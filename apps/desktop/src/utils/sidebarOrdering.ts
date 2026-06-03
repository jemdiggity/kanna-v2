import type { PipelineItem } from "@kanna/db";
import { taskSearchMatch } from "./taskSearch";

export interface SidebarItemGroup {
  stageName: string;
  items: PipelineItem[];
}

interface SidebarOrderingOptions {
  repoId: string;
  items: readonly PipelineItem[];
  getStageOrder: (repoId: string) => readonly string[];
  searchQuery?: string;
}

function hasTag(item: { tags: string }, tag: string): boolean {
  try {
    return (JSON.parse(item.tags) as string[]).includes(tag);
  } catch {
    return false;
  }
}

function isHidden(item: { stage: string; closed_at?: string | null }): boolean {
  return item.stage === "done" || item.closed_at != null;
}

function matchesSearch(query: string, item: PipelineItem): boolean {
  if (!query) return true;
  return taskSearchMatch(query, item) !== null;
}

function searchScore(query: string, item: PipelineItem): number {
  if (!query) return 0;
  return taskSearchMatch(query, item)?.score ?? 0;
}

function compareBySearchScore(query: string, left: PipelineItem, right: PipelineItem): number {
  const scoreLeft = searchScore(query, left);
  const scoreRight = searchScore(query, right);
  if (scoreLeft !== scoreRight) return scoreRight - scoreLeft;
  return right.created_at.localeCompare(left.created_at);
}

function sortByCreatedAt(items: PipelineItem[]): PipelineItem[] {
  return [...items].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function normalizedSearchQuery(query: string | undefined): string {
  return query?.trim() ?? "";
}

export function sortedSidebarPinnedItems(options: SidebarOrderingOptions): PipelineItem[] {
  const query = normalizedSearchQuery(options.searchQuery);
  return options.items
    .filter((item) =>
      item.repo_id === options.repoId
      && !isHidden(item)
      && Boolean(item.pinned)
      && matchesSearch(query, item)
    )
    .sort((left, right) => {
      if (query) return compareBySearchScore(query, left, right);
      return (left.pin_order ?? 0) - (right.pin_order ?? 0);
    });
}

export function sortedSidebarBlockedItems(options: SidebarOrderingOptions): PipelineItem[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const items = options.items.filter((item) =>
    item.repo_id === options.repoId
    && hasTag(item, "blocked")
    && !isHidden(item)
    && !item.pinned
    && matchesSearch(query, item)
  );
  return query ? [...items].sort((left, right) => compareBySearchScore(query, left, right)) : sortByCreatedAt(items);
}

export function groupedSidebarItemsByStage(options: SidebarOrderingOptions): SidebarItemGroup[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const blockedIds = new Set(
    options.items
      .filter((item) =>
        item.repo_id === options.repoId
        && hasTag(item, "blocked")
        && !isHidden(item)
        && !item.pinned
      )
      .map((item) => item.id),
  );

  const stageItems = options.items.filter((item) =>
    item.repo_id === options.repoId
    && !isHidden(item)
    && !item.pinned
    && !blockedIds.has(item.id)
    && matchesSearch(query, item)
  );

  const groups = new Map<string, PipelineItem[]>();
  for (const item of stageItems) {
    if (!groups.has(item.stage)) groups.set(item.stage, []);
    groups.get(item.stage)!.push(item);
  }

  for (const items of groups.values()) {
    items.sort(query
      ? (left, right) => compareBySearchScore(query, left, right)
      : (left, right) => right.created_at.localeCompare(left.created_at));
  }

  const order = options.getStageOrder(options.repoId);
  const stageNames = [...groups.keys()].sort((left, right) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    const leftOrder = leftIndex === -1 ? order.length : leftIndex;
    const rightOrder = rightIndex === -1 ? order.length : rightIndex;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.localeCompare(right);
  });

  return stageNames
    .map((stageName) => ({ stageName, items: groups.get(stageName) ?? [] }))
    .filter((group) => group.items.length > 0);
}

export function sortSidebarItemsForRepo(options: SidebarOrderingOptions): PipelineItem[] {
  return [
    ...sortedSidebarPinnedItems(options),
    ...groupedSidebarItemsByStage(options).flatMap((group) => group.items),
    ...sortedSidebarBlockedItems(options),
  ];
}
