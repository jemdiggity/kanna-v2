import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
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
  beginCloudTaskPublicationSession,
  createFirestoreCloudTaskPublicationStore,
  handleCloudTaskPublication,
} from "../src/cloudTaskPublication.js";

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
 */
async function waitForRelay(timeoutMs = 10_000): Promise<void> {
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
  const chunkData = "x".repeat(96 * 1024);
  const chunksPerBundle = Math.ceil((23 * 1024 * 1024) / chunkData.length);
  return Array.from({ length: bundleCount }, (_, bundleIndex) =>
    Array.from({ length: chunksPerBundle }, (_, index) => JSON.stringify({
      type: "companion_snapshot_chunk",
      task_id: "task-maximum-companion",
      transfer_id: `session-maximum-companion:revision-${bundleIndex}`,
      index,
      count: chunksPerBundle,
      data: chunkData,
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
          firestore: { host: "127.0.0.1", port: firestorePort },
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
    firebaseProcess.stdout?.resume();
    idToken = await waitForAuthEmulator(authPort);
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
      },
      detached: true,
      stdio: "pipe",
    });

    // Log relay stderr for debugging test failures
    relayProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[relay] ${chunk.toString()}`);
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
        body: JSON.stringify({ idToken, deviceId }),
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
    expect(readyOrder.slice(0, 2)).toEqual(["desktop", "client"]);

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
      { timeout: 10_000, interval: 100 },
    );
    expect(sendCallbacks).toBeLessThan(expectedFrames);

    desktopTunnel.resume();
    await Promise.race([
      allReceived,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`received ${receivedFrames}/${expectedFrames} snapshots`)),
          15_000,
        );
      }),
    ]);
    await vi.waitFor(
      () => expect(sendCallbacks).toBe(expectedFrames),
      { timeout: 5_000 },
    );
    await vi.waitFor(
      async () => expect((await relayTunnelFlowHealth()).resumeCount)
        .toBeGreaterThan(before.resumeCount),
      { timeout: 5_000, interval: 100 },
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
    expect(elapsedMs).toBeGreaterThanOrEqual(9_500);
    expect(elapsedMs).toBeLessThan(12_000);
  }, 13_000);

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
