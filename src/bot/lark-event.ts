import { extractTextContent } from "../util/text.js";
import { normalizeChatType, type ChatType, type SenderIdentity } from "./access-control.js";
import type { IncomingAttachment, IncomingTextMessage } from "./message-router.js";

export interface LarkBotIdentity {
  openId?: string;
}

export interface LarkEventDiagnostic {
  reason?:
    | "missing_message"
    | "unsupported_message_type"
    | "empty_message"
    | "group_without_bot_mention"
    | "missing_ids";
  messageId?: string;
  chatId?: string;
  chatType?: ChatType;
  messageType?: string;
  mentionCount: number;
  startsWithMention: boolean;
  attachmentCount: number;
  textLength: number;
  botIdentityResolved: boolean;
}

export interface LarkEventAdaptation {
  incoming: IncomingTextMessage | null;
  diagnostic: LarkEventDiagnostic;
}

export function toIncomingTextMessage(
  event: unknown,
  botIdentity: LarkBotIdentity,
): IncomingTextMessage | null {
  return adaptLarkTextEvent(event, botIdentity).incoming;
}

export function adaptLarkTextEvent(
  event: unknown,
  botIdentity: LarkBotIdentity,
): LarkEventAdaptation {
  const eventRecord = asRecord(event);
  const message = asRecord(eventRecord?.message);
  if (!message) {
    return dropped({
      reason: "missing_message",
      mentionCount: 0,
      startsWithMention: false,
      attachmentCount: 0,
      textLength: 0,
      botIdentityResolved: Boolean(botIdentity.openId),
    });
  }

  const messageType = getString(message, "message_type");
  const diagnosticBase = buildDiagnosticBase(message, botIdentity, messageType);
  const content = parseContent(message);
  const attachments = extractAttachments(messageType, content);
  if (!isSupportedMessageType(messageType)) {
    return dropped({ ...diagnosticBase, reason: "unsupported_message_type" });
  }

  const text = extractMessageText(messageType, message, content);
  if (!text && attachments.length === 0) {
    return dropped({ ...diagnosticBase, reason: "empty_message" });
  }

  const chatType = normalizeChatType(message.chat_type);
  if (chatType === "group" && !messageMentionsBot(message, botIdentity)) {
    return dropped({ ...diagnosticBase, chatType, reason: "group_without_bot_mention" });
  }

  const messageId = getString(message, "message_id");
  const chatId = getString(message, "chat_id");
  if (!messageId || !chatId) {
    return dropped({ ...diagnosticBase, chatType, reason: "missing_ids" });
  }

  return {
    incoming: {
      messageId,
      chatId,
      chatType,
      sender: extractSenderIdentity(event),
      text: text ?? "",
      attachments,
    },
    diagnostic: {
      ...diagnosticBase,
      messageId,
      chatId,
      chatType,
    },
  };
}

export function messageMentionsBot(message: unknown, botIdentity: LarkBotIdentity): boolean {
  const botOpenId = botIdentity.openId?.trim();
  if (!botOpenId) {
    return false;
  }

  const listedMention = extractMentions(message).some((mention) => {
    const id = asRecord(mention.id);
    return getString(id, "open_id") === botOpenId;
  });
  if (listedMention) {
    return true;
  }

  const messageRecord = asRecord(message);
  const content = messageRecord ? parseContent(messageRecord) : null;
  if (!content) {
    return false;
  }
  return flattenPostNodes(content).some((node) => {
    if (getString(node, "tag") !== "at") {
      return false;
    }
    return [getString(node, "open_id"), getString(node, "user_id"), getString(node, "id")].includes(
      botOpenId,
    );
  });
}

export function extractSenderIdentity(event: unknown): SenderIdentity {
  const eventRecord = asRecord(event);
  const senderId = asRecord(asRecord(eventRecord?.sender)?.sender_id);
  const messageSenderId = asRecord(asRecord(asRecord(eventRecord?.message)?.sender)?.sender_id);

  return {
    openId: getString(senderId, "open_id") ?? getString(messageSenderId, "open_id"),
    userId: getString(senderId, "user_id") ?? getString(messageSenderId, "user_id"),
    unionId: getString(senderId, "union_id") ?? getString(messageSenderId, "union_id"),
  };
}

function extractMentions(message: unknown): Array<Record<string, unknown>> {
  const mentions = asRecord(message)?.mentions;
  if (!Array.isArray(mentions)) {
    return [];
  }
  return mentions.flatMap((mention) => {
    const record = asRecord(mention);
    return record ? [record] : [];
  });
}

function buildDiagnosticBase(
  message: Record<string, unknown>,
  botIdentity: LarkBotIdentity,
  messageType?: string,
): LarkEventDiagnostic {
  const content = parseContent(message);
  const text = extractMessageText(messageType, message, content) ?? "";
  return {
    messageId: getString(message, "message_id"),
    chatId: getString(message, "chat_id"),
    chatType: normalizeChatType(message.chat_type),
    messageType,
    mentionCount: extractMentions(message).length,
    startsWithMention: startsWithMention(text),
    attachmentCount: extractAttachments(messageType, content).length,
    textLength: text.length,
    botIdentityResolved: Boolean(botIdentity.openId),
  };
}

function isSupportedMessageType(messageType: string | undefined): boolean {
  return (
    messageType === "text" ||
    messageType === "post" ||
    messageType === "image" ||
    messageType === "file"
  );
}

function extractAttachments(
  messageType: string | undefined,
  content: Record<string, unknown> | null,
): IncomingAttachment[] {
  if (messageType !== "image" && messageType !== "file" && messageType !== "post") {
    return [];
  }

  if (!content) {
    return [];
  }

  if (messageType === "image") {
    const key = getString(content, "image_key");
    return key ? [{ kind: "image", key }] : [];
  }

  if (messageType === "post") {
    return extractPostAttachments(content);
  }

  const key = getString(content, "file_key");
  if (!key) {
    return [];
  }
  return [
    {
      kind: "file",
      key,
      name: getString(content, "file_name"),
    },
  ];
}

function extractPostAttachments(content: Record<string, unknown>): IncomingAttachment[] {
  const attachments: IncomingAttachment[] = [];
  const seen = new Set<string>();
  for (const node of flattenPostNodes(content)) {
    const tag = getString(node, "tag");
    const imageKey = getString(node, "image_key") ?? getString(node, "img_key");
    if ((tag === "img" || imageKey) && imageKey) {
      pushAttachment(attachments, seen, { kind: "image", key: imageKey });
      continue;
    }

    const fileKey = getString(node, "file_key");
    if (fileKey) {
      pushAttachment(attachments, seen, {
        kind: "file",
        key: fileKey,
        name: getString(node, "file_name") ?? getString(node, "name"),
      });
    }
  }
  return attachments;
}

function pushAttachment(
  attachments: IncomingAttachment[],
  seen: Set<string>,
  attachment: IncomingAttachment,
): void {
  const id = `${attachment.kind}:${attachment.key}`;
  if (seen.has(id)) {
    return;
  }
  seen.add(id);
  attachments.push(attachment);
}

function extractMessageText(
  messageType: string | undefined,
  message: Record<string, unknown>,
  content: Record<string, unknown> | null,
): string | null {
  if (messageType !== "post") {
    return extractTextContent(getString(message, "content"));
  }

  if (!content) {
    return null;
  }

  const text = flattenPostNodes(content)
    .flatMap((node) => {
      const tag = getString(node, "tag");
      if (tag === "text" || tag === "a" || tag === "at") {
        return getString(node, "text") ?? getString(node, "name") ?? "";
      }
      return [];
    })
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return text || null;
}

function flattenPostNodes(content: Record<string, unknown>): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  for (const root of postRoots(content)) {
    collectPostNodes(root, nodes);
  }
  return nodes;
}

function postRoots(content: Record<string, unknown>): unknown[] {
  const roots: unknown[] = [content];
  const post = asRecord(content.post);
  if (post) {
    roots.push(post);
  }

  for (const locale of ["zh_cn", "en_us", "ja_jp", "zh_hk", "zh_tw"] as const) {
    const root = asRecord(content[locale]) ?? asRecord(post?.[locale]);
    if (root) {
      roots.push(root);
    }
  }
  return roots;
}

function collectPostNodes(value: unknown, nodes: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPostNodes(item, nodes);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  if (typeof record.tag === "string") {
    nodes.push(record);
  }

  collectPostNodes(record.content, nodes);
}

function parseContent(message: Record<string, unknown>): Record<string, unknown> | null {
  const raw = getString(message, "content");
  if (!raw) {
    return null;
  }

  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function dropped(diagnostic: LarkEventDiagnostic): LarkEventAdaptation {
  return {
    incoming: null,
    diagnostic,
  };
}

function startsWithMention(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("@") || /^<at\b/iu.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}
