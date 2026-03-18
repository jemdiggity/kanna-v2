/**
 * Minimal WebSocket proxy: bridges browser xterm.js ↔ daemon Unix socket.
 *
 * Run: bun run tests/pty-test/server.ts
 * Open: http://localhost:3456
 */

import { serve } from "bun";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createConnection } from "net";

const DAEMON_SOCK = `${process.env.HOME}/Library/Application Support/Kanna/daemon.sock`;
const PORT = 3456;

const html = readFileSync(resolve(import.meta.dir, "test.html"), "utf-8");

const server = serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  },
  websocket: {
    open(ws) {
      console.log("[ws] client connected");

      // Connect to daemon
      const daemon = createConnection(DAEMON_SOCK);
      let buffer = "";

      daemon.on("connect", () => {
        console.log("[daemon] connected");
        (ws as any)._daemon = daemon;
      });

      daemon.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "Output") {
              // Send raw bytes to browser
              const bytes = new Uint8Array(event.data);
              ws.send(bytes);
            } else if (event.type === "Exit") {
              ws.send(JSON.stringify({ type: "exit", code: event.code }));
            } else {
              ws.send(JSON.stringify(event));
            }
          } catch {
            // Not JSON
          }
        }
      });

      daemon.on("error", (err) => {
        console.error("[daemon] error:", err.message);
        ws.close();
      });

      daemon.on("close", () => {
        console.log("[daemon] disconnected");
        ws.close();
      });
    },

    message(ws, message) {
      const daemon = (ws as any)._daemon;
      if (!daemon) return;

      if (typeof message === "string") {
        // Control message from browser (spawn, attach, input commands)
        daemon.write(message + "\n");
      } else {
        // Binary data — raw key input from xterm.js
        // Wrap as daemon Input command
        const bytes = Array.from(new Uint8Array(message as ArrayBuffer));
        const cmd = JSON.stringify({ type: "Input", session_id: (ws as any)._sessionId, data: bytes });
        daemon.write(cmd + "\n");
      }
    },

    close(ws) {
      const daemon = (ws as any)._daemon;
      if (daemon) daemon.destroy();
      console.log("[ws] client disconnected");
    },
  },
});

console.log(`PTY test server: http://localhost:${PORT}`);
console.log(`Daemon socket: ${DAEMON_SOCK}`);
