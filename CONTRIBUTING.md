# Contributing

Thanks for helping improve Chat2Codex.

## Development Setup

```bash
bun install
bun run check
```

`bun run check` runs TypeScript type checking, the Bun test suite, and the
production build.

## Local Validation

Use the app-server smoke tests after changing Codex protocol wiring:

```bash
bun run smoke:app-server
bun run smoke:app-server:turn
bun run smoke:app-server:approval
```

The turn and approval smoke tests require a working local Codex login and may
start model-backed Codex turns.

## Pull Requests

- Keep changes focused and reversible.
- Add or update tests for behavior changes.
- Update README or `.env.example` when configuration changes.
- Do not commit `.env`, `.data/`, `dist/`, `node_modules/`, logs, or local
  attachment files.
- Run `bun run check` before opening a pull request.

## Commit Messages

Use concise Conventional Commit subjects when possible, for example:

```text
fix: restrict group chat project roots
docs: add security deployment guidance
```
