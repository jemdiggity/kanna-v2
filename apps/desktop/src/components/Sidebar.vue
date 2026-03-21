<script setup lang="ts">
import type { Repo, PipelineItem } from "@kanna/db";
import { ref, watch, onMounted, nextTick } from "vue";
import Sortable from "sortablejs";

const props = defineProps<{
  repos: Repo[];
  pipelineItems: PipelineItem[];
  selectedRepoId: string | null;
  selectedItemId: string | null;
}>();

const emit = defineEmits<{
  (e: "select-repo", id: string): void;
  (e: "select-item", id: string): void;
  (e: "import-repo"): void;
  (e: "new-task", repoId: string): void;
  (e: "open-preferences"): void;
  (e: "pin-item", itemId: string, position: number): void;
  (e: "unpin-item", itemId: string): void;
  (e: "reorder-pinned", repoId: string, orderedIds: string[]): void;
  (e: "rename-item", itemId: string, displayName: string | null): void;
}>();

const collapsedRepos = ref<Set<string>>(new Set());

// Track Sortable instances for cleanup
const sortableInstances = new Map<string, Sortable[]>();
const isDragging = ref(false);

function sortedPinned(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && i.stage !== "done" && i.pinned)
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
}

function sortedUnpinned(repoId: string): PipelineItem[] {
  const order: Record<string, number> = { idle: 0, unread: 1, working: 2 };
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && i.stage !== "done" && !i.pinned)
    .sort((a, b) => {
      const ao = order[a.activity || "idle"] ?? 0;
      const bo = order[b.activity || "idle"] ?? 0;
      if (ao !== bo) return ao - bo;
      const aTime = a.activity_changed_at || a.created_at;
      const bTime = b.activity_changed_at || b.created_at;
      return bTime.localeCompare(aTime);
    });
}

function itemsForRepo(repoId: string): PipelineItem[] {
  return [...sortedPinned(repoId), ...sortedUnpinned(repoId)];
}

function itemTitle(item: PipelineItem): string {
  const raw = item.display_name || item.issue_title || item.prompt || "Untitled";
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
}

function cancelRename() {
  editingItemId.value = null;
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
    nextTick(() => initSortables(repoId));
  } else {
    collapsedRepos.value.add(repoId);
    destroySortables(repoId);
  }
}

function destroySortables(repoId: string) {
  const instances = sortableInstances.get(repoId);
  if (instances) {
    instances.forEach((s) => s.destroy());
    sortableInstances.delete(repoId);
  }
}

/** Read item IDs from DOM order (source of truth after Sortable reorders) */
function getIdsFromEl(el: HTMLElement): string[] {
  return Array.from(el.children)
    .map((child) => (child as HTMLElement).dataset.itemId)
    .filter(Boolean) as string[];
}

function initSortables(repoId: string) {
  destroySortables(repoId);

  const pinnedEl = document.querySelector(`[data-pinned="${repoId}"]`) as HTMLElement | null;
  const unpinnedEl = document.querySelector(`[data-unpinned="${repoId}"]`) as HTMLElement | null;
  if (!pinnedEl || !unpinnedEl) return;

  const instances: Sortable[] = [];

  instances.push(Sortable.create(pinnedEl, {
    group: `repo-${repoId}`,
    animation: 150,
    forceFallback: true,
    fallbackClass: "sortable-fallback",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    onStart() { isDragging.value = true; },
    onEnd() {
      isDragging.value = false;
      const ids = getIdsFromEl(pinnedEl);
      // Pin any newly arrived items
      for (let i = 0; i < ids.length; i++) {
        const item = props.pipelineItems.find((it) => it.id === ids[i]);
        if (item && !item.pinned) {
          emit("pin-item", ids[i], i);
        }
      }
      // Reorder all pinned
      if (ids.length > 0) {
        emit("reorder-pinned", repoId, ids);
      }
    },
  }));

  instances.push(Sortable.create(unpinnedEl, {
    group: `repo-${repoId}`,
    animation: 150,
    forceFallback: true,
    fallbackClass: "sortable-fallback",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    sort: false,
    onStart() { isDragging.value = true; },
    onEnd() { isDragging.value = false; },
    onAdd(evt) {
      const itemId = (evt.item as HTMLElement).dataset.itemId;
      if (itemId) {
        const item = props.pipelineItems.find((i) => i.id === itemId);
        if (item?.pinned) {
          emit("unpin-item", itemId);
        }
      }
    },
  }));

  sortableInstances.set(repoId, instances);
}

// Init sortables when repos/items change
watch(
  () => [props.repos, props.pipelineItems],
  () => {
    nextTick(() => {
      for (const repo of props.repos) {
        if (!collapsedRepos.value.has(repo.id)) {
          initSortables(repo.id);
        }
      }
    });
  },
  { immediate: true, deep: true }
);
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-content">
      <div v-if="repos.length === 0" class="empty-state">
        No repos imported yet.
      </div>

      <div v-for="repo in repos" :key="repo.id" class="repo-section">
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
            title="New Task (⌘N)"
            @click.stop="emit('new-task', repo.id)"
          >+</button>
        </div>

        <div v-if="!collapsedRepos.has(repo.id)" class="pipeline-list">
          <!-- Pinned tasks -->
          <div :data-pinned="repo.id" class="pinned-zone">
            <div
              v-for="item in sortedPinned(repo.id)"
              :key="item.id"
              :data-item-id="item.id"
              class="pipeline-item"
              :class="{ selected: selectedItemId === item.id }"
              @click="handleSelectItem(item)"
              @dblclick.stop="startRename(item)"
            >
              <input
                v-if="editingItemId === item.id"
                class="rename-input"
                v-model="editingValue"
                @keydown.enter="commitRename(item.id)"
                @keydown.escape="cancelRename()"
                @blur="commitRename(item.id)"
                @click.stop
              />
              <span
                v-else
                class="item-title"
                :style="{
                  fontWeight: item.activity === 'unread' ? 'bold' : 'normal',
                  fontStyle: item.activity === 'working' ? 'italic' : 'normal',
                }"
              >{{ itemTitle(item) }}</span>
            </div>
          </div>

          <!-- Divider -->
          <div v-show="itemsForRepo(repo.id).length > 0" class="pin-divider">
            <div class="pin-divider-line"></div>
          </div>

          <!-- Unpinned tasks -->
          <div :data-unpinned="repo.id" class="unpinned-zone">
            <div
              v-for="item in sortedUnpinned(repo.id)"
              :key="item.id"
              :data-item-id="item.id"
              class="pipeline-item"
              :class="{ selected: selectedItemId === item.id }"
              @click="handleSelectItem(item)"
              @dblclick.stop="startRename(item)"
            >
              <input
                v-if="editingItemId === item.id"
                class="rename-input"
                v-model="editingValue"
                @keydown.enter="commitRename(item.id)"
                @keydown.escape="cancelRename()"
                @blur="commitRename(item.id)"
                @click.stop
              />
              <span
                v-else
                class="item-title"
                :style="{
                  fontWeight: item.activity === 'unread' ? 'bold' : 'normal',
                  fontStyle: item.activity === 'working' ? 'italic' : 'normal',
                }"
              >{{ itemTitle(item) }}</span>
            </div>
          </div>

          <div v-if="itemsForRepo(repo.id).length === 0" class="no-items">
            No tasks
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-footer">
      <button class="btn-import" @click="emit('import-repo')">
        Import Repo
      </button>
      <button class="btn-icon btn-prefs" title="Preferences (⌘,)" @click="emit('open-preferences')">
        &#9881;
      </button>
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
  margin-left: auto;
  font-size: 14px;
  padding: 0 4px;
  opacity: 0.5;
}

.btn-add-task:hover {
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

.btn-import {
  flex: 1;
  padding: 6px 12px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #ccc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.btn-import:hover {
  background: #333;
  color: #e0e0e0;
}

.btn-prefs {
  flex-shrink: 0;
  font-size: 14px;
}

.pinned-zone {
  min-height: 0;
}

.pinned-zone:not(:empty) {
  min-height: 28px;
}

.pin-divider {
  padding: 6px 6px;
}

.pin-divider-line {
  height: 1px;
  background: #555;
}

.unpinned-zone {
  min-height: 8px;
}

/* Sortable.js classes */
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
