# Security Policy

Chat2Codex turns chat messages into local Codex runs. Treat every enabled chat
as a remote-control surface for the machine running the bridge.

## Supported Versions

Security fixes target the latest code on `main` until the project starts
publishing versioned releases.

## Reporting a Vulnerability

Open a private report through GitHub's security advisory flow if it is enabled
for the repository. If that is not available yet, open an issue with a minimal
description and ask for a private contact path before sharing exploit details.

Do not include real Feishu/Lark credentials, Codex tokens, chat ids, local
paths, screenshots of private chats, or attached documents in public reports.

## Deployment Guidance

- Keep `.env`, `.data/`, logs, and downloaded attachments out of commits and
  public archives.
- Direct messages are enabled by default for personal use.
- Group chats are disabled by default. Enable them only with `ALLOW_GROUPS=true`
  plus `ALLOWED_CHAT_IDS`.
- Group chats are limited to `CODEX_GROUP_ALLOWED_ROOTS`, or `CODEX_WORKDIR`
  when that list is empty.
- Set `ALLOWED_USER_IDS` for team deployments, especially when using interactive
  Codex approvals.
- Use `CODEX_SANDBOX=read-only` for Q&A-only bots and avoid
  `danger-full-access` in shared chats.
- Rotate `FEISHU_APP_SECRET` if `.env` or a service log may have been shared.
