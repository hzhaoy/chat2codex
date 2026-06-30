import path from "node:path";

import { z } from "zod";

export interface AccessControlConfig {
  allowDirectMessages: boolean;
  allowGroups: boolean;
  allowedChatIds: string[];
  allowedUserIds: string[];
}

const codexApprovalPolicies = ["untrusted", "on-request", "on-failure", "never"] as const;

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
  CODEX_MODEL: z.string().optional(),
  CODEX_SKIP_GIT_REPO_CHECK: booleanEnv(false),
  CODEX_GROUP_ALLOWED_ROOTS: z.string().default(""),
  ALLOW_DIRECT_MESSAGES: booleanEnv(true),
  ALLOW_GROUPS: booleanEnv(false),
  ALLOWED_CHAT_IDS: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  ATTACHMENT_DOWNLOAD_DIR: z.string().min(1).default(".data/attachments"),
  BRIDGE_STATE_PATH: z.string().min(1).default(".data/state.json"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = configSchema.parse(env);
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
    codexModel: parsed.CODEX_MODEL?.trim() || undefined,
    codexSkipGitRepoCheck: parsed.CODEX_SKIP_GIT_REPO_CHECK,
    codexGroupAllowedRoots: groupAllowedRoots.length > 0 ? groupAllowedRoots : [codexWorkdir],
    access: {
      allowDirectMessages: parsed.ALLOW_DIRECT_MESSAGES,
      allowGroups: parsed.ALLOW_GROUPS,
      allowedChatIds: parseCsv(parsed.ALLOWED_CHAT_IDS),
      allowedUserIds: parseCsv(parsed.ALLOWED_USER_IDS),
    } satisfies AccessControlConfig,
    attachmentDownloadDir: path.resolve(parsed.ATTACHMENT_DOWNLOAD_DIR),
    bridgeStatePath: path.resolve(parsed.BRIDGE_STATE_PATH),
    logLevel: parsed.LOG_LEVEL,
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
