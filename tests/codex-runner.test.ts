import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
