# Retryable Handoff Sealed-Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit one pre-side-effect `retry_on_successor` daemon error and transparently replay Spawn, SpawnAgent, Kill, and AgentInput once after the successor PID and socket are published.

**Architecture:** The daemon-wide lifecycle write guard already linearizes handoff commit against mutation-command read guards. The daemon maps only those verified early refusals, plus existing atomic early seal refusals, to `RetryOnSuccessor`; late installer and transport failures stay non-retryable. Desktop and `kanna-server` clients retain the connected daemon PID, wait for a different PID whose socket is connectable, then resend the exact same serialized command once.

**Tech Stack:** Rust, Tokio Unix sockets, serde JSON protocol, Tauri desktop command layer, `kanna-server` task lifecycle tests.

---

## File Structure

- `crates/daemon/src/protocol.rs` — owns the shared typed error code.
- `crates/daemon/src/connection.rs` — maps lifecycle-committed and atomic Kill seal refusals.
- `crates/daemon/src/agent_runtime/commands.rs` — maps early SpawnAgent refusal and keeps resume-installer failures non-retryable.
- `crates/daemon/tests/handoff.rs` — producer contract across the four public commands and handoff commit.
- `apps/desktop/src-tauri/src/daemon_client.rs` — records the connected daemon PID.
- `apps/desktop/src-tauri/src/daemon_lifecycle.rs` — reusable PID-publication plus socket-connect readiness boundary.
- `apps/desktop/src-tauri/src/commands/daemon/protocol.rs` — classifies only `retry_on_successor` as successor-retryable.
- `apps/desktop/src-tauri/src/commands/daemon/connection.rs` — one-replay command executor shared by ack and spawn responses.
- `apps/desktop/src-tauri/src/commands/daemon.rs` — routes Spawn and SpawnAgent through the shared executor.
- `crates/kanna-server/src/daemon_client.rs` — retains daemon directory/PID and implements byte-stable one-replay successor retry.
- `crates/kanna-server/src/task_creator/lifecycle.rs` — uses successor retry for task Spawn and replacement Kill while preserving replacement bookkeeping.
- `crates/kanna-server/src/ksp.rs` — routes AgentInput through the same explicit successor-retry contract.
- `crates/kanna-server/src/task_creator/tests/mod.rs` and `spawn.rs` — sequential fake-daemon producer/consumer fixtures and Spawn assertions.
- `crates/kanna-server/src/task_creator/tests/stage.rs` — replacement Kill retry/bookkeeping assertions.

### Task 1: Define and emit the producer contract

**Files:**

- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/tests/handoff.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/agent_runtime/commands.rs`

- [ ] **Step 1: Write the failing handoff contract test**

Extend the handoff test protocol with the new error and commands:

```rust
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    // existing variants...
    RetryOnSuccessor,
}
```

Drive a v2 compatibility handoff to `HandoffReady`, send `Spawn`, `SpawnAgent`,
`Kill`, and `AgentInput` on ordinary clients, prove they remain blocked before
`HandoffAdopted`, then assert every response is:

```rust
Evt::Error {
    code: Some(ErrorCode::RetryOnSuccessor),
    ..
}
```

Use safe unique session IDs. No agent executable or existing session is needed:
the daemon lifecycle refusal must occur before command-specific work.

- [ ] **Step 2: Run the producer test and verify RED**

Run:

```bash
cargo test -p kanna-daemon --test handoff \
  test_handoff_commit_refuses_mutations_with_retry_on_successor -- --nocapture
```

Expected: FAIL because `retry_on_successor` is not a protocol variant and
committed refusals currently carry no code.

- [ ] **Step 3: Add the protocol code and early refusal mapping**

Add:

```rust
pub enum ErrorCode {
    // existing variants...
    RetryOnSuccessor,
}
```

In `connection.rs`, use
`Some(protocol::ErrorCode::RetryOnSuccessor)` for:

```rust
if *daemon_lifecycle_guard != DaemonLifecycleState::Running
```

in PTY Spawn, Kill, SpawnAgent, and AgentInput. Keep unsafe session-id
validation before the lifecycle check.

Map the atomic agent/PTTY Kill seal outcomes to the same code. In
`handle_spawn_agent`, map only the seal check before reservation/journaling to
`RetryOnSuccessor`.

In the AgentInput resume installer failure, remove the claim that a sealed
post-spawn failure is retryable and return `AgentSpawnFailed` (sealed orphan)
or `SessionNotFound` (replaced/removed record), never `RetryOnSuccessor`.

- [ ] **Step 4: Run the producer contract and protocol tests**

Run:

```bash
cargo test -p kanna-daemon --test handoff \
  test_handoff_commit_refuses_mutations_with_retry_on_successor -- --nocapture
cargo test -p kanna-daemon protocol::tests --lib
```

Expected: PASS.

- [ ] **Step 5: Add negative installer tests**

Keep `install_respawned_child`'s existing exact-incarnation cleanup behavior.
Extract the handler's late failure response into a small function:

```rust
fn post_spawn_install_error(session_id: &str, operation: &str) -> Event {
    agent_error(
        protocol::ErrorCode::AgentSpawnFailed,
        format!(
            "agent {operation} for session {session_id} was refused after child spawn"
        ),
    )
}
```

Use it when initial or resume installation returns `None`. Extend the existing
sealed installer tests in `crates/daemon/src/tests.rs` to assert the exact child
is killed/reaped, only the matching reservation is rolled back, and the
resulting error code is `AgentSpawnFailed`, not `RetryOnSuccessor`.

- [ ] **Step 6: Run daemon unit tests and commit**

Run:

```bash
cargo test -p kanna-daemon --lib
```

Expected: PASS.

Commit:

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/connection.rs \
  crates/daemon/src/agent_runtime/commands.rs crates/daemon/src/tests.rs \
  crates/daemon/tests/handoff.rs
git commit -m "feat(daemon): define retry-on-successor refusal"
```

### Task 2: Reuse desktop successor publication and replay once

**Files:**

- Modify: `apps/desktop/src-tauri/src/daemon_client.rs`
- Modify: `apps/desktop/src-tauri/src/daemon_lifecycle.rs`
- Modify: `apps/desktop/src-tauri/src/commands/daemon/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/commands/daemon/connection.rs`
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs`

- [ ] **Step 1: Write failing protocol classification tests**

Add:

```rust
#[test]
fn only_explicit_successor_refusal_requests_handoff_replay() {
    let retry = DaemonCommandError {
        message: "retry against successor".into(),
        code: Some("retry_on_successor".into()),
    };
    assert!(is_retry_on_successor(&retry));

    for error in [
        DaemonCommandError {
            message: "failed to read event: reset".into(),
            code: None,
        },
        DaemonCommandError {
            message: "connection closed by daemon".into(),
            code: None,
        },
        DaemonCommandError {
            message: "failed to flush command: broken pipe".into(),
            code: None,
        },
    ] {
        assert!(!is_retry_on_successor(&error));
    }
}
```

- [ ] **Step 2: Write a failing one-replay connection test**

Use two Unix listeners and a test PID publication hook. The first reads and
stores the raw JSON line, returns:

```json
{"type":"Error","code":"retry_on_successor","message":"retry on successor"}
```

Then publish a different PID and connectable replacement listener. The
replacement stores its raw line and returns the expected `Ok` or
`SessionCreated`. Assert:

```rust
assert_eq!(first_raw_line, second_raw_line);
assert_eq!(replacement_command_count, 1);
```

Return `retry_on_successor` from the replacement in a second test and assert it
is surfaced without a third connection.

- [ ] **Step 3: Record PID and factor the readiness boundary**

Add `connected_pid: Option<u32>` plus an accessor to desktop `DaemonClient`.
Capture the PID serving the connected Unix socket with `LOCAL_PEERPID` on
macOS (and `SO_PEERCRED` on Linux test hosts). A test-only stream constructor
accepts an explicit PID so sequential fake listeners can model distinct daemon
processes without forking test binaries. Factor the existing
`daemon.pid` plus socket-connect loop into:

```rust
pub(crate) async fn wait_for_published_daemon(
    expectation: PublishedDaemonExpectation,
) -> Result<DaemonClient, String>
```

with:

```rust
enum PublishedDaemonExpectation {
    Exact(u32),
    SuccessorOf(u32),
}
```

Accept a connection only when its recorded PID equals the published PID and
the expectation. Use `Exact(child.id())` from `ensure_daemon_running`; use
`SuccessorOf(previous_pid)` from command retry.

- [ ] **Step 4: Implement the byte-stable shared executor**

Add:

```rust
pub(super) fn is_retry_on_successor(error: &DaemonCommandError) -> bool {
    error.code.as_deref() == Some("retry_on_successor")
}
```

Implement a generic parser-backed executor that takes `&str`, sends exactly
that string, and has one explicit retry branch:

```rust
match send_command_once(state, json, parse).await {
    Err(error) if is_retry_on_successor(&error) => {
        let previous_pid = connected_pid(state).await?;
        clear_daemon_client(state).await;
        let successor =
            wait_for_published_daemon(PublishedDaemonExpectation::SuccessorOf(previous_pid))
                .await?;
        *state.lock().await = Some(successor);
        send_command_once(state, json, parse).await
    }
    result => result,
}
```

Do not loop. Do not classify read/EOF/timeout/post-side-effect errors as
successor refusals.

- [ ] **Step 5: Route Spawn and SpawnAgent through the executor**

Add a `parse_session_created` parser and replace their manual send/read blocks
with:

```rust
send_command_expect_session_created(&state, &json).await
```

Keep ack commands on `send_command_expect_ack`.

- [ ] **Step 6: Run desktop Rust tests and commit**

Run:

```bash
cargo test -p kanna-desktop commands::daemon
```

Expected: PASS.

Commit:

```bash
git add apps/desktop/src-tauri/src/daemon_client.rs \
  apps/desktop/src-tauri/src/daemon_lifecycle.rs \
  apps/desktop/src-tauri/src/commands/daemon.rs \
  apps/desktop/src-tauri/src/commands/daemon/connection.rs \
  apps/desktop/src-tauri/src/commands/daemon/protocol.rs
git commit -m "fix(desktop): retry sealed commands on successor"
```

### Task 3: Retry kanna-server Spawn, replacement Kill, and AgentInput

**Files:**

- Modify: `crates/kanna-server/src/daemon_client.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/spawn.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] **Step 1: Write the failing server Spawn retry test**

Add a sequential fake daemon fixture that:

1. accepts the existing client and returns `RetryOnSuccessor`;
2. records the first raw command;
3. publishes a distinct `daemon.pid` and replacement listener;
4. accepts one successor connection and returns `SessionCreated`;
5. records the second raw command.

Assert `spawn_prepared_task` succeeds and:

```rust
assert_eq!(first_raw_command, retry_raw_command);
assert_eq!(successor_spawn_count, 1);
```

- [ ] **Step 2: Write the failing replacement Kill bookkeeping test**

Begin with no replacement entry. Have the old daemon refuse Kill, then have the
successor return `Ok`. Assert:

```rust
assert!(kill_session_replacing(...).await.is_ok());
assert_eq!(old_commands, vec![expected_kill.clone()]);
assert_eq!(new_commands, vec![expected_kill]);
assert!(replacements.consume(session_id));
assert!(!replacements.consume(session_id));
```

The first `consume` represents the one matching Exit; the second proves another
Exit is not swallowed as another replacement.

Add a second-successor-refusal test proving the replacement entry is cancelled
when the single replay is exhausted.

- [ ] **Step 3: Implement byte-stable successor retry in DaemonClient**

Store:

```rust
daemon_dir: String,
connected_pid: Option<u32>,
```

Split serialization from round trip:

```rust
async fn send_serialized_command(&mut self, json: &str) -> Result<Event, Box<dyn Error>>
```

Then add:

```rust
pub async fn send_command_retrying_successor(
    &mut self,
    command: &Command,
) -> Result<Event, Box<dyn Error>>
```

Serialize once. If and only if the returned event has
`ErrorCode::RetryOnSuccessor`, wait for a different published PID plus a
connectable socket, replace `self`, and call `send_serialized_command(&json)`
once more.

- [ ] **Step 4: Use the retry API without resetting bookkeeping**

Change task Spawn and replacement Kill:

```rust
daemon.send_command_retrying_successor(&command).await
```

Call `replacements.begin(session_id)` before the first Kill and leave it active
inside the retry method. Preserve existing cancellation for transport errors,
final not-found, unexpected response, and the successor's final error.

Route KSP agent commands through the same method. Only `AgentInput` can receive
`retry_on_successor`; permission, interrupt, and model commands retain their
existing behavior because the producer never emits that code for them.

- [ ] **Step 5: Run server tests and commit**

Run:

```bash
cargo test -p kanna-server task_creator
cargo test -p kanna-server daemon_client
```

Expected: PASS.

Commit:

```bash
git add crates/kanna-server/src/daemon_client.rs \
  crates/kanna-server/src/task_creator/lifecycle.rs \
  crates/kanna-server/src/ksp.rs \
  crates/kanna-server/src/task_creator/tests/mod.rs \
  crates/kanna-server/src/task_creator/tests/spawn.rs \
  crates/kanna-server/src/task_creator/tests/stage.rs
git commit -m "fix(server): retry task lifecycle on daemon successor"
```

### Task 4: Prove no duplicate sessions or Exit publication

**Files:**

- Modify: `crates/daemon/tests/handoff.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] **Step 1: Add a real handoff retry lifecycle test**

Spawn one PTY and subscribe to lifecycle events. Start a successor daemon,
issue Kill while the old daemon owns the handoff write guard, and consume
`RetryOnSuccessor` after commit. Wait for the successor PID/socket boundary,
replay the same Kill once, and assert:

```rust
assert_eq!(killed_exit_count, 1);
assert_eq!(remaining_sessions_with_id, 0);
```

For Spawn, issue it during handoff, replay once on the successor, then List and
assert exactly one matching session and one `SessionCreated`.

- [ ] **Step 2: Run the idempotency tests**

Run:

```bash
cargo test -p kanna-daemon --test handoff \
  retry_on_successor -- --nocapture
```

Expected: PASS with one session creation and one killed Exit.

- [ ] **Step 3: Commit**

```bash
git add crates/daemon/tests/handoff.rs \
  crates/kanna-server/src/task_creator/tests/stage.rs
git commit -m "test: prove handoff command retry idempotency"
```

### Task 5: Verify the complete scoped change

**Files:**

- Modify if needed: files above only.

- [ ] **Step 1: Format**

Run from the repository root:

```bash
cargo fmt --all
cargo fmt --all -- --check
```

Inspect any formatting diff before continuing.

- [ ] **Step 2: Run required Clippy**

Run from the repository root:

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

Expected: exit 0.

- [ ] **Step 3: Run daemon and kanna-server suites**

Run:

```bash
cargo test -p kanna-daemon
cargo test -p kanna-server
```

Expected: all tests pass.

- [ ] **Step 4: Run canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: all canonical Rust checks pass.

- [ ] **Step 5: Inspect scope and invariants**

Run:

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  crates/daemon \
  apps/desktop/src-tauri/src \
  crates/kanna-server/src \
  docs/superpowers
```

Confirm:

- `RetryOnSuccessor` appears only at verified pre-side-effect lifecycle/seal
  refusals.
- No transport or late installer error maps to it.
- Each consumer has one replay branch and no retry loop.
- The serialized command is reused unchanged.
- Replacement bookkeeping spans the refused Kill and its retry.
- Exact-incarnation teardown and Exit publication code are otherwise
  unchanged.

- [ ] **Step 6: Commit any verification-only fixes**

```bash
git add crates/daemon/src crates/daemon/tests/handoff.rs \
  apps/desktop/src-tauri/src/daemon_client.rs \
  apps/desktop/src-tauri/src/daemon_lifecycle.rs \
  apps/desktop/src-tauri/src/commands/daemon.rs \
  apps/desktop/src-tauri/src/commands/daemon \
  crates/kanna-server/src/daemon_client.rs \
  crates/kanna-server/src/task_creator \
  docs/superpowers
git commit -m "fix: address retry contract verification"
```
