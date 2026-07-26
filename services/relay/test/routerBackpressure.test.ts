import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  routeMessage,
  setPhoneConnection,
  setServerConnection,
  TASK_TRANSFER_TUNNEL_MAX_BUFFERED_BYTES,
  taskTransferTunnelFlowStateForTests,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = null;
});

describe("task-transfer tunnel backpressure", () => {
  it("pauses a fast producer for a slow consumer without exceeding the byte cap", async () => {
    const port = await freePort();
    server = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const url = `ws://127.0.0.1:${port}`;

    const control = await connect(url);
    setServerConnection("user", "desktop", control.server);
    const producer = await connect(url);
    setPhoneConnection("user", producer.server);

    const establish = new Promise<Record<string, unknown>>((resolve) => {
      control.client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    routeMessage(
      "user",
      "phone",
      JSON.stringify({
        type: "tunnel_request",
        id: "slow-consumer",
        desktopId: "desktop",
        service: "task-transfer",
      }),
      producer.server,
    );
    const signal = await establish;
    const consumer = await connect(url);
    expect(attachDesktopTunnel(
      "user",
      "desktop",
      String(signal.tunnelId),
      consumer.server,
    )).toBe(true);
    producer.server.on("message", (data, isBinary) => {
      forwardTunnelData(producer.server, data, isBinary);
    });
    consumer.server.on("message", (data, isBinary) => {
      forwardTunnelData(consumer.server, data, isBinary);
    });

    consumer.client.pause();
    const frame = Buffer.alloc(128 * 1024, 7);
    for (let index = 0; index < 64; index += 1) {
      producer.client.send(frame);
      if (taskTransferTunnelFlowStateForTests(producer.server).paused) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await waitUntil(() => taskTransferTunnelFlowStateForTests(producer.server).paused);

    const flow = taskTransferTunnelFlowStateForTests(producer.server);
    expect(flow.peakBufferedBytes).toBeGreaterThan(0);
    expect(flow.peakBufferedBytes).toBeLessThanOrEqual(
      TASK_TRANSFER_TUNNEL_MAX_BUFFERED_BYTES,
    );

    consumer.client.resume();
    await waitUntil(() => !taskTransferTunnelFlowStateForTests(producer.server).paused);
  }, 10_000);
});
