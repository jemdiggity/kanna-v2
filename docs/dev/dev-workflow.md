# Development Workflow

Day-to-day development runs through the `kd` CLI (`./kd` at the repo root,
implemented in `tools/kd/`). `kd` is the canonical self-development surface for
both humans and agents; when an MCP client has `kd-mcp` configured, the same
tasks are available as MCP tools.

## The three contexts

We develop Kanna in and on Kanna. Any given session runs in one of:

1. **Main checkout** — the stable instance at the repo root, used to manage
   tasks and spawn worktrees.
2. **Release build** — the installed `/Applications/Kanna.app`, used when the
   main checkout itself is being modified.
3. **Dev worktree** — a task branch checked out at
   `{repo}/.kanna-worktrees/task-{uuid}`, running its own fully isolated dev
   instance.

## Worktree isolation

`kd` auto-detects the context and isolates each instance so main + N worktrees
run simultaneously without conflicts:

- **Ports** — base ports come from `.kanna/config.json` `ports` (e.g.
  `KANNA_DEV_PORT: 1420`); each worktree gets the next free offset and the
  resolved values are passed to its processes as env vars.
- **Database** — main uses `kanna-v2.db`; worktrees use
  `kanna-wt-{worktree-dir}.db` (same Application Support dir).
- **Daemon** — worktrees use `{worktree}/.kanna-daemon/` instead of
  `~/Library/Application Support/Kanna/`.
- **tmux** — worktrees get their own tmux *server* named
  `kanna-{worktree-dir}`.
- **Tauri config** — `kd dev up` writes `tauri.conf.local.json` with the port
  override and passes `--config`; the committed `tauri.conf.json` is never
  modified.

`./kd env print` shows everything resolved for the current context.

## kd command reference

Grouped highlights — run `./kd` for the full surface (task ids live in
`tools/kd/src/tasks/registry.ts`).

### Dev environment

```sh
./kd dev up                  # start desktop dev stack in background tmux
./kd dev up --mobile         # + Expo mobile app
./kd dev up --emulators      # + Firebase emulators
./kd dev up --seed           # + seed data (from a worktree)
./kd dev up --attach         # attach to the tmux session
./kd dev down                # stop; --kill-daemon also kills workspace daemons
./kd dev restart             # stop + start (optional component: desktop|mobile|backend)
./kd dev status              # inspect tmux session status
./kd dev log                 # recent desktop output
./kd dev log mobile          # recent mobile output
./kd env print               # resolved ports, DB, daemon dir, transfer root
./kd doctor                  # prerequisite check
./kd clean --all             # remove generated artifacts
```

### Build & test

```sh
./kd build desktop           # workspace build
./kd build sidecars          # sidecar-only build + staging
pnpm test                    # canonical JS/TS suite
./kd test rust               # canonical Rust suite
```

### Mobile

```sh
./kd mobile run --device     # dev stack + install/launch on a physical iPhone
./kd mobile doctor --device  # on-device preflight without building
./kd mobile up --staging     # staging Metro against installed Kanna Staging
./kd mobile up --production  # mobile against installed /Applications/Kanna.app
./kd mobile ota status --staging  # OTA channel pointer; all OTA workflows in release.md
```

Always start end-to-end mobile runs from `./kd dev up --mobile` or
`./kd mobile up` — launching Expo directly from `apps/mobile` does not start
the desktop-side `kanna-server`, so the app boots but can't reach desktop
data. Physical-device flows, staging installs, and the Buffy staging test
identity are documented in detail in `AGENTS.md`.

### Cloud & release

```sh
./kd cloud deploy --staging            # Firebase; add --relay for the relay
./kd cloud deploy --production
./kd release ship --dry-run            # build/sign without publishing
./kd release ship --release            # tag, publish, upload manifest
./kd release ship --staging --release  # staging channel prerelease
```

See [Release](release.md). Never run `firebase deploy` or `pnpm exec tauri`
directly; if a `kd` workflow is broken, fix `kd` and rerun through it.

## Repo-level Kanna config: `.kanna/`

Per-repo product configuration, used by Kanna when running tasks against this
repo (and dogfooded by this repo on itself):

- `config.json` — worktree `setup` commands (here: `pnpm install`,
  `./kd env sync`), `teardown`, `test`, base `ports`, default pipeline.
- `agents/{name}/AGENT.md` (+ optional `EXTEND.md`) — agent definitions and
  repo-local extensions.
- `pipelines/{name}.json` — pipeline definitions.
- `tasks/{slug}/agent.md` — custom task templates.

Built-in agents/pipelines ship as Tauri bundled resources; per-repo files
override them by name.

## Debugging map

| Symptom / need | Look at |
|---|---|
| Frontend behavior, console output | `/tmp/kanna-webview-*.log` (worktrees use the directory name, e.g. `kanna-webview-task-348cf000.log`; main uses a cwd hash) |
| Dev process output (vite, tauri, mobile) | `./kd dev log [mobile]`, or attach with `./kd dev up --attach` |
| Daemon behavior, PTY sessions | `kanna-daemon_*.log` in the instance's daemon dir |
| Local API | `curl http://127.0.0.1:48120/v1/status` (main/production instance) |
| Resolved instance config | `./kd env print` |
| Silent agent CLI failures | The agent SDK captures stderr — check it |
| Stuck daemons across worktrees | `./kd dev down --kill-daemon`, or `./kd daemon kill` |

## Conventions and pitfalls

Coding style (TypeScript, Rust, Vue), the E2E coverage expectation, and the
hard-won "Common Pitfalls" list are maintained in
[`AGENTS.md`](../../AGENTS.md) and apply to human contributions exactly as they
do to agent contributions. Highlights you will hit early:

- Run `pnpm exec tsc --noEmit` and `cargo clippy` before calling work done;
  `cargo fmt --all` from the repo root before committing Rust.
- No `any` in TypeScript; no `unwrap()` in production Rust.
- Trace the full data flow (DB → server → store → component → daemon) before
  changing any layer; fix designs rather than layering workarounds.
- Cross-boundary behavior changes need E2E coverage, or an explicit dated note
  in `docs/` explaining why not yet (see the `*-e2e-gap.md` / `*-e2e-note.md`
  convention).
