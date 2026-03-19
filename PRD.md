# Kanna — Product Requirements

## What

Kanna is a desktop app for managing Claude Code agent tasks. Create a task, Claude works on it in an isolated worktree, review the diff, make a PR, merge. All from one window.

## Who

Software developers who use Claude Code and want to run multiple agent tasks in parallel without juggling terminals and branches.

## Core Concepts

**Task** — A unit of work. Has a prompt, a git worktree, a Claude agent session, and a pipeline stage. One task = one branch = one PR.

**Pipeline** — Linear workflow: `queued → in_progress → needs_review → merged | closed`.

**Daemon** — Standalone process that manages PTY sessions. Survives app restarts. Handles seamless upgrades via fd handoff.

## Workflows

### Create a task

1. Cmd+N → enter prompt
2. App creates git worktree (`{repo}/.kanna-worktrees/task-{uuid}`)
3. Runs `.kanna/config.json` setup scripts if present (e.g., `bun install`)
4. Spawns Claude CLI in the worktree via daemon
5. Agent starts working. User watches in real-time terminal.

### Review and merge

1. Agent finishes → task marked as unread (bold in sidebar)
2. User selects task, presses Cmd+D → diff modal shows all branch changes
3. Optionally Cmd+P → file picker → preview, Cmd+O → open in IDE, or Cmd+J → shell in worktree
4. Cmd+S → create GitHub PR, task moves to `needs_review`
5. Cmd+M → merge PR, task moves to `merged`

### Manual intervention

1. Cmd+J → shell modal opens in the task's worktree
2. Run tests, inspect files, debug
3. Close shell → focus returns to agent terminal
4. Type in agent terminal to send input to Claude

### Multi-repo

- Import repos via sidebar
- Each repo has its own task list
- Switch between repos and tasks freely
- Cmd+Opt+Up/Down navigates tasks in sidebar order

## Pipeline Stages

| Stage | Description | Valid transitions |
|-------|-------------|-------------------|
| `queued` | Created, waiting to start | → `in_progress`, `closed` |
| `in_progress` | Agent working or waiting for input | → `needs_review`, `closed` |
| `needs_review` | PR created, awaiting human review | → `merged`, `closed` |
| `merged` | PR merged | terminal |
| `closed` | Abandoned or rejected | terminal |

GitHub labels applied automatically: `kn:wip` (in progress), `kn:pr-ready` (needs review).

### Closing a task (Cmd+Delete)

1. Kills the agent PTY session and shell session in the daemon
2. Marks the task as `closed` in the DB
3. Selects the next task in the sidebar
4. Closed tasks are hidden from the sidebar immediately

### Garbage collection

Closed tasks are cleaned up on app startup. Tasks closed longer than `gcAfterDays` (default: 3, configurable in preferences) are permanently deleted — worktree removed, DB row deleted.

## Task Activity

| State | Meaning | Sidebar display |
|-------|---------|-----------------|
| `idle` | No recent activity | normal |
| `working` | Agent actively running (PostToolUse hook) | italic |
| `unread` | Agent finished, user hasn't looked | bold |

Sorted in sidebar: working > unread > idle, then by most recent.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+N | New task |
| Cmd+D | Diff modal |
| Cmd+J | Shell modal |
| Cmd+P | File picker |
| Cmd+O | Open in IDE |
| Cmd+S | Make PR |
| Cmd+M | Merge PR |
| Cmd+Delete | Close task |
| Cmd+Opt+Up/Down | Navigate tasks |
| Cmd+Shift+Z | Zen mode (hide sidebar) |
| Cmd+/ | Keyboard shortcuts |
| Cmd+, | Preferences |
| Escape | Dismiss modal |

All shortcuts work even when the terminal has focus.

## Agent Execution

### PTY mode (default)

Claude CLI runs in a real terminal via the daemon. User sees full TUI output in real-time. Interactive — user can type. Hooks (`kanna-hook` binary) report lifecycle events:

- `Stop` — agent finished
- `StopFailure` — agent hit error
- `PostToolUse` — agent invoked a tool (marks task as working)

### SDK mode (alternate)

Claude CLI runs headless with `--output-format stream-json`. NDJSON on stdin/stdout. Non-interactive. Used for automation.

## Daemon

The daemon is a standalone process that manages PTY sessions over a Unix socket. See [crates/daemon/SPEC.md](crates/daemon/SPEC.md) for the full specification.

### Invariants

1. **One daemon at a time.** New daemon always replaces the old one.
2. **Always handoff.** New daemon transfers sessions from old daemon via SCM_RIGHTS.
3. **Always spawn.** App always starts a fresh daemon. Never reuses existing.
4. **Always wait.** App waits for the new daemon's PID before connecting. Prevents connecting to the old daemon during handoff.
5. **Sessions survive upgrades.** Child processes are unaware of daemon restarts.
6. **One reader per session.** Single `stream_output` task, started on first Attach.
7. **One client per session.** Attach swaps the output target atomically.

### App Startup Sequence

1. App spawns new daemon binary (detached via `setsid`)
2. New daemon detects old daemon, performs handoff (fd transfer), old daemon exits
3. New daemon writes PID file and binds socket
4. App polls PID file until it matches the spawned child
5. App clears stale command connection (`DaemonState`)
6. App connects to new daemon (event bridge + on-demand command connection)
7. Frontend mounts terminals, calls Attach → Resize → Claude redraws

The app does **not** attempt to reconnect mid-session. Daemon restarts only happen on app startup. All connections are established fresh after the new daemon is confirmed ready.

### Reconnection

No scrollback buffer. On reconnect: Attach → Resize → SIGWINCH → Claude redraws its TUI. Works because Claude CLI (ink/React) re-renders the full component tree on resize.

### Logging

Uses `flexi_logger`. Logs to stderr + file at `{KANNA_DAEMON_DIR}/kanna-daemon_*.log`. Level controlled by `RUST_LOG` (default: `info`).

## Diff Viewer

- Modal (Cmd+D), not a tab
- Scopes: Branch (all changes since main), Last Commit, Working (uncommitted)
- Scope remembered per task
- Rendered by `@pierre/diffs` with shadow DOM, syntax highlighting via worker pool
- Unified view with classic +/- indicators

## Preferences

| Setting | Options | Default |
|---------|---------|---------|
| Font Family | SF Mono, Menlo, Courier New, Fira Code | SF Mono |
| Font Size | 10–24px | 13 |
| Suspend After | minutes | 30 |
| Kill After | minutes | 60 |
| Appearance | system, light, dark | system |
| IDE Command | any executable | code |

Stored in SQLite `settings` table.

## Configuration

### Environment variables

| Var | Description |
|-----|-------------|
| `KANNA_GITHUB_TOKEN` | GitHub API token for PRs |
| `KANNA_SLACK_TOKEN` | Slack notifications (optional) |
| `KANNA_DISCORD_TOKEN` | Discord notifications (optional) |
| `KANNA_DB_NAME` | Database filename (default: `kanna-v2.db`) |
| `KANNA_DAEMON_DIR` | Daemon data directory |
| `RUST_LOG` | Daemon log level |

### Per-repo config (`.kanna/config.json`)

```json
{
  "setup": ["bun install"],
  "teardown": ["./scripts/cleanup.sh"],
  "ports": {
    "KANNA_DEV_PORT": 1420
  }
}
```

## Architecture

```
apps/desktop/          Tauri v2 app (Vue 3 frontend + Rust backend)
packages/core/         Business logic (pipeline, GitHub, Slack, config)
packages/db/           SQLite schema + query helpers
crates/daemon/         PTY daemon (Unix socket, session persistence, handoff)
crates/claude-agent-sdk/  Rust wrapper for Claude CLI (NDJSON streaming)
crates/kanna-hook/     Hook binary called by Claude CLI lifecycle events
```

### Data flow

```
User creates task
  → App creates worktree + DB record
  → App tells daemon to Spawn PTY session
  → App tells daemon to Attach (start streaming)
  → Daemon forks child (zsh -c "claude ..."), reads PTY output
  → Daemon sends Output events to app via Unix socket
  → App emits Tauri events to frontend
  → Frontend writes to xterm.js

User types in terminal
  → xterm.js onData → invoke("send_input") → daemon Input command → PTY write

Claude finishes
  → kanna-hook fires Stop event → daemon broadcasts → app updates task activity

User makes PR
  → App calls GitHub API → creates PR → updates DB → transitions stage
```

## Dev Workflow

```bash
bun dev          # from repo root
```

## Testing

```bash
# Unit tests
bun test                              # all packages via turborepo

# Daemon integration tests
cd crates/daemon && cargo test -- --test-threads=1

# E2E tests (requires app running)
KANNA_DB_NAME=kanna-test.db bun tauri dev  # terminal 1
cd apps/desktop && bun test:e2e            # terminal 2
```
