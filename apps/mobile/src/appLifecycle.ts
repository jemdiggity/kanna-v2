import type { AppStateStatus } from "react-native";

export const TERMINAL_BACKGROUND_GRACE_MS = 20_000;

export interface TerminalAppStateLifecycleOptions {
  initialState: AppStateStatus;
  graceMs?: number;
  now?: () => number;
  setTransportForeground(foreground: boolean): void;
  setControllerForeground(foreground: boolean): void;
  reconcileTerminalAfterBackground(): void;
  expireTerminalGrace(): void;
}

export interface TerminalAppStateTransition {
  returnedToActive: boolean;
  preserveTerminal: boolean;
}

/**
 * Owns the deliberately asymmetric mobile terminal lifecycle. iOS `inactive`
 * is an interruption (switcher, shade, Control Center), not a background
 * signal. A real background gets a bounded window before the transport and
 * attachment are released.
 */
export function createTerminalAppStateLifecycle({
  initialState,
  graceMs = TERMINAL_BACKGROUND_GRACE_MS,
  now = Date.now,
  setTransportForeground,
  setControllerForeground,
  reconcileTerminalAfterBackground,
  expireTerminalGrace
}: TerminalAppStateLifecycleOptions): {
  transition(nextState: AppStateStatus): TerminalAppStateTransition;
  dispose(): void;
} {
  let currentState = initialState;
  let graceExpired = false;
  let backgroundedAtMs: number | null =
    initialState === "background" ? now() : null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGraceTimer = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const expireBackgroundGrace = () => {
    if (graceExpired) return;
    graceExpired = true;
    expireTerminalGrace();
    setTransportForeground(false);
  };

  const startBackgroundGrace = () => {
    if (graceTimer || graceExpired) return;
    backgroundedAtMs ??= now();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (backgroundedAtMs === null || currentState === "active") return;
      expireBackgroundGrace();
    }, Math.max(0, graceMs - (now() - backgroundedAtMs)));
  };

  setTransportForeground(true);
  setControllerForeground(initialState === "active");
  // The retained WebView must consume live bytes throughout the short grace.
  // Holding them in a second client queue makes foregrounding replay every
  // historical TUI frame even though the socket itself never reattached.
  if (initialState === "background") startBackgroundGrace();

  return {
    transition(nextState) {
      const previousState = currentState;
      currentState = nextState;

      if (nextState === "active") {
        if (
          backgroundedAtMs !== null &&
          now() - backgroundedAtMs >= graceMs
        ) {
          expireBackgroundGrace();
        }
        const preserveTerminal = !graceExpired;
        clearGraceTimer();
        setTransportForeground(true);
        if (previousState !== "active" && preserveTerminal) {
          reconcileTerminalAfterBackground();
        }
        setControllerForeground(true);
        graceExpired = false;
        backgroundedAtMs = null;
        return {
          returnedToActive: previousState !== "active",
          preserveTerminal
        };
      }

      setControllerForeground(false);
      if (nextState === "background") {
        backgroundedAtMs ??= now();
        startBackgroundGrace();
      }

      return { returnedToActive: false, preserveTerminal: true };
    },
    dispose() {
      clearGraceTimer();
    }
  };
}

export function shouldRefreshOnAppStateTransition(
  previousState: AppStateStatus,
  nextState: AppStateStatus
): boolean {
  return previousState !== "active" && nextState === "active";
}

export type ForegroundTransitionAction = "none" | "refresh" | "reload";

export interface ForegroundTransitionInput {
  previousState: AppStateStatus;
  nextState: AppStateStatus;
  hasDownloadedUpdate: boolean;
}

export function getForegroundTransitionAction({
  previousState,
  nextState,
  hasDownloadedUpdate
}: ForegroundTransitionInput): ForegroundTransitionAction {
  if (
    hasDownloadedUpdate &&
    previousState === "background" &&
    nextState === "active"
  ) {
    return "reload";
  }

  return shouldRefreshOnAppStateTransition(previousState, nextState)
    ? "refresh"
    : "none";
}

export interface OtaForegroundCheckInput {
  previousState: AppStateStatus;
  nextState: AppStateStatus;
  nowMs: number;
  lastCheckAtMs: number | null;
  throttleMs: number;
}

export function shouldCheckForOtaUpdateOnForeground({
  previousState,
  nextState,
  nowMs,
  lastCheckAtMs,
  throttleMs
}: OtaForegroundCheckInput): boolean {
  if (!shouldRefreshOnAppStateTransition(previousState, nextState)) {
    return false;
  }

  return lastCheckAtMs === null || nowMs - lastCheckAtMs >= throttleMs;
}
