# Changelog

All notable changes to Chat2Codex will be documented in this file.

This project follows the spirit of Keep a Changelog and uses semantic version
numbers once releases are published.

## Unreleased

## 0.8.0 - 2026-07-29

### Added

- Native personal-Weixin ClawBot adapter using the iLink HTTP protocol, QR
  setup, durable long-poll cursors, typing indicators, and encrypted inbound
  image/file downloads without installing OpenClaw.
- `CHAT2CODEX_ADAPTER=feishu|weixin`,
  `WEIXIN_CREDENTIALS_PATH`, `chat2codex setup weixin`, and adapter-aware
  doctor checks.
- Sender-bound text fallbacks for approvals, additional permissions, and MCP
  URL decisions through `/approve`, `/permit`, and `/mcp-decide`.

### Changed

- `CodexRunner`, `MessageRouter`, state, `AdapterSupervisor`, and `ChatSender`
  construction now live in a common composition root instead of the Feishu
  adapter.

### Security

- Weixin credentials and runtime protocol state use owner-only files; secret
  tokens and context values stay out of `.env` and logs. Weixin v1 rejects
  groups and unsupported media, while text decisions are bound to the original
  conversation, stable sender identity, request, and expiry lifecycle.

## 0.7.0 - 2026-07-23

### Added

- A platform-neutral adapter contract now covers inbound messages and actions,
  attachments, actor identities, view models, delivery handles, and adapter
  capabilities. A compile-only reference adapter protects this extension API.
- `AdapterSupervisor` owns adapter lifecycle and routes events, view delivery,
  updates, and attachment access strictly by `adapterId`. One adapter may fail
  to start without stopping other ready adapters.
- Persisted state now uses a versioned adapter-partitioned envelope. Existing
  v0.6 state migrates into the Feishu/Lark partition and receives a private
  one-time backup before the first v0.7 write.

### Changed

- The ingress `MessageRouter` is now a thin facade over `BridgeRunner`, which
  owns Codex execution, durable queues, approvals, and recovery.
- Feishu/Lark transport, event adaptation, cards, action callbacks, and posts
  now live under an independent adapter. The production startup path registers
  it through the adapter supervisor.
- Core action handling returns platform-neutral toast or replacement-view
  responses; the Feishu adapter alone renders Lark callback payloads.
- Ordinary runs now use a platform-neutral processing reaction and throttled
  text progress instead of mutating a run-status card. New runs expose `/stop`
  as their stopping control; failures replace the processing reaction with a
  failure reaction, while approval and structured-input cards remain
  interactive.

### Security

- Architecture tests reject platform SDK or adapter imports from `src/core`.
  Interactive callback disclosure checks are injected as an adapter policy,
  so forged decisions remain fail-closed without coupling core to card code.
- Actor identity comparisons use typed identity keys, and reusable Codex
  sessions include their adapter partition in the session scope.

## 0.6.0 - 2026-07-21

### Added

- `/fork --turn <history-index|turn_id>` now creates a non-destructive fork at a
  selected non-running turn through `thread/fork.lastTurnId`. The source thread
  and local files remain unchanged.
- `/help` provides a compact mobile command guide, and `/retry` reruns the most
  recent in-memory task for the same chat and original sender without depending
  on an interactive-card callback.
- `/usage` shows the latest turn and cumulative thread token usage plus context
  window occupancy when the active Codex provider emits usage notifications.
- `/archive`, `/archived`, and `/unarchive` provide a mobile archive workflow
  without deleting thread history or changing local files.
- `/service status|logs|restart` exposes bridge health, bounded recent logs, and
  supervisor-backed graceful restart from the mobile chat.

### Fixed

- Historical-turn fork intent and results are persisted around the external
  app-server call. Delivery retries and bridge restarts replay the known result
  without creating another thread, and later chat session choices are not
  overwritten during recovery.
- Archive and unarchive intent/results use the same fail-closed recovery rule:
  known results are redelivered without repeating the external mutation, while
  uncertain outcomes are never replayed automatically.
- The transitive `protobufjs` dependency is pinned to the patched 7.6.5 release
  so the Lark SDK cannot resolve to versions affected by CVE-2026-59877.

### Security

- Historical-turn forks fail closed before sending `thread/fork` unless the
  running app-server version exactly matches the bundled protocol snapshot,
  including prerelease and build metadata.
- Text and card retries are bound to the original task sender. Exact retry
  prompts stay in process memory and are unavailable after a bridge restart.
- Service logs and restart require a direct message from an explicitly
  allowlisted user. Restart is disabled unless the installed launchd/systemd
  unit marks the process as supervisor-managed, and it refuses while work is
  running or queued.

## 0.5.0 - 2026-07-20

### Added

- `/plan <task>` now runs one turn with the app-server Plan collaboration mode,
  making Codex `request_user_input` available without leaving later ordinary
  messages in Plan mode.
- Codex `item/tool/requestUserInput` requests can now pause a turn for
  sender-bound Feishu/Lark card answers or an explicit
  `/answer <reply-code> <value>` text reply. Multi-question requests support
  option selection, free-form answers, skip, cancel, and server-side validation.
- Standard MCP form and URL elicitations now use sender-bound Feishu/Lark cards.
  Typed form fields support
  `/mcp-answer <reply-code> <JSON-quoted-field-id> <value>` and are revalidated
  against the original schema before submission.
- Codex `item/permissions/requestApproval` requests now use complete-profile
  approval cards with deny, turn-scoped grant, and session-scoped grant
  decisions.
- Codex runs now persist a durable job and terminal-reply outbox. A reply-send
  failure retries the stored delivery with a stable idempotency key instead of
  executing the Codex turn again; runs interrupted by a bridge restart are
  reported for manual inspection rather than replayed automatically.
- Consecutive turns in the same chat/thread scope now reuse one Codex app-server
  process, preserving session-scoped grants until the sender, cwd, thread,
  policy, or session epoch changes. Idle TTL and LRU session-cap settings bound
  the resident process pool.

### Changed

- Added configurable global Codex concurrency and global/per-chat durable queue
  limits. Admission counts active jobs, undelivered replies, and pending control
  messages; tasks that exceed a limit are rejected before Codex runs, while
  in-turn approval/input waits share the same pending-count ceilings.
- Restart recovery replays read-only control commands, but does not replay
  mutating or run-targeted controls such as `/new`, `/stop`, or `/steer` onto a
  different task. Previously non-Codex messages cannot be promoted into a Codex
  run solely because access or routing configuration changed during restart.
- Added attachment count, per-file, per-message, and store quotas with streamed
  downloads, atomic finalization, and lazy retention cleanup.
- Bounded chat replies, Codex stderr, captured command count/output, run diffs,
  and structured log entries. File logs now rotate by configured size/count.
- Terminal jobs and delivered outbox records now use configurable count-based
  retention while active jobs and undelivered replies remain protected.
- `SIGINT` and `SIGTERM` now stop the Lark connection and all reusable,
  single-use, and transient Codex children before releasing the instance lock;
  queued durable jobs remain available for restart recovery.

### Fixed

- Reusable sessions now restart once when an app-server exits before the next
  turn is submitted, closing an idle-process exit race without replaying turns
  that may already have started.

### Security

- Secret `requestUserInput` questions fail closed because ordinary chat
  messages cannot provide a non-persistent masked-input channel. User-input
  request fields are bounded, withdrawn requests suppress late callbacks, and
  answers are neither echoed in terminal cards nor retained in bridge state.
- `requestUserInput` and MCP text answers bypass durable message/job storage and
  are not echoed by the bridge. Secret or sensitive fields fail closed.
- Additional-permission grants accept only `grantTurn` or `grantSession` and
  always clone the runner's original requested profile; card payloads cannot
  substitute permissions or enable `strictAutoReview`. Permission and MCP card
  callbacks are bound to the original sender and card message, and late or
  malformed actions fail closed.
- Reusable sessions are keyed by stable sender identity and canonical execution
  scope. Thread ownership is exclusive, late turn/request events are generation
  checked, and messages without a stable sender identity fall back to a
  single-turn process so they cannot inherit session grants.

## 0.4.1 - 2026-07-19

### Changed

- GitHub Releases now use the matching `CHANGELOG.md` version section for
  structured Added, Changed, and Fixed notes while retaining the full compare
  link.
- `chat2codex doctor` now compares the detected Codex CLI version with the
  bundled app-server protocol snapshot and warns when compatibility needs to be
  verified with smoke tests.
- Replaced the deprecated rollback roadmap item with non-destructive
  fork-from-history-turn guidance and updated the security support policy for
  versioned releases.

### Fixed

- Unknown app-server server requests now return a method-not-found error, while
  malformed approval requests fail closed without exposing or inventing an
  approval option; MCP elicitations and additional-permission requests receive
  explicit safe cancellation/denial responses.
- Approval cards now disclose additional permissions and exact exec/network
  policy rules, suppressing allow actions whenever security details cannot be
  rendered completely. File-change requests without target/patch disclosure are
  limited to decline/cancel, and card callbacks recheck the same decision filter
  server-side.
- Approval callbacks now fail closed for synchronous and asynchronous errors,
  and each request receives a globally unique internal card key so concurrent
  app-server connections cannot collide on reused JSON-RPC ids.

## 0.4.0 - 2026-07-17

### Added

- New chat commands: `/history`, `/search <term>`, `/fork`, and `/compact` for
  inspecting, finding, branching, and compacting Codex app-server threads from
  chat.
- Durable pending-message inbox with restart replay, plus canonical-workspace
  scheduling so two chats cannot run Codex concurrently in the same repo.

### Changed

- Refreshed the bundled app-server schema for Codex CLI 0.144.5 and moved
  history detail reads to the implemented `thread/turns/list` full-items path.
- Direct and group execution now require explicit sender/chat authorization;
  QR setup automatically allowlists the scanning user's `open_id`.
- Group `/whoami` replies now omit sender identifiers; direct-message replies
  still expose the available ids needed for allowlist setup.

### Fixed

- Removed bridge and chat-platform credentials from Codex child environments.
- Serialized atomic JSON state writes and restricted state/attachment storage
  created by Chat2Codex to owner-only permissions; startup now enforces one
  bridge process per state file.
- Scoped diagnostics per chat, rejected group-root symlink escapes, and delayed
  processed-message marking until handling and reply delivery succeed.
- Made workspace-waiting runs visible and cancellable, and bound queued runs to
  the workspace/thread snapshot they were accepted for.
- Distinguished a deleted session cwd from a missing `CODEX_BIN`; affected chats
  now fall back to the configured default cwd when possible and ask users to
  resend the task.
- Launchd services now receive the selected `CHAT2CODEX_ENV` explicitly and use
  `~/.chat2codex/.data/logs` by default, including services run from a source
  checkout.

## 0.3.0 - 2026-07-06

### Added

- Completed run cards now include compact run results and detail buttons for
  summary, changed files, diff, and command logs.
- New chat commands: `/summary`, `/files`, `/diff`, `/logs`, `/host`/`/health`,
  and `/steer <instruction>`.
- `chat2codex doctor` and `/host` now surface mobile/team-bot safety warnings.

## 0.2.0 - 2026-07-02

### Added

- Operational `/status` details for queue depth, active run age, approval wait
  age, and recent failures.
- Configurable run and approval timeouts for long-running team bot deployments.

## 0.1.1 - 2026-07-02

### Added

- npm-friendly CLI commands for setup, init, doctor, app-server smoke checks, and
  user service management.

## 0.1.0 - 2026-07-01

### Added

- Feishu/Lark long-connection adapter for running local Codex from chat.
- Per-chat Codex sessions, project selection, thread listing/resume, stop, retry,
  and status commands.
- Codex app-server progress, final output, and approval-card handling.
- Attachment download support for image and file messages.
- User-level launchd/systemd service setup.
- Local protocol snapshot and smoke tests for Codex app-server compatibility.
