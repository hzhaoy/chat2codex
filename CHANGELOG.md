# Changelog

All notable changes to Chat2Codex will be documented in this file.

This project follows the spirit of Keep a Changelog and uses semantic version
numbers once releases are published.

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
