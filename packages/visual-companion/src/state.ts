import type { CompanionAction, CompanionState } from "./types";

export function initialCompanionState(): CompanionState {
  return {
    status: "idle",
    snapshot: null,
    unread: false,
    errorMessage: null,
    eventId: null,
    eventStatus: "idle"
  };
}

export function reduceCompanionState(
  state: CompanionState,
  action: CompanionAction
): CompanionState {
  if (action.type === "reset") return initialCompanionState();

  if (action.type === "begin") {
    return {
      ...initialCompanionState(),
      status: "connecting"
    };
  }

  if (action.type === "connection") {
    if (action.connected) return state;
    const selectionWasSending = state.eventStatus === "sending";
    return {
      ...state,
      status: "reconnecting",
      snapshot: action.retainSnapshot === false ? null : state.snapshot,
      unread: false,
      errorMessage: selectionWasSending
        ? "Connection lost before the selection was confirmed. Retry after reconnecting."
        : null,
      eventId: null,
      eventStatus: selectionWasSending ? "error" : "idle"
    };
  }

  if (action.type === "snapshot") {
    const revisionChanged =
      state.snapshot?.revision !== action.snapshot.revision;
    return {
      status: "available",
      snapshot: action.snapshot,
      unread: action.viewed
        ? false
        : revisionChanged
          ? true
          : state.unread,
      errorMessage: null,
      eventId: null,
      eventStatus: "idle"
    };
  }

  if (action.type === "unavailable") {
    return {
      ...initialCompanionState(),
      status: "unavailable"
    };
  }

  if (action.type === "error") {
    return {
      ...initialCompanionState(),
      status: "error",
      errorMessage: action.message
    };
  }

  if (action.type === "begin_event") {
    return {
      ...state,
      errorMessage: null,
      eventId: action.eventId,
      eventStatus: "sending"
    };
  }

  if (action.type === "viewed") {
    return state.unread ? { ...state, unread: false } : state;
  }

  if (
    state.eventId !== action.result.eventId ||
    state.snapshot?.sessionId !== action.result.sessionId ||
    state.snapshot.revision !== action.result.revision
  ) {
    return state;
  }
  return {
    ...state,
    errorMessage: action.result.accepted
      ? null
      : action.result.message ??
        (action.result.code
          ? `Selection rejected: ${action.result.code}`
          : "The visual companion rejected this selection."),
    eventStatus: action.result.accepted ? "sent" : "error"
  };
}
