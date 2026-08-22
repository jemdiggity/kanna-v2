import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  byteAccountFor,
  closeByteAccount,
  emitByteRollups,
  getByteStats,
  identifyByteAccount,
  openByteAccount,
  rawDataByteLength,
  recordBytesReceived,
  relayMessageByteClass,
  resetByteAccountingForTests,
  resolveByteRollupIntervalMs,
  DEFAULT_BYTE_ROLLUP_INTERVAL_MS,
  startByteRollups,
  statsBearerToken,
  stopByteRollups,
} from "../src/byteAccounting.js";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  pendingResponseClassCountForTests,
  pendingResponseCountForTests,
  routeMessage,
  routedMessageByteClass,
  setPhoneConnection,
  setServerConnection,
} from "../src/router.js";

const sockets: WebSocket[] = [];
let server: WebSocketServer | null = null;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing probe address"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startServer(): Promise<string> {
  const port = await freePort();
  server = new WebSocketServer({ port, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `ws://127.0.0.1:${port}`;
}

/**
 * Open a real socket pair and give the relay-side socket an odometer, exactly
 * as `wss.on("connection")` does.
 */
async function connect(url: string): Promise<{ client: WebSocket; server: WebSocket }> {
  const accepted = new Promise<WebSocket>((resolve) => server!.once("connection", resolve));
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const serverSocket = await accepted;
  openByteAccount(serverSocket);
  sockets.push(client, serverSocket);
  return { client, server: serverSocket };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

function loggedByteEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => (typeof line === "string" ? line : ""))
    .filter((line) => line.startsWith("[bytes] "))
    .map((line) => JSON.parse(line.slice("[bytes] ".length)) as Record<string, unknown>);
}

beforeEach(() => {
  resetByteAccountingForTests();
});

afterEach(async () => {
  stopByteRollups();
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("byte classification", () => {
  it("classifies a session-scoped event as terminal traffic", () => {
    expect(relayMessageByteClass({
      type: "event",
      payload: { session_id: "sess-1", type: "terminal_output", data: "abc" },
    })).toBe("terminalEvent");
  });

  it("classifies repository browse invokes separately", () => {
    expect(relayMessageByteClass({ type: "invoke", path: "/v1/tasks/task-1/browse/content?path=README.md" })).toBe("fileBrowse");
  });

  it("classifies events without a session id, invokes, and unparsed frames as control", () => {
    expect(relayMessageByteClass({ type: "event", payload: { type: "task_updated" } }))
      .toBe("control");
    expect(relayMessageByteClass({ type: "event", payload: { session_id: "" } }))
      .toBe("control");
    expect(relayMessageByteClass({ type: "event", payload: ["not", "an", "object"] }))
      .toBe("control");
    expect(relayMessageByteClass({ type: "invoke", id: "1" })).toBe("control");
    expect(relayMessageByteClass(null)).toBe("control");
  });

  it("measures string, buffer, fragment, and array-buffer frames without copying", () => {
    expect(rawDataByteLength("héllo")).toBe(6);
    expect(rawDataByteLength(Buffer.alloc(1024))).toBe(1024);
    expect(rawDataByteLength([Buffer.alloc(10), Buffer.alloc(22)])).toBe(32);
    expect(rawDataByteLength(new ArrayBuffer(64))).toBe(64);
  });
});

describe("per-connection attribution", () => {
  it("attributes tunnel bytes to the uid and desktop on both sides of the splice", async () => {
    const url = await startServer();
    const desktopControl = await connect(url);
    const phone = await connect(url);
    const desktopTunnel = await connect(url);

    setServerConnection("uid-tunnel", "desktop-a", desktopControl.server);
    setPhoneConnection("uid-tunnel", phone.server);
    identifyByteAccount(desktopControl.server, {
      uid: "uid-tunnel",
      desktopId: "desktop-a",
      role: "server",
    });
    identifyByteAccount(phone.server, { uid: "uid-tunnel", role: "phone" });

    const establish = new Promise<Record<string, unknown>>((resolve) => {
      desktopControl.client.once("message", (raw: Buffer) =>
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    });
    const request = JSON.stringify({
      type: "tunnel_request",
      id: "open-1",
      desktopId: "desktop-a",
    });
    routeMessage(
      "uid-tunnel",
      "phone",
      request,
      phone.server,
      null,
      null,
      Buffer.byteLength(request),
    );
    const signal = await establish;
    expect(attachDesktopTunnel(
      "uid-tunnel",
      "desktop-a",
      String(signal.tunnelId),
      desktopTunnel.server,
    )).toBe(true);

    const payload = Buffer.alloc(48 * 1024, 7);
    forwardTunnelData(desktopTunnel.server, payload, true);
    forwardTunnelData(phone.server, Buffer.alloc(1_024, 3), true);

    const desktopAccount = byteAccountFor(desktopTunnel.server);
    const phoneAccount = byteAccountFor(phone.server);
    expect(desktopAccount).toMatchObject({ uid: "uid-tunnel", desktopId: "desktop-a" });
    expect(desktopAccount?.received.tunnel).toBe(48 * 1024);
    expect(desktopAccount?.sent.tunnel).toBe(1_024);
    // The phone socket keeps its uid and gains the desktop it tunnels to.
    expect(phoneAccount).toMatchObject({
      uid: "uid-tunnel",
      desktopId: "desktop-a",
      role: "phone",
      tunnelService: "ksp",
    });
    expect(phoneAccount?.received.tunnel).toBe(1_024);
    expect(phoneAccount?.sent.tunnel).toBe(48 * 1024);
    // Control bytes stay out of the tunnel column on both sides.
    expect(phoneAccount?.received.control).toBe(0);
    expect(desktopControl.server && byteAccountFor(desktopControl.server)?.sent.control)
      .toBeGreaterThan(0);
    expect(byteAccountFor(desktopControl.server)?.sent.tunnel).toBe(0);
  });

  it("bills task-transfer tunnel frames to their own class", async () => {
    const url = await startServer();
    const desktopControl = await connect(url);
    const phone = await connect(url);
    const desktopTunnel = await connect(url);

    setServerConnection("uid-transfer", "desktop-b", desktopControl.server);
    setPhoneConnection("uid-transfer", phone.server);

    const establish = new Promise<Record<string, unknown>>((resolve) => {
      desktopControl.client.once("message", (raw: Buffer) =>
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    });
    routeMessage(
      "uid-transfer",
      "phone",
      JSON.stringify({
        type: "tunnel_request",
        id: "open-transfer",
        desktopId: "desktop-b",
        service: "task-transfer",
      }),
      phone.server,
    );
    const signal = await establish;
    attachDesktopTunnel(
      "uid-transfer",
      "desktop-b",
      String(signal.tunnelId),
      desktopTunnel.server,
    );

    forwardTunnelData(desktopTunnel.server, Buffer.alloc(4_096, 1), true);

    expect(byteAccountFor(desktopTunnel.server)?.received).toMatchObject({
      taskTransfer: 4_096,
      tunnel: 0,
      terminalEvent: 0,
    });
    expect(byteAccountFor(phone.server)?.sent).toMatchObject({
      taskTransfer: 4_096,
      tunnel: 0,
    });
  });

  it("splits routed terminal events from control messages on both sockets", async () => {
    const url = await startServer();
    const desktop = await connect(url);
    const phone = await connect(url);

    setServerConnection("uid-observe", "desktop-c", desktop.server);
    setPhoneConnection("uid-observe", phone.server);
    identifyByteAccount(desktop.server, {
      uid: "uid-observe",
      desktopId: "desktop-c",
      role: "server",
    });
    identifyByteAccount(phone.server, { uid: "uid-observe", role: "phone" });

    const observe = JSON.stringify({
      type: "invoke",
      id: "observe-1",
      desktopId: "desktop-c",
      command: "observe_session",
      args: { session_id: "sess-1" },
    });
    const observeBytes = Buffer.byteLength(observe);
    recordBytesReceived(phone.server, "control", observeBytes);
    routeMessage("uid-observe", "phone", observe, phone.server, null, null, observeBytes);

    const terminalFrame = JSON.stringify({
      type: "event",
      payload: {
        session_id: "sess-1",
        type: "terminal_output",
        data: "x".repeat(20_000),
      },
    });
    const terminalBytes = Buffer.byteLength(terminalFrame);
    recordBytesReceived(desktop.server, relayMessageByteClass(JSON.parse(terminalFrame)), terminalBytes);
    routeMessage(
      "uid-observe",
      "server",
      terminalFrame,
      desktop.server,
      "desktop-c",
      null,
      terminalBytes,
    );

    const desktopAccount = byteAccountFor(desktop.server);
    const phoneAccount = byteAccountFor(phone.server);
    expect(desktopAccount?.received.terminalEvent).toBe(terminalBytes);
    expect(desktopAccount?.received.control).toBe(0);
    expect(desktopAccount?.sent.control).toBe(observeBytes);
    expect(phoneAccount?.received.control).toBe(observeBytes);
    expect(phoneAccount?.sent.terminalEvent).toBe(terminalBytes);
    expect(phoneAccount?.sent.control).toBe(0);
  });

  it("counts a relay-generated error response against the caller", async () => {
    const url = await startServer();
    const phone = await connect(url);
    setPhoneConnection("uid-offline", phone.server);

    routeMessage(
      "uid-offline",
      "phone",
      JSON.stringify({ type: "invoke", id: "1", command: "list_tasks" }),
      phone.server,
    );

    const account = byteAccountFor(phone.server);
    expect(account?.sent.control).toBeGreaterThan(0);
    expect(account?.sent.tunnel).toBe(0);
  });

  it("charges routed browse invokes and correlated responses to fileBrowse", async () => {
    const url = await startServer();
    const desktop = await connect(url);
    const phone = await connect(url);
    setServerConnection("uid-browse", "desktop-browse", desktop.server);
    setPhoneConnection("uid-browse", phone.server);

    const invoke = JSON.stringify({
      type: "invoke",
      id: "browse-1",
      desktopId: "desktop-browse",
      path: "/v1/tasks/task-1/browse/content?path=README.md",
    });
    const invokeClass = relayMessageByteClass(JSON.parse(invoke));
    recordBytesReceived(phone.server, invokeClass, Buffer.byteLength(invoke));
    routeMessage("uid-browse", "phone", invoke, phone.server, null, null, Buffer.byteLength(invoke));
    await waitUntil(() => byteAccountFor(desktop.server)?.sent.fileBrowse === Buffer.byteLength(invoke));
    expect(pendingResponseCountForTests("uid-browse")).toBe(1);
    expect(pendingResponseClassCountForTests("uid-browse")).toBe(1);

    const response = JSON.stringify({ type: "response", id: "browse-1", data: { lines: ["hello"] } });
    const responseClass = routedMessageByteClass("uid-browse", JSON.parse(response));
    recordBytesReceived(desktop.server, responseClass, Buffer.byteLength(response));
    routeMessage("uid-browse", "server", response, desktop.server, "desktop-browse", null, Buffer.byteLength(response));
    await waitUntil(() => byteAccountFor(phone.server)?.sent.fileBrowse === Buffer.byteLength(response));

    expect(byteAccountFor(phone.server)?.received).toMatchObject({ fileBrowse: Buffer.byteLength(invoke), control: 0 });
    expect(byteAccountFor(desktop.server)?.sent).toMatchObject({ fileBrowse: Buffer.byteLength(invoke), control: 0 });
    expect(byteAccountFor(desktop.server)?.received).toMatchObject({ fileBrowse: Buffer.byteLength(response), control: 0 });
    expect(byteAccountFor(phone.server)?.sent).toMatchObject({ fileBrowse: Buffer.byteLength(response), control: 0 });
    expect(pendingResponseCountForTests("uid-browse")).toBe(0);
    expect(pendingResponseClassCountForTests("uid-browse")).toBe(0);
  });
});

describe("odometer reporting", () => {
  it("logs a close rollup with identity, duration, and per-class totals", async () => {
    const url = await startServer();
    const desktop = await connect(url);
    identifyByteAccount(desktop.server, {
      uid: "uid-log",
      desktopId: "desktop-log",
      role: "server",
    });
    recordBytesReceived(desktop.server, "tunnel", 2_048);
    recordBytesReceived(desktop.server, "control", 64);

    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    closeByteAccount(desktop.server);
    const events = loggedByteEvents(logged);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "connection_close",
      uid: "uid-log",
      desktopId: "desktop-log",
      role: "server",
      received: { tunnel: 2_048, control: 64, taskTransfer: 0, terminalEvent: 0 },
      receivedTotal: 2_112,
      sentTotal: 0,
      totalBytes: 2_112,
    });
    expect(events[0].durationMs).toEqual(expect.any(Number));

    // Idempotent: a second close emits nothing.
    closeByteAccount(desktop.server);
    expect(loggedByteEvents(logged)).toHaveLength(1);
  });

  it("rolls up still-open connections on the periodic timer", async () => {
    const url = await startServer();
    const phone = await connect(url);
    identifyByteAccount(phone.server, { uid: "uid-rollup", role: "phone" });
    recordBytesReceived(phone.server, "terminalEvent", 512);

    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    emitByteRollups();
    expect(loggedByteEvents(logged)).toMatchObject([{
      event: "connection_rollup",
      uid: "uid-rollup",
      received: { terminalEvent: 512 },
    }]);

    startByteRollups(1_000);
    await waitUntil(() => loggedByteEvents(logged).length >= 2, 5_000);
    stopByteRollups();

    // A closed connection stops rolling up.
    closeByteAccount(phone.server);
    const afterClose = loggedByteEvents(logged).length;
    emitByteRollups();
    expect(loggedByteEvents(logged)).toHaveLength(afterClose);
  });

  it("aggregates process totals without naming any account", async () => {
    const url = await startServer();
    const phone = await connect(url);
    const desktop = await connect(url);
    identifyByteAccount(phone.server, { uid: "uid-stats", role: "phone" });
    recordBytesReceived(phone.server, "tunnel", 1_000);
    recordBytesReceived(desktop.server, "control", 25);

    const stats = getByteStats();
    expect(stats.received).toMatchObject({
      tunnel: 1_000,
      control: 25,
      taskTransfer: 0,
      terminalEvent: 0,
      total: 1_025,
    });
    expect(stats.connections).toMatchObject({ open: 2, opened: 2, closed: 0 });
    expect(stats.totalBytes).toBe(1_025);
    expect(JSON.stringify(stats)).not.toContain("uid-stats");

    vi.spyOn(console, "log").mockImplementation(() => {});
    closeByteAccount(phone.server);
    expect(getByteStats().connections).toMatchObject({ open: 1, opened: 2, closed: 1 });
    // A closed connection's bytes stay in the process totals.
    expect(getByteStats().received.total).toBe(1_025);
  });

  it("reads the rollup interval from the environment and rejects nonsense", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveByteRollupIntervalMs({})).toBe(DEFAULT_BYTE_ROLLUP_INTERVAL_MS);
    expect(resolveByteRollupIntervalMs({ KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS: "60000" }))
      .toBe(60_000);
    expect(resolveByteRollupIntervalMs({ KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS: "10" }))
      .toBe(DEFAULT_BYTE_ROLLUP_INTERVAL_MS);
    expect(resolveByteRollupIntervalMs({ KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS: "soon" }))
      .toBe(DEFAULT_BYTE_ROLLUP_INTERVAL_MS);
  });

  it("accepts only a bearer credential for the stats endpoint", () => {
    expect(statsBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(statsBearerToken("bearer   abc")).toBe("abc");
    expect(statsBearerToken("Basic abc")).toBeNull();
    expect(statsBearerToken("Bearer")).toBeNull();
    expect(statsBearerToken(undefined)).toBeNull();
  });
});
