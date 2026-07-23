import type { ActionResponse } from "../../src/core/actions.js";
import type {
  AdapterEventHandler,
  AttachmentRef,
  AttachmentStream,
  ChatAdapter,
  DeliveryOptions,
  DeliveryResult,
  InboundEvent,
  MessageReaction,
  MessageReactionHandle,
  MessageReactionRemovalResult,
  MessageReactionResult,
  MessageRef,
  ViewHandle,
  ViewTarget,
} from "../../src/core/contracts.js";
import type { ChatView } from "../../src/core/view-models.js";

/** Compile-only reference implementation for third-party adapters. */
export class ReferenceAdapter implements ChatAdapter {
  readonly descriptor = {
    adapterId: "reference:default",
    platformKind: "reference",
    accountId: "default",
  } as const;

  readonly capabilities = {
    markdown: true,
    interactiveViews: true,
    viewUpdates: true,
    attachments: true,
    messageReactions: false,
  } as const;

  private handler?: AdapterEventHandler;

  async start(handler: AdapterEventHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async sendView(
    target: ViewTarget,
    _view: ChatView,
    _options?: DeliveryOptions,
  ): Promise<DeliveryResult> {
    return {
      status: "delivered",
      handle: { ...target, messageId: "reference-message" },
    };
  }

  async updateView(handle: ViewHandle, _view: ChatView): Promise<DeliveryResult> {
    return { status: "delivered", handle };
  }

  async addReaction(
    _ref: MessageRef,
    _reaction: MessageReaction,
  ): Promise<MessageReactionResult> {
    return { status: "unsupported", reason: "Reference adapter does not support reactions." };
  }

  async removeReaction(
    _handle: MessageReactionHandle,
  ): Promise<MessageReactionRemovalResult> {
    return { status: "unsupported", reason: "Reference adapter does not support reactions." };
  }

  async openAttachment(ref: AttachmentRef): Promise<AttachmentStream> {
    return {
      name: ref.name,
      mediaType: ref.mediaType,
      size: 0,
      chunks: emptyChunks(),
    };
  }

  emit(event: InboundEvent): Promise<ActionResponse | void> {
    if (!this.handler) {
      throw new Error("Reference adapter is not started.");
    }
    return this.handler(event);
  }
}

async function* emptyChunks(): AsyncIterable<Uint8Array> {
  // Compile-only empty attachment stream.
}
