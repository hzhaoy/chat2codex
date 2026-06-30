import { describe, expect, test } from "bun:test";

import {
  buildApprovalCard,
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
    expect(serialized).toContain("approve_rule");
    expect(serialized).toContain("rm \\\\-rf");
    expect(serialized).toContain("Approve");
    expect(serialized).toContain("Approve rule");
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

  test("collapses nested shell wrappers in approval command display", () => {
    const innerCommand = String.raw`/bin/zsh -lc "printf '%s\\n' 'hello approval' > codex-approval-smoke.txt"`;
    const nestedCommand = String.raw`/bin/zsh -lc "/bin/zsh -lc \"printf '%s\\n' 'hello approval' > codex-approval-smoke.txt\""`;
    const card = buildApprovalCard({
      status: "pending",
      updatedAt: "2026-06-29T12:00:30.000Z",
      request: {
        id: "approval_1",
        kind: "command",
        command: nestedCommand,
        cwd: "/tmp/chat2codex",
        proposedExecpolicyAmendment: ["/bin/zsh", "-lc", innerCommand],
        decisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["/bin/zsh", "-lc", innerCommand],
            },
          },
          "cancel",
        ],
      },
    });

    const serialized = JSON.stringify(card);
    expect(serialized.match(/\/bin\/zsh/gu)).toHaveLength(2);
    expect(serialized).toContain("approve_rule");
    expect(serialized).toContain("printf");
    expect(serialized).toContain("hello approval");
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
    expect(selectedSerialized).toContain("Selected project: /repo/6");
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
    expect(selectedSerialized).toContain("Selected session: Session 6");
    expect(selectedSerialized).not.toContain("resume_thread");
    expect(selectedSerialized).not.toContain("page_sessions");
  });
});
