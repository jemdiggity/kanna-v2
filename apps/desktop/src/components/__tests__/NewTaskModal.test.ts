// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { AGENT_PROVIDERS, AGENT_PROVIDER_SPECS } from "@kanna/agent-protocol";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewTaskModal from "../NewTaskModal.vue";
import { clearContextShortcuts, getContextShortcuts } from "../../composables/useShortcutContext";

async function flushPromises() {
  await Promise.resolve();
  await nextTick();
}

function selectedAgentLabel(wrapper: ReturnType<typeof mount<typeof NewTaskModal>>): string {
  return wrapper.get(".agent-provider").text();
}

const invokeMock = vi.hoisted(() => vi.fn());
const DEFAULT_AVAILABLE_PROVIDERS = ["claude", "codex", "opencode", "antigravity"] as const;

vi.mock("../../invoke", () => ({
  invoke: invokeMock,
}));

describe("NewTaskModal", () => {
  it("keeps prompt entry available while task options load", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        optionsLoading: true,
        availableAgentProviders: ["claude"],
        pipelines: ["default"],
        baseBranches: ["origin/main"],
        defaultBaseBranch: "origin/main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await wrapper.get("textarea").setValue("Write while loading");

    expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="task-options-loading"]').text()).toBe("tasks.loadingOptions");
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");
    expect(wrapper.get('[data-testid="base-branch-toggle"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="pipeline-toggle"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get(".btn-primary").attributes("disabled")).toBeDefined();
  });

  it("shows a neutral branch loading value before uncached options arrive", () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        optionsLoading: true,
        availableAgentProviders: undefined,
        pipelines: [],
        baseBranches: [],
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    const branchValue = wrapper.get('[data-testid="base-branch-value"]');
    expect(branchValue.text()).toBe("tasks.loadingOptions");
    expect(branchValue.classes()).not.toContain("invalid");
  });

  it("uses the repository default pipeline after options load", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        optionsLoading: true,
        availableAgentProviders: ["claude"],
        baseBranches: ["origin/main"],
        defaultBaseBranch: "origin/main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toBe("default");

    await wrapper.setProps({
      optionsLoading: false,
      pipelines: ["default", "qa-review"],
      defaultPipeline: "qa-review",
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toBe("qa-review");

    await wrapper.get("textarea").setValue("Use the configured pipeline");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.[0]).toEqual([
      "Use the configured pipeline", "claude", "qa-review", "origin/main", "pty",
    ]);
  });

  it("keeps a valid user-selected pipeline when options hydrate again", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        pipelines: ["default", "qa-review"],
        defaultPipeline: "qa-review",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await wrapper.get('[data-testid="pipeline-toggle"]').trigger("click");
    await wrapper.get('[data-testid="pipeline-option-default"]').trigger("click");
    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toBe("default");

    await wrapper.setProps({
      pipelines: ["default", "qa-review", "release"],
      defaultPipeline: "release",
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="pipeline-value"]').text()).toBe("default");
  });

  it("keeps Create disabled while a previous task submission finishes", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        submissionPending: true,
        availableAgentProviders: ["claude"],
        pipelines: ["default"],
        baseBranches: ["origin/main"],
        defaultBaseBranch: "origin/main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await wrapper.get("textarea").setValue("Queue another task");

    expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
    expect(wrapper.get(".btn-primary").attributes("disabled")).toBeDefined();
  });

  beforeEach(() => {
    invokeMock.mockClear();
  });

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

    expect(selectedAgentLabel(wrapper)).toBe("claude");
    expect(wrapper.findAll(".agent-provider")).toHaveLength(1);

    await wrapper.find("textarea").trigger("keydown", {
      key: "]",
      metaKey: true,
      shiftKey: true,
    });
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex");
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

    expect(selectedAgentLabel(wrapper)).toBe("claude");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex");
  });

  it("includes OpenCode in the agent cycle when installed", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "codex",
        availableAgentProviders: [...DEFAULT_AVAILABLE_PROVIDERS],
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("opencode");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude sdk");
  });

  it("includes Antigravity in the agent cycle when agy is installed", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "opencode",
        availableAgentProviders: [...DEFAULT_AVAILABLE_PROVIDERS],
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("opencode");

    for (let attempt = 0; attempt < 4 && selectedAgentLabel(wrapper) !== "antigravity"; attempt++) {
      await wrapper.get(".agent-provider").trigger("click");
      await flushPromises();
    }

    expect(selectedAgentLabel(wrapper)).toBe("antigravity");
  });

  it("offers every installed PTY provider and every headless-capable provider", async () => {
    const sortedProviders = [...AGENT_PROVIDERS].sort((a, b) => a.localeCompare(b));
    const sortedHeadlessProviders = AGENT_PROVIDER_SPECS
      .filter((spec) => spec.supports_headless)
      .map((spec) => spec.id)
      .sort((a, b) => a.localeCompare(b));
    const expectedChoices = [
      ...sortedProviders,
      ...sortedHeadlessProviders.map((provider) => `${provider} sdk`),
    ];
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: sortedProviders[0],
        availableAgentProviders: sortedProviders,
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    const choices: string[] = [];
    for (let index = 0; index < expectedChoices.length; index += 1) {
      choices.push(selectedAgentLabel(wrapper));
      await wrapper.get(".agent-provider").trigger("click");
      await flushPromises();
    }

    expect(choices).toEqual(expectedChoices);
  });

  it("keeps OpenCode selectable in headless agent mode", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "opencode",
        defaultAgentType: "agent",
        availableAgentProviders: ["opencode"],
        baseBranches: ["main"],
        defaultBaseBranch: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("opencode sdk");
    expect(wrapper.find('[data-testid="model-select"]').exists()).toBe(false);

    await wrapper.get("textarea").setValue("Use OpenCode headlessly");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.[0]).toEqual([
      "Use OpenCode headlessly", "opencode", "default", "main", "agent",
    ]);
  });

  it("uses repo-scoped provider availability without probing the desktop PATH", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "opencode",
        availableAgentProviders: ["opencode"],
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("opencode");
    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("opencode sdk");
    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("opencode");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not offer or submit an unavailable provider when the repo has no agent executable", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        availableAgentProviders: [],
        baseBranches: ["main"],
        defaultBaseBranch: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await wrapper.get("textarea").setValue("Cannot run");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(selectedAgentLabel(wrapper)).toBe("mainPanel.agentNotInstalled");
    expect(wrapper.get(".btn-primary").attributes()).toHaveProperty("disabled");
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it("orders agent choices by most recent exact usage", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        availableAgentProviders: ["claude", "copilot", "codex", "opencode"],
        recentAgentChoices: [
          { provider: "copilot", executionType: "pty" },
          { provider: "codex", executionType: "agent" },
        ],
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("copilot");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex sdk");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("codex");
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
        availableAgentProviders: [...DEFAULT_AVAILABLE_PROVIDERS],
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
      ["Ship branch picker", "claude", "default", "feature/task-base-branch", "pty"],
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

    expect(wrapper.emitted("submit")).toEqual([["Ship pipeline picker", "claude", "review", "origin/main", "pty"]]);
  });

  it("uses combined chat and CLI agent choices when submitting", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        defaultAgentProvider: "claude",
        availableAgentProviders: [...DEFAULT_AVAILABLE_PROVIDERS],
        pipelines: ["default"],
        defaultPipeline: "default",
        baseBranches: ["origin/main"],
        defaultBaseBranch: "origin/main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    await flushPromises();

    expect(selectedAgentLabel(wrapper)).toBe("claude");

    await wrapper.get("textarea").setValue("Keep raw");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.at(-1)).toEqual(["Keep raw", "claude", "default", "origin/main", "pty"]);

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("codex");

    await wrapper.get("textarea").setValue("Use codex raw");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.at(-1)).toEqual(["Use codex raw", "codex", "default", "origin/main", "pty"]);

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("opencode");

    await wrapper.get(".agent-provider").trigger("click");
    await flushPromises();
    expect(selectedAgentLabel(wrapper)).toBe("claude sdk");

    await wrapper.get("textarea").setValue("Use claude chat");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", metaKey: true });

    expect(wrapper.emitted("submit")?.at(-1)).toEqual(["Use claude chat", "claude", "default", "origin/main", "agent"]);

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
      ["Ship branch picker submit", "claude", "default", "origin/main", "pty"],
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
    expect(wrapper.get('[data-testid="base-branch-value"]').classes()).toContain("invalid");

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
      ["Ship branch fallback", "claude", "default", "origin/main", "pty"],
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

  it("updates an automatically selected base branch when the refreshed default changes", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["origin/main", "main"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await flushPromises();
    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/main");

    await wrapper.setProps({
      baseBranches: ["origin/dev", "dev", "origin/main", "main"],
      defaultBaseBranch: "origin/dev",
      defaultBranchName: "dev",
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("origin/dev");
  });

  it("keeps a manually selected base branch when refreshed options still include it", async () => {
    const wrapper = mount(NewTaskModal, {
      props: {
        baseBranches: ["origin/main", "main", "feature/task-base-branch"],
        defaultBaseBranch: "origin/main",
        defaultBranchName: "main",
      },
      global: { mocks: { $t: (key: string) => key } },
    });

    await wrapper.get('[data-testid="base-branch-toggle"]').trigger("click");
    await wrapper.get('[data-testid="base-branch-option-feature/task-base-branch"]').trigger("click");

    await wrapper.setProps({
      baseBranches: ["origin/dev", "dev", "origin/main", "main", "feature/task-base-branch"],
      defaultBaseBranch: "origin/dev",
      defaultBranchName: "dev",
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="base-branch-value"]').text()).toBe("feature/task-base-branch");
  });
});
