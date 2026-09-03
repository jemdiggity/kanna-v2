import { invoke } from "../invoke";
import { listen } from "../listen";
import type {
  DesktopRelayTerminalEvent,
  DesktopRelayTerminalSubscription,
  ObserveDesktopRelayTerminalOptions,
} from "./desktopRelayTerminal";
import type {
  DesktopRemoteCompanionEvent,
  DesktopRemoteCompanionSubscription,
  DesktopRemoteTaskClient,
  DesktopRemoteTaskViewClient,
  ObserveDesktopRemoteCompanionOptions,
  RemoteTaskDirectoryListing,
} from "./desktopRemoteTaskClient";
import { parseTaskDiffContent, parseTaskDirectoryListing } from "./desktopRelayTerminal";

const companionGenerationProcessNonce = createCompanionGenerationProcessNonce();
let companionGenerationCounter = 0;

export async function createConfiguredDesktopLanTerminalClient(): Promise<DesktopRemoteTaskClient> {
  return createDesktopLanTerminalClient();
}

export async function createConfiguredDesktopLanTaskViewClient(): Promise<DesktopRemoteTaskViewClient> {
  return createDesktopLanTerminalClient();
}

export function createDesktopLanTerminalClient(): DesktopRemoteTaskViewClient {
  interface ObserverRecord {
    leaseId: string;
    options: ObserveDesktopRelayTerminalOptions;
  }
  const observers = new Map<string, ObserverRecord>();
  type CompanionObserver = {
    subscriptionGeneration: string;
    attemptGeneration: string;
    options: ObserveDesktopRemoteCompanionOptions;
    retryIndex: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
    connected: boolean;
    sending: boolean;
    failedGeneration: string | null;
    sidecarIncarnation: number | null;
  };
  const companionObservers = new Map<string, CompanionObserver>();
  const reconnectDelaysMs = [250, 500, 1_000, 2_000];
  let terminalUnlistenPromise: Promise<() => void> | null = null;
  let companionUnlistenPromise: Promise<() => void> | null = null;
  let sidecarLifecycleUnlistenPromise: Promise<() => void> | null = null;
  let latestExitedSidecarIncarnation = 0;

  const ensureTerminalListener = () => {
    terminalUnlistenPromise ??= listen("transfer-terminal-event", (event) => {
      handleTransferTerminalEvent(event.payload as Record<string, unknown>);
    });
    return terminalUnlistenPromise;
  };

  const ensureCompanionListener = () => {
    companionUnlistenPromise ??= listen("transfer-companion-event", (event) => {
      handleTransferCompanionEvent(event.payload);
    });
    return companionUnlistenPromise;
  };

  const ensureSidecarLifecycleListener = () => {
    sidecarLifecycleUnlistenPromise ??= listen(
      "transfer-sidecar-exited",
      (event) => {
        const payload = asRecord(event.payload);
        const incarnation = payload?.incarnation;
        if (typeof incarnation !== "number" || !Number.isSafeInteger(incarnation)) return;
        if (incarnation <= latestExitedSidecarIncarnation) return;
        latestExitedSidecarIncarnation = incarnation;
        for (const entry of companionObservers.values()) {
          if (!isCurrentCompanion(entry)) continue;
          if (entry.sidecarIncarnation !== incarnation) continue;
          const generation = entry.attemptGeneration;
          if (
            entry.failedGeneration === generation
            && !entry.connected
          ) {
            continue;
          }
          entry.failedGeneration = generation;
          entry.connected = false;
          entry.sending = false;
          entry.options.listener({
            type: "connection",
            taskId: entry.options.taskId,
            connected: false,
          });
          scheduleCompanionRetry(entry);
        }
      },
    );
    return sidecarLifecycleUnlistenPromise;
  };

  const handleTransferTerminalEvent = (payload: Record<string, unknown>) => {
    const peerId = getStringField(payload, "peer_id") ?? getStringField(payload, "peerId");
    const sessionId = getStringField(payload, "session_id") ?? getStringField(payload, "sessionId");
    const observerLeaseId =
      getStringField(payload, "observer_lease_id")
      ?? getStringField(payload, "observerLeaseId");
    const event = asRecord(payload.event);
    if (!peerId || !sessionId || !observerLeaseId || !event) return;
    const observer = observers.get(observerKey(peerId, sessionId));
    if (!observer || observer.leaseId !== observerLeaseId) return;
    const normalized = normalizeTerminalEvent(sessionId, event);
    if (normalized) observer.options.listener(normalized);
  };

  const handleTransferCompanionEvent = (value: unknown) => {
    const payload = asRecord(value);
    if (!payload) return;
    const incarnation = payload.incarnation;
    const peerId = getStringField(payload, "peer_id") ?? getStringField(payload, "peerId");
    const taskId = getStringField(payload, "task_id") ?? getStringField(payload, "taskId");
    const generation = getStringField(payload, "generation");
    const frame = asRecord(payload.frame);
    if (
      typeof incarnation !== "number"
      || !Number.isSafeInteger(incarnation)
      || incarnation <= latestExitedSidecarIncarnation
      || !peerId
      || !taskId
      || !generation
      || !frame
    ) return;
    const entry = companionObservers.get(companionObserverKey(peerId, taskId));
    if (!entry || entry.attemptGeneration !== generation) return;
    if (
      entry.sidecarIncarnation !== null
      && entry.sidecarIncarnation !== incarnation
    ) return;
    const normalized = normalizeCompanionEvent(taskId, frame);
    if (!normalized) return;
    if (
      normalized.type === "error"
      && normalized.code === "connection_failed"
    ) {
      entry.failedGeneration = generation;
      entry.connected = false;
      entry.sending = false;
      entry.options.listener({
        type: "connection",
        taskId,
        connected: false,
      });
      scheduleCompanionRetry(entry);
      return;
    }
    entry.options.listener(normalized);
  };

  const isCurrentCompanion = (entry: CompanionObserver) =>
    companionObservers.get(
      companionObserverKey(entry.options.desktopId, entry.options.taskId),
    )?.subscriptionGeneration === entry.subscriptionGeneration;

  const startCompanionAttempt = async (entry: CompanionObserver) => {
    const generation = entry.attemptGeneration;
    try {
      await Promise.all([
        ensureCompanionListener(),
        ensureSidecarLifecycleListener(),
      ]);
      if (!isCurrentCompanion(entry) || generation !== entry.attemptGeneration) return;
      const response = await invoke<unknown>("observe_transfer_peer_companion", {
        peerId: entry.options.desktopId,
        taskId: entry.options.taskId,
        generation,
      });
      if (!isCurrentCompanion(entry) || generation !== entry.attemptGeneration) {
        await invoke("unobserve_transfer_peer_companion", {
          peerId: entry.options.desktopId,
          taskId: entry.options.taskId,
          generation,
        }).catch(() => undefined);
        return;
      }
      const responseRecord = asRecord(response);
      const incarnation = responseRecord?.incarnation;
      if (typeof incarnation !== "number" || !Number.isSafeInteger(incarnation)) {
        throw new Error("transfer sidecar response is missing its incarnation");
      }
      if (incarnation <= latestExitedSidecarIncarnation) {
        throw new Error("transfer sidecar exited before observation became active");
      }
      entry.sidecarIncarnation = incarnation;
      if (entry.failedGeneration === generation) {
        entry.connected = false;
        scheduleCompanionRetry(entry);
        return;
      }
      entry.retryIndex = 0;
      entry.connected = true;
      entry.options.listener({
        type: "connection",
        taskId: entry.options.taskId,
        connected: true,
      });
    } catch (error) {
      if (!isCurrentCompanion(entry) || generation !== entry.attemptGeneration) return;
      entry.connected = false;
      entry.options.listener({
        type: "connection",
        taskId: entry.options.taskId,
        connected: false,
      });
      if (
        error instanceof Error &&
        error.message.includes("does not support visual companions")
      ) {
        entry.options.listener({
          type: "error",
          taskId: entry.options.taskId,
          code: "companion_unsupported",
          message: "This paired desktop does not support remote visual companions.",
        });
        return;
      }
      scheduleCompanionRetry(entry);
    }
  };

  const scheduleCompanionRetry = (entry: CompanionObserver) => {
    if (!isCurrentCompanion(entry) || entry.retryTimer) return;
    const delay = reconnectDelaysMs[
      Math.min(entry.retryIndex, reconnectDelaysMs.length - 1)
    ];
    entry.retryIndex += 1;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (!isCurrentCompanion(entry)) return;
      entry.attemptGeneration = nextCompanionGeneration();
      entry.connected = false;
      entry.sending = false;
      entry.failedGeneration = null;
      // The retry may land on a respawned sidecar whose first frames can beat
      // the observe response; a pinned dead incarnation would silently drop
      // that initial snapshot. Bind to the next incarnation we actually see,
      // exactly like the first attempt.
      entry.sidecarIncarnation = null;
      void startCompanionAttempt(entry);
    }, delay);
  };

  return {
    close() {
      for (const observer of observers.values()) {
        void invoke("unobserve_transfer_peer_session", {
          peerId: observer.options.desktopId,
          sessionId: observer.options.taskId,
          observerLeaseId: observer.leaseId,
        }).catch(() => undefined);
      }
      observers.clear();
      for (const entry of companionObservers.values()) {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        void invoke("unobserve_transfer_peer_companion", {
          peerId: entry.options.desktopId,
          taskId: entry.options.taskId,
          generation: entry.attemptGeneration,
        }).catch(() => undefined);
      }
      companionObservers.clear();
      void terminalUnlistenPromise?.then((unlisten) => unlisten());
      void companionUnlistenPromise?.then((unlisten) => unlisten());
      void sidecarLifecycleUnlistenPromise?.then((unlisten) => unlisten());
      terminalUnlistenPromise = null;
      companionUnlistenPromise = null;
      sidecarLifecycleUnlistenPromise = null;
    },
    observeTerminal(options) {
      const key = observerKey(options.desktopId, options.taskId);
      const observer: ObserverRecord = {
        leaseId: globalThis.crypto.randomUUID(),
        options,
      };
      observers.set(key, observer);
      void ensureTerminalListener()
        .then(() => {
          if (observers.get(key) !== observer) return false;
          return invoke("observe_transfer_peer_session", {
            peerId: options.desktopId,
            sessionId: options.taskId,
            observerLeaseId: observer.leaseId,
          }).then(() => true);
        })
        .then((observing) => {
          if (!observing || observers.get(key) !== observer) return;
          options.listener({ type: "ready", taskId: options.taskId });
        })
        .catch((error: unknown) => {
          if (observers.get(key) !== observer) return;
          options.listener({
            type: "error",
            taskId: options.taskId,
            message: error instanceof Error ? error.message : "LAN terminal failed.",
          });
        });

      return {
        close() {
          if (observers.get(key) === observer) {
            observers.delete(key);
          }
          void invoke("unobserve_transfer_peer_session", {
            peerId: options.desktopId,
            sessionId: options.taskId,
            observerLeaseId: observer.leaseId,
          }).catch(() => undefined);
        },
      } satisfies DesktopRelayTerminalSubscription;
    },
    observeCompanion(options) {
      const key = companionObserverKey(options.desktopId, options.taskId);
      const generation = nextCompanionGeneration();
      const entry: CompanionObserver = {
        subscriptionGeneration: generation,
        attemptGeneration: generation,
        options,
        retryIndex: 0,
        retryTimer: null,
        connected: false,
        sending: false,
        failedGeneration: null,
        sidecarIncarnation: null,
      };
      companionObservers.set(key, entry);
      let closed = false;
      const isCurrent = () => !closed && isCurrentCompanion(entry);
      void startCompanionAttempt(entry);

      return {
        close() {
          if (closed) return;
          const wasCurrent = isCurrentCompanion(entry);
          closed = true;
          if (!wasCurrent) return;
          if (entry.retryTimer) clearTimeout(entry.retryTimer);
          companionObservers.delete(key);
          void invoke("unobserve_transfer_peer_companion", {
            peerId: options.desktopId,
            taskId: options.taskId,
            generation: entry.attemptGeneration,
          }).catch(() => undefined);
        },
        sendEvent(sessionId, revision, event) {
          if (closed || !isCurrent() || !entry.connected || entry.sending) return false;
          const generation = entry.attemptGeneration;
          entry.sending = true;
          void invoke("send_transfer_peer_companion_event", {
            peerId: options.desktopId,
            taskId: options.taskId,
            sessionId,
            revision,
            generation,
            event,
          })
            .then(() => {
              if (!closed && isCurrent() && generation === entry.attemptGeneration) {
                entry.sending = false;
              }
            })
            .catch((error: unknown) => {
              if (
                !closed
                && isCurrent()
                && generation === entry.attemptGeneration
              ) {
                entry.sending = false;
                entry.connected = false;
                entry.failedGeneration = generation;
                options.listener({
                  type: "connection",
                  taskId: options.taskId,
                  connected: false,
                });
                options.listener({
                  type: "error",
                  taskId: options.taskId,
                  code: "send_failed",
                  message: error instanceof Error ? error.message : "LAN companion event failed.",
                });
                scheduleCompanionRetry(entry);
              }
            }
          );
          return true;
        },
      } satisfies DesktopRemoteCompanionSubscription;
    },
    async sendInput(options) {
      await invoke("send_transfer_peer_session_input", {
        peerId: options.desktopId,
        sessionId: options.taskId,
        data: options.data,
        ...(options.submissionBoundary ? { submissionBoundary: true } : {}),
        ...(options.controlInput ? { controlInput: true } : {}),
      });
    },
    async resize(options) {
      await invoke("resize_transfer_peer_session", {
        peerId: options.desktopId,
        sessionId: options.taskId,
        cols: options.cols,
        rows: options.rows,
      });
    },
    async closeTask(options) {
      await invoke("close_transfer_peer_task", {
        peerId: options.desktopId,
        taskId: options.taskId,
      });
    },
    async advanceStage(options) {
      const args: Record<string, unknown> = {
        peerId: options.desktopId,
        taskId: options.taskId,
      };
      if (options.expectedTransitionRevision) {
        args.expectedTransitionRevision = options.expectedTransitionRevision;
      }
      await invoke("advance_transfer_peer_task_stage", args);
    },
    async readTaskFile(options) {
      const response = await invoke("read_transfer_peer_task_file", {
        peerId: options.desktopId,
        taskId: options.taskId,
        path: options.path,
      });
      const record = asRecord(response);
      const path = record ? getStringField(record, "path") : null;
      const content = record ? getStringField(record, "content") : null;
      if (path === null || content === null) {
        throw new Error("LAN task file response was malformed.");
      }
      return { path, content };
    },
    async listTaskDirectory(options) {
      const entries: RemoteTaskDirectoryListing["entries"] = [];
      let offset = 0;
      let responsePath = options.path;
      let totalEntries = 0;
      while (true) {
        const response = await invoke("read_transfer_peer_task_directory", {
          peerId: options.desktopId,
          taskId: options.taskId,
          path: options.path,
          showAllFiles: options.showAllFiles === true,
          offset,
          limit: 100,
        });
        const page = parseTaskDirectoryListing(response);
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
      const response = await invoke("read_transfer_peer_task_diff", {
        peerId: options.desktopId,
        taskId: options.taskId,
        scope: options.request.scope,
        mode: options.request.mode,
      });
      return parseTaskDiffContent(response);
    },
    async markTaskRead(options) {
      await invoke("mark_transfer_peer_task_read", {
        peerId: options.desktopId,
        taskId: options.taskId,
        expectedActivityRevision: options.expectedActivityRevision,
      });
    },
  };
}

function createCompanionGenerationProcessNonce(): string {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(36)).join("-");
}

function nextCompanionGeneration(): string {
  companionGenerationCounter += 1;
  return `lan-companion-${companionGenerationProcessNonce}-${companionGenerationCounter}`;
}

function normalizeCompanionEvent(
  taskId: string,
  frame: Record<string, unknown>,
): DesktopRemoteCompanionEvent | null {
  if (getStringField(frame, "task_id") !== taskId) return null;
  switch (frame.type) {
    case "companion_snapshot": {
      const sessionId = getStringField(frame, "session_id");
      const revision = getStringField(frame, "revision");
      const html = getStringField(frame, "html");
      const documentKind = frame.document_kind;
      const sourceOrigin = frame.source_origin;
      if (
        !sessionId
        || !revision
        || html === null
        || (documentKind !== "fragment" && documentKind !== "full_document")
        || (sourceOrigin != null && typeof sourceOrigin !== "string")
      ) {
        return null;
      }
      const assets = normalizeCompanionAssets(frame.assets);
      if (!assets) return null;
      return {
        type: "snapshot",
        taskId,
        snapshot: {
          sessionId,
          revision,
          documentKind,
          html,
          sourceOrigin: typeof sourceOrigin === "string" ? sourceOrigin : undefined,
          assets,
        },
      };
    }
    case "companion_unavailable":
      return { type: "unavailable", taskId };
    case "companion_event_result": {
      const sessionId = getStringField(frame, "session_id");
      const revision = getStringField(frame, "revision");
      const eventId = getStringField(frame, "event_id");
      if (!eventId || typeof frame.accepted !== "boolean") {
        return null;
      }
      if (!sessionId || !revision) {
        return {
          type: "error",
          taskId,
          code: "incompatible_companion_result",
          message: "The remote companion result is from an incompatible version.",
        };
      }
      if (frame.code != null && typeof frame.code !== "string") return null;
      if (frame.message != null && typeof frame.message !== "string") return null;
      return {
        type: "event_result",
        taskId,
        result: {
          sessionId,
          revision,
          eventId,
          accepted: frame.accepted,
          ...(typeof frame.code === "string" ? { code: frame.code } : {}),
          ...(typeof frame.message === "string" ? { message: frame.message } : {}),
        },
      };
    }
    case "companion_error": {
      const code = getStringField(frame, "code");
      const message = getStringField(frame, "message");
      return code && message ? { type: "error", taskId, code, message } : null;
    }
    default:
      return null;
  }
}

function normalizeCompanionAssets(value: unknown) {
  if (!Array.isArray(value)) return [];
  const assets: Array<{
    name: string;
    contentType: string;
    digest: string;
    dataB64: string;
  }> = [];
  for (const rawAsset of value) {
    const asset = asRecord(rawAsset);
    if (!asset) continue;
    const name = getStringField(asset, "name");
    const contentType = getStringField(asset, "content_type");
    const digest = getStringField(asset, "digest");
    const dataB64 = getStringField(asset, "data_b64");
    if (name === null || contentType === null || digest === null || dataB64 === null) continue;
    assets.push({ name, contentType, digest, dataB64 });
  }
  return assets;
}

function normalizeTerminalEvent(
  taskId: string,
  event: Record<string, unknown>,
): DesktopRelayTerminalEvent | null {
  switch (event.type) {
    case "snapshot": {
      const snapshot = asRecord(event.snapshot);
      return { type: "output", taskId, text: snapshot ? getStringField(snapshot, "vt") ?? "" : "" };
    }
    case "output":
      return { type: "output", taskId, text: decodeBytes(event.data) };
    case "exit":
      return { type: "exit", taskId, code: getNumberField(event, "code") ?? 0 };
    case "error":
      return {
        type: "error",
        taskId,
        message: getStringField(event, "message") ?? "LAN terminal failed.",
      };
    default:
      return null;
  }
}

function observerKey(peerId: string, sessionId: string): string {
  return `${peerId}:${sessionId}`;
}

function companionObserverKey(peerId: string, taskId: string): string {
  return JSON.stringify([peerId, taskId]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function getStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function getNumberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

function decodeBytes(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return new TextDecoder().decode(Uint8Array.from(value.filter((byte): byte is number =>
    typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
  )));
}
