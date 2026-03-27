<script setup lang="ts">
import { ref, reactive, computed, inject, onMounted, nextTick, type Ref } from "vue";
import { useI18n } from "vue-i18n";

import { computedAsync } from "@vueuse/core";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import { hasTag } from "@kanna/core";
import { getSetting, setSetting, type DbHandle } from "@kanna/db";
import i18n from "./i18n";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import AddRepoModal from "./components/AddRepoModal.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import FilePreviewModal from "./components/FilePreviewModal.vue";
import TreeExplorerModal from "./components/TreeExplorerModal.vue";
import DiffModal from "./components/DiffModal.vue";
import CommitGraphModal from "./components/CommitGraphModal.vue";
import ShellModal from "./components/ShellModal.vue";
import CommandPaletteModal from "./components/CommandPaletteModal.vue";
import AnalyticsModal from "./components/AnalyticsModal.vue";
import BlockerSelectModal from "./components/BlockerSelectModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import ToastContainer from "./components/ToastContainer.vue";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { startPeriodicBackup } from "./composables/useBackup";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { type ShortcutContext } from "./composables/useShortcutContext";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useGc } from "./composables/useGc";
import { useRestoreFocus } from "./composables/useRestoreFocus";
import { isTopModal } from "./composables/useModalZIndex";
import { useKannaStore } from "./stores/kanna";
import { NEW_CUSTOM_TASK_PROMPT } from "@kanna/core";
import type { CustomTaskConfig } from "@kanna/core";
import type { DynamicCommand } from "./components/CommandPaletteModal.vue";

const store = useKannaStore();
const toast = useToast();
const { t } = useI18n();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;
const { tasks: customTasks, scan: scanCustomTasks } = useCustomTasks();
const gcRef = ref<{ runGc: () => Promise<void> }>();
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);

// UI state
const showNewTaskModal = ref(false);
const showAddRepoModal = ref(false);
const addRepoInitialTab = ref<"create" | "import">("create");
const showShortcutsModal = ref(false);
const shortcutsStartFull = ref(false);
const shortcutsContext = ref<ShortcutContext>("main");
const showFilePickerModal = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const previewInitialLine = ref<number | undefined>(undefined);
const showDiffModal = ref(false);
const showTreeExplorer = ref(false);
const activeWorktreePath = computed(() =>
  store.currentItem?.branch ? `${store.selectedRepo?.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo?.path ?? ""
);
const showShellModal = ref(false);
const shellRepoRoot = ref(false);
const showCommandPalette = ref(false);
const commandUsageCounts = ref<Record<string, number>>({});
const showAnalyticsModal = ref(false);
const showBlockerSelect = ref(false);
const blockerSelectMode = ref<"block" | "edit">("block");
const showPreferencesPanel = ref(false);
const preferences = reactive({
  suspendAfterMinutes: 30,
  killAfterMinutes: 60,
  ideCommand: "code",
  locale: "en",
  devLingerTerminals: false,
  defaultAgentProvider: "claude" as "claude" | "copilot",
});
const diffScopes = new Map<string, "branch" | "commit" | "working">();
const sidebarHidden = ref(false);
const maximizedModal = ref<ShortcutContext | null>(null);
const maximized = computed(() => maximizedModal.value !== null);
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);
const shellModalRef = ref<InstanceType<typeof ShellModal> | null>(null);
const diffModalRef = ref<InstanceType<typeof DiffModal> | null>(null);
const showCommitGraphModal = ref(false);
const commitGraphModalRef = ref<InstanceType<typeof CommitGraphModal> | null>(null);
const treeExplorerRef = ref<InstanceType<typeof TreeExplorerModal> | null>(null);
const filePreviewRef = ref<InstanceType<typeof FilePreviewModal> | null>(null);
const preferencesRef = ref<InstanceType<typeof PreferencesPanel> | null>(null);

// Navigation
function navigateItems(direction: -1 | 1) {
  const allItems = store.sortedItemsAllRepos;
  const sidebar = sidebarRef.value;
  const visibleItems = sidebar?.searchQuery
    ? allItems.filter((i) => sidebar.matchesSearch(i))
    : allItems;
  if (visibleItems.length === 0) return;
  const currentIndex = visibleItems.findIndex((i) => i.id === store.selectedItemId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= visibleItems.length) nextIndex = visibleItems.length - 1;
  }
  const nextItem = visibleItems[nextIndex];
  if (nextItem.id !== store.selectedItemId) {
    if (nextItem.repo_id !== store.selectedRepoId) {
      store.selectRepo(nextItem.repo_id);
    }
    store.selectItem(nextItem.id);
  }
}

function navigateRepos(direction: -1 | 1) {
  const visibleRepos = store.repos;
  if (visibleRepos.length === 0) return;
  const currentIndex = visibleRepos.findIndex((r) => r.id === store.selectedRepoId);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= visibleRepos.length) return;
  }
  const nextRepo = visibleRepos[nextIndex];
  if (nextRepo.id === store.selectedRepoId) return;
  store.selectRepo(nextRepo.id);

  // Restore last-selected task for this repo, or fall back to first task
  const lastItemId = store.lastSelectedItemByRepo[nextRepo.id];
  const lastItem = lastItemId
    ? store.items.find((i) => i.id === lastItemId && i.repo_id === nextRepo.id && !hasTag(i, "done"))
    : undefined;
  if (lastItem) {
    store.selectItem(lastItem.id);
  } else {
    const sorted = store.sortedItemsAllRepos.filter((i) => i.repo_id === nextRepo.id);
    if (sorted.length > 0) {
      store.selectItem(sorted[0].id);
    }
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
    !hasTag(i, "done") &&
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
    cmds.push({ action: "blockTask", label: t('tasks.blockTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
  }
  if (item && hasTag(item, "blocked")) {
    cmds.push({ action: "editBlockedTask", label: t('tasks.editBlockedTask'), group: t('shortcuts.groupTasks'), shortcut: "" });
  }
  return cmds;
});

// Custom tasks
async function handleLaunchCustomTask(task: CustomTaskConfig) {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, task.prompt, "pty", { customTask: task });
  } catch (e: any) {
    console.error("[App] custom task launch failed:", e);
    alert(`${t('app.customTaskLaunchFailed')}: ${e?.message || e}`);
  }
}

async function handleCreateCustomTask() {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      alert(t('app.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  try {
    await store.createItem(store.selectedRepoId, repo.path, NEW_CUSTOM_TASK_PROMPT);
  } catch (e: any) {
    console.error("[App] custom task creation failed:", e);
    alert(`${t('app.customTaskCreationFailed')}: ${e?.message || e}`);
  }
}

const paletteDynamicCommands = computed<DynamicCommand[]>(() => {
  const cmds: DynamicCommand[] = [];
  // Rename task (only when a task is selected)
  if (store.currentItem) {
    cmds.push({
      id: "rename-task",
      label: t('tasks.renameTask'),
      execute: () => sidebarRef.value?.renameSelectedItem(),
    });
  }
  // Always include "New Custom Task" option
  cmds.push({
    id: "custom-task-new",
    label: t('app.newCustomTask'),
    description: t('app.newCustomTaskDesc'),
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
  // Manual GC
  if (gcRef.value) {
    cmds.push({
      id: "run-gc",
      label: t('app.runGc'),
      description: t('app.runGcDesc'),
      execute: () => gcRef.value?.runGc(),
    });
  }
  return cmds;
});

// Derive shortcut context from visible modals (more reliable than the global singleton
// which can be stale if a KeepAlive deactivation resets it after a modal sets it).
const currentShortcutContext = computed<ShortcutContext>(() => {
  if (showFilePreviewModal.value) return "file";
  if (showShellModal.value) return "shell";
  if (showDiffModal.value) return "diff";
  return "main";
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
  toggleTreeExplorer: () => {
    if (showTreeExplorer.value) {
      const z = treeExplorerRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showTreeExplorer.value = false;
      } else {
        treeExplorerRef.value?.bringToFront();
      }
    } else {
      showTreeExplorer.value = true;
    }
  },
  openInIDE: async () => {
    const item = store.currentItem;
    const repo = store.selectedRepo;
    if (!item?.branch || !repo) return;
    const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
    await invoke("run_script", { script: `${store.ideCommand} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch((e) => console.error("[openInIDE] failed:", e));
  },
  makePR: () => store.makePR(),
  mergeQueue: () => store.mergeQueue(),
  closeTask: () => store.closeTask(),
  undoClose: () => store.undoClose(),
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  goToOldestUnread: () => {
    const repoItems = store.sortedItemsForCurrentRepo;
    const unread = repoItems.filter((i) => i.activity === "unread");
    if (unread.length === 0) return;
    const oldest = unread.reduce((a, b) =>
      (a.activity_changed_at ?? "") < (b.activity_changed_at ?? "") ? a : b,
    );
    store.selectItem(oldest.id);
  },
  navigateRepoUp: () => navigateRepos(-1),
  navigateRepoDown: () => navigateRepos(1),
  toggleSidebar: () => { sidebarHidden.value = !sidebarHidden.value; },
  toggleMaximize: () => {
    const ctx = currentShortcutContext.value;
    maximizedModal.value = maximizedModal.value === ctx ? null : ctx;
  },
  dismiss: () => {
    if (showCommandPalette.value) { showCommandPalette.value = false; return; }
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return; }
    if (showFilePreviewModal.value) { filePreviewRef.value?.dismiss(); return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; return; }
    // Shell before diff: Escape closes the topmost modal first
    if (showShellModal.value) { return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximizedModal.value = null; return; }
    if (showAnalyticsModal.value) { showAnalyticsModal.value = false; return; }
    if (showCommitGraphModal.value) { showCommitGraphModal.value = false; return; }
    if (showTreeExplorer.value) { showTreeExplorer.value = false; return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return; }
    if (showAddRepoModal.value) { showAddRepoModal.value = false; return; }
  },
  openShell: () => {
    if (!store.selectedRepo || !store.currentItem) return;
    if (showShellModal.value && !shellRepoRoot.value) {
      const z = shellModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showShellModal.value = false;
        maximizedModal.value = null;
      } else {
        shellModalRef.value?.bringToFront();
      }
    } else {
      shellRepoRoot.value = false;
      showShellModal.value = true;
    }
  },
  openShellRepoRoot: () => {
    if (!store.selectedRepo) return;
    if (showShellModal.value && shellRepoRoot.value) {
      const z = shellModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showShellModal.value = false;
        maximizedModal.value = null;
      } else {
        shellModalRef.value?.bringToFront();
      }
    } else {
      shellRepoRoot.value = true;
      showShellModal.value = true;
    }
  },
  showDiff: () => {
    if (!store.selectedRepo) return;
    if (showDiffModal.value) {
      const z = diffModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showDiffModal.value = false;
        maximizedModal.value = null;
      } else {
        diffModalRef.value?.bringToFront();
      }
    } else {
      showDiffModal.value = true;
    }
  },
  showCommitGraph: () => {
    if (!store.selectedRepo) return;
    if (showCommitGraphModal.value) {
      const z = commitGraphModalRef.value?.zIndex ?? 0;
      if (isTopModal(z)) {
        showCommitGraphModal.value = false;
      } else {
        commitGraphModalRef.value?.bringToFront();
      }
    } else {
      showCommitGraphModal.value = true;
    }
  },
  showShortcuts: () => {
    if (showShortcutsModal.value) {
      if (shortcutsStartFull.value && currentShortcutContext.value !== "main") {
        // Showing all in a modal context → switch to contextual
        shortcutsStartFull.value = false;
      } else {
        showShortcutsModal.value = false;
      }
      return;
    }
    showCommandPalette.value = false;
    shortcutsContext.value = currentShortcutContext.value;
    // Main = always full set; modals start in context mode
    shortcutsStartFull.value = currentShortcutContext.value === "main";
    showShortcutsModal.value = true;
  },
  showAllShortcuts: () => {
    if (showShortcutsModal.value) {
      if (!shortcutsStartFull.value) {
        // Showing contextual → switch to all
        shortcutsStartFull.value = true;
      } else {
        showShortcutsModal.value = false;
      }
      return;
    }
    showCommandPalette.value = false;
    shortcutsContext.value = currentShortcutContext.value;
    shortcutsStartFull.value = true;
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
  goBack: () => store.goBack(),
  goForward: () => store.goForward(),
  createRepo: () => { addRepoInitialTab.value = "create"; showAddRepoModal.value = true; },
  importRepo: () => { addRepoInitialTab.value = "import"; showAddRepoModal.value = true; },
  blockTask: () => { handleBlockTask(); },
  editBlockedTask: () => { handleEditBlockedTask(); },
  openPreferences: () => { showPreferencesPanel.value = true; },
  prevTab: () => { preferencesRef.value?.cycleTab(-1); },
  nextTab: () => { preferencesRef.value?.cycleTab(1); },
  focusSearch: () => { sidebarRef.value?.focusSearch(); },
};
useKeyboardShortcuts(keyboardActions, {
  context: () => currentShortcutContext.value,
  beforeAction: (action) => {
    if (action !== "showShortcuts" && action !== "showAllShortcuts" && action !== "dismiss" && showShortcutsModal.value) {
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

// Auto-restore focus to whatever had it before the modal opened
const anyModalOpen = computed(() =>
  showNewTaskModal.value || showAddRepoModal.value || showShortcutsModal.value ||
  showFilePickerModal.value || showFilePreviewModal.value || showDiffModal.value ||
  showTreeExplorer.value || showShellModal.value || showAnalyticsModal.value ||
  showBlockerSelect.value || showPreferencesPanel.value || showCommitGraphModal.value
);
useRestoreFocus(anyModalOpen);

// Restore focus after native macOS fullscreen exit.
// WKWebView loses first-responder status during the exit animation, breaking
// terminal input and keyboard shortcuts. The Rust side calls
// evaluateJavaScript: after a delay, which triggers becomeFirstResponder on
// WKWebView (WebKit Bug 143482 fix). We track the last meaningful focused
// element and expose a global restore function for that call.
let lastFocusedElement: HTMLElement | null = null;
document.addEventListener("focusin", (e) => {
  const el = e.target as HTMLElement;
  if (el && el !== document.body) lastFocusedElement = el;
});
(window as unknown as Record<string, unknown>).__kannaRestoreFocus = () => {
  if (lastFocusedElement) {
    lastFocusedElement.focus();
  }
};

function handleSelectItem(itemId: string) {
  store.selectItem(itemId);
}

// Handlers that mix UI state + store
async function handleNewTaskSubmit(prompt: string, agentProvider: "claude" | "copilot" = "claude") {
  if (!store.selectedRepoId) {
    if (store.repos.length === 1) {
      store.selectedRepoId = store.repos[0].id;
    } else {
      toast.warning(t('toasts.selectRepoFirst'));
      return;
    }
  }
  const repo = store.repos.find((r) => r.id === store.selectedRepoId);
  if (!repo) return;
  showNewTaskModal.value = false;
  try {
    await store.createItem(store.selectedRepoId, repo.path, prompt, "pty", { agentProvider });
  } catch (e: any) {
    console.error("Task creation failed:", e);
    toast.error(`${t('toasts.taskCreationFailed')}: ${e?.message || e}`);
  }
}

async function handleCreateRepo(name: string, path: string) {
  try {
    await store.createRepo(name, path);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`${t('toasts.repoCreationFailed')}: ${msg}`);
  }
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await store.importRepo(path, name, defaultBranch);
  showAddRepoModal.value = false;
}

const cloningRepo = ref(false);

async function handleCloneRepo(url: string, destination: string) {
  cloningRepo.value = true;
  try {
    await store.cloneAndImportRepo(url, destination);
    showAddRepoModal.value = false;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(`${t('toasts.cloneFailed')}: ${msg}`);
  } finally {
    cloningRepo.value = false;
  }
}

const currentBlockers = computedAsync(async () => {
  const item = store.currentItem;
  if (!item || !hasTag(item, "blocked")) return [];
  return store.listBlockersForItem(item.id);
}, []);

async function trackCommandUsage(commandId: string) {
  const counts = { ...commandUsageCounts.value };
  counts[commandId] = (counts[commandId] || 0) + 1;
  commandUsageCounts.value = counts;
  await setSetting(db, "commandPaletteUsage", JSON.stringify(counts));
}

// Preferences update handler
async function handlePreferenceUpdate(key: string, value: string) {
  await store.savePreference(key, value);
  if (key === "locale" && ["en", "ja", "ko"].includes(value)) {
    i18n.global.locale.value = value as "en" | "ja" | "ko";
    preferences.locale = value;
  } else if (key === "suspendAfterMinutes") {
    preferences.suspendAfterMinutes = parseInt(value, 10) || 30;
  } else if (key === "killAfterMinutes") {
    preferences.killAfterMinutes = parseInt(value, 10) || 60;
  } else if (key === "ideCommand") {
    preferences.ideCommand = value;
  } else if (key === "dev.lingerTerminals") {
    preferences.devLingerTerminals = value === "true";
  } else if (key === "defaultAgentProvider") {
    preferences.defaultAgentProvider = (value === "copilot" ? "copilot" : "claude");
  }
}

// Init
onMounted(async () => {
  await store.init(db);

  // GC: async cleanup of stale done tasks, repeats hourly
  gcRef.value = useGc(db);

  // Load persisted locale
  const savedLocale = await getSetting(db, "locale");
  if (savedLocale && ["en", "ja", "ko"].includes(savedLocale)) {
    i18n.global.locale.value = savedLocale as "en" | "ja" | "ko";
    preferences.locale = savedLocale;
  }

  // Sync preferences from store
  preferences.suspendAfterMinutes = store.suspendAfterMinutes;
  preferences.killAfterMinutes = store.killAfterMinutes;
  preferences.ideCommand = store.ideCommand;
  preferences.devLingerTerminals = store.devLingerTerminals;

  const savedAgentProvider = await getSetting(db, "defaultAgentProvider");
  if (savedAgentProvider === "copilot") preferences.defaultAgentProvider = "copilot";

  startPeriodicBackup(dbName, ref(db) as Ref<DbHandle | null>);
  if (!store.hideShortcutsOnStartup) {
    shortcutsStartFull.value = true;
    showShortcutsModal.value = true;
  }
  const raw = await getSetting(db, "commandPaletteUsage");
  if (raw) {
    try { commandUsageCounts.value = JSON.parse(raw); }
    catch (e) { console.error("[App] corrupt commandPaletteUsage setting:", e); }
  }

  document.addEventListener("file-link-activate", (e: Event) => {
    const detail = (e as CustomEvent).detail as { path: string; line?: number };
    previewFilePath.value = detail.path;
    previewInitialLine.value = detail.line;
    showFilePreviewModal.value = true;
  });
});
</script>

<template>
  <div class="app">
    <Sidebar
      ref="sidebarRef"
      v-if="!maximized && !sidebarHidden"
      :repos="store.repos"
      :pipeline-items="store.items"
      :selected-repo-id="store.selectedRepoId"
      :selected-item-id="store.selectedItemId"
      :blocker-names="sidebarBlockerNames"
      @select-repo="store.selectRepo"
      @select-item="handleSelectItem"
      @new-task="(repoId: string) => { store.selectedRepoId = repoId; showNewTaskModal = true; }"
      @pin-item="store.pinItem"
      @unpin-item="store.unpinItem"
      @reorder-pinned="store.reorderPinned"
      @rename-item="store.renameItem"
      @rename-done="focusAgentTerminal"
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
      :default-agent-provider="preferences.defaultAgentProvider"
      @submit="handleNewTaskSubmit"
      @cancel="showNewTaskModal = false"
    />
    <AddRepoModal
      v-if="showAddRepoModal"
      :initial-tab="addRepoInitialTab"
      :cloning="cloningRepo"
      @create="handleCreateRepo"
      @import="handleImportRepo"
      @clone="handleCloneRepo"
      @cancel="showAddRepoModal = false"
    />
    <CommandPaletteModal
      v-if="showCommandPalette"
      :extra-commands="paletteExtraCommands"
      :dynamic-commands="paletteDynamicCommands"
      :usage-counts="commandUsageCounts"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
      @use="trackCommandUsage"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      :context="shortcutsContext"
      :start-in-full-mode="shortcutsStartFull"
      :hide-on-startup="store.hideShortcutsOnStartup"
      @close="showShortcutsModal = false"
      @update:hide-on-startup="(val: boolean) => store.savePreference('hideShortcutsOnStartup', String(val))"
      @update:full-mode="shortcutsStartFull = $event"
    />
    <KeepAlive :max="10">
      <ShellModal
        ref="shellModalRef"
        v-if="showShellModal && store.selectedRepo && (shellRepoRoot || store.currentItem)"
        :key="`shell-${shellRepoRoot ? `repo-${store.selectedRepo.id}` : `wt-${store.currentItem?.id}`}`"
        :session-id="`shell-${shellRepoRoot ? `repo-${store.selectedRepo.id}` : `wt-${store.currentItem?.id}`}`"
        :cwd="shellRepoRoot ? store.selectedRepo.path : (store.currentItem?.branch ? `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}` : store.selectedRepo.path)"
        :port-env="shellRepoRoot ? undefined : store.currentItem?.port_env"
        :maximized="maximizedModal === 'shell'"
        @close="showShellModal = false; maximizedModal = null"
      />
    </KeepAlive>
    <DiffModal
      ref="diffModalRef"
      v-if="showDiffModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      :initial-scope="store.currentItem ? diffScopes.get(store.currentItem.id) : undefined"
      :base-ref="store.currentItem?.base_ref ?? undefined"
      :maximized="maximizedModal === 'diff'"
      @scope-change="(s: 'branch' | 'commit' | 'working') => { if (store.currentItem) diffScopes.set(store.currentItem.id, s); }"
      @close="showDiffModal = false; maximizedModal = null"
    />
    <CommitGraphModal
      ref="commitGraphModalRef"
      v-if="showCommitGraphModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      @close="showCommitGraphModal = false"
    />
    <FilePickerModal
      v-if="showFilePickerModal && store.selectedRepo?.path"
      :worktree-path="activeWorktreePath"
      @close="showFilePickerModal = false"
      @select="(f: string) => { showFilePickerModal = false; previewFilePath = f; previewInitialLine = undefined; showFilePreviewModal = true; }"
    />
    <TreeExplorerModal
      ref="treeExplorerRef"
      v-if="showTreeExplorer && store.selectedRepo?.path"
      :worktree-path="activeWorktreePath"
      :repo-root="activeWorktreePath"
      :suspended="showFilePreviewModal"
      @close="showTreeExplorer = false"
      @open-file="(f: string) => { previewFilePath = f; previewInitialLine = undefined; showFilePreviewModal = true; }"
    />
    <FilePreviewModal
      ref="filePreviewRef"
      v-if="showFilePreviewModal && store.selectedRepo?.path"
      :file-path="previewFilePath"
      :worktree-path="activeWorktreePath"
      :ide-command="store.ideCommand"
      :initial-line="previewInitialLine"
      :maximized="maximizedModal === 'file'"
      @close="showFilePreviewModal = false; maximizedModal = null"
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
      :title="blockerSelectMode === 'block' ? $t('app.selectBlockingTasks') : $t('app.editBlockingTasks')"
      @confirm="onBlockerConfirm"
      @cancel="showBlockerSelect = false"
    />
    <PreferencesPanel
      v-if="showPreferencesPanel"
      ref="preferencesRef"
      :preferences="preferences"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
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
