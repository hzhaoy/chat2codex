import { describe, expect, test } from "bun:test";

import {
  adaptLarkCardActionEvent,
  answerMcpElicitationCardAction,
  resolveMcpElicitationCardAction,
  resolvePermissionApprovalCardAction,
} from "../src/bot/lark-card-action.js";

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

  test("adapts run detail button callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_result",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "show_run_detail",
          detailKind: "diff",
        },
      },
    });

    expect(action).toMatchObject({
      action: "show_run_detail",
      chatId: "oc_chat",
      messageId: "om_result",
      detailKind: "diff",
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

  test("adapts requestUserInput option callbacks", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_user_input",
      },
      operator: {
        open_id: "ou_sender",
      },
      action: {
        value: {
          app: "chat2codex",
          action: "answer_user_input",
          userInputId: "user_input_1",
          questionId: "mode",
          optionIndex: 1,
        },
      },
    });

    expect(action).toMatchObject({
      action: "answer_user_input",
      chatId: "oc_chat",
      messageId: "om_user_input",
      userInputId: "user_input_1",
      questionId: "mode",
      optionIndex: 1,
      sender: {
        openId: "ou_sender",
      },
    });
  });

  test("adapts requestUserInput skip and cancel callbacks", () => {
    const skip = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_user_input",
      },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: "answer_user_input",
          userInputId: "user_input_1",
          questionId: "mode",
        },
      },
    });
    const cancel = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_user_input",
      },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: "cancel_user_input",
          userInputId: "user_input_1",
        },
      },
    });

    expect(skip).toMatchObject({
      action: "answer_user_input",
      userInputId: "user_input_1",
      questionId: "mode",
    });
    expect(skip?.optionIndex).toBeUndefined();
    expect(cancel).toMatchObject({
      action: "cancel_user_input",
      userInputId: "user_input_1",
      chatId: "oc_chat",
      messageId: "om_user_input",
    });
  });

  test("adapts bounded additional-permission decisions", () => {
    const action = adaptLarkCardActionEvent({
      context: {
        open_chat_id: "oc_chat",
        open_message_id: "om_permission",
      },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: resolvePermissionApprovalCardAction,
          requestId: "permission_local_1",
          decision: "grantSession",
          permissions: { network: { enabled: true } },
        },
      },
    });

    expect(action).toMatchObject({
      action: resolvePermissionApprovalCardAction,
      chatId: "oc_chat",
      messageId: "om_permission",
      requestId: "permission_local_1",
      decision: "grantSession",
      sender: { openId: "ou_sender" },
    });
    expect(action).not.toHaveProperty("permissions");
  });

  test("adapts MCP option and terminal decisions without typed values", () => {
    const option = adaptLarkCardActionEvent({
      context: { open_chat_id: "oc_chat", open_message_id: "om_mcp" },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: answerMcpElicitationCardAction,
          requestId: "mcp_local_1",
          fieldId: "environment",
          optionIndex: 1,
          answer: "production",
        },
      },
    });
    const resolution = adaptLarkCardActionEvent({
      context: { open_chat_id: "oc_chat", open_message_id: "om_mcp" },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: resolveMcpElicitationCardAction,
          requestId: "mcp_local_1",
          decision: "decline",
          url: "https://must-not-be-forwarded.example",
        },
      },
    });

    expect(option).toMatchObject({
      action: answerMcpElicitationCardAction,
      requestId: "mcp_local_1",
      fieldId: "environment",
      optionIndex: 1,
    });
    expect(option).not.toHaveProperty("answer");
    expect(resolution).toMatchObject({
      action: resolveMcpElicitationCardAction,
      requestId: "mcp_local_1",
      decision: "decline",
    });
    expect(resolution).not.toHaveProperty("url");
  });

  test("drops oversized identifiers and invalid interactive decisions", () => {
    const action = adaptLarkCardActionEvent({
      context: { open_chat_id: "oc_chat", open_message_id: "om_mcp" },
      operator: { open_id: "ou_sender" },
      action: {
        value: {
          app: "chat2codex",
          action: resolvePermissionApprovalCardAction,
          requestId: "r".repeat(129),
          fieldId: "f".repeat(129),
          optionIndex: 999,
          decision: "grant_forever",
        },
      },
    });

    expect(action).toMatchObject({ action: resolvePermissionApprovalCardAction });
    expect(action?.requestId).toBeUndefined();
    expect(action?.fieldId).toBeUndefined();
    expect(action?.optionIndex).toBeUndefined();
    expect(action?.decision).toBeUndefined();
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
