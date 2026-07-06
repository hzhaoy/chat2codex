import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCommand, runCli } from "../src/cli.js";

const originalCwd = process.cwd();
const originalLog = console.log;
const originalHome = process.env.CHAT2CODEX_HOME;
const originalEnv = process.env.CHAT2CODEX_ENV;

describe("CLI", () => {
  beforeEach(() => {
    console.log = () => undefined;
  });

  afterEach(() => {
    console.log = originalLog;
    process.chdir(originalCwd);
    setOptionalEnv("CHAT2CODEX_HOME", originalHome);
    setOptionalEnv("CHAT2CODEX_ENV", originalEnv);
  });

  test("defaults to the start command", () => {
    expect(parseCommand([])).toEqual({ command: "start", args: [] });
    expect(parseCommand(["--help"])).toEqual({ command: "help", args: [] });
    expect(parseCommand(["smoke", "approval"])).toEqual({
      command: "smoke",
      args: ["approval"],
    });
  });

  test("start help does not require bridge configuration", async () => {
    await runCli(["start", "--help"]);
    await expect(runCli(["not-a-command"])).rejects.toThrow("Unknown start argument");
  });

  test("init creates an env file with an explicit CODEX_WORKDIR", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-cli-"));
    const envFile = path.join(tempDir, ".env");
    const workdir = path.join(tempDir, "workspace");
    try {
      process.chdir(tempDir);
      await fs.mkdir(workdir);

      await runCli(["init", "--env", envFile, "--workdir", workdir]);

      const env = await fs.readFile(envFile, "utf8");
      expect(env).toContain("FEISHU_APP_ID=cli_xxx");
      expect(env).toContain(`CODEX_WORKDIR=${path.resolve(workdir)}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("init defaults to CHAT2CODEX_HOME/.env", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-home-"));
    const workdir = path.join(tempDir, "workspace");
    try {
      process.env.CHAT2CODEX_HOME = tempDir;
      await fs.mkdir(workdir);

      await runCli(["init", "--workdir", workdir]);

      const env = await fs.readFile(path.join(tempDir, ".env"), "utf8");
      expect(env).toContain(`CODEX_WORKDIR=${path.resolve(workdir)}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("doctor prints mobile-safe warnings for risky remote chat settings", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-home-"));
    const workdir = path.join(tempDir, "workspace");
    const stateDir = path.join(tempDir, "state");
    const attachmentDir = path.join(tempDir, "attachments");
    const output: string[] = [];
    const envKeys = [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "CODEX_WORKDIR",
      "BRIDGE_STATE_PATH",
      "ATTACHMENT_DOWNLOAD_DIR",
      "CODEX_BIN",
      "ALLOW_GROUPS",
      "CODEX_APPROVAL_POLICY",
      "CODEX_RUN_TIMEOUT_MS",
      "CODEX_APPROVAL_TIMEOUT_MS",
    ];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    try {
      console.log = (line?: unknown) => {
        output.push(String(line ?? ""));
      };
      process.env.CHAT2CODEX_HOME = tempDir;
      process.env.FEISHU_APP_ID = "cli_test";
      process.env.FEISHU_APP_SECRET = "secret";
      process.env.CODEX_WORKDIR = workdir;
      process.env.BRIDGE_STATE_PATH = path.join(stateDir, "state.json");
      process.env.ATTACHMENT_DOWNLOAD_DIR = attachmentDir;
      process.env.CODEX_BIN = process.execPath;
      process.env.ALLOW_GROUPS = "true";
      process.env.CODEX_APPROVAL_POLICY = "never";
      process.env.CODEX_RUN_TIMEOUT_MS = "0";
      process.env.CODEX_APPROVAL_TIMEOUT_MS = "0";
      await fs.mkdir(workdir);
      await fs.mkdir(stateDir);
      await fs.mkdir(attachmentDir);
      await fs.writeFile(
        path.join(tempDir, ".env"),
        [
          "FEISHU_APP_ID=cli_test",
          "FEISHU_APP_SECRET=secret",
          `CODEX_WORKDIR=${workdir}`,
          `BRIDGE_STATE_PATH=${path.join(stateDir, "state.json")}`,
          `ATTACHMENT_DOWNLOAD_DIR=${attachmentDir}`,
          `CODEX_BIN=${process.execPath}`,
          "ALLOW_GROUPS=true",
          "CODEX_APPROVAL_POLICY=never",
          "CODEX_RUN_TIMEOUT_MS=0",
        ].join("\n"),
      );

      await runCli(["doctor"]);

      const text = output.join("\n");
      expect(text).toContain("mobile-safe group users");
      expect(text).toContain("mobile-safe approvals");
      expect(text).toContain("mobile-safe run timeout");
      expect(text).toContain("ALLOW_GROUPS is true");
    } finally {
      for (const key of envKeys) {
        setOptionalEnv(key, previousEnv.get(key));
      }
      process.exitCode = undefined;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
