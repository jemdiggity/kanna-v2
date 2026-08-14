# Atomic Attributed Task Input Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reviewed atomic-input regressions without changing the sound per-`(session_id, pid)` serialization and PID-fencing core.

**Architecture:** The coordinator remains the only PTY-input serialization point. It gains a stateful terminal-byte parser, bounded cancellable deferred-message waits, uncertainty eviction, and explicit session retirement; KSP gains bounded per-task admission workers so the multiplexed frame loop never awaits daemon input. The terminal watcher owns exit cleanup and completion notification is detached only after durable run finalization.

**Tech Stack:** Rust, Tokio actors/channels, KSP WebSocket integration tests, SQLite task-event tests, JSON tool catalog.

---

### Task 1: Coordinator draft parsing and bounded delivery

**Files:**
- Modify: `crates/kanna-server/src/task_input_queue.rs`
- Test: `crates/kanna-server/src/task_input_queue.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add failing parser and coordinator regressions**

Add tests proving that `\x1b[200~line1\nline2\x1b[201~` remains one daemon write, does not record its internal newline as `terminal-enter`, and keeps an already-admitted logical message behind the paste until a later external Enter. Add cases proving cursor/clipboard protocol bytes do not open a draft, while printable bytes do.

- [ ] **Step 2: Verify the regressions fail**

Run: `cargo test -p kanna-server --bin kanna-server task_input_queue -- --nocapture`

Expected: failures show the current newline splitter closes the paste and current control sequences create drafts.

- [ ] **Step 3: Implement a stateful terminal-byte parser inside the session worker**

Replace `split_operator_submissions(Vec<u8>)` with worker-owned parsing state that recognizes normal, Escape, CSI, OSC, and bracketed-paste states across frames. Split only on `\r`, `\n`, or Ctrl-C in normal state. Refactor operator delivery so one original request receives one response after its parsed pieces are processed and deferred messages are flushed only at genuine boundaries.

- [ ] **Step 4: Add a failing bounded-wait cancellation regression**

Use Tokio's paused clock to open a printable draft, enqueue a complete message through `submit_message_if_session`, advance through the delivery deadline, and assert the call returns a typed unavailable error. Close the draft afterward and assert the timed-out message is not delivered.

- [ ] **Step 5: Implement bounded cancellable deferred messages**

Wrap coordinator response waits in the daemon-command delivery deadline. Before delivering a deferred message, discard it when `response.is_closed()`. Bound `deferred_messages` to `INPUT_QUEUE_CAPACITY`; reject excess messages without writing bytes.

- [ ] **Step 6: Verify coordinator tests pass**

Run: `cargo test -p kanna-server --bin kanna-server task_input_queue -- --nocapture`

Expected: all coordinator tests pass, including paste integrity and cancellation.

### Task 2: Daemon recovery and lifecycle cleanup

**Files:**
- Modify: `crates/kanna-server/src/task_input_queue.rs`
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Modify: `crates/kanna-server/src/http_api/task_input.rs`
- Test: `crates/kanna-server/src/task_input_queue.rs`
- Test: `crates/kanna-server/src/terminal_watcher.rs`

- [ ] **Step 1: Add failing recovery and cleanup regressions**

Add a fake-daemon test where the first connection consumes an `InputIfSession` command and drops its acknowledgement, then a replacement socket accepts a distinct later input for the same PID. Add a coordinator test that calls session retirement and observes the worker/current-PID entries disappear. Add a watcher-shape test in which a parent has an open draft and inline child exit handling returns within a short timeout.

- [ ] **Step 2: Verify the regressions fail**

Run: `cargo test -p kanna-server --bin kanna-server reconnect -- --nocapture`

Run: `cargo test -p kanna-server --bin kanna-server terminal_watcher -- --nocapture`

Expected: later input remains poisoned, coordinator entries remain retained, or completion handling times out.

- [ ] **Step 3: Evict uncertain workers and reset daemon connections**

Set the cached `Option<DaemonClient>` to `None` on every transport error. Remove the incarnation worker on both `SessionNotFound` and `Uncertain`, while never replaying the uncertain request or retargeting queued requests.

- [ ] **Step 4: Add explicit session retirement and detach completion delivery**

Add `TaskInputCoordinator::retire_session(&str)` to remove every worker and cached PID for the exited session. Call it at the top of the terminal watcher's `Exit` arm, including killed/replaced exits. Keep run finalization awaited, then spawn best-effort completion notification delivery so the shared daemon event loop is never parked on another task's draft.

- [ ] **Step 5: Verify recovery and watcher tests pass**

Run: `cargo test -p kanna-server --bin kanna-server reconnect -- --nocapture`

Run: `cargo test -p kanna-server --bin kanna-server terminal_watcher -- --nocapture`

Expected: all selected tests pass and later same-PID input reaches the replacement daemon exactly once.

### Task 3: Non-blocking KSP scheduling and catalog contract

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `crates/kanna-tool-catalog/src/catalog.json`
- Modify: `crates/kanna-tool-catalog/tests/catalog.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-tool-catalog/tests/catalog.rs`

- [ ] **Step 1: Add failing KSP head-of-line regression**

Send a `TermInput` whose fake daemon `List` or `InputIfSession` acknowledgement is withheld, immediately send an authenticated KSP `Request` and `TermResize`, and assert both later frames are processed inside 300 ms. Preserve per-task operator ordering in a separate assertion.

- [ ] **Step 2: Verify the KSP regression fails**

Run: `cargo test -p kanna-server --bin kanna-server terminal_input_does_not_block -- --nocapture`

Expected: the response or resize command times out behind inline `send_operator_bytes().await`.

- [ ] **Step 3: Implement bounded per-task terminal-input workers**

Add a `terminal_inputs` handle map to `StreamConn`. `TermInput` validates base64 and uses `try_send` into that task's bounded worker; the worker resolves the session route and awaits coordinator delivery in FIFO order, reporting asynchronous errors through `frame_tx`. Attach/detach/route replacement and connection shutdown retire the corresponding worker without changing the existing resize worker.

- [ ] **Step 4: Add and satisfy the event-catalog regression**

Add `task.input` to `wait_events_documents_every_event_type_the_server_emits` and document `payload.source`, `delivery`, `boundary`, `queueSequence`, `sessionPid`, optional bounded `text`, and `truncated` in `kanna_wait_events`.

- [ ] **Step 5: Verify KSP and catalog tests pass**

Run: `cargo test -p kanna-server --bin kanna-server terminal_input -- --nocapture`

Run: `cargo test -p kanna-tool-catalog wait_events_documents_every_event_type_the_server_emits -- --nocapture`

Expected: all selected tests pass.

### Task 4: Full verification and exact-head handoff

**Files:**
- Modify only files required by failures caused by Tasks 1-3.

- [ ] **Step 1: Format and run configured checks**

Run: `cargo fmt --all -- --check`

Run: `cargo clippy --workspace --all-targets --all-features -- -D warnings`

Run: `cargo test -p kanna-server`

Run: `cargo test -p kanna-daemon`

Run: `pnpm --filter @kanna/stream-client test`

Run: the mobile test command from `docs/dev/testing.md` that covers transport attribution.

Run: `pnpm exec tsc --noEmit`

Run: the repository test command declared in `.kanna/config.json`.

- [ ] **Step 2: Review the exact diff**

Run: `git diff --check`

Run: `git diff --stat 77ed4e61..HEAD`

Run: `git status --short`

Confirm every blocking reviewer finding maps to a regression and no non-blocking follow-up expanded scope.

- [ ] **Step 3: Commit and report the exact head**

Create one local revision commit, record `git rev-parse HEAD`, and include the exact diff base/head and verification results in the Kanna stage summary. Do not push or create/modify a PR.
