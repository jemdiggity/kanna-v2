import type { AgentProvider } from "../types/kanna";
import type { SpawnOptions } from "./useTerminal";

export interface TerminalSpawnConfig {
  worktreePath?: string;
  prompt?: string;
  agentProvider?: AgentProvider;
}

export interface SpawnPtySessionFn {
  (
    sessionId: string,
    cwd: string,
    prompt: string,
    cols: number,
    rows: number,
    options?: { agentProvider?: AgentProvider },
  ): Promise<void>;
}

export function buildTerminalSpawnOptions(
  spawnPtySession: SpawnPtySessionFn | undefined,
  config: TerminalSpawnConfig,
): SpawnOptions | undefined {
  if (!spawnPtySession || !config.worktreePath || !config.prompt) {
    return undefined;
  }

  return {
    cwd: config.worktreePath,
    prompt: config.prompt,
    spawnFn: (sessionId, cwd, prompt, cols, rows) =>
      spawnPtySession(sessionId, cwd, prompt, cols, rows, {
        agentProvider: config.agentProvider,
      }),
  };
}
