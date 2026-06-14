<script setup lang="ts">
import type { Repo, PipelineItem } from "@kanna/db";
import { computed, ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import draggable from "vuedraggable";
import { taskSearchMatch } from "../utils/taskSearch";
import {
  groupedSidebarItemsByStage,
  sortedSidebarBlockedItems,
  sortedSidebarPinnedItems,
  sortSidebarItemsForRepo,
} from "../utils/sidebarOrdering";
import { useKannaStore } from "../stores/kanna";
import { isTaskTearingDown } from "../stores/taskStages";
import { macOsTextInputAttrs } from "../utils/textInput";

const { t } = useI18n();
const store = useKannaStore();

type SidebarPipelineItem = PipelineItem & {
  remote_task?: boolean;
};

const props = defineProps<{
  repos: Repo[];
  pipelineItems: SidebarPipelineItem[];
  selectedRepoId: string | null;
  selectedItemId: string | null;
  blockerNames?: Record<string, string>;
}>();

const emit = defineEmits<{
  (e: "select-repo", id: string): void;
  (e: "select-item", id: string): void;
  (e: "new-task", repoId: string): void;
  (e: "pin-item", itemId: string, position: number): void;
  (e: "unpin-item", itemId: string): void;
  (e: "reorder-pinned", repoId: string, orderedIds: string[]): void;
  (e: "reorder-repos", orderedIds: string[]): void;
  (e: "rename-item", itemId: string, displayName: string | null): void;
  (e: "rename-repo", repoId: string, name: string): void;
  (e: "hide-repo", repoId: string): void;
  (e: "rename-done"): void;
}>();

interface DraggableChange<T extends { id: string }> {
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
const selectedVisibleTaskId = computed(() => {
  const item = props.selectedItemId
    ? props.pipelineItems.find((candidate) => candidate.id === props.selectedItemId)
    : null;
  return item && item.stage !== "done" && item.closed_at == null ? item.id : null;
});
const selectedTaskRepoId = computed(() => {
  const item = props.selectedItemId
    ? props.pipelineItems.find((candidate) => candidate.id === props.selectedItemId)
    : null;
  return item && item.stage !== "done" && item.closed_at == null ? item.repo_id : null;
});

function isSearchActive(): boolean {
  return searchQuery.value.trim().length > 0;
}

function matchesSearch(item: SidebarPipelineItem): boolean {
  const q = trimmedSearchQuery.value;
  if (!q) return true;
  return taskSearchMatch(q, item) !== null;
}

function sidebarOrderingOptions(repoId: string) {
  return {
    repoId,
    items: props.pipelineItems,
    getStageOrder: store.getStageOrder,
    searchQuery: searchQuery.value,
  };
}

function sortedPinned(repoId: string): SidebarPipelineItem[] {
  return sortedSidebarPinnedItems(sidebarOrderingOptions(repoId));
}

function sortedBlocked(repoId: string): SidebarPipelineItem[] {
  return sortedSidebarBlockedItems(sidebarOrderingOptions(repoId));
}

interface StageGroup {
  stageName: string;
  items: SidebarPipelineItem[];
}

/**
 * Group non-pinned, non-blocked items for a repo by their stage field.
 * Stage order comes from the store (repo config or DEFAULT_STAGE_ORDER).
 * Stages not in the configured order sort alphabetically after listed stages.
 */
function groupedByStage(repoId: string): StageGroup[] {
  return groupedSidebarItemsByStage(sidebarOrderingOptions(repoId));
}

function itemsForRepo(repoId: string): SidebarPipelineItem[] {
  return sortSidebarItemsForRepo(sidebarOrderingOptions(repoId));
}

function totalItemsForRepo(repoId: string): number {
  return props.pipelineItems.filter((i) => i.repo_id === repoId && i.stage !== "done" && i.closed_at == null).length;
}

function repoCountLabel(repoId: string): string {
  const visible = itemsForRepo(repoId).length;
  if (!hasActiveSearch.value) return String(visible);
  return `${visible}/${totalItemsForRepo(repoId)}`;
}

function itemTitle(item: SidebarPipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  return item.active_post_action ? `... ${raw}` : raw;
}

function itemTooltip(item: SidebarPipelineItem): string | undefined {
  return item.prompt || (isRemoteTask(item) ? t('sidebar.remoteTaskTooltip') : undefined);
}

function isRemoteTask(item: SidebarPipelineItem): boolean {
  return item.remote_task === true;
}

const editingItemId = ref<string | null>(null);
const editingValue = ref("");
const editingRepoId = ref<string | null>(null);
const editingRepoValue = ref("");

function startRename(item: SidebarPipelineItem) {
  editingRepoId.value = null;
  editingItemId.value = item.id;
  editingValue.value = item.display_name || item.issue_title || item.prompt || "";
  nextTick(() => {
    const input = document.querySelector('.rename-input') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function startRepoRename(repo: Repo) {
  editingItemId.value = null;
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

function commitRename(itemId: string) {
  const trimmed = editingValue.value.trim();
  const item = props.pipelineItems.find((i) => i.id === itemId);
  const original = item?.issue_title || item?.prompt || "";
  // If cleared or matches original, set to null (remove custom name)
  const displayName = trimmed && trimmed !== original ? trimmed : null;
  emit("rename-item", itemId, displayName);
  editingItemId.value = null;
  emit("rename-done");
}

function cancelRename() {
  editingItemId.value = null;
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

function handleSelectItem(item: SidebarPipelineItem) {
  emit("select-repo", item.repo_id);
  emit("select-item", item.id);
}

function toggleRepo(repoId: string) {
  if (collapsedRepos.value.has(repoId)) {
    collapsedRepos.value.delete(repoId);
  } else {
    collapsedRepos.value.add(repoId);
  }
}

function reorderIds<T extends { id: string }>(items: readonly T[], oldIndex: number, newIndex: number): string[] {
  const ids = items.map((item) => item.id);
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

function onPinnedChange(repoId: string, evt: DraggableChange<SidebarPipelineItem>) {
  if (isSearchActive()) return;
  if (evt.added) {
    // Item dragged from unpinned to pinned zone
    emit("pin-item", evt.added.element.id, evt.added.newIndex);
    // Reorder all pinned items with the new arrival
    const ids = sortedPinned(repoId).map((i) => i.id);
    ids.splice(evt.added.newIndex, 0, evt.added.element.id);
    emit("reorder-pinned", repoId, ids);
  }
  if (evt.moved) {
    // Item reordered within pinned zone
    emit("reorder-pinned", repoId, reorderIds(sortedPinned(repoId), evt.moved.oldIndex, evt.moved.newIndex));
  }
}

function onUnpinnedChange(repoId: string, evt: DraggableChange<SidebarPipelineItem>) {
  if (isSearchActive()) return;
  const added = evt.added;
  if (added) {
    // Item dragged from pinned to unpinned zone — unpin it
    emit("unpin-item", added.element.id);
    // Reorder remaining pinned items
    const remainingIds = sortedPinned(repoId)
      .filter((i) => i.id !== added.element.id)
      .map((i) => i.id);
    if (remainingIds.length > 0) {
      emit("reorder-pinned", repoId, remainingIds);
    }
  }
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
  if (!props.selectedItemId) return;
  await nextTick();
  sidebarContentRef.value
    ?.querySelector<HTMLElement>(".pipeline-item.selected")
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

watch(
  [() => props.selectedItemId, selectedVisibleTaskId],
  () => {
    void scrollSelectedTaskIntoView();
  },
  { immediate: true, flush: "post" },
);

function renameSelectedItem() {
  if (!props.selectedItemId) return;
  const item = props.pipelineItems.find((i) => i.id === props.selectedItemId);
  if (item) startRename(item);
}

function focusSearch() {
  searchInputRef.value?.focus();
}

onBeforeUnmount(stopRepoDragListeners);

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
              selected: selectedRepoId === repo.id,
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

          <div v-if="!collapsedRepos.has(repo.id)" class="pipeline-list">
          <!-- Pinned tasks (draggable, sortable) -->
          <draggable
            :model-value="sortedPinned(repo.id)"
            :group="{ name: `repo-${repo.id}` }"
            item-key="id"
            :animation="150"
            :disabled="isSearchActive()"
            :force-fallback="true"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            fallback-class="sortable-fallback"
            class="pinned-zone"
            @change="(evt) => onPinnedChange(repo.id, evt)"
          >
            <template #item="{ element }">
              <div
                class="pipeline-item"
                :class="{ selected: selectedItemId === element.id }"
                @click="handleSelectItem(element)"
                @dblclick.stop="startRename(element)"
              >
                <input
                  v-if="editingItemId === element.id"
                  class="rename-input"
                  v-model="editingValue"
                  v-bind="macOsTextInputAttrs"
                  @keydown.enter="commitRename(element.id)"
                  @keydown.escape="cancelRename()"
                  @blur="commitRename(element.id)"
                  @click.stop
                />
                <span
                  v-else
                  class="item-title"
                  :style="{
                    fontWeight: element.activity === 'unread' ? 'bold' : 'normal',
                    fontStyle: element.activity === 'working' ? 'italic' : 'normal',
                    textDecoration: isTaskTearingDown(element) ? 'line-through' : 'none',
                    opacity: isTaskTearingDown(element) ? 0.5 : 1,
                  }"
                  :title="itemTooltip(element)"
                >
                  <span v-if="isRemoteTask(element)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- Divider -->
          <div v-show="sortedPinned(repo.id).length > 0" class="pin-divider">
            <div class="pin-divider-line"></div>
          </div>

          <!-- Stage sections (dynamic) -->
          <template v-for="group in groupedByStage(repo.id)" :key="group.stageName">
            <div class="section-label" :class="{ 'filtered-label': hasActiveSearch }">{{ group.stageName }}</div>
            <draggable
              :model-value="group.items"
              :group="{ name: `repo-${repo.id}` }"
              item-key="id"
              :animation="150"
              :sort="false"
              :disabled="isSearchActive()"
              :force-fallback="true"
              ghost-class="sortable-ghost"
              chosen-class="sortable-chosen"
              fallback-class="sortable-fallback"
              class="type-zone"
              @change="(evt) => onUnpinnedChange(repo.id, evt)"
            >
              <template #item="{ element }">
                <div
                  class="pipeline-item"
                  :class="{ selected: selectedItemId === element.id }"
                  @click="handleSelectItem(element)"
                  @dblclick.stop="startRename(element)"
                >
                  <input
                    v-if="editingItemId === element.id"
                    class="rename-input"
                    v-model="editingValue"
                    v-bind="macOsTextInputAttrs"
                    @keydown.enter="commitRename(element.id)"
                    @keydown.escape="cancelRename()"
                    @blur="commitRename(element.id)"
                    @click.stop
                  />
                  <span
                    v-else
                    class="item-title"
                    :style="{
                      fontWeight: element.activity === 'unread' ? 'bold' : 'normal',
                      fontStyle: element.activity === 'working' ? 'italic' : 'normal',
                      textDecoration: isTaskTearingDown(element) ? 'line-through' : 'none',
                      opacity: isTaskTearingDown(element) ? 0.5 : 1,
                    }"
                    :title="itemTooltip(element)"
                  >
                    <span v-if="isRemoteTask(element)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(element) }}</span>
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
            <div
              v-for="element in sortedBlocked(repo.id)"
              :key="element.id"
              class="pipeline-item"
              :class="{ selected: selectedItemId === element.id }"
              @click="handleSelectItem(element)"
              @dblclick.stop="startRename(element)"
            >
              <input
                v-if="editingItemId === element.id"
                class="rename-input"
                v-model="editingValue"
                v-bind="macOsTextInputAttrs"
                @keydown.enter="commitRename(element.id)"
                @keydown.escape="cancelRename()"
                @blur="commitRename(element.id)"
                @click.stop
              />
              <div v-else class="blocked-item-content">
                <span
                  class="item-title"
                  :style="{
                    color: 'var(--kn-text-muted)',
                    textDecoration: isTaskTearingDown(element) ? 'line-through' : 'none',
                    opacity: isTaskTearingDown(element) ? 0.5 : 1,
                  }"
                  :title="itemTooltip(element)"
                >
                  <span v-if="isRemoteTask(element)" class="remote-task-marker" :aria-label="t('sidebar.remoteTaskTooltip')">&lt; </span>{{ itemTitle(element) }}</span>
                <span
                  v-if="blockerNames?.[element.id]"
                  class="blocked-by-text"
                >{{ $t('sidebar.blockedBy') }} {{ blockerNames[element.id] }}</span>
              </div>
            </div>
          </div>

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
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        v-bind="macOsTextInputAttrs"
        type="text"
        class="search-input"
        :placeholder="$t('sidebar.searchPlaceholder')"
        @keydown.escape="searchQuery = ''; searchInputRef?.blur()"
      />
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
  border-right-color: var(--kn-accent);
}

.sidebar.is-filtering .sidebar-content {
  box-shadow: inset 0 1px 0 var(--kn-bg-accent-subtle);
}

.sidebar.is-filtering .repo-header {
  background: var(--kn-bg-panel-raised);
}

.sidebar.is-filtering .repo-count {
  color: var(--kn-accent);
}

.sidebar.is-filtering .search-input {
  border-color: var(--kn-accent);
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
  cursor: grab;
  color: var(--kn-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.repo-header:hover {
  background: var(--kn-bg-panel-raised);
}

.repo-header.selected {
  background: var(--kn-bg-panel-raised);
}

.repo-header.contains-selected-task {
  background: var(--kn-bg-selected);
  outline: 1px solid var(--kn-accent);
}

.repo-dragging .repo-header {
  opacity: 0.65;
  cursor: grabbing;
}

.repo-drag-over .repo-header {
  box-shadow: inset 0 2px 0 var(--kn-accent);
}

.sidebar.is-filtering .repo-header {
  cursor: pointer;
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

.pipeline-list {
  padding-left: 20px;
}

.pipeline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px;
  cursor: grab;
  border-radius: 4px;
  margin: 1px 6px;
  user-select: none;
  -webkit-user-select: none;
}

.pipeline-item:hover {
  background: var(--kn-bg-panel-raised);
}

.pipeline-item.selected {
  background: var(--kn-bg-selected);
  outline: 1px solid var(--kn-accent);
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

.remote-task-marker {
  color: var(--kn-accent);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
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

.search-input {
  flex: 1;
  padding: 6px 10px;
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
  cursor: grabbing;
}

.sortable-fallback {
  opacity: 0.9;
  background: var(--kn-bg-sidebar);
  border-radius: 4px;
  box-shadow: var(--kn-shadow-modal);
}

</style>
