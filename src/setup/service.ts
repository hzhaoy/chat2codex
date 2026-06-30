import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceTarget = "launchd" | "systemd";
type ServiceCommand = "print" | "install" | "uninstall";

export interface ServiceOptions {
  target: ServiceTarget;
  projectDir: string;
  entrypoint: string;
  envFile: string;
  nodeBin: string;
  pathEnv: string;
  launchdLabel: string;
  systemdServiceName: string;
  stdoutPath: string;
  stderrPath: string;
}

const defaultLaunchdLabel = "com.chat2codex.bridge";
const defaultSystemdServiceName = "chat2codex";

if (isDirectRun()) {
  await main(process.argv.slice(2));
}

async function main(argv: string[]): Promise<void> {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      printHelp();
      return;
    }

    const options = createServiceOptions(parsed);
    if (parsed.command === "print") {
      printService(options);
      return;
    }
    if (parsed.command === "install") {
      await installService(options);
      return;
    }
    await uninstallService(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function defaultServiceTarget(platform: NodeJS.Platform = process.platform): ServiceTarget {
  return platform === "darwin" ? "launchd" : "systemd";
}

export function createServiceOptions(args: ServiceCliArgs = {}): ServiceOptions {
  const target = args.target ?? defaultServiceTarget();
  const projectDir = path.resolve(args.projectDir ?? process.cwd());
  const logsDir = path.join(projectDir, ".data", "logs");
  return {
    target,
    projectDir,
    entrypoint: path.resolve(projectDir, args.entrypoint ?? "dist/index.js"),
    envFile: path.resolve(projectDir, args.envFile ?? ".env"),
    nodeBin: args.nodeBin ?? findExecutable("node"),
    pathEnv: args.pathEnv ?? defaultServicePath(target),
    launchdLabel: args.launchdLabel ?? defaultLaunchdLabel,
    systemdServiceName: normalizeSystemdServiceName(
      args.systemdServiceName ?? defaultSystemdServiceName,
    ),
    stdoutPath: path.resolve(
      projectDir,
      args.stdoutPath ?? path.join(logsDir, "chat2codex.out.log"),
    ),
    stderrPath: path.resolve(
      projectDir,
      args.stderrPath ?? path.join(logsDir, "chat2codex.err.log"),
    ),
  };
}

export function launchdPlistPath(label = defaultLaunchdLabel): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUnitPath(serviceName = defaultSystemdServiceName): string {
  return path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    `${normalizeSystemdServiceName(serviceName)}.service`,
  );
}

export function defaultServicePath(target: ServiceTarget = defaultServiceTarget()): string {
  if (target === "launchd") {
    return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return "/usr/local/bin:/usr/bin:/bin";
}

export function renderLaunchdPlist(options: ServiceOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodeBin)}</string>
    <string>${escapeXml(options.entrypoint)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${escapeXml(options.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: ServiceOptions): string {
  return `[Unit]
Description=Chat2Codex Feishu/Lark bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemd(options.projectDir)}
Environment=${quoteSystemd("NODE_ENV=production")}
Environment=${quoteSystemd(`PATH=${options.pathEnv}`)}
EnvironmentFile=-${quoteSystemd(options.envFile)}
ExecStart=${quoteSystemd(options.nodeBin)} ${quoteSystemd(options.entrypoint)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installService(options: ServiceOptions): Promise<void> {
  await ensureInstallInputs(options);
  if (options.target === "launchd") {
    await installLaunchd(options);
    return;
  }
  await installSystemd(options);
}

async function uninstallService(options: ServiceOptions): Promise<void> {
  if (options.target === "launchd") {
    await uninstallLaunchd(options);
    return;
  }
  await uninstallSystemd(options);
}

async function installLaunchd(options: ServiceOptions): Promise<void> {
  assertPlatform("darwin", "launchd");
  const plistPath = launchdPlistPath(options.launchdLabel);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.mkdir(path.dirname(options.stdoutPath), { recursive: true });
  await fs.writeFile(plistPath, renderLaunchdPlist(options));

  const domain = launchdDomain();
  run("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["enable", `${domain}/${options.launchdLabel}`]);
  run("launchctl", ["kickstart", "-k", `${domain}/${options.launchdLabel}`]);

  console.log(`Installed launchd service: ${options.launchdLabel}`);
  console.log(`Plist: ${plistPath}`);
  console.log(`Logs: ${options.stdoutPath} / ${options.stderrPath}`);
}

async function uninstallLaunchd(options: ServiceOptions): Promise<void> {
  assertPlatform("darwin", "launchd");
  const plistPath = launchdPlistPath(options.launchdLabel);
  run("launchctl", ["bootout", launchdDomain(), plistPath], { allowFailure: true });
  await fs.rm(plistPath, { force: true });
  console.log(`Uninstalled launchd service: ${options.launchdLabel}`);
}

async function installSystemd(options: ServiceOptions): Promise<void> {
  assertPlatform("linux", "systemd");
  const unitPath = systemdUnitPath(options.systemdServiceName);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, renderSystemdUnit(options));

  const unitName = `${options.systemdServiceName}.service`;
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", unitName]);

  console.log(`Installed systemd user service: ${unitName}`);
  console.log(`Unit: ${unitPath}`);
  console.log(`Logs: journalctl --user -u ${unitName} -f`);
}

async function uninstallSystemd(options: ServiceOptions): Promise<void> {
  assertPlatform("linux", "systemd");
  const unitName = `${options.systemdServiceName}.service`;
  run("systemctl", ["--user", "disable", "--now", unitName], { allowFailure: true });
  await fs.rm(systemdUnitPath(options.systemdServiceName), { force: true });
  run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  console.log(`Uninstalled systemd user service: ${unitName}`);
}

async function ensureInstallInputs(options: ServiceOptions): Promise<void> {
  const missing: string[] = [];
  if (!(await fileExists(options.envFile))) {
    missing.push(`${options.envFile} (.env; run bun run setup:feishu first)`);
  }
  if (!(await fileExists(options.entrypoint))) {
    missing.push(`${options.entrypoint} (run bun run build first)`);
  }
  if (missing.length > 0) {
    throw new Error(`Cannot install service; missing required file(s):\n- ${missing.join("\n- ")}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function printService(options: ServiceOptions): void {
  const filePath =
    options.target === "launchd"
      ? launchdPlistPath(options.launchdLabel)
      : systemdUnitPath(options.systemdServiceName);
  const content =
    options.target === "launchd" ? renderLaunchdPlist(options) : renderSystemdUnit(options);

  console.log(`# target: ${options.target}`);
  console.log(`# file: ${filePath}`);
  console.log(content);
}

export interface ServiceCliArgs {
  command?: ServiceCommand;
  target?: ServiceTarget;
  projectDir?: string;
  entrypoint?: string;
  envFile?: string;
  nodeBin?: string;
  pathEnv?: string;
  launchdLabel?: string;
  systemdServiceName?: string;
  stdoutPath?: string;
  stderrPath?: string;
  help?: boolean;
}

function parseCliArgs(argv: string[]): ServiceCliArgs {
  const result: ServiceCliArgs = {};
  const rest = [...argv];
  const first = rest[0];
  if (first === "print" || first === "install" || first === "uninstall") {
    result.command = rest.shift() as ServiceCommand;
  } else {
    result.command = "print";
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    if (!name.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? rest[++index];
    if (!value) {
      throw new Error(`Missing value for ${name}`);
    }

    switch (name) {
      case "--target":
        result.target = parseTarget(value);
        break;
      case "--project-dir":
        result.projectDir = value;
        break;
      case "--entrypoint":
        result.entrypoint = value;
        break;
      case "--env-file":
        result.envFile = value;
        break;
      case "--node-bin":
        result.nodeBin = value;
        break;
      case "--path":
        result.pathEnv = value;
        break;
      case "--launchd-label":
        result.launchdLabel = value;
        break;
      case "--systemd-name":
        result.systemdServiceName = value;
        break;
      case "--stdout":
        result.stdoutPath = value;
        break;
      case "--stderr":
        result.stderrPath = value;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return result;
}

function parseTarget(value: string): ServiceTarget {
  if (value === "launchd" || value === "systemd") {
    return value;
  }
  throw new Error(`Unsupported service target: ${value}`);
}

function normalizeSystemdServiceName(value: string): string {
  return value.endsWith(".service") ? value.slice(0, -".service".length) : value;
}

function findExecutable(command: string): string {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  const found = result.status === 0 ? result.stdout.trim() : "";
  if (found) {
    return found;
  }
  if (path.basename(process.execPath) === command) {
    return process.execPath;
  }
  return command;
}

function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0 && !options.allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function assertPlatform(expected: NodeJS.Platform, target: ServiceTarget): void {
  if (process.platform !== expected) {
    throw new Error(`${target} install is only supported on ${expected}; use print to render files.`);
  }
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot determine current uid for launchd bootstrap domain.");
  }
  return `gui/${uid}`;
}

function quoteSystemd(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && path.resolve(entrypoint) === fileURLToPath(import.meta.url));
}

function printHelp(): void {
  console.log(`Usage:
  bun src/setup/service.ts print [options]
  bun src/setup/service.ts install [options]
  bun src/setup/service.ts uninstall [options]

Options:
  --target launchd|systemd       Defaults to launchd on macOS, systemd elsewhere
  --project-dir <path>           Defaults to the current directory
  --entrypoint <path>            Defaults to dist/index.js under project dir
  --env-file <path>              Defaults to .env under project dir
  --node-bin <path>              Defaults to the current node executable from PATH
  --path <PATH>                  PATH passed to the service environment
                                  Defaults to a stable service PATH
  --launchd-label <label>        Defaults to com.chat2codex.bridge
  --systemd-name <name>          Defaults to chat2codex
  --stdout <path>                launchd stdout log path
  --stderr <path>                launchd stderr log path
`);
}
