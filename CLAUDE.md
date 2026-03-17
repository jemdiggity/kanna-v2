# CLAUDE.md

## Project

Kanna — Tauri v2 desktop app for managing Claude Code agent tasks. Vue 3 frontend, Rust backend, SQLite database.

## Package Manager

Use `bun` for all package management and script execution. Not pnpm, not npm.

## Monorepo Layout

- `apps/desktop/` — Tauri desktop app (Vue 3 + Rust)
- `packages/core/` — shared TypeScript business logic (pipeline, GitHub, Slack, Discord, config)
- `packages/db/` — database schema types and query helpers
- `crates/claude-agent-sdk/` — Rust wrapper for Claude CLI (NDJSON streaming)
- `crates/daemon/` — PTY daemon (Unix socket, session persistence)
- `crates/tauri-plugin-delta-updater/` — self-updater plugin (stub)

## Key Commands

```bash
# Development
cd apps/desktop && bun tauri dev

# Build
cd apps/desktop && bun tauri build

# Unit tests
pnpm test                    # all packages via turborepo
cd packages/core && bun test # core package only

# Rust integration tests (needs claude in PATH)
cd apps/desktop/src-tauri && cargo test --test agent_cli_integration -- --ignored --nocapture

# E2E tests (needs app running with test DB)
# Terminal 1: KANNA_DB_NAME=kanna-test.db bun tauri dev
# Terminal 2: cd apps/desktop && bun test:e2e
```

## Architecture

- **Tauri commands** in `apps/desktop/src-tauri/src/commands/` — agent, daemon, git, fs, shell
- **Vue composables** in `apps/desktop/src/composables/` — usePipeline, useRepo, useTerminal, etc.
- **Agent SDK** wraps Claude CLI via `--output-format stream-json`, communicates via NDJSON on stdin/stdout
- **Permission mode flags** use camelCase: `dontAsk`, `acceptEdits`, `default` (not kebab-case)
- **Browser mock layer** (`tauri-mock.ts`, `invoke.ts`, `listen.ts`, `dialog.ts`) enables running the frontend in a regular browser without Tauri APIs

## Database

SQLite via `tauri-plugin-sql`. Tables: `repo`, `pipeline_item`, `worktree`, `terminal_session`, `agent_run`, `settings`. Schema defined inline in `App.vue`'s `runMigrations()`.

DB name configurable via `KANNA_DB_NAME` env var (defaults to `kanna-v2.db`). E2E tests use `kanna-test.db`.

## Testing

- **Unit tests:** vitest in `packages/core/` and `packages/db/`
- **Integration tests:** Rust tests in `apps/desktop/src-tauri/tests/` (real Claude CLI)
- **E2E tests:** bun test + W3C WebDriver via `tauri-plugin-webdriver` on port 4445
- E2E tests access Vue internals via `__vue_app__._instance.setupState` — dev builds only
- WebDriver is only available in debug builds (`#[cfg(debug_assertions)]`)

## Conventions

- Pipeline stages: `queued`, `in_progress`, `needs_review`, `merged`, `closed`
- Git worktrees created at `{repoPath}/.kanna-worktrees/task-{uuid}`
- Branch names: `task-{uuid}`
- GitHub labels: `kn:wip`, `kn:pr-ready`, `kn:claimed`
- API tokens from env: `KANNA_GITHUB_TOKEN`, `KANNA_SLACK_TOKEN`, `KANNA_DISCORD_TOKEN`

## Common Pitfalls

- Claude CLI permission mode flags are **camelCase** (`dontAsk` not `dont-ask`). The SDK was broken by this once already.
- `@pierre/diffs` worker pool API: use `getOrCreateWorkerPoolSingleton({ poolOptions: { workerFactory }, highlighterOptions: { theme } })`. There is no `createWorkerFactory` export.
- `git_diff` must include untracked files (`include_untracked`, `recurse_untracked_dirs`, `show_untracked_content`) or new files created by Claude won't appear in the diff view.
- The agent SDK pipes stderr to capture (not null) — check stderr output when debugging silent CLI failures.
- `tauri-plugin-webdriver` on port 4445 for E2E testing. Only works in debug builds on macOS WKWebView.
