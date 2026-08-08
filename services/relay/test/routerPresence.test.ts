import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  hasConnectionPairForTests,
  routeMessage,
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

async function connect(url: string): Promise<{ client: WebSocket; server: WebSocket }> {
  const accepted = new Promise<WebSocket>((resolve) => server!.once("connection", resolve));
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const serverSocket = await accepted;
  sockets.push(client, serverSocket);
  return { client, server: serverSocket };
}

async function disconnect(peer: { client: WebSocket; server: WebSocket }): Promise<void> {
  const closed = new Promise<void>((resolve) => peer.server.once("close", resolve));
  peer.client.close();
  await closed;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

async function listActiveDesktops(
  userId: string,
  phone: { client: WebSocket; server: WebSocket },
): Promise<string[]> {
  const response = nextMessage(phone.client);
  routeMessage(
    userId,
    "phone",
    JSON.stringify({ type: "invoke", id: "presence", command: "list_active_desktops" }),
    phone.server,
  );
  const data = (await response).data as { desktopIds?: unknown };
  return [...(data.desktopIds as string[])].sort();
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("connection pair lifetime", () => {
  it("keeps the other desktops online when one disconnects with no phone attached", async () => {
    const url = await startServer();
    const userId = "multi-desktop-user";
    const macbook = await connect(url);
    const studio = await connect(url);
    const imac = await connect(url);
    setServerConnection(userId, "desktop-macbook", macbook.server);
    setServerConnection(userId, "desktop-studio", studio.server);
    setServerConnection(userId, "desktop-imac", imac.server);

    // The phone is away — exactly the state the desktops sit in most of the day.
    await disconnect(macbook);

    const phone = await connect(url);
    setPhoneConnection(userId, phone.server);
    expect(await listActiveDesktops(userId, phone)).toEqual([
      "desktop-imac",
      "desktop-studio",
    ]);
  });

  it("keeps a remaining phone client routable when another disconnects with no desktop attached", async () => {
    const url = await startServer();
    const userId = "multi-phone-user";
    const first = await connect(url);
    const second = await connect(url);
    setPhoneConnection(userId, first.server);
    setPhoneConnection(userId, second.server);

    await disconnect(first);

    const desktop = await connect(url);
    setServerConnection(userId, "desktop-macbook", desktop.server);
    const delivered = nextMessage(second.client);
    routeMessage(
      userId,
      "server",
      JSON.stringify({ type: "event", name: "task_changed" }),
      desktop.server,
      "desktop-macbook",
    );
    expect((await delivered).name).toBe("task_changed");
  });

  it("still forgets the user once both sides have disconnected", async () => {
    const url = await startServer();
    const userId = "drained-user";
    const desktop = await connect(url);
    const phone = await connect(url);
    setServerConnection(userId, "desktop-macbook", desktop.server);
    setPhoneConnection(userId, phone.server);
    expect(hasConnectionPairForTests(userId)).toBe(true);

    await disconnect(desktop);
    await disconnect(phone);

    expect(hasConnectionPairForTests(userId)).toBe(false);
  });
});
