import type { IncomingAction, ActionResponse } from "./actions.js";
import type { SenderIdentity } from "./identity.js";
import type { ChatView } from "./view-models.js";

export type AdapterId = string;
export type PlatformKind = string;
export type ConversationKind = "direct" | "group";

export interface AdapterDescriptor {
  adapterId: AdapterId;
  platformKind: PlatformKind;
  accountId: string;
}

export interface ConversationRef {
  adapterId: AdapterId;
  conversationId: string;
  kind: ConversationKind;
}

export interface MessageRef {
  adapterId: AdapterId;
  conversationId: string;
  messageId: string;
}

export type MessageReaction = "processing" | "failure";

export interface MessageReactionHandle extends MessageRef {
  reactionId: string;
  reaction: MessageReaction;
}

export interface AttachmentRef {
  message: MessageRef;
  attachmentId: string;
  kind: "image" | "file";
  name?: string;
  mediaType?: string;
  size?: number;
}

export interface IncomingMessageEvent {
  kind: "message";
  ref: MessageRef;
  conversation: ConversationRef;
  sender: SenderIdentity;
  text: string;
  addressedToBot: boolean;
  attachments: AttachmentRef[];
}

export interface IncomingActionEvent {
  kind: "action";
  adapterId: AdapterId;
  action: IncomingAction;
}

export interface IngressDiagnosticEvent {
  kind: "diagnostic";
  adapterId: AdapterId;
  outcome: "routed" | "dropped";
  reason?: string;
  messageId?: string;
  conversationId?: string;
  conversationKind?: string;
  payloadKind?: string;
  mentionCount: number;
  startsWithMention: boolean;
  attachmentCount: number;
  textLength: number;
  botIdentityResolved: boolean;
}

export type InboundEvent = IncomingMessageEvent | IncomingActionEvent | IngressDiagnosticEvent;

export interface ViewTarget {
  adapterId: AdapterId;
  conversationId: string;
}

export interface ViewHandle extends ViewTarget {
  messageId: string;
}

export interface DeliveryOptions {
  idempotencyKey?: string;
}

export interface AdapterCapabilities {
  markdown: boolean;
  interactiveViews: boolean;
  viewUpdates: boolean;
  attachments: boolean;
  messageReactions: boolean;
}

export type DeliveryResult =
  | { status: "delivered"; handle?: ViewHandle }
  | { status: "unsupported"; reason: string };

export type MessageReactionResult =
  | { status: "delivered"; handle: MessageReactionHandle }
  | { status: "unsupported"; reason: string };

export type MessageReactionRemovalResult =
  | { status: "delivered" }
  | { status: "unsupported"; reason: string };

export interface AttachmentStream {
  chunks: AsyncIterable<Uint8Array>;
  name?: string;
  mediaType?: string;
  size?: number;
}

export type AdapterEventHandler = (event: InboundEvent) => Promise<ActionResponse | void>;

/** The only platform transport contract visible to the runtime/core boundary. */
export interface ChatAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly capabilities: AdapterCapabilities;
  start(handler: AdapterEventHandler): Promise<void>;
  stop(): Promise<void>;
  sendView(target: ViewTarget, view: ChatView, options?: DeliveryOptions): Promise<DeliveryResult>;
  updateView(handle: ViewHandle, view: ChatView): Promise<DeliveryResult>;
  addReaction(ref: MessageRef, reaction: MessageReaction): Promise<MessageReactionResult>;
  removeReaction(handle: MessageReactionHandle): Promise<MessageReactionRemovalResult>;
  openAttachment(ref: AttachmentRef): Promise<AttachmentStream>;
}
