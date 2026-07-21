# KSP PTY Runtime Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KSP the authoritative runtime-status channel for attached PTY sessions while preserving the server-side selected-task idle/unread policy.

**Architecture:** Add live status to daemon terminal snapshots, forward both initial and edge-triggered PTY status through the existing KSP `status_changed` frame, route that frame through the shared stream client, and hand it from terminal lifecycle code to the existing store runtime-status service through a policy-free sink. Keep the Tauri listener and daemon polling as labeled fallbacks for sessions without an attachment.

**Tech Stack:** Rust/Serde/Tokio, TypeScript/Vue/Pinia, Vitest, Cargo test/clippy/fmt.

---

## File Structure

- Modify `crates/daemon/src/protocol.rs`, `session.rs`, and terminal snapshot constructors: carry a backward-compatible `SessionStatus` in snapshots and test old/new JSON.
- Modify `crates/kanna-server/src/ksp.rs`: emit initial and live PTY `status_changed` frames and add fake-daemon regression coverage.
- Modify `packages/stream-client/src/index.ts` and `stream-client.test.ts`: route status to terminal and agent attachments safely.
- Create `apps/desktop/src/composables/terminalRuntimeStatusSink.ts`: policy-free terminal-to-store callback registration.
- Modify `apps/desktop/src/composables/terminalSessionLifecycle.ts`, `apps/desktop/src/stores/init.ts`, `apps/desktop/src/stores/sessions.ts`, and `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`: register and exercise the KSP status path while retaining labeled fallbacks.
- Create `docs/2026-07-21-ksp-pty-runtime-status-e2e-gap.md` if the live-provider E2E harness cannot deterministically trigger PTY status.

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

- [x] Add KSP-path tests in `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts` for busy/working, selected idle, unselected unread, setup-pending and closed guards, and duplicate KSP plus legacy delivery.
- [x] Run `pnpm --dir apps/desktop test -- src/stores/kanna.runtimeStatusSync.test.ts` and confirm RED because no terminal runtime-status sink exists.
- [x] Add the policy-free sink module, call it from `terminalSessionLifecycle`'s `onStatus`, and register the store callback in `init.ts` to resolve the daemon session and call the existing `applyTaskRuntimeStatus` service.
- [x] Label the legacy listener and `syncTaskStatusesFromDaemon` poll with the spec's temporary-unattached-session fallback and removal criteria.
- [x] Re-run the focused desktop test and the affected `useTerminal.test.ts` test file.

### Task 5: E2E disposition and verification

- [x] Inspect the desktop E2E harness for a deterministic non-live-provider PTY status transition. If unavailable, document that external provider behavior is nondeterministic, identify a daemon-status injection hook as the missing fixture, and list the narrower Rust/TS integration tests.
- [x] Run `cargo fmt --all -- --check`, focused Rust tests, `cargo clippy -p kanna-daemon -p kanna-server --all-targets`, focused TypeScript tests, and touched-package TypeScript no-emit checks.
- [x] Inspect `git diff --check`, `git status`, and the final diff against this plan and the approved design.
- [x] Commit the implementation and tests with a focused message.
