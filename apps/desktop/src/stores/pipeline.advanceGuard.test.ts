// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { createPipelineApi } from "./pipeline";
import type { StoreContext } from "./state";
import {
  setDesktopServerClientHandlersForTests,
  updateDesktopServerClientHandlersForTests,
} from "../services/desktopServerClient";

const { invokeMock, resolveBaseUrlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>) => null),
  resolveBaseUrlMock: vi.fn(async (_logContext: string) => "http://127.0.0.1:48120"),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../services/kannaServerBaseUrl", () => ({
  resolveCurrentKannaServerBaseUrl: resolveBaseUrlMock,
}));

function makeItem(overrides: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: "task-1",
    repo_id: "repo-1",
    prompt: "Ship it",
    pipeline: "default",
    pipeline_def: null,
    stage: "pr",
    branch: "task-1",
    closed_at: null,
    has_running_post: 0,
    ...overrides,
  } as PipelineItem;
}

describe("advanceStage running-post guard", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(null);
    resolveBaseUrlMock.mockResolvedValue("http://127.0.0.1:48120");
  });

  afterEach(() => {
    setDesktopServerClientHandlersForTests(null);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("refuses an ordinary advance while a post is running instead of hitting the backend override", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const toastWarning = vi.fn();
    const context = {
      state: {
        items: ref([makeItem({ has_running_post: 1 })]),
        repos: ref([]),
      },
      toast: { warning: toastWarning, error: vi.fn() },
      tt: (key: string) => key,
    } as unknown as StoreContext;
    const api = createPipelineApi(context);

    await api.advanceStage("task-1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith("toasts.stagePostRunning");
  });

  it("returns a distinct hold result instead of treating a conflict as ordinary blocking", async () => {
    const fetchMock = vi.fn(async () => new Response(
      "approval held: unresolved failed_result",
      { status: 409 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    updateDesktopServerClientHandlersForTests({
      fetchRepoPipelineDefinition: async () => ({
        revision: "approval-hold-test",
        definition: {
          name: "default",
          stages: [{
            name: "pr",
            policy: { transition: "manual" },
          }],
        },
      }),
    });
    const toastWarning = vi.fn();
    const context = {
      state: {
        items: ref([makeItem()]),
        repos: ref([]),
        selectedItemId: ref(null),
        selectedRepoId: ref("repo-1"),
        lastSelectedItemByRepo: ref({}),
        pipelineCache: new Map(),
        agentCache: new Map(),
      },
      services: {
        selectedTaskId: ref(null),
        sortedItemsForCurrentRepo: ref([makeItem()]),
      },
      toast: { warning: toastWarning, error: vi.fn() },
      tt: (key: string) => key,
    } as unknown as StoreContext;

    await expect(createPipelineApi(context).advanceStage("task-1")).resolves.toBe("held");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      "approval held: unresolved failed_result",
    );
  });

  it("records a deliberate desktop override with the required marker and reason", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ state: "overridden", holds: [] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const reloadSnapshot = vi.fn(async () => undefined);
    const context = {
      state: {
        items: ref([makeItem()]),
        repos: ref([]),
      },
      services: { reloadSnapshot },
      toast: { warning: vi.fn(), error: vi.fn() },
      tt: (key: string) => key,
    } as unknown as StoreContext;

    await expect(createPipelineApi(context).overrideApprovalHold(
      "task-1",
      "  Accept the diagnostic-only scope  ",
    )).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48120/v1/tasks/task-1/actions/override-approval",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-kanna-human-action": "approval-override",
        },
        body: JSON.stringify({ reason: "Accept the diagnostic-only scope" }),
      },
    );
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);
  });
});
