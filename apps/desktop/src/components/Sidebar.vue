<script setup lang="ts">
import type {
  BlockerTaskStates,
  Repo,
  TaskBlocker,
} from "../types/kanna";
import type { ReadySidebarTaskItem, SidebarTaskItem } from "../types/taskUi";
import { computed, ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import draggable from "vuedraggable";
import { taskSearchMatch } from "../utils/taskSearch";
import { isTaskWorking, showsUnreadMark } from "../utils/taskActivityDisplay";
import {
  groupedSidebarTaskItemsByStage,
  sidebarTaskSubtreeRows,
  sortedSidebarTaskBlockedItems,
  sortedSidebarTaskPinnedItems,
  sortSidebarTaskItemsForRepo,
  type SidebarTaskTreeRow,
} from "../utils/sidebarOrdering";
import { useKannaStore } from "../stores/kanna";
import { isTaskTearingDown } from "../stores/taskStages";
import { macOsTextInputAttrs } from "../utils/textInput";

const { t } = useI18n();
const store = useKannaStore();

const props = defineProps<{
  repos: Repo[];
  taskSlots: SidebarTaskItem[];
  selectedRepoId: string | null;
  selectedSlotId: string | null;
  blockerNames?: Record<string, string>;
  taskBlockers?: readonly TaskBlocker[];
  blockerTaskStates?: Readonly<BlockerTaskStates>;
}>();

const emit = defineEmits<{
  (e: "select-repo", id: string): void;
  (e: "select-item", id: string): void;
  (e: "new-task", repoId: string): void;
  (e: "pin-item", itemId: string, position: number): void;
  (e: "unpin-item", itemId: string): void;
  (e: "reorder-pinned", repoId: string, orderedIds: string[]): void;
  (e: "reorder-repos", orderedIds: string[]): void;
  (e: "set-parent", childId: string, parentId: string | null): void;
  (e: "rename-item", itemId: string, displayName: string | null): void;
  (e: "rename-repo", repoId: string, name: string): void;
  (e: "hide-repo", repoId: string): void;
  (e: "rename-done"): void;
}>();

interface DraggableChange<T> {
  added?: {
    element: T;
    newIndex: number;
  };
  moved?: {
    oldIndex: number;
    newIndex: number;
  };
}

const collapsedRepos = ref<Set<string>>(new Set());
const searchQuery = ref("");
const searchInputRef = ref<HTMLInputElement | null>(null);
const sidebarContentRef = ref<HTMLElement | null>(null);
const preSearchCollapsed = ref<Set<string> | null>(null);
const repoDrag = ref<{ repoId: string; startY: number; active: boolean; overRepoId: string | null } | null>(null);
const suppressNextRepoClick = ref(false);
const trimmedSearchQuery = computed(() => searchQuery.value.trim());
const hasActiveSearch = computed(() => trimmedSearchQuery.value.length > 0);
const selectedVisibleSlotId = computed(() => {
  const item = props.selectedSlotId
    ? props.taskSlots.find((candidate) => candidate.slot_id === props.selectedSlotId)
    : null;
  return item && item.closed_at == null ? item.slot_id : null;
});
const selectedTaskRepoId = computed(() => {
  const item = props.selectedSlotId
    ? props.taskSlots.find((candidate) => candidate.slot_id === props.selectedSlotId)
    : null;
  return item && item.closed_at == null ? item.repo_id : null;
});
function isSearchActive(): boolean {
  return searchQuery.value.trim().length > 0;
}

function clearSearch(): void {
  searchQuery.value = "";
  nextTick(() => searchInputRef.value?.focus());
}

function matchesSearch(item: SidebarTaskItem): boolean {
  const q = trimmedSearchQuery.value;
  if (!q) return true;
  return taskSearchMatch(q, item) !== null;
}

function sidebarOrderingOptions(repoId: string) {
  return {
    repoId,
    items: props.taskSlots,
    blockers: props.taskBlockers ?? store.taskBlockers,
    blockerTaskStates: props.blockerTaskStates ?? store.blockerTaskStates,
    getStageOrder: store.getStageOrder,
    searchQuery: searchQuery.value,
  };
}

function sortedPinned(repoId: string): SidebarTaskItem[] {
  return sortedSidebarTaskPinnedItems(sidebarOrderingOptions(repoId));
}

function sortedBlocked(repoId: string): SidebarTaskItem[] {
  return sortedSidebarTaskBlockedItems(sidebarOrderingOptions(repoId));
}

interface StageGroup {
  stageName: string;
  items: SidebarTaskItem[];
}

/**
 * Group non-pinned, non-blocked items for a repo by their stage field.
 * Stage order comes from the store (repo config or DEFAULT_STAGE_ORDER).
 * Stages not in the configured order sort alphabetically after listed stages.
 */
function groupedByStage(repoId: string): StageGroup[] {
  return groupedSidebarTaskItemsByStage(sidebarOrderingOptions(repoId));
}

function itemsForRepo(repoId: string): SidebarTaskItem[] {
  return sortSidebarTaskItemsForRepo(sidebarOrderingOptions(repoId));
}

/** A top-level task plus its nested subtasks, depth-annotated for indented rendering. */
function subtreeRows(repoId: string, item: SidebarTaskItem): SidebarTaskTreeRow[] {
  return sidebarTaskSubtreeRows(sidebarOrderingOptions(repoId), item);
}

function renderedSlotIds(repoId: string): Set<string> {
  const ids = new Set<string>();
  const roots = [
    ...sortedPinned(repoId),
    ...groupedByStage(repoId).flatMap((group) => group.items),
    ...sortedBlocked(repoId),
  ];
  for (const root of roots) {
    for (const row of subtreeRows(repoId, root)) {
      ids.add(row.item.slot_id);
    }
  }
  return ids;
}

function fallbackItems(repoId: string): SidebarTaskItem[] {
  const rendered = renderedSlotIds(repoId);
  return itemsForRepo(repoId).filter((item) => !rendered.has(item.slot_id));
}

function fallbackGroups(repoId: string): StageGroup[] {
  const groups = new Map<string, SidebarTaskItem[]>();
  for (const item of fallbackItems(repoId)) {
    if (!groups.has(item.stage)) groups.set(item.stage, []);
    groups.get(item.stage)!.push(item);
  }

  const order = store.getStageOrder(repoId);
  return [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      const leftOrder = leftIndex === -1 ? order.length : leftIndex;
      const rightOrder = rightIndex === -1 ? order.length : rightIndex;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.localeCompare(right);
    })
    .map(([stageName, items]) => ({ stageName, items }));
}

function subtaskIndentStyle(depth: number): Record<string, string> {
  return depth > 0 ? { paddingLeft: `${14 + depth * 16}px` } : {};
}

/**
 * Remote subtasks render nested from the owner's published task graph, but
 * reparenting is an owner-side edit, so the detach affordance stays local-only.
 */
function canDetachSubtask(row: SidebarTaskTreeRow): boolean {
  return row.depth > 0
    && row.item.state === "ready"
    && !isRemoteTask(row.item)
    && editingSlotId.value !== row.item.slot_id;
}

function totalItemsForRepo(repoId: string): number {
  return props.taskSlots.filter((i) => i.repo_id === repoId && i.closed_at == null).length;
}

function repoCountLabel(repoId: string): string {
  const visible = itemsForRepo(repoId).length;
  if (!hasActiveSearch.value) return String(visible);
  return `${visible}/${totalItemsForRepo(repoId)}`;
}

function itemTitle(item: SidebarTaskItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  // A running post (e.g. commit) executes inside the live session while the
  // stage stays put; the "..." prefix is the transition-in-flight signal.
  return item.has_running_post ? `... ${raw}` : raw;
}

function itemTooltip(item: SidebarTaskItem): string | undefined {
  const marker = transferMarker(item);
  return marker ? `${itemTitle(item)} — ${marker.label}` : itemTitle(item);
}

function isRemoteTask(item: SidebarTaskItem): boolean {
  return item.remote_task === true;
}

/**
 * A cross-machine transfer moves a task off this machine (or onto it) while
 * both sidebars would otherwise show nothing at all. `transfer_status` is the
 * same field for either direction: a task being pushed away and a task still
 * importing both sit in one of these in-flight states.
 */
const IN_FLIGHT_TRANSFER_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "claimed",
  "streaming",
  "importing",
  "awaiting_acknowledgment",
]);

type TransferDisplayState = "transferring" | "failed";

interface TransferMarker {
  state: TransferDisplayState;
  glyph: string;
  label: string;
}

/**
 * Rows are re-derived per repo group and rendered from four call sites, so the
 * marker is resolved once per snapshot and looked up by slot.
 */
const transferMarkers = computed<ReadonlyMap<string, TransferMarker>>(() => {
  const markers = new Map<string, TransferMarker>();
  for (const item of props.taskSlots) {
    const status = item.transfer_status ?? "";
    if (IN_FLIGHT_TRANSFER_STATUSES.has(status)) {
      markers.set(item.slot_id, {
        state: "transferring",
        glyph: "⇄",
        label: t("sidebar.transferringTaskTooltip"),
      });
    } else if (status === "failed") {
      markers.set(item.slot_id, {
        state: "failed",
        glyph: "⇄✗",
        label: t("sidebar.transferFailedTaskTooltip"),
      });
    }
  }
  return markers;
});

function transferMarker(item: SidebarTaskItem): TransferMarker | undefined {
  return transferMarkers.value.get(item.slot_id);
}

function isReadyTask(item: SidebarTaskItem | null | undefined): item is ReadySidebarTaskItem {
  return item?.state === "ready";
}

function readyTaskByDurableId(taskId: string | null | undefined): ReadySidebarTaskItem | null {
  if (!taskId) return null;
  return props.taskSlots.find((item): item is ReadySidebarTaskItem =>
    item.state === "ready" && item.task_id === taskId,
  ) ?? null;
}

function currentReadyTask(item: SidebarTaskItem | null | undefined): ReadySidebarTaskItem | null {
  if (!item) return null;
  return props.taskSlots.find((candidate): candidate is ReadySidebarTaskItem =>
    candidate.slot_id === item.slot_id
    && candidate.state === "ready"
    && candidate.task_id === item.task_id,
  ) ?? null;
}

const editingSlotId = ref<string | null>(null);
const editingValue = ref("");
const editingRepoId = ref<string | null>(null);
const editingRepoValue = ref("");

function startRename(item: SidebarTaskItem) {
  const readyItem = currentReadyTask(item);
  if (!readyItem) return;
  editingRepoId.value = null;
  editingSlotId.value = readyItem.slot_id;
  editingValue.value = readyItem.display_name || readyItem.issue_title || readyItem.prompt || "";
  nextTick(() => {
    const input = document.querySelector('.rename-input') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function startRepoRename(repo: Repo) {
  editingSlotId.value = null;
  editingRepoId.value = repo.id;
  editingRepoValue.value = repo.name;
  nextTick(() => {
    const input = document.querySelector('.repo-rename-input') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function commitRepoRename(repoId: string) {
  const trimmed = editingRepoValue.value.trim();
  const repo = props.repos.find((candidate) => candidate.id === repoId);
  if (trimmed && trimmed !== repo?.name) {
    emit("rename-repo", repoId, trimmed);
  }
  editingRepoId.value = null;
  emit("rename-done");
}

function cancelRepoRename() {
  editingRepoId.value = null;
  emit("rename-done");
}

function commitRename(slotId: string) {
  const item = props.taskSlots.find((candidate) => candidate.slot_id === slotId);
  if (!isReadyTask(item)) {
    editingSlotId.value = null;
    return;
  }
  const trimmed = editingValue.value.trim();
  const original = item?.issue_title || item?.prompt || "";
  // If cleared or matches original, set to null (remove custom name)
  const displayName = trimmed && trimmed !== original ? trimmed : null;
  emit("rename-item", item.task_id, displayName);
  editingSlotId.value = null;
  emit("rename-done");
}

function cancelRename() {
  editingSlotId.value = null;
  emit("rename-done");
}

/** Prevent sidebar clicks from stealing focus, except on inputs (rename). */
function preventFocusSteal(e: MouseEvent) {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
    e.preventDefault();
  }
}

function handleSelectRepo(repoId: string) {
  if (suppressNextRepoClick.value) return;
  emit("select-repo", repoId);
}

function handleSelectItem(item: SidebarTaskItem) {
  emit("select-item", item.slot_id);
}

function toggleRepo(repoId: string) {
  if (collapsedRepos.value.has(repoId)) {
    collapsedRepos.value.delete(repoId);
  } else {
    collapsedRepos.value.add(repoId);
  }
}

function reorderTaskIds(items: readonly ReadySidebarTaskItem[], oldIndex: number, newIndex: number): string[] {
  const ids = items.map((item) => item.task_id);
  const [moved] = ids.splice(oldIndex, 1);
  if (!moved) return ids;
  ids.splice(newIndex, 0, moved);
  return ids;
}

function reorderedRepoIds(sourceRepoId: string, targetRepoId: string): string[] | null {
  const ids = props.repos.map((repo) => repo.id);
  const oldIndex = ids.indexOf(sourceRepoId);
  const newIndex = ids.indexOf(targetRepoId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return null;
  const [moved] = ids.splice(oldIndex, 1);
  if (!moved) return null;
  ids.splice(newIndex, 0, moved);
  return ids;
}

function emitRepoReorder(sourceRepoId: string, targetRepoId: string) {
  if (isSearchActive()) return;
  const orderedIds = reorderedRepoIds(sourceRepoId, targetRepoId);
  if (!orderedIds) return;
  emit("reorder-repos", orderedIds);
}

function getRepoIdAtPoint(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof HTMLElement)) return null;
  return element.closest<HTMLElement>(".repo-section[data-repo-id]")?.dataset.repoId ?? null;
}

function stopRepoDragListeners() {
  document.removeEventListener("mousemove", handleRepoDragMove);
  document.removeEventListener("mouseup", handleRepoDragEnd);
}

function handleRepoDragMove(event: MouseEvent) {
  const drag = repoDrag.value;
  if (!drag) return;
  if (!drag.active && Math.abs(event.clientY - drag.startY) < 4) return;
  drag.active = true;
  const overRepoId = getRepoIdAtPoint(event.clientX, event.clientY);
  drag.overRepoId = overRepoId && overRepoId !== drag.repoId ? overRepoId : null;
  event.preventDefault();
}

function handleRepoDragEnd(event: MouseEvent) {
  stopRepoDragListeners();
  const drag = repoDrag.value;
  repoDrag.value = null;
  if (!drag?.active) return;
  suppressNextRepoClick.value = true;
  setTimeout(() => {
    suppressNextRepoClick.value = false;
  }, 0);
  const targetRepoId = getRepoIdAtPoint(event.clientX, event.clientY) ?? drag.overRepoId;
  if (!targetRepoId || targetRepoId === drag.repoId) return;
  emitRepoReorder(drag.repoId, targetRepoId);
}

function startRepoDrag(repoId: string, event: MouseEvent) {
  if (isSearchActive() || event.button !== 0) return;
  if (event.target instanceof HTMLElement && event.target.closest(".collapse-btn,.btn-icon,.repo-rename-input")) return;
  repoDrag.value = { repoId, startY: event.clientY, active: false, overRepoId: null };
  document.addEventListener("mousemove", handleRepoDragMove);
  document.addEventListener("mouseup", handleRepoDragEnd);
}

function readyTasks(items: readonly SidebarTaskItem[]): ReadySidebarTaskItem[] | null {
  return items.every(isReadyTask) ? [...items] : null;
}

function onPinnedChange(repoId: string, evt: DraggableChange<SidebarTaskItem>) {
  if (isSearchActive()) return;
  if (evt.added) {
    const addedItem = currentReadyTask(evt.added.element);
    if (!addedItem) return;
    // Item dragged from unpinned to pinned zone
    suppressParentDrop.value = true;
    dropParentId.value = null;
    emit("pin-item", addedItem.task_id, evt.added.newIndex);
    // Reorder all pinned items with the new arrival
    const existingPinned = readyTasks(sortedPinned(repoId));
    if (!existingPinned) return;
    const ids = existingPinned.map((item) => item.task_id);
    ids.splice(evt.added.newIndex, 0, addedItem.task_id);
    emit("reorder-pinned", repoId, ids);
  }
  if (evt.moved) {
    const pinned = readyTasks(sortedPinned(repoId));
    if (!pinned || !pinned[evt.moved.oldIndex]) return;
    // Item reordered within pinned zone
    emit("reorder-pinned", repoId, reorderTaskIds(pinned, evt.moved.oldIndex, evt.moved.newIndex));
  }
}

function onUnpinnedChange(repoId: string, evt: DraggableChange<SidebarTaskItem>) {
  if (isSearchActive()) return;
  const added = evt.added;
  const addedItem = currentReadyTask(added?.element);
  if (added && addedItem) {
    // Item dragged from pinned to unpinned zone — unpin it
    suppressParentDrop.value = true;
    dropParentId.value = null;
    emit("unpin-item", addedItem.task_id);
    // Reorder remaining pinned items
    const remaining = sortedPinned(repoId)
      .filter((item) => item.slot_id !== addedItem.slot_id);
    const remainingReady = readyTasks(remaining);
    if (!remainingReady) return;
    const remainingIds = remainingReady.map((item) => item.task_id);
    if (remainingIds.length > 0) {
      emit("reorder-pinned", repoId, remainingIds);
    }
  }
}

// --- Drag a task onto another task to nest it as a subtask ---
// SortableJS owns the drag, so we read the drop target by hit-testing the pointer position
// rather than via the list-reorder model. A live highlight (dropParentId) shows the target.
interface SortableDragEvent {
  item?: HTMLElement;
  originalEvent?: Event;
}

interface SortableMoveEvent {
  draggedContext?: { element?: SidebarTaskItem };
  relatedContext?: { element?: SidebarTaskItem };
}

const draggedTaskId = ref<string | null>(null);
const dropParentId = ref<string | null>(null);
const suppressParentDrop = ref(false);
const emptyTaskSlots: SidebarTaskItem[] = [];

function isPinnedTaskDragForRepo(repoId: string): boolean {
  const dragged = readyTaskByDurableId(draggedTaskId.value);
  return dragged?.repo_id === repoId && Boolean(dragged.pinned);
}

function pointerFromEvent(event: Event | undefined | null): { x: number; y: number } | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return null;
}

function taskRowAtPoint(x: number, y: number): { id: string; pinned: boolean } | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".workflow-item");
  const id = row?.dataset.taskId;
  if (!row || !id || !readyTaskByDurableId(id)) return null;
  return { id, pinned: Boolean(row.closest(".pinned-zone")) };
}

function parentIdFromHit(hit: { id: string; pinned: boolean } | null, childId: string): string | null {
  // Dropping into the pinned zone stays a pin gesture, so only nest in other zones.
  return hit && !hit.pinned && hit.id !== childId ? hit.id : null;
}

function resolveDropParent(x: number, y: number, childId: string): string | null {
  return parentIdFromHit(taskRowAtPoint(x, y), childId);
}

function currentParentId(taskId: string): string | null {
  return readyTaskByDurableId(taskId)?.parent_task_id ?? null;
}

function onTaskDragPointerMove(event: PointerEvent) {
  const childId = draggedTaskId.value;
  if (!childId) return;
  dropParentId.value = resolveDropParent(event.clientX, event.clientY, childId);
}

function stopTaskDragTracking() {
  document.removeEventListener("pointermove", onTaskDragPointerMove, true);
}

function taskIdFromDragStart(evt: SortableDragEvent): string | null {
  const target = evt.originalEvent?.target;
  if (target instanceof HTMLElement) {
    const rowTaskId = target.closest<HTMLElement>(".workflow-item[data-task-id]")?.dataset.taskId;
    if (readyTaskByDurableId(rowTaskId)) return rowTaskId ?? null;
  }
  const itemTaskId = evt.item?.dataset.taskId;
  return readyTaskByDurableId(itemTaskId)?.task_id ?? null;
}

function canMoveTask(event: SortableMoveEvent): boolean {
  const source = event.draggedContext?.element;
  if (!currentReadyTask(source)) return false;
  const target = event.relatedContext?.element;
  return target === undefined || currentReadyTask(target) !== null;
}

function onTaskDragStart(evt: SortableDragEvent) {
  draggedTaskId.value = isSearchActive() ? null : taskIdFromDragStart(evt);
  dropParentId.value = null;
  suppressParentDrop.value = false;
  if (draggedTaskId.value) {
    document.addEventListener("pointermove", onTaskDragPointerMove, true);
  }
}

function onTaskDragEnd(evt: SortableDragEvent) {
  stopTaskDragTracking();
  const childId = draggedTaskId.value;
  let parentId = dropParentId.value;
  const shouldSuppressParentDrop = suppressParentDrop.value;
  draggedTaskId.value = null;
  dropParentId.value = null;
  suppressParentDrop.value = false;
  if (!childId || isSearchActive()) return;
  if (shouldSuppressParentDrop) return;
  let hit: { id: string; pinned: boolean } | null = null;
  let hasDropPoint = false;
  if (!parentId) {
    const point = pointerFromEvent(evt.originalEvent);
    if (point) {
      hasDropPoint = true;
      hit = taskRowAtPoint(point.x, point.y);
      parentId = parentIdFromHit(hit, childId);
    }
  }
  if (parentId && parentId !== childId) {
    emit("set-parent", childId, parentId);
  } else if (!parentId && hasDropPoint && !hit && currentParentId(childId)) {
    emit("set-parent", childId, null);
  }
}

function detachSubtask(item: SidebarTaskItem) {
  const readyItem = currentReadyTask(item);
  if (!readyItem) return;
  emit("set-parent", readyItem.task_id, null);
}

watch(searchQuery, (q) => {
  if (q.trim()) {
    if (!preSearchCollapsed.value) {
      preSearchCollapsed.value = new Set(collapsedRepos.value);
    }
    collapsedRepos.value = new Set();
  } else {
    if (preSearchCollapsed.value) {
      collapsedRepos.value = new Set(preSearchCollapsed.value);
      preSearchCollapsed.value = null;
    }
  }
});

async function scrollSelectedTaskIntoView() {
  if (!props.selectedSlotId) return;
  await nextTick();
  sidebarContentRef.value
    ?.querySelector<HTMLElement>(".workflow-item.selected")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

watch(
  [() => props.selectedSlotId, selectedVisibleSlotId],
  () => {
    void scrollSelectedTaskIntoView();
  },
  { immediate: true, flush: "post" },
);

function renameSelectedItem() {
  if (!props.selectedSlotId) return;
  const item = props.taskSlots.find((candidate) => candidate.slot_id === props.selectedSlotId);
  if (item) startRename(item);
}

function focusSearch() {
  searchInputRef.value?.focus();
}

onBeforeUnmount(stopRepoDragListeners);
onBeforeUnmount(stopTaskDragTracking);

defineExpose({ renameSelectedItem, focusSearch, searchQuery, matchesSearch, emitRepoReorder });
</script>

<template>
  <aside class="sidebar" :class="{ 'is-filtering': hasActiveSearch }" @mousedown="preventFocusSteal">
    <div ref="sidebarContentRef" class="sidebar-content">
      <div v-if="repos.length === 0" class="empty-state">
        {{ $t('sidebar.noReposYet') }}<br>
        {{ $t('sidebar.noReposHint', { shortcut: '⌘I' }) }}
      </div>

      <div class="repo-list">
        <div
          v-for="repo in repos"
          :key="repo.id"
          v-show="!hasActiveSearch || itemsForRepo(repo.id).length > 0"
          class="repo-section"
          :class="{
            'repo-dragging': repoDrag?.repoId === repo.id && repoDrag.active,
            'repo-drag-over': repoDrag?.overRepoId === repo.id,
          }"
          :data-repo-id="repo.id"
        >
          <div
            class="repo-header"
            :class="{
              selected: selectedRepoId === repo.id && (!selectedTaskRepoId || selectedTaskRepoId === repo.id),
              'contains-selected-task': selectedTaskRepoId === repo.id,
            }"
            @mousedown="startRepoDrag(repo.id, $event)"
            @click="handleSelectRepo(repo.id)"
          >
            <button
              class="collapse-btn"
              @click.stop="toggleRepo(repo.id)"
            >
              {{ collapsedRepos.has(repo.id) ? ">" : "v" }}
            </button>
            <input
              v-if="editingRepoId === repo.id"
              class="repo-rename-input"
              v-model="editingRepoValue"
              v-bind="macOsTextInputAttrs"
              @keydown.enter="commitRepoRename(repo.id)"
              @keydown.escape="cancelRepoRename()"
              @blur="commitRepoRename(repo.id)"
              @click.stop
            />
            <span
              v-else
              class="repo-name"
              :class="{ 'filtered-label': hasActiveSearch }"
              @dblclick.stop="startRepoRename(repo)"
            >{{ repo.name }}</span>
            <span class="repo-count">{{ repoCountLabel(repo.id) }}</span>
            <button
              class="btn-icon btn-add-task"
              :title="$t('sidebar.newTaskTooltip')"
              @click.stop="emit('new-task', repo.id)"
            >+</button>
            <button
              class="btn-icon btn-hide-repo"
              :title="$t('sidebar.removeRepoTooltip')"
              @click.stop="emit('hide-repo', repo.id)"
            >&times;</button>
          </div>

          <div v-if="!collapsedRepos.has(repo.id)" class="workflow-list">
          <!-- Pinned tasks (draggable, sortable) -->
          <draggable
            :model-value="sortedPinned(repo.id)"
            :group="{ name: `repo-${repo.id}` }"
            item-key="slot_id"
            :animation="150"
            :disabled="isSearchActive()"
            :move="canMoveTask"
            :force-fallback="true"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            fallback-class="sortable-fallback"
            class="pinned-zone"
            @change="(evt) => onPinnedChange(repo.id, evt)"
            @start="onTaskDragStart"
            @end="onTaskDragEnd"
          >
            <template #item="{ element }">
              <div
                class="task-subtree"
                :data-task-id="element.task_id"
              >
                <div
                  v-for="row in subtreeRows(repo.id, element)"
                  :key="row.item.slot_id"
                  class="workflow-item"
                  :data-slot-id="row.item.slot_id"
                  :data-task-id="row.item.task_id"
                  :data-transfer-state="transferMarker(row.item)?.state"
                  :aria-busy="row.item.state === 'creating' ? 'true' : undefined"
                  :class="{
                    selected: selectedSlotId === row.item.slot_id,
                    'initializing-item': row.item.state === 'creating',
                    subtask: row.depth > 0,
                    'drop-target': row.item.task_id !== null && dropParentId === row.item.task_id,
                  }"
                  :style="subtaskIndentStyle(row.depth)"
                  @click="handleSelectItem(row.item)"
                  @dblclick.stop="startRename(row.item)"
                >
                  <input
                    v-if="editingSlotId === row.item.slot_id"
                    class="rename-input"
                    v-model="editingValue"
                    v-bind="macOsTextInputAttrs"
                    @keydown.enter="commitRename(row.item.slot_id)"
                    @keydown.escape="cancelRename()"
                    @blur="commitRename(row.item.slot_id)"
                    @click.stop
                  />
                  <span
                    v-else
                    class="item-title"
                    :style="{
                      fontWeight: 'normal',
                      fontStyle: isTaskWorking(row.item) ? 'italic' : 'normal',
                      textDecoration: isTaskTearingDown(row.item) ? 'line-through' : 'none',
                      opacity: isTaskTearingDown(row.item) ? 0.5 : 1,
                    }"
                    :title="itemTooltip(row.item)"
                  >
                    <span v-if="transferMarker(row.item)" class="transfer-task-marker" :class="`transfer-task-marker-${transferMarker(row.item)?.state}`" :aria-label="transferMarker(row.item)?.label">{{ transferMarker(row.item)?.glyph }} </span><span v-if="isRemoteTask(row.item)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(row.item) }}</span><span v-if="showsUnreadMark(row.item)" class="unread-task-dot" aria-hidden="true"></span>
                  <button
                    v-if="canDetachSubtask(row)"
                    type="button"
                    class="subtask-detach"
                    :title="$t('sidebar.detachSubtask')"
                    :aria-label="$t('sidebar.detachSubtask')"
                    :data-testid="`detach-subtask-${row.item.slot_id}`"
                    @mousedown.stop.prevent
                    @click.stop="detachSubtask(row.item)"
                  >&times;</button>
                </div>
              </div>
            </template>
          </draggable>

          <!-- Divider -->
          <div v-show="sortedPinned(repo.id).length > 0" class="pin-divider">
            <div class="pin-divider-line"></div>
          </div>

          <draggable
            v-if="sortedPinned(repo.id).length > 0 && groupedByStage(repo.id).length === 0"
            :model-value="emptyTaskSlots"
            :group="{ name: `repo-${repo.id}` }"
            item-key="slot_id"
            :animation="150"
            :sort="false"
            :disabled="isSearchActive()"
            :move="canMoveTask"
            :force-fallback="true"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            fallback-class="sortable-fallback"
            class="empty-unpin-zone"
            :class="{ 'empty-unpin-zone-active': isPinnedTaskDragForRepo(repo.id) }"
            @change="(evt) => onUnpinnedChange(repo.id, evt)"
            @start="onTaskDragStart"
            @end="onTaskDragEnd"
          >
            <template #item="{ element }">
              <div class="task-subtree" :data-task-id="element.task_id"></div>
            </template>
          </draggable>

          <!-- Stage sections (dynamic) -->
          <template v-for="group in groupedByStage(repo.id)" :key="group.stageName">
            <div class="section-label" :class="{ 'filtered-label': hasActiveSearch }">{{ group.stageName }}</div>
            <draggable
              :model-value="group.items"
              :group="{ name: `repo-${repo.id}` }"
              item-key="slot_id"
              :animation="150"
              :sort="false"
              :disabled="isSearchActive()"
              :move="canMoveTask"
              :force-fallback="true"
              ghost-class="sortable-ghost"
              chosen-class="sortable-chosen"
              fallback-class="sortable-fallback"
              class="type-zone"
              @change="(evt) => onUnpinnedChange(repo.id, evt)"
              @start="onTaskDragStart"
              @end="onTaskDragEnd"
            >
              <template #item="{ element }">
                <div
                  class="task-subtree"
                  :data-task-id="element.task_id"
                >
                  <div
                    v-for="row in subtreeRows(repo.id, element)"
                    :key="row.item.slot_id"
                    class="workflow-item"
                    :data-slot-id="row.item.slot_id"
                    :data-task-id="row.item.task_id"
                    :data-transfer-state="transferMarker(row.item)?.state"
                    :aria-busy="row.item.state === 'creating' ? 'true' : undefined"
                    :class="{
                      selected: selectedSlotId === row.item.slot_id,
                      'initializing-item': row.item.state === 'creating',
                      subtask: row.depth > 0,
                      'drop-target': row.item.task_id !== null && dropParentId === row.item.task_id,
                    }"
                    :style="subtaskIndentStyle(row.depth)"
                    @click="handleSelectItem(row.item)"
                    @dblclick.stop="startRename(row.item)"
                  >
                    <input
                      v-if="editingSlotId === row.item.slot_id"
                      class="rename-input"
                      v-model="editingValue"
                      v-bind="macOsTextInputAttrs"
                      @keydown.enter="commitRename(row.item.slot_id)"
                      @keydown.escape="cancelRename()"
                      @blur="commitRename(row.item.slot_id)"
                      @click.stop
                    />
                    <span
                      v-else
                      class="item-title"
                      :style="{
                        fontWeight: 'normal',
                        fontStyle: isTaskWorking(row.item) ? 'italic' : 'normal',
                        textDecoration: isTaskTearingDown(row.item) ? 'line-through' : 'none',
                        opacity: isTaskTearingDown(row.item) ? 0.5 : 1,
                      }"
                      :title="itemTooltip(row.item)"
                    >
                      <span v-if="transferMarker(row.item)" class="transfer-task-marker" :class="`transfer-task-marker-${transferMarker(row.item)?.state}`" :aria-label="transferMarker(row.item)?.label">{{ transferMarker(row.item)?.glyph }} </span><span v-if="isRemoteTask(row.item)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(row.item) }}</span><span v-if="showsUnreadMark(row.item)" class="unread-task-dot" aria-hidden="true"></span>
                    <button
                      v-if="canDetachSubtask(row)"
                      type="button"
                      class="subtask-detach"
                      :title="$t('sidebar.detachSubtask')"
                      :aria-label="$t('sidebar.detachSubtask')"
                      :data-testid="`detach-subtask-${row.item.slot_id}`"
                      @mousedown.stop.prevent
                      @click.stop="detachSubtask(row.item)"
                    >&times;</button>
                  </div>
                </div>
              </template>
            </draggable>
          </template>

          <!-- Blocked tasks -->
          <div
            v-if="sortedBlocked(repo.id).length > 0"
            class="section-label"
            :class="{ 'filtered-label': hasActiveSearch }"
          >{{ $t('sidebar.sectionBlocked') }}</div>
          <div class="type-zone">
            <template v-for="blocked in sortedBlocked(repo.id)" :key="blocked.slot_id">
              <div
                v-for="row in subtreeRows(repo.id, blocked)"
                :key="row.item.slot_id"
                class="workflow-item"
                :data-slot-id="row.item.slot_id"
                :data-task-id="row.item.task_id"
                :data-transfer-state="transferMarker(row.item)?.state"
                :aria-busy="row.item.state === 'creating' ? 'true' : undefined"
                :class="{
                  selected: selectedSlotId === row.item.slot_id,
                  'initializing-item': row.item.state === 'creating',
                  subtask: row.depth > 0,
                  'drop-target': row.item.task_id !== null && dropParentId === row.item.task_id,
                }"
                :style="subtaskIndentStyle(row.depth)"
                @click="handleSelectItem(row.item)"
                @dblclick.stop="startRename(row.item)"
              >
                <input
                  v-if="editingSlotId === row.item.slot_id"
                  class="rename-input"
                  v-model="editingValue"
                  v-bind="macOsTextInputAttrs"
                  @keydown.enter="commitRename(row.item.slot_id)"
                  @keydown.escape="cancelRename()"
                  @blur="commitRename(row.item.slot_id)"
                  @click.stop
                />
                <div v-else class="blocked-item-content">
                  <span
                    class="item-title"
                    :style="{
                      color: 'var(--kn-text-muted)',
                      textDecoration: isTaskTearingDown(row.item) ? 'line-through' : 'none',
                      opacity: isTaskTearingDown(row.item) ? 0.5 : 1,
                    }"
                    :title="itemTooltip(row.item)"
                  >
                    <span v-if="transferMarker(row.item)" class="transfer-task-marker" :class="`transfer-task-marker-${transferMarker(row.item)?.state}`" :aria-label="transferMarker(row.item)?.label">{{ transferMarker(row.item)?.glyph }} </span><span v-if="isRemoteTask(row.item)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(row.item) }}</span><span v-if="showsUnreadMark(row.item)" class="unread-task-dot" aria-hidden="true"></span>
                  <span
                    v-if="row.item.task_id && blockerNames?.[row.item.task_id]"
                    class="blocked-by-text"
                  >{{ $t('sidebar.blockedBy') }} {{ blockerNames[row.item.task_id] }}</span>
                </div>
                <button
                  v-if="canDetachSubtask(row)"
                  type="button"
                  class="subtask-detach"
                  :title="$t('sidebar.detachSubtask')"
                  :aria-label="$t('sidebar.detachSubtask')"
                  :data-testid="`detach-subtask-${row.item.slot_id}`"
                  @mousedown.stop.prevent
                  @click.stop="detachSubtask(row.item)"
                >&times;</button>
              </div>
            </template>
          </div>

          <!-- Fallback for invalid parent graphs: keep every open task visible. -->
          <template v-for="group in fallbackGroups(repo.id)" :key="`fallback-${group.stageName}`">
            <div class="section-label" :class="{ 'filtered-label': hasActiveSearch }">{{ group.stageName }}</div>
            <div class="type-zone">
              <div
                v-for="item in group.items"
                :key="item.slot_id"
                class="workflow-item"
                :data-slot-id="item.slot_id"
                :data-task-id="item.task_id"
                :data-transfer-state="transferMarker(item)?.state"
                :aria-busy="item.state === 'creating' ? 'true' : undefined"
                :class="{
                  selected: selectedSlotId === item.slot_id,
                  'initializing-item': item.state === 'creating',
                  'drop-target': item.task_id !== null && dropParentId === item.task_id,
                }"
                @click="handleSelectItem(item)"
                @dblclick.stop="startRename(item)"
              >
                <input
                  v-if="editingSlotId === item.slot_id"
                  class="rename-input"
                  v-model="editingValue"
                  v-bind="macOsTextInputAttrs"
                  @keydown.enter="commitRename(item.slot_id)"
                  @keydown.escape="cancelRename()"
                  @blur="commitRename(item.slot_id)"
                  @click.stop
                />
                <span
                  v-else
                  class="item-title"
                  :style="{
                    fontWeight: 'normal',
                    fontStyle: isTaskWorking(item) ? 'italic' : 'normal',
                    textDecoration: isTaskTearingDown(item) ? 'line-through' : 'none',
                    opacity: isTaskTearingDown(item) ? 0.5 : 1,
                  }"
                  :title="itemTooltip(item)"
                >
                  <span v-if="transferMarker(item)" class="transfer-task-marker" :class="`transfer-task-marker-${transferMarker(item)?.state}`" :aria-label="transferMarker(item)?.label">{{ transferMarker(item)?.glyph }} </span><span v-if="isRemoteTask(item)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(item) }}</span><span v-if="showsUnreadMark(item)" class="unread-task-dot" aria-hidden="true"></span>
              </div>
            </div>
          </template>

          <div v-if="itemsForRepo(repo.id).length === 0" class="no-items">
            {{ hasActiveSearch
              ? $t('sidebar.noTasksMatching', { query: trimmedSearchQuery })
              : $t('sidebar.noTasks')
            }}
          </div>
        </div>
      </div>
      </div>
    </div>

    <div class="sidebar-footer">
      <div class="search-field">
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          v-bind="macOsTextInputAttrs"
          type="text"
          class="search-input"
          :placeholder="$t('sidebar.searchPlaceholder')"
          @keydown.escape="searchQuery = ''; searchInputRef?.blur()"
        />
        <button
          v-if="searchQuery.length > 0"
          type="button"
          class="search-clear"
          :aria-label="$t('sidebar.clearSearch')"
          :title="$t('sidebar.clearSearch')"
          data-testid="sidebar-search-clear"
          @mousedown.prevent
          @click="clearSearch"
        >
          ×
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--kn-bg-sidebar);
  border-right: 1px solid var(--kn-border-default);
  display: flex;
  flex-direction: column;
  height: 100%;
  user-select: none;
}

.sidebar.is-filtering {
  background: var(--kn-bg-sidebar);
  border-right-color: var(--kn-warning);
}

.sidebar.is-filtering .sidebar-content {
  box-shadow: inset 0 1px 0 var(--kn-warning-bg);
}

.sidebar.is-filtering .repo-header {
  background: var(--kn-bg-panel-raised);
}

.sidebar.is-filtering .repo-count {
  color: var(--kn-warning);
}

.sidebar.is-filtering .search-input {
  border-color: var(--kn-warning);
  background: var(--kn-bg-input);
}

.sidebar.is-filtering .search-input::placeholder {
  color: var(--kn-text-muted);
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.empty-state {
  color: var(--kn-text-muted);
  font-size: 12px;
  padding: 16px 14px;
  text-align: center;
  line-height: 1.8;
}

.empty-state kbd {
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: var(--kn-text-muted);
}

.empty-state kbd + kbd {
  margin-left: 2px;
}

.repo-section {
  margin-bottom: 2px;
}

.repo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  color: var(--kn-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.repo-header:hover {
  background: var(--kn-bg-panel-raised);
}

.repo-header.selected {
  box-shadow:
    inset 0 1px 0 var(--kn-accent),
    inset 0 -1px 0 var(--kn-accent);
}

.repo-header.contains-selected-task {
  box-shadow:
    inset 0 1px 0 var(--kn-accent),
    inset 0 -1px 0 var(--kn-accent);
}

.repo-dragging .repo-header {
  opacity: 0.65;
}

.repo-drag-over .repo-header {
  box-shadow: inset 0 2px 0 var(--kn-accent);
}

.sidebar.is-filtering .repo-header {
  cursor: pointer;
}

.sidebar.is-filtering .repo-header.selected {
  box-shadow:
    inset 0 1px 0 var(--kn-warning),
    inset 0 -1px 0 var(--kn-warning);
}

.sidebar.is-filtering .repo-header.contains-selected-task {
  box-shadow:
    inset 0 1px 0 var(--kn-warning),
    inset 0 -1px 0 var(--kn-warning);
}

.sidebar.is-filtering .repo-drag-over .repo-header {
  box-shadow: inset 0 2px 0 var(--kn-warning);
}

.collapse-btn {
  background: none;
  border: none;
  color: var(--kn-text-muted);
  cursor: pointer;
  font-size: 10px;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  width: 14px;
  padding: 0;
  text-align: center;
}

.repo-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-rename-input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--kn-text-primary);
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-accent);
  border-radius: 2px;
  padding: 1px 4px;
  outline: none;
  font-family: inherit;
}

.repo-count {
  color: var(--kn-text-muted);
  font-size: 11px;
}

.btn-icon {
  -webkit-app-region: no-drag;
  background: none;
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--kn-bg-hover);
  color: var(--kn-text-primary);
}

.btn-add-task {
  font-size: 14px;
  padding: 0 4px;
  opacity: 0.5;
}

.btn-add-task:hover {
  opacity: 1;
}

.btn-hide-repo {
  margin-left: auto;
  opacity: 0;
  font-size: 14px;
  padding: 0 4px;
  transition: opacity 0.1s;
}

.repo-header:hover .btn-hide-repo {
  opacity: 0.5;
}

.btn-hide-repo:hover {
  opacity: 1;
}

.workflow-list {
  padding-left: 20px;
}

.workflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px;
  border-radius: 4px;
  margin: 1px 6px;
  user-select: none;
  -webkit-user-select: none;
}

.task-subtree {
  display: flex;
  flex-direction: column;
}

.workflow-item.subtask {
  position: relative;
}

/* Subtask guide rail: a short vertical tick marking nesting under the parent. */
.workflow-item.subtask::before {
  content: "";
  position: absolute;
  left: 16px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--kn-border-subtle, var(--kn-bg-panel-raised));
}

.workflow-item:hover {
  background: var(--kn-bg-panel-raised);
}

.workflow-item.selected {
  background: var(--kn-bg-selected);
  outline: 1px solid var(--kn-accent);
}

/* Highlighted while a dragged task hovers over it as a potential parent. */
.workflow-item.drop-target {
  background: var(--kn-bg-selected);
  outline: 1px dashed var(--kn-accent);
}

.sidebar.is-filtering .workflow-item.selected {
  outline-color: var(--kn-warning);
}

.sidebar.is-filtering .workflow-item.drop-target {
  outline-color: var(--kn-warning);
}

.item-title {
  font-size: 12px;
  color: var(--kn-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  pointer-events: none;
}

.unread-task-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--kn-accent);
  pointer-events: none;
}

.workflow-item.initializing-item .item-title {
  color: var(--kn-text-muted);
  font-style: italic;
}

.remote-task-marker {
  color: var(--kn-accent);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}

/* A transfer is the one thing that can move a task off this machine while its
   row still looks ordinary. Same glyph language as the remote marker. */
.transfer-task-marker {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}

.transfer-task-marker-transferring {
  color: var(--kn-accent);
  animation: transfer-marker-pulse 1.6s ease-in-out infinite;
}

.transfer-task-marker-failed {
  color: var(--kn-danger);
}

@keyframes transfer-marker-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .transfer-task-marker-transferring {
    animation: none;
  }
}

.awaiting-verdict-badge {
  flex: 0 0 auto;
  border: 1px solid var(--kn-border-subtle, var(--kn-bg-panel-raised));
  border-radius: 3px;
  padding: 0 4px;
  color: var(--kn-text-muted);
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  letter-spacing: 0;
  pointer-events: auto;
}

.subtask-detach {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 3px;
  padding: 0;
  background: transparent;
  color: var(--kn-text-muted);
  font-size: 13px;
  line-height: 16px;
  opacity: 0;
}

.workflow-item:hover .subtask-detach,
.subtask-detach:focus-visible {
  opacity: 1;
}

.subtask-detach:hover,
.subtask-detach:focus-visible {
  background: var(--kn-bg-hover);
  color: var(--kn-text-primary);
  outline: none;
}

.rename-input {
  flex: 1;
  font-size: 12px;
  color: var(--kn-text-primary);
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-accent);
  border-radius: 2px;
  padding: 1px 4px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.no-items {
  color: var(--kn-text-muted);
  font-size: 11px;
  padding: 4px 14px;
}

.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--kn-border-default);
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-field {
  position: relative;
  flex: 1;
  min-width: 0;
}

.search-input {
  width: 100%;
  padding: 6px 28px 6px 10px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-secondary);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.search-input:focus {
  border-color: var(--kn-accent);
  background: var(--kn-bg-input);
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.search-clear {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--kn-text-muted);
  font: inherit;
  font-size: 14px;
  line-height: 18px;
  padding: 0;
  cursor: default;
}

.search-clear:hover,
.search-clear:focus-visible {
  background: var(--kn-bg-hover);
  color: var(--kn-text-primary);
  outline: none;
}

.pinned-zone {
  min-height: 0;
}

.pinned-zone:not(:empty) {
  min-height: 28px;
  padding-top: 4px;
}

.pin-divider {
  padding: 6px 6px;
}

.pin-divider-line {
  height: 1px;
  background: var(--kn-border-strong);
}

.empty-unpin-zone {
  min-height: 0;
  margin: 0 6px;
  overflow: hidden;
  border: 0 dashed transparent;
  border-radius: 4px;
  transition: border-width 120ms ease, background-color 120ms ease;
}

.empty-unpin-zone-active {
  min-height: 28px;
  border-width: 1px;
  border-color: var(--kn-border-strong);
  background: var(--kn-bg-hover);
}

.section-label {
  color: var(--kn-text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 6px 14px 2px;
}

.filtered-label {
  font-style: italic;
}

.type-zone {
  min-height: 0;
}

.blocked-item-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  pointer-events: none;
}

.blocked-by-text {
  font-size: 10px;
  color: var(--kn-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Drag classes */
.sortable-ghost {
  opacity: 0.4;
  background: var(--kn-bg-accent-subtle);
  border-radius: 4px;
}

.sortable-chosen {
  opacity: 0.9;
}

.sortable-fallback {
  opacity: 0.9;
  background: var(--kn-bg-sidebar);
  border-radius: 4px;
  box-shadow: var(--kn-shadow-modal);
}

</style>
