import type { AgentProvider } from "@kanna/agent-protocol";
import type {
  KannaTransport,
  TaskAgentStreamEvent,
  TaskAgentSubscription,
  TaskCompanionStreamEvent,
  TaskCompanionSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription,
  TaskSummaryStreamEvent,
  TaskSummarySubscription,
} from "../api/client";
import { RepoNotRegisteredError } from "../api/client";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  DesktopSummary,
  MobileServerStatus,
  RepoSummary,
  RepoCheckoutOperation,
  RepoDirectoryListing,
  RepoFileRange,
  RepoCommandCatalog,
  RunRepoCommandResponse,
  TaskActionResponse,
  TaskActivityResponse,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskInputAttachment,
  TaskDetail,
  TaskSummary,
  WritePathHealth,
} from "../api/types";
import {
  buildCloudTaskId,
  canonicalizeTaskActionId,
} from "../api/taskIdentity";
import {
  canonicalRepoId,
  isRemoteRepoId,
  mergeRepoSummaries
} from "../api/repoIdentity";
import { buildTaskDiffQuery } from "./lanTransport";

export interface RemoteDesktopRecord {
  desktopId: string;
  displayName: string;
  online: boolean;
  reachableViaRelay: boolean;
  connectionMode: "lan" | "internet" | "both";
  lastSeenAt?: string | null;
  /** Agent provider CLIs the desktop published. Absent from desktops that
   * predate provider inventory publication. */
  agentProviders?: AgentProvider[];
}

export interface RemoteDesktopInvocationRequest {
  desktopId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: unknown | null;
}

export type RemoteDesktopInvoker = (
  request: RemoteDesktopInvocationRequest
) => Promise<unknown>;

export type RemoteTaskTerminalObserver = (
  request: { desktopId: string; taskId: string },
  listener: (event: TaskTerminalStreamEvent) => void
) => TaskTerminalSubscription;

export type RemoteTaskAgentObserver = (
  request: { desktopId: string; taskId: string },
  listener: (event: TaskAgentStreamEvent) => void
) => TaskAgentSubscription;

export type RemoteTaskCompanionObserver = (
  request: { desktopId: string; taskId: string },
  listener: (event: TaskCompanionStreamEvent) => void
) => TaskCompanionSubscription;

export type RemoteTransportErrorCode =
  | "no_selected_desktop"
  | "remote_invocation_failed"
  | "invalid_status_response";

export class RemoteTransportError extends Error {
  readonly code: RemoteTransportErrorCode;
  readonly cause: unknown;

  constructor(
    code: RemoteTransportErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "RemoteTransportError";
    this.code = code;
    this.cause = cause;
  }
}

export interface RemoteTransportDependencies {
  listDesktopRecords(): Promise<RemoteDesktopRecord[]>;
  getSelectedDesktopId(): string | null;
  invokeDesktop: RemoteDesktopInvoker;
  observeTaskTerminal?: RemoteTaskTerminalObserver;
  observeTaskAgent?: RemoteTaskAgentObserver;
  observeTaskCompanion?: RemoteTaskCompanionObserver;
  observeDesktopTaskSummaries?: (
    desktopId: string,
    listener: (event: TaskSummaryStreamEvent) => void
  ) => TaskSummarySubscription;
  listCloudTasks?: () => Promise<CloudIndexedTaskSummary[]>;
  desktopRepoWaitMs?: number;
  desktopRepoRefreshIntervalMs?: number;
}

interface CloudTaskRoute {
  desktopId: string;
  repoId?: string;
  localRepoId?: string;
  taskId: string;
}

interface CloudRepoRoute {
  desktopId: string;
  localRepoId: string;
}

type CloudIndexedTaskSummary = TaskSummary & {
  repoName?: string | null;
};

const DEFAULT_DESKTOP_REPO_WAIT_MS = 3_000;
const DEFAULT_DESKTOP_REPO_REFRESH_INTERVAL_MS = 30_000;

export function createRemoteTransport({
  listDesktopRecords,
  getSelectedDesktopId,
  invokeDesktop,
  observeTaskTerminal,
  observeTaskAgent,
  observeTaskCompanion,
  observeDesktopTaskSummaries,
  listCloudTasks,
  desktopRepoWaitMs = DEFAULT_DESKTOP_REPO_WAIT_MS,
  desktopRepoRefreshIntervalMs = DEFAULT_DESKTOP_REPO_REFRESH_INTERVAL_MS
}: RemoteTransportDependencies): KannaTransport {
  let cloudTaskRoutes = new Map<string, CloudTaskRoute>();
  const provisionalTaskRoutes = new Map<string, CloudTaskRoute>();
  let latestAcceptedCloudTasks: CloudIndexedTaskSummary[] = [];
  let latestCloudReadEpoch = 0;
  const cloudRepoOwners = new Map<string, CloudRepoRoute>();
  const desktopRepoSnapshots = new Map<string, RepoSummary[]>();
  const desktopRepoFetchedAt = new Map<string, number>();
  const desktopRepoReads = new Map<string, Promise<void>>();
  let latestDesktopRecords: RemoteDesktopRecord[] = [];

  const taskRouteForId = (taskId: string): CloudTaskRoute | null =>
    provisionalTaskRoutes.get(taskId) ?? cloudTaskRoutes.get(taskId) ?? null;
  const taskRouteIdentity = (route: CloudTaskRoute): string =>
    JSON.stringify([route.desktopId, route.taskId]);

  const rememberCloudTasks = <T extends TaskSummary>(
    tasks: T[],
    readEpoch: number
  ): T[] => {
    const nextRoutes = new Map<string, CloudTaskRoute>();
    const canonicalTaskIds = new Set<string>();
    const canonicalRouteIdentities = new Set<string>();
    for (const task of tasks) {
      canonicalTaskIds.add(task.id);
      if (isCloudTaskRoute(task)) {
        const route = {
          desktopId: task.ownerDesktopId,
          repoId: task.repoId,
          localRepoId: task.ownerLocalRepoId ?? task.repoId,
          taskId: task.ownerLocalTaskId
        };
        nextRoutes.set(task.id, route);
        canonicalRouteIdentities.add(taskRouteIdentity(route));
      }
    }
    if (readEpoch === latestCloudReadEpoch) {
      for (const [taskId, route] of provisionalTaskRoutes) {
        if (
          canonicalTaskIds.has(taskId) ||
          canonicalRouteIdentities.has(taskRouteIdentity(route))
        ) {
          provisionalTaskRoutes.delete(taskId);
        }
      }
      cloudTaskRoutes = nextRoutes;
      latestAcceptedCloudTasks = tasks;
    }
    return tasks;
  };

  const resolveCloudTaskRoute = async (
    taskId: string,
    refreshCloudRoute = false
  ): Promise<CloudTaskRoute | null> => {
    const cached = taskRouteForId(taskId);
    if (!listCloudTasks || (!refreshCloudRoute && cached)) {
      return cached;
    }

    await listFreshCloudTasks();
    return taskRouteForId(taskId);
  };

  const listFreshCloudTasks = async (): Promise<CloudIndexedTaskSummary[]> => {
    if (!listCloudTasks) {
      return [];
    }

    const readEpoch = ++latestCloudReadEpoch;
    return rememberCloudTasks(await listCloudTasks(), readEpoch);
  };

  const resolveCloudRepoRoute = async (
    repoId: string,
    requestedDesktopId?: string
  ): Promise<CloudRepoRoute | null> => {
    if (listCloudTasks) {
      await listFreshCloudTasks();
    } else if (!requestedDesktopId) {
      return null;
    }
    const routeTask = latestAcceptedCloudTasks.find(
      (
        task
      ): task is CloudIndexedTaskSummary & {
        ownerDesktopId: string;
        ownerLocalTaskId: string;
      } =>
        task.repoId === repoId &&
        isCloudTaskRoute(task) &&
        (!requestedDesktopId || task.ownerDesktopId === requestedDesktopId)
    );
    if (requestedDesktopId) {
      if (
        !latestDesktopRecords.some(
          (desktop) => desktop.desktopId === requestedDesktopId
        )
      ) {
        try {
          latestDesktopRecords = await listDesktopRecords();
        } catch {
          // The destination repo read below remains authoritative for routing.
        }
      }
      await readDesktopRepos(requestedDesktopId);
      const logicalRepoId = logicalRepoIdFor(repoId);
      const hintedMember = routeTask?.ownerLocalRepoId
        ? desktopRepoSnapshots
            .get(requestedDesktopId)
            ?.find(
              (repo) =>
                repo.id === routeTask.ownerLocalRepoId &&
                (!isRemoteRepoId(logicalRepoId) ||
                  canonicalRepoId(repo) === logicalRepoId)
            )
        : undefined;
      const localRepoId =
        desktopLocalRepoId(requestedDesktopId, repoId) ?? hintedMember?.id;
      if (!localRepoId) {
        throw new RepoNotRegisteredError(
          repoDisplayName(repoId),
          desktopDisplayName(requestedDesktopId)
        );
      }
      return { desktopId: requestedDesktopId, localRepoId };
    }
    const inventoryRoute = cloudRepoOwners.get(repoId);
    if (inventoryRoute) {
      return inventoryRoute;
    }
    if (routeTask) {
      return {
        desktopId: routeTask.ownerDesktopId,
        localRepoId: routeTask.ownerLocalRepoId ?? repoId
      };
    }
    if (!cloudRepoOwners.has(repoId)) {
      await listReachableDesktopRepos();
    }
    return cloudRepoOwners.get(repoId) ?? null;
  };

  const logicalRepoIdFor = (repoId: string): string => {
    const knownMember = [...desktopRepoSnapshots.values()]
      .flat()
      .find((repo) => repo.id === repoId);
    return isRemoteRepoId(repoId)
      ? repoId
      : knownMember
        ? canonicalRepoId(knownMember)
        : repoId;
  };

  const desktopLocalRepoId = (
    desktopId: string,
    repoId: string
  ): string | null => {
    const logicalRepoId = logicalRepoIdFor(repoId);
    const member = desktopRepoSnapshots
      .get(desktopId)
      ?.find(
        (repo) => repo.id === repoId || canonicalRepoId(repo) === logicalRepoId
      );
    return member?.id ?? null;
  };

  const repoDisplayName = (repoId: string): string => {
    const member = [...desktopRepoSnapshots.values()]
      .flat()
      .find(
        (repo) => repo.id === repoId || canonicalRepoId(repo) === repoId
      );
    return member?.name ??
      latestAcceptedCloudTasks.find((task) => task.repoId === repoId)?.repoName?.trim() ??
      repoId;
  };

  const desktopDisplayName = (desktopId: string): string =>
    latestDesktopRecords.find((desktop) => desktop.desktopId === desktopId)
      ?.displayName ?? desktopId;

  const requestDesktop = async <T>(
    desktopId: string,
    method: RemoteDesktopInvocationRequest["method"],
    path: string,
    body: unknown | null
  ): Promise<T> => {
    try {
      return (await invokeDesktop({
        desktopId,
        method,
        path,
        body
      })) as T;
    } catch (error) {
      if (error instanceof RemoteTransportError) {
        throw error;
      }

      throw new RemoteTransportError(
        "remote_invocation_failed",
        `Remote desktop request failed: ${formatErrorMessage(error)}`,
        error
      );
    }
  };

  const rememberDesktopRepos = (desktopId: string, repos: RepoSummary[]) => {
    forgetDesktopRepos(desktopId);
    desktopRepoSnapshots.set(desktopId, repos);
    for (const repo of repos) {
      cloudRepoOwners.set(canonicalRepoId(repo), {
        desktopId,
        localRepoId: repo.id
      });
    }
  };

  const readDesktopRepos = async (desktopId: string): Promise<void> => {
    const repos = parseRepoSummaries(
      await requestDesktop<unknown>(desktopId, "GET", "/v1/repos", null)
    );
    rememberDesktopRepos(desktopId, repos);
    desktopRepoFetchedAt.set(desktopId, Date.now());
  };

  const forgetDesktopRepos = (desktopId: string) => {
    desktopRepoSnapshots.delete(desktopId);
    desktopRepoFetchedAt.delete(desktopId);
    for (const [repoId, owner] of cloudRepoOwners) {
      if (owner.desktopId === desktopId) {
        cloudRepoOwners.delete(repoId);
      }
    }
  };

  const startDesktopRepoRead = (desktopId: string): Promise<void> => {
    const inFlight = desktopRepoReads.get(desktopId);
    if (inFlight) {
      return inFlight;
    }
    const read = (async () => {
      try {
        await readDesktopRepos(desktopId);
      } catch {
        // Keep the last snapshot for this desktop; a transiently
        // unreachable desktop's repos still merge from the cache below.
      } finally {
        desktopRepoFetchedAt.set(desktopId, Date.now());
      }
    })().finally(() => {
      if (desktopRepoReads.get(desktopId) === read) {
        desktopRepoReads.delete(desktopId);
      }
    });
    desktopRepoReads.set(desktopId, read);
    return read;
  };

  const refreshDesktopRepos = async (): Promise<void> => {
    let records: RemoteDesktopRecord[];
    try {
      records = await listDesktopRecords();
    } catch {
      return;
    }
    latestDesktopRecords = records;
    const recordIds = new Set(records.map((record) => record.desktopId));
    for (const desktopId of [...desktopRepoSnapshots.keys()]) {
      if (!recordIds.has(desktopId)) {
        forgetDesktopRepos(desktopId);
      }
    }
    const now = Date.now();
    await Promise.all(
      records
        .filter((record) => record.reachableViaRelay || record.online)
        .filter((record) => {
          if (desktopRepoReads.has(record.desktopId)) {
            return true;
          }
          const fetchedAt = desktopRepoFetchedAt.get(record.desktopId);
          return (
            fetchedAt === undefined ||
            now - fetchedAt >= desktopRepoRefreshIntervalMs
          );
        })
        .map((record) => startDesktopRepoRead(record.desktopId))
    );
  };

  // The cloud task index only carries repos that have open tasks, so repo
  // listings additionally ask each reachable desktop for its full repo list
  // through the relay. Every listing runs its own records pass so a desktop
  // that becomes reachable later is fetched immediately; in-flight reads are
  // tracked per desktop, so one hung desktop can neither trigger duplicate
  // invocations nor block newly reachable desktops from being queried. The
  // refresh interval throttles per fetched desktop, never a no-op pass.
  // Reads that outlast the wait window finish in the background and land in
  // the snapshot cache for the next listing.
  const listReachableDesktopRepos = (): Promise<RepoSummary[]> => {
    const collectDesktopRepos = () =>
      [...desktopRepoSnapshots.entries()].flatMap(([desktopId, repos]) =>
        repos.map((repo) => ({
          ...repo,
          registeredDesktopIds: [desktopId]
        }))
      );
    return awaitWithFallback(
      refreshDesktopRepos().then(collectDesktopRepos),
      desktopRepoWaitMs,
      collectDesktopRepos
    );
  };

  const request = async <T>(
    method: RemoteDesktopInvocationRequest["method"],
    path: string,
    body: unknown | null
  ): Promise<T> => {
    const response = await invokeSelectedDesktop({
      getSelectedDesktopId,
      invokeDesktop,
      method,
      path,
      body
    });
    return response as T;
  };

  const requestTask = async <T>(
    taskId: string,
    method: RemoteDesktopInvocationRequest["method"],
    buildPath: (localTaskId: string) => string,
    body: unknown | null,
    refreshCloudRoute = false
  ): Promise<T> => {
    const route = await resolveCloudTaskRoute(taskId, refreshCloudRoute);
    if (route) {
      return requestDesktop<T>(
        route.desktopId,
        method,
        buildPath(route.taskId),
        body
      );
    }

    return request<T>(method, buildPath(taskId), body);
  };

  const requestTaskAction = async (
    taskId: string,
    buildPath: (localTaskId: string) => string
  ): Promise<TaskActionResponse> => {
    const route = await resolveCloudTaskRoute(taskId);
    if (!route) {
      return request<TaskActionResponse>("POST", buildPath(taskId), null);
    }

    const response = await requestDesktop<TaskActionResponse>(
      route.desktopId,
      "POST",
      buildPath(route.taskId),
      null
    );
    const responseTaskId = (
      response as TaskActionResponse | null | undefined
    )?.taskId;
    if (typeof responseTaskId !== "string") {
      return response;
    }
    if (responseTaskId === route.taskId) {
      return { ...response, taskId };
    }

    if (route.localRepoId) {
      const canonicalTaskId = canonicalizeTaskActionId({
        canonicalTaskId: taskId,
        ownerDesktopId: route.desktopId,
        localRepoId: route.localRepoId,
        sourceLocalTaskId: route.taskId,
        responseLocalTaskId: responseTaskId
      });
      const resolvedTask = await requestDesktop<TaskSummary[]>(
        route.desktopId,
        "GET",
        "/v1/tasks/recent",
        null
      )
        .then((tasks) =>
          Array.isArray(tasks)
            ? tasks.find(
                (candidate) =>
                  candidate.id === responseTaskId &&
                  candidate.repoId === route.localRepoId
              )
            : undefined
        )
        .catch(() => undefined);
      provisionalTaskRoutes.set(canonicalTaskId, {
        desktopId: route.desktopId,
        repoId: route.repoId,
        localRepoId: route.localRepoId,
        taskId: responseTaskId
      });
      return {
        ...response,
        taskId: canonicalTaskId,
        ownerDesktopId: route.desktopId,
        ownerLocalRepoId: route.localRepoId,
        ownerLocalTaskId: responseTaskId,
        ...(resolvedTask
          ? {
              task: {
                ...resolvedTask,
                id: canonicalTaskId,
                repoId: route.repoId ?? resolvedTask.repoId
              }
            }
          : {})
      };
    }

    provisionalTaskRoutes.set(responseTaskId, {
      desktopId: route.desktopId,
      repoId: route.repoId,
      localRepoId: route.localRepoId,
      taskId: responseTaskId
    });
    return response;
  };

  return {
    ...(observeDesktopTaskSummaries ? { observeDesktopTaskSummaries } : {}),
    getTaskRouteIdentity(taskId: string): string {
      const route = taskRouteForId(taskId);
      return JSON.stringify([
        "remote",
        route?.desktopId ?? getSelectedDesktopId(),
        route?.taskId ?? taskId
      ]);
    },
    async getStatus(): Promise<MobileServerStatus> {
      if (listCloudTasks) {
        return {
          state: "running",
          desktopId: "cloud",
          desktopName: "Kanna Cloud",
          version: "cloud",
          environment: "production",
          serverVersion: "cloud",
          lanHost: "cloud",
          lanPort: 0,
          pairingCode: null,
          writePathHealth: {
            healthy: true,
            status: "healthy",
            activeWorkspaceCommands: 0,
            maxWorkspaceCommands: 0,
            longRunningWorkspaceCommands: 0,
            oldestWorkspaceCommandSeconds: null
          }
        };
      }
      return mapMobileServerStatus(await request("GET", "/v1/status", null));
    },
    async listDesktops(): Promise<DesktopSummary[]> {
      const records = await listDesktopRecords();
      latestDesktopRecords = records;
      return records.map((record) => ({
        id: record.desktopId,
        name: record.displayName,
        online: record.online,
        mode: "remote",
        reachableViaRelay: record.reachableViaRelay,
        connectionMode: record.connectionMode,
        lastSeenAt: record.lastSeenAt ?? null,
        ...(record.agentProviders
          ? { agentProviders: record.agentProviders }
          : {}),
      }));
    },
    listRepos: async () => {
      if (!listCloudTasks) {
        return request<RepoSummary[]>("GET", "/v1/repos", null);
      }
      const [tasks, desktopRepos] = await Promise.all([
        listFreshCloudTasks(),
        listReachableDesktopRepos()
      ]);
      const taskRepos = new Map<string, RepoSummary>();
      for (const task of tasks) {
        if (!taskRepos.has(task.repoId)) {
          taskRepos.set(task.repoId, {
            id: task.repoId,
            name: task.repoName?.trim() || task.repoId,
            ...(task.ownerDesktopId
              ? { registeredDesktopIds: [task.ownerDesktopId] }
              : {})
          });
        }
      }
      return mergeRepoSummaries([...taskRepos.values(), ...desktopRepos]);
    },
    startRepoCheckout: async ({ desktopId, ...input }) =>
      requestDesktop<RepoCheckoutOperation>(
        desktopId,
        "POST",
        "/v1/repo-checkouts",
        input
      ),
    getRepoCheckout: async (desktopId, operationId) => {
      const operation = await requestDesktop<RepoCheckoutOperation>(
        desktopId,
        "GET",
        `/v1/repo-checkouts/${encodeURIComponent(operationId)}`,
        null
      );
      if (operation.state === "done") {
        await readDesktopRepos(desktopId);
      }
      return operation;
    },
    listRepoTasks: async (repoId: string) => {
      if (listCloudTasks) {
        return (await listFreshCloudTasks()).filter(
          (task) => task.repoId === repoId
        );
      }
      return request<TaskSummary[]>(
        "GET",
        `/v1/repos/${encodeURIComponent(repoId)}/tasks`,
        null
      );
    },
    listRepoCommands: async (repoId: string) => {
      const repoRoute = await resolveCloudRepoRoute(repoId);
      if (!repoRoute) {
        return request<RepoCommandCatalog>(
          "GET",
          `/v1/repos/${encodeURIComponent(repoId)}/commands`,
          null
        );
      }
      const catalog = await requestDesktop<RepoCommandCatalog>(
        repoRoute.desktopId,
        "GET",
        `/v1/repos/${encodeURIComponent(repoRoute.localRepoId)}/commands`,
        null
      );
      return { ...catalog, repoId };
    },
    runRepoCommand: async (repoId, commandId, catalogRevision) => {
      const repoRoute = await resolveCloudRepoRoute(repoId);
      const path = (localRepoId: string) =>
        `/v1/repos/${encodeURIComponent(localRepoId)}/commands/${encodeURIComponent(commandId)}/run`;
      if (!repoRoute) {
        return request<RunRepoCommandResponse>(
          "POST",
          path(repoId),
          { catalogRevision }
        );
      }
      const response = await requestDesktop<RunRepoCommandResponse>(
        repoRoute.desktopId,
        "POST",
        path(repoRoute.localRepoId),
        { catalogRevision }
      );
      if (!listCloudTasks) {
        return response;
      }
      const ownerDesktopId = response.ownerDesktopId ?? repoRoute.desktopId;
      const ownerLocalRepoId = response.ownerLocalRepoId ?? repoRoute.localRepoId;
      const ownerLocalTaskId = response.ownerLocalTaskId ?? response.taskId;
      const canonicalTaskId = buildCloudTaskId({
        ownerDesktopId,
        localRepoId: ownerLocalRepoId,
        ownerLocalTaskId
      });
      provisionalTaskRoutes.set(canonicalTaskId, {
        desktopId: ownerDesktopId,
        repoId,
        localRepoId: ownerLocalRepoId,
        taskId: ownerLocalTaskId
      });
      return {
        ...response,
        taskId: canonicalTaskId,
        ownerDesktopId,
        ownerLocalRepoId,
        ownerLocalTaskId
      };
    },
    listRecentTasks: () =>
      listCloudTasks
        ? listFreshCloudTasks()
        : request<TaskSummary[]>("GET", "/v1/tasks/recent", null),
    getTask: async (taskId: string) => {
      const route = await resolveCloudTaskRoute(taskId);
      if (!route) {
        return request<TaskDetail>(
          "GET",
          `/v1/tasks/${encodeURIComponent(taskId)}`,
          null
        );
      }

      const detail = await requestDesktop<TaskDetail>(
        route.desktopId,
        "GET",
        `/v1/tasks/${encodeURIComponent(route.taskId)}`,
        null
      );
      return {
        ...detail,
        id: taskId,
        repoId: route.repoId ?? detail.repoId,
        ownerDesktopId: route.desktopId,
        ownerLocalRepoId: route.localRepoId ?? detail.repoId,
        ownerLocalTaskId: route.taskId
      };
    },
    searchTasks: async (query) => {
      if (listCloudTasks) {
        const normalizedQuery = query.toLowerCase();
        return (await listFreshCloudTasks()).filter(
          (task) =>
            task.title.toLowerCase().includes(normalizedQuery) ||
            task.waitingPromptSnippet?.toLowerCase().includes(normalizedQuery) === true
        );
      }
      return request<TaskSummary[]>(
        "GET",
        `/v1/tasks/search?query=${encodeURIComponent(query)}`,
        null
      );
    },
    createTask: async (input: CreateTaskRequest) => {
      const {
        desktopId: requestedDesktopId,
        taskId,
        ...taskInput
      } = input;
      const hasTaskId = taskId !== undefined;
      const method = hasTaskId ? "PUT" : "POST";
      const path = hasTaskId
        ? `/v1/tasks/${encodeURIComponent(taskId)}`
        : "/v1/tasks";
      const repoRoute = await resolveCloudRepoRoute(
        input.repoId,
        requestedDesktopId
      );
      if (repoRoute) {
        const created = await requestDesktop<CreateTaskResponse>(
          repoRoute.desktopId,
          method,
          path,
          { ...taskInput, repoId: repoRoute.localRepoId }
        );
        if (!listCloudTasks) {
          provisionalTaskRoutes.set(created.taskId, {
            desktopId: repoRoute.desktopId,
            taskId: created.taskId
          });
          return created;
        }
        const canonicalTaskId = buildCloudTaskId({
          ownerDesktopId: repoRoute.desktopId,
          localRepoId: repoRoute.localRepoId,
          ownerLocalTaskId: created.taskId
        });
        provisionalTaskRoutes.set(canonicalTaskId, {
          desktopId: repoRoute.desktopId,
          repoId: input.repoId,
          localRepoId: repoRoute.localRepoId,
          taskId: created.taskId
        });
        return {
          ...created,
          taskId: canonicalTaskId,
          repoId: input.repoId,
          ownerDesktopId: repoRoute.desktopId,
          ownerLocalRepoId: repoRoute.localRepoId,
          ownerLocalTaskId: created.taskId
        };
      }

      return request<CreateTaskResponse>(method, path, taskInput);
    },
    abortTaskCreation: ({ taskId, desktopId }) =>
      requestDesktop<void>(
        desktopId,
        "POST",
        `/v1/tasks/${encodeURIComponent(taskId)}/actions/abort-creation`,
        null
      ),
    runMergeAgent: (taskId: string) =>
      requestTaskAction(
        taskId,
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/actions/run-merge-agent`
      ),
    advanceTaskStage: (taskId: string) =>
      requestTaskAction(
        taskId,
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/actions/advance-stage`
      ),
    markTaskRead: (taskId: string, expectedActivityRevision?: number) =>
      requestTask<TaskActivityResponse>(
        taskId,
        "POST",
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/actions/mark-read`,
        expectedActivityRevision === undefined
          ? null
          : { expectedActivityRevision },
        true
      ),
    closeTask: async (taskId: string) => {
      const closingRoute = taskRouteForId(taskId);
      await requestTask<void>(
        taskId,
        "POST",
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/actions/close`,
        null
      );
      for (const [provisionalTaskId, route] of provisionalTaskRoutes) {
        if (
          provisionalTaskId === taskId ||
          (closingRoute &&
            taskRouteIdentity(route) === taskRouteIdentity(closingRoute))
        ) {
          provisionalTaskRoutes.delete(provisionalTaskId);
        }
      }
    },
    sendTaskInput: async (
      taskId: string,
      input: string,
      attachment?: TaskInputAttachment
    ) => {
      await requestTask<void>(
        taskId,
        "POST",
        (localTaskId) => `/v1/tasks/${encodeURIComponent(localTaskId)}/input`,
        attachment ? { input, attachment } : { input }
      );
    },
    supportsTaskInputAttachments: async (taskId: string) => {
      // Deliberately NOT `getStatus()`: with cloud tasks wired that returns a
      // synthetic "Kanna Cloud" literal describing no desktop at all, so the
      // marker would always look absent. `requestTask` resolves the task's
      // owner desktop — the same routing `sendTaskInput` uses — so the answer
      // comes from the machine the photo would actually land on.
      const status = await requestTask<MobileServerStatus>(
        taskId,
        "GET",
        () => "/v1/status",
        null
      );
      return typeof status.taskInputAttachmentVersion === "number";
    },
    readTaskFile: (taskId: string, path: string) =>
      requestTask<TaskFileContent>(
        taskId,
        "GET",
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/files/content?path=${encodeURIComponent(path)}`,
        null
      ),
    listTaskDirectory: (taskId, path, showAllFiles = false, offset = 0, filter = "") =>
      requestTask<RepoDirectoryListing>(taskId, "GET", (localTaskId) => `/v1/tasks/${encodeURIComponent(localTaskId)}/browse?path=${encodeURIComponent(path)}&showAllFiles=${showAllFiles}&offset=${offset}&limit=60&filter=${encodeURIComponent(filter)}`, null),
    readTaskFileRange: (taskId, path, startLine, lineCount, metadataOnly = false) =>
      requestTask<RepoFileRange>(taskId, "GET", (localTaskId) => `/v1/tasks/${encodeURIComponent(localTaskId)}/browse/content?path=${encodeURIComponent(path)}&startLine=${startLine}&lineCount=${lineCount}&metadataOnly=${metadataOnly}`, null),
    resolveTaskFileMentions: (
      taskId: string,
      mentions: readonly TaskFileMentionInput[]
    ) =>
      requestTask<TaskFileMentionResolution>(
        taskId,
        "POST",
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/files/resolve-mentions`,
        { mentions }
      ),
    readTaskDiff: (taskId: string, diffRequest?: TaskDiffRequest) =>
      requestTask<TaskDiffContent>(
        taskId,
        "GET",
        (localTaskId) =>
          `/v1/tasks/${encodeURIComponent(localTaskId)}/diff${buildTaskDiffQuery(diffRequest)}`,
        null
      ),
    observeTaskTerminal(
      taskId: string,
      listener: (event: TaskTerminalStreamEvent) => void
    ): TaskTerminalSubscription {
      if (!observeTaskTerminal) {
        throw new RemoteTransportError(
          "remote_invocation_failed",
          "Remote terminal transport is not available."
        );
      }

      const route = taskRouteForId(taskId);
      if (route) {
        return observeTaskTerminal(
          { desktopId: route.desktopId, taskId: route.taskId },
          listener
        );
      }

      if (listCloudTasks) {
        let closed = false;
        let activeSubscription: TaskTerminalSubscription | null = null;
        const pendingCommands: Array<
          (subscription: TaskTerminalSubscription) => void
        > = [];
        const withSubscription = (
          command: (subscription: TaskTerminalSubscription) => void
        ) => {
          if (activeSubscription) {
            command(activeSubscription);
          } else if (!closed) {
            pendingCommands.push(command);
          }
        };

        void resolveCloudTaskRoute(taskId)
          .then((resolvedRoute) => {
            if (closed) {
              return;
            }

            const targetRoute =
              resolvedRoute ?? {
                desktopId: getSelectedDesktopOrThrow(getSelectedDesktopId),
                taskId
              };
            activeSubscription = observeTaskTerminal(
              {
                desktopId: targetRoute.desktopId,
                taskId: targetRoute.taskId
              },
              listener
            );
            for (const command of pendingCommands.splice(0)) {
              command(activeSubscription);
            }
            if (closed) {
              activeSubscription.close();
            }
          })
          .catch((error) => {
            if (closed) {
              return;
            }
            listener({
              type: "error",
              taskId,
              message: formatErrorMessage(error)
            });
          });

        return {
          close() {
            closed = true;
            pendingCommands.length = 0;
            activeSubscription?.close();
          },
          sendInput(dataB64: string, submissionBoundary = false, controlInput = false) {
            withSubscription((subscription) => {
              if (controlInput) {
                subscription.sendInput?.(dataB64, false, true);
              } else if (submissionBoundary) {
                subscription.sendInput?.(dataB64, true);
              } else {
                subscription.sendInput?.(dataB64);
              }
            });
          },
          resize(cols: number, rows: number) {
            withSubscription((subscription) =>
              subscription.resize?.(cols, rows)
            );
          },
          requestScrollback(request) {
            withSubscription((subscription) =>
              subscription.requestScrollback?.(request)
            );
          }
        };
      }

      const desktopId = getSelectedDesktopOrThrow(getSelectedDesktopId);
      return observeTaskTerminal({ desktopId, taskId }, listener);
    },
    observeTaskAgent(
      taskId: string,
      listener: (event: TaskAgentStreamEvent) => void
    ): TaskAgentSubscription {
      if (!observeTaskAgent) {
        throw new RemoteTransportError(
          "remote_invocation_failed",
          "Remote agent stream transport is not available."
        );
      }

      const route = taskRouteForId(taskId);
      if (route) {
        return observeTaskAgent(
          { desktopId: route.desktopId, taskId: route.taskId },
          listener
        );
      }

      if (listCloudTasks) {
        let closed = false;
        let activeSubscription: TaskAgentSubscription | null = null;
        const pendingCommands: Array<(subscription: TaskAgentSubscription) => void> = [];

        const withSubscription = (
          command: (subscription: TaskAgentSubscription) => void
        ) => {
          if (closed) {
            return;
          }
          if (activeSubscription) {
            command(activeSubscription);
          } else {
            pendingCommands.push(command);
          }
        };

        void resolveCloudTaskRoute(taskId)
          .then((resolvedRoute) => {
            if (closed) {
              return;
            }

            const targetRoute =
              resolvedRoute ?? {
                desktopId: getSelectedDesktopOrThrow(getSelectedDesktopId),
                taskId
              };
            activeSubscription = observeTaskAgent(
              {
                desktopId: targetRoute.desktopId,
                taskId: targetRoute.taskId
              },
              listener
            );
            for (const command of pendingCommands.splice(0)) {
              command(activeSubscription);
            }
            if (closed) {
              activeSubscription.close();
            }
          })
          .catch((error) => {
            if (closed) {
              return;
            }
            listener({
              type: "error",
              taskId,
              message: formatErrorMessage(error)
            });
          });

        return {
          close() {
            closed = true;
            pendingCommands.length = 0;
            activeSubscription?.close();
          },
          sendInput(input: string) {
            withSubscription((subscription) => subscription.sendInput(input));
          },
          sendPermission(requestId, decision) {
            withSubscription((subscription) =>
              subscription.sendPermission(requestId, decision)
            );
          },
          interrupt() {
            withSubscription((subscription) => subscription.interrupt());
          }
        };
      }

      const desktopId = getSelectedDesktopOrThrow(getSelectedDesktopId);
      return observeTaskAgent({ desktopId, taskId }, listener);
    },
    observeTaskCompanion(
      taskId: string,
      listener: (event: TaskCompanionStreamEvent) => void
    ): TaskCompanionSubscription {
      if (!observeTaskCompanion) {
        throw new RemoteTransportError(
          "remote_invocation_failed",
          "Remote visual companion transport is not available."
        );
      }

      const translate = (event: TaskCompanionStreamEvent) =>
        listener({ ...event, taskId });
      const route = taskRouteForId(taskId);
      if (route) {
        return observeTaskCompanion(
          { desktopId: route.desktopId, taskId: route.taskId },
          translate
        );
      }

      if (listCloudTasks) {
        let closed = false;
        let activeSubscription: TaskCompanionSubscription | null = null;

        void resolveCloudTaskRoute(taskId)
          .then((resolvedRoute) => {
            if (closed) return;
            const targetRoute =
              resolvedRoute ?? {
                desktopId: getSelectedDesktopOrThrow(getSelectedDesktopId),
                taskId
              };
            activeSubscription = observeTaskCompanion(
              { desktopId: targetRoute.desktopId, taskId: targetRoute.taskId },
              translate
            );
            if (closed) activeSubscription.close();
          })
          .catch((error) => {
            if (closed) return;
            listener({
              type: "error",
              taskId,
              code: "desktop_unavailable",
              message: formatErrorMessage(error)
            });
          });

        return {
          close() {
            closed = true;
            activeSubscription?.close();
          },
          sendEvent(sessionId, revision, event) {
            if (closed) return false;
            if (activeSubscription) {
              return activeSubscription.sendEvent(sessionId, revision, event);
            }
            return false;
          }
        };
      }

      const desktopId = getSelectedDesktopOrThrow(getSelectedDesktopId);
      return observeTaskCompanion({ desktopId, taskId }, translate);
    }
  };
}

async function invokeSelectedDesktop({
  getSelectedDesktopId,
  invokeDesktop,
  method,
  path,
  body
}: {
  getSelectedDesktopId(): string | null;
  invokeDesktop: RemoteDesktopInvoker;
  method: RemoteDesktopInvocationRequest["method"];
  path: string;
  body: unknown | null;
}): Promise<unknown> {
  const desktopId = getSelectedDesktopOrThrow(getSelectedDesktopId);

  try {
    return await invokeDesktop({
      desktopId,
      method,
      path,
      body
    });
  } catch (error) {
    if (error instanceof RemoteTransportError) {
      throw error;
    }

    throw new RemoteTransportError(
      "remote_invocation_failed",
      `Remote desktop request failed: ${formatErrorMessage(error)}`,
      error
    );
  }
}

function getSelectedDesktopOrThrow(
  getSelectedDesktopId: () => string | null
): string {
  const desktopId = getSelectedDesktopId();
  if (!desktopId) {
    throw new RemoteTransportError(
      "no_selected_desktop",
      "Select a desktop before connecting remotely."
    );
  }

  return desktopId;
}

function isCloudTaskRoute(
  task: TaskSummary | undefined
): task is TaskSummary & { ownerDesktopId: string; ownerLocalTaskId: string } {
  return (
    Boolean(task) &&
    typeof (task as { ownerDesktopId?: unknown }).ownerDesktopId === "string" &&
    typeof (task as { ownerLocalTaskId?: unknown }).ownerLocalTaskId === "string"
  );
}

function mapMobileServerStatus(response: unknown): MobileServerStatus {
  if (!isRecord(response)) {
    throw new RemoteTransportError(
      "invalid_status_response",
      "Remote desktop returned an invalid status response."
    );
  }

  const state = getStringField(response, "state");
  const desktopId = getStringField(response, "desktopId");
  const desktopName = getStringField(response, "desktopName");
  const version = getStringField(response, "version");
  const environment = getStringField(response, "environment");
  const serverVersion = getNullableStringField(response, "serverVersion");
  const lanHost = getStringField(response, "lanHost");
  const lanPort = getNumberField(response, "lanPort");
  const pairingCode = getNullableStringField(response, "pairingCode");
  const writePathHealth = mapWritePathHealth(response.writePathHealth);
  // Rebuilt field by field, so a capability the desktop advertises has to be
  // copied here or the relay path reads as an older desktop forever.
  const taskInputAttachmentVersion = getNumberField(
    response,
    "taskInputAttachmentVersion"
  );

  if (
    state === null ||
    desktopId === null ||
    desktopName === null ||
    version === null ||
    environment === null ||
    lanHost === null ||
    lanPort === null
  ) {
    throw new RemoteTransportError(
      "invalid_status_response",
      "Remote desktop returned an invalid status response."
    );
  }

  return {
    state,
    desktopId,
    desktopName,
    version,
    environment,
    serverVersion,
    lanHost,
    lanPort,
    pairingCode,
    ...(writePathHealth ? { writePathHealth } : {}),
    ...(taskInputAttachmentVersion === null
      ? {}
      : { taskInputAttachmentVersion })
  };
}

/** Desktops that predate write-path health reporting omit the field entirely;
 * absence means unknown (mirroring the optional `kspStreamVersion`), so only a
 * present-but-malformed payload is rejected. */
function mapWritePathHealth(value: unknown): WritePathHealth | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.healthy !== "boolean" ||
    typeof value.status !== "string" ||
    typeof value.activeWorkspaceCommands !== "number" ||
    typeof value.maxWorkspaceCommands !== "number" ||
    typeof value.longRunningWorkspaceCommands !== "number" ||
    (value.oldestWorkspaceCommandSeconds !== null &&
      typeof value.oldestWorkspaceCommandSeconds !== "number")
  ) {
    throw new RemoteTransportError(
      "invalid_status_response",
      "Remote desktop returned an invalid status response."
    );
  }

  return {
    healthy: value.healthy,
    status: value.status,
    activeWorkspaceCommands: value.activeWorkspaceCommands,
    maxWorkspaceCommands: value.maxWorkspaceCommands,
    longRunningWorkspaceCommands: value.longRunningWorkspaceCommands,
    oldestWorkspaceCommandSeconds: value.oldestWorkspaceCommandSeconds
  };
}

function parseRepoSummaries(value: unknown): RepoSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const repos: RepoSummary[] = [];
  for (const entry of value) {
    if (
      isRecord(entry) &&
      typeof entry.id === "string" &&
      entry.id &&
      typeof entry.name === "string"
    ) {
      repos.push({
        id: entry.id,
        name: entry.name,
        ...(typeof entry.remoteUrl === "string" && entry.remoteUrl
          ? { remoteUrl: entry.remoteUrl }
          : {}),
        ...(typeof entry.remoteUrlHash === "string" && entry.remoteUrlHash
          ? { remoteUrlHash: entry.remoteUrlHash }
          : {})
      });
    }
  }
  return repos;
}

function awaitWithFallback<T>(
  read: Promise<T>,
  waitMs: number,
  fallback: () => T
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: T) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => settle(fallback()), waitMs);
    read.then(settle, () => settle(fallback()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function getNumberField(
  record: Record<string, unknown>,
  field: string
): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

function getNullableStringField(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "unknown error";
}
