export interface ChatSession {
  threadId?: string;
  cwd: string;
  chatType?: "direct" | "group";
  updatedAt: string;
  lastProjects?: ProjectSelection[];
  lastThreads?: ThreadSelection[];
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

export interface BridgeDiagnostics {
  lastEvent?: EventDiagnosticSnapshot;
  lastDroppedEvent?: EventDiagnosticSnapshot;
  recentFailures?: RecentFailureDiagnostic[];
}

export type FailureDiagnosticCategory =
  | "codex_missing"
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

export interface BridgeState {
  chats: Record<string, ChatSession>;
  processedMessageIds: string[];
  diagnostics: BridgeDiagnostics;
}

export const emptyState = (): BridgeState => ({
  chats: {},
  processedMessageIds: [],
  diagnostics: {},
});
