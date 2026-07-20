import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import {
  setDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import { createStoreContext, createStoreState } from "./state";
import { createTaskCloseActions } from "./taskCloseActions";
import { createTaskItemActions } from "./taskItemActions";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === "git_default_branch") return "main";
    if (command === "git_list_base_branches") return ["main"];
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

vi.mock("../invoke", () => ({ invoke: invokeMock }));

function repo(id = "repo-1"): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    name: id,
    default_branch: "main",
    remote_url: null,
    remote_url_hash: null,
    hidden: 0,
    sort_order: 0,
    created_at: "2026-07-11T00:00:00.000Z",
    last_opened_at: "2026-07-11T00:00:00.000Z",
  };
}

function item(id = "task-durable"): PipelineItem {
  return {
    id,
    repo_id: "repo-1",
    issue_number: null,
    issue_title: null,
    prompt: "Close durable task",
    pipeline: "default",
    pipeline_def: null,
    stage: "in progress",
    pr_number: null,
    pr_url: null,
    branch: null,
    closed_at: null,
    agent_type: "pty",
    agent_provider: "claude",
    activity: "idle",
    activity_changed_at: null,
    unread_at: null,
    port_offset: null,
    display_name: null,
    last_output_preview: null,
    port_env: null,
    pinned: 0,
    pin_order: null,
    base_ref: null,
    agent_session_id: null,
    teardown_started_at: null,
    parent_task_id: null,
    notify_task_id: null,
    notified_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function createHarness(durableItem = item()) {
  const state = createStoreState();
  state.repos.value = [repo(), repo("repo-2")];
  state.items.value = [durableItem];
  state.selectedRepoId.value = "repo-1";
  state.selectedItemId.value = "create:stable";
  const selectedTaskId = ref<string | null>(durableItem.id);
  const selectReplacementAfterItemRemoval = vi.fn(async () => null);
  const selectItem = vi.fn(async (_taskId: string) => {
    state.selectedItemId.value = "create:restored";
  });
  const restoreSelection = vi.fn((taskId: string) => {
    state.selectedItemId.value = taskId;
    selectedTaskId.value = taskId;
  });
  const services = {
    selectedTaskId: computed(() => selectedTaskId.value),
    currentItem: computed(() => durableItem),
    selectedRepo: computed(() =>
      state.repos.value.find((candidate) => candidate.id === state.selectedRepoId.value) ?? null,
    ),
    selectReplacementAfterItemRemoval,
    selectItem,
    persistSelection: vi.fn(async () => {}),
    restoreSelection,
    reconcileSelection: vi.fn(),
    fetchSnapshot: vi.fn(async () => ({
      entries: [{ repo: repo(), items: [durableItem] }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    })),
    reloadSnapshot: vi.fn(async () => {}),
    withOptimisticItemOverlay: vi.fn(async (input: {
      apply: (snapshot: {
        entries: Array<{ repo: Repo; items: PipelineItem[] }>;
        taskBlockers: never[];
        worktreePaths: Record<string, string>;
        settings: Record<string, string>;
      }) => {
        entries: Array<{ repo: Repo; items: PipelineItem[] }>;
        taskBlockers: never[];
        worktreePaths: Record<string, string>;
        settings: Record<string, string>;
      };
      run: () => Promise<unknown>;
      reconcile?: () => Promise<void>;
    }) => {
      const authoritativeItems = state.items.value;
      const projected = input.apply({
        entries: [{ repo: repo(), items: authoritativeItems }],
        taskBlockers: [],
        worktreePaths: {},
        settings: {},
      });
      state.items.value = projected.entries.flatMap((entry) => entry.items);
      try {
        const result = await input.run();
        await input.reconcile?.();
        return result;
      } finally {
        state.items.value = authoritativeItems;
      }
    }),
    getAgentProviderAvailability: vi.fn(async () => ({ claude: true })),
    windowWorkspace: { invalidateSharedData: vi.fn(async () => {}) },
  };
  const toast = {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
  const context = createStoreContext(state, toast, services);
  const actions = createTaskCloseActions(context, { checkUnblocked: vi.fn(async () => {}) });
  return { state, services, actions, selectedTaskId, toast };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("task close durable selection", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests({
      closeTask: async () => {},
      reopenTask: async () => {},
      fetchClosedTaskIdentities: async () => [{ id: "task-durable", repo_id: "repo-1" }],
    });
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
  });

  it("selects a replacement when the closed durable task owns a noncanonical slot", async () => {
    const durableItem = item();
    const { actions, services } = createHarness(durableItem);

    await actions.closeTask(durableItem.id);

    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
  });

  it("hides the task and selects its replacement before close completes", async () => {
    const closeResponse = deferred<void>();
    setDesktopServerClientHandlersForTests({
      closeTask: async () => closeResponse.promise,
    });
    const durableItem = item();
    const { actions, services, state } = createHarness(durableItem);

    const closePromise = actions.closeTask(durableItem.id);
    await vi.waitFor(() => expect(services.withOptimisticItemOverlay).toHaveBeenCalledOnce());

    expect(state.items.value.find((candidate) => candidate.id === durableItem.id)?.closed_at).not.toBeNull();
    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);

    closeResponse.resolve();
    await closePromise;
  });

  it("keeps close ownership when a live snapshot removes the selected task", async () => {
    const closeResponse = deferred<void>();
    const closeTask = vi.fn(async () => closeResponse.promise);
    setDesktopServerClientHandlersForTests({ closeTask });
    const durableItem = item();
    const { actions, services, state, selectedTaskId } = createHarness(durableItem);

    const closePromise = actions.closeTask(durableItem.id);
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledWith(durableItem.id));

    // A server snapshot may reconcile visible selection before the older
    // close response resolves. That is not a newer user navigation intent.
    state.items.value = [];
    state.selectedItemId.value = "task-from-snapshot";
    selectedTaskId.value = "task-from-snapshot";
    closeResponse.resolve();
    await closePromise;

    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
  });

  it("preserves a newly created task selection while close completion is pending", async () => {
    const closeResponse = deferred<void>();
    const closeTask = vi.fn(async () => closeResponse.promise);
    setDesktopServerClientHandlersForTests({
      closeTask,
      createTask: async (request) => ({
        taskId: "task-newer",
        repoId: request.repoId,
        title: request.prompt,
        stage: "in progress",
        agentType: request.agentType ?? "agent",
      }),
    });
    const durableItem = item();
    const { actions, services, state } = createHarness(durableItem);
    const itemActions = createTaskItemActions({
      state,
      services,
      toast: {
        toasts: ref([]),
        dismiss: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
      requireDb: () => {
        throw new Error("database should not be required");
      },
      tt: (key: string) => key,
    });

    const closePromise = actions.closeTask(durableItem.id);
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledWith(durableItem.id));

    const createdTaskId = await itemActions.createItem(
      "repo-2",
      "/tmp/repo-2",
      "Create while close is pending",
      "agent",
    );
    const createdSlotId = state.selectedItemId.value;

    expect(createdTaskId).toBe("task-newer");
    expect(state.selectedRepoId.value).toBe("repo-2");
    expect(createdSlotId).toMatch(/^create:/);
    expect(state.selectionIntentVersion.value).toBe(1);

    closeResponse.resolve();
    await closePromise;

    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
    expect(services.restoreSelection).not.toHaveBeenCalled();
    expect(state.selectedRepoId.value).toBe("repo-2");
    expect(state.selectedItemId.value).toBe(createdSlotId);
  });

  it("reports failure when the close request fails and the task remains open", async () => {
    const closeError = new Error("close request failed");
    setDesktopServerClientHandlersForTests({
      closeTask: async () => {
        throw closeError;
      },
    });
    const durableItem = item();
    const { actions, services, toast } = createHarness(durableItem);

    const closed = await actions.closeTask(durableItem.id);

    expect(closed).toBe(false);
    expect(services.fetchSnapshot).toHaveBeenCalledOnce();
    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
    expect(services.restoreSelection).toHaveBeenCalledWith(durableItem.id);
    expect(services.reloadSnapshot).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Failed to close task");
  });

  it("reconciles selection when the close response fails after the task was committed", async () => {
    const closeError = new Error("close response was lost");
    setDesktopServerClientHandlersForTests({
      closeTask: async () => {
        throw closeError;
      },
    });
    const durableItem = item();
    const { actions, services, toast } = createHarness(durableItem);
    services.fetchSnapshot.mockResolvedValueOnce({
      entries: [{ repo: repo(), items: [] }],
      taskBlockers: [],
      worktreePaths: {},
      settings: {},
    });

    const closed = await actions.closeTask(durableItem.id);

    expect(closed).toBe(true);
    expect(services.selectReplacementAfterItemRemoval).toHaveBeenCalledWith(durableItem);
    expect(services.reloadSnapshot).toHaveBeenCalledOnce();
    expect(services.windowWorkspace.invalidateSharedData).toHaveBeenCalledWith("closeTask");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the stable slot selected after undo delegates restoration to selectItem", async () => {
    const { actions, services, state } = createHarness();

    await actions.undoClose();

    expect(services.selectItem).toHaveBeenCalledWith("task-durable");
    expect(state.selectedItemId.value).toBe("create:restored");
  });
});
