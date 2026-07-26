# Review Race Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daemon agent delivery non-blocking, unify legacy relay task mutations with HTTP ownership serialization, and preserve generic CLI compatibility with old catalog overrides.

**Architecture:** Agent journals enqueue to byte-budgeted per-client writer tasks, keeping generation validation atomic while moving socket progress outside shared locks. Legacy relay close/advance commands translate to authenticated HTTP actions on the shared `AppState`. Generic CLI completion resolves the active catalog first and adds process-owned `runId` only to the resolved request body.

**Tech Stack:** Rust, Tokio Unix sockets and channels, Axum/Tower HTTP dispatch, SQLite-backed Kanna task lifecycle, `kanna-tool-catalog`, Rust unit and integration tests.

---

### Task 1: Non-blocking daemon agent fan-out

**Files:**
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime.rs`
- Modify: `crates/daemon/src/agent_runtime/commands.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/tests/agent_sessions.rs`

- [ ] **Step 1: Write the stalled-client regression**

Add an integration test to `crates/daemon/tests/agent_sessions.rs` that:

```rust
#[test]
fn stalled_agent_client_does_not_block_unrelated_agent_operations() {
    // Start the daemon with a debug writer barrier.
    // Spawn and attach session A, receiving its initial snapshot.
    // Trigger a live event and wait until A's mailbox writer reaches the barrier.
    // Spawn session B and issue AgentSetModel on a separate connection.
    // Assert B receives Ok before releasing A's writer barrier.
}
```

Use a barrier path passed through `KANNA_TEST_AGENT_WRITER_BARRIER`. The writer task must create `blocked` only after it has delivered the initial snapshot, and wait for `release` before writing the next live event.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
cargo test --manifest-path crates/daemon/Cargo.toml --test agent_sessions stalled_agent_client_does_not_block_unrelated_agent_operations -- --exact --nocapture
```

Expected: FAIL because current fan-out awaits the stalled socket while holding the daemon-wide `AgentSessions` mutex during persistent input journaling.

- [ ] **Step 3: Add byte-budgeted agent subscribers**

Replace `AgentShared.writers: Vec<AgentClientWriter>` with subscriber records that contain:

```rust
pub struct AgentSubscriber {
    pub writer_id: usize,
    pub tx: tokio::sync::mpsc::UnboundedSender<AgentEventLine>,
    pub pending_bytes: Arc<AtomicUsize>,
    pub writer: AgentClientWriter,
    pub writer_task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
pub struct AgentEventLine {
    pub line: Arc<str>,
}
```

Keep the byte limit in the daemon runtime, serialize each `Event` once, increment pending bytes before enqueue, and decrement after each completed or discarded write. If enqueueing would exceed the budget or the writer task has closed, remove that subscriber, abort its task, and asynchronously shut down only that socket.

- [ ] **Step 4: Make append and attach enqueue-only**

In `crates/daemon/src/agent_runtime.rs`:

```rust
async fn journal_and_fan_out_for_generation(...) -> bool {
    let mut shared = shared.lock().await;
    if shared.spawn_generation != spawn_generation {
        return false;
    }
    let entry = shared.journal.append(event);
    let wire = Event::AgentEvent {
        session_id: session_id.to_string(),
        seq: entry.seq,
        event: entry.event,
    };
    enqueue_agent_event(&mut shared.writers, &wire);
    true
}
```

Register the subscriber and enqueue its `AgentSnapshot` under the same `AgentShared` lock in `handle_attach_agent`. The writer task performs all socket writes after that lock is released.

Update cleanup, detach, and kill paths to cancel/remove subscriber records without awaiting client I/O.

- [ ] **Step 5: Split persistent input ownership checks around journaling**

Change `handle_agent_input` so the first registry critical section only revalidates generation/run/shared identity and writes the input line. Drop the registry lock before `journal_and_fan_out_for_generation`. Then reacquire the registry and revalidate the same identity before calling `set_status`.

Return `WriteFailed` if ownership changes before journaling or before the status update. Never mutate a replacement record.

- [ ] **Step 6: Run focused daemon tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/daemon/Cargo.toml --test agent_sessions stalled_agent_client_does_not_block_unrelated_agent_operations -- --exact --nocapture
cargo test --manifest-path crates/daemon/Cargo.toml --test agent_sessions persistent_input_captured_before_kill_cannot_reach_or_journal_successor -- --exact --nocapture
cargo test --manifest-path crates/daemon/Cargo.toml agent_runtime -- --nocapture
```

Expected: all PASS.

- [ ] **Step 7: Commit the daemon fix**

```bash
git add crates/daemon/src/agent.rs crates/daemon/src/agent_runtime.rs crates/daemon/src/agent_runtime/commands.rs crates/daemon/src/agent_runtime/lifecycle.rs crates/daemon/tests/agent_sessions.rs
git commit -m "fix(daemon): isolate agent clients from registry operations"
```

### Task 2: Shared relay and HTTP task-action ownership

**Files:**
- Modify: `crates/kanna-server/Cargo.toml`
- Modify: `crates/kanna-server/src/commands.rs`
- Modify: `crates/kanna-server/src/relay.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/relay_dispatch.rs`

- [ ] **Step 1: Write the legacy-relay-versus-HTTP race regression**

Add a multi-thread Tokio test to `relay_dispatch.rs` that:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_relay_task_action_conflicts_with_http_action_flight() {
    // Seed one task and install a blocking test close handler.
    // Start POST /actions/close through the HTTP router and wait for the handler.
    // Dispatch legacy advance_stage for the same task through a real relay sink.
    // Assert the legacy id-addressed response contains the shared 409 conflict.
    // Release close, assert it completes, then prove the action flight can be acquired again.
}
```

Move test hooks in `close_task` and `advance_stage` after durable task-id resolution and `begin_task_action`, so tests exercise the production action flight.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml legacy_relay_task_action_conflicts_with_http_action_flight -- --nocapture
```

Expected: FAIL because the legacy relay path directly executes `commands::handle_invoke` and never acquires `AppState::task_action_flights`.

- [ ] **Step 3: Translate supported legacy mutations to HTTP actions**

Add a pure mapping helper:

```rust
pub(crate) fn legacy_task_action_request(
    command: &str,
    args: &Value,
) -> Result<Option<(&'static str, String, Value)>, String>
```

Map only `close_task` and `advance_stage` to their POST paths, URL-encoding the task id with the shared catalog/path encoder. Remove those direct mutation arms from `commands::handle_invoke` so no supported legacy relay route can bypass the shared lifecycle.

Add `kanna-tool-catalog = { path = "../kanna-tool-catalog" }` to `crates/kanna-server/Cargo.toml` and use its existing `encode_path_segment` implementation rather than introducing a second URL encoder.

- [ ] **Step 4: Dispatch translated actions without blocking the relay loop**

Add `dispatch_legacy_relay_task_action` beside `dispatch_relay_http_invoke`. Reuse the relay invoke semaphore and blocking-pool HTTP dispatcher:

```rust
http_api::dispatch_authenticated_http_invoke(
    Arc::clone(&http_state),
    method,
    &path,
    body,
).await
```

Convert success to legacy `data` (`null` for 204) and HTTP failure to the legacy `error` field while preserving the invoke id. Detect and dispatch this path before opening the old short-lived daemon connection.

- [ ] **Step 5: Run focused server tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml legacy_relay_task_action_conflicts_with_http_action_flight -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml http_api::tests::relay_dispatch -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml http_api::tests::actions -- --nocapture
```

Expected: all PASS.

- [ ] **Step 6: Commit the relay ownership fix**

```bash
git add crates/kanna-server/Cargo.toml crates/kanna-server/src/commands.rs crates/kanna-server/src/relay.rs crates/kanna-server/src/http_api/task_actions.rs crates/kanna-server/src/http_api/tests/relay_dispatch.rs
git commit -m "fix(server): serialize legacy relay task actions"
```

### Task 3: Post-resolution CLI run ownership

**Files:**
- Modify: `crates/kanna-cli/src/commands/tool.rs`
- Modify: `crates/kanna-cli/src/tests/cli_surface.rs`
- Modify: `crates/kanna-cli/src/tests/mod.rs`
- Modify: `crates/kanna-cli/tests/tool_call.rs`

- [ ] **Step 1: Write the old-override CLI contract test**

Extend `tool_call.rs` with:

```rust
#[test]
fn current_cli_binds_run_id_after_resolving_old_override_catalog() {
    // Write bundled_catalog() to <temp>/.kanna/mcp-tools.json after removing
    // the kanna_complete_stage run_id parameter.
    // Run current kanna-cli from that cwd with KANNA_STAGE_RUN_ID.
    // Verify the fixture receives runId in the POST body and the command succeeds.
}
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-cli/Cargo.toml --test tool_call current_cli_binds_run_id_after_resolving_old_override_catalog -- --exact --nocapture
```

Expected: FAIL with `unknown argument: run_id` from the old override catalog.

- [ ] **Step 3: Resolve first and bind ownership to the HTTP body**

Replace `bind_stage_run_id` with an MCP-matching resolver:

```rust
pub(crate) fn resolve_tool_request(
    catalog: &Catalog,
    name: &str,
    args: &Value,
    stage_run_id: Option<&str>,
) -> Result<ResolvedRequest, String> {
    let mut request = resolve_request(catalog, name, args)?;
    if name == "kanna_complete_stage" {
        if let Some(run_id) = stage_run_id.map(str::trim).filter(|id| !id.is_empty()) {
            request.body.as_object_mut()
                .ok_or_else(|| "resolved tool request body must be a JSON object".to_string())?
                .insert("runId".to_string(), Value::String(run_id.to_string()));
        }
    }
    Ok(request)
}
```

Use it from `call_catalog_tool`. Update the unit test to assert the environment-owned value overrides an explicit caller value in the resolved camel-case request body.

- [ ] **Step 4: Run focused CLI tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/kanna-cli/Cargo.toml --test tool_call -- --nocapture
cargo test --manifest-path crates/kanna-cli/Cargo.toml generic_complete_stage_tool_call -- --nocapture
```

Expected: all PASS.

- [ ] **Step 5: Commit the CLI compatibility fix**

```bash
git add crates/kanna-cli/src/commands/tool.rs crates/kanna-cli/src/tests/cli_surface.rs crates/kanna-cli/src/tests/mod.rs crates/kanna-cli/tests/tool_call.rs
git commit -m "fix(cli): bind stage ownership after catalog resolution"
```

### Task 4: Cross-component verification

**Files:**
- Verify all modified files

- [ ] **Step 1: Format and inspect**

Run:

```bash
cargo fmt --all --manifest-path crates/daemon/Cargo.toml -- --check
git diff --check
git status --short
```

Expected: formatting and diff checks pass; only intended task changes remain.

- [ ] **Step 2: Run package suites**

Run:

```bash
cargo test --manifest-path crates/daemon/Cargo.toml
cargo test --manifest-path crates/kanna-server/Cargo.toml
cargo test --manifest-path crates/kanna-cli/Cargo.toml
```

Expected: all PASS.

- [ ] **Step 3: Run the canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: PASS. If an unrelated environment limitation prevents the full command, preserve and report the focused package evidence and the exact external failure.

- [ ] **Step 4: Review final branch state**

Run:

```bash
git log --oneline -5
git status --short
git diff HEAD~4 --stat
```

Expected: the design, daemon, server, and CLI commits are present and the worktree is clean.
