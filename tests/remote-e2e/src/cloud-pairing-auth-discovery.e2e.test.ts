import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUFFY_UID, waitForBuffyIdToken } from "./firebaseAuth";
import { startRemoteHarness, type RemoteHarness } from "./harness";

interface PairingSessionResponse {
  code: string;
  desktopId: string;
  desktopName: string;
}

interface CreatePairingCodeResponse {
  pairingCode: string;
  pairingCodeId: string;
  desktopId: string;
  desktopSecret: string;
  desktopClaimToken: string;
  expiresAt: string;
}

interface ClaimPairingCodeResponse {
  desktopId: string;
  uid: string;
}

interface FirestoreDocument {
  fields?: Record<string, FirestoreValue>;
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  nullValue?: null;
  booleanValue?: boolean;
}

interface DesktopDescriptor {
  id: string;
  name: string;
  connectionMode: string;
}

interface AuthAttempt {
  outcome: "auth_ok" | "closed";
  userId?: string;
  closeCode?: number;
}

const DESKTOP_NAME = "Remote E2E Desktop";
const DEVICE_TOKEN = "e2e-token";

describe("remote cloud pairing, auth, and discovery E2E", () => {
  let harness: RemoteHarness;

  beforeAll(async () => {
    harness = await startRemoteHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  }, 30_000);

  it("pairs a desktop through cloud functions and reconnects kanna-server with the issued desktop credentials", async () => {
    const localPairing = asPairingSession(await harness.client.invokeDesktop({
      desktopId: harness.desktopId,
      method: "POST",
      path: "/v1/pairing/sessions",
      body: null
    }));
    expect(localPairing).toMatchObject({
      desktopId: harness.desktopId,
      desktopName: DESKTOP_NAME
    });
    expect(localPairing.code).toMatch(/^[0-9A-F]{6}$/);

    const created = asCreatePairingCodeResponse(await callFunction(harness, "createPairingCode", {
      desktopName: localPairing.desktopName
    }));
    expect(created).toMatchObject({
      pairingCode: expect.stringMatching(/^[0-9A-Z]{6}$/),
      pairingCodeId: expect.any(String),
      desktopId: expect.stringMatching(/^desktop-/),
      desktopSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      desktopClaimToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: expect.any(String)
    });

    const pairingCodeDoc = await readFirestoreDocument(harness, `pairingCodes/${created.pairingCodeId}`);
    expect(stringField(pairingCodeDoc, "pairingCode")).toBe(created.pairingCode);
    expect(stringField(pairingCodeDoc, "desktopId")).toBe(created.desktopId);
    expect(stringField(pairingCodeDoc, "status")).toBe("pending");
    expect(stringField(pairingCodeDoc, "desktopClaimTokenHash")).toBe(sha256Hex(created.desktopClaimToken));

    const pendingDesktopDoc = await readFirestoreDocument(harness, `pendingDesktops/${created.desktopId}`);
    expect(stringField(pendingDesktopDoc, "pairingCodeId")).toBe(created.pairingCodeId);
    expect(stringField(pendingDesktopDoc, "desktopName")).toBe(localPairing.desktopName);
    expect(stringField(pendingDesktopDoc, "desktopSecretHash")).toBe(sha256Hex(created.desktopSecret));
    expect(stringField(pendingDesktopDoc, "desktopSecret")).toBeNull();

    const idToken = await waitForBuffyIdToken(harness.ports.auth, 10_000);
    const claimed = asClaimPairingCodeResponse(await callFunction(harness, "claimPairingCode", {
      pairingCode: created.pairingCode
    }, idToken));
    expect(claimed).toEqual({
      desktopId: created.desktopId,
      uid: BUFFY_UID
    });

    const desktopDoc = await readFirestoreDocument(harness, `users/${BUFFY_UID}/desktops/${created.desktopId}`);
    expect(stringField(desktopDoc, "desktopId")).toBe(created.desktopId);
    expect(stringField(desktopDoc, "displayName")).toBe(localPairing.desktopName);
    expect(stringField(desktopDoc, "desktopSecretHash")).toBe(sha256Hex(created.desktopSecret));
    expect(stringField(desktopDoc, "desktopSecret")).toBeNull();

    await expect(callFunction(harness, "claimPairingCode", {
      pairingCode: created.pairingCode
    }, idToken)).rejects.toThrow(/already claimed|claimed|unavailable/i);

    await harness.restartServerWithIdentity({
      desktopId: created.desktopId,
      desktopSecret: created.desktopSecret
    });
    await harness.waitForDesktop(created.desktopId);

    const status = await harness.client.invokeDesktop({
      desktopId: created.desktopId,
      method: "GET",
      path: "/v1/status",
      body: null
    });
    expect(status).toMatchObject({
      desktopId: created.desktopId,
      desktopName: localPairing.desktopName,
      state: "running"
    });

    const serverToml = await readFile(harness.paths.configPath, "utf8");
    expect(serverToml).toContain(`desktop_id = "${created.desktopId}"`);
    expect(serverToml).toContain(`desktop_secret = "${created.desktopSecret}"`);
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
      id_token: await waitForBuffyIdToken(harness.ports.auth, 10_000)
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
    await seedDesktopCredential(harness, {
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
    await seedDesktopCredential(harness, {
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

  it("lists desktops through the relay and observes relay presence flip as kanna-server disconnects and reconnects", async () => {
    const desktopId = `desktop-discovery-${Date.now()}`;
    const desktopSecret = sha256Hex(`${desktopId}:secret`);
    await seedDesktopCredential(harness, {
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
    expect(descriptors).toEqual([
      {
        id: desktopId,
        name: DESKTOP_NAME,
        connectionMode: "both"
      }
    ]);

    await expectActiveDesktopIds(harness, [desktopId]);

    await harness.stopServer();
    await expectActiveDesktopIds(harness, []);

    await harness.startServer();
    await harness.waitForDesktop(desktopId);
    await expectActiveDesktopIds(harness, [desktopId]);
  }, 90_000);
});

async function callFunction(
  harness: RemoteHarness,
  name: "createPairingCode" | "claimPairingCode",
  data: Record<string, unknown>,
  idToken?: string
): Promise<unknown> {
  const urls = [
    `http://127.0.0.1:${harness.ports.functions}/kanna-local/us-central1/${name}`,
    `http://127.0.0.1:${harness.ports.functions}/kanna-local/us-central1/${name}/`,
    `http://127.0.0.1:${harness.ports.functions}/${name}`,
    `http://127.0.0.1:${harness.ports.functions}/${name}/`
  ];
  let lastFailure = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const url of urls) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
        },
        body: JSON.stringify({ data })
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        lastFailure = `${response.status}: ${JSON.stringify(body)}`;
        if (response.status === 404) {
          continue;
        }
        throw new Error(`function ${name} failed with ${lastFailure}`);
      }
      if (!isRecord(body) || !("result" in body)) {
        throw new Error(`function ${name} returned invalid callable body: ${JSON.stringify(body)}`);
      }
      return body.result;
    }
    await sleep(250);
  }
  throw new Error(`function ${name} failed with ${lastFailure}`);
}

async function readFirestoreDocument(harness: RemoteHarness, path: string): Promise<FirestoreDocument> {
  const response = await fetch(`${firestoreBaseUrl(harness)}/${path}`, {
    headers: { Authorization: "Bearer owner" }
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

async function seedDesktopCredential(
  harness: RemoteHarness,
  input: {
    desktopId: string;
    desktopSecret: string;
    displayName: string;
    revokedAt?: string;
  }
): Promise<void> {
  const body = {
    fields: {
      desktopId: { stringValue: input.desktopId },
      displayName: { stringValue: input.displayName },
      desktopSecretHash: { stringValue: sha256Hex(input.desktopSecret) },
      updatedAt: { stringValue: new Date().toISOString() },
      ...(input.revokedAt ? { revokedAt: { stringValue: input.revokedAt } } : {})
    }
  };
  const response = await fetch(`${firestoreBaseUrl(harness)}/users/${BUFFY_UID}/desktops/${input.desktopId}`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer owner",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`failed to seed desktop credential: ${response.status} ${await response.text()}`);
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

function asPairingSession(value: unknown): PairingSessionResponse {
  if (!isRecord(value)) {
    throw new Error("pairing session response was not an object");
  }
  const code = requiredString(value, "code");
  const desktopId = requiredString(value, "desktopId");
  const desktopName = requiredString(value, "desktopName");
  return { code, desktopId, desktopName };
}

function asCreatePairingCodeResponse(value: unknown): CreatePairingCodeResponse {
  if (!isRecord(value)) {
    throw new Error("createPairingCode response was not an object");
  }
  return {
    pairingCode: requiredString(value, "pairingCode"),
    pairingCodeId: requiredString(value, "pairingCodeId"),
    desktopId: requiredString(value, "desktopId"),
    desktopSecret: requiredString(value, "desktopSecret"),
    desktopClaimToken: requiredString(value, "desktopClaimToken"),
    expiresAt: requiredString(value, "expiresAt")
  };
}

function asClaimPairingCodeResponse(value: unknown): ClaimPairingCodeResponse {
  if (!isRecord(value)) {
    throw new Error("claimPairingCode response was not an object");
  }
  return {
    desktopId: requiredString(value, "desktopId"),
    uid: requiredString(value, "uid")
  };
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
      connectionMode: requiredString(entry, "connectionMode")
    };
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
