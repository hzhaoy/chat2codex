# Contributing

Thanks for helping improve Chat2Codex. This guide is for contributors working
from a source checkout, not for normal npm-installed usage.

## Prerequisites

- Node.js `>= 20.12.0`
- Bun `1.3.x`
- A local Codex CLI installation that is already logged in
- A Feishu/Lark app with bot messaging, long-connection events, and
  `card.action.trigger` enabled

Run the baseline checks first:

```bash
bun install
bun run check
```

`bun run check` runs TypeScript type checking, the Bun test suite, and the
production build.

## Source Checkout Setup

For source development, keep a project-local `.env` so you do not accidentally
debug against a globally installed `~/.chat2codex/.env` instance:

```bash
cp .env.example .env
```

Either let the setup flow write app credentials:

```bash
bun src/index.ts setup --env .env --workdir /absolute/path/to/a/test/repo
```

Or edit `.env` manually:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
LARK_DOMAIN=feishu
CODEX_WORKDIR=/absolute/path/to/a/test/repo
CODEX_BIN=/absolute/path/to/codex
BRIDGE_STATE_PATH=.data/state.json
ATTACHMENT_DOWNLOAD_DIR=.data/attachments
```

Use a disposable test repository for `CODEX_WORKDIR`. Live Feishu testing may
ask Codex to inspect or edit files.

Check the local configuration:

```bash
bun src/index.ts doctor --env .env
```

## Local Development Server

Start the bridge from source:

```bash
bun run dev
```

`bun run dev` is equivalent to `bun src/index.ts start --env .env`.

Avoid running two bridge processes for the same Feishu/Lark app. If a user
service or another terminal session is already running, stop it before starting
the source checkout. Otherwise one process may consume events while the other
appears idle.

Useful checks:

```bash
# Source checkout process
ps aux | grep '[c]hat2codex\|src/index.ts\|dist/index.js'

# If you installed the source checkout as a service
bun run service:uninstall

# If you installed the npm package as a user service
chat2codex service uninstall
```

On macOS, you can inspect a launchd service with:

```bash
launchctl print gui/$(id -u)/com.chat2codex.bridge
```

On Linux:

```bash
systemctl --user status chat2codex
```

## Live Feishu/Lark Debug Checklist

After `bun run dev` prints that the WebSocket client is ready, test in a direct
chat first:

```text
/whoami
/status
/host
```

Then run one short Codex task:

```text
Summarize this repository in one paragraph.
```

For runtime-control changes, also test a long-running turn and immediate
steering:

```text
Please wait 20 seconds, then inspect README.md and git status, and summarize the result.
```

Immediately send:

```text
/steer Keep the change minimal and do not create new files.
```

Expected behavior:

- `/steer` replies immediately, even while the first task is still starting.
- If the turn is not ready yet, the instruction is temporarily queued and sent
  automatically when steering becomes available.
- The completed card shows run details, and `/summary`, `/files`, `/diff`, and
  `/logs` return the latest captured run data when available.

## Live Weixin Debug Checklist

Automated protocol tests do not replace a real ClawBot acceptance pass. With a
Weixin account that has the ClawBot entry enabled, run
`chat2codex setup weixin`, then verify a text task, an image task, a file task,
`/approve`, `/permit`, `/mcp-decide`, `/stop`, and restart recovery. Confirm
that group and voice/video messages are dropped, typing is cancelled at the
end of a run, and the same task is not executed twice after a delivery retry.

## Local Validation

Run targeted tests while developing:

```bash
bun test tests/message-router.test.ts
bun test tests/codex-runner.test.ts
bun test tests/lark-card.test.ts
```

Run the full gate before opening a pull request:

```bash
bun run check
git diff --check
```

Use app-server smoke tests after changing Codex protocol wiring:

```bash
bun run smoke:app-server
bun run smoke:app-server:turn
bun run smoke:app-server:approval
```

The turn and approval smoke tests require a working local Codex login and may
start model-backed Codex turns.

When changing generated protocol snapshots:

```bash
bun run protocol:generate
git diff -- docs/codex-app-server-protocol
```

Review schema diffs before changing app-server handling.

## Common Startup Issues

- `chat2codex: command not found`: source contributors should use `bun run dev`
  or `bun src/index.ts ...`; the `chat2codex` command only exists after a global
  install or package-link setup.
- Bot receives no messages: check that only one bridge is running for the app,
  the app is in long-connection mode, and the bot has message event
  subscriptions.
- Card buttons do nothing: verify `card.action.trigger` is subscribed in the
  Feishu/Lark developer console.
- Attachments fail: verify the message resource/read permission used by the
  Feishu/Lark message resource API.
- Codex fails under a background service but works in your shell: set
  `CODEX_BIN` to an absolute path because launchd/systemd do not load
  interactive shell startup files.
- A group chat does not respond: group messages must mention the bot, and the
  chat must be enabled with `ALLOW_GROUPS=true` plus `ALLOWED_CHAT_IDS`.

## Pull Requests

- Keep changes focused and reversible.
- Add or update tests for behavior changes.
- Update README, `CONTRIBUTING.md`, or `.env.example` when configuration,
  startup, or developer workflow changes.
- Do not commit `.env`, `.data/`, `dist/`, `node_modules/`, logs, downloaded
  attachments, local chat ids, Feishu/Lark secrets, or Codex tokens.
- Run `bun run check` before opening a pull request.

## Commit Messages

Use concise Conventional Commit subjects when possible, for example:

```text
fix: restrict group chat project roots
docs: add security deployment guidance
```
