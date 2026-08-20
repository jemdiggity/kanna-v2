/**
 * Relay entitlement enforcement against the real Firebase emulator
 * (`docs/specs/accounts-and-billing.md`, Decisions 5 and 8).
 *
 * Two relays share one emulator: one with
 * `KANNA_RELAY_ENTITLEMENT_ENFORCEMENT=on`, which is what every assertion about
 * refusal is made against, and one with the flag off, which is what proves the
 * shipped default is unchanged. Both are real processes speaking the real
 * protocol — the enforcement points sit in the handshake and the publication
 * paths, so an in-process test of the module alone would not show them wired.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ENTITLEMENT_REQUIRED_CODE } from "../src/entitlement.js";

const PASSWORD = "password123";

/**
 * Short enough that the revocation test can observe the bound instead of
 * waiting the production minute for it.
 */
const ENTITLEMENT_CACHE_TTL_MS = 400;

interface TestAccount {
  uid: string;
  email: string;
  emailVerified: boolean;
  desktopId: string;
  desktopSecret: string;
  idToken: string;
}

const ACCOUNTS = {
  entitled: { uid: "ent-active", email: "ent-active@example.com", emailVerified: true },
  unentitled: { uid: "ent-none", email: "ent-none@example.com", emailVerified: true },
  unverified: { uid: "ent-unverified", email: "ent-unverified@example.com", emailVerified: false },
  comped: { uid: "ent-comped", email: "ent-comped@example.com", emailVerified: true },
  graceExpired: { uid: "ent-grace-gone", email: "ent-grace-gone@example.com", emailVerified: true },
} as const;

type AccountName = keyof typeof ACCOUNTS;

const accounts = {} as Record<AccountName, TestAccount>;

let firebaseProcess: ChildProcessWithoutNullStreams | null = null;
let firebaseConfigDir: string | null = null;
let enforcingRelay: ChildProcessWithoutNullStreams | null = null;
let permissiveRelay: ChildProcessWithoutNullStreams | null = null;
let adminApp: App | null = null;
let db: Firestore;
let authPort = 0;
let firestorePort = 0;
let enforcingPort = 0;
let permissivePort = 0;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForRelay(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    if (response?.ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`relay on ${port} did not become ready`);
}

async function signIn(email: string): Promise<string> {
  const url = `http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=kanna-local`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { idToken?: string } | null;
    if (response?.ok && body?.idToken) return body.idToken;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`auth emulator never signed in ${email}`);
}

function entitlementDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "active",
    source: "stripe",
    capabilities: ["cloud_relay", "cloud_task_index", "remote_task_control"],
    currentPeriodEndsAt: "2027-01-01T00:00:00.000Z",
    graceEndsAt: null,
    stripeCustomerId: "cus_relay_test",
    stripeSubscriptionId: "sub_relay_test",
    appStoreOriginalTransactionId: null,
    duplicateSources: false,
    environment: "staging",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

function entitlementRef(uid: string) {
  return db.doc(`users/${uid}/entitlements/cloud_access`);
}

/**
 * Run the real comp grant script against this emulator.
 *
 * This is the whole Slice-1 claim in one step: the operator script writes
 * `billing/comp`, calls `recomputeEntitlement` itself — nothing else would, no
 * Firestore trigger watches the source docs — and the relay then serves the
 * account. Asserting it here rather than only in the billing package's own
 * tests is what proves the two halves meet.
 */
async function grantCompAccess(email: string): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const child = spawn(
    "pnpm",
    ["--filter", "@kanna/firebase-functions", "comp:grant", "--", "--reason", "grandfathered", email],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GCLOUD_PROJECT: "kanna-local",
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
        FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
      },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number>((resolveCode) => {
    child.on("exit", (exitCode) => resolveCode(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(`comp:grant failed (${code}):\n${output}`);
  }
}

interface AuthResult {
  ws: WebSocket;
  userId: string;
  capabilities: Record<string, unknown>;
  entitlement: Record<string, unknown> | undefined;
}

function connectAndAuth(port: number, payload: Record<string, unknown>): Promise<AuthResult> {
  return new Promise((resolveAuth, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("auth timed out"));
    }, 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", ...payload })));
    const handler = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== "auth_ok") return;
      clearTimeout(timeout);
      ws.off("message", handler);
      resolveAuth({
        ws,
        userId: message.userId as string,
        capabilities: message.capabilities as Record<string, unknown>,
        entitlement: message.entitlement as Record<string, unknown> | undefined,
      });
    };
    ws.on("message", handler);
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("waitForMessage timed out")), timeoutMs);
    const handler = (raw: Buffer) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", handler);
      resolveMessage(message);
    };
    ws.on("message", handler);
  });
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolveClose) => {
    if (ws.readyState >= WebSocket.CLOSING) {
      resolveClose();
      return;
    }
    ws.on("close", () => resolveClose());
    ws.close();
  });
}

function snapshot(desktopId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    desktop: { displayName: "Entitlement Test Mac" },
    tasks: [
      {
        localRepoId: "repo-entitlement",
        ownerDesktopId: desktopId,
        ownerLocalTaskId: "task-entitlement",
        title: "Entitlement publication",
        promptSnippet: "Entitlement publication",
        waitingPromptSnippet: null,
        displayName: null,
        stage: "in progress",
        activity: "idle",
        status: "active",
        repo: {
          cloudRepoId: "repo-entitlement",
          name: "Kanna",
          remoteUrl: "git@github.com:kanna/kanna.git",
          remoteUrlHash: "remote-hash",
          defaultBranch: "main",
        },
        branch: "task-entitlement",
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
        createdAt: "2026-08-21 00:00:00",
        updatedAt: "2026-08-21 00:01:00",
        closedAt: null,
      },
    ],
  };
}

/** Authenticate as a desktop and publish one snapshot, returning the ack. */
async function publishAs(
  port: number,
  account: TestAccount,
  id: string,
): Promise<{ ack: Record<string, unknown>; auth: AuthResult }> {
  const auth = await connectAndAuth(port, {
    desktop_id: account.desktopId,
    desktop_secret: account.desktopSecret,
  });
  const ack = waitForMessage(auth.ws, (message) =>
    message.type === "task_snapshot_ack" && message.id === id);
  auth.ws.send(JSON.stringify({
    type: "task_snapshot_publish",
    id,
    snapshot: snapshot(account.desktopId),
  }));
  return { ack: await ack, auth };
}

async function spawnRelay(port: number, enforcement: "on" | "off"): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      FIREBASE_PROJECT_ID: "kanna-local",
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
      PORT: String(port),
      KANNA_RELAY_ENTITLEMENT_ENFORCEMENT: enforcement,
      KANNA_RELAY_ENTITLEMENT_CACHE_TTL_MS: String(ENTITLEMENT_CACHE_TTL_MS),
    },
    detached: true,
    stdio: "pipe",
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[relay:${enforcement}] ${chunk.toString()}`);
  });
  child.stdout?.resume();
  return child;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already exited.
      }
      resolveExit();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolveExit();
    }
  });
}

describe("Relay entitlement enforcement", () => {
  beforeAll(async () => {
    authPort = await findFreePort();
    firestorePort = await findFreePort();
    enforcingPort = await findFreePort();
    permissivePort = await findFreePort();
    const hubPort = await findFreePort();
    const loggingPort = await findFreePort();

    firebaseConfigDir = await mkdtemp(join(tmpdir(), "kanna-entitlement-firebase-"));
    const configPath = join(firebaseConfigDir, "firebase.json");
    await writeFile(
      configPath,
      JSON.stringify({
        firestore: {
          rules: resolve(fileURLToPath(new URL("../../../firestore.rules", import.meta.url))),
        },
        emulators: {
          auth: { host: "127.0.0.1", port: authPort },
          firestore: { host: "127.0.0.1", port: firestorePort },
          hub: { host: "127.0.0.1", port: hubPort },
          logging: { host: "127.0.0.1", port: loggingPort },
          ui: { enabled: false },
        },
      }),
    );
    firebaseProcess = spawn(
      "pnpm",
      ["exec", "firebase", "emulators:start", "--project", "kanna-local", "--config", configPath],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: { ...process.env },
        detached: true,
        stdio: "pipe",
      },
    );
    firebaseProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[firebase] ${chunk.toString()}`);
    });
    firebaseProcess.stdout?.resume();

    process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${firestorePort}`;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${authPort}`;
    adminApp = initializeApp({ projectId: "kanna-local" }, `entitlement-suite-${firestorePort}`);
    db = getFirestore(adminApp);
    const auth = getAuth(adminApp);

    // Wait for the auth emulator, then build every account this suite needs.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await auth.listUsers(1);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    for (const [name, spec] of Object.entries(ACCOUNTS) as [AccountName, typeof ACCOUNTS[AccountName]][]) {
      await auth.createUser({
        uid: spec.uid,
        email: spec.email,
        emailVerified: spec.emailVerified,
        password: PASSWORD,
      });
      const desktopId = `desktop-${spec.uid}`;
      const desktopSecret = `secret-${spec.uid}`;
      await db.doc(`desktopCredentials/${desktopId}`).set({
        desktopId,
        desktopSecretHash: sha256Hex(desktopSecret),
        displayName: "Entitlement Test Mac",
        revokedAt: null,
        uid: spec.uid,
        updatedAt: new Date(0).toISOString(),
      });
      accounts[name] = {
        uid: spec.uid,
        email: spec.email,
        emailVerified: spec.emailVerified,
        desktopId,
        desktopSecret,
        idToken: await signIn(spec.email),
      };
    }

    // The entitlement records, written as the reducer writes them.
    await entitlementRef(accounts.entitled.uid).set(entitlementDoc({}));
    // An unverified account whose subscription is otherwise in good standing:
    // Decision 1 says the relay refuses it anyway.
    await entitlementRef(accounts.unverified.uid).set(entitlementDoc({}));
    // Dunning that ran out: `grace` is still the stored status because nothing
    // sweeps it, so the enforcement-side read is what has to expire it.
    await entitlementRef(accounts.graceExpired.uid).set(entitlementDoc({
      status: "grace",
      graceEndsAt: "2026-08-01T00:00:00.000Z",
    }));
    // …and `accounts.unentitled` deliberately gets no document at all.
    await grantCompAccess(accounts.comped.email);

    enforcingRelay = await spawnRelay(enforcingPort, "on");
    permissiveRelay = await spawnRelay(permissivePort, "off");
    await waitForRelay(enforcingPort);
    await waitForRelay(permissivePort);
  }, 180_000);

  afterAll(async () => {
    await terminateProcessTree(enforcingRelay);
    await terminateProcessTree(permissiveRelay);
    await terminateProcessTree(firebaseProcess);
    if (adminApp) await deleteApp(adminApp);
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (firebaseConfigDir) await rm(firebaseConfigDir, { recursive: true, force: true });
  });

  it("advertises the full capability set to an entitled desktop and publishes", async () => {
    const { ack, auth } = await publishAs(enforcingPort, accounts.entitled, "entitled-publish");

    expect(auth.capabilities.tunnelServices).toEqual(["ksp", "task-transfer"]);
    expect(auth.capabilities.taskSnapshotPublication).toBeDefined();
    expect(auth.capabilities.mobileNotifications).toBeDefined();
    expect(auth.entitlement).toEqual({
      active: true,
      status: "active",
      currentPeriodEndsAt: "2027-01-01T00:00:00.000Z",
      graceEndsAt: null,
    });
    expect(ack).toMatchObject({ ok: true });
    await closeAndWait(auth.ws);
  });

  it("authenticates an unentitled desktop but advertises and serves nothing paid", async () => {
    const { ack, auth } = await publishAs(enforcingPort, accounts.unentitled, "unentitled-publish");

    // Decision 5: the session still completes auth. Closing it would be exactly
    // the generic connection error the neutral inactive state exists to avoid.
    expect(auth.userId).toBe(accounts.unentitled.uid);
    expect(auth.capabilities.tunnelServices).toEqual([]);
    expect(auth.capabilities.taskSnapshotPublication).toBeUndefined();
    expect(auth.capabilities.mobileNotifications).toBeUndefined();
    // Desktop-to-desktop routing is not part of the enforced set, so it stays.
    expect(auth.capabilities.desktopRouting).toBeDefined();
    expect(auth.entitlement).toEqual({
      active: false,
      status: "none",
      currentPeriodEndsAt: null,
      graceEndsAt: null,
    });
    expect(ack).toMatchObject({ ok: false, code: ENTITLEMENT_REQUIRED_CODE });

    const pushAck = waitForMessage(auth.ws, (message) =>
      message.type === "mobile_notification_ack" && message.id === "unentitled-push");
    auth.ws.send(JSON.stringify({
      type: "mobile_notification_publish",
      id: "unentitled-push",
      notification: {
        kind: "task_awaiting_input",
        taskId: "task-entitlement",
        title: "Waiting",
        body: "Ready for review",
      },
    }));
    await expect(pushAck).resolves.toMatchObject({
      ok: false,
      code: ENTITLEMENT_REQUIRED_CODE,
    });
    await closeAndWait(auth.ws);
  });

  it("refuses an unentitled tunnel request with the entitlement code", async () => {
    const auth = await connectAndAuth(enforcingPort, { id_token: accounts.unentitled.idToken });
    expect(auth.capabilities.tunnelServices).toEqual([]);

    const response = waitForMessage(auth.ws, (message) =>
      message.type === "response" && message.id === "unentitled-tunnel");
    auth.ws.send(JSON.stringify({
      type: "tunnel_request",
      id: "unentitled-tunnel",
      desktopId: accounts.unentitled.desktopId,
      service: "task-transfer",
    }));
    await expect(response).resolves.toMatchObject({
      error: "entitlement required",
      code: ENTITLEMENT_REQUIRED_CODE,
    });
    await closeAndWait(auth.ws);
  });

  it("lets an entitled tunnel request through to the router", async () => {
    const auth = await connectAndAuth(enforcingPort, { id_token: accounts.entitled.idToken });

    const response = waitForMessage(auth.ws, (message) =>
      message.type === "response" && message.id === "entitled-tunnel");
    auth.ws.send(JSON.stringify({
      type: "tunnel_request",
      id: "entitled-tunnel",
      desktopId: accounts.entitled.desktopId,
      service: "task-transfer",
    }));
    // No desktop is connected, so the router's own answer is the proof that the
    // request passed the entitlement gate rather than being refused by it.
    const message = await response;
    expect(message.error).toBe("Desktop offline");
    expect(message.code).toBeUndefined();
    await closeAndWait(auth.ws);
  });

  it("refuses an unverified phone token holding an active subscription", async () => {
    const auth = await connectAndAuth(enforcingPort, { id_token: accounts.unverified.idToken });

    expect(auth.capabilities.tunnelServices).toEqual([]);
    expect(auth.entitlement).toMatchObject({
      active: false,
      status: "unknown",
      reason: "unverified_email",
    });
    await closeAndWait(auth.ws);
  });

  it("serves an account the comp seeding script granted", async () => {
    // The entitlement here was derived by the reducer from `billing/comp`, and
    // enforcement never branches on source: it reads status and capabilities.
    const comp = (await db.doc(`users/${accounts.comped.uid}/billing/comp`).get()).data();
    expect(comp).toMatchObject({ source: "comp", active: true, reason: "grandfathered" });

    const { ack, auth } = await publishAs(enforcingPort, accounts.comped, "comped-publish");
    expect(auth.capabilities.tunnelServices).toEqual(["ksp", "task-transfer"]);
    expect(auth.entitlement).toMatchObject({
      active: true,
      status: "active",
      // Comp never expires; only an explicit revocation ends it.
      currentPeriodEndsAt: null,
    });
    expect(ack).toMatchObject({ ok: true });
    await closeAndWait(auth.ws);
  });

  it("refuses a grace record whose grace period has already ended", async () => {
    const { ack, auth } = await publishAs(enforcingPort, accounts.graceExpired, "grace-publish");

    expect(auth.capabilities.tunnelServices).toEqual([]);
    expect(auth.entitlement).toMatchObject({ active: false, status: "grace" });
    expect(ack).toMatchObject({ ok: false, code: ENTITLEMENT_REQUIRED_CODE });
    await closeAndWait(auth.ws);
  });

  it("honours a revocation on a live session within the cache TTL", async () => {
    const first = await publishAs(enforcingPort, accounts.entitled, "revoke-before");
    expect(first.ack).toMatchObject({ ok: true });

    try {
      await entitlementRef(accounts.entitled.uid).set(entitlementDoc({
        status: "revoked",
        capabilities: [],
      }));

      const publish = async (id: string): Promise<Record<string, unknown>> => {
        const ack = waitForMessage(first.auth.ws, (message) =>
          message.type === "task_snapshot_ack" && message.id === id);
        first.auth.ws.send(JSON.stringify({
          type: "task_snapshot_publish",
          id,
          snapshot: snapshot(accounts.entitled.desktopId),
        }));
        return await ack;
      };

      // Inside the window the open session keeps the entitlement it was granted.
      expect(await publish("revoke-inside-ttl")).toMatchObject({ ok: true });

      // The TTL is the revocation bound, so it must actually bind — without a
      // reconnect, and without the relay polling anything.
      await new Promise((r) => setTimeout(r, ENTITLEMENT_CACHE_TTL_MS + 250));
      expect(await publish("revoke-after-ttl")).toMatchObject({
        ok: false,
        code: ENTITLEMENT_REQUIRED_CODE,
      });
    } finally {
      await entitlementRef(accounts.entitled.uid).set(entitlementDoc({}));
      await closeAndWait(first.auth.ws);
    }
  });

  it("changes nothing at all with the flag off", async () => {
    // The same account that is refused everything by the enforcing relay.
    const { ack, auth } = await publishAs(permissivePort, accounts.unentitled, "flag-off-publish");

    expect(auth.capabilities.tunnelServices).toEqual(["ksp", "task-transfer"]);
    expect(auth.capabilities.taskSnapshotPublication).toBeDefined();
    expect(auth.capabilities.mobileNotifications).toBeDefined();
    // Absent, not `false`: with enforcement off `auth_ok` keeps its old shape.
    expect(auth.entitlement).toBeUndefined();
    expect(ack).toMatchObject({ ok: true });
    await closeAndWait(auth.ws);

    const phone = await connectAndAuth(permissivePort, { id_token: accounts.unverified.idToken });
    expect(phone.capabilities.tunnelServices).toEqual(["ksp", "task-transfer"]);
    expect(phone.entitlement).toBeUndefined();
    await closeAndWait(phone.ws);
  });
});
