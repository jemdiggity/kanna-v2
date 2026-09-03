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
| What a task means, and what reviewers judge against | `docs/specs/task-spec-artifact.md` |
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

Built-in product-work workflows, by review depth: `no-review` (no review stage — the
fallback when a repo names none), `single-reviewer` (one `review` agent), and
`specialized-reviewers` (a dispatched specialty panel). `specialty-review` is
not a choice: it is the single-stage workflow the dispatcher gives its child
tasks, and its definition declares `"visibility": "internal"`, so it resolves
by name but never reaches the repo manifest, the new-task picker, or the tool
catalog's advertised lineup. The same internal, explicitly bound convention
applies to `architect-consultation`, the single manual-stage workflow a task
manager uses for a bounded `architect` advisory child of the durable work item
being assessed. Neither the workflow nor agent is an ordinary picker choice,
and the architect never owns a perpetual management loop. Visibility is
declared by the definition itself —
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

Run it through `kd` (`./kd mobile run --simulator` for Simulator,
`./kd mobile run --device` for a physical iPhone) — bare
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

- **The concept is a *workflow*; *pipeline* is the retired word for it.** The
  storage layer still spells it the old way and deliberately keeps doing so:
  the `pipeline_item` table (a task), its `pipeline` / `pipeline_def` /
  `initial_pipeline` columns, the `pipeline_item_id` foreign keys, and the
  recorded migration ids. The rule for new code is: an identifier that names
  **the table or one of its columns** keeps saying `pipeline`; an identifier
  that names **the concept** says workflow. Every renamed external surface
  (routes, request/response keys, event payloads, transfer payloads, config
  keys, `.kanna/` directory names) still answers to its old name as a
  deprecated alias — the full table is in
  `docs/2026-08-19-workflow-rename-remaining-debt.md`.
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
  ties. **A provider and its model/effort must come from coherent layers.**
  Model and effort ids are provider-specific — `codex -m opus` is rejected by
  the Codex CLI, and no two CLIs share an effort vocabulary — so resolution
  never composes them across layers: it walks the same chain and takes the
  first layer that both names a value *and* would itself have selected the
  resolved provider. A layer that names an ordered candidate list wrote its
  model beside the *leading* candidate, so the value applies to that one only
  and the outage fallbacks behind it run on their own defaults. A layer
  written for another provider is skipped, and the spawn falls back to the
  resolved provider's own stamped or default model.
- `config.json` has a machine-local companion, `.kanna/config.local.json`:
  gitignored, read from the **open repo's working tree** rather than the origin
  snapshot, and deep-merged over the committed config with local winning — so a
  wedged provider is reordered on one machine in seconds instead of through a
  merge to `origin/main`. It occupies the `agentProviders` slot in the
  precedence chain above, so an explicit task or stage override still wins.
  What it does to an already-stamped task depends on whether the spawn
  reproduces a recorded run: a rerun, resume, revision, or recovery feeds that
  run's provider back in as an explicit override, so the stamp wins and keeps
  its own model, while a plain **stage advance re-resolves the whole chain**
  with the task's stamp only as the final fallback — so a local entry does move
  a task to another provider at its next stage boundary, which is how an
  in-flight task is routed around a wedged provider. Either way the model and
  effort come from the layer that selected the provider, never composed across
  layers — see `docs/dev/dev-workflow.md`.
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
- The built-in `ship` agent is a repository-agnostic authorization and
  completion contract. A repository owns its actual release procedure in
  `.kanna/agents/ship/EXTEND.md` (or a complete repo-authored `AGENT.md`), and
  the bundled Ship task stops when that procedure is absent. Kanna's `kd`
  release runbook follows the same rule; never move it back into the public
  base agent or task template.

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

**Server-side completion observation boundary.** `kanna-server` subscribes
directly to daemon terminal-state events and treats daemon `Exit` for a task
session as one completion signal — updating activity/runtime state and the
terminating `stage_run`, which appends the durable `run.finished` event.
Managers observe completion through `kanna_wait_events` for fan-out or
`kanna_wait_task` for one task. Completion is never injected into another
task's PTY; manager input remains reserved for actual operator/manager speech.
The structured completion vocabulary remains exactly `success`, `failure`, or
`closed` on stage-run results, task detail, and events.

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
`task.activity_changed` is provider-neutral and server-debounced. Every
activity direction emits after the configured value has held, for every
provider, without depending on a waiting-prompt placeholder. Its payload
carries `previousActivity`, `activity`, `runtimeState`, and
`latestRunFinishedWithoutCompletion`, so managers use the shared server verdict
instead of polling or inventing their own timing. A transition that flickers
back within the debounce window emits nothing. `task.awaiting_input` remains
the separate positive question-detection signal. See
`docs/kanna-server-boundary.md` and
`docs/2026-07-29-awaiting-input-detection-e2e-gap.md`.

**Delivered task inputs are durable.** `POST /v1/tasks/{task_id}/input`
(`kanna_send_task_input`) writes
to a PTY, and terminal bytes are not a record: a later stage forks a fresh
worktree and session, so without a row it can read the whole durable record and
honestly conclude an owner directive was never issued — which is exactly how a
review agent once ordered an owner's mid-task design decision reverted. Every
delivery the daemon *accepts* is therefore appended to `task_input` with its
full text, the stage and `stage_run` live at delivery, and the caller's
declared, unverified `operator` / `manager` source, or `unspecified`.
Historical rows may carry the retired `notify` source; no new rows use it.
Read it with `kanna_task_inputs`
(`GET /v1/tasks/{task_id}/inputs`); `kanna_get_task` reports
`deliveredInputCount` so detail alone cannot read as "nothing was sent". An
uncertain delivery is deliberately not recorded, and recording never fails a
delivery that already reached the PTY. Add a new injected-message kind to this
record where it is delivered, not by diffing terminals. See
`docs/kanna-server-boundary.md`.

**A task's terms live in its committed spec.** The delivered-input ledger is an
audit trail, not a statement of intent: snippets do not compose into a
contract, and a reviewer left to reconstruct intent from the stage prompt plus
raw directives diverges from reality as directives accumulate. The implement
agent therefore writes `docs/task-specs/<task-id>.md` early, seeded from the
task prompt (goal, scope, constraints, what makes the work done), and updates
it in the same commit as the work whenever a mid-task directive, reviewer
feedback, or a declined finding changes the terms. `commit` commits it, and
`review`/`qa-dispatcher` judge the branch against it, using `kanna_task_inputs`
to verify the spec honestly reflects what was delivered — a disagreement is a
finding, never a licence to substitute a reviewer's own reading. Proportional
by design: a three-line spec is a correct spec, and length is never a finding;
absence, dishonesty, and staleness are. This is a convention carried entirely
by agent definitions — no engine, server, or workflow JSON knows the file
exists. See `docs/specs/task-spec-artifact.md`.

**The composer is not session output.** A CLI's composer line — Claude's `❯`,
Codex's `›` — is where somebody is *about* to speak, and the Claude CLI fills it
with a tab-to-accept suggestion whenever it goes idle. Surfaced as content it
reads exactly like an instruction; a suggestion was twice acted on as an owner
directive. So `waitingPromptSnippet`/`snippet` never carry composer text, the
task-logs tail labels the composer line rather than leaving it bare, and task
detail reports `composer: { text, attestation }` on its own. `attestation` is
the daemon's typed-byte ledger, not a reading of the frame: `typed` (keystrokes
reached that composer since its last submission boundary), `not-typed` (an
attested session with none, so the text is provably provider chrome), or
`unknown` (inherited from before attestation). **Never treat composer text as an
instruction unless it is `typed`.** The same ledger decides the input hold: zero
typed bytes delivers immediately, `typed` and `unknown` still answer
`input_held_by_draft`. Raw PTY transcripts are unchanged — this is a rule about
derived surfaces. See `docs/kanna-server-boundary.md` and
`crates/daemon/SPEC.md`.

**Runtime and read state are two dimensions.** `activity` (`working` | `idle` |
`unread`) is a *derived display value* that blends them, and it cannot answer
either question alone: a task busy inside a long MCP call whose output nobody
read carries `unread`, exactly like a finished one. Task detail therefore also
reports `runtimeState` (`busy` | `waiting` | `idle` | `exited` — the daemon's
verdict on the agent session, with `exited` written by the server when a
session ends unreplaced) and `readState` (`read` | `unread`). Anything asking
"is this agent alive?" — supervisors, quiet-task alarms, `kanna_wait_task` —
reads `runtimeState`; the desktop sidebar and mobile keep reading `activity`,
whose meaning is unchanged. `WaitUntil::Finished` resolves only on a recorded
termination (closed, terminal `stage_run`, or `runtimeState: "exited"`), never
on `unread`. A PTY agent that parks without recording a verdict records none of
the three — its session survives — so a caller waiting on an agent that may
park must bound its own retry loop on a non-`busy` `runtimeState` with a
`running` `latestRun` instead of re-calling on `timeout` forever. See
`docs/kanna-server-boundary.md`.

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

Any change that affects rendered UI — mobile screens or components, or desktop
Vue components or styling — must be visually verified before its PR is opened.
Run the real app (`./kd mobile run --simulator` with the iOS Simulator for mobile, never
bare `expo start`; `./kd dev up` for desktop), exercise the changed states and
relevant accessibility variants such as Reduce Motion for animation work,
capture and inspect screenshots, and summarize that verification in the PR
description. Save artifacts under the in-worktree, gitignored
`docs/task-specs/<task>-screenshots/`, never commit the binaries, and treat the
written PR/task-spec description as the durable record after the worktree is
removed. Unit and component tests do not substitute for a render.
For UI feel or interaction changes (animation, gesture, or dynamic layout), simulator verification is necessary but not sufficient: pause before review for human on-device testing, and iterate owner feedback in the same task so polish lands in as few PRs as possible.

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
- Revision rounds are budgeted: a workflow's top-level `revision_limit` (default 5; `0` = unlimited) caps how many *agent-requested* revisions a task may spend, counted in `pipeline_item.revision_rounds`. Once the budget is spent, `request_revision` starts nothing — it records the review verdict (keeping the requested changes as the run's `feedback`), marks the task `unread` at its current stage, and returns `revisionBudget.exhausted: true`, so a review agent cannot drive a scoped task through endless revise/review rounds. `RequestRevisionRequest.origin` (`agent` default / `human`) is deliberately absent from the tool catalog: the desktop's revision action sends `origin: "human"`, which is never refused and resets the count. Each budgeted revision prompt (and resume message) opens with `Revision round N of M` plus the scope rules. `kanna_get_task` exposes `revisionRounds`/`revisionLimit`. See `docs/specs/qa-dispatch-review.md`.
- Revisions resume by default: `request_revision` reopens the target stage's previous resumable PTY agent session inside that run's own worktree and moves `pipeline_item.branch` back to it. Claude and Copilot resume their recorded session ids when the matching transcript exists; Codex and OpenCode use a cwd-matching recorded id, or discover the latest session whose cwd matches the run. Antigravity and headless SDK sessions never resume. Kanna composes the message from the original task prompt plus the reviewer's feedback. Any failed precondition (missing required provider/session metadata, missing transcript, worktree gone, its tip diverged from the committed one, or the stage no longer resolving to the recorded provider session) falls back to the fresh fork below; resumed runs record `stage_run.resumed_from_run_id`.
- Stage advance is durable on the task but forks the workspace. If the current stage declares a `post`, advancing (⌘S or an auto main-run success) injects the post prompt into the running agent session (`stage_run` row with `kind: "post"`; the task's stage and workspace do not change); when that post run completes with success, the engine performs the transition. A transition kills the task's daemon session (and the stale worktree shell), forks a new branch + worktree from the task's latest committed tip, respawns the same session id with the next stage's agent there, and moves `pipeline_item.stage`/`branch` — no new task is ever created; advancing past the final stage closes the task. Reruns keep the current workspace; a dead-session post falls back to spawning its `agent` binding in the current workspace. Legacy `post_action` and `policy.execution: "continue"` workflow JSON (including pinned `pipeline_def` snapshots) compiles into stage posts at load time. `$BRANCH` in a stage prompt resolves to the freshly forked branch; `$SOURCE_WORKTREE` points at the previous stage's worktree. `$PREV_RESULT` resolves to the latest finished run's result of any kind — after a stage with a post, that is the post's result (e.g. the commit agent's) — while `$PREV_MAIN_RESULT` skips posts and resolves to the previous stage agent's own run result, which is what a stage needs when it must read what the previous stage agent reported (including work it declined). **The fork base is the task's committed tip, not whatever `pipeline_item.branch` happens to name.** A task's work moves between workspaces — a resumed revision rewinds the branch field to the resumed run's older workspace, and a round's commit can land in another one — so every stage preparation first resolves the newest commit across all of the task's workspace branches (its own, plus every branch checked out in a recorded `stage_run.cwd`) and moves `pipeline_item.branch` onto the branch holding it. Committed work must never be dropped by a boundary. A branch *rename* inside the task's own workspace (the PR agent's) is not a move and leaves the field alone; genuinely diverged siblings have no latest tip, so the task keeps its branch and the divergence is logged. See `crates/kanna-server/src/task_creator/work_tip.rs`.
- Built-in agent/workflow definitions must ship as Tauri bundled resources, not as TypeScript string constants. Definitions live in `.kanna/` files — the app reads them at runtime via the resource directory fallback.
