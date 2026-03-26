# Diff View Modal Refinement

## Problem

The current diff view has three scopes (Branch, Last Commit, Working) with issues:
- Branch diff compares against `HEAD` of the default branch, not the merge base — shows upstream changes mixed with feature work
- Working scope falls back from unstaged to staged instead of combining them
- Last Commit scope shows even when there are no branch commits
- Tab order doesn't reflect usage frequency (Working is most common but listed last)

## Design

### Scope Definitions and Tab Order

Tabs left to right: **Working** | **Last Commit** | **Branch**

**Working** (default scope):
- `git_diff(staged: false)` — unstaged + untracked changes (`diff_index_to_workdir`)
- Toggle to include staged changes via `s` key or toolbar button
- When toggle is on, uses `diff_tree_to_workdir` (HEAD tree vs working directory) — a single coherent diff that includes both staged and unstaged changes
- Toggle state is per-session (not persisted per-task)

**Last Commit**:
- `git_diff_range("HEAD~1", "HEAD")`
- Always enabled in tab bar
- When no commits exist beyond the merge base (`merge_base == HEAD`), shows "No commits since branching" message instead of a diff
- Scope cycling still includes this tab

**Branch**:
- `git_merge_base(base_ref, "HEAD")` → `git_diff_range(merge_base, "HEAD")`
- Shows only committed changes on the feature branch since branching
- `base_ref` stored in DB at task creation (e.g., `"origin/main"`)
- `git_merge_base` handles rebases onto the same branch automatically — the common ancestor moves forward after rebase

### Database: `base_ref` Column

Add `base_ref TEXT` to the `worktree` table via the existing `addColumn` migration pattern.

Populated at task creation time:
1. Resolve `origin/{defaultBranch}` — use this if it exists
2. Fall back to local `{defaultBranch}` if no remote

The stored value is a branch name (not a commit hash), so `git_merge_base` always returns the correct fork point even after rebases onto the same branch.

**Out of scope**: detecting when a task is rebased onto a *different* branch (e.g., `main` → `release/1.0`). The stored `base_ref` would be stale in this case. Future work.

### Backend Changes

**`git_merge_base`** — new Tauri command (already implemented):

```rust
#[tauri::command]
pub fn git_merge_base(repo_path: String, ref_a: String, ref_b: String) -> Result<String, String>
```

Uses `git2::Repository::merge_base()`. Returns the full SHA of the common ancestor. Performance: 1-5ms per call.

**`git_diff`** — update existing command. Replace the `staged: bool` parameter with a `mode: String` parameter accepting:
- `"unstaged"` — `diff_index_to_workdir()` (current `staged: false` behavior)
- `"staged"` — `diff_tree_to_index()` (current `staged: true` behavior)
- `"all"` — `diff_tree_to_workdir()` with untracked file options — single diff from HEAD to working directory, includes both staged and unstaged changes

### Frontend Changes (DiffView.vue)

**Props**: add `baseRef?: string` — the stored base branch ref from the DB.

**Tab order**: `scopeOrder` changes from `["working", "branch", "commit"]` to `["working", "commit", "branch"]`.

**Working scope staged toggle**:
- New reactive state: `includeStaged: ref(false)`
- When off: `git_diff(mode: "unstaged")`
- When on: `git_diff(mode: "all")` — single diff from HEAD to working directory
- `s` key toggles in the `extraHandler`
- Toolbar shows toggle button (same style as scope buttons) only when Working scope is active

**Last Commit availability check**:
- On load, compute `git_merge_base(baseRef, "HEAD")` and resolve `HEAD` SHA
- If equal: show "No commits since branching" message
- If not equal: render diff normally

**Branch scope**:
- Uses `baseRef` prop (not freshly detected default branch) for `git_merge_base`
- Falls back to detecting default branch if `baseRef` is not provided (backwards compat)

### Error Handling

- **No remote at creation**: store local default branch name as `base_ref`
- **`git_merge_base` fails**: show error inline in diff area (don't swallow)
- **Empty diffs**: show "No changes" for working, "No commits since branching" for last commit
- **Large diffs**: unchanged — @pierre/diffs renders incrementally per file

### Performance

All git operations measured at 1-14ms. Full branch scope (3 sequential calls) completes in ~8ms total. No caching needed.

| Operation | Measured Range |
|---|---|
| `git_default_branch` | 2-6ms |
| `git_merge_base` | 1-5ms |
| `git_diff_range` | 1-8ms |
| `git_diff(unstaged)` | 3-14ms |
| `renderDiff` | 1-21ms |

### Cleanup

Remove timing `console.log` statements from DiffView.vue before shipping.
