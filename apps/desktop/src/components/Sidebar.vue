<script setup lang="ts">
import type { Repo, PipelineItem } from "@kanna/db";
import { ref } from "vue";

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
}>();

const collapsedRepos = ref<Set<string>>(new Set());

const draggingItemId = ref<string | null>(null);
const dropTarget = ref<{ zone: "pinned" | "unpinned"; index: number } | null>(null);

function toggleRepo(repoId: string) {
  if (collapsedRepos.value.has(repoId)) {
    collapsedRepos.value.delete(repoId);
  } else {
    collapsedRepos.value.add(repoId);
  }
}

function itemsForRepo(repoId: string): PipelineItem[] {
  const order: Record<string, number> = { idle: 0, unread: 1, working: 2 };
  return props.pipelineItems
    .filter((item) => item.repo_id === repoId && item.stage !== "closed")
    .sort((a, b) => {
      // Pinned tasks always come first
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      // Among pinned tasks, sort by pin_order
      if (a.pinned && b.pinned) return (a.pin_order ?? 0) - (b.pin_order ?? 0);
      // Among unpinned tasks, sort by activity then time
      const ao = order[a.activity || "idle"] ?? 0;
      const bo = order[b.activity || "idle"] ?? 0;
      if (ao !== bo) return ao - bo;
      const aTime = a.activity_changed_at || a.created_at;
      const bTime = b.activity_changed_at || b.created_at;
      return bTime.localeCompare(aTime);
    });
}

function pinnedItemsForRepo(repoId: string): PipelineItem[] {
  return itemsForRepo(repoId).filter((item) => item.pinned);
}

function unpinnedItemsForRepo(repoId: string): PipelineItem[] {
  return itemsForRepo(repoId).filter((item) => !item.pinned);
}

function itemTitle(item: PipelineItem): string {
  const raw = item.issue_title || item.prompt || "Untitled";
  return raw.length > 40 ? raw.slice(0, 40) + "..." : raw;
}

function handleSelectRepo(repoId: string) {
  emit("select-repo", repoId);
}

function handleSelectItem(item: PipelineItem) {
  emit("select-repo", item.repo_id);
  emit("select-item", item.id);
}

function handleDragStart(e: DragEvent, item: PipelineItem) {
  draggingItemId.value = item.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.id);
  }
}

function handleDragEnd() {
  draggingItemId.value = null;
  dropTarget.value = null;
}

function handleDragOverPinned(e: DragEvent, repoId: string, index: number) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dropTarget.value = { zone: "pinned", index };
}

function handleDragOverUnpinned(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dropTarget.value = { zone: "unpinned", index: 0 };
}

function handleDragOverDivider(e: DragEvent, repoId: string) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dropTarget.value = { zone: "pinned", index: pinnedItemsForRepo(repoId).length };
}

function handleDropPinned(e: DragEvent, repoId: string, index: number) {
  e.preventDefault();
  const itemId = draggingItemId.value;
  if (!itemId) return;

  // Guard against cross-repo drag
  const draggedItem = props.pipelineItems.find((i) => i.id === itemId);
  if (!draggedItem || draggedItem.repo_id !== repoId) { handleDragEnd(); return; }

  const pinned = pinnedItemsForRepo(repoId);
  const wasPinned = pinned.some((i) => i.id === itemId);

  if (wasPinned) {
    const currentIds = pinned.map((i) => i.id).filter((id) => id !== itemId);
    currentIds.splice(index, 0, itemId);
    emit("reorder-pinned", repoId, currentIds);
  } else {
    const currentIds = pinned.map((i) => i.id);
    currentIds.splice(index, 0, itemId);
    emit("pin-item", itemId, index);
    emit("reorder-pinned", repoId, currentIds);
  }

  handleDragEnd();
}

function handleDropUnpinned(e: DragEvent, itemId?: string) {
  e.preventDefault();
  const draggedId = itemId || draggingItemId.value;
  if (!draggedId) return;

  const item = props.pipelineItems.find((i) => i.id === draggedId);
  if (item?.pinned) {
    emit("unpin-item", draggedId);
  }

  handleDragEnd();
}
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
          <template v-if="pinnedItemsForRepo(repo.id).length > 0 || draggingItemId">
            <div
              v-if="pinnedItemsForRepo(repo.id).length === 0"
              class="pin-drop-zone"
              @dragover.prevent="handleDragOverPinned($event, repo.id, 0)"
              @drop="handleDropPinned($event, repo.id, 0)"
            >
              <div
                class="drop-indicator"
                :class="{ active: dropTarget?.zone === 'pinned' && dropTarget?.index === 0 }"
              ></div>
            </div>
            <template v-for="(item, idx) in pinnedItemsForRepo(repo.id)" :key="item.id">
              <div
                class="drop-indicator"
                :class="{ active: dropTarget?.zone === 'pinned' && dropTarget?.index === idx }"
                @dragover.prevent="handleDragOverPinned($event, repo.id, idx)"
                @drop="handleDropPinned($event, repo.id, idx)"
              ></div>
              <div
                class="pipeline-item"
                :class="{
                  selected: selectedItemId === item.id,
                  dragging: draggingItemId === item.id,
                }"
                draggable="true"
                @dragstart="handleDragStart($event, item)"
                @dragend="handleDragEnd"
                @click="handleSelectItem(item)"
              >
                <span
                  class="item-title"
                  :style="{
                    fontWeight: item.activity === 'unread' ? 'bold' : 'normal',
                    fontStyle: item.activity === 'working' ? 'italic' : 'normal',
                  }"
                >{{ itemTitle(item) }}</span>
              </div>
            </template>
            <!-- Drop indicator after last pinned item -->
            <div
              class="drop-indicator"
              :class="{ active: dropTarget?.zone === 'pinned' && dropTarget?.index === pinnedItemsForRepo(repo.id).length }"
              @dragover.prevent="handleDragOverPinned($event, repo.id, pinnedItemsForRepo(repo.id).length)"
              @drop="handleDropPinned($event, repo.id, pinnedItemsForRepo(repo.id).length)"
            ></div>
          </template>

          <!-- Divider -->
          <div
            v-if="pinnedItemsForRepo(repo.id).length > 0 || draggingItemId"
            class="pin-divider"
            @dragover.prevent="handleDragOverDivider($event, repo.id)"
            @drop="handleDropPinned($event, repo.id, pinnedItemsForRepo(repo.id).length)"
          >
            <div class="pin-divider-line"></div>
          </div>

          <!-- Unpinned tasks -->
          <div
            class="unpinned-zone"
            @dragover.prevent="handleDragOverUnpinned($event)"
            @drop="handleDropUnpinned($event)"
          >
            <div
              v-for="item in unpinnedItemsForRepo(repo.id)"
              :key="item.id"
              class="pipeline-item"
              :class="{
                selected: selectedItemId === item.id,
                dragging: draggingItemId === item.id,
              }"
              draggable="true"
              @dragstart="handleDragStart($event, item)"
              @dragend="handleDragEnd"
              @click="handleSelectItem(item)"
            >
              <span
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

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #333;
  -webkit-app-region: drag;
}

.app-title {
  font-size: 14px;
  font-weight: 600;
  color: #f0f0f0;
  letter-spacing: 0.5px;
}

.flipped {
  display: inline-block;
  transform: scaleX(-1);
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
  cursor: pointer;
  border-radius: 4px;
  margin: 1px 6px;
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

.pin-divider {
  padding: 4px 6px;
}

.pin-divider-line {
  height: 1px;
  background: #333;
}

.drop-indicator {
  height: 0;
  margin: 0 6px;
  transition: height 0.1s;
}

.drop-indicator.active {
  height: 2px;
  background: #0066cc;
  border-radius: 1px;
}

.pin-drop-zone {
  min-height: 8px;
}

.pipeline-item.dragging {
  opacity: 0.3;
}

.unpinned-zone {
  min-height: 4px;
}
</style>
