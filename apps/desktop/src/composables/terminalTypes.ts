export interface SpawnOptions {
  cwd: string
  prompt: string
  spawnFn: (sessionId: string, cwd: string, prompt: string, cols: number, rows: number) => Promise<void>
}

export interface TerminalOptions {
  kittyKeyboard?: boolean
  agentProvider?: string
  worktreePath?: string
  agentTerminal?: boolean
  skipInitialReconnectEffects?: boolean
  recoverSession?: (sessionId: string, options?: { cols?: number; rows?: number }) => Promise<void>
}
