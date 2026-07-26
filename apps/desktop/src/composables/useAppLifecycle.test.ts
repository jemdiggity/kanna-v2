import { describe, expect, it, vi } from "vitest";

import { handleTaskPullRequested } from "./useAppLifecycle";
import type { TransferMachine } from "../services/desktopTransferMachines";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-source",
    closed_at: null,
    ...overrides,
  };
}

function machine(overrides: Partial<TransferMachine> = {}): TransferMachine {
  return {
    peerId: "peer-requester",
    desktopId: "desktop-requester",
    name: "Requester Mac",
    publicKey: "requester-key",
    lanEndpoint: "127.0.0.1:43100",
    relayDesktopId: "desktop-requester",
    trustSource: "same-account-cloud",
    preferredTransport: "lan",
    cloudFallback: true,
    ...overrides,
  };
}

describe("handleTaskPullRequested", () => {
  it("pushes an open locally owned task back to the requester exactly once", async () => {
    let release!: () => void;
    const pushTaskToPeer = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const inFlight = new Set<string>();
    const store = { items: [item()], pushTaskToPeer };
    const event = {
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    };

    const first = handleTaskPullRequested(event, store as never, inFlight, [machine()]);
    const duplicate = handleTaskPullRequested(event, store as never, inFlight, [machine()]);

    expect(pushTaskToPeer).toHaveBeenCalledTimes(1);
    expect(pushTaskToPeer).toHaveBeenCalledWith("task-source", "peer-requester", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-requester",
    });
    expect(await duplicate).toBe(false);
    release();
    expect(await first).toBe(true);
  });

  it("rejects a requester that is absent from the current eligible machine catalog", async () => {
    const pushTaskToPeer = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Set(), [])).resolves.toBe(false);

    expect(pushTaskToPeer).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", [], "task-missing"],
    ["closed", [item({ closed_at: "2026-07-26T00:00:00Z" })], "task-source"],
    ["remote-only", [item()], "cloud:task-source"],
    ["already transferring", [item({
      transfer_direction: "outgoing",
      transfer_status: "streaming",
    })], "task-source"],
    ["incoming transfer", [item({
      transfer_direction: "incoming",
      transfer_status: "importing",
    })], "task-source"],
  ])("rejects a %s source without starting push", async (_case, items, sourceTaskId) => {
    const pushTaskToPeer = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId,
    }, { items, pushTaskToPeer } as never, new Set(), [machine()])).resolves.toBe(false);

    expect(pushTaskToPeer).not.toHaveBeenCalled();
  });
});
