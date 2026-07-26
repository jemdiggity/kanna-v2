# Remote Blocked Task UX Review Round 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all eight round-four review findings with regression coverage and preserve the existing remote-task and daemon behavior.

**Architecture:** Raw blocker metadata is localized only in Vue, observer and cache lifetimes use explicit leases, LAN snapshot failures are per-peer results, and PTY handoff quiesces old readers before its final snapshot with rollback on abort. Existing interval, workspace projection, and sidecar boundaries remain authoritative.

**Tech Stack:** Vue 3, TypeScript, Vitest, WebDriver, Rust/Tokio, serde, Node.js.

---

### Task 1: Localized blocker projection and WebDriver journey

**Files:**
- Modify: `apps/desktop/src/workspace/projectWorkspaceBlockers.ts`
- Modify: `apps/desktop/src/workspace/projectWorkspaceBlockers.test.ts`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Create: `apps/desktop/tests/e2e/mock/remote-blocked-task.test.ts`

- [ ] Add failing projection and component tests proving unresolved blockers expose a raw short task id and render `Task {id}`, `タスク {id}`, and `작업 {id}`, while empty resolved blockers use each locale's existing untitled label.
- [ ] Run the focused Vitest files and confirm the English literals in `projectWorkspaceBlockers.ts` make the new assertions fail.
- [ ] Add `fallback_task_id` metadata, derive Sidebar names in `App.vue` with `t("tasks.taskId", { id })`, and use the same locale-aware fallback in MainPanel.
- [ ] Add an E2E-only cloud snapshot injector that follows the production generation/ref update path.
- [ ] Add a WebDriver journey that injects a blocked remote task, verifies the Blocked section and panel, presses Cmd+S and sees no owner action, injects an unblocked snapshot, forces a non-success owner action, and verifies the error toast.
- [ ] Run the focused unit tests and the new mock E2E target.

### Task 2: Bounded daemon lag-recovery retry

**Files:**
- Modify: `crates/daemon/src/output.rs`

- [ ] Add a paused-time regression whose snapshot function fails persistently and assert one notification causes one attempt until the status interval advances.
- [ ] Run the focused daemon unit test and confirm it observes repeated immediate attempts.
- [ ] Remove failure-path self-notification and retain retry through the existing interval and later output/status paths.
- [ ] Re-run the daemon output tests.

### Task 3: kd cache reclamation

**Files:**
- Modify: `tools/kd/bin/kd-cache.mjs`
- Modify: `tools/kd/bin/kd-resolver.mjs`
- Modify: `tools/kd/tests/kd-cache.test.mjs`

- [ ] Add failing tests for age pruning, count pruning, byte pruning, live lease fencing, installation-lock fencing, current-identity fencing, stale lease cleanup, and oldest-first order.
- [ ] Run `pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1` and confirm the reclamation API is missing.
- [ ] Implement root-level lease/use markers, recursive byte accounting, injectable limits/time/process-liveness, and age-then-count/size pruning.
- [ ] Acquire the parent-shell lease in the resolver before returning the entrypoint and prune only after successful installation.
- [ ] Re-run the kd cache and resolver tests.

### Task 4: LAN observer ordering

**Files:**
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`

- [ ] Add failing frontend close/reopen tests proving old completions emit no events and old closes include a different lease from replacement observes.
- [ ] Add failing Rust ordering tests for unobserve-before-observe of one lease and old-unobserve-after-new-observe of a replacement lease.
- [ ] Carry `observer_lease_id` through every command layer and make runtime slots active/closed lease states.
- [ ] Gate frontend ready/error callbacks and map deletion by the current lease.
- [ ] Run frontend LAN terminal and task-transfer protocol/runtime tests.

### Task 5: Per-peer LAN snapshot capability failures

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `crates/task-transfer/tests/runtime.rs`

- [ ] Add a failing requester test with trusted v1 and v2 peers that expects the v2 snapshot plus a v1 upgrade/re-pair issue.
- [ ] Add a failing desktop mapping test proving a peer issue does not hide valid snapshots and reaches the warning callback.
- [ ] Return structured issues beside snapshots, converting every per-peer failure into an issue rather than aborting enumeration.
- [ ] Preserve the Tauri array response by appending issue envelopes, map only snapshot envelopes, and warn once per unique upgrade/re-pair issue in the composable.
- [ ] Run focused task-transfer and desktop LAN index tests.

### Task 6: Lossless daemon handoff and old-client errors

**Files:**
- Modify: `crates/daemon/src/session.rs`
- Modify: `crates/daemon/src/output.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/startup.rs`
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] Add a failing handoff integration test with a debug barrier that emits child PTY output after final snapshot capture but before ACK.
- [ ] Add a failing previous-schema decode test for every handoff-in-progress response path.
- [ ] Add quiesce request/ack/resume notifications to `StreamControl` and make `stream_output` pause without dropping its fd or input receiver.
- [ ] Quiesce readers before `handoff_parts`, resume on every pre-commit return, and stop quiesced readers only after ACK.
- [ ] Emit handoff-in-progress errors without the unnegotiated enum code and remove the new code from the shared vocabulary.
- [ ] Run daemon unit, reconnect, and handoff tests.

### Task 7: Full verification and handoff

**Files:**
- Review all modified files against `origin/main`

- [ ] Run all focused frontend, task-transfer, daemon, and kd tests.
- [ ] Run the desktop build/typecheck.
- [ ] Run `pnpm test`.
- [ ] Run the practical Rust verification required by the touched crates.
- [ ] Inspect `git diff --check`, the complete scope diff, and repository status.
- [ ] Commit the finished revision with a focused message.
- [ ] Record Kanna stage success with a summary that includes the replacement-PR wording and verification evidence.
