# Terminal Output Stall Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make intermittent terminal freezes diagnosable at the daemon, KSP, WebView event-loop, and xterm boundaries, and fix daemon slow-consumer backpressure only if a deterministic regression probe reproduces it.

**Architecture:** Add one bounded Rust operation monitor shared by the daemon and KSP server, plus one bounded TypeScript terminal monitor in the desktop WebView. Each process measures durations with its own monotonic clock and emits rate-limited `terminal_perf` records containing identifiers and counts, never terminal payloads. A deliberately non-reading daemon client gates the only behavioral change: concurrent, timeout-bounded live fanout that closes and removes a stalled consumer while preserving per-client byte order.

**Tech Stack:** Rust, Tokio, Unix sockets, Vue 3/TypeScript, xterm.js, Vitest, WebdriverIO, pnpm.

---

## Task 1: Add the shared bounded Rust stall classifier

**Files:**
- Create: `crates/daemon/src/terminal_perf.rs`
- Modify: `crates/daemon/src/lib.rs`

- [x] **Step 1: Write threshold, rate-limit, recovery, and bounded-state tests**

  Add unit tests in `terminal_perf.rs` around a test-owned `TerminalPerfMonitor` and explicit `Instant` values. Cover:

  ```rust
  #[test]
  fn operation_reports_once_at_threshold_then_recovers() { /* 499ms none; 500ms stall; finish recovered */ }

  #[test]
  fn continuing_stall_is_rate_limited() { /* no duplicate before 10s; repeat after 10s */ }

  #[test]
  fn finishing_unpolled_slow_operation_still_reports_stall_and_recovery() { /* 750ms */ }

  #[test]
  fn dropping_guard_removes_operation() { /* active_count returns to zero */ }
  ```

  Use a `TerminalPerfContext` with `component`, `session_id`, optional `task_id`, `stage`, `chunk`, `bytes`, and optional queue occupancy. Assert formatted records start with `terminal_perf`, contain `event=stall`/`event=recovered`, and never contain a sample payload string.

- [x] **Step 2: Run the focused tests to prove the new module is absent**

  Run: `cargo test -p kanna-daemon terminal_perf -- --nocapture`

  Expected: FAIL because `terminal_perf` is not exported yet.

- [x] **Step 3: Implement the monitor and stable formatter**

  Implement:

  ```rust
  pub const STALL_THRESHOLD: Duration = Duration::from_millis(500);
  pub const STALL_REPEAT_INTERVAL: Duration = Duration::from_secs(10);
  pub const OUTPUT_GAP_THRESHOLD: Duration = Duration::from_secs(2);

  #[derive(Clone, Debug, PartialEq, Eq)]
  pub struct TerminalPerfContext { /* identifiers, stage, counts, queue capacity */ }

  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum TerminalPerfEventKind { Stall, Recovered, Gap }

  #[derive(Clone, Debug, PartialEq, Eq)]
  pub struct TerminalPerfEvent { /* context, kind, duration, optional prior_stage */ }

  #[derive(Clone)]
  pub struct TerminalPerfMonitor { /* Arc<Mutex<State>>, thresholds */ }

  pub struct TerminalPerfGuard { /* monitor, operation id, finished flag */ }
  ```

  `begin_at`, `poll_at`, and `finish_at` use explicit monotonic instants for tests. Production `begin` and `poll` call `Instant::now()`. `finish_at` returns both a late stall and recovery when the watchdog did not run before a slow operation completed. `Drop` always removes the active operation. State contains only active operations and one rate-limit timestamp per operation.

  Add a process-global monitor and an idempotent `start_global_watchdog()` that scans every 250ms and sends formatted warning records through `log::warn!`. Format wall-clock `at_ms` only when emitting; derive `duration_ms` from monotonic time. Export the module from `lib.rs`.

- [x] **Step 4: Run the shared monitor tests**

  Run: `cargo test -p kanna-daemon terminal_perf -- --nocapture`

  Expected: PASS, including exact threshold and cleanup assertions.

- [x] **Step 5: Commit the shared primitive**

  ```bash
  git add crates/daemon/src/terminal_perf.rs crates/daemon/src/lib.rs
  git commit -m "feat: add bounded terminal stall monitor"
  ```

## Task 2: Instrument daemon output stages and source gaps

**Files:**
- Modify: `crates/daemon/src/startup.rs`
- Modify: `crates/daemon/src/output.rs`
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/tests.rs`

- [x] **Step 1: Add source-order and diagnostic-content tests**

  Extend source-order tests to require `terminal_perf` guards around:

  ```text
  mirror_output
  detect_status
  attached_writer
  recovery_write
  observer_write
  snapshot_lock
  snapshot_serialize
  ```

  Add a pure output-gap classifier test that feeds chunk times at `0ms`, `1900ms`, and `4000ms`, asserting only the last transition emits `event=gap`, with `prior_stage` when the previous processing pass exceeded 500ms and `pty_source_silence` otherwise.

- [x] **Step 2: Run focused daemon tests and confirm failure**

  Run: `cargo test -p kanna-daemon --lib output_gap -- --nocapture`

  Expected: FAIL because output gap tracking and the new stage guards are not wired.

- [x] **Step 3: Wire bounded instrumentation into daemon startup and output processing**

  Start the global watchdog once during daemon startup. In `stream_output`, assign a monotonically increasing chunk number per session and retain only `last_read_at` plus the previous slow stage. On output resumption after two seconds, emit one gap record, classified as a prior downstream blocker or PTY source silence.

  Wrap each awaited or CPU-sensitive boundary in a guard with the same chunk number and byte count. Split `Session::snapshot` timing so waiting for the state mutex is `snapshot_lock` and terminal serialization is `snapshot_serialize`. Do not log bytes, decoded output, command text, or snapshots.

- [x] **Step 4: Run daemon unit tests**

  Run: `cargo test -p kanna-daemon --lib -- --nocapture`

  Expected: PASS with existing output ordering unchanged.

- [x] **Step 5: Commit daemon instrumentation**

  ```bash
  git add crates/daemon/src/main.rs crates/daemon/src/output.rs crates/daemon/src/session.rs crates/daemon/src/tests.rs
  git commit -m "feat: classify daemon terminal output stalls"
  ```

## Task 3: Prove and isolate a non-reading daemon consumer

**Files:**
- Modify: `crates/daemon/tests/reconnect.rs`
- Modify: `crates/daemon/src/output.rs`

- [x] **Step 1: Add the deterministic red integration probe**

  Add `non_reading_attached_client_does_not_block_healthy_terminal_output` to `reconnect.rs`:

  1. Spawn a chatty PTY that writes numbered 16KiB chunks continuously.
  2. Attach client A, consume its attach snapshot/status, then deliberately stop reading.
  3. Wait until A's Unix socket buffer is saturated.
  4. Attach client B and continuously parse daemon JSON events.
  5. Send a unique marker into the PTY and require B to receive that marker within one second.
  6. Require B's received chunk sequence to remain ordered.

  Keep A alive until the assertion so the failure cannot be explained by disconnect cleanup.

- [x] **Step 2: Run the probe against current fanout**

  Run: `cargo test -p kanna-daemon --test reconnect non_reading_attached_client_does_not_block_healthy_terminal_output -- --nocapture`

  Expected: FAIL by timeout, proving the sequential `write_event().await` fanout can suspend PTY ingestion. If it unexpectedly passes after repeated runs, leave behavior unchanged, retain the probe, and skip Steps 3-5 as mandated by the approved proven-fix gate.

- [x] **Step 3: Add a fanout test for slow-client removal**

  Add a focused test asserting a writer that cannot finish within 500ms is shut down and removed, while a healthy writer receives the same chunk immediately. Assert the healthy writer still receives subsequent chunks in order.

- [x] **Step 4: Implement bounded concurrent live fanout**

  Replace sequential attached-writer delivery with concurrent writes using `futures::future::join_all`. Each per-client write is guarded by `tokio::time::timeout(STALL_THRESHOLD, write_event(...))`. A timeout or write error:

  - emits the `attached_writer` stall/recovery diagnostic;
  - shuts down that writer half so its reader observes EOF and can reconnect from a fresh snapshot;
  - removes the exact writer `Arc` from the session registry;
  - never cancels or reorders writes for healthy clients.

  Continue awaiting the group before processing the next PTY chunk, preserving per-client chunk order. Because writes run concurrently, healthy clients receive the current chunk without waiting behind the stalled client; the output loop is bounded to one 500ms timeout before the stalled writer is removed.

- [x] **Step 5: Run the regression tests repeatedly**

  Run:

  ```bash
  cargo test -p kanna-daemon --test reconnect non_reading_attached_client_does_not_block_healthy_terminal_output -- --nocapture
  cargo test -p kanna-daemon --test reconnect non_reading_attached_client_does_not_block_healthy_terminal_output -- --nocapture
  cargo test -p kanna-daemon --test reconnect -- --nocapture
  ```

  Expected: PASS on both repeated probes and the complete reconnect suite.

- [x] **Step 6: Commit the proven fix**

  ```bash
  git add crates/daemon/src/output.rs crates/daemon/tests/reconnect.rs
  git commit -m "fix: isolate stalled terminal consumers"
  ```

## Task 4: Instrument KSP queue admission and WebSocket delivery

**Files:**
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/ksp.rs`

- [x] **Step 1: Add tiny-queue and held-sink tests**

  Add Tokio tests in `ksp.rs` that use a test-owned monitor:

  ```rust
  #[tokio::test(start_paused = true)]
  async fn full_terminal_frame_queue_reports_outbound_queue_stall() { /* capacity 1, held receiver */ }

  #[tokio::test(start_paused = true)]
  async fn held_websocket_sink_reports_websocket_send_not_queue_stall() { /* send future held */ }

  #[tokio::test(start_paused = true)]
  async fn fast_terminal_frame_emits_no_perf_record() { /* ordinary path */ }
  ```

  Assert queue diagnostics include available and maximum capacity and contain no `data_b64` payload.

- [x] **Step 2: Run focused KSP tests and confirm failure**

  Run: `cargo test -p kanna-server ksp::tests::full_terminal_frame_queue_reports_outbound_queue_stall -- --nocapture`

  Expected: FAIL because KSP sends are not instrumented.

- [x] **Step 3: Add instrumented helpers and start the watchdog**

  Start the shared Rust watchdog once in server startup. Wrap terminal `frame_tx.send(frame).await` in `outbound_queue`, capturing `Sender::capacity()` and `Sender::max_capacity()` before awaiting. Wrap terminal-frame JSON serialization as `frame_serialize` and the socket sink await as `websocket_send`. Identify terminal frames without altering the KSP schema. Leave non-terminal coalescing and ordering unchanged.

- [x] **Step 4: Run KSP tests**

  Run: `cargo test -p kanna-server ksp::tests -- --nocapture`

  Expected: PASS; fast frames produce no diagnostic events.

- [x] **Step 5: Commit KSP instrumentation**

  ```bash
  git add crates/kanna-server/src/main.rs crates/kanna-server/src/ksp.rs
  git commit -m "feat: trace terminal KSP backpressure"
  ```

## Task 5: Stamp stream dispatch and monitor WebView/xterm backlog

**Files:**
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Create: `apps/desktop/src/perf/terminalOutputPerf.ts`
- Create: `apps/desktop/src/perf/terminalOutputPerf.test.ts`
- Modify: `apps/desktop/src/composables/terminalSessionLifecycle.ts`
- Modify: `apps/desktop/src/composables/useTerminal.test.ts`

- [x] **Step 1: Add stream dispatch timestamp tests**

  Extend `TerminalStreamHandlers.onOutput` to receive:

  ```ts
  export interface TerminalOutputMetadata {
    receivedAtMs: number;
  }
  ```

  Add an injectable monotonic `now` option to `StreamClient` tests and assert a `term_output` handler receives the exact local timestamp. Existing one-argument handlers must remain valid.

- [x] **Step 2: Add WebView monitor tests with fake time**

  Test a class or factory with injected `now`, wall clock, visibility, logger, and interval scheduler. Cover:

  - a held xterm completion callback emits `stage=xterm_backlog` at 500ms with pending chunk/byte counts;
  - completion emits one recovery and clears pending counts;
  - a 500ms timer drift while visible emits `stage=event_loop`;
  - the same drift while hidden emits `stage=background_throttling`;
  - a resumed frame after two seconds emits `stage=frame_gap`;
  - detach removes state and stops the interval when the last terminal leaves;
  - the serialized record does not contain a supplied base64 string or decoded marker.

- [x] **Step 3: Run frontend tests and confirm failure**

  Run:

  ```bash
  pnpm --dir packages/stream-client test -- src/stream-client.test.ts
  pnpm --dir apps/desktop test -- src/perf/terminalOutputPerf.test.ts src/composables/useTerminal.test.ts
  ```

  Expected: FAIL because metadata and the monitor do not exist.

- [x] **Step 4: Implement bounded frontend monitoring**

  `terminalOutputPerf.ts` owns one module-level registry keyed by session id and one 250ms interval while the registry is non-empty. Per session retain only counters, latest timestamps, maxima for E2E inspection, and the latest diagnostic record. Implement:

  ```ts
  export interface TerminalOutputPerfHandle {
    frameReceived(receivedAtMs: number, encodedBytes: number): void;
    recordDecode(durationMs: number, decodedBytes: number): void;
    beginXtermWrite(bytes: number): () => void;
    dispose(): void;
  }

  export function attachTerminalOutputPerf(sessionId: string): TerminalOutputPerfHandle;
  export function getTerminalOutputPerfSnapshot(): TerminalOutputPerfSnapshot;
  ```

  Emit `console.warn` records beginning `terminal_perf`; installed builds persist these through existing console forwarding. Use no payload fields. Rate-limit a continuing stall to ten seconds and emit one recovery. The xterm handle keeps aggregate pending chunks/bytes and the start of the current backlog episode, not a per-chunk history.

  In `terminalSessionLifecycle.ts`, attach the monitor alongside the terminal stream. On output, measure base64 decoding, call `beginXtermWrite`, and pass its idempotent completion function to `terminal.write(bytes, callback)`. Dispose it with the stream lifecycle. Preserve clipboard parsing and first-output behavior.

- [x] **Step 5: Run frontend tests**

  Run:

  ```bash
  pnpm --dir packages/stream-client test -- src/stream-client.test.ts
  pnpm --dir apps/desktop test -- src/perf/terminalOutputPerf.test.ts src/composables/useTerminal.test.ts
  ```

  Expected: PASS, including held callback and visible/hidden classifications.

- [x] **Step 6: Commit WebView instrumentation**

  ```bash
  git add packages/stream-client/src/index.ts packages/stream-client/src/stream-client.test.ts apps/desktop/src/perf/terminalOutputPerf.ts apps/desktop/src/perf/terminalOutputPerf.test.ts apps/desktop/src/composables/terminalSessionLifecycle.ts apps/desktop/src/composables/useTerminal.test.ts
  git commit -m "feat: diagnose webview terminal stalls"
  ```

## Task 6: Add bounded E2E observability and exercise the full path

**Files:**
- Modify: `apps/desktop/src/e2eAppMetrics.ts`
- Modify: `apps/desktop/src/env.d.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/tests/e2e/mock/terminal-output-performance.test.ts`

- [x] **Step 1: Add a failing E2E assertion for event-loop classification**

  Expose a development-only snapshot containing scalar maxima and the latest redacted terminal diagnostic. Extend the E2E test to:

  1. clear the snapshot;
  2. observe continuously numbered real PTY output under the normal path;
  3. assert no normal-path stage reaches 500ms;
  4. synchronously block the WebView main thread for 750ms through `browser.execute`;
  5. wait for the watchdog tick and assert the latest event is `stage=event_loop`, not `outbound_queue` or `websocket_send`;
  6. assert no numbered marker is lost after the block.

- [x] **Step 2: Run the focused E2E test and confirm failure**

  Start the canonical worktree environment with `./kd dev up`, then run:

  ```bash
  pnpm --dir apps/desktop test:e2e -- mock/terminal-output-performance.test.ts
  ```

  Expected: FAIL because the development snapshot is not exposed.

- [x] **Step 3: Expose only bounded redacted diagnostic state**

  Add `terminalOutputPerf` getters/resetters to the existing development-only `window.__KANNA_E2E__` surface. The snapshot contains active-session count, maximum frame gap, maximum event-loop drift, maximum xterm backlog, pending counts, and the latest structured event. It contains no terminal strings, frame bodies, or history array.

- [x] **Step 4: Run E2E and terminal fidelity regressions**

  Run:

  ```bash
  pnpm --dir apps/desktop test:e2e -- mock/terminal-output-performance.test.ts
  pnpm --dir apps/desktop test -- src/composables/useTerminal.test.ts
  ```

  Expected: PASS; the injected block is classified locally and normal output resumes in order.

- [ ] **Step 5: Commit E2E coverage**

  ```bash
  git add apps/desktop/src/e2eAppMetrics.ts apps/desktop/src/env.d.ts apps/desktop/src/main.ts apps/desktop/tests/e2e/mock/terminal-output-performance.test.ts
  git commit -m "test: cover terminal stall diagnostics end to end"
  ```

## Task 7: Verify the complete change

**Files:**
- Review all files changed since the design commit.

- [ ] **Step 1: Format and run focused checks**

  ```bash
  cargo fmt --all -- --check
  pnpm --dir packages/stream-client test
  pnpm --dir apps/desktop test -- src/perf/terminalOutputPerf.test.ts src/composables/useTerminal.test.ts
  cargo test -p kanna-daemon terminal_perf -- --nocapture
  cargo test -p kanna-daemon --test reconnect -- --nocapture
  cargo test -p kanna-server ksp::tests -- --nocapture
  ```

  Expected: all PASS.

- [ ] **Step 2: Run repository-level verification**

  ```bash
  pnpm test
  ./kd test rust
  ```

  Expected: all PASS. If an unrelated pre-existing failure occurs, capture the exact command and output and keep it separate from task regressions.

- [ ] **Step 3: Inspect diagnostics and diff**

  ```bash
  rg -n "terminal_perf" crates/daemon crates/kanna-server apps/desktop packages/stream-client
  git diff --check
  git status --short
  git diff --stat e16775d7..HEAD
  ```

  Confirm every record is redacted, every monitor is bounded by active sessions/operations, the output frame schema is unchanged, and no direct database or non-worktree files changed.

- [ ] **Step 4: Record final verification evidence**

  Update this plan's checkboxes to reflect executed work. Do not advance the manual Kanna stage. Report the implementation, proven root cause (if the deterministic gate reproduced it), diagnostic stages, and exact verification results to the user.
