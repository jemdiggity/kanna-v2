import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { invoke } from "../invoke";
import { createRelayTunnelWebSocketFactory, StreamClient } from "@kanna/stream-client";

export const PRODUCTION_CLOUD_TRANSPORT_URL = "wss://relay.kanna.build";
export const STAGING_CLOUD_TRANSPORT_URL = "wss://relay-staging.kanna.build";

export type DesktopRelayTerminalEvent =
  | { type: "ready"; taskId: string }
  | { type: "output"; taskId: string; text: string }
  | { type: "exit"; taskId: string; code: number }
  | { type: "error"; taskId: string; message: string };

export interface DesktopRelayTerminalSubscription {
  close(): void;
}

interface RelaySocketLike {
  readyState: number;
  close(): void;
  send(data: string): void;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
}

export interface DesktopRelayTerminalClientOptions {
  createSocket?: (url: string) => RelaySocketLike;
  getIdToken(forceRefresh?: boolean): Promise<string | null>;
  relayUrl: string;
}

interface PendingInvoke {
  onSuccess?: () => void;
  reject(error: Error): void;
  resolve(value: unknown): void;
}

export interface ObserveDesktopRelayTerminalOptions {
  desktopId: string;
  taskId: string;
  listener(event: DesktopRelayTerminalEvent): void;
}

export interface RemoteTerminalActionOptions {
  desktopId: string;
  taskId: string;
}

export interface MarkRemoteTaskReadOptions extends RemoteTerminalActionOptions {
  expectedActivityRevision: number;
}

export interface SendRemoteTerminalInputOptions extends RemoteTerminalActionOptions {
  data: string;
}

export interface ResizeRemoteTerminalOptions extends RemoteTerminalActionOptions {
  cols: number;
  rows: number;
}

export interface DesktopRelayTerminalClient {
  close(): void;
  observeTerminal(options: ObserveDesktopRelayTerminalOptions): DesktopRelayTerminalSubscription;
  sendInput(options: SendRemoteTerminalInputOptions): Promise<void>;
  resize(options: ResizeRemoteTerminalOptions): Promise<void>;
  closeTask(options: RemoteTerminalActionOptions): Promise<void>;
  advanceStage(options: RemoteTerminalActionOptions): Promise<void>;
  markTaskRead(options: MarkRemoteTaskReadOptions): Promise<void>;
}

export async function createConfiguredDesktopRelayTerminalClient(): Promise<DesktopRelayTerminalClient | null> {
  const relayUrl = await resolveDesktopRelayUrl();
  if (!relayUrl) return null;
  const authSession = await getConfiguredDesktopAuthSession();
  return createDesktopRelayTerminalClient({
    relayUrl,
    getIdToken: (forceRefresh?: boolean) => authSession.getIdToken(forceRefresh),
  });
}

export async function listActiveDesktopIdsViaRelay(): Promise<Set<string> | null> {
  const relayUrl = await resolveDesktopRelayUrl();
  if (!relayUrl) return null;
  const authSession = await getConfiguredDesktopAuthSession();
  const client = createDesktopRelayRpcClient({
    relayUrl,
    getIdToken: (forceRefresh?: boolean) => authSession.getIdToken(forceRefresh),
  });
  try {
    const response = await client.invoke({
      command: "list_active_desktops",
      args: {},
    });
    const desktopIds = isRecord(response) && Array.isArray(response.desktopIds)
      ? response.desktopIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return new Set(desktopIds);
  } finally {
    client.close();
  }
}

export function createDesktopRelayTerminalClient({
  createSocket = (url) => new WebSocket(url) as unknown as RelaySocketLike,
  getIdToken,
  relayUrl,
}: DesktopRelayTerminalClientOptions): DesktopRelayTerminalClient {
  const clients = new Map<string, StreamClient>();

  const clientForDesktop = (desktopId: string): StreamClient => {
    const existing = clients.get(desktopId);
    if (existing) return existing;
    const client = new StreamClient({
      url: relayUrl,
      credentialProvider: () => getIdToken(),
      webSocketFactory: createRelayTunnelWebSocketFactory({
        relayUrl,
        desktopId,
        getIdentityToken: () => getIdToken(),
        webSocketFactory: createSocket,
      }),
      reconnectDelaysMs: [250, 500, 1000, 2000],
    });
    clients.set(desktopId, client);
    return client;
  };

  return {
    close() {
      for (const client of clients.values()) {
        client.close();
      }
      clients.clear();
    },
    observeTerminal(options) {
      const client = clientForDesktop(options.desktopId);
      client.attachTerminal(options.taskId, {
        onSnapshot(_cols, _rows, dataB64) {
          options.listener({ type: "output", taskId: options.taskId, text: decodeBase64(dataB64) });
          options.listener({ type: "ready", taskId: options.taskId });
        },
        onOutput(dataB64) {
          options.listener({ type: "output", taskId: options.taskId, text: decodeBase64(dataB64) });
        },
        onSessionExit(code) {
          options.listener({ type: "exit", taskId: options.taskId, code });
        },
        onError(_code, message) {
          options.listener({ type: "error", taskId: options.taskId, message });
        },
      });
      return {
        close() {
          client.detach(options.taskId, "terminal");
        },
      };
    },
    async sendInput(options) {
      clientForDesktop(options.desktopId).sendTermInput(options.taskId, encodeBase64(options.data));
    },
    async resize(options) {
      clientForDesktop(options.desktopId).sendTermResize(options.taskId, options.cols, options.rows);
    },
    async closeTask(options) {
      await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/close`,
        null,
      );
    },
    async advanceStage(options) {
      await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/advance-stage`,
        null,
      );
    },
    async markTaskRead(options) {
      await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/mark-read`,
        { expectedActivityRevision: options.expectedActivityRevision },
      );
    },
  };

  let socket: RelaySocketLike | null = null;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let nextId = 1;
  const pendingInvokes = new Map<string, PendingInvoke>();
  const terminalObservers = new Map<string, ObserveDesktopRelayTerminalOptions>();

  const ensureSocket = () => {
    if (socket) return socket;

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
      if (!idToken) throw new Error("Sign in before connecting to the relay.");
      openSocket.send(JSON.stringify({ type: "auth", id_token: idToken }));
    } catch (error) {
      failAll(error instanceof Error ? error : new Error("Relay authentication failed."));
    }
  };

  const sendInvoke = async (
    desktopId: string,
    payload: Record<string, unknown>,
    onSuccess?: () => void,
  ) => {
    const openSocket = ensureSocket();
    if (!readyPromise) throw new Error("Relay connection was not initialized.");
    await readyPromise;
    const id = `desktop-${nextId++}`;
    const promise = new Promise<unknown>((resolve, reject) => {
      pendingInvokes.set(id, { onSuccess, resolve, reject });
    });
    openSocket.send(JSON.stringify({ type: "invoke", id, desktopId, ...payload }));
    return promise;
  };

  const handleRelayMessage = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const parsed = parseJsonRecord(raw);
    if (!parsed) return;
    if (parsed.type === "auth_ok") {
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      return;
    }
    if (parsed.type === "response") {
      handleResponse(parsed);
      return;
    }
    if (parsed.type === "event") {
      handleTerminalEvent(parsed);
    }
  };

  const handleResponse = (message: Record<string, unknown>) => {
    const id = normalizeId(message.id);
    if (!id) return;
    const pending = pendingInvokes.get(id);
    if (!pending) return;
    pendingInvokes.delete(id);
    if (typeof message.error === "string" && message.error.trim()) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.onSuccess?.();
    pending.resolve(message.body ?? message.data ?? null);
  };

  const handleTerminalEvent = (message: Record<string, unknown>) => {
    if (!isRecord(message.payload)) return;
    const payload = message.payload;
    const taskId = getStringField(payload, "session_id");
    if (!taskId) return;
    const observer = terminalObservers.get(taskId);
    if (!observer) return;

    switch (message.name) {
      case "terminal_snapshot": {
        const snapshot = isRecord(payload.snapshot) ? payload.snapshot : null;
        observer.listener({ type: "output", taskId, text: snapshot ? getStringField(snapshot, "vt") ?? "" : "" });
        break;
      }
      case "terminal_output":
        observer.listener({ type: "output", taskId, text: decodeBase64(getStringField(payload, "data_b64") ?? "") });
        break;
      case "session_exit":
        observer.listener({ type: "exit", taskId, code: getNumberField(payload, "code") ?? 0 });
        terminalObservers.delete(taskId);
        break;
      case "terminal_error":
        observer.listener({ type: "error", taskId, message: getStringField(payload, "message") ?? "Remote terminal failed." });
        terminalObservers.delete(taskId);
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
    for (const observer of terminalObservers.values()) {
      observer.listener({ type: "error", taskId: observer.taskId, message: error.message });
    }
    terminalObservers.clear();
  };

  return {
    close() {
      socket?.close();
    },
    observeTerminal(options) {
      terminalObservers.set(options.taskId, options);
      void sendInvoke(options.desktopId, {
        command: "observe_session",
        args: { session_id: options.taskId },
      }, () => {
        options.listener({ type: "ready", taskId: options.taskId });
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          options.listener({
            type: "error",
            taskId: options.taskId,
            message: error instanceof Error ? error.message : "Remote terminal failed.",
          });
        });

      return {
        close() {
          terminalObservers.delete(options.taskId);
          void sendInvoke(options.desktopId, {
            command: "unobserve_session",
            args: { session_id: options.taskId },
          }).catch(() => undefined);
        },
      };
    },
    async sendInput(options) {
      await sendInvoke(options.desktopId, {
        command: "send_input",
        args: { session_id: options.taskId, data: options.data },
      });
    },
    async resize(options) {
      await sendInvoke(options.desktopId, {
        command: "resize_session",
        args: { session_id: options.taskId, cols: options.cols, rows: options.rows },
      });
    },
    async closeTask(options) {
      await sendInvoke(options.desktopId, {
        command: "close_task",
        args: { task_id: options.taskId },
      });
    },
    async advanceStage(options) {
      await sendInvoke(options.desktopId, {
        command: "advance_stage",
        args: { task_id: options.taskId },
      });
    },
    async markTaskRead(options) {
      await sendInvoke(options.desktopId, {
        command: "mark_task_read",
        args: {
          task_id: options.taskId,
          expected_activity_revision: options.expectedActivityRevision,
        },
      });
    },
  };
}

interface DesktopRelayRpcClient {
  close(): void;
  invoke(payload: Record<string, unknown>): Promise<unknown>;
}

function createDesktopRelayRpcClient({
  createSocket = (url) => new WebSocket(url) as unknown as RelaySocketLike,
  getIdToken,
  relayUrl,
}: DesktopRelayTerminalClientOptions): DesktopRelayRpcClient {
  const socket = createSocket(relayUrl);
  let nextId = 1;
  let ready = false;
  const pendingInvokes = new Map<string, PendingInvoke>();
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  socket.onopen = async () => {
    try {
      const idToken = await getIdToken();
      if (!idToken) throw new Error("Sign in before connecting to the relay.");
      socket.send(JSON.stringify({ type: "auth", id_token: idToken }));
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Relay authentication failed."));
    }
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    const parsed = parseJsonRecord(event.data);
    if (!parsed) return;
    if (parsed.type === "auth_ok") {
      ready = true;
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      return;
    }
    if (parsed.type === "response") {
      const id = normalizeId(parsed.id);
      if (!id) return;
      const pending = pendingInvokes.get(id);
      if (!pending) return;
      pendingInvokes.delete(id);
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        pending.reject(new Error(parsed.error));
        return;
      }
      pending.resolve(parsed.data ?? parsed.body ?? null);
    }
  };
  socket.onerror = () => fail(new Error("Relay connection failed."));
  socket.onclose = () => fail(new Error("Relay connection closed."));

  const fail = (error: Error) => {
    if (!ready) rejectReady?.(error);
    resolveReady = null;
    rejectReady = null;
    for (const pending of pendingInvokes.values()) {
      pending.reject(error);
    }
    pendingInvokes.clear();
  };

  return {
    close() {
      socket.close();
    },
    async invoke(payload) {
      await readyPromise;
      const id = `desktop-rpc-${nextId++}`;
      const promise = new Promise<unknown>((resolve, reject) => {
        pendingInvokes.set(id, { resolve, reject });
      });
      const timeout = window.setTimeout(() => {
        const pending = pendingInvokes.get(id);
        if (!pending) return;
        pendingInvokes.delete(id);
        pending.reject(new Error("Relay request timed out."));
      }, 5000);
      socket.send(JSON.stringify({ type: "invoke", id, ...payload }));
      try {
        return await promise;
      } finally {
        window.clearTimeout(timeout);
      }
    },
  };
}

export async function resolveDesktopRelayUrl(): Promise<string | null> {
  const configured = await invoke<string>("read_env_var", { name: "KANNA_RELAY_URL" }).catch(() => "");
  const port = await invoke<string>("read_env_var", { name: "KANNA_RELAY_PORT" }).catch(() => "");
  const cloudEnv = await invoke<string>("read_env_var", { name: "KANNA_CLOUD_ENV" }).catch(() => "");
  return resolveDesktopCloudTransportUrlFromEnv({
    KANNA_RELAY_URL: configured,
    KANNA_RELAY_PORT: port,
    KANNA_CLOUD_ENV: cloudEnv,
  }, { dev: import.meta.env.DEV });
}

export function resolveDesktopCloudTransportUrlFromEnv(
  env: { KANNA_RELAY_URL?: string | null; KANNA_RELAY_PORT?: string | null; KANNA_CLOUD_ENV?: string | null },
  options: { dev: boolean },
): string | null {
  const configured = env.KANNA_RELAY_URL?.trim();
  if (configured) return configured;

  const port = env.KANNA_RELAY_PORT?.trim();
  if (port) return `ws://127.0.0.1:${port}`;

  const cloudEnv = env.KANNA_CLOUD_ENV?.trim().toLowerCase();
  if (cloudEnv === "staging") return STAGING_CLOUD_TRANSPORT_URL;
  if (!options.dev) return PRODUCTION_CLOUD_TRANSPORT_URL;

  return null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    console.debug("[relay-terminal] failed to parse JSON record:", error);
    return null;
  }
}

function normalizeId(id: unknown): string | null {
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function getNumberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

function decodeBase64(value: string): string {
  if (!value) return "";
  const binary = globalThis.atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
