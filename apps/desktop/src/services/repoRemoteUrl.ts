import type { Repo } from "../types/kanna";

import { invoke } from "../invoke";
import { hashRemoteUrl } from "../utils/cloudTaskSnapshot";
import { patchDesktopRepo } from "./desktopServerClient";

const REMOTE_URL_CACHE_TTL_MS = 5 * 60 * 1000;

interface RemoteUrlCacheEntry {
  path: string;
  remoteUrl: string | null;
  remoteUrlHash: string | null;
  loadedAt: number;
}

const remoteUrlCache = new Map<string, RemoteUrlCacheEntry>();
const pendingRemoteUrlLoads = new Map<string, Promise<RepoRemoteMetadata>>();

export interface RepoRemoteMetadata {
  remoteUrl: string | null;
  remoteUrlHash: string | null;
}

export async function getCachedRepoRemoteMetadata(
  repo: Pick<Repo, "id" | "path" | "remote_url" | "remote_url_hash">,
): Promise<RepoRemoteMetadata> {
  const now = Date.now();
  const cached = remoteUrlCache.get(repo.id);
  if (cached && cached.path === repo.path && now - cached.loadedAt < REMOTE_URL_CACHE_TTL_MS) {
    return {
      remoteUrl: cached.remoteUrl,
      remoteUrlHash: cached.remoteUrlHash,
    };
  }

  if (repo.remote_url && repo.remote_url_hash) {
    const metadata = {
      remoteUrl: repo.remote_url,
      remoteUrlHash: repo.remote_url_hash,
    };
    remoteUrlCache.set(repo.id, {
      path: repo.path,
      ...metadata,
      loadedAt: now,
    });
    return metadata;
  }

  const pending = pendingRemoteUrlLoads.get(repo.id);
  if (pending) return pending;

  const load = refreshRepoRemoteMetadata(repo)
    .finally(() => {
      pendingRemoteUrlLoads.delete(repo.id);
    });

  pendingRemoteUrlLoads.set(repo.id, load);
  return load;
}

export async function getCachedRepoRemoteUrl(
  repo: Pick<Repo, "id" | "path" | "remote_url" | "remote_url_hash">,
): Promise<string | null> {
  return (await getCachedRepoRemoteMetadata(repo)).remoteUrl;
}

export async function refreshRepoRemoteMetadata(
  repo: Pick<Repo, "id" | "path">,
): Promise<RepoRemoteMetadata> {
  const remoteUrl = await invoke<string>("git_remote_url", { repoPath: repo.path })
    .catch(() => null);
  const remoteUrlHash = await hashRemoteUrl(remoteUrl);
  remoteUrlCache.set(repo.id, {
    path: repo.path,
    remoteUrl,
    remoteUrlHash,
    loadedAt: Date.now(),
  });
  await patchDesktopRepo(repo.id, {
    remoteUrl,
    remoteUrlHash,
  }).catch((error) => {
    console.warn("[repoRemoteUrl] failed to persist repo remote metadata:", error);
  });
  return {
    remoteUrl,
    remoteUrlHash,
  };
}

export function __resetRepoRemoteUrlCacheForTests(): void {
  remoteUrlCache.clear();
  pendingRemoteUrlLoads.clear();
}
