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
    const inFlight = new Map();
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
    releaseRefresh();
    expect(await duplicate).toBe("delivered");
    expect(await first).toBe("delivered");
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
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [
      machine({
        peerId: "peer-other",
        desktopId: "desktop-other",
        relayDesktopId: "desktop-other",
      }),
      machine(requesterOverrides),
    ], { refreshCloudTransferRoute })).resolves.toBe("delivered");

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
    const inFlight = new Map();

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

    await expect(pending).resolves.toBe("interrupted");
    expect(pushTaskToPeer).not.toHaveBeenCalled();
    expect(inFlight).toEqual(new Map());
  });

  it("lets abort take precedence when a pending route refresh rejects", async () => {
    let rejectRefresh!: (error: unknown) => void;
    const refreshCloudTransferRoute = vi.fn(() =>
      new Promise<void>((_resolve, reject) => { rejectRefresh = reject; }));
    const pushTaskToPeer = vi.fn(async () => {});
    const reportOperationalError = vi.fn();
    const waitForRetry = vi.fn(async () => {});
    const abortController = new AbortController();

    const pending = handleTaskPullRequested({
      requestId: "pull-aborted-refresh-rejection",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [machine()], {
      maxAttempts: 3,
      refreshCloudTransferRoute,
      reportOperationalError,
      signal: abortController.signal,
      waitForRetry,
    });

    await vi.waitFor(() => expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(1));
    abortController.abort();
    rejectRefresh(new Error("route refresh failed during unmount"));

    await expect(pending).resolves.toBe("interrupted");
    expect(waitForRetry).not.toHaveBeenCalled();
    expect(pushTaskToPeer).not.toHaveBeenCalled();
    expect(reportOperationalError).not.toHaveBeenCalled();
  });

  it("retries route refresh failures with a delay before starting one return push", async () => {
    const refreshCloudTransferRoute = vi.fn()
      .mockRejectedValueOnce(new Error("relay route unavailable"))
      .mockRejectedValueOnce(new Error("relay route unavailable"))
      .mockResolvedValue(undefined);
    const pushTaskToPeer = vi.fn(async () => {});
    const waitForRetry = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-route-retry",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [machine()], {
      maxAttempts: 3,
      retryDelayMs: 125,
      refreshCloudTransferRoute,
      waitForRetry,
    })).resolves.toBe("delivered");

    expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(3);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenNthCalledWith(1, 125);
    expect(waitForRetry).toHaveBeenNthCalledWith(2, 125);
    expect(pushTaskToPeer).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected return push as terminal instead of replaying non-idempotent setup", async () => {
    const pushTaskToPeer = vi.fn(async () => {
      throw new Error("preflight failed after reserving a transfer");
    });
    const waitForRetry = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-terminal-push",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [machine()], {
      maxAttempts: 3,
      waitForRetry,
    })).resolves.toBe("terminal");

    expect(pushTaskToPeer).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("retries explicitly safe pre-mutation push failures with a bounded delay", async () => {
    const retryable = Object.assign(new Error("source desktop identity unavailable"), {
      retryableTaskPush: true,
    });
    const pushTaskToPeer = vi.fn()
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue(undefined);
    const waitForRetry = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-retryable-push",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [machine()], {
      maxAttempts: 3,
      retryDelayMs: 125,
      waitForRetry,
    })).resolves.toBe("delivered");

    expect(pushTaskToPeer).toHaveBeenCalledTimes(3);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenNthCalledWith(1, 125);
    expect(waitForRetry).toHaveBeenNthCalledWith(2, 125);
  });

  it("preserves one successful route refresh across safe return-push retries", async () => {
    const retryable = Object.assign(new Error("source desktop identity unavailable"), {
      retryableTaskPush: true,
    });
    const refreshCloudTransferRoute = vi.fn(async () => {});
    const pushTaskToPeer = vi.fn()
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue(undefined);
    const waitForRetry = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-route-once-push-retry",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [machine()], {
      maxAttempts: 3,
      refreshCloudTransferRoute,
      waitForRetry,
    })).resolves.toBe("delivered");

    expect(refreshCloudTransferRoute).toHaveBeenCalledTimes(1);
    expect(pushTaskToPeer).toHaveBeenCalledTimes(3);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
  });

  it("rejects a requester that is absent from the current eligible machine catalog", async () => {
    const pushTaskToPeer = vi.fn(async () => {});

    await expect(handleTaskPullRequested({
      requestId: "pull-1",
      requesterPeerId: "peer-requester",
      sourceTaskId: "task-source",
    }, { items: [item()], pushTaskToPeer } as never, new Map(), [])).resolves.toBe("terminal");

    expect(pushTaskToPeer).not.toHaveBeenCalled();
  });

  it("retains an event that arrives before the requester catalog and pushes exactly once", async () => {
    const pushTaskToPeer = vi.fn(async () => {});
    const inFlight = new Map();
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

    await expect(duplicate).resolves.toBe("delivered");
    await expect(pending).resolves.toBe("delivered");
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
    }, { items, pushTaskToPeer } as never, new Map(), [machine()])).resolves.toBe("terminal");

    expect(pushTaskToPeer).not.toHaveBeenCalled();
  });
});
