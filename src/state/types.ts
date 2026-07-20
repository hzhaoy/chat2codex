import { randomUUID } from "node:crypto";

export interface ChatSession {
  /** Rotated whenever the chat starts or selects a different logical Codex session. */
  sessionEpoch: string;
  threadId?: string;
  cwd: string;
  chatType?: "direct" | "group";
  updatedAt: string;
  lastProjects?: ProjectSelection[];
  lastThreads?: ThreadSelection[];
  lastTurns?: TurnSelection[];
  lastRun?: LastRunSummary;
}

/**
 * Creates an opaque, non-sensitive identity for one logical chat session.
 * Runtime app-server handles and permission grants must never be persisted here.
 */
export const createSessionEpoch = (): string => randomUUID();

export interface ProjectSelection {
  cwd: string;
  threadCount: number;
  updatedAt?: string;
  title?: string;
  preview?: string;
  latestThreadId?: string;
}

export interface ThreadSelection {
  threadId: string;
  cwd: string;
  title?: string;
  preview?: string;
  updatedAt?: string;
  resumable?: boolean;
  unavailableReason?: string;
}

export interface TurnSelection {
  threadId: string;
  turnId: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  summary?: string;
}

export type LastRunStatus = "success" | "failed" | "stopped";

export interface LastRunCommandSummary {
  command: string;
  cwd?: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputPreview?: string;
}

export interface LastRunReviewSummary {
  changedFiles: string[];
  diff?: string;
  diffStat?: string;
  fileChangeCount: number;
  commands: LastRunCommandSummary[];
}

export interface LastRunSummary {
  id: string;
  status: LastRunStatus;
  cwd: string;
  threadId?: string;
  promptPreview: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  finalTextPreview?: string;
  errorPreview?: string;
  review: LastRunReviewSummary;
}

export type EventDiagnosticOutcome = "routed" | "dropped";

export interface EventDiagnosticSnapshot {
  at: string;
  outcome: EventDiagnosticOutcome;
  reason?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  messageType?: string;
  mentionCount: number;
  startsWithMention: boolean;
  attachmentCount: number;
  textLength: number;
  botIdentityResolved: boolean;
}

export interface ChatDiagnostics {
  lastEvent?: EventDiagnosticSnapshot;
  lastDroppedEvent?: EventDiagnosticSnapshot;
  recentFailures?: RecentFailureDiagnostic[];
}

export interface BridgeDiagnostics extends ChatDiagnostics {
  byChat?: Record<string, ChatDiagnostics>;
}

export type FailureDiagnosticCategory =
  | "codex_missing"
  | "cwd_missing"
  | "app_server_timeout"
  | "approval_timeout"
  | "run_timeout"
  | "thread_unavailable"
  | "attachment_download_failed"
  | "unknown";

export interface RecentFailureDiagnostic {
  at: string;
  category: FailureDiagnosticCategory;
  cwd?: string;
  promptPreview?: string;
  threadId?: string;
  exitCode?: number | null;
  signal?: string | null;
  detail: string;
  hint?: string;
}

export type PendingMessageRoute =
  | "codex"
  | "control_replay_safe"
  | "control_no_replay"
  | "message";

export interface PendingMessageDelivery {
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  sender: {
    openId?: string;
    userId?: string;
    unionId?: string;
  };
  text: string;
  attachments?: Array<{
    kind: "image" | "file";
    key: string;
    name?: string;
  }>;
  acceptedAt: string;
  attempts: number;
  lastError?: string;
  /**
   * Added after the initial durable-inbox rollout. Missing values are
   * classified conservatively during recovery for state-file compatibility.
   */
  route?: PendingMessageRoute;
}

export type DurableCodexJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface DurableCodexJob {
  id: string;
  kind: "codex_run" | "control_recovery";
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  cwd: string;
  prompt: string;
  /** Missing on pre-v0.5 state files and therefore treated as default mode. */
  collaborationMode?: "default" | "plan";
  threadId?: string;
  status: DurableCodexJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: LastRunSummary;
  deliveryIds: string[];
  interruptionReason?: string;
  /** A durable singleton used to suppress repeated queue-full replies. */
  capacityNoticeScope?: "global" | "chat";
  capacityNoticeKind?: "durable" | "inbox";
  capacityNoticeActive?: boolean;
}

export type DurableOutboxStatus = "pending" | "sending" | "delivered";

export interface DurableOutboxMessage {
  id: string;
  jobId: string;
  chatId: string;
  kind: "text" | "markdown";
  text: string;
  sequence: number;
  status: DurableOutboxStatus;
  idempotencyKey: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface BridgeState {
  chats: Record<string, ChatSession>;
  jobs: Record<string, DurableCodexJob>;
  outbox: Record<string, DurableOutboxMessage>;
  pendingMessages: Record<string, PendingMessageDelivery>;
  processedMessageIds: string[];
  diagnostics: BridgeDiagnostics;
}

export const emptyState = (): BridgeState => ({
  chats: {},
  jobs: {},
  outbox: {},
  pendingMessages: {},
  processedMessageIds: [],
  diagnostics: {},
});
