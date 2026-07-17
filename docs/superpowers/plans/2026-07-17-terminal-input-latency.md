# Terminal Input Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep desktop keypress-to-echo latency below 500 ms while concurrent same-WebSocket server work runs, without changing terminal byte semantics or lifecycle recovery.

**Architecture:** A bounded per-terminal control worker caches task-to-daemon routing and owns one persistent daemon socket, while the existing output attachment keeps its own socket. KSP requests and synchronous route resolution are dispatched away from the sequential WebSocket reader and Tokio runtime workers.

**Tech Stack:** Rust, Tokio, Axum WebSockets, rusqlite, Kanna daemon JSON protocol, Vue 3, TypeScript, Vitest, WebDriver real-PTY E2E.

---

### Task 1: Prove KSP head-of-line blocking and persistent control semantics

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write a failing same-WebSocket concurrency test**

Add a fake daemon plus a locked SQLite write fixture. Attach a task terminal,
send a KSP settings write that remains blocked, then send `TermInput`. Assert
the fake daemon receives `DaemonCommand::Input` within 300 ms before releasing
the SQLite lock.

- [ ] **Step 2: Run the test and verify RED**

Run: `cargo test -p kanna-server ksp::tests::terminal_input_bypasses_blocked_ksp_request -- --nocapture`

Expected: FAIL because the sequential frame loop does not read `TermInput`
until the blocked request completes.

- [ ] **Step 3: Write failing connection reuse and ordering tests**

Have one fake control connection accept input, resize, and a second input.
Assert one accepted socket and exact command order, including opaque Kitty and
paste bytes.

- [ ] **Step 4: Run the tests and verify RED**

Run: `cargo test -p kanna-server ksp::tests::terminal_control -- --nocapture`

Expected: FAIL because every command currently opens a fresh socket.

### Task 2: Implement the terminal control worker and blocking boundaries

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add asynchronous route resolution**

Replace synchronous `resolve_session_id` use on async paths with a helper that
clones the DB path and task id and calls `Db::open(...).resolve_task_terminal_session_id(...)`
inside `tokio::task::spawn_blocking`.

- [ ] **Step 2: Add bounded per-terminal workers**

Add `TerminalControlCommand`, `TerminalControlHandle`, and a worker loop. The
worker resolves at most once, owns an optional persistent `DaemonClient`, sends
commands in channel order, validates `DaemonEvent::Ok`, and reconnects with the
existing bounded daemon retry schedule after transport loss.

- [ ] **Step 3: Route input and resize without awaiting daemon replies**

Decode base64 in the reader loop, obtain or create the task's control handle,
and use `try_send`. Emit `terminal_busy` on a full channel. On successful
terminal attach, replace a handle whose cached session route differs.

- [ ] **Step 4: Dispatch request and agent commands concurrently**

Spawn task-addressed agent command work instead of awaiting it in the reader.
For KSP API requests, call `dispatch_http_invoke` from a `spawn_blocking`
closure driven by the current Tokio handle, then send the id-addressed response
from the spawned task.

- [ ] **Step 5: Run the Rust tests and verify GREEN**

Run: `cargo test -p kanna-server ksp -- --nocapture`

Expected: all KSP tests pass, including the new latency, ordering, reconnect,
and route replacement cases.

### Task 3: Lock frontend byte batching behavior

**Files:**
- Create: `apps/desktop/src/composables/terminalInputQueue.test.ts`
- Modify: `apps/desktop/src/composables/terminalInputQueue.ts` only if a failing test exposes a defect
- Modify: `apps/desktop/src/composables/useTerminal.test.ts` only for xterm integration expectations

- [ ] **Step 1: Write direct queue tests**

Use fake timers and a fake `StreamClient` to assert rapid input coalesces after
8 ms, Kitty/bracketed-paste bytes survive base64 exactly, immediate sends flush
older queued bytes first, and one rejected client acquisition does not poison
later writes.

- [ ] **Step 2: Run the tests and verify RED where behavior is missing**

Run: `pnpm --dir apps/desktop exec vitest run src/composables/terminalInputQueue.test.ts src/composables/useTerminal.test.ts`

Expected: any missing recovery or ordering behavior fails for the stated
assertion rather than a fixture error.

- [ ] **Step 3: Make the minimal queue correction**

Preserve the 8 ms batching window and promise chain, changing only behavior
demonstrated by a failing test.

- [ ] **Step 4: Re-run and verify GREEN**

Run the same Vitest command and expect all selected tests to pass.

### Task 4: Add deterministic concurrent server work to the real E2E harness

**Files:**
- Modify: `crates/kanna-server/src/http_api/e2e_sql.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `apps/desktop/src/env.d.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/tests/e2e/real/pty-session.test.ts`

- [ ] **Step 1: Add a debug-only bounded server-work endpoint**

Accept `durationMs` clamped to 1..2000 and perform the sleep inside
`spawn_blocking`. Register the route only with other debug E2E routes.

- [ ] **Step 2: Expose same-WebSocket work through the E2E hook**

Add hook methods that start and await a shared `StreamClient.request` to the
debug endpoint, allowing terminal input to overlap the unresolved response.

- [ ] **Step 3: Tighten the real PTY latency test**

Start 750 ms of server work, send a unique marker through the active xterm,
poll the xterm buffer at a short interval, assert echo under 500 ms, and then
await successful server-work completion.

- [ ] **Step 4: Run the focused E2E target**

Start the canonical environment with `./kd dev up`, then run:
`pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/pty-session.test.ts`.

Expected: the latency case passes below 500 ms and lifecycle/handoff cases
remain green.

### Task 5: Full verification and revision commit

**Files:**
- Review all modified files

- [ ] **Step 1: Run requested focused and canonical checks**

Run:

```bash
cargo test -p kanna-server ksp -- --nocapture
pnpm --dir apps/desktop exec vitest run src/composables/terminalInputQueue.test.ts src/composables/useTerminal.test.ts
pnpm test
(cd crates/daemon && cargo test -- --test-threads=1)
cargo test -p kanna-server
```

Expected: every command exits 0 with no failed tests.

- [ ] **Step 2: Review the final diff and status**

Run: `git diff --check && git status --short && git diff --stat && git diff`

Expected: no whitespace errors, only task-related files, and all design
requirements represented in code or tests.

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add docs/superpowers/specs/2026-07-17-terminal-input-latency-design.md \
  docs/superpowers/plans/2026-07-17-terminal-input-latency.md \
  crates/kanna-server/src/ksp.rs \
  crates/kanna-server/src/http_api/e2e_sql.rs \
  crates/kanna-server/src/http_api/router.rs \
  apps/desktop/src/env.d.ts \
  apps/desktop/src/main.ts \
  apps/desktop/src/composables/terminalInputQueue.test.ts \
  apps/desktop/src/composables/terminalInputQueue.ts \
  apps/desktop/src/composables/useTerminal.test.ts \
  apps/desktop/tests/e2e/real/pty-session.test.ts
git commit -m "fix: isolate terminal input from server latency"
```

Expected: a task-specific commit containing the implementation and regression
coverage required to cross the next stage boundary.
