import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  verifyPhoneToken,
  verifyPhoneIdentity,
  verifyDeviceToken,
  verifyDesktopCredentials,
  revalidateServerAuth,
  registerDevice,
  registerPushDevice,
  unregisterPushDevice,
  type ServerAuthProof,
} from "./auth.js";
import {
  ENTITLEMENT_REQUIRED_CODE,
  ENTITLEMENT_REQUIRED_ERROR,
  entitlementEnforcementEnabled,
  resolveSessionEntitlement,
  sessionHasCapability,
  type CloudAccessCapability,
  type EntitlementSubject,
} from "./entitlement.js";
import {
  attachDesktopTunnel,
  forwardTunnelData,
  setPhoneConnection,
  setServerConnection,
  routeMessage,
  sendErrorResponse,
  getConnectionCount,
  getTunnelFlowStats,
  isTunnelSocket,
} from "./router.js";
import { handleOtaRequest } from "./ota.js";
import { RELAY_PER_MESSAGE_DEFLATE } from "./webSocketCompression.js";
import {
  attachUpgradeAdmission,
  clientAddressForRequest,
  createUpgradeAdmission,
  resolveMaxPayloadBytes,
  resolveUpgradeAdmissionOptions,
} from "./webSocketLimits.js";
import { resolveBuildCommit } from "./buildInfo.js";
import {
  beginCloudTaskPublicationSession,
  createFirestoreCloudTaskPublicationStore,
  endCloudTaskPublicationSession,
  handleCloudTaskPublication,
  MAX_TASK_SNAPSHOT_BYTES,
} from "./cloudTaskPublication.js";
import {
  parseMobileNotification,
  publishMobileNotification,
  type MobileNotificationDelivery,
} from "./mobileNotifications.js";
import {
  attachWebSocketMessageHandler,
} from "./webSocketMessageLifecycle.js";
import {
  closeByteAccount,
  identifyByteAccount,
  openByteAccount,
  rawDataByteLength,
  recordBytesReceived,
  recordBytesSent,
  relayMessageByteClass,
  startByteRollups,
  stopByteRollups,
} from "./byteAccounting.js";
import {
  buildRelayStatsPayload,
  matchesStatsToken,
  resolveStatsToken,
  statsRequestToken,
  type RelayStatsAudience,
} from "./relayStatus.js";
import { RELAY_STATUS_DASHBOARD_HTML } from "./statusDashboardPage.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const BUILD_COMMIT = resolveBuildCommit(process.env);
const AUTH_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = resolveMaxPayloadBytes();
const E2E_SHUTDOWN_TOKEN =
  process.env.KANNA_E2E_RELAY_SHUTDOWN_TOKEN?.trim() || null;
/**
 * The operator credential for `/stats` and `/dashboard`. Null on a relay
 * deployed without it, which leaves `/stats` behaving exactly as it did before
 * the dashboard landed and `/dashboard` unavailable.
 */
const STATS_TOKEN = resolveStatsToken();
const cloudTaskPublicationStore = createFirestoreCloudTaskPublicationStore();

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * Identify a phone frame the entitlement gate has something to say about, and
 * name the capability it needs.
 *
 * Two frame types qualify, and between them they are every unit of remote value
 * a phone can ask the relay for: `tunnel_request` opens a tunnel
 * (`cloud_relay`), and `invoke` drives the desktop from the phone
 * (`remote_task_control`) — the owner's 2026-08-21 ruling that everything
 * crossing the relay is paid. Anything else a phone sends is a response or an
 * event on a conversation one of these already started.
 *
 * The router parses the same frame again on its way through, which is one
 * wasted parse per gated request in exchange for the entitlement check not
 * reaching into the router's routing logic at all.
 */
function parseGatedPhoneRequest(
  data: string,
): { id: unknown; capability: CloudAccessCapability } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const message = parsed as { type?: unknown; id?: unknown };
  if (message.type === "tunnel_request") {
    return { id: message.id, capability: "cloud_relay" };
  }
  if (message.type === "invoke") {
    return { id: message.id, capability: "remote_task_control" };
  }
  return null;
}

/**
 * What a status request's credential may see, or null when it presented none
 * the relay accepts.
 *
 * The operator token is checked first, so a relay running with one never pays a
 * Firebase round trip for the operator's own polling.
 */
async function authorizeStatsRequest(
  req: IncomingMessage,
): Promise<RelayStatsAudience | null> {
  const presented = statsRequestToken(req);
  if (!presented) return null;
  if (STATS_TOKEN && matchesStatsToken(presented, STATS_TOKEN)) return "operator";
  return await verifyPhoneToken(presented) ? "account" : null;
}

/**
 * Mark a status response uncacheable and unreferrable. Both matter because the
 * dashboard URL carries the token: `no-store` keeps it out of the browser's
 * disk cache and `no-referrer` keeps it out of anything the page links to.
 */
function noStore(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * Send a JSON response.
 */
function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// --- HTTP server ---

export const server = createServer(async (req, res) => {
  try {
    if (
      E2E_SHUTDOWN_TOKEN &&
      req.method === "POST" &&
      req.url === "/__kanna_e2e_shutdown" &&
      req.headers["x-kanna-e2e-shutdown-token"] === E2E_SHUTDOWN_TOKEN
    ) {
      res.writeHead(204).end();
      setImmediate(() => shutdown("E2E shutdown"));
      return;
    }

    if (await handleOtaRequest(req, res)) {
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        commit: BUILD_COMMIT,
        connections: getConnectionCount(),
        tunnelFlow: getTunnelFlowStats(),
      });
      return;
    }

    // Relay status. Never public, and two credentials with two visibilities:
    // a Firebase ID token reads process aggregates only, exactly as it always
    // has, while the operator token additionally reads the per-connection rows
    // the dashboard shows. See relayStatus.ts.
    const statusPath = new URL(req.url ?? "/", "http://relay.invalid").pathname;

    if (req.method === "GET" && statusPath === "/stats") {
      noStore(res);
      const audience = await authorizeStatsRequest(req);
      if (!audience) {
        res.setHeader("WWW-Authenticate", "Bearer");
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      jsonResponse(res, 200, buildRelayStatsPayload({
        commit: BUILD_COMMIT,
        upgrades: upgradeAdmission.stats(),
        audience,
      }));
      return;
    }

    // The status dashboard: one self-contained page that polls /stats. It shows
    // uid and desktop id, so only the operator credential opens it — a valid
    // Firebase ID token is not enough.
    if (req.method === "GET" && statusPath === "/dashboard") {
      noStore(res);
      if (!STATS_TOKEN) {
        // Configuration state, not user data. Answering 401 here would send the
        // operator hunting for a credential that no value could satisfy.
        jsonResponse(res, 503, {
          error: "Relay status dashboard is disabled: KANNA_RELAY_STATS_TOKEN is not set",
        });
        return;
      }
      if (await authorizeStatsRequest(req) !== "operator") {
        res.setHeader("WWW-Authenticate", "Bearer");
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(RELAY_STATUS_DASHBOARD_HTML),
      });
      res.end(RELAY_STATUS_DASHBOARD_HTML);
      return;
    }

    if (req.method === "POST" && req.url === "/register") {
      const body = await readBody(req);
      let parsed: { idToken?: string; deviceToken?: string };

      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!parsed.idToken || !parsed.deviceToken) {
        jsonResponse(res, 400, {
          error: "Missing idToken or deviceToken",
        });
        return;
      }

      const userId = await verifyPhoneToken(parsed.idToken);
      if (!userId) {
        jsonResponse(res, 401, { error: "Invalid token" });
        return;
      }

      await registerDevice(userId, parsed.deviceToken);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/push/register") {
      const body = await readBody(req);
      let parsed: { idToken?: string; deviceId?: string; deviceToken?: string };

      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!parsed.idToken || !parsed.deviceId || !parsed.deviceToken) {
        jsonResponse(res, 400, {
          error: "Missing idToken, deviceId, or deviceToken",
        });
        return;
      }
      if (parsed.deviceId.length > 256 || parsed.deviceToken.length > 4_096) {
        jsonResponse(res, 400, { error: "Push registration is oversized" });
        return;
      }

      const userId = await verifyPhoneToken(parsed.idToken);
      if (!userId) {
        jsonResponse(res, 401, { error: "Invalid token" });
        return;
      }

      await registerPushDevice(userId, parsed.deviceId, parsed.deviceToken);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/push/unregister") {
      const body = await readBody(req);
      let parsed: { idToken?: string; deviceId?: string };

      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!parsed.idToken || !parsed.deviceId) {
        jsonResponse(res, 400, { error: "Missing idToken or deviceId" });
        return;
      }
      if (parsed.deviceId.length > 256) {
        jsonResponse(res, 400, { error: "Push unregistration is oversized" });
        return;
      }

      const userId = await verifyPhoneToken(parsed.idToken);
      if (!userId) {
        jsonResponse(res, 401, { error: "Invalid token" });
        return;
      }

      await unregisterPushDevice(userId, parsed.deviceId);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // 404 for everything else
    jsonResponse(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[http] Unhandled error:", err);
    jsonResponse(res, 500, { error: "Internal server error" });
  }
});

// --- WebSocket server ---

// Terminal frames are the relay's dominant traffic and compress well; see
// webSocketCompression.ts for the bounds and for which clients negotiate.
//
// The byte odometer is unaffected: `ws` hands the message handler decompressed
// payloads and compresses on the way out, so both sides keep counting
// application bytes, which is the right unit for per-user metering.
//
// The router's tunnel watermarks *do* change meaning, and correctly so: they
// read `bufferedAmount`, which counts the bytes actually held — compressed,
// once a frame is on the socket. The memory bound they enforce stays exact,
// but compressible traffic now moves much further before a source is paused.
//
// `noServer` rather than `{ server }`: the relay has to decide whether to admit
// an upgrade *before* `ws` allocates a socket for it, and that decision needs
// the request headers (see `clientAddressForRequest`). `ws` in `server` mode
// installs its own `upgrade` listener and offers no hook that runs first.
export const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: RELAY_PER_MESSAGE_DEFLATE,
  // Bounds the *decompressed* size of an inbound message, which is what makes
  // `perMessageDeflate` safe to leave on for unauthenticated callers. See
  // webSocketLimits.ts for the derivation and the operator override.
  maxPayload: MAX_PAYLOAD_BYTES,
});

export const upgradeAdmission = createUpgradeAdmission(
  resolveUpgradeAdmissionOptions(),
);

attachUpgradeAdmission({
  server,
  wss,
  admission: upgradeAdmission,
  onRefused: (address, reason) => {
    console.warn(`[ws] Refused upgrade from ${address}: ${reason}`);
  },
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const clientAddress = clientAddressForRequest(req);
  const remoteAddr = req.socket.remoteAddress ?? "unknown";
  console.log(`[ws] New connection from ${clientAddress} (peer ${remoteAddr})`);
  openByteAccount(ws);

  // Held from the upgrade until this socket proves who it is, or gives up.
  let preAuthSlotHeld = true;
  const releasePreAuthSlot = (): void => {
    if (!preAuthSlotHeld) return;
    preAuthSlotHeld = false;
    upgradeAdmission.release(clientAddress);
  };

  let authenticated = false;
  let userId: string | null = null;
  let role: "phone" | "server" | null = null;
  let desktopId: string | null = null;
  let serverAuthProof: ServerAuthProof | null = null;
  // Null until the handshake resolves an identity. Every entitlement check the
  // session makes afterwards goes through it, so a phone token's
  // `email_verified` claim keeps applying to later requests, not just to auth.
  let entitlementSubject: EntitlementSubject | null = null;
  let publicationSessionGeneration: number | null = null;
  let nextPublicationSequence = 1;

  ws.on("close", () => {
    if (
      role !== "server"
      || !userId
      || !desktopId
      || publicationSessionGeneration === null
    ) {
      return;
    }
    void endCloudTaskPublicationSession({
      userId,
      desktopId,
      generation: publicationSessionGeneration,
      store: cloudTaskPublicationStore,
    }).catch((error) => {
      console.warn(
        `[cloud] Failed to end task publication session for ${userId}/${desktopId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  // 10-second auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      console.warn(`[ws] Auth timeout for ${remoteAddr}`);
      ws.close(4001, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  attachWebSocketMessageHandler(ws, remoteAddr, async (
    raw: RawData,
    isBinary: boolean,
    messageLifecycle,
  ) => {
    // Tunnel frames are the relay's hot path. forwardTunnelData already
    // measures every frame for backpressure and feeds that same measurement
    // to the byte odometer, so they are never measured again here.
    if (isTunnelSocket(ws)) {
      forwardTunnelData(ws, raw, isBinary);
      return;
    }
    const receivedByteLength = rawDataByteLength(raw);

    // --- Auth handshake (first message) ---
    if (!authenticated) {
      recordBytesReceived(ws, "control", receivedByteLength);
      const data = raw.toString();
      // The phone token's `email_verified` claim; null for desktop credential
      // sessions, which carry no token and so make no claim.
      let phoneEmailVerified: boolean | null = null;
      let msg: {
        type?: string;
        id_token?: string;
        device_token?: string;
        desktop_id?: string;
        desktop_secret?: string;
        tunnel_id?: string;
      };

      try {
        msg = JSON.parse(data);
      } catch {
        ws.close(4002, "Invalid JSON");
        clearTimeout(authTimer);
        return;
      }

      if (msg.type !== "auth") {
        ws.close(4003, "First message must be auth");
        clearTimeout(authTimer);
        return;
      }

      if (msg.id_token) {
        // Phone client auth
        const principal = await verifyPhoneIdentity(msg.id_token);
        userId = principal?.userId ?? null;
        phoneEmailVerified = principal?.emailVerified ?? null;
        role = "phone";
      } else if (msg.desktop_id && msg.desktop_secret) {
        const principal = await verifyDesktopCredentials(
          msg.desktop_id,
          msg.desktop_secret
        );
        userId = principal?.userId ?? null;
        desktopId = principal?.desktopId ?? null;
        serverAuthProof = principal ? {
          kind: "desktop",
          desktopId: msg.desktop_id,
          desktopSecret: msg.desktop_secret,
        } : null;
        role = "server";
      } else if (msg.device_token) {
        // Server (kanna-server) auth
        userId = await verifyDeviceToken(msg.device_token);
        desktopId = msg.desktop_id ?? msg.device_token;
        serverAuthProof = {
          kind: "device",
          desktopId,
          deviceToken: msg.device_token,
        };
        role = "server";
      } else {
        ws.close(4004, "Missing id_token, device_token, or desktop credentials");
        clearTimeout(authTimer);
        return;
      }

      if (!userId) {
        ws.close(4005, "Authentication failed");
        clearTimeout(authTimer);
        return;
      }

      // Identity is settled; entitlement is the next question
      // (`docs/specs/accounts-and-billing.md`, Decision 5). Both session kinds
      // resolve to a uid, so both are enforced. With the flag off this resolves
      // to an unrestricted session without reading anything.
      entitlementSubject = { userId, emailVerified: phoneEmailVerified };
      const sessionEntitlement = await resolveSessionEntitlement(entitlementSubject);

      if (role === "server" && desktopId && msg.tunnel_id) {
        // A tunnel socket carries the payload the phone's `tunnel_request`
        // already had to be entitled to ask for. Refusing it here as well is
        // what makes the tunnel closed rather than merely unadvertised.
        if (!sessionEntitlement.grants("cloud_relay")) {
          clearTimeout(authTimer);
          ws.close(ENTITLEMENT_REQUIRED_CODE, ENTITLEMENT_REQUIRED_ERROR);
          return;
        }
        authenticated = true;
        releasePreAuthSlot();
        clearTimeout(authTimer);
        attachDesktopTunnel(userId, desktopId, msg.tunnel_id, ws);
        console.log(
          `[ws] Authenticated tunnel socket for ${userId}/${desktopId} from ${remoteAddr}`
        );
        return;
      }

      if (role === "server" && desktopId && serverAuthProof?.kind === "desktop") {
        try {
          if (!await revalidateServerAuth(serverAuthProof, userId, desktopId)) {
            clearTimeout(authTimer);
            ws.close(4005, "Authentication revoked");
            return;
          }
          publicationSessionGeneration = await beginCloudTaskPublicationSession({
            userId,
            desktopId,
            store: cloudTaskPublicationStore,
          });
          nextPublicationSequence = 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[cloud] Failed to lease task publication generation for ${userId}/${desktopId}: ${message}`,
          );
          clearTimeout(authTimer);
          ws.close(1011, "Cloud publication initialization failed");
          return;
        }
      }

      authenticated = true;
      releasePreAuthSlot();
      clearTimeout(authTimer);

      // Register the connection with the router
      if (role === "phone") {
        setPhoneConnection(userId, ws);
      } else {
        setServerConnection(userId, desktopId ?? "default", ws, serverAuthProof);
      }
      identifyByteAccount(ws, {
        uid: userId,
        desktopId: role === "server" ? desktopId ?? "default" : null,
        role,
      });

      // Send auth success. An unentitled session still gets `auth_ok` — it is
      // authenticated, and closing it would be the generic connection error
      // Decision 5 exists to avoid — but the relay advertises only what it will
      // actually serve, so the capability block narrows instead. With
      // enforcement off every `grants` call answers true and this frame is
      // byte-identical to the pre-enforcement relay, `entitlement` included:
      // the field is absent, not false.
      const authOk = JSON.stringify({
        type: "auth_ok",
        userId,
        capabilities: {
          tunnelServices: sessionEntitlement.grants("cloud_relay")
            ? ["ksp", "task-transfer"]
            : [],
          ...(serverAuthProof?.kind === "desktop" ? {
            ...(sessionEntitlement.grants("cloud_task_index") ? {
              taskSnapshotPublication: {
                version: 2,
                authModes: ["desktop-secret"],
              },
            } : {}),
            ...(sessionEntitlement.grants("cloud_relay") ? {
              mobileNotifications: {
                version: 1,
              },
            } : {}),
            ...(sessionEntitlement.grants("remote_task_control") ? {
              desktopRouting: {
                version: 1,
              },
            } : {}),
          } : {}),
        },
        ...(sessionEntitlement.snapshot
          ? { entitlement: sessionEntitlement.snapshot }
          : {}),
      });
      ws.send(authOk);
      recordBytesSent(ws, "control", Buffer.byteLength(authOk));
      console.log(
        `[ws] Authenticated ${role} for user ${userId} from ${remoteAddr}`
      );
      return;
    }

    // --- Post-auth: route messages ---
    const data = raw.toString();
    if (role === "server") {
      let publication: {
        type?: unknown;
        id?: unknown;
        snapshot?: unknown;
        notification?: unknown;
      } | null = null;
      try {
        publication = JSON.parse(data) as {
          type?: unknown;
          id?: unknown;
          snapshot?: unknown;
          notification?: unknown;
        };
      } catch {
        // Non-publication messages retain the router's existing behavior.
      }
      // That parse already identified the message, so the odometer classifies
      // it without a second one.
      recordBytesReceived(ws, relayMessageByteClass(publication), receivedByteLength);
      if (
        publication?.type === "invoke"
        && serverAuthProof?.kind === "desktop"
      ) {
        if (
          !desktopId
          || !await revalidateServerAuth(serverAuthProof, userId!, desktopId)
        ) {
          sendErrorResponse(
            ws,
            publication.id,
            "desktop credential is no longer authorized",
          );
          ws.close(4005, "Authentication revoked");
          return;
        }
        // Desktop-to-desktop routing is remote control that crosses the relay,
        // so it is paid for by the same capability as the phone's `invoke`
        // (owner ruling, 2026-08-21). Re-resolved per request, which is what
        // bounds a revocation by the cache TTL rather than by the next
        // reconnect. The session itself is never closed over an entitlement.
        if (!await sessionHasCapability(entitlementSubject!, "remote_task_control")) {
          sendErrorResponse(
            ws,
            publication.id,
            ENTITLEMENT_REQUIRED_ERROR,
            ENTITLEMENT_REQUIRED_CODE,
          );
          return;
        }
      }
      if (publication?.type === "mobile_notification_publish") {
        const id = typeof publication.id === "string" ? publication.id : "";
        const sendAck = (
          ok: boolean,
          delivery?: MobileNotificationDelivery,
          error?: string,
          code?: number
        ) => {
          messageLifecycle.sendMobileNotificationAck({
            type: "mobile_notification_ack",
            id,
            ok,
            ...(delivery ? { delivery } : {}),
            ...(error ? { error } : {}),
            ...(code === undefined ? {} : { code }),
          });
        };
        if (serverAuthProof?.kind !== "desktop") {
          sendAck(false, undefined, "desktop-secret authentication is required");
          return;
        }
        if (!id || !desktopId || Buffer.byteLength(data) > 16_384) {
          sendAck(false, undefined, "mobile notification is malformed or oversized");
          return;
        }
        if (!await revalidateServerAuth(serverAuthProof, userId!, desktopId)) {
          sendAck(false, undefined, "desktop credential is no longer authorized");
          ws.close(4005, "Authentication revoked");
          return;
        }
        // Push is part of cloud access, so it stops when the entitlement does.
        // Re-resolved per notification rather than reused from the handshake,
        // which is what bounds revocation by the cache TTL instead of by the
        // desktop's next reconnect.
        if (!await sessionHasCapability(entitlementSubject!, "cloud_relay")) {
          sendAck(false, undefined, ENTITLEMENT_REQUIRED_ERROR, ENTITLEMENT_REQUIRED_CODE);
          return;
        }
        let notification;
        try {
          notification = parseMobileNotification(publication.notification);
        } catch {
          sendAck(false, undefined, "mobile notification is malformed or oversized");
          return;
        }
        await publishMobileNotification({
          userId: userId!,
          desktopId,
          notification,
          sendAck: ({ ok, delivery, error }) => sendAck(ok, delivery, error),
        });
        return;
      }
      if (publication?.type === "task_snapshot_publish") {
        const id = typeof publication.id === "string" ? publication.id : "";
        const generation = publicationSessionGeneration === null
          ? null
          : {
              session: publicationSessionGeneration,
              sequence: nextPublicationSequence++,
            };
        const sendAck = (ok: boolean, error?: string, code?: number) => {
          messageLifecycle.sendTaskSnapshotAck({
            type: "task_snapshot_ack",
            id,
            ok,
            ...(error ? { error } : {}),
            ...(code === undefined ? {} : { code }),
          });
        };
        if (serverAuthProof?.kind !== "desktop") {
          sendAck(false, "desktop-secret authentication is required for task snapshot publication");
          return;
        }
        if (
          !id
          || !generation
          || Buffer.byteLength(data) > MAX_TASK_SNAPSHOT_BYTES + 16_384
        ) {
          sendAck(false, "task snapshot publication is malformed or oversized");
          return;
        }
        if (!desktopId || !await revalidateServerAuth(
          serverAuthProof,
          userId!,
          desktopId,
        )) {
          sendAck(false, "desktop credential is no longer authorized");
          ws.close(4005, "Authentication revoked");
          return;
        }
        // The cloud task index is the paid surface here: publication stops and
        // the index goes stale, but nothing already published is deleted, so it
        // comes back on renewal (Decision 5).
        if (!await sessionHasCapability(entitlementSubject!, "cloud_task_index")) {
          sendAck(false, ENTITLEMENT_REQUIRED_ERROR, ENTITLEMENT_REQUIRED_CODE);
          return;
        }
        try {
          await handleCloudTaskPublication({
            userId: userId!,
            desktopId,
            generation,
            snapshot: publication.snapshot,
            store: cloudTaskPublicationStore,
          });
          sendAck(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[cloud] Task snapshot publication rejected for ${userId}/${desktopId}: ${message}`);
          sendAck(false, message);
        }
        return;
      }
    } else {
      // Phone clients only ever send control-plane requests.
      recordBytesReceived(ws, "control", receivedByteLength);
      // Everything a phone asks the relay to do is remote value, and remote
      // value is what the subscription buys (owner ruling, 2026-08-21): a
      // tunnel needs `cloud_relay`, an `invoke` needs `remote_task_control`.
      // The parse happens only while enforcement is on, which is what keeps the
      // flag-off path byte-for-byte and read-for-read what it was.
      if (entitlementEnforcementEnabled()) {
        const request = parseGatedPhoneRequest(data);
        if (
          request
          && !await sessionHasCapability(entitlementSubject!, request.capability)
        ) {
          sendErrorResponse(
            ws,
            request.id,
            ENTITLEMENT_REQUIRED_ERROR,
            ENTITLEMENT_REQUIRED_CODE,
          );
          return;
        }
      }
    }
    routeMessage(
      userId!,
      role!,
      data,
      ws,
      desktopId,
      serverAuthProof,
      receivedByteLength,
    );
  });

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(authTimer);
    // A socket that never authenticated still holds its pre-auth slot; this is
    // the only place a refused, timed-out, or abandoned upgrade gives it back.
    releasePreAuthSlot();
    closeByteAccount(ws);
    console.log(
      `[ws] Connection closed: ${remoteAddr} (code=${code}, reason=${reason.toString()})`
    );
  });

  ws.on("error", (err: Error) => {
    // Oversize closes get their own line because they are the one relay error
    // an operator has to act on: two frame classes are producer-unbounded (see
    // webSocketLimits.ts), so a real user hitting the cap is possible, and the
    // fix is to raise KANNA_RELAY_MAX_PAYLOAD_BYTES on the VM. Anything less
    // greppable than this would leave that failure looking like a flaky socket.
    if ((err as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
      console.error(
        `[ws] Oversize frame from ${clientAddress} (authenticated=${authenticated}, `
        + `role=${role ?? "unknown"}, maxPayload=${MAX_PAYLOAD_BYTES}); closing that `
        + `connection only. Raise KANNA_RELAY_MAX_PAYLOAD_BYTES if this is legitimate traffic.`
      );
      return;
    }
    console.error(`[ws] Error from ${remoteAddr}:`, err.message);
  });
});

// --- Start ---

export function startRelay(port = PORT, host?: string): void {
  startByteRollups();
  const onListening = () => {
    console.log(`[relay] Listening on port ${port}`);
    console.log(
      `[relay] Firebase project=${process.env.FIREBASE_PROJECT_ID?.trim() || "(default)"}`
    );
  };
  if (host) {
    server.listen(port, host, onListening);
  } else {
    server.listen(port, onListening);
  }
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal} received; closing connections`);
  stopByteRollups();
  server.close();
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1012, "Relay restarting");
    }
  }
  wss.close(() => process.exit(0));
  setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    process.exit(0);
  }, 4_000).unref();
}

const isEntrypoint =
  typeof process.argv[1] === "string"
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  startRelay();
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
