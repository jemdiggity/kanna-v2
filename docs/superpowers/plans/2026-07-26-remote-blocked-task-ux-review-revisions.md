# Remote Blocked Task UX Review Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remote blocked-task review gaps with real rendered interaction coverage, bounded concurrent LAN control, validated relay mark-read errors, and end-to-end single-flight remote advancement.

**Architecture:** Keep presentation authority in the existing workspace projection, but exercise it through real Vue components. Move LAN request concurrency below the renderer by multiplexing the Tauri sidecar client and sidecar command loop, add a lower deadline and pending-request cleanup, and make polling single-flight. Key remote advances in both the viewer and owner, treating active/running-post duplicates as idempotent success.

**Tech Stack:** Vue 3, Vue Test Utils, Vitest, Tauri v2, Tokio, Axum, Rust integration tests.

## Global Constraints

- Work only in the current Kanna worktree and current branch.
- Preserve local task behavior and current remote terminal, read-dwell, and file-link behavior.
- Do not modify or close PR #921 and do not push this branch.
- Use `pnpm` for JavaScript package management and scripts.
- Release artifacts must remain vendored or statically linked.

---

### Task 1: Rendered Remote Blocked Journey And Relay Mark-Read Validation

**Files:**
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.test.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`

**Interfaces:**
- Consumes: `DesktopRelayTerminalClient.markTaskRead(options): Promise<void>`.
- Produces: real rendered App coverage and consistent non-2xx relay task-action errors.

- [ ] Add a Vitest journey mounting real `Sidebar` and `MainPanel`, with only terminal leaf components stubbed. Assert the task appears below the Blocked heading, the blocker panel replaces the terminal, Cmd+S does not invoke the owner, a stale-unblocked 409 becomes a toast, and a newer unblocked snapshot restores the remote terminal.
- [ ] Run the focused App test and verify it fails against the stub-only coverage seam.
- [ ] Add table-driven 404/409/500 mark-read response tests asserting owner bodies and fallback status messages.
- [ ] Run the relay test and verify it fails because `markTaskRead` resolves non-2xx responses.
- [ ] Capture the mark-read response and pass it to `assertSuccessfulTaskAction(response, "mark read")`.
- [ ] Run both focused tests and verify they pass.

### Task 2: Bounded, Multiplexed LAN Mark-Read

**Files:**
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Test: `crates/task-transfer/tests/runtime.rs` or a focused sidecar control integration test.

**Interfaces:**
- Consumes: newline-delimited sidecar control requests with unique `request_id`.
- Produces: concurrent sidecar requests, a lower mark-read deadline, cancellation-safe pending entries, and single-flight one-second LAN refresh.

- [ ] Add a stalled-peer regression that starts mark-read, then proves terminal control and snapshot refresh complete before the mark-read deadline and that the stalled connection/future is gone after timeout.
- [ ] Run it and verify it fails because the sidecar command loop serializes requests.
- [ ] Add a frontend fake-timer regression proving repeated LAN refresh ticks do not overlap or queue.
- [ ] Run it and verify overlapping calls occur.
- [ ] Store sidecar stdin behind its own async mutex, make request methods borrow `&self`, clone an `Arc<TransferSidecarClient>` out of `TransferServiceState`, and release the service-state mutex before awaiting a response.
- [ ] Make the sidecar stdin loop dispatch parsed requests concurrently while retaining serialized stdout writes.
- [ ] Bound mark-read below the renderer and remove the pending response entry whenever the waiting future is dropped or reaches its deadline.
- [ ] Track one active LAN refresh promise in the composable and skip interval ticks while it is active; disposal prevents late snapshots from committing.
- [ ] Run the stalled-peer, Tauri, and App focused tests and verify they pass.

### Task 3: Viewer And Owner Remote Advance Single-Flight

**Files:**
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.test.ts`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

**Interfaces:**
- Consumes: `PipelineItem.has_running_post` and remote owner/task identity.
- Produces: per-viewer owner/task request keys and owner-side task-scoped idempotency guards retained through detached execution.

- [ ] Add frontend tests for two immediate remote advances and for a `has_running_post` snapshot; assert only one/no owner requests respectively.
- [ ] Run them and verify duplicate requests currently occur.
- [ ] Add an owner HTTP regression issuing two immediate advances while the first transition is gated; assert one transition and two successful responses.
- [ ] Add an owner HTTP regression where the latest run is a running post; assert advance is a successful no-op and does not perform the historical override.
- [ ] Run them and verify the current handler prepares duplicate transitions.
- [ ] Add a viewer `Set` keyed by owner desktop and owner task, clear it in `finally`, and guard both the composable action and keyboard path with `has_running_post`.
- [ ] Add task-scoped owner advance guards to `AppState`, acquire before preparation, retain the guard in detached execution, and return the current task as an idempotent success when already active or already running a post.
- [ ] Run focused frontend and server tests and verify they pass.

### Task 4: Verification And Handoff

**Files:**
- Review all changed files against `origin/main`.

**Interfaces:**
- Produces: one committed, pipeline-ready replacement branch.

- [ ] Run focused desktop tests covering App, keyboard actions, relay/LAN clients, cloud task index, workspace construction, blocker projection, Sidebar, and MainPanel.
- [ ] Run focused Rust tests for task-transfer and Kanna server stage actions.
- [ ] Run the desktop typecheck/build command used by this repository.
- [ ] Run `pnpm test` and the canonical practical JavaScript verification required by the task.
- [ ] Inspect `git diff --check`, `git status`, and the complete `origin/main...HEAD` diff for scope and correctness.
- [ ] Commit all implementation, tests, and review documentation with a focused message.
- [ ] Record Kanna stage success with a summary that says the future PR supersedes #921 and lists conflict decisions plus exact verification evidence.
