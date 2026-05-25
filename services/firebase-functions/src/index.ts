import { randomBytes } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { buildPairingArtifacts } from "./pairing.js";
import { buildTaskSnapshotWrite } from "./taskSnapshots.js";
import { emulatorPorts, type CreatePairingCodeRequest } from "./types.js";

const PAIRING_TTL_MS = 5 * 60 * 1000;

function ensureFirebaseApp(): void {
  if (getApps().length === 0) {
    initializeApp();
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function randomPairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

async function requireBearerUidFromHeader(
  authorization: string | undefined
): Promise<string> {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Missing bearer token");
  }

  ensureFirebaseApp();
  const decoded = await getAuth().verifyIdToken(match[1]!);
  return decoded.uid;
}

export const createPairingCode = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (request.body ?? {}) as Partial<CreatePairingCodeRequest>;
  const desktopDisplayName = body.desktopDisplayName?.trim() || "Kanna Desktop";

  const artifacts = buildPairingArtifacts({
    desktopDisplayName,
    now: new Date(),
    expiresInMs: PAIRING_TTL_MS,
    pairingCode: randomPairingCode(),
    pairingCodeId: `pairing-${randomHex(12)}`,
    desktopId: `desktop-${randomHex(12)}`,
    desktopSecret: randomHex(32),
    desktopClaimToken: randomHex(32),
  });

  ensureFirebaseApp();
  const db = getFirestore();

  await db.collection("pairingCodes").doc(artifacts.response.pairingCodeId).set(
    artifacts.pairingRecord
  );
  await db.collection("pendingDesktops").doc(artifacts.response.desktopId).set(
    artifacts.desktopRecord
  );

  response.status(200).json(artifacts.response);
});

export const upsertTaskSnapshot = onRequest(async (request, response) => {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  let uid: string;
  try {
    uid = await requireBearerUidFromHeader(request.header("authorization"));
  } catch (error) {
    response.status(401).json({
      error: error instanceof Error ? error.message : "Unauthorized",
    });
    return;
  }

  try {
    const write = buildTaskSnapshotWrite(uid, request.body);
    ensureFirebaseApp();
    await getFirestore().doc(write.path).set(write.data, { merge: true });
    response.status(200).json({ ok: true, cloudTaskId: write.data.cloudTaskId });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid task snapshot",
    });
  }
});

export { buildPairingArtifacts, emulatorPorts };
