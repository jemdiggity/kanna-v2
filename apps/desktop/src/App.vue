<script setup lang="ts">
import { ref, computed, inject, onMounted, nextTick, type Ref } from "vue";

import { computedAsync } from "@vueuse/core";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import { hasTag } from "@kanna/core";
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
import AnalyticsModal from "./components/AnalyticsModal.vue";
import BlockerSelectModal from "./components/BlockerSelectModal.vue";
import ToastContainer from "./components/ToastContainer.vue";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { startPeriodicBackup } from "./composables/useBackup";
import { createNavigationHistory } from "./composables/useNavigationHistory";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { activeContext } from "./composables/useShortcutContext";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useKannaStore } from "./stores/kanna";
import { NEW_CUSTOM_TASK_PROMPT } from "@kanna/core";
import type { CustomTaskConfig } from "@kanna/core";
import type { DynamicCommand } from "./components/CommandPaletteModal.vue";

const store = useKannaStore();
const toast = useToast();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;
const { tasks: customTasks, scan: scanCustomTasks } = useCustomTasks();
const { recordNavigation, goBack, goForward } = createNavigationHistory();
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);

// UI state
const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showShortcutsModal = ref(false);
const shortcutsContext = ref<"main" | "diff" | "file">("main");
const showFilePickerModal = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const showDiffModal = ref(false);
const showShellModal = ref(false);
const showCommandPalette = ref(false);
const showAnalyticsModal = ref(false);
const showBlockerSelect = ref(false);
const blockerSelectMode = ref<"block" | "edit">("block");
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
  const nextId = currentItems[nextIndex].id;
  if (nextId !== store.selectedItemId) {
    if (store.selectedItemId) recordNavigation(store.selectedItemId);
    store.selectItem(nextId);
  }
}

function handleBlockTask() {
  blockerSelectMode.value = "block";
  showBlockerSelect.value = true;
}

function handleEditBlockedTask() {
  blockerSelectMode.value = "edit";
  showBlockerSelect.value = true;
}

const blockerCandidates = computed(() => {
  const item = store.currentItem;
  if (!item) return [];
  return store.items.filter((i) =>
    i.id !== item.id &&
    !hasTag(i, "done") && !hasTag(i, "pr") && !hasTag(i, "merge") &&
    i.repo_id === store.selectedRepoId
  );
});

// Tasks that would create circular dependencies — shown greyed out
const disabledBlockerIds = computedAsync(async () => {
  const item = store.currentItem;
  if (!item) return [];
  if (!hasTag(item, "done")) {
    const dependents = await collectDependents(item.id);
    return [...dependents];
  }
  return [];
}, []);

/** Walk the blocker graph to find all tasks transitively blocked by itemId. */
async function collectDependents(itemId: string): Promise<Set<string>> {
  const result = new Set<string>();
  const queue = [itemId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const blocked = await store.listBlockedByItem(current);
    for (const b of blocked) {
      if (!result.has(b.id)) {
        result.add(b.id);
        queue.push(b.id);
      }
    }
  }
  return result;
}

const preselectedBlockerIds = computedAsync(async () => {
  const item = store.currentItem;
  if (!item || !hasTag(item, "blocked")) return [];
  const blockers = await store.listBlockersForItem(item.id);
  return blockers.map((b: any) => b.id);
}, []);

// Build a map of blocked item ID → blocker names for the sidebar
const sidebarBlockerNames = computedAsync(async () => {
  const blockedItems = store.items.filter((i) => hasTag(i, "blocked"));
  if (blockedItems.length === 0) return {};
  const map: Record<string, string> = {};
  for (const item of blockedItems) {
    const blockers = await store.listBlockersForItem(item.id);
    map[item.id] = blockers
      .map((b) => b.display_name || (b.prompt ? b.prompt.slice(0, 30) : "Untitled"))
      .join(", ");
  }
  return map;
}, {});

async function onBlockerConfirm(selectedIds: string[]) {
  showBlockerSelect.value = false;
  if (blockerSelectMode.value === "block") {
    await store.blockTask(selectedIds);
  } else {
    const item = store.currentItem;
    if (item) {
      try {
        await store.editBlockedTask(item.id, selectedIds);
      } catch (e: any) {
        toast.error(e.message);
      }
    }
  }
}

const paletteExtraCommands = computed(() => {
  const cmds: Array<{ action: ActionName; label: string; group: string; shortcut: string }> = [];
  const item = store.currentItem;
  if (item && !hasTag(item, "done") && !hasTag(item, "blocked")) {
    cmds.push({ action: "blockTask", label: "Block Task", group: "Tasks", shortcut: "" });
  }
  if (item && hasTag(item, "blocked")) {
    cmds.push({ action: "editBlockedTask", label: "Edit Blocked Task", group: "Tasks", shortcut: "" });
  }
  return cmds;
});

// Custom tasks
async function handleLaunchCustomTask(task: CustomTaskConfig) {
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
    await store.createItem(store.selectedRepoId, repo.path, task.prompt, "pty", { customTask: task });
  } catch (e: any) {
    console.error("[App] custom task launch failed:", e);
    alert(`Custom task launch failed: ${e?.message || e}`);
  }
}

async function handleCreateCustomTask() {
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
    await store.createItem(store.selectedRepoId, repo.path, NEW_CUSTOM_TASK_PROMPT);
  } catch (e: any) {
    console.error("[App] custom task creation failed:", e);
    alert(`Custom task creation failed: ${e?.message || e}`);
  }
}

const customTaskCommands = computed<DynamicCommand[]>(() => {
  const cmds: DynamicCommand[] = [];
  // Always include "New Custom Task" option
  cmds.push({
    id: "custom-task-new",
    label: "New Custom Task",
    description: "Create a new reusable agent task definition",
    execute: () => handleCreateCustomTask(),
  });
  // Add discovered custom tasks
  for (const task of customTasks.value) {
    cmds.push({
      id: `custom-task-${task.name}`,
      label: task.name,
      description: task.description,
      execute: () => handleLaunchCustomTask(task),
    });
  }
  return cmds;
});

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
    if (showShortcutsModal.value) { showShortcutsModal.value = false; focusAgentTerminal(); return; }
    if (showFilePreviewModal.value) { showFilePreviewModal.value = false; focusAgentTerminal(); return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; focusAgentTerminal(); return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximized.value = false; focusAgentTerminal(); return; }
    if (showAnalyticsModal.value) { showAnalyticsModal.value = false; focusAgentTerminal(); return; }
    if (showShellModal.value) { return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; focusAgentTerminal(); return; }
    if (showImportRepoModal.value) { showImportRepoModal.value = false; focusAgentTerminal(); return; }
  },
  openShell: () => { showShellModal.value = !showShellModal.value; },
  showDiff: () => { showDiffModal.value = !showDiffModal.value; },
  showShortcuts: () => {
    if (showShortcutsModal.value) {
      showShortcutsModal.value = false;
      return;
    }
    // Close non-context modals (command palette isn't a context)
    showCommandPalette.value = false;
    // Don't close diff/shell/file preview/file picker — those provide context
    // Snapshot the active context at open time
    shortcutsContext.value = activeContext.value;
    showShortcutsModal.value = true;
  },
  commandPalette: () => {
    showCommandPalette.value = !showCommandPalette.value;
    if (showCommandPalette.value) {
      const repo = store.selectedRepo;
      if (repo) scanCustomTasks(repo.path);
    }
  },
  showAnalytics: () => { showAnalyticsModal.value = !showAnalyticsModal.value; },
  goBack: () => {
    if (!store.selectedItemId) return;
    const validIds = new Set(store.items.filter((i) => !hasTag(i, "done")).map((i) => i.id));
    const taskId = goBack(store.selectedItemId, validIds);
    if (taskId) store.selectItem(taskId);
  },
  goForward: () => {
    if (!store.selectedItemId) return;
    const validIds = new Set(store.items.filter((i) => !hasTag(i, "done")).map((i) => i.id));
    const taskId = goForward(store.selectedItemId, validIds);
    if (taskId) store.selectItem(taskId);
  },
  importRepo: () => { showImportRepoModal.value = true; },
  blockTask: () => { handleBlockTask(); },
  editBlockedTask: () => { handleEditBlockedTask(); },
};
useKeyboardShortcuts(keyboardActions, {
  beforeAction: (action) => {
    if (action !== "showShortcuts" && action !== "dismiss" && showShortcutsModal.value) {
      showShortcutsModal.value = false;
    }
  },
});

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

function handleSelectItem(itemId: string) {
  if (store.selectedItemId && store.selectedItemId !== itemId) {
    recordNavigation(store.selectedItemId);
  }
  store.selectItem(itemId);
}

// Handlers that mix UI state + store
async function handleNewTaskSubmit(prompt: string) {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      toast.warning("Select a repository first");
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
    toast.error(`Task creation failed: ${e?.message || e}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

const currentBlockers = computedAsync(async () => {
  const item = store.currentItem;
  if (!item || !hasTag(item, "blocked")) return [];
  return store.listBlockersForItem(item.id);
}, []);

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
      :blocker-names="sidebarBlockerNames"
      @select-repo="store.selectRepo"
      @select-item="handleSelectItem"
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
      :blockers="currentBlockers"
      :has-repos="store.repos.length > 0"
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
      :extra-commands="paletteExtraCommands"
      :dynamic-commands="customTaskCommands"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      :context="shortcutsContext"
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
      @close="showDiffModal = false; maximized = false; focusAgentTerminal()"
    />
    <FilePickerModal
      v-if="showFilePickerModal && store.selectedRepo?.path"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      @close="showFilePickerModal = false; focusAgentTerminal()"
      @select="(f: string) => { showFilePickerModal = false; previewFilePath = f; showFilePreviewModal = true; }"
    />
    <FilePreviewModal
      v-if="showFilePreviewModal && store.selectedRepo?.path"
      :file-path="previewFilePath"
      :worktree-path="store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path"
      :ide-command="store.ideCommand"
      @close="showFilePreviewModal = false; focusAgentTerminal()"
    />
    <AnalyticsModal
      v-if="showAnalyticsModal"
      :db="db"
      :repo-id="store.selectedRepoId"
      @close="showAnalyticsModal = false"
    />
    <BlockerSelectModal
      v-if="showBlockerSelect"
      :candidates="blockerCandidates"
      :disabled-ids="disabledBlockerIds"
      :preselected="blockerSelectMode === 'edit' ? preselectedBlockerIds : undefined"
      :title="blockerSelectMode === 'block' ? 'Select blocking tasks' : 'Edit blocking tasks'"
      @confirm="onBlockerConfirm"
      @cancel="showBlockerSelect = false"
    />
    <ToastContainer />
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
