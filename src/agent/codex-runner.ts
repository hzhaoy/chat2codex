import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

import type { BridgeConfig } from "../config/env.js";
import { readBundledProtocolManifest, readPackageVersion } from "../package-info.js";
import type { Logger } from "../util/logger.js";
import { buildCodexChildEnv } from "./codex-environment.js";
import {
  hasStableIdentity,
  identitiesIntersect,
  identityKeys,
  type SenderIdentity,
} from "../core/identity.js";

const appServerSteerRetryDelaysMs = [0, 100, 250, 500, 1000, 1500];
const maxUserInputQuestions = 3;
const maxUserInputOptions = 10;
const maxUserInputQuestionIdLength = 128;
const maxUserInputHeaderLength = 64;
const maxUserInputQuestionLength = 1_024;
const maxUserInputOptionLabelLength = 128;
const maxUserInputOptionDescriptionLength = 512;
const maxInteractiveIdentityLength = 256;
const maxInteractiveMessageLength = 4_096;
const maxMcpFormFields = 32;
const maxMcpFieldNameLength = 128;
const maxMcpFieldTextLength = 1_024;
const maxMcpStringValueLength = 4_096;
const maxMcpEnumOptions = 50;
const maxMcpEnumValueLength = 256;
const maxMcpUrlLength = 2_048;
const maxPermissionEntries = 64;
const maxPermissionPathLength = 4_096;
const maxPermissionGlobDepth = 128;
const serverRequestCallbackGraceMs = 25;
const maxServerRequestTombstones = 256;
const serverRequestTombstoneTtlMs = 5 * 60 * 1000;
const maxChangedFiles = 200;
const maxChangedFilePathChars = 4_096;
const minAppServerJsonLineBytes = 256 * 1_024;
const maxAppServerJsonLineBytes = 8 * 1_024 * 1_024;
const truncationMarker = "\n... [truncated]";

class CodexAppServerExitError extends Error {
  constructor() {
    super("Codex app-server exited before responding.");
    this.name = "CodexAppServerExitError";
  }
}

class CodexSessionStartupExitError extends Error {
  constructor(
    readonly threadId: string | undefined,
    cause: CodexAppServerExitError,
  ) {
    super(cause.message, { cause });
    this.name = "CodexSessionStartupExitError";
  }
}

export interface CodexRunInput {
  prompt: string;
  cwd: string;
  threadId?: string;
  collaborationMode?: CodexCollaborationMode;
  sessionScope?: CodexSessionScope;
  onThreadBound?: (threadId: string) => void | Promise<void>;
  signal?: AbortSignal;
  onProgress?: (update: CodexProgressUpdate) => void | Promise<void>;
  onApprovalRequest?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  onUserInputRequest?: (
    request: CodexUserInputRequest,
    context: CodexUserInputRequestContext,
  ) => Promise<CodexUserInputResponse>;
  onMcpElicitationRequest?: (
    request: CodexMcpElicitationRequest,
    context: CodexServerRequestContext,
  ) => Promise<CodexMcpElicitationResponse>;
  onPermissionApprovalRequest?: (
    request: CodexPermissionApprovalRequest,
    context: CodexServerRequestContext,
  ) => Promise<CodexPermissionApprovalDecision>;
  onRunControl?: (control: CodexRunControl) => void;
}

export type CodexCollaborationMode = "default" | "plan";

export interface CodexSessionScope {
  adapterId?: string;
  chatId: string;
  sessionEpoch: string;
  principal: CodexSessionPrincipal;
}

export type CodexSessionPrincipal = SenderIdentity;

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
  tokenUsage?: CodexThreadTokenUsage;
  diff?: string;
  diffStat?: string;
  changedFiles: string[];
  fileChangeCount: number;
  commands: CodexCommandSummary[];
}

export interface CodexTokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexThreadTokenUsage {
  last: CodexTokenUsageBreakdown;
  total: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
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

export interface CodexServerRequestContext {
  signal: AbortSignal;
}

export interface CodexMcpElicitationOption {
  value: string;
  title: string;
}

interface CodexMcpElicitationFieldBase {
  name: string;
  title: string | null;
  description: string | null;
  required: boolean;
}

export type CodexMcpElicitationField =
  | (CodexMcpElicitationFieldBase & {
      type: "string";
      default: string | null;
      format: "email" | "uri" | "date" | "date-time" | null;
      minLength: number | null;
      maxLength: number | null;
    })
  | (CodexMcpElicitationFieldBase & {
      type: "number";
      default: number | null;
      minimum: number | null;
      maximum: number | null;
    })
  | (CodexMcpElicitationFieldBase & {
      type: "integer";
      default: number | null;
      minimum: number | null;
      maximum: number | null;
    })
  | (CodexMcpElicitationFieldBase & {
      type: "boolean";
      default: boolean | null;
    })
  | (CodexMcpElicitationFieldBase & {
      type: "enum";
      default: string | null;
      options: CodexMcpElicitationOption[];
    })
  | (CodexMcpElicitationFieldBase & {
      type: "multi_select";
      default: string[] | null;
      options: CodexMcpElicitationOption[];
      minItems: number | null;
      maxItems: number | null;
    });

interface CodexMcpElicitationRequestBase {
  id: string;
  serverName: string;
  threadId: string;
  turnId: string | null;
  message: string;
}

export type CodexMcpElicitationRequest =
  | (CodexMcpElicitationRequestBase & {
      mode: "form";
      fields: CodexMcpElicitationField[];
    })
  | (CodexMcpElicitationRequestBase & {
      mode: "url";
      elicitationId: string;
      url: string;
    });

export type CodexMcpElicitationValue = string | number | boolean | string[];
export type CodexMcpElicitationResponse =
  | {
      action: "accept";
      content?: Record<string, CodexMcpElicitationValue> | null;
    }
  | { action: "decline" | "cancel" };

export type CodexFileSystemSpecialPath =
  | { kind: "root" | "minimal" | "tmpdir" | "slash_tmp" }
  | { kind: "project_roots"; subpath?: string | null }
  | { kind: "unknown"; path: string; subpath?: string | null };

export type CodexFileSystemPath =
  | { type: "path"; path: string }
  | { type: "glob_pattern"; pattern: string }
  | { type: "special"; value: CodexFileSystemSpecialPath };

export interface CodexFileSystemPermissionEntry {
  access: "read" | "write" | "deny";
  path: CodexFileSystemPath;
}

export interface CodexAdditionalFileSystemPermissions {
  entries?: CodexFileSystemPermissionEntry[] | null;
  globScanMaxDepth?: number | null;
  read?: string[] | null;
  write?: string[] | null;
}

export interface CodexPermissionProfile {
  fileSystem?: CodexAdditionalFileSystemPermissions | null;
  network?: { enabled?: boolean | null } | null;
}

export interface CodexPermissionApprovalRequest {
  id: string;
  cwd: string;
  itemId: string;
  permissions: CodexPermissionProfile;
  startedAtMs: number;
  threadId: string;
  turnId: string;
  environmentId: string | null;
  reason: string | null;
}

export type CodexPermissionApprovalDecision = "deny" | "grantTurn" | "grantSession";

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
  lastTurnId?: string;
}

interface AppServerRequestOptions {
  requiredCliVersion?: string;
  capabilityLabel?: string;
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

type McpElicitationParseResult =
  | { status: "supported"; request: CodexMcpElicitationRequest }
  | { status: "safe-cancel" }
  | { status: "malformed"; message: string }
  | { status: "not-applicable" };

type PermissionApprovalParseResult =
  | { status: "supported"; request: CodexPermissionApprovalRequest }
  | { status: "malformed"; message: string }
  | { status: "not-applicable" };

interface PendingInteractiveRequest {
  controller: AbortController;
  threadId: string;
}

interface BoundedCommandOutput {
  text: string;
  bytes: number;
  truncated: boolean;
}

interface CommandOutputBufferState {
  buffers: Map<string, BoundedCommandOutput>;
  totalBytes: number;
}

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
  private readonly sessionsByChat = new Map<string, CodexAppServerSession>();
  private readonly ownerByThread = new Map<string, CodexAppServerSession>();
  private readonly sessionExpiryTimers = new Map<CodexAppServerSession, NodeJS.Timeout>();
  private readonly singleUseChildren = new Set<ChildProcessWithoutNullStreams>();
  private sessionMutationTail: Promise<void> = Promise.resolve();
  private disposed = false;

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
    let requestOptions: AppServerRequestOptions | undefined;
    if (input.lastTurnId) {
      const manifest = await readBundledProtocolManifest();
      const requiredCliVersion = parseCodexVersion(manifest.codexVersion);
      if (!requiredCliVersion) {
        throw new Error(
          "Cannot verify historical-turn fork compatibility: the bundled protocol manifest has no parseable Codex version.",
        );
      }
      requestOptions = {
        requiredCliVersion,
        capabilityLabel: "Historical-turn fork",
      };
    }
    const result = await this.requestAppServer("thread/fork", {
      threadId: input.threadId,
      excludeTurns: true,
      cwd: input.cwd ?? null,
      approvalPolicy: this.config.codexApprovalPolicy,
      approvalsReviewer: "user",
      sandbox: this.config.codexSandbox,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
      ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
    }, requestOptions);
    const thread = parseCodexThread(asRecord(result)?.thread);
    if (!thread) {
      throw new Error("Codex app-server did not return a forked thread.");
    }
    return markThreadResumability(thread, this.appServerCliVersion);
  }

  async compactThread(threadId: string): Promise<void> {
    await this.requestAppServer("thread/compact/start", { threadId });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.requestAppServer("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<CodexThread> {
    const result = await this.requestAppServer("thread/unarchive", { threadId });
    const thread = parseCodexThread(asRecord(result)?.thread);
    if (!thread) {
      throw new Error("Codex app-server did not return the unarchived thread.");
    }
    return markThreadResumability(thread, this.appServerCliVersion);
  }

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    if (this.disposed) {
      throw new Error("Codex session manager is disposed.");
    }
    if (input.signal?.aborted) {
      return cancelledRunResult(input.threadId);
    }
    if (!isReusableSessionScope(input.sessionScope)) {
      return this.runSingleUse(input);
    }
    let cwdKey: string;
    try {
      cwdKey = await realpath(input.cwd);
    } catch (error) {
      this.logger.warn("Codex session cwd could not be canonicalized; using a single-use process", {
        cwd: input.cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.runSingleUse(input);
    }

    return this.runReusable(input, cwdKey, true);
  }

  private async runReusable(
    input: CodexRunInput,
    cwdKey: string,
    allowStartupRetry: boolean,
  ): Promise<CodexRunResult> {
    let runPromise!: Promise<CodexRunResult>;
    await this.mutateSessions(async () => {
      if (this.disposed) {
        throw new Error("Codex session manager is disposed.");
      }
      await this.evictExpiredSessions();
      const descriptor = createSessionDescriptor(this.config, input.sessionScope!, cwdKey, input.threadId);
      let session = this.sessionsByChat.get(descriptor.scope.chatId);
      if (session && !session.matches(descriptor)) {
        if (session.isActive()) {
          throw new Error("The current Codex chat session is still running and cannot be rotated.");
        }
        await this.removeSession(session, "scope_changed");
        session = undefined;
      }

      if (session && session.isActive()) {
        throw new Error("The Codex app-server session already has an active turn.");
      }

      if (!session) {
        if (input.threadId) {
          const owner = this.ownerByThread.get(input.threadId);
          if (owner) {
            if (owner.isActive()) {
              throw new Error("The requested Codex thread already has an active app-server session.");
            }
            await this.removeSession(owner, "thread_owner_transferred");
          }
        }
        await this.ensureSessionCapacity();
        session = this.createSession(descriptor);
      }

      runPromise = session.run(input);
    });
    try {
      return await runPromise;
    } catch (error) {
      if (
        allowStartupRetry &&
        error instanceof CodexSessionStartupExitError &&
        !input.signal?.aborted &&
        !this.disposed
      ) {
        const threadId = error.threadId ?? input.threadId;
        this.logger.warn(
          "Reusable Codex app-server exited before turn submission; retrying once",
          {
            chatId: input.sessionScope?.chatId,
            threadId,
          },
        );
        return this.runReusable(
          {
            ...input,
            ...(threadId ? { threadId } : {}),
          },
          cwdKey,
          false,
        );
      }
      throw error;
    }
  }

  async invalidateChatSession(chatId: string, reason = "chat_invalidated"): Promise<void> {
    await this.mutateSessions(async () => {
      const session = this.sessionsByChat.get(chatId);
      if (session) {
        await this.removeSession(session, reason);
      }
    });
  }

  async dispose(): Promise<void> {
    await this.mutateSessions(async () => {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      const sessions = [...this.sessionsByChat.values()];
      const singleUseChildren = [...this.singleUseChildren];
      this.sessionsByChat.clear();
      this.ownerByThread.clear();
      await Promise.all([
        ...sessions.map((session) => session.close("manager_disposed")),
        ...singleUseChildren.map((child) => stopChildProcess(child)),
      ]);
    });
  }

  private async runSingleUse(input: CodexRunInput): Promise<CodexRunResult> {
    if (this.disposed) {
      throw new Error("Codex session manager is disposed.");
    }
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
    this.singleUseChildren.add(child);
    child.once("close", () => {
      this.singleUseChildren.delete(child);
    });

    const pendingInteractiveRequests = new Map<string | number, PendingInteractiveRequest>();
    const abortPendingInteractiveRequests = () => {
      for (const pending of pendingInteractiveRequests.values()) {
        pending.controller.abort();
      }
      pendingInteractiveRequests.clear();
    };
    let forceKillTimer: NodeJS.Timeout | null = null;
    const abortChild = () => {
      abortPendingInteractiveRequests();
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
    let requestSeq = 0;
    let activeTurnId: string | undefined;
    let turnCompleted = false;
    let turnError: string | null = null;
    let approvalCancelled = false;
    const summary = createEmptyRunSummary();
    const commandOutputBuffers: CommandOutputBufferState = {
      buffers: new Map(),
      totalBytes: 0,
    };
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

    const stderrCollector = createBoundedUtf8Collector(
      child.stderr,
      this.config.codexStderrMaxBytes,
    );
    const stdoutReader = createBoundedLineReader(
      child.stdout,
      appServerJsonLineLimit(this.config),
      (line) => {
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
          input.onMcpElicitationRequest,
          input.onPermissionApprovalRequest,
          pendingInteractiveRequests,
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
        abortResolvedInteractiveRequest(message, pendingInteractiveRequests);
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
          turnError = truncateTextChars(
            formatTurnError(turn?.error),
            this.config.chatOutputMaxChars,
          );
        }
      }
      if (
        message.method === "thread/tokenUsage/updated" &&
        getString(message.params, "threadId") === threadId &&
        (!activeTurnId || getString(message.params, "turnId") === activeTurnId)
      ) {
        const tokenUsage = parseThreadTokenUsage(message.params?.tokenUsage);
        if (tokenUsage) {
          summary.tokenUsage = tokenUsage;
        }
      }
      if (message.method === "error") {
        if (message.params?.willRetry !== true) {
          turnError = truncateTextChars(
            getString(asRecord(message.params?.error), "message") ??
              "Codex reported an error.",
            this.config.chatOutputMaxChars,
          );
        }
        this.logger.warn("Codex emitted an error notification", message);
      }
      if (message.method === "item/completed") {
        const item = asRecord(message.params?.item);
        if (getString(item, "type") === "agentMessage") {
          const text = getString(item, "text");
          if (text && /\S/u.test(text) && getString(item, "phase") !== "commentary") {
            finalText = truncateTextChars(text, this.config.chatOutputMaxChars);
          }
        }
        recordCompletedItem(
          summary,
          item,
          commandOutputBuffers,
          this.config.runLogMaxCommands,
          this.config.runLogMaxBytes,
        );
      }
      if (message.method === "turn/diff/updated") {
        const diff = getString(message.params, "diff");
        if (diff !== undefined) {
          const boundedDiff = truncateTextChars(diff, this.config.runDiffMaxChars);
          summary.diff = boundedDiff;
          summary.diffStat = summarizeUnifiedDiff(boundedDiff);
          addChangedFiles(summary, filesFromUnifiedDiff(boundedDiff));
        }
      }
      if (message.method === "item/commandExecution/outputDelta") {
        const itemId = getString(message.params, "itemId");
        const delta = getString(message.params, "delta");
        if (
          itemId !== undefined &&
          itemId.length <= maxInteractiveIdentityLength &&
          delta !== undefined
        ) {
          appendCommandOutput(
            commandOutputBuffers,
            itemId,
            delta,
            this.config.runLogMaxCommands,
            this.config.runLogMaxBytes,
          );
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
      },
      () => {
        const error = new Error("Codex app-server emitted an oversized JSON line.");
        turnError = error.message;
        this.logger.warn("Discarded an oversized Codex app-server JSON line");
        rejectPendingRequests(error);
        abortChild();
      },
    );

    function rejectPendingRequests(error: Error) {
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    }

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on("error", (error) => {
          abortPendingInteractiveRequests();
          rejectPendingRequests(error);
          reject(error);
        });
        child.on("close", (code, signal) => {
          abortPendingInteractiveRequests();
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
      if (threadId) {
        await input.onThreadBound?.(threadId);
      }

      const collaborationMode = input.collaborationMode
        ? buildCollaborationMode(
            input.collaborationMode,
            this.config.codexModel ??
              requireDefaultModel(await sendRequest("model/list", { includeHidden: false })),
          )
        : undefined;
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
        ...(collaborationMode ? { collaborationMode } : {}),
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
    const stderr = stderrCollector.finish().trim();

    const cancelled = Boolean(input.signal?.aborted || (approvalCancelled && !finalText.trim()));
    if (!finalText.trim()) {
      finalText = cancelled
        ? ""
        : exit.code === 0 && turnCompleted && !turnError
          ? "(Codex finished without a final text response.)"
          : [turnError, stderr].filter(Boolean).join("\n");
    }
    finalText = truncateTextChars(finalText.trim(), this.config.chatOutputMaxChars);

    return {
      threadId,
      finalText,
      stderr,
      exitCode: cancelled || (turnCompleted && !turnError) ? 0 : exit.code,
      signal: exit.signal,
      cancelled,
      summary: finalizeRunSummary(
        summary,
        this.config.runLogMaxCommands,
        this.config.runLogMaxBytes,
        this.config.runDiffMaxChars,
      ),
    };
  }

  private createSession(descriptor: CodexSessionDescriptor): CodexAppServerSession {
    const session = new CodexAppServerSession(
      this.config,
      this.logger,
      descriptor,
      {
        handleServerRequest: (message, context, respond) => {
          this.handleAppServerRequest(
            message,
            context.input.onApprovalRequest,
            context.input.onUserInputRequest,
            context.input.onMcpElicitationRequest,
            context.input.onPermissionApprovalRequest,
            context.pendingInteractiveRequests,
            context.input.signal,
            respond,
            (decision) => {
              if (decision === "cancel") {
                context.approvalCancelled = true;
              }
            },
          );
        },
        bindThread: (boundSession, threadId) =>
          this.bindSessionThread(boundSession, threadId),
        onInitialized: (result) => this.rememberAppServerInfo(result),
        onDead: (deadSession) => this.forgetDeadSession(deadSession),
        onIdle: (idleSession) => this.scheduleSessionExpiry(idleSession),
      },
    );
    this.sessionsByChat.set(descriptor.scope.chatId, session);
    if (descriptor.threadId) {
      this.ownerByThread.set(descriptor.threadId, session);
    }
    return session;
  }

  private async bindSessionThread(
    session: CodexAppServerSession,
    threadId: string,
  ): Promise<void> {
    await this.mutateSessions(async () => {
      if (this.sessionsByChat.get(session.chatId) !== session || !session.isHealthy()) {
        throw new Error("The Codex app-server session expired before its thread was bound.");
      }
      const owner = this.ownerByThread.get(threadId);
      if (owner && owner !== session) {
        if (owner.isActive()) {
          throw new Error("The Codex thread is already active in another app-server session.");
        }
        await this.removeSession(owner, "thread_owner_transferred");
      }
      const previousThreadId = session.threadId;
      if (previousThreadId && previousThreadId !== threadId) {
        throw new Error("The Codex app-server session cannot change its bound thread.");
      }
      session.bindThread(threadId);
      this.ownerByThread.set(threadId, session);
    });
  }

  private forgetDeadSession(session: CodexAppServerSession): void {
    if (this.sessionsByChat.get(session.chatId) === session) {
      this.sessionsByChat.delete(session.chatId);
    }
    if (session.threadId && this.ownerByThread.get(session.threadId) === session) {
      this.ownerByThread.delete(session.threadId);
    }
    this.clearSessionExpiry(session);
  }

  private scheduleSessionExpiry(session: CodexAppServerSession): void {
    this.clearSessionExpiry(session);
    const ttlMs = this.config.codexAppServerIdleTtlMs;
    if (ttlMs <= 0 || !session.isHealthy() || session.isActive()) {
      return;
    }
    const timer = setTimeout(() => {
      void this.mutateSessions(async () => {
        if (
          this.sessionsByChat.get(session.chatId) === session &&
          !session.isActive() &&
          Date.now() - session.lastUsedAt >= ttlMs
        ) {
          await this.removeSession(session, "idle_ttl_expired");
        }
      }).catch((error: unknown) => {
        this.logger.warn("Failed to expire an idle Codex app-server session", error);
      });
    }, ttlMs);
    timer.unref?.();
    this.sessionExpiryTimers.set(session, timer);
  }

  private clearSessionExpiry(session: CodexAppServerSession): void {
    const timer = this.sessionExpiryTimers.get(session);
    if (timer) {
      clearTimeout(timer);
      this.sessionExpiryTimers.delete(session);
    }
  }

  private async evictExpiredSessions(): Promise<void> {
    const ttlMs = this.config.codexAppServerIdleTtlMs;
    if (ttlMs <= 0) {
      return;
    }
    const expired = [...this.sessionsByChat.values()].filter(
      (session) => !session.isActive() && Date.now() - session.lastUsedAt >= ttlMs,
    );
    for (const session of expired) {
      await this.removeSession(session, "idle_ttl_expired");
    }
  }

  private async ensureSessionCapacity(): Promise<void> {
    while (this.sessionsByChat.size >= this.config.codexMaxAppServerSessions) {
      const candidate = [...this.sessionsByChat.values()]
        .filter((session) => !session.isActive())
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) {
        throw new Error("All Codex app-server sessions are active; capacity is exhausted.");
      }
      await this.removeSession(candidate, "lru_capacity_eviction");
    }
  }

  private async removeSession(session: CodexAppServerSession, reason: string): Promise<void> {
    if (this.sessionsByChat.get(session.chatId) === session) {
      this.sessionsByChat.delete(session.chatId);
    }
    if (session.threadId && this.ownerByThread.get(session.threadId) === session) {
      this.ownerByThread.delete(session.threadId);
    }
    this.clearSessionExpiry(session);
    await session.close(reason);
  }

  private async mutateSessions<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.sessionMutationTail;
    let release!: () => void;
    this.sessionMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private handleAppServerRequest(
    message: JsonRpcRequest,
    onApprovalRequest: CodexRunInput["onApprovalRequest"],
    onUserInputRequest: CodexRunInput["onUserInputRequest"],
    onMcpElicitationRequest: CodexRunInput["onMcpElicitationRequest"],
    onPermissionApprovalRequest: CodexRunInput["onPermissionApprovalRequest"],
    pendingInteractiveRequests: Map<string | number, PendingInteractiveRequest>,
    runSignal: AbortSignal | undefined,
    respond: (response: JsonRpcServerResponse) => void,
    onApprovalDecision: (decision: CodexApprovalDecision) => void,
  ): void {
    if (!isRequestId(message.id)) {
      respond({ id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const requestId = message.id;
    if (rejectDuplicatePendingRequest(requestId, pendingInteractiveRequests, respond)) {
      return;
    }

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

      const pending: PendingInteractiveRequest = {
        controller: new AbortController(),
        threadId: userInput.request.threadId,
      };
      if (rejectDuplicatePendingRequest(requestId, pendingInteractiveRequests, respond)) {
        return;
      }
      pendingInteractiveRequests.set(requestId, pending);
      deferServerRequestCallback()
        .then(() => {
          if (
            pending.controller.signal.aborted ||
            pendingInteractiveRequests.get(requestId) !== pending
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
            pendingInteractiveRequests.get(requestId) !== pending
          ) {
            return;
          }
          pendingInteractiveRequests.delete(requestId);
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
            pendingInteractiveRequests.get(requestId) !== pending
          ) {
            return;
          }
          pendingInteractiveRequests.delete(requestId);
          this.logger.warn("Codex user input callback failed");
          respondUserInputFailure(requestId, respond);
        });
      return;
    }

    const elicitation = parseMcpElicitationRequest(message);
    if (elicitation.status === "malformed") {
      respond({ id: requestId, error: { code: -32602, message: elicitation.message } });
      return;
    }
    if (elicitation.status === "safe-cancel") {
      respond({ id: requestId, result: cancelledMcpElicitationResponse() });
      return;
    }
    if (elicitation.status === "supported") {
      this.handleMcpElicitationRequest(
        requestId,
        elicitation.request,
        onMcpElicitationRequest,
        pendingInteractiveRequests,
        runSignal,
        respond,
      );
      return;
    }

    const permissionApproval = parsePermissionApprovalRequest(message);
    if (permissionApproval.status === "malformed") {
      respond({ id: requestId, error: { code: -32602, message: permissionApproval.message } });
      return;
    }
    if (permissionApproval.status === "supported") {
      this.handlePermissionApprovalRequest(
        requestId,
        permissionApproval.request,
        onPermissionApprovalRequest,
        pendingInteractiveRequests,
        runSignal,
        respond,
      );
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

    if (runSignal?.aborted) {
      return;
    }
    const pending: PendingInteractiveRequest = {
      controller: new AbortController(),
      threadId: approval.threadId ?? "",
    };
    pendingInteractiveRequests.set(requestId, pending);
    deferServerRequestCallback()
      .then(() => {
        if (
          pending.controller.signal.aborted ||
          pendingInteractiveRequests.get(requestId) !== pending
        ) {
          return undefined;
        }
        return onApprovalRequest(approval);
      })
      .then((decision) => {
        if (
          decision === undefined ||
          pending.controller.signal.aborted ||
          pendingInteractiveRequests.get(requestId) !== pending
        ) {
          return;
        }
        pendingInteractiveRequests.delete(requestId);
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
        if (
          pending.controller.signal.aborted ||
          pendingInteractiveRequests.get(requestId) !== pending
        ) {
          return;
        }
        pendingInteractiveRequests.delete(requestId);
        this.logger.warn("Codex approval callback failed; cancelling approval request", error);
        onApprovalDecision("cancel");
        respond({ id: requestId, result: { decision: "cancel" } });
      });
  }

  private handleMcpElicitationRequest(
    requestId: string | number,
    request: CodexMcpElicitationRequest,
    callback: CodexRunInput["onMcpElicitationRequest"],
    pendingRequests: Map<string | number, PendingInteractiveRequest>,
    runSignal: AbortSignal | undefined,
    respond: (response: JsonRpcServerResponse) => void,
  ): void {
    if (runSignal?.aborted) {
      return;
    }
    if (!callback) {
      respond({ id: requestId, result: cancelledMcpElicitationResponse() });
      return;
    }
    if (rejectDuplicatePendingRequest(requestId, pendingRequests, respond)) {
      return;
    }

    // Validation always uses a private snapshot. The callback receives a separate clone so
    // UI code cannot weaken `required`, add enum options, or change modes before validation.
    const validationRequest = cloneMcpElicitationRequest(request);
    const callbackRequest = cloneMcpElicitationRequest(validationRequest);
    const pending: PendingInteractiveRequest = {
      controller: new AbortController(),
      threadId: request.threadId,
    };
    pendingRequests.set(requestId, pending);
    deferServerRequestCallback()
      .then(() => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return undefined;
        }
        return callback(callbackRequest, { signal: pending.controller.signal });
      })
      .then((response) => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return;
        }
        pendingRequests.delete(requestId);
        const validated = parseMcpElicitationResponse(response, validationRequest);
        if (!validated) {
          this.logger.warn("Codex MCP elicitation callback returned an invalid response; cancelling");
          respond({ id: requestId, result: cancelledMcpElicitationResponse() });
          return;
        }
        respond({ id: requestId, result: validated });
      })
      .catch(() => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return;
        }
        pendingRequests.delete(requestId);
        this.logger.warn("Codex MCP elicitation callback failed; cancelling");
        respond({ id: requestId, result: cancelledMcpElicitationResponse() });
      });
  }

  private handlePermissionApprovalRequest(
    requestId: string | number,
    request: CodexPermissionApprovalRequest,
    callback: CodexRunInput["onPermissionApprovalRequest"],
    pendingRequests: Map<string | number, PendingInteractiveRequest>,
    runSignal: AbortSignal | undefined,
    respond: (response: JsonRpcServerResponse) => void,
  ): void {
    if (runSignal?.aborted) {
      return;
    }
    if (!callback) {
      respond({ id: requestId, result: deniedPermissionApprovalResponse() });
      return;
    }
    if (rejectDuplicatePendingRequest(requestId, pendingRequests, respond)) {
      return;
    }

    // Keep a private snapshot: the UI may display the request but cannot mutate the grant.
    const responsePermissions = clonePermissionProfile(request.permissions);
    const pending: PendingInteractiveRequest = {
      controller: new AbortController(),
      threadId: request.threadId,
    };
    pendingRequests.set(requestId, pending);
    deferServerRequestCallback()
      .then(() => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return undefined;
        }
        return callback(request, { signal: pending.controller.signal });
      })
      .then((decision) => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return;
        }
        pendingRequests.delete(requestId);
        if (!isPermissionApprovalDecision(decision)) {
          this.logger.warn("Codex permission approval callback returned an invalid decision; denying");
          respond({ id: requestId, result: deniedPermissionApprovalResponse() });
          return;
        }
        respond({
          id: requestId,
          result:
            decision === "deny"
              ? deniedPermissionApprovalResponse()
              : {
                  permissions: responsePermissions,
                  scope: decision === "grantSession" ? "session" : "turn",
                },
        });
      })
      .catch(() => {
        if (pending.controller.signal.aborted || pendingRequests.get(requestId) !== pending) {
          return;
        }
        pendingRequests.delete(requestId);
        this.logger.warn("Codex permission approval callback failed; denying");
        respond({ id: requestId, result: deniedPermissionApprovalResponse() });
      });
  }

  private async requestAppServer(
    method: string,
    params: Record<string, unknown>,
    options: AppServerRequestOptions = {},
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error("Codex session manager is disposed.");
    }
    const child = spawn(this.config.codexBin, buildCodexAppServerArgs(), {
      cwd: this.config.codexWorkdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexChildEnv(),
    });
    this.singleUseChildren.add(child);
    child.once("close", () => {
      this.singleUseChildren.delete(child);
    });
    const stderrCollector = createBoundedUtf8Collector(
      child.stderr,
      this.config.codexStderrMaxBytes,
    );
    let requestSeq = 0;
    const pendingRequests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const pendingInteractiveRequests = new Map<string | number, PendingInteractiveRequest>();

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

    function rejectPendingRequests(error: Error) {
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
    }

    const stdoutReader = createBoundedLineReader(
      child.stdout,
      appServerJsonLineLimit(this.config),
      (line) => {
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
            pending.reject(
              new Error(message.error.message ?? "Codex app-server request failed."),
            );
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
            undefined,
            undefined,
            pendingInteractiveRequests,
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
          abortResolvedInteractiveRequest(message, pendingInteractiveRequests);
        }
      },
      () => {
        const error = new Error("Codex app-server emitted an oversized JSON line.");
        this.logger.warn("Discarded an oversized Codex app-server JSON line");
        rejectPendingRequests(error);
        abortChild();
      },
    );

    child.once("error", (error) => {
      rejectPendingRequests(error);
    });
    child.once("close", () => {
      const stderr = stderrCollector.finish().trim();
      const suffix = stderr ? `\n${stderr}` : "";
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
        const currentCliVersion = parseCodexVersion(
          getString(asRecord(initializeResult), "userAgent"),
        );
        this.rememberAppServerInfo(initializeResult);
        if (
          options.requiredCliVersion &&
          currentCliVersion !== options.requiredCliVersion
        ) {
          throw new Error(
            `${options.capabilityLabel ?? method} requires Codex ${options.requiredCliVersion} to match the bundled protocol snapshot; the app-server reported ${currentCliVersion ?? "an unknown version"}. Run chat2codex doctor and refresh the protocol snapshot before retrying.`,
          );
        }
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
      stderrCollector.finish();
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

interface CodexSessionDescriptor {
  scope: CodexSessionScope;
  cwdKey: string;
  threadId?: string;
  policyKey: string;
}

interface ScopedRunContext {
  generation: string;
  input: CodexRunInput;
  threadId?: string;
  turnId?: string;
  turnStartSubmitted: boolean;
  finalText: string;
  turnCompleted: boolean;
  turnError: string | null;
  approvalCancelled: boolean;
  summary: CodexRunSummary;
  commandOutputBuffers: CommandOutputBufferState;
  pendingInteractiveRequests: Map<string | number, PendingInteractiveRequest>;
  resolveTurn: () => void;
  turnDone: Promise<void>;
  abortListener: () => void;
  interruptSent: boolean;
  interruptFallbackTimer: NodeJS.Timeout | null;
  stderrText: string;
  stderrTruncated: boolean;
}

interface ScopedTransportRequest {
  method: string;
  generation?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ServerRequestTombstone {
  count: number;
  threadId: string;
  expiresAt: number;
}

interface CodexAppServerSessionCallbacks {
  handleServerRequest(
    message: JsonRpcRequest,
    context: ScopedRunContext,
    respond: (response: JsonRpcServerResponse) => void,
  ): void;
  bindThread(session: CodexAppServerSession, threadId: string): Promise<void>;
  onInitialized(result: unknown): void;
  onDead(session: CodexAppServerSession): void;
  onIdle(session: CodexAppServerSession): void;
}

class CodexAppServerSession {
  readonly generation = randomUUID();
  readonly chatId: string;
  lastUsedAt = Date.now();

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrCollector: ReturnType<typeof createPerRunUtf8Collector>;
  private readonly stdoutReader: ReturnType<typeof createBoundedLineReader>;
  private readonly pendingRequests = new Map<string, ScopedTransportRequest>();
  private readonly serverRequestTombstones = new Map<
    string | number,
    ServerRequestTombstone
  >();
  private readonly closePromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private resolveClose!: (exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  private requestSeq = 0;
  private initialized?: Promise<void>;
  private collaborationModeModel?: string;
  private threadAttached = false;
  private activeRun?: ScopedRunContext;
  private dead = false;
  private closeStarted = false;
  private forceKillTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly descriptor: CodexSessionDescriptor,
    private readonly callbacks: CodexAppServerSessionCallbacks,
  ) {
    this.chatId = descriptor.scope.chatId;
    this.logger.info("Starting reusable Codex app-server session", {
      chatId: this.chatId,
      cwd: descriptor.cwdKey,
      resume: Boolean(descriptor.threadId),
      generation: this.generation,
    });
    this.child = spawn(this.config.codexBin, buildCodexAppServerArgs(), {
      cwd: descriptor.cwdKey,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexChildEnv(),
    });
    this.stderrCollector = createPerRunUtf8Collector(
      this.child.stderr,
      (value) => {
        const context = this.activeRun;
        if (!context || context.stderrTruncated) {
          return;
        }
        const bounded = truncateUtf8Text(
          `${context.stderrText}${value}`,
          this.config.codexStderrMaxBytes,
        );
        context.stderrText = bounded.text;
        context.stderrTruncated = bounded.truncated;
      },
    );
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    this.stdoutReader = createBoundedLineReader(
      this.child.stdout,
      appServerJsonLineLimit(this.config),
      (line) => this.handleLine(line),
      () => {
        this.logger.warn("Discarded an oversized Codex app-server JSON line", {
          chatId: this.chatId,
          generation: this.generation,
        });
        void this.close("oversized_json_line");
      },
    );
    this.child.once("error", (error) => {
      this.rejectPendingRequests(error);
    });
    this.child.once("close", (code, signal) => {
      this.dead = true;
      this.abortPendingInteractiveRequests(this.activeRun);
      this.rejectPendingRequests(new CodexAppServerExitError());
      if (this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = null;
      }
      this.stdoutReader.close();
      this.stderrCollector.finish();
      this.resolveClose({ code, signal });
      this.callbacks.onDead(this);
    });
  }

  get threadId(): string | undefined {
    return this.descriptor.threadId;
  }

  bindThread(threadId: string): void {
    this.descriptor.threadId = threadId;
  }

  matches(expected: CodexSessionDescriptor): boolean {
    return (
      this.isHealthy() &&
      this.descriptor.scope.adapterId === expected.scope.adapterId &&
      this.descriptor.scope.chatId === expected.scope.chatId &&
      this.descriptor.scope.sessionEpoch === expected.scope.sessionEpoch &&
      sameStableSessionPrincipal(
        this.descriptor.scope.principal,
        expected.scope.principal,
      ) &&
      this.descriptor.cwdKey === expected.cwdKey &&
      this.descriptor.policyKey === expected.policyKey &&
      this.descriptor.threadId === expected.threadId
    );
  }

  isHealthy(): boolean {
    return (
      !this.dead &&
      !this.closeStarted &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  isActive(): boolean {
    return this.activeRun !== undefined;
  }

  async run(input: CodexRunInput): Promise<CodexRunResult> {
    if (!this.isHealthy()) {
      throw new Error("The Codex app-server session is no longer healthy.");
    }
    if (this.activeRun) {
      throw new Error("The Codex app-server session already has an active turn.");
    }
    if (input.signal?.aborted) {
      return cancelledRunResult(input.threadId ?? this.threadId);
    }

    let resolveTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const context: ScopedRunContext = {
      generation: randomUUID(),
      input,
      threadId: this.threadId,
      turnStartSubmitted: false,
      finalText: "",
      turnCompleted: false,
      turnError: null,
      approvalCancelled: false,
      summary: createEmptyRunSummary(),
      commandOutputBuffers: { buffers: new Map(), totalBytes: 0 },
      pendingInteractiveRequests: new Map(),
      resolveTurn,
      turnDone,
      abortListener: () => this.requestInterrupt(context),
      interruptSent: false,
      interruptFallbackTimer: null,
      stderrText: "",
      stderrTruncated: false,
    };
    this.activeRun = context;
    this.lastUsedAt = Date.now();
    input.signal?.addEventListener("abort", context.abortListener, { once: true });

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      await this.ensureInitialized();
      await this.ensureThread(context);
      if (input.signal?.aborted) {
        await this.close("aborted_before_turn_start");
        return cancelledRunResult(context.threadId);
      }

      const collaborationMode = input.collaborationMode
        ? buildCollaborationMode(
            input.collaborationMode,
            await this.resolveCollaborationModeModel(context.generation),
          )
        : undefined;
      const turnResult = await this.sendRequest(
        "turn/start",
        {
          threadId: context.threadId,
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
          ...(collaborationMode ? { collaborationMode } : {}),
        },
        context.generation,
      );
      context.turnId = extractTurnId(turnResult) ?? context.turnId;
      if (!context.threadId || !context.turnId) {
        throw new Error("Codex app-server did not return an active thread and turn.");
      }
      if (input.signal?.aborted) {
        this.requestInterrupt(context);
      }
      input.onRunControl?.({
        threadId: context.threadId,
        turnId: context.turnId,
        steer: (text: string) =>
          steerAppServerTurn({
            text,
            getThreadId: () => context.threadId,
            getTurnId: () => context.turnId,
            isTurnCompleted: () => context.turnCompleted,
            isAborted: () => Boolean(input.signal?.aborted),
            sendRequest: (method, params) =>
              this.sendRequest(method, params, context.generation),
          }),
      });

      const outcome = await Promise.race([
        context.turnDone.then(() => ({ kind: "turn" as const })),
        this.closePromise.then((closed) => ({ kind: "exit" as const, closed })),
      ]);
      if (outcome.kind === "exit") {
        exit = outcome.closed;
      }

      const stderr = context.stderrText.trim();
      const cancelled = Boolean(
        input.signal?.aborted || (context.approvalCancelled && !context.finalText.trim()),
      );
      if (!context.finalText.trim()) {
        context.finalText = cancelled
          ? ""
          : context.turnCompleted && !context.turnError
            ? "(Codex finished without a final text response.)"
            : [context.turnError, stderr].filter(Boolean).join("\n");
      }
      context.finalText = truncateTextChars(
        context.finalText.trim(),
        this.config.chatOutputMaxChars,
      );
      return {
        threadId: context.threadId,
        finalText: context.finalText,
        stderr,
        exitCode:
          cancelled || (context.turnCompleted && !context.turnError)
            ? 0
            : (exit?.code ?? 1),
        signal: exit?.signal ?? null,
        cancelled,
        summary: finalizeRunSummary(
          context.summary,
          this.config.runLogMaxCommands,
          this.config.runLogMaxBytes,
          this.config.runDiffMaxChars,
        ),
      };
    } catch (error) {
      await this.close("run_failed");
      if (!context.turnStartSubmitted && error instanceof CodexAppServerExitError) {
        throw new CodexSessionStartupExitError(context.threadId, error);
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", context.abortListener);
      if (context.interruptFallbackTimer) {
        clearTimeout(context.interruptFallbackTimer);
      }
      this.rememberServerRequestTombstones(context);
      this.abortPendingInteractiveRequests(context);
      this.rejectGenerationRequests(
        context.generation,
        new Error("The Codex turn is no longer active."),
      );
      if (this.activeRun === context) {
        this.activeRun = undefined;
      }
      this.lastUsedAt = Date.now();
      if (this.isHealthy()) {
        this.callbacks.onIdle(this);
      }
    }
  }

  async close(reason: string): Promise<void> {
    if (!this.closeStarted) {
      this.closeStarted = true;
      this.abortPendingInteractiveRequests(this.activeRun);
      this.logger.info("Stopping reusable Codex app-server session", {
        chatId: this.chatId,
        generation: this.generation,
        pid: this.child.pid,
        reason,
      });
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
        this.forceKillTimer = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill("SIGKILL");
          }
        }, 5000);
        this.forceKillTimer.unref?.();
      }
    }
    if (this.dead || this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    await this.closePromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const result = await this.sendRequest("initialize", {
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
        this.callbacks.onInitialized(result);
        this.sendJson({ method: "initialized" });
      })();
    }
    await this.initialized;
  }

  private async ensureThread(context: ScopedRunContext): Promise<void> {
    if (this.threadAttached) {
      context.threadId = this.threadId;
      return;
    }
    const requestedThreadId = this.threadId;
    const result = requestedThreadId
      ? await this.sendRequest(
          "thread/resume",
          buildThreadResumeParams(this.config, context.input),
          context.generation,
        )
      : await this.sendRequest(
          "thread/start",
          buildThreadStartParams(this.config, context.input),
          context.generation,
        );
    const threadId = extractThreadId(result) ?? context.threadId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id.");
    }
    context.threadId = threadId;
    await this.callbacks.bindThread(this, threadId);
    if (!requestedThreadId) {
      await context.input.onThreadBound?.(threadId);
    }
    this.threadAttached = true;
  }

  private async resolveCollaborationModeModel(generation: string): Promise<string> {
    if (this.config.codexModel) {
      return this.config.codexModel;
    }
    if (!this.collaborationModeModel) {
      this.collaborationModeModel = requireDefaultModel(
        await this.sendRequest("model/list", { includeHidden: false }, generation),
      );
    }
    return this.collaborationModeModel;
  }

  private requestInterrupt(context: ScopedRunContext): void {
    if (this.activeRun !== context || context.turnCompleted) {
      return;
    }
    this.rememberServerRequestTombstones(context);
    this.abortPendingInteractiveRequests(context);
    if (context.threadId && context.turnId && !context.interruptSent) {
      context.interruptSent = true;
      void this.sendRequest(
        "turn/interrupt",
        { threadId: context.threadId, turnId: context.turnId },
        context.generation,
      ).catch((error: unknown) => {
        this.logger.warn("Codex turn/interrupt failed; waiting for process fallback", error);
      });
    }
    if (!context.interruptFallbackTimer) {
      context.interruptFallbackTimer = setTimeout(() => {
        if (this.activeRun === context && !context.turnCompleted) {
          void this.close("turn_interrupt_timeout");
        }
      }, 5000);
      context.interruptFallbackTimer.unref?.();
    }
  }

  private sendJson(message: unknown): void {
    if (!this.child.stdin.writable || this.child.stdin.destroyed || !this.isHealthy()) {
      throw new CodexAppServerExitError();
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendRequest(
    method: string,
    params: unknown,
    generation?: string,
  ): Promise<unknown> {
    const id = String(++this.requestSeq);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { method, generation, resolve, reject });
    });
    try {
      this.sendJson({ id: Number(id), method, params });
      const context = this.activeRun;
      if (
        method === "turn/start" &&
        generation !== undefined &&
        context?.generation === generation
      ) {
        context.turnStartSubmitted = true;
      }
    } catch (error) {
      this.pendingRequests.delete(id);
      const normalized = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(normalized);
    }
    return promise;
  }

  private handleLine(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      return;
    }
    if (isJsonRpcResponse(message)) {
      const pending = this.pendingRequests.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
        return;
      }
      const context = this.activeRun;
      if (context && pending.generation === context.generation) {
        if (pending.method === "turn/start") {
          context.turnId = extractTurnId(message.result) ?? context.turnId;
        } else if (pending.method === "thread/start" || pending.method === "thread/resume") {
          context.threadId = extractThreadId(message.result) ?? context.threadId;
        }
      }
      pending.resolve(message.result);
      return;
    }
    if (isJsonRpcRequest(message)) {
      this.handleServerRequest(message);
      return;
    }
    if (isInvalidJsonRpcRequestEnvelope(message)) {
      this.safeSend({ id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    if (isJsonRpcNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleServerRequest(message: JsonRpcRequest): void {
    const context = this.activeRun;
    const requestThreadId = getString(message.params, "threadId");
    const requestTurnId = message.params?.turnId;
    const isActiveMcpSessionRequest =
      message.method === "mcpServer/elicitation/request" && requestTurnId == null;
    const belongsToActiveTurn = Boolean(
      context &&
        context.threadId &&
        context.turnId &&
        requestThreadId === context.threadId &&
        (requestTurnId === context.turnId || isActiveMcpSessionRequest),
    );
    if (!context || !belongsToActiveTurn || context.turnCompleted) {
      const failClosedContext = createFailClosedRunContext(
        this.descriptor.cwdKey,
        context?.threadId,
      );
      this.callbacks.handleServerRequest(message, failClosedContext, (response) =>
        this.safeSend(response),
      );
      return;
    }
    const generation = context.generation;
    this.callbacks.handleServerRequest(message, context, (response) => {
      if (this.activeRun === context && context.generation === generation && !context.turnCompleted) {
        this.safeSend(response);
      }
    });
  }

  private handleNotification(message: JsonRpcNotification): void {
    const context = this.activeRun;
    if (!context) {
      return;
    }
    if (message.method === "serverRequest/resolved") {
      if (getString(message.params, "threadId") === context.threadId) {
        const requestId = message.params?.requestId;
        if (isRequestId(requestId) && this.consumeServerRequestTombstone(requestId, context)) {
          return;
        }
        abortResolvedInteractiveRequest(message, context.pendingInteractiveRequests);
      }
      return;
    }
    if (message.method === "thread/started") {
      return;
    }
    if (message.method === "turn/started") {
      if (getString(message.params, "threadId") !== context.threadId) {
        return;
      }
      const startedTurnId = getString(asRecord(message.params?.turn), "id");
      if (context.turnId && startedTurnId !== context.turnId) {
        return;
      }
      context.turnId = startedTurnId ?? context.turnId;
    }
    if (!notificationBelongsToRun(message, context) || context.turnCompleted) {
      return;
    }

    if (message.method === "turn/completed") {
      const turn = asRecord(message.params?.turn);
      context.summary.durationMs = getNumber(turn, "durationMs") ?? context.summary.durationMs;
      context.turnCompleted = true;
      if (getString(turn, "status") === "failed") {
        context.turnError = truncateTextChars(
          formatTurnError(turn?.error),
          this.config.chatOutputMaxChars,
        );
      }
      context.resolveTurn();
    } else if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = parseThreadTokenUsage(message.params?.tokenUsage);
      if (tokenUsage) {
        context.summary.tokenUsage = tokenUsage;
      }
    } else if (message.method === "error") {
      if (message.params?.willRetry !== true) {
        context.turnError = truncateTextChars(
          getString(asRecord(message.params?.error), "message") ?? "Codex reported an error.",
          this.config.chatOutputMaxChars,
        );
      }
      this.logger.warn("Codex emitted an error notification", message);
    } else if (message.method === "item/completed") {
      const item = asRecord(message.params?.item);
      if (getString(item, "type") === "agentMessage") {
        const text = getString(item, "text");
        if (text && /\S/u.test(text) && getString(item, "phase") !== "commentary") {
          context.finalText = truncateTextChars(text, this.config.chatOutputMaxChars);
        }
      }
      recordCompletedItem(
        context.summary,
        item,
        context.commandOutputBuffers,
        this.config.runLogMaxCommands,
        this.config.runLogMaxBytes,
      );
    } else if (message.method === "turn/diff/updated") {
      const diff = getString(message.params, "diff");
      if (diff !== undefined) {
        const boundedDiff = truncateTextChars(diff, this.config.runDiffMaxChars);
        context.summary.diff = boundedDiff;
        context.summary.diffStat = summarizeUnifiedDiff(boundedDiff);
        addChangedFiles(context.summary, filesFromUnifiedDiff(boundedDiff));
      }
    } else if (message.method === "item/commandExecution/outputDelta") {
      const itemId = getString(message.params, "itemId");
      const delta = getString(message.params, "delta");
      if (
        itemId !== undefined &&
        itemId.length <= maxInteractiveIdentityLength &&
        delta !== undefined
      ) {
        appendCommandOutput(
          context.commandOutputBuffers,
          itemId,
          delta,
          this.config.runLogMaxCommands,
          this.config.runLogMaxBytes,
        );
      }
    } else if (message.method === "item/fileChange/patchUpdated") {
      const changes = Array.isArray(message.params?.changes) ? message.params.changes : [];
      recordFileChanges(context.summary, changes);
    }

    const progress = summarizeCodexAppServerProgress(message);
    if (progress && context.input.onProgress && !context.input.signal?.aborted) {
      Promise.resolve(context.input.onProgress(progress)).catch((error: unknown) => {
        this.logger.warn("Codex progress callback failed", error);
      });
    }
  }

  private safeSend(response: JsonRpcServerResponse): void {
    try {
      this.sendJson(response);
    } catch (error) {
      this.logger.warn("Failed to respond to Codex app-server request", error);
    }
  }

  private abortPendingInteractiveRequests(context: ScopedRunContext | undefined): void {
    if (!context) {
      return;
    }
    for (const pending of context.pendingInteractiveRequests.values()) {
      pending.controller.abort();
    }
    context.pendingInteractiveRequests.clear();
  }

  private rememberServerRequestTombstones(context: ScopedRunContext): void {
    if (!context.threadId) {
      return;
    }
    this.pruneServerRequestTombstones();
    for (const requestId of context.pendingInteractiveRequests.keys()) {
      const existing = this.serverRequestTombstones.get(requestId);
      this.serverRequestTombstones.delete(requestId);
      this.serverRequestTombstones.set(requestId, {
        count: Math.min((existing?.count ?? 0) + 1, 8),
        threadId: context.threadId,
        expiresAt: Date.now() + serverRequestTombstoneTtlMs,
      });
    }
    while (this.serverRequestTombstones.size > maxServerRequestTombstones) {
      const oldest = this.serverRequestTombstones.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.serverRequestTombstones.delete(oldest);
    }
  }

  private consumeServerRequestTombstone(
    requestId: string | number,
    context: ScopedRunContext,
  ): boolean {
    this.pruneServerRequestTombstones();
    const tombstone = this.serverRequestTombstones.get(requestId);
    if (!tombstone || tombstone.threadId !== context.threadId) {
      return false;
    }
    if (tombstone.count <= 1) {
      this.serverRequestTombstones.delete(requestId);
    } else {
      tombstone.count -= 1;
    }
    return true;
  }

  private pruneServerRequestTombstones(): void {
    const now = Date.now();
    for (const [requestId, tombstone] of this.serverRequestTombstones) {
      if (tombstone.expiresAt <= now) {
        this.serverRequestTombstones.delete(requestId);
      }
    }
  }

  private rejectGenerationRequests(generation: string, error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.generation === generation) {
        this.pendingRequests.delete(id);
        pending.reject(error);
      }
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

function createSessionDescriptor(
  config: BridgeConfig,
  scope: CodexSessionScope,
  cwdKey: string,
  threadId: string | undefined,
): CodexSessionDescriptor {
  return {
    scope: {
      adapterId: scope.adapterId,
      chatId: scope.chatId,
      sessionEpoch: scope.sessionEpoch,
      principal: {
        ...scope.principal,
        keys: identityKeys(scope.principal),
      },
    },
    cwdKey,
    threadId,
    policyKey: JSON.stringify({
      codexBin: config.codexBin,
      sandbox: config.codexSandbox,
      approvalPolicy: config.codexApprovalPolicy,
      model: config.codexModel ?? null,
      skipGitRepoCheck: config.codexSkipGitRepoCheck,
    }),
  };
}

function isReusableSessionScope(scope: CodexSessionScope | undefined): scope is CodexSessionScope {
  return Boolean(
    scope &&
      scope.chatId.trim() &&
      scope.sessionEpoch.trim() &&
      hasStableIdentity(scope.principal),
  );
}

function sameStableSessionPrincipal(
  left: CodexSessionPrincipal,
  right: CodexSessionPrincipal,
): boolean {
  return identitiesIntersect(left, right);
}

function notificationBelongsToRun(
  message: JsonRpcNotification,
  context: ScopedRunContext,
): boolean {
  const threadId = getString(message.params, "threadId");
  const turnId =
    getString(message.params, "turnId") ?? getString(asRecord(message.params?.turn), "id");
  return Boolean(
    context.threadId &&
      context.turnId &&
      threadId === context.threadId &&
      turnId === context.turnId,
  );
}

function cancelledRunResult(threadId: string | undefined): CodexRunResult {
  return {
    threadId,
    finalText: "",
    stderr: "",
    exitCode: null,
    signal: null,
    cancelled: true,
  };
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let forceKillTimer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
    forceKillTimer.unref?.();
  });
}

function createFailClosedRunContext(
  cwd: string,
  threadId: string | undefined,
): ScopedRunContext {
  let resolveTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  return {
    generation: randomUUID(),
    input: { prompt: "", cwd },
    threadId,
    turnStartSubmitted: false,
    finalText: "",
    turnCompleted: false,
    turnError: null,
    approvalCancelled: false,
    summary: createEmptyRunSummary(),
    commandOutputBuffers: { buffers: new Map(), totalBytes: 0 },
    pendingInteractiveRequests: new Map(),
    resolveTurn,
    turnDone,
    abortListener: () => undefined,
    interruptSent: false,
    interruptFallbackTimer: null,
    stderrText: "",
    stderrTruncated: false,
  };
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

function finalizeRunSummary(
  summary: CodexRunSummary,
  maxCommands: number,
  maxLogBytes: number,
  maxDiffChars: number,
): CodexRunSummary {
  const commands: CodexCommandSummary[] = [];
  for (const command of summary.commands) {
    appendBoundedCommandSummary(commands, command, maxCommands, maxLogBytes);
  }
  return {
    ...summary,
    diff: summary.diff ? truncateTextChars(summary.diff, maxDiffChars) : undefined,
    changedFiles: [...new Set(summary.changedFiles)].slice(0, maxChangedFiles),
    commands,
  };
}

function recordCompletedItem(
  summary: CodexRunSummary,
  item: Record<string, unknown> | null,
  commandOutputBuffers: CommandOutputBufferState,
  maxCommands: number,
  maxLogBytes: number,
): void {
  const itemType = getString(item, "type");
  if (itemType === "commandExecution") {
    const itemId = getString(item, "id");
    const bufferedOutput = itemId ? takeCommandOutput(commandOutputBuffers, itemId) : undefined;
    const command = getString(item, "command");
    if (!command) {
      return;
    }
    appendBoundedCommandSummary(
      summary.commands,
      {
        command,
        cwd: getString(item, "cwd"),
        status: getString(item, "status"),
        exitCode: getNullableNumber(item, "exitCode"),
        durationMs: getNumber(item, "durationMs"),
        outputPreview: truncateOutputPreview(
          getString(item, "aggregatedOutput") ?? bufferedOutput ?? "",
          maxLogBytes,
        ),
      },
      maxCommands,
      maxLogBytes,
    );
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
    if (summary.changedFiles.length >= maxChangedFiles) {
      break;
    }
    const boundedFile = truncateTextChars(file, maxChangedFilePathChars);
    if (!boundedFile || seen.has(boundedFile)) {
      continue;
    }
    seen.add(boundedFile);
    summary.changedFiles.push(boundedFile);
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

function truncateOutputPreview(value: string, maxBytes: number): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return truncateUtf8Text(normalized, maxBytes).text;
}

function appendCommandOutput(
  state: CommandOutputBufferState,
  itemId: string,
  delta: string,
  maxCommands: number,
  maxBytes: number,
): void {
  const existing = state.buffers.get(itemId);
  if (existing) {
    state.totalBytes -= existing.bytes;
    state.buffers.delete(itemId);
  }
  const bounded = existing?.truncated
    ? existing
    : truncateUtf8Text(`${existing?.text ?? ""}${delta}`, maxBytes);
  state.buffers.set(itemId, bounded);
  state.totalBytes += bounded.bytes;

  while (state.buffers.size > maxCommands || state.totalBytes > maxBytes) {
    const oldestId = state.buffers.keys().next().value as string | undefined;
    if (oldestId === undefined) {
      break;
    }
    const oldest = state.buffers.get(oldestId);
    state.buffers.delete(oldestId);
    state.totalBytes -= oldest?.bytes ?? 0;
  }
}

function takeCommandOutput(state: CommandOutputBufferState, itemId: string): string | undefined {
  const buffered = state.buffers.get(itemId);
  if (!buffered) {
    return undefined;
  }
  state.buffers.delete(itemId);
  state.totalBytes -= buffered.bytes;
  return buffered.text;
}

function appendBoundedCommandSummary(
  commands: CodexCommandSummary[],
  command: CodexCommandSummary,
  maxCommands: number,
  maxBytes: number,
): void {
  commands.push(fitCommandSummaryToBytes(command, maxBytes));
  while (commands.length > maxCommands || commandSummariesTextBytes(commands) > maxBytes) {
    commands.shift();
  }
}

function fitCommandSummaryToBytes(
  command: CodexCommandSummary,
  maxBytes: number,
): CodexCommandSummary {
  let remaining = maxBytes;
  const takeRequired = (value: string): string => {
    const bounded = truncateUtf8Text(value, remaining).text;
    remaining -= Buffer.byteLength(bounded, "utf8");
    return bounded;
  };
  const takeOptional = (value: string | undefined): string | undefined => {
    if (!value || remaining <= 0) {
      return undefined;
    }
    return takeRequired(value);
  };
  const boundedCommand = takeRequired(command.command);
  const outputPreview = takeOptional(command.outputPreview);
  const cwd = takeOptional(command.cwd);
  const status = takeOptional(command.status);
  return {
    command: boundedCommand,
    cwd,
    status,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    outputPreview,
  };
}

function commandSummariesTextBytes(commands: CodexCommandSummary[]): number {
  return commands.reduce(
    (total, command) =>
      total +
      [command.command, command.cwd, command.status, command.outputPreview].reduce(
        (bytes, value) => bytes + (value ? Buffer.byteLength(value, "utf8") : 0),
        0,
      ),
    0,
  );
}

function truncateUtf8Text(value: string, maxBytes: number): BoundedCommandOutput {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) {
    return { text: value, bytes, truncated: false };
  }
  const marker = byteTruncationMarker(maxBytes);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let contentBytes = 0;
  let endIndex = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (contentBytes + characterBytes > contentBudget) {
      break;
    }
    contentBytes += characterBytes;
    endIndex += character.length;
  }
  const text = `${value.slice(0, endIndex)}${marker}`;
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: true,
  };
}

function truncateTextChars(value: string, maxChars: number): string {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maxChars) {
      break;
    }
  }
  if (count <= maxChars) {
    return value;
  }

  const marker = charTruncationMarker(maxChars);
  const contentBudget = Math.max(0, maxChars - [...marker].length);
  let contentChars = 0;
  let endIndex = 0;
  for (const character of value) {
    if (contentChars >= contentBudget) {
      break;
    }
    contentChars += 1;
    endIndex += character.length;
  }
  return `${value.slice(0, endIndex)}${marker}`;
}

function byteTruncationMarker(maxBytes: number): string {
  const fullMarkerBytes = Buffer.byteLength(truncationMarker, "utf8");
  if (maxBytes >= fullMarkerBytes) {
    return truncationMarker;
  }
  return maxBytes >= 3 ? "..." : ".".repeat(maxBytes);
}

function charTruncationMarker(maxChars: number): string {
  if (maxChars >= [...truncationMarker].length) {
    return truncationMarker;
  }
  return maxChars >= 3 ? "..." : ".".repeat(maxChars);
}

function createBoundedUtf8Collector(stream: Readable, maxBytes: number) {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let truncated = false;
  let finished = false;

  const append = (value: string) => {
    if (!value || truncated) {
      return;
    }
    const bounded = truncateUtf8Text(`${text}${value}`, maxBytes);
    text = bounded.text;
    truncated = bounded.truncated;
  };
  const onData = (chunk: Buffer | string) => {
    if (truncated) {
      return;
    }
    append(typeof chunk === "string" ? chunk : decoder.write(chunk));
  };
  const finish = () => {
    if (!finished) {
      finished = true;
      stream.off("data", onData);
      append(decoder.end());
    }
    return text;
  };
  stream.on("data", onData);
  stream.once("end", finish);
  return { finish };
}

function createPerRunUtf8Collector(stream: Readable, append: (value: string) => void) {
  const decoder = new StringDecoder("utf8");
  let finished = false;
  const onData = (chunk: Buffer | string) => {
    append(typeof chunk === "string" ? chunk : decoder.write(chunk));
  };
  const finish = () => {
    if (!finished) {
      finished = true;
      stream.off("data", onData);
      append(decoder.end());
    }
  };
  stream.on("data", onData);
  stream.once("end", finish);
  return { finish };
}

function appServerJsonLineLimit(config: BridgeConfig): number {
  // JSON string escaping can expand one input character to six ASCII bytes (for example \u0000).
  const charBudget = Math.max(config.chatOutputMaxChars, config.runDiffMaxChars) * 6;
  const desired = Math.max(config.runLogMaxBytes, charBudget) + 64 * 1_024;
  return Math.max(
    minAppServerJsonLineBytes,
    Math.min(maxAppServerJsonLineBytes, desired),
  );
}

function createBoundedLineReader(
  stream: Readable,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onOversizedLine: () => void,
) {
  const lineBuffer = Buffer.allocUnsafe(maxLineBytes);
  let lineLength = 0;
  let discarding = false;
  let closed = false;

  const finishLine = () => {
    if (!discarding) {
      const contentLength =
        lineLength > 0 && lineBuffer[lineLength - 1] === 0x0d ? lineLength - 1 : lineLength;
      onLine(lineBuffer.toString("utf8", 0, contentLength));
    }
    lineLength = 0;
    discarding = false;
  };
  const onData = (value: Buffer | string) => {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segmentLength = segmentEnd - offset;
      if (!discarding && segmentLength > 0) {
        if (lineLength + segmentLength > maxLineBytes) {
          lineLength = 0;
          discarding = true;
          onOversizedLine();
        } else {
          chunk.copy(lineBuffer, lineLength, offset, segmentEnd);
          lineLength += segmentLength;
        }
      }
      if (newlineIndex === -1) {
        break;
      }
      finishLine();
      offset = newlineIndex + 1;
    }
  };
  const onEnd = () => {
    if (lineLength > 0 || discarding) {
      finishLine();
    }
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return { close };
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

function abortResolvedInteractiveRequest(
  notification: JsonRpcNotification,
  pendingRequests: Map<string | number, PendingInteractiveRequest>,
): void {
  const params = asObjectRecord(notification.params);
  const requestId = params?.requestId;
  const threadId = getString(params, "threadId");
  if (!isRequestId(requestId) || threadId === undefined) {
    return;
  }
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.threadId !== threadId) {
    return;
  }
  pendingRequests.delete(requestId);
  pending.controller.abort();
}

function rejectDuplicatePendingRequest(
  requestId: string | number,
  pendingRequests: Map<string | number, PendingInteractiveRequest>,
  respond: (response: JsonRpcServerResponse) => void,
): boolean {
  const existing = pendingRequests.get(requestId);
  if (!existing) {
    return false;
  }
  pendingRequests.delete(requestId);
  existing.controller.abort();
  respond({ id: requestId, error: { code: -32600, message: "Invalid Request" } });
  return true;
}

function parseMcpElicitationRequest(message: JsonRpcRequest): McpElicitationParseResult {
  if (message.method !== "mcpServer/elicitation/request") {
    return { status: "not-applicable" };
  }

  const params = asPlainObjectRecord(message.params);
  if (
    !params ||
    !isBoundedNonEmptyString(params.serverName, maxInteractiveIdentityLength) ||
    !isBoundedNonEmptyString(params.threadId, maxInteractiveIdentityLength) ||
    !isNullableBoundedString(params.turnId, maxInteractiveIdentityLength) ||
    !isBoundedString(params.message, maxInteractiveMessageLength) ||
    !isBoundedOpaqueJson(params._meta, maxInteractiveMessageLength)
  ) {
    return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
  }

  if (params.mode === "openai/form") {
    if (
      !hasOnlyKeys(params, [
        "_meta",
        "serverName",
        "threadId",
        "turnId",
        "message",
        "mode",
        "requestedSchema",
      ]) ||
      !Object.hasOwn(params, "requestedSchema") ||
      !isBoundedOpaqueJson(params.requestedSchema, maxInteractiveMessageLength)
    ) {
      return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
    }
    // This client deliberately does not negotiate mcpServerOpenaiFormElicitation.
    return { status: "safe-cancel" };
  }

  const common = {
    id: randomUUID(),
    serverName: params.serverName,
    threadId: params.threadId,
    turnId: (params.turnId as string | null | undefined) ?? null,
    message: params.message,
  };
  if (params.mode === "form") {
    if (
      !hasOnlyKeys(params, [
        "_meta",
        "serverName",
        "threadId",
        "turnId",
        "message",
        "mode",
        "requestedSchema",
      ])
    ) {
      return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
    }
    const fields = parseMcpFormSchema(params.requestedSchema);
    if (!fields) {
      return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
    }
    return { status: "supported", request: { ...common, mode: "form", fields } };
  }

  if (
    params.mode === "url" &&
    hasOnlyKeys(params, [
      "_meta",
      "serverName",
      "threadId",
      "turnId",
      "message",
      "mode",
      "elicitationId",
      "url",
    ]) &&
    isBoundedNonEmptyString(params.elicitationId, maxInteractiveIdentityLength) &&
    isAllowedMcpUrl(params.url)
  ) {
    return {
      status: "supported",
      request: {
        ...common,
        mode: "url",
        elicitationId: params.elicitationId,
        url: params.url,
      },
    };
  }

  return { status: "malformed", message: "Invalid params: malformed MCP elicitation" };
}

function parseMcpFormSchema(value: unknown): CodexMcpElicitationField[] | null {
  const schema = asPlainObjectRecord(value);
  if (
    !schema ||
    !hasOnlyKeys(schema, ["$schema", "properties", "required", "type"]) ||
    schema.type !== "object" ||
    !isNullableBoundedString(schema.$schema, maxMcpUrlLength)
  ) {
    return null;
  }
  const properties = asPlainObjectRecord(schema.properties);
  if (!properties || Object.keys(properties).length > maxMcpFormFields) {
    return null;
  }

  let required: string[] = [];
  if (schema.required !== undefined && schema.required !== null) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > maxMcpFormFields ||
      !schema.required.every((item) => isBoundedNonEmptyString(item, maxMcpFieldNameLength)) ||
      new Set(schema.required).size !== schema.required.length
    ) {
      return null;
    }
    required = schema.required;
  }
  const requiredNames = new Set(required);
  if (required.some((name) => !Object.hasOwn(properties, name))) {
    return null;
  }

  const fields: CodexMcpElicitationField[] = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (!isBoundedNonEmptyString(name, maxMcpFieldNameLength) || !isSafeObjectKey(name)) {
      return null;
    }
    const field = parseMcpFormField(name, fieldSchema, requiredNames.has(name));
    if (!field) {
      return null;
    }
    fields.push(field);
  }
  return fields;
}

function parseMcpFormField(
  name: string,
  value: unknown,
  required: boolean,
): CodexMcpElicitationField | null {
  const schema = asPlainObjectRecord(value);
  if (!schema) {
    return null;
  }
  const title = readNullableText(schema, "title", maxMcpFieldTextLength);
  const description = readNullableText(schema, "description", maxMcpFieldTextLength);
  if (!title.ok || !description.ok) {
    return null;
  }
  const base = { name, title: title.value, description: description.value, required };

  if (schema.type === "array") {
    if (
      !hasOnlyKeys(schema, [
        "type",
        "title",
        "description",
        "default",
        "items",
        "minItems",
        "maxItems",
      ])
    ) {
      return null;
    }
    const options = parseMcpMultiSelectOptions(schema.items);
    const minItems = readNullableBoundedInteger(schema, "minItems", 0, maxMcpEnumOptions);
    const maxItems = readNullableBoundedInteger(schema, "maxItems", 0, maxMcpEnumOptions);
    if (
      !options ||
      !minItems.ok ||
      !maxItems.ok ||
      (minItems.value !== null && maxItems.value !== null && minItems.value > maxItems.value) ||
      (minItems.value !== null && minItems.value > options.length)
    ) {
      return null;
    }
    const defaultValue = readNullableStringArray(schema, "default", options);
    if (!defaultValue.ok) {
      return null;
    }
    if (
      defaultValue.value !== null &&
      ((minItems.value !== null && defaultValue.value.length < minItems.value) ||
        (maxItems.value !== null && defaultValue.value.length > maxItems.value))
    ) {
      return null;
    }
    return {
      ...base,
      type: "multi_select",
      default: defaultValue.value,
      options,
      minItems: minItems.value,
      maxItems: maxItems.value,
    };
  }

  if (schema.type === "boolean") {
    if (!hasOnlyKeys(schema, ["type", "title", "description", "default"])) {
      return null;
    }
    const defaultValue = readNullableBoolean(schema, "default");
    return defaultValue.ok
      ? { ...base, type: "boolean", default: defaultValue.value }
      : null;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (
      !hasOnlyKeys(schema, [
        "type",
        "title",
        "description",
        "default",
        "minimum",
        "maximum",
      ])
    ) {
      return null;
    }
    const minimum = readNullableFiniteNumber(schema, "minimum");
    const maximum = readNullableFiniteNumber(schema, "maximum");
    const defaultValue = readNullableFiniteNumber(schema, "default");
    if (
      !minimum.ok ||
      !maximum.ok ||
      !defaultValue.ok ||
      (minimum.value !== null && maximum.value !== null && minimum.value > maximum.value) ||
      (schema.type === "integer" &&
        defaultValue.value !== null &&
        !Number.isSafeInteger(defaultValue.value)) ||
      (defaultValue.value !== null &&
        ((minimum.value !== null && defaultValue.value < minimum.value) ||
          (maximum.value !== null && defaultValue.value > maximum.value)))
    ) {
      return null;
    }
    return {
      ...base,
      type: schema.type,
      default: defaultValue.value,
      minimum: minimum.value,
      maximum: maximum.value,
    };
  }

  if (schema.type !== "string") {
    return null;
  }
  if (Object.hasOwn(schema, "oneOf") || Object.hasOwn(schema, "enum")) {
    const options = parseMcpSingleSelectOptions(schema);
    if (!options) {
      return null;
    }
    const defaultValue = readNullableString(schema, "default", maxMcpEnumValueLength);
    if (
      !defaultValue.ok ||
      (defaultValue.value !== null &&
        !options.some((option) => option.value === defaultValue.value))
    ) {
      return null;
    }
    return { ...base, type: "enum", default: defaultValue.value, options };
  }

  if (
    !hasOnlyKeys(schema, [
      "type",
      "title",
      "description",
      "default",
      "format",
      "minLength",
      "maxLength",
    ])
  ) {
    return null;
  }
  const format = readNullableStringFormat(schema.format);
  const minLength = readNullableBoundedInteger(
    schema,
    "minLength",
    0,
    maxMcpStringValueLength,
  );
  const maxLength = readNullableBoundedInteger(
    schema,
    "maxLength",
    0,
    maxMcpStringValueLength,
  );
  const defaultValue = readNullableString(schema, "default", maxMcpStringValueLength);
  if (
    !format.ok ||
    !minLength.ok ||
    !maxLength.ok ||
    !defaultValue.ok ||
    (minLength.value !== null && maxLength.value !== null && minLength.value > maxLength.value) ||
    (defaultValue.value !== null &&
      !isValidMcpStringValue(defaultValue.value, {
        ...base,
        type: "string",
        default: null,
        format: format.value,
        minLength: minLength.value,
        maxLength: maxLength.value,
      }))
  ) {
    return null;
  }
  return {
    ...base,
    type: "string",
    default: defaultValue.value,
    format: format.value,
    minLength: minLength.value,
    maxLength: maxLength.value,
  };
}

function parseMcpSingleSelectOptions(
  schema: Record<string, unknown>,
): CodexMcpElicitationOption[] | null {
  if (Object.hasOwn(schema, "oneOf")) {
    if (!hasOnlyKeys(schema, ["type", "title", "description", "default", "oneOf"])) {
      return null;
    }
    return parseMcpTitledOptions(schema.oneOf);
  }
  if (
    !hasOnlyKeys(schema, [
      "type",
      "title",
      "description",
      "default",
      "enum",
      "enumNames",
    ]) ||
    !Array.isArray(schema.enum)
  ) {
    return null;
  }
  const values = parseBoundedUniqueStrings(schema.enum, maxMcpEnumOptions, maxMcpEnumValueLength);
  if (!values) {
    return null;
  }
  if (schema.enumNames === undefined || schema.enumNames === null) {
    return values.map((value) => ({ value, title: value }));
  }
  const titles = parseBoundedStrings(
    schema.enumNames,
    maxMcpEnumOptions,
    maxMcpFieldTextLength,
  );
  return titles && titles.length === values.length
    ? values.map((value, index) => ({ value, title: titles[index] ?? value }))
    : null;
}

function parseMcpMultiSelectOptions(value: unknown): CodexMcpElicitationOption[] | null {
  const items = asPlainObjectRecord(value);
  if (!items) {
    return null;
  }
  if (Object.hasOwn(items, "enum")) {
    if (!hasOnlyKeys(items, ["type", "enum"]) || items.type !== "string") {
      return null;
    }
    const values = parseBoundedUniqueStrings(items.enum, maxMcpEnumOptions, maxMcpEnumValueLength);
    return values?.map((option) => ({ value: option, title: option })) ?? null;
  }
  if (!hasOnlyKeys(items, ["anyOf"])) {
    return null;
  }
  return parseMcpTitledOptions(items.anyOf);
}

function parseMcpTitledOptions(value: unknown): CodexMcpElicitationOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxMcpEnumOptions) {
    return null;
  }
  const options: CodexMcpElicitationOption[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const option = asPlainObjectRecord(raw);
    if (
      !option ||
      !hasOnlyKeys(option, ["const", "title"]) ||
      !isBoundedString(option.const, maxMcpEnumValueLength) ||
      !isBoundedString(option.title, maxMcpFieldTextLength) ||
      seen.has(option.const)
    ) {
      return null;
    }
    seen.add(option.const);
    options.push({ value: option.const, title: option.title });
  }
  return options;
}

function parseMcpElicitationResponse(
  value: unknown,
  request: CodexMcpElicitationRequest,
): Record<string, unknown> | null {
  const response = asPlainObjectRecord(value);
  if (!response || !hasOnlyKeys(response, ["action", "content"])) {
    return null;
  }
  if (response.action === "decline" || response.action === "cancel") {
    return response.content === undefined || response.content === null
      ? { action: response.action, content: null }
      : null;
  }
  if (response.action !== "accept") {
    return null;
  }
  if (request.mode === "url") {
    return response.content === undefined || response.content === null
      ? { action: "accept", content: null }
      : null;
  }

  const content = asPlainObjectRecord(response.content);
  if (!content) {
    return null;
  }
  const fields = new Map(request.fields.map((field) => [field.name, field]));
  if (Object.keys(content).some((name) => !fields.has(name))) {
    return null;
  }
  const normalized: Record<string, CodexMcpElicitationValue> = {};
  for (const field of request.fields) {
    if (!Object.hasOwn(content, field.name)) {
      if (field.required) {
        return null;
      }
      continue;
    }
    const fieldValue = content[field.name];
    if (!isValidMcpFieldValue(fieldValue, field)) {
      return null;
    }
    normalized[field.name] = Array.isArray(fieldValue) ? [...fieldValue] : fieldValue;
  }
  return { action: "accept", content: normalized };
}

function cloneMcpElicitationRequest(
  request: CodexMcpElicitationRequest,
): CodexMcpElicitationRequest {
  if (request.mode === "url") {
    return { ...request };
  }
  return {
    ...request,
    fields: request.fields.map((field) => {
      if (field.type === "enum") {
        return {
          ...field,
          options: field.options.map((option) => ({ ...option })),
        };
      }
      if (field.type === "multi_select") {
        return {
          ...field,
          default: field.default ? [...field.default] : null,
          options: field.options.map((option) => ({ ...option })),
        };
      }
      return { ...field };
    }),
  };
}

function isValidMcpFieldValue(value: unknown, field: CodexMcpElicitationField): value is CodexMcpElicitationValue {
  if (field.type === "string") {
    return typeof value === "string" && isValidMcpStringValue(value, field);
  }
  if (field.type === "number" || field.type === "integer") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isSafeInteger(value)) &&
      (field.minimum === null || value >= field.minimum) &&
      (field.maximum === null || value <= field.maximum)
    );
  }
  if (field.type === "boolean") {
    return typeof value === "boolean";
  }
  if (field.type === "enum") {
    return typeof value === "string" && field.options.some((option) => option.value === value);
  }
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length &&
    (field.minItems === null || value.length >= field.minItems) &&
    (field.maxItems === null || value.length <= field.maxItems) &&
    value.every((item) => field.options.some((option) => option.value === item))
  );
}

function isValidMcpStringValue(
  value: string,
  field: Extract<CodexMcpElicitationField, { type: "string" }>,
): boolean {
  if (
    value.length > maxMcpStringValueLength ||
    (field.minLength !== null && value.length < field.minLength) ||
    (field.maxLength !== null && value.length > field.maxLength)
  ) {
    return false;
  }
  if (field.format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  }
  if (field.format === "uri") {
    try {
      return new URL(value).protocol.length > 1;
    } catch {
      return false;
    }
  }
  if (field.format === "date") {
    return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  }
  if (field.format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
  }
  return true;
}

function cancelledMcpElicitationResponse(): Record<string, unknown> {
  return { action: "cancel", content: null };
}

function isAllowedMcpUrl(value: unknown): value is string {
  if (!isBoundedNonEmptyString(value, maxMcpUrlLength) || value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function parsePermissionApprovalRequest(message: JsonRpcRequest): PermissionApprovalParseResult {
  if (message.method !== "item/permissions/requestApproval") {
    return { status: "not-applicable" };
  }
  const params = asPlainObjectRecord(message.params);
  if (
    !params ||
    !hasOnlyKeys(params, [
      "cwd",
      "environmentId",
      "itemId",
      "permissions",
      "reason",
      "startedAtMs",
      "threadId",
      "turnId",
    ]) ||
    !isBoundedNonEmptyString(params.cwd, maxPermissionPathLength) ||
    !isBoundedNonEmptyString(params.itemId, maxInteractiveIdentityLength) ||
    !Number.isSafeInteger(params.startedAtMs) ||
    !isBoundedNonEmptyString(params.threadId, maxInteractiveIdentityLength) ||
    !isBoundedNonEmptyString(params.turnId, maxInteractiveIdentityLength) ||
    !isNullableBoundedString(params.environmentId, maxInteractiveIdentityLength) ||
    !isNullableBoundedString(params.reason, maxInteractiveMessageLength)
  ) {
    return { status: "malformed", message: "Invalid params: malformed permission approval" };
  }
  const permissions = parsePermissionProfile(params.permissions);
  if (!permissions) {
    return { status: "malformed", message: "Invalid params: malformed permission approval" };
  }
  return {
    status: "supported",
    request: {
      id: randomUUID(),
      cwd: params.cwd,
      itemId: params.itemId,
      permissions,
      startedAtMs: params.startedAtMs as number,
      threadId: params.threadId,
      turnId: params.turnId,
      environmentId: (params.environmentId as string | null | undefined) ?? null,
      reason: (params.reason as string | null | undefined) ?? null,
    },
  };
}

function parsePermissionProfile(value: unknown): CodexPermissionProfile | null {
  const profile = asPlainObjectRecord(value);
  if (!profile || !hasOnlyKeys(profile, ["fileSystem", "network"])) {
    return null;
  }
  const result: CodexPermissionProfile = {};
  if (Object.hasOwn(profile, "fileSystem")) {
    if (profile.fileSystem === null) {
      result.fileSystem = null;
    } else {
      const fileSystem = parseAdditionalFileSystemPermissions(profile.fileSystem);
      if (!fileSystem) {
        return null;
      }
      result.fileSystem = fileSystem;
    }
  }
  if (Object.hasOwn(profile, "network")) {
    if (profile.network === null) {
      result.network = null;
    } else {
      const network = asPlainObjectRecord(profile.network);
      if (!network || !hasOnlyKeys(network, ["enabled"])) {
        return null;
      }
      const normalized: { enabled?: boolean | null } = {};
      if (Object.hasOwn(network, "enabled")) {
        if (network.enabled !== null && typeof network.enabled !== "boolean") {
          return null;
        }
        normalized.enabled = network.enabled as boolean | null;
      }
      result.network = normalized;
    }
  }
  return result;
}

function parseAdditionalFileSystemPermissions(
  value: unknown,
): CodexAdditionalFileSystemPermissions | null {
  const permissions = asPlainObjectRecord(value);
  if (!permissions || !hasOnlyKeys(permissions, ["entries", "globScanMaxDepth", "read", "write"])) {
    return null;
  }
  const result: CodexAdditionalFileSystemPermissions = {};
  if (Object.hasOwn(permissions, "entries")) {
    if (permissions.entries === null) {
      result.entries = null;
    } else if (Array.isArray(permissions.entries) && permissions.entries.length <= maxPermissionEntries) {
      const entries = permissions.entries.map(parseFileSystemPermissionEntry);
      if (entries.some((entry) => entry === null)) {
        return null;
      }
      result.entries = entries as CodexFileSystemPermissionEntry[];
    } else {
      return null;
    }
  }
  if (Object.hasOwn(permissions, "globScanMaxDepth")) {
    if (permissions.globScanMaxDepth === null) {
      result.globScanMaxDepth = null;
    } else if (
      Number.isSafeInteger(permissions.globScanMaxDepth) &&
      (permissions.globScanMaxDepth as number) >= 1 &&
      (permissions.globScanMaxDepth as number) <= maxPermissionGlobDepth
    ) {
      result.globScanMaxDepth = permissions.globScanMaxDepth as number;
    } else {
      return null;
    }
  }
  for (const key of ["read", "write"] as const) {
    if (!Object.hasOwn(permissions, key)) {
      continue;
    }
    if (permissions[key] === null) {
      result[key] = null;
      continue;
    }
    const paths = parseBoundedStrings(permissions[key], maxPermissionEntries, maxPermissionPathLength);
    if (!paths) {
      return null;
    }
    result[key] = paths;
  }
  return result;
}

function parseFileSystemPermissionEntry(value: unknown): CodexFileSystemPermissionEntry | null {
  const entry = asPlainObjectRecord(value);
  if (
    !entry ||
    !hasOnlyKeys(entry, ["access", "path"]) ||
    (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny")
  ) {
    return null;
  }
  const filePath = parsePermissionFileSystemPath(entry.path);
  return filePath ? { access: entry.access, path: filePath } : null;
}

function parsePermissionFileSystemPath(value: unknown): CodexFileSystemPath | null {
  const filePath = asPlainObjectRecord(value);
  if (!filePath) {
    return null;
  }
  if (
    filePath.type === "path" &&
    hasOnlyKeys(filePath, ["type", "path"]) &&
    isBoundedString(filePath.path, maxPermissionPathLength)
  ) {
    return { type: "path", path: filePath.path };
  }
  if (
    filePath.type === "glob_pattern" &&
    hasOnlyKeys(filePath, ["type", "pattern"]) &&
    isBoundedString(filePath.pattern, maxPermissionPathLength)
  ) {
    return { type: "glob_pattern", pattern: filePath.pattern };
  }
  if (filePath.type !== "special" || !hasOnlyKeys(filePath, ["type", "value"])) {
    return null;
  }
  const special = parsePermissionSpecialPath(filePath.value);
  return special ? { type: "special", value: special } : null;
}

function parsePermissionSpecialPath(value: unknown): CodexFileSystemSpecialPath | null {
  const special = asPlainObjectRecord(value);
  if (!special) {
    return null;
  }
  if (
    special.kind === "root" ||
    special.kind === "minimal" ||
    special.kind === "tmpdir" ||
    special.kind === "slash_tmp"
  ) {
    return hasOnlyKeys(special, ["kind"]) ? { kind: special.kind } : null;
  }
  if (special.kind === "project_roots") {
    if (
      !hasOnlyKeys(special, ["kind", "subpath"]) ||
      !isNullableBoundedString(special.subpath, maxPermissionPathLength)
    ) {
      return null;
    }
    return Object.hasOwn(special, "subpath")
      ? { kind: "project_roots", subpath: special.subpath as string | null }
      : { kind: "project_roots" };
  }
  if (
    special.kind === "unknown" &&
    hasOnlyKeys(special, ["kind", "path", "subpath"]) &&
    isBoundedString(special.path, maxPermissionPathLength) &&
    isNullableBoundedString(special.subpath, maxPermissionPathLength)
  ) {
    return Object.hasOwn(special, "subpath")
      ? { kind: "unknown", path: special.path, subpath: special.subpath as string | null }
      : { kind: "unknown", path: special.path };
  }
  return null;
}

function clonePermissionProfile(profile: CodexPermissionProfile): CodexPermissionProfile {
  return {
    ...(Object.hasOwn(profile, "fileSystem")
      ? {
          fileSystem:
            profile.fileSystem === null
              ? null
              : {
                  ...profile.fileSystem,
                  ...(Array.isArray(profile.fileSystem?.entries)
                    ? {
                        entries: profile.fileSystem.entries.map((entry) => ({
                          access: entry.access,
                          path: clonePermissionPath(entry.path),
                        })),
                      }
                    : {}),
                  ...(Array.isArray(profile.fileSystem?.read)
                    ? { read: [...profile.fileSystem.read] }
                    : {}),
                  ...(Array.isArray(profile.fileSystem?.write)
                    ? { write: [...profile.fileSystem.write] }
                    : {}),
                },
        }
      : {}),
    ...(Object.hasOwn(profile, "network")
      ? { network: profile.network === null ? null : { ...profile.network } }
      : {}),
  };
}

function clonePermissionPath(filePath: CodexFileSystemPath): CodexFileSystemPath {
  if (filePath.type === "path") {
    return { ...filePath };
  }
  if (filePath.type === "glob_pattern") {
    return { ...filePath };
  }
  return { type: "special", value: { ...filePath.value } };
}

function isPermissionApprovalDecision(value: unknown): value is CodexPermissionApprovalDecision {
  return value === "deny" || value === "grantTurn" || value === "grantSession";
}

function deniedPermissionApprovalResponse(): Record<string, unknown> {
  return { permissions: {}, scope: "turn" };
}

type NullableReadResult<T> = { ok: true; value: T | null } | { ok: false; value: null };

function readNullableText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): NullableReadResult<string> {
  return readNullableString(record, key, maxLength);
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): NullableReadResult<string> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return isBoundedString(value, maxLength)
    ? { ok: true, value }
    : { ok: false, value: null };
}

function readNullableBoolean(
  record: Record<string, unknown>,
  key: string,
): NullableReadResult<boolean> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, value: null };
}

function readNullableFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): NullableReadResult<number> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return typeof value === "number" && Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, value: null };
}

function readNullableBoundedInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): NullableReadResult<number> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? { ok: true, value: value as number }
    : { ok: false, value: null };
}

function readNullableStringArray(
  record: Record<string, unknown>,
  key: string,
  options: CodexMcpElicitationOption[],
): NullableReadResult<string[]> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (
    !Array.isArray(value) ||
    value.length > maxMcpEnumOptions ||
    !value.every((item) => typeof item === "string") ||
    new Set(value).size !== value.length ||
    !value.every((item) => options.some((option) => option.value === item))
  ) {
    return { ok: false, value: null };
  }
  return { ok: true, value: [...value] };
}

function readNullableStringFormat(value: unknown): NullableReadResult<"email" | "uri" | "date" | "date-time"> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  return value === "email" || value === "uri" || value === "date" || value === "date-time"
    ? { ok: true, value }
    : { ok: false, value: null };
}

function parseBoundedStrings(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every((item) => isBoundedString(item, maxLength))
  ) {
    return null;
  }
  return [...value];
}

function parseBoundedUniqueStrings(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  const strings = parseBoundedStrings(value, maxItems, maxLength);
  return strings && strings.length > 0 && new Set(strings).size === strings.length ? strings : null;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && value.length > 0;
}

function isSafeObjectKey(value: string): boolean {
  return value !== "__proto__" && value !== "prototype" && value !== "constructor";
}

function isNullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null || isBoundedString(value, maxLength);
}

function isBoundedOpaqueJson(value: unknown, maxLength: number): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length <= maxLength;
  } catch {
    return false;
  }
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

function parseThreadTokenUsage(value: unknown): CodexThreadTokenUsage | null {
  const record = asRecord(value);
  const last = parseTokenUsageBreakdown(record?.last);
  const total = parseTokenUsageBreakdown(record?.total);
  if (!last || !total) {
    return null;
  }
  const modelContextWindow = getNullableNonNegativeInteger(record, "modelContextWindow");
  if (record && "modelContextWindow" in record && modelContextWindow === undefined) {
    return null;
  }
  return {
    last,
    total,
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };
}

function parseTokenUsageBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const cachedInputTokens = getNonNegativeInteger(record, "cachedInputTokens");
  const inputTokens = getNonNegativeInteger(record, "inputTokens");
  const outputTokens = getNonNegativeInteger(record, "outputTokens");
  const reasoningOutputTokens = getNonNegativeInteger(record, "reasoningOutputTokens");
  const totalTokens = getNonNegativeInteger(record, "totalTokens");
  if (
    cachedInputTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
  ) {
    return null;
  }
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function getNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function getNullableNonNegativeInteger(
  record: Record<string, unknown> | null,
  key: string,
): number | null | undefined {
  if (!record || !(key in record)) {
    return undefined;
  }
  if (record[key] === null) {
    return null;
  }
  return getNonNegativeInteger(record, key);
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
  const match = value?.match(
    /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/u,
  );
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

function buildCollaborationMode(
  mode: CodexCollaborationMode,
  model: string,
): Record<string, unknown> {
  return {
    mode,
    settings: {
      model,
      developer_instructions: null,
    },
  };
}

function requireDefaultModel(result: unknown): string {
  const data = asRecord(result)?.data;
  const models: unknown[] = Array.isArray(data) ? data : [];
  const defaultModel = models
    .map((entry) => asRecord(entry))
    .find((entry) => entry?.isDefault === true);
  const model = getString(defaultModel, "model") ?? getString(defaultModel, "id");
  if (!model) {
    throw new Error("Codex app-server did not advertise a default model for collaboration mode.");
  }
  return model;
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

function deferServerRequestCallback(): Promise<void> {
  return delay(serverRequestCallbackGraceMs);
}

function isRequestId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length <= maxInteractiveIdentityLength) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
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
