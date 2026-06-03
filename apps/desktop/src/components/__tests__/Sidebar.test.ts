// @vitest-environment happy-dom

import type { PipelineItem, Repo } from "@kanna/db";
import { mount } from "@vue/test-utils";
import { h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../Sidebar.vue";

const getStageOrder = vi.fn();

function translate(key: string, params?: Record<string, string>) {
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
) {
  return mount(Sidebar, {
    props: {
      repos,
      pipelineItems,
      selectedRepoId: repos[0]?.id ?? null,
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

  it("prefixes active post-action tasks with an ASCII ellipsis and keeps the stage group", () => {
    getStageOrder.mockReturnValue(["merge", "pr", "review", "in progress"]);
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Fix sidebar task ordering",
        active_post_action: "commit",
        stage: "in progress",
      }),
    ]);

    expect(wrapper.text()).toContain("in progress");
    expect(wrapper.text()).toContain("... Fix sidebar task ordering");
    expect(wrapper.text()).not.toContain("commit");
  });

  it("prefixes pinned active post-action tasks", () => {
    const wrapper = mountSidebar([
      item("task-1", {
        display_name: "Pinned task",
        active_post_action: "commit",
        pinned: 1,
        pin_order: 0,
      }),
    ]);

    expect(wrapper.text()).toContain("... Pinned task");
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
    expect(titles[0]?.attributes("title")).toBe("Remote task");
    expect(titles[0]?.find(".remote-task-marker").exists()).toBe(true);
    expect(titles[1]?.text()).toBe("Local cleanup");
    expect(titles[1]?.attributes("title")).toBeUndefined();
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
