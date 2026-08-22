import type { RepoBrowseEntry } from "../lib/api/types";

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
