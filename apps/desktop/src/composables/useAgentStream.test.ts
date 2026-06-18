import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { useAgentStream } from "./useAgentStream";

interface AttachHandlers {
  onSnapshot: (snapshot: [], next: number) => void;
  onEvent: (seq: number, event: never) => void;
  onError: (code: string, message: string) => void;
}

interface FakeStreamClient {
  attachAgent: (taskId: string, handlers: AttachHandlers, fromSeq: number) => void;
  sendAgentInput: (taskId: string, text: string) => void;
  sendAgentPermission: (taskId: string, requestId: string, decision: unknown) => void;
  sendAgentInterrupt: (taskId: string) => void;
  sendAgentSetModel: (taskId: string, model: string) => void;
  detach: (taskId: string, kind: "agent") => void;
}

const streamMocks = vi.hoisted(() => {
  let resolveClient: ((client: FakeStreamClient) => void) | null = null;
  const clientPromise = new Promise<FakeStreamClient>((resolve) => {
    resolveClient = resolve;
  });
  const fakeClient: FakeStreamClient = {
    attachAgent: vi.fn(),
    sendAgentInput: vi.fn(),
    sendAgentPermission: vi.fn(),
    sendAgentInterrupt: vi.fn(),
    sendAgentSetModel: vi.fn(),
    detach: vi.fn(),
  };
  return {
    clientPromise,
    fakeClient,
    resolveClient: (client: FakeStreamClient) => {
      if (!resolveClient) throw new Error("client resolver not initialized");
      resolveClient(client);
    },
  };
});

vi.mock("./desktopStreamClient", () => ({
  getSharedStreamClient: vi.fn(() => streamMocks.clientPromise),
  onSharedStreamConnectionChange: vi.fn(() => () => undefined),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

describe("useAgentStream", () => {
  it("queues input sent before stream creation finishes", async () => {
    const stream = useAgentStream("task-1");

    stream.sendInput("please continue");
    expect(streamMocks.fakeClient.sendAgentInput).not.toHaveBeenCalled();

    streamMocks.resolveClient(streamMocks.fakeClient);
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
  });
});
