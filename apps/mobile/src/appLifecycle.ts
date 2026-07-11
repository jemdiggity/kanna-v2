import type { AppStateStatus } from "react-native";

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
