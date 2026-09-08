import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const getIdTokenMock = vi.hoisted(() => vi.fn(async () => "id-token"));

vi.mock("../invoke", () => ({
  invoke: invokeMock,
}));

vi.mock("./desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    getIdToken: getIdTokenMock,
  })),
}));

import {
  PRODUCTION_CLOUD_TRANSPORT_URL,
  STAGING_CLOUD_TRANSPORT_URL,
  createConfiguredDesktopRelayTerminalClient,
  createDesktopRelayTerminalClient,
  listActiveDesktopIdsViaRelay,
  resolveDesktopCloudTransportUrlFromEnv,
  type DesktopRelayTerminalEvent,
} from "./desktopRelayTerminal";
import type { DesktopRemoteCompanionEvent } from "./desktopRemoteTaskClient";

class FakeSocket {
  readyState = 1;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  drop(code?: number) {
    this.onclose?.(code === undefined ? {} : { code });
  }
}

async function openRelayTunnel(socket: FakeSocket) {
  socket.onopen?.();
  await Promise.resolve();
  socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
  await Promise.resolve();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "tunnel_ready",
      tunnelId: "tunnel-1",
      desktopId: "desktop-owner",
    }),
  });
  await Promise.resolve();
}

describe("configured desktop relay helpers", () => {
  let originalWebSocket: typeof globalThis.WebSocket | undefined;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    invokeMock.mockImplementation(async (_cmd: string, args?: { name?: string }) => {
      if (args?.name === "KANNA_RELAY_URL" || args?.name === "KANNA_RELAY_PORT") return "";
      return "";
    });
    getIdTokenMock.mockResolvedValue("id-token");
    vi.stubEnv("DEV", false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invokeMock.mockReset();
    getIdTokenMock.mockReset();
    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    } else {
      delete (globalThis as { WebSocket?: unknown }).WebSocket;
    }
  });

  it("creates the configured terminal client against the production relay when relay env is absent outside dev", async () => {
    const socket = new FakeSocket();
    const webSocketMock = vi.fn(function WebSocketMock() {
      return socket;
    });
    globalThis.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const client = await createConfiguredDesktopRelayTerminalClient();

    expect(client).not.toBeNull();
    const sendPromise = client!.sendInput({
      desktopId: "desktop-owner",
      taskId: "task-1",
      data: "hello\n",
    });
    await openRelayTunnel(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["term_input_boundary"],
      }),
    });
    await Promise.resolve();

    expect(webSocketMock).toHaveBeenCalledWith(PRODUCTION_CLOUD_TRANSPORT_URL);
    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual({ type: "auth", id_token: "id-token" });
    expect(sent).toContainEqual(expect.objectContaining({
      type: "tunnel_request",
      desktopId: "desktop-owner",
    }));
    expect(sent).toContainEqual({
      type: "auth",
      capabilities: ["companion_event_epoch", "term_input_boundary", "terminal_geometry"],
      credential: "id-token",
    });
    expect(sent).toContainEqual({
      type: "term_input",
      task_id: "task-1",
      data_b64: "aGVsbG8K",
    });

    await expect(sendPromise).resolves.toBeUndefined();
  });

  it("lists active desktop ids through the production relay when relay env is absent outside dev", async () => {
    const socket = new FakeSocket();
    const webSocketMock = vi.fn(function WebSocketMock() {
      return socket;
    });
    globalThis.WebSocket = webSocketMock as unknown as typeof WebSocket;

    const listPromise = listActiveDesktopIdsViaRelay();
    await vi.waitFor(() => {
      expect(webSocketMock).toHaveBeenCalledWith(PRODUCTION_CLOUD_TRANSPORT_URL);
    });
    socket.onopen?.();
    await Promise.resolve();
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    const invoke = sent.find((entry) => entry.command === "list_active_desktops");
    expect(invoke).toMatchObject({
      type: "invoke",
      command: "list_active_desktops",
      args: {},
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: invoke.id,
        data: { desktopIds: ["desktop-a", "", "desktop-b"] },
      }),
    });

    await expect(listPromise).resolves.toEqual(new Set(["desktop-a", "desktop-b"]));
    expect(socket.readyState).toBe(3);
  });
});

describe("createDesktopRelayTerminalClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-refreshes both relay and stream credentials after an auth rejection", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const getIdToken = vi.fn(async (forceRefresh?: boolean) =>
      forceRefresh ? "refreshed-token" : "cached-token"
    );
    const client = createDesktopRelayTerminalClient({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      getIdToken,
      relayUrl: "ws://relay.test",
    });
    const events: DesktopRemoteCompanionEvent[] = [];
    client.observeCompanion({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });

    const firstSocket = sockets[0];
    await openRelayTunnel(firstSocket);
    firstSocket.drop(4005);
    await vi.advanceTimersByTimeAsync(250);

    const refreshedSocket = sockets[1];
    await openRelayTunnel(refreshedSocket);
    refreshedSocket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal", "companion"],
      }),
    });
    await Promise.resolve();

    expect(getIdToken.mock.calls.map(([forceRefresh]) => forceRefresh ?? false))
      .toEqual([false, false, true, true]);
    expect(refreshedSocket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "auth",
      id_token: "refreshed-token",
    });
    expect(refreshedSocket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "auth",
      capabilities: ["companion_event_epoch", "term_input_boundary", "terminal_geometry"],
      credential: "refreshed-token",
    });
    expect(refreshedSocket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });
    expect(events).toContainEqual({
      type: "connection",
      taskId: "task-1",
      connected: true,
    });

    client.close();
  });

  it("observes and interacts with a remote visual companion over the relay", async () => {
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket);
    const events: DesktopRemoteCompanionEvent[] = [];
    const client = createDesktopRelayTerminalClient({
      createSocket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });
    client.observeTerminal({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });

    const subscription = client.observeCompanion({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });
    expect(createSocket).toHaveBeenCalledOnce();

    await openRelayTunnel(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        stream_kinds: ["agent", "terminal", "companion"],
        capabilities: ["companion_attachment_epoch"],
      }),
    });
    await Promise.resolve();
    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "attach",
      task_id: "task-1",
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: 1,
      include_assets: true,
    });
    expect(events).toContainEqual({
      type: "connection",
      taskId: "task-1",
      connected: true,
    });

    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_snapshot",
        task_id: "task-1",
        session_id: "session-1",
        revision: "revision-1",
        document_kind: "fragment",
        html: "<h2>Hello</h2>",
        source_origin: "http://localhost:52341",
        attachment_epoch: 1,
        assets: [{
          name: "layout.png",
          content_type: "image/png",
          digest: "asset-digest",
          data_b64: "UE5H",
        }],
      }),
    });

    expect(events.at(-1)).toMatchObject({
      type: "snapshot",
      taskId: "task-1",
      snapshot: {
        sourceOrigin: "http://localhost:52341",
        assets: [{ name: "layout.png", contentType: "image/png" }],
      },
    });

    const choice = {
      session_id: "session-1",
      revision: "revision-1",
      event_id: "event-1",
      type: "select",
      choice: "grid",
      text: "Grid",
      id: null,
      timestamp: 1,
    };
    expect(subscription.sendEvent("session-1", "revision-1", choice)).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: "companion_event",
      task_id: "task-1",
      session_id: "session-1",
      revision: "revision-1",
      event: choice,
    });

    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_event_result",
        task_id: "task-1",
        session_id: "session-1",
        revision: "revision-1",
        event_id: "event-1",
        accepted: false,
        code: "stale_revision",
        message: "Refresh the companion.",
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_unavailable",
        task_id: "task-1",
        attachment_epoch: 1,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_event_result",
        task_id: "task-1",
        event_id: "legacy-event",
        accepted: true,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "companion_error",
        task_id: "task-1",
        code: "read_failed",
        message: "Could not read the companion.",
        attachment_epoch: 1,
      }),
    });
    expect(events.slice(-3)).toEqual([
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
      { type: "unavailable", taskId: "task-1" },
      {
        type: "error",
        taskId: "task-1",
        code: "read_failed",
        message: "Could not read the companion.",
      },
    ]);

    subscription.close();
    subscription.close();
    expect(subscription.sendEvent("session-1", "revision-1", choice)).toBe(false);
    const detachFrames = socket.sent
      .map((entry) => JSON.parse(entry))
      .filter((frame) => frame.type === "detach");
    expect(detachFrames).toEqual([
      {
        type: "detach",
        task_id: "task-1",
        kind: "companion",
        attachment_epoch: 1,
      },
    ]);
  });

  it("observes remote terminal output over the relay only after auth", async () => {
    const socket = new FakeSocket();
    const events: DesktopRelayTerminalEvent[] = [];
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const subscription = client.observeTerminal({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: (event) => events.push(event),
    });

    await openRelayTunnel(socket);
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "auth", id_token: "id-token" });
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: "tunnel_request",
      desktopId: "desktop-owner",
    });

    expect(JSON.parse(socket.sent[2])).toEqual({
      type: "auth",
      capabilities: ["companion_event_epoch", "term_input_boundary", "terminal_geometry"],
      credential: "id-token",
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["terminal_geometry"],
      }),
    });
    await Promise.resolve();
    expect(socket.sent).toHaveLength(3);
    subscription.registerViewer(80, 24);
    expect(JSON.parse(socket.sent[3])).toEqual({
      type: "term_viewer_register",
      task_id: "task-1",
      viewer_id: "terminal-viewer-1",
      role: "remote",
      generation: 1,
      cols: 80,
      rows: 24,
      visible: true,
    });
    expect(JSON.parse(socket.sent[4])).toEqual({
      type: "attach",
      task_id: "task-1",
      kind: "terminal",
      from_seq: 0,
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_snapshot",
        task_id: "task-1",
        cols: 80,
        rows: 24,
        data_b64: "",
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "aGVsbG8=",
      }),
    });
    // KSP frames are byte boundaries, not UTF-8 character boundaries. Keep
    // the split bytes intact so xterm's streaming decoder can join them.
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "5w==",
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "term_output",
        task_id: "task-1",
        data_b64: "lYw=",
      }),
    });

    expect(events).toEqual([
      {
        type: "snapshot",
        taskId: "task-1",
        cols: 80,
        rows: 24,
        data: new Uint8Array(),
      },
      {
        type: "output",
        taskId: "task-1",
        data: new TextEncoder().encode("hello"),
      },
      {
        type: "output",
        taskId: "task-1",
        data: new Uint8Array([0xe7]),
      },
      {
        type: "output",
        taskId: "task-1",
        data: new Uint8Array([0x95, 0x8c]),
      },
    ]);
  });

  it("sends unobserve when a terminal subscription closes", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const subscription = client.observeTerminal({
      desktopId: "desktop-owner",
      taskId: "task-1",
      listener: vi.fn(),
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["terminal_geometry"],
      }),
    });
    await Promise.resolve();

    subscription.close();
    await Promise.resolve();

    expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual(
      { type: "detach", task_id: "task-1", kind: "terminal" },
    );
  });

  it("sends terminal input through the relay", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const promise = client.sendInput({
      desktopId: "desktop-owner",
      taskId: "task-1",
      data: "hello\n",
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["term_input_boundary"],
      }),
    });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual({
      type: "term_input",
      task_id: "task-1",
      data_b64: "aGVsbG8K",
    });

    await expect(promise).resolves.toBeUndefined();
  });

  it("sends terminal resize, close task, advance stage, and mark read through the relay", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const resizePromise = client.resize({
      desktopId: "desktop-owner",
      taskId: "task-1",
      cols: 100,
      rows: 32,
    });
    const closePromise = client.closeTask({
      desktopId: "desktop-owner",
      taskId: "task-1",
    });
    const advancePromise = client.advanceStage({
      desktopId: "desktop-owner",
      taskId: "task-1",
      expectedTransitionRevision: "run-1",
    });
    const markReadPromise = client.markTaskRead({
      desktopId: "desktop-owner",
      taskId: "task/read",
      expectedActivityRevision: 7,
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "auth_ok",
        capabilities: ["terminal_geometry"],
      }),
    });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual({
      type: "term_viewer_register",
      task_id: "task-1",
      viewer_id: "terminal-viewer-1",
      role: "remote",
      generation: 1,
      cols: 100,
      rows: 32,
      visible: true,
    });
    const closeRequest = sent.find((entry) => entry.path === "/v1/tasks/task-1/actions/close");
    const advanceRequest = sent.find((entry) => entry.path === "/v1/tasks/task-1/actions/advance-stage");
    const markReadRequest = sent.find((entry) => entry.path === "/v1/tasks/task%2Fread/actions/mark-read");
    expect(closeRequest).toMatchObject({ type: "request", method: "POST", body: null });
    expect(advanceRequest).toMatchObject({
      type: "request",
      method: "POST",
      body: { source: "operator", expectedTransitionRevision: "run-1" },
    });
    expect(markReadRequest).toMatchObject({
      type: "request",
      method: "POST",
      body: { expectedActivityRevision: 7 },
    });

    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: closeRequest.id, status: 200, body: null }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: advanceRequest.id, status: 200, body: null }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: markReadRequest.id, status: 200, body: null }) });

    await expect(resizePromise).resolves.toBeUndefined();
    await expect(closePromise).resolves.toBeUndefined();
    await expect(advancePromise).resolves.toBeUndefined();
    await expect(markReadPromise).resolves.toBeUndefined();
  });

  it("reads a remote task file through the relay tunnel", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const readPromise = client.readTaskFile({
      desktopId: "desktop-owner",
      taskId: "task-1",
      path: "src dir/app.ts",
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    const readRequest = sent.find(
      (entry) => entry.path === "/v1/tasks/task-1/files/content?path=src%20dir%2Fapp.ts",
    );
    expect(readRequest).toMatchObject({ type: "request", method: "GET", body: null });

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: readRequest.id,
        status: 200,
        body: { path: "src dir/app.ts", content: "remote body" },
      }),
    });

    await expect(readPromise).resolves.toEqual({ path: "src dir/app.ts", content: "remote body" });
  });

  it("rejects a remote task file read that fails or returns a malformed body", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const missingPromise = client.readTaskFile({
      desktopId: "desktop-owner",
      taskId: "task-1",
      path: "missing.ts",
    });
    const malformedPromise = client.readTaskFile({
      desktopId: "desktop-owner",
      taskId: "task-1",
      path: "src/app.ts",
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    const missingRequest = sent.find(
      (entry) => entry.path === "/v1/tasks/task-1/files/content?path=missing.ts",
    );
    const malformedRequest = sent.find(
      (entry) => entry.path === "/v1/tasks/task-1/files/content?path=src%2Fapp.ts",
    );

    socket.onmessage?.({
      data: JSON.stringify({ type: "response", id: missingRequest.id, status: 404, body: { error: "file not found" } }),
    });
    socket.onmessage?.({
      data: JSON.stringify({ type: "response", id: malformedRequest.id, status: 200, body: { path: "src/app.ts" } }),
    });

    await expect(missingPromise).rejects.toThrow("Remote task file read failed with HTTP 404.");
    await expect(malformedPromise).rejects.toThrow("Remote task file response was malformed.");
  });

  it("reads a paginated task directory and scoped diff from the owning desktop", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    const directoryPromise = client.listTaskDirectory({
      desktopId: "desktop-owner",
      taskId: "owner-task",
      path: "src dir",
      showAllFiles: true,
    });
    const diffPromise = client.readTaskDiff({
      desktopId: "desktop-owner",
      taskId: "owner-task",
      request: { scope: "working", mode: "staged" },
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await vi.waitFor(() => {
      expect(socket.sent.some((entry) => entry.includes("/browse?"))).toBe(true);
      expect(socket.sent.some((entry) => entry.includes("/diff?"))).toBe(true);
    });

    const firstRequests = socket.sent.map((entry) => JSON.parse(entry));
    const firstDirectory = firstRequests.find(
      (entry) => entry.path === "/v1/tasks/owner-task/browse?path=src%20dir&showAllFiles=true&offset=0&limit=100",
    );
    const diff = firstRequests.find(
      (entry) => entry.path === "/v1/tasks/owner-task/diff?scope=working&mode=staged",
    );
    expect(firstDirectory).toMatchObject({ type: "request", method: "GET", body: null });
    expect(diff).toMatchObject({ type: "request", method: "GET", body: null });

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: firstDirectory.id,
        status: 200,
        body: {
          path: "src dir",
          entries: [{ name: "a.ts", path: "src dir/a.ts", isDir: false, size: 12 }],
          offset: 0,
          nextOffset: 1,
          totalEntries: 2,
        },
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: diff.id,
        status: 200,
        body: {
          taskId: "owner-task",
          baseRef: null,
          mergeBase: null,
          patch: "remote patch",
          truncated: false,
        },
      }),
    });

    await vi.waitFor(() => {
      expect(socket.sent.some((entry) => entry.includes("offset=1"))).toBe(true);
    });
    const secondDirectory = socket.sent
      .map((entry) => JSON.parse(entry))
      .find((entry) => entry.path?.includes("offset=1"));
    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: secondDirectory.id,
        status: 200,
        body: {
          path: "src dir",
          entries: [{ name: "nested", path: "src dir/nested", isDir: true, size: null }],
          offset: 1,
          nextOffset: null,
          totalEntries: 2,
        },
      }),
    });

    await expect(directoryPromise).resolves.toMatchObject({
      path: "src dir",
      entries: [
        { name: "a.ts", path: "src dir/a.ts", isDir: false, size: 12 },
        { name: "nested", path: "src dir/nested", isDir: true, size: null },
      ],
      nextOffset: null,
      totalEntries: 2,
    });
    await expect(diffPromise).resolves.toMatchObject({ taskId: "owner-task", patch: "remote patch" });
  });

  it("rejects a blocked owner response with its message", async () => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });
    const advancePromise = client.advanceStage({
      desktopId: "desktop-owner",
      taskId: "task-blocked",
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();
    const request = socket.sent
      .map((entry) => JSON.parse(entry))
      .find((entry) =>
        entry.path === "/v1/tasks/task-blocked/actions/advance-stage"
      );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: request.id,
        status: 409,
        body: { error: "task is blocked: task-blocked" },
      }),
    });

    await expect(advancePromise).rejects.toThrow("task is blocked: task-blocked");
  });

  it.each([
    {
      status: 404,
      body: { error: "task not found" },
      expected: "task not found",
    },
    {
      status: 409,
      body: { message: "activity revision changed" },
      expected: "activity revision changed",
    },
    {
      status: 500,
      body: null,
      expected: "Remote mark read failed with HTTP 500",
    },
  ])("rejects mark-read HTTP $status responses", async ({ status, body, expected }) => {
    const socket = new FakeSocket();
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });
    const markReadPromise = client.markTaskRead({
      desktopId: "desktop-owner",
      taskId: "task-unread",
      expectedActivityRevision: 7,
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();
    const request = socket.sent
      .map((entry) => JSON.parse(entry))
      .find((entry) =>
        entry.path === "/v1/tasks/task-unread/actions/mark-read"
      );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "response",
        id: request.id,
        status,
        body,
      }),
    });

    await expect(markReadPromise).rejects.toThrow(expected);
  });

  it.each([409, 503])(
    "rejects a remote close when the owner returns status %s",
    async (status) => {
      const socket = new FakeSocket();
      const client = createDesktopRelayTerminalClient({
        createSocket: () => socket,
        getIdToken: vi.fn(async () => "id-token"),
        relayUrl: "ws://relay.test",
      });

      const closePromise = client.closeTask({
        desktopId: "desktop-owner",
        taskId: "task-1",
      });

      await openRelayTunnel(socket);
      socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
      await Promise.resolve();

      const request = socket.sent
        .map((entry) => JSON.parse(entry))
        .find((entry) => entry.path === "/v1/tasks/task-1/actions/close");
      expect(request).toMatchObject({ type: "request", method: "POST" });
      socket.onmessage?.({
        data: JSON.stringify({
          type: "response",
          id: request.id,
          status,
          body: { error: "Task is already closed." },
        }),
      });

      await expect(closePromise).rejects.toThrow("Task is already closed.");
    },
  );

  it.each([409, 503])(
    "rejects a remote stage advance when the owner returns status %s",
    async (status) => {
      const socket = new FakeSocket();
      const client = createDesktopRelayTerminalClient({
        createSocket: () => socket,
        getIdToken: vi.fn(async () => "id-token"),
        relayUrl: "ws://relay.test",
      });

      const advancePromise = client.advanceStage({
        desktopId: "desktop-owner",
        taskId: "task-1",
      });

      await openRelayTunnel(socket);
      socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
      await Promise.resolve();

      const request = socket.sent
        .map((entry) => JSON.parse(entry))
        .find((entry) => entry.path === "/v1/tasks/task-1/actions/advance-stage");
      expect(request).toMatchObject({ type: "request", method: "POST" });
      socket.onmessage?.({
        data: JSON.stringify({
          type: "response",
          id: request.id,
          status,
          body: { error: "Owner is unavailable." },
        }),
      });

      await expect(advancePromise).rejects.toThrow("Owner is unavailable.");
    },
  );
});

describe("resolveDesktopCloudTransportUrlFromEnv", () => {
  it("uses explicit URL and local port overrides before defaults", () => {
    expect(resolveDesktopCloudTransportUrlFromEnv({
      KANNA_RELAY_URL: " wss://cloud.example ",
      KANNA_RELAY_PORT: "19083",
    }, { dev: false })).toBe("wss://cloud.example");

    expect(resolveDesktopCloudTransportUrlFromEnv({
      KANNA_RELAY_PORT: "19083",
    }, { dev: false })).toBe("ws://127.0.0.1:19083");
  });

  it("uses the production cloud transport default only outside dev builds", () => {
    expect(resolveDesktopCloudTransportUrlFromEnv({}, { dev: false })).toBe(PRODUCTION_CLOUD_TRANSPORT_URL);
    expect(resolveDesktopCloudTransportUrlFromEnv({}, { dev: true })).toBeNull();
  });

  it("uses the staging cloud transport default when the desktop cloud env is staging", () => {
    expect(resolveDesktopCloudTransportUrlFromEnv({
      KANNA_CLOUD_ENV: " staging ",
    }, { dev: false })).toBe(STAGING_CLOUD_TRANSPORT_URL);
  });
});
