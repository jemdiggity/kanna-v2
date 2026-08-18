import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteTransport } from "../../../apps/mobile/src/lib/transports/remoteTransport";
import {
  agentProviderOptionsForDesktop,
  parseAgentProviderInventory
} from "../../../apps/mobile/src/lib/api/agentProviders";
import { createAppModel, type AppModel } from "../../../apps/mobile/src/appModel";
import { createStaticBonjourBrowser } from "../../../apps/mobile/src/lib/discovery/bonjour";
import {
  createMobileAuthSession,
  type MobileAuthSdk,
  type MobileAuthSession,
  type MobileAuthUser
} from "../../../apps/mobile/src/lib/firebase/auth";
import type {
  CloudDesktopRecord,
  CloudTaskIndex
} from "../../../apps/mobile/src/lib/firebase/taskIndex";
import {
  buildMachineInventory,
  summarizeMachines,
  type MobileMachine
} from "../../../apps/mobile/src/state/machineInventory";
import {
  BUFFY_EMAIL,
  BUFFY_PASSWORD,
  BUFFY_UID,
  signInWithPassword
} from "./firebaseAuth";
import { createNodeRelayDesktopClient } from "./nodeRelayClient";
import {
  hostInstalledAgentProviders,
  startRemoteHarness,
  type RemoteHarness
} from "./harness";

interface PairingSessionResponse {
  code: string;
  desktopId: string;
  desktopName: string;
}

interface FirestoreDocument {
  fields?: Record<string, FirestoreValue>;
}

interface FirestoreValue {
  stringValue?: string;
  timestampValue?: string;
  nullValue?: null;
  arrayValue?: { values?: FirestoreValue[] };
}

interface DesktopDescriptor {
  id: string;
  name: string;
  connectionMode: string;
  agentProviders?: string[];
}

interface AuthAttempt {
  outcome: "auth_ok" | "closed";
  userId?: string;
  closeCode?: number;
}

const DESKTOP_NAME = "Remote E2E Desktop";

describe("remote desktop credential auth and discovery E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("publishes Buffy-owned desktop credentials and reconnects kanna-server with desktop secret relay auth", async () => {
    const localPairing = asPairingSession(
      await harness.createDesktopPairingSession()
    );
    expect(localPairing).toMatchObject({
      desktopId: harness.desktopId,
      desktopName: DESKTOP_NAME
    });
    expect(localPairing.code).toMatch(/^[0-9A-F]{6}$/);

    const desktopId = `desktop-cloud-bootstrap-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId,
      desktopSecret,
      displayName: localPairing.desktopName
    });

    const desktopDoc = await readFirestoreDocument(
      harness,
      `desktopCredentials/${desktopDocId(desktopId)}`,
      "owner"
    );
    expect(stringField(desktopDoc, "desktopId")).toBe(desktopId);
    expect(stringField(desktopDoc, "displayName")).toBe(localPairing.desktopName);
    expect(stringField(desktopDoc, "desktopSecretHash")).toBe(sha256Hex(desktopSecret));
    expect(stringField(desktopDoc, "desktopSecret")).toBeNull();

    await harness.restartServerWithIdentity({ desktopId, desktopSecret });
    await harness.waitForDesktop(desktopId);

    const status = await harness.client.invokeDesktop({
      desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });
    expect(status).toMatchObject({
      desktopId,
      desktopName: localPairing.desktopName,
      state: "running"
    });

    const serverToml = await readFile(harness.paths.configPath, "utf8");
    expect(serverToml).toContain(`desktop_id = "${desktopId}"`);
    expect(serverToml).toContain(`desktop_secret = "${desktopSecret}"`);
    expect(serverToml).toContain("pairing_store_path = ");
  }, 90_000);

  it("authenticates the full stack with device tokens, desktop credentials, and Firebase ID tokens while rejecting bad credentials", async () => {
    await harness.restartServerWithIdentity({ desktopId: harness.desktopId });
    await harness.waitForDesktop(harness.desktopId);

    const legacyStatus = await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });
    expect(legacyStatus).toMatchObject({
      desktopId: harness.desktopId,
      state: "running"
    });

    const phoneAuth = await attemptRelayAuth(harness, {
      type: "auth",
      id_token: await harness.getIdToken()
    });
    expect(phoneAuth).toEqual({ outcome: "auth_ok", userId: BUFFY_UID });

    const badDevice = await attemptRelayAuth(harness, {
      type: "auth",
      device_token: "missing-device-token",
      desktop_id: "bad-device-desktop"
    });
    expect(badDevice).toEqual({ outcome: "closed", closeCode: 4005 });

    const desktopId = `desktop-auth-matrix-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId,
      desktopSecret,
      displayName: DESKTOP_NAME
    });

    await harness.restartServerWithIdentity({ desktopId, desktopSecret });
    await harness.waitForDesktop(desktopId);
    const credentialStatus = await harness.client.invokeDesktop({
      desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });
    expect(credentialStatus).toMatchObject({
      desktopId,
      state: "running"
    });

    const badSecret = await attemptRelayAuth(harness, {
      type: "auth",
      desktop_id: desktopId,
      desktop_secret: "wrong-secret"
    });
    expect(badSecret).toEqual({ outcome: "closed", closeCode: 4005 });

    const revokedDesktopId = `${desktopId}-revoked`;
    const revokedSecret = sha256Hex(`${desktopId}:revoked`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId: revokedDesktopId,
      desktopSecret: revokedSecret,
      displayName: "Revoked Desktop",
      revokedAt: new Date().toISOString()
    });
    const revoked = await attemptRelayAuth(harness, {
      type: "auth",
      desktop_id: revokedDesktopId,
      desktop_secret: revokedSecret
    });
    expect(revoked).toEqual({ outcome: "closed", closeCode: 4005 });

    const badPhone = await attemptRelayAuth(harness, {
      type: "auth",
      id_token: "not-a-firebase-id-token"
    });
    expect(badPhone).toEqual({ outcome: "closed", closeCode: 4005 });
  }, 90_000);

  // The transport App Review actually used: a phone off the LAN, reaching a Mac
  // through the relay. Nothing else runs this chain end to end — the desktop
  // publishing its real inventory, the relay validating and storing it, and the
  // phone's machine record carrying it into the composer's agent options. Each
  // hop has a unit test; none of them proves they agree.
  it("carries the desktop's real agent inventory through the relay into the phone's machine record", async () => {
    const desktopId = `desktop-inventory-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId,
      desktopSecret,
      displayName: DESKTOP_NAME
    });
    // Cloud task publication only runs for a desktop-secret identity, which is
    // what a phone-paired Mac has.
    await harness.restartServerWithIdentity({ desktopId, desktopSecret });
    await harness.waitForDesktop(desktopId);

    const published = await waitForPublishedAgentProviders(harness, desktopId);
    expectHarnessAgentProviders(published);

    // From here on it is the phone's own code, over the record the relay wrote:
    // the same parse the Firestore desktop index applies, the real remote
    // transport, and the composer's option list.
    const agentProviders = parseAgentProviderInventory(published);
    expect(agentProviders).toEqual(published);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId,
          displayName: DESKTOP_NAME,
          online: true,
          reachableViaRelay: true,
          connectionMode: "internet",
          ...(agentProviders ? { agentProviders } : {})
        }
      ],
      getSelectedDesktopId: () => desktopId,
      invokeDesktop: (request) => harness.client.invokeDesktop(request)
    });
    const [machine] = await transport.listDesktops();
    expect(machine.agentProviders).toEqual(agentProviders);

    const offered = agentProviderOptionsForDesktop(machine);
    expect(offered).toContain("codex");
    // The reviewer's failure: a machine without Claude must not offer Claude.
    if (!published.includes("claude")) {
      expect(offered).not.toContain("claude");
    }
  }, 90_000);

  it("lists desktops through the relay and observes relay presence flip as kanna-server disconnects and reconnects", async () => {
    const desktopId = `desktop-discovery-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId,
      desktopSecret,
      displayName: DESKTOP_NAME
    });
    await harness.restartServerWithIdentity({ desktopId, desktopSecret });
    await harness.waitForDesktop(desktopId);

    const descriptors = asDesktopDescriptors(await harness.client.invokeDesktop({
      desktopId,
      method: "GET",
      path: "/v1/desktops",
      body: null
    }));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: desktopId,
      name: DESKTOP_NAME,
      connectionMode: "both"
    });
    expectHarnessAgentProviders(descriptors[0].agentProviders);

    await expectActiveDesktopIds(harness, [desktopId]);

    await harness.stopServer();
    await expectActiveDesktopIds(harness, []);

    await harness.startServer();
    await harness.waitForDesktop(desktopId);
    await expectActiveDesktopIds(harness, [desktopId]);
  }, 90_000);

  it("stops reporting the account's machines once the phone signs out", async () => {
    const desktopId = `desktop-signout-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await publishDesktopCredentialAsBuffy(harness, {
      desktopId,
      desktopSecret,
      displayName: DESKTOP_NAME
    });
    await harness.restartServerWithIdentity({ desktopId, desktopSecret });
    await harness.waitForDesktop(desktopId);

    const authSession = createEmulatorAuthSession(harness);
    await authSession.signInWithEmailPassword({
      email: BUFFY_EMAIL,
      password: BUFFY_PASSWORD
    });
    expect(authSession.getState()).toMatchObject({
      status: "signedIn",
      user: { uid: BUFFY_UID }
    });

    // A desktop read can be held open here, the way a Firestore read that
    // left before sign-out is still in flight when the account goes away.
    let holdDesktopRead: Promise<void> | null = null;
    const app = createAppModel({
      authSession,
      persistence: {
        load: async () => null,
        save: async () => undefined
      },
      options: {
        forceCloud: true,
        relayUrl: harness.relayUrl,
        taskIndex: createAccountDesktopIndex(harness, authSession, () => holdDesktopRead),
        bonjourBrowser: createStaticBonjourBrowser([]),
        createRelayClient: ({ relayUrl, getIdToken }) =>
          createNodeRelayDesktopClient({ relayUrl, getIdToken })
      }
    });

    try {
      await app.initialize();
      await waitForMachines(app, (machines) =>
        machines.some(
          (machine) =>
            machine.desktopId === desktopId &&
            machine.origins.account &&
            machine.availability.cloud
        )
      );

      let releaseDesktopRead!: () => void;
      holdDesktopRead = new Promise<void>((resolve) => {
        releaseDesktopRead = resolve;
      });
      const heldRead = app.client.listDesktops().catch(() => undefined);

      await app.controller.signOut();

      expect(machinesOf(app)).toEqual([]);
      expect(summarizeMachines(machinesOf(app))).toEqual({
        total: 0,
        available: 0
      });

      releaseDesktopRead();
      await heldRead;
      await sleep(500);

      expect(app.sessionStore.getState().accountDesktops).toEqual([]);
      expect(machinesOf(app)).toEqual([]);
      expect(summarizeMachines(machinesOf(app))).toEqual({
        total: 0,
        available: 0
      });
    } finally {
      app.controller.dispose();
    }
  }, 90_000);
});

/**
 * The phone's Firebase auth session, backed by the emulator's real Buffy
 * credentials: sign-in mints a real ID token, and sign-out drops it exactly
 * the way the shipped Firebase SDK adapter does.
 */
function createEmulatorAuthSession(harness: RemoteHarness): MobileAuthSession {
  const listeners = new Set<(user: MobileAuthUser | null) => void>();
  let user: MobileAuthUser | null = null;
  let idToken: string | null = null;
  const publish = () => {
    for (const listener of listeners) listener(user);
  };
  const sdk: MobileAuthSdk = {
    getCurrentUser: () => user,
    onAuthStateChanged(listener) {
      listeners.add(listener);
      listener(user);
      return () => {
        listeners.delete(listener);
      };
    },
    async signInWithEmailPassword(email, password) {
      const signIn = await signInWithPassword({
        authPort: harness.ports.auth,
        email,
        password
      });
      if (!signIn?.idToken) {
        throw new Error("Firebase Auth emulator rejected the phone's sign-in");
      }
      idToken = signIn.idToken;
      user = { uid: signIn.localId ?? BUFFY_UID, email, displayName: null };
      publish();
      return user;
    },
    async signOut() {
      user = null;
      idToken = null;
      publish();
    },
    async getIdToken() {
      return idToken;
    }
  };
  return createMobileAuthSession({ sdk });
}

/**
 * The desktop records the relay published for this account, read from
 * Firestore with the phone's own ID token. `hold` models a read that is
 * already in flight: the credential is captured when the read starts, and the
 * request completes whenever the test releases it.
 */
function createAccountDesktopIndex(
  harness: RemoteHarness,
  authSession: MobileAuthSession,
  hold: () => Promise<void> | null
): CloudTaskIndex {
  return {
    async listDesktops(uid) {
      const idToken = await authSession.getIdToken();
      await hold();
      if (!idToken) {
        throw new Error("the phone holds no account credential");
      }
      const response = await fetch(
        `${firestoreBaseUrl(harness)}/users/${uid}/desktops`,
        { headers: { Authorization: `Bearer ${idToken}` } }
      );
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        throw new Error(
          `failed to list account desktops: ${response.status} ${JSON.stringify(body)}`
        );
      }
      return asCloudDesktopRecords(body);
    },
    async listRecentTasks() {
      return [];
    },
    subscribeRecentTasks(_uid, onUpdate) {
      onUpdate([]);
      return () => undefined;
    }
  };
}

function asCloudDesktopRecords(value: unknown): CloudDesktopRecord[] {
  if (!isRecord(value) || !Array.isArray(value.documents)) {
    return [];
  }
  return value.documents.flatMap((entry): CloudDesktopRecord[] => {
    if (!isRecord(entry)) return [];
    const document = entry as FirestoreDocument;
    const desktopId = stringField(document, "desktopId");
    if (!desktopId) return [];
    const agentProviders = parseAgentProviderInventory(
      stringArrayField(document, "agentProviders") ?? undefined
    );
    return [{
      desktopId,
      displayName: stringField(document, "displayName") ?? desktopId,
      updatedAt: timestampField(document, "updatedAt"),
      ...(agentProviders ? { agentProviders } : {})
    }];
  });
}

/** The machine list the phone's Machines screen renders, from its own state. */
function machinesOf(app: AppModel): MobileMachine[] {
  const state = app.sessionStore.getState();
  return buildMachineInventory({
    accountDesktops: state.accountDesktops,
    manualDesktops: state.trustedDesktops,
    liveLanDesktops: state.liveLanDesktops
  });
}

/**
 * Poll the machine list, re-reading desktops the way the app's own refresh
 * does: relay presence settles after the first read, so the account record
 * only reports as reachable once a later read maps it.
 */
async function waitForMachines(
  app: AppModel,
  predicate: (machines: MobileMachine[]) => boolean,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastMachines: MobileMachine[] = [];
  while (Date.now() < deadline) {
    lastMachines = machinesOf(app);
    if (predicate(lastMachines)) return;
    await app.client.listDesktops().catch(() => undefined);
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for the expected machine list: ${JSON.stringify(lastMachines)}`
  );
}

async function readFirestoreDocument(
  harness: RemoteHarness,
  path: string,
  idToken: string
): Promise<FirestoreDocument> {
  const response = await fetch(`${firestoreBaseUrl(harness)}/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new Error(`failed to read Firestore document ${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  if (!isRecord(body)) {
    throw new Error(`Firestore document ${path} returned invalid body`);
  }
  return body as FirestoreDocument;
}

async function publishDesktopCredentialAsBuffy(
  harness: RemoteHarness,
  input: {
    desktopId: string;
    desktopSecret: string;
    displayName: string;
    revokedAt?: string;
  }
): Promise<void> {
  const idToken = await harness.getIdToken();
  const body = {
    fields: {
      desktopId: { stringValue: input.desktopId },
      displayName: { stringValue: input.displayName },
      desktopSecretHash: { stringValue: sha256Hex(input.desktopSecret) },
      revokedAt: input.revokedAt
        ? { stringValue: input.revokedAt }
        : { nullValue: null },
      uid: { stringValue: BUFFY_UID },
      updatedAt: { stringValue: new Date().toISOString() },
    }
  };
  const response = await fetch(
    `${firestoreBaseUrl(harness)}/desktopCredentials/${desktopDocId(input.desktopId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    throw new Error(`failed to publish desktop credential as Buffy: ${response.status} ${await response.text()}`);
  }
}

async function attemptRelayAuth(
  harness: RemoteHarness,
  payload: Record<string, unknown>
): Promise<AuthAttempt> {
  return await new Promise<AuthAttempt>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${harness.ports.relay}`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for relay auth result"));
    }, 10_000);

    socket.on("open", () => {
      socket.send(JSON.stringify(payload));
    });
    socket.on("message", (data: RawData) => {
      const message = parseJsonRecord(data.toString());
      if (message?.type === "auth_ok" && typeof message.userId === "string") {
        clearTimeout(timeout);
        socket.close(1000);
        resolve({ outcome: "auth_ok", userId: message.userId });
      }
    });
    socket.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ outcome: "closed", closeCode: code });
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function expectActiveDesktopIds(harness: RemoteHarness, expectedIds: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastIds: string[] = [];
  while (Date.now() < deadline) {
    const ids = Array.from(await harness.client.listActiveDesktopIds()).sort();
    lastIds = ids;
    if (JSON.stringify(ids) === JSON.stringify([...expectedIds].sort())) {
      return;
    }
    await sleep(250);
  }
  expect(lastIds).toEqual([...expectedIds].sort());
}

function firestoreBaseUrl(harness: RemoteHarness): string {
  return `http://127.0.0.1:${harness.ports.firestore}/v1/projects/kanna-local/databases/(default)/documents`;
}

function desktopDocId(desktopId: string): string {
  return desktopId.replace(/\//g, "_");
}

function asPairingSession(value: unknown): PairingSessionResponse {
  if (!isRecord(value)) {
    throw new Error("pairing session response was not an object");
  }
  const code = requiredString(value, "code");
  const desktopId = requiredString(value, "desktopId");
  const desktopName = requiredString(value, "desktopName");
  return { code, desktopId, desktopName };
}

function asDesktopDescriptors(value: unknown): DesktopDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error("desktop descriptors response was not an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("desktop descriptor was not an object");
    }
    return {
      id: requiredString(entry, "id"),
      name: requiredString(entry, "name"),
      connectionMode: requiredString(entry, "connectionMode"),
      ...(Array.isArray(entry.agentProviders)
        ? { agentProviders: entry.agentProviders.map(String) }
        : {})
    };
  });
}

/**
 * The harness server runs with only its stub `codex` reachable
 * (`serverProviderPath`), so anything describing it must name codex and must
 * not name a provider this host does not also expose in the directories
 * executable resolution probes globally.
 */
function expectHarnessAgentProviders(reported: string[] | undefined): void {
  expect(reported).toBeDefined();
  expect(reported).toContain("codex");
  const unavoidable = new Set(["codex", ...hostInstalledAgentProviders()]);
  expect(
    (reported ?? []).filter((provider) => !unavoidable.has(provider))
  ).toEqual([]);
}

/**
 * The relay writes the desktop document from the snapshot `kanna-server`
 * publishes, on a 500ms poll, so the first read can land before the first
 * publication.
 */
async function waitForPublishedAgentProviders(
  harness: RemoteHarness,
  desktopId: string,
  timeoutMs = 30_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no cloud desktop document was published";
  while (Date.now() < deadline) {
    try {
      const document = await readFirestoreDocument(
        harness,
        `users/${BUFFY_UID}/desktops/${desktopDocId(desktopId)}`,
        await harness.getIdToken()
      );
      const published = stringArrayField(document, "agentProviders");
      if (published) return published;
      lastError = "the published desktop document carried no agentProviders";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for a published agent inventory: ${lastError}`);
}

function stringArrayField(
  document: FirestoreDocument,
  field: string
): string[] | null {
  const values = document.fields?.[field]?.arrayValue?.values;
  if (!values) return null;
  return values.map((value) => {
    if (typeof value.stringValue !== "string") {
      throw new Error(`${field} held a non-string entry`);
    }
    return value.stringValue;
  });
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing string field ${field}`);
  }
  return value;
}

function stringField(document: FirestoreDocument, field: string): string | null {
  const value = document.fields?.[field];
  return value?.stringValue ?? null;
}

function timestampField(document: FirestoreDocument, field: string): string | null {
  const value = document.fields?.[field];
  return value?.timestampValue ?? value?.stringValue ?? null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
