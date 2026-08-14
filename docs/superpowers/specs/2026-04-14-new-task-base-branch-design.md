# New Task Base Branch Selection

## Summary

Add a base-branch chooser to the new-task flow so users can create a task from any Git branch or ref instead of always branching from the repository default branch. The chooser should favor `origin/<defaultBranch>` first and `<defaultBranch>` second, support fuzzy search using the existing `fuzzyMatch` utility, and use the same low-ceremony visual style as the import-repo dialog's local-folder chooser.

This change must fix the current architectural mismatch where `baseBranch` is sometimes treated as a Git ref and sometimes treated as the name of an existing Kanna worktree directory. New-task creation and stage advancement should both use the same explicit start-point flow for worktree creation.

## Goals

- Let users choose the base branch for a new task.
- Allow any branch or ref the local repository can resolve at task-creation time.
- Prioritize `origin/<defaultBranch>` and `<defaultBranch>` in the picker.
- Support inline fuzzy search with the existing branch list.
- Keep the new-task modal visually lightweight.
- Ensure `base_ref` matches the selected base branch so diff behavior is correct from task creation onward.
- Remove the assumption that an arbitrary base branch implies a matching Kanna worktree path.

## Non-Goals

- Adding remote branch browsing beyond refs already available locally.
- Changing how imported repositories detect their default branch.
- Adding persistent per-repo base-branch preferences.
- Redesigning the new-task modal beyond the new branch chooser row.

## Current State

The data model already has `pipeline_item.base_ref`, and `createItem()` already accepts an optional `baseBranch`. The missing pieces are in the UI and in the worktree bootstrap path:

- `NewTaskModal.vue` does not expose any base-branch selection.
- `App.vue` only forwards prompt, provider, and workflow name.
- `createItem()` computes `base_ref` from the repository default branch even when a caller supplied `baseBranch`.
- `createWorktree()` treats `baseBranch` as the name of an existing Kanna worktree directory by changing the `git worktree add` working directory to `{repoPath}/.kanna-worktrees/{baseBranch}` and then using `HEAD` as the start point.

That last behavior only works for stage transitions built from an existing task branch and breaks the more general feature the UI now needs.

## Requirements

### Functional

1. Opening the new-task modal loads candidate branches for the selected repo.
2. The picker includes any locally resolvable branch/ref and explicitly includes `origin/<defaultBranch>` when available.
3. The branch list order is:
   - `origin/<defaultBranch>` first when present
   - `<defaultBranch>` second when present
   - all remaining refs sorted alphabetically
4. The picker supports fuzzy filtering via `fuzzyMatch.ts`.
5. Submitting the modal passes the exact selected branch/ref through to task creation.
6. Worktree creation uses the selected ref as the Git start point.
7. The inserted `pipeline_item.base_ref` equals the selected base branch/ref.
8. Stage advancement continues to create the next task from the prior task branch using the same explicit start-point mechanism.

### UX

1. The new control should match the lightweight style of the import-repo dialog's local-folder chooser.
2. The common case should remain fast: users can accept the default branch without opening a heavy picker UI.
3. Search should be keyboard friendly and update immediately as the user types.
4. If branch enumeration fails, task creation should still work with a sane fallback based on the repo default branch.

## 1. Branch enumeration

Add a new Tauri Git command that returns branch candidates for a repo. It should collect:

- local heads from `refs/heads/*`
- the explicit remote-tracking ref `refs/remotes/origin/<defaultBranch>` when it exists

The command should return a plain string array of displayable refs such as `main`, `release/1.2`, or `origin/main`.

This intentionally does not enumerate every remote-tracking branch. The requirement is "any branch can be the base branch," but in implementation terms that means any branch or ref the local repo can already resolve. That keeps the UI bounded and avoids turning this into a remote ref browser.

If enumeration fails, the app falls back to a synthetic branch list:

- `origin/<defaultBranch>`
- `<defaultBranch>`

The modal can still open and submit successfully in that state.

## 2. Modal UI

`NewTaskModal.vue` gets a new "Base branch" row below the workflow row.

The row is lightweight by default:

- a small label
- the currently selected base branch rendered as inline text
- a minimal clickable control styled like the import-repo dialog's `change-link`

Clicking the control opens an inline branch picker within the modal body. The picker contains:

- a compact search input
- a scrollable list of matching branch candidates
- a highlighted selected row

The default selection is:

1. `origin/<defaultBranch>` when present in the loaded list
2. otherwise `<defaultBranch>`
3. otherwise the first available candidate

The modal submit event expands to include `baseBranch`.

## 3. Search and ranking

The picker search uses the existing `apps/desktop/src/utils/fuzzyMatch.ts`.

Behavior:

- Empty query preserves the canonical branch ordering.
- Non-empty query scores every candidate with `fuzzyMatch`.
- Non-matching entries are removed.
- Matching entries are sorted by descending fuzzy score, with lexical name as the tiebreaker.

This keeps branch search behavior consistent with the rest of the app and avoids a second ad hoc matching implementation.

## 4. App handoff

`App.vue` loads branch candidates when opening the new-task modal for the selected repo. It already loads workflow names and repo config there, so this is the correct integration point for repo-scoped modal data.

`handleNewTaskSubmit()` expands from:

- `prompt`
- `agentProvider`
- `workflowName`

to:

- `prompt`
- `agentProvider`
- `workflowName`
- `baseBranch`

That value is forwarded to `store.createItem()`.

## 5. Store behavior

`createItem()` should stop hard-coding `base_ref` to the repo default branch when `opts.baseBranch` is present.

New behavior:

- if `opts.baseBranch` exists, `base_ref = opts.baseBranch`
- otherwise resolve the current behavior from the repo default branch, preferring `origin/<defaultBranch>` when available

This ensures diff behavior reflects the user's explicit choice.

## 6. Worktree creation

`createWorktree()` should always treat the base branch as an explicit Git start point, not as a Kanna worktree path.

New behavior:

- always run `git_worktree_add` from the repository root
- if `baseBranch` is provided, pass it as `startPoint`
- if `baseBranch` is omitted, keep the current fetch-then-branch-from-default behavior

That produces one consistent mental model:

- new tasks from the UI start from the selected branch/ref
- stage-advanced tasks start from the previous task branch

Both cases use the same `git worktree add -b <task-branch> <path> <startPoint>` flow.

## 7. Stage advancement

`advanceStage()` already calls `createItem()` with `baseBranch: item.branch`.

No UX changes are needed there, but the implementation will benefit from the `createWorktree()` fix because it will stop relying on the previous task's worktree directory structure and instead start directly from the branch ref.

## Error handling

- If branch enumeration fails, log the error and fall back to default-branch-derived candidates.
- If `git worktree add` fails because the selected ref is no longer resolvable, surface the existing task-creation failure toast and leave the task in the failed/idle path the store already uses.
- If the selected branch disappears between modal open and submit, do not silently rewrite the selection; fail clearly during worktree creation.

## Testing

Tests should cover the smallest layers that prove the behavior:

### Vue tests

- `NewTaskModal.test.ts`
  - emits `baseBranch` on submit
  - shows the selected branch inline
  - filters branches with fuzzy search
  - preserves default ordering when the search query is empty

### Store tests

- a store-level test for `createItem()` or `createWorktree()` proving that:
  - explicit `baseBranch` becomes `base_ref`
  - arbitrary branch names do not require a matching `.kanna-worktrees/<branch>` path
  - stage advancement still passes the previous task branch through the same path

### Type and integration verification

- `pnpm exec vitest` for the touched unit tests
- `pnpm exec tsc --noEmit`

If the repo already has a focused store test harness for this path, use it. If not, prefer adding narrow tests around the modal plus the smallest store-level seam that exercises start-point handling.

## Files Expected To Change

- `apps/desktop/src/components/NewTaskModal.vue`
- `apps/desktop/src/components/__tests__/NewTaskModal.test.ts`
- `apps/desktop/src/App.vue`
- `apps/desktop/src/stores/kanna.ts`
- `apps/desktop/src-tauri/src/commands/git.rs`
- `apps/desktop/src/tauri-mock.ts`
- related i18n strings for the new label and search placeholder

## Open Decisions Resolved

- Branch source: any locally resolvable Git branch/ref.
- Preferred defaults: `origin/<defaultBranch>` first, `<defaultBranch>` second.
- Search behavior: fuzzy search using the existing file-picker scorer.
- UI style: lightweight chooser modeled after the import-repo dialog's minimal change-link pattern.

## Implementation Notes

- Keep the returned branch list as strings rather than creating a new branch object type unless the UI later needs metadata such as source or tracking status.
- Do not add a second fuzzy matching utility.
- Do not persist the chosen base branch beyond task creation.
- Avoid changing the schema. `pipeline_item.base_ref` is sufficient for this feature.
