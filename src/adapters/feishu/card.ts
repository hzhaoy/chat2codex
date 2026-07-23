import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexMcpElicitationField,
  CodexMcpElicitationRequest,
  CodexPermissionApprovalDecision,
  CodexPermissionApprovalRequest,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "../../agent/codex-runner.js";
import type {
  ApprovalCardInput,
  ApprovalCardStatus,
  HostHealthCardInput,
  McpElicitationCardInput,
  McpElicitationCardRequest,
  McpElicitationCardStatus,
  PermissionApprovalCardInput,
  PermissionApprovalCardRequest,
  PermissionApprovalCardStatus,
  ProjectCardItem,
  ProjectListCardInput,
  RunResultCardInput,
  RunStatusCardInput,
  RunStatusCardStatus,
  SessionCardItem,
  SessionListCardInput,
  UserInputCardInput,
  UserInputCardStatus,
} from "../../core/view-models.js";
export type {
  ApprovalCardInput,
  ApprovalCardStatus,
  HostHealthCardInput,
  McpElicitationCardInput,
  McpElicitationCardRequest,
  McpElicitationCardStatus,
  PermissionApprovalCardInput,
  PermissionApprovalCardRequest,
  PermissionApprovalCardStatus,
  ProjectCardItem,
  ProjectListCardInput,
  RunResultCardInput,
  RunStatusCardInput,
  RunStatusCardStatus,
  SessionCardItem,
  SessionListCardInput,
  UserInputCardInput,
  UserInputCardStatus,
} from "../../core/view-models.js";
import {
  answerMcpElicitationCardAction,
  answerUserInputCardAction,
  cancelUserInputCardAction,
  resolveMcpElicitationCardAction,
  resolvePermissionApprovalCardAction,
  resolveApprovalCardAction,
  pageProjectsCardAction,
  pageSessionsCardAction,
  retryRunCardActionValue,
  runCardActionApp,
  resumeThreadCardAction,
  selectProjectCardAction,
  showRunDetailCardAction,
  type McpElicitationCardDecision,
  type PermissionApprovalCardDecision,
  type RunDetailKind,
} from "./action.js";

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

export function isPermissionApprovalCardDecisionAllowed(
  request: PermissionApprovalCardRequest,
  decision: PermissionApprovalCardDecision,
): boolean {
  if (decision === "deny") {
    return true;
  }
  const profile = permissionProfileView(request.permissions);
  return permissionDisclosureIssue(request, profile) === null;
}

export function getMcpElicitationCardOptionValue(
  input: McpElicitationCardInput,
  fieldId: string,
  optionIndex: number,
): string | boolean | undefined {
  if (
    input.status !== "pending" ||
    input.request.mode !== "form" ||
    mcpContextDisclosureIssue(input.request) ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= maxMcpOptionButtons
  ) {
    return undefined;
  }
  const form = parseNormalizedMcpFields(input.request.fields);
  if (form.issue || mcpFormDisplayIssue(form)) {
    return undefined;
  }
  const answered = new Set(input.answeredFieldIds ?? []);
  const current = form.fields.find((fieldView) => !answered.has(fieldView.id));
  if (!current || current.id !== fieldId || current.sensitive || current.multiple) {
    return undefined;
  }
  if (current.type === "boolean") {
    return optionIndex === 0 ? true : optionIndex === 1 ? false : undefined;
  }
  return current.options.length <= maxMcpOptionButtons
    ? current.options[optionIndex]?.value
    : undefined;
}

export function isMcpElicitationCardSkipAllowed(
  input: McpElicitationCardInput,
  fieldId: string,
): boolean {
  if (
    input.status !== "pending" ||
    input.request.mode !== "form" ||
    mcpContextDisclosureIssue(input.request)
  ) {
    return false;
  }
  const form = parseNormalizedMcpFields(input.request.fields);
  if (form.issue || mcpFormDisplayIssue(form)) {
    return false;
  }
  const answered = new Set(input.answeredFieldIds ?? []);
  const current = form.fields.find((fieldView) => !answered.has(fieldView.id));
  return Boolean(
    current && current.id === fieldId && !current.required && !current.sensitive,
  );
}

export function isMcpElicitationCardDecisionAllowed(
  input: McpElicitationCardInput,
  decision: Exclude<McpElicitationCardDecision, "skip">,
): boolean {
  if (input.status !== "pending" || !hasBoundedLocalRequestId(input.request.id)) {
    return false;
  }
  if (decision === "decline" || decision === "cancel") {
    return true;
  }
  if (mcpContextDisclosureIssue(input.request)) {
    return false;
  }
  if (input.request.mode === "url") {
    return mcpUrlDisclosureIssue(input.request.url) === null;
  }
  const form = parseNormalizedMcpFields(input.request.fields);
  if (form.issue || mcpFormDisplayIssue(form)) {
    return false;
  }
  const answered = new Set(input.answeredFieldIds ?? []);
  if (form.fields.some((fieldView) => fieldView.sensitive)) {
    return false;
  }
  return form.fields
    .filter((fieldView) => fieldView.required)
    .every((fieldView) => answered.has(fieldView.id));
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
const maxInteractiveRequestIdLength = 128;
const maxPermissionProfileLength = 2_400;
const maxPermissionPathLength = 320;
const maxPermissionEntries = 24;
const maxMcpFields = 12;
const maxMcpFieldIdLength = 128;
const maxMcpOptions = 10;
const maxMcpOptionButtons = 5;
const maxMcpFieldDisplayLength = 1_200;
const maxMcpFormDisplayLength = 8_000;
const maxMcpUrlLength = 1_000;

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

  if (input.status === "failed" || input.status === "stopped") {
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
            ? "发送 /stop 可以停止当前任务；最终回答会作为单独消息发送。"
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

export function buildPermissionApprovalCard(
  input: PermissionApprovalCardInput,
): LarkInteractiveCard {
  const profile = permissionProfileView(input.request.permissions);
  const disclosureIssue = permissionDisclosureIssue(input.request, profile);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(permissionApprovalDetail(input), 700),
    },
    {
      tag: "div",
      fields: [
        field("cwd", input.request.cwd, 320),
        field("updated", input.updatedAt, 80),
        ...(input.request.reason ? [field("reason", input.request.reason, 500)] : []),
        approvalField("requested_profile", profile.text, maxPermissionProfileLength),
        ...(disclosureIssue
          ? [
              field(
                "approval_guard",
                `Grant actions disabled because ${disclosureIssue}; only deny remains available.`,
                500,
              ),
            ]
          : []),
      ],
    },
    { tag: "hr" },
  ];

  if (input.status === "pending" && hasBoundedLocalRequestId(input.request.id)) {
    elements.push(permissionApprovalActions(input.request.id, Boolean(disclosureIssue)));
  }
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          input.status === "pending"
            ? disclosureIssue
              ? "权限范围无法完整安全展示；不会提供任何授权按钮。"
              : "授权范围与上方完整 requested profile 完全一致。"
            : "这条额外权限请求已结束。",
      },
    ],
  });

  const meta = permissionApprovalStatusMeta(input.status);
  return interactiveCard(meta.template, meta.title, elements);
}

export function buildMcpElicitationCard(input: McpElicitationCardInput): LarkInteractiveCard {
  const meta = mcpElicitationStatusMeta(input.status, input.request.mode);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: plain(mcpElicitationDetail(input), 700),
    },
    {
      tag: "div",
      fields: [
        field("server", input.request.serverName, 160),
        field("mode", input.request.mode, 40),
        field("updated", input.updatedAt, 80),
      ],
    },
  ];

  if (input.request.mode === "url") {
    buildMcpUrlElements(input, elements);
  } else {
    buildMcpFormElements(input, elements);
  }

  return interactiveCard(meta.template, meta.title, elements);
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

interface PermissionProfileView {
  text: string;
  issue: string | null;
}

interface McpFormView {
  fields: McpFieldView[];
  issue: string | null;
}

interface McpFieldOptionView {
  value: string;
  title: string;
}

interface McpFieldView {
  id: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "multi_select";
  required: boolean;
  format?: string;
  constraints: string[];
  defaultValue?: string;
  options: McpFieldOptionView[];
  multiple: boolean;
  sensitive: boolean;
}

function permissionProfileView(value: unknown): PermissionProfileView {
  const summary = structuredSummary(value);
  let issue = validatePermissionProfile(value);
  if (!issue && !summary.complete) {
    issue = "the requested profile cannot be rendered completely";
  }
  if (!issue && summary.text.length > maxPermissionProfileLength) {
    issue = "the requested profile exceeds the display limit";
  }
  return { text: summary.text, issue };
}

function permissionDisclosureIssue(
  request: PermissionApprovalCardRequest,
  profile: PermissionProfileView,
): string | null {
  if (!hasBoundedLocalRequestId(request.id)) {
    return "the local request id is unavailable or exceeds its limit";
  }
  if (!request.cwd || request.cwd.length > 320) {
    return "the working directory is unavailable or exceeds the display limit";
  }
  if (request.reason && request.reason.length > 500) {
    return "the reason exceeds the display limit";
  }
  return profile.issue;
}

function validatePermissionProfile(value: unknown): string | null {
  try {
    const profile = exactDataRecord(value, ["fileSystem", "network"]);
    if (!profile) {
      return "the requested profile has an unsupported shape";
    }
    const fileSystem = profile.fileSystem;
    if (fileSystem !== undefined && fileSystem !== null) {
      const issue = validateFileSystemPermissions(fileSystem);
      if (issue) {
        return issue;
      }
    }
    const network = profile.network;
    if (network !== undefined && network !== null) {
      const permissions = exactDataRecord(network, ["enabled"]);
      if (
        !permissions ||
        (permissions.enabled !== undefined &&
          permissions.enabled !== null &&
          typeof permissions.enabled !== "boolean")
      ) {
        return "the network permission profile has an unsupported shape";
      }
    }
    return null;
  } catch {
    return "the requested profile cannot be inspected safely";
  }
}

function validateFileSystemPermissions(value: unknown): string | null {
  const permissions = exactDataRecord(value, ["entries", "globScanMaxDepth", "read", "write"]);
  if (!permissions) {
    return "the filesystem permission profile has an unsupported shape";
  }
  if (
    permissions.globScanMaxDepth !== undefined &&
    permissions.globScanMaxDepth !== null &&
    (typeof permissions.globScanMaxDepth !== "number" ||
      !Number.isSafeInteger(permissions.globScanMaxDepth) ||
      permissions.globScanMaxDepth < 1)
  ) {
    return "the filesystem glob depth is invalid";
  }
  for (const key of ["read", "write"] as const) {
    const entries = permissions[key];
    if (entries === undefined || entries === null) {
      continue;
    }
    if (
      !Array.isArray(entries) ||
      entries.length > maxPermissionEntries ||
      !entries.every(
        (entry) => typeof entry === "string" && entry.length <= maxPermissionPathLength,
      )
    ) {
      return `the filesystem ${key} paths cannot be displayed completely`;
    }
  }
  const entries = permissions.entries;
  if (entries === undefined || entries === null) {
    return null;
  }
  if (!Array.isArray(entries) || entries.length > maxPermissionEntries) {
    return "the filesystem entries exceed the display limit";
  }
  return entries.every(validateFileSystemEntry)
    ? null
    : "a filesystem entry has an unsupported or oversized path";
}

function validateFileSystemEntry(value: unknown): boolean {
  const entry = exactDataRecord(value, ["access", "path"]);
  return Boolean(
    entry &&
      (entry.access === "read" || entry.access === "write" || entry.access === "deny") &&
      validateFileSystemPermissionPath(entry.path),
  );
}

function validateFileSystemPermissionPath(value: unknown): boolean {
  const path = dataRecord(value);
  if (!path || typeof path.type !== "string") {
    return false;
  }
  if (path.type === "path") {
    const exact = exactDataRecord(value, ["path", "type"]);
    return Boolean(
      exact && typeof exact.path === "string" && exact.path.length <= maxPermissionPathLength,
    );
  }
  if (path.type === "glob_pattern") {
    const exact = exactDataRecord(value, ["pattern", "type"]);
    return Boolean(
      exact &&
        typeof exact.pattern === "string" &&
        exact.pattern.length <= maxPermissionPathLength,
    );
  }
  if (path.type !== "special") {
    return false;
  }
  const exact = exactDataRecord(value, ["type", "value"]);
  const special = exact ? dataRecord(exact.value) : null;
  if (!special || typeof special.kind !== "string") {
    return false;
  }
  if (["root", "minimal", "tmpdir", "slash_tmp"].includes(special.kind)) {
    return Boolean(exactDataRecord(exact?.value, ["kind"]));
  }
  if (special.kind === "project_roots") {
    const normalized = exactDataRecord(exact?.value, ["kind", "subpath"]);
    return Boolean(
      normalized &&
        (normalized.subpath === undefined ||
          normalized.subpath === null ||
          (typeof normalized.subpath === "string" &&
            normalized.subpath.length <= maxPermissionPathLength)),
    );
  }
  if (special.kind === "unknown") {
    const normalized = exactDataRecord(exact?.value, ["kind", "path", "subpath"]);
    return Boolean(
      normalized &&
        typeof normalized.path === "string" &&
        normalized.path.length <= maxPermissionPathLength &&
        (normalized.subpath === undefined ||
          normalized.subpath === null ||
          (typeof normalized.subpath === "string" &&
            normalized.subpath.length <= maxPermissionPathLength)),
    );
  }
  return false;
}

function permissionApprovalActions(
  requestId: string,
  grantActionsDisabled: boolean,
): Record<string, unknown> {
  const decisions: PermissionApprovalCardDecision[] = grantActionsDisabled
    ? ["deny"]
    : ["deny", "grantTurn", "grantSession"];
  return {
    tag: "action",
    actions: decisions.map((decision) => ({
      tag: "button",
      text: plain(permissionDecisionLabel(decision), 48),
      type: decision === "deny" ? "danger" : decision === "grantTurn" ? "primary" : "default",
      value: {
        app: runCardActionApp,
        action: resolvePermissionApprovalCardAction,
        requestId,
        decision,
      },
      confirm: {
        title: plain("处理额外权限请求？", 80),
        text: plain(`将选择：${permissionDecisionLabel(decision)}。`, 120),
      },
    })),
  };
}

function permissionDecisionLabel(decision: PermissionApprovalCardDecision): string {
  if (decision === "grantTurn") {
    return "Grant this turn";
  }
  if (decision === "grantSession") {
    return "Grant session";
  }
  return "Deny";
}

function permissionApprovalDetail(input: PermissionApprovalCardInput): string {
  if (input.status === "resolved") {
    return input.decision
      ? `额外权限请求已处理：${permissionDecisionLabel(input.decision)}。`
      : "额外权限请求已处理。";
  }
  if (input.status === "declined") {
    return "这条额外权限请求已拒绝。";
  }
  if (input.status === "cancelled") {
    return "这条额外权限请求已随 Codex 任务取消。";
  }
  if (input.status === "expired") {
    return "这条额外权限请求已过期。";
  }
  return input.request.reason
    ? `Codex 请求额外权限：${input.request.reason}`
    : "Codex 请求额外权限。";
}

function permissionApprovalStatusMeta(
  status: PermissionApprovalCardStatus,
): { title: string; template: string } {
  if (status === "pending") {
    return { title: "Codex 请求额外权限", template: "orange" };
  }
  if (status === "resolved") {
    return { title: "Codex 权限请求已处理", template: "green" };
  }
  if (status === "declined") {
    return { title: "Codex 权限请求已拒绝", template: "grey" };
  }
  return {
    title: status === "expired" ? "Codex 权限请求已过期" : "Codex 权限请求已取消",
    template: "grey",
  };
}

function buildMcpUrlElements(
  input: McpElicitationCardInput,
  elements: Array<Record<string, unknown>>,
): void {
  const contextIssue = mcpContextDisclosureIssue(input.request);
  const requestedUrl = input.request.mode === "url" ? input.request.url : undefined;
  const urlIssue = mcpUrlDisclosureIssue(requestedUrl);
  const disclosureIssue = contextIssue ?? urlIssue;
  const safeUrl = disclosureIssue ? null : requestedUrl ?? null;
  elements.push(
    { tag: "hr" },
    {
      tag: "div",
      text: plain(input.request.message, 700),
    },
  );
  if (safeUrl) {
    elements.push({
      tag: "div",
      fields: [approvalField("url", safeUrl, maxMcpUrlLength)],
    });
  } else {
    elements.push({
      tag: "div",
      fields: [
        field(
          "elicitation_guard",
          `Accept/open actions disabled because ${disclosureIssue ?? "the URL is unavailable"}.`,
          500,
        ),
      ],
    });
  }
  if (input.status === "pending" && hasBoundedLocalRequestId(input.request.id)) {
    elements.push(mcpUrlActions(input.request.id, safeUrl));
  }
  elements.push(mcpElicitationNote(input.status, disclosureIssue));
}

function buildMcpFormElements(
  input: McpElicitationCardInput,
  elements: Array<Record<string, unknown>>,
): void {
  const contextIssue = mcpContextDisclosureIssue(input.request);
  const form =
    input.request.mode === "form"
      ? parseNormalizedMcpFields(input.request.fields)
      : { fields: [], issue: "the normalized standard form fields are unavailable" };
  const answered = new Set(input.answeredFieldIds ?? []);
  const displayIssue = mcpFormDisplayIssue(form, answered);
  const disclosureIssue = contextIssue ?? form.issue ?? displayIssue;

  elements.push(
    { tag: "hr" },
    {
      tag: "div",
      text: plain(input.request.message, 700),
    },
  );
  for (const [index, fieldView] of form.fields.entries()) {
    elements.push({
      tag: "div",
      text: markdown(renderMcpField(fieldView, answered.has(fieldView.id), index + 1)),
    });
  }

  if (disclosureIssue) {
    elements.push({
      tag: "div",
      fields: [
        field(
          "elicitation_guard",
          `Answer/accept actions disabled because ${disclosureIssue}.`,
          500,
        ),
      ],
    });
  }

  if (input.status === "pending" && hasBoundedLocalRequestId(input.request.id)) {
    const pendingField = form.fields.find((fieldView) => !answered.has(fieldView.id));
    if (!disclosureIssue && pendingField) {
      const inputActions = mcpFieldInputActions(input, pendingField);
      if (inputActions) {
        elements.push(inputActions);
      }
      const guidance = mcpFieldReplyGuidance(input, pendingField);
      if (guidance) {
        elements.push({
          tag: "note",
          elements: [{ tag: "plain_text", content: guidance }],
        });
      }
    }
    const canAccept =
      !disclosureIssue &&
      !form.fields.some((fieldView) => fieldView.sensitive) &&
      form.fields
        .filter((fieldView) => fieldView.required)
        .every((fieldView) => answered.has(fieldView.id));
    elements.push(mcpResolveActions(input.request.id, canAccept));
  }
  elements.push(mcpElicitationNote(input.status, disclosureIssue));
}

function mcpFormDisplayIssue(form: McpFormView, answered = new Set<string>()): string | null {
  const displayLength = form.fields.reduce(
    (total, fieldView, index) =>
      total + renderMcpField(fieldView, answered.has(fieldView.id), index + 1).length,
    0,
  );
  return displayLength > maxMcpFormDisplayLength
    ? "the form exceeds the card display limit"
    : null;
}

function mcpContextDisclosureIssue(request: McpElicitationCardRequest): string | null {
  if (!hasBoundedLocalRequestId(request.id)) {
    return "the local request id is unavailable or exceeds its limit";
  }
  if (!request.serverName || request.serverName.length > 160) {
    return "the MCP server name is unavailable or exceeds the display limit";
  }
  if (!request.message || request.message.length > 700) {
    return "the MCP message is unavailable or exceeds the display limit";
  }
  return null;
}

function hasBoundedLocalRequestId(value: string): boolean {
  return Boolean(value && value.length <= maxInteractiveRequestIdLength);
}

function mcpUrlDisclosureIssue(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > maxMcpUrlLength) {
    return "the URL is unavailable or exceeds the display limit";
  }
  if (value.trim() !== value) {
    return "the URL has surrounding whitespace";
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "the URL is not an HTTP(S) URL";
    }
    if (!parsed.hostname) {
      return "the URL has no hostname";
    }
    if (parsed.username || parsed.password) {
      return "the URL contains userinfo credentials";
    }
    return null;
  } catch {
    return "the URL is invalid";
  }
}

function mcpUrlActions(requestId: string, url: string | null): Record<string, unknown> {
  const actions: Array<Record<string, unknown>> = [];
  if (url) {
    actions.push({
      tag: "button",
      text: plain("Open URL", 48),
      type: "default",
      url,
    });
    actions.push(mcpResolveButton(requestId, "accept", "Accept", "primary"));
  }
  actions.push(mcpResolveButton(requestId, "decline", "Decline", "danger"));
  actions.push(mcpResolveButton(requestId, "cancel", "Cancel", "default"));
  return { tag: "action", actions };
}

function mcpResolveActions(requestId: string, canAccept: boolean): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      ...(canAccept ? [mcpResolveButton(requestId, "accept", "Submit", "primary")] : []),
      mcpResolveButton(requestId, "decline", "Decline", "danger"),
      mcpResolveButton(requestId, "cancel", "Cancel", "default"),
    ],
  };
}

function mcpResolveButton(
  requestId: string,
  decision: Exclude<McpElicitationCardDecision, "skip">,
  label: string,
  type: string,
): Record<string, unknown> {
  return {
    tag: "button",
    text: plain(label, 48),
    type,
    value: {
      app: runCardActionApp,
      action: resolveMcpElicitationCardAction,
      requestId,
      decision,
    },
  };
}

function mcpFieldInputActions(
  input: McpElicitationCardInput,
  fieldView: McpFieldView,
): Record<string, unknown> | null {
  if (fieldView.sensitive) {
    return null;
  }
  const options =
    fieldView.type === "boolean"
      ? [
          { value: "true", title: "True" },
          { value: "false", title: "False" },
        ]
      : fieldView.multiple
        ? []
        : fieldView.options;
  const renderedOptionLabels = options.map((option) => truncate(option.title, 48));
  const optionsFitButtons =
    options.length > 0 &&
    options.length <= maxMcpOptionButtons &&
    renderedOptionLabels.every(Boolean) &&
    new Set(renderedOptionLabels).size === renderedOptionLabels.length;
  const actions: Array<Record<string, unknown>> = optionsFitButtons
    ? options.map((option, optionIndex) => ({
        tag: "button",
        text: plain(option.title, 48),
        type: "primary",
        value: {
          app: runCardActionApp,
          action: answerMcpElicitationCardAction,
          requestId: input.request.id,
          fieldId: fieldView.id,
          optionIndex,
        },
      }))
    : [];
  if (!fieldView.required) {
    actions.push({
      tag: "button",
      text: plain("Skip", 48),
      type: "default",
      value: {
        app: runCardActionApp,
        action: answerMcpElicitationCardAction,
        requestId: input.request.id,
        fieldId: fieldView.id,
        decision: "skip",
      },
    });
  }
  return actions.length ? { tag: "action", actions } : null;
}

function mcpFieldReplyGuidance(
  input: McpElicitationCardInput,
  fieldView: McpFieldView,
): string | null {
  if (fieldView.sensitive) {
    return "这个字段看起来包含 secret/password；聊天中不会提供输入入口。";
  }
  if (
    !input.replyCode ||
    input.replyCode.length > 40 ||
    !fieldView.id ||
    fieldView.id.length > maxMcpFieldIdLength
  ) {
    return null;
  }
  const suffix = fieldView.multiple ? "<JSON 字符串数组>" : "<内容>";
  const guidance =
    `可发送 /mcp-answer ${input.replyCode} ${JSON.stringify(fieldView.id)} ${suffix} 回答这个字段。`;
  return guidance.length <= 240 ? guidance : null;
}

function mcpElicitationNote(
  status: McpElicitationCardStatus,
  disclosureIssue: string | null,
): Record<string, unknown> {
  return {
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content:
          status !== "pending"
            ? "这条 MCP elicitation 已结束；卡片不会回显回答内容。"
            : disclosureIssue
              ? "请求未完整展示，已关闭所有正向操作；仍可拒绝或取消。"
              : "提交前，服务端会按原始 MCP schema 重新校验字段和值。",
      },
    ],
  };
}

function mcpElicitationDetail(input: McpElicitationCardInput): string {
  if (input.status === "resolved") {
    return "MCP elicitation 已提交；为避免泄露，卡片不会回显回答内容。";
  }
  if (input.status === "declined") {
    return "这条 MCP elicitation 已拒绝。";
  }
  if (input.status === "cancelled") {
    return "这条 MCP elicitation 已取消。";
  }
  if (input.status === "expired") {
    return "这条 MCP elicitation 已过期，迟到的操作不会生效。";
  }
  return input.request.mode === "url"
    ? "MCP 服务请求你查看并确认下面的链接。"
    : "MCP 服务请求你填写下面的结构化表单。";
}

function mcpElicitationStatusMeta(
  status: McpElicitationCardStatus,
  mode: McpElicitationCardRequest["mode"],
): { title: string; template: string } {
  if (status === "pending") {
    return {
      title: mode === "url" ? "MCP 请求打开链接" : "MCP 请求结构化输入",
      template: "orange",
    };
  }
  if (status === "resolved") {
    return { title: "MCP elicitation 已处理", template: "green" };
  }
  if (status === "declined") {
    return { title: "MCP elicitation 已拒绝", template: "grey" };
  }
  return {
    title: status === "expired" ? "MCP elicitation 已过期" : "MCP elicitation 已取消",
    template: "grey",
  };
}

function parseNormalizedMcpFields(fields: CodexMcpElicitationField[]): McpFormView {
  try {
    if (!Array.isArray(fields) || fields.length > maxMcpFields) {
      throw new Error("the form has too many fields to display completely");
    }
    const normalized = fields.map(normalizeMcpField);
    if (new Set(normalized.map((fieldView) => fieldView.id)).size !== normalized.length) {
      throw new Error("the form contains duplicate field ids");
    }
    for (const [index, fieldView] of normalized.entries()) {
      if (renderMcpField(fieldView, false, index + 1).length > maxMcpFieldDisplayLength) {
        throw new Error("a form field exceeds the display limit");
      }
    }
    return { fields: normalized, issue: null };
  } catch (error) {
    return {
      fields: [],
      issue: error instanceof Error ? error.message : "the form fields cannot be inspected safely",
    };
  }
}

function normalizeMcpField(value: unknown): McpFieldView {
  const field = dataRecord(value);
  if (
    !field ||
    typeof field.name !== "string" ||
    !field.name ||
    field.name.length > maxMcpFieldIdLength ||
    typeof field.required !== "boolean" ||
    typeof field.type !== "string"
  ) {
    throw new Error("a form field has invalid normalized metadata");
  }
  const title = optionalMcpString(field.title, 160, field.name);
  const description = optionalMcpString(field.description, 500);
  const base = {
    id: field.name,
    title,
    ...(description ? { description } : {}),
    required: field.required,
    constraints: [] as string[],
    options: [] as McpFieldOptionView[],
    multiple: false,
    sensitive: isSensitiveMcpField(field.name, title),
  };
  if (field.type === "string") {
    const exact = exactDataRecord(value, [
      "default",
      "description",
      "format",
      "maxLength",
      "minLength",
      "name",
      "required",
      "title",
      "type",
    ]);
    if (!exact) {
      throw new Error("a string field contains unsupported normalized properties");
    }
    const format = parseMcpStringFormat(exact.format);
    const minLength = optionalNonNegativeInteger(exact.minLength, "minLength");
    const maxLength = optionalNonNegativeInteger(exact.maxLength, "maxLength");
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new Error("a string field has an invalid length range");
    }
    const defaultValue = optionalMcpDefaultString(exact.default);
    return {
      ...base,
      type: "string",
      ...(format ? { format } : {}),
      constraints: [
        ...(minLength !== undefined ? [`minLength=${minLength}`] : []),
        ...(maxLength !== undefined ? [`maxLength=${maxLength}`] : []),
      ],
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      sensitive: isSensitiveMcpField(field.name, title, format),
    };
  }
  if (field.type === "number" || field.type === "integer") {
    const exact = exactDataRecord(value, [
      "default",
      "description",
      "maximum",
      "minimum",
      "name",
      "required",
      "title",
      "type",
    ]);
    if (!exact) {
      throw new Error("a numeric field contains unsupported normalized properties");
    }
    const minimum = optionalFiniteNumber(exact.minimum, "minimum");
    const maximum = optionalFiniteNumber(exact.maximum, "maximum");
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error("a numeric field has an invalid range");
    }
    const defaultValue = optionalMcpDefaultNumber(exact.default, field.type === "integer");
    return {
      ...base,
      type: field.type,
      constraints: [
        ...(minimum !== undefined ? [`minimum=${minimum}`] : []),
        ...(maximum !== undefined ? [`maximum=${maximum}`] : []),
      ],
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  }
  if (field.type === "boolean") {
    const exact = exactDataRecord(value, [
      "default",
      "description",
      "name",
      "required",
      "title",
      "type",
    ]);
    if (
      !exact ||
      (exact.default !== null && exact.default !== undefined && typeof exact.default !== "boolean")
    ) {
      throw new Error("a boolean field has invalid normalized properties");
    }
    return {
      ...base,
      type: "boolean",
      ...(typeof exact.default === "boolean" ? { defaultValue: String(exact.default) } : {}),
    };
  }
  if (field.type === "enum") {
    const exact = exactDataRecord(value, [
      "default",
      "description",
      "name",
      "options",
      "required",
      "title",
      "type",
    ]);
    if (!exact) {
      throw new Error("an enum field contains unsupported normalized properties");
    }
    const options = parseNormalizedMcpOptions(exact.options);
    const defaultValue = optionalMcpDefaultString(exact.default);
    if (defaultValue !== undefined && !options.some((option) => option.value === defaultValue)) {
      throw new Error("an enum field has an invalid default");
    }
    return {
      ...base,
      type: "enum",
      options,
      ...(defaultValue ? { defaultValue } : {}),
      sensitive: base.sensitive || options.some(isSensitiveMcpOption),
    };
  }
  if (field.type === "multi_select") {
    const exact = exactDataRecord(value, [
      "default",
      "description",
      "maxItems",
      "minItems",
      "name",
      "options",
      "required",
      "title",
      "type",
    ]);
    if (!exact) {
      throw new Error("a multi-select field contains unsupported normalized properties");
    }
    const options = parseNormalizedMcpOptions(exact.options);
    const minItems = optionalNonNegativeInteger(exact.minItems, "minItems");
    const maxItems = optionalNonNegativeInteger(exact.maxItems, "maxItems");
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new Error("a multi-select field has an invalid item range");
    }
    const defaultValue = optionalMcpDefaultStringArray(exact.default, options);
    return {
      ...base,
      type: "multi_select",
      options,
      multiple: true,
      constraints: [
        ...(minItems !== undefined ? [`minItems=${minItems}`] : []),
        ...(maxItems !== undefined ? [`maxItems=${maxItems}`] : []),
      ],
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      sensitive: base.sensitive || options.some(isSensitiveMcpOption),
    };
  }
  throw new Error("a form field uses an unsupported normalized type");
}

function parseNormalizedMcpOptions(value: unknown): McpFieldOptionView[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxMcpOptions) {
    throw new Error("a select field has no options or too many options");
  }
  const options = value.map((entry) => {
    const option = exactDataRecord(entry, ["title", "value"]);
    if (
      !option ||
      typeof option.value !== "string" ||
      !option.value ||
      option.value.length > 160 ||
      typeof option.title !== "string" ||
      !option.title ||
      option.title.length > 160
    ) {
      throw new Error("a select option is invalid or oversized");
    }
    return { value: option.value, title: option.title };
  });
  ensureUniqueMcpOptions(options);
  return options;
}

function optionalMcpString(value: unknown, maxLength: number, fallback?: string): string {
  if (value === undefined || value === null) {
    return fallback ?? "";
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error("a form string is invalid or oversized");
  }
  return value || fallback || "";
}

function parseMcpStringFormat(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "email" ||
    value === "uri" ||
    value === "date" ||
    value === "date-time" ||
    value === "password"
  ) {
    return value;
  }
  throw new Error("a string field uses an unsupported format");
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`a form field has an invalid ${label}`);
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`a form field has an invalid ${label}`);
  }
  return value;
}

function optionalMcpDefaultString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 240) {
    throw new Error("a string field has an invalid or oversized default");
  }
  return value;
}

function optionalMcpDefaultNumber(value: unknown, integer: boolean): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error("a numeric field has an invalid default");
  }
  return String(value);
}

function optionalMcpDefaultStringArray(
  value: unknown,
  options: McpFieldOptionView[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const allowed = new Set(options.map((option) => option.value));
  if (
    !Array.isArray(value) ||
    value.length > maxMcpOptions ||
    !value.every((item) => typeof item === "string" && allowed.has(item))
  ) {
    throw new Error("an array field has an invalid default");
  }
  return JSON.stringify(value);
}

function ensureUniqueMcpOptions(options: McpFieldOptionView[]): void {
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new Error("a select field has duplicate option values");
  }
}

function isSensitiveMcpField(fieldId: string, title: string, format?: string): boolean {
  if (format === "password") {
    return true;
  }
  return isSensitiveMcpText(`${fieldId} ${title}`);
}

function isSensitiveMcpOption(option: McpFieldOptionView): boolean {
  return isSensitiveMcpText(`${option.title} ${option.value}`);
}

function isSensitiveMcpText(value: string): boolean {
  return /(?:password|passwd|secret|token|api[\s_-]*key|credential|private[\s_-]*key)/iu.test(value);
}

function renderMcpField(fieldView: McpFieldView, answered: boolean, index: number): string {
  const heading = index > 0 ? `${index}. ${fieldView.title}` : fieldView.title;
  const metadata = [
    `id=${fieldView.id}`,
    `type=${fieldView.type}`,
    `required=${fieldView.required ? "yes" : "no"}`,
    `status=${answered ? "answered" : "pending"}`,
    fieldView.format ? `format=${fieldView.format}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const optionText = !fieldView.sensitive && fieldView.options.length
    ? `enum=${fieldView.options
        .map((option, optionIndex) =>
          option.title === option.value
            ? `${optionIndex}:${option.value}`
            : `${optionIndex}:${option.title} (${option.value})`,
        )
        .join(" | ")}`
    : null;
  return [
    `**${escapeLarkMarkdown(heading)}**`,
    escapeLarkMarkdown(metadata),
    fieldView.description ? escapeLarkMarkdown(fieldView.description) : null,
    optionText ? escapeLarkMarkdown(optionText) : null,
    fieldView.constraints.length
      ? escapeLarkMarkdown(`range=${fieldView.constraints.join(", ")}`)
      : null,
    fieldView.defaultValue !== undefined && !fieldView.sensitive
      ? escapeLarkMarkdown(`default=${fieldView.defaultValue}`)
      : null,
    fieldView.sensitive
      ? "**security** secret/password-like field; chat input disabled"
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function interactiveCard(
  template: string,
  title: string,
  elements: Array<Record<string, unknown>>,
): LarkInteractiveCard {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: plain(title, 120),
    },
    elements,
  };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string")
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | null {
  const record = dataRecord(value);
  if (!record) {
    return null;
  }
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
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
