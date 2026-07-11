import type {
  KannaClient,
  TaskAgentStreamEvent,
  TaskAgentSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../api/client";
import type {
  CreateTaskRequest,
  DesktopSummary,
  RepoSummary,
  TaskActionResponse,
  TaskSummary
} from "../api/types";

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
  lanClientForDesktop?(desktopId: string): KannaClient | null;
  optionalLanWaitMs?: number;
}

export interface LanTaskSnapshot {
  desktopId: string;
  tasks: TaskSummary[];
}

export interface MergedTaskSnapshot {
  tasks: TaskSummary[];
  routes: Map<string, DisplayTaskRoute>;
}

export interface CloudLanClient extends KannaClient {
  listCurrentCloudTasks(): Promise<TaskSummary[]>;
  listRecentTasksWithSupplement(
    onSupplement: (tasks: TaskSummary[]) => void
  ): Promise<TaskSummary[]>;
}

type SettledRead<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

const DEFAULT_OPTIONAL_LAN_WAIT_MS = 1_000;

export function mergeCloudAndLanTasks({
  cloudTasks,
  lan,
  lanAuthoritative = true
}: {
  cloudTasks: TaskSummary[];
  lan: LanTaskSnapshot | null;
  lanAuthoritative?: boolean;
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
      if (lanTask.snippet !== null && lanTask.snippet !== undefined) {
        mergedTask.snippet = lanTask.snippet;
      }
      if (lanTask.agentType !== null && lanTask.agentType !== undefined) {
        mergedTask.agentType = lanTask.agentType;
      }
      tasks.push(mergedTask);
      usedDisplayTaskIds.add(cloudTask.id);
      routes.set(
        cloudTask.id,
        lanAuthoritative
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
  let latestRepoReadEpoch = 0;
  let latestDesktopReadEpoch = 0;
  let snapshotTaskRoutes = new Map<string, DisplayTaskRoute>();
  const provisionalTaskRoutes = new Map<string, DisplayTaskRoute>();
  let lastCloudTasks: TaskSummary[] | undefined;
  let lastLanTaskSnapshot: LanTaskSnapshot | undefined;
  let lastCloudRepos: RepoSummary[] | undefined;
  let lastLanRepos: RepoSummary[] | undefined;
  let lastCloudDesktops: DesktopSummary[] | undefined;
  let lastLanDesktops: DesktopSummary[] | undefined;

  const acceptMergedTaskSnapshot = (
    readEpoch: number,
    merged: MergedTaskSnapshot
  ) => {
    if (readEpoch !== latestReadEpoch) {
      return;
    }
    snapshotTaskRoutes = merged.routes;
    for (const [displayTaskId, provisionalRoute] of provisionalTaskRoutes) {
      const isPublished = Array.from(merged.routes.values()).some(
        (route) =>
          route.source === "lan" &&
          provisionalRoute.source === "lan" &&
          route.desktopId === provisionalRoute.desktopId &&
          route.taskId === provisionalRoute.taskId
      );
      if (isPublished) {
        provisionalTaskRoutes.delete(displayTaskId);
      }
    }
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
    return {
      desktopId: status.desktopId,
      tasks: await desktopLan.listRecentTasks()
    };
  };

  const readRecentTasks = async (
    onSupplement?: (tasks: TaskSummary[]) => void
  ): Promise<TaskSummary[]> => {
    const readEpoch = ++latestReadEpoch;
    const lanEnabled = options.isLanEnabled();
    let cloudTasksForRead: TaskSummary[] | undefined;
    const cloudRead = settleRead(() => cloud.listRecentTasks());
    const lanRead = lanEnabled
      ? settleOptionalLanRead(
          loadLanTaskSnapshot,
          optionalLanWaitMs,
          (lateSnapshot) => {
            if (
              readEpoch === latestReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanTaskSnapshot = lateSnapshot;
              if (onSupplement) {
                const merged = mergeCloudAndLanTasks({
                  cloudTasks: cloudTasksForRead ?? lastCloudTasks ?? [],
                  lan: lateSnapshot
                });
                acceptMergedTaskSnapshot(readEpoch, merged);
                onSupplement(merged.tasks);
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
    const lanStillEnabled = lanEnabled && options.isLanEnabled();

    if (isLatestRead && cloudResult.status === "fulfilled") {
      lastCloudTasks = cloudResult.value;
    }
    if (
      isLatestRead &&
      lanStillEnabled &&
      lanResult?.status === "fulfilled"
    ) {
      lastLanTaskSnapshot = lanResult.value;
    }

    const cloudTasks =
      cloudResult.status === "fulfilled"
        ? cloudResult.value
        : lastCloudTasks;
    const currentLanSnapshot =
      lanResult?.status === "fulfilled" ? lanResult.value : undefined;
    const lanSnapshot = lanStillEnabled
      ? currentLanSnapshot ?? lastLanTaskSnapshot
      : undefined;

    if (cloudTasks === undefined && lanSnapshot === undefined) {
      throw firstReadFailure(cloudResult, lanResult);
    }

    const merged = mergeCloudAndLanTasks({
      cloudTasks: cloudTasks ?? [],
      lan: lanSnapshot ?? null,
      lanAuthoritative: currentLanSnapshot !== undefined
    });

    if (isLatestRead) acceptMergedTaskSnapshot(readEpoch, merged);
    return merged.tasks;
  };

  const listRecentTasks = (): Promise<TaskSummary[]> => readRecentTasks();

  const listCurrentCloudTasks = async (): Promise<TaskSummary[]> => {
    const readEpoch = ++latestReadEpoch;
    const cloudTasks = await cloud.listRecentTasks();
    const merged = mergeCloudAndLanTasks({ cloudTasks, lan: null });
    if (readEpoch === latestReadEpoch) {
      lastCloudTasks = cloudTasks;
      acceptMergedTaskSnapshot(readEpoch, merged);
    }
    return merged.tasks;
  };

  type ResolvedTaskRoute =
    | { source: "cloud"; taskId: string; client: KannaClient }
    | {
        source: "lan";
        taskId: string;
        desktopId: string;
        client: KannaClient;
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

    provisionalTaskRoutes.set(
      responseTaskId,
      route.source === "lan"
        ? {
            source: "lan",
            taskId: responseTaskId,
            desktopId: route.desktopId
          }
        : { source: "cloud", taskId: responseTaskId }
    );
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
          () => lan.listRepos(),
          optionalLanWaitMs,
          (lateRepos) => {
            if (
              readEpoch === latestRepoReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanRepos = lateRepos;
            }
          }
        )
      : null;
    const cachedTaskSnapshot =
      lastCloudTasks !== undefined || (lanEnabled && lastLanTaskSnapshot !== undefined)
        ? mergeCloudAndLanTasks({
            cloudTasks: lastCloudTasks ?? [],
            lan: lanEnabled ? lastLanTaskSnapshot ?? null : null,
            lanAuthoritative: false
          }).tasks
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
      lastLanRepos = lanResult.value;
    }

    const cloudRepos =
      cloudResult.status === "fulfilled" ? cloudResult.value : lastCloudRepos;
    const lanRepos = lanStillEnabled
      ? lanResult?.status === "fulfilled"
        ? lanResult.value
        : lastLanRepos
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

    return mergeRepos(availableRepos.flat());
  };

  const listDesktops = async (): Promise<DesktopSummary[]> => {
    const readEpoch = ++latestDesktopReadEpoch;
    const lanEnabled = options.isLanEnabled();
    const cloudRead = settleRead(() => cloud.listDesktops());
    const lanRead = lanEnabled
      ? settleOptionalLanRead(
          () => lan.listDesktops(),
          optionalLanWaitMs,
          (lateDesktops) => {
            if (
              readEpoch === latestDesktopReadEpoch &&
              options.isLanEnabled()
            ) {
              lastLanDesktops = lateDesktops;
            }
          }
        )
      : null;
    const cloudResult = await cloudRead;
    const lanResult = lanRead ? await lanRead : null;
    const isLatestRead = readEpoch === latestDesktopReadEpoch;
    const lanStillEnabled = lanEnabled && options.isLanEnabled();

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
          const createdTask = await destinationLan.createTask(input);
          provisionalTaskRoutes.set(createdTask.taskId, {
            source: "lan",
            taskId: createdTask.taskId,
            desktopId: status.desktopId
          });
          return createdTask;
        }
      }
    }
    return cloud.createTask(input);
  };

  return {
    getStatus: () => cloud.getStatus(),
    listDesktops,
    listRepos,
    listRepoTasks: async (repoId) =>
      (await listRecentTasks()).filter((task) => task.repoId === repoId),
    listRecentTasks,
    listRecentTasksWithSupplement: (onSupplement) =>
      readRecentTasks(onSupplement),
    listCurrentCloudTasks,
    searchTasks: async (query) => {
      const normalizedQuery = query.toLowerCase();
      return (await listRecentTasks()).filter(
        (task) =>
          task.title.toLowerCase().includes(normalizedQuery) ||
          task.snippet?.toLowerCase().includes(normalizedQuery) === true
      );
    },
    createTask,
    runMergeAgent: (taskId) =>
      invokeTaskActionRoute(taskId, (client, routedTaskId) =>
        client.runMergeAgent(routedTaskId)
      ),
    advanceTaskStage: (taskId) =>
      invokeTaskActionRoute(taskId, (client, routedTaskId) =>
        client.advanceTaskStage(routedTaskId)
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
    observeTaskTerminal(
      taskId: string,
      listener: (event: TaskTerminalStreamEvent) => void
    ): TaskTerminalSubscription {
      const route = routeForTask(taskId);
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
      const route = routeForTask(taskId);
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
    createPairingSession: () => lan.createPairingSession()
  };
}

function reposFromTasks(tasks: TaskSummary[]): RepoSummary[] {
  return tasks.map((task) => ({
    id: task.repoId,
    name: task.repoName?.trim() || task.repoId
  }));
}

function mergeRepos(repos: RepoSummary[]): RepoSummary[] {
  const reposById = new Map<string, RepoSummary>();
  for (const repo of repos) {
    if (!reposById.has(repo.id)) {
      reposById.set(repo.id, repo);
    }
  }
  return Array.from(reposById.values());
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
    return {
      ...cloudDesktop,
      online: cloudDesktop.online || lanDesktop.online,
      connectionMode: "both" as const
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

function settleOptionalLanRead<T>(
  read: () => Promise<T>,
  waitMs: number,
  onLateFulfilled: (value: T) => void
): Promise<SettledRead<T>> {
  const settledRead = settleRead(read);
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
