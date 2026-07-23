import { describe, expect, test } from "bun:test";

import {
  buildApprovalCard,
  buildHostHealthCard,
  buildMcpElicitationCard,
  buildPermissionApprovalCard,
  buildProjectListCard,
  buildRunStatusCard,
  buildSessionListCard,
  buildUserInputCard,
  getMcpElicitationCardOptionValue,
  isMcpElicitationCardSkipAllowed,
  isMcpElicitationCardDecisionAllowed,
  isPermissionApprovalCardDecisionAllowed,
  type LarkInteractiveCard,
} from "../src/bot/lark-card.js";
import {
  answerMcpElicitationCardAction,
  answerUserInputCardAction,
  cancelUserInputCardAction,
  resolveMcpElicitationCardAction,
  resolvePermissionApprovalCardAction,
  retryRunCardActionValue,
  runCardActionApp,
} from "../src/bot/lark-card-action.js";

describe("Lark run status cards", () => {
  test("builds an updateable running status card", () => {
    const card = buildRunStatusCard({
      status: "running",
      detail: "Codex 正在调用工具。",
      cwd: "/tmp/chat2codex",
      prompt: "summarize the repo",
      startedAt: "2026-06-29T12:00:00.000Z",
      updatedAt: "2026-06-29T12:00:15.000Z",
    });

    expect(card.config).toEqual({
      wide_screen_mode: true,
      update_multi: true,
    });
    expect(card.header).toEqual({
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Codex 正在处理",
      },
    });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Codex 正在调用工具。");
    expect(serialized).toContain("发送 /stop 可以停止当前任务");
    expect(serialized).not.toContain("stop_run");
    expect(serialized).not.toContain("retry_run");
  });

  test("uses terminal status templates", () => {
    expect(
      buildRunStatusCard({
        status: "success",
        detail: "done",
        cwd: "/tmp/chat2codex",
        prompt: "prompt",
        startedAt: "2026-06-29T12:00:00.000Z",
      }).header.template,
    ).toBe("green");
    expect(
      buildRunStatusCard({
        status: "failed",
        detail: "failed",
        cwd: "/tmp/chat2codex",
        prompt: "prompt",
        startedAt: "2026-06-29T12:00:00.000Z",
      }).header.template,
    ).toBe("red");
    expect(
      buildRunStatusCard({
        status: "stopped",
        detail: "stopped",
        cwd: "/tmp/chat2codex",
        prompt: "prompt",
        startedAt: "2026-06-29T12:00:00.000Z",
      }).header.template,
    ).toBe("grey");
  });

  test("includes retry actions on failed and stopped cards", () => {
    for (const status of ["failed", "stopped"] as const) {
      const serialized = JSON.stringify(
        buildRunStatusCard({
          status,
          detail: status,
          cwd: "/tmp/chat2codex",
          prompt: "prompt",
          startedAt: "2026-06-29T12:00:00.000Z",
        }),
      );

      expect(serialized).toContain("重试");
      expect(serialized).toContain(JSON.stringify(retryRunCardActionValue));
      expect(serialized).not.toContain("stop_run");
    }
  });

  test("does not include card actions on successful cards", () => {
    const serialized = JSON.stringify(
      buildRunStatusCard({
        status: "success",
        detail: "done",
        cwd: "/tmp/chat2codex",
        prompt: "prompt",
        startedAt: "2026-06-29T12:00:00.000Z",
      }),
    );

    expect(serialized).not.toContain("stop_run");
    expect(serialized).not.toContain("retry_run");
  });

  test("includes result summary and detail actions on completed cards", () => {
    const serialized = JSON.stringify(
      buildRunStatusCard({
        status: "success",
        detail: "done",
        cwd: "/tmp/chat2codex",
        prompt: "prompt",
        startedAt: "2026-06-29T12:00:00.000Z",
        result: {
          durationMs: 1234,
          changedFileCount: 2,
          commandCount: 1,
          diffAvailable: true,
          logsAvailable: true,
          filesPreview: ["src/app.ts", "tests/app.test.ts"],
          statusNote: "ok",
        },
      }),
    );

    expect(serialized).toContain("本轮结果");
    expect(serialized).toContain("files: 2");
    expect(serialized).toContain("diff: available");
    expect(serialized).toContain("changed:");
    expect(serialized).toContain("摘要");
    expect(serialized).toContain("文件");
    expect(serialized).toContain("Diff");
    expect(serialized).toContain("日志");
    expect(serialized).toContain("show_run_detail");
  });

  test("builds host health cards", () => {
    const card = buildHostHealthCard({
      title: "桥接服务在线，Codex CLI 可用。",
      status: "warn",
      host: "test-host",
      platform: "darwin arm64",
      uptime: "1m",
      queueDepth: 0,
      activeRun: "(none)",
      approvalWait: "(none)",
      codexBin: "/usr/local/bin/codex",
      codexVersion: "codex 1.2.3",
      defaultCwd: "/tmp/chat2codex",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      runTimeout: "10m",
      approvalTimeout: "5m",
      access: "direct:on groups:off allowed_chats=0 allowed_users=0",
      statePath: "/tmp/chat2codex/state.json",
      attachmentDir: "/tmp/chat2codex/attachments",
      warnings: ["CODEX_BIN is relative"],
    });

    const serialized = JSON.stringify(card);
    expect(card.header.template).toBe("yellow");
    expect(serialized).toContain("Host 健康卡");
    expect(serialized).toContain("codex 1\\\\.2\\\\.3");
    expect(serialized).toContain("queue");
    expect(serialized).toContain("CODEX\\\\_BIN is relative");
  });

  test("builds approval buttons from Codex decisions", () => {
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_1",
        kind: "command",
        command: "rm -rf build",
        cwd: "/tmp/chat2codex",
        reason: "requires approval by policy",
        proposedExecpolicyAmendment: ["rm", "-rf"],
        decisions: [
          "accept",
          "acceptForSession",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["rm", "-rf"],
            },
          },
          "decline",
          "cancel",
        ],
      },
    });

    const serialized = JSON.stringify(card);
    expect(card.header.title.content).toBe("Codex 请求执行命令");
    expect(serialized).toContain("rm \\\\-rf build");
    expect(serialized).toContain("proposed_exec_policy_amendment");
    expect(serialized).toContain("exec_policy_decisions");
    expect(serialized).toContain("rm \\\\-rf");
    expect(serialized).toContain("Approve");
    expect(serialized).toContain("Exec rule: rm -rf");
    expect(serialized).toContain("Approve session");
    expect(serialized).toContain("Deny");
    expect(serialized).toContain("Cancel turn");
    expect(serialized).toContain(
      JSON.stringify({
        app: runCardActionApp,
        action: "resolve_approval",
        approvalId: "approval_1",
        decisionIndex: 3,
      }),
    );
  });

  test("preserves approval command whitespace exactly", () => {
    const command = "printf 'a  b'\nprintf 'c   d'";
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_1",
        kind: "command",
        command,
        cwd: "/tmp/chat2codex",
        proposedExecpolicyAmendment: ["printf", "a  b", "line\nbreak"],
        decisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["printf", "a  b", "line\nbreak"],
            },
          },
          "cancel",
        ],
      },
    });

    const fields = approvalCardFieldText(card);
    expect(fields).toContain(command);
    expect(fields).toContain('printf "a  b" "line\\\\nbreak"');
    expect(fields).not.toContain("printf 'a b'");
    expect(fields).not.toContain("printf 'c d'");
  });

  test("discloses and distinguishes every exec policy decision", () => {
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_exec_rules_1",
        kind: "command",
        command: "git fetch origin",
        decisions: [
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "fetch", "origin"],
            },
          },
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "fetch", "upstream"],
            },
          },
          "decline",
        ],
      },
    });

    const fields = approvalCardFieldText(card);
    expect(fields).toContain("exec_policy_decisions");
    expect(fields).toContain("1: git fetch origin");
    expect(fields).toContain("2: git fetch upstream");
    expect(approvalButtonLabels(card)).toEqual([
      "Exec rule: git fetch origin",
      "Exec rule: git fetch upstream",
      "Deny",
    ]);
  });

  test("discloses additional permissions and network policy scope in approval cards", () => {
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_network_1",
        kind: "command",
        command: "curl https://registry.example.com/package",
        cwd: "/tmp/chat2codex",
        networkApprovalContext: {
          protocol: "https",
          host: "registry.example.com",
        },
        additionalPermissions: {
          network: {
            allowedDomains: ["registry.example.com"],
          },
          fileSystem: {
            write: ["/tmp/package-cache"],
          },
        },
        proposedNetworkPolicyAmendments: [
          { host: "registry.example.com", action: "allow" },
          { host: "telemetry.example.com", action: "deny" },
        ],
        decisions: [
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                action: "allow",
                host: "registry.example.com",
              },
            },
          },
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                action: "deny",
                host: "telemetry.example.com",
              },
            },
          },
          "decline",
        ],
      },
    });

    const fields = approvalCardFieldText(card);
    const serialized = JSON.stringify(card);
    expect(fields).toContain("additional_permissions");
    expect(fields).toContain('"fileSystem"');
    expect(fields).toContain('"network"');
    expect(fields.indexOf('"fileSystem"')).toBeLessThan(fields.indexOf('"network"'));
    expect(fields).toContain("network_approval_context");
    expect(fields).toContain('"host":"registry\\.example\\.com"');
    expect(fields).toContain('"protocol":"https"');
    expect(fields).toContain("proposed_network_policy_amendments");
    expect(fields).toContain('"action":"allow","host":"registry\\.example\\.com"');
    expect(fields).toContain('"action":"deny","host":"telemetry\\.example\\.com"');
    expect(fields).toContain("network_policy_decisions");
    expect(fields).toContain("1: Network allow: registry\\.example\\.com");
    expect(fields).toContain("2: Network deny: telemetry\\.example\\.com");
    expect(serialized).toContain("Network allow: registry.example.com");
    expect(serialized).toContain("Network deny: telemetry.example.com");
    expect(serialized).not.toContain("Apply network policy");
  });

  test("renders bounded stable summaries without invoking approval payload accessors", () => {
    let accessorCalls = 0;
    const additionalPermissions: Record<string, unknown> = {
      zeta: "z".repeat(1_000),
      alpha: true,
    };
    Object.defineProperty(additionalPermissions, "dangerous", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must not render";
      },
    });
    additionalPermissions.self = additionalPermissions;

    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_permissions_1",
        kind: "command",
        additionalPermissions,
        decisions: ["decline", "cancel"],
      },
    });

    const fields = approvalCardFieldText(card);
    expect(accessorCalls).toBe(0);
    expect(fields.indexOf('"alpha"')).toBeLessThan(fields.indexOf('"dangerous"'));
    expect(fields.indexOf('"dangerous"')).toBeLessThan(fields.indexOf('"self"'));
    expect(fields).toContain("accessor omitted");
    expect(fields).toContain("circular reference");
    expect(fields).not.toContain("must not render");
    expect(fields.length).toBeLessThan(900);
  });

  test("removes approval actions when security details cannot be shown completely", () => {
    const longHost = `${"segment.".repeat(20)}example.com`;
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_oversized_1",
        kind: "command",
        command: "curl https://example.com",
        additionalPermissions: {
          fileSystem: {
            write: Array.from({ length: 30 }, (_, index) => `/private/path/${index}`),
          },
        },
        decisions: [
          "accept",
          "acceptForSession",
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { action: "allow", host: longHost },
            },
          },
          "decline",
          "cancel",
        ],
      },
    });

    expect(approvalButtonLabels(card)).toEqual(["Deny", "Cancel turn"]);
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("仅保留拒绝/取消操作");
    expect(serialized).toContain('"decisionIndex":3');
    expect(serialized).toContain('"decisionIndex":4');
    expect(serialized).not.toContain('"decisionIndex":0');
    expect(serialized).not.toContain('"decisionIndex":1');
    expect(serialized).not.toContain('"decisionIndex":2');
  });

  test("renders no action element when an undisclosed command has no safe decision", () => {
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_missing_command_1",
        kind: "command",
        command: null,
        decisions: ["accept"],
      },
    });

    expect(approvalButtonLabels(card)).toEqual([]);
    expect(JSON.stringify(card)).toContain("No safe decision is available");
  });

  test("limits file-change cards without target details to deny and cancel", () => {
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_file_1",
        kind: "file_change",
        reason: "write outside the current root",
        grantRoot: "/private/project",
        decisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });

    expect(approvalButtonLabels(card)).toEqual(["Deny", "Cancel turn"]);
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("file-change targets and patch details are unavailable");
    expect(serialized).toContain('"decisionIndex":2');
    expect(serialized).toContain('"decisionIndex":3');
    expect(serialized).not.toContain('"decisionIndex":0');
    expect(serialized).not.toContain('"decisionIndex":1');
  });

  test("builds requestUserInput option buttons for the first unanswered question", () => {
    const card = buildUserInputCard({
      status: "pending",
      replyCode: "R7K2M9",
      updatedAt: "2026-07-20T12:00:00.000Z",
      answers: {
        editor: { answers: ["VS Code"] },
      },
      request: {
        id: "user_input_1",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        autoResolutionMs: 120_000,
        questions: [
          {
            id: "editor",
            header: "Editor",
            question: "Which editor do you use?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "VS Code", description: "Use the Visual Studio Code setup." },
            ],
          },
          {
            id: "mode",
            header: "Mode",
            question: "Which mode should Codex use?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Safe", description: "Keep the current security boundary." },
              { label: "Fast", description: "Prefer the faster execution path." },
            ],
          },
        ],
      },
    });

    expect(card.header.title.content).toBe("Codex 需要你的回答");
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Which mode should Codex use?");
    expect(serialized).not.toContain("Which editor do you use?");
    expect(serialized).toContain("Keep the current security boundary\\\\.");

    const actions = cardActionValues(card);
    expect(actions).toContainEqual({
      app: runCardActionApp,
      action: answerUserInputCardAction,
      userInputId: "user_input_1",
      questionId: "mode",
      optionIndex: 0,
    });
    expect(actions).toContainEqual({
      app: runCardActionApp,
      action: answerUserInputCardAction,
      userInputId: "user_input_1",
      questionId: "mode",
      optionIndex: 1,
    });
    expect(actions).toContainEqual({
      app: runCardActionApp,
      action: answerUserInputCardAction,
      userInputId: "user_input_1",
      questionId: "mode",
    });
    expect(actions).toContainEqual({
      app: runCardActionApp,
      action: cancelUserInputCardAction,
      userInputId: "user_input_1",
    });
    expect(actions.every((value) => !("label" in value) && !("answer" in value))).toBe(true);
  });

  test("shows bounded text reply guidance for free-form and other answers", () => {
    for (const question of [
      {
        id: "name",
        header: "Name",
        question: "What should this release be called?",
        isOther: false,
        isSecret: false,
        options: null,
      },
      {
        id: "target",
        header: "Target",
        question: "Choose a target or provide another value.",
        isOther: true,
        isSecret: false,
        options: [{ label: "Staging", description: "Use staging." }],
      },
    ]) {
      const card = buildUserInputCard({
        status: "pending",
        replyCode: "R7K2M9",
        updatedAt: "2026-07-20T12:00:00.000Z",
        request: {
          id: `user_input_${question.id}`,
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          autoResolutionMs: null,
          questions: [question],
        },
      });

      expect(JSON.stringify(card)).toContain("/answer R7K2M9 <内容>");
      expect(cardActionValues(card)).toContainEqual({
        app: runCardActionApp,
        action: answerUserInputCardAction,
        userInputId: `user_input_${question.id}`,
        questionId: question.id,
      });
    }
  });

  test("removes requestUserInput actions in terminal states and never echoes secret answers", () => {
    for (const status of ["resolved", "cancelled", "expired"] as const) {
      const card = buildUserInputCard({
        status,
        replyCode: "R7K2M9",
        updatedAt: "2026-07-20T12:00:00.000Z",
        answers: {
          token: { answers: ["super-secret-token"] },
        },
        request: {
          id: "user_input_secret",
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          autoResolutionMs: null,
          questions: [
            {
              id: "token",
              header: "Credential",
              question: "Provide the temporary token.",
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
        },
      });

      const serialized = JSON.stringify(card);
      expect(cardActionValues(card)).toEqual([]);
      expect(serialized).not.toContain("answer_user_input");
      expect(serialized).not.toContain("cancel_user_input");
      expect(serialized).not.toContain("super-secret-token");
    }
  });

  test("fails closed instead of offering chat input for pending secret questions", () => {
    const card = buildUserInputCard({
      status: "pending",
      replyCode: "R7K2M9",
      updatedAt: "2026-07-20T12:00:00.000Z",
      request: {
        id: "user_input_secret",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        autoResolutionMs: null,
        questions: [
          {
            id: "token",
            header: "Credential",
            question: "Provide the temporary token.",
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      },
    });

    const serialized = JSON.stringify(card);
    expect(cardActionValues(card)).toEqual([]);
    expect(serialized).not.toContain("/answer");
    expect(serialized).not.toContain("answer_user_input");
    expect(serialized).toContain("不会收集或提交回答");
  });

  test("bounds requestUserInput fields and visible option buttons", () => {
    const card = buildUserInputCard({
      status: "pending",
      replyCode: "R".repeat(200),
      updatedAt: "2026-07-20T12:00:00.000Z",
      request: {
        id: "user_input_bounded",
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        autoResolutionMs: null,
        questions: [
          {
            id: "choice",
            header: "H".repeat(1_000),
            question: "Q".repeat(5_000),
            isOther: false,
            isSecret: false,
            options: Array.from({ length: 20 }, (_, index) => ({
              label: `${index}-${"L".repeat(500)}`,
              description: "D".repeat(2_000),
            })),
          },
        ],
      },
    });

    const optionActions = cardActionValues(card).filter(
      (value) => value.action === answerUserInputCardAction && "optionIndex" in value,
    );
    expect(optionActions.length).toBeGreaterThan(0);
    expect(optionActions.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(card).length).toBeLessThan(8_000);
  });

  test("shows the complete normalized permission profile with three bounded decisions", () => {
    const card = buildPermissionApprovalCard({
      status: "pending",
      updatedAt: "2026-07-20T13:00:00.000Z",
      request: {
        id: "permission_local_1",
        cwd: "/workspace/chat2codex",
        reason: "The tool needs an isolated package cache.",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            globScanMaxDepth: 4,
            entries: [
              { access: "read", path: { type: "path", path: "/workspace/input" } },
              {
                access: "write",
                path: {
                  type: "special",
                  value: { kind: "project_roots", subpath: ".cache" },
                },
              },
            ],
            read: ["/legacy/read"],
            write: ["/legacy/write"],
          },
        },
      },
    });

    const fields = approvalCardFieldText(card);
    expect(card.header.title.content).toBe("Codex 请求额外权限");
    expect(fields).toContain("requested_profile");
    expect(fields).toContain('"access":"read"');
    expect(fields).toContain('"kind":"project\\_roots"');
    expect(fields).toContain('"enabled":true');
    expect(fields.indexOf('"fileSystem"')).toBeLessThan(fields.indexOf('"network"'));
    expect(approvalButtonLabels(card)).toEqual([
      "Deny",
      "Grant this turn",
      "Grant session",
    ]);

    const values = cardActionValues(card);
    expect(values).toEqual([
      {
        app: runCardActionApp,
        action: resolvePermissionApprovalCardAction,
        requestId: "permission_local_1",
        decision: "deny",
      },
      {
        app: runCardActionApp,
        action: resolvePermissionApprovalCardAction,
        requestId: "permission_local_1",
        decision: "grantTurn",
      },
      {
        app: runCardActionApp,
        action: resolvePermissionApprovalCardAction,
        requestId: "permission_local_1",
        decision: "grantSession",
      },
    ]);
    expect(values.every((value) => !("permissions" in value) && !("cwd" in value))).toBe(true);
    expect(
      isPermissionApprovalCardDecisionAllowed(
        {
          id: "permission_local_1",
          cwd: "/workspace/chat2codex",
          permissions: {
            network: { enabled: true },
            fileSystem: { write: ["/legacy/write"] },
          },
        },
        "grantTurn",
      ),
    ).toBe(true);
  });

  test("fails permission grants closed when the full profile cannot be displayed", () => {
    let accessorCalls = 0;
    const permissions: Record<string, unknown> = { network: { enabled: true } };
    Object.defineProperty(permissions, "fileSystem", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return { write: ["/must/not/be/read"] };
      },
    });
    const accessorCard = buildPermissionApprovalCard({
      status: "pending",
      updatedAt: "2026-07-20T13:00:00.000Z",
      request: {
        id: "permission_local_2",
        cwd: "/workspace/chat2codex",
        permissions,
      },
    });
    const oversizedCard = buildPermissionApprovalCard({
      status: "pending",
      updatedAt: "2026-07-20T13:00:00.000Z",
      request: {
        id: "permission_local_3",
        cwd: "/workspace/chat2codex",
        permissions: { fileSystem: { write: [`/${"x".repeat(400)}`] } },
      },
    });
    const oversizedIdCard = buildPermissionApprovalCard({
      status: "pending",
      updatedAt: "2026-07-20T13:00:00.000Z",
      request: {
        id: "p".repeat(129),
        cwd: "/workspace/chat2codex",
        permissions: {},
      },
    });

    expect(accessorCalls).toBe(0);
    for (const card of [accessorCard, oversizedCard]) {
      expect(approvalButtonLabels(card)).toEqual(["Deny"]);
      expect(JSON.stringify(card)).not.toContain("grantTurn");
      expect(JSON.stringify(card)).not.toContain("grantSession");
      expect(JSON.stringify(card)).toContain("不会提供任何授权按钮");
    }
    expect(cardActionValues(oversizedIdCard)).toEqual([]);
    expect(
      isPermissionApprovalCardDecisionAllowed(
        {
          id: "permission_local_3",
          cwd: "/workspace/chat2codex",
          permissions: { fileSystem: { write: [`/${"x".repeat(400)}`] } },
        },
        "grantSession",
      ),
    ).toBe(false);
  });

  test("removes permission actions from every terminal state", () => {
    for (const status of ["resolved", "declined", "cancelled", "expired"] as const) {
      const card = buildPermissionApprovalCard({
        status,
        decision: status === "resolved" ? "grantTurn" : undefined,
        updatedAt: "2026-07-20T13:00:00.000Z",
        request: {
          id: "permission_terminal",
          cwd: "/workspace/chat2codex",
          permissions: {},
        },
      });
      expect(cardActionValues(card)).toEqual([]);
      expect(JSON.stringify(card)).not.toContain("resolve_permission_approval");
    }
  });

  test("renders every standard MCP form field, type, requirement, enum and range", () => {
    const card = buildMcpElicitationCard({
      status: "pending",
      updatedAt: "2026-07-20T13:05:00.000Z",
      replyCode: "MCP7K2",
      request: {
        id: "mcp_local_1",
        serverName: "release-tools",
        threadId: "thread_1",
        turnId: "turn_1",
        message: "Choose the deployment settings.",
        mode: "form",
        fields: [
          {
            name: "environment",
            type: "enum",
            title: "Environment",
            description: "Deployment target.",
            required: true,
            default: null,
            options: [
              { value: "staging", title: "Staging" },
              { value: "production", title: "Production" },
            ],
          },
          {
            name: "retries",
            type: "integer",
            title: "Retries",
            description: null,
            required: true,
            minimum: 1,
            maximum: 5,
            default: 2,
          },
          {
            name: "notify",
            type: "boolean",
            title: "Notify",
            description: null,
            required: false,
            default: true,
          },
          {
            name: "regions",
            type: "multi_select",
            title: "Regions",
            description: null,
            required: false,
            minItems: 1,
            maxItems: 2,
            default: null,
            options: [
              { value: "cn", title: "China" },
              { value: "us", title: "United States" },
            ],
          },
          {
            name: "callback",
            type: "string",
            title: "Callback URL",
            description: null,
            required: false,
            format: "uri",
            minLength: 8,
            maxLength: 200,
            default: null,
          },
        ],
      },
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Environment");
    expect(serialized).toContain("type=enum");
    expect(serialized).toContain("required=yes");
    expect(serialized).toContain(
      "enum=0:Staging \\\\(staging\\\\) \\\\| 1:Production \\\\(production\\\\)",
    );
    expect(serialized).toContain("type=integer");
    expect(serialized).toContain("range=minimum=1, maximum=5");
    expect(serialized).toContain("type=boolean");
    expect(serialized).toContain("type=multi\\\\_select");
    expect(serialized).toContain("range=minItems=1, maxItems=2");
    expect(serialized).toContain("format=uri");
    expect(serialized).toContain("range=minLength=8, maxLength=200");

    const optionValues = cardActionValues(card).filter(
      (value) => value.action === answerMcpElicitationCardAction,
    );
    expect(optionValues).toEqual([
      {
        app: runCardActionApp,
        action: answerMcpElicitationCardAction,
        requestId: "mcp_local_1",
        fieldId: "environment",
        optionIndex: 0,
      },
      {
        app: runCardActionApp,
        action: answerMcpElicitationCardAction,
        requestId: "mcp_local_1",
        fieldId: "environment",
        optionIndex: 1,
      },
    ]);
    expect(optionValues.every((value) => !("answer" in value) && !("value" in value))).toBe(true);
    expect(
      getMcpElicitationCardOptionValue(
        {
          status: "pending",
          updatedAt: "2026-07-20T13:05:00.000Z",
          request: {
            id: "mcp_local_1",
            serverName: "release-tools",
            threadId: "thread_1",
            turnId: "turn_1",
            message: "Choose the deployment settings.",
            mode: "form",
            fields: [
              {
                name: "environment",
                type: "enum",
                title: "Environment",
                description: null,
                required: true,
                default: null,
                options: [
                  { value: "staging", title: "Staging" },
                  { value: "production", title: "Production" },
                ],
              },
            ],
          },
        },
        "environment",
        1,
      ),
    ).toBe("production");
  });

  test("offers typed MCP guidance and submit only after required fields are answered", () => {
    const request = {
      id: "mcp_local_2",
      serverName: "release-tools",
      threadId: "thread_1",
      turnId: "turn_1",
      message: "Configure retries.",
      mode: "form" as const,
      fields: [
        {
          name: "retries",
          type: "integer" as const,
          title: "Retries",
          description: null,
          required: true,
          minimum: 1,
          maximum: 5,
          default: null,
        },
        {
          name: "notify",
          type: "boolean" as const,
          title: "Notify",
          description: null,
          required: false,
          default: null,
        },
      ],
    };
    const pending = buildMcpElicitationCard({
      status: "pending",
      request,
      replyCode: "MCP7K2",
      updatedAt: "2026-07-20T13:05:00.000Z",
    });
    const ready = buildMcpElicitationCard({
      status: "pending",
      request,
      replyCode: "MCP7K2",
      answeredFieldIds: ["retries"],
      updatedAt: "2026-07-20T13:06:00.000Z",
    });

    expect(JSON.stringify(pending)).toContain('/mcp-answer MCP7K2 \\"retries\\" <内容>');
    expect(cardActionValues(pending)).not.toContainEqual(
      expect.objectContaining({ action: resolveMcpElicitationCardAction, decision: "accept" }),
    );
    expect(cardActionValues(ready)).toContainEqual({
      app: runCardActionApp,
      action: resolveMcpElicitationCardAction,
      requestId: "mcp_local_2",
      decision: "accept",
    });
    expect(
      isMcpElicitationCardDecisionAllowed(
        {
          status: "pending",
          request,
          updatedAt: "2026-07-20T13:05:00.000Z",
        },
        "accept",
      ),
    ).toBe(false);
    expect(
      isMcpElicitationCardDecisionAllowed(
        {
          status: "pending",
          request,
          answeredFieldIds: ["retries"],
          updatedAt: "2026-07-20T13:06:00.000Z",
        },
        "accept",
      ),
    ).toBe(true);
    expect(cardActionValues(ready)).toContainEqual({
      app: runCardActionApp,
      action: answerMcpElicitationCardAction,
      requestId: "mcp_local_2",
      fieldId: "notify",
      decision: "skip",
    });
    expect(
      isMcpElicitationCardSkipAllowed(
        {
          status: "pending",
          request,
          answeredFieldIds: ["retries"],
          updatedAt: "2026-07-20T13:06:00.000Z",
        },
        "notify",
      ),
    ).toBe(true);
    expect(
      getMcpElicitationCardOptionValue(
        {
          status: "pending",
          request,
          answeredFieldIds: ["retries"],
          updatedAt: "2026-07-20T13:06:00.000Z",
        },
        "notify",
        0,
      ),
    ).toBe(true);
    expect(
      isMcpElicitationCardSkipAllowed(
        {
          status: "pending",
          request,
          updatedAt: "2026-07-20T13:05:00.000Z",
        },
        "retries",
      ),
    ).toBe(false);
  });

  test("does not provide chat input or submit for secret/password-like MCP fields", () => {
    const card = buildMcpElicitationCard({
      status: "pending",
      replyCode: "MCP7K2",
      updatedAt: "2026-07-20T13:05:00.000Z",
      request: {
        id: "mcp_secret",
        serverName: "credential-helper",
        threadId: "thread_1",
        turnId: "turn_1",
        message: "Provide a credential.",
        mode: "form",
        fields: [
          {
            name: "api_token",
            type: "string",
            title: "API token",
            description: null,
            required: true,
            format: null,
            minLength: null,
            maxLength: null,
            default: "must-not-be-rendered",
          },
        ],
      },
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("secret/password-like field");
    expect(serialized).not.toContain("/mcp-answer");
    expect(serialized).not.toContain("must-not-be-rendered");
    expect(cardActionValues(card).filter((value) => value.action === answerMcpElicitationCardAction)).toEqual([]);
    expect(approvalButtonLabels(card)).toEqual(["Decline", "Cancel"]);
  });

  test("never renders sensitive enum or multi-select options and fails closed", () => {
    const sensitiveFields = [
      {
        name: "auth_choice",
        type: "enum" as const,
        title: "Authentication choice",
        description: null,
        required: false,
        default: "secret-enum-value",
        options: [
          { value: "secret-enum-value", title: "Secret enum title" },
          { value: "other-secret-value", title: "Other secret title" },
        ],
      },
      {
        name: "scope_choice",
        type: "multi_select" as const,
        title: "Scope choice",
        description: null,
        required: false,
        default: ["secret-scope-value"],
        minItems: null,
        maxItems: null,
        options: [
          { value: "secret-scope-value", title: "Secret scope title" },
          { value: "other-scope-value", title: "Other scope title" },
        ],
      },
    ];

    for (const field of sensitiveFields) {
      const input = {
        status: "pending" as const,
        replyCode: "MCP7K2",
        updatedAt: "2026-07-20T13:05:00.000Z",
        request: {
          id: `mcp_secret_${field.type}`,
          serverName: "credential-helper",
          threadId: "thread_1",
          turnId: "turn_1",
          message: "Choose a credential setting.",
          mode: "form" as const,
          fields: [field],
        },
      };
      const card = buildMcpElicitationCard(input);
      const serialized = JSON.stringify(card);

      for (const option of field.options) {
        expect(serialized).not.toContain(option.title);
        expect(serialized).not.toContain(option.value);
      }
      expect(serialized).toContain("secret/password-like field");
      expect(serialized).not.toContain("/mcp-answer");
      expect(approvalButtonLabels(card)).toEqual(["Decline", "Cancel"]);
      expect(
        cardActionValues(card).filter(
          (value) => value.action === answerMcpElicitationCardAction,
        ),
      ).toEqual([]);
      expect(isMcpElicitationCardDecisionAllowed(input, "accept")).toBe(false);
      expect(isMcpElicitationCardSkipAllowed(input, field.name)).toBe(false);
      expect(getMcpElicitationCardOptionValue(input, field.name, 0)).toBeUndefined();
    }
  });

  test("shows only complete HTTP(S) URL elicitations and keeps URLs out of payloads", () => {
    const url = "https://example.com/authorize?client=chat2codex&state=abc";
    const valid = buildMcpElicitationCard({
      status: "pending",
      updatedAt: "2026-07-20T13:05:00.000Z",
      request: {
        id: "mcp_url_1",
        serverName: "oauth-server",
        threadId: "thread_1",
        turnId: "turn_1",
        message: "Authorize this MCP server.",
        mode: "url",
        elicitationId: "elicitation_1",
        url,
      },
    });
    const invalidInputs = [
      { id: "mcp_url_2", url: "ftp://example.com/private" },
      {
        id: "mcp_url_3",
        url: "https://alice:super-secret@example.com/private",
      },
      { id: "mcp_url_4", url: "https://" },
    ].map(({ id, url: invalidUrl }) => ({
      status: "pending" as const,
      updatedAt: "2026-07-20T13:05:00.000Z",
      request: {
        id,
        serverName: "oauth-server",
        threadId: "thread_1",
        turnId: "turn_1",
        message: "Authorize this MCP server.",
        mode: "url" as const,
        elicitationId: `elicitation_${id}`,
        url: invalidUrl,
      },
    }));

    expect(JSON.stringify(valid)).toContain(
      "https://example\\\\.com/authorize?client=chat2codex&state=abc",
    );
    expect(approvalButtonLabels(valid)).toEqual(["Open URL", "Accept", "Decline", "Cancel"]);
    expect(cardActionValues(valid)).toContainEqual({
      app: runCardActionApp,
      action: resolveMcpElicitationCardAction,
      requestId: "mcp_url_1",
      decision: "accept",
    });
    expect(cardActionValues(valid).every((value) => !("url" in value))).toBe(true);

    for (const input of invalidInputs) {
      const invalid = buildMcpElicitationCard(input);
      expect(JSON.stringify(invalid)).not.toContain(input.request.url);
      expect(approvalButtonLabels(invalid)).toEqual(["Decline", "Cancel"]);
      expect(cardActionValues(invalid)).not.toContainEqual(
        expect.objectContaining({ decision: "accept" }),
      );
      expect(isMcpElicitationCardDecisionAllowed(input, "accept")).toBe(false);
    }
  });

  test("bounds unsupported or oversized MCP forms and removes positive actions", () => {
    const fields = Array.from({ length: 13 }, (_, index) => ({
      name: `field_${index}`,
      type: "string" as const,
      title: `Field ${index}`,
      description: null,
      required: false,
      format: null,
      minLength: null,
      maxLength: null,
      default: null,
    }));
    const card = buildMcpElicitationCard({
      status: "pending",
      request: {
        id: "mcp_too_many",
        serverName: "test-server",
        threadId: "thread_1",
        turnId: "turn_1",
        message: "Too many fields.",
        mode: "form",
        fields,
      },
      replyCode: "MCP7K2",
      updatedAt: "2026-07-20T13:05:00.000Z",
    });
    expect(approvalButtonLabels(card)).toEqual(["Decline", "Cancel"]);
    expect(JSON.stringify(card).length).toBeLessThan(5_000);
    expect(cardActionValues(card).every((value) => value.decision !== "accept")).toBe(true);
  });

  test("removes MCP actions in every terminal state and ignores answer-shaped extras", () => {
    for (const status of ["resolved", "declined", "cancelled", "expired"] as const) {
      const input = {
        status,
        updatedAt: "2026-07-20T13:05:00.000Z",
        request: {
          id: "mcp_terminal",
          serverName: "test-server",
          threadId: "thread_1",
          turnId: "turn_1",
          message: "Question",
          mode: "form" as const,
          fields: [
            {
              name: "name",
              type: "string" as const,
              title: "Name",
              description: null,
              required: false,
              format: null,
              minLength: null,
              maxLength: null,
              default: null,
            },
          ],
        },
        answers: { name: "must-not-be-rendered" },
      };
      const card = buildMcpElicitationCard(input);
      expect(cardActionValues(card)).toEqual([]);
      expect(JSON.stringify(card)).not.toContain("must-not-be-rendered");
      expect(JSON.stringify(card)).not.toContain("answer_mcp_elicitation");
      expect(JSON.stringify(card)).not.toContain("resolve_mcp_elicitation");
    }
  });

  test("builds project list cards with compact paths and selection buttons", () => {
    const card = buildProjectListCard({
      currentCwd: "/workspace/chat2codex",
      projects: [
        {
          cwd: "/workspace/chat2codex",
          threadCount: 15,
          updatedAt: "2026-06-30 15:42",
          title: "后续工作计划",
        },
        {
          cwd: "/workspace/scratch/chat2codex-app-server-smoke-KcU7PM",
          threadCount: 1,
          updatedAt: "2026-06-30 14:43",
          title: "Create approval smoke file",
        },
        {
          cwd: "/repo/c",
          threadCount: 1,
        },
        {
          cwd: "/repo/d",
          threadCount: 1,
        },
        {
          cwd: "/repo/e",
          threadCount: 1,
        },
        {
          cwd: "/repo/f",
          threadCount: 1,
        },
      ],
    });

    const serialized = JSON.stringify(card);
    expect(card.header.title.content).toBe("Codex 项目");
    expect(serialized).toContain("进入 1");
    expect(serialized).toContain("select_project");
    expect(serialized).toContain("\"projectIndex\":2");
    expect(serialized).toContain("page_projects");
    expect(serialized).toContain("下一页");
    expect(serialized).not.toContain("进入 6");
    expect(serialized).toContain("scratch/chat2codex\\\\-app\\\\-server\\\\-smoke\\\\-KcU7PM");
  });

  test("builds second project list pages and selected states", () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      cwd: `/repo/${index + 1}`,
      threadCount: 1,
      title: `Project ${index + 1}`,
    }));
    const pageCard = buildProjectListCard({
      currentCwd: "/repo/1",
      projects,
      page: 2,
    });
    const selectedCard = buildProjectListCard({
      currentCwd: "/repo/6",
      projects,
      page: 2,
      selectedProjectIndex: 6,
      status: "selected",
    });

    const pageSerialized = JSON.stringify(pageCard);
    expect(pageSerialized).toContain("6. 6");
    expect(pageSerialized).toContain("进入 6");
    expect(pageSerialized).toContain("\"projectIndex\":6");
    expect(pageSerialized).toContain("上一页");
    expect(pageSerialized).not.toContain("下一页");

    const selectedSerialized = JSON.stringify(selectedCard);
    expect(selectedCard.header.title.content).toBe("Codex 项目已选择");
    expect(selectedCard.header.template).toBe("green");
    expect(selectedSerialized).toContain("已选择项目：/repo/6");
    expect(selectedSerialized).not.toContain("select_project");
    expect(selectedSerialized).not.toContain("page_projects");
  });

  test("builds session list cards with compact ids and resume buttons", () => {
    const card = buildSessionListCard({
      cwd: "/workspace/chat2codex",
      currentThreadId: "019f16f0-35ed-71f2-a187-2ccd2eb75e48",
      sessions: [
        {
          threadId: "019f16f0-35ed-71f2-a187-2ccd2eb75e48",
          title: "后续工作计划",
          updatedAt: "2026-06-30 15:42",
        },
        {
          threadId: "019f16e0-d5cf-7b13-adc0-990067ffe585",
          title: "创建 approval smoke 文件",
          updatedAt: "2026-06-30 13:07",
        },
        {
          threadId: "thread_3",
          title: "Third",
        },
        {
          threadId: "thread_4",
          title: "Fourth",
        },
        {
          threadId: "thread_5",
          title: "Fifth",
        },
        {
          threadId: "thread_6",
          title: "Sixth",
        },
      ],
    });

    const serialized = JSON.stringify(card);
    expect(card.header.title.content).toBe("当前项目会话");
    expect(serialized).toContain("继续 1");
    expect(serialized).toContain("resume_thread");
    expect(serialized).toContain("\"threadIndex\":2");
    expect(serialized).toContain("page_sessions");
    expect(serialized).toContain("下一页");
    expect(serialized).not.toContain("继续 6");
    expect(serialized).toContain("019f16f0\\\\.\\\\.\\\\.5e48");
  });

  test("omits resume buttons for unavailable sessions", () => {
    const card = buildSessionListCard({
      cwd: "/repo/a",
      sessions: [
        {
          threadId: "thread_newer",
          title: "Newer desktop thread",
          resumable: false,
          unavailableReason: "会话由 Codex 0.142.3 创建；当前服务使用 0.136.0",
        },
        {
          threadId: "thread_current",
          title: "Current bridge thread",
        },
      ],
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("不可继续");
    expect(serialized).toContain("0\\\\.142\\\\.3");
    expect(serialized).not.toContain("继续 1");
    expect(serialized).not.toContain("\"threadIndex\":1");
    expect(serialized).toContain("继续 2");
    expect(serialized).toContain("\"threadIndex\":2");
  });

  test("builds second session list pages and selected states", () => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      threadId: `thread_${index + 1}`,
      title: `Session ${index + 1}`,
    }));
    const pageCard = buildSessionListCard({
      cwd: "/repo/a",
      sessions,
      page: 2,
    });
    const selectedCard = buildSessionListCard({
      cwd: "/repo/a",
      currentThreadId: "thread_6",
      sessions,
      page: 2,
      selectedThreadIndex: 6,
      status: "selected",
    });

    const pageSerialized = JSON.stringify(pageCard);
    expect(pageSerialized).toContain("6. Session 6");
    expect(pageSerialized).toContain("继续 6");
    expect(pageSerialized).toContain("\"threadIndex\":6");
    expect(pageSerialized).toContain("上一页");
    expect(pageSerialized).not.toContain("下一页");

    const selectedSerialized = JSON.stringify(selectedCard);
    expect(selectedCard.header.title.content).toBe("Codex 会话已选择");
    expect(selectedCard.header.template).toBe("green");
    expect(selectedSerialized).toContain("已选择会话：Session 6");
    expect(selectedSerialized).not.toContain("resume_thread");
    expect(selectedSerialized).not.toContain("page_sessions");
  });
});

function approvalCardFieldText(card: LarkInteractiveCard): string {
  return card.elements
    .flatMap((element) => {
      if (!Array.isArray(element.fields)) {
        return [];
      }
      return element.fields.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const text = (entry as { text?: unknown }).text;
        if (typeof text !== "object" || text === null) {
          return [];
        }
        const content = (text as { content?: unknown }).content;
        return typeof content === "string" ? [content] : [];
      });
    })
    .join("\n");
}

function approvalButtonLabels(card: LarkInteractiveCard): string[] {
  return card.elements.flatMap((element) => {
    if (element.tag !== "action" || !Array.isArray(element.actions)) {
      return [];
    }
    return element.actions.flatMap((action) => {
      if (typeof action !== "object" || action === null) {
        return [];
      }
      const text = (action as { text?: unknown }).text;
      if (typeof text !== "object" || text === null) {
        return [];
      }
      const content = (text as { content?: unknown }).content;
      return typeof content === "string" ? [content] : [];
    });
  });
}

function cardActionValues(
  card: LarkInteractiveCard,
): Array<Record<string, unknown>> {
  return card.elements.flatMap((element) => {
    if (element.tag !== "action" || !Array.isArray(element.actions)) {
      return [];
    }
    return element.actions.flatMap((action) => {
      if (typeof action !== "object" || action === null) {
        return [];
      }
      const value = (action as { value?: unknown }).value;
      return typeof value === "object" && value !== null
        ? [value as Record<string, unknown>]
        : [];
    });
  });
}
