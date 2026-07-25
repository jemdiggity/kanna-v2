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
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();

    expect(webSocketMock).toHaveBeenCalledWith(PRODUCTION_CLOUD_TRANSPORT_URL);
    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual({ type: "auth", id_token: "id-token" });
    expect(sent).toContainEqual(expect.objectContaining({
      type: "tunnel_request",
      desktopId: "desktop-owner",
    }));
    expect(sent).toContainEqual({ type: "auth", credential: "id-token" });
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
  it("observes remote terminal output over the relay only after auth", async () => {
    const socket = new FakeSocket();
    const events: DesktopRelayTerminalEvent[] = [];
    const client = createDesktopRelayTerminalClient({
      createSocket: () => socket,
      getIdToken: vi.fn(async () => "id-token"),
      relayUrl: "ws://relay.test",
    });

    client.observeTerminal({
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

    expect(JSON.parse(socket.sent[2])).toEqual({ type: "auth", credential: "id-token" });
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[3])).toEqual({
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

    expect(events).toEqual([
      { type: "output", taskId: "task-1", text: "" },
      { type: "ready", taskId: "task-1" },
      { type: "output", taskId: "task-1", text: "hello" },
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
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
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
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
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
    });
    const markReadPromise = client.markTaskRead({
      desktopId: "desktop-owner",
      taskId: "task/read",
    });

    await openRelayTunnel(socket);
    socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
    await Promise.resolve();

    const sent = socket.sent.map((entry) => JSON.parse(entry));
    expect(sent).toContainEqual({
      type: "term_resize",
      task_id: "task-1",
      cols: 100,
      rows: 32,
    });
    const closeRequest = sent.find((entry) => entry.path === "/v1/tasks/task-1/actions/close");
    const advanceRequest = sent.find((entry) => entry.path === "/v1/tasks/task-1/actions/advance-stage");
    const markReadRequest = sent.find((entry) => entry.path === "/v1/tasks/task%2Fread/actions/mark-read");
    expect(closeRequest).toMatchObject({ type: "request", method: "POST", body: null });
    expect(advanceRequest).toMatchObject({ type: "request", method: "POST", body: null });
    expect(markReadRequest).toMatchObject({ type: "request", method: "POST", body: null });

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
