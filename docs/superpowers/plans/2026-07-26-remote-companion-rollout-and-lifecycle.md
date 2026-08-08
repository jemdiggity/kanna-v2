# Remote Companion Rollout and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve mixed-version companion delivery while removing maximum snapshot work from latency-sensitive paths and fixing out-of-order LAN observation installation.

**Architecture:** Negotiate chunk support through an optional KSP companion-attach capability, prepare and decode negotiated chunks on blocking/worker lanes, retain legacy relay forwarding under the existing absolute cap, and fence LAN observer installation by the latest peer/task generation. Extend the real E2E journey to keep two released/selected companions concurrently interactive.

**Tech Stack:** Rust/Tokio/Axum, TypeScript/Vitest/ws, Vue/WebDriver/Playwright, pnpm, Cargo.

## Global Constraints

- Use `pnpm` for JavaScript package scripts.
- Keep old peers working when optional capability fields are absent.
- Do not add build-machine runtime dependencies.
- Keep terminal/control traffic independent from companion serialization and parsing.
- Preserve the relay's 64 MiB absolute cap and 32 MiB/16 MiB high/low water marks.
- Work only in the current Kanna worktree and do not push or create a PR.

---

### Task 1: Optional KSP chunk negotiation

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `packages/agent-protocol/src/generated/ClientFrame.ts`
- Modify: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `packages/stream-client/src/index.ts`
- Test: `crates/kanna-agent-protocol/src/frames.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `packages/stream-client/src/stream-client.test.ts`

**Interfaces:**
- Produces: optional `accept_snapshot_chunks: bool` on `ClientFrame::Attach`.
- Consumes: server-side per-attachment `accept_snapshot_chunks: bool`.

- [ ] Add protocol compatibility tests parsing legacy companion attach frames without the field and round-tripping an attach with `accept_snapshot_chunks: true`.
- [ ] Run the focused Rust protocol tests and confirm the current enum variants reject the new field expectations.
- [ ] Extend the attach variant with a defaulted, omitted-when-none boolean and regenerate the TypeScript mirror.
- [ ] Add KSP tests asserting an absent client capability yields `CompanionSnapshot` and an advertised capability yields `CompanionSnapshotChunk`.
- [ ] Add stream-client tests asserting companion attach advertises the capability and legacy servers remain accepted through unchunked snapshots.
- [ ] Run the focused protocol, server, and stream-client tests.

### Task 2: Server serialization off the receive path

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`

**Interfaces:**
- Produces: an outbound companion state that can hold a pending blocking serialization task and yield prepared chunks.
- Consumes: the negotiated chunk boolean from Task 1.

- [ ] Add a test gate inside maximum snapshot serialization, publish a legal maximum snapshot, inject `TermOutput` while serialization is blocked, and assert the terminal frame is received before releasing the gate.
- [ ] Run the focused test and confirm `OutboundFrameReceiver::recv` blocks in `serde_json::to_string`.
- [ ] Start snapshot serialization/chunk preparation with `tokio::task::spawn_blocking`, poll its join handle without blocking ordinary-frame dequeue, and fall back to the untouched legacy frame for non-capable peers.
- [ ] Re-run the maximum-bundle and outbound coalescing tests.

### Task 3: Browser final assembly off the UI thread

**Files:**
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`

**Interfaces:**
- Produces: completed chunk payloads enqueued to the companion decode lane through `StreamFrameDecoder.decode`.
- Consumes: the existing socket/generation-bounded decode ingress and `handleFrame`.

- [ ] Add a test whose decoder blocks only the completed serialized snapshot; deliver the final chunk and a terminal frame; assert terminal dispatch occurs before the decoder resolves and companion dispatch occurs afterward.
- [ ] Run the focused test and confirm synchronous `chunks.join("")`/`JSON.parse` dispatches before the decoder gate is used.
- [ ] Replace final synchronous parsing with bounded companion-lane decode ingress carrying the completed serialized payload and retained-byte accounting.
- [ ] Re-run chunk validation, maximum bundle responsiveness, and decode overflow tests.

### Task 4: Relay mixed-version compatibility and real backpressure

**Files:**
- Modify: `services/relay/src/router.ts`
- Modify: `services/relay/test/router.test.ts`
- Modify: `services/relay/test/integration.test.ts`

**Interfaces:**
- Preserves: all legal legacy frames below the 64 MiB absolute cap.
- Tests: legal `companion_snapshot_chunk` frames of at most 256 KiB.

- [ ] Replace the router regression that expects a 23 MiB legacy frame rejection with one that expects forwarding below the absolute cap.
- [ ] Rewrite the integration slow-peer fixture to send enough 96 KiB chunk frames to cross the high-water mark, observe source pause, resume the real peer, and observe callback completion/resume.
- [ ] Add a separate absolute-cap assertion that a frame cannot be enqueued when `bufferedAmount + payloadBytes` exceeds 64 MiB.
- [ ] Run the focused router/integration tests and confirm the legacy rejection and old oversized-frame fixture fail.
- [ ] Remove the legacy companion frame-size rejection while retaining general flow control.
- [ ] Re-run the focused relay suite.

### Task 5: Latest-generation LAN observer fencing

**Files:**
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`

**Interfaces:**
- Produces: scheduler lanes keyed by `(target_peer_id, task_id)`.
- Produces: runtime latest-generation intent per observer key.
- Preserves: generation-bound event send and unobserve APIs.

- [ ] Add a scheduler regression where generation 1 blocks, generation 2 is queued, and companion event/control ordering remains per peer/task while terminal control bypasses it.
- [ ] Add a runtime regression with a controllable open gate where generation 2 completes before generation 1; assert generation 2 is installed and the losing stream is released.
- [ ] Add a desktop regression resolving the replacement observe before the first observe and assert only the replacement connects while stale cleanup uses generation 1.
- [ ] Run the focused Rust and desktop tests and confirm stale generation 1 can currently install/complete.
- [ ] Key control scheduling by peer/task, record latest requested generation before opening, fence installation under the observer lock, and drop/release stale streams.
- [ ] Order desktop replacement cleanup before starting its observation and retain late-completion cleanup.
- [ ] Re-run all focused LAN tests.

### Task 6: Concurrent real companion journey and stable navigation

**Files:**
- Modify: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`
- Modify if needed: `apps/desktop/tests/e2e/helpers/remoteCompanion.ts`

**Interfaces:**
- Consumes: two `RemoteCompanionFixture` instances and two `RemoteCompanionBrowser` instances.
- Produces: owner-keyed discovery/selection helpers that survive sidebar rerenders.

- [ ] Change discovery to return exactly one visible row matching owner desktop/task/transport and change selection retries to re-find/re-click that row until selected identity and diagnostics agree.
- [ ] Add a journey that opens A, selects B without closing A, publishes distinct updates to both, clicks distinct choices in both, asserts each fixture contains only its choice, then reselects A and verifies its latest revision.
- [ ] Run the canonical focused real E2E three clean times and preserve diagnostics for any failed discovery instead of relying on prompt deduplication.

### Task 7: Final verification

**Files:**
- Verify all files above.

- [ ] Run `cargo fmt --all -- --check` for the affected Rust workspace configuration.
- [ ] Run focused Rust tests for `kanna-agent-protocol`, `kanna-server`, and `task-transfer`.
- [ ] Run focused Vitest suites for stream-client, desktop LAN terminal, and relay.
- [ ] Run TypeScript checks for changed packages.
- [ ] Run `git diff --check`, inspect `git status --short`, and review the complete diff for unrelated edits.
- [ ] Record `kanna_complete_stage` success with the verified commands, or failure with the exact blocker.
