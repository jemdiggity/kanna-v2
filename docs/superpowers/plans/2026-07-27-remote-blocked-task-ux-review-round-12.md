# Remote Blocked Task UX Review Round 12 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all seven round-12 review findings while preserving the
replacement PR's remote blocked-task and terminal behavior.

**Architecture:** Repository-scoped projection prevents cross-owner blocker
aliasing; privileged HTTP middleware protects transfer state; existing sealed
request crypto authenticates transfer lifecycle messages before side effects.
Blocking artifact work runs off-thread and publishes crash-safely, while daemon
subscriptions share the exact-incarnation lifecycle fence. `/v1/stream` is the
explicit deployed-client compatibility lane and `/v2/stream` is the secure
negotiated endpoint.

**Tech Stack:** Vue 3, TypeScript/Vitest, Rust, Tokio, Axum, Tauri v2,
SQLite/rusqlite, Unix `openat`/atomic rename primitives.

---

### Task 1: Scope blocker fallback to the repository and owner

**Files:**
- Modify: `apps/desktop/src/workspace/projectWorkspaceBlockers.ts`
- Test: `apps/desktop/src/workspace/projectWorkspaceBlockers.test.ts`
- Test: `apps/desktop/src/App.test.ts`

- [x] Add a failing projection test with an absent intended blocker and a
  same-owner/task-ID PR-resolved collision in another repository.
- [x] Add `repoKey` to scoped and fallback owner-task index keys.
- [x] Add an App integration fixture proving the raw fallback remains in
  Sidebar's Blocked section, MainPanel's blocker panel, and Cmd+S's guard.
- [x] Run the focused projection and App tests.

### Task 2: Protect transfer HTTP and retain v1 mobile compatibility

**Files:**
- Modify: `crates/kanna-server/src/http_api/lan_trust.rs`
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [x] Add failing non-loopback requests with hostile `Origin` headers for a
  transfer list read and transfer mutation; assert `401` and unchanged state.
- [x] Classify all non-OPTIONS `/v1/transfers` methods as privileged controls.
- [x] Replace the current v1 rejection fixture with a serialized deployed
  previous-mobile auth/terminal stream fixture that expects `AuthOk`.
- [x] Restore `AllowEmpty` only on `/v1/stream`; retain peer-derived paired
  auth on `/v2/stream`.
- [x] Run focused Kanna server HTTP and KSP tests.

### Task 3: Authenticate prepare and finalize transfer messages

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Test: `crates/task-transfer/tests/protocol.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add failing forged prepare/finalize argument, stale-envelope, in-process
  replay, and restart replay tests; assert no second reservation or
  finalization event.
- [x] Add authenticated payloads to prepare and finalize protocol frames.
- [x] Seal receiver epoch, request/transfer IDs, requester, target identity,
  and source task identity on the sender.
- [x] Authenticate and durably reserve replay IDs before receiver side effects,
  then validate every bound outer argument.
- [x] Run protocol and focused runtime tests.

### Task 4: Offload and crash-proof artifact materialization

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_artifact.rs`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Test: `apps/desktop/src-tauri/src/transfer_artifact.rs`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`

- [x] Add a failing stale-partial-temp retry test for Codex rollout copying.
- [x] Add a failing store retry test proving an imported task retains its
  resume session when the complete rollout already exists, and that copy
  errors abort task creation.
- [x] Publish Codex copies through a create-new same-directory temp, file
  flush/fsync, no-replace rename, and parent-directory fsync; clean stale
  matching temps.
- [x] Make the Tauri command async and run the entire materializer through
  `spawn_blocking`, mapping join errors.
- [x] Run desktop Rust artifact tests and focused transfer-store tests.

### Task 5: Fence daemon subscription registration by incarnation

**Files:**
- Modify: `crates/daemon/src/connection.rs`
- Test: `crates/daemon/tests/reconnect.rs`

- [x] Add deterministic pause-based regressions for ObserveSnapshot and
  AttachSnapshot racing Kill, plus same-ID respawn; reject any stale
  Snapshot/Status after final Exit.
- [x] Acquire the per-ID lifecycle lock before resolving Observe,
  ObserveSnapshot, or AttachSnapshot.
- [x] Revalidate the exact session handle and fanout under the registration
  lock immediately before enqueueing initial events or `Ok`.
- [x] Run the focused daemon reconnect regressions and daemon crate tests.

### Task 6: Verify, review, and hand off

**Files:**
- Review: complete branch diff against `origin/main`

- [x] Run focused frontend/workspace suites, Kanna server, task-transfer,
  desktop artifact/store, daemon, and compatibility suites.
- [x] Run the desktop build/typecheck and `pnpm test`.
- [x] Run `./kd test rust`.
- [x] Review the complete diff for original blocker, terminal, read-dwell,
  file-link, lifecycle-response, and workspace-projection requirements.
- [x] Commit the revision and record successful Kanna stage completion with a
  replacement-PR summary that says it supersedes #921.
