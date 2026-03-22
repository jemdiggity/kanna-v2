# CLAUDE.md

## Project

Kanna — Tauri v2 desktop app for managing Claude Code agent tasks. Vue 3 frontend, Rust backend, SQLite database. See [PRD.md](PRD.md) for product requirements.

Kanna is a product distributed to end users as a signed macOS app. All dependencies must be vendored or statically linked — never depend on libraries installed on the build machine (e.g., Homebrew). Release builds must run on any Mac without developer tools installed.

## Package Manager

Use `bun` for all package management and script execution. Not pnpm, not npm.

## Monorepo Layout

- `apps/desktop/` — Tauri desktop app (Vue 3 + Rust)
- `packages/core/` — shared TypeScript business logic (pipeline, GitHub, Slack, Discord, config)
- `packages/db/` — database schema types and query helpers
- `crates/claude-agent-sdk/` — Rust wrapper for Claude CLI (NDJSON streaming)
- `crates/daemon/` — PTY daemon (Unix socket, session persistence)
- `crates/tauri-plugin-delta-updater/` — self-updater plugin (stub)

## Development Workflow

We develop Kanna **in and on** Kanna — Claude Code agents run from one of three contexts:

1. **Main branch** — the stable Kanna instance at the repo root, used to manage tasks and spawn worktrees
2. **Release build** — installed to `/Applications/Kanna.app`, used when the main branch is being modified
3. **Dev worktree** — a feature branch checked out at `{repoPath}/.kanna-worktrees/task-{uuid}`, running its own isolated dev server

### Worktree isolation

Worktrees are fully isolated from the main branch instance:

- **Separate Vite port** — main uses `localhost:1420`, worktrees get a unique port automatically. The app reads base ports from `.kanna/config.json` `ports` field (e.g., `"KANNA_DEV_PORT": 1420`), picks the next unused offset (1, 2, 3…), and stores the computed port (e.g., `1421`) as `port_env` in the DB. When the worktree's agent session spawns, `KANNA_DEV_PORT` is passed as an env var — no manual editing of `config.json` is needed. `dev.sh` then writes `tauri.conf.local.json` with the port override and passes `--config` to Tauri — the committed `tauri.conf.json` is never modified. Vite also reads `KANNA_DEV_PORT` to set its server port.
- **Separate daemon** — worktrees use `{worktree}/.kanna-daemon/` instead of `~/Library/Application Support/Kanna/`
- **Separate database** — each instance uses its own SQLite DB
- **Separate tmux session** — `dev.sh` names the session `kanna-{worktree-dir}` instead of `kanna`

This means the main Kanna app and a dev worktree can run simultaneously without port or data conflicts.

### Launching the dev server

Always use `./scripts/dev.sh` to start the dev server — never run `bun tauri dev` or `cargo tauri dev` directly. It auto-detects the worktree context, sets `KANNA_WORKTREE=1`, forwards all `KANNA_*` env vars, and runs in a background tmux session.

```bash
# Development (from repo root or worktree root)
./scripts/dev.sh             # start in tmux (auto-detects worktree)
./scripts/dev.sh stop        # stop the tmux session
./scripts/dev.sh restart     # stop + start
./scripts/dev.sh log         # print recent tmux output
./scripts/dev.sh start -a    # start and attach to tmux session

# Build
cd apps/desktop && bun tauri build

# Unit tests
bun test                     # all packages via turborepo
cd packages/core && bun test # core package only

# Daemon tests
cd crates/daemon && cargo test -- --test-threads=1

# Rust integration tests (needs claude in PATH)
cd apps/desktop/src-tauri && cargo test --test agent_cli_integration -- --ignored --nocapture

# E2E tests (needs app running with test DB)
# Terminal 1: KANNA_DB_NAME=kanna-test.db bun tauri dev
# Terminal 2: cd apps/desktop && bun test:e2e
```

### First build in a worktree

The first `bun dev` in a fresh worktree compiles ~523 Rust crates (the daemon builds quickly, but the full Tauri app takes several minutes). Subsequent builds are incremental.

## Architecture

- **Tauri commands** in `apps/desktop/src-tauri/src/commands/` — agent, daemon, git, fs, shell
- **Vue composables** in `apps/desktop/src/composables/` — usePipeline, useRepo, useTerminal, etc.
- **Daemon** in `crates/daemon/` — standalone PTY session manager. See `crates/daemon/SPEC.md` for full spec, `PRD.md` for product behavior.
- **Agent SDK** wraps Claude CLI via `--output-format stream-json`, communicates via NDJSON on stdin/stdout
- **Permission mode flags** use camelCase: `dontAsk`, `acceptEdits`, `default` (not kebab-case)
- **Browser mock layer** (`tauri-mock.ts`, `invoke.ts`, `listen.ts`, `dialog.ts`) enables running the frontend in a regular browser without Tauri APIs

### Data flow

```
User creates task → worktree + DB record → daemon Spawn → Attach (start streaming)
  → daemon forks child (zsh -c "claude ...") → reads PTY output → Output events via Unix socket
  → Tauri events → frontend xterm.js

User types → xterm.js onData → invoke("send_input") → daemon Input → PTY write

Claude finishes → kanna-hook fires Stop → daemon broadcasts → app updates task activity

User makes PR → GitHub API → DB update → stage transition
```

## Daemon

- Raw libc PTY (not portable-pty) — needed for `SCM_RIGHTS` fd handoff
- Always spawned fresh on app start, handoff from old daemon preserves sessions
- App waits for new daemon's PID file before connecting (prevents stale connections)
- One reader per session, started on first Attach (not on Spawn)
- No scrollback buffer — reconnection uses SIGWINCH to trigger Claude TUI redraw
- Logs to `~/Library/Application Support/Kanna/kanna-daemon_*.log` via flexi_logger
- `KANNA_DAEMON_DIR` env var overrides data directory (used by tests)

### Daemon invariants

1. **One daemon at a time.** New daemon always replaces the old one.
2. **Always handoff.** New daemon transfers sessions from old daemon via SCM_RIGHTS.
3. **Always spawn.** App always starts a fresh daemon. Never reuses existing.
4. **Always wait.** App waits for the new daemon's PID before connecting.
5. **Sessions survive upgrades.** Child processes are unaware of daemon restarts.
6. **One reader per session.** Single `stream_output` task, started on first Attach.
7. **One client per session.** Attach swaps the output target atomically.

### App startup sequence

1. App spawns new daemon binary (detached via `setsid`)
2. New daemon detects old daemon, performs handoff (fd transfer), old daemon exits
3. New daemon writes PID file and binds socket
4. App polls PID file until it matches the spawned child
5. App clears stale command connection (`DaemonState`)
6. App connects to new daemon (event bridge + on-demand command connection)
7. Frontend mounts terminals, calls Attach → Resize → Claude redraws

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

## Versioning

Single `VERSION` file generated by `scripts/sync-version.sh` from git tags. Format: `0.0.1` (tagged) or `0.0.1-dev.main.abc1234` (untagged). Syncs to `tauri.conf.json`. Package.json versions are all `0.0.0` (meaningless). Daemon reads version from git at compile time via `build.rs`.

## Common Pitfalls

- Claude CLI permission mode flags are **camelCase** (`dontAsk` not `dont-ask`). The SDK was broken by this once already.
- `@pierre/diffs`: use `containerWrapper` (not `fileContainer`) in `FileDiff.render()` — `fileContainer` skips the shadow DOM and loses all styling. Use `worker-portable.js` (not `worker.js`) to avoid WASM dependency. Theme/lineDiffType go in worker pool options, not FileDiff constructor (ignored when using pool).
- `git_diff` must include untracked files (`include_untracked`, `recurse_untracked_dirs`, `show_untracked_content`) or new files created by Claude won't appear in the diff view.
- The agent SDK pipes stderr to capture (not null) — check stderr output when debugging silent CLI failures.
- `tauri-plugin-webdriver` on port 4445 for E2E testing. Only works in debug builds on macOS WKWebView.
- Daemon must be detached from app process group (`setsid` via `pre_exec`) or Ctrl+C kills it.
- Frontend console logs go to `/tmp/kanna-webview.log` via the log forwarding in `main.ts`.
