import { describe, expect, test } from "bun:test";

import { buildCodexChildEnv } from "../src/agent/codex-environment.js";

describe("Codex child environment", () => {
  test("removes bridge and platform credentials while preserving Codex runtime variables", () => {
    const childEnv = buildCodexChildEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex-home",
      OPENAI_API_KEY: "openai-test-key",
      HTTPS_PROXY: "http://proxy.example",
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "feishu-secret",
      LARK_DOMAIN: "feishu",
      WEIXIN_TOKEN: "weixin-secret",
      WECOM_SECRET: "wecom-secret",
      CHAT2CODEX_HOME: "/tmp/chat2codex",
      ALLOWED_USER_IDS: "ou_secret",
      BRIDGE_STATE_PATH: "/tmp/state.json",
      CODEX_WORKDIR: "/tmp/workspace",
      CODEX_SANDBOX: "workspace-write",
      CODEX_MAX_CONCURRENT_RUNS: "2",
      BRIDGE_MAX_PENDING_MESSAGES: "64",
      BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "8",
      ATTACHMENT_MAX_COUNT: "4",
      ATTACHMENT_MAX_FILE_BYTES: "26214400",
      ATTACHMENT_MAX_TOTAL_BYTES: "52428800",
      ATTACHMENT_STORE_MAX_BYTES: "1073741824",
      ATTACHMENT_RETENTION_HOURS: "24",
      CHAT_OUTPUT_MAX_CHARS: "28000",
      CODEX_STDERR_MAX_BYTES: "262144",
      RUN_LOG_MAX_COMMANDS: "20",
      RUN_LOG_MAX_BYTES: "65536",
      RUN_DIFF_MAX_CHARS: "60000",
      LOG_ENTRY_MAX_BYTES: "16384",
      LOG_FILE_MAX_BYTES: "10485760",
      LOG_FILE_MAX_FILES: "3",
      JOB_RETENTION_COUNT: "500",
      OUTBOX_RETENTION_COUNT: "500",
    });

    expect(childEnv).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex-home",
      OPENAI_API_KEY: "openai-test-key",
      HTTPS_PROXY: "http://proxy.example",
    });
    expect(childEnv.FEISHU_APP_ID).toBeUndefined();
    expect(childEnv.FEISHU_APP_SECRET).toBeUndefined();
    expect(childEnv.LARK_DOMAIN).toBeUndefined();
    expect(childEnv.WEIXIN_TOKEN).toBeUndefined();
    expect(childEnv.WECOM_SECRET).toBeUndefined();
    expect(childEnv.CHAT2CODEX_HOME).toBeUndefined();
    expect(childEnv.ALLOWED_USER_IDS).toBeUndefined();
    expect(childEnv.BRIDGE_STATE_PATH).toBeUndefined();
    expect(childEnv.CODEX_WORKDIR).toBeUndefined();
    expect(childEnv.CODEX_SANDBOX).toBeUndefined();
    for (const key of [
      "CODEX_MAX_CONCURRENT_RUNS",
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
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }
  });
});
