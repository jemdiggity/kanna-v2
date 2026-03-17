<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { DbHandle, PipelineItem } from "@kanna/db";
import { listPipelineItems } from "@kanna/db";
import type { Stage } from "@kanna/core";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import { useRepo } from "./composables/useRepo";
import { usePipeline } from "./composables/usePipeline";
import { usePreferences } from "./composables/usePreferences";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { useResourceSweeper } from "./composables/useResourceSweeper";
import { usePRWorkflow } from "./composables/usePRWorkflow";

const db = ref<DbHandle | null>(null);

const { repos, selectedRepoId, refresh: refreshRepos, importRepo } = useRepo(db);
const { items, selectedItemId, loadItems, transition, createItem, selectedItem } = usePipeline(db);
const {
  fontFamily,
  fontSize,
  suspendAfterMinutes,
  killAfterMinutes,
  appearanceMode,
  ideCommand,
  load: loadPreferences,
  save: savePreference,
} = usePreferences(db);

// Resource sweeper — runs every 60s, manages idle sessions and old tasks
useResourceSweeper(
  () => db.value,
  () => ({
    suspendAfterMinutes: suspendAfterMinutes.value,
    killAfterMinutes: killAfterMinutes.value,
  })
);

const selectedRepo = computed(() =>
  repos.value.find((r) => r.id === selectedRepoId.value) ?? null
);

// PR workflow — only instantiate when db is available
const prWorkflow = computed(() =>
  db.value ? usePRWorkflow(db.value) : null
);

const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showPreferencesPanel = ref(false);
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

async function handleMakePR() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.createPR(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("PR creation failed:", e);
  }
}

async function handleMerge() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.mergePR(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Merge failed:", e);
  }
}

async function handleCloseTask() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.closeTask(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Close failed:", e);
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
  openPreferences: () => { showPreferencesPanel.value = true; },
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
  const repo = repos.value.find((r) => r.id === selectedRepoId.value);
  if (!repo) return;
  await createItem(selectedRepoId.value, repo.path, prompt);
  showNewTaskModal.value = false;
  await refreshAllItems();
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

async function handlePreferenceUpdate(key: string, value: string) {
  await savePreference(key, value);
}

// Reconcile DB terminal sessions against live daemon sessions on startup
async function reconcileSessions() {
  if (!db.value) return;
  try {
    const liveSessions = await invoke<{ session_id: string }[]>("list_sessions");
    const liveIds = new Set(liveSessions.map((s) => s.session_id));

    const dbSessions = await db.value.select<{ id: string; daemon_session_id: string }>(
      "SELECT id, daemon_session_id FROM terminal_session WHERE daemon_session_id IS NOT NULL"
    );

    for (const s of dbSessions) {
      if (!liveIds.has(s.daemon_session_id)) {
        await db.value!.execute("DELETE FROM terminal_session WHERE id = ?", [s.id]);
      }
    }
  } catch {
    // Daemon may not be running yet
  }
}

// Initialize
onMounted(async () => {
  try {
    const database = await Database.load("sqlite:kanna-v2.db");
    db.value = database as unknown as DbHandle;
    await refreshRepos();
    await loadPreferences();
    await reconcileSessions();
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
      @open-preferences="showPreferencesPanel = true"
    />
    <MainPanel
      :item="currentItem"
      @make-pr="handleMakePR"
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
    <PreferencesPanel
      v-if="showPreferencesPanel"
      :preferences="{
        fontFamily: fontFamily,
        fontSize: fontSize,
        suspendAfterMinutes: suspendAfterMinutes,
        killAfterMinutes: killAfterMinutes,
        appearanceMode: appearanceMode,
        ideCommand: ideCommand,
      }"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
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
