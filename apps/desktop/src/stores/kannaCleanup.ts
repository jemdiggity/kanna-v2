import { getAppErrorCode } from "../appError";

export function isTeardownSessionId(sessionId: string): boolean {
  return sessionId.startsWith("td-");
}

export function getTaskIdFromTeardownSessionId(sessionId: string): string | null {
  if (!isTeardownSessionId(sessionId)) {
    return null;
  }

  const taskId = sessionId.slice(3);
  return taskId.length > 0 ? taskId : null;
}

export function shouldClearCachedTerminalStateOnSessionExit(sessionId: string): boolean {
  return !isTeardownSessionId(sessionId);
}

export interface TeardownExitBehaviorInput {
  exitCode: number | null;
  lingerEnabled: boolean;
}

export function shouldAutoCloseTaskAfterTeardownExit(
  input: TeardownExitBehaviorInput,
): boolean {
  return input.exitCode === 0 && !input.lingerEnabled;
}

export function isMissingDaemonSessionError(error: unknown): boolean {
  return getAppErrorCode(error) === "session_not_found";
}

export function isSessionAlreadyExistsError(error: unknown): boolean {
  return getAppErrorCode(error) === "session_already_exists";
}

export function reportCloseSessionError(
  prefix: string,
  error: unknown,
  logger: (message?: unknown, ...optionalParams: unknown[]) => void = console.error,
): void {
  if (isMissingDaemonSessionError(error)) {
    return;
  }

  logger(prefix, error);
}

export function reportPrewarmSessionError(
  prefix: string,
  error: unknown,
  logger: (message?: unknown, ...optionalParams: unknown[]) => void = console.error,
): void {
  if (isSessionAlreadyExistsError(error)) {
    return;
  }

  logger(prefix, error);
}
