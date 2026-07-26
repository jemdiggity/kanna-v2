# Authoritative PTY Busy State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daemon `Busy` status converge to sidebar `working` without task selection, while preventing handoff and same-id reader lifecycle gaps from publishing stale activity.

**Architecture:** Keep activity policy in `kanna-server`, but make the selection-independent `Busy` transition authoritative even for attached PTYs. Resume PTY readers during daemon handoff and fence old readers before a killed session id is reused. The existing server state-change stream remains the only sidebar synchronization path.

**Tech Stack:** Rust, Tokio, Unix PTYs, SQLite-backed Kanna server state, Cargo tests.

---

## File Structure

- Modify `crates/kanna-server/src/terminal_watcher.rs`: split attached-session
  ownership by status and add focused activity regressions.
- Modify `crates/daemon/src/session.rs`: expose reader-stop lifecycle helpers
  and weakly retained per-session-id lifecycle locks.
- Modify `crates/daemon/src/connection.rs`: stop/fence the current reader in
  `Kill` before the session id becomes reusable.
- Modify `crates/daemon/src/output.rs`: reject externally visible work from a
  reader whose handle is no longer current.
- Modify `crates/daemon/src/startup.rs`: restart adopted PTY readers before
  publishing the replacement daemon socket.
- Modify `crates/daemon/tests/handoff.rs`,
  `crates/daemon/tests/reconnect.rs`, and daemon unit tests: prove no-attach
  handoff status tracking and same-id fencing.

### Task 1: Make attached Busy authoritative

- [ ] **Step 1: Replace the blanket attached-status test with status-specific regressions**

  In `crates/kanna-server/src/terminal_watcher.rs`, seed an attached task as
  `unread`, send `DaemonEvent::StatusChanged { status: Busy }`, and assert the
  stored activity is `working`. Retain a separate attached `Idle` case that
  starts `working` and remains `working`.

- [ ] **Step 2: Run the focused watcher tests and verify RED**

  Run:

  ```bash
  cargo test -p kanna-server terminal_watcher::tests::watcher_applies_attached_busy_status -- --test-threads=1
  ```

  Expected: FAIL because `apply_unattached_runtime_status` returns before
  applying any attached status.

- [ ] **Step 3: Narrow the attachment guard**

  Change `apply_unattached_runtime_status` so it returns early only when the
  session is attached and the status is `Idle` or `Waiting`. Let `Busy`
  continue through the existing task resolution,
  `activity_for_runtime_status`, database update, and task-state publication.

- [ ] **Step 4: Run all terminal watcher tests**

  Run:

  ```bash
  cargo test -p kanna-server terminal_watcher::tests:: -- --test-threads=1
  ```

  Expected: PASS.

### Task 2: Fence readers during same-id replacement

- [ ] **Step 1: Add reader lifecycle tests**

  Add tests around `StreamControl` and the kill path proving:

  ```rust
  control.request_stop();
  assert!(control.stop_requested());
  control.mark_stopped();
  assert!(control.is_stopped());
  ```

  Then add a deterministic same-id regression that keeps the first reader
  alive, kills it, respawns the id, releases old output, and asserts only the
  replacement's events/status reach subscribers.

- [ ] **Step 2: Run the same-id regression and verify RED**

  Run the exact new test filter under:

  ```bash
  cargo test -p kanna-daemon same_id -- --test-threads=1 --nocapture
  ```

  Expected: FAIL because `Kill` does not request or await reader stop and the
  reader only checks manager identity during final cleanup.

- [ ] **Step 3: Add stop acknowledgement and same-id serialization**

  In `crates/daemon/src/session.rs`, add a helper that waits asynchronously for
  the active stream control to report `is_stopped()`. Give each handle a
  monotonic retired flag that `SessionManager` sets on removal/replacement,
  and give spawn/kill a weakly retained per-session-id lifecycle lock. Do not
  hold the PTY, state, or manager mutex while waiting.

- [ ] **Step 4: Fence externally visible reader work**

  In `crates/daemon/src/output.rs`, check the handle's O(1) retired flag
  together with `StreamControl` before mirroring chunks, after awaited fanout
  and terminal operations, before quiet status refresh/emission, and before
  recovery writes. A stale reader marks itself stopped and exits without
  touching fanout, recovery, or task status.

- [ ] **Step 5: Stop the reader before completing Kill**

  In `crates/daemon/src/connection.rs`, request reader stop before killing the
  PTY, await acknowledgement, publish the single killed `Exit`, end recovery,
  and remove the handle only if it is still the current incarnation. Hold the
  same-id lifecycle lock through this sequence so a later `SessionCreated`
  cannot overtake it.

- [ ] **Step 6: Re-run focused daemon tests**

  Run:

  ```bash
  cargo test -p kanna-daemon same_id -- --test-threads=1 --nocapture
  cargo test -p kanna-daemon session::tests:: -- --test-threads=1
  ```

  Expected: PASS.

### Task 3: Resume adopted PTY readers without attachment

- [ ] **Step 1: Add the no-attach handoff regression**

  In `crates/daemon/tests/handoff.rs`, spawn a provider fixture whose handed-off
  visible state changes after replacement. Start the replacement daemon, do
  not send `AttachSnapshot`, poll `List`, and assert the adopted session
  reaches the new status.

- [ ] **Step 2: Run the handoff test and verify RED**

  Run:

  ```bash
  cargo test -p kanna-daemon --test handoff adopted_pty_tracks_status_before_first_attach -- --test-threads=1 --nocapture
  ```

  Expected: FAIL because adopted PTYs have no `stream_output` task before
  attach.

- [ ] **Step 3: Prepare adopted PTY reader inputs**

  In `crates/daemon/src/startup.rs`, create a `StreamControl`, clone the adopted
  fd, take its input receiver, and retain the handle and session metadata in a
  local pending-reader collection while inserting the handle into
  `SessionManager`.

- [ ] **Step 4: Establish the old-daemon relinquish barrier**

  Keep the handoff connection open after `HandoffAdopted` until the old daemon
  closes it after relinquishing readers. Use this connection EOF as the shared
  PTY/agent ownership barrier, with a bounded kill fallback. Do not use
  `kill(pid, 0)` because zombies remain visible until reaped.

- [ ] **Step 5: Start recovery, fanout, and stream ingestion**

  For each pending adopted PTY, initialize recovery using the seeded snapshot,
  mark its fanout streaming, and spawn `stream_output` with the same dependency
  set used by normal `Spawn`. Complete this before binding/publishing the new
  socket.

- [ ] **Step 6: Re-run handoff and reconnect tests**

  Run:

  ```bash
  cargo test -p kanna-daemon --test handoff -- --test-threads=1
  cargo test -p kanna-daemon --test reconnect -- --test-threads=1
  ```

  Expected: PASS.

### Task 4: Verification

- [ ] **Step 1: Run focused server and daemon suites**

  ```bash
  cargo test -p kanna-server terminal_watcher::tests:: -- --test-threads=1
  cargo test -p kanna-daemon -- --test-threads=1
  ```

- [ ] **Step 2: Run formatting and lint checks**

  ```bash
  cargo fmt --all -- --check
  cargo clippy -p kanna-daemon -p kanna-server --all-targets
  ```

- [ ] **Step 3: Run repository verification practical for this change**

  ```bash
  pnpm test
  ./kd test rust
  ```

  If a process-heavy suite is affected by host pressure, isolate the failing
  test and report both results rather than treating a timeout as a pass.

- [ ] **Step 4: Inspect the final diff**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Confirm only the approved server/daemon lifecycle changes, tests, design,
  and plan are present. Do not push, create a PR, advance the Kanna stage, or
  record manual-stage completion.
