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
  return encodeAgentPromptInputChunks(stagePrompt, options);
}

export function encodeAgentPromptInputChunks(
  prompt: string,
  options: AgentStageInputOptions,
): number[][] {
  if (options.agentProvider === "codex") {
    return [
      encodeDaemonInput(prompt),
      encodeDaemonInput("\x1b[13u"),
    ];
  }

  return [encodeAgentPromptInput(prompt, options)];
}

export function encodeAgentStageInput(
  stagePrompt: string,
  options: AgentStageInputOptions,
): number[] {
  return encodeAgentPromptInput(stagePrompt, options);
}

export function encodeAgentPromptInput(
  prompt: string,
  options: AgentStageInputOptions,
): number[] {
  void options;
  return encodeDaemonInput(`\x1b[200~${prompt}\x1b[201~\r`);
}
