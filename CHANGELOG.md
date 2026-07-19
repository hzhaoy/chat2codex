# Changelog

All notable changes to Chat2Codex will be documented in this file.

This project follows the spirit of Keep a Changelog and uses semantic version
numbers once releases are published.

## Unreleased

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
