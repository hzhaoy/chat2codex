/*
 * iLink protocol behavior in this module is derived from the MIT-licensed
 * @tencent-weixin/openclaw-weixin 2.4.6 implementation. See
 * THIRD_PARTY_NOTICES.md for attribution. Chat2Codex does not depend on the
 * OpenClaw plugin package at runtime.
 */
import crypto, { randomUUID } from "node:crypto";

import type { BridgeConfig } from "../../config/env.js";
import type {
  AdapterEventHandler,
  AttachmentRef,
  ChatAdapter,
} from "../../core/contracts.js";
import type { ChatView } from "../../core/view-models.js";
import type { Logger } from "../../util/logger.js";
import { WeixinApiClient } from "./api.js";
import {
  loadWeixinCredentials,
  loadWeixinRuntime,
  saveWeixinRuntime,
  weixinRuntimePath,
} from "./store.js";
import {
  WeixinItemType,
  type WeixinAttachmentDescriptor,
  type WeixinMessage,
  type WeixinMessageItem,
  type WeixinRuntimeState,
} from "./types.js";

const weixinCdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c/";
const retryDelayMs = 2_000;
const degradedRetryDelayMs = 30_000;
const staleTokenPauseMs = 60 * 60 * 1_000;

export async function createWeixinAdapter(
  config: BridgeConfig,
  logger: Logger,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ChatAdapter> {
  const credentials = await loadWeixinCredentials(config.weixinCredentialsPath);
  const runtimePath = weixinRuntimePath(config.weixinCredentialsPath);
  const runtime = await loadWeixinRuntime(runtimePath);
  pruneExpiredAttachments(runtime);
  const api = new WeixinApiClient({
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    logger,
    fetchImpl: options.fetchImpl,
  });
  const adapterId = `weixin:${credentials.accountId}`;
  let controller: AbortController | undefined;
  let pollTask: Promise<void> | undefined;
  let persistTail = Promise.resolve();

  const persist = (): Promise<void> => {
    persistTail = persistTail
      .catch(() => undefined)
      .then(() => saveWeixinRuntime(runtimePath, runtime));
    return persistTail;
  };

  const adapter: ChatAdapter = {
    descriptor: {
      adapterId,
      platformKind: "weixin",
      accountId: credentials.accountId,
    },
    capabilities: {
      markdown: false,
      interactiveViews: false,
      viewUpdates: false,
      attachments: true,
      messageReactions: true,
    },
    async start(handler) {
      if (controller) {
        throw new Error("Weixin adapter is already started.");
      }
      controller = new AbortController();
      await api.notifyStart();
      pollTask = pollWeixin(
        api,
        runtime,
        handler,
        adapterId,
        persist,
        logger,
        controller.signal,
        config.attachmentRetentionHours,
      );
      pollTask.catch((error: unknown) => {
        if (!controller?.signal.aborted) {
          logger.error("Weixin long polling stopped unexpectedly", safeError(error));
        }
      });
    },
    async stop() {
      const activeController = controller;
      controller = undefined;
      activeController?.abort();
      await pollTask?.catch((error: unknown) => {
        if (!isAbortError(error)) {
          throw error;
        }
      });
      pollTask = undefined;
      await persistTail;
      if (activeController) {
        await api.notifyStop().catch((error: unknown) => {
          logger.warn("Weixin notify-stop failed", safeError(error));
        });
      }
    },
    async sendView(target, view, options) {
      const text = renderWeixinView(view);
      const conversation = runtime.conversations[target.conversationId];
      const clientId = options?.idempotencyKey ?? randomUUID();
      await api.sendText({
        to: target.conversationId,
        text,
        contextToken: conversation?.contextToken,
        clientId,
      });
      return {
        status: "delivered",
        handle: {
          adapterId,
          conversationId: target.conversationId,
          messageId: clientId,
        },
      };
    },
    async updateView() {
      return {
        status: "unsupported",
        reason: "Weixin does not support in-place message updates.",
      };
    },
    async addReaction(ref, reaction) {
      if (reaction === "failure") {
        return {
          status: "unsupported",
          reason: "Weixin has no failure reaction; the core result message reports failures.",
        };
      }
      const conversation = ensureConversation(runtime, ref.conversationId);
      if (!conversation.typingTicket) {
        conversation.typingTicket = await api.getTypingTicket(
          ref.conversationId,
          conversation.contextToken,
        );
        await persist();
      }
      if (!conversation.typingTicket) {
        return {
          status: "unsupported",
          reason: "Weixin did not provide a typing ticket.",
        };
      }
      await api.sendTyping(ref.conversationId, conversation.typingTicket, 1);
      return {
        status: "delivered",
        handle: {
          ...ref,
          reaction,
          reactionId: `typing:${randomUUID()}`,
        },
      };
    },
    async removeReaction(handle) {
      if (!handle.reactionId.startsWith("typing:")) {
        return {
          status: "unsupported",
          reason: "Unknown Weixin reaction handle.",
        };
      }
      const ticket = runtime.conversations[handle.conversationId]?.typingTicket;
      if (!ticket) {
        return {
          status: "unsupported",
          reason: "Weixin typing ticket is no longer available.",
        };
      }
      await api.sendTyping(handle.conversationId, ticket, 2);
      return { status: "delivered" };
    },
    async openAttachment(ref) {
      const descriptor = runtime.attachments[ref.attachmentId];
      if (!descriptor || Date.parse(descriptor.expiresAt) <= Date.now()) {
        delete runtime.attachments[ref.attachmentId];
        await persist();
        throw new Error("Weixin attachment metadata is missing or expired.");
      }
      const downloaded = await openDecryptedAttachmentStream(
        descriptor,
        config.attachmentMaxFileBytes,
        options.fetchImpl,
      );
      return {
        chunks: removeDescriptorAfterConsumption(
          downloaded.chunks,
          async () => {
            delete runtime.attachments[ref.attachmentId];
            await persist();
          },
        ),
        name: descriptor.name,
        mediaType: descriptor.mediaType,
        size: downloaded.size,
      };
    },
  };

  return adapter;
}

async function pollWeixin(
  api: WeixinApiClient,
  runtime: WeixinRuntimeState,
  handler: AdapterEventHandler,
  adapterId: string,
  persist: () => Promise<void>,
  logger: Logger,
  signal: AbortSignal,
  attachmentRetentionHours: number,
): Promise<void> {
  let consecutiveFailures = 0;
  let longPollTimeoutMs = 35_000;
  while (!signal.aborted) {
    try {
      const response = await api.getUpdates(
        runtime.getUpdatesBuf,
        longPollTimeoutMs,
        signal,
      );
      if (signal.aborted) {
        return;
      }
      if (
        response.longpolling_timeout_ms !== undefined &&
        response.longpolling_timeout_ms > 0
      ) {
        longPollTimeoutMs = response.longpolling_timeout_ms;
      }
      if (
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0)
      ) {
        if (response.ret === -14 || response.errcode === -14) {
          logger.error(
            "Weixin Bot Token is stale; pausing requests for one hour. Rerun setup weixin if it does not recover.",
          );
          consecutiveFailures = 0;
          await waitForAbort(staleTokenPauseMs, signal);
          continue;
        }
        throw new Error(
          `getUpdates failed: ret=${response.ret ?? "?"} errcode=${response.errcode ?? "?"}`,
        );
      }
      for (const message of response.msgs ?? []) {
        const events = adaptWeixinMessage(
          message,
          adapterId,
          runtime,
          attachmentRetentionHours,
        );
        await persist();
        for (const event of events) {
          await handler(event);
        }
      }
      // The cursor advances only after the complete batch reaches the core.
      runtime.getUpdatesBuf = response.get_updates_buf ?? runtime.getUpdatesBuf;
      pruneExpiredAttachments(runtime);
      await persist();
      consecutiveFailures = 0;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      consecutiveFailures += 1;
      logger.warn("Weixin getUpdates failed; the current cursor will be replayed", {
        failureCount: consecutiveFailures,
        error: safeError(error),
      });
      await waitForAbort(
        consecutiveFailures >= 3 ? degradedRetryDelayMs : retryDelayMs,
        signal,
      );
    }
  }
}

function adaptWeixinMessage(
  message: WeixinMessage,
  adapterId: string,
  runtime: WeixinRuntimeState,
  attachmentRetentionHours: number,
) {
  const messageId = normalizeId(message.message_id);
  const userId = message.from_user_id?.trim();
  const items = message.item_list ?? [];
  const diagnosticBase = {
    kind: "diagnostic" as const,
    adapterId,
    messageId,
    conversationId: userId,
    conversationKind: message.group_id ? "group" : "direct",
    payloadKind: itemKinds(items),
    mentionCount: 0,
    startsWithMention: false,
    attachmentCount: 0,
    textLength: 0,
    botIdentityResolved: true,
  };
  if (!messageId || !userId) {
    return [{ ...diagnosticBase, outcome: "dropped" as const, reason: "missing_message_identity" }];
  }
  if (message.group_id?.trim()) {
    return [{ ...diagnosticBase, outcome: "dropped" as const, reason: "weixin_group_unsupported" }];
  }

  const textParts: string[] = [];
  const attachments: AttachmentRef[] = [];
  const expiresAt = new Date(
    Date.now() + attachmentRetentionHours * 60 * 60 * 1_000,
  ).toISOString();
  items.forEach((item, index) => {
    const text = extractText(item);
    if (text) {
      textParts.push(text);
    }
    const descriptor = attachmentDescriptor(item, expiresAt);
    if (!descriptor) {
      return;
    }
    const attachmentId = `${messageId}:${index}`;
    runtime.attachments[attachmentId] = descriptor;
    attachments.push({
      message: { adapterId, conversationId: userId, messageId },
      attachmentId,
      kind: descriptor.kind,
      name: descriptor.name,
      mediaType: descriptor.mediaType,
    });
  });

  if (message.context_token?.trim()) {
    runtime.conversations[userId] = {
      ...runtime.conversations[userId],
      contextToken: message.context_token,
      updatedAt: new Date().toISOString(),
    };
  } else {
    ensureConversation(runtime, userId);
  }

  const text = textParts.join("\n").trim();
  const unsupportedMedia = items.some(
    (item) => item.type === WeixinItemType.VOICE || item.type === WeixinItemType.VIDEO,
  );
  if (!text && attachments.length === 0) {
    return [{
      ...diagnosticBase,
      outcome: "dropped" as const,
      reason: unsupportedMedia ? "weixin_media_unsupported" : "empty_weixin_message",
    }];
  }
  return [
    {
      ...diagnosticBase,
      outcome: "routed" as const,
      attachmentCount: attachments.length,
      textLength: text.length,
    },
    {
      kind: "message" as const,
      ref: { adapterId, conversationId: userId, messageId },
      conversation: { adapterId, conversationId: userId, kind: "direct" as const },
      sender: {
        keys: [{ kind: "ilink_user_id", value: userId }],
        userId,
      },
      text,
      addressedToBot: true,
      attachments,
    },
  ];
}

function extractText(item: WeixinMessageItem): string | undefined {
  const direct = item.text_item?.text?.trim();
  if (direct) {
    return direct;
  }
  const quoted = item.ref_msg?.message_item?.text_item?.text?.trim();
  const title = item.ref_msg?.title?.trim();
  if (quoted || title) {
    return `[引用] ${quoted ?? title}`;
  }
  return undefined;
}

function attachmentDescriptor(
  item: WeixinMessageItem,
  expiresAt: string,
): WeixinAttachmentDescriptor | undefined {
  if (item.type === WeixinItemType.IMAGE && item.image_item?.media) {
    return {
      kind: "image",
      media: item.image_item.media,
      imageAesKeyHex: item.image_item.aeskey,
      mediaType: "image/jpeg",
      expiresAt,
    };
  }
  if (item.type === WeixinItemType.FILE && item.file_item?.media) {
    return {
      kind: "file",
      media: item.file_item.media,
      name: sanitizeAttachmentName(item.file_item.file_name),
      expiresAt,
    };
  }
  return undefined;
}

async function downloadAndDecryptAttachment(
  descriptor: WeixinAttachmentDescriptor,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const stream = await openDecryptedAttachmentStream(
    descriptor,
    maxBytes,
    fetchImpl,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream.chunks) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function openDecryptedAttachmentStream(
  descriptor: WeixinAttachmentDescriptor,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ chunks: AsyncIterable<Uint8Array>; size?: number }> {
  const url = attachmentDownloadUrl(descriptor);
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Weixin CDN download failed with HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + 16) {
    throw new Error(`Attachment exceeds the configured ${maxBytes}-byte per-file limit.`);
  }
  const key = decodeAesKey(
    descriptor.imageAesKeyHex ?? descriptor.media.aes_key,
  );
  if (!response.body) {
    throw new Error("Weixin CDN response did not include an attachment body.");
  }
  return {
    chunks: decryptResponseBody(response.body, key, maxBytes),
  };
}

async function* decryptResponseBody(
  body: ReadableStream<Uint8Array>,
  key: Buffer,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  let encryptedBytes = 0;
  let decryptedBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      encryptedBytes += result.value.byteLength;
      if (encryptedBytes > maxBytes + 16) {
        throw new Error(`Attachment exceeds the configured ${maxBytes}-byte per-file limit.`);
      }
      const decrypted = decipher.update(Buffer.from(result.value));
      decryptedBytes += decrypted.byteLength;
      if (decryptedBytes > maxBytes) {
        throw new Error(`Attachment exceeds the configured ${maxBytes}-byte per-file limit.`);
      }
      if (decrypted.byteLength > 0) {
        yield decrypted;
      }
    }
    const final = decipher.final();
    decryptedBytes += final.byteLength;
    if (decryptedBytes > maxBytes) {
      throw new Error(`Attachment exceeds the configured ${maxBytes}-byte per-file limit.`);
    }
    if (final.byteLength > 0) {
      yield final;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* removeDescriptorAfterConsumption(
  chunks: AsyncIterable<Uint8Array>,
  completed: () => Promise<void>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    yield chunk;
  }
  await completed();
}

function attachmentDownloadUrl(descriptor: WeixinAttachmentDescriptor): URL {
  if (descriptor.media.full_url) {
    const url = new URL(descriptor.media.full_url);
    if (url.protocol !== "https:") {
      throw new Error("Weixin attachment URL must use HTTPS.");
    }
    return url;
  }
  const query = descriptor.media.encrypt_query_param?.trim();
  if (!query) {
    throw new Error("Weixin attachment is missing its CDN query parameter.");
  }
  const url = new URL("download", weixinCdnBaseUrl);
  url.searchParams.set("encrypted_query_param", query);
  return url;
}

function decodeAesKey(value: string | undefined): Buffer {
  if (!value?.trim()) {
    throw new Error("Weixin attachment is missing its AES key.");
  }
  const trimmed = value.trim();
  if (/^[0-9a-f]{32}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.byteLength === 16) {
    return decoded;
  }
  const ascii = decoded.toString("utf8");
  if (/^[0-9a-f]{32}$/iu.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error("Weixin attachment AES key has an unsupported encoding.");
}

function renderWeixinView(view: ChatView): string {
  switch (view.kind) {
    case "text":
      return renderWeixinPlainText(view.text);
    case "markdown":
      return view.markdown;
    case "run_status":
      return renderWeixinPlainText(
        [
          `Codex 任务：${view.input.status}`,
          view.input.detail,
          `目录：${view.input.cwd}`,
          view.input.result?.statusNote,
        ].filter(Boolean).join("\n"),
      );
    case "approval":
      return renderWeixinPlainText(`Codex 审批：${view.input.status}`);
    case "user_input":
      return renderWeixinPlainText(`Codex 结构化输入：${view.input.status}`);
    case "permission_approval":
      return renderWeixinPlainText(`Codex 权限请求：${view.input.status}`);
    case "mcp_elicitation":
      return renderWeixinPlainText(`MCP 请求：${view.input.status}`);
    case "project_list":
      return renderWeixinPlainText(renderProjects(view.input));
    case "session_list":
      return renderWeixinPlainText(renderSessions(view.input));
    case "host_health":
      return renderWeixinPlainText(renderHostHealth(view.input));
  }
}

/**
 * The Weixin client collapses a single LF inside a text item into inline
 * whitespace. Empty lines survive as paragraph boundaries, so plain-text
 * control views need one blank line between logical lines. Markdown answers
 * bypass this normalization because their source already owns its layout.
 */
function renderWeixinPlainText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/\n+/gu, "\n\n");
}

function renderProjects(input: Extract<ChatView, { kind: "project_list" }>["input"]): string {
  const lines = input.projects.map(
    (project, index) =>
      `${index + 1}. ${project.title ?? project.cwd} (${project.threadCount} 个会话)`,
  );
  return [`项目（当前：${input.currentCwd}）`, ...lines].join("\n");
}

function renderSessions(input: Extract<ChatView, { kind: "session_list" }>["input"]): string {
  const lines = input.sessions.map(
    (session, index) =>
      `${index + 1}. ${session.title ?? session.threadId}${session.resumable === false ? "（不可恢复）" : ""}`,
  );
  return [input.title ?? `会话（${input.cwd}）`, input.note, ...lines]
    .filter(Boolean)
    .join("\n");
}

function renderHostHealth(input: Extract<ChatView, { kind: "host_health" }>["input"]): string {
  return [
    `${input.title}：${input.status}`,
    `主机：${input.host} (${input.platform})`,
    `运行时间：${input.uptime}`,
    `队列：${input.queueDepth}`,
    `活动任务：${input.activeRun}`,
    `审批：${input.approvalWait}`,
    `Codex：${input.codexBin} ${input.codexVersion}`,
    `目录：${input.defaultCwd}`,
    ...input.warnings.map((warning) => `警告：${warning}`),
  ].join("\n");
}

function ensureConversation(runtime: WeixinRuntimeState, userId: string) {
  runtime.conversations[userId] ??= { updatedAt: new Date().toISOString() };
  return runtime.conversations[userId];
}

function pruneExpiredAttachments(runtime: WeixinRuntimeState): void {
  const now = Date.now();
  for (const [key, descriptor] of Object.entries(runtime.attachments)) {
    if (!Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= now) {
      delete runtime.attachments[key];
    }
  }
}

function sanitizeAttachmentName(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll("\\", "/").split("/").pop()?.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    return undefined;
  }
  return normalized.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 180);
}

function normalizeId(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function itemKinds(items: WeixinMessageItem[]): string {
  return [...new Set(items.map((item) => String(item.type ?? "unknown")))].join(",");
}

function waitForAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const weixinAdapterInternals = {
  adaptWeixinMessage,
  downloadAndDecryptAttachment,
  decodeAesKey,
  pollWeixin,
  renderWeixinPlainText,
  renderWeixinView,
};
