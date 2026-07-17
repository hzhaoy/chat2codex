import type { AccessControlConfig } from "../config/env.js";

export type ChatType = "direct" | "group";

export interface SenderIdentity {
  openId?: string;
  userId?: string;
  unionId?: string;
}

export interface AccessContext {
  chatId: string;
  chatType: ChatType;
  sender: SenderIdentity;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: "sender_not_allowed" | "direct_messages_disabled" | "groups_disabled" | "chat_not_allowed";
}

export function decideAccess(
  config: AccessControlConfig,
  context: AccessContext,
): AccessDecision {
  if (context.chatType === "direct") {
    if (!config.allowDirectMessages) {
      return { allowed: false, reason: "direct_messages_disabled" };
    }
    if (
      config.allowedChatIds.includes(context.chatId) ||
      senderMatchesAllowedUser(context.sender, config.allowedUserIds)
    ) {
      return { allowed: true };
    }
    return { allowed: false, reason: "sender_not_allowed" };
  }

  if (!config.allowGroups) {
    return { allowed: false, reason: "groups_disabled" };
  }
  if (!config.allowedChatIds.includes(context.chatId)) {
    return { allowed: false, reason: "chat_not_allowed" };
  }
  if (!senderMatchesAllowedUser(context.sender, config.allowedUserIds)) {
    return { allowed: false, reason: "sender_not_allowed" };
  }
  return { allowed: true };
}

export function normalizeChatType(value: unknown): ChatType {
  if (typeof value !== "string") {
    return "group";
  }

  const normalized = value.trim().toLowerCase();
  if (["p2p", "direct", "private", "dm"].includes(normalized)) {
    return "direct";
  }
  return "group";
}

export function senderMatchesAllowedUser(
  sender: SenderIdentity,
  allowedUserIds: string[],
): boolean {
  const ids = [sender.openId, sender.userId, sender.unionId].filter((value): value is string =>
    Boolean(value),
  );
  return ids.some((id) => allowedUserIds.includes(id));
}
