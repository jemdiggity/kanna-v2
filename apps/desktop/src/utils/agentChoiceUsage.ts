import type { AgentProvider } from "@kanna/db";
import type { AgentExecutionType } from "../stores/agentExecutionType";

export type RecentAgentChoice = {
  provider: AgentProvider;
  executionType: AgentExecutionType;
};

const VALID_PROVIDERS = new Set(["claude", "copilot", "codex", "opencode", "antigravity"]);
const VALID_EXECUTION_TYPES = new Set(["pty", "agent"]);

function isRecentAgentChoice(value: unknown): value is RecentAgentChoice {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { provider?: unknown; executionType?: unknown };
  return typeof candidate.provider === "string"
    && VALID_PROVIDERS.has(candidate.provider)
    && typeof candidate.executionType === "string"
    && VALID_EXECUTION_TYPES.has(candidate.executionType);
}

export function agentChoiceKey(choice: RecentAgentChoice): string {
  return `${choice.provider}:${choice.executionType}`;
}

export function parseRecentAgentChoices(raw: string | null | undefined): RecentAgentChoice[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const choices: RecentAgentChoice[] = [];
    for (const entry of parsed) {
      if (!isRecentAgentChoice(entry)) continue;
      const key = agentChoiceKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(entry);
    }
    return choices;
  } catch {
    return [];
  }
}

export function promoteRecentAgentChoice(
  choices: RecentAgentChoice[],
  choice: RecentAgentChoice,
): RecentAgentChoice[] {
  const promotedKey = agentChoiceKey(choice);
  return [
    choice,
    ...choices.filter((existing) => agentChoiceKey(existing) !== promotedKey),
  ];
}

export function sortAgentChoicesByRecentUsage<T extends RecentAgentChoice>(
  choices: T[],
  recentChoices: RecentAgentChoice[],
): T[] {
  const recentIndex = new Map(recentChoices.map((choice, index) => [agentChoiceKey(choice), index]));
  return choices
    .map((choice, index) => ({ choice, index, recent: recentIndex.get(agentChoiceKey(choice)) }))
    .sort((a, b) => {
      if (a.recent !== undefined && b.recent !== undefined) return a.recent - b.recent;
      if (a.recent !== undefined) return -1;
      if (b.recent !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.choice);
}
