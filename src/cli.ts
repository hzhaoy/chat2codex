import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { ZodError } from "zod";

import { buildCodexChildEnv } from "./agent/codex-environment.js";
import { runBridge } from "./bot/lark-bot.js";
import { loadConfig } from "./config/env.js";
import { defaultChat2CodexHome, defaultEnvPath } from "./config/paths.js";
import { acquireBridgeInstanceLock } from "./state/instance-lock.js";
import { ConsoleLogger } from "./util/logger.js";

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

interface DoctorCheck {
  label: string;
  status: "ok" | "warn" | "error";
  detail?: string;
}

interface InitOptions {
  envFile: string;
  force: boolean;
  help: boolean;
  workdir: string;
}

interface EnvBackedOptions {
  envFile: string;
  help: boolean;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, args } = parseCommand(argv);

  switch (command) {
    case "help":
      printHelp();
      return;
    case "version":
      console.log(await packageVersion());
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
  start                 Start the Feishu/Lark bridge (default)
  setup                 Create/connect a Feishu/Lark app and write .env
  init                  Create a starter .env without registering an app
  doctor                Check local configuration and Codex availability
  smoke                 Run Codex app-server smoke checks
  service               Print/install/uninstall a user service
  protocol generate     Refresh the bundled Codex app-server schema snapshot
  help                  Show this help
  version               Show package version

Examples:
  chat2codex setup --workdir /absolute/path/to/your/repo
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

Starts the Feishu/Lark bridge using the configured env file.

Options:
  --env <path>       Env file path (default: ~/.chat2codex/.env)
`);
    return;
  }

  loadRuntimeEnv(options.envFile);
  const config = loadConfig(process.env);
  const logger = new ConsoleLogger(config.logLevel);

  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled rejection", error);
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    process.exitCode = 1;
  });

  const instanceLock = await acquireBridgeInstanceLock(config.bridgeStatePath, (error) => {
    logger.error("Chat2Codex instance lock was compromised; stopping the bridge", error);
    process.exit(1);
  });
  try {
    await runBridge(config, logger);
  } catch (error) {
    await instanceLock.release();
    throw error;
  }
}

async function runSetup(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage: chat2codex setup [options]

Creates and connects a Feishu/Lark app through the official QR-code flow, then
writes FEISHU_APP_ID, FEISHU_APP_SECRET, LARK_DOMAIN, CODEX_WORKDIR, and when
available FEISHU_BOT_OPEN_ID and the scanning user's ALLOWED_USER_IDS to .env.

Options:
  --env <path>       File to create or update (default: .env)
  --workdir <path>   CODEX_WORKDIR value (default: current directory)
`);
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
  if (args[0] === "-h" || args[0] === "--help") {
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
  loadRuntimeEnv(envPath);

  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(process.env);
    checks.push({ label: "configuration", status: "ok" });
  } catch (error) {
    checks.push({ label: "configuration", status: "error", detail: formatConfigError(error) });
  }

  const codexBin = config?.codexBin ?? process.env.CODEX_BIN ?? "codex";
  checks.push(checkCommand(codexBin, ["--version"], "Codex CLI"));

  if (config) {
    checks.push(await checkDirectory(config.codexWorkdir, "CODEX_WORKDIR"));
    checks.push(await checkRuntimeDirectory(path.dirname(config.bridgeStatePath), "state directory"));
    checks.push(await checkRuntimeDirectory(path.dirname(config.attachmentDownloadDir), "attachment parent"));
    checks.push(...checkMobileSafeConfig(config));
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
  const options: EnvBackedOptions = { envFile: defaultEnvPath(), help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--env" || arg === "--env-file") {
      options.envFile = requireValue(args, ++index, arg);
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

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot(), "package.json"), "utf8")) as {
    version?: string;
  };
  return packageJson.version ?? "unknown";
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

function loadRuntimeEnv(envFile: string): void {
  loadDotenv({ path: envFile, override: false, quiet: true });
  process.env.CHAT2CODEX_HOME ??= defaultChat2CodexHome();
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function checkCommand(command: string, args: string[], label: string): DoctorCheck {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: buildCodexChildEnv(),
  });
  if (result.status === 0) {
    return {
      label,
      status: "ok",
      detail: result.stdout.trim() || command,
    };
  }
  return {
    label,
    status: "error",
    detail: `failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout || "not found"}`,
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

function formatEnvValue(value: string): string {
  if (/[\s#"'\\]/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
