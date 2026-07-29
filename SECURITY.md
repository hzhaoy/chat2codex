# Security Policy

Chat2Codex turns chat messages into local Codex runs. Treat every enabled chat
as a remote-control surface for the machine running the bridge.

## Supported Versions

Security fixes are developed on `main` and released for the latest published
minor release line. Earlier minor release lines do not receive security fixes;
upgrade before reporting or validating a suspected vulnerability.

| Version | Supported |
| --- | --- |
| `0.7.x` | Yes |
| `<= 0.6.x` | No |

## Reporting a Vulnerability

Open a private report through GitHub's security advisory flow if it is enabled
for the repository. If that is not available yet, open an issue with a minimal
description and ask for a private contact path before sharing exploit details.

Do not include real Feishu/Lark or Weixin credentials, Codex tokens, chat ids, local
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
- Keep Weixin `credentials.json` and `runtime.json` private. The Bot Token,
  attachment AES keys, and context tokens must never be copied into `.env`,
  logs, issues, or chat transcripts. Rerun the QR binding after suspected
  credential exposure.
- Weixin v1 is a personal direct-message adapter. Keep `ALLOW_GROUPS=false`;
  ordinary groups, voice/video input, outbound media, and in-place updates are
  intentionally rejected.
- Platform credentials are removed from the environment passed to Codex child
  processes. Keep unrelated secrets out of the bridge service environment too.
- After installing or upgrading Codex CLI, run `chat2codex doctor`. An exact
  version mismatch with the bundled app-server protocol snapshot is a warning;
  run `chat2codex smoke` before treating that CLI version as compatible.
- Unknown app-server server-request methods are rejected, and malformed
  approval requests return an invalid-params error without offering an
  approval action. Supported `requestUserInput`, standard MCP form/URL
  elicitation, and additional-permission requests are revalidated against the
  runner's original request before a response is returned. Callbacks are bound
  to the original sender and card message; malformed, withdrawn, late, secret,
  or incompletely rendered requests fail closed. Interactive answer values are
  not persisted or echoed by the bridge. Investigate compatibility warnings
  instead of weakening this behavior.
- Session-scoped command and permission grants remain only in the reusable
  app-server process that received them. The bridge rotates that process when
  the sender identity, canonical cwd, thread, policy, or session epoch changes;
  messages without a stable sender identity use a single-turn process and
  cannot inherit session grants.
- Approval cards disclose additional permission profiles and every complete
  exec/network policy rule. If any security-relevant detail cannot be rendered
  completely, allow actions are removed and only decline/cancel remain, and the
  same filter is enforced server-side for card callbacks. File-change approval
  requests currently omit target files and patch details, so they are limited
  to decline/cancel until complete disclosure is available.
- Pending events are replayed with at-least-once semantics. Review sensitive
  side effects after an interrupted run before allowing an automatic retry.
- Run only one bridge process for each `BRIDGE_STATE_PATH`; startup rejects a
  second live instance to prevent duplicate replay and lost state updates.
- Instance locks are not reclaimed automatically. After a hard crash, verify
  that no bridge is running before removing `<BRIDGE_STATE_PATH>.lock`.
