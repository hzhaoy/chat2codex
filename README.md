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
- Direct-message routing is enabled by default, but every sender or direct chat
  must be explicitly allowlisted except for `/whoami` discovery.
- Group chats are disabled by default and require both chat and sender
  allowlists. They can be constrained to `CODEX_GROUP_ALLOWED_ROOTS`.
- The Codex app-server protocol is experimental. Run `chat2codex doctor` and
  the checks in [Codex App-Server Guardrails](#codex-app-server-guardrails)
  after installing or upgrading Codex CLI.

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
`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `LARK_DOMAIN`, and the scanning user's
`open_id` in `ALLOWED_USER_IDS` to
`~/.chat2codex/.env`. You can still run
`chat2codex init --workdir /absolute/path/to/your/repo` and edit that env file
manually if you already have an app. After the first start, `/whoami` remains
available for discovering ids that need to be allowlisted.

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
Completed cards include a compact run result and detail buttons for summary,
changed files, diff, and command logs. The same details are available with
`/summary`, `/files`, `/diff`, and `/logs`.
If card creation or updates fail, it falls back to text progress replies.

### CLI Commands

| Command | Effect |
| --- | --- |
| `chat2codex` / `chat2codex start` | Start the Feishu/Lark bridge. |
| `chat2codex setup --workdir <path>` | Create/connect a Feishu/Lark app and write `.env`. |
| `chat2codex init --workdir <path>` | Create a starter `.env` when you already have an app. |
| `chat2codex doctor` | Check `.env`, Node.js, Codex CLI and protocol-snapshot versions, workspace paths, and mobile/team-bot safety warnings. |
| `chat2codex smoke [--mode turn\|approval]` | Verify the Codex app-server protocol locally. |
| `chat2codex service print\|install\|uninstall` | Manage a user-level launchd/systemd service. |

By default, Chat2Codex stores configuration and runtime state under
`~/.chat2codex`. Set `CHAT2CODEX_HOME=/path/to/home` or pass `--env /path/to/.env`
when you need a separate bot instance.

## Features

- Feishu/Lark long-connection bot, no public webhook server required.
- One reusable Codex app-server session per chat/thread scope. Consecutive turns
  keep the same process—and therefore session-scoped grants—while the sender,
  cwd, thread, policy, and session epoch remain unchanged.
- `/status`, `/host`, `/projects`, `/project <index|path>`, `/threads`,
  `/history`, `/search`, `/resume`, `/fork`, `/compact`, `/plan <task>`, `/new`,
  `/cd <path>`,
  `/stop`, `/steer`, `/answer`, `/mcp-answer`, `/summary`, `/files`, `/diff`,
  `/logs`, and `/whoami` commands.
- Local state in JSON.
- Codex app-server JSON-RPC for machine-readable progress, final output, and
  approval callbacks.
- Throttled run-status card updates while Codex is running, with stop/retry
  buttons, completed-run detail buttons, and text fallback.
- Feishu/Lark approval cards for Codex command/file-change approval requests.
  Buttons are generated from Codex's current approval decisions, including
  Approve, Approve session, Deny, and Cancel turn when those options are
  offered.
- `/plan <task>` runs one turn in Codex Plan mode. Structured Codex
  `requestUserInput` questions are rendered as sender-bound cards,
  with an explicit `/answer <reply-code> <value>` fallback for free-form input.
  Options are validated against the original request; secret questions fail
  closed instead of collecting credentials through chat history.
- Standard MCP form and URL elicitations rendered as sender-bound cards. Typed
  form fields can also use
  `/mcp-answer <reply-code> <JSON-quoted-field-id> <value>`; values are validated
  against the original schema, while sensitive fields fail closed.
- Additional-permission requests from `item/permissions/requestApproval`
  rendered as complete-profile approval cards. Chat2Codex exposes only deny,
  turn-scoped grant, and session-scoped grant; a grant always returns the
  original profile requested by Codex.
- Feishu/Lark image and file messages downloaded to local paths and passed to
  Codex with the prompt.
- Event diagnostics in logs and `/status` for recent routed/dropped messages.
- Operational `/status` details for queue depth, active run age, approval wait
  age, and recent failures.
- `/host` health card for the bridge host, Codex binary, default cwd, queue,
  active run count, approval wait count, and mobile/team-bot safety warnings.
- Runtime steering with `/steer <instruction>` for sending follow-up guidance to
  the active Codex turn without waiting behind the chat queue.
- Search, history, fork, and compact controls for Codex app-server threads from
  chat, so mobile users can continue older work without returning to the host.
- Optional run and approval timeouts for unattended team bot deployments.
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
upgrading Codex CLI, first run:

```bash
chat2codex doctor
```

`doctor` compares the exact detected `codex --version` output with the Codex
version recorded in the bundled protocol snapshot. A mismatch, or a missing or
unreadable snapshot manifest, is a compatibility warning rather than a failed
doctor run. Treat it as unverified protocol compatibility and continue with the
fast local smoke test:

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
[`src/agent/codex-runner.ts`](src/agent/codex-runner.ts). Chat2Codex handles only
explicitly supported app-server server requests. Unknown methods return a
JSON-RPC method-not-found error; malformed approval requests return an
invalid-params error without exposing or inventing an approval option.
`item/tool/requestUserInput` is supported for `/plan <task>` turns through
cards and explicit `/answer` replies; request fields and callback answers are
revalidated, withdrawn requests reject late replies, and `isSecret` questions
fail closed because chat cannot guarantee masked input. Standard
`mcpServer/elicitation/request` form and
URL requests are supported through cards, with `/mcp-answer` for typed form
values. The bridge does not persist or echo `requestUserInput` or MCP answer
values, and sensitive form fields fail closed. The OpenAI-specific MCP form
extension is not negotiated.

`item/permissions/requestApproval` is also supported through a sender-bound
card that discloses the complete requested permission profile. The only bridge
decisions are `deny`, `grantTurn`, and `grantSession`. A grant clones the exact
original profile held by the runner; card payloads cannot replace permissions
or enable `strictAutoReview`. Malformed, incomplete, withdrawn, or undisplayable
requests fail closed.

When `CODEX_APPROVAL_POLICY` allows interactive approvals, Codex app-server
emits approval requests while a turn is running. Chat2Codex posts a separate
approval card to the same chat and pauses Codex until an authorized user clicks
one of the options. The card buttons mirror Codex's `availableDecisions` for
command execution requests. The current file-change approval request does not
include target files or patch details, so Chat2Codex exposes only decline/cancel
until those details can be correlated and rendered completely. If command
decisions are absent or `null`, the bridge likewise exposes only decline/cancel;
a malformed decision list is rejected as invalid params.
Cards disclose additional filesystem/network permissions and every exact
exec/network policy rule. If security-relevant details cannot be rendered
completely, allow actions are removed and only decline/cancel remain; the
message router enforces the same decision filter when processing card callbacks.

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

Group `/whoami` replies expose only `chat_id`, chat type, and the access
decision. Sender ids are intentionally omitted from group history; use a direct
message `/whoami` when an administrator needs the sender's available ids.

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
   CODEX_RUN_TIMEOUT_MS=1800000
   CODEX_APPROVAL_TIMEOUT_MS=300000
   ATTACHMENT_DOWNLOAD_DIR=/absolute/path/to/chat2codex-attachments
   ```

   `CODEX_BIN` should be absolute for background services because launchd and
   systemd do not load your interactive shell startup files.
   Use `CODEX_APPROVAL_POLICY=never` for unattended bots that should never wait
   for a Feishu/Lark approval click.
   Leave `CODEX_RUN_TIMEOUT_MS=0` and `CODEX_APPROVAL_TIMEOUT_MS=0` to disable
   automatic timeouts; set positive millisecond values when team bots should
   fail fast instead of waiting forever.

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
tail -f ~/.chat2codex/.data/logs/chat2codex.out.log ~/.chat2codex/.data/logs/chat2codex.err.log

# Linux status and logs
systemctl --user status chat2codex
journalctl --user -u chat2codex -f

# Uninstall the user service
chat2codex service uninstall
```

The default launchd log directory is `~/.chat2codex/.data/logs` for both npm
installs and source checkouts. Foreground development with `bun run dev` logs to
the terminal instead. File logging uses bounded entries and rotates according
to `LOG_FILE_MAX_BYTES` and `LOG_FILE_MAX_FILES`. A source checkout that
intentionally wants project-local service logs can override them explicitly:

```bash
bun src/index.ts service install --env .env --project-dir . \
  --stdout .data/logs/chat2codex.out.log \
  --stderr .data/logs/chat2codex.err.log
```

## Chat Commands

| Command | Effect |
| --- | --- |
| `/status` | Show current chat session, cwd, queue depth, active run age, approval wait age, recent failures, attachment directory, and recent event diagnostics. |
| `/host` | Send a Host health card with Codex CLI availability, service paths, queue/approval counts, and mobile/team-bot safety warnings. `/health` is an alias. |
| `/projects` | List projects discovered from Codex app-server threads, grouped by cwd. |
| `/project <index\|path>` | Enter a listed project by number, or switch to a directory path, and start with no selected thread. |
| `/threads` | List recent Codex conversations for the current project. `/sessions` is an alias. |
| `/history [index\|turn_id]` | Show recent turns for the current conversation; pass a listed number or turn id to show turn details. |
| `/search <term>` | Search Codex conversation history and save results for `/resume <index>` or `/fork <index>`. |
| `/resume <index\|thread_id>` | Continue a listed conversation by number, or load one directly by Codex thread id. |
| `/fork [index\|thread_id]` | Fork the current, listed, or specified Codex conversation and switch this chat to the new thread. |
| `/compact` | Request compaction for the current Codex conversation. |
| `/plan <task>` | Run one task in Codex Plan mode. Use this mode when Codex should call `request_user_input`; the next ordinary message returns to Default mode. |
| `/new` | Start a fresh Codex conversation in the current project. |
| `/cd <path>` | Change the current chat cwd and start a fresh Codex thread. |
| `/stop` | Stop the active Codex run for the current chat. The running status card also has a stop button. |
| `/steer <instruction>` | Send extra guidance to the active Codex run immediately, bypassing queued chat work. |
| `/answer <reply-code> <value>` | Answer the current non-secret Codex `requestUserInput` question. The reply code is shown on the question card; answers bypass queued chat work and are neither persisted nor echoed by the bridge. |
| `/mcp-answer <reply-code> <JSON-quoted-field-id> <value>` | Answer the current non-sensitive MCP form field using the exact command shown on its card. `/skip` skips an optional field; quote the value as `"/skip"` when that literal string is intended. Typed values are checked against the original schema; answers bypass queued chat work and are neither persisted nor echoed by the bridge. |
| `/summary` | Show the most recent run summary for this chat. |
| `/files` | Show changed files from the most recent run. |
| `/diff` | Show the latest captured diff from the most recent run. |
| `/logs` | Show command summaries and captured output previews from the most recent run. |
| `/whoami` | Show the current `chat_id`, chat type, and access decision; sender ids are included only in direct messages. |

## Safety Defaults

Chat2Codex defaults to `CODEX_SANDBOX=workspace-write`, so Codex can edit inside the selected workspace. Use `read-only` for safer Q&A-only bots.

It defaults to `CODEX_APPROVAL_POLICY=never` for unattended operation. Set
`CODEX_APPROVAL_POLICY=on-request` or `untrusted` when you want Codex approval
requests to appear as Feishu/Lark cards. In group chats, approval buttons can
only be handled by users listed in `ALLOWED_USER_IDS`.

`CODEX_RUN_TIMEOUT_MS=0` and `CODEX_APPROVAL_TIMEOUT_MS=0` disable automatic
timeouts. For long-running background bots, set positive millisecond values so a
stuck Codex turn or unattended approval request is cancelled and recorded in
`/status` as a recent failure with a recovery hint.

Key production resource paths are bounded by default and can be tuned with the
positive-integer settings in [`.env.example`](.env.example):
`CODEX_MAX_CONCURRENT_RUNS`, `CODEX_MAX_APP_SERVER_SESSIONS`, the global and per-chat
`BRIDGE_MAX_PENDING_MESSAGES` / `BRIDGE_MAX_PENDING_MESSAGES_PER_CHAT` limits,
which bound active jobs, undelivered durable replies, pending control messages,
and in-turn approval/input waits,
attachment count/file/message/store quotas plus `ATTACHMENT_RETENTION_HOURS`,
chat/stderr/run-log/diff output limits, log entry/file rotation limits, and
terminal job/delivered-outbox retention counts.
Active jobs and undelivered outbox entries are never removed by retention
pruning. Attachments are streamed into private temporary files, checked against
the configured quotas, atomically finalized, and lazily expired without
following symlinks.

Reusable app-server sessions are held only in memory. Idle sessions expire
after `CODEX_APP_SERVER_IDLE_TTL_MS` (15 minutes by default), and the least
recently used idle session is closed when `CODEX_MAX_APP_SERVER_SESSIONS` is
reached. Changing the sender identity, cwd, thread, policy, `/new` epoch, or
using `/fork`/`/compact` closes the old owner before another process can attach.
Messages without a stable sender id use a single-turn process and cannot inherit
session-scoped grants. A graceful `SIGINT`/`SIGTERM` closes the Lark connection
and all Codex children; queued durable work remains recoverable, while running
work is marked interrupted and is never replayed automatically.

`chat2codex doctor` and `/host` both surface mobile/team-bot safety warnings,
including relative `CODEX_BIN`, group chats without `ALLOWED_USER_IDS`,
disabled run/approval timeouts, and high-risk sandbox settings.

If a chat's selected cwd is deleted, an `ENOENT` startup failure is treated as
a missing workspace rather than a missing Codex binary. Chat2Codex clears the
selected thread, switches the chat back to `CODEX_WORKDIR` when that directory
is still allowed, and asks the user to resend the task. If the default cwd is
also unavailable, use `/cd <existing-directory>` before retrying.

Direct-message routing is enabled by default, but messages other than `/whoami`
must come from a sender in `ALLOWED_USER_IDS` or a direct chat in
`ALLOWED_CHAT_IDS`. Group messages must mention the bot and require all three:
`ALLOW_GROUPS=true`, an allowed chat, and a sender in `ALLOWED_USER_IDS`.
Authorized direct messages can switch to any local directory. Group chats are
constrained to canonical paths under `CODEX_GROUP_ALLOWED_ROOTS`, or under
`CODEX_WORKDIR` when that list is empty; symlinks cannot bypass the boundary.

Incoming events are persisted to a pending inbox before the long-connection
handler returns. Codex prompts also create durable jobs before execution. A
queued job can resume after restart; a job that had reached `running` is marked
interrupted and is not automatically executed again because its side effects
cannot be inferred safely. Terminal replies are delivered from a durable outbox
with stable idempotency keys, so a chat-delivery failure does not rerun Codex.
After restart, read-only control messages such as `/status` may be replayed;
mutating or run-targeted controls such as `/new`, `/stop`, and `/steer` are not
replayed onto another task. A message previously classified as non-Codex cannot
be promoted into a Codex run solely because access or routing configuration
changed during restart.
Codex runs targeting the same workspace are serialized across chats, while
different workspaces can run in parallel up to `CODEX_MAX_CONCURRENT_RUNS`;
global and per-chat queue admission is rejected before Codex starts when its
configured limit is reached. `/status` and `/stop` also cover runs waiting for a
workspace or global permit. Only one bridge process may use a given
`BRIDGE_STATE_PATH`. Keep approvals and Git review enabled for sensitive work,
and inspect the thread/worktree before manually retrying an interrupted job.

The instance lock is removed on normal shutdown. A `SIGKILL` or fatal runtime
crash can leave `<BRIDGE_STATE_PATH>.lock`; after confirming that no bridge
process is running, remove that lock directory before restarting. It is never
reclaimed automatically because doing so can race with another startup.

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

## Version Roadmap

1. **v0.5 (current Unreleased development):** the planned interaction and
   production-hardening scope is implemented: `requestUserInput`, standard MCP
   form/URL elicitation, additional-permission approval, durable job/outbox
   delivery, chat/thread app-server session reuse, bounded session/concurrency
   pools, graceful child-process shutdown, attachment quotas and expiry, output
   limits, state retention, and log rotation. This does not indicate a published
   v0.5 release.
2. **v0.6:** fork from a selected historical turn with
   `thread/fork.lastTurnId`, leaving the source thread unchanged. This is not a
   filesystem rollback and does not restore local file changes.
3. Later: introduce a chat-adapter boundary before adding Slack, Discord, or
   other platforms.
