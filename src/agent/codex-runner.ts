import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";

import type { BridgeConfig } from "../config/env.js";
import { readPackageVersion } from "../package-info.js";
import type { Logger } from "../util/logger.js";
import { buildCodexChildEnv } from "./codex-environment.js";

const appServerSteerRetryDelaysMs = [0, 100, 250, 500, 1000, 1500];
const maxUserInputQuestions = 3;
const maxUserInputOptions = 10;
const maxUserInputQuestionIdLength = 128;
const maxUserInputHeaderLength = 64;
const maxUserInputQuestionLength = 1_024;
const maxUserInputOptionLabelLength = 128;
const maxUserInputOptionDescriptionLength = 512;

export interface CodexRunInput {
  prompt: string;
  cwd: string;
  threadId?: string;
  signal?: AbortSignal;
  onProgress?: (update: CodexProgressUpdate) => void | Promise<void>;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  onUserInputRequest?: (
    request: CodexUserInputRequest,
    context: CodexUserInputRequestContext,
  ) => Promise<CodexUserInputResponse>;
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
        execpolicy_amendment: string[];
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action: "allow" | "deny";
          host: string;
        };
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
  networkApprovalContext?: unknown;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
  decisions: CodexApprovalDecision[];
}

export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

export interface CodexUserInputRequest {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
  autoResolutionMs: number | null;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export interface CodexUserInputResponse {
  answers: Record<string, CodexUserInputAnswer>;
}

export interface CodexUserInputRequestContext {
  signal: AbortSignal;
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
    code?: number;
    message?: string;
  };
}

type ApprovalParseResult =
  | { status: "supported"; request: CodexApprovalRequest }
  | { status: "malformed"; message: string }
  | { status: "unsupported" };

type UserInputParseResult =
  | { status: "supported"; request: CodexUserInputRequest }
  | { status: "malformed"; message: string }
  | { status: "not-applicable" };

interface PendingUserInputRequest {
  controller: AbortController;
  threadId: string;
}

type SafeServerRequestResult =
  | { status: "handled"; result: Record<string, unknown> }
  | { status: "malformed"; message: string }
  | { status: "not-applicable" };

type JsonRpcServerResponse =
  | { id: string | number | null; result: unknown }
  | { id: string | number | null; error: { code: number; message: string } };

const knownUnsupportedServerRequestMethods = new Set([
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
]);

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

    const pendingUserInputRequests = new Map<string | number, PendingUserInputRequest>();
    const abortPendingUserInputRequests = () => {
      for (const pending of pendingUserInputRequests.values()) {
        pending.controller.abort();
      }
      pendingUserInputRequests.clear();
    };
    let forceKillTimer: NodeJS.Timeout | null = null;
    const abortChild = () => {
      abortPendingUserInputRequests();
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

    const respondToServerRequest = (response: JsonRpcServerResponse) => {
      try {
        sendJson(response);
      } catch (error) {
        this.logger.warn("Failed to respond to Codex app-server request", error);
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
        this.handleAppServerRequest(
          message,
          input.onApprovalRequest,
          input.onUserInputRequest,
          pendingUserInputRequests,
          input.signal,
          respondToServerRequest,
          (decision) => {
            if (decision === "cancel") {
              approvalCancelled = true;
            }
          },
        );
        return;
      }
      if (isInvalidJsonRpcRequestEnvelope(message)) {
        respondToServerRequest({
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        });
        return;
      }

      if (!isJsonRpcNotification(message)) {
        return;
      }

      if (message.method === "serverRequest/resolved") {
        abortResolvedUserInputRequest(message, pendingUserInputRequests);
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
          abortPendingUserInputRequests();
          rejectPendingRequests(error);
          reject(error);
        });
        child.on("close", (code, signal) => {
          abortPendingUserInputRequests();
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
          version: await readPackageVersion(),
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.rememberAppServerInfo(initializeResult);
      sendJson({ method: "initialized" });

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
    onApprovalRequest: CodexRunInput["onApprovalRequest"],
    onUserInputRequest: CodexRunInput["onUserInputRequest"],
    pendingUserInputRequests: Map<string | number, PendingUserInputRequest>,
    runSignal: AbortSignal | undefined,
    respond: (response: JsonRpcServerResponse) => void,
    onApprovalDecision: (decision: CodexApprovalDecision) => void,
  ): void {
    if (!isRequestId(message.id)) {
      respond({ id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const requestId = message.id;

    const userInput = parseUserInputRequest(message);
    if (userInput.status === "malformed") {
      respond({ id: requestId, error: { code: -32602, message: userInput.message } });
      return;
    }
    if (userInput.status === "supported") {
      if (runSignal?.aborted) {
        return;
      }
      if (!onUserInputRequest) {
        respondUserInputFailure(requestId, respond);
        return;
      }

      const pending: PendingUserInputRequest = {
        controller: new AbortController(),
        threadId: userInput.request.threadId,
      };
      pendingUserInputRequests.get(requestId)?.controller.abort();
      pendingUserInputRequests.set(requestId, pending);
      Promise.resolve()
        .then(() => {
          if (
            pending.controller.signal.aborted ||
            pendingUserInputRequests.get(requestId) !== pending
          ) {
            return undefined;
          }
          return onUserInputRequest(userInput.request, {
            signal: pending.controller.signal,
          });
        })
        .then((response) => {
          if (
            pending.controller.signal.aborted ||
            pendingUserInputRequests.get(requestId) !== pending
          ) {
            return;
          }
          pendingUserInputRequests.delete(requestId);
          const validated = parseUserInputResponse(response, userInput.request);
          if (!validated) {
            this.logger.warn("Codex user input callback returned an invalid response");
            respondUserInputFailure(requestId, respond);
            return;
          }
          respond({ id: requestId, result: validated });
        })
        .catch(() => {
          if (
            pending.controller.signal.aborted ||
            pendingUserInputRequests.get(requestId) !== pending
          ) {
            return;
          }
          pendingUserInputRequests.delete(requestId);
          this.logger.warn("Codex user input callback failed");
          respondUserInputFailure(requestId, respond);
        });
      return;
    }

    const safeRequest = parseSafeServerRequest(message);
    if (safeRequest.status === "handled") {
      respond({ id: requestId, result: safeRequest.result });
      return;
    }
    if (safeRequest.status === "malformed") {
      respond({ id: requestId, error: { code: -32602, message: safeRequest.message } });
      return;
    }

    const parsed = parseApprovalRequest(message);
    if (parsed.status === "unsupported") {
      const knownMethod = knownUnsupportedServerRequestMethods.has(message.method);
      respond({
        id: requestId,
        error: {
          code: knownMethod ? -32000 : -32601,
          message: knownMethod
            ? `Unsupported app-server request method: ${message.method}`
            : `Method not found: ${message.method}`,
        },
      });
      return;
    }
    if (parsed.status === "malformed") {
      respond({ id: requestId, error: { code: -32602, message: parsed.message } });
      return;
    }

    const approval = parsed.request;
    if (approval.decisions.length === 0) {
      onApprovalDecision("cancel");
      respond({ id: requestId, result: { decision: "cancel" } });
      return;
    }

    if (!onApprovalRequest) {
      onApprovalDecision("decline");
      respond({ id: requestId, result: { decision: "decline" } });
      return;
    }

    Promise.resolve()
      .then(() => onApprovalRequest(approval))
      .then((decision) => {
        if (!isCodexApprovalDecision(decision) || !isOfferedDecision(decision, approval.decisions)) {
          this.logger.warn("Codex approval callback returned an unavailable decision; cancelling", {
            requestId: approval.id,
          });
          onApprovalDecision("cancel");
          respond({ id: requestId, result: { decision: "cancel" } });
          return;
        }
        onApprovalDecision(decision);
        respond({ id: requestId, result: { decision } });
      })
      .catch((error: unknown) => {
        this.logger.warn("Codex approval callback failed; cancelling approval request", error);
        onApprovalDecision("cancel");
        respond({ id: requestId, result: { decision: "cancel" } });
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
    const pendingUserInputRequests = new Map<string | number, PendingUserInputRequest>();

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
        this.handleAppServerRequest(
          message,
          undefined,
          undefined,
          pendingUserInputRequests,
          undefined,
          (response) => {
            try {
              sendJson(response);
            } catch (error) {
              this.logger.warn("Failed to respond to Codex app-server request", error);
            }
          },
          () => undefined,
        );
        return;
      }
      if (isInvalidJsonRpcRequestEnvelope(message)) {
        try {
          sendJson({ id: null, error: { code: -32600, message: "Invalid Request" } });
        } catch (error) {
          this.logger.warn("Failed to respond to invalid Codex app-server request", error);
        }
        return;
      }
      if (isJsonRpcNotification(message) && message.method === "serverRequest/resolved") {
        abortResolvedUserInputRequest(message, pendingUserInputRequests);
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
            version: await readPackageVersion(),
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        });
        this.rememberAppServerInfo(initializeResult);
        sendJson({ method: "initialized" });
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
    return asObjectRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function isJsonRpcRequest(message: Record<string, unknown>): message is JsonRpcRequest {
  return "id" in message && typeof message.method === "string";
}

function isInvalidJsonRpcRequestEnvelope(message: Record<string, unknown>): boolean {
  return "id" in message && "method" in message;
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

function parseUserInputRequest(message: JsonRpcRequest): UserInputParseResult {
  if (message.method !== "item/tool/requestUserInput") {
    return { status: "not-applicable" };
  }

  const params = asObjectRecord(message.params);
  if (
    !params ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    !Array.isArray(params.questions) ||
    params.questions.length > maxUserInputQuestions
  ) {
    return { status: "malformed", message: "Invalid params: malformed user input request" };
  }

  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== undefined &&
    autoResolutionMs !== null &&
    (typeof autoResolutionMs !== "number" ||
      !Number.isSafeInteger(autoResolutionMs) ||
      autoResolutionMs < 0)
  ) {
    return { status: "malformed", message: "Invalid params: malformed user input request" };
  }

  const questions: CodexUserInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const value of params.questions) {
    const question = asObjectRecord(value);
    if (
      !question ||
      typeof question.id !== "string" ||
      question.id.length === 0 ||
      question.id.length > maxUserInputQuestionIdLength ||
      typeof question.header !== "string" ||
      question.header.length > maxUserInputHeaderLength ||
      typeof question.question !== "string" ||
      question.question.length > maxUserInputQuestionLength ||
      (question.isOther !== undefined && typeof question.isOther !== "boolean") ||
      (question.isSecret !== undefined && typeof question.isSecret !== "boolean") ||
      questionIds.has(question.id)
    ) {
      return { status: "malformed", message: "Invalid params: malformed user input request" };
    }

    let options: CodexUserInputOption[] | null = null;
    if (question.options !== undefined && question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length > maxUserInputOptions) {
        return { status: "malformed", message: "Invalid params: malformed user input request" };
      }
      options = [];
      for (const value of question.options) {
        const option = asObjectRecord(value);
        if (
          !option ||
          typeof option.label !== "string" ||
          option.label.length > maxUserInputOptionLabelLength ||
          typeof option.description !== "string" ||
          option.description.length > maxUserInputOptionDescriptionLength
        ) {
          return { status: "malformed", message: "Invalid params: malformed user input request" };
        }
        options.push({ label: option.label, description: option.description });
      }
    }

    questionIds.add(question.id);
    questions.push({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther ?? false,
      isSecret: question.isSecret ?? false,
      options,
    });
  }

  return {
    status: "supported",
    request: {
      id: randomUUID(),
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      questions,
      autoResolutionMs: autoResolutionMs ?? null,
    },
  };
}

function parseUserInputResponse(
  value: unknown,
  request: CodexUserInputRequest,
): CodexUserInputResponse | null {
  const response = asPlainObjectRecord(value);
  const rawAnswers = asPlainObjectRecord(response?.answers);
  if (!response || !rawAnswers) {
    return null;
  }

  const questionIds = new Set(request.questions.map((question) => question.id));
  const answers: Array<[string, CodexUserInputAnswer]> = [];
  for (const [questionId, value] of Object.entries(rawAnswers)) {
    const answer = asPlainObjectRecord(value);
    if (
      !questionIds.has(questionId) ||
      !answer ||
      !Array.isArray(answer.answers) ||
      !answer.answers.every((item) => typeof item === "string")
    ) {
      return null;
    }
    answers.push([questionId, { answers: [...answer.answers] }]);
  }

  return { answers: Object.fromEntries(answers) };
}

function respondUserInputFailure(
  requestId: string | number,
  respond: (response: JsonRpcServerResponse) => void,
): void {
  respond({
    id: requestId,
    error: { code: -32000, message: "User input request failed." },
  });
}

function abortResolvedUserInputRequest(
  notification: JsonRpcNotification,
  pendingUserInputRequests: Map<string | number, PendingUserInputRequest>,
): void {
  const params = asObjectRecord(notification.params);
  const requestId = params?.requestId;
  const threadId = getString(params, "threadId");
  if (!isRequestId(requestId) || threadId === undefined) {
    return;
  }
  const pending = pendingUserInputRequests.get(requestId);
  if (!pending || pending.threadId !== threadId) {
    return;
  }
  pendingUserInputRequests.delete(requestId);
  pending.controller.abort();
}

function parseSafeServerRequest(message: JsonRpcRequest): SafeServerRequestResult {
  if (message.method === "mcpServer/elicitation/request") {
    const params = asObjectRecord(message.params);
    if (!params || !isValidMcpElicitationParams(params)) {
      return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
    }
    return { status: "handled", result: { action: "cancel", content: null } };
  }

  if (message.method === "item/permissions/requestApproval") {
    const params = asObjectRecord(message.params);
    if (!params || !isValidPermissionsApprovalParams(params)) {
      return { status: "malformed", message: "Invalid params: malformed permission approval" };
    }
    return { status: "handled", result: { permissions: {}, scope: "turn" } };
  }

  return { status: "not-applicable" };
}

function isValidMcpElicitationParams(params: Record<string, unknown>): boolean {
  if (
    typeof params.serverName !== "string" ||
    typeof params.threadId !== "string" ||
    !isOptionalNullableString(params.turnId) ||
    typeof params.message !== "string" ||
    typeof params.mode !== "string"
  ) {
    return false;
  }
  if (params.mode === "form" || params.mode === "openai/form") {
    return Object.hasOwn(params, "requestedSchema");
  }
  return (
    params.mode === "url" &&
    typeof params.elicitationId === "string" &&
    typeof params.url === "string"
  );
}

function isValidPermissionsApprovalParams(params: Record<string, unknown>): boolean {
  return (
    typeof params.cwd === "string" &&
    typeof params.itemId === "string" &&
    isRequestPermissionProfile(params.permissions) &&
    typeof params.startedAtMs === "number" &&
    Number.isInteger(params.startedAtMs) &&
    typeof params.threadId === "string" &&
    typeof params.turnId === "string" &&
    isOptionalNullableString(params.environmentId) &&
    isOptionalNullableString(params.reason)
  );
}

function parseApprovalRequest(message: JsonRpcRequest): ApprovalParseResult {
  if (
    message.method !== "item/commandExecution/requestApproval" &&
    message.method !== "item/fileChange/requestApproval"
  ) {
    return { status: "unsupported" };
  }

  const params = asObjectRecord(message.params);
  if (!params) {
    return { status: "malformed", message: "Invalid params: expected an object" };
  }
  const threadId = getString(params, "threadId");
  const turnId = getString(params, "turnId");
  const itemId = getString(params, "itemId");
  const startedAtMs = getNumber(params, "startedAtMs");
  if (
    threadId === undefined ||
    turnId === undefined ||
    itemId === undefined ||
    startedAtMs === undefined ||
    !Number.isInteger(startedAtMs)
  ) {
    return {
      status: "malformed",
      message: "Invalid params: threadId, turnId, itemId, and integer startedAtMs are required",
    };
  }

  if (message.method === "item/commandExecution/requestApproval") {
    if (!hasValidCommandApprovalOptionalParams(params)) {
      return {
        status: "malformed",
        message: "Invalid params: command approval fields do not match the protocol schema",
      };
    }
    const decisions = parseCommandDecisions(params.availableDecisions);
    if (!decisions) {
      return {
        status: "malformed",
        message: "Invalid params: availableDecisions contains an unsupported decision",
      };
    }
    return {
      status: "supported",
      request: {
        id: randomUUID(),
        kind: "command",
        threadId,
        turnId,
        itemId,
        approvalId: getString(params, "approvalId") ?? null,
        startedAtMs,
        reason: getString(params, "reason") ?? null,
        command: getString(params, "command") ?? null,
        cwd: getString(params, "cwd") ?? null,
        commandActions: Array.isArray(params.commandActions) ? params.commandActions : undefined,
        additionalPermissions: params.additionalPermissions,
        networkApprovalContext: params.networkApprovalContext,
        proposedExecpolicyAmendment: Array.isArray(params.proposedExecpolicyAmendment)
          ? params.proposedExecpolicyAmendment
          : undefined,
        proposedNetworkPolicyAmendments: Array.isArray(params.proposedNetworkPolicyAmendments)
          ? params.proposedNetworkPolicyAmendments
          : undefined,
        decisions,
      },
    };
  }

  if (!hasValidFileChangeApprovalOptionalParams(params)) {
    return {
      status: "malformed",
      message: "Invalid params: file-change approval fields do not match the protocol schema",
    };
  }
  return {
    status: "supported",
    request: {
      id: randomUUID(),
      kind: "file_change",
      threadId,
      turnId,
      itemId,
      startedAtMs,
      reason: getString(params, "reason") ?? null,
      grantRoot: getString(params, "grantRoot") ?? null,
      decisions: ["decline", "cancel"],
    },
  };
}

function parseCommandDecisions(value: unknown): CodexApprovalDecision[] | null {
  if (value === undefined || value === null) {
    return ["decline", "cancel"];
  }
  if (!Array.isArray(value) || !value.every(isCodexApprovalDecision)) {
    return null;
  }
  return value;
}

function hasValidCommandApprovalOptionalParams(params: Record<string, unknown>): boolean {
  return (
    isOptionalNullableString(params.approvalId) &&
    isOptionalNullableString(params.command) &&
    isOptionalNullableString(params.cwd) &&
    isOptionalNullableString(params.environmentId) &&
    isOptionalNullableString(params.reason) &&
    isOptionalNullableCommandActions(params.commandActions) &&
    isOptionalNullablePermissionProfile(params.additionalPermissions) &&
    isOptionalNullableNetworkApprovalContext(params.networkApprovalContext) &&
    isOptionalNullableStringArray(params.proposedExecpolicyAmendment) &&
    isOptionalNullableNetworkPolicyArray(params.proposedNetworkPolicyAmendments)
  );
}

function hasValidFileChangeApprovalOptionalParams(params: Record<string, unknown>): boolean {
  return isOptionalNullableString(params.grantRoot) && isOptionalNullableString(params.reason);
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isOptionalNullableCommandActions(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every(isCommandAction))
  );
}

function isCommandAction(value: unknown): boolean {
  const action = asObjectRecord(value);
  if (!action || typeof action.command !== "string") {
    return false;
  }
  if (action.type === "read") {
    return typeof action.name === "string" && typeof action.path === "string";
  }
  if (action.type === "listFiles") {
    return isOptionalNullableString(action.path);
  }
  if (action.type === "search") {
    return isOptionalNullableString(action.path) && isOptionalNullableString(action.query);
  }
  return action.type === "unknown";
}

function isOptionalNullablePermissionProfile(value: unknown): boolean {
  return value === undefined || value === null || isAdditionalPermissionProfile(value);
}

function isAdditionalPermissionProfile(value: unknown): boolean {
  const profile = asObjectRecord(value);
  return Boolean(
    profile &&
      isOptionalNullableFileSystemPermissions(profile.fileSystem) &&
      isOptionalNullableNetworkPermissions(profile.network),
  );
}

function isRequestPermissionProfile(value: unknown): boolean {
  const profile = asObjectRecord(value);
  return Boolean(
    profile &&
      Object.keys(profile).every((key) => key === "fileSystem" || key === "network") &&
      isOptionalNullableFileSystemPermissions(profile.fileSystem) &&
      isOptionalNullableNetworkPermissions(profile.network),
  );
}

function isOptionalNullableFileSystemPermissions(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  const permissions = asObjectRecord(value);
  return Boolean(
    permissions &&
      (permissions.entries === undefined ||
        permissions.entries === null ||
        (Array.isArray(permissions.entries) &&
          permissions.entries.every(isFileSystemSandboxEntry))) &&
      (permissions.globScanMaxDepth === undefined ||
        permissions.globScanMaxDepth === null ||
        (typeof permissions.globScanMaxDepth === "number" &&
          Number.isInteger(permissions.globScanMaxDepth) &&
          permissions.globScanMaxDepth >= 1)) &&
      isOptionalNullableStringArray(permissions.read) &&
      isOptionalNullableStringArray(permissions.write),
  );
}

function isFileSystemSandboxEntry(value: unknown): boolean {
  const entry = asObjectRecord(value);
  return Boolean(
    entry &&
      (entry.access === "read" || entry.access === "write" || entry.access === "deny") &&
      isFileSystemPath(entry.path),
  );
}

function isFileSystemPath(value: unknown): boolean {
  const filePath = asObjectRecord(value);
  if (!filePath) {
    return false;
  }
  if (filePath.type === "path") {
    return typeof filePath.path === "string";
  }
  if (filePath.type === "glob_pattern") {
    return typeof filePath.pattern === "string";
  }
  return filePath.type === "special" && isFileSystemSpecialPath(filePath.value);
}

function isFileSystemSpecialPath(value: unknown): boolean {
  const special = asObjectRecord(value);
  if (!special || !isOptionalNullableString(special.subpath)) {
    return false;
  }
  if (
    special.kind === "root" ||
    special.kind === "minimal" ||
    special.kind === "project_roots" ||
    special.kind === "tmpdir" ||
    special.kind === "slash_tmp"
  ) {
    return true;
  }
  return special.kind === "unknown" && typeof special.path === "string";
}

function isOptionalNullableNetworkPermissions(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  const permissions = asObjectRecord(value);
  return Boolean(
    permissions &&
      (permissions.enabled === undefined ||
        permissions.enabled === null ||
        typeof permissions.enabled === "boolean"),
  );
}

function isOptionalNullableNetworkApprovalContext(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  const context = asObjectRecord(value);
  return Boolean(
    context &&
      typeof context.host === "string" &&
      (context.protocol === "http" ||
        context.protocol === "https" ||
        context.protocol === "socks5Tcp" ||
        context.protocol === "socks5Udp"),
  );
}

function isOptionalNullableNetworkPolicyArray(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every(isNetworkPolicyAmendment))
  );
}

function isNetworkPolicyAmendment(value: unknown): boolean {
  const policy = asObjectRecord(value);
  return Boolean(
    policy &&
      (policy.action === "allow" || policy.action === "deny") &&
      typeof policy.host === "string",
  );
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
  const record = asObjectRecord(value);
  if (!record || Object.keys(record).length !== 1) {
    return false;
  }
  if ("acceptWithExecpolicyAmendment" in record) {
    const amendment = asObjectRecord(record.acceptWithExecpolicyAmendment);
    return Boolean(
      amendment &&
        Array.isArray(amendment.execpolicy_amendment) &&
        amendment.execpolicy_amendment.every((part) => typeof part === "string"),
    );
  }
  if ("applyNetworkPolicyAmendment" in record) {
    const amendment = asObjectRecord(record.applyNetworkPolicyAmendment);
    return Boolean(amendment && isNetworkPolicyAmendment(amendment.network_policy_amendment));
  }
  return false;
}

function isOfferedDecision(
  decision: CodexApprovalDecision,
  offered: CodexApprovalDecision[],
): boolean {
  return offered.some((candidate) => isDeepStrictEqual(candidate, decision));
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

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
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

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPlainObjectRecord(value: unknown): Record<string, unknown> | null {
  const record = asObjectRecord(value);
  if (!record) {
    return null;
  }
  const prototype = Object.getPrototypeOf(record) as unknown;
  return prototype === Object.prototype || prototype === null ? record : null;
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
