# DB Query Layer With Embedded Optimistic Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `bump()` / `refreshKey` from the Kanna desktop store by introducing a DB-backed query layer that exposes reactive refs and owns optimistic overlays for temporary task UI state.

**Architecture:** Add `queries.ts` as the only owner of DB-backed `repos` and `items`, including canonical loading, optimistic overlays, merged reactive refs, and refresh methods. Rewire the existing store modules so they mutate the DB through actions and ask the query layer to reconcile, while the UI only reads reactive query refs and never patches canonical collections directly.

**Tech Stack:** Vue 3 refs/computed, Pinia setup store, TypeScript, `@kanna/db` query helpers, Tauri SQL plugin, Vitest

---

## File Structure

### New Files

- `apps/desktop/src/stores/queries.ts`
  Purpose: own canonical DB-backed `repos`/`items`, optimistic overlays, merged refs, and refresh helpers.

### Modified Files

- `apps/desktop/src/stores/state.ts`
  Purpose after change: keep selection/preferences/caches/runtime refs, but remove `refreshKey`, `bump`, and DB-backed collection ownership.
- `apps/desktop/src/stores/kanna.ts`
  Purpose after change: compose the query layer into the top-level store and stop exporting `bump()` / `refreshKey`.
- `apps/desktop/src/stores/tasks.ts`
  Purpose after change: stop directly mutating `items.value`; task creation placeholder and related optimism move into `queries.ts`.
- `apps/desktop/src/stores/sessions.ts`
  Purpose after change: write runtime status to the DB and trigger query reconciliation through `queries.ts`.
- `apps/desktop/src/stores/workflow.ts`
  Purpose after change: stage transitions/reruns update via query refresh rather than `context.bump()`.
- `apps/desktop/src/stores/init.ts`
  Purpose after change: startup loads and reloads through the query layer instead of using a global invalidation token.
- `apps/desktop/src/stores/selection.ts`
  Purpose after change: consume query-backed refs as ordinary reactive arrays without any direct knowledge of canonical vs optimistic data.
- `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
  Purpose: prove runtime status updates still flow into reactive item data.
- `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
  Purpose: prove task creation, undo, and blocked task flows still reconcile correctly through the query layer.
- `apps/desktop/src/stores/kannaConfig.test.ts`
  Purpose: protect the existing helper exports while the store internals change.

## Task 1: Introduce Query Layer For Canonical DB Reads

**Files:**
- Create: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Write the failing read-model test seam**

Add a small assertion in the existing runtime-status test that the store still exposes reactive `repos` and `items` without relying on `refreshKey`.

```ts
const store = useKannaStore();
await store.init(db);

expect(Array.isArray(store.repos)).toBe(false);
expect(store.repos.value).toBeDefined();
expect(store.items.value).toBeDefined();
```

- [ ] **Step 2: Run the targeted test before the refactor**

Run: `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS before changes, establishing the baseline behavior.

- [ ] **Step 3: Create `queries.ts` with canonical refs and refresh helpers**

Define query-owned refs and explicit refresh methods, but do not add optimistic overlays yet.

```ts
export interface QueryState<T> {
  data: ComputedRef<T>;
  pending: Ref<boolean>;
  error: Ref<unknown>;
  refresh: () => Promise<void>;
}

export interface QueriesApi {
  repos: QueryState<Repo[]>;
  items: QueryState<PipelineItem[]>;
  loadInitialData(): Promise<void>;
  reloadRepos(): Promise<void>;
  reloadItems(): Promise<void>;
  reloadAll(): Promise<void>;
}
```

- [ ] **Step 4: Remove `refreshKey` / `computedAsync` ownership from `state.ts`**

Replace DB-backed `repos` and `items` ownership with plain long-lived refs or query-facing placeholders owned by `queries.ts`.

```ts
export interface StoreState {
  db: Ref<DbHandle | null>;
  selectedRepoId: Ref<string | null>;
  selectedItemId: Ref<string | null>;
  // no refreshKey
  // no bump
}
```

- [ ] **Step 5: Compose the query layer in `kanna.ts`**

Wire query-backed refs into the top-level store and stop exporting `refreshKey` or `bump`.

```ts
const queries = createQueriesApi(context);

return {
  repos: queries.repos.data,
  items: queries.items.data,
  refreshRepos: queries.repos.refresh,
  refreshItems: queries.items.refresh,
};
```

- [ ] **Step 6: Run the targeted test after the extraction**

Run: `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
Expected: PASS, with no dependency on `refreshKey`.

- [ ] **Step 7: Commit the canonical query-layer introduction**

```bash
git add apps/desktop/src/stores/queries.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts
git commit -m "refactor: add canonical db query layer"
```

## Task 2: Add Embedded Optimistic Item Overlays

**Files:**
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing optimistic placeholder test**

Extend the task-creation test harness to prove a pending task appears immediately via the exposed reactive items before canonical reconciliation completes.

```ts
const createPromise = store.createItem("repo-1", "/tmp/repo", "Ship it", "sdk", {
  agentProvider: "claude",
});

expect(store.items.value.some((item) => item.prompt === "Ship it")).toBe(true);

await createPromise;
```

- [ ] **Step 2: Run the affected test before implementing overlays**

Run: `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`
Expected: PASS baseline before the optimistic implementation changes.

- [ ] **Step 3: Add optimistic overlay support to `queries.ts`**

Implement an internal overlay map and expose merged `items` that combine canonical rows with temporary optimistic entries.

```ts
interface OptimisticItemOverlay {
  key: string;
  apply(base: PipelineItem[]): PipelineItem[];
}

const optimisticItems = ref<OptimisticItemOverlay[]>([]);

const mergedItems = computed(() => {
  let result = baseItems.value;
  for (const overlay of optimisticItems.value) {
    result = overlay.apply(result);
  }
  return result;
});
```

- [ ] **Step 4: Add an optimistic helper for task-style mutations**

Encapsulate optimistic lifecycle management so `tasks.ts` does not patch `items` directly.

```ts
async function withOptimisticItemOverlay<T>(input: {
  key: string;
  apply(base: PipelineItem[]): PipelineItem[];
  run: () => Promise<T>;
  reconcile?: () => Promise<void>;
}): Promise<T> {
  addOverlay(input.key, input.apply);
  try {
    const result = await input.run();
    await (input.reconcile?.() ?? reloadItems());
    return result;
  } finally {
    removeOverlay(input.key);
  }
}
```

- [ ] **Step 5: Rework `tasks.ts` task creation to use the query-layer overlay**

Delete direct `items.value = ...` mutation and move pending placeholder behavior behind the query helper.

```ts
await queries.withOptimisticItemOverlay({
  key: `create:${id}`,
  apply: (base) => [pendingPlaceholder, ...base.filter((item) => item.id !== id)],
  run: async () => {
    await insertPipelineItem(db, payload);
    await queries.reloadItems();
  },
});
```

- [ ] **Step 6: Run the task-flow test after the overlay migration**

Run: `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`
Expected: PASS, with pending task visibility and reconciliation preserved.

- [ ] **Step 7: Commit the optimistic overlay migration**

```bash
git add apps/desktop/src/stores/queries.ts apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "refactor: move optimistic task overlays into queries"
```

## Task 3: Replace `bump()` Calls Across Store Modules

**Files:**
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [ ] **Step 1: Write the failing post-mutation refresh test**

Add or extend tests so DB writes triggered by runtime status or task mutations are observed through the query-backed `items` ref without any `bump()` export.

```ts
mockState.sessionStatuses = [{ session_id: "task-1", status: "busy" }];
mockState.emit("daemon_ready", {});
await nextTick();

expect(store.items.value.find((item) => item.id === "task-1")?.activity).toBe("working");
```

- [ ] **Step 2: Run the store tests before removing `bump()`**

Run:
- `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`

Expected: PASS before the replacement.

- [ ] **Step 3: Replace task-module `context.bump()` calls with query refreshes**

Use the narrowest correct query-layer methods for each mutation site.

```ts
await updatePipelineItemActivity(db, item.id, nextActivity);
await queries.reloadItems();
```

- [ ] **Step 4: Replace session/workflow/init invalidation with query refreshes**

Daemon-driven updates, startup recovery, and stage changes should all reconcile through the query layer.

```ts
await closePipelineItem(db, item.id);
await queries.reloadItems();

await insertRepo(db, repo);
await queries.reloadRepos();
```

- [ ] **Step 5: Remove `bump()` from the store API**

Delete `bump` from `StoreContext`, `kanna.ts`, and any dependent imports/usages.

```ts
export interface StoreContext {
  state: StoreState;
  services: StoreServices;
  toast: ReturnType<typeof useToast>;
  requireDb: () => DbHandle;
  tt: (key: string) => string;
}
```

- [ ] **Step 6: Run the store tests after removing `bump()`**

Run:
- `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`

Expected: PASS, with query-layer refreshes fully replacing `bump()`.

- [ ] **Step 7: Commit the invalidation cleanup**

```bash
git add apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/sessions.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/selection.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "refactor: remove store bump invalidation"
```

## Task 4: Preserve Helper Exports And Query Compatibility

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/kannaConfig.test.ts`
- Test: `apps/desktop/src/stores/kannaConfig.test.ts`

- [ ] **Step 1: Write the failing compatibility test**

Keep the helper-export contract intact while the store internals change.

```ts
import { collectTeardownCommands, readRepoConfig } from "./kanna";

await expect(readRepoConfig("/repo/.kanna-worktrees/task-123")).resolves.toEqual({});
```

- [ ] **Step 2: Run the config test before changes**

Run: `pnpm test -- src/stores/kannaConfig.test.ts`
Expected: PASS before compatibility adjustments.

- [ ] **Step 3: Preserve re-exports through the slim store boundary**

Ensure `kanna.ts` continues to re-export the helper functions after query-layer integration.

```ts
export { readRepoConfig } from "./state";
export { collectTeardownCommands } from "./tasks";
```

- [ ] **Step 4: Run the config test again**

Run: `pnpm test -- src/stores/kannaConfig.test.ts`
Expected: PASS after the query-layer refactor.

- [ ] **Step 5: Commit the compatibility preservation**

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/kannaConfig.test.ts
git commit -m "test: preserve store helper exports"
```

## Task 5: Full Verification And Architecture Check

**Files:**
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kannaConfig.test.ts`

- [ ] **Step 1: Run TypeScript verification**

Run: `pnpm exec tsc --noEmit`
Expected: PASS with no remaining `refreshKey`, `bump`, or direct canonical collection patching outside `queries.ts`.

- [ ] **Step 2: Run focused store tests**

Run:
- `pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`
- `pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`
- `pnpm test -- src/stores/kannaConfig.test.ts`

Expected: PASS with query-backed reactivity and compatibility preserved.

- [ ] **Step 3: Confirm `bump()` and `refreshKey` are gone from store code**

Run: `rg -n "\\bbump\\b|refreshKey" apps/desktop/src/stores`
Expected: no matches in active store architecture, except possibly historical comments/tests that should be cleaned up if present.

- [ ] **Step 4: Review the diff for architectural drift**

Run: `git diff --stat`
Expected: `queries.ts` owns DB-backed collection logic, and no other module mutates canonical `repos`/`items` directly.

- [ ] **Step 5: Commit the final query-layer architecture**

```bash
git add apps/desktop/src/stores/queries.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/sessions.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts apps/desktop/src/stores/kanna.taskBaseBranch.test.ts apps/desktop/src/stores/kannaConfig.test.ts
git commit -m "refactor: add db-backed reactive query layer"
```
