export interface ChatSession {
  threadId?: string;
  cwd: string;
  chatType?: "direct" | "group";
  updatedAt: string;
  lastProjects?: ProjectSelection[];
  lastThreads?: ThreadSelection[];
  lastTurns?: TurnSelection[];
  lastRun?: LastRunSummary;
}

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
  kind: "codex_run";
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  cwd: string;
  prompt: string;
  threadId?: string;
  status: DurableCodexJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: LastRunSummary;
  deliveryIds: string[];
  interruptionReason?: string;
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
