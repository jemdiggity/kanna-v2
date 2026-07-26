// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { createPipelineApi } from "./pipeline";
import type { StoreContext } from "./state";

const { fetchPipelineMock, invokeMock, resolveBaseUrlMock } = vi.hoisted(() => ({
  fetchPipelineMock: vi.fn(),
  invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>) => null),
  resolveBaseUrlMock: vi.fn(async (_logContext: string) => "http://127.0.0.1:48120"),
}));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../services/kannaServerBaseUrl", () => ({
  resolveCurrentKannaServerBaseUrl: resolveBaseUrlMock,
}));

vi.mock("../services/desktopServerClient", () => ({
  fetchDesktopRepoPipelineDefinition: fetchPipelineMock,
  fetchDesktopRepoAgentDefinition: vi.fn(),
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
    fetchPipelineMock.mockResolvedValue({
      revision: "test",
      definition: {
        name: "default",
        stages: [{ name: "pr", policy: { transition: "manual" } }],
      },
    });
  });

  afterEach(() => {
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

  it("reports a non-blocked 409 as an action failure instead of a Task Blocked warning", async () => {
    const fetchMock = vi.fn(async () => new Response("task action already in progress", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const toastWarning = vi.fn();
    const toastError = vi.fn();
    const item = makeItem();
    const context = {
      state: {
        items: ref([item]),
        repos: ref([]),
        pipelineCache: new Map(),
        selectedItemId: ref(item.id),
      },
      services: {
        selectedTaskId: ref(item.id),
        sortedItemsForCurrentRepo: ref([item]),
      },
      toast: { warning: toastWarning, error: toastError },
      tt: (key: string) => key,
    } as unknown as StoreContext;
    const api = createPipelineApi(context);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await api.advanceStage(item.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastWarning).not.toHaveBeenCalledWith("mainPanel.taskBlocked");
    expect(toastError).toHaveBeenCalledWith(
      "toasts.agentStartFailed: task action already in progress",
    );
    expect(errorSpy).toHaveBeenCalled();
  });
});
