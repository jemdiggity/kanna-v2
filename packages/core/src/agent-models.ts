import type { AgentProvider } from "@kanna/agent-protocol";

/**
 * Models offered by the agent UI's model picker, per provider.
 *
 * These ids are passed verbatim to the provider CLI (`--model` for Claude's
 * stream-json `set_model`, `-m` for `codex exec`). They are the source of truth
 * for both the desktop dropdown and the real CLI contract tests, which confirm
 * each id is accepted by the actual CLI. Update them together.
 */
export interface AgentModelOption {
  /** Model id passed to the CLI. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
}

export const AGENT_MODELS: Partial<Record<AgentProvider, AgentModelOption[]>> = {
  claude: [
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  ],
  // Confirmed against `codex exec -m <id>` (see tests/cli-contract).
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  ],
};

export function agentModelsFor(provider: AgentProvider | undefined): AgentModelOption[] {
  if (provider === undefined) return AGENT_MODELS.claude ?? [];
  return AGENT_MODELS[provider] ?? [];
}
