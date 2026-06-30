import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type SmokeMode = "handshake" | "turn" | "approval";
type ApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

interface SmokeOptions {
  codexBin: string;
  cwd?: string;
  mode: SmokeMode;
  timeoutMs: number;
  model?: string;
  prompt: string;
  approvalPolicy: ApprovalPolicy;
  approvalDecision: ApprovalDecision;
  sandbox: SandboxMode;
}

interface JsonRpcRequest {
  [key: string]: unknown;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  [key: string]: unknown;
  id: string | number;
  result?: unknown;
  error?: { message?: string };
}

interface JsonRpcNotification {
  [key: string]: unknown;
  method: string;
  params?: Record<string, unknown>;
}

const defaultPrompt = "Reply exactly with: chat2codex-app-server-smoke-ok";
const approvalFileName = "approval-smoke.txt";
const approvalFileText = "chat2codex approval smoke ok";
const defaultApprovalPrompt = [
  `Create a file named ${approvalFileName} in the current working directory.`,
  `The file content must be exactly: ${approvalFileText}`,
  "Use a shell command to create the file.",
  "After the file is created, reply exactly with: chat2codex-app-server-approval-smoke-ok",
].join(" ");

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const codexVersion = commandOutput(options.codexBin, ["--version"]);
  const temporaryCwd = options.cwd
    ? null
    : await fs.mkdtemp(path.join(os.tmpdir(), "chat2codex-app-server-smoke-"));
  const cwd = options.cwd ? path.resolve(options.cwd) : temporaryCwd;
  if (!cwd) {
    throw new Error("Unable to create a temporary smoke workspace.");
  }

  if (!options.cwd) {
    await fs.writeFile(
      path.join(cwd, "README.md"),
      "Temporary workspace for Chat2Codex app-server smoke test.\n",
    );
  }

  const session = new AppServerSmokeSession(options.codexBin, cwd, options.timeoutMs);
  try {
    await session.start();
    await session.request("initialize", {
      clientInfo: {
        name: "chat2codex-smoke",
        title: "Chat2Codex Smoke Test",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });

    const threadResult = await session.request("thread/start", {
      cwd,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: options.sandbox,
      ...(options.model ? { model: options.model } : {}),
    });
    session.threadId = extractThreadId(threadResult) ?? session.threadId;
    if (!session.threadId) {
      throw new Error("thread/start did not return a thread id.");
    }

    let turnId: string | undefined;
    if (options.mode === "turn" || options.mode === "approval") {
      const turnResult = await session.request("turn/start", {
        threadId: session.threadId,
        input: [
          {
            type: "text",
            text: options.prompt,
            text_elements: [],
          },
        ],
        cwd,
        approvalPolicy: options.approvalPolicy,
        sandboxPolicy: sandboxModeToPolicy(options.sandbox),
        ...(options.model ? { model: options.model } : {}),
      });
      turnId = extractTurnId(turnResult) ?? session.turnId;
      await session.waitForTurnCompletion();
    }

    if (options.mode === "approval" && session.approvalRequests.length === 0) {
      throw new Error(
        `Approval smoke completed without an app-server approval request. Observed server requests: ${[
          ...session.observedServerRequests,
        ].join(", ") || "(none)"}.`,
      );
    }

    let approvalFile: { path: string; content: string } | undefined;
    if (options.mode === "approval" && options.approvalDecision === "accept") {
      const filePath = path.join(cwd, approvalFileName);
      const content = await fs.readFile(filePath, "utf8");
      approvalFile = { path: filePath, content };
      if (content.trim() !== approvalFileText) {
        throw new Error(
          `${approvalFileName} content mismatch: expected ${JSON.stringify(
            approvalFileText,
          )}, got ${JSON.stringify(content.trim())}`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: options.mode,
          codexVersion,
          cwd,
          threadId: session.threadId,
          turnId,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          approvalDecision:
            options.mode === "approval" ? options.approvalDecision : undefined,
          approvalRequests:
            session.approvalRequests.length > 0 ? session.approvalRequests : undefined,
          approvalFile,
          finalText:
            options.mode === "turn" || options.mode === "approval"
              ? session.finalText
              : undefined,
          observedNotifications: [...session.observedNotifications].sort(),
          observedServerRequests: [...session.observedServerRequests].sort(),
          stderrLineCount: countLines(session.stderr) || undefined,
          stderrPreview: preview(session.stderr, 1200) || undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.stop();
    if (temporaryCwd) {
      await fs.rm(temporaryCwd, { recursive: true, force: true });
    }
  }
}

class AppServerSmokeSession {
  threadId?: string;
  turnId?: string;
  finalText = "";
  stderr = "";
  readonly observedNotifications = new Set<string>();
  readonly observedServerRequests = new Set<string>();
  readonly approvalRequests: Array<Record<string, unknown>> = [];

  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: readline.Interface | null = null;
  private requestSeq = 0;
  private stopping = false;
  private turnStarted = false;
  private turnCompleted = false;
  private closePromise: Promise<void> | null = null;
  private resolveTurn: (() => void) | null = null;
  private rejectTurn: ((error: Error) => void) | null = null;
  private readonly turnDone = new Promise<void>((resolve, reject) => {
    this.resolveTurn = resolve;
    this.rejectTurn = reject;
  });
  private readonly pending = new Map<
    string,
    {
      method: string;
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly codexBin: string,
    private readonly cwd: string,
    private readonly timeoutMs: number,
    private readonly approvalDecision: ApprovalDecision = "accept",
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.codexBin, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.closePromise = new Promise((resolve) => {
      this.child?.on("close", () => {
        const error = new Error("Codex app-server exited before the smoke test completed.");
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          if (!this.stopping) {
            pending.reject(error);
          }
        }
        this.pending.clear();
        if (this.turnStarted && !this.turnCompleted && !this.stopping) {
          this.rejectTurn?.(error);
        }
        resolve();
      });
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      if (!this.turnCompleted) {
        this.rejectTurn?.(error);
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.requireChild();
    const id = String(++this.requestSeq);
    const message = { id, method, params };
    if (method === "turn/start") {
      this.turnStarted = true;
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out waiting for ${method} after ${this.timeoutMs}ms. Observed notifications: ${[
              ...this.observedNotifications,
            ].join(", ") || "(none)"}.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  waitForTurnCompletion(): Promise<void> {
    if (this.turnCompleted) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for turn/completed after ${this.timeoutMs}ms. Observed notifications: ${[
              ...this.observedNotifications,
            ].join(", ") || "(none)"}.`,
          ),
        );
      }, this.timeoutMs);
      this.turnDone.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.reader?.close();
    if (!child) {
      return;
    }
    this.stopping = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 2000);
      await this.closePromise?.finally(() => clearTimeout(forceKill));
      return;
    }
    await this.closePromise;
  }

  private handleLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      return;
    }

    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(`${pending.method} failed: ${message.error.message ?? "unknown error"}`),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (isJsonRpcRequest(message)) {
      this.observedServerRequests.add(message.method);
      this.resolveServerRequest(message);
      return;
    }

    if (!isJsonRpcNotification(message)) {
      return;
    }
    this.observedNotifications.add(message.method);

    if (message.method === "thread/started") {
      this.threadId = extractThreadId(message.params) ?? this.threadId;
    }
    if (message.method === "turn/started") {
      this.turnId = extractTurnId(message.params) ?? this.turnId;
    }
    if (message.method === "item/completed") {
      const item = asRecord(message.params?.item);
      if (getString(item, "type") === "agentMessage" && getString(item, "phase") !== "commentary") {
        this.finalText = getString(item, "text") ?? this.finalText;
      }
    }
    if (message.method === "turn/completed") {
      this.turnCompleted = true;
      this.resolveTurn?.();
    }
  }

  private resolveServerRequest(message: JsonRpcRequest): void {
    const child = this.requireChild();
    let result: Record<string, unknown> = {};
    if (message.method.endsWith("/requestApproval")) {
      this.approvalRequests.push(summarizeApprovalRequest(message));
      result = { decision: this.approvalDecision };
    }
    child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || !this.child.stdin.writable || this.child.stdin.destroyed) {
      throw new Error("Codex app-server process is not writable.");
    }
    return this.child;
  }
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {
    codexBin: process.env.CODEX_BIN || "codex",
    cwd: undefined,
    mode: parseMode(process.env.CODEX_APP_SERVER_SMOKE_MODE) ?? "handshake",
    timeoutMs: parsePositiveInt(process.env.CODEX_APP_SERVER_SMOKE_TIMEOUT_MS) ?? 30_000,
    model: process.env.CODEX_MODEL || undefined,
    prompt: defaultPrompt,
    approvalPolicy: "never",
    approvalDecision: "accept",
    sandbox: "read-only",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--codex-bin") {
      options.codexBin = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mode") {
      const mode = parseMode(requireValue(argv, ++index, arg));
      if (!mode) {
        throw new Error("--mode must be handshake, turn, or approval.");
      }
      options.mode = mode;
      continue;
    }
    if (arg === "--timeout-ms") {
      const timeout = parsePositiveInt(requireValue(argv, ++index, arg));
      if (!timeout) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
      options.timeoutMs = timeout;
      continue;
    }
    if (arg === "--model") {
      options.model = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--prompt") {
      options.prompt = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--approval-policy") {
      const approvalPolicy = parseApprovalPolicy(requireValue(argv, ++index, arg));
      if (!approvalPolicy) {
        throw new Error("--approval-policy must be untrusted, on-request, on-failure, or never.");
      }
      options.approvalPolicy = approvalPolicy;
      continue;
    }
    if (arg === "--approval-decision") {
      const decision = parseApprovalDecision(requireValue(argv, ++index, arg));
      if (!decision) {
        throw new Error("--approval-decision must be accept, acceptForSession, decline, or cancel.");
      }
      options.approvalDecision = decision;
      continue;
    }
    if (arg === "--sandbox") {
      const sandbox = parseSandbox(requireValue(argv, ++index, arg));
      if (!sandbox) {
        throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access.");
      }
      options.sandbox = sandbox;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode === "approval") {
    if (options.prompt === defaultPrompt) {
      options.prompt = defaultApprovalPrompt;
    }
    if (options.approvalPolicy === "never") {
      options.approvalPolicy = "untrusted";
    }
    if (options.sandbox === "read-only") {
      options.sandbox = "workspace-write";
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: bun src/setup/smoke-app-server.ts [options]

Options:
  --mode handshake|turn|approval
                            handshake validates initialize + thread/start; turn also runs a model turn;
                            approval induces a write command approval and accepts it by default
  --timeout-ms <ms>         timeout for each protocol phase (default: 30000)
  --codex-bin <path>        Codex executable (default: CODEX_BIN or codex)
  --cwd <path>              workspace to use (default: temp dir or CODEX_WORKDIR)
  --model <name>            optional Codex model override
  --prompt <text>           prompt for --mode turn
  --approval-policy <name>  default: never; approval mode defaults to untrusted
  --approval-decision <d>   default: accept
  --sandbox <mode>          default: read-only; approval mode defaults to workspace-write
`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseMode(value: string | undefined): SmokeMode | null {
  if (value === "handshake" || value === "turn" || value === "approval") {
    return value;
  }
  return null;
}

function parseApprovalPolicy(value: string | undefined): ApprovalPolicy | null {
  if (value === "untrusted" || value === "on-request" || value === "on-failure" || value === "never") {
    return value;
  }
  return null;
}

function parseApprovalDecision(value: string | undefined): ApprovalDecision | null {
  if (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return value;
  }
  return null;
}

function parseSandbox(value: string | undefined): SandboxMode | null {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run ${command} ${args.join(" ")}: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

function countLines(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\r?\n/u).length : 0;
}

function preview(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3).trimEnd()}...` : trimmed;
}

function sandboxModeToPolicy(mode: SandboxMode): Record<string, unknown> {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function summarizeApprovalRequest(message: JsonRpcRequest): Record<string, unknown> {
  const params = asRecord(message.params) ?? {};
  const summary: Record<string, unknown> = {
    id: message.id,
    method: message.method,
  };
  for (const key of [
    "threadId",
    "turnId",
    "itemId",
    "approvalId",
    "reason",
    "command",
    "cwd",
    "grantRoot",
    "availableDecisions",
  ]) {
    const value = params[key];
    if (value !== undefined) {
      summary[key] = value;
    }
  }
  return summary;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isJsonRpcRequest(message: Record<string, unknown>): message is JsonRpcRequest {
  return "id" in message && typeof message.method === "string";
}

function isJsonRpcNotification(message: Record<string, unknown>): message is JsonRpcNotification {
  return !("id" in message) && typeof message.method === "string";
}

function isJsonRpcResponse(message: Record<string, unknown>): message is JsonRpcResponse {
  return "id" in message && !("method" in message) && ("result" in message || "error" in message);
}

function extractThreadId(result: unknown): string | undefined {
  return getString(asRecord(asRecord(result)?.thread), "id") ?? getString(asRecord(result), "threadId");
}

function extractTurnId(result: unknown): string | undefined {
  return getString(asRecord(asRecord(result)?.turn), "id") ?? getString(asRecord(result), "turnId");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
}
