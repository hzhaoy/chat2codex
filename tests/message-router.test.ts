import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexProgressUpdate,
  CodexRunInput,
  CodexRunResult,
  CodexThread,
  CodexThreadListInput,
  CodexThreadListResult,
} from "../src/agent/codex-runner.js";
import type {
  ApprovalCardInput,
  LarkInteractiveCard,
  RunStatusCardInput,
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

  constructor(private readonly threads: CodexThread[]) {
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
      expect(sender.messages[0]?.text).toContain("access: denied (groups_disabled)");
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
      expect(JSON.stringify(response)).toContain("Selected session: A older");
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

      expect(codex.runs[0]?.cwd).toBe(path.resolve("/tmp"));
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
        expect(codex.runs[0]?.cwd).toBe(allowedProject);
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

  test("group approval card action requires an allowed user list", async () => {
    const codex = new ApprovalCodex({
      id: "approval_1",
      kind: "command",
      command: "rm -rf build",
      decisions: ["accept", "decline"],
    });
    const sender = new CardCollectingSender();
    await withRouterAndSender(
      { ALLOW_GROUPS: "true", ALLOWED_CHAT_IDS: "oc_group" },
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
        await waitFor(() => sender.approvalCards.length === 1);

        const rejected = await router.handleCardAction({
          action: "resolve_approval",
          chatId: "oc_group",
          messageId: sender.approvalCards[0]?.handle.messageId,
          approvalId: "approval_1",
          decisionIndex: 0,
          sender: { openId: "ou_user" },
        });

        expect(expectToast(rejected).toast.type).toBe("error");
        expect(codex.decision).toBeUndefined();

        await router.enqueue({
          messageId: "m_stop",
          chatId: "oc_group",
          chatType: "group",
          sender: { openId: "ou_user" },
          text: "@_user_1 /stop",
        });
        await running;
        expect(codex.decision).toBe("cancel");
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
  try {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: tempDir,
      BRIDGE_STATE_PATH: path.join(tempDir, "state.json"),
      ...env,
    });
    const router = new MessageRouter(
      config,
      new JsonStateStore(config.bridgeStatePath),
      sender,
      silentLogger,
      codex,
    );
    await router.start();
    await testBody({ router, sender, codex, config });
  } finally {
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
