import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo, TaskBlocker, TaskPort } from "../types/kanna";
import type { WorkflowDefinition } from "../../../../packages/core/src/workflow/workflow-types";
import type { CustomTaskConfig, RepoConfig } from "@kanna/core";
import { buildStagePrompt } from "../../../../packages/core/src/workflow/prompt-builder";

const toastErrorMock = vi.hoisted(() => vi.fn());
const toastWarningMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

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
      workflow: "default",
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
  let workflowItems: PipelineItem[] = [];
  let workflowDefinition: WorkflowDefinition = {
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
  let taskBlockers: TaskBlocker[] = [];
  let worktreeRows: Array<{ pipeline_item_id: string; path: string; branch: string }> = [];
  let blockCleanupGate: Promise<void> | null = null;
  let createTaskResponseGate: Promise<void> | null = null;
  let failingCommands: Record<string, string> = {};
  let commandGates: Record<string, Promise<void>> = {};
  const listBlockersForItemMock = vi.fn(async (_db?: DbHandle, _itemId?: string) => [] as PipelineItem[]);
  const listBlockedByItemMock = vi.fn(async (_db?: DbHandle, _itemId?: string) => [] as PipelineItem[]);
  const insertTaskBlockerMock = vi.fn(async (_db: DbHandle, blockedItemId: string, blockerItemId: string) => {
    taskBlockers = [
      ...taskBlockers.filter(
        (blocker) => blocker.blocked_item_id !== blockedItemId || blocker.blocker_item_id !== blockerItemId,
      ),
      { blocked_item_id: blockedItemId, blocker_item_id: blockerItemId },
    ];
  });
  const removeTaskBlockerMock = vi.fn(async (_db: DbHandle, blockedItemId: string, blockerItemId: string) => {
    taskBlockers = taskBlockers.filter(
      (blocker) => blocker.blocked_item_id !== blockedItemId || blocker.blocker_item_id !== blockerItemId,
    );
  });
  const removeAllBlockersForItemMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    taskBlockers = taskBlockers.filter((blocker) => blocker.blocked_item_id !== itemId);
  });
  const setSettingMock = vi.fn(async () => {});
  const updatePipelineItemTagsMock = vi.fn(async (_db: DbHandle, itemId: string, tags: string[]) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.tags = JSON.stringify(tags);
      item.updated_at = now;
    }
  });
  const insertWorktreeMock = vi.fn(async () => {});
  const upsertTerminalSessionMock = vi.fn(async () => {});
  const insertStageRunMock = vi.fn(async () => {});
  const updateAgentSessionIdMock = vi.fn(async () => {});
  const putTaskAgentSessionMock = vi.fn(async () => {});

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
    if (commandGates[command]) {
      await commandGates[command];
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
      case "ensure_mobile_server":
      case "spawn_session":
      case "signal_session":
      case "spawn_agent_session":
      case "kill_session":
      case "detach_session":
      case "attach_session_with_snapshot":
      case "send_input":
      case "run_script":
      case "ensure_directory":
      case "write_text_file":
        return undefined;
      case "list_sessions":
        return workflowItems
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
      case "get_workflow_socket_path":
        return "/tmp/kanna.sock";
      case "read_env_var":
        return readEnvVarOverrides[String(args?.name ?? "")] ?? "";
      case "ensure_term_init":
        return "/tmp/kanna-zdotdir";
      case "read_builtin_resource":
        return String(args?.relativePath ?? "{}");
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
    workflowItems.push(makeItem({
      id: item.id,
      repo_id: item.repo_id,
      prompt: item.prompt ?? null,
      workflow: item.pipeline,
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
      agent_session_id: item.agent_session_id ?? null,
      agent_spawn_options: item.agent_spawn_options ?? null,
    }));
  });

  const updatePipelineItemStageMock = vi.fn(async (_db: DbHandle, itemId: string, stage: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.stage = stage;
      item.updated_at = now;
    }
  });

  const updatePipelineItemActivityMock = vi.fn(async (_db: DbHandle, itemId: string, activity: PipelineItem["activity"]) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.activity = activity;
      item.activity_changed_at = now;
      item.updated_at = now;
    }
  });

  const clearPipelineItemStageResultMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.stage_result = null;
      item.updated_at = now;
    }
  });

  const updatePipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string, activePostAction: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.active_post_action = activePostAction;
      item.updated_at = now;
    }
  });

  const clearPipelineItemActivePostActionMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.active_post_action = null;
      item.updated_at = now;
    }
  });

  const markPipelineItemTearingDownMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.teardown_started_at = item.teardown_started_at ?? now;
      item.updated_at = now;
    }
  });

  const closePipelineItemMock = vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (item) {
      item.closed_at = now;
      item.updated_at = now;
    }
  });

  function reset(): void {
    repos = [makeRepo()];
    workflowItems = [];
    workflowDefinition = { name: "default", stages: [] };
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
    taskBlockers = [];
    worktreeRows = [];
    blockCleanupGate = null;
    createTaskResponseGate = null;
    failingCommands = {};
    commandGates = {};
    invokeMock.mockClear();
    insertPipelineItemMock.mockClear();
    updatePipelineItemStageMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
    clearPipelineItemStageResultMock.mockClear();
    updatePipelineItemActivePostActionMock.mockClear();
    clearPipelineItemActivePostActionMock.mockClear();
    markPipelineItemTearingDownMock.mockClear();
    closePipelineItemMock.mockClear();
    listBlockersForItemMock.mockClear();
    listBlockedByItemMock.mockClear();
    insertTaskBlockerMock.mockClear();
    removeTaskBlockerMock.mockClear();
    removeAllBlockersForItemMock.mockClear();
    setSettingMock.mockClear();
    updatePipelineItemTagsMock.mockClear();
    insertWorktreeMock.mockClear();
    upsertTerminalSessionMock.mockClear();
    insertStageRunMock.mockClear();
    updateAgentSessionIdMock.mockClear();
    putTaskAgentSessionMock.mockClear();
    listBlockersForItemMock.mockResolvedValue([]);
    listBlockedByItemMock.mockResolvedValue([]);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ taskId: "item-created" }),
      text: async () => "",
    });
  }

  return {
    get repos() {
      return repos;
    },
    set repos(value: Repo[]) {
      repos = value;
    },
    get workflowItems() {
      return workflowItems;
    },
    set workflowItems(value: PipelineItem[]) {
      workflowItems = value;
    },
    get workflowDefinition() {
      return workflowDefinition;
    },
    set workflowDefinition(value: WorkflowDefinition) {
      workflowDefinition = value;
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
    get taskBlockers() {
      return taskBlockers;
    },
    set taskBlockers(value: TaskBlocker[]) {
      taskBlockers = value;
    },
    get worktreeRows() {
      return worktreeRows;
    },
    set worktreeRows(value: Array<{ pipeline_item_id: string; path: string; branch: string }>) {
      worktreeRows = value;
    },
    invokeMock,
    insertPipelineItemMock,
    updatePipelineItemStageMock,
    updatePipelineItemActivityMock,
    clearPipelineItemStageResultMock,
    updatePipelineItemActivePostActionMock,
    clearPipelineItemActivePostActionMock,
    markPipelineItemTearingDownMock,
    closePipelineItemMock,
    makeItem,
    makeRepo,
    defer,
    listBlockersForItemMock,
    listBlockedByItemMock,
    insertTaskBlockerMock,
    removeTaskBlockerMock,
    removeAllBlockersForItemMock,
    setSettingMock,
    updatePipelineItemTagsMock,
    insertWorktreeMock,
    upsertTerminalSessionMock,
    insertStageRunMock,
    updateAgentSessionIdMock,
    putTaskAgentSessionMock,
    get blockCleanupGate() {
      return blockCleanupGate;
    },
    set blockCleanupGate(value: Promise<void> | null) {
      blockCleanupGate = value;
    },
    get createTaskResponseGate() {
      return createTaskResponseGate;
    },
    set createTaskResponseGate(value: Promise<void> | null) {
      createTaskResponseGate = value;
    },
    get failingCommands() {
      return failingCommands;
    },
    set failingCommands(value: Record<string, string>) {
      failingCommands = value;
    },
    get commandGates() {
      return commandGates;
    },
    set commandGates(value: Record<string, Promise<void>>) {
      commandGates = value;
    },
    reset,
  };
});

vi.mock("../invoke", () => ({
  invoke: mockState.invokeMock,
}));

vi.stubGlobal("fetch", fetchMock);

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

vi.mock("../../../../packages/core/src/workflow/agent-loader", () => ({
  parseAgentDefinition: vi.fn((content: string) => {
    const role = content.match(/\.kanna\/agents\/([^/]+)\/AGENT\.md/)?.[1] ?? "agent";
    return {
      name: role,
      description: role,
      prompt: `${role} agent prompt`,
      agent_provider: role === "setup" ? "codex" : "claude",
    };
  }),
}));

vi.mock("../../../../packages/core/src/workflow/workflow-loader", () => ({
  parseWorkflowJson: vi.fn(() => mockState.workflowDefinition),
}));

vi.mock("../../../../packages/core/src/workflow/prompt-builder", () => ({
  buildStagePrompt: vi.fn((agentPrompt: string, stagePrompt: string | undefined, context: { taskPrompt?: string }) =>
    [agentPrompt, stagePrompt]
      .filter((part): part is string => part !== undefined && part.trim() !== "")
      .join("\n\n")
      .replaceAll("$TASK_PROMPT", context.taskPrompt ?? "")
  ),
  buildKannaRuntimeSystemPrompt: vi.fn(() => "This session was launched by Kanna."),
  buildKannaRuntimeUserPrompt: vi.fn((prompt: string) => `This session was launched by Kanna.\n\n${prompt}`),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => ({
    error: toastErrorMock,
    warning: toastWarningMock,
  }),
}));

vi.mock("../composables/terminalSessionRecovery", () => ({
  buildTaskShellCommand: vi.fn((agentCmd: string, _setupCmds: string[], options?: { agentCmdPreamble?: string }) => options?.agentCmdPreamble ?? agentCmd),
  getShellTerminalEnv: vi.fn(() => ({
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kanna",
  })),
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
  normalizeAgentProviderCandidates: vi.fn((provider?: string | string[]) =>
    provider == null ? [] : (Array.isArray(provider) ? provider : [provider])
  ),
  getPreferredAgentProviders: vi.fn((options: {
    explicit?: string | string[];
    stage?: string | string[];
    agent?: string | string[];
    item?: string;
  }) => options.explicit ?? options.stage ?? options.agent ?? options.item ?? "claude"),
  requireResolvedAgentProvider: vi.fn((provider?: string) => provider ?? "claude"),
  resolveAgentProvider: vi.fn((provider?: string | string[]) => Array.isArray(provider) ? provider[0] : (provider ?? "claude")),
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
      t: (key: string) => key === "mainPanel.taskBlocked" ? "Task Blocked" : key,
    },
  },
}));

vi.mock("@kanna/" + "db", () => ({
  listRepos: vi.fn(async () => mockState.repos),
  insertRepo: vi.fn(async () => {}),
  findRepoByPath: vi.fn(async () => null),
  hideRepo: vi.fn(async () => {}),
  unhideRepo: vi.fn(async () => {}),
  listPipelineItems: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.workflowItems.filter((item) => item.repo_id === repoId)
  ),
  listTaskBlockers: vi.fn(async () => mockState.taskBlockers),
  insertPipelineItem: mockState.insertPipelineItemMock,
  insertStageRun: mockState.insertStageRunMock,
  insertWorktree: mockState.insertWorktreeMock,
  upsertTerminalSession: mockState.upsertTerminalSessionMock,
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
  markPipelineItemTearingDown: mockState.markPipelineItemTearingDownMock,
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
    const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
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
  insertTaskBlocker: mockState.insertTaskBlockerMock,
  removeTaskBlocker: mockState.removeTaskBlockerMock,
  removeAllBlockersForItem: mockState.removeAllBlockersForItemMock,
  listBlockersForItem: mockState.listBlockersForItemMock,
  listBlockedByItem: mockState.listBlockedByItemMock,
  getUnblockedItems: vi.fn(async () => []),
  hasCircularDependency: vi.fn(async () => false),
  insertOperatorEvent: vi.fn(async () => {}),
  updateAgentSessionId: mockState.updateAgentSessionIdMock,
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
import {
  setDesktopServerClientHandlersForTests,
  setDesktopSnapshotFetcherForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

/**
 * The webview is a browser, so `kanna-server` refuses its task actions unless
 * they carry this desktop's local control credential; the Tauri mock hands out
 * this one. See `services/localControlCredential.ts`.
 */
const LOCAL_CREDENTIAL_HEADERS = { Authorization: "Bearer mock-local-control-credential" };

let activeStore: ReturnType<typeof useKannaStore> | null = null;

function createDb(): DbHandle {
  return {
    execute: vi.fn(async (query: string, bindValues?: unknown[]) => {
      if (query.startsWith("INSERT OR IGNORE INTO task_port")) {
        const [port, workflowItemId, envName] = bindValues as [number, string, string];
        if (!mockState.taskPorts.some((taskPort) => taskPort.port === port)) {
          mockState.taskPorts = [
            ...mockState.taskPorts,
            {
              port,
              pipeline_item_id: workflowItemId,
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
        const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
        if (item) {
          item.port_offset = portOffset;
          item.port_env = portEnv;
        }
        return { rowsAffected: item ? 1 : 0 };
      }

      if (query.startsWith("DELETE FROM pipeline_item WHERE id = ?")) {
        const [itemId] = bindValues as [string];
        mockState.workflowItems = mockState.workflowItems.filter((candidate) => candidate.id !== itemId);
        return { rowsAffected: 1 };
      }

      if (query.startsWith("DELETE FROM worktree WHERE pipeline_item_id = ?")) {
        const [itemId] = bindValues as [string];
        mockState.worktreeRows = mockState.worktreeRows.filter((row) => row.pipeline_item_id !== itemId);
        return { rowsAffected: 1 };
      }

      if (query.startsWith("INSERT INTO worktree")) {
        const [_id, itemId, path, branch] = bindValues as [string, string, string, string];
        mockState.worktreeRows = [
          ...mockState.worktreeRows.filter((row) => row.pipeline_item_id !== itemId),
          { pipeline_item_id: itemId, path, branch },
        ];
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
        const closed = [...mockState.workflowItems]
          .filter((item) => item.closed_at !== null)
          .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
        return (closed[0] ? [closed[0]] : []) as T[];
      }

      if (query === "SELECT id FROM pipeline_item WHERE id = ? LIMIT 1") {
        const [itemId] = bindValues as [string];
        const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
        return (item ? [{ id: item.id }] : []) as T[];
      }

      if (query === "SELECT path FROM worktree WHERE pipeline_item_id = ?") {
        const [itemId] = bindValues as [string];
        return mockState.worktreeRows
          .filter((row) => row.pipeline_item_id === itemId)
          .map((row) => ({ path: row.path })) as T[];
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
  activeStore = store;
  await store.init(createDb());
  await flushStore();
  return store;
}

describe("kanna store task base branch integration", () => {
  beforeEach(() => {
    mockState.reset();
    activeStore = null;
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: mockState.repos.map((repo) => ({
        repo,
        items: mockState.workflowItems.filter((item) => item.repo_id === repo.id),
      })),
      taskBlockers: mockState.taskBlockers,
      worktreePaths: {},
      settings: {},
    }));
    const resolveConfigForPath = (configPath: string): RepoConfig => {
      return mockState.repoConfigResolver?.(configPath) ?? mockState.repoConfig;
    };
    const claimPortsForTask = (taskId: string, config: RepoConfig): Record<string, string> => {
      const ports = config.ports ?? {};
      const portEnv: Record<string, string> = {};
      let firstPort: number | null = null;
      const occupiedPorts = new Set(
        mockState.taskPorts
          .filter((taskPort) => taskPort.pipeline_item_id !== taskId)
          .map((taskPort) => taskPort.port),
      );
      for (const port of config.reserved_ports ?? []) {
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          occupiedPorts.add(port);
        }
      }
      for (const preferredPort of Object.values(ports)) {
        for (const offset of config.reserved_port_offsets ?? []) {
          if (!Number.isInteger(offset) || offset < 0) continue;
          const reservedPort = preferredPort + offset;
          if (reservedPort > 0 && reservedPort <= 65535) {
            occupiedPorts.add(reservedPort);
          }
        }
      }

      mockState.taskPorts = mockState.taskPorts.filter((taskPort) => taskPort.pipeline_item_id !== taskId);
      for (const [envName, preferredPort] of Object.entries(ports)) {
        for (let candidate = preferredPort + 1; candidate <= 65535; candidate += 1) {
          if (occupiedPorts.has(candidate)) continue;
          mockState.taskPorts = [
            ...mockState.taskPorts,
            {
              port: candidate,
              pipeline_item_id: taskId,
              env_name: envName,
              created_at: mockState.makeItem().created_at,
            },
          ];
          occupiedPorts.add(candidate);
          portEnv[envName] = String(candidate);
          if (firstPort === null) firstPort = candidate;
          break;
        }
      }

      const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
      if (item) {
        item.port_offset = firstPort;
        item.port_env = Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null;
      }
      return portEnv;
    };
    const buildRuntimeEnv = (
      taskId: string,
      worktreePath: string,
      portEnv: Record<string, string>,
      config: RepoConfig,
    ): Record<string, string> => {
      const inheritedPath = (mockState.readEnvVarOverrides.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(":")
        .filter((entry) => entry !== "/usr/bin")
        .join(":");
      return {
        KANNA_WORKTREE: "1",
        ...(config.workspace?.env ?? {}),
        ...portEnv,
        KANNA_CLI_PATH: "/usr/bin/kanna-cli",
        PATH: [
          "/usr/bin",
          ...(config.workspace?.path?.prepend ?? []).map((entry) => `${worktreePath}/${entry.replace(/^\.\//, "")}`),
          inheritedPath,
          ...(config.workspace?.path?.append ?? []).map((entry) => `${worktreePath}/${entry.replace(/^\.\//, "")}`),
        ].filter(Boolean).join(":"),
        KANNA_TASK_ID: taskId,
        KANNA_SOCKET_PATH: "/tmp/kanna.sock",
        KANNA_SERVER_BASE_URL: `http://127.0.0.1:${mockState.readEnvVarOverrides.KANNA_MOBILE_SERVER_PORT ?? "48120"}`,
      };
    };
    const runTaskSetup = async (
      taskId: string,
      worktreePath: string,
      config: RepoConfig,
      portEnv: Record<string, string>,
    ): Promise<void> => {
      for (const script of config.setup ?? []) {
        await mockState.invokeMock("run_script", {
          script,
          cwd: worktreePath,
          env: buildRuntimeEnv(taskId, worktreePath, portEnv, config),
        });
      }
    };
    const spawnTask = async (
      taskId: string,
      worktreePath: string,
      config: RepoConfig,
      portEnv: Record<string, string>,
    ): Promise<void> => {
      const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
      if (!item) return;
      if (item.agent_type === "agent") {
        const spawnOptions = item.agent_spawn_options
          ? JSON.parse(item.agent_spawn_options) as Record<string, unknown>
          : {};
        await mockState.invokeMock("spawn_agent_session", {
          sessionId: taskId,
          cwd: worktreePath,
          prompt: item.prompt ?? "",
          env: buildRuntimeEnv(taskId, worktreePath, portEnv, config),
          agentProvider: item.agent_provider,
          systemPrompt: "This session was launched by Kanna.",
          mcpConfigPath: null,
          permissionMode: spawnOptions.permissionMode ?? null,
          model: spawnOptions.model ?? null,
          allowedTools: spawnOptions.allowedTools ?? null,
          disallowedTools: spawnOptions.disallowedTools ?? null,
          maxTurns: spawnOptions.maxTurns ?? null,
          maxBudgetUsd: spawnOptions.maxBudgetUsd ?? null,
          executable: null,
        });
        return;
      }
      const spawnOptions = item.agent_spawn_options
        ? JSON.parse(item.agent_spawn_options) as Record<string, unknown>
        : {};
      if (!item.agent_session_id) {
        const agentSessionId = crypto.randomUUID();
        await mockState.putTaskAgentSessionMock(taskId, agentSessionId);
        item.agent_session_id = agentSessionId;
      }
      const modelArg = typeof spawnOptions.model === "string" ? ` -m ${spawnOptions.model}` : "";
      const providerCommand = item.agent_provider === "codex"
        ? `codex${modelArg} ${item.prompt ?? ""} This session was launched by Kanna.`
        : item.agent_provider === "copilot"
          ? `copilot ${item.prompt ?? ""}`
          : `claude ${item.prompt ?? ""}`;
      await mockState.invokeMock("spawn_session", {
        sessionId: taskId,
        cwd: worktreePath,
        executable: "/bin/zsh",
        args: ["--login", "-i", "-c", providerCommand],
        env: buildRuntimeEnv(taskId, worktreePath, portEnv, config),
        cols: 80,
        rows: 24,
        agentProvider: item.agent_provider,
      });
    };
    setDesktopServerClientHandlersForTests({
      getSetting: async () => null,
      putSetting: async (key, value) => ({ key, value }),
      deleteSetting: async () => {},
      postOperatorEvents: async () => {},
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: mockState.repoConfig,
        defaultWorkflow: mockState.repoConfig.workflow ?? "default",
        workflows: ["default"],
      }),
      fetchRepoWorkflowDefinition: async () => ({
        revision: "rev-1",
        definition: mockState.workflowDefinition,
      }),
      fetchRepoAgentDefinition: async (_repoId, agentSelector) => ({
        revision: "rev-1",
        definition: {
          name: agentSelector,
          description: agentSelector,
          prompt: `${agentSelector} agent prompt`,
          agent_provider: agentSelector === "setup" ? "codex" : "claude",
        },
      }),
      patchRepo: async (repoId, input) => {
        const repo = mockState.repos.find((candidate) => candidate.id === repoId);
        if (!repo) return;
        if (input.hidden !== undefined) {
          repo.hidden = input.hidden ? 1 : 0;
        }
      },
      fetchClosedTaskIdentities: async () =>
        mockState.workflowItems
          .filter((item) => item.closed_at !== null)
          .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)) || a.id.localeCompare(b.id))
          .map((item) => ({ id: item.id, repo_id: item.repo_id })),
      createTask: async (request) => {
        const repo = mockState.repos.find((candidate) => candidate.id === request.repoId);
        if (!repo) throw new Error(`repo not found: ${request.repoId}`);
        const taskId = crypto.randomUUID();
        const branch = `task-${taskId}`;
        const worktreePath = `${repo.path}/.kanna-worktrees/${branch}`;
        const worktreeConfig = resolveConfigForPath(`${worktreePath}/.kanna/config.json`);
        if (request.baseRef?.startsWith("origin/")) {
          await mockState.invokeMock("git_fetch", {
            repoPath: repo.path,
            branch: request.baseRef.slice("origin/".length),
          });
        }
        await mockState.invokeMock("git_worktree_add", {
          repoPath: repo.path,
          path: worktreePath,
          branch,
          startPoint: request.baseRef ?? repo.default_branch,
        });
        const requestedAgent = request.agent;
        const resolvedAgent = requestedAgent
          ? {
              name: requestedAgent,
              prompt: `${requestedAgent} agent prompt`,
              agentProvider: requestedAgent === "setup" ? "codex" : "claude",
            }
          : null;
        const taskPrompt = resolvedAgent
          ? `${resolvedAgent.prompt}\n\n${request.prompt}`
          : request.prompt;
        const taskProvider = request.agentProvider ?? resolvedAgent?.agentProvider ?? "claude";
        const spawnOptions = {
          model: request.model ?? null,
          permissionMode: request.permissionMode ?? null,
          allowedTools: request.allowedTools ?? null,
          disallowedTools: request.disallowedTools ?? null,
          maxTurns: request.maxTurns ?? null,
          maxBudgetUsd: request.maxBudgetUsd ?? null,
        };
        const agentSpawnOptions = Object.values(spawnOptions).some((value) => value != null)
          ? JSON.stringify(spawnOptions)
          : null;

        await mockState.insertPipelineItemMock({} as DbHandle, {
          id: taskId,
          repo_id: repo.id,
          prompt: taskPrompt,
          workflow: request.workflowName ?? "default",
          stage: request.stage ?? "in progress",
          tags: [],
          branch,
          agent_type: request.agentType ?? "pty",
          agent_provider: taskProvider,
          activity: "idle",
          display_name: request.displayName ?? null,
          base_ref: request.baseRef ?? null,
          agent_session_id: request.resumeSessionId ?? null,
          agent_spawn_options: agentSpawnOptions,
        });
        await mockState.insertStageRunMock({} as DbHandle, {
          task_id: taskId,
          stage: request.stage ?? "in progress",
          kind: "main",
          agent: requestedAgent ?? null,
          agent_provider: taskProvider,
          model: request.model ?? null,
          status: "running",
          session_id: taskId,
          cwd: worktreePath,
        });
        const portEnv = claimPortsForTask(taskId, worktreeConfig);
        await mockState.insertWorktreeMock({} as DbHandle, {
          id: `wt-${taskId}`,
          pipeline_item_id: taskId,
          path: worktreePath,
          branch,
        });
        if ((request.agentType ?? "pty") === "pty") {
          await mockState.upsertTerminalSessionMock({} as DbHandle, {
            id: `agent-${taskId}`,
            repo_id: repo.id,
            pipeline_item_id: taskId,
            label: "agent",
            cwd: worktreePath,
            daemon_session_id: taskId,
          });
        }
        if ((request.agentType ?? "pty") === "agent") {
          await runTaskSetup(taskId, worktreePath, worktreeConfig, portEnv);
        }
        try {
          await spawnTask(taskId, worktreePath, worktreeConfig, portEnv);
        } catch {
          mockState.workflowItems = mockState.workflowItems.filter((item) => item.id !== taskId);
        }
        if (mockState.createTaskResponseGate) {
          await mockState.createTaskResponseGate;
        }
        return {
          taskId,
          repoId: repo.id,
          title: request.displayName ?? request.prompt,
          stage: request.stage ?? "in progress",
          agentType: request.agentType ?? "pty",
          worktreePath,
        };
      },
      closeTask: async (taskId) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        const repo = item ? mockState.repos.find((candidate) => candidate.id === item.repo_id) : null;
        if (!item || !repo) return;
        await mockState.invokeMock("kill_session", { sessionId: taskId });
        await mockState.invokeMock("kill_session", { sessionId: `shell-wt-${taskId}` });
        const worktreePath = item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;
        const config = resolveConfigForPath(`${worktreePath}/.kanna/config.json`);
        if (config.teardown?.length) {
          await mockState.markPipelineItemTearingDownMock({} as DbHandle, taskId);
          await mockState.invokeMock("spawn_session", {
            sessionId: `td-${taskId}`,
            cwd: worktreePath,
            args: config.teardown,
            env: buildRuntimeEnv(
              taskId,
              worktreePath,
              item.port_env ? JSON.parse(item.port_env) as Record<string, string> : {},
              config,
            ),
          });
        }
        await mockState.closePipelineItemMock({} as DbHandle, taskId);
      },
      reopenTask: async (taskId) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        const repo = item ? mockState.repos.find((candidate) => candidate.id === item.repo_id) : null;
        if (!item || !repo) return;
        const worktreePath = item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;
        const config = resolveConfigForPath(`${worktreePath}/.kanna/config.json`);
        item.closed_at = null;
        item.updated_at = mockState.makeItem().updated_at;
        claimPortsForTask(taskId, config);
      },
      blockTask: async (taskId, blockerTaskIds) => {
        for (const blockerTaskId of blockerTaskIds) {
          await mockState.insertTaskBlockerMock({} as DbHandle, taskId, blockerTaskId);
        }
      },
      unblockTask: async (taskId) => {
        const blockers = await mockState.listBlockersForItemMock({} as DbHandle, taskId);
        for (const blocker of blockers) {
          await mockState.removeTaskBlockerMock({} as DbHandle, taskId, blocker.id);
        }
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (!item) return;
        if (item.agent_session_id) {
          const message = blockers
            .map((blocker) => blocker.display_name ?? blocker.prompt ?? blocker.id)
            .join("\n");
          await mockState.invokeMock("send_input", {
            sessionId: taskId,
            data: Array.from(new TextEncoder().encode(message)),
          });
        } else {
          const repo = mockState.repos.find((candidate) => candidate.id === item.repo_id);
          const worktreePath = repo && item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : (repo?.path ?? "/tmp/repo");
          const config = resolveConfigForPath(`${worktreePath}/.kanna/config.json`);
          await spawnTask(
            taskId,
            worktreePath,
            config,
            item.port_env ? JSON.parse(item.port_env) as Record<string, string> : {},
          );
        }
      },
      applyTaskRuntimeStatus: async (taskId, input) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (!item || item.closed_at != null) return { taskId, activity: null };
        let activity: PipelineItem["activity"] | null = null;
        if (input.status === "busy" && item.activity !== "working") {
          activity = "working";
        } else if ((input.status === "idle" || input.status === "waiting") && item.activity === "working") {
          activity = input.selected ? "idle" : "unread";
        }
        if (activity) {
          item.activity = activity;
          item.activity_changed_at = mockState.makeItem().activity_changed_at;
          item.updated_at = mockState.makeItem().updated_at;
        }
        return { taskId, activity };
      },
      markTaskRead: async (taskId) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (item?.activity === "unread") item.activity = "idle";
        return { taskId, activity: item?.activity === "idle" ? "idle" : null };
      },
      putTaskAgentSession: async (taskId, agentSessionId) => {
        await mockState.putTaskAgentSessionMock(taskId, agentSessionId);
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (item) {
          item.agent_session_id = agentSessionId;
          item.updated_at = mockState.makeItem().updated_at;
        }
      },
      claimTaskPorts: async (taskId, input) => {
        const portEnv: Record<string, string> = {};
        let firstPort: number | null = null;
        const occupiedPorts = new Set(mockState.taskPorts.map((taskPort) => taskPort.port));
        for (const port of input.reservedPorts ?? []) {
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            occupiedPorts.add(port);
          }
        }
        for (const preferredPort of Object.values(input.ports ?? {})) {
          for (const offset of input.reservedPortOffsets ?? []) {
            if (!Number.isInteger(offset) || offset < 0) continue;
            const reservedPort = preferredPort + offset;
            if (reservedPort > 0 && reservedPort <= 65535) {
              occupiedPorts.add(reservedPort);
            }
          }
        }
        for (const [envName, preferredPort] of Object.entries(input.ports ?? {})) {
          const existing = mockState.taskPorts.find(
            (taskPort) => taskPort.pipeline_item_id === taskId && taskPort.env_name === envName,
          );
          if (existing) {
            occupiedPorts.add(existing.port);
            portEnv[envName] = String(existing.port);
            if (firstPort === null) firstPort = existing.port;
            continue;
          }
          for (let candidate = preferredPort + 1; candidate <= 65535; candidate += 1) {
            if (occupiedPorts.has(candidate)) continue;
            mockState.taskPorts = [
              ...mockState.taskPorts,
              {
                port: candidate,
                pipeline_item_id: taskId,
                env_name: envName,
                created_at: mockState.makeItem().created_at,
              },
            ];
            occupiedPorts.add(candidate);
            portEnv[envName] = String(candidate);
            if (firstPort === null) firstPort = candidate;
            break;
          }
        }
        return { taskId, portEnv, firstPort };
      },
      releaseTaskPorts: async (taskId) => {
        mockState.taskPorts = mockState.taskPorts.filter((taskPort) => taskPort.pipeline_item_id !== taskId);
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (item) {
          item.port_offset = null;
          item.port_env = null;
        }
      },
    });
    toastErrorMock.mockClear();
    toastWarningMock.mockClear();
    vi.mocked(buildStagePrompt).mockClear();
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
      const createdItem = mockState.workflowItems.at(-1);
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

  it("skips configured reserved port offsets and explicit reserved ports", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
      reserved_port_offsets: [0, 1],
      reserved_ports: [3002],
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Ship reserved port ranges", "agent", {
      agentProvider: "claude",
    });

    await vi.waitFor(() => {
      const createdItem = mockState.workflowItems.at(-1);
      expect(createdItem?.port_offset).toBe(1422);
      expect(createdItem?.port_env).toBe(JSON.stringify({
        KANNA_DEV_PORT: "1422",
        API_PORT: "3003",
      }));
      expect(mockState.taskPorts.map((taskPort) => `${taskPort.env_name}:${taskPort.port}`)).toEqual([
        "KANNA_DEV_PORT:1422",
        "API_PORT:3003",
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
      const createdItem = mockState.workflowItems.at(-1);
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
      const secondItem = mockState.workflowItems.at(-1);
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
      const createdItem = mockState.workflowItems.at(-1);
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
            KANNA_SOCKET_PATH: "/tmp/kanna.sock",
            KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
          }),
        }),
      );
    });
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
      createdItem = mockState.workflowItems.at(-1);
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
      const createdItem = mockState.workflowItems.at(-1);
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
      const createdItem = mockState.workflowItems.at(-1);
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
      expect(mockState.workflowItems.some((item) => item.id === taskId)).toBe(false);
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

  it("persists frontend-created PTY provider session ids through the server client", async () => {
    const store = await createStore();

    const taskId = await store.createItem("repo-1", "/tmp/repo", "Ship provider session", "pty", {
      agentProvider: "copilot",
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({ sessionId: taskId }),
      );
    });

    expect(mockState.putTaskAgentSessionMock).toHaveBeenCalledOnce();
    expect(mockState.putTaskAgentSessionMock).toHaveBeenCalledWith(
      taskId,
      expect.stringMatching(/^[0-9a-f-]+$/),
    );
    expect(mockState.updateAgentSessionIdMock).not.toHaveBeenCalled();
    expect(mockState.workflowItems.find((item) => item.id === taskId)?.agent_session_id)
      .toEqual(expect.stringMatching(/^[0-9a-f-]+$/));
  });

  it("passes remote workspace env and PATH updates to identified PTY task sessions", async () => {
    mockState.repoConfig = {
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
    mockState.workflowItems = [mockState.makeItem({
      id: "task-pty-env",
      branch: "task-pty-env",
      prompt: "Ship PTY env",
    })];
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
          KANNA_SERVER_BASE_URL: "http://127.0.0.1:48120",
        }),
      }),
    );
    const spawnCall = mockState.invokeMock.mock.calls.find(([command]) => command === "spawn_session");
    expect(spawnCall?.[1]?.args?.join(" ")).toContain("--append-system-prompt");
    expect(spawnCall?.[1]?.args?.join(" ")).toContain("This session was launched by Kanna.");
    expect(spawnCall?.[1]?.args?.join(" ")).not.toContain("Ship PTY env\\n\\nThis session was launched by Kanna.");
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

  it("keeps one selected UI slot from submission through durable hydration", async () => {
    const worktreeAddGate = mockState.defer();
    const selectionGate = mockState.defer();
    const persistSelection = vi.fn(async () => selectionGate.promise);
    const store = await createStore();
    mockState.commandGates = { git_worktree_add: worktreeAddGate.promise };
    store.attachWindowWorkspace({
      bootstrap: { windowId: "test-window", selectedRepoId: null, selectedItemId: null },
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

    const createPromise = store.createItem("repo-1", "/tmp/repo", "Show one stable task", "pty", {
      agentProvider: "claude",
    });
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({ repoPath: "/tmp/repo" }),
      );
    });

    expect(mockState.insertPipelineItemMock).not.toHaveBeenCalled();
    expect(store.currentTaskSlot).toMatchObject({
      slot_id: expect.stringMatching(/^create:/),
      task_id: null,
      state: "creating",
      task: null,
      draft: {
        repo_id: "repo-1",
        prompt: "Show one stable task",
        agent_type: "pty",
        agent_provider: "claude",
      },
    });
    const slotId = store.currentTaskSlot!.slot_id;
    expect(store.items.some((item) => item.id === slotId)).toBe(false);
    expect(store.selectedItemId).toBe(slotId);
    expect(store.selectedTaskId).toBeNull();
    expect(store.taskUiSlots).toHaveLength(1);
    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });

    worktreeAddGate.resolve();
    await vi.waitFor(() => {
      expect(store.currentTaskSlot).toMatchObject({
        slot_id: slotId,
        task_id: expect.stringMatching(/^[0-9a-f-]+$/),
        state: "ready",
        task: { id: expect.stringMatching(/^[0-9a-f-]+$/) },
      });
    });

    expect(store.items.some((item) => item.id === slotId)).toBe(false);
    expect(store.selectedItemId).toBe(slotId);
    expect(store.selectedTaskId).toBe(store.currentTaskSlot?.task_id);
    expect(store.taskUiSlots.filter((slot) => slot.draft.prompt === "Show one stable task")).toHaveLength(1);

    selectionGate.resolve();
    const taskId = await createPromise;
    expect(taskId).toBe(store.currentTaskSlot?.task_id);
    await vi.waitFor(() => {
      expect(persistSelection).toHaveBeenCalledWith({
        selectedRepoId: "repo-1",
        selectedItemId: taskId,
      });
    });
  });

  it("keeps one slot when a snapshot arrives before the create response and hydrates it on acknowledgement", async () => {
    const responseGate = mockState.defer();
    const store = await createStore();
    mockState.createTaskResponseGate = responseGate.promise;

    const createPromise = store.createItem(
      "repo-1",
      "/tmp/repo",
      "Snapshot before acknowledgement",
      "pty",
      { agentProvider: "claude" },
    );
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_session",
        expect.objectContaining({ agentProvider: "claude" }),
      );
    });
    const durableItem = mockState.workflowItems.find(
      (item) => item.prompt === "Snapshot before acknowledgement",
    );
    expect(durableItem).toBeDefined();

    await store.init(createDb());

    expect(store.items.some((item) => item.id === durableItem!.id)).toBe(true);
    expect(store.taskUiSlots.filter(
      (slot) => slot.draft.prompt === "Snapshot before acknowledgement",
    )).toEqual([
      expect.objectContaining({
        slot_id: expect.stringMatching(/^create:/),
        task_id: null,
        state: "creating",
        task: null,
      }),
    ]);
    const slotId = store.selectedItemId;

    let failNextSnapshot = true;
    setDesktopSnapshotFetcherForTests(async () => {
      if (failNextSnapshot) {
        failNextSnapshot = false;
        throw new Error("post-ack snapshot unavailable");
      }
      return {
        entries: mockState.repos.map((repo) => ({
          repo,
          items: mockState.workflowItems.filter((item) => item.repo_id === repo.id),
        })),
        taskBlockers: mockState.taskBlockers,
        worktreePaths: {},
        settings: {},
      };
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    responseGate.resolve();
    const taskId = await createPromise;

    expect(taskId).toBe(durableItem!.id);
    expect(store.selectedItemId).toBe(slotId);
    expect(store.currentTaskSlot).toMatchObject({
      slot_id: slotId,
      task_id: taskId,
      state: "ready",
      task: { id: taskId },
    });
    expect(store.taskUiSlots.filter((slot) => slot.task_id === taskId)).toHaveLength(1);
    consoleError.mockRestore();
  });

  it("retains an acknowledged slot when task snapshot hydration fails", async () => {
    const store = await createStore();
    const slotCountBeforeCreate = store.taskUiSlots.length;
    let failNextSnapshot = true;
    setDesktopSnapshotFetcherForTests(async () => {
      if (failNextSnapshot) {
        failNextSnapshot = false;
        throw new Error("snapshot temporarily unavailable");
      }
      return {
        entries: mockState.repos.map((repo) => ({
          repo,
          items: mockState.workflowItems.filter((item) => item.repo_id === repo.id),
        })),
        taskBlockers: mockState.taskBlockers,
        worktreePaths: {},
        settings: {},
      };
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const taskId = await store.createItem(
      "repo-1",
      "/tmp/repo",
      "Hydrate later",
      "pty",
      { agentProvider: "claude" },
    );

    expect(store.currentTaskSlot).toMatchObject({
      slot_id: expect.stringMatching(/^create:/),
      task_id: taskId,
      state: "creating",
      task: null,
      authoritative_miss_grace_remaining: 1,
    });
    const slotId = store.currentTaskSlot!.slot_id;
    expect(store.selectedItemId).toBe(slotId);
    expect(store.items.some((item) => item.id === taskId)).toBe(false);
    expect(store.taskUiSlots).toHaveLength(slotCountBeforeCreate + 1);
    await store.init(createDb());

    expect(store.currentTaskSlot).toMatchObject({
      slot_id: slotId,
      task_id: taskId,
      state: "ready",
      task: { id: taskId },
    });
    expect(store.taskUiSlots.filter((slot) => slot.task_id === taskId)).toHaveLength(1);
    consoleError.mockRestore();
  });

  it("removes only the creating slot and restores selection when creation fails before acknowledgement", async () => {
    mockState.workflowItems = [mockState.makeItem({
      id: "item-existing",
      branch: "task-item-existing",
      prompt: "Keep this task",
    })];
    mockState.baseBranchResponse = ["feature/no-default"];
    const store = await createStore();
    await store.selectItem("item-existing");
    const persistSelection = vi.fn(() => new Promise<void>(() => {}));
    store.attachWindowWorkspace({
      bootstrap: { windowId: "test-window", selectedRepoId: "repo-1", selectedItemId: "item-existing" },
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
    const createPromise = store.createItem(
      "repo-1",
      "/tmp/repo",
      "Fail before acknowledgement",
      "pty",
      { agentProvider: "claude" },
    );
    let outcome: {
      status: "pending" | "resolved" | "rejected";
      error: unknown;
    } = { status: "pending", error: null };
    void createPromise.then(
      () => {
        outcome = { status: "resolved", error: null };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );
    await vi.waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("No valid base branch selected");
    });
    await Promise.resolve();

    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toEqual(new Error("No valid base branch selected"));

    expect(store.taskUiSlots).toHaveLength(1);
    expect(store.taskUiSlots[0]).toMatchObject({
      slot_id: "item-existing",
      task_id: "item-existing",
      state: "ready",
    });
    expect(store.taskUiSlots.some((slot) => slot.draft.prompt === "Fail before acknowledgement")).toBe(false);
    expect(store.selectedItemId).toBe("item-existing");
    expect(store.lastSelectedItemByRepo["repo-1"]).toBe("item-existing");
    expect(persistSelection).toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: null,
    });
    expect(persistSelection).toHaveBeenCalledTimes(1);
  });

  it("materializes a deferred same-repo snapshot task immediately when creation fails", async () => {
    const baseBranchGate = mockState.defer();
    mockState.baseBranchResponse = ["feature/no-default"];
    const store = await createStore();
    mockState.commandGates = {
      git_list_base_branches: baseBranchGate.promise,
    };

    const createPromise = store.createItem(
      "repo-1",
      "/tmp/repo",
      "Fail after another task arrives",
      "pty",
      { agentProvider: "claude" },
    );
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_list_base_branches",
        { repoPath: "/tmp/repo" },
      );
    });

    const arrivedItem = mockState.makeItem({
      id: "item-arrived",
      branch: "task-item-arrived",
      prompt: "Arrived during creation",
    });
    mockState.workflowItems = [arrivedItem];
    await store.init(createDb());

    expect(store.items.map((item) => item.id)).toEqual(["item-arrived"]);
    expect(store.taskUiSlots).toEqual([
      expect.objectContaining({
        slot_id: expect.stringMatching(/^create:/),
        task_id: null,
        state: "creating",
      }),
    ]);

    baseBranchGate.resolve();
    await expect(createPromise).rejects.toThrow("No valid base branch selected");

    expect(store.taskUiSlots).toEqual([
      expect.objectContaining({
        slot_id: "item-arrived",
        task_id: "item-arrived",
        state: "ready",
        task: expect.objectContaining({ id: "item-arrived" }),
      }),
    ]);
    expect(store.selectedItemId).toBe("item-arrived");
    expect(store.lastSelectedItemByRepo["repo-1"]).toBe("item-arrived");
  });

  it("does not steal selection back when the user leaves a creating slot", async () => {
    mockState.workflowItems = [mockState.makeItem({
      id: "item-existing",
      branch: "task-item-existing",
      prompt: "Stay here",
    })];
    const worktreeAddGate = mockState.defer();
    const store = await createStore();
    mockState.commandGates = { git_worktree_add: worktreeAddGate.promise };
    const persistSelection = vi.fn(async () => {});
    store.attachWindowWorkspace({
      bootstrap: { windowId: "test-window", selectedRepoId: "repo-1", selectedItemId: "item-existing" },
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
    await store.selectItem("item-existing");

    const createPromise = store.createItem(
      "repo-1",
      "/tmp/repo",
      "Create without stealing focus",
      "pty",
      { agentProvider: "claude" },
    );
    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "git_worktree_add",
        expect.objectContaining({ repoPath: "/tmp/repo" }),
      );
    });
    const creatingSlotId = store.currentTaskSlot!.slot_id;
    expect(creatingSlotId).toMatch(/^create:/);

    await store.selectItem("item-existing");
    worktreeAddGate.resolve();
    const taskId = await createPromise;

    expect(store.selectedItemId).toBe("item-existing");
    expect(store.selectedTaskId).toBe("item-existing");
    expect(store.lastSelectedItemByRepo["repo-1"]).toBe("item-existing");
    expect(store.taskUiSlots.filter((slot) => slot.task_id === taskId)).toEqual([
      expect.objectContaining({ slot_id: creatingSlotId, state: "ready" }),
    ]);
    expect(persistSelection).not.toHaveBeenCalledWith({
      selectedRepoId: "repo-1",
      selectedItemId: taskId,
    });
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

  it("spawns a referenced custom task agent instead of wrapping it in the default workflow agent", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          agent: "implement",
          prompt: "Implement this request: $TASK_PROMPT",
        },
      ],
    };
    const store = await createStore();

    await store.createItem("repo-1", "/tmp/repo", "Set up Kanna for this repository.", "agent", {
      customTask: {
        name: "Set Up Repository",
        agent: "setup",
        prompt: "Set up Kanna for this repository.",
        executionMode: "agent",
      },
    });

    await vi.waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith(
        "spawn_agent_session",
        expect.objectContaining({
          agentProvider: "codex",
          prompt: expect.stringContaining("setup agent prompt"),
        }),
      );
    });

    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_agent_session",
      expect.objectContaining({
        prompt: expect.not.stringContaining("implement agent prompt"),
      }),
    );
    expect(mockState.insertStageRunMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "in progress",
        agent: "setup",
        agent_provider: "codex",
      }),
    );
  });

  it("reruns stages through the local kanna-server action endpoint", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-existing",
        branch: "task-existing",
        stage: "in progress",
      }),
    ];

    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.items).toHaveLength(1);
    });

    await store.rerunStage("item-existing");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/item-existing/actions/rerun-stage",
      { method: "POST", headers: LOCAL_CREDENTIAL_HEADERS },
    );
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("run_script", expect.anything());
  });

  it("retries repo unhide undo through the server API after a failed attempt", async () => {
    mockState.repos = [
      mockState.makeRepo({ id: "repo-1", path: "/tmp/repo-1", name: "repo-1" }),
      mockState.makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2" }),
    ];
    const store = await createStore();
    await vi.waitFor(() => {
      expect(store.repos).toHaveLength(2);
    });

    await store.hideRepo("repo-2");
    expect(mockState.repos.find((repo) => repo.id === "repo-2")?.hidden).toBe(1);

    updateDesktopServerClientHandlersForTests({
      patchRepo: async () => {
        throw new Error("server unavailable");
      },
    });

    await store.undoClose();
    expect(mockState.repos.find((repo) => repo.id === "repo-2")?.hidden).toBe(1);

    updateDesktopServerClientHandlersForTests({
      patchRepo: async (repoId, input) => {
        const repo = mockState.repos.find((candidate) => candidate.id === repoId);
        if (!repo) return;
        if (input.hidden !== undefined) {
          repo.hidden = input.hidden ? 1 : 0;
        }
      },
    });

    await store.undoClose();
    expect(mockState.repos.find((repo) => repo.id === "repo-2")?.hidden).toBe(0);
  });

  it("assigns ports freshly on undo close instead of restoring the task's previous assignment", async () => {
    mockState.repoConfig = {
      ports: {
        KANNA_DEV_PORT: 1420,
        API_PORT: 3000,
      },
    };
    mockState.workflowItems = [
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

    const reopenedItem = mockState.workflowItems[0];
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
    mockState.workflowItems = [
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

    const reopenedItem = mockState.workflowItems[0];
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

  it("passes remote workspace env and PATH updates to identified worktree shell sessions", async () => {
    mockState.repoConfig = {
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
    mockState.workflowItems = [mockState.makeItem({
      id: "task-shell",
      branch: "task-shell",
    })];
    const store = await createStore();

    await store.spawnShellSession(
      "shell-wt-task-shell",
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
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
          TERM_PROGRAM: "kanna",
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
    mockState.workflowItems = [
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

  it("delegates missing worktree recreation to the server before respawning a reopened task", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-closed",
        branch: "task-closed",
        prompt: "continue e3d1fc75",
        closed_at: "2026-04-14T12:00:00.000Z",
        agent_type: "pty",
      }),
    ];
    const store = await createStore();

    await store.undoClose();

    expect(mockState.invokeMock).not.toHaveBeenCalledWith("file_exists", {
      path: "/tmp/repo/.kanna-worktrees/task-closed",
    });
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("git_worktree_add", expect.anything());
    expect(mockState.invokeMock).toHaveBeenCalledWith(
      "spawn_session",
      expect.objectContaining({
        sessionId: "item-closed",
        cwd: "/tmp/repo/.kanna-worktrees/task-closed",
      }),
    );
  });

  it("advances stages through the local kanna-server action endpoint", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
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

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/item-existing/actions/advance-stage",
      {
        method: "POST",
        headers: { ...LOCAL_CREDENTIAL_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "operator" }),
      },
    );
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("git_worktree_add", expect.anything());
  });

  it("does not advance a closed task even when its stage is still active", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "review", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
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
    expect(mockState.workflowItems[0]?.stage).toBe("review");
    expect(mockState.workflowItems[0]?.closed_at).toBe("2026-06-03 00:02:25");
  });

  it("keeps selection on the same task when the server advances it in place", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        mockState.workflowItems = [
          mockState.makeItem({
            id: "item-source",
            branch: "task-source",
            stage: "review",
          }),
        ];
        return { taskId: "item-source" };
      },
      text: async () => "",
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");

    expect(store.selectedItemId).toBe("item-source");
    expect(store.items.map((item) => item.id)).toEqual(["item-source"]);
  });

  it("shows the next stage immediately while server advance continues", async () => {
    const serverAdvanceGate = mockState.defer();
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
      }),
    ];
    fetchMock.mockImplementationOnce(async () => {
      await serverAdvanceGate.promise;
      mockState.workflowItems = [
        mockState.makeItem({
          id: "item-source",
          branch: "task-source",
          stage: "review",
        }),
      ];
      return {
        ok: true,
        json: async () => ({ taskId: "item-source" }),
        text: async () => "",
      };
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    const advancePromise = store.advanceStage("item-source");
    await flushStore();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/item-source/actions/advance-stage",
      {
        method: "POST",
        headers: { ...LOCAL_CREDENTIAL_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "operator" }),
      },
    );
    expect(store.currentItem?.stage).toBe("review");
    expect(store.sortedItemsForCurrentRepo.find((item) => item.id === "item-source")?.stage).toBe("review");

    serverAdvanceGate.resolve();
    await advancePromise;
  });

  it("keeps the next-stage projection when the detached server action returns before the snapshot advances", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "review", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        activity: "idle",
      }),
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ taskId: "item-source" }),
      text: async () => "",
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    const advancePromise = store.advanceStage("item-source");
    await flushStore();

    expect(store.currentItem?.stage).toBe("review");
    expect(store.currentItem?.activity).toBe("working");
    expect(store.sortedItemsForCurrentRepo.find((item) => item.id === "item-source")?.stage).toBe("review");

    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source-2",
        stage: "review",
        activity: "working",
      }),
    ];
    await advancePromise;

    expect(store.currentItem?.stage).toBe("review");
    expect(store.currentItem?.activity).toBe("working");
  });

  it("waits for a terminal-stage advance snapshot before restoring selection", async () => {
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        { name: "in progress", transition: "manual" },
        { name: "pr", transition: "manual" },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
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
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ taskId: "item-source" }),
      text: async () => "",
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    const advancePromise = store.advanceStage("item-source");
    await flushStore();

    expect(store.selectedItemId).toBe("item-source");

    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "pr",
        closed_at: "2026-04-14T00:03:00.000Z",
        created_at: "2026-04-14T00:02:00.000Z",
        updated_at: "2026-04-14T00:03:00.000Z",
      }),
      mockState.makeItem({
        id: "item-next",
        branch: "task-next",
        stage: "in progress",
        created_at: "2026-04-14T00:01:00.000Z",
        updated_at: "2026-04-14T00:01:00.000Z",
      }),
    ];

    await advancePromise;

    expect(store.selectedItemId).toBe("item-next");
  });

  it("keeps a post-stage advance on the current stage while post dispatch is in flight", async () => {
    const serverAdvanceGate = mockState.defer();
    mockState.workflowDefinition = {
      name: "default",
      stages: [
        {
          name: "in progress",
          policy: { transition: "manual" },
          post: { name: "commit" },
        },
        { name: "review", policy: { transition: "manual" } },
      ],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        active_post_action: null,
        has_running_post: 0,
      }),
    ];
    fetchMock.mockImplementationOnce(async () => {
      await serverAdvanceGate.promise;
      mockState.workflowItems = [
        mockState.makeItem({
          id: "item-source",
          branch: "task-source",
          stage: "in progress",
          active_post_action: null,
          has_running_post: 1,
        }),
      ];
      return {
        ok: true,
        json: async () => ({ taskId: "item-source" }),
        text: async () => "",
      };
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    const advancePromise = store.advanceStage("item-source");
    await flushStore();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(store.currentItem?.stage).toBe("in progress");
    expect(store.currentItem?.has_running_post).toBe(1);
    expect(store.currentItem?.active_post_action).toBe("commit");
    expect(store.sortedItemsForCurrentRepo.find((item) => item.id === "item-source")?.stage).toBe("in progress");

    serverAdvanceGate.resolve();
    await advancePromise;

    expect(store.currentItem?.stage).toBe("in progress");
    expect(store.currentItem?.has_running_post).toBe(1);
  });

  it("moves selection to the next visible item when the advance closes the task", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
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
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        mockState.workflowItems = [
          mockState.makeItem({
            id: "item-source",
            branch: "task-source",
            stage: "pr",
            closed_at: "2026-04-14T00:03:00.000Z",
          }),
          mockState.makeItem({
            id: "item-next",
            branch: "task-next",
            stage: "in progress",
            created_at: "2026-04-14T00:01:00.000Z",
            updated_at: "2026-04-14T00:01:00.000Z",
          }),
        ];
        return { taskId: "item-source", followTask: false };
      },
      text: async () => "",
    });

    const store = await createStore();
    await store.selectItem("item-source");
    await flushStore();

    await store.advanceStage("item-source");

    expect(store.selectedItemId).toBe("item-next");
  });

  it("shows the blocked-task toast when the server rejects stage advance with conflict", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-blocked",
        branch: "task-blocked",
        stage: "in progress",
      }),
    ];
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({}),
      text: async () => "task is blocked: item-blocked",
    });

    const store = await createStore();

    await store.advanceStage("item-blocked");

    expect(toastWarningMock).toHaveBeenCalledWith("Task Blocked");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("refreshes after the server reruns an active post-action", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-source",
        branch: "task-source",
        stage: "in progress",
        active_post_action: "commit",
      }),
    ];

    const store = await createStore();

    await store.rerunStage("item-source");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/item-source/actions/rerun-stage",
      { method: "POST", headers: LOCAL_CREDENTIAL_HEADERS },
    );
    expect(buildStagePrompt).not.toHaveBeenCalled();
  });

  it("does not auto-select a created task when selectOnCreate is false", async () => {
    mockState.workflowItems = [
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
    mockState.workflowItems = [
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

    const active = mockState.workflowItems.find((item) => item.id === "item-active");
    expect(active?.branch).toBe("task-item-active");
    expect(active?.agent_session_id).toBe("claude-item-active");
    expect(mockState.taskBlockers).toContainEqual({
      blocked_item_id: "item-active",
      blocker_item_id: "item-blocker",
    });
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

    mockState.workflowItems = [
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

    const blocked = mockState.workflowItems.find((item) => item.id === "item-blocked");
    expect(blocked?.branch).toBe("task-item-blocked");
    expect(mockState.removeTaskBlockerMock).toHaveBeenCalledWith(
      expect.anything(),
      "item-blocked",
      "item-blocker",
    );
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
    mockState.workflowItems = [
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

  it("delegates close cleanup to the server task action", async () => {
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-cleanup",
        branch: "task-item-cleanup",
      }),
    ];
    mockState.worktreeRows = [
      {
        pipeline_item_id: "item-cleanup",
        path: "/tmp/repo/.kanna-worktrees/task-item-cleanup",
        branch: "task-item-cleanup",
      },
    ];

    const store = await createStore();
    await store.selectItem("item-cleanup");
    await flushStore();

    await store.closeTask();
    await flushStore();

    expect(mockState.invokeMock.mock.calls.some(([command, args]) =>
      command === "run_script" &&
      typeof args?.script === "string" &&
      args.script.includes("WIP at task close")
    )).toBe(false);
    expect(mockState.workflowItems[0]?.closed_at).toBe(mockState.makeItem().updated_at);
  });

  it("marks a task as tearing down before spawning its teardown session", async () => {
    mockState.repoConfig = {
      teardown: ["pnpm cleanup"],
    };
    mockState.workflowItems = [
      mockState.makeItem({
        id: "item-teardown",
        branch: "task-item-teardown",
      }),
    ];

    const store = await createStore();
    await store.selectItem("item-teardown");
    await flushStore();

    await store.closeTask();
    await flushStore();

    const teardownSpawnCallIndex = mockState.invokeMock.mock.calls.findIndex(
      ([command, args]) =>
        command === "spawn_session" &&
        args?.sessionId === "td-item-teardown",
    );
    expect(teardownSpawnCallIndex).toBeGreaterThanOrEqual(0);

    const markOrder = mockState.markPipelineItemTearingDownMock.mock.invocationCallOrder[0];
    const teardownSpawnOrder = mockState.invokeMock.mock.invocationCallOrder[teardownSpawnCallIndex];

    expect(markOrder).toBeLessThan(teardownSpawnOrder);
  });

  it("kills SDK agent sessions before running teardown commands", async () => {
    mockState.repoConfig = {
      teardown: ["pnpm cleanup"],
      ports: {
        KANNA_DEV_PORT: 1420,
      },
    };
    mockState.workflowItems = [
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

    mockState.workflowItems = [
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
