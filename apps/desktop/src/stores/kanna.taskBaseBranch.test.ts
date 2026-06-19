import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo, TaskPort } from "@kanna/db";
import type { PipelineDefinition } from "../../../../packages/core/src/pipeline/pipeline-types";
import type { CustomTaskConfig, RepoConfig } from "@kanna/core";
import { buildStagePrompt } from "../../../../packages/core/src/pipeline/prompt-builder";

const toastErrorMock = vi.hoisted(() => vi.fn());
const publishDesktopTaskSnapshotMock = vi.hoisted(() => vi.fn(async () => {}));

const mockState = vi.hoisted(() => {
  const repoPath = "/tmp/repo";
  const now = "2026-04-14T00:00:00.000Z";

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    return {
      id: "repo-1",
      path: repoPath,
      name: "repo",
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: now,
      last_opened_at: now,
      ...overrides,
    };
  }

  function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
    return {
      id: "item-1",
      repo_id: "repo-1",
      issue_number: null,
      issue_title: null,
      prompt: "Ship it",
      pipeline: "default",
      stage: "in progress",
      stage_result: null,
      active_post_action: null,
      tags: "[]",
      pr_number: null,
      pr_url: null,
      branch: "task-existing",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "idle",
      activity_changed_at: now,
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
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  let repos = [makeRepo()];
  let pipelineItems: PipelineItem[] = [];
  let pipelineDefinition: PipelineDefinition = {
    name: "default",
    stages: [],
  };
  let readEnvVarOverrides: Record<string, string> = {
    KANNA_DB_NAME: "kanna-wt-task-existing.db",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  let defaultBranchResponse = "main";
  let currentBranchResponse: string | Error | null = null;
  let baseBranchResponse: string[] | Error = ["origin/main", "main"];
  let repoConfig: RepoConfig = {};
  let repoConfigResolver: ((path: string) => RepoConfig | undefined) | null = null;
  let taskPorts: TaskPort[] = [];
  let blockCleanupGate: Promise<void> | null = null;
  let failingCommands: Record<string, string> = {};
  const listBlockersForItemMock = vi.fn(async () => [] as PipelineItem[]);
  const listBlockedByItemMock = vi.fn(async () => [] as PipelineItem[]);
  const setSettingMock = vi.fn(async () => {});
  const updatePipelineItemTagsMock = vi.fn(async (_db: DbHandle, itemId: string, tags: string[]) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.tags = JSON.stringify(tags);
      item.updated_at = now;
    }
  });
  const insertWorktreeMock = vi.fn(async () => {});
  const upsertTerminalSessionMock = vi.fn(async () => {});

  function defer(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (failingCommands[command]) {
      throw new Error(failingCommands[command]);
    }
    switch (command) {
      case "git_default_branch":
        return defaultBranchResponse;
      case "git_current_branch":
        if (currentBranchResponse instanceof Error) throw currentBranchResponse;
        return currentBranchResponse ?? String(args?.repoPath ?? "").split("/").pop() ?? null;
      case "git_list_base_branches":
        if (baseBranchResponse instanceof Error) throw baseBranchResponse;
        return baseBranchResponse;
      case "git_fetch":
      case "git_worktree_add":
      case "git_worktree_remove":
      case "spawn_session":
      case "signal_session":
      case "spawn_agent_session":
      case "kill_session":
      case "detach_session":
      case "attach_session_with_snapshot":
      case "send_input":
      case "run_script":
        return undefined;
      case "list_sessions":
        return pipelineItems
          .filter((item) => item.closed_at === null && item.agent_type === "pty")
          .map((item) => ({
            session_id: item.id,
            state: "Active",
          }));
      case "file_exists":
        return false;
      case "list_dir":
        return [];
      case "which_binary":
        return `/usr/bin/${String(args?.name ?? "tool")}`;
      case "get_app_data_dir":
        return "/tmp/kanna";
      case "get_pipeline_socket_path":
        return "/tmp/kanna.sock";
      case "read_env_var":
        return readEnvVarOverrides[String(args?.name ?? "")] ?? "";
      case "ensure_term_init":
        return "/tmp/kanna-zdotdir";
      case "read_builtin_resource":
        return "{}";
      case "read_text_file":
        if (typeof args?.path === "string" && args.path.endsWith("/.kanna/config.json")) {
          return JSON.stringify({ __mockPath: args.path });
        }
        throw new Error("missing");
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  });

  const insertPipelineItemMock = vi.fn(async (_db: DbHandle, item: Partial<PipelineItem>) => {
    pipelineItems.push(makeItem({
      id: item.id,
      repo_id: item.repo_id,
      prompt: item.prompt ?? null,
      pipeline: item.pipeline,
      stage: item.stage,
      tags: JSON.stringify(item.tags ?? []),
      branch: item.branch ?? null,
      agent_type: item.agent_type ?? null,
      agent_provider: item.agent_provider ?? "claude",
      activity: item.activity ?? "idle",
      display_name: item.display_name ?? null,
      port_offset: item.port_offset ?? null,
      port_env: item.port_env ?? null,
      base_ref: item.base_ref ?? null,
    }));
  });

  const updatePipelineItemStageMock = vi.fn(async (_db: DbHandle, itemId: string, stage: string) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.stage = stage;
      item.updated_at = now;
    }
  });

  const updatePipelineItemActivityMock = vi.fn(async (_db: DbHandle, itemId: string, activity: PipelineItem["activity"]) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.activity = activity;
      item.activity_changed_at = now;
      item.updated_at = now;
    }
  });

  const clearPipelineItemStageResultMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.stage_result = null;
      item.updated_at = now;
    }
  });

  const updatePipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string, activePostAction: string) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.active_post_action = activePostAction;
      item.updated_at = now;
    }
  });

  const clearPipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.active_post_action = null;
      item.updated_at = now;
    }
  });

  const closePipelineItemMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.stage = "done";
      item.closed_at = now;
      item.updated_at = now;
    }
  });

  function reset(): void {
    repos = [makeRepo()];
    pipelineItems = [];
    pipelineDefinition = { name: "default", stages: [] };
    defaultBranchResponse = "main";
    currentBranchResponse = null;
    baseBranchResponse = ["origin/main", "main"];
    readEnvVarOverrides = {
      KANNA_DB_NAME: "kanna-wt-task-existing.db",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };
    repoConfig = {};
    repoConfigResolver = null;
    taskPorts = [];
    blockCleanupGate = null;
    failingCommands = {};
    invokeMock.mockClear();
    insertPipelineItemMock.mockClear();
    updatePipelineItemStageMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
    clearPipelineItemStageResultMock.mockClear();
    updatePipelineItemActivePostActionMock.mockClear();
    clearPipelineItemActivePostActionMock.mockClear();
    closePipelineItemMock.mockClear();
    listBlockersForItemMock.mockClear();
    listBlockedByItemMock.mockClear();
    setSettingMock.mockClear();
    updatePipelineItemTagsMock.mockClear();
    insertWorktreeMock.mockClear();
    upsertTerminalSessionMock.mockClear();
    listBlockersForItemMock.mockResolvedValue([]);
    listBlockedByItemMock.mockResolvedValue([]);
  }

  return {
    get repos() {
      return repos;
    },
    set repos(value: Repo[]) {
      repos = value;
    },
    get pipelineItems() {
      return pipelineItems;
    },
    set pipelineItems(value: PipelineItem[]) {
      pipelineItems = value;
    },
    get pipelineDefinition() {
      return pipelineDefinition;
    },
    set pipelineDefinition(value: PipelineDefinition) {
      pipelineDefinition = value;
    },
    get baseBranchResponse() {
      return baseBranchResponse;
    },
    set baseBranchResponse(value: string[] | Error) {
      baseBranchResponse = value;
    },
    get defaultBranchResponse() {
      return defaultBranchResponse;
    },
    set defaultBranchResponse(value: string) {
      defaultBranchResponse = value;
    },
    get currentBranchResponse() {
      return currentBranchResponse;
    },
    set currentBranchResponse(value: string | Error | null) {
      currentBranchResponse = value;
    },
    get readEnvVarOverrides() {
      return readEnvVarOverrides;
    },
    set readEnvVarOverrides(value: Record<string, string>) {
      readEnvVarOverrides = value;
    },
    get repoConfig() {
      return repoConfig;
    },
    set repoConfig(value: RepoConfig) {
      repoConfig = value;
    },
    get repoConfigResolver() {
      return repoConfigResolver;
    },
    set repoConfigResolver(value: ((path: string) => RepoConfig | undefined) | null) {
      repoConfigResolver = value;
    },
    get taskPorts() {
      return taskPorts;
    },
    set taskPorts(value: TaskPort[]) {
      taskPorts = value;
    },
    invokeMock,
    insertPipelineItemMock,
    updatePipelineItemStageMock,
    updatePipelineItemActivityMock,
    clearPipelineItemStageResultMock,
    updatePipelineItemActivePostActionMock,
    clearPipelineItemActivePostActionMock,
    closePipelineItemMock,
    makeItem,
    makeRepo,
    defer,
    listBlockersForItemMock,
    listBlockedByItemMock,
    setSettingMock,
    updatePipelineItemTagsMock,
    insertWorktreeMock,
    upsertTerminalSessionMock,
    get blockCleanupGate() {
      return blockCleanupGate;
    },
    set blockCleanupGate(value: Promise<void> | null) {
      blockCleanupGate = value;
    },
    get failingCommands() {
      return failingCommands;
    },
    set failingCommands(value: Record<string, string>) {
      failingCommands = value;
    },
    reset,
  };
});

vi.mock("../invoke", () => ({
  invoke: mockState.invokeMock,
}));

vi.mock("../tauri-mock", () => ({
  isTauri: false,
}));

vi.mock("../listen", () => ({
  listen: vi.fn(),
}));

vi.mock("@kanna/core", () => ({
  parseRepoConfig: vi.fn((json: string) => {
    const parsed = JSON.parse(json) as { __mockPath?: string };
    if (parsed.__mockPath && mockState.repoConfigResolver) {
      const resolved = mockState.repoConfigResolver(parsed.__mockPath);
      if (resolved) {
        return resolved;
      }
    }
    return mockState.repoConfig;
  }),
  parseAgentMd: vi.fn(() => null),
  DEFAULT_STAGE_ORDER: ["pr", "review", "in progress"],
}));

vi.mock("../../../../packages/core/src/pipeline/agent-loader", () => ({
  parseAgentDefinition: vi.fn(() => ({
    name: "agent",
    description: "agent",
    prompt: "Agent prompt",
  })),
}));

vi.mock("../../../../packages/core/src/pipeline/pipeline-loader", () => ({
  parsePipelineJson: vi.fn(() => mockState.pipelineDefinition),
}));

vi.mock("../../../../packages/core/src/pipeline/prompt-builder", () => ({
  buildStagePrompt: vi.fn(() => "Stage prompt"),
  buildKannaRuntimeSystemPrompt: vi.fn(() => "This session was launched by Kanna."),
  buildKannaRuntimeUserPrompt: vi.fn((prompt: string) => `This session was launched by Kanna.\n\n${prompt}`),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => ({
    error: toastErrorMock,
    warning: vi.fn(),
  }),
}));

vi.mock("../services/desktopCloudPublisher", () => ({
  publishDesktopTaskSnapshot: publishDesktopTaskSnapshotMock,
}));

vi.mock("../composables/terminalSessionRecovery", () => ({
  buildTaskShellCommand: vi.fn((agentCmd: string, _setupCmds: string[], options?: { agentCmdPreamble?: string }) => options?.agentCmdPreamble ?? agentCmd),
  getTaskTerminalEnv: vi.fn(() => ({})),
}));

vi.mock("../composables/terminalStateCache", () => ({
  clearCachedTerminalState: vi.fn(),
}));

vi.mock("./kannaCleanup", () => ({
  closePipelineItemAndClearCachedTerminalState: vi.fn(async (itemId: string, closePipelineItem: (itemId: string) => Promise<unknown>) => {
    if (mockState.blockCleanupGate) {
      await mockState.blockCleanupGate;
    }
    await closePipelineItem(itemId);
  }),
  isTeardownSessionId: vi.fn(() => false),
  reportCloseSessionError: vi.fn(),
  reportPrewarmSessionError: vi.fn(),
  shouldClearCachedTerminalStateOnSessionExit: vi.fn(() => false),
}));

vi.mock("./agent-provider", () => ({
  getPreferredAgentProviders: vi.fn((options: {
    explicit?: string | string[];
    stage?: string | string[];
    agent?: string | string[];
    item?: string;
  }) => options.explicit ?? options.stage ?? options.agent ?? options.item ?? "claude"),
  requireResolvedAgentProvider: vi.fn((provider?: string) => provider ?? "claude"),
  resolveAgentProvider: vi.fn((provider?: string | string[]) => Array.isArray(provider) ? provider[0] : (provider ?? "claude")),
}));

vi.mock("./taskCreationPlaceholder", () => ({
  buildPendingTaskPlaceholder: vi.fn((options: {
    id: string;
    repoId: string;
    prompt: string;
    branch: string;
    agentType: string;
    requestedAgentProviders?: string | string[];
    pipelineName?: string;
    stage?: string;
    displayName?: string | null;
  }) => mockState.makeItem({
    id: options.id,
    repo_id: options.repoId,
    prompt: options.prompt,
    branch: options.branch,
    agent_type: options.agentType,
    agent_provider: Array.isArray(options.requestedAgentProviders)
      ? (options.requestedAgentProviders[0] ?? "claude")
      : (options.requestedAgentProviders ?? "claude"),
    pipeline: options.pipelineName ?? "default",
    stage: options.stage ?? "in progress",
    activity: "working",
    display_name: options.displayName ?? null,
  })),
}));

vi.mock("./taskRuntimeStatus", () => ({
  shouldIgnoreRuntimeStatusDuringSetup: vi.fn(() => false),
}));

vi.mock("./portAllocationLog", () => ({
  formatTaskPortAllocationLog: vi.fn(() => ""),
}));

vi.mock("./taskShellPrewarm", () => ({
  shouldPrewarmTaskShellOnCreate: vi.fn(() => false),
}));

vi.mock("./agent-permissions", () => ({
  getAgentPermissionFlags: vi.fn(() => []),
}));

vi.mock("./db", () => ({
  resolveDbName: vi.fn(async () => "kanna-wt-task-existing.db"),
}));

vi.mock("./kannaCliEnv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kannaCliEnv")>();
  return {
    ...actual,
    buildKannaCliEnv: vi.fn(actual.buildKannaCliEnv),
    buildTaskRuntimeEnv: vi.fn(actual.buildTaskRuntimeEnv),
  };
});

vi.mock("../i18n", () => ({
  default: {
    global: {
      t: (key: string) => key,
    },
  },
}));

vi.mock("@kanna/db", () => ({
  listRepos: vi.fn(async () => mockState.repos),
  insertRepo: vi.fn(async () => {}),
  findRepoByPath: vi.fn(async () => null),
  hideRepo: vi.fn(async () => {}),
  unhideRepo: vi.fn(async () => {}),
  listPipelineItems: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.pipelineItems.filter((item) => item.repo_id === repoId)
  ),
  insertPipelineItem: mockState.insertPipelineItemMock,
  insertWorktree: mockState.insertWorktreeMock,
  upsertTerminalSession: mockState.upsertTerminalSessionMock,
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
  markPipelineItemTearingDown: vi.fn(async () => {}),
  updatePipelineItemStage: mockState.updatePipelineItemStageMock,
  updatePipelineItemTags: mockState.updatePipelineItemTagsMock,
  updatePipelineItemActivePostAction: mockState.updatePipelineItemActivePostActionMock,
  clearPipelineItemActivePostAction: mockState.clearPipelineItemActivePostActionMock,
  pinPipelineItem: vi.fn(async () => {}),
  unpinPipelineItem: vi.fn(async () => {}),
  reorderPinnedItems: vi.fn(async () => {}),
  updatePipelineItemDisplayName: vi.fn(async () => {}),
  clearPipelineItemStageResult: mockState.clearPipelineItemStageResultMock,
  closePipelineItem: mockState.closePipelineItemMock,
  reopenPipelineItem: vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = mockState.pipelineItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.closed_at = null;
    }
  }),
  getRepo: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.repos.find((repo) => repo.id === repoId) ?? null
  ),
  updateRepoRemoteMetadata: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  setSetting: mockState.setSettingMock,
  insertTaskBlocker: vi.fn(async () => {}),
  removeTaskBlocker: vi.fn(async () => {}),
  removeAllBlockersForItem: vi.fn(async () => {}),
  listBlockersForItem: mockState.listBlockersForItemMock,
  listBlockedByItem: mockState.listBlockedByItemMock,
  getUnblockedItems: vi.fn(async () => []),
  hasCircularDependency: vi.fn(async () => false),
  insertOperatorEvent: vi.fn(async () => {}),
  updateAgentSessionId: vi.fn(async () => {}),
  listTaskPorts: vi.fn(async () => [...mockState.taskPorts].sort((a, b) => a.port - b.port)),
  listTaskPortsForItem: vi.fn(async (_db: DbHandle, itemId: string) =>
    mockState.taskPorts
      .filter((taskPort) => taskPort.pipeline_item_id === itemId)
      .sort((a, b) => a.port - b.port)
  ),
  deleteTaskPortsForItem: vi.fn(async (_db: DbHandle, itemId: string) => {
    mockState.taskPorts = mockState.taskPorts.filter((taskPort) => taskPort.pipeline_item_id !== itemId);
  }),
}));

import { useKannaStore } from "./kanna";

function createDb(): DbHandle {
  return {
    execute: vi.fn(async (query: string, bindValues?: unknown[]) => {
      if (query.startsWith("INSERT OR IGNORE INTO task_port")) {
        const [port, pipelineItemId, envName] = bindValues as [number, string, string];
        if (!mockState.taskPorts.some((taskPort) => taskPort.port === port)) {
          mockState.taskPorts = [
            ...mockState.taskPorts,
            {
              port,
              pipeline_item_id: pipelineItemId,
              env_name: envName,
              created_at: mockState.makeItem().created_at,
            },
          ];
          return { rowsAffected: 1 };
        }
        return { rowsAffected: 0 };
      }

      if (query.startsWith("UPDATE pipeline_item SET port_offset = ?, port_env = ?, updated_at = datetime('now') WHERE id = ?")) {
        const [portOffset, portEnv, itemId] = bindValues as [number | null, string | null, string];
        const item = mockState.pipelineItems.find((candidate) => candidate.id === itemId);
        if (item) {
          item.port_offset = portOffset;
          item.port_env = portEnv;
        }
        return { rowsAffected: item ? 1 : 0 };
      }

      if (query.startsWith("DELETE FROM pipeline_item WHERE id = ?")) {
        const [itemId] = bindValues as [string];
        mockState.pipelineItems = mockState.pipelineItems.filter((candidate) => candidate.id !== itemId);
        return { rowsAffected: 1 };
      }

      return { rowsAffected: 1 };
    }),
    select: vi.fn(async <T>(query: string, bindValues?: unknown[]) => {
      if (query === "SELECT pipeline_item_id FROM task_port WHERE port = ?") {
        const [port] = bindValues as [number];
        const row = mockState.taskPorts.find((taskPort) => taskPort.port === port);
        return row ? [{ pipeline_item_id: row.pipeline_item_id }] as T[] : [];
      }

      if (query === "SELECT * FROM pipeline_item WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1") {
        const closed = [...mockState.pipelineItems]
          .filter((item) => item.closed_at !== null)
          .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
        return (closed[0] ? [closed[0]] : []) as T[];
      }

      return [];
    }),
  };
}

async function flushStore(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function createStore() {
  setActivePinia(createPinia());
  const store = useKannaStore();
  await store.init(createDb());
  await flushStore();
  return store;
}

describe("kanna store task base branch integration", () => {
  beforeEach(() => {
    mockState.reset();
    toastErrorMock.mockClear();
    publishDesktopTaskSnapshotMock.mockReset();
    publishDesktopTaskSnapshotMock.mockResolvedValue(undefined);
  });

  it("passes the repo default branch into the merge agent prompt", async () => {
    mockState.repos = [mockState.makeRepo({ default_branch: "dev" })];
    const store = await createStore();

    await store.mergeQueue();

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining("Default target branch for this merge run: dev"),
        stage: "in progress",
      }),
    );
  });

  it("persists an explicit baseBranch into base_ref and uses it as the worktree start point from repo root", async () => {
    mockState.baseBranchResponse = ["feature/task-base-branch", "origin/main", "main"];
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship explicit base branch", "agent", {
      baseBranch: "feature/task-base-branch",
      agentProvider: "claude",
    });

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        base_ref: "feature/task-base-branch",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "feature/task-base-branch",
        }),
      );
    });
  });

  it("prefers origin/default for base_ref when no explicit base branch is provided and the remote ref exists", async () => {
    mockState.baseBranchResponse = ["feature/x", "main", "origin/main"];
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship default branch task", "agent", {
      agentProvider: "claude",
    });

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        base_ref: "origin/main",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith("git_fetch", {
        repoPath: "/tmp/repo",
        branch: "main",
      });
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "origin/main",
        }),
      );
    });

    const gitFetchCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "git_fetch");
    const gitWorktreeAddCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "git_worktree_add");

    expect(gitFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(gitWorktreeAddCallIndex).toBeGreaterThan(gitFetchCallIndex);
    expect(
      mockState.invokeMock.mock.calls.some(([command, args]) =>
        command === "git_worktree_add" &&
        typeof args === "object" &&
        args !== null &&
        "startPoint" in args &&
        (args as { startPoint?: unknown }).startPoint === "main"
      ),
    ).toBe(false);
  });

  it("shows a toast when cloud task snapshot publish fails after local task creation", async () => {
    publishDesktopTaskSnapshotMock.mockRejectedValue(
      Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }),
    );
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship cloud-visible task", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Cloud publish failed: permission-denied");
    });
  });

  it("prefers origin/dev for the dev default branch and uses that remote ref as the worktree start point", async () => {
    mockState.defaultBranchResponse = "dev";
    mockState.baseBranchResponse = ["feature/x", "dev", "origin/dev"];
    mockState.repos = [mockState.makeRepo({ default_branch: "dev" })];
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship dev default branch task", "agent", {
      agentProvider: "claude",
    });

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        base_ref: "origin/dev",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "origin/dev",
        }),
      );
    });
  });

  it("fetches an explicitly selected origin base branch before creating the worktree", async () => {
    mockState.defaultBranchResponse = "dev";
    mockState.baseBranchResponse = ["dev", "origin/dev"];
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship explicit remote base branch task", "agent", {
      baseBranch: "origin/dev",
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith("git_fetch", {
        repoPath: "/tmp/repo",
        branch: "dev",
      });
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "origin/dev",
        }),
      );
    });

    const gitFetchCallIndex = mockState.invokeMock.mock.calls.findIndex(([command, args]) =>
      command === "git_fetch" &&
      typeof args === "object" &&
      args !== null &&
      "branch" in args &&
      (args as { branch?: unknown }).branch === "dev"
    );
    const gitWorktreeAddCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "git_worktree_add");

    expect(gitFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(gitWorktreeAddCallIndex).toBeGreaterThan(gitFetchCallIndex);
  });

  it("does not create a task when base branch enumeration fails", async () => {
    mockState.baseBranchResponse = new Error("git_list_base_branches failed");
    const store = await createStore();

    await expect(store.createItem("repo-1", "/tmp/repo", "Ship fallback task", "agent", {
      agentProvider: "claude",
    })).rejects.toThrow("No valid base branch");

    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
  });

  it("does not create a task when no verified default base branch exists", async () => {
    mockState.baseBranchResponse = ["feature/x"];
    const store = await createStore();

    await expect(store.createItem("repo-1", "/tmp/repo", "Ship missing base task", "agent", {
      agentProvider: "claude",
    })).rejects.toThrow("No valid base branch");

    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
  });

  it("reserves every configured base port for the default branch and starts worktrees at the next offset", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship reserved ports", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem?.port_offset).toBe(1421);
      expect(createdItem?.port_env).toBe(JSON.stringify({
        KANNA_DEV_PORT: "1421",
        API_PORT: "3001",
      }));
      expect(mockState.taskPorts.map((taskPort) => `${taskPort.env_name}:${taskPort.port}`)).toEqual([
        "KANNA_DEV_PORT:1421",
        "API_PORT:3001",
      ]);
    });
  });

  it("claims task ports from the checked-out worktree config instead of the repo root config", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
      },
    };
    mockState.repoConfigResolver = (path: string) => {
      if (path.includes("/.kanna-worktrees/")) {
        return {
          ports: {
            KANNA_DEV_PORT: 1420,
            KANNA_TRANSFER_PORT: 4455,
          },
        };
      }
      return undefined;
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship worktree-scoped ports", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem?.port_offset).toBe(1421);
      expect(createdItem?.port_env).toBe(JSON.stringify({
        KANNA_DEV_PORT: "1421",
        KANNA_TRANSFER_PORT: "4456",
      }));
      expect(mockState.taskPorts.map((taskPort) => `${taskPort.env_name}:${taskPort.port}`)).toEqual([
        "KANNA_DEV_PORT:1421",
        "KANNA_TRANSFER_PORT:4456",
      ]);
    });
  });

  it("assigns later worktrees the next free offset above the reserved default-branch port", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "First task", "agent", {
      agentProvider: "claude",
    });
    await store.createItem("repo-1", "/tmp/repo", "Second task", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const secondItem = mockState.pipelineItems.at(-1);
      expect(secondItem?.port_offset).toBe(1422);
      expect(secondItem?.port_env).toBe(JSON.stringify({
        KANNA_DEV_PORT: "1422",
        API_PORT: "3002",
      }));
    });
  });

  it("passes task-scoped port and kanna-cli env to agent sessions", async () => {
    mockState.readEnvVarOverrides = {
      ...mockState.readEnvVarOverrides,
      PATH: "/usr/local/bin:/bin",
    };
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship agent env", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem).toBeTruthy();
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({
          sessionId: createdItem?.id,
          prompt: "Ship agent env",
          systemPrompt: expect.stringContaining("This session was launched by Kanna."),
          env: expect.objectContaining({
            KANNA_WORKTREE: "1",
            KANNA_DEV_PORT: "1421",
            API_PORT: "3001",
            KANNA_CLI_PATH: "/usr/bin/kanna-cli",
            PATH: "/usr/bin:/usr/local/bin:/bin",
            KANNA_TASK_ID: createdItem?.id,
            KANNA_CLI_DB_PATH: "/tmp/kanna/kanna-wt-task-existing.db",
            KANNA_SOCKET_PATH: "/tmp/kanna.sock",
          }),
        }),
      );
    });
    const createAgentCall = mockState.invokeMock.mock.calls.find(([command]) => command === "spawn_agent_session");
    const env = createAgentCall?.[1]?.env as Record<string, string> | undefined;
    expect(env).not.toHaveProperty("KANNA_SERVER_BASE_URL");
  });

  it("runs repo setup scripts before spawning SDK agent sessions", async () => {
    mockState.readEnvVarOverrides = {
      ...mockState.readEnvVarOverrides,
      PATH: "/usr/local/bin:/bin",
    };
    mockState.repoConfig = {
      setup: ["pnpm install --frozen-lockfile"],
      ports: {
        KANNA_DEV_PORT: 1420,
      },
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship SDK setup", "agent", {
      agentProvider: "claude",
    });

    let createdItem: PipelineItem | undefined;
    await vi.waitFor(() => {
      createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem).toBeTruthy();
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "run_script",
        expect.objectContaining({
          script: "pnpm install --frozen-lockfile",
          cwd: `/tmp/repo/.kanna-worktrees/task-${createdItem?.id}`,
          env: expect.objectContaining({
            KANNA_WORKTREE: "1",
            KANNA_DEV_PORT: "1421",
            KANNA_CLI_PATH: "/usr/bin/kanna-cli",
            PATH: "/usr/bin:/usr/local/bin:/bin",
            KANNA_TASK_ID: createdItem?.id,
            KANNA_CLI_DB_PATH: "/tmp/kanna/kanna-wt-task-existing.db",
            KANNA_SOCKET_PATH: "/tmp/kanna.sock",
          }),
        }),
      );
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({ sessionId: createdItem?.id }),
      );
    });

    const runScriptCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "run_script");
    const spawnAgentCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "spawn_agent_session");
    expect(runScriptCallIndex).toBeGreaterThanOrEqual(0);
    expect(spawnAgentCallIndex).toBeGreaterThan(runScriptCallIndex);
  });

  it("passes a non-default app mobile server URL to agent sessions", async () => {
    mockState.readEnvVarOverrides = {
      ...mockState.readEnvVarOverrides,
      KANNA_MOBILE_SERVER_PORT: "48129",
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship dev server env", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem).toBeTruthy();
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({
          sessionId: createdItem?.id,
          env: expect.objectContaining({
            KANNA_SERVER_BASE_URL: "http://127.0.0.1:48129",
          }),
        }),
      );
    });
  });

  it("passes workspace env and PATH updates to agent sessions", async () => {
    mockState.repoConfigResolver = (path: string) => {
      if (path.includes("/.kanna-worktrees/") && path.endsWith("/.kanna/config.json")) {
        return {
          workspace: {
            env: {
              FOO: "bar",
            },
            path: {
              prepend: ["./bin"],
              append: ["vendor/tools"],
            },
          },
        };
      }
      return undefined;
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship agent env", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.pipelineItems.at(-1);
      expect(createdItem).toBeTruthy();
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({
          env: expect.objectContaining({
            FOO: "bar",
            PATH: `/usr/bin:/tmp/repo/.kanna-worktrees/task-${createdItem?.id}/bin:/usr/local/bin:/bin:/tmp/repo/.kanna-worktrees/task-${createdItem?.id}/vendor/tools`,
          }),
        }),
      );
    });
  });

  it("removes a partially-created task when headless agent spawn fails", async () => {
    mockState.failingCommands = {
      spawn_agent_session: "daemon unavailable",
    };
    const store = await createStore();

    const taskId = await store.createItem("repo-1", "/tmp/repo", "Spawn failure cleanup", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({ sessionId: taskId }),
      );
      expect(mockState.pipelineItems.some((item) => item.id === taskId)).toBe(false);
    });
    expect(mockState.upsertTerminalSessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pipeline_item_id: taskId }),
    );
  });

  it("persists worktree and agent terminal session mappings for created PTY tasks", async () => {
    const store = await createStore();

    const taskId = await store.createItem("repo-1", "/tmp/repo", "Ship mobile terminal streaming", "pty", {
      agentProvider: "codex",
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({ sessionId: taskId }),
      );
    });

    const worktreePath = `/tmp/repo/.kanna-worktrees/task-${taskId}`;
    expect(mockState.insertWorktreeMock).toHaveBeenCalledWith(expect.anything(), {
      id: `wt-${taskId}`,
      pipeline_item_id: taskId,
      path: worktreePath,
      branch: `task-${taskId}`,
    });
    expect(mockState.upsertTerminalSessionMock).toHaveBeenCalledWith(expect.anything(), {
      id: `agent-${taskId}`,
      repo_id: "repo-1",
      pipeline_item_id: taskId,
      label: "agent",
      cwd: worktreePath,
      daemon_session_id: taskId,
    });
  });

  it("passes workspace env and PATH updates to PTY task sessions", async () => {
    mockState.repoConfigResolver = (path: string) => {
      if (path === "/tmp/repo/.kanna-worktrees/task-pty-env/.kanna/config.json") {
        return {
          workspace: {
            env: {
              FOO: "bar",
            },
            path: {
              prepend: ["./bin"],
              append: ["vendor/tools"],
            },
          },
        };
      }
      return undefined;
    };
    const store = await createStore();

    await store.spawnPtySession(
      "task-pty-env",
      "/tmp/repo/.kanna-worktrees/task-pty-env",
      "Ship PTY env",
      80,
      24,
      {
        agentProvider: "claude",
        worktreePath: "/tmp/repo/.kanna-worktrees/task-pty-env",
      },
    );

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        cwd: "/tmp/repo/.kanna-worktrees/task-pty-env",
        env: expect.objectContaining({
          FOO: "bar",
          PATH: "/usr/bin:/tmp/repo/.kanna-worktrees/task-pty-env/bin:/usr/local/bin:/bin:/tmp/repo/.kanna-worktrees/task-pty-env/vendor/tools",
          KANNA_WORKTREE: "1",
          KANNA_CLI_PATH: "/usr/bin/kanna-cli",
        }),
      }),
    );
    const spawnCall = mockState.invokeMock.mock.calls.find(([command]) => command === "spawn_session");
    expect(spawnCall?.[1]?.args?.join(" ")).toContain("--append-system-prompt");
    expect(spawnCall?.[1]?.args?.join(" ")).toContain("This session was launched by Kanna.");
    expect(spawnCall?.[1]?.args?.join(" ")).not.toContain("Ship PTY env\\n\\nThis session was launched by Kanna.");
    const env = spawnCall?.[1]?.env as Record<string, string> | undefined;
    expect(env).not.toHaveProperty("KANNA_SERVER_BASE_URL");
  });

  it("uses the real E2E override for PTY task provider and model when no explicit choice is supplied", async () => {
    mockState.readEnvVarOverrides = {
      KANNA_DB_NAME: "kanna-wt-task-existing.db",
      KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Use cheap real e2e agent", "pty");

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agent_provider: "codex",
        prompt: "Use cheap real e2e agent",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({
          agentProvider: "codex",
          args: expect.arrayContaining([
            expect.stringContaining("codex -m gpt-5.4-mini"),
            expect.stringContaining("This session was launched by Kanna."),
            expect.stringContaining("Use cheap real e2e agent"),
          ]),
        }),
      );
    });
  });

  it("forces the real E2E PTY provider override even when the UI supplied one", async () => {
    mockState.readEnvVarOverrides = {
      KANNA_DB_NAME: "kanna-wt-task-existing.db",
      KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Respect explicit provider", "pty", {
      agentProvider: "copilot",
    });

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agent_provider: "codex",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({
          agentProvider: "codex",
          args: expect.arrayContaining([
            expect.stringContaining("codex -m gpt-5.4-mini"),
          ]),
        }),
      );
    });
  });

  it("clears pending setup before selecting a spawned PTY task so setup output is visible", async () => {
    const selectionGate = mockState.defer();
    const store = await createStore();
    store.attachWindowWorkspace({
      bootstrap: { windowId: "test-window", selectedRepoId: null, selectedItemId: null },
      loadSnapshot: vi.fn(async () => ({ windows: [] })),
      saveSnapshot: vi.fn(async () => {}),
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      forgetCurrentWindow: vi.fn(async () => {}),
      persistSelection: vi.fn(async () => selectionGate.promise),
      persistSidebarHidden: vi.fn(async () => {}),
      persistSidebarWidth: vi.fn(async () => {}),
      invalidateSharedData: vi.fn(async () => {}),
      restoreAdditionalWindows: vi.fn(async () => {}),
      onSharedInvalidation: vi.fn(async () => vi.fn()),
    });

    await store.createItem("repo-1", "/tmp/repo", "Show setup output", "pty", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({
          agentProvider: "claude",
        }),
      );
      expect(store.selectedItemId).toMatch(/^[0-9a-f-]+$/);
    });

    expect(store.pendingSetupIds).not.toContain(store.selectedItemId);
    selectionGate.resolve();
  });

  it("keeps a custom task PTY provider ahead of the real E2E override", async () => {
    mockState.readEnvVarOverrides = {
      KANNA_DB_NAME: "kanna-wt-task-existing.db",
      KANNA_E2E_REAL_AGENT_PROVIDER: "codex",
      KANNA_E2E_REAL_AGENT_MODEL: "gpt-5.4-mini",
    };
    const store = await createStore();
    const customTask: CustomTaskConfig = {
      name: "Synthetic PTY",
      prompt: "Synthetic PTY",
      executionMode: "pty",
      agentProvider: "copilot",
      setup: ["echo synthetic"],
    };

    await store.createItem("repo-1", "/tmp/repo", "Respect custom provider", "pty", {
      customTask,
    });

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agent_provider: "copilot",
      }),
    );

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({
          agentProvider: "copilot",
          args: expect.arrayContaining([
            expect.stringContaining("copilot"),
          ]),
        }),
      );
    });
  });

  it("passes task-scoped port and kanna-cli env to rerun stage setup scripts", async () => {
    mockState.readEnvVarOverrides = {
      ...mockState.readEnvVarOverrides,
      PATH: "/usr/local/bin:/bin",
    };
    mockState.pipelineDefinition = {
      name: "default",
      environments: {
        dev: {
          setup: ["echo setup"],
        },
      },
      stages: [
        { name: "in progress", environment: "dev" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-existing",
        branch: "task-existing",
        stage: "in progress",
        port_env: JSON.stringify({
          KANNA_DEV_PORT: "1421",
          API_PORT: "3001",
        }),
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.rerunStage("item-existing");

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "run_script",
      expect.objectContaining({
        cwd: "/tmp/repo/.kanna-worktrees/task-existing",
        env: expect.objectContaining({
          KANNA_WORKTREE: "1",
          KANNA_DEV_PORT: "1421",
          API_PORT: "3001",
          KANNA_CLI_PATH: "/usr/bin/kanna-cli",
          PATH: "/usr/bin:/usr/local/bin:/bin",
          KANNA_TASK_ID: "item-existing",
          KANNA_CLI_DB_PATH: "/tmp/kanna/kanna-wt-task-existing.db",
          KANNA_SOCKET_PATH: "/tmp/kanna.sock",
        }),
      }),
    );
    const runScriptCall = mockState.invokeMock.mock.calls.find(([command]) => command === "run_script");
    const env = runScriptCall?.[1]?.env as Record<string, string> | undefined;
    expect(env).not.toHaveProperty("KANNA_SERVER_BASE_URL");
  });

  it("assigns ports freshly on undo close instead of restoring the task's previous assignment", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-closed",
        branch: "task-closed",
        closed_at: "2026-04-14T12:00:00.000Z",
        port_offset: 1422,
        port_env: JSON.stringify({
          KANNA_DEV_PORT: "1422",
          API_PORT: "3002",
        }),
      }),
    ];
    const store = await createStore();

    await store.undoClose();

    const reopenedItem = mockState.pipelineItems[0];
    expect(reopenedItem.closed_at).toBeNull();
    expect(reopenedItem.port_offset).toBe(1421);
    expect(reopenedItem.port_env).toBe(JSON.stringify({
      KANNA_DEV_PORT: "1421",
      API_PORT: "3001",
    }));
    expect(mockState.taskPorts.map((taskPort) => `${taskPort.env_name}:${taskPort.port}`)).toEqual([
      "KANNA_DEV_PORT:1421",
      "API_PORT:3001",
    ]);
  });

  it("reclaims ports on undo close from the task worktree config instead of the repo root config", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
      },
    };
    mockState.repoConfigResolver = (path: string) => {
      if (path === "/tmp/repo/.kanna-worktrees/task-closed/.kanna/config.json") {
        return {
          ports: {
            KANNA_DEV_PORT: 1420,
            KANNA_TRANSFER_PORT: 4455,
          },
        };
      }
      return undefined;
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-closed",
        branch: "task-closed",
        closed_at: "2026-04-14T12:00:00.000Z",
        port_offset: 1422,
        port_env: JSON.stringify({
          KANNA_DEV_PORT: "1422",
        }),
      }),
    ];
    const store = await createStore();

    await store.undoClose();

    const reopenedItem = mockState.pipelineItems[0];
    expect(reopenedItem.closed_at).toBeNull();
    expect(reopenedItem.port_offset).toBe(1421);
    expect(reopenedItem.port_env).toBe(JSON.stringify({
      KANNA_DEV_PORT: "1421",
      KANNA_TRANSFER_PORT: "4456",
    }));
    expect(mockState.taskPorts.map((taskPort) => `${taskPort.env_name}:${taskPort.port}`)).toEqual([
      "KANNA_DEV_PORT:1421",
      "KANNA_TRANSFER_PORT:4456",
    ]);
  });

  it("passes workspace env and PATH updates to worktree shell sessions", async () => {
    mockState.repoConfigResolver = (path: string) => {
      if (path === "/tmp/repo/.kanna-worktrees/task-shell/.kanna/config.json") {
        return {
          workspace: {
            env: {
              FOO: "bar",
            },
            path: {
              prepend: ["./bin"],
              append: ["vendor/tools"],
            },
          },
        };
      }
      return undefined;
    };
    const store = await createStore();

    await store.spawnShellSession(
      "shell-task-shell",
      "/tmp/repo/.kanna-worktrees/task-shell",
      JSON.stringify({
        KANNA_DEV_PORT: "1421",
      }),
      true,
      "/tmp/repo",
    );

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        cwd: "/tmp/repo/.kanna-worktrees/task-shell",
        args: [ "--login" ],
        env: expect.objectContaining({
          TERM: "xterm-256color",
          ZDOTDIR: "/tmp/kanna-zdotdir",
          KANNA_WORKTREE: "1",
          KANNA_DEV_PORT: "1421",
          KANNA_CLI_PATH: "/usr/bin/kanna-cli",
          FOO: "bar",
          PATH: "/usr/bin:/tmp/repo/.kanna-worktrees/task-shell/bin:/usr/local/bin:/bin:/tmp/repo/.kanna-worktrees/task-shell/vendor/tools",
        }),
      }),
    );
  });

  it("reuses the saved prompt when respawning a reopened PTY task", async () => {
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-closed",
        branch: "task-closed",
        prompt: "continue e3d1fc75",
        closed_at: "2026-04-14T12:00:00.000Z",
        agent_type: "pty",
        agent_provider: "codex",
      }),
    ];
    const store = await createStore();

    vi.useFakeTimers();
    try {
      const undoClose = store.undoClose();
      await vi.advanceTimersByTimeAsync(6_000);
      await undoClose;
    } finally {
      vi.useRealTimers();
    }

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: "item-closed",
        cwd: "/tmp/repo/.kanna-worktrees/task-closed",
        agentProvider: "codex",
        args: expect.arrayContaining([
          expect.stringContaining("continue e3d1fc75"),
        ]),
      }),
    );
  });

  it("advances stages using the previous task branch as the next worktree start point", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-existing",
        branch: "task-existing-branch",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.advanceStage("item-existing");

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "task-existing-branch",
        }),
      );
    });
  });

  it("does not advance a closed task even when its stage is still active", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "review", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-closed-review",
        branch: "task-closed-review",
        stage: "review",
        closed_at: "2026-06-03 00:02:25",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.advanceStage("item-closed-review");

    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "git_worktree_add",
      expect.anything(),
    );
    expect(mockState.pipelineItems[0]?.stage).toBe("review");
    expect(mockState.pipelineItems[0]?.closed_at).toBe("2026-06-03 00:02:25");
  });

  it("preserves the original base ref while advancing stages from the source branch", async () => {
    mockState.pipelineDefinition = {
      name: "qa",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual", agent: "review" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-existing",
        branch: "task-existing-branch",
        base_ref: "origin/main",
        pipeline: "qa",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.advanceStage("item-existing");

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "task-existing-branch",
        }),
      );
      expect(mockState.pipelineItems.some(
        (item) => item.stage === "review" && item.base_ref === "origin/main",
      )).toBe(true);
    });
    expect(buildStagePrompt).toHaveBeenCalledWith(
      "Agent prompt",
      undefined,
      expect.objectContaining({
        branch: "task-existing-branch",
        baseRef: "origin/main",
      }),
    );
  });

  it("advances stages from the branch currently checked out in the source worktree", async () => {
    mockState.currentBranchResponse = "renamed/source-branch";
    mockState.pipelineDefinition = {
      name: "qa",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual", agent: "review" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-existing",
        branch: "task-stale-branch",
        base_ref: "origin/dev",
        pipeline: "qa",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.advanceStage("item-existing");

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_current_branch",
        { repoPath: "/tmp/repo/.kanna-worktrees/task-stale-branch" },
      );
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({
          repoPath: "/tmp/repo",
          startPoint: "renamed/source-branch",
        }),
      );
      expect(mockState.pipelineItems.some(
        (item) => item.stage === "review" && item.base_ref === "origin/dev",
      )).toBe(true);
    });
    expect(buildStagePrompt).toHaveBeenCalledWith(
      "Agent prompt",
      undefined,
      expect.objectContaining({
        branch: "renamed/source-branch",
        baseRef: "origin/dev",
        sourceWorktree: "/tmp/repo/.kanna-worktrees/task-stale-branch",
      }),
    );
  });

  it("detaches the source task terminal before killing it during stage advance", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");

    const detachIndex = mockState.invokeMock.mock.calls.findIndex(
      ([command, args]) => command === "detach_session" && args?.sessionId === "item-source",
    );
    const killIndex = mockState.invokeMock.mock.calls.findIndex(
      ([command, args]) => command === "kill_session" && args?.sessionId === "item-source",
    );

    expect(detachIndex).toBeGreaterThanOrEqual(0);
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(detachIndex).toBeLessThan(killIndex);
  });

  it("keeps selection on the next visible item when the destination stage sets follow_task to false", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual", follow_task: false },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        created_at: "2026-04-14T00:02:00.000Z",
        updated_at: "2026-04-14T00:02:00.000Z",
      }),
      mockState.makeItem({
        id: "item-next",
        branch: "task-next",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");
    let createdPrItem: PipelineItem | undefined;
    await vi.waitFor(() => {
      createdPrItem = mockState.pipelineItems.find((item) => item.stage === "pr" && item.id !== "item-source");
      expect(createdPrItem).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({ sessionId: createdPrItem?.id }),
      );
    });

    expect(store.selectedItemId).toBe("item-next");
  });

  it("selects the next visible item before closing the promoted task", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        created_at: "2026-04-14T00:02:00.000Z",
        updated_at: "2026-04-14T00:02:00.000Z",
      }),
      mockState.makeItem({
        id: "item-next",
        branch: "task-next",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    const persistSelection = vi.fn(async () => {});
    store.attachWindowWorkspace({
      bootstrap: {
        windowId: "main",
        selectedRepoId: null,
        selectedItemId: null,
      },
      loadSnapshot: vi.fn(async () => ({ windows: [] })),
      saveSnapshot: vi.fn(async () => {}),
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      forgetCurrentWindow: vi.fn(async () => {}),
      persistSelection,
      persistSidebarHidden: vi.fn(async () => {}),
      persistSidebarWidth: vi.fn(async () => {}),
      invalidateSharedData: vi.fn(async () => {}),
      restoreAdditionalWindows: vi.fn(async () => {}),
      onSharedInvalidation: vi.fn(async () => vi.fn()),
    });
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");

    const selectNextOrder = persistSelection.mock.calls.findIndex(
      ([selection]) => selection.selectedItemId === "item-next",
    );
    const selectNextInvocationOrder = persistSelection.mock.invocationCallOrder[selectNextOrder];
    const closeInvocationOrder = mockState.closePipelineItemMock.mock.invocationCallOrder[0];

    expect(selectNextOrder).toBeGreaterThanOrEqual(0);
    expect(selectNextInvocationOrder).toBeLessThan(closeInvocationOrder);
  });

  it("still follows the spawned task when follow_task is omitted", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
      mockState.makeItem({
        id: "item-next",
        branch: "task-next",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");

    await vi.waitFor(() => {
      expect(
        mockState.pipelineItems.some((item) => item.id === store.selectedItemId && item.stage === "review"),
      ).toBe(true);
    });
  });

  it("keeps automatic next-stage tasks in the background when follow_task is omitted", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "auto" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        created_at: "2026-04-14T00:02:00.000Z",
        updated_at: "2026-04-14T00:02:00.000Z",
      }),
      mockState.makeItem({
        id: "item-active",
        branch: "task-active",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-active");
    await flushStore();

    await store.advanceStage("item-source", { initiatedBy: "auto" });

    let createdReviewItem: PipelineItem | undefined;
    await vi.waitFor(() => {
      createdReviewItem = mockState.pipelineItems.find((item) => item.id !== "item-source" && item.stage === "review");
      expect(createdReviewItem).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({ sessionId: createdReviewItem?.id }),
      );
    });
    expect(store.selectedItemId).toBe("item-active");
  });

  it("lets automatic next-stage tasks opt into focus with follow_task true", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "auto", follow_task: true },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
      mockState.makeItem({
        id: "item-active",
        branch: "task-active",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-active");
    await flushStore();

    await store.advanceStage("item-source", { initiatedBy: "auto" });

    await vi.waitFor(() => {
      expect(
        mockState.pipelineItems.some((item) => item.id === store.selectedItemId && item.stage === "review"),
      ).toBe(true);
    });
  });

  it("leaves selection unset when follow_task is false and there is no next visible item", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual", follow_task: false },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");
    await flushStore();

    expect(store.selectedItemId).toBeNull();
  });

  it("closes the task when advancing from the final pipeline stage", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-pr",
        branch: "task-pr",
        stage: "pr",
        created_at: "2026-04-14T00:02:00.000Z",
        updated_at: "2026-04-14T00:02:00.000Z",
      }),
      mockState.makeItem({
        id: "item-next",
        branch: "task-next",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-pr");
    await flushStore();

    await store.advanceStage("item-pr");
    await flushStore();

    const prItem = mockState.pipelineItems.find((item) => item.id === "item-pr");
    expect(mockState.closePipelineItemMock).toHaveBeenCalledWith(expect.anything(), "item-pr");
    expect(prItem?.stage).toBe("done");
    expect(prItem?.closed_at).not.toBeNull();
    expect(store.selectedItemId).toBe("item-next");
  });

  it("passes the source worktree path into the PR stage prompt context", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual", follow_task: false, agent: "pr" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await flushStore();

    await store.advanceStage("item-source");

    expect(buildStagePrompt).toHaveBeenCalledWith(
      "Agent prompt",
      undefined,
      expect.objectContaining({
        taskPrompt: "Ship it",
        branch: "task-source",
        sourceWorktree: "/tmp/repo/.kanna-worktrees/task-source",
      }),
    );
  });

  it("keeps the source task title when creating a generated next-stage prompt", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "qa", transition: "manual", agent: "qa" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        prompt: "Fix sidebar task ordering",
        display_name: null,
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: "Stage prompt",
        stage: "qa",
        display_name: "Fix sidebar task ordering",
      }),
    );
  });

  it("preserves SDK agent execution when advancing a GUI agent task", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "qa", transition: "manual", agent: "qa" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        agent_type: "agent",
        agent_provider: "claude",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    let createdQaItem: PipelineItem | undefined;
    await vi.waitFor(() => {
      createdQaItem = mockState.pipelineItems.find((item) => item.id !== "item-source" && item.stage === "qa");
      expect(createdQaItem).toBeDefined();
      expect(createdQaItem?.agent_type).toBe("agent");
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({
          sessionId: createdQaItem?.id,
          prompt: "Stage prompt",
          agentProvider: "claude",
        }),
      );
    });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({ sessionId: createdQaItem?.id }),
    );
  });

  it("starts a stage post-action without changing the task stage", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: {
            name: "commit",
            transition: "auto",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
        agent_provider: "codex",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemActivePostActionMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.updatePipelineItemStageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.pipelineItems[0].stage).toBe("in progress");
    expect(mockState.closePipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.clearPipelineItemStageResultMock).toHaveBeenCalledWith(expect.anything(), "item-source");
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("Stage prompt")),
    });
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  });

  it("submits continue-mode prompts to Codex with the terminal Enter sequence", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        agent_provider: "codex",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("Stage prompt")),
    });
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  });

  it("relaunches Codex continue-mode stages when the previous TUI has exited", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        agent_type: "agent",
        agent_provider: "codex",
        agent_session_id: "019d9a8c-9f39-7240-818f-88367a7c31df",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemStageMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: "item-source",
        cwd: "/tmp/repo/.kanna-worktrees/task-source",
        args: expect.arrayContaining([
          expect.stringContaining("codex resume"),
          expect.stringContaining("019d9a8c-9f39-7240-818f-88367a7c31df"),
          expect.stringContaining("Stage prompt"),
        ]),
      }),
    );
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\r")),
    });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  }, 10_000);

  it("skips the post-action and advances to the next real stage when requested", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: { name: "commit", transition: "auto", agent: "commit" },
        },
        { name: "pr", transition: "manual", agent: "pr" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "committed" }),
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source", { initiatedBy: "auto", skipPostAction: true });

    expect(mockState.updatePipelineItemActivePostActionMock).not.toHaveBeenCalled();
    expect(mockState.closePipelineItemMock).toHaveBeenCalledWith(expect.anything(), "item-source");
    expect(mockState.insertPipelineItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stage: "pr", prompt: "Stage prompt" }),
    );
  });

  it("continues the same task and sends the next stage prompt when stage mode is continue", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit", prompt: "Commit $TASK_PROMPT" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
        agent_provider: "codex",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemStageMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.closePipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "git_worktree_add",
      expect.anything(),
    );
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("Stage prompt")),
    });
    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[13u")),
    });
  });

  it("submits continue-mode prompts to Claude with carriage return", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        agent_provider: "claude",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[200~Stage prompt\x1b[201~\r")),
    });
  });

  it("submits continue-mode prompts to Copilot with carriage return", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        agent_provider: "copilot",
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    expect(mockState.invokeMock).toHaveBeenCalledWith("send_input", {
      sessionId: "item-source",
      data: Array.from(new TextEncoder().encode("\x1b[200~Stage prompt\x1b[201~\r")),
    });
  });

  it("refreshes an edited repo pipeline definition before advancing stages", async () => {
    mockState.pipelineDefinition = {
      name: "qa",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "auto", agent: "review" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        pipeline: "qa",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
      }),
    ];

    const store = await createStore();
    await store.loadPipeline("/tmp/repo", "qa");

    mockState.pipelineDefinition = {
      name: "qa",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
        { name: "review", transition: "auto", agent: "review" },
      ],
    };

    await store.advanceStage("item-source");

    expect(mockState.updatePipelineItemStageMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
      "commit",
    );
    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stage: "review" }),
    );
  });

  it("clears stale stage result before sending a continue stage prompt", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "commit", transition: "auto", mode: "continue", agent: "commit" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        stage_result: JSON.stringify({ status: "success", summary: "implemented" }),
      }),
    ];

    const store = await createStore();

    await store.advanceStage("item-source");

    const clearCallOrder = mockState.clearPipelineItemStageResultMock.mock.invocationCallOrder[0];
    const sendInputCallIndex = mockState.invokeMock.mock.calls.findIndex(([command]) => command === "send_input");
    const sendInputOrder = mockState.invokeMock.mock.invocationCallOrder[sendInputCallIndex];

    expect(mockState.clearPipelineItemStageResultMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-source",
    );
    expect(clearCallOrder).toBeLessThan(sendInputOrder);
  });

  it("reruns the active post-action prompt instead of the parent stage prompt", async () => {
    mockState.pipelineDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          agent: "implement",
          prompt: "Implement $TASK_PROMPT",
          post_action: {
            name: "commit",
            transition: "auto",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        active_post_action: "commit",
      }),
    ];

    const store = await createStore();

    await store.rerunStage("item-source");

    expect(buildStagePrompt).toHaveBeenCalledWith(
      "Agent prompt",
      "Commit $TASK_PROMPT",
      expect.objectContaining({ taskPrompt: "Ship it" }),
    );
  });

  it("does not auto-select a created task when selectOnCreate is false", async () => {
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-active",
        branch: "task-item-active",
        prompt: "Keep me selected",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-active");
    await flushStore();

    await store.createItem("repo-1", "/tmp/repo", "Spawn without follow", "agent", {
      agentProvider: "claude",
      selectOnCreate: false,
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({ prompt: "Spawn without follow" }),
      );
    });

    expect(store.selectedItemId).toBe("item-active");
  });

  it("marks the current task blocked in place without killing its live session", async () => {
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-active",
        branch: "task-item-active",
        agent_session_id: "claude-item-active",
        prompt: "Investigate sidebar lag",
        display_name: "Sidebar lag",
      }),
      mockState.makeItem({
        id: "item-blocker",
        branch: "task-item-blocker",
        prompt: "Finish upstream dependency",
        display_name: "Upstream dependency",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.currentItem?.id).toBe("item-blocker");
    });

    await store.selectItem("item-active");
    await flushStore();

    await store.blockTask(["item-blocker"]);
    await flushStore();

    const active = mockState.pipelineItems.find((item) => item.id === "item-active");
    expect(active?.branch).toBe("task-item-active");
    expect(active?.agent_session_id).toBe("claude-item-active");
    expect(JSON.parse(active?.tags ?? "[]")).toContain("blocked");
    expect(store.selectedItemId).toBe("item-active");
    expect(store.currentItem?.id).toBe("item-active");
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("kill_session", expect.anything());
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "git_worktree_remove",
      expect.objectContaining({ path: "/tmp/repo/.kanna-worktrees/task-item-active" }),
    );
  });

  it("unblocks a live blocked task in place and sends blocker context to the existing session", async () => {
    const blocker = mockState.makeItem({
      id: "item-blocker",
      branch: "task-item-blocker",
      closed_at: "2026-04-14T01:00:00.000Z",
      prompt: "Finish upstream dependency",
      display_name: "Upstream dependency",
    });

    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-blocked",
        branch: "task-item-blocked",
        agent_session_id: "claude-item-blocked",
        tags: '["blocked"]',
      }),
      blocker,
    ];

    mockState.listBlockersForItemMock
      .mockResolvedValueOnce([blocker])
      .mockResolvedValueOnce([]);

    const store = await createStore();
    await store.editBlockedTask("item-blocked", []);
    await flushStore();

    const blocked = mockState.pipelineItems.find((item) => item.id === "item-blocked");
    expect(JSON.parse(blocked?.tags ?? "[]")).not.toContain("blocked");
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "send_input",
      expect.objectContaining({
        sessionId: "item-blocked",
        data: expect.arrayContaining(Array.from(new TextEncoder().encode("Upstream dependency"))),
      }),
    );
    expect(mockState.invokeMock).not.toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({ sessionId: "item-blocked" }),
    );
  });

  it("closes a blocked task with live resources through the normal cleanup path", async () => {
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-blocked",
        branch: "task-item-blocked",
        agent_session_id: "claude-item-blocked",
        tags: '["blocked"]',
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-blocked");
    await flushStore();

    await store.closeTask();
    await flushStore();

    expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "item-blocked" });
    expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "shell-wt-item-blocked" });
  });

  it("kills SDK agent sessions before running teardown commands", async () => {
    mockState.repoConfig = {
      teardown: ["pnpm cleanup"],
      ports: {
        KANNA_DEV_PORT: 1420,
      },
    };
    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-sdk",
        branch: "task-item-sdk",
        agent_type: "agent",
        agent_provider: "codex",
        port_env: JSON.stringify({
          KANNA_DEV_PORT: "1421",
        }),
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-sdk");
    await flushStore();

    await store.closeTask();
    await flushStore();

    expect(mockState.invokeMock).toHaveBeenCalledWith("kill_session", { sessionId: "item-sdk" });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("signal_session", {
      sessionId: "item-sdk",
      signal: "SIGINT",
    });
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: "td-item-sdk",
        cwd: "/tmp/repo/.kanna-worktrees/task-item-sdk",
        args: expect.arrayContaining([expect.stringContaining("pnpm cleanup")]),
        env: expect.objectContaining({
          KANNA_WORKTREE: "1",
          KANNA_DEV_PORT: "1421",
          KANNA_CLI_PATH: "/usr/bin/kanna-cli",
          KANNA_TASK_ID: "item-sdk",
          KANNA_CLI_DB_PATH: "/tmp/kanna/kanna-wt-task-existing.db",
          KANNA_SOCKET_PATH: "/tmp/kanna.sock",
        }),
      }),
    );
  });

  it("still respawns legacy blocked tasks with no live session context", async () => {
    const blocker = mockState.makeItem({
      id: "item-blocker",
      branch: "task-item-blocker",
      closed_at: "2026-04-14T01:00:00.000Z",
    });

    mockState.pipelineItems = [
      mockState.makeItem({
        id: "item-blocked",
        branch: null,
        agent_session_id: null,
        tags: '["blocked"]',
      }),
      blocker,
    ];

    mockState.listBlockersForItemMock
      .mockResolvedValueOnce([blocker])
      .mockResolvedValueOnce([]);

    const store = await createStore();
    await store.editBlockedTask("item-blocked", []);
    await flushStore();

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({ sessionId: "item-blocked" }),
    );
  });
});
