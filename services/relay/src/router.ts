import type { WebSocket } from "ws";

interface ConnectionPair {
  clients: Set<WebSocket>;
  desktops: Map<string, WebSocket>;
  pendingResponses: Map<string, WebSocket>;
  terminalObservers: Map<string, Set<WebSocket>>;
}

interface RelayMessage {
  type?: unknown;
  id?: unknown;
  desktopId?: unknown;
  command?: unknown;
  args?: unknown;
  name?: unknown;
  payload?: unknown;
}

/** In-memory map of userId → client and desktop WebSocket connections. */
const connections = new Map<string, ConnectionPair>();

function parseRelayMessage(data: string): RelayMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === "object") {
      return parsed as RelayMessage;
    }
  } catch {
    return null;
  }

  return null;
}

function sendErrorResponse(
  client: WebSocket | undefined,
  id: unknown,
  error: string
): void {
  if (id == null || !client || client.readyState !== 1) {
    return;
  }

  client.send(
    JSON.stringify({
      type: "response",
      id,
      error,
    })
  );
}

function sendSuccessResponse(client: WebSocket | undefined, id: unknown): void {
  if (id == null || !client || client.readyState !== 1) {
    return;
  }

  client.send(
    JSON.stringify({
      type: "response",
      id,
      data: null,
    })
  );
}

function sendDataResponse(
  client: WebSocket | undefined,
  id: unknown,
  data: unknown
): void {
  if (id == null || !client || client.readyState !== 1) {
    return;
  }

  client.send(
    JSON.stringify({
      type: "response",
      id,
      data,
    })
  );
}

function messageIdKey(id: unknown): string | null {
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function getSessionIdFromMessage(message: RelayMessage | null): string | null {
  if (message?.command === "observe_session" || message?.command === "unobserve_session") {
    const args = message.args;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const sessionId = (args as Record<string, unknown>).session_id;
      return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
    }
  }

  if (message?.type === "event") {
    const payload = message.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const sessionId = (payload as Record<string, unknown>).session_id;
      return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
    }
  }

  return null;
}

function observerKey(desktopId: string | undefined, sessionId: string): string {
  return `${desktopId ?? "default"}:${sessionId}`;
}

function splitObserverKey(key: string): { desktopId: string; sessionId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    desktopId: key.slice(0, separator),
    sessionId: key.slice(separator + 1),
  };
}

function buildUnobserveMessage(sessionId: string, id: string): string {
  return JSON.stringify({
    type: "invoke",
    id,
    command: "unobserve_session",
    args: { session_id: sessionId },
  });
}

function forwardUnobserveIfLastObserverGone(
  pair: ConnectionPair,
  key: string,
  pendingTarget?: WebSocket
): void {
  const observer = splitObserverKey(key);
  if (!observer) return;
  const target = pair.desktops.get(observer.desktopId);
  if (!target || target.readyState !== 1) return;

  const id = `relay-unobserve:${key}:${Date.now()}:${Math.random()}`;
  if (pendingTarget) {
    pair.pendingResponses.set(id, pendingTarget);
  }
  target.send(buildUnobserveMessage(observer.sessionId, id));
}

function removeClient(pair: ConnectionPair, ws: WebSocket): void {
  pair.clients.delete(ws);
  for (const [id, client] of pair.pendingResponses.entries()) {
    if (client === ws) {
      pair.pendingResponses.delete(id);
    }
  }
  for (const [key, clients] of pair.terminalObservers.entries()) {
    clients.delete(ws);
    if (clients.size === 0) {
      pair.terminalObservers.delete(key);
      forwardUnobserveIfLastObserverGone(pair, key, ws);
    }
  }
}

/**
 * Store the phone-side WebSocket for a user.
 * Closes any existing phone connection for this user.
 * Cleans up the map entry when the socket closes.
 */
export function setPhoneConnection(userId: string, ws: WebSocket): void {
  let pair = connections.get(userId);
  if (!pair) {
    pair = {
      clients: new Set(),
      desktops: new Map(),
      pendingResponses: new Map(),
      terminalObservers: new Map(),
    };
    connections.set(userId, pair);
  }

  pair.clients.add(ws);
  console.log(`[router] Client connected for ${userId}`);

  ws.on("close", () => {
    console.log(`[router] Client disconnected for ${userId}`);
    const current = connections.get(userId);
    if (current?.clients.has(ws)) {
      removeClient(current, ws);
      if (current.desktops.size === 0) {
        connections.delete(userId);
      }
    }
  });
}

/**
 * Store the server-side (kanna-server) WebSocket for a user.
 * Closes any existing server connection for this user.
 * Cleans up the map entry when the socket closes.
 */
export function setServerConnection(
  userId: string,
  desktopId: string,
  ws: WebSocket
): void {
  let pair = connections.get(userId);
  if (!pair) {
    pair = {
      clients: new Set(),
      desktops: new Map(),
      pendingResponses: new Map(),
      terminalObservers: new Map(),
    };
    connections.set(userId, pair);
  }

  const existing = pair.desktops.get(desktopId);
  if (existing && existing !== ws && existing.readyState <= 1) {
    console.log(
      `[router] Closing existing server connection for ${userId}/${desktopId}`
    );
    existing.close(1000, "Replaced by new connection");
  }

  pair.desktops.set(desktopId, ws);
  console.log(`[router] Server connected for ${userId}/${desktopId}`);

  ws.on("close", () => {
    console.log(`[router] Server disconnected for ${userId}/${desktopId}`);
    const current = connections.get(userId);
    if (current?.desktops.get(desktopId) === ws) {
      current.desktops.delete(desktopId);
      // Clean up map entry if both sides are gone
      if (current.clients.size === 0) {
        connections.delete(userId);
      }
    }
  });
}

/**
 * Route a message from one side to the other.
 *
 * - If phone sends to an offline server: parse JSON and return an error response.
 * - If server sends to an offline phone: silently drop the message.
 */
export function routeMessage(
  userId: string,
  from: "phone" | "server",
  data: string,
  source?: WebSocket,
  sourceDesktopId?: string | null
): void {
  const pair = connections.get(userId);
  if (!pair) return;
  const parsed = parseRelayMessage(data);

  if (from === "phone") {
    if (parsed?.command === "list_active_desktops") {
      sendDataResponse(source, parsed.id, {
        desktopIds: Array.from(pair.desktops.entries())
          .filter(([, ws]) => ws.readyState === 1)
          .map(([desktopId]) => desktopId),
      });
      return;
    }

    let target: WebSocket | undefined;
    let error: string | undefined;
    const desktopId =
      typeof parsed?.desktopId === "string" ? parsed.desktopId : undefined;
    const desktopCount = pair.desktops.size;

    if (desktopId) {
      target = pair.desktops.get(desktopId);
      if (!target) {
        error = "Desktop offline";
      }
    } else if (desktopCount === 1) {
      target = Array.from(pair.desktops.values())[0];
    } else if (desktopCount > 1) {
      error = "Multiple desktops connected; desktopId required";
    } else {
      error = "Desktop offline";
    }

    if (target && target.readyState === 1) {
      const resolvedDesktopId =
        desktopId ??
        (desktopCount === 1 ? Array.from(pair.desktops.keys())[0] : undefined);
      const idKey = messageIdKey(parsed?.id);
      if (idKey && source) {
        pair.pendingResponses.set(idKey, source);
      }
      const sessionId = getSessionIdFromMessage(parsed);
      if (sessionId && source && parsed?.command === "observe_session") {
        const key = observerKey(resolvedDesktopId, sessionId);
        let clients = pair.terminalObservers.get(key);
        if (!clients) {
          clients = new Set();
          pair.terminalObservers.set(key, clients);
        }
        clients.add(source);
      } else if (sessionId && source && parsed?.command === "unobserve_session") {
        const key = observerKey(resolvedDesktopId, sessionId);
        const clients = pair.terminalObservers.get(key);
        clients?.delete(source);
        if (clients && clients.size > 0) {
          if (idKey) pair.pendingResponses.delete(idKey);
          sendSuccessResponse(source, parsed?.id);
          return;
        }
        if (clients) {
          pair.terminalObservers.delete(key);
        }
      }
      target.send(data);
    } else {
      if (target && target.readyState !== 1) {
        error = "Desktop offline";
      }

      sendErrorResponse(source, parsed?.id, error ?? "Desktop offline");

      if (!parsed) {
        // Not valid JSON or no id — can't send error response
        console.warn(
          `[router] Phone message to offline server for ${userId}, could not parse for error response`
        );
      }
    }
  } else {
    const idKey = messageIdKey(parsed?.id);
    if (parsed?.type === "response" && idKey) {
      const hadPendingResponse = pair.pendingResponses.has(idKey);
      const target = pair.pendingResponses.get(idKey);
      pair.pendingResponses.delete(idKey);
      if (target && target.readyState === 1) {
        target.send(data);
      }
      if (hadPendingResponse) return;
    }

    const sessionId = getSessionIdFromMessage(parsed);
    if (parsed?.type === "event" && sessionId) {
      const key = observerKey(sourceDesktopId ?? undefined, sessionId);
      const observers = pair.terminalObservers.get(key);
      if (observers && observers.size > 0) {
        for (const target of observers) {
          if (target.readyState === 1) {
            target.send(data);
          }
        }
        return;
      }
    }

    for (const target of pair.clients) {
      if (target.readyState === 1) {
        target.send(data);
      }
    }
  }
}

/** Get current connection count (for health/debug). */
export function getConnectionCount(): number {
  return connections.size;
}
