// Provider identity comes from the generated @kanna/agent-protocol contract.
// This module keeps the shared frontmatter helper alongside compatibility
// exports used by the agent-definition and task-template loaders.
import {
  AGENT_PROVIDERS,
  isAgentProvider,
  type AgentProvider,
} from "@kanna/agent-protocol";

export { AGENT_PROVIDERS, isAgentProvider };
export type { AgentProvider };
export const VALID_AGENT_PROVIDERS = AGENT_PROVIDERS;
export type KnownAgentProvider = AgentProvider;

/**
 * Split a frontmatter `agent_provider` value into an ordered list of trimmed,
 * non-empty tokens. Accepts a YAML array, a single string, or a comma-separated
 * string (e.g. `codex, claude, copilot, opencode, antigravity`). Does not validate the tokens — callers
 * decide whether unknown providers should throw or be filtered out.
 */
export function splitAgentProviderValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}
