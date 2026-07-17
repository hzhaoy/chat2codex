import { spawn } from "node:child_process";
import readline from "node:readline";

import type { BridgeConfig } from "../config/env.js";
import type { Logger } from "../util/logger.js";
import { buildCodexChildEnv } from "./codex-environment.js";

const appServerSteerRetryDelaysMs = [0, 100, 250, 500, 1000, 1500];

export interface CodexRunInput {
  prompt: string;
  cwd: string;
  threadId?: string;
  signal?: AbortSignal;
  onProgress?: (update: CodexProgressUpdate) => void | Promise<void>;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  onRunControl?: (control: CodexRunControl) => void;
}

export interface CodexRunResult {
  threadId?: string;
  finalText: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  cancelled?: boolean;
  summary?: CodexRunSummary;
}

export interface CodexRunControl {
  threadId?: string;
  turnId?: string;
  steer(input: string): Promise<void>;
}

export interface CodexRunSummary {
  durationMs?: number;
  diff?: string;
  diffStat?: string;
  changedFiles: string[];
  fileChangeCount: number;
  commands: CodexCommandSummary[];
}

export interface CodexCommandSummary {
  command: string;
  cwd?: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputPreview?: string;
}

export interface CodexProgressUpdate {
  kind: "running" | "error";
  text: string;
  eventType?: string;
  itemType?: string;
}

export type CodexApprovalKind = "command" | "file_change";
export type CodexApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: unknown;
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: unknown;
      };
    };

export interface CodexApprovalRequest {
  id: string;
  kind: CodexApprovalKind;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string | null;
  startedAtMs?: number;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  grantRoot?: string | null;
  commandActions?: unknown[];
  additionalPermissions?: unknown;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
  decisions: CodexApprovalDecision[];
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  cwd: string;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  source?: unknown;
  status?: unknown;
  path?: string | null;
  cliVersion?: string;
  resumable?: boolean;
  unavailableReason?: string;
}

export interface CodexThreadListInput {
  cwd?: string | string[];
  limit?: number;
  cursor?: string;
  searchTerm?: string;
  archived?: boolean | null;
  sortKey?: "created_at" | "updated_at";
  sortDirection?: "asc" | "desc";
}

export interface CodexThreadListResult {
  threads: CodexThread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadSearchInput {
  searchTerm: string;
  limit?: number;
  cursor?: string;
  archived?: boolean | null;
  sortKey?: "created_at" | "updated_at";
  sortDirection?: "asc" | "desc";
}

export interface CodexThreadSearchResultItem {
  thread: CodexThread;
  snippet?: string;
}

export interface CodexThreadSearchResult {
  results: CodexThreadSearchResultItem[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadTurnListInput {
  threadId: string;
  limit?: number;
  cursor?: string;
  sortDirection?: "asc" | "desc";
  itemsView?: "notLoaded" | "summary" | "full";
}

export interface CodexThreadTurnListResult {
  turns: CodexThreadTurn[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadTurnItemListInput {
  threadId: string;
  turnId: string;
  limit?: number;
  cursor?: string;
  sortDirection?: "asc" | "desc";
}

export interface CodexThreadTurnItemListResult {
  items: CodexThreadItem[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadTurn {
  id: string;
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items: CodexThreadItem[];
}

export interface CodexThreadItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  files?: string[];
}

export interface CodexForkThreadInput {
  threadId: string;
  cwd?: string;
}

interface JsonRpcRequest {
  [key: string]: unknown;
  id: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  [key: string]: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  [key: string]: unknown;
  id: unknown;
  result?: unknown;
  error?: {
    message?: string;
  };
}

export class CodexRunner {
  private appServerCliVersion?: string;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  async listThreads(input: CodexThreadListInput = {}): Promise<CodexThreadListResult> {
    const result = await this.requestAppServer("thread/list", {
      limit: input.limit ?? 100,
      sortKey: input.sortKey ?? "updated_at",
      sortDirection: input.sortDirection ?? "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      useStateDbOnly: true,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    });
    const record = asRecord(result);
    return {
      threads: parseCodexThreads(record?.data).map((thread) =>
        markThreadResumability(thread, this.appServerCliVersion),
      ),
      nextCursor: getString(record, "nextCursor") ?? null,
      backwardsCursor: getString(record, "backwardsCursor") ?? null,
    };
  }

  async readThread(threadId: string): Promise<CodexThread | null> {
    const result = await this.requestAppServer("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = parseCodexThread(asRecord(result)?.thread);
    return thread ? markThreadResumability(thread, this.appServerCliVersion) : null;
  }

  async searchThreads(input: CodexThreadSearchInput): Promise<CodexThreadSearchResult> {
    const result = await this.requestAppServer("thread/search", {
      searchTerm: input.searchTerm,
      limit: input.limit ?? 20,
      sortKey: input.sortKey ?? "updated_at",
      sortDirection: input.sortDirection ?? "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    });
    const record = asRecord(result);
    return {
      results: parseThreadSearchResults(record?.data).map((item) => ({
        ...item,
        thread: markThreadResumability(item.thread, this.appServerCliVersion),
      })),
      nextCursor: getString(record, "nextCursor") ?? null,
      backwardsCursor: getString(record, "backwardsCursor") ?? null,
    };
  }

  async listThreadTurns(input: CodexThreadTurnListInput): Promise<CodexThreadTurnListResult> {
    const result = await this.requestAppServer("thread/turns/list", {
      threadId: input.threadId,
      limit: input.limit ?? 10,
      sortDirection: input.sortDirection ?? "desc",
      itemsView: input.itemsView ?? "summary",
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    const record = asRecord(result);
    return {
      turns: parseThreadTurns(record?.data),
      nextCursor: getString(record, "nextCursor") ?? null,
      backwardsCursor: getString(record, "backwardsCursor") ?? null,
    };
  }

  async listTurnItems(input: CodexThreadTurnItemListInput): Promise<CodexThreadTurnItemListResult> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    while (true) {
      const result = await this.requestAppServer("thread/turns/list", {
        threadId: input.threadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      });
      const record = asRecord(result);
      const turn = parseThreadTurns(record?.data).find((item) => item.id === input.turnId);
      if (turn) {
        return {
          items: turn.items,
          nextCursor: null,
          backwardsCursor: null,
        };
      }

      const nextCursor = getString(record, "nextCursor");
      if (!nextCursor || seenCursors.has(nextCursor)) {
        return {
          items: [],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async forkThread(input: CodexForkThreadInput): Promise<CodexThread> {
    const result = await this.requestAppServer("thread/fork", {
      threadId: input.threadId,
      excludeTurns: true,
      cwd: input.cwd ?? null,
      approvalPolicy: this.config.codexApprovalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codexSandbox,
      ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
    });
    const thread = parseCodexThread(asRecord(result)?.thread);
    if (!thread) {
      throw new Error("Codex app-server did not return a forked thread.");
    }
    return markThreadResumability(thread, this.appServerCliVersion);
  }

  async compactThread(threadId: string): Promise<void> {
    await this.requestAppServer("thread/compact/start", { threadId });
  }

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    if (input.signal?.aborted) {
      return {
        threadId: input.threadId,
        finalText: "",
        stderr: "",
        exitCode: null,
        signal: null,
        cancelled: true,
      };
    }

    const args = buildCodexAppServerArgs();
    this.logger.info("Starting Codex", {
      cwd: input.cwd,
      resume: Boolean(input.threadId),
      sandbox: this.config.codexSandbox,
      approvalPolicy: this.config.codexApprovalPolicy,
      mode: "app-server",
    });

    const child = spawn(this.config.codexBin, args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexChildEnv(),
    });

    let forceKillTimer: NodeJS.Timeout | null = null;
    const abortChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      this.logger.info("Stopping Codex child process", { pid: child.pid });
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
      forceKillTimer.unref?.();
    };
    input.signal?.addEventListener("abort", abortChild, { once: true });
    if (input.signal?.aborted) {
      abortChild();
    }

    let threadId = input.threadId;
    let finalText = "";
    let stderr = "";
    let requestSeq = 0;
    let activeTurnId: string | undefined;
    let turnCompleted = false;
    let turnError: string | null = null;
    let approvalCancelled = false;
    const summary = createEmptyRunSummary();
    const commandOutputBuffers = new Map<string, string>();
    let resolveTurn: (() => void) | null = null;
    const pendingRequests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const turnDone = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });

    const sendJson = (message: unknown) => {
      if (!child.stdin.writable || child.stdin.destroyed) {
        throw new Error("Codex app-server stdin is not writable.");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const sendRequest = (method: string, params: unknown): Promise<unknown> => {
      const id = ++requestSeq;
      const promise = new Promise<unknown>((resolve, reject) => {
        pendingRequests.set(String(id), { resolve, reject });
      });
      sendJson({ id, method, params });
      return promise;
    };

    const resolveServerRequest = (id: unknown, result: unknown) => {
      try {
        sendJson({ id, result });
      } catch (error) {
        this.logger.warn("Failed to resolve Codex app-server request", error);
      }
    };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      const message = parseJsonLine(line);
      if (!message) {
        return;
      }

      if (isJsonRpcResponse(message)) {
        const pending = pendingRequests.get(String(message.id));
        if (!pending) {
          return;
        }
        pendingRequests.delete(String(message.id));
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
          return;
        }
        pending.resolve(message.result);
        return;
      }

      if (isJsonRpcRequest(message)) {
        this.handleAppServerRequest(message, input, resolveServerRequest, (decision) => {
          if (decision === "cancel") {
            approvalCancelled = true;
          }
        });
        return;
      }

      if (!isJsonRpcNotification(message)) {
        return;
      }

      if (message.method === "thread/started") {
        threadId = getString(asRecord(message.params?.thread), "id") ?? threadId;
      }
      if (message.method === "turn/started") {
        activeTurnId = getString(asRecord(message.params?.turn), "id") ?? activeTurnId;
      }
      if (message.method === "turn/completed") {
        const turn = asRecord(message.params?.turn);
        summary.durationMs = getNumber(turn, "durationMs") ?? summary.durationMs;
        if (!activeTurnId || getString(turn, "id") === activeTurnId) {
          turnCompleted = true;
          resolveTurn?.();
        }
        if (getString(turn, "status") === "failed") {
          turnError = formatTurnError(turn?.error);
        }
      }
      if (message.method === "error") {
        if (message.params?.willRetry !== true) {
          turnError =
            getString(asRecord(message.params?.error), "message") ?? "Codex reported an error.";
        }
        this.logger.warn("Codex emitted an error notification", message);
      }
      if (message.method === "item/completed") {
        const item = asRecord(message.params?.item);
        if (getString(item, "type") === "agentMessage") {
          const text = getString(item, "text");
          if (text?.trim() && getString(item, "phase") !== "commentary") {
            finalText = text;
          }
        }
        recordCompletedItem(summary, item, commandOutputBuffers);
      }
      if (message.method === "turn/diff/updated") {
        const diff = getString(message.params, "diff");
        if (diff !== undefined) {
          summary.diff = diff;
          summary.diffStat = summarizeUnifiedDiff(diff);
          addChangedFiles(summary, filesFromUnifiedDiff(diff));
        }
      }
      if (message.method === "item/commandExecution/outputDelta") {
        const itemId = getString(message.params, "itemId");
        const delta = getString(message.params, "delta");
        if (itemId !== undefined && delta !== undefined) {
          const outputPreview = truncateOutputPreview(`${commandOutputBuffers.get(itemId) ?? ""}${delta}`);
          if (outputPreview !== undefined) {
            commandOutputBuffers.set(itemId, outputPreview);
          }
        }
      }
      if (message.method === "item/fileChange/patchUpdated") {
        const changes = Array.isArray(message.params?.changes) ? message.params.changes : [];
        recordFileChanges(summary, changes);
      }

      const progress = summarizeCodexAppServerProgress(message);
      if (progress && input.onProgress && !input.signal?.aborted) {
        Promise.resolve(input.onProgress(progress)).catch((error: unknown) => {
          this.logger.warn("Codex progress callback failed", error);
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const rejectPendingRequests = (error: Error) => {
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    };

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on("error", (error) => {
          rejectPendingRequests(error);
          reject(error);
        });
        child.on("close", (code, signal) => {
          rejectPendingRequests(new Error("Codex app-server exited before responding."));
          resolve({ code, signal });
        });
      },
    );

    try {
      const initializeResult = await sendRequest("initialize", {
        clientInfo: {
          name: "chat2codex",
          title: "Chat2Codex",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.rememberAppServerInfo(initializeResult);

      const threadResult = input.threadId
        ? await sendRequest("thread/resume", buildThreadResumeParams(this.config, input))
        : await sendRequest("thread/start", buildThreadStartParams(this.config, input));
      threadId = extractThreadId(threadResult) ?? threadId;

      const turnResult = await sendRequest("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: [],
          },
        ],
        cwd: input.cwd,
        approvalPolicy: this.config.codexApprovalPolicy,
        sandboxPolicy: sandboxModeToPolicy(this.config.codexSandbox),
        ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
      });
      activeTurnId = extractTurnId(turnResult) ?? activeTurnId;
      input.onRunControl?.({
        threadId,
        turnId: activeTurnId,
        steer: (text: string) =>
          steerAppServerTurn({
            text,
            getThreadId: () => threadId,
            getTurnId: () => activeTurnId,
            isTurnCompleted: () => turnCompleted,
            isAborted: () => Boolean(input.signal?.aborted),
            sendRequest,
          }),
      });
    } catch (error) {
      abortChild();
      throw error;
    }

    const exit = await Promise.race([
      turnDone.then(() => {
        if (child.exitCode === null && child.signalCode === null) {
          abortChild();
        }
        return exitPromise;
      }),
      exitPromise,
    ]);

    input.signal?.removeEventListener("abort", abortChild);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    stdoutReader.close();

    const cancelled = Boolean(input.signal?.aborted || (approvalCancelled && !finalText.trim()));
    if (!finalText.trim()) {
      finalText = cancelled
        ? ""
        : exit.code === 0 && turnCompleted && !turnError
          ? "(Codex finished without a final text response.)"
          : [turnError, stderr.trim()].filter(Boolean).join("\n");
    }

    return {
      threadId,
      finalText: finalText.trim(),
      stderr: stderr.trim(),
      exitCode: cancelled || (turnCompleted && !turnError) ? 0 : exit.code,
      signal: exit.signal,
      cancelled,
      summary: finalizeRunSummary(summary),
    };
  }

  private handleAppServerRequest(
    message: JsonRpcRequest,
    input: CodexRunInput,
    resolveServerRequest: (id: unknown, result: unknown) => void,
    onApprovalDecision: (decision: CodexApprovalDecision) => void,
  ): void {
    const approval = toCodexApprovalRequest(message);
    if (!approval) {
      resolveServerRequest(message.id, {});
      return;
    }

    if (!input.onApprovalRequest) {
      onApprovalDecision("decline");
      resolveServerRequest(message.id, { decision: "decline" });
      return;
    }

    Promise.resolve(input.onApprovalRequest(approval))
      .then((decision) => {
        onApprovalDecision(decision);
        resolveServerRequest(message.id, { decision });
      })
      .catch((error: unknown) => {
        this.logger.warn("Codex approval callback failed; cancelling approval request", error);
        onApprovalDecision("cancel");
        resolveServerRequest(message.id, { decision: "cancel" });
      });
  }

  private async requestAppServer(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = spawn(this.config.codexBin, buildCodexAppServerArgs(), {
      cwd: this.config.codexWorkdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexChildEnv(),
    });
    const stdoutReader = readline.createInterface({ input: child.stdout });
    let stderr = "";
    let requestSeq = 0;
    const pendingRequests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();

    let forceKillTimer: NodeJS.Timeout | null = null;
    const abortChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
      forceKillTimer.unref?.();
    };

    const sendJson = (message: unknown) => {
      if (!child.stdin.writable || child.stdin.destroyed) {
        throw new Error("Codex app-server stdin is not writable.");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const sendRequest = (requestMethod: string, requestParams: unknown): Promise<unknown> => {
      const id = ++requestSeq;
      const promise = new Promise<unknown>((resolve, reject) => {
        pendingRequests.set(String(id), { resolve, reject });
      });
      sendJson({ id, method: requestMethod, params: requestParams });
      return promise;
    };

    const rejectPendingRequests = (error: Error) => {
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    };

    stdoutReader.on("line", (line) => {
      const message = parseJsonLine(line);
      if (!message) {
        return;
      }
      if (isJsonRpcResponse(message)) {
        const pending = pendingRequests.get(String(message.id));
        if (!pending) {
          return;
        }
        pendingRequests.delete(String(message.id));
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
          return;
        }
        pending.resolve(message.result);
        return;
      }
      if (isJsonRpcRequest(message)) {
        try {
          sendJson({ id: message.id, result: {} });
        } catch (error) {
          this.logger.warn("Failed to resolve Codex app-server request", error);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (error) => {
      rejectPendingRequests(error);
    });
    child.once("close", () => {
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      rejectPendingRequests(new Error(`Codex app-server exited before responding.${suffix}`));
    });

    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        abortChild();
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, 15_000);
    });

    const closePromise = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });

    try {
      const operation = (async () => {
        const initializeResult = await sendRequest("initialize", {
          clientInfo: {
            name: "chat2codex",
            title: "Chat2Codex",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        });
        this.rememberAppServerInfo(initializeResult);
        return sendRequest(method, params);
      })();
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      abortChild();
      await Promise.race([
        closePromise,
        delay(250),
      ]);
      if (forceKillTimer && (child.exitCode !== null || child.signalCode !== null)) {
        clearTimeout(forceKillTimer);
      }
      stdoutReader.close();
    }
  }

  private rememberAppServerInfo(result: unknown): void {
    const userAgent = getString(asRecord(result), "userAgent");
    const version = parseCodexVersion(userAgent);
    if (version) {
      this.appServerCliVersion = version;
    }
  }
}

export function summarizeCodexProgress(event: CodexJsonEvent): CodexProgressUpdate | null {
  if (event.type === "turn.started") {
    return {
      kind: "running",
      text: "Codex 正在处理。",
      eventType: event.type,
    };
  }

  if (event.type === "turn.completed") {
    return {
      kind: "running",
      text: "Codex 正在整理结果。",
      eventType: event.type,
    };
  }

  if (event.type === "item.started") {
    const itemType = event.item?.type;
    return {
      kind: "running",
      text: describeStartedItem(itemType, getItemName(event.item)),
      eventType: event.type,
      itemType,
    };
  }

  if (event.type === "error") {
    return {
      kind: "error",
      text: "Codex 报告了一个错误事件。",
      eventType: event.type,
    };
  }

  return null;
}

export function buildCodexArgs(config: BridgeConfig, input: CodexRunInput): string[] {
  const global = ["--ask-for-approval", config.codexApprovalPolicy];
  const common = ["--json"];
  if (config.codexModel) {
    common.push("--model", config.codexModel);
  }
  if (config.codexSkipGitRepoCheck) {
    common.push("--skip-git-repo-check");
  }

  if (input.threadId) {
    return [...global, "exec", "resume", ...common, input.threadId, input.prompt];
  }

  return [
    ...global,
    "exec",
    ...common,
    "--sandbox",
    config.codexSandbox,
    "--cd",
    input.cwd,
    input.prompt,
  ];
}

export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--stdio"];
}

export interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    name?: string;
    tool_name?: string;
    command?: string;
    title?: string;
  };
}

export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  return parseJsonLine(line) as CodexJsonEvent | null;
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

function summarizeCodexAppServerProgress(message: JsonRpcNotification): CodexProgressUpdate | null {
  if (message.method === "turn/started") {
    return {
      kind: "running",
      text: "Codex 正在处理。",
      eventType: message.method,
    };
  }

  if (message.method === "turn/completed") {
    return {
      kind: "running",
      text: "Codex 正在整理结果。",
      eventType: message.method,
    };
  }

  if (message.method === "item/started") {
    const item = asRecord(message.params?.item);
    return {
      kind: "running",
      text: describeAppServerStartedItem(item),
      eventType: message.method,
      itemType: getString(item, "type"),
    };
  }

  if (message.method === "error") {
    return {
      kind: "error",
      text: "Codex 报告了一个错误事件。",
      eventType: message.method,
    };
  }

  return null;
}

function describeStartedItem(itemType: string | undefined, itemName: string | undefined): string {
  if (itemType === "reasoning") {
    return "Codex 正在思考。";
  }
  if (["tool_call", "function_call", "command_execution"].includes(itemType ?? "")) {
    return itemName ? `Codex 正在调用工具：${itemName}。` : "Codex 正在调用工具。";
  }
  return "Codex 正在执行下一步。";
}

function describeAppServerStartedItem(item: Record<string, unknown> | null): string {
  const itemType = getString(item, "type");
  if (itemType === "reasoning") {
    return "Codex 正在思考。";
  }
  if (itemType === "commandExecution") {
    const command = getString(item, "command");
    return command ? `Codex 正在执行命令：${truncateInline(command, 60)}。` : "Codex 正在执行命令。";
  }
  if (itemType === "fileChange") {
    return "Codex 正在应用文件变更。";
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const tool = getString(item, "tool");
    return tool ? `Codex 正在调用工具：${truncateInline(tool, 60)}。` : "Codex 正在调用工具。";
  }
  return "Codex 正在执行下一步。";
}

function createEmptyRunSummary(): CodexRunSummary {
  return {
    changedFiles: [],
    fileChangeCount: 0,
    commands: [],
  };
}

function finalizeRunSummary(summary: CodexRunSummary): CodexRunSummary {
  return {
    ...summary,
    diff: summary.diff ? truncateLargeText(summary.diff, 60_000) : undefined,
    changedFiles: [...new Set(summary.changedFiles)].slice(0, 200),
    commands: summary.commands.slice(-20).map((command) => ({
      ...command,
      outputPreview: command.outputPreview
        ? truncateOutputPreview(command.outputPreview)
        : undefined,
    })),
  };
}

function recordCompletedItem(
  summary: CodexRunSummary,
  item: Record<string, unknown> | null,
  commandOutputBuffers: Map<string, string>,
): void {
  const itemType = getString(item, "type");
  if (itemType === "commandExecution") {
    const command = getString(item, "command");
    if (!command) {
      return;
    }
    const itemId = getString(item, "id");
    const bufferedOutput = itemId ? commandOutputBuffers.get(itemId) : undefined;
    summary.commands.push({
      command,
      cwd: getString(item, "cwd"),
      status: getString(item, "status"),
      exitCode: getNullableNumber(item, "exitCode"),
      durationMs: getNumber(item, "durationMs"),
      outputPreview: truncateOutputPreview(
        getString(item, "aggregatedOutput") ?? bufferedOutput ?? "",
      ),
    });
    return;
  }

  if (itemType === "fileChange") {
    recordFileChanges(summary, Array.isArray(item?.changes) ? item.changes : []);
  }
}

function recordFileChanges(summary: CodexRunSummary, changes: unknown[]): void {
  const files = changes.flatMap((change) => {
    const record = asRecord(change);
    const filePath = getString(record, "path");
    return filePath ? [filePath] : [];
  });
  if (files.length) {
    summary.fileChangeCount += files.length;
    addChangedFiles(summary, files);
  }
}

function addChangedFiles(summary: CodexRunSummary, files: string[]): void {
  const seen = new Set(summary.changedFiles);
  for (const file of files) {
    if (!file || seen.has(file)) {
      continue;
    }
    seen.add(file);
    summary.changedFiles.push(file);
  }
}

function filesFromUnifiedDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/u);
    if (match?.[2]) {
      files.push(match[2]);
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(.+)$/u);
    if (plus?.[1] && plus[1] !== "/dev/null") {
      files.push(plus[1]);
    }
  }
  return [...new Set(files)];
}

function summarizeUnifiedDiff(diff: string): string | undefined {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  const fileCount = filesFromUnifiedDiff(diff).length;
  if (fileCount === 0 && additions === 0 && deletions === 0) {
    return undefined;
  }
  return `${fileCount} file(s), +${additions} -${deletions}`;
}

function truncateOutputPreview(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return truncateLargeText(normalized, 4_000);
}

function truncateLargeText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 32)}\n... [truncated]` : value;
}

function getItemName(item: CodexJsonEvent["item"]): string | undefined {
  const raw = item?.name ?? item?.tool_name ?? item?.command ?? item?.title;
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/\s+/gu, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

function toCodexApprovalRequest(message: JsonRpcRequest): CodexApprovalRequest | null {
  const params = message.params ?? {};
  if (message.method === "item/commandExecution/requestApproval") {
    return {
      id: approvalRequestKey(message.id),
      kind: "command",
      threadId: getString(params, "threadId"),
      turnId: getString(params, "turnId"),
      itemId: getString(params, "itemId"),
      approvalId: getString(params, "approvalId") ?? null,
      startedAtMs: getNumber(params, "startedAtMs"),
      reason: getString(params, "reason") ?? null,
      command: getString(params, "command") ?? null,
      cwd: getString(params, "cwd") ?? null,
      commandActions: Array.isArray(params.commandActions) ? params.commandActions : undefined,
      additionalPermissions: params.additionalPermissions,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
      proposedNetworkPolicyAmendments: Array.isArray(params.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments
        : undefined,
      decisions: parseCommandDecisions(params.availableDecisions),
    };
  }

  if (message.method === "item/fileChange/requestApproval") {
    return {
      id: approvalRequestKey(message.id),
      kind: "file_change",
      threadId: getString(params, "threadId"),
      turnId: getString(params, "turnId"),
      itemId: getString(params, "itemId"),
      startedAtMs: getNumber(params, "startedAtMs"),
      reason: getString(params, "reason") ?? null,
      grantRoot: getString(params, "grantRoot") ?? null,
      decisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
  }

  return null;
}

function parseCommandDecisions(value: unknown): CodexApprovalDecision[] {
  if (!Array.isArray(value)) {
    return ["accept", "acceptForSession", "decline", "cancel"];
  }
  const decisions = value.filter(isCodexApprovalDecision);
  return decisions.length ? decisions : ["accept", "acceptForSession", "decline", "cancel"];
}

function isCodexApprovalDecision(value: unknown): value is CodexApprovalDecision {
  if (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  ) {
    return true;
  }
  const record = asRecord(value);
  return Boolean(record?.acceptWithExecpolicyAmendment || record?.applyNetworkPolicyAmendment);
}

function parseCodexThreads(value: unknown): CodexThread[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const thread = parseCodexThread(item);
    return thread ? [thread] : [];
  });
}

function parseThreadSearchResults(value: unknown): CodexThreadSearchResultItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const thread = parseCodexThread(record?.thread);
    if (!thread) {
      return [];
    }
    return [
      {
        thread,
        snippet: getString(record, "snippet"),
      },
    ];
  });
}

function parseCodexThread(value: unknown): CodexThread | null {
  const record = asRecord(value);
  const id = getString(record, "id");
  const cwd = getString(record, "cwd");
  if (!id || !cwd) {
    return null;
  }
  return {
    id,
    cwd,
    sessionId: getString(record, "sessionId"),
    name: getNullableString(record, "name"),
    preview: getString(record, "preview"),
    createdAt: getNumber(record, "createdAt"),
    updatedAt: getNumber(record, "updatedAt"),
    source: record?.source,
    status: record?.status,
    path: getNullableString(record, "path"),
    cliVersion: getString(record, "cliVersion"),
  };
}

function parseThreadTurns(value: unknown): CodexThreadTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const turn = parseThreadTurn(item);
    return turn ? [turn] : [];
  });
}

function parseThreadTurn(value: unknown): CodexThreadTurn | null {
  const record = asRecord(value);
  const id = getString(record, "id");
  const status = getString(record, "status");
  if (!id || !status) {
    return null;
  }
  return {
    id,
    status,
    startedAt: getNullableNumber(record, "startedAt"),
    completedAt: getNullableNumber(record, "completedAt"),
    durationMs: getNullableNumber(record, "durationMs"),
    items: parseThreadItems(record?.items),
  };
}

function parseThreadItems(value: unknown): CodexThreadItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = parseThreadItem(item);
    return parsed ? [parsed] : [];
  });
}

function parseThreadItem(value: unknown): CodexThreadItem | null {
  const record = asRecord(value);
  const id = getString(record, "id");
  const type = getString(record, "type");
  if (!record || !id || !type) {
    return null;
  }
  return {
    id,
    type,
    text: threadItemText(record, type),
    command: getString(record, "command"),
    cwd: getString(record, "cwd"),
    status: getString(record, "status"),
    exitCode: getNullableNumber(record, "exitCode"),
    durationMs: getNullableNumber(record, "durationMs"),
    files: threadItemFiles(record),
  };
}

function threadItemText(record: Record<string, unknown>, type: string): string | undefined {
  if (type === "userMessage") {
    return userInputText(record.content);
  }
  return getString(record, "text") ?? stringArrayText(record.summary) ?? stringArrayText(record.content);
}

function userInputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((item) => {
    const record = asRecord(item);
    const type = getString(record, "type");
    if (type === "text") {
      const text = getString(record, "text");
      return text ? [text] : [];
    }
    if (type === "localImage") {
      const imagePath = getString(record, "path");
      return imagePath ? [`[image] ${imagePath}`] : ["[image]"];
    }
    if (type === "image") {
      const url = getString(record, "url");
      return url ? [`[image] ${url}`] : ["[image]"];
    }
    if (type === "skill" || type === "mention") {
      const name = getString(record, "name");
      return name ? [`[${type}] ${name}`] : [`[${type}]`];
    }
    return [];
  });
  return cleanJoinedText(parts);
}

function stringArrayText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return cleanJoinedText(value.filter((item): item is string => typeof item === "string"));
}

function cleanJoinedText(parts: string[]): string | undefined {
  const normalized = parts.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return normalized || undefined;
}

function threadItemFiles(record: Record<string, unknown>): string[] | undefined {
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const files = changes.flatMap((change) => {
    const item = asRecord(change);
    const filePath = getString(item, "path");
    return filePath ? [filePath] : [];
  });
  return files.length ? [...new Set(files)] : undefined;
}

function markThreadResumability(
  thread: CodexThread,
  appServerCliVersion: string | undefined,
): CodexThread {
  const unavailableReason = inferThreadUnavailableReason(thread, appServerCliVersion);
  return {
    ...thread,
    resumable: !unavailableReason,
    unavailableReason: unavailableReason ?? undefined,
  };
}

function inferThreadUnavailableReason(
  thread: CodexThread,
  appServerCliVersion: string | undefined,
): string | null {
  const threadFamily = codexVersionFamily(thread.cliVersion);
  const appServerFamily = codexVersionFamily(appServerCliVersion);
  if (threadFamily && appServerFamily && threadFamily !== appServerFamily) {
    return [
      `会话由 Codex ${thread.cliVersion} 创建`,
      `当前服务使用 ${appServerCliVersion}`,
      "请升级 CODEX_BIN 后重试，或发送 /new 在当前项目新建会话",
    ].join("；");
  }
  return null;
}

function codexVersionFamily(value: string | undefined): string | null {
  const match = value?.match(/\b(\d+)\.(\d+)\.\d+\b/u);
  return match ? `${match[1]}.${match[2]}` : null;
}

function parseCodexVersion(value: string | undefined): string | null {
  const match = value?.match(/\b\d+\.\d+\.\d+\b/u);
  return match?.[0] ?? null;
}

function buildThreadStartParams(config: BridgeConfig, input: CodexRunInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    approvalPolicy: config.codexApprovalPolicy,
    approvalsReviewer: "user",
    sandbox: config.codexSandbox,
    ...(config.codexModel ? { model: config.codexModel } : {}),
  };
}

function buildThreadResumeParams(config: BridgeConfig, input: CodexRunInput): Record<string, unknown> {
  return {
    threadId: input.threadId,
    cwd: input.cwd,
    approvalPolicy: config.codexApprovalPolicy,
    approvalsReviewer: "user",
    sandbox: config.codexSandbox,
    ...(config.codexModel ? { model: config.codexModel } : {}),
  };
}

function sandboxModeToPolicy(mode: BridgeConfig["codexSandbox"]): Record<string, unknown> {
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

function extractThreadId(result: unknown): string | undefined {
  return getString(asRecord(asRecord(result)?.thread), "id");
}

function extractTurnId(result: unknown): string | undefined {
  return getString(asRecord(asRecord(result)?.turn), "id");
}

interface SteerAppServerTurnInput {
  text: string;
  getThreadId: () => string | undefined;
  getTurnId: () => string | undefined;
  isTurnCompleted: () => boolean;
  isAborted: () => boolean;
  sendRequest: (method: string, params: unknown) => Promise<unknown>;
}

async function steerAppServerTurn(input: SteerAppServerTurnInput): Promise<void> {
  let lastTransientError: Error | null = null;
  for (const retryDelayMs of appServerSteerRetryDelaysMs) {
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    if (input.isAborted()) {
      throw new Error("Codex turn is no longer running.");
    }
    if (input.isTurnCompleted()) {
      throw new Error("Codex turn has already completed.");
    }
    const threadId = input.getThreadId();
    const turnId = input.getTurnId();
    if (!threadId || !turnId) {
      throw new Error("Codex turn is not steerable.");
    }
    try {
      await input.sendRequest("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [
          {
            type: "text",
            text: input.text,
            text_elements: [],
          },
        ],
      });
      return;
    } catch (error) {
      if (!isNoActiveTurnToSteerError(error)) {
        throw error;
      }
      lastTransientError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastTransientError ?? new Error("Codex turn is not ready to receive steering.");
}

function isNoActiveTurnToSteerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no active turn to steer/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function approvalRequestKey(id: unknown): string {
  return typeof id === "string" || typeof id === "number" ? String(id) : JSON.stringify(id);
}

function formatTurnError(error: unknown): string {
  const record = asRecord(error);
  const message = getString(record, "message");
  if (message) {
    return message;
  }
  return error ? JSON.stringify(error) : "Codex turn failed.";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getNullableString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null | undefined {
  const value = record?.[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function getNumber(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function getNullableNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | null | undefined {
  const value = record?.[key];
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : undefined;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}
