import fs from "node:fs/promises";
import path from "node:path";

import * as lark from "@larksuiteoapi/node-sdk";

import type { BridgeConfig } from "../config/env.js";
import { JsonStateStore } from "../state/store.js";
import type { Logger } from "../util/logger.js";
import {
  adaptLarkTextEvent,
  type LarkBotIdentity,
  type LarkEventDiagnostic,
} from "./lark-event.js";
import { adaptLarkCardActionEvent, cardActionToast } from "./lark-card-action.js";
import {
  buildApprovalCard,
  type LarkInteractiveCard,
  buildRunStatusCard,
  type ApprovalCardInput,
  type RunStatusCardInput,
} from "./lark-card.js";
import { buildMarkdownPost } from "./lark-post.js";
import {
  MessageRouter,
  type DownloadedAttachment,
  type IncomingAttachment,
  type IncomingTextMessage,
  type StatusCardHandle,
} from "./message-router.js";

interface BotProbeResult {
  botName?: string;
  botOpenId?: string;
}

export async function runBridge(config: BridgeConfig, logger: Logger): Promise<void> {
  const domain = config.larkDomain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain,
  });

  const sendText = async (chatId: string, text: string) => {
    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  };

  const sender = {
    sendText,
    async sendMarkdown(chatId: string, markdown: string) {
      try {
        await client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: JSON.stringify(buildMarkdownPost(markdown)),
          },
        });
      } catch (error) {
        logger.warn("Failed to send markdown post; falling back to text", error);
        await sendText(chatId, markdown);
      }
    },
    async sendInteractiveCard(chatId: string, card: LarkInteractiveCard) {
      await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    },
    async updateInteractiveCard(messageId: string, card: LarkInteractiveCard) {
      await client.im.v1.message.patch({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
    },
    async downloadAttachment(
      message: IncomingTextMessage,
      attachment: IncomingAttachment,
    ): Promise<DownloadedAttachment> {
      const response = await client.im.v1.messageResource.get({
        params: {
          type: attachment.kind,
        },
        path: {
          message_id: message.messageId,
          file_key: attachment.key,
        },
      });
      const directory = path.join(
        config.attachmentDownloadDir,
        sanitizePathSegment(message.messageId),
      );
      await fs.mkdir(directory, { recursive: true });

      const fileName = buildAttachmentFileName(attachment, response.headers);
      const filePath = path.join(directory, fileName);
      await response.writeFile(filePath);
      return {
        kind: attachment.kind,
        name: attachment.name ?? fileName,
        path: filePath,
      };
    },
    async createStatusCard(
      chatId: string,
      input: RunStatusCardInput,
    ): Promise<StatusCardHandle> {
      const response = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildRunStatusCard(input)),
        },
      });
      const messageId = response.data?.message_id;
      if (!messageId) {
        throw new Error("Feishu/Lark did not return a message_id for the status card.");
      }
      return { messageId };
    },
    async updateStatusCard(
      handle: StatusCardHandle,
      input: RunStatusCardInput,
    ): Promise<void> {
      await client.im.v1.message.patch({
        path: {
          message_id: handle.messageId,
        },
        data: {
          content: JSON.stringify(buildRunStatusCard(input)),
        },
      });
    },
    async createApprovalCard(
      chatId: string,
      input: ApprovalCardInput,
    ): Promise<StatusCardHandle> {
      const response = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildApprovalCard(input)),
        },
      });
      const messageId = response.data?.message_id;
      if (!messageId) {
        throw new Error("Feishu/Lark did not return a message_id for the approval card.");
      }
      return { messageId };
    },
    async updateApprovalCard(
      handle: StatusCardHandle,
      input: ApprovalCardInput,
    ): Promise<void> {
      await client.im.v1.message.patch({
        path: {
          message_id: handle.messageId,
        },
        data: {
          content: JSON.stringify(buildApprovalCard(input)),
        },
      });
    },
  };

  const router = new MessageRouter(
    config,
    new JsonStateStore(config.bridgeStatePath),
    sender,
    logger,
  );
  await router.start();

  const botIdentity = await resolveBotIdentity(config, logger);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      const { incoming, diagnostic } = adaptLarkTextEvent(event, botIdentity);
      if (!incoming) {
        await router.recordEventDiagnostic("dropped", diagnostic);
        logDroppedEvent(logger, diagnostic);
        return;
      }

      await router.recordEventDiagnostic("routed", diagnostic);
      logRoutedEvent(logger, diagnostic);
      router.enqueue(incoming);
    },
    "card.action.trigger": async (event: unknown) => {
      const action = adaptLarkCardActionEvent(event);
      if (!action) {
        logger.warn("Ignored unknown Lark card action", { eventType: "card.action.trigger" });
        return cardActionToast("warning", "这个卡片操作已被忽略。");
      }
      return router.handleCardAction(action);
    },
  });

  const wsClient = new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain,
  });

  logger.info("Starting Feishu/Lark long-connection bridge", {
    domain: config.larkDomain,
    statePath: config.bridgeStatePath,
    defaultCwd: config.codexWorkdir,
    access: {
      allowDirectMessages: config.access.allowDirectMessages,
      allowGroups: config.access.allowGroups,
      allowedChatIds: config.access.allowedChatIds.length,
      allowedUserIds: config.access.allowedUserIds.length,
    },
    botIdentityResolved: Boolean(botIdentity.openId),
  });
  wsClient.start({ eventDispatcher });
}

function buildAttachmentFileName(attachment: IncomingAttachment, headers: unknown): string {
  if (attachment.kind === "file") {
    return sanitizeFileName(attachment.name ?? `file-${shortKey(attachment.key)}.bin`);
  }

  return sanitizeFileName(`image-${shortKey(attachment.key)}${imageExtension(headers)}`);
}

function imageExtension(headers: unknown): string {
  const contentType = headerValue(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
  switch (contentType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    default:
      return ".bin";
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  const record =
    typeof headers === "object" && headers !== null ? (headers as Record<string, unknown>) : null;
  const value = record?.[name] ?? record?.[name.toLowerCase()] ?? record?.[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? value : undefined;
}

function shortKey(key: string): string {
  return sanitizePathSegment(key).slice(0, 24) || "attachment";
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function sanitizeFileName(value: string): string {
  const sanitized = sanitizePathSegment(value);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "attachment.bin";
}

function logDroppedEvent(logger: Logger, diagnostic: LarkEventDiagnostic): void {
  logger.info("Dropped Lark event before routing", formatDiagnosticForLog(diagnostic));
}

function logRoutedEvent(logger: Logger, diagnostic: LarkEventDiagnostic): void {
  logger.info("Routing Lark message", formatDiagnosticForLog(diagnostic));
}

function formatDiagnosticForLog(diagnostic: LarkEventDiagnostic): Record<string, unknown> {
  return {
    reason: diagnostic.reason,
    messageId: diagnostic.messageId,
    chatId: diagnostic.chatId,
    chatType: diagnostic.chatType,
    messageType: diagnostic.messageType,
    mentionCount: diagnostic.mentionCount,
    startsWithMention: diagnostic.startsWithMention,
    attachmentCount: diagnostic.attachmentCount,
    textLength: diagnostic.textLength,
    botIdentityResolved: diagnostic.botIdentityResolved,
  };
}

async function resolveBotIdentity(
  config: BridgeConfig,
  logger: Logger,
): Promise<LarkBotIdentity> {
  if (config.feishuBotOpenId) {
    return { openId: config.feishuBotOpenId };
  }

  const bot = await probeBot(config.feishuAppId, config.feishuAppSecret, config.larkDomain);
  if (bot?.botOpenId) {
    return { openId: bot.botOpenId };
  }

  logger.warn(
    "Could not resolve Feishu/Lark bot open_id; group messages will be ignored until FEISHU_BOT_OPEN_ID is set.",
  );
  return {};
}

async function probeBot(
  appId: string,
  appSecret: string,
  domain: BridgeConfig["larkDomain"],
): Promise<BotProbeResult | null> {
  const baseUrl = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  try {
    const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenPayload = (await tokenResponse.json()) as {
      tenant_access_token?: string;
    };
    if (!tokenPayload.tenant_access_token) {
      return null;
    }

    const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: {
        Authorization: `Bearer ${tokenPayload.tenant_access_token}`,
        "Content-Type": "application/json",
      },
    });
    const botPayload = (await botResponse.json()) as {
      code?: number;
      bot?: { app_name?: string; bot_name?: string; open_id?: string };
      data?: { bot?: { app_name?: string; bot_name?: string; open_id?: string } };
    };
    if (botPayload.code !== 0) {
      return null;
    }
    const bot = botPayload.bot ?? botPayload.data?.bot;
    return {
      botName: bot?.app_name ?? bot?.bot_name,
      botOpenId: bot?.open_id,
    };
  } catch {
    return null;
  }
}
