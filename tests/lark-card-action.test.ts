import { describe, expect, test } from "bun:test";

import { adaptLarkCardActionEvent } from "../src/bot/lark-card-action.js";

describe("Lark card action adaptation", () => {
  test("adapts SDK-normalized stop button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_message",
      },
      operator: {
        open_id: "ou_sender",
        user_id: "u_sender",
        union_id: "on_sender",
      },
      action: {
        tag: "button",
        value: {
          app: "chat2codex",
          action: "stop_run",
        },
      },
    });

    expect(action).toEqual({
      action: "stop_run",
      chatId: "oc_chat",
      messageId: "om_message",
      sender: {
        openId: "ou_sender",
        userId: "u_sender",
        unionId: "on_sender",
      },
    });
  });

  test("adapts raw v2 card callbacks", () => {
    const action = adaptLarkCardActionEvent({
      event: {
        context: {
          open_chat_id: "oc_chat",
          open_message_id: "om_message",
        },
        operator: {
          open_id: "ou_sender",
        },
        action: {
          value: {
            app: "chat2codex",
            action: "stop_run",
          },
        },
      },
    });

    expect(action).toMatchObject({
      action: "stop_run",
      chatId: "oc_chat",
      messageId: "om_message",
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts retry button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_message",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "retry_run",
        },
      },
    });

    expect(action).toMatchObject({
      action: "retry_run",
      chatId: "oc_chat",
      messageId: "om_message",
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts approval button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_approval",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "resolve_approval",
          approvalId: "approval_1",
          decisionIndex: 2,
        },
      },
    });

    expect(action).toMatchObject({
      action: "resolve_approval",
      chatId: "oc_chat",
      messageId: "om_approval",
      approvalId: "approval_1",
      decisionIndex: 2,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts project selection button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_projects",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "select_project",
          projectIndex: 3,
          page: 1,
        },
      },
    });

    expect(action).toMatchObject({
      action: "select_project",
      chatId: "oc_chat",
      messageId: "om_projects",
      projectIndex: 3,
      page: 1,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts session resume button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_sessions",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "resume_thread",
          threadIndex: 2,
          page: 1,
        },
      },
    });

    expect(action).toMatchObject({
      action: "resume_thread",
      chatId: "oc_chat",
      messageId: "om_sessions",
      threadIndex: 2,
      page: 1,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts project pagination button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_projects",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "page_projects",
          page: 2,
        },
      },
    });

    expect(action).toMatchObject({
      action: "page_projects",
      chatId: "oc_chat",
      messageId: "om_projects",
      page: 2,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts session pagination button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_sessions",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "page_sessions",
          page: 2,
        },
      },
    });

    expect(action).toMatchObject({
      action: "page_sessions",
      chatId: "oc_chat",
      messageId: "om_sessions",
      page: 2,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("ignores unrelated card actions", () => {
    expect(
      adaptLarkCardActionEvent({
        context: {
          open_chat_id: "oc_chat",
        },
        action: {
          value: {
            app: "chat2codex",
            action: "approve_run",
          },
        },
      }),
    ).toBeNull();
  });
});
