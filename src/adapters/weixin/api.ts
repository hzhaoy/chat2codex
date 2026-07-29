import crypto from "node:crypto";

import type { Logger } from "../../util/logger.js";
import type {
  WeixinGetUpdatesResponse,
  WeixinMessage,
} from "./types.js";
import {
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
} from "./types.js";

const defaultApiTimeoutMs = 15_000;
const defaultLongPollTimeoutMs = 35_000;

export interface WeixinApiClientOptions {
  baseUrl: string;
  token?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class WeixinApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WeixinApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getUpdates(
    getUpdatesBuf: string,
    timeoutMs = defaultLongPollTimeoutMs,
    abortSignal?: AbortSignal,
  ): Promise<WeixinGetUpdatesResponse> {
    try {
      return await this.postJson<WeixinGetUpdatesResponse>(
        "ilink/bot/getupdates",
        {
          get_updates_buf: getUpdatesBuf,
          base_info: baseInfo(),
        },
        timeoutMs,
        abortSignal,
      );
    } catch (error) {
      if (isAbortError(error)) {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw error;
    }
  }

  async sendText(params: {
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
  }): Promise<void> {
    const message: WeixinMessage = {
      from_user_id: "",
      to_user_id: params.to,
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      context_token: params.contextToken,
      item_list: [
        {
          type: WeixinItemType.TEXT,
          text_item: { text: params.text },
        },
      ],
    };
    const response = await this.postJson<{ ret?: number; errmsg?: string }>(
      "ilink/bot/sendmessage",
      {
        msg: { ...message, client_id: params.clientId },
        base_info: baseInfo(),
      },
      defaultApiTimeoutMs,
    );
    assertApiSuccess("sendMessage", response);
  }

  async getTypingTicket(
    userId: string,
    contextToken?: string,
  ): Promise<string | undefined> {
    const response = await this.postJson<{
      ret?: number;
      errmsg?: string;
      typing_ticket?: string;
    }>(
      "ilink/bot/getconfig",
      {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: baseInfo(),
      },
      10_000,
    );
    assertApiSuccess("getConfig", response);
    return response.typing_ticket?.trim() || undefined;
  }

  async sendTyping(
    userId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    const response = await this.postJson<{ ret?: number; errmsg?: string }>(
      "ilink/bot/sendtyping",
      {
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status,
        base_info: baseInfo(),
      },
      10_000,
    );
    assertApiSuccess("sendTyping", response);
  }

  async notifyStart(): Promise<void> {
    const response = await this.postJson<{ ret?: number; errmsg?: string }>(
      "ilink/bot/msg/notifystart",
      { base_info: baseInfo() },
      10_000,
    );
    assertApiSuccess("notifyStart", response);
  }

  async notifyStop(): Promise<void> {
    const response = await this.postJson<{ ret?: number; errmsg?: string }>(
      "ilink/bot/msg/notifystop",
      { base_info: baseInfo() },
      10_000,
    );
    assertApiSuccess("notifyStop", response);
  }

  async getJson<T>(
    endpoint: string,
    timeoutMs: number,
    baseUrl = this.options.baseUrl,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(endpoint, trailingSlash(baseUrl)), {
        method: "GET",
        headers: commonHeaders(false),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Weixin GET failed with HTTP ${response.status}.`);
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async postJson<T>(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
    abortSignal?: AbortSignal,
    baseUrl = this.options.baseUrl,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(new URL(endpoint, trailingSlash(baseUrl)), {
        method: "POST",
        headers: commonHeaders(Boolean(this.options.token), this.options.token),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Weixin POST failed with HTTP ${response.status}.`);
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (!isAbortError(error)) {
        this.options.logger.warn("Weixin API request failed", {
          endpoint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
    }
  }
}

function baseInfo() {
  return {
    channel_version: "0.7.0",
    bot_agent: "Chat2Codex/0.7.0",
  };
}

function commonHeaders(
  authenticated: boolean,
  token?: string,
): Record<string, string> {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(0x000700),
    "X-WECHAT-UIN": Buffer.from(String(uint32), "utf8").toString("base64"),
    ...(authenticated && token
      ? {
          Authorization: `Bearer ${token}`,
        }
      : {}),
  };
}

function assertApiSuccess(
  label: string,
  response: { ret?: number; errcode?: number; errmsg?: string },
): void {
  if (
    (response.ret !== undefined && response.ret !== 0) ||
    (response.errcode !== undefined && response.errcode !== 0)
  ) {
    throw new Error(
      `${label} failed: ret=${response.ret ?? "?"} errcode=${response.errcode ?? "?"}`,
    );
  }
}

function trailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
