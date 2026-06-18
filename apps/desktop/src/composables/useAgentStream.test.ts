// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamHandlers } from "@kanna/stream-client";
import { createAgentStream } from "./useAgentStream";

const clientMock = vi.hoisted(() => ({
  attachAgent: vi.fn(),
  detach: vi.fn(),
  sendAgentInput: vi.fn(),
  sendAgentPermission: vi.fn(),
  sendAgentInterrupt: vi.fn(),
  sendAgentSetModel: vi.fn(),
}));

vi.mock("./desktopStreamClient", () => ({
  getSharedStreamClient: vi.fn(async () => clientMock),
  onSharedStreamConnectionChange: vi.fn(() => vi.fn()),
}));

async function flushAsyncWork(attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("createAgentStream", () => {
  beforeEach(() => {
    clientMock.attachAgent.mockReset();
    clientMock.detach.mockReset();
    clientMock.sendAgentInput.mockReset();
    clientMock.sendAgentPermission.mockReset();
    clientMock.sendAgentInterrupt.mockReset();
    clientMock.sendAgentSetModel.mockReset();
  });

  it("recovers and reattaches when an agent stream reports a missing session", async () => {
    const recoverSession = vi.fn(async () => {});
    clientMock.attachAgent.mockImplementation((_taskId: string, handlers: AgentStreamHandlers, fromSeq: number) => {
      if (clientMock.attachAgent.mock.calls.length === 1) {
        handlers.onError?.("no_session", "session not found: task-1");
        return;
      }
      handlers.onSnapshot([{ seq: fromSeq, event: { type: "turn_started", model: null } }], fromSeq + 1);
    });

    const stream = await createAgentStream("task-1", { recoverSession });
    await flushAsyncWork();

    expect(recoverSession).toHaveBeenCalledWith("task-1");
    expect(clientMock.attachAgent).toHaveBeenCalledTimes(2);
    expect(clientMock.attachAgent).toHaveBeenNthCalledWith(1, "task-1", expect.any(Object), 0);
    expect(clientMock.attachAgent).toHaveBeenNthCalledWith(2, "task-1", expect.any(Object), 0);
    expect(stream.error.value).toBeNull();
    expect(stream.events.value).toEqual([
      { seq: 0, event: { type: "turn_started", model: null } },
    ]);
  });
});
