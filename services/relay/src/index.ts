import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyPhoneToken, verifyDeviceToken, registerDevice } from "./auth.js";
import {
  setPhoneConnection,
  setServerConnection,
  routeMessage,
  getConnectionCount,
} from "./router.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const AUTH_TIMEOUT_MS = 10_000;

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
    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, {
        status: "ok",
        connections: getConnectionCount(),
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

  // 10-second auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      console.warn(`[ws] Auth timeout for ${remoteAddr}`);
      ws.close(4001, "Auth timeout");
    }
  }, AUTH_TIMEOUT_MS);

  ws.on("message", async (raw: Buffer | string) => {
    const data = typeof raw === "string" ? raw : raw.toString();

    // --- Auth handshake (first message) ---
    if (!authenticated) {
      let msg: {
        type?: string;
        id_token?: string;
        device_token?: string;
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
      } else if (msg.device_token) {
        // Server (kanna-server) auth
        userId = await verifyDeviceToken(msg.device_token);
        role = "server";
      } else {
        ws.close(4004, "Missing id_token or device_token");
        clearTimeout(authTimer);
        return;
      }

      if (!userId) {
        ws.close(4005, "Authentication failed");
        clearTimeout(authTimer);
        return;
      }

      authenticated = true;
      clearTimeout(authTimer);

      // Register the connection with the router
      if (role === "phone") {
        setPhoneConnection(userId, ws);
      } else {
        setServerConnection(userId, ws);
      }

      // Send auth success
      ws.send(JSON.stringify({ type: "auth_ok", userId }));
      console.log(
        `[ws] Authenticated ${role} for user ${userId} from ${remoteAddr}`
      );
      return;
    }

    // --- Post-auth: route messages ---
    routeMessage(userId!, role!, data);
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
    `[relay] SKIP_AUTH=${process.env.SKIP_AUTH === "true" ? "true" : "false"}`
  );
});
