import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type ClientOptions } from "ws";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  routeMessage,
  setPhoneConnection,
  setServerConnection,
} from "../src/router.js";
import {
  byteAccountFor,
  openByteAccount,
  resetByteAccountingForTests,
} from "../src/byteAccounting.js";
import { RELAY_PER_MESSAGE_DEFLATE } from "../src/webSocketCompression.js";

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

/**
 * Start a server configured exactly the way `index.ts` configures the relay's,
 * so these tests exercise the shipped compression bounds rather than a copy.
 */
async function startRelayWebSocketServer(): Promise<string> {
  const port = await freePort();
  server = new WebSocketServer({
    port,
    host: "127.0.0.1",
    perMessageDeflate: RELAY_PER_MESSAGE_DEFLATE,
  });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `ws://127.0.0.1:${port}`;
}

interface ConnectedPair {
  client: WebSocket;
  server: WebSocket;
  /** The `Sec-WebSocket-Extensions` the relay answered the upgrade with. */
  negotiatedExtensions: string;
}

async function connect(url: string, options?: ClientOptions): Promise<ConnectedPair> {
  const accepted = new Promise<WebSocket>((resolve) => server!.once("connection", resolve));
  const client = new WebSocket(url, options);
  let negotiatedExtensions = "";
  client.once("upgrade", (response) => {
    negotiatedExtensions = response.headers["sec-websocket-extensions"] ?? "";
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const serverSocket = await accepted;
  openByteAccount(serverSocket);
  sockets.push(client, serverSocket);
  return { client, server: serverSocket, negotiatedExtensions };
}

/**
 * Bytes actually read off the TCP socket. The byte odometer deliberately
 * measures *application* bytes on both sides, so it cannot see compression;
 * the only place the win is visible is the wire.
 */
interface SocketBearingWebSocket {
  _socket?: { bytesRead: number };
}

function wireBytesRead(ws: WebSocket): number {
  const socket = (ws as unknown as SocketBearingWebSocket)._socket;
  if (!socket) throw new Error("websocket has no underlying socket");
  return socket.bytesRead;
}

/**
 * A terminal frame shaped like the ones the relay actually carries:
 * base64 PTY output wrapped in JSON, repetitive because TUI redraws are.
 */
function terminalFrame(targetRawBytes: number): string {
  const line = "[2K[32m✓[0m services/relay/test/router.test.ts (12 tests) 41ms\r\n";
  let raw = "";
  while (Buffer.byteLength(raw) < targetRawBytes) raw += line;
  return JSON.stringify({
    type: "event",
    payload: {
      session_id: "compression-session",
      type: "terminal_output",
      data: Buffer.from(raw, "utf8").toString("base64"),
    },
  });
}

/**
 * Splice a phone socket to a desktop tunnel socket through the real router,
 * then return both ends wired to `forwardTunnelData` — the relay's hot path.
 */
async function establishKspTunnel(
  url: string,
  userId: string,
  phoneOptions?: ClientOptions,
): Promise<{ phone: ConnectedPair; desktopTunnel: ConnectedPair }> {
  const desktopControl = await connect(url, { perMessageDeflate: false });
  setServerConnection(userId, "desktop", desktopControl.server);
  const phone = await connect(url, phoneOptions);
  setPhoneConnection(userId, phone.server);

  const establish = new Promise<Record<string, unknown>>((resolve) => {
    desktopControl.client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  routeMessage(
    userId,
    "phone",
    JSON.stringify({
      type: "tunnel_request",
      id: "compression",
      desktopId: "desktop",
      service: "ksp",
    }),
    phone.server,
  );
  const signal = await establish;

  // The desktop opens its tunnel socket with a client that has no
  // `permessage-deflate` implementation, exactly like tokio-tungstenite.
  const desktopTunnel = await connect(url, { perMessageDeflate: false });
  // Both ends are told the tunnel is ready before any payload flows; drain
  // those frames so the tests below read the spliced payload itself.
  const ready = Promise.all([nextMessage(phone.client), nextMessage(desktopTunnel.client)]);
  expect(attachDesktopTunnel(
    userId,
    "desktop",
    String(signal.tunnelId),
    desktopTunnel.server,
  )).toBe(true);
  for (const frame of await ready) {
    expect(JSON.parse(frame)).toMatchObject({ type: "tunnel_ready" });
  }

  phone.server.on("message", (data, isBinary) => {
    forwardTunnelData(phone.server, data, isBinary);
  });
  desktopTunnel.server.on("message", (data, isBinary) => {
    forwardTunnelData(desktopTunnel.server, data, isBinary);
  });

  return { phone, desktopTunnel };
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (raw: Buffer) => resolve(raw.toString()));
  });
}

beforeEach(() => {
  resetByteAccountingForTests();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
  resetByteAccountingForTests();
});

describe("relay WebSocket compression", () => {
  it("negotiates permessage-deflate with the bounded server window", async () => {
    const url = await startRelayWebSocketServer();
    const phone = await connect(url);

    expect(phone.negotiatedExtensions).toContain("permessage-deflate");
    expect(phone.negotiatedExtensions).toContain("server_max_window_bits=13");
    expect(phone.client.extensions).toContain("permessage-deflate");
  });

  it("leaves a client that offers no extensions uncompressed and connected", async () => {
    const url = await startRelayWebSocketServer();
    const desktop = await connect(url, { perMessageDeflate: false });

    expect(desktop.negotiatedExtensions).toBe("");
    expect(desktop.client.extensions).toBe("");
    expect(desktop.client.readyState).toBe(WebSocket.OPEN);
  });

  it("compresses a spliced terminal frame on the wire and delivers it intact", async () => {
    const url = await startRelayWebSocketServer();
    const { phone, desktopTunnel } = await establishKspTunnel(url, "compressing-user");
    expect(phone.client.extensions).toContain("permessage-deflate");

    const frame = terminalFrame(256 * 1024);
    const frameBytes = Buffer.byteLength(frame);
    const before = wireBytesRead(phone.client);
    const delivered = nextMessage(phone.client);
    desktopTunnel.client.send(frame);

    expect(await delivered).toBe(frame);
    const wireBytes = wireBytesRead(phone.client) - before;
    expect(wireBytes).toBeGreaterThan(0);
    expect(wireBytes).toBeLessThan(frameBytes / 5);
  }, 15_000);

  it("delivers the same frame intact and uncompressed to a non-negotiating client", async () => {
    const url = await startRelayWebSocketServer();
    const { phone, desktopTunnel } = await establishKspTunnel(
      url,
      "plain-user",
      { perMessageDeflate: false },
    );
    expect(phone.client.extensions).toBe("");

    const frame = terminalFrame(256 * 1024);
    const frameBytes = Buffer.byteLength(frame);
    const before = wireBytesRead(phone.client);
    const delivered = nextMessage(phone.client);
    desktopTunnel.client.send(frame);

    expect(await delivered).toBe(frame);
    expect(wireBytesRead(phone.client) - before).toBeGreaterThanOrEqual(frameBytes);
  }, 15_000);

  it("keeps the byte odometer counting application bytes, not wire bytes", async () => {
    const url = await startRelayWebSocketServer();
    const { phone, desktopTunnel } = await establishKspTunnel(url, "odometer-user");

    const frame = terminalFrame(256 * 1024);
    const frameBytes = Buffer.byteLength(frame);
    const before = wireBytesRead(phone.client);
    const delivered = nextMessage(phone.client);
    desktopTunnel.client.send(frame);
    await delivered;

    // Received on the desktop end, forwarded out the phone end: both sides
    // measure the payload the relay handled, so compression never distorts
    // per-user metering.
    expect(byteAccountFor(desktopTunnel.server)?.received.tunnel).toBe(frameBytes);
    expect(byteAccountFor(phone.server)?.sent.tunnel).toBe(frameBytes);
    expect(wireBytesRead(phone.client) - before).toBeLessThan(frameBytes);
  }, 15_000);
});
