import path from "node:path";

import { z } from "zod";

import { defaultChat2CodexHome } from "./paths.js";

export interface AccessControlConfig {
  allowDirectMessages: boolean;
  allowGroups: boolean;
  allowedChatIds: string[];
  allowedUserIds: string[];
}

const codexApprovalPolicies = ["untrusted", "on-request", "never"] as const;

const ONE_GIBIBYTE = 1024 ** 3;
const ONE_TEBIBYTE = 1024 ** 4;

const positiveIntegerEnv = (defaultValue: number, maximum: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") {
      return defaultValue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return defaultValue;
      }
      if (!/^\d+$/.test(trimmed)) {
        return value;
      }
      return Number(trimmed);
    }
    return value;
  }, z.number().int().positive().max(maximum));

const timeoutEnv = () =>
  z.preprocess((value) => {
    if (value === undefined || value === "") {
      return 0;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return 0;
      }
      return Number(trimmed);
    }
    return value;
  }, z.number().int().nonnegative());

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean());

const configSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_BOT_OPEN_ID: z.string().optional(),
  LARK_DOMAIN: z.enum(["feishu", "lark"]).default("feishu"),
  CODEX_BIN: z.string().min(1).default("codex"),
  CODEX_WORKDIR: z.string().min(1).default(process.cwd()),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_APPROVAL_POLICY: z.enum(codexApprovalPolicies).default("never"),
  CODEX_RUN_TIMEOUT_MS: timeoutEnv().default(0),
  CODEX_APPROVAL_TIMEOUT_MS: timeoutEnv().default(0),
  CODEX_MAX_CONCURRENT_RUNS: positiveIntegerEnv(2, 256),
  CODEX_MODEL: z.string().optional(),
  CODEX_SKIP_GIT_REPO_CHECK: booleanEnv(false),
  CODEX_GROUP_ALLOWED_ROOTS: z.string().default(""),
  ALLOW_DIRECT_MESSAGES: booleanEnv(true),
  ALLOW_GROUPS: booleanEnv(false),
  ALLOWED_CHAT_IDS: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  BRIDGE_MAX_PENDING_MESSAGES: positiveIntegerEnv(64, 100_000),
  BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: positiveIntegerEnv(8, 100_000),
  ATTACHMENT_DOWNLOAD_DIR: z.string().min(1).default(".data/attachments"),
  ATTACHMENT_MAX_COUNT: positiveIntegerEnv(4, 1_000),
  ATTACHMENT_MAX_FILE_BYTES: positiveIntegerEnv(25 * 1024 ** 2, ONE_TEBIBYTE),
  ATTACHMENT_MAX_TOTAL_BYTES: positiveIntegerEnv(50 * 1024 ** 2, ONE_TEBIBYTE),
  ATTACHMENT_STORE_MAX_BYTES: positiveIntegerEnv(ONE_GIBIBYTE, ONE_TEBIBYTE),
  ATTACHMENT_RETENTION_HOURS: positiveIntegerEnv(24, 24 * 365 * 10),
  CHAT_OUTPUT_MAX_CHARS: positiveIntegerEnv(28_000, ONE_GIBIBYTE),
  CODEX_STDERR_MAX_BYTES: positiveIntegerEnv(256 * 1024, ONE_GIBIBYTE),
  RUN_LOG_MAX_COMMANDS: positiveIntegerEnv(20, 100_000),
  RUN_LOG_MAX_BYTES: positiveIntegerEnv(64 * 1024, ONE_GIBIBYTE),
  RUN_DIFF_MAX_CHARS: positiveIntegerEnv(60_000, ONE_GIBIBYTE),
  LOG_ENTRY_MAX_BYTES: positiveIntegerEnv(16 * 1024, ONE_GIBIBYTE),
  LOG_FILE_MAX_BYTES: positiveIntegerEnv(10 * 1024 ** 2, ONE_TEBIBYTE),
  LOG_FILE_MAX_FILES: positiveIntegerEnv(3, 10_000),
  JOB_RETENTION_COUNT: positiveIntegerEnv(500, 1_000_000),
  OUTBOX_RETENTION_COUNT: positiveIntegerEnv(500, 1_000_000),
  BRIDGE_STATE_PATH: z.string().min(1).default(".data/state.json"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((config, context) => {
  if (config.BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT > config.BRIDGE_MAX_PENDING_MESSAGES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT"],
      message: "must not exceed BRIDGE_MAX_PENDING_MESSAGES",
    });
  }
  if (config.ATTACHMENT_MAX_FILE_BYTES > config.ATTACHMENT_MAX_TOTAL_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ATTACHMENT_MAX_FILE_BYTES"],
      message: "must not exceed ATTACHMENT_MAX_TOTAL_BYTES",
    });
  }
  if (config.ATTACHMENT_MAX_TOTAL_BYTES > config.ATTACHMENT_STORE_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ATTACHMENT_MAX_TOTAL_BYTES"],
      message: "must not exceed ATTACHMENT_STORE_MAX_BYTES",
    });
  }
  if (config.LOG_ENTRY_MAX_BYTES > config.LOG_FILE_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LOG_ENTRY_MAX_BYTES"],
      message: "must not exceed LOG_FILE_MAX_BYTES",
    });
  }
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = configSchema.parse(env);
  const home = defaultChat2CodexHome(env);
  const codexWorkdir = path.resolve(parsed.CODEX_WORKDIR);
  const groupAllowedRoots = parseCsv(parsed.CODEX_GROUP_ALLOWED_ROOTS).map((entry) =>
    path.resolve(entry),
  );
  return {
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
    feishuBotOpenId: parsed.FEISHU_BOT_OPEN_ID?.trim() || undefined,
    larkDomain: parsed.LARK_DOMAIN,
    codexBin: parsed.CODEX_BIN,
    codexWorkdir,
    codexSandbox: parsed.CODEX_SANDBOX,
    codexApprovalPolicy: parsed.CODEX_APPROVAL_POLICY,
    codexRunTimeoutMs: parsed.CODEX_RUN_TIMEOUT_MS,
    codexApprovalTimeoutMs: parsed.CODEX_APPROVAL_TIMEOUT_MS,
    codexMaxConcurrentRuns: parsed.CODEX_MAX_CONCURRENT_RUNS,
    codexModel: parsed.CODEX_MODEL?.trim() || undefined,
    codexSkipGitRepoCheck: parsed.CODEX_SKIP_GIT_REPO_CHECK,
    codexGroupAllowedRoots: groupAllowedRoots.length > 0 ? groupAllowedRoots : [codexWorkdir],
    access: {
      allowDirectMessages: parsed.ALLOW_DIRECT_MESSAGES,
      allowGroups: parsed.ALLOW_GROUPS,
      allowedChatIds: parseCsv(parsed.ALLOWED_CHAT_IDS),
      allowedUserIds: parseCsv(parsed.ALLOWED_USER_IDS),
    } satisfies AccessControlConfig,
    bridgeMaxPendingMessages: parsed.BRIDGE_MAX_PENDING_MESSAGES,
    bridgeMaxPendingMessagesPerChat: parsed.BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT,
    attachmentDownloadDir: path.resolve(
      env.ATTACHMENT_DOWNLOAD_DIR || path.join(home, "attachments"),
    ),
    attachmentMaxCount: parsed.ATTACHMENT_MAX_COUNT,
    attachmentMaxFileBytes: parsed.ATTACHMENT_MAX_FILE_BYTES,
    attachmentMaxTotalBytes: parsed.ATTACHMENT_MAX_TOTAL_BYTES,
    attachmentStoreMaxBytes: parsed.ATTACHMENT_STORE_MAX_BYTES,
    attachmentRetentionHours: parsed.ATTACHMENT_RETENTION_HOURS,
    chatOutputMaxChars: parsed.CHAT_OUTPUT_MAX_CHARS,
    codexStderrMaxBytes: parsed.CODEX_STDERR_MAX_BYTES,
    runLogMaxCommands: parsed.RUN_LOG_MAX_COMMANDS,
    runLogMaxBytes: parsed.RUN_LOG_MAX_BYTES,
    runDiffMaxChars: parsed.RUN_DIFF_MAX_CHARS,
    logEntryMaxBytes: parsed.LOG_ENTRY_MAX_BYTES,
    logFileMaxBytes: parsed.LOG_FILE_MAX_BYTES,
    logFileMaxFiles: parsed.LOG_FILE_MAX_FILES,
    jobRetentionCount: parsed.JOB_RETENTION_COUNT,
    outboxRetentionCount: parsed.OUTBOX_RETENTION_COUNT,
    bridgeStatePath: path.resolve(env.BRIDGE_STATE_PATH || path.join(home, "state.json")),
    logLevel: parsed.LOG_LEVEL,
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
