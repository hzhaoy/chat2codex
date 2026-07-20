import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type CodexApprovalDecision,
  type CodexApprovalRequest,
  type CodexCommandSummary,
  type CodexForkThreadInput,
  CodexRunner,
  type CodexProgressUpdate,
  type CodexRunControl,
  type CodexRunInput,
  type CodexRunResult,
  type CodexRunSummary,
  type CodexUserInputRequest,
  type CodexUserInputResponse,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadListInput,
  type CodexThreadListResult,
  type CodexThreadSearchInput,
  type CodexThreadSearchResult,
  type CodexThreadTurn,
  type CodexThreadTurnItemListInput,
  type CodexThreadTurnItemListResult,
  type CodexThreadTurnListInput,
  type CodexThreadTurnListResult,
} from "../agent/codex-runner.js";
import { buildCodexChildEnv } from "../agent/codex-environment.js";
import { BridgeConfig } from "../config/env.js";
import { JsonStateStore } from "../state/store.js";
import {
  BridgeState,
  type DurableCodexJob,
  type DurableCodexJobStatus,
  type DurableOutboxMessage,
  type ChatDiagnostics,
  type EventDiagnosticOutcome,
  type EventDiagnosticSnapshot,
  type FailureDiagnosticCategory,
  type LastRunCommandSummary,
  type LastRunReviewSummary,
  type LastRunStatus,
  type LastRunSummary,
  type PendingMessageDelivery,
  type ProjectSelection,
  type RecentFailureDiagnostic,
  type ThreadSelection,
  type TurnSelection,
} from "../state/types.js";
import type { Logger } from "../util/logger.js";
import { normalizeRoutedText, splitForChat } from "../util/text.js";
import {
  decideAccess,
  senderMatchesAllowedUser,
  type AccessContext,
  type AccessDecision,
  type ChatType,
  type SenderIdentity,
} from "./access-control.js";
import {
  enforceAttachmentStoreLimits,
  removeAttachmentFiles,
} from "./attachment-store.js";
import {
  answerUserInputCardAction,
  cancelUserInputCardAction,
  cardActionCard,
  cardActionToast,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardAction,
  resumeThreadCardAction,
  resolveApprovalCardAction,
  selectProjectCardAction,
  showRunDetailCardAction,
  stopRunCardAction,
  type CardActionResponse,
  type IncomingCardAction,
  type RunDetailKind,
} from "./lark-card-action.js";
import {
  buildApprovalCard,
  buildHostHealthCard,
  buildProjectListCard,
  buildSessionListCard,
  buildUserInputCard,
  isApprovalDecisionIndexAllowed,
  type ApprovalCardInput,
  type HostHealthCardInput,
  type LarkInteractiveCard,
  type RunResultCardInput,
  type RunStatusCardInput,
  type UserInputCardInput,
} from "./lark-card.js";

const minProgressIntervalMs = 15_000;
const maxRememberedStatusCards = 100;
const pendingRunSteerTtlMs = 30_000;
const maxPendingSteers = 5;
const maxUserInputAnswerLength = 4_000;
const outboxRetryDelaysMs = [250, 1_000, 5_000, 30_000, 120_000] as const;
const pendingSteerLimitMessage = "已有 5 条补充指令等待发送，请先等当前 Codex 任务接收后再试。";

export interface IncomingTextMessage {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  sender: SenderIdentity;
  text: string;
  attachments?: IncomingAttachment[];
}

export interface IncomingAttachment {
  kind: "image" | "file";
  key: string;
  name?: string;
}

export interface DownloadedAttachment {
  kind: IncomingAttachment["kind"];
  path: string;
  name?: string;
}

export interface IncomingEventDiagnostic {
  reason?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  messageType?: string;
  mentionCount: number;
  startsWithMention: boolean;
  attachmentCount: number;
  textLength: number;
  botIdentityResolved: boolean;
}

export interface ChatSender {
  sendText(chatId: string, text: string, options?: ChatDeliveryOptions): Promise<void>;
  sendMarkdown?(chatId: string, markdown: string, options?: ChatDeliveryOptions): Promise<void>;
  sendInteractiveCard?(chatId: string, card: LarkInteractiveCard): Promise<void>;
  updateInteractiveCard?(messageId: string, card: LarkInteractiveCard): Promise<void>;
  downloadAttachment?(
    message: IncomingTextMessage,
    attachment: IncomingAttachment,
  ): Promise<DownloadedAttachment>;
  createStatusCard?(chatId: string, input: RunStatusCardInput): Promise<StatusCardHandle>;
  updateStatusCard?(handle: StatusCardHandle, input: RunStatusCardInput): Promise<void>;
  createApprovalCard?(chatId: string, input: ApprovalCardInput): Promise<StatusCardHandle>;
  updateApprovalCard?(handle: StatusCardHandle, input: ApprovalCardInput): Promise<void>;
  createUserInputCard?(chatId: string, input: UserInputCardInput): Promise<StatusCardHandle>;
  updateUserInputCard?(handle: StatusCardHandle, input: UserInputCardInput): Promise<void>;
}

export interface ChatDeliveryOptions {
  idempotencyKey?: string;
}

export interface StatusCardHandle {
  messageId: string;
}

export interface CodexClient {
  run(input: CodexRunInput): Promise<CodexRunResult>;
  listThreads?(input?: CodexThreadListInput): Promise<CodexThreadListResult>;
  readThread?(threadId: string): Promise<CodexThread | null>;
  searchThreads?(input: CodexThreadSearchInput): Promise<CodexThreadSearchResult>;
  listThreadTurns?(input: CodexThreadTurnListInput): Promise<CodexThreadTurnListResult>;
  listTurnItems?(input: CodexThreadTurnItemListInput): Promise<CodexThreadTurnItemListResult>;
  forkThread?(input: CodexForkThreadInput): Promise<CodexThread>;
  compactThread?(threadId: string): Promise<void>;
}

interface PendingApproval {
  chatId: string;
  request: CodexApprovalRequest;
  resolve: (decision: CodexApprovalDecision) => void;
  handle: StatusCardHandle | null;
  createdAt: string;
  createdAtMs: number;
  timeoutTimer?: NodeJS.Timeout;
  decision?: CodexApprovalDecision;
  resolvedAt?: string;
  cancelledAt?: string;
  cancelReason?: "run_cancelled" | "timeout";
}

interface ActiveRunState {
  controller: AbortController;
  cwd: string;
  prompt: string;
  threadId?: string;
  turnId?: string;
  steer?: CodexRunControl["steer"];
  pendingSteers: PendingSteer[];
  startedAt: string;
  startedAtMs: number;
  lastProgressAt?: string;
  lastProgressAtMs?: number;
  lastProgressText?: string;
  timeoutTimer?: NodeJS.Timeout;
  timedOut?: boolean;
}

interface QueuedRunState {
  controller: AbortController;
  cwd: string;
  prompt: string;
  messageId?: string;
  threadId?: string;
  chatType?: ChatType;
  originSender?: SenderIdentity;
  queuedAtMs: number;
  waitingFor: "workspace" | "global_capacity";
}

interface GlobalRunWaiter {
  signal: AbortSignal;
  resolve: (release: (() => void) | null) => void;
  abortListener: () => void;
}

interface PendingUserInput {
  key: string;
  chatId: string;
  chatType: ChatType;
  originSender: SenderIdentity;
  request: CodexUserInputRequest;
  replyCode: string;
  answers: Map<string, { answers: string[] }>;
  resolve: (response: CodexUserInputResponse) => void;
  signal: AbortSignal;
  abortListener: () => void;
  handle: StatusCardHandle | null;
  terminalCard?: UserInputCardInput;
}

interface PendingSteer {
  text: string;
}

interface PendingRunSteers {
  items: PendingSteer[];
  timeoutTimer: NodeJS.Timeout;
}

export class MessageRouter {
  private state: BridgeState | null = null;
  private stateMutationTail: Promise<void> = Promise.resolve();
  private attachmentTaskTail: Promise<void> = Promise.resolve();
  private readonly bridgeStartedAtMs = Date.now();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly workspaceQueues = new Map<string, Promise<void>>();
  private readonly messageTasks = new Map<string, Promise<void>>();
  private readonly outboxTasks = new Map<string, Promise<void>>();
  private readonly outboxRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly queueDepths = new Map<string, number>();
  private readonly queuedRuns = new Map<string, QueuedRunState>();
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly pendingRunSteers = new Map<string, PendingRunSteers>();
  private readonly activeApprovals = new Map<string, PendingApproval>();
  private readonly activeUserInputs = new Map<string, PendingUserInput>();
  private readonly statusCardRuns = new Map<string, { chatId: string; prompt: string }>();
  private readonly globalRunWaiters: GlobalRunWaiter[] = [];
  private activeGlobalRuns = 0;
  private readonly codex: CodexClient;
  private disposed = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JsonStateStore,
    private readonly sender: ChatSender,
    private readonly logger: Logger,
    codex?: CodexClient,
  ) {
    this.codex = codex ?? new CodexRunner(config, logger);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.outboxRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.outboxRetryTimers.clear();
    for (const waiter of this.globalRunWaiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.resolve(null);
    }
  }

  async start(): Promise<void> {
    this.state = await this.store.load();
    await this.recoverDurableState();
    for (const jobId of new Set(
      Object.values(this.state.outbox)
        .filter((delivery) => delivery.status === "pending")
        .map((delivery) => delivery.jobId),
    )) {
      this.scheduleOutboxDrain(jobId);
    }
    for (const pending of Object.values(this.state.pendingMessages)) {
      if (this.state.jobs[pending.messageId]?.status !== "queued") {
        continue;
      }
      this.scheduleAcceptedMessage(fromPendingMessage(pending));
    }
  }

  async accept(message: IncomingTextMessage): Promise<void> {
    if (this.requireState().processedMessageIds.includes(message.messageId)) {
      return;
    }
    if (!message.attachments?.length && isUserInputAnswerCommand(message)) {
      // User-input answers can contain secrets or other private values. Keep the
      // command in memory only; processMessage still persists its message id so
      // successful deliveries remain deduplicated without persisting the answer.
      this.scheduleAcceptedMessage(message);
      return;
    }
    const outcome = await this.mutateState((state) => {
      if (state.processedMessageIds.includes(message.messageId)) {
        return "duplicate" as const;
      }
      const durableCandidate = isDurableCodexCandidate(this.config, message);
      if (durableCandidate && !state.jobs[message.messageId]) {
        const session = this.ensureSession(message.chatId, state, message.chatType);
        const now = new Date().toISOString();
        if (queueLimitReached(state, message.chatId, this.config)) {
          const job: DurableCodexJob = {
            id: message.messageId,
            kind: "codex_run",
            messageId: message.messageId,
            chatId: message.chatId,
            chatType: message.chatType,
            cwd: session.cwd,
            prompt: "[rejected: queue capacity reached]",
            threadId: session.threadId,
            status: "cancelled",
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            deliveryIds: [],
            interruptionReason: "queue_capacity_reached",
          };
          state.jobs[message.messageId] = job;
          appendOutboxDeliveries(
            state,
            job,
            [{ kind: "text", text: queueCapacityMessage(this.config) }],
            now,
          );
          markMessageProcessed(state, message.messageId);
          return "rejected" as const;
        }
        state.jobs[message.messageId] = {
          id: message.messageId,
          kind: "codex_run",
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          cwd: session.cwd,
          prompt: routedText(message),
          threadId: session.threadId,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          deliveryIds: [],
        };
      }
      state.pendingMessages[message.messageId] ??= toPendingMessage(message);
      return "accepted" as const;
    });
    if (outcome === "duplicate") {
      return;
    }
    if (outcome === "rejected") {
      this.scheduleOutboxDrain(message.messageId);
      return;
    }
    this.scheduleAcceptedMessage(message);
  }

  async recordEventDiagnostic(
    outcome: EventDiagnosticOutcome,
    diagnostic: IncomingEventDiagnostic,
  ): Promise<void> {
    const state = this.requireState();
    const snapshot: EventDiagnosticSnapshot = {
      at: new Date().toISOString(),
      outcome,
      reason: diagnostic.reason,
      messageId: diagnostic.messageId,
      chatId: diagnostic.chatId,
      chatType: diagnostic.chatType,
      messageType: diagnostic.messageType,
      mentionCount: diagnostic.mentionCount,
      startsWithMention: diagnostic.startsWithMention,
      attachmentCount: diagnostic.attachmentCount,
      textLength: diagnostic.textLength,
      botIdentityResolved: diagnostic.botIdentityResolved,
    };
    const diagnostics = diagnostic.chatId
      ? ensureChatDiagnostics(state, diagnostic.chatId)
      : state.diagnostics;
    diagnostics.lastEvent = snapshot;
    if (outcome === "dropped") {
      diagnostics.lastDroppedEvent = snapshot;
    }
    await this.store.save(state);
  }

  enqueue(message: IncomingTextMessage): Promise<void> {
    if (!message.attachments?.length && isStopCommand(message)) {
      return this.handleImmediateStop(message);
    }
    if (!message.attachments?.length && isSteerCommand(message)) {
      return this.handleImmediateSteer(message);
    }
    if (!message.attachments?.length && isStatusCommand(message)) {
      return this.handleImmediateStatus(message);
    }
    if (!message.attachments?.length && isHostCommand(message)) {
      return this.handleImmediateHost(message);
    }
    if (!message.attachments?.length && detailCommandKind(message)) {
      return this.handleImmediateRunDetail(message);
    }
    if (!message.attachments?.length && isUserInputAnswerCommand(message)) {
      return this.handleImmediateUserInputAnswer(message);
    }

    return this.enqueueTask(message.chatId, () => this.handle(message));
  }

  private scheduleAcceptedMessage(message: IncomingTextMessage): void {
    void this.enqueue(message).catch(async (error: unknown) => {
      this.logger.error("Accepted chat message processing failed; leaving it pending", error);
      const state = this.requireState();
      const pending = state.pendingMessages[message.messageId];
      if (!pending) {
        return;
      }
      pending.attempts += 1;
      pending.lastError = truncateInline(formatError(error), 240);
      await this.store.save(state).catch((saveError: unknown) => {
        this.logger.error("Failed to persist pending message failure", saveError);
      });
    });
  }

  async handleCardAction(action: IncomingCardAction): Promise<CardActionResponse | undefined> {
    const access = decideAccess(this.config.access, {
      chatId: action.chatId,
      chatType: this.chatTypeForAction(action.chatId),
      sender: action.sender,
    });
    if (!access.allowed) {
      this.logger.warn("Rejected unauthorized card action", {
        chatId: action.chatId,
        messageId: action.messageId,
        reason: access.reason,
      });
      return cardActionToast("error", "当前用户未授权操作这个 Chat2Codex 任务。");
    }

    if (action.action === stopRunCardAction) {
      const result = await this.stopCodex(action.chatId, { notifyChat: false });
      return cardActionToast(result.stopped ? "success" : "warning", result.message);
    }

    if (action.action === retryRunCardAction) {
      return this.handleRetryCardAction(action);
    }
    if (action.action === showRunDetailCardAction) {
      return this.handleRunDetailCardAction(action);
    }

    if (action.action === resolveApprovalCardAction) {
      return this.handleApprovalCardAction(action);
    }
    if (
      action.action === answerUserInputCardAction ||
      action.action === cancelUserInputCardAction
    ) {
      return this.handleUserInputCardAction(action);
    }
    if (action.action === pageProjectsCardAction) {
      return this.handleProjectPageCardAction(action);
    }
    if (action.action === pageSessionsCardAction) {
      return this.handleSessionPageCardAction(action);
    }
    if (action.action === selectProjectCardAction) {
      return this.handleSelectProjectCardAction(action);
    }
    if (action.action === resumeThreadCardAction) {
      return this.handleResumeThreadCardAction(action);
    }

    return cardActionToast("warning", "这个卡片操作已被忽略。");
  }

  private enqueueTask(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    this.incrementQueueDepth(chatId);
    const next = previous
      .catch((error) => {
        this.logger.warn("Previous chat task failed", error);
      })
      .then(async () => {
        this.decrementQueueDepth(chatId);
        await task();
      })
      .finally(() => {
        if (this.queues.get(chatId) === next) {
          this.queues.delete(chatId);
        }
      });

    this.queues.set(chatId, next);
    return next;
  }

  private processMessage(
    message: IncomingTextMessage,
    action: () => Promise<void>,
  ): Promise<void> {
    const active = this.messageTasks.get(message.messageId);
    if (active) {
      return active;
    }

    const task = this.processMessageOnce(message, action).finally(() => {
      if (this.messageTasks.get(message.messageId) === task) {
        this.messageTasks.delete(message.messageId);
      }
    });
    this.messageTasks.set(message.messageId, task);
    return task;
  }

  private async processMessageOnce(
    message: IncomingTextMessage,
    action: () => Promise<void>,
  ): Promise<void> {
    const state = this.requireState();
    if (state.processedMessageIds.includes(message.messageId)) {
      if (state.pendingMessages[message.messageId]) {
        await this.mutateState((currentState) => {
          delete currentState.pendingMessages[message.messageId];
        });
      }
      this.logger.debug("Skipping duplicate message", { messageId: message.messageId });
      return;
    }

    await action();
    await this.mutateState((currentState) => {
      const job = currentState.jobs[message.messageId];
      if (job?.status === "queued") {
        job.status = "cancelled";
        job.prompt = truncateInline(job.prompt, 180);
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
      }
      markMessageProcessed(currentState, message.messageId);
    });
  }

  private incrementQueueDepth(chatId: string): void {
    this.queueDepths.set(chatId, (this.queueDepths.get(chatId) ?? 0) + 1);
  }

  private decrementQueueDepth(chatId: string): void {
    const next = (this.queueDepths.get(chatId) ?? 0) - 1;
    if (next <= 0) {
      this.queueDepths.delete(chatId);
      return;
    }
    this.queueDepths.set(chatId, next);
  }

  private handle(message: IncomingTextMessage): Promise<void> {
    return this.processMessage(message, () => this.handleMessage(message));
  }

  private async handleMessage(message: IncomingTextMessage): Promise<void> {
    const text = routedText(message);
    const hasAttachments = Boolean(message.attachments?.length);
    if (!text && !hasAttachments) {
      return;
    }

    if (!hasAttachments && text === "/whoami") {
      await this.sendWhoami(message);
      return;
    }

    const decision = decideAccess(this.config.access, toAccessContext(message));
    if (!decision.allowed) {
      await this.rejectUnauthorized(message, decision);
      return;
    }

    if (!hasAttachments && text === "/status") {
      await this.sendStatus(message.chatId);
      return;
    }
    if (!hasAttachments && text === "/host") {
      await this.sendHostHealth(message.chatId);
      return;
    }
    if (!hasAttachments && (text === "/diff" || text === "/logs" || text === "/files" || text === "/summary")) {
      await this.sendRunDetail(message.chatId, commandDetailKind(text));
      return;
    }
    if (!hasAttachments && (text === "/steer" || text.startsWith("/steer "))) {
      await this.steerActiveRun(message.chatId, text.slice("/steer".length).trim());
      return;
    }
    if (!hasAttachments && text === "/stop") {
      await this.stopCodex(message.chatId);
      return;
    }
    if (!hasAttachments && text === "/projects") {
      await this.sendProjects(message.chatId, message.chatType);
      return;
    }
    if (!hasAttachments && (text === "/project" || text.startsWith("/project "))) {
      await this.selectProject(message.chatId, message.chatType, text.slice("/project".length).trim());
      return;
    }
    if (!hasAttachments && (text === "/threads" || text === "/sessions")) {
      await this.sendThreads(message.chatId, message.chatType);
      return;
    }
    if (!hasAttachments && (text === "/history" || text.startsWith("/history "))) {
      await this.sendHistory(message.chatId, message.chatType, text.slice("/history".length).trim());
      return;
    }
    if (!hasAttachments && (text === "/search" || text.startsWith("/search "))) {
      await this.searchThreads(message.chatId, message.chatType, text.slice("/search".length).trim());
      return;
    }
    if (!hasAttachments && (text === "/resume" || text.startsWith("/resume "))) {
      await this.resumeThread(message.chatId, message.chatType, text.slice("/resume".length).trim());
      return;
    }
    if (!hasAttachments && (text === "/fork" || text.startsWith("/fork "))) {
      await this.forkThread(message.chatId, message.chatType, text.slice("/fork".length).trim());
      return;
    }
    if (!hasAttachments && text === "/compact") {
      await this.compactThread(message.chatId, message.chatType);
      return;
    }
    if (!hasAttachments && (text === "/new" || text === "/reset")) {
      await this.resetSession(message.chatId);
      return;
    }
    if (!hasAttachments && text.startsWith("/cd ")) {
      await this.changeDirectory(message.chatId, message.chatType, text.slice(4).trim());
      return;
    }

    const prompt = await this.buildCodexPrompt(message, text);
    if (!prompt) {
      return;
    }

    await this.runCodex(
      message.chatId,
      prompt,
      message.chatType,
      message.messageId,
      message.sender,
    );
  }

  private async rejectUnauthorized(
    message: IncomingTextMessage,
    decision: AccessDecision,
  ): Promise<void> {
    this.logger.warn("Rejected unauthorized chat message", {
      chatId: message.chatId,
      chatType: message.chatType,
      reason: decision.reason,
    });

    if (message.chatType !== "direct") {
      return;
    }

    await this.sender.sendText(
      message.chatId,
      [
        "当前会话未授权使用 Chat2Codex。",
        "发送 /whoami 查看当前 chat_id，然后配置 ALLOWED_CHAT_IDS 或 ALLOWED_USER_IDS。",
      ].join("\n"),
    );
  }

  private async runCodex(
    chatId: string,
    prompt: string,
    chatType?: ChatType,
    messageId?: string,
    originSender?: SenderIdentity,
  ): Promise<void> {
    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    if (messageId) {
      await this.mutateState((currentState) => {
        const currentSession = this.ensureSession(chatId, currentState, chatType);
        const now = new Date().toISOString();
        const job = currentState.jobs[messageId] ?? {
          id: messageId,
          kind: "codex_run" as const,
          messageId,
          chatId,
          chatType: currentSession.chatType ?? chatType ?? "direct",
          cwd: currentSession.cwd,
          prompt,
          status: "queued" as const,
          createdAt: now,
          updatedAt: now,
          deliveryIds: [],
        };
        if (isTerminalJobStatus(job.status)) {
          return;
        }
        job.cwd = currentSession.cwd;
        job.prompt = prompt;
        job.threadId = currentSession.threadId;
        job.updatedAt = now;
        currentState.jobs[messageId] = job;
      });
      const existing = this.requireState().jobs[messageId];
      if (existing && isTerminalJobStatus(existing.status)) {
        this.scheduleOutboxDrain(messageId);
        return;
      }
    }
    const workspace = canonicalExistingPath(session.cwd) ?? path.resolve(session.cwd);
    const queuedRun: QueuedRunState = {
      controller: new AbortController(),
      cwd: session.cwd,
      prompt,
      messageId,
      threadId: session.threadId,
      chatType: session.chatType ?? chatType,
      originSender: originSender ? { ...originSender } : undefined,
      queuedAtMs: Date.now(),
      waitingFor: "workspace",
    };
    this.queuedRuns.set(chatId, queuedRun);
    let workspaceTaskStarted = false;
    const workspaceTask = this.enqueueWorkspaceTask(workspace, async () => {
      workspaceTaskStarted = true;
      if (queuedRun.controller.signal.aborted) {
        return;
      }
      await this.runCodexInWorkspace(chatId, queuedRun);
    });
    return await waitForTaskOrQueuedAbort(
      workspaceTask,
      queuedRun.controller.signal,
      () => workspaceTaskStarted,
    ).finally(() => {
      if (this.queuedRuns.get(chatId) === queuedRun) {
        this.queuedRuns.delete(chatId);
      }
    });
  }

  private enqueueWorkspaceTask(workspace: string, task: () => Promise<void>): Promise<void> {
    const previous = this.workspaceQueues.get(workspace) ?? Promise.resolve();
    const next = previous
      .catch((error: unknown) => {
        this.logger.warn("Previous workspace task failed", error);
      })
      .then(task)
      .finally(() => {
        if (this.workspaceQueues.get(workspace) === next) {
          this.workspaceQueues.delete(workspace);
        }
      });
    this.workspaceQueues.set(workspace, next);
    return next;
  }

  private async runCodexInWorkspace(
    chatId: string,
    queuedRun: QueuedRunState,
  ): Promise<void> {
    const state = this.requireState();
    const session = this.ensureSession(chatId, state, queuedRun.chatType);
    if (session.cwd !== queuedRun.cwd || session.threadId !== queuedRun.threadId) {
      await this.sender.sendText(
        chatId,
        "任务排队期间项目或会话已变化；为避免在错误工作区执行，这次任务已取消。",
      );
      return;
    }
    const prompt = queuedRun.prompt;
    if (!this.directoryAllowedForChat(session.cwd, session.chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }
    await this.store.save(state);

    queuedRun.waitingFor = "global_capacity";
    const releaseGlobalRun = await this.acquireGlobalRunPermit(queuedRun.controller.signal);
    if (!releaseGlobalRun) {
      return;
    }
    try {
      await this.runCodexWithGlobalPermit(chatId, queuedRun);
    } finally {
      releaseGlobalRun();
    }
  }

  private async runCodexWithGlobalPermit(
    chatId: string,
    queuedRun: QueuedRunState,
  ): Promise<void> {
    const state = this.requireState();
    const session = this.ensureSession(chatId, state, queuedRun.chatType);
    const prompt = queuedRun.prompt;
    queuedRun.waitingFor = "workspace";

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const statusCard = await this.createStatusCard(chatId, {
      status: "running",
      detail: "收到，已开始处理。",
      cwd: session.cwd,
      prompt,
      startedAt,
      updatedAt: startedAt,
    });
    this.rememberStatusCardRun(statusCard, chatId, prompt);

    const controller = queuedRun.controller;
    if (controller.signal.aborted) {
      await this.updateStatusCard(statusCard, {
        status: "stopped",
        detail: "任务在等待执行期间已取消。",
        cwd: session.cwd,
        prompt,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (queuedRun.messageId) {
      await this.mutateState((currentState) => {
        const job = currentState.jobs[queuedRun.messageId!];
        if (!job || isTerminalJobStatus(job.status)) {
          return;
        }
        job.status = "running";
        job.prompt = truncateInline(job.prompt, 180);
        job.startedAt = startedAt;
        job.updatedAt = startedAt;
      });
    }
    const runState: ActiveRunState = {
      controller,
      cwd: session.cwd,
      prompt,
      threadId: session.threadId,
      pendingSteers: this.takePendingRunSteers(chatId),
      startedAt,
      startedAtMs,
    };
    if (this.queuedRuns.get(chatId) === queuedRun) {
      this.queuedRuns.delete(chatId);
    }
    if (this.config.codexRunTimeoutMs > 0) {
      runState.timeoutTimer = setTimeout(() => {
        if (this.activeRuns.get(chatId) !== runState || controller.signal.aborted) {
          return;
        }
        runState.timedOut = true;
        controller.abort();
      }, this.config.codexRunTimeoutMs);
      runState.timeoutTimer.unref?.();
    }
    const reportProgress = this.createProgressReporter(
      chatId,
      controller.signal,
      statusCard,
      session.cwd,
      prompt,
      startedAt,
      runState,
    );
    this.activeRuns.set(chatId, runState);
    try {
      const result = await this.codex.run({
        prompt,
        cwd: session.cwd,
        threadId: session.threadId,
        signal: controller.signal,
        onProgress: reportProgress,
        onApprovalRequest: (request) =>
          this.requestApproval(
            chatId,
            request,
            controller.signal,
            statusCard,
            session.cwd,
            prompt,
            startedAt,
          ),
        onUserInputRequest: (request, context) =>
          this.requestUserInput(
            chatId,
            queuedRun.chatType ?? "direct",
            queuedRun.originSender,
            request,
            context.signal,
          ),
        onRunControl: (control) => {
          runState.threadId = control.threadId ?? runState.threadId;
          runState.turnId = control.turnId;
          runState.steer = control.steer;
          void this.flushPendingSteers(chatId, runState);
        },
      });

      if (result.cancelled || controller.signal.aborted) {
        if (runState.timedOut) {
          await this.reportRunTimeout(chatId, statusCard, session.cwd, prompt, session.threadId, startedAt, queuedRun.messageId);
          return;
        }
        const completedAt = new Date().toISOString();
        const lastRun = buildLastRunSummary({
          status: "stopped",
          cwd: session.cwd,
          threadId: result.threadId ?? session.threadId,
          prompt,
          startedAt,
          completedAt,
          summary: result.summary,
        });
        await this.persistRunTerminal({
          chatId,
          messageId: queuedRun.messageId,
          status: "cancelled",
          lastRun,
          threadId: result.threadId ?? session.threadId,
          deliveries: [],
        });
        this.logger.info("Codex run stopped", { chatId });
        await this.updateStatusCard(statusCard, {
          status: "stopped",
          detail: "已停止当前 Codex 任务。",
          cwd: session.cwd,
          prompt,
          startedAt,
          updatedAt: completedAt,
          result: runResultCardInput(lastRun),
        });
        return;
      }

      const resultThreadId = result.threadId ?? session.threadId;
      const completedAt = new Date().toISOString();

      if (result.exitCode !== 0) {
        const lastRun = buildLastRunSummary({
          status: "failed",
          cwd: session.cwd,
          threadId: resultThreadId,
          prompt,
          startedAt,
          completedAt,
          summary: result.summary,
          errorText: [result.finalText, result.stderr].filter(Boolean).join("\n"),
        });
        const failure = formatCodexFailure(result, session.cwd);
        await this.recordRecentFailure(chatId, {
          category: inferCodexResultFailureCategory(result),
          cwd: session.cwd,
          promptPreview: prompt,
          threadId: resultThreadId,
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          detail: formatExit(result),
          hint: inferCodexFailureHint(result.finalText, result.stderr) ?? undefined,
        });
        const durable = await this.persistRunTerminal({
          chatId,
          messageId: queuedRun.messageId,
          status: "failed",
          lastRun,
          threadId: resultThreadId,
          updateSessionThread: true,
          deliveries: splitForChat(failure).map((text) => ({ kind: "text" as const, text })),
        });
        await this.updateStatusCard(statusCard, {
          status: "failed",
          detail: "Codex 运行失败，错误摘要已发送。",
          cwd: session.cwd,
          prompt,
          startedAt,
          updatedAt: completedAt,
          result: runResultCardInput(lastRun),
        });
        if (durable) {
          await this.drainOutboxForJob(queuedRun.messageId!);
        } else {
          for (const chunk of splitForChat(failure)) {
            await this.sender.sendText(chatId, chunk);
          }
        }
        return;
      }

      const lastRun = buildLastRunSummary({
        status: "success",
        cwd: session.cwd,
        threadId: resultThreadId,
        prompt,
        startedAt,
        completedAt,
        summary: result.summary,
        finalText: result.finalText,
      });
      const chatOutput = truncateChatOutput(result.finalText, this.config.chatOutputMaxChars);
      const durable = await this.persistRunTerminal({
        chatId,
        messageId: queuedRun.messageId,
        status: "completed",
        lastRun,
        threadId: resultThreadId,
        deliveries: splitForChat(chatOutput).map((text) => ({
          kind: "markdown" as const,
          text,
        })),
      });
      await this.updateStatusCard(statusCard, {
        status: "success",
        detail: "Codex 已完成，正在发送最终回答。",
        cwd: session.cwd,
        prompt,
        startedAt,
        updatedAt: completedAt,
        result: runResultCardInput(lastRun),
      });
      if (durable) {
        await this.drainOutboxForJob(queuedRun.messageId!);
      } else {
        for (const chunk of splitForChat(chatOutput)) {
          await this.sendMarkdown(chatId, chunk);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (runState.timedOut) {
          await this.reportRunTimeout(chatId, statusCard, session.cwd, prompt, session.threadId, startedAt, queuedRun.messageId);
          return;
        }
        this.logger.info("Codex run stopped", { chatId });
        if (queuedRun.messageId) {
          const completedAt = new Date().toISOString();
          const lastRun = buildLastRunSummary({
            status: "stopped",
            cwd: session.cwd,
            threadId: session.threadId,
            prompt,
            startedAt,
            completedAt,
            errorText: "Codex run was stopped.",
          });
          await this.persistRunTerminal({
            chatId,
            messageId: queuedRun.messageId,
            status: "cancelled",
            lastRun,
            threadId: session.threadId,
            deliveries: [],
          });
        }
        return;
      }
      this.logger.error("Codex run failed", error);
      const failedCwd = session.cwd;
      const failedThreadId = session.threadId;
      const cwdExists = Boolean(
        (await fs.stat(failedCwd).catch(() => null))?.isDirectory(),
      );
      const cwdMissing = getErrorCode(error) === "ENOENT" && !cwdExists;
      let fallbackCwd: string | null = null;
      if (cwdMissing) {
        const candidate = this.config.codexWorkdir;
        const fallbackStat = await fs.stat(candidate).catch(() => null);
        if (
          fallbackStat?.isDirectory() &&
          this.directoryAllowedForChat(candidate, session.chatType)
        ) {
          fallbackCwd = candidate;
          session.cwd = candidate;
          delete session.threadId;
        }
      }
      let failure = formatCodexStartupFailure(
        error,
        this.config.codexBin,
        failedCwd,
        cwdExists,
      );
      if (cwdMissing) {
        failure = [
          failure,
          "",
          fallbackCwd
            ? `已切回默认 cwd：${fallbackCwd}\n请重新发送刚才的任务。`
            : "默认 cwd 也不可用；请发送 /cd <现有目录> 后重试。",
        ].join("\n");
      }
      if (!cwdMissing && failedThreadId && isThreadResumeReadFailure(error)) {
        delete session.threadId;
        session.updatedAt = new Date().toISOString();
        await this.store.save(state);
        await this.recordRecentFailure(chatId, {
          category: "thread_unavailable",
          cwd: failedCwd,
          promptPreview: prompt,
          threadId: failedThreadId,
          detail: formatError(error),
          hint: "发送 /sessions 重新选择可恢复会话，或直接重发消息在当前项目新建会话。",
        });
        failure = [
          failure,
          "",
          [
            `已清除当前 chat 中不可继续的会话选择：${failedThreadId}`,
            "可以发送 /sessions 重新选择可恢复会话，或直接重发消息在当前项目新建会话。",
          ].join("\n"),
        ].join("\n");
      } else {
        await this.recordRecentFailure(chatId, {
          category: inferStartupFailureCategory(error, cwdExists),
          cwd: failedCwd,
          promptPreview: prompt,
          threadId: failedThreadId,
          detail: formatError(error),
          hint: cwdMissing
            ? fallbackCwd
              ? `已切回默认 cwd ${fallbackCwd}；请重新发送刚才的任务。`
              : "请发送 /cd <现有目录> 后重新发送任务。"
            : inferStartupFailureHint(
              getErrorCode(error),
              this.config.codexBin,
              failedCwd,
              cwdExists,
            ) ?? undefined,
        });
      }
      const completedAt = new Date().toISOString();
      const lastRun = buildLastRunSummary({
        status: "failed",
        cwd: failedCwd,
        threadId: failedThreadId,
        prompt,
        startedAt,
        completedAt,
        errorText: formatError(error),
      });
      const durable = await this.persistRunTerminal({
        chatId,
        messageId: queuedRun.messageId,
        status: "failed",
        lastRun,
        threadId: failedThreadId,
        deliveries: splitForChat(failure).map((text) => ({ kind: "text" as const, text })),
      });
      await this.updateStatusCard(statusCard, {
        status: "failed",
        detail: "Codex 启动失败，错误摘要已发送。",
        cwd: failedCwd,
        prompt,
        startedAt,
        updatedAt: completedAt,
        result: runResultCardInput(lastRun),
      });
      if (durable) {
        await this.drainOutboxForJob(queuedRun.messageId!);
      } else {
        for (const chunk of splitForChat(failure)) {
          await this.sender.sendText(chatId, chunk);
        }
      }
    } finally {
      if (runState.timeoutTimer) {
        clearTimeout(runState.timeoutTimer);
      }
      await this.cancelApprovalsForChat(chatId);
      await this.cancelUserInputsForChat(chatId);
      if (this.activeRuns.get(chatId) === runState) {
        await this.reportUnsentPendingSteers(chatId, runState);
        this.activeRuns.delete(chatId);
      }
    }
  }

  private acquireGlobalRunPermit(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted || this.disposed) {
      return Promise.resolve(null);
    }
    if (this.activeGlobalRuns < this.config.codexMaxConcurrentRuns) {
      this.activeGlobalRuns += 1;
      return Promise.resolve(this.createGlobalRunRelease());
    }

    return new Promise((resolve) => {
      const waiter: GlobalRunWaiter = {
        signal,
        resolve,
        abortListener: () => {
          const index = this.globalRunWaiters.indexOf(waiter);
          if (index >= 0) {
            this.globalRunWaiters.splice(index, 1);
          }
          signal.removeEventListener("abort", waiter.abortListener);
          resolve(null);
        },
      };
      signal.addEventListener("abort", waiter.abortListener, { once: true });
      this.globalRunWaiters.push(waiter);
    });
  }

  private createGlobalRunRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeGlobalRuns = Math.max(0, this.activeGlobalRuns - 1);
      this.grantNextGlobalRunPermit();
    };
  }

  private grantNextGlobalRunPermit(): void {
    while (
      !this.disposed &&
      this.activeGlobalRuns < this.config.codexMaxConcurrentRuns &&
      this.globalRunWaiters.length > 0
    ) {
      const waiter = this.globalRunWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      if (waiter.signal.aborted) {
        waiter.resolve(null);
        continue;
      }
      this.activeGlobalRuns += 1;
      waiter.resolve(this.createGlobalRunRelease());
    }
  }

  private async reportRunTimeout(
    chatId: string,
    statusCard: StatusCardHandle | null,
    cwd: string,
    prompt: string,
    threadId: string | undefined,
    startedAt: string,
    messageId?: string,
  ): Promise<void> {
    const failure = formatRunTimeoutFailure(this.config.codexRunTimeoutMs, cwd);
    this.logger.warn("Codex run timed out", {
      chatId,
      timeoutMs: this.config.codexRunTimeoutMs,
    });
    await this.recordRecentFailure(chatId, {
      category: "run_timeout",
      cwd,
      promptPreview: prompt,
      threadId,
      detail: `Run exceeded CODEX_RUN_TIMEOUT_MS=${this.config.codexRunTimeoutMs}.`,
      hint: runTimeoutHint(this.config.codexRunTimeoutMs),
    });
    const completedAt = new Date().toISOString();
    const lastRun = buildLastRunSummary({
      status: "failed",
      cwd,
      threadId,
      prompt,
      startedAt,
      completedAt,
      errorText: `Run exceeded CODEX_RUN_TIMEOUT_MS=${this.config.codexRunTimeoutMs}.`,
    });
    const durable = await this.persistRunTerminal({
      chatId,
      messageId,
      status: "failed",
      lastRun,
      threadId,
      deliveries: splitForChat(failure).map((text) => ({ kind: "text" as const, text })),
    });
    await this.updateStatusCard(statusCard, {
      status: "failed",
      detail: "Codex 运行超时，已停止当前任务。",
      cwd,
      prompt,
      startedAt,
      updatedAt: completedAt,
      result: runResultCardInput(lastRun),
    });
    if (durable) {
      await this.drainOutboxForJob(messageId!);
    } else {
      for (const chunk of splitForChat(failure)) {
        await this.sender.sendText(chatId, chunk);
      }
    }
  }

  private async recoverDurableState(): Promise<void> {
    await this.mutateState((state) => {
      const now = new Date().toISOString();
      for (const delivery of Object.values(state.outbox)) {
        if (delivery.status === "sending") {
          delivery.status = "pending";
          delivery.updatedAt = now;
        }
      }

      for (const pending of Object.values(state.pendingMessages)) {
        let job = state.jobs[pending.messageId];
        if (!job) {
          const session = state.chats[pending.chatId];
          job = {
            id: pending.messageId,
            kind: "codex_run",
            messageId: pending.messageId,
            chatId: pending.chatId,
            chatType: pending.chatType,
            cwd: session?.cwd ?? this.config.codexWorkdir,
            prompt: pending.text,
            threadId: session?.threadId,
            status: "interrupted",
            createdAt: pending.acceptedAt,
            updatedAt: now,
            completedAt: now,
            deliveryIds: [],
            interruptionReason: "legacy_pending_without_job",
          };
          state.jobs[job.id] = job;
          appendOutboxDeliveries(state, job, [
            {
              kind: "text",
              text: interruptedJobMessage(job),
            },
          ], now);
          markMessageProcessed(state, pending.messageId);
          continue;
        }

        if (job.status === "running") {
          interruptDurableJob(state, job, now);
          markMessageProcessed(state, pending.messageId);
          continue;
        }
        if (isTerminalJobStatus(job.status)) {
          markMessageProcessed(state, pending.messageId);
        }
      }

      for (const job of Object.values(state.jobs)) {
        if (job.status === "running") {
          interruptDurableJob(state, job, now);
          markMessageProcessed(state, job.messageId);
          continue;
        }
        if (job.status === "queued" && !state.pendingMessages[job.messageId]) {
          interruptDurableJob(state, job, now, "queued_job_missing_inbox");
          markMessageProcessed(state, job.messageId);
        }
      }
    });
  }

  private async persistRunTerminal(input: {
    chatId: string;
    messageId?: string;
    status: Extract<DurableCodexJobStatus, "completed" | "failed" | "cancelled">;
    lastRun: LastRunSummary;
    threadId?: string;
    updateSessionThread?: boolean;
    deliveries: Array<{ kind: DurableOutboxMessage["kind"]; text: string }>;
  }): Promise<boolean> {
    return this.mutateState((state) => {
      const job = input.messageId ? state.jobs[input.messageId] : undefined;
      const session = this.ensureSession(input.chatId, state, job?.chatType);
      if ((input.status !== "failed" || input.updateSessionThread) && input.threadId) {
        session.threadId = input.threadId;
      }
      session.lastRun = input.lastRun;
      session.updatedAt = input.lastRun.completedAt;
      if (!input.messageId) {
        return false;
      }

      const durableJob = job ?? {
        id: input.messageId,
        kind: "codex_run" as const,
        messageId: input.messageId,
        chatId: input.chatId,
        chatType: session.chatType ?? "direct",
        cwd: input.lastRun.cwd,
        prompt: input.lastRun.promptPreview,
        status: "running" as const,
        createdAt: input.lastRun.startedAt,
        updatedAt: input.lastRun.startedAt,
        deliveryIds: [],
      };
      if (!isTerminalJobStatus(durableJob.status)) {
        durableJob.status = input.status;
        durableJob.prompt = input.lastRun.promptPreview;
        durableJob.threadId = input.threadId ?? durableJob.threadId;
        durableJob.result = input.lastRun;
        durableJob.completedAt = input.lastRun.completedAt;
        durableJob.updatedAt = input.lastRun.completedAt;
        appendOutboxDeliveries(state, durableJob, input.deliveries, input.lastRun.completedAt);
        state.jobs[input.messageId] = durableJob;
      }
      markMessageProcessed(state, input.messageId);
      return true;
    });
  }

  private scheduleOutboxDrain(jobId: string): void {
    if (this.disposed) {
      return;
    }
    void this.drainOutboxForJob(jobId).catch((error: unknown) => {
      this.logger.error("Durable outbox drain failed", error);
    });
  }

  private drainOutboxForJob(jobId: string): Promise<void> {
    const active = this.outboxTasks.get(jobId);
    if (active) {
      return active;
    }
    const task = this.drainOutboxForJobOnce(jobId).finally(() => {
      if (this.outboxTasks.get(jobId) === task) {
        this.outboxTasks.delete(jobId);
      }
    });
    this.outboxTasks.set(jobId, task);
    return task;
  }

  private async drainOutboxForJobOnce(jobId: string): Promise<void> {
    const deliveries = Object.values(this.requireState().outbox)
      .filter((delivery) => delivery.jobId === jobId)
      .sort((left, right) => left.sequence - right.sequence);
    for (const delivery of deliveries) {
      if (delivery.status === "delivered") {
        continue;
      }
      if (!(await this.deliverOutboxMessage(delivery.id))) {
        return;
      }
    }
    this.clearOutboxRetry(jobId);
  }

  private scheduleOutboxRetry(jobId: string, attempts: number): void {
    if (this.disposed || this.outboxRetryTimers.has(jobId)) {
      return;
    }
    const delayIndex = Math.min(
      Math.max(0, attempts - 1),
      outboxRetryDelaysMs.length - 1,
    );
    const timer = setTimeout(() => {
      if (this.outboxRetryTimers.get(jobId) !== timer) {
        return;
      }
      this.outboxRetryTimers.delete(jobId);
      this.scheduleOutboxDrain(jobId);
    }, outboxRetryDelaysMs[delayIndex]);
    timer.unref?.();
    this.outboxRetryTimers.set(jobId, timer);
  }

  private clearOutboxRetry(jobId: string): void {
    const timer = this.outboxRetryTimers.get(jobId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.outboxRetryTimers.delete(jobId);
  }

  private async deliverOutboxMessage(deliveryId: string): Promise<boolean> {
    const delivery = await this.mutateState((state) => {
      const current = state.outbox[deliveryId];
      if (!current || current.status === "delivered") {
        return null;
      }
      current.status = "sending";
      current.attempts += 1;
      current.updatedAt = new Date().toISOString();
      delete current.lastError;
      return structuredClone(current);
    });
    if (!delivery) {
      return true;
    }

    try {
      const options = { idempotencyKey: delivery.idempotencyKey };
      if (delivery.kind === "markdown" && this.sender.sendMarkdown) {
        await this.sender.sendMarkdown(delivery.chatId, delivery.text, options);
      } else {
        await this.sender.sendText(delivery.chatId, delivery.text, options);
      }
      await this.mutateState((state) => {
        const current = state.outbox[deliveryId];
        if (!current) {
          return;
        }
        current.status = "delivered";
        current.text = "";
        current.deliveredAt = new Date().toISOString();
        current.updatedAt = current.deliveredAt;
        delete current.lastError;
      });
      return true;
    } catch (error) {
      await this.mutateState((state) => {
        const current = state.outbox[deliveryId];
        if (!current) {
          return;
        }
        current.status = "pending";
        current.updatedAt = new Date().toISOString();
        current.lastError = truncateInline(formatError(error), 240);
      });
      this.logger.warn("Durable outbox delivery failed; leaving it pending", {
        deliveryId,
        jobId: delivery.jobId,
        error: formatError(error),
      });
      this.scheduleOutboxRetry(delivery.jobId, delivery.attempts);
      return false;
    }
  }

  private async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    if (this.sender.sendMarkdown) {
      await this.sender.sendMarkdown(chatId, markdown);
      return;
    }
    await this.sender.sendText(chatId, markdown);
  }

  private async sendCard(
    chatId: string,
    card: LarkInteractiveCard,
    fallbackMarkdown: string,
  ): Promise<void> {
    if (!this.sender.sendInteractiveCard) {
      await this.sendMarkdown(chatId, fallbackMarkdown);
      return;
    }

    try {
      await this.sender.sendInteractiveCard(chatId, card);
    } catch (error) {
      this.logger.warn("Interactive card send failed; falling back to markdown", error);
      await this.sendMarkdown(chatId, fallbackMarkdown);
    }
  }

  private async buildCodexPrompt(
    message: IncomingTextMessage,
    text: string,
  ): Promise<string | null> {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return text;
    }

    if (attachments.length > this.config.attachmentMaxCount) {
      const detail = `Message contains ${attachments.length} attachments; limit is ${this.config.attachmentMaxCount}.`;
      await this.recordRecentFailure(message.chatId, {
        category: "attachment_download_failed",
        cwd: this.requireState().chats[message.chatId]?.cwd ?? this.config.codexWorkdir,
        promptPreview: text || "attachment-only message",
        detail,
        hint: `每条消息最多发送 ${this.config.attachmentMaxCount} 个附件。`,
      });
      await this.sender.sendText(
        message.chatId,
        `附件数量超过上限：每条消息最多 ${this.config.attachmentMaxCount} 个，本次没有执行 Codex。`,
      );
      return null;
    }

    if (!this.sender.downloadAttachment) {
      await this.recordRecentFailure(message.chatId, {
        category: "attachment_download_failed",
        cwd: this.requireState().chats[message.chatId]?.cwd ?? this.config.codexWorkdir,
        promptPreview: text || "attachment-only message",
        detail: "Current chat adapter does not support attachment downloads.",
        hint: "请使用支持附件下载的飞书/Lark 适配器，或改为发送本机文件路径。",
      });
      await this.sender.sendText(message.chatId, "当前聊天适配器暂不支持下载附件。");
      return null;
    }

    return this.enqueueAttachmentTask(() =>
      this.downloadAttachmentsAndBuildPrompt(message, text, attachments),
    );
  }

  private async downloadAttachmentsAndBuildPrompt(
    message: IncomingTextMessage,
    text: string,
    attachments: IncomingAttachment[],
  ): Promise<string | null> {
    const downloaded: DownloadedAttachment[] = [];
    try {
      for (const attachment of attachments) {
        downloaded.push(await this.sender.downloadAttachment!(message, attachment));
      }
      await enforceAttachmentStoreLimits({
        rootDir: this.config.attachmentDownloadDir,
        downloadedPaths: downloaded.map((attachment) => attachment.path),
        retentionHours: this.config.attachmentRetentionHours,
        messageMaxBytes: this.config.attachmentMaxTotalBytes,
        storeMaxBytes: this.config.attachmentStoreMaxBytes,
      });
    } catch (error) {
      if (downloaded.length > 0) {
        await removeAttachmentFiles(
          this.config.attachmentDownloadDir,
          downloaded.map((attachment) => attachment.path),
        ).catch((cleanupError: unknown) => {
          this.logger.warn("Failed to clean up rejected attachment downloads", cleanupError);
        });
      }
      this.logger.error("Attachment download failed", error);
      await this.recordRecentFailure(message.chatId, {
        category: "attachment_download_failed",
        cwd: this.requireState().chats[message.chatId]?.cwd ?? this.config.codexWorkdir,
        promptPreview: text || defaultAttachmentPrompt(downloaded),
        detail: formatError(error),
        hint: "检查飞书/Lark 消息资源读取权限，或确认附件仍可由当前应用读取。",
      });
      await this.sender.sendText(
        message.chatId,
        `附件处理失败：${truncateInline(formatError(error), 240)}\n请检查消息资源权限，以及单文件、单消息和附件存储配额。`,
      );
      return null;
    }

    const promptText = text || defaultAttachmentPrompt(downloaded);
    return [promptText, "", "本地附件路径：", ...downloaded.map(formatAttachmentLine)].join("\n");
  }

  private enqueueAttachmentTask<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.attachmentTaskTail
      .catch(() => undefined)
      .then(task);
    this.attachmentTaskTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async handleImmediateStop(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.stopCodex(message.chatId));
  }

  private async handleImmediateStatus(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.sendStatus(message.chatId));
  }

  private async handleImmediateHost(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.sendHostHealth(message.chatId));
  }

  private async handleImmediateRunDetail(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () =>
      this.sendRunDetail(message.chatId, detailCommandKind(message) ?? "summary"),
    );
  }

  private async handleImmediateSteer(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () =>
      this.steerActiveRun(message.chatId, routedText(message).slice("/steer".length).trim()),
    );
  }

  private async handleImmediateUserInputAnswer(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.answerUserInputFromText(message));
  }

  private async handleImmediateCommand(
    message: IncomingTextMessage,
    action: () => Promise<unknown>,
  ): Promise<void> {
    await this.processMessage(message, async () => {
      const decision = decideAccess(this.config.access, toAccessContext(message));
      if (!decision.allowed) {
        await this.rejectUnauthorized(message, decision);
        return;
      }

      await action();
    });
  }

  private async sendStatus(chatId: string): Promise<void> {
    const state = this.requireState();
    const session = state.chats[chatId];
    if (!session) {
      await this.sender.sendText(
        chatId,
        [
          "当前 chat 还没有 Codex session。",
          `默认 cwd: ${this.config.codexWorkdir}`,
          ...this.formatRuntimeStatusLines(chatId, state),
          ...this.formatDiagnosticStatusLines(chatId, state),
        ].join("\n"),
      );
      return;
    }

    await this.sender.sendText(
      chatId,
      [
        "当前 chat 状态：",
        `cwd: ${session.cwd}`,
        `thread: ${session.threadId ?? "(未创建)"}`,
        `updated: ${session.updatedAt}`,
        ...this.formatRuntimeStatusLines(chatId, state),
        ...this.formatDiagnosticStatusLines(chatId, state),
      ].join("\n"),
    );
  }

  private async sendHostHealth(chatId: string): Promise<void> {
    const state = this.requireState();
    const input = this.buildHostHealthInput(chatId, state);
    const fallback = formatHostHealth(input);
    if (this.sender.sendInteractiveCard) {
      try {
        await this.sender.sendInteractiveCard(chatId, buildHostHealthCard(input));
        return;
      } catch (error) {
        this.logger.warn("Host health card send failed; falling back to markdown", error);
      }
    }
    await this.sendMarkdown(chatId, fallback);
  }

  private async sendRunDetail(chatId: string, kind: RunDetailKind): Promise<void> {
    const lastRun = this.requireState().chats[chatId]?.lastRun;
    if (!lastRun) {
      await this.sender.sendText(chatId, "当前 chat 还没有可查看的最近运行结果。");
      return;
    }
    const detail = formatRunDetail(lastRun, kind);
    for (const chunk of splitForChat(detail)) {
      await this.sendMarkdown(chatId, chunk);
    }
  }

  private async steerActiveRun(chatId: string, text: string): Promise<void> {
    if (!text) {
      await this.sender.sendText(chatId, "用法：/steer <补充指令>");
      return;
    }
    const run = this.activeRuns.get(chatId);
    if (!run || run.controller.signal.aborted) {
      if (this.queues.has(chatId)) {
        await this.queuePendingRunSteer(chatId, text);
        return;
      }
      await this.sender.sendText(chatId, "当前 chat 没有正在运行、可补充指令的 Codex 任务。");
      return;
    }
    if (!run.steer) {
      if (!this.addPendingSteer(run.pendingSteers, text)) {
        await this.sender.sendText(chatId, pendingSteerLimitMessage);
        return;
      }
      await this.sender.sendText(chatId, "当前 Codex 任务正在启动补充指令通道；已暂存这条补充指令，准备好后会自动发送。");
      return;
    }
    await this.sendSteer(chatId, run, text, "sent");
  }

  private async queuePendingRunSteer(chatId: string, text: string): Promise<void> {
    const existing = this.pendingRunSteers.get(chatId);
    if (existing) {
      if (!this.addPendingSteer(existing.items, text)) {
        await this.sender.sendText(chatId, pendingSteerLimitMessage);
        return;
      }
      await this.sender.sendText(chatId, "当前 Codex 任务正在排队或启动；已暂存这条补充指令，准备好后会自动发送。");
      return;
    }

    const pending: PendingRunSteers = {
      items: [{ text }],
      timeoutTimer: setTimeout(() => {
        void this.expirePendingRunSteers(chatId);
      }, pendingRunSteerTtlMs),
    };
    pending.timeoutTimer.unref?.();
    this.pendingRunSteers.set(chatId, pending);
    await this.sender.sendText(chatId, "当前 Codex 任务正在排队或启动；已暂存这条补充指令，准备好后会自动发送。");
  }

  private addPendingSteer(items: PendingSteer[], text: string): boolean {
    if (items.length >= maxPendingSteers) {
      return false;
    }
    items.push({ text });
    return true;
  }

  private takePendingRunSteers(chatId: string): PendingSteer[] {
    const pending = this.pendingRunSteers.get(chatId);
    if (!pending) {
      return [];
    }
    this.pendingRunSteers.delete(chatId);
    clearTimeout(pending.timeoutTimer);
    return pending.items.splice(0);
  }

  private async expirePendingRunSteers(chatId: string): Promise<void> {
    const pending = this.pendingRunSteers.get(chatId);
    if (!pending) {
      return;
    }
    this.pendingRunSteers.delete(chatId);
    const count = pending.items.length;
    if (!count) {
      return;
    }
    try {
      await this.sender.sendText(
        chatId,
        count === 1
          ? "暂存的补充指令没有等到可接收的 Codex 任务，已取消。"
          : `${count} 条暂存的补充指令没有等到可接收的 Codex 任务，已取消。`,
      );
    } catch (error) {
      this.logger.warn("Pending steer expiry notification failed", error);
    }
  }

  private async flushPendingSteers(
    chatId: string,
    run: ActiveRunState,
  ): Promise<void> {
    if (this.activeRuns.get(chatId) !== run || run.controller.signal.aborted || !run.steer) {
      return;
    }
    const pending = run.pendingSteers.splice(0);
    for (const item of pending) {
      if (this.activeRuns.get(chatId) !== run || run.controller.signal.aborted) {
        return;
      }
      await this.sendSteer(chatId, run, item.text, "flushed");
    }
  }

  private async sendSteer(
    chatId: string,
    run: ActiveRunState,
    text: string,
    mode: "sent" | "flushed",
  ): Promise<void> {
    if (!run.steer) {
      await this.sender.sendText(chatId, "当前 Codex 任务暂时还不能接收补充指令，请稍后重试。");
      return;
    }
    try {
      await run.steer(text);
      await this.sender.sendText(
        chatId,
        mode === "sent"
          ? "已把补充指令发送给当前 Codex 任务。"
          : "已把暂存的补充指令发送给当前 Codex 任务。",
      );
    } catch (error) {
      await this.sender.sendText(chatId, `补充指令发送失败：${formatSteerFailure(error)}`);
    }
  }

  private async reportUnsentPendingSteers(chatId: string, run: ActiveRunState): Promise<void> {
    const count = run.pendingSteers.length;
    if (!count) {
      return;
    }
    run.pendingSteers.splice(0);
    await this.sender.sendText(
      chatId,
      count === 1
        ? "当前 Codex 任务已结束，暂存的补充指令未发送。"
        : `当前 Codex 任务已结束，${count} 条暂存的补充指令未发送。`,
    );
  }

  private buildHostHealthInput(chatId: string, state: BridgeState): HostHealthCardInput {
    const codex = probeCodexVersion(this.config.codexBin);
    const warnings = mobileSafetyWarnings(this.config);
    const status = codex.ok && warnings.length === 0 ? "ok" : codex.ok ? "warn" : "error";
    const diagnostics = diagnosticsForChat(state, chatId);
    return {
      title: codex.ok ? "桥接服务在线，Codex CLI 可用。" : "桥接服务在线，但 Codex CLI 检查失败。",
      status,
      host: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      uptime: formatDuration(Date.now() - this.bridgeStartedAtMs),
      queueDepth:
        [...this.queueDepths.values()].reduce((total, depth) => total + depth, 0) +
        this.queuedRuns.size,
      activeRun:
        this.queuedRuns.size > 0
          ? `${this.activeRuns.size} running / ${this.queuedRuns.size} waiting`
          : `${this.activeRuns.size}`,
      approvalWait: `${this.activeApprovals.size}`,
      codexBin: this.config.codexBin,
      codexVersion: codex.version,
      defaultCwd: this.config.codexWorkdir,
      sandbox: this.config.codexSandbox,
      approvalPolicy: this.config.codexApprovalPolicy,
      runTimeout: formatTimeout(this.config.codexRunTimeoutMs),
      approvalTimeout: formatTimeout(this.config.codexApprovalTimeoutMs),
      access: formatAccessSummary(this.config),
      statePath: this.config.bridgeStatePath,
      attachmentDir: this.config.attachmentDownloadDir,
      lastEvent: formatEventDiagnostic(diagnostics.lastEvent),
      lastFailure: diagnostics.recentFailures?.at(-1)
        ? formatRecentFailureLine(diagnostics.recentFailures.at(-1)!)
        : undefined,
      warnings,
    };
  }

  private formatRuntimeStatusLines(chatId: string, state: BridgeState): string[] {
    const diagnostics = diagnosticsForChat(state, chatId);
    const queuedRun = this.queuedRuns.get(chatId);
    const activeRun = this.activeRuns.get(chatId);
    return [
      `queue_depth: ${(this.queueDepths.get(chatId) ?? 0) + (queuedRun ? 1 : 0)}`,
      `active_run: ${activeRun ? formatActiveRun(activeRun) : formatQueuedRun(queuedRun)}`,
      `approval_wait: ${formatApprovalWait(
        [...this.activeApprovals.values()].filter((approval) => approval.chatId === chatId),
      )}`,
      ...formatRecentFailureStatusLines(diagnostics.recentFailures),
    ];
  }

  private formatDiagnosticStatusLines(chatId: string, state: BridgeState): string[] {
    const diagnostics = diagnosticsForChat(state, chatId);
    return [
      `approval_policy: ${this.config.codexApprovalPolicy}`,
      `sandbox: ${this.config.codexSandbox}`,
      `attachment_dir: ${this.config.attachmentDownloadDir}`,
      `last_event: ${formatEventDiagnostic(diagnostics.lastEvent)}`,
      `last_dropped: ${formatEventDiagnostic(diagnostics.lastDroppedEvent)}`,
    ];
  }

  private async sendProjects(chatId: string, chatType: ChatType): Promise<void> {
    if (!this.codex.listThreads) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持读取 app-server 项目列表。");
      return;
    }

    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    let result: CodexThreadListResult;
    try {
      result = await this.codex.listThreads({
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `读取 Codex app-server 项目失败：${formatError(error)}`);
      return;
    }

    const projects = groupThreadsByProject(result.threads).filter((project) =>
      this.directoryAllowedForChat(project.cwd, chatType),
    );
    session.lastProjects = projects;
    session.updatedAt = new Date().toISOString();
    await this.store.save(state);

    if (!projects.length) {
      await this.sender.sendText(
        chatId,
        [
          "Codex app-server 暂未返回项目记录。",
          `当前项目：${session.cwd}`,
          "可以发送 /project /absolute/path 手动指定项目目录。",
        ].join("\n"),
      );
      return;
    }

    const lines = ["**Codex app-server 项目**", "", `当前：\`${session.cwd}\``];
    projects.forEach((project, index) => {
      const current = project.cwd === session.cwd ? "（当前）" : "";
      lines.push("", `**${index + 1}. ${path.basename(project.cwd) || project.cwd}**${current}`);
      lines.push(`\`${project.cwd}\``);
      lines.push(
        [
          `${project.threadCount} 个对话`,
          project.updatedAt ? `最近 ${project.updatedAt}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      const title = project.title ?? project.preview;
      if (title) {
        lines.push(`最新：${truncateInline(title, 90)}`);
      }
    });
    lines.push("", "发送 `/project <编号>` 进入项目，或 `/project /absolute/path` 手动指定。");
    await this.sendCard(
      chatId,
      buildProjectListCard({
        currentCwd: session.cwd,
        projects,
      }),
      lines.join("\n"),
    );
  }

  private async selectProject(chatId: string, chatType: ChatType, argument: string): Promise<void> {
    if (!argument) {
      await this.sender.sendText(chatId, "用法：/project <编号|/absolute/path>");
      return;
    }

    const state = this.requireState();
    const current = this.ensureSession(chatId, state, chatType);
    let cwd: string | null = null;
    const index = parseSelectionIndex(argument);
    if (index !== null) {
      const selected = current.lastProjects?.[index - 1];
      if (!selected) {
        await this.sender.sendText(chatId, "没有这个项目编号。请先发送 /projects 查看可选项目。");
        return;
      }
      cwd = selected.cwd;
    } else {
      const requested = path.isAbsolute(argument)
        ? path.resolve(argument)
        : path.resolve(current.cwd, argument);
      const stat = await fs.stat(requested).catch(() => null);
      if (!stat?.isDirectory()) {
        await this.sender.sendText(chatId, `目录不存在：${requested}`);
        return;
      }
      cwd = requested;
    }

    if (!this.directoryAllowedForChat(cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(cwd));
      return;
    }

    await this.applyProjectSelection(chatId, state, current, cwd);
    await this.sendMarkdown(
      chatId,
      ["**已进入项目**", `\`${cwd}\``, "", "发送 `/sessions` 查看会话，或 `/new` 新建对话。"].join(
        "\n",
      ),
    );
  }

  private async sendThreads(chatId: string, chatType: ChatType): Promise<void> {
    if (!this.codex.listThreads) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持读取 app-server 对话列表。");
      return;
    }

    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    if (!this.directoryAllowedForChat(session.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }
    let result: CodexThreadListResult;
    try {
      result = await this.codex.listThreads({
        cwd: session.cwd,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `读取当前项目对话失败：${formatError(error)}`);
      return;
    }

    const threads = result.threads.filter((thread) => thread.cwd === session.cwd);
    session.lastThreads = threads.map((thread) => toThreadSelection(thread));
    session.updatedAt = new Date().toISOString();
    await this.store.save(state);

    if (!threads.length) {
      await this.sender.sendText(
        chatId,
        [
          "当前项目还没有可继续的 Codex 对话。",
          `project: ${session.cwd}`,
          "发送 /new 新建对话，或直接发送任务。",
        ].join("\n"),
      );
      return;
    }

    const lines = ["**当前项目会话**", "", `项目：\`${session.cwd}\``];
    threads.forEach((thread, index) => {
      const title = threadTitle(thread);
      const current = thread.id === session.threadId ? "（当前）" : "";
      lines.push("", `**${index + 1}. ${truncateInline(title, 90)}**${current}`);
      lines.push(
        [
          thread.updatedAt ? `最近 ${formatCodexTimestamp(thread.updatedAt)}` : null,
          `id \`${thread.id}\``,
          thread.resumable === false ? "不可继续" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      if (thread.resumable === false && thread.unavailableReason) {
        lines.push(`原因：${truncateInline(thread.unavailableReason, 140)}`);
      }
    });
    lines.push("", "发送 `/resume <编号>` 或 `/resume <thread_id>` 继续会话；发送 `/new` 新建会话。");
    await this.sendCard(
      chatId,
      buildSessionListCard({
        cwd: session.cwd,
        currentThreadId: session.threadId,
        sessions: session.lastThreads,
      }),
      lines.join("\n"),
    );
  }

  private async sendHistory(chatId: string, chatType: ChatType, argument: string): Promise<void> {
    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    if (!session.threadId) {
      await this.sender.sendText(chatId, "当前 chat 还没有可查看历史的 Codex 会话。先发送任务或用 /resume 选择会话。");
      return;
    }
    if (!this.directoryAllowedForChat(session.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }

    if (argument) {
      await this.sendHistoryTurnDetail(chatId, session.threadId, argument);
      return;
    }

    if (!this.codex.listThreadTurns) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持读取 app-server 会话历史。");
      return;
    }

    let result: CodexThreadTurnListResult;
    try {
      result = await this.codex.listThreadTurns({
        threadId: session.threadId,
        limit: 12,
        sortDirection: "desc",
        itemsView: "summary",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `读取会话历史失败：${formatError(error)}`);
      return;
    }

    session.lastTurns = result.turns.map((turn) => toTurnSelection(session.threadId!, turn));
    session.updatedAt = new Date().toISOString();
    await this.store.save(state);

    if (!result.turns.length) {
      await this.sender.sendText(chatId, "当前 Codex 会话还没有可展示的历史轮次。");
      return;
    }

    await this.sendMarkdown(chatId, formatThreadHistory(session.threadId, session.cwd, session.lastTurns));
  }

  private async sendHistoryTurnDetail(
    chatId: string,
    threadId: string,
    argument: string,
  ): Promise<void> {
    if (!this.codex.listTurnItems) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持读取历史轮次详情。");
      return;
    }

    const state = this.requireState();
    const session = this.ensureSession(chatId, state);
    const turnId = resolveTurnId(session.lastTurns, argument);
    if (!turnId) {
      await this.sender.sendText(chatId, "没有这个历史编号。请先发送 /history 查看当前会话历史。");
      return;
    }

    let result: CodexThreadTurnItemListResult;
    try {
      result = await this.codex.listTurnItems({
        threadId,
        turnId,
        limit: 100,
        sortDirection: "asc",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `读取历史详情失败：${formatError(error)}`);
      return;
    }

    const detail = formatTurnDetail(threadId, turnId, result.items);
    for (const chunk of splitForChat(detail)) {
      await this.sendMarkdown(chatId, chunk);
    }
  }

  private async searchThreads(chatId: string, chatType: ChatType, query: string): Promise<void> {
    if (!query) {
      await this.sender.sendText(chatId, "用法：/search <关键词>");
      return;
    }
    if (!this.codex.searchThreads) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持搜索 app-server 对话。");
      return;
    }

    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    let result: CodexThreadSearchResult;
    try {
      result = await this.codex.searchThreads({
        searchTerm: query,
        limit: 20,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `搜索 Codex 对话失败：${formatError(error)}`);
      return;
    }

    const selections = result.results
      .filter((item) => this.directoryAllowedForChat(item.thread.cwd, chatType))
      .map((item) => toThreadSelection(item.thread, item.snippet));
    session.lastThreads = selections;
    session.updatedAt = new Date().toISOString();
    await this.store.save(state);

    if (!selections.length) {
      await this.sender.sendText(chatId, `没有找到可访问的 Codex 对话：${query}`);
      return;
    }

    const fallback = formatSearchResults(query, selections);
    await this.sendCard(
      chatId,
      buildSessionListCard({
        cwd: `搜索：${query}`,
        title: "Codex 搜索结果",
        contextLabel: "搜索",
        note: "发送 /resume <编号> 继续会话，或发送 /fork <编号> 分叉会话。",
        currentThreadId: session.threadId,
        sessions: selections,
      }),
      fallback,
    );
  }

  private async resumeThread(chatId: string, chatType: ChatType, argument: string): Promise<void> {
    if (!argument) {
      await this.sender.sendText(chatId, "用法：/resume <编号|thread_id>");
      return;
    }

    const state = this.requireState();
    const current = this.ensureSession(chatId, state, chatType);
    let selection: ThreadSelection | null = null;
    const index = parseSelectionIndex(argument);
    if (index !== null) {
      selection = current.lastThreads?.[index - 1] ?? null;
      if (!selection) {
        await this.sender.sendText(chatId, "没有这个对话编号。请先发送 /threads 查看当前项目对话。");
        return;
      }
    } else {
      if (!this.codex.readThread) {
        await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持按 thread_id 读取对话。");
        return;
      }
      let thread: CodexThread | null;
      try {
        thread = await this.codex.readThread(argument);
      } catch (error) {
        await this.sender.sendText(chatId, `读取对话失败：${formatError(error)}`);
        return;
      }
      if (!thread) {
        await this.sender.sendText(chatId, `找不到对话：${argument}`);
        return;
      }
      selection = toThreadSelection(thread);
    }

    if (selection.resumable === false) {
      await this.sender.sendText(chatId, formatThreadUnavailable(selection));
      return;
    }
    if (!this.directoryAllowedForChat(selection.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(selection.cwd));
      return;
    }

    await this.applyThreadSelection(chatId, state, current, selection);
    await this.sendMarkdown(
      chatId,
      [
        "**已选择会话**",
        `项目：\`${selection.cwd}\``,
        `thread：\`${selection.threadId}\``,
        "",
        "下一条消息会继续这个会话；发送 `/new` 可在当前项目新建会话。",
      ].join("\n"),
    );
  }

  private async forkThread(chatId: string, chatType: ChatType, argument: string): Promise<void> {
    if (!this.codex.forkThread) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持分叉 app-server 对话。");
      return;
    }
    if (this.activeRuns.has(chatId)) {
      await this.sender.sendText(chatId, "当前 chat 正在运行 Codex 任务，完成或 /stop 后再分叉会话。");
      return;
    }

    const state = this.requireState();
    const current = this.ensureSession(chatId, state, chatType);
    const selection = await this.resolveThreadForControl(chatId, chatType, current, argument);
    if (!selection) {
      return;
    }
    if (selection.resumable === false) {
      await this.sender.sendText(chatId, formatThreadUnavailable(selection));
      return;
    }
    if (!this.directoryAllowedForChat(selection.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(selection.cwd));
      return;
    }

    let forked: CodexThread;
    try {
      forked = await this.codex.forkThread({
        threadId: selection.threadId,
        cwd: selection.cwd,
      });
    } catch (error) {
      await this.sender.sendText(chatId, `分叉 Codex 会话失败：${formatError(error)}`);
      return;
    }

    if (!this.directoryAllowedForChat(forked.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(forked.cwd));
      return;
    }

    const forkSelection = toThreadSelection(forked);
    await this.applyThreadSelection(chatId, state, current, forkSelection);
    await this.sendMarkdown(
      chatId,
      [
        "**已分叉 Codex 会话**",
        `来源：\`${selection.threadId}\``,
        `新 thread：\`${forkSelection.threadId}\``,
        `项目：\`${forkSelection.cwd}\``,
        "",
        "下一条消息会继续这个分叉会话；原会话不会被修改。",
      ].join("\n"),
    );
  }

  private async compactThread(chatId: string, chatType: ChatType): Promise<void> {
    if (!this.codex.compactThread) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持压缩 app-server 会话。");
      return;
    }
    if (this.activeRuns.has(chatId)) {
      await this.sender.sendText(chatId, "当前 chat 正在运行 Codex 任务，完成或 /stop 后再压缩会话。");
      return;
    }

    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    if (!session.threadId) {
      await this.sender.sendText(chatId, "当前 chat 还没有可压缩的 Codex 会话。先发送任务或用 /resume 选择会话。");
      return;
    }
    if (!this.directoryAllowedForChat(session.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }

    try {
      await this.codex.compactThread(session.threadId);
    } catch (error) {
      await this.sender.sendText(chatId, `压缩 Codex 会话失败：${formatError(error)}`);
      return;
    }

    session.updatedAt = new Date().toISOString();
    await this.store.save(state);
    await this.sendMarkdown(
      chatId,
      [
        "**已请求压缩当前 Codex 会话**",
        `thread：\`${session.threadId}\``,
        `项目：\`${session.cwd}\``,
        "",
        "下一条消息会继续这个会话。",
      ].join("\n"),
    );
  }

  private async resolveThreadForControl(
    chatId: string,
    chatType: ChatType,
    current: { cwd: string; threadId?: string; lastThreads?: ThreadSelection[] },
    argument: string,
  ): Promise<ThreadSelection | null> {
    if (!argument) {
      if (!current.threadId) {
        await this.sender.sendText(chatId, "用法：/fork <编号|thread_id>，或先用 /resume 选择当前会话后发送 /fork。");
        return null;
      }
      return {
        threadId: current.threadId,
        cwd: current.cwd,
      };
    }

    const index = parseSelectionIndex(argument);
    if (index !== null) {
      const selection = current.lastThreads?.[index - 1];
      if (!selection) {
        await this.sender.sendText(chatId, "没有这个对话编号。请先发送 /threads 或 /search 查看可选对话。");
        return null;
      }
      return selection;
    }

    if (!this.codex.readThread) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持按 thread_id 读取要操作的对话。");
      return null;
    }
    let thread: CodexThread | null;
    try {
      thread = await this.codex.readThread(argument);
    } catch (error) {
      await this.sender.sendText(chatId, `读取对话失败：${formatError(error)}`);
      return null;
    }
    if (!thread) {
      await this.sender.sendText(chatId, `找不到对话：${argument}`);
      return null;
    }
    if (!this.directoryAllowedForChat(thread.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(thread.cwd));
      return null;
    }
    return toThreadSelection(thread);
  }

  private async applyProjectSelection(
    chatId: string,
    state: BridgeState,
    current: { chatType?: ChatType; lastProjects?: ProjectSelection[] },
    cwd: string,
  ): Promise<void> {
    state.chats[chatId] = {
      cwd,
      chatType: current.chatType,
      updatedAt: new Date().toISOString(),
      lastProjects: current.lastProjects,
      lastTurns: undefined,
    };
    await this.store.save(state);
  }

  private async applyThreadSelection(
    chatId: string,
    state: BridgeState,
    current: { chatType?: ChatType; lastProjects?: ProjectSelection[]; lastThreads?: ThreadSelection[] },
    selection: ThreadSelection,
  ): Promise<void> {
    state.chats[chatId] = {
      cwd: selection.cwd,
      threadId: selection.threadId,
      chatType: current.chatType,
      updatedAt: new Date().toISOString(),
      lastProjects: current.lastProjects,
      lastThreads: current.lastThreads,
      lastTurns: undefined,
    };
    await this.store.save(state);
  }

  private async handleUserInputCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse> {
    if (!action.userInputId) {
      return cardActionToast("warning", "无法处理输入请求：缺少请求上下文。");
    }
    const pending = this.activeUserInputs.get(userInputKey(action.chatId, action.userInputId));
    if (!pending) {
      return cardActionToast("warning", "无法处理输入请求：请求已结束或已失效。");
    }
    if (!sameStableSenderIdentity(pending.originSender, action.sender)) {
      return cardActionToast("error", "只有发起当前 Codex 任务的用户可以回答这条输入请求。");
    }
    if (
      !pending.handle ||
      !action.messageId ||
      action.messageId !== pending.handle.messageId
    ) {
      return cardActionToast("warning", "无法处理输入请求：卡片上下文不匹配。");
    }

    if (action.action === cancelUserInputCardAction) {
      const input = this.finishPendingUserInput(pending, "cancelled", { answers: {} });
      await this.updateUserInputCard(pending.handle, input);
      return cardActionCard(buildUserInputCard(input));
    }

    const question = nextUserInputQuestion(pending);
    if (!question || !action.questionId || action.questionId !== question.id) {
      return cardActionToast("warning", "无法处理输入请求：当前问题已变化，请刷新卡片后重试。");
    }

    let answers: string[] = [];
    if (action.optionIndex !== undefined) {
      const options = question.options ?? [];
      const option = options[action.optionIndex];
      if (!option || action.optionIndex < 0) {
        return cardActionToast("warning", "无法处理输入请求：选项已失效。");
      }
      if (option.label.length > maxUserInputAnswerLength) {
        return cardActionToast("warning", "无法处理输入请求：选项内容超过安全长度上限。");
      }
      // Never trust a label supplied by the callback. Resolve the selected value
      // from the original app-server request using the validated index.
      answers = [option.label];
    }

    const input = this.advancePendingUserInput(pending, question.id, answers);
    await this.updateUserInputCard(pending.handle, input);
    return cardActionCard(buildUserInputCard(input));
  }

  private async requestUserInput(
    chatId: string,
    chatType: ChatType,
    originSender: SenderIdentity | undefined,
    request: CodexUserInputRequest,
    signal: AbortSignal,
  ): Promise<CodexUserInputResponse> {
    if (signal.aborted || request.questions.length === 0) {
      return { answers: {} };
    }
    if (request.questions.some((question) => question.isSecret)) {
      await this.sendUserInputTextSafely(
        chatId,
        "这次 Codex 请求包含敏感输入；当前聊天通道不提供安全密码输入，已按安全策略跳过。",
      );
      return { answers: {} };
    }
    if (!originSender || !hasStableSenderIdentity(originSender)) {
      await this.sendUserInputTextSafely(
        chatId,
        "无法确认原始请求人的稳定身份，已拒绝这次 Codex 用户输入请求。",
      );
      return { answers: {} };
    }

    const key = userInputKey(chatId, request.id);
    if (this.activeUserInputs.has(key)) {
      await this.sendUserInputTextSafely(
        chatId,
        "收到重复的 Codex 用户输入请求；为避免回答错配，已拒绝后到请求。",
      );
      return { answers: {} };
    }

    return new Promise<CodexUserInputResponse>((resolve) => {
      let pending!: PendingUserInput;
      const abortListener = () => {
        if (this.activeUserInputs.get(key) !== pending) {
          return;
        }
        const input = this.finishPendingUserInput(pending, "expired", { answers: {} });
        void this.updateUserInputCard(pending.handle, input);
      };
      pending = {
        key,
        chatId,
        chatType,
        originSender: { ...originSender },
        request,
        replyCode: this.createUserInputReplyCode(),
        answers: new Map(),
        resolve,
        signal,
        abortListener,
        handle: null,
      };
      this.activeUserInputs.set(key, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      void this.presentUserInputRequest(pending);
    });
  }

  private async answerUserInputFromText(message: IncomingTextMessage): Promise<void> {
    const command = parseUserInputAnswerCommand(routedText(message));
    if (!command) {
      await this.sender.sendText(message.chatId, "用法：/answer <replyCode> <内容>");
      return;
    }
    const pending = [...this.activeUserInputs.values()].find(
      (candidate) =>
        candidate.chatId === message.chatId &&
        candidate.replyCode.toLowerCase() === command.replyCode.toLowerCase(),
    );
    if (!pending) {
      await this.sender.sendText(message.chatId, "回复码无效，或这条 Codex 输入请求已经结束。");
      return;
    }
    if (!sameStableSenderIdentity(pending.originSender, message.sender)) {
      await this.sender.sendText(
        message.chatId,
        "只有发起当前 Codex 任务的用户可以回答这条输入请求。",
      );
      return;
    }

    const question = nextUserInputQuestion(pending);
    if (!question) {
      await this.sender.sendText(message.chatId, "这条 Codex 输入请求已经结束。");
      return;
    }
    if (command.answer.length > maxUserInputAnswerLength) {
      await this.sender.sendText(
        message.chatId,
        `回答超过 ${maxUserInputAnswerLength} 个字符，未提交；请缩短后重试。`,
      );
      return;
    }
    let answer = command.answer;
    if ((question.options?.length ?? 0) > 0 && !question.isOther) {
      const option = question.options?.find((candidate) => candidate.label === answer);
      if (!option) {
        await this.sender.sendText(
          message.chatId,
          "当前问题只接受卡片中的可选项；请发送完全一致的选项名称。",
        );
        return;
      }
      answer = option.label;
    }

    const input = this.advancePendingUserInput(pending, question.id, [answer]);
    await this.updateUserInputCard(pending.handle, input);
    if (input.status === "pending" && !pending.handle) {
      const delivered = await this.sendUserInputTextSafely(
        message.chatId,
        formatUserInputTextPrompt(pending),
      );
      if (!delivered && this.activeUserInputs.get(pending.key) === pending) {
        this.finishPendingUserInput(pending, "cancelled", { answers: {} });
      }
      return;
    }
    await this.sendUserInputTextSafely(
      message.chatId,
      input.status === "resolved"
        ? "已把回答提交给 Codex（回答内容不会在聊天中回显）。"
        : "已记录当前问题的回答（回答内容不会在聊天中回显）。",
    );
  }

  private advancePendingUserInput(
    pending: PendingUserInput,
    questionId: string,
    answers: string[],
  ): UserInputCardInput {
    pending.answers.set(questionId, { answers: [...answers] });
    if (nextUserInputQuestion(pending)) {
      return this.userInputCardInput(pending, "pending");
    }
    return this.finishPendingUserInput(
      pending,
      "resolved",
      pendingUserInputResponse(pending),
    );
  }

  private finishPendingUserInput(
    pending: PendingUserInput,
    status: "resolved" | "cancelled" | "expired",
    response: CodexUserInputResponse,
  ): UserInputCardInput {
    if (this.activeUserInputs.get(pending.key) === pending) {
      this.activeUserInputs.delete(pending.key);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    const input = this.userInputCardInput(pending, status);
    pending.terminalCard = input;
    pending.resolve(response);
    return input;
  }

  private userInputCardInput(
    pending: PendingUserInput,
    status: UserInputCardInput["status"],
  ): UserInputCardInput {
    return {
      status,
      request: pending.request,
      replyCode: pending.replyCode,
      ...(status === "pending" || status === "resolved"
        ? { answers: redactedUserInputAnswers(pending) }
        : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  private async presentUserInputRequest(pending: PendingUserInput): Promise<void> {
    if (!this.sender.createUserInputCard || !this.sender.updateUserInputCard) {
      const delivered = await this.sendUserInputTextSafely(
        pending.chatId,
        formatUserInputTextPrompt(pending),
      );
      if (!delivered && this.activeUserInputs.get(pending.key) === pending) {
        this.finishPendingUserInput(pending, "cancelled", { answers: {} });
      }
      return;
    }
    try {
      const handle = await this.sender.createUserInputCard(
        pending.chatId,
        this.userInputCardInput(pending, "pending"),
      );
      if (this.activeUserInputs.get(pending.key) === pending) {
        pending.handle = handle;
        const answerCount = pending.answers.size;
        if (answerCount > 0) {
          await this.updateUserInputCard(handle, this.userInputCardInput(pending, "pending"));
        }
        if (this.activeUserInputs.get(pending.key) !== pending) {
          if (pending.terminalCard) {
            await this.updateUserInputCard(handle, pending.terminalCard);
          }
        } else if (pending.answers.size !== answerCount) {
          await this.updateUserInputCard(handle, this.userInputCardInput(pending, "pending"));
        }
        return;
      }
      if (pending.terminalCard) {
        await this.updateUserInputCard(handle, pending.terminalCard);
      }
    } catch (error) {
      this.logger.warn("User-input card creation failed; falling back to text", error);
      if (this.activeUserInputs.get(pending.key) === pending) {
        const delivered = await this.sendUserInputTextSafely(
          pending.chatId,
          formatUserInputTextPrompt(pending),
        );
        if (!delivered && this.activeUserInputs.get(pending.key) === pending) {
          this.finishPendingUserInput(pending, "cancelled", { answers: {} });
        }
      }
    }
  }

  private async updateUserInputCard(
    handle: StatusCardHandle | null,
    input: UserInputCardInput,
  ): Promise<boolean> {
    if (!handle || !this.sender.updateUserInputCard) {
      return false;
    }
    try {
      await this.sender.updateUserInputCard(handle, input);
      return true;
    } catch (error) {
      this.logger.warn("User-input card update failed", error);
      return false;
    }
  }

  private async sendUserInputTextSafely(chatId: string, text: string): Promise<boolean> {
    try {
      await this.sender.sendText(chatId, text);
      return true;
    } catch (error) {
      this.logger.warn("User-input text delivery failed", error);
      return false;
    }
  }

  private async cancelUserInputsForChat(chatId: string): Promise<void> {
    const pending = [...this.activeUserInputs.values()].filter(
      (request) => request.chatId === chatId,
    );
    for (const request of pending) {
      if (this.activeUserInputs.get(request.key) !== request) {
        continue;
      }
      const input = this.finishPendingUserInput(request, "cancelled", { answers: {} });
      await this.updateUserInputCard(request.handle, input);
    }
  }

  private createUserInputReplyCode(): string {
    let code = "";
    do {
      code = randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase();
    } while (
      [...this.activeUserInputs.values()].some(
        (pending) => pending.replyCode.toLowerCase() === code,
      )
    );
    return code;
  }

  private async stopCodex(
    chatId: string,
    options: { notifyChat?: boolean } = {},
  ): Promise<{ stopped: boolean; message: string }> {
    const runState = this.activeRuns.get(chatId);
    if (runState && !runState.controller.signal.aborted) {
      runState.controller.abort();
      const message = "已请求停止当前 chat 的 Codex 任务。";
      if (options.notifyChat !== false) {
        await this.sender.sendText(chatId, message);
      }
      return { stopped: true, message };
    }

    const queuedRun = this.queuedRuns.get(chatId);
    if (queuedRun && !queuedRun.controller.signal.aborted) {
      queuedRun.controller.abort();
      this.queuedRuns.delete(chatId);
      await this.persistCancelledQueuedRun(queuedRun);
      const message = "已取消当前 chat 排队中的 Codex 任务。";
      if (options.notifyChat !== false) {
        await this.sender.sendText(chatId, message);
      }
      return { stopped: true, message };
    }

    const message = "当前 chat 没有正在运行的 Codex 任务。";
    if (options.notifyChat !== false) {
      await this.sender.sendText(chatId, message);
    }
    return { stopped: false, message };
  }

  private async persistCancelledQueuedRun(run: QueuedRunState): Promise<void> {
    if (!run.messageId) {
      return;
    }
    await this.mutateState((state) => {
      const job = state.jobs[run.messageId!];
      if (job?.status === "queued") {
        job.status = "cancelled";
        job.prompt = truncateInline(job.prompt, 180);
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
      }
      markMessageProcessed(state, run.messageId!);
    });
  }

  private handleRetryCardAction(action: IncomingCardAction): CardActionResponse {
    if (!action.messageId) {
      return cardActionToast("warning", "无法重试：缺少状态卡上下文。");
    }

    const run = this.statusCardRuns.get(action.messageId);
    if (!run || run.chatId !== action.chatId) {
      return cardActionToast("warning", "无法重试：当前服务没有这张状态卡的任务上下文。");
    }

    if (this.queues.has(action.chatId)) {
      return cardActionToast("warning", "当前 chat 已有任务排队或运行中。");
    }

    this.enqueueTask(action.chatId, () =>
      this.runCodex(
        action.chatId,
        run.prompt,
        this.chatTypeForAction(action.chatId),
        undefined,
        action.sender,
      ),
    ).catch(
      (error) => {
        this.logger.error("Retry task failed", error);
      },
    );
    return cardActionToast("success", "已把这次任务重新加入当前 chat 的 Codex 队列。");
  }

  private async handleRunDetailCardAction(action: IncomingCardAction): Promise<CardActionResponse> {
    const kind = action.detailKind ?? "summary";
    await this.sendRunDetail(action.chatId, kind);
    return cardActionToast("success", "已发送最近一轮运行详情。");
  }

  private async handleProjectPageCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
    const page = action.page;
    if (!page || page < 1) {
      return cardActionToast("warning", "无法翻页：缺少页码。");
    }
    const state = this.requireState();
    const session = this.ensureSession(action.chatId, state);
    const projects = session.lastProjects;
    if (!projects?.length) {
      return cardActionToast("warning", "这个项目列表已失效，请重新发送 /projects。");
    }

    const card = buildProjectListCard({
      currentCwd: session.cwd,
      projects,
      page,
    });
    return this.updateActionCardOrFallback(action, card, "已更新项目列表。");
  }

  private async handleSessionPageCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
    const page = action.page;
    if (!page || page < 1) {
      return cardActionToast("warning", "无法翻页：缺少页码。");
    }
    const state = this.requireState();
    const session = this.ensureSession(action.chatId, state);
    const sessions = session.lastThreads;
    if (!sessions?.length) {
      return cardActionToast("warning", "这个会话列表已失效，请重新发送 /sessions。");
    }

    const card = buildSessionListCard({
      cwd: session.cwd,
      currentThreadId: session.threadId,
      sessions,
      page,
    });
    return this.updateActionCardOrFallback(action, card, "已更新会话列表。");
  }

  private async handleSelectProjectCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
    if (
      this.queues.has(action.chatId) ||
      this.queuedRuns.has(action.chatId) ||
      this.activeRuns.has(action.chatId)
    ) {
      return cardActionToast("warning", "当前 chat 有任务排队或运行中，完成或停止后再切换项目。");
    }
    const index = action.projectIndex;
    if (!index || index < 1) {
      return cardActionToast("warning", "无法进入项目：缺少项目编号。");
    }
    const state = this.requireState();
    const session = this.ensureSession(action.chatId, state);
    const selected = session.lastProjects?.[index - 1];
    if (!selected) {
      return cardActionToast("warning", "这个项目列表已失效，请重新发送 /projects。");
    }
    if (!this.directoryAllowedForChat(selected.cwd, this.chatTypeForAction(action.chatId))) {
      return cardActionToast("error", this.formatDirectoryDenied(selected.cwd));
    }

    await this.applyProjectSelection(action.chatId, state, session, selected.cwd);
    const card = buildProjectListCard({
      currentCwd: selected.cwd,
      projects: session.lastProjects ?? [],
      page: action.page ?? pageForIndex(index),
      selectedProjectIndex: index,
      status: "selected",
    });
    return this.updateActionCardOrFallback(
      action,
      card,
      `已进入项目：${path.basename(selected.cwd) || selected.cwd}`,
    );
  }

  private async handleResumeThreadCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
    if (
      this.queues.has(action.chatId) ||
      this.queuedRuns.has(action.chatId) ||
      this.activeRuns.has(action.chatId)
    ) {
      return cardActionToast("warning", "当前 chat 有任务排队或运行中，完成或停止后再切换会话。");
    }
    const index = action.threadIndex;
    if (!index || index < 1) {
      return cardActionToast("warning", "无法继续会话：缺少会话编号。");
    }
    const state = this.requireState();
    const session = this.ensureSession(action.chatId, state);
    const selected = session.lastThreads?.[index - 1];
    if (!selected) {
      return cardActionToast("warning", "这个会话列表已失效，请重新发送 /sessions。");
    }
    if (selected.resumable === false) {
      return cardActionToast("warning", formatThreadUnavailable(selected));
    }
    if (!this.directoryAllowedForChat(selected.cwd, this.chatTypeForAction(action.chatId))) {
      return cardActionToast("error", this.formatDirectoryDenied(selected.cwd));
    }

    await this.applyThreadSelection(action.chatId, state, session, selected);
    const card = buildSessionListCard({
      cwd: selected.cwd,
      currentThreadId: selected.threadId,
      sessions: session.lastThreads ?? [],
      page: action.page ?? pageForIndex(index),
      selectedThreadIndex: index,
      status: "selected",
    });
    return this.updateActionCardOrFallback(
      action,
      card,
      `已选择会话：${selected.title ?? selected.threadId}`,
    );
  }

  private async handleApprovalCardAction(action: IncomingCardAction): Promise<CardActionResponse> {
    if (
      !approvalActionSenderAllowed(
        this.config.access.allowedUserIds,
        action.sender,
        this.chatTypeForAction(action.chatId),
      )
    ) {
      return cardActionToast("error", "群聊中的 Codex 审批必须由 ALLOWED_USER_IDS 中的用户处理。");
    }
    if (!action.approvalId) {
      return cardActionToast("warning", "无法处理审批：缺少审批上下文。");
    }
    const pending = this.activeApprovals.get(action.approvalId);
    if (!pending || pending.chatId !== action.chatId) {
      return cardActionToast("warning", "无法处理审批：当前服务没有这条待审批请求。");
    }
    if (action.decisionIndex === undefined) {
      return cardActionToast("warning", "无法处理审批：缺少审批选项。");
    }
    if (!isApprovalDecisionIndexAllowed(pending.request, action.decisionIndex)) {
      return cardActionToast("warning", "无法处理审批：该选项未通过安全披露校验。");
    }
    const decision = pending.request.decisions[action.decisionIndex];
    if (!decision) {
      return cardActionToast("warning", "无法处理审批：审批选项已失效。");
    }

    this.activeApprovals.delete(action.approvalId);
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pending.decision = decision;
    pending.resolvedAt = new Date().toISOString();
    pending.resolve(decision);
    const resolvedInput: ApprovalCardInput = {
      status: "resolved",
      request: pending.request,
      decision,
      updatedAt: pending.resolvedAt,
    };
    void this.updateApprovalCard(pending.handle, resolvedInput);
    return cardActionCard(buildApprovalCard(resolvedInput));
  }

  private async requestApproval(
    chatId: string,
    request: CodexApprovalRequest,
    signal: AbortSignal,
    statusCard: StatusCardHandle | null,
    cwd: string,
    prompt: string,
    startedAt: string,
  ): Promise<CodexApprovalDecision> {
    if (signal.aborted) {
      return "cancel";
    }

    await this.updateStatusCard(statusCard, {
      status: "running",
      detail: approvalStatusDetail(request),
      cwd,
      prompt,
      startedAt,
      updatedAt: new Date().toISOString(),
    });

    return new Promise<CodexApprovalDecision>((resolve) => {
      const createdAtMs = Date.now();
      const pending: PendingApproval = {
        chatId,
        request,
        resolve,
        handle: null,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
      };
      this.activeApprovals.set(request.id, pending);
      const cancel = () => {
        if (this.activeApprovals.get(request.id) !== pending) {
          return;
        }
        this.activeApprovals.delete(request.id);
        if (pending.timeoutTimer) {
          clearTimeout(pending.timeoutTimer);
        }
        pending.cancelledAt = new Date().toISOString();
        pending.cancelReason = "run_cancelled";
        resolve("cancel");
        this.updateApprovalCard(pending.handle, {
          status: "cancelled",
          request,
          updatedAt: pending.cancelledAt,
        }).catch((error: unknown) => {
          this.logger.warn("Approval card cancellation update failed", error);
        });
      };
      signal.addEventListener("abort", cancel, { once: true });

      if (this.config.codexApprovalTimeoutMs > 0) {
        pending.timeoutTimer = setTimeout(() => {
          if (this.activeApprovals.get(request.id) !== pending) {
            return;
          }
          this.activeApprovals.delete(request.id);
          pending.cancelledAt = new Date().toISOString();
          pending.cancelReason = "timeout";
          resolve("cancel");
          this.updateApprovalCard(pending.handle, {
            status: "cancelled",
            request,
            updatedAt: pending.cancelledAt,
          }).catch((error: unknown) => {
            this.logger.warn("Approval card timeout update failed", error);
          });
          this.updateStatusCard(statusCard, {
            status: "running",
            detail: "Codex 审批等待超时，已取消这次审批请求。",
            cwd,
            prompt,
            startedAt,
            updatedAt: pending.cancelledAt,
          }).catch((error: unknown) => {
            this.logger.warn("Status card approval-timeout update failed", error);
          });
          this.recordRecentFailure(chatId, {
            category: "approval_timeout",
            cwd,
            promptPreview: prompt,
            detail: `Approval exceeded CODEX_APPROVAL_TIMEOUT_MS=${this.config.codexApprovalTimeoutMs}.`,
            hint: approvalTimeoutHint(this.config.codexApprovalTimeoutMs),
          }).catch((error: unknown) => {
            this.logger.warn("Failed to record approval timeout", error);
          });
        }, this.config.codexApprovalTimeoutMs);
        pending.timeoutTimer.unref?.();
      }

      this.createApprovalCard(chatId, {
        status: "pending",
        request,
        updatedAt: new Date().toISOString(),
      })
        .then((handle) => {
          if (this.activeApprovals.get(request.id) === pending) {
            pending.handle = handle;
            return;
          }
          if (pending.resolvedAt && pending.decision) {
            this.updateApprovalCard(handle, {
              status: "resolved",
              request,
              decision: pending.decision,
              updatedAt: pending.resolvedAt,
            }).catch((error: unknown) => {
              this.logger.warn("Late approval card resolution update failed", error);
            });
            return;
          }
          if (pending.cancelledAt) {
            this.updateApprovalCard(handle, {
              status: "cancelled",
              request,
              updatedAt: pending.cancelledAt,
            }).catch((error: unknown) => {
              this.logger.warn("Late approval card cancellation update failed", error);
            });
          }
        })
        .catch((error: unknown) => {
          this.logger.warn("Approval card creation failed; cancelling approval request", error);
          if (this.activeApprovals.get(request.id) === pending) {
            this.activeApprovals.delete(request.id);
            resolve("cancel");
          }
        });
    });
  }

  private async cancelApprovalsForChat(chatId: string): Promise<void> {
    const pending = [...this.activeApprovals.values()].filter((approval) => approval.chatId === chatId);
    for (const approval of pending) {
      if (this.activeApprovals.get(approval.request.id) !== approval) {
        continue;
      }
      this.activeApprovals.delete(approval.request.id);
      if (approval.timeoutTimer) {
        clearTimeout(approval.timeoutTimer);
      }
      approval.cancelledAt = new Date().toISOString();
      approval.cancelReason = "run_cancelled";
      approval.resolve("cancel");
      await this.updateApprovalCard(approval.handle, {
        status: "cancelled",
        request: approval.request,
        updatedAt: approval.cancelledAt,
      });
    }
  }

  private rememberStatusCardRun(
    handle: StatusCardHandle | null,
    chatId: string,
    prompt: string,
  ): void {
    if (!handle) {
      return;
    }

    this.statusCardRuns.set(handle.messageId, { chatId, prompt });
    while (this.statusCardRuns.size > maxRememberedStatusCards) {
      const oldestKey = this.statusCardRuns.keys().next().value;
      if (!oldestKey) {
        return;
      }
      this.statusCardRuns.delete(oldestKey);
    }
  }

  private createProgressReporter(
    chatId: string,
    signal: AbortSignal,
    statusCard: StatusCardHandle | null,
    cwd: string,
    prompt: string,
    startedAt: string,
    runState: ActiveRunState,
  ): (update: CodexProgressUpdate) => Promise<void> {
    let lastSentAt = 0;
    let cardUpdatesFailed = false;
    return async (update) => {
      if (signal.aborted) {
        return;
      }
      const now = Date.now();
      runState.lastProgressAtMs = now;
      runState.lastProgressAt = new Date(now).toISOString();
      runState.lastProgressText = update.text;
      if (lastSentAt !== 0 && now - lastSentAt < minProgressIntervalMs) {
        return;
      }
      lastSentAt = now;
      if (statusCard && !cardUpdatesFailed) {
        const updated = await this.updateStatusCard(statusCard, {
          status: "running",
          detail: update.text,
          cwd,
          prompt,
          startedAt,
          updatedAt: new Date(now).toISOString(),
        });
        if (updated) {
          return;
        }
        cardUpdatesFailed = true;
      }
      await this.sender.sendText(chatId, update.text);
    };
  }

  private async createStatusCard(
    chatId: string,
    input: RunStatusCardInput,
  ): Promise<StatusCardHandle | null> {
    if (!this.sender.createStatusCard || !this.sender.updateStatusCard) {
      await this.sender.sendText(chatId, input.detail);
      return null;
    }

    try {
      return await this.sender.createStatusCard(chatId, input);
    } catch (error) {
      this.logger.warn("Status card creation failed; falling back to text progress", error);
      await this.sender.sendText(chatId, input.detail);
      return null;
    }
  }

  private async updateStatusCard(
    handle: StatusCardHandle | null,
    input: RunStatusCardInput,
  ): Promise<boolean> {
    if (!handle || !this.sender.updateStatusCard) {
      return false;
    }

    try {
      await this.sender.updateStatusCard(handle, input);
      return true;
    } catch (error) {
      this.logger.warn("Status card update failed", error);
      return false;
    }
  }

  private async createApprovalCard(
    chatId: string,
    input: ApprovalCardInput,
  ): Promise<StatusCardHandle | null> {
    if (!this.sender.createApprovalCard || !this.sender.updateApprovalCard) {
      await this.sender.sendText(chatId, "Codex 正在等待审批，但当前聊天适配器不支持审批卡片。");
      throw new Error("approval cards are not supported by this chat sender");
    }

    try {
      return await this.sender.createApprovalCard(chatId, input);
    } catch (error) {
      this.logger.warn("Approval card creation failed", error);
      await this.sender.sendText(chatId, "Codex 审批卡片创建失败，已取消这次审批请求。");
      throw error;
    }
  }

  private async updateApprovalCard(
    handle: StatusCardHandle | null,
    input: ApprovalCardInput,
  ): Promise<boolean> {
    if (!handle || !this.sender.updateApprovalCard) {
      return false;
    }

    try {
      await this.sender.updateApprovalCard(handle, input);
      return true;
    } catch (error) {
      this.logger.warn("Approval card update failed", error);
      return false;
    }
  }

  private async updateActionCardOrFallback(
    action: IncomingCardAction,
    card: LarkInteractiveCard,
    successToast: string,
  ): Promise<CardActionResponse | undefined> {
    this.logger.debug(successToast, {
      chatId: action.chatId,
      messageId: action.messageId,
    });
    return cardActionCard(card);
  }

  private async sendWhoami(message: IncomingTextMessage): Promise<void> {
    const decision = decideAccess(this.config.access, toAccessContext(message));
    const senderLines =
      message.chatType === "direct"
        ? [
            `sender.open_id: ${message.sender.openId ?? "(unknown)"}`,
            ...(message.sender.userId ? [`sender.user_id: ${message.sender.userId}`] : []),
            `sender.union_id: ${message.sender.unionId ?? "(unknown)"}`,
          ]
        : [];
    await this.sender.sendText(
      message.chatId,
      [
        "Chat2Codex 当前会话信息：",
        `chat_id: ${message.chatId}`,
        `chat_type: ${message.chatType}`,
        ...senderLines,
        `access: ${decision.allowed ? "allowed" : `denied (${decision.reason ?? "unknown"})`}`,
      ].join("\n"),
    );
  }

  private async resetSession(chatId: string): Promise<void> {
    const state = this.requireState();
    const current = this.ensureSession(chatId, state);
    const cwd = current.cwd;
    state.chats[chatId] = {
      cwd,
      chatType: current.chatType,
      updatedAt: new Date().toISOString(),
      lastProjects: current.lastProjects,
      lastThreads: current.lastThreads,
    };
    await this.store.save(state);
    await this.sendMarkdown(chatId, ["**已新建当前项目的 Codex 会话**", `\`${cwd}\``].join("\n"));
  }

  private async changeDirectory(
    chatId: string,
    chatType: ChatType,
    requestedPath: string,
  ): Promise<void> {
    if (!requestedPath) {
      await this.sender.sendText(chatId, "用法：/cd /absolute/path/to/repo");
      return;
    }

    const requestedCwd = path.resolve(requestedPath);
    const stat = await fs.stat(requestedCwd).catch(() => null);
    if (!stat?.isDirectory()) {
      await this.sender.sendText(chatId, `目录不存在：${requestedCwd}`);
      return;
    }
    const nextCwd = await fs.realpath(requestedCwd);
    if (!this.directoryAllowedForChat(nextCwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(nextCwd));
      return;
    }

    const state = this.requireState();
    const current = state.chats[chatId];
    state.chats[chatId] = {
      cwd: nextCwd,
      chatType,
      updatedAt: new Date().toISOString(),
      lastProjects: current?.lastProjects,
    };
    await this.store.save(state);
    await this.sender.sendText(chatId, `已切换 cwd，并重置 session：\n${nextCwd}`);
  }

  private ensureSession(
    chatId: string,
    state: BridgeState = this.requireState(),
    chatType?: ChatType,
  ) {
    const session = state.chats[chatId] ?? {
      cwd: this.config.codexWorkdir,
      updatedAt: new Date().toISOString(),
    };
    if (chatType) {
      session.chatType = chatType;
    }
    state.chats[chatId] = session;
    return session;
  }

  private chatTypeForAction(chatId: string): ChatType {
    return this.requireState().chats[chatId]?.chatType ?? "group";
  }

  private directoryAllowedForChat(cwd: string, chatType: ChatType | undefined): boolean {
    if (chatType !== "group") {
      return true;
    }
    const resolved = path.resolve(cwd);
    return this.config.codexGroupAllowedRoots.some((root) => isPathWithin(root, resolved));
  }

  private formatDirectoryDenied(cwd: string): string {
    return [
      "当前群聊不能使用这个目录。",
      `requested: ${cwd}`,
      `allowed: ${this.config.codexGroupAllowedRoots.join(", ")}`,
      "如需在群聊开放更多项目，请配置 CODEX_GROUP_ALLOWED_ROOTS；私聊不受这个目录限制。",
    ].join("\n");
  }

  private async recordRecentFailure(
    chatId: string,
    failure: Omit<RecentFailureDiagnostic, "at"> & { at?: string },
  ): Promise<void> {
    await this.mutateState((state) => {
      const diagnostics = ensureChatDiagnostics(state, chatId);
      const recentFailures = diagnostics.recentFailures ?? [];
      diagnostics.recentFailures = [
        ...recentFailures,
        {
          at: failure.at ?? new Date().toISOString(),
          category: failure.category,
          cwd: failure.cwd,
          promptPreview: failure.promptPreview
            ? truncateInline(failure.promptPreview, 120)
            : undefined,
          threadId: failure.threadId,
          exitCode: failure.exitCode,
          signal: failure.signal,
          detail: truncateInline(failure.detail, 240),
          hint: failure.hint ? truncateInline(failure.hint, 240) : undefined,
        },
      ].slice(-5);
    });
    this.logger.warn("Recorded recent Chat2Codex failure", {
      chatId,
      category: failure.category,
    });
  }

  private mutateState<T>(mutation: (state: BridgeState) => T): Promise<T> {
    const operation = this.stateMutationTail
      .catch(() => undefined)
      .then(async () => {
        const state = this.requireState();
        const previous = structuredClone(state);
        try {
          const result = mutation(state);
          await this.store.save(state);
          return result;
        } catch (error) {
          restoreBridgeState(state, previous);
          throw error;
        }
      });
    this.stateMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private requireState(): BridgeState {
    if (!this.state) {
      throw new Error("MessageRouter.start() must be called before handling messages.");
    }
    return this.state;
  }
}

function restoreBridgeState(target: BridgeState, source: BridgeState): void {
  target.chats = source.chats;
  target.jobs = source.jobs;
  target.outbox = source.outbox;
  target.pendingMessages = source.pendingMessages;
  target.processedMessageIds = source.processedMessageIds;
  target.diagnostics = source.diagnostics;
}

interface ProjectAggregate extends ProjectSelection {
  sortUpdatedMs: number;
}

interface LastRunBuildInput {
  status: LastRunStatus;
  cwd: string;
  threadId?: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  summary?: CodexRunSummary;
  finalText?: string;
  errorText?: string;
}

function buildLastRunSummary(input: LastRunBuildInput): LastRunSummary {
  const durationMs =
    input.summary?.durationMs ?? Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  return {
    id: `${Date.parse(input.completedAt) || Date.now()}`,
    status: input.status,
    cwd: input.cwd,
    threadId: input.threadId,
    promptPreview: truncateInline(input.prompt, 180),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    finalTextPreview: input.finalText ? truncateDetail(input.finalText, 600) : undefined,
    errorPreview: input.errorText ? truncateDetail(input.errorText, 600) : undefined,
    review: toLastRunReviewSummary(input.summary, input.cwd),
  };
}

function toLastRunReviewSummary(summary: CodexRunSummary | undefined, cwd: string): LastRunReviewSummary {
  const changedFiles = normalizeChangedFiles(cwd, summary?.changedFiles ?? []);
  return {
    changedFiles,
    diff: summary?.diff ? truncateDetail(summary.diff, 60_000) : undefined,
    diffStat: summary?.diffStat,
    fileChangeCount: summary?.fileChangeCount ?? 0,
    commands: summary?.commands.map(toLastRunCommandSummary) ?? [],
  };
}

function toLastRunCommandSummary(command: CodexCommandSummary): LastRunCommandSummary {
  return {
    command: truncateDetail(command.command, 800),
    cwd: command.cwd,
    status: command.status,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    outputPreview: command.outputPreview ? truncateDetail(command.outputPreview, 4000) : undefined,
  };
}

function runResultCardInput(lastRun: LastRunSummary): RunResultCardInput {
  const changedFiles = normalizeChangedFiles(lastRun.cwd, lastRun.review.changedFiles);
  const failedCommands = lastRun.review.commands.filter((command) =>
    command.exitCode !== undefined && command.exitCode !== null
      ? command.exitCode !== 0
      : command.status === "failed",
  );
  return {
    threadId: lastRun.threadId,
    durationMs: lastRun.durationMs,
    changedFileCount: changedFiles.length,
    commandCount: lastRun.review.commands.length,
    failedCommandCount: failedCommands.length,
    diffAvailable: Boolean(lastRun.review.diff),
    logsAvailable: lastRun.review.commands.length > 0,
    filesPreview: changedFiles.slice(0, 3),
    statusNote: lastRun.errorPreview ? truncateInline(lastRun.errorPreview, 80) : undefined,
  };
}

function formatRunDetail(lastRun: LastRunSummary, kind: RunDetailKind): string {
  if (kind === "files") {
    const changedFiles = normalizeChangedFiles(lastRun.cwd, lastRun.review.changedFiles);
    if (!changedFiles.length) {
      return "最近一轮没有可展示的文件变更记录。";
    }
    return [
      "**最近一轮变更文件**",
      `状态：${lastRun.status}`,
      `cwd：\`${lastRun.cwd}\``,
      "",
      ...changedFiles.map((file) => `- \`${file}\``),
    ].join("\n");
  }
  if (kind === "diff") {
    if (!lastRun.review.diff) {
      return "最近一轮没有可展示的 diff。";
    }
    return [
      "**最近一轮 diff**",
      lastRun.review.diffStat ? `_${lastRun.review.diffStat}_` : null,
      "",
      "```diff",
      lastRun.review.diff,
      "```",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }
  if (kind === "logs") {
    if (!lastRun.review.commands.length) {
      return "最近一轮没有可展示的命令日志。";
    }
    return [
      "**最近一轮命令日志**",
      ...lastRun.review.commands.map(formatRunCommandDetail),
    ].join("\n\n");
  }
  return [
    "**最近一轮运行摘要**",
    `状态：${lastRun.status}`,
    `cwd：\`${lastRun.cwd}\``,
    lastRun.threadId ? `thread：\`${lastRun.threadId}\`` : null,
    `耗时：${lastRun.durationMs !== undefined ? formatDuration(lastRun.durationMs) : "(unknown)"}`,
    `完成：${lastRun.completedAt}`,
    `prompt：${lastRun.promptPreview}`,
    `文件：${normalizeChangedFiles(lastRun.cwd, lastRun.review.changedFiles).length}`,
    `命令：${lastRun.review.commands.length}`,
    lastRun.review.diffStat ? `diff：${lastRun.review.diffStat}` : null,
    lastRun.errorPreview ? `错误：${lastRun.errorPreview}` : null,
    lastRun.finalTextPreview ? `最终回复预览：${lastRun.finalTextPreview}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function normalizeChangedFiles(cwd: string, files: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const file of files) {
    const displayPath = normalizeChangedFilePath(cwd, file);
    if (!displayPath) {
      continue;
    }
    const key = path.normalize(displayPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(displayPath);
  }
  return normalized.slice(0, 200);
}

function normalizeChangedFilePath(cwd: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed) {
    return "";
  }
  if (!path.isAbsolute(trimmed)) {
    return trimmed;
  }
  const relative = path.relative(cwd, trimmed);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return trimmed;
}

function formatRunCommandDetail(command: LastRunCommandSummary, index: number): string {
  const meta = [
    command.cwd ? `cwd=${command.cwd}` : null,
    command.status ? `status=${command.status}` : null,
    command.exitCode !== undefined ? `exit=${command.exitCode ?? "null"}` : null,
    command.durationMs !== undefined ? `duration=${formatDuration(command.durationMs)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    `**${index + 1}.** \`${command.command}\``,
    meta || null,
    command.outputPreview ? ["```text", command.outputPreview, "```"].join("\n") : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatHostHealth(input: HostHealthCardInput): string {
  return [
    "**Chat2Codex Host 健康卡**",
    input.title,
    "",
    `host: ${input.host}`,
    `platform: ${input.platform}`,
    `uptime: ${input.uptime}`,
    `queue: ${input.queueDepth}`,
    `active_run: ${input.activeRun}`,
    `approval_wait: ${input.approvalWait}`,
    `codex: ${input.codexVersion}`,
    `codex_bin: ${input.codexBin}`,
    `default_cwd: ${input.defaultCwd}`,
    `sandbox: ${input.sandbox}`,
    `approval: ${input.approvalPolicy}`,
    `run_timeout: ${input.runTimeout}`,
    `approval_timeout: ${input.approvalTimeout}`,
    `access: ${input.access}`,
    `state: ${input.statePath}`,
    `attachments: ${input.attachmentDir}`,
    input.lastEvent ? `last_event: ${input.lastEvent}` : null,
    input.lastFailure ? `last_failure: ${input.lastFailure}` : null,
    ...input.warnings.map((warning) => `warning: ${warning}`),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function probeCodexVersion(codexBin: string): { ok: boolean; version: string } {
  const result = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    env: buildCodexChildEnv(),
    timeout: 5000,
  });
  if (result.status === 0) {
    return {
      ok: true,
      version: (result.stdout || result.stderr).trim() || "available",
    };
  }
  return {
    ok: false,
    version: result.error?.message ?? ((result.stderr || result.stdout).trim() || "unavailable"),
  };
}

function mobileSafetyWarnings(config: BridgeConfig): string[] {
  const warnings: string[] = [];
  if (
    config.access.allowDirectMessages &&
    config.access.allowedUserIds.length === 0 &&
    config.access.allowedChatIds.length === 0
  ) {
    warnings.push("私聊尚未配置 ALLOWED_USER_IDS 或 ALLOWED_CHAT_IDS，除 /whoami 外的消息会被拒绝。");
  }
  if (config.access.allowGroups && config.access.allowedUserIds.length === 0) {
    warnings.push("群聊已开启，但 ALLOWED_USER_IDS 为空；群消息和卡片操作都会被拒绝。");
  }
  if (config.access.allowGroups && config.codexApprovalPolicy === "never") {
    warnings.push("群聊中使用 CODEX_APPROVAL_POLICY=never 风险较高，建议改为 on-request。");
  }
  if (config.access.allowGroups && config.codexRunTimeoutMs === 0) {
    warnings.push("群聊中 CODEX_RUN_TIMEOUT_MS=0 会让任务无限等待，建议设置正整数。");
  }
  if (config.access.allowGroups && config.codexApprovalTimeoutMs === 0) {
    warnings.push("群聊中 CODEX_APPROVAL_TIMEOUT_MS=0 会让审批无限等待，建议设置正整数。");
  }
  if (config.codexSandbox === "danger-full-access") {
    warnings.push("当前 sandbox 是 danger-full-access；远程聊天入口建议使用 workspace-write。");
  }
  if (!path.isAbsolute(config.codexBin)) {
    warnings.push("CODEX_BIN 不是绝对路径；后台服务环境可能找不到 Codex。");
  }
  return warnings;
}

function formatTimeout(value: number): string {
  return value === 0 ? "disabled" : formatDuration(value);
}

function formatAccessSummary(config: BridgeConfig): string {
  return [
    config.access.allowDirectMessages ? "direct:on" : "direct:off",
    config.access.allowGroups ? "groups:on" : "groups:off",
    `allowed_chats=${config.access.allowedChatIds.length}`,
    `allowed_users=${config.access.allowedUserIds.length}`,
  ].join(" ");
}

function formatRecentFailureLine(failure: RecentFailureDiagnostic): string {
  return [
    failure.at,
    failure.category,
    failure.cwd ? `cwd=${failure.cwd}` : null,
    failure.threadId ? `thread=${failure.threadId}` : null,
    `detail=${failure.detail}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function truncateDetail(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 32).trimEnd()}\n... [truncated]`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatSteerFailure(error: unknown): string {
  const message = formatError(error);
  if (/no active turn to steer|turn is not steerable|turn is no longer running|turn has already completed/i.test(message)) {
    return "当前 Codex 任务暂时不能接收补充指令，可能还没进入可补充阶段或已经结束。";
  }
  return message;
}

function formatThreadUnavailable(selection: ThreadSelection): string {
  return [
    "这个 Codex 会话当前不可继续。",
    `thread: ${selection.threadId}`,
    selection.unavailableReason ? `原因：${selection.unavailableReason}` : null,
    "可以发送 /new 在当前项目新建会话；如果要继续这个历史会话，请让 Chat2Codex 使用与该会话兼容的 CODEX_BIN。",
  ]
    .filter(Boolean)
    .join("\n");
}

function groupThreadsByProject(threads: CodexThread[]): ProjectSelection[] {
  const projects = new Map<string, ProjectAggregate>();
  for (const thread of threads) {
    const current = projects.get(thread.cwd) ?? {
      cwd: thread.cwd,
      threadCount: 0,
      sortUpdatedMs: 0,
    };
    current.threadCount += 1;
    const updatedMs = codexTimestampMs(thread.updatedAt);
    if (updatedMs >= current.sortUpdatedMs) {
      current.sortUpdatedMs = updatedMs;
      current.updatedAt = thread.updatedAt ? formatCodexTimestamp(thread.updatedAt) : undefined;
      current.title = threadTitle(thread);
      current.preview = cleanText(thread.preview);
      current.latestThreadId = thread.id;
    }
    projects.set(thread.cwd, current);
  }

  return [...projects.values()]
    .sort((left, right) => right.sortUpdatedMs - left.sortUpdatedMs || left.cwd.localeCompare(right.cwd))
    .map(({ sortUpdatedMs: _sortUpdatedMs, ...project }) => project);
}

function toThreadSelection(thread: CodexThread, previewOverride?: string): ThreadSelection {
  return {
    threadId: thread.id,
    cwd: thread.cwd,
    title: threadTitle(thread),
    preview: cleanText(previewOverride) ?? cleanText(thread.preview),
    updatedAt: thread.updatedAt ? formatCodexTimestamp(thread.updatedAt) : undefined,
    resumable: thread.resumable,
    unavailableReason: thread.unavailableReason,
  };
}

function toTurnSelection(threadId: string, turn: CodexThreadTurn): TurnSelection {
  return {
    threadId,
    turnId: turn.id,
    status: turn.status,
    startedAt: turn.startedAt ? formatCodexTimestamp(turn.startedAt) : undefined,
    completedAt: turn.completedAt ? formatCodexTimestamp(turn.completedAt) : undefined,
    durationMs: turn.durationMs ?? undefined,
    summary: summarizeTurnItems(turn.items),
  };
}

function resolveTurnId(turns: TurnSelection[] | undefined, argument: string): string | null {
  const index = parseSelectionIndex(argument);
  if (index !== null) {
    return turns?.[index - 1]?.turnId ?? null;
  }
  return argument.trim() || null;
}

function formatSearchResults(query: string, selections: ThreadSelection[]): string {
  const lines = ["**Codex 搜索结果**", `关键词：${query}`];
  selections.forEach((selection, index) => {
    lines.push("", `**${index + 1}. ${truncateInline(selection.title ?? selection.threadId, 90)}**`);
    lines.push(`项目：\`${selection.cwd}\``);
    lines.push(
      [
        selection.updatedAt ? `最近 ${selection.updatedAt}` : null,
        `id \`${selection.threadId}\``,
        selection.resumable === false ? "不可继续" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (selection.preview) {
      lines.push(`匹配：${truncateInline(selection.preview, 160)}`);
    }
  });
  lines.push("", "发送 `/resume <编号>` 继续会话，或 `/fork <编号>` 分叉会话。");
  return lines.join("\n");
}

function formatThreadHistory(threadId: string, cwd: string, turns: TurnSelection[]): string {
  const lines = ["**当前会话历史**", `项目：\`${cwd}\``, `thread：\`${threadId}\``];
  turns.forEach((turn, index) => {
    const meta = [
      turn.startedAt ? `开始 ${turn.startedAt}` : null,
      turn.completedAt ? `完成 ${turn.completedAt}` : null,
      turn.durationMs !== undefined ? `耗时 ${formatDuration(turn.durationMs)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push("", `**${index + 1}. ${turn.status}**`);
    lines.push([`id \`${turn.turnId}\``, meta].filter(Boolean).join(" · "));
    if (turn.summary) {
      lines.push(truncateInline(turn.summary, 180));
    }
  });
  lines.push("", "发送 `/history <编号>` 查看某一轮详情。");
  return lines.join("\n");
}

function formatTurnDetail(threadId: string, turnId: string, items: CodexThreadItem[]): string {
  if (!items.length) {
    return ["**历史轮次详情**", `thread：\`${threadId}\``, `turn：\`${turnId}\``, "", "这一轮没有可展示的 item。"].join("\n");
  }

  return [
    "**历史轮次详情**",
    `thread：\`${threadId}\``,
    `turn：\`${turnId}\``,
    "",
    ...items.map(formatThreadItemDetail),
  ].join("\n\n");
}

function summarizeTurnItems(items: CodexThreadItem[]): string | undefined {
  const user = items.find((item) => item.type === "userMessage" && item.text)?.text;
  const agent = items.find((item) => item.type === "agentMessage" && item.text)?.text;
  const commandCount = items.filter((item) => item.type === "commandExecution").length;
  const changedFiles = items.flatMap((item) => item.files ?? []);
  const parts = [
    user ? `user: ${truncateInline(user, 80)}` : null,
    agent ? `agent: ${truncateInline(agent, 80)}` : null,
    commandCount ? `commands: ${commandCount}` : null,
    changedFiles.length ? `files: ${[...new Set(changedFiles)].slice(0, 3).join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function formatThreadItemDetail(item: CodexThreadItem, index: number): string {
  const label = threadItemLabel(item);
  const meta = [
    item.status ? `status=${item.status}` : null,
    item.exitCode !== undefined ? `exit=${item.exitCode ?? "null"}` : null,
    item.durationMs !== undefined && item.durationMs !== null ? `duration=${formatDuration(item.durationMs)}` : null,
    item.cwd ? `cwd=${item.cwd}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const body = threadItemBody(item);
  return [
    `**${index + 1}. ${label}**`,
    meta || null,
    body,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function threadItemLabel(item: CodexThreadItem): string {
  if (item.type === "userMessage") {
    return "用户消息";
  }
  if (item.type === "agentMessage") {
    return "Codex 回复";
  }
  if (item.type === "commandExecution") {
    return "命令";
  }
  if (item.type === "fileChange") {
    return "文件变更";
  }
  if (item.type === "reasoning") {
    return "思考";
  }
  if (item.type === "plan") {
    return "计划";
  }
  return item.type;
}

function threadItemBody(item: CodexThreadItem): string | null {
  if (item.type === "commandExecution" && item.command) {
    return ["```text", item.command, "```"].join("\n");
  }
  if (item.type === "fileChange" && item.files?.length) {
    return item.files.map((file) => `- \`${file}\``).join("\n");
  }
  if (item.text) {
    return truncateDetail(item.text, 2_000);
  }
  return null;
}

function threadTitle(thread: CodexThread): string {
  return cleanText(thread.name) ?? cleanText(thread.preview) ?? thread.id;
}

function parseSelectionIndex(value: string): number | null {
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

function pageForIndex(index: number, pageSize = 5): number {
  return Math.max(1, Math.ceil(index / pageSize));
}

function formatCodexTimestamp(value: number): string {
  return formatLocalMinute(new Date(codexTimestampMs(value)));
}

function codexTimestampMs(value: number | undefined): number {
  if (!value || value < 0) {
    return 0;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function cleanText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function formatLocalMinute(date: Date): string {
  const parts = [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
  ];
  return `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function approvalStatusDetail(request: CodexApprovalRequest): string {
  if (request.kind === "command") {
    const command = request.command ? `：${truncateForStatus(request.command, 80)}` : "";
    return `Codex 正在等待命令审批${command}`;
  }
  return "Codex 正在等待文件变更审批。";
}

function approvalDecisionLabel(decision: CodexApprovalDecision): string {
  if (decision === "accept") {
    return "Approve";
  }
  if (decision === "acceptForSession") {
    return "Approve session";
  }
  if (decision === "decline") {
    return "Deny";
  }
  if (decision === "cancel") {
    return "Cancel turn";
  }
  if ("acceptWithExecpolicyAmendment" in decision) {
    return "Approve rule";
  }
  return "Apply network policy";
}

function truncateForStatus(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

export function formatCodexFailure(result: CodexRunResult, cwd: string): string {
  const output = summarizeFailureOutput(result.finalText || result.stderr);
  const hint = inferCodexFailureHint(result.finalText, result.stderr);
  const lines = [
    "Codex 运行失败。",
    `exit: ${formatExit(result)}`,
    `cwd: ${cwd}`,
    "",
    "错误摘要：",
    output,
  ];
  if (hint) {
    lines.push("", `提示：${hint}`);
  }
  return lines.join("\n");
}

export function formatCodexStartupFailure(
  error: unknown,
  codexBin: string,
  cwd: string,
  cwdExists = true,
): string {
  const code = getErrorCode(error);
  const hint = inferStartupFailureHint(code, codexBin, cwd, cwdExists);
  const lines = [
    "Codex 启动失败。",
    `command: ${codexBin}`,
    `cwd: ${cwd}`,
    `error: ${formatError(error)}`,
  ];
  if (hint) {
    lines.push(`提示：${hint}`);
  }
  return lines.join("\n");
}

function formatRunTimeoutFailure(timeoutMs: number, cwd: string): string {
  return [
    "Codex 运行超时，已停止当前任务。",
    `timeout: CODEX_RUN_TIMEOUT_MS=${timeoutMs}`,
    `cwd: ${cwd}`,
    "",
    `提示：${runTimeoutHint(timeoutMs)}`,
  ].join("\n");
}

function formatExit(result: CodexRunResult): string {
  const parts = [`code=${result.exitCode ?? "null"}`];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  }
  return parts.join(" ");
}

function summarizeFailureOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "(Codex 没有返回错误输出，请查看服务日志。)";
  }

  const normalized = trimmed.replace(/\n{3,}/gu, "\n\n");
  const maxLength = 1800;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trimEnd()}\n...（已截断，完整输出请查看服务日志）`;
}

function truncateChatOutput(value: string, maxChars: number): string {
  let prefix = "";
  let count = 0;
  let truncated = false;
  for (const character of value) {
    if (count >= maxChars) {
      truncated = true;
      break;
    }
    prefix += character;
    count += 1;
  }
  if (!truncated) {
    return value;
  }

  const marker = "\n\n…（输出已截断）";
  const markerChars = [...marker];
  if (maxChars <= markerChars.length) {
    return markerChars.slice(0, maxChars).join("");
  }
  const contentChars = [...prefix];
  return `${contentChars.slice(0, maxChars - markerChars.length).join("").trimEnd()}${marker}`;
}

function inferCodexFailureHint(finalText: string, stderr: string): string | null {
  const combined = `${finalText}\n${stderr}`.toLowerCase();
  if (combined.includes("not a git repository")) {
    return "当前 cwd 可能不是 Git 仓库；可以用 /cd 切到目标仓库，或设置 CODEX_SKIP_GIT_REPO_CHECK=true。";
  }
  if (combined.includes("permission denied") || combined.includes("eacces")) {
    return "检查 CODEX_WORKDIR、仓库文件权限，以及 CODEX_SANDBOX 是否允许这次操作。";
  }
  if (combined.includes("not logged in") || combined.includes("authentication")) {
    return "运行服务的系统用户可能没有登录 Codex CLI；请用同一用户在终端完成 Codex 登录。";
  }
  if (combined.includes("sandbox")) {
    return "如果任务需要访问工作区外的路径，请调整 CODEX_WORKDIR 或 CODEX_SANDBOX。";
  }
  return null;
}

function inferCodexResultFailureCategory(result: CodexRunResult): FailureDiagnosticCategory {
  const combined = `${result.finalText}\n${result.stderr}`.toLowerCase();
  if (combined.includes("timed out") && combined.includes("app-server")) {
    return "app_server_timeout";
  }
  return "unknown";
}

function inferStartupFailureHint(
  code: string | null,
  codexBin: string,
  cwd?: string,
  cwdExists = true,
): string | null {
  if (code === "ENOENT") {
    if (!cwdExists && cwd) {
      return `当前 cwd 不存在：${cwd}；请发送 /cd <现有目录> 后重试。`;
    }
    return `找不到 Codex 命令 ${codexBin}；请设置 CODEX_BIN 为绝对路径，后台服务不会加载你的交互式 shell PATH。`;
  }
  if (code === "EACCES") {
    return `Codex 命令 ${codexBin} 不可执行；请检查文件权限或改用可执行文件的绝对路径。`;
  }
  return null;
}

function inferStartupFailureCategory(
  error: unknown,
  cwdExists = true,
): FailureDiagnosticCategory {
  if (getErrorCode(error) !== "ENOENT") {
    return "unknown";
  }
  return cwdExists ? "codex_missing" : "cwd_missing";
}

function runTimeoutHint(timeoutMs: number): string {
  return `任务超过 ${formatDuration(timeoutMs)}；可以调大 CODEX_RUN_TIMEOUT_MS、拆小任务，或稍后用 /status 查看队列后重试。`;
}

function approvalTimeoutHint(timeoutMs: number): string {
  return `审批等待超过 ${formatDuration(timeoutMs)}；可以调大 CODEX_APPROVAL_TIMEOUT_MS，或让授权用户更快处理审批卡片。`;
}

function isThreadResumeReadFailure(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("failed to read thread") ||
    message.includes("thread-store internal error") ||
    message.includes("does not start with session metadata")
  );
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function isDurableCodexCandidate(config: BridgeConfig, message: IncomingTextMessage): boolean {
  if (!decideAccess(config.access, toAccessContext(message)).allowed) {
    return false;
  }
  if (message.attachments?.length) {
    return true;
  }
  const text = routedText(message);
  return Boolean(text) && !isBuiltInRouterCommand(text);
}

function isBuiltInRouterCommand(text: string): boolean {
  return (
    text === "/whoami" ||
    text === "/status" ||
    text === "/host" ||
    text === "/health" ||
    text === "/diff" ||
    text === "/logs" ||
    text === "/files" ||
    text === "/summary" ||
    text === "/stop" ||
    text === "/projects" ||
    text === "/threads" ||
    text === "/sessions" ||
    text === "/compact" ||
    text === "/new" ||
    text === "/reset" ||
    text === "/steer" ||
    text.startsWith("/steer ") ||
    text === "/answer" ||
    text.startsWith("/answer ") ||
    text === "/project" ||
    text.startsWith("/project ") ||
    text === "/history" ||
    text.startsWith("/history ") ||
    text === "/search" ||
    text.startsWith("/search ") ||
    text === "/resume" ||
    text.startsWith("/resume ") ||
    text === "/fork" ||
    text.startsWith("/fork ") ||
    text.startsWith("/cd ")
  );
}

function isTerminalJobStatus(status: DurableCodexJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

function queueLimitReached(
  state: BridgeState,
  chatId: string,
  config: BridgeConfig,
): boolean {
  let total = 0;
  let forChat = 0;
  for (const job of Object.values(state.jobs)) {
    if (isTerminalJobStatus(job.status)) {
      continue;
    }
    total += 1;
    if (job.chatId === chatId) {
      forChat += 1;
    }
  }
  return (
    total >= config.bridgeMaxPendingMessages ||
    forChat >= config.bridgeMaxPendingMessagesPerChat
  );
}

function queueCapacityMessage(config: BridgeConfig): string {
  return [
    "Chat2Codex 当前任务队列已满，这条任务没有执行。",
    `全局最多保留 ${config.bridgeMaxPendingMessages} 条排队或运行任务；每个 chat 最多 ${config.bridgeMaxPendingMessagesPerChat} 条。`,
    "请等待已有任务结束后重新发送。控制命令和交互回复不受该上限影响。",
  ].join("\n");
}

function appendOutboxDeliveries(
  state: BridgeState,
  job: DurableCodexJob,
  deliveries: Array<{ kind: DurableOutboxMessage["kind"]; text: string }>,
  createdAt: string,
): void {
  for (const delivery of deliveries) {
    const id = randomUUID();
    const outbox: DurableOutboxMessage = {
      id,
      jobId: job.id,
      chatId: job.chatId,
      kind: delivery.kind,
      text: delivery.text,
      sequence: job.deliveryIds.length,
      status: "pending",
      idempotencyKey: id,
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
    state.outbox[id] = outbox;
    job.deliveryIds.push(id);
  }
}

function interruptDurableJob(
  state: BridgeState,
  job: DurableCodexJob,
  at: string,
  reason = "bridge_restarted_during_run",
): void {
  if (isTerminalJobStatus(job.status)) {
    return;
  }
  job.status = "interrupted";
  job.prompt = truncateInline(job.prompt, 180);
  job.updatedAt = at;
  job.completedAt = at;
  job.interruptionReason = reason;
  appendOutboxDeliveries(
    state,
    job,
    [{ kind: "text", text: interruptedJobMessage(job) }],
    at,
  );
}

function interruptedJobMessage(job: DurableCodexJob): string {
  return [
    "Chat2Codex 在任务执行期间重启，无法确认此前的 Codex 进程是否已经产生副作用。",
    "为避免重复修改，系统不会自动重新执行这条任务。",
    `cwd: ${job.cwd}`,
    job.threadId ? `thread: ${job.threadId}` : null,
    "请先检查当前 thread、Git 工作区和相关外部状态，再决定是否重新发送任务。",
  ]
    .filter(Boolean)
    .join("\n");
}

function markMessageProcessed(state: BridgeState, messageId: string): void {
  if (!state.processedMessageIds.includes(messageId)) {
    state.processedMessageIds.push(messageId);
  }
  delete state.pendingMessages[messageId];
}

function toPendingMessage(message: IncomingTextMessage): PendingMessageDelivery {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    sender: { ...message.sender },
    text: message.text,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    acceptedAt: new Date().toISOString(),
    attempts: 0,
  };
}

function fromPendingMessage(message: PendingMessageDelivery): IncomingTextMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    sender: { ...message.sender },
    text: message.text,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
  };
}

function toAccessContext(message: IncomingTextMessage): AccessContext {
  return {
    chatId: message.chatId,
    chatType: message.chatType,
    sender: message.sender,
  };
}

function routedText(message: IncomingTextMessage): string {
  if (message.chatType === "group") {
    return normalizeRoutedText(message.text);
  }
  return message.text.trim();
}

function isStopCommand(message: IncomingTextMessage): boolean {
  return routedText(message) === "/stop";
}

function isStatusCommand(message: IncomingTextMessage): boolean {
  return routedText(message) === "/status";
}

function isHostCommand(message: IncomingTextMessage): boolean {
  return routedText(message) === "/host" || routedText(message) === "/health";
}

function isSteerCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/steer" || text.startsWith("/steer ");
}

function isUserInputAnswerCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/answer" || text.startsWith("/answer ");
}

function parseUserInputAnswerCommand(
  text: string,
): { replyCode: string; answer: string } | null {
  if (!text.startsWith("/answer ")) {
    return null;
  }
  const rest = text.slice("/answer".length).trim();
  const separator = rest.search(/\s/);
  if (separator <= 0) {
    return null;
  }
  const replyCode = rest.slice(0, separator).trim();
  const answer = rest.slice(separator).trim();
  return replyCode && answer ? { replyCode, answer } : null;
}

function userInputKey(chatId: string, requestId: string): string {
  return `${chatId}\u0000${requestId}`;
}

function hasStableSenderIdentity(sender: SenderIdentity): boolean {
  return Boolean(sender.openId || sender.userId || sender.unionId);
}

function sameStableSenderIdentity(left: SenderIdentity, right: SenderIdentity): boolean {
  return Boolean(
    (left.openId && right.openId && left.openId === right.openId) ||
    (left.userId && right.userId && left.userId === right.userId) ||
    (left.unionId && right.unionId && left.unionId === right.unionId),
  );
}

function nextUserInputQuestion(
  pending: PendingUserInput,
): CodexUserInputRequest["questions"][number] | undefined {
  return pending.request.questions.find((question) => !pending.answers.has(question.id));
}

function pendingUserInputResponse(pending: PendingUserInput): CodexUserInputResponse {
  return {
    answers: Object.fromEntries(
      [...pending.answers].map(([questionId, answer]) => [
        questionId,
        { answers: [...answer.answers] },
      ]),
    ),
  };
}

function redactedUserInputAnswers(
  pending: PendingUserInput,
): CodexUserInputResponse["answers"] {
  return Object.fromEntries(
    [...pending.answers.keys()].map((questionId) => [questionId, { answers: [] }]),
  );
}

function formatUserInputTextPrompt(pending: PendingUserInput): string {
  const question = nextUserInputQuestion(pending);
  if (!question) {
    return "这条 Codex 用户输入请求已经结束。";
  }
  const options = (question.options ?? []).slice(0, 10);
  return [
    "Codex 正在等待你的补充输入。",
    `${truncateInline(question.header, 80)}：${truncateInline(question.question, 500)}`,
    ...options.map((option) => `- ${truncateInline(option.label, 80)}`),
    `发送 /answer ${pending.replyCode} <内容> 回答当前问题。`,
    options.length > 0 && !question.isOther
      ? "当前问题只接受上面的可选项名称（需完全一致）。"
      : null,
    "回答内容不会在聊天中回显，也不会写入 Chat2Codex 持久化状态。",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function detailCommandKind(message: IncomingTextMessage): RunDetailKind | null {
  return parseDetailCommandKind(routedText(message));
}

function commandDetailKind(text: string): RunDetailKind {
  return parseDetailCommandKind(text) ?? "summary";
}

function parseDetailCommandKind(text: string): RunDetailKind | null {
  if (text === "/summary") {
    return "summary";
  }
  if (text === "/files") {
    return "files";
  }
  if (text === "/diff") {
    return "diff";
  }
  if (text === "/logs") {
    return "logs";
  }
  return null;
}

function defaultAttachmentPrompt(attachments: DownloadedAttachment[]): string {
  const hasImage = attachments.some((attachment) => attachment.kind === "image");
  const hasFile = attachments.some((attachment) => attachment.kind === "file");
  if (hasImage && hasFile) {
    return "请查看并处理下面的图片和文件。";
  }
  if (hasImage) {
    return "请查看并处理下面的图片。";
  }
  return "请查看并处理下面的文件。";
}

function formatAttachmentLine(attachment: DownloadedAttachment): string {
  const label = attachment.kind === "image" ? "图片" : "文件";
  const name = attachment.name ? ` ${attachment.name}` : "";
  return `- ${label}${name}: ${attachment.path}`;
}

function ensureChatDiagnostics(state: BridgeState, chatId: string): ChatDiagnostics {
  state.diagnostics.byChat ??= {};
  state.diagnostics.byChat[chatId] ??= {};
  return state.diagnostics.byChat[chatId]!;
}

function diagnosticsForChat(state: BridgeState, chatId: string): ChatDiagnostics {
  const legacyLastEvent =
    state.diagnostics.lastEvent?.chatId === chatId ? state.diagnostics.lastEvent : undefined;
  const legacyLastDroppedEvent =
    state.diagnostics.lastDroppedEvent?.chatId === chatId
      ? state.diagnostics.lastDroppedEvent
      : undefined;
  return {
    lastEvent: legacyLastEvent,
    lastDroppedEvent: legacyLastDroppedEvent,
    ...state.diagnostics.byChat?.[chatId],
  };
}

function formatEventDiagnostic(diagnostic: EventDiagnosticSnapshot | undefined): string {
  if (!diagnostic) {
    return "(none)";
  }

  const parts = [
    diagnostic.at,
    diagnostic.outcome,
    `type=${diagnostic.messageType ?? "unknown"}`,
    `chat=${diagnostic.chatType ?? "unknown"}`,
    `chat_id=${diagnostic.chatId ?? "unknown"}`,
    `attachments=${diagnostic.attachmentCount}`,
    `text=${diagnostic.textLength}`,
    `mentions=${diagnostic.mentionCount}`,
  ];
  if (diagnostic.reason) {
    parts.push(`reason=${diagnostic.reason}`);
  }
  if (diagnostic.messageId) {
    parts.push(`message=${diagnostic.messageId}`);
  }
  return parts.join(" ");
}

function formatActiveRun(run: ActiveRunState | undefined): string {
  if (!run) {
    return "(none)";
  }
  const parts = [
    `age=${formatDuration(Date.now() - run.startedAtMs)}`,
    `cwd=${run.cwd}`,
    `thread=${run.threadId ?? "(new)"}`,
    `prompt="${truncateInline(run.prompt, 90)}"`,
  ];
  if (run.lastProgressAtMs && run.lastProgressText) {
    parts.push(
      `last_progress=${formatDuration(Date.now() - run.lastProgressAtMs)} ago "${truncateInline(
        run.lastProgressText,
        80,
      )}"`,
    );
  }
  return parts.join(" ");
}

function formatQueuedRun(run: QueuedRunState | undefined): string {
  if (!run) {
    return "(none)";
  }
  return [
    `state=${run.waitingFor === "global_capacity" ? "waiting_for_global_capacity" : "waiting_for_workspace"}`,
    `age=${formatDuration(Date.now() - run.queuedAtMs)}`,
    `cwd=${run.cwd}`,
    `thread=${run.threadId ?? "(new)"}`,
    `prompt="${truncateInline(run.prompt, 90)}"`,
  ].join(" ");
}

function waitForTaskOrQueuedAbort(
  task: Promise<void>,
  signal: AbortSignal,
  taskStarted: () => boolean,
): Promise<void> {
  if (signal.aborted) {
    return taskStarted() ? task : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (taskStarted()) {
        return;
      }
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function formatApprovalWait(approvals: PendingApproval[]): string {
  if (approvals.length === 0) {
    return "(none)";
  }
  const [approval] = approvals;
  if (!approval) {
    return "(none)";
  }
  const parts = [
    `count=${approvals.length}`,
    `age=${formatDuration(Date.now() - approval.createdAtMs)}`,
    `type=${approval.request.kind === "command" ? "commandExecution" : "fileChange"}`,
    `decisions=${approval.request.decisions.length}`,
  ];
  if (approval.request.command) {
    parts.push(`command="${truncateInline(approval.request.command, 90)}"`);
  }
  if (approval.request.cwd) {
    parts.push(`cwd=${approval.request.cwd}`);
  }
  return parts.join(" ");
}

function formatRecentFailureStatusLines(
  recentFailures: RecentFailureDiagnostic[] | undefined,
): string[] {
  if (!recentFailures?.length) {
    return ["recent_failures: (none)"];
  }
  return [
    "recent_failures:",
    ...recentFailures.slice(-5).map((failure, index) => {
      const parts = [
        `${index + 1}.`,
        failure.at,
        failure.category,
        failure.cwd ? `cwd=${failure.cwd}` : null,
        failure.threadId ? `thread=${failure.threadId}` : null,
        failure.promptPreview ? `prompt="${failure.promptPreview}"` : null,
        `detail="${failure.detail}"`,
        failure.hint ? `hint="${failure.hint}"` : null,
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    }),
  ];
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h${minuteRemainder}m`;
}

function approvalActionSenderAllowed(
  allowedUserIds: string[],
  sender: SenderIdentity,
  chatType: ChatType,
): boolean {
  if (allowedUserIds.length > 0) {
    return senderMatchesAllowedUser(sender, allowedUserIds);
  }
  return chatType !== "group";
}

function isPathWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalExistingPath(root);
  const canonicalCandidate = canonicalExistingPath(candidate);
  if (!canonicalRoot || !canonicalCandidate) {
    return false;
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingPath(value: string): string | null {
  try {
    return realpathSync.native(path.resolve(value));
  } catch {
    return null;
  }
}
