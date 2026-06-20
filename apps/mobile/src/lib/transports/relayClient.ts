import type {
  TaskAgentSubscription,
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../api/client";
import type {
  RemoteDesktopInvocationRequest,
  RemoteDesktopInvoker,
  RemoteTaskAgentObserver,
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
  invokeDesktop: RemoteDesktopInvoker;
  observeTaskTerminal: RemoteTaskTerminalObserver;
  observeTaskAgent: RemoteTaskAgentObserver;
  sendTaskInput(options: { desktopId: string; taskId: string; data: string }): Promise<void>;
}

export interface RelayDesktopClientDependencies {
  createSocket?: RelaySocketFactory;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  nextId?: () => string;
  relayUrl: string;
  /** Called when the relay rejects auth even after a forced token refresh, so
   * the app can surface an auth-expired state and require re-login. */
  onAuthError?(): void;
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
  onAuthError
}: RelayDesktopClientDependencies): RelayDesktopClient {
  let socket: RelaySocketLike | null = null;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const pendingInvokes = new Map<string, PendingInvoke>();
  const terminalObservers = new Map<string, TerminalObserver>();
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
    });
    streamClients.set(desktopId, client);
    return client;
  };

  const ensureSocket = () => {
    if (socket) {
      return socket;
    }

    socket = createSocket(relayUrl);
    readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    socket.onopen = () => {
      void sendAuth(socket!);
    };
    socket.onmessage = (event) => {
      handleRelayMessage(event.data);
    };
    socket.onerror = () => {
      failAll(new Error("Relay connection failed."));
    };
    socket.onclose = () => {
      failAll(new Error("Relay connection closed."));
      socket = null;
      readyPromise = null;
      resolveReady = null;
      rejectReady = null;
    };

    return socket;
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
    const openSocket = ensureSocket();
    await readyPromise;
    const id = nextId();

    const promise = new Promise<unknown>((resolve, reject) => {
      pendingInvokes.set(id, { resolve, reject });
    });
    openSocket.send(
      JSON.stringify({
        type: "invoke",
        id,
        desktopId,
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
      pending.reject(new Error(message.error));
      return;
    }
    if (status >= 400) {
      pending.reject(new Error(`Remote desktop request failed with status ${status}.`));
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
      socket?.close();
      for (const client of streamClients.values()) {
        client.close();
      }
      streamClients.clear();
    },
    invokeDesktop(request: RemoteDesktopInvocationRequest) {
      return sendInvoke(request.desktopId, {
        method: request.method,
        path: request.path,
        body: request.body
      });
    },
    observeTaskTerminal({ desktopId, taskId }, listener) {
      const client = streamClientForDesktop(desktopId);
      client.attachTerminal(taskId, {
        onSnapshot(_cols, _rows, dataB64) {
          listener({ type: "ready", taskId });
          if (dataB64) {
            listener({ type: "output", taskId, dataB64 });
          }
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
          client.detach(taskId, "terminal");
        }
      } satisfies TaskTerminalSubscription;
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
      } satisfies TaskAgentSubscription;
    },
    async sendTaskInput({ desktopId, taskId, data }) {
      streamClientForDesktop(desktopId).sendTermInput(taskId, encodeBase64(data));
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
