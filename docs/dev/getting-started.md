# Getting Started

This page takes you from a fresh clone to a running development instance of the
Kanna desktop app.

## Prerequisites

macOS with the following on `PATH` (checked by `./kd doctor`):

- `git`
- `pnpm` (the repo pins `pnpm@11` via the `packageManager` field; Node.js is
  required to run pnpm and the `kd` CLI)
- `tmux` — `kd dev up` runs the dev processes in a background tmux session
- `rustc` / `cargo` — the toolchain version is pinned by `rust-toolchain.toml`
  and installed automatically by rustup
- `sqlite3`

For agent sessions you also need at least one agent CLI installed and
authenticated (Claude CLI is the default provider; Copilot, Codex, OpenCode,
and Antigravity are also supported).

## Setup

```sh
git clone <repo-url> kanna
cd kanna
./kd setup          # checks prerequisites, then installs workspace deps
./kd doctor         # re-check prerequisites at any time
```

`./kd setup --check` verifies prerequisites without installing anything.

Use `pnpm` for all package management and script execution — never npm.

## Run the app

```sh
./kd dev up
```

Always launch through `kd` — never `pnpm run dev`, `pnpm exec tauri dev`, or
`cargo tauri dev` directly. `kd` resolves the instance context (main checkout
vs. worktree), assigns ports, derives the per-instance database and daemon
directory, writes a local Tauri config, and starts everything in a background
tmux session.

Useful follow-ups:

```sh
./kd dev status     # what's running
./kd dev log        # recent desktop output from the tmux session
./kd dev down       # stop the session
./kd env print      # resolved ports, DB path, daemon dir, transfer root
```

Variants: `./kd dev up --mobile` (desktop + Expo mobile app),
`--emulators` (Firebase emulators), `--seed` (seed data, from a worktree),
`--attach` (attach to the tmux session). See
[Development Workflow](dev-workflow.md) for the full `kd` reference.

### First build takes a while

The first `./kd dev up` in a fresh checkout or worktree compiles ~523 Rust
crates. The daemon builds quickly, but the full Tauri app takes several
minutes. Subsequent builds are incremental. Rust build artifacts go to
`.build/` (not `target/`) — configured in `.cargo/config.toml`.

## Where things live at runtime

| Thing | Location |
|---|---|
| SQLite DB (main checkout) | `~/Library/Application Support/build.kanna/kanna-v2.db` |
| SQLite DB (worktree instance) | same dir, `kanna-wt-{worktree-dir}.db` |
| Daemon data (main checkout) | `~/Library/Application Support/Kanna/` |
| Daemon data (worktree instance) | `{worktree}/.kanna-daemon/` |
| Daemon logs | `kanna-daemon_*.log` in the daemon data dir |
| Frontend (webview) console logs | `/tmp/kanna-webview-*.log` (per instance) |
| Local API (`kanna-server`) | `http://127.0.0.1:48120` (production/main default) |

The desktop app owns the daemon and `kanna-server` lifecycles; you normally
never start those by hand.

## Verify your setup

```sh
pnpm test           # canonical JS/TS test suite (turbo across the workspace)
./kd test rust      # canonical Rust test suite
```

Both should pass on a clean checkout. See [Testing](testing.md) for the rest of
the taxonomy (E2E, live agent suites, mobile).

## Developing Kanna in Kanna

The team develops Kanna *with* Kanna: a stable instance (main checkout or the
installed `/Applications/Kanna.app`) manages tasks, and each task runs an agent
in its own worktree under `{repo}/.kanna-worktrees/task-{id}` with its own
ports, DB, daemon, and tmux server. This means you can run the main app and any
number of worktree dev instances simultaneously without conflicts. The
mechanics are covered in [Development Workflow](dev-workflow.md).
