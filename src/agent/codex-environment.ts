const platformCredentialPrefixes = [
  "FEISHU_",
  "LARK_",
  "WEIXIN_",
  "WECHAT_",
  "WECOM_",
  "CHAT2CODEX_",
] as const;

const bridgeOnlyEnvironmentKeys = new Set([
  "ALLOW_DIRECT_MESSAGES",
  "ALLOW_GROUPS",
  "ALLOWED_CHAT_IDS",
  "ALLOWED_USER_IDS",
  "ATTACHMENT_DOWNLOAD_DIR",
  "BRIDGE_STATE_PATH",
  "LOG_LEVEL",
  "CODEX_BIN",
  "CODEX_WORKDIR",
  "CODEX_SANDBOX",
  "CODEX_APPROVAL_POLICY",
  "CODEX_RUN_TIMEOUT_MS",
  "CODEX_APPROVAL_TIMEOUT_MS",
  "CODEX_MAX_CONCURRENT_RUNS",
  "CODEX_GROUP_ALLOWED_ROOTS",
  "CODEX_SKIP_GIT_REPO_CHECK",
  "CODEX_MODEL",
  "CODEX_APP_SERVER_SCHEMA_DIR",
  "CODEX_APP_SERVER_SMOKE_MODE",
  "CODEX_APP_SERVER_SMOKE_TIMEOUT_MS",
  "BRIDGE_MAX_PENDING_MESSAGES",
  "BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT",
  "ATTACHMENT_MAX_COUNT",
  "ATTACHMENT_MAX_FILE_BYTES",
  "ATTACHMENT_MAX_TOTAL_BYTES",
  "ATTACHMENT_STORE_MAX_BYTES",
  "ATTACHMENT_RETENTION_HOURS",
  "CHAT_OUTPUT_MAX_CHARS",
  "CODEX_STDERR_MAX_BYTES",
  "RUN_LOG_MAX_COMMANDS",
  "RUN_LOG_MAX_BYTES",
  "RUN_DIFF_MAX_CHARS",
  "LOG_ENTRY_MAX_BYTES",
  "LOG_FILE_MAX_BYTES",
  "LOG_FILE_MAX_FILES",
  "JOB_RETENTION_COUNT",
  "OUTBOX_RETENTION_COUNT",
  "CHAT2CODEX_LOG_FILE",
]);

export function buildCodexChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...source };
  for (const key of Object.keys(childEnv)) {
    if (
      bridgeOnlyEnvironmentKeys.has(key) ||
      platformCredentialPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      delete childEnv[key];
    }
  }
  return childEnv;
}
