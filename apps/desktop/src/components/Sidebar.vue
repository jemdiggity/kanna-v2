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
}>();

const collapsedRepos = ref<Set<string>>(new Set());

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
    .filter((item) => item.repo_id === repoId)
    .sort((a, b) => {
      const ao = order[(a as any).activity || "idle"] ?? 0;
      const bo = order[(b as any).activity || "idle"] ?? 0;
      if (ao !== bo) return ao - bo;
      const aTime = (a as any).activity_changed_at || a.created_at;
      const bTime = (b as any).activity_changed_at || b.created_at;
      return bTime.localeCompare(aTime);
    });
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
            title="New Task"
            @click.stop="emit('new-task', repo.id)"
          >+</button>
        </div>

        <div v-if="!collapsedRepos.has(repo.id)" class="pipeline-list">
          <div
            v-for="item in itemsForRepo(repo.id)"
            :key="item.id"
            class="pipeline-item"
            :class="{ selected: selectedItemId === item.id }"
            @click="handleSelectItem(item)"
          >
            <span
              class="item-title"
              :style="{
                fontWeight: (item as any).activity === 'unread' ? 'bold' : 'normal',
                fontStyle: (item as any).activity === 'working' ? 'italic' : 'normal',
              }"
            >{{ itemTitle(item) }}</span>
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
      <button class="btn-icon btn-prefs" title="Preferences (Cmd+,)" @click="emit('open-preferences')">
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
  font-family: "SF Mono", Menlo, monospace;
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
</style>
