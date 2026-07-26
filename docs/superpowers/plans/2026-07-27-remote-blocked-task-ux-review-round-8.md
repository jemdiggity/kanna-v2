# Remote Blocked Task UX Review Round 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` because the authority, lifecycle, and
> compatibility changes share protocol context. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Resolve the eighth review round's nine findings with bounded, restart-safe,
compatible remote task behavior.

**Architecture:** Bind privileged LAN requests to an owner restart epoch,
backpressure relay binary forwarding, select one coherent remote authority,
serialize lifecycle/receipt work by durable identity, and stage protocol
compatibility behind endpoint/capability epochs.

**Tech Stack:** Vue 3, TypeScript, Vitest/WebDriver, Rust/Tokio/Axum, WebSocket,
Firebase relay integration tests.

---

### Task 1: Cloud blocked-task rendered journey

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/remote-blocked-task.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.vue`

- [x] Add a failing cloud snapshot variant proving Blocked placement/panel,
  Cmd+S suppression, unblock, and surfaced cloud action failure.
- [x] Add a development-only one-shot remote action failure seam and consume it
  at the same action/toast boundary used by production failures.
- [x] Run the focused WebDriver journey for both sources.

### Task 2: Owner-restart epoch

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Test: `crates/task-transfer/tests/runtime.rs`
- Test: `crates/task-transfer/tests/protocol.rs`

- [x] Add hostile restart tests that capture each privileged sealed request,
  restart only the owner, and verify no owner adapter is reached.
- [x] Fetch a live random owner epoch through a request-correlated challenge and
  bind it into every privileged sealed payload.
- [x] Reject absent/mismatched epochs before replay reservation.
- [x] Run task-transfer protocol/runtime tests.

### Task 3: Relay task-transfer backpressure

**Files:**
- Modify: `services/relay/src/router.ts`
- Test: `services/relay/test/routerBackpressure.test.ts`

- [x] Add a failing real-WebSocket slow-consumer test and capture the relay
  queued-byte high-water.
- [x] Pause/resume task-transfer sources at high/low water and close both halves
  before `bufferedAmount + frameBytes` exceeds the hard cap.
- [x] Run relay build and integration tests.

### Task 4: Coherent authority projection

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.test.ts`
- Modify: `apps/desktop/src/workspace/types.ts`

- [x] Add failing outgoing/incoming overlap and displaced cloud/LAN owner tests.
- [x] Group stable cloud identities and map every field from one transfer-aware
  winner.
- [x] Select one workspace candidate using local ownership, owner displacement,
  freshness, and same-owner LAN preference.
- [x] Run focused desktop service/workspace tests.

### Task 5: LAN close through server mutation lease

**Files:**
- Modify: `crates/task-transfer/src/runtime/daemon.rs`
- Test: `crates/task-transfer/tests/runtime.rs`
- Test: `crates/kanna-server/src/http_api/tests/actions.rs`

- [x] Add a failing LAN-close adapter test proving the canonical server close
  endpoint is called rather than direct daemon/database mutation.
- [x] Delegate close with an empty JSON body through the existing local Kanna
  server action helper.
- [x] Add/extend durable-id lease regressions for close versus advance,
  block/complete, and session replacement.
- [x] Run focused task-transfer and Kanna-server action tests.

### Task 6: Explicit receipt apply/nack

**Files:**
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/tauri-mock.ts`
- Test: `crates/task-transfer/tests/runtime.rs`
- Test: `crates/task-transfer/tests/protocol.rs`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Test: `apps/desktop/src/App.test.ts`

- [x] Add a failing delayed-close regression showing the two-second retry can
  deliver a second concurrent completion.
- [x] Claim receipts in flight until apply; add nack to release/requeue a failed
  delivery.
- [x] Wire the sidecar/Tauri nack command and call it from the lifecycle
  listener on handler failure.
- [x] Run focused sidecar, runtime, App, and store tests.

### Task 7: Previous server/current relay publication

**Files:**
- Modify: `services/relay/src/auth.ts`
- Modify: `services/relay/src/index.ts`
- Test: `services/relay/test/auth.test.ts`
- Test: `services/relay/test/integration.test.ts`

- [x] Replace the failing “no legacy lease” contract with previous-server
  publication and revocation tests.
- [x] Revalidate legacy device-token account ownership, lease the same
  generation-fenced publisher, and advertise compatibility in `auth_ok`.
- [x] Run relay auth/publication integration tests.

### Task 8: Previous mobile/current server KSP

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [x] Add failing contracts for empty-auth `/v1/stream` and authenticated
  `/v2/stream`.
- [x] Keep v1 legacy empty-auth behavior, require pairing on v2, and route
  current mobile clients to v2.
- [x] Run focused KSP and mobile LAN tests.

### Task 9: Relay service capability negotiation

**Files:**
- Modify: `services/relay/src/index.ts`
- Modify: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`
- Test: `services/relay/test/integration.test.ts`
- Test: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`

- [x] Add a failing current-proxy/previous-relay contract proving no tunnel
  request is sent after capability-less `auth_ok`.
- [x] Advertise `task-transfer` in current relay `auth_ok` and require it before
  requesting a tunnel.
- [x] Run focused proxy and relay tests.

### Task 10: Verification and completion

- [x] Run formatting and all focused suites.
- [x] Run desktop build/typecheck and the repository practical JavaScript
  verification (`pnpm test` plus the canonical package command exposed by kd).
- [x] Run `git diff --check`, inspect the complete diff against `origin/main`,
  and verify every original blocked-task requirement.
- [x] Commit the revision and record Kanna stage success with a summary that
  states this branch supersedes #921 and lists conflict decisions/evidence.
