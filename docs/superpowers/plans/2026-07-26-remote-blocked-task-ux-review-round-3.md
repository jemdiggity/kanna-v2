# Remote Blocked Task UX Review Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate LAN snapshot/advance requests, linearize competing task mutations, recover desktop retry state, fence observer races, and restore optional stage-advance revision compatibility.

**Architecture:** Existing sealed transfer identities authenticate and replay-bind sensitive peer requests. A canonical keyed `AppState` lease spans validation and detached lifecycle execution, desktop pending entries track source snapshot generations, and observer slots reserve a generation before discovery awaits.

**Tech Stack:** Rust, Tokio, Axum, rusqlite, X25519/XChaCha20-Poly1305, Vue 3, TypeScript, Vitest, Tauri v2.

---

### Task 1: Authenticated LAN Snapshot And Advance Requests

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/task-transfer/tests/sidecar_control.rs`

- [ ] **Step 1: Write failing protocol and runtime regressions**

Add tests that deserialize snapshot/advance requests without
`expected_transition_revision`, assert modern envelopes omit an absent
revision, reject an attacker-encrypted advance claiming a paired peer, reject
an exact replay, and reject forged snapshot access before returning task data.

- [ ] **Step 2: Verify the regressions fail**

Run:

```bash
cargo test -p kanna-task-transfer --test protocol
cargo test -p kanna-task-transfer --test runtime forged_advance_payload_cannot_apply_owner_action -- --exact
cargo test -p kanna-task-transfer --test runtime forged_snapshot_payload_cannot_expose_owner_tasks -- --exact
```

Expected: protocol deserialization fails for the missing required field and
forged plaintext requests reach the current authorization checks.

- [ ] **Step 3: Implement sealed request authentication and replay consumption**

Add optional sealed payload fields, an authenticated request helper that
verifies sender key/action/request ID and consumes a bounded replay key, and
use it before snapshot exposure or owner advance dispatch. Build envelopes
from the runtime's persisted identity.

- [ ] **Step 4: Verify Task 1**

Run:

```bash
cargo test -p kanna-task-transfer --test protocol
cargo test -p kanna-task-transfer --test runtime
cargo test -p kanna-task-transfer --test sidecar_control
```

Expected: all task-transfer protocol, runtime, and sidecar tests pass.

### Task 2: Shared Per-Task Mutation Lease

**Files:**
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/task_blockers.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/revision_status.rs`

- [ ] **Step 1: Write failing cross-action and blocker-race tests**

Gate detached advance execution, then race completion, revision, close, and
blocker replacement against the same task. Assert competitors cannot commit
until the advance lease releases and then re-read the post-advance state.

- [ ] **Step 2: Verify the regressions fail**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions::advance_stage_linearizes -- --nocapture
cargo test -p kanna-server http_api::tests::actions::blocker_replacement_waits_for_stage_advance -- --exact
```

Expected: at least one competing mutation commits during advance preparation
or detached execution.

- [ ] **Step 3: Implement canonical keyed leases**

Replace the advance-only set with one coordinator that can return an
idempotent non-waiting claim for advance or an awaited claim for competing
mutations. Resolve the durable task ID first, acquire its lease, re-open the DB
for validation, and transfer advance/completion/revision leases into detached
execution.

- [ ] **Step 4: Verify Task 2**

Run:

```bash
cargo test -p kanna-server http_api::tests::actions -- --nocapture
cargo test -p kanna-server http_api::tests::revision_status -- --nocapture
```

Expected: all action and revision route tests pass.

### Task 3: Desktop Retry Reconciliation And Legacy No-CAS Path

**Files:**
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: adjacent LAN/relay/Tauri tests

- [ ] **Step 1: Write failing retry and compatibility regressions**

Add UI tests for an accepted request followed by a later authoritative
same-revision snapshot, task disappearance followed by same-revision
reappearance, disposal cleanup, and an older snapshot without a revision
issuing an authenticated no-CAS advance.

- [ ] **Step 2: Verify the regressions fail**

Run:

```bash
pnpm --dir apps/desktop test --run src/App.test.ts
```

Expected: same-revision accepted requests remain pending, reappearing tasks
remain suppressed, and revision-less tasks are rejected locally.

- [ ] **Step 3: Implement generation-backed pending reconciliation**

Track cloud/LAN snapshot generations, record the selected source generation in
each pending entry, reconcile on later generations/task identity/revision, and
clear on disposal. Make every expected revision boundary optional and omit it
for legacy snapshots.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
pnpm --dir apps/desktop test --run \
  src/App.test.ts \
  src/services/desktopLanTerminal.test.ts \
  src/services/desktopRelayTerminal.test.ts
cargo test -p kanna-desktop transfer -- --nocapture
```

Expected: focused desktop and Tauri transfer tests pass.

### Task 4: Observer Generation Fencing

**Files:**
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/task-transfer/tests/sidecar_control.rs`

- [ ] **Step 1: Write failing observer ordering regressions**

Delay peer discovery during observe, issue unobserve, release discovery, and
assert no observer installs. Start two overlapping observes and assert the
newest observer survives while the displaced handle terminates.

- [ ] **Step 2: Verify the regressions fail**

Run:

```bash
cargo test -p kanna-task-transfer delayed_observe_cannot_install_after_unobserve -- --exact
cargo test -p kanna-task-transfer concurrent_observe_replacement_aborts_displaced_handle -- --exact
```

Expected: delayed observe installs after unobserve and/or both observer
connections remain live.

- [ ] **Step 3: Implement generation-owned observer slots**

Reserve `{ generation, handle: None }` before discovery, abort displaced
handles under the observer-map lock, and install only when the generation is
still current. Remove and abort on unobserve and runtime drop.

- [ ] **Step 4: Verify Task 4**

Run all task-transfer runtime and sidecar control tests. Expected: all pass.

### Task 5: Full Verification, Scope Review, Commit, And Handoff

**Files:**
- Review every changed file against `origin/main`.

- [ ] **Step 1: Run focused frontend/workspace checks**

```bash
pnpm --dir apps/desktop test --run \
  src/App.test.ts \
  src/composables/useAppKeyboardActions.test.ts \
  src/services/desktopCloudTaskIndex.test.ts \
  src/services/desktopLanTaskIndex.test.ts \
  src/services/desktopLanTerminal.test.ts \
  src/services/desktopRelayTerminal.test.ts \
  src/workspace/buildWorkspace.test.ts \
  src/workspace/projectWorkspaceBlockers.test.ts
```

- [ ] **Step 2: Run desktop build/typecheck and canonical practical JavaScript verification**

Inspect root and desktop package scripts, run the repository's desktop build
and typecheck commands, then:

```bash
pnpm test
```

- [ ] **Step 3: Run focused and canonical Rust verification**

```bash
cargo test -p kanna-task-transfer
cargo test -p kanna-server
./kd test rust
```

- [ ] **Step 4: Review correctness and scope**

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status --short
```

Confirm all five reviewer findings are covered, blocker behavior remains
projected through cloud/LAN, local and terminal behavior is unchanged, and no
release dependency relies on a build-machine library.

- [ ] **Step 5: Commit and record the auto-transition result**

Commit the finished revision locally with a focused message. Then call
`kanna_complete_stage` with a summary that the future replacement PR
supersedes #921, describes the conflict/security/concurrency decisions, and
lists exact verification evidence. Do not push, create a PR, modify #921, or
advance the pipeline manually.
