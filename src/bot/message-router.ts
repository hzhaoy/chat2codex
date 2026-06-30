import fs from "node:fs/promises";
import path from "node:path";

import {
  type CodexApprovalDecision,
  type CodexApprovalRequest,
  CodexRunner,
  type CodexProgressUpdate,
  type CodexRunInput,
  type CodexRunResult,
  type CodexThread,
  type CodexThreadListInput,
  type CodexThreadListResult,
} from "../agent/codex-runner.js";
import { BridgeConfig } from "../config/env.js";
import { JsonStateStore } from "../state/store.js";
import {
  BridgeState,
  type EventDiagnosticOutcome,
  type EventDiagnosticSnapshot,
  type ProjectSelection,
  type ThreadSelection,
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
  cardActionCard,
  cardActionToast,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardAction,
  resumeThreadCardAction,
  resolveApprovalCardAction,
  selectProjectCardAction,
  stopRunCardAction,
  type CardActionResponse,
  type IncomingCardAction,
} from "./lark-card-action.js";
import {
  buildApprovalCard,
  buildProjectListCard,
  buildSessionListCard,
  type ApprovalCardInput,
  type LarkInteractiveCard,
  type RunStatusCardInput,
} from "./lark-card.js";

const minProgressIntervalMs = 15_000;
const maxRememberedStatusCards = 100;

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
  sendText(chatId: string, text: string): Promise<void>;
  sendMarkdown?(chatId: string, markdown: string): Promise<void>;
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
}

export interface StatusCardHandle {
  messageId: string;
}

export interface CodexClient {
  run(input: CodexRunInput): Promise<CodexRunResult>;
  listThreads?(input?: CodexThreadListInput): Promise<CodexThreadListResult>;
  readThread?(threadId: string): Promise<CodexThread | null>;
}

interface PendingApproval {
  chatId: string;
  request: CodexApprovalRequest;
  resolve: (decision: CodexApprovalDecision) => void;
  handle: StatusCardHandle | null;
  decision?: CodexApprovalDecision;
  resolvedAt?: string;
  cancelledAt?: string;
}

export class MessageRouter {
  private state: BridgeState | null = null;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeApprovals = new Map<string, PendingApproval>();
  private readonly statusCardRuns = new Map<string, { chatId: string; prompt: string }>();
  private readonly codex: CodexClient;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: JsonStateStore,
    private readonly sender: ChatSender,
    private readonly logger: Logger,
    codex?: CodexClient,
  ) {
    this.codex = codex ?? new CodexRunner(config, logger);
  }

  async start(): Promise<void> {
    this.state = await this.store.load();
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
    state.diagnostics.lastEvent = snapshot;
    if (outcome === "dropped") {
      state.diagnostics.lastDroppedEvent = snapshot;
    }
    await this.store.save(state);
  }

  enqueue(message: IncomingTextMessage): Promise<void> {
    if (!message.attachments?.length && isStopCommand(message)) {
      return this.handleImmediateStop(message).catch((error) => {
        this.logger.error("Immediate stop command failed", error);
      });
    }

    return this.enqueueTask(message.chatId, () => this.handle(message));
  }

  async handleCardAction(action: IncomingCardAction): Promise<CardActionResponse | undefined> {
    if (!cardActionSenderAllowed(this.config.access.allowedUserIds, action.sender)) {
      this.logger.warn("Rejected unauthorized card action", {
        chatId: action.chatId,
        messageId: action.messageId,
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

    if (action.action === resolveApprovalCardAction) {
      return this.handleApprovalCardAction(action);
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
    const next = previous
      .catch((error) => {
        this.logger.warn("Previous chat task failed", error);
      })
      .then(task)
      .finally(() => {
        if (this.queues.get(chatId) === next) {
          this.queues.delete(chatId);
        }
      });

    this.queues.set(chatId, next);
    return next;
  }

  private async handle(message: IncomingTextMessage): Promise<void> {
    const state = this.requireState();
    if (state.processedMessageIds.includes(message.messageId)) {
      this.logger.debug("Skipping duplicate message", { messageId: message.messageId });
      return;
    }
    state.processedMessageIds.push(message.messageId);
    await this.store.save(state);

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
    if (!hasAttachments && (text === "/resume" || text.startsWith("/resume "))) {
      await this.resumeThread(message.chatId, message.chatType, text.slice("/resume".length).trim());
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

    await this.runCodex(message.chatId, prompt, message.chatType);
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

  private async runCodex(chatId: string, prompt: string, chatType?: ChatType): Promise<void> {
    const state = this.requireState();
    const session = this.ensureSession(chatId, state, chatType);
    if (!this.directoryAllowedForChat(session.cwd, session.chatType)) {
      await this.sender.sendText(chatId, this.formatDirectoryDenied(session.cwd));
      return;
    }
    await this.store.save(state);

    const startedAt = new Date().toISOString();
    const statusCard = await this.createStatusCard(chatId, {
      status: "running",
      detail: "收到，已开始处理。",
      cwd: session.cwd,
      prompt,
      startedAt,
      updatedAt: startedAt,
    });
    this.rememberStatusCardRun(statusCard, chatId, prompt);

    const controller = new AbortController();
    const reportProgress = this.createProgressReporter(
      chatId,
      controller.signal,
      statusCard,
      session.cwd,
      prompt,
      startedAt,
    );
    this.activeRuns.set(chatId, controller);
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
      });

      if (result.cancelled || controller.signal.aborted) {
        this.logger.info("Codex run stopped", { chatId });
        await this.updateStatusCard(statusCard, {
          status: "stopped",
          detail: "已停止当前 Codex 任务。",
          cwd: session.cwd,
          prompt,
          startedAt,
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      if (result.threadId) {
        session.threadId = result.threadId;
      }
      session.updatedAt = new Date().toISOString();
      await this.store.save(state);

      if (result.exitCode !== 0) {
        const failure = formatCodexFailure(result, session.cwd);
        await this.updateStatusCard(statusCard, {
          status: "failed",
          detail: "Codex 运行失败，错误摘要已发送。",
          cwd: session.cwd,
          prompt,
          startedAt,
          updatedAt: new Date().toISOString(),
        });
        for (const chunk of splitForChat(failure)) {
          await this.sender.sendText(chatId, chunk);
        }
        return;
      }

      await this.updateStatusCard(statusCard, {
        status: "success",
        detail: "Codex 已完成，正在发送最终回答。",
        cwd: session.cwd,
        prompt,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      for (const chunk of splitForChat(result.finalText)) {
        await this.sendMarkdown(chatId, chunk);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.info("Codex run stopped", { chatId });
        return;
      }
      this.logger.error("Codex run failed", error);
      let failure = formatCodexStartupFailure(error, this.config.codexBin, session.cwd);
      if (session.threadId && isThreadResumeReadFailure(error)) {
        const failedThreadId = session.threadId;
        delete session.threadId;
        session.updatedAt = new Date().toISOString();
        await this.store.save(state);
        failure = [
          failure,
          "",
          [
            `已清除当前 chat 中不可继续的会话选择：${failedThreadId}`,
            "可以发送 /sessions 重新选择可恢复会话，或直接重发消息在当前项目新建会话。",
          ].join("\n"),
        ].join("\n");
      }
      await this.updateStatusCard(statusCard, {
        status: "failed",
        detail: "Codex 启动失败，错误摘要已发送。",
        cwd: session.cwd,
        prompt,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      for (const chunk of splitForChat(failure)) {
        await this.sender.sendText(chatId, chunk);
      }
    } finally {
      await this.cancelApprovalsForChat(chatId);
      if (this.activeRuns.get(chatId) === controller) {
        this.activeRuns.delete(chatId);
      }
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

    if (!this.sender.downloadAttachment) {
      await this.sender.sendText(message.chatId, "当前聊天适配器暂不支持下载附件。");
      return null;
    }

    let downloaded: DownloadedAttachment[];
    try {
      downloaded = [];
      for (const attachment of attachments) {
        downloaded.push(await this.sender.downloadAttachment(message, attachment));
      }
    } catch (error) {
      this.logger.error("Attachment download failed", error);
      await this.sender.sendText(
        message.chatId,
        `附件下载失败：${formatError(error)}\n请确认机器人仍在该会话中，且附件大小不超过飞书/Lark下载限制。`,
      );
      return null;
    }

    const promptText = text || defaultAttachmentPrompt(downloaded);
    return [promptText, "", "本地附件路径：", ...downloaded.map(formatAttachmentLine)].join("\n");
  }

  private async handleImmediateStop(message: IncomingTextMessage): Promise<void> {
    const state = this.requireState();
    if (state.processedMessageIds.includes(message.messageId)) {
      this.logger.debug("Skipping duplicate message", { messageId: message.messageId });
      return;
    }
    state.processedMessageIds.push(message.messageId);
    await this.store.save(state);

    const decision = decideAccess(this.config.access, toAccessContext(message));
    if (!decision.allowed) {
      await this.rejectUnauthorized(message, decision);
      return;
    }

    await this.stopCodex(message.chatId);
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
          ...this.formatDiagnosticStatusLines(state),
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
        ...this.formatDiagnosticStatusLines(state),
      ].join("\n"),
    );
  }

  private formatDiagnosticStatusLines(state: BridgeState): string[] {
    return [
      `approval_policy: ${this.config.codexApprovalPolicy}`,
      `sandbox: ${this.config.codexSandbox}`,
      `attachment_dir: ${this.config.attachmentDownloadDir}`,
      `last_event: ${formatEventDiagnostic(state.diagnostics.lastEvent)}`,
      `last_dropped: ${formatEventDiagnostic(state.diagnostics.lastDroppedEvent)}`,
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
    session.lastThreads = threads.map(toThreadSelection);
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
    };
    await this.store.save(state);
  }

  private async stopCodex(
    chatId: string,
    options: { notifyChat?: boolean } = {},
  ): Promise<{ stopped: boolean; message: string }> {
    const controller = this.activeRuns.get(chatId);
    if (!controller || controller.signal.aborted) {
      const message = "当前 chat 没有正在运行的 Codex 任务。";
      if (options.notifyChat !== false) {
        await this.sender.sendText(chatId, message);
      }
      return { stopped: false, message };
    }

    controller.abort();
    const message = "已请求停止当前 chat 的 Codex 任务。";
    if (options.notifyChat !== false) {
      await this.sender.sendText(chatId, message);
    }
    return { stopped: true, message };
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
      this.runCodex(action.chatId, run.prompt, this.chatTypeForAction(action.chatId)),
    ).catch(
      (error) => {
        this.logger.error("Retry task failed", error);
      },
    );
    return cardActionToast("success", "已把这次任务重新加入当前 chat 的 Codex 队列。");
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
    const decision = pending.request.decisions[action.decisionIndex];
    if (!decision) {
      return cardActionToast("warning", "无法处理审批：审批选项已失效。");
    }

    this.activeApprovals.delete(action.approvalId);
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
      const pending: PendingApproval = {
        chatId,
        request,
        resolve,
        handle: null,
      };
      this.activeApprovals.set(request.id, pending);
      const cancel = () => {
        if (this.activeApprovals.get(request.id) !== pending) {
          return;
        }
        this.activeApprovals.delete(request.id);
        pending.cancelledAt = new Date().toISOString();
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
      approval.cancelledAt = new Date().toISOString();
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
  ): (update: CodexProgressUpdate) => Promise<void> {
    let lastSentAt = 0;
    let cardUpdatesFailed = false;
    return async (update) => {
      if (signal.aborted) {
        return;
      }
      const now = Date.now();
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
    await this.sender.sendText(
      message.chatId,
      [
        "Chat2Codex 当前会话信息：",
        `chat_id: ${message.chatId}`,
        `chat_type: ${message.chatType}`,
        `sender.open_id: ${message.sender.openId ?? "(unknown)"}`,
        `sender.user_id: ${message.sender.userId ?? "(unknown)"}`,
        `sender.union_id: ${message.sender.unionId ?? "(unknown)"}`,
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

    const nextCwd = path.resolve(requestedPath);
    const stat = await fs.stat(nextCwd).catch(() => null);
    if (!stat?.isDirectory()) {
      await this.sender.sendText(chatId, `目录不存在：${nextCwd}`);
      return;
    }
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

  private requireState(): BridgeState {
    if (!this.state) {
      throw new Error("MessageRouter.start() must be called before handling messages.");
    }
    return this.state;
  }
}

interface ProjectAggregate extends ProjectSelection {
  sortUpdatedMs: number;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function toThreadSelection(thread: CodexThread): ThreadSelection {
  return {
    threadId: thread.id,
    cwd: thread.cwd,
    title: threadTitle(thread),
    preview: cleanText(thread.preview),
    updatedAt: thread.updatedAt ? formatCodexTimestamp(thread.updatedAt) : undefined,
    resumable: thread.resumable,
    unavailableReason: thread.unavailableReason,
  };
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

export function formatCodexStartupFailure(error: unknown, codexBin: string, cwd: string): string {
  const code = getErrorCode(error);
  const hint = inferStartupFailureHint(code, codexBin);
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

function inferStartupFailureHint(code: string | null, codexBin: string): string | null {
  if (code === "ENOENT") {
    return `找不到 Codex 命令 ${codexBin}；请设置 CODEX_BIN 为绝对路径，后台服务不会加载你的交互式 shell PATH。`;
  }
  if (code === "EACCES") {
    return `Codex 命令 ${codexBin} 不可执行；请检查文件权限或改用可执行文件的绝对路径。`;
  }
  return null;
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

function cardActionSenderAllowed(
  allowedUserIds: string[],
  sender: SenderIdentity,
): boolean {
  return allowedUserIds.length === 0 || senderMatchesAllowedUser(sender, allowedUserIds);
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
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
