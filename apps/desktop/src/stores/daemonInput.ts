export function encodeDaemonInput(input: string): number[] {
  return Array.from(new TextEncoder().encode(input));
}

interface AgentStageInputOptions {
  agentProvider: string | null | undefined;
  kittyKeyboard: boolean;
}

export function encodeAgentStageInputChunks(
  stagePrompt: string,
  options: AgentStageInputOptions,
): number[][] {
  if (options.agentProvider === "codex") {
    return [
      encodeDaemonInput(stagePrompt),
      encodeDaemonInput("\x1b[13u"),
    ];
  }

  return [encodeAgentStageInput(stagePrompt, options)];
}

export function encodeAgentStageInput(
  stagePrompt: string,
  options: AgentStageInputOptions,
): number[] {
  void options;
  return encodeDaemonInput(`\x1b[200~${stagePrompt}\x1b[201~\r`);
}
