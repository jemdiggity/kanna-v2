// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { createPipelineApi } from "./pipeline";
import type { StoreContext } from "./state";

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

});
