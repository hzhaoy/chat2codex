import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCodexArgs,
  CodexRunner,
  parseCodexJsonLine,
  summarizeCodexProgress,
} from "../src/agent/codex-runner.js";
import { loadConfig } from "../src/config/env.js";
import { ConsoleLogger } from "../src/util/logger.js";

describe("codex runner helpers", () => {
  test("builds new exec arguments with sandbox and cwd", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_BIN: "codex",
      CODEX_WORKDIR: "/tmp/chat2codex",
      CODEX_SANDBOX: "read-only",
      CODEX_APPROVAL_POLICY: "on-request",
      CODEX_MODEL: "gpt-test",
      CODEX_SKIP_GIT_REPO_CHECK: "true",
    });

    expect(
      buildCodexArgs(config, {
        prompt: "summarize",
        cwd: "/tmp/chat2codex",
      }),
    ).toEqual([
      "--ask-for-approval",
      "on-request",
      "exec",
      "--json",
      "--model",
      "gpt-test",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/chat2codex",
      "summarize",
    ]);
  });

  test("builds resume arguments without sandbox or cwd", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: "/tmp/chat2codex",
    });

    expect(
      buildCodexArgs(config, {
        prompt: "continue",
        cwd: "/tmp/chat2codex",
        threadId: "thread_123",
      }),
    ).toEqual([
      "--ask-for-approval",
      "never",
      "exec",
      "resume",
      "--json",
      "thread_123",
      "continue",
    ]);
  });

  test("parses JSONL events defensively", () => {
    expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"t1"}')).toEqual({
      type: "thread.started",
      thread_id: "t1",
    });
    expect(parseCodexJsonLine("not json")).toBeNull();
  });

  test("summarizes selected JSONL events into user-facing progress", () => {
    expect(summarizeCodexProgress({ type: "turn.started" })).toEqual({
      kind: "running",
      text: "Codex 正在处理。",
      eventType: "turn.started",
    });
    expect(
      summarizeCodexProgress({
        type: "item.started",
        item: { type: "tool_call", name: "exec_command" },
      }),
    ).toEqual({
      kind: "running",
      text: "Codex 正在调用工具：exec_command。",
      eventType: "item.started",
      itemType: "tool_call",
    });
    expect(
      summarizeCodexProgress({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
    ).toBeNull();
  });

  test("returns a cancelled result when the run signal is already aborted", async () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_BIN: "missing-codex-binary-for-test",
      CODEX_WORKDIR: "/tmp/chat2codex",
    });
    const controller = new AbortController();
    controller.abort();

    const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
      prompt: "stop",
      cwd: "/tmp/chat2codex",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      cancelled: true,
      exitCode: null,
      finalText: "",
    });
  });

  test("marks app-server threads from other Codex CLI versions unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.136.0 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/list") {
    send({
      id: message.id,
      result: {
        data: [
          { id: "thread_newer", cwd: "/repo/a", cliVersion: "0.142.3" },
          { id: "thread_current", cwd: "/repo/a", cliVersion: "0.136.0" }
        ]
      }
    });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).listThreads();

      expect(result.threads[0]).toMatchObject({
        id: "thread_newer",
        resumable: false,
      });
      expect(result.threads[0]?.unavailableReason).toContain("0.142.3");
      expect(result.threads[0]?.unavailableReason).toContain("0.136.0");
      expect(result.threads[1]).toMatchObject({
        id: "thread_current",
        resumable: true,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("allows threads from the same Codex CLI version family", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.142.4 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/list") {
    send({
      id: message.id,
      result: {
        data: [
          { id: "thread_patch", cwd: "/repo/a", cliVersion: "0.142.3" },
          { id: "thread_older_family", cwd: "/repo/a", cliVersion: "0.136.0" }
        ]
      }
    });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).listThreads();

      expect(result.threads[0]).toMatchObject({
        id: "thread_patch",
        resumable: true,
      });
      expect(result.threads[1]).toMatchObject({
        id: "thread_older_family",
        resumable: false,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("wraps app-server thread control requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.144.5 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/search") {
    send({ id: message.id, result: { data: [{ snippet: "matched text", thread: { id: "thread_search", cwd: "/repo/a", name: "Search hit", cliVersion: "0.144.5" } }] } });
    return;
  }
  if (message.method === "thread/turns/list") {
    if (message.params.itemsView === "full") {
      if (message.params.cursor === "page-2") {
        send({ id: message.id, result: { data: [{ id: "turn_1", status: "completed", itemsView: "full", items: [{ id: "item_cmd", type: "commandExecution", command: "bun test", cwd: "/repo/a", status: "completed", exitCode: 0, commandActions: [] }] }], nextCursor: null, backwardsCursor: null } });
      } else {
        send({ id: message.id, result: { data: [{ id: "turn_other", status: "completed", itemsView: "full", items: [] }], nextCursor: "page-2", backwardsCursor: null } });
      }
    } else {
      send({ id: message.id, result: { data: [{ id: "turn_1", status: "completed", startedAt: 4000, itemsView: "summary", items: [{ id: "item_user", type: "userMessage", content: [{ type: "text", text: "hello" }] }] }] } });
    }
    return;
  }
  if (message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { id: "thread_fork", cwd: message.params.cwd, name: "Forked", cliVersion: "0.144.5" } } });
    return;
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unexpected method: " + message.method } });
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const runner = new CodexRunner(config, new ConsoleLogger("error"));

      const search = await runner.searchThreads({ searchTerm: "Search", limit: 5 });
      expect(search.results[0]?.thread).toMatchObject({ id: "thread_search", resumable: true });
      expect(search.results[0]?.snippet).toBe("matched text");

      const turns = await runner.listThreadTurns({ threadId: "thread_search" });
      expect(turns.turns[0]).toMatchObject({
        id: "turn_1",
        status: "completed",
        items: [{ id: "item_user", type: "userMessage", text: "hello" }],
      });

      const items = await runner.listTurnItems({ threadId: "thread_search", turnId: "turn_1" });
      expect(items.items[0]).toMatchObject({
        id: "item_cmd",
        type: "commandExecution",
        command: "bun test",
        exitCode: 0,
      });

      const forked = await runner.forkThread({ threadId: "thread_search", cwd: "/repo/a" });
      expect(forked).toMatchObject({ id: "thread_fork", cwd: "/repo/a", resumable: true });

      await expect(runner.compactThread("thread_fork")).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reads messages from schema-shaped app-server error notifications", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.144.5 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send({ method: "error", params: { threadId: "thread_fake", turnId: "turn_fake", willRetry: false, error: { message: "schema-shaped failure", codexErrorInfo: null, additionalDetails: null } } });
    send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "interrupted", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "trigger an error",
        cwd: tempDir,
      });

      expect(result.finalText).toBe("schema-shaped failure");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not retain retryable app-server errors after the turn succeeds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "Codex Desktop/0.144.5 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send({ method: "error", params: { threadId: "thread_fake", turnId: "turn_fake", willRetry: true, error: { message: "temporary failure", codexErrorInfo: null, additionalDetails: null } } });
    send({ method: "item/completed", params: { threadId: "thread_fake", turnId: "turn_fake", item: { id: "agent_1", type: "agentMessage", text: "recovered", phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "recover from a retryable error",
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe("recovered");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs through app-server approval requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send({
      id: "approval_1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread_fake",
        turnId: "turn_fake",
        itemId: "item_cmd",
        command: "rm -rf build",
        cwd: "/tmp/repo",
        availableDecisions: ["accept", "decline"]
      }
    });
    return;
  }
  if (message.id === "approval_1") {
    send({ method: "item/completed", params: { threadId: "thread_fake", turnId: "turn_fake", completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg_1", text: "approved", phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
        CODEX_APPROVAL_POLICY: "on-request",
      });
      const decisions: unknown[] = [];
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "run command",
        cwd: tempDir,
        onApprovalRequest: async (request) => {
          decisions.push(request.decisions);
          expect(request).toMatchObject({
            id: "approval_1",
            kind: "command",
            command: "rm -rf build",
            cwd: "/tmp/repo",
          });
          return "accept";
        },
      });

      expect(decisions).toEqual([["accept", "decline"]]);
      expect(result).toMatchObject({
        threadId: "thread_fake",
        finalText: "approved",
        exitCode: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("collects app-server run summaries and exposes steering control", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    const receivedPath = path.join(tempDir, "received.jsonl");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const receivedPath = process.env.RECEIVED_PATH;
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
function remember(message) {
  if (receivedPath) fs.appendFileSync(receivedPath, JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  remember(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", delta: "ok\\n" }
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread_fake",
        turnId: "turn_fake",
        item: { type: "commandExecution", id: "cmd_1", command: "bun test", cwd: "/repo", status: "completed", exitCode: 0, durationMs: 42 }
      }
    });
    send({
      method: "item/fileChange/patchUpdated",
      params: { threadId: "thread_fake", turnId: "turn_fake", changes: [{ path: "src/app.ts" }] }
    });
    send({
      method: "turn/diff/updated",
      params: { threadId: "thread_fake", turnId: "turn_fake", diff: "diff --git a/src/app.ts b/src/app.ts\\n+++ b/src/app.ts\\n@@\\n+hello\\n-old\\n" }
    });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "thread_fake", turnId: "turn_fake", item: { type: "agentMessage", id: "msg_1", text: "done", phase: "final_answer", memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
    }, 30);
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: {} });
    return;
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    const originalReceivedPath = process.env.RECEIVED_PATH;
    try {
      process.env.RECEIVED_PATH = receivedPath;
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "run command",
        cwd: tempDir,
        onRunControl: (control) => {
          expect(control).toMatchObject({
            threadId: "thread_fake",
            turnId: "turn_fake",
          });
          void control.steer("please continue");
        },
      });

      expect(result).toMatchObject({
        threadId: "thread_fake",
        finalText: "done",
        exitCode: 0,
        summary: {
          durationMs: 100,
          diffStat: "1 file(s), +1 -1",
          changedFiles: ["src/app.ts"],
          fileChangeCount: 1,
          commands: [
            {
              command: "bun test",
              cwd: "/repo",
              status: "completed",
              exitCode: 0,
              durationMs: 42,
              outputPreview: "ok",
            },
          ],
        },
      });
      const received = await readJsonl(receivedPath);
      expect(received).toContainEqual(
        expect.objectContaining({
          method: "turn/steer",
          params: expect.objectContaining({
            threadId: "thread_fake",
            expectedTurnId: "turn_fake",
          }),
        }),
      );
    } finally {
      if (originalReceivedPath === undefined) {
        delete process.env.RECEIVED_PATH;
      } else {
        process.env.RECEIVED_PATH = originalReceivedPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retries app-server steering while the active turn is still settling", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    const receivedPath = path.join(tempDir, "received.jsonl");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const receivedPath = process.env.RECEIVED_PATH;
const rl = readline.createInterface({ input: process.stdin });
let steerAttempts = 0;
function send(message) { console.log(JSON.stringify(message)); }
function remember(message) {
  if (receivedPath) fs.appendFileSync(receivedPath, JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  remember(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    return;
  }
  if (message.method === "turn/steer") {
    steerAttempts += 1;
    if (steerAttempts === 1) {
      send({ id: message.id, error: { code: -32000, message: "no active turn to steer" } });
      return;
    }
    send({ id: message.id, result: {} });
    send({ method: "item/completed", params: { threadId: "thread_fake", turnId: "turn_fake", item: { type: "agentMessage", id: "msg_1", text: "done", phase: "final_answer", memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
    return;
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    const originalReceivedPath = process.env.RECEIVED_PATH;
    try {
      process.env.RECEIVED_PATH = receivedPath;
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let steerPromise: Promise<void> | undefined;
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "run command",
        cwd: tempDir,
        onRunControl: (control) => {
          steerPromise = control.steer("please continue");
        },
      });

      await expect(steerPromise).resolves.toBeUndefined();
      expect(result).toMatchObject({
        threadId: "thread_fake",
        finalText: "done",
        exitCode: 0,
      });
      const received = await readJsonl(receivedPath);
      expect(received.filter((message) => message.method === "turn/steer")).toHaveLength(2);
    } finally {
      if (originalReceivedPath === undefined) {
        delete process.env.RECEIVED_PATH;
      } else {
        process.env.RECEIVED_PATH = originalReceivedPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("treats a cancelled app-server approval as a cancelled run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { console.log(JSON.stringify(message)); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send({
      id: "approval_1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread_fake",
        turnId: "turn_fake",
        itemId: "item_cmd",
        command: "printf hello > smoke.txt",
        cwd: "/tmp/repo",
        availableDecisions: ["accept", "cancel"]
      }
    });
    return;
  }
  if (message.id === "approval_1") {
    send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    await chmod(fakeCodex, 0o755);

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
        CODEX_APPROVAL_POLICY: "on-request",
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "run command",
        cwd: tempDir,
        onApprovalRequest: async () => "cancel",
      });

      expect(result).toMatchObject({
        threadId: "thread_fake",
        cancelled: true,
        finalText: "",
        exitCode: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function readJsonl(filePath: string): Promise<unknown[]> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
