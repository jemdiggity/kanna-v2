import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem, Repo } from "../types/kanna";
import {
  setDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import { createStoreContext, createStoreState } from "./state";
import { createTaskCloseActions } from "./taskCloseActions";

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
  const services = {
    selectedTaskId: computed(() => selectedTaskId.value),
    currentItem: computed(() => durableItem),
    selectedRepo: computed(() =>
      state.repos.value.find((candidate) => candidate.id === state.selectedRepoId.value) ?? null,
    ),
    selectReplacementAfterItemRemoval,
    selectItem,
    reloadSnapshot: vi.fn(async () => {}),
    getAgentProviderAvailability: vi.fn(async () => ({ claude: true })),
    windowWorkspace: { invalidateSharedData: vi.fn(async () => {}) },
  };
  const context = createStoreContext(state, {
    toasts: ref([]),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }, services);
  const actions = createTaskCloseActions(context, { checkUnblocked: vi.fn(async () => {}) });
  return { state, services, actions, selectedTaskId };
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

  it("preserves a newer task selection while close completion is pending", async () => {
    const closeResponse = deferred<void>();
    const closeTask = vi.fn(async () => closeResponse.promise);
    setDesktopServerClientHandlersForTests({ closeTask });
    const durableItem = item();
    const { actions, services, state, selectedTaskId } = createHarness(durableItem);

    const closePromise = actions.closeTask(durableItem.id);
    await vi.waitFor(() => expect(closeTask).toHaveBeenCalledWith(durableItem.id));

    state.selectedItemId.value = "create:newer";
    selectedTaskId.value = "task-newer";
    state.selectionIntentVersion.value += 1;
    closeResponse.resolve();
    await closePromise;

    expect(services.selectReplacementAfterItemRemoval).not.toHaveBeenCalled();
    expect(state.selectedRepoId.value).toBe("repo-1");
    expect(state.selectedItemId.value).toBe("create:newer");
  });

  it("keeps the stable slot selected after undo delegates restoration to selectItem", async () => {
    const { actions, services, state } = createHarness();

    await actions.undoClose();

    expect(services.selectItem).toHaveBeenCalledWith("task-durable");
    expect(state.selectedItemId.value).toBe("create:restored");
  });
});
