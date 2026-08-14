import { EventEmitter } from "node:events";
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
    expect(JSON.stringify({ errors: errors.mock.calls, warnings: warnings.mock.calls }))
      .not.toContain(canary);
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
    expect(JSON.stringify(errors.mock.calls)).not.toContain(canary);
  });

  it("contains concurrent auth revalidation rejection while another request completes", async () => {
    const canary = "desktop-auth-secret-DO-NOT-LEAK";
    const socket = new FaultInjectingSocket();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revalidateServerAuth = vi.fn(async () => {
      throw new Error(`credential lookup rejected ${canary}`);
    });
    attachWebSocketMessageHandler(
      socket as unknown as WebSocket,
      "test-peer",
      async (raw, _isBinary, lifecycle) => {
        const message = parseMessage(raw);
        if (message.id === "notify-revalidation-failure") {
          await revalidateServerAuth();
        }
        lifecycle.sendMobileNotificationAck({
          type: "mobile_notification_ack",
          id: message.id,
          ok: true,
        });
      },
    );

    const unhandled = await captureUnhandledRejections(async () => {
      socket.emitJson(mobileNotificationRequest("notify-revalidation-failure"));
      socket.emitJson(mobileNotificationRequest("notify-concurrent-success"));
    });

    expect(unhandled).toEqual([]);
    expect(revalidateServerAuth).toHaveBeenCalledOnce();
    expect(decodedMessages(socket)).toEqual([
      {
        type: "mobile_notification_ack",
        id: "notify-concurrent-success",
        ok: true,
      },
      {
        type: "mobile_notification_ack",
        id: "notify-revalidation-failure",
        ok: false,
        error: "relay could not process request",
      },
    ]);
    expect(socket.sendAttempts).toBe(2);
    expect(socket.terminated).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(canary);
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
