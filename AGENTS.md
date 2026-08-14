# AGENTS.md

Kanna is a distributed system, not a single program. It runs coding agent tasks
in parallel — each task gets its own git worktree, branch, agent session, and
workflow stage — across parts that start, crash, upgrade, and ship
independently:

- a **macOS desktop app** (Tauri v2, Vue 3 + Rust) — the operator's UI
- a **PTY daemon** that outlives the app, so agent sessions survive restarts
  and upgrades
- **`kanna-server`**, which owns SQLite and serves the local and LAN APIs
- **agent CLIs** (`claude`, `codex`, `copilot`, `opencode`, `agy`) spawned per
  task, each in its own worktree
- a **mobile app** plus the **cloud services** (relay + Firebase) that let it
  reach the desktop from off-network

Separate processes mean separate lifecycles and separate failure modes. Most
non-trivial changes cross at least one of these boundaries, so treat a change
as a change to a system: find out who else consumes the surface you are
touching, and never assume "the app" is one process.

The desktop app ships to end users as a signed macOS app: **all dependencies
must be vendored or statically linked** — never depend on anything installed on
the build machine (e.g. Homebrew). Release builds must run on a Mac with no
developer tools installed.

This file is the canonical conventions document — binding for humans and
agents alike. It deliberately holds only what you cannot get from the code:
contracts, non-obvious conventions, and hard-won pitfalls. Everything else is
a reference below.

## Where to look

| Need | Read |
|---|---|
| How the system fits together, components, data flow | `docs/dev/architecture.md` |
| Running the app, `kd` commands, worktree isolation, debugging | `docs/dev/dev-workflow.md` |
| First-time setup and prerequisites | `docs/dev/getting-started.md` |
| Test taxonomy and what to run when | `docs/dev/testing.md` |
| Versioning, staging/production ships, promotion, mobile OTA | `docs/dev/release.md` |
| UI flows, close semantics, shortcuts, preferences | `docs/dev/product-behavior.md` |
| PTY daemon contract — invariants, handoff, lifecycle | `crates/daemon/SPEC.md` |
| Server boundary and v1 LAN API surface | `docs/kanna-server-boundary.md` |
| Mobile app, OTA operations | `apps/mobile/`, `docs/specs/mobile-ota-updates.md` |
| Feature specs (merge master, task graph, QA dispatch, RCs) | `docs/specs/` |
| Every DB table and migration | `crates/kanna-server/src/db/mod.rs` |
| Agent provider registry | `crates/kanna-agent-protocol/src/providers.rs` |
| Built-in workflows and agents | `.kanna/workflows/*.json`, `.kanna/agents/*/AGENT.md` |

Tests are executable specs — prefer reading them over prose: `tools/kd/tests/`
for release and dev-CLI behavior, `crates/daemon/tests/` for handoff and
reconnect, `tests/cli-contract/` for agent CLI compatibility.

## Core concepts

- **Task** — a unit of work: a prompt, a git worktree, an agent session, and a
  lifecycle stage. One task = one branch = one PR.
- **Workflow** — an ordered list of stages, each with an agent, an optional
  environment, a stage policy, and an optional `post`. Every built-in runs
  `in progress` (post: `commit`) → … → `pr` (post: `approve`); what varies is
  the review stage between them (see "Built-in workflows" below).
- **Workspace** — the ephemeral manifestation of a task. Tasks are durable
  (same id, run history, blockers), but **every stage transition forks a fresh
  workspace**: a new branch + worktree `task-{id}-{n}` cut from the previous
  stage's committed tip. N worktrees, N branches, one PR. **Only committed
  work crosses a stage boundary.** When a task leaves a workspace, that
  workspace's repo-config `teardown` commands run best-effort in a detached
  `td-{branch}` daemon session; open-task worktrees stay available for revision
  resume until the task closes.
- **Post** — tail work injected into the stage's *running* agent session before
  the transition. Stages fork workspaces and swap sessions; posts continue them.
- **Daemon** — standalone process managing PTY sessions. Survives app restarts.

Advancing past the final stage closes the task. Close snapshots dirty state
into local WIP commits, removes the task's worktrees, and **keeps the
branches** — close never deletes a branch.

Built-in workflows, by review depth: `no-review` (no review stage — the
fallback when a repo names none), `single-reviewer` (one `review` agent), and
`specialized-reviewers` (a dispatched specialty panel). `specialty-review` is
not a choice: it is the single-stage workflow the dispatcher gives its child
tasks, and its definition declares `"visibility": "internal"`, so it resolves
by name but never reaches the repo manifest, the new-task picker, or the tool
catalog's advertised lineup. Visibility is declared by the definition itself —
a top-level `visibility` field (`public` | `internal`, default `public`) in a
workflow JSON, or the same key in AGENT.md frontmatter (the `commit` and
`approve` stage posts declare `internal`; EXTEND.md may override it) — and it
governs listing only, never resolution: an internal name always works when
passed explicitly. The effective definition decides, so a repo file shadowing
an internal built-in must re-declare `"visibility": "internal"` to stay
unlisted; omitting the field deliberately promotes the name to a choice.
The `specialized-reviewers` review stage fans specialty reviews out as child tasks and
aggregates their verdicts against a scope bar — see
`docs/specs/qa-dispatch-review.md`.

## Task management: use the MCP tools

**Do not read or write the SQLite database directly for orchestration.** Use
`kanna-mcp` (`kanna_*` tools, backed by the local API on `127.0.0.1:48120`)
first, and `kanna-cli` only as the fallback for clients without MCP support.
`kd-mcp` exposes the dev workflow the same way — prefer it over shelling out.

Both are registered in `.mcp.json`. Their tool surface is generated from
`crates/kanna-tool-catalog`, the single declarative source of truth shared
with `kanna-cli`; `kanna-mcp` hot-reloads an override catalog and emits
`notifications/tools/list_changed` when it changes.

## Agent execution

**PTY mode (default)** — the agent CLI runs in a real terminal via the daemon;
the user sees the TUI and can type. Lifecycle events arrive as hooks.
**SDK mode** — headless with `--output-format stream-json`, NDJSON on
stdin/stdout, non-interactive.

To send input to a running task:
`kanna-cli task send-input --task-id <TASK_ID> --message "..."`.

## Mobile

`apps/mobile` is an Expo / React Native companion app — a first-class client,
not an accessory. It reads desktop data from `kanna-server`: directly over the
LAN (`KANNA_MOBILE_SERVER_PORT`) when on the same network, or through the
relay (`services/relay`, Firebase-authenticated) when remote. Anything you add
to the server's surface may have a mobile consumer.

Two contracts that are easy to break:

- **Bump `runtimeVersion` in `apps/mobile/src/mobileEnvironments.json` whenever
  a change touches native code, native config, the Expo SDK, native
  dependencies, or `apps/mobile/plugins/withKannaNativeIdentity.js`.** JS-only
  changes keep the same `runtimeVersion` and are OTA-deliverable. Shipping an
  OTA update against a stale `runtimeVersion` pushes JS to incompatible native
  code. Replacing the embedded OTA signing certificate counts as native config
  — bump *every* environment.
- **Native identity is keyed by `KANNA_APP_ENV`**, applied during
  `expo prebuild` by the config plugin above (dev / staging / production get
  distinct bundle ids and display names). Don't hand-patch `project.pbxproj`;
  Expo regenerates it.

Run it through `kd` (`./kd dev up --mobile`, `./kd mobile run --device`) — bare
`expo start` does not start the desktop-side `kanna-server`. Details and device
troubleshooting: `docs/dev/dev-workflow.md`; OTA operations:
`docs/specs/mobile-ota-updates.md`.

## Daemon handoff security

At startup, while the app is still its live direct parent, the daemon records
kernel-derived executable paths for itself and the app launcher. For every
supported v3 or legacy-v2 `Handoff`, the sender pins `LOCAL_PEERPID` and the
peer's live direct parent by PID/start time, matches both executable paths, and
rechecks the identities and paths before acquiring daemon-lifecycle ownership,
sealing registries, snapshotting, writing `HandoffReady`, or sending any fd.
The receiver separately retains its old-daemon peer/start-time check before
acknowledging transferred descriptors.

## Conventions

- Task stage lives in `pipeline_item.stage`. **Visibility is governed by
  `closed_at`, not stage** — closed tasks keep their last stage. Blocked
  display state derives from `task_blocker`, not tags.
- Worktrees at `{repoPath}/.kanna-worktrees/task-{uuid}`; branches `task-{id}`,
  with stage forks appending a counter (`task-{id}-2`, …).
- GitHub labels: `kn:wip`, `kn:pr-ready`, `kn:claimed`.
- Tokens from env: `KANNA_GITHUB_TOKEN`, `KANNA_SLACK_TOKEN`,
  `KANNA_DISCORD_TOKEN`.
- Rust build artifacts go to `.build/`, not `target/` (`.cargo/config.toml`).
- Use `pnpm`. Not npm.
- **Always start the dev environment with `./kd dev up`** — never `pnpm run dev`,
  `pnpm exec tauri dev`, or `cargo tauri dev`. `kd` is the canonical
  self-development surface: it derives the worktree's ports, DB, daemon dir,
  and tmux identity. Same rule for deploys (`./kd cloud deploy`, never
  `firebase deploy`) and mobile (`./kd dev up --mobile` / `./kd mobile up`,
  never bare `expo start` — it won't start the desktop-side `kanna-server`).
  If a `kd` workflow is broken, fix `kd` rather than working around it.
- Production promotions and production mobile OTA publishes require an explicit
  human request. Staging is free for agents — but the staging *channel* is a
  lineage, not a scratch pad: `kd` refuses a staging publish that diverges from
  or rolls back the candidate `desktop-staging` already serves, refuses main
  publishes while an unpromoted `release/X.Y` candidate soaks, and gates
  promotion on lineage validity plus the `release-policy.json` soak window
  (default 24h). The three operations that discard that state —
  `kd release reset-staging`, `kd release cut --abandon-series`, and
  `kd release promote --override-soak` — need a named human request like
  production does. See `docs/specs/release-candidates.md`.
- Use `apps/desktop/src/utils/fuzzyMatch.ts` instead of writing a new fuzzy
  search.
- `.kanna/` is per-repo config: `config.json` (`setup`, `teardown`, `test`,
  `ports`, `workflow`, and `agentProviders`, whose exact agent names or `*`
  globs select a provider plus an optional model), `workflows/{name}.json`,
  `agents/{name}/AGENT.md` (repo files override built-ins by name),
  `agents/{name}/EXTEND.md` (layers onto the resolved agent without rewriting
  it — read only from the open repo, never from bundled resources), and
  `tasks/{slug}/agent.md` templates. Its `config.schema.json` is the public
  schema served at
  `https://schemas.kanna.build/config.schema.json`; merging a change to it on
  `main` publishes it automatically via
  `.github/workflows/config-schema-pages.yml`, which builds the artifact with
  `./kd pages build-schema` and deploys it to Pages. There is no publish
  command — the repo's Pages source is "GitHub Actions" (see
  `docs/dev/dev-workflow.md`).
  Provider/model precedence is an explicit task or stage override, then the
  repo's matching `agentProviders` entry, then layered `AGENT.md`/`EXTEND.md`
  frontmatter, then the global default provider setting. Exact map keys beat
  globs; among globs, the most non-`*` characters wins and lexical order breaks
  ties.
- `config.json` has a machine-local companion, `.kanna/config.local.json`:
  gitignored, read from the **open repo's working tree** rather than the origin
  snapshot, and deep-merged over the committed config with local winning — so a
  wedged provider is reordered on one machine in seconds instead of through a
  merge to `origin/main`. It occupies the `agentProviders` slot in the
  precedence chain above, so an explicit task or stage override still wins.
  Only `agentProviders`, `workflow`, `ports`, `setup`, `teardown`, and `test`
  may be set; `vars`, `flavors`, `workspace`, `stage_order`, and the
  `reserved_port*` keys are deliberately excluded, because they change what a
  task *means* rather than how one machine runs it. `agentProviders` and
  `ports` merge entry by entry (local replaces the entry of that name, others
  survive); every other key replaces outright, and arrays never concatenate.
  Anything else in the file — an unknown key, a bad value, invalid JSON — fails
  definition resolution with an error naming the file. Provenance is always
  reported: the server logs the file and its keys at resolution, the repo
  manifest carries them as `config.localOverride`, and every PTY spawn prints
  them before setup runs. See `docs/dev/dev-workflow.md`.
- Built-in agent/workflow definitions must ship as Tauri bundled resources,
  **not** as TypeScript string constants.

## Database

`kanna-server` owns SQLite through bundled `rusqlite`; schema and migrations
live in `crates/kanna-server/src/db/mod.rs`, and server startup completes
legacy file relocation before serving. Desktop `stores/db.ts` only resolves the
database name and provides the disabled/DEV-E2E `DbHandle` facade.

`kd` resolves the DB name from context: main instances use `kanna-v2.db`;
worktrees auto-name theirs `kanna-wt-{worktree-dir}.db`. The dev build's Tauri
identifier is `build.kanna`, so the default directory is
`~/Library/Application Support/build.kanna/`.

## Working on the codebase

**Trace before you touch.** Before changing a feature, trace its complete data
flow — DB → server → store → component → composable → daemon — and read every
file in the path. A fix that only looks at one layer breaks another. A task
close/undo, for example, touches the DB layer, the store, `Sidebar.vue`,
`TerminalTabs.vue`, `useTerminal.ts`, and the daemon.

**Fix designs, not symptoms.** Leave the architecture cleaner than you found
it. If a fix needs a polling loop, a retry timer, or logic that already exists
elsewhere, the approach is wrong. When two systems disagree on the source of
truth, pick one and make everything use it. Clean up resources where the
lifecycle owns them. Prefer the most correct architecture over the shortest
patch; treat tactical safety fallbacks as temporary and label them as such.

**Server-side completion notify boundary.** `kanna-server` subscribes directly
to daemon terminal-state events and treats daemon `Exit` for a task session as
one completion signal — updating activity to `unread`, claiming
`pipeline_item.notify_task_id` via `notified_at`, and delivering
`TASK <child-id> DONE [success|failure|closed]: <title>` through the same
two-step input helper as `/v1/tasks/{task_id}/input`. Keep this
server/daemon-side; it must not depend on the desktop frontend event bridge
being open. `kanna_set_task_notify` retargets that notification on an
already-running task.

The status word is a **closed three-word vocabulary** derived from the
`TaskCompletionTrigger` plus the task's terminating `stage_run` — never from the
daemon `Exit` alone, which cannot tell an agent erroring from a task advancing
past its final stage from a human closing the task, because all three end the
same PTY. `success` = ended cleanly (workflow finished, or session ended with no
failing verdict); `failure` = the terminating run reported failure, or the agent
process died non-zero; `closed` = closed before finishing its workflow, which is
not a failure. Receiving agents match these words exactly and act without
re-reading task state, so any new ending must map onto one of the three rather
than widen the payload. See `docs/kanna-server-boundary.md`.

**Task event feed.** `GET /v1/task-events` (`kanna_wait_events`) is how an agent
watches *several* tasks — `kanna_wait_task` blocks on one id and resolves only
on finish, so a fan-out cannot use it. Events are appended by the same DB writes
that change the state they describe, and the cursor is `task_event.seq`, whose
ordering SQLite's single-writer rule guarantees; a caller that passes back its
cursor never misses an event fired between two calls. Add a new event by
appending it where the state already changes, not by diffing snapshots. The
`task.awaiting_input` event is the daemon's `Waiting` status — a positive match
on prompt chrome, never inferred from a quiet session, because mislabelling a
long build as blocked is worse than not reporting it at all.
`task.activity_changed` is the provider-neutral fallback: it is appended when
a task with a non-empty `waitingPromptSnippet` moves from `working` to `idle`
or `unread`. That weaker edge makes unrecognized provider questions visible,
but does not prove the snippet is a question. A prompt-only change while the
task remains stopped is visible only by polling task detail. See
`docs/kanna-server-boundary.md` and
`docs/2026-07-29-awaiting-input-detection-e2e-gap.md`.

## E2E coverage expectation

Any behavior that crosses component or system boundaries should add or update
at least one E2E test — UI flows, client↔server interactions, daemon/PTY/git/
filesystem behavior, persistence and reconnect, and async coordination where
isolated tests do not prove the real wiring. Unit and integration tests are not
a substitute when the risk is in the wiring.

If a behavior should have E2E coverage but cannot get it yet, land a dated note
in `docs/` (`YYYY-MM-DD-<topic>-e2e-gap.md` / `-e2e-note.md`) saying why it is
not yet testable, what would make it testable, and what narrower tests were
added meanwhile.

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

## Common Pitfalls

- Claude CLI permission mode flags are **camelCase** (`dontAsk` not `dont-ask`). The SDK was broken by this once already.
- `@pierre/diffs`: use `containerWrapper` (not `fileContainer`) in `FileDiff.render()` — `fileContainer` skips the shadow DOM and loses all styling. Use `worker-portable.js` (not `worker.js`) to avoid WASM dependency. Theme/lineDiffType go in worker pool options, not FileDiff constructor (ignored when using pool).
- `git_diff` must include untracked files (`include_untracked`, `recurse_untracked_dirs`, `show_untracked_content`) or new files created by Claude won't appear in the diff view.
- The agent SDK pipes stderr to capture (not null) — check stderr output when debugging silent CLI failures.
- `tauri-plugin-webdriver` on port 4445 for E2E testing. Only works in debug builds on macOS WKWebView.
- Daemon must be detached from app process group (`setsid` via `pre_exec`) or Ctrl+C kills it.
- End-to-end mobile runs must start from `./kd dev up --mobile` or `./kd mobile up`. Launching Expo directly from `apps/mobile` does not start the desktop-side `kanna-server`, so the resolved `KANNA_MOBILE_SERVER_PORT` will be down unless the desktop app is already running.
- A dev machine runs several Kanna instances side by side — production `Kanna.app` (LAN port 48120, `~/Library/Application Support/build.kanna/`), `Kanna Staging.app` (48121, `build.kanna.staging/`), and per-worktree dev instances — each with its own DB, server log, `server.toml`, desktop id, and relay (`wss://relay.kanna.build` vs `relay-staging.kanna.build`). They often share a display name, so a name, a process name, or a default port identifies nothing. Before debugging or performing environment-sensitive operations against a running instance (mobile notifications, cloud deploys, mobile OTA publishes, or direct local/LAN API calls), call `kanna_info` and scope every operation and every log, config, DB, and process check to the effective connection, advertised LAN endpoint, `environment`, `desktop.id`, and port it reports; a fault found in a different instance is a different bug, not the answer.
- Frontend console logs are written to `/tmp/kanna-webview-*.log` via the log forwarding in [`apps/desktop/src/main.ts`](apps/desktop/src/main.ts) and the Tauri `append_log` command in [`apps/desktop/src-tauri/src/commands/fs.rs`](apps/desktop/src-tauri/src/commands/fs.rs). Each instance gets its own log file: worktrees use the directory name (for this worktree: `/tmp/kanna-webview-task-348cf000.log`), while main instances use a cwd path hash (for example `kanna-webview-1a2b3c4d.log`).
- Prefer the most correct architecture over the shortest patch. Use temporary safety fallbacks only when necessary, and document them as fallbacks rather than as the intended steady state.
- Rust build artifacts go to `.build/` (not `target/`) — configured in `.cargo/config.toml`.
- Sidecar build changes should preserve shared Rust caches when possible, but final sidecar binaries used for staging, packaging, or daemon launch must come from a build-private `.build/` path rather than a contested shared final artifact path.
- Terminal output must be ANSI-stripped before pattern matching — raw escape sequences (colors, cursor movement) interfere with hook detection.
- The event bridge auto-reconnects to daemon with exponential backoff — don't add manual retry logic on top.
- KeepAlive is used for ShellModal to preserve xterm buffer across task switches — use `v-show` not `v-if` for terminal-containing components.
- `agent_next_message` uses a polling pattern — frontend calls it repeatedly to drain the buffered message queue from the background drainer task.
- Revision rounds are budgeted: a workflow's top-level `revision_limit` (default 3; `0` = unlimited) caps how many *agent-requested* revisions a task may spend, counted in `pipeline_item.revision_rounds`. Once the budget is spent, `request_revision` starts nothing — it records the review verdict (keeping the requested changes as the run's `feedback`), marks the task `unread` at its current stage, and returns `revisionBudget.exhausted: true`, so a review agent cannot drive a scoped task through endless revise/review rounds. `RequestRevisionRequest.origin` (`agent` default / `human`) is deliberately absent from the tool catalog: the desktop's revision action sends `origin: "human"`, which is never refused and resets the count. Each budgeted revision prompt (and resume message) opens with `Revision round N of M` plus the scope rules. `kanna_get_task` exposes `revisionRounds`/`revisionLimit`. See `docs/specs/qa-dispatch-review.md`.
- Revisions resume by default: `request_revision` reopens the target stage's previous Claude agent session (`--resume <stage_run.provider_session_id>`) inside that run's own worktree — Claude CLI transcripts are keyed by working directory — and moves `pipeline_item.branch` back to it. Kanna composes the message from the original task prompt plus the reviewer's feedback. Any failed precondition (non-Claude provider, missing transcript, worktree gone, or its tip diverged from the committed one) falls back to the fresh fork below; resumed runs record `stage_run.resumed_from_run_id`. Claude PTY spawns assign the session id upfront (`--session-id`), recorded on `stage_run.provider_session_id`/`cwd` and mirrored to `pipeline_item.agent_session_id`.
- Stage advance is durable on the task but forks the workspace. If the current stage declares a `post`, advancing (⌘S or an auto main-run success) injects the post prompt into the running agent session (`stage_run` row with `kind: "post"`; the task's stage and workspace do not change); when that post run completes with success, the engine performs the transition. A transition kills the task's daemon session (and the stale worktree shell), forks a new branch + worktree from the current branch's committed tip, respawns the same session id with the next stage's agent there, and moves `pipeline_item.stage`/`branch` — no new task is ever created; advancing past the final stage closes the task. Reruns keep the current workspace; a dead-session post falls back to spawning its `agent` binding in the current workspace. Legacy `post_action` and `policy.execution: "continue"` workflow JSON (including pinned `pipeline_def` snapshots) compiles into stage posts at load time. `$BRANCH` in a stage prompt resolves to the freshly forked branch; `$SOURCE_WORKTREE` points at the previous stage's worktree. `$PREV_RESULT` resolves to the latest finished run's result of any kind — after a stage with a post, that is the post's result (e.g. the commit agent's) — while `$PREV_MAIN_RESULT` skips posts and resolves to the previous stage agent's own run result, which is what a stage needs when it must read what the previous stage agent reported (including work it declined).
- Built-in agent/workflow definitions must ship as Tauri bundled resources, not as TypeScript string constants. Definitions live in `.kanna/` files — the app reads them at runtime via the resource directory fallback.
