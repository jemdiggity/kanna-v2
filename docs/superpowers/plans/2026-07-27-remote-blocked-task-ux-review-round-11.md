# Remote Blocked Task UX Review Round 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all eight round-11 security, concurrency, framing, dependency,
and lifecycle-delivery findings while preserving the replacement PR's UX.

**Architecture:** Authentication and publication authority are denied at their
entry points; transport and lifecycle buffers are bounded before allocation;
database rows become the cross-window transfer authority; asynchronous snapshot
mapping is generation fenced. Lifecycle events use explicit bridge
claim/renew/ack/nack delivery rather than treating event emission as completion.

**Tech Stack:** Rust, Tokio, Axum, SQLite/rusqlite, Tauri v2, Vue 3,
TypeScript/Vitest, Firebase relay, Cargo, Bazel.

---

### Task 1: Secure stream and relay publication entry points

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Modify: `services/relay/src/index.ts`
- Modify: `services/relay/src/auth.ts`
- Test: `services/relay/test/auth.test.ts`
- Test: `services/relay/test/integration.test.ts`

- [x] Add a failing endpoint test that connects to non-loopback `/v1/stream`
  with empty auth and attempts task input, stage advance, close, terminal input,
  and task-file requests; verify every connection closes unauthorized.
- [x] Make the v1 handler derive the same peer-aware auth mode as v2 and run the
  Kanna server KSP regression.
- [x] Add a failing relay test where the account device token supplies another
  registered desktop ID and attempts snapshot/transfer publication.
- [x] Restrict publication generation, capability advertisement, and publication
  handling to desktop-secret proofs while preserving legacy routing; run relay
  auth and integration tests.

### Task 2: Bound peer response framing

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add hostile servers whose ordinary responses exceed a small configured
  response limit or never terminate with newline; verify protocol failure.
- [x] Add explicit ordinary and artifact response limits, a dedicated artifact
  response permit, and bounded newline reads.
- [x] Verify ordinary, artifact, oversized, unterminated, and concurrent
  task-transfer runtime cases.

### Task 3: Add database transfer ownership

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/transfers.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/transfers.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `packages/db/src/migrations/001_initial.sql`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/composables/useAppTaskTransfer.ts`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Test: `apps/desktop/src/App.test.ts`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`

- [x] Add failing database tests for one pending-to-claimed winner, rejected
  duplicate claims, expired recovery takeover, stale-owner transitions, and two
  connections inserting active outgoing transfers for one source task.
- [x] Add migration columns/indexes and transactional DB methods, including a
  partial unique active-outgoing index.
- [x] Expose claim/renew/takeover and owner-checked transition APIs.
- [x] Route live transfer events and startup recovery through one claim/import
  helper; renew the lease during import and pass the token through transitions.
- [x] Add an event-versus-startup deferred overlap test proving finalization,
  repository materialization, and task creation run once, plus a two-renderer
  outgoing transfer test; run focused App/store/server tests.

### Task 4: Fence cloud subscription emissions

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Test: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`

- [x] Add a subscription test with two deferred relay-presence responses
  completed newest-first and verify the old response cannot overwrite it.
- [x] Add monotonic latest-wins emit sequencing and run the focused service
  suite.

### Task 5: Make lifecycle delivery acknowledged and bounded

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/pull.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Test: `crates/task-transfer/tests/runtime.rs`
- Test: `crates/task-transfer/tests/sidecar_control.rs`
- Test: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Test: `apps/desktop/src/App.test.ts`

- [x] Add failing tests for consumer close after emit but before ack, nack and
  lease-expiry redelivery, count/byte admission, sustained no-renderer
  backpressure, task-pull source overflow, and bounded/cancelled finalization
  waiters.
- [x] Replace Tauri emit-and-pop with ordered retained deliveries carrying
  delivery IDs, owner leases, renew, ack, and nack operations.
- [x] Bound sidecar stdout frames and bridge retained bytes/count; stop draining
  on admission pressure.
- [x] Bound the runtime event channel and task-pull map; cap finalization waiters,
  remove cancelled waiters, and apply request timeouts.
- [x] Wrap every mutating renderer handler with lease renewal and ack/nack, then
  run task-transfer, Tauri unit, sidecar-control, and App regressions.

### Task 6: Regenerate release dependency locks and verify

**Files:**
- Modify: `Cargo.desktop.lock`
- Modify: `MODULE.bazel.lock`
- Review: complete branch diff against `origin/main`

- [x] Run `cargo generate-lockfile --manifest-path Cargo.desktop.toml` and verify
  the `kanna-desktop` package lists direct `flate2` and `tar`.
- [x] Run `bazel mod deps --lockfile_mode=update` and verify desktop crate
  aliases/dependency maps include both crates.
- [x] Run focused frontend/workspace suites, relay suites, Kanna server and
  task-transfer Rust suites, desktop build/typecheck, `pnpm test`, and
  `./kd test rust`.
- [x] Run
  `bazel build -c opt //apps/desktop/src-tauri:kanna_desktop_bazel`.
- [x] Review the complete diff for scope and original remote blocker,
  terminal, read-dwell, file-link, and workspace-projection behavior.
- [x] Commit the revision and record successful Kanna stage completion with a
  summary suitable for the replacement PR.
