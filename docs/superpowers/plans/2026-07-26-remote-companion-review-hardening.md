# Remote Companion Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote companion recovery authoritative, bound limiter and IPC resources, isolate decoder cancellation, and preserve terminal ordering without companion-induced latency.

**Architecture:** Gate recovery on a fresh snapshot, allocate limiter state only for validated events, move large LAN companion bundles to a bounded length-prefixed IPC stream, and split decoding by owner and frame lane. Existing public companion and terminal APIs remain unchanged.

**Tech Stack:** Rust/Tokio/Tauri, TypeScript/Vitest, Playwright E2E, pnpm, Cargo.

---

### Task 1: Snapshot-gated relay recovery

**Files:**
- Modify: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.ts`

- [ ] Add a regression that disconnects an active bridge, reconnects the transport, and asserts no `available` state is published until a new snapshot revision is accepted and upserted.
- [ ] Run `pnpm --dir apps/desktop test -- desktopCompanionBridge.test.ts` and confirm the regression fails because cached snapshot state restores availability.
- [ ] Clear transport snapshot authority on disconnect while retaining the active bridge bundle, and require snapshot acceptance to restore availability.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Bounded validated KSP limiter

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] Add a regression that sends more than the key bound using distinct invalid sessions and asserts `companion_event_times` retains no invalid keys.
- [ ] Run the focused `kanna-server` test and confirm the retained key count grows.
- [ ] Prune expired timestamps and empty keys before lookup, avoid `entry` allocation during rate checks, allocate only after a successful append, and cap retained active keys at 64.
- [ ] Re-run the focused server tests and confirm validation, rate limiting, and key bounds pass.

### Task 3: Dedicated bounded LAN companion IPC

**Files:**
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`

- [ ] Add a maximum-bundle slow-reader regression that fills the companion lane while asserting terminal output completes within the latency bound.
- [ ] Run the focused task-transfer test and confirm the shared stdout writer blocks.
- [ ] Add a private inherited companion channel, length-prefix frames with an explicit maximum, coalesce replaceable snapshots by peer/task without dropping reliable results, serialize in `spawn_blocking`, and keep ordinary stdout writes independent.
- [ ] Add a bounded desktop companion reader that performs parsing in `spawn_blocking` and forwards the unchanged `transfer-companion-event`.
- [ ] Re-run task-transfer and desktop Rust tests.

### Task 4: Per-client decoder cancellation and lane ordering

**Files:**
- Modify: `apps/desktop/src/services/desktopStreamFrameDecoder.ts`
- Create: `apps/desktop/src/services/desktopStreamFrameDecoder.test.ts`
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`

- [ ] Add a multi-owner in-flight test proving cancellation of one decoder leaves the other worker and promise alive.
- [ ] Run the focused desktop test and confirm shared-worker reset rejects both owners.
- [ ] Make each decoder instance own its worker, queue accounting, and cancellation lifecycle.
- [ ] Add a delayed terminal snapshot test asserting snapshot then output and an independent delayed companion test asserting terminal dispatch is not blocked.
- [ ] Run the stream-client test and confirm output currently overtakes the snapshot.
- [ ] Split bounded decode ingress into terminal, companion, and control lanes; enqueue parsed terminal output on the terminal lane and cancel only the current client's work.
- [ ] Re-run both focused TypeScript suites.

### Task 5: Integration verification

**Files:**
- Verify: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`

- [ ] Run formatting/type checks for changed Rust and TypeScript packages.
- [ ] Run the focused Rust and Vitest suites.
- [ ] Run the real remote visual companion E2E through the repository's canonical E2E command when the environment supports it.
- [ ] Review `git diff --check`, inspect the final diff for unrelated changes, and record the Kanna stage result.
