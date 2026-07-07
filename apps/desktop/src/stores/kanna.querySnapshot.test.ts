import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "../types/kanna";

const beginTaskSwitchMock = vi.hoisted(() => vi.fn());
const invalidateSharedDataMock = vi.hoisted(() => vi.fn(async () => {}));
const onSharedInvalidationMock = vi.hoisted(() => vi.fn(async () => () => undefined));

const mockState = vi.hoisted(() => {
  const now = "2026-04-17T00:00:00.000Z";

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    const id = overrides.id ?? "repo-1";
    return {
      id,
      path: overrides.path ?? `/tmp/${id}`,
      name: overrides.name ?? id,
      default_branch: "main",
      hidden: 0,
      sort_order: 0,
      created_at: now,
      last_opened_at: now,
      ...overrides,
    };
  }

  function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
    const id = overrides.id ?? "item-1";
    const repoId = overrides.repo_id ?? "repo-1";
    return {
      id,
      repo_id: repoId,
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
      branch: overrides.branch ?? `task-${id}`,
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

  let allRepos: Repo[] = [];
  let pipelineItems: PipelineItem[] = [];

  const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "ensure_term_init":
      case "list_sessions":
      case "get_app_data_dir":
      case "spawn_session":
      case "attach_session_with_snapshot":
      case "signal_session":
      case "kill_session":
      case "get_pipeline_socket_path":
        return [];
      case "file_exists":
        return true;
      case "read_text_file":
        if (typeof args?.path === "string" && args.path.endsWith("/.kanna/config.json")) {
          return "{}";
        }
        throw new Error("missing");
      case "which_binary":
        return "/usr/bin/claude";
      case "git_default_branch":
        return "main";
      case "ensure_directory":
      case "git_init":
      case "git_clone":
        return undefined;
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  });
  const listReposMock = vi.fn(async () => allRepos.filter((repo) => !repo.hidden));
  const listPipelineItemsMock = vi.fn(async (_db: DbHandle, repoId: string) =>
    pipelineItems.filter((item) => item.repo_id === repoId),
  );
  const listTaskBlockersMock = vi.fn(async () => []);
  const getSettingMock = vi.fn(async () => null);
  const getUnblockedItemsMock = vi.fn(async () => []);

  function reset(): void {
    allRepos = [
      makeRepo({ id: "repo-1", path: "/tmp/repo-1", name: "repo-1", hidden: 0 }),
      makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2", hidden: 0 }),
    ];
    pipelineItems = [
      makeItem({ id: "item-1", repo_id: "repo-1" }),
      makeItem({ id: "item-2", repo_id: "repo-2" }),
    ];
    invokeMock.mockClear();
    listReposMock.mockClear();
    listPipelineItemsMock.mockClear();
    listTaskBlockersMock.mockClear();
    getSettingMock.mockClear();
    getUnblockedItemsMock.mockClear();
  }

  reset();

  return {
    get allRepos() {
      return allRepos;
    },
    set allRepos(value: Repo[]) {
      allRepos = value;
    },
    get visibleRepos() {
      return allRepos.filter((repo) => !repo.hidden);
    },
    get pipelineItems() {
      return pipelineItems;
    },
    set pipelineItems(value: PipelineItem[]) {
      pipelineItems = value;
    },
    makeRepo,
    makeItem,
    invokeMock,
    listReposMock,
    listPipelineItemsMock,
    listTaskBlockersMock,
    getSettingMock,
    getUnblockedItemsMock,
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
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@kanna/core", () => ({
  parseRepoConfig: vi.fn(() => ({})),
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
  parsePipelineJson: vi.fn(() => ({
    name: "default",
    stages: [],
  })),
}));

vi.mock("../../../../packages/core/src/pipeline/prompt-builder", () => ({
  buildStagePrompt: vi.fn(() => "Stage prompt"),
}));

vi.mock("../composables/useToast", () => ({
  useToast: () => ({
    error: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("../composables/terminalSessionRecovery", () => ({
  buildTaskShellCommand: vi.fn(() => "agent-command"),
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
  closePipelineItemAndClearCachedTerminalState: vi.fn(async () => {}),
  getTaskIdFromTeardownSessionId: vi.fn(() => null),
  isTeardownSessionId: vi.fn(() => false),
  reportCloseSessionError: vi.fn(),
  reportPrewarmSessionError: vi.fn(),
  shouldAutoCloseTaskAfterTeardownExit: vi.fn(() => false),
  shouldAutoCloseTaskImmediatelyAfterEnteringTeardown: vi.fn(() => false),
  shouldClearCachedTerminalStateOnSessionExit: vi.fn(() => false),
}));

vi.mock("./agent-provider", () => ({
  getPreferredAgentProviders: vi.fn(() => "claude"),
  requireResolvedAgentProvider: vi.fn((provider?: string) => provider ?? "claude"),
  resolveAgentProvider: vi.fn((provider?: string | string[]) => Array.isArray(provider) ? provider[0] : (provider ?? "claude")),
}));

vi.mock("./taskCreationPlaceholder", () => ({
  buildPendingTaskPlaceholder: vi.fn(),
}));

vi.mock("./portAllocationLog", () => ({
  formatTaskPortAllocationLog: vi.fn(() => ""),
}));

vi.mock("./taskCloseBehavior", () => ({
  getTaskCloseBehavior: vi.fn(() => "close"),
}));

vi.mock("./taskCloseSelection", () => ({
  shouldSelectNextOnCloseTransition: vi.fn(() => true),
}));

vi.mock("./taskShellPrewarm", () => ({
  shouldPrewarmTaskShellOnCreate: vi.fn(() => false),
}));

vi.mock("./taskRuntimeStatus", () => ({
  resolveActivityForRuntimeStatus: vi.fn(() => null),
  shouldIgnoreRuntimeStatusDuringSetup: vi.fn(() => false),
}));

vi.mock("../perf/taskSwitchPerf", () => ({
  beginTaskSwitch: (...args: unknown[]) => beginTaskSwitchMock(...args),
}));

vi.mock("./agent-permissions", () => ({
  getAgentPermissionFlags: vi.fn(() => []),
}));

vi.mock("./taskBaseBranch", () => ({
  getCreateWorktreeStartPoint: vi.fn(() => "main"),
  resolveInitialBaseRef: vi.fn(() => "origin/main"),
}));

vi.mock("./db", () => ({
  resolveDbName: vi.fn(() => "kanna.db"),
}));

vi.mock("./kannaCliEnv", () => ({
  buildKannaCliEnv: vi.fn(() => ({})),
}));

vi.mock("../i18n", () => ({
  default: {
    global: {
      t: (key: string) => key,
    },
  },
}));

vi.mock("@kanna/" + "db", () => ({
  listRepos: mockState.listReposMock,
  insertRepo: vi.fn(async (_db: DbHandle, repo: Repo) => {
    mockState.allRepos = [...mockState.allRepos, repo];
  }),
  findRepoByPath: vi.fn(async (_db: DbHandle, path: string) =>
    mockState.allRepos.find((repo) => repo.path === path) ?? null,
  ),
  hideRepo: vi.fn(async (_db: DbHandle, repoId: string) => {
    mockState.allRepos = mockState.allRepos.map((repo) =>
      repo.id === repoId ? { ...repo, hidden: 1 } : repo,
    );
  }),
  unhideRepo: vi.fn(async (_db: DbHandle, repoId: string) => {
    mockState.allRepos = mockState.allRepos.map((repo) =>
      repo.id === repoId ? { ...repo, hidden: 0 } : repo,
    );
  }),
  listPipelineItems: mockState.listPipelineItemsMock,
  listTaskBlockers: mockState.listTaskBlockersMock,
  insertPipelineItem: vi.fn(async () => {}),
  updatePipelineItemActivity: vi.fn(async () => {}),
  markPipelineItemTearingDown: vi.fn(async () => {}),
  updatePipelineItemStage: vi.fn(async () => {}),
  pinPipelineItem: vi.fn(async () => {}),
  unpinPipelineItem: vi.fn(async () => {}),
  reorderPinnedItems: vi.fn(async () => {}),
  updatePipelineItemDisplayName: vi.fn(async () => {}),
  clearPipelineItemStageResult: vi.fn(async () => {}),
  clearPipelineItemActivePostAction: vi.fn(async () => {}),
  closePipelineItem: vi.fn(async () => {}),
  reopenPipelineItem: vi.fn(async () => {}),
  getRepo: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.allRepos.find((repo) => repo.id === repoId) ?? null,
  ),
  getSetting: mockState.getSettingMock,
  setSetting: vi.fn(async () => {}),
  insertTaskBlocker: vi.fn(async () => {}),
  removeTaskBlocker: vi.fn(async () => {}),
  removeAllBlockersForItem: vi.fn(async () => {}),
  listBlockersForItem: vi.fn(async () => []),
  listBlockedByItem: vi.fn(async () => []),
  getUnblockedItems: mockState.getUnblockedItemsMock,
  hasCircularDependency: vi.fn(async () => false),
  insertOperatorEvent: vi.fn(async () => {}),
  updateAgentSessionId: vi.fn(async () => {}),
  listTaskPorts: vi.fn(async () => []),
  listTaskPortsForItem: vi.fn(async () => []),
  deleteTaskPortsForItem: vi.fn(async () => {}),
}));

import { useKannaStore } from "./kanna";
import {
  setDesktopSnapshotFetcherForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async () => []),
  };
}

async function flushStore(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function createStore(db: DbHandle = createDb()) {
  setActivePinia(createPinia());
  const store = useKannaStore();
  store.attachWindowWorkspace({
    bootstrap: {
      windowId: "main",
      selectedRepoId: null,
      selectedItemId: null,
    },
    loadSnapshot: vi.fn(async () => ({ windows: [] })),
    saveSnapshot: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
    persistSelection: vi.fn(async () => {}),
    persistSidebarHidden: vi.fn(async () => {}),
    persistSidebarWidth: vi.fn(async () => {}),
    invalidateSharedData: invalidateSharedDataMock,
    restoreAdditionalWindows: vi.fn(async () => {}),
    onSharedInvalidation: onSharedInvalidationMock,
  });
  await store.init(db);
  await flushStore();
  return store;
}

describe("kanna query snapshot regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
    mockState.reset();
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: mockState.visibleRepos.map((repo) => ({
        repo,
        items: mockState.pipelineItems.filter((item) => item.repo_id === repo.id),
      })),
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    updateDesktopServerClientHandlersForTests({
      findRepoByPath: async (path) =>
        mockState.allRepos.find((repo) => repo.path === path) as never ?? null,
      addRepo: async ({ path, name }) => {
        const repo = mockState.makeRepo({
          id: `repo-${mockState.allRepos.length + 1}`,
          path,
          name: name ?? path.split("/").pop() ?? "repo",
          hidden: 0,
        });
        mockState.allRepos = [...mockState.allRepos, repo];
        return repo as never;
      },
      patchRepo: async (repoId, input) => {
        mockState.allRepos = mockState.allRepos.map((repo) =>
          repo.id === repoId
            ? {
                ...repo,
                hidden: input.hidden === undefined ? repo.hidden : (input.hidden ? 1 : 0),
                remote_url: input.remoteUrl === undefined ? repo.remote_url : input.remoteUrl,
                remote_url_hash: input.remoteUrlHash === undefined ? repo.remote_url_hash : input.remoteUrlHash,
              }
            : repo,
        );
      },
    });
    beginTaskSwitchMock.mockReset();
    invalidateSharedDataMock.mockReset();
    onSharedInvalidationMock.mockReset();
    mockState.listReposMock.mockClear();
    mockState.listPipelineItemsMock.mockClear();
    mockState.listTaskBlockersMock.mockClear();
    mockState.getSettingMock.mockClear();
    mockState.getUnblockedItemsMock.mockClear();
  });

  afterEach(() => {
    setDesktopSnapshotFetcherForTests(async () => ({
      entries: [],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    }));
    vi.useRealTimers();
  });

  it("removes a hidden repo and its tasks from the visible store state together", async () => {
    const store = await createStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);

    await store.hideRepo("repo-2");
    await flushStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1"]);
  });

  it("hydrates the startup snapshot without direct database reads", async () => {
    const db = createDb();
    const store = await createStore(db);

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    expect(mockState.listReposMock).not.toHaveBeenCalled();
    expect(mockState.listPipelineItemsMock).not.toHaveBeenCalled();
    expect(mockState.listTaskBlockersMock).not.toHaveBeenCalled();
    expect(mockState.getSettingMock).not.toHaveBeenCalled();
    expect(mockState.getUnblockedItemsMock).not.toHaveBeenCalled();
    expect(db["select"]).not.toHaveBeenCalled();
  });

  it("restores an unhidden repo with its tasks from the same refresh path", async () => {
    mockState.allRepos = [
      mockState.makeRepo({ id: "repo-1", path: "/tmp/repo-1", name: "repo-1", hidden: 0 }),
      mockState.makeRepo({ id: "repo-2", path: "/tmp/repo-2", name: "repo-2", hidden: 1 }),
    ];
    const store = await createStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1"]);

    await store.importRepo("/tmp/repo-2", "repo-2", "main");
    await flushStore();

    expect(store.repos.map((repo) => repo.id)).toEqual(["repo-1", "repo-2"]);
    expect(store.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  });

  it("history navigation skips tasks from repos that are no longer visible", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");
    await vi.advanceTimersByTimeAsync(1001);
    store.selectedRepoId = "repo-2";
    await store.selectItem("item-2");
    await flushStore();

    await store.hideRepo("repo-2");
    await flushStore();

    store.goBack();
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-1");
    expect(store.currentItem?.id).toBe("item-1");
  });

  it("records cross-repo task selection history when the previous task is provided explicitly", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");
    await vi.advanceTimersByTimeAsync(1001);

    await store.selectRepo("repo-2");
    await store.selectItem("item-2", { previousItemId: "item-1" });
    await flushStore();

    store.goBack();
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-1");
    expect(store.currentItem?.id).toBe("item-1");

    store.goForward();
    await flushStore();

    expect(store.selectedRepo?.id).toBe("repo-2");
    expect(store.currentItem?.id).toBe("item-2");
  });

  it("begins a task-switch perf record when selecting a PTY task", async () => {
    const store = await createStore();

    await store.selectRepo("repo-1");
    await store.selectItem("item-1");

    expect(beginTaskSwitchMock).toHaveBeenCalledWith("item-1");
  });

  it("emits a shared invalidation after hiding a repo", async () => {
    const store = await createStore();

    await store.hideRepo("repo-2");

    expect(invalidateSharedDataMock).toHaveBeenCalledWith("hideRepo");
  });
});
