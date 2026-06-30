import { describe, expect, test } from "bun:test";

import {
  adaptLarkTextEvent,
  messageMentionsBot,
  toIncomingTextMessage,
} from "../src/bot/lark-event.js";

describe("Lark event adaptation", () => {
  test("routes direct text messages without requiring a bot mention", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "p2p",
        text: "hello",
      }),
      {},
    );

    expect(incoming).toMatchObject({
      messageId: "m1",
      chatId: "oc_chat",
      chatType: "direct",
      sender: { openId: "ou_sender" },
      text: "hello",
    });
  });

  test("routes direct image messages as attachments", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "p2p",
        messageType: "image",
        content: {
          image_key: "img_v3_test",
        },
      }),
      {},
    );

    expect(incoming).toMatchObject({
      messageId: "m1",
      chatId: "oc_chat",
      chatType: "direct",
      text: "",
      attachments: [
        {
          kind: "image",
          key: "img_v3_test",
        },
      ],
    });
  });

  test("routes direct post image messages as attachments", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "p2p",
        messageType: "post",
        content: makePostContent([
          [
            {
              tag: "img",
              image_key: "img_v3_test",
            },
          ],
        ]),
      }),
      {},
    );

    expect(incoming).toMatchObject({
      text: "",
      attachments: [
        {
          kind: "image",
          key: "img_v3_test",
        },
      ],
    });
  });

  test("routes direct file messages as attachments", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "p2p",
        messageType: "file",
        content: {
          file_key: "file_v2_test",
          file_name: "report.pdf",
        },
      }),
      {},
    );

    expect(incoming).toMatchObject({
      text: "",
      attachments: [
        {
          kind: "file",
          key: "file_v2_test",
          name: "report.pdf",
        },
      ],
    });
  });

  test("ignores group messages when the bot is not mentioned", () => {
    expect(
      toIncomingTextMessage(
        makeEvent({
          chatType: "group",
          text: "hello everyone",
        }),
        { openId: "ou_bot" },
      ),
    ).toBeNull();
  });

  test("reports a diagnostic when a mention-looking group message does not mention the bot", () => {
    const result = adaptLarkTextEvent(
      makeEvent({
        chatType: "group",
        text: "@_user_1 /whoami",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }],
      }),
      { openId: "ou_bot" },
    );

    expect(result.incoming).toBeNull();
    expect(result.diagnostic).toMatchObject({
      reason: "group_without_bot_mention",
      messageId: "m1",
      chatId: "oc_chat",
      chatType: "group",
      mentionCount: 1,
      startsWithMention: true,
      botIdentityResolved: true,
    });
  });

  test("ignores group messages that mention someone other than the bot", () => {
    expect(
      toIncomingTextMessage(
        makeEvent({
          chatType: "group",
          text: "@_user_1 hello",
          mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }],
        }),
        { openId: "ou_bot" },
      ),
    ).toBeNull();
  });

  test("routes group messages only when the bot is mentioned", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "group",
        text: "@_user_1 /whoami",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
      }),
      { openId: "ou_bot" },
    );

    expect(incoming).toMatchObject({
      messageId: "m1",
      chatId: "oc_chat",
      chatType: "group",
      text: "@_user_1 /whoami",
    });
  });

  test("routes group attachments only when the bot is mentioned", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "group",
        messageType: "file",
        content: {
          file_key: "file_v2_test",
          file_name: "report.pdf",
        },
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
      }),
      { openId: "ou_bot" },
    );

    expect(incoming).toMatchObject({
      chatType: "group",
      attachments: [
        {
          kind: "file",
          key: "file_v2_test",
        },
      ],
    });

    expect(
      toIncomingTextMessage(
        makeEvent({
          chatType: "group",
          messageType: "image",
          content: {
            image_key: "img_v3_test",
          },
        }),
        { openId: "ou_bot" },
      ),
    ).toBeNull();
  });

  test("routes group post image messages when a post at node mentions the bot", () => {
    const incoming = toIncomingTextMessage(
      makeEvent({
        chatType: "group",
        messageType: "post",
        content: makePostContent([
          [
            {
              tag: "at",
              user_id: "ou_bot",
              text: "@Chat2Codex",
            },
            {
              tag: "text",
              text: "这张图片说的是什么呢",
            },
          ],
          [
            {
              tag: "img",
              image_key: "img_v3_test",
            },
          ],
        ]),
      }),
      { openId: "ou_bot" },
    );

    expect(incoming).toMatchObject({
      chatType: "group",
      text: "@Chat2Codex 这张图片说的是什么呢",
      attachments: [
        {
          kind: "image",
          key: "img_v3_test",
        },
      ],
    });
  });

  test("does not treat any group mention as the bot when bot identity is unavailable", () => {
    expect(
      messageMentionsBot(
        {
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
        },
        {},
      ),
    ).toBe(false);
  });
});

function makeEvent(options: {
  chatType: "p2p" | "group";
  text?: string;
  messageType?: "text" | "image" | "file";
  content?: Record<string, unknown>;
  mentions?: Array<{ key: string; id: { open_id?: string } }>;
}) {
  const messageType = options.messageType ?? "text";
  const content = options.content ?? { text: options.text ?? "" };
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender",
      },
    },
    message: {
      message_id: "m1",
      chat_id: "oc_chat",
      chat_type: options.chatType,
      message_type: messageType,
      content: JSON.stringify(content),
      mentions: options.mentions,
    },
  };
}

function makePostContent(content: unknown[][]) {
  return {
    zh_cn: {
      content,
    },
  };
}
