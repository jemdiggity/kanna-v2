import { getRepo, listBlockersForItem, type PipelineItem, type Repo } from "@kanna/db";
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
  }).publish(snapshot);
}

async function resolveDesktopId(): Promise<string> {
  const envId = await invoke<string>("read_env_var", { name: "KANNA_TRANSFER_PEER_ID" }).catch(() => "");
  if (envId.trim()) return envId.trim();

  const dbName = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" }).catch(() => "");
  return dbName.trim() || "desktop-local";
}
