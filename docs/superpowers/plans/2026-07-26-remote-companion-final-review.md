# Remote Companion Final Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the final remote-companion review fixes with regression
coverage at every ownership and resource boundary.

**Architecture:** Localize and terminate stale browser content at the document
boundary; derive direct-LAN companion capability from paired-device trust;
retain shared frames, byte admission, and attachment identity through delivery;
and validate bounded proof fields before state allocation.

**Tech Stack:** TypeScript/Vitest/Playwright, Vue i18n, Rust/Tokio/Axum/Tauri,
pnpm, Cargo.

---

### Task 1: Browser lifecycle and localization

**Files:**
- Modify: `packages/visual-companion/src/document.test.ts`
- Modify: `packages/visual-companion/src/document.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Modify: `apps/desktop/src-tauri/src/commands/companion.rs`
- Modify: `apps/desktop/src-tauri/src/companion_bridge.rs`
- Modify: `apps/desktop/tests/e2e/helpers/remoteCompanion.ts`
- Modify: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`

- [ ] Add failing document tests proving unavailable clicks do not add
  `selected`, reconnecting content is inert, terminal status removes controls,
  and Japanese strings render without English fallback.
- [ ] Run `pnpm --dir packages/visual-companion test -- document.test.ts` and
  confirm the new assertions fail for the current styling/lifecycle behavior.
- [ ] Add an explicit websocket string bundle, availability-before-styling,
  inert/re-enable behavior, and terminal lifecycle replacement/reload.
- [ ] Add app-owned en/ja/ko companion strings and pass them into the rendered
  document and Rust lifecycle-page bundle.
- [ ] Add Rust tests for localized terminal pages and stale document/asset
  removal, then run the focused package, desktop, and Rust suites.
- [ ] Add Playwright helpers/assertions for inert reconnecting content and
  absent terminal controls/markers.

### Task 2: Direct-LAN companion authorization

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [ ] Add failing KSP tests proving an empty-auth direct connection cannot
  attach a companion or send a companion event even with
  `include_assets: true`, while a trusted upgrade and relay capability can.
- [ ] Run the focused `kanna-server` tests and confirm the direct connection
  currently receives a snapshot.
- [ ] Pass paired-device trust from the WebSocket upgrade into explicit KSP
  connection capabilities and gate both companion attach and events.
- [ ] Send paired-device headers in the React Native LAN WebSocket handshake
  and cover the factory arguments.
- [ ] Re-run the focused Rust and mobile transport suites.

### Task 3: Companion ingress validation

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/companion.rs`

- [ ] Add failing tests for one-byte-over-64-KiB observe/event requests,
  oversized sealed payloads, noncanonical proof nonces, and oversized proof
  identifiers; assert replay and observer maps remain unchanged.
- [ ] Run the focused task-transfer tests and confirm the outer request still
  accepts the 8 MiB general limit and invalid fields reach allocation paths.
- [ ] Add prefix-specific request ceilings and validate identifiers plus every
  fixed-size nonce before replay consumption or observer registration.
- [ ] Re-run the focused task-transfer tests.

### Task 4: KSP fan-out accounting and generation fencing

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] Add failing concurrent maximum-bundle tests proving source frames are
  shared, pending bytes remain charged during blocked serialization/delivery,
  and a detached/reattached generation cannot emit its late completion.
- [ ] Run the focused KSP tests and confirm deep clones, early charge release,
  and stale prepared output.
- [ ] Store `Arc<ServerFrame>` in pending entries, carry the pending charge and
  attachment identity through blocking chunk preparation and delivery, and
  recheck generation before each active emission.
- [ ] Re-run focused and complete `kanna-server` tests.

### Task 5: LAN observer bounded delivery

**Files:**
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/src/runtime/companion.rs`

- [ ] Add a failing maximum-bundle non-reading-observer test that waits for
  bounded cancellation/timeout and verifies delivery admission is released.
- [ ] Run the focused test and confirm the current untimed `write_all` remains
  blocked.
- [ ] Reserve bounded delivery bytes, serialize the outer line in
  `spawn_blocking`, retain admission through chunked writes, and select every
  write against timeout and observer cancellation.
- [ ] Re-run the task-transfer runtime tests.

### Task 6: Decode and sidecar incarnation fencing

**Files:**
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Modify: `packages/stream-client/src/index.ts`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`

- [ ] Add blocked-decode replacement tests and old-incarnation terminal-event
  tests; run them and confirm late work reaches replacement observers.
- [ ] Add attachment-generation fences to companion decode ingress.
- [ ] Gate and tag every sidecar event, return incarnation from terminal
  observation, and require matching live incarnation in the terminal client.
- [ ] Re-run the stream-client, desktop service, and desktop Rust tests.

### Task 7: Legacy truncated event recovery

**Files:**
- Modify: `crates/visual-companion/src/tests.rs`
- Modify: `crates/visual-companion/src/event.rs`

- [ ] Replace the refusal test with an exact old-shape JSONL fixture lacking
  `session_id` and `revision`, followed by a crash-truncated record.
- [ ] Run the focused test and confirm append is refused.
- [ ] Truncate and sync only the incomplete markerless tail under the event
  lock before creating a marker transaction.
- [ ] Re-run append twice and assert byte-preserved history plus idempotence.

### Task 8: Recovery and final verification

**Files:**
- Verify: all files above

- [ ] Run `cargo fmt --all -- --check`, affected Vitest suites, affected Cargo
  suites, `pnpm test`, and `./kd test rust` as practical.
- [ ] Run
  `pnpm --dir apps/desktop test:e2e -- real/remote-visual-companion.test.ts`
  repeatedly and record clean relay-restart recovery within the configured
  bound.
- [ ] Run `git diff --check`, inspect the complete diff against every review
  bullet, and record the Kanna stage result.
