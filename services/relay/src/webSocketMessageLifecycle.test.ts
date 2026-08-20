import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { publishMobileNotification } from "./mobileNotifications.js";
import {
  attachWebSocketMessageHandler,
} from "./webSocketMessageLifecycle.js";

class FaultInjectingSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  sendAttempts = 0;
  terminated = false;
  sendFailure: Error | null = null;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sendAttempts += 1;
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push(data);
    callback?.();
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  emitJson(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("websocket message lifecycle", () => {
  it("does not decode successful binary frames for failure correlation", async () => {
    const socket = new FaultInjectingSocket();
    const raw = Buffer.alloc(128 * 1024);
    const toString = vi.spyOn(raw, "toString");
    const handler = vi.fn(async () => undefined);
    attachWebSocketMessageHandler(
      socket as unknown as WebSocket,
      "test-peer",
      handler,
    );

    socket.emit("message", raw, true);
    await flushEventLoop();

    expect(handler).toHaveBeenCalledOnce();
    expect(toString).not.toHaveBeenCalled();
  });

  it("contains concurrent incident-id failure and sends one correlated safe acknowledgement", async () => {
    const canary = "incident-secret-DO-NOT-LEAK";
    const socket = new FaultInjectingSocket();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    attachWebSocketMessageHandler(
      socket as unknown as WebSocket,
      "test-peer",
      async (raw, _isBinary, lifecycle) => {
        const message = parseMessage(raw);
        if (message.id === "notify-healthy") {
          lifecycle.sendMobileNotificationAck({
            type: "mobile_notification_ack",
            id: message.id,
            ok: true,
          });
          return;
        }
        await publishMobileNotification({
          userId: "operator-1",
          desktopId: "desktop-1",
          notification: { title: "Ready", body: "Staging is ready." },
          sendAck: (ack) => lifecycle.sendMobileNotificationAck({
            type: "mobile_notification_ack",
            id: message.id,
            ...ack,
          }),
        }, {
          send: async () => {
            throw new Error(`provider rejected ${canary}`);
          },
          createIncidentId: () => {
            throw new Error(`incident allocation rejected ${canary}`);
          },
        });
      },
    );

    const unhandled = await captureUnhandledRejections(async () => {
      socket.emitJson(mobileNotificationRequest("notify-incident-failure"));
      socket.emitJson(mobileNotificationRequest("notify-healthy"));
    });

    expect(unhandled).toEqual([]);
    expect(decodedMessages(socket)).toEqual([
      {
        type: "mobile_notification_ack",
        id: "notify-healthy",
        ok: true,
      },
      {
        type: "mobile_notification_ack",
        id: "notify-incident-failure",
        ok: false,
        error: "relay could not process request",
      },
    ]);
    expect(socket.sendAttempts).toBe(2);
    expect(socket.terminated).toBe(false);
    expect(renderedLogCalls(errors.mock.calls, warnings.mock.calls)).not.toContain(canary);
    expect(renderedLogCalls([[new Error(canary)]])).toContain(canary);
  });

  it("contains acknowledgement send failure without a duplicate attempt and disconnects", async () => {
    const canary = "websocket-send-secret-DO-NOT-LEAK";
    const socket = new FaultInjectingSocket();
    socket.sendFailure = new Error(`socket write rejected ${canary}`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    attachWebSocketMessageHandler(
      socket as unknown as WebSocket,
      "test-peer",
      async (raw, _isBinary, lifecycle) => {
        const message = parseMessage(raw);
        await Promise.resolve();
        lifecycle.sendMobileNotificationAck({
          type: "mobile_notification_ack",
          id: message.id,
          ok: true,
        });
      },
    );

    const unhandled = await captureUnhandledRejections(async () => {
      socket.emitJson(mobileNotificationRequest("notify-send-failure"));
    });

    expect(unhandled).toEqual([]);
    expect(socket.sendAttempts).toBe(1);
    expect(socket.sent).toEqual([]);
    expect(socket.terminated).toBe(true);
    expect(renderedLogCalls(errors.mock.calls)).not.toContain(canary);
  });

  it("contains auth revalidation rejection through the production websocket listener", async () => {
    const canary = "desktop-auth-secret-DO-NOT-LEAK";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const revalidateServerAuth = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error(`credential lookup rejected ${canary}`));
    vi.doMock("./auth.js", () => ({
      verifyPhoneToken: vi.fn(),
      verifyDeviceToken: vi.fn(),
      verifyDesktopCredentials: vi.fn().mockResolvedValue({
        userId: "operator-1",
        desktopId: "desktop-1",
      }),
      revalidateServerAuth,
      registerDevice: vi.fn(),
      registerPushDevice: vi.fn(),
      unregisterPushDevice: vi.fn(),
    }));
    vi.doMock("./cloudTaskPublication.js", () => ({
      createFirestoreCloudTaskPublicationStore: vi.fn().mockReturnValue({}),
      beginCloudTaskPublicationSession: vi.fn().mockResolvedValue(1),
      endCloudTaskPublicationSession: vi.fn().mockResolvedValue(undefined),
      handleCloudTaskPublication: vi.fn(),
      MAX_TASK_SNAPSHOT_BYTES: 4 * 1024 * 1024,
    }));

    const port = await findFreePort();
    const relay = await import("./index.js");
    relay.startRelay(port, "127.0.0.1");
    await waitForListening(relay.server);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
      await waitForOpen(client);
      client.send(JSON.stringify({
        type: "auth",
        desktop_id: "desktop-1",
        desktop_secret: "desktop-secret",
      }));
      expect(await receiveJson(client)).toMatchObject({ type: "auth_ok" });

      const unhandled = await captureUnhandledRejections(async () => {
        client.send(JSON.stringify(mobileNotificationRequest("notify-revalidation-failure")));
        expect(await receiveJson(client)).toEqual({
          type: "mobile_notification_ack",
          id: "notify-revalidation-failure",
          ok: false,
          error: "relay could not process request",
        });
      });

      expect(unhandled).toEqual([]);
      expect(revalidateServerAuth).toHaveBeenCalledTimes(2);
      await expectNoMessage(client);
      expect(renderedLogCalls(errors.mock.calls, warnings.mock.calls)).not.toContain(canary);
    } finally {
      client.close();
      await waitForClose(client);
      await closeWebSocketServer(relay.wss);
      await closeServer(relay.server);
      logs.mockRestore();
      vi.doUnmock("./auth.js");
      vi.doUnmock("./cloudTaskPublication.js");
    }
  });
});

function mobileNotificationRequest(id: string): Record<string, unknown> {
  return {
    type: "mobile_notification_publish",
    id,
    notification: { title: "Ready", body: "Staging is ready." },
  };
}

function parseMessage(raw: RawData): Record<string, unknown> {
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

function decodedMessages(socket: FaultInjectingSocket): Record<string, unknown>[] {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

function renderedLogCalls(...calls: ReadonlyArray<ReadonlyArray<ReadonlyArray<unknown>>>): string {
  return calls.flat(2).map((argument) => inspect(argument)).join("\n");
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to resolve relay test port"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForListening(server: import("node:http").Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function receiveJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", reject);
  });
}

async function expectNoMessage(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      clearTimeout(timeout);
      reject(new Error(`unexpected duplicate websocket message: ${data.toString()}`));
    };
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, 25);
    ws.once("message", onMessage);
  });
}

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once("close", resolve);
  });
}

async function closeWebSocketServer(server: import("ws").WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function captureUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    await flushEventLoop();
    await flushEventLoop();
    return reasons;
  } finally {
    process.off("unhandledRejection", listener);
  }
}

async function flushEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
