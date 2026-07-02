export interface ChatSession {
  threadId?: string;
  cwd: string;
  chatType?: "direct" | "group";
  updatedAt: string;
  lastProjects?: ProjectSelection[];
  lastThreads?: ThreadSelection[];
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
