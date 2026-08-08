# Remote Companion Review Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all seven reviewer-requested remote companion revisions
with focused regressions.

**Architecture:** Carry monotonic observer epochs through both coalescing
queues; expose observable opener success and a native accessible activation;
exercise paired LAN through the existing hybrid Appium harness; and admit
inbound work by retained bytes and connection capability.

**Tech Stack:** Rust/Tokio/Axum, TypeScript/Vitest, Vue 3, WebdriverIO/Appium,
pnpm, Cargo.

## Global Constraints

- Work only in the current Kanna worktree and do not push or create a PR.
- Use `pnpm` for JavaScript package scripts.
- Preserve unauthenticated LAN terminal and agent compatibility.
- Keep companion payloads and one-time capabilities out of E2E diagnostics.

---

### Task 1: Fence both latest-frame queues by observer epoch

**Files:**
- Modify: `crates/task-transfer/src/runtime/events.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/companion.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Test: `crates/task-transfer/src/runtime/tests.rs`
- Test: `crates/task-transfer/tests/protocol.rs`

**Interfaces:**
- `RuntimeEvent::CompanionEvent` and `SidecarEvent::CompanionEvent` produce
  `generation_order: u64`.
- `RuntimeEventSender::register_companion_generation(peer, task, generation,
  order)` establishes the only latest generation allowed to publish.

- [x] Add blocked-queue regressions that publish a new-epoch snapshot followed
  by an old-epoch snapshot and assert the new revision is delivered.
- [x] Run the focused task-transfer tests and confirm the old snapshot replaces
  the new snapshot.
- [x] Carry `observer_order` through stream publication and both event enums.
- [x] Register the current epoch before opening a replacement stream; remove it
  only when the matching observer is unobserved or cleaned up.
- [x] Reject lower epochs in both coalescing queues and re-run the focused tests.

### Task 2: Observe successful physical-click opener launch

**Files:**
- Modify: `apps/desktop/src/e2eRemoteCompanion.ts`
- Test: `apps/desktop/src/e2eRemoteCompanion.test.ts`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Modify: `apps/desktop/tests/e2e/helpers/remoteCompanion.ts`
- Modify: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`

**Interfaces:**
- The E2E snapshot adds a sanitized `openerOutcome` state and monotonically
  increasing opener attempt number.
- The bridge records success only after `openUrl(entryUrl)` resolves.

- [x] Add an E2E-hook unit test for a successful opener attempt.
- [x] Record opener outcomes without storing or exposing the capability URL in
  diagnostics.
- [x] Add a helper that waits for a later successful opener attempt.
- [x] Make the second physical xterm click wait for that success.

### Task 3: Add keyboard-accessible companion activation

**Files:**
- Modify: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Test: `apps/desktop/src/components/__tests__/CloudTerminalView.test.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

**Interfaces:**
- `DesktopCompanionBridgeManager.openCurrent(remoteKey)` activates the current
  authenticated snapshot without a terminal MouseEvent.

- [x] Add a component test that finds the localized native button by label and
  observes `openCurrent`.
- [x] Add bridge coverage for opening the current authenticated snapshot.
- [x] Refactor activation so pointer and current-snapshot entry share the same
  lifecycle and opener path.
- [x] Render and style the labeled button and re-run desktop unit tests.

### Task 4: Admit a legal maximum delayed-decoder chunk burst

**Files:**
- Test: `packages/stream-client/src/stream-client.test.ts`
- Modify: `packages/stream-client/src/index.ts`

**Interfaces:**
- Decode ingress remains bounded by `MAX_PENDING_DECODE_BYTES`.

- [x] Add a failing test that blocks the first decoder call, queues every
  96 KiB chunk of a legal maximum bundle, and asserts the socket stays open.
- [x] Remove the eight active/queued frame cap while retaining byte accounting.
- [x] Release the decoder, assert snapshot delivery, and re-run stream-client
  tests.

### Task 5: Bound and offload LAN outer-frame decode

**Files:**
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/companion.rs`
- Test: `crates/task-transfer/src/runtime/companion.rs`

**Interfaces:**
- Viewer runtime state owns shared inbound decode slots and retained-byte
  budget.
- A blocking helper parses `PeerCompanionEvent`, decrypts it, and validates the
  owner payload while holding both permits.

- [x] Add a regression that runs two maximum inbound decodes on a one-worker
  Tokio runtime and observes terminal/control scheduling progress.
- [x] Demonstrate shared concurrency and retained-byte admission in the
  regression.
- [x] Acquire shared admission before reading, reserve the wire frame, and move
  parse/decrypt/validation into `spawn_blocking`.
- [x] Release the gate and assert both frames complete within the byte ceiling.

### Task 6: Advertise companion only to capable connections

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

**Interfaces:**
- `auth_ok_frame(companion_access)` includes companion only when authorized.

- [x] Change the unpaired KSP test to expect agent/terminal capabilities and no
  unauthorized frame.
- [x] Add a headerless mobile LAN transport test that receives the restricted
  frame, calls `onUnavailable`, and sends no companion attach.
- [x] Build auth responses from `KspConnection.companion_access` and re-run both
  focused suites.

### Task 7: Exercise the paired-LAN native companion journey

**Files:**
- Modify: `apps/mobile/e2e/run.ts`
- Modify: `apps/mobile/e2e/specs/hybrid/hybrid-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/terminal-streaming-coverage.md`
- Test: `apps/mobile/e2e/run.test.ts`

**Interfaces:**
- Hybrid setup claims `createPairingSession().pairingPayload` through the real
  E2E pairing deep link.
- Hybrid flow receives the existing companion fixture/actions and runs the
  shared native/WebView companion journey after relay shutdown.

- [x] Add a pairing-seed contract assertion that hybrid companion setup claims
  credentials after preserving its deterministic selection.
- [x] Claim the pairing payload after deterministic selection seeding.
- [x] Export the shared Appium companion UI adapter and invoke the journey on
  the LAN-routed duplicate after relay shutdown.
- [x] Document the exact simulator, local-network, desktop-server, pairing, and
  Appium prerequisites and narrower automated coverage.

### Task 8: Verify and complete

**Files:**
- Verify: every file above

- [x] Run focused Vitest and Cargo suites for each task.
- [x] Run formatting, type checks, `git diff --check`, and the practical
  canonical suites.
- [x] Inspect the complete diff against all seven reviewer findings.
- [ ] Record Kanna stage success with the verified command summary.
