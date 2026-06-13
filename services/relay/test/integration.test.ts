import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";

const RELAY_PORT = 18080;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const HEALTH_URL = `http://localhost:${RELAY_PORT}/health`;
const TEST_EMAIL = "upvote.sieve.7t@icloud.com";
const TEST_PASSWORD = "password123";
const OTHER_TEST_EMAIL = "relay.other.7t@example.com";
const OTHER_TEST_PASSWORD = "password123";
const TEST_DEVICE_TOKEN = "e2e-token";

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

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function signInToAuthEmulator(
  authPort: number,
  email: string,
  password: string,
): Promise<string | null> {
  const signInUrl = `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
  const response = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  }).catch(() => null);
  const body = await response?.json().catch(() => null) as { idToken?: string } | null;
  return response?.ok && body?.idToken ? body.idToken : null;
}

async function waitForAuthEmulator(authPort: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await signInToAuthEmulator(authPort, TEST_EMAIL, TEST_PASSWORD);
    if (token) return token;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Firebase auth emulator did not become ready on ${authPort}`);
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
    const handler = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve({ ws, userId: msg.userId });
      }
    };
    ws.on("message", handler);
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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function waitForRawMessage(
  ws: WebSocket,
  predicate: (data: Buffer, isBinary: boolean) => boolean,
  timeoutMs = 5_000
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("waitForRawMessage timed out"));
    }, timeoutMs);

    const handler = (raw: Buffer, isBinary: boolean) => {
      if (predicate(raw, isBinary)) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve({ data: raw, isBinary });
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
  let firebaseProcess: ChildProcessWithoutNullStreams | null = null;
  let firebaseConfigDir: string | null = null;
  let authPort = 0;
  let firestorePort = 0;
  let idToken = "";
  let otherIdToken = "";
  let relayProcess: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    authPort = await findFreePort();
    firestorePort = await findFreePort();
    firebaseConfigDir = await mkdtemp(join(tmpdir(), "kanna-relay-firebase-"));
    const firebaseConfigPath = join(firebaseConfigDir, "firebase.json");
    await writeFile(
      firebaseConfigPath,
      JSON.stringify({
        firestore: { rules: resolve(fileURLToPath(new URL("../../../firestore.rules", import.meta.url))) },
        emulators: {
          auth: { host: "127.0.0.1", port: authPort },
          firestore: { host: "127.0.0.1", port: firestorePort },
          ui: { enabled: false },
        },
      }),
    );
    firebaseProcess = spawn("pnpm", [
      "exec",
      "firebase",
      "emulators:start",
      "--project",
      "kanna-local",
      "--config",
      firebaseConfigPath,
      "--import",
      resolve(fileURLToPath(new URL("../../firebase/emulator-seed", import.meta.url))),
    ], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env },
      stdio: "pipe",
    });
    firebaseProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[firebase] ${chunk.toString()}`);
    });
    idToken = await waitForAuthEmulator(authPort);
    otherIdToken = await signInToAuthEmulator(authPort, OTHER_TEST_EMAIL, OTHER_TEST_PASSWORD) ?? "";
    if (!otherIdToken) throw new Error("Second seeded auth user is unavailable");

    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        FIREBASE_PROJECT_ID: "kanna-local",
        FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
        PORT: String(RELAY_PORT),
      },
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
    firebaseProcess?.kill("SIGTERM");
    // Give the process a moment to exit cleanly
    await new Promise((r) => setTimeout(r, 500));
    if (firebaseConfigDir) await rm(firebaseConfigDir, { recursive: true, force: true });
  });

  it("should authenticate a server with device_token", async () => {
    const { ws, userId } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });
    expect(userId).toMatch(/^[A-Za-z0-9]+$/);
    await closeAndWait(ws);
  });

  it("routes legacy device-token servers by supplied desktop id", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-legacy-route",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const serverReceivedInvoke = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.desktopId === "desktop-legacy-route",
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "legacy-desktop-route",
        desktopId: "desktop-legacy-route",
        command: "list_sessions",
        args: {},
      }),
    );

    await expect(serverReceivedInvoke).resolves.toMatchObject({
      id: "legacy-desktop-route",
      command: "list_sessions",
    });

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("should authenticate a phone with id_token", async () => {
    const { ws, userId } = await connectAndAuth({
      id_token: idToken,
    });
    expect(userId).toMatch(/^[A-Za-z0-9]+$/);
    await closeAndWait(ws);
  });

  it("should return 'Desktop offline' when no server is connected", async () => {
    // Connect as phone only (no server for this user)
    const { ws: phone } = await connectAndAuth({ id_token: idToken });

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
      device_token: TEST_DEVICE_TOKEN,
    });

    // 2. Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
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

  it("pairs a requested tunnel and splices text and binary frames without parsing them", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-tunnel",
    });
    const { ws: clientTunnel } = await connectAndAuth({
      id_token: idToken,
    });

    const establishSignal = waitForMessage(
      desktopControl,
      (msg) => msg.type === "tunnel_establish" && msg.desktopId === "desktop-tunnel",
    );

    clientTunnel.send(
      JSON.stringify({
        type: "tunnel_request",
        id: "open-tunnel-1",
        desktopId: "desktop-tunnel",
      }),
    );

    const signal = await establishSignal;
    expect(signal.tunnelId).toEqual(expect.any(String));

    const desktopTunnel = new WebSocket(RELAY_URL);
    const readyOrder: string[] = [];
    desktopTunnel.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId) {
        readyOrder.push("desktop");
      }
    });
    clientTunnel.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId) {
        readyOrder.push("client");
      }
    });
    const desktopReady = waitForMessage(
      desktopTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    const clientReady = waitForMessage(
      clientTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );

    await new Promise<void>((resolve) => desktopTunnel.on("open", resolve));
    desktopTunnel.send(
      JSON.stringify({
        type: "auth",
        device_token: TEST_DEVICE_TOKEN,
        desktop_id: "desktop-tunnel",
        tunnel_id: signal.tunnelId,
      }),
    );

    await expect(desktopReady).resolves.toMatchObject({ type: "tunnel_ready" });
    await expect(clientReady).resolves.toMatchObject({ type: "tunnel_ready" });
    expect(readyOrder.slice(0, 2)).toEqual(["desktop", "client"]);

    const desktopSawJson = waitForRawMessage(
      desktopTunnel,
      (raw, isBinary) => !isBinary && raw.toString() === '{"type":"ksp_auth","credential":"opaque"}',
    );
    clientTunnel.send('{"type":"ksp_auth","credential":"opaque"}');
    await expect(desktopSawJson).resolves.toMatchObject({ isBinary: false });

    const clientSawBinary = waitForRawMessage(
      clientTunnel,
      (raw, isBinary) => isBinary && raw.equals(Buffer.from([0, 1, 2, 255])),
    );
    desktopTunnel.send(Buffer.from([0, 1, 2, 255]));
    await expect(clientSawBinary).resolves.toMatchObject({ isBinary: true });

    await closeAndWait(clientTunnel);
    await closeAndWait(desktopTunnel);
    await closeAndWait(desktopControl);
  });

  it("rejects tunnel requests for an offline desktop", async () => {
    const { ws: client } = await connectAndAuth({
      id_token: idToken,
    });

    client.send(
      JSON.stringify({
        type: "tunnel_request",
        id: "offline-tunnel",
        desktopId: "missing-desktop",
      }),
    );

    const response = await waitForMessage(
      client,
      (msg) => msg.type === "response" && msg.id === "offline-tunnel",
    );
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(client);
  });

  it("should route events from server to phone", async () => {
    // Connect server
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });

    // Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
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

  it("routes terminal events only to clients that observe the session", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-terminal-owner",
    });
    const { ws: observer } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: idleClient } = await connectAndAuth({
      id_token: idToken,
    });

    const observeInvoke = waitForMessage(
      server,
      (msg) =>
        msg.type === "invoke" &&
        msg.command === "observe_session" &&
        msg.desktopId === "desktop-terminal-owner",
    );

    observer.send(
      JSON.stringify({
        type: "invoke",
        id: "observe-task-1",
        desktopId: "desktop-terminal-owner",
        command: "observe_session",
        args: { session_id: "task-1" },
      }),
    );

    const invoke = await observeInvoke;
    server.send(
      JSON.stringify({
        type: "response",
        id: invoke.id,
        data: null,
      }),
    );
    await waitForMessage(
      observer,
      (msg) => msg.type === "response" && msg.id === "observe-task-1",
    );

    const observedEvent = waitForMessage(
      observer,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
    );
    const idleEvent = waitForMessage(
      idleClient,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
      250,
    ).then(
      () => "event",
      () => "timeout",
    );

    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "task-1", data_b64: "aGVsbG8=" },
      }),
    );

    await expect(observedEvent).resolves.toMatchObject({
      name: "terminal_output",
    });
    await expect(idleEvent).resolves.toBe("timeout");

    await closeAndWait(observer);
    await closeAndWait(idleClient);
    await closeAndWait(server);
  });

  it("keeps owner terminal streaming until the last observer unsubscribes", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-terminal-shared",
    });
    const { ws: first } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: second } = await connectAndAuth({
      id_token: idToken,
    });

    for (const [client, id] of [[first, "observe-first"], [second, "observe-second"]] as const) {
      const forwardedObserve = waitForMessage(
        server,
        (msg) => msg.type === "invoke" && msg.command === "observe_session" && msg.id === id,
      );
      client.send(
        JSON.stringify({
          type: "invoke",
          id,
          desktopId: "desktop-terminal-shared",
          command: "observe_session",
          args: { session_id: "task-shared" },
        }),
      );
      await forwardedObserve;
      server.send(JSON.stringify({ type: "response", id, data: null }));
      await waitForMessage(client, (msg) => msg.type === "response" && msg.id === id);
    }

    const unexpectedUnobserve = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.command === "unobserve_session",
      250,
    ).then(
      () => "unobserve",
      () => "timeout",
    );
    first.send(
      JSON.stringify({
        type: "invoke",
        id: "unobserve-first",
        desktopId: "desktop-terminal-shared",
        command: "unobserve_session",
        args: { session_id: "task-shared" },
      }),
    );
    await waitForMessage(first, (msg) => msg.type === "response" && msg.id === "unobserve-first");
    await expect(unexpectedUnobserve).resolves.toBe("timeout");

    const firstEvent = waitForMessage(
      first,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
      250,
    ).then(
      () => "event",
      () => "timeout",
    );
    const secondEvent = waitForMessage(
      second,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
    );
    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "task-shared", data_b64: "bGl2ZQ==" },
      }),
    );
    await expect(firstEvent).resolves.toBe("timeout");
    await expect(secondEvent).resolves.toMatchObject({ name: "terminal_output" });

    const forwardedUnobserve = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.command === "unobserve_session" && msg.id === "unobserve-second",
    );
    second.send(
      JSON.stringify({
        type: "invoke",
        id: "unobserve-second",
        desktopId: "desktop-terminal-shared",
        command: "unobserve_session",
        args: { session_id: "task-shared" },
      }),
    );
    await forwardedUnobserve;

    await closeAndWait(first);
    await closeAndWait(second);
    await closeAndWait(server);
  });

  it("keeps two desktop connections for the same user isolated by desktop id", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-two" &&
        msg.command === "list_sessions"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 91,
        desktopId: "desktop-two",
        command: "list_sessions",
        args: {},
      })
    );

    const invoke = await desktopTwoInvoke;
    expect(invoke.desktopId).toBe("desktop-two");
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("routes HTTP-style invokes only to the selected desktop", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one-http",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two-http",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-two-http" &&
        msg.method === "GET" &&
        msg.path === "/v1/status"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "http-status",
        desktopId: "desktop-two-http",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const invoke = await desktopTwoInvoke;
    expect(invoke.body).toBeNull();
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("routes mobile task actions only to the requested owner desktop", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-owner-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-owner-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const unexpectedDesktopOneInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-owner-two" &&
        msg.path === "/v1/tasks/cloud-task-1/input"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "task-action-owner-route",
        desktopId: "desktop-owner-two",
        method: "POST",
        path: "/v1/tasks/cloud-task-1/input",
        body: { input: "continue\n" },
      })
    );

    await expect(desktopTwoInvoke).resolves.toMatchObject({
      desktopId: "desktop-owner-two",
      method: "POST",
    });
    await expect(unexpectedDesktopOneInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("requires desktopId for HTTP-style invokes when multiple desktops are connected", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one-missing-id",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two-missing-id",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoUnexpectedInvoke = waitForMessage(
      desktopTwo,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "missing-desktop-id",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "missing-desktop-id"
    );
    expect(response.error).toBe("Multiple desktops connected; desktopId required");
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");
    await expect(desktopTwoUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("returns Desktop offline for an HTTP-style invoke targeting a disconnected desktop", async () => {
    const { ws: desktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-online",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "offline-desktop",
        desktopId: "desktop-offline",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "offline-desktop"
    );
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(phone);
    await closeAndWait(desktop);
  });

  it("lists only active desktop connections for a signed-in user", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-active-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-active-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "active-desktops",
        command: "list_active_desktops",
        args: {},
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "active-desktops"
    );
    expect(response.data).toEqual({
      desktopIds: expect.arrayContaining([
        "desktop-active-one",
        "desktop-active-two",
      ]),
    });

    await closeAndWait(desktopTwo);
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "active-desktops-after-close",
        command: "list_active_desktops",
        args: {},
      })
    );

    const afterClose = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "active-desktops-after-close"
    );
    expect(afterClose.data).toEqual({
      desktopIds: ["desktop-active-one"],
    });

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
  });

  it("routes desktop responses only to phones authenticated as the same user", async () => {
    const { ws: userOneDesktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });
    const { ws: userOnePhone } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: userTwoPhone } = await connectAndAuth({
      id_token: otherIdToken,
    });

    const userOneResponse = waitForMessage(
      userOnePhone,
      (msg) => msg.type === "response" && msg.id === "same-user-only"
    );
    const userTwoUnexpectedResponse = waitForMessage(
      userTwoPhone,
      (msg) => msg.type === "response",
      250
    ).then(
      () => "response",
      () => "timeout"
    );

    userOneDesktop.send(
      JSON.stringify({
        type: "response",
        id: "same-user-only",
        data: { ok: true },
      })
    );

    const response = await userOneResponse;
    expect(response.data).toEqual({ ok: true });
    await expect(userTwoUnexpectedResponse).resolves.toBe("timeout");

    await closeAndWait(userTwoPhone);
    await closeAndWait(userOnePhone);
    await closeAndWait(userOneDesktop);
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
