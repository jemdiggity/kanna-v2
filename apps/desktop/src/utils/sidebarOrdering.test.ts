import { describe, expect, it } from "vitest";
import type { PipelineItem, TaskBlocker } from "../types/kanna";
import type { SidebarTaskItem } from "../types/taskUi";

import {
  groupedSidebarItemsByStage,
  groupedSidebarTaskItemsByStage,
  replacementSidebarItemAfterRemoval,
  replacementSidebarTaskItemAfterRemoval,
  replacementSidebarTaskItemsAfterRemoval,
  sidebarChildItems,
  sidebarTaskChildItems,
  sidebarSubtreeRows,
  sidebarTaskSubtreeRows,
  sortedSidebarPinnedItems,
  sortSidebarItemsForRepo,
  sortSidebarTaskItemsForRepo,
} from "./sidebarOrdering";
import { DEFAULT_SINGLETON_PIN_ORDER } from "./singletonTask";

const ORDER = ["merge", "pr", "review", "in progress"];
const getStageOrder = () => ORDER;

function item(overrides: Partial<PipelineItem>): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Task",
    workflow: "default",
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-05-31T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    display_name: null,
    base_ref: null,
    agent_session_id: null,
    teardown_started_at: null,
    last_output_preview: null,
    notify_task_id: null,
    notified_at: null,
    pipeline_def: null,
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

function sidebarItem(overrides: Partial<SidebarTaskItem> = {}): SidebarTaskItem {
  const durable = item({ id: "task-1" });
  const { id: taskId, ...presentation } = durable;
  return {
    ...presentation,
    slot_id: "slot-1",
    task_id: taskId,
    state: "ready",
    ...overrides,
  } as SidebarTaskItem;
}

describe("sidebarOrdering", () => {
  it("puts a defaulted singleton pin above the operator's own pins", () => {
    // buildWorkspace gives a directory singleton with no explicit pin the
    // default order; ordering must read that as the top of the pinned group
    // without renumbering the pins the operator placed.
    const singleton = item({
      id: "task-merge",
      singleton_agent: "merge",
      pinned: 1,
      pin_order: DEFAULT_SINGLETON_PIN_ORDER,
    });
    const firstPin = item({ id: "task-a", pinned: 1, pin_order: 0 });
    const secondPin = item({ id: "task-b", pinned: 1, pin_order: 1 });

    expect(
      sortedSidebarPinnedItems({
        repoId: "repo-1",
        items: [firstPin, secondPin, singleton],
        getStageOrder,
      }).map((entry) => entry.id),
    ).toEqual(["task-merge", "task-a", "task-b"]);
  });

  it("leaves an unpinned singleton row in its stage group", () => {
    // The owner's machine stamps the pin once at claim time, so a cleared
    // `pinned` is an explicit unpin — nothing re-derives the default over it.
    const singleton = item({ id: "task-merge", pipeline: "singleton-merge", pinned: 0 });

    expect(
      sortedSidebarPinnedItems({ repoId: "repo-1", items: [singleton], getStageOrder }),
    ).toEqual([]);
    expect(
      groupedSidebarItemsByStage({ repoId: "repo-1", items: [singleton], getStageOrder })
        .flatMap((group) => group.items.map((entry) => entry.id)),
    ).toEqual(["task-merge"]);
  });

  it("uses slot identity for rows and durable identity for blockers and parents", () => {
    const parent = sidebarItem({
      slot_id: "slot-parent",
      task_id: "task-parent",
      stage: "in progress",
    });
    const child = sidebarItem({
      slot_id: "slot-child",
      task_id: "task-child",
      parent_task_id: "task-parent",
      stage: "merge",
    });
    const blocked = sidebarItem({
      slot_id: "slot-blocked",
      task_id: "task-blocked",
      stage: "in progress",
    });
    const blocker = sidebarItem({
      slot_id: "slot-blocker",
      task_id: "task-blocker",
      stage: "review",
    });
    const options = {
      repoId: "repo-1",
      items: [parent, child, blocked, blocker],
      blockers: [{ blocked_item_id: "task-blocked", blocker_item_id: "task-blocker" }],
      getStageOrder,
    };

    expect(sidebarTaskChildItems(options, "task-parent").map((entry) => entry.slot_id)).toEqual([
      "slot-child",
    ]);
    expect(sidebarTaskSubtreeRows(options, parent).map((row) => [row.item.slot_id, row.depth])).toEqual([
      ["slot-parent", 0],
      ["slot-child", 1],
    ]);
    expect(sortSidebarTaskItemsForRepo(options).map((entry) => entry.slot_id)).toEqual([
      "slot-blocker",
      "slot-parent",
      "slot-child",
      "slot-blocked",
    ]);
  });

  it("keeps distinct slots even when duplicate durable task identities reach ordering", () => {
    const items = [
      sidebarItem({
        slot_id: "create:stable",
        task_id: "task-1",
        created_at: "2026-05-31T00:00:02.000Z",
      }),
      sidebarItem({
        slot_id: "task-1",
        task_id: "task-1",
        created_at: "2026-05-31T00:00:01.000Z",
      }),
    ];

    expect(sortSidebarTaskItemsForRepo({
      repoId: "repo-1",
      items,
      getStageOrder,
    }).map((entry) => entry.slot_id)).toEqual(["create:stable", "task-1"]);
  });

  it("does not give creating rows durable blocker or parent identity", () => {
    const parent = sidebarItem({ slot_id: "slot-parent", task_id: "task-parent" });
    const creating = sidebarItem({
      slot_id: "create:new",
      task_id: null,
      state: "creating",
      parent_task_id: "task-parent",
      stage: "merge",
    });
    const options = {
      repoId: "repo-1",
      items: [parent, creating],
      blockers: [{ blocked_item_id: "create:new", blocker_item_id: "task-parent" }],
      getStageOrder,
    };

    expect(sidebarTaskChildItems(options, "task-parent")).toEqual([]);
    expect(groupedSidebarTaskItemsByStage(options)
      .flatMap((group) => group.items)
      .map((entry) => entry.slot_id)).toContain("create:new");
  });

  it("excludes closed rows even when their stage is still active", () => {
    const sorted = sortSidebarItemsForRepo({
      repoId: "repo-1",
      items: [
        item({ id: "closed-pr", stage: "pr", closed_at: "2026-05-31 10:56:44" }),
        item({ id: "open", stage: "in progress", closed_at: null }),
      ],
      getStageOrder: () => ["merge", "pr", "review", "in progress"],
    });

    expect(sorted.map((entry) => entry.id)).toEqual(["open"]);
  });

  it("does not hide an open row solely because its stage is done", () => {
    const sorted = sortSidebarItemsForRepo({
      repoId: "repo-1",
      items: [
        item({ id: "legacy-done", stage: "done", closed_at: null }),
        item({ id: "open", stage: "in progress", closed_at: null }),
      ],
      getStageOrder,
    });

    expect(sorted.map((entry) => entry.id)).toEqual(["open", "legacy-done"]);
  });

  it("derives blocked ordering from task_blocker rows instead of tags", () => {
    const blockers: TaskBlocker[] = [
      { blocked_item_id: "blocked", blocker_item_id: "upstream" },
    ];
    const items = [
      item({ id: "blocked", stage: "in progress", tags: "[]" } as Partial<PipelineItem>),
      item({ id: "tagged-only", stage: "in progress", tags: "[\"blocked\"]" } as Partial<PipelineItem>),
      item({ id: "upstream", stage: "review" }),
    ];

    const groups = groupedSidebarItemsByStage({ repoId: "repo-1", items, blockers, getStageOrder });
    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toEqual([
      "upstream",
      "tagged-only",
    ]);

    const ordered = sortSidebarItemsForRepo({ repoId: "repo-1", items, blockers, getStageOrder });
    expect(ordered.map((entry) => entry.id)).toEqual(["upstream", "tagged-only", "blocked"]);
  });

  it("stops treating a task as blocked once its blocker is parked at pr with a PR", () => {
    const blockers: TaskBlocker[] = [
      { blocked_item_id: "dependent", blocker_item_id: "upstream" },
    ];
    const items = [
      item({ id: "dependent", stage: "in progress", tags: "[]" } as Partial<PipelineItem>),
      item({
        id: "upstream",
        stage: "pr",
        pr_url: "https://github.com/acme/repo/pull/7",
      }),
    ];

    // Optimistic resolution: the dependent leaves the blocked section and
    // appears in its own stage group even though the blocker row persists.
    const groups = groupedSidebarItemsByStage({ repoId: "repo-1", items, blockers, getStageOrder });
    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toContain("dependent");

    // Without a PR the blocker still blocks.
    const unresolvedItems = [
      item({ id: "dependent", stage: "in progress", tags: "[]" } as Partial<PipelineItem>),
      item({ id: "upstream", stage: "pr", pr_url: null }),
    ];
    const unresolvedGroups = groupedSidebarItemsByStage({
      repoId: "repo-1",
      items: unresolvedItems,
      blockers,
      getStageOrder,
    });
    expect(
      unresolvedGroups.flatMap((group) => group.items.map((entry) => entry.id)),
    ).not.toContain("dependent");
  });

  it("uses snapshot state when a closed blocker is absent from visible items", () => {
    const blockers: TaskBlocker[] = [
      { blocked_item_id: "dependent", blocker_item_id: "closed-upstream" },
    ];
    const items = [item({ id: "dependent", stage: "in progress" })];

    const groups = groupedSidebarItemsByStage({
      repoId: "repo-1",
      items,
      blockers,
      blockerTaskStates: {
        "closed-upstream": {
          closed_at: "2026-07-19T22:49:04Z",
          stage: "pr",
          pr_url: null,
        },
      },
      getStageOrder,
    });

    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toContain("dependent");
  });

  it("keeps a task blocked when its blocker state is unavailable", () => {
    const blockers: TaskBlocker[] = [
      { blocked_item_id: "dependent", blocker_item_id: "unknown-upstream" },
    ];
    const items = [item({ id: "dependent", stage: "in progress" })];

    const groups = groupedSidebarItemsByStage({ repoId: "repo-1", items, blockers, getStageOrder });

    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).not.toContain("dependent");
  });

  it("nests a subtask directly beneath its parent and hides it from its own stage group", () => {
    const items = [
      item({ id: "parent", stage: "in progress", created_at: "2026-05-31T00:00:02.000Z" }),
      item({
        id: "child",
        stage: "pr",
        parent_task_id: "parent",
        created_at: "2026-05-31T00:00:03.000Z",
      }),
      item({ id: "other", stage: "in progress", created_at: "2026-05-31T00:00:01.000Z" }),
    ];

    const ordered = sortSidebarItemsForRepo({ repoId: "repo-1", items, getStageOrder });
    expect(ordered.map((entry) => entry.id)).toEqual(["parent", "child", "other"]);

    // The child must not surface in its own "pr" stage section.
    const groups = groupedSidebarItemsByStage({ repoId: "repo-1", items, getStageOrder });
    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).not.toContain("child");
  });

  it("returns depth-annotated subtree rows for nested subtasks", () => {
    const items = [
      item({ id: "parent", created_at: "2026-05-31T00:00:01.000Z" }),
      item({ id: "child-a", parent_task_id: "parent", created_at: "2026-05-31T00:00:02.000Z" }),
      item({ id: "child-b", parent_task_id: "parent", created_at: "2026-05-31T00:00:03.000Z" }),
      item({ id: "grandchild", parent_task_id: "child-a", created_at: "2026-05-31T00:00:04.000Z" }),
    ];
    const options = { repoId: "repo-1", items, getStageOrder };

    expect(sidebarChildItems(options, "parent").map((entry) => entry.id)).toEqual([
      "child-a",
      "child-b",
    ]);

    const rows = sidebarSubtreeRows(options, items[0]);
    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ["parent", 0],
      ["child-a", 1],
      ["grandchild", 2],
      ["child-b", 1],
    ]);
  });

  it("promotes an orphaned subtask to top level when its parent is gone", () => {
    const items = [
      item({ id: "orphan", stage: "in progress", parent_task_id: "missing-parent" }),
    ];
    const ordered = sortSidebarItemsForRepo({ repoId: "repo-1", items, getStageOrder });
    expect(ordered.map((entry) => entry.id)).toEqual(["orphan"]);
  });

  it("selects a child's next sibling and falls back to its parent before unrelated rows", () => {
    const parent = item({
      id: "parent",
      created_at: "2026-05-31T00:00:03.000Z",
    });
    const childA = item({
      id: "child-a",
      parent_task_id: parent.id,
      created_at: "2026-05-31T00:00:04.000Z",
    });
    const childB = item({
      id: "child-b",
      parent_task_id: parent.id,
      created_at: "2026-05-31T00:00:05.000Z",
    });
    const childC = item({
      id: "child-c",
      parent_task_id: parent.id,
      created_at: "2026-05-31T00:00:06.000Z",
    });
    const unrelated = item({
      id: "unrelated",
      created_at: "2026-05-31T00:00:01.000Z",
    });
    const options = {
      repoId: "repo-1",
      items: [parent, childA, childB, childC, unrelated],
      getStageOrder,
    };

    expect(replacementSidebarItemAfterRemoval(options, childA)?.id).toBe("child-b");
    expect(replacementSidebarItemAfterRemoval(options, childC)?.id).toBe("child-b");
    expect(replacementSidebarItemAfterRemoval({
      ...options,
      items: [parent, childB, unrelated],
    }, childB)?.id).toBe("parent");
  });

  it("selects the next top-level peer and clamps to the previous peer at the end", () => {
    const newest = item({ id: "newest", created_at: "2026-05-31T00:00:03.000Z" });
    const middle = item({ id: "middle", created_at: "2026-05-31T00:00:02.000Z" });
    const oldest = item({ id: "oldest", created_at: "2026-05-31T00:00:01.000Z" });
    const options = {
      repoId: "repo-1",
      items: [newest, middle, oldest],
      getStageOrder,
    };

    expect(replacementSidebarItemAfterRemoval(options, middle)?.id).toBe("oldest");
    expect(replacementSidebarItemAfterRemoval(options, oldest)?.id).toBe("middle");
  });

  it("applies the sibling-aware replacement rule to presentation slots", () => {
    const parent = sidebarItem({
      slot_id: "slot-parent",
      task_id: "parent",
      created_at: "2026-05-31T00:00:03.000Z",
    });
    const child = sidebarItem({
      slot_id: "slot-child",
      task_id: "child",
      parent_task_id: "parent",
      created_at: "2026-05-31T00:00:04.000Z",
    });
    const unrelated = sidebarItem({
      slot_id: "slot-unrelated",
      task_id: "unrelated",
      created_at: "2026-05-31T00:00:01.000Z",
    });

    expect(replacementSidebarTaskItemAfterRemoval({
      repoId: "repo-1",
      items: [parent, child, unrelated],
      getStageOrder,
    }, child)?.slot_id).toBe("slot-parent");
  });

  it("orders prepared sibling fallbacks by later rows before clamping backward to earlier rows", () => {
    const parent = sidebarItem({ slot_id: "slot-parent", task_id: "parent" });
    const childA = sidebarItem({
      slot_id: "slot-a",
      task_id: "a",
      parent_task_id: "parent",
      created_at: "2026-05-31T00:00:01.000Z",
    });
    const childB = sidebarItem({
      slot_id: "slot-b",
      task_id: "b",
      parent_task_id: "parent",
      created_at: "2026-05-31T00:00:02.000Z",
    });
    const childC = sidebarItem({
      slot_id: "slot-c",
      task_id: "c",
      parent_task_id: "parent",
      created_at: "2026-05-31T00:00:03.000Z",
    });
    const childD = sidebarItem({
      slot_id: "slot-d",
      task_id: "d",
      parent_task_id: "parent",
      created_at: "2026-05-31T00:00:04.000Z",
    });

    expect(replacementSidebarTaskItemsAfterRemoval({
      repoId: "repo-1",
      items: [parent, childA, childB, childC, childD],
      getStageOrder,
    }, childB).map((item) => item.slot_id)).toEqual([
      "slot-c",
      "slot-d",
      "slot-a",
      "slot-parent",
    ]);
  });

  it("suppresses nesting during an active search so every match stays visible", () => {
    const items = [
      item({ id: "parent", prompt: "alpha" }),
      item({ id: "child", prompt: "beta", parent_task_id: "parent" }),
    ];
    const options = { repoId: "repo-1", items, getStageOrder, searchQuery: "beta" };

    expect(sidebarChildItems(options, "parent")).toEqual([]);
    const ordered = sortSidebarItemsForRepo(options);
    expect(ordered.map((entry) => entry.id)).toEqual(["child"]);
    expect(sidebarSubtreeRows(options, items[1]).map((row) => row.item.id)).toEqual(["child"]);
  });
});
