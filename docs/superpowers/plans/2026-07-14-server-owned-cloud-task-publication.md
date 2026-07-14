# Server-Owned Cloud Task Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the mobile Firestore task index from the singleton `kanna-server` relay connection instead of Vue renderer windows.

**Architecture:** Add a Rust snapshot mapper and coalescing publisher state machine to `kanna-server`; add a validated Firebase Admin reconciliation handler to the relay; reduce desktop writes to credential association only. The server sends full open-task snapshots and the relay derives the only writable Firestore subtree from the revalidated authenticated principal.

**Tech Stack:** Rust/Tokio/Serde/SQLite/WebSockets, TypeScript/Vitest/ws, Firebase Admin/Firestore emulator, Vue 3/Vitest, pnpm.

---

### Task 1: Rust snapshot contract and mapper

**Files:**
- Create: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/Cargo.toml`

- [ ] Write tests that build a `UiSnapshot` and assert every existing cloud schema field, activity, blockers, repository remote metadata, and status mapping.
- [ ] Run `cargo test -p kanna-server cloud_task_publisher::tests::snapshot -- --nocapture` and confirm the missing module/API failure.
- [ ] Implement serializable version-1 snapshot types and a pure `map_ui_snapshot(desktop_id, desktop_name, snapshot)` function.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Rust coalescing/retry/reconnect state machine

**Files:**
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `crates/kanna-server/src/relay_client.rs`
- Modify: `crates/kanna-server/src/relay.rs`

- [ ] Add tests proving one in-flight request, newest-state coalescing, acknowledgement advancement, retry scheduling/limit, timeout retry, and forced reconnect reconciliation.
- [ ] Run the focused tests and confirm behavioral failures.
- [ ] Add `task_snapshot_publish` and `task_snapshot_ack` relay messages plus a transport-independent publisher state machine.
- [ ] Integrate a short SQLite fingerprint poll and retry deadline into the existing single relay loop; start publication only after `auth_ok` and force reconcile on each reconnect.
- [ ] Run `cargo test -p kanna-server cloud_task_publisher relay_client relay::tests -- --nocapture` and confirm it passes.

### Task 3: Relay validation and scoped Firestore reconciliation

**Files:**
- Create: `services/relay/src/cloudTaskPublication.ts`
- Create: `services/relay/test/cloudTaskPublication.test.ts`
- Modify: `services/relay/src/index.ts`
- Modify: `services/relay/src/auth.ts`

- [ ] Add failing tests for valid own-desktop reconciliation, stale/duplicate deletion, activity-only updates, malformed/oversized payload rejection, owner-ID mismatch rejection, and inability to select another desktop subtree.
- [ ] Run `pnpm --dir services/relay test -- cloudTaskPublication.test.ts` and confirm the missing handler failure.
- [ ] Implement strict bounded parsing and chunked Firebase Admin writes under `users/{authenticatedUid}/desktops/{authenticatedDesktopId}`.
- [ ] Retain auth proof per socket, revalidate it before each publication, acknowledge writes, and close revoked/reassigned connections.
- [ ] Run all relay tests and confirm they pass.

### Task 4: Renderer credential-only association

**Files:**
- Create: `apps/desktop/src/services/desktopCloudAssociation.ts`
- Create: `apps/desktop/src/services/desktopCloudAssociation.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.test.ts`
- Delete: `apps/desktop/src/services/desktopCloudPublisher.ts`
- Delete: `apps/desktop/src/services/desktopCloudPublisher.test.ts`

- [ ] Add failing tests for credential association writing only profile/desktop fields and never a task subcollection, including idempotent calls from two windows.
- [ ] Add App/architecture tests proving sign-in performs association/read subscription without task reconciliation and works when `navigator.locks` is absent.
- [ ] Run the focused desktop tests and confirm failures against current renderer publication.
- [ ] Extract credential bootstrap, remove sign-in/change watcher task publication and remote task metadata deletion, and delete the direct task publisher.
- [ ] Run focused desktop tests and confirm they pass.

### Task 5: Remove store publication escape paths

**Files:**
- Modify: `apps/desktop/src/stores/taskItemActions.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Delete: `apps/desktop/src/stores/taskPublishing.ts`
- Create: `apps/desktop/src/services/cloudPublicationArchitecture.test.ts`

- [ ] Add a failing static architecture test that rejects renderer imports/calls of task Firestore publication and any `navigator.locks` dependency.
- [ ] Run it and confirm it finds the existing task-creation/store paths.
- [ ] Remove direct task publication/toasts/E2E hooks while leaving local server mutations and LAN transfer refresh intact.
- [ ] Run store and architecture tests and confirm they pass.

### Task 6: Emulator-backed server-to-mobile integration

**Files:**
- Modify: `services/relay/test/integration.test.ts`
- Modify: `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts` or create a focused cross-stack test beside it

- [ ] Add a failing harness test that authenticates a real `kanna-server`, observes its initial task in Firestore through the mobile index contract, applies a runtime `working` transition through the server API, and waits for the Firestore activity update.
- [ ] Run the emulator-backed target and confirm publication is absent before implementation.
- [ ] Add only the harness wiring required to launch the actual server/relay against emulator credentials and read the nested task collection.
- [ ] Run the target and confirm the activity transition is visible.

### Task 7: Verification

**Files:**
- Modify only files required by discovered regressions, with a failing regression test first.

- [ ] Run focused desktop tests.
- [ ] Run `pnpm --dir services/relay test`.
- [ ] Run `cargo test -p kanna-server`.
- [ ] Run `pnpm test`.
- [ ] Run `cd crates/daemon && cargo test -- --test-threads=1`.
- [ ] Run the emulator-backed integration target and record any environment-only limitation accurately.
