# Provider Resume Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider resume bounded, process-owned, generation-safe, action-idempotent, and release-build complete.

**Architecture:** Correlate Codex metadata through rollout descriptors owned by the exact PTY process group, use immutable daemon spawn generations, and add server-side expected-state action leases. Enforce ownership with database compare-and-swap and generation-conditional daemon lifecycle operations.

**Tech Stack:** Rust, Tokio, Unix process/pipes, serde, rusqlite/SQLite, Cargo, Bazel

---

### Task 1: Bound and correlate Codex discovery

**Files:**
- Modify: `crates/daemon/src/codex_session.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/startup.rs`

- [ ] Add tests proving a verified ID bypasses traversal, a large global history is
  not scanned, foreign same-cwd post-spawn metadata is rejected, and custom
  `CODEX_HOME` plus locator correlation state survive handoff.
- [ ] Run `cargo test -p kanna-daemon codex_session` and confirm the new tests fail
  against global recursive discovery.
- [ ] Replace full-history baseline IDs with bounded process-group descriptor
  discovery and serializable locator handoff state; reject unverified/incomplete
  adoption.
- [ ] Run `cargo test -p kanna-daemon codex_session` and confirm all locator tests pass.

### Task 2: Order respawn input and bind readers to generations

**Files:**
- Modify: `crates/daemon/src/agent.rs`
- Modify: `crates/daemon/src/agent_runtime/commands.rs`
- Modify: `crates/daemon/src/agent_runtime/readers.rs`
- Modify: `crates/daemon/src/agent_runtime/lifecycle.rs`
- Modify: `crates/daemon/src/agent_runtime/adoption.rs`
- Modify: `crates/daemon/tests/agent_sessions.rs`

- [ ] Add a barrier-controlled respawn test that holds reader delivery until the
  accepted `UserMessage` append can be inspected.
- [ ] Add a kill-respawn fault-injection test that releases old buffered output and
  EOF after the replacement exists and asserts no journal/status/Exit mutation.
- [ ] Run the two focused tests and confirm ordering and stale-reader failures.
- [ ] Add immutable `spawn_generation` to records/readers; guard every registry
  access and EOF; journal accepted respawn input before opening the reader gate.
- [ ] Make Kill accept expected run/generation ownership and refuse stale targets.
- [ ] Run `cargo test -p kanna-daemon --test agent_sessions` repeatedly and in
  parallel to prove the prior flaky regression is stable.

### Task 3: Validate Exit ownership

**Files:**
- Modify: `crates/kanna-server/src/terminal_watcher.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`

- [ ] Add a watcher test that sends a delayed old `Exit.run_id` after a replacement
  main run owns the task and asserts activity/notifications remain unchanged.
- [ ] Run the focused watcher test and confirm it fails.
- [ ] Add an exact-active-owner database predicate and require it before completion
  side effects; consume replacement bookkeeping without trusting `session_id`.
- [ ] Run the focused watcher and stage-run database tests.

### Task 4: Serialize and compare-and-swap task actions

**Files:**
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/stages.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/db/stage_runs.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/stage.rs`

- [ ] Add concurrent/retry tests for revision, advance, completion, and rerun plus
  stale-worker Kill/land tests.
- [ ] Run focused HTTP/lifecycle/database tests and confirm duplicate mutations.
- [ ] Add task-scoped action flights and prepared expected stage/branch/run identity.
- [ ] Implement transactional finish/create/land/rerun compare-and-swap helpers and
  idempotent already-applied results.
- [ ] Carry expected run/generation through detached workers and conditional Kill.
- [ ] Run all focused server tests.

### Task 5: Negotiate resume before mutation

**Files:**
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/revision.rs`

- [ ] Add a full HTTP revision regression with a legacy/unreachable fake daemon and
  assert the source run, stage, branch, and response status remain correct.
- [ ] Run the regression and confirm the current handler returns success after
  prematurely failing the run.
- [ ] Move capability negotiation before revision mutation; on incompatibility use
  the prepared fresh-fork path when safe, otherwise return an error without writes.
- [ ] Run full revision HTTP and task-creator test modules.

### Task 6: Synchronize release dependency graphs

**Files:**
- Modify: `crates/daemon/Cargo.lock`
- Modify: `crates/kanna-server/Cargo.lock`
- Modify: `crates/task-transfer/Cargo.lock`
- Modify: Bazel crate-universe lock output selected by the repository generator

- [ ] Reproduce `bazel build //:kanna-daemon-aarch64-apple-darwin` and retain the
  `E0433` failure as the release regression.
- [ ] Regenerate Cargo and Bazel dependency locks using repository tooling.
- [ ] Build daemon, server, and task-transfer Apple sidecar release targets.

### Task 7: Full verification and compatibility review

**Files:**
- Modify only if verification exposes a scoped regression.

- [ ] Run formatter and focused daemon/server tests.
- [ ] Run `pnpm test` and `./kd test rust`.
- [ ] Run the three Bazel release sidecar builds.
- [ ] Create and wait for a `review-compat` specialty task through `kanna-mcp`,
  ensuring it records a PASS/FAIL latest run without interactive confirmation.
- [ ] Record this stage success only after every required check and compatibility
  verdict passes; otherwise record failure with the blocking evidence.
