<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import Database from "@tauri-apps/plugin-sql";
import type { DbHandle, PipelineItem } from "@kanna/db";
import { listPipelineItems } from "@kanna/db";
import type { Stage } from "@kanna/core";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import { useRepo } from "./composables/useRepo";
import { usePipeline } from "./composables/usePipeline";
import { usePreferences } from "./composables/usePreferences";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";

const db = ref<DbHandle | null>(null);

const { repos, selectedRepoId, refresh: refreshRepos, importRepo } = useRepo(db);
const { items, selectedItemId, loadItems, transition, createItem, selectedItem } = usePipeline(db);
const { load: loadPreferences } = usePreferences(db);

const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const zenMode = ref(false);

const currentItem = computed(() => selectedItem());

// Load pipeline items when selected repo changes
watch(selectedRepoId, async (repoId) => {
  if (repoId) {
    await loadItems(repoId);
  } else {
    items.value = [];
    selectedItemId.value = null;
  }
});

// All pipeline items across all repos for sidebar display
const allItems = ref<PipelineItem[]>([]);

async function refreshAllItems() {
  if (!db.value) return;
  const allLoaded: PipelineItem[] = [];
  for (const repo of repos.value) {
    const repoItems = await listPipelineItems(db.value, repo.id);
    allLoaded.push(...repoItems);
  }
  allItems.value = allLoaded;
}

watch([repos, selectedRepoId], refreshAllItems, { immediate: true });

// Keyboard shortcuts
function navigateItems(direction: -1 | 1) {
  const currentItems = items.value;
  if (currentItems.length === 0) return;

  const currentIndex = currentItems.findIndex((i) => i.id === selectedItemId.value);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  selectedItemId.value = currentItems[nextIndex].id;
}

function handleMerge() {
  const item = selectedItem();
  if (item && item.stage === "needs_review") {
    transition(item.id, "merged" as Stage);
  }
}

function handleCloseTask() {
  const item = selectedItem();
  if (item && item.stage !== "merged" && item.stage !== "closed") {
    transition(item.id, "closed" as Stage);
  }
}

useKeyboardShortcuts({
  newTask: () => { showNewTaskModal.value = true; },
  merge: handleMerge,
  closeTask: handleCloseTask,
  toggleZen: () => { zenMode.value = !zenMode.value; },
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  exitZen: () => { zenMode.value = false; },
});

// Handlers
async function handleSelectRepo(repoId: string) {
  selectedRepoId.value = repoId;
}

function handleSelectItem(itemId: string) {
  selectedItemId.value = itemId;
}

async function handleNewTaskSubmit(prompt: string) {
  if (!selectedRepoId.value) return;
  await createItem(selectedRepoId.value, prompt);
  showNewTaskModal.value = false;
  await refreshAllItems();
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

// Initialize
onMounted(async () => {
  try {
    const database = await Database.load("sqlite:kanna-v2.db");
    db.value = database as unknown as DbHandle;
    await refreshRepos();
    await loadPreferences();
  } catch (e) {
    console.error("Failed to initialize database:", e);
  }
});
</script>

<template>
  <div class="app" :class="{ zen: zenMode }">
    <Sidebar
      v-if="!zenMode"
      :repos="repos"
      :pipeline-items="allItems"
      :selected-repo-id="selectedRepoId"
      :selected-item-id="selectedItemId"
      @select-repo="handleSelectRepo"
      @select-item="handleSelectItem"
      @import-repo="showImportRepoModal = true"
      @new-task="showNewTaskModal = true"
    />
    <MainPanel
      :item="currentItem"
      @make-pr="() => {}"
      @merge="handleMerge"
      @close-task="handleCloseTask"
    />

    <NewTaskModal
      v-if="showNewTaskModal"
      @submit="handleNewTaskSubmit"
      @cancel="showNewTaskModal = false"
    />
    <ImportRepoModal
      v-if="showImportRepoModal"
      @import="handleImportRepo"
      @cancel="showImportRepoModal = false"
    />
  </div>
</template>

<style>
:root {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  color: #e0e0e0;
  background-color: #1a1a1a;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>

<style scoped>
.app {
  display: flex;
  height: 100%;
  width: 100%;
}

.app.zen {
  /* In zen mode, sidebar is hidden, main panel fills everything */
}
</style>
