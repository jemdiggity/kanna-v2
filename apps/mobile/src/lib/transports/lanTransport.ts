import type {
  KannaTransport,
  TaskAgentSubscription,
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
  TaskActionResponse,
  TaskActivityResponse,
  TaskFileContent,
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

export type WebSocketFactory = (url: string) => WebSocketLike;

export function createLanTransport(
  baseUrl: string,
  fetchImpl: FetchLike,
  createSocket: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike
): KannaTransport {
  const request = async <T>(
    path: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    }
  ): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`LAN request failed (${response.status}) for ${path}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  };

  return {
    getStatus: () => request<MobileServerStatus>("/v1/status"),
    async listDesktops() {
      const desktops = await request<DesktopDescriptor[]>("/v1/desktops");
      return desktops.map(mapDesktopSummary);
    },
    listRepos: () => request<RepoSummary[]>("/v1/repos"),
    listRepoTasks: (repoId: string) =>
      request<TaskSummary[]>(`/v1/repos/${encodeURIComponent(repoId)}/tasks`),
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
        body: JSON.stringify({ input })
      }),
    readTaskFile: async (_taskId: string, _path: string): Promise<TaskFileContent> => {
      throw new Error(
        "Task file preview requires an authenticated relay connection."
      );
    },
    observeTaskTerminal(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl),
        webSocketFactory: (url) => createSocket(url) as unknown as StreamWebSocketLike,
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
        }
      } satisfies TaskTerminalSubscription;
    },
    observeTaskAgent(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl),
        webSocketFactory: (url) => createSocket(url) as unknown as StreamWebSocketLike,
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
    }
  };
}

function buildKspWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/stream";
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
