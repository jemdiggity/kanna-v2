import {
  collection,
  connectFirestoreEmulator,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase/app";
import { isAgentProvider } from "@kanna/agent-protocol";
import type { PipelineItem, Repo } from "../types/kanna";
import { invoke } from "../invoke";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";
import { listActiveDesktopIdsViaRelay } from "./desktopRelayTerminal";

export interface DesktopCloudTaskSnapshot {
  cloudTaskId?: string;
  localRepoId?: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  waitingPromptSnippet?: string | null;
  displayName: string | null;
  stage: string;
  activity?: string;
  activityRevision?: number;
  blockerRevision?: number;
  transitionRevision?: string | null;
  status: string;
  hasRunningPost?: boolean;
  blockedByTaskIds?: string[];
  /** Owner-side durable id of this task's parent, in the publisher's task-id space. */
  parentTaskId?: string | null;
  repo: {
    cloudRepoId: string;
    name: string;
    remoteUrl?: string | null;
    remoteUrlHash?: string | null;
    defaultBranch?: string | null;
  };
  branch: string | null;
  baseRef: string | null;
  prNumber: number | null;
  prUrl: string | null;
  agent?: {
    provider?: string | null;
    type?: string | null;
  };
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  transfer?: {
    state: "none" | "outgoing" | "incoming" | "finalization_pending";
    transferId?: string | null;
    sourceDesktopId?: string | null;
    destinationDesktopId?: string | null;
  };
}

export interface DesktopCloudDesktopSnapshot {
  desktopId?: string;
  displayName?: string;
  transfer?: {
    peerId?: string;
    publicKey?: string;
    protocolVersion?: number;
    acceptingTransfers?: boolean;
  } | null;
}

export interface DesktopCloudTransferMachine {
  desktopId: string;
  displayName: string;
  online: boolean;
  peerId: string;
  publicKey: string;
  protocolVersion: number;
  acceptingTransfers: boolean;
}

export interface DesktopCloudSnapshot {
  repos: DesktopCloudRepo[];
  items: PipelineItem[];
  terminalRefs: Record<string, DesktopCloudTerminalRef>;
  blockedByTaskIds: Record<string, string[]>;
  transferMachines: DesktopCloudTransferMachine[];
}

export type DesktopCloudRepo = Repo & {
  remote_url?: string | null;
  remoteUrlHash?: string | null;
};

export interface DesktopCloudTerminalRef {
  ownerDesktopId: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId: string;
  transport?: "cloud" | "lan";
  transferPeerId?: string;
  preferredTransferTransport?: "lan" | "cloud";
}

export interface DesktopCloudTaskIndexOptions {
  localRepos?: Array<{
    repo: Repo;
    remoteUrlHash: string | null;
  }>;
  localItems?: Array<Pick<PipelineItem, "id" | "repo_id" | "stage" | "closed_at">>;
  localClosedItems?: Array<Pick<PipelineItem, "id" | "repo_id">>;
  activeDesktopIds?: Set<string> | null;
  currentDesktopId?: string | null;
}

let firestorePromise: Promise<Firestore | null> | null = null;
let connectedFirestoreEmulator: string | null = null;

export async function getConfiguredDesktopFirestore(): Promise<Firestore | null> {
  firestorePromise ??= (async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: (name) => invoke<string>("read_env_var", { name }),
      dev: import.meta.env.DEV,
    });
    if (!config.app) return null;

    const app = getApps()[0] ?? initializeApp(config.app);
    const db = getFirestore(app);
    if (config.firestoreEmulator) {
      const key = config.firestoreEmulator.url;
      if (connectedFirestoreEmulator !== key) {
        connectFirestoreEmulator(
          db,
          config.firestoreEmulator.host,
          config.firestoreEmulator.port,
        );
        connectedFirestoreEmulator = key;
      }
    }
    return db;
  })();
  return firestorePromise;
}

export async function listDesktopCloudTasks(
  uid: string,
  db?: Firestore | null,
  options: DesktopCloudTaskIndexOptions = {},
): Promise<DesktopCloudSnapshot> {
  const firestore = db === undefined ? await getConfiguredDesktopFirestore() : db;
  if (!firestore) {
    return {
      repos: [],
      items: [],
      terminalRefs: {},
      blockedByTaskIds: {},
      transferMachines: [],
    };
  }

  const desktopsRef = collection(firestore, "users", uid, "desktops");
  const [desktopSnapshot, activeDesktopIds, currentDesktopId] = await Promise.all([
    getDocs(desktopsRef),
    options.activeDesktopIds === undefined
      ? listActiveDesktopIdsViaRelay().catch(() => null)
      : Promise.resolve(options.activeDesktopIds),
    options.currentDesktopId === undefined
      ? resolveDesktopId()
      : Promise.resolve(options.currentDesktopId),
  ]);
  const nestedSnapshots = await Promise.all(desktopSnapshot.docs.map(async (desktopDoc) => {
    const tasksRef = collection(desktopDoc.ref, "tasks");
    const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
    return snapshot.docs.map((doc) => doc.data() as DesktopCloudTaskSnapshot);
  }));
  const taskSnapshots = nestedSnapshots.flat();
  return mapDesktopCloudTasks(
    taskSnapshots,
    { ...options, activeDesktopIds, currentDesktopId },
    desktopSnapshot.docs.map((desktopDoc) => ({
      documentId: desktopDoc.id,
      snapshot: desktopDoc.data() as DesktopCloudDesktopSnapshot,
    })),
  );
}

export interface SubscribeDesktopCloudTasksOptions {
  // Read fresh each emit so mapping reflects the current local repos/items.
  getOptions: () => DesktopCloudTaskIndexOptions;
}

/**
 * Live subscription to the signed-in user's cloud task index. Replaces polling
 * getDocs: it attaches an onSnapshot listener to the user's `desktops`
 * collection and a nested listener to each desktop's open `tasks`, so updates
 * are pushed the instant a peer desktop writes. Returns an unsubscribe.
 */
export function subscribeDesktopCloudTasks(
  uid: string,
  onUpdate: (snapshot: DesktopCloudSnapshot) => void,
  options: SubscribeDesktopCloudTasksOptions,
): () => void {
  let cancelled = false;
  let desktopsUnsub: (() => void) | null = null;
  const taskUnsubs = new Map<string, () => void>();
  const tasksByDesktop = new Map<string, DesktopCloudTaskSnapshot[]>();
  const desktopsById = new Map<
    string,
    { documentId: string; snapshot: DesktopCloudDesktopSnapshot }
  >();
  let requestedEmission = 0;

  const emit = async () => {
    const emission = ++requestedEmission;
    const base = options.getOptions();
    const [activeDesktopIds, currentDesktopId] = await Promise.all([
      base.activeDesktopIds === undefined
        ? listActiveDesktopIdsViaRelay().catch(() => null)
        : Promise.resolve(base.activeDesktopIds),
      base.currentDesktopId === undefined ? resolveDesktopId() : Promise.resolve(base.currentDesktopId),
    ]);
    if (cancelled || emission !== requestedEmission) return;
    const snapshots = [...tasksByDesktop.values()].flat();
    onUpdate(mapDesktopCloudTasks(
      snapshots,
      { ...base, activeDesktopIds, currentDesktopId },
      [...desktopsById.values()],
    ));
  };

  void (async () => {
    const firestore = await getConfiguredDesktopFirestore();
    if (cancelled) return;
    if (!firestore) {
      onUpdate({
        repos: [],
        items: [],
        terminalRefs: {},
        blockedByTaskIds: {},
        transferMachines: [],
      });
      return;
    }
    const desktopsRef = collection(firestore, "users", uid, "desktops");
    desktopsUnsub = onSnapshot(desktopsRef, (desktopsSnapshot) => {
      const present = new Set<string>();
      for (const desktopDoc of desktopsSnapshot.docs) {
        present.add(desktopDoc.id);
        desktopsById.set(desktopDoc.id, {
          documentId: desktopDoc.id,
          snapshot: desktopDoc.data() as DesktopCloudDesktopSnapshot,
        });
        if (taskUnsubs.has(desktopDoc.id)) continue;
        const tasksQuery = query(collection(desktopDoc.ref, "tasks"), where("closedAt", "==", null));
        taskUnsubs.set(
          desktopDoc.id,
          onSnapshot(tasksQuery, (tasksSnapshot) => {
            tasksByDesktop.set(
              desktopDoc.id,
              tasksSnapshot.docs.map((doc) => doc.data() as DesktopCloudTaskSnapshot),
            );
            void emit();
          }),
        );
      }
      for (const [desktopId, unsub] of [...taskUnsubs]) {
        if (present.has(desktopId)) continue;
        unsub();
        taskUnsubs.delete(desktopId);
        tasksByDesktop.delete(desktopId);
        desktopsById.delete(desktopId);
      }
      void emit();
    });
  })();

  return () => {
    cancelled = true;
    desktopsUnsub?.();
    desktopsUnsub = null;
    for (const unsub of taskUnsubs.values()) unsub();
    taskUnsubs.clear();
    tasksByDesktop.clear();
    desktopsById.clear();
  };
}

export function mapDesktopCloudTasks(
  snapshots: DesktopCloudTaskSnapshot[],
  options: DesktopCloudTaskIndexOptions = {},
  desktopSnapshots: Array<{
    documentId: string;
    snapshot: DesktopCloudDesktopSnapshot;
  }> = [],
): DesktopCloudSnapshot {
  const reposById = new Map<string, DesktopCloudRepo>();
  const items: PipelineItem[] = [];
  const terminalRefs: Record<string, DesktopCloudTerminalRef> = {};
  const blockedByTaskIds: Record<string, string[]> = {};
  const transferMachines = mapDesktopCloudTransferMachines(
    desktopSnapshots,
    options.activeDesktopIds,
  );
  const transferMachineByDesktopId = new Map(
    transferMachines
      .filter((machine) =>
        machine.online
        && machine.protocolVersion === 1
        && machine.acceptingTransfers)
      .map((machine) => [machine.desktopId, machine]),
  );
  const localRepoById = new Map(
    (options.localRepos ?? []).map((entry) => [entry.repo.id, entry.repo]),
  );
  const localRepoByRemoteHash = new Map(
    (options.localRepos ?? [])
      .filter((entry): entry is { repo: Repo; remoteUrlHash: string } =>
        typeof entry.remoteUrlHash === "string" && entry.remoteUrlHash.length > 0,
      )
      .map((entry) => [entry.remoteUrlHash, entry.repo]),
  );
  const closedLocalItemKeys = new Set(
    [
      ...(options.localItems ?? [])
        .filter((item) => item.closed_at !== null)
        .map((item) => `${item.repo_id}:${item.id}`),
      ...(options.localClosedItems ?? []).map((item) => `${item.repo_id}:${item.id}`),
    ],
  );
  const authoritative = authoritativeTaskSnapshots(snapshots);
  // Parents are published in the owner's task-id space; resolve them against the
  // presentation ids this mapping mints so nesting survives the trip.
  const presentationIdByOwnerTask = new Map(
    authoritative.map((snapshot) => [
      ownerTaskKey(snapshot, snapshot.ownerLocalTaskId),
      presentationTaskId(snapshot),
    ]),
  );
  for (const snapshot of authoritative) {
    const snapshotLocalRepoId = snapshot.localRepoId ?? snapshot.repo.cloudRepoId;
    const exactLocalRepo = localRepoById.get(snapshotLocalRepoId);
    const localRepo = exactLocalRepo ?? (snapshot.repo.remoteUrlHash
      ? localRepoByRemoteHash.get(snapshot.repo.remoteUrlHash)
      : undefined);
    const repoId = localRepo?.id ?? cloudRepoId(snapshotLocalRepoId);
    if (closedLocalItemKeys.has(`${repoId}:${snapshot.ownerLocalTaskId}`)) {
      continue;
    }
    if (!localRepo && !reposById.has(repoId)) {
      reposById.set(repoId, {
        id: repoId,
        path: "cloud",
        name: snapshot.repo.name,
        remote_url: snapshot.repo.remoteUrl ?? null,
        remote_url_hash: snapshot.repo.remoteUrlHash ?? null,
        remoteUrlHash: snapshot.repo.remoteUrlHash ?? null,
        default_branch: snapshot.repo.defaultBranch ?? "main",
        hidden: 0,
        // Preserve discovery order until the viewer's durable sidebar order is
        // applied by buildWorkspace; synthetic repos must not all advertise 0.
        sort_order: reposById.size,
        created_at: snapshot.createdAt,
        last_opened_at: snapshot.updatedAt,
      });
    }

    const itemId = presentationTaskId(snapshot);
    const parentOwnerTaskId = nonblankString(snapshot.parentTaskId ?? null);
    const parentItemId = parentOwnerTaskId
      ? presentationIdByOwnerTask.get(ownerTaskKey(snapshot, parentOwnerTaskId)) ?? null
      : null;
    const uniqueBlockerIds = [...new Set(
      (snapshot.blockedByTaskIds ?? []).filter((id) => id.trim().length > 0),
    )];
    if (uniqueBlockerIds.length > 0) {
      blockedByTaskIds[itemId] = uniqueBlockerIds;
    }
    if (ownerDesktopIsReachable(snapshot.ownerDesktopId, options.activeDesktopIds)) {
      const transferMachine = transferMachineByDesktopId.get(snapshot.ownerDesktopId);
      terminalRefs[itemId] = {
        ownerDesktopId: snapshot.ownerDesktopId,
        ownerLocalRepoId: snapshotLocalRepoId,
        ownerLocalTaskId: snapshot.ownerLocalTaskId,
        transport: "cloud",
        ...(transferMachine
          ? {
              transferPeerId: transferMachine.peerId,
              preferredTransferTransport: "cloud" as const,
            }
          : {}),
      };
    }

    items.push({
      id: itemId,
      repo_id: repoId,
      prompt: snapshot.promptSnippet ?? snapshot.title,
      pipeline: "cloud",
      pipeline_def: null,
      stage: snapshot.stage,
      pr_number: snapshot.prNumber,
      pr_url: snapshot.prUrl,
      branch: snapshot.branch,
      activity: normalizeActivity(snapshot.activity),
      activity_revision: typeof snapshot.activityRevision === "number"
        && Number.isSafeInteger(snapshot.activityRevision)
        && snapshot.activityRevision >= 0
        ? snapshot.activityRevision
        : undefined,
      blocker_revision: typeof snapshot.blockerRevision === "number"
        && Number.isSafeInteger(snapshot.blockerRevision)
        && snapshot.blockerRevision >= 0
        ? snapshot.blockerRevision
        : undefined,
      transition_revision: typeof snapshot.transitionRevision === "string"
        && snapshot.transitionRevision.trim().length > 0
        ? snapshot.transitionRevision
        : null,
      activity_changed_at: snapshot.updatedAt,
      has_running_post: snapshot.hasRunningPost ? 1 : 0,
      unread_at: null,
      port_offset: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      display_name: snapshot.displayName ?? `${snapshot.title} (${snapshot.ownerDesktopId})`,
      issue_number: null,
      issue_title: null,
      closed_at: snapshot.closedAt ?? null,
      agent_session_id: null,
      base_ref: snapshot.baseRef,
      agent_provider: normalizeAgentProvider(snapshot.agent?.provider),
      agent_type: snapshot.agent?.type ?? "pty",
      teardown_started_at: null,
      parent_task_id: parentItemId === itemId ? null : parentItemId,
      last_output_preview: snapshot.waitingPromptSnippet ?? null,
      notify_task_id: null,
      notified_at: null,
      created_at: snapshot.createdAt,
      updated_at: snapshot.updatedAt,
    });
  }

  return {
    repos: [...reposById.values()],
    items,
    terminalRefs,
    blockedByTaskIds,
    transferMachines,
  };
}

function mapDesktopCloudTransferMachines(
  desktops: Array<{
    documentId: string;
    snapshot: DesktopCloudDesktopSnapshot;
  }>,
  activeDesktopIds: Set<string> | null | undefined,
): DesktopCloudTransferMachine[] {
  return desktops
    .flatMap(({ documentId, snapshot }) => {
      const desktopId = nonblankString(snapshot.desktopId) ?? nonblankString(documentId);
      const transfer = snapshot.transfer;
      const peerId = nonblankString(transfer?.peerId);
      const publicKey = nonblankString(transfer?.publicKey);
      const protocolVersion = transfer?.protocolVersion;
      if (
        !desktopId
        || !peerId
        || !publicKey
        || !Number.isSafeInteger(protocolVersion)
        || (protocolVersion as number) <= 0
        || typeof transfer?.acceptingTransfers !== "boolean"
      ) {
        return [];
      }
      return [{
        desktopId,
        displayName: nonblankString(snapshot.displayName) ?? desktopId,
        online: ownerDesktopIsReachable(desktopId, activeDesktopIds),
        peerId,
        publicKey,
        protocolVersion: protocolVersion as number,
        acceptingTransfers: transfer.acceptingTransfers,
      }];
    })
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName)
      || left.desktopId.localeCompare(right.desktopId));
}

function nonblankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function ownerDesktopIsReachable(ownerDesktopId: string, activeDesktopIds: Set<string> | null | undefined): boolean {
  return activeDesktopIds === undefined || activeDesktopIds === null || activeDesktopIds.has(ownerDesktopId);
}

function sortByUpdatedAt<T extends { updatedAt: string }>(snapshots: T[]): T[] {
  return [...snapshots].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function authoritativeTaskSnapshots(
  snapshots: DesktopCloudTaskSnapshot[],
): DesktopCloudTaskSnapshot[] {
  const winners = new Map<string, DesktopCloudTaskSnapshot>();
  for (const snapshot of snapshots) {
    const identity = snapshot.cloudTaskId
      ?? `${snapshot.ownerDesktopId}:${snapshot.localRepoId ?? snapshot.repo.cloudRepoId}:${snapshot.ownerLocalTaskId}`;
    const current = winners.get(identity);
    if (!current || compareTaskAuthority(snapshot, current) > 0) {
      winners.set(identity, snapshot);
    }
  }
  return sortByUpdatedAt([...winners.values()]);
}

function compareTaskAuthority(
  left: DesktopCloudTaskSnapshot,
  right: DesktopCloudTaskSnapshot,
): number {
  const transferRank = (snapshot: DesktopCloudTaskSnapshot): number => {
    switch (snapshot.transfer?.state ?? "none") {
      case "finalization_pending":
        return 4;
      case "incoming":
        return 3;
      case "none":
        return 2;
      case "outgoing":
        return 1;
    }
  };
  return transferRank(left) - transferRank(right)
    || left.updatedAt.localeCompare(right.updatedAt)
    || (left.activityRevision ?? -1) - (right.activityRevision ?? -1)
    || (left.blockerRevision ?? -1) - (right.blockerRevision ?? -1)
    || (left.transitionRevision ?? "").localeCompare(right.transitionRevision ?? "")
    || left.ownerDesktopId.localeCompare(right.ownerDesktopId)
    || left.ownerLocalTaskId.localeCompare(right.ownerLocalTaskId);
}

function cloudRepoId(id: string): string {
  return `cloud:${id}`;
}

function cloudTaskId(id: string): string {
  return `cloud:${id}`;
}

/** The id a snapshot is presented under locally, stable for every reference to it. */
function presentationTaskId(snapshot: DesktopCloudTaskSnapshot): string {
  const localRepoId = snapshot.localRepoId ?? snapshot.repo.cloudRepoId;
  return snapshot.cloudTaskId
    ? cloudTaskId(snapshot.cloudTaskId)
    : cloudTaskId(`${snapshot.ownerDesktopId}:${localRepoId}:${snapshot.ownerLocalTaskId}`);
}

/** Owner-side identity of a task published by `snapshot`'s desktop and repo. */
function ownerTaskKey(snapshot: DesktopCloudTaskSnapshot, ownerLocalTaskId: string): string {
  const localRepoId = snapshot.localRepoId ?? snapshot.repo.cloudRepoId;
  return JSON.stringify([snapshot.ownerDesktopId, localRepoId, ownerLocalTaskId]);
}

function normalizeActivity(activity: string | undefined): PipelineItem["activity"] {
  return activity === "working" || activity === "unread" ? activity : "idle";
}

function normalizeAgentProvider(provider: string | null | undefined): PipelineItem["agent_provider"] {
  return isAgentProvider(provider) ? provider : "claude";
}

async function resolveDesktopId(): Promise<string | null> {
  const mobileStatus = await invoke<{ desktopId?: string }>("mobile_server_status").catch(() => null);
  if (mobileStatus?.desktopId?.trim()) return mobileStatus.desktopId.trim();

  const envId = await readEnvString("KANNA_TRANSFER_PEER_ID");
  if (envId.trim()) return envId.trim();

  return null;
}

async function readEnvString(name: string): Promise<string> {
  const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
  return typeof value === "string" ? value : "";
}
