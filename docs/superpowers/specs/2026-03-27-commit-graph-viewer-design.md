# Commit Graph Viewer

## Summary

A read-only, visually polished git commit graph modal that renders the full repository DAG as an SVG visualization. Pure eye candy — no click interactions, just scroll and admire. Opens via keyboard shortcut, virtual-scrolls the entire repo history.

## Context

Kanna has no commit history visualization. The existing `git_log` Tauri command returns `hash`, `message`, `author` — insufficient for graph layout (missing parent hashes and timestamps). No pre-built Vue 3 git graph component exists; the closest production-quality option is DoltHub's `commit-graph` (React, Apache-2.0). We'll port their layout algorithm and build a custom SVG renderer.

## Design

### Backend: Extended Git Log Command

New Tauri command in `apps/desktop/src-tauri/src/commands/git.rs`:

```rust
#[derive(Serialize)]
pub struct GraphCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

#[tauri::command]
pub async fn git_graph(repo_path: String, max_count: Option<usize>) -> Result<Vec<GraphCommit>, String>
```

Uses `git2::Revwalk` with topological + time sorting. Returns all commits by default (no `max_count`), or a capped number if specified. Each commit includes its parent hashes for DAG reconstruction.

### Layout Algorithm

Pure TypeScript module at `apps/desktop/src/utils/commitGraph.ts`. Zero dependencies, testable in isolation.

**Input:** Array of `GraphCommit` (hash, parents, timestamp, message, author).

**Output:** Array of positioned nodes with `x` (column), `y` (row), `color`, plus arrays of branch path segments and curve definitions.

**Algorithm** (ported from DoltHub's `computePosition.ts`, Apache-2.0):

1. **Build children map** — iterate all commits, for each parent hash record the child. This inverts the parent→child relationship.

2. **Topological sort** — DFS traversal ensuring children appear before parents in the output array. Within the DFS, commits are initially sorted by timestamp (newest first) to produce a natural ordering.

3. **Column assignment** — process commits in topological order. Maintain a `columns` array tracking active branch segments per column. Classify each commit by its children:
   - **No children** (branch tip): allocate a new column, start a new branch segment.
   - **Has branch children** (child whose `parents[0]` is this commit): place at the leftmost branch child's column. End other branch-child segments (they forked from here).
   - **Only merge children** (appears as `parents[1+]` only): find an available column starting right of the max child column. A column is "available" if its last segment ended at or before the nearest child's row.

4. **Color assignment** — each new branch segment gets a `branchOrder` (global counter). Colors cycle through the palette via `branchOrder % palette.length`. Commit dots inherit the color of the branch segment they sit on.

**Key types:**

```ts
interface PositionedCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
  x: number;       // column (lane)
  y: number;       // row
  color: string;
}

interface BranchSegment {
  column: number;
  startRow: number;
  endRow: number;
  color: string;
}

interface CurveDef {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
}
```

### SVG Rendering

Vue component `CommitGraphView.vue` renders the positioned data as inline SVG:

- **Branch paths** — vertical `<line>` elements for each branch segment. Drawn first (behind everything else).
- **Curves** — cubic Bezier `<path>` elements connecting commits across columns (branch-outs and merges). Control points use weighted averages between start/end for smooth S-curves:
  - CP1: X 90% toward end, Y 60% toward start (exits horizontally)
  - CP2: X 97% toward end, Y 40% toward start (arrives vertically)
- **Commit dots** — `<circle>` elements at each commit position.
- **Commit text** — `<text>` or HTML overlay showing abbreviated hash, truncated message, author, relative date. Positioned to the right of the graph lanes.
- **Glow effects** — SVG `<filter>` with `feGaussianBlur` + `feColorMatrix` for colored drop shadows behind dots and lines.

**Grid constants:**

```ts
const COMMIT_SPACING = 32;   // vertical pixels between rows
const BRANCH_SPACING = 16;   // horizontal pixels between columns
const NODE_RADIUS = 4;       // commit dot radius
const TEXT_OFFSET = 20;       // px right of the last column for commit text
```

### Virtual Scrolling

Fixed row height (`COMMIT_SPACING`) enables simple virtual scrolling without a library:

- Container div with `overflow-y: auto`
- Inner spacer div with `height: totalCommits * COMMIT_SPACING`
- Compute visible row range from `scrollTop` / `COMMIT_SPACING` with a buffer of ~20 rows above/below
- Render only visible SVG elements + text, absolutely positioned
- `onscroll` handler updates visible range (debounced or via `requestAnimationFrame`)

### Color Palette

8-10 colors optimized for dark backgrounds with subtle neon quality:

```ts
const BRANCH_COLORS = [
  '#58a6ff',  // blue
  '#3fb950',  // green
  '#d2a8ff',  // purple
  '#f78166',  // orange
  '#ff7b72',  // red
  '#79c0ff',  // light blue
  '#7ee787',  // light green
  '#ffa657',  // amber
  '#d29922',  // gold
  '#f0883e',  // burnt orange
];
```

### Modal Integration

**New file:** `apps/desktop/src/components/CommitGraphModal.vue`

Follows the established modal pattern:
- Fixed overlay (`inset: 0`, `background: rgba(0,0,0,0.6)`, `z-index: 1000`)
- Inner content panel (`background: #1a1a1a`, `border: 1px solid #444`, `border-radius: 8px`)
- Nearly full-screen (90vw x 90vh) to give the graph room
- Close on Escape or overlay click

**Keyboard shortcuts:**
- Open: registered in `useKeyboardShortcuts` (exact binding TBD based on available combos — likely `⇧⌘G`)
- Scroll: vim-style via `useLessScroll` (`j/k/f/b/d/u/g/G`)
- Close: `Escape` or `q`

**State in App.vue:**
- New `showCommitGraphModal` ref
- Conditional render: `v-if="showCommitGraphModal && store.selectedRepo?.path"`
- Passes `repoPath` and optional `worktreePath` as props

### File Inventory

| File | Action | Purpose |
|---|---|---|
| `apps/desktop/src-tauri/src/commands/git.rs` | Modify | Add `git_graph` command |
| `apps/desktop/src/utils/commitGraph.ts` | Create | Layout algorithm (topo sort, column assignment, color) |
| `apps/desktop/src/components/CommitGraphView.vue` | Create | SVG renderer with virtual scroll |
| `apps/desktop/src/components/CommitGraphModal.vue` | Create | Modal wrapper |
| `apps/desktop/src/App.vue` | Modify | Add modal state + conditional render |
| `apps/desktop/src/composables/useKeyboardShortcuts.ts` | Modify | Add open shortcut |
| `apps/desktop/src/invoke.ts` | No change | Already generic |
| `packages/core/src/` | No change | Not needed |

### Non-Goals

- Click/hover interactions on commits
- Auto-refresh when commits change
- Branch filtering or search
- Commit details panel
- Integration with DiffView
