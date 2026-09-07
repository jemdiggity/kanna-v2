import type { SpawnOptions, TerminalOptions } from "./useTerminal";
import { getAppErrorCode } from "../appError";
import {
  renderBestEffortLifecycleCommand,
  shellSingleQuote,
} from "../utils/lifecycleCommands";

export type TerminalRecoveryMode = "attach-only" | "spawn-on-missing";
export interface ReconnectRedrawPolicy {
  waitForIdleStatus: string | null;
  settleDelayMs: number;
  fallbackDelayMs: number;
}

export interface TaskTerminalEnv {
  TERM: string;
  COLORTERM?: string;
  TERM_PROGRAM?: string;
}

export interface TaskShellCommandOptions {
  kannaCliPath?: string;
  agentCmdPreamble?: string;
}

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

const SESSION_NOT_FOUND_CODE = "session_not_found";
const HANDOFF_LOST_CODE = "handoff_lost";
const SESSION_ALREADY_EXISTS_CODE = "session_already_exists";

export function isMissingDaemonSessionFailure(error: unknown): boolean {
  return getAppErrorCode(error) === SESSION_NOT_FOUND_CODE;
}

export function isExistingDaemonSessionFailure(error: unknown): boolean {
  return getAppErrorCode(error) === SESSION_ALREADY_EXISTS_CODE;
}

export function getTerminalRecoveryMode(
  spawnOptions?: SpawnOptions,
  options?: TerminalOptions,
): TerminalRecoveryMode {
  const isTaskTerminal = !!spawnOptions && !!options?.worktreePath && !!options?.agentProvider;
  return isTaskTerminal ? "attach-only" : "spawn-on-missing";
}

export function shouldReattachOnDaemonReady(
  spawnOptions?: SpawnOptions,
  _options?: TerminalOptions,
): boolean {
  return !!spawnOptions;
}

export function shouldDelayConnectUntilAfterInitialLayout(
  spawnOptions?: SpawnOptions,
  options?: TerminalOptions,
): boolean {
  return getTerminalRecoveryMode(spawnOptions, options) === "attach-only";
}

export function shouldRestoreRecoveryState(
  spawnOptions?: SpawnOptions,
  _options?: TerminalOptions,
): boolean {
  return !!spawnOptions;
}

export function shouldRunTerminalDispose(alreadyDisposed: boolean): boolean {
  return !alreadyDisposed;
}

export function shouldEnableKittyKeyboard(options?: TerminalOptions): boolean {
  return options?.agentProvider === "claude";
}

export function shouldSupportKittyKeyboard(options?: TerminalOptions): boolean {
  return !!options?.agentProvider;
}

export function shouldPushKittyKeyboardOnFreshAttach(_options?: TerminalOptions): boolean {
  return false;
}

export function shouldResetTerminalOnReconnect(options?: TerminalOptions): boolean {
  return options?.agentProvider !== "codex";
}

/** Whether an incoming snapshot replaces the xterm buffer or is written on top
 * of it. A recovered-scrollback restore always keeps the buffer. A respawned
 * session id (stage-swap rebind, cleared exit latch) always resets: whatever
 * xterm shows belongs to the dead PTY, and the snapshot now opens with the
 * carried-over history — writing it below the stale copy would show it twice.
 * Only an ordinary reconnect keeps the provider-specific behavior. */
export function shouldResetTerminalForSnapshot(params: {
  preserveRecoveredScrollback: boolean;
  sessionRespawned: boolean;
  agentProvider?: string;
}): boolean {
  if (params.preserveRecoveredScrollback) return false;
  return (
    params.sessionRespawned ||
    shouldResetTerminalOnReconnect({ agentProvider: params.agentProvider })
  );
}

export function getReconnectKeyboardPush(_options?: TerminalOptions): string | null {
  return null;
}

export function getTaskTerminalEnv(agentProvider?: string): TaskTerminalEnv {
  void agentProvider;
  return {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kanna",
  };
}

export function getShellTerminalEnv(): TaskTerminalEnv {
  return {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "kanna",
  };
}

function directoryName(path: string): string | null {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return path.slice(0, lastSlash);
}

function truncateVisibleShellCommand(command: string, maxLength = 115): string {
  if (command.length <= maxLength) return command;
  return `${command.slice(0, maxLength - 3)}...`;
}

export function buildTaskShellCommand(
  agentCmd: string,
  setupCmds: string[],
  options?: TaskShellCommandOptions,
): string {
  const preludeParts: string[] = [];
  if (options?.kannaCliPath) {
    const quotedCliPath = shellSingleQuote(options.kannaCliPath);
    preludeParts.push(`export KANNA_CLI_PATH='${quotedCliPath}'`);

    const cliDir = directoryName(options.kannaCliPath);
    if (cliDir) {
      preludeParts.push(`export PATH='${shellSingleQuote(cliDir)}':\"$PATH\"`);
    }
  }

  const setupParts = setupCmds.map((cmd) => renderBestEffortLifecycleCommand(cmd, "Setup"));

  const commandParts: string[] = [];
  if (preludeParts.length > 0) {
    commandParts.push(preludeParts.join(" && "));
  }
  if (setupParts.length > 0) {
    commandParts.push(`printf '\\033[33mRunning startup...\\033[0m\\n' && ${setupParts.join(" && ")} && printf '\\n'`);
  }
  const printedAgentCmd = shellSingleQuote(truncateVisibleShellCommand(agentCmd));
  const launchAgentCmd = options?.agentCmdPreamble ?? agentCmd;
  commandParts.push(`printf '\\033[2m$ %s\\033[0m\\n' '${printedAgentCmd}'`);
  commandParts.push(launchAgentCmd);

  return commandParts.join(" && ");
}

export function formatAttachFailureMessage(message: string, retrySeconds?: number): string {
  const retry = retrySeconds == null
    ? ""
    : ` Retrying in ${retrySeconds}s; reopen the task to retry now.`;
  return `\r\n\x1b[31mFailed to reconnect to existing session: ${message}${retry}\x1b[0m\r\n`;
}

export function formatMissingInitialTaskSessionMessage(): string {
  return "\r\n\x1b[33mKnock, knock, Neo. Kanna couldn't find a live agent session for this task.\x1b[0m\r\n";
}

export function isDaemonHandoffFailure(error: unknown): boolean {
  return getAppErrorCode(error) === HANDOFF_LOST_CODE;
}

export function shouldRespawnAfterAttachFailure(
  error: unknown,
  hasAttachedOnce: boolean,
  hasRecoveryState: boolean,
  spawnOptions?: SpawnOptions,
  options?: TerminalOptions,
): boolean {
  if (
    isMissingDaemonSessionFailure(error) &&
    !hasAttachedOnce &&
    !hasRecoveryState
  ) {
    return false;
  }
  return (
    getTerminalRecoveryMode(spawnOptions, options) === "attach-only" &&
    (isDaemonHandoffFailure(error) || isMissingDaemonSessionFailure(error))
  );
}

export function getRespawnToastKey(
  error: unknown,
  hasRecoveryState: boolean,
): string {
  if (isDaemonHandoffFailure(error)) {
    return hasRecoveryState
      ? "toasts.daemonHandoffRespawnedWithScrollback"
      : "toasts.daemonHandoffRespawned";
  }

  return hasRecoveryState
    ? "toasts.sessionRespawnedWithScrollback"
    : "toasts.sessionRespawned";
}

export function getReconnectResizeDelayMs(_options?: TerminalOptions): number {
  return 0;
}
export function shouldForceDoubleResizeOnReconnect(_options?: TerminalOptions): boolean {
  return _options?.agentProvider === "claude";
}

export function shouldSkipReconnect(connecting: boolean, attached: boolean): boolean {
  return connecting || attached;
}

export function getReconnectRedrawPolicy(options?: TerminalOptions): ReconnectRedrawPolicy {
  if (options?.agentProvider === "claude") {
    return {
      waitForIdleStatus: "idle",
      settleDelayMs: 200,
      fallbackDelayMs: 2000,
    };
  }
  return {
    waitForIdleStatus: null,
    settleDelayMs: 0,
    fallbackDelayMs: 0,
  };
}
