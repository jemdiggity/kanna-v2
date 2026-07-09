// @vitest-environment happy-dom

import type { PipelineItem, Repo } from "../../types/kanna";
import { mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, nextTick } from "vue";
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
  props: ["modelValue", "class", "disabled"],
  emits: ["change"],
  setup(
    props: { modelValue: Array<PipelineItem | Repo>; class?: string; disabled?: boolean },
    { slots }: { slots: { item?: (scope: { element: PipelineItem | Repo }) => unknown } },
  ) {
    return () => h(
      "div",
      { class: props.class, "data-disabled": String(Boolean(props.disabled)) },
      (props.modelValue ?? []).map((element) => slots.item?.({ element })),
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

function item(id: string, overrides: Partial<PipelineItem>): PipelineItem {
  const base: PipelineItem = {
    id,
    repo_id: repo.id,
    issue_number: null,
    issue_title: null,
    prompt: null,
    pipeline: "default",
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

  return {
    ...base,
    ...overrides,
  };
}

function mountSidebar(pipelineItems: PipelineItem[], selectedItemId: string | null = "task-1") {
  return mount(Sidebar, {
    props: {
      repos: [repo],
      pipelineItems,
      selectedRepoId: repo.id,
      selectedItemId,
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

function mountSidebarWithRepos(
  repos: Repo[],
  pipelineItems: PipelineItem[],
  selectedItemId: string | null = "task-1",
  selectedRepoId: string | null = repos[0]?.id ?? null,
) {
  return mount(Sidebar, {
    props: {
      repos,
      pipelineItems,
      selectedRepoId,
      selectedItemId,
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

describe("Sidebar", () => {
  beforeEach(() => {
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    getStageOrder.mockReset();
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
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

    const title = wrapper.get(".pipeline-item .item-title");
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

    const title = wrapper.get(".pinned-zone .pipeline-item .item-title");
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

    const rows = wrapper.findAll(".pipeline-item");
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

    await wrapper.get('[data-testid="detach-subtask-task-2"]').trigger("click");

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
      vm.onUnpinnedChange(repo.id, { added: { element: wrapper.props("pipelineItems")[0]!, newIndex: 0 } });
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

    expect(wrapper.get(".pipeline-item .item-title").text()).toBe(longTitle);
  });

  it("uses the rendered task title as the sidebar title tooltip", () => {
    const prompt = "Add tooltip to task titles so hovering shows the full task prompt even when the sidebar truncates the visible title";
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Tooltip task titles",
        prompt,
      }),
    ]);

    const title = wrapper.get(".pipeline-item .item-title");
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

    const titles = wrapper.findAll(".pipeline-item .item-title");
    expect(titles).toHaveLength(2);
    expect(titles[0]?.text()).toBe("< LAN visible task");
    expect(titles[0]?.attributes("title")).toBe("LAN visible task");
    expect(titles[0]?.find(".remote-task-marker").exists()).toBe(true);
    expect(titles[1]?.text()).toBe("Local cleanup");
    expect(titles[1]?.attributes("title")).toBe("Local cleanup");
    expect(titles[1]?.find(".remote-task-marker").exists()).toBe(false);
  });

  it("switches the sidebar into a filtered visual state and shows filtered repo counts", async () => {
    const pipelineItems = [
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

    const wrapper = mountSidebar(pipelineItems);

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
    expect(wrapper.findAll(".pipeline-item .item-title").map((el) => el.text()).sort()).toEqual([
      "Merge queue polish",
      "Sidebar visibility fix",
    ]);
  });

  it("excludes closed tasks from filtered repo count totals", async () => {
    const pipelineItems = [
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

    const wrapper = mountSidebar(pipelineItems);

    await wrapper.get(".search-input").setValue("visibility");

    expect(wrapper.get(".repo-count").text()).toBe("1/1");
    expect(wrapper.findAll(".pipeline-item .item-title").map((el) => el.text())).toEqual([
      "Sidebar visibility fix",
    ]);
  });

  it("shows a search-aware empty state when no tasks match the search query", async () => {
    const pipelineItems = [
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

    const wrapper = mountSidebar(pipelineItems);

    await wrapper.get(".search-input").setValue("does-not-match");

    expect(wrapper.text()).toContain('No tasks match "does-not-match"');
    expect(wrapper.text()).not.toContain("No tasks\n");
  });

  it("keeps created_at ordering when search is empty and uses search score ordering when query exists", async () => {
    const pipelineItems = [
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

    const wrapper = mountSidebar(pipelineItems, null);

    await flushPromises();
    await flushPromises();

    const vm = wrapper.vm as {
      matchesSearch(item: PipelineItem): boolean;
    };

    expect(wrapper.findAll(".pipeline-item .item-title").map((el) => el.text())).toEqual([
      "Task checklist",
      "task",
      "Other note",
    ]);

    await wrapper.get(".search-input").setValue("task");
    await nextTick();

    expect(wrapper.findAll(".pipeline-item .item-title").map((el) => el.text())).toEqual([
      "task",
      "Task checklist",
    ]);
    expect(vm.matchesSearch(pipelineItems[0])).toBe(true);
    expect(vm.matchesSearch(pipelineItems[2])).toBe(true);
    expect(vm.matchesSearch(pipelineItems[1])).toBe(false);
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
      ], "task-1");

      await flushPromises();
      scrollIntoView.mockClear();

      await wrapper.setProps({ selectedItemId: "task-2" });
      await flushPromises();

      const selected = wrapper.get(".pipeline-item.selected");
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
    const pipelineItems = [
      item("task-1", {
        repo_id: repo.id,
        display_name: "First repo task",
      }),
      item("task-2", {
        repo_id: "repo-2",
        display_name: "Second repo task",
      }),
    ];

    const wrapper = mountSidebarWithRepos(repos, pipelineItems, "task-2");

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
    const pipelineItems = [
      item("task-1", {
        repo_id: repo.id,
        display_name: "First repo task",
      }),
    ];

    const wrapper = mountSidebarWithRepos(repos, pipelineItems, "task-1", "repo-2");

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
      ], "task-closed");

      await flushPromises();
      scrollIntoView.mockClear();

      await wrapper.setProps({
        pipelineItems: [
          item("task-closed", {
            display_name: "Closed task",
            stage: "pr",
            closed_at: null,
          }),
        ],
      });
      await flushPromises();

      const selected = wrapper.get(".pipeline-item.selected");
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

  it("keeps a tearing-down task in its pipeline stage section with strikethrough styling", async () => {
    const pipelineItems = [
      item("task-1", {
        display_name: "PR task cleanup",
        stage: "pr",
        teardown_started_at: "2026-05-08T00:00:00.000Z",
      }),
    ];

    const wrapper = mountSidebar(pipelineItems, null);

    await flushPromises();

    expect(wrapper.findAll(".section-label").map((label) => label.text())).toEqual(["pr"]);
    expect(wrapper.text()).not.toContain("teardown");
    const title = wrapper.get(".pipeline-item .item-title");
    expect(title.attributes("style")).toContain("text-decoration: line-through");
    expect(title.attributes("style")).toContain("opacity: 0.5");
  });

  it("disables pinned drag interactions while search is active", async () => {
    const pipelineItems = [
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

    const wrapper = mountSidebar(pipelineItems, null);

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
        id: "repo-3",
        path: "/repo-3",
        name: "third",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ];
    const wrapper = mountSidebarWithRepos(repos, [], null);
    const vm = wrapper.vm as {
      emitRepoReorder(sourceRepoId: string, targetRepoId: string): void;
    };

    vm.emitRepoReorder(repos[2]!.id, repos[0]!.id);

    expect(wrapper.emitted("reorder-repos")).toEqual([[["repo-3", "repo-1", "repo-2"]]]);
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
