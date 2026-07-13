# CLI Agent Type Default

**Date:** 2026-07-12
**Status:** Approved

## Goal

Make omitted agent execution types default to CLI/PTY mode for every provider. This ensures engine-created singleton agents, including Merge Master, run in an interactive CLI session unless a caller explicitly requests headless agent mode.

## Design

The provider registry is the canonical source of execution-mode defaults. Change every provider's `default_session_type` to `pty` in `kanna-agent-protocol`, then regenerate the TypeScript provider registry so backend resolution and frontend metadata remain aligned.

The server's existing `resolve_agent_type` behavior remains structurally unchanged: an omitted value uses the provider default. Explicit `pty` continues to select CLI mode, while explicit `agent` and the legacy aliases `chat` and `sdk` continue to select headless mode for providers that support it. PTY-only providers continue rejecting explicit headless requests.

No existing task rows are migrated. The new default applies only when a task is created without an explicit agent type.

## Testing

- Update protocol tests to require PTY as the default for every provider.
- Add or update server resolver coverage showing an omitted type resolves to PTY for a headless-capable provider while an explicit agent type still resolves to headless mode.
- Update generated-registry frontend tests to require PTY defaults.
- Run focused Rust and desktop tests, then the repository's practical broader checks for the touched packages.

## Out of Scope

- Changing the names stored in the database (`pty` and `agent`).
- Removing the legacy `chat` or `sdk` aliases.
- Migrating or restarting existing tasks.
- Special-casing Merge Master or any other singleton caller.
