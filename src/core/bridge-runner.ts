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
  type CodexCollaborationMode,
  type CodexForkThreadInput,
  type CodexMcpElicitationField,
  type CodexMcpElicitationRequest,
  type CodexMcpElicitationResponse,
  type CodexMcpElicitationValue,
  type CodexPermissionApprovalDecision,
  type CodexPermissionApprovalRequest,
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
import {
  actionView,
  answerUserInputCardAction,
  answerMcpElicitationCardAction,
  cancelUserInputCardAction,
  cardActionToast,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardAction,
  resumeThreadCardAction,
  resolveApprovalCardAction,
  resolveMcpElicitationCardAction,
  resolvePermissionApprovalCardAction,
  selectProjectCardAction,
  showRunDetailCardAction,
  stopRunCardAction,
  type CardActionResponse,
  type IncomingCardAction,
  type RunDetailKind,
} from "./actions.js";
import type { ChatView } from "./view-models.js";
import { hasStableIdentity, identitiesIntersect } from "./identity.js";
import type {
  ApprovalCardInput,
  HostHealthCardInput,
  McpElicitationCardInput,
  PermissionApprovalCardInput,
  RunResultCardInput,
  RunStatusCardInput,
  UserInputCardInput,
} from "./view-models.js";
import type { InteractionPolicy } from "./interaction-policy.js";
import { JsonStateStore } from "../state/store.js";
import {
  BridgeState,
  createSessionEpoch,
  type ChatSession,
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
  type PendingMessageRoute,
  type PendingForkAttempt,
  type PendingThreadArchiveAttempt,
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
import type {
  MessageReaction,
  MessageReactionHandle,
} from "./contracts.js";

const minProgressIntervalMs = 30_000;
const maxRememberedStatusCards = 100;
const pendingRunSteerTtlMs = 30_000;
const maxPendingSteers = 5;
const maxUserInputAnswerLength = 4_000;
const maxMcpTextAnswerLength = 16_384;
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
  sendView?(chatId: string, view: ChatView): Promise<void>;
  addReaction?(
    chatId: string,
    messageId: string,
    reaction: MessageReaction,
  ): Promise<MessageReactionHandle | null>;
  removeReaction?(handle: MessageReactionHandle): Promise<void>;
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
  createPermissionApprovalCard?(
    chatId: string,
    input: PermissionApprovalCardInput,
  ): Promise<StatusCardHandle>;
  updatePermissionApprovalCard?(
    handle: StatusCardHandle,
    input: PermissionApprovalCardInput,
  ): Promise<void>;
  createMcpElicitationCard?(
    chatId: string,
    input: McpElicitationCardInput,
  ): Promise<StatusCardHandle>;
  updateMcpElicitationCard?(
    handle: StatusCardHandle,
    input: McpElicitationCardInput,
  ): Promise<void>;
}

export interface ChatDeliveryOptions {
  idempotencyKey?: string;
}

export interface StatusCardHandle {
  messageId: string;
  adapterId?: string;
  conversationId?: string;
}

export interface CodexClient {
  run(input: CodexRunInput): Promise<CodexRunResult>;
  invalidateChatSession?(chatId: string, reason?: string): Promise<void>;
  dispose?(): Promise<void>;
  listThreads?(input?: CodexThreadListInput): Promise<CodexThreadListResult>;
  readThread?(threadId: string): Promise<CodexThread | null>;
  searchThreads?(input: CodexThreadSearchInput): Promise<CodexThreadSearchResult>;
  listThreadTurns?(input: CodexThreadTurnListInput): Promise<CodexThreadTurnListResult>;
  listTurnItems?(input: CodexThreadTurnItemListInput): Promise<CodexThreadTurnItemListResult>;
  forkThread?(input: CodexForkThreadInput): Promise<CodexThread>;
  compactThread?(threadId: string): Promise<void>;
  archiveThread?(threadId: string): Promise<void>;
  unarchiveThread?(threadId: string): Promise<CodexThread>;
}

export interface MessageRouterRuntimeControl {
  requestRestart?: () => void;
}

interface PendingApproval {
  key: string;
  chatId: string;
  originSender: SenderIdentity;
  request: CodexApprovalRequest;
  replyCode: string;
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
  terminal: boolean;
  progressDeliveryTail: Promise<void>;
}

interface QueuedRunState {
  controller: AbortController;
  cwd: string;
  prompt: string;
  collaborationMode: CodexCollaborationMode;
  sessionEpoch: string;
  messageId?: string;
  threadId?: string;
  chatType?: ChatType;
  originSender?: SenderIdentity;
  queuedAtMs: number;
  waitingFor: "workspace" | "global_capacity";
  processingReaction?: MessageReactionHandle | null;
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

interface PendingPermissionApproval {
  key: string;
  chatId: string;
  originSender: SenderIdentity;
  request: CodexPermissionApprovalRequest;
  replyCode: string;
  resolve: (decision: CodexPermissionApprovalDecision) => void;
  signal: AbortSignal;
  abortListener: () => void;
  handle: StatusCardHandle | null;
  timeoutTimer?: NodeJS.Timeout;
  terminalCard?: PermissionApprovalCardInput;
}

interface PendingMcpElicitation {
  key: string;
  chatId: string;
  originSender: SenderIdentity;
  request: CodexMcpElicitationRequest;
  replyCode: string;
  answers: Map<string, CodexMcpElicitationValue>;
  completedFieldIds: Set<string>;
  resolve: (response: CodexMcpElicitationResponse) => void;
  signal: AbortSignal;
  abortListener: () => void;
  handle: StatusCardHandle | null;
  timeoutTimer?: NodeJS.Timeout;
  terminalCard?: McpElicitationCardInput;
}

interface PendingSteer {
  text: string;
}

interface PendingRunSteers {
  items: PendingSteer[];
  timeoutTimer: NodeJS.Timeout;
}

export class BridgeRunner {
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
  private readonly activePermissionApprovals = new Map<string, PendingPermissionApproval>();
  private readonly activeMcpElicitations = new Map<string, PendingMcpElicitation>();
  private readonly statusCardRuns = new Map<
    string,
    {
      chatId: string;
      prompt: string;
      collaborationMode: CodexCollaborationMode;
      originSender?: SenderIdentity;
    }
  >();
  private readonly retryableRunsByChat = new Map<
    string,
    {
      prompt: string;
      collaborationMode: CodexCollaborationMode;
      originSender?: SenderIdentity;
    }
  >();
  private readonly forkRecoveries = new Map<string, PendingForkAttempt>();
  private readonly threadArchiveRecoveries = new Map<string, PendingThreadArchiveAttempt>();
  private readonly restartAfterMessageIds = new Set<string>();
  private readonly globalRunWaiters: GlobalRunWaiter[] = [];
  private readonly activeCodexRunTasks = new Set<Promise<CodexRunResult>>();
  private activeGlobalRuns = 0;
  private readonly codex: CodexClient;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JsonStateStore,
    private readonly sender: ChatSender,
    private readonly logger: Logger,
    codex: CodexClient,
    private readonly interactionPolicy: InteractionPolicy,
    private readonly runtimeControl: MessageRouterRuntimeControl = {},
  ) {
    this.codex = codex;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    for (const timer of this.outboxRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.outboxRetryTimers.clear();
    for (const pending of this.pendingRunSteers.values()) {
      clearTimeout(pending.timeoutTimer);
    }
    this.pendingRunSteers.clear();
    for (const queuedRun of this.queuedRuns.values()) {
      queuedRun.controller.abort();
    }
    this.queuedRuns.clear();
    for (const run of this.activeRuns.values()) {
      if (run.timeoutTimer) {
        clearTimeout(run.timeoutTimer);
      }
      run.controller.abort();
    }
    for (const waiter of this.globalRunWaiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.resolve(null);
    }
    this.disposePromise = (async () => {
      const errors: unknown[] = [];
      if (this.state) {
        const now = new Date().toISOString();
        try {
          await this.mutateState((state) => {
            for (const job of Object.values(state.jobs)) {
              if (job.status !== "running") {
                continue;
              }
              interruptDurableJob(state, job, now, "bridge_shutdown");
              markMessageProcessed(state, job.messageId);
            }
          });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.codex.dispose?.();
      } catch (error) {
        errors.push(error);
      }
      const taskResults = await Promise.allSettled([
        ...this.activeCodexRunTasks,
        ...this.messageTasks.values(),
        ...this.queues.values(),
        ...this.outboxTasks.values(),
        this.attachmentTaskTail,
      ]);
      for (const result of taskResults) {
        if (result.status === "rejected") {
          this.logger.warn("Router task failed during bridge shutdown", result.reason);
        }
      }
      await this.stateMutationTail;
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to dispose Chat2Codex cleanly");
      }
    })();
    return this.disposePromise;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error("Cannot start a disposed MessageRouter.");
    }
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
      const job = this.state.jobs[pending.messageId];
      const route = pending.route ?? inferLegacyPendingRoute(this.config, pending, job);
      if (route === "control_replay_safe" || route === "message") {
        this.scheduleAcceptedMessage(fromPendingMessage(pending));
      } else if (route === "codex" && job?.status === "queued") {
        this.scheduleAcceptedMessage(fromPendingMessage(pending));
      }
    }
  }

  async accept(message: IncomingTextMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.requireState().processedMessageIds.includes(message.messageId)) {
      return;
    }
    if (
      !message.attachments?.length &&
      (
        isApprovalAnswerCommand(message) ||
        isPermissionAnswerCommand(message) ||
        isMcpDecisionCommand(message) ||
        isUserInputAnswerCommand(message) ||
        isMcpAnswerCommand(message)
      )
    ) {
      // Interactive answers can contain private values. Keep the
      // command in memory only; processMessage still persists its message id so
      // successful deliveries remain deduplicated without persisting the answer.
      this.scheduleAcceptedMessage(message);
      return;
    }
    let retryPending: IncomingTextMessage | undefined;
    const outcome = await this.mutateState((state) => {
      if (state.processedMessageIds.includes(message.messageId)) {
        return "duplicate" as const;
      }
      const existingPending = state.pendingMessages[message.messageId];
      if (existingPending) {
        const forkRecovery = this.forkRecoveries.get(message.messageId);
        if (forkRecovery) {
          existingPending.forkAttempt = structuredClone(forkRecovery);
        }
        const archiveRecovery = this.threadArchiveRecoveries.get(message.messageId);
        if (archiveRecovery) {
          existingPending.threadArchiveAttempt = structuredClone(archiveRecovery);
        }
        retryPending = fromPendingMessage(existingPending);
        return "retry_pending" as const;
      }
      const route = pendingMessageRoute(this.config, message);
      const durableCandidate = route === "codex";
      clearResolvedCapacityNotices(state, this.config);
      if (durableCandidate && !state.jobs[message.messageId]) {
        const session = this.ensureSession(message.chatId, state, message.chatType);
        const now = new Date().toISOString();
        const capacityScope = queueLimitScope(state, message.chatId, this.config);
        if (capacityScope) {
          const activeNotice = hasActiveCapacityNotice(
            state,
            "durable",
            capacityScope,
            message.chatId,
          );
          if (activeNotice) {
            markMessageProcessed(state, message.messageId);
            return "rejected_silently" as const;
          }
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
            capacityNoticeScope: capacityScope,
            capacityNoticeKind: "durable",
            capacityNoticeActive: true,
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
        const turn = parseCodexTurnRequest(routedText(message));
        state.jobs[message.messageId] = {
          id: message.messageId,
          kind: "codex_run",
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          cwd: session.cwd,
          prompt: turn.prompt,
          collaborationMode: turn.collaborationMode,
          threadId: session.threadId,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          deliveryIds: [],
        };
      } else if (!durableCandidate) {
        const capacityScope = pendingInboxLimitScope(
          state,
          message.chatId,
          this.config,
        );
        if (capacityScope) {
          const activeNotice = hasActiveCapacityNotice(
            state,
            "inbox",
            capacityScope,
            message.chatId,
          );
          if (activeNotice) {
            markMessageProcessed(state, message.messageId);
            return "rejected_silently" as const;
          }
          const now = new Date().toISOString();
          const session = state.chats[message.chatId];
          const job: DurableCodexJob = {
            id: message.messageId,
            kind: "control_recovery",
            messageId: message.messageId,
            chatId: message.chatId,
            chatType: message.chatType,
            cwd: session?.cwd ?? this.config.codexWorkdir,
            prompt: "[rejected: inbox capacity reached]",
            threadId: session?.threadId,
            status: "cancelled",
            createdAt: now,
            updatedAt: now,
            completedAt: now,
            deliveryIds: [],
            interruptionReason: "inbox_capacity_reached",
            capacityNoticeScope: capacityScope,
            capacityNoticeKind: "inbox",
            capacityNoticeActive: true,
          };
          state.jobs[job.id] = job;
          appendOutboxDeliveries(
            state,
            job,
            [{ kind: "text", text: inboxCapacityMessage(this.config) }],
            now,
          );
          markMessageProcessed(state, message.messageId);
          return "rejected" as const;
        }
      }
      state.pendingMessages[message.messageId] ??= toPendingMessage(message, route);
      return "accepted" as const;
    });
    if (outcome === "duplicate") {
      return;
    }
    if (outcome === "retry_pending") {
      if (retryPending) {
        this.scheduleAcceptedMessage(retryPending);
      }
      return;
    }
    if (outcome === "rejected") {
      this.scheduleOutboxDrain(message.messageId);
      return;
    }
    if (outcome === "rejected_silently") {
      return;
    }
    this.scheduleAcceptedMessage(message);
  }

  async recordEventDiagnostic(
    outcome: EventDiagnosticOutcome,
    diagnostic: IncomingEventDiagnostic,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
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
    await this.mutateState((state) => {
      const diagnostics = diagnostic.chatId
        ? ensureChatDiagnostics(state, diagnostic.chatId)
        : state.diagnostics;
      diagnostics.lastEvent = snapshot;
      if (outcome === "dropped") {
        diagnostics.lastDroppedEvent = snapshot;
      }
    });
  }

  enqueue(message: IncomingTextMessage): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
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
    if (!message.attachments?.length && isMcpAnswerCommand(message)) {
      return this.handleImmediateMcpAnswer(message);
    }
    if (!message.attachments?.length && isApprovalAnswerCommand(message)) {
      return this.handleImmediateApprovalAnswer(message);
    }
    if (!message.attachments?.length && isPermissionAnswerCommand(message)) {
      return this.handleImmediatePermissionAnswer(message);
    }
    if (!message.attachments?.length && isMcpDecisionCommand(message)) {
      return this.handleImmediateMcpDecision(message);
    }

    return this.enqueueTask(message.chatId, () => this.handle(message));
  }

  private scheduleAcceptedMessage(message: IncomingTextMessage): void {
    void this.enqueue(message).catch(async (error: unknown) => {
      this.logger.error("Accepted chat message processing failed; leaving it pending", error);
      await this.mutateState((state) => {
        const pending = state.pendingMessages[message.messageId];
        if (!pending) {
          return;
        }
        const forkRecovery = this.forkRecoveries.get(message.messageId);
        if (forkRecovery) {
          pending.forkAttempt = structuredClone(forkRecovery);
        }
        const archiveRecovery = this.threadArchiveRecoveries.get(message.messageId);
        if (archiveRecovery) {
          pending.threadArchiveAttempt = structuredClone(archiveRecovery);
        }
        pending.attempts += 1;
        pending.lastError = truncateInline(formatError(error), 240);
      }).catch((saveError: unknown) => {
        this.logger.error("Failed to persist pending message failure", saveError);
      });
    });
  }

  async handleCardAction(action: IncomingCardAction): Promise<CardActionResponse | undefined> {
    if (this.disposed) {
      return cardActionToast("warning", "Chat2Codex 正在关闭，这个卡片操作已忽略。");
    }
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
    if (action.action === resolvePermissionApprovalCardAction) {
      return this.handlePermissionApprovalCardAction(action);
    }
    if (
      action.action === answerMcpElicitationCardAction ||
      action.action === resolveMcpElicitationCardAction
    ) {
      return this.handleMcpElicitationCardAction(action);
    }
    if (action.action === pageProjectsCardAction) {
      return this.handleProjectPageCardAction(action);
    }
    if (action.action === pageSessionsCardAction) {
      return this.handleSessionPageCardAction(action);
    }
    if (action.action === selectProjectCardAction) {
      return this.enqueueSessionCardAction(
        action.chatId,
        "当前 chat 有任务排队或运行中，完成或停止后再切换项目。",
        () => this.handleSelectProjectCardAction(action),
      );
    }
    if (action.action === resumeThreadCardAction) {
      return this.enqueueSessionCardAction(
        action.chatId,
        "当前 chat 有任务排队或运行中，完成或停止后再切换会话。",
        () => this.handleResumeThreadCardAction(action),
      );
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
        if (this.disposed) {
          return;
        }
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

  private async enqueueSessionCardAction<T>(
    chatId: string,
    busyMessage: string,
    task: () => Promise<T>,
  ): Promise<T | CardActionResponse> {
    if (
      this.queues.has(chatId) ||
      this.queuedRuns.has(chatId) ||
      this.activeRuns.has(chatId)
    ) {
      return cardActionToast("warning", busyMessage);
    }
    let result!: T;
    await this.enqueueTask(chatId, async () => {
      result = await task();
    });
    return result;
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
    if (this.disposed) {
      return;
    }
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
    this.forkRecoveries.delete(message.messageId);
    this.threadArchiveRecoveries.delete(message.messageId);
    if (this.restartAfterMessageIds.delete(message.messageId)) {
      this.runtimeControl.requestRestart?.();
    }
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

    if (!hasAttachments && text === "/help") {
      await this.sendHelp(message.chatId);
      return;
    }
    if (!hasAttachments && text === "/retry") {
      await this.retryLastRun(message);
      return;
    }
    if (!hasAttachments && text === "/usage") {
      await this.sendTokenUsage(message.chatId);
      return;
    }
    if (!hasAttachments && (text === "/service" || text.startsWith("/service "))) {
      await this.handleServiceCommand(message, text.slice("/service".length).trim());
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
    if (!hasAttachments && text === "/archived") {
      await this.sendArchivedThreads(message.chatId, message.chatType);
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
      await this.forkThread(
        message.chatId,
        message.chatType,
        text.slice("/fork".length).trim(),
        message.messageId,
      );
      return;
    }
    if (!hasAttachments && text === "/compact") {
      await this.compactThread(message.chatId, message.chatType);
      return;
    }
    if (!hasAttachments && text === "/archive") {
      await this.archiveCurrentThread(message.chatId, message.messageId);
      return;
    }
    if (!hasAttachments && (text === "/unarchive" || text.startsWith("/unarchive "))) {
      await this.unarchiveThread(
        message.chatId,
        message.chatType,
        text.slice("/unarchive".length).trim(),
        message.messageId,
      );
      return;
    }
    if (!hasAttachments && text === "/plan") {
      await this.sender.sendText(message.chatId, "用法：/plan <任务>（以 Plan 模式执行这一轮）");
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

    const turn = parseCodexTurnRequest(text);
    const prompt = await this.buildCodexPrompt(message, turn.prompt);
    if (!prompt) {
      return;
    }

    await this.runCodex(
      message.chatId,
      prompt,
      message.chatType,
      message.messageId,
      message.sender,
      turn.collaborationMode,
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
    collaborationMode: CodexCollaborationMode = "default",
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
        job.collaborationMode = collaborationMode;
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
      collaborationMode,
      sessionEpoch: session.sessionEpoch,
      messageId,
      threadId: session.threadId,
      chatType: session.chatType ?? chatType,
      originSender: originSender ? { ...originSender } : undefined,
      queuedAtMs: Date.now(),
      waitingFor: "workspace",
    };
    this.queuedRuns.set(chatId, queuedRun);
    try {
      if (messageId) {
        queuedRun.processingReaction = await this.addProcessingReaction(
          chatId,
          messageId,
        );
      }
      if (queuedRun.controller.signal.aborted) {
        return;
      }
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
      );
    } finally {
      await this.finishProcessingReaction(queuedRun);
      if (this.queuedRuns.get(chatId) === queuedRun) {
        this.queuedRuns.delete(chatId);
      }
    }
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
    if (
      session.cwd !== queuedRun.cwd ||
      session.threadId !== queuedRun.threadId ||
      session.sessionEpoch !== queuedRun.sessionEpoch
    ) {
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
    const statusCard: StatusCardHandle | null = null;
    this.rememberStatusCardRun(
      statusCard,
      chatId,
      prompt,
      queuedRun.collaborationMode,
      queuedRun.originSender,
    );

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
      terminal: false,
      progressDeliveryTail: Promise.resolve(),
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
    const reportProgress = this.createProgressReporter(chatId, controller.signal, runState);
    this.activeRuns.set(chatId, runState);
    try {
      const codexRunTask = this.codex.run({
        prompt,
        cwd: session.cwd,
        threadId: session.threadId,
        collaborationMode: queuedRun.collaborationMode,
        sessionScope:
          queuedRun.originSender && hasStableSenderIdentity(queuedRun.originSender)
            ? {
                adapterId: this.store.adapterId,
                chatId,
                sessionEpoch: queuedRun.sessionEpoch,
                principal: { ...queuedRun.originSender },
              }
            : undefined,
        onThreadBound: async (threadId) => {
          if (this.disposed) {
            throw new Error("Chat2Codex is shutting down; refusing to bind a Codex thread.");
          }
          await this.mutateState((currentState) => {
            const currentSession = this.ensureSession(chatId, currentState, queuedRun.chatType);
            if (
              currentSession.cwd !== queuedRun.cwd ||
              currentSession.threadId !== queuedRun.threadId ||
              currentSession.sessionEpoch !== queuedRun.sessionEpoch
            ) {
              throw new Error("The chat session changed before the Codex thread could be bound.");
            }
            const now = new Date().toISOString();
            currentSession.threadId = threadId;
            currentSession.updatedAt = now;
            if (queuedRun.messageId) {
              const job = currentState.jobs[queuedRun.messageId];
              if (!job || isTerminalJobStatus(job.status)) {
                throw new Error("The durable Codex job ended before its thread could be bound.");
              }
              job.threadId = threadId;
              job.updatedAt = now;
            }
          });
          queuedRun.threadId = threadId;
          runState.threadId = threadId;
        },
        signal: controller.signal,
        onProgress: reportProgress,
        onApprovalRequest: (request) =>
          this.requestApproval(
            chatId,
            queuedRun.originSender,
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
        onMcpElicitationRequest: (request, context) =>
          this.requestMcpElicitation(
            chatId,
            queuedRun.originSender,
            request,
            context.signal,
          ),
        onPermissionApprovalRequest: (request, context) =>
          this.requestPermissionApproval(
            chatId,
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
      this.activeCodexRunTasks.add(codexRunTask);
      let result: CodexRunResult;
      try {
        result = await codexRunTask;
      } finally {
        this.activeCodexRunTasks.delete(codexRunTask);
      }
      await this.closeProgressReporter(runState);

      if (result.cancelled || controller.signal.aborted) {
        if (this.disposed) {
          return;
        }
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
      await this.closeProgressReporter(runState);
      if (controller.signal.aborted) {
        if (this.disposed) {
          return;
        }
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
          await this.mutateState((currentState) => {
            const currentSession = this.ensureSession(chatId, currentState, queuedRun.chatType);
            currentSession.cwd = candidate;
            delete currentSession.threadId;
            currentSession.sessionEpoch = createSessionEpoch();
            currentSession.updatedAt = new Date().toISOString();
          });
          await this.invalidateCodexSession(chatId, "cwd_missing_fallback");
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
        await this.mutateState((currentState) => {
          const currentSession = this.ensureSession(chatId, currentState, queuedRun.chatType);
          delete currentSession.threadId;
          currentSession.sessionEpoch = createSessionEpoch();
          currentSession.updatedAt = new Date().toISOString();
        });
        await this.invalidateCodexSession(chatId, "thread_resume_failed");
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
      await this.cancelPermissionApprovalsForChat(chatId);
      await this.cancelMcpElicitationsForChat(chatId);
      if (this.activeRuns.get(chatId) === runState) {
        if (!this.disposed) {
          await this.reportUnsentPendingSteers(chatId, runState);
        }
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
        const route = pending.route ?? inferLegacyPendingRoute(this.config, pending, job);
        pending.route = route;

        if (route === "control_replay_safe") {
          continue;
        }
        if (route === "message") {
          // A non-command message can have this route because it was not
          // authorized when accepted. Never let a later configuration or
          // command-classification change promote it into a Codex/control
          // action during restart recovery.
          if (
            pendingMessageRoute(this.config, fromPendingMessage(pending)) ===
            "message"
          ) {
            continue;
          }
          markMessageProcessed(state, pending.messageId);
          continue;
        }
        if (route === "control_no_replay") {
          if (!job) {
            const session = state.chats[pending.chatId];
            job = {
              id: pending.messageId,
              kind: "control_recovery",
              messageId: pending.messageId,
              chatId: pending.chatId,
              chatType: pending.chatType,
              cwd: session?.cwd ?? this.config.codexWorkdir,
              prompt: controlCommandName(pending.text),
              threadId: session?.threadId,
              status: "interrupted",
              createdAt: pending.acceptedAt,
              updatedAt: now,
              completedAt: now,
              deliveryIds: [],
              interruptionReason: "control_command_not_replayed",
            };
            state.jobs[job.id] = job;
            const recoveryText = pending.forkAttempt
              ? this.recoveredForkMessage(state, pending, pending.forkAttempt)
              : pending.threadArchiveAttempt
                ? recoveredThreadArchiveMessage(state, pending, pending.threadArchiveAttempt)
              : interruptedControlMessage(job.prompt);
            appendOutboxDeliveries(
              state,
              job,
              [{
                kind: pending.forkAttempt || pending.threadArchiveAttempt ? "markdown" : "text",
                text: recoveryText,
              }],
              now,
            );
          }
          markMessageProcessed(state, pending.messageId);
          continue;
        }

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
    view: ChatView,
    fallbackMarkdown: string,
  ): Promise<void> {
    if (!this.sender.sendView) {
      await this.sendMarkdown(chatId, fallbackMarkdown);
      return;
    }

    try {
      await this.sender.sendView(chatId, view);
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
        hint: "请使用支持附件下载的平台适配器，或改为发送本机文件路径。",
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
        hint: "检查平台消息资源读取权限，或确认附件仍可由当前应用读取。",
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

  private async handleImmediateMcpAnswer(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.answerMcpElicitationFromText(message));
  }

  private async handleImmediateApprovalAnswer(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.answerApprovalFromText(message));
  }

  private async handleImmediatePermissionAnswer(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.answerPermissionFromText(message));
  }

  private async handleImmediateMcpDecision(message: IncomingTextMessage): Promise<void> {
    await this.handleImmediateCommand(message, () => this.decideMcpFromText(message));
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

  private async sendHelp(chatId: string): Promise<void> {
    await this.sendMarkdown(
      chatId,
      [
        "**Chat2Codex 常用命令**",
        "",
        "- `/status` / `/host`：查看当前 chat 与主机健康状态",
        "- `/projects` / `/threads` / `/history`：浏览项目、会话和历史 turn",
        "- `/archive` / `/archived` / `/unarchive <编号|thread_id>`：归档与恢复会话",
        "- `/resume <编号|thread_id>`：继续已有会话",
        "- `/fork [编号|thread_id]`：分叉整个会话",
        "- `/fork --turn <历史编号|turn_id>`：从历史 turn 非破坏性分叉",
        "- `/retry`：重试当前进程中这个 chat 最近一轮任务",
        "- `/usage`：查看最近一轮与当前 thread 的 token/context 用量",
        "- `/service status|logs|restart`：查看或管理 bridge 服务（logs/restart 仅限管理员私聊）",
        "- `/plan <任务>`：执行一次 Plan 模式任务",
        "- `/stop` / `/steer <补充指令>`：停止或补充当前任务",
        "- `/summary` / `/files` / `/diff` / `/logs`：查看最近运行结果",
        "- `/new` / `/cd <path>`：新建会话或切换工作目录",
        "- `/approve` / `/permit` / `/mcp-decide`：按待处理提示在纯文本平台完成安全审批",
        "",
        "历史 turn 分叉不会恢复或回滚本地文件。",
      ].join("\n"),
    );
  }

  private async retryLastRun(message: IncomingTextMessage): Promise<void> {
    const run = this.retryableRunsByChat.get(message.chatId);
    if (!run) {
      await this.sender.sendText(
        message.chatId,
        "当前服务没有这个 chat 可重试的任务上下文；服务重启后请重新发送原任务。",
      );
      return;
    }
    if (
      !run.originSender ||
      !hasStableSenderIdentity(run.originSender) ||
      !sameStableSenderIdentity(run.originSender, message.sender)
    ) {
      await this.sender.sendText(
        message.chatId,
        "只有发起最近一轮任务的用户可以重试；无法稳定识别发送者时不会执行重试。",
      );
      return;
    }
    if (this.activeRuns.has(message.chatId) || this.queuedRuns.has(message.chatId)) {
      await this.sender.sendText(message.chatId, "当前 chat 已有任务排队或运行中。");
      return;
    }

    await this.runCodex(
      message.chatId,
      run.prompt,
      message.chatType,
      undefined,
      message.sender,
      run.collaborationMode,
    );
  }

  private async sendTokenUsage(chatId: string): Promise<void> {
    const lastRun = this.requireState().chats[chatId]?.lastRun;
    if (!lastRun) {
      await this.sender.sendText(chatId, "当前 chat 还没有可查看的最近运行结果。");
      return;
    }
    if (!lastRun.tokenUsage) {
      await this.sender.sendText(
        chatId,
        "最近一轮没有收到 Codex 的 token usage 通知；这通常表示该 provider 或协议版本未提供用量。",
      );
      return;
    }
    await this.sendMarkdown(chatId, formatTokenUsage(lastRun));
  }

  private async handleServiceCommand(
    message: IncomingTextMessage,
    argument: string,
  ): Promise<void> {
    const command = argument.toLowerCase();
    if (!command) {
      await this.sender.sendText(message.chatId, "用法：/service <status|logs|restart>");
      return;
    }
    if (command === "status") {
      const state = this.requireState();
      await this.sendMarkdown(
        message.chatId,
        [
          "**Chat2Codex 服务状态**",
          `pid：${process.pid}`,
          `uptime：${formatDuration(Date.now() - this.bridgeStartedAtMs)}`,
          `restart：${this.config.serviceRestartEnabled ? "supervisor enabled" : "disabled"}`,
          `log：${this.config.logFilePath ? `\`${this.config.logFilePath}\`` : process.platform === "linux" ? "systemd journal" : "(foreground / unavailable)"}`,
          ...this.formatRuntimeStatusLines(message.chatId, state),
        ].join("\n"),
      );
      return;
    }
    if (!this.serviceAdminAllowed(message)) {
      await this.sender.sendText(
        message.chatId,
        "`/service logs` 和 `/service restart` 只允许在私聊中由 ALLOWED_USER_IDS 明确列出的用户执行。",
      );
      return;
    }
    if (command === "logs") {
      try {
        const logText = await readServiceLogTail(this.config.logFilePath);
        await this.sender.sendText(message.chatId, `Chat2Codex 最近服务日志：\n${logText}`);
      } catch (error) {
        await this.sender.sendText(message.chatId, `读取服务日志失败：${formatError(error)}`);
      }
      return;
    }
    if (command === "restart") {
      if (!this.config.serviceRestartEnabled || !this.runtimeControl.requestRestart) {
        await this.sender.sendText(
          message.chatId,
          "当前 bridge 不是由支持自动拉起的服务配置启动，已拒绝远程重启。",
        );
        return;
      }
      if (this.activeRuns.size > 0 || this.queuedRuns.size > 0) {
        await this.sender.sendText(
          message.chatId,
          "当前还有运行中或排队任务；请先完成或 `/stop`，再重启服务。",
        );
        return;
      }
      await this.sender.sendText(
        message.chatId,
        "已接受服务重启请求；bridge 将优雅退出并由 launchd/systemd 自动拉起。",
      );
      this.restartAfterMessageIds.add(message.messageId);
      return;
    }
    await this.sender.sendText(message.chatId, "用法：/service <status|logs|restart>");
  }

  private serviceAdminAllowed(message: IncomingTextMessage): boolean {
    return (
      message.chatType === "direct" &&
      this.config.access.allowedUserIds.length > 0 &&
      senderMatchesAllowedUser(message.sender, this.config.access.allowedUserIds)
    );
  }

  private async sendHostHealth(chatId: string): Promise<void> {
    const state = this.requireState();
    const input = this.buildHostHealthInput(chatId, state);
    const fallback = formatHostHealth(input);
    if (this.sender.sendView) {
      try {
        await this.sender.sendView(chatId, { kind: "host_health", input });
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
      approvalWait: this.formatInteractionWait(),
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
      `interaction_wait: ${this.formatInteractionWait(chatId)}`,
      ...formatRecentFailureStatusLines(diagnostics.recentFailures),
    ];
  }

  private formatInteractionWait(chatId?: string): string {
    const inChat = <T extends { chatId: string }>(values: Iterable<T>): number =>
      [...values].filter((value) => chatId === undefined || value.chatId === chatId).length;
    return [
      `approval=${inChat(this.activeApprovals.values())}`,
      `user_input=${inChat(this.activeUserInputs.values())}`,
      `permission=${inChat(this.activePermissionApprovals.values())}`,
      `mcp=${inChat(this.activeMcpElicitations.values())}`,
    ].join(" ");
  }

  private interactionLimitReached(chatId: string): boolean {
    const collections: Array<Iterable<{ chatId: string }>> = [
      this.activeApprovals.values(),
      this.activeUserInputs.values(),
      this.activePermissionApprovals.values(),
      this.activeMcpElicitations.values(),
    ];
    let total = 0;
    let forChat = 0;
    for (const collection of collections) {
      for (const pending of collection) {
        total += 1;
        if (pending.chatId === chatId) {
          forChat += 1;
        }
      }
    }
    return (
      total >= this.config.bridgeMaxPendingMessages ||
      forChat >= this.config.bridgeMaxPendingMessagesPerChat
    );
  }

  private warnInteractionLimit(chatId: string, kind: string): void {
    this.logger.warn("Rejected interactive request at the pending interaction limit", {
      chatId,
      kind,
      maxPending: this.config.bridgeMaxPendingMessages,
      maxPendingPerChat: this.config.bridgeMaxPendingMessagesPerChat,
    });
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
    await this.mutateState((currentState) => {
      const currentSession = this.ensureSession(chatId, currentState, chatType);
      currentSession.updatedAt = new Date().toISOString();
    });

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
      {
        kind: "project_list",
        input: {
          currentCwd: session.cwd,
          projects,
        },
      },
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

    await this.applyProjectSelection(chatId, cwd);
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
    await this.mutateState((currentState) => {
      const currentSession = this.ensureSession(chatId, currentState, chatType);
      currentSession.updatedAt = new Date().toISOString();
    });

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
      {
        kind: "session_list",
        input: {
          cwd: session.cwd,
          currentThreadId: session.threadId,
          sessions: session.lastThreads,
        },
      },
      lines.join("\n"),
    );
  }

  private async sendArchivedThreads(chatId: string, chatType: ChatType): Promise<void> {
    if (!this.codex.listThreads) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持读取已归档会话。");
      return;
    }
    const session = this.ensureSession(chatId, this.requireState(), chatType);
    if (!this.directoryAllowedForChat(session.cwd, chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }
    let result: CodexThreadListResult;
    try {
      result = await this.codex.listThreads({
        cwd: session.cwd,
        archived: true,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
    } catch (error) {
      await this.sender.sendText(chatId, `读取已归档会话失败：${formatError(error)}`);
      return;
    }
    const archived = result.threads
      .filter((thread) => thread.cwd === session.cwd)
      .map((thread) => toThreadSelection(thread));
    await this.mutateState((state) => {
      const current = this.ensureSession(chatId, state, chatType);
      current.lastArchivedThreads = archived;
      current.updatedAt = new Date().toISOString();
    });
    if (!archived.length) {
      await this.sender.sendText(chatId, "当前项目没有已归档的 Codex 会话。");
      return;
    }
    await this.sendMarkdown(
      chatId,
      [
        "**已归档会话**",
        `项目：\`${session.cwd}\``,
        "",
        ...archived.flatMap((thread, index) => [
          `**${index + 1}. ${truncateInline(thread.title ?? thread.preview ?? thread.threadId, 90)}**`,
          `id \`${thread.threadId}\`${thread.updatedAt ? ` · 最近 ${thread.updatedAt}` : ""}`,
          "",
        ]),
        "发送 `/unarchive <编号>` 或 `/unarchive <thread_id>` 恢复；恢复后可用 `/resume` 继续。",
      ].join("\n"),
    );
  }

  private async archiveCurrentThread(chatId: string, messageId: string): Promise<void> {
    if (!this.codex.archiveThread) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持归档会话。");
      return;
    }
    const pending = this.requireState().pendingMessages[messageId];
    const recovered = this.threadArchiveRecoveries.get(messageId) ?? pending?.threadArchiveAttempt;
    if (recovered) {
      await this.finishRecoveredThreadArchive(chatId, recovered);
      return;
    }
    const session = this.ensureSession(chatId);
    if (!session.threadId) {
      await this.sender.sendText(chatId, "当前 chat 还没有已选择的 Codex 会话。");
      return;
    }
    const attempt: PendingThreadArchiveAttempt = {
      action: "archive",
      threadId: session.threadId,
      startedAt: new Date().toISOString(),
    };
    if (pending) {
      await this.persistThreadArchiveAttempt(messageId, attempt);
    }
    await this.invalidateCodexSession(chatId, "thread_archived");
    try {
      await this.codex.archiveThread(attempt.threadId);
    } catch (error) {
      await this.sender.sendText(chatId, `归档会话失败：${formatError(error)}`);
      return;
    }
    attempt.completed = true;
    if (pending) {
      this.threadArchiveRecoveries.set(messageId, structuredClone(attempt));
      await this.persistThreadArchiveAttempt(messageId, attempt);
    }
    await this.applyCompletedThreadArchive(chatId, attempt);
    await this.sendMarkdown(chatId, threadArchiveResultMessage(attempt));
  }

  private async unarchiveThread(
    chatId: string,
    chatType: ChatType,
    argument: string,
    messageId: string,
  ): Promise<void> {
    if (!this.codex.unarchiveThread) {
      await this.sender.sendText(chatId, "当前 Codex 客户端暂不支持恢复已归档会话。");
      return;
    }
    const pending = this.requireState().pendingMessages[messageId];
    const recovered = this.threadArchiveRecoveries.get(messageId) ?? pending?.threadArchiveAttempt;
    if (recovered) {
      await this.finishRecoveredThreadArchive(chatId, recovered);
      return;
    }
    if (!argument) {
      await this.sender.sendText(chatId, "用法：/unarchive <已归档编号|thread_id>（先发送 /archived）");
      return;
    }
    const session = this.ensureSession(chatId, this.requireState(), chatType);
    const index = parseSelectionIndex(argument);
    const threadId = index === null
      ? argument
      : session.lastArchivedThreads?.[index - 1]?.threadId;
    if (!threadId) {
      await this.sender.sendText(chatId, "没有这个已归档会话编号。请先发送 /archived 刷新列表。");
      return;
    }
    const attempt: PendingThreadArchiveAttempt = {
      action: "unarchive",
      threadId,
      startedAt: new Date().toISOString(),
    };
    if (pending) {
      await this.persistThreadArchiveAttempt(messageId, attempt);
    }
    try {
      await this.codex.unarchiveThread(threadId);
    } catch (error) {
      await this.sender.sendText(chatId, `恢复已归档会话失败：${formatError(error)}`);
      return;
    }
    attempt.completed = true;
    if (pending) {
      this.threadArchiveRecoveries.set(messageId, structuredClone(attempt));
      await this.persistThreadArchiveAttempt(messageId, attempt);
    }
    await this.applyCompletedThreadArchive(chatId, attempt);
    await this.sendMarkdown(chatId, threadArchiveResultMessage(attempt));
  }

  private async persistThreadArchiveAttempt(
    messageId: string,
    attempt: PendingThreadArchiveAttempt,
  ): Promise<void> {
    await this.mutateState((state) => {
      const pending = state.pendingMessages[messageId];
      if (!pending) {
        throw new Error("Cannot persist archive intent without a pending message.");
      }
      pending.threadArchiveAttempt = structuredClone(attempt);
    });
  }

  private async applyCompletedThreadArchive(
    chatId: string,
    attempt: PendingThreadArchiveAttempt,
  ): Promise<void> {
    if (!attempt.completed) {
      return;
    }
    await this.mutateState((state) => {
      const session = this.ensureSession(chatId, state);
      if (attempt.action === "archive" && session.threadId === attempt.threadId) {
        session.threadId = undefined;
        session.lastTurns = undefined;
        session.sessionEpoch = createSessionEpoch();
      }
      if (attempt.action === "unarchive") {
        session.lastArchivedThreads = session.lastArchivedThreads?.filter(
          (thread) => thread.threadId !== attempt.threadId,
        );
      }
      session.updatedAt = new Date().toISOString();
    });
  }

  private async finishRecoveredThreadArchive(
    chatId: string,
    attempt: PendingThreadArchiveAttempt,
  ): Promise<void> {
    await this.applyCompletedThreadArchive(chatId, attempt);
    await this.sendMarkdown(chatId, threadArchiveResultMessage(attempt));
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
      {
        kind: "session_list",
        input: {
          cwd: `搜索：${query}`,
          title: "Codex 搜索结果",
          contextLabel: "搜索",
          note: "发送 /resume <编号> 继续会话，或发送 /fork <编号> 分叉会话。",
          currentThreadId: session.threadId,
          sessions: selections,
        },
      },
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

    await this.applyThreadSelection(chatId, selection);
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

  private async forkThread(
    chatId: string,
    chatType: ChatType,
    argument: string,
    messageId: string,
  ): Promise<void> {
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
    const pending = state.pendingMessages[messageId];
    const pendingContext = pending ?? toPendingMessage({
      messageId,
      chatId,
      chatType,
      sender: {},
      text: `/fork ${argument}`,
    }, "control_no_replay");
    const replayAttempt = this.forkRecoveries.get(messageId) ?? pending?.forkAttempt;
    if (replayAttempt) {
      await this.sendMarkdown(
        chatId,
        this.recoveredForkMessage(state, pendingContext, replayAttempt),
      );
      return;
    }

    const turnFork = parseHistoricalTurnForkArgument(argument);
    let lastTurnId: string | undefined;
    let selection: ThreadSelection | null;
    if (turnFork.requested) {
      if (!current.threadId) {
        await this.sender.sendText(
          chatId,
          "当前 chat 还没有可分叉的 Codex 会话。先发送任务或用 /resume 选择会话。",
        );
        return;
      }
      if (!turnFork.argument) {
        await this.sender.sendText(
          chatId,
          "用法：/fork --turn <历史编号|turn_id>；请先发送 /history 查看历史。",
        );
        return;
      }
      const turn = resolveHistoricalTurnBoundary(
        current.lastTurns,
        current.threadId,
        turnFork.argument,
      );
      if (!turn) {
        await this.sender.sendText(
          chatId,
          "没有这个当前会话的历史编号或 turn_id。请先发送 /history 查看当前会话历史。",
        );
        return;
      }
      if (turn.status === "inProgress") {
        await this.sender.sendText(chatId, "这个历史 turn 仍在进行中，完成或停止后才能从这里分叉。");
        return;
      }
      selection = { threadId: current.threadId, cwd: current.cwd };
      lastTurnId = turn.turnId;
    } else {
      selection = await this.resolveThreadForControl(chatId, chatType, current, argument);
    }
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

    const forkAttempt: PendingForkAttempt = {
      sourceThreadId: selection.threadId,
      startedAt: new Date().toISOString(),
      ...(lastTurnId ? { lastTurnId } : {}),
    };
    if (pending) {
      await this.mutateState((currentState) => {
        const currentPending = currentState.pendingMessages[messageId];
        if (!currentPending) {
          throw new Error("Pending fork message disappeared before its intent was persisted.");
        }
        currentPending.forkAttempt = { ...forkAttempt };
      });
    }

    await this.rotateSessionEpoch(chatId, "thread_fork");
    let forked: CodexThread;
    try {
      forked = await this.codex.forkThread({
        threadId: selection.threadId,
        cwd: selection.cwd,
        ...(lastTurnId ? { lastTurnId } : {}),
      });
    } catch (error) {
      await this.sender.sendText(chatId, `分叉 Codex 会话失败：${formatError(error)}`);
      return;
    }

    const forkSelection = toThreadSelection(forked);
    const completedAttempt: PendingForkAttempt = {
      ...forkAttempt,
      result: forkSelection,
      selectionPersisted: true,
    };
    if (pending) {
      this.forkRecoveries.set(messageId, completedAttempt);
    }
    if (!this.directoryAllowedForChat(forked.cwd, chatType)) {
      const blockedAttempt: PendingForkAttempt = {
        ...completedAttempt,
        selectionPersisted: false,
      };
      if (pending) {
        this.forkRecoveries.set(messageId, blockedAttempt);
        await this.persistForkRecovery(messageId, blockedAttempt).catch((error: unknown) => {
          this.logger.error("Failed to persist the policy-blocked fork for recovery", error);
        });
      }
      await this.sendMarkdown(
        chatId,
        this.recoveredForkMessage(this.requireState(), pendingContext, blockedAttempt),
      );
      return;
    }

    try {
      if (pending) {
        await this.persistForkSelection(chatId, messageId, forkSelection, completedAttempt);
      } else {
        await this.applyThreadSelection(chatId, forkSelection);
      }
    } catch (error) {
      const recoveryAttempt: PendingForkAttempt = {
        ...completedAttempt,
        selectionPersisted: false,
      };
      if (pending) {
        this.forkRecoveries.set(messageId, recoveryAttempt);
        await this.persistForkRecovery(messageId, recoveryAttempt).catch((recoveryError: unknown) => {
          this.logger.error("Failed to persist the created fork for recovery", recoveryError);
        });
      }
      await this.sendForkPersistenceWarning(chatId, recoveryAttempt, error);
      return;
    }
    await this.sendMarkdown(
      chatId,
      this.recoveredForkMessage(this.requireState(), pendingContext, completedAttempt),
    );
  }

  private async persistForkSelection(
    chatId: string,
    messageId: string,
    selection: ThreadSelection,
    attempt: PendingForkAttempt,
  ): Promise<void> {
    await this.mutateState((state) => {
      const pending = state.pendingMessages[messageId];
      if (!pending) {
        throw new Error("Pending fork message disappeared before its result was persisted.");
      }
      pending.forkAttempt = structuredClone(attempt);
      const current = this.ensureSession(chatId, state, pending.chatType);
      state.chats[chatId] = selectedChatSession(current, selection);
    });
    await this.invalidateCodexSession(chatId, "thread_changed");
  }

  private async persistForkRecovery(
    messageId: string,
    attempt: PendingForkAttempt,
  ): Promise<void> {
    await this.mutateState((state) => {
      const pending = state.pendingMessages[messageId];
      if (!pending) {
        throw new Error("Pending fork message disappeared before recovery was persisted.");
      }
      pending.forkAttempt = structuredClone(attempt);
    });
  }

  private recoveredForkMessage(
    state: BridgeState,
    pending: PendingMessageDelivery,
    attempt: PendingForkAttempt,
  ): string {
    const result = attempt.result;
    if (!result) {
      return [
        "**没有重复执行分叉**",
        `来源：\`${attempt.sourceThreadId}\``,
        ...(attempt.lastTurnId ? [`截止 turn：\`${attempt.lastTurnId}\``] : []),
        "",
        "此前的分叉尝试未能完整记录结果。为避免创建重复 thread，本次不会自动重试；请发送 `/threads` 检查已有会话后再决定。",
      ].join("\n");
    }
    if (!this.directoryAllowedForChat(result.cwd, pending.chatType)) {
      return [
        "**分叉已创建，但安全策略阻止选择**",
        `来源：\`${attempt.sourceThreadId}\``,
        ...(attempt.lastTurnId ? [`截止 turn：\`${attempt.lastTurnId}\``] : []),
        `新 thread：\`${result.threadId}\``,
        "",
        this.formatDirectoryDenied(result.cwd),
        "",
        "系统不会自动重试，也不会把当前 chat 切到这个 thread。",
      ].join("\n");
    }
    const selected =
      attempt.selectionPersisted === true &&
      state.chats[pending.chatId]?.threadId === result.threadId;
    return [
      selected ? "**已分叉 Codex 会话**" : "**分叉已创建，但当前会话未切换**",
      `来源：\`${attempt.sourceThreadId}\``,
      ...(attempt.lastTurnId ? [`截止 turn：\`${attempt.lastTurnId}\``] : []),
      `新 thread：\`${result.threadId}\``,
      `项目：\`${result.cwd}\``,
      "",
      selected
        ? attempt.lastTurnId
          ? "下一条消息会继续这个分叉会话；原会话不会被修改，也不会恢复或回滚本地文件。"
          : "下一条消息会继续这个分叉会话；原会话不会被修改。"
        : "当前会话可能已在稍后切换，或之前未能保存切换结果；系统不会覆盖它。发送 `/resume <thread_id>` 可选择上面的新 thread。",
    ].join("\n");
  }

  private async sendForkPersistenceWarning(
    chatId: string,
    attempt: PendingForkAttempt,
    error: unknown,
  ): Promise<void> {
    const result = attempt.result;
    if (!result) {
      throw new Error("Fork recovery attempt is missing its result.");
    }
    this.logger.error("Fork created but chat selection persistence failed", error);
    await this.sendMarkdown(
      chatId,
      [
        "**分叉已创建，但未切换当前会话**",
        `来源：\`${attempt.sourceThreadId}\``,
        ...(attempt.lastTurnId ? [`截止 turn：\`${attempt.lastTurnId}\``] : []),
        `新 thread：\`${result.threadId}\``,
        "",
        "保存会话状态失败，当前 chat 仍停留在原 thread。为避免重复分叉，系统不会自动重试；状态恢复后可用 `/resume <thread_id>` 选择上面的新 thread。",
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

    await this.rotateSessionEpoch(chatId, "thread_compact");
    try {
      await this.codex.compactThread(session.threadId);
    } catch (error) {
      await this.sender.sendText(chatId, `压缩 Codex 会话失败：${formatError(error)}`);
      return;
    }

    await this.mutateState((currentState) => {
      const currentSession = this.ensureSession(chatId, currentState, chatType);
      currentSession.updatedAt = new Date().toISOString();
    });
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
    cwd: string,
  ): Promise<void> {
    await this.mutateState((state) => {
      const current = this.ensureSession(chatId, state);
      state.chats[chatId] = {
        cwd,
        sessionEpoch: createSessionEpoch(),
        chatType: current.chatType,
        updatedAt: new Date().toISOString(),
        lastProjects: current.lastProjects,
        lastTurns: undefined,
      };
    });
    await this.invalidateCodexSession(chatId, "project_changed");
  }

  private async applyThreadSelection(
    chatId: string,
    selection: ThreadSelection,
  ): Promise<void> {
    await this.mutateState((state) => {
      const current = this.ensureSession(chatId, state);
      state.chats[chatId] = {
        cwd: selection.cwd,
        threadId: selection.threadId,
        sessionEpoch: createSessionEpoch(),
        chatType: current.chatType,
        updatedAt: new Date().toISOString(),
        lastProjects: current.lastProjects,
        lastThreads: current.lastThreads,
        lastArchivedThreads: current.lastArchivedThreads,
        lastTurns: undefined,
      };
    });
    await this.invalidateCodexSession(chatId, "thread_changed");
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
      return actionView({ kind: "user_input", input });
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
    return actionView({ kind: "user_input", input });
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
    if (this.interactionLimitReached(chatId)) {
      this.warnInteractionLimit(chatId, "request_user_input");
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
        replyCode: this.createInteractionReplyCode(),
        answers: new Map(),
        resolve,
        signal,
        abortListener,
        handle: null,
      };
      this.activeUserInputs.set(key, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return;
      }
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

  private createInteractionReplyCode(): string {
    let code = "";
    do {
      code = randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase();
    } while (
      [
        ...this.activeApprovals.values(),
        ...this.activeUserInputs.values(),
        ...this.activePermissionApprovals.values(),
        ...this.activeMcpElicitations.values(),
      ].some((pending) => pending.replyCode.toLowerCase() === code)
    );
    return code;
  }

  private async handlePermissionApprovalCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse> {
    if (!action.requestId || !isPermissionApprovalDecision(action.decision)) {
      return cardActionToast("warning", "无法处理权限请求：缺少请求上下文。");
    }
    const pending = this.activePermissionApprovals.get(
      interactiveRequestKey(action.chatId, action.requestId),
    );
    if (!pending) {
      return cardActionToast("warning", "无法处理权限请求：请求已结束或已失效。");
    }
    if (!sameStableSenderIdentity(pending.originSender, action.sender)) {
      return cardActionToast("error", "只有发起当前 Codex 任务的用户可以处理这条权限请求。");
    }
    if (
      !pending.handle ||
      !action.messageId ||
      pending.handle.messageId !== action.messageId
    ) {
      return cardActionToast("warning", "无法处理权限请求：卡片上下文不匹配。");
    }
    if (!this.interactionPolicy.isPermissionDecisionAllowed(pending.request, action.decision)) {
      return cardActionToast("warning", "权限详情未能完整验证，不能执行这项授权。");
    }

    const status = action.decision === "deny" ? "declined" : "resolved";
    const input = this.finishPendingPermissionApproval(pending, status, action.decision);
    await this.updatePermissionApprovalCard(pending.handle, input);
    return actionView({ kind: "permission_approval", input });
  }

  private async answerPermissionFromText(message: IncomingTextMessage): Promise<void> {
    const command = parsePermissionAnswerCommand(routedText(message));
    if (!command) {
      await this.sender.sendText(
        message.chatId,
        "用法：/permit <replyCode> <deny|turn|session>",
      );
      return;
    }
    const pending = [...this.activePermissionApprovals.values()].find(
      (candidate) =>
        candidate.chatId === message.chatId &&
        candidate.replyCode.toLowerCase() === command.replyCode,
    );
    if (!pending) {
      await this.sender.sendText(message.chatId, "回复码无效，或这条权限请求已经结束。");
      return;
    }
    if (!sameStableSenderIdentity(pending.originSender, message.sender)) {
      await this.sender.sendText(
        message.chatId,
        "只有发起当前 Codex 任务的用户可以处理这条权限请求。",
      );
      return;
    }
    const decision: CodexPermissionApprovalDecision =
      command.decision === "deny"
        ? "deny"
        : command.decision === "turn"
          ? "grantTurn"
          : "grantSession";
    if (!this.interactionPolicy.isPermissionDecisionAllowed(pending.request, decision)) {
      await this.sender.sendText(
        message.chatId,
        "权限详情未能完整验证，不能执行这项授权。",
      );
      return;
    }
    const status = decision === "deny" ? "declined" : "resolved";
    const input = this.finishPendingPermissionApproval(pending, status, decision);
    await this.updatePermissionApprovalCard(pending.handle, input);
    await this.sender.sendText(
      message.chatId,
      decision === "deny"
        ? "已拒绝这次额外权限请求。"
        : decision === "grantTurn"
          ? "已仅为当前 turn 授予这次额外权限。"
          : "已为当前 session 授予这次额外权限。",
    );
  }

  private async requestPermissionApproval(
    chatId: string,
    originSender: SenderIdentity | undefined,
    request: CodexPermissionApprovalRequest,
    signal: AbortSignal,
  ): Promise<CodexPermissionApprovalDecision> {
    if (signal.aborted) {
      return "deny";
    }
    if (!originSender || !hasStableSenderIdentity(originSender)) {
      await this.sendUserInputTextSafely(
        chatId,
        "无法确认原始请求人的稳定身份，已拒绝这次额外权限请求。",
      );
      return "deny";
    }
    const key = interactiveRequestKey(chatId, request.id);
    if (this.activePermissionApprovals.has(key)) {
      await this.sendUserInputTextSafely(
        chatId,
        "收到重复的额外权限请求；为避免授权错配，已拒绝后到请求。",
      );
      return "deny";
    }
    if (this.interactionLimitReached(chatId)) {
      this.warnInteractionLimit(chatId, "permission_approval");
      return "deny";
    }

    return new Promise<CodexPermissionApprovalDecision>((resolve) => {
      let pending!: PendingPermissionApproval;
      const abortListener = () => {
        if (this.activePermissionApprovals.get(key) !== pending) {
          return;
        }
        const input = this.finishPendingPermissionApproval(pending, "expired", "deny");
        void this.updatePermissionApprovalCard(pending.handle, input);
      };
      pending = {
        key,
        chatId,
        originSender: { ...originSender },
        request,
        replyCode: this.createInteractionReplyCode(),
        resolve,
        signal,
        abortListener,
        handle: null,
      };
      if (this.config.codexApprovalTimeoutMs > 0) {
        pending.timeoutTimer = setTimeout(() => {
          if (this.activePermissionApprovals.get(key) !== pending) {
            return;
          }
          const input = this.finishPendingPermissionApproval(pending, "expired", "deny");
          void this.updatePermissionApprovalCard(pending.handle, input);
        }, this.config.codexApprovalTimeoutMs);
        pending.timeoutTimer.unref?.();
      }
      this.activePermissionApprovals.set(key, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return;
      }
      void this.presentPermissionApproval(pending);
    });
  }

  private finishPendingPermissionApproval(
    pending: PendingPermissionApproval,
    status: PermissionApprovalCardInput["status"],
    decision: CodexPermissionApprovalDecision,
  ): PermissionApprovalCardInput {
    if (this.activePermissionApprovals.get(pending.key) === pending) {
      this.activePermissionApprovals.delete(pending.key);
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    const input: PermissionApprovalCardInput = {
      status,
      request: pending.request,
      ...(status === "resolved" || status === "declined" ? { decision } : {}),
      updatedAt: new Date().toISOString(),
    };
    pending.terminalCard = input;
    pending.resolve(decision);
    return input;
  }

  private async presentPermissionApproval(pending: PendingPermissionApproval): Promise<void> {
    if (!this.sender.createPermissionApprovalCard || !this.sender.updatePermissionApprovalCard) {
      const delivered = await this.sendUserInputTextSafely(
        pending.chatId,
        formatPermissionApprovalTextPrompt(pending),
      );
      if (!delivered && this.activePermissionApprovals.get(pending.key) === pending) {
        this.finishPendingPermissionApproval(pending, "cancelled", "deny");
      }
      return;
    }
    try {
      const handle = await this.sender.createPermissionApprovalCard(pending.chatId, {
        status: "pending",
        request: pending.request,
        updatedAt: new Date().toISOString(),
      });
      if (this.activePermissionApprovals.get(pending.key) === pending) {
        pending.handle = handle;
        return;
      }
      if (pending.terminalCard) {
        await this.updatePermissionApprovalCard(handle, pending.terminalCard);
      }
    } catch (error) {
      this.logger.warn("Permission approval card creation failed; falling back to text", error);
      if (this.activePermissionApprovals.get(pending.key) === pending) {
        const delivered = await this.sendUserInputTextSafely(
          pending.chatId,
          formatPermissionApprovalTextPrompt(pending),
        );
        if (!delivered && this.activePermissionApprovals.get(pending.key) === pending) {
          this.finishPendingPermissionApproval(pending, "cancelled", "deny");
        }
      }
    }
  }

  private async updatePermissionApprovalCard(
    handle: StatusCardHandle | null,
    input: PermissionApprovalCardInput,
  ): Promise<boolean> {
    if (!handle || !this.sender.updatePermissionApprovalCard) {
      return false;
    }
    try {
      await this.sender.updatePermissionApprovalCard(handle, input);
      return true;
    } catch (error) {
      this.logger.warn("Permission approval card update failed", error);
      return false;
    }
  }

  private async cancelPermissionApprovalsForChat(chatId: string): Promise<void> {
    for (const pending of [...this.activePermissionApprovals.values()]) {
      if (pending.chatId !== chatId || this.activePermissionApprovals.get(pending.key) !== pending) {
        continue;
      }
      const input = this.finishPendingPermissionApproval(pending, "cancelled", "deny");
      await this.updatePermissionApprovalCard(pending.handle, input);
    }
  }

  private async handleMcpElicitationCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse> {
    if (!action.requestId) {
      return cardActionToast("warning", "无法处理 MCP 请求：缺少请求上下文。");
    }
    const pending = this.activeMcpElicitations.get(
      interactiveRequestKey(action.chatId, action.requestId),
    );
    if (!pending) {
      return cardActionToast("warning", "无法处理 MCP 请求：请求已结束或已失效。");
    }
    if (!sameStableSenderIdentity(pending.originSender, action.sender)) {
      return cardActionToast("error", "只有发起当前 Codex 任务的用户可以回答这条 MCP 请求。");
    }
    if (
      !pending.handle ||
      !action.messageId ||
      pending.handle.messageId !== action.messageId
    ) {
      return cardActionToast("warning", "无法处理 MCP 请求：卡片上下文不匹配。");
    }

    if (action.action === answerMcpElicitationCardAction) {
      if (pending.request.mode !== "form" || !action.fieldId) {
        return cardActionToast("warning", "无法处理 MCP 回答：字段上下文无效。");
      }
      const cardInput = this.mcpElicitationCardInput(pending, "pending");
      if (action.decision === "skip") {
        if (!this.interactionPolicy.isMcpSkipAllowed(cardInput, action.fieldId)) {
          return cardActionToast("warning", "这个 MCP 字段不能跳过，或当前字段已经变化。");
        }
        pending.completedFieldIds.add(action.fieldId);
      } else {
        if (action.optionIndex === undefined) {
          return cardActionToast("warning", "无法处理 MCP 回答：选项上下文无效。");
        }
        const value = this.interactionPolicy.getMcpOptionValue(
          cardInput,
          action.fieldId,
          action.optionIndex,
        );
        if (value === undefined) {
          return cardActionToast("warning", "MCP 选项已失效，或当前字段已经变化。");
        }
        pending.answers.set(action.fieldId, value);
        pending.completedFieldIds.add(action.fieldId);
      }
      const updated = this.mcpElicitationCardInput(pending, "pending");
      await this.updateMcpElicitationCard(pending.handle, updated);
      return actionView({ kind: "mcp_elicitation", input: updated });
    }

    if (!isMcpResolutionDecision(action.decision)) {
      return cardActionToast("warning", "无法处理 MCP 请求：缺少处理决定。");
    }
    const cardInput = this.mcpElicitationCardInput(pending, "pending");
    if (!this.interactionPolicy.isMcpDecisionAllowed(cardInput, action.decision)) {
      return cardActionToast("warning", "MCP 请求未完整验证，不能执行这项操作。");
    }
    const response: CodexMcpElicitationResponse =
      action.decision === "accept"
        ? pending.request.mode === "form"
          ? { action: "accept", content: mcpElicitationContent(pending) }
          : { action: "accept", content: null }
        : { action: action.decision };
    const status =
      action.decision === "accept"
        ? "resolved"
        : action.decision === "decline"
          ? "declined"
          : "cancelled";
    const terminal = this.finishPendingMcpElicitation(pending, status, response);
    await this.updateMcpElicitationCard(pending.handle, terminal);
    return actionView({ kind: "mcp_elicitation", input: terminal });
  }

  private async requestMcpElicitation(
    chatId: string,
    originSender: SenderIdentity | undefined,
    request: CodexMcpElicitationRequest,
    signal: AbortSignal,
  ): Promise<CodexMcpElicitationResponse> {
    if (signal.aborted) {
      return { action: "cancel" };
    }
    if (!originSender || !hasStableSenderIdentity(originSender)) {
      await this.sendUserInputTextSafely(
        chatId,
        "无法确认原始请求人的稳定身份，已取消这次 MCP elicitation。",
      );
      return { action: "cancel" };
    }
    if (
      request.mode === "form" &&
      request.fields.some((field) => isSensitiveMcpInputField(field))
    ) {
      await this.sendUserInputTextSafely(
        chatId,
        "这次 MCP 表单包含 secret/password-like 字段；聊天通道不能安全采集或展示，已取消请求。",
      );
      return { action: "cancel" };
    }
    const key = interactiveRequestKey(chatId, request.id);
    if (this.activeMcpElicitations.has(key)) {
      await this.sendUserInputTextSafely(
        chatId,
        "收到重复的 MCP elicitation；为避免回答错配，已取消后到请求。",
      );
      return { action: "cancel" };
    }
    if (this.interactionLimitReached(chatId)) {
      this.warnInteractionLimit(chatId, "mcp_elicitation");
      return { action: "cancel" };
    }

    return new Promise<CodexMcpElicitationResponse>((resolve) => {
      let pending!: PendingMcpElicitation;
      const abortListener = () => {
        if (this.activeMcpElicitations.get(key) !== pending) {
          return;
        }
        const input = this.finishPendingMcpElicitation(
          pending,
          "expired",
          { action: "cancel" },
        );
        void this.updateMcpElicitationCard(pending.handle, input);
      };
      pending = {
        key,
        chatId,
        originSender: { ...originSender },
        request,
        replyCode: this.createInteractionReplyCode(),
        answers: new Map(),
        completedFieldIds: new Set(),
        resolve,
        signal,
        abortListener,
        handle: null,
      };
      if (this.config.codexApprovalTimeoutMs > 0) {
        pending.timeoutTimer = setTimeout(() => {
          if (this.activeMcpElicitations.get(key) !== pending) {
            return;
          }
          const input = this.finishPendingMcpElicitation(
            pending,
            "expired",
            { action: "cancel" },
          );
          void this.updateMcpElicitationCard(pending.handle, input);
        }, this.config.codexApprovalTimeoutMs);
        pending.timeoutTimer.unref?.();
      }
      this.activeMcpElicitations.set(key, pending);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return;
      }
      void this.presentMcpElicitation(pending);
    });
  }

  private async answerMcpElicitationFromText(message: IncomingTextMessage): Promise<void> {
    const command = parseMcpAnswerCommand(routedText(message));
    if (!command) {
      await this.sender.sendText(
        message.chatId,
        "用法：/mcp-answer <replyCode> <fieldId> <内容>",
      );
      return;
    }
    const pending = [...this.activeMcpElicitations.values()].find(
      (candidate) =>
        candidate.chatId === message.chatId &&
        candidate.replyCode.toLowerCase() === command.replyCode.toLowerCase(),
    );
    if (!pending) {
      await this.sender.sendText(message.chatId, "回复码无效，或这条 MCP 请求已经结束。");
      return;
    }
    if (!sameStableSenderIdentity(pending.originSender, message.sender)) {
      await this.sender.sendText(
        message.chatId,
        "只有发起当前 Codex 任务的用户可以回答这条 MCP 请求。",
      );
      return;
    }
    if (pending.request.mode !== "form") {
      await this.sender.sendText(message.chatId, "URL 型 MCP 请求只能通过原始卡片处理。");
      return;
    }
    const field = nextMcpElicitationField(pending);
    if (!field || field.name !== command.fieldId) {
      await this.sender.sendText(
        message.chatId,
        "MCP 当前字段已经变化；请按最新卡片或提示中的 fieldId 重试。",
      );
      return;
    }
    if (isSensitiveMcpInputField(field)) {
      await this.sender.sendText(
        message.chatId,
        "这个字段看起来包含 secret/password；聊天中不会接收该值。",
      );
      return;
    }
    if (command.answer === "/skip" && !field.required) {
      pending.completedFieldIds.add(field.name);
    } else {
      const parsed = parseMcpTextAnswer(field, command.answer);
      if (!parsed.ok) {
        await this.sender.sendText(message.chatId, parsed.message);
        return;
      }
      pending.answers.set(field.name, parsed.value);
      pending.completedFieldIds.add(field.name);
    }

    const nextField = nextMcpElicitationField(pending);
    if (!nextField) {
      const terminal = this.finishPendingMcpElicitation(
        pending,
        "resolved",
        { action: "accept", content: mcpElicitationContent(pending) },
      );
      await this.updateMcpElicitationCard(pending.handle, terminal);
      await this.sendUserInputTextSafely(
        message.chatId,
        "已把 MCP 表单提交给 Codex（回答内容不会在聊天中回显）。",
      );
      return;
    }

    const input = this.mcpElicitationCardInput(pending, "pending");
    await this.updateMcpElicitationCard(pending.handle, input);
    await this.sendUserInputTextSafely(message.chatId, formatMcpTextPrompt(pending));
  }

  private async decideMcpFromText(message: IncomingTextMessage): Promise<void> {
    const command = parseMcpDecisionCommand(routedText(message));
    if (!command) {
      await this.sender.sendText(
        message.chatId,
        "用法：/mcp-decide <replyCode> <accept|decline|cancel>",
      );
      return;
    }
    const pending = [...this.activeMcpElicitations.values()].find(
      (candidate) =>
        candidate.chatId === message.chatId &&
        candidate.replyCode.toLowerCase() === command.replyCode,
    );
    if (!pending) {
      await this.sender.sendText(message.chatId, "回复码无效，或这条 MCP 请求已经结束。");
      return;
    }
    if (!sameStableSenderIdentity(pending.originSender, message.sender)) {
      await this.sender.sendText(
        message.chatId,
        "只有发起当前 Codex 任务的用户可以处理这条 MCP 请求。",
      );
      return;
    }
    const input = this.mcpElicitationCardInput(pending, "pending");
    if (!this.interactionPolicy.isMcpDecisionAllowed(input, command.decision)) {
      await this.sender.sendText(
        message.chatId,
        "MCP 请求未完整验证，不能执行这项操作。",
      );
      return;
    }
    const response: CodexMcpElicitationResponse =
      command.decision === "accept"
        ? pending.request.mode === "form"
          ? { action: "accept", content: mcpElicitationContent(pending) }
          : { action: "accept", content: null }
        : { action: command.decision };
    const status =
      command.decision === "accept"
        ? "resolved"
        : command.decision === "decline"
          ? "declined"
          : "cancelled";
    const terminal = this.finishPendingMcpElicitation(pending, status, response);
    await this.updateMcpElicitationCard(pending.handle, terminal);
    await this.sender.sendText(
      message.chatId,
      command.decision === "accept"
        ? "已接受这条 MCP 请求。"
        : command.decision === "decline"
          ? "已拒绝这条 MCP 请求。"
          : "已取消这条 MCP 请求。",
    );
  }

  private mcpElicitationCardInput(
    pending: PendingMcpElicitation,
    status: McpElicitationCardInput["status"],
  ): McpElicitationCardInput {
    return {
      status,
      request: pending.request,
      updatedAt: new Date().toISOString(),
      ...(pending.request.mode === "form" ? { replyCode: pending.replyCode } : {}),
      ...(status === "pending" || status === "resolved"
        ? { answeredFieldIds: [...pending.completedFieldIds] }
        : {}),
    };
  }

  private finishPendingMcpElicitation(
    pending: PendingMcpElicitation,
    status: McpElicitationCardInput["status"],
    response: CodexMcpElicitationResponse,
  ): McpElicitationCardInput {
    if (this.activeMcpElicitations.get(pending.key) === pending) {
      this.activeMcpElicitations.delete(pending.key);
    }
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    const input = this.mcpElicitationCardInput(pending, status);
    pending.terminalCard = input;
    pending.resolve(response);
    return input;
  }

  private async presentMcpElicitation(pending: PendingMcpElicitation): Promise<void> {
    if (!this.sender.createMcpElicitationCard || !this.sender.updateMcpElicitationCard) {
      await this.presentMcpTextFallback(pending);
      return;
    }
    try {
      const handle = await this.sender.createMcpElicitationCard(
        pending.chatId,
        this.mcpElicitationCardInput(pending, "pending"),
      );
      if (this.activeMcpElicitations.get(pending.key) === pending) {
        pending.handle = handle;
        return;
      }
      if (pending.terminalCard) {
        await this.updateMcpElicitationCard(handle, pending.terminalCard);
      }
    } catch (error) {
      this.logger.warn("MCP elicitation card creation failed", error);
      if (this.activeMcpElicitations.get(pending.key) === pending) {
        await this.presentMcpTextFallback(pending);
      }
    }
  }

  private async presentMcpTextFallback(pending: PendingMcpElicitation): Promise<void> {
    const delivered = await this.sendUserInputTextSafely(
      pending.chatId,
      pending.request.mode === "url"
        ? formatMcpUrlTextPrompt(pending)
        : formatMcpTextPrompt(pending),
    );
    if (!delivered && this.activeMcpElicitations.get(pending.key) === pending) {
      this.finishPendingMcpElicitation(pending, "cancelled", { action: "cancel" });
    }
  }

  private async updateMcpElicitationCard(
    handle: StatusCardHandle | null,
    input: McpElicitationCardInput,
  ): Promise<boolean> {
    if (!handle || !this.sender.updateMcpElicitationCard) {
      return false;
    }
    try {
      await this.sender.updateMcpElicitationCard(handle, input);
      return true;
    } catch (error) {
      this.logger.warn("MCP elicitation card update failed", error);
      return false;
    }
  }

  private async cancelMcpElicitationsForChat(chatId: string): Promise<void> {
    for (const pending of [...this.activeMcpElicitations.values()]) {
      if (pending.chatId !== chatId || this.activeMcpElicitations.get(pending.key) !== pending) {
        continue;
      }
      const input = this.finishPendingMcpElicitation(
        pending,
        "cancelled",
        { action: "cancel" },
      );
      await this.updateMcpElicitationCard(pending.handle, input);
    }
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
    if (
      !run.originSender ||
      !hasStableSenderIdentity(run.originSender) ||
      !sameStableSenderIdentity(run.originSender, action.sender)
    ) {
      return cardActionToast("error", "只有发起这次 Codex 任务的用户可以重试。");
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
        run.collaborationMode,
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

    const view: ChatView = {
      kind: "project_list",
      input: { currentCwd: session.cwd, projects, page },
    };
    return this.updateActionCardOrFallback(action, view, "已更新项目列表。");
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

    const view: ChatView = {
      kind: "session_list",
      input: { cwd: session.cwd, currentThreadId: session.threadId, sessions, page },
    };
    return this.updateActionCardOrFallback(action, view, "已更新会话列表。");
  }

  private async handleSelectProjectCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
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

    await this.applyProjectSelection(action.chatId, selected.cwd);
    const view: ChatView = {
      kind: "project_list",
      input: {
        currentCwd: selected.cwd,
        projects: session.lastProjects ?? [],
        page: action.page ?? pageForIndex(index),
        selectedProjectIndex: index,
        status: "selected",
      },
    };
    return this.updateActionCardOrFallback(
      action,
      view,
      `已进入项目：${path.basename(selected.cwd) || selected.cwd}`,
    );
  }

  private async handleResumeThreadCardAction(
    action: IncomingCardAction,
  ): Promise<CardActionResponse | undefined> {
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

    await this.applyThreadSelection(action.chatId, selected);
    const view: ChatView = {
      kind: "session_list",
      input: {
        cwd: selected.cwd,
        currentThreadId: selected.threadId,
        sessions: session.lastThreads ?? [],
        page: action.page ?? pageForIndex(index),
        selectedThreadIndex: index,
        status: "selected",
      },
    };
    return this.updateActionCardOrFallback(
      action,
      view,
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
    const pending = this.activeApprovals.get(
      interactiveRequestKey(action.chatId, action.approvalId),
    );
    if (!pending) {
      return cardActionToast("warning", "无法处理审批：当前服务没有这条待审批请求。");
    }
    if (!sameStableSenderIdentity(pending.originSender, action.sender)) {
      return cardActionToast("error", "只有发起当前 Codex 任务的用户可以处理这条审批请求。");
    }
    if (
      !pending.handle ||
      !action.messageId ||
      pending.handle.messageId !== action.messageId
    ) {
      return cardActionToast("warning", "无法处理审批：卡片上下文不匹配。");
    }
    if (action.decisionIndex === undefined) {
      return cardActionToast("warning", "无法处理审批：缺少审批选项。");
    }
    if (!this.interactionPolicy.isApprovalDecisionAllowed(pending.request, action.decisionIndex)) {
      return cardActionToast("warning", "无法处理审批：该选项未通过安全披露校验。");
    }
    const decision = pending.request.decisions[action.decisionIndex];
    if (!decision) {
      return cardActionToast("warning", "无法处理审批：审批选项已失效。");
    }

    this.activeApprovals.delete(pending.key);
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
    return actionView({ kind: "approval", input: resolvedInput });
  }

  private async answerApprovalFromText(message: IncomingTextMessage): Promise<void> {
    const command = parseApprovalAnswerCommand(routedText(message));
    if (!command) {
      await this.sender.sendText(
        message.chatId,
        "用法：/approve <replyCode> <选项编号>",
      );
      return;
    }
    const pending = [...this.activeApprovals.values()].find(
      (candidate) =>
        candidate.chatId === message.chatId &&
        candidate.replyCode.toLowerCase() === command.replyCode,
    );
    if (!pending) {
      await this.sender.sendText(message.chatId, "回复码无效，或这条审批请求已经结束。");
      return;
    }
    if (!sameStableSenderIdentity(pending.originSender, message.sender)) {
      await this.sender.sendText(
        message.chatId,
        "只有发起当前 Codex 任务的用户可以处理这条审批请求。",
      );
      return;
    }
    const decisionIndex = command.optionNumber - 1;
    if (!this.interactionPolicy.isApprovalDecisionAllowed(pending.request, decisionIndex)) {
      await this.sender.sendText(message.chatId, "审批选项无效或已经失效。");
      return;
    }
    const decision = pending.request.decisions[decisionIndex];
    if (!decision) {
      await this.sender.sendText(message.chatId, "审批选项无效或已经失效。");
      return;
    }
    this.activeApprovals.delete(pending.key);
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
    }
    pending.decision = decision;
    pending.resolvedAt = new Date().toISOString();
    pending.resolve(decision);
    await this.updateApprovalCard(pending.handle, {
      status: "resolved",
      request: pending.request,
      decision,
      updatedAt: pending.resolvedAt,
    });
    await this.sender.sendText(
      message.chatId,
      `已提交审批决定：${approvalDecisionLabel(decision)}。`,
    );
  }

  private async requestApproval(
    chatId: string,
    originSender: SenderIdentity | undefined,
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
    if (!originSender || !hasStableSenderIdentity(originSender)) {
      await this.sendUserInputTextSafely(
        chatId,
        "无法确认原始请求人的稳定身份，已取消这次 Codex 审批请求。",
      );
      return "cancel";
    }
    const key = interactiveRequestKey(chatId, request.id);
    if (this.activeApprovals.has(key)) {
      await this.sendUserInputTextSafely(
        chatId,
        "收到重复的 Codex 审批请求；为避免审批错配，已取消后到请求。",
      );
      return "cancel";
    }
    if (this.interactionLimitReached(chatId)) {
      this.warnInteractionLimit(chatId, "approval");
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
        key,
        chatId,
        originSender: { ...originSender },
        request,
        replyCode: this.createInteractionReplyCode(),
        resolve,
        handle: null,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
      };
      this.activeApprovals.set(key, pending);
      const cancel = () => {
        if (this.activeApprovals.get(key) !== pending) {
          return;
        }
        this.activeApprovals.delete(key);
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
          if (this.activeApprovals.get(key) !== pending) {
            return;
          }
          this.activeApprovals.delete(key);
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

      const presentation = this.sender.createApprovalCard && this.sender.updateApprovalCard
        ? this.createApprovalCard(chatId, {
        status: "pending",
        request,
        updatedAt: new Date().toISOString(),
          })
        : this.sendUserInputTextSafely(chatId, formatApprovalTextPrompt(pending)).then(
            (delivered) => {
              if (!delivered) {
                throw new Error("Approval text prompt delivery failed.");
              }
              return null;
            },
          );
      presentation
        .then((handle) => {
          if (!handle) {
            return;
          }
          if (this.activeApprovals.get(key) === pending) {
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
          this.logger.warn("Approval presentation failed", error);
          if (this.activeApprovals.get(key) === pending) {
            if (this.sender.createApprovalCard && this.sender.updateApprovalCard) {
              void this.sendUserInputTextSafely(
                chatId,
                formatApprovalTextPrompt(pending),
              ).then((delivered) => {
                if (!delivered && this.activeApprovals.get(key) === pending) {
                  this.activeApprovals.delete(key);
                  resolve("cancel");
                }
              });
            } else {
              this.activeApprovals.delete(key);
              resolve("cancel");
            }
          }
        });
    });
  }

  private async cancelApprovalsForChat(chatId: string): Promise<void> {
    const pending = [...this.activeApprovals.values()].filter((approval) => approval.chatId === chatId);
    for (const approval of pending) {
      if (this.activeApprovals.get(approval.key) !== approval) {
        continue;
      }
      this.activeApprovals.delete(approval.key);
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
    collaborationMode: CodexCollaborationMode,
    originSender?: SenderIdentity,
  ): void {
    const run = {
      prompt,
      collaborationMode,
      originSender: originSender ? { ...originSender } : undefined,
    };
    this.retryableRunsByChat.delete(chatId);
    this.retryableRunsByChat.set(chatId, run);
    while (this.retryableRunsByChat.size > maxRememberedStatusCards) {
      const oldestChatId = this.retryableRunsByChat.keys().next().value;
      if (!oldestChatId) {
        break;
      }
      this.retryableRunsByChat.delete(oldestChatId);
    }
    if (!handle) {
      return;
    }

    this.statusCardRuns.set(handle.messageId, { chatId, ...run });
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
    runState: ActiveRunState,
  ): (update: CodexProgressUpdate) => Promise<void> {
    let lastSentAt = 0;
    return async (update) => {
      if (signal.aborted || runState.terminal) {
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
      const delivery = runState.progressDeliveryTail.then(async () => {
        if (signal.aborted) {
          return;
        }
        await this.sender.sendText(chatId, update.text);
      });
      runState.progressDeliveryTail = delivery.catch((error: unknown) => {
        this.logger.warn("Progress delivery failed", error);
      });
      await delivery;
    };
  }

  private async closeProgressReporter(runState: ActiveRunState): Promise<void> {
    runState.terminal = true;
    await runState.progressDeliveryTail;
  }

  private async addProcessingReaction(
    chatId: string,
    messageId: string,
  ): Promise<MessageReactionHandle | null> {
    if (this.sender.addReaction) {
      try {
        const handle = await this.sender.addReaction(chatId, messageId, "processing");
        if (handle) {
          return handle;
        }
      } catch (error) {
        this.logger.warn("Processing reaction creation failed", error);
      }
    }

    try {
      await this.sender.sendText(chatId, "收到，已开始处理。");
    } catch (error) {
      this.logger.warn("Processing acknowledgement failed", error);
    }
    return null;
  }

  private async finishProcessingReaction(queuedRun: QueuedRunState): Promise<void> {
    const handle = queuedRun.processingReaction;
    if (!handle || !this.sender.removeReaction) {
      return;
    }

    try {
      await this.sender.removeReaction(handle);
    } catch (error) {
      this.logger.warn("Processing reaction removal failed", error);
      return;
    }

    if (
      !queuedRun.messageId ||
      this.state?.jobs[queuedRun.messageId]?.status !== "failed" ||
      !this.sender.addReaction
    ) {
      return;
    }

    try {
      await this.sender.addReaction(
        handle.conversationId,
        handle.messageId,
        "failure",
      );
    } catch (error) {
      this.logger.warn("Failure reaction creation failed", error);
    }
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
    view: ChatView,
    successToast: string,
  ): Promise<CardActionResponse | undefined> {
    this.logger.debug(successToast, {
      chatId: action.chatId,
      messageId: action.messageId,
    });
    return actionView(view);
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
    let cwd = this.config.codexWorkdir;
    await this.mutateState((state) => {
      const current = this.ensureSession(chatId, state);
      cwd = current.cwd;
      state.chats[chatId] = {
        cwd,
        sessionEpoch: createSessionEpoch(),
        chatType: current.chatType,
        updatedAt: new Date().toISOString(),
        lastProjects: current.lastProjects,
        lastThreads: current.lastThreads,
        lastArchivedThreads: current.lastArchivedThreads,
      };
    });
    await this.invalidateCodexSession(chatId, "session_reset");
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

    await this.mutateState((state) => {
      const current = state.chats[chatId];
      state.chats[chatId] = {
        cwd: nextCwd,
        sessionEpoch: createSessionEpoch(),
        chatType,
        updatedAt: new Date().toISOString(),
        lastProjects: current?.lastProjects,
      };
    });
    await this.invalidateCodexSession(chatId, "cwd_changed");
    await this.sender.sendText(chatId, `已切换 cwd，并重置 session：\n${nextCwd}`);
  }

  private async rotateSessionEpoch(chatId: string, reason: string): Promise<void> {
    await this.mutateState((state) => {
      const session = this.ensureSession(chatId, state);
      session.sessionEpoch = createSessionEpoch();
      session.updatedAt = new Date().toISOString();
    });
    await this.invalidateCodexSession(chatId, reason);
  }

  private async invalidateCodexSession(chatId: string, reason: string): Promise<void> {
    await this.codex.invalidateChatSession?.(chatId, reason);
  }

  private ensureSession(
    chatId: string,
    state: BridgeState = this.requireState(),
    chatType?: ChatType,
  ) {
    const session = state.chats[chatId] ?? {
      cwd: this.config.codexWorkdir,
      sessionEpoch: createSessionEpoch(),
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
    tokenUsage: input.summary?.tokenUsage ? structuredClone(input.summary.tokenUsage) : undefined,
    review: toLastRunReviewSummary(input.summary, input.cwd),
  };
}

function formatTokenUsage(lastRun: LastRunSummary): string {
  const usage = lastRun.tokenUsage!;
  const context = usage.modelContextWindow;
  const contextPercent =
    typeof context === "number" && context > 0
      ? `${((usage.total.totalTokens / context) * 100).toFixed(1)}%`
      : "(unknown)";
  return [
    "**最近一轮 Token 用量**",
    lastRun.threadId ? `thread：\`${lastRun.threadId}\`` : null,
    `本轮：${formatTokenCount(usage.last.totalTokens)}（输入 ${formatTokenCount(usage.last.inputTokens)}，缓存输入 ${formatTokenCount(usage.last.cachedInputTokens)}，输出 ${formatTokenCount(usage.last.outputTokens)}，推理输出 ${formatTokenCount(usage.last.reasoningOutputTokens)}）`,
    `累计：${formatTokenCount(usage.total.totalTokens)}（输入 ${formatTokenCount(usage.total.inputTokens)}，缓存输入 ${formatTokenCount(usage.total.cachedInputTokens)}，输出 ${formatTokenCount(usage.total.outputTokens)}，推理输出 ${formatTokenCount(usage.total.reasoningOutputTokens)}）`,
    `context window：${typeof context === "number" ? formatTokenCount(context) : "(unknown)"}`,
    `累计占 context：${contextPercent}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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

function selectedChatSession(
  current: {
    chatType?: ChatType;
    lastProjects?: ProjectSelection[];
    lastThreads?: ThreadSelection[];
    lastArchivedThreads?: ThreadSelection[];
  },
  selection: ThreadSelection,
): ChatSession {
  return {
    cwd: selection.cwd,
    threadId: selection.threadId,
    sessionEpoch: createSessionEpoch(),
    chatType: current.chatType,
    updatedAt: new Date().toISOString(),
    lastProjects: current.lastProjects,
    lastThreads: current.lastThreads,
    lastArchivedThreads: current.lastArchivedThreads,
    lastTurns: undefined,
  };
}

function parseHistoricalTurnForkArgument(argument: string): {
  requested: boolean;
  argument: string;
} {
  const trimmed = argument.trim();
  const match = /^--turn(?:\s+(.*))?$/u.exec(trimmed);
  if (match) {
    return { requested: true, argument: match[1]?.trim() ?? "" };
  }
  return { requested: false, argument: "" };
}

function resolveHistoricalTurnBoundary(
  turns: TurnSelection[] | undefined,
  threadId: string,
  argument: string,
): { turnId: string; status?: string } | null {
  const index = parseSelectionIndex(argument);
  if (index !== null) {
    const turn = turns?.[index - 1];
    return turn?.threadId === threadId
      ? { turnId: turn.turnId, status: turn.status }
      : null;
  }

  const turnId = argument.trim();
  if (!turnId) {
    return null;
  }
  const cached = turns?.find(
    (candidate) => candidate.threadId === threadId && candidate.turnId === turnId,
  );
  return { turnId, status: cached?.status };
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
  lines.push(
    "",
    "发送 `/history <编号>` 查看详情，或 `/fork --turn <编号>` 从这一轮非破坏性分叉。",
  );
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

function pendingMessageRoute(
  config: BridgeConfig,
  message: IncomingTextMessage,
): PendingMessageRoute {
  if (isDurableCodexCandidate(config, message)) {
    return "codex";
  }
  if (!message.attachments?.length) {
    const text = routedText(message);
    if (isBuiltInRouterCommand(text)) {
      return isReplaySafeRouterCommand(text)
        ? "control_replay_safe"
        : "control_no_replay";
    }
  }
  return "message";
}

function inferLegacyPendingRoute(
  config: BridgeConfig,
  pending: PendingMessageDelivery,
  job: DurableCodexJob | undefined,
): PendingMessageRoute {
  if (job) {
    return "codex";
  }
  return pendingMessageRoute(config, fromPendingMessage(pending));
}

function isReplaySafeRouterCommand(text: string): boolean {
  return (
    text === "/help" ||
    text === "/whoami" ||
    text === "/status" ||
    text === "/host" ||
    text === "/health" ||
    text === "/diff" ||
    text === "/logs" ||
    text === "/files" ||
    text === "/summary" ||
    text === "/usage" ||
    text === "/plan" ||
    text === "/projects" ||
    text === "/threads" ||
    text === "/sessions" ||
    text === "/archived" ||
    text === "/service" ||
    text === "/service status" ||
    text === "/service logs" ||
    text === "/history" ||
    text.startsWith("/history ") ||
    text === "/search" ||
    text.startsWith("/search ")
  );
}

function controlCommandName(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return "(control command)";
  }
  return trimmed.split(/\s+/u, 1)[0] ?? "(control command)";
}

function isBuiltInRouterCommand(text: string): boolean {
  return (
    text === "/help" ||
    text === "/whoami" ||
    text === "/status" ||
    text === "/host" ||
    text === "/health" ||
    text === "/diff" ||
    text === "/logs" ||
    text === "/files" ||
    text === "/summary" ||
    text === "/usage" ||
    text === "/service" ||
    text.startsWith("/service ") ||
    text === "/retry" ||
    text === "/stop" ||
    text === "/projects" ||
    text === "/threads" ||
    text === "/sessions" ||
    text === "/archived" ||
    text === "/archive" ||
    text === "/unarchive" ||
    text.startsWith("/unarchive ") ||
    text === "/compact" ||
    text === "/plan" ||
    text === "/new" ||
    text === "/reset" ||
    text === "/steer" ||
    text.startsWith("/steer ") ||
    text === "/answer" ||
    text.startsWith("/answer ") ||
    text === "/mcp-answer" ||
    text.startsWith("/mcp-answer ") ||
    text === "/approve" ||
    text.startsWith("/approve ") ||
    text === "/permit" ||
    text.startsWith("/permit ") ||
    text === "/mcp-decide" ||
    text.startsWith("/mcp-decide ") ||
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

async function readServiceLogTail(logFilePath: string | undefined): Promise<string> {
  if (logFilePath) {
    const handle = await fs.open(logFilePath, "r");
    try {
      const stat = await handle.stat();
      const maxBytes = 64 * 1024;
      const length = Math.min(stat.size, maxBytes);
      const offset = Math.max(0, stat.size - length);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset > 0) {
        text = text.slice(Math.max(0, text.indexOf("\n") + 1));
      }
      const lines = text.split("\n").filter(Boolean).slice(-80);
      return truncateDetail(lines.join("\n") || "(日志文件为空)", 12_000);
    } finally {
      await handle.close();
    }
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      "journalctl",
      ["--user", "-u", "chat2codex.service", "-n", "80", "--no-pager"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "journalctl did not return service logs");
    }
    return truncateDetail(result.stdout.trim() || "(systemd journal 为空)", 12_000);
  }
  throw new Error("当前进程没有配置 CHAT2CODEX_LOG_FILE");
}

function threadArchiveResultMessage(attempt: PendingThreadArchiveAttempt): string {
  if (!attempt.completed) {
    return [
      "**会话归档操作结果未知**",
      `操作：${attempt.action}`,
      `thread：\`${attempt.threadId}\``,
      "服务不会自动重放这次外部状态变更；请用 `/archived` 核对后再决定下一步。",
    ].join("\n");
  }
  return attempt.action === "archive"
    ? [
        "**已归档当前 Codex 会话**",
        `thread：\`${attempt.threadId}\``,
        "本地文件没有被删除或回滚；下一条普通任务会创建新会话。",
      ].join("\n")
    : [
        "**已恢复已归档的 Codex 会话**",
        `thread：\`${attempt.threadId}\``,
        "发送 `/threads` 后用 `/resume` 继续该会话。",
      ].join("\n");
}

function recoveredThreadArchiveMessage(
  state: BridgeState,
  pending: PendingMessageDelivery,
  attempt: PendingThreadArchiveAttempt,
): string {
  if (attempt.completed) {
    const session = state.chats[pending.chatId];
    if (attempt.action === "archive" && session?.threadId === attempt.threadId) {
      session.threadId = undefined;
      session.lastTurns = undefined;
      session.sessionEpoch = createSessionEpoch();
      session.updatedAt = new Date().toISOString();
    }
    if (attempt.action === "unarchive" && session) {
      session.lastArchivedThreads = session.lastArchivedThreads?.filter(
        (thread) => thread.threadId !== attempt.threadId,
      );
      session.updatedAt = new Date().toISOString();
    }
  }
  return threadArchiveResultMessage(attempt);
}

function isTerminalJobStatus(status: DurableCodexJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

function queueLimitScope(
  state: BridgeState,
  chatId: string,
  config: BridgeConfig,
): "global" | "chat" | null {
  const counts = durableObligationCounts(state);
  if (counts.total >= config.bridgeMaxPendingMessages) {
    return "global";
  }
  if ((counts.byChat.get(chatId) ?? 0) >= config.bridgeMaxPendingMessagesPerChat) {
    return "chat";
  }
  return null;
}

function pendingInboxLimitScope(
  state: BridgeState,
  chatId: string,
  config: BridgeConfig,
): "global" | "chat" | null {
  const counts = inboxObligationCounts(state);
  if (counts.total >= config.bridgeMaxPendingMessages) {
    return "global";
  }
  if ((counts.byChat.get(chatId) ?? 0) >= config.bridgeMaxPendingMessagesPerChat) {
    return "chat";
  }
  return null;
}

function hasActiveCapacityNotice(
  state: BridgeState,
  kind: "durable" | "inbox",
  scope: "global" | "chat",
  chatId: string,
): boolean {
  return Object.values(state.jobs).some(
    (job) =>
      job.capacityNoticeActive === true &&
      (job.capacityNoticeKind ?? "durable") === kind &&
      job.capacityNoticeScope === scope &&
      (scope === "global" || job.chatId === chatId),
  );
}

function clearResolvedCapacityNotices(
  state: BridgeState,
  config: BridgeConfig,
): void {
  const durableCounts = durableObligationCounts(state);
  const inboxCounts = inboxObligationCounts(state);
  const jobsWithUndeliveredOutbox = new Set(
    Object.values(state.outbox)
      .filter((delivery) => delivery.status !== "delivered")
      .map((delivery) => delivery.jobId),
  );
  for (const job of Object.values(state.jobs)) {
    if (!job.capacityNoticeActive || !job.capacityNoticeScope) {
      continue;
    }
    const noticeKind = job.capacityNoticeKind ?? "durable";
    const counts = noticeKind === "durable" ? durableCounts : inboxCounts;
    const stillFull =
      jobsWithUndeliveredOutbox.has(job.id) ||
      (job.capacityNoticeScope === "global"
        ? counts.total >= config.bridgeMaxPendingMessages
        : (counts.byChat.get(job.chatId) ?? 0) >= config.bridgeMaxPendingMessagesPerChat);
    if (!stillFull) {
      job.capacityNoticeActive = false;
    }
  }
}

function inboxObligationCounts(state: BridgeState): {
  total: number;
  byChat: Map<string, number>;
} {
  const obligations = new Map<string, string>();
  for (const pending of Object.values(state.pendingMessages)) {
    if (pending.route === "codex") {
      continue;
    }
    obligations.set(pending.messageId, pending.chatId);
  }
  for (const delivery of Object.values(state.outbox)) {
    if (
      delivery.status !== "delivered" &&
      state.jobs[delivery.jobId]?.kind === "control_recovery"
    ) {
      obligations.set(delivery.jobId, delivery.chatId);
    }
  }

  const byChat = new Map<string, number>();
  for (const chatId of obligations.values()) {
    byChat.set(chatId, (byChat.get(chatId) ?? 0) + 1);
  }
  return { total: obligations.size, byChat };
}

function durableObligationCounts(state: BridgeState): {
  total: number;
  byChat: Map<string, number>;
} {
  const obligations = new Map<string, string>();
  for (const job of Object.values(state.jobs)) {
    if (!isTerminalJobStatus(job.status)) {
      obligations.set(job.id, job.chatId);
    }
  }
  for (const delivery of Object.values(state.outbox)) {
    if (delivery.status !== "delivered") {
      obligations.set(delivery.jobId, delivery.chatId);
    }
  }
  for (const pending of Object.values(state.pendingMessages)) {
    if (
      pending.route === "codex" &&
      !state.jobs[pending.messageId]
    ) {
      obligations.set(pending.messageId, pending.chatId);
    }
  }

  const byChat = new Map<string, number>();
  for (const chatId of obligations.values()) {
    byChat.set(chatId, (byChat.get(chatId) ?? 0) + 1);
  }
  return { total: obligations.size, byChat };
}

function queueCapacityMessage(config: BridgeConfig): string {
  return [
    "Chat2Codex 当前任务队列已满，这条任务没有执行。",
    `全局最多保留 ${config.bridgeMaxPendingMessages} 条排队、运行或待投递任务；每个 chat 最多 ${config.bridgeMaxPendingMessagesPerChat} 条。`,
    "请等待已有任务结束或回复投递成功后重新发送。控制命令使用独立的待处理消息上限；交互回复不受该上限影响。",
  ].join("\n");
}

function inboxCapacityMessage(config: BridgeConfig): string {
  return [
    "Chat2Codex 当前待处理消息已满，这条控制消息没有执行。",
    `全局最多保留 ${config.bridgeMaxPendingMessages} 条待处理消息；每个 chat 最多 ${config.bridgeMaxPendingMessagesPerChat} 条。`,
    "请等待已有消息处理完成后重试。过载期间只会保留这一条通知。",
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

function interruptedControlMessage(command: string): string {
  return [
    "桥接服务在处理控制命令期间重启，无法确认该命令是否已经完成。",
    "为避免重复变更，系统不会自动重放这条控制命令。",
    `command: ${command}`,
    "请先检查当前会话和工作区状态，再决定是否重新发送。",
  ].join("\n");
}

function markMessageProcessed(state: BridgeState, messageId: string): void {
  if (!state.processedMessageIds.includes(messageId)) {
    state.processedMessageIds.push(messageId);
  }
  delete state.pendingMessages[messageId];
}

function toPendingMessage(
  message: IncomingTextMessage,
  route: PendingMessageRoute,
): PendingMessageDelivery {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    sender: { ...message.sender },
    text: message.text,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    acceptedAt: new Date().toISOString(),
    attempts: 0,
    route,
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

function parseCodexTurnRequest(text: string): {
  prompt: string;
  collaborationMode: CodexCollaborationMode;
} {
  if (text === "/plan") {
    return { prompt: "", collaborationMode: "plan" };
  }
  if (text.startsWith("/plan ")) {
    return {
      prompt: text.slice("/plan".length).trim(),
      collaborationMode: "plan",
    };
  }
  return { prompt: text, collaborationMode: "default" };
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

function isMcpAnswerCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/mcp-answer" || text.startsWith("/mcp-answer ");
}

function isApprovalAnswerCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/approve" || text.startsWith("/approve ");
}

function isPermissionAnswerCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/permit" || text.startsWith("/permit ");
}

function isMcpDecisionCommand(message: IncomingTextMessage): boolean {
  const text = routedText(message);
  return text === "/mcp-decide" || text.startsWith("/mcp-decide ");
}

function parseApprovalAnswerCommand(
  text: string,
): { replyCode: string; optionNumber: number } | null {
  const match = /^\/approve\s+([a-f0-9]{8})\s+([1-9]\d*)$/u.exec(text);
  if (!match) {
    return null;
  }
  const optionNumber = Number(match[2]);
  return Number.isSafeInteger(optionNumber)
    ? { replyCode: match[1]!, optionNumber }
    : null;
}

function parsePermissionAnswerCommand(
  text: string,
): { replyCode: string; decision: "deny" | "turn" | "session" } | null {
  const match = /^\/permit\s+([a-f0-9]{8})\s+(deny|turn|session)$/u.exec(text);
  return match
    ? {
        replyCode: match[1]!,
        decision: match[2] as "deny" | "turn" | "session",
      }
    : null;
}

function parseMcpDecisionCommand(
  text: string,
): { replyCode: string; decision: "accept" | "decline" | "cancel" } | null {
  const match = /^\/mcp-decide\s+([a-f0-9]{8})\s+(accept|decline|cancel)$/u.exec(text);
  return match
    ? {
        replyCode: match[1]!,
        decision: match[2] as "accept" | "decline" | "cancel",
      }
    : null;
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

interface ParsedMcpAnswerCommand {
  replyCode: string;
  fieldId: string;
  answer: string;
}

function parseMcpAnswerCommand(text: string): ParsedMcpAnswerCommand | null {
  if (!text.startsWith("/mcp-answer ")) {
    return null;
  }
  const rest = text.slice("/mcp-answer".length).trim();
  const separator = rest.search(/\s/u);
  if (separator <= 0) {
    return null;
  }
  const replyCode = rest.slice(0, separator);
  const fieldAndAnswer = rest.slice(separator).trimStart();
  if (!/^[a-f0-9]{8}$/u.test(replyCode) || !fieldAndAnswer) {
    return null;
  }
  let fieldId = "";
  let answerText = "";
  if (fieldAndAnswer.startsWith('"')) {
    const token = parseJsonStringToken(fieldAndAnswer);
    if (!token) {
      return null;
    }
    fieldId = token.value;
    answerText = token.rest;
  } else {
    const fieldSeparator = fieldAndAnswer.search(/\s/u);
    if (fieldSeparator <= 0) {
      return null;
    }
    fieldId = fieldAndAnswer.slice(0, fieldSeparator);
    answerText = fieldAndAnswer.slice(fieldSeparator);
  }
  const answer = answerText.trim();
  if (!fieldId || fieldId.length > 128 || !answer || answer.length > maxMcpTextAnswerLength) {
    return null;
  }
  return { replyCode, fieldId, answer };
}

function parseJsonStringToken(text: string): { value: string; rest: string } | null {
  let escaped = false;
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const token = text.slice(0, index + 1);
    const rest = text.slice(index + 1);
    if (!/^\s/u.test(rest)) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(token);
      return typeof value === "string" ? { value, rest } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function interactiveRequestKey(chatId: string, requestId: string): string {
  return `${chatId}\u0000${requestId}`;
}

function isPermissionApprovalDecision(
  value: unknown,
): value is CodexPermissionApprovalDecision {
  return value === "deny" || value === "grantTurn" || value === "grantSession";
}

function isMcpResolutionDecision(
  value: unknown,
): value is "accept" | "decline" | "cancel" {
  return value === "accept" || value === "decline" || value === "cancel";
}

function nextMcpElicitationField(
  pending: PendingMcpElicitation,
): CodexMcpElicitationField | undefined {
  return pending.request.mode === "form"
    ? pending.request.fields.find((field) => !pending.completedFieldIds.has(field.name))
    : undefined;
}

function mcpElicitationContent(
  pending: PendingMcpElicitation,
): Record<string, CodexMcpElicitationValue> {
  if (pending.request.mode !== "form") {
    return {};
  }
  return Object.fromEntries(
    pending.request.fields.flatMap((field) => {
      const value = pending.answers.get(field.name);
      return value === undefined
        ? []
        : [[field.name, Array.isArray(value) ? [...value] : value] as const];
    }),
  );
}

function isSensitiveMcpInputField(field: CodexMcpElicitationField): boolean {
  const sensitive = (value: string): boolean =>
    /(?:password|passwd|secret|token|api[\s_-]*key|credential|private[\s_-]*key)/iu.test(value);
  if (sensitive(`${field.name} ${field.title ?? ""}`)) {
    return true;
  }
  return (
    (field.type === "enum" || field.type === "multi_select") &&
    field.options.some((option) => sensitive(`${option.title} ${option.value}`))
  );
}

type ParsedMcpTextAnswer =
  | { ok: true; value: CodexMcpElicitationValue }
  | { ok: false; message: string };

function parseMcpTextAnswer(
  field: CodexMcpElicitationField,
  raw: string,
): ParsedMcpTextAnswer {
  if (!raw || raw.length > maxMcpTextAnswerLength) {
    return { ok: false, message: "MCP 回答为空或超过聊天输入上限。" };
  }
  if (field.type === "string") {
    const decoded = decodeMcpStringAnswer(raw);
    if (!decoded.ok) {
      return decoded;
    }
    const value = decoded.value;
    if (
      value.length > 4_096 ||
      (field.minLength !== null && value.length < field.minLength) ||
      (field.maxLength !== null && value.length > field.maxLength)
    ) {
      return { ok: false, message: "MCP 文本回答不符合字段长度约束。" };
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
      return { ok: false, message: "MCP 回答必须是有效的邮箱地址。" };
    }
    if (field.format === "uri") {
      try {
        if (new URL(value).protocol.length <= 1) {
          return { ok: false, message: "MCP 回答必须是有效的 URI。" };
        }
      } catch {
        return { ok: false, message: "MCP 回答必须是有效的 URI。" };
      }
    }
    if (
      field.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    ) {
      return { ok: false, message: "MCP 回答必须是 YYYY-MM-DD 日期。" };
    }
    if (
      field.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      return { ok: false, message: "MCP 回答必须是有效的 ISO 日期时间。" };
    }
    return { ok: true, value };
  }
  if (field.type === "number" || field.type === "integer") {
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isSafeInteger(value)) ||
      (field.minimum !== null && value < field.minimum) ||
      (field.maximum !== null && value > field.maximum)
    ) {
      return { ok: false, message: "MCP 数值回答不符合字段类型或范围约束。" };
    }
    return { ok: true, value };
  }
  if (field.type === "boolean") {
    const value = raw.toLowerCase();
    if (value !== "true" && value !== "false") {
      return { ok: false, message: "MCP 布尔回答只能是 true 或 false。" };
    }
    return { ok: true, value: value === "true" };
  }
  if (field.type === "enum") {
    const decoded = decodeMcpStringAnswer(raw);
    if (!decoded.ok) {
      return decoded;
    }
    const direct = field.options.find((option) => option.value === decoded.value);
    if (direct) {
      return { ok: true, value: direct.value };
    }
    const byTitle = field.options.filter((option) => option.title === decoded.value);
    return byTitle.length === 1
      ? { ok: true, value: byTitle[0]!.value }
      : { ok: false, message: "MCP 回答必须与一个枚举值或唯一标题完全一致。" };
  }

  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return { ok: false, message: "MCP 多选回答必须是 JSON 字符串数组。" };
  }
  const allowed = new Set(field.options.map((option) => option.value));
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === "string") ||
    new Set(values).size !== values.length ||
    (field.minItems !== null && values.length < field.minItems) ||
    (field.maxItems !== null && values.length > field.maxItems) ||
    !values.every((value) => allowed.has(value))
  ) {
    return { ok: false, message: "MCP 多选回答包含无效、重复或超出数量约束的选项。" };
  }
  return { ok: true, value: [...values] };
}

function decodeMcpStringAnswer(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (!raw.startsWith('"')) {
    return { ok: true, value: raw };
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string"
      ? { ok: true, value }
      : { ok: false, message: "MCP 字符串回答的 JSON 引号格式无效。" };
  } catch {
    return { ok: false, message: "MCP 字符串回答的 JSON 引号格式无效。" };
  }
}

function formatMcpTextPrompt(pending: PendingMcpElicitation): string {
  const field = nextMcpElicitationField(pending);
  if (!field) {
    return "这条 MCP elicitation 已经结束。";
  }
  const sensitive = isSensitiveMcpInputField(field);
  const options =
    !sensitive && (field.type === "enum" || field.type === "multi_select")
      ? field.options.map((option) =>
          option.title === option.value
            ? `• ${option.value}`
            : `• ${option.title} (${option.value})`,
        )
      : !sensitive && field.type === "boolean"
        ? ["• true", "• false"]
        : [];
  return [
    "Codex 结构化输入",
    [
      "【问题】",
      `${field.title ?? field.name}（fieldId：${field.name}｜类型：${field.type}｜${field.required ? "必填" : "可选"}）`,
      field.description,
    ].filter((line): line is string => Boolean(line)).join("\n"),
    options.length > 0 ? ["【可选值】", ...options].join("\n") : null,
    sensitive
      ? "这个字段可能包含 secret/password，聊天中不会提供输入入口。"
      : [
          "【回复命令】",
          `• 回答：/mcp-answer ${pending.replyCode} ${JSON.stringify(field.name)} <内容>`,
          !field.required
            ? `• 跳过：/mcp-answer ${pending.replyCode} ${JSON.stringify(field.name)} /skip`
            : null,
        ].filter((line): line is string => Boolean(line)).join("\n"),
    !sensitive && field.type === "multi_select"
      ? "多选值请使用 JSON 字符串数组。"
      : null,
    !field.required && (field.type === "string" || field.type === "enum")
      ? '若实际值就是 /skip，请写成 JSON 字符串 "/skip"。'
      : null,
    "回答内容不会在聊天中回显，也不会写入 Chat2Codex 持久化状态。",
  ].filter((section): section is string => Boolean(section)).join("\n\n");
}

function formatMcpUrlTextPrompt(pending: PendingMcpElicitation): string {
  if (pending.request.mode !== "url") {
    return formatMcpTextPrompt(pending);
  }
  return [
    "Codex MCP 请求",
    [
      "【请求】",
      `• 服务：${pending.request.serverName}`,
      `• 说明：${pending.request.message}`,
      `• URL：${pending.request.url}`,
    ].join("\n"),
    [
      "【可选操作】",
      `• 接受：/mcp-decide ${pending.replyCode} accept`,
      `• 拒绝：/mcp-decide ${pending.replyCode} decline`,
      `• 取消：/mcp-decide ${pending.replyCode} cancel`,
    ].join("\n"),
    "只有发起当前 Codex 任务的用户可以处理，回复码在请求结束后立即失效。",
  ].join("\n\n");
}

function formatApprovalTextPrompt(pending: PendingApproval): string {
  const request = pending.request;
  const requestSection =
    request.kind === "command"
      ? [
          "【命令】",
          request.command,
          request.cwd ? `目录：${request.cwd}` : null,
          request.reason ? `原因：${request.reason}` : null,
        ]
      : [
          "【文件变更】",
          request.cwd ? `目录：${request.cwd}` : null,
          request.grantRoot ? `授权根目录：${request.grantRoot}` : null,
          request.reason ? `原因：${request.reason}` : null,
        ];
  const optionLines = request.decisions.map(
    (decision, index) => `${index + 1}. ${approvalTextDecisionLabel(decision)}`,
  );
  const lacksStandaloneDecline =
    !request.decisions.includes("decline") && request.decisions.includes("cancel");
  return [
    request.kind === "command" ? "Codex 命令审批" : "Codex 文件变更审批",
    requestSection.filter((line): line is string => Boolean(line)).join("\n"),
    request.additionalPermissions
      ? formatApprovalMetadata("额外权限", request.additionalPermissions)
      : null,
    request.networkApprovalContext
      ? formatApprovalMetadata("网络审批上下文", request.networkApprovalContext)
      : null,
    request.proposedNetworkPolicyAmendments
      ? formatApprovalMetadata("建议网络规则", request.proposedNetworkPolicyAmendments)
      : null,
    ["【可选操作】", ...optionLines].join("\n"),
    lacksStandaloneDecline
      ? "说明：Codex 本次未提供 Deny；“拒绝并取消本轮”（Cancel turn）是本次请求提供的拒绝路径。"
      : null,
    ["【回复命令】", `/approve ${pending.replyCode} <选项编号>`].join("\n"),
    [
      "回复码只对本次请求有效；编号严格映射 Codex 原始 decision。",
      "/permit 仅用于 Codex 单独发出的网络或文件系统权限请求。",
    ].join("\n"),
  ].filter((section): section is string => Boolean(section)).join("\n\n");
}

function formatPermissionApprovalTextPrompt(
  pending: PendingPermissionApproval,
): string {
  return [
    "Codex 额外权限请求",
    [
      "【请求】",
      `• 目录：${pending.request.cwd}`,
      pending.request.reason ? `• 原因：${pending.request.reason}` : null,
    ].filter((line): line is string => Boolean(line)).join("\n"),
    formatApprovalMetadata("权限详情", pending.request.permissions),
    [
      "【可选操作】",
      `• 拒绝：/permit ${pending.replyCode} deny`,
      `• 仅当前 turn 授权：/permit ${pending.replyCode} turn`,
      `• 当前 session 授权：/permit ${pending.replyCode} session`,
    ].join("\n"),
    "只有发起当前 Codex 任务的用户可以处理；请求结束后回复码立即失效。",
  ].filter((section): section is string => Boolean(section)).join("\n\n");
}

function approvalTextDecisionLabel(decision: CodexApprovalDecision): string {
  if (decision === "accept") {
    return "仅本次允许（Approve）";
  }
  if (decision === "acceptForSession") {
    return "本会话内允许（Approve session）";
  }
  if (decision === "decline") {
    return "拒绝本次执行（Deny）";
  }
  if (decision === "cancel") {
    return "拒绝并取消本轮（Cancel turn）";
  }
  if ("acceptWithExecpolicyAmendment" in decision) {
    return "允许并保存命令规则（Approve rule）";
  }
  return "应用网络策略变更（Apply network policy）";
}

function formatApprovalMetadata(title: string, value: unknown): string {
  return [`【${title}】`, formatApprovalMetadataValue(value)].join("\n");
}

function formatApprovalMetadataValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "• 无";
    }
    return value.map((entry) => `• ${formatApprovalMetadataInline(entry)}`).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "• 无";
    }
    return entries
      .map(([key, entry]) => `• ${key}：${formatApprovalMetadataInline(entry)}`)
      .join("\n");
  }
  return `• ${formatApprovalMetadataInline(value)}`;
}

function formatApprovalMetadataInline(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatApprovalMetadataInline(entry)).join(" · ");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}=${formatApprovalMetadataInline(entry)}`)
      .join(" · ");
  }
  return String(value);
}

function hasStableSenderIdentity(sender: SenderIdentity): boolean {
  return hasStableIdentity(sender);
}

function sameStableSenderIdentity(left: SenderIdentity, right: SenderIdentity): boolean {
  return identitiesIntersect(left, right);
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
    "Codex 补充输入",
    [
      "【问题】",
      truncateInline(question.header, 80),
      truncateInline(question.question, 500),
    ].join("\n"),
    options.length > 0
      ? [
          "【可选值】",
          ...options.map((option) => `• ${truncateInline(option.label, 80)}`),
        ].join("\n")
      : null,
    ["【回复命令】", `/answer ${pending.replyCode} <内容>`].join("\n"),
    options.length > 0 && !question.isOther
      ? "当前问题只接受上面的可选项名称（需完全一致）。"
      : null,
    "回答内容不会在聊天中回显，也不会写入 Chat2Codex 持久化状态。",
  ].filter((section): section is string => Boolean(section)).join("\n\n");
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
