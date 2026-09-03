import { readServerRefusal, ServerRefusalError } from "./serverRefusal";
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
  PushPairingMaterial,
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
  TaskInputResult,
  TaskDetail,
  TaskPreviewOpenResult,
  TaskSummary
} from "../api/types";
import { parseAgentProviderInventory } from "../api/agentProviders";

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
  // The server's own explanation and machine-readable reason for a failed
  // request, when it sent them.
  const readFailure = async (response: {
    json: () => Promise<unknown>;
  }): Promise<{ reason: string | null; message: string | null }> => {
    try {
      return readServerRefusal(await response.json());
    } catch {
      return { reason: null, message: null };
    }
  };

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
      // The server explains refusals it expects a person to act on — a task
      // input held behind someone's unsent line names the terminal to go
      // press Enter at. A status code alone sends that person nowhere, and the
      // reason lets a caller tell that refusal from a broken connection.
      const { reason, message } = await readFailure(response);
      throw new ServerRefusalError(
        `LAN request failed (${response.status}) for ${path}${message ? `: ${message}` : ""}`,
        reason,
        response.status
      );
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
    reissuePushPairingCertificate: () =>
      request<PushPairingMaterial>("/v1/pairing/push-certificate", {
        method: "POST"
      }),
    async listDesktops() {
      const desktops = await request<DesktopDescriptor[]>("/v1/desktops");
      return desktops.map(mapDesktopSummary);
    },
    listRepos: () => request<RepoSummary[]>("/v1/repos"),
    startRepoCheckout: ({ desktopId: _desktopId, ...input }) =>
      request<RepoCheckoutOperation>("/v1/repo-checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      }),
    getRepoCheckout: (_desktopId, operationId) =>
      request<RepoCheckoutOperation>(
        `/v1/repo-checkouts/${encodeURIComponent(operationId)}`
      ),
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "operator" })
      }),
    resumeTask: (taskId: string) =>
      request<TaskActionResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/resume`, {
        method: "POST"
      }),
    markTaskRead: (taskId: string, expectedActivityRevision?: number) =>
      request<TaskActivityResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/mark-read`, {
        method: "POST",
        ...(expectedActivityRevision === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expectedActivityRevision })
            })
      }),
    closeTask: (taskId: string) =>
      request<void>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/close`, {
        method: "POST"
      }),
    openTaskPreview: async (taskId: string, portName?: string) => {
      const opened = await request<
        Omit<TaskPreviewOpenResult, "url"> & { enterPath: string }
      >(
        `/v1/tasks/${encodeURIComponent(taskId)}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(portName ? { portName } : {})
        }
      );
      const previewOrigin = new URL(baseUrl);
      previewOrigin.port = String(opened.port);
      const enterUrl = new URL(opened.enterPath, previewOrigin.origin);
      const { enterPath: _enterPath, ...result } = opened;
      return { ...result, url: enterUrl.toString() };
    },
    closeTaskPreview: (taskId: string) =>
      request<void>(`/v1/tasks/${encodeURIComponent(taskId)}/preview`, {
        method: "DELETE"
      }),
    sendTaskInput: (
      taskId: string,
      input: string,
      attachment?: TaskInputAttachment
    ) =>
      request<TaskInputResult | undefined>(
        `/v1/tasks/${encodeURIComponent(taskId)}/input`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attachment ? { input, attachment } : { input })
        }
      ).then((result) =>
        result?.status === "queued" ? result : { status: "delivered" }
      ),
    // A LAN connection is pinned to one desktop, so that desktop's own status
    // is the answer. Read fresh rather than reusing the cached
    // `kspStreamVersion` probe: the desktop can be upgraded under a live app.
    supportsTaskInputAttachments: async () => {
      const status = await request<MobileServerStatus>("/v1/status");
      return typeof status.taskInputAttachmentVersion === "number";
    },
    readTaskFile: async (_taskId: string, _path: string): Promise<TaskFileContent> => {
      throw new Error("Task file preview requires an authenticated relay connection.");
    },
    listTaskDirectory: (taskId, path, showAllFiles = false, offset = 0, filter = "") => request<RepoDirectoryListing>(`/v1/tasks/${encodeURIComponent(taskId)}/browse?path=${encodeURIComponent(path)}&showAllFiles=${showAllFiles}&offset=${offset}&limit=60&filter=${encodeURIComponent(filter)}`),
    readTaskFileRange: (taskId, path, startLine, lineCount, metadataOnly = false, startByte = 0) => request<RepoFileRange>(`/v1/tasks/${encodeURIComponent(taskId)}/browse/content?path=${encodeURIComponent(path)}&startLine=${startLine}&startByte=${startByte}&lineCount=${lineCount}&metadataOnly=${metadataOnly}`),
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
        reconnectDelaysMs: [250, 500, 1000, 2000],
        // A phone on LAN is still a phone: same xterm buffer, same cold-open
        // latency. The window is negotiated on both mobile transports.
        terminalScrollbackWindow: true
      });

      client.attachTerminal(taskId, {
        onSnapshot(cols, rows, dataB64, _agentProvider, window) {
          listener({
            type: "snapshot",
            taskId,
            cols,
            rows,
            dataB64,
            // Omitted rather than nulled for an unwindowed snapshot: the event
            // shape a legacy desktop produces is unchanged.
            ...(window ? { window } : {})
          });
        },
        onOutput(dataB64) {
          if (dataB64) {
            listener({ type: "output", taskId, dataB64 });
          }
        },
        onResumed(window) {
          listener({ type: "resumed", taskId, window });
        },
        onScrollbackChunk(chunk) {
          listener({ type: "scrollback", taskId, chunk });
        },
        onSessionExit(code) {
          listener({ type: "exit", taskId, code });
        },
        onError(code, message) {
          listener({ type: "error", taskId, code, message });
        }
      });

      return {
        close() {
          client.close();
        },
        sendInput(dataB64: string, submissionBoundary = false, controlInput = false) {
          client.sendTermInput(taskId, dataB64, submissionBoundary, controlInput);
        },
        resize(cols: number, rows: number) {
          client.sendTermResize(taskId, cols, rows);
        },
        requestScrollback(request) {
          client.requestTerminalScrollback(taskId, request);
        }
      } satisfies TaskTerminalSubscription;
    },
    observeTaskAgent(taskId, listener) {
      const client = new StreamClient({
        url: buildKspWebSocketUrl(baseUrl, kspStreamVersion),
        credential: streamCredential,
        webSocketFactory: (url) => createKspSocket(url) as unknown as StreamWebSocketLike,
        reconnectDelaysMs: [250, 500, 1000, 2000],
        agentHistoryWindow: true
      });

      client.attachAgent(taskId, {
        onSnapshot(events, nextSeq, window) {
          listener({
            type: "snapshot",
            taskId,
            events,
            nextSeq,
            ...(window
              ? {
                  historyStartSeq: window.historyStartSeq,
                  historyFromSeq: window.historyFromSeq,
                  resumed: window.resumed
                }
              : {})
          });
        },
        onHistoryChunk(chunk) {
          listener({
            type: "history",
            taskId,
            events: chunk.events,
            startSeq: chunk.startSeq,
            endSeq: chunk.endSeq,
            afterSeq: chunk.afterSeq
          });
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
        onError(code, message) {
          listener({ type: "error", taskId, code, message });
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
        },
        requestHistory(request) {
          client.requestAgentHistory(taskId, request);
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
  const agentProviders = parseAgentProviderInventory(desktop.agentProviders);
  return {
    id: desktop.id,
    name: desktop.name,
    online: true,
    mode: desktop.connectionMode === "remote" ? "remote" : "lan",
    ...(agentProviders ? { agentProviders } : {})
  };
}
