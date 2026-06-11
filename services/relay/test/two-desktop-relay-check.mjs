// Manual two-desktop check against the deployed relay.
//
// Boots TWO real kanna-server sidecar binaries with desktop-credential
// configs (the same shape mobile.rs writes), registers their secret hashes
// on a disposable Firebase user's users/{uid}/desktops docs, and verifies a
// phone-side client sees both desktops via list_active_desktops.
//
// Usage (from repo root, after `./kd build sidecars`):
//   KANNA_FIREBASE_API_KEY=<web api key> node services/relay/test/two-desktop-relay-check.mjs
// Optional: KANNA_RELAY_SMOKE_URL (default wss://relay.kanna.build),
//           KANNA_FIREBASE_PROJECT_ID (default kanna-build).
//
// Credentials come from env only. The disposable auth user, Firestore docs,
// server processes, and temp dirs are all cleaned up on exit.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = process.env.KANNA_FIREBASE_API_KEY;
const RELAY_URL = process.env.KANNA_RELAY_SMOKE_URL || "wss://relay.kanna.build";
const PROJECT = process.env.KANNA_FIREBASE_PROJECT_ID || "kanna-build";
const SERVER_BIN = "apps/desktop/src-tauri/binaries/kanna-server-aarch64-apple-darwin";
if (!API_KEY) throw new Error("KANNA_FIREBASE_API_KEY required");

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

async function jsonOrThrow(res, msg) {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${msg}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function signUp() {
  const email = `kanna-two-desktop-${randomBytes(6).toString("hex")}@kanna-smoke.invalid`;
  const password = randomBytes(16).toString("hex");
  const body = await jsonOrThrow(await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }) },
  ), "signUp failed");
  return { idToken: body.idToken, uid: body.localId };
}

async function createDesktopDoc(idToken, uid, desktopId, secret) {
  const body = await jsonOrThrow(await fetch(`${FS}/users/${uid}/desktops`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      desktopId: { stringValue: desktopId },
      displayName: { stringValue: `Two-desktop check ${desktopId}` },
      desktopSecretHash: { stringValue: createHash("sha256").update(secret).digest("hex") },
      revokedAt: { nullValue: null },
      updatedAt: { stringValue: new Date().toISOString() },
    } }),
  }), `create desktops doc ${desktopId} failed`);
  return body.name.split("/documents/")[1];
}

async function deleteDoc(idToken, path) {
  await fetch(`${FS}/${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${idToken}` } });
}

function startServer(root, desktopId, secret, lanPort) {
  const dir = mkdtempSync(join(tmpdir(), `kanna-two-desktop-${desktopId}-`));
  execFileSync("sqlite3", [join(dir, "kanna.db"), "PRAGMA user_version = 1;"]);
  const configPath = join(dir, "server.toml");
  writeFileSync(configPath, [
    `relay_url = "${RELAY_URL}"`,
    `device_token = "unused-${desktopId}"`,
    `daemon_dir = "${dir}"`,
    `db_path = "${join(dir, "kanna.db")}"`,
    `desktop_id = "${desktopId}"`,
    `desktop_secret = "${secret}"`,
    `desktop_name = "Two-desktop check ${desktopId}"`,
    `lan_host = "127.0.0.1"`,
    `lan_port = ${lanPort}`,
    `pairing_store_path = "${join(dir, "pairings.json")}"`,
    "",
  ].join("\n"));
  const child = spawn(join(root, SERVER_BIN), [], {
    env: { ...process.env, KANNA_SERVER_CONFIG: configPath, RUST_LOG: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${desktopId}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${desktopId}] ${d}`));
  return { child, dir };
}

function phoneListDesktops(idToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error("phone check timed out")); }, 20_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", id_token: idToken })));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ type: "invoke", id: "list-1", command: "list_active_desktops", args: {} }));
      } else if (msg.type === "response" && msg.id === "list-1") {
        clearTimeout(timer);
        ws.close(1000);
        resolve(msg.data?.desktopIds ?? []);
      }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error(`phone ws error: ${e.message}`)); });
  });
}

const root = process.cwd();
const { idToken, uid } = await signUp();
console.log(`disposable uid: ${uid}`);
const desktops = [
  { id: `desktop-${randomBytes(4).toString("hex")}-aaaa`, secret: randomBytes(32).toString("hex"), port: 48181 },
  { id: `desktop-${randomBytes(4).toString("hex")}-bbbb`, secret: randomBytes(32).toString("hex"), port: 48182 },
];
const docPaths = [];
const procs = [];
try {
  for (const d of desktops) docPaths.push(await createDesktopDoc(idToken, uid, d.id, d.secret));
  for (const d of desktops) procs.push(startServer(root, d.id, d.secret, d.port));

  // wait for both servers to authenticate, then ask the relay what it sees
  await new Promise((r) => setTimeout(r, 6000));
  const ids = await phoneListDesktops(idToken);
  console.log("relay-visible desktops:", JSON.stringify(ids));
  const allOnline = desktops.every((d) => ids.includes(d.id));
  console.log(allOnline
    ? "RESULT: PASS — both real kanna-server instances authenticated to the deployed relay"
    : "RESULT: FAIL — expected both desktop ids online");
  process.exitCode = allOnline ? 0 : 1;
} finally {
  for (const p of procs) { p.child.kill("SIGTERM"); }
  for (const path of docPaths) await deleteDoc(idToken, path).catch(() => undefined);
  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  }).catch(() => undefined);
  for (const p of procs) rmSync(p.dir, { recursive: true, force: true });
  console.log("cleanup done (servers killed, docs + disposable user deleted)");
}
