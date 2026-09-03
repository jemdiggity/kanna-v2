import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteCompanionEvent } from "./desktopRemoteTaskClient";

const invokeMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
const listenMock = vi.hoisted(() => vi.fn(async () => () => undefined));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("../listen", () => ({
  listen: listenMock,
}));

import { invoke } from "../invoke";
import { listen } from "../listen";
import { createDesktopLanTerminalClient } from "./desktopLanTerminal";

describe("createDesktopLanTerminalClient", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "observe_transfer_peer_companion"
        || command === "observe_transfer_peer_session"
        ? { incarnation: 1 }
        : null,
    ));
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
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

    expect(invokeMock).toHaveBeenCalledWith("send_transfer_peer_session_input", {
      peerId: "peer-primary",
      sessionId: "task-1",
      data: "hello\n",
    });
    expect(invokeMock).toHaveBeenCalledWith("resize_transfer_peer_session", {
      peerId: "peer-primary",
      sessionId: "task-1",
      cols: 100,
      rows: 32,
    });
    expect(invokeMock).toHaveBeenCalledWith("close_transfer_peer_task", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
    expect(invokeMock).toHaveBeenCalledWith("advance_transfer_peer_task_stage", {
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

  it("reads paginated task directories and diffs through transfer sidecar commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        path: "src",
        entries: [{ name: "a.ts", path: "src/a.ts", isDir: false, size: 12 }],
        offset: 0,
        nextOffset: 1,
        totalEntries: 2,
      })
      .mockResolvedValueOnce({
        path: "src",
        entries: [{ name: "b.ts", path: "src/b.ts", isDir: false, size: 14 }],
        offset: 1,
        nextOffset: null,
        totalEntries: 2,
      })
      .mockResolvedValueOnce({
        taskId: "task-1",
        baseRef: "main",
        mergeBase: "abc123",
        patch: "diff --git a/src/a.ts b/src/a.ts",
        truncated: true,
      });
    const client = createDesktopLanTerminalClient();

    await expect(client.listTaskDirectory({
      desktopId: "peer-primary",
      taskId: "task-1",
      path: "src",
      showAllFiles: true,
    })).resolves.toMatchObject({
      path: "src",
      entries: [
        expect.objectContaining({ path: "src/a.ts" }),
        expect.objectContaining({ path: "src/b.ts" }),
      ],
      nextOffset: null,
      totalEntries: 2,
    });
    await expect(client.readTaskDiff({
      desktopId: "peer-primary",
      taskId: "task-1",
      request: { scope: "branch", mode: "all" },
    })).resolves.toMatchObject({ truncated: true });

    expect(invoke).toHaveBeenNthCalledWith(1, "read_transfer_peer_task_directory", {
      peerId: "peer-primary",
      taskId: "task-1",
      path: "src",
      showAllFiles: true,
      offset: 0,
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "read_transfer_peer_task_directory", {
      peerId: "peer-primary",
      taskId: "task-1",
      path: "src",
      showAllFiles: true,
      offset: 1,
      limit: 100,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "read_transfer_peer_task_diff", {
      peerId: "peer-primary",
      taskId: "task-1",
      scope: "branch",
      mode: "all",
    });
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
    await vi.waitFor(() => expect(observeCalls).toBe(2));
    await Promise.resolve();

    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([]);
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

  it("rejects delayed terminal events from a replaced observer lease", async () => {
    const firstEvents: unknown[] = [];
    const replacementEvents: unknown[] = [];
    const client = createDesktopLanTerminalClient();

    client.observeTerminal({
      desktopId: "peer-primary",
      taskId: "task-1",
      listener: (event) => firstEvents.push(event),
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "observe_transfer_peer_session",
      expect.anything(),
    ));
    const firstLease = vi.mocked(invoke).mock.calls
      .find(([command]) => command === "observe_transfer_peer_session")?.[1]
      ?.observerLeaseId;

    client.observeTerminal({
      desktopId: "peer-primary",
      taskId: "task-1",
      listener: (event) => replacementEvents.push(event),
    });
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) =>
      command === "observe_transfer_peer_session"
    )).toHaveLength(2));
    const replacementLease = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === "observe_transfer_peer_session")
      .at(-1)?.[1]?.observerLeaseId;

    const emitTerminal = listenerFor("transfer-terminal-event");
    emitTerminal({
      payload: {
        peer_id: "peer-primary",
        session_id: "task-1",
        observer_lease_id: firstLease,
        event: { type: "output", session_id: "task-1", data: [111, 108, 100] },
      },
    });
    emitTerminal({
      payload: {
        peer_id: "peer-primary",
        session_id: "task-1",
        observer_lease_id: replacementLease,
        event: { type: "output", session_id: "task-1", data: [110, 101, 119] },
      },
    });

    expect(replacementEvents).toEqual([
      {
        type: "output",
        taskId: "task-1",
        data: new TextEncoder().encode("new"),
      },
    ]);
  });

  it("observes complete companion frames through one shared Tauri listener", async () => {
    const companionEvents: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopLanTerminalClient();
    client.observeTerminal({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => companionEvents.push(event),
    });
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(3));
    await waitForCompanionObservations(1);
    const generation = companionGenerationAt(0);

    const companionListener = listenerFor("transfer-companion-event");
    companionListener({
      payload: {
        type: "companion_event",
        incarnation: 1,
        peer_id: "peer-owner",
        task_id: "task-1",
        generation,
        frame: {
          type: "companion_snapshot",
          task_id: "task-1",
          session_id: "session-1",
          revision: "revision-1",
          document_kind: "fragment",
          html: "<h2>Hello</h2>",
          source_origin: "http://localhost:52341",
          assets: [{
            name: "layout.png",
            content_type: "image/png",
            digest: "asset-digest",
            data_b64: "UE5H",
          }, null, { name: "incomplete.png" }],
        },
      },
    });

    expect(companionEvents.filter((event) => event.type !== "connection")).toEqual([{
      type: "snapshot",
      taskId: "task-1",
      snapshot: {
        sessionId: "session-1",
        revision: "revision-1",
        documentKind: "fragment",
        html: "<h2>Hello</h2>",
        sourceOrigin: "http://localhost:52341",
        assets: [{
          name: "layout.png",
          contentType: "image/png",
          digest: "asset-digest",
          dataB64: "UE5H",
        }],
      },
    }]);
  });

  it("ignores malformed, wrong-owner, and wrong-task companion notifications", async () => {
    const listener = vi.fn();
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener,
    });
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await waitForCompanionObservations(1);
    const emit = listenerFor("transfer-companion-event");

    for (const payload of [
      null,
      { peer_id: "peer-other", task_id: "task-1", frame: validUnavailable() },
      { peer_id: "peer-owner", task_id: "task-other", frame: validUnavailable() },
      { peer_id: "peer-owner", task_id: "task-1", frame: { ...validUnavailable(), task_id: "task-other" } },
      {
        peer_id: "peer-owner",
        task_id: "task-1",
        frame: {
          type: "companion_snapshot",
          task_id: "task-1",
          session_id: "session-1",
          revision: "revision-1",
          document_kind: "fragment",
          html: "<h2>Hello</h2>",
          assets: [],
          source_origin: 52341,
        },
      },
    ]) {
      emit({ payload });
    }

    expect(listener.mock.calls.filter(([event]) =>
      (event as DesktopRemoteCompanionEvent).type !== "connection"
    )).toHaveLength(0);
  });

  it("normalizes unavailable, event-result, and error frames", async () => {
    const events: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await waitForCompanionObservations(1);
    const emit = listenerFor("transfer-companion-event");

    emitCompanion(emit, validUnavailable());
    emitCompanion(emit, {
      type: "companion_event_result",
      task_id: "task-1",
      session_id: "session-1",
      revision: "revision-1",
      event_id: "event-1",
      accepted: false,
      code: "stale_revision",
      message: "Refresh the companion.",
    });
    emitCompanion(emit, {
      type: "companion_event_result",
      task_id: "task-1",
      event_id: "legacy-event",
      accepted: true,
    });
    emitCompanion(emit, {
      type: "companion_error",
      task_id: "task-1",
      code: "read_failed",
      message: "Could not read the companion.",
    });

    expect(events.filter((event) => event.type !== "connection")).toEqual([
      { type: "unavailable", taskId: "task-1" },
      {
        type: "event_result",
        taskId: "task-1",
        result: {
          sessionId: "session-1",
          revision: "revision-1",
          eventId: "event-1",
          accepted: false,
          code: "stale_revision",
          message: "Refresh the companion.",
        },
      },
      {
        type: "error",
        taskId: "task-1",
        code: "incompatible_companion_result",
        message: "The remote companion result is from an incompatible version.",
      },
      {
        type: "error",
        taskId: "task-1",
        code: "read_failed",
        message: "Could not read the companion.",
      },
    ]);
  });

  it("sends companion events and closes idempotently", async () => {
    const client = createDesktopLanTerminalClient();
    const subscription = client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });
    const event = {
      event_id: "event-1",
      type: "click",
      choice: "grid",
      text: "Grid",
      id: "layout-grid",
      timestamp: 1_784_268_000_000,
    };
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "observe_transfer_peer_companion",
      expect.anything(),
    ));
    await Promise.resolve();
    const generation = companionGenerationAt(0);

    expect(subscription.sendEvent("session-1", "revision-1", event)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("send_transfer_peer_companion_event", {
      peerId: "peer-owner",
      taskId: "task-1",
      sessionId: "session-1",
      revision: "revision-1",
      generation,
      event,
    });

    subscription.close();
    subscription.close();
    expect(subscription.sendEvent("session-1", "revision-1", event)).toBe(false);
    expect(invokeMock.mock.calls.filter(([command]) =>
      command === "unobserve_transfer_peer_companion"
    )).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("unobserve_transfer_peer_companion", {
      peerId: "peer-owner",
      taskId: "task-1",
      generation,
    });
  });

  it("does not let an old companion subscription close its replacement", () => {
    const client = createDesktopLanTerminalClient();
    const first = client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });
    const replacement = client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });
    const event = {
      event_id: "event-1",
      type: "click",
      choice: "grid",
      text: "Grid",
      id: null,
      timestamp: 1,
    };

    first.close();
    expect(first.sendEvent("session-1", "revision-1", event)).toBe(false);
    expect(invokeMock.mock.calls.filter(([command]) =>
      command === "unobserve_transfer_peer_companion"
    )).toHaveLength(0);

    replacement.close();
    expect(invokeMock.mock.calls.filter(([command]) =>
      command === "unobserve_transfer_peer_companion"
    )).toHaveLength(1);
  });

  it("keeps generation 2 installed when its observation completes before generation 1", async () => {
    const observeResolvers: Array<(value: { incarnation: number }) => void> = [];
    invokeMock.mockImplementation((command) => {
      if (command !== "observe_transfer_peer_companion") {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        observeResolvers.push(resolve);
      });
    });
    const firstEvents: DesktopRemoteCompanionEvent[] = [];
    const secondEvents: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => firstEvents.push(event),
    });
    await waitForCompanionObservations(1);
    const generation1 = companionGenerationAt(0);
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => secondEvents.push(event),
    });
    await waitForCompanionObservations(2);
    const generation2 = companionGenerationAt(1);

    observeResolvers[1]({ incarnation: 2 });
    await vi.waitFor(() => expect(secondEvents).toContainEqual({
      type: "connection",
      taskId: "task-1",
      connected: true,
    }));
    observeResolvers[0]({ incarnation: 1 });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      "unobserve_transfer_peer_companion",
      {
        peerId: "peer-owner",
        taskId: "task-1",
        generation: generation1,
      },
    ));

    expect(generation2).not.toBe(generation1);
    expect(firstEvents).not.toContainEqual(expect.objectContaining({
      type: "connection",
      connected: true,
    }));
    expect(secondEvents.filter((event) =>
      event.type === "connection" && event.connected
    )).toHaveLength(1);
  });

  it("keeps generations unique across client instances and delayed cleanup", async () => {
    const firstEvents: DesktopRemoteCompanionEvent[] = [];
    const secondEvents: DesktopRemoteCompanionEvent[] = [];
    const firstClient = createDesktopLanTerminalClient();
    const first = firstClient.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => firstEvents.push(event),
    });
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) =>
      command === "observe_transfer_peer_companion"
    )).toHaveLength(1));
    const firstGeneration = companionGenerationAt(0);

    const secondClient = createDesktopLanTerminalClient();
    secondClient.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => secondEvents.push(event),
    });
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) =>
      command === "observe_transfer_peer_companion"
    )).toHaveLength(2));
    const secondGeneration = companionGenerationAt(1);

    expect(secondGeneration).not.toBe(firstGeneration);
    first.close();
    expect(invokeMock).toHaveBeenCalledWith("unobserve_transfer_peer_companion", {
      peerId: "peer-owner",
      taskId: "task-1",
      generation: firstGeneration,
    });

    const companionListeners = listenersFor("transfer-companion-event");
    for (const emit of companionListeners) {
      emit({
        payload: {
          incarnation: 1,
          peer_id: "peer-owner",
          task_id: "task-1",
          generation: firstGeneration,
          frame: validUnavailable(),
        },
      });
    }
    expect(secondEvents.some((event) => event.type === "unavailable")).toBe(false);

    for (const emit of companionListeners) {
      emit({
        payload: {
          incarnation: 1,
          peer_id: "peer-owner",
          task_id: "task-1",
          generation: secondGeneration,
          frame: validUnavailable(),
        },
      });
    }
    expect(firstEvents.some((event) => event.type === "unavailable")).toBe(false);
    expect(secondEvents).toContainEqual({ type: "unavailable", taskId: "task-1" });
  });

  it("does not start observation when closed before the shared listener resolves", async () => {
    let resolveListen!: (unlisten: () => void) => void;
    listenMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveListen = resolve;
    }));
    const client = createDesktopLanTerminalClient();
    const subscription = client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });

    subscription.close();
    resolveListen(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock.mock.calls.filter(([command]) =>
      command === "observe_transfer_peer_companion"
    )).toHaveLength(0);
  });

  it("keeps adversarial peer and task ids isolated", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({ desktopId: "a:b", taskId: "c", listener: first });
    client.observeCompanion({ desktopId: "a", taskId: "b:c", listener: second });
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await waitForCompanionObservations(2);
    const firstGeneration = companionGenerationAt(0);
    const secondGeneration = companionGenerationAt(1);
    const emit = listenerFor("transfer-companion-event");

    emit({
      payload: {
        incarnation: 1,
        peer_id: "a:b",
        task_id: "c",
        generation: firstGeneration,
        frame: { type: "companion_unavailable", task_id: "c" },
      },
    });
    emit({
      payload: {
        incarnation: 1,
        peer_id: "a",
        task_id: "b:c",
        generation: secondGeneration,
        frame: { type: "companion_unavailable", task_id: "b:c" },
      },
    });

    expect(first).toHaveBeenCalledWith({ type: "unavailable", taskId: "c" });
    expect(second).toHaveBeenCalledWith({ type: "unavailable", taskId: "b:c" });
  });

  it("reconnects with a fresh generation and ignores stale attempt frames", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      const subscription = client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await waitForCompanionObservations(1);
      const failedGeneration = companionGenerationAt(0);
      const emit = listenerFor("transfer-companion-event");
      emitCompanion(emit, {
        type: "companion_error",
        task_id: "task-1",
        code: "connection_failed",
        message: "socket closed",
      });

      expect(events.at(-1)).toEqual({
        type: "connection",
        taskId: "task-1",
        connected: false,
      });
      invokeMock.mockClear();
      expect(subscription.sendEvent("session-1", "revision-1", {
        event_id: "event-disconnected",
        type: "click",
        choice: "grid",
        text: "Grid",
        id: null,
        timestamp: 1,
      })).toBe(false);
      expect(invokeMock).not.toHaveBeenCalledWith(
        "send_transfer_peer_companion_event",
        expect.anything(),
      );
      await vi.advanceTimersByTimeAsync(250);
      const retryGeneration = companionGenerationAt(0);
      expect(invokeMock).toHaveBeenCalledWith("observe_transfer_peer_companion", {
        peerId: "peer-owner",
        taskId: "task-1",
        generation: retryGeneration,
      });
      expect(retryGeneration).not.toBe(failedGeneration);

      emit({
        payload: {
          incarnation: 1,
          peer_id: "peer-owner",
          task_id: "task-1",
          generation: failedGeneration,
          frame: validUnavailable(),
        },
      });
      expect(events.some((event) => event.type === "unavailable")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks every live companion disconnected and retries when the owned transfer sidecar exits", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await waitForCompanionObservations(1);
      const firstGeneration = companionGenerationAt(0);

      listenerFor("transfer-sidecar-exited")({ payload: { incarnation: 1 } });
      expect(events.at(-1)).toEqual({
        type: "connection",
        taskId: "task-1",
        connected: false,
      });

      await vi.advanceTimersByTimeAsync(250);
      const retryGeneration = companionGenerationAt(1);
      expect(retryGeneration).not.toBe(firstGeneration);
      expect(invokeMock).toHaveBeenCalledWith("observe_transfer_peer_companion", {
        peerId: "peer-owner",
        taskId: "task-1",
        generation: retryGeneration,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a respawned sidecar's snapshot that beats the retry observe response", async () => {
    vi.useFakeTimers();
    try {
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await waitForCompanionObservations(1);

      // The first attempt bound the observer to sidecar incarnation 1.
      listenerFor("transfer-sidecar-exited")({ payload: { incarnation: 1 } });

      // The retry's observe response hangs, so the observer has not yet
      // learned the respawned incarnation when its first frame arrives —
      // the companion event lane is unordered relative to the response.
      invokeMock.mockImplementation((command) =>
        command === "observe_transfer_peer_companion"
          ? new Promise(() => undefined)
          : Promise.resolve(null),
      );
      await vi.advanceTimersByTimeAsync(250);
      await waitForCompanionObservations(2);
      const retryGeneration = companionGenerationAt(1);

      listenerFor("transfer-companion-event")({
        payload: {
          type: "companion_event",
          incarnation: 2,
          peer_id: "peer-owner",
          task_id: "task-1",
          generation: retryGeneration,
          frame: {
            type: "companion_snapshot",
            task_id: "task-1",
            session_id: "session-1",
            revision: "revision-2",
            document_kind: "fragment",
            html: "<h2>Respawned</h2>",
            assets: [],
          },
        },
      });

      expect(events.at(-1)).toMatchObject({
        type: "snapshot",
        taskId: "task-1",
        snapshot: { revision: "revision-2", html: "<h2>Respawned</h2>" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts multiple companion observers once for one sidecar death", async () => {
    vi.useFakeTimers();
    try {
      const companionEvents = [vi.fn(), vi.fn()];
      const client = createDesktopLanTerminalClient();
      for (let index = 0; index < 2; index += 1) {
        client.observeCompanion({
          desktopId: "peer-owner",
          taskId: `companion-${index}`,
          listener: companionEvents[index],
        });
      }
      await vi.waitFor(() => expect(invokeMock.mock.calls.filter(
        ([command]) => command === "observe_transfer_peer_companion",
      )).toHaveLength(2));
      invokeMock.mockClear();
      invokeMock.mockImplementation((command) => Promise.resolve(
        command === "observe_transfer_peer_companion"
          ? { incarnation: 2 }
          : null,
      ));

      const emitExit = listenerFor("transfer-sidecar-exited");
      emitExit({ payload: { incarnation: 1 } });
      emitExit({ payload: { incarnation: 1 } });
      await vi.advanceTimersByTimeAsync(250);

      expect(invokeMock.mock.calls.filter(
        ([command]) => command === "observe_transfer_peer_companion",
      )).toHaveLength(2);
      for (const listener of companionEvents) {
        expect(listener.mock.calls.filter(([event]) =>
          (event as DesktopRemoteCompanionEvent).type === "connection"
          && !(event as Extract<DesktopRemoteCompanionEvent, { type: "connection" }>).connected
        )).toHaveLength(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale reader exit after its replacement is healthy", async () => {
    let incarnation = 1;
    invokeMock.mockImplementation((command) => Promise.resolve(
      command === "observe_transfer_peer_companion"
        ? { incarnation: incarnation++ }
        : null,
    ));
    const events: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });
    await waitForCompanionObservations(1);

    listenerFor("transfer-sidecar-exited")({ payload: { incarnation: 0 } });

    expect(events.at(-1)).toEqual({
      type: "connection",
      taskId: "task-1",
      connected: true,
    });
    expect(invokeMock.mock.calls.filter(
      ([command]) => command === "observe_transfer_peer_companion",
    )).toHaveLength(1);
  });

  it("surfaces a v1 peer as unsupported without retrying forever", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation((command) =>
        command === "observe_transfer_peer_companion"
          ? Promise.reject(new Error("peer does not support visual companions"))
          : Promise.resolve(null));
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      client.observeCompanion({
        desktopId: "peer-v1",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await vi.waitFor(() => expect(events).toContainEqual({
        type: "error",
        taskId: "task-1",
        code: "companion_unsupported",
        message: "This paired desktop does not support remote visual companions.",
      }));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(invokeMock.mock.calls.filter(
        ([command]) => command === "observe_transfer_peer_companion",
      )).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes companion events and reconnects after an uncertain send failure", async () => {
    vi.useFakeTimers();
    try {
      let rejectSend!: (reason?: unknown) => void;
      invokeMock.mockImplementation((command) => {
        if (command === "send_transfer_peer_companion_event") {
          return new Promise((_, reject) => {
            rejectSend = reject;
          });
        }
        return Promise.resolve(
          command === "observe_transfer_peer_companion" ? { incarnation: 1 } : null,
        );
      });
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      const subscription = client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await waitForCompanionObservations(1);
      const event = {
        event_id: "event-1",
        type: "click",
        choice: "grid",
        text: "Grid",
        id: null,
        timestamp: 1,
      };

      expect(subscription.sendEvent("session-1", "revision-1", event)).toBe(true);
      expect(subscription.sendEvent("session-1", "revision-1", {
        ...event,
        event_id: "event-2",
      })).toBe(false);

      rejectSend(new Error("request may not have reached owner"));
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toContainEqual({
        type: "connection",
        taskId: "task-1",
        connected: false,
      });
      expect(events).toContainEqual({
        type: "error",
        taskId: "task-1",
        code: "send_failed",
        message: "request may not have reached owner",
      });

      await vi.advanceTimersByTimeAsync(250);
      const retryGeneration = companionGenerationAt(1);
      expect(invokeMock).toHaveBeenCalledWith("observe_transfer_peer_companion", {
        peerId: "peer-owner",
        taskId: "task-1",
        generation: retryGeneration,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report connected when stream failure beats the observe response", async () => {
    vi.useFakeTimers();
    try {
      let resolveObserve!: (value: unknown) => void;
      invokeMock.mockImplementation((command) => {
        if (command === "observe_transfer_peer_companion") {
          return new Promise((resolve) => {
            resolveObserve = resolve;
          });
        }
        return Promise.resolve(null);
      });
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      const subscription = client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await Promise.resolve();
      await Promise.resolve();
      const generation = companionGenerationAt(0);
      const emit = listenerFor("transfer-companion-event");
      emit({
        payload: {
          incarnation: 1,
          peer_id: "peer-owner",
          task_id: "task-1",
          generation,
          frame: {
            type: "companion_error",
            task_id: "task-1",
            code: "connection_failed",
            message: "stream closed after ACK",
          },
        },
      });

      resolveObserve({ incarnation: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(events.filter((event) => event.type === "connection")).toEqual([{
        type: "connection",
        taskId: "task-1",
        connected: false,
      }]);
      expect(subscription.sendEvent("session-1", "revision-1", {
        event_id: "event-disconnected",
        type: "click",
        choice: "grid",
        text: "Grid",
        id: null,
        timestamp: 1,
      })).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      const retryGeneration = companionGenerationAt(1);
      expect(retryGeneration).not.toBe(generation);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report connected when the sidecar exit beats the observe response", async () => {
    vi.useFakeTimers();
    try {
      let resolveObserve!: (value: unknown) => void;
      invokeMock.mockImplementation((command) => {
        if (command === "observe_transfer_peer_companion") {
          return new Promise((resolve) => {
            resolveObserve = resolve;
          });
        }
        return Promise.resolve(null);
      });
      const events: DesktopRemoteCompanionEvent[] = [];
      const client = createDesktopLanTerminalClient();
      client.observeCompanion({
        desktopId: "peer-owner",
        taskId: "task-1",
        listener: (event) => events.push(event),
      });
      await Promise.resolve();
      await Promise.resolve();

      listenerFor("transfer-sidecar-exited")({ payload: { incarnation: 7 } });
      resolveObserve({ incarnation: 7 });
      await Promise.resolve();
      await Promise.resolve();

      expect(events).not.toContainEqual({
        type: "connection",
        taskId: "task-1",
        connected: true,
      });
      expect(events).toContainEqual({
        type: "connection",
        taskId: "task-1",
        connected: false,
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(invokeMock.mock.calls.filter(
        ([command]) => command === "observe_transfer_peer_companion",
      )).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a buffered companion frame after its sidecar incarnation exited", async () => {
    const events: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopLanTerminalClient();
    client.observeCompanion({
      desktopId: "peer-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });
    await waitForCompanionObservations(1);
    const generation = companionGenerationAt(0);
    const emit = listenerFor("transfer-companion-event");

    listenerFor("transfer-sidecar-exited")({ payload: { incarnation: 1 } });
    emit({
      payload: {
        incarnation: 1,
        peer_id: "peer-owner",
        task_id: "task-1",
        generation,
        frame: {
          type: "companion_snapshot",
          task_id: "task-1",
          session_id: "session-1",
          revision: "stale-after-exit",
          document_kind: "fragment",
          html: "<h1>stale</h1>",
          source_origin: null,
          assets: [],
        },
      },
    });

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "snapshot",
    }));
  });




});

function listenerFor(eventName: string): (event: { payload: unknown }) => void {
  const call = listenMock.mock.calls.find(([name]) => name === eventName);
  expect(call).toBeDefined();
  return call![1] as (event: { payload: unknown }) => void;
}

function listenersFor(eventName: string): Array<(event: { payload: unknown }) => void> {
  return listenMock.mock.calls
    .filter(([name]) => name === eventName)
    .map(([, listener]) => listener as (event: { payload: unknown }) => void);
}

function companionGenerationAt(index: number): string {
  const call = invokeMock.mock.calls.filter(([command]) =>
    command === "observe_transfer_peer_companion"
  )[index];
  expect(call).toBeDefined();
  return (call![1] as { generation: string }).generation;
}

async function waitForCompanionObservations(count: number): Promise<void> {
  await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) =>
    command === "observe_transfer_peer_companion"
  )).toHaveLength(count));
}

function emitCompanion(
  listener: (event: { payload: unknown }) => void,
  frame: Record<string, unknown>,
) {
  listener({
    payload: {
      type: "companion_event",
      incarnation: 1,
      peer_id: "peer-owner",
      task_id: "task-1",
      generation: companionGenerationAt(0),
      frame,
    },
  });
}

function validUnavailable() {
  return {
    type: "companion_unavailable",
    task_id: "task-1",
  };
}
