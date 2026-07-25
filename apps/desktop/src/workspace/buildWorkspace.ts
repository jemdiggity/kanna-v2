import type { PipelineItem } from "../types/kanna";
import type {
  BuildWorkspaceInput,
  BuildWorkspaceResult,
  LocalRepoWithRemote,
  RemoteTaskDiagnostics,
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
  const closedLocalKeys = buildClosedLocalKeys(
    input.localItems,
    input.localClosedItems ?? [],
    repoContext.localRepoKeyById,
  );
  const candidates = [
    ...input.localItems
      .filter((item) => !item.closed_at)
      .map((item) => localCandidate(item, repoContext.localRepoKeyById)),
    ...remoteCandidates(input.cloudSnapshot.items, input.cloudSnapshot.terminalRefs, "cloud", repoContext, closedLocalKeys),
    ...remoteCandidates(input.lanSnapshot.items, input.lanSnapshot.terminalRefs, "lan", repoContext, closedLocalKeys),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  const tasksByKey = new Map<string, WorkspaceTask>();
  for (const candidate of candidates) {
    const existing = tasksByKey.get(candidate.logicalKey);
    const next = existing
      ? mergeWorkspaceTask(existing, candidate)
      : createWorkspaceTask(candidate);
    tasksByKey.set(candidate.logicalKey, next);
  }

  const tasks = [...tasksByKey.values()].sort((a, b) =>
    b.item.created_at.localeCompare(a.item.created_at),
  );

  return {
    repos: repoContext.repos,
    tasks,
    diagnostics: tasks.map(diagnosticsForTask),
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
): Array<Candidate | null> {
  return items.map((item) => {
    if (item.closed_at) return null;
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
      logicalKey: localKey,
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

function buildClosedLocalKeys(
  items: PipelineItem[],
  closedItems: Array<Pick<PipelineItem, "id" | "repo_id">>,
  localRepoKeyById: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.closed_at) continue;
    const repoKey = localRepoKeyById.get(item.repo_id);
    if (repoKey) keys.add(`${repoKey}:owner-local:${item.id}`);
  }
  for (const item of closedItems) {
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
  const candidateRoute = terminalRouteFor(candidate);
  if (
    existing.localTaskId
    || routePrecedence(candidateRoute) <= routePrecedence(existing.terminal)
  ) {
    return {
      ...existing,
      remoteTaskIds,
      sources,
    };
  }

  return {
    ...existing,
    id: candidate.item.id,
    item: candidate.item,
    owner: {
      kind: "remote",
      id: candidate.source.terminalRef?.ownerDesktopId ?? "unknown",
    },
    remoteTaskIds,
    sources,
    terminal: candidateRoute,
    reachability: candidateRoute.kind === "none" ? "unknown" : "reachable",
    capabilities: capabilitiesFor(candidate),
  };
}

function routePrecedence(route: WorkspaceTerminalRoute): number {
  switch (route.kind) {
    case "local":
      return 3;
    case "lan":
      return 2;
    case "cloud":
      return 1;
    case "none":
      return 0;
  }
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
  return buildCapabilities({ isLocal, hasTerminal, isReachable });
}

function buildCapabilities(input: {
  isLocal: boolean;
  hasTerminal: boolean;
  isReachable: boolean;
}): WorkspaceCapabilities {
  return {
    canOpenTerminal: input.hasTerminal,
    canSendInput: input.hasTerminal,
    canResizeTerminal: input.hasTerminal,
    canClose: input.isReachable,
    canCreateSiblingTask: true,
    canPushToMachine: input.isLocal,
    canPullFromMachine: !input.isLocal,
    canOpenDiff: input.isLocal,
    canOpenInIde: input.isLocal,
    canOpenShell: input.isLocal,
    canAdvanceStage: input.isReachable,
    canEditMetadata: input.isReachable,
  };
}

function diagnosticsForTask(task: WorkspaceTask): RemoteTaskDiagnostics {
  const selectedRef = task.terminal.kind === "cloud" || task.terminal.kind === "lan"
    ? task.terminal.remoteRef
    : undefined;
  const cloudSource = task.sources.find((source) => source.kind === "cloud");
  const lanSource = task.sources.find((source) => source.kind === "lan");
  const sources = task.sources
    .map((source) => source.kind)
    .filter((kind, index, all) => all.indexOf(kind) === index);

  return {
    itemId: task.item.id,
    prompt: task.item.prompt ?? "",
    repoId: task.repoKey,
    sources,
    selectedTerminalTransport: task.terminal.kind,
    ownerDesktopId: selectedRef?.ownerDesktopId,
    ownerLocalTaskId: selectedRef?.ownerLocalTaskId,
    cloudUpdatedAt: cloudSource?.updatedAt,
    lanUpdatedAt: lanSource?.updatedAt,
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
