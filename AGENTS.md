# AGENTS.md

## Project

Kanna — Tauri v2 desktop app for managing coding agent tasks. Vue 3 frontend, Rust backend, SQLite database. Public repository hosted on GitHub.

Kanna is a product distributed to end users as a signed macOS app. All dependencies must be vendored or statically linked — never depend on libraries installed on the build machine (e.g., Homebrew). Release builds must run on any Mac without developer tools installed.

**Target user:** Software developers who use coding agents and want to run multiple agent tasks in parallel without juggling terminals and branches.

## Product Behavior

### Core concepts

- **Task** — A unit of work. Has a prompt, a git worktree, an agent session, and a lifecycle stage. One task = one branch = one PR.
- **Pipeline** — User-definable agentic pipeline: an ordered list of stages, each with an agent, an optional environment, a stage policy, and an optional post. Defined in `.kanna/pipelines/*.json`. Default: `in progress` (post: `commit`) `→ review → pr` (post: `approve`, which marks the PR ready and signals the merge master). Tasks are durable (same id, run history, blockers), but each stage transition forks a fresh workspace: a new branch + worktree named `task-{id}-{n}` (the durable task id plus a workspace counter; the creation workspace is plain `task-{id}`) cut from the previous branch's committed tip — N worktrees, N branches, one PR (the PR agent renames the final branch into something meaningful). A workspace is an ephemeral manifestation of the task. A stage's `post` (e.g. commit) is tail work injected into the stage's running agent session before the transition — stages fork workspaces and swap sessions, posts continue them. Only committed work crosses a stage boundary; when the task leaves a workspace, the workspace's repo-config `teardown` commands run best-effort in a detached `td-{branch}` daemon session, and open-task worktrees stay available for revision resume until the task closes. Advancing past the final stage closes the task; close snapshots dirty workspace state into local WIP commits, removes the task's worktrees, and keeps the branches.
- **Daemon** — Standalone process that manages PTY sessions. Survives app restarts. Handles seamless upgrades via fd handoff.

### Workflows

**Create a task:**
1. Cmd+N → enter prompt (choose an available agent provider)
2. App creates git worktree (`{repo}/.kanna-worktrees/task-{uuid}`)
3. Runs `.kanna/config.json` setup scripts if present (e.g., `pnpm install`)
4. Spawns agent CLI in the worktree via daemon
5. Agent starts working. User watches in real-time terminal.

**Review and merge:**
1. Agent finishes → task marked as unread (bold in sidebar)
2. User selects task, presses Cmd+D → diff modal shows all branch changes
3. Optionally Cmd+P → file picker → preview, Cmd+O → open in IDE, or Cmd+J → shell in worktree
4. Cmd+S → advance the pipeline (commit post runs in-session; the pr-stage agent creates the GitHub PR and reports its URL)
5. Human reviews the PR, then Cmd+S (or the diff modal's approve button) advances the pr stage: when the task's pinned pipeline ships the `approve` post, the button reads "Approve & Merge" and the post marks the PR ready and signals the merge master, which merges it; pinned pipelines without the post get a plain "Approve" that only advances. Approval is single-flight: while the post runs the button is disabled and repeated Cmd+S is ignored — only the post's completion closes the task. Shift+Cmd+S in the diff modal sends the task back to `in progress` for revisions instead.

**Manual intervention:**
1. Cmd+J → shell modal opens in the task's worktree
2. Run tests, inspect files, debug
3. Close shell → focus returns to agent terminal
4. Type in agent terminal to send input to Claude

**Multi-repo:** Import repos via sidebar. Each repo has its own task list. Cmd+Opt+Up/Down navigates tasks in sidebar order.

### Closing a task (Cmd+Delete)

1. Kills the agent PTY session and shell session in the daemon
2. Runs workspace teardown commands best-effort when configured
3. Sets `closed_at` in the DB
4. Snapshots dirty state in each of the task's worktrees with a local `WIP at task close` commit, then removes those worktrees with `git worktree remove --force --force` and prunes worktree registrations
5. Deletes the task's `worktree` table rows but keeps the task row and all branches. Branches are never deleted by close.
6. Selects the next task in the sidebar
7. Tasks with `closed_at` are hidden from the sidebar. The sidebar shows tasks whose `closed_at` is null.

On server startup, Kanna reconciles leftovers across all repos, including hidden repos: closed-task worktrees are snapshotted and removed, stale registrations are pruned, and young orphan `task-*` directories without a task row are spared. This bounds registered worktrees by construction to roughly the number of open tasks. The bound matters because each registered git worktree expands sandboxed agent shell spawn profiles; unbounded worktrees can overflow macOS `ARG_MAX` and cause sandboxed shell launches to fail with `E2BIG`.

### Task activity

| State | Meaning | Sidebar display |
|-------|---------|-----------------|
| `idle` | No recent activity | normal |
| `working` | Agent actively running (PostToolUse hook) | italic |
| `unread` | Agent finished, user hasn't looked | bold |

Sorted in sidebar: pinned (manual order) → merge → pr → active (by created_at desc) → blocked.

### Pinned tasks

Tasks can be pinned to the top of their repo's task list by dragging above the pin divider. Per-repo scope. Closed tasks disappear regardless of pin state.

### Agent execution

**PTY mode (default):** Agent CLI runs in a real terminal via the daemon. User sees full TUI output in real-time. Interactive — user can type. Hooks (`kanna-hook` binary) report lifecycle events: `Stop` (finished), `StopFailure` (error), `PostToolUse` (marks task as working).

**SDK mode (alternate):** Agent CLI runs headless with `--output-format stream-json`. NDJSON on stdin/stdout. Non-interactive. Used for automation.

**Sending input to a running task:** Use `kanna-cli task send-input --task-id <TASK_ID> --message "Please fix the failing typecheck"` to send feedback or instructions to an already-running agent task through the desktop-backed local API. The command posts to `/v1/tasks/{task_id}/input` and appends Enter to the message when needed.

### MCP task management

Project-scoped MCP servers are registered in `.mcp.json` so Claude Code, Codex, and other MCP-aware agent clients launched from this repo can discover both Kanna task tools and kd development tools.

- **`kanna-mcp`** exposes `kanna_*` task-management tools backed by the desktop local API at `http://127.0.0.1:48120`. Prefer these tools for task management: create tasks, fetch task status/detail, list/search tasks, close tasks, send input, request revision, advance stage, and complete stage. Its tool surface comes from `crates/kanna-tool-catalog`, the single declarative source of truth shared with `kanna-cli`.
- Kanna task sessions register the instance-local `kanna-mcp` server automatically for Claude (`--mcp-config`), Codex (`-c mcp_servers.kanna-mcp.*`), Copilot (`--additional-mcp-config`), and OpenCode (`OPENCODE_CONFIG_CONTENT`). Antigravity (`agy 1.0.14`) has no verified stable MCP registration flag or config surface, so Antigravity tasks use the `kanna-cli` fallback for Kanna task operations.
- The MCP server hot-reloads an override catalog from `KANNA_MCP_CATALOG` or `<cwd>/.kanna/mcp-tools.json`. When the catalog changes, `kanna-mcp` swaps the active tools and emits the JSON-RPC notification `notifications/tools/list_changed`; clients should call `tools/list` again after receiving it. The shared CLI exposes the same catalog through `kanna-cli tool list` and can invoke any catalog tool with `kanna-cli tool call <name> --json '{...}'`.
- Catalog manifests declare `{ "tools": [...] }`. Each tool includes `name`, `description`, `method`, `path` with `{param}` placeholders, `response` (`json`, `text`, or `wait`), and `params`. Params use snake_case names, `type` (`string`, `integer`, `string_array`, or `object`), `required`, `location` (`path`, `query`, or `body`), optional camelCase `key`, optional `enum`, optional `default`, and optional integer `min`/`max` clamps.
- **`kd-mcp`** exposes kd development workflow tools. Prefer these tools over shelling out when an MCP client has them available.

Do not read or write the SQLite database directly for orchestration. Use `kanna-mcp` first, then `kanna-cli` as the fallback for clients without MCP support.

### Diff viewer

- Modal (Cmd+D), not a tab
- Scopes: Branch (all changes since merge-base with default branch), Last Commit, Working (uncommitted)
- Staged toggle to filter staged-only changes
- Scope remembered per task
- Rendered by `@pierre/diffs` with shadow DOM, syntax highlighting via worker pool

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| ⇧⌘N | New task |
| ⌘D | Diff modal |
| ⌘J | Shell modal |
| ⇧⌘J | Shell at repo root |
| ⌘P | File picker |
| ⌘O | Open in IDE |
| ⌘S | Advance stage / approve (runs the stage's post first; blocked while a post is running) |
| ⇧⌘Delete | Close task |
| ⌘Z | Undo close |
| ⌘Opt+Up/Down | Navigate tasks |
| ⌘B | Toggle sidebar |
| ⇧⌘P | Command palette |
| ⇧⌘E | Tree explorer |
| ⇧⌘Enter | Toggle maximize |
| ⇧⌘A | Analytics |
| ⌘/ | Keyboard shortcuts |
| ⌘, | Preferences |
| Ctrl+- / Ctrl+Shift+- | Back / Forward |
| Escape | Dismiss modal |

All shortcuts work even when the terminal has focus.

### Preferences

| Setting | Default |
|---------|---------|
| Suspend After (minutes) | 5 |
| Kill After (minutes) | 30 |
| IDE Command | code |
| Locale | en |
| Default Agent Provider | claude |

Stored in SQLite `settings` table.

## Package Manager

Use `pnpm` for all package management and script execution. Not npm.

## Monorepo Layout

- `apps/desktop/` — Tauri desktop app (Vue 3 + Rust)
- `packages/core/` — shared TypeScript business logic (pipeline, GitHub, Slack, Discord, config)
- `packages/db/` — database schema types and query helpers
- `crates/claude-agent-sdk/` — Rust wrapper for Claude CLI (NDJSON streaming)
- `crates/daemon/` — PTY daemon (Unix socket, session persistence)
- `crates/kanna-cli/` — sidecar binary for agents to signal stage completion (`kanna-cli stage-complete`) and send input to running tasks (`kanna-cli task send-input`)
- `crates/kanna-hook/` — lightweight binary that signals events to the daemon
- `crates/tauri-plugin-delta-updater/` — self-updater plugin (stub)
- `tests/` — CLI contract tests (`cli-contract/`), PTY test utility (`pty-test/`)
- `scripts/` — build, release, setup, and maintenance scripts
- `tools/kd/` — `kd` CLI and `kd-mcp` self-development workflow server
- `docs/` — planning and spec documents
- `.cargo/config.toml` — sets `target-dir = ".build"` (shared Rust build cache)

## Development Workflow

We develop Kanna **in and on** Kanna — Claude Code agents run from one of three contexts:

1. **Main branch** — the stable Kanna instance at the repo root, used to manage tasks and spawn worktrees
2. **Release build** — installed to `/Applications/Kanna.app`, used when the main branch is being modified
3. **Dev worktree** — a feature branch checked out at `{repoPath}/.kanna-worktrees/task-{uuid}`, running its own isolated dev server

### Worktree isolation

Worktrees are fully isolated from the main branch instance:

- **Separate Vite port** — main uses `localhost:1420`, worktrees get a unique port automatically. The app reads base ports from `.kanna/config.json` `ports` field (e.g., `"KANNA_DEV_PORT": 1420`), picks the next unused offset (1, 2, 3…), and stores the computed port (e.g., `1421`) as `port_env` in the DB. When the worktree's agent session spawns, `KANNA_DEV_PORT` is passed as an env var — no manual editing of `config.json` is needed. `kd dev up` then writes `tauri.conf.local.json` with the port override and passes `--config` to Tauri — the committed `tauri.conf.json` is never modified. Vite also reads `KANNA_DEV_PORT` to set its server port.
- **Separate daemon** — worktrees use `{worktree}/.kanna-daemon/` instead of `~/Library/Application Support/Kanna/`
- **Separate database** — each instance uses its own SQLite DB
- **Separate tmux server** — `kd dev up` uses a tmux server named `kanna-{worktree-dir}` instead of the default `kanna`, and creates the desktop/mobile windows inside a same-named session on that server

This means the main Kanna app and a dev worktree can run simultaneously without port or data conflicts.

### Launching the dev environment

Always use `./kd dev up` to start the dev environment — never run `pnpm run dev`, `pnpm exec tauri dev`, or `cargo tauri dev` directly. `kd` is the canonical self-development surface for agents and humans. It auto-detects the worktree context, sets `KANNA_WORKTREE=1`, derives the worktree DB/daemon/tmux server internally, writes local Tauri config, and runs the desktop/mobile/emulator processes in a background tmux session.

When an MCP client has `kd-mcp` configured, prefer the matching MCP tool over shelling out. The MCP surface mirrors the `kd` tasks for dev up/down/status/log/seed, emulator control, daemon kill, mobile device smoke, and doctor checks. Use the CLI when MCP is unavailable or when the workflow needs an option not exposed through MCP yet.

Prefer the most correct architecture over the shortest patch. If there is a tradeoff between a quick local fix and preserving the right long-term boundary or source of truth, choose the more correct design unless the user explicitly asks for a temporary stopgap. Treat tactical safety fallbacks as temporary, not as the desired end state.

One concrete example: when changing the desktop sidecar build pipeline, preserve shared Rust intermediates when possible, but keep final sidecar binaries and staged `externalBin` inputs private to the current build. Do not let Tauri packaging, daemon launch, or staging read contested final binaries directly from a shared `CARGO_TARGET_DIR`. If a sidecar fix gives every worktree its own full target dir, treat that as a temporary safety fallback, not the preferred end state.

For mobile development, the same rule applies at the app level: use `./kd dev up --mobile` or `./kd mobile up` for end-to-end testing instead of launching Expo directly from `apps/mobile`. The desktop app startup path is what spawns the desktop-side `kanna-server` LAN API on the resolved `KANNA_MOBILE_SERVER_PORT`. Running `pnpm run dev -- --ios` or `expo start` inside `apps/mobile` is only appropriate for UI-only work when the desktop-side mobile server is already running elsewhere; by itself it will not start `kanna-server`, so the mobile app will boot but fail to connect to desktop data.

For physical iPhone dev-build launches, set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME`, then run `./kd mobile run --device` from a worktree. This is the canonical single-command flow: it starts or augments the worktree dev stack with Firebase emulators, relay, desktop, and a resilient dev-client Metro on `KANNA_MOBILE_PORT`; resolves the Mac LAN IP; prints the exact Metro URL (`http://<LAN-IP>:<KANNA_MOBILE_PORT>`); then runs `expo run:ios --device <udid> --port <KANNA_MOBILE_PORT>` with `REACT_NATIVE_PACKAGER_HOSTNAME=<LAN-IP>`. It reuses the kd-managed Metro and does not kill Metro after launch. Use `./kd mobile doctor --device` to run the same on-device preflight without building or launching.

iOS requires a one-time Local Network permission grant for the dev build: Settings -> Privacy & Security -> Local Network -> Kanna = ON. If this permission is denied or dismissed, the app can show "Could not connect to development server" even when the Metro URL is correct. Troubleshooting map: "No script URL provided" means Metro is down or the app launched against the wrong port; "Could not connect to development server" means Metro is down, the phone cannot reach the printed LAN URL, or Local Network permission is off.

Mobile native identity is keyed by `KANNA_APP_ENV` from `apps/mobile/src/mobileEnvironments.json`. The iOS bundle ids are `build.kanna.app.dev` for dev, `build.kanna.app.staging` for staging, and `build.kanna.app` for production; display names are `Kanna Dev`, `Kanna Staging`, and `Kanna`. `./kd mobile run --device` resolves the environment, then runs `expo prebuild --platform ios` with `KANNA_APP_ENV` before invoking `expo run:ios`. This is the standard Expo Continuous Native Generation path: `apps/mobile/app.config.ts` sets `ios.bundleIdentifier`, and `apps/mobile/plugins/withKannaNativeIdentity.js` applies the bundle id and display name to only the `KannaMobile` app target during prebuild. Because Expo config plugins make the Xcode changes during the same prebuild-sync path that `expo run:ios` uses before compiling, there is no runtime `project.pbxproj` patch for Expo to revert; test targets such as WebDriverAgentRunner keep their own bundle ids.

Mobile OTA runtime compatibility is keyed by the `runtimeVersion` value in `apps/mobile/src/mobileEnvironments.json`. Bump this value whenever a change touches native code, native config, the Expo SDK, native dependencies, or `apps/mobile/plugins/withKannaNativeIdentity.js`; JS-only changes keep the same runtimeVersion and are OTA-deliverable.

When asked to launch the mobile app against production, use `./kd mobile up --production`. Production desktop mobile API comes from the installed `/Applications/Kanna.app/Contents/MacOS/kanna-server`, not the current worktree desktop server. The production launch path verifies `curl http://127.0.0.1:48120/v1/status`, checks `~/Library/Application Support/build.kanna/Kanna/server.toml`, starts only the mobile Metro/Expo window, and uses production Firebase/relay defaults from the installed desktop status and mobile app defaults. Plain `./kd mobile up` remains a development workflow that starts the worktree desktop plus mobile; do not assume it targets production.

When targeting staging on a physical iPhone, first distinguish a dev-client launch from a standalone install. Set `KANNA_IOS_DEVICE_UDID` or `KANNA_IOS_PHYSICAL_DEVICE_NAME` for both workflows. Use `./kd mobile run --device --staging` for live development: it starts staging dev-client Metro with `KANNA_APP_ENV=staging`, uses staging Firebase/relay defaults (`kanna-staging`, `wss://relay-staging.kanna.build`), prebuilds the staging native identity, and runs `expo run:ios` with both `--port <KANNA_MOBILE_PORT>` and `RCT_METRO_PORT=<KANNA_MOBILE_PORT>`. The resulting app requires Metro to keep running. Use `./kd mobile run --device --staging --install` when the operator asks to install staging without Metro or wants a self-contained app: it builds, installs, and launches the bundled Release app with `--no-bundler`, and it neither starts nor requires Metro. In both cases the installed `/Applications/Kanna Staging.app` desktop/server is the desktop owner; staging must not start a worktree desktop. Use `./kd mobile up --staging` only when a staging dev-client app is already installed and you only need staging Metro running; it does not install or relaunch a physical iPhone app. To use the committed persistent Buffy the Bug Slayer test identity, a human with `kanna-staging` credentials first provisions the real staging Firebase data with:

```bash
gcloud auth application-default login
pnpm --dir services/firebase-functions exec node scripts/provision-staging-buffy-user.mjs
KANNA_E2E_DEVICE_TOKEN=staging-buffy-device-token ./kd mobile up --staging
```

The script is idempotent: it upserts the Firebase Auth user `upvote.sieve.7t@icloud.com` / `password123` with display name `Buffy the Bug Slayer`, stores the committed avatar reference `file://services/firebase/emulator-seed/assets/buffy-avatar.jpg`, and merges `devices/staging-buffy-device-token` in `kanna-staging` Firestore so the staging relay can authenticate the desktop when that token is supplied. Use `--dry-run` on the script to print the planned Auth user and Firestore document without writing staging data.

```bash
# Development (from repo root or worktree root)
./kd dev up                  # start in tmux (auto-detects worktree)
./kd dev up --mobile         # start desktop + Expo mobile app together
./kd dev up --emulators      # start Firebase emulators + desktop
./kd dev up --seed           # start with seed data (run from a worktree)
./kd dev down                # stop the tmux session
./kd dev down --kill-daemon  # stop tmux and kill workspace daemons
./kd dev restart             # stop + start
./kd dev status              # inspect tmux session status
./kd dev log                 # print recent desktop tmux output
./kd dev log mobile          # print recent mobile tmux output
./kd mobile run --device     # start dev stack + install/launch on a physical iPhone
./kd mobile run --device --staging # install/launch staging dev client; requires staging Metro
./kd mobile run --device --staging --install # install/launch self-contained staging Release app; no Metro
./kd mobile doctor --device  # check physical iPhone Metro reachability, install state, and Local Network guidance
./kd mobile up --production  # start mobile with installed /Applications/Kanna.app production status/relay defaults
./kd mobile up --staging     # start staging Metro only against installed Kanna Staging; does not install/launch a physical iPhone
./kd mobile ota publish --staging     # publish a signed staging JS/asset OTA update
./kd mobile ota publish --production  # publish a signed production JS/asset OTA update
./kd mobile ota status --staging      # inspect the staging OTA channel pointer
./kd mobile ota doctor --staging      # read-only OTA cloud/relay preflight before human device verification
./kd mobile ota provision --staging   # idempotently create staging OTA storage and relay bucket IAM
./kd mobile ota provision-secret --staging --key-path "$HOME/.kanna/secrets/kanna-mobile-ota-v1-private-key.pem"
./kd dev up --attach         # start and attach to tmux session
./kd env print               # print resolved ports, DB, daemon dir, transfer root
./kd doctor                  # check local prerequisites
./kd setup --check           # check prerequisites without installing
./kd clean --all             # remove generated artifacts

# Build
./kd build desktop           # workspace build
./kd build sidecars          # sidecar-only build + staging

# Release
./kd release ship --dry-run  # build/sign release artifacts without publishing
./kd release ship --release  # tag, publish, and upload updater manifest
./kd release ship --staging --release  # publish immutable staging prerelease and repoint desktop-staging/latest-staging.json
./kd release ship --staging --rollback-to 1.2.4-staging.3  # repoint staging channel to an existing prerelease manifest

# Cloud deploy
./kd cloud deploy --staging     # deploy Firebase cloud services to staging
./kd cloud deploy --production  # deploy Firebase cloud services to production

# Canonical automated verification
pnpm test
./kd test rust

# Package-specific unit tests
cd packages/core && pnpm test

# Explicit live/process-heavy suites
# Requires installed and authenticated agent CLIs and may consume quota:
pnpm test:agent-cli-compat
pnpm test:remote-e2e
pnpm test:tui-fidelity

# Rust integration tests (needs claude in PATH)
cd apps/desktop/src-tauri && cargo test --test agent_cli_integration -- --ignored --nocapture

# E2E tests (needs app running in a worktree dev instance)
# Terminal 1: cd {repo}/.kanna-worktrees/task-{uuid} && ./kd dev up --attach
# Terminal 2: cd apps/desktop && pnpm test:e2e

# Mobile Appium E2E (local only)
# Simulator: pnpm --dir apps/mobile run test:e2e:preflight
# Simulator: pnpm --dir apps/mobile run test:e2e:smoke
# Physical device launch: ./kd mobile run --device
# Physical device preflight only: ./kd mobile doctor --device
# Physical device Appium smoke is local/human-only after the app is installed:
# pnpm --dir apps/mobile run test:e2e:device:preflight
# pnpm --dir apps/mobile run test:e2e:device:smoke
# Device smoke reuses an existing kd-managed Metro on KANNA_MOBILE_PORT and
# only stops Metro when the smoke runner started that Metro itself.
# Use KANNA_IOS_DEVICE_UDID for an exact device, or KANNA_IOS_PHYSICAL_DEVICE_NAME
# to target the visible phone name (for example "Jerome's iPhone 15").
# Set one of them when more than one iPhone is attached.
```

### First build in a worktree

The first `./kd dev up` in a fresh worktree compiles ~523 Rust crates (the daemon builds quickly, but the full Tauri app takes several minutes). Subsequent builds are incremental.

### Cloud deployment

Always use `./kd cloud deploy --staging` or `./kd cloud deploy --production` for Firebase backend deployments. Do not run `firebase deploy`, `pnpm exec firebase deploy`, or other Firebase CLI deploy commands directly. If `kd cloud deploy` hangs, hides necessary output, or otherwise fails, fix the `kd` deployment workflow and rerun the deployment through `kd`.

### Mobile OTA updates

Self-hosted mobile OTA updates are served by the relay at `/ota/manifest` and `/ota/assets`, stored in the environment Firebase/GCS bucket under `ota/ios/<runtimeVersion>/`, and code-signed with key id `kanna-mobile-ota-v1`. The public certificate is committed at `apps/mobile/certs/ota-codesign.pem`. Provision the bucket and relay read access idempotently through `./kd mobile ota provision --staging|--production`, then provision the private key through `./kd mobile ota provision-secret --staging|--production --key-path <path>` into Secret Manager as `kanna-mobile-ota-private-key-pem`. Both commands require an explicit environment flag.

Deploy relay support through `./kd cloud deploy --staging|--production --relay`. Publish only through `./kd mobile ota publish --staging|--production`; publishing is separate from infrastructure provisioning. Check pointers with `./kd mobile ota status --staging|--production`. Run read-only cloud and relay preflight with `./kd mobile ota doctor --staging|--production` or the `preflight` alias; this requires Google Cloud credentials for the target project and performs no writes. Roll back by repointing the channel with `./kd mobile ota publish --staging|--production --rollback-to <updateId>`.

## Architecture

- **Tauri commands** in `apps/desktop/src-tauri/src/commands/` — agent, daemon, git, fs, shell
- **Tauri app core** in `apps/desktop/src-tauri/src/lib.rs` — event bridge, reattach coordinator, daemon spawn, macOS integrations
- **Vue composables** in `apps/desktop/src/composables/` — useTerminal, useKeyboardShortcuts, useBackup, etc.
- **Daemon** in `crates/daemon/` — standalone PTY session manager. See `crates/daemon/SPEC.md` for full spec.
- **Agent SDK** wraps Claude CLI via `--output-format stream-json`, communicates via NDJSON on stdin/stdout
- **Agent providers** — the generated registry supports Claude (`"claude"`), GitHub Copilot (`"copilot"`), Codex (`"codex"`), OpenCode (`"opencode"`), and Antigravity (`"antigravity"`, executable `agy`). Claude, Codex, and OpenCode support headless agent sessions; Copilot and Antigravity are PTY-only.
- **Permission mode flags** use camelCase: `dontAsk`, `acceptEdits`, `default` (not kebab-case)
- **Browser mock layer** (`tauri-mock.ts`, `invoke.ts`, `listen.ts`, `dialog.ts`) enables running the frontend in a regular browser without Tauri APIs

### Data flow

```
User creates task → worktree + DB record → daemon Spawn (start reader + headless terminal)
  → daemon forks child (zsh -c "claude ...") → reads PTY output → headless terminal + live Output events
  → frontend AttachSnapshot hydrates xterm.js from the headless terminal, then streams live output

User types → xterm.js onData → invoke("send_input") → daemon Input → PTY write

Claude finishes → PTY shows ❯ idle prompt → Tauri detects ClaudeIdle → app updates task activity

User makes PR → GitHub API → DB update → stage transition
```

## Codebase Overview

### Utilities (`apps/desktop/src/utils/`)

- **`fuzzyMatch.ts`** — VSCode-inspired fuzzy file-path scorer. Multi-part queries (e.g., "comp btn"), bonuses for path separators, camelCase boundaries, consecutive matches, filename boost (+1000). Returns score + matched indices. **Use this instead of writing a new fuzzy search.**
- **`parseRepoInput.ts`** — Parses repo input in any format: local paths, SSH URLs, HTTPS URLs, `owner/repo` shorthand, `gh repo clone` commands. Returns structured `ParsedInput` with normalized clone URL.

### Composables (`apps/desktop/src/composables/`)

| Composable | Purpose |
|---|---|
| `useAnalytics` | Task analytics bucketing (daily/weekly/monthly), operator metrics (response time, dwell time, focus score, switches/hour) |
| `useBackup` | Timestamped DB backups with WAL flush, 7-day retention, periodic interval (4h) |
| `useClaudeUsage` | Regex parser for Claude CLI `/usage` output (session %, week %, dollar spend) |
| `useCustomTasks` | Scans `.kanna/tasks/` for `agent.md` files, abortable via AbortController |
| `useInlineSearch` | Search/filtering for task lists |
| `useKeyboardShortcuts` | Central shortcut registry (30+ actions), context-aware, modifier matching, terminal passthrough filtering |
| `useLessScroll` | Vim/less-style scroll navigation (j/k/f/b/d/u/g/G), skips input elements |
| `useModalZIndex` | Z-index stacking for overlapping modals |
| `useNavigationHistory` | Back/forward stacks (max 50), 1s dwell threshold to skip transient visits |
| `useOperatorEvents` | Emits `app_blur`/`app_focus` on visibility change for analytics |
| `useRestoreFocus` | Restores focus to previous element after modal close |
| `useShortcutContext` | Singleton context manager — components set active context on mount, register supplementary shortcuts |
| `useTerminal` | xterm.js lifecycle, WebGL fallback, Kitty keyboard mode, SIGWINCH redraw on reconnect, debounced fit |
| `useToast` | Toast notifications (max 3 visible, auto-dismiss, configurable duration) |
| `useTreeExplorer` | Miller-columns file browser with caching, vim navigation (j/k/h/l/gg/G), `/` filter mode, 50ms debounced preview, prefetch |

### Components (`apps/desktop/src/components/`)

| Component | Purpose |
|---|---|
| `ActionBar` | PR creation button, conditional on task status |
| `AddRepoModal` | Add repository (create or import tabs) |
| `AgentView` | Claude agent message stream display |
| `AnalyticsModal` | Task and operator analytics charts |
| `BlockerSelectModal` | Task dependency/blocker editor |
| `CommandPaletteModal` | Quick command launcher (`⇧⌘P`) |
| `DiffModal` / `DiffView` | Git diff viewer using `@pierre/diffs` |
| `FilePickerModal` | File open dialog from repo |
| `FilePreviewModal` | File content preview pane |
| `KeyboardShortcutsModal` | Shortcut reference display |
| `MainPanel` | Central task view with terminal tabs or blocked placeholder |
| `NewTaskModal` | Task creation with custom/predefined templates |
| `PreferencesPanel` | Settings (IDE command, timeouts, locale) |
| `ShellModal` | Standalone shell terminal |
| `Sidebar` | Task list navigation (pinned/PR/merge/active/blocked sections) |
| `TagBadges` | Task tag display |
| `TaskHeader` | Task title, branch, PR link, stage |
| `TerminalTabs` | Tab manager for multiple terminal/agent sessions |
| `TerminalView` | xterm.js terminal renderer |
| `ToastContainer` | Toast notification display |
| `TreeExplorerModal` | Miller-columns file explorer |

### Stores (`apps/desktop/src/stores/`)

- **`kanna.ts`** (Pinia) — App state: repo/item selection, sorted items (pinned → merge → pr → active → blocked), debounced activity transitions (unread → idle after 1s), `generateId()` via `crypto.getRandomValues()`, operator event emission, undo support. Key interfaces: `PtySpawnOptions` (agentProvider, model, permissionMode, allowedTools, maxTurns, maxBudgetUsd, setupCmds, portEnv).
- **`db.ts`** — Frontend database compatibility: resolves the database name and exposes the disabled/DEV-E2E `DbHandle` facade. The server owns the schema, migrations, and legacy file-location relocation.

### Tauri Commands (`apps/desktop/src-tauri/src/commands/`)

| Module | Commands |
|---|---|
| `agent.rs` | `create_agent_session` (background drainer), `agent_next_message` (poll buffer), `agent_send_message`, `agent_interrupt`, `agent_close_session`, `get_claude_usage` |
| `daemon.rs` | `spawn_session`, `attach_session_with_snapshot`, `detach_session`, `send_input`, `resize_session`, `signal_session`, `kill_session`, `list_sessions` |
| `fs.rs` | `get_app_data_dir`, `file_exists`, `read_text_file`, `write_text_file`, `copy_file`, `remove_file`, `list_dir`, `list_files` (gitignore-aware), `read_dir_entries`, `read_env_var`, `which_binary`, `ensure_directory`, `append_log` |
| `git.rs` | `git_diff` (staged + unstaged + untracked), `git_diff_range`, `git_merge_base`, `git_worktree_list`, `git_worktree_add`, `git_worktree_remove`, `git_log`, `git_default_branch`, `git_remote_url`, `git_push`, `git_fetch`, `git_clone`, `git_init`, `git_app_info` |
| `shell.rs` | `ensure_term_init` (ZDOTDIR proxy), `run_script` |

### Tauri App Core (`apps/desktop/src-tauri/src/lib.rs`)

- **Event bridge** (`spawn_event_bridge`) — background task subscribing to daemon events, auto-reconnects with exponential backoff on daemon restart, emits Tauri events: `terminal_output`, `session_exit`, `hook_event`, `status_changed`, `daemon_ready`
- **Reattach coordinator** (`spawn_reattach_coordinator`) — listens to `daemon_ready`, re-attaches all tracked sessions, sends Resize to trigger SIGWINCH for Claude TUI redraw
- **Daemon spawn** (`ensure_daemon_running`) — searches for sidecar binary, spawns with `setsid`, waits for PID file match, handles worktree isolation
- **macOS fn+F fullscreen** — native event monitor intercepts fn+F without Cmd/Ctrl/Option to toggle fullscreen
- **PATH resolution** (`fix_path_from_shell`) — runs interactive login shell to capture real PATH (fixes Spotlight-launched app's minimal PATH)
- **Terminal output patterns** — strips ANSI from PTY output to detect: "Interrupted", "Do you want to allow", Copilot idle/thinking states; broadcasts as hook events
- **State:** `AgentState` (DashMap of buffered sessions), `DaemonState` (shared daemon connection), `AttachedSessions` (tracks active output streams)

### Packages

**`@kanna/core`** (`packages/core/src/`):
- `pipeline/types.ts` — `SYSTEM_TAGS`, `parseTags()`, `hasTag()` (safe JSON parse, never throws)
- `config/repo-config.ts` — `parseRepoConfig()` from `.kanna/config.json`
- `config/custom-tasks.ts` — `parseAgentMd()` frontmatter parser, slug-to-name conversion
- `config/custom-tasks-scanner.ts` — Scans `.kanna/tasks/` with smart empty-file skipping
- `slack/` — `SlackClient` (postMessage, fetchHistory)
- `discord/` — `DiscordClient` (postMessage, fetchHistory)

**`@kanna/db`** (`packages/db/src/`):
- `schema.ts` — TypeScript types mirroring all SQLite tables
- `queries.ts` — Abstracted query layer over `DbHandle` interface. Includes: CRUD for repos/items/sessions, JSON tag management, `hasCircularDependency()` (DFS cycle detection for task blockers), `getUnblockedItems()`, analytics aggregation, `getSetting`/`setSetting`

### Rust Crates

- **`claude-agent-sdk`** — Session builder pattern, NDJSON stream parsing, permission callbacks, `find_claude_binary()`. Types: `PermissionMode` (`DontAsk`/`AcceptEdits`/`Default`), `ThinkingMode`, `Effort` levels. Bidirectional control protocol: app sends Interrupt/SetModel/SetPermissionMode, CLI sends CanUseTool for permission checks.
- **`daemon`** — Raw libc PTY, Unix socket NDJSON protocol, SCM_RIGHTS fd transfer for handoff, session manager with spawn/attach/detach/resize/signal/kill.
- **`tauri-plugin-delta-updater`** — Self-updater plugin (stub).

### Key Third-Party Libraries

| Library | Usage | Notes |
|---|---|---|
| `@pierre/diffs` | Diff rendering | Use `containerWrapper` not `fileContainer`, `worker-portable.js` not `worker.js` |
| `xterm.js` (6.x beta) | Terminal UI | With fit, image, serialize, web-links, webgl addons |
| `shiki` | Syntax highlighting | Used for code preview |
| `pinia` | State management | Single store in `kanna.ts` |
| `markdown-it` | Markdown parsing | With strikethrough-alt, task-lists plugins |
| `vue-chartjs` + `chart.js` | Charts | Analytics modal |
| `vuedraggable` | Drag-drop | Task reordering |
| `@vueuse/core` | Composable utilities | `computedAsync`, etc. |
| `vue-i18n` | i18n | Locale support |
| `git2` (Rust) | Git operations | Fully vendored (libgit2 + OpenSSL) |

### Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `install.sh` | Download and install latest release from GitHub (DMG, arch auto-detect) |
| `app-update-full-bundle-e2e.sh` | Specialized full-bundle updater E2E helper, invoked through `./kd test app-update-bundle` |
| `setup-worktree.sh` | Minimal task setup helper used as repo-config fixture/input |
| `stage-terminal-recovery-runtime.sh` | Low-level runtime staging helper for terminal recovery assets |
| `repo-config.test.sh` / `setup-worktree.sh.test.sh` | Shell-level fixture tests for shell-specific helpers |

### Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `KANNA_DEV_PORT` | vite.config.ts, kd | Dev server port (default 1420) |
| `KANNA_WORKTREE` | kd → runtime | Flag: running in a worktree |
| `KANNA_DB_NAME` | kd → stores/db.ts | Resolved SQLite filename for the current instance |
| `KANNA_DAEMON_DIR` | kd → daemon | Resolved daemon data directory for the current instance |
| `KANNA_GITHUB_TOKEN` | core/github | GitHub API auth |
| `KANNA_SLACK_TOKEN` | core/slack | Slack API auth |
| `KANNA_DISCORD_TOKEN` | core/discord | Discord API auth |
| `KANNA_VERSION` | daemon build.rs | Compile-time version from git |

### Database Tables

| Table | Key Columns |
|---|---|
| `repo` | id, path, name, default_branch, hidden |
| `pipeline_item` | id, repo_id, prompt, pipeline, stage, pr_number/url, branch, activity, port_env (JSON), pinned, pin_order, display_name, agent_type, agent_provider, base_ref, issue_number, issue_title, closed_at, notify_task_id, notified_at, parent_task_id, pipeline_def, port_offset |
| `task_blocker` | blocked_item_id, blocker_item_id |
| `worktree` | id, pipeline_item_id, path, branch |
| `terminal_session` | id, repo_id, pipeline_item_id, label, cwd, daemon_session_id |
| `agent_run` | id, repo_id, agent_type, status, started_at, finished_at |
| `settings` | key, value |
| `activity_log` | id, pipeline_item_id, activity, started_at |
| `operator_events` | id, event_type, pipeline_item_id, repo_id |

## Daemon

- Raw libc PTY (not portable-pty) — needed for `SCM_RIGHTS` fd handoff
- Always spawned fresh on app start, handoff from old daemon preserves sessions
- App waits for new daemon's PID file before connecting (prevents stale connections)
- One reader per session. New spawned sessions start the reader at Spawn; adopted handoff sessions start it on first AttachSnapshot.
- **Headless terminal authority** — detached PTY output is interpreted into the per-session headless terminal. There is no pre-attach raw byte buffer.
- **Broadcast output** — all attached clients receive output simultaneously; AttachSnapshot adds a live writer without creating new readers
- **Terminal size coordination** — effective PTY dimensions are `min(cols)` × `min(rows)` across all attached clients
- No raw scrollback replay — reconnection hydrates xterm.js from the headless terminal snapshot, then streams live output
- Logs to `~/Library/Application Support/Kanna/kanna-daemon_*.log` via flexi_logger
- `KANNA_DAEMON_DIR` env var overrides data directory (used by tests)
- Protocol: line-delimited JSON over Unix socket. Commands include Spawn, AttachSnapshot, Detach, Input, Resize, Signal, Kill, List, Subscribe, Handoff, HookEvent

### Daemon invariants

1. **One daemon at a time.** New daemon always replaces the old one.
2. **Always handoff.** New daemon transfers sessions from old daemon via SCM_RIGHTS.
3. **Always spawn.** App always starts a fresh daemon. Never reuses existing.
4. **Always wait.** App waits for the new daemon's PID before connecting.
5. **Sessions survive upgrades.** Child processes are unaware of daemon restarts.
6. **One reader per session.** Single `stream_output` task; spawned sessions start it immediately, adopted sessions start it on first AttachSnapshot.
7. **Headless terminal is authoritative while detached.** AttachSnapshot atomically snapshots that state and joins the live output stream.

### App startup sequence

1. App spawns new daemon binary (detached via `setsid`)
2. New daemon detects old daemon, performs handoff (fd transfer), old daemon exits
3. New daemon writes PID file and binds socket
4. App polls PID file until it matches the spawned child
5. App clears stale command connection (`DaemonState`)
6. App connects to new daemon (event bridge + on-demand command connection)
7. Frontend mounts terminals, calls AttachSnapshot → Resize → live stream resumes

## Database

`kanna-server` owns SQLite through bundled `rusqlite`, with all schema definitions and schema migrations in `crates/kanna-server/src/db/mod.rs`. Server startup owns legacy file-location relocation and completes it before calling `Db::open_migrated` and serving requests. Desktop `stores/db.ts` only resolves the database name and provides the disabled/DEV-E2E `DbHandle` facade for compatibility. See the Database Tables inventory in the Codebase Overview section for the full table list.

DB name is resolved by `kd` from the current context: main instances use `kanna-v2.db`, and worktrees auto-name their DB `kanna-wt-{worktree-dir}.db` (for example `kanna-wt-task-10720bf8.db`). In the current checked-in dev build, Tauri's app identifier is `build.kanna`, so the default DB directory is `~/Library/Application Support/build.kanna/`. If the app identifier changes for another build flavor, the enclosing Application Support directory changes with it.

## Testing

- **Unit tests:** vitest in `packages/core/`, `packages/db/`, and `apps/desktop/src/composables/` (useBackup, useInlineSearch, useNavigationHistory, useShortcutContext have `.test.ts` files)
- **Integration tests:** Rust tests in `apps/desktop/src-tauri/tests/` (real Claude CLI)
- **Daemon tests:** `crates/daemon/tests/` — handoff and reconnect tests with real daemon processes
- **CLI contract tests:** `tests/cli-contract/tests/offline/` runs under canonical `pnpm test`; real Claude, Copilot, Codex, and OpenCode compatibility lives in `tests/cli-contract/tests/live/` and runs only through `pnpm test:agent-cli-compat` because it requires installed/authenticated CLIs and may consume quota
- **E2E tests:** `pnpm test:e2e` + W3C WebDriver via `tauri-plugin-webdriver` on port 4445
  - Mock tests (`apps/desktop/tests/e2e/mock/`): action-bar, app-launch, diff-view, import-repo, keyboard-shortcuts, preferences, task-lifecycle
  - Real tests (`apps/desktop/tests/e2e/real/`): claude-session, diff-after-claude (requires Claude CLI)
- E2E tests access Vue internals via `__vue_app__._instance.setupState` — dev builds only
- WebDriver is only available in debug builds (`#[cfg(debug_assertions)]`)

### E2E coverage expectation

Any behavior that crosses component or system boundaries should add or update at least one E2E test.

Typical triggers include:

- UI flows, navigation, and interactive user journeys
- frontend or mobile client interactions with server or backend APIs
- daemon, PTY, process, filesystem, git, or network behavior
- persistence, reload, reconnect, or recovery behavior
- asynchronous coordination where isolated tests do not prove the real wiring

Unit and integration tests remain important, but they are not a substitute when the risk is in the wiring between systems.

If a behavior should have E2E coverage but cannot reasonably get it yet, the change must explicitly document:

- why it is not yet testable end to end
- what would be needed to make it testable
- what narrower tests were added in the meantime

## Conventions

- Task stage is tracked via `pipeline_item.stage` (e.g., `'in progress'`, `'commit'`, `'pr'`). Visibility is governed by `closed_at`; closed tasks keep their last stage. Blocked display state derives from `task_blocker`, not tags.
- Git worktrees created at `{repoPath}/.kanna-worktrees/task-{uuid}`
- Branch names: `task-{id}` at creation; stage forks append a workspace counter (`task-{id}-2`, `task-{id}-3`, …)
- GitHub labels: `kn:wip`, `kn:pr-ready`, `kn:claimed`
- API tokens from env: `KANNA_GITHUB_TOKEN`, `KANNA_SLACK_TOKEN`, `KANNA_DISCORD_TOKEN`
- Agent provider IDs: `"claude"`, `"copilot"`, `"codex"`, `"opencode"`, and `"antigravity"` — generated from `crates/kanna-agent-protocol/src/providers.rs` and stored in `pipeline_item.agent_provider`
- i18n locales: English (`en`), Japanese (`ja`), Korean (`ko`) in `apps/desktop/src/i18n/locales/`
- Keyboard shortcut contexts: `"main"`, `"diff"`, `"file"`, `"shell"`, `"tree"` — managed by `useShortcutContext`
- `.kanna/` per repo — project-level Kanna config:
  - `config.json` — `setup` (commands run in each new worktree), `teardown` (cleanup commands run best-effort in a workspace whenever the task leaves it: stage-transition forks, advancing past the final stage, and task close), `test` (test commands), `ports` (env var → base port mapping), `pipeline` (default pipeline name)
  - `agents/{name}/AGENT.md` — agent definitions (YAML frontmatter + markdown body). Built-in agents ship as Tauri resources; per-repo files override built-ins by name.
  - `agents/{name}/EXTEND.md` — repo-local agent extension layered onto the resolved agent (repo override or built-in): the body is appended to the agent prompt and optional frontmatter fields (`description`, `model`, `permission_mode`, `allowed_tools`, `agent_provider`) replace the base's. Lets a repo customize a default agent without rewriting it (e.g. this repo's `review/EXTEND.md` requires the full unit & integration suites). Extensions are read only from the open repo, never from bundled resources.
  - `pipelines/{name}.json` — pipeline definitions (stages, environments, stage policies). Built-in `default.json` ships as Tauri resource.
  - `tasks/{slug}/agent.md` — custom task templates with YAML frontmatter (prompt, model, permissions, allowed tools)

## Working on the Codebase

### Trace before you touch

Before fixing a bug or adding a feature, trace the complete data flow for the affected feature: DB → store → component → composable → daemon. Read all files in the path before proposing changes. A fix that only looks at one layer will break another.

For example, a task close/undo touches: `queries.ts` (DB), `kanna.ts` (store), `Sidebar.vue` (visibility), `TerminalTabs.vue` (component lifecycle), `useTerminal.ts` (attach/detach), and the daemon (PTY sessions). Changing one without understanding the others leads to piecemeal hacks.

### Improve the architecture

Changes should leave the architecture cleaner than you found it. Adding a hack to work around a design problem is not acceptable — fix the design instead. If a fix requires a polling loop, a retry timer, or duplicating logic that already exists elsewhere, that's a signal the approach is wrong.

When something doesn't work, find the architectural reason and fix it at the right layer:
- If a component needs to react to a state change, make sure the lifecycle handles it (mount/unmount/watch) — don't add manual triggers from the store.
- If two systems disagree on the source of truth (e.g., `stage` vs `closed_at` for visibility), pick one and make everything use it.
- If a resource needs cleanup, clean it up where the lifecycle owns it — don't leave stale state for another layer to work around.

### Server-side completion notify boundary

`kanna-server` subscribes directly to daemon terminal-state events and treats daemon `Exit` for a task session as the headless completion signal. That path updates task activity to `unread`, claims `pipeline_item.notify_task_id` by setting `notified_at`, and delivers `TASK <child-id> DONE [success|failure]: <title>` through the same two-step input submission helper used by `/v1/tasks/{task_id}/input`. Keep this boundary server/daemon-side; do not depend on the desktop frontend event bridge being open for completion notifications.

Current E2E status: notify has server boundary coverage with a fake daemon asserting the exact two `Input` writes and the once-only DB guard. A full desktop E2E would require a runnable daemon plus agent task that exits under the packaged app/WebDriver harness; add that when the E2E harness can deterministically drive agent completion without external Claude/Copilot credentials.

## Coding Style

### TypeScript

- **Never use `any`.** Use `unknown`, generics, proper interfaces, or type assertions to a specific type. If you're tempted to use `any`, you haven't modeled the type yet. Existing `any` usage is tech debt, not precedent.
- **Run `pnpm exec tsc --noEmit`** before considering TypeScript work done. Fix all type errors — don't suppress them with `@ts-ignore` or `as any`.
- **Prefer `interface` over `type`** for object shapes. Use `type` for unions, intersections, and mapped types.
- **No non-null assertions (`!`)** unless the surrounding code makes the guarantee obvious (e.g., immediately after an existence check in the same scope).

### Rust

- **Run `cargo clippy`** and fix all warnings. Clippy is right until proven otherwise.
- **No `unwrap()` in production code.** Use `?`, `unwrap_or`, `unwrap_or_else`, or proper error handling. `unwrap()` is acceptable in tests.
- **Run `cargo fmt --all` from the repo root** before committing Rust changes. The repo pins the Rust formatter via `rust-toolchain.toml`.

### Vue

- Use `<script setup lang="ts">` for all components.
- Props and emits must be typed — use `defineProps<{}>()` and `defineEmits<{}>()`, not the runtime declaration.
- Prefer composables (`use*`) over mixins or provide/inject for shared logic.
- Prefer reactive style — use `computed()` and `watch`/`watchEffect` over imperative functions that manually read and return ref values. Derived state should be a `computed`, not a function call.

### General

- No `console.log` left in committed code. Use the app's frontend log forwarding for debug output, and remove before committing.
- Catch blocks must log or re-throw — never swallow errors silently.

## UI

- **Keyboard shortcuts** use one `<kbd>` per key: `<kbd>⇧</kbd><kbd>⌘</kbd><kbd>N</kbd>`, not `<kbd>⇧⌘N</kbd>`. Use `kbd + kbd { margin-left: 2px }` for spacing.

## Versioning

Single `VERSION` file is the source of truth for packaged app versioning. Production `kd release ship --release` updates `VERSION`, `tauri.conf.json`, and Rust package metadata, commits them, tags `vX.Y.Z`, and publishes a per-version GitHub release. Staging ships do not persist version bumps: each `--staging` ship builds with `X.Y.Z-staging.N`, publishes an immutable prerelease tagged `vX.Y.Z-staging.N`, uploads a manifest copy there, and then clobbers only `latest-staging.json` on the pointer release tagged `desktop-staging`. Development builds may include separate branch/worktree metadata in the UI, but that metadata is not the packaged version. Package.json versions are all `0.0.0` (meaningless). The desktop app reads `VERSION` at compile time via `build.rs`.

## Common Pitfalls

- Claude CLI permission mode flags are **camelCase** (`dontAsk` not `dont-ask`). The SDK was broken by this once already.
- `@pierre/diffs`: use `containerWrapper` (not `fileContainer`) in `FileDiff.render()` — `fileContainer` skips the shadow DOM and loses all styling. Use `worker-portable.js` (not `worker.js`) to avoid WASM dependency. Theme/lineDiffType go in worker pool options, not FileDiff constructor (ignored when using pool).
- `git_diff` must include untracked files (`include_untracked`, `recurse_untracked_dirs`, `show_untracked_content`) or new files created by Claude won't appear in the diff view.
- The agent SDK pipes stderr to capture (not null) — check stderr output when debugging silent CLI failures.
- `tauri-plugin-webdriver` on port 4445 for E2E testing. Only works in debug builds on macOS WKWebView.
- Daemon must be detached from app process group (`setsid` via `pre_exec`) or Ctrl+C kills it.
- End-to-end mobile runs must start from `./kd dev up --mobile` or `./kd mobile up`. Launching Expo directly from `apps/mobile` does not start the desktop-side `kanna-server`, so the resolved `KANNA_MOBILE_SERVER_PORT` will be down unless the desktop app is already running.
- Frontend console logs are written to `/tmp/kanna-webview-*.log` via the log forwarding in [`apps/desktop/src/main.ts`](apps/desktop/src/main.ts) and the Tauri `append_log` command in [`apps/desktop/src-tauri/src/commands/fs.rs`](apps/desktop/src-tauri/src/commands/fs.rs). Each instance gets its own log file: worktrees use the directory name (for this worktree: `/tmp/kanna-webview-task-348cf000.log`), while main instances use a cwd path hash (for example `kanna-webview-1a2b3c4d.log`).
- Prefer the most correct architecture over the shortest patch. Use temporary safety fallbacks only when necessary, and document them as fallbacks rather than as the intended steady state.
- Rust build artifacts go to `.build/` (not `target/`) — configured in `.cargo/config.toml`.
- Sidecar build changes should preserve shared Rust caches when possible, but final sidecar binaries used for staging, packaging, or daemon launch must come from a build-private `.build/` path rather than a contested shared final artifact path.
- Terminal output must be ANSI-stripped before pattern matching — raw escape sequences (colors, cursor movement) interfere with hook detection.
- The event bridge auto-reconnects to daemon with exponential backoff — don't add manual retry logic on top.
- KeepAlive is used for ShellModal to preserve xterm buffer across task switches — use `v-show` not `v-if` for terminal-containing components.
- `agent_next_message` uses a polling pattern — frontend calls it repeatedly to drain the buffered message queue from the background drainer task.
- Revisions resume by default: `request_revision` reopens the target stage's previous Claude agent session (`--resume <stage_run.provider_session_id>`) inside that run's own worktree — Claude CLI transcripts are keyed by working directory — and moves `pipeline_item.branch` back to it. Kanna composes the message from the original task prompt plus the reviewer's feedback. Any failed precondition (non-Claude provider, missing transcript, worktree gone, or its tip diverged from the committed one) falls back to the fresh fork below; resumed runs record `stage_run.resumed_from_run_id`. Claude PTY spawns assign the session id upfront (`--session-id`), recorded on `stage_run.provider_session_id`/`cwd` and mirrored to `pipeline_item.agent_session_id`.
- Stage advance is durable on the task but forks the workspace. If the current stage declares a `post`, advancing (⌘S or an auto main-run success) injects the post prompt into the running agent session (`stage_run` row with `kind: "post"`; the task's stage and workspace do not change); when that post run completes with success, the engine performs the transition. A transition kills the task's daemon session (and the stale worktree shell), forks a new branch + worktree from the current branch's committed tip, respawns the same session id with the next stage's agent there, and moves `pipeline_item.stage`/`branch` — no new task is ever created; advancing past the final stage closes the task. Reruns keep the current workspace; a dead-session post falls back to spawning its `agent` binding in the current workspace. Legacy `post_action` and `policy.execution: "continue"` pipeline JSON (including pinned `pipeline_def` snapshots) compiles into stage posts at load time. `$BRANCH` in a stage prompt resolves to the freshly forked branch; `$SOURCE_WORKTREE` points at the previous stage's worktree.
- Built-in agent/pipeline definitions must ship as Tauri bundled resources, not as TypeScript string constants. Definitions live in `.kanna/` files — the app reads them at runtime via the resource directory fallback.
