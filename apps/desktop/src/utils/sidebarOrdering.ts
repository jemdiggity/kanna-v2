import type { BlockerTaskStates, PipelineItem, TaskBlocker } from "../types/kanna";
import type { SidebarTaskItem } from "../types/taskUi";
import { isBlockerResolved } from "./blockerResolution";
import { taskSearchMatch, type TaskSearchable } from "./taskSearch";

interface OrderingItem extends TaskSearchable {
  repo_id: string;
  closed_at: string | null;
  pinned: number;
  pin_order: number | null;
  stage: string;
  pr_url: string | null;
  parent_task_id: string | null;
  created_at: string;
}

interface ItemIdentity<T> {
  rowId: (item: T) => string;
  taskId: (item: T) => string | null;
}

interface OrderingOptions<T extends OrderingItem> {
  repoId: string;
  items: readonly T[];
  blockers?: readonly TaskBlocker[];
  blockerTaskStates?: Readonly<BlockerTaskStates>;
  getStageOrder: (repoId: string) => readonly string[];
  searchQuery?: string;
}

interface ItemGroup<T> {
  stageName: string;
  items: T[];
}

interface TreeRow<T> {
  item: T;
  depth: number;
}

interface SidebarOrderingOptions extends OrderingOptions<PipelineItem> {}

export interface SidebarItemGroup extends ItemGroup<PipelineItem> {}

/** A durable task row paired with its nesting depth (0 = top-level parent, 1 = subtask, ...). */
export interface SidebarTreeRow extends TreeRow<PipelineItem> {}

export interface SidebarTaskOrderingOptions extends OrderingOptions<SidebarTaskItem> {}

export interface SidebarTaskItemGroup extends ItemGroup<SidebarTaskItem> {}

/** A presentation slot paired with its nesting depth (0 = top-level parent, 1 = subtask, ...). */
export interface SidebarTaskTreeRow extends TreeRow<SidebarTaskItem> {}

const DURABLE_IDENTITY: ItemIdentity<PipelineItem> = {
  rowId: (item) => item.id,
  taskId: (item) => item.id,
};

const SLOT_IDENTITY: ItemIdentity<SidebarTaskItem> = {
  rowId: (item) => item.slot_id,
  taskId: (item) => item.task_id,
};

function isHidden(item: { closed_at?: string | null }): boolean {
  return item.closed_at != null;
}

function matchesSearch(query: string, item: TaskSearchable): boolean {
  if (!query) return true;
  return taskSearchMatch(query, item) !== null;
}

function searchScore(query: string, item: TaskSearchable): number {
  if (!query) return 0;
  return taskSearchMatch(query, item)?.score ?? 0;
}

function compareBySearchScore<T extends OrderingItem>(query: string, left: T, right: T): number {
  const scoreLeft = searchScore(query, left);
  const scoreRight = searchScore(query, right);
  if (scoreLeft !== scoreRight) return scoreRight - scoreLeft;
  return right.created_at.localeCompare(left.created_at);
}

function sortByCreatedAt<T extends OrderingItem>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function normalizedSearchQuery(query: string | undefined): string {
  return query?.trim() ?? "";
}

/**
 * A task shows as blocked only while at least one of its blockers is
 * unresolved. Blockers resolve optimistically (closed, or parked at `pr`
 * with a PR created — see isBlockerResolved), so a dependent that started
 * stacking on a PR'd blocker leaves the blocked section even though its
 * task_blocker rows persist after resolution. Blocker task state is projected
 * separately because closed and hidden blockers are absent from `items`.
 * A blocker with no projected or visible state counts as unresolved.
 */
function blockedTaskIds<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): Set<string> {
  const itemsByTaskId = new Map<string, T>();
  for (const item of options.items) {
    const taskId = identity.taskId(item);
    if (taskId !== null) itemsByTaskId.set(taskId, item);
  }

  const blocked = new Set<string>();
  for (const blocker of options.blockers ?? []) {
    const blockerState = options.blockerTaskStates?.[blocker.blocker_item_id]
      ?? itemsByTaskId.get(blocker.blocker_item_id);
    if (!blockerState || !isBlockerResolved(blockerState)) {
      blocked.add(blocker.blocked_item_id);
    }
  }
  return blocked;
}

/** Durable ids of visible tasks in the repo, used to resolve subtask parents. */
function presentTaskIds<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): Set<string> {
  const present = new Set<string>();
  for (const item of options.items) {
    if (item.repo_id !== options.repoId || isHidden(item)) continue;
    const taskId = identity.taskId(item);
    if (taskId !== null) present.add(taskId);
  }
  return present;
}

/**
 * A task nests under a parent only when both rows have durable identities.
 * Nesting is suppressed during search so every match remains independently visible.
 */
function makeNestedChildPredicate<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): (item: T) => boolean {
  const query = normalizedSearchQuery(options.searchQuery);
  if (query) return () => false;
  const present = presentTaskIds(options, identity);
  return (item) => {
    const taskId = identity.taskId(item);
    return taskId !== null
      && item.parent_task_id !== null
      && item.parent_task_id !== taskId
      && present.has(item.parent_task_id);
  };
}

function childItems<T extends OrderingItem>(
  options: OrderingOptions<T>,
  parentTaskId: string,
  identity: ItemIdentity<T>,
): T[] {
  if (normalizedSearchQuery(options.searchQuery)) return [];
  return options.items
    .filter((item) => {
      const taskId = identity.taskId(item);
      return item.repo_id === options.repoId
        && !isHidden(item)
        && taskId !== null
        && taskId !== parentTaskId
        && item.parent_task_id === parentTaskId;
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function subtreeRows<T extends OrderingItem>(
  options: OrderingOptions<T>,
  root: T,
  identity: ItemIdentity<T>,
): Array<TreeRow<T>> {
  const rows: Array<TreeRow<T>> = [];
  const seenRowIds = new Set<string>();
  const walk = (item: T, depth: number) => {
    const rowId = identity.rowId(item);
    if (seenRowIds.has(rowId)) return;
    seenRowIds.add(rowId);
    rows.push({ item, depth });
    const taskId = identity.taskId(item);
    if (taskId === null) return;
    for (const child of childItems(options, taskId, identity)) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

function sortedPinnedItems<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): T[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options, identity);
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

function sortedBlockedItems<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): T[] {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options, identity);
  const blockedIds = blockedTaskIds(options, identity);
  const items = options.items.filter((item) => {
    const taskId = identity.taskId(item);
    return item.repo_id === options.repoId
      && taskId !== null
      && blockedIds.has(taskId)
      && !isHidden(item)
      && !item.pinned
      && !isNestedChild(item)
      && matchesSearch(query, item);
  });
  return query
    ? [...items].sort((left, right) => compareBySearchScore(query, left, right))
    : sortByCreatedAt(items);
}

function groupedItemsByStage<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): Array<ItemGroup<T>> {
  const query = normalizedSearchQuery(options.searchQuery);
  const isNestedChild = makeNestedChildPredicate(options, identity);
  const blockedIds = blockedTaskIds(options, identity);

  const stageItems = options.items.filter((item) => {
    const taskId = identity.taskId(item);
    return item.repo_id === options.repoId
      && !isHidden(item)
      && !item.pinned
      && (taskId === null || !blockedIds.has(taskId))
      && !isNestedChild(item)
      && matchesSearch(query, item);
  });

  const groups = new Map<string, T[]>();
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

function sortItemsForRepo<T extends OrderingItem>(
  options: OrderingOptions<T>,
  identity: ItemIdentity<T>,
): T[] {
  const topLevel = [
    ...sortedPinnedItems(options, identity),
    ...groupedItemsByStage(options, identity).flatMap((group) => group.items),
    ...sortedBlockedItems(options, identity),
  ];

  const ordered: T[] = [];
  const seenRowIds = new Set<string>();
  for (const root of topLevel) {
    for (const row of subtreeRows(options, root, identity)) {
      const rowId = identity.rowId(row.item);
      if (seenRowIds.has(rowId)) continue;
      seenRowIds.add(rowId);
      ordered.push(row.item);
    }
  }

  // Safety net for pathological parent cycles: surface visible matching rows that no root reached.
  const query = normalizedSearchQuery(options.searchQuery);
  for (const item of options.items) {
    const rowId = identity.rowId(item);
    if (item.repo_id !== options.repoId || isHidden(item) || seenRowIds.has(rowId)) continue;
    if (!matchesSearch(query, item)) continue;
    seenRowIds.add(rowId);
    ordered.push(item);
  }

  return ordered;
}

// Durable adapters retained for snapshot/store consumers until they migrate to UI slots.
export function sidebarChildItems(options: SidebarOrderingOptions, parentId: string): PipelineItem[] {
  return childItems(options, parentId, DURABLE_IDENTITY);
}

export function sidebarSubtreeRows(
  options: SidebarOrderingOptions,
  root: PipelineItem,
): SidebarTreeRow[] {
  return subtreeRows(options, root, DURABLE_IDENTITY);
}

export function sortedSidebarPinnedItems(options: SidebarOrderingOptions): PipelineItem[] {
  return sortedPinnedItems(options, DURABLE_IDENTITY);
}

export function sortedSidebarBlockedItems(options: SidebarOrderingOptions): PipelineItem[] {
  return sortedBlockedItems(options, DURABLE_IDENTITY);
}

export function groupedSidebarItemsByStage(options: SidebarOrderingOptions): SidebarItemGroup[] {
  return groupedItemsByStage(options, DURABLE_IDENTITY);
}

export function sortSidebarItemsForRepo(options: SidebarOrderingOptions): PipelineItem[] {
  return sortItemsForRepo(options, DURABLE_IDENTITY);
}

// Slot-aware APIs keep UI row identity separate from nullable durable task identity.
export function sidebarTaskChildItems(
  options: SidebarTaskOrderingOptions,
  parentTaskId: string,
): SidebarTaskItem[] {
  return childItems(options, parentTaskId, SLOT_IDENTITY);
}

export function sidebarTaskSubtreeRows(
  options: SidebarTaskOrderingOptions,
  root: SidebarTaskItem,
): SidebarTaskTreeRow[] {
  return subtreeRows(options, root, SLOT_IDENTITY);
}

export function sortedSidebarTaskPinnedItems(
  options: SidebarTaskOrderingOptions,
): SidebarTaskItem[] {
  return sortedPinnedItems(options, SLOT_IDENTITY);
}

export function sortedSidebarTaskBlockedItems(
  options: SidebarTaskOrderingOptions,
): SidebarTaskItem[] {
  return sortedBlockedItems(options, SLOT_IDENTITY);
}

export function groupedSidebarTaskItemsByStage(
  options: SidebarTaskOrderingOptions,
): SidebarTaskItemGroup[] {
  return groupedItemsByStage(options, SLOT_IDENTITY);
}

export function sortSidebarTaskItemsForRepo(
  options: SidebarTaskOrderingOptions,
): SidebarTaskItem[] {
  return sortItemsForRepo(options, SLOT_IDENTITY);
}
