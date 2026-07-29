import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { config as loadDotenv } from "dotenv";
import { ZodError } from "zod";

import { buildCodexChildEnv } from "./agent/codex-environment.js";
import { loadConfig } from "./config/env.js";
import { defaultChat2CodexHome, defaultEnvPath } from "./config/paths.js";
import {
  packageRoot,
  protocolManifestPath,
  readBundledProtocolManifest,
  readPackageVersion,
} from "./package-info.js";
import { acquireBridgeInstanceLock } from "./state/instance-lock.js";
import { ConsoleLogger, type Logger } from "./util/logger.js";
import {
  runBridgeRuntime,
  type BridgeRuntime,
} from "./runtime/bridge-runtime.js";
import { createPlatformAdapterBundle } from "./runtime/platform.js";

type CliCommand =
  | "doctor"
  | "help"
  | "init"
  | "protocol"
  | "service"
  | "setup"
  | "smoke"
  | "start"
  | "version";

export interface DoctorCheck {
  label: string;
  status: "ok" | "warn" | "error";
  detail?: string;
}

interface CommandCheckResult {
  check: DoctorCheck;
  output: string | null;
}

interface InitOptions {
  envFile: string;
  force: boolean;
  help: boolean;
  workdir: string;
}

interface EnvBackedOptions {
  envFile: string;
  envFileExplicit: boolean;
  help: boolean;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface GracefulShutdownController {
  done: Promise<void>;
  request(signal: ShutdownSignal): void;
}

interface GracefulShutdownOptions {
  forceExit?: (code: number) => void;
  timeoutMs?: number;
}

interface UncaughtExceptionHandlerOptions {
  forceExit?: (code: number) => void;
  setExitCode?: (code: number) => void;
}

const defaultShutdownTimeoutMs = 10_000;

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, args } = parseCommand(argv);

  switch (command) {
    case "help":
      printHelp();
      return;
    case "version":
      console.log(await readPackageVersion());
      return;
    case "start":
      await runStart(args);
      return;
    case "setup":
      await runSetup(args);
      return;
    case "init":
      await runInit(args);
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "smoke":
      await runSmoke(args);
      return;
    case "service":
      await runService(args);
      return;
    case "protocol":
      await runProtocol(args);
      return;
  }
}

export function parseCommand(argv: string[]): { command: CliCommand; args: string[] } {
  const [first, ...rest] = argv;
  if (!first) {
    return { command: "start", args: [] };
  }
  if (first === "-h" || first === "--help" || first === "help") {
    return { command: "help", args: rest };
  }
  if (first === "-v" || first === "--version" || first === "version") {
    return { command: "version", args: rest };
  }
  if (isCommand(first)) {
    return { command: first, args: rest };
  }
  return { command: "start", args: argv };
}

export function printHelp(): void {
  console.log(`Usage: chat2codex [command] [options]

Commands:
  start                 Start the selected chat adapter (default)
  setup                 Connect Feishu/Lark or Weixin and write .env
  init                  Create a starter .env without registering an app
  doctor                Check local configuration and Codex availability
  smoke                 Run Codex app-server smoke checks
  service               Print/install/uninstall a user service
  protocol generate     Refresh the bundled Codex app-server schema snapshot
  help                  Show this help
  version               Show package version

Examples:
  chat2codex setup --workdir /absolute/path/to/your/repo
  chat2codex setup weixin --workdir /absolute/path/to/your/repo
  chat2codex doctor
  chat2codex start
  chat2codex smoke --mode approval
  chat2codex service install
`);
}

async function runStart(args: string[]): Promise<void> {
  const options = parseEnvBackedArgs(args, "start");
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage: chat2codex start [options]

Starts the adapter selected by CHAT2CODEX_ADAPTER using the configured env file.

Options:
  --env <path>       Env file path (default: ~/.chat2codex/.env)
`);
    return;
  }

  loadRuntimeEnv(options.envFile, options.envFileExplicit);
  const config = loadConfig(process.env);
  const logger = new ConsoleLogger(config.logLevel, {
    filePath: config.logFilePath,
    maxEntryBytes: config.logEntryMaxBytes,
    maxFileBytes: config.logFileMaxBytes,
    maxFiles: config.logFileMaxFiles,
  });

  let runtime: BridgeRuntime | undefined;
  let instanceLock: Awaited<ReturnType<typeof acquireBridgeInstanceLock>> | undefined;
  let shutdown: GracefulShutdownController | undefined;
  let instanceLockCompromised = false;
  const onUnhandledRejection = (error: unknown) => {
    logger.error("Unhandled rejection", error);
  };
  const onUncaughtException = createUncaughtExceptionHandler(() => shutdown, logger);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  const onSigint = () => shutdown?.request("SIGINT");
  const onSigterm = () => shutdown?.request("SIGTERM");
  try {
    instanceLock = await acquireBridgeInstanceLock(config.bridgeStatePath, (error) => {
      logger.error("Chat2Codex instance lock was compromised; stopping the bridge", error);
      instanceLockCompromised = true;
      process.exitCode = 1;
      shutdown?.request("SIGTERM");
    });
    let resolveRuntimeReady!: (
      runtime: BridgeRuntime | undefined,
    ) => void;
    const runtimeReady = new Promise<BridgeRuntime | undefined>(
      (resolve) => {
        resolveRuntimeReady = resolve;
      },
    );
    shutdown = createGracefulShutdownController(async () => {
      await (await runtimeReady)?.dispose();
    }, logger);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    if (instanceLockCompromised) {
      shutdown.request("SIGTERM");
    }
    try {
      const platform = await createPlatformAdapterBundle(config, logger);
      runtime = await runBridgeRuntime(
        config,
        platform,
        logger,
        () => shutdown?.request("SIGTERM"),
      );
    } finally {
      resolveRuntimeReady(runtime);
    }
    await shutdown.done;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
    try {
      await runtime?.dispose();
    } finally {
      await instanceLock?.release();
    }
  }
}

export function createGracefulShutdownController(
  dispose: () => Promise<void>,
  logger: Logger,
  options: GracefulShutdownOptions = {},
): GracefulShutdownController {
  const timeoutMs = options.timeoutMs ?? defaultShutdownTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Graceful shutdown timeout must be a positive safe integer.");
  }

  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let firstSignal: ShutdownSignal | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const clearShutdownTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const request = (signal: ShutdownSignal) => {
    if (settled) {
      return;
    }
    if (firstSignal) {
      logger.warn("Received a second shutdown signal; forcing exit", { signal });
      forceExit(shutdownExitCode(signal));
      return;
    }

    firstSignal = signal;
    logger.info("Received shutdown signal; stopping the bridge", { signal, timeoutMs });
    timer = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit", { signal, timeoutMs });
      forceExit(shutdownExitCode(signal));
    }, timeoutMs);

    void Promise.resolve()
      .then(dispose)
      .then(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          clearShutdownTimer();
          logger.info("Bridge shutdown complete");
          resolveDone();
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearShutdownTimer();
          logger.error("Bridge shutdown failed", error);
          rejectDone(error);
        },
      );
  };

  return { done, request };
}

export function createUncaughtExceptionHandler(
  getShutdown: () => GracefulShutdownController | undefined,
  logger: Logger,
  options: UncaughtExceptionHandlerOptions = {},
): (error: Error) => void {
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  return (error: Error) => {
    logger.error("Uncaught exception", error);
    setExitCode(1);
    const activeShutdown = getShutdown();
    if (!activeShutdown) {
      logger.error("Uncaught exception occurred before graceful shutdown was available");
      forceExit(1);
      return;
    }
    activeShutdown.request("SIGTERM");
  };
}

function shutdownExitCode(signal: ShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

async function runSetup(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage: chat2codex setup [options]

Connects a Feishu/Lark app by default. Use "setup weixin" to connect a personal
Weixin ClawBot through the official QR-code flow.

Options:
  --env <path>       File to create or update (default: .env)
  --workdir <path>   CODEX_WORKDIR value (default: current directory)
`);
    return;
  }

  if (args[0] === "weixin") {
    const { runWeixinSetup } = await import("./setup/weixin.js");
    await runWeixinSetup(args.slice(1));
    return;
  }
  const remaining = args[0] === "feishu" || args[0] === "lark" ? args.slice(1) : args;

  const { runFeishuSetup } = await import("./setup/feishu.js");
  await runFeishuSetup(remaining);
}

async function runInit(args: string[]): Promise<void> {
  const options = parseInitArgs(args);
  if (options.help) {
    console.log(`Usage: chat2codex init [options]

Options:
  --env <path>       File to create (default: ~/.chat2codex/.env)
  --workdir <path>   CODEX_WORKDIR value (default: current directory)
  --force            Overwrite the target file when it already exists
`);
    return;
  }

  const envFile = path.resolve(options.envFile);
  const exists = await fileExists(envFile);
  if (exists && !options.force) {
    console.log(`${envFile} already exists; use --force to overwrite it.`);
    return;
  }

  const template = await readEnvExample();
  const next = template.replace(
    /^CODEX_WORKDIR=.*$/mu,
    `CODEX_WORKDIR=${formatEnvValue(path.resolve(options.workdir))}`,
  );
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  await fs.writeFile(envFile, `${next.trimEnd()}\n`, { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  console.log(`Created ${envFile}`);
  console.log("Next: edit FEISHU_APP_ID and FEISHU_APP_SECRET, then run chat2codex doctor.");
}

async function runDoctor(args: string[]): Promise<void> {
  const options = parseEnvBackedArgs(args, "doctor");
  if (options.help) {
    console.log(`Usage: chat2codex doctor [options]

Checks .env, Node.js, Codex CLI, CODEX_WORKDIR, and runtime directories.

Options:
  --env <path>       Env file path (default: ~/.chat2codex/.env)
`);
    return;
  }

  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion(process.versions.node));

  const envPath = path.resolve(options.envFile);
  const envExists = await fileExists(envPath);
  checks.push({
    label: ".env",
    status: envExists ? "ok" : "error",
    detail: envExists ? envPath : "missing; run chat2codex setup or chat2codex init",
  });
  loadRuntimeEnv(envPath, options.envFileExplicit);

  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(process.env);
    checks.push({ label: "configuration", status: "ok" });
  } catch (error) {
    checks.push({ label: "configuration", status: "error", detail: formatConfigError(error) });
  }

  const codexBin = config?.codexBin ?? process.env.CODEX_BIN ?? "codex";
  const codexCommand = checkCommand(codexBin, ["--version"], "Codex CLI");
  checks.push(codexCommand.check);
  checks.push(await checkCodexProtocolCompatibility(codexCommand.output));

  if (config) {
    checks.push(await checkDirectory(config.codexWorkdir, "CODEX_WORKDIR"));
    checks.push(await checkRuntimeDirectory(path.dirname(config.bridgeStatePath), "state directory"));
    checks.push(await checkRuntimeDirectory(path.dirname(config.attachmentDownloadDir), "attachment parent"));
    checks.push(...checkMobileSafeConfig(config));
    if (config.chatAdapter === "weixin") {
      const { loadWeixinCredentials } = await import("./adapters/weixin/store.js");
      try {
        const credentials = await loadWeixinCredentials(config.weixinCredentialsPath);
        checks.push({
          label: "Weixin credentials",
          status: "ok",
          detail: `${config.weixinCredentialsPath} (bot ${credentials.accountId})`,
        });
        if (
          credentials.userId &&
          !config.access.allowedUserIds.includes(credentials.userId)
        ) {
          checks.push({
            label: "Weixin scanning user",
            status: "error",
            detail: "credential userId is missing from ALLOWED_USER_IDS; rerun setup weixin",
          });
        }
      } catch (error) {
        checks.push({
          label: "Weixin credentials",
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      checks.push({
        label: "Weixin private-chat boundary",
        status:
          config.access.allowDirectMessages &&
          !config.access.allowGroups &&
          (
            config.access.allowedUserIds.length > 0 ||
            config.access.allowedChatIds.length > 0
          )
            ? "ok"
            : "error",
        detail:
          "Weixin v1 requires direct messages, disabled groups, and a user/chat allowlist",
      });
    }
  }

  printDoctorChecks(checks);
  if (checks.some((check) => check.status === "error")) {
    process.exitCode = 1;
  }
}

async function runSmoke(args: string[]): Promise<void> {
  const normalized = normalizeSmokeArgs(args);
  loadRuntimeEnv(defaultEnvPath());
  const { runAppServerSmoke } = await import("./setup/smoke-app-server.js");
  await runAppServerSmoke(normalized);
}

async function runService(args: string[]): Promise<void> {
  const { runServiceSetup } = await import("./setup/service.js");
  await runServiceSetup(args);
}

async function runProtocol(args: string[]): Promise<void> {
  if (args[0] !== "generate") {
    console.log(`Usage: chat2codex protocol generate [options]`);
    if (args.length > 0) {
      process.exitCode = 1;
    }
    return;
  }
  loadRuntimeEnv(defaultEnvPath());
  const { generateAppServerSchema } = await import("./setup/generate-app-server-schema.js");
  await generateAppServerSchema(args.slice(1));
}

function normalizeSmokeArgs(args: string[]): string[] {
  const [first, ...rest] = args;
  if (first === "handshake" || first === "turn" || first === "approval") {
    return ["--mode", first, ...rest];
  }
  return args;
}

function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {
    envFile: defaultEnvPath(),
    force: false,
    help: false,
    workdir: process.cwd(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--env" || arg === "--env-file") {
      options.envFile = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--workdir") {
      options.workdir = requireValue(args, ++index, arg);
      continue;
    }
    throw new Error(`Unknown init argument: ${arg}`);
  }
  return options;
}

function parseEnvBackedArgs(args: string[], command: string): EnvBackedOptions {
  const options: EnvBackedOptions = {
    envFile: defaultEnvPath(),
    envFileExplicit: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--env" || arg === "--env-file") {
      options.envFile = requireValue(args, ++index, arg);
      options.envFileExplicit = true;
      continue;
    }
    throw new Error(`Unknown ${command} argument: ${arg}`);
  }
  return options;
}

function isCommand(value: string): value is CliCommand {
  return [
    "doctor",
    "init",
    "protocol",
    "service",
    "setup",
    "smoke",
    "start",
  ].includes(value);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function readEnvExample(): Promise<string> {
  const local = path.resolve(".env.example");
  const bundled = path.join(packageRoot(), ".env.example");
  for (const candidate of [local, bundled]) {
    const content = await fs.readFile(candidate, "utf8").catch(() => null);
    if (content !== null) {
      return content;
    }
  }
  throw new Error("Could not find .env.example in the current directory or package.");
}

function loadRuntimeEnv(envFile: string, override = false): void {
  loadDotenv({ path: envFile, override, quiet: true });
  process.env.CHAT2CODEX_HOME ??= defaultChat2CodexHome();
}

export async function checkCodexProtocolCompatibility(
  actualVersion: string | null,
  manifestPath = protocolManifestPath(),
): Promise<DoctorCheck> {
  let expectedVersion: string;
  try {
    const manifest = await readBundledProtocolManifest(manifestPath);
    expectedVersion = manifest.codexVersion.trim();
  } catch (error) {
    return {
      label: "Codex protocol",
      status: "warn",
      detail: `could not read the bundled protocol manifest at ${manifestPath}: ${formatError(error)}. Reinstall Chat2Codex or, from a source checkout, run chat2codex protocol generate; then run chat2codex smoke.`,
    };
  }

  if (actualVersion === null) {
    return {
      label: "Codex protocol",
      status: "warn",
      detail: `could not compare against the bundled app-server schema for ${expectedVersion} because codex --version failed`,
    };
  }

  const installedVersion = actualVersion.trim();
  if (installedVersion === expectedVersion) {
    return {
      label: "Codex protocol",
      status: "ok",
      detail: `${installedVersion} matches the bundled app-server schema`,
    };
  }

  return {
    label: "Codex protocol",
    status: "warn",
    detail: `installed ${installedVersion || "Codex CLI returned no version"}; the bundled app-server schema was generated with ${expectedVersion}. Run chat2codex smoke; if the upgrade is intentional, run chat2codex protocol generate and review the schema diff.`,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function checkDirectory(dirPath: string, label: string): Promise<DoctorCheck> {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat) {
    return { label, status: "error", detail: `${dirPath} does not exist` };
  }
  if (!stat.isDirectory()) {
    return { label, status: "error", detail: `${dirPath} is not a directory` };
  }
  return { label, status: "ok", detail: dirPath };
}

async function checkRuntimeDirectory(dirPath: string, label: string): Promise<DoctorCheck> {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat) {
    return { label, status: "warn", detail: `${dirPath} will be created on first use` };
  }
  if (!stat.isDirectory()) {
    return { label, status: "error", detail: `${dirPath} is not a directory` };
  }
  return { label, status: "ok", detail: dirPath };
}

function checkNodeVersion(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const ok = major > 20 || (major === 20 && minor >= 12);
  return {
    label: "Node.js",
    status: ok ? "ok" : "error",
    detail: `v${version}${ok ? "" : " is below the required >=20.12.0"}`,
  };
}

function checkCommand(command: string, args: string[], label: string): CommandCheckResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: buildCodexChildEnv(),
  });
  if (result.status === 0) {
    const output = result.stdout.trim();
    return {
      check: {
        label,
        status: "ok",
        detail: output || command,
      },
      output,
    };
  }
  return {
    check: {
      label,
      status: "error",
      detail: `failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout || "not found"}`,
    },
    output: null,
  };
}

function checkMobileSafeConfig(config: ReturnType<typeof loadConfig>): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (!path.isAbsolute(config.codexBin)) {
    checks.push({
      label: "mobile-safe CODEX_BIN",
      status: "warn",
      detail: "CODEX_BIN is not absolute; background services may not load your interactive shell PATH",
    });
  }
  if (
    config.access.allowDirectMessages &&
    config.access.allowedUserIds.length === 0 &&
    config.access.allowedChatIds.length === 0
  ) {
    checks.push({
      label: "mobile-safe direct allowlist",
      status: "warn",
      detail: "direct messages require ALLOWED_USER_IDS or ALLOWED_CHAT_IDS; use /whoami to discover them",
    });
  }
  if (config.access.allowGroups && config.access.allowedUserIds.length === 0) {
    checks.push({
      label: "mobile-safe group users",
      status: "warn",
      detail: "ALLOW_GROUPS is true but ALLOWED_USER_IDS is empty; group messages and card actions will be denied",
    });
  }
  if (config.access.allowGroups && config.codexApprovalPolicy === "never") {
    checks.push({
      label: "mobile-safe approvals",
      status: "warn",
      detail: "group bots should usually use CODEX_APPROVAL_POLICY=on-request instead of never",
    });
  }
  if (config.access.allowGroups && config.codexRunTimeoutMs === 0) {
    checks.push({
      label: "mobile-safe run timeout",
      status: "warn",
      detail: "CODEX_RUN_TIMEOUT_MS=0 disables automatic run cancellation for group bots",
    });
  }
  if (config.access.allowGroups && config.codexApprovalTimeoutMs === 0) {
    checks.push({
      label: "mobile-safe approval timeout",
      status: "warn",
      detail: "CODEX_APPROVAL_TIMEOUT_MS=0 disables automatic approval cancellation for group bots",
    });
  }
  if (config.codexSandbox === "danger-full-access") {
    checks.push({
      label: "mobile-safe sandbox",
      status: "warn",
      detail: "danger-full-access is risky for a remote chat entrypoint; prefer workspace-write",
    });
  }
  if (checks.length === 0) {
    checks.push({
      label: "mobile-safe profile",
      status: "ok",
      detail: "no mobile/team-bot safety warnings detected",
    });
  }
  return checks;
}

function printDoctorChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const prefix = check.status === "ok" ? "ok" : check.status === "warn" ? "warn" : "error";
    console.log(`${prefix.padEnd(5)} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
  }
}

function formatConfigError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
