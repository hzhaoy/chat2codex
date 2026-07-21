import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

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
  buildMcpElicitationCard,
  buildPermissionApprovalCard,
  buildRunStatusCard,
  buildUserInputCard,
  type ApprovalCardInput,
  type LarkInteractiveCard,
  type McpElicitationCardInput,
  type PermissionApprovalCardInput,
  type RunStatusCardInput,
  type UserInputCardInput,
} from "./lark-card.js";
import { buildMarkdownPost } from "./lark-post.js";
import {
  MessageRouter,
  type ChatDeliveryOptions,
  type DownloadedAttachment,
  type IncomingAttachment,
  type IncomingTextMessage,
  type StatusCardHandle,
} from "./message-router.js";

interface BotProbeResult {
  botName?: string;
  botOpenId?: string;
}

interface AttachmentDownloadResponse {
  headers: unknown;
  getReadableStream(): Readable;
}

interface BridgeWebSocketClient {
  close(params?: { force?: boolean }): void;
}

interface BridgeMessageRouter {
  dispose(): void | Promise<void>;
}

export interface BridgeRuntime {
  dispose(): Promise<void>;
}

export async function runBridge(
  config: BridgeConfig,
  logger: Logger,
  requestRestart?: () => void,
): Promise<BridgeRuntime> {
  const domain = config.larkDomain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain,
  });

  const sendText = async (chatId: string, text: string, options?: ChatDeliveryOptions) => {
    await client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        ...(options?.idempotencyKey ? { uuid: options.idempotencyKey } : {}),
      },
    });
  };

  const sender = {
    sendText,
    async sendMarkdown(chatId: string, markdown: string, options?: ChatDeliveryOptions) {
      try {
        await client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: JSON.stringify(buildMarkdownPost(markdown)),
            ...(options?.idempotencyKey ? { uuid: options.idempotencyKey } : {}),
          },
        });
      } catch (error) {
        logger.warn("Failed to send markdown post; falling back to text", error);
        await sendText(chatId, markdown, options);
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
        sanitizeMessageDirectoryName(message.messageId),
      );
      const downloadRoot = await ensurePrivateDirectory(config.attachmentDownloadDir);
      const resolvedDirectory = await ensurePrivateDirectory(directory);
      assertPathInside(downloadRoot, resolvedDirectory);

      const fileName = buildAttachmentFileName(attachment, response.headers);
      const filePath = path.join(resolvedDirectory, fileName);
      await writeAttachmentResponseAtomically(
        response,
        downloadRoot,
        filePath,
        config.attachmentMaxFileBytes,
      );
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
    async createUserInputCard(
      chatId: string,
      input: UserInputCardInput,
    ): Promise<StatusCardHandle> {
      const response = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildUserInputCard(input)),
        },
      });
      const messageId = response.data?.message_id;
      if (!messageId) {
        throw new Error("Feishu/Lark did not return a message_id for the user-input card.");
      }
      return { messageId };
    },
    async updateUserInputCard(
      handle: StatusCardHandle,
      input: UserInputCardInput,
    ): Promise<void> {
      await client.im.v1.message.patch({
        path: {
          message_id: handle.messageId,
        },
        data: {
          content: JSON.stringify(buildUserInputCard(input)),
        },
      });
    },
    async createPermissionApprovalCard(
      chatId: string,
      input: PermissionApprovalCardInput,
    ): Promise<StatusCardHandle> {
      const response = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildPermissionApprovalCard(input)),
        },
      });
      const messageId = response.data?.message_id;
      if (!messageId) {
        throw new Error(
          "Feishu/Lark did not return a message_id for the permission-approval card.",
        );
      }
      return { messageId };
    },
    async updatePermissionApprovalCard(
      handle: StatusCardHandle,
      input: PermissionApprovalCardInput,
    ): Promise<void> {
      await client.im.v1.message.patch({
        path: {
          message_id: handle.messageId,
        },
        data: {
          content: JSON.stringify(buildPermissionApprovalCard(input)),
        },
      });
    },
    async createMcpElicitationCard(
      chatId: string,
      input: McpElicitationCardInput,
    ): Promise<StatusCardHandle> {
      const response = await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(buildMcpElicitationCard(input)),
        },
      });
      const messageId = response.data?.message_id;
      if (!messageId) {
        throw new Error("Feishu/Lark did not return a message_id for the MCP-elicitation card.");
      }
      return { messageId };
    },
    async updateMcpElicitationCard(
      handle: StatusCardHandle,
      input: McpElicitationCardInput,
    ): Promise<void> {
      await client.im.v1.message.patch({
        path: {
          message_id: handle.messageId,
        },
        data: {
          content: JSON.stringify(buildMcpElicitationCard(input)),
        },
      });
    },
  };

  const router = new MessageRouter(
    config,
    new JsonStateStore(config.bridgeStatePath, {
      jobRetentionCount: config.jobRetentionCount,
      outboxRetentionCount: config.outboxRetentionCount,
    }),
    sender,
    logger,
    undefined,
    { requestRestart },
  );
  let wsClient: lark.WSClient | undefined;
  try {
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
        await router.accept(incoming);
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

    wsClient = new lark.WSClient({
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
    await wsClient.start({ eventDispatcher });
    return createBridgeRuntime(wsClient, router);
  } catch (error) {
    try {
      await createBridgeRuntime(wsClient, router).dispose();
    } catch (disposeError) {
      logger.error("Failed to clean up the bridge after startup failed", disposeError);
    }
    throw error;
  }
}

function createBridgeRuntime(
  wsClient: BridgeWebSocketClient | undefined,
  router: BridgeMessageRouter,
): BridgeRuntime {
  let disposePromise: Promise<void> | undefined;
  return {
    dispose() {
      disposePromise ??= disposeBridgeRuntime(wsClient, router);
      return disposePromise;
    },
  };
}

async function disposeBridgeRuntime(
  wsClient: BridgeWebSocketClient | undefined,
  router: BridgeMessageRouter,
): Promise<void> {
  let webSocketError: unknown;
  try {
    wsClient?.close();
  } catch (error) {
    webSocketError = error;
  }

  try {
    await router.dispose();
  } catch (routerError) {
    if (webSocketError !== undefined) {
      throw new AggregateError(
        [webSocketError, routerError],
        "Failed to dispose the Feishu/Lark bridge",
      );
    }
    throw routerError;
  }

  if (webSocketError !== undefined) {
    throw webSocketError;
  }
}

// Exported solely so shutdown ordering and idempotency can be tested without opening a socket.
export const createBridgeRuntimeForTest = createBridgeRuntime;

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Attachment directory is not a private directory: ${directory}`);
  }
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}

async function writeAttachmentResponseAtomically(
  response: AttachmentDownloadResponse,
  downloadRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<number> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Attachment byte limit must be a positive safe integer.");
  }

  const resolvedRoot = path.resolve(downloadRoot);
  const resolvedFilePath = path.resolve(filePath);
  assertPathInside(resolvedRoot, resolvedFilePath);

  const temporaryPath = path.join(
    path.dirname(resolvedFilePath),
    `.${path.basename(resolvedFilePath)}.${randomUUID()}.part`,
  );
  assertPathInside(resolvedRoot, temporaryPath);

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let readable: Readable | undefined;
  let bytesWritten = 0;

  try {
    const contentLength = attachmentContentLength(response.headers);
    if (contentLength !== undefined && contentLength > maxBytes) {
      throw attachmentTooLargeError(maxBytes);
    }

    handle = await fs.open(temporaryPath, "wx", 0o600);
    readable = response.getReadableStream();
    for await (const chunk of readable) {
      const buffer = attachmentChunkBuffer(chunk);
      if (bytesWritten + buffer.byteLength > maxBytes) {
        readable.destroy();
        throw attachmentTooLargeError(maxBytes);
      }
      await writeAll(handle, buffer);
      bytesWritten += buffer.byteLength;
    }

    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, resolvedFilePath);
    await fs.chmod(resolvedFilePath, 0o600);
    return bytesWritten;
  } catch (error) {
    readable?.destroy();
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await Promise.allSettled([
      fs.rm(temporaryPath, { force: true }),
      fs.rm(resolvedFilePath, { force: true }),
    ]);
    throw error;
  }
}

// Exported solely so the byte-limit and atomic-file guarantees can be tested without mocking the SDK.
export const writeAttachmentResponseAtomicallyForTest = writeAttachmentResponseAtomically;

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error("Attachment download stopped before the current chunk was written.");
    }
    offset += bytesWritten;
  }
}

function attachmentChunkBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  throw new Error("Attachment stream returned an unsupported chunk type.");
}

function attachmentContentLength(headers: unknown): number | undefined {
  const value = headerValue(headers, "content-length")?.trim();
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

function attachmentTooLargeError(maxBytes: number): Error {
  return new Error(`Attachment exceeds the configured ${maxBytes}-byte per-file limit.`);
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Attachment path escapes the configured download directory.");
  }
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
  const getter = record?.get;
  const getterValue =
    typeof getter === "function" ? (getter.call(headers, name) as unknown) : undefined;
  const matchingEntry = record
    ? Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : undefined;
  const value = getterValue ?? matchingEntry;
  if (Array.isArray(value)) {
    const item = value.find((entry) => typeof entry === "string" || typeof entry === "number");
    return typeof item === "number" ? String(item) : item;
  }
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function shortKey(key: string): string {
  return sanitizePathSegment(key).slice(0, 24) || "attachment";
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function sanitizeMessageDirectoryName(value: string): string {
  const sanitized = sanitizePathSegment(value);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "message";
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
