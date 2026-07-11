// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "../../types/kanna";
import type { TaskUiSlot } from "../../types/taskUi";

const invokeMock = vi.fn();

const draft = {
  repo_id: "repo-1",
  prompt: "Make a merge master task",
  display_name: "Merge Master",
  pipeline: "default",
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
    pipeline: "default",
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

describe("MainPanel", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_env_var") return Promise.resolve("0.0.0");
      return Promise.reject(new Error("missing"));
    });
    vi.stubGlobal("__KANNA_MOBILE__", false);
    localStorage.clear();
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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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

    expect(wrapper.find(".setup-placeholder").exists()).toBe(false);
    expect(wrapper.get('[data-testid="terminal-tabs"]').attributes("data-session-id")).toBe("task-pending");
  });
});
