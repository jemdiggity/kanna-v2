// Single source of truth for the set of agent providers Kanna understands, plus
// the shared frontmatter-parsing helpers used by both the agent-definition loader
// (`.kanna/agents/*/AGENT.md`) and the task-template loader (`.kanna/tasks/*/agent.md`).
//
// Keep VALID_AGENT_PROVIDERS in sync with `AgentProvider` in `@kanna/db`
// (packages/db/src/schema.ts) and with the `agent_provider` enum in
// `.kanna/pipelines/schema.json`. `@kanna/core` intentionally does not depend on
// `@kanna/db`, so the union is duplicated here rather than imported.

export const VALID_AGENT_PROVIDERS = [
  "claude",
  "copilot",
  "codex",
  "opencode",
  "antigravity",
] as const;

export type KnownAgentProvider = (typeof VALID_AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is KnownAgentProvider {
  return typeof value === "string" && (VALID_AGENT_PROVIDERS as readonly string[]).includes(value);
}

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
