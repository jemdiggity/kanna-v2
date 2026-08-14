import type {
  KannaTransport,
  TaskAgentSubscription,
  TaskCompanionSubscription,
  TaskTerminalSubscription
} from "../api/client";
import { StreamClient, type WebSocketLike as StreamWebSocketLike } from "@kanna/stream-client";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  DesktopDescriptor,
  DesktopSummary,
  MobileServerStatus,
  RepoSummary,
  RepoCommandCatalog,
  RunRepoCommandResponse,
  TaskActionResponse,
  TaskActivityResponse,
  TaskDiffContent,
  TaskDiffRequest,
  TaskFileContent,
  TaskFileMentionInput,
  TaskFileMentionResolution,
  TaskDetail,
  TaskSummary
} from "../api/types";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

export type WebSocketFactory = (
  url: string,
  headers?: Record<string, string>
) => WebSocketLike;

export interface LanDeviceCredentials {
  deviceId: string;
  deviceSecret: string;
}

export function createLanTransport(
  baseUrl: string,
  fetchImpl: FetchLike,
  createSocket: WebSocketFactory = (url, headers) => {
    const ReactNativeWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) => WebSocketLike;
    return new ReactNativeWebSocket(url, undefined, { headers });
  },
  options: { deviceCredentials?: LanDeviceCredentials | null } = {}
): KannaTransport {
  const deviceCredentials = options.deviceCredentials ?? null;
  let kspStreamVersion: 1 | 2 = 1;
  const streamCredential = deviceCredentials
    ? JSON.stringify(deviceCredentials)
    : undefined;
  const credentialHeaders = (): Record<string, string> =>
    deviceCredentials
      ? {
          "X-Kanna-Device-Id": deviceCredentials.deviceId,
          "X-Kanna-Device-Secret": deviceCredentials.deviceSecret
        }
      : {};
  const createKspSocket = (url: string): WebSocketLike =>
    deviceCredentials
      ? createSocket(url, credentialHeaders())
      : createSocket(url);
  const request = async <T>(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    }
  ): Promise<T> => {
    const response = await fetchImpl(
      `${baseUrl}${path}`,
      deviceCredentials
        ? { ...init, headers: { ...credentialHeaders(), ...init?.headers } }
        : init
    );
    if (!response.ok) {
      throw new Error(`LAN request failed (${response.status}) for ${path}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  };

  return {
    getStatus: async () => {
      const status = await request<MobileServerStatus>("/v1/status");
      kspStreamVersion = status.kspStreamVersion === 2 ? 2 : 1;
      return status;
    },
    async listDesktops() {
      const desktops = await request<DesktopDescriptor[]>("/v1/desktops");
      return desktops.map(mapDesktopSummary);
    },
    listRepos: () => request<RepoSummary[]>("/v1/repos"),
    listRepoTasks: (repoId: string) =>
      request<TaskSummary[]>(`/v1/repos/${encodeURIComponent(repoId)}/tasks`),
    listRepoCommands: (repoId: string) =>
      request<RepoCommandCatalog>(
        `/v1/repos/${encodeURIComponent(repoId)}/commands`
      ),
    runRepoCommand: (
      repoId: string,
      commandId: string,
      catalogRevision: string
    ) =>
      request<RunRepoCommandResponse>(
        `/v1/repos/${encodeURIComponent(repoId)}/commands/${encodeURIComponent(commandId)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalogRevision })
        }
      ),
    listRecentTasks: () => request<TaskSummary[]>("/v1/tasks/recent"),
    getTask: (taskId: string) =>
      request<TaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`),
    searchTasks: (query) =>
      request<TaskSummary[]>(`/v1/tasks/search?query=${encodeURIComponent(query)}`),
    createTask: (input: CreateTaskRequest) => {
      const {
        desktopId: _desktopId,
        taskId,
        ...taskInput
      } = input;
      const hasTaskId = taskId !== undefined;
      const path = hasTaskId
        ? `/v1/tasks/${encodeURIComponent(taskId)}`
        : "/v1/tasks";
      return request<CreateTaskResponse>(path, {
        method: hasTaskId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskInput)
      });
    },
    abortTaskCreation: ({ taskId }) =>
      request<void>(
        `/v1/tasks/${encodeURIComponent(taskId)}/actions/abort-creation`,
        { method: "POST" }
      ),
    runMergeAgent: (taskId: string) =>
      request<TaskActionResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/run-merge-agent`, {
        method: "POST"
      }),
    advanceTaskStage: (taskId: string) =>
      request<TaskActionResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/advance-stage`, {
        method: "POST"
      }),
    markTaskRead: (taskId: string) =>
      request<TaskActivityResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/mark-read`, {
        method: "POST"
      }),
    closeTask: (taskId: string) =>
      request<void>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/close`, {
        method: "POST"
      }),
    sendTaskInput: (taskId: string, input: string) =>
      request<void>(`/v1/tasks/${encodeURIComponent(taskId)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, source: "human" })
      }),
    readTaskFile: async (_taskId: string, _path: string): Promise<TaskFileContent> => {
      throw new Error(
        "Task file preview requires an authenticated relay connection."
      );
    },
    resolveTaskFileMentions: async (
      _taskId: string,
      _mentions: readonly TaskFileMentionInput[]
    ): Promise<TaskFileMentionResolution> => {
      throw new Error(
        "Task file resolution requires an authenticated relay connection."
      );
    },
    readTaskDiff: (
      taskId: string,
      diffRequest?: TaskDiffRequest
    ): Promise<TaskDiffContent> => {
      if (!deviceCredentials) {
        return Promise.reject(
          new Error(
            "Task diff requires a paired device or an authenticated relay connection. Re-pair this machine to view diffs over LAN."
          )
        );
      }
      return request<TaskDiffContent>(
        `/v1/tasks/${encodeURIComponent(taskId)}/diff${buildTaskDiffQuery(diffRequest)}`
      );
    },
    observeTaskTerminal(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl, kspStreamVersion),
        credential: streamCredential,
        webSocketFactory: (url) => createKspSocket(url) as unknown as StreamWebSocketLike,
        reconnectDelaysMs: [250, 500, 1000, 2000]
      });

      client.attachTerminal(taskId, {
        onSnapshot(cols, rows, dataB64) {
          listener({ type: "snapshot", taskId, cols, rows, dataB64 });
        },
        onOutput(dataB64) {
          if (dataB64) {
            listener({ type: "output", taskId, dataB64 });
          }
        },
        onSessionExit(code) {
          listener({ type: "exit", taskId, code });
        },
        onError(_code, message) {
          listener({ type: "error", taskId, message });
        }
      });

      return {
        close() {
          client.close();
        },
        sendInput(dataB64: string) {
          client.sendTermInput(taskId, dataB64);
        },
        resize(cols: number, rows: number) {
          client.sendTermResize(taskId, cols, rows);
        }
      } satisfies TaskTerminalSubscription;
    },
    observeTaskAgent(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl, kspStreamVersion),
        credential: streamCredential,
        webSocketFactory: (url) => createKspSocket(url) as unknown as StreamWebSocketLike,
        reconnectDelaysMs: [250, 500, 1000, 2000]
      });

      client.attachAgent(taskId, {
        onSnapshot(events, nextSeq) {
          listener({ type: "snapshot", taskId, events, nextSeq });
        },
        onEvent(seq, event) {
          listener({ type: "event", taskId, seq, event });
        },
        onStatus(status) {
          listener({ type: "status", taskId, status });
        },
        onSessionExit(code) {
          listener({ type: "exit", taskId, code });
        },
        onError(_code, message) {
          listener({ type: "error", taskId, message });
        }
      });

      return {
        close() {
          client.close();
        },
        sendInput(input: string) {
          client.sendAgentInput(taskId, input);
        },
        sendPermission(requestId, decision) {
          client.sendAgentPermission(taskId, requestId, decision);
        },
        interrupt() {
          client.sendAgentInterrupt(taskId);
        }
      } satisfies TaskAgentSubscription;
    },
    observeTaskCompanion(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl, kspStreamVersion),
        credential: streamCredential,
        webSocketFactory: (url) => createKspSocket(url) as unknown as StreamWebSocketLike,
        reconnectDelaysMs: [250, 500, 1000, 2000]
      });

      client.attachCompanion(
        taskId,
        {
          onSnapshot(snapshot) {
            listener({ type: "snapshot", taskId, ...snapshot, assets: [] });
          },
          onUnavailable() {
            listener({ type: "unavailable", taskId });
          },
          onEventResult(result) {
            listener({ type: "event_result", taskId, ...result });
          },
          onConnectionChange(connected) {
            listener({ type: "connection", taskId, connected });
          },
          onError(code, message) {
            listener({ type: "error", taskId, code, message });
          }
        },
        { includeAssets: false }
      );

      return {
        close() {
          client.detach(taskId, "companion");
          client.close();
        },
        sendEvent(sessionId, revision, event) {
          return client.sendCompanionEvent(taskId, sessionId, revision, event);
        }
      } satisfies TaskCompanionSubscription;
    }
  };
}

export function buildTaskDiffQuery(request?: TaskDiffRequest): string {
  if (!request) return "";
  return `?scope=${encodeURIComponent(request.scope)}&mode=${encodeURIComponent(request.mode)}`;
}

function buildKspWebSocketUrl(
  baseUrl: string,
  streamVersion: 1 | 2
): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v${streamVersion}/stream`;
  url.search = "";
  return url.toString();
}

function mapDesktopSummary(desktop: DesktopDescriptor): DesktopSummary {
  return {
    id: desktop.id,
    name: desktop.name,
    online: true,
    mode: desktop.connectionMode === "remote" ? "remote" : "lan"
  };
}
