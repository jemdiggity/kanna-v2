import type { SpawnOptions, TerminalOptions } from "./useTerminal";

export type TerminalRecoveryMode = "attach-only" | "spawn-on-missing";

export function getTerminalRecoveryMode(
  spawnOptions?: SpawnOptions,
  options?: TerminalOptions,
): TerminalRecoveryMode {
  const isTaskTerminal = !!spawnOptions && !!options?.worktreePath && !!options?.agentProvider;
  return isTaskTerminal ? "attach-only" : "spawn-on-missing";
}

export function formatAttachFailureMessage(message: string): string {
  return `\r\n\x1b[31mFailed to reconnect to existing session: ${message}\x1b[0m\r\n`;
}
