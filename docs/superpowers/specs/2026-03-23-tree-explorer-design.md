# Tree Explorer Design

## Summary

A ranger-style Miller column file browser presented as a modal overlay, opened via `⌘⇧E`. Three-pane layout (parent / current / preview) with vim-key navigation, type-to-filter, and tactile column slide animations. Designed for spatial navigation — when you know where a file lives but not what it's called.

## Motivation

The existing `⌘P` file picker is search-first — great when you know a filename, but useless when you're browsing by location. A tree explorer fills the gap: spatial, structural, nostalgic.

## Architecture

### Backend: `read_dir_entries` Tauri command

**File:** `apps/desktop/src-tauri/src/commands/fs.rs`

```rust
#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    is_dir: bool,
}

#[tauri::command]
pub fn read_dir_entries(path: String, repo_root: String) -> Result<Vec<DirEntry>, String>
```

- Uses the `ignore` crate to respect `.gitignore` at all levels, global gitignore (`~/.config/git/ignore`), and `.git/info/exclude`
- `repo_root` provides the `.gitignore` hierarchy root — the frontend already knows this from the selected repo
- Hardcode-skips `.git/` itself (gitignore doesn't cover it)
- Sorts: directories first, then files, both alphabetical case-insensitive
- Returns `Vec<DirEntry>` — minimal `{ name, is_dir }`
- Dotfiles that aren't gitignored are shown (gitignore is the single source of truth)
- Must also be mocked in `tauri-mock.ts` for browser dev mode

**New Rust dependency:** `ignore` crate (by the ripgrep author, pure Rust, no system deps).

### Frontend state: `useTreeExplorer` composable

**File:** `apps/desktop/src/composables/useTreeExplorer.ts`

```typescript
interface TreeNode {
  name: string
  isDir: boolean
  path: string          // relative to repo root
  children?: TreeNode[] // populated when loaded
  loaded: boolean       // whether children have been fetched
}

interface MillerState {
  columns: TreeNode[][]  // [parent entries, current entries, preview entries]
  cursor: number[]       // active index per column [parentIdx, currentIdx, previewIdx]
  activeColumn: number   // 0=parent, 1=current, 2=preview
  breadcrumb: string[]   // ["src", "composables"] path segments
}
```

**Key behaviors:**

- **`navigate(direction: 'h'|'j'|'k'|'l')`** — moves cursor or shifts columns
  - `j`/`k` — move cursor within active column
  - `l` on a dir — shift columns right (parent←current←preview, load new preview children)
  - `l` on a file — open file preview modal
  - `h` — shift columns left (go up one level)
- **`prefetch(path)`** — called whenever cursor lands on a directory, loads its children in background (1-level-ahead strategy)
- **`filterText`** — reactive string; typing filters active column entries by fuzzy match
- **Cache** — `Map<string, TreeNode[]>` keyed by path; revisiting a directory is instant
- **Virtual list** — each column uses `useVirtualList` from `@vueuse/core`, item height fixed at ~28px

### Component: `TreeExplorerModal.vue`

**File:** `apps/desktop/src/components/TreeExplorerModal.vue`

**Layout:**

```
┌─ Modal overlay ─────────────────────────────────┐
│ ┌─ Breadcrumb bar ────────────────────────────┐ │
│ │  ~ / src / composables /                    │ │
│ ├─────────────┬───────────────┬───────────────┤ │
│ │  Parent     │  Current      │  Preview      │ │
│ │             │               │               │ │
│ │  apps/      │ ▸ components/ │  usePipe…     │ │
│ │  crates/    │ ▾ composables/│  useRepo…     │ │
│ │  packages/  │   stores/     │  useTerm…     │ │
│ │ ▸src/       │   App.vue     │  useToast…    │ │
│ │  scripts/   │   main.ts     │               │ │
│ │             │               │               │ │
│ ├─────────────┴───────────────┴───────────────┤ │
│ │ ⌨ filter: ___                    Esc close  │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- **Three columns**, flex layout, equal width. Active column gets subtle left border highlight (`#0066cc`)
- **Cursor** — highlighted row with `background: #0066cc44`, gold left-border accent (`#ffcc00`) matching existing sidebar selection pattern
- **Directories** show `▸` (collapsed) or `▾` (in current path). Files are plain text.
- **Breadcrumb bar** at top — clickable segments to jump up multiple levels
- **Filter bar** at bottom — appears when typing, filters active column. `Esc` clears filter first, closes modal on second press
- **Virtual scroll** — each column is a `useVirtualList` container, so directories with 1000+ entries only render ~20 DOM nodes

**Keyboard map:**

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down in active column |
| `k` / `↑` | Move cursor up in active column |
| `l` / `→` / `Enter` | Enter directory or open file preview |
| `h` / `←` | Go to parent directory |
| `y` | Yank (copy) current file/dir path to clipboard |
| `gg` | Jump to top of column |
| `G` | Jump to bottom of column |
| `/` or just start typing | Filter current column |
| `Esc` | Clear filter, or close modal |

### Integration

**Keyboard shortcut:**
- `⌘⇧E` registered in `useKeyboardShortcuts.ts` with action `toggleTreeExplorer`
- Added to `KeyboardShortcutsModal.vue` help menu under a "Navigation" section
- Context: works from main view and shell terminal (same as `⌘P`)

**Modal mounting:**
- `<TreeExplorerModal>` added in `App.vue` alongside existing modals
- Controlled by reactive `showTreeExplorer` ref (local to App.vue, matching other modals)

**File preview handoff:**
- `Enter` on a file emits `open-file` with full path
- `App.vue` closes tree modal, opens `FilePreviewModal` with that path — reuses existing infrastructure

**Root path logic:**
- Task selected → open at worktree path
- Repo selected (no task) → open at repo root
- Nothing selected → no-op

**Mock layer:**
- `read_dir_entries` added to `tauri-mock.ts` returning a fake directory structure

**No new frontend dependencies.** `@vueuse/core` (for `useVirtualList`) is already installed. `ignore` crate is new on Rust side only.

## Tactile Polish

### Column transitions (entering/leaving directories)

- **Easing:** `cubic-bezier(0, 0, .2, 1)` at 180ms — fast start, gentle deceleration
- All three columns slide as a unit via `transform: translateX()` — creates the sensation of moving *through* the filesystem
- `l` slides left (deeper), `h` slides right (shallower)

### Cursor movement (j/k within a column)

- **Instant.** No transition. Highlight snaps immediately.
- Background: `#0066cc44` with `2px solid #ffcc00` left border

### Other details

- **Type-to-filter** — non-matching entries fade to 30% opacity (not removed), preserving spatial context. Backspace restores. Clear on column change.
- **Breadcrumb** — clickable path segments, clicking jumps directly to that depth
- **Directory arrows** — `▸` / `▾` for dirs in current path vs collapsed. No animation on arrows.
- **Empty directory** — centered dim `(empty)` message
- **Loading state** — preview column shows pulsing `···` placeholder while fetching

## Styling

Follows existing app conventions:
- Dark theme: `#1a1a1a` / `#1e1e1e` backgrounds
- Text: `#ccc` / `#888` hierarchy
- Selection: `#0066cc` blue, `#ffcc00` gold accent
- Font: JetBrains Mono for all tree content
- Modal: `.modal-overlay` with `rgba(0,0,0,0.6)` backdrop
- Hover: `#333` background on items
- Borders: `1px solid #333` between columns

## Files to Create

1. `apps/desktop/src/components/TreeExplorerModal.vue` — the modal component
2. `apps/desktop/src/composables/useTreeExplorer.ts` — state management composable

## Files to Modify

1. `apps/desktop/src-tauri/src/commands/fs.rs` — add `read_dir_entries` command
2. `apps/desktop/src-tauri/src/commands/mod.rs` — register new command
3. `apps/desktop/src-tauri/src/main.rs` or `lib.rs` — add command to handler
4. `apps/desktop/src-tauri/Cargo.toml` — add `ignore` crate dependency
5. `apps/desktop/src/App.vue` — mount `TreeExplorerModal`, wire shortcut + events
6. `apps/desktop/src/composables/useKeyboardShortcuts.ts` — register `⌘⇧E`
7. `apps/desktop/src/components/KeyboardShortcutsModal.vue` — add to help menu
8. `apps/desktop/src/tauri-mock.ts` — mock `read_dir_entries`
9. `apps/desktop/src/invoke.ts` — add type for the new command (if typed invocations are used)
