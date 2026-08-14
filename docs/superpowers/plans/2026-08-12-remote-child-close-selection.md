# Remote Child Close Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make closing a selected remote child task choose the same sibling-or-parent replacement that closing a local child chooses.

**Architecture:** Define the sibling-or-parent replacement rule once in `sidebarOrdering.ts` and use it from both the durable local selection store and slot-aware remote navigation. Remote close prepares the replacement synchronously before awaiting its owner, then applies that captured choice only if the closing row is still selected. This preserves the removed row's sibling position across authoritative refreshes and preserves newer user navigation.

**Tech Stack:** Vue 3 composition API, TypeScript, Vitest, desktop WebDriver mock E2E.

---

### Task 1: Route remote close through sidebar replacement navigation

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`
- Test: `apps/desktop/tests/e2e/mock/remote-task-close-selection.test.ts`

- [x] **Step 1: Add a failing App regression test**

Add an App test that projects a remote parent with two remote children, selects the first child, closes it, and asserts the second child becomes selected. Close the remaining child and assert the parent becomes selected. Include an unrelated local task so selecting the first local row cannot satisfy the assertions.

The core assertions must be:

```ts
expect(selectedTaskId()).toBe("cloud:repo-remote:task-child-b");
expect(store.selectedItemId).toBe(slotIdFor("cloud:repo-remote:task-child-b"));

await capturedKeyboardActions?.closeTask();
await flushPromises();

expect(selectedTaskId()).toBe("cloud:repo-remote:task-parent");
expect(store.selectedItemId).toBe(slotIdFor("cloud:repo-remote:task-parent"));
```

- [x] **Step 2: Run the App regression test and verify RED**

Run:

```bash
pnpm --filter @kanna/desktop exec vitest run src/App.test.ts --maxWorkers=2
```

Expected: the new test fails because remote close clears `store.selectedItemId` instead of selecting the sibling or parent.

- [x] **Step 3: Add a shared sibling-or-parent replacement rule**

In `sidebarOrdering.ts`, add durable and slot-aware adapters over one replacement algorithm. A removed child selects the sibling at its old position, clamps to the previous sibling at the end, and falls back to its visible parent when it was the final child. A removed top-level item selects only another top-level peer. Route both `stores/selection.ts` and `useAppTaskNavigation.ts` through this rule.

- [x] **Step 4: Prepare remote-close reselection before the owner await**

Change `closeSelectedWorkspaceTask` to receive a preparer callback. Capture the selected projected row and prepare its ordered sibling/parent fallback chain before creating the client or awaiting the remote owner. After `client.closeTask` succeeds, compare the current presentation slot with the captured slot and apply the first still-present prepared candidate only if the closing row remains selected. Always mark the successfully closed task locally closed even if selection persistence fails; treat persistence errors as post-close reconciliation errors rather than reporting that the owner-side close failed.

In `App.vue`, rename the raw cloud-workspace close binding and expose a no-argument wrapper after `useAppTaskNavigation` is created:

```ts
function closeSelectedWorkspaceTask(): Promise<boolean> {
  return closeSelectedWorkspaceTaskRaw(
    appTaskNavigation.prepareReplacementAfterItemRemoval,
  );
}
```

Continue passing this wrapper to keyboard actions and the main-panel close event.

- [x] **Step 5: Cover async close races and verify GREEN**

Run:

```bash
pnpm --filter @kanna/desktop exec vitest run src/App.test.ts --maxWorkers=2
```

Add regressions for newer navigation during a deferred close, authoritative removal of the middle child before the owner resolves, disappearance of its initially prepared next sibling, restored durable-id selection (including no replacement), and persistence failure. Expected: all `App.test.ts` tests pass.

- [x] **Step 6: Add mock desktop E2E coverage**

Create `apps/desktop/tests/e2e/mock/remote-task-close-selection.test.ts`. Inject a frozen LAN snapshot through `__e2eInjectRemoteSnapshot` containing a parent and two ordered children. Click the first child, trigger the close shortcut, and assert:

```ts
expect(selectedTaskIdAfterFirstClose).toBe(ids.childB);
expect(closeTransferInvokesAfterFirstClose).toContainEqual(expect.objectContaining({
  cmd: "close_transfer_peer_task",
  args: { peerId: "peer-owner", taskId: "task-child-a" },
}));
```

Then close the second child and assert the selected sidebar row has the parent's durable presentation id. Add a one-shot command-scoped success interceptor to the existing E2E invoke history so this test traverses the real LAN client command boundary without contacting a peer.

- [x] **Step 7: Run focused and static verification**

Run:

```bash
pnpm --filter @kanna/desktop exec vitest run src/App.test.ts --maxWorkers=2
pnpm --filter @kanna/desktop test:e2e -- mock/remote-task-close-selection.test.ts
pnpm exec tsc --noEmit
```

Expected: all commands exit zero with no TypeScript errors.

- [x] **Step 8: Review the diff for scope and selection races**

Confirm the diff changes only remote close replacement behavior and its tests; verify that a user navigation made while the remote close request is pending is preserved by the captured-slot equality guard.
