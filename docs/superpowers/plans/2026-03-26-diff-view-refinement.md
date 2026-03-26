# Diff View Refinement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the diff view modal to show correct content — working changes as default with staged toggle, merge-base-aware branch diff, and commit-aware last commit scope.

**Architecture:** Update `git_diff` Rust command to support a `mode` parameter (`unstaged`/`staged`/`all`). Add `base_ref` column to `pipeline_item` table (the `worktree` table is unused at runtime). Rewrite `DiffView.vue` scope logic to use merge base and new diff modes. `git_merge_base` command already exists.

**Tech Stack:** Rust (git2), Vue 3, SQLite, @pierre/diffs, tauri-plugin-sql

**Spec:** `docs/superpowers/specs/2026-03-26-diff-view-refinement-design.md`

**Note:** The spec says `base_ref` goes on `worktree` table, but the `worktree` table is unused at runtime — all task data lives on `pipeline_item`. This plan puts `base_ref` on `pipeline_item` instead.

---

### Task 1: Update `git_diff` Rust command — replace `staged: bool` with `mode: String`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/git.rs:19-50`

- [ ] **Step 1: Update `git_diff` signature and implementation**

Replace `staged: bool` with `mode: String`. Add `"all"` mode using `diff_tree_to_workdir_with_index`.

```rust
#[tauri::command]
pub fn git_diff(repo_path: String, mode: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let diff = match mode.as_str() {
        "staged" => {
            // Staged diff: HEAD tree vs index
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_index(head.as_ref(), None, None)
                .map_err(|e| e.to_string())?
        }
        "all" => {
            // All changes: HEAD tree vs working directory (staged + unstaged)
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let mut opts = git2::DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        _ => {
            // "unstaged" (default): index vs working directory
            let mut opts = git2::DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
    };

    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => output.push(origin as u8),
            _ => {}
        }
        output.extend_from_slice(line.content());
        true
    })
    .map_err(|e| e.to_string())?;

    String::from_utf8(output).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Update all callers of `git_diff` to use new `mode` parameter**

Search the codebase for all `invoke.*git_diff` calls that pass `staged:` and update them to pass `mode:` instead.

Key callers:
- `apps/desktop/src/components/DiffView.vue` — multiple calls in `loadDiff()`
- Any other files that invoke `git_diff`

Find all with: `rg 'invoke.*git_diff.*staged' apps/desktop/src/`

For now, replace `staged: false` with `mode: "unstaged"` and `staged: true` with `mode: "staged"` to maintain current behavior. The new `"all"` mode will be used in Task 4.

- [ ] **Step 3: Run `cargo clippy` and verify no warnings**

Run: `cd apps/desktop/src-tauri && cargo clippy`
Expected: No warnings

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/git.rs apps/desktop/src/components/DiffView.vue
git commit -m "refactor: replace git_diff staged bool with mode string parameter"
```

---

### Task 2: Add `base_ref` column to `pipeline_item` and populate on task creation

**Files:**
- Modify: `apps/desktop/src/stores/db.ts` (add migration)
- Modify: `packages/db/src/schema.ts` (add field to PipelineItem interface)
- Modify: `packages/db/src/queries.ts` (add base_ref to insertPipelineItem)
- Modify: `apps/desktop/src/stores/kanna.ts` (populate base_ref on createItem)
- Modify: `apps/desktop/tests/e2e/seed.sql` (add base_ref to seed worktree inserts)
- Modify: `apps/desktop/tests/e2e/helpers/seed.ts` (add base_ref to seed worktree inserts)

- [ ] **Step 1: Add migration in `db.ts`**

Add after the existing `addColumn` calls in `runMigrations()`:

```typescript
await addColumn("pipeline_item", "base_ref", "TEXT");
```

- [ ] **Step 2: Add `base_ref` to `PipelineItem` interface**

In `packages/db/src/schema.ts`, add to the `PipelineItem` interface:

```typescript
base_ref: string | null;
```

- [ ] **Step 3: Update `insertPipelineItem` in queries.ts**

Add `base_ref` to the Omit list's exclusions (so it becomes optional in the insert type), add it to the INSERT column list and VALUES, and pass `item.base_ref ?? null` in the bind values.

- [ ] **Step 4: Populate `base_ref` on task creation in `kanna.ts`**

In `createItem()`, before calling `insertPipelineItem`, compute the base ref:

```typescript
// Compute base_ref for merge-base diffing
let baseRef: string | null = null;
try {
  const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
  // Prefer origin ref if remote exists
  try {
    await invoke<string>("git_merge_base", { repoPath, refA: `origin/${defaultBranch}`, refB: "HEAD" });
    baseRef = `origin/${defaultBranch}`;
  } catch {
    baseRef = defaultBranch;
  }
} catch (e) {
  console.warn("[store] failed to compute base_ref:", e);
}
```

Then pass `base_ref: baseRef` in the `insertPipelineItem` call.

Also update `blockTask()` (~line 955 in kanna.ts) — it calls `insertPipelineItem` for replacement blocked items. Pass `base_ref` there too. Note: `startBlockedTask()` does NOT call `insertPipelineItem` — it uses a raw UPDATE on an existing item, so it doesn't need changes.

- [ ] **Step 5: Update seed data**

Add `base_ref` column with value `'origin/main'` to the seed INSERT statements in:
- `apps/desktop/tests/e2e/seed.sql`
- `apps/desktop/tests/e2e/helpers/seed.ts`

- [ ] **Step 6: Run `bun tsc --noEmit` to verify types**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/queries.ts apps/desktop/src/stores/db.ts apps/desktop/src/stores/kanna.ts apps/desktop/tests/e2e/seed.sql apps/desktop/tests/e2e/helpers/seed.ts
git commit -m "feat: add base_ref to pipeline_item for merge-base diffing"
```

---

### Task 3: Rewrite DiffView.vue scope logic

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue`
- Modify: `apps/desktop/src/components/DiffModal.vue` (pass-through baseRef prop)
- Modify: `apps/desktop/src/App.vue` (pass baseRef to DiffModal)

- [ ] **Step 1: Add `baseRef` prop to DiffView and DiffModal**

DiffView.vue — add to props:
```typescript
const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "commit" | "working";
  baseRef?: string;
}>();
```

DiffModal.vue — add to props and pass through:
```typescript
defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "commit" | "working";
  maximized?: boolean;
  baseRef?: string;
}>();
```

In DiffModal template, add `:base-ref="baseRef"` to the `<DiffView>` element.

- [ ] **Step 2: Pass `baseRef` from App.vue**

In App.vue's `<DiffModal>` usage (~line 684), add:
```
:base-ref="store.currentItem?.base_ref ?? undefined"
```

- [ ] **Step 3: Change default scope and tab order**

In DiffView.vue:
- Change default scope from `"branch"` to `"working"`: `const scope = ref<...>(props.initialScope || "working");`
- Change `scopeOrder` from `["working", "branch", "commit"]` to `["working", "commit", "branch"]`

- [ ] **Step 4: Rewrite `loadDiff()` with new scope logic**

Replace the entire `loadDiff()` function body's scope branching:

```typescript
async function loadDiff() {
  emit("scope-change", scope.value);
  const path = props.worktreePath || props.repoPath;
  loading.value = true;
  error.value = null;
  noDiff.value = false;
  noBranchCommits.value = false;

  try {
    let patch = "";

    if (scope.value === "working") {
      const mode = includeStaged.value ? "all" : "unstaged";
      patch = await invoke<string>("git_diff", { repoPath: path, mode });
    } else if (scope.value === "commit") {
      // Check if there are branch commits
      const hasBranchCommits = await checkBranchHasCommits(path);
      if (!hasBranchCommits) {
        noBranchCommits.value = true;
        cleanupInstance();
        return;
      }
      patch = await invoke<string>("git_diff_range", {
        repoPath: path,
        from: "HEAD~1",
        to: "HEAD",
      });
    } else {
      // "branch" scope — diff from merge base
      const baseRef = props.baseRef || await detectBaseRef(path);
      const mergeBase = await invoke<string>("git_merge_base", {
        repoPath: path,
        refA: baseRef,
        refB: "HEAD",
      });
      patch = await invoke<string>("git_diff_range", {
        repoPath: path,
        from: mergeBase,
        to: "HEAD",
      });
    }

    if (!patch?.trim()) {
      noDiff.value = true;
      diffContent.value = "";
      cleanupInstance();
      return;
    }

    diffContent.value = patch;
    await renderDiff(diffContent.value);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
```

Add helper functions:

```typescript
async function checkBranchHasCommits(path: string): Promise<boolean> {
  try {
    const baseRef = props.baseRef || await detectBaseRef(path);
    const mergeBase = await invoke<string>("git_merge_base", {
      repoPath: path,
      refA: baseRef,
      refB: "HEAD",
    });
    const headRef = await invoke<string>("git_diff_range", {
      repoPath: path,
      from: mergeBase,
      to: "HEAD",
    });
    // If merge base == HEAD, there are no commits on the branch
    // We check by seeing if there's any diff between merge base and HEAD
    return headRef.trim().length > 0;
  } catch {
    return false;
  }
}

async function detectBaseRef(path: string): Promise<string> {
  const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path });
  try {
    // Verify origin ref exists by trying merge-base
    await invoke<string>("git_merge_base", {
      repoPath: path,
      refA: `origin/${defaultBranch}`,
      refB: "HEAD",
    });
    return `origin/${defaultBranch}`;
  } catch {
    return defaultBranch;
  }
}
```

- [ ] **Step 5: Add `includeStaged` state and `noBranchCommits` state**

```typescript
const includeStaged = ref(false);
const noBranchCommits = ref(false);
```

- [ ] **Step 6: Remove timing console.log statements**

Remove all `console.log(\`[DiffView]` lines and the `performance.now()` timing variables that were added for measurement.

- [ ] **Step 7: Run `bun tsc --noEmit`**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/DiffView.vue apps/desktop/src/components/DiffModal.vue apps/desktop/src/App.vue
git commit -m "feat: rewrite diff scopes with merge-base, working default, staged toggle"
```

---

### Task 4: Add staged toggle UI and keyboard shortcut

**Files:**
- Modify: `apps/desktop/src/components/DiffView.vue` (template + styles + shortcut)
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

- [ ] **Step 1: Update template — reorder tabs and add staged toggle**

Replace the template's toolbar section:

```html
<div class="diff-toolbar">
  <div class="scope-selector">
    <button :class="{ active: scope === 'working' }" @click="scope = 'working'; loadDiff()">{{ $t('diffView.scopeWorking') }}</button>
    <button :class="{ active: scope === 'commit' }" @click="scope = 'commit'; loadDiff()">{{ $t('diffView.scopeLastCommit') }}</button>
    <button :class="{ active: scope === 'branch' }" @click="scope = 'branch'; loadDiff()">{{ $t('diffView.scopeBranch') }}</button>
  </div>
  <button
    v-if="scope === 'working'"
    class="staged-toggle"
    :class="{ active: includeStaged }"
    @click="includeStaged = !includeStaged; loadDiff()"
  >{{ $t('diffView.includeStaged') }}</button>
</div>
```

Update the status messages section to handle `noBranchCommits`:

```html
<div v-if="error" class="diff-status diff-error">{{ error }}</div>
<div v-else-if="noBranchCommits && !loading" class="diff-status">{{ $t('diffView.noCommitsSinceBranching') }}</div>
<div v-else-if="noDiff && !loading" class="diff-status">{{ $t('diffView.noChanges') }}</div>
```

- [ ] **Step 2: Add `s` key handler for staged toggle**

In the `useLessScroll` `extraHandler`, add before the scope cycling handlers:

```typescript
// s — toggle include staged (only in working scope)
if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
  if (scope.value === "working") {
    e.preventDefault();
    includeStaged.value = !includeStaged.value;
    loadDiff();
    return true;
  }
}
```

- [ ] **Step 3: Register the shortcut for display**

Add to the `registerContextShortcuts` call:

```typescript
{ label: t('diffView.shortcutToggleStaged'), display: "s" },
```

- [ ] **Step 4: Add styles for staged toggle button**

```css
.staged-toggle {
  margin-left: 12px;
  padding: 3px 10px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #888;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}

.staged-toggle.active {
  background: #0066cc;
  border-color: #0077ee;
  color: #fff;
}
```

- [ ] **Step 5: Add i18n strings**

Add to all locale files under `diffView`:

```json
"includeStaged": "+ Staged",
"noCommitsSinceBranching": "No commits since branching",
"shortcutToggleStaged": "Toggle staged"
```

- [ ] **Step 6: Manual test**

1. Start dev server: `./scripts/dev.sh restart`
2. Open diff modal (Cmd+D)
3. Verify tab order: Working | Last Commit | Branch
4. Verify Working is default scope
5. Press `s` — should toggle staged changes
6. Switch to Last Commit on a task with no commits — should show "No commits since branching"
7. Switch to Branch — should show merge-base diff
8. Cycle scopes with Cmd+Shift+] and Cmd+Shift+[

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/DiffView.vue apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "feat: add staged toggle UI and keyboard shortcut to diff view"
```

---

### Task 5: Cleanup and final verification

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/git.rs` (verify git_merge_base is clean)
- Modify: `docs/superpowers/specs/2026-03-26-diff-view-refinement-design.md` (correct base_ref table)

- [ ] **Step 1: Run full type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Run cargo clippy**

Run: `cd apps/desktop/src-tauri && cargo clippy`
Expected: No warnings

- [ ] **Step 3: Run cargo fmt**

Run: `cd apps/desktop/src-tauri && cargo fmt`

- [ ] **Step 4: Update spec to reflect `pipeline_item` instead of `worktree` table**

In `docs/superpowers/specs/2026-03-26-diff-view-refinement-design.md`, change the "Database: `base_ref` Column" section to reference `pipeline_item` instead of `worktree`.

- [ ] **Step 5: Verify no console.log statements remain in DiffView.vue**

Run: `rg 'console\.log' apps/desktop/src/components/DiffView.vue`
Expected: No matches

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: cleanup and final verification for diff view refinement"
```
