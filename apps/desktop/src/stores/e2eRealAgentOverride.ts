import type { AgentProvider } from "@kanna/db";
import { invoke } from "../invoke";
import type { AgentExecutionType } from "./agentExecutionType";

export interface RealE2eAgentOverrideInput {
  agentType: AgentExecutionType;
  explicitAgentProvider?: AgentProvider | AgentProvider[];
  explicitModel?: string;
}

export interface RealE2eAgentOverride {
  agentProvider: AgentProvider;
  model: string | null;
}

function isAgentProvider(value: string): value is AgentProvider {
  return value === "claude" || value === "copilot" || value === "codex" || value === "opencode";
}

async function readEnv(name: string): Promise<string> {
  try {
    return (await invoke<string>("read_env_var", { name })) || "";
  } catch {
    return "";
  }
}

export async function resolveRealE2eAgentOverride(
  input: RealE2eAgentOverrideInput,
): Promise<RealE2eAgentOverride | null> {
  if (input.agentType !== "pty") return null;

  const [rawProvider, rawModel] = await Promise.all([
    readEnv("KANNA_E2E_REAL_AGENT_PROVIDER"),
    readEnv("KANNA_E2E_REAL_AGENT_MODEL"),
  ]);

  const provider = rawProvider.trim();
  if (!isAgentProvider(provider)) return null;

  const model = rawModel.trim();
  return {
    agentProvider: provider,
    model: model.length > 0 ? model : null,
  };
}
