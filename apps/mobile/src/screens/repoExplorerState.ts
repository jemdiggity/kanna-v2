import type { RepoBrowseEntry } from "../lib/api/types";

export interface RepoExplorerLocation {
  path: string;
  filePath: string | null;
}

export interface RepoExplorerNavigation {
  current: RepoExplorerLocation;
  forward: RepoExplorerLocation[];
}

export function initialExplorerNavigation(): RepoExplorerNavigation {
  return { current: { path: "", filePath: null }, forward: [] };
}

export function navigateExplorer(
  navigation: RepoExplorerNavigation,
  location: RepoExplorerLocation
): RepoExplorerNavigation {
  return { current: location, forward: [] };
}

export function backExplorer(
  navigation: RepoExplorerNavigation
): RepoExplorerNavigation {
  const { current } = navigation;
  if (!current.filePath && !current.path) return navigation;
  const previous = current.filePath
    ? { path: current.path, filePath: null }
    : { path: parentExplorerPath(current.path), filePath: null };
  return {
    current: previous,
    forward: [current, ...navigation.forward]
  };
}

export function forwardExplorer(
  navigation: RepoExplorerNavigation
): RepoExplorerNavigation {
  const [next, ...forward] = navigation.forward;
  if (!next) return navigation;
  return { current: next, forward };
}

export function parentExplorerPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export function explorerFilterQuery(value: string): string {
  return value.trim();
}

export function appendDirectoryPage(
  current: readonly RepoBrowseEntry[],
  next: readonly RepoBrowseEntry[]
): RepoBrowseEntry[] {
  const byPath = new Map(current.map((entry) => [entry.path, entry]));
  for (const entry of next) byPath.set(entry.path, entry);
  return [...byPath.values()];
}
