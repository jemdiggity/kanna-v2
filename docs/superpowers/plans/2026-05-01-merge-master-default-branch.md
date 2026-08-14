# Merge Master Default Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pass the selected repo's default branch to Merge Master so repos that use `dev` do not default merge instructions to `main`.

**Architecture:** Keep repo branch resolution in the desktop store, where selected repo metadata already exists. Append a runtime context block to the merge agent prompt at merge task creation time, and update the merge agent instructions to consume that context and verify it against Git remote metadata.

**Tech Stack:** Vue 3/Pinia store, Vitest, existing Kanna workflow agent definitions.

---

### Task 1: Add Store Regression Test

**Files:**
- Modify: `apps/desktop/src/stores/kanna.taskBaseBranch.test.ts`

- [x] **Step 1: Write the failing test**

Add this test inside `describe("kanna store task base branch integration", () => { ... })`:

```ts
  it("passes the repo default branch into the merge agent prompt", async () => {
    mockState.repos = [mockState.makeRepo({ default_branch: "dev" })];
    const store = await createStore();

    await store.mergeQueue();

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining("Default target branch for this merge run: dev"),
        stage: "in progress",
      }),
    );
  });
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "passes the repo default branch into the merge agent prompt"
```

Expected: FAIL because the merge task prompt is still just the base agent prompt.

### Task 2: Pass Runtime Branch Context

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`

- [x] **Step 1: Implement the prompt context helper inline in `mergeQueue()`**

Replace:

```ts
      const agent = await workflow.loadAgent(repo.path, "merge");
      await tasks.createItem(repo.id, repo.path, agent.prompt, "pty");
```

with:

```ts
      const agent = await workflow.loadAgent(repo.path, "merge");
      const targetBranch = repo.default_branch || "main";
      const prompt = `${agent.prompt.trim()}

## Runtime Merge Context

Default target branch for this merge run: ${targetBranch}

Use this branch as the default when the user does not specify a target branch. Before merging, verify it against the repository's remote default branch with \`git symbolic-ref --short refs/remotes/origin/HEAD\` or \`git remote show origin\`. If the verified default branch differs from this value, ask the user which branch to use.`;

      await tasks.createItem(repo.id, repo.path, prompt, "pty");
```

- [x] **Step 2: Run the focused test**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "passes the repo default branch into the merge agent prompt"
```

Expected: PASS.

### Task 3: Update Merge Agent Instructions

**Files:**
- Modify: `.kanna/agents/merge/AGENT.md`

- [x] **Step 1: Remove hard-coded `main` language**

Replace:

```md
1. Ask the user which PR(s) to merge and the target branch (default: main).
```

with:

```md
1. Ask the user which PR(s) to merge. Use the Runtime Merge Context target branch as the default target branch. If no runtime target branch is provided, infer the default from `git symbolic-ref --short refs/remotes/origin/HEAD` or `git remote show origin`.
```

- [x] **Step 2: Run the focused test again**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/stores/kanna.taskBaseBranch.test.ts -t "passes the repo default branch into the merge agent prompt"
```

Expected: PASS.

### Task 4: Verify TypeScript

**Files:**
- Verify: TypeScript workspace

- [x] **Step 1: Run TypeScript check**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: exit code 0.
