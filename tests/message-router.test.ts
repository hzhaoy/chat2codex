import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexMcpElicitationRequest,
  CodexMcpElicitationResponse,
  CodexPermissionApprovalDecision,
  CodexPermissionApprovalRequest,
  CodexRunControl,
  CodexProgressUpdate,
  CodexRunInput,
  CodexRunResult,
  CodexUserInputRequest,
  CodexUserInputResponse,
  CodexThread,
  CodexThreadItem,
  CodexThreadListInput,
  CodexThreadListResult,
  CodexThreadSearchInput,
  CodexThreadSearchResult,
  CodexThreadSearchResultItem,
  CodexThreadTurn,
  CodexThreadTurnItemListInput,
  CodexThreadTurnItemListResult,
  CodexThreadTurnListInput,
  CodexThreadTurnListResult,
} from "../src/agent/codex-runner.js";
import type {
  ApprovalCardInput,
  LarkInteractiveCard,
  McpElicitationCardInput,
  PermissionApprovalCardInput,
  RunStatusCardInput,
  UserInputCardInput,
} from "../src/bot/lark-card.js";
import { renderFeishuInteractiveView } from "../src/adapters/feishu/adapter.js";
import { renderLarkActionResponse } from "../src/adapters/feishu/action.js";
import type { ActionResponse } from "../src/core/actions.js";
import type {
  MessageReaction,
  MessageReactionHandle,
} from "../src/core/contracts.js";
import type { ChatView } from "../src/core/view-models.js";
import {
  MessageRouter,
  type ChatSender,
  type CodexClient,
  type DownloadedAttachment,
  type IncomingAttachment,
  type IncomingTextMessage,
  type StatusCardHandle,
} from "../src/bot/message-router.js";
import { loadConfig } from "../src/config/env.js";
import { JsonStateStore } from "../src/state/store.js";
import type { Logger } from "../src/util/logger.js";

type TestBridgeConfig = ReturnType<typeof loadConfig>;

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class ToggleFailingStateStore extends JsonStateStore {
  failSaves = false;

  override async save(state: Parameters<JsonStateStore["save"]>[0]): Promise<void> {
    if (this.failSaves) {
      throw new Error("simulated state save failure");
    }
    await super.save(state);
  }
}

class CollectingSender implements ChatSender {
  readonly messages: Array<{ chatId: string; text: string; kind: "text" | "markdown" }> = [];
  readonly reactions: Array<{
    operation: "add" | "remove";
    chatId: string;
    messageId: string;
    reaction: MessageReaction;
  }> = [];

  async sendText(chatId: string, text: string): Promise<void> {
    this.messages.push({ chatId, text, kind: "text" });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    this.messages.push({ chatId, text: markdown, kind: "markdown" });
  }

  async addReaction(
    chatId: string,
    messageId: string,
    reaction: MessageReaction,
  ): Promise<MessageReactionHandle> {
    this.reactions.push({ operation: "add", chatId, messageId, reaction });
    return {
      adapterId: "test:default",
      conversationId: chatId,
      messageId,
      reaction,
      reactionId: `reaction-${this.reactions.length}`,
    };
  }

  async removeReaction(handle: MessageReactionHandle): Promise<void> {
    this.reactions.push({
      operation: "remove",
      chatId: handle.conversationId,
      messageId: handle.messageId,
      reaction: handle.reaction,
    });
  }
}

class FailingDeliverySender implements ChatSender {
  async sendText(): Promise<void> {
    throw new Error("simulated delivery failure");
  }

  async sendMarkdown(): Promise<void> {
    throw new Error("simulated delivery failure");
  }
}

class FinalFailingSender extends CollectingSender {
  readonly idempotencyKeys: string[] = [];

  override async sendMarkdown(
    _chatId: string,
    _markdown: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
    }
    throw new Error("simulated final delivery failure");
  }
}

class TransientFinalDeliverySender extends CollectingSender {
  readonly idempotencyKeys: string[] = [];
  attempts = 0;

  override async sendMarkdown(
    chatId: string,
    markdown: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    this.attempts += 1;
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
    }
    if (this.attempts === 1) {
      throw new Error("simulated transient final delivery failure");
    }
    await super.sendMarkdown(chatId, markdown);
  }
}

class PersistentDurableDeliveryFailingSender extends CollectingSender {
  readonly idempotencyKeys: string[] = [];

  override async sendText(
    chatId: string,
    text: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
      throw new Error("simulated persistent durable delivery failure");
    }
    await super.sendText(chatId, text);
  }

  override async sendMarkdown(
    chatId: string,
    markdown: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
      throw new Error("simulated persistent durable delivery failure");
    }
    await super.sendMarkdown(chatId, markdown);
  }
}

class ToggleControlDeliverySender extends CollectingSender {
  failControl = false;
  readonly idempotencyKeys: string[] = [];

  override async sendText(
    chatId: string,
    text: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
      throw new Error("simulated persistent durable delivery failure");
    }
    if (this.failControl) {
      throw new Error("simulated transient control delivery failure");
    }
    await super.sendText(chatId, text);
  }
}

class FailingNextMarkdownSender extends CollectingSender {
  failNextMarkdown = false;

  override async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    if (this.failNextMarkdown) {
      this.failNextMarkdown = false;
      throw new Error("simulated fork result delivery failure");
    }
    await super.sendMarkdown(chatId, markdown);
  }
}

class IdempotencyCollectingSender extends CollectingSender {
  readonly idempotencyKeys: string[] = [];

  override async sendMarkdown(
    chatId: string,
    markdown: string,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    if (options?.idempotencyKey) {
      this.idempotencyKeys.push(options.idempotencyKey);
    }
    await super.sendMarkdown(chatId, markdown);
  }
}

class CardCollectingSender extends CollectingSender {
  readonly interactiveCards: Array<{
    chatId: string;
    card: LarkInteractiveCard;
  }> = [];
  readonly interactiveCardUpdates: Array<{
    messageId: string;
    card: LarkInteractiveCard;
  }> = [];
  readonly cards: Array<{
    chatId: string;
    input: RunStatusCardInput;
    handle: StatusCardHandle;
  }> = [];
  readonly cardUpdates: Array<{ handle: StatusCardHandle; input: RunStatusCardInput }> = [];
  readonly approvalCards: Array<{
    chatId: string;
    input: ApprovalCardInput;
    handle: StatusCardHandle;
  }> = [];
  readonly approvalCardUpdates: Array<{
    handle: StatusCardHandle;
    input: ApprovalCardInput;
  }> = [];
  readonly userInputCards: Array<{
    chatId: string;
    input: UserInputCardInput;
    handle: StatusCardHandle;
  }> = [];
  readonly userInputCardUpdates: Array<{
    handle: StatusCardHandle;
    input: UserInputCardInput;
  }> = [];
  readonly permissionApprovalCards: Array<{
    chatId: string;
    input: PermissionApprovalCardInput;
    handle: StatusCardHandle;
  }> = [];
  readonly permissionApprovalCardUpdates: Array<{
    handle: StatusCardHandle;
    input: PermissionApprovalCardInput;
  }> = [];
  readonly mcpElicitationCards: Array<{
    chatId: string;
    input: McpElicitationCardInput;
    handle: StatusCardHandle;
  }> = [];
  readonly mcpElicitationCardUpdates: Array<{
    handle: StatusCardHandle;
    input: McpElicitationCardInput;
  }> = [];

  async createStatusCard(chatId: string, input: RunStatusCardInput): Promise<StatusCardHandle> {
    const handle = { messageId: `om_${this.cards.length + 1}` };
    this.cards.push({ chatId, input, handle });
    return handle;
  }

  async sendInteractiveCard(chatId: string, card: LarkInteractiveCard): Promise<void> {
    this.interactiveCards.push({ chatId, card });
  }

  async sendView(chatId: string, view: ChatView): Promise<void> {
    if (view.kind === "text") {
      await this.sendText(chatId, view.text);
      return;
    }
    if (view.kind === "markdown") {
      await this.sendMarkdown(chatId, view.markdown);
      return;
    }
    await this.sendInteractiveCard(chatId, renderFeishuInteractiveView(view));
  }

  async updateInteractiveCard(messageId: string, card: LarkInteractiveCard): Promise<void> {
    this.interactiveCardUpdates.push({ messageId, card });
  }

  async updateStatusCard(handle: StatusCardHandle, input: RunStatusCardInput): Promise<void> {
    this.cardUpdates.push({ handle, input });
  }

  async createApprovalCard(chatId: string, input: ApprovalCardInput): Promise<StatusCardHandle> {
    const handle = { messageId: `oma_${this.approvalCards.length + 1}` };
    this.approvalCards.push({ chatId, input, handle });
    return handle;
  }

  async updateApprovalCard(handle: StatusCardHandle, input: ApprovalCardInput): Promise<void> {
    this.approvalCardUpdates.push({ handle, input });
  }

  async createUserInputCard(
    chatId: string,
    input: UserInputCardInput,
  ): Promise<StatusCardHandle> {
    const handle = { messageId: `omu_${this.userInputCards.length + 1}` };
    this.userInputCards.push({ chatId, input, handle });
    return handle;
  }

  async updateUserInputCard(
    handle: StatusCardHandle,
    input: UserInputCardInput,
  ): Promise<void> {
    this.userInputCardUpdates.push({ handle, input });
  }

  async createPermissionApprovalCard(
    chatId: string,
    input: PermissionApprovalCardInput,
  ): Promise<StatusCardHandle> {
    const handle = { messageId: `omp_${this.permissionApprovalCards.length + 1}` };
    this.permissionApprovalCards.push({ chatId, input, handle });
    return handle;
  }

  async updatePermissionApprovalCard(
    handle: StatusCardHandle,
    input: PermissionApprovalCardInput,
  ): Promise<void> {
    this.permissionApprovalCardUpdates.push({ handle, input });
  }

  async createMcpElicitationCard(
    chatId: string,
    input: McpElicitationCardInput,
  ): Promise<StatusCardHandle> {
    const handle = { messageId: `omm_${this.mcpElicitationCards.length + 1}` };
    this.mcpElicitationCards.push({ chatId, input, handle });
    return handle;
  }

  async updateMcpElicitationCard(
    handle: StatusCardHandle,
    input: McpElicitationCardInput,
  ): Promise<void> {
    this.mcpElicitationCardUpdates.push({ handle, input });
  }
}

class FailingUserInputCardSender extends CardCollectingSender {
  readonly userInputCardAttempts: Array<{ chatId: string; input: UserInputCardInput }> = [];

  override async createUserInputCard(
    chatId: string,
    input: UserInputCardInput,
  ): Promise<StatusCardHandle> {
    this.userInputCardAttempts.push({ chatId, input });
    throw new Error("simulated user-input card failure");
  }
}

class FailingUserInputPresentationSender extends FailingUserInputCardSender {
  override async sendText(): Promise<void> {
    throw new Error("simulated user-input fallback failure");
  }
}

class FailingPermissionApprovalCardSender extends CardCollectingSender {
  readonly permissionApprovalCardAttempts: Array<{
    chatId: string;
    input: PermissionApprovalCardInput;
  }> = [];

  override async createPermissionApprovalCard(
    chatId: string,
    input: PermissionApprovalCardInput,
  ): Promise<StatusCardHandle> {
    this.permissionApprovalCardAttempts.push({ chatId, input });
    throw new Error("simulated permission-approval card failure");
  }
}

class DelayedApprovalCardSender extends CardCollectingSender {
  readonly createStarted = deferred<void>();
  readonly releaseCreate = deferred<void>();

  override async createApprovalCard(
    chatId: string,
    input: ApprovalCardInput,
  ): Promise<StatusCardHandle> {
    this.createStarted.resolve();
    await this.releaseCreate.promise;
    return super.createApprovalCard(chatId, input);
  }
}

class DelayedReactionSender extends CardCollectingSender {
  readonly createStarted = deferred<void>();
  readonly releaseCreate = deferred<void>();

  override async addReaction(
    chatId: string,
    messageId: string,
    reaction: MessageReaction,
  ): Promise<MessageReactionHandle> {
    this.createStarted.resolve();
    await this.releaseCreate.promise;
    return super.addReaction(chatId, messageId, reaction);
  }
}

class DelayedTextSender extends CollectingSender {
  readonly sendStarted = deferred<void>();
  readonly releaseSend = deferred<void>();

  override async sendText(chatId: string, text: string): Promise<void> {
    this.sendStarted.resolve();
    await this.releaseSend.promise;
    await super.sendText(chatId, text);
  }
}

class AttachmentCollectingSender extends CollectingSender {
  readonly downloads: Array<{ messageId: string; attachment: IncomingAttachment }> = [];
  readonly downloadedPaths: string[] = [];
  readonly contentsByKey = new Map<string, string>();
  private attachmentRoot = "/tmp/chat2codex-downloads";

  setAttachmentRoot(attachmentRoot: string): void {
    this.attachmentRoot = attachmentRoot;
  }

  async downloadAttachment(
    message: IncomingTextMessage,
    attachment: IncomingAttachment,
  ): Promise<DownloadedAttachment> {
    this.downloads.push({ messageId: message.messageId, attachment });
    const filePath = path.join(
      this.attachmentRoot,
      message.messageId,
      attachment.name ?? attachment.key,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, this.contentsByKey.get(attachment.key) ?? "attachment");
    this.downloadedPaths.push(filePath);
    return {
      kind: attachment.kind,
      name: attachment.name,
      path: filePath,
    };
  }
}

class FakeCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  constructor(private readonly progressUpdates: CodexProgressUpdate[] = []) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    for (const update of this.progressUpdates) {
      await input.onProgress?.(update);
    }
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }
}

class SessionAwareCodex extends FakeCodex {
  readonly invalidations: Array<{ chatId: string; reason?: string }> = [];
  disposeCount = 0;

  override async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const threadId = input.threadId ?? "thread_session";
    await input.onThreadBound?.(threadId);
    return {
      threadId,
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }

  async invalidateChatSession(chatId: string, reason?: string): Promise<void> {
    this.invalidations.push({ chatId, reason });
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class EarlyBindingCodex extends SessionAwareCodex {
  readonly threadBound = deferred<void>();
  readonly continueTurn = deferred<void>();
  turnContinued = false;

  override async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const threadId = input.threadId ?? "thread_early_bound";
    await input.onThreadBound?.(threadId);
    this.threadBound.resolve();
    await Promise.race([
      this.continueTurn.promise,
      new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true })),
    ]);
    this.turnContinued = true;
    return {
      threadId,
      finalText: input.signal?.aborted ? "" : "done",
      stderr: "",
      exitCode: input.signal?.aborted ? null : 0,
      cancelled: input.signal?.aborted,
    };
  }

  override async dispose(): Promise<void> {
    this.continueTurn.resolve();
    await super.dispose();
  }
}

class ListingCodex extends FakeCodex {
  readonly listInputs: CodexThreadListInput[] = [];
  readonly readIds: string[] = [];
  readonly searchInputs: CodexThreadSearchInput[] = [];
  readonly turnListInputs: CodexThreadTurnListInput[] = [];
  readonly turnItemInputs: CodexThreadTurnItemListInput[] = [];
  readonly forkInputs: Array<{ threadId: string; cwd?: string; lastTurnId?: string }> = [];
  readonly compactIds: string[] = [];
  readonly archiveIds: string[] = [];
  readonly unarchiveIds: string[] = [];
  private readonly archivedThreadIds: Set<string>;

  constructor(
    private readonly threads: CodexThread[],
    private readonly extra: {
      searchResults?: CodexThreadSearchResultItem[];
      turns?: CodexThreadTurn[];
      itemsByTurn?: Record<string, CodexThreadItem[]>;
      forkedThread?: CodexThread;
      archivedThreads?: CodexThread[];
    } = {},
  ) {
    super();
    this.archivedThreadIds = new Set(extra.archivedThreads?.map((thread) => thread.id));
    for (const thread of extra.archivedThreads ?? []) {
      if (!this.threads.some((candidate) => candidate.id === thread.id)) {
        this.threads.push(thread);
      }
    }
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadListResult> {
    this.listInputs.push(input);
    let threads = this.threads.filter((thread) =>
      input.archived === true
        ? this.archivedThreadIds.has(thread.id)
        : !this.archivedThreadIds.has(thread.id),
    );
    if (typeof input.cwd === "string") {
      threads = threads.filter((thread) => thread.cwd === input.cwd);
    } else if (Array.isArray(input.cwd)) {
      threads = threads.filter((thread) => input.cwd?.includes(thread.cwd));
    }
    threads = [...threads].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return {
      threads: threads.slice(0, input.limit ?? threads.length),
    };
  }

  async readThread(threadId: string): Promise<CodexThread | null> {
    this.readIds.push(threadId);
    return this.threads.find((thread) => thread.id === threadId) ?? null;
  }

  async searchThreads(input: CodexThreadSearchInput): Promise<CodexThreadSearchResult> {
    this.searchInputs.push(input);
    const results = this.extra.searchResults ?? this.threads.map((thread) => ({
      thread,
      snippet: thread.preview ?? thread.name ?? thread.cwd,
    }));
    const query = input.searchTerm.toLowerCase();
    const filtered = results.filter((result) =>
      [
        result.thread.name,
        result.thread.preview,
        result.thread.cwd,
        result.thread.id,
        result.snippet,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
    return {
      results: filtered.slice(0, input.limit ?? filtered.length),
    };
  }

  async listThreadTurns(input: CodexThreadTurnListInput): Promise<CodexThreadTurnListResult> {
    this.turnListInputs.push(input);
    return {
      turns: (this.extra.turns ?? []).slice(0, input.limit ?? this.extra.turns?.length ?? 0),
    };
  }

  async listTurnItems(input: CodexThreadTurnItemListInput): Promise<CodexThreadTurnItemListResult> {
    this.turnItemInputs.push(input);
    return {
      items: this.extra.itemsByTurn?.[input.turnId] ?? [],
    };
  }

  async forkThread(input: {
    threadId: string;
    cwd?: string;
    lastTurnId?: string;
  }): Promise<CodexThread> {
    this.forkInputs.push(input);
    const source = this.threads.find((thread) => thread.id === input.threadId);
    return (
      this.extra.forkedThread ?? {
        id: `fork_${input.threadId}`,
        cwd: input.cwd ?? source?.cwd ?? "/repo/forked",
        name: `Fork of ${input.threadId}`,
        updatedAt: 5_000,
      }
    );
  }

  async compactThread(threadId: string): Promise<void> {
    this.compactIds.push(threadId);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archiveIds.push(threadId);
    this.archivedThreadIds.add(threadId);
  }

  async unarchiveThread(threadId: string): Promise<CodexThread> {
    this.unarchiveIds.push(threadId);
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new Error("missing archived thread");
    }
    this.archivedThreadIds.delete(threadId);
    return thread;
  }
}

class LifecycleCodex extends ListingCodex {
  readonly invalidations: Array<{ chatId: string; reason?: string }> = [];

  async invalidateChatSession(chatId: string, reason?: string): Promise<void> {
    this.invalidations.push({ chatId, reason });
  }
}

class ResumeReadFailingCodex extends ListingCodex {
  override async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    if (this.runs.length === 1) {
      throw new Error(
        "failed to read thread: thread-store internal error: rollout does not start with session metadata",
      );
    }
    return {
      threadId: "thread_after_clear",
      finalText: "fresh done",
      stderr: "",
      exitCode: 0,
    };
  }
}

class SequencedCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  constructor(private readonly results: CodexRunResult[]) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    return (
      this.results.shift() ?? {
        threadId: "thread_test",
        finalText: "done",
        stderr: "",
        exitCode: 0,
      }
    );
  }
}

class BlockingCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  abortCount = 0;

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    return new Promise((resolve) => {
      const finishCancelled = () => {
        this.abortCount += 1;
        resolve({
          threadId: "thread_test",
          finalText: "",
          stderr: "",
          exitCode: null,
          cancelled: true,
        });
      };

      if (input.signal?.aborted) {
        finishCancelled();
        return;
      }
      input.signal?.addEventListener("abort", finishCancelled, { once: true });
    });
  }
}

class DisposableBlockingCodex extends BlockingCodex {
  disposeCount = 0;

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class ControlledCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly completions: Array<ReturnType<typeof deferred<CodexRunResult>>> = [];

  run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const completion = deferred<CodexRunResult>();
    this.completions.push(completion);
    return completion.promise;
  }

  complete(index: number, threadId: string): void {
    this.completions[index]?.resolve({
      threadId,
      finalText: "done",
      stderr: "",
      exitCode: 0,
    });
  }
}

class ControlledListingCodex extends ControlledCodex {
  constructor(readonly threads: CodexThread[]) {
    super();
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadListResult> {
    const threads = [...this.threads].sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
    return { threads: threads.slice(0, input.limit ?? threads.length) };
  }
}

class FirstBlockingThenDoneCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  abortCount = 0;

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    if (this.runs.length > 1) {
      return {
        threadId: "thread_after_queue",
        finalText: "queued done",
        stderr: "",
        exitCode: 0,
      };
    }
    return new Promise((resolve) => {
      const finishCancelled = () => {
        this.abortCount += 1;
        resolve({
          threadId: "thread_test",
          finalText: "",
          stderr: "",
          exitCode: null,
          cancelled: true,
        });
      };

      if (input.signal?.aborted) {
        finishCancelled();
        return;
      }
      input.signal?.addEventListener("abort", finishCancelled, { once: true });
    });
  }
}

class ApprovalCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly decisions: Array<{ prompt: string; decision: CodexApprovalDecision | undefined }> = [];
  decision: CodexApprovalDecision | undefined;

  constructor(private readonly request: CodexApprovalRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const decision = await input.onApprovalRequest?.(this.request);
    this.decision = decision;
    this.decisions.push({ prompt: input.prompt, decision });
    return {
      threadId: "thread_test",
      finalText: `decision=${formatDecisionForTest(decision)}`,
      stderr: "",
      exitCode: 0,
    };
  }
}

class UserInputCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly requestStarted = deferred<void>();
  response: CodexUserInputResponse | undefined;
  private requestController: AbortController | undefined;

  constructor(private readonly request: CodexUserInputRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    this.requestController = new AbortController();
    const abortRequest = () => this.requestController?.abort();
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    this.requestStarted.resolve();
    try {
      this.response = await input.onUserInputRequest?.(this.request, {
        signal: this.requestController.signal,
      });
    } finally {
      input.signal?.removeEventListener("abort", abortRequest);
    }
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }

  abortRequest(): void {
    this.requestController?.abort();
  }
}

class PermissionApprovalCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly requestStarted = deferred<void>();
  decision: CodexPermissionApprovalDecision | undefined;
  private requestController: AbortController | undefined;

  constructor(private readonly request: CodexPermissionApprovalRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    this.requestController = new AbortController();
    const abortRequest = () => this.requestController?.abort();
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    this.requestStarted.resolve();
    try {
      this.decision = await input.onPermissionApprovalRequest?.(this.request, {
        signal: this.requestController.signal,
      });
    } finally {
      input.signal?.removeEventListener("abort", abortRequest);
    }
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }

  abortRequest(): void {
    this.requestController?.abort();
  }
}

class McpElicitationCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly requestStarted = deferred<void>();
  response: CodexMcpElicitationResponse | undefined;
  private requestController: AbortController | undefined;

  constructor(private readonly request: CodexMcpElicitationRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    this.requestController = new AbortController();
    const abortRequest = () => this.requestController?.abort();
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    this.requestStarted.resolve();
    try {
      this.response = await input.onMcpElicitationRequest?.(this.request, {
        signal: this.requestController.signal,
      });
    } finally {
      input.signal?.removeEventListener("abort", abortRequest);
    }
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }

  abortRequest(): void {
    this.requestController?.abort();
  }
}

class FireAndForgetUserInputCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  constructor(private readonly request: CodexUserInputRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const controller = new AbortController();
    void input.onUserInputRequest?.(this.request, { signal: controller.signal });
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }
}

class CompletingBeforeApprovalCardCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  constructor(
    private readonly request: CodexApprovalRequest,
    private readonly waitForApprovalCardCreate: () => Promise<void>,
  ) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    void input.onApprovalRequest?.(this.request);
    await this.waitForApprovalCardCreate();
    return {
      threadId: "thread_test",
      finalText: "done",
      stderr: "",
      exitCode: 0,
    };
  }
}

class FailingCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    return {
      threadId: "thread_test",
      finalText: "",
      stderr: "fatal: not a git repository",
      exitCode: 2,
    };
  }
}

class RichResultCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    return {
      threadId: "thread_result",
      finalText: "done",
      stderr: "",
      exitCode: 0,
      summary: {
        durationMs: 1234,
        tokenUsage: {
          last: {
            cachedInputTokens: 200,
            inputTokens: 1_000,
            outputTokens: 300,
            reasoningOutputTokens: 100,
            totalTokens: 1_300,
          },
          total: {
            cachedInputTokens: 2_000,
            inputTokens: 10_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 500,
            totalTokens: 12_000,
          },
          modelContextWindow: 120_000,
        },
        diff: "diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n@@\n+hello\n",
        diffStat: "1 file(s), +1 -0",
        changedFiles: [path.join(input.cwd, "src/app.ts"), "src/app.ts"],
        fileChangeCount: 1,
        commands: [
          {
            command: "bun test",
            cwd: "/repo",
            status: "completed",
            exitCode: 0,
            durationMs: 42,
            outputPreview: "1 pass",
          },
        ],
      },
    };
  }
}

class SteerableCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly steers: string[] = [];

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const control: CodexRunControl = {
      threadId: "thread_steer",
      turnId: "turn_steer",
      steer: async (text: string) => {
        this.steers.push(text);
      },
    };
    input.onRunControl?.(control);
    return new Promise((resolve) => {
      const finishCancelled = () => {
        resolve({
          threadId: "thread_steer",
          finalText: "",
          stderr: "",
          exitCode: null,
          cancelled: true,
        });
      };
      if (input.signal?.aborted) {
        finishCancelled();
        return;
      }
      input.signal?.addEventListener("abort", finishCancelled, { once: true });
    });
  }
}

class FailingSteerCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    input.onRunControl?.({
      threadId: "thread_steer",
      turnId: "turn_steer",
      steer: async () => {
        throw new Error("no active turn to steer");
      },
    });
    return new Promise((resolve) => {
      const finishCancelled = () => {
        resolve({
          threadId: "thread_steer",
          finalText: "",
          stderr: "",
          exitCode: null,
          cancelled: true,
        });
      };
      if (input.signal?.aborted) {
        finishCancelled();
        return;
      }
      input.signal?.addEventListener("abort", finishCancelled, { once: true });
    });
  }
}

class DelayedSteerableCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];
  readonly steers: string[] = [];

  constructor(private readonly controlDelayMs = 20) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    setTimeout(() => {
      input.onRunControl?.({
        threadId: "thread_steer",
        turnId: "turn_steer",
        steer: async (text: string) => {
          this.steers.push(text);
        },
      });
    }, this.controlDelayMs);
    return new Promise((resolve) => {
      const finishCancelled = () => {
        resolve({
          threadId: "thread_steer",
          finalText: "",
          stderr: "",
          exitCode: null,
          cancelled: true,
        });
      };
      if (input.signal?.aborted) {
        finishCancelled();
        return;
      }
      input.signal?.addEventListener("abort", finishCancelled, { once: true });
    });
  }
}

class ThrowingCodex implements CodexClient {
  readonly runs: CodexRunInput[] = [];

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    const error = new Error("spawn codex ENOENT");
    Object.assign(error, { code: "ENOENT" });
    throw error;
  }
}

describe("MessageRouter access control", () => {
  test("routes /plan as a single Plan turn and restores Default mode afterward", async () => {
    await withRouter({}, async ({ router, codex, sender }) => {
      await router.enqueue({
        messageId: "m_plan_turn",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/plan ask one question",
      });
      await router.enqueue({
        messageId: "m_default_turn",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue normally",
      });
      await router.enqueue({
        messageId: "m_plan_usage",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/plan",
      });

      expect(codex.runs.map(({ prompt, collaborationMode }) => ({ prompt, collaborationMode }))).toEqual([
        { prompt: "ask one question", collaborationMode: "plan" },
        { prompt: "continue normally", collaborationMode: "default" },
      ]);
      expect(sender.messages.at(-1)?.text).toBe("用法：/plan <任务>（以 Plan 模式执行这一轮）");
    });
  });

  test("persists accepted events without waiting for a long Codex run", async () => {
    const codex = new BlockingCodex();
    await withRouterAndCodex({}, codex, async ({ router, config }) => {
      const accepted = {
        messageId: "m_durable",
        chatId: "oc_chat",
        chatType: "direct" as const,
        sender: { openId: "ou_user" },
        text: "long task",
      };

      await router.accept(accepted);
      await waitFor(() => codex.runs.length === 1);

      const store = new JsonStateStore(config.bridgeStatePath);
      const pending = await store.load();
      expect(pending.pendingMessages.m_durable?.text).toBe("long task");
      expect(pending.processedMessageIds).not.toContain("m_durable");

      await router.enqueue({
        messageId: "m_stop_durable",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await waitForState(store, (state) => state.processedMessageIds.includes("m_durable"));

      const completed = await store.load();
      expect(completed.pendingMessages.m_durable).toBeUndefined();
      expect(completed.processedMessageIds).toContain("m_durable");
    });
  });

  test("graceful disposal interrupts only running jobs and preserves queued inbox work", async () => {
    const codex = new DisposableBlockingCodex();
    await withRouterAndCodex({}, codex, async ({ router, config }) => {
      const store = new JsonStateStore(config.bridgeStatePath);
      await router.accept({
        messageId: "m_shutdown_running",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "running during shutdown",
      });
      await waitFor(() => codex.runs.length === 1);
      await waitForState(store, (state) => state.jobs.m_shutdown_running?.status === "running");

      await router.accept({
        messageId: "m_shutdown_queued",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "queued for restart",
      });
      await waitForState(store, (state) => state.jobs.m_shutdown_queued?.status === "queued");

      await router.dispose();
      await router.dispose();

      const stopped = await store.load();
      expect(codex.disposeCount).toBe(1);
      expect(stopped.jobs.m_shutdown_running).toMatchObject({
        status: "interrupted",
        interruptionReason: "bridge_shutdown",
      });
      expect(stopped.pendingMessages.m_shutdown_running).toBeUndefined();
      expect(stopped.processedMessageIds).toContain("m_shutdown_running");
      expect(stopped.jobs.m_shutdown_queued?.status).toBe("queued");
      expect(stopped.pendingMessages.m_shutdown_queued?.text).toBe("queued for restart");
      expect(stopped.processedMessageIds).not.toContain("m_shutdown_queued");

      await router.recordEventDiagnostic("routed", {
        chatId: "oc_chat",
        mentionCount: 0,
        startsWithMention: false,
        attachmentCount: 0,
        textLength: 4,
        botIdentityResolved: true,
      });
      expect((await store.load()).diagnostics).toEqual(stopped.diagnostics);
    });
  });

  test("still disposes Codex children when shutdown state persistence fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-dispose-failure-"));
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: tempDir,
      BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
      ALLOWED_USER_IDS: "ou_user",
    });
    const store = new ToggleFailingStateStore(config.bridgeStatePath);
    const codex = new SessionAwareCodex();
    const router = new MessageRouter(config, store, new CollectingSender(), silentLogger, codex);
    try {
      await router.start();
      store.failSaves = true;
      await expect(router.dispose()).rejects.toThrow("simulated state save failure");
      expect(codex.disposeCount).toBe(1);
    } finally {
      store.failSaves = false;
      await router.dispose().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serializes Codex runs from different chats that target the same workspace", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex({}, codex, async ({ router }) => {
      const first = router.enqueue({
        messageId: "m_workspace_1",
        chatId: "oc_chat_1",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "first task",
      });
      const second = router.enqueue({
        messageId: "m_workspace_2",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "second task",
      });

      await waitFor(() => codex.runs.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(codex.runs).toHaveLength(1);

      codex.complete(0, "thread_workspace_1");
      await first;
      await waitFor(() => codex.runs.length === 2);

      codex.complete(1, "thread_workspace_2");
      await second;
      expect(codex.runs.map((run) => run.prompt)).toEqual(["first task", "second task"]);
    });
  });

  test("lets stop cancel a task waiting for the workspace lock", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender, config }) => {
      const first = router.enqueue({
        messageId: "m_workspace_blocker",
        chatId: "oc_chat_1",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "block the workspace",
      });
      await router.accept({
        messageId: "m_workspace_waiting",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "should be cancelled",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m_workspace_status",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/status",
      });
      expect(sender.messages.at(-1)?.text).toContain("• 队列：1");
      expect(sender.messages.at(-1)?.text).toContain("• 当前任务：等待执行");

      await router.enqueue({
        messageId: "m_workspace_stop",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      expect(sender.messages.at(-1)?.text).toBe("已取消当前 chat 排队中的 Codex 任务。");

      const store = new JsonStateStore(config.bridgeStatePath);
      const cancelled = await store.load();
      expect(cancelled.pendingMessages.m_workspace_waiting).toBeUndefined();
      expect(cancelled.processedMessageIds).toContain("m_workspace_waiting");

      let nextCommandCompleted = false;
      const nextCommand = router
        .enqueue({
          messageId: "m_after_workspace_stop",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/new",
        })
        .then(() => {
          nextCommandCompleted = true;
        });
      await waitFor(() => nextCommandCompleted);

      codex.complete(0, "thread_workspace_blocker");
      await Promise.all([first, nextCommand]);
      expect(codex.runs.map((run) => run.prompt)).toEqual(["block the workspace"]);
    });
  });

  test("keeps a queued run bound to its original workspace and blocks card switching", async () => {
    await withRouterAndSender(
      {},
      new ControlledListingCodex([]),
      new CardCollectingSender(),
      async ({ router, sender, codex, config }) => {
        const otherWorkspace = path.join(config.codexWorkdir, "other-workspace");
        await mkdir(otherWorkspace);
        codex.threads.push(
          { id: "thread_other", cwd: otherWorkspace, name: "Other", updatedAt: 2_000 },
          { id: "thread_current", cwd: config.codexWorkdir, name: "Current", updatedAt: 1_000 },
        );
        await router.enqueue({
          messageId: "m_projects_before_queue",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/projects",
        });

        const first = router.enqueue({
          messageId: "m_bound_blocker",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "first bound task",
        });
        const second = router.enqueue({
          messageId: "m_bound_waiter",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "second bound task",
        });
        await waitFor(() => codex.runs.length === 1);

        const response = await router.handleCardAction({
          action: "select_project",
          chatId: "oc_chat_2",
          messageId: "om_projects",
          projectIndex: 1,
          sender: { openId: "ou_user" },
        });
        expect(expectToast(response).toast.content).toContain("任务排队或运行中");

        codex.complete(0, "thread_bound_1");
        await first;
        await waitFor(() => codex.runs.length === 2);
        expect(codex.runs[1]?.cwd).toBe(config.codexWorkdir);
        codex.complete(1, "thread_bound_2");
        await second;
        expect(sender.messages.some((message) => message.text.includes("错误工作区"))).toBe(false);
      },
    );
  });

  test("allows Codex runs in different workspaces to proceed concurrently", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex({}, codex, async ({ router, config }) => {
      const secondWorkspace = path.join(config.codexWorkdir, "second-workspace");
      await mkdir(secondWorkspace);
      await router.enqueue({
        messageId: "m_cd_workspace_2",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/cd ${secondWorkspace}`,
      });

      const first = router.enqueue({
        messageId: "m_parallel_1",
        chatId: "oc_chat_1",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "first parallel task",
      });
      const second = router.enqueue({
        messageId: "m_parallel_2",
        chatId: "oc_chat_2",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "second parallel task",
      });

      await waitFor(() => codex.runs.length === 2);
      expect(new Set(codex.runs.map((run) => run.cwd))).toEqual(
        new Set([config.codexWorkdir, await realpath(secondWorkspace)]),
      );

      codex.complete(0, "thread_parallel_1");
      codex.complete(1, "thread_parallel_2");
      await Promise.all([first, second]);
    });
  });

  test("bounds concurrent Codex runs globally while preserving workspace scheduling", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex(
      { CODEX_MAX_CONCURRENT_RUNS: "1" },
      codex,
      async ({ router, config, sender }) => {
        const secondWorkspace = path.join(config.codexWorkdir, "globally-limited-workspace");
        await mkdir(secondWorkspace);
        await router.enqueue({
          messageId: "m_global_limit_cd",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: `/cd ${secondWorkspace}`,
        });

        const first = router.enqueue({
          messageId: "m_global_limit_1",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "first globally limited task",
        });
        const second = router.enqueue({
          messageId: "m_global_limit_2",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "second globally limited task",
        });

        await waitFor(() => codex.runs.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(codex.runs).toHaveLength(1);

        await router.enqueue({
          messageId: "m_global_limit_status",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        expect(sender.messages.at(-1)?.text).toContain("• 当前任务：等待执行");

        codex.complete(0, "thread_global_limit_1");
        await waitFor(() => codex.runs.length === 2);
        codex.complete(1, "thread_global_limit_2");
        await Promise.all([first, second]);
      },
    );
  });

  test("rejects excess durable jobs atomically without blocking control commands", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "1",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      async ({ router, config, sender }) => {
        await router.accept({
          messageId: "m_capacity_running",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "occupy the only queue slot",
        });
        await waitFor(() => codex.runs.length === 1);

        await Promise.all([
          router.accept({
            messageId: "m_capacity_rejected_1",
            chatId: "oc_chat_2",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "must not run one",
          }),
          router.accept({
            messageId: "m_capacity_rejected_2",
            chatId: "oc_chat_3",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "must not run two",
          }),
        ]);
        await waitFor(
          () => sender.messages.filter((message) => message.text.includes("队列已满")).length === 1,
        );

        await router.accept({
          messageId: "m_capacity_status",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await waitFor(() =>
          sender.messages.some((message) => message.text.includes("• 当前任务：运行中")),
        );

        const store = new JsonStateStore(config.bridgeStatePath);
        const state = await store.load();
        expect(state.jobs.m_capacity_rejected_1).toMatchObject({
          status: "cancelled",
          interruptionReason: "queue_capacity_reached",
          capacityNoticeScope: "global",
          capacityNoticeActive: true,
        });
        expect(state.jobs.m_capacity_rejected_2).toBeUndefined();
        for (const messageId of ["m_capacity_rejected_1", "m_capacity_rejected_2"]) {
          expect(state.pendingMessages[messageId]).toBeUndefined();
          expect(state.processedMessageIds).toContain(messageId);
        }
        expect(
          Object.values(state.outbox).find(
            (delivery) => delivery.jobId === "m_capacity_rejected_1",
          )?.status,
        ).toBe("delivered");
        expect(
          Object.values(state.outbox).some(
            (delivery) => delivery.jobId === "m_capacity_rejected_2",
          ),
        ).toBe(false);
        expect(codex.runs).toHaveLength(1);

        codex.complete(0, "thread_capacity_running");
        await waitForState(store, (saved) => saved.jobs.m_capacity_running?.status === "completed");
      },
    );
  });

  test("applies the pending-job cap per chat without rejecting another chat", async () => {
    const codex = new ControlledCodex();
    await withRouterAndCodex(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "3",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      async ({ router, config, sender }) => {
        await router.accept({
          messageId: "m_per_chat_running",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "occupy this chat slot",
        });
        await waitFor(() => codex.runs.length === 1);

        await router.accept({
          messageId: "m_per_chat_rejected",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "same chat should be rejected",
        });
        await router.accept({
          messageId: "m_other_chat_accepted",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "other chat may queue",
        });
        await waitFor(() => sender.messages.some((message) => message.text.includes("队列已满")));

        const store = new JsonStateStore(config.bridgeStatePath);
        await waitForState(store, (state) => state.jobs.m_other_chat_accepted?.status === "queued");
        const queued = await store.load();
        expect(queued.jobs.m_per_chat_rejected?.status).toBe("cancelled");
        expect(queued.jobs.m_other_chat_accepted?.status).toBe("queued");

        codex.complete(0, "thread_per_chat_running");
        await waitFor(() => codex.runs.length === 2);
        codex.complete(1, "thread_other_chat");
        await waitForState(store, (state) => state.jobs.m_other_chat_accepted?.status === "completed");
      },
    );
  });

  test("bounds durable jobs and outbox retries while delivery keeps failing", async () => {
    const sender = new PersistentDurableDeliveryFailingSender();
    const codex = new FakeCodex();
    await withRouterAndSender(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "1",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      sender,
      async ({ router, config }) => {
        const store = new JsonStateStore(config.bridgeStatePath);
        await router.accept({
          messageId: "m_delivery_blocked",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "finish but keep the reply undelivered",
        });
        await waitForState(store, (state) =>
          Object.values(state.outbox).some(
            (delivery) =>
              delivery.jobId === "m_delivery_blocked" &&
              delivery.status === "pending" &&
              delivery.attempts >= 1,
          ),
        );

        const overflowIds = Array.from({ length: 12 }, (_, index) => `m_overflow_${index}`);
        await Promise.all(
          overflowIds.map((messageId) =>
            router.accept({
              messageId,
              chatId: "oc_chat",
              chatType: "direct",
              sender: { openId: "ou_user" },
              text: `overflow ${messageId}`,
            }),
          ),
        );
        await waitForState(store, (state) =>
          Object.values(state.outbox).some(
            (delivery) =>
              delivery.jobId === overflowIds[0] &&
              delivery.status === "pending" &&
              delivery.attempts >= 1,
          ),
        );

        const blocked = await store.load();
        expect(codex.runs).toHaveLength(1);
        expect(Object.keys(blocked.jobs).sort()).toEqual(
          ["m_delivery_blocked", overflowIds[0]!].sort(),
        );
        expect(Object.values(blocked.outbox)).toHaveLength(2);
        expect(blocked.jobs[overflowIds[0]!]).toMatchObject({
          status: "cancelled",
          interruptionReason: "queue_capacity_reached",
          capacityNoticeScope: "global",
          capacityNoticeActive: true,
        });
        for (const messageId of overflowIds) {
          expect(blocked.pendingMessages[messageId]).toBeUndefined();
          expect(blocked.processedMessageIds).toContain(messageId);
        }
        expect(sender.idempotencyKeys.length).toBeGreaterThanOrEqual(2);
      },
    );
  });

  test("bounds pending control inbox records while the sender keeps failing", async () => {
    const sender = new PersistentDurableDeliveryFailingSender();
    sender.sendText = async (_chatId, _text, options) => {
      if (options?.idempotencyKey) {
        sender.idempotencyKeys.push(options.idempotencyKey);
      }
      throw new Error("simulated persistent control delivery failure");
    };
    const codex = new FakeCodex();
    await withRouterAndSender(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "1",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      sender,
      async ({ router, config }) => {
        const store = new JsonStateStore(config.bridgeStatePath);
        await router.accept({
          messageId: "m_status_blocked",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await waitForState(
          store,
          (state) => state.pendingMessages.m_status_blocked?.attempts === 1,
        );

        const overflowIds = Array.from(
          { length: 12 },
          (_, index) => `m_status_overflow_${index}`,
        );
        await Promise.all(
          overflowIds.map((messageId) =>
            router.accept({
              messageId,
              chatId: "oc_chat",
              chatType: "direct",
              sender: { openId: "ou_user" },
              text: "/status",
            }),
          ),
        );
        await waitForState(
          store,
          (state) =>
            Object.values(state.outbox).some(
              (delivery) =>
                delivery.jobId === overflowIds[0] &&
                delivery.status === "pending" &&
                delivery.attempts >= 1,
            ),
        );

        const blocked = await store.load();
        expect(codex.runs).toHaveLength(0);
        expect(Object.keys(blocked.pendingMessages)).toEqual(["m_status_blocked"]);
        expect(Object.keys(blocked.jobs)).toEqual([overflowIds[0]]);
        expect(Object.values(blocked.outbox)).toHaveLength(1);
        expect(blocked.jobs[overflowIds[0]!]).toMatchObject({
          kind: "control_recovery",
          status: "cancelled",
          interruptionReason: "inbox_capacity_reached",
          capacityNoticeKind: "inbox",
          capacityNoticeScope: "global",
          capacityNoticeActive: true,
        });
        for (const messageId of overflowIds) {
          expect(blocked.processedMessageIds).toContain(messageId);
        }
      },
    );
  });

  test("applies the pending control inbox cap per chat", async () => {
    const sender = new FailingDeliverySender();
    const codex = new FakeCodex();
    await withRouterAndSender(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "3",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      sender,
      async ({ router, config }) => {
        const store = new JsonStateStore(config.bridgeStatePath);
        await router.accept({
          messageId: "m_chat_status_blocked",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await waitForState(
          store,
          (state) => state.pendingMessages.m_chat_status_blocked?.attempts === 1,
        );

        await router.accept({
          messageId: "m_chat_status_overflow",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await router.accept({
          messageId: "m_other_chat_status",
          chatId: "oc_chat_2",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await waitForState(
          store,
          (state) => state.pendingMessages.m_other_chat_status?.attempts === 1,
        );

        const blocked = await store.load();
        expect(Object.keys(blocked.pendingMessages).sort()).toEqual(
          ["m_chat_status_blocked", "m_other_chat_status"].sort(),
        );
        expect(blocked.jobs.m_chat_status_overflow).toMatchObject({
          kind: "control_recovery",
          interruptionReason: "inbox_capacity_reached",
          capacityNoticeKind: "inbox",
          capacityNoticeScope: "chat",
          capacityNoticeActive: true,
        });
        expect(codex.runs).toHaveLength(0);
      },
    );
  });

  test("retries the same control delivery without letting failed notices grow across chats", async () => {
    const sender = new ToggleControlDeliverySender();
    const codex = new FakeCodex();
    await withRouterAndSender(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "3",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      sender,
      async ({ router, config }) => {
        const store = new JsonStateStore(config.bridgeStatePath);
        for (const suffix of ["a", "b", "c"]) {
          const chatId = `oc_chat_${suffix}`;
          const pendingId = `m_status_${suffix}`;
          const overflowId = `m_status_overflow_${suffix}`;
          const pendingMessage = {
            messageId: pendingId,
            chatId,
            chatType: "direct" as const,
            sender: { openId: "ou_user" },
            text: "/status",
          };

          sender.failControl = true;
          await router.accept(pendingMessage);
          await waitForState(
            store,
            (state) => state.pendingMessages[pendingId]?.attempts === 1,
          );
          await router.accept({ ...pendingMessage, messageId: overflowId });
          await waitForState(
            store,
            (state) =>
              Object.values(state.outbox).some(
                (delivery) =>
                  delivery.jobId === overflowId &&
                  delivery.status === "pending" &&
                  delivery.attempts >= 1,
              ),
          );

          sender.failControl = false;
          await router.accept(pendingMessage);
          await waitForState(
            store,
            (state) => state.pendingMessages[pendingId] === undefined,
          );
        }

        sender.failControl = true;
        await router.accept({
          messageId: "m_status_after_global_cap",
          chatId: "oc_chat_d",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });

        const bounded = await store.load();
        expect(Object.keys(bounded.pendingMessages)).toHaveLength(0);
        expect(Object.keys(bounded.jobs)).toHaveLength(3);
        expect(Object.keys(bounded.outbox)).toHaveLength(3);
        expect(bounded.jobs.m_status_overflow_c).toMatchObject({
          capacityNoticeKind: "inbox",
          capacityNoticeScope: "global",
          capacityNoticeActive: true,
        });
        expect(bounded.processedMessageIds).toContain("m_status_after_global_cap");
        expect(codex.runs).toHaveLength(0);
      },
    );
  });

  test("replays a failed final delivery after restart without rerunning Codex", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-delivery-"));
    let failedRouter: MessageRouter | undefined;
    let replayRouter: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      const failedSender = new FinalFailingSender();
      const firstCodex = new FakeCodex();
      failedRouter = new MessageRouter(
        config,
        store,
        failedSender,
        silentLogger,
        firstCodex,
      );
      await failedRouter.start();
      await failedRouter.accept({
        messageId: "m_replay",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "retry after restart",
      });

      await waitForState(store, (state) =>
        Object.values(state.outbox).some(
          (delivery) =>
            delivery.jobId === "m_replay" &&
            delivery.attempts === 1 &&
            delivery.status === "pending",
        ),
      );
      const failed = await store.load();
      expect(firstCodex.runs).toHaveLength(1);
      expect(failed.jobs.m_replay?.status).toBe("completed");
      expect(failed.pendingMessages.m_replay).toBeUndefined();
      expect(failed.processedMessageIds).toContain("m_replay");
      const failedDelivery = Object.values(failed.outbox).find(
        (delivery) => delivery.jobId === "m_replay",
      );
      expect(failedDelivery?.status).toBe("pending");
      expect(failedDelivery?.lastError).toContain("simulated final delivery failure");
      expect(failedSender.idempotencyKeys).toEqual([failedDelivery?.idempotencyKey]);
      await failedRouter.dispose();
      failedRouter = undefined;

      const replayCodex = new FakeCodex();
      const replaySender = new IdempotencyCollectingSender();
      replayRouter = new MessageRouter(
        config,
        new JsonStateStore(config.bridgeStatePath),
        replaySender,
        silentLogger,
        replayCodex,
      );
      await replayRouter.start();
      await waitForState(store, (state) =>
        Object.values(state.outbox).some(
          (delivery) => delivery.jobId === "m_replay" && delivery.status === "delivered",
        ),
      );

      const replayed = await store.load();
      expect(replayCodex.runs).toHaveLength(0);
      expect(replaySender.messages.map((message) => message.text)).toEqual(["done"]);
      expect(replaySender.idempotencyKeys).toEqual([failedDelivery?.idempotencyKey]);
      expect(replayed.pendingMessages.m_replay).toBeUndefined();
      expect(replayed.processedMessageIds).toContain("m_replay");
      expect(
        Object.values(replayed.outbox).find((delivery) => delivery.jobId === "m_replay")?.text,
      ).toBe("");
    } finally {
      await failedRouter?.dispose();
      await replayRouter?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retries a transient final delivery in-process without rerunning Codex", async () => {
    const sender = new TransientFinalDeliverySender();
    const codex = new FakeCodex();
    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.accept({
        messageId: "m_retry_in_process",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "retry the reply only",
      });

      const store = new JsonStateStore(config.bridgeStatePath);
      await waitForState(store, (state) =>
        Object.values(state.outbox).some(
          (delivery) =>
            delivery.jobId === "m_retry_in_process" && delivery.status === "delivered",
        ),
      );

      expect(codex.runs).toHaveLength(1);
      expect(sender.attempts).toBe(2);
      expect(
        sender.messages
          .filter((message) => message.kind === "markdown")
          .map((message) => message.text),
      ).toEqual(["done"]);
      expect(sender.idempotencyKeys).toHaveLength(2);
      expect(new Set(sender.idempotencyKeys).size).toBe(1);
    });
  });

  test("caps the total final answer before creating durable chat deliveries", async () => {
    const codex = new SequencedCodex([{
      threadId: "thread_bounded_output",
      finalText: `开头-${"结果".repeat(200)}-结尾不应出现`,
      stderr: "",
      exitCode: 0,
    }]);
    await withRouterAndCodex(
      { CHAT_OUTPUT_MAX_CHARS: "64" },
      codex,
      async ({ router, config, sender }) => {
        await router.accept({
          messageId: "m_bounded_chat_output",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "produce a large answer",
        });

        const store = new JsonStateStore(config.bridgeStatePath);
        await waitForState(
          store,
          (state) => state.jobs.m_bounded_chat_output?.status === "completed",
        );
        await waitFor(() => sender.messages.some((message) => message.kind === "markdown"));

        const delivered = sender.messages
          .filter((message) => message.kind === "markdown")
          .map((message) => message.text)
          .join("");
        expect([...delivered].length).toBeLessThanOrEqual(64);
        expect(delivered).toContain("输出已截断");
        expect(delivered).not.toContain("结尾不应出现");
      },
    );
  });

  test("replays a pending status command after restart instead of inventing a Codex job", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-status-recovery-"));
    const sender = new DelayedTextSender();
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {},
        jobs: {},
        outbox: {},
        pendingMessages: {
          m_status_restart: {
            messageId: "m_status_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/status",
            acceptedAt: "2026-07-20T00:00:00.000Z",
            attempts: 0,
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new FakeCodex();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await sender.sendStarted.promise;

      const replaying = await store.load();
      expect(replaying.pendingMessages.m_status_restart?.route).toBe("control_replay_safe");
      expect(replaying.jobs.m_status_restart).toBeUndefined();

      sender.releaseSend.resolve();
      await waitForState(
        store,
        (state) => state.pendingMessages.m_status_restart === undefined,
      );
      const recovered = await store.load();
      expect(codex.runs).toHaveLength(0);
      expect(recovered.jobs.m_status_restart).toBeUndefined();
      expect(recovered.processedMessageIds).toContain("m_status_restart");
      expect(sender.messages[0]?.text).toContain("当前 chat");
    } finally {
      sender.releaseSend.resolve();
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not promote a persisted non-Codex message after access changes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-route-recovery-"));
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_newly_allowed",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {},
        jobs: {},
        outbox: {},
        pendingMessages: {
          m_previously_denied: {
            messageId: "m_previously_denied",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_newly_allowed" },
            text: "must not become a Codex run after restart",
            acceptedAt: "2026-07-20T00:00:00.000Z",
            attempts: 1,
            route: "message",
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new FakeCodex();
      const sender = new CollectingSender();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();

      const recovered = await store.load();
      expect(recovered.pendingMessages.m_previously_denied).toBeUndefined();
      expect(recovered.processedMessageIds).toContain("m_previously_denied");
      expect(recovered.jobs.m_previously_denied).toBeUndefined();
      expect(codex.runs).toHaveLength(0);
      expect(sender.messages).toHaveLength(0);
    } finally {
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("recovers a pending side-effect control without replaying or blaming Codex", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-control-recovery-"));
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {
          oc_chat: {
            cwd: tempDir,
            chatType: "direct",
            threadId: "thread_before_restart",
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
        },
        jobs: {},
        outbox: {},
        pendingMessages: {
          m_new_restart: {
            messageId: "m_new_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/new",
            acceptedAt: "2026-07-20T00:00:00.000Z",
            attempts: 0,
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new FakeCodex();
      const sender = new IdempotencyCollectingSender();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await waitFor(() => sender.messages.length === 1);

      const recovered = await store.load();
      expect(codex.runs).toHaveLength(0);
      expect(recovered.chats.oc_chat?.threadId).toBe("thread_before_restart");
      expect(recovered.pendingMessages.m_new_restart).toBeUndefined();
      expect(recovered.processedMessageIds).toContain("m_new_restart");
      expect(recovered.jobs.m_new_restart).toMatchObject({
        kind: "control_recovery",
        status: "interrupted",
        interruptionReason: "control_command_not_replayed",
        prompt: "/new",
      });
      expect(sender.messages[0]?.text).toContain("不会自动重放");
      expect(sender.messages[0]?.text).not.toContain("Codex");
    } finally {
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not replay stale stop or steer commands onto a recovered queued run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-control-race-"));
    const codex = new ControlledCodex();
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {
          oc_chat: {
            cwd: tempDir,
            chatType: "direct",
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
        },
        jobs: {
          m_queued_restart: {
            id: "m_queued_restart",
            kind: "codex_run",
            messageId: "m_queued_restart",
            chatId: "oc_chat",
            chatType: "direct",
            cwd: tempDir,
            prompt: "continue the queued task",
            status: "queued",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            deliveryIds: [],
          },
        },
        outbox: {},
        pendingMessages: {
          m_queued_restart: {
            messageId: "m_queued_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "continue the queued task",
            acceptedAt: "2026-07-20T00:00:00.000Z",
            attempts: 0,
          },
          m_stop_restart: {
            messageId: "m_stop_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/stop",
            acceptedAt: "2026-07-20T00:00:01.000Z",
            attempts: 0,
          },
          m_steer_restart: {
            messageId: "m_steer_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/steer private recovery instruction",
            acceptedAt: "2026-07-20T00:00:02.000Z",
            attempts: 0,
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const sender = new IdempotencyCollectingSender();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await waitFor(() => codex.runs.length === 1);
      await waitFor(
        () => sender.messages.filter((message) => message.text.includes("不会自动重放")).length === 2,
      );

      const recovered = await store.load();
      expect(codex.runs[0]?.signal?.aborted).toBe(false);
      expect(recovered.jobs.m_stop_restart).toMatchObject({
        kind: "control_recovery",
        prompt: "/stop",
      });
      expect(recovered.jobs.m_steer_restart).toMatchObject({
        kind: "control_recovery",
        prompt: "/steer",
      });
      expect(sender.messages.map((message) => message.text).join("\n")).not.toContain(
        "private recovery instruction",
      );

      codex.complete(0, "thread_recovered_queue");
      await waitForState(
        store,
        (state) => state.jobs.m_queued_restart?.status === "completed",
      );
    } finally {
      codex.complete(0, "thread_recovered_queue");
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("marks a running durable job interrupted on restart without rerunning Codex", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-interrupted-"));
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {
          oc_chat: {
            cwd: tempDir,
            chatType: "direct",
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
        },
        jobs: {
          m_interrupted: {
            id: "m_interrupted",
            kind: "codex_run",
            messageId: "m_interrupted",
            chatId: "oc_chat",
            chatType: "direct",
            cwd: tempDir,
            prompt: "may already have side effects",
            status: "running",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:01.000Z",
            startedAt: "2026-07-20T00:00:01.000Z",
            deliveryIds: [],
          },
        },
        outbox: {},
        pendingMessages: {
          m_interrupted: {
            messageId: "m_interrupted",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "may already have side effects",
            acceptedAt: "2026-07-20T00:00:00.000Z",
            attempts: 0,
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new FakeCodex();
      const sender = new IdempotencyCollectingSender();
      const router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await waitForState(store, (state) => state.jobs.m_interrupted?.status === "interrupted");
      await waitFor(() => sender.messages.length === 1);

      const recovered = await store.load();
      expect(codex.runs).toHaveLength(0);
      expect(recovered.pendingMessages.m_interrupted).toBeUndefined();
      expect(recovered.processedMessageIds).toContain("m_interrupted");
      expect(sender.messages[0]?.text).toContain("不会自动重新执行");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not run Codex or reply for unauthorized group messages", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_group",
        chatType: "group",
        sender: { openId: "ou_user" },
        text: "run this",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages).toHaveLength(0);
    });
  });

  test("answers whoami even when the group is not authorized", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_group",
        chatType: "group",
        sender: { openId: "ou_user" },
        text: "/whoami",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("chat_id：oc_group");
      expect(sender.messages[0]?.text).not.toContain("【发送者】");
      expect(sender.messages[0]?.text).toContain("未授权（groups_disabled）");
    });
  });

  test("includes available sender ids in direct-message whoami", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_direct",
        chatType: "direct",
        sender: { openId: "ou_user", userId: "u_user", unionId: "on_user" },
        text: "/whoami",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("open_id：ou_user");
      expect(sender.messages[0]?.text).toContain("user_id：u_user");
      expect(sender.messages[0]?.text).toContain("union_id：on_user");
      expect(sender.messages[0]?.text).toContain("【访问权限】\n• 已授权");
    });
  });

  test("answers whoami when the group message starts with a bot mention", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_group",
        chatType: "group",
        sender: { openId: "ou_user" },
        text: "@_user_1 /whoami",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("chat_id：oc_group");
      expect(sender.messages[0]?.text).toContain("未授权（groups_disabled）");
    });
  });

  test("status includes attachment directory and recent event diagnostics", async () => {
    await withRouter({}, async ({ router, sender }) => {
      await router.recordEventDiagnostic("dropped", {
        reason: "unsupported_message_type",
        messageId: "m_dropped",
        chatId: "oc_chat",
        chatType: "direct",
        messageType: "audio",
        mentionCount: 0,
        startsWithMention: false,
        attachmentCount: 0,
        textLength: 0,
        botIdentityResolved: true,
      });

      await router.enqueue({
        messageId: "m_status",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/status",
      });

      expect(sender.messages[0]?.text).toContain("【诊断】");
      expect(sender.messages[0]?.text).toContain("附件目录：");
      expect(sender.messages[0]?.text).toContain("最近消息：已丢弃");
      expect(sender.messages[0]?.text).toContain("类型 audio");
      expect(sender.messages[0]?.text).toContain("原因 unsupported_message_type");
      expect(sender.messages[0]?.text).toContain("最近丢弃：已丢弃");
      expect(sender.messages[0]?.text).toContain("• 队列：0");
      expect(sender.messages[0]?.text).toContain("• 当前任务：无");
      expect(sender.messages[0]?.text).toContain("• 命令审批：无");
      expect(sender.messages[0]?.text).toContain("• 最近失败：无");
    });
  });

  test("keeps status and host diagnostics scoped to the requesting chat", async () => {
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, new FailingCodex(), sender, async ({ router }) => {
      await router.recordEventDiagnostic("dropped", {
        reason: "secret-chat-drop",
        messageId: "m_secret_chat",
        chatId: "oc_secret_chat",
        chatType: "direct",
        messageType: "text",
        mentionCount: 0,
        startsWithMention: false,
        attachmentCount: 0,
        textLength: 12,
        botIdentityResolved: true,
      });
      await router.enqueue({
        messageId: "m_secret_run",
        chatId: "oc_secret_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "secret prompt from another chat",
      });

      sender.messages.length = 0;
      await router.recordEventDiagnostic("routed", {
        messageId: "m_visible_chat",
        chatId: "oc_visible_chat",
        chatType: "direct",
        messageType: "text",
        mentionCount: 0,
        startsWithMention: false,
        attachmentCount: 0,
        textLength: 7,
        botIdentityResolved: true,
      });
      await router.enqueue({
        messageId: "m_status_visible",
        chatId: "oc_visible_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/status",
      });

      const status = sender.messages.at(-1)?.text ?? "";
      expect(status).toContain("m_visible_chat");
      expect(status).not.toContain("m_secret_chat");
      expect(status).not.toContain("secret prompt from another chat");

      await router.enqueue({
        messageId: "m_host_visible",
        chatId: "oc_visible_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/host",
      });
      const host = JSON.stringify(sender.interactiveCards.at(-1)?.card ?? {});
      expect(host).toContain("visible");
      expect(host).not.toContain("m_secret_chat");
      expect(host).not.toContain("secret prompt from another chat");
    });
  });

  test("host sends a health card with mobile safety warnings", async () => {
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      {
        CODEX_BIN: process.execPath,
        ALLOW_GROUPS: "true",
        ALLOWED_CHAT_IDS: "oc_group",
        CODEX_APPROVAL_POLICY: "never",
        CODEX_RUN_TIMEOUT_MS: "0",
      },
      new FakeCodex(),
      sender,
      async ({ router }) => {
        await router.enqueue({
          messageId: "m_host",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 /host",
        });

        expect(sender.interactiveCards).toHaveLength(1);
        const serialized = JSON.stringify(sender.interactiveCards[0]?.card);
        expect(serialized).toContain("Host 健康卡");
        expect(serialized).toContain("queue");
        expect(serialized).toContain("风险较高");
        expect(serialized).toContain("任务无限等待");
      },
    );
  });

  test("status bypasses the queue and reports active run metadata", async () => {
    const codex = new FirstBlockingThenDoneCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const running = router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long running task",
      });
      await waitFor(() => codex.runs.length === 1);

      const queued = router.enqueue({
        messageId: "m_queued",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "queued task",
      });
      await router.enqueue({
        messageId: "m_status",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/status",
      });

      const status = sender.messages.at(-1)?.text ?? "";
      expect(status).toContain("• 队列：1");
      expect(status).toContain("• 当前任务：运行中");
      expect(status).not.toContain("long running task");

      await router.enqueue({
        messageId: "m_stop",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;
      await queued;
      expect(codex.runs.map((run) => run.prompt)).toEqual(["long running task", "queued task"]);
    });
  });

  test("lists Codex app-server projects grouped by cwd", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A plan",
        updatedAt: 1_000,
      },
      {
        id: "thread_b1",
        cwd: "/repo/b",
        preview: "Investigate B",
        updatedAt: 3_000,
      },
      {
        id: "thread_a2",
        cwd: "/repo/a",
        preview: "Fix A",
        updatedAt: 2_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });

      expect(codex.listInputs[0]).toMatchObject({
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      expect(sender.messages[0]?.kind).toBe("markdown");
      expect(sender.messages[0]?.text).toContain("**Codex app-server 项目**");
      expect(sender.messages[0]?.text).toContain("**1. b**");
      expect(sender.messages[0]?.text).toContain("`/repo/b`");
      expect(sender.messages[0]?.text).toContain("**2. a**");
      expect(sender.messages[0]?.text).toContain("`/repo/a`");
      expect(sender.messages[0]?.text).toContain("2 个对话");
      expect(sender.messages[0]?.text).toContain("`/project <编号>`");
    });
  });

  test("sends project lists as interactive cards when supported", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A work",
        updatedAt: 2_000,
      },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });

      expect(sender.interactiveCards).toHaveLength(1);
      expect(sender.interactiveCards[0]?.card.header.title.content).toBe("Codex 项目");
      expect(JSON.stringify(sender.interactiveCards[0]?.card)).toContain("进入 1");
      expect(sender.messages).toHaveLength(0);
    });
  });

  test("selects a project by listed index before running Codex", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_b1",
        cwd: "/repo/b",
        name: "B work",
        updatedAt: 3_000,
      },
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A work",
        updatedAt: 2_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      await router.enqueue({
        messageId: "m_project",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/project 2",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run in selected project",
      });

      expect(sender.messages[1]?.kind).toBe("markdown");
      expect(sender.messages[1]?.text).toContain("**已进入项目**");
      expect(sender.messages[1]?.text).toContain("`/repo/a`");
      expect(codex.runs).toHaveLength(1);
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBeUndefined();
      expect(codex.runs[0]?.prompt).toBe("run in selected project");
    });
  });

  test("lists current project sessions and resumes by index", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A recent",
        updatedAt: 4_000,
      },
      {
        id: "thread_a2",
        cwd: "/repo/a",
        name: "A older",
        updatedAt: 2_000,
      },
      {
        id: "thread_b1",
        cwd: "/repo/b",
        name: "B work",
        updatedAt: 3_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      await router.enqueue({
        messageId: "m_project",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/project 1",
      });
      await router.enqueue({
        messageId: "m_threads",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/sessions",
      });
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume 2",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue selected thread",
      });

      expect(codex.listInputs[1]).toMatchObject({ cwd: "/repo/a", limit: 50 });
      expect(sender.messages[2]?.kind).toBe("markdown");
      expect(sender.messages[2]?.text).toContain("**当前项目会话**");
      expect(sender.messages[2]?.text).toContain("1. A recent");
      expect(sender.messages[2]?.text).toContain("2. A older");
      expect(sender.messages[3]?.text).toContain("thread：`thread_a2`");
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBe("thread_a2");
    });
  });

  test("session card actions resume the selected thread", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A recent",
        updatedAt: 4_000,
      },
      {
        id: "thread_a2",
        cwd: "/repo/a",
        name: "A older",
        updatedAt: 2_000,
      },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      const projectResponse = await router.handleCardAction({
        action: "select_project",
        chatId: "oc_chat",
        messageId: "om_projects",
        projectIndex: 1,
        page: 1,
        sender: { openId: "ou_user" },
      });
      await router.enqueue({
        messageId: "m_sessions",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/sessions",
      });
      const response = await router.handleCardAction({
        action: "resume_thread",
        chatId: "oc_chat",
        messageId: "om_sessions",
        threadIndex: 2,
        page: 1,
        sender: { openId: "ou_user" },
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue from card",
      });

      const renderedProjectResponse = renderFeishuActionForTest(projectResponse);
      expect(renderedProjectResponse).toMatchObject({
        card: {
          type: "raw",
          data: {
            header: {
              title: {
                content: "Codex 项目已选择",
              },
            },
          },
        },
      });
      expect(JSON.stringify(renderedProjectResponse)).not.toContain("select_project");
      const renderedSessionResponse = renderFeishuActionForTest(response);
      expect(renderedSessionResponse).toMatchObject({
        card: {
          type: "raw",
          data: {
            header: {
              title: {
                content: "Codex 会话已选择",
              },
            },
          },
        },
      });
      expect(JSON.stringify(renderedSessionResponse)).toContain("已选择会话：A older");
      expect(JSON.stringify(renderedSessionResponse)).not.toContain("resume_thread");
      expect(sender.interactiveCards.at(-1)?.card.header.title.content).toBe("当前项目会话");
      expect(sender.interactiveCardUpdates).toHaveLength(0);
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBe("thread_a2");
    });
  });

  test("project and session card pagination returns raw card callback updates", async () => {
    const codex = new ListingCodex([
      { id: "thread_1", cwd: "/repo/1", name: "Project 1", updatedAt: 6_000 },
      { id: "thread_2", cwd: "/repo/2", name: "Project 2", updatedAt: 5_000 },
      { id: "thread_3", cwd: "/repo/3", name: "Project 3", updatedAt: 4_000 },
      { id: "thread_4", cwd: "/repo/4", name: "Project 4", updatedAt: 3_000 },
      { id: "thread_5", cwd: "/repo/5", name: "Project 5", updatedAt: 2_000 },
      { id: "thread_6", cwd: "/repo/6", name: "Project 6", updatedAt: 1_000 },
      { id: "thread_a1", cwd: "/repo/1", name: "A recent", updatedAt: 9_000 },
      { id: "thread_a2", cwd: "/repo/1", name: "A 2", updatedAt: 8_000 },
      { id: "thread_a3", cwd: "/repo/1", name: "A 3", updatedAt: 7_000 },
      { id: "thread_a4", cwd: "/repo/1", name: "A 4", updatedAt: 6_500 },
      { id: "thread_a5", cwd: "/repo/1", name: "A 5", updatedAt: 6_400 },
      { id: "thread_a6", cwd: "/repo/1", name: "A 6", updatedAt: 6_300 },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      const projectPage = await router.handleCardAction({
        action: "page_projects",
        chatId: "oc_chat",
        messageId: "om_projects",
        page: 2,
        sender: { openId: "ou_user" },
      });

      const renderedProjectPage = renderFeishuActionForTest(projectPage);
      expect(renderedProjectPage).toMatchObject({
        card: {
          type: "raw",
          data: {
            header: {
              title: {
                content: "Codex 项目",
              },
            },
          },
        },
      });
      expect(JSON.stringify(renderedProjectPage)).toContain("进入 6");
      expect(JSON.stringify(renderedProjectPage)).toContain("上一页");
      expect(JSON.stringify(renderedProjectPage)).not.toContain("下一页");

      await router.handleCardAction({
        action: "select_project",
        chatId: "oc_chat",
        messageId: "om_projects",
        projectIndex: 1,
        page: 1,
        sender: { openId: "ou_user" },
      });
      await router.enqueue({
        messageId: "m_sessions",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/sessions",
      });
      const sessionPage = await router.handleCardAction({
        action: "page_sessions",
        chatId: "oc_chat",
        messageId: "om_sessions",
        page: 2,
        sender: { openId: "ou_user" },
      });

      const renderedSessionPage = renderFeishuActionForTest(sessionPage);
      expect(renderedSessionPage).toMatchObject({
        card: {
          type: "raw",
          data: {
            header: {
              title: {
                content: "当前项目会话",
              },
            },
          },
        },
      });
      expect(JSON.stringify(renderedSessionPage)).toContain("继续 6");
      expect(JSON.stringify(renderedSessionPage)).toContain("上一页");
      expect(JSON.stringify(renderedSessionPage)).not.toContain("下一页");
      expect(sender.interactiveCardUpdates).toHaveLength(0);
    });
  });

  test("resumes a conversation by thread id from app-server", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_b1",
        cwd: "/repo/b",
        name: "B work",
        updatedAt: 3_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_b1",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue by id",
      });

      expect(codex.readIds).toEqual(["thread_b1"]);
      expect(codex.runs[0]?.cwd).toBe("/repo/b");
      expect(codex.runs[0]?.threadId).toBe("thread_b1");
    });
  });

  test("searches conversations and reuses results for resume", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_search_1",
        cwd: "/repo/a",
        name: "Release notes",
        preview: "Prepare mobile control release",
        updatedAt: 4_000,
      },
      {
        id: "thread_other",
        cwd: "/repo/b",
        name: "Other",
        preview: "Unrelated",
        updatedAt: 3_000,
      },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_search",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/search mobile",
      });
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume 1",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue searched thread",
      });

      expect(codex.searchInputs[0]).toMatchObject({
        searchTerm: "mobile",
        limit: 20,
        sortKey: "updated_at",
      });
      expect(sender.interactiveCards[0]?.card.header.title.content).toBe("Codex 搜索结果");
      expect(JSON.stringify(sender.interactiveCards[0]?.card)).toContain("Release notes");
      expect(JSON.stringify(sender.interactiveCards[0]?.card)).toContain("Prepare mobile control release");
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBe("thread_search_1");
    });
  });

  test("lists conversation history and renders selected turn detail", async () => {
    const codex = new ListingCodex(
      [
        {
          id: "thread_a1",
          cwd: "/repo/a",
          name: "A recent",
          updatedAt: 4_000,
        },
      ],
      {
        turns: [
          {
            id: "turn_2",
            status: "completed",
            startedAt: 4_000,
            completedAt: 4_001,
            durationMs: 1_000,
            items: [
              { id: "item_user", type: "userMessage", text: "please add history" },
              { id: "item_agent", type: "agentMessage", text: "history added" },
            ],
          },
        ],
        itemsByTurn: {
          turn_2: [
            { id: "item_user", type: "userMessage", text: "please add history" },
            {
              id: "item_cmd",
              type: "commandExecution",
              command: "bun test",
              cwd: "/repo/a",
              status: "completed",
              exitCode: 0,
            },
            { id: "item_file", type: "fileChange", files: ["src/app.ts"], status: "completed" },
          ],
        },
      },
    );

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_history",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/history",
      });
      await router.enqueue({
        messageId: "m_history_detail",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/history 1",
      });

      expect(codex.turnListInputs[0]).toMatchObject({
        threadId: "thread_a1",
        limit: 12,
        itemsView: "summary",
      });
      expect(codex.turnItemInputs[0]).toMatchObject({
        threadId: "thread_a1",
        turnId: "turn_2",
      });
      expect(sender.messages[1]?.text).toContain("**当前会话历史**");
      expect(sender.messages[1]?.text).toContain("please add history");
      expect(sender.messages[2]?.text).toContain("**历史轮次详情**");
      expect(sender.messages[2]?.text).toContain("bun test");
      expect(sender.messages[2]?.text).toContain("src/app.ts");
    });
  });

  test("forks from a selected historical turn without modifying the source thread", async () => {
    const codex = new ListingCodex(
      [{ id: "thread_a1", cwd: "/repo/a", name: "A recent", updatedAt: 4_000 }],
      {
        turns: [
          {
            id: "turn_2",
            status: "completed",
            startedAt: 4_000,
            completedAt: 4_001,
            durationMs: 1_000,
            items: [{ id: "item_user", type: "userMessage", text: "checkpoint" }],
          },
        ],
      },
    );

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume_turn_fork",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_history_turn_fork",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/history",
      });
      await router.enqueue({
        messageId: "m_fork_turn",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/fork --turn 1",
      });
      await router.enqueue({
        messageId: "m_run_turn_fork",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue forked checkpoint",
      });

      expect(codex.forkInputs).toEqual([
        { threadId: "thread_a1", cwd: "/repo/a", lastTurnId: "turn_2" },
      ]);
      expect(sender.messages[2]?.text).toContain("截止 turn：`turn_2`");
      expect(sender.messages[2]?.text).toContain("不会恢复或回滚本地文件");
      expect(codex.runs[0]?.threadId).toBe("fork_thread_a1");
    });
  });

  test("validates historical turn boundaries and rejects an in-progress turn", async () => {
    const codex = new ListingCodex(
      [{ id: "thread_a1", cwd: "/repo/a", name: "A recent", updatedAt: 4_000 }],
      {
        turns: [{ id: "turn_running", status: "inProgress", items: [] }],
      },
    );

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const command = (messageId: string, text: string): IncomingTextMessage => ({
        messageId,
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text,
      });
      await router.enqueue(command("m_resume_turn_guard", "/resume thread_a1"));
      await router.enqueue(command("m_missing_history_turn", "/fork --turn 1"));
      await router.enqueue(command("m_history_turn_guard", "/history"));
      await router.enqueue(command("m_running_turn_guard", "/fork --turn 1"));

      expect(codex.forkInputs).toHaveLength(0);
      expect(sender.messages[1]?.text).toContain("请先发送 /history");
      expect(sender.messages[3]?.text).toContain("仍在进行中");
    });
  });

  test("replays a failed fork result in-process without creating another thread", async () => {
    const codex = new ListingCodex(
      [{ id: "thread_a1", cwd: "/repo/a", name: "A recent", updatedAt: 4_000 }],
      {
        turns: [{ id: "turn_2", status: "completed", items: [] }],
      },
    );
    const sender = new FailingNextMarkdownSender();

    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.enqueue({
        messageId: "m_resume_fork_retry",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_history_fork_retry",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/history",
      });
      sender.failNextMarkdown = true;
      const forkMessage: IncomingTextMessage = {
        messageId: "m_fork_retry",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/fork --turn 1",
      };
      await router.accept(forkMessage);

      const store = new JsonStateStore(config.bridgeStatePath);
      await waitForState(
        store,
        (state) => state.pendingMessages.m_fork_retry?.attempts === 1,
      );
      expect(codex.forkInputs).toHaveLength(1);
      expect((await store.load()).pendingMessages.m_fork_retry?.forkAttempt?.result).toMatchObject({
        threadId: "fork_thread_a1",
      });

      await router.accept(forkMessage);
      await waitForState(
        store,
        (state) => state.processedMessageIds.includes("m_fork_retry"),
      );

      expect(codex.forkInputs).toHaveLength(1);
      expect(sender.messages.at(-1)?.text).toContain("fork_thread_a1");
    });
  });

  test("recovers a persisted fork result after restart without rerunning the fork", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-fork-recovery-"));
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {
          oc_chat: {
            cwd: "/repo/a",
            threadId: "fork_thread_a1",
            sessionEpoch: "epoch_forked",
            chatType: "direct",
            updatedAt: "2026-07-21T00:00:00.000Z",
          },
        },
        jobs: {},
        outbox: {},
        pendingMessages: {
          m_fork_restart: {
            messageId: "m_fork_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/fork --turn turn_2",
            acceptedAt: "2026-07-21T00:00:00.000Z",
            attempts: 1,
            route: "control_no_replay",
            forkAttempt: {
              sourceThreadId: "thread_a1",
              lastTurnId: "turn_2",
              startedAt: "2026-07-21T00:00:00.000Z",
              selectionPersisted: true,
              result: { threadId: "fork_thread_a1", cwd: "/repo/a" },
            },
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new ListingCodex([]);
      const sender = new IdempotencyCollectingSender();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await waitForState(
        store,
        (state) =>
          state.processedMessageIds.includes("m_fork_restart") &&
          Object.values(state.outbox).some(
            (delivery) => delivery.jobId === "m_fork_restart" && delivery.status === "delivered",
          ),
      );

      expect(codex.forkInputs).toHaveLength(0);
      expect(sender.messages[0]?.text).toContain("**已分叉 Codex 会话**");
      expect(sender.messages[0]?.text).toContain("fork_thread_a1");
    } finally {
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("forks the current conversation and continues the forked thread", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A recent",
        updatedAt: 4_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_fork",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/fork",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue fork",
      });

      expect(codex.forkInputs).toEqual([{ threadId: "thread_a1", cwd: "/repo/a" }]);
      expect(sender.messages[1]?.text).toContain("**已分叉 Codex 会话**");
      expect(sender.messages[1]?.text).toContain("fork_thread_a1");
      expect(codex.runs[0]?.threadId).toBe("fork_thread_a1");
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
    });
  });

  test("compacts the selected conversation", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A recent",
        updatedAt: 4_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_compact",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/compact",
      });

      expect(codex.compactIds).toEqual(["thread_a1"]);
      expect(sender.messages[1]?.text).toContain("**已请求压缩当前 Codex 会话**");
      expect(sender.messages[1]?.text).toContain("thread_a1");
    });
  });

  test("archives the current conversation and restores it from the archived list", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A recent",
        updatedAt: 4_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender, config }) => {
      await router.enqueue({
        messageId: "m_resume_archive",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_archive",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/archive",
      });
      await router.enqueue({
        messageId: "m_archived",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/archived",
      });
      await router.enqueue({
        messageId: "m_unarchive",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/unarchive 1",
      });

      expect(codex.archiveIds).toEqual(["thread_a1"]);
      expect(codex.unarchiveIds).toEqual(["thread_a1"]);
      expect(codex.listInputs.at(-1)).toMatchObject({
        cwd: "/repo/a",
        archived: true,
      });
      expect(sender.messages[1]?.text).toContain("**已归档当前 Codex 会话**");
      expect(sender.messages[2]?.text).toContain("**已归档会话**");
      expect(sender.messages[3]?.text).toContain("**已恢复已归档的 Codex 会话**");
      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(persisted.chats.oc_chat?.threadId).toBeUndefined();
      expect(persisted.chats.oc_chat?.lastArchivedThreads).toEqual([]);
    });
  });

  test("replays a failed archive result without archiving the thread twice", async () => {
    const codex = new ListingCodex([
      { id: "thread_a1", cwd: "/repo/a", name: "A recent", updatedAt: 4_000 },
    ]);
    const sender = new FailingNextMarkdownSender();

    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.enqueue({
        messageId: "m_resume_before_archive_retry",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      sender.failNextMarkdown = true;
      const message: IncomingTextMessage = {
        messageId: "m_archive_retry",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/archive",
      };
      await router.accept(message);
      const store = new JsonStateStore(config.bridgeStatePath);
      await waitForState(
        store,
        (state) => state.pendingMessages.m_archive_retry?.attempts === 1,
      );
      expect(codex.archiveIds).toEqual(["thread_a1"]);
      expect((await store.load()).pendingMessages.m_archive_retry?.threadArchiveAttempt).toMatchObject({
        action: "archive",
        threadId: "thread_a1",
        completed: true,
      });

      await router.accept(message);
      await waitForState(store, (state) => state.processedMessageIds.includes("m_archive_retry"));
      expect(codex.archiveIds).toEqual(["thread_a1"]);
      expect(sender.messages.at(-1)?.text).toContain("**已归档当前 Codex 会话**");
    });
  });

  test("recovers a completed archive after restart without replaying the external action", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-archive-recovery-"));
    let router: MessageRouter | undefined;
    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOWED_USER_IDS: "ou_user",
      });
      const store = new JsonStateStore(config.bridgeStatePath);
      await store.save({
        chats: {
          oc_chat: {
            cwd: "/repo/a",
            threadId: "thread_a1",
            sessionEpoch: "epoch_before_archive",
            chatType: "direct",
            updatedAt: "2026-07-21T00:00:00.000Z",
          },
        },
        jobs: {},
        outbox: {},
        pendingMessages: {
          m_archive_restart: {
            messageId: "m_archive_restart",
            chatId: "oc_chat",
            chatType: "direct",
            sender: { openId: "ou_user" },
            text: "/archive",
            acceptedAt: "2026-07-21T00:00:00.000Z",
            attempts: 1,
            route: "control_no_replay",
            threadArchiveAttempt: {
              action: "archive",
              threadId: "thread_a1",
              startedAt: "2026-07-21T00:00:00.000Z",
              completed: true,
            },
          },
        },
        processedMessageIds: [],
        diagnostics: {},
      });

      const codex = new ListingCodex([]);
      const sender = new IdempotencyCollectingSender();
      router = new MessageRouter(config, store, sender, silentLogger, codex);
      await router.start();
      await waitForState(
        store,
        (state) =>
          state.processedMessageIds.includes("m_archive_restart") &&
          Object.values(state.outbox).some(
            (delivery) =>
              delivery.jobId === "m_archive_restart" && delivery.status === "delivered",
          ),
      );

      const recovered = await store.load();
      expect(codex.archiveIds).toHaveLength(0);
      expect(recovered.chats.oc_chat?.threadId).toBeUndefined();
      expect(recovered.chats.oc_chat?.sessionEpoch).not.toBe("epoch_before_archive");
      expect(sender.messages[0]?.text).toContain("**已归档当前 Codex 会话**");
    } finally {
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("refuses to resume an unavailable listed conversation", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_newer",
        cwd: "/repo/a",
        name: "Newer desktop thread",
        updatedAt: 3_000,
        resumable: false,
        unavailableReason: "会话由 Codex 0.142.3 创建；当前服务使用 0.136.0",
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      await router.enqueue({
        messageId: "m_project",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/project 1",
      });
      await router.enqueue({
        messageId: "m_threads",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/sessions",
      });
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume 1",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "start instead",
      });

      expect(sender.messages[2]?.text).toContain("不可继续");
      expect(sender.messages[3]?.text).toContain("这个 Codex 会话当前不可继续。");
      expect(sender.messages[3]?.text).toContain("0.142.3");
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBeUndefined();
    });
  });

  test("session card actions refuse unavailable conversations", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_newer",
        cwd: "/repo/a",
        name: "Newer desktop thread",
        updatedAt: 3_000,
        resumable: false,
        unavailableReason: "会话由 Codex 0.142.3 创建；当前服务使用 0.136.0",
      },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_projects",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/projects",
      });
      await router.handleCardAction({
        action: "select_project",
        chatId: "oc_chat",
        messageId: "om_projects",
        projectIndex: 1,
        page: 1,
        sender: { openId: "ou_user" },
      });
      await router.enqueue({
        messageId: "m_sessions",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/sessions",
      });

      const response = await router.handleCardAction({
        action: "resume_thread",
        chatId: "oc_chat",
        messageId: "om_sessions",
        threadIndex: 1,
        page: 1,
        sender: { openId: "ou_user" },
      });

      expect(expectToast(response).toast.type).toBe("warning");
      expect(expectToast(response).toast.content).toContain("不可继续");
      expect(codex.runs).toHaveLength(0);
    });
  });

  test("clears a selected thread after Codex cannot read its rollout", async () => {
    const codex = new ResumeReadFailingCodex([
      {
        id: "thread_bad",
        cwd: "/repo/a",
        name: "Bad rollout",
        updatedAt: 3_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_bad",
      });
      await router.enqueue({
        messageId: "m_first",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "continue bad",
      });
      await router.enqueue({
        messageId: "m_second",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "start fresh after clear",
      });

      expect(codex.runs[0]?.threadId).toBe("thread_bad");
      expect(codex.runs[1]?.threadId).toBeUndefined();
      expect(sender.messages.some((message) => message.text.includes("已清除当前 chat"))).toBe(true);
      expect(sender.messages.at(-1)).toMatchObject({
        kind: "markdown",
        text: "fresh done",
      });
    });
  });

  test("new starts a fresh conversation in the selected project", async () => {
    const codex = new ListingCodex([
      {
        id: "thread_a1",
        cwd: "/repo/a",
        name: "A work",
        updatedAt: 3_000,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_resume",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/resume thread_a1",
      });
      await router.enqueue({
        messageId: "m_new",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/new",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "start fresh",
      });

      expect(sender.messages[1]?.kind).toBe("markdown");
      expect(sender.messages[1]?.text).toContain("`/repo/a`");
      expect(codex.runs[0]?.cwd).toBe("/repo/a");
      expect(codex.runs[0]?.threadId).toBeUndefined();
    });
  });

  test("persists an app-server thread binding before the first turn continues", async () => {
    const codex = new EarlyBindingCodex();
    await withRouterAndCodex({}, codex, async ({ router, config }) => {
      await router.accept({
        messageId: "m_early_bind",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "bind before turn",
      });
      await codex.threadBound.promise;

      const state = await new JsonStateStore(config.bridgeStatePath).load();
      expect(codex.turnContinued).toBe(false);
      expect(state.chats.oc_chat?.threadId).toBe("thread_early_bound");
      expect(state.jobs.m_early_bind).toMatchObject({
        status: "running",
        threadId: "thread_early_bound",
      });
      expect(codex.runs[0]?.sessionScope?.sessionEpoch).toBe(
        state.chats.oc_chat?.sessionEpoch,
      );

      codex.continueTurn.resolve();
      await waitForState(
        new JsonStateStore(config.bridgeStatePath),
        (current) => current.jobs.m_early_bind?.status === "completed",
      );
    });
  });

  test("keeps one scope across turns and rotates the principal without trusting missing ids", async () => {
    const codex = new SessionAwareCodex();
    await withRouterAndCodex(
      {
        ALLOW_GROUPS: "true",
        ALLOWED_CHAT_IDS: "oc_group",
        ALLOWED_USER_IDS: "ou_user,ou_other",
      },
      codex,
      async ({ router }) => {
        await router.enqueue({
          messageId: "m_scope_1",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "first turn",
        });
        await router.enqueue({
          messageId: "m_scope_2",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "second turn",
        });
        await router.enqueue({
          messageId: "m_scope_3",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_other" },
          text: "new principal",
        });
        await router.enqueue({
          messageId: "m_scope_no_id",
          chatId: "oc_direct_without_id",
          chatType: "direct",
          sender: {},
          text: "single use only",
        });

        expect(codex.runs[0]?.sessionScope).toBeDefined();
        expect(codex.runs[1]?.sessionScope?.sessionEpoch).toBe(
          codex.runs[0]?.sessionScope?.sessionEpoch,
        );
        expect(codex.runs[1]?.threadId).toBe("thread_session");
        expect(codex.runs[2]?.sessionScope?.sessionEpoch).toBe(
          codex.runs[0]?.sessionScope?.sessionEpoch,
        );
        expect(codex.runs[2]?.sessionScope?.principal.openId).toBe("ou_other");
        expect(codex.runs[3]?.sessionScope).toBeUndefined();
      },
    );
  });

  test("rotates and invalidates app-server sessions at every thread or cwd lifecycle boundary", async () => {
    const codex = new LifecycleCodex([
      {
        id: "thread_source",
        cwd: "/repo/a",
        name: "Source thread",
        updatedAt: 3_000,
      },
    ]);
    await withRouterAndCodex({}, codex, async ({ router, config }) => {
      const projectDir = path.join(config.codexWorkdir, "project-next");
      const cdDir = path.join(config.codexWorkdir, "cwd-next");
      await mkdir(projectDir);
      await mkdir(cdDir);
      const command = (messageId: string, text: string): IncomingTextMessage => ({
        messageId,
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text,
      });

      await router.enqueue(command("m_resume_lifecycle", "/resume thread_source"));
      await router.enqueue(command("m_compact_lifecycle", "/compact"));
      await router.enqueue(command("m_fork_lifecycle", "/fork"));
      await router.enqueue(command("m_new_lifecycle", "/new"));
      await router.enqueue(command("m_project_lifecycle", `/project ${projectDir}`));
      await router.enqueue(command("m_cd_lifecycle", `/cd ${cdDir}`));

      expect(codex.invalidations).toEqual([
        { chatId: "oc_chat", reason: "thread_changed" },
        { chatId: "oc_chat", reason: "thread_compact" },
        { chatId: "oc_chat", reason: "thread_fork" },
        { chatId: "oc_chat", reason: "thread_changed" },
        { chatId: "oc_chat", reason: "session_reset" },
        { chatId: "oc_chat", reason: "project_changed" },
        { chatId: "oc_chat", reason: "cwd_changed" },
      ]);
    });
  });

  test("runs Codex for allowlisted group messages", async () => {
    await withRouter(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group" },
      async ({ router, sender, codex }) => {
        await router.enqueue({
          messageId: "m1",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "run this",
        });

        expect(codex.runs).toHaveLength(1);
        expect(codex.runs[0]?.prompt).toBe("run this");
        expect(sender.messages.map((message) => message.text)).toEqual(["done"]);
        expect(sender.messages.map((message) => message.kind)).toEqual(["markdown"]);
        expect(sender.reactions).toEqual([
          {
            operation: "add",
            chatId: "oc_group",
            messageId: "m1",
            reaction: "processing",
          },
          {
            operation: "remove",
            chatId: "oc_group",
            messageId: "m1",
            reaction: "processing",
          },
        ]);
      },
    );
  });

  test("strips the leading bot mention before passing an allowlisted group prompt to Codex", async () => {
    await withRouter(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group" },
      async ({ router, codex }) => {
        await router.enqueue({
          messageId: "m1",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 run this",
        });

        expect(codex.runs[0]?.prompt).toBe("run this");
      },
    );
  });

  test("allows direct messages to switch outside group roots", async () => {
    await withRouter({}, async ({ router, codex }) => {
      await router.enqueue({
        messageId: "m_cd",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/cd /tmp",
      });
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run outside default workdir",
      });

      expect(codex.runs[0]?.cwd).toBe(await realpath("/tmp"));
    });
  });

  test("limits group cwd changes to the configured group roots", async () => {
    await withRouter(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group" },
      async ({ router, sender, codex, config }) => {
        const allowedProject = path.join(config.codexWorkdir, "team-project");
        await mkdir(allowedProject, { recursive: true });

        await router.enqueue({
          messageId: "m_denied",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 /cd /tmp",
        });
        await router.enqueue({
          messageId: "m_allowed",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: `@_user_1 /cd ${allowedProject}`,
        });
        await router.enqueue({
          messageId: "m_run",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 run inside allowed root",
        });

        expect(sender.messages[0]?.text).toContain("当前群聊不能使用这个目录");
        expect(codex.runs).toHaveLength(1);
        expect(codex.runs[0]?.cwd).toBe(await realpath(allowedProject));
      },
    );
  });

  test("rejects group cwd changes that escape an allowed root through a symlink", async () => {
    await withRouter(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group" },
      async ({ router, sender, codex, config }) => {
        const escapeLink = path.join(config.codexWorkdir, "escape-link");
        await symlink(os.tmpdir(), escapeLink);

        await router.enqueue({
          messageId: "m_symlink",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: `@_user_1 /cd ${escapeLink}`,
        });

        expect(codex.runs).toHaveLength(0);
        expect(sender.messages.at(-1)?.text).toContain("当前群聊不能使用这个目录");
      },
    );
  });

  test("sends throttled Codex progress updates", async () => {
    const codex = new FakeCodex([
      {
        kind: "running",
        text: "Codex 正在处理。",
      },
      {
        kind: "running",
        text: "Codex 正在调用工具。",
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run with progress",
      });

      expect(sender.messages.map((message) => message.text)).toEqual([
        "Codex 正在处理。",
        "done",
      ]);
      expect(sender.messages.map((message) => message.kind)).toEqual([
        "text",
        "markdown",
      ]);
      expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
        { operation: "add", reaction: "processing" },
        { operation: "remove", reaction: "processing" },
      ]);
    });
  });

  test("uses ordinary text progress instead of a mutable run-status card", async () => {
    const codex = new FakeCodex([
      {
        kind: "running",
        text: "Codex 正在处理。",
      },
      {
        kind: "running",
        text: "Codex 正在调用工具。",
      },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run with card progress",
      });

      expect(sender.cards).toHaveLength(0);
      expect(sender.cardUpdates).toHaveLength(0);
      expect(sender.messages.map((message) => message.text)).toEqual([
        "Codex 正在处理。",
        "done",
      ]);
      expect(sender.messages.map((message) => message.kind)).toEqual(["text", "markdown"]);
      expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
        { operation: "add", reaction: "processing" },
        { operation: "remove", reaction: "processing" },
      ]);
    });
  });

  test("drains an in-flight progress message before sending the final answer", async () => {
    const codex = new FakeCodex([
      {
        kind: "running",
        text: "Codex 正在调用工具。",
      },
    ]);
    const sender = new DelayedTextSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_progress_order",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run with delayed progress",
      });

      await sender.sendStarted.promise;
      expect(sender.messages).toHaveLength(0);
      sender.releaseSend.resolve();
      await running;

      expect(sender.messages.map((message) => message.text)).toEqual([
        "Codex 正在调用工具。",
        "done",
      ]);
    });
  });

  test("suppresses progress callbacks that arrive after the run is terminal", async () => {
    let runInput: CodexRunInput | undefined;
    const codex: CodexClient = {
      async run(input) {
        runInput = input;
        return {
          threadId: "thread_test",
          finalText: "done",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_late_progress",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "finish before late progress",
      });

      await runInput?.onProgress?.({
        kind: "running",
        text: "this progress is stale",
      });
      expect(sender.messages.map((message) => message.text)).toEqual(["done"]);
    });
  });

  test("records rich run results and serves detail commands", async () => {
    const codex = new RichResultCodex();
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "make a small edit",
      });

      expect(sender.cards).toHaveLength(0);
      expect(sender.cardUpdates).toHaveLength(0);

      for (const [command, expected] of [
        ["/summary", "状态：success"],
        ["/files", "src/app.ts"],
        ["/diff", "diff --git a/src/app.ts b/src/app.ts"],
        ["/logs", "bun test"],
        ["/usage", "累计占 context：10.0%"],
      ] as const) {
        await router.enqueue({
          messageId: `m_${command.slice(1)}`,
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: command,
        });
        expect(sender.messages.at(-1)?.text).toContain(expected);
        if (command === "/files") {
          expect(sender.messages.at(-1)?.text).not.toContain(path.join(config.codexWorkdir, "src/app.ts"));
        }
      }

    });
  });

  test("steer bypasses the queue and sends guidance to the active run", async () => {
    const codex = new SteerableCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const running = router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long running task",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m_steer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/steer focus on tests",
      });

      expect(codex.steers).toEqual(["focus on tests"]);
      expect(sender.messages.at(-1)?.text).toContain("已把补充指令发送给当前 Codex 任务");

      await router.enqueue({
        messageId: "m_stop",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;
    });
  });

  test("steer queues guidance when the active run control is not ready yet", async () => {
    const codex = new DelayedSteerableCodex(50);
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const running = router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long running task",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m_steer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/steer focus on tests",
      });

      expect(sender.messages.at(-1)?.text).toContain("已暂存这条补充指令");
      await waitFor(() => codex.steers.length === 1);
      expect(codex.steers).toEqual(["focus on tests"]);
      expect(sender.messages.at(-1)?.text).toContain("已把暂存的补充指令发送给当前 Codex 任务");

      await router.enqueue({
        messageId: "m_stop",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;
    });
  });

  test("steer queues guidance while a run is starting but not active yet", async () => {
    const codex = new DelayedSteerableCodex(20);
    const sender = new DelayedReactionSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long running task",
      });
      await sender.createStarted.promise;

      await router.enqueue({
        messageId: "m_steer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/steer focus on tests",
      });

      expect(sender.messages.at(-1)?.text).toContain("正在排队或启动");
      expect(codex.steers).toEqual([]);

      sender.releaseCreate.resolve();
      await waitFor(() => codex.steers.length === 1);
      expect(codex.steers).toEqual(["focus on tests"]);
      expect(sender.messages.at(-1)?.text).toContain("已把暂存的补充指令发送给当前 Codex 任务");

      await router.enqueue({
        messageId: "m_stop",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;
    });
  });

  test("steer hides transient app-server wording when steering is rejected", async () => {
    const codex = new FailingSteerCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const running = router.enqueue({
        messageId: "m_run",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long running task",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m_steer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/steer focus on tests",
      });

      expect(sender.messages.at(-1)?.text).toContain("当前 Codex 任务暂时不能接收补充指令");
      expect(sender.messages.at(-1)?.text).not.toContain("no active turn to steer");

      await router.enqueue({
        messageId: "m_stop",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;
    });
  });

  test("downloads attachments and appends local paths to the Codex prompt", async () => {
    const sender = new AttachmentCollectingSender();
    await withRouterAndSender({}, new FakeCodex(), sender, async ({ router, codex, config }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "summarize this",
        attachments: [
          {
            kind: "file",
            key: "file_v2_test",
            name: "report.pdf",
          },
        ],
      });

      expect(sender.downloads).toEqual([
        {
          messageId: "m1",
          attachment: {
            kind: "file",
            key: "file_v2_test",
            name: "report.pdf",
          },
        },
      ]);
      expect(codex.runs[0]?.prompt).toBe(
        [
          "summarize this",
          "",
          "本地附件路径：",
          `- 文件 report.pdf: ${path.join(config.attachmentDownloadDir, "m1", "report.pdf")}`,
        ].join("\n"),
      );
    });
  });

  test("uses a default prompt for attachment-only messages", async () => {
    const sender = new AttachmentCollectingSender();
    await withRouterAndSender({}, new FakeCodex(), sender, async ({ router, codex, config }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "",
        attachments: [
          {
            kind: "image",
            key: "img_v3_test",
          },
        ],
      });

      expect(codex.runs[0]?.prompt).toBe(
        [
          "请查看并处理下面的图片。",
          "",
          "本地附件路径：",
          `- 图片: ${path.join(config.attachmentDownloadDir, "m1", "img_v3_test")}`,
        ].join("\n"),
      );
    });
  });

  test("rejects attachment counts before starting any download", async () => {
    const sender = new AttachmentCollectingSender();
    await withRouterAndSender(
      { ATTACHMENT_MAX_COUNT: "1" },
      new FakeCodex(),
      sender,
      async ({ router, codex }) => {
        await router.enqueue({
          messageId: "m_too_many_attachments",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "process both",
          attachments: [
            { kind: "file", key: "first", name: "first.txt" },
            { kind: "file", key: "second", name: "second.txt" },
          ],
        });

        expect(sender.downloads).toHaveLength(0);
        expect(codex.runs).toHaveLength(0);
        expect(sender.messages.at(-1)?.text).toContain("附件数量超过上限");
      },
    );
  });

  test("removes the current batch when attachment message bytes exceed the quota", async () => {
    const sender = new AttachmentCollectingSender();
    sender.contentsByKey.set("first", "1234");
    sender.contentsByKey.set("second", "5678");
    await withRouterAndSender(
      {
        ATTACHMENT_MAX_FILE_BYTES: "5",
        ATTACHMENT_MAX_TOTAL_BYTES: "6",
        ATTACHMENT_STORE_MAX_BYTES: "100",
      },
      new FakeCodex(),
      sender,
      async ({ router, codex }) => {
        await router.enqueue({
          messageId: "m_attachment_total",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "process both",
          attachments: [
            { kind: "file", key: "first", name: "first.txt" },
            { kind: "file", key: "second", name: "second.txt" },
          ],
        });

        expect(sender.downloads).toHaveLength(2);
        expect(codex.runs).toHaveLength(0);
        expect(sender.messages.at(-1)?.text).toContain("per-message limit");
        for (const filePath of sender.downloadedPaths) {
          await expect(Bun.file(filePath).exists()).resolves.toBe(false);
        }
      },
    );
  });

  test("does not run Codex when the sender cannot download attachments", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "summarize this",
        attachments: [
          {
            kind: "file",
            key: "file_v2_test",
            name: "report.pdf",
          },
        ],
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages.map((message) => message.text)).toEqual([
        "当前聊天适配器暂不支持下载附件。",
      ]);
    });
  });

  test("summarizes non-zero Codex exits with context and hints", async () => {
    const codex = new FailingCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run and fail",
      });

      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("Codex 运行失败。");
      expect(sender.messages[0]?.text).toContain("exit: code=2");
      expect(sender.messages[0]?.text).toContain("cwd:");
      expect(sender.messages[0]?.text).toContain("fatal: not a git repository");
      expect(sender.messages[0]?.text).toContain("CODEX_SKIP_GIT_REPO_CHECK=true");
    });
  });

  test("replaces the processing reaction with a failure reaction", async () => {
    const codex = new FailingCodex();
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run and fail",
      });

      expect(sender.cards).toHaveLength(0);
      expect(sender.cardUpdates).toHaveLength(0);
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("Codex 运行失败。");
      expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
        { operation: "add", reaction: "processing" },
        { operation: "remove", reaction: "processing" },
        { operation: "add", reaction: "failure" },
      ]);
    });
  });

  test("summarizes Codex startup failures with service-friendly hints", async () => {
    const codex = new ThrowingCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run but codex is missing",
      });

      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("Codex 启动失败。");
      expect(sender.messages[0]?.text).toContain("command: codex");
      expect(sender.messages[0]?.text).toContain("spawn codex ENOENT");
      expect(sender.messages[0]?.text).toContain("CODEX_BIN");
      expect(sender.messages[0]?.text).toContain("PATH");
    });
  });

  test("resets a deleted session cwd without running the task in another workspace", async () => {
    const codex = new ThrowingCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender, config }) => {
      const temporaryCwd = path.join(config.codexWorkdir, "temporary-workspace");
      await mkdir(temporaryCwd);
      const storedCwd = await realpath(temporaryCwd);
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/cd ${temporaryCwd}`,
      });
      await rm(temporaryCwd, { recursive: true, force: true });
      sender.messages.length = 0;

      await router.enqueue({
        messageId: "m2",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "do not run in the wrong workspace",
      });

      expect(codex.runs).toHaveLength(1);
      expect(codex.runs[0]?.cwd).toBe(storedCwd);
      expect(sender.messages.at(-1)?.text).toContain(
        `当前 cwd 不存在：${storedCwd}`,
      );
      expect(sender.messages.at(-1)?.text).toContain(
        `已切回默认 cwd：${config.codexWorkdir}`,
      );

      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(persisted.chats.oc_chat?.cwd).toBe(config.codexWorkdir);
      expect(persisted.diagnostics.byChat?.oc_chat?.recentFailures?.at(-1)?.category).toBe(
        "cwd_missing",
      );
    });
  });

  test("reports when stop is requested without an active run", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages.map((message) => message.text)).toEqual([
        "当前 chat 没有正在运行的 Codex 任务。",
      ]);
    });
  });

  test("stop bypasses the chat queue and aborts the active Codex run", async () => {
    const codex = new BlockingCodex();
    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long task",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m2",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;

      expect(codex.abortCount).toBe(1);
      expect(sender.messages.map((message) => message.text)).toEqual([
        "已请求停止当前 chat 的 Codex 任务。",
      ]);
      expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
        { operation: "add", reaction: "processing" },
        { operation: "remove", reaction: "processing" },
      ]);
    });
  });

  test("removes the processing reaction when a run is stopped", async () => {
    const codex = new BlockingCodex();
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long task",
      });
      await waitFor(() => codex.runs.length === 1);

      await router.enqueue({
        messageId: "m2",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/stop",
      });
      await running;

      expect(sender.cards).toHaveLength(0);
      expect(sender.cardUpdates).toHaveLength(0);
      expect(sender.messages.map((message) => message.text)).toEqual([
        "已请求停止当前 chat 的 Codex 任务。",
      ]);
      expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
        { operation: "add", reaction: "processing" },
        { operation: "remove", reaction: "processing" },
      ]);
    });
  });

  test("run timeout aborts the task and records a recent failure", async () => {
    const codex = new BlockingCodex();
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { CODEX_RUN_TIMEOUT_MS: "10" },
      codex,
      sender,
      async ({ router }) => {
        await router.enqueue({
          messageId: "m1",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "long task",
        });

        expect(codex.abortCount).toBe(1);
        expect(sender.cards).toHaveLength(0);
        expect(sender.cardUpdates).toHaveLength(0);
        expect(sender.messages.at(-1)?.text).toContain("CODEX_RUN_TIMEOUT_MS=10");
        expect(sender.reactions.map(({ operation, reaction }) => ({ operation, reaction }))).toEqual([
          { operation: "add", reaction: "processing" },
          { operation: "remove", reaction: "processing" },
          { operation: "add", reaction: "failure" },
        ]);

        await router.enqueue({
          messageId: "m_status",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        expect(sender.messages.at(-1)?.text).toContain("run_timeout");
      },
    );
  });

  test("card stop action aborts the active run without sending chat text", async () => {
    const codex = new BlockingCodex();
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "long task",
      });
      await waitFor(() => codex.runs.length === 1);

      const response = await router.handleCardAction({
        action: "stop_run",
        chatId: "oc_chat",
        messageId: "om_1",
        sender: { openId: "ou_user" },
      });
      await running;

      expect(response).toEqual({
        kind: "toast",
        level: "success",
        text: "已请求停止当前 chat 的 Codex 任务。",
      });
      expect(codex.abortCount).toBe(1);
      expect(sender.cards).toHaveLength(0);
      expect(sender.cardUpdates).toHaveLength(0);
      expect(sender.messages).toHaveLength(0);
    });
  });

  test("card stop action reports when there is no active run", async () => {
    await withRouter({}, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "quick task",
      });
      sender.messages.length = 0;

      const response = await router.handleCardAction({
        action: "stop_run",
        chatId: "oc_chat",
        messageId: "om_1",
        sender: { openId: "ou_user" },
      });

      expect(response).toEqual({
        kind: "toast",
        level: "warning",
        text: "当前 chat 没有正在运行的 Codex 任务。",
      });
      expect(sender.messages).toHaveLength(0);
    });
  });

  test("card stop action respects allowed user ids", async () => {
    const codex = new BlockingCodex();
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_allowed" },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m1",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_allowed" },
          text: "long task",
        });
        await waitFor(() => codex.runs.length === 1);

        const rejected = await router.handleCardAction({
          action: "stop_run",
          chatId: "oc_chat",
          messageId: "om_1",
          sender: { openId: "ou_other" },
        });

        expect(expectToast(rejected).toast.type).toBe("error");
        expect(codex.abortCount).toBe(0);

        await router.handleCardAction({
          action: "stop_run",
          chatId: "oc_chat",
          messageId: "om_1",
          sender: { openId: "ou_allowed" },
        });
        await running;
      },
    );
  });

  test("approval card action resolves the pending Codex approval decision", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      cwd: "/tmp/chat2codex",
      reason: "requires approval by policy",
      decisions: ["accept", "acceptForSession", "decline"],
    };
    const codex = new ApprovalCodex(request);
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run command",
      });
      await waitFor(() => sender.approvalCards.length === 1);

      const response = await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_1",
        decisionIndex: 1,
        sender: { openId: "ou_user" },
      });
      await running;

      const renderedResponse = renderFeishuActionForTest(response);
      expect(renderedResponse).toMatchObject({
        card: {
          type: "raw",
          data: {
            header: {
              title: {
                content: "Codex 审批已处理",
              },
            },
          },
        },
      });
      expect(JSON.stringify(renderedResponse)).toContain("已选择：Approve session。");
      expect(JSON.stringify(renderedResponse)).not.toContain("resolve_approval");
      expect(codex.decision).toBe("acceptForSession");
      expect(sender.approvalCards[0]?.input.request.decisions).toEqual([
        "accept",
        "acceptForSession",
        "decline",
      ]);
      expect(sender.approvalCardUpdates.at(-1)?.input).toMatchObject({
        status: "resolved",
        decision: "acceptForSession",
      });
      expect(sender.messages.at(-1)).toMatchObject({
        kind: "markdown",
        text: "decision=acceptForSession",
      });
    });
  });

  test("resolves text-only approvals by reply code and original decision index", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_text_1",
      kind: "command",
      command: "bun test",
      cwd: "/tmp/chat2codex",
      proposedExecpolicyAmendment: ["bun", "test"],
      decisions: [
        "accept",
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["bun", "test"],
          },
        },
        "cancel",
      ],
    };
    const codex = new ApprovalCodex(request);
    const sender = new CollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_approval_text",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run tests",
      });
      await waitFor(() =>
        sender.messages.some((message) => message.text.includes("/approve")),
      );
      const prompt = sender.messages.find((message) =>
        message.text.includes("/approve"),
      )?.text;
      expect(prompt).toContain("【命令】\nbun test");
      expect(prompt).toContain("1. 仅本次允许（Approve）");
      expect(prompt).toContain("2. 允许并保存命令规则（Approve rule）");
      expect(prompt).toContain("3. 拒绝并取消本轮（Cancel turn）");
      expect(prompt).toContain("/permit 仅用于 Codex 单独发出的");
      expect(prompt).not.toContain('"acceptWithExecpolicyAmendment"');
      expect(prompt).not.toContain("【命令分析】");
      expect(prompt).not.toContain("【建议命令规则】");
      const replyCode = /\/approve ([a-f0-9]{8})/u.exec(prompt ?? "")?.[1];
      expect(replyCode).toBeTruthy();

      await router.enqueue({
        messageId: "m_approval_wrong_user",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_other" },
        text: `/approve ${replyCode} 1`,
      });
      expect(codex.decision).toBeUndefined();

      await router.enqueue({
        messageId: "m_approval_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/approve ${replyCode} 1`,
      });
      await running;
      expect(codex.decision).toBe("accept");

      await router.enqueue({
        messageId: "m_approval_late_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/approve ${replyCode} 3`,
      });
      expect(sender.messages.at(-1)?.text).toContain("回复码无效");
    });
  });

  test("approval card action rejects a mismatched card message id", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run command",
      });
      await waitFor(() => sender.approvalCards.length === 1);

      const rejected = await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: "oma_wrong",
        approvalId: "approval_1",
        decisionIndex: 0,
        sender: { openId: "ou_user" },
      });

      expect(expectToast(rejected).toast).toMatchObject({
        type: "warning",
        content: "无法处理审批：卡片上下文不匹配。",
      });
      expect(codex.decision).toBeUndefined();

      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_1",
        decisionIndex: 1,
        sender: { openId: "ou_user" },
      });
      await running;
      expect(codex.decision).toBe("decline");
    });
  });

  test("keeps identical approval request ids isolated by chat", async () => {
    const codex = new ApprovalCodex({
      id: "approval_shared",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      const firstCwd = path.join(config.codexWorkdir, "first");
      const secondCwd = path.join(config.codexWorkdir, "second");
      await Promise.all([
        mkdir(firstCwd, { recursive: true }),
        mkdir(secondCwd, { recursive: true }),
      ]);
      await Promise.all([
        router.enqueue({
          messageId: "m_cd_first",
          chatId: "oc_first",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: `/cd ${firstCwd}`,
        }),
        router.enqueue({
          messageId: "m_cd_second",
          chatId: "oc_second",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: `/cd ${secondCwd}`,
        }),
      ]);

      const firstRun = router.enqueue({
        messageId: "m_first",
        chatId: "oc_first",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "first command",
      });
      const secondRun = router.enqueue({
        messageId: "m_second",
        chatId: "oc_second",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "second command",
      });
      await waitFor(() => sender.approvalCards.length === 2);

      const firstCard = sender.approvalCards.find((card) => card.chatId === "oc_first");
      const secondCard = sender.approvalCards.find((card) => card.chatId === "oc_second");
      expect(firstCard).toBeDefined();
      expect(secondCard).toBeDefined();

      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_first",
        messageId: firstCard?.handle.messageId,
        approvalId: "approval_shared",
        decisionIndex: 0,
        sender: { openId: "ou_user" },
      });
      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_second",
        messageId: secondCard?.handle.messageId,
        approvalId: "approval_shared",
        decisionIndex: 1,
        sender: { openId: "ou_user" },
      });
      await Promise.all([firstRun, secondRun]);

      expect(codex.decisions).toEqual(
        expect.arrayContaining([
          { prompt: "first command", decision: "accept" },
          { prompt: "second command", decision: "decline" },
        ]),
      );
    });
  });

  test("rejects card callbacks for approval decisions hidden by disclosure guards", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_file_1",
      kind: "file_change",
      reason: "write outside the current root",
      grantRoot: "/private/project",
      decisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
    const codex = new ApprovalCodex(request);
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "edit file",
      });
      await waitFor(() => sender.approvalCards.length === 1);

      const rejected = await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_file_1",
        decisionIndex: 0,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(rejected).toast).toMatchObject({
        type: "warning",
        content: "无法处理审批：该选项未通过安全披露校验。",
      });
      expect(codex.decision).toBeUndefined();

      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_file_1",
        decisionIndex: 2,
        sender: { openId: "ou_user" },
      });
      await running;
      expect(codex.decision).toBe("decline");
    });
  });

  test("status reports pending approval wait details", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      cwd: "/tmp/chat2codex",
      decisions: ["accept", "decline", "cancel"],
    };
    const codex = new ApprovalCodex(request);
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run command",
      });
      await waitFor(() => sender.approvalCards.length === 1);

      await router.enqueue({
        messageId: "m_status",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/status",
      });

      const status = sender.messages.at(-1)?.text ?? "";
      expect(status).toContain("• 命令审批：1 条待处理");
      expect(status).not.toContain("rm -rf build");

      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_1",
        decisionIndex: 2,
        sender: { openId: "ou_user" },
      });
      await running;
    });
  });

  test("approval timeout cancels the request and records a recent failure", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "cancel"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { CODEX_APPROVAL_TIMEOUT_MS: "10" },
      codex,
      sender,
      async ({ router }) => {
        await router.enqueue({
          messageId: "m1",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "run command",
        });

        expect(codex.decision).toBe("cancel");
        expect(sender.approvalCardUpdates.at(-1)?.input).toMatchObject({
          status: "cancelled",
        });

        await router.enqueue({
          messageId: "m_status",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        const status = sender.messages.at(-1)?.text ?? "";
        expect(status).toContain("approval_timeout");
        expect(status).toContain("CODEX_APPROVAL_TIMEOUT_MS=10");
      },
    );
  });

  test("group messages require an allowed user before an approval can start", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group", ALLOWED_USER_IDS: "" },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m1",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 run command",
        });
        await running;

        expect(sender.approvalCards).toHaveLength(0);
        expect(codex.runs).toHaveLength(0);
        expect(codex.decision).toBeUndefined();
      },
    );
  });

  test("an allowlisted group member cannot approve another member's Codex request", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      {
        ALLOW_GROUPS: "true",
        ALLOWED_CHAT_IDS: "oc_group",
        ALLOWED_USER_IDS: "ou_origin,ou_other",
      },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m1",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_origin" },
          text: "@_user_1 run command",
        });
        await waitFor(() => sender.approvalCards.length === 1);

        const rejected = await router.handleCardAction({
          action: "resolve_approval",
          chatId: "oc_group",
          messageId: sender.approvalCards[0]?.handle.messageId,
          approvalId: "approval_1",
          decisionIndex: 0,
          sender: { openId: "ou_other" },
        });
        expect(expectToast(rejected).toast).toMatchObject({
          type: "error",
          content: "只有发起当前 Codex 任务的用户可以处理这条审批请求。",
        });
        expect(codex.decision).toBeUndefined();

        await router.handleCardAction({
          action: "resolve_approval",
          chatId: "oc_group",
          messageId: sender.approvalCards[0]?.handle.messageId,
          approvalId: "approval_1",
          decisionIndex: 1,
          sender: { openId: "ou_origin" },
        });
        await running;
        expect(codex.decision).toBe("decline");
      },
    );
  });

  test("marks a late approval card cancelled when the Codex run already finished", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_1",
      kind: "file_change",
      reason: "requires file change approval",
      decisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
    const sender = new DelayedApprovalCardSender();
    const codex = new CompletingBeforeApprovalCardCodex(
      request,
      () => sender.createStarted.promise,
    );

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "edit file",
      });

      await sender.createStarted.promise;
      await running;
      expect(sender.approvalCards).toHaveLength(0);

      sender.releaseCreate.resolve();
      await waitFor(
        () => sender.approvalCards.length === 1 && sender.approvalCardUpdates.length === 1,
      );

      expect(sender.approvalCardUpdates[0]?.handle).toEqual(sender.approvalCards[0]?.handle);
      expect(sender.approvalCardUpdates[0]?.input).toMatchObject({
        status: "cancelled",
        request,
      });
      expect(sender.messages.at(-1)).toMatchObject({
        kind: "markdown",
        text: "done",
      });
    });
  });

  test("rejects approval actions until the card message id is known", async () => {
    const request: CodexApprovalRequest = {
      id: "approval_1",
      kind: "command",
      command: "rm -- smoke.txt",
      decisions: ["accept", "cancel"],
    };
    const sender = new DelayedApprovalCardSender();
    const codex = new ApprovalCodex(request);

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "delete file",
      });

      await sender.createStarted.promise;
      const response = await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: "oma_1",
        approvalId: "approval_1",
        decisionIndex: 0,
        sender: { openId: "ou_user" },
      });

      expect(expectToast(response).toast).toMatchObject({
        type: "warning",
        content: "无法处理审批：卡片上下文不匹配。",
      });
      expect(codex.decision).toBeUndefined();
      expect(sender.approvalCardUpdates).toHaveLength(0);

      sender.releaseCreate.resolve();
      await waitFor(() => sender.approvalCards.length === 1);
      await router.handleCardAction({
        action: "resolve_approval",
        chatId: "oc_chat",
        messageId: sender.approvalCards[0]?.handle.messageId,
        approvalId: "approval_1",
        decisionIndex: 0,
        sender: { openId: "ou_user" },
      });
      await running;

      expect(codex.decision).toBe("accept");
      expect(sender.approvalCardUpdates[0]?.handle).toEqual(sender.approvalCards[0]?.handle);
      expect(sender.approvalCardUpdates[0]?.input).toMatchObject({
        status: "resolved",
        request,
        decision: "accept",
      });
    });
  });

  test("approval card action respects allowed user ids", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_allowed" },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m1",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_allowed" },
          text: "run command",
        });
        await waitFor(() => sender.approvalCards.length === 1);

        const rejected = await router.handleCardAction({
          action: "resolve_approval",
          chatId: "oc_chat",
          messageId: sender.approvalCards[0]?.handle.messageId,
          approvalId: "approval_1",
          decisionIndex: 0,
          sender: { openId: "ou_other" },
        });
        expect(expectToast(rejected).toast.type).toBe("error");
        expect(codex.decision).toBeUndefined();

        await router.handleCardAction({
          action: "resolve_approval",
          chatId: "oc_chat",
          messageId: sender.approvalCards[0]?.handle.messageId,
          approvalId: "approval_1",
          decisionIndex: 1,
          sender: { openId: "ou_allowed" },
        });
        await running;

        expect(codex.decision).toBe("decline");
      },
    );
  });

  test("answers requestUserInput cards one question at a time and validates card context", async () => {
    const request: CodexUserInputRequest = {
      id: "input_1",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment should be used?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Staging", description: "Use staging." },
            { label: "Production", description: "Use production." },
          ],
        },
        {
          id: "note",
          header: "Note",
          question: "Any extra note?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    };
    const codex = new UserInputCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_input_card",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });
      await waitFor(() => sender.userInputCards.length === 1);
      const handle = sender.userInputCards[0]!.handle;

      const wrongSender = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "environment",
        optionIndex: 1,
        sender: { openId: "ou_other" },
      });
      expect(expectToast(wrongSender).toast.type).toBe("error");

      const wrongCard = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: "om_forged",
        userInputId: request.id,
        questionId: "environment",
        optionIndex: 1,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(wrongCard).toast.type).toBe("warning");

      const wrongQuestion = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "note",
        optionIndex: 0,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(wrongQuestion).toast.type).toBe("warning");

      const wrongOption = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "environment",
        optionIndex: 9,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(wrongOption).toast.type).toBe("warning");

      const nextQuestion = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "environment",
        optionIndex: 1,
        sender: { openId: "ou_user" },
      });
      expectReplacementView(nextQuestion, "user_input");
      expect(JSON.stringify(nextQuestion)).toContain("Any extra note?");
      expect(codex.response).toBeUndefined();
      expect(sender.userInputCardUpdates.at(-1)?.input).toMatchObject({
        status: "pending",
        answers: { environment: { answers: [] } },
      });

      const resolved = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "note",
        sender: { openId: "ou_user" },
      });
      expectReplacementView(resolved, "user_input");
      await running;

      expect(codex.runs).toHaveLength(1);
      expect(codex.response).toEqual({
        answers: {
          environment: { answers: ["Production"] },
          note: { answers: [] },
        },
      });
      expect(sender.userInputCardUpdates.at(-1)?.input).toMatchObject({
        status: "resolved",
        answers: {
          environment: { answers: [] },
          note: { answers: [] },
        },
      });
    });
  });

  test("binds requestUserInput cancellation to the original group sender", async () => {
    const request: CodexUserInputRequest = {
      id: "input_group",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [{
        id: "confirm",
        header: "Confirm",
        question: "Continue?",
        isOther: false,
        isSecret: false,
        options: [{ label: "Yes", description: "Continue." }],
      }],
    };
    const codex = new UserInputCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      {
        ALLOW_GROUPS: "true",
        ALLOWED_CHAT_IDS: "oc_group",
        ALLOWED_USER_IDS: "ou_user,ou_other",
      },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m_input_group",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "ask me",
        });
        await waitFor(() => sender.userInputCards.length === 1);
        const handle = sender.userInputCards[0]!.handle;

        const rejected = await router.handleCardAction({
          action: "cancel_user_input",
          chatId: "oc_group",
          messageId: handle.messageId,
          userInputId: request.id,
          sender: { openId: "ou_other" },
        });
        expect(expectToast(rejected).toast.type).toBe("error");
        expect(codex.response).toBeUndefined();

        const cancelled = await router.handleCardAction({
          action: "cancel_user_input",
          chatId: "oc_group",
          messageId: handle.messageId,
          userInputId: request.id,
          sender: { openId: "ou_user" },
        });
        expectReplacementView(cancelled, "user_input");
        await running;

        expect(codex.response).toEqual({ answers: {} });
        expect(sender.userInputCardUpdates.at(-1)?.input.status).toBe("cancelled");
      },
    );
  });

  test("handles /answer immediately without persisting or echoing answer content", async () => {
    const request: CodexUserInputRequest = {
      id: "input_text",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Choose a color.",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Red", description: "Use red." },
            { label: "Blue", description: "Use blue." },
          ],
        },
        {
          id: "detail",
          header: "Detail",
          question: "Give a detail.",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    };
    const codex = new UserInputCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_user,ou_other" },
      codex,
      sender,
      async ({ router, config }) => {
      const running = router.enqueue({
        messageId: "m_input_text",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });
      await waitFor(() => sender.userInputCards.length === 1);
      const replyCode = sender.userInputCards[0]!.input.replyCode;

      await router.enqueue({
        messageId: "m_wrong_user_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_other" },
        text: `/answer ${replyCode} Blue`,
      });
      expect(codex.response).toBeUndefined();
      expect(sender.messages.at(-1)?.text).toContain("发起当前 Codex 任务的用户");

      await router.enqueue({
        messageId: "m_long_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/answer ${replyCode} ${"x".repeat(4_001)}`,
      });
      expect(codex.response).toBeUndefined();
      expect(sender.messages.at(-1)?.text).toContain("4000");

      await router.enqueue({
        messageId: "m_bad_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/answer ${replyCode} Purple`,
      });
      expect(codex.response).toBeUndefined();
      expect(sender.messages.at(-1)?.text).toContain("可选项");

      await router.enqueue({
        messageId: "m_color_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/answer ${replyCode} Blue`,
      });
      expect(codex.response).toBeUndefined();

      const privateAnswer = "private phrase 93f15";
      const answerMessage: IncomingTextMessage = {
        messageId: "m_private_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/answer ${replyCode} ${privateAnswer}`,
      };
      await router.accept(answerMessage);
      await router.accept(answerMessage);
      await running;

      expect(codex.runs).toHaveLength(1);
      expect(codex.response).toEqual({
        answers: {
          color: { answers: ["Blue"] },
          detail: { answers: [privateAnswer] },
        },
      });
      expect(sender.messages.every((message) => !message.text.includes(privateAnswer))).toBe(true);
      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(JSON.stringify(persisted)).not.toContain(privateAnswer);
      expect(persisted.processedMessageIds.filter((id) => id === answerMessage.messageId)).toHaveLength(1);
      },
    );
  });

  test("fails secret requestUserInput closed without creating a card", async () => {
    const secretQuestion = "Paste the production password";
    const codex = new UserInputCodex({
      id: "input_secret",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [{
        id: "password",
        header: "Password",
        question: secretQuestion,
        isOther: true,
        isSecret: true,
        options: null,
      }],
    });
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.enqueue({
        messageId: "m_input_secret",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask for a secret",
      });

      expect(codex.response).toEqual({ answers: {} });
      expect(sender.userInputCards).toHaveLength(0);
      expect(sender.messages.some((message) => message.text.includes("敏感输入"))).toBe(true);
      expect(sender.messages.every((message) => !message.text.includes(secretQuestion))).toBe(true);
      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(JSON.stringify(persisted)).not.toContain(secretQuestion);
    });
  });

  test("expires requestUserInput on its request signal and rejects late answers", async () => {
    const request: CodexUserInputRequest = {
      id: "input_expired",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: 10_000,
      questions: [{
        id: "choice",
        header: "Choice",
        question: "Choose.",
        isOther: false,
        isSecret: false,
        options: [{ label: "One", description: "The first option." }],
      }],
    };
    const codex = new UserInputCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_input_expired",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });
      await waitFor(() => sender.userInputCards.length === 1);
      const handle = sender.userInputCards[0]!.handle;

      codex.abortRequest();
      await running;
      expect(codex.response).toEqual({ answers: {} });
      expect(sender.userInputCardUpdates.at(-1)?.input.status).toBe("expired");

      const late = await router.handleCardAction({
        action: "answer_user_input",
        chatId: "oc_chat",
        messageId: handle.messageId,
        userInputId: request.id,
        questionId: "choice",
        optionIndex: 0,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(late).toast.type).toBe("warning");
    });
  });

  test("falls back to /answer text when requestUserInput card creation fails", async () => {
    const request: CodexUserInputRequest = {
      id: "input_fallback",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [{
        id: "detail",
        header: "Detail",
        question: "Provide a detail.",
        isOther: true,
        isSecret: false,
        options: null,
      }],
    };
    const codex = new UserInputCodex(request);
    const sender = new FailingUserInputCardSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_input_fallback",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });
      await waitFor(() => sender.userInputCardAttempts.length === 1);
      await waitFor(() => sender.messages.some((message) => message.text.includes("/answer")));
      const replyCode = sender.userInputCardAttempts[0]!.input.replyCode;

      await router.enqueue({
        messageId: "m_fallback_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/answer ${replyCode} fallback detail`,
      });
      await running;

      expect(codex.runs).toHaveLength(1);
      expect(codex.response).toEqual({
        answers: { detail: { answers: ["fallback detail"] } },
      });
    });
  });

  test("fails requestUserInput closed when neither card nor fallback text can be delivered", async () => {
    const codex = new UserInputCodex({
      id: "input_undeliverable",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [{
        id: "detail",
        header: "Detail",
        question: "Provide a detail.",
        isOther: true,
        isSecret: false,
        options: null,
      }],
    });
    const sender = new FailingUserInputPresentationSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_input_undeliverable",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });

      expect(codex.runs).toHaveLength(1);
      expect(codex.response).toEqual({ answers: {} });
      expect(sender.userInputCardAttempts).toHaveLength(1);
    });
  });

  test("cleans up an unawaited requestUserInput when the run finishes", async () => {
    const request: CodexUserInputRequest = {
      id: "input_unawaited",
      threadId: "thread_test",
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      questions: [{
        id: "detail",
        header: "Detail",
        question: "Provide a detail.",
        isOther: true,
        isSecret: false,
        options: null,
      }],
    };
    const codex = new FireAndForgetUserInputCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m_input_unawaited",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "ask me",
      });
      await waitFor(() => sender.userInputCardUpdates.length > 0);
      expect(sender.userInputCardUpdates.at(-1)?.input.status).toBe("cancelled");

      const late = await router.handleCardAction({
        action: "cancel_user_input",
        chatId: "oc_chat",
        messageId: sender.userInputCards[0]?.handle.messageId,
        userInputId: request.id,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(late).toast.type).toBe("warning");
    });
  });

  test("binds extra permission approval to the original sender and card", async () => {
    const request: CodexPermissionApprovalRequest = {
      id: "permission_1",
      cwd: "/repo",
      itemId: "item_1",
      permissions: {
        fileSystem: {
          entries: [{ access: "write", path: { type: "path", path: "/repo/output" } }],
        },
        network: { enabled: true },
      },
      startedAtMs: 1_750_000_000_000,
      threadId: "thread_test",
      turnId: "turn_1",
      environmentId: null,
      reason: "Publish the generated artifact.",
    };
    const codex = new PermissionApprovalCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_user,ou_other" },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m_permission",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "publish artifact",
        });
        await waitFor(() => sender.permissionApprovalCards.length === 1);
        const handle = sender.permissionApprovalCards[0]!.handle;

        const wrongSender = await router.handleCardAction({
          action: "resolve_permission_approval",
          chatId: "oc_chat",
          messageId: handle.messageId,
          requestId: request.id,
          decision: "grantTurn",
          sender: { openId: "ou_other" },
        });
        expect(expectToast(wrongSender).toast.type).toBe("error");
        expect(codex.decision).toBeUndefined();

        const wrongCard = await router.handleCardAction({
          action: "resolve_permission_approval",
          chatId: "oc_chat",
          messageId: "om_permission_forged",
          requestId: request.id,
          decision: "grantTurn",
          sender: { openId: "ou_user" },
        });
        expect(expectToast(wrongCard).toast.type).toBe("warning");
        expect(codex.decision).toBeUndefined();

        const forgedDecision = await router.handleCardAction({
          action: "resolve_permission_approval",
          chatId: "oc_chat",
          messageId: handle.messageId,
          requestId: request.id,
          decision: "accept",
          sender: { openId: "ou_user" },
        });
        expect(expectToast(forgedDecision).toast.type).toBe("warning");
        expect(codex.decision).toBeUndefined();

        const resolved = await router.handleCardAction({
          action: "resolve_permission_approval",
          chatId: "oc_chat",
          messageId: handle.messageId,
          requestId: request.id,
          decision: "grantSession",
          sender: { openId: "ou_user" },
        });
        expectReplacementView(resolved, "permission_approval");
        await running;

        expect(codex.decision).toBe("grantSession");
        expect(sender.permissionApprovalCardUpdates.at(-1)).toMatchObject({
          handle,
          input: {
            status: "resolved",
            request,
            decision: "grantSession",
          },
        });
      },
    );
  });

  test("falls back to /permit when permission approval cards are unavailable", async () => {
    const request: CodexPermissionApprovalRequest = {
      id: "permission_unavailable",
      cwd: "/repo",
      itemId: "item_1",
      permissions: { network: { enabled: true } },
      startedAtMs: 1_750_000_000_000,
      threadId: "thread_test",
      turnId: "turn_1",
      environmentId: null,
      reason: "Access the release endpoint.",
    };

    const unavailableCodex = new PermissionApprovalCodex(request);
    const unavailableSender = new CollectingSender();
    await withRouterAndSender({}, unavailableCodex, unavailableSender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_permission_unavailable",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "request permission",
      });
      await waitFor(() =>
        unavailableSender.messages.some((message) =>
          message.text.includes("/permit"),
        ),
      );
      const prompt = unavailableSender.messages.find((message) =>
        message.text.includes("/permit"),
      )?.text;
      const replyCode = /\/permit ([a-f0-9]{8}) turn/u.exec(prompt ?? "")?.[1];
      expect(replyCode).toBeTruthy();
      await router.enqueue({
        messageId: "m_permission_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/permit ${replyCode} turn`,
      });
      await running;
      expect(unavailableCodex.decision).toBe("grantTurn");
    });
  });

  test("expires extra permission approval on abort and rejects late card actions", async () => {
    const request: CodexPermissionApprovalRequest = {
      id: "permission_expired",
      cwd: "/repo",
      itemId: "item_1",
      permissions: { network: { enabled: true } },
      startedAtMs: 1_750_000_000_000,
      threadId: "thread_test",
      turnId: "turn_1",
      environmentId: null,
      reason: "Access the release endpoint.",
    };
    const codex = new PermissionApprovalCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_permission_expired",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "request permission",
      });
      await waitFor(() => sender.permissionApprovalCards.length === 1);
      const handle = sender.permissionApprovalCards[0]!.handle;

      codex.abortRequest();
      await running;
      expect(codex.decision).toBe("deny");
      expect(sender.permissionApprovalCardUpdates.at(-1)?.input.status).toBe("expired");

      const late = await router.handleCardAction({
        action: "resolve_permission_approval",
        chatId: "oc_chat",
        messageId: handle.messageId,
        requestId: request.id,
        decision: "grantTurn",
        sender: { openId: "ou_user" },
      });
      expect(expectToast(late).toast.type).toBe("warning");
    });
  });

  test("submits an MCP form from a card option and a private text answer", async () => {
    const request: CodexMcpElicitationRequest = {
      id: "mcp_form_1",
      serverName: "release-manager",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Collect release settings.",
      mode: "form",
      fields: [
        {
          name: "environment",
          title: "Environment",
          description: "Select a deployment target.",
          required: true,
          type: "enum",
          default: null,
          options: [
            { value: "staging", title: "Staging" },
            { value: "production", title: "Production" },
          ],
        },
        {
          name: "release_note",
          title: "Release note",
          description: "Provide a private note.",
          required: true,
          type: "string",
          default: null,
          format: null,
          minLength: 1,
          maxLength: 200,
        },
      ],
    };
    const codex = new McpElicitationCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_user,ou_other" },
      codex,
      sender,
      async ({ router, config }) => {
        const running = router.enqueue({
        messageId: "m_mcp_form",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "collect release settings",
      });
      await waitFor(() => sender.mcpElicitationCards.length === 1);
      const initial = sender.mcpElicitationCards[0]!;

      const selected = await router.handleCardAction({
        action: "answer_mcp_elicitation",
        chatId: "oc_chat",
        messageId: initial.handle.messageId,
        requestId: request.id,
        fieldId: "environment",
        optionIndex: 1,
        sender: { openId: "ou_user" },
      });
      expectReplacementView(selected, "mcp_elicitation");
      expect(sender.mcpElicitationCardUpdates.at(-1)?.input).toMatchObject({
        status: "pending",
        answeredFieldIds: ["environment"],
      });

      await router.accept({
        messageId: "m_mcp_wrong_sender_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_other" },
        text: `/mcp-answer ${initial.input.replyCode} release_note forged-value`,
      });
      await waitFor(() =>
        sender.messages.some((message) => message.text.includes("只有发起当前 Codex 任务的用户")),
      );
      expect(codex.response).toBeUndefined();

      const privateAnswer = "private release phrase 48f31";
      const answerMessage: IncomingTextMessage = {
        messageId: "m_mcp_private_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/mcp-answer ${initial.input.replyCode} release_note ${privateAnswer}`,
      };
      await router.accept(answerMessage);
      await router.accept(answerMessage);
      await running;

      expect(codex.response).toEqual({
        action: "accept",
        content: {
          environment: "production",
          release_note: privateAnswer,
        },
      });
      expect(sender.messages.every((message) => !message.text.includes(privateAnswer))).toBe(true);
      expect(
        sender.mcpElicitationCardUpdates.every(
          (update) => !JSON.stringify(update.input).includes(privateAnswer),
        ),
      ).toBe(true);
      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(JSON.stringify(persisted)).not.toContain(privateAnswer);
      expect(
        persisted.processedMessageIds.filter((id) => id === answerMessage.messageId),
      ).toHaveLength(1);
      },
    );
  });

  test("answers a leading-whitespace MCP field id and keeps required /skip as data", async () => {
    const fieldId = " release note";
    const codex = new McpElicitationCodex({
      id: "mcp_quoted_field",
      serverName: "release-manager",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Collect a release marker.",
      mode: "form",
      fields: [
        {
          name: fieldId,
          title: "Release marker",
          description: null,
          required: true,
          type: "string",
          default: null,
          format: null,
          minLength: 1,
          maxLength: 20,
        },
      ],
    });
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_mcp_quoted_field",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "collect marker",
      });
      await waitFor(() => sender.mcpElicitationCards.length === 1);
      const card = sender.mcpElicitationCards[0]!;

      await router.accept({
        messageId: "m_mcp_quoted_field_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/mcp-answer ${card.input.replyCode} ${JSON.stringify(fieldId)} /skip`,
      });
      await running;

      expect(codex.response).toEqual({
        action: "accept",
        content: { [fieldId]: "/skip" },
      });
    });
  });

  test("bounds pending interactive requests with the configured per-chat limit", async () => {
    const responses: CodexMcpElicitationResponse[] = [];
    const request = (id: string): CodexMcpElicitationRequest => ({
      id,
      serverName: "release-manager",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Confirm release.",
      mode: "form",
      fields: [
        {
          name: "confirmed",
          title: "Confirmed",
          description: null,
          required: true,
          type: "boolean",
          default: null,
        },
      ],
    });
    const codex: CodexClient = {
      async run(input: CodexRunInput): Promise<CodexRunResult> {
        const first = input.onMcpElicitationRequest!(request("mcp_limit_1"), {
          signal: new AbortController().signal,
        });
        responses.push(
          await input.onMcpElicitationRequest!(request("mcp_limit_2"), {
            signal: new AbortController().signal,
          }),
        );
        responses.unshift(await first);
        return {
          threadId: "thread_test",
          finalText: "done",
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      {
        BRIDGE_MAX_PENDING_MESSAGES: "2",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "1",
      },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m_mcp_limit",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "trigger parallel requests",
        });
        await waitFor(() => sender.mcpElicitationCards.length === 1);
        expect(sender.mcpElicitationCards).toHaveLength(1);
        expect(responses).toEqual([{ action: "cancel" }]);

        const card = sender.mcpElicitationCards[0]!;
        await router.handleCardAction({
          action: "resolve_mcp_elicitation",
          chatId: "oc_chat",
          messageId: card.handle.messageId,
          requestId: "mcp_limit_1",
          decision: "cancel",
          sender: { openId: "ou_user" },
        });
        await running;
        expect(responses).toEqual([{ action: "cancel" }, { action: "cancel" }]);
      },
    );
  });

  test("fails an MCP form with a required secret-like field closed", async () => {
    const secretPrompt = "Paste the production credential.";
    const codex = new McpElicitationCodex({
      id: "mcp_secret",
      serverName: "release-manager",
      threadId: "thread_test",
      turnId: "turn_1",
      message: secretPrompt,
      mode: "form",
      fields: [
        {
          name: "api_token",
          title: "API token",
          description: "Used to access production.",
          required: true,
          type: "string",
          default: null,
          format: null,
          minLength: 1,
          maxLength: 200,
        },
      ],
    });
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router, config }) => {
      await router.enqueue({
        messageId: "m_mcp_secret",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "invoke secure MCP form",
      });

      expect(codex.response).toEqual({ action: "cancel" });
      expect(sender.mcpElicitationCards).toHaveLength(0);
      expect(sender.messages.some((message) => message.text.includes("secret/password-like"))).toBe(
        true,
      );
      expect(sender.messages.every((message) => !message.text.includes(secretPrompt))).toBe(true);
      const persisted = await new JsonStateStore(config.bridgeStatePath).load();
      expect(JSON.stringify(persisted)).not.toContain(secretPrompt);
    });
  });

  test("binds URL MCP acceptance to the original sender", async () => {
    const request: CodexMcpElicitationRequest = {
      id: "mcp_url_1",
      serverName: "oauth-provider",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Authorize access in the browser.",
      mode: "url",
      elicitationId: "elicit_1",
      url: "https://auth.example.test/authorize?flow=release",
    };
    const codex = new McpElicitationCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_user,ou_other" },
      codex,
      sender,
      async ({ router }) => {
        const running = router.enqueue({
          messageId: "m_mcp_url",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "authorize release provider",
        });
        await waitFor(() => sender.mcpElicitationCards.length === 1);
        const handle = sender.mcpElicitationCards[0]!.handle;

        const rejected = await router.handleCardAction({
          action: "resolve_mcp_elicitation",
          chatId: "oc_chat",
          messageId: handle.messageId,
          requestId: request.id,
          decision: "accept",
          sender: { openId: "ou_other" },
        });
        expect(expectToast(rejected).toast.type).toBe("error");
        expect(codex.response).toBeUndefined();

        const accepted = await router.handleCardAction({
          action: "resolve_mcp_elicitation",
          chatId: "oc_chat",
          messageId: handle.messageId,
          requestId: request.id,
          decision: "accept",
          sender: { openId: "ou_user" },
        });
        expectReplacementView(accepted, "mcp_elicitation");
        await running;

        expect(codex.response).toEqual({ action: "accept", content: null });
        expect(sender.mcpElicitationCardUpdates.at(-1)).toMatchObject({
          handle,
          input: { status: "resolved", request },
        });
      },
    );
  });

  test("falls back to /mcp-decide for URL requests on text-only adapters", async () => {
    const request: CodexMcpElicitationRequest = {
      id: "mcp_url_text",
      serverName: "oauth-provider",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Authorize access.",
      mode: "url",
      elicitationId: "elicit_text",
      url: "https://auth.example.test/authorize",
    };
    const codex = new McpElicitationCodex(request);
    const sender = new CollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_mcp_url_text",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "authorize provider",
      });
      await waitFor(() =>
        sender.messages.some((message) => message.text.includes("/mcp-decide")),
      );
      const prompt = sender.messages.find((message) =>
        message.text.includes("/mcp-decide"),
      )?.text;
      expect(prompt).toContain(request.url);
      const replyCode = /\/mcp-decide ([a-f0-9]{8}) accept/u.exec(
        prompt ?? "",
      )?.[1];
      expect(replyCode).toBeTruthy();
      await router.enqueue({
        messageId: "m_mcp_url_text_answer",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: `/mcp-decide ${replyCode} accept`,
      });
      await running;
      expect(codex.response).toEqual({ action: "accept", content: null });
    });
  });

  test("expires MCP elicitation on abort and rejects late card actions", async () => {
    const request: CodexMcpElicitationRequest = {
      id: "mcp_expired",
      serverName: "release-manager",
      threadId: "thread_test",
      turnId: "turn_1",
      message: "Confirm the release.",
      mode: "form",
      fields: [
        {
          name: "confirmed",
          title: "Confirmed",
          description: null,
          required: true,
          type: "boolean",
          default: null,
        },
      ],
    };
    const codex = new McpElicitationCodex(request);
    const sender = new CardCollectingSender();

    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      const running = router.enqueue({
        messageId: "m_mcp_expired",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "confirm release",
      });
      await waitFor(() => sender.mcpElicitationCards.length === 1);
      const handle = sender.mcpElicitationCards[0]!.handle;

      codex.abortRequest();
      await running;
      expect(codex.response).toEqual({ action: "cancel" });
      expect(sender.mcpElicitationCardUpdates.at(-1)?.input.status).toBe("expired");

      const late = await router.handleCardAction({
        action: "answer_mcp_elicitation",
        chatId: "oc_chat",
        messageId: handle.messageId,
        requestId: request.id,
        fieldId: "confirmed",
        optionIndex: 0,
        sender: { openId: "ou_user" },
      });
      expect(expectToast(late).toast.type).toBe("warning");
    });
  });

  test("help lists the mobile conversation workbench commands", async () => {
    await withRouter({}, async ({ router, sender, codex }) => {
      await router.enqueue({
        messageId: "m_help",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/help",
      });

      expect(codex.runs).toHaveLength(0);
      expect(sender.messages[0]?.text).toContain("**Chat2Codex 常用命令**");
      expect(sender.messages[0]?.text).toContain("/fork --turn");
      expect(sender.messages[0]?.text).toContain("/retry");
      expect(sender.messages[0]?.text).toContain("/usage");
    });
  });

  test("usage reports when the provider did not emit token usage", async () => {
    await withRouter({}, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_usage_source",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "run without usage",
      });
      await router.enqueue({
        messageId: "m_usage_missing",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/usage",
      });

      expect(sender.messages.at(-1)?.text).toContain("没有收到 Codex 的 token usage 通知");
    });
  });

  test("service controls expose status and bounded logs and restart only from an admin direct chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-service-control-"));
    let router: MessageRouter | undefined;
    try {
      const logPath = path.join(tempDir, "chat2codex.log");
      await writeFile(logPath, ["old line", "latest line"].join("\n"));
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: tempDir,
        BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
        ALLOW_GROUPS: "true",
        ALLOWED_CHAT_IDS: "oc_group",
        ALLOWED_USER_IDS: "ou_admin",
        CHAT2CODEX_LOG_FILE: logPath,
        CHAT2CODEX_SERVICE_RESTART_ENABLED: "true",
      });
      const sender = new CollectingSender();
      let restartRequests = 0;
      router = new MessageRouter(
        config,
        new JsonStateStore(config.bridgeStatePath),
        sender,
        silentLogger,
        new FakeCodex(),
        { requestRestart: () => restartRequests += 1 },
      );
      await router.start();

      const direct = (messageId: string, text: string): IncomingTextMessage => ({
        messageId,
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_admin" },
        text,
      });
      await router.enqueue(direct("m_service_status", "/service status"));
      await router.enqueue(direct("m_service_logs", "/service logs"));
      await router.enqueue({
        messageId: "m_service_group_restart",
        chatId: "oc_group",
        chatType: "group",
        sender: { openId: "ou_admin" },
        text: "/service restart",
      });
      await router.enqueue(direct("m_service_restart", "/service restart"));
      await waitFor(() => restartRequests === 1);

      expect(sender.messages[0]?.text).toContain("**Chat2Codex 服务状态**");
      expect(sender.messages[0]?.text).toContain(`\`${logPath}\``);
      expect(sender.messages[1]?.text).toContain("latest line");
      expect(sender.messages[2]?.text).toContain("只允许在私聊中");
      expect(sender.messages[3]?.text).toContain("优雅退出");
    } finally {
      await router?.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("text retry reruns the latest in-memory prompt for the original sender", async () => {
    const codex = new SequencedCodex([
      {
        threadId: "thread_test",
        finalText: "first done",
        stderr: "",
        exitCode: 0,
      },
      {
        threadId: "thread_test",
        finalText: "retry done",
        stderr: "",
        exitCode: 0,
      },
    ]);

    await withRouterAndCodex({}, codex, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m_retry_source",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "full prompt to retry exactly",
      });
      await router.enqueue({
        messageId: "m_retry_text",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "/retry",
      });

      expect(codex.runs.map((run) => run.prompt)).toEqual([
        "full prompt to retry exactly",
        "full prompt to retry exactly",
      ]);
      expect(sender.messages.at(-1)?.text).toBe("retry done");
    });
  });

  test("text retry rejects a different allowed sender", async () => {
    const codex = new SequencedCodex([
      { threadId: "thread_test", finalText: "done", stderr: "", exitCode: 0 },
    ]);
    const sender = new CardCollectingSender();

    await withRouterAndSender(
      { ALLOWED_USER_IDS: "ou_user,ou_other" },
      codex,
      sender,
      async ({ router }) => {
        await router.enqueue({
          messageId: "m_retry_owner",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "owner task",
        });
        await router.enqueue({
          messageId: "m_retry_other",
          chatId: "oc_chat",
          chatType: "direct",
          sender: { openId: "ou_other" },
          text: "/retry",
        });
        expect(codex.runs).toHaveLength(1);
        expect(sender.messages.at(-1)?.text).toContain("只有发起最近一轮任务的用户");
      },
    );
  });

  test("card retry action reports missing status card context", async () => {
    await withRouter({}, async ({ router, sender }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "quick task",
      });
      sender.messages.length = 0;

      const response = await router.handleCardAction({
        action: "retry_run",
        chatId: "oc_chat",
        messageId: "om_unknown",
        sender: { openId: "ou_user" },
      });

      expect(response).toEqual({
        kind: "toast",
        level: "warning",
        text: "无法重试：当前服务没有这张状态卡的任务上下文。",
      });
      expect(sender.messages).toHaveLength(0);
    });
  });
});

async function withRouter(
  env: Record<string, string>,
  testBody: (context: {
    router: MessageRouter;
    sender: CollectingSender;
    codex: FakeCodex;
    config: TestBridgeConfig;
  }) => Promise<void>,
): Promise<void> {
  await withRouterAndCodex(env, new FakeCodex(), testBody);
}

async function withRouterAndCodex<TCodex extends CodexClient>(
  env: Record<string, string>,
  codex: TCodex,
  testBody: (context: {
    router: MessageRouter;
    sender: CollectingSender;
    codex: TCodex;
    config: TestBridgeConfig;
  }) => Promise<void>,
): Promise<void> {
  await withRouterAndSender(env, codex, new CollectingSender(), testBody);
}

async function withRouterAndSender<TCodex extends CodexClient, TSender extends ChatSender>(
  env: Record<string, string>,
  codex: TCodex,
  sender: TSender,
  testBody: (context: {
    router: MessageRouter;
    sender: TSender;
    codex: TCodex;
    config: TestBridgeConfig;
  }) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-test-"));
  let router: MessageRouter | undefined;
  try {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: tempDir,
      BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
      ATTACHMENT_DOWNLOAD_DIR: path.join(tempDir, "attachments"),
      ALLOWED_USER_IDS: "ou_user",
      ...env,
    });
    if (sender instanceof AttachmentCollectingSender) {
      sender.setAttachmentRoot(config.attachmentDownloadDir);
    }
    router = new MessageRouter(
      config,
      new JsonStateStore(config.bridgeStatePath),
      sender,
      silentLogger,
      codex,
    );
    await router.start();
    await testBody({ router, sender, codex, config });
  } finally {
    await router?.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function formatDecisionForTest(decision: CodexApprovalDecision | undefined): string {
  if (typeof decision === "string") {
    return decision;
  }
  return JSON.stringify(decision);
}

function expectToast(response: unknown): { toast: { type: string; content: string } } {
  expect(response).toMatchObject({ kind: "toast" });
  const toast = response as { kind: "toast"; level: string; text: string };
  return { toast: { type: toast.level, content: toast.text } };
}

function expectReplacementView(response: unknown, kind: ChatView["kind"]): ChatView {
  expect(response).toMatchObject({ kind: "replace_view", view: { kind } });
  return (response as Extract<ActionResponse, { kind: "replace_view" }>).view;
}

function renderFeishuActionForTest(response: unknown): unknown {
  expect(response).toHaveProperty("kind");
  return renderLarkActionResponse(response as ActionResponse, renderFeishuInteractiveView);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForState(
  store: JsonStateStore,
  predicate: (state: Awaited<ReturnType<JsonStateStore["load"]>>) => boolean,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate(await store.load())) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for persisted state");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
