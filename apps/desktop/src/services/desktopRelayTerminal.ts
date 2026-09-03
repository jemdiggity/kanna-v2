import { getConfiguredDesktopAuthSession } from "./desktopAuthSdk";
import { invoke } from "../invoke";
import { createRelayTunnelWebSocketFactory, StreamClient } from "@kanna/stream-client";
import { createDesktopStreamFrameDecoder } from "./desktopStreamFrameDecoder";
import type {
  DesktopRemoteTaskClient,
  DesktopRemoteTaskViewClient,
  RemoteTaskDiffContent,
  RemoteTaskDirectoryListing,
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

export async function createConfiguredDesktopRemoteTaskViewClient(): Promise<DesktopRemoteTaskViewClient | null> {
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
}: DesktopRelayTerminalClientOptions): DesktopRemoteTaskViewClient {
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
        onSnapshot(cols, rows, dataB64) {
          options.listener({
            type: "snapshot",
            taskId: options.taskId,
            cols,
            rows,
            data: decodeBase64(dataB64),
          });
        },
        onOutput(dataB64) {
          options.listener({
            type: "output",
            taskId: options.taskId,
            data: decodeBase64(dataB64),
          });
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
    async listTaskDirectory(options) {
      const client = clientForDesktop(options.desktopId);
      const entries: RemoteTaskDirectoryListing["entries"] = [];
      let offset = 0;
      let responsePath = options.path;
      let totalEntries = 0;
      while (true) {
        const response = await client.request(
          "GET",
          `/v1/tasks/${encodeURIComponent(options.taskId)}/browse?path=${encodeURIComponent(options.path)}&showAllFiles=${options.showAllFiles === true}&offset=${offset}&limit=100`,
          null,
        );
        assertSuccessfulTaskAction(response, "task directory read");
        const page = parseTaskDirectoryListing(response.body);
        responsePath = page.path;
        totalEntries = page.totalEntries;
        entries.push(...page.entries);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      return {
        path: responsePath,
        entries,
        offset: 0,
        nextOffset: null,
        totalEntries,
      };
    },
    async readTaskDiff(options) {
      const query = new URLSearchParams({
        scope: options.request.scope,
        mode: options.request.mode,
      });
      const response = await clientForDesktop(options.desktopId).request(
        "GET",
        `/v1/tasks/${encodeURIComponent(options.taskId)}/diff?${query.toString()}`,
        null,
      );
      assertSuccessfulTaskAction(response, "task diff read");
      return parseTaskDiffContent(response.body);
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

export function parseTaskDirectoryListing(value: unknown): RemoteTaskDirectoryListing {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Remote task directory response was malformed.");
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.path !== "string"
      || typeof entry.isDir !== "boolean"
    ) {
      throw new Error("Remote task directory response was malformed.");
    }
    const size = typeof entry.size === "number" || entry.size === null
      ? entry.size
      : undefined;
    return { name: entry.name, path: entry.path, isDir: entry.isDir, size };
  });
  if (
    typeof value.path !== "string"
    || typeof value.offset !== "number"
    || !(typeof value.nextOffset === "number" || value.nextOffset === null)
    || typeof value.totalEntries !== "number"
  ) {
    throw new Error("Remote task directory response was malformed.");
  }
  return {
    path: value.path,
    entries,
    offset: value.offset,
    nextOffset: value.nextOffset,
    totalEntries: value.totalEntries,
  };
}

export function parseTaskDiffContent(value: unknown): RemoteTaskDiffContent {
  if (
    !isRecord(value)
    || typeof value.taskId !== "string"
    || !(typeof value.baseRef === "string" || value.baseRef === null)
    || !(typeof value.mergeBase === "string" || value.mergeBase === null)
    || typeof value.patch !== "string"
    || typeof value.truncated !== "boolean"
  ) {
    throw new Error("Remote task diff response was malformed.");
  }
  return {
    taskId: value.taskId,
    baseRef: value.baseRef,
    mergeBase: value.mergeBase,
    patch: value.patch,
    truncated: value.truncated,
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

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}
