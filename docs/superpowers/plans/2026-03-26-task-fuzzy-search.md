# Task Fuzzy Search Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidebar "Add Repo" button with a search input that fuzzy-filters tasks by title, branch, or prompt.

**Architecture:** Add a `searchQuery` ref to `Sidebar.vue`, pipe it through the existing category filter functions using `fuzzyMatch()` from `utils/fuzzyMatch.ts`, and wire `⌘F` to focus the input via the existing keyboard shortcuts system.

**Tech Stack:** Vue 3, existing `fuzzyMatch` utility, `useKeyboardShortcuts` composable, vue-i18n

**Spec:** `docs/superpowers/specs/2026-03-26-task-fuzzy-search-design.md`

---

### Task 1: Add i18n Keys

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json:77-78` (sidebar section)
- Modify: `apps/desktop/src/i18n/locales/en.json:33-68` (shortcuts section)
- Modify: `apps/desktop/src/i18n/locales/ja.json:77-78`
- Modify: `apps/desktop/src/i18n/locales/ja.json:33-68`
- Modify: `apps/desktop/src/i18n/locales/ko.json:77-78`
- Modify: `apps/desktop/src/i18n/locales/ko.json:33-68`

- [ ] **Step 1: Update en.json**

In the `sidebar` section, replace `addRepo` and `addRepoTooltip` with `searchPlaceholder`:

```json
"searchPlaceholder": "Search tasks…  ⌘F"
```

In the `shortcuts` section, add after the `treeExplorer` entry:

```json
"focusSearch": "Focus Search"
```

- [ ] **Step 2: Update ja.json**

In the `sidebar` section, replace `addRepo` and `addRepoTooltip` with:

```json
"searchPlaceholder": "タスクを検索…  ⌘F"
```

In the `shortcuts` section, add:

```json
"focusSearch": "検索にフォーカス"
```

- [ ] **Step 3: Update ko.json**

In the `sidebar` section, replace `addRepo` and `addRepoTooltip` with:

```json
"searchPlaceholder": "작업 검색…  ⌘F"
```

In the `shortcuts` section, add:

```json
"focusSearch": "검색 포커스"
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "feat(i18n): add task search keys, remove addRepo sidebar keys"
```

---

### Task 2: Add `focusSearch` Keyboard Shortcut

**Files:**
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:4-32` (ActionName union)
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts:60-94` (shortcuts array)
- Modify: `apps/desktop/src/App.vue:304-464` (keyboardActions object)

- [ ] **Step 1: Add `focusSearch` to `ActionName` union**

In `useKeyboardShortcuts.ts`, add `"focusSearch"` to the `ActionName` type union (after `"openShellRepoRoot"`, the current last member):

```typescript
  | "openShellRepoRoot"
  | "focusSearch";
```

- [ ] **Step 2: Add shortcut definition to `shortcuts` array**

Add after the `toggleTreeExplorer` entry (line 86), before the Settings comment:

```typescript
  { action: "focusSearch", labelKey: "shortcuts.focusSearch", groupKey: "shortcuts.groupNavigation", key: "f", meta: true, display: "⌘F", context: ["main"] },
```

- [ ] **Step 3: Add `focusSearch` handler in App.vue's `keyboardActions`**

Add after `openPreferences` (line 463):

```typescript
  focusSearch: () => { sidebarRef.value?.focusSearch(); },
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors (the `focusSearch` method on Sidebar doesn't exist yet, but `sidebarRef` is typed via `InstanceType<typeof Sidebar>` which will pick it up after Task 3. If this fails, proceed — it will resolve after Task 3.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useKeyboardShortcuts.ts apps/desktop/src/App.vue
git commit -m "feat: add ⌘F focusSearch keyboard shortcut"
```

---

### Task 3: Replace Sidebar Footer and Add Search Filtering

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.vue:1-171` (script section)
- Modify: `apps/desktop/src/components/Sidebar.vue:173-436` (template section)
- Modify: `apps/desktop/src/components/Sidebar.vue:439-714` (style section)

- [ ] **Step 1: Add imports and search state to Sidebar script**

Add `fuzzyMatch` import at the top of the `<script setup>`:

```typescript
import { fuzzyMatch } from "../utils/fuzzyMatch";
```

Add search state refs after `collapsedRepos` (line 31):

```typescript
const searchQuery = ref("");
const searchInputRef = ref<HTMLInputElement | null>(null);
const preSearchCollapsed = ref<Set<string> | null>(null);
```

- [ ] **Step 2: Add a `matchesSearch` helper function**

Add after the `searchInputRef` declaration:

```typescript
function matchesSearch(item: PipelineItem): boolean {
  const q = searchQuery.value.trim();
  if (!q) return true;
  const fields = [item.display_name, item.issue_title, item.prompt, item.branch];
  return fields.some((f) => f && fuzzyMatch(q, f) !== null);
}
```

- [ ] **Step 3: Add the search filter to each sort function**

Update each of the five sort functions to filter by search query. Add `.filter(matchesSearch)` to each:

In `sortedPinned` (line 33-37), change the return to:

```typescript
function sortedPinned(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && !hasTag(i, "done") && i.pinned && matchesSearch(i))
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
}
```

In `sortedPR` (line 43-47):

```typescript
function sortedPR(repoId: string): PipelineItem[] {
  return sortByCreatedAt(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "pr") && !hasTag(i, "done") && !i.pinned && matchesSearch(i))
  );
}
```

In `sortedMerge` (line 49-53):

```typescript
function sortedMerge(repoId: string): PipelineItem[] {
  return sortByCreatedAt(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "merge") && !hasTag(i, "done") && !i.pinned && matchesSearch(i))
  );
}
```

In `sortedActive` (line 55-59):

```typescript
function sortedActive(repoId: string): PipelineItem[] {
  return sortByCreatedAt(
    props.pipelineItems.filter((i) => i.repo_id === repoId && !hasTag(i, "pr") && !hasTag(i, "merge") && !hasTag(i, "blocked") && !hasTag(i, "done") && !i.pinned && matchesSearch(i))
  );
}
```

In `sortedBlocked` (line 61-65):

```typescript
function sortedBlocked(repoId: string): PipelineItem[] {
  return sortByCreatedAt(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "blocked") && !hasTag(i, "done") && !i.pinned && matchesSearch(i))
  );
}
```

- [ ] **Step 4: Add collapse auto-expand/restore logic**

Add a `watch` on `searchQuery` (after the `matchesSearch` function):

```typescript
import { ref, nextTick, watch } from "vue";
```

(Update the existing import to include `watch`.)

```typescript
watch(searchQuery, (q) => {
  if (q.trim()) {
    if (!preSearchCollapsed.value) {
      preSearchCollapsed.value = new Set(collapsedRepos.value);
    }
    collapsedRepos.value = new Set();
  } else {
    if (preSearchCollapsed.value) {
      collapsedRepos.value = new Set(preSearchCollapsed.value);
      preSearchCollapsed.value = null;
    }
  }
});
```

- [ ] **Step 5: Add `focusSearch` method and update `defineExpose`**

Add `focusSearch` function:

```typescript
function focusSearch() {
  searchInputRef.value?.focus();
}
```

Update `defineExpose` (line 170):

```typescript
defineExpose({ renameSelectedItem, focusSearch });
```

- [ ] **Step 6: Remove `add-repo` emit**

Remove `(e: "add-repo"): void;` from the `defineEmits` block (line 21).

- [ ] **Step 7: Update the repo header count to show filtered count**

The `itemsForRepo` function (line 67-69) already composes the sort functions, so it will automatically reflect the search filter. No changes needed — the count at line 194 (`itemsForRepo(repo.id).length`) will show the filtered count.

- [ ] **Step 8: Hide repos with zero matching items**

Wrap each `repo-section` div with a `v-if` check. Change line 181:

```html
<div v-for="repo in repos" :key="repo.id" class="repo-section">
```

to:

```html
<div v-for="repo in repos" :key="repo.id" v-show="!searchQuery.trim() || itemsForRepo(repo.id).length > 0" class="repo-section">
```

(Use `v-show` instead of `v-if` to avoid destroying/recreating drag state.)

- [ ] **Step 9: Replace the sidebar footer template**

Replace the footer block (lines 431-435):

```html
<div class="sidebar-footer">
  <button class="btn-import" @click="emit('add-repo')" :title="$t('sidebar.addRepoTooltip')">
    {{ $t('sidebar.addRepo') }}
  </button>
</div>
```

with:

```html
<div class="sidebar-footer">
  <input
    ref="searchInputRef"
    v-model="searchQuery"
    type="text"
    class="search-input"
    :placeholder="$t('sidebar.searchPlaceholder')"
    @keydown.escape="searchQuery = ''; searchInputRef?.blur()"
  />
</div>
```

- [ ] **Step 10: Update styles**

Replace the `.btn-import` styles (lines 634-648) with `.search-input` styles:

Remove:
```css
.btn-import {
  flex: 1;
  padding: 6px 12px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #ccc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.btn-import:hover {
  background: #333;
  color: #e0e0e0;
}
```

Add:
```css
.search-input {
  flex: 1;
  padding: 6px 10px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #ccc;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.search-input:focus {
  border-color: #0066cc;
  background: #1a1a1a;
}

.search-input::placeholder {
  color: #555;
}
```

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/components/Sidebar.vue
git commit -m "feat: replace add-repo button with fuzzy search input in sidebar"
```

---

### Task 4: Clean Up Parent Component

**Files:**
- Modify: `apps/desktop/src/App.vue:620`

- [ ] **Step 1: Remove `@add-repo` handler from `<Sidebar>` in App.vue**

Remove this line from the `<Sidebar>` element (line 620):

```
@add-repo="addRepoInitialTab = 'import'; showAddRepoModal = true"
```

Do NOT remove `addRepoInitialTab`, `createRepo`, or `importRepo` — these are independent.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "fix: remove dead @add-repo handler from Sidebar usage"
```

---

### Task 5: Manual Verification

- [ ] **Step 1: Start the dev server**

```bash
./scripts/dev.sh
```

- [ ] **Step 2: Verify search input appears**

Open the app. The sidebar footer should show a search input with placeholder "Search tasks... ⌘F" instead of the old "Add Repo" button.

- [ ] **Step 3: Verify fuzzy search works**

Type a partial task name. Tasks that don't match should disappear. Repos with no matching tasks should hide. Clear the input — everything should restore.

- [ ] **Step 4: Verify `⌘F` focuses the search input**

Press `⌘F`. The search input should gain focus.

- [ ] **Step 5: Verify `Escape` clears and blurs**

Type a query, press Escape. The query should clear and the input should lose focus.

- [ ] **Step 6: Verify collapse restore**

Collapse a repo, type a search query (all repos expand), clear query. The previously collapsed repo should be collapsed again.

- [ ] **Step 7: Verify `⌘I` / `⇧⌘I` still work**

Press `⌘I` — the Add Repo modal should open in "Create" tab.
Press `⇧⌘I` — the Add Repo modal should open in "Import" tab.

- [ ] **Step 8: Verify drag-and-drop still works during search**

With an active search query, drag a visible task to the pinned zone. It should pin correctly.
