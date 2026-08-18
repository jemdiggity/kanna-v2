import type {
  KannaClient,
  TaskAgentStreamEvent,
  TaskAgentSubscription,
  TaskCompanionStreamEvent,
  TaskCompanionSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../api/client";
import { RepoNotRegisteredError } from "../api/client";
import type {
  CreateTaskRequest,
  DesktopSummary,
  RepoSummary,
  TaskActionResponse,
  TaskDiffContent,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskSummary
} from "../api/types";
import {
  buildCloudTaskId,
  canonicalizeTaskActionId
} from "../api/taskIdentity";
import { canonicalRepoId, mergeRepoSummaries } from "../api/repoIdentity";

export type DisplayTaskRoute =
  | { source: "cloud"; taskId: string }
  | {
      source: "lan";
      taskId: string;
      desktopId: string;
      cloudFallbackTaskId?: string;
    }
  | {
      source: "unavailable";
      taskId: string;
      desktopId: string;
      message: string;
    };

export interface CloudLanClientOptions {
  isLanEnabled(): boolean;
  canUseLanTaskStreams?(desktopId: string): boolean;
  lanClientForDesktop?(desktopId: string): KannaClient | null;
  optionalLanWaitMs?: number;
  onDesktopSourceWarnings?(warnings: DesktopSourceWarnings): void;
  initialDesktopSources?: DesktopSources;
  onDesktopSourcesChanged?(sources: DesktopSources): void;
  onLanReadUnavailable?(): void;
}

export interface DesktopSourceWarnings {
  account: string | null;
  local: string | null;
}

export interface DesktopSources {
  account: DesktopSummary[];
  local: DesktopSummary[];
}

export interface LanTaskSnapshot {
  desktopId: string;
  tasks: TaskSummary[];
}

interface LanRepoSnapshot {
  desktopId: string;
  repos: RepoSummary[];
}

export interface MergedTaskSnapshot {
  tasks: TaskSummary[];
  routes: Map<string, DisplayTaskRoute>;
}

export interface CloudLanClient extends KannaClient {
  listRecentTasksWithSupplement(
    onSupplement: (tasks: TaskSummary[]) => void
  ): Promise<TaskSummary[]>;
}

type SettledRead<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

interface TaskReadEntry {
  promise: Promise<TaskSummary[]>;
  supplements: Set<(tasks: TaskSummary[]) => void>;
}

class OptionalLanReadInFlightError extends Error {}

type ProvisionalTaskRoute = Extract<DisplayTaskRoute, { source: "lan" }> & {
  localRepoId?: string;
  displayRepoId?: string;
};

const DEFAULT_OPTIONAL_LAN_WAIT_MS = 1_000;

export function mergeCloudAndLanTasks({
  cloudTasks,
  lan,
  lanAuthoritative = true,
  preferLanRoutes = lanAuthoritative
}: {
  cloudTasks: TaskSummary[];
  lan: LanTaskSnapshot | null;
  lanAuthoritative?: boolean;
  preferLanRoutes?: boolean;
}): MergedTaskSnapshot {
  const routes = new Map<string, DisplayTaskRoute>();
  const usedLanTaskIndexes = new Set<number>();
  const usedDisplayTaskIds = new Set<string>();
  const tasks: TaskSummary[] = [];

  for (const cloudTask of cloudTasks) {
    const matchingLanTaskIndex = lan
      ? lan.tasks.findIndex(
          (lanTask, index) =>
            !usedLanTaskIndexes.has(index) &&
            cloudTask.ownerDesktopId === lan.desktopId &&
            cloudTask.ownerLocalTaskId === lanTask.id &&
            (cloudTask.ownerLocalRepoId === undefined ||
              cloudTask.ownerLocalRepoId === lanTask.repoId)
        )
      : -1;

    if (lan && matchingLanTaskIndex >= 0) {
      const lanTask = lan.tasks[matchingLanTaskIndex];
      usedLanTaskIndexes.add(matchingLanTaskIndex);
      const mergedTask: TaskSummary = {
        ...cloudTask,
        title: lanTask.title ?? cloudTask.title,
        stage: lanTask.stage ?? cloudTask.stage
      };
      if (mergedTask.ownerLocalRepoId === undefined) {
        mergedTask.ownerLocalRepoId = lanTask.repoId;
      }
      if (lanTask.prompt !== null && lanTask.prompt !== undefined) {
        mergedTask.prompt = lanTask.prompt;
      }
      if (
        lanTask.waitingPromptSnippet !== null &&
        lanTask.waitingPromptSnippet !== undefined
      ) {
        mergedTask.waitingPromptSnippet = lanTask.waitingPromptSnippet;
      }
      if (lanTask.agentType !== null && lanTask.agentType !== undefined) {
        mergedTask.agentType = lanTask.agentType;
      }
      if (lanTask.activity !== undefined) {
        mergedTask.activity = lanTask.activity;
      }
      if (lanTask.activityRevision !== undefined) {
        mergedTask.activityRevision = lanTask.activityRevision;
      }
      // LAN is fresher; null/empty are meaningful (parent detached, blockers
      // resolved), so only an absent field falls back to the cloud snapshot.
      if (lanTask.parentTaskId !== undefined) {
        mergedTask.parentTaskId = lanTask.parentTaskId;
      }
      if (lanTask.blockedByTaskIds !== undefined) {
        mergedTask.blockedByTaskIds = lanTask.blockedByTaskIds;
      }
      if (lanTask.pinned !== undefined) {
        mergedTask.pinned = lanTask.pinned;
      }
      if (lanTask.pinOrder !== undefined) {
        mergedTask.pinOrder = lanTask.pinOrder;
      }
      tasks.push(mergedTask);
      usedDisplayTaskIds.add(cloudTask.id);
      routes.set(
        cloudTask.id,
        preferLanRoutes
          ? {
              source: "lan",
              taskId: lanTask.id,
              desktopId: lan.desktopId,
              cloudFallbackTaskId: cloudTask.id
            }
          : { source: "cloud", taskId: cloudTask.id }
      );
      continue;
    }

    if (
      lan &&
      lanAuthoritative &&
      cloudTask.ownerDesktopId === lan.desktopId
    ) {
      continue;
    }

    tasks.push(cloudTask);
    usedDisplayTaskIds.add(cloudTask.id);
    routes.set(cloudTask.id, { source: "cloud", taskId: cloudTask.id });
  }

  if (lan) {
    lan.tasks.forEach((lanTask, index) => {
      if (usedLanTaskIndexes.has(index)) {
        return;
      }
      const displayTaskId = collisionSafeLanTaskId(
        lan.desktopId,
        lanTask.id,
        usedDisplayTaskIds
      );
      usedDisplayTaskIds.add(displayTaskId);
      tasks.push(
        displayTaskId === lanTask.id
          ? lanTask
          : { ...lanTask, id: displayTaskId }
      );
      routes.set(displayTaskId, {
        source: "lan",
        taskId: lanTask.id,
        desktopId: lan.desktopId
      });
    });
  }

  return { tasks, routes };
}

function mergeCloudWithPreservedLanProjection(
  cloudTasks: TaskSummary[],
  accepted: MergedTaskSnapshot,
  provisionalRoutes: ReadonlyMap<string, ProvisionalTaskRoute>
): MergedTaskSnapshot {
  const acceptedTasksById = new Map(
    accepted.tasks.map((task) => [task.id, task] as const)
  );
  const preservedLanEntries = Array.from(accepted.routes.entries()).flatMap(
    ([displayTaskId, route]) => {
      if (route.source !== "lan") return [];
      const task = acceptedTasksById.get(displayTaskId);
      return task ? [{ displayTaskId, route, task }] : [];
    }
  );
  const preservedLanByDisplayId = new Map(
    preservedLanEntries.map((entry) => [entry.displayTaskId, entry] as const)
  );
  const reservedLanDisplayIds = new Set(preservedLanByDisplayId.keys());
  const usedPreservedDisplayIds = new Set<string>();
  const usedDisplayTaskIds = new Set<string>();
  const tasks: TaskSummary[] = [];
  const routes = new Map<string, DisplayTaskRoute>();

  const appendPreserved = (
    entry: (typeof preservedLanEntries)[number]
  ) => {
    if (usedPreservedDisplayIds.has(entry.displayTaskId)) return;
    usedPreservedDisplayIds.add(entry.displayTaskId);
    usedDisplayTaskIds.add(entry.displayTaskId);
    tasks.push(entry.task);
    routes.set(entry.displayTaskId, entry.route);
  };

  const mergePublishedWithPreservedLanState = (
    cloudTask: TaskSummary,
    preservedTask: TaskSummary,
    displayTaskId: string
  ): TaskSummary => {
    const mergedTask: TaskSummary = {
      ...cloudTask,
      id: displayTaskId,
      title: preservedTask.title ?? cloudTask.title,
      stage: preservedTask.stage ?? cloudTask.stage
    };
    if (
      mergedTask.ownerLocalRepoId === undefined &&
      preservedTask.ownerLocalRepoId !== undefined
    ) {
      mergedTask.ownerLocalRepoId = preservedTask.ownerLocalRepoId;
    }
    if (preservedTask.prompt !== null && preservedTask.prompt !== undefined) {
      mergedTask.prompt = preservedTask.prompt;
    }
    if (
      preservedTask.waitingPromptSnippet !== null &&
      preservedTask.waitingPromptSnippet !== undefined
    ) {
      mergedTask.waitingPromptSnippet = preservedTask.waitingPromptSnippet;
    }
    if (
      preservedTask.agentType !== null &&
      preservedTask.agentType !== undefined
    ) {
      mergedTask.agentType = preservedTask.agentType;
    }
    if (preservedTask.activity !== undefined) {
      mergedTask.activity = preservedTask.activity;
    }
    if (preservedTask.activityRevision !== undefined) {
      mergedTask.activityRevision = preservedTask.activityRevision;
    }
    if (preservedTask.parentTaskId !== undefined) {
      mergedTask.parentTaskId = preservedTask.parentTaskId;
    }
    if (preservedTask.blockedByTaskIds !== undefined) {
      mergedTask.blockedByTaskIds = preservedTask.blockedByTaskIds;
    }
    return mergedTask;
  };

  for (const cloudTask of cloudTasks) {
    const ownerMatch =
      cloudTask.ownerDesktopId && cloudTask.ownerLocalTaskId
        ? preservedLanEntries.find(
            (entry) =>
              entry.route.desktopId === cloudTask.ownerDesktopId &&
              entry.route.taskId === cloudTask.ownerLocalTaskId &&
              (cloudTask.ownerLocalRepoId === undefined ||
                cloudTask.ownerLocalRepoId ===
                  (provisionalRoutes.get(entry.displayTaskId)?.localRepoId ??
                    entry.task.ownerLocalRepoId ??
                    entry.task.repoId))
          )
        : undefined;
    if (ownerMatch) {
      usedPreservedDisplayIds.add(ownerMatch.displayTaskId);
      const reservedIdMatch = preservedLanByDisplayId.get(cloudTask.id);
      if (
        reservedIdMatch &&
        reservedIdMatch.displayTaskId !== ownerMatch.displayTaskId
      ) {
        appendPreserved(reservedIdMatch);
      }
      const displayTaskId =
        reservedIdMatch &&
        reservedIdMatch.displayTaskId !== ownerMatch.displayTaskId
          ? collisionSafeCloudTaskId(
              cloudTask.id,
              new Set([...reservedLanDisplayIds, ...usedDisplayTaskIds])
            )
          : cloudTask.id;
      usedDisplayTaskIds.add(displayTaskId);
      tasks.push(
        mergePublishedWithPreservedLanState(
          cloudTask,
          ownerMatch.task,
          displayTaskId
        )
      );
      routes.set(displayTaskId, {
        ...ownerMatch.route,
        cloudFallbackTaskId: cloudTask.id
      });
      continue;
    }

    const reservedIdMatch = preservedLanByDisplayId.get(cloudTask.id);
    if (reservedIdMatch) {
      appendPreserved(reservedIdMatch);
      const displayTaskId = collisionSafeCloudTaskId(
        cloudTask.id,
        new Set([...reservedLanDisplayIds, ...usedDisplayTaskIds])
      );
      usedDisplayTaskIds.add(displayTaskId);
      tasks.push({ ...cloudTask, id: displayTaskId });
      routes.set(displayTaskId, { source: "cloud", taskId: cloudTask.id });
      continue;
    }

    const displayTaskId = collisionSafeCloudTaskId(
      cloudTask.id,
      new Set([...reservedLanDisplayIds, ...usedDisplayTaskIds])
    );
    usedDisplayTaskIds.add(displayTaskId);
    tasks.push(
      displayTaskId === cloudTask.id
        ? cloudTask
        : { ...cloudTask, id: displayTaskId }
    );
    routes.set(displayTaskId, { source: "cloud", taskId: cloudTask.id });
  }

  for (const entry of preservedLanEntries) {
    appendPreserved(entry);
  }

  return { tasks, routes };
}

function collisionSafeCloudTaskId(
  taskId: string,
  usedDisplayTaskIds: ReadonlySet<string>
): string {
  if (!usedDisplayTaskIds.has(taskId)) return taskId;

  const baseId = `cloud:${taskId}`;
  let displayTaskId = baseId;
  let suffix = 2;
  while (usedDisplayTaskIds.has(displayTaskId)) {
    displayTaskId = `${baseId}:${suffix}`;
    suffix += 1;
  }
  return displayTaskId;
}

function hasLanRoutes(snapshot: MergedTaskSnapshot | undefined): boolean {
  return snapshot
    ? Array.from(snapshot.routes.values()).some((route) => route.source === "lan")
    : false;
}

function collisionSafeLanTaskId(
  desktopId: string,
  taskId: string,
  usedDisplayTaskIds: ReadonlySet<string>
): string {
  if (!usedDisplayTaskIds.has(taskId)) {
    return taskId;
  }

  const baseId = `lan:${desktopId}:${taskId}`;
  let displayTaskId = baseId;
  let suffix = 2;
  while (usedDisplayTaskIds.has(displayTaskId)) {
    displayTaskId = `${baseId}:${suffix}`;
    suffix += 1;
  }
  return displayTaskId;
}

export function createCloudLanClient(
  cloud: KannaClient,
  lan: KannaClient,
  options: CloudLanClientOptions
): CloudLanClient {
  const optionalLanWaitMs = normalizeOptionalLanWaitMs(
    options.optionalLanWaitMs
  );
  let latestReadEpoch = 0;
  let ordinaryTaskReadBatch: TaskReadEntry | undefined;
  let authoritativeTaskReadInFlight: TaskReadEntry | undefined;
  let latestRepoReadEpoch = 0;
  let latestDesktopReadEpoch = 0;
  let snapshotTaskRoutes = new Map<string, DisplayTaskRoute>();
  let acceptedTaskSnapshot: MergedTaskSnapshot | undefined;
  const provisionalTaskRoutes = new Map<string, ProvisionalTaskRoute>();
  let lastCloudTasks: TaskSummary[] | undefined;
  let lastLanTaskSnapshot: LanTaskSnapshot | undefined;
  let lastCloudRepos: RepoSummary[] | undefined;
  let lastLanRepoSnapshot: LanRepoSnapshot | undefined;
  let lastCloudDesktops: DesktopSummary[] | undefined =
    options.initialDesktopSources?.account;
  let lastLanDesktops: DesktopSummary[] | undefined =
    options.initialDesktopSources?.local;
  let desktopSourceWarnings: DesktopSourceWarnings = {
    account: null,
    local: null
  };
  const lanRepoOwners = new Map<string, Map<string, string>>();
  const lanRepoSnapshots = new Map<string, RepoSummary[]>();
  // Desktop-local repo id -> canonical display id (`git:<hash>`) for LAN
  // repos with a remote URL hash, so LAN-only tasks list under the same
  // repository entry as their cloud-published siblings from other machines.
  const lanRepoDisplayIds = new Map<string, string>();

  const rememberLanRepos = (snapshot: LanRepoSnapshot) => {
    let displayIdsChanged = false;
    lanRepoSnapshots.set(snapshot.desktopId, snapshot.repos);
    for (const [displayRepoId, owners] of lanRepoOwners) {
      owners.delete(snapshot.desktopId);
      if (owners.size === 0) {
        lanRepoOwners.delete(displayRepoId);
      }
    }
    for (const repo of snapshot.repos) {
      const displayRepoId = canonicalRepoId(repo);
      const owners = lanRepoOwners.get(displayRepoId) ?? new Map<string, string>();
      owners.set(snapshot.desktopId, repo.id);
      lanRepoOwners.set(displayRepoId, owners);
      if (displayRepoId === repo.id) {
        displayIdsChanged = lanRepoDisplayIds.delete(repo.id) || displayIdsChanged;
      } else if (lanRepoDisplayIds.get(repo.id) !== displayRepoId) {
        lanRepoDisplayIds.set(repo.id, displayRepoId);
        displayIdsChanged = true;
      }
    }
    // Newly learned repo identity reprojects the accepted snapshot, so an
    // already-published task list stops deriving a duplicate repo entry the
    // moment the LAN repo read lands. Routes are keyed by task display id
    // and stay valid.
    if (displayIdsChanged && acceptedTaskSnapshot) {
      acceptedTaskSnapshot = canonicalizeLanTaskRepoIds(acceptedTaskSnapshot);
      snapshotTaskRoutes = acceptedTaskSnapshot.routes;
    }
  };

  const canonicalizeLanTaskRepoIds = (
    merged: MergedTaskSnapshot
  ): MergedTaskSnapshot => {
    if (lanRepoDisplayIds.size === 0) {
      return merged;
    }
    let changed = false;
    const tasks = merged.tasks.map((task) => {
      const displayRepoId = lanRepoDisplayIds.get(task.repoId);
      if (!displayRepoId) {
        return task;
      }
      changed = true;
      return {
        ...task,
        repoId: displayRepoId,
        ownerLocalRepoId: task.ownerLocalRepoId ?? task.repoId
      };
    });
    return changed ? { tasks, routes: merged.routes } : merged;
  };

  const reportDesktopSourceWarnings = (
    updates: Partial<DesktopSourceWarnings>
  ) => {
    desktopSourceWarnings = { ...desktopSourceWarnings, ...updates };
    options.onDesktopSourceWarnings?.(desktopSourceWarnings);
  };
  const publishDesktopSources = () => {
    options.onDesktopSourcesChanged?.({
      account: lastCloudDesktops ?? [],
      local: options.isLanEnabled() ? lastLanDesktops ?? [] : []
    });
  };

  const projectProvisionalTaskIdentities = (
    merged: MergedTaskSnapshot
  ): MergedTaskSnapshot => {
    const tasks = [...merged.tasks];
    const routes = new Map(merged.routes);
    for (const [displayTaskId, provisionalRoute] of provisionalTaskRoutes) {
      const published = tasks.some(
        (task) =>
          task.ownerDesktopId === provisionalRoute.desktopId &&
          task.ownerLocalTaskId === provisionalRoute.taskId &&
          (!provisionalRoute.localRepoId ||
            task.ownerLocalRepoId === provisionalRoute.localRepoId)
      );
      if (published) {
        continue;
      }
      const matchingTaskIndex = tasks.findIndex((task) => {
        const route = routes.get(task.id);
        return (
          route?.source === "lan" &&
          route.desktopId === provisionalRoute.desktopId &&
          route.taskId === provisionalRoute.taskId &&
          (!provisionalRoute.localRepoId ||
            task.repoId === provisionalRoute.localRepoId)
        );
      });
      if (matchingTaskIndex < 0) {
        continue;
      }
      const matchingTask = tasks[matchingTaskIndex];
      const matchingRoute = routes.get(matchingTask.id);
      if (matchingRoute?.source !== "lan") {
        continue;
      }
      tasks[matchingTaskIndex] = {
        ...matchingTask,
        id: displayTaskId,
        repoId: provisionalRoute.displayRepoId ?? matchingTask.repoId
      };
      if (matchingTask.id !== displayTaskId) {
        routes.delete(matchingTask.id);
      }
      routes.set(displayTaskId, {
        source: "lan",
        taskId: matchingRoute.taskId,
        desktopId: matchingRoute.desktopId,
        ...(matchingRoute.cloudFallbackTaskId
          ? { cloudFallbackTaskId: matchingRoute.cloudFallbackTaskId }
          : {})
      });
    }
    return { tasks, routes };
  };

  const acceptMergedTaskSnapshot = (
    readEpoch: number,
    merged: MergedTaskSnapshot
  ): MergedTaskSnapshot => {
    if (readEpoch !== latestReadEpoch && acceptedTaskSnapshot) {
      return acceptedTaskSnapshot;
    }
    merged = canonicalizeLanTaskRepoIds(projectProvisionalTaskIdentities(merged));
    acceptedTaskSnapshot = merged;
    snapshotTaskRoutes = merged.routes;
    for (const [displayTaskId, provisionalRoute] of provisionalTaskRoutes) {
      const isPublished = merged.tasks.some(
        (task) =>
          task.ownerDesktopId === provisionalRoute.desktopId &&
          task.ownerLocalTaskId === provisionalRoute.taskId &&
          (!provisionalRoute.localRepoId ||
            task.ownerLocalRepoId === provisionalRoute.localRepoId)
      );
      if (isPublished) {
        provisionalTaskRoutes.delete(displayTaskId);
      }
    }
    return merged;
  };

  const lanClientForDesktop = (desktopId: string): KannaClient | null => {
    if (!options.lanClientForDesktop) {
      return lan;
    }
    try {
      return options.lanClientForDesktop(desktopId);
    } catch {
      return null;
    }
  };

  // One repo fetch per desktop is shared between repo listings and task
  // reads, so concurrent bootstrap flows consume a single /v1/repos call and
  // identity bookkeeping happens at fetch resolution regardless of which
  // caller wins the race.
  const lanRepoIdentityDesktops = new Set<string>();
  let lanRepoFetchInFlight: {
    desktopId: string;
    read: Promise<LanRepoSnapshot>;
  } | null = null;
  const fetchLanRepoSnapshot = (
    desktopLan: KannaClient,
    desktopId: string
  ): Promise<LanRepoSnapshot> => {
    if (lanRepoFetchInFlight?.desktopId === desktopId) {
      return lanRepoFetchInFlight.read;
    }
    let inFlight!: { desktopId: string; read: Promise<LanRepoSnapshot> };
    const read = desktopLan
      .listRepos()
      .then((repos) => {
        const snapshot: LanRepoSnapshot = { desktopId, repos };
        rememberLanRepos(snapshot);
        lanRepoIdentityDesktops.add(desktopId);
        return snapshot;
      })
      .finally(() => {
        if (lanRepoFetchInFlight === inFlight) {
          lanRepoFetchInFlight = null;
        }
      });
    inFlight = { desktopId, read };
    lanRepoFetchInFlight = inFlight;
    return read;
  };
  const loadLanRepoSnapshot = async (): Promise<LanRepoSnapshot> => {
    const status = await lan.getStatus();
    if (status.state !== "running") {
      throw new Error(`LAN desktop is not running (${status.state}).`);
    }
    const desktopLan = lanClientForDesktop(status.desktopId);
    if (!desktopLan) {
      throw new Error(
        `No LAN client is available for desktop ${status.desktopId}.`
      );
    }
    return fetchLanRepoSnapshot(desktopLan, status.desktopId);
  };
  const readLanRepoSnapshot = shareWhilePending(loadLanRepoSnapshot);
  const loadLanTaskSnapshot = async (): Promise<LanTaskSnapshot> => {
    const status = await lan.getStatus();
    if (status.state !== "running") {
      throw new Error(`LAN desktop is not running (${status.state}).`);
    }
    const desktopLan = lanClientForDesktop(status.desktopId);
    if (!desktopLan) {
      throw new Error(
        `No LAN client is available for desktop ${status.desktopId}.`
      );
    }
    // Until this desktop's repo identity is known, task reads fetch the repo
    // list alongside the tasks so LAN-only tasks canonicalize to
    // `git:<hash>` in the same read. Without this, a bootstrap that accepts
    // tasks before any repo read lands would return desktop-local repo ids
    // and resurface the cross-machine duplicate. Best-effort: a failed repo
    // read degrades to the last known identity.
    const repoIdentityRead = lanRepoIdentityDesktops.has(status.desktopId)
      ? null
      : fetchLanRepoSnapshot(desktopLan, status.desktopId).then(
          () => undefined,
          () => undefined
        );
    const tasks = await desktopLan.listRecentTasks();
    if (repoIdentityRead) {
      await repoIdentityRead;
    }
    return {
      desktopId: status.desktopId,
      tasks
    };
  };
  const readLanTaskSnapshot = shareWhilePending(loadLanTaskSnapshot);
  const readLanDesktops = shareWhilePending(() => lan.listDesktops());

  const performRecentTaskRead = async (
    readEpoch: number,
    supplements: Set<(tasks: TaskSummary[]) => void>
  ): Promise<TaskSummary[]> => {
    const lanEnabled = options.isLanEnabled();
    let cloudTasksForRead: TaskSummary[] | undefined;
    let lateLanSnapshotForRead: LanTaskSnapshot | undefined;
    let primarySnapshotReady = false;
    const cloudRead = settleRead(() => cloud.listRecentTasks());
    const lanRead = lanEnabled
      ? settleOptionalLanRead(
          readLanTaskSnapshot,
          optionalLanWaitMs,
          (lateSnapshot) => {
            lateLanSnapshotForRead = lateSnapshot;
            if (
              readEpoch === latestReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanTaskSnapshot = lateSnapshot;
              if (primarySnapshotReady && supplements.size > 0) {
                const merged = mergeCloudAndLanTasks({
                  cloudTasks: cloudTasksForRead ?? lastCloudTasks ?? [],
                  lan: lateSnapshot
                });
                const accepted = acceptMergedTaskSnapshot(readEpoch, merged);
                for (const publishSupplement of supplements) {
                  publishSupplement(accepted.tasks);
                }
              }
            }
          }
        )
      : null;
    const cloudResult = await cloudRead;
    cloudTasksForRead =
      cloudResult.status === "fulfilled"
        ? cloudResult.value
        : lastCloudTasks;
    const lanResult = lanRead ? await lanRead : null;
    const isLatestRead = readEpoch === latestReadEpoch;
    const canEstablishSnapshot =
      isLatestRead || acceptedTaskSnapshot === undefined;
    const lanStillEnabled = lanEnabled && options.isLanEnabled();

    if (
      lanStillEnabled &&
      lanResult?.status === "rejected" &&
      !(lanResult.reason instanceof OptionalLanReadInFlightError)
    ) {
      options.onLanReadUnavailable?.();
    }

    if (canEstablishSnapshot && cloudResult.status === "fulfilled") {
      lastCloudTasks = cloudResult.value;
    }
    if (
      canEstablishSnapshot &&
      lanStillEnabled &&
      lanResult?.status === "fulfilled"
    ) {
      lastLanTaskSnapshot = lanResult.value;
    }
    if (canEstablishSnapshot && !lanStillEnabled) {
      lastLanTaskSnapshot = undefined;
    }

    const cloudTasks =
      cloudResult.status === "fulfilled"
        ? cloudResult.value
        : lastCloudTasks;
    const currentLanSnapshot = lanStillEnabled
      ? lanResult?.status === "fulfilled"
        ? lanResult.value
        : lateLanSnapshotForRead
      : undefined;
    const lanSnapshot = lanStillEnabled
      ? currentLanSnapshot ?? lastLanTaskSnapshot
      : undefined;

    if (cloudTasks === undefined && lanSnapshot === undefined) {
      primarySnapshotReady = true;
      throw firstReadFailure(cloudResult, lanResult);
    }

    const merged =
      currentLanSnapshot !== undefined
        ? mergeCloudAndLanTasks({
            cloudTasks: cloudTasks ?? [],
            lan: currentLanSnapshot
          })
        : lanStillEnabled && hasLanRoutes(acceptedTaskSnapshot)
          ? mergeCloudWithPreservedLanProjection(
              cloudTasks ?? [],
              acceptedTaskSnapshot!,
              provisionalTaskRoutes
            )
          : mergeCloudAndLanTasks({
              cloudTasks: cloudTasks ?? [],
              lan: lanSnapshot ?? null,
              lanAuthoritative: false,
              preferLanRoutes: lanSnapshot !== undefined
            });

    primarySnapshotReady = true;
    return acceptMergedTaskSnapshot(readEpoch, merged).tasks;
  };

  const startTaskRead = (
    supplements: Set<(tasks: TaskSummary[]) => void>
  ): Promise<TaskSummary[]> => {
    const readEpoch = ++latestReadEpoch;
    return performRecentTaskRead(readEpoch, supplements);
  };

  const listRecentTasks = (): Promise<TaskSummary[]> => {
    if (authoritativeTaskReadInFlight) {
      return acceptedTaskSnapshot
        ? Promise.resolve(acceptedTaskSnapshot.tasks)
        : authoritativeTaskReadInFlight.promise;
    }
    if (ordinaryTaskReadBatch) {
      return ordinaryTaskReadBatch.promise;
    }

    const supplements = new Set<(tasks: TaskSummary[]) => void>();
    const batch = { promise: startTaskRead(supplements), supplements };
    ordinaryTaskReadBatch = batch;
    void Promise.resolve().then(() => {
      if (ordinaryTaskReadBatch === batch) {
        ordinaryTaskReadBatch = undefined;
      }
    });
    return batch.promise;
  };

  const listRecentTasksWithSupplement = (
    onSupplement: (tasks: TaskSummary[]) => void
  ): Promise<TaskSummary[]> => {
    ordinaryTaskReadBatch = undefined;
    const supplements = new Set([onSupplement]);
    let inFlight!: TaskReadEntry;
    const promise = startTaskRead(supplements).finally(() => {
      if (authoritativeTaskReadInFlight === inFlight) {
        authoritativeTaskReadInFlight = undefined;
      }
    });
    inFlight = { promise, supplements };
    authoritativeTaskReadInFlight = inFlight;
    return promise;
  };

  type ResolvedTaskRoute =
    | { source: "cloud"; taskId: string; client: KannaClient }
    | {
        source: "lan";
        taskId: string;
        desktopId: string;
        client: KannaClient;
        cloudFallbackTaskId?: string;
      }
    | Extract<DisplayTaskRoute, { source: "unavailable" }>;

  const routeForTask = (taskId: string): ResolvedTaskRoute => {
    const route =
      provisionalTaskRoutes.get(taskId) ?? snapshotTaskRoutes.get(taskId);
    if (!route) {
      return { source: "cloud", taskId, client: cloud };
    }
    if (route.source === "cloud") {
      return { ...route, client: cloud };
    }
    if (route.source === "unavailable") {
      return route;
    }

    const lanClient = options.isLanEnabled()
      ? lanClientForDesktop(route.desktopId)
      : null;
    if (lanClient) {
      return { ...route, client: lanClient };
    }
    if (route.cloudFallbackTaskId) {
      return {
        source: "cloud",
        taskId: route.cloudFallbackTaskId,
        client: cloud
      };
    }
    return {
      source: "unavailable",
      taskId: route.taskId,
      desktopId: route.desktopId,
      message: `LAN route for task "${taskId}" is unavailable.`
    };
  };

  const routeForTaskStream = (taskId: string): ResolvedTaskRoute => {
    const route = routeForTask(taskId);
    if (
      route.source === "lan" &&
      route.cloudFallbackTaskId &&
      options.canUseLanTaskStreams?.(route.desktopId) === false
    ) {
      return {
        source: "cloud",
        taskId: route.cloudFallbackTaskId,
        client: cloud
      };
    }
    return route;
  };

  const invokeTaskRoute = <T>(
    taskId: string,
    invoke: (client: KannaClient, routedTaskId: string) => Promise<T>
  ): Promise<T> => {
    const route = routeForTask(taskId);
    if (route.source === "unavailable") {
      return Promise.reject(new Error(route.message));
    }
    return invoke(route.client, route.taskId);
  };

  const routeForRepo = (repoId: string) => {
    const sourceTask = acceptedTaskSnapshot?.tasks.find(
      (candidate) => candidate.repoId === repoId
    );
    if (!sourceTask) {
      const owner = lanRepoOwners.get(repoId)?.entries().next().value;
      if (owner && options.isLanEnabled()) {
        const [desktopId, localRepoId] = owner;
        const ownerClient = lanClientForDesktop(desktopId);
        if (ownerClient) {
          return {
            source: "lan" as const,
            client: ownerClient,
            repoId: localRepoId,
            desktopId
          };
        }
        return {
          source: "unavailable" as const,
          taskId: repoId,
          desktopId,
          message: `LAN route for repository "${repoId}" is unavailable.`
        };
      }
      return { source: "cloud" as const, client: cloud, repoId };
    }
    const taskRoute = routeForTask(sourceTask.id);
    if (taskRoute.source === "unavailable") {
      return taskRoute;
    }
    if (taskRoute.source === "lan") {
      return {
        source: "lan" as const,
        client: taskRoute.client,
        repoId: sourceTask.ownerLocalRepoId ?? sourceTask.repoId,
        desktopId: taskRoute.desktopId
      };
    }
    return {
      source: "cloud" as const,
      client: taskRoute.client,
      repoId: sourceTask.repoId
    };
  };

  const invokeTaskActionRoute = async (
    taskId: string,
    invoke: (client: KannaClient, routedTaskId: string) => Promise<TaskActionResponse>
  ): Promise<TaskActionResponse> => {
    const route = routeForTask(taskId);
    if (route.source === "unavailable") {
      throw new Error(route.message);
    }
    const response = await invoke(route.client, route.taskId);
    const responseTaskId = (
      response as TaskActionResponse | null | undefined
    )?.taskId;
    if (typeof responseTaskId !== "string") {
      return response;
    }
    if (responseTaskId === route.taskId) {
      return { ...response, taskId };
    }

    if (route.source === "lan") {
      const sourceTask = acceptedTaskSnapshot?.tasks.find(
        (candidate) => candidate.id === taskId
      );
      const provisionalRoute = provisionalTaskRoutes.get(taskId);
      const localRepoId =
        provisionalRoute?.localRepoId ??
        sourceTask?.ownerLocalRepoId ??
        sourceTask?.repoId ??
        null;
      if (localRepoId) {
        const canonicalTaskId = canonicalizeTaskActionId({
          canonicalTaskId: taskId,
          ownerDesktopId: route.desktopId,
          localRepoId,
          sourceLocalTaskId: route.taskId,
          responseLocalTaskId: responseTaskId
        });
        const resolvedTask = await route.client
          .listRecentTasks()
          .then((tasks) =>
            tasks.find(
              (candidate) =>
                candidate.id === responseTaskId &&
                candidate.repoId === localRepoId
            )
          )
          .catch(() => undefined);
        provisionalTaskRoutes.set(canonicalTaskId, {
          source: "lan",
          taskId: responseTaskId,
          desktopId: route.desktopId,
          localRepoId,
          displayRepoId:
            provisionalRoute?.displayRepoId ??
            sourceTask?.repoId ??
            localRepoId
        });
        return {
          ...response,
          taskId: canonicalTaskId,
          ownerDesktopId: route.desktopId,
          ownerLocalRepoId: localRepoId,
          ownerLocalTaskId: responseTaskId,
          ...(resolvedTask
            ? {
                task: {
                  ...resolvedTask,
                  id: canonicalTaskId,
                  repoId:
                    provisionalRoute?.displayRepoId ??
                    sourceTask?.repoId ??
                    resolvedTask.repoId
                }
              }
            : {})
        };
      }
    }

    if (route.source === "lan") {
      provisionalTaskRoutes.set(responseTaskId, {
        source: "lan",
        taskId: responseTaskId,
        desktopId: route.desktopId
      });
    }
    return response;
  };

  const removeMatchingProvisionalRoutes = (
    desktopId: string,
    routedTaskId: string
  ) => {
    for (const [displayTaskId, route] of provisionalTaskRoutes) {
      if (
        route.source === "lan" &&
        route.desktopId === desktopId &&
        route.taskId === routedTaskId
      ) {
        provisionalTaskRoutes.delete(displayTaskId);
      }
    }
  };

  const listRepos = async (): Promise<RepoSummary[]> => {
    const readEpoch = ++latestRepoReadEpoch;
    const lanEnabled = options.isLanEnabled();
    const cloudRead = settleRead(() => cloud.listRepos());
    const lanRead = lanEnabled
      ? settleOptionalLanRead(
          readLanRepoSnapshot,
          optionalLanWaitMs,
          (lateSnapshot) => {
            if (
              readEpoch === latestRepoReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanRepoSnapshot = lateSnapshot;
            }
          }
        )
      : null;
    const cachedTaskSnapshot =
      lastCloudTasks !== undefined || (lanEnabled && lastLanTaskSnapshot !== undefined)
        ? canonicalizeLanTaskRepoIds(
            mergeCloudAndLanTasks({
              cloudTasks: lastCloudTasks ?? [],
              lan: lanEnabled ? lastLanTaskSnapshot ?? null : null,
              lanAuthoritative: false
            })
          ).tasks
        : null;
    const tasksRead: Promise<SettledRead<TaskSummary[]>> = cachedTaskSnapshot
      ? Promise.resolve({ status: "fulfilled", value: cachedTaskSnapshot })
      : settleRead(() => listRecentTasks());
    const cloudResult = await cloudRead;
    const lanResult = lanRead ? await lanRead : null;
    const tasksResult = await tasksRead;
    const isLatestRead = readEpoch === latestRepoReadEpoch;
    const lanStillEnabled = lanEnabled && options.isLanEnabled();

    if (isLatestRead && cloudResult.status === "fulfilled") {
      lastCloudRepos = cloudResult.value;
    }
    if (
      isLatestRead &&
      lanStillEnabled &&
      lanResult?.status === "fulfilled"
    ) {
      lastLanRepoSnapshot = lanResult.value;
    }

    const cloudRepos =
      cloudResult.status === "fulfilled" ? cloudResult.value : lastCloudRepos;
    const fallbackLanRepoSnapshot = lastLanRepoSnapshot;
    const lanRepos = lanStillEnabled
      ? lanResult?.status === "fulfilled"
        ? lanResult.value.repos.map((repo) => ({
            ...repo,
            registeredDesktopIds: [lanResult.value.desktopId]
          }))
        : fallbackLanRepoSnapshot
          ? fallbackLanRepoSnapshot.repos.map((repo) => ({
              ...repo,
              registeredDesktopIds: [fallbackLanRepoSnapshot.desktopId]
            }))
          : undefined
      : undefined;
    const derivedRepos =
      tasksResult.status === "fulfilled"
        ? reposFromTasks(tasksResult.value)
        : undefined;
    const availableRepos = [cloudRepos, lanRepos, derivedRepos].filter(
      (repos): repos is RepoSummary[] => repos !== undefined
    );
    if (availableRepos.length === 0) {
      throw firstReadFailure(cloudResult, lanResult, tasksResult);
    }

    return mergeRepoSummaries(availableRepos.flat());
  };

  const listDesktops = async (): Promise<DesktopSummary[]> => {
    const readEpoch = ++latestDesktopReadEpoch;
    const lanEnabled = options.isLanEnabled();
    const cloudRead = settleRead(() => cloud.listDesktops());
    const lanRead = lanEnabled
      ? settleOptionalLanRead(
          readLanDesktops,
          optionalLanWaitMs,
          (lateDesktops) => {
            if (
              readEpoch === latestDesktopReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanDesktops = lateDesktops;
              reportDesktopSourceWarnings({ local: null });
              publishDesktopSources();
            }
          }
        )
      : null;
    const cloudResult = await cloudRead;
    const lanResult = lanRead ? await lanRead : null;
    const isLatestRead = readEpoch === latestDesktopReadEpoch;
    const lanStillEnabled = lanEnabled && options.isLanEnabled();

    if (
      lanStillEnabled &&
      lanResult?.status === "rejected" &&
      !(lanResult.reason instanceof OptionalLanReadInFlightError)
    ) {
      options.onLanReadUnavailable?.();
    }

    reportDesktopSourceWarnings({
      account: cloudResult.status === "fulfilled"
        ? null
        : readFailureMessage(cloudResult.reason),
      local: !lanStillEnabled
        ? null
        : lanResult?.status === "fulfilled"
          ? null
          : readFailureMessage(lanResult?.reason)
    });

    if (isLatestRead && cloudResult.status === "fulfilled") {
      lastCloudDesktops = cloudResult.value;
    }
    if (
      isLatestRead &&
      lanStillEnabled &&
      lanResult?.status === "fulfilled"
    ) {
      lastLanDesktops = lanResult.value;
    }
    if (isLatestRead) publishDesktopSources();

    const cloudDesktops =
      cloudResult.status === "fulfilled"
        ? cloudResult.value
        : lastCloudDesktops;
    const lanDesktops = lanStillEnabled
      ? lanResult?.status === "fulfilled"
        ? lanResult.value
        : lastLanDesktops
      : undefined;
    if (cloudDesktops === undefined && lanDesktops === undefined) {
      throw firstReadFailure(cloudResult, lanResult);
    }

    return mergeDesktops(cloudDesktops ?? [], lanDesktops ?? []);
  };

  const createTask = async (input: CreateTaskRequest) => {
    if (input.desktopId && options.isLanEnabled()) {
      let status = null;
      try {
        status = await lan.getStatus();
      } catch {
      }
      if (
        status?.state === "running" &&
        status.desktopId === input.desktopId &&
        options.isLanEnabled()
      ) {
        const destinationLan = lanClientForDesktop(status.desktopId);
        if (destinationLan) {
          const destinationRepos = await destinationLan.listRepos();
          rememberLanRepos({ desktopId: status.desktopId, repos: destinationRepos });
          const snapshotLocalRepoId = [
            ...(acceptedTaskSnapshot?.tasks ?? []),
            ...(lastCloudTasks ?? [])
          ].find(
            (task) =>
              task.repoId === input.repoId &&
              task.ownerDesktopId === status.desktopId &&
              task.ownerLocalRepoId
          )?.ownerLocalRepoId;
          const knownMember = [...lanRepoSnapshots.values()]
            .flat()
            .find((repo) => repo.id === input.repoId);
          const logicalRepoId = knownMember
            ? canonicalRepoId(knownMember)
            : input.repoId;
          const destinationRepo = destinationRepos.find(
            (repo) =>
              repo.id === snapshotLocalRepoId ||
              repo.id === input.repoId ||
              canonicalRepoId(repo) === logicalRepoId
          );
          if (!destinationRepo) {
            const knownRepo = [
              ...(lastCloudRepos ?? []),
              ...[...lanRepoSnapshots.values()].flat()
            ].find(
              (repo) =>
                repo.id === input.repoId ||
                canonicalRepoId(repo) === input.repoId
            );
            const desktopName = [
              ...(lastLanDesktops ?? []),
              ...(lastCloudDesktops ?? [])
            ].find((desktop) => desktop.id === status.desktopId)?.name ??
              status.desktopName;
            throw new RepoNotRegisteredError(
              knownRepo?.name ?? input.repoId,
              desktopName
            );
          }
          const localRepoId = destinationRepo.id;
          const createdTask = await destinationLan.createTask({
            ...input,
            repoId: localRepoId
          });
          const canonicalTaskId = buildCloudTaskId({
            ownerDesktopId: status.desktopId,
            localRepoId: createdTask.repoId,
            ownerLocalTaskId: createdTask.taskId
          });
          provisionalTaskRoutes.set(canonicalTaskId, {
            source: "lan",
            taskId: createdTask.taskId,
            desktopId: status.desktopId,
            localRepoId: createdTask.repoId,
            displayRepoId: input.repoId
          });
          return {
            ...createdTask,
            taskId: canonicalTaskId,
            repoId: input.repoId,
            ownerDesktopId: status.desktopId,
            ownerLocalRepoId: createdTask.repoId,
            ownerLocalTaskId: createdTask.taskId
          };
        }
      }
    }
    return cloud.createTask(input);
  };

  const abortTaskCreation: KannaClient["abortTaskCreation"] = async (input) => {
    if (options.isLanEnabled()) {
      const destinationLan = lanClientForDesktop(input.desktopId);
      if (destinationLan) {
        await destinationLan.abortTaskCreation(input);
        return;
      }
    }
    await cloud.abortTaskCreation(input);
  };

  return {
    getTaskRouteIdentity(taskId: string): string {
      const route = routeForTaskStream(taskId);
      if (route.source === "cloud") {
        return route.client.getTaskRouteIdentity?.(route.taskId) ??
          JSON.stringify(["cloud", route.taskId]);
      }
      if (route.source === "lan") {
        return JSON.stringify([
          "lan",
          route.desktopId,
          route.taskId
        ]);
      }
      return JSON.stringify([
        "unavailable",
        route.desktopId,
        route.taskId
      ]);
    },
    getStatus: () => cloud.getStatus(),
    listDesktops,
    listRepos,
    listRepoTasks: async (repoId) =>
      (await listRecentTasks()).filter((task) => task.repoId === repoId),
    listRepoCommands: async (repoId) => {
      const route = routeForRepo(repoId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      const catalog = await route.client.listRepoCommands(route.repoId);
      return { ...catalog, repoId };
    },
    runRepoCommand: async (repoId, commandId, catalogRevision) => {
      const route = routeForRepo(repoId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      const response = await route.client.runRepoCommand(
        route.repoId,
        commandId,
        catalogRevision
      );
      if (route.source !== "lan") {
        return response;
      }
      const canonicalTaskId = buildCloudTaskId({
        ownerDesktopId: route.desktopId,
        localRepoId: route.repoId,
        ownerLocalTaskId: response.taskId
      });
      provisionalTaskRoutes.set(canonicalTaskId, {
        source: "lan",
        taskId: response.taskId,
        desktopId: route.desktopId,
        localRepoId: route.repoId,
        displayRepoId: repoId
      });
      return {
        ...response,
        taskId: canonicalTaskId,
        ownerDesktopId: route.desktopId,
        ownerLocalRepoId: route.repoId,
        ownerLocalTaskId: response.taskId
      };
    },
    listRecentTasks,
    listRecentTasksWithSupplement,
    getTask: async (taskId) => {
      const route = routeForTask(taskId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      if (!route.client.getTask) {
        throw new Error("Task detail is not available from this client.");
      }

      const detail = await route.client.getTask(route.taskId);
      const displayTask = acceptedTaskSnapshot?.tasks.find(
        (candidate) => candidate.id === taskId
      );
      return {
        ...detail,
        id: taskId,
        repoId: displayTask?.repoId ?? detail.repoId,
        ownerDesktopId:
          displayTask?.ownerDesktopId ?? detail.ownerDesktopId,
        ownerLocalRepoId:
          displayTask?.ownerLocalRepoId ?? detail.ownerLocalRepoId,
        ownerLocalTaskId:
          displayTask?.ownerLocalTaskId ?? detail.ownerLocalTaskId
      };
    },
    searchTasks: async (query) => {
      const normalizedQuery = query.toLowerCase();
      return (await listRecentTasks()).filter(
        (task) =>
          task.title.toLowerCase().includes(normalizedQuery) ||
          task.waitingPromptSnippet?.toLowerCase().includes(normalizedQuery) === true
      );
    },
    createTask,
    abortTaskCreation,
    runMergeAgent: (taskId) =>
      invokeTaskActionRoute(taskId, (client, routedTaskId) =>
        client.runMergeAgent(routedTaskId)
      ),
    advanceTaskStage: (taskId) =>
      invokeTaskActionRoute(taskId, (client, routedTaskId) =>
        client.advanceTaskStage(routedTaskId)
      ),
    markTaskRead: (taskId, expectedActivityRevision) =>
      invokeTaskRoute(taskId, (client, routedTaskId) =>
        expectedActivityRevision === undefined
          ? client.markTaskRead(routedTaskId)
          : client.markTaskRead(routedTaskId, expectedActivityRevision)
      ),
    pinTask: (taskId) =>
      invokeTaskRoute(taskId, (client, routedTaskId) =>
        client.pinTask(routedTaskId)
      ),
    unpinTask: (taskId) =>
      invokeTaskRoute(taskId, (client, routedTaskId) =>
        client.unpinTask(routedTaskId)
      ),
    closeTask: async (taskId) => {
      const route = routeForTask(taskId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      await route.client.closeTask(route.taskId);
      if (route.source === "lan") {
        removeMatchingProvisionalRoutes(route.desktopId, route.taskId);
      }
    },
    sendTaskInput: (taskId, input) =>
      invokeTaskRoute(taskId, (client, routedTaskId) =>
        client.sendTaskInput(routedTaskId, input)
      ),
    readTaskFile: async (taskId, path): Promise<TaskFileContent> => {
      const route = routeForTask(taskId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      if (route.source === "lan") {
        if (route.cloudFallbackTaskId) {
          return cloud.readTaskFile(route.cloudFallbackTaskId, path);
        }
        throw new Error(
          `Task file preview for LAN-only task "${taskId}" requires an authenticated relay connection.`
        );
      }
      return route.client.readTaskFile(route.taskId, path);
    },
    resolveTaskFileMentions: async (
      taskId,
      mentions: readonly TaskFileMentionInput[]
    ): Promise<TaskFileMentionResolution> => {
      const route = routeForTask(taskId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      if (route.source === "lan") {
        if (route.cloudFallbackTaskId) {
          return cloud.resolveTaskFileMentions(
            route.cloudFallbackTaskId,
            mentions
          );
        }
        throw new Error(
          `Task file resolution for LAN-only task "${taskId}" requires an authenticated relay connection.`
        );
      }
      return route.client.resolveTaskFileMentions(route.taskId, mentions);
    },
    readTaskDiff: async (taskId, request): Promise<TaskDiffContent> => {
      const route = routeForTask(taskId);
      if (route.source === "unavailable") {
        throw new Error(route.message);
      }
      if (route.source === "lan") {
        try {
          return await route.client.readTaskDiff(route.taskId, request);
        } catch (error) {
          if (route.cloudFallbackTaskId) {
            return cloud.readTaskDiff(route.cloudFallbackTaskId, request);
          }
          throw error;
        }
      }
      return route.client.readTaskDiff(route.taskId, request);
    },
    observeTaskTerminal(
      taskId: string,
      listener: (event: TaskTerminalStreamEvent) => void
    ): TaskTerminalSubscription {
      const route = routeForTaskStream(taskId);
      if (route.source === "unavailable") {
        listener({ type: "error", taskId, message: route.message });
        return { close() {} };
      }
      return route.client.observeTaskTerminal(route.taskId, listener);
    },
    observeTaskAgent(
      taskId: string,
      listener: (event: TaskAgentStreamEvent) => void
    ): TaskAgentSubscription {
      const route = routeForTaskStream(taskId);
      if (route.source === "unavailable") {
        listener({ type: "error", taskId, message: route.message });
        return {
          close() {},
          sendInput() {},
          sendPermission() {},
          interrupt() {}
        };
      }
      return route.client.observeTaskAgent(route.taskId, listener);
    },
    observeTaskCompanion(
      taskId: string,
      listener: (event: TaskCompanionStreamEvent) => void
    ): TaskCompanionSubscription {
      const route = routeForTaskStream(taskId);
      if (route.source === "unavailable") {
        listener({
          type: "error",
          taskId,
          code: "desktop_unavailable",
          message: route.message
        });
        return { close() {}, sendEvent: () => false };
      }
      return route.client.observeTaskCompanion(route.taskId, (event) =>
        listener({ ...event, taskId })
      );
    }
  };
}

function reposFromTasks(tasks: TaskSummary[]): RepoSummary[] {
  return tasks.map((task) => ({
    id: task.repoId,
    name: task.repoName?.trim() || task.repoId,
    ...(task.ownerDesktopId
      ? { registeredDesktopIds: [task.ownerDesktopId] }
      : {})
  }));
}

function mergeDesktops(
  cloudDesktops: DesktopSummary[],
  lanDesktops: DesktopSummary[]
): DesktopSummary[] {
  const lanById = new Map(lanDesktops.map((desktop) => [desktop.id, desktop]));
  const usedLanIds = new Set<string>();
  const merged = cloudDesktops.map((cloudDesktop) => {
    const lanDesktop = lanById.get(cloudDesktop.id);
    if (!lanDesktop) {
      return cloudDesktop;
    }
    usedLanIds.add(lanDesktop.id);
    // The LAN read came straight from the machine; the cloud record is a
    // published snapshot that can lag it. Prefer the direct inventory, and keep
    // the published one when the LAN read carried none.
    const agentProviders =
      lanDesktop.agentProviders ?? cloudDesktop.agentProviders;
    return {
      ...cloudDesktop,
      online: cloudDesktop.online || lanDesktop.online,
      connectionMode: "both" as const,
      ...(agentProviders ? { agentProviders } : {})
    };
  });

  for (const lanDesktop of lanDesktops) {
    if (!usedLanIds.has(lanDesktop.id)) {
      merged.push(lanDesktop);
    }
  }
  return merged;
}

async function settleRead<T>(read: () => Promise<T>): Promise<SettledRead<T>> {
  try {
    return { status: "fulfilled", value: await read() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

interface SharedPendingRead<T> {
  promise: Promise<T>;
  started: boolean;
}

function shareWhilePending<T>(
  read: () => Promise<T>
): () => SharedPendingRead<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) {
      return { promise: inFlight, started: false };
    }

    let raw: Promise<T>;
    try {
      raw = Promise.resolve(read());
    } catch (error) {
      raw = Promise.reject(error);
    }
    let current!: Promise<T>;
    current = raw.finally(() => {
      if (inFlight === current) {
        inFlight = null;
      }
    });
    inFlight = current;
    return { promise: current, started: true };
  };
}

function settleOptionalLanRead<T>(
  read: () => SharedPendingRead<T>,
  waitMs: number,
  onLateFulfilled: (value: T) => void
): Promise<SettledRead<T>> {
  const pendingRead = read();
  if (!pendingRead.started) {
    return Promise.resolve({
      status: "rejected",
      reason: new OptionalLanReadInFlightError(
        "Optional LAN read is already in flight."
      )
    });
  }

  const settledRead = settleRead(() => pendingRead.promise);
  return new Promise((resolve) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      resolve({
        status: "rejected",
        reason: new Error(`Optional LAN read timed out after ${waitMs}ms.`)
      });
    }, waitMs);

    void settledRead.then((result) => {
      if (timedOut) {
        if (result.status === "fulfilled") {
          onLateFulfilled(result.value);
        }
        return;
      }
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function normalizeOptionalLanWaitMs(waitMs: number | undefined): number {
  if (waitMs === undefined || !Number.isFinite(waitMs)) {
    return DEFAULT_OPTIONAL_LAN_WAIT_MS;
  }
  return Math.max(0, waitMs);
}

function readFailureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason ?? "Unknown source error");
}

function firstReadFailure(
  ...results: Array<SettledRead<unknown> | null>
): unknown {
  for (const result of results) {
    if (result?.status === "rejected") {
      return result.reason;
    }
  }
  return new Error("No cloud or LAN snapshot is available.");
}
