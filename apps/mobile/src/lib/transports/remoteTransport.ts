import type {
  KannaTransport,
  TaskAgentStreamEvent,
  TaskAgentSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription,
} from "../api/client";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  DesktopSummary,
  MobileServerStatus,
  PairingSession,
  RepoSummary,
  TaskActionResponse,
  TaskSummary,
} from "../api/types";

export interface RemoteDesktopRecord {
  desktopId: string;
  displayName: string;
  online: boolean;
  reachableViaRelay: boolean;
  connectionMode: "lan" | "internet" | "both";
  lastSeenAt?: string | null;
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

export type RemoteTaskInputSender = (
  request: { desktopId: string; taskId: string; data: string }
) => Promise<void>;

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
  sendTaskInput?: RemoteTaskInputSender;
  listCloudTasks?: () => Promise<CloudIndexedTaskSummary[]>;
}

interface CloudTaskRoute {
  desktopId: string;
  taskId: string;
}

type CloudIndexedTaskSummary = TaskSummary & {
  repoName?: string | null;
};

export function createRemoteTransport({
  listDesktopRecords,
  getSelectedDesktopId,
  invokeDesktop,
  observeTaskTerminal,
  observeTaskAgent,
  sendTaskInput,
  listCloudTasks
}: RemoteTransportDependencies): KannaTransport {
  let cloudTaskRoutes = new Map<string, CloudTaskRoute>();
  const provisionalTaskRoutes = new Map<string, CloudTaskRoute>();
  let latestAcceptedCloudTasks: CloudIndexedTaskSummary[] = [];
  let latestCloudReadEpoch = 0;

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
    taskId: string
  ): Promise<CloudTaskRoute | null> => {
    const cached = taskRouteForId(taskId);
    if (cached) {
      return cached;
    }
    if (!listCloudTasks) {
      return null;
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

  const resolveCloudRepoDesktopId = async (
    repoId: string
  ): Promise<string | null> => {
    if (!listCloudTasks) {
      return null;
    }

    await listFreshCloudTasks();
    const routeTask = latestAcceptedCloudTasks.find(
      (
        task
      ): task is CloudIndexedTaskSummary & {
        ownerDesktopId: string;
        ownerLocalTaskId: string;
      } => task.repoId === repoId && isCloudTaskRoute(task)
    );
    return routeTask?.ownerDesktopId ?? null;
  };

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
    body: unknown | null
  ): Promise<T> => {
    const route = await resolveCloudTaskRoute(taskId);
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

    provisionalTaskRoutes.set(responseTaskId, {
      desktopId: route.desktopId,
      taskId: responseTaskId
    });
    return response;
  };

  return {
    async getStatus(): Promise<MobileServerStatus> {
      if (listCloudTasks) {
        return {
          state: "running",
          desktopId: "cloud",
          desktopName: "Kanna Cloud",
          lanHost: "cloud",
          lanPort: 0,
          pairingCode: null
        };
      }
      return mapMobileServerStatus(await request("GET", "/v1/status", null));
    },
    async listDesktops(): Promise<DesktopSummary[]> {
      const records = await listDesktopRecords();
      return records.map((record) => ({
        id: record.desktopId,
        name: record.displayName,
        online: record.online,
        mode: "remote",
        reachableViaRelay: record.reachableViaRelay,
        connectionMode: record.connectionMode,
        lastSeenAt: record.lastSeenAt ?? null,
      }));
    },
    listRepos: async () => {
      if (!listCloudTasks) {
        return request<RepoSummary[]>("GET", "/v1/repos", null);
      }
      const tasks = await listFreshCloudTasks();
      const reposById = new Map<string, string>();
      for (const task of tasks) {
        if (!reposById.has(task.repoId)) {
          reposById.set(task.repoId, task.repoName?.trim() || task.repoId);
        }
      }
      return Array.from(reposById, ([id, name]) => ({ id, name }));
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
    listRecentTasks: () =>
      listCloudTasks
        ? listFreshCloudTasks()
        : request<TaskSummary[]>("GET", "/v1/tasks/recent", null),
    searchTasks: async (query) => {
      if (listCloudTasks) {
        const normalizedQuery = query.toLowerCase();
        return (await listFreshCloudTasks()).filter(
          (task) =>
            task.title.toLowerCase().includes(normalizedQuery) ||
            task.snippet?.toLowerCase().includes(normalizedQuery) === true
        );
      }
      return request<TaskSummary[]>(
        "GET",
        `/v1/tasks/search?query=${encodeURIComponent(query)}`,
        null
      );
    },
    createTask: async (input: CreateTaskRequest) => {
      const { desktopId: requestedDesktopId, ...taskInput } = input;
      const desktopId =
        requestedDesktopId ?? (await resolveCloudRepoDesktopId(input.repoId));
      if (desktopId) {
        const created = await requestDesktop<CreateTaskResponse>(
          desktopId,
          "POST",
          "/v1/tasks",
          taskInput
        );
        provisionalTaskRoutes.set(created.taskId, {
          desktopId,
          taskId: created.taskId
        });
        return created;
      }

      return request<CreateTaskResponse>("POST", "/v1/tasks", taskInput);
    },
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
    sendTaskInput: async (taskId: string, input: string) => {
      const route = await resolveCloudTaskRoute(taskId);
      if (route && sendTaskInput) {
        await sendTaskInput({
          desktopId: route.desktopId,
          taskId: route.taskId,
          data: input
        });
        return;
      }

      await requestTask<void>(
        taskId,
        "POST",
        (localTaskId) => `/v1/tasks/${encodeURIComponent(localTaskId)}/input`,
        { input }
      );
    },
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
        return observeTaskTerminal(route, listener);
      }

      if (listCloudTasks) {
        let closed = false;
        let activeSubscription: TaskTerminalSubscription | null = null;

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
            activeSubscription = observeTaskTerminal(targetRoute, listener);
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
            activeSubscription?.close();
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
        return observeTaskAgent(route, listener);
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
            activeSubscription = observeTaskAgent(targetRoute, listener);
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
    async createPairingSession(): Promise<PairingSession> {
      throw new Error(
        "Cloud pairing session is not created from the mobile transport"
      );
    },
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
  const lanHost = getStringField(response, "lanHost");
  const lanPort = getNumberField(response, "lanPort");
  const pairingCode = getNullableStringField(response, "pairingCode");

  if (
    state === null ||
    desktopId === null ||
    desktopName === null ||
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
    lanHost,
    lanPort,
    pairingCode
  };
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
