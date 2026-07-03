import type { AgentProvider } from "@kanna/db";
import { shellSingleQuote } from "../utils/shell";

export interface AgentCommandResult {
  agentCmd: string;
  agentCmdPreamble?: string;
}

export interface BuildAgentCommandParams {
  taskId: string;
  prompt: string;
  runtimeSystemPrompt: string;
  runtimeUserPrompt: string;
  permissionFlags: string[];
  mcpConfigPath?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  createSessionId?: () => string;
  persistAgentSessionId?: (agentSessionId: string) => Promise<void>;
  resolveBinaryPath?: (name: string) => Promise<string>;
}

export async function buildAgentCommand(
  provider: AgentProvider,
  params: BuildAgentCommandParams,
): Promise<AgentCommandResult> {
  switch (provider) {
    case "copilot":
      return buildCopilotCommand(params);
    case "codex":
      return buildCodexCommand(params);
    case "opencode":
      return buildOpenCodeCommand(params);
    case "antigravity":
      return buildAntigravityCommand(params);
    case "claude":
      return buildClaudeCommand(params);
  }
}

async function buildCopilotCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const copilotFlags: string[] = [...params.permissionFlags];
  if (params.model) copilotFlags.push(`--model=${params.model}`);
  if (params.allowedTools?.length) {
    for (const tool of params.allowedTools) copilotFlags.push(`--allow-tool=${tool}`);
  }
  if (params.disallowedTools?.length) {
    for (const tool of params.disallowedTools) copilotFlags.push(`--deny-tool=${tool}`);
  }

  if (params.resumeSessionId) {
    copilotFlags.push(`--resume=${shellSingleQuote(params.resumeSessionId)}`);
  } else {
    const copilotSessionId = createAgentSessionId(params);
    await persistFreshAgentSessionId(params, copilotSessionId);
    copilotFlags.push(`--session-id=${shellSingleQuote(copilotSessionId)}`);
  }

  const flags = copilotFlags.join(" ");
  return {
    agentCmd: params.resumeSessionId
      ? `copilot ${flags}`
      : `copilot ${flags} -i ${shellSingleQuote(params.prompt)}`,
    agentCmdPreamble: params.resumeSessionId
      ? undefined
      : `copilot ${flags} -i ${shellSingleQuote(params.runtimeUserPrompt)}`,
  };
}

function buildCodexCommand(params: BuildAgentCommandParams): AgentCommandResult {
  const codexFlags: string[] = [...params.permissionFlags];
  if (params.model) codexFlags.push(`-m ${params.model}`);
  const flags = codexFlags.join(" ");
  if (params.resumeSessionId) {
    const resumeSessionArg = shellSingleQuote(params.resumeSessionId);
    return {
      agentCmd: params.prompt
        ? `codex resume ${flags} ${resumeSessionArg} ${shellSingleQuote(params.prompt)}`
        : `codex resume ${flags} ${resumeSessionArg}`,
      agentCmdPreamble: params.prompt
        ? `codex resume ${flags} ${resumeSessionArg} ${shellSingleQuote(params.runtimeUserPrompt)}`
        : undefined,
    };
  }

  return {
    agentCmd: params.prompt
      ? `codex ${flags} ${shellSingleQuote(params.prompt)}`
      : `codex ${flags}`,
    agentCmdPreamble: params.prompt
      ? `codex ${flags} ${shellSingleQuote(params.runtimeUserPrompt)}`
      : undefined,
  };
}

async function buildOpenCodeCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const opencodePath = params.resolveBinaryPath
    ? await params.resolveBinaryPath("opencode").catch(() => "opencode")
    : "opencode";
  const opencodeExecutable = shellSingleQuote(opencodePath);
  const opencodeFlags: string[] = [...params.permissionFlags];
  if (params.model) opencodeFlags.push(`-m ${params.model}`);
  if (params.resumeSessionId) {
    opencodeFlags.push(`--session ${shellSingleQuote(params.resumeSessionId)}`);
  }
  const opencodeParts = [opencodeExecutable, "run", "--interactive", ...opencodeFlags];
  if (params.prompt) {
    opencodeParts.push(shellSingleQuote(params.prompt));
  }

  const result: AgentCommandResult = {
    agentCmd: opencodeParts.join(" "),
  };
  if (params.prompt) {
    const opencodePreambleParts = [
      opencodeExecutable,
      "run",
      "--interactive",
      ...opencodeFlags,
      shellSingleQuote(params.runtimeUserPrompt),
    ];
    result.agentCmdPreamble = opencodePreambleParts.join(" ");
  }
  return result;
}

function buildAntigravityCommand(params: BuildAgentCommandParams): AgentCommandResult {
  const antigravityFlags: string[] = [...params.permissionFlags];
  if (params.model) antigravityFlags.push(`--model ${params.model}`);
  const parts = [shellSingleQuote("agy"), ...antigravityFlags];
  if (params.prompt) parts.push("--prompt-interactive", shellSingleQuote(params.prompt));

  const result: AgentCommandResult = {
    agentCmd: parts.join(" "),
  };
  if (params.prompt) {
    result.agentCmdPreamble = [
      shellSingleQuote("agy"),
      ...antigravityFlags,
      "--prompt-interactive",
      shellSingleQuote(params.runtimeUserPrompt),
    ].join(" ");
  }
  return result;
}

async function buildClaudeCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const flags: string[] = [...params.permissionFlags];
  flags.push(`--append-system-prompt ${shellSingleQuote(params.runtimeSystemPrompt)}`);
  if (params.mcpConfigPath) {
    flags.push(`--mcp-config ${shellSingleQuote(params.mcpConfigPath)}`);
  }
  if (params.model) flags.push(`--model ${params.model}`);
  if (params.maxTurns != null) flags.push(`--max-turns ${params.maxTurns}`);
  if (params.maxBudgetUsd != null) flags.push(`--max-budget-usd ${params.maxBudgetUsd}`);
  if (params.allowedTools?.length) {
    flags.push(`--allowedTools ${params.allowedTools.join(",")}`);
  }
  if (params.disallowedTools?.length) {
    flags.push(`--disallowedTools ${params.disallowedTools.join(",")}`);
  }

  const claudeSessionId = params.resumeSessionId || createAgentSessionId(params);
  if (!params.resumeSessionId) {
    await persistFreshAgentSessionId(params, claudeSessionId);
  }

  if (params.resumeSessionId) {
    flags.push(`--resume ${claudeSessionId}`);
  } else {
    flags.push(`--session-id ${claudeSessionId}`);
  }

  if (params.resumeSessionId || !params.prompt) {
    return { agentCmd: `claude ${flags.join(" ")}` };
  }
  return { agentCmd: `claude ${flags.join(" ")} ${shellSingleQuote(params.prompt)}` };
}

function createAgentSessionId(params: BuildAgentCommandParams): string {
  return params.createSessionId ? params.createSessionId() : crypto.randomUUID();
}

async function persistFreshAgentSessionId(
  params: BuildAgentCommandParams,
  agentSessionId: string,
): Promise<void> {
  if (!params.persistAgentSessionId) {
    throw new Error(`missing agent session id writer for ${params.taskId}`);
  }
  await params.persistAgentSessionId(agentSessionId);
}
