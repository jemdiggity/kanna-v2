import {
  collection,
  getDocs,
  getFirestore,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import type { TaskSummary } from "../api/types";

export interface CloudTaskSnapshot {
  cloudTaskId: string;
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
}

export function createFirestoreTaskIndex(
  db: Firestore = getFirestore(),
): CloudTaskIndex {
  return {
    async listRecentTasks(uid) {
      const tasksRef = collection(db, "users", uid, "tasks");
      const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
      return sortCloudTasks(
        snapshot.docs.map((doc) => doc.data() as CloudTaskSnapshot),
      ).map(mapCloudTaskSnapshot);
    },
  };
}

export function mapCloudTaskSnapshot(snapshot: CloudTaskSnapshot): CloudTaskSummary {
  return {
    id: snapshot.cloudTaskId,
    repoId: snapshot.repo.cloudRepoId,
    repoName: snapshot.repo.name,
    title: snapshot.displayName ?? snapshot.title,
    stage: snapshot.stage,
    snippet: snapshot.promptSnippet ?? undefined,
    agentProvider: snapshot.agent?.provider ?? null,
    ownerDesktopId: snapshot.ownerDesktopId,
    ownerLocalTaskId: snapshot.ownerLocalTaskId,
    ownerOnline: false,
  };
}

export function sortCloudTasks<T extends { updatedAt: string }>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
