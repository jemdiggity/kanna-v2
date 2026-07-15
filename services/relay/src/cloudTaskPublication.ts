import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getFirebaseServices } from "./firebase.js";

export const MAX_TASK_SNAPSHOT_BYTES = 512 * 1024;
const MAX_TASKS = 250;
const MAX_BATCH_OPERATIONS = 400;

export type CloudTaskDocument = Record<string, unknown> & {
  localRepoId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
};

export interface ValidatedCloudTaskPublication {
  displayName: string;
  tasks: CloudTaskDocument[];
}

export interface CloudTaskPublicationStore {
  reconcile(input: {
    userId: string;
    desktopId: string;
    displayName: string;
    tasks: CloudTaskDocument[];
  }): Promise<void>;
}

export interface TaskReconciliationPlan {
  sets: Array<{ id: string; data: CloudTaskDocument }>;
  deleteIds: string[];
}

interface ExistingTaskDocument {
  id: string;
  data: unknown;
}

export function validateCloudTaskPublication(
  value: unknown,
  authenticatedDesktopId: string,
): ValidatedCloudTaskPublication {
  const root = requiredRecord(value, "task snapshot");
  const encodedBytes = Buffer.byteLength(JSON.stringify(root));
  if (encodedBytes > MAX_TASK_SNAPSHOT_BYTES) {
    throw new Error(`task snapshot exceeds ${MAX_TASK_SNAPSHOT_BYTES} bytes`);
  }
  if (root.schemaVersion !== 1) {
    throw new Error("task snapshot schemaVersion must be 1");
  }
  const desktop = requiredRecord(root.desktop, "task snapshot desktop");
  const displayName = requiredString(desktop.displayName, "desktop.displayName", 256);
  if (!Array.isArray(root.tasks)) {
    throw new Error("task snapshot tasks must be an array");
  }
  if (root.tasks.length > MAX_TASKS) {
    throw new Error(`task snapshot may contain at most ${MAX_TASKS} tasks`);
  }

  const identities = new Set<string>();
  const tasks = root.tasks.map((raw, index) => {
    const task = validateTask(raw, index, authenticatedDesktopId);
    const key = taskIdentity(task);
    if (identities.has(key)) {
      throw new Error(`task snapshot contains duplicate identity ${key}`);
    }
    identities.add(key);
    return task;
  });
  return { displayName, tasks };
}

function validateTask(value: unknown, index: number, desktopId: string): CloudTaskDocument {
  const path = `tasks[${index}]`;
  const task = requiredRecord(value, path);
  const ownerDesktopId = requiredString(task.ownerDesktopId, `${path}.ownerDesktopId`, 128);
  if (ownerDesktopId !== desktopId) {
    throw new Error(`${path}.ownerDesktopId must match the authenticated desktop`);
  }
  const localRepoId = requiredString(task.localRepoId, `${path}.localRepoId`, 128);
  const ownerLocalTaskId = requiredString(task.ownerLocalTaskId, `${path}.ownerLocalTaskId`, 128);
  const repo = requiredRecord(task.repo, `${path}.repo`);
  const agent = requiredRecord(task.agent, `${path}.agent`);
  const transfer = requiredRecord(task.transfer, `${path}.transfer`);
  if (transfer.state !== "none") throw new Error(`${path}.transfer.state must be none`);
  for (const field of ["transferId", "sourceDesktopId", "destinationDesktopId"] as const) {
    if (transfer[field] !== null) throw new Error(`${path}.transfer.${field} must be null`);
  }
  if (!Array.isArray(task.blockedByTaskIds) || task.blockedByTaskIds.length > 100) {
    throw new Error(`${path}.blockedByTaskIds must be an array of at most 100 ids`);
  }
  const blockedByTaskIds = task.blockedByTaskIds.map((id, blockerIndex) =>
    requiredString(id, `${path}.blockedByTaskIds[${blockerIndex}]`, 128));
  const status = requiredString(task.status, `${path}.status`, 16);
  if (!new Set(["active", "blocked", "pr", "done"]).has(status)) {
    throw new Error(`${path}.status is invalid`);
  }
  if (task.closedAt !== null) throw new Error(`${path}.closedAt must be null for an open task`);

  return {
    localRepoId,
    ownerDesktopId,
    ownerLocalTaskId,
    title: requiredString(task.title, `${path}.title`, 512),
    promptSnippet: nullableString(task.promptSnippet, `${path}.promptSnippet`, 500),
    waitingPromptSnippet: optionalNullableUnicodeString(
      task.waitingPromptSnippet,
      `${path}.waitingPromptSnippet`,
      240,
    ),
    displayName: nullableString(task.displayName, `${path}.displayName`, 512),
    stage: requiredString(task.stage, `${path}.stage`, 64),
    activity: requiredString(task.activity, `${path}.activity`, 32),
    status,
    repo: {
      cloudRepoId: requiredString(repo.cloudRepoId, `${path}.repo.cloudRepoId`, 128),
      name: requiredString(repo.name, `${path}.repo.name`, 256),
      remoteUrl: nullableString(repo.remoteUrl, `${path}.repo.remoteUrl`, 2048),
      remoteUrlHash: nullableString(repo.remoteUrlHash, `${path}.repo.remoteUrlHash`, 128),
      defaultBranch: nullableString(repo.defaultBranch, `${path}.repo.defaultBranch`, 512),
    },
    branch: nullableString(task.branch, `${path}.branch`, 512),
    baseRef: nullableString(task.baseRef, `${path}.baseRef`, 512),
    prNumber: nullableInteger(task.prNumber, `${path}.prNumber`),
    prUrl: nullableString(task.prUrl, `${path}.prUrl`, 2048),
    agent: {
      provider: requiredString(agent.provider, `${path}.agent.provider`, 64),
      type: requiredString(agent.type, `${path}.agent.type`, 32),
    },
    transfer: {
      state: "none",
      transferId: null,
      sourceDesktopId: null,
      destinationDesktopId: null,
    },
    blockedByTaskIds,
    createdAt: requiredString(task.createdAt, `${path}.createdAt`, 64),
    updatedAt: requiredString(task.updatedAt, `${path}.updatedAt`, 64),
    closedAt: null,
  };
}

export function planTaskReconciliation(
  existing: ExistingTaskDocument[],
  tasks: CloudTaskDocument[],
  newId: () => string,
): TaskReconciliationPlan {
  const existingByIdentity = new Map<string, ExistingTaskDocument[]>();
  for (const document of existing) {
    const key = taskIdentityFromUnknown(document.data);
    if (!key) continue;
    existingByIdentity.set(key, [...(existingByIdentity.get(key) ?? []), document]);
  }

  const sets: TaskReconciliationPlan["sets"] = [];
  const retainedIds = new Set<string>();
  for (const task of tasks) {
    const matches = existingByIdentity.get(taskIdentity(task)) ?? [];
    const targetId = matches[0]?.id ?? newId();
    retainedIds.add(targetId);
    sets.push({ id: targetId, data: task });
  }
  const deleteIds = existing
    .map((document) => document.id)
    .filter((id) => !retainedIds.has(id));
  return { sets, deleteIds };
}

export async function handleCloudTaskPublication(input: {
  userId: string;
  desktopId: string;
  snapshot: unknown;
  store?: CloudTaskPublicationStore;
}): Promise<void> {
  const publication = validateCloudTaskPublication(input.snapshot, input.desktopId);
  const store = input.store ?? createFirestoreCloudTaskPublicationStore();
  await store.reconcile({
    userId: input.userId,
    desktopId: input.desktopId,
    displayName: publication.displayName,
    tasks: publication.tasks,
  });
}

export function createFirestoreCloudTaskPublicationStore(
  db: Firestore = getFirebaseServices().db,
): CloudTaskPublicationStore {
  return {
    async reconcile({ userId, desktopId, displayName, tasks }) {
      const desktopDocId = desktopId === "." || desktopId === ".."
        ? `desktop-${Buffer.from(desktopId).toString("hex")}`
        : desktopId.replaceAll("/", "_");
      const desktopsRef = db.collection(`users/${userId}/desktops`);
      const desktopRef = desktopsRef.doc(desktopDocId);
      await desktopRef.set({
        desktopId,
        displayName,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const tasksRef = desktopRef.collection("tasks");
      const existing = await tasksRef.get();
      const plan = planTaskReconciliation(
        existing.docs.map((document) => ({ id: document.id, data: document.data() })),
        tasks,
        () => tasksRef.doc().id,
      );
      const operations: Array<
        | { kind: "set"; id: string; data: CloudTaskDocument }
        | { kind: "delete"; id: string }
      > = [
        ...plan.sets.map((operation) => ({ kind: "set" as const, ...operation })),
        ...plan.deleteIds.map((id) => ({ kind: "delete" as const, id })),
      ];
      for (let offset = 0; offset < operations.length; offset += MAX_BATCH_OPERATIONS) {
        const batch = db.batch();
        for (const operation of operations.slice(offset, offset + MAX_BATCH_OPERATIONS)) {
          const ref = tasksRef.doc(operation.id);
          if (operation.kind === "set") batch.set(ref, operation.data);
          else batch.delete(ref);
        }
        await batch.commit();
      }

      // Older renderer publishers created auto-id desktop documents. The full
      // server reconciliation makes the canonical document authoritative, so
      // remove every duplicate subtree after its tasks have been replaced.
      const matchingDesktops = await desktopsRef.where("desktopId", "==", desktopId).get();
      for (const duplicate of matchingDesktops.docs) {
        if (duplicate.id === desktopRef.id) continue;
        const duplicateTasks = await duplicate.ref.collection("tasks").get();
        for (let offset = 0; offset < duplicateTasks.docs.length; offset += MAX_BATCH_OPERATIONS) {
          const batch = db.batch();
          for (const document of duplicateTasks.docs.slice(offset, offset + MAX_BATCH_OPERATIONS)) {
            batch.delete(document.ref);
          }
          await batch.commit();
        }
        await duplicate.ref.delete();
      }
    },
  };
}

function taskIdentity(task: Pick<CloudTaskDocument, "localRepoId" | "ownerLocalTaskId">): string {
  return `${task.localRepoId}\u0000${task.ownerLocalTaskId}`;
}

function taskIdentityFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.localRepoId !== "string" || typeof value.ownerLocalTaskId !== "string") return null;
  return `${value.localRepoId}\u0000${value.ownerLocalTaskId}`;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function nullableString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${field} must be null or a string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalNullableUnicodeString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Array.from(value).length > maxLength) {
    throw new Error(`${field} must be null or a string of at most ${maxLength} characters`);
  }
  return value;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be null or a non-negative integer`);
  }
  return value as number;
}
