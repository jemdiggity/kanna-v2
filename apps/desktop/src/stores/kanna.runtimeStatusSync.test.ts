import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "../types/kanna";
import { forwardTerminalRuntimeStatus } from "../composables/terminalRuntimeStatusSink";
import { acknowledgeTaskUiSlot, buildCreatingTaskUiSlot } from "./taskUiSlots";

const mockState = vi.hoisted(() => {
  const now = "2026-04-16T00:00:00.000Z";
  const updateAgentSessionIdMock = vi.fn(async () => {});
  const putTaskAgentSessionMock = vi.fn(async () => {});

  function makeRepo(overrides: Partial<Repo> = {}): Repo {
    return {
      id: "repo-1",
      path: "/tmp/repo",
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
      id: "task-1",
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
      branch: "task-task-1",
      closed_at: null,
      agent_type: "pty",
      agent_provider: "claude",
      activity: "working",
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
  let workflowItems = [makeItem()];
  let worktreeRows: Array<{ pipeline_item_id: string; path: string; branch: string }> = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();

  const invokeMock = vi.fn(async (command: string) => {
    switch (command) {
      case "list_dir":
        return [];
      case "spawn_session":
      case "ensure_term_init":
      case "get_app_data_dir":
      case "get_workflow_socket_path":
      case "run_script":
        return undefined;
      case "file_exists":
        return true;
      case "read_text_file":
        return "{}";
      case "which_binary":
        return "/usr/bin/claude";
      default:
        throw new Error(`unexpected invoke: ${command}`);
    }
  });

  const listenMock = vi.fn(async (event: string, handler: (event: unknown) => void) => {
    const handlers = listeners.get(event) ?? [];
    handlers.push(handler);
    listeners.set(event, handlers);
    return () => {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((candidate) => candidate !== handler),
      );
    };
  });

  const updatePipelineItemActivityMock = vi.fn(async (_db: DbHandle, itemId: string, activity: PipelineItem["activity"]) => {
    const item = workflowItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.activity = activity;
    item.activity_changed_at = now;
    item.updated_at = now;
  });

  const fetchSnapshotMock = vi.fn(async () => ({
    entries: repos.map((repo) => ({
      repo,
      items: workflowItems.filter((item) => item.repo_id === repo.id && item.closed_at === null),
    })),
    taskBlockers: [],
    worktreePaths: {},
    settings: {},
  }));

  function emit(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) {
      handler({ payload });
    }
  }

  function reset(): void {
    repos = [makeRepo()];
    workflowItems = [makeItem()];
    worktreeRows = [];
    listeners.clear();
    invokeMock.mockClear();
    listenMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
    fetchSnapshotMock.mockClear();
  }

  return {
    makeItem,
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
    get worktreeRows() {
      return worktreeRows;
    },
    set worktreeRows(value: Array<{ pipeline_item_id: string; path: string; branch: string }>) {
      worktreeRows = value;
    },
    invokeMock,
    listenMock,
    updatePipelineItemActivityMock,
    fetchSnapshotMock,
    updateAgentSessionIdMock,
    putTaskAgentSessionMock,
    emit,
    reset,
  };
});

const cleanupMocks = vi.hoisted(() => ({
  closePipelineItemAndClearCachedTerminalState: vi.fn(async (
    itemId: string,
    closePipelineItem: (itemId: string) => Promise<unknown>,
  ) => {
    await closePipelineItem(itemId);
  }),
  getTaskIdFromTeardownSessionId: vi.fn((sessionId: string) =>
    sessionId.startsWith("td-") ? sessionId.slice(3) || null : null,
  ),
  isTeardownSessionId: vi.fn((sessionId: string) => sessionId.startsWith("td-")),
  reportCloseSessionError: vi.fn(),
  reportPrewarmSessionError: vi.fn(),
  shouldAutoCloseTaskAfterTeardownExit: vi.fn(({ exitCode, lingerEnabled }: { exitCode: number | null; lingerEnabled: boolean }) =>
    exitCode === 0 && !lingerEnabled,
  ),
  shouldAutoCloseTaskImmediatelyAfterEnteringTeardown: vi.fn(() => false),
  shouldClearCachedTerminalStateOnSessionExit: vi.fn(() => false),
}));

vi.mock("../invoke", () => ({
  invoke: mockState.invokeMock,
}));

vi.mock("../tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("../listen", () => ({
  listen: mockState.listenMock,
}));

vi.mock("@kanna/core", () => ({
  parseRepoConfig: vi.fn(() => ({})),
  parseAgentMd: vi.fn(() => null),
  DEFAULT_STAGE_ORDER: ["pr", "review", "in progress"],
}));

vi.mock("../../../../packages/core/src/workflow/agent-loader", () => ({
  parseAgentDefinition: vi.fn(() => ({
    name: "agent",
    description: "agent",
    prompt: "Agent prompt",
  })),
}));

vi.mock("../../../../packages/core/src/workflow/workflow-loader", () => ({
  parseWorkflowJson: vi.fn(() => ({
    name: "default",
    stages: [],
  })),
}));

vi.mock("../../../../packages/core/src/workflow/prompt-builder", () => ({
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
  ...cleanupMocks,
}));

vi.mock("./agent-provider", () => ({
  normalizeAgentProviderCandidates: vi.fn((providers?: string | string[]) =>
    providers == null ? [] : (Array.isArray(providers) ? providers : [providers])),
  getPreferredAgentProviders: vi.fn(() => "claude"),
  requireResolvedAgentProvider: vi.fn((provider?: string) => provider ?? "claude"),
  resolveAgentProvider: vi.fn((provider?: string | string[]) => Array.isArray(provider) ? provider[0] : (provider ?? "claude")),
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
  listRepos: vi.fn(async () => mockState.repos),
  insertRepo: vi.fn(async () => {}),
  findRepoByPath: vi.fn(async () => null),
  hideRepo: vi.fn(async () => {}),
  unhideRepo: vi.fn(async () => {}),
  listPipelineItems: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.workflowItems.filter((item) => item.repo_id === repoId),
  ),
  listTaskBlockers: vi.fn(async () => []),
  insertPipelineItem: vi.fn(async () => {}),
  updatePipelineItemActivity: mockState.updatePipelineItemActivityMock,
  markPipelineItemTearingDown: vi.fn(async () => {}),
  updatePipelineItemStage: vi.fn(async () => {}),
  pinPipelineItem: vi.fn(async () => {}),
  unpinPipelineItem: vi.fn(async () => {}),
  reorderPinnedItems: vi.fn(async () => {}),
  updatePipelineItemDisplayName: vi.fn(async () => {}),
  clearPipelineItemStageResult: vi.fn(async () => {}),
  clearPipelineItemActivePostAction: vi.fn(async () => {}),
  closePipelineItem: vi.fn(async (_db: DbHandle, itemId: string) => {
    const item = mockState.workflowItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.teardown_started_at = null;
    item.closed_at = "2026-04-16T00:00:00.000Z";
    item.updated_at = "2026-04-16T00:00:00.000Z";
  }),
  reopenPipelineItem: vi.fn(async () => {}),
  getRepo: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.repos.find((repo) => repo.id === repoId) ?? null,
  ),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  insertTaskBlocker: vi.fn(async () => {}),
  removeTaskBlocker: vi.fn(async () => {}),
  removeAllBlockersForItem: vi.fn(async () => {}),
  listBlockersForItem: vi.fn(async () => []),
  listBlockedByItem: vi.fn(async () => []),
  getUnblockedItems: vi.fn(async () => []),
  hasCircularDependency: vi.fn(async () => false),
  insertOperatorEvent: vi.fn(async () => {}),
  updateAgentSessionId: mockState.updateAgentSessionIdMock,
  listTaskPorts: vi.fn(async () => []),
  listTaskPortsForItem: vi.fn(async () => []),
  deleteTaskPortsForItem: vi.fn(async () => {}),
}));

import { useKannaStore } from "./kanna";
import {
  setDesktopSnapshotFetcherForTests,
  setDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

function createDb(): DbHandle {
  return {
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "DELETE FROM worktree WHERE pipeline_item_id = ?") {
        const itemId = typeof params?.[0] === "string" ? params[0] : null;
        mockState.worktreeRows = mockState.worktreeRows.filter((row) => row.pipeline_item_id !== itemId);
      }
      return { rowsAffected: 1 };
    }),
    select: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT agent_provider FROM pipeline_item")) {
        const itemId = typeof params?.[0] === "string" ? params[0] : null;
        const item = itemId
          ? mockState.workflowItems.find((candidate) => candidate.id === itemId)
          : null;
        return item ? [{ agent_provider: item.agent_provider }] : [];
      }
      if (sql === "SELECT path FROM worktree WHERE pipeline_item_id = ?") {
        const itemId = typeof params?.[0] === "string" ? params[0] : null;
        return mockState.worktreeRows
          .filter((row) => row.pipeline_item_id === itemId)
          .map((row) => ({ path: row.path }));
      }
      if (sql === "SELECT id FROM pipeline_item WHERE id = ? LIMIT 1") {
        const itemId = typeof params?.[0] === "string" ? params[0] : null;
        return mockState.workflowItems.some((item) => item.id === itemId) ? [{ id: itemId }] : [];
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
  mockState.updatePipelineItemActivityMock.mockClear();
  return store;
}

describe("kanna runtime status reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.reset();
    setDesktopSnapshotFetcherForTests(mockState.fetchSnapshotMock);
    setDesktopServerClientHandlersForTests({
      getSetting: async () => null,
      deleteSetting: async () => {},
      putSetting: async (key, value) => ({ key, value }),
      postOperatorEvents: async () => {},
      fetchRepoKannaDefinitions: async () => ({
        revision: "remote-rev",
        refName: "origin/main",
        config: {},
        defaultWorkflow: "default",
        workflows: ["default"],
      }),
      releaseTaskPorts: async () => {},
      closeTask: async (taskId) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (item) {
          item.closed_at = "2026-04-16T00:00:00.000Z";
          item.updated_at = "2026-04-16T00:00:00.000Z";
        }
      },
      applyTaskRuntimeStatus: async (taskId, input) => {
        const item = mockState.workflowItems.find((candidate) => candidate.id === taskId);
        if (!item || item.closed_at != null) return { taskId, activity: null };
        let activity: PipelineItem["activity"] | null = null;
        if (input.status === "busy" && item.activity !== "working") {
          activity = "working";
        } else if (input.status === "idle" || input.status === "waiting") {
          if (input.selected && (item.activity === "working" || item.activity === "unread")) {
            activity = "idle";
          } else if (!input.selected && item.activity === "working") {
            activity = "unread";
          }
        }
        if (activity) {
          await mockState.updatePipelineItemActivityMock(expect.anything(), taskId, activity);
        }
        return { taskId, activity };
      },
      putTaskAgentSession: async (taskId, agentSessionId) => {
        await mockState.putTaskAgentSessionMock(taskId, agentSessionId);
      },
    });
    cleanupMocks.closePipelineItemAndClearCachedTerminalState.mockClear();
    cleanupMocks.getTaskIdFromTeardownSessionId.mockClear();
    cleanupMocks.isTeardownSessionId.mockClear();
    cleanupMocks.reportCloseSessionError.mockClear();
    cleanupMocks.reportPrewarmSessionError.mockClear();
    cleanupMocks.shouldAutoCloseTaskAfterTeardownExit.mockClear();
    cleanupMocks.shouldAutoCloseTaskImmediatelyAfterEnteringTeardown.mockClear();
    cleanupMocks.shouldClearCachedTerminalStateOnSessionExit.mockClear();
    mockState.updateAgentSessionIdMock.mockClear();
    mockState.putTaskAgentSessionMock.mockClear();
  });

  it("does not register or poll the removed legacy runtime-status path", async () => {
    await createStore();

    expect(mockState.listenMock).not.toHaveBeenCalledWith(
      "status_changed",
      expect.any(Function),
    );
    mockState.invokeMock.mockClear();
    mockState.emit("daemon_ready", {});
    mockState.emit("session_created", { session_id: "task-1" });
    await flushStore();
    expect(mockState.invokeMock).not.toHaveBeenCalledWith("list_sessions");
  });

  it("reconciles KSP terminal busy status to working", async () => {
    await createStore();
    mockState.workflowItems[0]!.activity = "idle";

    await forwardTerminalRuntimeStatus("task-1", "busy");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "working",
    );
    expect(mockState.workflowItems[0]?.activity).toBe("working");
  });

  it("reconciles KSP terminal idle status to idle when selected", async () => {
    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-1");
    await flushStore();
    mockState.workflowItems[0]!.activity = "working";

    await forwardTerminalRuntimeStatus("task-1", "idle");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "idle",
    );
  });

  it("reconciles KSP terminal idle status to unread when unselected", async () => {
    await createStore();
    mockState.workflowItems[0]!.activity = "working";

    await forwardTerminalRuntimeStatus("task-1", "idle");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "unread",
    );
  });

  it("repairs watcher unread from an attach gap with queued selected idle status", async () => {
    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-1");
    await flushStore();
    mockState.workflowItems[0]!.activity = "working";

    // During an initial/reconnect gap the server-side watcher has no lease
    // and conservatively applies the unattached working -> unread rule.
    mockState.workflowItems[0]!.activity = "unread";

    // AttachSnapshot queues StatusChanged(current) after the snapshot. The
    // selected client replays that idle status and repairs the gap write.
    await forwardTerminalRuntimeStatus("task-1", "idle");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "idle",
    );
    expect(mockState.workflowItems[0]?.activity).toBe("idle");
  });

  it("keeps the pending-setup guard on KSP terminal idle status", async () => {
    const store = await createStore();
    store.taskUiSlots.splice(
      0,
      store.taskUiSlots.length,
      ...acknowledgeTaskUiSlot(
        [buildCreatingTaskUiSlot({
          slotId: "create:task-1",
          repoId: "repo-1",
          prompt: "Ship it",
          agentType: "pty",
          requestedAgentProviders: "claude",
        })],
        "create:task-1",
        "task-1",
      ),
    );
    mockState.workflowItems[0]!.activity = "working";

    await forwardTerminalRuntimeStatus("task-1", "idle");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalled();
    expect(mockState.workflowItems[0]?.activity).toBe("working");
  });

  it("keeps the closed-task guard on KSP terminal status", async () => {
    mockState.workflowItems = [{
      ...mockState.workflowItems[0]!,
      closed_at: "2026-06-06 05:38:31",
      activity: "idle",
    }];
    await createStore();

    await forwardTerminalRuntimeStatus("task-1", "busy");
    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalled();
    expect(mockState.workflowItems[0]?.activity).toBe("idle");
  });

  it("reconciles busy status from a forked workspace branch to the durable task", async () => {
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        id: "5aa7c7ec",
        branch: "task-5aa7c7ec-7",
        stage: "pr",
        agent_provider: "codex",
        activity: "idle",
      },
    ];

    await createStore();
    await flushStore();

    await forwardTerminalRuntimeStatus("task-5aa7c7ec-7", "busy");

    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "5aa7c7ec",
      "working",
    );
    expect(mockState.workflowItems[0]?.activity).toBe("working");
  });

  it("keeps an exited task read when another open window has it selected", async () => {
    const store = await createStore();
    store.attachWindowWorkspace({
      bootstrap: {
        windowId: "window-a",
        selectedRepoId: "repo-1",
        selectedItemId: null,
      },
      loadSnapshot: vi.fn(async () => ({
        windows: [
          {
            windowId: "window-a",
            selectedRepoId: "repo-1",
            selectedItemId: null,
            sidebarHidden: false,
            sidebarWidth: 260,
            order: 0,
          },
          {
            windowId: "window-b",
            selectedRepoId: "repo-1",
            selectedItemId: "task-1",
            sidebarHidden: false,
            sidebarWidth: 260,
            order: 1,
          },
        ],
      })),
      saveSnapshot: vi.fn(async () => {}),
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      destroyNativeWindow: vi.fn(async () => {}),
      forgetCurrentWindow: vi.fn(async () => {}),
      persistSelection: vi.fn(async () => {}),
      persistSidebarHidden: vi.fn(async () => {}),
      persistSidebarWidth: vi.fn(async () => {}),
      invalidateSharedData: vi.fn(async () => {}),
      restoreAdditionalWindows: vi.fn(async () => {}),
      onSharedInvalidation: vi.fn(async () => vi.fn()),
    });
    await flushStore();
    mockState.workflowItems[0]!.activity = "working";

    mockState.emit("session_exit", {
      session_id: "task-1",
      code: 0,
      resume_session_id: null,
    });

    await flushStore();

    await vi.waitFor(() => {
      expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
        expect.anything(),
        "task-1",
        "idle",
      );
    });
    expect(mockState.workflowItems[0]?.activity).toBe("idle");
  });

  it("keeps an exited forked workspace task read when another open window has it selected", async () => {
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        id: "5aa7c7ec",
        branch: "task-5aa7c7ec-7",
        stage: "pr",
        agent_provider: "codex",
        activity: "working",
      },
    ];
    const store = await createStore();
    store.attachWindowWorkspace({
      bootstrap: {
        windowId: "window-a",
        selectedRepoId: "repo-1",
        selectedItemId: null,
      },
      loadSnapshot: vi.fn(async () => ({
        windows: [
          {
            windowId: "window-a",
            selectedRepoId: "repo-1",
            selectedItemId: null,
            sidebarHidden: false,
            sidebarWidth: 260,
            order: 0,
          },
          {
            windowId: "window-b",
            selectedRepoId: "repo-1",
            selectedItemId: "5aa7c7ec",
            sidebarHidden: false,
            sidebarWidth: 260,
            order: 1,
          },
        ],
      })),
      saveSnapshot: vi.fn(async () => {}),
      openWindow: vi.fn(async () => {}),
      closeWindow: vi.fn(async () => {}),
      destroyNativeWindow: vi.fn(async () => {}),
      forgetCurrentWindow: vi.fn(async () => {}),
      persistSelection: vi.fn(async () => {}),
      persistSidebarHidden: vi.fn(async () => {}),
      persistSidebarWidth: vi.fn(async () => {}),
      invalidateSharedData: vi.fn(async () => {}),
      restoreAdditionalWindows: vi.fn(async () => {}),
      onSharedInvalidation: vi.fn(async () => vi.fn()),
    });
    await flushStore();
    mockState.workflowItems[0]!.activity = "working";
    expect(store.items[0]).toMatchObject({
      id: "5aa7c7ec",
      branch: "task-5aa7c7ec-7",
      activity: "working",
    });

    mockState.emit("session_exit", {
      session_id: "task-5aa7c7ec-7",
      code: 0,
      resume_session_id: null,
    });

    await flushStore();

    await vi.waitFor(() => {
      expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
        expect.anything(),
        "5aa7c7ec",
        "idle",
      );
    });
    expect(mockState.workflowItems[0]?.activity).toBe("idle");
  });

  it("ignores session exits for closed tasks", async () => {
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        stage: "done",
        closed_at: "2026-06-06 05:38:31",
        activity: "idle",
      },
    ];

    await createStore();
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "task-1",
      code: 0,
      resume_session_id: null,
    });

    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "unread",
    );
    expect(mockState.workflowItems[0]?.activity).toBe("idle");
  });

  it("persists codex resume session ids through the server client from the frontend session_exit path", async () => {
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        agent_provider: "codex",
      },
    ];

    await createStore();
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "task-1",
      code: 0,
      resume_session_id: "019d99a5-aa94-7c73-b786-644cc095c037",
    });

    await flushStore();

    expect(mockState.putTaskAgentSessionMock).toHaveBeenCalledWith(
      "task-1",
      "019d99a5-aa94-7c73-b786-644cc095c037",
    );
    expect(mockState.updateAgentSessionIdMock).not.toHaveBeenCalled();
  });

  it("selects the next task in the same repo when the selected teardown task auto-closes", async () => {
    mockState.repos = [
      {
        ...mockState.repos[0]!,
        id: "repo-1",
        path: "/tmp/repo-1",
        name: "repo-1",
      },
      {
        ...mockState.repos[0]!,
        id: "repo-2",
        path: "/tmp/repo-2",
        name: "repo-2",
      },
    ];
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        id: "task-closing",
        repo_id: "repo-1",
        stage: "in progress",
        teardown_started_at: "2026-04-16T00:04:00.000Z",
        created_at: "2026-04-16T00:03:00.000Z",
      },
      {
        ...mockState.workflowItems[0]!,
        id: "task-next",
        repo_id: "repo-1",
        stage: "in progress",
        created_at: "2026-04-16T00:02:00.000Z",
      },
      {
        ...mockState.workflowItems[0]!,
        id: "task-other-repo",
        repo_id: "repo-2",
        stage: "in progress",
        created_at: "2026-04-16T00:01:00.000Z",
      },
    ];

    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-closing");
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "td-task-closing",
      code: 0,
    });

    await flushStore();

    expect(store.selectedRepoId).toBe("repo-1");
    expect(store.selectedItemId).toBe("task-next");
    expect(store.currentItem?.id).toBe("task-next");
  });

  it("delegates teardown session auto-close cleanup to the server", async () => {
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        id: "task-closing",
        repo_id: "repo-1",
        branch: "task-task-closing",
        teardown_started_at: "2026-04-16T00:04:00.000Z",
      },
    ];
    mockState.worktreeRows = [
      {
        pipeline_item_id: "task-closing",
        path: "/tmp/repo/.kanna-worktrees/task-task-closing",
        branch: "task-task-closing",
      },
    ];

    await createStore();
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "td-task-closing",
      code: 0,
    });

    await vi.waitFor(() => {
      expect(mockState.workflowItems[0]?.closed_at).toBe("2026-04-16T00:00:00.000Z");
    });

    const cleanupCall = mockState.invokeMock.mock.calls.find(([command, args]) =>
      command === "run_script" &&
      typeof args?.script === "string" &&
      args.script.includes("WIP at task close")
    );
    expect(cleanupCall).toBeUndefined();
  });

  it("keeps the repo selected when the selected teardown task leaves it empty", async () => {
    mockState.repos = [
      {
        ...mockState.repos[0]!,
        id: "repo-1",
        path: "/tmp/repo-1",
        name: "repo-1",
      },
      {
        ...mockState.repos[0]!,
        id: "repo-2",
        path: "/tmp/repo-2",
        name: "repo-2",
      },
    ];
    mockState.workflowItems = [
      {
        ...mockState.workflowItems[0]!,
        id: "task-closing",
        repo_id: "repo-1",
        stage: "in progress",
        teardown_started_at: "2026-04-16T00:03:00.000Z",
        created_at: "2026-04-16T00:02:00.000Z",
      },
      {
        ...mockState.workflowItems[0]!,
        id: "task-other-repo",
        repo_id: "repo-2",
        stage: "in progress",
        created_at: "2026-04-16T00:01:00.000Z",
      },
    ];

    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-closing");
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "td-task-closing",
      code: 0,
    });

    await flushStore();

    expect(store.selectedRepoId).toBe("repo-1");
    expect(store.selectedItemId).toBeNull();
  });
});
