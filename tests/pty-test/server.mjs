import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const PORT = Number(process.env.PTY_TEST_PORT ?? 3487);
const ROOT = new URL(".", import.meta.url).pathname;
const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
const sessions = new Map();

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function broadcast(session, data) {
  for (const client of session.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function spawnSession(sessionId, executable, args, cwd) {
  if (sessions.has(sessionId)) {
    throw new Error(`session already exists: ${sessionId}`);
  }

  const child = pty.spawn(executable, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      TERM_PROGRAM: "xterm",
    },
  });

  const session = { pty: child, clients: new Set() };

  child.onData((data) => {
    broadcast(session, Buffer.from(data, "utf8"));
  });

  child.onExit(({ exitCode, signal }) => {
    broadcast(session, JSON.stringify({ type: "exit", sessionId, code: exitCode, signal }));
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function modulePath(urlPath) {
  const candidate = resolve(ROOT, urlPath.slice(1));
  if (!candidate.startsWith(resolve(ROOT))) return null;
  if (!existsSync(candidate)) return null;
  return candidate;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/spawn") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        spawnSession(parsed.sessionId, parsed.executable, parsed.args, parsed.cwd ?? process.cwd());
        sendJson(res, 200, { ok: true, sessionId: parsed.sessionId });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/kill") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const session = getSession(parsed.sessionId);
        if (!session) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        session.pty.kill();
        sessions.delete(parsed.sessionId);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }

  if (url.pathname.startsWith("/node_modules/")) {
    const filePath = modulePath(url.pathname);
    if (!filePath) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": filePath.endsWith(".css") ? "text/css" : "application/javascript",
    });
    res.end(readFileSync(filePath));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  socket.sessionId = url.searchParams.get("session") ?? undefined;

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const sessionId = message.sessionId ?? socket.sessionId;
    const session = sessionId ? getSession(sessionId) : undefined;

    if (message.type === "attach") {
      if (!sessionId || !session) {
        socket.send(JSON.stringify({ type: "error", message: `session not found: ${sessionId}` }));
        return;
      }
      socket.sessionId = sessionId;
      session.clients.add(socket);
      session.pty.resize(message.cols ?? 120, message.rows ?? 36);
      socket.send(JSON.stringify({ type: "attached", sessionId }));
      return;
    }

    if (!sessionId || !session) {
      socket.send(JSON.stringify({ type: "error", message: `session not found: ${sessionId}` }));
      return;
    }

    if (message.type === "input") {
      session.pty.write(Buffer.from(message.data).toString("utf8"));
      return;
    }

    if (message.type === "resize") {
      session.pty.resize(message.cols, message.rows);
      return;
    }

    if (message.type === "detach") {
      session.clients.delete(socket);
      socket.send(JSON.stringify({ type: "detached", sessionId }));
    }
  });

  socket.on("close", () => {
    if (!socket.sessionId) return;
    const session = getSession(socket.sessionId);
    session?.clients.delete(socket);
  });
});

server.listen(PORT, () => {
  console.log(`pty-test listening on http://localhost:${PORT}`);
});
