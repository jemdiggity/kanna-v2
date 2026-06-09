import type { CloudTaskSnapshot } from "./types.js";

const ACTIVITIES = new Set(["idle", "working", "unread"]);
const STATUSES = new Set(["active", "blocked", "pr", "merge", "done", "transferring"]);
const TRANSFER_STATES = new Set(["none", "outgoing", "incoming", "finalization_pending"]);
const AGENT_PROVIDERS = new Set(["claude", "copilot", "codex", "opencode"]);

export interface TaskSnapshotIdentity {
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
}

export type TaskSnapshotRequest =
  | { action: "upsert"; snapshot: CloudTaskSnapshot }
  | { action: "delete"; identity: TaskSnapshotIdentity }
  | { action: "reconcile"; ownerDesktopId: string; snapshots: CloudTaskSnapshot[] };

export interface ExistingTaskSnapshotDoc {
  id: string;
  data: Record<string, unknown>;
}

export type TaskSnapshotMutation =
  | { type: "create"; data: CloudTaskSnapshot }
  | { type: "update"; docId: string; data: CloudTaskSnapshot }
  | { type: "delete"; docId: string };

export function validateTaskSnapshotInput(input: unknown): CloudTaskSnapshot {
  const record = requireRecord(input, "snapshot");
  const promptSnippet = nullableString(record.promptSnippet, "promptSnippet");
  if (promptSnippet && promptSnippet.length > 500) {
    throw new Error("promptSnippet must be 500 characters or fewer");
  }
  const repo = validateRepo(record.repo);

  const snapshot: CloudTaskSnapshot = {
    ...optionalCloudTaskId(record),
    ownerDesktopId: requireString(record, "ownerDesktopId"),
    localRepoId: optionalString(record.localRepoId, "localRepoId") ?? repo.cloudRepoId,
    ownerLocalTaskId: requireString(record, "ownerLocalTaskId"),
    title: requireString(record, "title"),
    promptSnippet,
    displayName: nullableString(record.displayName, "displayName"),
    stage: requireString(record, "stage"),
    activity: enumString(record.activity, ACTIVITIES, "activity") as CloudTaskSnapshot["activity"],
    status: enumString(record.status, STATUSES, "status") as CloudTaskSnapshot["status"],
    repo,
    branch: nullableString(record.branch, "branch"),
    baseRef: nullableString(record.baseRef, "baseRef"),
    prNumber: nullableNumber(record.prNumber, "prNumber"),
    prUrl: nullableString(record.prUrl, "prUrl"),
    agent: validateAgent(record.agent),
    transfer: validateTransfer(record.transfer),
    blockedByTaskIds: stringArray(record.blockedByTaskIds, "blockedByTaskIds"),
    createdAt: requireString(record, "createdAt"),
    updatedAt: requireString(record, "updatedAt"),
    closedAt: nullableString(record.closedAt, "closedAt"),
  };

  return snapshot;
}

export function buildTaskSnapshotRequest(input: unknown): TaskSnapshotRequest {
  const record = requireRecord(input, "request");
  if (typeof record.action !== "string") {
    return {
      action: "upsert",
      snapshot: validateTaskSnapshotInput(input),
    };
  }

  if (record.action === "upsert") {
    return {
      action: "upsert",
      snapshot: validateTaskSnapshotInput(record.snapshot),
    };
  }

  if (record.action === "delete") {
    return {
      action: "delete",
      identity: validateTaskSnapshotIdentity(record.identity),
    };
  }

  if (record.action === "reconcile") {
    const ownerDesktopId = requireString(record, "ownerDesktopId");
    if (!Array.isArray(record.snapshots)) {
      throw new Error("snapshots must be an array");
    }
    const snapshots = record.snapshots.map((snapshot) => validateTaskSnapshotInput(snapshot));
    if (snapshots.some((snapshot) => snapshot.ownerDesktopId !== ownerDesktopId)) {
      throw new Error("snapshots must belong to ownerDesktopId");
    }
    return { action: "reconcile", ownerDesktopId, snapshots };
  }

  throw new Error("action is invalid");
}

export function buildTaskSnapshotMutations({
  existingDocs,
  snapshots,
}: {
  existingDocs: ExistingTaskSnapshotDoc[];
  snapshots: CloudTaskSnapshot[];
}): TaskSnapshotMutation[] {
  const mutations: TaskSnapshotMutation[] = [];
  const matchedDocIds = new Set<string>();

  for (const snapshot of snapshots) {
    const matchingDocs = sortDocsNewestFirst(existingDocs.filter((doc) =>
      snapshotIdentityKeyFromData(doc.data) === snapshotIdentityKey(snapshot),
    ));
    const [target, ...duplicates] = matchingDocs;
    if (target) {
      matchedDocIds.add(target.id);
      mutations.push({ type: "update", docId: target.id, data: snapshot });
    } else {
      mutations.push({ type: "create", data: snapshot });
    }

    for (const duplicate of duplicates) {
      matchedDocIds.add(duplicate.id);
      mutations.push({ type: "delete", docId: duplicate.id });
    }
  }

  const openKeys = new Set(snapshots.map(snapshotIdentityKey));
  for (const doc of existingDocs) {
    if (matchedDocIds.has(doc.id)) continue;
    const key = snapshotIdentityKeyFromData(doc.data);
    if (!key || !openKeys.has(key)) {
      mutations.push({ type: "delete", docId: doc.id });
    }
  }

  return mutations;
}

export function taskSnapshotIdentityMatchesData(
  identity: TaskSnapshotIdentity,
  data: Record<string, unknown>,
): boolean {
  return snapshotIdentityKeyFromData(data) === identityKey(identity);
}

function validateTaskSnapshotIdentity(input: unknown): TaskSnapshotIdentity {
  const record = requireRecord(input, "identity");
  return {
    ownerDesktopId: requireString(record, "ownerDesktopId"),
    localRepoId: requireString(record, "localRepoId"),
    ownerLocalTaskId: requireString(record, "ownerLocalTaskId"),
  };
}

function sortDocsNewestFirst<T extends ExistingTaskSnapshotDoc>(docs: T[]): T[] {
  return [...docs].sort((left, right) =>
    readUpdatedAt(right.data).localeCompare(readUpdatedAt(left.data)),
  );
}

function readUpdatedAt(data: Record<string, unknown>): string {
  return typeof data.updatedAt === "string" ? data.updatedAt : "";
}

function snapshotIdentityKey(snapshot: CloudTaskSnapshot): string {
  return identityKey({
    ownerDesktopId: snapshot.ownerDesktopId,
    localRepoId: snapshot.localRepoId,
    ownerLocalTaskId: snapshot.ownerLocalTaskId,
  });
}

function snapshotIdentityKeyFromData(data: Record<string, unknown>): string | null {
  const ownerDesktopId = typeof data.ownerDesktopId === "string" ? data.ownerDesktopId : null;
  const localRepoId = typeof data.localRepoId === "string"
    ? data.localRepoId
    : readLegacyCloudRepoId(data);
  const ownerLocalTaskId = typeof data.ownerLocalTaskId === "string"
    ? data.ownerLocalTaskId
    : null;
  if (!ownerDesktopId || !localRepoId || !ownerLocalTaskId) return null;
  return identityKey({ ownerDesktopId, localRepoId, ownerLocalTaskId });
}

function identityKey(identity: TaskSnapshotIdentity): string {
  return `${identity.ownerDesktopId}\u0000${identity.localRepoId}\u0000${identity.ownerLocalTaskId}`;
}

function readLegacyCloudRepoId(data: Record<string, unknown>): string | null {
  const repo = data.repo;
  if (!repo || typeof repo !== "object") return null;
  const cloudRepoId = (repo as { cloudRepoId?: unknown }).cloudRepoId;
  return typeof cloudRepoId === "string" ? cloudRepoId : null;
}

function validateRepo(value: unknown): CloudTaskSnapshot["repo"] {
  const record = requireRecord(value, "repo");
  return {
    cloudRepoId: requireString(record, "cloudRepoId"),
    name: requireString(record, "name"),
    remoteUrl: nullableString(record.remoteUrl, "remoteUrl"),
    remoteUrlHash: nullableString(record.remoteUrlHash, "remoteUrlHash"),
    defaultBranch: nullableString(record.defaultBranch, "defaultBranch"),
  };
}

function optionalCloudTaskId(record: Record<string, unknown>): Pick<CloudTaskSnapshot, "cloudTaskId"> {
  if (record.cloudTaskId === null || record.cloudTaskId === undefined) return {};
  return { cloudTaskId: requireString(record, "cloudTaskId") };
}

function validateAgent(value: unknown): CloudTaskSnapshot["agent"] {
  const record = requireRecord(value, "agent");
  const provider = enumString(record.provider, AGENT_PROVIDERS, "agent.provider");
  return {
    provider: provider as CloudTaskSnapshot["agent"]["provider"],
    type: requireString(record, "type"),
  };
}

function validateTransfer(value: unknown): CloudTaskSnapshot["transfer"] {
  const record = requireRecord(value, "transfer");
  return {
    state: enumString(
      record.state,
      TRANSFER_STATES,
      "transfer.state",
    ) as CloudTaskSnapshot["transfer"]["state"],
    transferId: nullableString(record.transferId, "transfer.transferId"),
    sourceDesktopId: nullableString(record.sourceDesktopId, "transfer.sourceDesktopId"),
    destinationDesktopId: nullableString(
      record.destinationDesktopId,
      "transfer.destinationDesktopId",
    ),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number or null`);
  }
  return value;
}

function enumString(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}
