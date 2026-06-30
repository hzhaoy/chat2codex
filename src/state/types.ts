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
