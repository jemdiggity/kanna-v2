import type {
  TaskTerminalStreamEvent,
  TaskTerminalSubscription
} from "../api/client";
import type {
  RemoteDesktopInvocationRequest,
  RemoteDesktopInvoker,
  RemoteTaskTerminalObserver
} from "./remoteTransport";

export interface RelaySocketLike {
  readyState: number;
  close(): void;
  send(data: string): void;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayDesktopClient {
  close(): void;
  invokeDesktop: RemoteDesktopInvoker;
  observeTaskTerminal: RemoteTaskTerminalObserver;
  sendTaskInput(options: { desktopId: string; taskId: string; data: string }): Promise<void>;
}

export interface RelayDesktopClientDependencies {
  createSocket?: RelaySocketFactory;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  nextId?: () => string;
  relayUrl: string;
}

interface PendingInvoke {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

interface TerminalObserver {
  decoder: TextDecoder;
  desktopId: string;
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
  relayUrl
}: RelayDesktopClientDependencies): RelayDesktopClient {
  let socket: RelaySocketLike | null = null;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const pendingInvokes = new Map<string, PendingInvoke>();
  const terminalObservers = new Map<string, TerminalObserver>();

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

  const handleRelayMessage = (raw: string) => {
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
            text: getStringField(snapshot, "vt") ?? ""
          });
        }
        break;
      }
      case "terminal_output":
        observer.listener({
          type: "output",
          taskId: sessionId,
          text: decodeBase64(
            getStringField(message.payload, "data_b64") ?? "",
            observer.decoder
          )
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
    },
    invokeDesktop(request: RemoteDesktopInvocationRequest) {
      return sendInvoke(request.desktopId, {
        method: request.method,
        path: request.path,
        body: request.body
      });
    },
    observeTaskTerminal({ desktopId, taskId }, listener) {
      terminalObservers.set(taskId, { decoder: new TextDecoder(), desktopId, listener });
      void sendInvoke(desktopId, {
        command: "observe_session",
        args: { session_id: taskId }
      })
        .then(() => {
          listener({ type: "ready", taskId });
        })
        .catch((error: unknown) => {
          listener({
            type: "error",
            taskId,
            message: error instanceof Error ? error.message : "Remote terminal failed"
          });
        });

      return {
        close() {
          terminalObservers.delete(taskId);
          void sendInvoke(desktopId, {
            command: "unobserve_session",
            args: { session_id: taskId }
          }).catch(() => undefined);
        }
      } satisfies TaskTerminalSubscription;
    },
    async sendTaskInput({ desktopId, taskId, data }) {
      await sendInvoke(desktopId, {
        command: "send_input",
        args: { session_id: taskId, data }
      });
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

function decodeBase64(value: string, decoder = new TextDecoder()): string {
  if (!value) {
    return "";
  }

  const binary = globalThis.atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return decoder.decode(bytes, { stream: true });
}
