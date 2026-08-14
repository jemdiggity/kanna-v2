// Kanna Stream Protocol client, shared by the desktop (Vue) and mobile
// (React Native) apps. One multiplexed WebSocket carries every stream and
// request; this client owns the auth handshake, per-task attachments with
// seq-resume, request/response correlation, and reconnect with backoff.
//
// Frame types are generated from the Rust source of truth in
// crates/kanna-agent-protocol (see @kanna/agent-protocol).

import type {
  AgentEvent,
  AgentProvider,
  ClientFrame,
  CompanionDocumentKind,
  CompanionEvent,
  FrameAgentEvent,
  KspCapability,
  PermissionDecision,
  ServerFrame,
  StateChangeScope,
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

export interface WebSocketFactoryOptions {
  /** Fetch a freshly-refreshed credential rather than a cached one. Set on the
   * single retry that follows an auth-failure close, so a stale/revoked token
   * is replaced before reconnecting. */
  forceRefreshCredential?: boolean;
}

export type WebSocketFactory = (
  url: string,
  options?: WebSocketFactoryOptions,
) => WebSocketLike;

/**
 * WebSocket close code the relay uses to reject a failed auth handshake (see
 * `services/relay/src/index.ts` — `ws.close(4005, "Authentication failed")`).
 * A close carrying this code before we are authenticated means the credential
 * was invalid/expired/revoked, so the client force-refreshes the token once and
 * retries before giving up.
 */
export const AUTH_FAILURE_CLOSE_CODE = 4005;

export type TaskInputSource =
  | "human"
  | "quick_action"
  | "api"
  | "completion_notification"
  | "stage_post"
  | "system";

/** Validate a complete logical message before a UI submits it. Quick-action
 * templates must be fully rendered; ordinary human/API text is never matched
 * against a phrase blacklist. The server repeats this trust-boundary check. */
export function validateTaskInput(source: TaskInputSource, input: string): void {
  if (source === "quick_action" && /\{[A-Za-z_][A-Za-z0-9_.-]*\}/.test(input)) {
    throw new Error("quick-action input contains an unresolved template placeholder");
  }
}

export interface AgentStreamHandlers {
  /** Journal replay on (re)attach. `nextSeq` is where the live stream resumes. */
  onSnapshot(events: FrameAgentEvent[], nextSeq: number): void;
  onEvent(seq: number, event: AgentEvent): void;
  onStatus?(status: string): void;
  onSessionExit?(code: number): void;
  onError?(code: string, message: string): void;
}

export interface TerminalStreamHandlers {
  onSnapshot?(
    cols: number,
    rows: number,
    dataB64: string,
    agentProvider?: AgentProvider | null,
  ): void;
  onOutput(dataB64: string, metadata: TerminalOutputMetadata): void;
  onStatus?(status: string): void;
  onSessionExit?(code: number): void;
  onError?(code: string, message: string): void;
}

export interface TerminalOutputMetadata {
  /** Local monotonic time at which the WebSocket frame reached dispatch. */
  receivedAtMs: number;
}

export interface CompanionAssetSnapshot {
  name: string;
  contentType: string;
  digest: string;
  dataB64: string;
}

export interface CompanionSnapshot {
  sessionId: string;
  revision: string;
  documentKind: CompanionDocumentKind;
  html: string;
  sourceOrigin?: string;
  assets: CompanionAssetSnapshot[];
}

export interface CompanionEventResult {
  sessionId: string;
  revision: string;
  eventId: string;
  accepted: boolean;
  code?: string;
  message?: string;
}

export interface CompanionStreamHandlers {
  onSnapshot(snapshot: CompanionSnapshot): void;
  onUnavailable(): void;
  onEventResult(result: CompanionEventResult): void;
  onConnectionChange?(connected: boolean): void;
  onError?(code: string, message: string): void;
}

export interface CompanionAttachmentOptions {
  /** Request embedded asset bytes. Defaults to true for desktop and older peers. */
  includeAssets?: boolean;
}

export interface StreamFrameDecoder {
  decode(
    data: string,
    lane?: StreamFrameDecodeLane,
  ): Promise<ServerFrame | null>;
  /** Joins and parses a completed bounded frame assembly in the decoder's
   * worker rather than on the browser UI thread. */
  decodeChunks?(
    chunks: readonly string[],
    lane?: StreamFrameDecodeLane,
  ): Promise<ServerFrame | null>;
  /** Cancels every decode owned by this client. The decoder remains reusable
   * for a later reconnect. */
  cancel(): void;
}

export type StreamFrameDecodeLane = "terminal" | "companion" | "control";

export interface StreamClientOptions {
  /** e.g. ws://127.0.0.1:48120/v1/stream */
  url: string;
  credential?: string;
  credentialProvider?: (forceRefresh?: boolean) => Promise<string | undefined | null>;
  webSocketFactory?: WebSocketFactory;
  /** Reconnect backoff schedule; the last entry repeats. */
  reconnectDelaysMs?: number[];
  onConnectionChange?(connected: boolean): void;
  /** Invoked when the auth handshake is still rejected after a forced token
   * refresh. The client stops reconnecting; callers should surface an
   * auth-expired state and require the user to sign in again. */
  onAuthError?(): void;
  /** Injectable local monotonic clock for terminal dispatch diagnostics. */
  now?: () => number;
  /** Decode large inbound frames away from the UI thread. */
  frameDecoder?: StreamFrameDecoder;
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

interface CompanionAttachment {
  kind: "companion";
  handlers: CompanionStreamHandlers;
  includeAssets: boolean;
  generation: number;
}

type Attachment = AgentAttachment | TerminalAttachment | CompanionAttachment;
type StateChangedListener = (scope: StateChangeScope) => void;

interface PendingRequest {
  resolve(value: { status: number; body: unknown }): void;
  reject(reason: Error): void;
}

interface PendingCompanionEvent {
  taskId: string;
  sessionId: string;
  revision: string;
  attachmentGeneration: number;
}

interface DecodeIngress {
  socket: WebSocketLike;
  retainedBytes: number;
  data?: string;
  chunks?: readonly string[];
  frame?: ServerFrame;
  companionChunkTaskId?: string;
  companionAttachmentGeneration?: number;
  companionChunkAttachmentEpoch?: { value: number | undefined };
  companionGenerationFence: number;
}

interface CompanionChunkAssembly {
  transferId: string;
  nextIndex: number;
  count: number;
  retainedCharacters: number;
  retainedBytes: number;
  chunks: string[];
  attachmentGeneration: number;
  attachmentEpoch: number | undefined;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];
const MAX_PENDING_COMPANION_EVENTS = 1024;
const MAX_COMPANION_CHUNK_COUNT = 512;
const MAX_COMPANION_CHUNK_CHARACTERS = 256 * 1024;
const MAX_COMPANION_ASSEMBLY_CHARACTERS = 64 * 1024 * 1024;
const MAX_LEGAL_COMPANION_BUNDLE_CHARACTERS = 32 * 1024 * 1024;
// A connection may carry two protocol-legal maximum companion bundles at the
// same time. Account the conservative two-byte JS string representation for
// both while keeping one shared, finite admission domain.
const MAX_PENDING_DECODE_BYTES =
  MAX_LEGAL_COMPANION_BUNDLE_CHARACTERS * 2 * 2;

/** Delay before the single force-refresh retry after an auth-failure close. */
const AUTH_RETRY_DELAY_MS = 250;

function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export class StreamClient {
  private readonly options: StreamClientOptions;
  private readonly factory: WebSocketFactory;
  private readonly now: () => number;
  private readonly frameDecoder: StreamFrameDecoder | undefined;
  private socket: WebSocketLike | null = null;
  private authed = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** When set, the next auth handshake refreshes the credential before sending. */
  private forceRefreshNextAuth = false;
  /** Guards the single force-refresh retry per auth-failure episode. */
  private authRetryConsumed = false;
  /** Set when a local credential fetch fails, so the ensuing disconnect is
   * treated as an auth failure even without a relay close code. */
  private authFailurePending = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingCompanionEvents = new Map<string, PendingCompanionEvent>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly companionChunkAssemblies = new Map<
    string,
    CompanionChunkAssembly
  >();
  private readonly stateChangedListeners = new Set<StateChangedListener>();
  private supportedStreamKinds = new Set<StreamKind>();
  private supportedCapabilities = new Set<KspCapability>();
  /** Companion task ids already attached on this socket. A replacement on a
   * peer missing either attachment- or event-epoch support must move to a
   * fresh socket before entering another lifecycle. */
  private readonly companionTasksOnSocket = new Set<string>();
  /** The sole attachment generation on this socket that may consume
   * epoch-less legacy event results. Once the task is replaced, omitted
   * epochs stay bound to the retired generation until a fresh socket makes
   * delayed results impossible. */
  private readonly legacyCompanionResultGenerations = new Map<string, number>();
  /** Frames queued until the auth handshake completes. */
  private sendQueue: ClientFrame[] = [];
  private readonly decodeIngress: Record<
    StreamFrameDecodeLane,
    DecodeIngress[]
  > = {
    terminal: [],
    companion: [],
    control: [],
  };
  private decodeIngressBytes = 0;
  private companionAttachmentGeneration = 0;
  private decodeGeneration = 0;
  private readonly activeDecodeGenerations = new Map<
    StreamFrameDecodeLane,
    number
  >();

  constructor(options: StreamClientOptions) {
    this.options = options;
    this.factory = options.webSocketFactory ?? defaultFactory;
    this.now = options.now ?? (() => performance.now());
    this.frameDecoder = options.frameDecoder;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPendingRequests(new Error("stream client closed"));
    this.pendingCompanionEvents.clear();
    this.companionChunkAssemblies.clear();
    this.resetDecodeIngress();
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

  attachCompanion(
    taskId: string,
    handlers: CompanionStreamHandlers,
    options: CompanionAttachmentOptions = {},
  ): void {
    const includeAssets = options.includeAssets !== false;
    if (this.companionAttachment(taskId)) {
      this.clearPendingCompanionEvents(taskId);
    }
    this.dropCompanionChunkAssembly(taskId);
    this.companionAttachmentGeneration += 1;
    const generation = this.companionAttachmentGeneration;
    this.attachments.set(attachmentKey(taskId, "companion"), {
      kind: "companion",
      handlers,
      includeAssets,
      generation,
    });
    if (this.authed && !this.supports("companion")) {
      handlers.onUnavailable();
      return;
    }
    if (
      this.authed &&
      (!this.supportsCapability("companion_attachment_epoch") ||
        !this.supportsCapability("companion_event_epoch")) &&
      this.companionTasksOnSocket.has(taskId)
    ) {
      this.retireLegacyCompanionSocket();
      return;
    }
    const sent = this.sendFrame({
      type: "attach",
      task_id: taskId,
      kind: "companion",
      from_seq: 0,
      accept_snapshot_chunks: true,
      attachment_epoch: generation,
      include_assets: includeAssets,
    });
    if (sent) this.recordCompanionAttachmentOnSocket(taskId, generation);
  }

  detach(taskId: string, kind: StreamKind): void {
    const attachment = this.attachments.get(attachmentKey(taskId, kind));
    this.attachments.delete(attachmentKey(taskId, kind));
    if (kind === "companion") {
      this.clearPendingCompanionEvents(taskId);
      this.dropCompanionChunkAssembly(taskId);
    }
    if (kind === "companion" && !this.supports("companion")) return;
    this.sendFrame({
      type: "detach",
      task_id: taskId,
      kind,
      ...(attachment?.kind === "companion"
        ? { attachment_epoch: attachment.generation }
        : {}),
    });
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

  sendAgentSetModel(taskId: string, model: string): void {
    this.sendFrame({ type: "agent_set_model", task_id: taskId, model });
  }

  sendTermInput(taskId: string, dataB64: string): void {
    this.sendFrame({ type: "term_input", task_id: taskId, data_b64: dataB64 });
  }

  sendTermResize(taskId: string, cols: number, rows: number): void {
    this.sendFrame({ type: "term_resize", task_id: taskId, cols, rows });
  }

  sendCompanionEvent(
    taskId: string,
    sessionId: string,
    revision: string,
    event: CompanionEvent,
  ): boolean {
    const attachment = this.companionAttachment(taskId);
    if (
      !this.authed ||
      !this.socket ||
      !this.supports("companion") ||
      !attachment
    ) {
      return false;
    }
    if (event.session_id !== sessionId || event.revision !== revision) return false;
    const key = companionEventKey(taskId, event.event_id);
    if (
      this.pendingCompanionEvents.size >= MAX_PENDING_COMPANION_EVENTS &&
      !this.pendingCompanionEvents.has(key)
    ) {
      return false;
    }
    const sent = this.rawSend({
      type: "companion_event",
      task_id: taskId,
      session_id: sessionId,
      revision,
      event,
      attachment_epoch: attachment.generation,
    });
    if (sent) {
      this.pendingCompanionEvents.set(key, {
        taskId,
        sessionId,
        revision,
        attachmentGeneration: attachment.generation,
      });
    }
    return sent;
  }

  onStateChanged(listener: StateChangedListener): () => void {
    this.stateChangedListeners.add(listener);
    return () => {
      this.stateChangedListeners.delete(listener);
    };
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
    this.supportedStreamKinds.clear();
    this.supportedCapabilities.clear();
    this.companionTasksOnSocket.clear();
    this.legacyCompanionResultGenerations.clear();
    const socket = this.factory(this.options.url, {
      forceRefreshCredential: this.forceRefreshNextAuth,
    });
    this.socket = socket;

    socket.onopen = () => {
      void this.sendAuthFrame(socket);
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      if (typeof event.data !== "string") return;
      const data = event.data;
      if (!this.frameDecoder) {
        try {
          this.handleFrame(JSON.parse(data) as ServerFrame);
        } catch {
          // Ignore malformed frames.
        }
        return;
      }
      if (data.startsWith('{"type":"term_output",')) {
        try {
          this.enqueueDecodedFrame(
            socket,
            JSON.parse(data) as ServerFrame,
            data.length * 2,
            "terminal",
          );
        } catch {
          // Ignore malformed terminal frames.
        }
        return;
      }
      this.enqueueDecode(socket, data, decodeLaneForWireFrame(data));
    };
    socket.onclose = (event) => this.handleDisconnect(socket, event);
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private handleDisconnect(socket: WebSocketLike, closeEvent?: unknown): void {
    if (this.closed || socket !== this.socket) return;
    this.socket = null;
    this.resetDecodeIngress();
    const wasAuthed = this.authed;
    this.authed = false;
    this.supportedStreamKinds.clear();
    this.supportedCapabilities.clear();
    this.companionTasksOnSocket.clear();
    this.legacyCompanionResultGenerations.clear();
    this.options.onConnectionChange?.(false);
    this.pendingCompanionEvents.clear();
    this.companionChunkAssemblies.clear();
    for (const attachment of this.attachments.values()) {
      if (attachment.kind === "companion") {
        attachment.handlers.onConnectionChange?.(false);
      }
    }
    this.failPendingRequests(new Error("stream disconnected"));

    // An auth-failure close (or a local credential fetch failure) before we
    // ever authenticated means the credential was rejected — distinct from an
    // ordinary network drop, which keeps the existing backoff reconnect.
    const authFailure =
      this.authFailurePending || (!wasAuthed && isAuthFailureClose(closeEvent));
    this.authFailurePending = false;

    if (authFailure) {
      if (!this.authRetryConsumed) {
        // Force-refresh the credential once and retry promptly.
        this.authRetryConsumed = true;
        this.forceRefreshNextAuth = true;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, AUTH_RETRY_DELAY_MS);
        return;
      }
      // The forced-refresh retry was still rejected: the session is expired.
      // Stop reconnecting and surface the failure so the user can re-login.
      this.closed = true;
      this.forceRefreshNextAuth = false;
      for (const attachment of this.attachments.values()) {
        attachment.handlers.onError?.("auth_expired", "Your session expired. Please sign in again.");
      }
      this.options.onAuthError?.();
      return;
    }

    // Ordinary disconnect (network drop, or a drop after the handshake): the
    // auth handshake itself did not fail this round, so clear any pending
    // force-refresh/retry state and fall back to the normal backoff reconnect.
    this.forceRefreshNextAuth = false;
    this.authRetryConsumed = false;
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
    let provided: string | undefined | null;
    try {
      provided = this.options.credentialProvider
        ? await this.options.credentialProvider(this.forceRefreshNextAuth)
        : this.options.credential;
    } catch {
      // Credential refresh failed (e.g. a revoked session). Drive the socket
      // through the auth-failure disconnect path so the retry/give-up logic runs.
      this.authFailurePending = true;
      if (socket === this.socket) socket.close();
      return;
    }
    if (this.closed || socket !== this.socket) return;
    const credential = provided && provided.trim().length > 0 ? provided : undefined;
    this.rawSend({
      type: "auth",
      ...(credential ? { credential } : {}),
      capabilities: ["companion_event_epoch"],
    }, socket);
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "auth_ok": {
        this.authed = true;
        this.supportedStreamKinds = new Set(
          frame.stream_kinds ?? ["agent", "terminal"],
        );
        this.supportedCapabilities = new Set(frame.capabilities ?? []);
        this.reconnectAttempt = 0;
        this.forceRefreshNextAuth = false;
        this.authRetryConsumed = false;
        this.options.onConnectionChange?.(true);
        for (const attachment of this.attachments.values()) {
          if (attachment.kind === "companion") {
            attachment.handlers.onConnectionChange?.(true);
          }
        }
        // Re-attach everything we track, resuming agent streams from the
        // last seen seq, then flush queued frames.
        for (const [key, attachment] of this.attachments) {
          const { taskId, kind } = parseAttachmentKey(key);
          if (attachment.kind === "companion" && !this.supports("companion")) {
            attachment.handlers.onUnavailable();
            continue;
          }
          const sent = this.rawSend({
            type: "attach",
            task_id: taskId,
            kind,
            from_seq: attachment.kind === "agent" ? attachment.fromSeq : 0,
            ...(attachment.kind === "companion"
              ? {
                  accept_snapshot_chunks: true,
                  attachment_epoch: attachment.generation,
                }
              : {}),
            ...(attachment.kind === "companion"
              ? { include_assets: attachment.includeAssets }
              : {}),
          });
          if (sent && attachment.kind === "companion") {
            this.recordCompanionAttachmentOnSocket(
              taskId,
              attachment.generation,
            );
          }
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
        this.terminalAttachment(frame.task_id)?.handlers.onStatus?.(frame.status);
        return;
      }
      case "state_changed": {
        for (const listener of [...this.stateChangedListeners]) {
          listener(frame.scope);
        }
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
          frame.agent_provider,
        );
        return;
      }
      case "term_output": {
        this.terminalAttachment(frame.task_id)?.handlers.onOutput(frame.data_b64, {
          receivedAtMs: this.now(),
        });
        return;
      }
      case "companion_snapshot": {
        const attachment = this.companionAttachment(frame.task_id);
        if (
          !this.companionFrameMatchesAttachment(
            frame.attachment_epoch,
            attachment,
          )
        ) {
          return;
        }
        this.dropCompanionChunkAssembly(frame.task_id);
        attachment?.handlers.onSnapshot({
          sessionId: frame.session_id,
          revision: frame.revision,
          documentKind: frame.document_kind,
          html: frame.html,
          sourceOrigin:
            typeof frame.source_origin === "string"
              ? frame.source_origin
              : undefined,
          assets: attachment.includeAssets && Array.isArray(frame.assets)
            ? frame.assets
                .filter(isCompanionAssetFrame)
                .map((asset) => ({
                  name: asset.name,
                  contentType: asset.content_type,
                  digest: asset.digest,
                  dataB64: asset.data_b64,
                }))
            : [],
        });
        return;
      }
      case "companion_snapshot_chunk": {
        this.acceptCompanionSnapshotChunk(frame);
        return;
      }
      case "companion_unavailable": {
        const attachment = this.companionAttachment(frame.task_id);
        if (
          this.companionFrameMatchesAttachment(
            frame.attachment_epoch,
            attachment,
          )
        ) {
          attachment?.handlers.onUnavailable();
        }
        return;
      }
      case "companion_event_result": {
        const attachment = this.companionAttachment(frame.task_id);
        const key = companionEventKey(frame.task_id, frame.event_id);
        const pending = this.pendingCompanionEvents.get(key);
        if (!pending || !attachment) return;
        if (pending.attachmentGeneration !== attachment.generation) return;
        if (
          frame.attachment_epoch === undefined
            ? this.supportsCapability("companion_event_epoch") ||
              this.legacyCompanionResultGenerations.get(frame.task_id) !==
                pending.attachmentGeneration
            : !this.companionFrameMatchesAttachment(
                frame.attachment_epoch,
                attachment,
              )
        ) {
          return;
        }
        if (
          frame.session_id != null &&
          frame.session_id !== pending.sessionId
        ) {
          return;
        }
        if (frame.revision != null && frame.revision !== pending.revision) {
          return;
        }
        this.pendingCompanionEvents.delete(key);
        const sessionId = frame.session_id ?? pending.sessionId;
        const revision = frame.revision ?? pending.revision;
        if (!sessionId || !revision) {
          attachment.handlers.onError?.(
            "incompatible_companion_result",
            "The remote companion result is from an incompatible version.",
          );
          return;
        }
        attachment.handlers.onEventResult({
          sessionId,
          revision,
          eventId: frame.event_id,
          accepted: frame.accepted,
          ...(frame.code == null ? {} : { code: frame.code }),
          ...(frame.message == null ? {} : { message: frame.message }),
        });
        return;
      }
      case "companion_error": {
        const attachment = this.companionAttachment(frame.task_id);
        if (
          this.companionFrameMatchesAttachment(
            frame.attachment_epoch,
            attachment,
          )
        ) {
          attachment?.handlers.onError?.(frame.code, frame.message);
        }
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
          this.companionAttachment(frame.task_id)?.handlers.onError?.(frame.code, frame.message);
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

  private companionAttachment(taskId: string): CompanionAttachment | undefined {
    const attachment = this.attachments.get(attachmentKey(taskId, "companion"));
    return attachment?.kind === "companion" ? attachment : undefined;
  }

  private companionFrameMatchesAttachment(
    attachmentEpoch: number | undefined,
    attachment: CompanionAttachment | undefined,
  ): boolean {
    if (
      attachmentEpoch === undefined &&
      !this.supportsCapability("companion_attachment_epoch")
    ) {
      return true;
    }
    return (
      attachment !== undefined &&
      Number.isSafeInteger(attachmentEpoch) &&
      attachmentEpoch === attachment.generation
    );
  }

  private acceptCompanionSnapshotChunk(
    frame: Extract<ServerFrame, { type: "companion_snapshot_chunk" }>,
  ): void {
    const attachment = this.companionAttachment(frame.task_id);
    if (
      !this.companionFrameMatchesAttachment(
        frame.attachment_epoch,
        attachment,
      )
    ) {
      return;
    }
    if (!attachment) {
      this.dropCompanionChunkAssembly(frame.task_id);
      return;
    }
    if (
      !Number.isSafeInteger(frame.index) ||
      !Number.isSafeInteger(frame.count) ||
      frame.index < 0 ||
      frame.count < 1 ||
      frame.count > MAX_COMPANION_CHUNK_COUNT ||
      frame.index >= frame.count ||
      frame.data.length > MAX_COMPANION_CHUNK_CHARACTERS ||
      frame.transfer_id.length === 0
    ) {
      this.dropCompanionChunkAssembly(frame.task_id);
      attachment.handlers.onError?.(
        "invalid_companion_chunks",
        "The remote visual companion was incomplete.",
      );
      return;
    }
    let assembly = this.companionChunkAssemblies.get(frame.task_id);
    if (frame.index === 0) {
      this.dropCompanionChunkAssembly(frame.task_id);
      assembly = {
        transferId: frame.transfer_id,
        nextIndex: 0,
        count: frame.count,
        retainedCharacters: 0,
        retainedBytes: 0,
        chunks: [],
        attachmentGeneration: attachment.generation,
        attachmentEpoch: frame.attachment_epoch,
      };
      this.companionChunkAssemblies.set(frame.task_id, assembly);
    }
    if (
      !assembly ||
      assembly.transferId !== frame.transfer_id ||
      assembly.count !== frame.count ||
      assembly.nextIndex !== frame.index ||
      assembly.retainedCharacters + frame.data.length >
        MAX_COMPANION_ASSEMBLY_CHARACTERS ||
      assembly.attachmentGeneration !== attachment.generation ||
      assembly.attachmentEpoch !== frame.attachment_epoch
    ) {
      this.dropCompanionChunkAssembly(frame.task_id);
      attachment.handlers.onError?.(
        "invalid_companion_chunks",
        "The remote visual companion was incomplete.",
      );
      return;
    }
    const retainedBytes = frame.data.length * 2;
    if (!this.reserveDecodeBytes(retainedBytes)) {
      this.dropCompanionChunkAssembly(frame.task_id);
      attachment.handlers.onError?.(
        "companion_decode_capacity",
        "The remote visual companion exceeded local decode capacity.",
      );
      return;
    }
    assembly.chunks.push(frame.data);
    assembly.retainedCharacters += frame.data.length;
    assembly.retainedBytes += retainedBytes;
    assembly.nextIndex += 1;
    if (assembly.nextIndex !== assembly.count) return;

    this.companionChunkAssemblies.delete(frame.task_id);
    const socket = this.socket;
    if (socket && this.frameDecoder?.decodeChunks) {
      this.enqueueDecodeIngress("companion", {
        socket,
        chunks: assembly.chunks,
        retainedBytes: assembly.retainedBytes,
        companionChunkTaskId: frame.task_id,
        companionAttachmentGeneration: assembly.attachmentGeneration,
        companionChunkAttachmentEpoch: { value: assembly.attachmentEpoch },
        companionGenerationFence: this.companionAttachmentGeneration,
      }, true);
      return;
    }
    try {
      const snapshot = JSON.parse(assembly.chunks.join("")) as ServerFrame;
      if (
        snapshot.type !== "companion_snapshot" ||
        snapshot.task_id !== frame.task_id ||
        snapshot.attachment_epoch !== assembly.attachmentEpoch
      ) {
        throw new Error("chunk payload identity mismatch");
      }
      this.handleFrame(snapshot);
    } catch {
      attachment.handlers.onError?.(
        "invalid_companion_chunks",
        "The remote visual companion was incomplete.",
      );
    } finally {
      this.releaseDecodeBytes(assembly.retainedBytes);
    }
  }

  private clearPendingCompanionEvents(taskId: string): void {
    for (const [key, pending] of this.pendingCompanionEvents) {
      if (pending.taskId === taskId) this.pendingCompanionEvents.delete(key);
    }
  }

  private enqueueDecode(
    socket: WebSocketLike,
    data: string,
    lane: StreamFrameDecodeLane,
  ): void {
    // JS strings may retain two bytes per code unit. Account conservatively
    // before putting the full wire string into a bounded lane.
    const retainedBytes = data.length * 2;
    this.enqueueDecodeIngress(lane, {
      socket,
      data,
      retainedBytes,
      companionGenerationFence: this.companionAttachmentGeneration,
    });
  }

  private enqueueDecodedFrame(
    socket: WebSocketLike,
    frame: ServerFrame,
    retainedBytes: number,
    lane: StreamFrameDecodeLane,
  ): void {
    this.enqueueDecodeIngress(lane, {
      socket,
      frame,
      retainedBytes,
      companionGenerationFence: this.companionAttachmentGeneration,
    });
  }

  private enqueueDecodeIngress(
    lane: StreamFrameDecodeLane,
    ingress: DecodeIngress,
    retainedBytesAlreadyReserved = false,
  ): void {
    if (
      !retainedBytesAlreadyReserved
      && !this.reserveDecodeBytes(ingress.retainedBytes)
    ) {
      this.handleDecodeOverflow(ingress);
      return;
    }
    this.decodeIngress[lane].push(ingress);
    if (!this.activeDecodeGenerations.has(lane)) {
      const generation = this.decodeGeneration;
      this.activeDecodeGenerations.set(lane, generation);
      void this.pumpDecodeIngress(lane, generation);
    }
  }

  private async pumpDecodeIngress(
    lane: StreamFrameDecodeLane,
    generation: number,
  ): Promise<void> {
    try {
      while (generation === this.decodeGeneration) {
        const ingress = this.decodeIngress[lane].shift();
        if (!ingress) return;
        let frame: ServerFrame | null;
        if (ingress.frame) {
          frame = ingress.frame;
        } else if (ingress.chunks) {
          try {
            frame = await this.frameDecoder!.decodeChunks!(
              ingress.chunks,
              lane,
            );
          } catch {
            if (generation === this.decodeGeneration) {
              this.releaseDecodeBytes(ingress.retainedBytes);
              this.handleDecodeOverflow(ingress);
            }
            return;
          }
        } else {
          try {
            frame = await this.frameDecoder!.decode(ingress.data!, lane);
          } catch {
            if (generation === this.decodeGeneration) {
              this.releaseDecodeBytes(ingress.retainedBytes);
              this.handleDecodeOverflow(ingress);
            }
            return;
          }
        }
        if (generation === this.decodeGeneration) {
          this.releaseDecodeBytes(ingress.retainedBytes);
        }
        if (
          generation === this.decodeGeneration &&
          frame &&
          ingress.socket === this.socket
        ) {
          if (
            ingress.companionChunkTaskId &&
            !this.companionIngressIsCurrent(
              ingress.companionChunkTaskId,
              ingress,
            )
          ) {
            continue;
          }
          if (
            ingress.companionChunkTaskId &&
            (
              frame.type !== "companion_snapshot" ||
              frame.task_id !== ingress.companionChunkTaskId ||
              (
                ingress.companionChunkAttachmentEpoch !== undefined &&
                frame.attachment_epoch !==
                  ingress.companionChunkAttachmentEpoch.value
              )
            )
          ) {
            this.companionAttachment(
              ingress.companionChunkTaskId,
            )?.handlers.onError?.(
              "invalid_companion_chunks",
              "The remote visual companion was incomplete.",
            );
            continue;
          }
          const companionTaskId = companionFrameTaskId(frame);
          if (
            companionTaskId !== null &&
            !this.companionIngressIsCurrent(companionTaskId, ingress)
          ) {
            continue;
          }
          this.handleFrame(frame);
        }
      }
    } finally {
      if (this.activeDecodeGenerations.get(lane) === generation) {
        this.activeDecodeGenerations.delete(lane);
        if (this.decodeIngress[lane].length > 0) {
          const nextGeneration = this.decodeGeneration;
          this.activeDecodeGenerations.set(lane, nextGeneration);
          void this.pumpDecodeIngress(lane, nextGeneration);
        }
      }
    }
  }

  private companionIngressIsCurrent(
    taskId: string,
    ingress: DecodeIngress,
  ): boolean {
    const attachment = this.companionAttachment(taskId);
    if (!attachment) return false;
    return ingress.companionAttachmentGeneration === undefined
      ? attachment.generation <= ingress.companionGenerationFence
      : attachment.generation === ingress.companionAttachmentGeneration;
  }

  private handleDecodeOverflow(ingress: DecodeIngress): void {
    if (ingress.socket !== this.socket) return;
    if (ingress.companionChunkTaskId) {
      this.companionAttachment(
        ingress.companionChunkTaskId,
      )?.handlers.onError?.(
        "companion_decode_capacity",
        "The remote visual companion exceeded local decode capacity.",
      );
      return;
    }
    for (const attachment of this.attachments.values()) {
      attachment.handlers.onError?.(
        "stream_decode_capacity",
        "The desktop could not decode an incoming update within its local capacity.",
      );
    }
  }

  private reserveDecodeBytes(bytes: number): boolean {
    if (bytes < 0 || this.decodeIngressBytes + bytes > MAX_PENDING_DECODE_BYTES) {
      return false;
    }
    this.decodeIngressBytes += bytes;
    return true;
  }

  private releaseDecodeBytes(bytes: number): void {
    this.decodeIngressBytes = Math.max(0, this.decodeIngressBytes - bytes);
  }

  private dropCompanionChunkAssembly(taskId: string): void {
    const assembly = this.companionChunkAssemblies.get(taskId);
    if (!assembly) return;
    this.companionChunkAssemblies.delete(taskId);
    this.releaseDecodeBytes(assembly.retainedBytes);
  }

  private resetDecodeIngress(): void {
    this.decodeGeneration += 1;
    this.decodeIngress.terminal = [];
    this.decodeIngress.companion = [];
    this.decodeIngress.control = [];
    this.decodeIngressBytes = 0;
    this.activeDecodeGenerations.clear();
    this.frameDecoder?.cancel();
  }

  private supports(kind: StreamKind): boolean {
    return this.supportedStreamKinds.has(kind);
  }

  private supportsCapability(capability: KspCapability): boolean {
    return this.supportedCapabilities.has(capability);
  }

  private retireLegacyCompanionSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.close();
    this.handleDisconnect(socket);
  }

  private recordCompanionAttachmentOnSocket(
    taskId: string,
    generation: number,
  ): void {
    if (
      !this.supportsCapability("companion_event_epoch") &&
      !this.companionTasksOnSocket.has(taskId)
    ) {
      this.legacyCompanionResultGenerations.set(taskId, generation);
    }
    this.companionTasksOnSocket.add(taskId);
  }

  private sendFrame(frame: ClientFrame): boolean {
    if (!this.authed || !this.socket) {
      // Attachment state is re-sent from the registry on auth. Neither edge
      // of that state transition belongs in the reconnect replay queue.
      if (frame.type !== "attach" && frame.type !== "detach") {
        this.sendQueue.push(frame);
      }
      return false;
    }
    return this.rawSend(frame);
  }

  private rawSend(frame: ClientFrame, socket = this.socket): boolean {
    try {
      if (socket !== this.socket || !socket) return false;
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // Socket died between checks; the close handler reconnects.
      return false;
    }
  }
}

function isAuthFailureClose(event: unknown): boolean {
  return closeEventCode(event) === AUTH_FAILURE_CLOSE_CODE;
}

function closeEventCode(event: unknown): number | null {
  if (typeof event === "object" && event !== null && "code" in event) {
    const code = (event as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }
  return null;
}

function attachmentKey(taskId: string, kind: StreamKind): string {
  return `${kind}:${taskId}`;
}

function companionFrameTaskId(frame: ServerFrame): string | null {
  switch (frame.type) {
    case "companion_snapshot":
    case "companion_snapshot_chunk":
    case "companion_unavailable":
    case "companion_error":
    case "companion_event_result":
      return frame.task_id;
    default:
      return null;
  }
}

function companionEventKey(taskId: string, eventId: string): string {
  return JSON.stringify([taskId, eventId]);
}

function decodeLaneForWireFrame(data: string): StreamFrameDecodeLane {
  if (
    data.startsWith('{"type":"term_snapshot",') ||
    data.startsWith('{"type":"term_output",')
  ) {
    return "terminal";
  }
  if (data.startsWith('{"type":"companion_')) {
    return "companion";
  }
  return "control";
}

function parseAttachmentKey(key: string): { taskId: string; kind: StreamKind } {
  const separator = key.indexOf(":");
  return {
    kind: key.slice(0, separator) as StreamKind,
    taskId: key.slice(separator + 1),
  };
}

function isCompanionAssetFrame(
  value: unknown,
): value is {
  name: string;
  content_type: string;
  digest: string;
  data_b64: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.name === "string" &&
    typeof asset.content_type === "string" &&
    typeof asset.digest === "string" &&
    typeof asset.data_b64 === "string"
  );
}

export interface RelayTunnelOptions {
  relayUrl: string;
  desktopId: string;
  getIdentityToken(forceRefresh?: boolean): Promise<string | null | undefined>;
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
  return (_url, options) =>
    new RelayTunnelSocket(
      relayUrl,
      desktopId,
      getIdentityToken,
      webSocketFactory,
      nextId,
      options?.forceRefreshCredential ?? false,
    );
}

class RelayTunnelSocket implements WebSocketLike {
  private readonly socket: WebSocketLike;
  private readonly queued: string[] = [];
  private identityToken: string | null = null;
  private ready = false;
  private closed = false;
  private closeNotified = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(
    relayUrl: string,
    private readonly desktopId: string,
    private readonly getIdentityToken: (
      forceRefresh?: boolean,
    ) => Promise<string | null | undefined>,
    webSocketFactory: WebSocketFactory,
    private readonly nextId: () => string,
    private readonly forceRefreshCredential: boolean,
  ) {
    this.socket = webSocketFactory(relayUrl);
    this.socket.onopen = () => {
      void this.authenticate();
    };
    this.socket.onmessage = (event) => this.handleMessage(event.data);
    this.socket.onerror = (event) => this.onerror?.(event);
    this.socket.onclose = (event) => this.emitClose(event);
  }

  /** Forward a single close to the owning StreamClient. The relay close code
   * (e.g. 4005) flows through here so the client can recognise auth failures;
   * a synthetic auth-failure code is emitted when our own token fetch fails. */
  private emitClose(event: unknown): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.(event);
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
      const token = await this.getIdentityToken(this.forceRefreshCredential);
      if (!token) {
        throw new Error("Sign in before opening a relay tunnel.");
      }
      this.identityToken = token;
      this.socket.send(JSON.stringify({ type: "auth", id_token: token }));
    } catch (error) {
      this.onerror?.(error);
      // Surface as an auth failure so the StreamClient force-refreshes once and
      // then gives up rather than reconnecting forever with a bad token.
      this.emitClose({ code: AUTH_FAILURE_CLOSE_CODE, reason: "relay tunnel auth failed" });
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
          service: "ksp",
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
      this.onmessage?.({
        data: JSON.stringify({
          type: "error",
          code: "relay_tunnel",
          message: parsed.error,
        }),
      });
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
