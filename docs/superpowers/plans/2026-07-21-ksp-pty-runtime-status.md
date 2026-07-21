# KSP PTY Runtime Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KSP the authoritative runtime-status channel for attached PTY sessions while preserving the server-side selected-task idle/unread policy.

**Architecture:** Add live status to daemon terminal snapshots and attached-session fanout, forward initial and edge-triggered PTY status through KSP, and apply attached status through the desktop store. Track live KSP terminal attachments in a shared refcounted registry; the server watcher applies the same runtime-status policy with `selected=false` only when a session is unattached, including subscribe-time `List` reconciliation. Remove the legacy Tauri event and desktop poll entirely.

**Tech Stack:** Rust/Serde/Tokio, TypeScript/Vue/Pinia, Vitest, Cargo test/clippy/fmt.

---

## File Structure

- Modify `crates/daemon/src/protocol.rs`, `session.rs`, and terminal snapshot constructors: carry a backward-compatible `SessionStatus` in snapshots and test old/new JSON.
- Modify `crates/kanna-server/src/ksp.rs`: emit initial and live PTY `status_changed` frames and add fake-daemon regression coverage.
- Modify `packages/stream-client/src/index.ts` and `stream-client.test.ts`: route status to terminal and agent attachments safely.
- Create `crates/kanna-server/src/terminal_attachments.rs` and modify `AppState`, KSP, and `terminal_watcher`: refcount attached sessions and apply status server-side only when unattached.
- Modify `apps/desktop/src/composables/terminalRuntimeStatusSink.ts` and `terminalLayout.ts`: provide a KSP-fed per-session status bus for the store and reconnect settling.
- Modify desktop stores and Tauri daemon bridges: remove the legacy status listener, poll, service registration, and Tauri emits.
- Create `apps/desktop/tests/e2e/fixtures/false-codex-runtime-status.sh`: render deterministic busy, waiting, and idle Codex footer states while keeping the PTY alive.
- Create `apps/desktop/tests/e2e/real/pty-runtime-status.test.ts`: prove selected and unselected task activity through the real daemon/KSP/store path.
- Delete `docs/2026-07-21-ksp-pty-runtime-status-e2e-gap.md`, which the amended spec supersedes.

### Task 1: Stream-client status routing

- [x] Add four tests in `packages/stream-client/src/stream-client.test.ts` proving terminal delivery, retained agent delivery, optional-handler safety, and unattached-task no-op.
- [x] Run `pnpm --dir packages/stream-client test -- stream-client.test.ts` and confirm the terminal-delivery test fails because `onStatus` is not in `TerminalStreamHandlers` and terminal dispatch is absent.
- [x] Add `onStatus?(status: string): void` and dispatch `status_changed` to both attachment kinds in `packages/stream-client/src/index.ts`.
- [x] Re-run the focused package test and confirm all cases pass.

### Task 2: Daemon snapshot status

- [x] Add protocol tests in `crates/daemon/src/protocol.rs` asserting a busy snapshot round-trips and an old payload defaults to `SessionStatus::Idle`.
- [x] Run `cargo test -p kanna-daemon protocol::tests::terminal_snapshot_status -- --nocapture` and confirm RED because the field is absent.
- [x] Add `#[serde(default)] pub status: SessionStatus` to `TerminalSnapshot`, populate it from the live `PtySession` state, and give non-live/recovery constructors the conservative idle default.
- [x] Re-run the focused daemon tests and confirm GREEN.

### Task 3: KSP terminal forwarding

- [x] Extend the fake-daemon KSP tests in `crates/kanna-server/src/ksp.rs` to assert snapshot status is emitted immediately after `term_snapshot`, matching mid-stream status is forwarded, and another session's status is ignored.
- [x] Run `cargo test -p kanna-server ksp::tests::terminal_stream_forwards_runtime_status -- --nocapture` and confirm RED because the frames are absent.
- [x] In `stream_terminal_once`, retain snapshot status before constructing `TermSnapshot`, send the initial `StatusChanged` frame next, and mirror the agent-stream `DaemonEvent::StatusChanged` arm with session filtering.
- [x] Re-run the focused KSP tests and confirm GREEN.

### Task 4: Desktop store-owned application

- [x] Add KSP-path tests in `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts` for busy/working, selected idle, unselected unread, setup-pending and closed guards.
- [x] Run `pnpm --dir apps/desktop test -- src/stores/kanna.runtimeStatusSync.test.ts` and confirm RED because no terminal runtime-status sink exists.
- [x] Add the policy-free sink module, call it from `terminalSessionLifecycle`'s `onStatus`, and register the store callback in `init.ts` to resolve the daemon session and call the existing `applyTaskRuntimeStatus` service.
- [x] Re-run the focused desktop test and the affected `useTerminal.test.ts` test file.

### Task 5: Refcounted KSP attachment ownership and unattached reconciliation

- [x] Add refcount lifecycle tests, then implement a process-shared session registry owned by `AppState`; terminal stream task lifetime holds the lease and detach/shutdown await cancellation.
- [x] Add watcher tests for unattached busy→working, idle-from-working→unread, attached skip, and subscribe-time `List` reconciliation.
- [x] Reuse `activity_for_runtime_status` with `selected=false`, publish task state changes after writes, and retain waiting-prompt persistence.

### Task 6: Remove desktop legacy status delivery

- [x] Remove both Tauri `status_changed` emits, the store listener, `syncTaskStatusesFromDaemon`, its call sites, and its service registration.
- [x] Add a store test proving initialization neither registers the removed event nor polls `list_sessions`.
- [x] Generalize the runtime-status sink into a per-session multi-subscriber bus and migrate terminal reconnect settling from the Tauri event to that bus.

### Task 7: Real-daemon live status fanout (discovered by E2E)

- [x] Add `live_status_changes_reach_attached_terminal_subscribers` in `crates/daemon/src/tests.rs` and confirm RED because the output module exposes no attached-fanout status delivery.
- [x] Enqueue the existing `StatusChanged` event to the session fanout after updating live session state, while retaining the global watcher broadcast and preserving lag/resync handling.
- [x] Run the focused daemon regression and confirm GREEN, then rerun the false-agent E2E to prove the real attach socket now carries waiting/idle transitions.

### Task 8: False-agent desktop E2E

- [x] Create an executable Codex fixture that begins at an idle `› ` prompt, then renders busy, waiting, and final idle phases with sleeps beyond the detector throttle.
- [x] Assert a selected, mounted task transitions working→idle through KSP and a second never-mounted task transitions working→unread through `terminal_watcher`.
- [x] Run the filtered E2E through the canonical worktree app launch and delete the superseded gap document.

### Task 9: Verification and commit

- [x] Run focused Vitest, TypeScript, Rust test, fmt, and clippy checks.
- [x] Inspect the final diff and commit without pushing or advancing the Kanna stage.

### Task 10: Revision — preserve status across terminal lag resync

- [x] Extend `terminal_stream_forwards_runtime_status` in `crates/kanna-server/src/ksp.rs` so the fake daemon sends the real attach sequence (`Snapshot(Busy)`, then the attach-time `StatusChanged(Busy)`) and assert KSP emits exactly `TermSnapshot`, one `StatusChanged(Busy)`, a later changed status, then exit.
- [x] Add a real-daemon reconnect integration test proving `AttachSnapshot` delivers `Snapshot` followed by one matching initial `StatusChanged` event.
- [x] Extend `terminal_stream_preserves_snapshot_and_split_multibyte_output_bytes` so a mid-stream resync snapshot carries `Busy` after the last delivered `Idle`, and assert its `StatusChanged(Busy)` follows the resync `TermSnapshot`.
- [x] Run `cargo test -p kanna-server ksp::tests::terminal_stream_forwards_runtime_status ksp::tests::terminal_stream_preserves_snapshot_and_split_multibyte_output_bytes -- --nocapture` (or the two filters separately) and confirm RED: the attach status is duplicated and the resync status is absent.
- [x] In `stream_terminal_once`, track the last status delivered for the attachment. Send the snapshot's status after every forwarded snapshot only when it differs from the last delivered status; initialize the tracker from the attach snapshot so the daemon's queued attach-time `StatusChanged` is suppressed without suppressing later transitions.
- [x] Re-run the two focused KSP tests and confirm GREEN.

### Task 11: Revision — make watcher list reconciliation response-safe

- [x] Add a deterministic integration test in `crates/kanna-server/src/terminal_watcher.rs`: acknowledge `Subscribe`, accept `List` on a second daemon connection, send `StatusChanged(Idle)` with a waiting prompt on the subscriber before replying `SessionList(Busy)` on the control connection, then assert the list reconciliation occurred and the buffered event persisted the prompt and produced the final unread activity.
- [x] Run the focused watcher test and confirm RED because the current subscribed connection consumes `StatusChanged` as the `List` response.
- [x] Connect a dedicated control `DaemonClient` after subscribe and issue `List` on that unsubscribed connection, retaining the original connection exclusively for subscriber events.
- [x] Update fake-daemon watcher helpers to model distinct subscriber and control sockets, then run all `terminal_watcher` tests and confirm GREEN.

### Task 12: Revision verification and commit

- [x] Run `pnpm test`.
- [x] Run `(cd crates/daemon && cargo test -- --test-threads=1)`.
- [x] Run `cargo test -p kanna-server`.
- [x] Run `cargo fmt --all -- --check`.
- [x] Run `cargo clippy -p kanna-daemon -p kanna-server --all-targets`.
- [ ] Review `git diff`, commit the revision locally, and record successful stage completion through Kanna.
