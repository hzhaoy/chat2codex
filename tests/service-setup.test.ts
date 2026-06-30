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
      nodeBin: "/opt/node/bin/node",
      pathEnv: "/opt/node/bin:/usr/bin",
      launchdLabel: "com.example.chat2codex",
    });

    const plist = renderLaunchdPlist(options);

    expect(plist).toContain("<string>com.example.chat2codex</string>");
    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex/dist/index.js</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/tmp/chat&amp;codex</string>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/node/bin:/usr/bin</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  test("renders a systemd user unit with quoted paths and env file", () => {
    const options = createServiceOptions({
      target: "systemd",
      projectDir: "/tmp/chat 2 codex",
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
    expect(systemdUnitPath("chat2codex-test.service")).toEndWith(
      "/.config/systemd/user/chat2codex-test.service",
    );
  });

  test("chooses launchd only on macOS by default", () => {
    expect(defaultServiceTarget("darwin")).toBe("launchd");
    expect(defaultServiceTarget("linux")).toBe("systemd");
  });
});
