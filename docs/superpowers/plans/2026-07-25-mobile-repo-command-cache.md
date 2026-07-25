# Mobile Repository Command Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep last-good repository commands visible through transient mobile relay failures while rejecting catalogs the server has confirmed are stale.

**Architecture:** Add a session-only `Map<string, RepoCommandCatalog>` to the mobile controller. Catalog loads publish cached data before refreshing, update the map on successful reads, retain cached data on refresh failures, and fall back to the current unavailable flow only when no cache exists. Stale command-run conflicts explicitly evict the affected cache before the existing reload path.

**Tech Stack:** TypeScript, Vue-independent mobile controller state, Vitest

---

### Task 1: Cache successful repository command catalogs

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts:1-8,234,778-828`

- [ ] **Step 1: Write the failing last-good refresh test**

Add this focused controller test beside the existing repository-command load tests:

```ts
it("keeps the last-good command catalog when its refresh fails", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands
    .mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{
        id: "factory:create-agent",
        label: "Create Agent",
        description: "Create a new agent definition",
        group: "configure"
      }]
    })
    .mockRejectedValueOnce(new Error("Relay connection closed."));
  const controller = createMobileController(client, store);
  await controller.bootstrap();

  await controller.loadRepoCommands();
  await controller.loadRepoCommands();

  expect(store.getState()).toMatchObject({
    selectedRepoId: "repo-1",
    repoCommandCatalog: {
      repoId: "repo-1",
      revision: "catalog-v1"
    },
    repoCommandStatus: "ready",
    repoCommandErrorMessage: null,
    unavailableRepoCommandIds: []
  });
  expect(client.listRepoCommands).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "keeps the last-good command catalog when its refresh fails"
```

Expected: FAIL because the second load clears the catalog and falls through to another repository or the unavailable state.

- [ ] **Step 3: Implement the controller cache**

Import `RepoCommandCatalog` with the existing API types:

```ts
import type {
  CreateTaskResponse,
  RepoCommandCatalog,
  RepoSummary,
  // existing imports
} from "../lib/api/types";
```

Create the controller-owned map beside `repoCommandLoadGeneration`:

```ts
let repoCommandLoadGeneration = 0;
const repoCommandCatalogs = new Map<string, RepoCommandCatalog>();
```

Update each iteration of `loadRepoCommands` so it publishes cached data before
the routed refresh, stores successful responses, and retains cached state on a
failed refresh:

```ts
while (repoId) {
  const cachedCatalog = repoCommandCatalogs.get(repoId);
  if (cachedCatalog) {
    store.setRepoCommandCatalog(cachedCatalog);
  } else {
    store.setRepoCommandLoading(repoId);
  }
  try {
    const catalog = await client.listRepoCommands(repoId);
    if (
      generation !== repoCommandLoadGeneration ||
      store.getState().selectedRepoId !== repoId
    ) {
      return;
    }
    const normalizedCatalog = { ...catalog, repoId };
    repoCommandCatalogs.set(repoId, normalizedCatalog);
    store.setRepoCommandCatalog(normalizedCatalog);
    return;
  } catch (error) {
    if (
      generation !== repoCommandLoadGeneration ||
      store.getState().selectedRepoId !== repoId
    ) {
      return;
    }
    if (cachedCatalog) {
      return;
    }

    // existing unavailable-repository fallback
  }
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "keeps the last-good command catalog when its refresh fails"
```

Expected: PASS.

- [ ] **Step 5: Add cache restoration and replacement coverage**

Add two tests:

```ts
it("restores cached commands while a repository refresh is in flight", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  const repoOneRefresh = createDeferred<Awaited<
    ReturnType<KannaClient["listRepoCommands"]>
  >>();
  client.listRepoCommands
    .mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "repo-1-v1",
      commands: []
    })
    .mockResolvedValueOnce({
      repoId: "repo-2",
      revision: "repo-2-v1",
      commands: []
    })
    .mockReturnValueOnce(repoOneRefresh.promise);
  const controller = createMobileController(client, store);
  await controller.bootstrap();
  controller.setNavigationView("more");
  await vi.waitFor(() => {
    expect(store.getState().repoCommandCatalog?.revision).toBe("repo-1-v1");
  });
  await controller.selectRepo("repo-2");

  const selection = controller.selectRepo("repo-1");
  await vi.waitFor(() => {
    expect(store.getState()).toMatchObject({
      selectedRepoId: "repo-1",
      repoCommandCatalog: { revision: "repo-1-v1" },
      repoCommandStatus: "ready"
    });
  });

  repoOneRefresh.resolve({
    repoId: "repo-1",
    revision: "repo-1-v2",
    commands: []
  });
  await selection;
  expect(store.getState().repoCommandCatalog?.revision).toBe("repo-1-v2");
});

it("replaces a cached command catalog after a successful refresh", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands
    .mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: []
    })
    .mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v2",
      commands: []
    });
  const controller = createMobileController(client, store);
  await controller.bootstrap();

  await controller.loadRepoCommands();
  await controller.loadRepoCommands();

  expect(store.getState().repoCommandCatalog?.revision).toBe("catalog-v2");
});
```

- [ ] **Step 6: Run the repository-command controller tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "command catalog|cached commands|repository command"
```

Expected: all selected tests PASS.

### Task 2: Evict catalogs after authoritative stale-revision conflicts

**Files:**
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts:1779-1815`

- [ ] **Step 1: Write the failing stale-cache eviction test**

```ts
it("does not retain commands after the server rejects their catalog revision", async () => {
  const store = createSessionStore();
  const client = createClientMock();
  client.listRepoCommands
    .mockResolvedValueOnce({
      repoId: "repo-1",
      revision: "catalog-v1",
      commands: [{
        id: "factory:create-agent",
        label: "Create Agent",
        description: "Create a new agent definition",
        group: "configure"
      }]
    })
    .mockRejectedValue(new Error("Relay connection closed."));
  client.runRepoCommand.mockRejectedValueOnce(
    new Error("Remote desktop request failed with status 409.")
  );
  const controller = createMobileController(client, store);
  await controller.bootstrap();
  await controller.loadRepoCommands();
  store.setRepos([{ id: "repo-1", name: "Repo One" }]);

  await controller.runRepoCommand("factory:create-agent");

  expect(store.getState()).toMatchObject({
    selectedRepoId: "repo-1",
    repoCommandCatalog: null,
    repoCommandStatus: "error",
    repoCommandErrorMessage: "Relay connection closed."
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "does not retain commands after the server rejects their catalog revision"
```

Expected: FAIL because the new cache preserves `catalog-v1` during the reload failure.

- [ ] **Step 3: Implement explicit stale-catalog eviction**

In `runRepoCommand`, retain the launched repository ID and evict its cache
before the stale reload:

```ts
if (reloadCatalog) {
  repoCommandCatalogs.delete(repoId);
  store.setRepoCommandLoading(repoId);
  await loadRepoCommands();
}
```

`setRepoCommandLoading` clears the selected visible catalog before the reload.
The existing generation and selected-repository guards still prevent stale
responses from becoming visible.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts -t "does not retain commands after the server rejects their catalog revision"
```

Expected: PASS.

- [ ] **Step 5: Run all mobile controller and session store tests**

Run:

```bash
pnpm --dir apps/mobile test -- src/state/mobileController.test.ts src/state/sessionStore.test.ts
```

Expected: both files PASS with no failures.

### Task 3: Verify the mobile package

**Files:**
- Verify only

- [ ] **Step 1: Run the mobile typecheck**

Run:

```bash
pnpm --dir apps/mobile run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run the complete mobile unit suite**

Run:

```bash
pnpm --dir apps/mobile test
```

Expected: all mobile test files PASS.

- [ ] **Step 3: Check formatting and worktree state**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the intended controller, controller test,
design, and plan changes are present.

