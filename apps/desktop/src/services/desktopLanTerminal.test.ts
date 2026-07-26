import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock("../listen", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { invoke } from "../invoke";
import { listen } from "../listen";
import { createDesktopLanTerminalClient } from "./desktopLanTerminal";

describe("createDesktopLanTerminalClient", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => undefined);
  });
  it("sends LAN terminal control actions through Tauri commands", async () => {
    const client = createDesktopLanTerminalClient();

    await client.sendInput({ desktopId: "peer-primary", taskId: "task-1", data: "hello\n" });
    await client.resize({ desktopId: "peer-primary", taskId: "task-1", cols: 100, rows: 32 });
    await client.closeTask({ desktopId: "peer-primary", taskId: "task-1" });
    await client.advanceStage({
      desktopId: "peer-primary",
      taskId: "task-1",
      expectedTransitionRevision: "run-1",
    });
    await client.markTaskRead({
      desktopId: "peer-primary",
      taskId: "task-1",
      expectedActivityRevision: 7,
    });

    expect(invoke).toHaveBeenCalledWith("send_transfer_peer_session_input", {
      peerId: "peer-primary",
      sessionId: "task-1",
      data: "hello\n",
    });
    expect(invoke).toHaveBeenCalledWith("resize_transfer_peer_session", {
      peerId: "peer-primary",
      sessionId: "task-1",
      cols: 100,
      rows: 32,
    });
    expect(invoke).toHaveBeenCalledWith("close_transfer_peer_task", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
    expect(invoke).toHaveBeenCalledWith("advance_transfer_peer_task_stage", {
      peerId: "peer-primary",
      taskId: "task-1",
      expectedTransitionRevision: "run-1",
    });
    expect(invoke).toHaveBeenCalledWith("mark_transfer_peer_task_read", {
      peerId: "peer-primary",
      taskId: "task-1",
      expectedActivityRevision: 7,
    });
  });

  it("reads a remote task file through the transfer sidecar command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      type: "read_peer_task_file",
      request_id: "read-task-file-1",
      path: "src/app.ts",
      content: "remote body",
    });
    const client = createDesktopLanTerminalClient();

    await expect(
      client.readTaskFile({ desktopId: "peer-primary", taskId: "task-1", path: "src/app.ts" }),
    ).resolves.toEqual({ path: "src/app.ts", content: "remote body" });

    expect(invoke).toHaveBeenCalledWith("read_transfer_peer_task_file", {
      peerId: "peer-primary",
      taskId: "task-1",
      path: "src/app.ts",
    });
  });

  it("rejects a malformed LAN task file response", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ path: "src/app.ts" });
    const client = createDesktopLanTerminalClient();

    await expect(
      client.readTaskFile({ desktopId: "peer-primary", taskId: "task-1", path: "src/app.ts" }),
    ).rejects.toThrow("LAN task file response was malformed.");
  });

  it("does not let an old close remove or notify a replacement observer", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstObserve = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondObserve = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let observeCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "observe_transfer_peer_session") {
        observeCalls += 1;
        await (observeCalls === 1 ? firstObserve : secondObserve);
      }
      return null;
    });
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const client = createDesktopLanTerminalClient();

    const first = client.observeTerminal({
      desktopId: "peer-primary",
      taskId: "task-1",
      listener: (event) => firstEvents.push(event),
    });
    await Promise.resolve();
    client.observeTerminal({
      desktopId: "peer-primary",
      taskId: "task-1",
      listener: (event) => secondEvents.push(event),
    });
    await vi.waitFor(() => expect(observeCalls).toBe(2));
    first.close();
    releaseFirst();
    releaseSecond();
    await vi.waitFor(() => expect(secondEvents).toHaveLength(1));

    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([{ type: "ready", taskId: "task-1" }]);
    const observeArgs = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "observe_transfer_peer_session")
      .map(([, args]) => args);
    const unobserveArgs = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "unobserve_transfer_peer_session")
      .map(([, args]) => args);
    expect(observeArgs).toHaveLength(2);
    expect(observeArgs[0]).toEqual(expect.objectContaining({
      observerLeaseId: expect.any(String),
    }));
    expect(observeArgs[1]).toEqual(expect.objectContaining({
      observerLeaseId: expect.any(String),
    }));
    expect(observeArgs[0]?.observerLeaseId).not.toBe(observeArgs[1]?.observerLeaseId);
    expect(unobserveArgs).toContainEqual(expect.objectContaining({
      observerLeaseId: observeArgs[0]?.observerLeaseId,
    }));
  });

  it("does not install or notify an observer after its subscription closes", async () => {
    let releaseListener!: () => void;
    vi.mocked(listen).mockImplementation(() => new Promise((resolve) => {
      releaseListener = () => resolve(() => undefined);
    }));
    const events: unknown[] = [];
    const client = createDesktopLanTerminalClient();

    const subscription = client.observeTerminal({
      desktopId: "peer-primary",
      taskId: "task-closed",
      listener: (event) => events.push(event),
    });
    subscription.close();
    releaseListener();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(invoke).not.toHaveBeenCalledWith(
      "observe_transfer_peer_session",
      expect.anything(),
    );
  });
});
