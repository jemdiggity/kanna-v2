# Remove Repo from Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to soft-hide repos from the sidebar via a hover X button, with cmd+z undo and re-import unhide.

**Architecture:** Add `hidden` column to `repo` table, filter in `listRepos`, replace hard-delete `removeRepo` with `hideRepo`/`unhideRepo` in the composable, add X button to sidebar, extend existing undo handler.

**Tech Stack:** Vue 3, TypeScript, SQLite (tauri-plugin-sql), Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-remove-repo-from-sidebar-design.md`

---

### Task 1: Update DB schema type and query functions

**Files:**
- Modify: `packages/db/src/schema.ts:1-8`
- Modify: `packages/db/src/queries.ts:1-33`

- [ ] **Step 1: Write failing tests for new query functions**

Add to `packages/db/src/queries.test.ts`. Import the new functions and write tests:

```typescript
// Add to imports at line 2:
import {
  // ...existing imports...
  hideRepo,
  unhideRepo,
  findRepoByPath,
} from "./queries.js";

// Add new describe block after "repo queries" (after line 219):
describe("repo hide/unhide queries", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    await insertRepo(db, {
      id: "r1",
      path: "/home/user/project-a",
      name: "project-a",
      default_branch: "main",
    });
    await insertRepo(db, {
      id: "r2",
      path: "/home/user/project-b",
      name: "project-b",
      default_branch: "main",
    });
  });

  it("hideRepo sets hidden to 1", async () => {
    await hideRepo(db, "r1");
    const repo = db.tables.repo.find((r) => r.id === "r1");
    expect(repo?.hidden).toBe(1);
  });

  it("listRepos excludes hidden repos", async () => {
    await hideRepo(db, "r1");
    const repos = await listRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe("r2");
  });

  it("unhideRepo sets hidden back to 0", async () => {
    await hideRepo(db, "r1");
    await unhideRepo(db, "r1");
    const repos = await listRepos(db);
    expect(repos).toHaveLength(2);
  });

  it("findRepoByPath returns repo including hidden", async () => {
    await hideRepo(db, "r1");
    const repo = await findRepoByPath(db, "/home/user/project-a");
    expect(repo).not.toBeNull();
    expect(repo!.id).toBe("r1");
    expect(repo!.hidden).toBe(1);
  });

  it("findRepoByPath returns null for unknown path", async () => {
    const repo = await findRepoByPath(db, "/nonexistent");
    expect(repo).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && bun test`
Expected: FAIL — `hideRepo`, `unhideRepo`, `findRepoByPath` not exported

- [ ] **Step 3: Add `hidden` field to Repo interface**

In `packages/db/src/schema.ts`, add `hidden` between `default_branch` and `created_at`:

```typescript
export interface Repo {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  hidden: number;       // 0 = visible, 1 = hidden
  created_at: string;
  last_opened_at: string;
}
```

- [ ] **Step 4: Update `insertRepo` Omit type**

In `packages/db/src/queries.ts:21-23`, change the parameter type:

```typescript
export async function insertRepo(
  db: DbHandle,
  repo: Omit<Repo, "created_at" | "last_opened_at" | "hidden">
): Promise<void> {
```

- [ ] **Step 5: Update `listRepos` to filter hidden repos**

In `packages/db/src/queries.ts:12-14`:

```typescript
export async function listRepos(db: DbHandle): Promise<Repo[]> {
  return db.select<Repo>("SELECT * FROM repo WHERE hidden = 0 ORDER BY last_opened_at DESC");
}
```

- [ ] **Step 6: Add `hideRepo`, `unhideRepo`, `findRepoByPath` functions**

Add after `deleteRepo` in `packages/db/src/queries.ts` (after line 33):

```typescript
export async function hideRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("UPDATE repo SET hidden = 1 WHERE id = ?", [id]);
}

export async function unhideRepo(db: DbHandle, id: string): Promise<void> {
  await db.execute("UPDATE repo SET hidden = 0 WHERE id = ?", [id]);
}

/** Includes hidden repos — callers must check `existing.hidden`. */
export async function findRepoByPath(db: DbHandle, path: string): Promise<Repo | null> {
  const rows = await db.select<Repo>("SELECT * FROM repo WHERE path = ?", [path]);
  return rows[0] ?? null;
}
```

- [ ] **Step 7: Update mock DB to support new operations**

In `packages/db/src/queries.test.ts`, update `createMockDb`:

1. Add `hidden: 0` to the repo object in the `INSERT INTO REPO` handler (after line 50):

```typescript
tables.repo.push({
  id,
  path,
  name,
  default_branch,
  hidden: 0,
  created_at: new Date().toISOString(),
  last_opened_at: new Date().toISOString(),
});
```

2. Add handler for `UPDATE REPO SET HIDDEN` in `execute` (after the `DELETE FROM REPO` block, after line 54):

```typescript
} else if (q.startsWith("UPDATE REPO SET HIDDEN")) {
  const [value, id] = bindValues as [number, string];
  const repo = tables.repo.find((r) => r.id === id);
  if (repo) repo.hidden = value;
```

3. Update the `SELECT * FROM REPO` handler in `select` to filter hidden repos (line 141-146):

```typescript
} else if (q.startsWith("SELECT * FROM REPO WHERE PATH")) {
  const [path] = bindValues as string[];
  return tables.repo.filter((r) => r.path === path) as unknown as T[];
} else if (q.startsWith("SELECT * FROM REPO WHERE HIDDEN")) {
  return tables.repo.filter((r) => r.hidden === 0).sort(
    (a, b) =>
      new Date(b.last_opened_at).getTime() -
      new Date(a.last_opened_at).getTime()
  ) as unknown as T[];
} else if (q.startsWith("SELECT * FROM REPO")) {
```

Note: The `SELECT * FROM REPO WHERE HIDDEN` matcher must come before the generic `SELECT * FROM REPO` matcher since the updated `listRepos` query now includes `WHERE hidden = 0`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd packages/db && bun test`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts packages/db/src/queries.test.ts
git commit -m "feat(db): add hidden column support for repo soft-hide"
```

---

### Task 2: Update useRepo composable

**Files:**
- Modify: `apps/desktop/src/composables/useRepo.ts:1-39`

- [ ] **Step 1: Replace removeRepo with hideRepo/unhideRepo and update importRepo**

Replace the entire file content of `apps/desktop/src/composables/useRepo.ts`:

```typescript
import { ref, type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import type { Repo } from "@kanna/db";
import { listRepos, insertRepo, hideRepo as hideRepoQuery, unhideRepo as unhideRepoQuery, findRepoByPath } from "@kanna/db";

export function useRepo(db: Ref<DbHandle | null>) {
  const repos = ref<Repo[]>([]);
  const selectedRepoId = ref<string | null>(null);

  async function refresh() {
    if (!db.value) return;
    repos.value = await listRepos(db.value);
  }

  async function importRepo(path: string, name: string, defaultBranch: string) {
    if (!db.value) return;
    const existing = await findRepoByPath(db.value, path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(db.value, existing.id);
        await refresh();
        selectedRepoId.value = existing.id;
      }
      return;
    }
    const id = crypto.randomUUID();
    await insertRepo(db.value, { id, path, name, default_branch: defaultBranch });
    await refresh();
    selectedRepoId.value = id;
  }

  async function hideRepo(id: string) {
    if (!db.value) return;
    await hideRepoQuery(db.value, id);
    if (selectedRepoId.value === id) {
      selectedRepoId.value = null;
    }
    await refresh();
  }

  async function unhideRepo(id: string) {
    if (!db.value) return;
    await unhideRepoQuery(db.value, id);
    await refresh();
  }

  return {
    repos,
    selectedRepoId,
    refresh,
    importRepo,
    hideRepo,
    unhideRepo,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/composables/useRepo.ts
git commit -m "feat(useRepo): replace removeRepo with hideRepo/unhideRepo"
```

---

### Task 3: Add migration and wire up App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue:28,160,210-229,262-265,587-602`

- [ ] **Step 1: Update useRepo destructuring**

In `apps/desktop/src/App.vue:28`, change:

```typescript
const { repos, selectedRepoId, refresh: refreshRepos, importRepo } = useRepo(db);
```

to:

```typescript
const { repos, selectedRepoId, refresh: refreshRepos, importRepo, hideRepo, unhideRepo } = useRepo(db);
```

- [ ] **Step 2: Add `lastUndoAction` ref**

Add before the `keyboardActions` object (before line 160):

```typescript
const lastUndoAction = ref<{ type: 'hideRepo'; repoId: string } | null>(null);
```

- [ ] **Step 3: Add `handleHideRepo` handler**

Add after `handleSelectRepo` (after line 265):

```typescript
async function handleHideRepo(repoId: string) {
  await hideRepo(repoId);
  lastUndoAction.value = { type: 'hideRepo', repoId };
}
```

- [ ] **Step 4: Extend undo handler**

In the `undoClose` handler (lines 210-229), add hide-repo undo at the top of the function body:

```typescript
undoClose: async () => {
  if (lastUndoAction.value?.type === 'hideRepo') {
    const repoId = lastUndoAction.value.repoId;
    lastUndoAction.value = null;
    await unhideRepo(repoId);
    return;
  }
  if (!db.value) return;
  // ...existing undo-close-task logic unchanged...
```

- [ ] **Step 4b: Clear `lastUndoAction` when a task is closed**

In `handleCloseTask` (line 122), add at the very start of the function body:

```typescript
lastUndoAction.value = null;
```

This prevents a stale repo-undo from intercepting cmd+z after a task close.

- [ ] **Step 5: Add `hidden` column migration**

In `runMigrations()`, add after the last `ALTER TABLE` try/catch block (after line 404):

```typescript
try {
  await database.execute(`ALTER TABLE repo ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }
```

- [ ] **Step 6: Wire Sidebar `hide-repo` event**

In the `<Sidebar>` template (around line 601), add the event handler after `@rename-item`:

```
@hide-repo="handleHideRepo"
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat(app): wire hideRepo, undo handler, and DB migration"
```

---

### Task 4: Add hover X button to Sidebar

> **Note:** Tasks 3 and 4 modify different files and can be done in parallel, but both must be committed before running `tsc --noEmit` — the `@hide-repo` binding in Task 3 references the emit declared in Task 4.

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:12-23,153-172,325-557`

- [ ] **Step 1: Add `hide-repo` emit declaration**

In `Sidebar.vue:12-23`, add to the `defineEmits` type:

```typescript
(e: "hide-repo", repoId: string): void;
```

- [ ] **Step 2: Add X button to repo header template**

In the repo header div (after the `btn-add-task` button, around line 171), add:

```html
<button
  class="btn-icon btn-hide-repo"
  title="Remove Repo"
  @click.stop="emit('hide-repo', repo.id)"
>&times;</button>
```

- [ ] **Step 3: Update CSS**

Move `margin-left: auto` from `.btn-add-task` to `.btn-hide-repo`. In the `<style scoped>` section:

Change `.btn-add-task` (lines 417-422):

```css
.btn-add-task {
  font-size: 14px;
  padding: 0 4px;
  opacity: 0.5;
}
```

Add after `.btn-add-task:hover` (after line 426):

```css
.btn-hide-repo {
  margin-left: auto;
  opacity: 0;
  font-size: 14px;
  padding: 0 4px;
  transition: opacity 0.1s;
}

.repo-header:hover .btn-hide-repo {
  opacity: 0.5;
}

.btn-hide-repo:hover {
  opacity: 1;
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue
git commit -m "feat(sidebar): add hover X button to hide repos"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Start the dev server**

Run: `./scripts/dev.sh`

- [ ] **Step 2: Verify X button appears on repo header hover**

Hover over a repo header — X button should fade in on the right side.

- [ ] **Step 3: Verify hiding a repo**

Click X — repo disappears from sidebar.

- [ ] **Step 4: Verify undo**

Press cmd+z — repo reappears in sidebar.

- [ ] **Step 5: Verify re-import unhide**

Hide a repo, then click "Import Repo" and select the same directory. The repo should reappear without creating a duplicate.

- [ ] **Step 6: Verify undo expiry**

Hide repo A, then hide repo B. Press cmd+z — only repo B reappears. Cmd+z again should undo-close a task (existing behavior), not restore repo A.
