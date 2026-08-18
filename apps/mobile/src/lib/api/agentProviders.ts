import {
  AGENT_PROVIDERS,
  isAgentProvider,
  type AgentProvider
} from "@kanna/agent-protocol";
import type { DesktopSummary } from "./types";

/**
 * A desktop's reported agent provider inventory, or `undefined` when the
 * machine did not report one.
 *
 * Unknown names are dropped rather than rejected: a desktop can ship a provider
 * this app build has never heard of, and the rest of its inventory is still
 * usable. A reported-but-empty list survives as `[]`, which is a different
 * answer from "not reported".
 */
export function parseAgentProviderInventory(
  value: unknown
): AgentProvider[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((provider): provider is AgentProvider =>
    typeof provider === "string" && isAgentProvider(provider)
  );
}

/**
 * Agent providers the composer may offer for a machine.
 *
 * Inventory is advisory. A machine that reported nothing — an older desktop, or
 * a record that could not carry the field — degrades to the full supported set,
 * which is the behaviour that shipped before inventory existed. Only a machine
 * that positively reported an empty inventory narrows the list to nothing.
 */
export function agentProviderOptionsForDesktop(
  desktop: Pick<DesktopSummary, "agentProviders"> | null | undefined
): AgentProvider[] {
  const reported = desktop?.agentProviders;
  if (!reported) return [...AGENT_PROVIDERS];
  return AGENT_PROVIDERS.filter((provider) => reported.includes(provider));
}

/** True when the machine itself reported that it can run no agent at all. */
export function desktopReportsNoAgentProvider(
  desktop: Pick<DesktopSummary, "agentProviders"> | null | undefined
): boolean {
  return Array.isArray(desktop?.agentProviders) && desktop.agentProviders.length === 0;
}

/**
 * The provider a task for this machine should be created with: the preferred
 * one when that machine can run it, otherwise the machine's own first choice in
 * registry order. `null` when the machine offers nothing — the caller must not
 * substitute a provider the machine cannot spawn.
 */
export function resolveAgentProviderForDesktop(
  preferred: AgentProvider | null | undefined,
  desktop: Pick<DesktopSummary, "agentProviders"> | null | undefined
): AgentProvider | null {
  const options = agentProviderOptionsForDesktop(desktop);
  if (preferred && options.includes(preferred)) return preferred;
  return options[0] ?? null;
}
