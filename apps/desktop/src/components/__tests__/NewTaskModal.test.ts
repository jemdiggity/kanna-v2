// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewTaskModal from "../NewTaskModal.vue";
import { clearContextShortcuts, getContextShortcuts } from "../../composables/useShortcutContext";

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

function selectedAgentLabel(wrapper: ReturnType<typeof mount<typeof NewTaskModal>>): string {
  return wrapper.get(".agent-provider").text();
}

vi.mock("../../invoke", () => ({
  invoke: vi.fn(async (command: string, args?: { name?: string; repoPath?: string }) => {
    if (command === "which_binary" && (args?.name === "claude" || args?.name === "codex" || args?.name === "opencode")) {
      return true;
    }
    throw new Error("missing");
  }),
}));

describe("NewTaskModal", () => {
  afterEach(() => {
    clearContextShortcuts("newTask");
  });

  it("shows only the selected agent choice and updates it when cycling", async () => {
    const wrapper = mount(NewTaskModal, {
      props: { defaultAgentProvider: "claude" },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude sdk");
    expect(wrapper.findAll(".agent-provider")).toHaveLength(1);

    await wrapper.find("textarea").trigger("keydown", {
      key: "]",
      metaKey: true,
      shiftKey: true,
    });
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude");
    expect(wrapper.findAll(".agent-provider")).toHaveLength(1);
  });

  it("cycles forward when the agent choice is clicked", async () => {
    const wrapper = mount(NewTaskModal, {
      props: { defaultAgentProvider: "claude" },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude sdk");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude");
  });

  it("includes OpenCode in the agent cycle when installed", async () => {
    const wrapper = mount(NewTaskModal, {
      props: { defaultAgentProvider: "codex" },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex sdk");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("opencode");
  });

  it("prevents mouse down default on the agent indicator so focus stays on the prompt", async () => {
    const wrapper = mount(NewTaskModal, {
      props: { defaultAgentProvider: "claude" },
      attachTo: document.body,
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    const textarea = wrapper.get("textarea");
    const agentButton = wrapper.get(".agent-provider");

    await textarea.trigger("focus");
    expect(document.activeElement).toBe(textarea.element);

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    agentButton.element.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    await agentButton.trigger("click");
    await flushPromises();

    expect(document.activeElement).toBe(textarea.element);

    wrapper.unmount();
  });

  it("registers the agent switching shortcut in new task context", async () => {
    mount(NewTaskModal, {
      props: { defaultAgentProvider: "claude" },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();

    expect(getContextShortcuts("newTask")).toContainEqual({
      action: "Switch agent",
      keys: "⇧⌘[ / ⇧⌘]",
    });
  });

  it("emits the selected base branch on submit", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["origin/main", "main", "feature/task-base-branch"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get("textarea").setValue("Ship branch picker");
    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
    await wrapper.get('[data-testid="base-branch-option-feature/task-base-branch"]').trigger("click");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")).toEqual([
      ["Ship branch picker", "claude", "default", "feature/task-base-branch", "agent"],
    ]);
  });

  it("renders the base branch row before the pipeline row", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["origin/main", "main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    const labels = wrapper.findAll(".pipeline-row .pipeline-label").map((label) => label.text());

    expect(labels).toEqual(["tasks.baseBranch", "Pipeline"]);
  });

  it("shows the selected pipeline inline before the picker is opened", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        pipelines: ["default", "review"],
        defaultPipeline: "review",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toContain("review");
    expect(wrapper.find('[data-testid="pipeline-option-default"]').exists()).toBe(false);
    expect(wrapper.find("#pipeline-select").exists()).toBe(false);
    expect(wrapper.get('[data-testid="pipeline-toggle"]').attributes("aria-expanded")).toBe("false");

    await wrapper.get('[data-testid="pipeline-toggle"]').trigger("click");

    expect(wrapper.get('[data-testid="pipeline-option-default"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="pipeline-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(wrapper.get('[data-testid="pipeline-option-review"]').classes()).toContain("selected");
  });

  it("opens the pipeline selector as the same compact dropdown style as base branch", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        pipelines: ["default", "review", "release"],
        defaultPipeline: "review",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get('[data-testid="pipeline-toggle"]').trigger("click");

    const dropdown = wrapper.get('[data-testid="pipeline-dropdown"]');
    const options = wrapper.get('[data-testid="pipeline-options"]');

    expect(dropdown.classes()).toContain("base-branch-dropdown");
    expect(options.classes()).toContain("base-branch-options");
    expect(options.attributes("style")).toContain("max-height");
    expect(wrapper.find(".base-branch-picker").exists()).toBe(false);
  });

  it("updates the selected pipeline through the inline picker before submit", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default", "review"],
        defaultPipeline: "default",
        baseBranches: ["origin/main", "main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get("textarea").setValue("Ship pipeline picker");
    await wrapper.get('[data-testid="pipeline-toggle"]').trigger("click");
    await wrapper.get('[data-testid="pipeline-option-review"]').trigger("click");
    expect(wrapper.find('[data-testid="pipeline-option-review"]').exists()).toBe(false);
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")).toEqual([["Ship pipeline picker", "claude", "review", "origin/main", "agent"]]);
  });

  it("uses combined chat and CLI agent choices when submitting", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["origin/main"],
        defaultBaseBranch: "origin/main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude sdk");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("claude");

    await wrapper.get("textarea").setValue("Keep raw");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.at(-1)).toEqual(["Keep raw", "claude", "default", "origin/main", "pty"]);

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("codex sdk");

    await wrapper.get("textarea").setValue("Use codex chat");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.at(-1)).toEqual(["Use codex chat", "codex", "default", "origin/main", "agent"]);
  });

  it("supports keyboard navigation in the pipeline picker and returns focus to the toggle", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        pipelines: ["default", "review"],
        defaultPipeline: "default",
      },
      attachTo: document.body,
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    const toggle = wrapper.get('[data-testid="pipeline-toggle"]');
    await toggle.trigger("focus");

    await toggle.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();

    expect(wrapper.get('[data-testid="pipeline-toggle"]').attributes("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(wrapper.get('[data-testid="pipeline-option-default"]').element);

    await wrapper.get('[data-testid="pipeline-option-default"]').trigger("keydown", { key: "ArrowDown" });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-testid="pipeline-option-review"]').element);

    wrapper.get('[data-testid="pipeline-option-review"]').element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    wrapper.get('[data-testid="pipeline-option-review"]').element.click();
    await flushPromises();

    expect(wrapper.find('[data-testid="pipeline-option-review"]').exists()).toBe(false);
    expect(document.activeElement).toBe(toggle.element);

    await toggle.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-testid="pipeline-option-review"]').element);

    await wrapper.get('[data-testid="pipeline-option-review"]').trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(wrapper.find('[data-testid="pipeline-option-review"]').exists()).toBe(false);
    expect(document.activeElement).toBe(toggle.element);

    wrapper.unmount();
  });

  it("uses a default pipeline option when no pipelines are provided", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {},
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get('[data-testid="pipeline-toggle"]').trigger("click");

    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toContain("default");
    expect(wrapper.get('[data-testid="pipeline-option-default"]').exists()).toBe(true);
  });

  it("filters branch options with fuzzy search", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["origin/main", "main", "feature/task-base-branch", "fix/base-branch-picker"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
    await wrapper.get('[data-testid="base-branch-search"]').setValue("tbb");

    expect(wrapper.text()).toContain("feature/task-base-branch");
    expect(wrapper.text()).not.toContain("fix/base-branch-picker");
  });

  it("opens the base branch selector as a compact dropdown with capped results height", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: [
          "origin/main",
          "main",
          "feature/task-base-branch",
          "feature/sidebar-analytics",
          "feature/worktree-cleanup",
          "feature/command-palette-filtering",
          "fix/base-branch-picker",
          "release/2026.04",
        ],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");

    expect(wrapper.get('[data-testid="base-branch-dropdown"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="base-branch-options"]').attributes("style")).toContain("max-height");
  });

  it("supports keyboard selection in the base branch dropdown and closes after selection", async () => {
    const wrapper = mount(NewTaskModal, {
      attachTo: document.body,
      props: {
        baseBranches: ["origin/main", "main", "release/2026.04"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
    await flushPromises();

    const search = wrapper.get('[data-testid="base-branch-search"]');
    expect(document.activeElement).toBe(search.element);

    await search.trigger("keydown", { key: "ArrowDown" });
    await search.trigger("keydown", { key: "ArrowDown" });
    await search.trigger("keydown", { key: "Enter" });

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("release/2026.04");
    expect(wrapper.find('[data-testid="base-branch-dropdown"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("submits with Cmd+Enter while the base branch search input is focused", async () => {
    const wrapper = mount(NewTaskModal, {
      attachTo: document.body,
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["origin/main", "main", "release/2026.04"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get("textarea").setValue("Ship branch picker submit");
    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
    await flushPromises();

    const search = wrapper.get('[data-testid="base-branch-search"]');
    expect(document.activeElement).toBe(search.element);

    await search.trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")).toEqual([
      ["Ship branch picker submit", "claude", "default", "origin/main", "agent"],
    ]);

    wrapper.unmount();
  });

  it("shows the selected base branch inline before the picker is opened", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["origin/main", "main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("origin/main");
    expect(wrapper.get('[data-testid="base-branch-change-link"]').text()).toContain("addRepo.change");
    expect(wrapper.find('[data-testid="base-branch-dropdown"]').exists()).toBe(false);
  });

  it("prefers origin default branch when no explicit default base branch is provided", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["feature/x", "main", "origin/main"],
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("origin/main");
  });

  it("shows the local default branch when origin default is unavailable", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["feature/x", "main"],
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("main");
  });

  it("blocks submit when no valid default base branch is available", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["feature/x"],
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("tasks.baseBranchRequired");

    await wrapper.get("textarea").setValue("Ship invalid branch guard");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.get(".btn-primary").attributes("disabled")).toBeDefined();
  });

  it("emits the visible base branch when submit leaves a resolved default untouched", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["feature/task-base-branch", "main", "origin/main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get("textarea").setValue("Ship branch fallback");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")).toEqual([
      ["Ship branch fallback", "claude", "default", "origin/main", "agent"],
    ]);
  });

  it("repairs the selected base branch when the available branches change", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["origin/main", "main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("origin/main");

    await wrapper.setProps({
      baseBranches: ["origin/dev", "dev"],
      defaultBaseBranch: "origin/dev",
      defaultBranchName: "dev",
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toContain("origin/dev");
  });
});
