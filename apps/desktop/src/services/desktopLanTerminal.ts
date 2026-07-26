import { invoke } from "../invoke";
import { listen } from "../listen";
import type {
  DesktopRelayTerminalClient,
  DesktopRelayTerminalEvent,
  DesktopRelayTerminalSubscription,
  ObserveDesktopRelayTerminalOptions,
} from "./desktopRelayTerminal";

export async function createConfiguredDesktopLanTerminalClient(): Promise<DesktopRelayTerminalClient> {
  return createDesktopLanTerminalClient();
}

export function createDesktopLanTerminalClient(): DesktopRelayTerminalClient {
  interface ObserverRecord {
    leaseId: string;
    options: ObserveDesktopRelayTerminalOptions;
  }
  const observers = new Map<string, ObserverRecord>();
  let unlistenPromise: Promise<() => void> | null = null;

  const ensureListener = () => {
    unlistenPromise ??= listen("transfer-terminal-event", (event) => {
      handleTransferTerminalEvent(event.payload as Record<string, unknown>);
    });
    return unlistenPromise;
  };

  const handleTransferTerminalEvent = (payload: Record<string, unknown>) => {
    const peerId = getStringField(payload, "peer_id") ?? getStringField(payload, "peerId");
    const sessionId = getStringField(payload, "session_id") ?? getStringField(payload, "sessionId");
    const event = asRecord(payload.event);
    if (!peerId || !sessionId || !event) return;
    const observer = observers.get(observerKey(peerId, sessionId));
    if (!observer) return;
    const normalized = normalizeTerminalEvent(sessionId, event);
    if (normalized) observer.options.listener(normalized);
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
      void unlistenPromise?.then((unlisten) => unlisten());
      unlistenPromise = null;
    },
    observeTerminal(options) {
      const key = observerKey(options.desktopId, options.taskId);
      const observer: ObserverRecord = {
        leaseId: globalThis.crypto.randomUUID(),
        options,
      };
      observers.set(key, observer);
      void ensureListener()
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
    async sendInput(options) {
      await invoke("send_transfer_peer_session_input", {
        peerId: options.desktopId,
        sessionId: options.taskId,
        data: options.data,
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
    async markTaskRead(options) {
      await invoke("mark_transfer_peer_task_read", {
        peerId: options.desktopId,
        taskId: options.taskId,
        expectedActivityRevision: options.expectedActivityRevision,
      });
    },
  };
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
