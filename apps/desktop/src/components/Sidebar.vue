<script setup lang="ts">
import type { Repo, PipelineItem } from "@kanna/db";
import { ref, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import draggable from "vuedraggable";
import { fuzzyMatch } from "../utils/fuzzyMatch";

function hasTag(item: { tags: string }, tag: string): boolean {
  try { return (JSON.parse(item.tags) as string[]).includes(tag); }
  catch { return false; }
}

function isHidden(item: { closed_at: string | null }): boolean {
  return item.closed_at !== null;
}

const { t } = useI18n();

const props = defineProps<{
  repos: Repo[];
  pipelineItems: PipelineItem[];
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
  (e: "rename-item", itemId: string, displayName: string | null): void;
  (e: "hide-repo", repoId: string): void;
  (e: "rename-done"): void;
}>();

const collapsedRepos = ref<Set<string>>(new Set());
const searchQuery = ref("");
const searchInputRef = ref<HTMLInputElement | null>(null);
const preSearchCollapsed = ref<Set<string> | null>(null);

function matchesSearch(item: PipelineItem): boolean {
  const q = searchQuery.value.trim();
  if (!q) return true;
  const title = item.display_name || item.issue_title || item.prompt;
  if (title && fuzzyMatch(q, title) !== null) return true;
  if (item.branch && item.branch.toLowerCase().includes(q.toLowerCase())) return true;
  return false;
}

function sortedPinned(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && !isHidden(i) && i.pinned && matchesSearch(i))
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
}

function sortByCreatedAt(items: PipelineItem[]): PipelineItem[] {
  return [...items].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function sortedBlocked(repoId: string): PipelineItem[] {
  return sortByCreatedAt(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "blocked") && !isHidden(i) && !i.pinned && matchesSearch(i))
  );
}

interface StageGroup {
  stageName: string;
  items: PipelineItem[];
}

/**
 * Group non-pinned, non-blocked items for a repo by their stage field.
 * Stage order is derived from first-appearance when items are sorted by created_at ASC
 * (oldest items tend to be in earlier pipeline stages, giving a stable ordering).
 */
function groupedByStage(repoId: string): StageGroup[] {
  const blockedSet = new Set(
    props.pipelineItems
      .filter((i) => i.repo_id === repoId && hasTag(i, "blocked") && !isHidden(i) && !i.pinned)
      .map((i) => i.id)
  );

  const stageItems = props.pipelineItems.filter(
    (i) => i.repo_id === repoId && !isHidden(i) && !i.pinned && !blockedSet.has(i.id) && matchesSearch(i)
  );

  // Sort items by created_at ASC to derive stage order (older items → earlier stages)
  const sortedAsc = [...stageItems].sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Collect unique stage names in first-appearance order
  const stageOrder: string[] = [];
  const seenStages = new Set<string>();
  for (const item of sortedAsc) {
    if (!seenStages.has(item.stage)) {
      seenStages.add(item.stage);
      stageOrder.push(item.stage);
    }
  }

  // Group items by stage, sorted by created_at DESC within each group
  const groups = new Map<string, PipelineItem[]>();
  for (const stage of stageOrder) {
    groups.set(stage, []);
  }
  for (const item of stageItems) {
    groups.get(item.stage)?.push(item);
  }
  for (const [, items] of groups) {
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  return stageOrder
    .map((stageName) => ({ stageName, items: groups.get(stageName) ?? [] }))
    .filter((g) => g.items.length > 0);
}

function itemsForRepo(repoId: string): PipelineItem[] {
  const stageItems = groupedByStage(repoId).flatMap((g) => g.items);
  return [...sortedPinned(repoId), ...stageItems, ...sortedBlocked(repoId)];
}

function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || t('tasks.untitled');
  return raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
}

const editingItemId = ref<string | null>(null);
const editingValue = ref("");

function startRename(item: PipelineItem) {
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
  emit("select-repo", repoId);
}

function handleSelectItem(item: PipelineItem) {
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

// Drag handlers — vuedraggable's @change provides { added, removed, moved }
function onPinnedChange(repoId: string, evt: any) {
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
    const ids = sortedPinned(repoId).map((i) => i.id);
    const [moved] = ids.splice(evt.moved.oldIndex, 1);
    ids.splice(evt.moved.newIndex, 0, moved);
    emit("reorder-pinned", repoId, ids);
  }
}

function onUnpinnedChange(repoId: string, evt: any) {
  if (evt.added) {
    // Item dragged from pinned to unpinned zone — unpin it
    emit("unpin-item", evt.added.element.id);
    // Reorder remaining pinned items
    const remainingIds = sortedPinned(repoId)
      .filter((i) => i.id !== evt.added.element.id)
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

function renameSelectedItem() {
  if (!props.selectedItemId) return;
  const item = props.pipelineItems.find((i) => i.id === props.selectedItemId);
  if (item) startRename(item);
}

function focusSearch() {
  searchInputRef.value?.focus();
}

defineExpose({ renameSelectedItem, focusSearch, searchQuery, matchesSearch });
</script>

<template>
  <aside class="sidebar" @mousedown="preventFocusSteal">
    <div class="sidebar-content">
      <div v-if="repos.length === 0" class="empty-state">
        {{ $t('sidebar.noReposYet') }}<br>
        {{ $t('sidebar.noReposHint', { shortcut: '⌘I' }) }}
      </div>

      <div v-for="repo in repos" :key="repo.id" v-show="!searchQuery.trim() || itemsForRepo(repo.id).length > 0" class="repo-section">
        <div
          class="repo-header"
          :class="{ selected: selectedRepoId === repo.id }"
          @click="handleSelectRepo(repo.id)"
        >
          <button
            class="collapse-btn"
            @click.stop="toggleRepo(repo.id)"
          >
            {{ collapsedRepos.has(repo.id) ? ">" : "v" }}
          </button>
          <span class="repo-name">{{ repo.name }}</span>
          <span class="repo-count">{{ itemsForRepo(repo.id).length }}</span>
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
            :force-fallback="true"
            ghost-class="sortable-ghost"
            chosen-class="sortable-chosen"
            fallback-class="sortable-fallback"
            class="pinned-zone"
            @change="(evt: any) => onPinnedChange(repo.id, evt)"
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
                    textDecoration: element.activity === 'torndown' ? 'line-through' : 'none',
                    opacity: element.activity === 'torndown' ? 0.5 : 1,
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- Divider -->
          <div v-show="sortedPinned(repo.id).length > 0" class="pin-divider">
            <div class="pin-divider-line"></div>
          </div>

          <!-- Stage sections (dynamic) -->
          <template v-for="group in groupedByStage(repo.id)" :key="group.stageName">
            <div class="section-label">{{ group.stageName }}</div>
            <draggable
              :model-value="group.items"
              :group="{ name: `repo-${repo.id}` }"
              item-key="id"
              :animation="150"
              :sort="false"
              :force-fallback="true"
              ghost-class="sortable-ghost"
              chosen-class="sortable-chosen"
              fallback-class="sortable-fallback"
              class="type-zone"
              @change="(evt: any) => onUnpinnedChange(repo.id, evt)"
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
                      textDecoration: element.activity === 'torndown' ? 'line-through' : 'none',
                      opacity: element.activity === 'torndown' ? 0.5 : 1,
                    }"
                  >{{ itemTitle(element) }}</span>
                </div>
              </template>
            </draggable>
          </template>

          <!-- Blocked tasks -->
          <div v-if="sortedBlocked(repo.id).length > 0" class="section-label">{{ $t('sidebar.sectionBlocked') }}</div>
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
                @keydown.enter="commitRename(element.id)"
                @keydown.escape="cancelRename()"
                @blur="commitRename(element.id)"
                @click.stop
              />
              <div v-else class="blocked-item-content">
                <span
                  class="item-title"
                  style="color: #666;"
                >{{ itemTitle(element) }}</span>
                <span
                  v-if="blockerNames?.[element.id]"
                  class="blocked-by-text"
                >{{ $t('sidebar.blockedBy') }} {{ blockerNames[element.id] }}</span>
              </div>
            </div>
          </div>

          <div v-if="itemsForRepo(repo.id).length === 0" class="no-items">
            {{ $t('sidebar.noTasks') }}
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-footer">
      <input
        ref="searchInputRef"
        v-model="searchQuery"
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
  background: #1e1e1e;
  border-right: 1px solid #333;
  display: flex;
  flex-direction: column;
  height: 100%;
  user-select: none;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.empty-state {
  color: #666;
  font-size: 12px;
  padding: 16px 14px;
  text-align: center;
  line-height: 1.8;
}

.empty-state kbd {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: inherit;
  font-size: 11px;
  color: #999;
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
  cursor: pointer;
  color: #ccc;
  font-size: 13px;
  font-weight: 500;
}

.repo-header:hover {
  background: #2a2a2a;
}

.repo-header.selected {
  background: #2a2a2a;
}

.collapse-btn {
  background: none;
  border: none;
  color: #666;
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

.repo-count {
  color: #666;
  font-size: 11px;
}

.btn-icon {
  -webkit-app-region: no-drag;
  background: none;
  border: 1px solid #444;
  color: #aaa;
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
  background: #333;
  color: #e0e0e0;
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
  background: #2a2a2a;
}

.pipeline-item.selected {
  background: #0066cc22;
  outline: 1px solid #0066cc44;
}

.item-title {
  font-size: 12px;
  color: #bbb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  pointer-events: none;
}

.rename-input {
  flex: 1;
  font-size: 12px;
  color: #eee;
  background: #2a2a2a;
  border: 1px solid #0066cc;
  border-radius: 2px;
  padding: 1px 4px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.no-items {
  color: #555;
  font-size: 11px;
  padding: 4px 14px;
}

.sidebar-footer {
  padding: 10px 14px;
  border-top: 1px solid #333;
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-input {
  flex: 1;
  padding: 6px 10px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #ccc;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}

.search-input:focus {
  border-color: #0066cc;
  background: #1a1a1a;
}

.search-input::placeholder {
  color: #555;
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
  background: #555;
}

.section-label {
  color: #666;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 6px 14px 2px;
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
  color: #555;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Drag classes */
.sortable-ghost {
  opacity: 0.4;
  background: #0066cc22;
  border-radius: 4px;
}

.sortable-chosen {
  cursor: grabbing;
}

.sortable-fallback {
  opacity: 0.9;
  background: #1e1e1e;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

</style>
