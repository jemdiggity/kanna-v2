import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, PipelineItem, Repo } from "@kanna/db";

const mockState = vi.hoisted(() => {
  const now = "2026-04-16T00:00:00.000Z";
  const updateAgentSessionIdMock = vi.fn(async () => {});

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
      pipeline: "default",
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
  let pipelineItems = [makeItem()];
  let sessionStatuses: Array<{ session_id: string; status: string }> = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();

  const invokeMock = vi.fn(async (command: string) => {
    switch (command) {
      case "list_sessions":
        return sessionStatuses;
      case "spawn_session":
      case "ensure_term_init":
      case "get_app_data_dir":
      case "get_pipeline_socket_path":
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
    const item = pipelineItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    item.activity = activity;
    item.activity_changed_at = now;
    item.updated_at = now;
  });

  function emit(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) {
      handler({ payload });
    }
  }

  function reset(): void {
    repos = [makeRepo()];
    pipelineItems = [makeItem()];
    sessionStatuses = [];
    listeners.clear();
    invokeMock.mockClear();
    listenMock.mockClear();
    updatePipelineItemActivityMock.mockClear();
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
    get sessionStatuses() {
      return sessionStatuses;
    },
    set sessionStatuses(value: Array<{ session_id: string; status: string }>) {
      sessionStatuses = value;
    },
    invokeMock,
    listenMock,
    updatePipelineItemActivityMock,
    updateAgentSessionIdMock,
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
  ...cleanupMocks,
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

vi.mock("@kanna/db", () => ({
  listRepos: vi.fn(async () => mockState.repos),
  insertRepo: vi.fn(async () => {}),
  findRepoByPath: vi.fn(async () => null),
  hideRepo: vi.fn(async () => {}),
  unhideRepo: vi.fn(async () => {}),
  listPipelineItems: vi.fn(async (_db: DbHandle, repoId: string) =>
    mockState.pipelineItems.filter((item) => item.repo_id === repoId),
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
    const item = mockState.pipelineItems.find((candidate) => candidate.id === itemId);
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

function createDb(): DbHandle {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    select: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT agent_provider FROM pipeline_item")) {
        const itemId = typeof params?.[0] === "string" ? params[0] : null;
        const item = itemId
          ? mockState.pipelineItems.find((candidate) => candidate.id === itemId)
          : null;
        return item ? [{ agent_provider: item.agent_provider }] : [];
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

describe("kanna runtime status reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.reset();
    cleanupMocks.closePipelineItemAndClearCachedTerminalState.mockClear();
    cleanupMocks.getTaskIdFromTeardownSessionId.mockClear();
    cleanupMocks.isTeardownSessionId.mockClear();
    cleanupMocks.reportCloseSessionError.mockClear();
    cleanupMocks.reportPrewarmSessionError.mockClear();
    cleanupMocks.shouldAutoCloseTaskAfterTeardownExit.mockClear();
    cleanupMocks.shouldAutoCloseTaskImmediatelyAfterEnteringTeardown.mockClear();
    cleanupMocks.shouldClearCachedTerminalStateOnSessionExit.mockClear();
    mockState.updateAgentSessionIdMock.mockClear();
  });

  it("reconciles a selected task to idle from a direct daemon status change", async () => {
    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-1");
    await flushStore();

    mockState.emit("status_changed", {
      session_id: "task-1",
      status: "waiting",
    });

    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "idle",
    );
    expect(mockState.pipelineItems[0]?.activity).toBe("idle");
  });

  it("ignores daemon status changes for closed tasks", async () => {
    mockState.pipelineItems = [
      {
        ...mockState.pipelineItems[0]!,
        stage: "done",
        closed_at: "2026-06-06 05:38:31",
        activity: "idle",
      },
    ];

    await createStore();
    await flushStore();

    mockState.emit("status_changed", {
      session_id: "task-1",
      status: "busy",
    });

    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "working",
    );
    expect(mockState.pipelineItems[0]?.activity).toBe("idle");
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
      forgetCurrentWindow: vi.fn(async () => {}),
      persistSelection: vi.fn(async () => {}),
      persistSidebarHidden: vi.fn(async () => {}),
      persistSidebarWidth: vi.fn(async () => {}),
      invalidateSharedData: vi.fn(async () => {}),
      restoreAdditionalWindows: vi.fn(async () => {}),
      onSharedInvalidation: vi.fn(async () => vi.fn()),
    });
    await flushStore();

    mockState.emit("session_exit", {
      session_id: "task-1",
      code: 0,
      resume_session_id: null,
    });

    await flushStore();

    expect(mockState.updatePipelineItemActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "idle",
    );
    expect(mockState.pipelineItems[0]?.activity).toBe("idle");
  });

  it("ignores session exits for closed tasks", async () => {
    mockState.pipelineItems = [
      {
        ...mockState.pipelineItems[0]!,
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
    expect(mockState.pipelineItems[0]?.activity).toBe("idle");
  });

  it("does not poll all daemon sessions for ordinary terminal output", async () => {
    const store = await createStore();
    await store.selectRepo("repo-1");
    await store.selectItem("task-1");
    await flushStore();
    mockState.invokeMock.mockClear();

    mockState.sessionStatuses = [{ session_id: "task-1", status: "waiting" }];

    mockState.emit("terminal_output", {
      session_id: "task-1",
      data_b64: "AA==",
    });

    await vi.advanceTimersByTimeAsync(1000);
    await flushStore();

    expect(mockState.invokeMock).not.toHaveBeenCalledWith("list_sessions");
    expect(mockState.updatePipelineItemActivityMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "idle",
    );
  });

  it("persists a codex resume session id from session_exit payload", async () => {
    mockState.pipelineItems = [
      {
        ...mockState.pipelineItems[0]!,
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

    expect(mockState.updateAgentSessionIdMock).toHaveBeenCalledWith(
      expect.anything(),
      "task-1",
      "019d99a5-aa94-7c73-b786-644cc095c037",
    );
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
    mockState.pipelineItems = [
      {
        ...mockState.pipelineItems[0]!,
        id: "task-closing",
        repo_id: "repo-1",
        stage: "in progress",
        teardown_started_at: "2026-04-16T00:04:00.000Z",
        created_at: "2026-04-16T00:03:00.000Z",
      },
      {
        ...mockState.pipelineItems[0]!,
        id: "task-next",
        repo_id: "repo-1",
        stage: "in progress",
        created_at: "2026-04-16T00:02:00.000Z",
      },
      {
        ...mockState.pipelineItems[0]!,
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

  it("falls back to another repo when the selected teardown task leaves its repo empty", async () => {
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
    mockState.pipelineItems = [
      {
        ...mockState.pipelineItems[0]!,
        id: "task-closing",
        repo_id: "repo-1",
        stage: "in progress",
        teardown_started_at: "2026-04-16T00:03:00.000Z",
        created_at: "2026-04-16T00:02:00.000Z",
      },
      {
        ...mockState.pipelineItems[0]!,
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

    expect(store.selectedRepoId).toBe("repo-2");
    expect(store.selectedItemId).toBe("task-other-repo");
    expect(store.currentItem?.id).toBe("task-other-repo");
  });
});
