import {
  collection,
  connectFirestoreEmulator,
  getDocs,
  getFirestore,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase/app";
import type { PipelineItem, Repo } from "@kanna/db";
import { invoke } from "../invoke";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";

export interface DesktopCloudTaskSnapshot {
  cloudTaskId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  displayName: string | null;
  stage: string;
  activity?: string;
  status: string;
  repo: {
    cloudRepoId: string;
    name: string;
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
  closedAt: string | null;
}

export interface DesktopCloudSnapshot {
  repos: Repo[];
  items: PipelineItem[];
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
): Promise<DesktopCloudSnapshot> {
  const firestore = db === undefined ? await getConfiguredDesktopFirestore() : db;
  if (!firestore) return { repos: [], items: [] };

  const tasksRef = collection(firestore, "users", uid, "tasks");
  const snapshot = await getDocs(query(tasksRef, where("closedAt", "==", null)));
  return mapDesktopCloudTasks(
    snapshot.docs.map((doc) => doc.data() as DesktopCloudTaskSnapshot),
  );
}

export function mapDesktopCloudTasks(
  snapshots: DesktopCloudTaskSnapshot[],
): DesktopCloudSnapshot {
  const reposById = new Map<string, Repo>();
  const items: PipelineItem[] = [];

  for (const snapshot of sortByUpdatedAt(snapshots)) {
    const repoId = cloudRepoId(snapshot.repo.cloudRepoId);
    if (!reposById.has(repoId)) {
      reposById.set(repoId, {
        id: repoId,
        path: "cloud",
        name: snapshot.repo.name,
        default_branch: snapshot.repo.defaultBranch ?? "main",
        hidden: 0,
        sort_order: 0,
        created_at: snapshot.createdAt,
        last_opened_at: snapshot.updatedAt,
      });
    }

    items.push({
      id: cloudTaskId(snapshot.cloudTaskId),
      repo_id: repoId,
      prompt: snapshot.promptSnippet ?? snapshot.title,
      pipeline: "cloud",
      stage: snapshot.stage,
      tags: JSON.stringify([snapshot.stage]),
      pr_number: snapshot.prNumber,
      pr_url: snapshot.prUrl,
      branch: snapshot.branch,
      activity: normalizeActivity(snapshot.activity),
      activity_changed_at: snapshot.updatedAt,
      unread_at: null,
      port_offset: null,
      port_env: null,
      pinned: 0,
      pin_order: null,
      display_name: snapshot.displayName ?? `${snapshot.title} (${snapshot.ownerDesktopId})`,
      issue_number: null,
      issue_title: null,
      closed_at: snapshot.closedAt,
      agent_session_id: null,
      base_ref: snapshot.baseRef,
      agent_provider: normalizeAgentProvider(snapshot.agent?.provider),
      agent_type: snapshot.agent?.type ?? "pty",
      previous_stage: null,
      stage_result: null,
      teardown_started_at: null,
      last_output_preview: null,
      active_post_action: null,
      created_at: snapshot.createdAt,
      updated_at: snapshot.updatedAt,
    });
  }

  return {
    repos: [...reposById.values()],
    items,
  };
}

function sortByUpdatedAt<T extends { updatedAt: string }>(snapshots: T[]): T[] {
  return [...snapshots].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function cloudRepoId(id: string): string {
  return `cloud:${id}`;
}

function cloudTaskId(id: string): string {
  return `cloud:${id}`;
}

function normalizeActivity(activity: string | undefined): PipelineItem["activity"] {
  return activity === "working" || activity === "unread" ? activity : "idle";
}

function normalizeAgentProvider(provider: string | null | undefined): PipelineItem["agent_provider"] {
  return provider === "copilot" || provider === "codex" ? provider : "claude";
}
