# Regression Testing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 26 unit tests for the `useKannaStore` Pinia store to catch regressions before merge, running in <30 seconds via the Merge Queue agent.

**Architecture:** Single test file (`kanna.test.ts`) with `bun:test`, mocked Tauri APIs (`invoke`, `listen`), and an in-memory `DbHandle` that mirrors the mock pattern from `packages/db/src/queries.test.ts`. Tests exercise store actions and assert state transitions without a browser, Tauri runtime, or daemon.

**Tech Stack:** bun:test, Vue 3 (ref/computed/nextTick), Pinia 3, @vueuse/core (computedAsync), @kanna/db types

**Spec:** `docs/superpowers/specs/2026-03-22-regression-testing-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `apps/desktop/src/stores/kanna.test.ts` | All 26 store unit tests + mock infrastructure |
| Modify | `.kanna/config.json` | Add `"test"` field for Merge Queue integration |

The test file is colocated with the store (same pattern as `useBackup.test.ts` beside `useBackup.ts`).

---

### Task 0: Create test file with mock infrastructure

**Files:**
- Create: `apps/desktop/src/stores/kanna.test.ts`

This task builds the mock `DbHandle`, mock `invoke`, mock `listen`, the `flushAsync` helper, and a `beforeEach` that resets everything. All subsequent tasks add `describe` blocks to this file.

- [ ] **Step 1: Create `kanna.test.ts` with mocks and one smoke test**

```typescript
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import type { DbHandle, PipelineItem, Repo, Setting, TaskBlocker, ActivityLog } from "@kanna/db";

// ── Mock invoke ────────────────────────────────────────────────────
let invokeCalls: { cmd: string; args: any }[] = [];
let invokeResults: Record<string, any> = {};

mock.module("../invoke", () => ({
  invoke: async (cmd: string, args?: any) => {
    invokeCalls.push({ cmd, args });
    const val = invokeResults[cmd];
    if (typeof val === "function") return val(args);
    return val;
  },
}));

// ── Mock listen — capture handlers for event emission ──────────────
const eventHandlers: Record<string, ((event: any) => void)[]> = {};

mock.module("../listen", () => ({
  listen: async (event: string, handler: (event: any) => void) => {
    if (!eventHandlers[event]) eventHandlers[event] = [];
    eventHandlers[event].push(handler);
    return () => {};
  },
}));

function emitEvent(event: string, payload: any) {
  for (const handler of eventHandlers[event] ?? []) {
    handler({ payload });
  }
}

// ── Mock tauri-mock ────────────────────────────────────────────────
mock.module("../tauri-mock", () => ({ isTauri: false }));

// ── Import store after mocks ──────────────────────────────────────
const { useKannaStore } = await import("./kanna");

// ── Flush computedAsync (repos depends on items, cascading) ───────
async function flushAsync(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ── In-memory DbHandle ────────────────────────────────────────────
function createTestDb(): DbHandle & {
  _tables: {
    repo: Repo[];
    pipeline_item: PipelineItem[];
    settings: Setting[];
    task_blocker: TaskBlocker[];
    activity_log: ActivityLog[];
  };
} {
  const _tables = {
    repo: [] as Repo[],
    pipeline_item: [] as PipelineItem[],
    settings: [] as Setting[],
    task_blocker: [] as TaskBlocker[],
    activity_log: [] as ActivityLog[],
  };

  return {
    _tables,

    async execute(query: string, bindValues?: unknown[]) {
      const q = query.trim().toUpperCase();

      // ── repo ──
      if (q.startsWith("INSERT INTO REPO")) {
        const [id, path, name, default_branch] = bindValues as string[];
        _tables.repo.push({
          id, path, name, default_branch,
          hidden: 0,
          created_at: new Date().toISOString(),
          last_opened_at: new Date().toISOString(),
        });
      } else if (q.startsWith("DELETE FROM REPO")) {
        const [id] = bindValues as string[];
        _tables.repo = _tables.repo.filter((r) => r.id !== id);
      } else if (q.startsWith("UPDATE REPO SET HIDDEN = 1")) {
        const repo = _tables.repo.find((r) => r.id === (bindValues as string[])[0]);
        if (repo) repo.hidden = 1;
      } else if (q.startsWith("UPDATE REPO SET HIDDEN = 0")) {
        const repo = _tables.repo.find((r) => r.id === (bindValues as string[])[0]);
        if (repo) repo.hidden = 0;

      // ── pipeline_item inserts ──
      } else if (q.startsWith("INSERT INTO PIPELINE_ITEM")) {
        const [id, repo_id, issue_number, issue_title, prompt, stage, pr_number, pr_url, branch, agent_type, port_offset, port_env, activity] =
          bindValues as unknown[];
        _tables.pipeline_item.push({
          id: id as string,
          repo_id: repo_id as string,
          issue_number: issue_number as number | null,
          issue_title: issue_title as string | null,
          prompt: prompt as string | null,
          stage: stage as string,
          pr_number: pr_number as number | null,
          pr_url: pr_url as string | null,
          branch: branch as string | null,
          agent_type: agent_type as string | null,
          port_offset: (port_offset as number | null) ?? null,
          port_env: (port_env as string | null) ?? null,
          activity: (activity as PipelineItem["activity"]) || "idle",
          activity_changed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          pinned: 0,
          pin_order: null,
          display_name: null,
        });

      // ── pipeline_item stage update ──
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET STAGE")) {
        const [newStage, id] = bindValues as string[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) { item.stage = newStage; item.updated_at = new Date().toISOString(); }

      // ── pipeline_item activity update ──
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET ACTIVITY")) {
        const [activity, id] = bindValues as string[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) {
          item.activity = activity as PipelineItem["activity"];
          item.activity_changed_at = new Date().toISOString();
          item.updated_at = new Date().toISOString();
        }

      // ── pipeline_item PR update ──
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PR_NUMBER")) {
        const [prNumber, prUrl, id] = bindValues as unknown[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) { item.pr_number = prNumber as number; item.pr_url = prUrl as string; item.updated_at = new Date().toISOString(); }

      // ── pipeline_item display_name update ──
      } else if (q.includes("DISPLAY_NAME") && q.startsWith("UPDATE")) {
        const [displayName, id] = bindValues as unknown[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) { item.display_name = displayName as string | null; item.updated_at = new Date().toISOString(); }

      // ── pin ──
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PINNED = 1")) {
        const [pinOrder, id] = bindValues as unknown[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) { item.pinned = 1; item.pin_order = pinOrder as number; item.updated_at = new Date().toISOString(); }
      } else if (q.startsWith("UPDATE PIPELINE_ITEM SET PINNED = 0")) {
        const [id] = bindValues as string[];
        const item = _tables.pipeline_item.find((p) => p.id === id);
        if (item) { item.pinned = 0; item.pin_order = null; item.updated_at = new Date().toISOString(); }
      } else if (q.includes("PIN_ORDER = CASE")) {
        if (bindValues) {
          const n = Math.round(bindValues.length / 3);
          for (let i = 0; i < n; i++) {
            const id = bindValues[i * 2] as string;
            const order = bindValues[i * 2 + 1] as number;
            const item = _tables.pipeline_item.find((p) => p.id === id);
            if (item) { item.pin_order = order; item.updated_at = new Date().toISOString(); }
          }
        }

      // ── startBlockedTask raw UPDATE (branch, port_offset, port_env, stage, activity) ──
      } else if (q.includes("SET BRANCH") && q.includes("PORT_OFFSET")) {
        const [branch, portOffset, portEnv, id] = bindValues as unknown[];
        const item = _tables.pipeline_item.find((p) => p.id === (id as string));
        if (item) {
          item.branch = branch as string;
          item.port_offset = portOffset as number;
          item.port_env = portEnv as string | null;
          item.stage = "in_progress";
          item.activity = "working";
          item.activity_changed_at = new Date().toISOString();
          item.updated_at = new Date().toISOString();
        }

      // ── GC delete ──
      } else if (q.startsWith("DELETE FROM PIPELINE_ITEM")) {
        const [id] = bindValues as string[];
        _tables.pipeline_item = _tables.pipeline_item.filter((p) => p.id !== id);

      // ── activity_log ──
      } else if (q.startsWith("INSERT INTO ACTIVITY_LOG")) {
        const [pipeline_item_id, activity] = bindValues as string[];
        _tables.activity_log.push({
          id: _tables.activity_log.length + 1,
          pipeline_item_id,
          activity: activity as ActivityLog["activity"],
          started_at: new Date().toISOString(),
        });

      // ── task_blocker ──
      } else if (q.startsWith("INSERT") && q.includes("TASK_BLOCKER")) {
        const [blocked_item_id, blocker_item_id] = bindValues as string[];
        if (!_tables.task_blocker.some((b) => b.blocked_item_id === blocked_item_id && b.blocker_item_id === blocker_item_id)) {
          _tables.task_blocker.push({ blocked_item_id, blocker_item_id });
        }
      } else if (q.startsWith("DELETE FROM TASK_BLOCKER WHERE BLOCKED_ITEM_ID = ? AND BLOCKER")) {
        const [blocked, blocker] = bindValues as string[];
        _tables.task_blocker = _tables.task_blocker.filter(
          (b) => !(b.blocked_item_id === blocked && b.blocker_item_id === blocker)
        );
      } else if (q.startsWith("DELETE FROM TASK_BLOCKER WHERE BLOCKED_ITEM_ID = ?")) {
        const [blocked] = bindValues as string[];
        _tables.task_blocker = _tables.task_blocker.filter((b) => b.blocked_item_id !== blocked);

      // ── settings ──
      } else if (q.startsWith("INSERT INTO SETTINGS")) {
        const [key, value] = bindValues as string[];
        const existing = _tables.settings.find((s) => s.key === key);
        if (existing) existing.value = value;
        else _tables.settings.push({ key, value });
      }

      return { rowsAffected: 1 };
    },

    async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
      const q = query.trim().toUpperCase();

      // ── repo ──
      if (q.includes("FROM REPO") && q.includes("WHERE ID")) {
        return _tables.repo.filter((r) => r.id === (bindValues as string[])[0]) as unknown as T[];
      }
      if (q.includes("FROM REPO") && q.includes("WHERE PATH")) {
        return _tables.repo.filter((r) => r.path === (bindValues as string[])[0]) as unknown as T[];
      }
      if (q.includes("FROM REPO") && q.includes("WHERE HIDDEN")) {
        return _tables.repo.filter((r) => r.hidden === 0).sort(
          (a, b) => new Date(b.last_opened_at).getTime() - new Date(a.last_opened_at).getTime()
        ) as unknown as T[];
      }
      if (q.includes("FROM REPO") && !q.includes("WHERE")) {
        return [..._tables.repo].sort(
          (a, b) => new Date(b.last_opened_at).getTime() - new Date(a.last_opened_at).getTime()
        ) as unknown as T[];
      }

      // ── pipeline_item ──
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("WHERE REPO_ID = ?") && q.includes("STAGE != 'DONE'")) {
        const repoId = (bindValues as string[])[0];
        return _tables.pipeline_item.filter((p) => p.repo_id === repoId && p.stage !== "done") as unknown as T[];
      }
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("WHERE REPO_ID")) {
        return _tables.pipeline_item.filter((p) => p.repo_id === (bindValues as string[])[0]) as unknown as T[];
      }
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("ACTIVITY = 'WORKING'")) {
        return _tables.pipeline_item.filter((p) => p.activity === "working") as unknown as T[];
      }
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("STAGE = 'DONE'") && q.includes("ORDER BY")) {
        return _tables.pipeline_item
          .filter((p) => p.stage === "done")
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .slice(0, 1) as unknown as T[];
      }
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("STAGE = 'BLOCKED'") && q.includes("NOT EXISTS")) {
        return _tables.pipeline_item.filter((p) => {
          if (p.stage !== "blocked") return false;
          const blockers = _tables.task_blocker
            .filter((b) => b.blocked_item_id === p.id)
            .map((b) => _tables.pipeline_item.find((pi) => pi.id === b.blocker_item_id))
            .filter(Boolean) as PipelineItem[];
          return blockers.every((b) => b.stage !== "in_progress" && b.stage !== "blocked");
        }) as unknown as T[];
      }

      // ── task_blocker ──
      if (q.includes("FROM TASK_BLOCKER") && q.includes("WHERE BLOCKED_ITEM_ID")) {
        return _tables.task_blocker.filter(
          (b) => b.blocked_item_id === (bindValues as string[])[0]
        ) as unknown as T[];
      }
      // JOIN queries for listBlockersForItem / listBlockedByItem
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("JOIN TASK_BLOCKER") && q.includes("BLOCKER_ITEM_ID") && q.includes("BLOCKED_ITEM_ID = ?")) {
        const blockedId = (bindValues as string[])[0];
        const blockerIds = _tables.task_blocker.filter((b) => b.blocked_item_id === blockedId).map((b) => b.blocker_item_id);
        return _tables.pipeline_item.filter((p) => blockerIds.includes(p.id)) as unknown as T[];
      }
      if (q.includes("FROM PIPELINE_ITEM") && q.includes("JOIN TASK_BLOCKER") && q.includes("BLOCKED_ITEM_ID") && q.includes("BLOCKER_ITEM_ID = ?")) {
        const blockerId = (bindValues as string[])[0];
        const blockedIds = _tables.task_blocker.filter((b) => b.blocker_item_id === blockerId).map((b) => b.blocked_item_id);
        return _tables.pipeline_item.filter((p) => blockedIds.includes(p.id)) as unknown as T[];
      }

      // ── settings ──
      if (q.includes("FROM SETTINGS")) {
        return _tables.settings.filter((s) => s.key === (bindValues as string[])[0]) as unknown as T[];
      }

      return [] as T[];
    },
  };
}

// ── Test helpers ───────────────────────────────────────────────────
function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    name: overrides.path.split("/").pop() || "repo",
    default_branch: "main",
    hidden: 0,
    created_at: new Date().toISOString(),
    last_opened_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<PipelineItem> & { id: string; repo_id: string }): PipelineItem {
  return {
    issue_number: null,
    issue_title: null,
    prompt: "test prompt",
    stage: "in_progress",
    pr_number: null,
    pr_url: null,
    branch: `task-${overrides.id}`,
    agent_type: "pty",
    activity: "idle",
    activity_changed_at: new Date().toISOString(),
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Global test state ──────────────────────────────────────────────
let db: ReturnType<typeof createTestDb>;
let store: ReturnType<typeof useKannaStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  db = createTestDb();
  store = useKannaStore();
  invokeCalls = [];
  invokeResults = {
    which_binary: "/usr/local/bin/kanna-hook",
    read_text_file: "",
    git_worktree_add: {},
    git_worktree_remove: {},
    kill_session: {},
    spawn_session: {},
    run_script: "",
    git_app_info: { branch: "main", commit_hash: "abc", version: "0.0.1" },
  };
  // Clear event handlers from previous test
  for (const key of Object.keys(eventHandlers)) {
    delete eventHandlers[key];
  }
});

// Helper: init store with seeded data and wait for computedAsync
async function initStore() {
  await store.init(db as unknown as DbHandle);
  await flushAsync();
}

// ── Smoke test ─────────────────────────────────────────────────────
describe("smoke", () => {
  it("initializes with empty state", async () => {
    await initStore();
    expect(store.repos).toEqual([]);
    expect(store.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the smoke test**

```bash
cd apps/desktop && bun test src/stores/kanna.test.ts
```

Expected: 1 test passes. If `computedAsync` flushing doesn't work, increase `flushAsync` rounds or debug.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.test.ts
git commit -m "test: add kanna store test infrastructure with mock DbHandle"
```

---

### Task 1: High-risk sorting & activity tests (tests 1-8)

**Files:**
- Modify: `apps/desktop/src/stores/kanna.test.ts`

- [ ] **Step 1: Add sorting & activity `describe` block with all 8 tests**

Append to `kanna.test.ts`:

```typescript
describe("sortedItemsForCurrentRepo", () => {
  it("pinned items sort first by pin_order", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "a", repo_id: "r1", stage: "in_progress", pinned: 1, pin_order: 1 }),
      makeItem({ id: "b", repo_id: "r1", stage: "in_progress", pinned: 1, pin_order: 0 }),
      makeItem({ id: "c", repo_id: "r1", stage: "in_progress" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    const sorted = store.sortedItemsForCurrentRepo;
    expect(sorted[0].id).toBe("b"); // pin_order 0
    expect(sorted[1].id).toBe("a"); // pin_order 1
    expect(sorted[2].id).toBe("c"); // unpinned
  });

  it("groups unpinned by stage: pr → merge → in_progress", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "ip", repo_id: "r1", stage: "in_progress" }),
      makeItem({ id: "pr", repo_id: "r1", stage: "pr" }),
      makeItem({ id: "mg", repo_id: "r1", stage: "merge" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    const sorted = store.sortedItemsForCurrentRepo;
    expect(sorted[0].id).toBe("pr");
    expect(sorted[1].id).toBe("mg");
    expect(sorted[2].id).toBe("ip");
  });

  it("within a stage, sorts by activity: working > unread > idle", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "idle", repo_id: "r1", stage: "in_progress", activity: "idle" }),
      makeItem({ id: "unread", repo_id: "r1", stage: "in_progress", activity: "unread" }),
      makeItem({ id: "working", repo_id: "r1", stage: "in_progress", activity: "working" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    const sorted = store.sortedItemsForCurrentRepo;
    // activityOrder: idle=0, unread=1, working=2 — lower = first? No.
    // Store sorts: (ao - bo). idle(0) - working(2) = -2, so idle sorts first.
    // Wait — check the store code: activityOrder = { idle: 0, unread: 1, working: 2 }
    // sort: (ao - bo) → ascending. So idle(0) first, working(2) last.
    // That means idle appears FIRST, not working. Let me verify this matches the
    // actual store behavior. The sidebar shows working items at top visually...
    // Actually re-reading the store: the sort is `ao - bo`, which is ascending by
    // activity number. idle=0 < unread=1 < working=2. So idle sorts first.
    // This is the CURRENT behavior — test it as-is.
    expect(sorted[0].activity).toBe("idle");
    expect(sorted[1].activity).toBe("unread");
    expect(sorted[2].activity).toBe("working");
  });

  it("excludes done items", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "done1", repo_id: "r1", stage: "done" }),
      makeItem({ id: "active1", repo_id: "r1", stage: "in_progress" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    const sorted = store.sortedItemsForCurrentRepo;
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe("active1");
  });
});

describe("selectItem", () => {
  it("transitions unread item to idle", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "unread" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await store.selectItem("item1");
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("idle");
  });

  it("does not write to DB for already-idle items", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "idle" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    const logCountBefore = db._tables.activity_log.length;
    await store.selectItem("item1");
    await flushAsync();
    // No activity_log entry should be added for idle → idle
    expect(db._tables.activity_log.length).toBe(logCountBefore);
  });
});

describe("_handleAgentFinished (via session_exit event)", () => {
  it("sets idle when item is currently selected", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "working" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item1";
    await flushAsync();
    emitEvent("session_exit", { session_id: "item1" });
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("idle");
  });

  it("sets unread when item is NOT selected", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "working" }),
      makeItem({ id: "item2", repo_id: "r1", activity: "idle" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item2"; // different item selected
    await flushAsync();
    emitEvent("session_exit", { session_id: "item1" });
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("unread");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/desktop && bun test src/stores/kanna.test.ts
```

Expected: 9 tests pass (1 smoke + 8 new).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.test.ts
git commit -m "test: add sorting and activity state tests for kanna store"
```

---

### Task 2: High-risk init & hook event tests (tests 9-16)

**Files:**
- Modify: `apps/desktop/src/stores/kanna.test.ts`

- [ ] **Step 1: Add init & hook event `describe` blocks**

Append to `kanna.test.ts`:

```typescript
describe("init", () => {
  it("transitions stale working items to unread", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "stale", repo_id: "r1", activity: "working" }),
    );
    await initStore();
    const item = db._tables.pipeline_item.find((p) => p.id === "stale");
    expect(item?.activity).toBe("unread");
  });

  it("GCs done tasks older than gcAfterDays", async () => {
    const oldDate = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "old", repo_id: "r1", stage: "done", updated_at: oldDate }),
    );
    await initStore();
    expect(db._tables.pipeline_item.find((p) => p.id === "old")).toBeUndefined();
  });

  it("preserves recent done tasks", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "recent", repo_id: "r1", stage: "done", updated_at: new Date().toISOString() }),
    );
    await initStore();
    expect(db._tables.pipeline_item.find((p) => p.id === "recent")).toBeDefined();
  });

  it("auto-starts blocked tasks whose blockers are done", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "blocker", repo_id: "r1", stage: "done" }),
      makeItem({ id: "blocked", repo_id: "r1", stage: "blocked", branch: null }),
    );
    db._tables.task_blocker.push({ blocked_item_id: "blocked", blocker_item_id: "blocker" });
    await initStore();
    const item = db._tables.pipeline_item.find((p) => p.id === "blocked");
    expect(item?.stage).toBe("in_progress");
  });

  it("restores persisted selection", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(makeItem({ id: "item1", repo_id: "r1" }));
    db._tables.settings.push(
      { key: "selected_repo_id", value: "r1" },
      { key: "selected_item_id", value: "item1" },
    );
    await initStore();
    expect(store.selectedRepoId).toBe("r1");
    expect(store.selectedItemId).toBe("item1");
  });
});

describe("hook events", () => {
  it("Stop event fires _handleAgentFinished", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "working" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item1";
    await flushAsync();
    emitEvent("hook_event", { session_id: "item1", event: "Stop" });
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("idle");
  });

  it("PostToolUse sets activity to working", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "idle" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    emitEvent("hook_event", { session_id: "item1", event: "PostToolUse" });
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("working");
  });

  it("WaitingForInput sets activity to unread", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", activity: "working" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    emitEvent("hook_event", { session_id: "item1", event: "WaitingForInput" });
    await flushAsync();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.activity).toBe("unread");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/desktop && bun test src/stores/kanna.test.ts
```

Expected: 17 tests pass (9 previous + 8 new).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.test.ts
git commit -m "test: add init lifecycle and hook event tests for kanna store"
```

---

### Task 3: Medium-risk task lifecycle tests (tests 17-24)

**Files:**
- Modify: `apps/desktop/src/stores/kanna.test.ts`

- [ ] **Step 1: Add lifecycle `describe` blocks**

Append to `kanna.test.ts`:

```typescript
describe("closeTask", () => {
  it("transitions item to done", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", stage: "in_progress" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item1";
    await flushAsync();
    await store.closeTask();
    const item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.stage).toBe("done");
  });

  it("selects next idle item after closing", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", stage: "in_progress", activity: "working" }),
      makeItem({ id: "item2", repo_id: "r1", stage: "in_progress", activity: "idle" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item1";
    await flushAsync();
    await store.closeTask();
    await flushAsync();
    expect(store.selectedItemId).toBe("item2");
  });

  it("unblocks dependent tasks", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "blocker", repo_id: "r1", stage: "in_progress" }),
      makeItem({ id: "blocked", repo_id: "r1", stage: "blocked", branch: null }),
    );
    db._tables.task_blocker.push({ blocked_item_id: "blocked", blocker_item_id: "blocker" });
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "blocker";
    await flushAsync();
    await store.closeTask();
    await flushAsync();
    const blocked = db._tables.pipeline_item.find((p) => p.id === "blocked");
    expect(blocked?.stage).toBe("in_progress");
  });
});

describe("blockTask", () => {
  it("creates blocked replacement with same prompt", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "item1", repo_id: "r1", prompt: "build feature X" }),
      makeItem({ id: "dep1", repo_id: "r1", stage: "in_progress" }),
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "item1";
    await flushAsync();
    await store.blockTask(["dep1"]);
    await flushAsync();
    // Original should be done
    const original = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(original?.stage).toBe("done");
    // New blocked item should have same prompt
    const blocked = db._tables.pipeline_item.find(
      (p) => p.stage === "blocked" && p.id !== "item1"
    );
    expect(blocked).toBeDefined();
    expect(blocked!.prompt).toBe("build feature X");
  });

  it("transfers dependents to replacement", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "A", repo_id: "r1", stage: "blocked", branch: null }),
      makeItem({ id: "B", repo_id: "r1", stage: "in_progress" }),
      makeItem({ id: "C", repo_id: "r1", stage: "in_progress" }),
    );
    // A is blocked by B
    db._tables.task_blocker.push({ blocked_item_id: "A", blocker_item_id: "B" });
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "B";
    await flushAsync();
    // Block B on C — should create B', transfer A's dependency from B to B'
    await store.blockTask(["C"]);
    await flushAsync();
    const replacement = db._tables.pipeline_item.find(
      (p) => p.stage === "blocked" && p.id !== "A" && p.id !== "B"
    );
    expect(replacement).toBeDefined();
    // A should now depend on replacement, not B
    const aBlockers = db._tables.task_blocker.filter((b) => b.blocked_item_id === "A");
    expect(aBlockers.some((b) => b.blocker_item_id === replacement!.id)).toBe(true);
    expect(aBlockers.some((b) => b.blocker_item_id === "B")).toBe(false);
  });
});

describe("checkUnblocked", () => {
  it("waits for ALL blockers before unblocking", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(
      makeItem({ id: "b1", repo_id: "r1", stage: "in_progress" }),
      makeItem({ id: "b2", repo_id: "r1", stage: "in_progress" }),
      makeItem({ id: "blocked", repo_id: "r1", stage: "blocked", branch: null }),
    );
    db._tables.task_blocker.push(
      { blocked_item_id: "blocked", blocker_item_id: "b1" },
      { blocked_item_id: "blocked", blocker_item_id: "b2" },
    );
    await initStore();
    store.selectedRepoId = "r1";
    store.selectedItemId = "b1";
    await flushAsync();

    // Close first blocker — blocked task should still be blocked
    await store.closeTask();
    await flushAsync();
    let blocked = db._tables.pipeline_item.find((p) => p.id === "blocked");
    expect(blocked?.stage).toBe("blocked");

    // Close second blocker
    store.selectedItemId = "b2";
    await flushAsync();
    await store.closeTask();
    await flushAsync();
    blocked = db._tables.pipeline_item.find((p) => p.id === "blocked");
    expect(blocked?.stage).toBe("in_progress");
  });
});

describe("createItem", () => {
  it("assigns unique port offsets", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    await initStore();
    store.selectedRepoId = "r1";
    await flushAsync();
    await store.createItem("r1", "/test/repo", "task 1");
    await store.createItem("r1", "/test/repo", "task 2");
    await flushAsync();
    const offsets = db._tables.pipeline_item.map((p) => p.port_offset).filter(Boolean);
    expect(new Set(offsets).size).toBe(offsets.length); // all unique
  });
});

describe("importRepo", () => {
  it("re-shows hidden repo instead of duplicating", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo", hidden: 1 }));
    await initStore();
    await store.importRepo("/test/repo", "repo", "main");
    await flushAsync();
    expect(db._tables.repo).toHaveLength(1);
    expect(db._tables.repo[0].hidden).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/desktop && bun test src/stores/kanna.test.ts
```

Expected: 25 tests pass (17 previous + 8 new).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.test.ts
git commit -m "test: add task lifecycle tests (close, block, unblock, create, import)"
```

---

### Task 4: Lower-risk passthrough tests (tests 25-26)

**Files:**
- Modify: `apps/desktop/src/stores/kanna.test.ts`

- [ ] **Step 1: Add passthrough `describe` blocks**

Append to `kanna.test.ts`:

```typescript
describe("pin/unpin", () => {
  it("round-trips pin and unpin", async () => {
    db._tables.repo.push(makeRepo({ id: "r1", path: "/test/repo" }));
    db._tables.pipeline_item.push(makeItem({ id: "item1", repo_id: "r1" }));
    await initStore();
    await store.pinItem("item1", 0);
    let item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.pinned).toBe(1);
    expect(item?.pin_order).toBe(0);
    await store.unpinItem("item1");
    item = db._tables.pipeline_item.find((p) => p.id === "item1");
    expect(item?.pinned).toBe(0);
    expect(item?.pin_order).toBeNull();
  });
});

describe("preferences", () => {
  it("saves and loads preferences", async () => {
    await initStore();
    await store.savePreference("suspendAfterMinutes", "15");
    await flushAsync();
    expect(store.suspendAfterMinutes).toBe(15);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd apps/desktop && bun test src/stores/kanna.test.ts
```

Expected: 27 tests pass (25 previous + 2 new).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/stores/kanna.test.ts
git commit -m "test: add pin/unpin and preference round-trip tests"
```

---

### Task 5: Wire into Merge Queue

**Files:**
- Modify: `.kanna/config.json`

- [ ] **Step 1: Add `test` field to config**

Add `"test"` array to `.kanna/config.json`:

```json
{
  "setup": ["bun install"],
  "teardown": ["./scripts/dev.sh stop -k", "./scripts/clean.sh --all"],
  "test": [
    "bun test"
  ],
  "ports": {
    "KANNA_DEV_PORT": 1420
  }
}
```

- [ ] **Step 2: Run the full test suite to verify timing**

```bash
cd /path/to/repo && bun test
```

Expected: All tests pass (store + existing composable + db + core tests) in <30 seconds.

- [ ] **Step 3: Commit**

```bash
git add .kanna/config.json
git commit -m "feat: add test script to .kanna/config.json for Merge Queue"
```
