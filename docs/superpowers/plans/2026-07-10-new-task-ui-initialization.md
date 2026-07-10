# New Task UI Initialization Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a newly submitted task visible and selected while it initializes, without ever treating its UI item ID as a durable task or daemon session ID.

**Architecture:** Introduce a UI-only `InitializingTaskItem` held separately from persisted `PipelineItem[]`. Selection may point at that UI item, but `currentItem` and every terminal/task API remain unavailable until the server returns a durable task ID and the snapshot contains the real task. The main panel and sidebar render initialization explicitly; successful creation hands selection to the real task before removing the UI item.

**Tech Stack:** Vue 3, Pinia, TypeScript, Vitest, Vue Test Utils, Tauri desktop frontend.

**Stage constraint:** Do not commit during this manual Kanna stage. Leave changes in the worktree for the pipeline's later commit stage.

---

## File Map

- Create `apps/desktop/src/stores/taskInitialization.ts` and its unit test for the UI-only lifecycle model.
- Delete `apps/desktop/src/stores/taskCreationPlaceholder.ts` and its test; initializing items are not `PipelineItem`s.
- Modify `apps/desktop/src/stores/state.ts`, `selection.ts`, `kanna.ts`, and their tests to keep UI and durable identities separate.
- Modify `apps/desktop/src/stores/taskItemActions.ts` and `kanna.taskBaseBranch.test.ts` for the create/initialize/handoff flow.
- Modify `apps/desktop/src/components/MainPanel.vue`, `TaskHeader.vue`, `Sidebar.vue`, `App.vue`, and component tests for explicit initialization rendering.
- Modify `apps/desktop/src/stores/sessions.ts`, `taskRuntimeStatus.ts`, and affected fixtures to remove obsolete fake-task setup state.

### Task 1: Define the UI-only initialization model

**Files:**
- Create: `apps/desktop/src/stores/taskInitialization.ts`
- Create: `apps/desktop/src/stores/taskInitialization.test.ts`

- [ ] **Step 1: Write the failing model tests**

Create `apps/desktop/src/stores/taskInitialization.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildInitializingTaskItem,
  initializeTaskItem,
  removeInitializingTaskItem,
  toReadyTaskUiItem,
} from "./taskInitialization";

describe("task initialization UI items", () => {
  it("creates a UI item without a durable task id", () => {
    const item = buildInitializingTaskItem({
      id: "create-1",
      repoId: "repo-1",
      prompt: "ship it",
      displayName: "Ship it",
      pipelineName: "qa",
      agentType: "pty",
      requestedAgentProviders: "copilot",
      nowIso: "2026-07-10T00:00:00.000Z",
    });

    expect(item).toMatchObject({
      id: "create-1",
      state: "initializing",
      taskId: null,
      repo_id: "repo-1",
      prompt: "ship it",
      display_name: "Ship it",
      pipeline: "qa",
      stage: "in progress",
      agent_type: "pty",
      agent_provider: "copilot",
    });
    expect(item).not.toHaveProperty("branch");
  });

  it("wraps persisted tasks with an explicit durable task id", () => {
    const task = { id: "task-1" } as import("../types/kanna").PipelineItem;
    expect(toReadyTaskUiItem(task)).toEqual({
      id: "task-1",
      state: "ready",
      taskId: "task-1",
      task,
    });
  });

  it("initializes and removes items immutably", () => {
    const pending = buildInitializingTaskItem({
      id: "create-1",
      repoId: "repo-1",
      prompt: "ship it",
      agentType: "pty",
    });

    const initialized = initializeTaskItem([pending], "create-1", "task-1");

    expect(initialized[0]?.taskId).toBe("task-1");
    expect(removeInitializingTaskItem(initialized, "create-1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/taskInitialization.test.ts
```

Expected: FAIL because `taskInitialization.ts` does not exist.

- [ ] **Step 3: Implement the model**

Create `apps/desktop/src/stores/taskInitialization.ts`:

```ts
import type { AgentProvider, PipelineItem } from "../types/kanna";
import { normalizeAgentProviderCandidates } from "./agent-provider";
import type { AgentExecutionType } from "./agentExecutionType";

export interface InitializingTaskItem {
  id: string;
  state: "initializing";
  taskId: string | null;
  repo_id: string;
  prompt: string;
  display_name: string | null;
  pipeline: string;
  stage: string;
  agent_type: AgentExecutionType;
  agent_provider: AgentProvider;
  created_at: string;
}

export interface ReadyTaskUiItem {
  id: string;
  state: "ready";
  taskId: string;
  task: PipelineItem;
}

export type TaskUiItem = InitializingTaskItem | ReadyTaskUiItem;

interface BuildOptions {
  id: string;
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
  stage?: string;
  agentType: AgentExecutionType;
  requestedAgentProviders?: AgentProvider | AgentProvider[];
  nowIso?: string;
}

export function buildInitializingTaskItem(options: BuildOptions): InitializingTaskItem {
  const providers = normalizeAgentProviderCandidates(options.requestedAgentProviders);
  return {
    id: options.id,
    state: "initializing",
    taskId: null,
    repo_id: options.repoId,
    prompt: options.prompt,
    display_name: options.displayName ?? null,
    pipeline: options.pipelineName ?? "default",
    stage: options.stage ?? "in progress",
    agent_type: options.agentType,
    agent_provider: providers[0] ?? "claude",
    created_at: options.nowIso ?? new Date().toISOString(),
  };
}

export function toReadyTaskUiItem(task: PipelineItem): ReadyTaskUiItem {
  return { id: task.id, state: "ready", taskId: task.id, task };
}

export function initializeTaskItem(
  items: readonly InitializingTaskItem[], itemId: string, taskId: string,
): InitializingTaskItem[] {
  return items.map((item) => item.id === itemId ? { ...item, taskId } : item);
}

export function removeInitializingTaskItem(
  items: readonly InitializingTaskItem[], itemId: string,
): InitializingTaskItem[] {
  return items.filter((item) => item.id !== itemId);
}
```

- [ ] **Step 4: Run the test and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/taskInitialization.test.ts
```

Expected: PASS with 3 tests.

### Task 2: Separate UI selection from durable task selection

**Files:**
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/stores/selection.test.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Add failing selection tests**

Add helpers and tests to `selection.test.ts`:

```ts
import { initializeTaskItem, type InitializingTaskItem } from "./taskInitialization";

function toastStub() {
  return {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
}

function initializingItem(overrides: Partial<InitializingTaskItem> = {}): InitializingTaskItem {
  return {
    id: "create-1",
    state: "initializing",
    taskId: null,
    repo_id: "repo-1",
    prompt: "Create a task",
    display_name: null,
    pipeline: "default",
    stage: "in progress",
    agent_type: "pty",
    agent_provider: "claude",
    created_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

it("does not resolve an initializing UI item as a persisted task", () => {
  const state = createStoreState();
  state.repos.value = [createRepo()];
  state.items.value = [createItem({ id: "task-existing" })];
  state.initializingTaskItems.value = [initializingItem()];
  state.selectedRepoId.value = "repo-1";
  state.selectedItemId.value = "create-1";

  const selection = createSelectionApi(createStoreContext(state, toastStub(), {}));

  expect(selection.currentInitializingItem.value?.id).toBe("create-1");
  expect(selection.currentItem.value).toBeNull();
});

it("persists only the durable id of an initializing selection", async () => {
  const state = createStoreState();
  state.repos.value = [createRepo()];
  state.initializingTaskItems.value = [initializingItem()];
  const persistSelection = vi.fn(async () => {});
  const selection = createSelectionApi(createStoreContext(
    state,
    toastStub(),
    { windowWorkspace: { persistSelection } } as never,
  ));

  await selection.selectItem("create-1");
  expect(persistSelection).toHaveBeenLastCalledWith({
    selectedRepoId: "repo-1", selectedItemId: null,
  });

  state.initializingTaskItems.value = initializeTaskItem(
    state.initializingTaskItems.value, "create-1", "task-1",
  );
  await selection.selectItem("create-1");
  expect(persistSelection).toHaveBeenLastCalledWith({
    selectedRepoId: "repo-1", selectedItemId: "task-1",
  });
});
```

- [ ] **Step 2: Run selection tests and verify RED**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/selection.test.ts
```

Expected: FAIL because state and selection do not expose initializing items.

- [ ] **Step 3: Add initializing items to store state**

In `state.ts`, import `InitializingTaskItem`, add `initializingTaskItems: Ref<InitializingTaskItem[]>` to `StoreState`, create `ref<InitializingTaskItem[]>([])`, and return it from `createStoreState()`.

```ts
const initializingTaskItems = ref<InitializingTaskItem[]>([]);
```

- [ ] **Step 4: Resolve and persist selection identities explicitly**

In `selection.ts`:

```ts
const currentInitializingItem = computed(() => {
  const selectedId = context.state.selectedItemId.value;
  return selectedId
    ? context.state.initializingTaskItems.value.find((item) => item.id === selectedId) ?? null
    : null;
});

function persistedSelectedTaskId(): string | null {
  const initializing = currentInitializingItem.value;
  return initializing ? initializing.taskId : context.state.selectedItemId.value;
}

async function persistWindowSelection(): Promise<void> {
  await context.services.windowWorkspace?.persistSelection({
    selectedRepoId: context.state.selectedRepoId.value,
    selectedItemId: persistedSelectedTaskId(),
  });
}
```

Add `currentInitializingItem: ComputedRef<InitializingTaskItem | null>` to `SelectionApi`. Replace `currentItem` with the existing lookup wrapped by the initializing guard:

```ts
const currentItem = computed(() => {
  if (currentInitializingItem.value) return null;
  if (context.state.selectedItemId.value) {
    const item = context.state.items.value.find(
      (candidate) => candidate.id === context.state.selectedItemId.value,
    );
    if (item && !isItemHidden(item) && item.repo_id === context.state.selectedRepoId.value) {
      return item;
    }
  }
  return sortedItemsForCurrentRepo.value[0] ?? null;
});
```

At the start of `selectItem`, after assigning `selectedItemId`, add:

```ts
const initializing = context.state.initializingTaskItems.value.find(
  (candidate) => candidate.id === itemId,
);
if (initializing) {
  context.state.selectedRepoId.value = initializing.repo_id;
  context.state.lastSelectedItemByRepo.value[initializing.repo_id] = initializing.id;
  await persistWindowSelection();
  return;
}
```

This returns before PTY metrics and operator events.

Change `selectReplacementAfterItemRemoval` and its service type to accept `Pick<PipelineItem, "id" | "repo_id">`; those are the only fields its replacement algorithm requires.

- [ ] **Step 5: Expose initialization state from Pinia**

In `kanna.ts`, return:

```ts
initializingTaskItems: state.initializingTaskItems,
currentInitializingItem: selection.currentInitializingItem,
```

- [ ] **Step 6: Run selection tests and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/selection.test.ts
```

Expected: PASS, including both new identity tests.

### Task 3: Move task creation onto the initialization lifecycle

**Files:**
- Modify: `apps/desktop/src/stores/taskItemActions.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Replace the optimistic-placeholder test with a failing regression**

Replace “selects the pending task placeholder immediately” in `kanna.taskBaseBranch.test.ts` with:

```ts
it("keeps the initializing UI id separate from the server task id", async () => {
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
    "repo-1", "/tmp/repo", "Show the new task now", "pty",
    { agentProvider: "claude" },
  );
  await vi.waitFor(() => expect(mockState.invokeMock).toHaveBeenCalledWith(
    "git_worktree_add", expect.objectContaining({ repoPath: "/tmp/repo" }),
  ));

  const uiId = store.selectedItemId;
  expect(store.currentInitializingItem).toMatchObject({ id: uiId, taskId: null });
  expect(store.currentItem).toBeNull();
  expect(store.items.some((item) => item.id === uiId)).toBe(false);

  worktreeAddGate.resolve();
  await vi.waitFor(() => {
    const initializing = store.initializingTaskItems.find((item) => item.id === uiId);
    expect(initializing?.taskId).toMatch(/^[0-9a-f-]+$/);
    expect(store.selectedItemId).toBe(initializing?.taskId);
  });

  selectionGate.resolve();
  await createPromise;
  expect(store.initializingTaskItems).toEqual([]);
  expect(store.currentItem?.id).toBe(store.selectedItemId);
});
```

In the existing `does not auto-select a created task when selectOnCreate is false` test, add:

```ts
expect(store.initializingTaskItems).toEqual([]);
expect(store.selectedItemId).toBe("item-active");
```

This covers background creation without changing its current selection.

- [ ] **Step 2: Run the regression and verify RED**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "initializing UI id"
```

Expected: FAIL because creation still inserts a fake `PipelineItem` overlay.

- [ ] **Step 3: Replace the optimistic overlay in `createItem`**

In `taskItemActions.ts`, import the Task 1 helpers. Remove the `KannaSnapshot` import, local `withOptimisticItemOverlay` wrapper, `buildPendingTaskPlaceholder`, and `applyPendingPlaceholderOverlay`.

Create and select UI-only state before the server request:

```ts
const initializingItem = buildInitializingTaskItem({
  id: placeholderId,
  repoId,
  prompt: effectivePrompt,
  displayName,
  pipelineName: opts?.pipelineName,
  agentType: effectiveAgentType,
  requestedAgentProviders,
});
context.state.initializingTaskItems.value = [
  initializingItem,
  ...context.state.initializingTaskItems.value,
];
context.state.pendingCreateVisibility.set(initializingItem.id, {
  bumpAt: performance.now(),
});
```

After `createDesktopTask` returns, re-key visibility tracking, reload the durable snapshot, then bind the UI item immediately before selection handoff:

```ts
createdTaskId = created.taskId;
const visibility = context.state.pendingCreateVisibility.get(initializingItem.id);
context.state.pendingCreateVisibility.delete(initializingItem.id);
if (visibility) context.state.pendingCreateVisibility.set(createdTaskId, visibility);

await reloadSnapshot();
context.state.initializingTaskItems.value = initializeTaskItem(
  context.state.initializingTaskItems.value,
  initializingItem.id,
  createdTaskId,
);
if (opts?.selectOnCreate !== false) {
  await requireService(context.services.selectItem, "selectItem")(createdTaskId);
}
context.state.initializingTaskItems.value = removeInitializingTaskItem(
  context.state.initializingTaskItems.value,
  initializingItem.id,
);
```

Use this failure cleanup around the server/reload body:

```ts
} catch (error) {
  context.state.initializingTaskItems.value = removeInitializingTaskItem(
    context.state.initializingTaskItems.value,
    initializingItem.id,
  );
  context.state.pendingCreateVisibility.delete(initializingItem.id);
  context.state.pendingCreateVisibility.delete(createdTaskId);
  if (context.state.selectedItemId.value === initializingItem.id) {
    await requireService(
      context.services.selectReplacementAfterItemRemoval,
      "selectReplacementAfterItemRemoval",
    )(initializingItem);
  }
  throw error;
}
```

Selection must change to `createdTaskId` before the success path removes the initializing item.

- [ ] **Step 4: Replace the old factory mock**

In `kanna.taskBaseBranch.test.ts`, replace the `taskCreationPlaceholder` mock with:

```ts
vi.mock("./taskInitialization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./taskInitialization")>();
  return {
    ...actual,
    buildInitializingTaskItem: vi.fn((options) => actual.buildInitializingTaskItem({
      ...options,
      nowIso: "2026-01-01T00:00:00.000Z",
    })),
  };
});
```

- [ ] **Step 5: Run creation tests and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "initializing UI id|setup output|creation failure"
```

Expected: PASS. The temporary UI id never appears in `store.items`; the selected real id exists in the server snapshot.

### Task 4: Gate the main panel and terminal on a real task

**Files:**
- Modify: `apps/desktop/src/components/MainPanel.vue`
- Modify: `apps/desktop/src/components/TaskHeader.vue`
- Modify: `apps/desktop/src/components/__tests__/MainPanel.test.ts`
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Write the failing main-panel lifecycle test**

Replace the pending-setup test in `MainPanel.test.ts` with:

```ts
it("mounts a terminal only after the UI item has a durable task", async () => {
  const { default: MainPanel } = await import("../MainPanel.vue");
  const ready = {
    id: "task-real",
    repo_id: "repo-1",
    prompt: "Make a task",
    stage: "in progress",
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-real",
    agent_type: "pty",
    agent_provider: "codex",
    port_offset: null,
    port_env: null,
    activity: "working",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    activity_changed_at: "2026-07-10T00:00:00.000Z",
    unread_at: null,
    pinned: 0,
    pin_order: null,
    display_name: "Make a task",
    closed_at: null,
    pipeline: "default",
    pipeline_def: null,
    stage_result: null,
    issue_number: null,
    issue_title: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    last_output_preview: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
  };
  const wrapper = mount(MainPanel, {
    props: {
      uiItem: {
        id: "create-1",
        state: "initializing",
        taskId: null,
        repo_id: "repo-1",
        prompt: "Make a task",
        display_name: "Make a task",
        pipeline: "default",
        stage: "in progress",
        agent_type: "pty",
        agent_provider: "codex",
        created_at: "2026-07-10T00:00:00.000Z",
      },
      repoPath: "/tmp/repo",
      hasRepos: true,
    },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        TaskHeader: { template: '<div data-testid="task-header" />' },
        TerminalTabs: {
          props: ["sessionId"],
          template: '<div data-testid="terminal-tabs" :data-session-id="sessionId" />',
        },
      },
    },
  });

  expect(wrapper.text()).toContain("mainPanel.taskSettingUp");
  expect(wrapper.find('[data-testid="terminal-tabs"]').exists()).toBe(false);

  await wrapper.setProps({
    uiItem: { id: ready.id, state: "ready", taskId: ready.id, task: ready },
  });
  expect(wrapper.get('[data-testid="terminal-tabs"]')
    .attributes("data-session-id")).toBe("task-real");
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/MainPanel.test.ts -t "durable task"
```

Expected: FAIL because `MainPanel` has no `uiItem` lifecycle prop.

- [ ] **Step 3: Add an explicit initializing branch**

In `MainPanel.vue`, replace the persisted-item prop with the UI union and derive the ready task/session explicitly:

```ts
import type { TaskUiItem } from "../stores/taskInitialization";

const props = defineProps<{
  uiItem: TaskUiItem | null;
  repoPath?: string;
}>();

const readyTaskUiItem = computed(() =>
  props.uiItem?.state === "ready" ? props.uiItem : null,
);
const item = computed(() => readyTaskUiItem.value?.task ?? null);
const terminalSessionId = computed(() => readyTaskUiItem.value?.taskId ?? null);
```

Keep the other currently declared props byte-for-byte and delete only `pendingSetup?: boolean`.

Put this branch before the existing ready `item` branch:

```vue
<template v-if="uiItem?.state === 'initializing'">
  <TaskHeader v-if="!maximized" :item="uiItem" />
  <div class="setup-placeholder">
    <p class="setup-title">{{ $t('mainPanel.taskSettingUp') }}</p>
  </div>
</template>
```

Insert that branch immediately before the current `<template v-if="item">`, then change the current opening tag to `<template v-else-if="item">`. Add `v-if="terminalSessionId"` to `TerminalTabs` and change its binding to `:session-id="terminalSessionId"`. Its other children and props remain unchanged. No terminal exists under the initializing branch, and the ready terminal receives `ReadyTaskUiItem.taskId` rather than the UI item id.

- [ ] **Step 4: Narrow `TaskHeader` to display fields**

Replace its `PipelineItem` prop with:

```ts
interface TaskHeaderItem {
  stage: string;
  display_name: string | null;
  issue_title?: string | null;
  prompt: string | null;
  branch?: string | null;
  port_env?: string | null;
  issue_number?: number | null;
  pr_number?: number | null;
  pr_url?: string | null;
}

const props = defineProps<{ item: TaskHeaderItem }>();
```

Keep title, tooltip, ports, branch, issue, and PR rendering unchanged; ready-only fields render nothing during initialization.

- [ ] **Step 5: Wire `App.vue` to the UI-item union**

Import `toReadyTaskUiItem` and add:

```ts
const mainPanelUiItem = computed(() =>
  store.currentInitializingItem
    ?? (mainPanelItem.value ? toReadyTaskUiItem(mainPanelItem.value) : null),
);
```

Pass `:ui-item="mainPanelUiItem"` to `MainPanel`; remove `:item` and the old `pending-setup` prop.

In `MainPanel.test.ts`, import `toReadyTaskUiItem` and change every existing ready-task mount from `item: task` to `uiItem: toReadyTaskUiItem(task)`. Change existing empty mounts from `item: null` to `uiItem: null`.

- [ ] **Step 6: Run the main-panel tests and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/MainPanel.test.ts
```

Expected: PASS; the only mounted terminal carries `task-real`.

### Task 5: Render initializing items in the sidebar without task capabilities

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue`
- Modify: `apps/desktop/src/components/__tests__/Sidebar.test.ts`

- [ ] **Step 1: Write a failing sidebar test**

Replace the simple store mock with a hoisted mutable store fixture:

```ts
const sidebarStore = vi.hoisted(() => ({
  initializingTaskItems: [] as Array<{
    id: string;
    state: "initializing";
    taskId: string | null;
    repo_id: string;
    prompt: string;
    display_name: string | null;
    pipeline: string;
    stage: string;
    agent_type: "pty";
    agent_provider: "claude";
    created_at: string;
  }>,
}));

vi.mock("../../stores/kanna", () => ({
  useKannaStore: () => ({
    getStageOrder,
    initializingTaskItems: sidebarStore.initializingTaskItems,
  }),
}));
```

Then add:

```ts
it("renders and selects an initializing UI item without task controls", async () => {
  sidebarStore.initializingTaskItems = [{
    id: "create-1",
    state: "initializing",
    taskId: null,
    repo_id: "repo-1",
    prompt: "Initialize this task",
    display_name: null,
    pipeline: "default",
    stage: "in progress",
    agent_type: "pty",
    agent_provider: "claude",
    created_at: "2026-07-10T00:00:00.000Z",
  }];
  const wrapper = mountSidebar([], "create-1");

  const row = wrapper.get('[data-initializing-item-id="create-1"]');
  expect(row.text()).toContain("Initialize this task");
  expect(row.classes()).toContain("selected");
  expect(row.find(".rename-input").exists()).toBe(false);

  await row.trigger("click");
  expect(wrapper.emitted("select-item")?.at(-1)).toEqual(["create-1"]);
});
```

Reset `sidebarStore.initializingTaskItems = []` in `beforeEach` so existing sidebar tests remain isolated.

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts -t "initializing UI item"
```

Expected: FAIL because initializing rows are not rendered.

- [ ] **Step 3: Render a non-draggable initialization section**

In `Sidebar.vue`, import `InitializingTaskItem` and add:

```ts
function initializingItemsForRepo(repoId: string): InitializingTaskItem[] {
  const query = trimmedSearchQuery.value.toLowerCase();
  return store.initializingTaskItems
    .filter((item) => item.repo_id === repoId)
    .filter((item) => !query || [item.display_name, item.prompt]
      .some((value) => value?.toLowerCase().includes(query)))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function initializingItemTitle(item: InitializingTaskItem): string {
  return item.display_name || item.prompt || t("tasks.untitled");
}

function handleSelectInitializingItem(item: InitializingTaskItem): void {
  emit("select-repo", item.repo_id);
  emit("select-item", item.id);
}
```

Before draggable ready-task sections for each expanded repo, render:

```vue
<template v-if="initializingItemsForRepo(repo.id).length > 0">
  <div class="section-label">
    {{ initializingItemsForRepo(repo.id)[0]?.stage }}
  </div>
  <div class="type-zone initializing-zone">
    <div
      v-for="initializing in initializingItemsForRepo(repo.id)"
      :key="initializing.id"
      class="pipeline-item initializing-item"
      :class="{ selected: selectedItemId === initializing.id }"
      :data-initializing-item-id="initializing.id"
      @click="handleSelectInitializingItem(initializing)"
    >
      <span class="item-title" :title="initializingItemTitle(initializing)">
        {{ initializingItemTitle(initializing) }}
      </span>
    </div>
  </div>
</template>
```

Include initializing rows in repo counts. Do not put them through draggable, rename, pin, parent, blocker, review-badge, or task-action paths while `taskId` is null.

- [ ] **Step 4: Run sidebar tests and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run src/components/__tests__/Sidebar.test.ts
```

Expected: PASS for the new row and all existing sidebar behavior.

### Task 6: Remove obsolete fake-task setup bookkeeping

**Files:**
- Delete: `apps/desktop/src/stores/taskCreationPlaceholder.ts`
- Delete: `apps/desktop/src/stores/taskCreationPlaceholder.test.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/taskRuntimeStatus.ts`
- Modify: `apps/desktop/src/stores/taskRuntimeStatus.test.ts`
- Modify: `apps/desktop/src/stores/sessions.test.ts`
- Modify: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Delete the fake placeholder factory and test**

Delete both files, then run:

```bash
rg -n "taskCreationPlaceholder|buildPendingTaskPlaceholder" apps/desktop/src
```

Expected: no matches.

- [ ] **Step 2: Remove `pendingSetupIds` from store state and exports**

Delete `pendingSetupIds` from `StoreState`, `createStoreState()`, and the return value in `kanna.ts`. `initializingTaskItems` is now the single source of initialization truth.

- [ ] **Step 3: Remove runtime suppression for fake persisted placeholders**

In `sessions.ts`, remove the `shouldIgnoreRuntimeStatusDuringSetup` import and block:

```ts
if (shouldIgnoreRuntimeStatusDuringSetup(
  status,
  context.state.pendingSetupIds.value.includes(item.id),
)) {
  return;
}
```

Delete `shouldIgnoreRuntimeStatusDuringSetup` from `taskRuntimeStatus.ts` and its four-test describe block from `taskRuntimeStatus.test.ts`. Keep `resolveActivityForRuntimeStatus` unchanged.

- [ ] **Step 4: Update manual fixtures and stale mocks**

Remove `pendingSetupIds` and `taskCreationPlaceholder` mocks from:

```text
apps/desktop/src/stores/sessions.test.ts
apps/desktop/src/stores/kanna.querySnapshot.test.ts
apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts
apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
```

Add `initializingTaskItems: ref([])` only where tests manually construct `StoreState`; tests using `createStoreState()` receive it automatically.

- [ ] **Step 5: Run the affected store suite and verify GREEN**

```bash
pnpm --dir apps/desktop exec vitest run \
  src/stores/taskInitialization.test.ts \
  src/stores/selection.test.ts \
  src/stores/kanna.taskBaseBranch.test.ts \
  src/stores/sessions.test.ts \
  src/stores/taskRuntimeStatus.test.ts \
  src/stores/kanna.querySnapshot.test.ts \
  src/stores/kanna.runtimeStatusSync.test.ts
```

Expected: PASS with no missing fields or stale module mocks.

### Task 7: Verify the regression and surrounding behavior

**Files:**
- Review all changed files.

- [ ] **Step 1: Run the focused lifecycle suite**

```bash
pnpm --dir apps/desktop exec vitest run \
  src/stores/taskInitialization.test.ts \
  src/stores/selection.test.ts \
  src/stores/kanna.taskBaseBranch.test.ts \
  src/components/__tests__/MainPanel.test.ts \
  src/components/__tests__/Sidebar.test.ts
```

Expected: PASS. The tests demonstrate that `create-*` UI IDs never enter `store.items` or `TerminalTabs`, while the server task ID does.

- [ ] **Step 2: Run the full desktop unit suite**

```bash
pnpm --dir apps/desktop test
```

Expected: PASS with no regressions.

- [ ] **Step 3: Run TypeScript and production frontend checks**

```bash
pnpm --dir apps/desktop build
```

Expected: `vue-tsc --noEmit` and `vite build` both succeed.

- [ ] **Step 4: Inspect the final diff and identity boundaries**

```bash
git diff --check
git diff --stat
git diff -- apps/desktop/src/stores/taskInitialization.ts \
  apps/desktop/src/stores/taskItemActions.ts \
  apps/desktop/src/stores/selection.ts \
  apps/desktop/src/components/MainPanel.vue \
  apps/desktop/src/components/Sidebar.vue
```

Expected:

- `git diff --check` produces no output.
- Initializing items are never added to `PipelineItem[]`.
- `TerminalTabs.sessionId` comes only from a ready `PipelineItem.id`.
- Task actions cannot resolve an initializing UI id as a task id.
- No terminal recovery behavior was weakened or suppressed.

- [ ] **Step 5: Leave the worktree uncommitted for pipeline handoff**

```bash
git status --short
```

Expected: only this task's design, plan, implementation, and test files are changed. Do not commit, push, or create a pull request in this stage.
