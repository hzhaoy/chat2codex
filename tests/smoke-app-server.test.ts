import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAppServerSmoke } from "../src/setup/smoke-app-server.js";

describe("app-server smoke approval validation", () => {
  test("fails fast when command availableDecisions contains a malformed entry", async () => {
    const fixture = await createSmokeFixture({
      method: "item/commandExecution/requestApproval",
      params: validApprovalParams({
        availableDecisions: [
          "accept",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: "invalid" } },
        ],
      }),
    });

    try {
      await expect(runApprovalSmoke(fixture)).rejects.toThrow(
        "availableDecisions must be a valid decision array",
      );
      expect(await approvalResponse(fixture)).toMatchObject({
        id: "approval_1",
        error: { code: -32602 },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("fails fast when the configured decision was not offered", async () => {
    const fixture = await createSmokeFixture({
      method: "item/commandExecution/requestApproval",
      params: validApprovalParams({ availableDecisions: ["decline"] }),
    });

    try {
      await expect(runApprovalSmoke(fixture)).rejects.toThrow(
        "configured decision accept was not offered",
      );
      expect(await approvalResponse(fixture)).toMatchObject({
        id: "approval_1",
        error: { code: -32602 },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps an explicit CLI decision compatible when availableDecisions is null", async () => {
    const fixture = await createSmokeFixture(
      {
        method: "item/commandExecution/requestApproval",
        params: validApprovalParams({ availableDecisions: null }),
      },
      true,
    );

    try {
      await expect(runApprovalSmoke(fixture)).resolves.toBeUndefined();
      expect(await approvalResponse(fixture)).toMatchObject({
        id: "approval_1",
        result: { decision: "accept" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects a file approval before counting it when required params are missing", async () => {
    const fixture = await createSmokeFixture({
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread_fake",
        turnId: "turn_fake",
        itemId: "item_fake",
      },
    });

    try {
      await expect(runApprovalSmoke(fixture)).rejects.toThrow("Invalid approval params");
      expect(await approvalResponse(fixture)).toMatchObject({
        id: "approval_1",
        error: { code: -32602 },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

interface SmokeFixture {
  cwd: string;
  executable: string;
  receivedPath: string;
  cleanup: () => Promise<void>;
}

interface ApprovalRequestFixture {
  method: string;
  params: Record<string, unknown>;
}

function validApprovalParams(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: "thread_fake",
    turnId: "turn_fake",
    itemId: "item_fake",
    startedAtMs: 1,
    ...overrides,
  };
}

async function createSmokeFixture(
  request: ApprovalRequestFixture,
  createApprovalFile = false,
): Promise<SmokeFixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "chat2codex-smoke-test-"));
  const executable = path.join(cwd, "fake-codex.cjs");
  const receivedPath = path.join(cwd, "received.jsonl");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("codex-cli smoke-test");
  process.exit(0);
}
const receivedPath = ${JSON.stringify(receivedPath)};
const request = ${JSON.stringify({ id: "approval_1", ...request })};
const createApprovalFile = ${JSON.stringify(createApprovalFile)};
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(receivedPath, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread_fake" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fake" } } });
    send(request);
    return;
  }
  if (message.id === "approval_1") {
    if (createApprovalFile && message.result && message.result.decision === "accept") {
      fs.writeFileSync(
        path.join(process.cwd(), "approval-smoke.txt"),
        "chat2codex approval smoke ok\\n",
      );
    }
    send({ method: "turn/completed", params: { threadId: "thread_fake" } });
  }
});
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));
`,
  );
  await chmod(executable, 0o755);
  return {
    cwd,
    executable,
    receivedPath,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

function runApprovalSmoke(fixture: SmokeFixture): Promise<void> {
  return runAppServerSmoke([
    "--codex-bin",
    fixture.executable,
    "--cwd",
    fixture.cwd,
    "--mode",
    "approval",
    "--approval-decision",
    "accept",
    "--timeout-ms",
    "2000",
  ]);
}

async function approvalResponse(fixture: SmokeFixture): Promise<Record<string, unknown>> {
  const messages = (await readFile(fixture.receivedPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const response = messages.find((message) => message.id === "approval_1");
  if (!response) {
    throw new Error("Fake app-server did not receive an approval response.");
  }
  return response;
}
