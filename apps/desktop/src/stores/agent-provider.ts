import type { AgentProvider } from "../types/kanna";

// Provider-selection policy (how a multi-provider agent/stage resolves to the one
// provider a task actually spawns with):
//
//   1. Precedence between sources (getPreferredAgentProviders): explicit > stage >
//      agent > item. The first source that names any provider wins outright; lower
//      sources are NOT consulted, even if the winning source's providers are all
//      unavailable. So a stage-level provider intentionally overrides the agent
//      definition's list, which in turn overrides the task's stored provider.
//   2. Within the winning source's ordered candidate list (resolveAgentProvider),
//      the first *installed/available* provider is chosen.
//   3. If the winning source has candidates but none are available, resolution
//      throws rather than silently falling back to another source or provider.
//
// Note: the ordered list in a built-in agent definition takes precedence over
// the task's stored provider on stage advance. Change the ordering in an
// AGENT.md, or set a stage/explicit provider, to override.

export type AgentProviderAvailability = Record<AgentProvider, boolean>;

export interface AgentProviderPrecedenceSources {
  explicit?: AgentProvider | AgentProvider[];
  stage?: AgentProvider | AgentProvider[];
  agent?: AgentProvider | AgentProvider[];
  item?: AgentProvider | AgentProvider[];
}

export function normalizeAgentProviderCandidates(
  providers: AgentProvider | AgentProvider[] | undefined,
): AgentProvider[] {
  if (!providers) return [];
  return Array.isArray(providers) ? providers : [providers];
}

export function getPreferredAgentProviders(sources: AgentProviderPrecedenceSources): AgentProvider[] {
  const providersByPrecedence = [sources.explicit, sources.stage, sources.agent, sources.item];
  for (const providers of providersByPrecedence) {
    const candidates = normalizeAgentProviderCandidates(providers);
    if (candidates.length > 0) return candidates;
  }

  return [];
}

export function resolveAgentProvider(
  providers: AgentProvider | AgentProvider[] | undefined,
  availability: AgentProviderAvailability,
): AgentProvider {
  const candidates = normalizeAgentProviderCandidates(providers);
  if (candidates.length === 0) {
    throw new Error("No agent provider configured for this request.");
  }

  for (const provider of candidates) {
    if (availability[provider]) return provider;
  }

  throw new Error(`None of the configured agent providers are available: ${candidates.join(", ")}.`);
}

export function requireResolvedAgentProvider(provider: AgentProvider | undefined): AgentProvider {
  if (!provider) {
    throw new Error("No agent provider resolved for PTY spawn.");
  }

  return provider;
}
