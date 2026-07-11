# Mobile Cloud Created-Task Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every cloud-indexed create and task-action result its canonical mobile identity before Firestore publication, while retaining the desktop-local route needed by LAN and relay calls.

**Architecture:** Use the shared task identity helper at the Firestore, relay, and hybrid cloud/LAN boundaries. `remoteTransport` owns relay route normalization and authoritative cloud-route replacement. `cloudLanClient` owns merged snapshot epochs, provisional LAN route projection, and accepted-snapshot replacement. `appModel` composes those clients and republishes Firestore callbacks through the complete source. `mobileController` consumes canonical responses and exact action-result summaries without weakening strict removal reconciliation.

**Tech Stack:** TypeScript, Vitest, React Native mobile state/controller, Firebase task index, Kanna relay and trusted-LAN transports.

---

## File Structure

- Create `apps/mobile/src/lib/api/taskIdentity.ts`: shared deterministic cloud id builder and action-response canonicalizer.
- Modify `apps/mobile/src/lib/api/types.ts`: allow canonical create/action responses to carry client-resolved owner/local route metadata and a new action response to carry its exact resolved `TaskSummary`.
- Modify `apps/mobile/src/lib/firebase/taskIndex.ts`: use the shared fallback builder while preserving an explicit Firestore `cloudTaskId` and exact owner-local repo id.
- Modify `apps/mobile/src/lib/transports/remoteTransport.ts`: normalize cloud-indexed create/action responses, cache local routes, and replace provisional routes during accepted cloud reads.
- Modify `apps/mobile/src/lib/sources/cloudLanClient.ts`: normalize LAN create/action responses, project provisional identities over raw LAN rows, reject stale reads, and replace provisional routes during accepted merged snapshots.
- Modify `apps/mobile/src/state/mobileController.ts`: retain canonical create/action state and consume exact action metadata without adding a grace period to reconciliation.
- Modify `apps/mobile/src/appModel.ts`: keep signed-in Firestore subscription active in default production composition and publish updates through the composed source.
- Modify focused transport, source, controller, and app-model tests.

### Task 1: Capture canonical create/action regressions

**Files:**

- Modify `apps/mobile/src/lib/transports/remoteTransport.test.ts`
- Modify `apps/mobile/src/lib/sources/cloudLanClient.test.ts`
- Modify `apps/mobile/src/state/mobileController.test.ts`
- Modify `apps/mobile/src/appModel.cloudFallback.test.ts`

- [ ] **Step 1: Add relay transport regressions**

Cover a cloud-indexed create returning `cloud:<desktop>:<local-repo>:<local-task>` while terminal and agent observers receive `{ desktopId, taskId: <local-task> }`. Cover advance returning the source local id and preserving the caller's canonical id. Cover merge returning a new local id, producing a new canonical id and an immediately reusable route.

- [ ] **Step 2: Add hybrid source regressions**

Start from an accepted cloud/LAN snapshot, execute LAN create and merge/advance, and assert the response ids are canonical from birth. Refresh with a raw LAN collection before Firestore publication and assert that the provisional canonical id is projected over the local row. Make an action result's `agentType` differ from its source and assert the exact result metadata is returned.

- [ ] **Step 3: Add controller regression**

Return a canonical `TaskActionResponse` with an exact `task` summary and prove the controller opens that task's own terminal or agent stream before publication. Retain the existing regression that a genuinely removed selected task closes its session.

- [ ] **Step 4: Add production-composition integration**

Create `createAppModel` signed in with `forceCloud: false`, a trusted Bonjour/LAN peer, and an initially empty captured `subscribeRecentTasks` stream. Drive `controller.createTask()`, publish the canonical Firestore snapshot, and assert:

- `selectedTaskId` and `taskTerminalTaskId` remain canonical.
- `activeView` remains `"tasks"`.
- The terminal subscription is not closed.
- LAN create and terminal attach calls use the desktop-local task id.

Add a composed action-to-live-update case for a newly created merge task, including its actual session type. Keep a relay-only composition case to cover the same boundary without LAN.

- [ ] **Step 5: Run the regressions and confirm they fail for the original behavior**

```bash
pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts src/lib/transports/remoteTransport.test.ts src/state/mobileController.test.ts src/appModel.cloudFallback.test.ts
```

Expected before implementation: local response ids reach controller state and publication causes false removal or session replacement.

### Task 2: Share canonical identity construction

**Files:**

- Create `apps/mobile/src/lib/api/taskIdentity.ts`
- Modify `apps/mobile/src/lib/firebase/taskIndex.ts`
- Modify `apps/mobile/src/lib/firebase/taskIndex.test.ts`

- [ ] **Step 1: Implement `buildCloudTaskId`**

Build the deterministic fallback from `ownerDesktopId`, owner-local repo id, and owner-local task id:

```ts
buildCloudTaskId({
  ownerDesktopId,
  localRepoId,
  ownerLocalTaskId
})
```

The result is `cloud:<desktop>:<local-repo>:<local-task>`.

- [ ] **Step 2: Implement `canonicalizeTaskActionId`**

When the action response local id equals the source local id, return the caller's existing canonical id. Otherwise build the new task's deterministic canonical id from the executing owner and local repo.

- [ ] **Step 3: Use the helper in Firestore mapping**

Keep `snapshot.cloudTaskId` unchanged when it exists. Use `buildCloudTaskId` only for the fallback. Preserve `ownerLocalRepoId` so action normalization and publication matching use the desktop-local repo rather than the visible cloud repo id.

### Task 3: Normalize and cache relay routes

**Files:**

- Modify `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify `apps/mobile/src/lib/transports/remoteTransport.test.ts`

- [ ] **Step 1: Normalize cloud-indexed create**

After the resolved owner desktop returns a successful create, retain the raw task id only in a provisional route:

```ts
canonicalId -> {
  desktopId,
  repoId: visibleRepoId,
  localRepoId: response.repoId,
  taskId: response.taskId
}
```

Return the response with `taskId: canonicalId`. If `listCloudTasks` is not configured, preserve the existing local-id behavior.

Resolve the selected visible repo to its owner-local repo at the same time as the owner desktop. Rewrite only the desktop wire request's `repoId`; keep the visible repo id in the response and controller state. If an explicit desktop has no known mapping, preserve the existing same-id fallback.

- [ ] **Step 2: Normalize every routed action response**

Invoke merge/advance with the source route's local id. If the response local id matches the source local id, return the caller's canonical id. If it is new, build and cache a new canonical route, then return that canonical id. Do not return the server's raw response id to mobile state.

Spread the original response so control fields such as `followTask` survive normalization.

- [ ] **Step 3: Attach exact new-task metadata**

For a new action task, best-effort read `/v1/tasks/recent` on the same desktop and match both local task and local repo. Attach the actual summary with canonical id and visible repo id. On a miss, omit `task`; never infer title, stage, or `agentType` from the source.

- [ ] **Step 4: Replace routes on accepted publication**

Give cloud reads monotonically increasing epochs. Only the latest accepted read replaces `cloudTaskRoutes`. At replacement time, remove provisional entries whose canonical id or `{ desktopId, localTaskId }` route identity appears in the authoritative collection. Successful close removes the matching provisional route immediately.

Cleanup occurs at accepted cloud publication/read replacement. It is not deferred to a later terminal, action, or other task-scoped lookup.

### Task 4: Normalize and project trusted-LAN routes

**Files:**

- Modify `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify `apps/mobile/src/lib/sources/cloudLanClient.test.ts`

- [ ] **Step 1: Canonicalize successful LAN create**

Validate the actual LAN endpoint's desktop id. Resolve the selected visible repo to that desktop's local repo and rewrite only the LAN wire request. Build the canonical response id from that desktop and the returned local repo/task ids. Cache the canonical id as a provisional LAN route containing the visible and local repo ids. Signed-out/direct LAN clients remain local-id based because they are not wrapped by the cloud-indexed composition.

- [ ] **Step 2: Canonicalize LAN task actions**

Translate the source canonical id to its LAN-local route. Preserve the source canonical id for same-task responses; for a new local id, build the new canonical id, pin it to the executing desktop, and best-effort attach its exact recent-task summary.

- [ ] **Step 3: Project provisional identity into collections**

When a merged collection contains the matching raw LAN row but no cloud-backed publication, replace that row's display id and repo id with the provisional canonical values. This keeps ordinary polling and empty/partial Firestore callbacks from replacing the selected canonical task with a raw id.

- [ ] **Step 4: Reject stale merged reads**

Assign every task collection read an epoch. An older delayed cloud or LAN result must return the last accepted snapshot rather than overwrite a newer publication. Supplement callbacks use the same accepted-snapshot gate.

- [ ] **Step 5: Replace provisional routes on publication**

When an accepted merged snapshot contains a cloud-backed task matching owner desktop, owner-local task, and known owner-local repo, remove the provisional entry and retain the snapshot route. That route may continue to prefer LAN while reachable and may carry a cloud fallback; cleanup does not force relay routing. Successful LAN close removes matching provisional entries immediately.

There is no TTL, timer, or client-local route-release hook. Without an accepted publication or successful close, the provisional route remains in memory until the app client is replaced or disposed.

### Task 5: Compose live updates and preserve controller state

**Files:**

- Modify `apps/mobile/src/appModel.ts`
- Modify `apps/mobile/src/state/mobileController.ts`
- Modify `apps/mobile/src/appModel.cloudFallback.test.ts`
- Modify `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Republish Firestore updates through the composed source**

For a signed-in user, keep the Firestore subscription active even when `forceCloud` is false and trusted LAN is available. Capture each Firestore update, then refresh and publish the complete `cloudLanClient` snapshot. Do not apply the raw cloud array directly as the authoritative collection in hybrid mode.

- [ ] **Step 2: Preserve canonical create state**

Insert the successful create summary under the response's already-canonical id, remember owner/local identity for authoritative matching, and open that id. Empty or partial callbacks then retain the same selected id through provisional projection.

- [ ] **Step 3: Preserve canonical action state**

After merge/advance, refresh collections and resolve the returned canonical id. If `TaskActionResponse.task` is present and publication has not supplied a different authoritative display id, insert that exact summary and open its corresponding terminal or agent stream. Do not fabricate fallback session metadata.

If the best-effort exact-summary lookup misses and collections do not yet contain the result, keep its canonical selection pending but clear the source task's stale session. Open the result stream only after authoritative metadata identifies its session type.

- [ ] **Step 4: Preserve strict reconciliation**

Use pending owner/local identity only when the client response contains the complete resolved route, and only to match a provisional response to its authoritative published task, including an explicit Firestore `cloudTaskId` that differs from the deterministic fallback. Retag a same-route active session to the explicit id without closing its subscription or clearing buffered state. Once resolved, remove pending controller metadata. Raw direct/local tasks and tasks with no provisional identity continue through the existing strict close-and-clear path when absent.

### Task 6: Verify compatibility and repository health

- [ ] **Step 1: Run focused mobile tests**

```bash
pnpm --dir apps/mobile test -- src/lib/sources/cloudLanClient.test.ts src/lib/transports/remoteTransport.test.ts src/lib/firebase/taskIndex.test.ts src/state/mobileController.test.ts src/appModel.cloudFallback.test.ts
```

- [ ] **Step 2: Run mobile type checking and full mobile suite**

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
```

- [ ] **Step 3: Run repository and daemon verification**

```bash
pnpm test
cd crates/daemon && cargo test -- --test-threads=1
```

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check
git status --short
git diff -- apps/mobile/src docs/superpowers/specs/2026-07-11-mobile-cloud-created-task-identity-design.md docs/superpowers/plans/2026-07-11-mobile-cloud-created-task-identity.md
```

Expected: no whitespace errors, canonical action response ids at every cloud-indexed boundary, and publication cleanup documented at accepted snapshot replacement.
