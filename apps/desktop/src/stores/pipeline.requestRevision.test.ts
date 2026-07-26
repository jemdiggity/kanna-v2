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
} = {}) {
  const reloadSnapshot = vi.fn(options.reloadSnapshot ?? (async () => {}));
  const toastError = vi.fn(options.toastError ?? (() => {}));
  const context = {
    state: {
      items: ref(options.items ?? [makeItem()]),
    },
    services: {
      reloadSnapshot,
    },
    toast: {
      error: toastError,
    },
    tt: (key: string) => key,
  } as unknown as StoreContext;
  return {
    api: createPipelineApi(context),
    reloadSnapshot,
    toastError,
  };
}

describe("requestRevision", () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(null);
    resolveBaseUrlMock.mockResolvedValue("http://127.0.0.1:48120");
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "revision-key-1"),
    });
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
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "revision-key-1",
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

  it("reuses one idempotency key after an accepted response is lost", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection closed after acceptance"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, reloadSnapshot } = makeApi();

    await expect(api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "revision-key-1",
        }),
      }));
    }
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reuses one durable idempotency key when rerun response delivery is lost", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection closed after rerun acceptance"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, reloadSnapshot } = makeApi();

    await expect(api.rerunStage("task-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "revision-key-1",
        }),
      }));
    }
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("retries only an explicitly pending idempotent revision response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("idempotent request is still pending", {
        status: 409,
        headers: { "Idempotency-Status": "pending" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api, reloadSnapshot } = makeApi();

    await expect(api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reloadSnapshot).toHaveBeenCalledTimes(1);
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

  it("keeps revision and advance actions single-flight for the same task", async () => {
    let releaseRequest!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await responseGate;
      return new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { api, toastError } = makeApi();

    const first = api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "needs changes",
      prompt: "Please revise.",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const duplicate = api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "duplicate",
      prompt: "Do not post this.",
    });
    await api.advanceStage("task-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBe(false);
    expect(toastError).not.toHaveBeenCalled();

    releaseRequest();
    await expect(first).resolves.toBe(true);

    await expect(api.requestRevision("task-1", {
      targetStage: "in progress",
      summary: "retry after completion",
      prompt: "This action should be accepted.",
    })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
