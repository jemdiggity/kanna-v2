# Stable Task Sidebar Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one stable sidebar slot selected and mounted while a newly created task progresses from UI-only draft to acknowledged durable task to hydrated `PipelineItem`.

**Architecture:** Durable snapshot items remain server-owned. A new local `TaskUiSlot` registry owns stable UI identity, with a nullable durable task ID and task payload. Workspace projection converts local slots and remote tasks into explicit `SidebarTaskItem` values; the sidebar keys by `slot_id`, while backend actions continue to use `task_id`.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, Vue Test Utils, existing Kanna snapshot/store and workspace projection layers.

**Stage constraint:** Do not create commits in this worktree. The Kanna pipeline performs committing after this manual stage advances. Each task ends with a diff/test checkpoint instead of a commit.

**Implementation note:** The completed implementation strengthens the sketches below with discriminated creating/ready slot types, one-authoritative-snapshot miss grace after acknowledgement, a stateful eagerly primed workspace projector that freezes repo membership during creation, and a two-gate browser lifecycle regression test.

---

## File Structure

- Create `apps/desktop/src/types/taskUi.ts` for the stable slot, draft, and sidebar presentation contracts.
- Create `apps/desktop/src/stores/taskUiSlots.ts` for pure slot creation, acknowledgement, reconciliation, lookup, removal, and sidebar projection helpers.
- Create `apps/desktop/src/stores/taskUiSlots.test.ts` for pure lifecycle coverage.
- Modify `apps/desktop/src/stores/state.ts` to hold local UI slots and expose slot-aware services.
- Modify `apps/desktop/src/stores/queries.ts` to reconcile every applied snapshot/overlay into existing slots.
- Modify `apps/desktop/src/stores/selection.ts` to track slot IDs in memory and derive durable IDs for persistence and events.
- Modify `apps/desktop/src/stores/kanna.ts` to wire and expose slot-aware state and selection.
- Modify `apps/desktop/src/stores/taskItemActions.ts` to create, acknowledge, hydrate, and fail one slot without a synthetic snapshot item.
- Delete `apps/desktop/src/stores/taskCreationPlaceholder.ts` and `apps/desktop/src/stores/taskCreationPlaceholder.test.ts` after their behavior is covered by slot tests.
- Modify `apps/desktop/src/utils/taskSearch.ts` and `apps/desktop/src/utils/sidebarOrdering.ts` so sidebar algorithms consume explicit presentation IDs.
- Modify `apps/desktop/src/composables/useAppCloudWorkspace.ts` to merge local slots with local/remote workspace tasks without duplication.
- Modify `apps/desktop/src/composables/useAppTaskNavigation.ts` to navigate/select slot IDs while resolving durable task actions.
- Modify `apps/desktop/src/components/Sidebar.vue` to key and select by `slot_id` and emit actions with `task_id`.
- Modify `apps/desktop/src/components/MainPanel.vue`, `apps/desktop/src/components/TaskHeader.vue`, and `apps/desktop/src/App.vue` to render a selected slot through setup and ready states.
- Modify focused store, utility, component, and app tests named below.

### Task 1: Define and test the stable slot lifecycle

**Files:**
- Create: `apps/desktop/src/types/taskUi.ts`
- Create: `apps/desktop/src/stores/taskUiSlots.ts`
- Test: `apps/desktop/src/stores/taskUiSlots.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Create `taskUiSlots.test.ts` with real slot helpers and no mocks:

```ts
import { describe, expect, it } from "vitest";
import type { PipelineItem } from "../types/kanna";
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
  reconcileTaskUiSlots,
  removeTaskUiSlot,
  taskUiSlotForSelection,
  taskUiSlotToSidebarItem,
} from "./taskUiSlots";

function task(id: string): PipelineItem {
  return {
    id,
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Ship stable slots",
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${id}`,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "working",
    activity_changed_at: "2026-07-11T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: "origin/main",
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function creatingSlot() {
  return buildCreatingTaskUiSlot({
    slotId: "create:slot-1",
    repoId: "repo-1",
    prompt: "Ship stable slots",
    displayName: null,
    pipelineName: "default",
    stage: "in progress",
    agentType: "pty",
    requestedAgentProviders: "claude",
    nowIso: "2026-07-11T00:00:00.000Z",
  });
}

describe("task UI slots", () => {
  it("acknowledges and hydrates one slot without changing its UI identity", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");
    const hydrated = reconcileTaskUiSlots(acknowledged, [task("durable-1")]);

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      slot_id: "create:slot-1",
      task_id: "durable-1",
      state: "ready",
      task: { id: "durable-1" },
    });
  });

  it("retains an acknowledged slot while a snapshot temporarily omits its task", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");
    expect(reconcileTaskUiSlots(acknowledged, [])).toEqual(acknowledged);
  });

  it("creates ready slots for durable tasks that did not originate in this UI", () => {
    const [slot] = reconcileTaskUiSlots([], [task("durable-1")]);
    expect(slot).toMatchObject({
      slot_id: "durable-1",
      task_id: "durable-1",
      state: "ready",
    });
  });

  it("resolves selection by stable slot ID or durable task ID", () => {
    const acknowledged = acknowledgeTaskUiSlot([creatingSlot()], "create:slot-1", "durable-1");
    expect(taskUiSlotForSelection(acknowledged, "create:slot-1")?.slot_id).toBe("create:slot-1");
    expect(taskUiSlotForSelection(acknowledged, "durable-1")?.slot_id).toBe("create:slot-1");
  });

  it("projects a creating slot without pretending it has a durable task ID", () => {
    expect(taskUiSlotToSidebarItem(creatingSlot())).toMatchObject({
      slot_id: "create:slot-1",
      task_id: null,
      state: "creating",
      prompt: "Ship stable slots",
    });
  });

  it("removes only the requested slot", () => {
    expect(removeTaskUiSlot([creatingSlot()], "create:slot-1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/taskUiSlots.test.ts
```

Expected: FAIL because `taskUiSlots.ts` does not exist.

- [ ] **Step 3: Add the UI contracts**

Create `types/taskUi.ts`:

```ts
import type { AgentProvider, PipelineItem } from "./kanna";
import type { AgentExecutionType } from "../stores/agentExecutionType";

export interface TaskUiDraft {
  repo_id: string;
  prompt: string;
  display_name: string | null;
  pipeline: string;
  stage: string;
  agent_type: AgentExecutionType;
  agent_provider: AgentProvider;
  created_at: string;
}

export interface TaskUiSlot {
  slot_id: string;
  task_id: string | null;
  state: "creating" | "ready";
  task: PipelineItem | null;
  draft: TaskUiDraft;
}

export interface SidebarTaskItem extends Omit<PipelineItem, "id"> {
  slot_id: string;
  task_id: string | null;
  state: "creating" | "ready";
  remote_task?: boolean;
}
```

- [ ] **Step 4: Implement the pure slot helpers**

Create `stores/taskUiSlots.ts` with these exported operations:

```ts
import type { AgentProvider, PipelineItem } from "../types/kanna";
import type { SidebarTaskItem, TaskUiSlot } from "../types/taskUi";
import { normalizeAgentProviderCandidates } from "./agent-provider";
import type { AgentExecutionType } from "./agentExecutionType";

interface BuildCreatingTaskUiSlotOptions {
  slotId: string;
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
  stage?: string;
  agentType: AgentExecutionType;
  requestedAgentProviders?: AgentProvider | AgentProvider[];
  nowIso?: string;
}

export function buildCreatingTaskUiSlot(options: BuildCreatingTaskUiSlotOptions): TaskUiSlot {
  const providers = normalizeAgentProviderCandidates(options.requestedAgentProviders);
  return {
    slot_id: options.slotId,
    task_id: null,
    state: "creating",
    task: null,
    draft: {
      repo_id: options.repoId,
      prompt: options.prompt,
      display_name: options.displayName ?? null,
      pipeline: options.pipelineName ?? "default",
      stage: options.stage ?? "in progress",
      agent_type: options.agentType,
      agent_provider: providers[0] ?? "claude",
      created_at: options.nowIso ?? new Date().toISOString(),
    },
  };
}

export function acknowledgeTaskUiSlot(
  slots: readonly TaskUiSlot[],
  slotId: string,
  taskId: string,
): TaskUiSlot[] {
  return slots.map((slot) => slot.slot_id === slotId ? { ...slot, task_id: taskId } : slot);
}

export function removeTaskUiSlot(slots: readonly TaskUiSlot[], slotId: string): TaskUiSlot[] {
  return slots.filter((slot) => slot.slot_id !== slotId);
}

export function taskUiSlotForSelection(
  slots: readonly TaskUiSlot[],
  selectionId: string | null | undefined,
): TaskUiSlot | null {
  if (!selectionId) return null;
  return slots.find((slot) => slot.slot_id === selectionId || slot.task_id === selectionId) ?? null;
}

export function reconcileTaskUiSlots(
  slots: readonly TaskUiSlot[],
  tasks: readonly PipelineItem[],
): TaskUiSlot[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const claimedTaskIds = new Set<string>();
  const reconciled: TaskUiSlot[] = [];

  for (const slot of slots) {
    const task = slot.task_id ? tasksById.get(slot.task_id) : undefined;
    if (task) {
      claimedTaskIds.add(task.id);
      reconciled.push({ ...slot, task_id: task.id, state: "ready", task });
    } else if (slot.state === "creating") {
      reconciled.push(slot);
    }
  }

  for (const task of tasks) {
    if (claimedTaskIds.has(task.id)) continue;
    reconciled.push({
      slot_id: task.id,
      task_id: task.id,
      state: "ready",
      task,
      draft: {
        repo_id: task.repo_id,
        prompt: task.prompt ?? "",
        display_name: task.display_name,
        pipeline: task.pipeline,
        stage: task.stage,
        agent_type: task.agent_type === "agent" ? "agent" : "pty",
        agent_provider: task.agent_provider,
        created_at: task.created_at,
      },
    });
  }

  return reconciled;
}

export function taskUiSlotToSidebarItem(slot: TaskUiSlot): SidebarTaskItem {
  if (slot.task) {
    const { id: task_id, ...task } = slot.task;
    return { ...task, slot_id: slot.slot_id, task_id, state: "ready" };
  }

  const now = slot.draft.created_at;
  return {
    slot_id: slot.slot_id,
    task_id: null,
    state: "creating",
    repo_id: slot.draft.repo_id,
    issue_number: null,
    issue_title: null,
    prompt: slot.draft.prompt,
    pipeline: slot.draft.pipeline,
    pipeline_def: null,
    stage: slot.draft.stage,
    pr_number: null,
    pr_url: null,
    branch: null,
    closed_at: null,
    agent_type: slot.draft.agent_type,
    agent_provider: slot.draft.agent_provider,
    activity: "working",
    activity_changed_at: now,
    unread_at: null,
    port_offset: null,
    display_name: slot.draft.display_name,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: now,
    updated_at: now,
  };
}
```

- [ ] **Step 5: Run the lifecycle tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/taskUiSlots.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint the task without committing**

Run:

```bash
git diff --check
git status --short
```

Expected: the three new slot files are present and `git diff --check` is silent.

### Task 2: Reconcile slots with snapshots and make selection slot-aware

**Files:**
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Test: `apps/desktop/src/stores/selection.test.ts`

- [ ] **Step 1: Add failing snapshot reconciliation coverage**

In `kanna.querySnapshot.test.ts`, add a test that loads a task, replaces its slot ID with a creation slot, reloads the task, and expects the slot ID to survive:

```ts
it("hydrates a durable task into its acknowledged UI slot", async () => {
  const store = await createStore();
  store.taskUiSlots.splice(0, store.taskUiSlots.length, {
    slot_id: "create:slot-1",
    task_id: "item-1",
    state: "creating",
    task: null,
    draft: {
      repo_id: "repo-1",
      prompt: "Ship it",
      display_name: null,
      pipeline: "default",
      stage: "in progress",
      agent_type: "pty",
      agent_provider: "claude",
      created_at: "2026-04-17T00:00:00.000Z",
    },
  });

  await store.init(createDb());

  expect(store.taskUiSlots).toEqual([
    expect.objectContaining({
      slot_id: "create:slot-1",
      task_id: "item-1",
      state: "ready",
      task: expect.objectContaining({ id: "item-1" }),
    }),
    expect.objectContaining({ task_id: "item-2" }),
  ]);
});
```

- [ ] **Step 2: Add failing selection persistence coverage**

In `selection.test.ts`, initialize a creating slot and assert that UI selection remains the slot ID while persistence receives `null`; acknowledge it and assert persistence receives the durable ID:

```ts
import {
  acknowledgeTaskUiSlot,
  buildCreatingTaskUiSlot,
} from "./taskUiSlots";

it("keeps slot selection stable while persisting only durable task IDs", async () => {
  const state = createStoreState();
  state.db.value = createDb();
  state.repos.value = [createRepo()];
  state.selectedRepoId.value = "repo-1";
  state.taskUiSlots.value = [buildCreatingTaskUiSlot({
    slotId: "create:slot-1",
    repoId: "repo-1",
    prompt: "Ship it",
    agentType: "pty",
    requestedAgentProviders: "claude",
  })];
  const persistSelection = vi.fn(async () => {});
  const context = createStoreContext(
    state,
    {
      toasts: ref([]),
      dismiss: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
    { windowWorkspace: { persistSelection } } as never,
  );
  const selection = createSelectionApi(context);

  await selection.selectItem("create:slot-1");
  expect(state.selectedItemId.value).toBe("create:slot-1");
  expect(selection.selectedTaskId.value).toBeNull();
  expect(persistSelection).toHaveBeenLastCalledWith({
    selectedRepoId: "repo-1",
    selectedItemId: null,
  });

  state.taskUiSlots.value = acknowledgeTaskUiSlot(
    state.taskUiSlots.value,
    "create:slot-1",
    "durable-1",
  );
  await selection.persistSelection();

  expect(state.selectedItemId.value).toBe("create:slot-1");
  expect(selection.selectedTaskId.value).toBe("durable-1");
  expect(persistSelection).toHaveBeenLastCalledWith({
    selectedRepoId: "repo-1",
    selectedItemId: "durable-1",
  });
});
```

- [ ] **Step 3: Run both focused tests to verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/kanna.querySnapshot.test.ts src/stores/selection.test.ts
```

Expected: FAIL because state and selection do not expose slot-aware behavior.

- [ ] **Step 4: Add slot state and services**

In `state.ts`:

```ts
import type { TaskUiSlot } from "../types/taskUi";

export interface StoreState {
  taskUiSlots: Ref<TaskUiSlot[]>;
}

export interface StoreServices {
  selectedTaskId?: ComputedRef<string | null>;
  currentTaskSlot?: ComputedRef<TaskUiSlot | null>;
  persistSelection?: () => Promise<void>;
}
```

Initialize `taskUiSlots` with `ref<TaskUiSlot[]>([])`, return it from `createStoreState`, and remove `pendingSetupIds` after Tasks 2–4 have replaced all consumers.

- [ ] **Step 5: Reconcile slots whenever query state is synchronized**

In `queries.ts`, import `reconcileTaskUiSlots` and finish `syncSnapshot()` with:

```ts
context.state.taskUiSlots.value = reconcileTaskUiSlots(
  context.state.taskUiSlots.value,
  context.state.items.value,
);
```

This must run for base snapshots and optimistic overlays so ready slot data always follows the current item projection.

- [ ] **Step 6: Make selection resolve stable slots**

In `selection.ts`, add:

```ts
const currentTaskSlot = computed(() =>
  taskUiSlotForSelection(
    context.state.taskUiSlots.value,
    context.state.selectedItemId.value,
  ),
);

const selectedTaskId = computed(() => currentTaskSlot.value?.task_id ?? null);

async function persistSelection(): Promise<void> {
  await context.services.windowWorkspace?.persistSelection({
    selectedRepoId: context.state.selectedRepoId.value,
    selectedItemId: selectedTaskId.value,
  });
}

const currentItem = computed(() => {
  const slot = currentTaskSlot.value;
  if (slot) {
    if (slot.draft.repo_id !== context.state.selectedRepoId.value) return null;
    return slot.task && !isItemHidden(slot.task) ? slot.task : null;
  }
  return sortedItemsForCurrentRepo.value[0] ?? null;
});
```

Update `selectItem` to resolve `taskUiSlotForSelection`, store `slot.slot_id`, set the repo from `slot.draft.repo_id`, and emit/persist only `slot.task_id`. Update fallback, restore, back/forward, and reconciliation paths to convert durable item IDs with `taskUiSlotForSelection(context.state.taskUiSlots.value, durableId)?.slot_id`. Return `selectedTaskId`, `currentTaskSlot`, and `persistSelection` in `SelectionApi`.

- [ ] **Step 7: Wire slot-aware selection through the Pinia store**

In `kanna.ts`:

```ts
services.selectedTaskId = selection.selectedTaskId;
services.currentTaskSlot = selection.currentTaskSlot;
services.persistSelection = selection.persistSelection;
```

Expose these values:

```ts
taskUiSlots: state.taskUiSlots,
selectedTaskId: selection.selectedTaskId,
currentTaskSlot: selection.currentTaskSlot,
```

- [ ] **Step 8: Run the focused tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/taskUiSlots.test.ts src/stores/kanna.querySnapshot.test.ts src/stores/selection.test.ts
```

Expected: PASS.

- [ ] **Step 9: Checkpoint the task without committing**

Run `git diff --check` and inspect `git diff --stat`. Expected: only slot/state/query/selection files and their focused tests changed.

### Task 3: Replace the creation overlay with one persistent slot

**Files:**
- Modify: `apps/desktop/src/stores/taskItemActions.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Delete: `apps/desktop/src/stores/taskCreationPlaceholder.ts`
- Delete: `apps/desktop/src/stores/taskCreationPlaceholder.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing creation handoff test**

Replace the existing pending-placeholder integration test with a delayed handoff assertion:

```ts
it("keeps one selected UI slot from submission through durable hydration", async () => {
  const worktreeAddGate = mockState.defer();
  const selectionGate = mockState.defer();
  const store = await createStore();
  mockState.commandGates = { git_worktree_add: worktreeAddGate.promise };
  store.attachWindowWorkspace({
    bootstrap: { windowId: "test-window", selectedRepoId: null, selectedItemId: null },
    loadSnapshot: vi.fn(async () => ({ windows: [] })),
    saveSnapshot: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
    closeWindow: vi.fn(async () => {}),
    forgetCurrentWindow: vi.fn(async () => {}),
    persistSelection: vi.fn(async () => selectionGate.promise),
    persistSidebarHidden: vi.fn(async () => {}),
    persistSidebarWidth: vi.fn(async () => {}),
    invalidateSharedData: vi.fn(async () => {}),
    restoreAdditionalWindows: vi.fn(async () => {}),
    onSharedInvalidation: vi.fn(async () => vi.fn()),
  });

  const createPromise = store.createItem(
    "repo-1",
    "/tmp/repo",
    "Show one stable task",
    "pty",
    { agentProvider: "claude" },
  );

  await vi.waitFor(() => {
    expect(store.currentTaskSlot?.slot_id).toMatch(/^create:/);
  });
  const slotId = store.currentTaskSlot!.slot_id;
  expect(store.items.some((item) => item.id === slotId)).toBe(false);
  expect(store.selectedItemId).toBe(slotId);
  expect(store.taskUiSlots).toHaveLength(1);

  worktreeAddGate.resolve();
  await vi.waitFor(() => {
    expect(store.currentTaskSlot?.task_id).toMatch(/^[0-9a-f-]+$/);
    expect(store.currentTaskSlot?.state).toBe("ready");
  });

  expect(store.currentTaskSlot?.slot_id).toBe(slotId);
  expect(store.taskUiSlots.filter((slot) => slot.draft.prompt === "Show one stable task")).toHaveLength(1);
  expect(store.selectedItemId).toBe(slotId);
  expect(store.selectedTaskId).toBe(store.currentTaskSlot?.task_id);

  selectionGate.resolve();
  await createPromise;
});
```

- [ ] **Step 2: Add a failing post-acknowledgement snapshot error test**

Add:

```ts
it("retains an acknowledged slot when task snapshot hydration fails", async () => {
  const store = await createStore();
  let failNextSnapshot = true;
  setDesktopSnapshotFetcherForTests(async () => {
    if (failNextSnapshot) {
      failNextSnapshot = false;
      throw new Error("snapshot temporarily unavailable");
    }
    return {
      entries: mockState.repos.map((repo) => ({
        repo,
        items: mockState.pipelineItems.filter((item) => item.repo_id === repo.id),
      })),
      taskBlockers: mockState.taskBlockers,
      worktreePaths: {},
      settings: {},
    };
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  const taskId = await store.createItem(
    "repo-1",
    "/tmp/repo",
    "Hydrate later",
    "pty",
    { agentProvider: "claude" },
  );

  expect(store.currentTaskSlot).toMatchObject({
    slot_id: expect.stringMatching(/^create:/),
    task_id: taskId,
    state: "creating",
    task: null,
  });

  await store.init(createDb());
  expect(store.currentTaskSlot).toMatchObject({ task_id: taskId, state: "ready" });
  consoleError.mockRestore();
});
```

- [ ] **Step 3: Run the creation tests to verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/kanna.taskBaseBranch.test.ts -t "stable task|Hydrate later"
```

Expected: FAIL because creation still injects and replaces a synthetic `PipelineItem`.

- [ ] **Step 4: Implement slot-based creation**

In `taskItemActions.ts`:

1. Generate `const slotId = `create:${crypto.randomUUID()}``.
2. Build and add a creating slot before base-branch resolution.
3. Select `slotId` directly when `selectOnCreate !== false`.
4. Run `createDesktopTask` without `withOptimisticItemOverlay`.
5. On response, call `acknowledgeTaskUiSlot`, transfer `pendingCreateVisibility` from `slotId` to the durable ID, and call `persistSelection` without changing `selectedItemId`.
6. Reload the snapshot. Let `queries.ts` hydrate the existing slot.
7. Catch reload failure after acknowledgement, log it, retain the slot, and still return the durable task ID.
8. On pre-acknowledgement failure, remove only `slotId` and select the normal replacement.

The core handoff should read:

```ts
const created = await createDesktopTask(request);
createdTaskId = created.taskId;
context.state.taskUiSlots.value = acknowledgeTaskUiSlot(
  context.state.taskUiSlots.value,
  slotId,
  createdTaskId,
);

if (context.state.selectedItemId.value === slotId) {
  await requireService(context.services.persistSelection, "persistSelection")()
    .catch((error) => console.error("[store] failed to persist acknowledged task selection:", error));
}

try {
  await reloadSnapshot();
} catch (error) {
  console.error("[store] failed to hydrate created task snapshot:", error);
}
```

Publish LAN/cloud snapshots only when `context.state.items` contains `createdTaskId`.

- [ ] **Step 5: Replace setup-status checks with slot state**

In `sessions.ts`, replace `pendingSetupIds` lookup with:

```ts
const isPendingSetup = context.state.taskUiSlots.value.some(
  (slot) => slot.task_id === item.id && slot.state === "creating",
);
if (shouldIgnoreRuntimeStatusDuringSetup(status, isPendingSetup)) return;
```

Remove `pendingSetupIds` from `state.ts`, `kanna.ts`, and creation code after no production references remain.

- [ ] **Step 6: Delete the synthetic placeholder helper**

Delete `taskCreationPlaceholder.ts` and its test. Confirm `rg -n "taskCreationPlaceholder|pendingSetupIds" apps/desktop/src` returns only deliberately retained historical text in docs, or no matches in production code.

- [ ] **Step 7: Run creation and slot tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/taskUiSlots.test.ts src/stores/kanna.taskBaseBranch.test.ts
```

Expected: PASS.

- [ ] **Step 8: Checkpoint the task without committing**

Run `git diff --check` and verify the deleted placeholder files are replaced by slot lifecycle coverage.

### Task 4: Project stable slots through workspace and sidebar ordering

**Files:**
- Modify: `apps/desktop/src/utils/taskSearch.ts`
- Modify: `apps/desktop/src/utils/sidebarOrdering.ts`
- Modify: `apps/desktop/src/utils/sidebarOrdering.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`

- [ ] **Step 1: Write failing ordering tests with distinct slot/task IDs**

Change the `item` test helper in `sidebarOrdering.test.ts` to return `SidebarTaskItem`, then add:

```ts
it("uses slot identity for rows and durable identity for blockers and parents", () => {
  const parent = item({ slot_id: "slot-parent", task_id: "task-parent" });
  const child = item({
    slot_id: "slot-child",
    task_id: "task-child",
    parent_task_id: "task-parent",
  });
  const blocked = item({ slot_id: "slot-blocked", task_id: "task-blocked" });
  const blocker = item({ slot_id: "slot-blocker", task_id: "task-blocker" });

  const ordered = sortSidebarItemsForRepo({
    repoId: "repo-1",
    items: [parent, child, blocked, blocker],
    blockers: [{ blocked_item_id: "task-blocked", blocker_item_id: "task-blocker" }],
    getStageOrder,
  });

  expect(ordered.map((entry) => entry.slot_id)).toEqual([
    "slot-parent",
    "slot-child",
    "slot-blocker",
    "slot-blocked",
  ]);
});
```

- [ ] **Step 2: Run ordering tests to verify RED**

Run `pnpm --dir apps/desktop test -- src/utils/sidebarOrdering.test.ts`.

Expected: type/test failure because ordering assumes `PipelineItem.id` is both identities.

- [ ] **Step 3: Generalize search and ordering to sidebar presentation items**

In `taskSearch.ts`, replace the `PipelineItem` parameter with:

```ts
export interface TaskSearchable {
  display_name: string | null;
  issue_title: string | null;
  branch: string | null;
  prompt: string | null;
}
```

Use `TaskSearchable` in `searchableFields` and `taskSearchMatch`.

In `sidebarOrdering.ts`, use `SidebarTaskItem` throughout. Apply these identity rules:

```ts
function slotId(item: SidebarTaskItem): string {
  return item.slot_id;
}

function taskId(item: SidebarTaskItem): string | null {
  return item.task_id;
}
```

- cycle/seen/deduplication sets store `slot_id`
- blocker matching compares `task_id` with `TaskBlocker` durable IDs
- parent presence stores non-null `task_id`; children compare `parent_task_id` with the parent's `task_id`
- creating slots have no blockers or children and still sort by draft `created_at`

- [ ] **Step 4: Project local slot IDs through cloud/workspace merging**

In `useAppCloudWorkspace.ts`:

```ts
export type AppSidebarItem = SidebarTaskItem & {
  remote_task?: boolean;
};
```

Build a map of local durable task ID to slot, then project workspace tasks:

```ts
const localSlotsByTaskId = computed(() => new Map(
  store.taskUiSlots
    .filter((slot) => slot.task_id !== null)
    .map((slot) => [slot.task_id!, slot]),
));

const sidebarItems = computed<AppSidebarItem[]>(() => {
  const representedSlots = new Set<string>();
  const workspaceItems = workspace.value.tasks.map((workspaceTask) => {
    const localSlot = workspaceTask.localTaskId
      ? localSlotsByTaskId.value.get(workspaceTask.localTaskId)
      : undefined;
    const slotId = localSlot?.slot_id ?? workspaceTask.item.id;
    representedSlots.add(slotId);
    const { id: task_id, ...task } = workspaceTask.item;
    return {
      ...task,
      slot_id: slotId,
      task_id,
      state: "ready" as const,
      repo_id: workspaceTask.repoKey,
      remote_task: workspaceTask.owner.kind !== "local",
    };
  });

  const creatingItems = store.taskUiSlots
    .filter((slot) => !representedSlots.has(slot.slot_id))
    .map(taskUiSlotToSidebarItem);
  return [...creatingItems, ...workspaceItems];
});
```

Add each local slot ID as an alias in `workspaceTasksByItemId` when a workspace task has `localTaskId`. This preserves local/cloud routing after a current-session task hydrates.

- [ ] **Step 5: Run ordering and workspace unit tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/utils/sidebarOrdering.test.ts src/workspace/buildWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint the task without committing**

Run `git diff --check` and inspect the ordering/workspace diff for any use of `slot_id` in backend API calls.

### Task 5: Render and select the same sidebar row through hydration

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/__tests__/Sidebar.test.ts`
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/TaskHeader.vue`
- Modify: `apps/desktop/src/components/__tests__/MainPanel.test.ts`
- Modify: `apps/desktop/src/components/__tests__/TaskHeader.test.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write the failing same-row sidebar test**

Update the Sidebar test fixtures to `SidebarTaskItem`, then add:

```ts
function sidebarItem(
  slotId: string,
  taskId: string | null,
  overrides: Partial<SidebarTaskItem> = {},
): SidebarTaskItem {
  const { id: _id, ...base } = item(taskId ?? slotId, {});
  return {
    ...base,
    slot_id: slotId,
    task_id: taskId,
    state: taskId ? "ready" : "creating",
    ...overrides,
  };
}

it("keeps the same row mounted when a creating slot becomes a durable task", async () => {
  const creating = sidebarItem("slot-1", null, {
    state: "creating",
    prompt: "Stable row",
  });
  const wrapper = mountSidebar([creating], "slot-1");
  const originalRow = wrapper.get('[data-slot-id="slot-1"]').element;

  await wrapper.setProps({
    taskSlots: [sidebarItem("slot-1", "task-1", {
      state: "ready",
      prompt: "Stable row",
      branch: "task-task-1",
    })],
  });

  expect(wrapper.findAll(".pipeline-item")).toHaveLength(1);
  expect(wrapper.get(".repo-count").text()).toBe("1");
  expect(wrapper.get('[data-slot-id="slot-1"]').element).toBe(originalRow);
  expect(wrapper.get('[data-slot-id="slot-1"]').attributes("data-task-id")).toBe("task-1");
  expect(wrapper.get('[data-slot-id="slot-1"]').classes()).toContain("selected");
});
```

- [ ] **Step 2: Write the failing main-panel slot transition test**

In `MainPanel.test.ts`, mount with a creating slot, assert the setup view, update the same slot to ready with a task, and assert `TerminalTabs` receives the durable task ID without an empty-state frame.

```ts
const readySlot: TaskUiSlot = {
  ...creatingSlot,
  task_id: "task-1",
  state: "ready",
  task: item("task-1", { branch: "task-task-1" }),
};

expect(wrapper.get(".setup-placeholder").exists()).toBe(true);
await wrapper.setProps({ uiSlot: readySlot });
expect(wrapper.find(".empty-state").exists()).toBe(false);
expect(wrapper.getComponent(TerminalTabs).props("sessionId")).toBe("task-1");
```

- [ ] **Step 3: Run component tests to verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/Sidebar.test.ts src/components/__tests__/MainPanel.test.ts src/App.test.ts
```

Expected: FAIL because components still key and select `PipelineItem.id`.

- [ ] **Step 4: Make Sidebar consume explicit slots**

In `Sidebar.vue`:

- rename prop `pipelineItems` to `taskSlots: AppSidebarItem[]`
- rename prop `selectedItemId` to `selectedSlotId`
- pass `taskSlots` to ordering helpers
- key every task row and draggable item with `slot_id`
- compare selection and editing state with `slot_id`
- render `data-slot-id="slot_id"` always and `data-task-id="task_id"` only when non-null
- emit `select-item` with `slot_id`
- emit pin, unpin, reorder, parent, detach, and rename operations only with non-null durable `task_id`
- disable dragging and renaming for `state === "creating"`

The normal row shape should be:

```vue
<div
  v-for="row in subtreeRows(repo.id, element)"
  :key="row.item.slot_id"
  class="pipeline-item"
  :class="{
    selected: selectedSlotId === row.item.slot_id,
    subtask: row.depth > 0,
    'initializing-item': row.item.state === 'creating',
    'drop-target': row.item.task_id !== null && dropParentId === row.item.task_id,
  }"
  :data-slot-id="row.item.slot_id"
  :data-task-id="row.item.task_id ?? undefined"
  :aria-busy="row.item.state === 'creating' ? 'true' : undefined"
  @click="handleSelectItem(row.item)"
>
```

Keep the existing title/activity styling; add italic muted styling for `.initializing-item .item-title`.

- [ ] **Step 5: Make MainPanel and TaskHeader consume a slot**

Change `MainPanel` prop to `uiSlot: TaskUiSlot | null` and derive:

```ts
const item = computed(() => props.uiSlot?.task ?? null);
const isCreating = computed(() => props.uiSlot?.state === "creating");
const headerItem = computed(() => item.value ?? (props.uiSlot ? {
  stage: props.uiSlot.draft.stage,
  display_name: props.uiSlot.draft.display_name,
  issue_title: null,
  prompt: props.uiSlot.draft.prompt,
  branch: null,
  port_env: null,
  issue_number: null,
  pr_number: null,
  pr_url: null,
} : null));
```

Render setup when `isCreating`, and render `TerminalTabs` only when `item` exists. Narrow `TaskHeader`'s prop to the exact header fields shown above rather than requiring a complete `PipelineItem`.

- [ ] **Step 6: Wire App to slot props**

In `App.vue`, pass `sidebarItems` as `task-slots`, pass `store.selectedItemId` as `selected-slot-id`, and pass the selected UI slot to `MainPanel`. For remote tasks, construct a ready `TaskUiSlot` whose `slot_id` and `task_id` are the remote item ID. Remove the `pending-setup` prop.

- [ ] **Step 7: Run component tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/components/__tests__/Sidebar.test.ts src/components/__tests__/MainPanel.test.ts src/components/__tests__/TaskHeader.test.ts src/App.test.ts
```

Expected: PASS, including the same DOM element assertion.

- [ ] **Step 8: Checkpoint the task without committing**

Run `git diff --check`; inspect `Sidebar.vue` to confirm `slot_id` is used only for UI keys/selection and `task_id` only for durable mutations.

### Task 6: Update navigation and backend-selection consumers

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/composables/useAppKeyboardActions.ts`
- Modify: `apps/desktop/src/stores/taskCloseActions.ts`
- Modify: `apps/desktop/src/stores/pipeline.ts`
- Modify: `apps/desktop/src/stores/windowSelection.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/selection.test.ts`
- Test: `apps/desktop/src/stores/init.test.ts`
- Test: `apps/desktop/src/composables/useAppKeyboardActions.test.ts`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Add failing navigation and close-selection assertions**

Extend the existing close integration coverage in `kanna.taskBaseBranch.test.ts` with a ready slot whose `slot_id` differs from `task_id`:

```ts
mockState.pipelineItems = [mockState.makeItem({ id: "task-1" })];
const store = await createStore();
const slot = store.taskUiSlots.find((candidate) => candidate.task_id === "task-1")!;
slot.slot_id = "create:slot-1";
await store.selectItem("create:slot-1");

expect(store.selectedItemId).toBe("create:slot-1");
expect(store.selectedTaskId).toBe("task-1");
await store.closeTask();
expect(mockState.pipelineItems[0]?.closed_at).toBe(mockState.makeItem().updated_at);
```

Extend `App.test.ts` navigation coverage to provide sidebar rows whose `slot_id` differs from `task_id`, invoke next/previous navigation, and assert `store.selectedItemId` becomes the target `slot_id`. Extend `useAppKeyboardActions.test.ts` so comparisons against a durable `PipelineItem.id` use `store.selectedTaskId`.

- [ ] **Step 2: Run affected tests to verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/kanna.taskBaseBranch.test.ts src/stores/selection.test.ts src/composables/useAppKeyboardActions.test.ts src/App.test.ts
```

Expected: at least the new distinct-identity assertions fail.

- [ ] **Step 3: Route UI navigation by slot and backend work by task**

Apply these rules consistently:

- `useAppTaskNavigation`: locate current/next rows by `slot_id`; call `store.selectItem(slot_id)`; use `task_id` for blocker and remote backend operations.
- `useAppKeyboardActions`: compare the selected durable task through `store.selectedTaskId` when comparing against `PipelineItem.id`.
- `taskCloseActions`: use `services.selectedTaskId` for selected-task comparisons; selection replacement resolves the replacement task back to a slot.
- `pipeline.ts`: compute `sourceTaskIsSelected` from `services.selectedTaskId`; restore selection through `selectItem` so durable IDs resolve to slots.
- `windowSelection.ts`: compare current-window selection through `services.selectedTaskId`; persisted other-window selections are already durable IDs.
- `init.ts`: bootstrap IDs are durable and must resolve to slots after the first snapshot; external refresh preserves the selected slot when its durable task remains.

No backend service call may receive `slot_id`.

- [ ] **Step 4: Run navigation/selection tests to verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test -- src/stores/kanna.taskBaseBranch.test.ts src/stores/selection.test.ts src/composables/useAppKeyboardActions.test.ts src/App.test.ts src/stores/pipeline.requestRevision.test.ts src/stores/init.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run a source audit for identity leaks**

Run:

```bash
rg -n "selectedItemId.*item\.id|item\.id.*selectedItemId|selectedItemId\.value ===" apps/desktop/src --glob '!**/*.test.ts'
rg -n "slot_id" apps/desktop/src/services apps/desktop/src/stores --glob '!**/*.test.ts'
```

Expected: every remaining comparison is explicitly UI-to-UI, and no service request body/path uses `slot_id`.

- [ ] **Step 6: Checkpoint the task without committing**

Run `git diff --check` and inspect the full diff stat.

### Task 7: Full verification

**Files:**
- Verify all modified frontend files and tests

- [ ] **Step 1: Run all desktop unit tests**

Run:

```bash
pnpm --dir apps/desktop test
```

Expected: all desktop Vitest tests pass with no unhandled errors.

- [ ] **Step 2: Run the desktop typecheck/build**

Run:

```bash
pnpm --dir apps/desktop build
```

Expected: `vue-tsc --noEmit` and Vite build complete successfully.

- [ ] **Step 3: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the stable-slot implementation, its design/plan documents, and directly related tests are changed. Do not commit or push.
