// Kanna Stream Protocol client, shared by the desktop (Vue) and mobile
// (React Native) apps. One multiplexed WebSocket carries every stream and
// request; this client owns the auth handshake, per-task attachments with
// seq-resume, request/response correlation, and reconnect with backoff.
//
// Frame types are generated from the Rust source of truth in
// crates/kanna-agent-protocol (see @kanna/agent-protocol).

import type {
  AgentEvent,
  ClientFrame,
  FrameAgentEvent,
  PermissionDecision,
  ServerFrame,
  StreamKind,
} from "@kanna/agent-protocol";

/** Minimal WebSocket surface so tests and non-browser runtimes can inject
 * their own implementation. Matches the browser WebSocket API subset used. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface AgentStreamHandlers {
  /** Journal replay on (re)attach. `nextSeq` is where the live stream resumes. */
  onSnapshot(events: FrameAgentEvent[], nextSeq: number): void;
  onEvent(seq: number, event: AgentEvent): void;
  onStatus?(status: string): void;
  onSessionExit?(code: number): void;
  onError?(code: string, message: string): void;
}

export interface TerminalStreamHandlers {
  onSnapshot?(cols: number, rows: number, dataB64: string): void;
  onOutput(dataB64: string): void;
  onSessionExit?(code: number): void;
  onError?(code: string, message: string): void;
}

export interface StreamClientOptions {
  /** e.g. ws://127.0.0.1:48120/v1/stream */
  url: string;
  credential?: string;
  credentialProvider?: () => Promise<string | undefined | null>;
  webSocketFactory?: WebSocketFactory;
  /** Reconnect backoff schedule; the last entry repeats. */
  reconnectDelaysMs?: number[];
  onConnectionChange?(connected: boolean): void;
}

interface AgentAttachment {
  kind: "agent";
  handlers: AgentStreamHandlers;
  /** Resume point: the next seq we have not seen yet. */
  fromSeq: number;
}

interface TerminalAttachment {
  kind: "terminal";
  handlers: TerminalStreamHandlers;
}

type Attachment = AgentAttachment | TerminalAttachment;

interface PendingRequest {
  resolve(value: { status: number; body: unknown }): void;
  reject(reason: Error): void;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class StreamClient {
  private readonly options: StreamClientOptions;
  private readonly factory: WebSocketFactory;
  private socket: WebSocketLike | null = null;
  private authed = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly attachments = new Map<string, Attachment>();
  /** Frames queued until the auth handshake completes. */
  private sendQueue: ClientFrame[] = [];

  constructor(options: StreamClientOptions) {
    this.options = options;
    this.factory = options.webSocketFactory ?? defaultFactory;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPendingRequests(new Error("stream client closed"));
    this.socket?.close();
    this.socket = null;
  }

  attachAgent(taskId: string, handlers: AgentStreamHandlers, fromSeq = 0): void {
    this.attachments.set(attachmentKey(taskId, "agent"), {
      kind: "agent",
      handlers,
      fromSeq,
    });
    this.sendFrame({ type: "attach", task_id: taskId, kind: "agent", from_seq: fromSeq });
  }

  attachTerminal(taskId: string, handlers: TerminalStreamHandlers): void {
    this.attachments.set(attachmentKey(taskId, "terminal"), {
      kind: "terminal",
      handlers,
    });
    this.sendFrame({ type: "attach", task_id: taskId, kind: "terminal", from_seq: 0 });
  }

  detach(taskId: string, kind: StreamKind): void {
    this.attachments.delete(attachmentKey(taskId, kind));
    this.sendFrame({ type: "detach", task_id: taskId, kind });
  }

  sendAgentInput(taskId: string, text: string): void {
    this.sendFrame({ type: "agent_input", task_id: taskId, text });
  }

  sendAgentPermission(taskId: string, requestId: string, decision: PermissionDecision): void {
    this.sendFrame({
      type: "agent_permission",
      task_id: taskId,
      request_id: requestId,
      decision,
    });
  }

  sendAgentInterrupt(taskId: string): void {
    this.sendFrame({ type: "agent_interrupt", task_id: taskId });
  }

  sendTermInput(taskId: string, dataB64: string): void {
    this.sendFrame({ type: "term_input", task_id: taskId, data_b64: dataB64 });
  }

  sendTermResize(taskId: string, cols: number, rows: number): void {
    this.sendFrame({ type: "term_resize", task_id: taskId, cols, rows });
  }

  /** Task-API request over the stream (replaces REST calls). */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const id = this.nextRequestId++;
    const promise = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    this.sendFrame({
      type: "request",
      id,
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
    return promise;
  }

  // ---- internals ----

  private connect(): void {
    if (this.closed) return;
    this.authed = false;
    const socket = this.factory(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      void this.sendAuthFrame(socket);
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      if (typeof event.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    socket.onclose = () => this.handleDisconnect(socket);
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private handleDisconnect(socket: WebSocketLike): void {
    if (this.closed || socket !== this.socket) return;
    this.socket = null;
    this.authed = false;
    this.options.onConnectionChange?.(false);
    this.failPendingRequests(new Error("stream disconnected"));
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_BACKOFF_MS;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failPendingRequests(reason: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
  }

  private async sendAuthFrame(socket: WebSocketLike): Promise<void> {
    const provided = this.options.credentialProvider
      ? await this.options.credentialProvider()
      : this.options.credential;
    if (this.closed || socket !== this.socket) return;
    const credential = provided && provided.trim().length > 0 ? provided : undefined;
    this.rawSend({ type: "auth", ...(credential ? { credential } : {}) }, socket);
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "auth_ok": {
        this.authed = true;
        this.reconnectAttempt = 0;
        this.options.onConnectionChange?.(true);
        // Re-attach everything we track, resuming agent streams from the
        // last seen seq, then flush queued frames.
        for (const [key, attachment] of this.attachments) {
          const { taskId, kind } = parseAttachmentKey(key);
          this.rawSend({
            type: "attach",
            task_id: taskId,
            kind,
            from_seq: attachment.kind === "agent" ? attachment.fromSeq : 0,
          });
        }
        const queued = this.sendQueue;
        this.sendQueue = [];
        for (const frame of queued) {
          this.rawSend(frame);
        }
        return;
      }
      case "agent_snapshot": {
        const attachment = this.agentAttachment(frame.task_id);
        if (!attachment) return;
        attachment.fromSeq = Number(frame.next_seq);
        attachment.handlers.onSnapshot(frame.events, Number(frame.next_seq));
        return;
      }
      case "agent_event": {
        const attachment = this.agentAttachment(frame.task_id);
        if (!attachment) return;
        attachment.fromSeq = Number(frame.seq) + 1;
        attachment.handlers.onEvent(Number(frame.seq), frame.event);
        return;
      }
      case "status_changed": {
        this.agentAttachment(frame.task_id)?.handlers.onStatus?.(frame.status);
        return;
      }
      case "session_exit": {
        this.agentAttachment(frame.task_id)?.handlers.onSessionExit?.(frame.code);
        this.terminalAttachment(frame.task_id)?.handlers.onSessionExit?.(frame.code);
        return;
      }
      case "term_snapshot": {
        this.terminalAttachment(frame.task_id)?.handlers.onSnapshot?.(
          frame.cols,
          frame.rows,
          frame.data_b64,
        );
        return;
      }
      case "term_output": {
        this.terminalAttachment(frame.task_id)?.handlers.onOutput(frame.data_b64);
        return;
      }
      case "response": {
        const pending = this.pendingRequests.get(Number(frame.id));
        if (pending) {
          this.pendingRequests.delete(Number(frame.id));
          pending.resolve({ status: frame.status, body: frame.body ?? null });
        }
        return;
      }
      case "error": {
        if (frame.task_id) {
          this.agentAttachment(frame.task_id)?.handlers.onError?.(frame.code, frame.message);
          this.terminalAttachment(frame.task_id)?.handlers.onError?.(frame.code, frame.message);
        } else {
          for (const attachment of this.attachments.values()) {
            attachment.handlers.onError?.(frame.code, frame.message);
          }
        }
        return;
      }
    }
  }

  private agentAttachment(taskId: string): AgentAttachment | undefined {
    const attachment = this.attachments.get(attachmentKey(taskId, "agent"));
    return attachment?.kind === "agent" ? attachment : undefined;
  }

  private terminalAttachment(taskId: string): TerminalAttachment | undefined {
    const attachment = this.attachments.get(attachmentKey(taskId, "terminal"));
    return attachment?.kind === "terminal" ? attachment : undefined;
  }

  private sendFrame(frame: ClientFrame): void {
    if (!this.authed || !this.socket) {
      // Attaches are re-sent from the attachment registry on auth; queue
      // everything else.
      if (frame.type !== "attach") {
        this.sendQueue.push(frame);
      }
      return;
    }
    this.rawSend(frame);
  }

  private rawSend(frame: ClientFrame, socket = this.socket): void {
    try {
      if (socket !== this.socket) return;
      socket?.send(JSON.stringify(frame));
    } catch {
      // Socket died between checks; the close handler reconnects.
    }
  }
}

function attachmentKey(taskId: string, kind: StreamKind): string {
  return `${kind}:${taskId}`;
}

function parseAttachmentKey(key: string): { taskId: string; kind: StreamKind } {
  const separator = key.indexOf(":");
  return {
    kind: key.slice(0, separator) as StreamKind,
    taskId: key.slice(separator + 1),
  };
}

export interface RelayTunnelOptions {
  relayUrl: string;
  desktopId: string;
  getIdentityToken(): Promise<string | null | undefined>;
  webSocketFactory?: WebSocketFactory;
  nextId?: () => string;
}

export function createRelayTunnelWebSocketFactory({
  relayUrl,
  desktopId,
  getIdentityToken,
  webSocketFactory = defaultFactory,
  nextId = createSequentialTunnelId,
}: RelayTunnelOptions): WebSocketFactory {
  return () =>
    new RelayTunnelSocket(
      relayUrl,
      desktopId,
      getIdentityToken,
      webSocketFactory,
      nextId,
    );
}

class RelayTunnelSocket implements WebSocketLike {
  private readonly socket: WebSocketLike;
  private readonly queued: string[] = [];
  private identityToken: string | null = null;
  private ready = false;
  private closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(
    relayUrl: string,
    private readonly desktopId: string,
    private readonly getIdentityToken: () => Promise<string | null | undefined>,
    webSocketFactory: WebSocketFactory,
    private readonly nextId: () => string,
  ) {
    this.socket = webSocketFactory(relayUrl);
    this.socket.onopen = () => {
      void this.authenticate();
    };
    this.socket.onmessage = (event) => this.handleMessage(event.data);
    this.socket.onerror = (event) => this.onerror?.(event);
    this.socket.onclose = (event) => this.onclose?.(event);
  }

  send(data: string): void {
    if (!this.ready) {
      this.queued.push(data);
      return;
    }
    this.sendTunnelData(data);
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  private async authenticate(): Promise<void> {
    try {
      const token = await this.getIdentityToken();
      if (!token) {
        throw new Error("Sign in before opening a relay tunnel.");
      }
      this.identityToken = token;
      this.socket.send(JSON.stringify({ type: "auth", id_token: token }));
    } catch (error) {
      this.onerror?.(error);
      this.close();
    }
  }

  private handleMessage(data: unknown): void {
    if (this.ready) {
      this.onmessage?.({ data });
      return;
    }
    if (typeof data !== "string") {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === "auth_ok") {
      this.socket.send(
        JSON.stringify({
          type: "tunnel_request",
          id: this.nextId(),
          desktopId: this.desktopId,
        }),
      );
      return;
    }

    if (parsed.type === "tunnel_ready") {
      this.ready = true;
      this.onopen?.({});
      for (const frame of this.queued.splice(0)) {
        this.sendTunnelData(frame);
      }
      return;
    }

    if (parsed.type === "response" && typeof parsed.error === "string") {
      this.onerror?.(new Error(parsed.error));
      if (!this.closed) this.close();
    }
  }

  private sendTunnelData(data: string): void {
    this.socket.send(this.withIdentityCredential(data));
  }

  private withIdentityCredential(data: string): string {
    if (!this.identityToken) return data;
    try {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (frame.type !== "auth") return data;
      if (typeof frame.credential === "string" && frame.credential.trim().length > 0) {
        return data;
      }
      return JSON.stringify({ ...frame, credential: this.identityToken });
    } catch {
      return data;
    }
  }
}

function createSequentialTunnelId(): string {
  return `tunnel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
