import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
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
  RunStatusCardInput,
  UserInputCardInput,
} from "../src/bot/lark-card.js";
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

class CollectingSender implements ChatSender {
  readonly messages: Array<{ chatId: string; text: string; kind: "text" | "markdown" }> = [];

  async sendText(chatId: string, text: string): Promise<void> {
    this.messages.push({ chatId, text, kind: "text" });
  }

  async sendMarkdown(chatId: string, markdown: string): Promise<void> {
    this.messages.push({ chatId, text: markdown, kind: "markdown" });
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

  async createStatusCard(chatId: string, input: RunStatusCardInput): Promise<StatusCardHandle> {
    const handle = { messageId: `om_${this.cards.length + 1}` };
    this.cards.push({ chatId, input, handle });
    return handle;
  }

  async sendInteractiveCard(chatId: string, card: LarkInteractiveCard): Promise<void> {
    this.interactiveCards.push({ chatId, card });
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

class DelayedStatusCardSender extends CardCollectingSender {
  readonly createStarted = deferred<void>();
  readonly releaseCreate = deferred<void>();

  override async createStatusCard(
    chatId: string,
    input: RunStatusCardInput,
  ): Promise<StatusCardHandle> {
    this.createStarted.resolve();
    await this.releaseCreate.promise;
    return super.createStatusCard(chatId, input);
  }
}

class AttachmentCollectingSender extends CollectingSender {
  readonly downloads: Array<{ messageId: string; attachment: IncomingAttachment }> = [];

  async downloadAttachment(
    message: IncomingTextMessage,
    attachment: IncomingAttachment,
  ): Promise<DownloadedAttachment> {
    this.downloads.push({ messageId: message.messageId, attachment });
    return {
      kind: attachment.kind,
      name: attachment.name,
      path: `/tmp/chat2codex-downloads/${attachment.name ?? attachment.key}`,
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

class ListingCodex extends FakeCodex {
  readonly listInputs: CodexThreadListInput[] = [];
  readonly readIds: string[] = [];
  readonly searchInputs: CodexThreadSearchInput[] = [];
  readonly turnListInputs: CodexThreadTurnListInput[] = [];
  readonly turnItemInputs: CodexThreadTurnItemListInput[] = [];
  readonly forkInputs: Array<{ threadId: string; cwd?: string }> = [];
  readonly compactIds: string[] = [];

  constructor(
    private readonly threads: CodexThread[],
    private readonly extra: {
      searchResults?: CodexThreadSearchResultItem[];
      turns?: CodexThreadTurn[];
      itemsByTurn?: Record<string, CodexThreadItem[]>;
      forkedThread?: CodexThread;
    } = {},
  ) {
    super();
  }

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadListResult> {
    this.listInputs.push(input);
    let threads = this.threads;
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

  async forkThread(input: { threadId: string; cwd?: string }): Promise<CodexThread> {
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
  decision: CodexApprovalDecision | undefined;

  constructor(private readonly request: CodexApprovalRequest) {}

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    this.runs.push(input);
    this.decision = await input.onApprovalRequest?.(this.request);
    return {
      threadId: "thread_test",
      finalText: `decision=${formatDecisionForTest(this.decision)}`,
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
      expect(sender.messages.at(-1)?.text).toContain("queue_depth: 1");
      expect(sender.messages.at(-1)?.text).toContain("state=waiting_for_workspace");

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
        expect(sender.messages.at(-1)?.text).toContain("state=waiting_for_global_capacity");

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
          () => sender.messages.filter((message) => message.text.includes("队列已满")).length === 2,
        );

        await router.accept({
          messageId: "m_capacity_status",
          chatId: "oc_chat_1",
          chatType: "direct",
          sender: { openId: "ou_user" },
          text: "/status",
        });
        await waitFor(() => sender.messages.some((message) => message.text.includes("active_run:")));

        const store = new JsonStateStore(config.bridgeStatePath);
        const state = await store.load();
        for (const messageId of ["m_capacity_rejected_1", "m_capacity_rejected_2"]) {
          expect(state.jobs[messageId]).toMatchObject({
            status: "cancelled",
            interruptionReason: "queue_capacity_reached",
          });
          expect(state.pendingMessages[messageId]).toBeUndefined();
          expect(state.processedMessageIds).toContain(messageId);
          expect(
            Object.values(state.outbox).find((delivery) => delivery.jobId === messageId)?.status,
          ).toBe("delivered");
        }
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
      failedRouter.dispose();
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
      failedRouter?.dispose();
      replayRouter?.dispose();
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
      expect(sender.messages[0]?.text).toContain("chat_id: oc_group");
      expect(sender.messages[0]?.text).not.toContain("sender.open_id:");
      expect(sender.messages[0]?.text).not.toContain("sender.user_id:");
      expect(sender.messages[0]?.text).not.toContain("sender.union_id:");
      expect(sender.messages[0]?.text).toContain("access: denied (groups_disabled)");
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
      expect(sender.messages[0]?.text).toContain("sender.open_id: ou_user");
      expect(sender.messages[0]?.text).toContain("sender.user_id: u_user");
      expect(sender.messages[0]?.text).toContain("sender.union_id: on_user");
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
      expect(sender.messages[0]?.text).toContain("chat_id: oc_group");
      expect(sender.messages[0]?.text).toContain("access: denied (groups_disabled)");
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

      expect(sender.messages[0]?.text).toContain("attachment_dir:");
      expect(sender.messages[0]?.text).toContain("last_event:");
      expect(sender.messages[0]?.text).toContain("type=audio");
      expect(sender.messages[0]?.text).toContain("reason=unsupported_message_type");
      expect(sender.messages[0]?.text).toContain("last_dropped:");
      expect(sender.messages[0]?.text).toContain("queue_depth: 0");
      expect(sender.messages[0]?.text).toContain("active_run: (none)");
      expect(sender.messages[0]?.text).toContain("approval_wait: (none)");
      expect(sender.messages[0]?.text).toContain("recent_failures: (none)");
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
      expect(status).toContain("queue_depth: 1");
      expect(status).toContain("active_run: age=");
      expect(status).toContain('prompt="long running task"');

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

      expect(projectResponse).toMatchObject({
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
      expect(JSON.stringify(projectResponse)).not.toContain("select_project");
      expect(response).toMatchObject({
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
      expect(JSON.stringify(response)).toContain("已选择会话：A older");
      expect(JSON.stringify(response)).not.toContain("resume_thread");
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

      expect(projectPage).toMatchObject({
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
      expect(JSON.stringify(projectPage)).toContain("进入 6");
      expect(JSON.stringify(projectPage)).toContain("上一页");
      expect(JSON.stringify(projectPage)).not.toContain("下一页");

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

      expect(sessionPage).toMatchObject({
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
      expect(JSON.stringify(sessionPage)).toContain("继续 6");
      expect(JSON.stringify(sessionPage)).toContain("上一页");
      expect(JSON.stringify(sessionPage)).not.toContain("下一页");
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
        expect(sender.messages.map((message) => message.text)).toEqual([
          "收到，已开始处理。",
          "done",
        ]);
        expect(sender.messages.map((message) => message.kind)).toEqual(["text", "markdown"]);
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
        "收到，已开始处理。",
        "Codex 正在处理。",
        "done",
      ]);
      expect(sender.messages.map((message) => message.kind)).toEqual([
        "text",
        "text",
        "markdown",
      ]);
    });
  });

  test("uses a single status card for progress and completion when supported", async () => {
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

      expect(sender.cards).toHaveLength(1);
      expect(sender.cards[0]?.input).toMatchObject({
        status: "running",
        detail: "收到，已开始处理。",
        prompt: "run with card progress",
      });
      expect(sender.cardUpdates).toHaveLength(2);
      expect(sender.cardUpdates[0]?.input).toMatchObject({
        status: "running",
        detail: "Codex 正在处理。",
      });
      expect(sender.cardUpdates[1]?.input).toMatchObject({
        status: "success",
        detail: "Codex 已完成，正在发送最终回答。",
      });
      expect(sender.messages.map((message) => message.kind)).toEqual(["markdown"]);
      expect(sender.messages[0]?.text).toBe("done");
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

      expect(sender.cardUpdates.at(-1)?.input).toMatchObject({
        status: "success",
        result: {
          filesPreview: ["src/app.ts"],
          changedFileCount: 1,
          commandCount: 1,
          diffAvailable: true,
          logsAvailable: true,
        },
      });

      for (const [command, expected] of [
        ["/summary", "状态：success"],
        ["/files", "src/app.ts"],
        ["/diff", "diff --git a/src/app.ts b/src/app.ts"],
        ["/logs", "bun test"],
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

      const response = await router.handleCardAction({
        action: "show_run_detail",
        detailKind: "diff",
        chatId: "oc_chat",
        messageId: sender.cards[0]?.handle.messageId,
        sender: { openId: "ou_user" },
      });
      expect(response).toMatchObject({
        toast: {
          type: "success",
        },
      });
      expect(sender.messages.at(-1)?.text).toContain("diff --git a/src/app.ts b/src/app.ts");
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
    const sender = new DelayedStatusCardSender();
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
    await withRouterAndSender({}, new FakeCodex(), sender, async ({ router, codex }) => {
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
          "- 文件 report.pdf: /tmp/chat2codex-downloads/report.pdf",
        ].join("\n"),
      );
    });
  });

  test("uses a default prompt for attachment-only messages", async () => {
    const sender = new AttachmentCollectingSender();
    await withRouterAndSender({}, new FakeCodex(), sender, async ({ router, codex }) => {
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
          "- 图片: /tmp/chat2codex-downloads/img_v3_test",
        ].join("\n"),
      );
    });
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

      expect(sender.messages).toHaveLength(2);
      expect(sender.messages[1]?.text).toContain("Codex 运行失败。");
      expect(sender.messages[1]?.text).toContain("exit: code=2");
      expect(sender.messages[1]?.text).toContain("cwd:");
      expect(sender.messages[1]?.text).toContain("fatal: not a git repository");
      expect(sender.messages[1]?.text).toContain("CODEX_SKIP_GIT_REPO_CHECK=true");
    });
  });

  test("updates the status card before sending a failure summary", async () => {
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

      expect(sender.cards).toHaveLength(1);
      expect(sender.cardUpdates).toHaveLength(1);
      expect(sender.cardUpdates[0]?.input).toMatchObject({
        status: "failed",
        detail: "Codex 运行失败，错误摘要已发送。",
      });
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.text).toContain("Codex 运行失败。");
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

      expect(sender.messages).toHaveLength(2);
      expect(sender.messages[1]?.text).toContain("Codex 启动失败。");
      expect(sender.messages[1]?.text).toContain("command: codex");
      expect(sender.messages[1]?.text).toContain("spawn codex ENOENT");
      expect(sender.messages[1]?.text).toContain("CODEX_BIN");
      expect(sender.messages[1]?.text).toContain("PATH");
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
        "收到，已开始处理。",
        "已请求停止当前 chat 的 Codex 任务。",
      ]);
    });
  });

  test("updates the status card when a run is stopped", async () => {
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

      expect(sender.cards).toHaveLength(1);
      expect(sender.cardUpdates.at(-1)?.input).toMatchObject({
        status: "stopped",
        detail: "已停止当前 Codex 任务。",
      });
      expect(sender.messages.map((message) => message.text)).toEqual([
        "已请求停止当前 chat 的 Codex 任务。",
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
        expect(sender.cardUpdates.at(-1)?.input).toMatchObject({
          status: "failed",
          detail: "Codex 运行超时，已停止当前任务。",
        });
        expect(sender.messages.at(-1)?.text).toContain("CODEX_RUN_TIMEOUT_MS=10");

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
        toast: {
          type: "success",
          content: "已请求停止当前 chat 的 Codex 任务。",
        },
      });
      expect(codex.abortCount).toBe(1);
      expect(sender.cardUpdates.at(-1)?.input.status).toBe("stopped");
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
        toast: {
          type: "warning",
          content: "当前 chat 没有正在运行的 Codex 任务。",
        },
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

      expect(response).toMatchObject({
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
      expect(JSON.stringify(response)).toContain("已选择：Approve session。");
      expect(JSON.stringify(response)).not.toContain("resolve_approval");
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
      expect(status).toContain("approval_wait: count=1");
      expect(status).toContain("type=commandExecution");
      expect(status).toContain("decisions=3");
      expect(status).toContain('command="rm -rf build"');

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

  test("marks a late approval card resolved when the user clicks before card creation returns", async () => {
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

      expect(response).toMatchObject({
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
      expect(JSON.stringify(response)).toContain("已选择：Approve。");
      expect(JSON.stringify(response)).not.toContain("resolve_approval");
      expect(sender.approvalCardUpdates).toHaveLength(0);

      sender.releaseCreate.resolve();
      await waitFor(
        () => sender.approvalCards.length === 1 && sender.approvalCardUpdates.length === 1,
      );
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
      expect(nextQuestion).toHaveProperty("card");
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
      expect(resolved).toHaveProperty("card");
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
        expect(cancelled).toHaveProperty("card");
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

  test("card retry action reruns the prompt from the status card context", async () => {
    const codex = new SequencedCodex([
      {
        threadId: "thread_test",
        finalText: "",
        stderr: "temporary failure",
        exitCode: 1,
      },
      {
        threadId: "thread_test",
        finalText: "retried done",
        stderr: "",
        exitCode: 0,
      },
    ]);
    const sender = new CardCollectingSender();
    await withRouterAndSender({}, codex, sender, async ({ router }) => {
      await router.enqueue({
        messageId: "m1",
        chatId: "oc_chat",
        chatType: "direct",
        sender: { openId: "ou_user" },
        text: "flaky task",
      });

      const response = await router.handleCardAction({
        action: "retry_run",
        chatId: "oc_chat",
        messageId: sender.cards[0]?.handle.messageId,
        sender: { openId: "ou_user" },
      });
      await waitFor(() => codex.runs.length === 2);
      await waitFor(() => sender.cards.length === 2);
      await waitFor(() =>
        sender.cardUpdates.some((update) => update.input.status === "success"),
      );

      expect(response).toEqual({
        toast: {
          type: "success",
          content: "已把这次任务重新加入当前 chat 的 Codex 队列。",
        },
      });
      expect(codex.runs.map((run) => run.prompt)).toEqual(["flaky task", "flaky task"]);
      expect(sender.cards[1]?.input).toMatchObject({
        status: "running",
        prompt: "flaky task",
      });
      expect(sender.cardUpdates.at(-1)?.input).toMatchObject({
        status: "success",
      });
      expect(sender.messages.at(-1)).toMatchObject({
        kind: "markdown",
        text: "retried done",
      });
    });
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
        toast: {
          type: "warning",
          content: "无法重试：当前服务没有这张状态卡的任务上下文。",
        },
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
      ALLOWED_USER_IDS: "ou_user",
      ...env,
    });
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
    router?.dispose();
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
  expect(response).toHaveProperty("toast");
  return response as { toast: { type: string; content: string } };
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
