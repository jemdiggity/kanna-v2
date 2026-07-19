import { join } from "node:path";

export const KANACHE_REPOSITORY = "https://github.com/jemdiggity/kanache";
export const KANACHE_REVISION = "6107c7b533a77a0c7c190b75c0284e7501c6edbf";
export const KANACHE_PROFILE = "dev";

export interface KanachePaths {
  revision: string;
  versionRoot: string;
  binary: string;
  events: string;
}

export interface WorktreeEntry {
  path: string;
  head: string;
}

export interface KanacheManifestSummary {
  profiles: string[];
  targets: string[];
  extraInputs: unknown[];
  createdUnixNanos: number;
}

export interface DonorCandidate extends WorktreeEntry {
  manifest: KanacheManifestSummary;
}

export function parseRustCacheMode(value: string | undefined): {
  enabled: boolean;
  warning?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "on" || normalized === "kanache") {
    return { enabled: true };
  }
  if (normalized === "off") return { enabled: false };
  return {
    enabled: false,
    warning: `Unknown KANNA_RUST_CACHE value ${JSON.stringify(value)}; cache disabled.`
  };
}

export function resolveKanachePaths(homeDir: string): KanachePaths {
  const versionRoot = join(
    homeDir,
    "Library",
    "Caches",
    "kanna",
    "tools",
    "kanache",
    KANACHE_REVISION
  );
  return {
    revision: KANACHE_REVISION,
    versionRoot,
    binary: join(versionRoot, "bin", "kanache"),
    events: join(homeDir, "Library", "Caches", "kanna", "kanache", "events.jsonl")
  };
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
  return output.split(/\n\n+/).flatMap((record) => {
    const lines = record.split("\n");
    if (lines.some((line) => line === "bare" || line.startsWith("prunable "))) return [];
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
    return path && head ? [{ path, head }] : [];
  });
}

export function parseKanacheManifest(raw: string): KanacheManifestSummary {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter((item): item is string => typeof item === "string")
    : [];
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((item): item is string => typeof item === "string")
    : [];
  const extraInputs = Array.isArray(value.extra_inputs) ? value.extra_inputs : [];

  if (profiles.length !== 1 || profiles[0] !== KANACHE_PROFILE) {
    throw new Error("Kanache donor must contain only profile dev.");
  }
  if (
    targets.length === 0 ||
    targets.some((target) => target !== "host" && !target.endsWith("-apple-darwin"))
  ) {
    throw new Error("Kanache donor has unsupported targets.");
  }
  if (extraInputs.length !== 0) {
    throw new Error("Kanache donor extra inputs are unsupported by the initial Kanna rollout.");
  }

  const created = Number(value.created_unix_nanos);
  if (!Number.isFinite(created)) {
    throw new Error("Kanache donor has no creation timestamp.");
  }

  return {
    profiles,
    targets: [...new Set(targets)].sort(),
    extraInputs,
    createdUnixNanos: created
  };
}

function coverage(candidate: DonorCandidate, hostTarget: string): number {
  const host = candidate.manifest.targets.includes("host");
  const explicit = candidate.manifest.targets.includes(hostTarget);
  return host && explicit ? 3 : host ? 2 : explicit ? 1 : 0;
}

export function rankDonors(
  candidates: DonorCandidate[],
  hostTarget: string
): DonorCandidate[] {
  return candidates
    .filter((candidate) => coverage(candidate, hostTarget) > 0)
    .sort(
      (left, right) =>
        coverage(right, hostTarget) - coverage(left, hostTarget) ||
        right.manifest.createdUnixNanos - left.manifest.createdUnixNanos
    );
}
