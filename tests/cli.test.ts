import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkCodexProtocolCompatibility,
  createGracefulShutdownController,
  createUncaughtExceptionHandler,
  parseCommand,
  runCli,
} from "../src/cli.js";

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

  test("graceful shutdown disposes once and completes without forcing exit", async () => {
    let disposeCalls = 0;
    const forceExitCodes: number[] = [];
    const controller = createGracefulShutdownController(
      async () => {
        disposeCalls += 1;
      },
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        timeoutMs: 1_000,
      },
    );

    controller.request("SIGTERM");
    await controller.done;
    controller.request("SIGINT");

    expect(disposeCalls).toBe(1);
    expect(forceExitCodes).toEqual([]);
  });

  test("a second shutdown signal forces exit without calling process.exit in tests", async () => {
    const releaseDispose = deferred<void>();
    const forceExitCodes: number[] = [];
    const controller = createGracefulShutdownController(
      () => releaseDispose.promise,
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        timeoutMs: 1_000,
      },
    );

    controller.request("SIGTERM");
    controller.request("SIGINT");
    expect(forceExitCodes).toEqual([130]);

    releaseDispose.resolve();
    await controller.done;
  });

  test("a bounded graceful shutdown timeout forces exit", async () => {
    const releaseDispose = deferred<void>();
    const forceExitCodes: number[] = [];
    const controller = createGracefulShutdownController(
      () => releaseDispose.promise,
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        timeoutMs: 5,
      },
    );

    controller.request("SIGTERM");
    await Bun.sleep(15);
    expect(forceExitCodes).toEqual([143]);

    releaseDispose.resolve();
    await controller.done;
  });

  test("an uncaught exception uses the active graceful shutdown controller", async () => {
    let disposeCalls = 0;
    const forceExitCodes: number[] = [];
    const exitCodes: number[] = [];
    const controller = createGracefulShutdownController(
      async () => {
        disposeCalls += 1;
      },
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        timeoutMs: 1_000,
      },
    );
    const handleUncaughtException = createUncaughtExceptionHandler(
      () => controller,
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    handleUncaughtException(new Error("fatal callback failure"));
    await controller.done;

    expect(disposeCalls).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(forceExitCodes).toEqual([]);
  });

  test("an early uncaught exception explicitly forces exit when shutdown is unavailable", () => {
    const forceExitCodes: number[] = [];
    const exitCodes: number[] = [];
    const handleUncaughtException = createUncaughtExceptionHandler(
      () => undefined,
      silentLogger,
      {
        forceExit: (code) => forceExitCodes.push(code),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    handleUncaughtException(new Error("fatal startup failure"));

    expect(exitCodes).toEqual([1]);
    expect(forceExitCodes).toEqual([1]);
  });

  test("doctor help does not require bridge configuration", async () => {
    const previousAppId = process.env.FEISHU_APP_ID;
    const previousAppSecret = process.env.FEISHU_APP_SECRET;
    const previousExitCode = process.exitCode;
    try {
      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;
      process.exitCode = undefined;

      await runCli(["doctor", "--env", path.join(os.tmpdir(), "missing.env"), "--help"]);

      expect(process.exitCode).toBeUndefined();
    } finally {
      setOptionalEnv("FEISHU_APP_ID", previousAppId);
      setOptionalEnv("FEISHU_APP_SECRET", previousAppSecret);
      process.exitCode = previousExitCode;
    }
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
      "CODEX_SANDBOX",
      "ALLOW_GROUPS",
      "ALLOWED_USER_IDS",
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
      process.env.CODEX_SANDBOX = "workspace-write";
      process.env.ALLOW_GROUPS = "true";
      process.env.ALLOWED_USER_IDS = "";
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

  test("doctor accepts the exact Codex version recorded by the bundled protocol manifest", async () => {
    const manifest = JSON.parse(
      await fs.readFile(
        new URL("../docs/codex-app-server-protocol/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { codexVersion: string };

    const result = await runDoctorWithCodexVersion(manifest.codexVersion);

    expect(result.output).toContain(`ok    Codex protocol - ${manifest.codexVersion}`);
    expect(result.output).toContain("matches the bundled app-server schema");
    expect(result.exitCode).toBeUndefined();
  });

  test("doctor warns without failing when Codex and the bundled protocol manifest differ", async () => {
    const result = await runDoctorWithCodexVersion("codex-cli 999.0.0");

    expect(result.output).toContain("warn  Codex protocol");
    expect(result.output).toContain("codex-cli 999.0.0");
    expect(result.output).toContain("chat2codex smoke");
    expect(result.output).toContain("chat2codex protocol generate");
    expect(result.output).toContain("review the schema diff");
    expect(result.exitCode).toBeUndefined();
  });

  test("protocol compatibility warns when the manifest is missing or unreadable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-manifest-"));
    try {
      const missing = await checkCodexProtocolCompatibility(
        "codex-cli 1.2.3",
        path.join(tempDir, "missing.json"),
      );
      expect(missing.status).toBe("warn");
      expect(missing.detail).toContain("could not read the bundled protocol manifest");
      expect(missing.detail).toContain("chat2codex protocol generate");

      const invalidManifest = path.join(tempDir, "manifest.json");
      await fs.writeFile(invalidManifest, "not json");
      const unreadable = await checkCodexProtocolCompatibility(
        "codex-cli 1.2.3",
        invalidManifest,
      );
      expect(unreadable.status).toBe("warn");
      expect(unreadable.detail).toContain("could not read the bundled protocol manifest");
      expect(unreadable.detail).toContain("chat2codex smoke");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return {
    promise,
    resolve: (value) => resolve(value as T | PromiseLike<T>),
  };
}

async function runDoctorWithCodexVersion(
  codexVersion: string,
): Promise<{ exitCode: number | string | undefined; output: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-doctor-"));
  const workdir = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  const attachmentDir = path.join(tempDir, "attachments");
  const fakeCodex = path.join(tempDir, "codex");
  const output: string[] = [];
  const envKeys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "LARK_DOMAIN",
    "CODEX_BIN",
    "CODEX_WORKDIR",
    "CODEX_SANDBOX",
    "CODEX_APPROVAL_POLICY",
    "CODEX_RUN_TIMEOUT_MS",
    "CODEX_APPROVAL_TIMEOUT_MS",
    "ALLOW_DIRECT_MESSAGES",
    "ALLOW_GROUPS",
    "ALLOWED_CHAT_IDS",
    "ALLOWED_USER_IDS",
    "ATTACHMENT_DOWNLOAD_DIR",
    "BRIDGE_STATE_PATH",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const previousLog = console.log;
  const previousExitCode = process.exitCode;
  const previousCwd = process.cwd();
  try {
    await fs.mkdir(workdir);
    await fs.mkdir(stateDir);
    await fs.mkdir(attachmentDir);
    await fs.writeFile(fakeCodex, `#!/bin/sh\nprintf '%s\\n' '${codexVersion}'\n`);
    await fs.chmod(fakeCodex, 0o755);
    await fs.writeFile(
      path.join(tempDir, ".env"),
      [
        "FEISHU_APP_ID=cli_test",
        "FEISHU_APP_SECRET=secret",
        `CODEX_BIN=${fakeCodex}`,
        `CODEX_WORKDIR=${workdir}`,
        `BRIDGE_STATE_PATH=${path.join(stateDir, "state.json")}`,
        `ATTACHMENT_DOWNLOAD_DIR=${attachmentDir}`,
        "ALLOW_DIRECT_MESSAGES=false",
        "ALLOW_GROUPS=false",
        "CODEX_APPROVAL_POLICY=on-request",
        "CODEX_RUN_TIMEOUT_MS=60000",
        "CODEX_APPROVAL_TIMEOUT_MS=60000",
      ].join("\n"),
    );

    process.env.CHAT2CODEX_HOME = tempDir;
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "secret";
    process.env.LARK_DOMAIN = "feishu";
    process.env.CODEX_BIN = fakeCodex;
    process.env.CODEX_WORKDIR = workdir;
    process.env.CODEX_SANDBOX = "workspace-write";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.CODEX_RUN_TIMEOUT_MS = "60000";
    process.env.CODEX_APPROVAL_TIMEOUT_MS = "60000";
    process.env.ALLOW_DIRECT_MESSAGES = "false";
    process.env.ALLOW_GROUPS = "false";
    process.env.ALLOWED_CHAT_IDS = "";
    process.env.ALLOWED_USER_IDS = "";
    process.env.ATTACHMENT_DOWNLOAD_DIR = attachmentDir;
    process.env.BRIDGE_STATE_PATH = path.join(stateDir, "state.json");
    console.log = (line?: unknown) => {
      output.push(String(line ?? ""));
    };
    process.exitCode = undefined;
    process.chdir(tempDir);

    await runCli(["doctor"]);

    return { exitCode: process.exitCode, output: output.join("\n") };
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    process.exitCode = previousExitCode;
    for (const key of envKeys) {
      setOptionalEnv(key, previousEnv.get(key));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
