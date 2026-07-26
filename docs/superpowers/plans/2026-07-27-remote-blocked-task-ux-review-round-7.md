# Remote Blocked Task UX Review Round 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`
> because the transport, replay, and recovery tasks share protocol context.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate privileged LAN traffic, make task-transfer replay safe
and bounded across restarts, and preserve v0.0.30 recovery compatibility.

**Architecture:** Authorize HTTP at handler extraction and KSP at the first auth
frame. Namespace task-transfer request ids per process, reserve bounded replay
slots in memory, persist only close/advance outside Tokio workers, and represent
historical cursor metadata with `Option`.

**Tech Stack:** Rust, Axum, Tokio, serde, X25519/XChaCha20-Poly1305, Vue/React
Native TypeScript, Vitest.

---

### Task 1: Privileged direct-LAN authentication

**Files:**
- Modify: `crates/kanna-server/src/http_api/lan_trust.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_input.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [x] Add failing HTTP tests for unauthenticated non-loopback input, advance,
  and close requests.
- [x] Add failing KSP/mobile tests for empty LAN auth and paired credentials.
- [x] Implement the loopback/paired/authenticated-tunnel extractor and direct
  KSP paired-device auth mode.
- [x] Run focused Kanna-server and mobile LAN transport tests.

### Task 2: Restart-unique bounded replay

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/replay_store.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add a failing requester-restart regression covering snapshot,
  observe/input/resize, file read, mark-read, close, and advance ids.
- [x] Add failing regressions proving repeated snapshot/input traffic creates no
  replay files and hits a configured in-memory bound.
- [x] Generate a random runtime request namespace and include it in every
  generated request id.
- [x] Replace the unbounded replay map with bounded entries that distinguish
  durable close/advance records from memory-only traffic.
- [x] Reserve under the async mutex, then perform durable writes/removals in
  `spawn_blocking`; retain owner-restart replay for close/advance.
- [x] Run task-transfer protocol/runtime tests.

### Task 3: v0.0.30 recovery compatibility

**Files:**
- Create: `packages/terminal-recovery/tests/fixtures/v0.0.30-snapshot.json`
- Modify: `packages/terminal-recovery/src/protocol.rs`
- Modify: `packages/terminal-recovery/src/session_mirror.rs`
- Modify: `packages/terminal-recovery/tests/snapshot_store.rs`
- Modify: `crates/daemon/src/recovery.rs`
- Modify: daemon recovery consumers/tests as required by optional cursor fields.

- [x] Add the exact historical fixture and failing loader tests in both crates.
- [x] Deserialize cursor row/column/visibility as optional and emit explicit
  values for new snapshots.
- [x] Preserve `None` through the recovery response boundary and apply
  compatibility defaults only when converting to the concrete terminal
  protocol.
- [x] Run focused terminal-recovery and daemon tests.

### Task 4: Verification and completion

- [x] Run `cargo fmt --all -- --check` and all focused Rust tests.
- [x] Run the desktop build/typecheck and `pnpm test`.
- [x] Run `./kd test rust` if practical for the touched Rust surface (the
  canonical command completed its protocol, frontend, and sidecar checks, then
  the host volume exhausted space while archiving `kanna-desktop`; focused
  touched-crate suites and the full Kanna-server suite passed separately).
- [x] Run `git diff --check` and review the full diff against `origin/main`.
- [ ] Commit the finished revision and record Kanna stage success with the
  supersedes-#921 summary and verification evidence.
