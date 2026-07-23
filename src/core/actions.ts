import type { SenderIdentity } from "./identity.js";
import type { ChatView } from "./view-models.js";

export const stopRunAction = "stop_run";
export const retryRunAction = "retry_run";
export const resolveApprovalAction = "resolve_approval";
export const answerUserInputAction = "answer_user_input";
export const cancelUserInputAction = "cancel_user_input";
export const resolvePermissionApprovalAction = "resolve_permission_approval";
export const answerMcpElicitationAction = "answer_mcp_elicitation";
export const resolveMcpElicitationAction = "resolve_mcp_elicitation";
export const selectProjectAction = "select_project";
export const resumeThreadAction = "resume_thread";
export const pageProjectsAction = "page_projects";
export const pageSessionsAction = "page_sessions";
export const showRunDetailAction = "show_run_detail";

export type ChatActionKind =
  | typeof stopRunAction
  | typeof retryRunAction
  | typeof resolveApprovalAction
  | typeof answerUserInputAction
  | typeof cancelUserInputAction
  | typeof resolvePermissionApprovalAction
  | typeof answerMcpElicitationAction
  | typeof resolveMcpElicitationAction
  | typeof selectProjectAction
  | typeof resumeThreadAction
  | typeof pageProjectsAction
  | typeof pageSessionsAction
  | typeof showRunDetailAction;

export type ActionToastType = "success" | "warning" | "error" | "info";
export type RunDetailKind = "summary" | "files" | "diff" | "logs";
export type PermissionApprovalDecision = "deny" | "grantTurn" | "grantSession";
export type McpElicitationDecision = "accept" | "decline" | "cancel" | "skip";
export type InteractiveDecision = PermissionApprovalDecision | McpElicitationDecision;

export interface IncomingAction {
  adapterId?: string;
  action: ChatActionKind;
  chatId: string;
  messageId?: string;
  sender: SenderIdentity;
  approvalId?: string;
  decisionIndex?: number;
  userInputId?: string;
  questionId?: string;
  optionIndex?: number;
  requestId?: string;
  fieldId?: string;
  decision?: InteractiveDecision;
  detailKind?: RunDetailKind;
  projectIndex?: number;
  threadIndex?: number;
  page?: number;
}

export type ActionResponse =
  | { kind: "toast"; level: ActionToastType; text: string }
  | { kind: "replace_view"; view: ChatView };

export function actionToast(level: ActionToastType, text: string): ActionResponse {
  return { kind: "toast", level, text };
}

export function actionView(view: ChatView): ActionResponse {
  return { kind: "replace_view", view };
}

// Compatibility aliases retained for the v0.6 public API surface.
export const stopRunCardAction = stopRunAction;
export const retryRunCardAction = retryRunAction;
export const resolveApprovalCardAction = resolveApprovalAction;
export const answerUserInputCardAction = answerUserInputAction;
export const cancelUserInputCardAction = cancelUserInputAction;
export const resolvePermissionApprovalCardAction = resolvePermissionApprovalAction;
export const answerMcpElicitationCardAction = answerMcpElicitationAction;
export const resolveMcpElicitationCardAction = resolveMcpElicitationAction;
export const selectProjectCardAction = selectProjectAction;
export const resumeThreadCardAction = resumeThreadAction;
export const pageProjectsCardAction = pageProjectsAction;
export const pageSessionsCardAction = pageSessionsAction;
export const showRunDetailCardAction = showRunDetailAction;
export const cardActionToast = actionToast;
export type RunCardActionKind = ChatActionKind;
export type CardActionToastType = ActionToastType;
export type PermissionApprovalCardDecision = PermissionApprovalDecision;
export type McpElicitationCardDecision = McpElicitationDecision;
export type InteractiveCardDecision = InteractiveDecision;
export type IncomingCardAction = IncomingAction;
export type CardActionResponse = ActionResponse;
