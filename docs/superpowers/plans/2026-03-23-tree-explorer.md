# Tree Explorer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ranger-style Miller column file browser modal (`⌘⇧E`) with vim-key navigation, type-to-filter, and tactile column slide animations.

**Architecture:** New `read_dir_entries` Tauri command using the `ignore` crate for .gitignore-aware directory listing. `useTreeExplorer` composable manages Miller column state (3 columns, cursor, cache, prefetch). `TreeExplorerModal.vue` renders the UI with virtual lists and CSS slide transitions. Wired into App.vue alongside existing modals.

**Tech Stack:** Rust (`ignore` crate), Vue 3 (`<script setup>`), `@vueuse/core` (`useVirtualList`), CSS transitions

**Spec:** `docs/superpowers/specs/2026-03-23-tree-explorer-design.md`

---

## File Structure

### Files to Create
| File | Responsibility |
|------|---------------|
| `apps/desktop/src/composables/useTreeExplorer.ts` | Miller column state: navigation, prefetch, cache, filter |
| `apps/desktop/src/components/TreeExplorerModal.vue` | Modal UI: 3 columns, breadcrumb, filter bar, keyboard handler, animations |

### Files to Modify
| File | Change |
|------|--------|
| `apps/desktop/src-tauri/Cargo.toml` | Add `ignore` crate dependency |
| `apps/desktop/src-tauri/src/commands/fs.rs` | Add `DirEntry` struct + `read_dir_entries` command |
| `apps/desktop/src-tauri/src/lib.rs` | Register `read_dir_entries` in invoke handler (~line 390) |
| `apps/desktop/src/tauri-mock.ts` | Add `read_dir_entries` mock handler |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | Add `toggleTreeExplorer` action + `⌘⇧E` shortcut def |
| `apps/desktop/src/components/KeyboardShortcutsModal.vue` | No change needed (auto-renders from "Navigation" group) |
| `apps/desktop/src/App.vue` | Mount modal, add `showTreeExplorer` ref, wire open-file handoff |

---

### Task 1: Add `ignore` crate and `read_dir_entries` Rust command

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add dependency, ~line 30)
- Modify: `apps/desktop/src-tauri/src/commands/fs.rs` (add command after `list_dir`, ~line 66)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register command, ~line 390)

- [ ] **Step 1: Add `ignore` crate to Cargo.toml**

In `apps/desktop/src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
ignore = "0.4"
```

- [ ] **Step 2: Add `DirEntry` struct and `read_dir_entries` command to fs.rs**

Add after the `list_dir` function (~line 66) in `apps/desktop/src-tauri/src/commands/fs.rs`:

```rust
#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn read_dir_entries(path: String, repo_root: String) -> Result<Vec<DirEntry>, String> {
    use ignore::gitignore::GitignoreBuilder;
    use std::path::Path;

    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    // Build gitignore matcher rooted at repo_root
    let root = Path::new(&repo_root);
    let mut builder = GitignoreBuilder::new(root);

    // Walk up from repo_root to find all .gitignore files in the hierarchy
    fn add_gitignores(builder: &mut GitignoreBuilder, dir: &std::path::Path) {
        let gi = dir.join(".gitignore");
        if gi.exists() {
            let _ = builder.add(gi);
        }
    }

    // Add repo root .gitignore
    add_gitignores(&mut builder, root);

    // Add .gitignore files along the path from root to target dir
    if let Ok(rel) = dir.strip_prefix(root) {
        let mut current = root.to_path_buf();
        for component in rel.components() {
            current = current.join(component);
            add_gitignores(&mut builder, &current);
        }
    }

    // Add global gitignore
    if let Some(global) = ignore::gitignore::Gitignore::global().0.path().map(|p| p.to_path_buf()) {
        let _ = builder.add(global);
    }

    let gitignore = builder.build().map_err(|e| format!("gitignore error: {}", e))?;

    let read = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read dir '{}': {}", path, e))?;

    let mut entries: Vec<DirEntry> = Vec::new();

    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Always skip .git directory
        if name == ".git" {
            continue;
        }

        let entry_path = entry.path();
        let is_dir = entry_path.is_dir();

        // Check gitignore — pass the full path and whether it's a directory
        let matched = gitignore.matched_path_or_any_parents(&entry_path, is_dir);
        if matched.is_ignore() {
            continue;
        }

        entries.push(DirEntry { name, is_dir });
    }

    // Sort: directories first, then files, both case-insensitive alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}
```

- [ ] **Step 3: Register command in lib.rs**

In `apps/desktop/src-tauri/src/lib.rs`, add to the `generate_handler!` macro after `commands::fs::ensure_directory`:

```rust
commands::fs::read_dir_entries,
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: Compiles without errors

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/commands/fs.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tree-explorer): add read_dir_entries Tauri command with gitignore support"
```

---

### Task 2: Add mock and register shortcut

**Files:**
- Modify: `apps/desktop/src/tauri-mock.ts` (add mock handler, ~line 230)
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts` (add action + shortcut def)

- [ ] **Step 1: Add mock handler for `read_dir_entries`**

In `apps/desktop/src/tauri-mock.ts`, add to the `invokeHandlers` object:

```typescript
read_dir_entries: () => [
  { name: "src", is_dir: true },
  { name: "components", is_dir: true },
  { name: "composables", is_dir: true },
  { name: "stores", is_dir: true },
  { name: "App.vue", is_dir: false },
  { name: "main.ts", is_dir: false },
],
```

- [ ] **Step 2: Add `toggleTreeExplorer` to ActionName type**

In `apps/desktop/src/composables/useKeyboardShortcuts.ts`, add to the `ActionName` union type:

```typescript
| "toggleTreeExplorer"
```

- [ ] **Step 3: Add shortcut definition**

In the `shortcuts` array (same file), add in the Navigation group section:

```typescript
{ action: "toggleTreeExplorer", label: "Tree Explorer", group: "Navigation", key: "e", meta: true, shift: true, display: "⇧⌘E", context: ["main", "shell"] },
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors (there will be a warning that `toggleTreeExplorer` action isn't handled yet — that's fine, handled in Task 4)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/tauri-mock.ts apps/desktop/src/composables/useKeyboardShortcuts.ts
git commit -m "feat(tree-explorer): register shortcut and add mock"
```

---

### Task 3: Create `useTreeExplorer` composable

**Files:**
- Create: `apps/desktop/src/composables/useTreeExplorer.ts`

- [ ] **Step 1: Create the composable file**

Create `apps/desktop/src/composables/useTreeExplorer.ts`:

```typescript
import { ref, computed, shallowRef } from "vue";
import { invoke } from "../invoke";

export interface TreeNode {
  name: string;
  isDir: boolean;
  path: string;
}

interface DirEntryResponse {
  name: string;
  is_dir: boolean;
}

export interface MillerState {
  columns: TreeNode[][];
  cursor: number[];
  activeColumn: number;
  breadcrumb: string[];
}

export function useTreeExplorer(rootPath: () => string, repoRoot: () => string) {
  const cache = new Map<string, TreeNode[]>();

  const state = ref<MillerState>({
    columns: [[], [], []],
    cursor: [0, 0, 0],
    activeColumn: 1,
    breadcrumb: [],
  });

  const filterText = ref("");
  const loading = ref(false);
  const slideDirection = shallowRef<"left" | "right" | null>(null);

  // Pending g key for gg sequence
  const pendingG = ref(false);
  let pendingGTimer: ReturnType<typeof setTimeout> | null = null;

  async function fetchDir(dirPath: string): Promise<TreeNode[]> {
    if (cache.has(dirPath)) return cache.get(dirPath)!;

    const entries = await invoke<DirEntryResponse[]>("read_dir_entries", {
      path: dirPath,
      repoRoot: repoRoot(),
    });

    const nodes: TreeNode[] = entries.map((e) => {
      const rel = dirPath === repoRoot()
        ? e.name
        : dirPath.replace(repoRoot() + "/", "") + "/" + e.name;
      return { name: e.name, isDir: e.is_dir, path: rel };
    });

    cache.set(dirPath, nodes);
    return nodes;
  }

  function absolutePath(relativePath: string): string {
    return relativePath ? `${repoRoot()}/${relativePath}` : repoRoot();
  }

  function breadcrumbToAbsolute(segments: string[]): string {
    return segments.length === 0
      ? repoRoot()
      : `${repoRoot()}/${segments.join("/")}`;
  }

  async function prefetch(node: TreeNode) {
    if (!node.isDir) return;
    const absPath = absolutePath(node.path);
    if (!cache.has(absPath)) {
      fetchDir(absPath).catch(() => {});
    }
  }

  // Filtered entries for the active column
  const filteredColumn = computed(() => {
    const col = state.value.activeColumn;
    const entries = state.value.columns[col] ?? [];
    if (!filterText.value) return entries;
    const lower = filterText.value.toLowerCase();
    return entries.map((entry) => ({
      ...entry,
      _dimmed: !entry.name.toLowerCase().includes(lower),
    }));
  });

  async function open(initialPath?: string) {
    const startPath = initialPath ?? rootPath();
    const bc = startPath === repoRoot()
      ? []
      : startPath.replace(repoRoot() + "/", "").split("/");

    state.value.breadcrumb = bc;
    loading.value = true;

    try {
      const currentAbs = breadcrumbToAbsolute(bc);
      const currentEntries = await fetchDir(currentAbs);

      // Parent column
      let parentEntries: TreeNode[] = [];
      if (bc.length > 0) {
        const parentBc = bc.slice(0, -1);
        const parentAbs = breadcrumbToAbsolute(parentBc);
        parentEntries = await fetchDir(parentAbs);
      }

      // Preview column (first dir entry's children, or first entry)
      let previewEntries: TreeNode[] = [];
      const firstDir = currentEntries.find((e) => e.isDir);
      if (firstDir) {
        previewEntries = await fetchDir(absolutePath(firstDir.path));
      }

      state.value.columns = [parentEntries, currentEntries, previewEntries];
      state.value.cursor = [
        // Parent cursor: index of current dir in parent
        bc.length > 0
          ? parentEntries.findIndex((e) => e.name === bc[bc.length - 1])
          : 0,
        0,
        0,
      ];
      state.value.activeColumn = 1;
      filterText.value = "";

      // Prefetch one level ahead for visible dirs
      for (const entry of currentEntries.slice(0, 20)) {
        prefetch(entry);
      }
    } finally {
      loading.value = false;
    }
  }

  async function navigateRight(): Promise<string | null> {
    const col = state.value.columns[1];
    const idx = state.value.cursor[1];
    const entry = col?.[idx];
    if (!entry) return null;

    if (!entry.isDir) {
      // Return file path for opening
      return entry.path;
    }

    // Enter directory
    slideDirection.value = "left";
    const newBc = [...state.value.breadcrumb, entry.name];
    state.value.breadcrumb = newBc;

    const newCurrentAbs = absolutePath(entry.path);
    const newCurrentEntries = await fetchDir(newCurrentAbs);

    // Current becomes parent, preview becomes current
    const oldCurrent = state.value.columns[1];
    const oldCursorIdx = state.value.cursor[1];

    let previewEntries: TreeNode[] = [];
    const firstDir = newCurrentEntries.find((e) => e.isDir);
    if (firstDir) {
      previewEntries = await fetchDir(absolutePath(firstDir.path));
    }

    state.value.columns = [oldCurrent, newCurrentEntries, previewEntries];
    state.value.cursor = [oldCursorIdx, 0, 0];
    filterText.value = "";

    // Prefetch
    for (const e of newCurrentEntries.slice(0, 20)) {
      prefetch(e);
    }

    // Clear slide direction after animation
    setTimeout(() => { slideDirection.value = null; }, 200);
    return null;
  }

  async function navigateLeft() {
    if (state.value.breadcrumb.length === 0) return;

    slideDirection.value = "right";
    // Capture the dir name we're leaving BEFORE mutating breadcrumb
    const leavingDirName = state.value.breadcrumb[state.value.breadcrumb.length - 1];
    const newBc = state.value.breadcrumb.slice(0, -1);
    state.value.breadcrumb = newBc;

    // Parent becomes new current
    const newCurrentAbs = breadcrumbToAbsolute(newBc);
    const newCurrentEntries = await fetchDir(newCurrentAbs);

    // Fetch new parent
    let newParentEntries: TreeNode[] = [];
    if (newBc.length > 0) {
      const parentBc = newBc.slice(0, -1);
      newParentEntries = await fetchDir(breadcrumbToAbsolute(parentBc));
    }

    // Old current becomes preview (the column we just left)
    const oldCurrent = state.value.columns[1];

    // Restore cursor to the directory we just navigated out of
    const restoredIdx = newCurrentEntries.findIndex((e) => e.name === leavingDirName);

    state.value.columns = [newParentEntries, newCurrentEntries, oldCurrent];
    state.value.cursor = [
      newBc.length > 0
        ? newParentEntries.findIndex((e) => e.name === newBc[newBc.length - 1])
        : 0,
      restoredIdx >= 0 ? restoredIdx : 0,
      0,
    ];
    filterText.value = "";

    setTimeout(() => { slideDirection.value = null; }, 200);
  }

  async function moveCursor(delta: number) {
    const col = state.value.columns[1];
    if (!col?.length) return;
    const newIdx = Math.max(0, Math.min(col.length - 1, state.value.cursor[1] + delta));
    state.value.cursor[1] = newIdx;

    // Update preview column
    const entry = col[newIdx];
    if (entry?.isDir) {
      const previewEntries = await fetchDir(absolutePath(entry.path));
      state.value.columns[2] = previewEntries;
      state.value.cursor[2] = 0;
    } else {
      state.value.columns[2] = [];
      state.value.cursor[2] = 0;
    }
  }

  function jumpTop() {
    state.value.cursor[1] = 0;
    // Trigger preview update
    moveCursor(0);
  }

  function jumpBottom() {
    const col = state.value.columns[1];
    if (!col?.length) return;
    state.value.cursor[1] = col.length - 1;
    moveCursor(0);
  }

  async function jumpToBreadcrumb(index: number) {
    const newBc = state.value.breadcrumb.slice(0, index);
    // Re-open at that level
    const targetPath = newBc.length === 0 ? repoRoot() : `${repoRoot()}/${newBc.join("/")}`;
    await open(targetPath);
  }

  function currentFilePath(): string | null {
    const col = state.value.columns[1];
    const idx = state.value.cursor[1];
    const entry = col?.[idx];
    return entry?.path ?? null;
  }

  /** Handle a key event. Returns file path string if a file should be opened, null otherwise. */
  async function handleKey(e: KeyboardEvent): Promise<string | null> {
    // Filter mode: typing characters
    if (filterText.value && e.key === "Escape") {
      e.preventDefault();
      filterText.value = "";
      return null;
    }

    // gg sequence
    if (pendingG.value) {
      pendingG.value = false;
      if (pendingGTimer) clearTimeout(pendingGTimer);
      if (e.key === "g") {
        e.preventDefault();
        jumpTop();
        return null;
      }
    }

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        await moveCursor(1);
        return null;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        await moveCursor(-1);
        return null;
      case "l":
      case "ArrowRight":
      case "Enter":
        e.preventDefault();
        return await navigateRight();
      case "h":
      case "ArrowLeft":
        e.preventDefault();
        await navigateLeft();
        return null;
      case "y":
        e.preventDefault();
        // Yank path handled by component (needs clipboard API)
        return null;
      case "g":
        if (!e.shiftKey) {
          e.preventDefault();
          pendingG.value = true;
          pendingGTimer = setTimeout(() => { pendingG.value = false; }, 500);
          return null;
        }
        break;
      case "G":
        e.preventDefault();
        jumpBottom();
        return null;
      case "/":
        e.preventDefault();
        // Focus filter — handled by component
        return null;
      default:
        // Type-to-filter: printable characters
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          filterText.value += e.key;
          return null;
        }
    }

    return null;
  }

  function reset() {
    state.value = {
      columns: [[], [], []],
      cursor: [0, 0, 0],
      activeColumn: 1,
      breadcrumb: [],
    };
    filterText.value = "";
    cache.clear();
    slideDirection.value = null;
    pendingG.value = false;
  }

  return {
    state,
    filterText,
    loading,
    slideDirection,
    filteredColumn,
    open,
    handleKey,
    currentFilePath,
    jumpToBreadcrumb,
    reset,
    pendingG,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors in the new file

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/useTreeExplorer.ts
git commit -m "feat(tree-explorer): add useTreeExplorer composable with Miller column state"
```

---

### Task 4: Create `TreeExplorerModal.vue` component

**Files:**
- Create: `apps/desktop/src/components/TreeExplorerModal.vue`

- [ ] **Step 1: Create the modal component**

Create `apps/desktop/src/components/TreeExplorerModal.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useTreeExplorer, type TreeNode } from "../composables/useTreeExplorer";

const props = defineProps<{
  worktreePath: string;
  repoRoot: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-file", filePath: string): void;
}>();

const modalRef = ref<HTMLElement | null>(null);

const {
  state,
  filterText,
  loading,
  slideDirection,
  open,
  handleKey,
  currentFilePath,
  jumpToBreadcrumb,
  reset,
} = useTreeExplorer(
  () => props.worktreePath,
  () => props.repoRoot
);

// Virtual lists for each column
const parentList = useVirtualList(
  () => state.value.columns[0] ?? [],
  { itemHeight: 28 }
);
const currentList = useVirtualList(
  () => state.value.columns[1] ?? [],
  { itemHeight: 28 }
);
const previewList = useVirtualList(
  () => state.value.columns[2] ?? [],
  { itemHeight: 28 }
);

async function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && !filterText.value) {
    e.preventDefault();
    emit("close");
    return;
  }

  if (e.key === "y" && !e.metaKey && !e.ctrlKey) {
    const path = currentFilePath();
    if (path) {
      e.preventDefault();
      await navigator.clipboard.writeText(path);
      return;
    }
  }

  const filePath = await handleKey(e);
  if (filePath) {
    emit("open-file", filePath);
  }
}

onMounted(async () => {
  await open();
  await nextTick();
  modalRef.value?.focus();
});

onUnmounted(() => {
  reset();
});

// Scroll active item into view when cursor changes
watch(
  () => state.value.cursor[1],
  () => {
    currentList.scrollTo(state.value.cursor[1]);
  }
);

function isInPath(entry: TreeNode, column: number): boolean {
  if (column === 0) {
    const bc = state.value.breadcrumb;
    return bc.length > 0 && entry.name === bc[bc.length - 1];
  }
  return false;
}

function isDimmed(entry: TreeNode): boolean {
  if (!filterText.value) return false;
  return !entry.name.toLowerCase().includes(filterText.value.toLowerCase());
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div
      ref="modalRef"
      class="tree-modal"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <!-- Breadcrumb bar -->
      <div class="breadcrumb-bar">
        <span
          class="breadcrumb-segment breadcrumb-root"
          @click="jumpToBreadcrumb(0)"
        >~</span>
        <template v-for="(seg, i) in state.breadcrumb" :key="i">
          <span class="breadcrumb-sep">/</span>
          <span
            class="breadcrumb-segment"
            @click="jumpToBreadcrumb(i + 1)"
          >{{ seg }}</span>
        </template>
        <span class="breadcrumb-sep">/</span>
      </div>

      <!-- Miller columns -->
      <div
        class="miller-columns"
        :class="{
          'slide-left': slideDirection === 'left',
          'slide-right': slideDirection === 'right',
        }"
      >
        <!-- Parent column -->
        <div class="miller-col col-parent">
          <div
            v-bind="parentList.containerProps"
            class="col-scroll"
          >
            <div v-bind="parentList.wrapperProps">
              <div
                v-for="{ data: entry, index } in parentList.list"
                :key="entry.path"
                class="tree-item"
                :class="{
                  active: isInPath(entry, 0),
                }"
              >
                <span v-if="entry.isDir" class="dir-arrow">{{ isInPath(entry, 0) ? '▾' : '▸' }}</span>
                <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
              </div>
            </div>
          </div>
          <div v-if="state.columns[0].length === 0" class="col-empty">(root)</div>
        </div>

        <!-- Current column (active) -->
        <div class="miller-col col-current">
          <div
            v-bind="currentList.containerProps"
            class="col-scroll"
          >
            <div v-bind="currentList.wrapperProps">
              <div
                v-for="{ data: entry, index } in currentList.list"
                :key="entry.path"
                class="tree-item"
                :class="{
                  cursor: index === state.cursor[1],
                  dimmed: isDimmed(entry),
                }"
              >
                <span v-if="entry.isDir" class="dir-arrow">▸</span>
                <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
              </div>
            </div>
          </div>
          <div v-if="loading" class="col-loading">···</div>
          <div v-else-if="state.columns[1].length === 0" class="col-empty">(empty)</div>
        </div>

        <!-- Preview column -->
        <div class="miller-col col-preview">
          <div
            v-bind="previewList.containerProps"
            class="col-scroll"
          >
            <div v-bind="previewList.wrapperProps">
              <div
                v-for="{ data: entry, index } in previewList.list"
                :key="entry.path"
                class="tree-item"
                :class="{
                  cursor: index === state.cursor[2],
                }"
              >
                <span v-if="entry.isDir" class="dir-arrow">▸</span>
                <span class="entry-name">{{ entry.name }}{{ entry.isDir ? '/' : '' }}</span>
              </div>
            </div>
          </div>
          <div v-if="state.columns[2].length === 0 && !loading" class="col-empty">
            {{ state.columns[1].length > 0 ? '(no preview)' : '' }}
          </div>
        </div>
      </div>

      <!-- Filter bar -->
      <div class="filter-bar">
        <span v-if="filterText" class="filter-text">
          filter: <strong>{{ filterText }}</strong>
          <span class="filter-hint">(Esc to clear)</span>
        </span>
        <span v-else class="filter-hint">type to filter · Esc to close</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  z-index: 1000;
}

.tree-modal {
  width: 780px;
  max-height: 60vh;
  background: #1e1e1e;
  border-radius: 10px;
  border: 1px solid #333;
  display: flex;
  flex-direction: column;
  outline: none;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

/* Breadcrumb */
.breadcrumb-bar {
  padding: 10px 14px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #888;
  border-bottom: 1px solid #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.breadcrumb-segment {
  color: #ccc;
  cursor: pointer;
}

.breadcrumb-segment:hover {
  color: #ffcc00;
}

.breadcrumb-root {
  color: #888;
}

.breadcrumb-sep {
  margin: 0 2px;
  color: #555;
}

/* Miller columns */
.miller-columns {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.miller-columns.slide-left {
  animation: slide-left 180ms cubic-bezier(0, 0, .2, 1);
}

.miller-columns.slide-right {
  animation: slide-right 180ms cubic-bezier(0, 0, .2, 1);
}

@keyframes slide-left {
  from { transform: translateX(33.33%); }
  to { transform: translateX(0); }
}

@keyframes slide-right {
  from { transform: translateX(-33.33%); }
  to { transform: translateX(0); }
}

.miller-col {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.miller-col + .miller-col {
  border-left: 1px solid #333;
}

.col-current {
  border-left: 2px solid #0066cc !important;
}

.col-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Tree items */
.tree-item {
  height: 28px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #888;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item:hover {
  background: #333;
}

.tree-item.cursor {
  background: #0066cc44;
  border-left: 2px solid #ffcc00;
  padding-left: 8px;
  color: #fff;
}

.tree-item.active {
  color: #0066cc;
}

.tree-item.dimmed {
  opacity: 0.3;
}

.dir-arrow {
  width: 14px;
  flex-shrink: 0;
  color: #ffcc00;
  font-size: 10px;
}

.entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Empty / loading states */
.col-empty,
.col-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  pointer-events: none;
}

.col-loading {
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* Filter bar */
.filter-bar {
  padding: 8px 14px;
  border-top: 1px solid #333;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #888;
}

.filter-text {
  color: #ccc;
}

.filter-text strong {
  color: #ffcc00;
}

.filter-hint {
  color: #555;
  margin-left: 4px;
}
</style>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/TreeExplorerModal.vue
git commit -m "feat(tree-explorer): add TreeExplorerModal with Miller columns and vim keys"
```

---

### Task 5: Wire into App.vue

**Files:**
- Modify: `apps/desktop/src/App.vue` (~lines 48-51 for refs, ~253 for action handler, ~502-514 for template)

- [ ] **Step 1: Add state refs**

In `apps/desktop/src/App.vue`, near the existing modal refs (~line 48-51), add:

```typescript
const showTreeExplorer = ref(false);
```

- [ ] **Step 2: Add action handler**

In the keyboard action handlers object (~line 253 area, near `openFile`), add:

```typescript
toggleTreeExplorer: () => {
  showTreeExplorer.value = !showTreeExplorer.value;
},
```

- [ ] **Step 3: Add import**

Add import at the top of `<script setup>`:

```typescript
import TreeExplorerModal from "./components/TreeExplorerModal.vue";
```

- [ ] **Step 4: Add modal to template**

After the `FilePreviewModal` block (~line 514), add:

```vue
<TreeExplorerModal
  v-if="showTreeExplorer && store.selectedRepo?.path"
  :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
  :repo-root="store.selectedRepo.path"
  @close="showTreeExplorer = false; focusAgentTerminal()"
  @open-file="(f: string) => { showTreeExplorer = false; previewFilePath = f; showFilePreviewModal = true; }"
/>
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat(tree-explorer): wire modal into App.vue with shortcut and file preview handoff"
```

---

### Task 6: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
./scripts/dev.sh
```

- [ ] **Step 2: Test basic flow**

1. Select a repo in the sidebar
2. Press `⌘⇧E` — tree explorer modal should open
3. Verify three columns render with directory contents
4. Press `j`/`k` — cursor should move instantly (no animation)
5. Press `l` on a directory — columns should slide left (180ms ease-out)
6. Press `h` — columns should slide right
7. Press `Enter` on a file — file preview modal should open
8. Press `Esc` — modal should close
9. Type characters — filter should appear, non-matching entries should dim
10. Press `y` — path should copy to clipboard
11. Check `⌘⇧E` appears in the shortcuts help modal (`⌘/`)

- [ ] **Step 3: Test edge cases**

1. Open tree at repo root — parent column should show "(root)"
2. Navigate into an empty directory — current column should show "(empty)"
3. Navigate into a directory with many files — virtual scroll should handle it
4. Verify `.git/` is not shown, `node_modules/` is not shown (if gitignored)

- [ ] **Step 4: Fix any issues found, commit**

```bash
git add -A
git commit -m "fix(tree-explorer): address smoke test issues"
```

---

### Task 7: Polish and animation refinement

**Files:**
- Modify: `apps/desktop/src/components/TreeExplorerModal.vue` (CSS tweaks)
- Modify: `apps/desktop/src/composables/useTreeExplorer.ts` (edge case fixes)

- [ ] **Step 1: Verify slide animation feels right**

Test column transitions — confirm 180ms `cubic-bezier(0, 0, .2, 1)` feels like smooth ease-out. Adjust timing if needed.

- [ ] **Step 2: Verify cursor is truly instant**

Navigate quickly with `j`/`k` — highlight should snap with zero delay. No `transition` property on `.tree-item.cursor`.

- [ ] **Step 3: Test type-to-filter clarity**

Type to filter — dimmed entries should be at 30% opacity. Verify spatial positions are preserved (entries don't reflow). Backspace should remove characters. Column change should clear filter.

- [ ] **Step 4: Test breadcrumb navigation**

Click breadcrumb segments — should jump directly to that depth. Verify breadcrumb updates correctly on `h`/`l` navigation.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(tree-explorer): polish animations and edge cases"
```
