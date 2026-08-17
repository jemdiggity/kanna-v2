import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createRelayDesktopClient, type RelayDesktopClient } from "../../../../mobile/src/lib/transports/relayClient";

function relayUrlForE2e(): string {
  const relayPort = process.env.KANNA_RELAY_PORT;
  if (!relayPort) {
    throw new Error("KANNA_RELAY_PORT is required for mobile relay auth recovery E2E");
  }
  return `ws://127.0.0.1:${relayPort}`;
}

function e2eDeviceToken(): string {
  const token = process.env.KANNA_E2E_DEVICE_TOKEN;
  if (!token) {
    throw new Error("KANNA_E2E_DEVICE_TOKEN is required for mobile relay auth recovery E2E");
  }
  return token;
}

async function signInForIdToken(): Promise<string> {
  const authPort = process.env.KANNA_FIREBASE_AUTH_PORT;
  if (!authPort) {
    throw new Error("KANNA_FIREBASE_AUTH_PORT is required for mobile relay auth recovery E2E");
  }

  const response = await fetch(
    `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "upvote.sieve.7t@icloud.com",
        password: "password123",
        returnSecureToken: true,
      }),
    },
  );
  const body = await response.json().catch(() => null) as { idToken?: string } | null;
  if (!response.ok || !body?.idToken) {
    throw new Error(`failed to sign into auth emulator: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectOpen(new Error("timed out waiting for relay websocket open"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = () => {
      cleanup();
      rejectOpen(new Error("relay websocket failed before open"));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

function waitForRelayMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error("timed out waiting for relay websocket message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(parsed)) return;
      cleanup();
      resolveMessage(parsed);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      rejectMessage(new Error(`relay websocket closed while waiting for message: ${event.code}`));
    };
    const onError = () => {
      cleanup();
      rejectMessage(new Error("relay websocket failed while waiting for message"));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function connectDesktopControlSocket(desktopId: string): Promise<WebSocket> {
  const socket = new WebSocket(relayUrlForE2e());
  await waitForWebSocketOpen(socket);
  socket.send(JSON.stringify({
    type: "auth",
    device_token: e2eDeviceToken(),
    desktop_id: desktopId,
  }));
  await waitForRelayMessage(socket, (message) => message.type === "auth_ok");
  return socket;
}

async function acceptRelayTunnel(input: {
  control: WebSocket;
  desktopId: string;
  expectedCredential: string;
  taskId: string;
}): Promise<WebSocket> {
  const establish = await waitForRelayMessage(
    input.control,
    (message) => message.type === "tunnel_establish" && message.desktopId === input.desktopId,
  );
  const tunnelId = establish.tunnelId;
  if (typeof tunnelId !== "string" || tunnelId.length === 0) {
    throw new Error(`relay tunnel_establish did not include a tunnel id: ${JSON.stringify(establish)}`);
  }

  const tunnel = new WebSocket(relayUrlForE2e());
  await waitForWebSocketOpen(tunnel);
  const ready = waitForRelayMessage(
    tunnel,
    (message) => message.type === "tunnel_ready" && message.tunnelId === tunnelId,
  );
  tunnel.send(JSON.stringify({
    type: "auth",
    device_token: e2eDeviceToken(),
    desktop_id: input.desktopId,
    tunnel_id: tunnelId,
  }));
  await ready;

  const kspAuth = await waitForRelayMessage(tunnel, (message) => message.type === "auth");
  expect(kspAuth).toMatchObject({
    type: "auth",
    credential: input.expectedCredential,
    capabilities: ["companion_event_epoch", "term_input_boundary"],
  });
  tunnel.send(JSON.stringify({ type: "auth_ok" }));

  const attach = await waitForRelayMessage(
    tunnel,
    (message) =>
      message.type === "attach" &&
      message.task_id === input.taskId &&
      message.kind === "terminal",
  );
  expect(attach).toEqual({
    type: "attach",
    task_id: input.taskId,
    kind: "terminal",
    from_seq: 0,
  });
  tunnel.send(JSON.stringify({
    type: "term_output",
    task_id: input.taskId,
    data_b64: Buffer.from("relay auth recovered").toString("base64"),
  }));
  return tunnel;
}

describe("mobile relay auth recovery", () => {
  it("force-refreshes once and reconnects a relay stream after the relay rejects the cached token", async () => {
    const taskId = "relay-auth-recovery-task";
    const desktopId = "desktop-relay-auth-recovery";
    const idToken = await signInForIdToken();
    const forceRefreshCalls: Array<boolean | undefined> = [];
    const authExpiredCalls: string[] = [];
    const terminalEvents: unknown[] = [];
    let client: RelayDesktopClient | null = null;
    let control: WebSocket | null = null;
    let tunnel: WebSocket | null = null;

    try {
      control = await connectDesktopControlSocket(desktopId);
      client = createRelayDesktopClient({
        relayUrl: relayUrlForE2e(),
        getIdToken: async (forceRefresh) => {
          forceRefreshCalls.push(forceRefresh);
          return forceRefresh ? idToken : "invalid-cached-id-token";
        },
        onAuthError: () => {
          authExpiredCalls.push("auth-expired");
        },
      });

      client.observeTaskTerminal({ desktopId, taskId }, (event) => {
        terminalEvents.push(event);
      });
      tunnel = await acceptRelayTunnel({
        control,
        desktopId,
        expectedCredential: idToken,
        taskId,
      });

      await waitUntil(
        () => terminalEvents.some((event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "output" &&
          "dataB64" in event &&
          typeof event.dataB64 === "string" &&
          Buffer.from(event.dataB64, "base64").toString("utf8") === "relay auth recovered"
        ),
        `timed out waiting for recovered relay terminal output: ${JSON.stringify(terminalEvents)}`,
      );
      expect(forceRefreshCalls).toEqual([false, true]);
      expect(authExpiredCalls).toEqual([]);
    } finally {
      client?.close();
      control?.close();
      tunnel?.close();
    }
  });

  it("surfaces auth-expired and stops retrying when the refreshed token is also rejected", async () => {
    const forceRefreshCalls: Array<boolean | undefined> = [];
    const authExpiredCalls: string[] = [];
    let client: RelayDesktopClient | null = null;

    try {
      client = createRelayDesktopClient({
        relayUrl: relayUrlForE2e(),
        getIdToken: async (forceRefresh) => {
          forceRefreshCalls.push(forceRefresh);
          return "invalid-id-token";
        },
        onAuthError: () => {
          authExpiredCalls.push("auth-expired");
        },
      });

      client.observeTaskTerminal(
        { desktopId: "desktop-relay-auth-recovery-rejected", taskId: "relay-auth-rejected-task" },
        () => {},
      );

      await waitUntil(
        () => authExpiredCalls.length === 1,
        `timed out waiting for auth-expired relay state; calls=${JSON.stringify(forceRefreshCalls)}`,
      );
      await sleep(1_000);
      expect(forceRefreshCalls).toEqual([false, true]);
      expect(authExpiredCalls).toEqual(["auth-expired"]);
    } finally {
      client?.close();
    }
  });
});
