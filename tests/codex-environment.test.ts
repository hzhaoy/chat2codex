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
  });
});
