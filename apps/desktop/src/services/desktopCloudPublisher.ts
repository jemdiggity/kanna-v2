import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  getRepo,
  listBlockersForItem,
  listPipelineItems,
  listRepos,
  type PipelineItem,
  type Repo,
} from "@kanna/db";
import type { DbHandle } from "@kanna/db";
import { invoke } from "../invoke";
import { buildCloudTaskSnapshot } from "../utils/cloudTaskSnapshot";
import { getConfiguredDesktopFirestore } from "./desktopCloudTaskIndex";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";

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
  firestore: Firestore;
  primaryEmail: string | null;
  uid: string;
}

type TaskSnapshotDocument = Record<string, unknown> & {
  localRepoId?: string;
  ownerLocalTaskId?: string;
};

export async function publishDesktopTaskSnapshot(
  db: DbHandle,
  item: PipelineItem,
  repo: Repo | null = null,
): Promise<void> {
  const targetRepo = repo ?? await getRepo(db, item.repo_id);
  if (!targetRepo) return;

  const context = await getCloudWriteContext();
  if (!context) return;

  const identity = {
    ownerDesktopId: context.desktopId,
    localRepoId: targetRepo.id,
    ownerLocalTaskId: item.id,
  };

  if (item.stage === "done" || item.closed_at !== null) {
    await deleteTaskSnapshotByIdentity(context, identity, { createDesktopDoc: false });
    return;
  }

  const snapshot = await buildSnapshot(db, item, targetRepo, context.desktopId);
  await upsertTaskSnapshots(context, [snapshot], { deleteStale: false });
}

export async function deleteRemoteTaskSnapshots(identity: RemoteTaskSnapshotIdentity): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;
  await deleteTaskSnapshotByIdentity(context, identity, { createDesktopDoc: false });
}

export async function reconcileDesktopTaskSnapshots(db: DbHandle): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;

  const snapshots: TaskSnapshotDocument[] = [];
  const repos = await listRepos(db);
  for (const repo of repos) {
    const items = await listPipelineItems(db, repo.id);
    for (const item of items) {
      if (item.stage === "done" || item.closed_at !== null) continue;
      try {
        snapshots.push(await buildSnapshot(db, item, repo, context.desktopId));
      } catch (error) {
        console.warn(`[cloud] failed to build task snapshot for ${item.id}:`, error);
      }
    }
  }

  await upsertTaskSnapshots(context, snapshots, { deleteStale: true });
}

export async function publishDesktopTaskSnapshots(
  db: DbHandle,
  _options: PublishDesktopTaskSnapshotsOptions = {},
): Promise<void> {
  await reconcileDesktopTaskSnapshots(db);
}

async function buildSnapshot(
  db: DbHandle,
  item: PipelineItem,
  repo: Repo,
  desktopId: string,
): Promise<TaskSnapshotDocument> {
  const [blockers, remoteUrl] = await Promise.all([
    listBlockersForItem(db, item.id),
    invoke<string>("git_remote_url", { repoPath: repo.path }).catch(() => null),
  ]);

  return await buildCloudTaskSnapshot({
    desktopId,
    item,
    repo: { ...repo, remote_url: remoteUrl },
    blockedByTaskIds: blockers.map((blocker) => blocker.id),
  }) as TaskSnapshotDocument;
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
  const snapshot = await getDocs(query(
    desktopsRef,
    where("desktopId", "==", desktopId),
    limit(1),
  ));
  const existing = snapshot.docs[0] as QueryDocumentSnapshot | undefined;
  if (existing) {
    await setDoc(existing.ref, {
      displayName: context.desktopDisplayName,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return existing.ref;
  }
  if (!options.create) return null;
  return addDoc(desktopsRef, {
    desktopId,
    displayName: context.desktopDisplayName,
    updatedAt: serverTimestamp(),
  });
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
}

async function resolveDesktopIdentity(): Promise<DesktopIdentity> {
  const mobileStatus = await invoke<{ desktopId?: string; desktopName?: string }>("mobile_server_status").catch(() => null);
  const desktopName = mobileStatus?.desktopName?.trim();
  if (mobileStatus?.desktopId?.trim()) {
    return {
      desktopId: mobileStatus.desktopId.trim(),
      displayName: desktopName || await resolveFallbackDesktopDisplayName(),
    };
  }

  const envId = await readEnvString("KANNA_TRANSFER_PEER_ID");
  if (envId.trim()) {
    return {
      desktopId: envId.trim(),
      displayName: desktopName || await resolveFallbackDesktopDisplayName(),
    };
  }

  return {
    desktopId: "desktop-local",
    displayName: desktopName || await resolveFallbackDesktopDisplayName(),
  };
}

async function resolveFallbackDesktopDisplayName(): Promise<string> {
  const hostName = await readEnvString("HOSTNAME");
  if (hostName.trim()) return hostName.trim();
  const computerName = await readEnvString("COMPUTERNAME");
  if (computerName.trim()) return computerName.trim();
  return "Kanna Desktop";
}

async function readEnvString(name: string): Promise<string> {
  const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
  return typeof value === "string" ? value : "";
}
