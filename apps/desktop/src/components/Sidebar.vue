<script setup lang="ts">
import type { Repo, PipelineItem } from "@kanna/db";
import { hasTag } from "@kanna/core";
import { ref, nextTick } from "vue";
import draggable from "vuedraggable";

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
  (e: "import-repo"): void;
  (e: "new-task", repoId: string): void;
  (e: "pin-item", itemId: string, position: number): void;
  (e: "unpin-item", itemId: string): void;
  (e: "reorder-pinned", repoId: string, orderedIds: string[]): void;
  (e: "rename-item", itemId: string, displayName: string | null): void;
  (e: "hide-repo", repoId: string): void;
}>();

const collapsedRepos = ref<Set<string>>(new Set());

function sortedPinned(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && !hasTag(i, "done") && i.pinned)
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0));
}

function sortByActivity(items: PipelineItem[]): PipelineItem[] {
  const order: Record<string, number> = { idle: 0, unread: 1, working: 2 };
  return items.sort((a, b) => {
    const ao = order[a.activity || "idle"] ?? 0;
    const bo = order[b.activity || "idle"] ?? 0;
    if (ao !== bo) return ao - bo;
    const isIdle = (a.activity || "idle") === "idle";
    const aTime = (isIdle ? a.unread_at : null) || a.activity_changed_at || a.created_at;
    const bTime = (isIdle ? b.unread_at : null) || b.activity_changed_at || b.created_at;
    return bTime.localeCompare(aTime);
  });
}

function sortedPR(repoId: string): PipelineItem[] {
  return sortByActivity(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "pr") && !hasTag(i, "done") && !i.pinned)
  );
}

function sortedMerge(repoId: string): PipelineItem[] {
  return sortByActivity(
    props.pipelineItems.filter((i) => i.repo_id === repoId && hasTag(i, "merge") && !hasTag(i, "done") && !i.pinned)
  );
}

function sortedActive(repoId: string): PipelineItem[] {
  return sortByActivity(
    props.pipelineItems.filter((i) => i.repo_id === repoId && !hasTag(i, "pr") && !hasTag(i, "merge") && !hasTag(i, "blocked") && !hasTag(i, "done") && !i.pinned)
  );
}

function sortedBlocked(repoId: string): PipelineItem[] {
  return props.pipelineItems
    .filter((i) => i.repo_id === repoId && hasTag(i, "blocked") && !hasTag(i, "done") && !i.pinned)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function itemsForRepo(repoId: string): PipelineItem[] {
  return [...sortedPinned(repoId), ...sortedMerge(repoId), ...sortedPR(repoId), ...sortedActive(repoId), ...sortedBlocked(repoId)];
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
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-content">
      <div v-if="repos.length === 0" class="empty-state">
        No repos imported yet.<br>
        Press <kbd>⇧⌘I</kbd> to import one.
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
          <button
            class="btn-icon btn-hide-repo"
            title="Remove Repo"
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
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- Divider -->
          <div v-show="sortedPinned(repo.id).length > 0" class="pin-divider">
            <div class="pin-divider-line"></div>
          </div>

          <!-- Merge Queue tasks -->
          <div v-if="sortedMerge(repo.id).length > 0" class="section-label">Merge Queue</div>
          <draggable
            :model-value="sortedMerge(repo.id)"
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
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- PR tasks -->
          <div v-if="sortedPR(repo.id).length > 0" class="section-label">Pull Requests</div>
          <draggable
            :model-value="sortedPR(repo.id)"
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
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- Active tasks -->
          <div v-if="sortedActive(repo.id).length > 0" class="section-label">Active</div>
          <draggable
            :model-value="sortedActive(repo.id)"
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
                  }"
                >{{ itemTitle(element) }}</span>
              </div>
            </template>
          </draggable>

          <!-- Blocked tasks -->
          <div v-if="sortedBlocked(repo.id).length > 0" class="section-label">Blocked</div>
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
                >Blocked by: {{ blockerNames[element.id] }}</span>
              </div>
            </div>
          </div>

          <div v-if="itemsForRepo(repo.id).length === 0" class="no-items">
            No tasks
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-footer">
      <button class="btn-import" @click="emit('import-repo')" title="Import Repo (⇧⌘I)">
        Import Repo
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
