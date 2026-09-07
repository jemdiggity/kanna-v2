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

/**
 * A parsed compact provider selector: `provider[-model[-effort]]`.
 *
 * Workflow stage/post `agent_provider` entries name provider candidates with
 * an optional model and reasoning effort folded into one token — `claude`,
 * `codex-sol`, `claude-fable-hi`, `codex-astra-lo` — so each candidate in an
 * ordered fallback list carries its own coherent pair. Anything not specified
 * inherits the provider CLI's own defaults.
 */
export interface AgentProviderSelector {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

/**
 * Effort tokens a selector's trailing segment may use, mapped to the
 * canonical spelling. Only these tokens read as an effort suffix; any other
 * trailing segment is part of the model string. Mirrors the Rust parser in
 * crates/kanna-agent-protocol/src/providers.rs (`parse_provider_selector`) —
 * keep the two in step.
 */
const EFFORT_ALIASES: Record<string, string> = {
  lo: "low",
  low: "low",
  med: "medium",
  medium: "medium",
  hi: "high",
  high: "high",
  xhi: "xhigh",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Parse a compact provider selector, returning `null` when the value is not
 * one. The first `-`-separated segment must be a known provider id; a
 * recognized trailing effort token is the effort (normalized), and everything
 * in between is the model, kept verbatim (multi-segment ids like
 * `gpt-5-codex` survive). Provider-specific validity of the model and effort
 * (e.g. a provider with no model flag) is enforced server-side; this parser
 * covers syntax and provider identity.
 */
export function parseAgentProviderSelector(
  value: string,
): AgentProviderSelector | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const dash = trimmed.indexOf("-");
  const head = dash === -1 ? trimmed : trimmed.slice(0, dash);
  if (!isAgentProvider(head)) return null;
  if (dash === -1) return { provider: head };
  const rest = trimmed.slice(dash + 1);
  const segments = rest.split("-");
  if (segments.some((segment) => segment.length === 0)) return null;
  const last = segments[segments.length - 1];
  const effort = last !== undefined ? EFFORT_ALIASES[last] : undefined;
  const modelSegments = effort === undefined ? segments : segments.slice(0, -1);
  const selector: AgentProviderSelector = { provider: head };
  if (modelSegments.length > 0) selector.model = modelSegments.join("-");
  if (effort !== undefined) selector.effort = effort;
  return selector;
}
