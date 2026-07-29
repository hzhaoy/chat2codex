import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CodexRunner } from "../agent/codex-runner.js";
import type { BridgeConfig } from "../config/env.js";
import type {
  ChatAdapter,
  InboundEvent,
} from "../core/contracts.js";
import type { InteractionPolicy } from "../core/interaction-policy.js";
import {
  MessageRouter,
  type ChatDeliveryOptions,
  type ChatSender,
  type DownloadedAttachment,
  type IncomingAttachment,
  type StatusCardHandle,
} from "../core/message-router.js";
import type { ChatView } from "../core/view-models.js";
import { JsonStateStore } from "../state/store.js";
import type { Logger } from "../util/logger.js";
import { AdapterSupervisor } from "./adapter-supervisor.js";

export interface PlatformAdapterBundle {
  adapter: ChatAdapter;
  interactionPolicy: InteractionPolicy;
}

export interface BridgeRuntime {
  dispose(): Promise<void>;
}

export async function runBridgeRuntime(
  config: BridgeConfig,
  bundle: PlatformAdapterBundle,
  logger: Logger,
  requestRestart?: () => void,
): Promise<BridgeRuntime> {
  const { adapter, interactionPolicy } = bundle;
  const adapterId = adapter.descriptor.adapterId;
  const supervisor = new AdapterSupervisor([adapter], logger);
  let markSupervisorReady!: () => void;
  const supervisorReady = new Promise<void>((resolve) => {
    markSupervisorReady = resolve;
  });
  const sender = createChatSender(config, supervisor, adapter, supervisorReady, logger);
  const router = new MessageRouter(
    config,
    new JsonStateStore(config.bridgeStatePath, {
      adapterId,
      jobRetentionCount: config.jobRetentionCount,
      outboxRetentionCount: config.outboxRetentionCount,
    }),
    sender,
    logger,
    new CodexRunner(config, logger),
    interactionPolicy,
    { requestRestart },
  );

  try {
    await router.start();
    await supervisor.start((event) => routeInboundEvent(router, event));
    markSupervisorReady();
    return createSupervisorBridgeRuntime(supervisor, router);
  } catch (error) {
    markSupervisorReady();
    try {
      await createSupervisorBridgeRuntime(supervisor, router).dispose();
    } catch (disposeError) {
      logger.error("Failed to clean up the bridge after startup failed", disposeError);
    }
    throw error;
  }
}

function createChatSender(
  config: BridgeConfig,
  supervisor: AdapterSupervisor,
  adapter: ChatAdapter,
  supervisorReady: Promise<void>,
  logger: Logger,
): ChatSender {
  const adapterId = adapter.descriptor.adapterId;
  const target = (chatId: string) => ({ adapterId, conversationId: chatId });
  const requireDelivered = async (
    result: Awaited<ReturnType<AdapterSupervisor["sendView"]>>,
  ) => {
    if (result.status === "unsupported") {
      throw new Error(result.reason);
    }
    return result;
  };
  const sendCoreView = async (
    chatId: string,
    view: ChatView,
    options?: ChatDeliveryOptions,
  ) => {
    await supervisorReady;
    return requireDelivered(await supervisor.sendView(target(chatId), view, options));
  };
  const createCoreView = async (
    chatId: string,
    view: ChatView,
  ): Promise<StatusCardHandle> => {
    const result = await sendCoreView(chatId, view);
    if (!result.handle) {
      throw new Error(`Adapter ${adapterId} did not return a view handle.`);
    }
    return result.handle;
  };
  const updateCoreView = async (
    handle: StatusCardHandle,
    view: ChatView,
  ): Promise<void> => {
    await supervisorReady;
    await requireDelivered(
      await supervisor.updateView(
        {
          adapterId: handle.adapterId ?? adapterId,
          conversationId: handle.conversationId ?? "",
          messageId: handle.messageId,
        },
        view,
      ),
    );
  };

  const sender: ChatSender = {
    async sendText(chatId, text, options) {
      await sendCoreView(chatId, { kind: "text", text }, options);
    },
    async sendMarkdown(chatId, markdown, options) {
      await sendCoreView(chatId, { kind: "markdown", markdown }, options);
    },
    async sendView(chatId, view) {
      await sendCoreView(chatId, view);
    },
  };

  if (adapter.capabilities.messageReactions) {
    sender.addReaction = async (chatId, messageId, reaction) => {
      await supervisorReady;
      const result = await supervisor.addReaction(
        { adapterId, conversationId: chatId, messageId },
        reaction,
      );
      if (result.status === "unsupported") {
        logger.debug("Message reaction is unsupported", {
          adapterId,
          reaction,
          reason: result.reason,
        });
        return null;
      }
      return result.handle;
    };
    sender.removeReaction = async (handle) => {
      await supervisorReady;
      const result = await supervisor.removeReaction(handle);
      if (result.status === "unsupported") {
        logger.debug("Message reaction removal is unsupported", {
          adapterId: handle.adapterId,
          reaction: handle.reaction,
          reason: result.reason,
        });
      }
    };
  }

  if (adapter.capabilities.attachments) {
    sender.downloadAttachment = async (
      message,
      attachment,
    ): Promise<DownloadedAttachment> => {
      await supervisorReady;
      const stream = await supervisor.openAttachment({
        message: {
          adapterId,
          conversationId: message.chatId,
          messageId: message.messageId,
        },
        attachmentId: attachment.key,
        kind: attachment.kind,
        name: attachment.name,
      });
      const directory = path.join(
        config.attachmentDownloadDir,
        sanitizePathSegment(message.messageId) || "message",
      );
      const downloadRoot = await ensurePrivateDirectory(config.attachmentDownloadDir);
      const resolvedDirectory = await ensurePrivateDirectory(directory);
      assertPathInside(downloadRoot, resolvedDirectory);
      const fileName = attachmentFileName(
        { ...attachment, name: stream.name ?? attachment.name },
        stream.mediaType,
      );
      const filePath = path.join(resolvedDirectory, fileName);
      await writeAttachmentStreamAtomically(
        stream.chunks,
        downloadRoot,
        filePath,
        config.attachmentMaxFileBytes,
        stream.size,
      );
      return {
        kind: attachment.kind,
        name: attachment.name ?? stream.name ?? fileName,
        path: filePath,
      };
    };
  }

  if (adapter.capabilities.interactiveViews && adapter.capabilities.viewUpdates) {
    sender.createStatusCard = (chatId, input) =>
      createCoreView(chatId, { kind: "run_status", input });
    sender.updateStatusCard = (handle, input) =>
      updateCoreView(handle, { kind: "run_status", input });
    sender.createApprovalCard = (chatId, input) =>
      createCoreView(chatId, { kind: "approval", input });
    sender.updateApprovalCard = (handle, input) =>
      updateCoreView(handle, { kind: "approval", input });
    sender.createUserInputCard = (chatId, input) =>
      createCoreView(chatId, { kind: "user_input", input });
    sender.updateUserInputCard = (handle, input) =>
      updateCoreView(handle, { kind: "user_input", input });
    sender.createPermissionApprovalCard = (chatId, input) =>
      createCoreView(chatId, { kind: "permission_approval", input });
    sender.updatePermissionApprovalCard = (handle, input) =>
      updateCoreView(handle, { kind: "permission_approval", input });
    sender.createMcpElicitationCard = (chatId, input) =>
      createCoreView(chatId, { kind: "mcp_elicitation", input });
    sender.updateMcpElicitationCard = (handle, input) =>
      updateCoreView(handle, { kind: "mcp_elicitation", input });
  }

  return sender;
}

async function routeInboundEvent(
  router: MessageRouter,
  event: InboundEvent,
) {
  if (event.kind === "diagnostic") {
    await router.recordEventDiagnostic(event.outcome, {
      reason: event.reason,
      messageId: event.messageId,
      chatId: event.conversationId,
      chatType: event.conversationKind,
      messageType: event.payloadKind,
      mentionCount: event.mentionCount,
      startsWithMention: event.startsWithMention,
      attachmentCount: event.attachmentCount,
      textLength: event.textLength,
      botIdentityResolved: event.botIdentityResolved,
    });
    return;
  }
  if (event.kind === "action") {
    return router.handleCardAction(event.action);
  }
  await router.accept({
    messageId: event.ref.messageId,
    chatId: event.conversation.conversationId,
    chatType: event.conversation.kind,
    sender: event.sender,
    text: event.text,
    attachments: event.attachments.map((attachment) => ({
      kind: attachment.kind,
      key: attachment.attachmentId,
      name: attachment.name,
    })),
  });
}

function createSupervisorBridgeRuntime(
  supervisor: AdapterSupervisor,
  router: Pick<MessageRouter, "dispose">,
): BridgeRuntime {
  let disposePromise: Promise<void> | undefined;
  return {
    dispose() {
      disposePromise ??= disposeSupervisorBridgeRuntime(supervisor, router);
      return disposePromise;
    },
  };
}

async function disposeSupervisorBridgeRuntime(
  supervisor: AdapterSupervisor,
  router: Pick<MessageRouter, "dispose">,
): Promise<void> {
  const results = await Promise.allSettled([supervisor.stop(), router.dispose()]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) {
    throw new AggregateError(errors, "Failed to dispose the adapter runtime cleanly.");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Attachment directory is not a private directory: ${directory}`);
  }
  await fs.chmod(directory, 0o700);
  return fs.realpath(directory);
}

export async function writeAttachmentStreamAtomically(
  chunks: AsyncIterable<Uint8Array>,
  downloadRoot: string,
  filePath: string,
  maxBytes: number,
  declaredSize?: number,
): Promise<number> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Attachment byte limit must be a positive safe integer.");
  }
  if (declaredSize !== undefined && declaredSize > maxBytes) {
    throw attachmentTooLargeError(maxBytes);
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
  let bytesWritten = 0;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    for await (const chunk of chunks) {
      const buffer = Buffer.from(chunk);
      if (bytesWritten + buffer.byteLength > maxBytes) {
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

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Attachment download stopped before the current chunk was written.");
    }
    offset += result.bytesWritten;
  }
}

function attachmentFileName(
  attachment: IncomingAttachment,
  mediaType?: string,
): string {
  if (attachment.name) {
    return sanitizeFileName(attachment.name);
  }
  const suffix = attachment.kind === "image" ? imageExtension(mediaType) : ".bin";
  return sanitizeFileName(`${attachment.kind}-${shortKey(attachment.key)}${suffix}`);
}

function imageExtension(mediaType?: string): string {
  switch (mediaType?.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
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

function shortKey(key: string): string {
  return sanitizePathSegment(key).slice(0, 24) || "attachment";
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function sanitizeFileName(value: string): string {
  const base = path.basename(value);
  const sanitized = sanitizePathSegment(base);
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : "attachment.bin";
}
