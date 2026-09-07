// @vitest-environment happy-dom

import type {
  BlockerTaskStates,
  PipelineItem,
  Repo,
  TaskBlocker,
} from "../../types/kanna";
import type { SidebarTaskItem } from "../../types/taskUi";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneVNode, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../Sidebar.vue";

const getStageOrder = vi.fn();

function translate(key: string, params?: Record<string, string>) {
  if (key === "sidebar.clearSearch") {
    return "Translated clear search";
  }
  if (key === "sidebar.noTasksMatching") {
    return `No tasks match "${params?.query ?? ""}"`;
  }
  if (key === "sidebar.noTasks") {
    return "No tasks";
  }
  if (key === "sidebar.remoteTaskTooltip") {
    return "Remote task";
  }
  if (key === "sidebar.awaitingVerdictShort") {
    return "Review";
  }
  if (key === "sidebar.awaitingVerdictBadge") {
    return `Awaiting ${params?.stage ?? ""} verdict`;
  }
  return key;
}

vi.mock("../../stores/kanna", () => ({
  useKannaStore: () => ({
    getStageOrder,
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

const draggableStub = {
  props: ["modelValue", "class", "disabled", "itemKey", "move"],
  emits: ["change"],
  setup(
    props: {
      modelValue: Array<SidebarTaskItem | Repo>;
      class?: string;
      disabled?: boolean;
      itemKey?: string;
      move?: (event: unknown) => boolean;
    },
    { slots }: { slots: { item?: (scope: { element: SidebarTaskItem | Repo }) => ReturnType<typeof h>[] } },
  ) {
    return () => h(
      "div",
      {
        class: props.class,
        "data-disabled": String(Boolean(props.disabled)),
        "data-has-move-guard": String(typeof props.move === "function"),
      },
      (props.modelValue ?? []).flatMap((element) => {
        const nodes = slots.item?.({ element }) ?? [];
        const identity = props.itemKey && props.itemKey in element
          ? String((element as unknown as Record<string, unknown>)[props.itemKey])
          : undefined;
        return nodes.map((node) => cloneVNode(node, { key: identity }));
      }),
    );
  },
};

function flushPromises() {
  return Promise.resolve().then(() => nextTick());
}

const repo: Repo = {
  id: "repo-1",
  path: "/repo",
  name: "kanna-v2",
  default_branch: "main",
  hidden: 0,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  last_opened_at: "2026-01-01T00:00:00.000Z",
};

function item(
  taskId: string,
  overrides: Partial<PipelineItem> & { remote_task?: boolean } = {},
  slotId = `slot:${taskId}`,
): SidebarTaskItem {
  const base: PipelineItem = {
    id: taskId,
    repo_id: repo.id,
    issue_number: null,
    issue_title: null,
    prompt: null,
    workflow: "default",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: "[]",
    pr_number: null,
    pr_url: null,
    branch: null,
    closed_at: null,
    agent_type: null,
    agent_provider: "claude",
    agent_session_id: null,
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    previous_stage: null,
    teardown_started_at: null,
    parent_task_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  const { id: _id, ...task } = {
    ...base,
    ...overrides,
  };
  return {
    ...task,
    slot_id: slotId,
    task_id: taskId,
    state: "ready",
  };
}

function creatingItem(
  slotId: string,
  taskId: string | null = null,
  overrides: Partial<PipelineItem> = {},
): SidebarTaskItem {
  return {
    ...item(taskId ?? "draft", overrides, slotId),
    slot_id: slotId,
    task_id: taskId,
    state: "creating",
  };
}

function mountSidebar(
  taskSlots: SidebarTaskItem[],
  selectedSlotId: string | null = "slot:task-1",
  blockerProps: {
    taskBlockers?: TaskBlocker[];
    blockerTaskStates?: BlockerTaskStates;
    blockerNames?: Record<string, string>;
  } = {},
) {
  return mount(Sidebar, {
    props: {
      repos: [repo],
      taskSlots,
      selectedRepoId: repo.id,
      selectedSlotId,
      blockerNames: {},
      ...blockerProps,
    },
    global: {
      stubs: {
        transition: {
          template: "<div><slot /></div>",
        },
        "transition-group": {
          template: "<div><slot /></div>",
        },
        draggable: draggableStub,
      },
      mocks: {
        $t: translate,
      },
    },
  });
}

function mountSidebarWithRepos(
  repos: Repo[],
  taskSlots: SidebarTaskItem[],
  selectedSlotId: string | null = "slot:task-1",
  selectedRepoId: string | null = repos[0]?.id ?? null,
) {
  return mount(Sidebar, {
    props: {
      repos,
      taskSlots,
      selectedRepoId,
      selectedSlotId,
      blockerNames: {},
    },
    global: {
      stubs: {
        transition: {
          template: "<div><slot /></div>",
        },
        "transition-group": {
          template: "<div><slot /></div>",
        },
        draggable: draggableStub,
      },
      mocks: {
        $t: translate,
      },
    },
  });
}

function wrapper_style(wrapper: ReturnType<typeof mountSidebar>, taskId: string) {
  return wrapper.get(`[data-task-id="${taskId}"] .item-title`).attributes("style");
}

describe("Sidebar", () => {
  beforeEach(() => {
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    getStageOrder.mockReset();
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
  });

  it("renders settled server activity when runtime status has not been observed", () => {
    // runtime_status is nullable: a task no session has reported on yet has
    // no runtime dimension, so the row falls back to the blended activity
    // value and must not acquire working styling from the missing field.
    const wrapper = mountSidebar([
      item("task-runtime-pending", {
        display_name: "Waiting for first runtime observation",
        activity: "idle",
      }),
    ], "slot:task-runtime-pending");

    const title = wrapper.get('[data-task-id="task-runtime-pending"] .item-title');
    expect(title.attributes("style")).toContain("font-style: normal");
    expect(title.text()).toBe("Waiting for first runtime observation");
  });

  it("draws both runtime styling and the unread indicator for a busy unread task", () => {
    const wrapper = mountSidebar([
      item("task-busy-unread", {
        display_name: "Busy and unread",
        activity: "unread",
        runtime_state: "busy",
        read_state: "unread",
      }),
    ], null);

    const style = wrapper
      .get('[data-task-id="task-busy-unread"] .item-title')
      .attributes("style");
    expect(style).toContain("font-style: italic");
    expect(style).toContain("font-weight: normal");
    expect(wrapper.get('[data-task-id="task-busy-unread"] .unread-task-dot').exists()).toBe(true);
  });

  it("restores the unread mark once a busy task settles", () => {
    // The point of keeping the dimensions separate: suppressing the mark while
    // working is a display choice, not a write. The read dimension survives, so
    // the mark comes back the moment the agent stops — which the old behaviour
    // could not do, because a busy transition destroyed the unread state.
    const settled = item("task-settling", {
      display_name: "Finished with unread output",
      activity: "unread",
      runtime_state: "idle",
      read_state: "unread",
    });

    const style = wrapper_style(mountSidebar([settled], null), "task-settling");
    expect(style).toContain("font-weight: normal");
    expect(style).toContain("font-style: normal");
    expect(mountSidebar([settled], null).get('.unread-task-dot').exists()).toBe(true);
  });

  it("keeps the unread mark on a task parked on a prompt", () => {
    // `waiting` is a live session, but it is not working, so the mark stays.
    const wrapper = mountSidebar([
      item("task-waiting-unread", {
        display_name: "Parked on a permission prompt",
        activity: "unread",
        runtime_state: "waiting",
        read_state: "unread",
      }),
    ], null);

    const style = wrapper
      .get('[data-task-id="task-waiting-unread"] .item-title')
      .attributes("style");
    expect(style).toContain("font-weight: normal");
    expect(style).toContain("font-style: normal");
    expect(wrapper.get('[data-task-id="task-waiting-unread"] .unread-task-dot').exists()).toBe(true);
  });

  it("stops drawing a settled task as working while it is unselected", () => {
    // The opposite report: a task that had parked at its composer but went on
    // rendering as busy. `activity` was stranded at "working"; the runtime
    // dimension is what actually settled.
    const wrapper = mountSidebar([
      item("task-settled", {
        display_name: "Parked at its composer",
        activity: "working",
        runtime_state: "idle",
        read_state: "unread",
      }),
    ], null);

    const style = wrapper
      .get('[data-task-id="task-settled"] .item-title')
      .attributes("style");
    expect(style).toContain("font-style: normal");
    expect(style).toContain("font-weight: normal");
    expect(wrapper.get('[data-task-id="task-settled"] .unread-task-dot').exists()).toBe(true);
  });

  it("keeps a task working after it is marked read", () => {
    // Marking read moves the read dimension only. A task still inside a long
    // tool call must not stop reading as working just because someone looked
    // at it, and reading it must not be required to see that it is working.
    const wrapper = mountSidebar([
      item("task-read-busy", {
        display_name: "Read but still working",
        activity: "working",
        runtime_state: "busy",
        read_state: "read",
      }),
    ], "slot:task-read-busy");

    const style = wrapper
      .get('[data-task-id="task-read-busy"] .item-title')
      .attributes("style");
    expect(style).toContain("font-style: italic");
    expect(style).toContain("font-weight: normal");
    expect(wrapper.find('[data-task-id="task-read-busy"] .unread-task-dot').exists()).toBe(false);
  });

  it("falls back to blended activity for a remote task that has no dimensions", () => {
    // Legacy cloud snapshots predate the two split fields and still need an
    // honest fallback to their blended activity.
    const wrapper = mountSidebar([
      item("task-remote", {
        display_name: "Owned elsewhere",
        remote_task: true,
        activity: "working",
      }),
    ], null);

    const style = wrapper
      .get('[data-task-id="task-remote"] .item-title')
      .attributes("style");
    expect(style).toContain("font-style: italic");
    expect(style).toContain("font-weight: normal");
  });

  it("places a remotely blocked task in the blocked section with its blocker name", () => {
    const blocked = item("remote-blocked", {
      display_name: "Blocked remote",
      remote_task: true,
    });
    const blocker = item("remote-blocker", {
      display_name: "Build dependency",
      remote_task: true,
    });
    const wrapper = mountSidebar([blocked, blocker], null, {
      taskBlockers: [{
        blocked_item_id: blocked.task_id,
        blocker_item_id: blocker.task_id,
      }],
      blockerTaskStates: {
        [blocker.task_id]: {
          closed_at: null,
          stage: "in progress",
          pr_url: null,
        },
      },
      blockerNames: {
        [blocked.task_id]: "Build dependency",
      },
    });

    const blockedRow = wrapper.get(`[data-task-id="${blocked.task_id}"]`);
    expect(blockedRow.text()).toContain("sidebar.blockedBy Build dependency");
    expect(blockedRow.element.previousElementSibling).toBeNull();
    expect(wrapper.text()).toContain("sidebar.sectionBlocked");
    expect(wrapper.findAll(`[data-task-id="${blocked.task_id}"]`)).toHaveLength(1);
  });

  it("keeps one selected DOM row when a creating slot hydrates into its durable task", async () => {
    const slotId = "create:stable";
    const wrapper = mountSidebar([
      creatingItem(slotId, null, {
        display_name: "Stable task row",
        prompt: "Keep this task row stable while setup completes",
      }),
    ], slotId);

    const creatingRow = wrapper.get<HTMLElement>(`.workflow-item[data-slot-id="${slotId}"]`);
    const originalElement = creatingRow.element;
    expect(wrapper.findAll(".workflow-item")).toHaveLength(1);
    expect(wrapper.get(".repo-count").text()).toBe("1");
    expect(creatingRow.classes()).toContain("selected");
    expect(creatingRow.classes()).toContain("initializing-item");
    expect(creatingRow.attributes("aria-busy")).toBe("true");
    expect(creatingRow.attributes("data-task-id")).toBeUndefined();

    await wrapper.setProps({
      taskSlots: [item("durable-task", {
        display_name: "Stable task row",
        prompt: "Keep this task row stable while setup completes",
      }, slotId)],
    });
    await nextTick();

    const readyRow = wrapper.get<HTMLElement>(`.workflow-item[data-slot-id="${slotId}"]`);
    expect(wrapper.findAll(".workflow-item")).toHaveLength(1);
    expect(wrapper.get(".repo-count").text()).toBe("1");
    expect(readyRow.element).toBe(originalElement);
    expect(readyRow.classes()).toContain("selected");
    expect(readyRow.classes()).not.toContain("initializing-item");
    expect(readyRow.attributes("aria-busy")).toBeUndefined();
    expect(readyRow.attributes("data-task-id")).toBe("durable-task");
  });

  it("selects acknowledged creating rows by slot id while keeping them busy", async () => {
    const wrapper = mountSidebar([
      creatingItem("create:acknowledged", "durable-pending", {
        display_name: "Acknowledged task",
      }),
    ], "create:acknowledged");

    const row = wrapper.get<HTMLElement>('[data-slot-id="create:acknowledged"]');
    await row.trigger("click");

    expect(row.classes()).toContain("selected");
    expect(row.classes()).toContain("initializing-item");
    expect(row.attributes("aria-busy")).toBe("true");
    expect(row.attributes("data-task-id")).toBe("durable-pending");
    expect(wrapper.get(".repo-count").text()).toBe("1");
    expect(wrapper.emitted("select-item")).toEqual([["create:acknowledged"]]);
    expect(wrapper.emitted("select-repo")).toBeUndefined();
  });

  it("emits slot ids for selection and durable ids for ready mutations", async () => {
    const task = item("durable-ready", {
      display_name: "Ready task",
    }, "slot:ready-distinct");
    const wrapper = mountSidebar([task], "slot:ready-distinct");

    await wrapper.get('[data-slot-id="slot:ready-distinct"]').trigger("click");
    expect(wrapper.emitted("select-item")).toEqual([["slot:ready-distinct"]]);
    expect(wrapper.emitted("select-repo")).toBeUndefined();

    await wrapper.get('[data-slot-id="slot:ready-distinct"]').trigger("dblclick");
    const input = wrapper.get<HTMLInputElement>(".rename-input");
    await input.setValue("Renamed ready task");
    await input.trigger("keydown.enter");
    expect(wrapper.emitted("rename-item")).toEqual([["durable-ready", "Renamed ready task"]]);

    const vm = wrapper.vm as {
      onPinnedChange(repoId: string, event: {
        added: { element: SidebarTaskItem; newIndex: number };
      }): void;
    };
    vm.onPinnedChange(repo.id, { added: { element: task, newIndex: 0 } });

    expect(wrapper.emitted("pin-item")).toEqual([["durable-ready", 0]]);
    expect(wrapper.emitted("reorder-pinned")).toEqual([[repo.id, ["durable-ready"]]]);
  });

  it("shows a connected unpin receiver only while dragging in an all-pinned repository", async () => {
    const tasks = [
      item("task-1", {
        display_name: "First pinned task",
        pinned: 1,
        pin_order: 0,
      }),
      item("task-2", {
        display_name: "Second pinned task",
        pinned: 1,
        pin_order: 1,
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ];
    const wrapper = mountSidebar(tasks, null);
    const vm = wrapper.vm as {
      onTaskDragStart(evt: { item?: HTMLElement }): void;
      onTaskDragEnd(evt: { originalEvent?: Event }): void;
    };

    expect(wrapper.findAll(".type-zone")).toHaveLength(1);
    expect(wrapper.get(".empty-unpin-zone").classes()).not.toContain("empty-unpin-zone-active");

    const dragged = document.createElement("div");
    dragged.dataset.taskId = "task-1";
    vm.onTaskDragStart({ item: dragged });
    await nextTick();

    expect(wrapper.get(".empty-unpin-zone").classes()).toContain("empty-unpin-zone-active");

    wrapper.findComponent(".empty-unpin-zone").vm.$emit("change", {
      added: { element: tasks[0]!, newIndex: 0 },
    });
    await nextTick();

    expect(wrapper.emitted("unpin-item")).toEqual([["task-1"]]);
    expect(wrapper.emitted("reorder-pinned")).toEqual([[repo.id, ["task-2"]]]);

    vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup") });
    await nextTick();

    expect(wrapper.get(".empty-unpin-zone").classes()).not.toContain("empty-unpin-zone-active");
  });

  it("blocks every task mutation while an acknowledged slot is still creating", async () => {
    const pending = creatingItem("create:pending", "durable-pending", {
      display_name: "Pending task",
      pinned: 1,
      pin_order: 0,
      parent_task_id: "durable-parent",
    });
    const wrapper = mountSidebar([pending], "create:pending");
    const vm = wrapper.vm as {
      renameSelectedItem(): void;
      commitRename(slotId: string): void;
      onPinnedChange(repoId: string, event: {
        added?: { element: SidebarTaskItem; newIndex: number };
        moved?: { oldIndex: number; newIndex: number };
      }): void;
      onUnpinnedChange(repoId: string, event: {
        added: { element: SidebarTaskItem; newIndex: number };
      }): void;
      onTaskDragStart(event: { item?: HTMLElement }): void;
      onTaskDragEnd(event: { originalEvent?: Event }): void;
      detachSubtask(item: SidebarTaskItem): void;
      canMoveTask(event: {
        draggedContext: { element: SidebarTaskItem };
        relatedContext: { element: SidebarTaskItem };
      }): boolean;
    };

    await wrapper.get('[data-slot-id="create:pending"]').trigger("dblclick");
    vm.renameSelectedItem();
    vm.commitRename("create:pending");
    vm.onPinnedChange(repo.id, { added: { element: pending, newIndex: 0 } });
    vm.onPinnedChange(repo.id, { moved: { oldIndex: 0, newIndex: 0 } });
    vm.onUnpinnedChange(repo.id, { added: { element: pending, newIndex: 0 } });
    vm.detachSubtask(pending);

    const syntheticDragRow = document.createElement("div");
    syntheticDragRow.dataset.taskId = "durable-pending";
    vm.onTaskDragStart({ item: syntheticDragRow });
    vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup") });

    const forgedReadyEventItem = {
      ...pending,
      state: "ready",
      task_id: pending.slot_id,
    } as SidebarTaskItem;
    vm.onPinnedChange(repo.id, { added: { element: forgedReadyEventItem, newIndex: 0 } });
    vm.onUnpinnedChange(repo.id, { added: { element: forgedReadyEventItem, newIndex: 0 } });
    vm.detachSubtask(forgedReadyEventItem);

    expect(vm.canMoveTask({
      draggedContext: { element: forgedReadyEventItem },
      relatedContext: { element: forgedReadyEventItem },
    })).toBe(false);
    expect(wrapper.find(".rename-input").exists()).toBe(false);
    expect(wrapper.emitted("rename-item")).toBeUndefined();
    expect(wrapper.emitted("pin-item")).toBeUndefined();
    expect(wrapper.emitted("unpin-item")).toBeUndefined();
    expect(wrapper.emitted("reorder-pinned")).toBeUndefined();
    expect(wrapper.emitted("set-parent")).toBeUndefined();
  });

  it("renders task titles without retired post-action prefixes", () => {
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Fix sidebar task ordering",
        stage: "in progress",
      }),
    ]);

    expect(wrapper.text()).toContain("in progress");
    expect(wrapper.text()).toContain("Fix sidebar task ordering");
    expect(wrapper.text()).not.toContain("... Fix sidebar task ordering");
    expect(wrapper.text()).not.toContain("commit");
  });

  it("renders a transition-in-flight prefix while a post is running", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Commit generated changes",
        stage: "in progress",
        has_running_post: 1,
      }),
    ]);

    const title = wrapper.get(".workflow-item .item-title");
    expect(title.text()).toBe("... Commit generated changes");
    expect(title.attributes("title")).toBe("... Commit generated changes");
  });

  it("renders pinned task titles without retired post-action prefixes", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Pinned task",
        pinned: 1,
        pin_order: 0,
      }),
    ]);

    expect(wrapper.text()).toContain("Pinned task");
    expect(wrapper.text()).not.toContain("... Pinned task");
  });

  it("renders the transition-in-flight prefix for pinned tasks while a post is running", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Pinned post task",
        pinned: 1,
        pin_order: 0,
        has_running_post: 1,
      }),
    ]);

    const title = wrapper.get(".pinned-zone .workflow-item .item-title");
    expect(title.text()).toBe("... Pinned post task");
    expect(title.attributes("title")).toBe("... Pinned post task");
  });

  it("renders a subtask nested beneath its parent instead of in its own stage section", () => {
    const wrapper = mountSidebar([
      item("task-1", { display_name: "Parent task", stage: "in progress" }),
      item("task-2", {
        display_name: "Child task",
        stage: "pr",
        parent_task_id: "task-1",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);

    const rows = wrapper.findAll(".workflow-item");
    expect(rows.map((row) => row.get(".item-title").text())).toEqual([
      "Parent task",
      "Child task",
    ]);

    // The child renders as a depth-1 subtask row...
    const childRow = rows[1];
    expect(childRow.classes()).toContain("subtask");
    // ...and the parent stays a top-level row.
    expect(rows[0].classes()).not.toContain("subtask");

    // The child's own "pr" stage must not appear as a separate section header.
    const sectionLabels = wrapper.findAll(".section-label").map((label) => label.text());
    expect(sectionLabels).not.toContain("pr");
  });

  it("still renders open tasks whose parent links form a cycle", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Cycle task A",
        stage: "in progress",
        parent_task_id: "task-2",
      }),
      item("task-2", {
        display_name: "Cycle task B",
        stage: "in progress",
        parent_task_id: "task-1",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);

    expect(wrapper.find(".repo-count").text()).toBe("2");
    expect(wrapper.findAll(".workflow-item").map((row) => row.get(".item-title").text())).toEqual([
      "Cycle task A",
      "Cycle task B",
    ]);
  });

  it("emits a null parent when detaching a subtask from its parent", async () => {
    const wrapper = mountSidebar([
      item("task-1", { display_name: "Parent task", stage: "in progress" }),
      item("task-2", {
        display_name: "Child task",
        stage: "pr",
        parent_task_id: "task-1",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);

    await wrapper.get('[data-testid="detach-subtask-slot:task-2"]').trigger("click");

    expect(wrapper.emitted("set-parent")).toEqual([["task-2", null]]);
  });

  it("does not reparent a parent when a subtask drag is dropped on the same subtask row", () => {
    const wrapper = mountSidebar([
      item("task-1", { display_name: "Parent task", stage: "in progress" }),
      item("task-2", {
        display_name: "Child task",
        stage: "pr",
        parent_task_id: "task-1",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);
    const vm = wrapper.vm as {
      onTaskDragStart(evt: { item?: HTMLElement; originalEvent?: Event }): void;
      onTaskDragEnd(evt: { originalEvent?: Event }): void;
    };
    const draggedSubtree = wrapper.find(".task-subtree").element as HTMLElement;
    const childRow = wrapper.find('[data-task-id="task-2"]').element as HTMLElement;
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(childRow);
    const startEvent = new MouseEvent("mousedown", { clientX: 12, clientY: 34 });
    Object.defineProperty(startEvent, "target", { value: childRow });

    try {
      vm.onTaskDragStart({
        item: draggedSubtree,
        originalEvent: startEvent,
      });
      vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup", { clientX: 12, clientY: 34 }) });
    } finally {
      elementFromPoint.mockRestore();
    }

    expect(wrapper.emitted("set-parent")).toBeUndefined();
  });

  it("emits a null parent when dragging a subtask into a top-level list area", () => {
    const wrapper = mountSidebar([
      item("task-1", { display_name: "Parent task", stage: "in progress" }),
      item("task-2", {
        display_name: "Child task",
        stage: "pr",
        parent_task_id: "task-1",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);
    const vm = wrapper.vm as {
      onTaskDragStart(evt: { item?: HTMLElement; originalEvent?: Event }): void;
      onTaskDragEnd(evt: { originalEvent?: Event }): void;
    };
    const draggedSubtree = wrapper.find(".task-subtree").element as HTMLElement;
    const childRow = wrapper.find('[data-task-id="task-2"]').element as HTMLElement;
    const topLevelDropArea = wrapper.find(".type-zone").element as HTMLElement;
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(topLevelDropArea);
    const startEvent = new MouseEvent("mousedown", { clientX: 12, clientY: 34 });
    Object.defineProperty(startEvent, "target", { value: childRow });

    try {
      vm.onTaskDragStart({
        item: draggedSubtree,
        originalEvent: startEvent,
      });
      vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup", { clientX: 12, clientY: 34 }) });
    } finally {
      elementFromPoint.mockRestore();
    }

    expect(wrapper.emitted("set-parent")).toEqual([["task-2", null]]);
  });

  it("does not set a parent when an unpin drag ends over another task row", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Pinned task",
        pinned: 1,
        pin_order: 0,
      }),
      item("task-2", {
        display_name: "Unpinned task",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
    ]);
    const vm = wrapper.vm as {
      onTaskDragStart(evt: { item?: HTMLElement }): void;
      onTaskDragPointerMove(event: PointerEvent): void;
      onUnpinnedChange(repoId: string, evt: { added?: { element: PipelineItem; newIndex: number } }): void;
      onTaskDragEnd(evt: { originalEvent?: Event }): void;
    };
    const dragged = document.createElement("div");
    dragged.dataset.taskId = "task-1";
    const target = wrapper.find('[data-task-id="task-2"]').element as HTMLElement;
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    try {
      vm.onTaskDragStart({ item: dragged });
      vm.onTaskDragPointerMove(new PointerEvent("pointermove", { clientX: 12, clientY: 34 }));
      vm.onUnpinnedChange(repo.id, { added: { element: wrapper.props("taskSlots")[0]!, newIndex: 0 } });
      vm.onTaskDragEnd({ originalEvent: new MouseEvent("mouseup", { clientX: 12, clientY: 34 }) });
    } finally {
      elementFromPoint.mockRestore();
    }

    expect(wrapper.emitted("unpin-item")).toEqual([["task-1"]]);
    expect(wrapper.emitted("set-parent")).toBeUndefined();
  });

  it("renders full task titles so sidebar width controls visual truncation", () => {
    const longTitle = "Investigate resizing the sidebar so task titles can use the available space";
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: longTitle,
      }),
    ]);

    expect(wrapper.get(".workflow-item .item-title").text()).toBe(longTitle);
  });

  it("uses the rendered task title as the sidebar title tooltip", () => {
    const prompt = "Add tooltip to task titles so hovering shows the full task prompt even when the sidebar truncates the visible title";
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Tooltip task titles",
        prompt,
      }),
    ]);

    const title = wrapper.get(".workflow-item .item-title");
    expect(title.text()).toBe("Tooltip task titles");
    expect(title.attributes("title")).toBe("Tooltip task titles");
  });

  it("marks remote tasks with a leading angle marker and leaves local tasks unmarked", () => {
    const wrapper = mountSidebar([
      item("task-remote", {
        display_name: "LAN visible task",
        created_at: "2026-01-01T11:00:00.000Z",
        remote_task: true,
      } as Partial<PipelineItem>),
      item("task-local", {
        display_name: "Local cleanup",
        created_at: "2026-01-01T10:00:00.000Z",
      }),
    ], null);

    const titles = wrapper.findAll(".workflow-item .item-title");
    expect(titles).toHaveLength(2);
    expect(titles[0]?.text()).toBe("< LAN visible task");
    expect(titles[0]?.attributes("title")).toBe("LAN visible task");
    expect(titles[0]?.find(".remote-task-marker").exists()).toBe(true);
    expect(titles[1]?.text()).toBe("Local cleanup");
    expect(titles[1]?.attributes("title")).toBe("Local cleanup");
    expect(titles[1]?.find(".remote-task-marker").exists()).toBe(false);
  });

  it("marks tasks with an in-flight transfer in either direction and distinguishes a failed one", () => {
    const wrapper = mountSidebar([
      item("task-pushing", {
        display_name: "Pushed away",
        created_at: "2026-01-01T14:00:00.000Z",
        transfer_direction: "outgoing",
        transfer_status: "streaming",
      }),
      item("task-importing", {
        display_name: "Arriving here",
        created_at: "2026-01-01T13:00:00.000Z",
        transfer_direction: "incoming",
        transfer_status: "importing",
      }),
      item("task-failed", {
        display_name: "Transfer broke",
        created_at: "2026-01-01T12:00:00.000Z",
        transfer_direction: "outgoing",
        transfer_status: "failed",
      }),
      item("task-done", {
        display_name: "Transfer finished",
        created_at: "2026-01-01T11:00:00.000Z",
        transfer_direction: "incoming",
        transfer_status: "completed",
      }),
      item("task-local", {
        display_name: "Never transferred",
        created_at: "2026-01-01T10:00:00.000Z",
      }),
    ], null);

    const rows = wrapper.findAll(".workflow-item");
    const stateByTaskId = new Map(
      rows.map((row) => [row.attributes("data-task-id"), row.attributes("data-transfer-state")]),
    );
    expect(stateByTaskId.get("task-pushing")).toBe("transferring");
    expect(stateByTaskId.get("task-importing")).toBe("transferring");
    expect(stateByTaskId.get("task-failed")).toBe("failed");
    expect(stateByTaskId.get("task-done")).toBeUndefined();
    expect(stateByTaskId.get("task-local")).toBeUndefined();

    const markerBySlot = new Map(
      rows.map((row) => [row.attributes("data-task-id"), row.find(".transfer-task-marker")]),
    );
    expect(markerBySlot.get("task-pushing")?.classes()).toContain(
      "transfer-task-marker-transferring",
    );
    expect(markerBySlot.get("task-failed")?.classes()).toContain("transfer-task-marker-failed");
    expect(markerBySlot.get("task-failed")?.text()).not.toBe(
      markerBySlot.get("task-pushing")?.text(),
    );
    expect(markerBySlot.get("task-local")?.exists()).toBe(false);

    const titleByTaskId = new Map(
      rows.map((row) => [row.attributes("data-task-id"), row.find(".item-title")]),
    );
    expect(titleByTaskId.get("task-importing")?.attributes("title")).toBe(
      "Arriving here — sidebar.transferringTaskTooltip",
    );
    expect(titleByTaskId.get("task-failed")?.attributes("title")).toBe(
      "Transfer broke — sidebar.transferFailedTaskTooltip",
    );
    expect(titleByTaskId.get("task-local")?.attributes("title")).toBe("Never transferred");
  });

  it("switches the sidebar into a filtered visual state and shows filtered repo counts", async () => {
    const workflowItems = [
      item("task-1", {
        prompt: "Fix sidebar search visibility",
        display_name: "Sidebar visibility fix",
        branch: "task-1",
        created_at: "2026-04-13 00:00:00",
        updated_at: "2026-04-13 00:00:00",
        activity_changed_at: "2026-04-13 00:00:00",
      }),
      item("task-2", {
        prompt: "Refine merge queue behavior",
        display_name: "Merge queue polish",
        branch: "task-2",
        stage: "pr",
        created_at: "2026-04-13 00:00:00",
        updated_at: "2026-04-13 00:00:00",
        activity_changed_at: "2026-04-13 00:00:00",
      }),
    ];

    const wrapper = mountSidebar(workflowItems);

    await wrapper.get(".search-input").setValue("visibility");

    expect(wrapper.get(".sidebar").classes()).toContain("is-filtering");
    expect(wrapper.get(".repo-count").text()).toBe("1/2");
    expect(wrapper.get(".repo-name").classes()).toContain("filtered-label");
    expect(wrapper.get(".section-label").classes()).toContain("filtered-label");
    expect(wrapper.text()).not.toContain('Filtering tasks: "visibility"');
  });

  it("shows a clear button only while the task search input has text", async () => {
    const wrapper = mountSidebar([
      item("task-1", {
        prompt: "Fix sidebar search visibility",
        display_name: "Sidebar visibility fix",
        branch: "task-1",
      }),
      item("task-2", {
        prompt: "Refine merge queue behavior",
        display_name: "Merge queue polish",
        branch: "task-2",
        stage: "pr",
      }),
    ]);

    expect(wrapper.find('[data-testid="sidebar-search-clear"]').exists()).toBe(false);

    await wrapper.get(".search-input").setValue("visibility");

    const clearButton = wrapper.get('[data-testid="sidebar-search-clear"]');
    expect(clearButton.attributes("aria-label")).toBe("Translated clear search");
    expect(clearButton.attributes("title")).toBe("Translated clear search");

    await clearButton.trigger("click");

    expect((wrapper.get(".search-input").element as HTMLInputElement).value).toBe("");
    expect(wrapper.find('[data-testid="sidebar-search-clear"]').exists()).toBe(false);
    expect(wrapper.findAll(".workflow-item .item-title").map((el) => el.text()).sort()).toEqual([
      "Merge queue polish",
      "Sidebar visibility fix",
    ]);
  });

  it("excludes closed tasks from filtered repo count totals", async () => {
    const workflowItems = [
      item("task-open", {
        prompt: "Fix sidebar search visibility",
        display_name: "Sidebar visibility fix",
        branch: "task-open",
      }),
      item("task-closed", {
        prompt: "Closed sidebar search visibility",
        display_name: "Closed visibility task",
        branch: "task-closed",
        stage: "pr",
        closed_at: "2026-05-31 10:56:44",
      }),
    ];

    const wrapper = mountSidebar(workflowItems);

    await wrapper.get(".search-input").setValue("visibility");

    expect(wrapper.get(".repo-count").text()).toBe("1/1");
    expect(wrapper.findAll(".workflow-item .item-title").map((el) => el.text())).toEqual([
      "Sidebar visibility fix",
    ]);
  });

  it("shows a search-aware empty state when no tasks match the search query", async () => {
    const workflowItems = [
      item("task-1", {
        prompt: "Fix sidebar search visibility",
        display_name: "Sidebar visibility fix",
        branch: "task-1",
      }),
      item("task-2", {
        prompt: "Refine merge queue behavior",
        display_name: "Merge queue polish",
        branch: "task-2",
        stage: "pr",
      }),
    ];

    const wrapper = mountSidebar(workflowItems);

    await wrapper.get(".search-input").setValue("does-not-match");

    expect(wrapper.text()).toContain('No tasks match "does-not-match"');
    expect(wrapper.text()).not.toContain("No tasks\n");
  });

  it("keeps created_at ordering when search is empty and uses search score ordering when query exists", async () => {
    const workflowItems = [
      item("task-1", {
        display_name: "Task checklist",
        created_at: "2026-01-01T11:00:00.000Z",
      }),
      item("task-2", {
        display_name: "Other note",
        created_at: "2026-01-01T09:00:00.000Z",
      }),
      item("task-3", {
        display_name: "task",
        created_at: "2026-01-01T10:00:00.000Z",
      }),
    ];

    const wrapper = mountSidebar(workflowItems, null);

    await flushPromises();
    await flushPromises();

    const vm = wrapper.vm as {
      matchesSearch(item: PipelineItem): boolean;
    };

    expect(wrapper.findAll(".workflow-item .item-title").map((el) => el.text())).toEqual([
      "Task checklist",
      "task",
      "Other note",
    ]);

    await wrapper.get(".search-input").setValue("task");
    await nextTick();

    expect(wrapper.findAll(".workflow-item .item-title").map((el) => el.text())).toEqual([
      "task",
      "Task checklist",
    ]);
    expect(vm.matchesSearch(workflowItems[0])).toBe(true);
    expect(vm.matchesSearch(workflowItems[2])).toBe(true);
    expect(vm.matchesSearch(workflowItems[1])).toBe(false);
  });

  it("scrolls the selected task row into view after selection changes", async () => {
    const scrollIntoView = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const wrapper = mountSidebar([
        item("task-1", {
          display_name: "First task",
          created_at: "2026-01-01T11:00:00.000Z",
        }),
        item("task-2", {
          display_name: "Second task",
          created_at: "2026-01-01T10:00:00.000Z",
        }),
      ], "slot:task-1");

      await flushPromises();
      scrollIntoView.mockClear();

      await wrapper.setProps({ selectedSlotId: "slot:task-2" });
      await flushPromises();

      const selected = wrapper.get(".workflow-item.selected");
      expect(selected.text()).toContain("Second task");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(selected.element);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalDescriptor);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it("marks the repository that contains the selected task", () => {
    const repos = [
      repo,
      {
        ...repo,
        id: "repo-2",
        path: "/repo-2",
        name: "second",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const workflowItems = [
      item("task-1", {
        repo_id: repo.id,
        display_name: "First repo task",
      }),
      item("task-2", {
        repo_id: "repo-2",
        display_name: "Second repo task",
      }),
    ];

    const wrapper = mountSidebarWithRepos(repos, workflowItems, "slot:task-2");

    const headers = wrapper.findAll(".repo-header");
    expect(headers[0]?.classes()).not.toContain("contains-selected-task");
    expect(headers[1]?.classes()).toContain("contains-selected-task");
  });

  it("does not render two repository headers as selected when repo and item selection diverge", () => {
    const repos = [
      repo,
      {
        ...repo,
        id: "repo-2",
        path: "/repo-2",
        name: "second",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const workflowItems = [
      item("task-1", {
        repo_id: repo.id,
        display_name: "First repo task",
      }),
    ];

    const wrapper = mountSidebarWithRepos(repos, workflowItems, "slot:task-1", "repo-2");

    const highlightedHeaders = wrapper.findAll(".repo-header").filter((header) =>
      header.classes().includes("selected") || header.classes().includes("contains-selected-task")
    );
    expect(highlightedHeaders).toHaveLength(1);
    expect(highlightedHeaders[0]?.text()).toContain("kanna-v2");
    expect(highlightedHeaders[0]?.classes()).not.toContain("selected");
    expect(highlightedHeaders[0]?.classes()).toContain("contains-selected-task");
  });

  it("styles the selected-task repository marker as inset top and bottom lines without a filled background", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
    const markerRule = source.match(/\.repo-header\.contains-selected-task\s*\{(?<body>[^}]*)\}/);

    expect(markerRule?.groups?.body).toContain("box-shadow:");
    expect(markerRule?.groups?.body).toContain("inset 0 1px 0 var(--kn-accent)");
    expect(markerRule?.groups?.body).toContain("inset 0 -1px 0 var(--kn-accent)");
    expect(markerRule?.groups?.body).not.toContain("background:");
    expect(markerRule?.groups?.body).not.toContain("outline:");
  });

  it("styles the selected repository marker as inset top and bottom lines without a filled background", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
    const selectedRule = source.match(/\.repo-header\.selected\s*\{(?<body>[^}]*)\}/);

    expect(selectedRule?.groups?.body).toContain("box-shadow:");
    expect(selectedRule?.groups?.body).toContain("inset 0 1px 0 var(--kn-accent)");
    expect(selectedRule?.groups?.body).toContain("inset 0 -1px 0 var(--kn-accent)");
    expect(selectedRule?.groups?.body).not.toContain("background:");
    expect(selectedRule?.groups?.body).not.toContain("outline:");
  });

  it("uses blue accent for selected task and task drop-target outlines by default", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

    const selectedTaskRule = source.match(/\.workflow-item\.selected\s*\{(?<body>[^}]*)\}/);
    const dropTargetRule = source.match(/\.workflow-item\.drop-target\s*\{(?<body>[^}]*)\}/);

    expect(selectedTaskRule?.groups?.body).toContain("outline: 1px solid var(--kn-accent)");
    expect(dropTargetRule?.groups?.body).toContain("outline: 1px dashed var(--kn-accent)");
  });

  it("uses warning yellow instead of the blue accent for active sidebar filtering", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

    const filteringRule = source.match(/\.sidebar\.is-filtering\s*\{(?<body>[^}]*)\}/);
    const contentRule = source.match(/\.sidebar\.is-filtering \.sidebar-content\s*\{(?<body>[^}]*)\}/);
    const repoCountRule = source.match(/\.sidebar\.is-filtering \.repo-count\s*\{(?<body>[^}]*)\}/);
    const searchInputRule = source.match(/\.sidebar\.is-filtering \.search-input\s*\{(?<body>[^}]*)\}/);

    expect(filteringRule?.groups?.body).toContain("border-right-color: var(--kn-warning)");
    expect(contentRule?.groups?.body).toContain("box-shadow: inset 0 1px 0 var(--kn-warning-bg)");
    expect(repoCountRule?.groups?.body).toContain("color: var(--kn-warning)");
    expect(searchInputRule?.groups?.body).toContain("border-color: var(--kn-warning)");
  });

  it("uses warning yellow for repo and task highlights only while filtering", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

    const selectedRepoRule = source.match(/\.sidebar\.is-filtering \.repo-header\.selected\s*\{(?<body>[^}]*)\}/);
    const selectedTaskRepoRule = source.match(/\.sidebar\.is-filtering \.repo-header\.contains-selected-task\s*\{(?<body>[^}]*)\}/);
    const selectedTaskRule = source.match(/\.sidebar\.is-filtering \.workflow-item\.selected\s*\{(?<body>[^}]*)\}/);
    const dropTargetRule = source.match(/\.sidebar\.is-filtering \.workflow-item\.drop-target\s*\{(?<body>[^}]*)\}/);

    expect(selectedRepoRule?.groups?.body).toContain("inset 0 1px 0 var(--kn-warning)");
    expect(selectedTaskRepoRule?.groups?.body).toContain("inset 0 -1px 0 var(--kn-warning)");
    expect(selectedTaskRule?.groups?.body).toContain("outline-color: var(--kn-warning)");
    expect(dropTargetRule?.groups?.body).toContain("outline-color: var(--kn-warning)");
  });

  it("does not use grab-hand cursors as the sidebar drag affordance", () => {
    const source = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

    expect(source).not.toMatch(/cursor:\s*(?:grab|grabbing)\s*;/);
  });

  it("scrolls when a selected active-stage task becomes unclosed and visible", async () => {
    const scrollIntoView = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const wrapper = mountSidebar([
        item("task-closed", {
          display_name: "Closed task",
          stage: "pr",
          closed_at: "2026-06-03T01:05:00.000Z",
        }),
      ], "slot:task-closed");

      await flushPromises();
      scrollIntoView.mockClear();

      await wrapper.setProps({
        taskSlots: [
          item("task-closed", {
            display_name: "Closed task",
            stage: "pr",
            closed_at: null,
          }),
        ],
      });
      await flushPromises();

      const selected = wrapper.get(".workflow-item.selected");
      expect(selected.text()).toContain("Closed task");
      expect(scrollIntoView.mock.contexts[0]).toBe(selected.element);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalDescriptor);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it("keeps a tearing-down task in its workflow stage section with strikethrough styling", async () => {
    const workflowItems = [
      item("task-1", {
        display_name: "PR task cleanup",
        stage: "pr",
        teardown_started_at: "2026-05-08T00:00:00.000Z",
      }),
    ];

    const wrapper = mountSidebar(workflowItems, null);

    await flushPromises();

    expect(wrapper.findAll(".section-label").map((label) => label.text())).toEqual(["pr"]);
    expect(wrapper.text()).not.toContain("teardown");
    const title = wrapper.get(".workflow-item .item-title");
    expect(title.attributes("style")).toContain("text-decoration: line-through");
    expect(title.attributes("style")).toContain("opacity: 0.5");
  });

  it("disables pinned drag interactions while search is active", async () => {
    const workflowItems = [
      item("task-1", {
        display_name: "Task checklist",
        pinned: 1,
        pin_order: 0,
        created_at: "2026-01-01T11:00:00.000Z",
      }),
      item("task-2", {
        display_name: "Other note",
        pinned: 1,
        pin_order: 1,
        created_at: "2026-01-01T10:00:00.000Z",
      }),
    ];

    const wrapper = mountSidebar(workflowItems, null);

    await flushPromises();
    await flushPromises();

    const vm = wrapper.vm as {
      onPinnedChange(repoId: string, evt: { moved?: { oldIndex: number; newIndex: number } }): void;
    };

    expect(wrapper.get(".pinned-zone").attributes("data-disabled")).toBe("false");

    await wrapper.get(".search-input").setValue("task");
    await nextTick();

    expect(wrapper.get(".pinned-zone").attributes("data-disabled")).toBe("true");

    vm.onPinnedChange(repo.id, { moved: { oldIndex: 0, newIndex: 0 } });

    expect(wrapper.emitted("reorder-pinned")).toBeUndefined();
  });

  it("emits repository order when repo drag completes over another repo", async () => {
    const repos = [
      repo,
      {
        ...repo,
        id: "repo-2",
        path: "/repo-2",
        name: "second",
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        ...repo,
        id: "cloud:repo-3",
        path: "cloud",
        name: "remote third",
        remote_url_hash: "remote-third-hash",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ];
    const wrapper = mountSidebarWithRepos(repos, [], null);
    const vm = wrapper.vm as {
      emitRepoReorder(sourceRepoId: string, targetRepoId: string): void;
    };

    vm.emitRepoReorder(repos[2]!.id, repos[0]!.id);

    expect(wrapper.emitted("reorder-repos")).toEqual([[["cloud:repo-3", "repo-1", "repo-2"]]]);
  });

  it("does not reorder repositories while search is active", async () => {
    const repos = [
      repo,
      {
        ...repo,
        id: "repo-2",
        path: "/repo-2",
        name: "second",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    const wrapper = mountSidebarWithRepos(repos, [
      item("task-1", {
        display_name: "Task checklist",
      }),
    ]);
    const vm = wrapper.vm as {
      emitRepoReorder(sourceRepoId: string, targetRepoId: string): void;
    };

    await wrapper.get(".search-input").setValue("task");
    await nextTick();

    vm.emitRepoReorder(repos[1]!.id, repos[0]!.id);

    expect(wrapper.emitted("reorder-repos")).toBeUndefined();
  });

  it("renames a repository from an inline editor opened by double-clicking the repo name", async () => {
    const wrapper = mountSidebar([], null);

    await wrapper.get(".repo-name").trigger("dblclick");
    await nextTick();

    const input = wrapper.get<HTMLInputElement>(".repo-rename-input");
    expect(input.element.value).toBe("kanna-v2");

    await input.setValue("Kanna Desktop");
    await input.trigger("keydown.enter");

    expect(wrapper.emitted("rename-repo")).toEqual([["repo-1", "Kanna Desktop"]]);
  });
});
