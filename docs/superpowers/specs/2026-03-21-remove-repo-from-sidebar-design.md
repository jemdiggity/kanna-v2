# Remove Repository from Sidebar

## Overview

Allow users to hide repositories from the sidebar without deleting data. Hidden repos can be restored via cmd+z (immediate undo) or by re-importing the same path.

## Motivation

Users accumulate repos over time and need a way to declutter the sidebar without losing task history or worktree data.

## Design

### Database

Add `hidden` column to `repo` table via migration:

```sql
ALTER TABLE repo ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
```

Update `Repo` interface in `packages/db/src/schema.ts`:

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

### DB Queries (`packages/db/src/queries.ts`)

- `listRepos`: change to `SELECT * FROM repo WHERE hidden = 0 ORDER BY last_opened_at DESC`
- Add `hideRepo(db, id)`: `UPDATE repo SET hidden = 1 WHERE id = ?`
- Add `unhideRepo(db, id)`: `UPDATE repo SET hidden = 0 WHERE id = ?`
- Add `findRepoByPath(db, path)`: `SELECT * FROM repo WHERE path = ?` (includes hidden repos — callers must check `existing.hidden`)
- Update `insertRepo` parameter type: `Omit<Repo, "created_at" | "last_opened_at" | "hidden">` (hidden defaults via SQL)

### Composable (`apps/desktop/src/composables/useRepo.ts`)

Replace the existing `removeRepo` (hard delete) with `hideRepo`:

```typescript
async function hideRepo(id: string) {
  if (!db.value) return;
  await hideRepoQuery(db.value, id);
  if (selectedRepoId.value === id) {
    selectedRepoId.value = null;
  }
  await refresh();
}
```

Add `unhideRepo`:

```typescript
async function unhideRepo(id: string) {
  if (!db.value) return;
  await unhideRepoQuery(db.value, id);
  await refresh();
}
```

Update `importRepo` to detect existing hidden repos by path:

```typescript
async function importRepo(path: string, name: string, defaultBranch: string) {
  if (!db.value) return;
  const existing = await findRepoByPath(db.value, path);
  if (existing) {
    if (existing.hidden) {
      await unhideRepoQuery(db.value, existing.id);
      await refresh();
      selectedRepoId.value = existing.id;
    }
    return; // already exists and visible, no-op
  }
  const id = crypto.randomUUID();
  await insertRepo(db.value, { id, path, name, default_branch: defaultBranch });
  await refresh();
  selectedRepoId.value = id;
}
```

### Sidebar UI (`apps/desktop/src/components/Sidebar.vue`)

Add X button to repo header, visible on hover:

```html
<button
  class="btn-icon btn-hide-repo"
  title="Remove Repo"
  @click.stop="emit('hide-repo', repo.id)"
>&times;</button>
```

Positioned after the existing + button. Move `margin-left: auto` from `.btn-add-task` to `.btn-hide-repo` so both buttons sit on the right side of the flex row. CSS:

```css
.btn-add-task {
  /* remove margin-left: auto — it moves to btn-hide-repo */
  font-size: 14px;
  padding: 0 4px;
  opacity: 0.5;
}

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

New emit: `(e: "hide-repo", repoId: string): void`

### Undo (`apps/desktop/src/App.vue`)

Add a `lastUndoAction` ref (must be declared before `keyboardActions` object that references it):

```typescript
const lastUndoAction = ref<{ type: 'hideRepo'; repoId: string } | null>(null);
```

Handle `hide-repo` event from sidebar:

```typescript
async function handleHideRepo(repoId: string) {
  await hideRepo(repoId);
  lastUndoAction.value = { type: 'hideRepo', repoId };
}
```

Extend the existing `undoClose` keyboard shortcut handler:

```typescript
undoClose: async () => {
  // Undo hide-repo takes priority if it was the last action
  if (lastUndoAction.value?.type === 'hideRepo') {
    const repoId = lastUndoAction.value.repoId;
    lastUndoAction.value = null;
    await unhideRepo(repoId);
    return;
  }
  // Existing undo-close-task logic...
}
```

The `lastUndoAction` ref clears when:
- Undo is performed (consumed)
- A different repo is hidden (overwritten with new ID)
- Single-level undo only, consistent with existing undo-close pattern

## Files Modified

| File | Change |
|------|--------|
| `packages/db/src/schema.ts` | Add `hidden: number` to `Repo` interface |
| `packages/db/src/queries.ts` | Filter `listRepos`, add `hideRepo`, `unhideRepo`, `findRepoByPath`; update `insertRepo` Omit type |
| `apps/desktop/src/composables/useRepo.ts` | Replace `removeRepo` with `hideRepo`/`unhideRepo`, update `importRepo` |
| `apps/desktop/src/components/Sidebar.vue` | Add hover X button, `hide-repo` emit |
| `apps/desktop/src/App.vue` | Migration for `hidden` column, `handleHideRepo`, extend undo handler |

## No New Files

All changes are modifications to existing files. No new components, commands, or modules.

## Testing

- Hide a repo: click X, repo disappears from sidebar
- Undo: cmd+z immediately after hiding restores it
- Re-import: import same path, hidden repo reappears
- Undo expiry: hide repo A, hide repo B, cmd+z only restores B
- Data integrity: hidden repo's tasks and worktrees remain intact
- Unit tests: update mock DB in `packages/db/src/queries.test.ts` to include `hidden` field
