// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { AgentStreamHandlers } from "@kanna/stream-client";
import { createAgentStream, useAgentStream } from "./useAgentStream";

interface FakeStreamClient {
  attachAgent: (taskId: string, handlers: AgentStreamHandlers, fromSeq: number) => void;
  sendAgentInput: (taskId: string, text: string) => void;
  sendAgentPermission: (taskId: string, requestId: string, decision: unknown) => void;
  sendAgentInterrupt: (taskId: string) => void;
  sendAgentSetModel: (taskId: string, model: string) => void;
  detach: (taskId: string, kind: "agent") => void;
}

const streamMocks = vi.hoisted(() => {
  let resolveClient: ((client: FakeStreamClient) => void) | null = null;
  let clientPromise: Promise<FakeStreamClient>;
  const fakeClient: FakeStreamClient = {
    attachAgent: vi.fn(),
    sendAgentInput: vi.fn(),
    sendAgentPermission: vi.fn(),
    sendAgentInterrupt: vi.fn(),
    sendAgentSetModel: vi.fn(),
    detach: vi.fn(),
  };

  function resetClientPromise() {
    clientPromise = new Promise<FakeStreamClient>((resolve) => {
      resolveClient = resolve;
    });
  }

  resetClientPromise();

  return {
    fakeClient,
    getClientPromise: () => clientPromise,
    reset: () => {
      fakeClient.attachAgent.mockReset();
      fakeClient.sendAgentInput.mockReset();
      fakeClient.sendAgentPermission.mockReset();
      fakeClient.sendAgentInterrupt.mockReset();
      fakeClient.sendAgentSetModel.mockReset();
      fakeClient.detach.mockReset();
      resetClientPromise();
    },
    resolveClient: (client: FakeStreamClient = fakeClient) => {
      if (!resolveClient) throw new Error("client resolver not initialized");
      resolveClient(client);
    },
  };
});

vi.mock("./desktopStreamClient", () => ({
  getSharedStreamClient: vi.fn(() => streamMocks.getClientPromise()),
  onSharedStreamConnectionChange: vi.fn(() => () => undefined),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

async function flushAsyncWork(attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("useAgentStream", () => {
  beforeEach(() => {
    streamMocks.reset();
  });

  it("queues input sent before stream creation finishes", async () => {
    const stream = useAgentStream("task-1");

    stream.sendInput("please continue");
    expect(streamMocks.fakeClient.sendAgentInput).not.toHaveBeenCalled();

    streamMocks.resolveClient();
    await flushPromises();

    expect(streamMocks.fakeClient.attachAgent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        onSnapshot: expect.any(Function),
        onEvent: expect.any(Function),
        onError: expect.any(Function),
      }),
      0,
    );
    expect(streamMocks.fakeClient.sendAgentInput).toHaveBeenCalledWith("task-1", "please continue");
    expect(stream.error.value).toBeNull();

    stream.close();
  });
});

describe("createAgentStream", () => {
  beforeEach(() => {
    streamMocks.reset();
  });

  it("recovers and reattaches when an agent stream reports a missing session", async () => {
    const recoverSession = vi.fn(async () => {});
    streamMocks.fakeClient.attachAgent.mockImplementation((_taskId: string, handlers: AgentStreamHandlers, fromSeq: number) => {
      if (streamMocks.fakeClient.attachAgent.mock.calls.length === 1) {
        handlers.onError?.("no_session", "session not found: task-1");
        return;
      }
      handlers.onSnapshot([{ seq: fromSeq, event: { type: "turn_started", model: null } }], fromSeq + 1);
    });
    streamMocks.resolveClient();

    const stream = await createAgentStream("task-1", { recoverSession });
    await flushAsyncWork();

    expect(recoverSession).toHaveBeenCalledWith("task-1");
    expect(streamMocks.fakeClient.attachAgent).toHaveBeenCalledTimes(2);
    expect(streamMocks.fakeClient.attachAgent).toHaveBeenNthCalledWith(1, "task-1", expect.any(Object), 0);
    expect(streamMocks.fakeClient.attachAgent).toHaveBeenNthCalledWith(2, "task-1", expect.any(Object), 0);
    expect(stream.error.value).toBeNull();
    expect(stream.events.value).toEqual([
      { seq: 0, event: { type: "turn_started", model: null } },
    ]);

    stream.close();
  });
});
