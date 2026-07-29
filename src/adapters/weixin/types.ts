export const WeixinMessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const WeixinItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface WeixinCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: WeixinCdnMedia;
    aeskey?: string;
  };
  voice_item?: {
    media?: WeixinCdnMedia;
    text?: string;
  };
  file_item?: {
    media?: WeixinCdnMedia;
    file_name?: string;
  };
  video_item?: {
    media?: WeixinCdnMedia;
  };
  ref_msg?: {
    title?: string;
    message_item?: WeixinMessageItem;
  };
}

export interface WeixinMessage {
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinCredentials {
  schemaVersion: 1;
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt: string;
}

export interface WeixinConversationRuntime {
  contextToken?: string;
  typingTicket?: string;
  updatedAt: string;
}

export interface WeixinAttachmentDescriptor {
  kind: "image" | "file";
  media: WeixinCdnMedia;
  imageAesKeyHex?: string;
  name?: string;
  mediaType?: string;
  expiresAt: string;
}

export interface WeixinRuntimeState {
  schemaVersion: 1;
  getUpdatesBuf: string;
  conversations: Record<string, WeixinConversationRuntime>;
  attachments: Record<string, WeixinAttachmentDescriptor>;
}

export function emptyWeixinRuntimeState(): WeixinRuntimeState {
  return {
    schemaVersion: 1,
    getUpdatesBuf: "",
    conversations: {},
    attachments: {},
  };
}
