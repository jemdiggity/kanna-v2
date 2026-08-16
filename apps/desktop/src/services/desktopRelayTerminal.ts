import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { invoke } from "../invoke";
import { createRelayTunnelWebSocketFactory, StreamClient } from "@kanna/stream-client";
import { createDesktopStreamFrameDecoder } from "./desktopStreamFrameDecoder";
import type {
  DesktopRemoteTaskClient,
} from "./desktopRemoteTaskClient";

export type {
  AdvanceRemoteTaskStageOptions,
  DesktopRemoteTerminalClient as DesktopRelayTerminalClient,
  DesktopRemoteTerminalEvent as DesktopRelayTerminalEvent,
  DesktopRemoteTerminalSubscription as DesktopRelayTerminalSubscription,
  MarkRemoteTaskReadOptions,
  ObserveDesktopRemoteTerminalOptions as ObserveDesktopRelayTerminalOptions,
  ReadRemoteTaskFileOptions,
  RemoteTaskActionOptions as RemoteTerminalActionOptions,
  RemoteTaskFileContent,
  ResizeRemoteTerminalOptions,
  SendRemoteTerminalInputOptions,
} from "./desktopRemoteTaskClient";

export const PRODUCTION_CLOUD_TRANSPORT_URL = "wss://relay.kanna.build";
export const STAGING_CLOUD_TRANSPORT_URL = "wss://relay-staging.kanna.build";

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

function assertSuccessfulTaskAction(
  response: { status: number; body: unknown },
  action: string,
): void {
  if (response.status >= 200 && response.status < 300) return;
  const body = response.body;
  let message: string | null = null;
  if (typeof body === "string" && body.trim()) {
    message = body.trim();
  } else if (body && typeof body === "object") {
    const candidate = body as { error?: unknown; message?: unknown };
    if (typeof candidate.error === "string" && candidate.error.trim()) {
      message = candidate.error.trim();
    } else if (typeof candidate.message === "string" && candidate.message.trim()) {
      message = candidate.message.trim();
    }
  }
  throw new Error(message ?? `Remote ${action} failed with HTTP ${response.status}`);
}

export async function createConfiguredDesktopRelayTerminalClient(): Promise<DesktopRemoteTaskClient | null> {
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
}: DesktopRelayTerminalClientOptions): DesktopRemoteTaskClient {
  const clients = new Map<string, StreamClient>();

  const clientForDesktop = (desktopId: string): StreamClient => {
    const existing = clients.get(desktopId);
    if (existing) return existing;
    const client = new StreamClient({
      url: relayUrl,
      credentialProvider: (forceRefresh) => getIdToken(forceRefresh),
      webSocketFactory: createRelayTunnelWebSocketFactory({
        relayUrl,
        desktopId,
        getIdentityToken: (forceRefresh) => getIdToken(forceRefresh),
        webSocketFactory: createSocket,
      }),
      reconnectDelaysMs: [250, 500, 1000, 2000],
      frameDecoder: createDesktopStreamFrameDecoder(),
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
    observeCompanion(options) {
      const client = clientForDesktop(options.desktopId);
      client.attachCompanion(options.taskId, {
        onSnapshot(snapshot) {
          options.listener({
            type: "snapshot",
            taskId: options.taskId,
            snapshot,
          });
        },
        onUnavailable() {
          options.listener({ type: "unavailable", taskId: options.taskId });
        },
        onEventResult(result) {
          options.listener({
            type: "event_result",
            taskId: options.taskId,
            result,
          });
        },
        onConnectionChange(connected) {
          options.listener({
            type: "connection",
            taskId: options.taskId,
            connected,
          });
        },
        onError(code, message) {
          options.listener({
            type: "error",
            taskId: options.taskId,
            code,
            message,
          });
        },
      });
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          client.detach(options.taskId, "companion");
        },
        sendEvent(sessionId, revision, event) {
          if (closed) return false;
          return client.sendCompanionEvent(
            options.taskId,
            sessionId,
            revision,
            event,
          );
        },
      };
    },
    async sendInput(options) {
      const client = clientForDesktop(options.desktopId);
      const dataB64 = encodeBase64(options.data);
      if (options.controlInput) {
        client.sendTermInput(options.taskId, dataB64, false, true);
      } else if (options.submissionBoundary) {
        client.sendTermInput(options.taskId, dataB64, true);
      } else {
        client.sendTermInput(options.taskId, dataB64);
      }
    },
    async resize(options) {
      clientForDesktop(options.desktopId).sendTermResize(options.taskId, options.cols, options.rows);
    },
    async closeTask(options) {
      const response = await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/close`,
        null,
      );
      assertSuccessfulTaskAction(response, "task close");
    },
    async advanceStage(options) {
      const body = options.expectedTransitionRevision
        ? { expectedTransitionRevision: options.expectedTransitionRevision }
        : {};
      const response = await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/advance-stage`,
        body,
      );
      assertSuccessfulTaskAction(response, "stage advance");
    },
    async readTaskFile(options) {
      const response = await clientForDesktop(options.desktopId).request(
        "GET",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/files/content?path=${encodeURIComponent(options.path)}`,
        null,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Remote task file read failed with HTTP ${response.status}.`);
      }
      const body = response.body;
      if (!isRecord(body) || typeof body.path !== "string" || typeof body.content !== "string") {
        throw new Error("Remote task file response was malformed.");
      }
      return { path: body.path, content: body.content };
    },
    async markTaskRead(options) {
      const response = await clientForDesktop(options.desktopId).request(
        "POST",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/mark-read`,
        { expectedActivityRevision: options.expectedActivityRevision },
      );
      assertSuccessfulTaskAction(response, "mark read");
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
