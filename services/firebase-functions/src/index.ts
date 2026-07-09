import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { https } from "firebase-functions/v1";

const PAIRING_TTL_MS = 5 * 60 * 1000;

interface PairingCodeDocument {
  pairingCode: string;
  desktopId: string;
  desktopName: string;
  desktopClaimTokenHash: string;
  status: "pending" | "claimed";
  expiresAt: string;
  createdAt: string;
  claimedAt: string | null;
  claimedByUid: string | null;
}

interface PendingDesktopDocument {
  desktopId: string;
  desktopName: string;
  desktopSecretHash: string;
  desktopClaimTokenHash: string;
  pairingCodeId: string;
  status: "pending" | "claimed";
  expiresAt: string;
  createdAt: string;
  claimedAt: string | null;
  claimedByUid: string | null;
}

if (getApps().length === 0) {
  initializeApp();
}

class FunctionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const createPairingCode = https.onRequest(async (request, response) => {
  await handleFunctionRequest(request.method, request.body, response, async (data) => {
    return await createPairingCodeBody(data);
  });
});

export const claimPairingCode = https.onRequest(async (request, response) => {
  await handleFunctionRequest(request.method, request.body, response, async (data) => {
    const uid = await requireUidFromAuthorization(request.header("authorization"));
    return await claimPairingCodeBody(data, uid);
  });
});

async function createPairingCodeBody(data: Record<string, unknown>): Promise<Record<string, string>> {
  const desktopName = optionalString(data.desktopName) ?? "Kanna Desktop";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
  const createdAt = now.toISOString();
  const pairingCode = generatePairingCode();
  const pairingCodeId = randomUUID();
  const desktopId = `desktop-${randomUUID()}`;
  const desktopSecret = randomBytes(32).toString("hex");
  const desktopClaimToken = randomBytes(32).toString("hex");
  const desktopSecretHash = sha256Hex(desktopSecret);
  const desktopClaimTokenHash = sha256Hex(desktopClaimToken);
  const db = getFirestore();

  const pairingDoc: PairingCodeDocument = {
    pairingCode,
    desktopId,
    desktopName,
    desktopClaimTokenHash,
    status: "pending",
    expiresAt,
    createdAt,
    claimedAt: null,
    claimedByUid: null
  };
  const pendingDoc: PendingDesktopDocument = {
    desktopId,
    desktopName,
    desktopSecretHash,
    desktopClaimTokenHash,
    pairingCodeId,
    status: "pending",
    expiresAt,
    createdAt,
    claimedAt: null,
    claimedByUid: null
  };

  await db.runTransaction(async (transaction) => {
    transaction.set(db.collection("pairingCodes").doc(pairingCodeId), pairingDoc);
    transaction.set(db.collection("pendingDesktops").doc(desktopId), pendingDoc);
  });

  return {
    pairingCode,
    pairingCodeId,
    desktopId,
    desktopSecret,
    desktopClaimToken,
    expiresAt
  };
}

async function claimPairingCodeBody(
  data: Record<string, unknown>,
  uid: string
): Promise<Record<string, string>> {
  const pairingCode = requiredString(data, "pairingCode").trim().toUpperCase();
  const db = getFirestore();
  const matchingCodes = await db
    .collection("pairingCodes")
    .where("pairingCode", "==", pairingCode)
    .limit(1)
    .get();

  const pairingSnapshot = matchingCodes.docs[0];
  if (!pairingSnapshot) {
    throw new FunctionHttpError(404, "not-found", "Pairing code was not found.");
  }

  return await db.runTransaction(async (transaction) => {
    const pairingRef = pairingSnapshot.ref;
    const pairingRead = await transaction.get(pairingRef);
    const pairing = asPairingCodeDocument(pairingRead.data());
    if (pairing.status !== "pending") {
      throw new FunctionHttpError(409, "failed-precondition", "Pairing code has already been claimed.");
    }
    if (Date.parse(pairing.expiresAt) <= Date.now()) {
      throw new FunctionHttpError(410, "deadline-exceeded", "Pairing code has expired.");
    }

    const pendingRef = db.collection("pendingDesktops").doc(pairing.desktopId);
    const pendingRead = await transaction.get(pendingRef);
    const pending = asPendingDesktopDocument(pendingRead.data());
    if (pending.pairingCodeId !== pairingRef.id || pending.status !== "pending") {
      throw new FunctionHttpError(409, "failed-precondition", "Pending desktop no longer matches this pairing code.");
    }

    const claimedAt = new Date().toISOString();
    transaction.update(pairingRef, {
      status: "claimed",
      claimedAt,
      claimedByUid: uid
    });
    transaction.update(pendingRef, {
      status: "claimed",
      claimedAt,
      claimedByUid: uid
    });
    transaction.set(db.doc(`users/${uid}/desktops/${pairing.desktopId}`), {
      desktopId: pairing.desktopId,
      displayName: pairing.desktopName,
      desktopSecretHash: pending.desktopSecretHash,
      pairingCodeId: pairingRef.id,
      createdAt: claimedAt,
      updatedAt: claimedAt,
      revokedAt: null
    }, { merge: true });

    return {
      desktopId: pairing.desktopId,
      uid
    };
  });
}

async function handleFunctionRequest(
  method: string,
  body: unknown,
  response: { status(code: number): { json(body: unknown): void } },
  handler: (data: Record<string, unknown>) => Promise<Record<string, string>>
): Promise<void> {
  if (method !== "POST") {
    response.status(405).json({ error: { status: "method-not-allowed", message: "Use POST." } });
    return;
  }

  try {
    const envelope = asRecord(body);
    const result = await handler(asRecord(envelope.data));
    response.status(200).json({ result });
  } catch (error) {
    if (error instanceof FunctionHttpError) {
      response.status(error.status).json({ error: { status: error.code, message: error.message } });
      return;
    }
    throw error;
  }
}

async function requireUidFromAuthorization(header: string | undefined): Promise<string> {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) {
    throw new FunctionHttpError(401, "unauthenticated", "Sign in before claiming a pairing code.");
  }

  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch {
    throw new FunctionHttpError(401, "unauthenticated", "Sign in before claiming a pairing code.");
  }
}

function asPairingCodeDocument(value: unknown): PairingCodeDocument {
  if (!isRecord(value)) {
    throw new FunctionHttpError(404, "not-found", "Pairing code was not found.");
  }
  return {
    pairingCode: requiredString(value, "pairingCode"),
    desktopId: requiredString(value, "desktopId"),
    desktopName: requiredString(value, "desktopName"),
    desktopClaimTokenHash: requiredString(value, "desktopClaimTokenHash"),
    status: requiredStatus(value, "status"),
    expiresAt: requiredString(value, "expiresAt"),
    createdAt: requiredString(value, "createdAt"),
    claimedAt: nullableString(value, "claimedAt"),
    claimedByUid: nullableString(value, "claimedByUid")
  };
}

function asPendingDesktopDocument(value: unknown): PendingDesktopDocument {
  if (!isRecord(value)) {
    throw new FunctionHttpError(404, "not-found", "Pending desktop was not found.");
  }
  return {
    desktopId: requiredString(value, "desktopId"),
    desktopName: requiredString(value, "desktopName"),
    desktopSecretHash: requiredString(value, "desktopSecretHash"),
    desktopClaimTokenHash: requiredString(value, "desktopClaimTokenHash"),
    pairingCodeId: requiredString(value, "pairingCodeId"),
    status: requiredStatus(value, "status"),
    expiresAt: requiredString(value, "expiresAt"),
    createdAt: requiredString(value, "createdAt"),
    claimedAt: nullableString(value, "claimedAt"),
    claimedByUid: nullableString(value, "claimedByUid")
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new FunctionHttpError(400, "invalid-argument", `Missing string field ${field}.`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new FunctionHttpError(400, "invalid-argument", `Invalid string field ${field}.`);
  }
  return value;
}

function requiredStatus(record: Record<string, unknown>, field: string): "pending" | "claimed" {
  const value = requiredString(record, field);
  if (value !== "pending" && value !== "claimed") {
    throw new FunctionHttpError(409, "failed-precondition", `Invalid pairing status ${value}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function generatePairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
