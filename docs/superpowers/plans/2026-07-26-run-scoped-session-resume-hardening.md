# Run-Scoped Session Resume Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make spawned daemon sessions run-scoped, keep provider conversation resumption independent, make revision retries durable and replayable, and close the reviewed control/kill/teardown races.

**Architecture:** Each newly spawned process receives a daemon session ID derived from its immutable stage-run ID; task-facing callers resolve the current stage run through SQLite, while provider-native IDs continue across runs. Revision HTTP actions use a durable idempotency ledger linked transactionally to `pending_stage_action`. Per-turn input returns an immediate busy result, and required teardown failures abort before setup or spawn.

**Tech Stack:** Rust, Tokio, Axum, rusqlite/SQLite, Vue 3/TypeScript, Vitest, pnpm.

---

### Task 1: Give every newly spawned run its own daemon session

**Files:**
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/spawn.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write failing lifecycle tests for run-scoped sessions**

Add assertions to initial spawn, rerun, stage-transition, and resumed-revision tests that distinguish the source session from the successor:

```rust
let successor = match spawn_command {
    kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
        let run_id = params.env.get("KANNA_STAGE_RUN_ID").unwrap();
        assert_eq!(session_id, *run_id);
        assert_ne!(session_id, source_session_id);
        (session_id, run_id.clone())
    }
    other => panic!("unexpected daemon command: {other:?}"),
};
assert_eq!(db.latest_stage_run(task_id).unwrap().unwrap().session_id, Some(successor.0));
```

Add a KSP/database regression proving task resolution follows the latest running run instead of the durable task ID:

```rust
assert_eq!(
    db.resolve_task_terminal_session_id("task-1").unwrap().as_deref(),
    Some("run-task-1-successor")
);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cargo test -p kanna-server task_creator::tests::spawn -- --nocapture
cargo test -p kanna-server task_creator::tests::revision -- --nocapture
cargo test -p kanna-server task_creator::tests::stage -- --nocapture
cargo test -p kanna-server resolves_task_terminal_session_id -- --nocapture
```

Expected: assertions show spawned `session_id` still equals the source/task session instead of the new run ID.

- [ ] **Step 3: Separate source and successor session identities**

Rename prepared replacement fields so they carry only the session being stopped:

```rust
pub(crate) struct PreparedStageRunSpawn {
    pub(super) task_id: String,
    pub(super) source_session_id: String,
    // existing fields unchanged
}

pub(crate) struct PreparedStageRerun {
    pub(super) task_id: String,
    pub(super) source_session_id: String,
    // existing fields unchanged
}
```

At every process-spawning lifecycle boundary, allocate the run before choosing the daemon session:

```rust
let run_id = generate_stage_run_id(&task_id);
let session_id = run_id.clone();
prepared
    .env
    .insert("KANNA_STAGE_RUN_ID".to_string(), run_id.clone());
```

Kill only the recorded source identity:

```rust
kill_session_replacing_if_owned(
    daemon,
    replacements,
    &prepared.source_session_id,
    prepared.expected_source.process_run_id.as_deref(),
)
.await?;
```

Reserve, spawn, reconcile, and land using the successor `session_id`. Apply the same allocation to initial task spawn, rerun, stage-transition/post-fallback spawn, and any newly awakened dormant task. A post injected into an already-live process keeps that process's existing session ID because it does not spawn a new process.

Change `resolve_task_terminal_session_id` to prefer the latest running stage
run before consulting legacy `terminal_session` rows:

```rust
let stage_run_session_id = self.conn.query_row(
    "SELECT session_id
     FROM stage_run
     WHERE task_id = ?1
       AND status = 'running'
       AND session_id IS NOT NULL
       AND session_id != ''
     ORDER BY datetime(started_at) DESC, rowid DESC
     LIMIT 1",
    [&pipeline_item_id],
    |row| row.get(0),
).optional()?;
if stage_run_session_id.is_some() {
    return Ok(stage_run_session_id);
}
```

Keep the `terminal_session` lookup afterward for pre-run/legacy tasks and the
task ID fallback last.

- [ ] **Step 4: Re-run focused session identity tests**

Run the commands from Step 2.

Expected: all focused tests pass, source kills target the old session, and every process spawn uses its run ID as daemon session ID.

- [ ] **Step 5: Commit the run-scoped identity change**

```bash
git add crates/kanna-server/src/task_creator crates/kanna-server/src/db/pipeline_items.rs crates/kanna-server/src/db/tests.rs crates/kanna-server/src/ksp.rs
git commit -m "fix: scope daemon sessions to spawned runs"
```

### Task 2: Keep control commands responsive during active per-turn children

**Files:**
- Modify: `crates/daemon/src/agent_runtime/commands.rs`
- Modify: `crates/daemon/tests/agent_sessions.rs`
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add the long-running per-turn regression**

Add a fake Codex/OpenCode child that emits a provider session and permission request, then remains alive until interrupted. On one daemon connection:

```rust
control.send(&Command::AgentInput {
    session_id: active_session.clone(),
    text: "second turn".to_string(),
});
let busy = control.recv_timeout(Duration::from_millis(500));
assert!(matches!(
    busy,
    Event::Error {
        code: Some(ErrorCode::AgentBusy),
        ..
    }
));

control.send(&Command::AgentPermission {
    session_id: active_session.clone(),
    request_id: "permission-1".to_string(),
    decision: PermissionDecision::Allow,
});
assert!(matches!(control.recv_timeout(Duration::from_millis(500)), Event::Ok));

control.send(&Command::AgentSetModel {
    session_id: active_session.clone(),
    model: "next-model".to_string(),
});
assert!(matches!(control.recv_timeout(Duration::from_millis(500)), Event::Ok));

control.send(&Command::AgentSetModel {
    session_id: other_session,
    model: "other-model".to_string(),
});
assert!(matches!(control.recv_timeout(Duration::from_millis(500)), Event::Ok));

control.send(&Command::AgentInterrupt {
    session_id: active_session,
});
assert!(matches!(control.recv_timeout(Duration::from_millis(500)), Event::Ok));
```

Add a KSP worker regression that queues input, permission, model, interrupt, and another task's command and observes all corresponding daemon commands without the worker stalling.

- [ ] **Step 2: Run the regressions and verify the timeout**

Run:

```bash
cargo test -p kanna-daemon --test agent_sessions per_turn_control_commands_remain_responsive -- --nocapture
cargo test -p kanna-server ksp::tests::agent_commands_remain_responsive -- --nocapture
```

Expected: the second input blocks the ordered connection/worker until the long-running child exits.

- [ ] **Step 3: Replace polling with an immediate busy result**

Add a protocol error code:

```rust
pub enum ErrorCode {
    // existing variants
    AgentBusy,
}
```

Replace the `loop` in `handle_agent_input` with one registry inspection. For both `child_reaping` and a live per-turn child, reply immediately:

```rust
if record.child_reaping
    || (record.turn_model == TurnModel::PerTurn && !record.exited)
{
    drop(registry);
    reply(
        &writer,
        &agent_error(
            protocol::ErrorCode::AgentBusy,
            format!("agent turn already in progress: {session_id}"),
        ),
    )
    .await;
    return;
}
```

Keep the existing atomic respawn reservation for an exited per-turn record.

- [ ] **Step 4: Re-run daemon and KSP responsiveness tests**

Run the commands from Step 2 plus:

```bash
cargo test -p kanna-daemon --test agent_sessions -- --nocapture
```

Expected: all control commands complete within their bounds and agent session integration tests pass.

- [ ] **Step 5: Commit the responsiveness fix**

```bash
git add crates/daemon/src crates/daemon/tests/agent_sessions.rs crates/kanna-server/src/ksp.rs
git commit -m "fix: reject overlapping per-turn input promptly"
```

### Task 3: Persist and replay revision request results

**Files:**
- Modify: `apps/desktop/src/stores/pipeline.ts`
- Modify: `apps/desktop/src/stores/pipeline.requestRevision.test.ts`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/db/fixtures/origin_main_028.sql`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `packages/db/src/migrations/001_initial.sql`

- [ ] **Step 1: Add failing database tests for the durable request ledger**

Add migration `032_task_action_request` and tests for an atomic claim/replay contract:

```rust
assert_eq!(
    db.claim_task_action_request(
        "revision-key-1",
        "task-1",
        "request-revision",
        r#"{"targetStage":"in progress","summary":"changes","prompt":"fix"}"#,
    ).unwrap(),
    TaskActionRequestClaim::Claimed,
);
assert_eq!(
    db.claim_task_action_request(
        "revision-key-1",
        "task-1",
        "request-revision",
        r#"{"targetStage":"in progress","summary":"changes","prompt":"fix"}"#,
    ).unwrap(),
    TaskActionRequestClaim::Pending,
);
assert!(matches!(
    db.claim_task_action_request(
        "revision-key-1",
        "task-1",
        "request-revision",
        r#"{"targetStage":"review","summary":"different","prompt":"different"}"#,
    ),
    Err(TaskActionRequestError::Conflict)
));
```

After landing a linked pending action, assert the same key returns the stored status/body and no second stage run is inserted. After rollback, assert a durable failure is replayed.

- [ ] **Step 2: Run database tests and verify migration/API failures**

Run:

```bash
cargo test -p kanna-server db::tests::task_action_request -- --nocapture
cargo test -p kanna-server migration -- --nocapture
```

Expected: the table, migration, and claim/finalization methods do not exist.

- [ ] **Step 3: Add the additive ledger schema and DB API**

Create:

```sql
CREATE TABLE IF NOT EXISTS task_action_request (
  idempotency_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  request_json TEXT NOT NULL,
  successor_run_id TEXT UNIQUE REFERENCES stage_run(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
  http_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Implement:

```rust
pub enum TaskActionRequestClaim {
    Claimed,
    Pending,
    Completed { status: u16, body: String },
}

pub fn claim_task_action_request(
    &self,
    key: &str,
    task_id: &str,
    action: &str,
    request_json: &str,
) -> Result<TaskActionRequestClaim, TaskActionRequestError>;

pub fn finish_task_action_request(
    &self,
    key: &str,
    state: &str,
    status: u16,
    response_body: &str,
) -> Result<(), rusqlite::Error>;
```

Extend `replace_current_run_with_pending_action` with an optional request key. In the same transaction that inserts `pending_stage_action`, bind `successor_run_id`. In `land_pending_stage_action`/`start_stage_run`, mark a linked request succeeded with the serialized `TaskActionResponse`. In rollback, mark it failed with an interruption/rollback response before deleting the pending successor.

- [ ] **Step 4: Add response-loss and restart HTTP regressions**

Exercise the real request-revision route with `Idempotency-Key: revision-key-1`:

```rust
let first = send_revision(&app, "revision-key-1", payload.clone()).await;
assert_eq!(first.status(), StatusCode::OK);
drop(first); // simulate loss after the server committed

let restarted = router(Arc::new(AppState::new(config.clone())));
let replay = send_revision(&restarted, "revision-key-1", payload.clone()).await;
assert_eq!(replay.status(), StatusCode::OK);
assert_eq!(stage_run_count(&config.db_path, "task-1"), 2);
assert_eq!(worktree_count(&config.db_path, "task-1"), expected_worktrees);
```

Add cases for restart with a reserved live successor, a rolled-back successor, a claim with no reservation, and key reuse with a different payload.

- [ ] **Step 5: Implement route claim, completion, and replay**

Extract the optional `Idempotency-Key` header. Serialize the validated payload once. Before preparing:

```rust
match db.claim_task_action_request(
    key,
    &source_task_id,
    "request-revision",
    &request_json,
)? {
    TaskActionRequestClaim::Claimed => {}
    TaskActionRequestClaim::Pending => return retryable_pending_response(),
    TaskActionRequestClaim::Completed { status, body } => {
        return replay_task_action_response(status, body)
    }
}
```

Pass the key through the prepared transition to the pending action reservation. Record every pre-reservation error as a completed failure. Let stage landing/rollback finalize post-reservation outcomes transactionally. Startup pending-action reconciliation must finalize any linked ledger rows before HTTP starts.

- [ ] **Step 6: Add the frontend stable-key retry regression**

Stub `crypto.randomUUID()` to return `revision-key-1`. Make the first fetch throw after recording acceptance and the second return replayed success. Assert both fetches have the same header and only one logical action:

```typescript
expect(fetchMock).toHaveBeenNthCalledWith(
  1,
  expect.any(String),
  expect.objectContaining({
    headers: expect.objectContaining({ "Idempotency-Key": "revision-key-1" }),
  }),
);
expect(fetchMock).toHaveBeenNthCalledWith(
  2,
  expect.any(String),
  expect.objectContaining({
    headers: expect.objectContaining({ "Idempotency-Key": "revision-key-1" }),
  }),
);
```

Add a retryable-pending response test proving the desktop retries within `LOCAL_SERVER_ACTION_TIMEOUT_MS`.

- [ ] **Step 7: Implement stable desktop request keys**

Create the key once in `requestRevision`:

```typescript
const idempotencyKey = globalThis.crypto.randomUUID();
const response = await postTaskAction(
  taskId,
  "request-revision",
  payload,
  { idempotencyKey, retryPending: true },
);
```

Merge `Content-Type` and `Idempotency-Key` headers on every retry. Retry only server responses explicitly marked as the same idempotent request still pending; return all other HTTP responses unchanged.

- [ ] **Step 8: Run focused database, HTTP, and desktop tests**

Run:

```bash
cargo test -p kanna-server db::tests::task_action_request -- --nocapture
cargo test -p kanna-server http_api::tests::actions::request_revision -- --nocapture
pnpm --dir apps/desktop test --run src/stores/pipeline.requestRevision.test.ts
```

Expected: response loss/restart replays one durable result and the frontend retries with one stable key.

- [ ] **Step 9: Commit idempotency**

```bash
git add apps/desktop/src/stores/pipeline.ts apps/desktop/src/stores/pipeline.requestRevision.test.ts crates/kanna-server/src packages/db/src/migrations/001_initial.sql
git commit -m "fix: make revision requests durably idempotent"
```

### Task 4: Make kill acknowledgments and blocking teardown fail closed

**Files:**
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/tests/agent_sessions.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] **Step 1: Add the already-exited persistent-agent regression**

Spawn a persistent Claude-like child that exits naturally, wait for its normal exit, kill its retained record, and then spawn a successor under a different run-scoped session:

```rust
control.send(&Command::Kill {
    session_id: source_session.clone(),
    expected_run_id: Some("run-source".to_string()),
});
assert!(matches!(control.recv(), Event::Ok));
assert!(matches!(
    subscriber.recv_timeout(Duration::from_millis(500)),
    Event::Exit {
        session_id,
        run_id: Some(run_id),
        killed: true,
        ..
    } if session_id == source_session && run_id == "run-source"
));
```

Assert the successor's natural exit is processed normally and no source replacement entry remains.

- [ ] **Step 2: Add failed/lost blocking-teardown fault injection**

For both an explicit daemon error and a socket close after receiving the teardown `Kill`, assert:

```rust
assert!(!worktree.join("resumed-setup.marker").exists());
assert!(
    commands.iter().all(|command| !matches!(
        command,
        kanna_daemon::protocol::Command::SpawnAgent { .. }
    ))
);
assert_eq!(db.latest_stage_run(task_id).unwrap().unwrap().id, source_run_id);
```

- [ ] **Step 3: Run regressions and verify current failures**

Run:

```bash
cargo test -p kanna-daemon --test agent_sessions exited_persistent_kill -- --nocapture
cargo test -p kanna-server blocking_teardown -- --nocapture
```

Expected: the already-exited persistent kill emits no killed exit, and blocking teardown errors only warn before setup/spawn continues.

- [ ] **Step 4: Guarantee killed exit and abort required teardown**

In `kill_agent_session`, emit a killed exit whenever a retained agent record is successfully removed, regardless of `record.exited` or turn model:

```rust
broadcast_event(
    broadcast_tx,
    &Event::Exit {
        session_id: session_id.to_string(),
        run_id: record.run_id.clone(),
        code: -1,
        resume_session_id: record.provider_session_id.clone(),
        killed: true,
    },
);
```

In `spawn_prepared_stage_run_for_api`, replace the warning-only blocking teardown branch with rollback and return:

```rust
if let Err(error) =
    kill_session_replacing(daemon, replacements, teardown_session_id).await
{
    return Err(fail_prepared_stage_spawn(
        db_path,
        &run_id,
        &prepared,
        format!(
            "failed to stop blocking workspace teardown {teardown_session_id}: {error}"
        ),
    ));
}
```

No deferred setup or provider command may be constructed before this succeeds.

- [ ] **Step 5: Re-run lifecycle regressions**

Run the commands from Step 3 plus:

```bash
cargo test -p kanna-server terminal_watcher -- --nocapture
cargo test -p kanna-server task_creator::tests::revision -- --nocapture
```

Expected: exact source exit acknowledgments are consumed, successor exits remain visible, and all teardown faults stop before setup/spawn.

- [ ] **Step 6: Commit lifecycle hardening**

```bash
git add crates/daemon/src/agent_runtime/lifecycle.rs crates/daemon/tests/agent_sessions.rs crates/kanna-server/src/task_creator crates/kanna-server/src/terminal_watcher.rs
git commit -m "fix: fail closed around session replacement"
```

### Task 5: Full verification and review

**Files:**
- Inspect every modified file.

- [ ] **Step 1: Run focused suites**

```bash
cargo test -p kanna-daemon --test agent_sessions -- --nocapture
cargo test -p kanna-server task_creator::tests::revision -- --nocapture
cargo test -p kanna-server task_creator::tests::stage -- --nocapture
cargo test -p kanna-server terminal_watcher -- --nocapture
cargo test -p kanna-server http_api::tests::actions -- --nocapture
pnpm --dir apps/desktop test --run src/stores/pipeline.requestRevision.test.ts
```

- [ ] **Step 2: Run repository checks**

```bash
cargo fmt --check
git diff --check
pnpm test
./kd test rust
```

If a canonical check cannot run because of an external dependency or environment failure, preserve its complete output and run the nearest focused checks that exercise the changed components.

- [ ] **Step 3: Review the final diff against the approved design**

Confirm:

```text
provider_session_id is the only identity reused for conversation resume
new spawned processes use run-scoped daemon session IDs
no AgentInput path polls AgentSessions while a per-turn child is active
same revision idempotency key cannot create two successor runs
every successful retained-agent kill emits one killed Exit
blocking teardown failure cannot reach setup or provider spawn
```

- [ ] **Step 4: Invoke verification and branch-finishing workflows**

Read and follow `superpowers:verification-before-completion`, then
`superpowers:finishing-a-development-branch`. Do not push or create a pull
request; this Kanna pipeline owns later integration.

- [ ] **Step 5: Record Kanna stage completion**

Use `kanna_complete_stage` with the durable task ID and an evidence-based
summary. Use the CLI fallback only if the MCP tool is unavailable.
