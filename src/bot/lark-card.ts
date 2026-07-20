import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "../agent/codex-runner.js";
import {
  answerUserInputCardAction,
  cancelUserInputCardAction,
  resolveApprovalCardAction,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardActionValue,
  runCardActionApp,
  resumeThreadCardAction,
  selectProjectCardAction,
  showRunDetailCardAction,
  stopRunCardActionValue,
  type RunDetailKind,
} from "./lark-card-action.js";

export type RunStatusCardStatus = "running" | "success" | "failed" | "stopped";
export type ApprovalCardStatus = "pending" | "resolved" | "cancelled";
export type UserInputCardStatus = "pending" | "resolved" | "cancelled" | "expired";

export interface RunStatusCardInput {
  status: RunStatusCardStatus;
  detail: string;
  cwd: string;
  prompt: string;
  startedAt: string;
  updatedAt?: string;
  result?: RunResultCardInput;
}

export interface RunResultCardInput {
  threadId?: string;
  durationMs?: number;
  changedFileCount?: number;
  commandCount?: number;
  failedCommandCount?: number;
  diffAvailable?: boolean;
  logsAvailable?: boolean;
  filesPreview?: string[];
  statusNote?: string;
}

export interface ApprovalCardInput {
  status: ApprovalCardStatus;
  request: CodexApprovalRequest;
  decision?: CodexApprovalDecision;
  updatedAt: string;
}

export interface UserInputCardInput {
  status: UserInputCardStatus;
  request: CodexUserInputRequest;
  replyCode: string;
  answers?: CodexUserInputResponse["answers"];
  updatedAt: string;
}

export interface ProjectListCardInput {
  currentCwd: string;
  projects: ProjectCardItem[];
  page?: number;
  pageSize?: number;
  selectedProjectIndex?: number;
  status?: "active" | "selected";
}

export interface ProjectCardItem {
  cwd: string;
  threadCount: number;
  updatedAt?: string;
  title?: string;
  preview?: string;
}

export interface SessionListCardInput {
  cwd: string;
  currentThreadId?: string;
  sessions: SessionCardItem[];
  title?: string;
  contextLabel?: string;
  note?: string;
  page?: number;
  pageSize?: number;
  selectedThreadIndex?: number;
  status?: "active" | "selected";
}

export interface SessionCardItem {
  threadId: string;
  title?: string;
  updatedAt?: string;
  preview?: string;
  resumable?: boolean;
  unavailableReason?: string;
}

type CardTextTag = "plain_text" | "lark_md";

interface CardText {
  tag: CardTextTag;
  content: string;
}

export interface LarkInteractiveCard {
  config: {
    wide_screen_mode: boolean;
    update_multi: boolean;
  };
  header: {
    template: string;
    title: CardText;
  };
  elements: Array<Record<string, unknown>>;
}

export function isApprovalDecisionIndexAllowed(
  request: CodexApprovalRequest,
  decisionIndex: number,
): boolean {
  if (!Number.isInteger(decisionIndex) || decisionIndex < 0) {
    return false;
  }
  const disclosureIssue = approvalDisclosureIssue(request);
  return approvalDecisionEntries(request, disclosureIssue).some(
    ({ index }) => index === decisionIndex,
  );
}

const statusMeta: Record<RunStatusCardStatus, { title: string; template: string }> = {
  running: {
    title: "Codex 正在处理",
    template: "blue",
  },
  success: {
    title: "Codex 已完成",
    template: "green",
  },
  failed: {
    title: "Codex 运行失败",
    template: "red",
  },
  stopped: {
    title: "Codex 已停止",
    template: "grey",
  },
};
const defaultListPageSize = 5;
const maxUserInputOptionButtons = 5;
const maxUserInputOptionsDisplayed = 10;

export function buildRunStatusCard(input: RunStatusCardInput): LarkInteractiveCard {
  const meta = statusMeta[input.status];
  const updatedAt = input.updatedAt ?? input.startedAt;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(input.detail, 600),
    },
    {
      tag: "div",
      fields: [
        field("cwd", input.cwd, 220),
        field("started", input.startedAt, 80),
        field("updated", updatedAt, 80),
        field("prompt", input.prompt, 260),
      ],
    },
    {
      tag: "hr",
    },
  ];

  if (input.result) {
    elements.push(resultSummaryElement(input.result));
  }

  if (input.status === "running") {
    elements.push(stopActionElement());
  } else if (input.status === "failed" || input.status === "stopped") {
    elements.push(retryActionElement());
  }
  if (input.status !== "running" && input.result) {
    elements.push(runDetailActionElement(input.result));
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          input.status === "running"
            ? "可点击停止按钮或发送 /stop；最终回答会作为单独消息发送。"
            : "最终回答或错误摘要会作为单独消息发送。",
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: meta.template,
      title: {
        tag: "plain_text",
        content: meta.title,
      },
    },
    elements,
  };
}

export interface HostHealthCardInput {
  title: string;
  status: "ok" | "warn" | "error";
  host: string;
  platform: string;
  uptime: string;
  queueDepth: number;
  activeRun: string;
  approvalWait: string;
  codexBin: string;
  codexVersion: string;
  defaultCwd: string;
  sandbox: string;
  approvalPolicy: string;
  runTimeout: string;
  approvalTimeout: string;
  access: string;
  statePath: string;
  attachmentDir: string;
  lastEvent?: string;
  lastFailure?: string;
  warnings: string[];
}

export function buildHostHealthCard(input: HostHealthCardInput): LarkInteractiveCard {
  const template = input.status === "ok" ? "green" : input.status === "warn" ? "yellow" : "red";
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(input.title, 500),
    },
    {
      tag: "div",
      fields: [
        field("host", input.host, 120),
        field("platform", input.platform, 120),
        field("uptime", input.uptime, 80),
        field("queue", String(input.queueDepth), 40),
        field("active_run", input.activeRun, 160),
        field("approval_wait", input.approvalWait, 160),
        field("codex", input.codexVersion, 160),
        field("codex_bin", input.codexBin, 180),
        field("default_cwd", input.defaultCwd, 220),
        field("sandbox", input.sandbox, 90),
        field("approval", input.approvalPolicy, 90),
        field("run_timeout", input.runTimeout, 90),
        field("approval_timeout", input.approvalTimeout, 90),
        field("access", input.access, 180),
        field("state", input.statePath, 220),
        field("attachments", input.attachmentDir, 220),
      ],
    },
  ];

  if (input.lastEvent || input.lastFailure || input.warnings.length) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: markdown(
        [
          input.lastEvent ? `**last_event** ${escapeLarkMarkdown(input.lastEvent)}` : null,
          input.lastFailure ? `**last_failure** ${escapeLarkMarkdown(input.lastFailure)}` : null,
          ...input.warnings.map((warning) => `**warning** ${escapeLarkMarkdown(warning)}`),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: "Chat2Codex Host 健康卡",
      },
    },
    elements,
  };
}

export function buildApprovalCard(input: ApprovalCardInput): LarkInteractiveCard {
  const meta = approvalStatusMeta(input.status, input.request);
  const disclosureIssue = approvalDisclosureIssue(input.request);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(approvalDetail(input), 700),
    },
    {
      tag: "div",
      fields: approvalFields(input, disclosureIssue),
    },
    {
      tag: "hr",
    },
  ];

  if (
    input.status === "pending" &&
    approvalDecisionEntries(input.request, disclosureIssue).length > 0
  ) {
    elements.push(approvalActionElement(input.request, disclosureIssue));
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          input.status === "pending"
            ? disclosureIssue
              ? `审批详情无法完整安全展示（${disclosureIssue}）；仅保留拒绝/取消操作。`
              : "按钮来自 Codex 当前审批请求的 availableDecisions。"
            : "这条 Codex 审批请求已处理。",
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: meta.template,
      title: {
        tag: "plain_text",
        content: meta.title,
      },
    },
    elements,
  };
}

export function buildUserInputCard(input: UserInputCardInput): LarkInteractiveCard {
  const meta = userInputStatusMeta[input.status];
  const question = firstUnansweredUserInputQuestion(input);
  const secretQuestionBlocked = input.status === "pending" && Boolean(question?.isSecret);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(userInputDetail(input.status, Boolean(question), secretQuestionBlocked), 500),
    },
    {
      tag: "div",
      fields: [
        field("updated", input.updatedAt, 80),
        field("reply_code", input.replyCode, 40),
        field("progress", userInputProgress(input), 80),
      ],
    },
  ];

  if (input.status === "pending" && question && !secretQuestionBlocked) {
    elements.push(
      { tag: "hr" },
      {
        tag: "div",
        text: markdown(
          [
            `**${escapeLarkMarkdown(truncate(question.header, 80))}**`,
            escapeLarkMarkdown(truncate(question.question, 500)),
          ].join("\n"),
        ),
      },
    );

    const displayedOptions = (question.options ?? []).slice(0, maxUserInputOptionsDisplayed);
    const buttonOptions = displayedOptions.slice(0, maxUserInputOptionButtons);
    for (const [index, option] of displayedOptions.entries()) {
      elements.push({
        tag: "div",
        text: markdown(
          [
            `**${index + 1}. ${escapeLarkMarkdown(truncate(option.label, 80))}**`,
            escapeLarkMarkdown(truncate(option.description, 180)),
          ].join("\n"),
        ),
      });
    }
    if (buttonOptions.length > 0) {
      elements.push(userInputOptionActions(input.request.id, question.id, buttonOptions));
    }

    if (
      displayedOptions.length === 0 ||
      question.isOther ||
      (question.options?.length ?? 0) > buttonOptions.length
    ) {
      elements.push({
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: truncate(
              `可发送 /answer ${truncate(input.replyCode, 40)} <内容> 回答当前问题。`,
              160,
            ),
          },
        ],
      });
    }

    elements.push(userInputControlActions(input.request.id, question.id));
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          input.status === "pending" && question
            ? "选项会在服务端按原始 requestUserInput 请求重新校验。"
            : "这条 Codex 用户输入请求已结束。",
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: meta.template,
      title: {
        tag: "plain_text",
        content: meta.title,
      },
    },
    elements,
  };
}

export function buildProjectListCard(input: ProjectListCardInput): LarkInteractiveCard {
  const pageSize = positiveInteger(input.pageSize) ?? defaultListPageSize;
  const page = normalizePage(input.page, input.projects.length, pageSize);
  const start = (page - 1) * pageSize;
  const visibleProjects = input.projects.slice(start, start + pageSize);
  const status = input.status ?? "active";
  const selectedProject = selectedItem(input.projects, input.selectedProjectIndex);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: markdown(`**当前项目**\n${codeLine(compactPath(input.currentCwd, 90))}`),
    },
    {
      tag: "hr",
    },
    ...visibleProjects.flatMap((project, index) =>
      projectSummaryElements(project, start + index, start + index + 1 === input.selectedProjectIndex),
    ),
  ];

  if (status === "selected" && selectedProject) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `已选择项目：${compactPath(selectedProject.cwd, 90)}`,
        },
      ],
    });
  } else if (visibleProjects.length) {
    elements.push({
      tag: "action",
      actions: visibleProjects.map((project, index) => {
        const projectIndex = start + index + 1;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `进入 ${projectIndex}`,
          },
          type: project.cwd === input.currentCwd ? "primary" : "default",
          value: {
            app: runCardActionApp,
            action: selectProjectCardAction,
            projectIndex,
            page,
          },
        };
      }),
    });
  }

  if (status !== "selected") {
    const pagination = paginationActions("projects", page, input.projects.length, pageSize);
    if (pagination.length) {
      elements.push({
        tag: "action",
        actions: pagination,
      });
    }
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: projectListNote(input.projects.length, page, pageSize, status),
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: status === "selected" ? "green" : "blue",
      title: {
        tag: "plain_text",
        content: status === "selected" ? "Codex 项目已选择" : "Codex 项目",
      },
    },
    elements,
  };
}

export function buildSessionListCard(input: SessionListCardInput): LarkInteractiveCard {
  const pageSize = positiveInteger(input.pageSize) ?? defaultListPageSize;
  const page = normalizePage(input.page, input.sessions.length, pageSize);
  const start = (page - 1) * pageSize;
  const visibleSessions = input.sessions.slice(start, start + pageSize);
  const status = input.status ?? "active";
  const selectedSession = selectedItem(input.sessions, input.selectedThreadIndex);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: markdown(`**${escapeLarkMarkdown(input.contextLabel ?? "项目")}**\n${codeLine(compactPath(input.cwd, 90))}`),
    },
    {
      tag: "hr",
    },
    ...visibleSessions.flatMap((session, index) =>
      sessionSummaryElements(
        session,
        start + index,
        session.threadId === input.currentThreadId,
        start + index + 1 === input.selectedThreadIndex,
      ),
    ),
  ];

  if (status === "selected" && selectedSession) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `已选择会话：${truncate(selectedSession.title ?? selectedSession.threadId, 120)}`,
        },
      ],
    });
  } else if (visibleSessions.length) {
    const actions = visibleSessions.flatMap((session, index) => {
      if (session.resumable === false) {
        return [];
      }
      const threadIndex = start + index + 1;
      return [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `继续 ${threadIndex}`,
          },
          type: session.threadId === input.currentThreadId ? "primary" : "default",
          value: {
            app: runCardActionApp,
            action: resumeThreadCardAction,
            threadIndex,
            page,
          },
        },
      ];
    });
    if (actions.length) {
      elements.push({
        tag: "action",
        actions,
      });
    }
  }

  if (status !== "selected") {
    const pagination = paginationActions("sessions", page, input.sessions.length, pageSize);
    if (pagination.length) {
      elements.push({
        tag: "action",
        actions: pagination,
      });
    }
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: input.note ?? sessionListNote(input.sessions.length, page, pageSize, status),
      },
    ],
  });

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: status === "selected" ? "green" : "blue",
      title: {
        tag: "plain_text",
        content: status === "selected" ? "Codex 会话已选择" : input.title ?? "当前项目会话",
      },
    },
    elements,
  };
}

function stopActionElement(): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: {
          tag: "plain_text",
          content: "停止",
        },
        type: "danger",
        value: stopRunCardActionValue,
        confirm: {
          title: {
            tag: "plain_text",
            content: "停止当前任务？",
          },
          text: {
            tag: "plain_text",
            content: "这会中止当前 chat 正在运行的 Codex 任务。",
          },
        },
      },
    ],
  };
}

function retryActionElement(): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: {
          tag: "plain_text",
          content: "重试",
        },
        type: "primary",
        value: retryRunCardActionValue,
        confirm: {
          title: {
            tag: "plain_text",
            content: "重试这次任务？",
          },
          text: {
            tag: "plain_text",
            content: "这会把同一条 prompt 重新加入当前 chat 的 Codex 队列。",
          },
        },
      },
    ],
  };
}

function resultSummaryElement(result: RunResultCardInput): Record<string, unknown> {
  const lines = [
    result.threadId ? `thread: ${shortThreadId(result.threadId)}` : null,
    result.durationMs !== undefined ? `duration: ${formatDuration(result.durationMs)}` : null,
    `files: ${result.changedFileCount ?? 0}`,
    `commands: ${result.commandCount ?? 0}`,
    result.failedCommandCount ? `failed_commands: ${result.failedCommandCount}` : null,
    result.diffAvailable ? "diff: available" : null,
    result.statusNote ? `note: ${result.statusNote}` : null,
    result.filesPreview?.length ? `changed: ${result.filesPreview.map((file) => `\`${compactPath(file, 48)}\``).join(", ")}` : null,
  ].filter(Boolean);
  return {
    tag: "div",
    text: markdown(["**本轮结果**", ...lines.map((line) => String(line))].join("\n")),
  };
}

function runDetailActionElement(result: RunResultCardInput): Record<string, unknown> {
  const detailActions: Array<{ kind: RunDetailKind; label: string; disabled?: boolean }> = [
    { kind: "summary", label: "摘要" },
    { kind: "files", label: "文件", disabled: !result.changedFileCount },
    { kind: "diff", label: "Diff", disabled: !result.diffAvailable },
    { kind: "logs", label: "日志", disabled: !result.logsAvailable },
  ];
  return {
    tag: "action",
    actions: detailActions
      .filter((action) => !action.disabled)
      .map((action) => ({
        tag: "button",
        text: {
          tag: "plain_text",
          content: action.label,
        },
        value: {
          app: runCardActionApp,
          action: showRunDetailCardAction,
          detailKind: action.kind,
        },
      })),
  };
}

function approvalActionElement(
  request: CodexApprovalRequest,
  disclosureIssue: string | null,
): Record<string, unknown> {
  return {
    tag: "action",
    actions: approvalDecisionEntries(request, disclosureIssue).map(({ decision, index }) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: decisionLabel(decision),
      },
      type: decisionButtonType(decision),
      value: {
        app: runCardActionApp,
        action: resolveApprovalCardAction,
        approvalId: request.id,
        decisionIndex: index,
      },
      confirm: {
        title: {
          tag: "plain_text",
          content: "处理 Codex 审批？",
        },
        text: {
          tag: "plain_text",
          content: `将选择 ${decisionLabel(decision)}。`,
        },
      },
    })),
  };
}

function userInputOptionActions(
  userInputId: string,
  questionId: string,
  options: Array<{ label: string }>,
): Record<string, unknown> {
  return {
    tag: "action",
    actions: options.map((option, optionIndex) => ({
      tag: "button",
      text: plain(option.label, 48),
      type: "primary",
      value: {
        app: runCardActionApp,
        action: answerUserInputCardAction,
        userInputId,
        questionId,
        optionIndex,
      },
    })),
  };
}

function userInputControlActions(userInputId: string, questionId: string): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: plain("跳过", 48),
        type: "default",
        value: {
          app: runCardActionApp,
          action: answerUserInputCardAction,
          userInputId,
          questionId,
        },
      },
      {
        tag: "button",
        text: plain("取消", 48),
        type: "danger",
        value: {
          app: runCardActionApp,
          action: cancelUserInputCardAction,
          userInputId,
        },
      },
    ],
  };
}

function projectSummaryElements(
  project: ProjectCardItem,
  index: number,
  isSelected: boolean,
): Array<Record<string, unknown>> {
  const title = pathLabel(project.cwd);
  const meta = [
    `${project.threadCount} 个会话`,
    project.updatedAt ? `最近 ${project.updatedAt}` : null,
    isSelected ? "已选择" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = project.title ?? project.preview;
  const lines = [
    `**${index + 1}. ${escapeLarkMarkdown(title)}**`,
    codeLine(compactPath(project.cwd, 90)),
    meta ? escapeLarkMarkdown(meta) : null,
    latest ? `最新：${escapeLarkMarkdown(truncate(latest, 80))}` : null,
  ].filter(Boolean);

  return [
    {
      tag: "div",
      text: markdown(lines.join("\n")),
    },
  ];
}

function sessionSummaryElements(
  session: SessionCardItem,
  index: number,
  isCurrent: boolean,
  isSelected: boolean,
): Array<Record<string, unknown>> {
  const title = session.title ?? session.preview ?? session.threadId;
  const meta = [
    session.updatedAt ? `最近 ${session.updatedAt}` : null,
    `id ${shortThreadId(session.threadId)}`,
    session.resumable === false ? "不可继续" : null,
    isSelected ? "已选择" : isCurrent ? "当前" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `**${index + 1}. ${escapeLarkMarkdown(truncate(title, 86))}**`,
    escapeLarkMarkdown(meta),
    session.preview && session.preview !== title
      ? `预览：${escapeLarkMarkdown(truncate(session.preview, 120))}`
      : null,
    session.resumable === false && session.unavailableReason
      ? `原因：${escapeLarkMarkdown(truncate(session.unavailableReason, 120))}`
      : null,
  ].filter(Boolean);
  return [
    {
      tag: "div",
      text: markdown(lines.join("\n")),
    },
  ];
}

function normalizePage(value: number | undefined, totalItems: number, pageSize: number): number {
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const requested = positiveInteger(value) ?? 1;
  return Math.min(Math.max(requested, 1), pageCount);
}

function positiveInteger(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function selectedItem<T>(items: T[], index: number | undefined): T | undefined {
  const selectedIndex = positiveInteger(index);
  return selectedIndex ? items[selectedIndex - 1] : undefined;
}

function paginationActions(
  kind: "projects" | "sessions",
  page: number,
  totalItems: number,
  pageSize: number,
): Array<Record<string, unknown>> {
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  if (pageCount <= 1) {
    return [];
  }

  const action = kind === "projects" ? pageProjectsCardAction : pageSessionsCardAction;
  const actions: Array<Record<string, unknown>> = [];
  if (page > 1) {
    actions.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: "上一页",
      },
      value: {
        app: runCardActionApp,
        action,
        page: page - 1,
      },
    });
  }
  if (page < pageCount) {
    actions.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: "下一页",
      },
      value: {
        app: runCardActionApp,
        action,
        page: page + 1,
      },
    });
  }
  return actions;
}

function projectListNote(
  totalItems: number,
  page: number,
  pageSize: number,
  status: "active" | "selected",
): string {
  if (status === "selected") {
    return "发送 /sessions 查看会话，或 /new 新建对话。";
  }
  const range = itemRange(totalItems, page, pageSize);
  return [
    `显示第 ${range.start}-${range.end} 个，共 ${totalItems} 个项目。`,
    "也可以发送 /project <编号> 进入项目，进入后发送 /sessions 查看会话。",
  ].join(" ");
}

function sessionListNote(
  totalItems: number,
  page: number,
  pageSize: number,
  status: "active" | "selected",
): string {
  if (status === "selected") {
    return "下一条消息会继续这个会话；发送 /new 可在当前项目新建会话。";
  }
  const range = itemRange(totalItems, page, pageSize);
  return [
    `显示第 ${range.start}-${range.end} 个，共 ${totalItems} 个会话。`,
    "也可以发送 /resume <编号> 继续会话，或发送 /new 新建会话。",
  ].join(" ");
}

function itemRange(totalItems: number, page: number, pageSize: number): { start: number; end: number } {
  if (totalItems <= 0) {
    return { start: 0, end: 0 };
  }
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalItems, start + pageSize - 1);
  return { start, end };
}

function pathLabel(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  const label = normalized.split("/").filter(Boolean).at(-1);
  return label || normalized || value;
}

function compactPath(value: string, maxLength: number): string {
  const normalized = value.replace(/\/+$/u, "") || value;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return truncate(normalized, maxLength);
  }
  const tail = parts.slice(-2).join("/");
  const prefix = normalized.startsWith("/") ? "/" : "";
  return truncate(`${prefix}.../${tail}`, maxLength);
}

function shortThreadId(value: string): string {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function codeLine(value: string): string {
  return `\`${escapeLarkMarkdown(value)}\``;
}

function approvalStatusMeta(
  status: ApprovalCardStatus,
  request: CodexApprovalRequest,
): { title: string; template: string } {
  if (status === "cancelled") {
    return {
      title: "Codex 审批已取消",
      template: "grey",
    };
  }
  if (status === "resolved") {
    return {
      title: "Codex 审批已处理",
      template: "green",
    };
  }
  return {
    title: request.kind === "command" ? "Codex 请求执行命令" : "Codex 请求修改文件",
    template: "orange",
  };
}

const userInputStatusMeta: Record<UserInputCardStatus, { title: string; template: string }> = {
  pending: {
    title: "Codex 需要你的回答",
    template: "orange",
  },
  resolved: {
    title: "Codex 已收到回答",
    template: "green",
  },
  cancelled: {
    title: "Codex 提问已取消",
    template: "grey",
  },
  expired: {
    title: "Codex 提问已过期",
    template: "grey",
  },
};

function firstUnansweredUserInputQuestion(input: UserInputCardInput) {
  const answers = input.answers ?? {};
  return input.request.questions.find((question) => !Object.hasOwn(answers, question.id));
}

function userInputProgress(input: UserInputCardInput): string {
  const answered = input.request.questions.filter((question) =>
    Object.hasOwn(input.answers ?? {}, question.id),
  ).length;
  return `${answered}/${input.request.questions.length}`;
}

function userInputDetail(
  status: UserInputCardStatus,
  hasPendingQuestion: boolean,
  secretQuestionBlocked = false,
): string {
  if (status === "resolved") {
    return "回答已提交给 Codex；为避免泄露，卡片不会回显回答内容。";
  }
  if (status === "cancelled") {
    return "这条用户输入请求已取消。";
  }
  if (status === "expired") {
    return "这条用户输入请求已过期，迟到的回答不会提交给 Codex。";
  }
  if (secretQuestionBlocked) {
    return "这个问题要求敏感输入；聊天消息无法提供不留痕的安全输入通道，因此不会收集或提交回答。";
  }
  return hasPendingQuestion
    ? "Codex 暂停当前任务，正在等待你回答下面的问题。"
    : "所有问题均已回答，正在提交给 Codex。";
}

function approvalDetail(input: ApprovalCardInput): string {
  const { request } = input;
  if (input.status === "resolved" && input.decision) {
    return `已选择：${decisionLabel(input.decision)}。`;
  }
  if (input.status === "cancelled") {
    return "这条审批请求已随 Codex 任务取消。";
  }
  if (request.kind === "command") {
    return request.reason
      ? `Codex 需要审批后执行命令：${request.reason}`
      : "Codex 需要审批后执行命令。";
  }
  return request.reason ? `Codex 需要审批后修改文件：${request.reason}` : "Codex 需要审批后修改文件。";
}

function approvalFields(
  input: ApprovalCardInput,
  disclosureIssue: string | null,
): Array<Record<string, unknown>> {
  const request = input.request;
  const fields = [
    field("type", request.kind === "command" ? "commandExecution" : "fileChange", 80),
    field("updated", input.updatedAt, 80),
  ];
  if (request.command) {
    fields.push(approvalField("command", request.command, 360));
  }
  if (request.cwd) {
    fields.push(approvalField("cwd", request.cwd, 220));
  }
  if (request.grantRoot) {
    fields.push(approvalField("grant_root", request.grantRoot, 220));
  }
  if (request.additionalPermissions !== undefined && request.additionalPermissions !== null) {
    fields.push(
      approvalField(
        "additional_permissions",
        stableStructuredSummary(request.additionalPermissions),
        500,
      ),
    );
  }
  if (request.networkApprovalContext !== undefined && request.networkApprovalContext !== null) {
    fields.push(
      approvalField(
        "network_approval_context",
        stableStructuredSummary(request.networkApprovalContext),
        360,
      ),
    );
  }
  if (
    request.proposedNetworkPolicyAmendments !== undefined &&
    request.proposedNetworkPolicyAmendments !== null
  ) {
    fields.push(
      approvalField(
        "proposed_network_policy_amendments",
        stableStructuredSummary(request.proposedNetworkPolicyAmendments),
        500,
      ),
    );
  }
  const proposedExecRule = formatExecpolicyAmendment(request.proposedExecpolicyAmendment);
  if (proposedExecRule) {
    fields.push(approvalField("proposed_exec_policy_amendment", proposedExecRule, 360));
  }
  const execPolicyDecisions = request.decisions.flatMap((decision, index) => {
    const amendment = execpolicyAmendmentFromDecision(decision);
    const formatted = amendment ? formatExecpolicyAmendment(amendment) : null;
    return formatted ? [`${index + 1}: ${formatted}`] : [];
  });
  if (execPolicyDecisions.length) {
    fields.push(approvalField("exec_policy_decisions", execPolicyDecisions.join(" / "), 500));
  }
  const networkPolicyDecisions = request.decisions.flatMap((decision, index) => {
    const amendment = networkPolicyAmendmentFromDecision(decision);
    return amendment ? [`${index + 1}: ${formatNetworkPolicyAmendment(amendment)}`] : [];
  });
  if (networkPolicyDecisions.length) {
    fields.push(approvalField("network_policy_decisions", networkPolicyDecisions.join(" / "), 500));
  }
  if (disclosureIssue) {
    fields.push(
      field(
        "approval_guard",
        `Approval actions disabled because ${disclosureIssue}; only deny/cancel remain available.`,
        360,
      ),
    );
  }
  fields.push(
    approvalField(
      "options",
      approvalDecisionEntries(request, disclosureIssue)
        .map(({ decision }) => decisionLabel(decision))
        .join(" / ") || "No safe decision is available",
      360,
    ),
  );
  return fields;
}

function approvalDecisionEntries(
  request: CodexApprovalRequest,
  disclosureIssue: string | null,
): Array<{ decision: CodexApprovalDecision; index: number }> {
  const entries = request.decisions.map((decision, index) => ({ decision, index }));
  if (!disclosureIssue) {
    return entries;
  }
  return entries.filter(
    ({ decision }) => decision === "decline" || decision === "cancel",
  );
}

function approvalDisclosureIssue(request: CodexApprovalRequest): string | null {
  if (request.kind === "file_change") {
    return "file-change targets and patch details are unavailable";
  }
  if (request.kind === "command") {
    if (!request.command?.trim()) {
      return "the command is missing";
    }
    if (request.command.length > 360) {
      return "the command exceeds the display limit";
    }
  }
  if (request.cwd && request.cwd.length > 220) {
    return "the working directory exceeds the display limit";
  }
  if (request.grantRoot && request.grantRoot.length > 220) {
    return "the grant root exceeds the display limit";
  }

  const structuredDetails: Array<[string, unknown, number]> = [
    ["additional permissions", request.additionalPermissions, 500],
    ["network approval context", request.networkApprovalContext, 360],
    ["proposed network policy amendments", request.proposedNetworkPolicyAmendments, 500],
  ];
  for (const [label, value, maxLength] of structuredDetails) {
    if (value === undefined || value === null) {
      continue;
    }
    const summary = structuredSummary(value);
    if (!summary.complete) {
      return `${label} cannot be rendered completely`;
    }
    if (summary.text.length > maxLength) {
      return `${label} exceeds the display limit`;
    }
  }

  const proposedExecRule = formatExecpolicyAmendment(request.proposedExecpolicyAmendment);
  if (proposedExecRule && proposedExecRule.length > 360) {
    return "the exec policy amendment exceeds the display limit";
  }

  const execPolicyDecisions = request.decisions.flatMap((decision, index) => {
    const amendment = execpolicyAmendmentFromDecision(decision);
    const formatted = amendment ? formatExecpolicyAmendment(amendment) : null;
    return formatted ? [`${index + 1}: ${formatted}`] : [];
  });
  if (execPolicyDecisions.join(" / ").length > 500) {
    return "exec policy decisions exceed the display limit";
  }

  const networkPolicyDecisions = request.decisions.flatMap((decision, index) => {
    const amendment = networkPolicyAmendmentFromDecision(decision);
    return amendment ? [`${index + 1}: ${formatNetworkPolicyAmendment(amendment)}`] : [];
  });
  if (networkPolicyDecisions.join(" / ").length > 500) {
    return "network policy decisions exceed the display limit";
  }

  const labels = request.decisions.map(decisionLabel);
  if (labels.some((label) => label.length > 80) || labels.join(" / ").length > 360) {
    return "approval options exceed the display limit";
  }
  return null;
}

function execpolicyAmendmentFromDecision(decision: CodexApprovalDecision): string[] | null {
  return typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision
    ? decision.acceptWithExecpolicyAmendment.execpolicy_amendment
    : null;
}

function formatExecpolicyAmendment(value: unknown): string | null {
  const command = execpolicyCommandTokens(value);
  if (command?.length) {
    return command.map(formatCommandToken).join(" ");
  }
  if (value === undefined || value === null) {
    return null;
  }
  return stableStructuredSummary(value);
}

function execpolicyCommandTokens(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((token) => typeof token === "string")) {
    return value;
  }
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  if (Array.isArray(record.command) && record.command.every((token) => typeof token === "string")) {
    return record.command;
  }
  return execpolicyCommandTokens(record.execpolicy_amendment);
}

function formatCommandToken(token: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token) ? token : JSON.stringify(token);
}

function decisionLabel(decision: CodexApprovalDecision): string {
  if (decision === "accept") {
    return "Approve";
  }
  if (decision === "acceptForSession") {
    return "Approve session";
  }
  if (decision === "decline") {
    return "Deny";
  }
  if (decision === "cancel") {
    return "Cancel turn";
  }
  if ("acceptWithExecpolicyAmendment" in decision) {
    return `Exec rule: ${formatExecpolicyAmendment(
      decision.acceptWithExecpolicyAmendment.execpolicy_amendment,
    )}`;
  }
  return formatNetworkPolicyAmendment(
    decision.applyNetworkPolicyAmendment.network_policy_amendment,
  );
}

function networkPolicyAmendmentFromDecision(
  decision: CodexApprovalDecision,
): { action: "allow" | "deny"; host: string } | null {
  return typeof decision === "object" && "applyNetworkPolicyAmendment" in decision
    ? decision.applyNetworkPolicyAmendment.network_policy_amendment
    : null;
}

function formatNetworkPolicyAmendment(amendment: {
  action: "allow" | "deny";
  host: string;
}): string {
  return `Network ${amendment.action}: ${amendment.host}`;
}

function stableStructuredSummary(value: unknown): string {
  return structuredSummary(value).text;
}

function structuredSummary(value: unknown): { text: string; complete: boolean } {
  const seen = new Set<object>();
  const state = { complete: true, entries: 100 };
  try {
    const text = JSON.stringify(normalizeStructuredValue(value, seen, state, 0));
    return typeof text === "string"
      ? { text, complete: state.complete }
      : { text: '"[unrenderable value]"', complete: false };
  } catch {
    return { text: '"[unrenderable value]"', complete: false };
  }
}

function normalizeStructuredValue(
  value: unknown,
  seen: Set<object>,
  state: { complete: boolean; entries: number },
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 240) {
      state.complete = false;
      return `${value.slice(0, 237)}...`;
    }
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    state.complete = false;
    return "[non-finite number]";
  }
  if (typeof value === "bigint") {
    state.complete = false;
    return `[bigint ${value.toString()}]`;
  }
  if (typeof value === "undefined") {
    state.complete = false;
    return "[undefined]";
  }
  if (typeof value === "function") {
    state.complete = false;
    return "[unsupported function]";
  }
  if (typeof value === "symbol") {
    state.complete = false;
    return "[unsupported symbol]";
  }
  if (depth >= 8) {
    state.complete = false;
    return "[maximum depth reached]";
  }
  if (seen.has(value)) {
    state.complete = false;
    return "[circular reference]";
  }
  if (state.entries <= 0) {
    state.complete = false;
    return "[entry limit reached]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: unknown[] = [];
      for (const item of value) {
        if (state.entries <= 0) {
          state.complete = false;
          normalized.push("[entry limit reached]");
          break;
        }
        state.entries -= 1;
        normalized.push(normalizeStructuredValue(item, seen, state, depth + 1));
      }
      return normalized;
    }

    const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const key of keys) {
      if (state.entries <= 0) {
        state.complete = false;
        normalized["[truncated]"] = "[entry limit reached]";
        break;
      }
      state.entries -= 1;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const renderedKey = key.length > 120 ? `${key.slice(0, 117)}...` : key;
      if (renderedKey !== key || !descriptor || !("value" in descriptor)) {
        state.complete = false;
      }
      normalized[renderedKey] =
        descriptor && "value" in descriptor
          ? normalizeStructuredValue(descriptor.value, seen, state, depth + 1)
          : "[accessor omitted]";
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function decisionButtonType(decision: CodexApprovalDecision): string {
  if (decision === "accept") {
    return "primary";
  }
  if (decision === "decline" || decision === "cancel") {
    return "danger";
  }
  return "default";
}

function field(label: string, value: string, maxLength: number): Record<string, unknown> {
  return {
    is_short: false,
    text: markdown(`**${label}**\n${escapeLarkMarkdown(truncate(value, maxLength))}`),
  };
}

function approvalField(label: string, value: string, maxLength: number): Record<string, unknown> {
  const visibleValue =
    value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  return {
    is_short: false,
    text: markdown(`**${label}**\n${escapeLarkMarkdown(visibleValue)}`),
  };
}

function plain(content: string, maxLength: number): CardText {
  return {
    tag: "plain_text",
    content: truncate(content, maxLength),
  };
}

function markdown(content: string): CardText {
  return {
    tag: "lark_md",
    content,
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1");
}
