<script setup lang="ts">
import { ref, inject, onMounted, nextTick, type Ref } from "vue";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import type { DbHandle } from "@kanna/db";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import FilePreviewModal from "./components/FilePreviewModal.vue";
import DiffModal from "./components/DiffModal.vue";
import ShellModal from "./components/ShellModal.vue";
import CommandPaletteModal from "./components/CommandPaletteModal.vue";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { startPeriodicBackup } from "./composables/useBackup";
import { useKannaStore } from "./stores/kanna";

const store = useKannaStore();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;

// UI state
const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showShortcutsModal = ref(false);
const showFilePickerModal = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const showDiffModal = ref(false);
const showShellModal = ref(false);
const showCommandPalette = ref(false);
const diffScopes = new Map<string, "branch" | "commit" | "working">();
const zenMode = ref(false);
const sidebarHidden = ref(false);
const maximized = ref(false);

// Navigation
function navigateItems(direction: -1 | 1) {
  const currentItems = store.sortedItemsForCurrentRepo;
  if (currentItems.length === 0) return;
  const currentIndex = currentItems.findIndex((i) => i.id === store.selectedItemId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  store.selectedItemId = currentItems[nextIndex].id;
}

// Keyboard shortcuts
const keyboardActions = {
  newTask: () => { showNewTaskModal.value = true; },
  newWindow: async () => {
    if (isTauri) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      new WebviewWindow(`window-${Date.now()}`, {
        url: "/", title: "", width: 1200, height: 800, minWidth: 800, minHeight: 600,
      });
    } else {
      window.open(window.location.href, "_blank");
    }
  },
  openFile: () => {
    if (showFilePreviewModal.value) {
      showFilePreviewModal.value = false;
      showFilePickerModal.value = true;
    } else {
      showFilePickerModal.value = !showFilePickerModal.value;
    }
  },
  openInIDE: async () => {
    const item = store.currentItem;
    const repo = store.selectedRepo;
    if (!item?.branch || !repo) return;
    const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
    await invoke("run_script", { script: `${store.ideCommand} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch(() => {});
  },
  makePR: () => store.makePR(),
  mergeQueue: () => store.mergeQueue(),
  closeTask: () => store.closeTask(),
  undoClose: () => store.undoClose(),
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  toggleSidebar: () => { sidebarHidden.value = !sidebarHidden.value; },
  toggleZen: () => { zenMode.value = !zenMode.value; },
  toggleMaximize: () => { maximized.value = !maximized.value; },
  dismiss: () => {
    if (showCommandPalette.value) { showCommandPalette.value = false; return; }
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return; }
    if (showFilePreviewModal.value) { showFilePreviewModal.value = false; return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximized.value = false; return; }
    if (showShellModal.value) { return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return; }
    if (showImportRepoModal.value) { showImportRepoModal.value = false; return; }
  },
  openShell: () => { showShellModal.value = !showShellModal.value; },
  showDiff: () => { showDiffModal.value = !showDiffModal.value; },
  showShortcuts: () => { showShortcutsModal.value = !showShortcutsModal.value; },
  commandPalette: () => { showCommandPalette.value = !showCommandPalette.value; },
};
useKeyboardShortcuts(keyboardActions);

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

// Handlers that mix UI state + store
async function handleNewTaskSubmit(prompt: string) {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert("Select a repository first");
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, prompt);
    showNewTaskModal.value = false;
  } catch (e: any) {
    console.error("Task creation failed:", e);
    alert(`Task creation failed: ${e?.message || e}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

// Init
onMounted(async () => {
  await store.init(db);
  startPeriodicBackup(dbName, ref(db) as Ref<DbHandle | null>);
  if (!store.hideShortcutsOnStartup) {
    showShortcutsModal.value = true;
  }
});
</script>

<template>
  <div class="app" :class="{ zen: zenMode }">
    <Sidebar
      v-if="!zenMode && !maximized && !sidebarHidden"
      :repos="store.repos"
      :pipeline-items="store.items"
      :selected-repo-id="store.selectedRepoId"
      :selected-item-id="store.selectedItemId"
      @select-repo="store.selectRepo"
      @select-item="store.selectItem"
      @import-repo="showImportRepoModal = true"
      @new-task="(repoId: string) => { store.selectedRepoId = repoId; showNewTaskModal = true; }"
      @pin-item="store.pinItem"
      @unpin-item="store.unpinItem"
      @reorder-pinned="store.reorderPinned"
      @rename-item="store.renameItem"
      @hide-repo="store.hideRepo"
    />
    <MainPanel
      :item="store.currentItem"
      :repo-path="store.selectedRepo?.path"
      :spawn-pty-session="store.spawnPtySession"
      :maximized="maximized"
      @close-task="store.closeTask"
      @agent-completed="store.bump"
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
    <CommandPaletteModal
      v-if="showCommandPalette"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      :hide-on-startup="store.hideShortcutsOnStartup"
      @close="showShortcutsModal = false"
      @update:hide-on-startup="(val: boolean) => store.savePreference('hideShortcutsOnStartup', String(val))"
    />
    <KeepAlive :max="10">
      <ShellModal
        v-if="showShellModal && store.currentItem"
        :key="`shell-${store.currentItem.id}`"
        :session-id="`shell-${store.currentItem.id}`"
        :cwd="store.currentItem.branch ? `${store.selectedRepo?.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo?.path || '/tmp'"
        :port-env="store.currentItem.port_env"
        :maximized="maximized"
        @close="showShellModal = false; maximized = false; focusAgentTerminal()"
      />
    </KeepAlive>
    <DiffModal
      v-if="showDiffModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : undefined"
      :initial-scope="store.currentItem ? diffScopes.get(store.currentItem.id) : undefined"
      :maximized="maximized"
      @scope-change="(s: any) => { if (store.currentItem) diffScopes.set(store.currentItem.id, s); }"
      @close="showDiffModal = false; maximized = false"
    />
    <FilePickerModal
      v-if="showFilePickerModal && store.selectedRepo?.path"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      @close="showFilePickerModal = false"
      @select="(f: string) => { showFilePickerModal = false; previewFilePath = f; showFilePreviewModal = true; }"
    />
    <FilePreviewModal
      v-if="showFilePreviewModal && store.selectedRepo?.path"
      :file-path="previewFilePath"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      :ide-command="store.ideCommand"
      @close="showFilePreviewModal = false"
    />
  </div>
</template>

<style>
:root {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: dark;
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
</style>
