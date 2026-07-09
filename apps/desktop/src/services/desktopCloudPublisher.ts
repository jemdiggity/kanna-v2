import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  type PipelineItem,
  type Repo,
  type DbHandle,
} from "../types/kanna";
import { invoke } from "../invoke";
import { buildCloudTaskSnapshot } from "../utils/cloudTaskSnapshot";
import { getConfiguredDesktopFirestore } from "./desktopCloudTaskIndex";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { fetchDesktopSnapshot } from "./desktopServerClient";
import { getCachedRepoRemoteUrl, __resetRepoRemoteUrlCacheForTests } from "./repoRemoteUrl";

const GENERIC_DESKTOP_NAME = "Kanna Desktop";

export interface RemoteTaskSnapshotIdentity {
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
}

export interface PublishDesktopTaskSnapshotsOptions {
  closedSinceDays?: number;
}

interface CloudWriteContext {
  desktopDisplayName: string;
  desktopId: string;
  desktopSecretHash: string | null;
  firestore: Firestore;
  primaryEmail: string | null;
  uid: string;
}

type TaskSnapshotDocument = Record<string, unknown> & {
  localRepoId?: string;
  ownerLocalTaskId?: string;
};

export async function publishDesktopTaskSnapshot(
  db: DbHandle | null | undefined,
  item: PipelineItem,
  repo: Repo | null = null,
): Promise<void> {
  void db;
  const snapshotState = await fetchDesktopSnapshot();
  const targetRepo = repo
    ?? snapshotState.entries.find((entry) => entry.repo.id === item.repo_id)?.repo
    ?? null;
  if (!targetRepo) return;

  const context = await getCloudWriteContext();
  if (!context) return;

  const identity = {
    ownerDesktopId: context.desktopId,
    localRepoId: targetRepo.id,
    ownerLocalTaskId: item.id,
  };

  if (item.closed_at !== null) {
    await deleteTaskSnapshotByIdentity(context, identity, { createDesktopDoc: false });
    return;
  }

  const snapshot = await buildSnapshot(
    item,
    targetRepo,
    context.desktopId,
    blockedByTaskIds(snapshotState.taskBlockers, item.id),
  );
  await upsertTaskSnapshots(context, [snapshot], { deleteStale: false });
}

export async function deleteRemoteTaskSnapshots(identity: RemoteTaskSnapshotIdentity): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;
  await deleteTaskSnapshotByIdentity(context, identity, { createDesktopDoc: false });
}

export async function deleteDesktopTaskSnapshotForLocalTask(
  localRepoId: string,
  ownerLocalTaskId: string,
): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;
  await deleteTaskSnapshotByIdentity(context, {
    ownerDesktopId: context.desktopId,
    localRepoId,
    ownerLocalTaskId,
  }, { createDesktopDoc: false });
}

export async function reconcileDesktopTaskSnapshots(db: DbHandle | null | undefined): Promise<void> {
  void db;
  const context = await getCloudWriteContext();
  if (!context) return;

  const snapshots: TaskSnapshotDocument[] = [];
  const snapshotState = await fetchDesktopSnapshot();
  for (const { repo, items } of snapshotState.entries) {
    for (const item of items) {
      if (item.closed_at !== null) continue;
      try {
        snapshots.push(await buildSnapshot(
          item,
          repo,
          context.desktopId,
          blockedByTaskIds(snapshotState.taskBlockers, item.id),
        ));
      } catch (error) {
        console.warn(`[cloud] failed to build task snapshot for ${item.id}:`, error);
      }
    }
  }

  await upsertTaskSnapshots(context, snapshots, { deleteStale: true });
}

export async function publishDesktopTaskSnapshots(
  db: DbHandle | null | undefined,
  _options: PublishDesktopTaskSnapshotsOptions = {},
): Promise<void> {
  await reconcileDesktopTaskSnapshots(db);
}

export function __resetDesktopCloudPublisherCachesForTests(): void {
  __resetRepoRemoteUrlCacheForTests();
}

async function buildSnapshot(
  item: PipelineItem,
  repo: Repo,
  desktopId: string,
  blockedByTaskIds: string[],
): Promise<TaskSnapshotDocument> {
  const remoteUrl = await getCachedRepoRemoteUrl(repo);

  return await buildCloudTaskSnapshot({
    desktopId,
    item,
    repo: { ...repo, remote_url: remoteUrl },
    blockedByTaskIds,
  }) as TaskSnapshotDocument;
}

function blockedByTaskIds(
  blockers: Array<{ blocked_item_id: string; blocker_item_id: string }>,
  itemId: string,
): string[] {
  return blockers
    .filter((blocker) => blocker.blocked_item_id === itemId)
    .map((blocker) => blocker.blocker_item_id);
}

async function getCloudWriteContext(): Promise<CloudWriteContext | null> {
  const [authSession, firestore, desktopIdentity] = await Promise.all([
    getConfiguredDesktopAuthSession(),
    getConfiguredDesktopFirestore(),
    resolveDesktopIdentity(),
  ]);
  const state = authSession.getState();
  if (state.status !== "signedIn" || !firestore) return null;

  return {
    desktopDisplayName: desktopIdentity.displayName,
    desktopId: desktopIdentity.desktopId,
    desktopSecretHash: desktopIdentity.desktopSecretHash,
    firestore,
    primaryEmail: state.user.email,
    uid: state.user.uid,
  };
}

async function upsertTaskSnapshots(
  context: CloudWriteContext,
  snapshots: TaskSnapshotDocument[],
  options: { deleteStale: boolean },
): Promise<void> {
  await updateUserProfileDocument(context);
  const desktopDoc = await resolveDesktopDocument(context, context.desktopId, { create: true });
  if (!desktopDoc) return;

  const tasksRef = collection(desktopDoc, "tasks");
  const existingDocs = await getDocs(tasksRef);
  const existingByIdentity = groupTaskDocsByIdentity(existingDocs.docs);
  const openKeys = new Set(snapshots.map(taskIdentityKey));
  const batch = writeBatch(context.firestore);

  for (const snapshot of snapshots) {
    const key = taskIdentityKey(snapshot);
    const [target, ...duplicates] = existingByIdentity.get(key) ?? [];
    const targetRef = target?.ref ?? doc(tasksRef);
    batch.set(targetRef, snapshot);
    for (const duplicate of duplicates) {
      batch.delete(duplicate.ref);
    }
  }

  if (options.deleteStale) {
    for (const taskDoc of existingDocs.docs) {
      const key = taskIdentityKeyFromData(taskDoc.data() as TaskSnapshotDocument);
      if (!key || !openKeys.has(key)) {
        batch.delete(taskDoc.ref);
      }
    }
  }

  await batch.commit();
}

async function deleteTaskSnapshotByIdentity(
  context: CloudWriteContext,
  identity: RemoteTaskSnapshotIdentity,
  options: { createDesktopDoc: boolean },
): Promise<void> {
  const desktopDoc = await resolveDesktopDocument(context, identity.ownerDesktopId, {
    create: options.createDesktopDoc,
  });
  if (!desktopDoc) return;

  const tasksRef = collection(desktopDoc, "tasks");
  const existingDocs = await getDocs(tasksRef);
  const targetKey = identityKey(identity.localRepoId, identity.ownerLocalTaskId);
  const batch = writeBatch(context.firestore);
  for (const taskDoc of existingDocs.docs) {
    const key = taskIdentityKeyFromData(taskDoc.data() as TaskSnapshotDocument);
    if (key === targetKey) {
      batch.delete(taskDoc.ref);
    }
  }
  await batch.commit();
}

async function resolveDesktopDocument(
  context: CloudWriteContext,
  desktopId: string,
  options: { create: boolean },
): Promise<DocumentReference | null> {
  const desktopsRef = collection(context.firestore, "users", context.uid, "desktops");
  // The relay authenticates kanna-server connections against this hash, so
  // registering it here is what lets this desktop use the cloud relay. Only
  // attach it to this desktop's own document.
  const credentialFields =
    desktopId === context.desktopId && context.desktopSecretHash
      ? { desktopSecretHash: context.desktopSecretHash }
      : {};
  // Use a deterministic document id derived from the desktop id so concurrent
  // publishers (sign-in reconcile + per-task publish + LAN publish) converge on
  // the same document instead of each creating its own via addDoc — which left
  // duplicate desktop records for a single desktopId.
  const desktopRef = doc(desktopsRef, desktopDocId(desktopId));

  if (options.create) {
    await setDoc(desktopRef, {
      desktopId,
      displayName: context.desktopDisplayName,
      updatedAt: serverTimestamp(),
      ...credentialFields,
    }, { merge: true });
    await deleteDuplicateDesktopDocs(context, desktopsRef, desktopId, desktopRef.id);
    return desktopRef;
  }

  const existing = await getDoc(desktopRef);
  if (existing.exists()) {
    await setDoc(desktopRef, {
      displayName: context.desktopDisplayName,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return desktopRef;
  }

  // Legacy fallback: a pre-deterministic auto-id document may still hold this
  // desktopId. Honour it for reads/deletes until the next create migrates it.
  const legacy = await getDocs(query(desktopsRef, where("desktopId", "==", desktopId), limit(1)));
  const legacyDoc = legacy.docs[0];
  if (!legacyDoc) return null;

  await setDoc(legacyDoc.ref, {
    displayName: context.desktopDisplayName,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return legacyDoc.ref;
}

// Firestore document ids may not contain "/" (and a few reserved forms). Desktop
// ids are UUID-style slugs, but guard defensively.
function desktopDocId(desktopId: string): string {
  return desktopId.replace(/\//g, "_");
}

// Removes any extra desktop documents that share this desktopId (legacy auto-id
// docs, or losers of a prior create race), including their tasks subcollection,
// keeping only the canonical deterministic-id document.
async function deleteDuplicateDesktopDocs(
  context: CloudWriteContext,
  desktopsRef: CollectionReference,
  desktopId: string,
  canonicalDocId: string,
): Promise<void> {
  const matches = await getDocs(query(desktopsRef, where("desktopId", "==", desktopId)));
  const stale = matches.docs.filter((candidate) => candidate.id !== canonicalDocId);
  for (const staleDoc of stale) {
    const staleTasks = await getDocs(collection(staleDoc.ref, "tasks"));
    const batch = writeBatch(context.firestore);
    for (const taskDoc of staleTasks.docs) {
      batch.delete(taskDoc.ref);
    }
    batch.delete(staleDoc.ref);
    await batch.commit();
  }
}

async function updateUserProfileDocument(context: CloudWriteContext): Promise<void> {
  if (!context.primaryEmail) return;
  await setDoc(doc(context.firestore, "users", context.uid), {
    primaryEmail: context.primaryEmail,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

function groupTaskDocsByIdentity(
  docs: QueryDocumentSnapshot[],
): Map<string, QueryDocumentSnapshot[]> {
  const byIdentity = new Map<string, QueryDocumentSnapshot[]>();
  for (const taskDoc of docs) {
    const key = taskIdentityKeyFromData(taskDoc.data() as TaskSnapshotDocument);
    if (!key) continue;
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), taskDoc]);
  }
  return byIdentity;
}

function taskIdentityKey(snapshot: TaskSnapshotDocument): string {
  const key = taskIdentityKeyFromData(snapshot);
  if (!key) throw new Error("task snapshot is missing localRepoId or ownerLocalTaskId");
  return key;
}

function taskIdentityKeyFromData(data: TaskSnapshotDocument): string | null {
  if (typeof data.localRepoId !== "string" || typeof data.ownerLocalTaskId !== "string") return null;
  return identityKey(data.localRepoId, data.ownerLocalTaskId);
}

function identityKey(localRepoId: string, ownerLocalTaskId: string): string {
  return `${localRepoId}\u0000${ownerLocalTaskId}`;
}

interface DesktopIdentity {
  desktopId: string;
  displayName: string;
  desktopSecretHash: string | null;
}

interface DesktopCloudCredentialPayload {
  desktopId?: string;
  desktopSecretHash?: string;
}

async function resolveDesktopIdentity(): Promise<DesktopIdentity> {
  const [credential, mobileStatus] = await Promise.all([
    invoke<DesktopCloudCredentialPayload>("desktop_cloud_credential").catch(() => null),
    invoke<{ desktopId?: string; desktopName?: string }>("mobile_server_status").catch(() => null),
  ]);
  const desktopName = normalizeDesktopDisplayName(mobileStatus?.desktopName);
  const desktopSecretHash =
    typeof credential?.desktopSecretHash === "string" && credential.desktopSecretHash.trim()
      ? credential.desktopSecretHash.trim()
      : null;

  if (typeof credential?.desktopId === "string" && credential.desktopId.trim()) {
    return {
      desktopId: credential.desktopId.trim(),
      displayName: desktopName || await resolveFallbackDesktopDisplayName(),
      desktopSecretHash,
    };
  }

  if (mobileStatus?.desktopId?.trim()) {
    return {
      desktopId: mobileStatus.desktopId.trim(),
      displayName: desktopName || await resolveFallbackDesktopDisplayName(),
      desktopSecretHash: null,
    };
  }

  const envId = await readEnvString("KANNA_TRANSFER_PEER_ID");
  if (envId.trim()) {
    return {
      desktopId: envId.trim(),
      displayName: desktopName || await resolveFallbackDesktopDisplayName(),
      desktopSecretHash: null,
    };
  }

  return {
    desktopId: "desktop-local",
    displayName: desktopName || await resolveFallbackDesktopDisplayName(),
    desktopSecretHash: null,
  };
}

async function resolveFallbackDesktopDisplayName(): Promise<string> {
  const hostName = await readEnvString("HOSTNAME");
  if (hostName.trim()) return hostName.trim();
  const computerName = await readEnvString("COMPUTERNAME");
  if (computerName.trim()) return computerName.trim();
  return GENERIC_DESKTOP_NAME;
}

function normalizeDesktopDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed === GENERIC_DESKTOP_NAME ? "" : trimmed;
}

async function readEnvString(name: string): Promise<string> {
  const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
  return typeof value === "string" ? value : "";
}
