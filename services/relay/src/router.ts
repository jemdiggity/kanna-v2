import type { RawData, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { ServerAuthProof } from "./auth.js";
import {
  identifyByteAccount,
  rawDataByteLength,
  recordBytesReceived,
  recordBytesSent,
  relayMessageByteClass,
  type RelayByteClass,
} from "./byteAccounting.js";

interface ConnectionPair {
  clients: Set<WebSocket>;
  desktops: Map<string, WebSocket>;
  pendingTunnels: Map<string, PendingTunnel>;
  pendingResponses: Map<string, WebSocket>;
  terminalObservers: Map<string, Set<WebSocket>>;
}

interface PendingTunnel {
  client: WebSocket;
  desktopId: string;
  service: TunnelService;
  expiry: ReturnType<typeof setTimeout>;
}

export type TunnelService = "ksp" | "task-transfer";

interface RelayMessage {
  type?: unknown;
  id?: unknown;
  desktopId?: unknown;
  command?: unknown;
  args?: unknown;
  name?: unknown;
  payload?: unknown;
  service?: unknown;
}

/** In-memory map of userId → client and desktop WebSocket connections. */
const connections = new Map<string, ConnectionPair>();
const verifiedDesktopIdentities = new WeakMap<WebSocket, string>();
const tunnelPeers = new WeakMap<WebSocket, WebSocket>();
const tunnelLabels = new WeakMap<WebSocket, "client" | "desktop">();
const tunnelServices = new WeakMap<WebSocket, TunnelService>();
const tunnelSockets = new WeakSet<WebSocket>();
const pausedTunnelSources = new WeakSet<WebSocket>();
const tunnelPeakBufferedBytes = new WeakMap<WebSocket, number>();

export const TASK_TRANSFER_TUNNEL_HIGH_WATER_BYTES = 512 * 1024;
export const TASK_TRANSFER_TUNNEL_LOW_WATER_BYTES = 256 * 1024;
export const TASK_TRANSFER_TUNNEL_MAX_BUFFERED_BYTES = 1024 * 1024;
export const TASK_TRANSFER_PENDING_TUNNEL_TIMEOUT_MS = 10_000;

export function pendingTunnelCountForTests(userId: string): number {
  return connections.get(userId)?.pendingTunnels.size ?? 0;
}

export function pendingResponseCountForTests(userId: string): number {
  return connections.get(userId)?.pendingResponses.size ?? 0;
}

export function hasConnectionPairForTests(userId: string): boolean {
  return connections.has(userId);
}

export function taskTransferTunnelFlowStateForTests(ws: WebSocket): {
  paused: boolean;
  peakBufferedBytes: number;
} {
  return {
    paused: pausedTunnelSources.has(ws),
    peakBufferedBytes: tunnelPeakBufferedBytes.get(ws) ?? 0,
  };
}

const backpressuredTunnelSources = new WeakSet<WebSocket>();
const MAX_TUNNEL_BUFFERED_BYTES = 64 * 1024 * 1024;
const TUNNEL_BACKPRESSURE_HIGH_WATER_BYTES = 32 * 1024 * 1024;
const TUNNEL_BACKPRESSURE_LOW_WATER_BYTES = 16 * 1024 * 1024;
const tunnelFlowStats = {
  pauseCount: 0,
  resumeCount: 0,
  capRejectCount: 0,
  maxBufferedBytes: 0,
};

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

/**
 * Send a control-channel frame and add it to the target's byte odometer.
 * `byteLength` is passed by callers that already measured the payload; only
 * relay-generated frames pay for their own measurement, and those are small
 * and infrequent by construction.
 */
function sendControlFrame(
  target: WebSocket,
  payload: string,
  byteLength = Buffer.byteLength(payload),
  byteClass: RelayByteClass = "control",
): void {
  target.send(payload);
  recordBytesSent(target, byteClass, byteLength);
}

export function sendErrorResponse(
  client: WebSocket | undefined,
  id: unknown,
  error: string
): void {
  if (!client || client.readyState !== 1) {
    return;
  }

  sendControlFrame(
    client,
    JSON.stringify({
      type: "response",
      id: id ?? null,
      error,
    })
  );
}

function sendSuccessResponse(client: WebSocket | undefined, id: unknown): void {
  if (id == null || !client || client.readyState !== 1) {
    return;
  }

  sendControlFrame(
    client,
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

  sendControlFrame(
    client,
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

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
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
  sendControlFrame(target, buildUnobserveMessage(observer.sessionId, id));
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

function removePendingTunnel(pair: ConnectionPair, tunnelId: string): PendingTunnel | undefined {
  const tunnel = pair.pendingTunnels.get(tunnelId);
  if (!tunnel) return undefined;
  clearTimeout(tunnel.expiry);
  pair.pendingTunnels.delete(tunnelId);
  return tunnel;
}

function storePendingTunnel(
  pair: ConnectionPair,
  tunnelId: string,
  client: WebSocket,
  desktopId: string,
  service: TunnelService,
): void {
  const expiry = setTimeout(() => {
    const current = pair.pendingTunnels.get(tunnelId);
    if (!current || current.client !== client) return;
    pair.pendingTunnels.delete(tunnelId);
    if (client.readyState <= 1) {
      client.close(4408, "Tunnel setup timed out");
    }
  }, TASK_TRANSFER_PENDING_TUNNEL_TIMEOUT_MS);
  expiry.unref?.();
  pair.pendingTunnels.set(tunnelId, { client, desktopId, service, expiry });
}

function closeTunnelPeer(ws: WebSocket): void {
  const peer = tunnelPeers.get(ws);
  if (pausedTunnelSources.has(ws)) {
    pausedTunnelSources.delete(ws);
    ws.resume();
  }
  tunnelPeers.delete(ws);
  tunnelLabels.delete(ws);
  tunnelServices.delete(ws);
  tunnelPeakBufferedBytes.delete(ws);
  tunnelSockets.delete(ws);
  backpressuredTunnelSources.delete(ws);
  if (peer) {
    if (pausedTunnelSources.has(peer)) {
      pausedTunnelSources.delete(peer);
      peer.resume();
    }
    tunnelPeers.delete(peer);
    tunnelLabels.delete(peer);
    tunnelServices.delete(peer);
    tunnelPeakBufferedBytes.delete(peer);
    tunnelSockets.delete(peer);
    backpressuredTunnelSources.delete(peer);
    if (peer.readyState <= 1) {
      peer.close(1000, "Tunnel peer closed");
    }
  }
}

function failTunnelPair(source: WebSocket, code: number, reason: string): void {
  const peer = tunnelPeers.get(source);
  tunnelPeers.delete(source);
  tunnelLabels.delete(source);
  tunnelSockets.delete(source);
  backpressuredTunnelSources.delete(source);
  if (peer) {
    tunnelPeers.delete(peer);
    tunnelLabels.delete(peer);
    tunnelSockets.delete(peer);
    backpressuredTunnelSources.delete(peer);
  }
  if (source.readyState <= 1) {
    source.close(code, reason);
  }
  if (peer && peer.readyState <= 1) {
    peer.close(code, reason);
  }
}

function newConnectionPair(): ConnectionPair {
  return {
    clients: new Set(),
    desktops: new Map(),
    pendingTunnels: new Map(),
    pendingResponses: new Map(),
    terminalObservers: new Map(),
  };
}

/**
 * Drop the user's pair only once *both* sides are gone.
 *
 * The pair is shared by every phone client and every desktop of one account,
 * so deleting it while any socket is still registered strands those sockets:
 * they stay open (their own close handlers then no-op against the replacement
 * pair) but vanish from `list_active_desktops` and from routing, and they
 * never reconnect because nothing told them anything was wrong.
 */
function deleteConnectionPairIfIdle(userId: string, pair: ConnectionPair): void {
  if (pair.clients.size === 0 && pair.desktops.size === 0) {
    connections.delete(userId);
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
    pair = newConnectionPair();
    connections.set(userId, pair);
  }

  pair.clients.add(ws);
  console.log(`[router] Client connected for ${userId}`);

  ws.on("close", () => {
    console.log(`[router] Client disconnected for ${userId}`);
    const current = connections.get(userId);
    if (current?.clients.has(ws)) {
      removeClient(current, ws);
      for (const [tunnelId, tunnel] of current.pendingTunnels.entries()) {
        if (tunnel.client === ws) {
          removePendingTunnel(current, tunnelId);
        }
      }
      deleteConnectionPairIfIdle(userId, current);
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
  ws: WebSocket,
  serverAuthProof?: ServerAuthProof | null,
): void {
  let pair = connections.get(userId);
  if (!pair) {
    pair = newConnectionPair();
    connections.set(userId, pair);
  }

  const existing = pair.desktops.get(desktopId);
  if (existing && existing !== ws && existing.readyState <= 1) {
    console.log(
      `[router] Closing existing server connection for ${userId}/${desktopId}`
    );
    existing.close(1000, "Replaced by new connection");
  }

  if (
    serverAuthProof?.kind === "desktop"
    && serverAuthProof.desktopId === desktopId
  ) {
    verifiedDesktopIdentities.set(ws, desktopId);
  }

  pair.desktops.set(desktopId, ws);
  console.log(`[router] Server connected for ${userId}/${desktopId}`);

  ws.on("close", () => {
    console.log(`[router] Server disconnected for ${userId}/${desktopId}`);
    const current = connections.get(userId);
    if (!current) return;

    for (const [id, requester] of current.pendingResponses.entries()) {
      if (requester === ws) {
        current.pendingResponses.delete(id);
      }
    }

    if (current.desktops.get(desktopId) === ws) {
      current.desktops.delete(desktopId);
      for (const [tunnelId, tunnel] of current.pendingTunnels.entries()) {
        if (tunnel.desktopId === desktopId) {
          tunnel.client.close(1011, "Desktop disconnected before tunnel opened");
          removePendingTunnel(current, tunnelId);
        }
      }
    }
    deleteConnectionPairIfIdle(userId, current);
  });
}

export function isTunnelSocket(ws: WebSocket): boolean {
  return tunnelSockets.has(ws);
}

export function forwardTunnelData(source: WebSocket, data: RawData, isBinary = false): void {
  const service = tunnelServices.get(source);
  // Measured once, for backpressure and the byte odometer alike. The relay
  // never parses a tunnel frame, so its class is the tunnel's service.
  const byteLength = rawDataByteLength(data);
  const byteClass: RelayByteClass = service === "task-transfer" ? "taskTransfer" : "tunnel";
  recordBytesReceived(source, byteClass, byteLength);
  const peer = tunnelPeers.get(source);
  if (!peer || peer.readyState !== 1) {
    return;
  }
  if (service === "task-transfer" && isBinary) {
    if (peer.bufferedAmount + byteLength > TASK_TRANSFER_TUNNEL_MAX_BUFFERED_BYTES) {
      source.close(1013, "Task-transfer backpressure limit exceeded");
      peer.close(1013, "Task-transfer backpressure limit exceeded");
      return;
    }
    peer.send(data, { binary: true }, (error) => {
      if (error && source.readyState <= 1) {
        source.close(1011, "Task-transfer forwarding failed");
        return;
      }
      if (
        pausedTunnelSources.has(source)
        && peer.bufferedAmount <= TASK_TRANSFER_TUNNEL_LOW_WATER_BYTES
      ) {
        pausedTunnelSources.delete(source);
        source.resume();
      }
    });
    recordBytesSent(peer, byteClass, byteLength);
    tunnelPeakBufferedBytes.set(
      source,
      Math.max(tunnelPeakBufferedBytes.get(source) ?? 0, peer.bufferedAmount),
    );
    if (
      peer.bufferedAmount >= TASK_TRANSFER_TUNNEL_HIGH_WATER_BYTES
      && !pausedTunnelSources.has(source)
    ) {
      pausedTunnelSources.add(source);
      source.pause();
    }
    return;
  }
  if (
    byteLength > MAX_TUNNEL_BUFFERED_BYTES ||
    peer.bufferedAmount > MAX_TUNNEL_BUFFERED_BYTES - byteLength
  ) {
    tunnelFlowStats.capRejectCount += 1;
    failTunnelPair(source, 1013, "Tunnel peer is not consuming data");
    return;
  }
  if (process.env.KANNA_RELAY_DEBUG_TUNNEL === "1") {
    const direction = tunnelLabels.get(source) === "client" ? "client->desktop" : "desktop->client";
    let summary = `<${byteLength} bytes>`;
    try {
      const parsed = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
      summary = typeof parsed.type === "string" ? parsed.type : "json";
      if (typeof parsed.task_id === "string") summary += ` task=${parsed.task_id}`;
      if (typeof parsed.code === "string") summary += ` code=${parsed.code}`;
    } catch {
      // Raw terminal bytes can be binary; keep the byte count summary.
    }
    console.log(`[router] Tunnel ${direction}: ${summary}`);
  }
  try {
    peer.send(data, { binary: isBinary }, (error) => {
      if (error) {
        console.warn(`[router] Tunnel send failed: ${error.message}`);
        failTunnelPair(source, 1011, "Tunnel send failed");
        return;
      }
      if (
        backpressuredTunnelSources.has(source) &&
        tunnelPeers.get(source) === peer &&
        peer.bufferedAmount <= TUNNEL_BACKPRESSURE_LOW_WATER_BYTES
      ) {
        backpressuredTunnelSources.delete(source);
        if (source.readyState === 1) {
          tunnelFlowStats.resumeCount += 1;
          source.resume();
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[router] Tunnel send failed: ${message}`);
    failTunnelPair(source, 1011, "Tunnel send failed");
    return;
  }

  recordBytesSent(peer, byteClass, byteLength);
  tunnelFlowStats.maxBufferedBytes = Math.max(
    tunnelFlowStats.maxBufferedBytes,
    peer.bufferedAmount,
  );
  if (peer.bufferedAmount > MAX_TUNNEL_BUFFERED_BYTES) {
    tunnelFlowStats.capRejectCount += 1;
    failTunnelPair(source, 1013, "Tunnel peer is not consuming data");
    return;
  }
  if (
    peer.bufferedAmount >= TUNNEL_BACKPRESSURE_HIGH_WATER_BYTES &&
    !backpressuredTunnelSources.has(source)
  ) {
    backpressuredTunnelSources.add(source);
    tunnelFlowStats.pauseCount += 1;
    source.pause();
  }
}

export function attachDesktopTunnel(
  userId: string,
  desktopId: string,
  tunnelId: string,
  ws: WebSocket
): boolean {
  const pair = connections.get(userId);
  const tunnel = pair?.pendingTunnels.get(tunnelId);
  if (!pair || !tunnel || tunnel.desktopId !== desktopId) {
    ws.close(4404, "Tunnel not found");
    return false;
  }

  removePendingTunnel(pair, tunnelId);
  tunnelSockets.add(tunnel.client);
  tunnelSockets.add(ws);
  tunnelPeers.set(tunnel.client, ws);
  tunnelPeers.set(ws, tunnel.client);
  tunnelLabels.set(tunnel.client, "client");
  tunnelLabels.set(ws, "desktop");
  tunnelServices.set(tunnel.client, tunnel.service);
  tunnelServices.set(ws, tunnel.service);
  tunnelPeakBufferedBytes.set(tunnel.client, 0);
  tunnelPeakBufferedBytes.set(ws, 0);
  ws.on("close", () => closeTunnelPeer(ws));
  tunnel.client.on("close", () => closeTunnelPeer(tunnel.client));

  identifyByteAccount(ws, {
    uid: userId,
    desktopId,
    role: "server",
    tunnelService: tunnel.service,
  });
  identifyByteAccount(tunnel.client, {
    uid: userId,
    desktopId,
    tunnelService: tunnel.service,
  });

  const ready = JSON.stringify({
    type: "tunnel_ready",
    tunnelId,
    desktopId,
    service: tunnel.service,
  });
  const readyBytes = Buffer.byteLength(ready);
  sendControlFrame(ws, ready, readyBytes);
  sendControlFrame(tunnel.client, ready, readyBytes);
  return true;
}

/**
 * Route a message from one side to the other.
 *
 * - If phone sends to an offline server: parse JSON and return an error response.
 * - An authenticated desktop may address another desktop owned by the same
 *   user. Responses return only to the requesting socket.
 * - If server sends an unsolicited event with no phone: silently drop it.
 */
export function routeMessage(
  userId: string,
  from: "phone" | "server",
  data: string,
  source?: WebSocket,
  sourceDesktopId?: string | null,
  serverAuthProof?: ServerAuthProof | null,
  /**
   * Byte length of `data` as it arrived on the wire. The caller already
   * measured the frame; passing it here keeps the byte odometer from
   * measuring the same payload twice.
   */
  dataByteLength = Buffer.byteLength(data),
): void {
  const pair = connections.get(userId);
  if (!pair) return;
  const parsed = parseRelayMessage(data);
  const byteClass = relayMessageByteClass(parsed);

  if (from === "phone") {
    if (parsed?.type === "tunnel_request") {
      const id = parsed.id;
      const service = parsed.service === undefined
        ? "ksp"
        : parsed.service === "ksp" || parsed.service === "task-transfer"
          ? parsed.service
          : null;
      if (!service) {
        sendErrorResponse(source, id, "Unsupported tunnel service");
        return;
      }
      const desktopId =
        typeof parsed.desktopId === "string" ? parsed.desktopId : undefined;
      const target = desktopId ? pair.desktops.get(desktopId) : undefined;
      if (!desktopId || !target || target.readyState !== 1) {
        sendErrorResponse(source, id, "Desktop offline");
        return;
      }
      if (!source || source.readyState !== 1) {
        return;
      }

      const tunnelId = randomUUID();
      storePendingTunnel(pair, tunnelId, source, desktopId, service);
      tunnelSockets.add(source);
      identifyByteAccount(source, { uid: userId, desktopId, tunnelService: service });
      sendControlFrame(
        target,
        JSON.stringify({
          type: "tunnel_establish",
          id,
          desktopId,
          tunnelId,
          service,
        })
      );
      return;
    }

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
      sendControlFrame(target, data, dataByteLength, byteClass);
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
        sendControlFrame(target, data, dataByteLength, byteClass);
      }
      if (hadPendingResponse) return;
    }

    if (parsed?.type === "invoke") {
      // A legacy device token proves only account membership. Desktop-to-desktop
      // routing requires the desktop-scoped credential that bound this socket
      // to its claimed desktop ID.
      if (
        serverAuthProof?.kind !== "desktop"
        || serverAuthProof.desktopId !== sourceDesktopId
      ) {
        sendErrorResponse(source, parsed.id, "desktop-secret authentication is required");
        return;
      }
      if (parsed.command === "list_active_desktops") {
        sendDataResponse(source, parsed.id, {
          desktopIds: Array.from(pair.desktops.entries())
            .filter(([, ws]) => ws.readyState === 1)
            .map(([desktopId]) => desktopId),
        });
        return;
      }

      const desktopId =
        typeof parsed.desktopId === "string" ? parsed.desktopId : undefined;
      if (!desktopId) {
        sendErrorResponse(source, parsed.id, "desktopId required for desktop-to-desktop request");
        return;
      }
      const target = pair.desktops.get(desktopId);
      if (!target || target.readyState !== 1) {
        sendErrorResponse(source, parsed.id, "Desktop offline");
        return;
      }
      if (verifiedDesktopIdentities.get(target) !== desktopId) {
        sendErrorResponse(
          source,
          parsed.id,
          "target desktop-secret authentication is required",
        );
        return;
      }
      if (idKey && source) {
        pair.pendingResponses.set(idKey, source);
      }
      sendControlFrame(target, data, dataByteLength, byteClass);
      return;
    }

    const sessionId = getSessionIdFromMessage(parsed);
    if (parsed?.type === "event" && sessionId) {
      const key = observerKey(sourceDesktopId ?? undefined, sessionId);
      const observers = pair.terminalObservers.get(key);
      if (observers && observers.size > 0) {
        for (const target of observers) {
          if (target.readyState === 1) {
            sendControlFrame(target, data, dataByteLength, byteClass);
          }
        }
        return;
      }
    }

    for (const target of pair.clients) {
      if (target.readyState === 1) {
        sendControlFrame(target, data, dataByteLength, byteClass);
      }
    }
  }
}

/** Get current connection count (for health/debug). */
export function getConnectionCount(): number {
  return connections.size;
}

export function getTunnelFlowStats(): Readonly<typeof tunnelFlowStats> {
  return { ...tunnelFlowStats };
}
