# Remote Companion Review Round 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close the four remaining sidecar lifecycle, companion poller,
stream-client admission, and desktop worker latency findings with deterministic
regressions.

**Architecture:** Give every transfer-sidecar failure path one shared atomic
death transition that owns notification. Keep a cached owner companion poller
alive until the source-map release path removes and cancels it. Account
in-progress companion assemblies and decoder work in one bounded byte ledger,
and treat local capacity rejection as a local frame error instead of a network
disconnect. Stream bounded UTF-8 buffers into the decoder worker and return
large companion fields as transferable chunks so the UI thread never
structured-clones a maximum bundle.

**Tech Stack:** Rust/Tokio/Tauri, TypeScript/Vitest/Web Workers, pnpm, Cargo.

---

### Task 1: Exactly-once transfer-sidecar death transition

**Files:**
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`

- [x] Add a fault-injection regression in which a write-side failure wins
  concurrent stdout and companion EOF transitions and assert the notification
  callback runs exactly once.
- [x] Run the focused Rust test and confirm direct `dead.store` calls bypass the
  only notifying transition.
- [x] Route write, newline, flush, response-channel, stdout EOF, and companion
  EOF failures through one compare-and-notify helper.
- [x] Add multiple terminal/companion observers, emit the one lifecycle event
  plus a duplicate, and assert every live observer retries exactly once.
- [x] Run the focused Rust and desktop LAN tests.

### Task 2: Zero-subscriber owner companion reconnect

**Files:**
- Modify: `crates/task-transfer/src/runtime/companion.rs`

- [x] Add a barrier-controlled regression that drops the last subscriber,
  forces a publish in the zero-subscriber window, reconnects to the cached
  source, and observes a later frame.
- [x] Run the regression and confirm `watch::Sender::send` currently terminates
  the poller when the zero-subscriber publish fails.
- [x] Ignore transient no-receiver send failures and let only the source-map
  release path remove and cancel the poller.
- [x] Re-run the focused regression and task-transfer runtime tests.

### Task 3: Aggregate companion assembly admission

**Files:**
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`

- [x] Add a regression that interleaves two legal maximum companion bundles,
  holds both in decoder admission, completes them, and repeats the cycle.
- [x] Assert the socket remains open, both attachments receive each replay,
  and no reconnect timer is created.
- [x] Run the regression and confirm the second completed assembly overflows
  the current queue-only 64 MiB ledger and closes the socket.
- [x] Reserve and release every retained chunk in the same aggregate ledger as
  active/queued decoder work, including detach, replacement, malformed input,
  disconnect, and decoder completion paths.
- [x] Size the bounded aggregate for two protocol-legal maximum assemblies and
  report local companion capacity failures without disconnect/reconnect.
- [x] Re-run stream-client tests and typecheck.

### Task 4: Transferable desktop decoder pipeline

**Files:**
- Modify: `apps/desktop/src/services/desktopStreamFrameDecoder.ts`
- Modify: `apps/desktop/src/services/desktopStreamFrameDecoder.worker.ts`
- Modify: `apps/desktop/src/services/desktopStreamFrameDecoder.test.ts`

- [x] Add protocol coverage proving `decodeChunks` returns before posting all
  chunks, sends only bounded transferable UTF-8 buffers, and never posts the
  complete string array.
- [x] Add a real-worker maximum-bundle timer regression that asserts main-thread
  scheduling continues while ingestion and large-field return complete.
- [x] Run both regressions and confirm the whole chunk array and parsed snapshot
  are currently structured-cloned.
- [x] Implement start/chunk/end worker messages with per-message and aggregate
  bounds.
- [x] Return companion HTML and asset payloads as bounded transferable UTF-8
  parts, reconstruct them in yielding main-thread slices, and preserve the
  `StreamFrameDecoder` public contract.
- [x] Re-run desktop decoder tests, desktop typecheck, and the real-worker
  latency regression.

### Task 5: Verification and completion

**Files:**
- Verify every file above.

- [x] Run focused TypeScript and Rust suites after each fix.
- [x] Run `cargo fmt --all -- --check`, affected typechecks, and practical
  canonical package tests.
- [x] Run `git diff --check`, inspect the complete diff against all four
  findings, and record Kanna stage success with the exact evidence.
