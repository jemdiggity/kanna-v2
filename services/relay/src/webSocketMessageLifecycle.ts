import { WebSocket, type RawData } from "ws";

const MESSAGE_FAILURE = "relay could not process request";

interface CorrelatedFailure {
  body: Record<string, unknown>;
  requestType: string;
}

export interface WebSocketMessageLifecycle {
  sendMobileNotificationAck(body: Record<string, unknown>): void;
  sendTaskSnapshotAck(body: Record<string, unknown>): void;
}

type WebSocketMessageHandler = (
  raw: RawData,
  isBinary: boolean,
  lifecycle: WebSocketMessageLifecycle,
) => Promise<void>;

export function attachWebSocketMessageHandler(
  ws: WebSocket,
  remoteAddr: string,
  handler: WebSocketMessageHandler,
): void {
  ws.on("message", (raw: RawData, isBinary: boolean) => {
    const lifecycle = createMessageLifecycle(ws, raw);
    void handler(raw, isBinary, lifecycle).catch(() => {
      lifecycle.handleRejection(remoteAddr);
    });
  });
}

function createMessageLifecycle(
  ws: WebSocket,
  raw: RawData,
): WebSocketMessageLifecycle & { handleRejection(remoteAddr: string): void } {
  let acknowledgementAttempted = false;

  const sendAcknowledgement = (body: Record<string, unknown>): void => {
    if (acknowledgementAttempted) return;
    acknowledgementAttempted = true;
    if (ws.readyState !== WebSocket.OPEN) {
      terminateSocket(ws);
      return;
    }
    ws.send(JSON.stringify(body), (error) => {
      if (error) terminateSocket(ws);
    });
  };

  return {
    sendMobileNotificationAck: sendAcknowledgement,
    sendTaskSnapshotAck: sendAcknowledgement,
    handleRejection(remoteAddr: string): void {
      const failure = correlatedFailure(raw);
      console.error(
        `[ws] Message handler failed for ${remoteAddr}`
        + (failure ? ` (request=${failure.requestType})` : ""),
      );
      if (!acknowledgementAttempted && failure && ws.readyState === WebSocket.OPEN) {
        try {
          sendAcknowledgement(failure.body);
          return;
        } catch {
          // The acknowledgement attempt is already recorded; terminate below.
        }
      }
      terminateSocket(ws);
    },
  };
}

function correlatedFailure(raw: RawData): CorrelatedFailure | null {
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    message = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (message.type === "mobile_notification_publish" && validStringId(message.id)) {
    return {
      requestType: message.type,
      body: {
        type: "mobile_notification_ack",
        id: message.id,
        ok: false,
        error: MESSAGE_FAILURE,
      },
    };
  }
  if (message.type === "task_snapshot_publish" && validStringId(message.id)) {
    return {
      requestType: message.type,
      body: {
        type: "task_snapshot_ack",
        id: message.id,
        ok: false,
        error: MESSAGE_FAILURE,
      },
    };
  }
  if (message.type === "invoke" && validRequestId(message.id)) {
    return {
      requestType: message.type,
      body: {
        type: "response",
        id: message.id,
        error: MESSAGE_FAILURE,
      },
    };
  }
  return null;
}

function validStringId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validRequestId(value: unknown): value is string | number {
  return validStringId(value) || (typeof value === "number" && Number.isFinite(value));
}

function terminateSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.terminate();
  } catch {
    // The socket is already unusable; there is no further lifecycle work to do.
  }
}
