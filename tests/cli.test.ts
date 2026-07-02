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
});

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
