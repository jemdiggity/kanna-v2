// Manual cutover smoke: authenticate as a phone-role client against the
// production relay and invoke a real kanna-server command through it.
// Usage: node test/relay-roundtrip-smoke.mjs <idTokenFile> [desktopId]
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const RELAY_URL = process.env.KANNA_RELAY_URL ?? "wss://relay.kanna.build";
const idToken = readFileSync(process.argv[2], "utf8").trim();
const desktopId = process.argv[3] ?? "";

const ws = new WebSocket(RELAY_URL);
const deadline = setTimeout(() => {
  console.error("TIMEOUT waiting for roundtrip");
  process.exit(2);
}, 20_000);

ws.on("open", () => {
  console.log("[smoke] connected, sending auth");
  ws.send(JSON.stringify({ type: "auth", id_token: idToken }));
  const invoke = {
    type: "invoke",
    id: "smoke-1",
    command: "list_repos",
    args: {},
  };
  if (desktopId) invoke.desktopId = desktopId;
  setTimeout(() => {
    console.log("[smoke] sending invoke list_repos");
    ws.send(JSON.stringify(invoke));
  }, 500);
});

ws.on("message", (raw) => {
  const text = raw.toString();
  console.log("[smoke] received:", text.length > 400 ? `${text.slice(0, 400)}…` : text);
  try {
    const msg = JSON.parse(text);
    if (msg.type === "response" && msg.id === "smoke-1") {
      console.log("[smoke] ROUNDTRIP OK");
      clearTimeout(deadline);
      ws.close();
      process.exit(0);
    }
  } catch {
    // non-JSON frame; keep listening
  }
});

ws.on("close", (code, reason) => {
  console.error(`[smoke] closed: code=${code} reason=${reason.toString()}`);
});
ws.on("error", (err) => {
  console.error("[smoke] error:", err.message);
});
