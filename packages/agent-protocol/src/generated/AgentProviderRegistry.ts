// Generated from crates/kanna-agent-protocol. Do not edit manually.
import type { AgentProvider } from "./AgentProvider";
import type { AgentProviderSpec } from "./AgentProviderSpec";

export const AGENT_PROVIDER_SPECS = [
  {
    "id": "claude",
    "executable": "claude",
    "default_session_type": "agent",
    "supports_headless": true
  },
  {
    "id": "copilot",
    "executable": "copilot",
    "default_session_type": "pty",
    "supports_headless": false
  },
  {
    "id": "codex",
    "executable": "codex",
    "default_session_type": "agent",
    "supports_headless": true
  },
  {
    "id": "opencode",
    "executable": "opencode",
    "default_session_type": "agent",
    "supports_headless": true
  },
  {
    "id": "antigravity",
    "executable": "agy",
    "default_session_type": "pty",
    "supports_headless": false
  }
] as const satisfies readonly AgentProviderSpec[];
export const AGENT_PROVIDERS: readonly AgentProvider[] =
  AGENT_PROVIDER_SPECS.map(({ id }) => id);

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string"
    && AGENT_PROVIDERS.includes(value as AgentProvider);
}

export function getAgentProviderSpec(provider: AgentProvider): Readonly<AgentProviderSpec> {
  const spec = AGENT_PROVIDER_SPECS.find((candidate) => candidate.id === provider);
  if (!spec) throw new Error(`Unknown agent provider: ${provider}`);
  return spec;
}
