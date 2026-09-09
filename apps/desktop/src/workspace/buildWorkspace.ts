import type { PipelineItem } from "../types/kanna";
import type { RemoteTaskPin } from "../services/remoteTaskPins";
import { DEFAULT_SINGLETON_PIN_ORDER, isDefaultPinnedTask } from "../utils/singletonTask";
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
  sources?: WorkspaceTaskSource[];
  repoKey: string;
  logicalKey: string;
}

const LOGICAL_OWNER_TASK_MARKER = ":owner-local:";

/**
 * The owner-side durable task id embedded in a workspace task's logical key.
 * This is the stable identity for viewer-local per-task state (e.g. remote
 * task pins) — unlike `item.id`, it does not change with the selected
 * transport route.
 */
export function workspaceTaskOwnerTaskId(
  task: Pick<WorkspaceTask, "logicalTaskKey">,
): string | null {
  const markerIndex = task.logicalTaskKey.indexOf(LOGICAL_OWNER_TASK_MARKER);
  if (markerIndex < 0) return null;
  const ownerTaskId = task.logicalTaskKey.slice(markerIndex + LOGICAL_OWNER_TASK_MARKER.length);
  return ownerTaskId || null;
}

export function buildWorkspace(input: BuildWorkspaceInput): BuildWorkspaceResult {
  const repoContext = buildRepoContext(input.localRepos, [
    ...input.cloudSnapshot.repos,
    ...input.lanSnapshot.repos,
  ], input.repoSidebarOrder);
  const closedLocalKeys = buildClosedLocalKeys(
    input.localItems,
    input.localClosedItems ?? [],
    repoContext.localRepoKeyById,
  );
  const localCandidates = input.localItems
    .filter((item) => !item.closed_at)
    .map((item) => localCandidate(item, repoContext.localRepoKeyById))
    .filter((candidate): candidate is Candidate => candidate !== null);
  const remote = [
    ...remoteCandidates(input.cloudSnapshot, "cloud", repoContext, closedLocalKeys, input.remoteTaskPins),
    ...remoteCandidates(input.lanSnapshot, "lan", repoContext, closedLocalKeys, input.remoteTaskPins),
  ].filter((candidate): candidate is Candidate => candidate !== null);
  const candidates = [...localCandidates, ...collapseRemoteAdvertisements(remote)];

  const tasksByKey = new Map<string, WorkspaceTask>();
  for (const candidate of candidates) {
    const existing = tasksByKey.get(candidate.logicalKey);
    const next = existing
      ? mergeWorkspaceTask(existing, candidate)
      : createWorkspaceTask(candidate);
    tasksByKey.set(candidate.logicalKey, next);
  }

  const logicalKeyByRemoteTaskId = new Map(
    remote.map((candidate) => [candidate.item.id, candidate.logicalKey]),
  );
  const tasks = [...tasksByKey.values()]
    .map((task) => withResolvedParent(task, tasksByKey, logicalKeyByRemoteTaskId))
    .sort((a, b) => b.item.created_at.localeCompare(a.item.created_at));

  return {
    repos: repoContext.repos,
    tasks,
    diagnostics: tasks.map(diagnosticsForTask),
  };
}

/**
 * A remote task's parent arrives as a presentation id minted by the transport that
 * advertised it, but the parent may be presented under a different id here — the
 * viewer's own task after a transfer, or the sibling advertisement from the other
 * transport. Retarget it at the merged task through the shared logical key, and drop
 * the reference when the parent is not part of this workspace.
 */
function withResolvedParent(
  task: WorkspaceTask,
  tasksByKey: ReadonlyMap<string, WorkspaceTask>,
  logicalKeyByRemoteTaskId: ReadonlyMap<string, string>,
): WorkspaceTask {
  const parentTaskId = task.item.parent_task_id;
  if (!parentTaskId || task.localTaskId !== null) return task;

  const parentLogicalKey = logicalKeyByRemoteTaskId.get(parentTaskId);
  const parentTask = parentLogicalKey ? tasksByKey.get(parentLogicalKey) : undefined;
  const resolved = parentTask && parentTask.logicalTaskKey !== task.logicalTaskKey
    ? workspaceTaskDurableTaskId(parentTask)
    : null;
  if (resolved === parentTaskId) return task;
  return { ...task, item: { ...task.item, parent_task_id: resolved } };
}

/** The id a workspace task is addressed by once projected into the sidebar. */
function workspaceTaskDurableTaskId(task: WorkspaceTask): string {
  return task.localTaskId ?? task.item.id;
}

function buildRepoContext(
  localRepos: LocalRepoWithRemote[],
  remoteRepos: RemoteRepo[],
  repoSidebarOrder: ReadonlyMap<string, number> = new Map(),
) {
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
      sortOrder: entry.repo.sort_order,
    });
  }

  let nextUnorderedPosition = Math.max(
    -1,
    ...localRepos.map((entry) => entry.repo.sort_order),
    ...repoSidebarOrder.values(),
  ) + 1;

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
      sortOrder: remoteUrlHash !== null && repoSidebarOrder.has(remoteUrlHash)
        ? repoSidebarOrder.get(remoteUrlHash) ?? nextUnorderedPosition++
        : nextUnorderedPosition++,
    });
  }

  return {
    repos: [...reposByKey.values()].sort((left, right) => left.sortOrder - right.sortOrder),
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
  const logicalKey = `${repoKey}${LOGICAL_OWNER_TASK_MARKER}${item.id}`;
  return {
    item,
    repoKey,
    logicalKey,
    source: {
      kind: "local",
      taskId: item.id,
      repoId: item.repo_id,
      updatedAt: item.updated_at,
      blockerRevision: item.blocker_revision,
      blockedByTaskIds: [],
    },
  };
}

function remoteCandidates(
  snapshot: BuildWorkspaceInput["cloudSnapshot"],
  kind: "cloud" | "lan",
  repoContext: ReturnType<typeof buildRepoContext>,
  closedLocalKeys: Set<string>,
  remoteTaskPins: BuildWorkspaceInput["remoteTaskPins"],
): Array<Candidate | null> {
  return snapshot.items.map((item) => {
    if (item.closed_at) return null;
    const repoKey = repoContext.remoteRepoKeyById.get(item.repo_id)
      ?? repoContext.localRepoKeyById.get(item.repo_id)
      ?? item.repo_id;
    const terminalRef = snapshot.terminalRefs[item.id];
    const ownerLocalTaskId = terminalRef?.ownerLocalTaskId ?? stripRemoteTaskPrefix(item.id);
    const logicalKey = `${repoKey}${LOGICAL_OWNER_TASK_MARKER}${ownerLocalTaskId}`;
    if (closedLocalKeys.has(logicalKey)) return null;
    return {
      item: applyRemoteTaskPin(item, remoteTaskPins?.get(ownerLocalTaskId)),
      repoKey,
      logicalKey,
      source: {
        kind,
        taskId: item.id,
        repoId: item.repo_id,
        updatedAt: item.updated_at,
        blockerRevision: item.blocker_revision,
        transitionRevision: item.transition_revision,
        terminalRef,
        blockedByTaskIds: snapshot.blockedByTaskIds?.[item.id] ?? [],
      },
    };
  });
}

/**
 * Resolves a cross-machine row's pin state on this viewer's machine.
 *
 * The owner's own `pinned`/`pin_order` never crosses: pinning is per-operator,
 * and the row arrives unpinned. What this machine decides on its own is the
 * default — an account-wide singleton is pinned at the top of the pinned group
 * on every machine — and the viewer-local overlay overrides it in both
 * directions: an explicit order pins the row there, and an explicit `null`
 * unpin keeps it out of the pinned group for good.
 */
function applyRemoteTaskPin(item: PipelineItem, pin: RemoteTaskPin | undefined): PipelineItem {
  if (pin === null) return item;
  if (pin !== undefined) return { ...item, pinned: 1, pin_order: pin };
  if (!isDefaultPinnedTask(item)) return item;
  return { ...item, pinned: 1, pin_order: DEFAULT_SINGLETON_PIN_ORDER };
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
    if (repoKey) keys.add(`${repoKey}${LOGICAL_OWNER_TASK_MARKER}${item.id}`);
  }
  for (const item of closedItems) {
    const repoKey = localRepoKeyById.get(item.repo_id);
    if (repoKey) keys.add(`${repoKey}${LOGICAL_OWNER_TASK_MARKER}${item.id}`);
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
    sources: candidate.sources ?? [candidate.source],
    blockedByTaskIds: candidate.source.blockedByTaskIds,
    reachability: isLocal ? "local" : remoteRef ? "reachable" : "unknown",
    capabilities: capabilitiesFor(candidate),
    terminal: terminalRouteFor(candidate),
  };
}

function mergeWorkspaceTask(existing: WorkspaceTask, candidate: Candidate): WorkspaceTask {
  const sources = [...existing.sources, ...(candidate.sources ?? [candidate.source])];
  if (candidate.source.kind === "local") {
    return {
      ...existing,
      id: `local:${candidate.item.id}`,
      localTaskId: candidate.item.id,
      item: candidate.item,
      owner: { kind: "local", id: "local" },
      sources,
      blockedByTaskIds: [],
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
    || compareCandidateToWorkspace(candidate, candidateRoute, existing) <= 0
  ) {
    return {
      ...existing,
      remoteTaskIds,
      sources,
      blockedByTaskIds: existing.blockedByTaskIds,
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
    blockedByTaskIds: candidate.source.blockedByTaskIds,
    terminal: candidateRoute,
    reachability: candidateRoute.kind === "none" ? "unknown" : "reachable",
    capabilities: capabilitiesFor(candidate),
  };
}

function collapseRemoteAdvertisements(candidates: Candidate[]): Candidate[] {
  const winners = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const current = winners.get(candidate.item.id);
    if (!current) {
      winners.set(candidate.item.id, candidate);
      continue;
    }
    const sources = [
      ...(current.sources ?? [current.source]),
      ...(candidate.sources ?? [candidate.source]),
    ];
    const winner = compareCandidateAuthority(candidate, current) > 0 ? candidate : current;
    winners.set(candidate.item.id, { ...winner, sources });
  }
  return [...winners.values()];
}

function compareCandidateAuthority(left: Candidate, right: Candidate): number {
  return compareAuthority(
    left.item,
    left.source,
    terminalRouteFor(left),
    right.item,
    right.source,
    terminalRouteFor(right),
  );
}

function compareCandidateToWorkspace(
  candidate: Candidate,
  candidateRoute: WorkspaceTerminalRoute,
  existing: WorkspaceTask,
): number {
  const existingSource = existing.sources.find((source) =>
    source.taskId === existing.item.id
    && source.kind === existing.terminal.kind)
    ?? existing.sources.find((source) => source.taskId === existing.item.id)
    ?? existing.sources[0];
  return compareAuthority(
    candidate.item,
    candidate.source,
    candidateRoute,
    existing.item,
    existingSource,
    existing.terminal,
  );
}

function compareAuthority(
  leftItem: PipelineItem,
  leftSource: WorkspaceTaskSource,
  leftRoute: WorkspaceTerminalRoute,
  rightItem: PipelineItem,
  rightSource: WorkspaceTaskSource,
  rightRoute: WorkspaceTerminalRoute,
): number {
  const itemComparison = leftItem.updated_at.localeCompare(rightItem.updated_at)
    || (leftItem.activity_revision ?? -1) - (rightItem.activity_revision ?? -1)
    || (leftItem.blocker_revision ?? -1) - (rightItem.blocker_revision ?? -1)
    || (leftItem.transition_revision ?? "").localeCompare(rightItem.transition_revision ?? "");
  if (itemComparison !== 0) return itemComparison;

  const leftOwner = leftSource.terminalRef?.ownerDesktopId ?? "";
  const rightOwner = rightSource.terminalRef?.ownerDesktopId ?? "";
  const leftOwnerTask = leftSource.terminalRef?.ownerLocalTaskId ?? "";
  const rightOwnerTask = rightSource.terminalRef?.ownerLocalTaskId ?? "";
  if (leftOwnerTask !== rightOwnerTask && leftSource.kind !== rightSource.kind) {
    // Cloud publication is transfer-state aware; when equally fresh LAN and
    // cloud advertisements disagree on ownership, cloud is the authority.
    return leftSource.kind === "cloud" ? 1 : -1;
  }
  return routePrecedence(leftRoute) - routePrecedence(rightRoute)
    || leftItem.id.localeCompare(rightItem.id)
    || leftOwner.localeCompare(rightOwner);
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
  const canPullFromMachine = !isLocal
    && isReachable
    && Boolean(candidate.source.terminalRef?.transferPeerId?.trim());
  return buildCapabilities({ isLocal, hasTerminal, isReachable, canPullFromMachine });
}

function buildCapabilities(input: {
  isLocal: boolean;
  hasTerminal: boolean;
  isReachable: boolean;
  canPullFromMachine: boolean;
}): WorkspaceCapabilities {
  return {
    canOpenTerminal: input.hasTerminal,
    canSendInput: input.hasTerminal,
    canResizeTerminal: input.hasTerminal,
    canClose: input.isReachable,
    canCreateSiblingTask: true,
    canPushToMachine: input.isLocal,
    canPullFromMachine: input.canPullFromMachine,
    canOpenDiff: input.isReachable,
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
  return candidate.remoteUrlHash ?? candidate.remote_url_hash ?? null;
}

function stripRemoteTaskPrefix(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] || id;
}
