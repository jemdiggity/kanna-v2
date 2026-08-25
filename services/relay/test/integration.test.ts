import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import WebSocket from "ws";
import {
  deleteAccount,
  firestoreAccountDeletionStore,
  type AccountDeletionStore,
} from "../../firebase-functions/src/accountDeletion.js";
import {
  beginCloudTaskPublicationSession,
  createFirestoreCloudTaskPublicationStore,
  handleCloudTaskPublication,
} from "../src/cloudTaskPublication.js";
import {
  anonymousDesktopId,
  garbageCollectAnonymousPushPairings,
  reconcileInvalidAnonymousPushToken,
  registerAnonymousPushPairing,
  type AnonymousPushPairingRequest,
} from "../src/anonymousPush.js";

const TEST_EMAIL = "upvote.sieve.7t@icloud.com";
const TEST_PASSWORD = "password123";
const OTHER_TEST_EMAIL = "relay.other.7t@example.com";
const OTHER_TEST_PASSWORD = "password123";
const TEST_DEVICE_TOKEN = "e2e-token";
const TEST_USER_ID = "Bax9TJvOWm5bbl0Aq4nXg3XmkTCu";
const SECRET_DESKTOP_ID = "desktop-secret-auth";
const SECRET_DESKTOP_SECRET = "desktop-secret-for-relay";
const ROUTING_TARGET_DESKTOP_ID = "desktop-secret-routing-target";
const ROUTING_TARGET_DESKTOP_SECRET = "desktop-secret-routing-target-secret";
const E2E_SHUTDOWN_TOKEN = "relay-integration-shutdown-capability";
const ANONYMOUS_PUSH_CAPTURE_COLLECTION = "e2eAnonymousPushDeliveries";
/**
 * The relay caches a successful desktop-credential validation for this long,
 * so a revocation lands on an already-open socket only once it expires.
 */
const DESKTOP_CREDENTIAL_CACHE_TTL_MS = 250;

/**
 * The per-IP pre-auth cap this suite runs the relay with, via
 * `KANNA_RELAY_MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP`.
 *
 * Lowered from the shipped 8 so the cases below can reach the cap in a handful
 * of sockets instead of a dozen — and, because the relay reads it from the
 * environment, exercising `resolveUpgradeAdmissionOptions` at the same time.
 *
 * 4 rather than 1 or 2 on purpose: this whole file shares one relay process,
 * and a few of its cases deliberately hold a socket that never authenticates
 * (the auth-timeout case holds exactly one for the full 10 s window). Those
 * hold at most one slot at a time, so 4 leaves three of headroom while still
 * being small enough to test cheaply.
 */
const MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP = 4;

/** Wait out the credential cache, so the next revalidation reaches Firestore. */
async function expireDesktopCredentialCache(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, DESKTOP_CREDENTIAL_CACHE_TTL_MS + 100));
}
let relayPort = 0;

function relayUrl(): string {
  return `ws://localhost:${relayPort}`;
}

function healthUrl(): string {
  return `http://localhost:${relayPort}/health`;
}

function relayHttpUrl(path: string): string {
  return `http://localhost:${relayPort}${path}`;
}

/** Everything the relay has written to stdout since it was spawned. */
let relayStdout = "";
/**
 * The same for stderr. The relay's refusal and oversize lines are
 * `console.warn`/`console.error`, which Node writes to stderr, so a test that
 * only reads stdout cannot see them.
 */
let relayStderr = "";

/**
 * A mark in both relay streams. Each stream is append-only but they grow
 * independently, so one offset into their concatenation would slide as the
 * other grew and could re-expose output from an earlier case.
 */
interface RelayLogMark {
  stdout: number;
  stderr: number;
}

function markRelayLog(): RelayLogMark {
  return { stdout: relayStdout.length, stderr: relayStderr.length };
}

/**
 * Everything the relay has written since `mark`, on either stream — for
 * assertions that should not care which one a given line lands on.
 */
function relayLogSince(mark: RelayLogMark): string {
  return `${relayStdout.slice(mark.stdout)}\n${relayStderr.slice(mark.stderr)}`;
}

interface RelayByteLogLine {
  event: string;
  connectionId: number;
  uid: string | null;
  desktopId: string | null;
  role: string;
  tunnelService: string | null;
  durationMs: number;
  received: Record<string, number>;
  sent: Record<string, number>;
  receivedTotal: number;
  sentTotal: number;
  totalBytes: number;
}

interface RelayByteStatsBody {
  status: string;
  bytes: {
    uptimeMs: number;
    connections: { open: number; opened: number; closed: number };
    received: Record<string, number>;
    sent: Record<string, number>;
    totalBytes: number;
  };
}

const BYTE_LOG_PREFIX = "[bytes] ";

function relayByteLogLines(): RelayByteLogLine[] {
  const lines: RelayByteLogLine[] = [];
  for (const line of relayStdout.split("\n")) {
    const start = line.indexOf(BYTE_LOG_PREFIX);
    if (start < 0) continue;
    try {
      lines.push(JSON.parse(line.slice(start + BYTE_LOG_PREFIX.length)) as RelayByteLogLine);
    } catch {
      // A stdout chunk boundary can split a line; the next poll sees it whole.
    }
  }
  return lines;
}

async function waitForByteLogLine(
  predicate: (line: RelayByteLogLine) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<RelayByteLogLine> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = relayByteLogLines().find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`relay never logged ${description}`);
}

async function fetchRelayByteStats(token: string): Promise<RelayByteStatsBody> {
  const response = await fetch(relayHttpUrl("/stats"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`relay /stats failed: ${response.status}`);
  }
  return await response.json() as RelayByteStatsBody;
}

interface RelayTunnelFlowHealth {
  pauseCount: number;
  resumeCount: number;
  capRejectCount: number;
  maxBufferedBytes: number;
}

async function relayTunnelFlowHealth(): Promise<RelayTunnelFlowHealth> {
  const response = await fetch(healthUrl());
  const body = await response.json() as {
    tunnelFlow?: RelayTunnelFlowHealth;
  };
  if (!response.ok || !body.tunnelFlow) {
    throw new Error(`relay health omitted tunnel flow metrics: ${JSON.stringify(body)}`);
  }
  return body.tunnelFlow;
}

/**
 * Helper: wait for the relay's /health endpoint to respond 200.
 * Polls every 200ms for up to `timeoutMs`.
 *
 * A liveness wait on a freshly spawned process, not a startup budget: the
 * default is deliberately generous so a box running several suites at once
 * cannot turn a slow start into a failure.
 */
async function waitForRelay(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(healthUrl());
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Relay did not become ready within ${timeoutMs}ms`);
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function signInToAuthEmulator(
  authPort: number,
  email: string,
  password: string,
): Promise<string | null> {
  const signInUrl = `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
  const response = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  }).catch(() => null);
  const body = await response?.json().catch(() => null) as { idToken?: string } | null;
  return response?.ok && body?.idToken ? body.idToken : null;
}

async function waitForAuthEmulator(authPort: number, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await signInToAuthEmulator(authPort, TEST_EMAIL, TEST_PASSWORD);
    if (token) return token;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Firebase auth emulator did not become ready on ${authPort}`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (!resolve) throw new Error("failed to create deferred promise");
  return { promise, resolve };
}

function publishedTask(activity: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localRepoId: "repo-cloud-publish",
    ownerDesktopId: SECRET_DESKTOP_ID,
    ownerLocalTaskId: "task-cloud-publish",
    title: "Server cloud publication",
    promptSnippet: "Server cloud publication",
    waitingPromptSnippet: "Ready for review",
    displayName: null,
    stage: "in progress",
    activity,
    status: "active",
    repo: {
      cloudRepoId: "repo-cloud-publish",
      name: "Kanna",
      remoteUrl: "git@github.com:kanna/kanna.git",
      remoteUrlHash: "remote-hash",
      defaultBranch: "main",
    },
    branch: "task-cloud-publish",
    baseRef: "origin/main",
    prNumber: null,
    prUrl: null,
    agent: { provider: "codex", type: "pty" },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds: [],
    createdAt: "2026-07-14 00:00:00",
    updatedAt: activity === "working" ? "2026-07-14 00:02:00" : "2026-07-14 00:01:00",
    closedAt: null,
    ...overrides,
  };
}

function publishedSnapshot(activity: string, tasks = [publishedTask(activity)]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    desktop: { displayName: "Studio Mac" },
    tasks,
  };
}

function maximumLegalCompanionChunkFrames(bundleCount = 3): string[] {
  // Incompressible on purpose, and freshly random per chunk. The relay
  // negotiates `permessage-deflate`, and its tunnel watermarks measure
  // `bufferedAmount` — which counts the bytes actually held, i.e. compressed
  // ones once a frame is on the socket. A repetitive filler (or one buffer
  // reused across chunks, which deflate's cross-message context would match)
  // shrinks away to nothing and never reaches the 32 MiB pause mark, so this
  // test would silently stop exercising the cap it exists to bound. Real
  // companion payloads are images and fonts, which do not compress either, so
  // this is also the more faithful worst case.
  // 72 KiB of entropy is exactly 96 KiB of base64, the chunk size the desktop
  // actually sends (`COMPANION_SNAPSHOT_CHUNK_DATA_BYTES`).
  const chunkBytes = 72 * 1024;
  const chunksPerBundle = Math.ceil((23 * 1024 * 1024) / (chunkBytes * 4 / 3));
  return Array.from({ length: bundleCount }, (_, bundleIndex) =>
    Array.from({ length: chunksPerBundle }, (_, index) => JSON.stringify({
      type: "companion_snapshot_chunk",
      task_id: "task-maximum-companion",
      transfer_id: `session-maximum-companion:revision-${bundleIndex}`,
      index,
      count: chunksPerBundle,
      data: randomBytes(chunkBytes).toString("base64"),
    }))
  ).flat();
}

async function seedRelayDesktopCredentials(firestorePort: number): Promise<void> {
  const previousHost = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${firestorePort}`;
  let app: App | undefined;
  try {
    app = initializeApp({ projectId: "kanna-local" }, `relay-integration-${firestorePort}`);
    await getFirestore(app)
      .doc(`desktopCredentials/${SECRET_DESKTOP_ID}`)
      .set({
        desktopId: SECRET_DESKTOP_ID,
        desktopSecretHash: sha256Hex(SECRET_DESKTOP_SECRET),
        displayName: "Studio Mac",
        revokedAt: null,
        uid: TEST_USER_ID,
        updatedAt: new Date(0).toISOString(),
      });
  } finally {
    if (app) await deleteApp(app);
    if (previousHost === undefined) {
      delete process.env.FIRESTORE_EMULATOR_HOST;
    } else {
      process.env.FIRESTORE_EMULATOR_HOST = previousHost;
    }
  }
}

function firebaseUserId(idToken: string): string {
  const payload = JSON.parse(
    Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as { user_id?: unknown };
  if (typeof payload.user_id !== "string" || !payload.user_id) {
    throw new Error("Firebase ID token is missing user_id");
  }
  return payload.user_id;
}

function firestoreDocumentUrl(firestorePort: number, path: string): string {
  return `http://127.0.0.1:${firestorePort}/v1/projects/kanna-local/databases/(default)/documents/${path}`;
}

async function writeCanonicalCredentialAs(input: {
  firestorePort: number;
  idToken: string;
  uid: string;
  revokedAt?: string | null;
}): Promise<Response> {
  return fetch(
    firestoreDocumentUrl(input.firestorePort, `desktopCredentials/${SECRET_DESKTOP_ID}`),
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          desktopId: { stringValue: SECRET_DESKTOP_ID },
          desktopSecretHash: { stringValue: sha256Hex(SECRET_DESKTOP_SECRET) },
          displayName: { stringValue: "Studio Mac" },
          revokedAt: input.revokedAt == null
            ? { nullValue: null }
            : { stringValue: input.revokedAt },
          uid: { stringValue: input.uid },
          updatedAt: { stringValue: new Date().toISOString() },
        },
      }),
    },
  );
}

/**
 * Helper: open a WebSocket, authenticate, and resolve when auth_ok is received.
 * Returns { ws, userId } from the auth_ok message.
 */
function connectAndAuth(
  authPayload: Record<string, unknown>
): Promise<{ ws: WebSocket; userId: string; capabilities: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Auth timed out"));
    }, 5_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...authPayload }));
    });
    const handler = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth_ok") {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve({
          ws,
          userId: msg.userId,
          capabilities: msg.capabilities as Record<string, unknown>,
        });
      }
    };
    ws.on("message", handler);
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface AnonymousPushTestIdentity {
  publicKey: string;
  privateKey: KeyObject;
}

interface AnonymousPushTestCertificate {
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

function createAnonymousPushIdentity(): AnonymousPushTestIdentity {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: Buffer.from(spki).subarray(-32).toString("base64url"),
    privateKey: pair.privateKey,
  };
}

function createAnonymousPushCertificate(
  identity: AnonymousPushTestIdentity,
  deviceId: string,
  issuedAt = Date.now() - 1_000,
): AnonymousPushTestCertificate {
  const expiresAt = issuedAt + 730 * 24 * 60 * 60_000;
  const payload = Buffer.concat([
    Buffer.from("kanna.push-pairing-cert.v1\0", "utf8"),
    Buffer.from(JSON.stringify({ deviceId, issuedAt, expiresAt }), "utf8"),
  ]);
  return {
    deviceId,
    issuedAt,
    expiresAt,
    signature: sign(null, payload, identity.privateKey).toString("base64url"),
  };
}

function anonymousPairingBody(
  identity: AnonymousPushTestIdentity,
  cert: AnonymousPushTestCertificate,
  fcmToken: string,
): AnonymousPushPairingRequest {
  return {
    desktopPubKey: identity.publicKey,
    deviceId: cert.deviceId,
    fcmToken,
    cert,
  };
}

function connectAndAuthAnonymous(
  identity: AnonymousPushTestIdentity,
): Promise<{ ws: WebSocket; capabilities: Record<string, unknown> }> {
  return new Promise((resolveConnection, reject) => {
    const ws = new WebSocket(relayUrl());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Anonymous auth timed out"));
    }, 5_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", anon_pub_key: identity.publicKey }));
    });
    ws.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth_challenge" && typeof message.nonce === "string") {
        const payload = Buffer.concat([
          Buffer.from("kanna.relay-auth.v1\0", "utf8"),
          Buffer.from(message.nonce, "base64url"),
        ]);
        ws.send(JSON.stringify({
          type: "auth_proof",
          signature: sign(null, payload, identity.privateKey).toString("base64url"),
        }));
      } else if (message.type === "auth_ok") {
        clearTimeout(timeout);
        resolveConnection({
          ws,
          capabilities: message.capabilities as Record<string, unknown>,
        });
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Open a socket and stop at the upgrade: no auth frame is ever sent, so the
 * connection holds its pre-auth admission slot until it closes or times out.
 */
function openWithoutAuth(): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const ws = new WebSocket(relayUrl());
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Upgrade timed out"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolveSocket(ws);
    });
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      ws.terminate();
      reject(new Error(`Upgrade refused with ${response.statusCode}`));
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** Open a socket expecting the relay to refuse the upgrade, and report its status. */
function openExpectingUpgradeRefusal(): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const ws = new WebSocket(relayUrl());
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Expected upgrade refusal timed out"));
    }, 5_000);
    // `ws` surfaces a non-101 upgrade response as `unexpected-response`, and
    // only emits `error` instead when nothing is listening for it.
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      ws.terminate();
      resolveStatus(response.statusCode ?? 0);
    });
    ws.once("open", () => {
      clearTimeout(timeout);
      ws.terminate();
      reject(new Error("Upgrade was admitted"));
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** Wait for the relay to log `needle` on either stream after `mark`. */
async function waitForRelayLog(
  mark: RelayLogMark,
  needle: string,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relayLogSince(mark).includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`relay never logged ${description}`);
}

function connectAndExpectClose(
  authPayload: Record<string, unknown>,
  expectedCode: number,
  timeoutMs = 5_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Expected close ${expectedCode} timed out`));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", ...authPayload }));
    });
    ws.on("close", (code: number) => {
      clearTimeout(timeout);
      try {
        expect(code).toBe(expectedCode);
        resolve(code);
      } catch (error) {
        reject(error);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Helper: wait for the next message on a WebSocket that matches a predicate.
 */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("waitForMessage timed out"));
    }, timeoutMs);

    const handler = (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function waitForRawMessage(
  ws: WebSocket,
  predicate: (data: Buffer, isBinary: boolean) => boolean,
  timeoutMs = 5_000
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("waitForRawMessage timed out"));
    }, timeoutMs);

    const handler = (raw: Buffer, isBinary: boolean) => {
      if (predicate(raw, isBinary)) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve({ data: raw, isBinary });
      }
    };
    ws.on("message", handler);
  });
}

function waitForMessages(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  count: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      reject(new Error(`waitForMessages timed out after ${messages.length}/${count}`));
    }, timeoutMs);

    const handler = (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      messages.push(msg);
      if (messages.length === count) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

async function requestActiveDesktopIds(
  phone: WebSocket,
  id: string,
): Promise<string[]> {
  phone.send(
    JSON.stringify({
      type: "invoke",
      id,
      command: "list_active_desktops",
      args: {},
    }),
  );

  const response = await waitForMessage(
    phone,
    (msg) => msg.type === "response" && msg.id === id,
  );
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("list_active_desktops returned invalid data");
  }
  const desktopIds = (data as Record<string, unknown>).desktopIds;
  if (!Array.isArray(desktopIds) || !desktopIds.every((value) => typeof value === "string")) {
    throw new Error("list_active_desktops returned invalid desktopIds");
  }
  return desktopIds;
}

/**
 * Helper: close a WebSocket and wait for the close event.
 */
function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState >= WebSocket.CLOSING) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.close();
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams | null,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already exited.
      }
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      process.kill(-child.pid!, signal);
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

describe("Relay integration", () => {
  let firebaseProcess: ChildProcessWithoutNullStreams | null = null;
  let firebaseConfigDir: string | null = null;
  let authPort = 0;
  let firestorePort = 0;
  let firestoreWebsocketPort = 0;
  let firebaseHubPort = 0;
  let firebaseLoggingPort = 0;
  let idToken = "";
  let otherIdToken = "";
  let relayProcess: ChildProcessWithoutNullStreams | null = null;
  let testFirestoreApp: App | null = null;
  let testFirestore: ReturnType<typeof getFirestore>;

  beforeAll(async () => {
    relayPort = await findFreePort();
    authPort = await findFreePort();
    firestorePort = await findFreePort();
    firestoreWebsocketPort = await findFreePort();
    firebaseHubPort = await findFreePort();
    firebaseLoggingPort = await findFreePort();
    firebaseConfigDir = await mkdtemp(join(tmpdir(), "kanna-relay-firebase-"));
    const firebaseConfigPath = join(firebaseConfigDir, "firebase.json");
    await writeFile(
      firebaseConfigPath,
      JSON.stringify({
        firestore: { rules: resolve(fileURLToPath(new URL("../../../firestore.rules", import.meta.url))) },
        emulators: {
          auth: { host: "127.0.0.1", port: authPort },
          firestore: {
            host: "127.0.0.1",
            port: firestorePort,
            websocketPort: firestoreWebsocketPort,
          },
          hub: { host: "127.0.0.1", port: firebaseHubPort },
          logging: { host: "127.0.0.1", port: firebaseLoggingPort },
          ui: { enabled: false },
        },
      }),
    );
    firebaseProcess = spawn("pnpm", [
      "exec",
      "firebase",
      "emulators:start",
      "--project",
      "kanna-local",
      "--config",
      firebaseConfigPath,
      "--import",
      resolve(fileURLToPath(new URL("../../firebase/emulator-seed", import.meta.url))),
    ], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env },
      detached: true,
      stdio: "pipe",
    });
    firebaseProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[firebase] ${chunk.toString()}`);
    });
    // Firebase is intentionally quiet on success, but its inherited stdout pipe
    // still needs a reader or a busy full-suite run can back-pressure startup.
    let firebaseStdout = "";
    firebaseProcess.stdout?.on("data", (chunk: Buffer) => {
      firebaseStdout += chunk.toString();
    });
    idToken = await Promise.race([
      waitForAuthEmulator(authPort),
      new Promise<never>((_resolve, reject) => {
        firebaseProcess?.once("exit", (code) => {
          reject(new Error(
            `Firebase emulator exited during startup (${code}): ${firebaseStdout}`,
          ));
        });
      }),
    ]);
    otherIdToken = await signInToAuthEmulator(authPort, OTHER_TEST_EMAIL, OTHER_TEST_PASSWORD) ?? "";
    if (!otherIdToken) throw new Error("Second seeded auth user is unavailable");
    await seedRelayDesktopCredentials(firestorePort);
    process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${firestorePort}`;
    testFirestoreApp = initializeApp({ projectId: "kanna-local" }, `relay-suite-${firestorePort}`);
    testFirestore = getFirestore(testFirestoreApp);

    relayProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        FIREBASE_PROJECT_ID: "kanna-local",
        FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
        PORT: String(relayPort),
        KANNA_E2E_RELAY_SHUTDOWN_TOKEN: E2E_SHUTDOWN_TOKEN,
        // Short enough that the byte-odometer test sees a periodic rollup for
        // a still-open connection instead of waiting an hour for one.
        KANNA_RELAY_BYTE_ROLLUP_INTERVAL_MS: "1000",
        // The desktop-credential cache bounds how long a revoked credential
        // is still honoured on an already-open socket. Short enough that the
        // revocation tests below can observe the bound instead of waiting the
        // production minute for it.
        KANNA_RELAY_DESKTOP_CREDENTIAL_CACHE_TTL_MS: String(
          DESKTOP_CREDENTIAL_CACHE_TTL_MS,
        ),
        // The per-IP pre-auth cap, lowered so the admission cases below reach
        // it in a handful of sockets. See the constant for why this value.
        KANNA_RELAY_MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP: String(
          MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP,
        ),
        KANNA_E2E_ANON_PUSH_CAPTURE_COLLECTION: ANONYMOUS_PUSH_CAPTURE_COLLECTION,
        KANNA_ANON_PUSH_DESKTOP_PER_MINUTE: "2",
        KANNA_ANON_PUSH_TOKEN_PER_MINUTE: "2",
      },
      detached: true,
      stdio: "pipe",
    });

    // Log relay stderr for debugging test failures, and keep it for the tests
    // that assert on a `console.warn` line the relay emits.
    relayStderr = "";
    relayProcess.stderr?.on("data", (chunk: Buffer) => {
      relayStderr += chunk.toString();
      process.stderr.write(`[relay] ${chunk.toString()}`);
    });
    // The byte odometer reports on stdout, and an unread pipe eventually
    // blocks the relay's own logging.
    relayStdout = "";
    relayProcess.stdout?.on("data", (chunk: Buffer) => {
      relayStdout += chunk.toString();
    });

    await waitForRelay();
  }, 90_000);

  afterAll(async () => {
    await terminateProcessTree(relayProcess);
    await terminateProcessTree(firebaseProcess);
    if (testFirestoreApp) await deleteApp(testFirestoreApp);
    delete process.env.FIRESTORE_EMULATOR_HOST;
    if (firebaseConfigDir) await rm(firebaseConfigDir, { recursive: true, force: true });
  });

  it("should authenticate a server with device_token", async () => {
    const { ws, userId } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });
    expect(userId).toMatch(/^[A-Za-z0-9]+$/);
    await closeAndWait(ws);
  });

  it("registers and unregisters authenticated mobile push devices", async () => {
    const deviceId = "relay-integration-push-device";
    const deviceToken = "relay-integration-fcm-token";
    const pushDeviceRef = testFirestore.doc(
      `users/${TEST_USER_ID}/pushDevices/${sha256Hex(deviceId)}`,
    );
    await pushDeviceRef.delete();

    try {
      const invalidRegister = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: "invalid-phone-token",
          deviceId,
          deviceToken,
        }),
      });
      expect(invalidRegister.status).toBe(401);

      const missingRegisterField = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, deviceId }),
      });
      expect(missingRegisterField.status).toBe(400);

      const register = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, deviceId, deviceToken }),
      });
      expect(register.status).toBe(200);
      expect(await register.json()).toEqual({ ok: true });
      expect((await pushDeviceRef.get()).data()).toEqual({
        deviceId,
        token: deviceToken,
        updatedAt: expect.any(String),
      });

      await pushDeviceRef.set(
        { legacyToken: "must-not-survive-replacement" },
        { merge: true },
      );
      const replacementToken = "relay-integration-replacement-fcm-token";
      const replace = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId,
          deviceToken: replacementToken,
        }),
      });
      expect(replace.status).toBe(200);
      expect((await pushDeviceRef.get()).data()).toEqual({
        deviceId,
        token: replacementToken,
        updatedAt: expect.any(String),
      });

      const staleUnregister = await fetch(relayHttpUrl("/push/unregister"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, deviceId, deviceToken }),
      });
      expect(staleUnregister.status).toBe(200);
      expect((await pushDeviceRef.get()).data()?.token).toBe(replacementToken);

      const invalidUnregister = await fetch(relayHttpUrl("/push/unregister"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: "invalid-phone-token",
          deviceId,
        }),
      });
      expect(invalidUnregister.status).toBe(401);
      expect((await pushDeviceRef.get()).exists).toBe(true);

      const missingUnregisterField = await fetch(relayHttpUrl("/push/unregister"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      expect(missingUnregisterField.status).toBe(400);

      const unregister = await fetch(relayHttpUrl("/push/unregister"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId,
          deviceToken: replacementToken,
        }),
      });
      expect(unregister.status).toBe(200);
      expect(await unregister.json()).toEqual({ ok: true });
      expect((await pushDeviceRef.get()).exists).toBe(false);
    } finally {
      await pushDeviceRef.delete();
    }
  });

  it("rejects a same-account legacy device token publishing as another desktop", async () => {
    const desktopRef = testFirestore.doc(
      `users/${TEST_USER_ID}/desktops/${SECRET_DESKTOP_ID}`,
    );
    const before = (await desktopRef.get()).data()?.publicationSessionGeneration ?? null;
    const beforeTaskIds = (await desktopRef.collection("tasks").get()).docs.map((doc) => doc.id).sort();
    const { ws, userId } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: SECRET_DESKTOP_ID,
    });

    expect(userId).toBe(TEST_USER_ID);
    const publicationAck = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "legacy-publish");
    ws.send(JSON.stringify({
      type: "task_snapshot_publish",
      id: "legacy-publish",
      snapshot: publishedSnapshot("working"),
    }));
    await expect(publicationAck).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("desktop-secret"),
    });
    const after = (await desktopRef.get()).data()?.publicationSessionGeneration ?? null;
    expect(after).toBe(before);
    expect((await desktopRef.collection("tasks").get()).docs.map((doc) => doc.id).sort())
      .toEqual(beforeTaskIds);
    await closeAndWait(ws);
  });

  it("rejects sibling invokes to a responder without verified desktop identity", async () => {
    const { ws: requester } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });
    const { ws: unverifiedTarget } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "legacy-sibling-target",
    });

    try {
      const unexpectedInvoke = waitForMessage(
        unverifiedTarget,
        (message) => message.type === "invoke",
        250,
      ).then(
        () => "invoke",
        () => "timeout",
      );
      const rejected = waitForMessage(
        requester,
        (message) => message.type === "response" && message.id === "unverified-target",
      );
      requester.send(JSON.stringify({
        type: "invoke",
        id: "unverified-target",
        desktopId: "legacy-sibling-target",
        method: "GET",
        path: "/v1/tasks/recent",
        body: null,
      }));

      await expect(rejected).resolves.toMatchObject({
        error: "target desktop-secret authentication is required",
      });
      await expect(unexpectedInvoke).resolves.toBe("timeout");
    } finally {
      await closeAndWait(requester);
      await closeAndWait(unverifiedTarget);
    }
  });

  it("stops routing sibling invokes after the requester desktop secret is revoked", async () => {
    const requesterCredentialRef = testFirestore.doc(
      `desktopCredentials/${SECRET_DESKTOP_ID}`,
    );
    const targetCredentialRef = testFirestore.doc(
      `desktopCredentials/${ROUTING_TARGET_DESKTOP_ID}`,
    );
    const targetDesktopRef = testFirestore.doc(
      `users/${TEST_USER_ID}/desktops/${ROUTING_TARGET_DESKTOP_ID}`,
    );
    await targetCredentialRef.set({
      desktopId: ROUTING_TARGET_DESKTOP_ID,
      desktopSecretHash: sha256Hex(ROUTING_TARGET_DESKTOP_SECRET),
      displayName: "Routing Target",
      revokedAt: null,
      uid: TEST_USER_ID,
      updatedAt: new Date().toISOString(),
    });

    const { ws: requester } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });
    const { ws: target } = await connectAndAuth({
      desktop_id: ROUTING_TARGET_DESKTOP_ID,
      desktop_secret: ROUTING_TARGET_DESKTOP_SECRET,
    });

    try {
      const firstInvoke = waitForMessage(
        target,
        (message) => message.type === "invoke" && message.id === "before-revocation",
      );
      requester.send(JSON.stringify({
        type: "invoke",
        id: "before-revocation",
        desktopId: ROUTING_TARGET_DESKTOP_ID,
        method: "GET",
        path: "/v1/tasks/recent",
        body: null,
      }));
      await expect(firstInvoke).resolves.toMatchObject({
        desktopId: ROUTING_TARGET_DESKTOP_ID,
      });

      await requesterCredentialRef.update({
        revokedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await expireDesktopCredentialCache();

      const unexpectedInvoke = waitForMessage(
        target,
        (message) => message.type === "invoke" && message.id === "after-revocation",
        250,
      ).then(
        () => "invoke",
        () => "timeout",
      );
      const rejected = waitForMessage(
        requester,
        (message) => message.type === "response" && message.id === "after-revocation",
      );
      const closed = new Promise<number>((resolveClose) => {
        requester.once("close", (code) => resolveClose(code));
      });
      requester.send(JSON.stringify({
        type: "invoke",
        id: "after-revocation",
        desktopId: ROUTING_TARGET_DESKTOP_ID,
        method: "GET",
        path: "/v1/tasks/recent",
        body: null,
      }));

      await expect(rejected).resolves.toMatchObject({
        error: "desktop credential is no longer authorized",
      });
      await expect(closed).resolves.toBe(4005);
      await expect(unexpectedInvoke).resolves.toBe("timeout");
    } finally {
      if (requester.readyState < WebSocket.CLOSING) await closeAndWait(requester);
      await closeAndWait(target);
      await requesterCredentialRef.update({
        revokedAt: null,
        updatedAt: new Date().toISOString(),
      });
      await targetCredentialRef.delete();
      await testFirestore.recursiveDelete(targetDesktopRef);
    }
  });

  it("routes mobile notification publishes only from desktop-secret servers", async () => {
    const pushDevicesRef = testFirestore.collection(
      `users/${TEST_USER_ID}/pushDevices`,
    );
    await testFirestore.recursiveDelete(pushDevicesRef);

    const { ws: desktopServer, capabilities } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });
    expect(capabilities).toMatchObject({
      desktopRouting: { version: 1 },
    });
    const desktopAck = waitForMessage(desktopServer, (message) =>
      message.type === "mobile_notification_ack" && message.id === "notify-desktop");
    desktopServer.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "notify-desktop",
      notification: {
        title: "Staging shipped",
        body: "The staging deployment completed.",
        taskId: "task-mobile-notification",
      },
    }));
    await expect(desktopAck).resolves.toMatchObject({
      type: "mobile_notification_ack",
      id: "notify-desktop",
      ok: true,
      delivery: {
        acceptedCount: 0,
        failedCount: 0,
        failureReasons: [],
      },
    });
    await closeAndWait(desktopServer);

    const { ws: legacyServer } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: SECRET_DESKTOP_ID,
    });
    const legacyAck = waitForMessage(legacyServer, (message) =>
      message.type === "mobile_notification_ack" && message.id === "notify-legacy");
    legacyServer.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "notify-legacy",
      notification: {
        title: "Staging shipped",
        body: "The staging deployment completed.",
        taskId: "task-mobile-notification",
      },
    }));
    await expect(legacyAck).resolves.toMatchObject({
      type: "mobile_notification_ack",
      id: "notify-legacy",
      ok: false,
      error: expect.stringContaining("desktop-secret"),
    });
    await closeAndWait(legacyServer);
  });

  it("registers, rotates, and revokes anonymous push bindings", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "anonymous-phone-lifecycle");
    const refreshedCert = createAnonymousPushCertificate(
      identity,
      cert.deviceId,
      cert.issuedAt + 1_000,
    );
    const pairings = testFirestore.collection("anonymousPushPairings");

    const register = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "fcm-token-one")),
    });
    expect(register.status).toBe(200);
    const first = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(first.size).toBe(1);
    expect(first.docs[0]?.data().fcmToken).toBe("fcm-token-one");

    const rotate = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "fcm-token-two")),
    });
    expect(rotate.status).toBe(200);
    const rotated = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(rotated.size).toBe(1);
    expect(rotated.docs[0]?.data().fcmToken).toBe("fcm-token-two");

    const refresh = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, refreshedCert, "fcm-token-three")),
    });
    expect(refresh.status).toBe(200);
    const refreshed = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(refreshed.size).toBe(1);
    expect(refreshed.docs[0]?.data()).toMatchObject({
      certIssuedAt: refreshedCert.issuedAt,
      certSignature: refreshedCert.signature,
      fcmToken: "fcm-token-three",
    });

    const revoke = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: identity.publicKey,
        deviceId: cert.deviceId,
        cert: refreshedCert,
      }),
    });
    expect(revoke.status).toBe(200);
    const revoked = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(revoked.size).toBe(1);
    expect(revoked.docs[0]?.data()).toMatchObject({ fcmToken: null, tokenHash: null });
  });

  it("revokes an older binding with a newer certificate after its refresh registration was missed", async () => {
    const identity = createAnonymousPushIdentity();
    const oldIssuedAt = Date.now() - 2_000;
    const oldCert = createAnonymousPushCertificate(identity, "missed-refresh-phone", oldIssuedAt);
    const newerCert = createAnonymousPushCertificate(identity, "missed-refresh-phone", oldIssuedAt + 1_000);
    const pairings = testFirestore.collection("anonymousPushPairings");

    const register = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, oldCert, "missed-refresh-token")),
    });
    expect(register.status).toBe(200);

    const revoke = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: identity.publicKey,
        deviceId: newerCert.deviceId,
        cert: newerCert,
      }),
    });

    expect(revoke.status).toBe(200);
    const revoked = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(revoked.size).toBe(1);
    expect(revoked.docs[0]?.data()).toMatchObject({
      certIssuedAt: newerCert.issuedAt,
      certSignature: newerCert.signature,
      fcmToken: null,
    });
  });

  it("refuses a stale certificate without replacing or revoking a newer binding", async () => {
    const identity = createAnonymousPushIdentity();
    const oldIssuedAt = Date.now() - 2_000;
    const staleCert = createAnonymousPushCertificate(identity, "stale-delete-phone", oldIssuedAt);
    const currentCert = createAnonymousPushCertificate(identity, "stale-delete-phone", oldIssuedAt + 1_000);
    const pairings = testFirestore.collection("anonymousPushPairings");

    const register = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, currentCert, "current-binding-token")),
    });
    expect(register.status).toBe(200);

    const staleRegister = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, staleCert, "stale-binding-token")),
    });
    expect(staleRegister.status).toBe(409);
    await expect(staleRegister.json()).resolves.toMatchObject({ code: "stale_certificate" });
    const retainedAfterRegister = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(retainedAfterRegister.size).toBe(1);
    expect(retainedAfterRegister.docs[0]?.data()).toMatchObject({
      certIssuedAt: currentCert.issuedAt,
      certSignature: currentCert.signature,
      fcmToken: "current-binding-token",
    });

    const revoke = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: identity.publicKey,
        deviceId: staleCert.deviceId,
        cert: staleCert,
      }),
    });

    expect(revoke.status).toBe(409);
    await expect(revoke.json()).resolves.toMatchObject({ code: "stale_certificate" });
    const retained = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(retained.size).toBe(1);
    expect(retained.docs[0]?.data()).toMatchObject({
      certIssuedAt: currentCert.issuedAt,
      certSignature: currentCert.signature,
      fcmToken: "current-binding-token",
    });

    const currentRevoke = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: identity.publicKey,
        deviceId: currentCert.deviceId,
        cert: currentCert,
      }),
    });
    expect(currentRevoke.status).toBe(200);

    const staleResurrection = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, staleCert, "resurrected-token")),
    });
    expect(staleResurrection.status).toBe(409);
    await expect(staleResurrection.json()).resolves.toMatchObject({ code: "stale_certificate" });
    const tombstone = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(tombstone.size).toBe(1);
    expect(tombstone.docs[0]?.data()).toMatchObject({
      certIssuedAt: currentCert.issuedAt,
      certSignature: currentCert.signature,
      fcmToken: null,
      tokenHash: null,
    });
  });

  it("revokes only the certificate-selected pairing without an FCM token", async () => {
    const identity = createAnonymousPushIdentity();
    const selectedCert = createAnonymousPushCertificate(identity, "certificate-only-selected");
    const retainedCert = createAnonymousPushCertificate(identity, "certificate-only-retained");
    const pairings = testFirestore.collection("anonymousPushPairings");
    for (const [cert, token] of [
      [selectedCert, "certificate-only-selected-token"],
      [retainedCert, "certificate-only-retained-token"],
    ] as const) {
      const response = await fetch(relayHttpUrl("/push/pairings"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anonymousPairingBody(identity, cert, token)),
      });
      expect(response.status).toBe(200);
    }

    const revoke = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        desktopPubKey: identity.publicKey,
        deviceId: selectedCert.deviceId,
        cert: selectedCert,
      }),
    });

    expect(revoke.status).toBe(200);
    const remaining = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(remaining.docs.filter((doc) => doc.data().fcmToken).map((doc) => doc.data().deviceIdHash)).toEqual([
      sha256Hex(retainedCert.deviceId),
    ]);
  });

  it("accepts a signed desktop revocation over its anonymous session", async () => {
    const identity = createAnonymousPushIdentity();
    const staleCert = createAnonymousPushCertificate(
      identity,
      "desktop-revoked-phone",
      Date.now() - 2_000,
    );
    const cert = createAnonymousPushCertificate(
      identity,
      "desktop-revoked-phone",
      staleCert.issuedAt + 1_000,
    );
    const pairings = testFirestore.collection("anonymousPushPairings");
    await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "desktop-revoked-token")),
    });
    expect((await pairings.where("desktopPubKey", "==", identity.publicKey).get()).size).toBe(1);

    const { ws } = await connectAndAuthAnonymous(identity);
    const ack = waitForMessage(ws, (message) =>
      message.type === "response" && message.id === "desktop-revoke");
    ws.send(JSON.stringify({
      type: "anonymous_push_revoke",
      id: "desktop-revoke",
      deviceId: cert.deviceId,
    }));
    await expect(ack).resolves.toMatchObject({ data: null });
    const staleResurrection = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, staleCert, "desktop-resurrected-token")),
    });
    expect(staleResurrection.status).toBe(409);
    await expect(staleResurrection.json()).resolves.toMatchObject({ code: "stale_certificate" });
    const revoked = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(revoked.size).toBe(1);
    expect(revoked.docs[0]?.data()).toMatchObject({
      certIssuedAt: cert.issuedAt,
      fcmToken: null,
    });
    await closeAndWait(ws);
  });

  it("refuses anonymous push registration without a valid desktop pairing certificate", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "unpaired-phone");
    const response = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...anonymousPairingBody(identity, cert, "unpaired-token"),
        cert: { ...cert, signature: randomBytes(64).toString("base64url") },
      }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_certificate" });
  });

  it("authenticates an anonymous desktop and delivers only to its paired token", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "anonymous-phone-delivery");
    await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "anonymous-delivery-token")),
    });
    const { ws, capabilities } = await connectAndAuthAnonymous(identity);
    expect(capabilities).toEqual({
      tunnelServices: [],
      mobileNotifications: { version: 1 },
    });
    const ack = waitForMessage(ws, (message) =>
      message.type === "mobile_notification_ack" && message.id === "anonymous-delivery");
    ws.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "anonymous-delivery",
      notification: { title: "Done", body: "Anonymous delivery works." },
    }));
    await expect(ack).resolves.toMatchObject({
      ok: true,
      delivery: { acceptedCount: 1, failedCount: 0 },
    });
    const captures = await testFirestore.collection(ANONYMOUS_PUSH_CAPTURE_COLLECTION)
      .where("notification.title", "==", "Done")
      .get();
    expect(captures.size).toBe(1);
    expect(captures.docs[0]?.data().tokenHash).toBe(sha256Hex("anonymous-delivery-token"));
    expect(captures.docs[0]?.data().desktopRoutingId).toBe(identity.publicKey);
    await closeAndWait(ws);
  });

  it("ignores tokenless watermarks when selecting anonymous push bindings", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "anonymous-phone-after-watermarks");
    const desktopKeyHash = anonymousDesktopId(identity.publicKey);
    const pairings = testFirestore.collection("anonymousPushPairings");
    const watermarkWrites = Array.from({ length: 10 }, (_, index) =>
      pairings.doc(`${desktopKeyHash}.watermark-${index}`).set({
        desktopKeyHash,
        deviceIdHash: sha256Hex(`watermark-device-${index}`),
        tokenHash: null,
        desktopPubKey: identity.publicKey,
        fcmToken: null,
        updatedAtMs: Date.now(),
        lastDeliveredAtMs: null,
        certIssuedAt: cert.issuedAt,
        certExpiresAt: cert.expiresAt,
        certSignature: cert.signature,
      }));
    await Promise.all(watermarkWrites);
    const register = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "token-after-watermarks")),
    });
    expect(register.status).toBe(200);

    const { ws } = await connectAndAuthAnonymous(identity);
    const ack = waitForMessage(ws, (message) =>
      message.type === "mobile_notification_ack" && message.id === "watermark-selection");
    ws.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "watermark-selection",
      notification: { title: "Watermark selection", body: "The live binding remains selectable." },
    }));
    await expect(ack).resolves.toMatchObject({
      ok: true,
      delivery: { acceptedCount: 1, failedCount: 0 },
    });
    const captures = await testFirestore.collection(ANONYMOUS_PUSH_CAPTURE_COLLECTION)
      .where("notification.title", "==", "Watermark selection")
      .get();
    expect(captures.size).toBe(1);
    expect(captures.docs[0]?.data().tokenHash).toBe(sha256Hex("token-after-watermarks"));
    await closeAndWait(ws);
  });

  it("refuses invoke, tunnel, and snapshot operations from an anonymous desktop", async () => {
    const identity = createAnonymousPushIdentity();
    const { ws } = await connectAndAuthAnonymous(identity);
    const invoke = waitForMessage(ws, (message) =>
      message.type === "response" && message.id === "anonymous-invoke");
    ws.send(JSON.stringify({ type: "invoke", id: "anonymous-invoke", command: "list_active_desktops" }));
    await expect(invoke).resolves.toMatchObject({ error: expect.stringContaining("cannot invoke") });

    const tunnel = waitForMessage(ws, (message) =>
      message.type === "response" && message.id === "anonymous-tunnel");
    ws.send(JSON.stringify({ type: "tunnel_request", id: "anonymous-tunnel" }));
    await expect(tunnel).resolves.toMatchObject({ error: expect.stringContaining("cannot open tunnels") });

    const snapshot = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "anonymous-snapshot");
    ws.send(JSON.stringify({ type: "task_snapshot_publish", id: "anonymous-snapshot", snapshot: {} }));
    await expect(snapshot).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("desktop-secret"),
    });
    await closeAndWait(ws);
  });

  it("rate-limits anonymous desktop notification publication", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "anonymous-phone-rate-limit");
    await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, cert, "anonymous-rate-token")),
    });
    const { ws } = await connectAndAuthAnonymous(identity);
    for (let index = 0; index < 2; index += 1) {
      const id = `anonymous-rate-${index}`;
      const ack = waitForMessage(ws, (message) =>
        message.type === "mobile_notification_ack" && message.id === id);
      ws.send(JSON.stringify({
        type: "mobile_notification_publish",
        id,
        notification: { title: "Rate", body: "Allowed" },
      }));
      await expect(ack).resolves.toMatchObject({ ok: true });
    }
    const refused = waitForMessage(ws, (message) =>
      message.type === "mobile_notification_ack" && message.id === "anonymous-rate-refused");
    ws.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "anonymous-rate-refused",
      notification: { title: "Rate", body: "Refused" },
    }));
    await expect(refused).resolves.toMatchObject({ ok: false, code: 429 });
    await closeAndWait(ws);
  });

  it("rate-limits anonymous publication attempts before a no-binding query can repeat", async () => {
    const identity = createAnonymousPushIdentity();
    const { ws } = await connectAndAuthAnonymous(identity);
    for (let index = 0; index < 3; index += 1) {
      const id = `anonymous-no-binding-rate-${index}`;
      const ack = waitForMessage(ws, (message) =>
        message.type === "mobile_notification_ack" && message.id === id);
      ws.send(JSON.stringify({
        type: "mobile_notification_publish",
        id,
        notification: { title: "No binding", body: "Still bounded" },
      }));
      if (index < 2) {
        await expect(ack).resolves.toMatchObject({ ok: false, code: 409 });
      } else {
        await expect(ack).resolves.toMatchObject({ ok: false, code: 429 });
      }
    }
    await closeAndWait(ws);
  });

  it("enforces binding caps without charging refresh or rotation an extra slot", async () => {
    const pairings = testFirestore.collection("anonymousPushPairings");
    await testFirestore.recursiveDelete(pairings);
    const desktopIdentity = createAnonymousPushIdentity();
    const desktopRequests = Array.from({ length: 10 }, (_, index) => {
      const cert = createAnonymousPushCertificate(desktopIdentity, `desktop-cap-phone-${index}`);
      return anonymousPairingBody(desktopIdentity, cert, `desktop-cap-token-${index}`);
    });
    for (const request of desktopRequests) {
      await registerAnonymousPushPairing(request, Date.now(), testFirestore);
    }
    const refreshed = desktopRequests[0]!;
    await registerAnonymousPushPairing(
      { ...refreshed, fcmToken: "desktop-cap-token-rotated" },
      Date.now(),
      testFirestore,
    );
    expect((await pairings.where("desktopKeyHash", "==", anonymousDesktopId(desktopIdentity.publicKey)).get()).size)
      .toBe(10);
    const overflowCert = createAnonymousPushCertificate(desktopIdentity, "desktop-cap-overflow");
    await expect(registerAnonymousPushPairing(
      anonymousPairingBody(desktopIdentity, overflowCert, "desktop-cap-overflow-token"),
      Date.now(),
      testFirestore,
    )).rejects.toMatchObject({ status: 409, code: "desktop_binding_cap" });

    await testFirestore.recursiveDelete(pairings);
    const sharedToken = "token-cap-shared";
    const tokenRequests = Array.from({ length: 20 }, (_, index) => {
      const identity = createAnonymousPushIdentity();
      const cert = createAnonymousPushCertificate(identity, `token-cap-phone-${index}`);
      return anonymousPairingBody(identity, cert, sharedToken);
    });
    for (const request of tokenRequests) {
      await registerAnonymousPushPairing(request, Date.now(), testFirestore);
    }
    await registerAnonymousPushPairing(tokenRequests[0]!, Date.now() + 1, testFirestore);
    expect((await pairings.where("tokenHash", "==", sha256Hex(sharedToken)).get()).size).toBe(20);
    const overflowIdentity = createAnonymousPushIdentity();
    const tokenOverflowCert = createAnonymousPushCertificate(overflowIdentity, "token-cap-overflow");
    await expect(registerAnonymousPushPairing(
      anonymousPairingBody(overflowIdentity, tokenOverflowCert, sharedToken),
      Date.now(),
      testFirestore,
    )).rejects.toMatchObject({ status: 409, code: "token_binding_cap" });
    await testFirestore.recursiveDelete(pairings);
  });

  it("collects only stale undelivered anonymous bindings", async () => {
    const pairings = testFirestore.collection("anonymousPushPairings");
    await testFirestore.recursiveDelete(pairings);
    const nowMs = Date.now();
    const staleMs = nowMs - 181 * 24 * 60 * 60 * 1_000;
    const recentMs = nowMs - 24 * 60 * 60 * 1_000;
    const base = {
      desktopKeyHash: "gc-desktop",
      deviceIdHash: "gc-device",
      tokenHash: "gc-token",
      desktopPubKey: "gc-public-key",
      fcmToken: "gc-fcm-token",
      certIssuedAt: nowMs - 732 * 24 * 60 * 60 * 1_000,
      certExpiresAt: nowMs - 1,
      certSignature: "gc-signature",
    };
    await Promise.all([
      pairings.doc("stale-undelivered").set({ ...base, updatedAtMs: staleMs, lastDeliveredAtMs: null }),
      pairings.doc("recently-refreshed").set({ ...base, updatedAtMs: recentMs, lastDeliveredAtMs: null }),
      pairings.doc("recently-delivered").set({ ...base, updatedAtMs: staleMs, lastDeliveredAtMs: recentMs }),
    ]);

    expect(await garbageCollectAnonymousPushPairings(testFirestore, nowMs)).toBe(1);
    expect((await pairings.get()).docs.map((doc) => doc.id).sort()).toEqual([
      "recently-delivered",
      "recently-refreshed",
    ]);
    await testFirestore.recursiveDelete(pairings);
  });

  it("keeps a certificate watermark when stale-binding GC retires an unexpired binding", async () => {
    const pairings = testFirestore.collection("anonymousPushPairings");
    await testFirestore.recursiveDelete(pairings);
    const identity = createAnonymousPushIdentity();
    const staleCert = createAnonymousPushCertificate(identity, "gc-ordering-phone", Date.now() - 2_000);
    const currentCert = createAnonymousPushCertificate(identity, "gc-ordering-phone", staleCert.issuedAt + 1_000);
    const currentBody = anonymousPairingBody(identity, currentCert, "gc-current-token");
    await registerAnonymousPushPairing(currentBody, Date.now(), testFirestore);
    const binding = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(binding.size).toBe(1);
    const bindingDoc = binding.docs[0];
    if (!bindingDoc) throw new Error("expected anonymous push binding");
    const nowMs = Date.now();
    await bindingDoc.ref.update({
      updatedAtMs: nowMs - 181 * 24 * 60 * 60 * 1_000,
      lastDeliveredAtMs: null,
    });

    expect(await garbageCollectAnonymousPushPairings(testFirestore, nowMs)).toBe(1);
    const retired = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(retired.size).toBe(1);
    expect(retired.docs[0]?.data()).toMatchObject({
      certIssuedAt: currentCert.issuedAt,
      certSignature: currentCert.signature,
      fcmToken: null,
      tokenHash: null,
    });

    const staleResurrection = await fetch(relayHttpUrl("/push/pairings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anonymousPairingBody(identity, staleCert, "gc-resurrected-token")),
    });
    expect(staleResurrection.status).toBe(409);
    await expect(staleResurrection.json()).resolves.toMatchObject({ code: "stale_certificate" });
    await testFirestore.recursiveDelete(pairings);
  });

  it("does not let stale invalid-token reconciliation retire a refreshed binding", async () => {
    const pairings = testFirestore.collection("anonymousPushPairings");
    await testFirestore.recursiveDelete(pairings);
    const identity = createAnonymousPushIdentity();
    const staleCert = createAnonymousPushCertificate(
      identity,
      "invalid-token-ordering-phone",
      Date.now() - 2_000,
    );
    const currentCert = createAnonymousPushCertificate(
      identity,
      staleCert.deviceId,
      staleCert.issuedAt + 1_000,
    );
    await registerAnonymousPushPairing(
      anonymousPairingBody(identity, staleCert, "invalid-stale-token"),
      Date.now(),
      testFirestore,
    );
    const staleSnapshot = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    const staleBinding = staleSnapshot.docs[0];
    if (!staleBinding) throw new Error("expected stale anonymous push binding snapshot");
    await registerAnonymousPushPairing(
      anonymousPairingBody(identity, currentCert, "invalid-current-token"),
      Date.now(),
      testFirestore,
    );

    await expect(reconcileInvalidAnonymousPushToken(
      staleBinding,
      Date.now(),
      testFirestore,
    )).rejects.toMatchObject({ status: 409, code: "stale_certificate" });
    const retained = await pairings.where("desktopPubKey", "==", identity.publicKey).get();
    expect(retained.size).toBe(1);
    expect(retained.docs[0]?.data()).toMatchObject({
      certIssuedAt: currentCert.issuedAt,
      certSignature: currentCert.signature,
      fcmToken: "invalid-current-token",
    });
    await testFirestore.recursiveDelete(pairings);
  });

  it("rate-limits certificate-only pairing deletion at the configured IP bound", async () => {
    const identity = createAnonymousPushIdentity();
    const cert = createAnonymousPushCertificate(identity, "delete-rate-limit-phone");
    const body = JSON.stringify({
      desktopPubKey: identity.publicKey,
      deviceId: cert.deviceId,
      cert,
    });
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(relayHttpUrl("/push/pairings"), {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.27",
        },
        body,
      });
      expect(response.status).toBe(200);
    }
    const refused = await fetch(relayHttpUrl("/push/pairings"), {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.27",
      },
      body,
    });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: "Anonymous push pairing rate limit exceeded",
    });
  });

  it("rate-limits one anonymous push token across desktop identities", async () => {
    const sharedToken = "anonymous-shared-rate-token";
    const identities = Array.from({ length: 3 }, () => createAnonymousPushIdentity());
    for (const [index, identity] of identities.entries()) {
      const cert = createAnonymousPushCertificate(identity, `anonymous-shared-phone-${index}`);
      const registration = await fetch(relayHttpUrl("/push/pairings"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anonymousPairingBody(identity, cert, sharedToken)),
      });
      expect(registration.status).toBe(200);
    }

    for (const [index, identity] of identities.entries()) {
      const { ws } = await connectAndAuthAnonymous(identity);
      const id = `anonymous-shared-rate-${index}`;
      const ack = waitForMessage(ws, (message) =>
        message.type === "mobile_notification_ack" && message.id === id);
      ws.send(JSON.stringify({
        type: "mobile_notification_publish",
        id,
        notification: { title: "Shared rate", body: "Across desktops" },
      }));
      if (index < 2) {
        await expect(ack).resolves.toMatchObject({ ok: true });
      } else {
        await expect(ack).resolves.toMatchObject({
          ok: false,
          code: 429,
          error: expect.stringContaining("token rate limit"),
        });
      }
      await closeAndWait(ws);
    }
  });

  it("authenticates a desktop and clears its transfer capability when the session disconnects", async () => {
    const desktopRef = testFirestore.doc(
      `users/${TEST_USER_ID}/desktops/${SECRET_DESKTOP_ID}`,
    );
    const { ws, userId } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });

    expect(userId).toBe(TEST_USER_ID);
    const publicationAck = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "publish-transfer");
    const snapshot = publishedSnapshot("idle");
    snapshot.desktop = {
      displayName: "Studio Mac",
      transfer: {
        peerId: "peer-secret-auth",
        publicKey: "public-key",
        protocolVersion: 1,
        acceptingTransfers: true,
      },
    };
    ws.send(JSON.stringify({
      type: "task_snapshot_publish",
      id: "publish-transfer",
      snapshot,
    }));
    await expect(publicationAck).resolves.toMatchObject({ ok: true });
    expect((await desktopRef.get()).data()?.transfer).toMatchObject({
      peerId: "peer-secret-auth",
      acceptingTransfers: true,
    });

    await closeAndWait(ws);
    await vi.waitFor(async () => {
      expect((await desktopRef.get()).data()?.transfer).toBeUndefined();
    });
  });

  it("reconciles only the authenticated desktop task subtree and carries activity-only changes", async () => {
    const tasksRef = testFirestore.collection(
      `users/${TEST_USER_ID}/desktops/${SECRET_DESKTOP_ID}/tasks`,
    );
    await tasksRef.doc("duplicate-one").set(publishedTask("idle"));
    await tasksRef.doc("duplicate-two").set(publishedTask("idle"));
    await tasksRef.doc("stale").set(publishedTask("idle", {
      ownerLocalTaskId: "stale-task",
    }));

    const { ws } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });
    const firstAck = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "publish-idle");
    ws.send(JSON.stringify({
      type: "task_snapshot_publish",
      id: "publish-idle",
      snapshot: publishedSnapshot("idle"),
    }));
    await expect(firstAck).resolves.toMatchObject({ ok: true });

    let documents = await tasksRef.get();
    expect(documents.docs).toHaveLength(1);
    expect(documents.docs[0]?.data()).toMatchObject({
      ownerLocalTaskId: "task-cloud-publish",
      activity: "idle",
      waitingPromptSnippet: "Ready for review",
    });

    const activityAck = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "publish-working");
    ws.send(JSON.stringify({
      type: "task_snapshot_publish",
      id: "publish-working",
      snapshot: publishedSnapshot("working"),
    }));
    await expect(activityAck).resolves.toMatchObject({ ok: true });
    documents = await tasksRef.get();
    expect(documents.docs[0]?.data()).toMatchObject({ activity: "working" });

    const crossDesktopAck = waitForMessage(ws, (message) =>
      message.type === "task_snapshot_ack" && message.id === "publish-other");
    ws.send(JSON.stringify({
      type: "task_snapshot_publish",
      id: "publish-other",
      snapshot: publishedSnapshot("working", [publishedTask("working", {
        ownerDesktopId: "desktop-other",
      })]),
    }));
    await expect(crossDesktopAck).resolves.toMatchObject({ ok: false });
    expect((await testFirestore.doc(
      `users/${TEST_USER_ID}/desktops/desktop-other`,
    ).get()).exists).toBe(false);
    await closeAndWait(ws);
  });

  it("fences relay registrations and cached or in-flight publication once deletion starts", async () => {
    const deletionRef = testFirestore.doc(`accountDeletions/${TEST_USER_ID}`);
    const credentialRef = testFirestore.doc(`desktopCredentials/${SECRET_DESKTOP_ID}`);
    const userRef = testFirestore.doc(`users/${TEST_USER_ID}`);
    const desktopRef = userRef.collection("desktops").doc(SECRET_DESKTOP_ID);
    const registrationToken = "delete-race-device-token";
    const deviceRef = testFirestore.doc(`devices/${registrationToken}`);
    const pushDeviceId = "delete-race-push-device";
    const pushDeviceRef = userRef.collection("pushDevices").doc(sha256Hex(pushDeviceId));
    const claimed = deferredVoid();
    const release = deferredVoid();
    const deletionStarted = deferredVoid();
    const continueDeletion = deferredVoid();
    const inFlightStore = createFirestoreCloudTaskPublicationStore(testFirestore, {
      async afterGenerationClaim() {
        claimed.resolve();
        await release.promise;
      },
    });
    const { ws } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });

    try {
      const registerDeviceBeforeDeletion = await fetch(relayHttpUrl("/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, deviceToken: registrationToken }),
      });
      expect(registerDeviceBeforeDeletion.status).toBe(200);
      const registerPushBeforeDeletion = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId: pushDeviceId,
          deviceToken: "delete-race-fcm-token",
        }),
      });
      expect(registerPushBeforeDeletion.status).toBe(200);
      expect((await deviceRef.get()).exists).toBe(true);
      expect((await pushDeviceRef.get()).exists).toBe(true);

      const warmAck = waitForMessage(ws, (message) =>
        message.type === "task_snapshot_ack" && message.id === "delete-race-warm");
      ws.send(JSON.stringify({
        type: "task_snapshot_publish",
        id: "delete-race-warm",
        snapshot: publishedSnapshot("idle"),
      }));
      await expect(warmAck).resolves.toMatchObject({ ok: true });

      const session = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId: SECRET_DESKTOP_ID,
        store: inFlightStore,
      });
      const inFlight = handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId: SECRET_DESKTOP_ID,
        generation: { session, sequence: 1 },
        snapshot: publishedSnapshot("working"),
        store: inFlightStore,
      });
      const inFlightRejection = expect(inFlight).rejects.toThrow(
        "account deletion is in progress",
      );
      await claimed.promise;

      const deletionStore = firestoreAccountDeletionStore(testFirestore);
      const pausedDeletionStore: AccountDeletionStore = {
        ...deletionStore,
        async markAccountDeletionStarted(uid) {
          const sessionIds = await deletionStore.markAccountDeletionStarted(uid);
          deletionStarted.resolve();
          await continueDeletion.promise;
          return sessionIds;
        },
      };
      const deletion = deleteAccount(
        { uid: TEST_USER_ID },
        {
          store: pausedDeletionStore,
          stripe: {
            cancelSubscription: vi.fn(async () => undefined),
            closeCheckoutSession: vi.fn(async () => undefined),
          },
          auth: {
            revokeRefreshTokens: vi.fn(async () => undefined),
            deleteUser: vi.fn(async () => undefined),
          },
        },
      );
      await deletionStarted.promise;
      release.resolve();

      const registerDeviceAfterFence = await fetch(relayHttpUrl("/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, deviceToken: registrationToken }),
      });
      expect(registerDeviceAfterFence.status).toBe(409);
      expect(await registerDeviceAfterFence.json()).toEqual({
        error: "account deletion is in progress",
      });
      const registerPushAfterFence = await fetch(relayHttpUrl("/push/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          deviceId: pushDeviceId,
          deviceToken: "replacement-fcm-token",
        }),
      });
      expect(registerPushAfterFence.status).toBe(409);
      expect(await registerPushAfterFence.json()).toEqual({
        error: "account deletion is in progress",
      });

      await inFlightRejection;
      const cachedAck = waitForMessage(ws, (message) =>
        message.type === "task_snapshot_ack" && message.id === "delete-race-cached");
      ws.send(JSON.stringify({
        type: "task_snapshot_publish",
        id: "delete-race-cached",
        snapshot: publishedSnapshot("working"),
      }));
      await expect(cachedAck).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/account deletion is in progress/),
      });
      continueDeletion.resolve();
      await expect(deletion).resolves.toEqual({ deleted: true });
      expect((await desktopRef.get()).exists).toBe(false);
      expect((await desktopRef.collection("tasks").get()).empty).toBe(true);
      expect((await deviceRef.get()).exists).toBe(false);
      expect((await pushDeviceRef.get()).exists).toBe(false);
    } finally {
      release.resolve();
      continueDeletion.resolve();
      if (ws.readyState < WebSocket.CLOSING) await closeAndWait(ws);
      await testFirestore.recursiveDelete(userRef);
      await deviceRef.delete();
      await deletionRef.delete();
      await credentialRef.set({
        desktopId: SECRET_DESKTOP_ID,
        desktopSecretHash: sha256Hex(SECRET_DESKTOP_SECRET),
        displayName: "Studio Mac",
        revokedAt: null,
        uid: TEST_USER_ID,
        updatedAt: new Date(0).toISOString(),
      });
      await testFirestore.doc(`devices/${TEST_DEVICE_TOKEN}`).set({
        userId: TEST_USER_ID,
        createdAt: new Date(0).toISOString(),
      });
    }
  });

  it("diffs task documents after warm-up and reseeds safely after restart", async () => {
    const desktopId = `desktop-diff-${Date.now()}`;
    const desktopRef = testFirestore.doc(`users/${TEST_USER_ID}/desktops/${desktopId}`);
    let taskReads = 0;
    const taskWrites: Array<{ kind: "set" | "delete"; id: string }> = [];
    const store = createFirestoreCloudTaskPublicationStore(testFirestore, {
      onTaskCollectionRead() {
        taskReads += 1;
      },
      onTaskDocumentWrite(kind, id) {
        taskWrites.push({ kind, id });
      },
    });
    const snapshot = (tasks: Record<string, unknown>[]) =>
      publishedSnapshot("idle", tasks.map((task) => ({ ...task, ownerDesktopId: desktopId })));
    const firstTask = publishedTask("idle");
    const secondTask = publishedTask("idle", { ownerLocalTaskId: "task-second" });

    try {
      const generation = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId,
        store,
      });
      expect(taskReads).toBe(1);
      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: generation, sequence: 1 },
        snapshot: snapshot([firstTask, secondTask]),
        store,
      });
      expect(taskWrites).toHaveLength(2);

      taskReads = 0;
      taskWrites.length = 0;
      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: generation, sequence: 2 },
        snapshot: snapshot([firstTask, secondTask]),
        store,
      });
      expect(taskReads).toBe(0);
      expect(taskWrites).toHaveLength(0);

      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: generation, sequence: 3 },
        snapshot: snapshot([
          { ...firstTask, activity: "working", updatedAt: "2026-07-14 00:03:00" },
          secondTask,
        ]),
        store,
      });
      expect(taskWrites).toHaveLength(1);
      expect(taskWrites[0]?.kind).toBe("set");

      const restartedWrites: Array<{ kind: "set" | "delete"; id: string }> = [];
      let restartedReads = 0;
      const restartedStore = createFirestoreCloudTaskPublicationStore(testFirestore, {
        onTaskCollectionRead() {
          restartedReads += 1;
        },
        onTaskDocumentWrite(kind, id) {
          restartedWrites.push({ kind, id });
        },
      });
      await desktopRef.collection("tasks").doc("identity-less-stray").set({
        stale: true,
      });
      const restartedGeneration = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId,
        store: restartedStore,
      });
      expect(restartedReads).toBe(1);
      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: restartedGeneration, sequence: 1 },
        snapshot: snapshot([firstTask]),
        store: restartedStore,
      });
      expect(restartedWrites.map(({ kind }) => kind).sort()).toEqual(["delete", "delete", "set"]);
      expect(restartedWrites).toContainEqual({ kind: "delete", id: "identity-less-stray" });
      const remaining = await desktopRef.collection("tasks").get();
      expect(remaining.docs).toHaveLength(1);
      expect(remaining.docs[0]?.data()).toMatchObject({ ownerLocalTaskId: "task-cloud-publish" });
    } finally {
      await testFirestore.recursiveDelete(desktopRef);
    }
  });

  it("serializes delayed overlapping publications in one session and retains removal state", async () => {
    const desktopId = `desktop-publication-overlap-${Date.now()}`;
    const desktopRef = testFirestore.doc(`users/${TEST_USER_ID}/desktops/${desktopId}`);
    const firstClaimed = deferredVoid();
    const releaseFirst = deferredVoid();
    const writes: Array<{ kind: "set" | "delete"; id: string }> = [];
    const store = createFirestoreCloudTaskPublicationStore(testFirestore, {
      async afterGenerationClaim(generation) {
        if (generation.sequence !== 1) return;
        firstClaimed.resolve();
        await releaseFirst.promise;
      },
      onTaskDocumentWrite(kind, id) {
        writes.push({ kind, id });
      },
    });
    const snapshot = (tasks: Record<string, unknown>[]) =>
      publishedSnapshot("idle", tasks.map((task) => ({ ...task, ownerDesktopId: desktopId })));

    try {
      const session = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId,
        store,
      });
      const older = handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session, sequence: 1 },
        snapshot: snapshot([publishedTask("idle")]),
        store,
      });
      await firstClaimed.promise;
      const newer = handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session, sequence: 2 },
        snapshot: snapshot([
          publishedTask("working"),
          publishedTask("idle", { ownerLocalTaskId: "task-second" }),
        ]),
        store,
      });

      releaseFirst.resolve();
      await Promise.all([older, newer]);
      writes.length = 0;
      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session, sequence: 3 },
        snapshot: snapshot([]),
        store,
      });

      expect(writes.map(({ kind }) => kind)).toEqual(["delete", "delete"]);
      expect((await desktopRef.collection("tasks").get()).empty).toBe(true);
    } finally {
      releaseFirst.resolve();
      await testFirestore.recursiveDelete(desktopRef);
    }
  });

  it("transactionally rejects a delayed older publication after a newer session commits", async () => {
    const desktopId = `desktop-publication-race-${Date.now()}`;
    const desktopRef = testFirestore.doc(
      `users/${TEST_USER_ID}/desktops/${desktopId}`,
    );
    const oldClaimed = deferredVoid();
    const releaseOld = deferredVoid();
    const oldStore = createFirestoreCloudTaskPublicationStore(testFirestore, {
      async afterGenerationClaim() {
        oldClaimed.resolve();
        await releaseOld.promise;
      },
    });
    const currentStore = createFirestoreCloudTaskPublicationStore(testFirestore);

    try {
      const oldSession = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId,
        store: oldStore,
      });
      const oldPublication = handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: oldSession, sequence: 1 },
        snapshot: publishedSnapshot("idle", [
          publishedTask("idle", { ownerDesktopId: desktopId }),
        ]),
        store: oldStore,
      });
      await oldClaimed.promise;

      const currentSession = await beginCloudTaskPublicationSession({
        userId: TEST_USER_ID,
        desktopId,
        store: currentStore,
      });
      await handleCloudTaskPublication({
        userId: TEST_USER_ID,
        desktopId,
        generation: { session: currentSession, sequence: 1 },
        snapshot: publishedSnapshot("working", [
          publishedTask("working", { ownerDesktopId: desktopId }),
        ]),
        store: currentStore,
      });
      releaseOld.resolve();

      await expect(oldPublication).rejects.toThrow("stale cloud task publication");
      const documents = await desktopRef.collection("tasks").get();
      expect(documents.docs).toHaveLength(1);
      expect(documents.docs[0]?.data()).toMatchObject({
        ownerDesktopId: desktopId,
        activity: "working",
      });
    } finally {
      releaseOld.resolve();
      await testFirestore.recursiveDelete(desktopRef);
    }
  });

  it("reassigns the canonical credential, closes the old relay socket, and publishes only for the new owner", async () => {
    const credentialRef = testFirestore.doc(
      `desktopCredentials/${SECRET_DESKTOP_ID}`,
    );
    const oldTasksRef = testFirestore.collection(
      `users/${TEST_USER_ID}/desktops/${SECRET_DESKTOP_ID}/tasks`,
    );
    await oldTasksRef.doc("old-owner-sentinel").set(publishedTask("idle", {
      ownerLocalTaskId: "old-owner-sentinel",
    }));
    const newOwnerUid = firebaseUserId(otherIdToken);
    const newDesktopRef = testFirestore.doc(
      `users/${newOwnerUid}/desktops/${SECRET_DESKTOP_ID}`,
    );
    const { ws: oldOwnerSocket } = await connectAndAuth({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: SECRET_DESKTOP_SECRET,
    });
    let newOwnerSocket: WebSocket | null = null;
    try {
      const revoke = await writeCanonicalCredentialAs({
        firestorePort,
        idToken,
        uid: TEST_USER_ID,
        revokedAt: new Date().toISOString(),
      });
      expect(revoke.status).toBe(200);
      const reclaim = await writeCanonicalCredentialAs({
        firestorePort,
        idToken: otherIdToken,
        uid: newOwnerUid,
      });
      expect(reclaim.status).toBe(200);
      await expireDesktopCredentialCache();

      const ack = waitForMessage(oldOwnerSocket, (message) =>
        message.type === "task_snapshot_ack" && message.id === "publish-after-reassignment");
      const closed = new Promise<number>((resolveClose) => {
        oldOwnerSocket.once("close", (code) => resolveClose(code));
      });
      oldOwnerSocket.send(JSON.stringify({
        type: "task_snapshot_publish",
        id: "publish-after-reassignment",
        snapshot: publishedSnapshot("working"),
      }));
      await expect(ack).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/no longer authorized/),
      });
      await expect(closed).resolves.toBe(4005);

      const authenticated = await connectAndAuth({
        desktop_id: SECRET_DESKTOP_ID,
        desktop_secret: SECRET_DESKTOP_SECRET,
      });
      newOwnerSocket = authenticated.ws;
      expect(authenticated.userId).toBe(newOwnerUid);
      const newOwnerAck = waitForMessage(newOwnerSocket, (message) =>
        message.type === "task_snapshot_ack" && message.id === "publish-new-owner");
      newOwnerSocket.send(JSON.stringify({
        type: "task_snapshot_publish",
        id: "publish-new-owner",
        snapshot: publishedSnapshot("working"),
      }));
      await expect(newOwnerAck).resolves.toMatchObject({ ok: true });

      const newTasks = await newDesktopRef.collection("tasks").get();
      expect(newTasks.docs).toHaveLength(1);
      expect(newTasks.docs[0]?.data()).toMatchObject({
        ownerDesktopId: SECRET_DESKTOP_ID,
        activity: "working",
      });
      expect((await oldTasksRef.doc("old-owner-sentinel").get()).exists).toBe(true);
    } finally {
      if (newOwnerSocket && newOwnerSocket.readyState < WebSocket.CLOSING) {
        await closeAndWait(newOwnerSocket);
      }
      await testFirestore.recursiveDelete(newDesktopRef);
      await credentialRef.set({
        desktopId: SECRET_DESKTOP_ID,
        desktopSecretHash: sha256Hex(SECRET_DESKTOP_SECRET),
        displayName: "Studio Mac",
        revokedAt: null,
        uid: TEST_USER_ID,
        updatedAt: new Date().toISOString(),
      });
      if (oldOwnerSocket.readyState < WebSocket.CLOSING) await closeAndWait(oldOwnerSocket);
    }
  });

  it("rejects bad desktop, device, and phone credentials against Firebase emulators", async () => {
    await expect(connectAndExpectClose({
      device_token: "missing-device-token",
    }, 4005)).resolves.toBe(4005);

    await expect(connectAndExpectClose({
      desktop_id: SECRET_DESKTOP_ID,
      desktop_secret: "wrong-secret",
    }, 4005)).resolves.toBe(4005);

    await expect(connectAndExpectClose({
      id_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjEsInVpZCI6ImV4cGlyZWQifQ.",
    }, 4005)).resolves.toBe(4005);
  });

  it("routes legacy device-token servers by supplied desktop id", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-legacy-route",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const serverReceivedInvoke = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.desktopId === "desktop-legacy-route",
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "legacy-desktop-route",
        desktopId: "desktop-legacy-route",
        command: "list_sessions",
        args: {},
      }),
    );

    await expect(serverReceivedInvoke).resolves.toMatchObject({
      id: "legacy-desktop-route",
      command: "list_sessions",
    });

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("should authenticate a phone with id_token", async () => {
    const { ws, userId } = await connectAndAuth({
      id_token: idToken,
    });
    expect(userId).toMatch(/^[A-Za-z0-9]+$/);
    await closeAndWait(ws);
  });

  it("should return 'Desktop offline' when no server is connected", async () => {
    // Connect as phone only (no server for this user)
    const { ws: phone } = await connectAndAuth({ id_token: idToken });

    // Send an invoke — expect an error response since no server is connected
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 42,
        command: "list_sessions",
        args: {},
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response"
    );
    expect(response.id).toBe(42);
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(phone);
  });

  it("should route invoke from phone to server and response back", async () => {
    // 1. Connect server
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });

    // 2. Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    // 3. Set up listener on server to auto-respond to invokes
    const serverReceivedInvoke = waitForMessage(
      server,
      (msg) => msg.type === "invoke"
    );

    // 4. Phone sends invoke
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 1,
        command: "list_sessions",
        args: {},
      })
    );

    // 5. Server receives invoke
    const invoke = await serverReceivedInvoke;
    expect(invoke.command).toBe("list_sessions");
    expect(invoke.id).toBe(1);

    // 6. Server sends response
    const phoneReceivedResponse = waitForMessage(
      phone,
      (msg) => msg.type === "response"
    );

    server.send(
      JSON.stringify({
        type: "response",
        id: invoke.id,
        data: [],
      })
    );

    // 7. Phone receives response
    const response = await phoneReceivedResponse;
    expect(response.id).toBe(1);
    expect(response.data).toEqual([]);

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("pairs a requested tunnel and splices text and binary frames without parsing them", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-tunnel",
    });
    const { ws: clientTunnel } = await connectAndAuth({
      id_token: idToken,
    });

    const establishSignal = waitForMessage(
      desktopControl,
      (msg) => msg.type === "tunnel_establish" && msg.desktopId === "desktop-tunnel",
    );

    clientTunnel.send(
      JSON.stringify({
        type: "tunnel_request",
        id: "open-tunnel-1",
        desktopId: "desktop-tunnel",
      }),
    );

    const signal = await establishSignal;
    expect(signal.tunnelId).toEqual(expect.any(String));
    expect(signal.service).toBe("ksp");

    const desktopTunnel = new WebSocket(relayUrl());
    const readyOrder: string[] = [];
    desktopTunnel.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId) {
        readyOrder.push("desktop");
      }
    });
    clientTunnel.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId) {
        readyOrder.push("client");
      }
    });
    const desktopReady = waitForMessage(
      desktopTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    const clientReady = waitForMessage(
      clientTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );

    await new Promise<void>((resolve) => desktopTunnel.on("open", resolve));
    desktopTunnel.send(
      JSON.stringify({
        type: "auth",
        device_token: TEST_DEVICE_TOKEN,
        desktop_id: "desktop-tunnel",
        tunnel_id: signal.tunnelId,
      }),
    );

    await expect(desktopReady).resolves.toMatchObject({
      type: "tunnel_ready",
      service: "ksp",
    });
    await expect(clientReady).resolves.toMatchObject({
      type: "tunnel_ready",
      service: "ksp",
    });
    // Both ends are told the tunnel is ready before any payload is spliced.
    // Which of the two *sockets* delivers its frame first is not something the
    // relay can guarantee — they are independent TCP connections, and
    // `attachDesktopTunnel` has already wired the peer map before it sends
    // either frame — so the order is asserted as a set, not a sequence.
    expect([...readyOrder.slice(0, 2)].sort()).toEqual(["client", "desktop"]);

    const desktopSawJson = waitForRawMessage(
      desktopTunnel,
      (raw, isBinary) => !isBinary && raw.toString() === '{"type":"ksp_auth","credential":"opaque"}',
    );
    clientTunnel.send('{"type":"ksp_auth","credential":"opaque"}');
    await expect(desktopSawJson).resolves.toMatchObject({ isBinary: false });

    const clientSawBinary = waitForRawMessage(
      clientTunnel,
      (raw, isBinary) => isBinary && raw.equals(Buffer.from([0, 1, 2, 255])),
    );
    desktopTunnel.send(Buffer.from([0, 1, 2, 255]));
    await expect(clientSawBinary).resolves.toMatchObject({ isBinary: true });

    await closeAndWait(clientTunnel);
    await closeAndWait(desktopTunnel);
    await closeAndWait(desktopControl);
  });

  it("accounts tunnel, terminal, and control bytes per connection and reports them", async () => {
    const ODOMETER_DESKTOP_ID = "desktop-byte-odometer";
    const SESSION_ID = "sess-byte-odometer";
    const TUNNEL_DOWNLOAD_BYTES = 128 * 1024;
    const TUNNEL_UPLOAD_BYTES = 8 * 1024;
    const CONTROL_BUDGET_BYTES = 16 * 1024;

    const statsBefore = await fetchRelayByteStats(idToken);

    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: ODOMETER_DESKTOP_ID,
    });
    const { ws: phoneControl } = await connectAndAuth({ id_token: idToken });
    const { ws: phoneTunnel } = await connectAndAuth({ id_token: idToken });

    // 1. Control traffic: a request and its response.
    expect(await requestActiveDesktopIds(phoneControl, "odometer-list"))
      .toContain(ODOMETER_DESKTOP_ID);

    // 2. Terminal streaming over the control channel, the way the mobile app
    //    watches a session.
    const observeSeen = waitForMessage(
      desktopControl,
      (msg) => msg.type === "invoke" && msg.id === "odometer-observe",
    );
    phoneControl.send(JSON.stringify({
      type: "invoke",
      id: "odometer-observe",
      desktopId: ODOMETER_DESKTOP_ID,
      command: "observe_session",
      args: { session_id: SESSION_ID },
    }));
    await observeSeen;

    const terminalChunk = "x".repeat(64 * 1024);
    const terminalFrame = JSON.stringify({
      type: "event",
      payload: {
        session_id: SESSION_ID,
        type: "terminal_output",
        data: terminalChunk,
      },
    });
    const terminalFrameBytes = Buffer.byteLength(terminalFrame);
    const terminalSeen = waitForMessage(
      phoneControl,
      (msg) => msg.type === "event",
      10_000,
    );
    desktopControl.send(terminalFrame);
    await terminalSeen;

    // 3. Tunnel traffic in both directions.
    const establishSignal = waitForMessage(
      desktopControl,
      (msg) => msg.type === "tunnel_establish" && msg.desktopId === ODOMETER_DESKTOP_ID,
    );
    phoneTunnel.send(JSON.stringify({
      type: "tunnel_request",
      id: "odometer-tunnel",
      desktopId: ODOMETER_DESKTOP_ID,
    }));
    const signal = await establishSignal;

    const desktopTunnel = new WebSocket(relayUrl());
    const desktopReady = waitForMessage(
      desktopTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    const clientReady = waitForMessage(
      phoneTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    await new Promise<void>((resolve) => desktopTunnel.on("open", resolve));
    desktopTunnel.send(JSON.stringify({
      type: "auth",
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: ODOMETER_DESKTOP_ID,
      tunnel_id: signal.tunnelId,
    }));
    await desktopReady;
    await clientReady;

    const downloadSeen = waitForRawMessage(
      phoneTunnel,
      (raw, isBinary) => isBinary && raw.length === TUNNEL_DOWNLOAD_BYTES,
      10_000,
    );
    desktopTunnel.send(Buffer.alloc(TUNNEL_DOWNLOAD_BYTES, 9));
    await downloadSeen;

    const uploadSeen = waitForRawMessage(
      desktopTunnel,
      (raw, isBinary) => isBinary && raw.length === TUNNEL_UPLOAD_BYTES,
      10_000,
    );
    phoneTunnel.send(Buffer.alloc(TUNNEL_UPLOAD_BYTES, 4));
    await uploadSeen;

    // A long-lived tunnel reports before it closes.
    const rollup = await waitForByteLogLine(
      (line) =>
        line.event === "connection_rollup"
        && line.desktopId === ODOMETER_DESKTOP_ID
        && line.tunnelService === "ksp"
        && line.received.tunnel >= TUNNEL_DOWNLOAD_BYTES,
      "a periodic rollup for the open desktop tunnel",
    );
    expect(rollup.uid).toBe(TEST_USER_ID);
    expect(rollup.durationMs).toBeGreaterThan(0);

    await closeAndWait(phoneTunnel);
    await closeAndWait(desktopTunnel);
    await closeAndWait(phoneControl);
    await closeAndWait(desktopControl);

    // Close-time rollups, one per connection, attributed to the account.
    const desktopTunnelClose = await waitForByteLogLine(
      (line) =>
        line.event === "connection_close"
        && line.role === "server"
        && line.desktopId === ODOMETER_DESKTOP_ID
        && line.tunnelService === "ksp",
      "the desktop tunnel close rollup",
    );
    expect(desktopTunnelClose.uid).toBe(TEST_USER_ID);
    expect(desktopTunnelClose.received.tunnel).toBe(TUNNEL_DOWNLOAD_BYTES);
    expect(desktopTunnelClose.sent.tunnel).toBe(TUNNEL_UPLOAD_BYTES);
    expect(desktopTunnelClose.received.taskTransfer).toBe(0);
    expect(desktopTunnelClose.received.terminalEvent).toBe(0);
    expect(desktopTunnelClose.received.control).toBeLessThan(CONTROL_BUDGET_BYTES);

    const phoneTunnelClose = await waitForByteLogLine(
      (line) =>
        line.event === "connection_close"
        && line.role === "phone"
        && line.desktopId === ODOMETER_DESKTOP_ID,
      "the phone tunnel close rollup",
    );
    expect(phoneTunnelClose.uid).toBe(TEST_USER_ID);
    expect(phoneTunnelClose.tunnelService).toBe("ksp");
    expect(phoneTunnelClose.sent.tunnel).toBe(TUNNEL_DOWNLOAD_BYTES);
    expect(phoneTunnelClose.received.tunnel).toBe(TUNNEL_UPLOAD_BYTES);
    expect(phoneTunnelClose.received.control).toBeLessThan(CONTROL_BUDGET_BYTES);
    expect(phoneTunnelClose.sent.control).toBeLessThan(CONTROL_BUDGET_BYTES);

    const desktopControlClose = await waitForByteLogLine(
      (line) =>
        line.event === "connection_close"
        && line.role === "server"
        && line.desktopId === ODOMETER_DESKTOP_ID
        && line.tunnelService === null,
      "the desktop control close rollup",
    );
    expect(desktopControlClose.uid).toBe(TEST_USER_ID);
    expect(desktopControlClose.received.terminalEvent).toBe(terminalFrameBytes);
    expect(desktopControlClose.received.tunnel).toBe(0);
    expect(desktopControlClose.received.control).toBeLessThan(CONTROL_BUDGET_BYTES);
    expect(desktopControlClose.sent.control).toBeGreaterThan(0);
    expect(desktopControlClose.sent.control).toBeLessThan(CONTROL_BUDGET_BYTES);

    const phoneControlClose = await waitForByteLogLine(
      (line) =>
        line.event === "connection_close"
        && line.role === "phone"
        && line.desktopId === null
        && line.sent.terminalEvent > 0,
      "the phone control close rollup",
    );
    expect(phoneControlClose.uid).toBe(TEST_USER_ID);
    expect(phoneControlClose.sent.terminalEvent).toBe(terminalFrameBytes);
    expect(phoneControlClose.received.terminalEvent).toBe(0);
    expect(phoneControlClose.received.tunnel).toBe(0);
    expect(phoneControlClose.received.control).toBeLessThan(CONTROL_BUDGET_BYTES);

    // Process aggregates moved by at least what this exchange carried.
    const statsAfter = await fetchRelayByteStats(idToken);
    expect(statsAfter.bytes.received.tunnel - statsBefore.bytes.received.tunnel)
      .toBeGreaterThanOrEqual(TUNNEL_DOWNLOAD_BYTES + TUNNEL_UPLOAD_BYTES);
    expect(statsAfter.bytes.sent.tunnel - statsBefore.bytes.sent.tunnel)
      .toBeGreaterThanOrEqual(TUNNEL_DOWNLOAD_BYTES + TUNNEL_UPLOAD_BYTES);
    expect(statsAfter.bytes.received.terminalEvent - statsBefore.bytes.received.terminalEvent)
      .toBeGreaterThanOrEqual(terminalFrameBytes);
    expect(statsAfter.bytes.sent.terminalEvent - statsBefore.bytes.sent.terminalEvent)
      .toBeGreaterThanOrEqual(terminalFrameBytes);
    expect(statsAfter.bytes.connections.closed).toBeGreaterThanOrEqual(4);
    expect(statsAfter.bytes.totalBytes).toBeGreaterThan(statsBefore.bytes.totalBytes);
    // Aggregates only: the endpoint never names an account.
    expect(JSON.stringify(statsAfter)).not.toContain(TEST_USER_ID);
    expect(JSON.stringify(statsAfter)).not.toContain(ODOMETER_DESKTOP_ID);
  }, 60_000);

  it("refuses byte stats to callers without a valid Firebase credential", async () => {
    const anonymous = await fetch(relayHttpUrl("/stats"));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Unauthorized" });

    const forged = await fetch(relayHttpUrl("/stats"), {
      headers: { Authorization: "Bearer not-a-real-id-token" },
    });
    expect(forged.status).toBe(401);

    const wrongScheme = await fetch(relayHttpUrl("/stats"), {
      headers: { Authorization: `Basic ${idToken}` },
    });
    expect(wrongScheme.status).toBe(401);

    const authorized = await fetch(relayHttpUrl("/stats"), {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as RelayByteStatsBody;
    expect(body.status).toBe("ok");
    expect(Object.keys(body.bytes.received).sort()).toEqual([
      "control",
      "fileBrowse",
      "taskTransfer",
      "terminalEvent",
      "total",
      "tunnel",
    ]);
  });

  it("routes same-user task-transfer tunnels with the requested service", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-transfer-service",
    });
    const { ws: clientTunnel } = await connectAndAuth({
      id_token: idToken,
    });

    const establishSignal = waitForMessage(
      desktopControl,
      (msg) =>
        msg.type === "tunnel_establish"
        && msg.desktopId === "desktop-transfer-service",
    );
    clientTunnel.send(JSON.stringify({
      type: "tunnel_request",
      id: "transfer-tunnel-1",
      desktopId: "desktop-transfer-service",
      service: "task-transfer",
    }));

    const signal = await establishSignal;
    expect(signal).toMatchObject({
      type: "tunnel_establish",
      desktopId: "desktop-transfer-service",
      service: "task-transfer",
    });

    const desktopTunnel = new WebSocket(relayUrl());
    const desktopReady = waitForMessage(
      desktopTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    const clientReady = waitForMessage(
      clientTunnel,
      (msg) => msg.type === "tunnel_ready" && msg.tunnelId === signal.tunnelId,
    );
    await new Promise<void>((resolve) => desktopTunnel.on("open", resolve));
    desktopTunnel.send(JSON.stringify({
      type: "auth",
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-transfer-service",
      tunnel_id: signal.tunnelId,
    }));

    await expect(desktopReady).resolves.toMatchObject({
      service: "task-transfer",
    });
    await expect(clientReady).resolves.toMatchObject({
      service: "task-transfer",
    });

    await closeAndWait(clientTunnel);
    await closeAndWait(desktopTunnel);
    await closeAndWait(desktopControl);
  });

  it("rejects unsupported tunnel services before creating a pending tunnel", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-unsupported-service",
    });
    const { ws: client } = await connectAndAuth({ id_token: idToken });
    const unexpectedEstablish = waitForMessage(
      desktopControl,
      (msg) => msg.type === "tunnel_establish",
      250,
    ).then(
      () => "established",
      () => "timeout",
    );

    client.send(JSON.stringify({
      type: "tunnel_request",
      id: "unsupported-service",
      desktopId: "desktop-unsupported-service",
      service: "ssh",
    }));

    const response = await waitForMessage(
      client,
      (msg) => msg.type === "response" && msg.id === "unsupported-service",
    );
    expect(response.error).toBe("Unsupported tunnel service");
    await expect(unexpectedEstablish).resolves.toBe("timeout");

    await closeAndWait(client);
    await closeAndWait(desktopControl);
  });

  it("does not route task-transfer tunnels to another user's desktop", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-cross-user-transfer",
    });
    const { ws: otherUserClient } = await connectAndAuth({
      id_token: otherIdToken,
    });
    const unexpectedEstablish = waitForMessage(
      desktopControl,
      (msg) => msg.type === "tunnel_establish",
      250,
    ).then(
      () => "established",
      () => "timeout",
    );

    otherUserClient.send(JSON.stringify({
      type: "tunnel_request",
      id: "cross-user-transfer",
      desktopId: "desktop-cross-user-transfer",
      service: "task-transfer",
    }));

    const response = await waitForMessage(
      otherUserClient,
      (msg) => msg.type === "response" && msg.id === "cross-user-transfer",
    );
    expect(response.error).toBe("Desktop offline");
    await expect(unexpectedEstablish).resolves.toBe("timeout");

    await closeAndWait(otherUserClient);
    await closeAndWait(desktopControl);
  });

  it("pauses and resumes legal bounded companion chunks without exceeding the absolute cap", async () => {
    const { ws: desktopControl } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-slow-tunnel",
    });
    const { ws: clientTunnel } = await connectAndAuth({
      id_token: idToken,
    });
    const establishSignal = waitForMessage(
      desktopControl,
      (msg) =>
        msg.type === "tunnel_establish" &&
        msg.desktopId === "desktop-slow-tunnel",
    );
    clientTunnel.send(
      JSON.stringify({
        type: "tunnel_request",
        id: "open-slow-tunnel",
        desktopId: "desktop-slow-tunnel",
      }),
    );
    const signal = await establishSignal;
    const desktopTunnel = new WebSocket(relayUrl());
    const desktopReady = waitForMessage(
      desktopTunnel,
      (msg) =>
        msg.type === "tunnel_ready" &&
        msg.tunnelId === signal.tunnelId,
    );
    const clientReady = waitForMessage(
      clientTunnel,
      (msg) =>
        msg.type === "tunnel_ready" &&
        msg.tunnelId === signal.tunnelId,
    );
    await new Promise<void>((resolve) => desktopTunnel.on("open", resolve));
    desktopTunnel.send(
      JSON.stringify({
        type: "auth",
        device_token: TEST_DEVICE_TOKEN,
        desktop_id: "desktop-slow-tunnel",
        tunnel_id: signal.tunnelId,
      }),
    );
    await desktopReady;
    await clientReady;

    const chunks = maximumLegalCompanionChunkFrames();
    expect(chunks.length).toBeGreaterThan(700);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 256 * 1024)).toBe(true);
    const before = await relayTunnelFlowHealth();
    const expectedFrames = chunks.length;
    let sendCallbacks = 0;
    let receivedFrames = 0;
    const allReceived = new Promise<void>((resolve) => {
      desktopTunnel.on("message", (_raw: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          receivedFrames += 1;
          if (receivedFrames === expectedFrames) resolve();
        }
      });
    });

    desktopTunnel.pause();
    for (const chunk of chunks) {
      clientTunnel.send(chunk, (error) => {
        expect(error).toBeFalsy();
        sendCallbacks += 1;
      });
    }
    await vi.waitFor(
      async () => expect((await relayTunnelFlowHealth()).pauseCount)
        .toBeGreaterThan(before.pauseCount),
      // Liveness polls: the counters either move or they do not. Generous so
      // a box running several suites cannot fail a correct run.
      { timeout: 60_000, interval: 100 },
    );
    expect(sendCallbacks).toBeLessThan(expectedFrames);

    desktopTunnel.resume();
    await Promise.race([
      allReceived,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`received ${receivedFrames}/${expectedFrames} snapshots`)),
          60_000,
        );
      }),
    ]);
    await vi.waitFor(
      () => expect(sendCallbacks).toBe(expectedFrames),
      { timeout: 60_000 },
    );
    await vi.waitFor(
      async () => expect((await relayTunnelFlowHealth()).resumeCount)
        .toBeGreaterThan(before.resumeCount),
      { timeout: 60_000, interval: 100 },
    );
    const after = await relayTunnelFlowHealth();
    expect(after.maxBufferedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(after.capRejectCount).toBe(before.capRejectCount);
    expect(clientTunnel.readyState).toBe(WebSocket.OPEN);
    expect(desktopTunnel.readyState).toBe(WebSocket.OPEN);

    await closeAndWait(clientTunnel);
    await closeAndWait(desktopTunnel);
    await closeAndWait(desktopControl);
  }, 30_000);

  it("rejects tunnel requests for an offline desktop", async () => {
    const { ws: client } = await connectAndAuth({
      id_token: idToken,
    });

    client.send(
      JSON.stringify({
        type: "tunnel_request",
        id: "offline-tunnel",
        desktopId: "missing-desktop",
      }),
    );

    const response = await waitForMessage(
      client,
      (msg) => msg.type === "response" && msg.id === "offline-tunnel",
    );
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(client);
  });

  it("should route events from server to phone", async () => {
    // Connect server
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });

    // Connect phone
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    // Set up listener on phone for events
    const phoneReceivedEvent = waitForMessage(
      phone,
      (msg) => msg.type === "event"
    );

    // Server pushes an event
    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "s1", data_b64: "aGVsbG8=" },
      })
    );

    // Phone receives the event
    const event = await phoneReceivedEvent;
    expect(event.name).toBe("terminal_output");
    expect((event.payload as Record<string, unknown>).session_id).toBe("s1");

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("routes terminal events only to clients that observe the session", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-terminal-owner",
    });
    const { ws: observer } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: idleClient } = await connectAndAuth({
      id_token: idToken,
    });

    const observeInvoke = waitForMessage(
      server,
      (msg) =>
        msg.type === "invoke" &&
        msg.command === "observe_session" &&
        msg.desktopId === "desktop-terminal-owner",
    );

    observer.send(
      JSON.stringify({
        type: "invoke",
        id: "observe-task-1",
        desktopId: "desktop-terminal-owner",
        command: "observe_session",
        args: { session_id: "task-1" },
      }),
    );

    const invoke = await observeInvoke;
    server.send(
      JSON.stringify({
        type: "response",
        id: invoke.id,
        data: null,
      }),
    );
    await waitForMessage(
      observer,
      (msg) => msg.type === "response" && msg.id === "observe-task-1",
    );

    const observedEvent = waitForMessage(
      observer,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
    );
    const idleEvent = waitForMessage(
      idleClient,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
      250,
    ).then(
      () => "event",
      () => "timeout",
    );

    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "task-1", data_b64: "aGVsbG8=" },
      }),
    );

    await expect(observedEvent).resolves.toMatchObject({
      name: "terminal_output",
    });
    await expect(idleEvent).resolves.toBe("timeout");

    await closeAndWait(observer);
    await closeAndWait(idleClient);
    await closeAndWait(server);
  });

  it("keeps owner terminal streaming until the last observer unsubscribes", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-terminal-shared",
    });
    const { ws: first } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: second } = await connectAndAuth({
      id_token: idToken,
    });

    for (const [client, id] of [[first, "observe-first"], [second, "observe-second"]] as const) {
      const forwardedObserve = waitForMessage(
        server,
        (msg) => msg.type === "invoke" && msg.command === "observe_session" && msg.id === id,
      );
      client.send(
        JSON.stringify({
          type: "invoke",
          id,
          desktopId: "desktop-terminal-shared",
          command: "observe_session",
          args: { session_id: "task-shared" },
        }),
      );
      await forwardedObserve;
      server.send(JSON.stringify({ type: "response", id, data: null }));
      await waitForMessage(client, (msg) => msg.type === "response" && msg.id === id);
    }

    const unexpectedUnobserve = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.command === "unobserve_session",
      250,
    ).then(
      () => "unobserve",
      () => "timeout",
    );
    first.send(
      JSON.stringify({
        type: "invoke",
        id: "unobserve-first",
        desktopId: "desktop-terminal-shared",
        command: "unobserve_session",
        args: { session_id: "task-shared" },
      }),
    );
    await waitForMessage(first, (msg) => msg.type === "response" && msg.id === "unobserve-first");
    await expect(unexpectedUnobserve).resolves.toBe("timeout");

    const firstEvent = waitForMessage(
      first,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
      250,
    ).then(
      () => "event",
      () => "timeout",
    );
    const secondEvent = waitForMessage(
      second,
      (msg) => msg.type === "event" && msg.name === "terminal_output",
    );
    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "task-shared", data_b64: "bGl2ZQ==" },
      }),
    );
    await expect(firstEvent).resolves.toBe("timeout");
    await expect(secondEvent).resolves.toMatchObject({ name: "terminal_output" });

    const forwardedUnobserve = waitForMessage(
      server,
      (msg) => msg.type === "invoke" && msg.command === "unobserve_session" && msg.id === "unobserve-second",
    );
    second.send(
      JSON.stringify({
        type: "invoke",
        id: "unobserve-second",
        desktopId: "desktop-terminal-shared",
        command: "unobserve_session",
        args: { session_id: "task-shared" },
      }),
    );
    await forwardedUnobserve;

    await closeAndWait(first);
    await closeAndWait(second);
    await closeAndWait(server);
  });

  it("keeps two desktop connections for the same user isolated by desktop id", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-two" &&
        msg.command === "list_sessions"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: 91,
        desktopId: "desktop-two",
        command: "list_sessions",
        args: {},
      })
    );

    const invoke = await desktopTwoInvoke;
    expect(invoke.desktopId).toBe("desktop-two");
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("routes HTTP-style invokes only to the selected desktop", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one-http",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two-http",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-two-http" &&
        msg.method === "GET" &&
        msg.path === "/v1/status"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "http-status",
        desktopId: "desktop-two-http",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const invoke = await desktopTwoInvoke;
    expect(invoke.body).toBeNull();
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("routes mobile task actions only to the requested owner desktop", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-owner-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-owner-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const unexpectedDesktopOneInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoInvoke = waitForMessage(
      desktopTwo,
      (msg) =>
        msg.type === "invoke" &&
        msg.desktopId === "desktop-owner-two" &&
        msg.path === "/v1/tasks/cloud-task-1/input"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "task-action-owner-route",
        desktopId: "desktop-owner-two",
        method: "POST",
        path: "/v1/tasks/cloud-task-1/input",
        body: { input: "continue\n" },
      })
    );

    await expect(desktopTwoInvoke).resolves.toMatchObject({
      desktopId: "desktop-owner-two",
      method: "POST",
    });
    await expect(unexpectedDesktopOneInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("requires desktopId for HTTP-style invokes when multiple desktops are connected", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-one-missing-id",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-two-missing-id",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const desktopOneUnexpectedInvoke = waitForMessage(
      desktopOne,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );
    const desktopTwoUnexpectedInvoke = waitForMessage(
      desktopTwo,
      (msg) => msg.type === "invoke",
      250
    ).then(
      () => "invoke",
      () => "timeout"
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "missing-desktop-id",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "missing-desktop-id"
    );
    expect(response.error).toBe("Multiple desktops connected; desktopId required");
    await expect(desktopOneUnexpectedInvoke).resolves.toBe("timeout");
    await expect(desktopTwoUnexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
    await closeAndWait(desktopTwo);
  });

  it("returns Desktop offline for an HTTP-style invoke targeting a disconnected desktop", async () => {
    const { ws: desktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-online",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "offline-desktop",
        desktopId: "desktop-offline",
        method: "GET",
        path: "/v1/status",
        body: null,
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "offline-desktop"
    );
    expect(response.error).toBe("Desktop offline");

    await closeAndWait(phone);
    await closeAndWait(desktop);
  }, 15_000);

  it("lists only active desktop connections for a signed-in user", async () => {
    const { ws: desktopOne } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-active-one",
    });
    const { ws: desktopTwo } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-active-two",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "active-desktops",
        command: "list_active_desktops",
        args: {},
      })
    );

    const response = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "active-desktops"
    );
    expect(response.data).toEqual({
      desktopIds: expect.arrayContaining([
        "desktop-active-one",
        "desktop-active-two",
      ]),
    });

    await closeAndWait(desktopTwo);
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "active-desktops-after-close",
        command: "list_active_desktops",
        args: {},
      })
    );

    const afterClose = await waitForMessage(
      phone,
      (msg) => msg.type === "response" && msg.id === "active-desktops-after-close"
    );
    expect(afterClose.data).toEqual({
      desktopIds: ["desktop-active-one"],
    });

    await closeAndWait(phone);
    await closeAndWait(desktopOne);
  });

  it("routes desktop responses only to phones authenticated as the same user", async () => {
    const { ws: userOneDesktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
    });
    const { ws: userOnePhone } = await connectAndAuth({
      id_token: idToken,
    });
    const { ws: userTwoPhone } = await connectAndAuth({
      id_token: otherIdToken,
    });

    const userOneResponse = waitForMessage(
      userOnePhone,
      (msg) => msg.type === "response" && msg.id === "same-user-only"
    );
    const userTwoUnexpectedResponse = waitForMessage(
      userTwoPhone,
      (msg) => msg.type === "response",
      250
    ).then(
      () => "response",
      () => "timeout"
    );

    userOneDesktop.send(
      JSON.stringify({
        type: "response",
        id: "same-user-only",
        data: { ok: true },
      })
    );

    const response = await userOneResponse;
    expect(response.data).toEqual({ ok: true });
    await expect(userTwoUnexpectedResponse).resolves.toBe("timeout");

    await closeAndWait(userTwoPhone);
    await closeAndWait(userOnePhone);
    await closeAndWait(userOneDesktop);
  });

  it("does not let another user invoke a desktop owned by the seeded user", async () => {
    const { ws: userOneDesktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-private-user-one",
    });
    const { ws: userTwoPhone } = await connectAndAuth({
      id_token: otherIdToken,
    });

    const unexpectedInvoke = waitForMessage(
      userOneDesktop,
      (msg) => msg.type === "invoke",
      250,
    ).then(
      () => "invoke",
      () => "timeout",
    );

    userTwoPhone.send(
      JSON.stringify({
        type: "invoke",
        id: "cross-user-invoke",
        desktopId: "desktop-private-user-one",
        method: "GET",
        path: "/v1/status",
        body: null,
      }),
    );

    const response = await waitForMessage(
      userTwoPhone,
      (msg) => msg.type === "response" && msg.id === "cross-user-invoke",
    );
    expect(response.error).toBe("Desktop offline");
    await expect(unexpectedInvoke).resolves.toBe("timeout");

    await closeAndWait(userTwoPhone);
    await closeAndWait(userOneDesktop);
  });

  it("drops server events silently while the phone is offline", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-offline-phone-event",
    });

    server.send(
      JSON.stringify({
        type: "event",
        name: "terminal_output",
        payload: { session_id: "offline-phone", data_b64: "b2ZmbGluZQ==" },
      }),
    );

    const health = await fetch(healthUrl());
    expect(health.ok).toBe(true);
    expect(server.readyState).toBe(WebSocket.OPEN);

    await closeAndWait(server);
  });

  it("routes server events to the phone in send order", async () => {
    const { ws: server } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "desktop-event-order",
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    const eventCount = 20;
    const receivedEvents = waitForMessages(
      phone,
      (msg) => msg.type === "event" && msg.name === "ordered_event",
      eventCount,
    );

    for (let sequence = 0; sequence < eventCount; sequence += 1) {
      server.send(
        JSON.stringify({
          type: "event",
          name: "ordered_event",
          payload: { sequence },
        }),
      );
    }

    const events = await receivedEvents;
    expect(events.map((event) => (event.payload as Record<string, unknown>).sequence)).toEqual(
      Array.from({ length: eventCount }, (_value, index) => index),
    );

    await closeAndWait(phone);
    await closeAndWait(server);
  });

  it("cleans up disconnected desktops and resumes routing after reconnect", async () => {
    const desktopId = "desktop-reconnect-route";
    const { ws: firstDesktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: desktopId,
    });
    const { ws: phone } = await connectAndAuth({
      id_token: idToken,
    });

    expect(await requestActiveDesktopIds(phone, "active-before-reconnect")).toContain(desktopId);
    await closeAndWait(firstDesktop);

    await expect(
      requestActiveDesktopIds(phone, "active-after-disconnect"),
    ).resolves.not.toContain(desktopId);

    const { ws: secondDesktop } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: desktopId,
    });
    const secondDesktopInvoke = waitForMessage(
      secondDesktop,
      (msg) => msg.type === "invoke" && msg.id === "invoke-after-reconnect",
    );

    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "invoke-after-reconnect",
        desktopId,
        method: "GET",
        path: "/v1/status",
        body: null,
      }),
    );

    await expect(secondDesktopInvoke).resolves.toMatchObject({
      desktopId,
      path: "/v1/status",
    });

    await closeAndWait(phone);
    await closeAndWait(secondDesktop);
  });

  it("keeps the account's other desktops online when one disconnects with no phone attached", async () => {
    // The everyday shape: several desktops idle on the relay while the phone
    // is asleep. Dropping one must not evict the account's other desktops —
    // their sockets stay open, so nothing would ever make them reconnect.
    const stayingIds = ["desktop-idle-stay-a", "desktop-idle-stay-b"];
    const leavingId = "desktop-idle-leave";
    const staying: WebSocket[] = [];
    for (const desktop_id of stayingIds) {
      staying.push(
        (await connectAndAuth({ device_token: TEST_DEVICE_TOKEN, desktop_id })).ws,
      );
    }
    const { ws: leaving } = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: leavingId,
    });

    await closeAndWait(leaving);

    const { ws: phone } = await connectAndAuth({ id_token: idToken });
    const active = await requestActiveDesktopIds(phone, "active-after-peer-drop");
    expect(active).toEqual(expect.arrayContaining(stayingIds));
    expect(active).not.toContain(leavingId);

    const survivorInvoke = waitForMessage(
      staying[0],
      (msg) => msg.type === "invoke" && msg.id === "invoke-after-peer-drop",
    );
    phone.send(
      JSON.stringify({
        type: "invoke",
        id: "invoke-after-peer-drop",
        desktopId: stayingIds[0],
        method: "GET",
        path: "/v1/status",
        body: null,
      }),
    );
    await expect(survivorInvoke).resolves.toMatchObject({
      desktopId: stayingIds[0],
      path: "/v1/status",
    });

    await closeAndWait(phone);
    for (const desktop of staying) await closeAndWait(desktop);
  });

  it("should reject connections that do not send auth within timeout", async () => {
    const startedAt = Date.now();
    const ws = new WebSocket(relayUrl());
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });
    const elapsedMs = Date.now() - startedAt;

    expect(closeCode).toBe(4001);
    // The lower bound is the real assertion: the relay waited out its 10s auth
    // window rather than closing early. The upper bound only says the window is
    // roughly that, not minutes, so it carries order-of-magnitude headroom —
    // a 12s ceiling on a 10s window left none once the box was busy.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_500);
    expect(elapsedMs).toBeLessThan(30_000);
  }, 40_000);

  it("rejects connections whose first message is not auth", async () => {
    const ws = new WebSocket(relayUrl());
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "not_auth", foo: "bar" }));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    expect(closeCode).toBe(4003);
  });

  it("should reject connections with missing tokens", async () => {
    const ws = new WebSocket(relayUrl());
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Send auth without any token
    ws.send(JSON.stringify({ type: "auth" }));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });

    // The relay closes with 4004 for "Missing id_token or device_token"
    expect(closeCode).toBe(4004);
  });

  it("keeps every other connection alive when one sends a frame over maxPayload", async () => {
    // Three authenticated connections from one address — two desktops and a
    // phone behind one NAT — are ordinary usage, and the per-IP bound is on the
    // *unauthenticated* population, so none of them is refused.
    const desktopA = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "limits-desktop-a",
    });
    const desktopB = await connectAndAuth({
      device_token: TEST_DEVICE_TOKEN,
      desktop_id: "limits-desktop-b",
    });
    const phone = await connectAndAuth({ id_token: idToken });

    // 24 MiB of zeros is a few KiB once deflated, which is exactly the
    // amplification this task closes: before it, the same trick could force a
    // 100 MiB allocation on a 1 GB VM, and it did not need to authenticate
    // first. `ws` now aborts the inflate at the cap and closes with 1009.
    const closed = new Promise<number>((resolveClose) => {
      phone.ws.once("close", (code: number) => resolveClose(code));
    });
    phone.ws.send(Buffer.alloc(24 * 1024 * 1024), { compress: true });
    expect(await closed).toBe(1009);

    const health = await fetch(healthUrl());
    expect(health.status).toBe(200);
    expect(desktopA.ws.readyState).toBe(WebSocket.OPEN);
    expect(desktopB.ws.readyState).toBe(WebSocket.OPEN);
    desktopA.ws.close();
    desktopB.ws.close();
  }, 30_000);

  it("releases each pre-auth slot on the auth frame, so live sockets are not capped", async () => {
    // The per-IP cap this suite runs the relay with bounds the *pre-auth*
    // population, not the live one: `releasePreAuthSlot()` hands the slot back
    // on the auth frame. That release is the load-bearing half of the feature. If it
    // regressed, the constant would silently become a hard cap on live sockets
    // per client address — which ordinary usage reaches, because every desktop
    // holds a control socket plus its KSP and task-transfer tunnel sockets and
    // a NAT puts several desktops and phones on one address. So this opens
    // more connections than the cap and keeps every one of them.
    const logMark = markRelayLog();
    const total = MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP + 3;
    const connections: Array<{ ws: WebSocket; userId: string }> = [];
    try {
      for (let index = 0; index < total; index += 1) {
        // Distinct desktop ids on purpose: `setServerConnection` closes a
        // same-id predecessor, and that close would hand a slot back for the
        // wrong reason — letting this pass even with the release removed.
        connections.push(await connectAndAuth({
          device_token: TEST_DEVICE_TOKEN,
          desktop_id: `preauth-release-${index}`,
        }));
      }

      expect(connections).toHaveLength(total);
      for (const { ws } of connections) {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
      expect(relayLogSince(logMark)).not.toContain("[ws] Refused upgrade");
    } finally {
      for (const { ws } of connections) ws.close();
    }
  }, 40_000);

  it("refuses an unauthenticated flood from one address and frees the slot on close", async () => {
    const logMark = markRelayLog();
    const silent: WebSocket[] = [];
    try {
      for (let index = 0; index < MAX_UNAUTHENTICATED_CONNECTIONS_PER_IP; index += 1) {
        silent.push(await openWithoutAuth());
      }

      // The surplus upgrade is refused before `ws` allocates anything for it.
      expect(await openExpectingUpgradeRefusal()).toBe(429);
      await waitForRelayLog(
        logMark,
        "[ws] Refused upgrade from",
        "the refused upgrade",
      );
      // Refusing the surplus must not disturb the sockets already admitted.
      for (const ws of silent) {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }

      // Closing one silent socket returns its slot — the release-on-close path,
      // which is the only thing that frees a socket that never authenticated.
      const closed = new Promise<void>((resolveClosed) => {
        silent[0].once("close", () => resolveClosed());
      });
      silent[0].close();
      await closed;
      silent.splice(0, 1);
      silent.push(await openWithoutAuth());
    } finally {
      // Close every silent socket, so the relay's 10 s auth timeout does not
      // bleed into a later case in this shared process.
      for (const ws of silent) ws.close();
    }
  }, 40_000);

  it("gracefully closes clients before an authorized E2E shutdown", async () => {
    const unauthorized = await fetch(
      `http://127.0.0.1:${relayPort}/__kanna_e2e_shutdown`,
      {
        method: "POST",
        headers: { "x-kanna-e2e-shutdown-token": "wrong-token" },
      },
    );
    expect(unauthorized.status).toBe(404);

    const { ws } = await connectAndAuth({ device_token: TEST_DEVICE_TOKEN });
    const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
      ws.once("close", (code: number, reason: Buffer) => {
        resolveClose({ code, reason: reason.toString() });
      });
    });
    const exited = new Promise<void>((resolveExit) => {
      relayProcess?.once("exit", () => resolveExit());
    });

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/__kanna_e2e_shutdown`,
      {
        method: "POST",
        headers: { "x-kanna-e2e-shutdown-token": E2E_SHUTDOWN_TOKEN },
      },
    );

    expect(response.status).toBe(204);
    await expect(closed).resolves.toEqual({
      code: 1012,
      reason: "Relay restarting",
    });
    await expect(exited).resolves.toBeUndefined();
  });
});
