// @vitest-environment happy-dom

import { computed } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";
import type { PipelineItem, Repo } from "../types/kanna";
import { createWorkflowApi } from "./workflow";
import { createStoreContext, createStoreState } from "./state";

const { invokeMock, resolveBaseUrlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
  resolveBaseUrlMock: vi.fn(async () => "http://127.0.0.1:48120"),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../services/kannaServerBaseUrl", () => ({
  resolveCurrentKannaServerBaseUrl: resolveBaseUrlMock,
}));

function makeItem(id: string, stage: string): PipelineItem {
  return {
    id,
    repo_id: "repo-1",
    stage,
    pipeline: "default",
    branch: `task-${id}`,
    closed_at: null,
  } as PipelineItem;
}

function mockDefaultWorkflow() {
  const fetchRepoWorkflowDefinition = vi.fn(async () => ({
    revision: "rev-1",
    definition: {
      name: "default",
      stages: [
        { name: "in progress", policy: { transition: "manual" as const } },
        { name: "pr", policy: { transition: "manual" as const } },
      ],
    },
  }));
  updateDesktopServerClientHandlersForTests({ fetchRepoWorkflowDefinition });
  return fetchRepoWorkflowDefinition;
}

describe("advanceStage durable selection", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(null);
    resolveBaseUrlMock.mockResolvedValue("http://127.0.0.1:48120");
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("moves selection after closing the durable task behind a noncanonical UI slot", async () => {
    const source = makeItem("task-source", "pr");
    const next = makeItem("task-next", "in progress");
    const state = createStoreState();
    state.repos.value = [{ id: "repo-1", path: "/tmp/repo" } as Repo];
    state.items.value = [source, next];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable";
    const fetchRepoWorkflowDefinition = mockDefaultWorkflow();

    const selectItem = vi.fn(async (taskId: string) => {
      expect(taskId).toBe("task-next");
      state.selectedItemId.value = "create:next-stable";
    });
    const reloadSnapshot = vi.fn(async () => {
      source.closed_at = "2026-07-11T00:00:00Z";
      state.items.value = [source, next];
    });
    const context = createStoreContext(state, {
      warning: vi.fn(),
      error: vi.fn(),
    } as never, {
      selectedTaskId: computed(() => "task-source"),
      sortedItemsForCurrentRepo: computed(() => [source, next]),
      isItemHidden: (item) => item.closed_at != null,
      selectItem,
      reloadSnapshot,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ taskId: "task-source" }),
      { status: 200 },
    )));

    await createWorkflowApi(context).advanceStage("task-source");

    expect(selectItem).toHaveBeenCalledOnce();
    expect(state.selectedItemId.value).toBe("create:next-stable");
    expect(fetchRepoWorkflowDefinition).toHaveBeenCalledWith("repo-1", "default");
  });

  it("clears and persists the stable selection when the final-stage task has no replacement", async () => {
    const source = makeItem("task-source", "pr");
    const state = createStoreState();
    state.repos.value = [{ id: "repo-1", path: "/tmp/repo" } as Repo];
    state.items.value = [source];
    state.selectedRepoId.value = "repo-1";
    state.selectedItemId.value = "create:stable";
    state.lastSelectedItemByRepo.value = {
      "repo-1": "create:stable",
      "repo-other": "create:other",
    };
    mockDefaultWorkflow();

    const persistedSlotIds: Array<string | null> = [];
    const persistSelection = vi.fn(async () => {
      persistedSlotIds.push(state.selectedItemId.value);
    });
    const reloadSnapshot = vi.fn(async () => {
      source.closed_at = "2026-07-11T00:00:00Z";
      state.items.value = [source];
    });
    const context = createStoreContext(state, {
      warning: vi.fn(),
      error: vi.fn(),
    } as never, {
      selectedTaskId: computed(() => "task-source"),
      sortedItemsForCurrentRepo: computed(() => [source]),
      persistSelection,
      reloadSnapshot,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ taskId: "task-source" }),
      { status: 200 },
    )));

    await createWorkflowApi(context).advanceStage("task-source");

    expect(state.selectedItemId.value).toBeNull();
    expect(state.lastSelectedItemByRepo.value).toEqual({
      "repo-other": "create:other",
    });
    expect(persistSelection).toHaveBeenCalledOnce();
    expect(persistedSlotIds).toEqual([null]);
  });
});
