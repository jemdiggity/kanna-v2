# New Task Options UI Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the transient invalid-base-branch message by hydrating New Task options from a repo-scoped UI cache while refreshing those options on every open.

**Architecture:** `useAppTaskCreation` will own a session-scoped `Map` of complete option snapshots keyed by repository id. Opening the modal applies a cached snapshot synchronously when available, then the existing guarded async load refreshes and atomically replaces both cache and visible refs. `NewTaskModal` will render a neutral loading label when no cached branch exists, while preserving the existing invalid result after loading completes.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, Vue Test Utils, pnpm

---

### Task 1: Cache repository option snapshots

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Test: `apps/desktop/src/composables/useAppTaskCreation.test.ts`

- [ ] **Step 1: Write the failing cached-reopen test**

Add this test after `shows New Task before repository options finish loading`:

```ts
  it("hydrates cached repository options while refreshing them on reopen", async () => {
    const { creation, availablePipelines, defaultPipelineName, availableBaseBranches } =
      createTaskCreationHarness();

    await creation.openNewTaskModal();

    const definitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultPipeline: string;
      pipelines: string[];
    }>();
    const providers = deferred<["codex"]>();
    const defaultBranch = deferred<string>();
    const baseBranches = deferred<string[]>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: () => definitions.promise,
      fetchRepoAgentProviders: () => providers.promise,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_default_branch") return defaultBranch.promise;
      if (command === "git_list_base_branches") return baseBranches.promise;
      return Promise.resolve("");
    });

    const reopenPromise = creation.openNewTaskModal();

    expect(creation.newTaskOptionsLoading.value).toBe(true);
    expect(creation.availableAgentProviders.value).toEqual([
      "claude", "copilot", "codex", "opencode", "antigravity",
    ]);
    expect(availablePipelines.value).toEqual(["default"]);
    expect(defaultPipelineName.value).toBe("default");
    expect(availableBaseBranches.value).toEqual(["origin/main"]);

    definitions.resolve({
      revision: "refreshed-rev",
      refName: "origin/trunk",
      config: {},
      defaultPipeline: "review",
      pipelines: ["default", "review"],
    });
    providers.resolve(["codex"]);
    defaultBranch.resolve("trunk");
    baseBranches.resolve(["origin/trunk", "trunk"]);
    await reopenPromise;

    expect(creation.availableAgentProviders.value).toEqual(["codex"]);
    expect(availablePipelines.value).toEqual(["default", "review"]);
    expect(defaultPipelineName.value).toBe("review");
    expect(availableBaseBranches.value).toEqual(["origin/trunk", "trunk"]);
    expect(creation.newTaskOptionsLoading.value).toBe(false);
  });
```

Add a second test to prove the cache key is the repository id rather than one global last-value slot:

```ts
  it("keeps cached repository options isolated by repository", async () => {
    const {
      creation,
      store,
      availablePipelines,
      availableBaseBranches,
    } = createTaskCreationHarness();

    await creation.openNewTaskModal("repo-1");
    store.repos.push({ id: "repo-2", path: "/repo-2" });
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: async () => ({
        revision: "repo-2-rev",
        refName: "origin/trunk",
        config: {},
        defaultPipeline: "review",
        pipelines: ["default", "review"],
      }),
      fetchRepoAgentProviders: async (): Promise<["codex"]> => ["codex"],
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_default_branch") return "trunk";
      if (command === "git_list_base_branches") return ["origin/trunk"];
      return "";
    });
    await creation.openNewTaskModal("repo-2");

    const definitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultPipeline: string;
      pipelines: string[];
    }>();
    const providers = deferred<["claude"]>();
    const defaultBranch = deferred<string>();
    const baseBranches = deferred<string[]>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: () => definitions.promise,
      fetchRepoAgentProviders: () => providers.promise,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_default_branch") return defaultBranch.promise;
      if (command === "git_list_base_branches") return baseBranches.promise;
      return Promise.resolve("");
    });

    const reopenRepoOne = creation.openNewTaskModal("repo-1");

    expect(creation.availableAgentProviders.value).toEqual([
      "claude", "copilot", "codex", "opencode", "antigravity",
    ]);
    expect(availablePipelines.value).toEqual(["default"]);
    expect(availableBaseBranches.value).toEqual(["origin/main"]);

    definitions.resolve({
      revision: "repo-1-refreshed-rev",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    });
    providers.resolve(["claude"]);
    defaultBranch.resolve("main");
    baseBranches.resolve(["origin/main", "main"]);
    await reopenRepoOne;
  });
```

Extend `discards option results from a superseded repository load` after its existing assertions to prove the discarded result was not cached:

```ts
    const refreshedDefinitions = deferred<{
      revision: string;
      refName: string;
      config: Record<string, never>;
      defaultPipeline: string;
      pipelines: string[];
    }>();
    const refreshedProviders = deferred<[]>();
    const refreshedDefaultBranch = deferred<string>();
    const refreshedBaseBranches = deferred<string[]>();
    updateDesktopServerClientHandlersForTests({
      fetchRepoKannaDefinitions: () => refreshedDefinitions.promise,
      fetchRepoAgentProviders: () => refreshedProviders.promise,
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_default_branch") return refreshedDefaultBranch.promise;
      if (command === "git_list_base_branches") return refreshedBaseBranches.promise;
      return Promise.resolve("");
    });

    const thirdOpen = creation.openNewTaskModal("repo-1");

    expect(availablePipelines.value).toEqual([]);
    expect(availableBaseBranches.value).toEqual([]);

    refreshedDefinitions.resolve({
      revision: "repo-1-current-rev",
      refName: "origin/main",
      config: {},
      defaultPipeline: "default",
      pipelines: ["default"],
    });
    refreshedProviders.resolve([]);
    refreshedDefaultBranch.resolve("main");
    refreshedBaseBranches.resolve(["origin/main"]);
    await thirdOpen;
```

- [ ] **Step 2: Run the composable test and verify it fails for the missing cache**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/composables/useAppTaskCreation.test.ts
```

Expected: FAIL because reopening a previously loaded repository clears providers, pipelines, and base branches instead of retaining that repository's first load values.

- [ ] **Step 3: Add the snapshot boundary and repo-scoped cache**

Add these definitions near `UseAppTaskCreationOptions`:

```ts
interface NewTaskOptionsSnapshot {
  availableAgentProviders: AgentProvider[] | undefined;
  availablePipelines: string[];
  defaultPipelineName: string | undefined;
  availableBaseBranches: string[];
  defaultBaseBranchName: string | undefined;
  repoDefaultBranchName: string | undefined;
}
```

Inside `useAppTaskCreation`, add the cache and two focused state helpers:

```ts
  const newTaskOptionsCache = new Map<string, NewTaskOptionsSnapshot>();

  function applyNewTaskOptions(snapshot: NewTaskOptionsSnapshot) {
    availableAgentProviders.value = snapshot.availableAgentProviders;
    availablePipelines.value = snapshot.availablePipelines;
    defaultPipelineName.value = snapshot.defaultPipelineName;
    availableBaseBranches.value = snapshot.availableBaseBranches;
    defaultBaseBranchName.value = snapshot.defaultBaseBranchName;
    repoDefaultBranchName.value = snapshot.repoDefaultBranchName;
  }

  function clearNewTaskOptions() {
    applyNewTaskOptions({
      availableAgentProviders: undefined,
      availablePipelines: [],
      defaultPipelineName: undefined,
      availableBaseBranches: [],
      defaultBaseBranchName: undefined,
      repoDefaultBranchName: undefined,
    });
  }
```

Replace the unconditional ref clearing at the start of `openNewTaskModal()` with repo-scoped hydration:

```ts
    const cachedOptions = targetRepoId ? newTaskOptionsCache.get(targetRepoId) : undefined;
    if (cachedOptions) {
      applyNewTaskOptions(cachedOptions);
    } else {
      clearNewTaskOptions();
    }
```

For the local-repository result, construct and atomically apply a snapshot after the existing guard:

```ts
        const snapshot: NewTaskOptionsSnapshot = {
          availableAgentProviders: repoAgentProviders,
          availablePipelines: manifest?.pipelines ?? [],
          defaultPipelineName: manifest?.defaultPipeline,
          availableBaseBranches: baseBranches,
          defaultBaseBranchName:
            getDefaultBaseBranch(baseBranches, defaultBranch || "main") || undefined,
          repoDefaultBranchName: defaultBranch || undefined,
        };
        newTaskOptionsCache.set(targetRepo.id, snapshot);
        applyNewTaskOptions(snapshot);
```

For a cloud-only result, construct the complete cloud snapshot after its existing guard and cache it only when `targetRepoId` is defined:

```ts
        const snapshot: NewTaskOptionsSnapshot = {
          availableAgentProviders: undefined,
          availablePipelines: [],
          defaultPipelineName: undefined,
          availableBaseBranches: baseBranches,
          defaultBaseBranchName:
            getDefaultBaseBranch(baseBranches, cloudRepo?.default_branch || "main") || undefined,
          repoDefaultBranchName: cloudRepo?.default_branch || undefined,
        };
        if (targetRepoId) newTaskOptionsCache.set(targetRepoId, snapshot);
        applyNewTaskOptions(snapshot);
```

- [ ] **Step 4: Run the focused composable suite and verify it passes**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/composables/useAppTaskCreation.test.ts
```

Expected: PASS, including the existing overlapping-load generation tests.

- [ ] **Step 5: Commit the cache behavior**

```bash
git add apps/desktop/src/composables/useAppTaskCreation.ts apps/desktop/src/composables/useAppTaskCreation.test.ts
git commit -m "fix(desktop): cache new task repository options"
```

### Task 2: Distinguish loading from invalid branch state

**Files:**
- Modify: `apps/desktop/src/components/NewTaskModal.vue`
- Test: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

- [ ] **Step 1: Write the failing first-load presentation test**

Add this test after `keeps prompt entry available while task options load`:

```ts
  it("shows a neutral branch loading value before uncached options arrive", () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        optionsLoading: true,
        availableAgentProviders: undefined,
        pipelines: [],
        baseBranches: [],
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    const branchValue = wrapper.get('[data-testid="base-branch-value"]');
    expect(branchValue.text()).toBe("tasks.loadingOptions");
    expect(branchValue.classes()).not.toContain("invalid");
  });
```

Extend the existing `blocks submit when no valid default base branch is available` test with:

```ts
    expect(wrapper.get('[data-testid="base-branch-value"]').classes()).toContain("invalid");
```

- [ ] **Step 2: Run the modal test and verify the new test fails correctly**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/components/__tests__/NewTaskModal.test.ts
```

Expected: FAIL because the empty loading state currently renders `tasks.baseBranchRequired` with the `invalid` class; the completed-invalid assertion continues to pass.

- [ ] **Step 3: Render a neutral loading value without invalid styling**

Change the base-branch value span to:

```vue
              <span
                class="base-branch-value"
                :class="{ invalid: !optionsLoading && !hasValidBaseBranch }"
                data-testid="base-branch-value"
              >
                {{ selectedBaseBranch ?? (optionsLoading ? $t("tasks.loadingOptions") : $t("tasks.baseBranchRequired")) }}
              </span>
```

- [ ] **Step 4: Verify cached and uncached loading presentation**

Add this assertion to `keeps prompt entry available while task options load` so a cached branch remains visible during refresh:

```ts
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");
```

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 src/components/__tests__/NewTaskModal.test.ts
```

Expected: PASS. The uncached case shows `tasks.loadingOptions`, the cached case shows `origin/main`, and the completed invalid case still shows `tasks.baseBranchRequired` with invalid styling.

- [ ] **Step 5: Commit the loading presentation**

```bash
git add apps/desktop/src/components/NewTaskModal.vue apps/desktop/src/components/__tests__/NewTaskModal.test.ts
git commit -m "fix(desktop): hide branch validation during option loading"
```

### Task 3: Verify the integrated desktop behavior

**Files:**
- Verify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Verify: `apps/desktop/src/components/NewTaskModal.vue`
- Verify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Verify: `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`

- [ ] **Step 1: Run both focused suites together**

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/composables/useAppTaskCreation.test.ts \
  src/components/__tests__/NewTaskModal.test.ts
```

Expected: PASS with no failures.

- [ ] **Step 2: Run desktop type checking and production bundling**

```bash
pnpm --dir apps/desktop build
```

Expected: `vue-tsc --noEmit` and `vite build` both complete successfully.

- [ ] **Step 3: Run the complete desktop unit suite**

```bash
pnpm --dir apps/desktop test
```

Expected: PASS with no failed test files.

- [ ] **Step 4: Check the final diff for scope and formatting**

```bash
git diff HEAD~2 --check
git status --short
```

Expected: no whitespace errors; only the implementation-plan document may remain uncommitted.

- [ ] **Step 5: Commit the implementation plan**

```bash
git add docs/superpowers/plans/2026-07-21-new-task-options-ui-cache.md
git commit -m "docs: plan new task options UI cache"
```
