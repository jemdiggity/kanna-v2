import type { BlockerTaskStates, DbHandle, Repo, TaskBlocker } from "../types/kanna";
import { invoke } from "../invoke";
import { isBlockerResolved } from "../utils/blockerResolution";
import { buildCloudTaskSnapshot } from "../utils/cloudTaskSnapshot";
import { mapDesktopCloudTasks, type DesktopCloudSnapshot, type DesktopCloudTaskSnapshot } from "./desktopCloudTaskIndex";
import { fetchDesktopSnapshot } from "./desktopServerClient";
import { getCachedRepoRemoteUrl } from "./repoRemoteUrl";

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

export async function publishDesktopLanTaskSnapshot(db?: DbHandle | null): Promise<void> {
  void db;
  const [desktopId, snapshot] = await Promise.all([
    resolveLanDesktopId(),
    fetchDesktopSnapshot(),
  ]);
  const tasks: DesktopCloudTaskSnapshot[] = [];

  for (const { repo, items } of snapshot.entries) {
    const remoteUrl = await getCachedRepoRemoteUrl(repo);
    for (const item of items.filter((candidate) => !candidate.closed_at)) {
      tasks.push(await buildCloudTaskSnapshot({
        desktopId,
        item,
        repo: { ...repo, remote_url: remoteUrl },
        blockedByTaskIds: blockedByTaskIds(
          snapshot.taskBlockers,
          snapshot.blockerTaskStates ?? {},
          item.id,
        ),
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

function blockedByTaskIds(
  blockers: TaskBlocker[],
  blockerTaskStates: BlockerTaskStates,
  itemId: string,
): string[] {
  return blockers
    .filter((blocker) => {
      if (blocker.blocked_item_id !== itemId) return false;
      const blockerState = blockerTaskStates[blocker.blocker_item_id];
      return !blockerState || !isBlockerResolved(blockerState);
    })
    .map((blocker) => blocker.blocker_item_id);
}

export async function listDesktopLanTasks(options: {
  localRepos?: Array<{ repo: Repo; remoteUrlHash: string | null }>;
  localClosedItems?: Array<{ id: string; repo_id: string }>;
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
