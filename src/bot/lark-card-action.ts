import type { SenderIdentity } from "./access-control.js";

export const runCardActionApp = "chat2codex";
export const stopRunCardAction = "stop_run";
export const retryRunCardAction = "retry_run";
export const resolveApprovalCardAction = "resolve_approval";
export const selectProjectCardAction = "select_project";
export const resumeThreadCardAction = "resume_thread";
export const pageProjectsCardAction = "page_projects";
export const pageSessionsCardAction = "page_sessions";
export const stopRunCardActionValue = Object.freeze({
  app: runCardActionApp,
  action: stopRunCardAction,
});
export const retryRunCardActionValue = Object.freeze({
  app: runCardActionApp,
  action: retryRunCardAction,
});

export type RunCardActionKind =
  | typeof stopRunCardAction
  | typeof retryRunCardAction
  | typeof resolveApprovalCardAction
  | typeof selectProjectCardAction
  | typeof resumeThreadCardAction
  | typeof pageProjectsCardAction
  | typeof pageSessionsCardAction;
export type CardActionToastType = "success" | "warning" | "error" | "info";

export interface IncomingCardAction {
  action: RunCardActionKind;
  chatId: string;
  messageId?: string;
  sender: SenderIdentity;
  approvalId?: string;
  decisionIndex?: number;
  projectIndex?: number;
  threadIndex?: number;
  page?: number;
}

export interface CardActionToastResponse {
  toast: {
    type: CardActionToastType;
    content: string;
  };
}

export interface CardActionCardResponse {
  card: {
    type: "raw";
    data: unknown;
  };
}

export type CardActionResponse = CardActionToastResponse | CardActionCardResponse;

export function cardActionToast(type: CardActionToastType, content: string): CardActionResponse {
  return {
    toast: {
      type,
      content,
    },
  };
}

export function cardActionCard(card: unknown): CardActionResponse {
  return {
    card: {
      type: "raw",
      data: card,
    },
  };
}

export function adaptLarkCardActionEvent(event: unknown): IncomingCardAction | null {
  const source = eventSource(event);
  if (!source) {
    return null;
  }

  const action = asRecord(source.action);
  const actionKind = getRunCardActionKind(action?.value);
  if (!actionKind) {
    return null;
  }

  const context = asRecord(source.context);
  const chatId = getString(context, "open_chat_id") ?? getString(source, "open_chat_id");
  if (!chatId) {
    return null;
  }

  const operator = asRecord(source.operator);
  const value = asRecord(action?.value);
  return {
    action: actionKind,
    chatId,
    messageId: getString(context, "open_message_id") ?? getString(source, "open_message_id"),
    sender: {
      openId: getString(operator, "open_id"),
      userId: getString(operator, "user_id"),
      unionId: getString(operator, "union_id"),
    },
    approvalId: getString(value, "approvalId"),
    decisionIndex: getNumber(value, "decisionIndex"),
    projectIndex: getNumber(value, "projectIndex"),
    threadIndex: getNumber(value, "threadIndex"),
    page: getNumber(value, "page"),
  };
}

function eventSource(event: unknown): Record<string, unknown> | null {
  const record = asRecord(event);
  if (!record) {
    return null;
  }
  return asRecord(record.event) ?? record;
}

function getRunCardActionKind(value: unknown): RunCardActionKind | null {
  const record = asRecord(value);
  if (getString(record, "app") !== runCardActionApp) {
    return null;
  }

  const action = getString(record, "action");
  if (
    action === stopRunCardAction ||
    action === retryRunCardAction ||
    action === resolveApprovalCardAction ||
    action === selectProjectCardAction ||
    action === resumeThreadCardAction ||
    action === pageProjectsCardAction ||
    action === pageSessionsCardAction
  ) {
    return action;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function getNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
