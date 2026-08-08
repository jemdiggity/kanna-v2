import type { CompanionEventResult, CompanionSnapshot } from "@kanna/stream-client";

export type { CompanionAssetSnapshot, CompanionSnapshot } from "@kanna/stream-client";

export type CompanionDeliveryTarget =
  | { kind: "react-native" }
  | {
      kind: "websocket";
      path: string;
      sessionId: string;
      revision: string;
      strings: CompanionDocumentStrings;
    };

export interface CompanionDocumentStrings {
  connecting: string;
  retry: string;
  available: string;
  reconnecting: string;
  unavailable: string;
  error: string;
  sending: string;
  sent: string;
  selectionFailed: string;
  unavailableDetail: string;
  errorDetail: string;
}

export type CompanionStatus =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "available"
  | "unavailable"
  | "error";

export type CompanionEventStatus = "idle" | "sending" | "sent" | "error";

export interface CompanionState {
  status: CompanionStatus;
  snapshot: CompanionSnapshot | null;
  unread: boolean;
  errorMessage: string | null;
  eventId: string | null;
  eventStatus: CompanionEventStatus;
}

export type CompanionAction =
  | { type: "begin" }
  | {
      type: "connection";
      connected: boolean;
      retainSnapshot?: boolean;
    }
  | { type: "snapshot"; snapshot: CompanionSnapshot; viewed?: boolean }
  | { type: "unavailable" }
  | { type: "error"; message: string }
  | { type: "begin_event"; eventId: string }
  | { type: "event_result"; result: CompanionEventResult }
  | { type: "viewed" }
  | { type: "reset" };
