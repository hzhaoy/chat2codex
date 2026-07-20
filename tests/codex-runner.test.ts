import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCodexArgs,
  CodexRunner,
  parseCodexJsonLine,
  summarizeCodexProgress,
  type CodexApprovalDecision,
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

  test("rejects unknown run requests and advertises the package version", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
  send({ id: "unknown_run_1", method: "future/unsafeRequest", params: {} });
  return;
}
if (message.id === "unknown_run_1") {
  send({
    id: "unsupported_input_1",
    method: "item/tool/requestUserInput",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_1", questions: [] }
  });
  return;
}
if (message.id === "unsupported_input_1") {
  send({ id: { unsafe: true }, method: "future/invalidRequest", params: {} });
  return;
}
if (message.id === null && message.error && message.error.code === -32600) completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let approvalCalls = 0;
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise an unknown request",
        cwd: tempDir,
        onApprovalRequest: async () => {
          approvalCalls += 1;
          return "cancel";
        },
      });

      expect(result.finalText).toBe("done");
      expect(approvalCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      const unknownResponse = received.find((message) => message.id === "unknown_run_1");
      expect(unknownResponse).toMatchObject({
        id: "unknown_run_1",
        error: { code: -32601 },
      });
      expect(unknownResponse && "result" in unknownResponse).toBe(false);
      const unsupportedResponse = received.find(
        (message) => message.id === "unsupported_input_1",
      );
      expect(unsupportedResponse).toEqual({
        id: "unsupported_input_1",
        error: { code: -32000, message: "User input request failed." },
      });
      expect(unsupportedResponse && "result" in unsupportedResponse).toBe(false);
      const invalidRequestResponse = received.find(
        (message) =>
          message.id === null &&
          (message.error as { code?: number } | undefined)?.code === -32600,
      );
      expect(invalidRequestResponse).toMatchObject({
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      expect(invalidRequestResponse && "result" in invalidRequestResponse).toBe(false);

      const packageVersion = await readPackageVersionForTest();
      expect(received).toContainEqual(
        expect.objectContaining({
          method: "initialize",
          params: expect.objectContaining({
            clientInfo: expect.objectContaining({ version: packageVersion }),
          }),
        }),
      );
      expect(received).toContainEqual(expect.objectContaining({ method: "initialized" }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("handles requestUserInput with normalized defaults and an exact response", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "user_input_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "input_1",
      autoResolutionMs: 60000,
      questions: [
        {
          id: "provider",
          header: "Provider",
          question: "Choose a provider",
          isOther: true,
          isSecret: false,
          options: [
            { label: "OpenAI", description: "Use OpenAI" },
            { label: "Local", description: "Use a local model" }
          ]
        },
        { id: "note", header: "Note", question: "Add a note" }
      ]
    }
  });
  return;
}
if (message.id === "user_input_1") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const requests: unknown[] = [];
      const signals: AbortSignal[] = [];
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise user input",
        cwd: tempDir,
        onUserInputRequest: async (request, context) => {
          requests.push(request);
          signals.push(context.signal);
          return {
            answers: {
              provider: { answers: ["OpenAI"] },
              note: { answers: ["ship it"] },
            },
          };
        },
      });

      expect(result.finalText).toBe("done");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        id: expect.any(String),
        threadId: "thread_fake",
        turnId: "turn_fake",
        itemId: "input_1",
        autoResolutionMs: 60_000,
        questions: [
          {
            id: "provider",
            header: "Provider",
            question: "Choose a provider",
            isOther: true,
            isSecret: false,
            options: [
              { label: "OpenAI", description: "Use OpenAI" },
              { label: "Local", description: "Use a local model" },
            ],
          },
          {
            id: "note",
            header: "Note",
            question: "Add a note",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
      });
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "user_input_1")).toEqual({
        id: "user_input_1",
        result: {
          answers: {
            provider: { answers: ["OpenAI"] },
            note: { answers: ["ship it"] },
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects malformed requestUserInput params before invoking the callback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
const invalidUserInputs = [
  { id: "invalid_input_1", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_1", questions: "bad" } },
  { id: "invalid_input_2", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_2", autoResolutionMs: -1, questions: [] } },
  { id: "invalid_input_3", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_3", autoResolutionMs: 1.5, questions: [] } },
  { id: "invalid_input_4", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_4", questions: [{ id: "same", header: "One", question: "First" }, { id: "same", header: "Two", question: "Second" }] } },
  { id: "invalid_input_5", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_5", questions: [{ id: "q", header: "Header", question: "Question", isSecret: "yes" }] } },
  { id: "invalid_input_6", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_6", questions: [{ id: "q", header: "Header", question: "Question", options: [{ label: "Only label" }] }] } },
  { id: "invalid_input_7", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_7", questions: [{ id: "", header: "Header", question: "Question" }] } },
  { id: "invalid_input_8", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_8", questions: [{ id: "q".repeat(129), header: "Header", question: "Question" }] } },
  { id: "invalid_input_9", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_9", questions: Array.from({ length: 4 }, (_, index) => ({ id: "q" + index, header: "Header", question: "Question" })) } },
  { id: "invalid_input_10", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_10", questions: [{ id: "q", header: "Header", question: "Question", options: Array.from({ length: 11 }, () => ({ label: "Label", description: "Description" })) }] } },
  { id: "invalid_input_11", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_11", questions: [{ id: "q", header: "h".repeat(65), question: "Question" }] } },
  { id: "invalid_input_12", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_12", questions: [{ id: "q", header: "Header", question: "q".repeat(1025) }] } },
  { id: "invalid_input_13", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_13", questions: [{ id: "q", header: "Header", question: "Question", options: [{ label: "l".repeat(129), description: "Description" }] }] } },
  { id: "invalid_input_14", params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "input_14", questions: [{ id: "q", header: "Header", question: "Question", options: [{ label: "Label", description: "d".repeat(513) }] }] } }
];
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
  state.invalidInputIndex = 0;
  const input = invalidUserInputs[state.invalidInputIndex];
  send({ id: input.id, method: "item/tool/requestUserInput", params: input.params });
  return;
}
if (String(message.id).startsWith("invalid_input_")) {
  state.invalidInputIndex += 1;
  const input = invalidUserInputs[state.invalidInputIndex];
  if (input) send({ id: input.id, method: "item/tool/requestUserInput", params: input.params });
  else completeTurn("done");
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let callbackCalls = 0;
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise invalid user input",
        cwd: tempDir,
        onUserInputRequest: async () => {
          callbackCalls += 1;
          return { answers: {} };
        },
      });

      expect(callbackCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      for (let index = 1; index <= 14; index += 1) {
        const id = `invalid_input_${index}`;
        const response = received.find((message) => message.id === id);
        expect(response).toMatchObject({ id, error: { code: -32602 } });
        expect(response && "result" in response).toBe(false);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fails closed for invalid requestUserInput callback responses without leaking values", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
function sendUserInput(id) {
  send({
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: id,
      questions: [{ id: "secret", header: "Secret", question: "Enter it", isSecret: true }]
    }
  });
}
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
  sendUserInput("invalid_output_1");
  return;
}
if (message.id === "invalid_output_1") {
  sendUserInput("invalid_output_2");
  return;
}
if (message.id === "invalid_output_2") {
  sendUserInput("invalid_output_3");
  return;
}
if (message.id === "invalid_output_3") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let callbackCalls = 0;
      const logged: unknown[] = [];
      const logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string, data?: unknown) => logged.push([message, data]),
        error: (message: string, data?: unknown) => logged.push([message, data]),
      };
      await new CodexRunner(config, logger).run({
        prompt: "exercise invalid callback output",
        cwd: tempDir,
        onUserInputRequest: async () => {
          callbackCalls += 1;
          if (callbackCalls === 1) {
            return { answers: { unexpected: { answers: ["DO_NOT_LEAK"] } } } as never;
          }
          if (callbackCalls === 2) {
            return { answers: { secret: ["DO_NOT_LEAK"] } } as never;
          }
          throw new Error("DO_NOT_LEAK");
        },
      });

      expect(callbackCalls).toBe(3);
      const receivedText = await readFile(receivedPath, "utf8");
      expect(receivedText).not.toContain("DO_NOT_LEAK");
      expect(JSON.stringify(logged)).not.toContain("DO_NOT_LEAK");
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      for (const id of ["invalid_output_1", "invalid_output_2", "invalid_output_3"]) {
        expect(received.find((message) => message.id === id)).toEqual({
          id,
          error: { code: -32000, message: "User input request failed." },
        });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("aborts requestUserInput callbacks when the server resolves them and suppresses late responses", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "resolved_input_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "input_1",
      questions: [{ id: "choice", header: "Choice", question: "Choose" }]
    }
  });
  setTimeout(() => {
    send({ method: "serverRequest/resolved", params: { threadId: "thread_fake", requestId: "resolved_input_1" } });
    setTimeout(() => completeTurn("done"), 30);
  }, 10);
  return;
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let callbackSignal: AbortSignal | undefined;
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise resolved user input",
        cwd: tempDir,
        onUserInputRequest: async (_request, context) => {
          callbackSignal = context.signal;
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { answers: { choice: { answers: ["late"] } } };
        },
      });

      expect(callbackSignal?.aborted).toBe(true);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.some((message) => message.id === "resolved_input_1")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not invoke requestUserInput callbacks resolved in the same stdout batch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "same_batch_input_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "input_1",
      questions: [{ id: "choice", header: "Choice", question: "Choose" }]
    }
  });
  send({
    method: "serverRequest/resolved",
    params: { threadId: "thread_fake", requestId: "same_batch_input_1" }
  });
  setTimeout(() => completeTurn("done"), 20);
  return;
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let callbackCalls = 0;
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise same-batch resolution",
        cwd: tempDir,
        onUserInputRequest: async () => {
          callbackCalls += 1;
          return { answers: { choice: { answers: ["late"] } } };
        },
      });

      expect(result.finalText).toBe("done");
      expect(callbackCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.some((message) => message.id === "same_batch_input_1")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("aborts pending requestUserInput callbacks when the run is cancelled", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "aborted_input_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "input_1",
      questions: [{ id: "choice", header: "Choice", question: "Choose" }]
    }
  });
  setTimeout(() => completeTurn("fallback"), 500);
  return;
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const controller = new AbortController();
      let callbackSignal: AbortSignal | undefined;
      let markCallbackStarted: (() => void) | undefined;
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve;
      });
      const run = new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise aborted user input",
        cwd: tempDir,
        signal: controller.signal,
        onUserInputRequest: async (_request, context) => {
          callbackSignal = context.signal;
          markCallbackStarted?.();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { answers: { choice: { answers: ["late"] } } };
        },
      });

      const started = await Promise.race([
        callbackStarted.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 750)),
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      controller.abort();
      const result = await run;

      expect(started).toBe(true);
      expect(callbackSignal?.aborted).toBe(true);
      expect(result.cancelled).toBe(true);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.some((message) => message.id === "aborted_input_1")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects unknown short-lived requests and completes listThreads", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
if (message.method === "initialize") {
  send({ id: message.id, result: { userAgent: "Codex Desktop/0.144.5 test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
  return;
}
if (message.method === "thread/list") {
  state.listRequestId = message.id;
  send({ id: "unknown_list_1", method: "future/shortLivedRequest", params: {} });
  return;
}
if (message.id === "unknown_list_1") {
  send({
    id: "short_lived_input_1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "input_1",
      questions: [{ id: "choice", header: "Choice", question: "Choose" }]
    }
  });
  return;
}
if (message.id === "short_lived_input_1") {
  send({ id: state.listRequestId, result: { data: [] } });
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).listThreads();

      expect(result.threads).toEqual([]);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      const unknownResponse = received.find((message) => message.id === "unknown_list_1");
      expect(unknownResponse).toMatchObject({
        id: "unknown_list_1",
        error: { code: -32601 },
      });
      expect(unknownResponse && "result" in unknownResponse).toBe(false);
      expect(received.find((message) => message.id === "short_lived_input_1")).toEqual({
        id: "short_lived_input_1",
        error: { code: -32000, message: "User input request failed." },
      });

      const packageVersion = await readPackageVersionForTest();
      expect(received).toContainEqual(
        expect.objectContaining({
          method: "initialize",
          params: expect.objectContaining({
            clientInfo: expect.objectContaining({ version: packageVersion }),
          }),
        }),
      );
      expect(received).toContainEqual(expect.objectContaining({ method: "initialized" }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns schema-valid safe defaults for elicitation and permission requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "elicitation_1",
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "test-mcp",
      threadId: "thread_fake",
      turnId: "turn_fake",
      message: "Provide a secret",
      mode: "openai/form",
      requestedSchema: {}
    }
  });
  return;
}
if (message.id === "elicitation_1") {
  send({
    id: "permissions_1",
    method: "item/permissions/requestApproval",
    params: {
      cwd: "/tmp/repo",
      itemId: "permission_item_1",
      permissions: {},
      startedAtMs: 1,
      threadId: "thread_fake",
      turnId: "turn_fake"
    }
  });
  return;
}
if (message.id === "permissions_1") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let approvalCalls = 0;
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise safe interactive defaults",
        cwd: tempDir,
        onApprovalRequest: async () => {
          approvalCalls += 1;
          return "accept";
        },
      });

      expect(approvalCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "elicitation_1")).toEqual({
        id: "elicitation_1",
        result: { action: "cancel", content: null },
      });
      expect(received.find((message) => message.id === "permissions_1")).toEqual({
        id: "permissions_1",
        result: { permissions: {}, scope: "turn" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects malformed elicitation and permission requests before applying safe defaults", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "invalid_elicitation_1",
    method: "mcpServer/elicitation/request",
    params: { serverName: "test-mcp", threadId: "thread_fake", message: "Missing schema", mode: "openai/form" }
  });
  return;
}
if (message.id === "invalid_elicitation_1") {
  send({
    id: "invalid_permissions_1",
    method: "item/permissions/requestApproval",
    params: { cwd: "/tmp/repo", itemId: "permission_item_1", startedAtMs: 1, threadId: "thread_fake", turnId: "turn_fake" }
  });
  return;
}
if (message.id === "invalid_permissions_1") {
  send({
    id: "invalid_permissions_extra_1",
    method: "item/permissions/requestApproval",
    params: { cwd: "/tmp/repo", itemId: "permission_item_2", permissions: { unexpected: true }, startedAtMs: 2, threadId: "thread_fake", turnId: "turn_fake" }
  });
  return;
}
if (message.id === "invalid_permissions_extra_1") {
  send({
    id: "invalid_elicitation_identity_1",
    method: "mcpServer/elicitation/request",
    params: { threadId: "thread_fake", message: "Missing server", mode: "openai/form", requestedSchema: {} }
  });
  return;
}
if (message.id === "invalid_elicitation_identity_1") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise malformed safe defaults",
        cwd: tempDir,
      });

      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      for (const id of [
        "invalid_elicitation_1",
        "invalid_permissions_1",
        "invalid_permissions_extra_1",
        "invalid_elicitation_identity_1",
      ]) {
        const response = received.find((message) => message.id === id);
        expect(response).toMatchObject({ id, error: { code: -32602 } });
        expect(response && "result" in response).toBe(false);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects command and file approvals that omit required params", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "invalid_command_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", availableDecisions: ["decline"] }
  });
  send({
    id: "invalid_file_1",
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", startedAtMs: 1 }
  });
  send({
    id: "invalid_additional_permissions_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_2", startedAtMs: 2, availableDecisions: ["decline"], additionalPermissions: { network: "bad" } }
  });
  send({
    id: "invalid_network_context_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_3", startedAtMs: 3, availableDecisions: ["decline"], networkApprovalContext: {} }
  });
  send({
    id: "invalid_command_actions_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_4", startedAtMs: 4, availableDecisions: ["decline"], commandActions: [1] }
  });
  return;
}
if (["invalid_command_1", "invalid_file_1", "invalid_additional_permissions_1", "invalid_network_context_1", "invalid_command_actions_1"].includes(message.id)) {
  state.invalidResponses = (state.invalidResponses || 0) + 1;
  if (state.invalidResponses === 5) completeTurn("done");
}
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let approvalCalls = 0;
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise malformed approvals",
        cwd: tempDir,
        onApprovalRequest: async () => {
          approvalCalls += 1;
          return "cancel";
        },
      });

      expect(approvalCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      for (const id of [
        "invalid_command_1",
        "invalid_file_1",
        "invalid_additional_permissions_1",
        "invalid_network_context_1",
        "invalid_command_actions_1",
      ]) {
        const response = received.find((message) => message.id === id);
        expect(response).toMatchObject({ id, error: { code: -32602 } });
        expect(response && "result" in response).toBe(false);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("limits file-change approvals without target details to decline and cancel", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "file_approval_1",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "file_1",
      startedAtMs: 1,
      reason: "write outside the current root",
      grantRoot: "/private/project"
    }
  });
  return;
}
if (message.id === "file_approval_1") completeTurn("denied");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const seenDecisions: CodexApprovalDecision[][] = [];
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise a file-change approval",
        cwd: tempDir,
        onApprovalRequest: async (request) => {
          expect(request).toMatchObject({
            kind: "file_change",
            grantRoot: "/private/project",
          });
          seenDecisions.push(request.decisions);
          return "decline";
        },
      });

      expect(seenDecisions).toEqual([["decline", "cancel"]]);
      expect(result.finalText).toBe("denied");
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "file_approval_1")).toMatchObject({
        result: { decision: "decline" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("limits missing or null command decisions to decline and cancel", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "missing_decisions_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", startedAtMs: 1 }
  });
  return;
}
if (message.id === "missing_decisions_1") {
  send({
    id: "null_decisions_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_2", startedAtMs: 2, availableDecisions: null }
  });
  return;
}
if (message.id === "null_decisions_1") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const seenDecisions: unknown[] = [];
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise safe approval defaults",
        cwd: tempDir,
        onApprovalRequest: async (request) => {
          seenDecisions.push(request.decisions);
          return "decline";
        },
      });

      expect(seenDecisions).toEqual([
        ["decline", "cancel"],
        ["decline", "cancel"],
      ]);
      expect(seenDecisions.flat()).not.toContain("accept");
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "missing_decisions_1")).toMatchObject({
        result: { decision: "decline" },
      });
      expect(received.find((message) => message.id === "null_decisions_1")).toMatchObject({
        result: { decision: "decline" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("automatically cancels command approvals with no available decisions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "empty_decisions_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", startedAtMs: 1, availableDecisions: [] }
  });
  return;
}
if (message.id === "empty_decisions_1") completeTurn();
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let approvalCalls = 0;
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise an empty decision set",
        cwd: tempDir,
        onApprovalRequest: async () => {
          approvalCalls += 1;
          return "accept";
        },
      });

      expect(approvalCalls).toBe(0);
      expect(result).toMatchObject({ cancelled: true, finalText: "" });
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "empty_decisions_1")).toMatchObject({
        result: { decision: "cancel" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects an entire approval decision list containing a malformed entry", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "malformed_decisions_1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread_fake",
      turnId: "turn_fake",
      itemId: "cmd_1",
      startedAtMs: 1,
      availableDecisions: ["decline", { acceptWithExecpolicyAmendment: { execpolicy_amendment: "not-an-array" } }]
    }
  });
  return;
}
if (message.id === "malformed_decisions_1") completeTurn("done");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      let approvalCalls = 0;
      await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise a malformed decision",
        cwd: tempDir,
        onApprovalRequest: async () => {
          approvalCalls += 1;
          return "decline";
        },
      });

      expect(approvalCalls).toBe(0);
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      const response = received.find((message) => message.id === "malformed_decisions_1");
      expect(response).toMatchObject({ error: { code: -32602 } });
      expect(response && "result" in response).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("cancels when the approval callback returns a decision that was not offered", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "unoffered_decision_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", startedAtMs: 1, availableDecisions: ["decline"] }
  });
  return;
}
if (message.id === "unoffered_decision_1") completeTurn();
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise an unavailable callback decision",
        cwd: tempDir,
        onApprovalRequest: async () => "accept",
      });

      expect(result).toMatchObject({ cancelled: true, finalText: "" });
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "unoffered_decision_1")).toMatchObject({
        result: { decision: "cancel" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("cancels when the approval callback throws synchronously", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex, receivedPath } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "sync_throw_1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", startedAtMs: 1, command: "echo safe", availableDecisions: ["accept", "cancel"] }
  });
  return;
}
if (message.id === "sync_throw_1") completeTurn();
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const result = await new CodexRunner(config, new ConsoleLogger("error")).run({
        prompt: "exercise a synchronous callback failure",
        cwd: tempDir,
        onApprovalRequest: () => {
          throw new Error("synchronous approval failure");
        },
      });

      expect(result).toMatchObject({ cancelled: true, finalText: "" });
      const received = (await readJsonl(receivedPath)) as Array<Record<string, unknown>>;
      expect(received.find((message) => message.id === "sync_throw_1")).toMatchObject({
        result: { decision: "cancel" },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("assigns globally unique internal ids when app-server request ids repeat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "chat2codex-runner-"));
    const { fakeCodex } = await createRecordingFakeCodex(
      tempDir,
      `
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
    id: "reused_rpc_id",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_fake", turnId: "turn_fake", itemId: "cmd_1", startedAtMs: 1, command: "echo safe", availableDecisions: ["decline"] }
  });
  return;
}
if (message.id === "reused_rpc_id") completeTurn("declined");
`,
    );

    try {
      const config = loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_BIN: fakeCodex,
        CODEX_WORKDIR: tempDir,
      });
      const runner = new CodexRunner(config, new ConsoleLogger("error"));
      const approvalIds: string[] = [];
      const run = (prompt: string) =>
        runner.run({
          prompt,
          cwd: tempDir,
          onApprovalRequest: async (request) => {
            approvalIds.push(request.id);
            return "decline";
          },
        });

      const results = await Promise.all([run("first"), run("second")]);

      expect(results.map((result) => result.finalText)).toEqual(["declined", "declined"]);
      expect(approvalIds).toHaveLength(2);
      expect(new Set(approvalIds).size).toBe(2);
      expect(approvalIds).not.toContain("reused_rpc_id");
      for (const id of approvalIds) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      }
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
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/repo",
        commandActions: [{ type: "unknown", command: "rm -rf build" }],
        additionalPermissions: { network: { enabled: true }, fileSystem: { write: ["/tmp/repo"] } },
        networkApprovalContext: { host: "example.com", protocol: "https" },
        proposedNetworkPolicyAmendments: [{ action: "allow", host: "example.com" }],
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
            id: expect.any(String),
            kind: "command",
            command: "rm -rf build",
            cwd: "/tmp/repo",
          });
          expect(request.id).not.toBe("approval_1");
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
        startedAtMs: 1,
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

async function createRecordingFakeCodex(
  tempDir: string,
  handlerSource: string,
): Promise<{ fakeCodex: string; receivedPath: string }> {
  const fakeCodex = path.join(tempDir, "fake-codex.cjs");
  const receivedPath = path.join(tempDir, "received.jsonl");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const receivedPath = ${JSON.stringify(receivedPath)};
const rl = readline.createInterface({ input: process.stdin });
const state = Object.create(null);
function send(message) { console.log(JSON.stringify(message)); }
function remember(message) { fs.appendFileSync(receivedPath, JSON.stringify(message) + "\\n"); }
function completeTurn(text) {
  if (text) {
    send({ method: "item/completed", params: { threadId: "thread_fake", turnId: "turn_fake", item: { type: "agentMessage", id: "msg_1", text, phase: "final_answer", memoryCitation: null } } });
  }
  send({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 100 } } });
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  remember(message);
  ${handlerSource}
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(fakeCodex, 0o755);
  return { fakeCodex, receivedPath };
}

async function readPackageVersionForTest(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version is missing");
  }
  return packageJson.version;
}
