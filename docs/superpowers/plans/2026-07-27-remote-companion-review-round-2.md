# Remote Companion Review Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining persisted-origin, runtime-admission, attachment-handoff, observe-rollback, concurrent-selection, and keyboard-interaction review findings.

**Architecture:** Preserve legacy companion discovery by parsing a validated loopback URL and emitting only its origin. Keep network reads outside scarce decode admission, register and roll back LAN observation generations transactionally, and add a client-chosen companion attachment epoch that the server reflects on attachment-owned frames so same-socket replacement can reject stale wire deliveries. Keep the desktop bridge’s selected companion lifecycle authoritative and exercise its native button through WebDriver keyboard actions.

**Tech Stack:** Rust/Tokio/Serde, TypeScript/Vitest/Vue 3, WebDriver/Playwright E2E, pnpm, Cargo.

---

### Task 1: Persisted origin compatibility and LAN runtime admission

**Files:**
- Modify: `crates/visual-companion/src/tests.rs`
- Modify: `crates/visual-companion/src/discovery.rs`
- Modify: `crates/task-transfer/src/runtime/companion.rs`

- [ ] Add an upgrade fixture whose `server-info` contains `{"url":"http://localhost:52341/?key=released-secret"}` and assert the bundle exposes exactly `http://localhost:52341`.
- [ ] Run the focused visual-companion origin test and confirm it fails because query-bearing persisted URLs are rejected.
- [ ] Parse the URL into scheme, authority, and suffix; validate only HTTP plus the exact loopback host/port forms; allow only `/` with an optional query/fragment that is discarded; continue rejecting credentials, non-loopback hosts, non-root paths, missing/invalid ports, and alternate numeric hosts.
- [ ] Re-run the focused visual-companion tests and confirm the persisted upgrade fixture passes without exposing the key.
- [ ] Add a three-stream Tokio regression using one shared two-slot decode semaphore: leave two authenticated companion streams idle, send a valid bounded frame on the third, and assert the third emits its update before timeout.
- [ ] Run the focused task-transfer regression and confirm it times out because the idle streams hold both decode slots.
- [ ] Move decode-slot acquisition after `read_bounded_line` returns a complete bounded frame; reserve retained wire bytes before waiting for the decode slot and hold both permits through blocking parse/decrypt/validation.
- [ ] Re-run the focused task-transfer companion tests and confirm the third stream progresses while retained/decode admission remains bounded.

### Task 2: Same-socket companion attachment epoch

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Regenerate: `packages/agent-protocol/src/generated/ClientFrame.ts`
- Regenerate: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] Add a stream-client regression that attaches epoch 1, locally detaches and reattaches epoch 2, then receives a completed epoch-1 snapshot before the server can process replacement and asserts neither the old nor replacement handlers accept it.
- [ ] Run the focused stream-client test and confirm the replacement currently accepts the stale snapshot.
- [ ] Add optional `attachment_epoch` to companion attach/detach client frames and attachment-owned companion server frames so old clients and servers remain deserializable.
- [ ] Send the current local generation as the attachment epoch on initial attach, reconnect attach, and detach; accept an epoch-bearing companion frame or chunk only when it exactly matches the current attachment; retain the existing local decode-generation fence for legacy frames.
- [ ] Store the optional epoch with the KSP attachment, reflect it on snapshots, chunks, unavailable frames, and attachment-scoped errors, and make an epoch-bearing detach remove only the matching attachment.
- [ ] Add a KSP regression proving an old attachment’s already-completed send is stamped with the old epoch and a replacement delivery with the new epoch.
- [ ] Regenerate protocol mirrors, then run protocol, stream-client, and focused KSP tests.

### Task 3: Transactional observe generation rollback

**Files:**
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/tests.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs` only if test visibility needs a bounded counter

- [ ] Add a runtime regression that registers an observe attempt against a peer whose stream open fails, calls unobserve for the same generation, and asserts both the observer-generation registry and runtime-event current-generation registry are empty.
- [ ] Run the focused runtime test and confirm the pre-install generation remains registered.
- [ ] Add an exact `(peer, task, generation, order)` rollback helper and invoke it for every error between pre-registration and successful observer installation, removing state only when the same generation/order is still current.
- [ ] Make unobserve idempotently clear a matching latest-generation entry even when no observer handle was installed, without deleting a newer attempt.
- [ ] Re-run the focused runtime tests, including out-of-order observe replacement coverage.

### Task 4: Concurrent selection lifecycle and real keyboard activation

**Files:**
- Modify: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Modify: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Modify: `apps/desktop/tests/e2e/helpers/remoteCompanion.ts`
- Modify: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`

- [ ] Add a bridge-manager regression that releases companion A while retaining its browser lease, adopts companion B, accepts B’s connection and snapshot, and asserts B publishes `available` without mutating A.
- [ ] Run the focused bridge test and confirm B’s selected lifecycle is published incorrectly.
- [ ] Publish the bridge’s computed authoritative status for a snapshot that does not require bundle refresh; do not substitute `unavailable`.
- [ ] Add a WebDriver helper that locates the visible native button by its `aria-label`, focuses it, verifies `document.activeElement`, and sends a real Enter or Space key action.
- [ ] Use the helper in the real desktop journey: arm capability capture, activate with Enter to obtain and open the browser result, then activate with Space and assert the real opener outcome advances to success.
- [ ] Re-run the focused bridge/Vue suites and the real remote visual companion spec.

### Task 5: Integration verification

**Files:**
- Verify all files above.

- [ ] Run `cargo fmt --all -- --check`, protocol mirror freshness, the affected Rust package tests, and the affected TypeScript/Vitest suites.
- [ ] Run the canonical real remote visual companion E2E when the local dev stack supports it; if an external prerequisite prevents it, record the exact command and failure.
- [ ] Run `git diff --check`, inspect the final diff for scope and compatibility, request final code review, and record the Kanna stage result.
