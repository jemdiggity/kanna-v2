import { randomBytes } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { buildPairingArtifacts } from "./pairing.js";
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

export { buildPairingArtifacts, emulatorPorts };
