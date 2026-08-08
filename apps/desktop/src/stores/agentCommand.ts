import type { AgentProvider } from "../types/kanna";
import { shellSingleQuote } from "../utils/shell";

export interface AgentCommandResult {
  agentCmd: string;
  agentCmdPreamble?: string;
  /**
   * The agent CLI's own session id this command starts (fresh assign) or
   * resumes, when the provider supports Kanna-assigned session ids.
   */
  agentSessionId?: string;
}

export interface BuildAgentCommandParams {
  taskId: string;
  prompt: string;
  runtimeSystemPrompt: string;
  runtimeUserPrompt: string;
  permissionFlags: string[];
  mcpConfigPath?: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  worktreePath?: string;
  readTextFile?: (path: string) => Promise<string>;
  createSessionId?: () => string;
  persistAgentSessionId?: (agentSessionId: string) => Promise<void>;
  resolveBinaryPath?: (name: string) => Promise<string>;
}

interface KannaMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface KannaMcpConfig {
  mcpServers?: {
    "kanna-mcp"?: KannaMcpServerConfig;
  };
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
  if (params.effort) copilotFlags.push(`--effort=${shellSingleQuote(params.effort)}`);
  if (params.allowedTools?.length) {
    for (const tool of params.allowedTools) copilotFlags.push(`--allow-tool=${tool}`);
  }
  if (params.disallowedTools?.length) {
    for (const tool of params.disallowedTools) copilotFlags.push(`--deny-tool=${tool}`);
  }

  let copilotSessionId: string;
  if (params.resumeSessionId) {
    copilotSessionId = params.resumeSessionId;
    copilotFlags.push(`--resume=${shellSingleQuote(copilotSessionId)}`);
  } else {
    copilotSessionId = createAgentSessionId(params);
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
    agentSessionId: copilotSessionId,
  };
}

async function buildCodexCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const codexFlags: string[] = [...params.permissionFlags];
  codexFlags.push(...await buildCodexMcpConfigFlags(params));
  if (params.model) codexFlags.push(`-m ${params.model}`);
  if (params.effort) {
    codexFlags.push(codexConfigFlag("model_reasoning_effort", JSON.stringify(params.effort)));
  }
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

async function buildCodexMcpConfigFlags(params: BuildAgentCommandParams): Promise<string[]> {
  if (!params.mcpConfigPath || !params.readTextFile) return [];

  try {
    const content = await params.readTextFile(params.mcpConfigPath);
    const config = JSON.parse(content) as KannaMcpConfig;
    const server = config.mcpServers?.["kanna-mcp"];
    if (!server?.command) return [];

    const flags = [
      codexConfigFlag("mcp_servers.kanna-mcp.command", JSON.stringify(server.command)),
      codexConfigFlag("mcp_servers.kanna-mcp.args", JSON.stringify(server.args ?? [])),
    ];
    for (const [key, value] of Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      flags.push(codexConfigFlag(`mcp_servers.kanna-mcp.env.${key}`, JSON.stringify(value)));
    }
    return flags;
  } catch (error) {
    console.warn("[store] failed to read Kanna MCP config for Codex:", error);
    return [];
  }
}

function codexConfigFlag(key: string, value: string): string {
  return `-c ${shellSingleQuote(`${key}=${value}`)}`;
}

/**
 * Reasoning effort cannot ride on the argv of OpenCode's TUI entrypoint: the
 * CLI's default command rejects `--variant` and exits with usage before drawing
 * anything. It goes through the config env var instead, where
 * `AgentConfig.variant` applies "only when using the agent's configured model"
 * — hence the model is written beside it. Mirrors
 * `opencode_config_content` in `crates/kanna-agent-protocol/src/mcp.rs`.
 */
function opencodeConfigEnvPrefix(model?: string, effort?: string): string | null {
  if (!effort) return null;
  const content = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: { build: { ...(model ? { model } : {}), variant: effort } },
  });
  return `OPENCODE_CONFIG_CONTENT=${shellSingleQuote(content)}`;
}

async function buildOpenCodeCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const opencodePath = params.resolveBinaryPath
    ? await params.resolveBinaryPath("opencode").catch(() => "opencode")
    : "opencode";
  const opencodeExecutable = shellSingleQuote(opencodePath);
  const opencodeFlags: string[] = [...params.permissionFlags];
  if (params.model) opencodeFlags.push(`-m ${params.model}`);
  const sessionFlag = params.resumeSessionId
    ? `--session ${shellSingleQuote(params.resumeSessionId)}`
    : null;
  const envPrefix = opencodeConfigEnvPrefix(params.model, params.effort);
  const command = (argv: string[]): string =>
    [...(envPrefix ? [envPrefix] : []), ...argv].join(" ");
  const tui = [opencodeExecutable, ...opencodeFlags, ...(sessionFlag ? [sessionFlag] : [])];

  // `opencode run` draws no TUI and exits at the end of its first turn, leaving
  // nothing for send-input, stage posts or the transfer wrap-up to type into.
  // The default command opens the interactive TUI; `--prompt` delivers the
  // opening prompt as a real turn on it — except when the TUI is also resuming
  // a session, where it discards `--prompt` silently. There the turn is seeded
  // by a headless `run` against the same session id first, and the TUI attaches
  // to the conversation it just extended. Mirrors the Rust composition in
  // `crates/kanna-server/src/task_creator/commands.rs`.
  const buildCommand = (prompt: string | undefined): string => {
    if (!prompt) return command(tui);
    if (!sessionFlag) return command([...tui, `--prompt ${shellSingleQuote(prompt)}`]);
    const seed = [opencodeExecutable, "run", ...opencodeFlags, sessionFlag, shellSingleQuote(prompt)];
    return `${command(seed)}; ${command(tui)}`;
  };

  const result: AgentCommandResult = {
    agentCmd: buildCommand(params.prompt),
  };
  if (params.prompt) {
    result.agentCmdPreamble = buildCommand(params.runtimeUserPrompt);
  }
  return result;
}

function buildAntigravityCommand(params: BuildAgentCommandParams): AgentCommandResult {
  const antigravityFlags: string[] = [...params.permissionFlags];
  if (params.model) antigravityFlags.push(`--model ${params.model}`);
  if (params.effort) antigravityFlags.push(`--effort ${shellSingleQuote(params.effort)}`);
  let workspaceAliasSetup: string[] = [];
  if (params.worktreePath) {
    const aliasBase = shellSingleQuote("/tmp/kanna-antigravity-workspaces");
    const aliasPath = shellSingleQuote(`/tmp/kanna-antigravity-workspaces/${safeAntigravityAliasName(params.worktreePath)}`);
    workspaceAliasSetup = [
      `mkdir -p ${aliasBase}`,
      `rm -f ${aliasPath}`,
      `ln -s ${shellSingleQuote(params.worktreePath)} ${aliasPath}`,
    ];
    antigravityFlags.push(`--add-dir ${aliasPath}`);
  }
  const parts = [shellSingleQuote("agy"), ...antigravityFlags];
  if (params.prompt) parts.push("--prompt-interactive", shellSingleQuote(params.prompt));

  const result: AgentCommandResult = {
    agentCmd: [...workspaceAliasSetup, parts.join(" ")].join(" && "),
  };
  if (params.prompt) {
    const preambleParts = [
      shellSingleQuote("agy"),
      ...antigravityFlags,
      "--prompt-interactive",
      shellSingleQuote(params.runtimeUserPrompt),
    ];
    result.agentCmdPreamble = [...workspaceAliasSetup, preambleParts.join(" ")].join(" && ");
  }
  return result;
}

function safeAntigravityAliasName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const name = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function buildClaudeCommand(params: BuildAgentCommandParams): Promise<AgentCommandResult> {
  const flags: string[] = [...params.permissionFlags];
  flags.push(`--append-system-prompt ${shellSingleQuote(params.runtimeSystemPrompt)}`);
  if (params.mcpConfigPath) {
    flags.push(`--mcp-config ${shellSingleQuote(params.mcpConfigPath)}`);
  }
  if (params.model) flags.push(`--model ${params.model}`);
  if (params.effort) flags.push(`--effort ${shellSingleQuote(params.effort)}`);
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
    return { agentCmd: `claude ${flags.join(" ")}`, agentSessionId: claudeSessionId };
  }
  return {
    agentCmd: `claude ${flags.join(" ")} ${shellSingleQuote(params.prompt)}`,
    agentSessionId: claudeSessionId,
  };
}

function createAgentSessionId(params: BuildAgentCommandParams): string {
  return params.createSessionId ? params.createSessionId() : crypto.randomUUID();
}

async function persistFreshAgentSessionId(
  params: BuildAgentCommandParams,
  agentSessionId: string,
): Promise<void> {
  await params.persistAgentSessionId?.(agentSessionId);
}
