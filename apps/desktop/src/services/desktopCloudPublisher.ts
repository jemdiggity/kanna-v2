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
import { createCloudTaskPublisher, type CloudTaskPublisher } from "./cloudTaskPublisher";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";

export interface RemoteTaskSnapshotIdentity {
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
}

export interface PublishDesktopTaskSnapshotsOptions {
  closedSinceDays?: number;
}

interface CloudWriteContext {
  desktopId: string;
  publisher: CloudTaskPublisher;
}

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
    await context.publisher.publish({ action: "delete", identity });
    return;
  }

  const snapshot = await buildSnapshot(db, item, targetRepo, context.desktopId);
  await context.publisher.publish({ action: "upsert", snapshot });
}

export async function deleteRemoteTaskSnapshots(identity: RemoteTaskSnapshotIdentity): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;
  await context.publisher.publish({ action: "delete", identity });
}

export async function reconcileDesktopTaskSnapshots(db: DbHandle): Promise<void> {
  const context = await getCloudWriteContext();
  if (!context) return;

  const snapshots: unknown[] = [];
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

  await context.publisher.publish({
    action: "reconcile",
    ownerDesktopId: context.desktopId,
    snapshots,
  });
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
): Promise<unknown> {
  const [blockers, remoteUrl] = await Promise.all([
    listBlockersForItem(db, item.id),
    invoke<string>("git_remote_url", { repoPath: repo.path }).catch(() => null),
  ]);

  return buildCloudTaskSnapshot({
    desktopId,
    item,
    repo: { ...repo, remote_url: remoteUrl },
    blockedByTaskIds: blockers.map((blocker) => blocker.id),
  });
}

async function getCloudWriteContext(): Promise<CloudWriteContext | null> {
  const [authSession, config, desktopId] = await Promise.all([
    getConfiguredDesktopAuthSession(),
    resolveDesktopFirebaseConfig({
      readEnv: (name) => invoke<string>("read_env_var", { name }),
      dev: import.meta.env.DEV,
    }),
    resolveDesktopId(),
  ]);
  const state = authSession.getState();
  if (state.status !== "signedIn") return null;

  return {
    desktopId,
    publisher: createCloudTaskPublisher({
      endpoint: config.functionsEndpoint,
      getIdToken: (forceRefresh?: boolean) => authSession.getIdToken(forceRefresh),
      postJson: (endpoint, idToken, snapshot) =>
        invoke("post_cloud_task_snapshot", { endpoint, idToken, snapshot }),
    }),
  };
}

async function resolveDesktopId(): Promise<string> {
  const mobileStatus = await invoke<{ desktopId?: string }>("mobile_server_status").catch(() => null);
  if (mobileStatus?.desktopId?.trim()) return mobileStatus.desktopId.trim();

  const envId = await readEnvString("KANNA_TRANSFER_PEER_ID");
  if (envId.trim()) return envId.trim();

  return "desktop-local";
}

async function readEnvString(name: string): Promise<string> {
  const value = await invoke<unknown>("read_env_var", { name }).catch(() => "");
  return typeof value === "string" ? value : "";
}
