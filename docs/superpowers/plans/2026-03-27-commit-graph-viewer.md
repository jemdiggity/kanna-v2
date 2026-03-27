# Commit Graph Viewer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, visually polished git commit graph modal that renders the full repository DAG as SVG with virtual scrolling.

**Architecture:** New Tauri command `git_graph` returns commits with parent hashes. A pure TypeScript layout algorithm (ported from DoltHub's Apache-2.0 `computePosition.ts`) assigns columns and colors. A Vue component renders SVG circles, lines, and Bezier curves in a virtual-scrolled modal.

**Tech Stack:** Rust/git2 (backend), TypeScript (layout), Vue 3 + inline SVG (rendering), existing modal/shortcut patterns.

---

### Task 1: Backend — `git_graph` Tauri Command

**Goal:** Add a `git_graph` command that returns commits with parent hashes, short hashes, and timestamps.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/git.rs`

**Acceptance Criteria:**
- [ ] `git_graph` returns `Vec<GraphCommit>` with hash, short_hash, parents, message, author, timestamp
- [ ] Uses topological + time sorting via `git2::Revwalk`
- [ ] Returns all commits by default, respects optional `max_count`
- [ ] Properly handles repos with no commits (returns empty vec)

**Verify:** `cd apps/desktop && bun tauri dev` → invoke `git_graph` from browser console via `__TAURI__.core.invoke("git_graph", { repoPath: "/path/to/repo" })`

**Steps:**

- [ ] **Step 1: Add the `GraphCommit` struct and `git_graph` command**

Add after the existing `CommitInfo` struct in `apps/desktop/src-tauri/src/commands/git.rs`:

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
pub fn git_graph(repo_path: String, max_count: Option<usize>) -> Result<Vec<GraphCommit>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;

    // Push all references so we get the full DAG
    revwalk.push_glob("refs/heads/*").map_err(|e| e.to_string())?;
    // Also include remote-tracking branches for full picture
    let _ = revwalk.push_glob("refs/remotes/*");

    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let limit = max_count.unwrap_or(usize::MAX);
    let mut commits = Vec::new();

    for oid in revwalk {
        if commits.len() >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let message = commit
            .message()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let parents = commit.parent_ids().map(|p| p.to_string()).collect();

        commits.push(GraphCommit {
            hash,
            short_hash,
            message,
            author,
            timestamp,
            parents,
        });
    }

    Ok(commits)
}
```

- [ ] **Step 2: Register the command in the invoke handler**

In `apps/desktop/src-tauri/src/lib.rs`, add `commands::git::git_graph` to the `invoke_handler` macro, after the existing `commands::git::git_log` line:

```rust
commands::git::git_graph,
```

- [ ] **Step 3: Add mock for browser development**

In the `tauri-mock.ts` file, add a mock handler for `git_graph` that returns sample data. Find where `git_log` is mocked and add nearby:

```typescript
case "git_graph":
  return [
    { hash: "abc1234567890", short_hash: "abc1234", message: "feat: add commit graph", author: "Dev", timestamp: Date.now() / 1000, parents: ["def5678901234"] },
    { hash: "def5678901234", short_hash: "def5678", message: "fix: resolve issue", author: "Dev", timestamp: Date.now() / 1000 - 3600, parents: ["ghi9012345678"] },
    { hash: "ghi9012345678", short_hash: "ghi9012", message: "initial commit", author: "Dev", timestamp: Date.now() / 1000 - 7200, parents: [] },
  ];
```

- [ ] **Step 4: Verify and commit**

Run: `cd apps/desktop/src-tauri && cargo clippy -- -D warnings 2>&1 | head -20`
Expected: No warnings

Run: `cd apps/desktop/src-tauri && cargo fmt --check`
Expected: No formatting issues

```bash
git add apps/desktop/src-tauri/src/commands/git.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/tauri-mock.ts
git commit -m "feat(git): add git_graph command for commit DAG data"
```

---

### Task 2: Layout Algorithm — `commitGraph.ts`

**Goal:** Implement the commit graph layout algorithm that assigns column positions and colors to commits.

**Files:**
- Create: `apps/desktop/src/utils/commitGraph.ts`
- Create: `apps/desktop/src/utils/__tests__/commitGraph.test.ts`

**Acceptance Criteria:**
- [ ] `layoutCommitGraph()` accepts `GraphCommit[]` and returns `{ commits: PositionedCommit[], branches: BranchSegment[], curves: CurveDef[] }`
- [ ] Topological sort places children before parents
- [ ] Column assignment follows DoltHub's three-case algorithm (no children → new column, branch children → leftmost child column, merge-only → find available column)
- [ ] Colors cycle through a 10-color palette
- [ ] Linear history produces a single column
- [ ] Branch + merge produces correct topology
- [ ] Empty input returns empty output

**Verify:** `cd apps/desktop && bun test src/utils/__tests__/commitGraph.test.ts`

**Steps:**

- [ ] **Step 1: Write tests**

Create `apps/desktop/src/utils/__tests__/commitGraph.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { layoutCommitGraph, type GraphCommit } from "../commitGraph";

describe("layoutCommitGraph", () => {
  it("returns empty output for empty input", () => {
    const result = layoutCommitGraph([]);
    expect(result.commits).toEqual([]);
    expect(result.branches).toEqual([]);
    expect(result.curves).toEqual([]);
  });

  it("assigns single column for linear history", () => {
    const commits: GraphCommit[] = [
      { hash: "c", short_hash: "c", message: "third", author: "A", timestamp: 3, parents: ["b"] },
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(3);
    // All in column 0
    expect(result.commits.every((c) => c.x === 0)).toBe(true);
    // Rows are sequential
    expect(result.commits.map((c) => c.y)).toEqual([0, 1, 2]);
    // One branch segment spanning all rows
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].column).toBe(0);
    // No curves in linear history
    expect(result.curves).toEqual([]);
  });

  it("assigns separate columns for branches", () => {
    // main: a <- b <- d (merge)
    // feat:      b <- c (branch)
    const commits: GraphCommit[] = [
      { hash: "d", short_hash: "d", message: "merge", author: "A", timestamp: 4, parents: ["b", "c"] },
      { hash: "c", short_hash: "c", message: "feat work", author: "A", timestamp: 3, parents: ["b"] },
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(4);
    // d and b should be on the same column (main branch)
    const dCommit = result.commits.find((c) => c.hash === "d")!;
    const bCommit = result.commits.find((c) => c.hash === "b")!;
    expect(dCommit.x).toBe(bCommit.x);
    // c should be on a different column (feature branch)
    const cCommit = result.commits.find((c) => c.hash === "c")!;
    expect(cCommit.x).not.toBe(bCommit.x);
    // Should have curves for the merge/branch
    expect(result.curves.length).toBeGreaterThan(0);
  });

  it("assigns colors from the palette", () => {
    const commits: GraphCommit[] = [
      { hash: "b", short_hash: "b", message: "second", author: "A", timestamp: 2, parents: ["a"] },
      { hash: "a", short_hash: "a", message: "first", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    // Every commit has a color string
    expect(result.commits.every((c) => typeof c.color === "string" && c.color.startsWith("#"))).toBe(true);
  });

  it("handles single commit (root with no parents)", () => {
    const commits: GraphCommit[] = [
      { hash: "a", short_hash: "a", message: "init", author: "A", timestamp: 1, parents: [] },
    ];
    const result = layoutCommitGraph(commits);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].x).toBe(0);
    expect(result.commits[0].y).toBe(0);
  });
});
```

- [ ] **Step 2: Implement the layout algorithm**

Create `apps/desktop/src/utils/commitGraph.ts`:

```typescript
// Layout algorithm ported from DoltHub's commit-graph (Apache-2.0)
// https://github.com/dolthub/commit-graph

export interface GraphCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
}

export interface PositionedCommit extends GraphCommit {
  x: number; // column (lane)
  y: number; // row
  color: string;
}

export interface BranchSegment {
  column: number;
  startRow: number;
  endRow: number;
  color: string;
}

export interface CurveDef {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
}

export interface GraphLayout {
  commits: PositionedCommit[];
  branches: BranchSegment[];
  curves: CurveDef[];
  maxColumn: number;
}

const BRANCH_COLORS = [
  "#58a6ff", // blue
  "#3fb950", // green
  "#d2a8ff", // purple
  "#f78166", // orange
  "#ff7b72", // red
  "#79c0ff", // light blue
  "#7ee787", // light green
  "#ffa657", // amber
  "#d29922", // gold
  "#f0883e", // burnt orange
];

interface BranchPath {
  startRow: number;
  endRow: number;
  endCommitHash: string;
  branchOrder: number;
}

export function layoutCommitGraph(rawCommits: GraphCommit[]): GraphLayout {
  if (rawCommits.length === 0) {
    return { commits: [], branches: [], curves: [], maxColumn: 0 };
  }

  // Build children map (parent -> children)
  const childrenMap = new Map<string, string[]>();
  const commitMap = new Map<string, GraphCommit>();
  for (const c of rawCommits) {
    commitMap.set(c.hash, c);
    for (const p of c.parents) {
      const children = childrenMap.get(p);
      if (children) {
        children.push(c.hash);
      } else {
        childrenMap.set(p, [c.hash]);
      }
    }
  }

  // Topological sort — commits are already topo+time sorted from git2,
  // but we need the ordering to be stable for column assignment.
  // Use the input order directly (git2 gives us TOPOLOGICAL | TIME).
  const sorted = rawCommits;

  // Column assignment
  const columns: BranchPath[][] = []; // columns[colIdx] = segments in that column
  let branchOrder = 0;
  const posMap = new Map<string, { x: number; y: number; color: string }>();

  for (let row = 0; row < sorted.length; row++) {
    const commit = sorted[row];
    const children = childrenMap.get(commit.hash) ?? [];

    // Classify children: "branch child" has this commit as parents[0]
    const branchChildXs: number[] = [];
    const mergeChildXs: number[] = [];
    const childYs: number[] = [];

    for (const childHash of children) {
      const childCommit = commitMap.get(childHash);
      const childPos = posMap.get(childHash);
      if (!childCommit || !childPos) continue;
      childYs.push(childPos.y);
      if (childCommit.parents[0] === commit.hash) {
        branchChildXs.push(childPos.x);
      } else {
        mergeChildXs.push(childPos.x);
      }
    }

    let col: number;
    let color: string;

    if (children.length === 0 || (branchChildXs.length === 0 && mergeChildXs.length === 0)) {
      // Case 1: No positioned children — branch tip (or orphan). New column.
      col = columns.length;
      columns.push([]);
      const order = branchOrder++;
      color = BRANCH_COLORS[order % BRANCH_COLORS.length];
      columns[col].push({
        startRow: row,
        endRow: Infinity,
        endCommitHash: commit.hash,
        branchOrder: order,
      });
    } else if (branchChildXs.length > 0) {
      // Case 2: Has branch children. Place at leftmost branch child's column.
      col = Math.min(...branchChildXs);
      // End the branch segment at this row
      const seg = columns[col].at(-1);
      if (seg && seg.endRow === Infinity) {
        seg.endRow = row;
        seg.endCommitHash = commit.hash;
      }
      color = BRANCH_COLORS[(seg?.branchOrder ?? 0) % BRANCH_COLORS.length];

      // Start a new segment continuing downward (for this commit's parents)
      if (commit.parents.length > 0) {
        const order = seg?.branchOrder ?? branchOrder++;
        columns[col].push({
          startRow: row,
          endRow: Infinity,
          endCommitHash: commit.hash,
          branchOrder: order,
        });
      }

      // End other branch-child columns' segments (they forked from here)
      for (const bx of branchChildXs) {
        if (bx !== col) {
          const otherSeg = columns[bx].at(-1);
          if (otherSeg && otherSeg.endRow === Infinity) {
            otherSeg.endRow = row;
            otherSeg.endCommitHash = commit.hash;
          }
        }
      }
    } else {
      // Case 3: Only merge children. Find available column.
      const maxChildX = Math.max(...mergeChildXs);
      const minChildY = Math.min(...childYs);
      col = -1;

      for (let c = maxChildX + 1; c < columns.length; c++) {
        const lastSeg = columns[c].at(-1);
        if (!lastSeg || lastSeg.endRow <= minChildY) {
          col = c;
          break;
        }
      }

      if (col === -1) {
        col = columns.length;
        columns.push([]);
      }

      const order = branchOrder++;
      color = BRANCH_COLORS[order % BRANCH_COLORS.length];
      columns[col].push({
        startRow: row,
        endRow: Infinity,
        endCommitHash: commit.hash,
        branchOrder: order,
      });
    }

    posMap.set(commit.hash, { x: col, y: row, color });
  }

  // End any remaining open segments
  for (const colSegs of columns) {
    const last = colSegs.at(-1);
    if (last && last.endRow === Infinity) {
      // Find the last row that references this column
      last.endRow = sorted.length - 1;
    }
  }

  // Build positioned commits
  const commits: PositionedCommit[] = sorted.map((c) => {
    const pos = posMap.get(c.hash)!;
    return { ...c, x: pos.x, y: pos.y, color: pos.color };
  });

  // Build branch segments for rendering
  const branches: BranchSegment[] = [];
  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    for (const seg of columns[colIdx]) {
      if (seg.startRow < seg.endRow) {
        branches.push({
          column: colIdx,
          startRow: seg.startRow,
          endRow: seg.endRow,
          color: BRANCH_COLORS[seg.branchOrder % BRANCH_COLORS.length],
        });
      }
    }
  }

  // Build curves for cross-column connections
  const curves: CurveDef[] = [];
  for (const commit of commits) {
    // Branch-out curves: children on different columns
    const children = childrenMap.get(commit.hash) ?? [];
    for (const childHash of children) {
      const childPos = posMap.get(childHash);
      if (!childPos) continue;
      const childCommit = commitMap.get(childHash);
      if (!childCommit) continue;
      // Only draw curve if child is on a different column AND this is the first parent (branch-out)
      if (childPos.x !== commit.x && childCommit.parents[0] === commit.hash) {
        curves.push({
          startX: childPos.x,
          startY: childPos.y,
          endX: commit.x,
          endY: commit.y,
          color: posMap.get(childHash)!.color,
        });
      }
    }

    // Merge curves: non-first parents on different columns
    for (let i = 1; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];
      const parentPos = posMap.get(parentHash);
      if (!parentPos) continue;
      if (parentPos.x !== commit.x) {
        curves.push({
          startX: commit.x,
          startY: commit.y,
          endX: parentPos.x,
          endY: parentPos.y,
          color: parentPos.color,
        });
      }
    }
  }

  return {
    commits,
    branches,
    curves,
    maxColumn: columns.length - 1,
  };
}
```

- [ ] **Step 3: Run tests and commit**

Run: `cd apps/desktop && bun test src/utils/__tests__/commitGraph.test.ts`
Expected: All tests PASS

```bash
git add apps/desktop/src/utils/commitGraph.ts apps/desktop/src/utils/__tests__/commitGraph.test.ts
git commit -m "feat: add commit graph layout algorithm"
```

---

### Task 3: SVG Renderer — `CommitGraphView.vue`

**Goal:** Vue component that renders the positioned commit graph as SVG with virtual scrolling.

**Files:**
- Create: `apps/desktop/src/components/CommitGraphView.vue`

**Acceptance Criteria:**
- [ ] Renders commit dots as `<circle>` elements with branch colors
- [ ] Renders branch paths as vertical `<line>` elements
- [ ] Renders cross-column connections as cubic Bezier `<path>` elements
- [ ] Renders commit text (short hash, message, author, relative date) to the right of the graph
- [ ] Virtual scrolling: only renders visible rows (viewport + 20-row buffer)
- [ ] SVG glow filter for visual polish
- [ ] vim-style scroll via `useLessScroll`
- [ ] Emits `close` on `q`

**Verify:** Open the app, trigger the commit graph modal, see the graph rendered with colors and smooth curves.

**Steps:**

- [ ] **Step 1: Create the component**

Create `apps/desktop/src/components/CommitGraphView.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { invoke } from "../invoke";
import { useLessScroll } from "../composables/useLessScroll";
import {
  layoutCommitGraph,
  type GraphCommit,
  type GraphLayout,
  type PositionedCommit,
  type BranchSegment,
  type CurveDef,
} from "../utils/commitGraph";

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const COMMIT_SPACING = 28;
const BRANCH_SPACING = 16;
const NODE_RADIUS = 4;
const GRAPH_PADDING = 12;
const TEXT_GAP = 16;

const scrollRef = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const layout = ref<GraphLayout>({
  commits: [],
  branches: [],
  curves: [],
  maxColumn: 0,
});

// Virtual scroll state
const scrollTop = ref(0);
const viewportHeight = ref(600);

const totalHeight = computed(
  () => layout.value.commits.length * COMMIT_SPACING + GRAPH_PADDING * 2
);

const graphWidth = computed(
  () => (layout.value.maxColumn + 1) * BRANCH_SPACING + GRAPH_PADDING * 2
);

const textStartX = computed(() => graphWidth.value + TEXT_GAP);

// Visible row range with buffer
const visibleRange = computed(() => {
  const first = Math.max(
    0,
    Math.floor((scrollTop.value - GRAPH_PADDING) / COMMIT_SPACING) - 20
  );
  const last = Math.min(
    layout.value.commits.length - 1,
    Math.ceil(
      (scrollTop.value + viewportHeight.value - GRAPH_PADDING) / COMMIT_SPACING
    ) + 20
  );
  return { first, last };
});

// Only render visible commits
const visibleCommits = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.commits.filter((c) => c.y >= first && c.y <= last);
});

// Only render visible branch segments (overlapping with viewport)
const visibleBranches = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.branches.filter(
    (b) => b.endRow >= first && b.startRow <= last
  );
});

// Only render curves where either endpoint is visible
const visibleCurves = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.curves.filter(
    (c) =>
      (c.startY >= first && c.startY <= last) ||
      (c.endY >= first && c.endY <= last)
  );
});

function px(col: number): number {
  return GRAPH_PADDING + col * BRANCH_SPACING;
}

function py(row: number): number {
  return GRAPH_PADDING + row * COMMIT_SPACING;
}

function curvePath(curve: CurveDef): string {
  const x1 = px(curve.startX);
  const y1 = py(curve.startY);
  const x2 = px(curve.endX);
  const y2 = py(curve.endY);
  const cx1 = x1 * 0.1 + x2 * 0.9;
  const cy1 = y1 * 0.6 + y2 * 0.4;
  const cx2 = x1 * 0.03 + x2 * 0.97;
  const cy2 = y1 * 0.4 + y2 * 0.6;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

function relativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function onScroll() {
  if (scrollRef.value) {
    scrollTop.value = scrollRef.value.scrollTop;
    viewportHeight.value = scrollRef.value.clientHeight;
  }
}

useLessScroll(scrollRef, { onClose: () => emit("close") });

async function loadGraph() {
  loading.value = true;
  error.value = null;
  try {
    const path = props.worktreePath || props.repoPath;
    const commits = await invoke<GraphCommit[]>("git_graph", {
      repoPath: path,
    });
    layout.value = layoutCommitGraph(commits);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadGraph();
  if (scrollRef.value) {
    viewportHeight.value = scrollRef.value.clientHeight;
  }
});
</script>

<template>
  <div ref="scrollRef" class="graph-scroll" tabindex="-1" @scroll="onScroll">
    <div v-if="loading" class="graph-status">Loading commit graph\u2026</div>
    <div v-else-if="error" class="graph-status error">{{ error }}</div>
    <template v-else>
      <div class="graph-canvas" :style="{ height: totalHeight + 'px' }">
        <svg
          class="graph-svg"
          :width="graphWidth"
          :height="totalHeight"
          :viewBox="`0 0 ${graphWidth} ${totalHeight}`"
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <!-- Branch path lines -->
          <line
            v-for="(b, i) in visibleBranches"
            :key="'b' + i"
            :x1="px(b.column)"
            :y1="py(b.startRow)"
            :x2="px(b.column)"
            :y2="py(b.endRow)"
            :stroke="b.color"
            stroke-width="2"
            stroke-opacity="0.4"
          />

          <!-- Bezier curves -->
          <path
            v-for="(c, i) in visibleCurves"
            :key="'c' + i"
            :d="curvePath(c)"
            :stroke="c.color"
            stroke-width="2"
            stroke-opacity="0.5"
            fill="none"
          />

          <!-- Commit dots -->
          <circle
            v-for="commit in visibleCommits"
            :key="commit.hash"
            :cx="px(commit.x)"
            :cy="py(commit.y)"
            :r="NODE_RADIUS"
            :fill="commit.color"
            filter="url(#glow)"
          />
        </svg>

        <!-- Commit text overlay (HTML for better text rendering) -->
        <div class="commit-text-layer" :style="{ left: textStartX + 'px' }">
          <div
            v-for="commit in visibleCommits"
            :key="'t' + commit.hash"
            class="commit-row"
            :style="{ top: py(commit.y) - 8 + 'px' }"
          >
            <span class="commit-hash" :style="{ color: commit.color }">{{
              commit.short_hash
            }}</span>
            <span class="commit-message">{{
              truncate(commit.message, 72)
            }}</span>
            <span class="commit-author">{{ commit.author }}</span>
            <span class="commit-time">{{ relativeTime(commit.timestamp) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.graph-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  outline: none;
  position: relative;
}

.graph-status {
  padding: 24px;
  color: #888;
  text-align: center;
}

.graph-status.error {
  color: #ff7b72;
}

.graph-canvas {
  position: relative;
  min-width: max-content;
}

.graph-svg {
  position: absolute;
  top: 0;
  left: 0;
}

.commit-text-layer {
  position: absolute;
  top: 0;
  pointer-events: none;
}

.commit-row {
  position: absolute;
  display: flex;
  gap: 10px;
  align-items: baseline;
  white-space: nowrap;
  height: 16px;
  font-size: 12px;
  line-height: 16px;
}

.commit-hash {
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 11px;
  opacity: 0.9;
}

.commit-message {
  color: #e0e0e0;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-author {
  color: #888;
  font-size: 11px;
}

.commit-time {
  color: #666;
  font-size: 11px;
}
</style>
```

- [ ] **Step 2: Verify rendering and commit**

Run: `cd apps/desktop && bun tsc --noEmit 2>&1 | head -20`
Expected: No type errors

```bash
git add apps/desktop/src/components/CommitGraphView.vue
git commit -m "feat: add commit graph SVG renderer with virtual scroll"
```

---

### Task 4: Modal Integration — Wire Into App

**Goal:** Add `CommitGraphModal.vue`, wire it into `App.vue` with keyboard shortcut `⌘G`.

**Files:**
- Create: `apps/desktop/src/components/CommitGraphModal.vue`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/composables/useKeyboardShortcuts.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

**Acceptance Criteria:**
- [ ] `⌘G` opens the commit graph modal (toggle behavior like `showDiff`)
- [ ] Escape and `q` close it
- [ ] Modal follows established pattern (overlay, dark background, border-radius)
- [ ] 90vw x 90vh size for maximum graph visibility
- [ ] Registered in the `dismiss` chain in `App.vue`
- [ ] Included in `anyModalOpen` for focus restoration
- [ ] i18n labels added for all three locales
- [ ] Action appears in keyboard shortcuts modal

**Verify:** Open the app, press `⌘G`, see the commit graph modal. Press Escape to close.

**Steps:**

- [ ] **Step 1: Create CommitGraphModal.vue**

Create `apps/desktop/src/components/CommitGraphModal.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import CommitGraphView from "./CommitGraphView.vue";
import { useShortcutContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
useShortcutContext("main");
const { zIndex, bringToFront } = useModalZIndex();
defineExpose({ zIndex, bringToFront });

const modalRef = ref<HTMLElement | null>(null);

defineProps<{
  repoPath: string;
  worktreePath?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('close')">
    <div ref="modalRef" class="graph-modal" tabindex="-1">
      <CommitGraphView
        :repo-path="repoPath"
        :worktree-path="worktreePath"
        @close="emit('close')"
      />
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.graph-modal {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  width: 90vw;
  height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}
</style>
```

- [ ] **Step 2: Add `showCommitGraph` action to `useKeyboardShortcuts.ts`**

Add `"showCommitGraph"` to the `ActionName` type union:

```typescript
| "showCommitGraph"
```

Add the shortcut definition in the `shortcuts` array, in the Views group (after the `showDiff` line):

```typescript
{ action: "showCommitGraph", labelKey: "shortcuts.commitGraph", groupKey: "shortcuts.groupViews", key: "g", meta: true, display: "⌘G", context: ["main"] },
```

- [ ] **Step 3: Wire into App.vue**

Add import at top of `<script setup>`:

```typescript
import CommitGraphModal from "./components/CommitGraphModal.vue";
```

Add state ref (near the other modal refs):

```typescript
const showCommitGraphModal = ref(false);
const commitGraphModalRef = ref<InstanceType<typeof CommitGraphModal> | null>(null);
```

Add action in `keyboardActions` (after `showDiff`):

```typescript
showCommitGraph: () => {
  if (!store.selectedRepo) return;
  if (showCommitGraphModal.value) {
    const z = commitGraphModalRef.value?.zIndex ?? 0;
    if (isTopModal(z)) {
      showCommitGraphModal.value = false;
    } else {
      commitGraphModalRef.value?.bringToFront();
    }
  } else {
    showCommitGraphModal.value = true;
  }
},
```

Add to the `dismiss` chain (before the tree explorer check):

```typescript
if (showCommitGraphModal.value) { showCommitGraphModal.value = false; return; }
```

Add `showCommitGraphModal.value` to `anyModalOpen` computed:

```typescript
showNewTaskModal.value || showAddRepoModal.value || showShortcutsModal.value ||
showFilePickerModal.value || showFilePreviewModal.value || showDiffModal.value ||
showTreeExplorer.value || showShellModal.value || showAnalyticsModal.value ||
showBlockerSelect.value || showPreferencesPanel.value || showCommitGraphModal.value
```

Add the template in the `<template>` section (after the DiffModal):

```vue
<CommitGraphModal
  ref="commitGraphModalRef"
  v-if="showCommitGraphModal && store.selectedRepo?.path"
  :repo-path="store.selectedRepo.path"
  :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
  @close="showCommitGraphModal = false"
/>
```

- [ ] **Step 4: Add i18n labels**

In `apps/desktop/src/i18n/locales/en.json`, add in the `shortcuts` section:

```json
"commitGraph": "Commit Graph"
```

In `apps/desktop/src/i18n/locales/ja.json`, add in the `shortcuts` section:

```json
"commitGraph": "\u30b3\u30df\u30c3\u30c8\u30b0\u30e9\u30d5"
```

In `apps/desktop/src/i18n/locales/ko.json`, add in the `shortcuts` section:

```json
"commitGraph": "\ucee4\ubc0b \uadf8\ub798\ud504"
```

- [ ] **Step 5: Verify and commit**

Run: `cd apps/desktop && bun tsc --noEmit 2>&1 | head -20`
Expected: No type errors

```bash
git add apps/desktop/src/components/CommitGraphModal.vue apps/desktop/src/App.vue apps/desktop/src/composables/useKeyboardShortcuts.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/ja.json apps/desktop/src/i18n/locales/ko.json
git commit -m "feat: add commit graph modal with ⌘G shortcut"
```
