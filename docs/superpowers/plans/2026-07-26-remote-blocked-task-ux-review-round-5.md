# Remote Blocked Task UX Review Round 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all six fifth-round review findings without regressing remote blocker, terminal, activity, file-link, or workspace behavior.

**Architecture:** Cache reclamation proves root and child ownership before deletion; UI, sidecar, and runtime each bound terminal work; observer lease ids make event authority explicit; stage advancement revalidates its source after client acquisition; generated Cargo/Bazel locks remain the release source of truth.

**Tech Stack:** Node.js, Vitest, Vue 3, TypeScript, Rust/Tokio, Cargo, Bazel.

---

### Task 1: Safe kd cache ownership

**Files:**
- Modify: `tools/kd/bin/kd-cache.mjs`
- Modify: `tools/kd/tests/kd-cache.test.mjs`

- [x] **Step 1: Add failing preservation and root-safety regressions**

Add tests that construct a marked cache with a valid 64-hex installation plus
`unrelated-project/` and a malformed hash installation, prune with `maxEntries:
0`, and assert only the valid installation is removed. Add table cases for `/`,
the injected home, the injected temp root, and a non-empty unmarked override;
each must throw before changing any child.

- [x] **Step 2: Verify the regressions fail**

Run:
`pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1`

Expected: the unrelated children are removed by current enumeration and unsafe
roots are accepted.

- [x] **Step 3: Implement root and child ownership validation**

Add a versioned `.kanna-kd-cache-root.json` marker, reject broad roots by
canonical path, initialize only safe empty/new roots (plus compatible canonical
default migration), and build prune candidates only when
`/^[0-9a-f]{64}$/` matches and `manifest.json` claims the exact identity/schema
and fixed entrypoints whose files exist.

- [x] **Step 4: Verify kd cache behavior**

Re-run the focused Vitest command and expect all cache tests to pass.

### Task 2: Bounded terminal/control scheduling

**Files:**
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Create: `apps/desktop/src/components/__tests__/CloudTerminalView.test.ts`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/tests/sidecar_control.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`

- [x] **Step 1: Add a failing frontend FIFO/backpressure regression**

Make `sendInput` return deferred promises, emit `a`, `b`, and `c`, and assert
only `a` is in flight; resolving it admits `b`, then `c`, in exact order.
Exercise unmount/replacement and assert queued bytes are discarded rather than
sent through the old client.

- [x] **Step 2: Add failing Rust admission/isolation regressions**

Drive more controls than the configured ordinary limit and assert excess
requests receive overload errors without increasing active handler count.
Stall the configured mark-read lane, then assert a terminal input request still
reaches its peer. Record two input requests for one session and assert the peer
observes their byte payloads in FIFO order.

- [x] **Step 3: Verify the new tests fail**

Run:
`pnpm --dir apps/desktop exec vitest run src/components/__tests__/CloudTerminalView.test.ts`

Run:
`cargo test --manifest-path crates/task-transfer/Cargo.toml --test sidecar_control --test runtime`

Expected: concurrent sends and unrestricted control/TCP work violate the new
assertions.

- [x] **Step 4: Implement layered bounded scheduling**

Serialize/coalesce xterm input per mounted terminal. In the sidecar, use
try-acquired owned permits before spawning, with separate ordinary and
mark-read semaphores and an explicit overload `ControlResponse::Error`.
In `TransferRuntime`, add separate bounded general and mark-read peer-request
semaphores; acquire the correct permit before connecting and retain it through
response parsing. Keep per-session input serialization independent of
mark-read.

- [x] **Step 5: Verify scheduling**

Re-run both focused commands and expect the FIFO, overload, and isolation tests
to pass.

### Task 3: Bounded observer state and lease-authoritative events

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/daemon.rs`
- Modify: `crates/task-transfer/src/runtime/events.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/task-transfer/tests/sidecar_control.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`

- [x] **Step 1: Add failing tombstone and delayed-event regressions**

Use short injected tombstone retention/capacity to close many never-observed
leases, trigger pruning, and assert observer state stays within the limit while
an immediate unobserve-before-observe pair remains suppressed. Replace lease A
with lease B, inject a delayed A output event after B is active, and assert only
B output reaches the frontend listener.

- [x] **Step 2: Verify observer regressions fail**

Run the focused task-transfer protocol/runtime/control tests and
`pnpm --dir apps/desktop exec vitest run src/services/desktopLanTerminal.test.ts`.

Expected: tombstones accumulate and the old event lacks enough identity to be
rejected.

- [x] **Step 3: Implement bounded tombstones and lease propagation**

Record closed time/order on tombstones, prune expired entries, and evict oldest
closed entries above capacity without touching active handles. Copy
`observer_lease_id` into the stream task, every `RuntimeEvent::TerminalEvent`,
`SidecarEvent::TerminalEvent`, Tauri terminal event payload, and desktop event
normalization. Require exact lease equality in `desktopLanTerminal`.

- [x] **Step 4: Verify observer behavior**

Re-run all focused observer tests and expect them to pass.

### Task 4: Post-acquisition stage authority

**Files:**
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [x] **Step 1: Add failing delayed-client route replacement tests**

Delay relay/LAN client creation, request stage advance, install a replacement
snapshot/route, then resolve the old client. Assert `advanceStage` is not called
and the acquired client closes. Cover one snapshot with a transition revision
and one legacy snapshot where both revisions are null but the authoritative
generation changes.

- [x] **Step 2: Verify tests fail**

Run:
`pnpm --dir apps/desktop exec vitest run src/App.test.ts`

Expected: the old client calls `advanceStage` after route replacement.

- [x] **Step 3: Implement exact revalidation**

Immediately before sending, require
`remoteStageAdvancesPending.get(requestKey) === pending`, exact source
kind/owner identity, exact transition revision, and exact current authoritative
generation. Return without sending on any mismatch and let `finally` close the
client.

- [x] **Step 4: Verify workspace authority**

Re-run `src/App.test.ts` and the focused cloud-workspace tests.

### Task 5: Regenerate desktop release locks

**Files:**
- Modify: `Cargo.desktop.lock`
- Modify: `MODULE.bazel.lock`

- [x] **Step 1: Regenerate Cargo lock**

Run:
`cargo generate-lockfile --manifest-path Cargo.desktop.toml`

Expected: `Cargo.desktop.lock` records `futures-util`,
`tokio-tungstenite`, and their transitive dependency graph.

- [x] **Step 2: Regenerate Bazel module lock**

Run:
`bazel mod deps --lockfile_mode=update`

Expected: `MODULE.bazel.lock` changes only in generated desktop crate-universe
inputs and contains repositories for both direct crates.

- [x] **Step 3: Inspect generated diffs**

Run:
`git diff -- Cargo.desktop.lock MODULE.bazel.lock`

Expected: generated dependency changes only; no hand edits or unrelated module
selection changes.

### Task 6: Full verification, scope review, and completion

**Files:**
- Review: all changes against `origin/main`

- [x] **Step 1: Run focused frontend and workspace tests**

Run the CloudTerminalView, desktop LAN terminal, App/cloud-workspace, workspace
projection, and remote terminal service suites.

- [x] **Step 2: Run touched Rust tests**

Run task-transfer unit, protocol, runtime, and sidecar-control tests plus the
desktop Rust checks required by the changed event payload.

- [x] **Step 3: Run requested repository verification**

Run the desktop build/typecheck, `pnpm test`, and `./kd test rust` when practical
for this touched Rust surface.

- [x] **Step 4: Review and commit**

Run `git diff --check`, inspect `git diff --stat origin/main...HEAD`, review the
complete task diff for scope and requirements, then commit all finished changes
with a focused review-fix message.

- [x] **Step 5: Record Kanna completion**

Record success with a summary that says the replacement PR supersedes #921,
lists concurrency/cache/lease/authority decisions, and reports verification
evidence. Record failure instead if any required boundary remains unresolved.
