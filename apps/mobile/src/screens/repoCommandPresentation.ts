import type {
  RepoCommand,
  RepoCommandCatalog,
  RepoCommandGroup,
  RepoSummary
} from "../lib/api/types";

export interface RepoCommandSection {
  group: RepoCommandGroup;
  title: string;
  commands: RepoCommand[];
}

const GROUPS: Array<Pick<RepoCommandSection, "group" | "title">> = [
  { group: "automation", title: "Automations" },
  { group: "configure", title: "Configure Repository" }
];

export function filterCommandAvailableRepos(
  repos: readonly RepoSummary[],
  unavailableRepoIds: readonly string[],
  selectedRepoId: string | null
): RepoSummary[] {
  if (unavailableRepoIds.length === 0) return [...repos];
  const unavailable = new Set(unavailableRepoIds);
  return repos.filter(
    (repo) => repo.id === selectedRepoId || !unavailable.has(repo.id)
  );
}

export function buildRepoCommandSections(
  catalog: RepoCommandCatalog | null,
  query: string
): RepoCommandSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const commands = (catalog?.commands ?? []).filter((command) => {
    if (!normalizedQuery) return true;
    return [command.label, command.description, command.id, command.group]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  return GROUPS.map(({ group, title }) => ({
    group,
    title,
    commands: commands.filter((command) => command.group === group)
  })).filter((section) => section.commands.length > 0);
}
