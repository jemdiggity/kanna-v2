import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBlockersForItem, type DbHandle, type PipelineItem, type Repo } from "@kanna/db";
import { createTaskBlockedActions } from "./taskBlockedActions";
import type { StoreContext } from "./state";

const mocks = vi.hoisted(() => {
  const invokeMock = vi.fn(async () => undefined);
  const updatePipelineItemActivityMock = vi.fn(async () => {});
  const updatePipelineItemTagsMock = vi.fn(async () => {});
  const listBlockersForItemMock = vi.fn(async () => []);
  return {
    invokeMock,
    updatePipelineItemActivityMock,
    updatePipelineItemTagsMock,
    listBlockersForItemMock,
  };
});

vi.mock("../invoke", () => ({
  invoke: mocks.invokeMock,
}));

vi.mock("@kanna/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kanna/db")>();
  return {
    ...actual,
    getRepo: vi.fn(async () => null),
    hasCircularDependency: vi.fn(async () => false),
    insertTaskBlocker: vi.fn(async () => {}),
    listBlockedByItem: vi.fn(async () => []),
    listBlockersForItem: mocks.listBlockersForItemMock,
    removeTaskBlocker: vi.fn(async () => {}),
    updatePipelineItemActivity: mocks.updatePipelineItemActivityMock,
    updatePipelineItemTags: mocks.updatePipelineItemTagsMock,
  };
});

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Ship it",
    pipeline: "default",
    stage: "in progress",
    stage_result: null,
    active_post_action: null,
    tags: JSON.stringify(["blocked"]),
    pr_number: null,
    pr_url: null,
    branch: "task-task-1",
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: "2026-06-30T00:00:00.000Z",
    unread_at: null,
    port_offset: null,
    display_name: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    previous_stage: null,
    teardown_started_at: null,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeContext(): StoreContext {
  const db = {
    select: vi.fn(async () => []),
    execute: vi.fn(async () => undefined),
  } as unknown as DbHandle;

  return {
    state: {
      db: ref(db),
      repos: ref<Repo[]>([]),
      items: ref<PipelineItem[]>([]),
      initialWindowBootstrap: ref(null),
      selectedRepoId: ref(null),
      selectedItemId: ref(null),
      lastSelectedItemByRepo: ref({}),
      suspendAfterMinutes: ref(5),
      killAfterMinutes: ref(30),
      ideCommand: ref("code"),
      hideShortcutsOnStartup: ref(false),
      devLingerTerminals: ref(false),
      appTheme: ref("system"),
      codeTheme: ref("github-dark"),
      agentMessageAppearance: ref("terminal"),
      lastHiddenRepoId: ref(null),
      pendingSetupIds: ref([]),
      pipelineCache: new Map(),
      agentCache: new Map(),
      stageOrderCache: new Map(),
      pendingCreateVisibility: new Map(),
    },
    services: {
      reloadSnapshot: vi.fn(async () => {}),
    },
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    tt: (key: string) => key,
    requireDb: () => db,
  };
}

function decode(data: unknown): string {
  return new TextDecoder().decode(new Uint8Array(data as number[]));
}

describe("createTaskBlockedActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits blocked resume prompts to Claude with terminal enter", async () => {
    const actions = createTaskBlockedActions(makeContext(), {} as never);
    const blocked = makeItem({ agent_provider: "claude", port_env: "{}" });
    const blocker = makeItem({
      id: "blocker-1",
      tags: "[]",
      branch: "task-blocker-1",
      closed_at: "2026-06-30T00:00:00.000Z",
      display_name: "Dependency",
    });

    await (actions.restoreUnblockedTask as (item: PipelineItem, blockers: PipelineItem[]) => Promise<void>)(blocked, [blocker]);

    const sendInputCall = mocks.invokeMock.mock.calls.find(([command]) => command === "send_input");
    expect(sendInputCall?.[1]).toMatchObject({ sessionId: "task-1" });
    expect(decode(sendInputCall?.[1]?.data)).toBe(
      "\x1b[200~This task was previously blocked by the following tasks, which have now completed:\n"
        + "- Dependency (branch: task-blocker-1)\n"
        + "Their changes may be on branches that haven't merged to main yet.\n"
        + "Please continue this task using that context where relevant.\x1b[201~\r",
    );
  });

  it("submits blocked resume prompts to Codex with the terminal Enter sequence", async () => {
    const actions = createTaskBlockedActions(makeContext(), {} as never);
    const blocked = makeItem({ agent_provider: "codex", port_env: "{}" });
    const blocker = makeItem({
      id: "blocker-1",
      tags: "[]",
      branch: "task-blocker-1",
      closed_at: "2026-06-30T00:00:00.000Z",
      display_name: "Dependency",
    });

    await (actions.restoreUnblockedTask as (item: PipelineItem, blockers: PipelineItem[]) => Promise<void>)(blocked, [blocker]);

    const sendInputCalls = mocks.invokeMock.mock.calls.filter(([command]) => command === "send_input");
    expect(sendInputCalls.map(([, args]) => ({
      sessionId: args?.sessionId,
      data: decode(args?.data),
    }))).toEqual([
      {
        sessionId: "task-1",
        data: "This task was previously blocked by the following tasks, which have now completed:\n"
          + "- Dependency (branch: task-blocker-1)\n"
          + "Their changes may be on branches that haven't merged to main yet.\n"
          + "Please continue this task using that context where relevant.",
      },
      {
        sessionId: "task-1",
        data: "\x1b[13u",
      },
    ]);
  });

  it("starts a dormant branch-only blocked task instead of sending input to a missing session", async () => {
    const repo: Repo = {
      id: "repo-1",
      path: "/repo",
      name: "Repo",
      default_branch: "main",
      remote_url: null,
      remote_url_hash: null,
      hidden: 0,
      sort_order: 0,
      created_at: "2026-06-30T00:00:00.000Z",
      last_opened_at: "2026-06-30T00:00:00.000Z",
    };
    const spawnPtySession = vi.fn(async () => {});
    const context = makeContext();
    context.state.repos.value = [repo];
    context.services.getAgentProviderAvailability = vi.fn(async () => ({
      claude: true,
      copilot: false,
      codex: false,
      opencode: false,
      antigravity: false,
    }));
    context.services.spawnPtySession = spawnPtySession;
    const ports = {
      claimTaskPorts: vi.fn(async () => ({ portEnv: {}, firstPort: null })),
    };
    const blocker = makeItem({
      id: "blocker-1",
      tags: "[]",
      branch: "task-blocker-1",
      closed_at: "2026-06-30T00:00:00.000Z",
      display_name: "Dependency",
    });
    mocks.listBlockersForItemMock.mockResolvedValue([blocker]);
    mocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === "file_exists") return false;
      if (command === "git_default_branch") return "main";
      if (command === "read_text_file") return "";
      return undefined;
    });

    const actions = createTaskBlockedActions(context, ports as never);
    const dormant = makeItem({
      branch: "task-task-1",
      agent_session_id: null,
      port_env: null,
    });

    await actions.restoreUnblockedTask(dormant, [blocker]);

    expect(mocks.invokeMock).not.toHaveBeenCalledWith("send_input", expect.anything());
    expect(spawnPtySession).toHaveBeenCalledWith(
      "task-1",
      "/repo/.kanna-worktrees/task-task-1",
      expect.stringContaining("Original task:\nShip it"),
      80,
      24,
      expect.objectContaining({ agentProvider: "claude" }),
    );
    expect(ports.claimTaskPorts).toHaveBeenCalledWith("task-1", {});
    expect(listBlockersForItem).toHaveBeenCalledWith(expect.anything(), "task-1");
  });
});
