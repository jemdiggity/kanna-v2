# Remote Blocked Task UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote blocked tasks appear and behave like local blocked tasks, including sidebar placement, blocker details, terminal suppression, stage-action guarding, and visible relay errors.

**Architecture:** Preserve owner blocker IDs in each remote snapshot and workspace source, then project them into presentation-only `TaskBlocker` edges after workspace/sidebar identity deduplication. Merge those edges with local store blocker state only at the App/UI boundary; keep Pinia and SQLite local-authoritative. Validate cloud relay response status independently so stale snapshots still produce an actionable error.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia, Vitest, Vue Test Utils, Firebase task snapshots, Kanna stream client

---

### Task 1: Preserve blocker metadata through remote snapshot mapping

**Files:**
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.test.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write the failing cloud snapshot mapping test**

Add an assertion to `desktopCloudTaskIndex.test.ts` proving the owner-local IDs survive
under the mapped presentation task ID:

```ts
it("preserves blocker task ids for workspace projection", () => {
  const snapshot = mapDesktopCloudTasks([
    remoteTaskSnapshot({
      cloudTaskId: "remote-repo-id:task-blocked",
      ownerLocalTaskId: "task-blocked",
      blockedByTaskIds: ["task-one", "task-two", "task-one"],
    }),
  ]);

  expect(snapshot.blockedByTaskIds).toEqual({
    "cloud:remote-repo-id:task-blocked": ["task-one", "task-two"],
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/services/desktopCloudTaskIndex.test.ts
```

Expected: FAIL because `DesktopCloudTaskSnapshot` and `DesktopCloudSnapshot` do not yet
carry `blockedByTaskIds`.

- [ ] **Step 3: Add snapshot types and mapping**

In `desktopCloudTaskIndex.ts`, add `blockedByTaskIds?: string[];` to
`DesktopCloudTaskSnapshot`, then replace the mapped snapshot declaration with:

```ts
export interface DesktopCloudSnapshot {
  repos: DesktopCloudRepo[];
  items: PipelineItem[];
  terminalRefs: Record<string, DesktopCloudTerminalRef>;
  blockedByTaskIds: Record<string, string[]>;
}
```

Inside `mapDesktopCloudTasks`:

```ts
const blockedByTaskIds: Record<string, string[]> = {};

// after itemId is calculated
const uniqueBlockerIds = [...new Set(
  (snapshot.blockedByTaskIds ?? []).filter((id) => id.trim().length > 0),
)];
if (uniqueBlockerIds.length > 0) {
  blockedByTaskIds[itemId] = uniqueBlockerIds;
}

return {
  repos: [...reposById.values()],
  items,
  terminalRefs,
  blockedByTaskIds,
};
```

Update every empty `DesktopCloudSnapshot` literal in `desktopCloudTaskIndex.ts`,
`useAppCloudWorkspace.ts`, `useAppTaskCreation.test.ts`, `buildWorkspace.test.ts`, and
`App.test.ts` to include:

```ts
blockedByTaskIds: {},
```

When `useAppCloudWorkspace` merges or filters snapshots, retain only metadata for retained
items:

```ts
const retainedItems = snapshot.items.filter((item) =>
  !remoteTaskIsLocallyClosed(item, snapshot.terminalRefs[item.id], closedIds),
);
const retainedTaskIds = new Set(retainedItems.map((item) => item.id));

blockedByTaskIds: Object.fromEntries(
  Object.entries(snapshot.blockedByTaskIds).filter(([taskId]) =>
    retainedTaskIds.has(taskId),
  ),
),
```

- [ ] **Step 4: Run mapping tests and typecheck the touched surface**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/services/desktopCloudTaskIndex.test.ts src/composables/useAppTaskCreation.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: all selected tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit snapshot preservation**

```bash
git add apps/desktop/src/services/desktopCloudTaskIndex.ts \
  apps/desktop/src/services/desktopCloudTaskIndex.test.ts \
  apps/desktop/src/composables/useAppCloudWorkspace.ts \
  apps/desktop/src/composables/useAppTaskCreation.test.ts \
  apps/desktop/src/workspace/buildWorkspace.test.ts \
  apps/desktop/src/App.test.ts
git commit -m "feat: preserve remote task blocker metadata"
```

### Task 2: Normalize remote blocker state in the unified workspace

**Files:**
- Modify: `apps/desktop/src/workspace/types.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.test.ts`

- [ ] **Step 1: Write failing workspace merge tests**

Add a test that supplies the same owner blocker through equally fresh cloud and LAN
snapshots and expects one normalized owner-local ID:

```ts
it("deduplicates remote blocker ids across cloud and LAN sources", () => {
  const cloud = remoteSnapshot("cloud", "cloud:repo:blocked", "blocked-owner");
  cloud.blockedByTaskIds = {
    "cloud:repo:blocked": ["blocker-owner", "blocker-owner"],
  };
  const lan = remoteSnapshot("lan", "cloud:repo:blocked", "blocked-owner");
  lan.blockedByTaskIds = {
    "cloud:repo:blocked": ["blocker-owner"],
  };

  const result = buildWorkspace({
    localRepos: [],
    localItems: [],
    cloudSnapshot: cloud,
    lanSnapshot: lan,
  });

  expect(result.tasks[0].blockedByTaskIds).toEqual(["blocker-owner"]);
  expect(result.tasks[0].sources.map((source) => source.blockedByTaskIds))
    .toEqual([["blocker-owner"], ["blocker-owner"]]);
});
```

Add a second case proving the freshest source clears a stale blocker:

```ts
expect(taskWithNewerClear.blockedByTaskIds).toEqual([]);
```

Add a third case proving a matching local task ignores replicated blocker metadata:

```ts
expect(localOwnedTask.blockedByTaskIds).toEqual([]);
```

- [ ] **Step 2: Run workspace tests to verify they fail**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/buildWorkspace.test.ts
```

Expected: FAIL because workspace sources/tasks do not expose blocker IDs.

- [ ] **Step 3: Carry blocker IDs on sources and tasks**

Extend `workspace/types.ts`:

```ts
export interface WorkspaceTaskSource {
  kind: WorkspaceSourceKind;
  taskId: string;
  repoId: string;
  updatedAt: string;
  terminalRef?: DesktopCloudTerminalRef;
  blockedByTaskIds: string[];
}
```

Add `blockedByTaskIds: string[];` to the existing `WorkspaceTask` interface.

In `buildWorkspace.ts`, pass the full mapped snapshot to `remoteCandidates`, read
`snapshot.blockedByTaskIds[item.id] ?? []`, and initialize local sources with an empty
array. Add a freshness-aware helper:

```ts
function blockedByTaskIdsForSources(sources: readonly WorkspaceTaskSource[]): string[] {
  if (sources.some((source) => source.kind === "local")) return [];
  const newestUpdatedAt = sources.reduce(
    (newest, source) => source.updatedAt > newest ? source.updatedAt : newest,
    "",
  );
  return [...new Set(
    sources
      .filter((source) => source.updatedAt === newestUpdatedAt)
      .flatMap((source) => source.blockedByTaskIds),
  )];
}
```

Set `blockedByTaskIds` from this helper in both `createWorkspaceTask` and
`mergeWorkspaceTask`, using the complete source array in each case.

Update workspace test factories so every source includes:

```ts
blockedByTaskIds: [],
```

- [ ] **Step 4: Run workspace tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/buildWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit workspace normalization**

```bash
git add apps/desktop/src/workspace/types.ts \
  apps/desktop/src/workspace/buildWorkspace.ts \
  apps/desktop/src/workspace/buildWorkspace.test.ts \
  apps/desktop/src/workspace/projectWorkspaceTasksForSidebar.test.ts
git commit -m "feat: normalize remote blockers in workspace"
```

### Task 3: Project owner blocker IDs into sidebar identities and display details

**Files:**
- Create: `apps/desktop/src/workspace/projectWorkspaceBlockers.ts`
- Create: `apps/desktop/src/workspace/projectWorkspaceBlockers.test.ts`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`

- [ ] **Step 1: Write failing projection tests**

Create `projectWorkspaceBlockers.test.ts` with focused fixtures and these expectations:

```ts
const result = projectWorkspaceBlockers({
  workspaceTasks: [blockedTask, blockerTask],
  sidebarItems,
  workspaceTasksByItemId,
});

expect(result.taskBlockers).toEqual([{
  blocked_item_id: blockedSidebarItem.task_id,
  blocker_item_id: blockerSidebarItem.task_id,
}]);
expect(result.blockerNames[blockedSidebarItem.task_id!]).toBe("Build dependency");
expect(result.blockersByLogicalTaskKey[blockedTask.logicalTaskKey]?.[0].id)
  .toBe(blockerSidebarItem.task_id);
```

Add cases proving:

```ts
expect(unresolved.blockerNames[blockedSidebarItem.task_id!]).toBe("Task 3c45beea");
expect(unresolved.taskBlockers).toHaveLength(1);
expect(localOwnedResult.taskBlockers).toEqual([]);
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/projectWorkspaceBlockers.test.ts
```

Expected: FAIL because the projection module has not been created.

- [ ] **Step 3: Add the focused projection module**

Add the display type to `types/kanna.ts`:

```ts
export type BlockerDisplayItem = Pick<
  PipelineItem,
  "id" | "display_name" | "prompt" | "closed_at" | "stage" | "pr_url"
>;
```

Implement the module with this public contract:

```ts
export interface WorkspaceBlockerProjection {
  taskBlockers: TaskBlocker[];
  blockerTaskStates: BlockerTaskStates;
  blockerNames: Record<string, string>;
  blockersByLogicalTaskKey: Record<string, BlockerDisplayItem[]>;
}

export function projectWorkspaceBlockers(input: {
  workspaceTasks: readonly WorkspaceTask[];
  sidebarItems: readonly SidebarTaskItem[];
  workspaceTasksByItemId: ReadonlyMap<string, WorkspaceTask>;
}): WorkspaceBlockerProjection
```

Build an inverse `sidebarItemByLogicalTaskKey` from `workspaceTasksByItemId`, then an
owner-task lookup from `source.terminalRef?.ownerLocalTaskId` and each task's logical
owner ID. For each remote-owned blocked task, deduplicate `blockedByTaskIds`, resolve its
blocker when present, and emit:

```ts
const blockerDisplay: BlockerDisplayItem = resolved
  ? {
      id: blockerSidebarItem?.task_id ?? resolved.item.id,
      display_name: resolved.item.display_name,
      prompt: resolved.item.prompt,
      closed_at: resolved.item.closed_at,
      stage: resolved.item.stage,
      pr_url: resolved.item.pr_url,
    }
  : {
      id: ownerBlockerId,
      display_name: `Task ${ownerBlockerId.slice(0, 8)}`,
      prompt: null,
      closed_at: null,
      stage: "in progress",
      pr_url: null,
    };
```

Do not emit remote edges for local-owned workspace tasks.

- [ ] **Step 4: Expose the projection from the cloud workspace composable**

In `useAppCloudWorkspace.ts`, calculate after `workspaceSidebarProjection`:

```ts
const workspaceBlockers = computed(() => projectWorkspaceBlockers({
  workspaceTasks: workspace.value.tasks,
  sidebarItems: workspaceSidebarProjection.value.sidebarItems,
  workspaceTasksByItemId: workspaceSidebarProjection.value.workspaceTasksByItemId,
}));

const selectedRemoteBlockers = computed(() => {
  const task = selectedWorkspaceTask.value;
  if (!task || task.owner.kind === "local") return [];
  return workspaceBlockers.value.blockersByLogicalTaskKey[task.logicalTaskKey] ?? [];
});

const selectedRemoteTaskIsBlocked = computed(
  () => selectedRemoteBlockers.value.length > 0,
);
```

Return all three values from the composable.

- [ ] **Step 5: Run projection and workspace tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/workspace/projectWorkspaceBlockers.test.ts \
  src/workspace/projectWorkspaceTasksForSidebar.test.ts \
  src/workspace/buildWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit blocker projection**

```bash
git add apps/desktop/src/types/kanna.ts \
  apps/desktop/src/workspace/projectWorkspaceBlockers.ts \
  apps/desktop/src/workspace/projectWorkspaceBlockers.test.ts \
  apps/desktop/src/composables/useAppCloudWorkspace.ts
git commit -m "feat: project remote blockers for workspace UI"
```

### Task 4: Merge local and remote blockers at the UI boundary

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/__tests__/Sidebar.test.ts`
- Modify: `apps/desktop/src/components/__tests__/MainPanel.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.test.ts`

- [ ] **Step 1: Write failing sidebar and main-panel tests**

In `Sidebar.test.ts`, mount two remote rows with explicit remote blocker props:

```ts
const wrapper = mountSidebar([blocked, blocker], null, {
  taskBlockers: [{
    blocked_item_id: blocked.task_id!,
    blocker_item_id: blocker.task_id!,
  }],
  blockerTaskStates: {
    [blocker.task_id!]: {
      closed_at: null,
      stage: "in progress",
      pr_url: null,
    },
  },
  blockerNames: {
    [blocked.task_id!]: "Build dependency",
  },
});

expect(wrapper.find("[data-testid='blocked-section']").text()).toContain("Build dependency");
expect(wrapper.find("[data-testid='stage-in-progress']").text()).not.toContain(blocked.prompt);
```

In `MainPanel.test.ts`, verify remote terminal suppression and blocker detail rendering:

```ts
expect(wrapper.find(".blocked-placeholder").exists()).toBe(true);
expect(wrapper.text()).toContain("Build dependency");
expect(wrapper.find("[data-testid='cloud-terminal']").exists()).toBe(false);
```

- [ ] **Step 2: Write the failing keyboard stage guard test**

In `useAppKeyboardActions.test.ts`, add `selectedWorkspaceTaskBlocked` to the harness and
assert:

```ts
selectedWorkspaceTaskBlocked.value = true;
keyboardActions.advanceStage();

expect(advanceSelectedRemoteWorkspaceTask).not.toHaveBeenCalled();
expect(toast.warning).toHaveBeenCalledWith("mainPanel.taskBlocked");
```

- [ ] **Step 3: Run the three focused tests to verify failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/components/__tests__/Sidebar.test.ts \
  src/components/__tests__/MainPanel.test.ts \
  src/composables/useAppKeyboardActions.test.ts
```

Expected: FAIL because remote blocker props and the keyboard guard are not wired.

- [ ] **Step 4: Make Sidebar consume caller-projected blocker state**

Extend `Sidebar.vue` props:

```ts
taskBlockers?: readonly TaskBlocker[];
blockerTaskStates?: Readonly<BlockerTaskStates>;
```

Replace local-store blocker inputs in `sidebarOrderingOptions`:

```ts
blockers: props.taskBlockers ?? store.taskBlockers,
blockerTaskStates: props.blockerTaskStates ?? store.blockerTaskStates,
```

Keep the store as a compatibility fallback for direct component consumers.

- [ ] **Step 5: Merge blocker presentation in App**

In `App.vue`, compute:

```ts
const sidebarTaskBlockers = computed(() => [
  ...store.taskBlockers,
  ...workspaceBlockers.value.taskBlockers,
]);
const sidebarBlockerTaskStates = computed(() => ({
  ...store.blockerTaskStates,
  ...workspaceBlockers.value.blockerTaskStates,
}));
const mergedSidebarBlockerNames = computed(() => ({
  ...sidebarBlockerNames.value,
  ...workspaceBlockers.value.blockerNames,
}));
const mainPanelBlockers = computed(() =>
  mainPanelIsCloudTask.value ? selectedRemoteBlockers.value : currentBlockers.value,
);
const mainPanelTaskIsBlocked = computed(() =>
  mainPanelIsCloudTask.value
    ? selectedRemoteTaskIsBlocked.value
    : currentTaskIsBlocked.value,
);
```

Pass the merged blocker edges/states/names to `Sidebar`, and pass
`mainPanelBlockers`/`mainPanelTaskIsBlocked` to `MainPanel`.

Update `MainPanel.vue`'s blocker prop from `PipelineItem[]` to:

```ts
blockers?: BlockerDisplayItem[];
```

- [ ] **Step 6: Use merged blocker state for navigation and stage actions**

Add computed blocker edges/states to `UseAppTaskNavigationOptions` and use their values in
both `visibleSidebarItemsForRepo` and `isBlocked`, instead of reading only the local store.

Add to `UseAppKeyboardActionsOptions`:

```ts
selectedWorkspaceTaskBlocked: ComputedRef<boolean>;
```

Guard the remote action before checking capabilities:

```ts
if (workspaceTask && selectedWorkspaceTaskBlocked.value) {
  toast.warning(t("mainPanel.taskBlocked"));
  return;
}
```

Pass `selectedRemoteTaskIsBlocked` from `App.vue`.

- [ ] **Step 7: Run focused UI tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/components/__tests__/Sidebar.test.ts \
  src/components/__tests__/MainPanel.test.ts \
  src/composables/useAppKeyboardActions.test.ts \
  src/composables/useAppTaskNavigation.test.ts \
  src/App.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit UI parity**

```bash
git add apps/desktop/src/App.vue \
  apps/desktop/src/components/Sidebar.vue \
  apps/desktop/src/components/MainPanel.vue \
  apps/desktop/src/components/__tests__/Sidebar.test.ts \
  apps/desktop/src/components/__tests__/MainPanel.test.ts \
  apps/desktop/src/composables/useAppTaskNavigation.ts \
  apps/desktop/src/composables/useAppKeyboardActions.ts \
  apps/desktop/src/composables/useAppKeyboardActions.test.ts
git commit -m "feat: mirror blocked task UI for remote tasks"
```

### Task 5: Reject remote lifecycle HTTP errors

**Files:**
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.test.ts`

- [ ] **Step 1: Write the failing HTTP 409 test**

Add to `desktopRelayTerminal.test.ts`:

```ts
it("rejects a blocked owner response with its message", async () => {
  const socket = new FakeSocket();
  const client = createDesktopRelayTerminalClient({
    createSocket: () => socket,
    getIdToken: vi.fn(async () => "id-token"),
    relayUrl: "ws://relay.test",
  });
  const advance = client.advanceStage({
    desktopId: "desktop-owner",
    taskId: "task-blocked",
  });

  await openRelayTunnel(socket);
  socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
  await Promise.resolve();
  const request = socket.sent.map((entry) => JSON.parse(entry))
    .find((entry) => entry.path === "/v1/tasks/task-blocked/actions/advance-stage");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "response",
      id: request.id,
      status: 409,
      body: { error: "task is blocked: task-blocked" },
    }),
  });

  await expect(advance).rejects.toThrow("task is blocked: task-blocked");
});
```

- [ ] **Step 2: Run the relay test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/services/desktopRelayTerminal.test.ts
```

Expected: FAIL because non-2xx stream responses currently resolve.

- [ ] **Step 3: Add a shared response assertion**

In `desktopRelayTerminal.ts`, add:

```ts
function assertSuccessfulTaskAction(
  response: { status: number; body: unknown },
  action: string,
): void {
  if (response.status >= 200 && response.status < 300) return;
  const body = response.body;
  const message = typeof body === "string"
    ? body
    : body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Remote ${action} failed with HTTP ${response.status}`;
  throw new Error(message);
}
```

Use it for both cloud HTTP actions:

```ts
const response = await clientForDesktop(options.desktopId).request(
  "POST",
  `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/advance-stage`,
  null,
);
assertSuccessfulTaskAction(response, "stage advance");
```

Apply the same check to `closeTask` so both lifecycle actions have consistent transport
semantics. Do not change the legacy RPC path, which already rejects RPC errors.

- [ ] **Step 4: Run relay and cloud-workspace action tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/services/desktopRelayTerminal.test.ts \
  src/App.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit remote error propagation**

```bash
git add apps/desktop/src/services/desktopRelayTerminal.ts \
  apps/desktop/src/services/desktopRelayTerminal.test.ts
git commit -m "fix: surface remote task action failures"
```

### Task 6: Complete regression verification

**Files:**
- Verify: all files changed in Tasks 1–5

- [ ] **Step 1: Run formatting and whitespace checks**

Run:

```bash
git diff --check e71d3c16
```

Expected: no output.

- [ ] **Step 2: Run all focused remote-blocker tests together**

Run:

```bash
pnpm --dir apps/desktop exec vitest run \
  src/services/desktopCloudTaskIndex.test.ts \
  src/workspace/buildWorkspace.test.ts \
  src/workspace/projectWorkspaceTasksForSidebar.test.ts \
  src/workspace/projectWorkspaceBlockers.test.ts \
  src/components/__tests__/Sidebar.test.ts \
  src/components/__tests__/MainPanel.test.ts \
  src/composables/useAppKeyboardActions.test.ts \
  src/composables/useAppTaskNavigation.test.ts \
  src/services/desktopRelayTerminal.test.ts \
  src/App.test.ts
```

Expected: all selected test files PASS.

- [ ] **Step 3: Run desktop typecheck**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Run the canonical JavaScript test suite**

Run:

```bash
pnpm test
```

Expected: exit 0. If an unrelated pre-existing test fails, record the exact failing test
and confirm the focused remote-blocker suite still passes.

- [ ] **Step 5: Inspect the final diff and status**

Run:

```bash
git diff --stat e71d3c16
git status --short
```

Expected: only the implementation-plan file may remain uncommitted; source and test
changes are committed, with no unrelated files modified.
