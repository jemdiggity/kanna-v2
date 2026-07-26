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
    let releaseRefresh!: () => void;
    const refreshCloudTransferRoute = vi.fn(() =>
      new Promise<void>((resolve) => { releaseRefresh = resolve; }));
    const pushTaskToPeer = vi.fn(async () => {});
    const inFlight = new Set<string>();
    const store = { items: [item()], pushTaskToPeer };
    const event = {
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    };

    const first = handleTaskPullRequested(event, store as never, inFlight, [machine()], {
      refreshCloudTransferRoute,
    });
    const duplicate = handleTaskPullRequested(event, store as never, inFlight, [machine()], {
      refreshCloudTransferRoute,
    });

    expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(1);
    expect(pushTaskToPeer).not.toHaveBeenCalled();
    expect(await duplicate).toBe(false);
    releaseRefresh();
    expect(await first).toBe(true);
    expect(pushTaskToPeer).toHaveBeenCalledTimes(1);
    expect(pushTaskToPeer).toHaveBeenCalledWith("task-source", "peer-requester", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-requester",
    });
  });

  it.each([
    ["cloud", {
      preferredTransport: "cloud" as const,
      cloudFallback: false,
      lanEndpoint: null,
    }],
    ["LAN-preferred cloud fallback", {
      preferredTransport: "lan" as const,
      cloudFallback: true,
      lanEndpoint: "127.0.0.1:43100",
    }],
  ])("refreshes the exact requester %s route before starting the return push", async (
    _route,
    requesterOverrides,
  ) => {
    const order: string[] = [];
    const refreshCloudTransferRoute = vi.fn(async () => {
      order.push("refresh");
    });
    const pushTaskToPeer = vi.fn(async () => {
      order.push("push");
    });

    await expect(handleTaskPullRequested({
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Set(), [
      machine({
        peerId: "peer-other",
        desktopId: "desktop-other",
        relayDesktopId: "desktop-other",
      }),
      machine(requesterOverrides),
    ], { refreshCloudTransferRoute })).resolves.toBe(true);

    expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(1);
    expect(refreshCloudTransferRoute).toHaveBeenCalledWith("peer-requester");
    expect(order).toEqual(["refresh", "push"]);
  });

  it("aborts after a pending route refresh without starting the return push", async () => {
    let releaseRefresh!: () => void;
    const refreshCloudTransferRoute = vi.fn(() =>
      new Promise<void>((resolve) => { releaseRefresh = resolve; }));
    const pushTaskToPeer = vi.fn(async () => {});
    const abortController = new AbortController();
    const inFlight = new Set<string>();

    const pending = handleTaskPullRequested({
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, inFlight, [machine()], {
      refreshCloudTransferRoute,
      signal: abortController.signal,
    });

    await vi.waitFor(() => expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(1));
    abortController.abort();
    releaseRefresh();

    await expect(pending).resolves.toBe(false);
    expect(pushTaskToPeer).not.toHaveBeenCalled();
    expect(inFlight).toEqual(new Set());
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

  it("retains an event that arrives before the requester catalog and pushes exactly once", async () => {
    const pushTaskToPeer = vi.fn(async () => {});
    const inFlight = new Set<string>();
    let machines: TransferMachine[] = [];
    const waitForRetry = vi.fn(async () => {
      machines = [machine()];
    });
    const event = {
      requestId: "pull-before-catalog",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    };
    const store = { items: [item()], pushTaskToPeer };

    const pending = handleTaskPullRequested(
      event,
      store as never,
      inFlight,
      () => machines,
      { maxAttempts: 2, waitForRetry },
    );
    const duplicate = handleTaskPullRequested(
      event,
      store as never,
      inFlight,
      () => machines,
      { maxAttempts: 2, waitForRetry },
    );

    await expect(duplicate).resolves.toBe(false);
    await expect(pending).resolves.toBe(true);
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(pushTaskToPeer).toHaveBeenCalledTimes(1);
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
