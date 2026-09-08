// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { AGENT_PROVIDERS, getAgentProviderSpec } from "@kanna/agent-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "vue-i18n";
import en from "../../i18n/locales/en.json";
import ja from "../../i18n/locales/ja.json";
import ko from "../../i18n/locales/ko.json";
import type { PipelineItem } from "../../types/kanna";
import type { TaskUiSlot } from "../../types/taskUi";
import { computed } from "vue";
import { useMainTabs } from "../../composables/useMainTabs";
import type { MainTabViewsController } from "../MainPanel.types";

const invokeMock = vi.fn();
const fetchTaskDetailMock = vi.fn();

const draft = {
  repo_id: "repo-1",
  prompt: "Make a merge master task",
  display_name: "Merge Master",
  workflow: "default",
  stage: "merge",
  agent_type: "pty" as const,
  agent_provider: "codex" as const,
  created_at: "2026-05-05 02:09:21",
};

function durableTask(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-pending",
    repo_id: "repo-1",
    prompt: draft.prompt,
    stage: draft.stage,
    tags: "[\"merge\"]",
    pr_number: null,
    pr_url: null,
    branch: "task-task-pending",
    agent_type: "pty",
    agent_provider: "codex",
    port_offset: null,
    port_env: null,
    activity: "working",
    created_at: draft.created_at,
    updated_at: draft.created_at,
    activity_changed_at: draft.created_at,
    unread_at: null,
    pinned: 0,
    pin_order: null,
    display_name: draft.display_name,
    closed_at: null,
    workflow: "default",
    stage_result: null,
    issue_number: null,
    issue_title: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    last_output_preview: null,
    parent_task_id: null,
    ...overrides,
  };
}

function creatingSlot(taskId: string | null): TaskUiSlot {
  return {
    slot_id: "create:stable",
    task_id: taskId,
    state: "creating",
    task: null,
    authoritative_miss_grace_remaining: taskId ? 1 : 0,
    draft,
  };
}

function readySlot(task = durableTask()): TaskUiSlot {
  return {
    slot_id: "create:stable",
    task_id: task.id,
    state: "ready",
    task,
    draft,
  };
}

vi.mock("../../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../../services/desktopServerClient", () => ({
  fetchDesktopTaskDetail: fetchTaskDetailMock,
}));

describe("MainPanel", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    fetchTaskDetailMock.mockReset();
    fetchTaskDetailMock.mockImplementation(async (taskId: string) => ({
      id: taskId,
      stage: "in progress",
      closedAt: null,
      latestRun: null,
      revisionRounds: 0,
      revisionLimit: 3,
      childTaskIds: [],
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_env_var") return Promise.resolve("0.0.0");
      return Promise.reject(new Error("missing"));
    });
    vi.stubGlobal("__KANNA_MOBILE__", false);
    localStorage.clear();
  });

  it("keeps terminal state across task-detail refresh failures", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");
    fetchTaskDetailMock
      .mockResolvedValueOnce({
        id: "task-pending",
        stage: "in progress",
        closedAt: null,
        latestRun: null,
        revisionRounds: 0,
        revisionLimit: 3,
        childTaskIds: [],
      })
      .mockRejectedValueOnce(new Error("transient detail refresh failure"))
      .mockResolvedValueOnce({
        id: "task-pending",
        stage: "in progress",
        closedAt: null,
        latestRun: null,
        revisionRounds: 0,
        revisionLimit: 3,
        childTaskIds: [],
      });
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask()),
        repoPath: "/tmp/repo",
        hasRepos: true,
      },
      attachTo: document.body,
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: true,
          TerminalTabs: {
            name: "TerminalTabs",
            template: '<textarea data-testid="interactive-terminal">buffer-before-refresh</textarea>',
          },
        },
      },
    });
    await flushPromises();
    const terminal = wrapper.get<HTMLTextAreaElement>('[data-testid="interactive-terminal"]');
    await terminal.setValue("typed-during-transition");
    terminal.element.focus();

    await wrapper.setProps({
      uiSlot: readySlot(durableTask({ activity_revision: 1 })),
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="interactive-terminal"]').element).toBe(terminal.element);
    expect(terminal.element.value).toBe("typed-during-transition");
    expect(document.activeElement).toBe(terminal.element);

    await wrapper.setProps({
      uiSlot: readySlot(durableTask({ activity_revision: 2 })),
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="interactive-terminal"]').element).toBe(terminal.element);
    expect(terminal.element.value).toBe("typed-during-transition");
    expect(document.activeElement).toBe(terminal.element);
    wrapper.unmount();
  });

  it("shows a dismissible command hint at the bottom even without repos or tasks and keeps it hidden after dismissal", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");

    const mountPanel = () => mount(MainPanel, {
      props: {
        uiSlot: null,
        hasRepos: false,
      },
      global: {
        mocks: {
          $t: (key: string) =>
            key === "mainPanel.commandHintPrefix"
              ? "Use"
              : key === "mainPanel.commandHintSuffix"
                ? "to see available commands."
                : key === "actions.dismiss"
                  ? "Dismiss"
                  : key,
        },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="terminal-tabs"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="command-hint"]').text().replace(/\s+/g, "")).toContain("Use⌘/toseeavailablecommands.");
    expect(wrapper.findAll('[data-testid="command-hint"] kbd')).toHaveLength(2);

    await wrapper.get('[data-testid="command-hint-dismiss"]').trigger("click");

    expect(wrapper.find('[data-testid="command-hint"]').exists()).toBe(false);
    expect(localStorage.getItem("kanna:hide-command-hint")).toBe("1");

    wrapper.unmount();

    const remounted = mountPanel();

    expect(remounted.find('[data-testid="command-hint"]').exists()).toBe(false);
  });

  it("shows full agent CLI version numbers from --version output", async () => {
    invokeMock.mockImplementation((command: string, args?: { name?: string; script?: string }) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      if (command === "which_binary") return Promise.resolve(`/usr/local/bin/${args?.name ?? "agent"}`);
      if (command === "run_script") {
        if (args?.script === "claude --version") return Promise.resolve("2.1.118 (Claude Code)\n");
        if (args?.script === "copilot --version") {
          return Promise.resolve("GitHub Copilot CLI 1.0.32.\nRun 'copilot update' to check for updates.\n");
        }
        if (args?.script === "codex --version") return Promise.resolve("codex-cli 0.125.0-beta.1+20260429\n");
        if (args?.script === "agy --version") return Promise.resolve("agy 1.0.14\n");
      }
      return Promise.resolve("");
    });

    const { default: MainPanel } = await import("../MainPanel.vue");

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: null,
        hasRepos: false,
      },
      global: {
        mocks: {
          $t: (key: string, values?: Record<string, string>) =>
            key === "mainPanel.agentVersion"
              ? `Version ${values?.version ?? "?"}`
              : key,
        },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Version 2.1.118");
    expect(wrapper.text()).toContain("Version 1.0.32");
    expect(wrapper.text()).toContain("Version 0.125.0-beta.1+20260429");
    expect(wrapper.text()).toContain("Version 1.0.14");
  });

  it("renders a setup card and checks the generated executable for every provider", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      return Promise.reject(new Error("missing"));
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: { item: null, hasRepos: false },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.findAll(".agent-card")).toHaveLength(AGENT_PROVIDERS.length);
    for (const provider of AGENT_PROVIDERS) {
      expect(invokeMock).toHaveBeenCalledWith("which_binary", {
        name: getAgentProviderSpec(provider).executable,
      });
    }
  });

  it("updates a newly installed CLI when setup requests a recheck", async () => {
    let opencodeInstalled = false;
    invokeMock.mockImplementation((command: string, args?: { name?: string; script?: string }) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      if (command === "which_binary" && args?.name === "opencode" && opencodeInstalled) {
        return Promise.resolve("/Users/tester/.opencode/bin/opencode");
      }
      if (command === "which_binary") return Promise.reject(new Error(`missing ${args?.name ?? "agent"}`));
      if (command === "run_script") return Promise.resolve("opencode 1.2.3\n");
      return Promise.resolve("");
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: { uiSlot: null, hasRepos: false },
      global: {
        mocks: {
          $t: (key: string, values?: Record<string, string>) =>
            key === "mainPanel.agentVersion"
              ? `Version ${values?.version ?? "?"}`
              : key === "mainPanel.agentOpenCodeName"
                ? "OpenCode"
                : key,
        },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });
    await flushPromises();

    const openCodeCard = () => wrapper.findAll(".agent-card")
      .find(card => card.text().includes("OpenCode"));
    expect(openCodeCard()?.find(".not-installed").exists()).toBe(true);

    opencodeInstalled = true;
    await (wrapper.vm as unknown as { recheckClis: () => Promise<void> }).recheckClis();
    await flushPromises();

    expect(openCodeCard()?.find(".installed").exists()).toBe(true);
    expect(openCodeCard()?.text()).toContain("Version 1.2.3");
  });

  it("rechecks agent CLIs when the setup shell tab closes", async () => {
    let opencodeInstalled = false;
    invokeMock.mockImplementation((command: string, args?: { name?: string }) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      if (command === "which_binary" && args?.name === "opencode" && opencodeInstalled) {
        return Promise.resolve("/Users/tester/.opencode/bin/opencode");
      }
      if (command === "which_binary") return Promise.reject(new Error(`missing ${args?.name ?? "agent"}`));
      if (command === "run_script") return Promise.resolve("opencode 1.2.3\n");
      return Promise.resolve("");
    });

    const scopeKey = computed<string | null>(() => "app");
    let panel: { onTabClosed?: (tab: { kind: string }) => void } | null = null;
    const tabs = useMainTabs({
      scopeKey,
      onTabClosed: (tab) => panel?.onTabClosed?.(tab),
    });

    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: null,
        hasRepos: false,
        views: {
          tabs,
          modals: {
            finishTransferredModal: vi.fn(),
            homePath: computed(() => "/home/tester"),
          },
          preferences: {},
          store: {},
        } as unknown as MainTabViewsController,
      },
      global: {
        mocks: {
          $t: (key: string, values?: Record<string, string>) =>
            key === "mainPanel.agentVersion"
              ? `Version ${values?.version ?? "?"}`
              : key === "mainPanel.agentOpenCodeName"
                ? "OpenCode"
                : key,
        },
        stubs: {
          TaskHeader: true,
          TerminalTabs: true,
          MainTabBar: true,
          ShellModal: true,
        },
      },
    });
    await flushPromises();
    panel = wrapper.vm as unknown as { onTabClosed?: (tab: { kind: string }) => void };

    const openCodeCard = () => wrapper.findAll(".agent-card")
      .find(card => card.text().includes("OpenCode"));
    expect(openCodeCard()?.find(".not-installed").exists()).toBe(true);

    // The shell is how an agent CLI gets installed before there are repos, so
    // closing that tab is the moment to look again.
    const shellTabId = tabs.openTab({ kind: "shell", shellScope: "repo" });
    await flushPromises();
    opencodeInstalled = true;
    tabs.closeTab(shellTabId!);
    await flushPromises();

    expect(openCodeCard()?.find(".installed").exists()).toBe(true);
  });

  it("shows the Antigravity install command when agy is missing", async () => {
    invokeMock.mockImplementation((command: string, args?: { name?: string }) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      if (command === "which_binary" && args?.name === "agy") return Promise.reject(new Error("missing agy"));
      if (command === "which_binary") return Promise.resolve(`/usr/local/bin/${args?.name ?? "agent"}`);
      if (command === "run_script") return Promise.resolve("1.0.0\n");
      return Promise.resolve("");
    });

    const { default: MainPanel } = await import("../MainPanel.vue");

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: null,
        hasRepos: false,
      },
      global: {
        mocks: {
          $t: (key: string, values?: Record<string, string>) =>
            key === "mainPanel.agentVersion"
              ? `Version ${values?.version ?? "?"}`
              : key === "mainPanel.agentAntigravityName"
                ? "Google Antigravity"
                : key,
        },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.text()).toContain("Google Antigravity");
    expect(wrapper.text()).toContain("curl -fsSL https://antigravity.google/cli/install.sh | bash");
  });

  it("groups installed agents before missing agents and sorts each group alphabetically", async () => {
    invokeMock.mockImplementation((command: string, args?: { name?: string; script?: string }) => {
      if (command === "read_env_var") return Promise.reject(new Error("env var not set"));
      if (command === "which_binary" && (args?.name === "agy" || args?.name === "codex")) {
        return Promise.resolve(`/usr/local/bin/${args.name}`);
      }
      if (command === "which_binary") return Promise.reject(new Error(`missing ${args?.name ?? "agent"}`));
      if (command === "run_script") return Promise.resolve(`${args?.script ?? "agent"} 1.0.0\n`);
      return Promise.resolve("");
    });

    const { default: MainPanel } = await import("../MainPanel.vue");

    const names: Record<string, string> = {
      "mainPanel.agentAntigravityName": "Google Antigravity",
      "mainPanel.agentClaudeName": "Claude Code",
      "mainPanel.agentCodexName": "OpenAI Codex",
      "mainPanel.agentCopilotName": "GitHub Copilot",
      "mainPanel.agentOpenCodeName": "OpenCode",
    };

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: null,
        hasRepos: false,
      },
      global: {
        mocks: {
          $t: (key: string, values?: Record<string, string>) =>
            key === "mainPanel.agentVersion"
              ? `Version ${values?.version ?? "?"}`
              : key === "mainPanel.agentInstalled"
                ? "Installed"
                : key === "mainPanel.agentNotInstalled"
                  ? "Not installed"
                  : names[key] ?? key,
        },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.findAll(".agent-group-title").map(title => title.text())).toEqual(["Installed", "Not installed"]);
    expect(wrapper.findAll(".agent-name").map(name => name.text())).toEqual([
      "Google Antigravity",
      "OpenAI Codex",
      "Claude Code",
      "GitHub Copilot",
      "OpenCode",
    ]);
  });

  it("keeps setup ahead of stale blockers and cloud routing through all creating phases", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: creatingSlot(null),
        repoPath: "/tmp/repo",
        hasRepos: true,
        blockers: [durableTask({ id: "stale-blocker" })],
        cloudTask: true,
        cloudTerminalRef: {
          ownerDesktopId: "desktop-remote",
          ownerLocalTaskId: "remote-task",
        },
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: {
          TaskHeader: {
            props: ["item"],
            template: '<div data-testid="task-header">{{ item.stage }}:{{ item.display_name }}</div>',
          },
          TerminalTabs: {
            props: ["sessionId"],
            template: '<div data-testid="terminal-tabs" :data-session-id="sessionId" />',
          },
          CloudTerminalView: { template: '<div data-testid="cloud-terminal" />' },
        },
      },
    });

    expect(wrapper.find('[data-testid="terminal-tabs"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-terminal"]').exists()).toBe(false);
    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
    expect(wrapper.text()).toContain("mainPanel.taskSettingUp");
    expect(wrapper.get('[data-testid="task-header"]').text()).toBe("merge:Merge Master");

    await wrapper.setProps({ uiSlot: creatingSlot("task-pending") });

    expect(wrapper.find('[data-testid="terminal-tabs"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cloud-terminal"]').exists()).toBe(false);
    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
    expect(wrapper.text()).toContain("mainPanel.taskSettingUp");

    await wrapper.setProps({
      uiSlot: readySlot(),
      blockers: [],
      cloudTask: false,
      cloudTerminalRef: null,
    });
    await flushPromises();

    expect(wrapper.find(".setup-placeholder").exists()).toBe(false);
    expect(wrapper.get('[data-testid="terminal-tabs"]').attributes("data-session-id")).toBe("task-pending");
  });

  it("shows the blocked placeholder when relationship state is unresolved but blocker details are hidden", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(),
        repoPath: "/tmp/repo",
        hasRepos: true,
        blockers: [],
        blocked: true,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    expect(wrapper.find(".blocked-placeholder").exists()).toBe(true);
    expect(wrapper.find('[data-testid="terminal-tabs"]').exists()).toBe(false);
  });

  it("shows remote blocker details instead of mounting the cloud terminal", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");

    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(),
        hasRepos: true,
        cloudTask: true,
        cloudTerminalRef: {
          ownerDesktopId: "desktop-owner",
          ownerLocalTaskId: "task-pending",
          transport: "cloud",
        },
        blockers: [durableTask({
          id: "remote-blocker",
          display_name: "Build dependency",
        })],
        blocked: true,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
          CloudTerminalView: { template: '<div data-testid="cloud-terminal" />' },
        },
      },
    });

    expect(wrapper.find(".blocked-placeholder").exists()).toBe(true);
    expect(wrapper.text()).toContain("Build dependency");
    expect(wrapper.find('[data-testid="cloud-terminal"]').exists()).toBe(false);
  });

  it("shows standalone revision recovery from exhausted task detail even when specialty children are closed", async () => {
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "review",
      closedAt: null,
      latestRun: {
        stage: "review",
        kind: "main",
        status: "failed",
        summary: "Parked for human review: automatic revision budget spent.",
        resumedFromRunId: null,
        resumeFallbackReason: null,
        finishedAt: "2026-08-03T00:00:00Z",
      },
      revisionRounds: 3,
      revisionLimit: 3,
      childTaskIds: ["closed-specialty-child"],
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({ stage: "review" })),
        hasRepos: true,
        blockers: [durableTask({
          id: "closed-specialty-child",
          parent_task_id: "task-pending",
          closed_at: "2026-08-02T00:00:00Z",
          agent_session_id: null,
        })],
        requestRevision: vi.fn(async () => true),
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="revision-recovery"]').exists()).toBe(true);
    expect(wrapper.find(".blocked-placeholder").exists()).toBe(false);
  });

  it("says so when the task's agent session is refusing delivered messages", async () => {
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "merge",
      closedAt: null,
      latestRun: null,
      revisionRounds: 0,
      revisionLimit: 3,
      childTaskIds: [],
      inputBlocked: "inherited-draft-unknown",
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({ activity: "idle" })),
        hasRepos: true,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    // The session is alive and idle, so nothing else on this screen says
    // anything is wrong — this banner is the only thing that does.
    expect(wrapper.find('[data-testid="input-blocked"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps a draft-held stage post visible on the task until its composer clears", async () => {
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "in progress",
      closedAt: null,
      latestRun: null,
      revisionRounds: 0,
      revisionLimit: 3,
      childTaskIds: [],
      composer: { text: "Find and fix a bug in @filename", attestation: "typed" },
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({
          stage: "in progress",
          has_running_post: 1,
          active_post_action: "commit",
        })),
        hasRepos: true,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="post-held-by-draft"]').text()).toContain("mainPanel.advanceHeldHint");
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "in progress",
      closedAt: null,
      latestRun: null,
      revisionRounds: 0,
      revisionLimit: 3,
      childTaskIds: [],
      composer: { text: null, attestation: "not-typed" },
    });
    await wrapper.setProps({
      uiSlot: readySlot(durableTask({
        stage: "in progress",
        has_running_post: 1,
        active_post_action: "commit",
        updated_at: "2026-09-01 01:50:00",
      })),
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="post-held-by-draft"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows no refused-input banner for a task whose session accepts messages", async () => {
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({ activity: "idle" })),
        hasRepos: true,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="input-blocked"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    ["budget remains", 2, 3, "Parked for human review: waiting"],
    ["unlimited budget", 3, 0, "Parked for human review: waiting"],
    ["latest result is not parked", 3, 3, "Review failed for another reason"],
  ])("hides standalone revision recovery when %s", async (_case, rounds, limit, summary) => {
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "review",
      closedAt: null,
      latestRun: {
        stage: "review",
        kind: "main",
        status: "failed",
        summary,
        resumedFromRunId: null,
        resumeFallbackReason: null,
        finishedAt: "2026-08-03T00:00:00Z",
      },
      revisionRounds: rounds,
      revisionLimit: limit,
      childTaskIds: [],
    });
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({ stage: "review" })),
        hasRepos: true,
        requestRevision: vi.fn(async () => true),
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="revision-recovery"]').exists()).toBe(false);
  });

  it("requires both human fields and disables duplicate submission while revision recovery is in flight", async () => {
    fetchTaskDetailMock.mockResolvedValue({
      id: "task-pending",
      stage: "review",
      closedAt: null,
      latestRun: {
        stage: "review",
        kind: "main",
        status: "failed",
        summary: "Parked for human review: automatic revision budget spent.",
        resumedFromRunId: null,
        resumeFallbackReason: null,
        finishedAt: "2026-08-03T00:00:00Z",
      },
      revisionRounds: 3,
      revisionLimit: 3,
      childTaskIds: [],
    });
    let resolveRequest: ((value: boolean) => void) | undefined;
    const requestRevision = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    }));
    const { default: MainPanel } = await import("../MainPanel.vue");
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(durableTask({ stage: "review" })),
        hasRepos: true,
        requestRevision,
      },
      global: {
        mocks: { $t: (key: string) => key },
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });
    await flushPromises();
    await wrapper.get('[data-testid="open-revision-composer"]').trigger("click");

    const submit = wrapper.get<HTMLButtonElement>('[data-testid="submit-revision"]');
    expect(submit.element.disabled).toBe(true);
    await wrapper.get('[data-testid="revision-summary"]').setValue("One more implementation pass");
    expect(submit.element.disabled).toBe(true);
    await wrapper.get('[data-testid="revision-prompt"]').setValue("Fix the deterministic lookup and add coverage.");
    expect(submit.element.disabled).toBe(false);

    await submit.trigger("submit");
    await submit.trigger("submit");
    expect(requestRevision).toHaveBeenCalledTimes(1);
    expect(submit.element.disabled).toBe(true);
    expect(requestRevision).toHaveBeenCalledWith("task-pending", {
      targetStage: "in progress",
      summary: "One more implementation pass",
      prompt: "Fix the deterministic lookup and add coverage.",
      metadata: { source: "kanna-parked-revision-recovery" },
    });

    resolveRequest?.(false);
    await flushPromises();
    expect(wrapper.find('[data-testid="revision-composer"]').exists()).toBe(true);
  });

  it.each([
    ["en", "Task 3c45beea", "Untitled"],
    ["ja", "タスク 3c45beea", "無題"],
    ["ko", "작업 3c45beea", "제목 없음"],
  ])("localizes unresolved and untitled blocker labels in %s", async (locale, unresolved, untitled) => {
    const { default: MainPanel } = await import("../MainPanel.vue");
    const i18n = createI18n({
      legacy: false,
      locale,
      fallbackLocale: "en",
      messages: { en, ja, ko },
    });
    const wrapper = mount(MainPanel, {
      props: {
        uiSlot: readySlot(),
        hasRepos: true,
        blockers: [
          {
            ...durableTask({
              id: "3c45beea",
              display_name: null,
              issue_title: null,
              prompt: null,
            }),
            fallback_task_id: "3c45beea",
          },
          durableTask({
            id: "empty-resolved",
            display_name: null,
            issue_title: null,
            prompt: null,
          }),
        ],
        blocked: true,
      },
      global: {
        plugins: [i18n],
        stubs: {
          TaskHeader: { template: '<div data-testid="task-header" />' },
          TerminalTabs: { template: '<div data-testid="terminal-tabs" />' },
        },
      },
    });

    expect(wrapper.findAll(".blocker-name").map((item) => item.text()))
      .toEqual([unresolved, untitled]);
  });
});
