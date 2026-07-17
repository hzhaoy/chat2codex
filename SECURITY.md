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
- Direct-message routing is enabled by default, but execution requires either
  an allowlisted sender or an allowlisted direct chat. `/whoami` remains
  available for discovering those ids in a direct message.
- Group `/whoami` replies omit all sender ids and expose only the `chat_id`,
  chat type, and access decision. Retrieve sender ids through a direct message
  instead of leaving them in group history.
- Group chats are disabled by default. Enable them only with `ALLOW_GROUPS=true`
  plus `ALLOWED_CHAT_IDS` and `ALLOWED_USER_IDS`.
- Group chats are limited to `CODEX_GROUP_ALLOWED_ROOTS`, or `CODEX_WORKDIR`
  when that list is empty.
- Set `ALLOWED_USER_IDS` for team deployments, especially when using interactive
  Codex approvals.
- Use `CODEX_SANDBOX=read-only` for Q&A-only bots and avoid
  `danger-full-access` in shared chats.
- Rotate `FEISHU_APP_SECRET` if `.env` or a service log may have been shared.
- Platform credentials are removed from the environment passed to Codex child
  processes. Keep unrelated secrets out of the bridge service environment too.
- Pending events are replayed with at-least-once semantics. Review sensitive
  side effects after an interrupted run before allowing an automatic retry.
- Run only one bridge process for each `BRIDGE_STATE_PATH`; startup rejects a
  second live instance to prevent duplicate replay and lost state updates.
- Instance locks are not reclaimed automatically. After a hard crash, verify
  that no bridge is running before removing `<BRIDGE_STATE_PATH>.lock`.
