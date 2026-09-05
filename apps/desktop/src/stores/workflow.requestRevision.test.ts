// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineItem } from "@kanna/db";
import { createWorkflowApi } from "./workflow";
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
    prompt: "Review this branch",
    stage: "review",
    branch: "task-1",
    closed_at: null,
    ...overrides,
  } as PipelineItem;
}

function makeApi(options: {
  items?: PipelineItem[];
  reloadSnapshot?: () => Promise<void>;
  toastError?: (message: string) => void;
  toastWarning?: (message: string) => void;
} = {}) {
  const reloadSnapshot = vi.fn(options.reloadSnapshot ?? (async () => {}));
  const toastError = vi.fn(options.toastError ?? (() => {}));
  const toastWarning = vi.fn(options.toastWarning ?? (() => {}));
  const context = {
    state: {
      items: ref(options.items ?? [makeItem()]),
    },
    services: {
      reloadSnapshot,
    },
    toast: {
      error: toastError,
      warning: toastWarning,
    },
    tt: (key: string) => key,
  } as unknown as StoreContext;
  return {
    api: createWorkflowApi(context),
    reloadSnapshot,
    toastError,
    toastWarning,
  };
}

describe("requestRevision", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(null);
    resolveBaseUrlMock.mockResolvedValue("http://127.0.0.1:48120");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns false and keeps caller state when the server action is not accepted", async () => {
    const fetchMock = vi.fn(async () => new Response("task is closed", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, reloadSnapshot, toastError } = makeApi();

    const result = await api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    });

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:48120/v1/tasks/task-1/actions/request-revision", {
      method: "POST",
      // The webview is a browser: `kanna-server` refuses a browser-originated
      // request that does not carry this desktop's local control credential.
      headers: {
        Authorization: "Bearer mock-local-control-credential",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetStage: "in progress",
        summary: "needs changes",
        prompt: "Please revise.",
        // A user-driven revision is exempt from the agent revision-round
        // budget and resets it.
        origin: "human",
      }),
    });
    expect(reloadSnapshot).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("toasts.agentStartFailed: task is closed");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns true after a successful request-revision action and snapshot reload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, reloadSnapshot, toastError } = makeApi();

    const result = await api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
      metadata: { source: "test" },
    });

    expect(result).toBe(true);
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("returns false without posting when the task is missing or closed", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api: missingApi } = makeApi({ items: [] });
    const { api: closedApi } = makeApi({ items: [makeItem({ closed_at: "2026-07-08T00:00:00Z" })] });

    await expect(missingApi.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    })).resolves.toBe(false);
    await expect(closedApi.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only one revision request per task while the mutation is in flight", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, toastWarning } = makeApi();
    const options = {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    };

    const first = api.requestRevision("task-1", options);
    await Promise.resolve();
    await expect(api.requestRevision("task-1", options)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith("toasts.revisionAlreadyStarting");

    resolveResponse?.(new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    await expect(first).resolves.toBe(true);
  });
});
