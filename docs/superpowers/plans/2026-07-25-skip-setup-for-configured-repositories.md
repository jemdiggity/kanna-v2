# Skip Setup for Configured Repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repository imports and clones from automatically creating a setup task when the repository already has a root `.kanna` path.

**Architecture:** Keep the policy in `useAppTaskCreation`, where successful repository addition already flows into setup-task creation. A conditional wrapper will query the existing filesystem helper after import or clone, while the create-new flow will retain its unconditional setup behavior.

**Tech Stack:** Vue 3 composables, TypeScript, Vitest, Tauri invoke bridge

---

### Task 1: Guard automatic setup after import and clone

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskCreation.ts:295-356`
- Test: `apps/desktop/src/composables/useAppTaskCreation.test.ts:585-608`

- [ ] **Step 1: Write failing regression tests for existing `.kanna` paths**

First, correct the harness’s clone mock to match the production return type:

```typescript
    cloneAndImportRepo: vi.fn(async () => "repo-1"),
```

Then replace the existing import setup test at the end of `useAppTaskCreation.test.ts` and add clone/create coverage:

```typescript
  it("skips the setup agent when an imported repository already has .kanna", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === "file_exists") return args?.path === "/repo/.kanna";
      return "";
    });
    const { creation, store } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/repo/.kanna" });
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("launches the setup agent when an imported repository has no .kanna", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return false;
      return "";
    });
    const { creation, store } = createTaskCreationHarness();

    await creation.handleImportRepo("/repo", "repo", "main");

    expect(store.importRepo).toHaveBeenCalledWith("/repo", "repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/repo/.kanna" });
    expect(store.loadAgent).toHaveBeenCalledWith("repo-1", "setup");
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/repo",
      "Set up Kanna for this repository.",
      "pty",
      expect.objectContaining({
        customTask: expect.objectContaining({
          name: "Set Up Repository",
          agent: "setup",
          prompt: "Set up Kanna for this repository.",
        }),
      }),
    );
    expect(store.createItem.mock.calls[0]?.[4]).not.toHaveProperty("agentProvider");
  });

  it("skips the setup agent when a cloned repository already has .kanna", async () => {
    invokeMock.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === "file_exists") return args?.path === "/clone/.kanna";
      return "";
    });
    const { creation, store } = createTaskCreationHarness();

    await creation.handleCloneRepo("git@github.com:kanna/repo.git", "/clone");

    expect(store.cloneAndImportRepo).toHaveBeenCalledWith(
      "git@github.com:kanna/repo.git",
      "/clone",
    );
    expect(invokeMock).toHaveBeenCalledWith("file_exists", { path: "/clone/.kanna" });
    expect(store.loadAgent).not.toHaveBeenCalled();
    expect(store.createItem).not.toHaveBeenCalled();
  });

  it("still launches the setup agent for a newly created repository", async () => {
    const { creation, store } = createTaskCreationHarness();

    await creation.handleCreateRepo("repo", "/repo");

    expect(store.createRepo).toHaveBeenCalledWith("repo", "/repo");
    expect(invokeMock).not.toHaveBeenCalledWith("file_exists", {
      path: "/repo/.kanna",
    });
    expect(store.loadAgent).toHaveBeenCalledWith("repo-1", "setup");
    expect(store.createItem).toHaveBeenCalledWith(
      "repo-1",
      "/repo",
      "Set up Kanna for this repository.",
      "pty",
      expect.objectContaining({
        customTask: expect.objectContaining({
          name: "Set Up Repository",
          agent: "setup",
          prompt: "Set up Kanna for this repository.",
        }),
      }),
    );
  });
```

- [ ] **Step 2: Run the focused test and verify the new regression fails**

Run:

```bash
pnpm --dir apps/desktop test -- useAppTaskCreation.test.ts
```

Expected: FAIL in “skips the setup agent when an imported repository already has .kanna” because `loadAgent` and `createItem` are still called; the clone regression also fails because `file_exists` is not invoked.

- [ ] **Step 3: Implement the conditional setup launcher**

In `useAppTaskCreation.ts`, add this function immediately after `launchSetupTask`:

```typescript
  async function launchSetupTaskIfNeeded(
    repoId: string | null | undefined,
    repoPath: string,
  ) {
    const hasKannaConfig = await fileExistsSafe(`${repoPath}/.kanna`);
    if (hasKannaConfig) return;
    await launchSetupTask(repoId, repoPath);
  }
```

Then update only the import and clone handlers:

```typescript
  async function handleImportRepo(path: string, name: string, defaultBranch: string) {
    try {
      const repoId = await store.importRepo(path, name, defaultBranch);
      showAddRepoModal.value = false;
      await launchSetupTaskIfNeeded(repoId, path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.repoImportFailed')}: ${msg}`);
    }
  }

  async function handleCloneRepo(url: string, destination: string) {
    cloningRepo.value = true;
    try {
      const repoId = await store.cloneAndImportRepo(url, destination);
      showAddRepoModal.value = false;
      await launchSetupTaskIfNeeded(repoId, destination);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('toasts.cloneFailed')}: ${msg}`);
    } finally {
      cloningRepo.value = false;
    }
  }
```

Leave `handleCreateRepo` calling `launchSetupTask` directly.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --dir apps/desktop test -- useAppTaskCreation.test.ts
```

Expected: PASS with all `useAppTaskCreation` tests green.

- [ ] **Step 5: Commit the behavior and regression coverage**

```bash
git add apps/desktop/src/composables/useAppTaskCreation.ts apps/desktop/src/composables/useAppTaskCreation.test.ts
git commit -m "fix(desktop): skip setup for configured repo imports"
```

### Task 2: Make the App integration test’s setup precondition explicit

**Files:**
- Test: `apps/desktop/src/App.test.ts:4083-4126`

- [ ] **Step 1: Encode the missing-`.kanna` condition in the existing App test**

Rename the test to `launches the setup agent after importing an unconfigured repository from AddRepoModal`. Immediately after `store.importRepo.mockResolvedValueOnce("repo-imported");`, add:

```typescript
    invokeMock.mockImplementation(async (command: string, args?: { name?: string; repoPath?: string }) => {
      if (command === "file_exists") return false;
      if (command === "list_dir") return ["default.json"];
      if (command === "read_text_file") return "";
      if (command === "git_default_branch") return "main";
      if (command === "git_list_base_branches") return ["feature/x", "main", "origin/main"];
      if (command === "read_env_var") return "/Users/test";
      if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex")) {
        return `/usr/bin/${args.name}`;
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
```

After the `store.importRepo` assertion, add:

```typescript
    expect(invokeMock).toHaveBeenCalledWith("file_exists", {
      path: "/tmp/imported/.kanna",
    });
```

- [ ] **Step 2: Run the App integration test**

Run:

```bash
pnpm --dir apps/desktop test -- App.test.ts
```

Expected: PASS, including the renamed import/setup test.

- [ ] **Step 3: Commit the integration-test clarification**

```bash
git add apps/desktop/src/App.test.ts
git commit -m "test(desktop): encode unconfigured repo setup precondition"
```

### Task 3: Run final verification

**Files:**
- Verify: `apps/desktop/src/composables/useAppTaskCreation.ts`
- Verify: `apps/desktop/src/composables/useAppTaskCreation.test.ts`
- Verify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Run both affected test files together**

Run:

```bash
pnpm --dir apps/desktop test -- useAppTaskCreation.test.ts App.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the complete desktop TypeScript check**

Run:

```bash
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Check the final diff**

Run:

```bash
git diff HEAD~2 --check
git status --short
```

Expected: `git diff --check` exits 0, and `git status --short` contains no uncommitted implementation changes.
