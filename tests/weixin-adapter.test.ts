import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { WeixinApiClient } from "../src/adapters/weixin/api.js";
import { weixinAdapterInternals } from "../src/adapters/weixin/adapter.js";
import {
  loadWeixinCredentials,
  loadWeixinRuntime,
  saveWeixinCredentials,
  saveWeixinRuntime,
} from "../src/adapters/weixin/store.js";
import { emptyWeixinRuntimeState } from "../src/adapters/weixin/types.js";
import { weixinSetupInternals } from "../src/setup/weixin.js";
import type { Logger } from "../src/util/logger.js";

const temporaryDirectories: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Weixin protocol adapter", () => {
  test("preserves logical lines in plain text without rewriting Markdown answers", () => {
    expect(
      weixinAdapterInternals.renderWeixinView({
        kind: "text",
        text: "Chat2Codex 状态\n\n【会话】\n• 工作目录：/repo\n• Thread：尚未创建",
      }),
    ).toBe(
      "Chat2Codex 状态\n\n【会话】\n\n• 工作目录：/repo\n\n• Thread：尚未创建",
    );
    expect(
      weixinAdapterInternals.renderWeixinView({
        kind: "markdown",
        markdown: "**结果**\n\n- 第一项\n- 第二项",
      }),
    ).toBe("**结果**\n\n- 第一项\n- 第二项");
  });

  test("maps private text and attachments to stable iLink identity", () => {
    const runtime = emptyWeixinRuntimeState();
    const events = weixinAdapterInternals.adaptWeixinMessage(
      {
        message_id: "m-1",
        from_user_id: "wx-user",
        context_token: "sensitive-context",
        item_list: [
          { type: 1, text_item: { text: "run tests" } },
          {
            type: 2,
            image_item: {
              aeskey: "00112233445566778899aabbccddeeff",
              media: { encrypt_query_param: "opaque" },
            },
          },
          {
            type: 4,
            file_item: {
              file_name: "../../report.txt",
              media: {
                encrypt_query_param: "file-query",
                aes_key: Buffer.alloc(16, 7).toString("base64"),
              },
            },
          },
        ],
      },
      "weixin:bot-1",
      runtime,
      24,
    );

    expect(events[0]).toMatchObject({
      kind: "diagnostic",
      outcome: "routed",
      attachmentCount: 2,
    });
    expect(events[1]).toMatchObject({
      kind: "message",
      conversation: { conversationId: "wx-user", kind: "direct" },
      sender: {
        keys: [{ kind: "ilink_user_id", value: "wx-user" }],
      },
      text: "run tests",
      attachments: [
        { attachmentId: "m-1:1", kind: "image" },
        { attachmentId: "m-1:2", kind: "file", name: "report.txt" },
      ],
    });
    expect(runtime.conversations["wx-user"]?.contextToken).toBe(
      "sensitive-context",
    );
  });

  test("drops groups and unsupported media with diagnostics", () => {
    const groupEvents = weixinAdapterInternals.adaptWeixinMessage(
      {
        message_id: "g-1",
        from_user_id: "wx-user",
        group_id: "group",
        item_list: [{ type: 1, text_item: { text: "ignored" } }],
      },
      "weixin:bot",
      emptyWeixinRuntimeState(),
      24,
    );
    expect(groupEvents).toEqual([
      expect.objectContaining({
        kind: "diagnostic",
        outcome: "dropped",
        reason: "weixin_group_unsupported",
      }),
    ]);

    const voiceEvents = weixinAdapterInternals.adaptWeixinMessage(
      {
        message_id: "v-1",
        from_user_id: "wx-user",
        item_list: [{ type: 3, voice_item: { text: "transcript" } }],
      },
      "weixin:bot",
      emptyWeixinRuntimeState(),
      24,
    );
    expect(voiceEvents).toEqual([
      expect.objectContaining({
        outcome: "dropped",
        reason: "weixin_media_unsupported",
      }),
    ]);
  });

  test("commits the sync cursor only after the complete batch reaches core", async () => {
    const message = {
      message_id: "cursor-message",
      from_user_id: "wx-user",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    };
    const failedRuntime = emptyWeixinRuntimeState();
    const failedController = new AbortController();
    const api = {
      async getUpdates() {
        return {
          ret: 0,
          msgs: [message],
          get_updates_buf: "cursor-after-batch",
        };
      },
    } as unknown as WeixinApiClient;
    await weixinAdapterInternals.pollWeixin(
      api,
      failedRuntime,
      async (event) => {
        if (event.kind === "message") {
          failedController.abort();
          throw new Error("core persistence failed");
        }
      },
      "weixin:bot",
      async () => undefined,
      logger,
      failedController.signal,
      24,
    );
    expect(failedRuntime.getUpdatesBuf).toBe("");

    const succeededRuntime = emptyWeixinRuntimeState();
    const succeededController = new AbortController();
    await weixinAdapterInternals.pollWeixin(
      api,
      succeededRuntime,
      async (event) => {
        if (event.kind === "message") {
          succeededController.abort();
        }
      },
      "weixin:bot",
      async () => undefined,
      logger,
      succeededController.signal,
      24,
    );
    expect(succeededRuntime.getUpdatesBuf).toBe("cursor-after-batch");
  });

  test("passes context and idempotency key in outbound requests without logging secrets", async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const client = new WeixinApiClient({
      baseUrl: "https://example.test",
      token: "bot-secret",
      logger,
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return Response.json({ ret: 0 });
      },
    });
    await client.sendText({
      to: "wx-user",
      text: "done",
      contextToken: "context-secret",
      clientId: "outbox-key",
    });

    expect(requests[0]?.url).toEndWith("/ilink/bot/sendmessage");
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer bot-secret",
    );
    expect(requests[0]?.body).toMatchObject({
      msg: {
        client_id: "outbox-key",
        context_token: "context-secret",
        to_user_id: "wx-user",
      },
    });
  });

  test("decrypts AES-128-ECB CDN payloads and enforces the size limit", async () => {
    const key = crypto.randomBytes(16);
    const plain = Buffer.from("private attachment");
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const descriptor = {
      kind: "file" as const,
      media: {
        full_url: "https://cdn.example.test/download",
        aes_key: key.toString("base64"),
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const fetchImpl = async () =>
      new Response(encrypted, {
        headers: { "content-length": String(encrypted.byteLength) },
      });

    await expect(
      weixinAdapterInternals.downloadAndDecryptAttachment(
        descriptor,
        1_000,
        fetchImpl,
      ),
    ).resolves.toEqual(plain);
    await expect(
      weixinAdapterInternals.downloadAndDecryptAttachment(
        descriptor,
        1,
        fetchImpl,
      ),
    ).rejects.toThrow("exceeds");
  });
});

describe("Weixin private state", () => {
  test("stores credentials and runtime as owner-only files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "chat2codex-weixin-"),
    );
    temporaryDirectories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const runtimePath = path.join(directory, "runtime.json");
    const credentials = {
      schemaVersion: 1 as const,
      accountId: "bot-1",
      token: "secret",
      baseUrl: "https://example.test",
      userId: "wx-user",
      savedAt: new Date().toISOString(),
    };
    await saveWeixinCredentials(credentialsPath, credentials);
    await saveWeixinRuntime(runtimePath, emptyWeixinRuntimeState());

    expect(await loadWeixinCredentials(credentialsPath)).toEqual(credentials);
    expect(await loadWeixinRuntime(runtimePath)).toEqual(
      emptyWeixinRuntimeState(),
    );
    expect((await fs.stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(runtimePath)).mode & 0o777).toBe(0o600);
  });
});

describe("Weixin QR protocol", () => {
  test("requests bot_type 3 and sends only the local token list", async () => {
    let request: { url: string; body: unknown } | undefined;
    const response = await weixinSetupInternals.fetchQrCode(
      ["existing-token"],
      new AbortController().signal,
      async (input, init) => {
        request = {
          url: String(input),
          body: JSON.parse(String(init?.body)) as unknown,
        };
        return Response.json({
          qrcode: "opaque-code",
          qrcode_img_content: "https://example.test/scan",
        });
      },
    );
    expect(request).toEqual({
      url: "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      body: { local_token_list: ["existing-token"] },
    });
    expect(response.qrcode).toBe("opaque-code");
  });

  test("polls verification codes and validates HTTPS redirect hosts", async () => {
    let observedUrl = "";
    const status = await weixinSetupInternals.fetchQrStatus(
      "https://ilinkai.weixin.qq.com",
      "opaque-code",
      "123456",
      new AbortController().signal,
      async (input) => {
        observedUrl = String(input);
        return Response.json({
          status: "scaned_but_redirect",
          redirect_host: "sh.example.test",
        });
      },
    );
    expect(new URL(observedUrl).searchParams.get("qrcode")).toBe("opaque-code");
    expect(new URL(observedUrl).searchParams.get("verify_code")).toBe("123456");
    expect(status.status).toBe("scaned_but_redirect");
    expect(
      weixinSetupInternals.normalizeRedirectHost("sh.example.test"),
    ).toBe("https://sh.example.test");
    expect(() =>
      weixinSetupInternals.normalizeRedirectHost("http://unsafe.example.test"),
    ).toThrow("HTTPS");
  });

  test("handles waiting, scan, verification, IDC redirect, confirmation, expiry, and duplicate binding", async () => {
    const statusResponses = [
      { status: "wait" },
      { status: "scaned" },
      { status: "need_verifycode" },
      { status: "scaned_but_redirect", redirect_host: "sh.example.test" },
      {
        status: "confirmed",
        bot_token: "bot-token",
        ilink_bot_id: "bot-id",
        ilink_user_id: "wx-user",
        baseurl: "https://api.example.test",
      },
    ];
    const observedStatusUrls: string[] = [];
    const result = await weixinSetupInternals.runQrLogin(
      [],
      new AbortController().signal,
      async (input) => {
        const url = String(input);
        if (url.includes("get_bot_qrcode")) {
          return Response.json({
            qrcode: "qr-1",
            qrcode_img_content: "https://example.test/scan-1",
          });
        }
        observedStatusUrls.push(url);
        return Response.json(statusResponses.shift());
      },
      {
        displayQr() {},
        async readVerifyCode() {
          return "654321";
        },
        async delay() {},
      },
    );
    expect(result).toEqual({
      kind: "confirmed",
      accountId: "bot-id",
      token: "bot-token",
      userId: "wx-user",
      baseUrl: "https://api.example.test",
    });
    expect(
      observedStatusUrls.some(
        (url) => new URL(url).searchParams.get("verify_code") === "654321",
      ),
    ).toBe(true);
    expect(observedStatusUrls.at(-1)).toStartWith(
      "https://sh.example.test/",
    );

    let qrRequests = 0;
    const afterExpiry = await weixinSetupInternals.runQrLogin(
      ["existing-token"],
      new AbortController().signal,
      async (input) => {
        if (String(input).includes("get_bot_qrcode")) {
          qrRequests += 1;
          return Response.json({
            qrcode: `qr-${qrRequests}`,
            qrcode_img_content: `https://example.test/scan-${qrRequests}`,
          });
        }
        return Response.json(
          qrRequests === 1
            ? { status: "expired" }
            : { status: "binded_redirect" },
        );
      },
      {
        displayQr() {},
        async delay() {},
      },
    );
    expect(afterExpiry).toEqual({ kind: "already_connected" });
    expect(qrRequests).toBe(2);
  });
});
