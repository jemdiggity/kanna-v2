# Mobile More Stale Repository Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep stale task-derived repositories from breaking the mobile More command UI while preserving those repositories for task browsing.

**Architecture:** Track transient command-catalog failures separately in the mobile session store. The controller skips failed repositories in a bounded fallback loop, while `RootNavigator` passes More a filtered repository list; retry clears the transient failures and probes again.

**Tech Stack:** TypeScript, React Native, Vue-independent mobile session store/controller, Vitest, React Test Renderer

---

### Task 1: Track transient repository command availability

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Test: `apps/mobile/src/state/sessionStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Add focused tests alongside the existing repository-command state tests:

```ts
it("tracks repository command failures without removing task repositories", () => {
  const store = createSessionStore();
  store.setRepos([
    { id: "repo-stale", name: "Stale" },
    { id: "repo-live", name: "Live" }
  ]);

  store.markRepoCommandsUnavailable("repo-stale");

  expect(store.getState()).toMatchObject({
    repos: [
      { id: "repo-stale", name: "Stale" },
      { id: "repo-live", name: "Live" }
    ],
    unavailableRepoCommandIds: ["repo-stale"]
  });
});

it("clears repository command failures for retry and successful catalogs", () => {
  const store = createSessionStore();
  store.setRepos([{ id: "repo-1", name: "Repo One" }]);
  store.markRepoCommandsUnavailable("repo-1");
  store.setRepoCommandCatalog({
    repoId: "repo-1",
    revision: "catalog-v1",
    commands: []
  });
  expect(store.getState().unavailableRepoCommandIds).toEqual([]);

  store.markRepoCommandsUnavailable("repo-1");
  store.resetRepoCommandAvailability();
  expect(store.getState().unavailableRepoCommandIds).toEqual([]);
});
```

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: FAIL because `unavailableRepoCommandIds`, `markRepoCommandsUnavailable`, and `resetRepoCommandAvailability` do not exist.

- [ ] **Step 3: Implement the minimal store state and actions**

Extend `SessionState` and `SessionStore`:

```ts
export interface SessionState {
  // existing fields
  pendingRepoCommandTask: PendingRepoCommandTask | null;
  unavailableRepoCommandIds: string[];
  recentTasks: TaskSummary[];
}

export interface SessionStore {
  // existing methods
  finishRepoCommandRun(commandId: string): void;
  markRepoCommandsUnavailable(repoId: string): void;
  resetRepoCommandAvailability(): void;
  setRecentTasks(tasks: TaskSummary[]): void;
}
```

Initialize the field:

```ts
pendingRepoCommandTask: null,
unavailableRepoCommandIds: [],
recentTasks: [],
```

Add the actions near the other repository-command actions:

```ts
markRepoCommandsUnavailable(repoId) {
  if (state.unavailableRepoCommandIds.includes(repoId)) return;
  state = {
    ...state,
    unavailableRepoCommandIds: [...state.unavailableRepoCommandIds, repoId]
  };
  publish();
},
resetRepoCommandAvailability() {
  if (state.unavailableRepoCommandIds.length === 0) return;
  state = { ...state, unavailableRepoCommandIds: [] };
  publish();
},
```

Update `setRepoCommandCatalog` so a recovered repository becomes available again:

```ts
const unavailableRepoCommandIds = state.unavailableRepoCommandIds.filter(
  (repoId) => repoId !== repoCommandCatalog.repoId
);
state = {
  ...state,
  repoCommandCatalog,
  repoCommandStatus: "ready",
  repoCommandErrorMessage: null,
  unavailableRepoCommandIds
};
```

- [ ] **Step 4: Run the store tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the store behavior**

```bash
git add apps/mobile/src/state/sessionStore.ts apps/mobile/src/state/sessionStore.test.ts
git commit -m "fix(mobile): track unavailable repo commands"
```

### Task 2: Filter unavailable repositories from More

**Files:**
- Modify: `apps/mobile/src/screens/repoCommandPresentation.ts`
- Test: `apps/mobile/src/screens/repoCommandPresentation.test.ts`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Write the failing presentation test**

Add the helper import and test:

```ts
import {
  buildRepoCommandSections,
  filterCommandAvailableRepos
} from "./repoCommandPresentation";

it("excludes command-unavailable repos without mutating the shared list", () => {
  const repos = [
    { id: "repo-stale", name: "Stale" },
    { id: "repo-live", name: "Live" }
  ];

  expect(filterCommandAvailableRepos(repos, ["repo-stale"])).toEqual([
    { id: "repo-live", name: "Live" }
  ]);
  expect(repos).toHaveLength(2);
});
```

- [ ] **Step 2: Run the presentation test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/repoCommandPresentation.test.ts
```

Expected: FAIL because `filterCommandAvailableRepos` is not exported.

- [ ] **Step 3: Implement the filtering helper**

In `repoCommandPresentation.ts`, import `RepoSummary` and add:

```ts
export function filterCommandAvailableRepos(
  repos: readonly RepoSummary[],
  unavailableRepoIds: readonly string[]
): RepoSummary[] {
  if (unavailableRepoIds.length === 0) return [...repos];
  const unavailable = new Set(unavailableRepoIds);
  return repos.filter((repo) => !unavailable.has(repo.id));
}
```

- [ ] **Step 4: Wire RootNavigator to pass only available command repositories**

Import the helper in `RootNavigator.tsx` and update `MoreRouteContent`:

```tsx
const commandRepos = filterCommandAvailableRepos(
  state.repos,
  state.unavailableRepoCommandIds
);

return (
  <MoreScreen
    // existing props
    repos={commandRepos}
    // existing props
  />
);
```

- [ ] **Step 5: Run presentation and screen tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/repoCommandPresentation.test.ts src/screens/MoreScreen.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit presentation filtering**

```bash
git add apps/mobile/src/screens/repoCommandPresentation.ts apps/mobile/src/screens/repoCommandPresentation.test.ts apps/mobile/src/navigation/RootNavigator.tsx
git commit -m "fix(mobile): hide unavailable repos from more"
```

### Task 3: Fall through stale repositories instead of failing More

**Files:**
- Modify: `apps/mobile/src/state/mobileController.ts`
- Test: `apps/mobile/src/state/mobileController.test.ts`

- [ ] **Step 1: Write the failing fallback tests**

Add controller tests using the existing `createClientMock`, `createSessionStore`, and `flushMicrotasks` helpers:

```ts
it("skips a stale selected repository when More opens", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands
    .mockRejectedValueOnce(new Error("404 repo not found: repo-1"))
    .mockResolvedValueOnce({
      repoId: "repo-2",
      revision: "catalog-repo-2",
      commands: []
    });
  const controller = createMobileController(client, store);
  await controller.bootstrap();

  controller.setNavigationView("more");
  await vi.waitFor(() => {
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-2",
      repoCommandStatus: "ready",
      unavailableRepoCommandIds: ["repo-1"]
    });
  });

  expect(store.getState().repos.map((repo) => repo.id)).toEqual([
    "repo-1",
    "repo-2"
  ]);
  expect(client.listRepoCommands.mock.calls).toEqual([
    ["repo-1"],
    ["repo-2"]
  ]);
});

it("reports an error only after every repository command catalog fails", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands.mockRejectedValue(new Error("repo unavailable"));
  const controller = createMobileController(client, store);
  await controller.bootstrap();

  await controller.loadRepoCommands();

  expect(client.listRepoCommands).toHaveBeenCalledTimes(2);
  expect(store.getState()).toMatchObject({
    repoCommandStatus: "error",
    repoCommandErrorMessage: "repo unavailable",
    unavailableRepoCommandIds: ["repo-1", "repo-2"]
  });
});

it("keeps an empty successful catalog instead of falling through", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands.mockResolvedValue({
    repoId: "repo-1",
    revision: "empty-catalog",
    commands: []
  });
  const controller = createMobileController(client, store);
  await controller.bootstrap();

  await controller.loadRepoCommands();

  expect(client.listRepoCommands).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({
    selectedRepoId: "repo-1",
    repoCommandStatus: "ready",
    unavailableRepoCommandIds: []
  });
});

it("retries repositories previously marked command-unavailable", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands.mockRejectedValue(new Error("repo unavailable"));
  const controller = createMobileController(client, store);
  await controller.bootstrap();
  await controller.loadRepoCommands();
  client.listRepoCommands.mockReset().mockResolvedValue({
    repoId: store.getState().selectedRepoId!,
    revision: "recovered",
    commands: []
  });

  await controller.retryRepoCommand();

  expect(client.listRepoCommands).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({
    repoCommandStatus: "ready",
    unavailableRepoCommandIds: []
  });
});
```

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts
```

Expected: FAIL because the first repository error immediately sets `repoCommandStatus: "error"` and retry does not clear transient failures.

- [ ] **Step 3: Implement bounded catalog fallback**

Replace `loadRepoCommands` with a bounded loop that retains the existing generation guards:

```ts
const loadRepoCommands = async (): Promise<void> => {
  const commandState = store.getState();
  let repoId = commandState.selectedRepoId;
  if (
    !repoId ||
    commandState.runningRepoCommandId !== null ||
    commandState.pendingRepoCommandTask !== null
  ) {
    return;
  }

  const generation = ++repoCommandLoadGeneration;
  while (repoId) {
    store.setRepoCommandLoading(repoId);
    try {
      const catalog = await client.listRepoCommands(repoId);
      if (
        generation !== repoCommandLoadGeneration ||
        store.getState().selectedRepoId !== repoId
      ) {
        return;
      }
      store.setRepoCommandCatalog({ ...catalog, repoId });
      return;
    } catch (error) {
      if (
        generation !== repoCommandLoadGeneration ||
        store.getState().selectedRepoId !== repoId
      ) {
        return;
      }

      store.markRepoCommandsUnavailable(repoId);
      const nextRepo = store.getState().repos.find(
        (candidate) =>
          !store.getState().unavailableRepoCommandIds.includes(candidate.id)
      );
      if (!nextRepo) {
        store.setRepoCommandError(
          repoId,
          error instanceof Error ? error.message : String(error)
        );
        return;
      }

      taskCollectionsRevision += 1;
      store.selectRepo(nextRepo.id);
      void loadRepoTasks(nextRepo.id).catch(() => undefined);
      repoId = nextRepo.id;
    }
  }
};
```

The `while` loop is bounded because each failure records one repository ID before the next candidate is selected.

- [ ] **Step 4: Reset availability only for explicit catalog retry**

In `retryRepoCommand`, preserve the pending-created-task branch and reset only when retrying catalogs:

```ts
async retryRepoCommand() {
  const pendingTask = store.beginRepoCommandTaskRefresh();
  if (!pendingTask) {
    if (!store.getState().pendingRepoCommandTask) {
      store.resetRepoCommandAvailability();
      await loadRepoCommands();
    }
    return null;
  }

  let openedTaskId: string | null = null;
  try {
    if (await loadCreatedRepoCommandTask(pendingTask)) {
      this.openTask(pendingTask.taskId);
      openedTaskId = pendingTask.taskId;
    }
  } finally {
    store.finishRepoCommandRun(pendingTask.commandId);
  }
  return openedTaskId;
},
```

- [ ] **Step 5: Run controller tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts
```

Expected: PASS, including the existing stale-response and command-launch single-flight tests.

- [ ] **Step 6: Commit controller fallback**

```bash
git add apps/mobile/src/state/mobileController.ts apps/mobile/src/state/mobileController.test.ts
git commit -m "fix(mobile): skip stale repos in more"
```

### Task 4: Verify the mobile change

**Files:**
- Verify: `apps/mobile/src/state/sessionStore.ts`
- Verify: `apps/mobile/src/state/mobileController.ts`
- Verify: `apps/mobile/src/screens/repoCommandPresentation.ts`
- Verify: `apps/mobile/src/navigation/RootNavigator.tsx`

- [ ] **Step 1: Run focused mobile tests**

```bash
pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts src/state/mobileController.test.ts src/screens/repoCommandPresentation.test.ts src/screens/MoreScreen.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the mobile typecheck**

```bash
pnpm --dir apps/mobile typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run the complete mobile unit suite**

```bash
pnpm --dir apps/mobile test
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

```bash
git status --short
git diff --check HEAD~3..HEAD
git log -4 --oneline
```

Expected: only the approved spec, plan, mobile implementation, and tests are present; `git diff --check` emits no errors.
