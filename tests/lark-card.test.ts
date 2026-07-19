import { describe, expect, test } from "bun:test";

import {
  buildApprovalCard,
  buildHostHealthCard,
  buildProjectListCard,
  buildRunStatusCard,
  buildSessionListCard,
} from "../src/bot/lark-card.js";
import {
  retryRunCardActionValue,
  runCardActionApp,
  stopRunCardActionValue,
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
    expect(serialized).toContain("可点击停止按钮或发送 /stop");
    expect(serialized).toContain("停止");
    expect(serialized).toContain(JSON.stringify(stopRunCardActionValue));
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

function approvalCardFieldText(card: ReturnType<typeof buildApprovalCard>): string {
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

function approvalButtonLabels(card: ReturnType<typeof buildApprovalCard>): string[] {
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
