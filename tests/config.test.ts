import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  test("parses boolean and comma-separated access control env values", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      CODEX_WORKDIR: "/tmp/chat2codex",
      CODEX_APPROVAL_POLICY: "on-request",
      CODEX_SKIP_GIT_REPO_CHECK: "false",
      CODEX_GROUP_ALLOWED_ROOTS: "/tmp/team-a, /tmp/team-b,, ",
      ALLOW_DIRECT_MESSAGES: "false",
      ALLOW_GROUPS: "true",
      ALLOWED_CHAT_IDS: "oc_a, oc_b,, ",
      ALLOWED_USER_IDS: "ou_1,on_2",
      ATTACHMENT_DOWNLOAD_DIR: "/tmp/chat2codex-attachments",
    });

    expect(config.codexSkipGitRepoCheck).toBe(false);
    expect(config.codexApprovalPolicy).toBe("on-request");
    expect(config.codexGroupAllowedRoots).toEqual(["/tmp/team-a", "/tmp/team-b"]);
    expect(config.feishuBotOpenId).toBe("ou_bot");
    expect(config.access.allowDirectMessages).toBe(false);
    expect(config.access.allowGroups).toBe(true);
    expect(config.access.allowedChatIds).toEqual(["oc_a", "oc_b"]);
    expect(config.access.allowedUserIds).toEqual(["ou_1", "on_2"]);
    expect(config.attachmentDownloadDir).toBe("/tmp/chat2codex-attachments");
    expect(config.codexRunTimeoutMs).toBe(0);
    expect(config.codexApprovalTimeoutMs).toBe(0);
    expect(config.codexMaxConcurrentRuns).toBe(2);
    expect(config.bridgeMaxPendingMessages).toBe(64);
    expect(config.bridgeMaxPendingMessagesPerChat).toBe(8);
    expect(config.attachmentMaxCount).toBe(4);
    expect(config.attachmentMaxFileBytes).toBe(26_214_400);
    expect(config.attachmentMaxTotalBytes).toBe(52_428_800);
    expect(config.attachmentStoreMaxBytes).toBe(1_073_741_824);
    expect(config.attachmentRetentionHours).toBe(24);
    expect(config.chatOutputMaxChars).toBe(28_000);
    expect(config.codexStderrMaxBytes).toBe(262_144);
    expect(config.runLogMaxCommands).toBe(20);
    expect(config.runLogMaxBytes).toBe(65_536);
    expect(config.runDiffMaxChars).toBe(60_000);
    expect(config.logEntryMaxBytes).toBe(16_384);
    expect(config.logFileMaxBytes).toBe(10_485_760);
    expect(config.logFileMaxFiles).toBe(3);
    expect(config.jobRetentionCount).toBe(500);
    expect(config.outboxRetentionCount).toBe(500);
  });

  test("parses resource and retention limits", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_MAX_CONCURRENT_RUNS: "4",
      BRIDGE_MAX_PENDING_MESSAGES: "12",
      BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "3",
      ATTACHMENT_MAX_COUNT: "2",
      ATTACHMENT_MAX_FILE_BYTES: "100",
      ATTACHMENT_MAX_TOTAL_BYTES: "200",
      ATTACHMENT_STORE_MAX_BYTES: "300",
      ATTACHMENT_RETENTION_HOURS: "6",
      CHAT_OUTPUT_MAX_CHARS: "400",
      CODEX_STDERR_MAX_BYTES: "500",
      RUN_LOG_MAX_COMMANDS: "7",
      RUN_LOG_MAX_BYTES: "600",
      RUN_DIFF_MAX_CHARS: "700",
      LOG_ENTRY_MAX_BYTES: "800",
      LOG_FILE_MAX_BYTES: "900",
      LOG_FILE_MAX_FILES: "5",
      JOB_RETENTION_COUNT: "10",
      OUTBOX_RETENTION_COUNT: "11",
    });

    expect(config).toMatchObject({
      codexMaxConcurrentRuns: 4,
      bridgeMaxPendingMessages: 12,
      bridgeMaxPendingMessagesPerChat: 3,
      attachmentMaxCount: 2,
      attachmentMaxFileBytes: 100,
      attachmentMaxTotalBytes: 200,
      attachmentStoreMaxBytes: 300,
      attachmentRetentionHours: 6,
      chatOutputMaxChars: 400,
      codexStderrMaxBytes: 500,
      runLogMaxCommands: 7,
      runLogMaxBytes: 600,
      runDiffMaxChars: 700,
      logEntryMaxBytes: 800,
      logFileMaxBytes: 900,
      logFileMaxFiles: 5,
      jobRetentionCount: 10,
      outboxRetentionCount: 11,
    });
  });

  test("defaults to direct messages on and group messages off", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: "/tmp/chat2codex",
      CHAT2CODEX_HOME: "/tmp/chat2codex-home",
    });

    expect(config.access).toEqual({
      allowDirectMessages: true,
      allowGroups: false,
      allowedChatIds: [],
      allowedUserIds: [],
    });
    expect(config.attachmentDownloadDir).toBe("/tmp/chat2codex-home/attachments");
    expect(config.bridgeStatePath).toBe("/tmp/chat2codex-home/state.json");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.codexRunTimeoutMs).toBe(0);
    expect(config.codexApprovalTimeoutMs).toBe(0);
    expect(config.codexGroupAllowedRoots).toEqual(["/tmp/chat2codex"]);
  });

  test("parses optional run and approval timeouts", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: "/tmp/chat2codex",
      CODEX_RUN_TIMEOUT_MS: "120000",
      CODEX_APPROVAL_TIMEOUT_MS: "30000",
    });

    expect(config.codexRunTimeoutMs).toBe(120_000);
    expect(config.codexApprovalTimeoutMs).toBe(30_000);
  });

  test("rejects invalid timeout values", () => {
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: "/tmp/chat2codex",
        CODEX_RUN_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: "/tmp/chat2codex",
        CODEX_APPROVAL_TIMEOUT_MS: "1.5",
      }),
    ).toThrow();
  });

  test("rejects invalid resource and retention limits", () => {
    const keys = [
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
    ] as const;
    const invalidValues = ["invalid", "0", "-1", "1.5", String(Number.MAX_SAFE_INTEGER)];

    for (const key of keys) {
      for (const value of invalidValues) {
        expect(() =>
          loadConfig({
            FEISHU_APP_ID: "cli_test",
            FEISHU_APP_SECRET: "secret",
            [key]: value,
          }),
        ).toThrow();
      }
    }
  });

  test("rejects inconsistent aggregate limits", () => {
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        BRIDGE_MAX_PENDING_MESSAGES: "4",
        BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT: "5",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        ATTACHMENT_MAX_FILE_BYTES: "201",
        ATTACHMENT_MAX_TOTAL_BYTES: "200",
        ATTACHMENT_STORE_MAX_BYTES: "300",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        ATTACHMENT_MAX_FILE_BYTES: "100",
        ATTACHMENT_MAX_TOTAL_BYTES: "301",
        ATTACHMENT_STORE_MAX_BYTES: "300",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        LOG_ENTRY_MAX_BYTES: "901",
        LOG_FILE_MAX_BYTES: "900",
      }),
    ).toThrow();
  });

  test("rejects the approval policy removed by Codex 0.144.5", () => {
    expect(() =>
      loadConfig({
        FEISHU_APP_ID: "cli_test",
        FEISHU_APP_SECRET: "secret",
        CODEX_WORKDIR: "/tmp/chat2codex",
        CODEX_APPROVAL_POLICY: "on-failure",
      }),
    ).toThrow();
  });
});
