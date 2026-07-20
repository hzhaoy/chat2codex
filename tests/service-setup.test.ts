import { describe, expect, test } from "bun:test";

import {
  createServiceOptions,
  defaultServiceTarget,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitPath,
} from "../src/setup/service.js";

describe("service setup", () => {
  test("renders a launchd plist for the built Node entrypoint", () => {
    const options = createServiceOptions({
      target: "launchd",
      projectDir: "/tmp/chat&codex",
      envFile: "/tmp/chat&codex/.env",
      nodeBin: "/opt/node/bin/node",
      pathEnv: "/opt/node/bin:/usr/bin",
      launchdLabel: "com.example.chat2codex",
      stderrPath: "/tmp/chat&codex/runtime.log",
    });

    const plist = renderLaunchdPlist(options);

    expect(plist).toContain("<string>com.example.chat2codex</string>");
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex/dist/index.js</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex</string>");
    expect(plist).toContain("<key>CHAT2CODEX_ENV</key>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex/.env</string>");
    expect(plist).toContain("<key>CHAT2CODEX_LOG_FILE</key>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex/runtime.log</string>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/node/bin:/usr/bin</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist.match(/<string>\/dev\/null<\/string>/gu)).toHaveLength(2);
    expect(options.stdoutPath).toEndWith("/.chat2codex/.data/logs/chat2codex.out.log");
    expect(options.stderrPath).toBe("/tmp/chat&codex/runtime.log");
  });

  test("renders a systemd user unit with quoted paths and env file", () => {
    const options = createServiceOptions({
      target: "systemd",
      projectDir: "/tmp/chat 2 codex",
      envFile: "/tmp/chat 2 codex/.env",
      nodeBin: "/usr/local/bin/node",
      pathEnv: "/usr/local/bin:/usr/bin",
      systemdServiceName: "chat2codex-test.service",
    });

    const unit = renderSystemdUnit(options);

    expect(unit).toContain('WorkingDirectory="/tmp/chat 2 codex"');
    expect(unit).toContain('Environment="NODE_ENV=production"');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(unit).toContain('EnvironmentFile=-"/tmp/chat 2 codex/.env"');
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/tmp/chat 2 codex/dist/index.js"');
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("CHAT2CODEX_LOG_FILE");
    expect(systemdUnitPath("chat2codex-test.service")).toEndWith(
      "/.config/systemd/user/chat2codex-test.service",
    );
  });

  test("chooses launchd only on macOS by default", () => {
    expect(defaultServiceTarget("darwin")).toBe("launchd");
    expect(defaultServiceTarget("linux")).toBe("systemd");
  });
});
