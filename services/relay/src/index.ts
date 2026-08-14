import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  verifyPhoneToken,
  verifyDeviceToken,
  verifyDesktopCredentials,
  revalidateServerAuth,
  registerDevice,
  registerPushDevice,
  unregisterPushDevice,
  type ServerAuthProof,
} from "./auth.js";
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
import {
  beginCloudTaskPublicationSession,
  endCloudTaskPublicationSession,
  handleCloudTaskPublication,
  MAX_TASK_SNAPSHOT_BYTES,
} from "./cloudTaskPublication.js";
import {
  parseMobileNotification,
  publishMobileNotification,
  type MobileNotificationDelivery,
} from "./mobileNotifications.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const AUTH_TIMEOUT_MS = 10_000;
const E2E_SHUTDOWN_TOKEN =
  process.env.KANNA_E2E_RELAY_SHUTDOWN_TOKEN?.trim() || null;

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

const server = createServer(async (req, res) => {
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
        connections: getConnectionCount(),
        tunnelFlow: getTunnelFlowStats(),
      });
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

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const remoteAddr = req.socket.remoteAddress ?? "unknown";
  console.log(`[ws] New connection from ${remoteAddr}`);

  let authenticated = false;
  let userId: string | null = null;
  let role: "phone" | "server" | null = null;
  let desktopId: string | null = null;
  let serverAuthProof: ServerAuthProof | null = null;
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

  ws.on("message", async (raw: RawData, isBinary: boolean) => {
    // --- Auth handshake (first message) ---
    if (!authenticated) {
      const data = raw.toString();
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
        userId = await verifyPhoneToken(msg.id_token);
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

      if (role === "server" && desktopId && msg.tunnel_id) {
        authenticated = true;
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
      clearTimeout(authTimer);

      // Register the connection with the router
      if (role === "phone") {
        setPhoneConnection(userId, ws);
      } else {
        setServerConnection(userId, desktopId ?? "default", ws, serverAuthProof);
      }

      // Send auth success
      ws.send(JSON.stringify({
        type: "auth_ok",
        userId,
        capabilities: {
          tunnelServices: ["ksp", "task-transfer"],
          ...(serverAuthProof?.kind === "desktop" ? {
            taskSnapshotPublication: {
              version: 2,
              authModes: ["desktop-secret"],
            },
            mobileNotifications: {
              version: 1,
            },
            desktopRouting: {
              version: 1,
            },
          } : {}),
        },
      }));
      console.log(
        `[ws] Authenticated ${role} for user ${userId} from ${remoteAddr}`
      );
      return;
    }

    // --- Post-auth: route messages ---
    if (isTunnelSocket(ws)) {
      forwardTunnelData(ws, raw, isBinary);
      return;
    }
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
      }
      if (publication?.type === "mobile_notification_publish") {
        const id = typeof publication.id === "string" ? publication.id : "";
        const sendAck = (
          ok: boolean,
          delivery?: MobileNotificationDelivery,
          error?: string
        ) => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: "mobile_notification_ack",
            id,
            ok,
            ...(delivery ? { delivery } : {}),
            ...(error ? { error } : {}),
          }));
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
        const sendAck = (ok: boolean, error?: string) => {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: "task_snapshot_ack",
            id,
            ok,
            ...(error ? { error } : {}),
          }));
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
        try {
          await handleCloudTaskPublication({
            userId: userId!,
            desktopId,
            generation,
            snapshot: publication.snapshot,
          });
          sendAck(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[cloud] Task snapshot publication rejected for ${userId}/${desktopId}: ${message}`);
          sendAck(false, message);
        }
        return;
      }
    }
    routeMessage(userId!, role!, data, ws, desktopId, serverAuthProof);
  });

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(authTimer);
    console.log(
      `[ws] Connection closed: ${remoteAddr} (code=${code}, reason=${reason.toString()})`
    );
  });

  ws.on("error", (err: Error) => {
    console.error(`[ws] Error from ${remoteAddr}:`, err.message);
  });
});

// --- Start ---

server.listen(PORT, () => {
  console.log(`[relay] Listening on port ${PORT}`);
  console.log(
    `[relay] Firebase project=${process.env.FIREBASE_PROJECT_ID?.trim() || "(default)"}`
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal} received; closing connections`);
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

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
