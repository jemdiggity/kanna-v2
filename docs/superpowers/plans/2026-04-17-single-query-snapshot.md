# Single Query Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace split repo/item query invalidation with one canonical repo+task snapshot and add regression coverage for repo visibility and optimistic task flows.

**Architecture:** `queries.ts` becomes the single owner of visible repo/task query state and publishes one canonical snapshot plus derived `repos`/`items` computeds. Store mutations stop choosing between repo-only and item-only reloads and instead reconcile through one snapshot reload, with optimistic item overlays applied against the snapshot rather than a standalone item list.

**Tech Stack:** Vue 3 refs/computed, Pinia setup store, Vitest, `@kanna/db` query helpers

---

## File Structure

- Modify: `apps/desktop/src/stores/queries.ts`
  - Replace split `baseRepos` / `baseItems` ownership with one canonical snapshot and one canonical reload path.
- Modify: `apps/desktop/src/stores/state.ts`
  - Remove snapshot-invalidating service surface that leaks repo/item split.
- Modify: `apps/desktop/src/stores/kanna.ts`
  - Wire the single snapshot reload service into the composed store API.
- Modify: `apps/desktop/src/stores/tasks.ts`
  - Replace repo-only/item-only refresh calls with snapshot reloads and keep optimistic item transitions working.
- Modify: `apps/desktop/src/stores/init.ts`
  - Reconcile daemon/startup refresh paths through snapshot reload.
- Modify: `apps/desktop/src/stores/selection.ts`
  - Ensure history/selection validity is based on currently visible items from the snapshot-backed selectors.
- Modify: `apps/desktop/src/stores/sessions.ts`
  - Reconcile runtime status changes through the single snapshot reload path.
- Modify: `apps/desktop/src/stores/workflow.ts`
  - Reconcile stage reruns through the single snapshot reload path.
- Create: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
  - Regression coverage for repo visibility invalidation and hidden-repo navigation.
- Extend: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
  - Keep optimistic create/block regression checks green after the snapshot refactor.

### Task 1: Write The Failing Snapshot Regression Tests

**Files:**
- Create: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`
- Test: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`

- [ ] **Step 1: Write the failing repo visibility and navigation tests**

```ts
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";
import { useKannaStore } from "./kanna";

const mockState = vi.hoisted(() => {
  const now = "2026-04-17T00:00:00.000Z";

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    return {
      id: "repo-1",
      path: "/tmp/repo-1",
      name: "repo-1",
      default_branch: "main",
      hidden: 0,
      created_at: now,
      last_opened_at: now,
      ...overrides,
    };
  }

  function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
    return {
      id: "item-1",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      workflow: "default",
      stage: "in progress",
      stage_result: null,
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: "task-item-1",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      activity_changed_at: now,
      unread_at: null,
      port_offset: null,
      display_name: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      base_ref: null,
      claude_session_id: null,
      previous_stage: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  let repos = [makeRepo(), makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2" })];
  let workflowItems = [
    makeItem(),
    makeItem({ id: "item-2", repo_id: "repo-2", branch: "task-item-2" }),
  ];

  return {
    get repos() { return repos; },
    set repos(value: Repo[]) { repos = value; },
    get workflowItems() { return workflowItems; },
    set workflowItems(value: PipelineItem[]) { workflowItems = value; },
    makeRepo,
    makeItem,
    reset() {
      repos = [makeRepo(), makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2" })];
      workflowItems = [
        makeItem(),
        makeItem({ id: "item-2", repo_id: "repo-2", branch: "task-item-2" }),
      ];
    },
  };
});

it("removes a hidden repo and its tasks from the visible store state together", async () => {
  const store = useKannaStore();
  await store.init();

  expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
  expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);

  mockState.repos = [mockState.makeRepo()];
  await store.hideRepo("repo-2");

  expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1"]);
  expect(store.items.map((item) => item.id)).toEqual(["item-1"]);
});

it("restores an unhidden repo with its tasks from the same snapshot refresh", async () => {
  const store = useKannaStore();
  mockState.repos = [mockState.makeRepo()];
  mockState.workflowItems = [mockState.makeItem()];
  await store.init();

  mockState.repos = [mockState.makeRepo(), mockState.makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2" })];
  mockState.workflowItems = [
    mockState.makeItem(),
    mockState.makeItem({ id: "item-2", repo_id: "repo-2", branch: "task-item-2" }),
  ];

  await store.importRepo("/tmp/repo-2", "repo-2", "main");

  expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
  expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
});
```

- [ ] **Step 2: Run the new test file and verify it fails for the current split invalidation**

Run: `cd apps/desktop && pnpm test -- src/stores/kanna.querySnapshot.test.ts`

Expected: FAIL in the repo visibility assertions because repo refresh and item refresh are still decoupled.

- [ ] **Step 3: Add the hidden-repo history regression**

```ts
it("history navigation skips tasks from repos that are no longer visible", async () => {
  const store = useKannaStore();
  await store.init();

  await store.selectRepo("repo-1");
  await store.selectItem("item-1");
  await store.selectRepo("repo-2");
  await store.selectItem("item-2");

  mockState.repos = [mockState.makeRepo()];
  await store.hideRepo("repo-2");
  store.goBack();

  expect(store.selectedRepo).toMatchObject({ id: "repo-1" });
  expect(store.currentItem).toMatchObject({ id: "item-1" });
});
```

- [ ] **Step 4: Re-run the targeted test file and confirm it still fails for the intended reason**

Run: `cd apps/desktop && pnpm test -- src/stores/kanna.querySnapshot.test.ts`

Expected: FAIL in one or more assertions tied to stale task state or stale navigation validity.

- [ ] **Step 5: Commit the red tests**

```bash
git add apps/desktop/src/stores/kanna.querySnapshot.test.ts
git commit -m "test: add query snapshot regression coverage"
```

### Task 2: Implement The Single Snapshot Query Layer

**Files:**
- Modify: `apps/desktop/src/stores/queries.ts`
- Modify: `apps/desktop/src/stores/state.ts`
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/stores/tasks.ts`
- Modify: `apps/desktop/src/stores/init.ts`
- Modify: `apps/desktop/src/stores/selection.ts`
- Modify: `apps/desktop/src/stores/sessions.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Test: `apps/desktop/src/stores/kanna.querySnapshot.test.ts`

- [ ] **Step 1: Replace split query state with a canonical snapshot in `queries.ts`**

```ts
interface RepoSnapshotEntry {
  repo: Repo;
  items: PipelineItem[];
}

interface KannaSnapshot {
  entries: RepoSnapshotEntry[];
}

interface OptimisticItemOverlay {
  key: string;
  apply: (snapshot: KannaSnapshot) => KannaSnapshot;
}

const baseSnapshot = ref<KannaSnapshot>({ entries: [] });

const mergedSnapshot = computed(() => {
  let result = baseSnapshot.value;
  for (const overlay of optimisticOverlays.value) {
    result = overlay.apply(result);
  }
  return result;
});

const repos = computed(() => mergedSnapshot.value.entries.map((entry) => entry.repo));
const items = computed(() => mergedSnapshot.value.entries.flatMap((entry) => entry.items));
```

- [ ] **Step 2: Replace repo/item reload split with one canonical reload**

```ts
async function reloadSnapshot(): Promise<void> {
  pending.value = true;
  error.value = null;
  try {
    const repos = await listRepos(context.requireDb());
    const entries: RepoSnapshotEntry[] = [];

    for (const repo of repos) {
      const items = await listPipelineItems(context.requireDb(), repo.id);
      entries.push({ repo, items });

      if (!context.state.stageOrderCache.has(repo.path)) {
        const config = await readRepoConfig(repo.path).catch(() => ({}));
        if (config.stage_order) {
          context.state.stageOrderCache.set(repo.path, config.stage_order);
        }
      }
    }

    baseSnapshot.value = { entries };
    syncSnapshot();
  } finally {
    pending.value = false;
  }
}
```

- [ ] **Step 3: Keep temporary compatibility by syncing state refs from the snapshot**

```ts
function syncSnapshot(): void {
  context.state.repos.value = mergedSnapshot.value.entries.map((entry) => entry.repo);
  context.state.items.value = mergedSnapshot.value.entries.flatMap((entry) => entry.items);
}
```

- [ ] **Step 4: Move optimistic item overlays to snapshot transforms**

```ts
async function withOptimisticItemOverlay<T>(input: {
  key: string;
  apply: (snapshot: KannaSnapshot) => KannaSnapshot;
  run: () => Promise<T>;
}): Promise<T> {
  addOverlay({ key: input.key, apply: input.apply });
  try {
    const result = await input.run();
    await reloadSnapshot();
    return result;
  } finally {
    removeOverlay(input.key);
    syncSnapshot();
  }
}
```

- [ ] **Step 5: Collapse store services onto the single canonical reload path**

```ts
export interface StoreServices {
  loadInitialData?: () => Promise<void>;
  reloadSnapshot?: () => Promise<void>;
  withOptimisticItemOverlay?: <T>(input: {
    key: string;
    apply: (snapshot: KannaSnapshot) => KannaSnapshot;
    run: () => Promise<T>;
  }) => Promise<T>;
}
```

Wire it in `kanna.ts`:

```ts
services.loadInitialData = queries.loadInitialData;
services.reloadSnapshot = queries.reloadSnapshot;
services.withOptimisticItemOverlay = queries.withOptimisticItemOverlay;
```

- [ ] **Step 6: Replace repo/item-specific reload call sites**

```ts
const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();

await reloadSnapshot();
```

Use that in:

- `tasks.ts`
- `init.ts`
- `sessions.ts`
- `workflow.ts`
- `selection.ts`

The key rule is that repo visibility changes and task mutations reconcile through the same reload path.

- [ ] **Step 7: Apply optimistic item patches against snapshot entries**

```ts
apply: (snapshot) => ({
  entries: snapshot.entries.map((entry) =>
    entry.repo.id === repoId
      ? { ...entry, items: [pendingPlaceholder, ...entry.items.filter((item) => item.id !== id)] }
      : entry,
  ),
})
```

Use the blocked-task replacement transform in `tasks.ts`:

```ts
apply: (snapshot) => ({
  entries: snapshot.entries.map((entry) =>
    entry.repo.id === originalRepoId
      ? {
          ...entry,
          items: entry.items
            .filter((candidate) => candidate.id !== originalId)
            .concat(blockedReplacement),
        }
      : entry,
  ),
})
```

- [ ] **Step 8: Tighten hidden-repo navigation validity in `selection.ts`**

```ts
const validIds = new Set(
  requireService(context.services.sortedItemsAllRepos, "sortedItemsAllRepos").value.map((item) => item.id),
);
```

Use snapshot-backed visible items when validating `goBack()` and `goForward()` so hidden repos cannot remain reachable through stale task arrays.

- [ ] **Step 9: Run the targeted regression file and verify green**

Run: `cd apps/desktop && pnpm test -- src/stores/kanna.querySnapshot.test.ts`

Expected: PASS

- [ ] **Step 10: Commit the snapshot refactor**

```bash
git add apps/desktop/src/stores/queries.ts apps/desktop/src/stores/state.ts apps/desktop/src/stores/kanna.ts apps/desktop/src/stores/tasks.ts apps/desktop/src/stores/init.ts apps/desktop/src/stores/selection.ts apps/desktop/src/stores/sessions.ts apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/kanna.querySnapshot.test.ts
git commit -m "refactor: unify store query snapshot"
```

### Task 3: Re-verify Optimistic Task Flows And Full Desktop Coverage

**Files:**
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`
- Test: `apps/desktop/src/stores/kanna.runtimeStatusSync.test.ts`

- [ ] **Step 1: Add an explicit optimistic placeholder regression to the existing task test file**

```ts
it("shows the pending task placeholder before snapshot reconciliation completes", async () => {
  const store = useKannaStore();
  await store.init();

  const createPromise = store.createItem("repo-1", "/tmp/repo", "Ship it", "pty");

  expect(store.items.some((item) => item.id.startsWith("item-"))).toBe(true);

  await createPromise;
});
```

- [ ] **Step 2: Keep the blocked-task replacement regression explicit**

```ts
it("shows the blocked replacement before cleanup finishes", async () => {
  expect(store.items.find((item) => item.id === newBlockedId)?.tags).toContain("blocked");
  expect(store.items.some((item) => item.id === originalId)).toBe(false);
});
```

- [ ] **Step 3: Run the targeted optimistic-flow suites**

Run: `cd apps/desktop && pnpm test -- src/stores/kanna.taskBaseBranch.test.ts`

Expected: PASS

Run: `cd apps/desktop && pnpm test -- src/stores/kanna.runtimeStatusSync.test.ts`

Expected: PASS

- [ ] **Step 4: Run typecheck and the full desktop unit suite**

Run: `cd apps/desktop && pnpm exec tsc --noEmit`
Expected: exit code `0`

Run: `cd apps/desktop && pnpm test`
Expected: PASS with the full `src` suite green

- [ ] **Step 5: Commit the regression-test tightening**

```bash
git add apps/desktop/src/stores/kanna.taskBaseBranch.test.ts
git commit -m "test: cover optimistic snapshot flows"
```
