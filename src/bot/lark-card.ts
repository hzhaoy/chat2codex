import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
} from "../agent/codex-runner.js";
import {
  resolveApprovalCardAction,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardActionValue,
  runCardActionApp,
  resumeThreadCardAction,
  selectProjectCardAction,
  stopRunCardActionValue,
} from "./lark-card-action.js";

export type RunStatusCardStatus = "running" | "success" | "failed" | "stopped";
export type ApprovalCardStatus = "pending" | "resolved" | "cancelled";

export interface RunStatusCardInput {
  status: RunStatusCardStatus;
  detail: string;
  cwd: string;
  prompt: string;
  startedAt: string;
  updatedAt?: string;
}

export interface ApprovalCardInput {
  status: ApprovalCardStatus;
  request: CodexApprovalRequest;
  decision?: CodexApprovalDecision;
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

  if (input.status === "running") {
    elements.push(stopActionElement());
  } else if (input.status === "failed" || input.status === "stopped") {
    elements.push(retryActionElement());
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

export function buildApprovalCard(input: ApprovalCardInput): LarkInteractiveCard {
  const meta = approvalStatusMeta(input.status, input.request);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(approvalDetail(input), 700),
    },
    {
      tag: "div",
      fields: approvalFields(input),
    },
    {
      tag: "hr",
    },
  ];

  if (input.status === "pending") {
    elements.push(approvalActionElement(input.request));
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          input.status === "pending"
            ? "按钮来自 Codex 当前审批请求的 availableDecisions。"
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
          content: `Selected project: ${compactPath(selectedProject.cwd, 90)}`,
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
      text: markdown(`**项目**\n${codeLine(compactPath(input.cwd, 90))}`),
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
          content: `Selected session: ${truncate(selectedSession.title ?? selectedSession.threadId, 120)}`,
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
        content: sessionListNote(input.sessions.length, page, pageSize, status),
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
        content: status === "selected" ? "Codex 会话已选择" : "当前项目会话",
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

function approvalActionElement(request: CodexApprovalRequest): Record<string, unknown> {
  return {
    tag: "action",
    actions: request.decisions.map((decision, index) => ({
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

function approvalFields(input: ApprovalCardInput): Array<Record<string, unknown>> {
  const request = input.request;
  const fields = [
    field("type", request.kind === "command" ? "commandExecution" : "fileChange", 80),
    field("updated", input.updatedAt, 80),
  ];
  if (request.command) {
    fields.push(field("command", formatCommandForDisplay(request.command), 360));
  }
  if (request.cwd) {
    fields.push(field("cwd", request.cwd, 220));
  }
  if (request.grantRoot) {
    fields.push(field("grant_root", request.grantRoot, 220));
  }
  const proposedExecRule = formatExecpolicyAmendment(
    request.proposedExecpolicyAmendment ?? execpolicyAmendmentFromDecisions(request.decisions),
  );
  if (proposedExecRule) {
    fields.push(field("approve_rule", proposedExecRule, 360));
  }
  fields.push(field("options", request.decisions.map(decisionLabel).join(" / "), 220));
  return fields;
}

function execpolicyAmendmentFromDecisions(decisions: CodexApprovalDecision[]): unknown {
  for (const decision of decisions) {
    if (typeof decision === "object" && "acceptWithExecpolicyAmendment" in decision) {
      return decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
    }
  }
  return undefined;
}

function formatExecpolicyAmendment(value: unknown): string | null {
  const command = execpolicyCommandTokens(value);
  if (command?.length) {
    return formatCommandForDisplay(command.map(formatCommandToken).join(" "));
  }
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function formatCommandForDisplay(command: string): string {
  let current = command.trim();
  while (true) {
    const outer = parseShellLcInvocation(current);
    if (!outer) {
      return current;
    }
    const inner = outer.command.trim();
    if (!parseShellLcInvocation(inner)) {
      return current;
    }
    current = inner;
  }
}

function parseShellLcInvocation(command: string): { command: string } | null {
  const match = command.trim().match(/^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-lc\s+([\s\S]+)$/u);
  if (!match?.[1]) {
    return null;
  }
  const inner = parseQuotedShellArgument(match[1].trim());
  return inner === null ? null : { command: inner };
}

function parseQuotedShellArgument(value: string): string | null {
  if (!value) {
    return null;
  }
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") {
    return value;
  }

  let content = "";
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "\"" && char === "\\") {
      const next = value[index + 1];
      if (next && "\"\\$`\n".includes(next)) {
        content += next;
        index += 1;
      } else {
        content += char;
      }
      continue;
    }
    if (char === quote) {
      return value.slice(index + 1).trim() ? null : content;
    }
    content += char;
  }
  return null;
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
    return "Approve rule";
  }
  return "Apply network policy";
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

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1");
}
