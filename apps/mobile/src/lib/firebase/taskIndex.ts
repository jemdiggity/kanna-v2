import {
  collection,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import type { TaskSummary } from "../api/types";

export interface CloudTaskSnapshot {
  cloudTaskId?: string;
  localRepoId?: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  displayName: string | null;
  stage: string;
  status: string;
  repo: { cloudRepoId: string; name: string };
  agent?: { provider?: string | null; type?: string | null } | null;
  updatedAt: string;
  closedAt: string | null;
}

export interface CloudTaskSummary extends TaskSummary {
  repoName: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  ownerOnline: boolean;
}

export interface CloudTaskIndex {
  listRecentTasks(uid: string): Promise<CloudTaskSummary[]>;
  // Live subscription: pushes the user's open cloud tasks whenever any peer
  // desktop writes, via onSnapshot. Returns an unsubscribe.
  subscribeRecentTasks(
    uid: string,
    onUpdate: (tasks: CloudTaskSummary[]) => void,
  ): () => void;
}

export function createFirestoreTaskIndex(
  db: Firestore = getFirestore(),
): CloudTaskIndex {
  return {
    async listRecentTasks(uid) {
      const desktopsRef = collection(db, "users", uid, "desktops");
      const desktops = await getDocs(desktopsRef);
      const snapshots = await Promise.all(desktops.docs.map(async (desktopDoc) => {
        const tasksRef = collection(desktopDoc.ref, "tasks");
        const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
        return snapshot.docs.map((doc) => doc.data() as CloudTaskSnapshot);
      }));
      return sortCloudTasks(
        snapshots.flat(),
      ).map(mapCloudTaskSnapshot);
    },
    subscribeRecentTasks(uid, onUpdate) {
      let cancelled = false;
      const tasksByDesktop = new Map<string, CloudTaskSnapshot[]>();
      const taskUnsubs = new Map<string, () => void>();

      const emit = () => {
        if (cancelled) return;
        const all = [...tasksByDesktop.values()].flat();
        onUpdate(sortCloudTasks(all).map(mapCloudTaskSnapshot));
      };

      const desktopsUnsub = onSnapshot(
        collection(db, "users", uid, "desktops"),
        (desktopsSnapshot) => {
          const present = new Set<string>();
          for (const desktopDoc of desktopsSnapshot.docs) {
            present.add(desktopDoc.id);
            if (taskUnsubs.has(desktopDoc.id)) continue;
            const tasksQuery = query(
              collection(desktopDoc.ref, "tasks"),
              where("closedAt", "==", null),
            );
            taskUnsubs.set(
              desktopDoc.id,
              onSnapshot(tasksQuery, (tasksSnapshot) => {
                tasksByDesktop.set(
                  desktopDoc.id,
                  tasksSnapshot.docs.map((doc) => doc.data() as CloudTaskSnapshot),
                );
                emit();
              }),
            );
          }
          for (const [desktopId, unsub] of [...taskUnsubs]) {
            if (present.has(desktopId)) continue;
            unsub();
            taskUnsubs.delete(desktopId);
            tasksByDesktop.delete(desktopId);
          }
          emit();
        },
      );

      return () => {
        cancelled = true;
        desktopsUnsub();
        for (const unsub of taskUnsubs.values()) unsub();
        taskUnsubs.clear();
        tasksByDesktop.clear();
      };
    },
  };
}

export function mapCloudTaskSnapshot(snapshot: CloudTaskSnapshot): CloudTaskSummary {
  return {
    id: snapshot.cloudTaskId ?? cloudTaskId(`${snapshot.ownerDesktopId}:${snapshot.localRepoId ?? snapshot.repo.cloudRepoId}:${snapshot.ownerLocalTaskId}`),
    repoId: snapshot.repo.cloudRepoId,
    repoName: snapshot.repo.name,
    title: snapshot.displayName ?? snapshot.title,
    stage: snapshot.stage,
    snippet: snapshot.promptSnippet ?? undefined,
    agentProvider: snapshot.agent?.provider ?? null,
    agentType: normalizeAgentType(snapshot.agent?.type),
    ownerDesktopId: snapshot.ownerDesktopId,
    ownerLocalTaskId: snapshot.ownerLocalTaskId,
    ownerOnline: false,
  };
}

function normalizeAgentType(type: string | null | undefined): TaskSummary["agentType"] {
  return type === "agent" || type === "pty" ? type : null;
}

function cloudTaskId(id: string): string {
  return `cloud:${id}`;
}

export function sortCloudTasks<T extends { updatedAt: string }>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
