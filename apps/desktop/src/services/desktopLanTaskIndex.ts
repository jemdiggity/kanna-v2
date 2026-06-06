import { listBlockersForItem, listPipelineItems, listRepos, type DbHandle, type Repo } from "@kanna/db";
import { invoke } from "../invoke";
import { buildCloudTaskSnapshot } from "../utils/cloudTaskSnapshot";
import { mapDesktopCloudTasks, type DesktopCloudSnapshot, type DesktopCloudTaskSnapshot } from "./desktopCloudTaskIndex";

interface PeerTaskSnapshotEnvelope {
  peer_id?: string;
  peerId?: string;
  display_name?: string;
  displayName?: string;
  snapshot?: unknown;
}

interface LanTaskSnapshotPayload {
  tasks?: DesktopCloudTaskSnapshot[];
}

export async function publishDesktopLanTaskSnapshot(db: DbHandle): Promise<void> {
  const [desktopId, repos] = await Promise.all([
    resolveLanDesktopId(),
    listRepos(db),
  ]);
  const tasks: DesktopCloudTaskSnapshot[] = [];

  for (const repo of repos) {
    const [items, remoteUrl] = await Promise.all([
      listPipelineItems(db, repo.id),
      invoke<string>("git_remote_url", { repoPath: repo.path }).catch(() => null),
    ]);
    for (const item of items.filter((candidate) => !candidate.closed_at && candidate.stage !== "done")) {
      const blockers = await listBlockersForItem(db, item.id);
      tasks.push(await buildCloudTaskSnapshot({
        desktopId,
        item,
        repo: { ...repo, remote_url: remoteUrl },
        blockedByTaskIds: blockers.map((blocker) => blocker.id),
      }));
    }
  }

  await invoke("set_transfer_task_snapshot", {
    snapshot: {
      schemaVersion: 1,
      tasks,
      publishedAt: new Date().toISOString(),
    },
  }).catch((error) => {
    console.warn("[lan] failed to publish task snapshot:", error);
  });
}

export async function listDesktopLanTasks(options: {
  localRepos?: Array<{ repo: Repo; remoteUrlHash: string | null }>;
  currentDesktopId?: string | null;
} = {}): Promise<DesktopCloudSnapshot> {
  const [raw, currentDesktopId] = await Promise.all([
    invoke<unknown>("list_transfer_task_snapshots").catch(() => []),
    options.currentDesktopId === undefined
      ? resolveLanDesktopId()
      : Promise.resolve(options.currentDesktopId),
  ]);
  const snapshots = Array.isArray(raw) ? raw : [];
  const tasks: DesktopCloudTaskSnapshot[] = [];

  for (const entry of snapshots) {
    const envelope = entry as PeerTaskSnapshotEnvelope;
    const peerId = envelope.peer_id ?? envelope.peerId;
    const payload = envelope.snapshot as LanTaskSnapshotPayload | undefined;
    if (!peerId || !Array.isArray(payload?.tasks)) continue;
    for (const task of payload.tasks) {
      tasks.push({
        ...task,
        cloudTaskId: `lan:${peerId}:${task.cloudTaskId}`,
        ownerDesktopId: peerId,
      });
    }
  }

  const mapped = mapDesktopCloudTasks(tasks, { ...options, currentDesktopId });
  for (const ref of Object.values(mapped.terminalRefs)) {
    ref.transport = "lan";
  }
  return mapped;
}

async function resolveLanDesktopId(): Promise<string> {
  const envId = await invoke<string>("read_env_var", { name: "KANNA_TRANSFER_PEER_ID" }).catch(() => "");
  if (envId.trim()) return envId.trim();

  const mobileStatus = await invoke<{ desktopId?: string }>("mobile_server_status").catch(() => null);
  if (mobileStatus?.desktopId?.trim()) return mobileStatus.desktopId.trim();

  return "peer-local";
}
