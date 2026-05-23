import type { PipelineItem } from "@kanna/db";
import type {
  BuildWorkspaceInput,
  BuildWorkspaceResult,
  LocalRepoWithRemote,
  RemoteRepo,
  WorkspaceCapabilities,
  WorkspaceRepo,
  WorkspaceTask,
  WorkspaceTaskSource,
  WorkspaceTerminalRoute,
} from "./types";

interface Candidate {
  item: PipelineItem;
  source: WorkspaceTaskSource;
  repoKey: string;
  logicalKey: string;
}

export function buildWorkspace(input: BuildWorkspaceInput): BuildWorkspaceResult {
  const repoContext = buildRepoContext(input.localRepos, [
    ...input.cloudSnapshot.repos,
    ...input.lanSnapshot.repos,
  ]);
  const closedLocalKeys = buildClosedLocalKeys(input.localItems, repoContext.localRepoKeyById);
  const openLocalKeys = buildOpenLocalKeys(input.localItems, repoContext.localRepoKeyById);
  const candidates = [
    ...input.localItems
      .filter((item) => item.stage !== "done" && !item.closed_at)
      .map((item) => localCandidate(item, repoContext.localRepoKeyById)),
    ...remoteCandidates(input.cloudSnapshot.items, input.cloudSnapshot.terminalRefs, "cloud", repoContext, closedLocalKeys, openLocalKeys),
    ...remoteCandidates(input.lanSnapshot.items, input.lanSnapshot.terminalRefs, "lan", repoContext, closedLocalKeys, openLocalKeys),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  const tasksByKey = new Map<string, WorkspaceTask>();
  for (const candidate of candidates) {
    const existing = tasksByKey.get(candidate.logicalKey);
    const next = existing
      ? mergeWorkspaceTask(existing, candidate)
      : createWorkspaceTask(candidate);
    tasksByKey.set(candidate.logicalKey, next);
  }

  return {
    repos: repoContext.repos,
    tasks: [...tasksByKey.values()].sort((a, b) =>
      b.item.created_at.localeCompare(a.item.created_at),
    ),
  };
}

function buildRepoContext(localRepos: LocalRepoWithRemote[], remoteRepos: RemoteRepo[]) {
  const reposByKey = new Map<string, WorkspaceRepo>();
  const localRepoKeyById = new Map<string, string>();
  const localRepoKeyByRemoteHash = new Map<string, string>();
  const remoteRepoKeyById = new Map<string, string>();

  for (const entry of localRepos) {
    const key = entry.repo.id;
    localRepoKeyById.set(entry.repo.id, key);
    if (entry.remoteUrlHash) localRepoKeyByRemoteHash.set(entry.remoteUrlHash, key);
    reposByKey.set(key, {
      key,
      localRepoId: entry.repo.id,
      remoteRepoIds: [],
      name: entry.repo.name,
      path: entry.repo.path,
      remoteUrl: entry.remoteUrl ?? null,
      remoteUrlHash: entry.remoteUrlHash,
      defaultBranch: entry.repo.default_branch,
      source: "local-only",
    });
  }

  for (const repo of remoteRepos) {
    const remoteUrlHash = readRemoteUrlHash(repo);
    const matchedLocalKey = remoteUrlHash ? localRepoKeyByRemoteHash.get(remoteUrlHash) : undefined;
    const key = matchedLocalKey ?? repo.id;
    remoteRepoKeyById.set(repo.id, key);
    const existing = reposByKey.get(key);
    if (existing) {
      if (!existing.remoteRepoIds.includes(repo.id)) existing.remoteRepoIds.push(repo.id);
      existing.source = existing.localRepoId ? "mixed" : "remote-only";
      existing.remoteUrl ??= repo.remote_url ?? null;
      existing.remoteUrlHash ??= remoteUrlHash;
      continue;
    }
    reposByKey.set(key, {
      key,
      localRepoId: null,
      remoteRepoIds: [repo.id],
      name: repo.name,
      path: null,
      remoteUrl: repo.remote_url ?? null,
      remoteUrlHash,
      defaultBranch: repo.default_branch,
      source: "remote-only",
    });
  }

  return {
    repos: [...reposByKey.values()],
    localRepoKeyById,
    remoteRepoKeyById,
  };
}

function localCandidate(
  item: PipelineItem,
  localRepoKeyById: Map<string, string>,
): Candidate | null {
  const repoKey = localRepoKeyById.get(item.repo_id);
  if (!repoKey) return null;
  const logicalKey = `${repoKey}:owner-local:${item.id}`;
  return {
    item,
    repoKey,
    logicalKey,
    source: {
      kind: "local",
      taskId: item.id,
      repoId: item.repo_id,
      updatedAt: item.updated_at,
    },
  };
}

function remoteCandidates(
  items: PipelineItem[],
  terminalRefs: BuildWorkspaceInput["cloudSnapshot"]["terminalRefs"],
  kind: "cloud" | "lan",
  repoContext: ReturnType<typeof buildRepoContext>,
  closedLocalKeys: Set<string>,
  openLocalKeys: Set<string>,
): Array<Candidate | null> {
  return items.map((item) => {
    if (item.stage === "done" || item.closed_at) return null;
    const repoKey = repoContext.remoteRepoKeyById.get(item.repo_id)
      ?? repoContext.localRepoKeyById.get(item.repo_id)
      ?? item.repo_id;
    const terminalRef = terminalRefs[item.id];
    const ownerLocalTaskId = terminalRef?.ownerLocalTaskId ?? stripRemoteTaskPrefix(item.id);
    const closedKey = `${repoKey}:owner-local:${ownerLocalTaskId}`;
    if (closedLocalKeys.has(closedKey)) return null;
    const localKey = `${repoKey}:owner-local:${ownerLocalTaskId}`;
    return {
      item,
      repoKey,
      logicalKey: openLocalKeys.has(localKey)
        ? localKey
        : `${repoKey}:owner:${terminalRef?.ownerDesktopId ?? "unknown"}:${ownerLocalTaskId}`,
      source: {
        kind,
        taskId: item.id,
        repoId: item.repo_id,
        updatedAt: item.updated_at,
        terminalRef,
      },
    };
  });
}

function buildOpenLocalKeys(
  items: PipelineItem[],
  localRepoKeyById: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.stage === "done" || item.closed_at) continue;
    const repoKey = localRepoKeyById.get(item.repo_id);
    if (repoKey) keys.add(`${repoKey}:owner-local:${item.id}`);
  }
  return keys;
}

function buildClosedLocalKeys(
  items: PipelineItem[],
  localRepoKeyById: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.stage !== "done" && !item.closed_at) continue;
    const repoKey = localRepoKeyById.get(item.repo_id);
    if (repoKey) keys.add(`${repoKey}:owner-local:${item.id}`);
  }
  return keys;
}

function createWorkspaceTask(candidate: Candidate): WorkspaceTask {
  const isLocal = candidate.source.kind === "local";
  const remoteRef = candidate.source.terminalRef;
  return {
    id: isLocal ? `local:${candidate.item.id}` : candidate.item.id,
    logicalTaskKey: candidate.logicalKey,
    localTaskId: isLocal ? candidate.item.id : null,
    remoteTaskIds: isLocal ? [] : [candidate.item.id],
    repoKey: candidate.repoKey,
    item: candidate.item,
    owner: isLocal
      ? { kind: "local", id: "local" }
      : { kind: "remote", id: remoteRef?.ownerDesktopId ?? "unknown" },
    sources: [candidate.source],
    reachability: isLocal ? "local" : remoteRef ? "reachable" : "unknown",
    capabilities: capabilitiesFor(candidate),
    terminal: terminalRouteFor(candidate),
  };
}

function mergeWorkspaceTask(existing: WorkspaceTask, candidate: Candidate): WorkspaceTask {
  const sources = [...existing.sources, candidate.source];
  if (candidate.source.kind === "local") {
    return {
      ...existing,
      id: `local:${candidate.item.id}`,
      localTaskId: candidate.item.id,
      item: candidate.item,
      owner: { kind: "local", id: "local" },
      sources,
      reachability: "local",
      capabilities: capabilitiesFor(candidate),
      terminal: { kind: "local", localSessionId: candidate.item.id },
    };
  }

  const remoteTaskIds = existing.remoteTaskIds.includes(candidate.item.id)
    ? existing.remoteTaskIds
    : [...existing.remoteTaskIds, candidate.item.id];
  const bestRoute = chooseBestRoute([...sources]);
  return {
    ...existing,
    remoteTaskIds,
    sources,
    terminal: bestRoute,
    reachability: existing.reachability === "local" ? "local" : bestRoute.kind === "none" ? "unknown" : "reachable",
    capabilities: existing.localTaskId
      ? existing.capabilities
      : capabilitiesFor(candidate),
  };
}

function chooseBestRoute(sources: WorkspaceTaskSource[]): WorkspaceTerminalRoute {
  const local = sources.find((source) => source.kind === "local");
  if (local) return { kind: "local", localSessionId: local.taskId };
  const lan = sources.find((source) => source.kind === "lan" && source.terminalRef);
  if (lan?.terminalRef) return { kind: "lan", remoteRef: lan.terminalRef };
  const cloud = sources.find((source) => source.kind === "cloud" && source.terminalRef);
  if (cloud?.terminalRef) return { kind: "cloud", remoteRef: cloud.terminalRef };
  return { kind: "none" };
}

function terminalRouteFor(candidate: Candidate): WorkspaceTerminalRoute {
  if (candidate.source.kind === "local") {
    return { kind: "local", localSessionId: candidate.item.id };
  }
  if (candidate.source.terminalRef) {
    return {
      kind: candidate.source.kind,
      remoteRef: candidate.source.terminalRef,
    };
  }
  return { kind: "none" };
}

function capabilitiesFor(candidate: Candidate): WorkspaceCapabilities {
  const isLocal = candidate.source.kind === "local";
  const hasTerminal = isLocal || Boolean(candidate.source.terminalRef);
  const isReachable = isLocal || Boolean(candidate.source.terminalRef);
  return {
    canOpenTerminal: hasTerminal,
    canSendInput: hasTerminal,
    canResizeTerminal: hasTerminal,
    canClose: isReachable,
    canCreateSiblingTask: true,
    canPushToMachine: isLocal,
    canPullFromMachine: !isLocal,
    canOpenDiff: isLocal,
    canOpenInIde: isLocal,
    canOpenShell: isLocal,
    canAdvanceStage: isLocal,
    canEditMetadata: isReachable,
  };
}

function readRemoteUrlHash(repo: RemoteRepo): string | null {
  const candidate = repo as RemoteRepo & { remoteUrlHash?: string | null };
  return candidate.remoteUrlHash ?? null;
}

function stripRemoteTaskPrefix(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] || id;
}
