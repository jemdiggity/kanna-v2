# Review Flow Control and Session Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reviewer-identified queue bounds, fresh-schema integrity, startup recovery, run-scoped session routing, and mixed-version relay compatibility gaps.

**Architecture:** Daemon-facing readers use bounded Tokio channels and bounded negotiation windows so socket reads inherit downstream backpressure. Durable task lookup accepts task IDs, branches, and active stage-run session IDs, while terminal operations resolve aliases to the current daemon session and preserve the alias at client-facing boundaries. Startup recovery subscribes before listing and treats only active, still-unexited successors as promotable.

**Tech Stack:** Rust, Tokio, SQLite/rusqlite, TypeScript, Node SQLite, Vitest, pnpm.

## Global Constraints

- Work only in the existing Kanna-managed worktree and current branch.
- Use `pnpm` for TypeScript package scripts.
- Keep all release dependencies vendored or statically linked; add no machine-installed runtime dependency.
- Do not push or create a pull request from this stage.

---

### Task 1: Executable fresh-schema integrity

**Files:**
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `packages/db/src/migrations.test.ts`

**Interfaces:**
- Consumes: the initial SQL schema as a single executable migration.
- Produces: a valid `stage_run(id)` parent before `task_action_request.successor_run_id`.

- [ ] **Step 1: Write the failing fresh-schema insert test**

Use `node:sqlite` `DatabaseSync`, enable foreign keys, execute the migration, insert a repo, task, stage run, and action request, then assert the stored successor run ID.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --dir packages/db test -- migrations.test.ts
```

Expected: FAIL with `no such table: main.stage_run`.

- [ ] **Step 3: Define `stage_run` before the child table**

Add the production stage-run columns and `FOREIGN KEY (task_id) REFERENCES pipeline_item(id) ON DELETE CASCADE` before `task_action_request`.

- [ ] **Step 4: Re-run package tests and build**

Run:

```bash
pnpm --dir packages/db test
pnpm --dir packages/db build
```

Expected: PASS.

### Task 2: Bounded daemon and KSP flow control

**Files:**
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Modify: `crates/kanna-server/src/ksp.rs`

**Interfaces:**
- Consumes: daemon subscription events and queued `TaskAgentCommand` values.
- Produces: bounded subscription handoff, bounded/time-limited pre-ack buffering, and at most 16 active agent-command tasks.

- [ ] **Step 1: Add RED tests for negotiation overflow and KSP saturation**

Add a fake daemon that emits more than the negotiation limit without acknowledging and assert the watcher returns a bounded-buffer error. Add a KSP fixture that holds 16 daemon replies, sends an overflow command, observes one `agent_busy`, and proves later commands remain backpressured until a held command completes.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml negotiation_buffer -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml agent_command_saturation -- --nocapture
```

Expected: the watcher accepts unbounded pre-ack events and the KSP worker drains/spawns rejection tasks beyond the active cap.

- [ ] **Step 3: Bound subscription queues and acknowledgement negotiation**

Replace `mpsc::unbounded_channel()` with `mpsc::channel(SUBSCRIPTION_EVENT_CAPACITY)`, await `send`, reject a pre-ack buffer at `SUBSCRIPTION_NEGOTIATION_CAPACITY`, and wrap acknowledgement receive in `SUBSCRIPTION_ACK_TIMEOUT`.

- [ ] **Step 4: Backpressure KSP at the active-command cap**

Send the single overflow error directly through the bounded frame sender, then await one active `JoinSet` completion before receiving another command. Never put rejection futures into `in_flight`.

- [ ] **Step 5: Re-run focused flow-control tests**

Run the commands from Step 2 and the existing KSP responsiveness and watcher negotiation suites.

### Task 3: Race-safe startup recovery

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Modify: `crates/kanna-server/src/main.rs` only if startup ownership must move to a shared subscribed watcher.

**Interfaces:**
- Consumes: `SessionInfo.state`, immutable `run_id`, and lifecycle events captured before `List`.
- Produces: promotion only for an active successor with no captured natural exit.

- [ ] **Step 1: Add exited-before-list and exit-between-list-and-land regressions**

Extend the fake startup daemon to acknowledge `SubscribeEvents`, return either `SessionState::Exited(0)` in `SessionList` or return Active and then emit a matching natural `Exit` before promotion. Assert both cases restore the source run and remove the pending successor.

- [ ] **Step 2: Run the startup tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml startup_reconciliation -- --nocapture
```

Expected: both regressions land the dead successor under the current List-only recovery.

- [ ] **Step 3: Subscribe before listing and reconcile buffered exits**

Establish the current versioned lifecycle subscription before requesting `List`, require `SessionState::Active`, and classify matching non-killed exits captured after subscription as non-live before calling `land_pending_stage_action`.

- [ ] **Step 4: Re-run startup recovery tests**

Run the command from Step 2 and verify existing live-successor and absent-successor cases remain green.

### Task 4: Durable task resolution for run-scoped lifecycle signals

**Files:**
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Modify: `crates/kanna-server/src/http_api/task_input.rs`
- Modify: `crates/kanna-server/src/http_api/tests/input.rs`

**Interfaces:**
- Consumes: durable task ID, branch, or pending/running `stage_run.session_id`.
- Produces: the durable `pipeline_item.id`, and resolves parent task input to its current daemon session.

- [ ] **Step 1: Add RED resolver and lifecycle regressions**

Seed task ID `task-child`, branch `task-task-child-2`, and running session `run-child-current`. Assert `resolve_pipeline_item_id("run-child-current") == Some("task-child")`. Exercise StatusChanged with a waiting prompt, Busy/Idle activity, and natural Exit; assert prompt/activity/unread and parent notification all target the durable task while notification input targets the parent’s distinct run session.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml resolves_run_scoped_session_to_task -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml run_scoped -- --nocapture
```

Expected: current lookup returns `None`, so lifecycle effects and notification routing are dropped.

- [ ] **Step 3: Extend durable task lookup and parent routing**

After exact task lookup, resolve `stage_run.session_id` for `status IN ('pending', 'running')`, then retain branch fallback. In `notify_task_completion`, resolve `notification.notify_task_id` through `resolve_task_terminal_session_id` before daemon input.

- [ ] **Step 4: Re-run DB, watcher, and input tests**

Run the commands from Step 2 plus the complete `db::tests`, `terminal_watcher::tests`, and `http_api::tests::input` filters.

### Task 5: Mixed-version legacy relay aliases

**Files:**
- Modify: `crates/kanna-server/src/commands.rs`
- Modify: `crates/kanna-server/src/relay.rs`

**Interfaces:**
- Consumes: legacy caller aliases that may be durable task IDs, branches, shell sessions, or daemon session IDs.
- Produces: daemon commands using the current run session while observer keys and relay payloads retain the caller alias.

- [ ] **Step 1: Add RED command and observer regressions**

Seed `task-legacy` with current session `run-legacy-current`; assert legacy input, resize, and observe send daemon commands to `run-legacy-current`, while emitted snapshot/output/exit payloads and unobserve keys use `task-legacy`.

- [ ] **Step 2: Run relay/command tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml legacy_terminal_alias -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml observer_loop -- --nocapture
```

Expected: daemon commands still use the durable task ID and observer payloads expose the run-scoped daemon ID.

- [ ] **Step 3: Resolve daemon targets without changing client identity**

Add a helper that returns `Db::resolve_task_terminal_session_id(alias)?.unwrap_or(alias.to_string())`. Use it for legacy input, resize, and observe. Key observer tasks and render every relay event with the original alias.

- [ ] **Step 4: Re-run mixed-version and existing observer tests**

Run the commands from Step 2 and the full relay test filter.

### Task 6: Final verification and stage completion

**Files:**
- Inspect every modified file and this plan.

**Interfaces:**
- Consumes: all changes from Tasks 1–5.
- Produces: formatting-clean, test-verified revision feedback resolution.

- [ ] **Step 1: Run formatting**

```bash
cargo fmt --all -- --check
pnpm exec prettier --check packages/db/src/migrations.test.ts
```

- [ ] **Step 2: Run focused suites**

```bash
pnpm --dir packages/db test
cargo test --manifest-path crates/kanna-server/Cargo.toml
```

- [ ] **Step 3: Run canonical repository verification**

```bash
pnpm test
./kd test rust
```

- [ ] **Step 4: Inspect the result**

```bash
git diff --check
git status --short
git diff --stat
```

- [ ] **Step 5: Record the auto-stage result**

Call `kanna_complete_stage` with status `success` and the verified summary, or status `failure` with the blocking evidence.

---

## Review Revision Tasks

### Task 7: Route task input to the current run session

**Files:**
- Modify: `crates/kanna-server/src/http_api/task_input.rs`
- Modify: `crates/kanna-server/src/http_api/tests/input.rs`

**Interfaces:**
- Consumes: a durable task/branch alias from `/v1/tasks/{id}/input`.
- Produces: daemon `Input` commands addressed to the current run-scoped session.

- [ ] **Step 1: Add the failing route regression**

Seed a task with a running `stage_run` whose `session_id` is `run-input-current`.
Run the real HTTP route against a Unix-socket fake daemon and assert both the
message and synthesized Enter target `run-input-current`.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml send_task_input_route_resolves_running_stage_run_session -- --nocapture
```

Expected: FAIL because the route sends both inputs to the durable task ID.

- [ ] **Step 3: Resolve before daemon I/O**

Open the configured database, call
`resolve_task_terminal_session_id(&task_id)`, return 404 when no durable task is
found, and pass the resolved session to `submit_task_input`.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and the complete `http_api::tests::input` filter.

### Task 8: Resolve and ownership-guard process closure

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

**Interfaces:**
- Consumes: the latest current-format stage run, including succeeded main/post runs.
- Produces: a daemon session ID plus the immutable run ID that owns its process.

- [ ] **Step 1: Add failing resolver and route regressions**

Cover a succeeded main run and a succeeded injected post. Assert a main resolves
to `(session_id, main_run_id)` and a post resolves to
`(session_id, resumed_from_run_id)`. At route level, assert explicit close and
final-stage close issue `Kill { session_id: run-*, expected_run_id: Some(run-*) }`.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml resolves_task_process_session -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml close_route_kills_run_scoped -- --nocapture
```

Expected: resolver tests do not compile until the API exists, and route tests
observe the durable task ID with no immutable owner.

- [ ] **Step 3: Add the shared process-binding resolver**

Define a database value carrying `session_id` and `expected_run_id`. Select the
latest current-ownership run without filtering out succeeded runs; use the
post's `resumed_from_run_id` as its process owner. Fall back to the terminal
mapping with no immutable owner for legacy tasks.

- [ ] **Step 4: Use ownership-aware kills in both close paths**

Resolve the binding during close preparation. Call
`kill_session_replacing_if_owned` for the process binding, and keep shell and
teardown cleanup as separate ownershipless kills.

- [ ] **Step 5: Verify GREEN**

Run the commands from Step 2 and the complete action-route test filter.

### Task 9: Preserve legacy terminal routing

**Files:**
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`

**Interfaces:**
- Consumes: migration-023-era running rows with provider UUID in `session_id`,
  null `provider_session_id`, and `run_ownership_version = 0`.
- Produces: the trusted `terminal_session.daemon_session_id`.

- [ ] **Step 1: Add the old-format fixture**

Insert the ownershipless row and a terminal mapping, then assert
`resolve_task_terminal_session_id` returns the terminal mapping rather than the
provider UUID.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml ownershipless_legacy_run_falls_back_to_terminal_session -- --nocapture
```

Expected: FAIL with the provider UUID.

- [ ] **Step 3: Trust only current ownership-version stage runs**

Add `run_ownership_version >= CURRENT_RUN_OWNERSHIP_VERSION` to stage-run
terminal resolution while preserving current rows with null provider IDs.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and all terminal-session resolver tests.

### Task 10: Preserve activity revision on successor reservation

**Files:**
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`

**Interfaces:**
- Consumes: pipeline-item activity before successor reservation.
- Produces: one revision increment when activity changes to `working`, zero for
  an already-working item.

- [ ] **Step 1: Extend the activity write regression**

Exercise both `replace_current_run_with_pending` and
`replace_current_run_with_pending_action`; assert each idle/unread-to-working
transition increments the revision, and an already-working reservation does not
invent another revision.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml every_server_activity_write_advances_the_activity_revision -- --nocapture
```

Expected: FAIL because reservation changes activity without changing revision.

- [ ] **Step 3: Increment conditionally in the reservation transaction**

Set:

```sql
activity_revision = activity_revision
  + CASE WHEN activity = 'working' THEN 0 ELSE 1 END
```

in the same `UPDATE pipeline_item` that sets activity to `working`.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and the complete database test filter.

### Task 11: Bound pending-action startup recovery

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Modify: `crates/kanna-server/src/main.rs`

**Interfaces:**
- Consumes: daemon subscription acknowledgement and session list during startup.
- Produces: bounded success or an error that leaves pending durable state intact
  for a later startup retry.

- [ ] **Step 1: Add the stalled-daemon regression**

Seed a pending action, accept both daemon connections, read the commands, and
withhold all replies. Assert startup reconciliation returns a timeout error
within the test deadline and the pending action remains.

- [ ] **Step 2: Verify RED**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml startup_reconciliation_times_out_when_daemon_stalls -- --nocapture
```

Expected: the outer test deadline fires because acknowledgement waits forever.

- [ ] **Step 3: Deadline-bound acknowledgement and List**

Wrap acknowledgement `read_event` and control `list` in
`tokio::time::timeout`. Return phase-specific timeout errors. Keep the startup
caller fail-closed so the process exits and its supervisor can retry with the
unchanged pending action.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2 and all `startup_reconciliation` tests.

### Task 12: Revision verification and completion

**Files:**
- Inspect every file changed by Tasks 7–11.

- [ ] **Step 1: Format and inspect**

```bash
cargo fmt --all -- --check
git diff --check
git status --short
```

- [ ] **Step 2: Run the focused server suite**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml
```

- [ ] **Step 3: Run canonical verification**

```bash
pnpm test
./kd test rust
```

- [ ] **Step 4: Record the auto-stage result**

Call `kanna_complete_stage` with the verified success summary, or failure with
the blocking evidence.
