import { randomBytes } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, type Firestore, type DocumentReference } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { buildPairingArtifacts } from "./pairing.js";
import {
  buildTaskSnapshotMutations,
  buildTaskSnapshotRequest,
  taskSnapshotIdentityMatchesData,
  type ExistingTaskSnapshotDoc,
  type TaskSnapshotIdentity,
} from "./taskSnapshots.js";
import { emulatorPorts, type CloudTaskSnapshot, type CreatePairingCodeRequest } from "./types.js";

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
    const taskRequest = buildTaskSnapshotRequest(request.body);
    ensureFirebaseApp();
    const db = getFirestore();

    if (taskRequest.action === "delete") {
      const deleted = await deleteTaskSnapshotsByIdentity(db, uid, taskRequest.identity);
      response.status(200).json({ ok: true, deleted });
      return;
    }

    if (taskRequest.action === "reconcile") {
      const result = await reconcileTaskSnapshots(db, uid, taskRequest.ownerDesktopId, taskRequest.snapshots);
      response.status(200).json({ ok: true, ...result });
      return;
    }

    const result = await reconcileTaskSnapshots(db, uid, taskRequest.snapshot.ownerDesktopId, [taskRequest.snapshot]);
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid task snapshot",
    });
  }
});

export { buildPairingArtifacts, emulatorPorts };

async function reconcileTaskSnapshots(
  db: Firestore,
  uid: string,
  ownerDesktopId: string,
  snapshots: CloudTaskSnapshot[],
): Promise<{ created: number; updated: number; deleted: number }> {
  const desktopDoc = await resolveDesktopDocument(db, uid, ownerDesktopId, { create: true });
  if (!desktopDoc) return { created: 0, updated: 0, deleted: 0 };
  const existingDocs = await listOwnedTaskSnapshotDocs(desktopDoc);
  const mutations = buildTaskSnapshotMutations({ existingDocs, snapshots });
  const tasksRef = desktopDoc.collection("tasks");
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const mutation of mutations) {
    if (mutation.type === "create") {
      await tasksRef.add(mutation.data);
      created += 1;
    } else if (mutation.type === "update") {
      await tasksRef.doc(mutation.docId).set(mutation.data, { merge: true });
      updated += 1;
    } else {
      await tasksRef.doc(mutation.docId).delete();
      deleted += 1;
    }
  }

  return { created, updated, deleted };
}

async function deleteTaskSnapshotsByIdentity(
  db: Firestore,
  uid: string,
  identity: TaskSnapshotIdentity,
): Promise<number> {
  const desktopDoc = await resolveDesktopDocument(db, uid, identity.ownerDesktopId, { create: false });
  if (!desktopDoc) return 0;
  const existingDocs = await listOwnedTaskSnapshotDocs(desktopDoc);
  const tasksRef = desktopDoc.collection("tasks");
  const matches = existingDocs.filter((doc) => taskSnapshotIdentityMatchesData(identity, doc.data));
  await Promise.all(matches.map((doc) => tasksRef.doc(doc.id).delete()));
  return matches.length;
}

async function resolveDesktopDocument(
  db: Firestore,
  uid: string,
  ownerDesktopId: string,
  options: { create: boolean },
): Promise<DocumentReference | null> {
  const desktopsRef = db.collection("users").doc(uid).collection("desktops");
  const existing = await desktopsRef
    .where("desktopId", "==", ownerDesktopId)
    .limit(1)
    .get();
  const desktopDoc = existing.docs[0];
  if (desktopDoc) return desktopDoc.ref;
  if (!options.create) return null;
  return desktopsRef.add({
    desktopId: ownerDesktopId,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function listOwnedTaskSnapshotDocs(
  desktopDoc: DocumentReference,
): Promise<ExistingTaskSnapshotDoc[]> {
  const snapshot = await desktopDoc.collection("tasks").get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  }));
}
