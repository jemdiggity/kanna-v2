import type {
  KannaTransport,
  TaskAgentSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../api/client";
import { StreamClient, type WebSocketLike as StreamWebSocketLike } from "@kanna/stream-client";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  DesktopDescriptor,
  DesktopSummary,
  MobileServerStatus,
  PairingSession,
  RepoSummary,
  TaskActionResponse,
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

interface RawTaskTerminalStreamEvent {
  type?: string;
  taskId?: string;
  task_id?: string;
  text?: string;
  code?: number;
  message?: string;
}

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
    searchTasks: (query) =>
      request<TaskSummary[]>(`/v1/tasks/search?query=${encodeURIComponent(query)}`),
    createTask: (input: CreateTaskRequest) =>
      request<CreateTaskResponse>("/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      }),
    runMergeAgent: (taskId: string) =>
      request<TaskActionResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/run-merge-agent`, {
        method: "POST"
      }),
    advanceTaskStage: (taskId: string) =>
      request<TaskActionResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/advance-stage`, {
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
    observeTaskTerminal(taskId, listener) {
      const socket = createSocket(buildTaskTerminalWebSocketUrl(baseUrl, taskId));
      let streamEnded = false;

      socket.onopen = () => {
        listener({ type: "ready", taskId });
      };
      socket.onmessage = (event) => {
        const parsed = normalizeTaskTerminalStreamEvent(
          JSON.parse(event.data) as RawTaskTerminalStreamEvent
        );
        if (parsed.type === "exit" || parsed.type === "error") {
          streamEnded = true;
        }
        listener(parsed);
      };
      socket.onerror = () => {
        streamEnded = true;
        listener({
          type: "error",
          taskId,
          message: `Task terminal stream failed for ${taskId}`
        });
      };
      socket.onclose = () => {
        if (streamEnded) {
          return;
        }
        listener({ type: "exit", taskId, code: 0 });
      };

      return {
        close() {
          socket.close();
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
    },
    createPairingSession: () =>
      request<PairingSession>("/v1/pairing/sessions", { method: "POST" })
  };
}

function normalizeTaskTerminalStreamEvent(
  event: RawTaskTerminalStreamEvent
): TaskTerminalStreamEvent {
  const taskId = event.taskId ?? event.task_id ?? "";

  switch (event.type) {
    case "ready":
      return { type: "ready", taskId };
    case "output":
      return {
        type: "output",
        taskId,
        text: event.text ?? ""
      };
    case "exit":
      return {
        type: "exit",
        taskId,
        code: event.code ?? 0
      };
    case "error":
      return {
        type: "error",
        taskId,
        message: event.message ?? "Task terminal stream failed"
      };
    default:
      return {
        type: "error",
        taskId,
        message: "Task terminal stream sent an unknown event"
      };
  }
}

function buildTaskTerminalWebSocketUrl(baseUrl: string, taskId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/tasks/${encodeURIComponent(taskId)}/terminal`;
  url.search = "";
  return url.toString();
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
