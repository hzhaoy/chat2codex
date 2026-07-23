import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexMcpElicitationRequest,
  CodexPermissionApprovalDecision,
  CodexPermissionApprovalRequest,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "../agent/codex-runner.js";

export type RunStatusViewStatus = "running" | "success" | "failed" | "stopped";
export type ApprovalViewStatus = "pending" | "resolved" | "cancelled";
export type UserInputViewStatus = "pending" | "resolved" | "cancelled" | "expired";
export type PermissionApprovalViewStatus =
  | "pending"
  | "resolved"
  | "declined"
  | "cancelled"
  | "expired";
export type McpElicitationViewStatus =
  | "pending"
  | "resolved"
  | "declined"
  | "cancelled"
  | "expired";

export interface RunStatusViewInput {
  status: RunStatusViewStatus;
  detail: string;
  cwd: string;
  prompt: string;
  startedAt: string;
  updatedAt?: string;
  result?: RunResultViewInput;
}

export interface RunResultViewInput {
  threadId?: string;
  durationMs?: number;
  changedFileCount?: number;
  commandCount?: number;
  failedCommandCount?: number;
  diffAvailable?: boolean;
  logsAvailable?: boolean;
  filesPreview?: string[];
  statusNote?: string;
}

export interface ApprovalViewInput {
  status: ApprovalViewStatus;
  request: CodexApprovalRequest;
  decision?: CodexApprovalDecision;
  updatedAt: string;
}

export interface UserInputViewInput {
  status: UserInputViewStatus;
  request: CodexUserInputRequest;
  replyCode: string;
  answers?: CodexUserInputResponse["answers"];
  updatedAt: string;
}

export type PermissionApprovalViewRequest = Pick<
  CodexPermissionApprovalRequest,
  "id" | "cwd" | "permissions"
> &
  Partial<
    Pick<
      CodexPermissionApprovalRequest,
      "environmentId" | "itemId" | "reason" | "startedAtMs" | "threadId" | "turnId"
    >
  >;

export interface PermissionApprovalViewInput {
  status: PermissionApprovalViewStatus;
  request: PermissionApprovalViewRequest;
  decision?: CodexPermissionApprovalDecision;
  updatedAt: string;
}

export type McpElicitationViewRequest = CodexMcpElicitationRequest;

export interface McpElicitationViewInput {
  status: McpElicitationViewStatus;
  request: McpElicitationViewRequest;
  updatedAt: string;
  replyCode?: string;
  /** Only field ids are needed for progress; answer values must never enter a view. */
  answeredFieldIds?: string[];
}

export interface ProjectListViewInput {
  currentCwd: string;
  projects: ProjectViewItem[];
  page?: number;
  pageSize?: number;
  selectedProjectIndex?: number;
  status?: "active" | "selected";
}

export interface ProjectViewItem {
  cwd: string;
  threadCount: number;
  updatedAt?: string;
  title?: string;
  preview?: string;
}

export interface SessionListViewInput {
  cwd: string;
  currentThreadId?: string;
  sessions: SessionViewItem[];
  title?: string;
  contextLabel?: string;
  note?: string;
  page?: number;
  pageSize?: number;
  selectedThreadIndex?: number;
  status?: "active" | "selected";
}

export interface SessionViewItem {
  threadId: string;
  title?: string;
  updatedAt?: string;
  preview?: string;
  resumable?: boolean;
  unavailableReason?: string;
}

export interface HostHealthViewInput {
  title: string;
  status: "ok" | "warn" | "error";
  host: string;
  platform: string;
  uptime: string;
  queueDepth: number;
  activeRun: string;
  approvalWait: string;
  codexBin: string;
  codexVersion: string;
  defaultCwd: string;
  sandbox: string;
  approvalPolicy: string;
  runTimeout: string;
  approvalTimeout: string;
  access: string;
  statePath: string;
  attachmentDir: string;
  lastEvent?: string;
  lastFailure?: string;
  warnings: string[];
}

/** Platform-neutral outbound presentation contract. */
export type ChatView =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "run_status"; input: RunStatusViewInput }
  | { kind: "approval"; input: ApprovalViewInput }
  | { kind: "user_input"; input: UserInputViewInput }
  | { kind: "permission_approval"; input: PermissionApprovalViewInput }
  | { kind: "mcp_elicitation"; input: McpElicitationViewInput }
  | { kind: "project_list"; input: ProjectListViewInput }
  | { kind: "session_list"; input: SessionListViewInput }
  | { kind: "host_health"; input: HostHealthViewInput };

// Compatibility names retained for the v0.6 internal import surface.
export type RunStatusCardStatus = RunStatusViewStatus;
export type ApprovalCardStatus = ApprovalViewStatus;
export type UserInputCardStatus = UserInputViewStatus;
export type PermissionApprovalCardStatus = PermissionApprovalViewStatus;
export type McpElicitationCardStatus = McpElicitationViewStatus;
export type RunStatusCardInput = RunStatusViewInput;
export type RunResultCardInput = RunResultViewInput;
export type ApprovalCardInput = ApprovalViewInput;
export type UserInputCardInput = UserInputViewInput;
export type PermissionApprovalCardRequest = PermissionApprovalViewRequest;
export type PermissionApprovalCardInput = PermissionApprovalViewInput;
export type McpElicitationCardRequest = McpElicitationViewRequest;
export type McpElicitationCardInput = McpElicitationViewInput;
export type ProjectListCardInput = ProjectListViewInput;
export type ProjectCardItem = ProjectViewItem;
export type SessionListCardInput = SessionListViewInput;
export type SessionCardItem = SessionViewItem;
export type HostHealthCardInput = HostHealthViewInput;
