import type { CloudTaskSnapshot } from "./types.js";

const ACTIVITIES = new Set(["idle", "working", "unread"]);
const STATUSES = new Set(["active", "blocked", "pr", "merge", "done", "transferring"]);
const TRANSFER_STATES = new Set(["none", "outgoing", "incoming", "finalization_pending"]);
const AGENT_PROVIDERS = new Set(["claude", "copilot", "codex", "opencode"]);

export interface TaskSnapshotWrite {
  path: string;
  data: CloudTaskSnapshot;
}

export function validateTaskSnapshotInput(input: unknown): CloudTaskSnapshot {
  const record = requireRecord(input, "snapshot");
  const promptSnippet = nullableString(record.promptSnippet, "promptSnippet");
  if (promptSnippet && promptSnippet.length > 500) {
    throw new Error("promptSnippet must be 500 characters or fewer");
  }

  const snapshot: CloudTaskSnapshot = {
    cloudTaskId: requireString(record, "cloudTaskId"),
    ownerDesktopId: requireString(record, "ownerDesktopId"),
    ownerLocalTaskId: requireString(record, "ownerLocalTaskId"),
    title: requireString(record, "title"),
    promptSnippet,
    displayName: nullableString(record.displayName, "displayName"),
    stage: requireString(record, "stage"),
    activity: enumString(record.activity, ACTIVITIES, "activity") as CloudTaskSnapshot["activity"],
    status: enumString(record.status, STATUSES, "status") as CloudTaskSnapshot["status"],
    repo: validateRepo(record.repo),
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

export function buildTaskSnapshotWrite(uid: string, input: unknown): TaskSnapshotWrite {
  const snapshot = validateTaskSnapshotInput(input);
  return {
    path: `users/${uid}/tasks/${snapshot.cloudTaskId}`,
    data: snapshot,
  };
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
