# KSP PTY Runtime Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KSP the authoritative runtime-status channel for attached PTY sessions while preserving the server-side selected-task idle/unread policy.

**Architecture:** Deliver initial, live, and lag-resync status through the daemon's ordered attached-session fanout as `StatusChanged` events, forward PTY status through KSP without synthesis, and apply attached status through the desktop store. Track live KSP terminal attachments in a shared refcounted registry; the server watcher applies the same runtime-status policy with `selected=false` only when a session is unattached, including subscribe-time and final-detach `List` reconciliation. Remove the legacy Tauri event and desktop poll entirely.

**Tech Stack:** Rust/Serde/Tokio, TypeScript/Vue/Pinia, Vitest, Cargo test/clippy/fmt.

---

## File Structure

- Modify daemon fanout and output handling: queue `StatusChanged` behind causal output and pair it with snapshots at attach and lag resync.
- Modify `crates/kanna-server/src/ksp.rs`: forward daemon-received initial, live, and resync PTY `status_changed` frames without synthesis.
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

### Task 13: Revision 3 — selected attach-gap repair rule

- [x] Add table-driven unit tests in `crates/kanna-server/src/http_api/task_activity.rs` proving `idle` and `waiting` with `selected=true` repair `unread` to `idle`, the same statuses with `selected=false` leave `unread` unchanged, and `busy` still maps every non-working activity to `working` while leaving `working` unchanged.
- [x] Run `cargo test -p kanna-server http_api::task_activity::tests:: -- --test-threads=1` and confirm RED because selected `unread` currently returns `None`.
- [x] Change only the `idle | waiting` branch of `activity_for_runtime_status`: selected reports map both `working` and `unread` to `idle`; unselected reports retain only `working` to `unread`.
- [x] Re-run the focused task-activity tests and confirm GREEN.

### Task 14: Revision 3 — final-detach notification and reconciliation

- [x] Add `terminal_attachments` tests proving the first of two lease drops emits no notification, the final drop emits exactly one session id, and the notification is not duplicated.
- [x] Run `cargo test -p kanna-server terminal_attachments::tests:: -- --test-threads=1` and confirm RED because the registry has no final-detach notification surface.
- [x] Give `TerminalAttachments` a shared unbounded final-detach sender and a single receiver obtained during server startup; keep the synchronous refcount mutation in `TerminalAttachmentLease::drop`, sending only after the count reaches zero.
- [x] Add terminal-watcher tests with a fake daemon proving one final-detach notification causes exactly one `DaemonCommand::List`, filters the matching `SessionInfo`, and applies its status through `apply_unattached_runtime_status`; prove no command or activity change occurs while another lease remains.
- [x] Run the focused detach-reconciliation tests and confirm RED before adding the worker.
- [x] Implement `terminal_detach_reconciliation_loop` and a one-shot helper in `crates/kanna-server/src/terminal_watcher.rs`; connect with `DaemonClient`, issue `List`, filter by session id, and rely on `apply_unattached_runtime_status` to re-check that the session is still unattached before writing.
- [x] Start the reconciliation worker beside `terminal_state_watcher_loop` in `crates/kanna-server/src/main.rs`, then re-run the focused attachment and watcher tests and confirm GREEN.

### Task 15: Revision 3 — ownership ordering coverage

- [x] Add a KSP test in `crates/kanna-server/src/ksp.rs` whose fake daemon blocks before replying to `AttachSnapshot`; assert `state.terminal_attachments().is_attached(session_id)` is already true while the command is in flight, then close the stream and assert the lease is released.
- [x] Run the focused KSP test and confirm it passes against the intended lease placement or exposes any ordering defect before further changes.
- [x] Retain lease acquisition outside the spawned stream future and its lifetime across all reconnect attempts; make only the minimal lifecycle adjustment if the new ordering test exposes a defect.
- [x] Re-run the focused KSP and existing attached-watcher skip tests.

### Task 16: Revision 3 — desktop and real-app gap repair

- [x] Add an integration case in `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts` that starts selected/working, simulates an unattached watcher write to `unread`, forwards the queued initial `idle`, and expects the selected client report to end at `idle`.
- [x] Run the focused desktop test and confirm RED, then update the test server policy to match `activity_for_runtime_status` revision 3 and re-run to confirm GREEN.
- [x] Extend `apps/desktop/tests/e2e/real/pty-runtime-status.test.ts` so a false agent completes before its terminal mounts, then attach and assert queued current status converges from `unread` to `idle`.
- [x] Start the worktree app only through `./kd dev up`; run the PTY runtime-status E2E, inspect `./kd dev log` on failure, and stop the app after the E2E passes.

### Task 17: Revision 3 — verification and PR update

- [x] Run focused kanna-server tests for `task_activity`, `terminal_attachments`, `terminal_watcher`, and the new KSP ordering case with `--test-threads=1`.
- [x] Run the focused desktop runtime-status Vitest file and the real-app PTY runtime-status E2E.
- [x] Run `pnpm test`.
- [x] Run `(cd crates/daemon && cargo test -- --test-threads=1)`; isolate the one host-pressure timeout and confirm it passes alone.
- [ ] Run `git diff --check`, review the final diff, commit the revision, update `origin/task-ab611644` to the approved revision-3 base, and force-push `feat/ksp-pty-runtime-status` with `--force-with-lease` to update PR #886.

### Task 18: Revision 4 — one authoritative daemon status carrier

- [x] Add or revise daemon tests proving live `StatusChanged` follows the causal `Output` on the attached fanout, attach initial events remain exactly `[Snapshot, StatusChanged(current)]`, resync queues that same pair and restores a status missed during drain, and the existing `Subscribe` broadcast remains unchanged.
- [x] Run the focused daemon tests and confirm the resync case is RED because resync currently queues only `Snapshot`.
- [x] Remove `TerminalSnapshot.status`, its serde tests, and every snapshot constructor assignment; retain `fanout_status_changed`, and change drained-subscriber resync to enqueue `[Snapshot, StatusChanged(session.status())]` under the fanout lock.
- [x] Replace the KSP snapshot-synthesis coverage with a fake-daemon test that sends queued initial `Snapshot` then `StatusChanged`, asserts that exact frame order, and proves no additional synthesized status frame appears; retain live and resync forwarding coverage through received daemon events.
- [x] Run the focused and full daemon/server suites plus `pnpm --dir packages/stream-client test`, isolating the documented host-pressure timeout.

### Task 19: Revision 4 — real-app carrier and recovery coverage

- [x] Extend the PTY runtime-status E2E with an attached live busy→idle transition that completes without reattach, proving the fanout steady-state carrier.
- [x] Add a dropped stream recovery case that re-establishes the terminal and converges to the daemon's current status via the queued attach pair.
- [x] Run the desktop runtime-status integration test and the PTY runtime-status E2E through `./kd dev up`, then stop the worktree app.
- [x] Run `pnpm test` plus the requested serial daemon suite, isolating the documented transient PTY timeout and confirming the affected test passes alone.
- [ ] Inspect the final diff, commit, rebase onto Revision 4 commit `a2ec0585`, and force-push PR #886 with lease protection.
