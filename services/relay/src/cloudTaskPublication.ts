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

export interface CloudTransferIdentity {
  peerId: string;
  publicKey: string;
  protocolVersion: number;
  acceptingTransfers: boolean;
}

export interface ValidatedCloudTaskPublication {
  displayName: string;
  /** Agent provider CLIs installed on the publishing desktop, or null from a
   * desktop build that predates the field. Stored verbatim (shape-validated,
   * not enum-validated): the relay ships separately from the desktop, so a
   * desktop that learns a new provider must not need a relay deploy. */
  agentProviders: string[] | null;
  transfer: CloudTransferIdentity | null;
  tasks: CloudTaskDocument[];
}

export interface CloudTaskPublicationGeneration {
  session: number;
  sequence: number;
}

export interface CloudTaskPublicationStore {
  reconcile(input: {
    userId: string;
    desktopId: string;
    generation: CloudTaskPublicationGeneration;
    displayName: string;
    agentProviders: string[] | null;
    transfer: CloudTransferIdentity | null;
    tasks: CloudTaskDocument[];
  }): Promise<void>;
}

export interface CloudTaskPublicationSessionStore extends CloudTaskPublicationStore {
  beginSession(input: {
    userId: string;
    desktopId: string;
  }): Promise<number>;
  endSession(input: {
    userId: string;
    desktopId: string;
    generation: number;
  }): Promise<boolean>;
}

export interface CloudTaskPublicationFaultInjection {
  afterGenerationClaim?(generation: CloudTaskPublicationGeneration): Promise<void>;
  onTaskCollectionRead?(): void;
  onTaskDocumentWrite?(kind: "set" | "delete", id: string): void;
}

export interface TaskReconciliationPlan {
  sets: Array<{ id: string; data: CloudTaskDocument }>;
  deleteIds: string[];
}

interface ExistingTaskDocument {
  id: string;
  data: unknown;
  fingerprint?: string;
}

interface CachedTaskDocument extends ExistingTaskDocument {
  fingerprint: string;
}

interface PublicationSessionState {
  tasksByIdentity: Map<string, CachedTaskDocument[]>;
  reconciliationTail: Promise<void>;
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
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) {
    throw new Error("task snapshot schemaVersion must be 1 or 2");
  }
  const schemaVersion = root.schemaVersion;
  const desktop = requiredRecord(root.desktop, "task snapshot desktop");
  const displayName = requiredString(desktop.displayName, "desktop.displayName", 256);
  const agentProviders = validateAgentProviders(desktop.agentProviders);
  const transfer = desktop.transfer === undefined || desktop.transfer === null
    ? null
    : validateCloudTransferIdentity(desktop.transfer);
  if (!Array.isArray(root.tasks)) {
    throw new Error("task snapshot tasks must be an array");
  }
  if (root.tasks.length > MAX_TASKS) {
    throw new Error(`task snapshot may contain at most ${MAX_TASKS} tasks`);
  }

  const identities = new Set<string>();
  const tasks = root.tasks.map((raw, index) => {
    const task = validateTask(raw, index, authenticatedDesktopId, schemaVersion);
    const key = taskIdentity(task);
    if (identities.has(key)) {
      throw new Error(`task snapshot contains duplicate identity ${key}`);
    }
    identities.add(key);
    return task;
  });
  return { displayName, agentProviders, transfer, tasks };
}

const MAX_AGENT_PROVIDERS = 32;

function validateAgentProviders(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_AGENT_PROVIDERS) {
    throw new Error(
      `desktop.agentProviders must be an array of at most ${MAX_AGENT_PROVIDERS} provider names`,
    );
  }
  return value.map((provider, index) =>
    requiredNonblankString(provider, `desktop.agentProviders[${index}]`, 64));
}

function validateCloudTransferIdentity(value: unknown): CloudTransferIdentity {
  const transfer = requiredRecord(value, "desktop.transfer");
  return {
    peerId: requiredNonblankString(transfer.peerId, "desktop.transfer.peerId", 256),
    publicKey: requiredNonblankString(transfer.publicKey, "desktop.transfer.publicKey", 4096),
    protocolVersion: requiredPositiveInteger(
      transfer.protocolVersion,
      "desktop.transfer.protocolVersion",
    ),
    acceptingTransfers: requiredBoolean(
      transfer.acceptingTransfers,
      "desktop.transfer.acceptingTransfers",
    ),
  };
}

function validateTask(
  value: unknown,
  index: number,
  desktopId: string,
  schemaVersion: 1 | 2,
): CloudTaskDocument {
  const path = `tasks[${index}]`;
  const task = requiredRecord(value, path);
  const cloudTaskId = task.cloudTaskId === undefined
    ? undefined
    : requiredString(task.cloudTaskId, `${path}.cloudTaskId`, 128);
  const ownerDesktopId = requiredString(task.ownerDesktopId, `${path}.ownerDesktopId`, 128);
  if (ownerDesktopId !== desktopId) {
    throw new Error(`${path}.ownerDesktopId must match the authenticated desktop`);
  }
  const localRepoId = requiredString(task.localRepoId, `${path}.localRepoId`, 128);
  const ownerLocalTaskId = requiredString(task.ownerLocalTaskId, `${path}.ownerLocalTaskId`, 128);
  const repo = requiredRecord(task.repo, `${path}.repo`);
  const agent = requiredRecord(task.agent, `${path}.agent`);
  const transfer = requiredRecord(task.transfer, `${path}.transfer`);
  const transferState = requiredString(transfer.state, `${path}.transfer.state`, 32);
  if (!new Set(["none", "outgoing", "incoming", "finalization_pending"]).has(transferState)) {
    throw new Error(`${path}.transfer.state is invalid`);
  }
  if (schemaVersion === 1 && transferState !== "none") {
    throw new Error(`${path}.transfer.state must be none for schemaVersion 1`);
  }
  const validatedTransfer = transferState === "none"
    ? validateEmptyTransfer(transfer, path)
    : {
        state: transferState,
        transferId: requiredNonblankString(
          transfer.transferId,
          `${path}.transfer.transferId`,
          128,
        ),
        sourceDesktopId: requiredNonblankString(
          transfer.sourceDesktopId,
          `${path}.transfer.sourceDesktopId`,
          128,
        ),
        destinationDesktopId: requiredNonblankString(
          transfer.destinationDesktopId,
          `${path}.transfer.destinationDesktopId`,
          128,
        ),
      };
  if (
    transferState === "outgoing"
    && validatedTransfer.sourceDesktopId !== desktopId
  ) {
    throw new Error(`${path}.transfer.sourceDesktopId must match the authenticated desktop`);
  }
  if (
    (transferState === "incoming" || transferState === "finalization_pending")
    && validatedTransfer.destinationDesktopId !== desktopId
  ) {
    throw new Error(`${path}.transfer.destinationDesktopId must match the authenticated desktop`);
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
  const activityRevision = optionalNonNegativeInteger(
    task.activityRevision,
    `${path}.activityRevision`,
  );
  const blockerRevision = optionalNonNegativeInteger(
    task.blockerRevision,
    `${path}.blockerRevision`,
  );
  const transitionRevision = optionalNullableString(
    task.transitionRevision,
    `${path}.transitionRevision`,
    128,
  );
  if (transitionRevision !== null && transitionRevision.length === 0) {
    throw new Error(`${path}.transitionRevision must be null or a non-empty string`);
  }
  const pinOrder = optionalNullableInteger(task.pinOrder, `${path}.pinOrder`);

  return {
    ...(cloudTaskId === undefined ? {} : { cloudTaskId }),
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
    ...(activityRevision === undefined ? {} : { activityRevision }),
    ...(blockerRevision === undefined ? {} : { blockerRevision }),
    transitionRevision,
    status,
    hasRunningPost: optionalBoolean(task.hasRunningPost, `${path}.hasRunningPost`),
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
    transfer: validatedTransfer,
    blockedByTaskIds,
    parentTaskId: optionalNullableString(task.parentTaskId, `${path}.parentTaskId`, 128),
    pinned: optionalBoolean(task.pinned, `${path}.pinned`),
    ...(pinOrder === undefined ? {} : { pinOrder }),
    createdAt: requiredString(task.createdAt, `${path}.createdAt`, 64),
    updatedAt: requiredString(task.updatedAt, `${path}.updatedAt`, 64),
    closedAt: null,
  };
}

function validateEmptyTransfer(
  transfer: Record<string, unknown>,
  path: string,
): {
  state: "none";
  transferId: null;
  sourceDesktopId: null;
  destinationDesktopId: null;
} {
  for (const field of ["transferId", "sourceDesktopId", "destinationDesktopId"] as const) {
    if (transfer[field] !== null) {
      throw new Error(`${path}.transfer.${field} must be null`);
    }
  }
  return {
    state: "none",
    transferId: null,
    sourceDesktopId: null,
    destinationDesktopId: null,
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
    if (
      !matches[0]
      || (matches[0].fingerprint ?? taskFingerprint(matches[0].data)) !== taskFingerprint(task)
    ) {
      sets.push({ id: targetId, data: task });
    }
  }
  const deleteIds = existing
    .map((document) => document.id)
    .filter((id) => !retainedIds.has(id));
  return { sets, deleteIds };
}

export async function handleCloudTaskPublication(input: {
  userId: string;
  desktopId: string;
  generation: CloudTaskPublicationGeneration;
  snapshot: unknown;
  store?: CloudTaskPublicationStore;
}): Promise<void> {
  validatePublicationGeneration(input.generation);
  const publication = validateCloudTaskPublication(input.snapshot, input.desktopId);
  const store = input.store ?? createFirestoreCloudTaskPublicationStore();
  await store.reconcile({
    userId: input.userId,
    desktopId: input.desktopId,
    generation: input.generation,
    displayName: publication.displayName,
    agentProviders: publication.agentProviders,
    transfer: publication.transfer,
    tasks: publication.tasks,
  });
}

export async function beginCloudTaskPublicationSession(input: {
  userId: string;
  desktopId: string;
  store?: CloudTaskPublicationSessionStore;
}): Promise<number> {
  const store = input.store ?? createFirestoreCloudTaskPublicationStore();
  return await store.beginSession({
    userId: input.userId,
    desktopId: input.desktopId,
  });
}

export async function endCloudTaskPublicationSession(input: {
  userId: string;
  desktopId: string;
  generation: number;
  store?: CloudTaskPublicationSessionStore;
}): Promise<boolean> {
  const store = input.store ?? createFirestoreCloudTaskPublicationStore();
  return await store.endSession({
    userId: input.userId,
    desktopId: input.desktopId,
    generation: input.generation,
  });
}

export function createFirestoreCloudTaskPublicationStore(
  db: Firestore = getFirebaseServices().db,
  faultInjection?: CloudTaskPublicationFaultInjection,
): CloudTaskPublicationSessionStore {
  const sessionStates = new Map<string, PublicationSessionState>();

  return {
    async beginSession({ userId, desktopId }) {
      const desktopDocId = cloudDesktopDocumentId(desktopId);
      const desktopsRef = db.collection(`users/${userId}/desktops`);
      const desktopRef = desktopsRef.doc(desktopDocId);
      const generation = await db.runTransaction(async (transaction) => {
        const current = await transaction.get(desktopRef);
        const currentGeneration = storedGenerationPart(
          current.data()?.publicationSessionGeneration,
        );
        const nextGeneration = currentGeneration + 1;
        if (!Number.isSafeInteger(nextGeneration)) {
          throw new Error("cloud task publication generation exhausted");
        }
        transaction.set(desktopRef, {
          desktopId,
          publicationSessionGeneration: nextGeneration,
          publicationSequence: 0,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return nextGeneration;
      });
      faultInjection?.onTaskCollectionRead?.();
      const tasks = await desktopRef.collection("tasks").get();
      sessionStates.set(publicationSessionKey(userId, desktopId, generation), {
        tasksByIdentity: indexTaskDocuments(tasks.docs.map((document) => ({
          id: document.id,
          data: document.data(),
        }))),
        reconciliationTail: Promise.resolve(),
      });
      return generation;
    },

    async endSession({ userId, desktopId, generation }) {
      const desktopDocId = cloudDesktopDocumentId(desktopId);
      const desktopRef = db.doc(`users/${userId}/desktops/${desktopDocId}`);
      const ended = await db.runTransaction(async (transaction) => {
        const current = await transaction.get(desktopRef);
        if (storedGenerationPart(
          current.data()?.publicationSessionGeneration,
        ) !== generation) {
          return false;
        }
        transaction.set(desktopRef, {
          transfer: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return true;
      });
      sessionStates.delete(publicationSessionKey(userId, desktopId, generation));
      return ended;
    },

    async reconcile({
      userId,
      desktopId,
      generation,
      displayName,
      agentProviders,
      transfer,
      tasks,
    }) {
      validatePublicationGeneration(generation);
      const desktopDocId = cloudDesktopDocumentId(desktopId);
      const desktopsRef = db.collection(`users/${userId}/desktops`);
      const desktopRef = desktopsRef.doc(desktopDocId);
      const stateKey = publicationSessionKey(userId, desktopId, generation.session);
      let sessionState = sessionStates.get(stateKey);
      if (!sessionState) {
        faultInjection?.onTaskCollectionRead?.();
        const seededTasks = await desktopRef.collection("tasks").get();
        sessionState = {
          tasksByIdentity: indexTaskDocuments(seededTasks.docs.map((document) => ({
            id: document.id,
            data: document.data(),
          }))),
          reconciliationTail: Promise.resolve(),
        };
        sessionStates.set(stateKey, sessionState);
      }
      const previousReconciliation = sessionState.reconciliationTail;
      let releaseReconciliation: () => void = () => undefined;
      sessionState.reconciliationTail = new Promise((resolve) => {
        releaseReconciliation = resolve;
      });
      await previousReconciliation;
      try {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(desktopRef);
        const currentGeneration = storedPublicationGeneration(current.data());
        if (
          currentGeneration.session !== generation.session
          || currentGeneration.sequence > generation.sequence
        ) {
          throw stalePublicationError(generation, currentGeneration);
        }
        transaction.set(desktopRef, {
          desktopId,
          displayName,
          agentProviders: agentProviders ?? FieldValue.delete(),
          transfer: transfer ?? FieldValue.delete(),
          publicationSequence: generation.sequence,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await faultInjection?.afterGenerationClaim?.(generation);

      const tasksRef = desktopRef.collection("tasks");
      const existing = [...sessionState.tasksByIdentity.values()].flat();
      const plan = planTaskReconciliation(
        existing,
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
      if (operations.length === 0) {
        await db.runTransaction(async (transaction) => {
          await requireCurrentPublication(transaction, desktopRef, generation);
        });
      }
      for (let offset = 0; offset < operations.length; offset += MAX_BATCH_OPERATIONS) {
        await db.runTransaction(async (transaction) => {
          await requireCurrentPublication(transaction, desktopRef, generation);
          for (const operation of operations.slice(offset, offset + MAX_BATCH_OPERATIONS)) {
            const ref = tasksRef.doc(operation.id);
            if (operation.kind === "set") transaction.set(ref, operation.data);
            else transaction.delete(ref);
            faultInjection?.onTaskDocumentWrite?.(operation.kind, operation.id);
          }
        });
      }
      sessionState.tasksByIdentity = indexTaskDocuments(planResultDocuments(existing, plan));

      // Older renderer publishers created auto-id desktop documents. The full
      // server reconciliation makes the canonical document authoritative, so
      // remove every duplicate subtree after its tasks have been replaced.
      const matchingDesktops = await desktopsRef.where("desktopId", "==", desktopId).get();
      for (const duplicate of matchingDesktops.docs) {
        if (duplicate.id === desktopRef.id) continue;
        const duplicateTasks = await duplicate.ref.collection("tasks").get();
        for (let offset = 0; offset < duplicateTasks.docs.length; offset += MAX_BATCH_OPERATIONS) {
          await db.runTransaction(async (transaction) => {
            await requireCurrentPublication(transaction, desktopRef, generation);
            for (const document of duplicateTasks.docs.slice(offset, offset + MAX_BATCH_OPERATIONS)) {
              transaction.delete(document.ref);
            }
          });
        }
        await db.runTransaction(async (transaction) => {
          await requireCurrentPublication(transaction, desktopRef, generation);
          transaction.delete(duplicate.ref);
        });
      }
      } finally {
        releaseReconciliation();
      }
    },
  };
}

function cloudDesktopDocumentId(desktopId: string): string {
  return desktopId === "." || desktopId === ".."
    ? `desktop-${Buffer.from(desktopId).toString("hex")}`
    : desktopId.replaceAll("/", "_");
}

async function requireCurrentPublication(
  transaction: FirebaseFirestore.Transaction,
  desktopRef: FirebaseFirestore.DocumentReference,
  generation: CloudTaskPublicationGeneration,
): Promise<void> {
  const current = await transaction.get(desktopRef);
  const stored = storedPublicationGeneration(current.data());
  if (
    stored.session !== generation.session
    || stored.sequence !== generation.sequence
  ) {
    throw stalePublicationError(generation, stored);
  }
}

function storedPublicationGeneration(
  data: FirebaseFirestore.DocumentData | undefined,
): CloudTaskPublicationGeneration {
  return {
    session: storedGenerationPart(data?.publicationSessionGeneration),
    sequence: storedGenerationPart(data?.publicationSequence),
  };
}

function storedGenerationPart(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function validatePublicationGeneration(generation: CloudTaskPublicationGeneration): void {
  if (
    !Number.isSafeInteger(generation.session)
    || generation.session <= 0
    || !Number.isSafeInteger(generation.sequence)
    || generation.sequence <= 0
  ) {
    throw new Error("cloud task publication generation must contain positive safe integers");
  }
}

function stalePublicationError(
  attempted: CloudTaskPublicationGeneration,
  current: CloudTaskPublicationGeneration,
): Error {
  return new Error(
    `stale cloud task publication ${attempted.session}/${attempted.sequence}; `
    + `current generation is ${current.session}/${current.sequence}`,
  );
}

function taskIdentity(task: Pick<CloudTaskDocument, "localRepoId" | "ownerLocalTaskId">): string {
  return `${task.localRepoId}\u0000${task.ownerLocalTaskId}`;
}

function taskIdentityFromUnknown(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.localRepoId !== "string" || typeof value.ownerLocalTaskId !== "string") return null;
  return `${value.localRepoId}\u0000${value.ownerLocalTaskId}`;
}

function taskFingerprint(value: unknown): string {
  return JSON.stringify(value, (_, nestedValue: unknown) => {
    if (!isRecord(nestedValue)) return nestedValue;
    return Object.fromEntries(Object.entries(nestedValue).sort(([left], [right]) =>
      left.localeCompare(right)));
  });
}

function indexTaskDocuments(
  documents: ExistingTaskDocument[],
): Map<string, CachedTaskDocument[]> {
  const result = new Map<string, CachedTaskDocument[]>();
  for (const document of documents) {
    const identity = taskIdentityFromUnknown(document.data) ?? `\u0001${document.id}`;
    const cached = { ...document, fingerprint: taskFingerprint(document.data) };
    result.set(identity, [...(result.get(identity) ?? []), cached]);
  }
  return result;
}

function planResultDocuments(
  existing: ExistingTaskDocument[],
  plan: TaskReconciliationPlan,
): ExistingTaskDocument[] {
  const deleted = new Set(plan.deleteIds);
  const byId = new Map(existing.filter(({ id }) => !deleted.has(id)).map((document) => [
    document.id,
    document,
  ]));
  for (const operation of plan.sets) byId.set(operation.id, operation);
  return [...byId.values()];
}

function publicationSessionKey(userId: string, desktopId: string, generation: number): string {
  return `${userId}\u0000${desktopId}\u0000${generation}`;
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

function requiredNonblankString(value: unknown, field: string, maxLength: number): string {
  const stringValue = requiredString(value, field, maxLength);
  if (stringValue.trim().length === 0) {
    throw new Error(`${field} must be a nonblank string`);
  }
  return stringValue;
}

function nullableString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${field} must be null or a string of at most ${maxLength} characters`);
  }
  return value;
}

// Missing on snapshots from older desktop publishers; treated as "no parent".
function optionalNullableString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined) return null;
  return nullableString(value, field, maxLength);
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

// Missing on snapshots from older desktop publishers; treated as "no running post".
function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalNullableInteger(
  value: unknown,
  field: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be null or an integer`);
  }
  return value as number;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be null or a non-negative integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer when present`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}
