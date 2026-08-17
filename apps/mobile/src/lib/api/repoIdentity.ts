import type { RepoSummary } from "./types";

/**
 * Repo ids are desktop-local (each machine mints its own `repo-…` id), so the
 * same git repository registered on two machines arrives under two different
 * ids. When a repo carries a remote URL hash, mobile displays it under the
 * machine-independent canonical id `git:<remoteUrlHash>` and keeps the
 * desktop-local ids for routing (owner maps, `ownerLocalRepoId`).
 */
const REMOTE_REPO_ID_PREFIX = "git:";

export function canonicalRepoIdForHash(remoteUrlHash: string): string {
  return `${REMOTE_REPO_ID_PREFIX}${remoteUrlHash}`;
}

/** Whether a repo id is machine-independent (`git:<hash>`) rather than a
 * desktop-local id, and therefore needs per-desktop member resolution. */
export function isRemoteRepoId(repoId: string): boolean {
  return repoId.startsWith(REMOTE_REPO_ID_PREFIX);
}

export function canonicalRepoId(repo: {
  id: string;
  remoteUrlHash?: string | null;
}): string {
  return repo.remoteUrlHash
    ? canonicalRepoIdForHash(repo.remoteUrlHash)
    : repo.id;
}

export function repoIsRegisteredOnDesktop(
  repo: RepoSummary,
  desktopId: string
): boolean {
  return repo.registeredDesktopIds?.includes(desktopId) ?? true;
}

/**
 * Merges repo summaries from several sources (task-derived, per-desktop repo
 * lists, LAN snapshots) into one entry per logical repository.
 *
 * Entries sharing a remote URL hash collapse into a single canonical entry.
 * Hash-less entries whose id is a known member of a hashed group (a
 * desktop-local id seen elsewhere with a hash) collapse into that group too.
 * The first entry of a group in input order wins its name and position, so
 * caller source precedence is preserved.
 */
export function mergeRepoSummaries(repos: RepoSummary[]): RepoSummary[] {
  const canonicalIdByMemberId = new Map<string, string>();
  for (const repo of repos) {
    if (repo.remoteUrlHash) {
      canonicalIdByMemberId.set(repo.id, canonicalRepoId(repo));
    }
  }

  const merged = new Map<string, RepoSummary>();
  for (const repo of repos) {
    const id = repo.remoteUrlHash
      ? canonicalRepoId(repo)
      : canonicalIdByMemberId.get(repo.id) ?? repo.id;
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, {
        id,
        name: repo.name,
        ...(repo.remoteUrlHash ? { remoteUrlHash: repo.remoteUrlHash } : {}),
        ...(repo.registeredDesktopIds
          ? { registeredDesktopIds: [...new Set(repo.registeredDesktopIds)] }
          : {})
      });
      continue;
    }
    if (!existing.remoteUrlHash && repo.remoteUrlHash) {
      existing.remoteUrlHash = repo.remoteUrlHash;
    }
    if (repo.registeredDesktopIds) {
      existing.registeredDesktopIds = [
        ...new Set([
          ...(existing.registeredDesktopIds ?? []),
          ...repo.registeredDesktopIds
        ])
      ];
    }
  }
  return Array.from(merged.values());
}
