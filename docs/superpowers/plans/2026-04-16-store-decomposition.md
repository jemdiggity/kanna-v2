# Store Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `apps/desktop/src/stores/kanna.ts` into a thin composition root backed by focused store modules without changing task, session, workflow, or startup behavior.

**Architecture:** Keep one top-level `useKannaStore()` Pinia store, but move its domain logic into plain TypeScript modules with explicit boundaries. Extract shared reactive state first, then move isolated ownership areas (`ports`, `workflow`, `selection`), then move the coupled session/task logic, and finally move startup wiring into `init.ts` so `kanna.ts` becomes assembly code rather than a monolith.

**Tech Stack:** Vue 3, Pinia, TypeScript, VueUse `computedAsync`/`watchDebounced`, Vitest, existing `@kanna/db` query helpers, existing Tauri invoke/listen bridges

---

## File Structure

### New Files

- `apps/desktop/src/stores/state.ts`
  Purpose: shared refs, computed async DB reads, caches, helper types, and the store context factory.
- `apps/desktop/src/stores/ports.ts`
  Purpose: independent domain store for `task_port` reservation, release, and close-with-release behavior.
- `apps/desktop/src/stores/workflow.ts`
  Purpose: workflow/agent loading, stage-order lookup, `advanceStage()`, and `rerunStage()`.
- `apps/desktop/src/stores/selection.ts`
  Purpose: selection state, history, hidden-item rules, sidebar sorting, and persisted selection helpers.
- `apps/desktop/src/stores/sessions.ts`
  Purpose: PTY/shell session preparation, spawn, prewarm, runtime status sync, and session-exit waiters.
- `apps/desktop/src/stores/tasks.ts`
  Purpose: repo actions, task lifecycle actions, blocked-task actions, and orchestration across sessions/workflow/ports.
- `apps/desktop/src/stores/init.ts`
  Purpose: startup behavior and Tauri event registration.

### Modified Files

- `apps/desktop/src/stores/kanna.ts`
  Purpose after refactor: define store, create shared state/context, compose extracted modules, return final API.
- `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
  Purpose: keep runtime-status coverage aligned with the extracted session/init wiring.
- `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
  Purpose: keep task creation/base-branch coverage aligned with the extracted task/workflow/ports flow.

### Optional New Tests If Extraction Creates a Clean Seam

- `apps/desktop/src/stores/ports.test.ts`
  Purpose: validate port allocation/release invariants without pulling the entire store into scope.

## Task 1: Extract Shared State And Context

**Files:**
- Create: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Write the failing type/test seam for extracted shared state**

Add an export-level seam in the runtime-status test so the store can still be initialized through `useKannaStore()` after state extraction. Keep the test focused on observable behavior, not file layout.

```ts
const store = useKannaStore();
await store.init(db);
await nextTick();

expect(store.repos).toBeDefined();
expect(store.items).toBeDefined();
```

- [ ] **Step 2: Run the targeted test before extraction**

Run: `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS before refactor, giving a known-good baseline for later regressions.

- [ ] **Step 3: Create `state.ts` with shared refs, caches, and context types**

Move the state and helper types out of `kanna.ts` into a context factory that still supports the current store behavior.

```ts
export interface StoreState {
  refreshKey: Ref<number>;
  repos: Ref<Repo[]>;
  items: Ref<PipelineItem[]>;
  selectedRepoId: Ref<string | null>;
  selectedItemId: Ref<string | null>;
  pendingSetupIds: Ref<string[]>;
  suspendAfterMinutes: Ref<number>;
  killAfterMinutes: Ref<number>;
  ideCommand: Ref<string>;
  hideShortcutsOnStartup: Ref<boolean>;
  devLingerTerminals: Ref<boolean>;
  lastHiddenRepoId: Ref<string | null>;
  lastSelectedItemByRepo: Ref<Record<string, string>>;
  workflowCache: Map<string, WorkflowDefinition>;
  agentCache: Map<string, AgentDefinition>;
  stageOrderCache: Map<string, string[]>;
}

export interface StoreContext {
  db: DbHandle;
  toast: ReturnType<typeof useToast>;
  state: StoreState;
  bump: () => void;
  tt: (key: string) => string;
}
```

- [ ] **Step 4: Rewire `kanna.ts` to consume the new state/context factory**

Leave the public store entry point intact, but stop declaring the refs and caches inline.

```ts
const state = createStoreState();
const bump = () => {
  state.refreshKey.value += 1;
};

const context = createStoreContext({
  db: _db,
  toast,
  state,
  bump,
});
```

- [ ] **Step 5: Run the targeted test again**

Run: `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS with no behavior change.

- [ ] **Step 6: Commit the shared-state extraction**

```bash
git add apps/desktop/src/stores/state.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts
git commit -m "refactor: extract shared kanna store state"
```

## Task 2: Extract Port And Workflow Domain Logic

**Files:**
- Create: `apps/desktop/src/stores/ports.ts`
- Create: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/ports.test.ts`

- [ ] **Step 1: Write the failing extraction tests for ports and task base-branch behavior**

Preserve the existing task-base-branch test and add a focused port seam if the extracted module exposes a stable unit-test surface.

```ts
const allocated = await portStore.claimTaskPorts("task-1", {
  ports: { KANNA_DEV_PORT: 1420 },
});

expect(allocated.portEnv).toEqual({ KANNA_DEV_PORT: "1421" });
expect(allocated.firstPort).toBe(1421);
```

- [ ] **Step 2: Run the affected tests before extraction**

Run: `pnpm exec vitest apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
Expected: PASS before refactor.

- [ ] **Step 3: Move task port allocation into `ports.ts`**

Extract the allocation lock and claim/release lifecycle into an independent domain store-like module that takes `DbHandle` explicitly.

```ts
export interface PortsStore {
  claimTaskPorts(itemId: string, repoConfig: RepoConfig): Promise<AllocatedPorts>;
  releaseTaskPorts(itemId: string): Promise<void>;
  closeTaskAndReleasePorts(
    itemId: string,
    closeFn: (id: string) => Promise<void>,
  ): Promise<void>;
}

export function createPortsStore(db: DbHandle): PortsStore {
  let allocationChain: Promise<void> = Promise.resolve();
  // existing claim/release logic moves here
}
```

- [ ] **Step 4: Move workflow/agent loading and stage actions into `workflow.ts`**

Keep repo-config-backed stage order and workflow caches in one place.

```ts
export interface WorkflowApi {
  getStageOrder(repoId: string): readonly string[];
  loadWorkflow(repoPath: string, workflowName: string): Promise<WorkflowDefinition>;
  loadAgent(repoPath: string, agentName: string): Promise<AgentDefinition>;
  advanceStage(taskId: string): Promise<void>;
  rerunStage(taskId: string): Promise<void>;
}
```

- [ ] **Step 5: Rewire `kanna.ts` and remaining task code to call `ports` and `workflow`**

The main store should compose these modules instead of owning their logic directly.

```ts
const ports = createPortsStore(_db);
const workflow = createWorkflowApi(context);

return {
  loadWorkflow: workflow.loadWorkflow,
  loadAgent: workflow.loadAgent,
  advanceStage: workflow.advanceStage,
  rerunStage: workflow.rerunStage,
};
```

- [ ] **Step 6: Run the targeted tests after extraction**

Run:
- `pnpm exec vitest apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- `pnpm exec vitest apps/desktop/src/stores/ports.test.ts`

Expected: PASS. If `ports.test.ts` is not added, the first command remains required.

- [ ] **Step 7: Commit the domain extraction**

```bash
git add apps/desktop/src/stores/ports.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts apps/desktop/src/stores/ports.test.ts
git commit -m "refactor: extract store domain modules"
```

## Task 3: Extract Selection And Session Management

**Files:**
- Create: `apps/desktop/src/stores/selection.ts`
- Create: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Write the failing session/selection preservation test**

Lock in the behavior that runtime status changes still update item activity after the extraction.

```ts
mockState.sessionStatuses = [{ session_id: "task-1", status: "busy" }];

await store.init(db);
mockState.emit("daemon_ready", {});
await nextTick();

expect(mockState.workflowItems[0]?.activity).toBe("working");
```

- [ ] **Step 2: Run the runtime-status test before extraction**

Run: `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS before refactor.

- [ ] **Step 3: Move selection/history/sorting into `selection.ts`**

Extract all item visibility, sorting, navigation, and persisted selection behavior into a focused module.

```ts
export interface SelectionApi {
  selectedRepo: ComputedRef<Repo | null>;
  currentItem: ComputedRef<PipelineItem | null>;
  sortedItemsForCurrentRepo: ComputedRef<PipelineItem[]>;
  sortedItemsAllRepos: ComputedRef<PipelineItem[]>;
  selectRepo(repoId: string): Promise<void>;
  selectItem(itemId: string): Promise<void>;
  restoreSelection(itemId: string): void;
  goBack(): void;
  goForward(): void;
}
```

- [ ] **Step 4: Move PTY/shell/runtime-sync logic into `sessions.ts`**

This module should own session waiters, shell prewarm, PTY command preparation, and daemon status synchronization.

```ts
export interface SessionsApi {
  spawnShellSession(
    sessionId: string,
    cwd: string,
    portEnv?: string | null,
    isWorktree?: boolean,
    fallbackCwd?: string | null,
  ): Promise<void>;
  spawnPtySession(
    sessionId: string,
    cwd: string,
    prompt: string,
    cols?: number,
    rows?: number,
    options?: PtySpawnOptions,
  ): Promise<void>;
  scheduleRuntimeStatusSync(sessionId: string): void;
  waitForSessionExit(sessionId: string): Promise<void>;
}
```

- [ ] **Step 5: Recompose the store around the extracted APIs**

`kanna.ts` should import the module factories and return their public surface instead of owning the implementation.

```ts
const selection = createSelectionApi(context);
const sessions = createSessionsApi(context);

return {
  selectedRepo: selection.selectedRepo,
  currentItem: selection.currentItem,
  sortedItemsForCurrentRepo: selection.sortedItemsForCurrentRepo,
  sortedItemsAllRepos: selection.sortedItemsAllRepos,
  selectRepo: selection.selectRepo,
  selectItem: selection.selectItem,
  goBack: selection.goBack,
  goForward: selection.goForward,
  spawnShellSession: sessions.spawnShellSession,
  spawnPtySession: sessions.spawnPtySession,
};
```

- [ ] **Step 6: Run the runtime-status test again**

Run: `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS with runtime status updates still flowing through daemon events.

- [ ] **Step 7: Commit the extraction**

```bash
git add apps/desktop/src/stores/selection.ts apps/desktop/src/stores/sessions.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts
git commit -m "refactor: extract store selection and sessions"
```

## Task 4: Extract Task Lifecycle And Startup Wiring

**Files:**
- Create: `apps/desktop/src/stores/tasks.ts`
- Create: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing integration-preservation tests for init/task flows**

Keep existing store-level tests as the integration harness so the refactor does not silently break startup or task creation behavior.

```ts
const store = useKannaStore();
await store.init(db);

await store.createItem("repo-1", "/tmp/repo", "Ship it");

expect(store.items.some((item) => item.prompt === "Ship it")).toBe(true);
```

- [ ] **Step 2: Run the store-level tests before extraction**

Run:
- `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm exec vitest apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

Expected: PASS before moving the orchestration code.

- [ ] **Step 3: Move repo/task/blocker lifecycle actions into `tasks.ts`**

This module owns the mutation-heavy flows and composes the already-extracted `ports`, `workflow`, `selection`, and `sessions` APIs.

```ts
export interface TasksApi {
  importRepo(path: string, name: string, defaultBranch: string): Promise<void>;
  createRepo(name: string, path: string): Promise<void>;
  cloneAndImportRepo(url: string, destination: string): Promise<void>;
  hideRepo(repoId: string): Promise<void>;
  createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType?: "pty" | "sdk",
    opts?: CreateItemOptions,
  ): Promise<void>;
  closeTask(targetItemId?: string, opts?: { selectNext?: boolean }): Promise<void>;
  undoClose(): Promise<void>;
  blockTask(blockerIds: string[]): Promise<void>;
  editBlockedTask(itemId: string, newBlockerIds: string[]): Promise<void>;
}
```

- [ ] **Step 4: Move startup and event-listener orchestration into `init.ts`**

Keep `init(db)` as the entry point, but move listener registration and startup recovery behavior behind a focused module.

```ts
export interface InitApi {
  init(db: DbHandle): Promise<void>;
}

listen("session_exit", async (event: unknown) => {
  // delegate to sessions/tasks behavior
});
```

- [ ] **Step 5: Slim `kanna.ts` down to a composition root**

After all extractions, `kanna.ts` should mostly create the module instances and return their API surface.

```ts
export const useKannaStore = defineStore("kanna", () => {
  const toast = useToast();
  const state = createStoreState();
  const ports = createPortsStore(_db);
  const selection = createSelectionApi(context);
  const sessions = createSessionsApi(context);
  const workflow = createWorkflowApi(context);
  const tasks = createTasksApi(context);
  const initApi = createInitApi(context);

  return {
    ...state.publicState,
    ...selection,
    ...sessions,
    ...workflow,
    ...tasks,
    init: initApi.init,
  };
});
```

- [ ] **Step 6: Run the targeted tests after the final extraction**

Run:
- `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm exec vitest apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

Expected: PASS with no task or startup regressions.

- [ ] **Step 7: Commit the final decomposition**

```bash
git add apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "refactor: decompose kanna store"
```

## Task 5: Full Verification And Cleanup

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/ports.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Run TypeScript verification**

Run: `pnpm exec tsc --noEmit`
Expected: PASS with no `any`, no missing exports, and no circular type fallout from the new module boundaries.

- [ ] **Step 2: Run focused store tests**

Run:
- `pnpm exec vitest apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm exec vitest apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- `pnpm exec vitest apps/desktop/src/stores/ports.test.ts`

Expected: PASS. If `ports.test.ts` was not added, skip that command and note it in the final summary.

- [ ] **Step 3: Check the line count target**

Run: `wc -l apps/desktop/src/stores/kanna.ts`
Expected: a result in the requested 300-500 line range, or a narrowly justified small variance if unavoidable.

- [ ] **Step 4: Review the final diff for boundary drift**

Run: `git diff --stat`
Expected: `kanna.ts` shrinks materially and the new modules each own one coherent responsibility.

- [ ] **Step 5: Commit the verification cleanup**

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/selection.ts apps/desktop/src/stores/sessions.ts apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/ports.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "test: verify store decomposition"
```
