import type { PipelineItem } from "@kanna/db";
import { taskSearchMatch } from "./taskSearch";

export interface SidebarItemGroup {
  stageName: string;
  items: PipelineItem[];
}

/** A task row paired with its nesting depth (0 = top-level parent, 1 = subtask, ...). */
export interface SidebarTreeRow {
  item: PipelineItem;
  depth: number;
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
  } catch (error) {
    console.debug("[sidebar-ordering] failed to parse task tags:", error);
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

/** Ids of visible (non-hidden) tasks in the repo — used to resolve subtask parents. */
function presentItemIds(options: SidebarOrderingOptions): Set<string> {
  return new Set(
    options.items
      .filter((item) => item.repo_id === options.repoId && !isHidden(item))
      .map((item) => item.id),
  );
}

/**
 * A task nests under a parent (and is therefore hidden from the flat stage/pinned/blocked
 * sections) only when its parent is itself a visible task in the same repo. Nesting is
 * suppressed during an active search so that every match stays visible in its own section.
 */
function makeNestedChildPredicate(options: SidebarOrderingOptions): (item: PipelineItem) => boolean {
  const query = normalizedSearchQuery(options.searchQuery);
  if (query) return () => false;
  const present = presentItemIds(options);
  return (item) =>
    item.parent_task_id != null
    && item.parent_task_id !== item.id
    && present.has(item.parent_task_id);
}

/** Direct subtasks of a parent, ordered oldest-first so they read in creation order. */
export function sidebarChildItems(options: SidebarOrderingOptions, parentId: string): PipelineItem[] {
  if (normalizedSearchQuery(options.searchQuery)) return [];
  return options.items
    .filter((item) =>
      item.repo_id === options.repoId
      && !isHidden(item)
      && item.id !== parentId
      && item.parent_task_id === parentId
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

/** A task and all of its descendants, depth-annotated, for nested sidebar rendering. */
export function sidebarSubtreeRows(options: SidebarOrderingOptions, root: PipelineItem): SidebarTreeRow[] {
  const rows: SidebarTreeRow[] = [];
  const seen = new Set<string>();
  const walk = (item: PipelineItem, depth: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    rows.push({ item, depth });
    for (const child of sidebarChildItems(options, item.id)) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

export function sortedSidebarPinnedItems(options: SidebarOrderingOptions): PipelineItem[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options);
  return options.items
    .filter((item) =>
      item.repo_id === options.repoId
      && !isHidden(item)
      && Boolean(item.pinned)
      && !isNestedChild(item)
      && matchesSearch(query, item)
    )
    .sort((left, right) => {
      if (query) return compareBySearchScore(query, left, right);
      return (left.pin_order ?? 0) - (right.pin_order ?? 0);
    });
}

export function sortedSidebarBlockedItems(options: SidebarOrderingOptions): PipelineItem[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options);
  const items = options.items.filter((item) =>
    item.repo_id === options.repoId
    && hasTag(item, "blocked")
    && !isHidden(item)
    && !item.pinned
    && !isNestedChild(item)
    && matchesSearch(query, item)
  );
  return query ? [...items].sort((left, right) => compareBySearchScore(query, left, right)) : sortByCreatedAt(items);
}

export function groupedSidebarItemsByStage(options: SidebarOrderingOptions): SidebarItemGroup[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options);
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
    && !isNestedChild(item)
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
  const topLevel = [
    ...sortedSidebarPinnedItems(options),
    ...groupedSidebarItemsByStage(options).flatMap((group) => group.items),
    ...sortedSidebarBlockedItems(options),
  ];

  // Re-attach subtasks directly beneath their parent so display order, task counts, and
  // keyboard navigation all agree. During an active search nesting is suppressed, so the
  // section lists already contain every match and the subtree walk is a no-op.
  const ordered: PipelineItem[] = [];
  const seen = new Set<string>();
  for (const root of topLevel) {
    for (const row of sidebarSubtreeRows(options, root)) {
      if (seen.has(row.item.id)) continue;
      seen.add(row.item.id);
      ordered.push(row.item);
    }
  }

  // Safety net for pathological parent cycles: surface any visible, search-matching task the
  // subtree walk could not reach rather than dropping it from the sidebar entirely.
  const query = normalizedSearchQuery(options.searchQuery);
  for (const item of options.items) {
    if (item.repo_id !== options.repoId || isHidden(item) || seen.has(item.id)) continue;
    if (!matchesSearch(query, item)) continue;
    seen.add(item.id);
    ordered.push(item);
  }

  return ordered;
}
