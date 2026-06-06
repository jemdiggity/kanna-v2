import { getRepo, listBlockersForItem, listPipelineItems, listRepos, type PipelineItem, type Repo } from "@kanna/db";
import { invoke } from "../invoke";
import { buildCloudTaskSnapshot } from "../utils/cloudTaskSnapshot";
import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";
import { createCloudTaskPublisher } from "./cloudTaskPublisher";
import type { DbHandle } from "@kanna/db";

export async function publishDesktopTaskSnapshot(
  db: DbHandle,
  item: PipelineItem,
  repo: Repo | null = null,
): Promise<void> {
  const targetRepo = repo ?? await getRepo(db, item.repo_id);
  if (!targetRepo) return;

  const [authSession, config, desktopId, blockers, remoteUrl] = await Promise.all([
    getConfiguredDesktopAuthSession(),
    resolveDesktopFirebaseConfig({
      readEnv: (name) => invoke<string>("read_env_var", { name }),
      dev: import.meta.env.DEV,
    }),
    resolveDesktopId(),
    listBlockersForItem(db, item.id),
    invoke<string>("git_remote_url", { repoPath: targetRepo.path }).catch(() => null),
  ]);

  const snapshot = await buildCloudTaskSnapshot({
    desktopId,
    item,
    repo: { ...targetRepo, remote_url: remoteUrl },
    blockedByTaskIds: blockers.map((blocker) => blocker.id),
  });

  await createCloudTaskPublisher({
    endpoint: config.functionsEndpoint,
    getIdToken: (forceRefresh?: boolean) => authSession.getIdToken(forceRefresh),
    postJson: (endpoint, idToken, snapshot) =>
      invoke("post_cloud_task_snapshot", { endpoint, idToken, snapshot }),
  }).publish(snapshot);
}

export interface PublishDesktopTaskSnapshotsOptions {
  closedSinceDays?: number;
}

export async function publishDesktopTaskSnapshots(
  db: DbHandle,
  options: PublishDesktopTaskSnapshotsOptions = {},
): Promise<void> {
  const repos = await listRepos(db);
  const cutoff = options.closedSinceDays === undefined
    ? null
    : Date.now() - options.closedSinceDays * 24 * 60 * 60 * 1000;

  for (const repo of repos) {
    const items = await listPipelineItems(db, repo.id);
    for (const item of items) {
      if (!shouldPublishTaskSnapshot(item, cutoff)) continue;
      await publishDesktopTaskSnapshot(db, item, repo).catch((error) => {
        console.warn(
          `[cloud] failed to publish task snapshot for ${item.id}:`,
          error,
        );
      });
    }
  }
}

function shouldPublishTaskSnapshot(item: PipelineItem, closedCutoffMs: number | null): boolean {
  if (item.stage !== "done" && !item.closed_at) return true;
  if (closedCutoffMs === null) return true;
  if (!item.closed_at) return false;
  const closedAt = Date.parse(item.closed_at);
  return Number.isFinite(closedAt) && closedAt >= closedCutoffMs;
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
