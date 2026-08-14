# Terminal Stage Transition Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an ordered, replayable `Stage advanced: old → new` separator into PTY terminal history whenever a durable task advances to another workflow stage.

**Architecture:** `kanna-server` formats and sanitizes the stage transition, stores it on the prepared stage swap, and sends it as an optional byte prelude in the daemon `Spawn` command. `kanna-daemon` mirrors that prelude through its normal terminal-output path before starting the PTY reader, so the marker precedes child output and is retained in attach and recovery snapshots. Non-transition spawns pass no prelude, and SDK/headless agent sessions remain unchanged because they do not expose a terminal snapshot.

**Tech Stack:** Rust, serde JSON daemon protocol, Kanna PTY daemon/headless terminal, Tokio integration tests

---

## File Structure

- Create `crates/kanna-server/src/task_creator/terminal_marker.rs`: sanitize stage display text and format the ANSI terminal separator.
- Modify `crates/kanna-server/src/task_creator/mod.rs`: register the marker module and initialize prepared runs without a marker by default.
- Modify `crates/kanna-server/src/task_creator/types.rs`: carry the optional terminal prelude on prepared stage runs.
- Modify `crates/kanna-server/src/task_creator/stages.rs`: assign a marker only in `prepare_swap_to_index`.
- Modify `crates/kanna-server/src/task_creator/lifecycle.rs`: forward the prepared prelude only to PTY daemon spawns.
- Modify `crates/kanna-server/src/task_creator/tests/stage.rs`: prove true advances emit markers and non-transition revision preparation does not.
- Modify `crates/daemon/src/protocol.rs`: add the backward-compatible optional `terminal_prelude` field to PTY `Spawn`.
- Modify `crates/daemon/src/connection.rs`: mirror the prelude before starting the child-output reader.
- Modify `crates/daemon/src/output.rs`: expose the existing output-chunk path within the crate for spawn initialization.
- Modify `crates/daemon/tests/reconnect.rs`: exercise marker ordering and attach-snapshot retention through the real daemon socket.
- Update Rust `Command::Spawn` construction fixtures under `crates/kanna-server/src/http_api/tests/`, `crates/kanna-server/src/task_creator/tests/`, and `crates/kanna-server/tests/provider_resolution_http.rs` with `terminal_prelude: None` where compilation requires an explicit field.

### Task 1: Add the optional daemon spawn prelude protocol

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify construction fixtures returned by `rg -l 'Command::Spawn \\{' crates apps --glob '*.rs'`

- [ ] **Step 1: Write failing protocol tests**

Extend `test_command_spawn_roundtrip` to construct a prelude and assert it survives JSON round-trip, then add a compatibility test which deserializes a legacy `Spawn` payload without the field:

```rust
let cmd = Command::Spawn {
    session_id: "abc123".to_string(),
    executable: "/bin/bash".to_string(),
    args: vec!["-l".to_string()],
    cwd: "/tmp".to_string(),
    env,
    cols: 80,
    rows: 24,
    agent_provider: Some(AgentProvider::Codex),
    terminal_prelude: Some(b"stage marker\r\n".to_vec()),
};
```

The decoded match must assert `terminal_prelude == Some(b"stage marker\r\n".to_vec())`. The compatibility test must assert a JSON object without `terminal_prelude` decodes with `terminal_prelude: None`.

- [ ] **Step 2: Run the focused protocol tests and verify RED**

Run: `cargo test -p kanna-daemon protocol::tests::test_command_spawn -- --nocapture`

Expected: compilation fails because `Command::Spawn` has no `terminal_prelude` field.

- [ ] **Step 3: Implement the protocol field**

Add this field after `agent_provider`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
terminal_prelude: Option<Vec<u8>>,
```

Update all Rust construction sites that create `Command::Spawn` to pass `terminal_prelude: None`; retain `..` in destructuring patterns where appropriate.

- [ ] **Step 4: Run the protocol tests and verify GREEN**

Run: `cargo test -p kanna-daemon protocol::tests::test_command_spawn -- --nocapture`

Expected: both spawn round-trip and legacy compatibility tests pass.

- [ ] **Step 5: Commit the protocol change**

```bash
git add crates/daemon/src/protocol.rs crates/kanna-server apps/desktop/src-tauri
git commit -m "feat(daemon): add optional terminal spawn prelude"
```

### Task 2: Mirror the prelude before PTY child output

**Files:**
- Modify: `crates/daemon/tests/reconnect.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/output.rs`

- [ ] **Step 1: Write the failing real-daemon integration test**

Add `stage_transition_prelude_precedes_process_output_in_snapshot` to `reconnect.rs`. Extend its wire-test `Cmd::Spawn` shape with `#[serde(default, skip_serializing_if = "Option::is_none")] terminal_prelude: Option<Vec<u8>>`, spawn a shell which prints a unique process marker and stays alive briefly, and send a unique prelude:

```rust
let prelude = "\r\n\x1b[2m━━ Stage advanced: in progress → review ━━\x1b[0m\r\n"
    .as_bytes()
    .to_vec();
conn.send(&Cmd::Spawn {
    session_id: session_id.to_string(),
    executable: "/bin/sh".to_string(),
    args: vec!["-c".to_string(), "printf 'NEW_STAGE_PROCESS_OUTPUT\\n'; sleep 2".to_string()],
    cwd: "/tmp".to_string(),
    env: HashMap::new(),
    cols: 100,
    rows: 24,
    terminal_prelude: Some(prelude),
});
```

Attach after `SessionCreated`, read the `Snapshot`, and assert both `Stage advanced: in progress → review` and `NEW_STAGE_PROCESS_OUTPUT` occur in `vt`, with the marker's index lower than the process output's index.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `cargo test -p kanna-daemon --test reconnect stage_transition_prelude_precedes_process_output_in_snapshot -- --exact --nocapture`

Expected: the snapshot contains process output but not the prelude.

- [ ] **Step 3: Implement ordered prelude mirroring**

Make `output::handle_output_chunk` `pub(crate)`. In `connection::handle_command`, bind `terminal_prelude` from `Command::Spawn`. After inserting the `SessionHandle`, starting recovery mirroring, and registering the empty writer list—but before `tokio::spawn(stream_output(...))`—route non-empty bytes through the existing output path:

```rust
if let Some(prelude) = terminal_prelude.as_deref().filter(|bytes| !bytes.is_empty()) {
    output::handle_output_chunk(
        &session_id,
        prelude,
        &handle,
        &broadcast_tx,
        &session_writers,
        &terminal_emulator_clients,
        &session_sizes,
        &session_observers,
        &recovery_manager,
    )
    .await;
}
```

This must remain before launching `stream_output`, because the child may already have bytes buffered in the PTY.

- [ ] **Step 4: Run daemon tests and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon --test reconnect stage_transition_prelude_precedes_process_output_in_snapshot -- --exact --nocapture
cargo test -p kanna-daemon protocol::tests::test_command_spawn -- --nocapture
```

Expected: the integration test proves ordering and snapshot retention; protocol tests remain green.

- [ ] **Step 5: Commit daemon behavior**

```bash
git add crates/daemon/src/connection.rs crates/daemon/src/output.rs crates/daemon/tests/reconnect.rs
git commit -m "feat(daemon): seed terminal history with spawn prelude"
```

### Task 3: Format and attach markers to true stage advances

**Files:**
- Create: `crates/kanna-server/src/task_creator/terminal_marker.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] **Step 1: Write failing formatter and stage-routing tests**

In `terminal_marker.rs`, add tests before implementation:

```rust
#[test]
fn formats_dim_stage_transition_separator() {
    assert_eq!(
        format_stage_transition_marker("in progress", "review"),
        "\r\n\x1b[2m━━ Stage advanced: in progress → review ━━\x1b[0m\r\n"
            .as_bytes()
            .to_vec()
    );
}

#[test]
fn strips_terminal_control_characters_from_stage_names() {
    let marker = format_stage_transition_marker("in\nprogress\x1b[31m", "re\rview");
    assert_eq!(
        marker,
        "\r\n\x1b[2m━━ Stage advanced: inprogress[31m → review ━━\x1b[0m\r\n"
            .as_bytes()
            .to_vec()
    );
}
```

In `prepare_advance_stage_forks_workspace_for_next_run_in_same_task`, assert `run.terminal_prelude` equals the formatted `in progress → review` marker. Add or extend a revision-preparation test to assert `terminal_prelude.is_none()`.

- [ ] **Step 2: Run the focused server tests and verify RED**

Run:

```bash
cargo test -p kanna-server task_creator::terminal_marker::tests -- --nocapture
cargo test -p kanna-server prepare_advance_stage_forks_workspace_for_next_run_in_same_task -- --exact --nocapture
```

Expected: compilation fails because the formatter module and prepared-run field do not exist.

- [ ] **Step 3: Implement marker formatting and stage ownership**

Create the formatter with control-character filtering:

```rust
fn sanitize_stage_name(stage: &str) -> String {
    stage.chars().filter(|character| !character.is_control()).collect()
}

pub(super) fn format_stage_transition_marker(from: &str, to: &str) -> Vec<u8> {
    format!(
        "\r\n\x1b[2m━━ Stage advanced: {} → {} ━━\x1b[0m\r\n",
        sanitize_stage_name(from),
        sanitize_stage_name(to),
    )
    .into_bytes()
}
```

Register `mod terminal_marker;`, add `pub(super) terminal_prelude: Option<Vec<u8>>` to `PreparedStageRunSpawn`, and initialize it to `None` in `prepare_stage_run_spawn`.

In `prepare_swap_to_index`, mutate only the `Run` result produced for the next workflow stage:

```rust
let from_stage = context.source_task.stage.as_deref().ok_or_else(|| {
    format!("task has no stage: {}", context.source_task_id)
})?;
let mut run = prepare_stage_run_for_target(
    db, config, context, next_stage, &next_stage.name, "main", None, None,
)?;
run.terminal_prelude = Some(super::terminal_marker::format_stage_transition_marker(
    from_stage,
    &next_stage.name,
));
Ok(PreparedStageTransition::Run(Box::new(run)))
```

This placement excludes initial creation, posts, reruns, revisions, and closure.

- [ ] **Step 4: Forward the marker to PTY spawns only**

Add `terminal_prelude: Option<Vec<u8>>` to `spawn_session_command`. Pass `None` from task creation, rerun, and teardown call sites; pass `prepared.terminal_prelude.clone()` from `spawn_prepared_stage_run_for_api`. In the PTY match arm, populate `DaemonCommand::Spawn { terminal_prelude, ... }`. In the `PreparedSessionSpawn::Agent` arm, intentionally do not attach the bytes because SDK sessions have no terminal.

- [ ] **Step 5: Run focused server tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server task_creator::terminal_marker::tests -- --nocapture
cargo test -p kanna-server prepare_advance_stage_forks_workspace_for_next_run_in_same_task -- --exact --nocapture
cargo test -p kanna-server revision -- --nocapture
```

Expected: formatter, stage advance, and revision tests pass.

- [ ] **Step 6: Commit server behavior**

```bash
git add crates/kanna-server/src/task_creator
git commit -m "feat(server): mark terminal stage transitions"
```

### Task 4: Verify the integrated change

**Files:**
- Verify all modified Rust files

- [ ] **Step 1: Format and inspect the diff**

Run:

```bash
cargo fmt --all -- --check
git diff --check
git status --short
git diff --stat
```

Expected: formatting and whitespace checks pass; only the spec, plan, daemon protocol/output, and server stage-transition files are changed by this task.

- [ ] **Step 2: Run package test suites**

Run:

```bash
cargo test -p kanna-daemon
cargo test -p kanna-server
```

Expected: both package suites pass with no failed tests.

- [ ] **Step 3: Run canonical Rust verification**

Run: `./kd test rust`

Expected: the repository's canonical Rust checks pass. If an unrelated pre-existing failure occurs, capture the exact command and failure without changing unrelated code.

- [ ] **Step 4: Review final behavior against the spec**

Confirm from tests and diff that:

- Only `prepare_swap_to_index` assigns a prelude.
- Stage names cannot introduce terminal control characters.
- Prelude bytes enter the authoritative headless terminal before PTY output reading begins.
- Legacy spawn JSON without the field remains valid.
- SDK/headless, post, rerun, revision, creation, teardown, and close paths remain unchanged.

- [ ] **Step 5: Commit any verification-only fixes**

If formatting or focused test fixes changed tracked files:

```bash
git add crates/daemon crates/kanna-server
git commit -m "test: verify terminal stage transition markers"
```
