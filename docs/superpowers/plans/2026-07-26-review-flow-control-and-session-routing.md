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
