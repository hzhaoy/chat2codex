import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexRunner, type CodexSessionScope } from "../src/agent/codex-runner.js";
import { loadConfig } from "../src/config/env.js";
import { ConsoleLogger } from "../src/util/logger.js";

const scope = (overrides: Partial<CodexSessionScope> = {}): CodexSessionScope => ({
  chatId: "chat_1",
  sessionEpoch: "epoch-1",
  principal: { openId: "ou_1" },
  ...overrides,
});

describe("Codex app-server session manager", () => {
  test("reuses one app-server process for consecutive turns in the same scoped thread", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    const boundThreads: string[] = [];

    try {
      const first = await runner.run({
        prompt: "first",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        onThreadBound: (threadId) => boundThreads.push(threadId),
      });
      const second = await runner.run({
        prompt: "second",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
      });

      expect(first.finalText).toBe("done:first");
      expect(second.finalText).toBe("done:second");
      expect(boundThreads).toEqual(["thread_shared"]);

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(1);
      expect(received.filter(({ message }) => message.method === "thread/start")).toHaveLength(1);
      expect(received.filter(({ message }) => message.method === "thread/resume")).toHaveLength(0);
      expect(received.filter(({ message }) => message.method === "turn/start")).toHaveLength(2);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(1);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("sets Plan mode for one turn and restores Default mode on the reused session", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const first = await runner.run({
        prompt: "plan-turn",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        collaborationMode: "plan",
      });
      await runner.run({
        prompt: "default-turn",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
        collaborationMode: "default",
      });

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "model/list")).toHaveLength(1);
      const turns = received
        .filter(({ message }) => message.method === "turn/start")
        .map(({ message }) => message.params as Record<string, unknown>);
      expect(turns.map((params) => params.collaborationMode)).toEqual([
        {
          mode: "plan",
          settings: { model: "fake-default-model", developer_instructions: null },
        },
        {
          mode: "default",
          settings: { model: "fake-default-model", developer_instructions: null },
        },
      ]);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("expires an idle session after its configured TTL", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir, {
      CODEX_APP_SERVER_IDLE_TTL_MS: "30",
    });

    try {
      const first = await runner.run({
        prompt: "before-ttl",
        cwd: fixture.tempDir,
        sessionScope: scope(),
      });
      await waitForMessage(fixture.receivedPath, "fixture/exit");
      const second = await runner.run({
        prompt: "after-ttl",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
      });

      expect(second.finalText).toBe("done:after-ttl");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(2);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("evicts the least recently used idle session when capacity is reached", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir, {
      CODEX_APP_SERVER_IDLE_TTL_MS: "0",
      CODEX_MAX_APP_SERVER_SESSIONS: "2",
    });

    try {
      await runner.run({
        prompt: "chat-one-first",
        cwd: fixture.tempDir,
        threadId: "thread_chat_1",
        sessionScope: scope({ chatId: "chat_1" }),
      });
      await delay(15);
      await runner.run({
        prompt: "chat-two-first",
        cwd: fixture.tempDir,
        threadId: "thread_chat_2",
        sessionScope: scope({ chatId: "chat_2" }),
      });
      await delay(15);
      await runner.run({
        prompt: "chat-one-recent",
        cwd: fixture.tempDir,
        threadId: "thread_chat_1",
        sessionScope: scope({ chatId: "chat_1" }),
      });
      await delay(15);
      await runner.run({
        prompt: "chat-three-first",
        cwd: fixture.tempDir,
        threadId: "thread_chat_3",
        sessionScope: scope({ chatId: "chat_3" }),
      });

      const beforeReopen = await readMessages(fixture.receivedPath);
      const firstPidByPrompt = new Map(
        beforeReopen
          .filter(({ message }) => message.method === "turn/start")
          .map((entry) => [
            ((entry.message.params as { input: Array<{ text: string }> }).input[0]?.text ?? ""),
            entry.pid,
          ]),
      );
      const exitedPids = new Set(
        beforeReopen
          .filter(({ message }) => message.method === "fixture/exit")
          .map((entry) => entry.pid),
      );
      expect(exitedPids.has(firstPidByPrompt.get("chat-two-first") ?? -1)).toBe(true);
      expect(exitedPids.has(firstPidByPrompt.get("chat-one-first") ?? -1)).toBe(false);

      await runner.run({
        prompt: "chat-two-reopened",
        cwd: fixture.tempDir,
        threadId: "thread_chat_2",
        sessionScope: scope({ chatId: "chat_2" }),
      });
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(4);
      expect(
        new Set(
          received
            .filter(({ message }) => message.method === "turn/start")
            .map((entry) => entry.pid),
        ),
      ).toHaveLength(4);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("rotates the process when the chat session epoch changes", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      await runner.run({
        prompt: "epoch-one",
        cwd: fixture.tempDir,
        sessionScope: scope({ sessionEpoch: "epoch-1" }),
      });
      await runner.run({
        prompt: "epoch-two",
        cwd: fixture.tempDir,
        sessionScope: scope({ sessionEpoch: "epoch-2" }),
      });

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(2);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("interrupts an aborted turn without destroying its reusable session", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    const controller = new AbortController();

    try {
      const interrupted = await runner.run({
        prompt: "wait-for-interrupt",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        signal: controller.signal,
        onRunControl: () => controller.abort(),
      });
      const second = await runner.run({
        prompt: "after-interrupt",
        cwd: fixture.tempDir,
        threadId: interrupted.threadId,
        sessionScope: scope(),
      });

      expect(interrupted.cancelled).toBe(true);
      expect(second.finalText).toBe("done:after-interrupt");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "turn/interrupt")).toHaveLength(1);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(1);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(1);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("sends turn/interrupt when abort happens before turn/start returns its turn id", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    const controller = new AbortController();

    try {
      const run = runner.run({
        prompt: "delayed-turn-start",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        signal: controller.signal,
      });
      await waitForMessage(fixture.receivedPath, "turn/start");
      controller.abort();
      const interrupted = await run;
      const second = await runner.run({
        prompt: "after-delayed-interrupt",
        cwd: fixture.tempDir,
        threadId: interrupted.threadId,
        sessionScope: scope(),
      });

      expect(interrupted.cancelled).toBe(true);
      expect(second.finalText).toBe("done:after-delayed-interrupt");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "turn/interrupt")).toHaveLength(1);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(1);
    } finally {
      controller.abort();
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("moves one thread to a new chat owner instead of sharing its process", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const first = await runner.run({
        prompt: "owner-one",
        cwd: fixture.tempDir,
        threadId: "thread_shared",
        sessionScope: scope({ chatId: "chat_1" }),
      });
      const second = await runner.run({
        prompt: "owner-two",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ chatId: "chat_2" }),
      });

      expect(second.finalText).toBe("done:owner-two");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(2);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("rotates a chat session when its stable principal changes", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const first = await runner.run({
        prompt: "principal-one",
        cwd: fixture.tempDir,
        threadId: "thread_shared",
        sessionScope: scope({ principal: { openId: "ou_A" } }),
      });
      await runner.run({
        prompt: "principal-two",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ principal: { openId: "ou_B" } }),
      });

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(new Set(received.map((entry) => entry.pid))).toHaveLength(2);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("awaits onThreadBound before starting the first turn", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });

    try {
      const run = runner.run({
        prompt: "wait-for-binding",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        onThreadBound: () => bindingGate,
      });
      await waitForMessage(fixture.receivedPath, "thread/start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      let received = await readMessages(fixture.receivedPath);
      expect(received.some(({ message }) => message.method === "turn/start")).toBe(false);

      releaseBinding();
      await expect(run).resolves.toMatchObject({ finalText: "done:wait-for-binding" });
      received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "turn/start")).toHaveLength(1);
    } finally {
      releaseBinding();
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("closes the session without starting a turn when onThreadBound fails", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      await expect(
        runner.run({
          prompt: "must-not-run",
          cwd: fixture.tempDir,
          sessionScope: scope(),
          onThreadBound: async () => {
            throw new Error("durable bind failed");
          },
        }),
      ).rejects.toThrow("durable bind failed");

      const received = await readMessages(fixture.receivedPath);
      expect(received.some(({ message }) => message.method === "turn/start")).toBe(false);
      expect(received.some(({ message }) => message.method === "fixture/exit")).toBe(true);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("awaits onThreadBound in single-use fallback runs", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      await expect(
        runner.run({
          prompt: "single-use-must-not-run",
          cwd: fixture.tempDir,
          onThreadBound: async () => {
            throw new Error("single-use bind failed");
          },
        }),
      ).rejects.toThrow("single-use bind failed");

      const received = await readMessages(fixture.receivedPath);
      expect(received.some(({ message }) => message.method === "turn/start")).toBe(false);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("accepts an explicit null-turn MCP URL request in the active session generation", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    let callbackCount = 0;

    try {
      const first = await runner.run({
        prompt: "mcp-null-turn",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        onMcpElicitationRequest: async (request) => {
          callbackCount += 1;
          expect(request).toMatchObject({ mode: "url", turnId: null });
          return { action: "accept" };
        },
      });
      const second = await runner.run({
        prompt: "mcp-omitted-turn",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
        onMcpElicitationRequest: async (request) => {
          callbackCount += 1;
          expect(request).toMatchObject({ mode: "url", turnId: null });
          return { action: "accept" };
        },
      });

      expect(first.finalText).toBe("mcp-accepted");
      expect(second.finalText).toBe("mcp-accepted");
      expect(callbackCount).toBe(2);
      const received = await readMessages(fixture.receivedPath);
      expect(received.find(({ message }) => message.id === "mcp_null_1")?.message).toMatchObject({
        id: "mcp_null_1",
        result: { action: "accept" },
      });
      expect(received.find(({ message }) => message.id === "mcp_null_2")?.message).toMatchObject({
        id: "mcp_null_2",
        result: { action: "accept" },
      });
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("drops late notifications from a previous turn", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const first = await runner.run({
        prompt: "first",
        cwd: fixture.tempDir,
        sessionScope: scope(),
      });
      const second = await runner.run({
        prompt: "late-only",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
      });

      expect(second.finalText).toBe("(Codex finished without a final text response.)");
      expect(second.finalText).not.toContain("stale-turn-one");
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("does not let a previous turn's resolved event abort a reused raw request id", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callbackCount = 0;
    let secondSignal: AbortSignal | undefined;
    const callback = (_request: unknown, context: { signal: AbortSignal }) => {
      callbackCount += 1;
      if (callbackCount === 1) {
        return firstGate.then(() => "grantTurn" as const);
      }
      secondSignal = context.signal;
      return new Promise<"grantTurn">((resolve) => {
        setTimeout(() => resolve("grantTurn"), 30);
      });
    };

    try {
      const first = await runner.run({
        prompt: "tombstone-first",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        onPermissionApprovalRequest: callback,
      });
      const second = await runner.run({
        prompt: "tombstone-second",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
        onPermissionApprovalRequest: callback,
      });

      expect(callbackCount).toBe(2);
      expect(secondSignal?.aborted).toBe(false);
      expect(second.finalText).toBe("tombstone-kept-current");
    } finally {
      releaseFirst();
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("fails closed instead of starting a concurrent turn in one session", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    try {
      const first = runner.run({
        prompt: "wait-for-interrupt",
        cwd: fixture.tempDir,
        sessionScope: scope(),
        signal: controller.signal,
        onRunControl: () => markStarted(),
      });
      await started;
      await expect(
        runner.run({
          prompt: "must-not-start",
          cwd: fixture.tempDir,
          threadId: "thread_shared",
          sessionScope: scope(),
        }),
      ).rejects.toThrow("active turn");
      controller.abort();
      await first;

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "turn/start")).toHaveLength(1);
    } finally {
      controller.abort();
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("keeps a session permission grant in-process and loses it after principal rotation", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    let approvalCount = 0;
    const approve = async () => {
      approvalCount += 1;
      return "grantSession" as const;
    };

    try {
      const first = await runner.run({
        prompt: "permission-first",
        cwd: fixture.tempDir,
        sessionScope: scope({ principal: { openId: "ou_A" } }),
        onPermissionApprovalRequest: approve,
      });
      await runner.run({
        prompt: "permission-second",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ principal: { openId: "ou_A" } }),
        onPermissionApprovalRequest: approve,
      });
      await runner.run({
        prompt: "permission-rotated",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ principal: { openId: "ou_B" } }),
        onPermissionApprovalRequest: approve,
      });

      expect(approvalCount).toBe(2);
      const received = await readMessages(fixture.receivedPath);
      const responses = received.filter(
        ({ message }) =>
          typeof message.id === "string" &&
          message.id.startsWith("permission_") &&
          "result" in message,
      );
      expect(responses).toHaveLength(2);
      for (const { message } of responses) {
        expect(message).toMatchObject({
          result: { permissions: { network: { enabled: true } }, scope: "session" },
        });
      }
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("keeps acceptForSession command approval in-process and loses it after principal rotation", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);
    let approvalCount = 0;
    const approve = async () => {
      approvalCount += 1;
      return "acceptForSession" as const;
    };

    try {
      const first = await runner.run({
        prompt: "command-first",
        cwd: fixture.tempDir,
        sessionScope: scope({ principal: { openId: "ou_A" } }),
        onApprovalRequest: approve,
      });
      await runner.run({
        prompt: "command-second",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ principal: { openId: "ou_A" } }),
        onApprovalRequest: approve,
      });
      await runner.run({
        prompt: "command-rotated",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope({ principal: { openId: "ou_B" } }),
        onApprovalRequest: approve,
      });

      expect(approvalCount).toBe(2);
      const received = await readMessages(fixture.receivedPath);
      const responses = received.filter(
        ({ message }) =>
          typeof message.id === "string" &&
          message.id.startsWith("command_approval_") &&
          "result" in message,
      );
      expect(responses).toHaveLength(2);
      for (const { message } of responses) {
        expect(message).toEqual({
          id: "command_approval_1",
          result: { decision: "acceptForSession" },
        });
      }
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("evicts a crashed idle child and resumes the thread in a fresh process", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const first = await runner.run({
        prompt: "crash-after-turn",
        cwd: fixture.tempDir,
        sessionScope: scope(),
      });
      await waitForMessage(fixture.receivedPath, "fixture/exit");
      // The child writes fixture/exit from its own exit hook, which can become
      // visible just before the parent receives the close event. Let the
      // manager observe that event so this test exercises idle-session
      // eviction rather than the separate pre-submission retry boundary.
      await delay(25);
      const second = await runner.run({
        prompt: "after-crash",
        cwd: fixture.tempDir,
        threadId: first.threadId,
        sessionScope: scope(),
      });

      expect(second.finalText).toBe("done:after-crash");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(received.filter(({ message }) => message.method === "thread/resume")).toHaveLength(1);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("retries once when the app-server exits before turn/start is submitted", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const result = await runner.run({
        prompt: "after-startup-crash",
        cwd: fixture.tempDir,
        threadId: "thread_crash_before_turn_start_once",
        sessionScope: scope(),
      });

      expect(result.finalText).toBe("done:after-startup-crash");
      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(2);
      expect(received.filter(({ message }) => message.method === "thread/resume")).toHaveLength(2);
      expect(received.filter(({ message }) => message.method === "turn/start")).toHaveLength(1);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("does not retry after turn/start has been submitted", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      await expect(
        runner.run({
          prompt: "crash-during-turn-start",
          cwd: fixture.tempDir,
          sessionScope: scope(),
        }),
      ).rejects.toThrow("Codex app-server exited before responding.");

      const received = await readMessages(fixture.receivedPath);
      expect(received.filter(({ message }) => message.method === "initialize")).toHaveLength(1);
      expect(received.filter(({ message }) => message.method === "turn/start")).toHaveLength(1);
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("dispose terminates idle sessions and rejects later runs", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      await runner.run({
        prompt: "before-dispose",
        cwd: fixture.tempDir,
        sessionScope: scope(),
      });
      await runner.dispose();
      await waitForMessage(fixture.receivedPath, "fixture/exit");

      await expect(
        runner.run({
          prompt: "after-dispose",
          cwd: fixture.tempDir,
          sessionScope: scope(),
        }),
      ).rejects.toThrow("disposed");
      await expect(
        runner.run({
          prompt: "single-use-after-dispose",
          cwd: fixture.tempDir,
        }),
      ).rejects.toThrow("disposed");
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("dispose terminates active transient app-server requests and blocks new ones", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const transientOutcome = runner.listThreads().then(
        () => null,
        (error: unknown) => error,
      );
      await waitForMessage(fixture.receivedPath, "thread/list");
      await runner.dispose();

      expect(await transientOutcome).toBeInstanceOf(Error);
      const before = await readMessages(fixture.receivedPath);
      const initializeCount = before.filter(
        ({ message }) => message.method === "initialize",
      ).length;
      await expect(runner.listThreads()).rejects.toThrow("disposed");
      const after = await readMessages(fixture.receivedPath);
      expect(after.filter(({ message }) => message.method === "initialize")).toHaveLength(
        initializeCount,
      );
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test("returns a non-zero result for a failed scoped turn", async () => {
    const fixture = await createSessionFakeCodex();
    const runner = createRunner(fixture.fakeCodex, fixture.tempDir);

    try {
      const result = await runner.run({
        prompt: "failed-turn",
        cwd: fixture.tempDir,
        sessionScope: scope(),
      });

      expect(result.exitCode).toBe(1);
      expect(result.finalText).toContain("scoped failure");
    } finally {
      await runner.dispose?.();
      await rm(fixture.tempDir, { recursive: true, force: true });
    }
  });
});

function createRunner(
  fakeCodex: string,
  cwd: string,
  overrides: NodeJS.ProcessEnv = {},
): CodexRunner {
  return new CodexRunner(
    loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_BIN: fakeCodex,
      CODEX_WORKDIR: cwd,
      CODEX_APPROVAL_POLICY: "on-request",
      ...overrides,
    }),
    new ConsoleLogger("error"),
  );
}

async function createSessionFakeCodex(): Promise<{
  tempDir: string;
  fakeCodex: string;
  receivedPath: string;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-session-"));
  const fakeCodex = path.join(tempDir, "fake-codex.cjs");
  const receivedPath = path.join(tempDir, "received.jsonl");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const receivedPath = ${JSON.stringify(receivedPath)};
const rl = readline.createInterface({ input: process.stdin });
let turnSeq = 0;
let activeTurnId;
let activeThreadId = "thread_shared";
const crashBeforeTurnStartPath = ${JSON.stringify(path.join(tempDir, "crash-before-turn-start-once"))};
let sessionPermissionGranted = false;
let sessionCommandApproved = false;
const completedTurns = new Set();
function send(message) { console.log(JSON.stringify(message)); }
function completeTurn(status, text) {
  if (completedTurns.has(activeTurnId)) return;
  completedTurns.add(activeTurnId);
  if (text) {
    send({ method: "item/completed", params: { threadId: activeThreadId, turnId: activeTurnId, item: { type: "agentMessage", id: "msg_" + turnSeq, text, phase: "final_answer" } } });
  }
  send({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: activeTurnId, items: [], itemsView: "full", status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(receivedPath, JSON.stringify({ pid: process.pid, message }) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.144.5 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "fake-default-model", model: "fake-default-model", isDefault: true }] } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    activeThreadId = message.method === "thread/resume" && typeof message.params?.threadId === "string"
      ? message.params.threadId
      : "thread_shared";
    if (activeThreadId === "thread_crash_before_turn_start_once" && !fs.existsSync(crashBeforeTurnStartPath)) {
      fs.writeFileSync(crashBeforeTurnStartPath, "crashed");
      process.exit(24);
    }
    send({ id: message.id, result: { thread: { id: activeThreadId } } });
    return;
  }
  if (message.method === "turn/start") {
    turnSeq += 1;
    activeTurnId = "turn_" + turnSeq;
    const prompt = message.params.input[0].text;
    if (prompt === "crash-during-turn-start") process.exit(25);
    if (prompt === "delayed-turn-start") {
      setTimeout(() => send({ id: message.id, result: { turn: { id: activeTurnId } } }), 50);
      return;
    }
    send({ id: message.id, result: { turn: { id: activeTurnId } } });
    if (prompt === "mcp-null-turn" || prompt === "mcp-omitted-turn") {
      const params = { serverName: "test-mcp", threadId: activeThreadId, message: "Open login", mode: "url", elicitationId: "elicitation_" + turnSeq, url: "https://example.com/login" };
      if (prompt === "mcp-null-turn") params.turnId = null;
      send({ id: "mcp_null_" + turnSeq, method: "mcpServer/elicitation/request", params });
      return;
    }
    if (prompt === "tombstone-first") {
      send({ id: "reused_request", method: "item/permissions/requestApproval", params: { cwd: ${JSON.stringify(tempDir)}, itemId: "tombstone_first", permissions: {}, startedAtMs: 1, threadId: activeThreadId, turnId: activeTurnId } });
      setTimeout(() => completeTurn("completed", "tombstone-first-done"), 60);
      return;
    }
    if (prompt === "tombstone-second") {
      send({ id: "reused_request", method: "item/permissions/requestApproval", params: { cwd: ${JSON.stringify(tempDir)}, itemId: "tombstone_second", permissions: {}, startedAtMs: 2, threadId: activeThreadId, turnId: activeTurnId } });
      setTimeout(() => send({ method: "serverRequest/resolved", params: { requestId: "reused_request", threadId: activeThreadId } }), 40);
      setTimeout(() => completeTurn("completed", ""), 150);
      return;
    }
    if (prompt === "failed-turn") {
      send({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: activeTurnId, items: [], itemsView: "full", status: "failed", error: { message: "scoped failure" }, startedAt: 1, completedAt: 2, durationMs: 1 } } });
      return;
    }
    if (prompt === "late-only") {
      send({ method: "item/completed", params: { threadId: activeThreadId, turnId: "turn_1", item: { type: "agentMessage", id: "stale", text: "stale-turn-one", phase: "final_answer" } } });
      completeTurn("completed", "");
      return;
    }
    if (prompt.startsWith("permission-") && !sessionPermissionGranted) {
      send({ id: "permission_" + turnSeq, method: "item/permissions/requestApproval", params: { cwd: ${JSON.stringify(tempDir)}, itemId: "permission_item_" + turnSeq, permissions: { network: { enabled: true } }, startedAtMs: 1, threadId: activeThreadId, turnId: activeTurnId } });
      return;
    }
    if (prompt.startsWith("command-") && !sessionCommandApproved) {
      send({ id: "command_approval_" + turnSeq, method: "item/commandExecution/requestApproval", params: { threadId: activeThreadId, turnId: activeTurnId, itemId: "command_item_" + turnSeq, startedAtMs: 1, command: "printf scoped", cwd: ${JSON.stringify(tempDir)}, availableDecisions: ["acceptForSession", "decline", "cancel"] } });
      return;
    }
    if (prompt !== "wait-for-interrupt") {
      completeTurn("completed", "done:" + prompt);
      if (prompt === "crash-after-turn") setTimeout(() => process.exit(23), 10);
    }
    return;
  }
  if (typeof message.id === "string" && message.id.startsWith("permission_") && message.result) {
    sessionPermissionGranted = message.result.scope === "session";
    completeTurn("completed", "permission-granted");
    return;
  }
  if (typeof message.id === "string" && message.id.startsWith("command_approval_") && message.result) {
    sessionCommandApproved = message.result.decision === "acceptForSession";
    completeTurn("completed", "command-approved");
    return;
  }
  if (typeof message.id === "string" && message.id.startsWith("mcp_null_") && message.result) {
    completeTurn("completed", "mcp-accepted");
    return;
  }
  if (message.id === "reused_request" && message.result) {
    completeTurn("completed", "tombstone-kept-current");
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    completeTurn("interrupted", "");
  }
});
process.on("exit", (code) => fs.appendFileSync(receivedPath, JSON.stringify({ pid: process.pid, message: { method: "fixture/exit", code } }) + "\\n"));
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(fakeCodex, 0o755);
  return { tempDir, fakeCodex, receivedPath };
}

async function readMessages(
  filePath: string,
): Promise<Array<{ pid: number; message: Record<string, unknown> }>> {
  const contents = await readFile(filePath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; message: Record<string, unknown> });
}

async function waitForMessage(filePath: string, method: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const received = await readMessages(filePath);
    if (received.some(({ message }) => message.method === method)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
