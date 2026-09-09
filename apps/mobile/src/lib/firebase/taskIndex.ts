import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import type { AgentProvider } from "@kanna/agent-protocol";
import type { TaskActivity, TaskSummary } from "../api/types";
import { parseAgentProviderInventory } from "../api/agentProviders";
import { buildCloudTaskId } from "../api/taskIdentity";
import { canonicalRepoIdForHash } from "../api/repoIdentity";
import { getConfiguredFirestore } from "./configuredFirestore";

export interface CloudTaskSnapshot {
  cloudTaskId?: string;
  localRepoId?: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet?: string | null;
  waitingPromptSnippet?: string | null;
  displayName?: string | null;
  stage: string;
  activity?: string | null;
  activityRevision?: number;
  status?: string;
  repo: { cloudRepoId: string; name: string; remoteUrlHash?: string | null };
  agent?: { provider?: string | null; type?: string | null } | null;
  parentTaskId?: string | null;
  blockedByTaskIds?: string[];
  /** The agent this task is the account-wide singleton for, when it is one.
   * Published by the owner's desktop; it is what lets a phone reading the
   * cloud index pin the singleton by default, exactly as it does on the LAN. */
  singletonAgent?: string | null;
  pinned?: boolean;
  pinOrder?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

export interface CloudTaskSummary extends TaskSummary {
  repoName: string;
  ownerDesktopId: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId: string;
  ownerOnline: boolean;
}

export interface CloudTaskIndexError {
  scope: "root" | "desktop" | "document";
  desktopId?: string;
  error: unknown;
}

export interface CloudDesktopRecord {
  desktopId: string;
  displayName: string;
  updatedAt: string | null;
  /** Agent provider CLIs the desktop published with its task snapshot. Absent
   * from desktops that predate provider inventory publication. */
  agentProviders?: AgentProvider[];
}

export interface CloudTaskIndex {
  listDesktops(uid: string): Promise<CloudDesktopRecord[]>;
  listRecentTasks(uid: string): Promise<CloudTaskSummary[]>;
  // Live subscription: pushes the user's open cloud tasks whenever any peer
  // desktop writes, via onSnapshot. Returns an unsubscribe.
  subscribeRecentTasks(
    uid: string,
    onUpdate: (tasks: CloudTaskSummary[]) => void,
    onError?: (error: CloudTaskIndexError) => void,
  ): () => void;
}

export function createFirestoreTaskIndex(
  db: Firestore = getConfiguredFirestore(),
): CloudTaskIndex {
  return {
    async listDesktops(uid) {
      const desktopsRef = collection(db, "users", uid, "desktops");
      const desktops = await getDocs(desktopsRef);
      return desktops.docs.map((doc) => mapCloudDesktopRecord(doc.id, doc.data()));
    },
    async listRecentTasks(uid) {
      const desktopsRef = collection(db, "users", uid, "desktops");
      const desktops = await getDocs(desktopsRef);
      const snapshots = await Promise.all(desktops.docs.map(async (desktopDoc) => {
        const tasksRef = collection(desktopDoc.ref, "tasks");
        const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
        return parseCloudTaskDocuments(snapshot.docs, desktopDoc.id);
      }));
      return sortCloudTasks(
        snapshots.flat(),
      ).map(mapCloudTaskSnapshot);
    },
    subscribeRecentTasks(uid, onUpdate, onError) {
      let cancelled = false;
      const tasksByDesktop = new Map<string, CloudTaskSnapshot[]>();
      const taskUnsubs = new Map<
        string,
        { generation: number; unsubscribe: () => void }
      >();
      const childGenerations = new Map<string, number>();
      const pendingDesktopIds = new Set<string>();
      let nextGeneration = 0;
      let hasRootSnapshot = false;

      const emit = () => {
        if (cancelled || pendingDesktopIds.size > 0) return;
        const all = [...tasksByDesktop.values()].flat();
        onUpdate(sortCloudTasks(all).map(mapCloudTaskSnapshot));
      };

      const desktopsUnsub = onSnapshot(
        collection(db, "users", uid, "desktops"),
        (desktopsSnapshot) => {
          if (cancelled) return;
          const initialRootSnapshot = !hasRootSnapshot;
          hasRootSnapshot = true;
          const desktopDocs = new Map(
            desktopsSnapshot.docs.map((desktopDoc) => [desktopDoc.id, desktopDoc]),
          );
          const present = new Set(desktopDocs.keys());
          let removedDesktop = false;

          for (const desktopId of [...childGenerations.keys()]) {
            if (present.has(desktopId)) continue;
            childGenerations.delete(desktopId);
            pendingDesktopIds.delete(desktopId);
            tasksByDesktop.delete(desktopId);
            const child = taskUnsubs.get(desktopId);
            taskUnsubs.delete(desktopId);
            child?.unsubscribe();
            removedDesktop = true;
          }

          const addedDesktops = [...desktopDocs].flatMap(([desktopId, desktopDoc]) => {
            if (childGenerations.has(desktopId)) return [];
            const generation = ++nextGeneration;
            childGenerations.set(desktopId, generation);
            pendingDesktopIds.add(desktopId);
            return [{ desktopId, desktopDoc, generation }];
          });

          for (const { desktopId, desktopDoc, generation } of addedDesktops) {
            const tasksQuery = query(
              collection(desktopDoc.ref, "tasks"),
              where("closedAt", "==", null),
            );
            const isCurrent = () =>
              !cancelled && childGenerations.get(desktopId) === generation;
            const unsubscribe = onSnapshot(
              tasksQuery,
              (tasksSnapshot) => {
                if (!isCurrent()) return;
                const tasks = parseCloudTaskDocuments(
                  tasksSnapshot.docs,
                  desktopId,
                  (error) => {
                    if (isCurrent()) onError?.(error);
                  },
                );
                if (!isCurrent()) return;
                tasksByDesktop.set(desktopId, tasks);
                pendingDesktopIds.delete(desktopId);
                emit();
              },
              (error) => {
                if (!isCurrent()) return;
                // Firestore listener errors are terminal. Keep this desktop in
                // the readiness barrier so healthy siblings cannot publish an
                // aggregate containing a missing or retained stale slice. The
                // app-model recovery owner replaces this subscription after a
                // complete one-shot read succeeds.
                pendingDesktopIds.add(desktopId);
                onError?.({ scope: "desktop", desktopId, error });
              },
            );
            if (isCurrent()) {
              taskUnsubs.set(desktopId, { generation, unsubscribe });
            } else {
              unsubscribe();
            }
          }

          if (addedDesktops.length === 0 && (initialRootSnapshot || removedDesktop)) {
            emit();
          }
        },
        (error) => {
          if (cancelled) return;
          onError?.({ scope: "root", error });
        },
      );

      return () => {
        cancelled = true;
        childGenerations.clear();
        pendingDesktopIds.clear();
        desktopsUnsub();
        for (const child of taskUnsubs.values()) child.unsubscribe();
        taskUnsubs.clear();
        tasksByDesktop.clear();
      };
    },
  };
}

interface CloudTaskDocumentLike {
  id?: string;
  data(): unknown;
}

function parseCloudTaskDocuments(
  docs: readonly CloudTaskDocumentLike[],
  desktopId?: string,
  reportError?: (error: CloudTaskIndexError) => void,
): CloudTaskSnapshot[] {
  const tasks: CloudTaskSnapshot[] = [];
  for (const doc of docs) {
    try {
      tasks.push(parseCloudTaskSnapshot(doc.data()));
    } catch (error) {
      reportError?.({ scope: "document", desktopId, error });
    }
  }
  return tasks;
}

function parseCloudTaskSnapshot(value: unknown): CloudTaskSnapshot {
  if (!isRecord(value)) {
    throw new Error("cloud task document must be an object");
  }
  if (!isRecord(value.repo)) {
    throw new Error("cloud task document repo must be an object");
  }
  const createdAt = normalizeCloudTimestamp(value.createdAt);
  if (!createdAt) {
    throw new Error("cloud task document createdAt must be a timestamp");
  }
  const updatedAt = normalizeCloudTimestamp(value.updatedAt);
  if (!updatedAt) {
    throw new Error("cloud task document updatedAt must be a timestamp");
  }

  return {
    cloudTaskId: optionalString(value.cloudTaskId),
    localRepoId: optionalString(value.localRepoId),
    ownerDesktopId: requiredString(value.ownerDesktopId, "ownerDesktopId"),
    ownerLocalTaskId: requiredString(value.ownerLocalTaskId, "ownerLocalTaskId"),
    title: requiredString(value.title, "title"),
    promptSnippet: optionalNullableString(value.promptSnippet),
    waitingPromptSnippet: optionalNullableString(value.waitingPromptSnippet),
    displayName: optionalNullableString(value.displayName),
    stage: requiredString(value.stage, "stage"),
    activity: optionalNullableString(value.activity),
    activityRevision: optionalNonNegativeInteger(value.activityRevision),
    status: optionalString(value.status),
    repo: {
      cloudRepoId: requiredString(value.repo.cloudRepoId, "repo.cloudRepoId"),
      name: requiredString(value.repo.name, "repo.name"),
      remoteUrlHash: optionalNullableString(value.repo.remoteUrlHash),
    },
    agent: parseCloudTaskAgent(value.agent),
    parentTaskId: optionalNullableString(value.parentTaskId),
    blockedByTaskIds: parseCloudTaskBlockerIds(value.blockedByTaskIds),
    singletonAgent: optionalNullableString(value.singletonAgent),
    pinned: optionalBoolean(value.pinned),
    pinOrder: optionalNullableNumber(value.pinOrder),
    createdAt,
    updatedAt,
    closedAt: value.closedAt === null
      ? null
      : normalizeCloudTimestamp(value.closedAt) ?? undefined,
  };
}

function parseCloudTaskBlockerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const id = optionalString(entry);
    return id ? [id] : [];
  });
}

function parseCloudTaskAgent(value: unknown): CloudTaskSnapshot["agent"] {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return {
    provider: optionalNullableString(value.provider),
    type: optionalNullableString(value.type),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`cloud task document ${field} must be a non-empty string`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null ? null : optionalString(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function optionalNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export function mapCloudTaskSnapshot(snapshot: CloudTaskSnapshot): CloudTaskSummary {
  // Repos with a remote URL hash display under the machine-independent
  // canonical repo id so the same repository on several desktops folds into
  // one entry; ownerLocalRepoId keeps the owner desktop's local id for routing.
  const repoId = snapshot.repo.remoteUrlHash
    ? canonicalRepoIdForHash(snapshot.repo.remoteUrlHash)
    : snapshot.repo.cloudRepoId;
  const ownerLocalRepoId =
    snapshot.localRepoId ??
    (repoId === snapshot.repo.cloudRepoId ? undefined : snapshot.repo.cloudRepoId);
  return {
    id: cloudTaskSummaryId(snapshot),
    repoId,
    repoName: snapshot.repo.name,
    title: snapshot.displayName ?? snapshot.title,
    prompt: snapshot.promptSnippet ?? undefined,
    stage: snapshot.stage,
    createdAt: snapshot.createdAt,
    waitingPromptSnippet: snapshot.waitingPromptSnippet ?? undefined,
    agentProvider: snapshot.agent?.provider ?? null,
    agentType: normalizeAgentType(snapshot.agent?.type),
    activity: normalizeTaskActivity(snapshot.activity),
    ...(snapshot.activityRevision === undefined
      ? {}
      : { activityRevision: snapshot.activityRevision }),
    parentTaskId: snapshot.parentTaskId ?? null,
    blockedByTaskIds: snapshot.blockedByTaskIds ?? [],
    // A document that never carried the field says nothing rather than saying
    // "not a singleton": absent stays absent so a later LAN read can fill it.
    ...(snapshot.singletonAgent === undefined
      ? {}
      : { singletonAgent: snapshot.singletonAgent }),
    pinned: snapshot.pinned ?? false,
    pinOrder: snapshot.pinOrder ?? null,
    ownerDesktopId: snapshot.ownerDesktopId,
    ...(ownerLocalRepoId ? { ownerLocalRepoId } : {}),
    ownerLocalTaskId: snapshot.ownerLocalTaskId,
    ownerOnline: false,
  };
}

function mapCloudDesktopRecord(
  docId: string,
  data: Record<string, unknown>
): CloudDesktopRecord {
  const desktopId =
    typeof data.desktopId === "string" && data.desktopId.trim()
      ? data.desktopId.trim()
      : docId;
  const displayName =
    typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : desktopId;

  const agentProviders = parseAgentProviderInventory(data.agentProviders);

  return {
    desktopId,
    displayName,
    updatedAt: normalizeCloudTimestamp(data.updatedAt),
    ...(agentProviders ? { agentProviders } : {})
  };
}

function normalizeCloudTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeCloudTimestampString(value);
  }
  if (value && typeof value === "object" && "toDate" in value) {
    const date = (value as { toDate?: () => unknown }).toDate?.();
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}

const cloudDateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const cloudSqliteTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
const cloudIsoTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function normalizeCloudTimestampString(value: string): string | null {
  const normalized = value.trim();
  const dateOnly = cloudDateOnlyPattern.exec(normalized);
  if (dateOnly) {
    return timestampPartsToIso({
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
    });
  }

  const sqlite = cloudSqliteTimestampPattern.exec(normalized);
  if (sqlite) {
    return timestampPartsToIso({
      year: Number(sqlite[1]),
      month: Number(sqlite[2]),
      day: Number(sqlite[3]),
      hour: Number(sqlite[4]),
      minute: Number(sqlite[5]),
      second: Number(sqlite[6]),
      millisecond: timestampFractionToMilliseconds(sqlite[7]),
    });
  }

  const iso = cloudIsoTimestampPattern.exec(normalized);
  if (!iso) return null;
  const offsetMinutes = iso[8] === "Z"
    ? 0
    : parseCloudTimestampOffset(iso[8]);
  if (offsetMinutes === null) return null;
  return timestampPartsToIso({
    year: Number(iso[1]),
    month: Number(iso[2]),
    day: Number(iso[3]),
    hour: Number(iso[4]),
    minute: Number(iso[5]),
    second: iso[6] ? Number(iso[6]) : 0,
    millisecond: timestampFractionToMilliseconds(iso[7]),
    offsetMinutes,
  });
}

function timestampFractionToMilliseconds(fraction: string | undefined): number {
  return fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
}

function parseCloudTimestampOffset(offset: string): number | null {
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  const absoluteMinutes = hours * 60 + minutes;
  return offset[0] === "+" ? absoluteMinutes : -absoluteMinutes;
}

function timestampPartsToIso(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
  offsetMinutes?: number;
}): string | null {
  const hour = parts.hour ?? 0;
  const minute = parts.minute ?? 0;
  const second = parts.second ?? 0;
  const millisecond = parts.millisecond ?? 0;
  const daysInMonth = [
    31,
    isLeapYear(parts.year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    parts.month < 1
    || parts.month > 12
    || parts.day < 1
    || parts.day > (daysInMonth[parts.month - 1] ?? 0)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }

  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(hour, minute, second, millisecond);
  const timestamp = date.getTime() - (parts.offsetMinutes ?? 0) * 60_000;
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function normalizeAgentType(type: string | null | undefined): TaskSummary["agentType"] {
  return type === "agent" || type === "pty" ? type : null;
}

function normalizeTaskActivity(activity: string | null | undefined): TaskActivity {
  return activity === "working" || activity === "unread" ? activity : "idle";
}

function cloudTaskSummaryId(snapshot: CloudTaskSnapshot): string {
  return snapshot.cloudTaskId
    ?? buildCloudTaskId({
        ownerDesktopId: snapshot.ownerDesktopId,
        localRepoId: snapshot.localRepoId ?? snapshot.repo.cloudRepoId,
        ownerLocalTaskId: snapshot.ownerLocalTaskId
      });
}

function stableTaskIdentity(task: { updatedAt: string }): string {
  const record = task as unknown as Record<string, unknown>;
  const id = optionalString(record.id);
  if (id) return id;
  const cloudId = optionalString(record.cloudTaskId);
  if (cloudId) return cloudId;
  const ownerDesktopId = optionalString(record.ownerDesktopId);
  const ownerLocalTaskId = optionalString(record.ownerLocalTaskId);
  const repo = isRecord(record.repo) ? record.repo : null;
  const repoId = optionalString(record.localRepoId)
    ?? optionalString(repo?.cloudRepoId);
  return ownerDesktopId && repoId && ownerLocalTaskId
    ? buildCloudTaskId({
        ownerDesktopId,
        localRepoId: repoId,
        ownerLocalTaskId
      })
    : "";
}

export function sortCloudTasks<T extends { updatedAt: string }>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    return byUpdatedAt !== 0
      ? byUpdatedAt
      : stableTaskIdentity(left).localeCompare(stableTaskIdentity(right));
  });
}
