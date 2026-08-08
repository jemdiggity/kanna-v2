import { desktopCompanionRemoteKey } from "./services/desktopCompanionIdentity";

export type E2ERemoteCompanionStatus =
  | "available"
  | "reconnecting"
  | "unavailable"
  | "error";

export interface E2ERemoteCompanionOwner {
  ownerDesktopId: string;
  ownerTaskId: string;
}

export interface E2ERemoteCompanionSnapshot
  extends E2ERemoteCompanionOwner {
  sessionId: string | null;
  revision: string | null;
  status: E2ERemoteCompanionStatus;
  /** Explicitly captured one-time loopback capability. */
  entryUrl: string | null;
  /** Monotonic, sanitized attempt id for a real Tauri opener invocation. */
  openerAttempt: number;
  openerOutcome: "pending" | "success" | "error" | null;
}

export interface E2ERemoteCompanionApi {
  captureNextOpen(input: E2ERemoteCompanionOwner): void;
  snapshot(input: E2ERemoteCompanionOwner): E2ERemoteCompanionSnapshot | null;
}

interface InternalState {
  armedCaptures: Set<string>;
  snapshots: Map<string, E2ERemoteCompanionSnapshot>;
}

const states = new WeakMap<E2ERemoteCompanionApi, InternalState>();

function key(input: E2ERemoteCompanionOwner): string {
  return desktopCompanionRemoteKey(input.ownerDesktopId, input.ownerTaskId);
}

function activeState(): InternalState | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const api = window.__KANNA_E2E__?.remoteCompanion;
  return api ? states.get(api) ?? null : null;
}

export function createE2ERemoteCompanionApi(): E2ERemoteCompanionApi {
  const state: InternalState = {
    armedCaptures: new Set(),
    snapshots: new Map(),
  };
  const api: E2ERemoteCompanionApi = {
    captureNextOpen(input) {
      state.armedCaptures.add(key(input));
    },
    snapshot(input) {
      const snapshot = state.snapshots.get(key(input));
      return snapshot ? { ...snapshot } : null;
    },
  };
  states.set(api, state);
  return api;
}

export function captureRemoteCompanionOpenForE2E(
  input: E2ERemoteCompanionOwner & {
    sessionId: string;
    revision: string;
    status: E2ERemoteCompanionStatus;
    entryUrl: string;
  },
): boolean {
  const state = activeState();
  if (!state) return false;
  const remoteKey = key(input);
  if (!state.armedCaptures.delete(remoteKey)) return false;
  const previous = state.snapshots.get(remoteKey);
  state.snapshots.set(remoteKey, {
    ...input,
    openerAttempt: previous?.openerAttempt ?? 0,
    openerOutcome: previous?.openerOutcome ?? null,
  });
  return true;
}

export function recordRemoteCompanionOpenerForE2E(
  input: E2ERemoteCompanionOwner & (
    | { outcome: "pending" }
    | {
      attempt: number;
      outcome: "success" | "error";
    }
  ),
): number {
  const state = activeState();
  if (!state) return 0;
  const remoteKey = key(input);
  const previous = state.snapshots.get(remoteKey);
  if (!previous) return 0;
  if (input.outcome === "pending") {
    const attempt = previous.openerAttempt + 1;
    state.snapshots.set(remoteKey, {
      ...previous,
      openerAttempt: attempt,
      openerOutcome: "pending",
    });
    return attempt;
  }
  if (input.attempt <= 0 || input.attempt !== previous.openerAttempt) {
    return previous.openerAttempt;
  }
  state.snapshots.set(remoteKey, {
    ...previous,
    openerOutcome: input.outcome,
  });
  return input.attempt;
}

export function observeRemoteCompanionStatusForE2E(
  input: E2ERemoteCompanionOwner & {
    sessionId: string | null;
    revision: string | null;
    status: E2ERemoteCompanionStatus;
  },
): void {
  const state = activeState();
  if (!state) return;
  const remoteKey = key(input);
  const previous = state.snapshots.get(remoteKey);
  const sameGeneration =
    previous?.sessionId === input.sessionId &&
    previous.revision === input.revision;
  state.snapshots.set(remoteKey, {
    ...input,
    entryUrl: sameGeneration ? previous.entryUrl : null,
    openerAttempt: previous?.openerAttempt ?? 0,
    openerOutcome: sameGeneration ? previous.openerOutcome : null,
  });
}
