import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import WebSocket from "ws";

const RELAY_PORT = 18080;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const HEALTH_URL = `http://localhost:${RELAY_PORT}/health`;

/**
 * Helper: wait for the relay's /health endpoint to respond 200.
 * Polls every 200ms for up to `timeoutMs`.
 */
async function waitForRelay(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Relay did not become ready within ${timeoutMs}ms`);
}

/**
 * Helper: open a WebSocket, authenticate, and resolve when auth_ok is received.
 * Returns { ws, userId } from the auth_ok message.
 */
function connectAndAuth(
  authPayload: Record<string, unknown>
): Promise<{ ws: WebSocket; userId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Auth timed out"));
    }, 5_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...authPayload }));
    });
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timeout);
        resolve({ ws, userId: msg.userId });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Helper: wait for the next message on a WebSocket that matches a predicate.
 */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("waitForMessage timed out"));
    }, timeoutMs);

    const handler = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

/**
 * Helper: close a WebSocket and wait for the close event.
 */
function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState >= WebSocket.CLOSING) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.close();
  });
}

describe("Relay integration", () => {
  let relayProcess: ReturnType<typeof import("child_process").spawn> | null =
    null;

  beforeAll(async () => {
    const { spawn } = await import("child_process");
    relayProcess = spawn("bun", ["run", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, SKIP_AUTH: "true", PORT: String(RELAY_PORT) },
      stdio: "pipe",
    });

    // Log relay stderr for debugging test failures
    relayProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[relay] ${chunk.toString()}`);
    });

    await waitForRelay();
  });

  afterAll(async () => {
    relayProcess?.kill("SIGTERM");
    // Give the process a moment to exit cleanly
    await new Promise((r) => setTimeout(r, 500));
  });

  it("should authenticate a server with device_token", async () => {
    const { ws, userId } = await connectAndAuth({
      device_token: "test-token-s1",
    });
    expect(userId).toBe("test-user");
    await closeAndWait(ws);
  });

  it("should authenticate a phone with id_token", async () => {
    const { ws, userId } = await connectAndAuth({
      id_token: "test-firebase-token",
    });
    expect(userId).toBe("test-user");
    await closeAndWait(ws);
  });

  it("should return 'Desktop offline' when no server is connected", async () => {
    // Connect as phone only (no server for this user)
    const { ws: phone } = await connectAndAuth({ id_token: "phone-only" });

    // Send an invoke — expect an error response since no server is connected
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 42,
        command: "list_sessions",
        args: {},
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response"
    );
    expect(response.id).toBe(42);
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(phone);
  });

  it("should route invoke from phone to server and response back", async () => {
    // 1. Connect server
    const { ws: server } = await connectAndAuth({
      device_token: "test-token-route",
    });

    // 2. Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: "test-token-route",
    });

    // 3. Set up listener on server to auto-respond to invokes
    const serverReceivedInvoke = waitForMessage(
      server,
      (msg) => msg.type === "invoke"
    );

    // 4. Phone sends invoke
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 1,
        command: "list_sessions",
        args: {},
      })
    );

    // 5. Server receives invoke
    const invoke = await serverReceivedInvoke;
    expect(invoke.command).toBe("list_sessions");
    expect(invoke.id).toBe(1);

    // 6. Server sends response
    const phoneReceivedResponse = waitForMessage(
      phone,
      (msg) => msg.type === "response"
    );

    server.send(
      JSON.stringify({
        type: "response",
        id: invoke.id,
        data: [],
      })
    );

    // 7. Phone receives response
    const response = await phoneReceivedResponse;
    expect(response.id).toBe(1);
    expect(response.data).toEqual([]);

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("should route events from server to phone", async () => {
    // Connect server
    const { ws: server } = await connectAndAuth({
      device_token: "test-token-events",
    });

    // Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: "test-token-events",
    });

    // Set up listener on phone for events
    const phoneReceivedEvent = waitForMessage(
      phone,
      (msg) => msg.type === "event"
    );

    // Server pushes an event
    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "s1", data_b64: "aGVsbG8=" },
      })
    );

    // Phone receives the event
    const event = await phoneReceivedEvent;
    expect(event.name).toBe("terminal_output");
    expect((event.payload as Record<string, unknown>).session_id).toBe("s1");

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("should reject connections that do not send auth within timeout", async () => {
    // Connect without sending auth — the relay should close after AUTH_TIMEOUT_MS (10s)
    // We won't wait the full 10s, just verify the connection opens fine
    // and verify a non-auth first message gets rejected
    const ws = new WebSocket(RELAY_URL);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Send a non-auth message
    ws.send(JSON.stringify({ type: "not_auth", foo: "bar" }));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    // The relay closes with 4003 for "First message must be auth"
    expect(closeCode).toBe(4003);
  });

  it("should reject connections with missing tokens", async () => {
    const ws = new WebSocket(RELAY_URL);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Send auth without any token
    ws.send(JSON.stringify({ type: "auth" }));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    // The relay closes with 4004 for "Missing id_token or device_token"
    expect(closeCode).toBe(4004);
  });
});
