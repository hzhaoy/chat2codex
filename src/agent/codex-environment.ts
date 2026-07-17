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
  "CODEX_GROUP_ALLOWED_ROOTS",
  "CODEX_SKIP_GIT_REPO_CHECK",
  "CODEX_MODEL",
  "CODEX_APP_SERVER_SCHEMA_DIR",
  "CODEX_APP_SERVER_SMOKE_MODE",
  "CODEX_APP_SERVER_SMOKE_TIMEOUT_MS",
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
