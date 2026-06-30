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
  });

  test("defaults to direct messages on and group messages off", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      CODEX_WORKDIR: "/tmp/chat2codex",
    });

    expect(config.access).toEqual({
      allowDirectMessages: true,
      allowGroups: false,
      allowedChatIds: [],
      allowedUserIds: [],
    });
    expect(config.attachmentDownloadDir).toMatch(/\.data\/attachments$/u);
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.codexGroupAllowedRoots).toEqual(["/tmp/chat2codex"]);
  });
});
