import { readServerRefusal, ServerRefusalError } from "./serverRefusal";
import type {
  TaskAgentSubscription,
  TaskCompanionSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription,
  TaskSummaryStreamEvent,
  TaskSummarySubscription
} from "../api/client";
import type {
  RemoteDesktopInvocationRequest,
  RemoteDesktopInvoker,
  RemoteTaskAgentObserver,
  RemoteTaskCompanionObserver,
  RemoteTaskTerminalObserver
} from "./remoteTransport";
import { createRelayTunnelWebSocketFactory, StreamClient } from "@kanna/stream-client";

export interface RelaySocketLike {
  readyState: number;
  close(): void;
  send(data: string): void;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayDesktopClient {
  close(): void;
  setForeground?(foreground: boolean): void;
  invokeDesktop: RemoteDesktopInvoker;
  listActiveDesktopIds(): Promise<Set<string>>;
  observeTaskTerminal: RemoteTaskTerminalObserver;
  observeTaskAgent: RemoteTaskAgentObserver;
  observeTaskCompanion: RemoteTaskCompanionObserver;
  observeDesktopTaskSummaries(
    desktopId: string,
    listener: (event: TaskSummaryStreamEvent) => void
  ): TaskSummarySubscription;
}

export interface RelayDesktopClientDependencies {
  createSocket?: RelaySocketFactory;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  nextId?: () => string;
  relayUrl: string;
  /** Called when the relay rejects auth even after a forced token refresh, so
   * the app can surface an auth-expired state and require re-login. */
  onAuthError?(): void;
  reconnectDelaysMs?: readonly number[];
}

interface PendingInvoke {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

interface TerminalObserver {
  listener(event: TaskTerminalStreamEvent): void;
}

interface RelayResponseMessage extends Record<string, unknown> {
  type: "response";
  id: unknown;
  data?: unknown;
  body?: unknown;
  error?: unknown;
  status?: unknown;
}

interface RelayEventMessage extends Record<string, unknown> {
  type: "event";
  name?: unknown;
  payload?: unknown;
}

export function createRelayDesktopClient({
  createSocket = (url) => new WebSocket(url) as unknown as RelaySocketLike,
  getIdToken,
  nextId = createSequentialIdFactory(),
  relayUrl,
  onAuthError,
  reconnectDelaysMs = [250, 500, 1000, 2000]
}: RelayDesktopClientDependencies): RelayDesktopClient {
  let socket: RelaySocketLike | null = null;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let foreground = true;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hasOpenedControlSocket = false;
  const pendingInvokes = new Map<string, PendingInvoke>();
  const terminalObservers = new Map<string, TerminalObserver>();
  const terminalConnectionListeners = new Map<string, Set<(connected: boolean) => void>>();
  const streamClients = new Map<string, StreamClient>();

  const streamClientForDesktop = (desktopId: string) => {
    const existing = streamClients.get(desktopId);
    if (existing) {
      return existing;
    }

    const client = new StreamClient({
      url: relayUrl,
      webSocketFactory: createRelayTunnelWebSocketFactory({
        relayUrl,
        desktopId,
        getIdentityToken: (forceRefresh) => getIdToken(forceRefresh),
        webSocketFactory: createSocket,
      }),
      reconnectDelaysMs: [250, 500, 1000, 2000],
      onAuthError,
      // The relay path is the one the owner measured at ~4.9 MB per five
      // minutes of viewing: bounded snapshots, on-demand scrollback, and delta
      // resubscribe are all negotiated here.
      terminalScrollbackWindow: true,
      terminalViewerRole: "remote",
      onConnectionChange(connected) {
        for (const listener of terminalConnectionListeners.get(desktopId) ?? []) {
          listener(connected);
        }
      },
    });
    streamClients.set(desktopId, client);
    return client;
  };

  const scheduleReconnect = () => {
    if (!foreground || disposed || reconnectTimer || !hasOpenedControlSocket) {
      return;
    }
    const delay = reconnectDelaysMs[
      Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)
    ] ?? 0;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (foreground && !disposed) {
        ensureSocket();
      }
    }, delay);
  };

  const ensureSocket = () => {
    if (!foreground || disposed) {
      return null;
    }
    if (socket && socket.readyState <= 1) {
      return socket;
    }

    const openSocket = createSocket(relayUrl);
    hasOpenedControlSocket = true;
    socket = openSocket;
    readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void readyPromise.catch(() => undefined);
    openSocket.onopen = () => {
      void sendAuth(openSocket);
    };
    openSocket.onmessage = (event) => {
      if (openSocket !== socket) {
        return;
      }
      handleRelayMessage(event.data);
    };
    openSocket.onerror = () => {
      if (openSocket !== socket) {
        return;
      }
      failAll(new Error("Relay connection failed."));
      socket = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
      scheduleReconnect();
    };
    openSocket.onclose = () => {
      if (openSocket !== socket) {
        return;
      }
      failAll(new Error("Relay connection closed."));
      socket = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
      scheduleReconnect();
    };

    return openSocket;
  };

  const sendAuth = async (openSocket: RelaySocketLike) => {
    try {
      const idToken = await getIdToken();
      if (!idToken) {
        throw new Error("Sign in before connecting to the relay.");
      }

      openSocket.send(
        JSON.stringify({
          type: "auth",
          id_token: idToken
        })
      );
    } catch (error) {
      failAll(error instanceof Error ? error : new Error("Relay authentication failed."));
    }
  };

  const sendInvoke = async (
    desktopId: string,
    payload: Record<string, unknown>
  ): Promise<unknown> => {
    return sendRelayMessage({
      desktopId,
      ...payload
    });
  };

  const sendRelayMessage = async (
    payload: Record<string, unknown>
  ): Promise<unknown> => {
    const openSocket = ensureSocket();
    if (!openSocket) {
      throw new Error(
        "Relay connection is paused while the app is in the background."
      );
    }
    await readyPromise;
    const id = nextId();

    const promise = new Promise<unknown>((resolve, reject) => {
      pendingInvokes.set(id, { resolve, reject });
    });
    openSocket.send(
      JSON.stringify({
        type: "invoke",
        id,
        ...payload
      })
    );

    return promise;
  };

  const handleRelayMessage = (raw: unknown) => {
    if (typeof raw !== "string") {
      return;
    }
    const parsed = parseJsonRecord(raw);
    if (!parsed) {
      return;
    }

    if (parsed.type === "auth_ok") {
      reconnectAttempt = 0;
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      return;
    }

    if (isRelayResponseMessage(parsed)) {
      handleRelayResponse(parsed);
      return;
    }

    if (isRelayEventMessage(parsed)) {
      handleRelayEvent(parsed);
    }
  };

  const handleRelayResponse = (message: RelayResponseMessage) => {
    const id = normalizeRelayId(message.id);
    if (!id) {
      return;
    }

    const pending = pendingInvokes.get(id);
    if (!pending) {
      return;
    }

    pendingInvokes.delete(id);
    const status = typeof message.status === "number" ? message.status : 200;
    if (typeof message.error === "string" && message.error.trim()) {
      // A frame carrying the desktop's own failure status is the desktop
      // answering, not a broken tunnel — the relay's own refusals ("Desktop
      // offline") carry no status. Reporting the two the same way is what put
      // the whole app into its connection-error state over one refused
      // request.
      if (typeof message.status === "number" && message.status >= 400) {
        pending.reject(
          new ServerRefusalError(
            `Remote desktop request failed with status ${message.status}. ${message.error}`,
            null,
            message.status,
            message.error
          )
        );
        return;
      }
      pending.reject(new Error(message.error));
      return;
    }
    if (status >= 400) {
      // Carry the desktop's own explanation and reason. A refusal a person has
      // to act on — a task input held behind an unsent line at that terminal —
      // names the terminal to go press Enter at; a bare status code names
      // nothing, and the reason lets a caller tell it from a broken link.
      const refusal = readServerRefusal(message.body ?? message.data);
      pending.reject(
        new ServerRefusalError(
          `Remote desktop request failed with status ${status}.${
            refusal.message ? ` ${refusal.message}` : ""
          }`,
          refusal.reason,
          status,
          refusal.message
        )
      );
      return;
    }

    pending.resolve(message.body ?? message.data ?? null);
  };


  const handleRelayEvent = (message: RelayEventMessage) => {
    if (!isRecord(message.payload)) {
      return;
    }

    const sessionId = getStringField(message.payload, "session_id");
    if (!sessionId) {
      return;
    }

    const observer = terminalObservers.get(sessionId);
    if (!observer) {
      return;
    }

    switch (message.name) {
      case "terminal_snapshot": {
        const snapshot = message.payload.snapshot;
        if (isRecord(snapshot)) {
          observer.listener({
            type: "output",
            taskId: sessionId,
            dataB64: encodeBase64(getStringField(snapshot, "vt") ?? "")
          });
        }
        break;
      }
      case "terminal_output":
        observer.listener({
          type: "output",
          taskId: sessionId,
          dataB64: getStringField(message.payload, "data_b64") ?? ""
        });
        break;
      case "session_exit":
        observer.listener({
          type: "exit",
          taskId: sessionId,
          code: getNumberField(message.payload, "code") ?? 0
        });
        terminalObservers.delete(sessionId);
        break;
      case "terminal_error":
        observer.listener({
          type: "error",
          taskId: sessionId,
          message: getStringField(message.payload, "message") ?? "Remote terminal failed"
        });
        terminalObservers.delete(sessionId);
        break;
    }
  };

  const failAll = (error: Error) => {
    rejectReady?.(error);
    resolveReady = null;
    rejectReady = null;
    for (const pending of pendingInvokes.values()) {
      pending.reject(error);
    }
    pendingInvokes.clear();
    for (const [taskId, observer] of terminalObservers.entries()) {
      observer.listener({
        type: "error",
        taskId,
        message: error.message
      });
    }
    terminalObservers.clear();
  };

  return {
    close() {
      disposed = true;
      foreground = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      for (const client of streamClients.values()) {
        client.close();
      }
      streamClients.clear();
    },
    setForeground(nextForeground) {
      if (disposed || foreground === nextForeground) {
        return;
      }
      foreground = nextForeground;
      if (!foreground) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        const openSocket = socket;
        socket = null;
        readyPromise = null;
        failAll(
          new Error("Relay connection closed while the app is in the background.")
        );
        openSocket?.close();
        return;
      }
      reconnectAttempt = 0;
      if (hasOpenedControlSocket) ensureSocket();
    },
    invokeDesktop(request: RemoteDesktopInvocationRequest) {
      return sendInvoke(request.desktopId, {
        method: request.method,
        path: request.path,
        body: request.body
      });
    },
    async listActiveDesktopIds() {
      const response = await sendRelayMessage({
        command: "list_active_desktops",
        args: {}
      });
      if (!isRecord(response) || !Array.isArray(response.desktopIds)) {
        return new Set();
      }

      return new Set(
        response.desktopIds.filter(
          (desktopId): desktopId is string =>
            typeof desktopId === "string" && desktopId.length > 0
        )
      );
    },
    observeTaskTerminal({ desktopId, taskId }, listener) {
      const client = streamClientForDesktop(desktopId);
      const connectionListeners =
        terminalConnectionListeners.get(desktopId) ?? new Set<(connected: boolean) => void>();
      terminalConnectionListeners.set(desktopId, connectionListeners);
      const onConnectionChange = (connected: boolean) => {
        listener({ type: "connection", taskId, connected });
      };
      connectionListeners.add(onConnectionChange);
      listener({
        type: "input_availability",
        taskId,
        unavailableReason: "connecting"
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
        onInputAvailabilityChange(availability) {
          listener({
            type: "input_availability",
            taskId,
            unavailableReason:
              availability === "available"
                ? null
                : availability === "unsupported"
                  ? "capability_required"
                  : "connecting"
          });
        },
        onError(code, message) {
          listener({ type: "error", taskId, code, message });
        }
      });

      return {
        close() {
          connectionListeners.delete(onConnectionChange);
          if (connectionListeners.size === 0) {
            terminalConnectionListeners.delete(desktopId);
          }
          client.detach(taskId, "terminal");
        },
        sendInput(dataB64: string, submissionBoundary = false, controlInput = false) {
          if (controlInput) {
            client.sendTermInput(taskId, dataB64, false, true);
          } else if (submissionBoundary) {
            client.sendTermInput(taskId, dataB64, true);
          } else {
            client.sendTermInput(taskId, dataB64);
          }
        },
        resize(cols: number, rows: number) {
          client.sendTermResize(taskId, cols, rows);
        },
        takeControl() {
          client.takeTerminalControl(taskId);
        },
        releaseControl() {
          client.releaseTerminalControl(taskId);
        },
        requestScrollback(request) {
          client.requestTerminalScrollback(taskId, request);
        }
      } satisfies TaskTerminalSubscription;
    },
    observeDesktopTaskSummaries(desktopId, listener) {
      const client = streamClientForDesktop(desktopId);
      client.attachTaskSummaries({
        onSummary(summary) {
          listener({ type: "summary", ...summary });
        },
        onConnectionChange(connected) {
          listener({ type: "connection", connected });
        }
      });
      return {
        close() {
          client.detachTaskSummaries();
        }
      };
    },
    observeTaskAgent({ desktopId, taskId }, listener) {
      const client = new StreamClient({
        url: relayUrl,
        webSocketFactory: createRelayTunnelWebSocketFactory({
          relayUrl,
          desktopId,
          getIdentityToken: (forceRefresh) => getIdToken(forceRefresh),
          webSocketFactory: createSocket,
        }),
        reconnectDelaysMs: [250, 500, 1000, 2000],
        onAuthError,
        agentHistoryWindow: true,
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
        },
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
        },
      } satisfies TaskAgentSubscription;
    },
    observeTaskCompanion({ desktopId, taskId }, listener) {
      const client = streamClientForDesktop(desktopId);
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
        },
        sendEvent(sessionId, revision, event) {
          return client.sendCompanionEvent(taskId, sessionId, revision, event);
        }
      } satisfies TaskCompanionSubscription;
    }
  };
}

function createSequentialIdFactory(): () => string {
  let next = 1;
  return () => `mobile-${next++}`;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRelayId(id: unknown): string | null {
  if (typeof id === "string" && id) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRelayResponseMessage(
  value: Record<string, unknown>
): value is RelayResponseMessage {
  return value.type === "response" && value.id != null;
}

function isRelayEventMessage(value: Record<string, unknown>): value is RelayEventMessage {
  return value.type === "event";
}

function getStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function getNumberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
