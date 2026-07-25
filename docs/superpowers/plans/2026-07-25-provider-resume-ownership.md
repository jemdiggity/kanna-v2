# Provider Resume Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider conversation discovery, persistence, and revision resume attributable to the exact main stage run and daemon spawn, with fail-closed mixed-version behavior.

**Architecture:** Generate the owning main `stage_run.id` before spawning and pass it to the daemon as `KANNA_STAGE_RUN_ID`; daemon lifecycle events echo this immutable `run_id`, and database updates target that row directly. Discover interactive Codex handles from Codex-owned `session_meta` files rather than terminal text. Negotiate capabilities through the backward-compatible `List` response and expose new events only through a versioned subscription.

**Tech Stack:** Rust, Tokio Unix-socket protocol, serde/serde_json, rusqlite/SQLite, Cargo tests

---

## File Structure

- `crates/daemon/src/protocol.rs` — daemon capabilities, versioned subscription, and optional run ownership on lifecycle events/handoff.
- `crates/daemon/src/connection.rs` — capability advertisement, subscription filtering, and PTY run ownership.
- `crates/daemon/src/agent.rs` — headless run ownership retained with the spawned agent record.
- `crates/daemon/src/agent_runtime/{commands,readers,lifecycle,adoption}.rs` — emit owned provider/exit events and preserve ownership through handoff.
- `crates/daemon/src/codex_session.rs` — provider-owned Codex session metadata discovery.
- `crates/daemon/src/session.rs`, `crates/daemon/src/output.rs`, `crates/daemon/src/handoff.rs`, and `crates/daemon/src/startup.rs` — retain PTY ownership and verified Codex handles across exit/handoff.
- `crates/kanna-server/src/daemon_client.rs` — parse and require daemon capabilities.
- `crates/kanna-server/src/db/stage_runs.rs` — latest-main selection and exact-run handle updates.
- `crates/kanna-server/src/task_creator/{lifecycle,stages}.rs` — pre-insert owned main runs, require resume capability, and fail closed on the newest main run.
- `crates/kanna-server/src/terminal_watcher.rs` — negotiate the event stream and persist handles by immutable run ID.
- Existing colocated Rust test modules — regression coverage for each behavior.

### Task 1: Fail-closed database ownership and resume selection

**Files:**
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Test: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] **Step 1: Write failing exact-owner database tests**

Replace the reusable-session update regression with two main runs and a post:

```rust
assert!(db.update_stage_run_provider_session_id(
    "run-implement",
    "codex-thread",
).unwrap());
let runs = db.list_stage_runs_for_task("task-1").unwrap();
assert_eq!(runs[0].provider_session_id.as_deref(), Some("codex-thread"));
assert_eq!(runs[1].provider_session_id, None); // commit post
assert_eq!(runs[2].provider_session_id, None); // replacement main
```

Add a return-value assertion proving the helper reports the owning task only while
`run-implement` is the newest main run, and returns no current-task owner after
`run-replacement` exists.

- [ ] **Step 2: Run the database tests and verify RED**

Run: `cargo test -p kanna-server provider_session_id_updates_exact_owning_main_run`

Expected: FAIL because the current API accepts a reusable terminal session ID and
selects the newest eligible row.

- [ ] **Step 3: Implement exact-run persistence**

Change the update to:

```sql
UPDATE stage_run
SET provider_session_id = ?2
WHERE id = ?1 AND kind = 'main' AND provider_session_id IS NULL
```

Return a small result containing `changed` and the task ID only when no newer main
run exists. Use `(datetime(started_at), id)` ordering consistently.

- [ ] **Step 4: Write the newer-null-run revision regression**

Seed `run-claude-old` with a handle, then seed a newer `run-codex-new` for the same
stage with a null handle. Assert revision preparation forks a numbered workspace and
does not resume the Claude ID.

- [ ] **Step 5: Run the revision test and verify RED**

Run: `cargo test -p kanna-server revision_does_not_skip_newer_null_handle_main_run`

Expected: FAIL because `latest_resumable_stage_run` filters null handles in SQL and
returns the older Claude row.

- [ ] **Step 6: Select newest main first**

Rename the query to `latest_main_stage_run`, remove handle/cwd predicates, and let
`prepare_revision_resume` validate that exact row. Keep all existing provider,
worktree, transcript, tip, and definition checks.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
cargo test -p kanna-server provider_session_id_updates_exact_owning_main_run
cargo test -p kanna-server revision_does_not_skip_newer_null_handle_main_run
cargo test -p kanna-server task_creator::tests::revision
```

Expected: PASS.

Commit:

```bash
git add crates/kanna-server/src/db/stage_runs.rs crates/kanna-server/src/db/tests.rs crates/kanna-server/src/task_creator/stages.rs crates/kanna-server/src/task_creator/tests/revision.rs
git commit -m "fix(server): bind resume handles to owning runs"
```

### Task 2: Negotiate daemon capabilities and version the event stream

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/tests.rs`
- Modify: `crates/kanna-server/src/daemon_client.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] **Step 1: Write failing protocol compatibility tests**

Add tests for:

```rust
let old: Event = serde_json::from_str(
    r#"{"type":"SessionList","sessions":[]}"#
).unwrap();
assert!(matches!(old, Event::SessionList { capabilities: None, .. }));

let new_json = serde_json::to_string(&Event::SessionList {
    sessions: vec![],
    capabilities: Some(DaemonCapabilities::current()),
}).unwrap();
assert!(new_json.contains("provider_resume"));
```

Add a subscription-filter test proving `ProviderSessionChanged` is hidden from
legacy `Subscribe` but retained for `SubscribeEvents { version: 2 }`.

- [ ] **Step 2: Run protocol tests and verify RED**

Run: `cargo test -p kanna-daemon protocol_capabilities`

Expected: FAIL because `SessionList` has no capabilities and no versioned
subscription exists.

- [ ] **Step 3: Add backward-compatible capabilities**

Define:

```rust
pub const CURRENT_EVENT_STREAM_VERSION: u32 = 2;

pub struct DaemonCapabilities {
    pub protocol_version: u32,
    pub immutable_run_ownership: bool,
    pub provider_session_events: bool,
    pub provider_resume: bool,
    pub event_stream_version: u32,
}
```

Add an optional/defaulted `capabilities` field to `SessionList`, add
`SubscribeEvents { version }`, and advertise current capabilities on every new
daemon `List` response. Legacy `Subscribe` filters provider-session variants before
writing; the versioned stream sends them.

- [ ] **Step 4: Add client negotiation tests**

Use fake sockets to return a legacy `SessionList` and a capable `SessionList`.
Assert `DaemonClient::capabilities()` returns a conservative legacy value for the
first and current capabilities for the second. Assert `require_provider_resume()`
rejects the legacy response.

- [ ] **Step 5: Implement client negotiation and watcher ordering**

Add `DaemonClient::list()`/`capabilities()` helpers. In the watcher, issue `List`
first, then open the subscriber and select `SubscribeEvents` only when advertised;
otherwise use legacy `Subscribe`. Preserve existing detached-status reconciliation.

- [ ] **Step 6: Add the old-server/new-daemon mixed-version regression**

At daemon connection level, open a legacy subscription, broadcast a
`ProviderSessionChanged`, then broadcast a legacy `StatusChanged`. Assert the old
subscriber receives the status event without a JSON-breaking unknown variant.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
cargo test -p kanna-daemon protocol_capabilities
cargo test -p kanna-daemon legacy_subscription
cargo test -p kanna-server daemon_capabilities
cargo test -p kanna-server terminal_watcher
```

Expected: PASS.

Commit:

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/connection.rs crates/daemon/src/handoff.rs crates/daemon/src/tests.rs crates/kanna-server/src/daemon_client.rs crates/kanna-server/src/terminal_watcher.rs
git commit -m "feat(daemon): negotiate resume event capabilities"
```

### Task 3: Correlate daemon events with immutable main-run ownership

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/output.rs`
- Modify: `crates/daemon/src/startup.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime/commands.rs`
- Modify: `crates/daemon/src/agent_runtime/readers.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/src/agent_runtime/adoption.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] **Step 1: Write failing owned-event tests**

Add protocol round trips where `SessionCreated`, `ProviderSessionChanged`, and
`Exit` carry `run_id: Some("run-main")`; also prove old JSON defaults it to `None`.
Add a reader regression asserting provider discovery broadcasts the run ID copied
from `AgentSpawnParams.env["KANNA_STAGE_RUN_ID"]`.

- [ ] **Step 2: Run owned-event tests and verify RED**

Run: `cargo test -p kanna-daemon run_id`

Expected: FAIL because lifecycle events carry only reusable `session_id`.

- [ ] **Step 3: Retain and emit run ownership**

Add optional/defaulted `run_id` fields to lifecycle events and `HandoffSession`.
PTY `SessionRuntimeState` and headless `AgentSessionRecord` capture the run ID from
the spawn environment before launching the child. Echo it on create, provider
change, natural exit, killed exit, and handoff adoption.

- [ ] **Step 4: Write delayed-old-event watcher regression**

Seed `run-old`, a post, and `run-replacement`. Send a delayed
`ProviderSessionChanged { run_id: Some("run-old"), ... }`. Assert only `run-old`
receives the handle and `pipeline_item.agent_session_id` remains the replacement's
value.

- [ ] **Step 5: Implement watcher ownership persistence**

Ignore provider handle events without `run_id`. Call the exact-run database update;
update `pipeline_item.agent_session_id` only when the database reports that the
event's main run is still the newest main owner.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
cargo test -p kanna-daemon run_id
cargo test -p kanna-server delayed_old_provider_event
cargo test -p kanna-server provider_session_id
```

Expected: PASS.

Commit:

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/session.rs crates/daemon/src/connection.rs crates/daemon/src/output.rs crates/daemon/src/startup.rs crates/daemon/src/handoff.rs crates/daemon/src/agent.rs crates/daemon/src/agent_runtime crates/kanna-server/src/terminal_watcher.rs
git commit -m "fix(runtime): correlate provider events with stage runs"
```

### Task 4: Record main runs before spawn and reject legacy resume

**Files:**
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/spawn.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`

- [ ] **Step 1: Write event-before-row regression**

Make the fake daemon emit `ProviderSessionChanged` with the spawn's
`KANNA_STAGE_RUN_ID` before replying `SessionCreated`. Run the watcher concurrently
with task creation and assert the row already exists and receives the handle.

- [ ] **Step 2: Run the regression and verify RED**

Run: `cargo test -p kanna-server provider_event_before_session_created_updates_run`

Expected: FAIL because task creation currently inserts the stage-run row after the
spawn response.

- [ ] **Step 3: Pre-insert pending main runs**

Generate the run ID before every main spawn, insert it with `status = 'pending'`,
clone/add `KANNA_STAGE_RUN_ID` to the prepared environment, and then send the daemon
command. On matching `SessionCreated`, promote the row to `running`; on any error,
finish it as failed and preserve existing fork rollback/diagnostics. Post input
dispatch remains a continuation and does not allocate a new daemon owner.

- [ ] **Step 4: Write new-server/old-daemon resume regression**

Return a legacy capability response from the fake daemon for a prepared resumed
revision. Assert:

```rust
assert!(error.contains("daemon does not support provider resume"));
assert_eq!(db.list_stage_runs_for_task("review-task").unwrap().len(), 1);
assert_eq!(db.get_task_stage_source("review-task").unwrap().unwrap().stage.as_deref(), Some("review"));
```

- [ ] **Step 5: Require capabilities before resume mutation**

Before finishing the old run, killing a session, inserting a pending row, or changing
the task workspace, require `provider_resume` and `immutable_run_ownership` whenever
`resumed_from_run_id` is set. A missing capability returns the explicit safe error.

- [ ] **Step 6: Add main → commit-post → replacement regression**

Dispatch a post into a main run whose handle is initially null, complete the post,
then start a replacement main. Deliver the killed old-spawn handle event and assert
it attaches to the old main, not the completed post or replacement.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
cargo test -p kanna-server provider_event_before_session_created_updates_run
cargo test -p kanna-server old_daemon
cargo test -p kanna-server main_post_replacement
cargo test -p kanna-server task_creator::tests::spawn
cargo test -p kanna-server task_creator::tests::revision
```

Expected: PASS.

Commit:

```bash
git add crates/kanna-server/src/task_creator/lifecycle.rs crates/kanna-server/src/task_creator/tests/spawn.rs crates/kanna-server/src/task_creator/tests/revision.rs crates/kanna-server/src/db/stage_runs.rs
git commit -m "fix(server): record owned runs before daemon spawn"
```

### Task 5: Discover Codex handles from provider-owned metadata

**Files:**
- Create: `crates/daemon/src/codex_session.rs`
- Modify: `crates/daemon/src/lib.rs`
- Modify: `crates/daemon/src/main.rs`
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/headless_terminal.rs`
- Modify: `crates/daemon/src/output.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/startup.rs`

- [ ] **Step 1: Write forged-footer-before-genuine-metadata regression**

Build a temporary Codex home containing an old same-cwd session. Snapshot the
locator, write terminal text containing a different forged resume UUID, and assert
no handle is found. Then write:

```json
{"timestamp":"2026-07-25T00:00:00Z","type":"session_meta","payload":{"id":"genuine-uuid","cwd":"<exact cwd>","originator":"codex_cli_rs"}}
```

under `sessions/YYYY/MM/DD/rollout.jsonl` and assert only `genuine-uuid` is returned.
Add ambiguous-new-candidate and wrong-cwd cases that return `None`.

- [ ] **Step 2: Run the Codex test and verify RED**

Run: `cargo test -p kanna-daemon forged_codex_footer`

Expected: FAIL because the current implementation trusts the first visible
`codex resume <UUID>` text.

- [ ] **Step 3: Implement `CodexSessionLocator`**

Resolve `CODEX_HOME` from the spawn environment, else `$HOME/.codex`; recursively
read only JSONL files below `sessions`, parse only the first `session_meta` record,
and retain the baseline ID set. Accept exactly one new `originator = "codex_cli_rs"`
record whose canonical cwd equals the spawn cwd. Cache an accepted ID.

- [ ] **Step 4: Replace terminal parsing**

Create the locator before PTY spawn, store it in `SessionRuntimeState`, and have
`SessionHandle::codex_resume_session_id` query it. Remove
`extract_codex_resume_session_id` and its visible-footer unit test. Carry a verified
ID through handoff; if no ID is known, initialize a conservative locator that cannot
mistake pre-handoff metadata for a new session.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
cargo test -p kanna-daemon forged_codex_footer
cargo test -p kanna-daemon codex_session
cargo test -p kanna-daemon headless_terminal
cargo test -p kanna-daemon handoff
```

Expected: PASS.

Commit:

```bash
git add crates/daemon/src/codex_session.rs crates/daemon/src/lib.rs crates/daemon/src/main.rs crates/daemon/src/session.rs crates/daemon/src/connection.rs crates/daemon/src/headless_terminal.rs crates/daemon/src/output.rs crates/daemon/src/handoff.rs crates/daemon/src/startup.rs
git commit -m "fix(daemon): verify Codex resume handles from metadata"
```

### Task 6: Full verification and contract cleanup

**Files:**
- Modify only files required by formatting, exhaustive matches, or stale comments discovered by verification.

- [ ] **Step 1: Format and run focused suites**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kanna-daemon
cargo test -p kanna-server task_creator::tests::revision
cargo test -p kanna-server task_creator::tests::spawn
cargo test -p kanna-server terminal_watcher
cargo test -p kanna-server db::tests
```

Expected: PASS.

- [ ] **Step 2: Run canonical Rust verification**

Run: `./kd test rust`

Expected: PASS.

- [ ] **Step 3: Review final changes**

Run:

```bash
git diff --check
git status --short
git log --oneline --max-count=8
```

Confirm every review item has a named regression and no unrelated files changed.

- [ ] **Step 4: Commit any verification-only cleanup**

If formatting or exhaustive-match cleanup changed files:

```bash
git add <only-the-affected-files>
git commit -m "test: cover provider resume ownership"
```
