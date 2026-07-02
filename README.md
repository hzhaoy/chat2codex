# Chat2Codex

[English](README.md) | [简体中文](README.zh-CN.md)

Run Codex on your own machine from Feishu/Lark chat.

Chat2Codex turns a Feishu/Lark bot into a message platform for the local Codex
CLI. Send prompts, files, and images from chat; receive Codex progress and final
answers; approve Codex actions with cards; and resume local Codex threads
without exposing a public webhook server.

## Current Status

- The shipped adapter is Feishu/Lark long connection. Slack, Discord, and other
  adapters are roadmap items.
- Direct messages are enabled by default and can switch to any local directory.
- Group chats are disabled by default, must be explicitly allowlisted, and can
  be constrained to `CODEX_GROUP_ALLOWED_ROOTS`.
- The Codex app-server protocol is experimental. Run the smoke tests in
  [Codex App-Server Guardrails](#codex-app-server-guardrails) after Codex CLI
  upgrades.

## Quick Start

### Prerequisites

- Node.js `>= 20.12.0`
- npm for installing the package.
- Codex CLI installed and logged in on the machine running this bridge.
- A Feishu/Lark account that can create an app, or an existing Feishu/Lark app
  with bot enabled.
- The app needs message receive/send/resource permissions, long-connection
  event subscriptions for message events, and the `card.action.trigger`
  callback.

### Install And Run

```bash
npm install -g chat2codex
```

Create and connect a Feishu/Lark app automatically by scanning a QR code:

```bash
chat2codex setup --workdir /absolute/path/to/your/repo
```

The setup command renders a terminal QR code and keeps the authorization URL as
a fallback. Scan it with Feishu/Lark, confirm the app creation, and it writes
`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `LARK_DOMAIN` to
`~/.chat2codex/.env`. You can still run
`chat2codex init --workdir /absolute/path/to/your/repo` and edit that env file
manually if you already have an app.

Check the local setup, then start the bridge:

```bash
chat2codex doctor
chat2codex start
```

Send a DM to the bot:

```text
/status
Summarize this repository.
```

You can also send a file or image. Chat2Codex downloads supported attachments
under `ATTACHMENT_DOWNLOAD_DIR` and appends their local paths to the Codex
prompt. If the message contains only an attachment, it uses a default prompt
asking Codex to inspect that file or image.

During a run, Chat2Codex sends a status card, updates that card at most once
every 15 seconds, and sends the final Codex response as a rendered rich-text
post. Click the card's stop button or send `/stop` to abort the active run.
Failed and stopped cards include a retry button for re-running the same prompt.
If card creation or updates fail, it falls back to text progress replies.

### CLI Commands

| Command | Effect |
| --- | --- |
| `chat2codex` / `chat2codex start` | Start the Feishu/Lark bridge. |
| `chat2codex setup --workdir <path>` | Create/connect a Feishu/Lark app and write `.env`. |
| `chat2codex init --workdir <path>` | Create a starter `.env` when you already have an app. |
| `chat2codex doctor` | Check `.env`, Node.js, Codex CLI, and workspace paths. |
| `chat2codex smoke [--mode turn\|approval]` | Verify the Codex app-server protocol locally. |
| `chat2codex service print\|install\|uninstall` | Manage a user-level launchd/systemd service. |

By default, Chat2Codex stores configuration and runtime state under
`~/.chat2codex`. Set `CHAT2CODEX_HOME=/path/to/home` or pass `--env /path/to/.env`
when you need a separate bot instance.

## Features

- Feishu/Lark long-connection bot, no public webhook server required.
- One Codex session per chat.
- `/status`, `/projects`, `/project <index|path>`, `/threads`, `/resume`,
  `/new`, `/cd <path>`, `/stop`, and `/whoami` commands.
- Local state in JSON.
- Codex app-server JSON-RPC for machine-readable progress, final output, and
  approval callbacks.
- Throttled run-status card updates while Codex is running, with stop/retry
  buttons and text fallback.
- Feishu/Lark approval cards for Codex command/file-change approval requests.
  Buttons are generated from Codex's current approval decisions, including
  Approve, Approve session, Deny, and Cancel turn when those options are
  offered.
- Feishu/Lark image and file messages downloaded to local paths and passed to
  Codex with the prompt.
- Event diagnostics in logs and `/status` for recent routed/dropped messages.
- Team-bot friendly error summaries when Codex fails or cannot start.
- Final Codex replies rendered as Feishu/Lark rich-text posts.
- User-level launchd/systemd setup for long-running team deployments.

## Project Docs

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Codex app-server protocol snapshot](docs/codex-app-server-protocol/)

## Codex App-Server Guardrails

Chat2Codex uses the experimental `codex app-server --stdio` protocol for
thread control, progress events, and approval callbacks. After installing or
upgrading Codex CLI, run the fast local smoke test:

```bash
chat2codex smoke
```

This validates `initialize` and `thread/start` against a temporary workspace
without starting a model turn. To verify a full model-backed turn as well:

```bash
chat2codex smoke --mode turn
```

To verify a real command-approval request, run:

```bash
chat2codex smoke --mode approval
```

That mode uses a temporary workspace, `approvalPolicy=untrusted`, and
`sandbox=workspace-write`. It prompts Codex to create `approval-smoke.txt`,
requires the app-server to emit `item/commandExecution/requestApproval`, returns
`accept`, waits for `turn/completed`, and checks the file content.

The current generated protocol snapshot lives under
[`docs/codex-app-server-protocol`](docs/codex-app-server-protocol/). Refresh it
after Codex CLI upgrades:

```bash
bun run protocol:generate
git diff -- docs/codex-app-server-protocol
```

Review schema diffs before changing
[`src/agent/codex-runner.ts`](src/agent/codex-runner.ts); approval behavior
should fail closed if the app-server request shape is unknown.

When `CODEX_APPROVAL_POLICY` allows interactive approvals, Codex app-server
emits approval requests while a turn is running. Chat2Codex posts a separate
approval card to the same chat and pauses Codex until an authorized user clicks
one of the options. The card buttons mirror Codex's `availableDecisions` for
command execution requests; file-change approval cards use Codex's file-change
decision set.

Apps created with the current `chat2codex setup` flow include that callback.
If you created the Feishu/Lark app before status-card actions were added,
manually subscribe the `card.action.trigger` callback in the developer console
so the stop button can reach this bridge over the long connection.

If you created the app before attachment support was added, also grant the
message resource/read permission used by Feishu/Lark's
`im.v1.messageResource.get` API; otherwise attachment downloads will fail even
though text messages still work.

Group messages are ignored unless they explicitly mention the bot. To enable a
group chat, first send `@Chat2Codex /whoami` in that chat and copy the reported
`chat_id`. Then set:

```env
ALLOW_GROUPS=true
ALLOWED_CHAT_IDS=oc_xxx
```

## Team Bot Deployment

For a team group, keep the bot allowlisted and run it as a user-level background
service instead of leaving `chat2codex start` in a terminal.

1. In the target group, send `@Chat2Codex /whoami` and copy the reported
   `chat_id`.
2. Update `~/.chat2codex/.env`:

   ```env
   ALLOW_GROUPS=true
   ALLOWED_CHAT_IDS=oc_xxx
   ALLOWED_USER_IDS=ou_xxx,ou_yyy
   CODEX_WORKDIR=/absolute/path/to/your/repo
   CODEX_GROUP_ALLOWED_ROOTS=/absolute/path/to/your/repo,/absolute/path/to/team/repos
   CODEX_BIN=/absolute/path/to/codex
   CODEX_APPROVAL_POLICY=on-request
   ATTACHMENT_DOWNLOAD_DIR=/absolute/path/to/chat2codex-attachments
   ```

   `CODEX_BIN` should be absolute for background services because launchd and
   systemd do not load your interactive shell startup files.
   Use `CODEX_APPROVAL_POLICY=never` for unattended bots that should never wait
   for a Feishu/Lark approval click.

3. Preview the service file:

   ```bash
   chat2codex service print
   ```

4. Install the user service:

   ```bash
   chat2codex service install
   ```

   On macOS this installs a launchd agent named `com.chat2codex.bridge`. On
   Linux this installs a systemd user service named `chat2codex.service`.

Useful service commands:

```bash
# macOS status and logs
launchctl print gui/$(id -u)/com.chat2codex.bridge
tail -f .data/logs/chat2codex.out.log .data/logs/chat2codex.err.log

# Linux status and logs
systemctl --user status chat2codex
journalctl --user -u chat2codex -f

# Uninstall the user service
chat2codex service uninstall
```

## Chat Commands

| Command | Effect |
| --- | --- |
| `/status` | Show current chat session, cwd, attachment directory, and recent event diagnostics. |
| `/projects` | List projects discovered from Codex app-server threads, grouped by cwd. |
| `/project <index\|path>` | Enter a listed project by number, or switch to a directory path, and start with no selected thread. |
| `/threads` | List recent Codex conversations for the current project. `/sessions` is an alias. |
| `/resume <index\|thread_id>` | Continue a listed conversation by number, or load one directly by Codex thread id. |
| `/new` | Start a fresh Codex conversation in the current project. |
| `/cd <path>` | Change the current chat cwd and start a fresh Codex thread. |
| `/stop` | Stop the active Codex run for the current chat. The running status card also has a stop button. |
| `/whoami` | Show the current `chat_id`, chat type, sender ids, and access decision. |

## Safety Defaults

Chat2Codex defaults to `CODEX_SANDBOX=workspace-write`, so Codex can edit inside the selected workspace. Use `read-only` for safer Q&A-only bots.

It defaults to `CODEX_APPROVAL_POLICY=never` for unattended operation. Set
`CODEX_APPROVAL_POLICY=on-request` or `untrusted` when you want Codex approval
requests to appear as Feishu/Lark cards. In group chats, approval buttons can
only be handled by users listed in `ALLOWED_USER_IDS`.

Direct messages are enabled by default. Group messages must mention the bot,
and group chats are disabled by default until enabled with `ALLOW_GROUPS=true`
plus `ALLOWED_CHAT_IDS`. You can also set `ALLOWED_USER_IDS` to a
comma-separated list of sender `open_id`, `user_id`, or `union_id` values.
Direct messages can switch to any local directory. Group chats are constrained
to `CODEX_GROUP_ALLOWED_ROOTS`, or to `CODEX_WORKDIR` when that list is empty.

Do not run this bot in a group with untrusted people while using broad filesystem access. A chat bot that can drive a local coding agent is effectively a remote control surface for your machine.

## Runtime Shape

The npm package runs the built Node.js ESM entrypoint. For local development from
a source checkout, use Bun:

```bash
bun install
bun run dev
```

Use `bun run start:bun` only after validating the Feishu SDK long-connection path in your environment.

Chat2Codex is an unofficial project and is not affiliated with OpenAI.

## Testing

```bash
bun run check
```

This runs TypeScript type checking, the Bun test suite, and the production
build. Use `bun audit` to check the Bun dependency lockfile.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and pull request
guidance. See [SECURITY.md](SECURITY.md) before running Chat2Codex in a shared
chat or reporting a security issue.

## Next Features To Add

1. Richer `/status` output for queue depth, active run age, approval wait age, and recent failures.
2. Configurable run and approval timeouts for long-running team bots.
3. Advanced thread controls beyond start/resume/reset, such as history, compact, fork, and rollback after app-server support is verified.
4. A chat-adapter boundary before adding Slack, Discord, or other platforms.
