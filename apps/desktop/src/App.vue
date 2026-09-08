<script setup lang="ts">
import { computed, inject, toRef, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { type BlockerDisplayItem, type DbHandle } from "./types/kanna";
import type { TaskUiSlot } from "./types/taskUi";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import AppModalLayer from "./components/AppModalLayer.vue";
import type { AppModalLayerController } from "./components/AppModalLayer.types";
import type { MainTabViewsController } from "./components/MainPanel.types";
import { type KeyboardActions } from "./composables/useKeyboardShortcuts";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { useRepoCommands } from "./composables/useRepoCommands";
import { useToast } from "./composables/useToast";
import { useAppUpdate } from "./composables/useAppUpdate";
import { useAppCloudWorkspace } from "./composables/useAppCloudWorkspace";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import { useAppModals } from "./composables/useAppModals";
import {
  mainTabScopeKeyForApp,
  mainTabScopeKeyForRepo,
  mainTabScopeKeyForTask,
  useMainTabs,
} from "./composables/useMainTabs";
import { useAppPreferences } from "./composables/useAppPreferences";
import { useAppTaskTransfer } from "./composables/useAppTaskTransfer";
import { useTransferFailureToasts } from "./composables/useTransferFailureToasts";
import { useAppTaskNavigation } from "./composables/useAppTaskNavigation";
import { useAppTaskCreation } from "./composables/useAppTaskCreation";
import { useAppKeyboardActions } from "./composables/useAppKeyboardActions";
import { useKannaStore } from "./stores/kanna";
import { useThemeRuntime } from "./theme/runtime";
import { type WindowWorkspaceController } from "./windowWorkspace";

const isMobile = __KANNA_MOBILE__;

const store = useKannaStore();
const toast = useToast();
const { t } = useI18n();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;
const windowWorkspace = inject<WindowWorkspaceController>("windowWorkspace")!;
const { catalog: repoCommandCatalog, scan: scanRepoCommands } = useRepoCommands();
const { effectiveAppTheme } = useThemeRuntime();
const appUpdate = useAppUpdate();
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);
store.attachWindowWorkspace(windowWorkspace);
const {
  desktopAuthSession,
  cloudSnapshot,
  lanSnapshot,
  transferMachines,
  selectedCloudRepoId,
  selectedCloudItemId,
  remoteSnapshot,
  remoteTaskDiagnostics,
  workspaceTasksByItemId,
  workspaceBlockers,
  sidebarRepos,
  sidebarItems,
  mainPanelRepo,
  mainPanelItem,
  mainPanelIsCloudTask,
  selectedWorkspaceTask,
  selectedRemoteBlockers,
  selectedRemoteTaskIsBlocked,
  mainPanelCloudTerminalRef,
  isCloudOnlyRepoId,
  cloudRepoRemoteUrl,
  refreshLanTasks,
  __e2eInjectRemoteSnapshot,
  __e2eFailNextRemoteAction,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  markTransferSidecarReady,
  refreshCloudTransferRoute,
  updateLanTransferPeers,
  closeSelectedWorkspaceTask: closeSelectedWorkspaceTaskRaw,
  advanceSelectedRemoteWorkspaceTask,
  pinSidebarTask,
  unpinSidebarTask,
  reorderPinnedSidebarTasks,
  disposeDesktopCloudWorkspace,
} = useAppCloudWorkspace({ db, store, toast, windowWorkspace });
if (import.meta.env.DEV) {
  void desktopAuthSession;
  void cloudSnapshot;
  void lanSnapshot;
  void __e2eInjectRemoteSnapshot;
  void __e2eFailNextRemoteAction;
}

const mainPanelUiSlot = computed<TaskUiSlot | null>(() => {
  const selectedId = selectedCloudItemId.value ?? store.selectedItemId;
  const localSlot = store.currentTaskSlot;
  if (
    localSlot
    && (
      selectedId === localSlot.slot_id
      || (localSlot.task_id !== null && selectedId === localSlot.task_id)
    )
  ) {
    return localSlot;
  }

  const item = mainPanelItem.value;
  if (!selectedId || !item) return null;
  const sidebarRow = sidebarItems.value.find((candidate) => candidate.slot_id === selectedId)
    ?? sidebarItems.value.find((candidate) =>
      candidate.repo_id === item.repo_id && candidate.task_id === selectedId,
    )
    ?? sidebarItems.value.find((candidate) =>
      candidate.repo_id === item.repo_id && candidate.task_id === item.id,
    );
  if (!sidebarRow || sidebarRow.state !== "ready") return null;

  return {
    slot_id: sidebarRow.slot_id,
    task_id: sidebarRow.task_id,
    state: "ready",
    task: item,
    draft: {
      repo_id: item.repo_id,
      prompt: item.prompt ?? "",
      display_name: item.display_name,
      workflow: item.pipeline,
      stage: item.stage,
      agent_type: item.agent_type === "agent" || item.agent_type === "sdk" ? "agent" : "pty",
      agent_provider: item.agent_provider,
      created_at: item.created_at,
    },
  };
});

async function reorderSidebarRepos(orderedIds: string[]): Promise<void> {
  const reposById = new Map(sidebarRepos.value.map((repo) => [repo.id, repo]));
  await store.reorderRepos(orderedIds.map((id) => ({
    id,
    remoteUrlHash: reposById.get(id)?.remote_url_hash ?? null,
  })));
}

const selectedSidebarSlotId = computed(() => {
  const selectedId = selectedCloudItemId.value ?? store.selectedItemId;
  if (!selectedId) return null;

  const direct = sidebarItems.value.find((item) => item.slot_id === selectedId);
  if (direct) return direct.slot_id;

  const workspaceTask = selectedWorkspaceTask.value
    ?? workspaceTasksByItemId.value.get(selectedId)
    ?? null;
  if (workspaceTask) {
    const retainedPresentation = sidebarItems.value.find((item) =>
      workspaceTasksByItemId.value.get(item.slot_id) === workspaceTask,
    );
    if (retainedPresentation) return retainedPresentation.slot_id;
  }

  return sidebarItems.value.find((item) => item.task_id === selectedId)?.slot_id
    ?? selectedId;
});

defineExpose({
  cloudSnapshot,
  lanSnapshot,
  refreshLanTasks,
});

// Tabs belong to the task the main panel is actually showing — the same slot
// that decides what the agent tab renders — so the tab bar and the views its
// shortcuts open can never disagree about which task they belong to. With no
// task on screen the repository owns the tab set instead: a commit graph or a
// repo-root shell is the repository's, not whichever task happened to be
// selected when it was opened.
const mainTabScopeKey = computed(() => {
  const task = mainPanelUiSlot.value?.task;
  if (task) return mainTabScopeKeyForTask(task.id);
  const repoId = selectedCloudRepoId.value ?? store.selectedRepoId;
  return repoId ? mainTabScopeKeyForRepo(repoId) : mainTabScopeKeyForApp();
});

/**
 * An agent asked this desktop to show a file. It lands in that task's own tab
 * set, whether or not this window is currently on that task: the operator's
 * selection is theirs, and the tab is simply waiting when they look.
 */
function openTaskFileView(taskId: string, filePath: string, line?: number): void {
  mainTabs.openTabInScope(mainTabScopeKeyForTask(taskId), {
    kind: "file",
    filePath,
    initialLine: line,
  });
}
const mainTabs = useMainTabs({
  scopeKey: mainTabScopeKey,
  onTabClosed: (tab) => {
    // A torn-off window restored its view from a tear-off context; closing
    // that view is what tells the window it came from to stop counting it.
    if (tab.kind === "tree" || tab.kind === "diff") {
      appModals.finishTransferredModal(tab.kind);
    }
    mainPanelRef.value?.onTabClosed?.(tab);
  },
});
const appModals = useAppModals({
  isMobile,
  store,
  windowWorkspace,
  selectedWorkspaceTask,
  mainTabs,
});
const {
  showNewTaskModal,
  availableWorkflows,
  defaultWorkflowName,
  availableBaseBranches,
  defaultBaseBranchName,
  repoDefaultBranchName,
  showAddRepoModal,
  addRepoInitialTab,
  showShortcutsModal,
  shortcutsStartFull,
  shortcutsContext,
  showFilePickerModal,
  homePath,
  showCommandPalette,
  showBlockerSelect,
  blockerSelectMode,
  showPeerPicker,
  sidebarHidden,
  maximizedModal,
  maximized,
  sidebarRef,
  mainPanelRef,
  sidebarShellStyle,
  canResizeSidebar,
  stopSidebarResize,
  startSidebarResize,
  restoreSidebarWidth,
  restoreTransferredModal,
  currentShortcutContext,
  closeFilePicker,
  showFilePickerOnTop,
  openFilePreview,
  openImageUrlPreview,
  getCurrentPreviewRecall,
} = appModals;
// Maximizing is a property of the main content area, so it cannot outlive
// having something in it: closing the last tab of a scope with no agent
// session would otherwise leave a hidden sidebar over an empty panel.
watch(
  () => mainTabs.activeTabId.value,
  (activeTabId) => {
    if (!activeTabId) maximizedModal.value = null;
  },
);

// A transfer that fails is server-side news now, so the window learns about it
// from the snapshot rather than from a call that threw.
useTransferFailureToasts(
  toRef(store, "items"),
  toast.error,
  () => t("toasts.transferFinalizationFailed"),
);
const appTaskTransfer = useAppTaskTransfer({
  store,
  toast,
  showPeerPicker,
  transferMachines,
  refreshCloudTransferRoute,
  onLanTransferPeersChanged: updateLanTransferPeers,
});
const {
  warmTransferSidecar,
  openPeerPicker,
  openPairPeerPicker,
  closePeerPicker,
} = appTaskTransfer;
async function warmCloudTransferSidecar(): Promise<void> {
  await warmTransferSidecar();
  await markTransferSidecarReady();
}
const appPreferences = useAppPreferences({
  db,
  store,
  effectiveAppTheme,
});
const {
  preferences,
  commandUsageCounts,
  trackAgentChoiceUsage,
  startSystemThemeListener,
  stopSystemThemeListener,
} = appPreferences;
const sidebarTaskBlockers = computed(() => [
  ...store.taskBlockers,
  ...workspaceBlockers.value.taskBlockers,
]);
const sidebarBlockerTaskStates = computed(() => ({
  ...store.blockerTaskStates,
  ...workspaceBlockers.value.blockerTaskStates,
}));
const appTaskNavigation = useAppTaskNavigation({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRef,
  sidebarRepos,
  sidebarItems,
  taskBlockers: sidebarTaskBlockers,
  blockerTaskStates: sidebarBlockerTaskStates,
  workspaceTasksByItemId,
  selectedCloudRepoId,
  selectedCloudItemId,
  showBlockerSelect,
  blockerSelectMode,
  repoCommandCatalog,
  openPeerPicker,
  openPairPeerPicker,
  pullSelectedWorkspaceTask: appTaskTransfer.pullSelectedWorkspaceTask,
});
function closeSelectedWorkspaceTask(): Promise<boolean> {
  return closeSelectedWorkspaceTaskRaw(
    appTaskNavigation.prepareReplacementAfterItemRemoval,
  );
}
const {
  navigateItems,
  navigateRepos,
  navigateBack,
  navigateForward,
  selectReadTask,
  selectUnreadTaskWithReadFallback,
  handleBlockTask,
  handleEditBlockedTask,
  sidebarBlockerNames: localSidebarBlockerNames,
  handleSelectRepo,
  selectSidebarItemById,
} = appTaskNavigation;
function workspaceBlockerName(blocker: BlockerDisplayItem): string {
  return blocker.display_name
    || blocker.issue_title
    || (blocker.prompt ? blocker.prompt.slice(0, 30) : null)
    || (blocker.fallback_task_id
      ? t("tasks.taskId", { id: blocker.fallback_task_id })
      : t("tasks.untitled"));
}
const workspaceSidebarBlockerNames = computed(() => Object.fromEntries(
  Object.entries(workspaceBlockers.value.blockersByPresentationTaskId)
    .map(([taskId, blockers]) => [
      taskId,
      blockers.map(workspaceBlockerName).join(", "),
    ]),
));
const sidebarBlockerNames = computed(() => ({
  ...localSidebarBlockerNames.value,
  ...workspaceSidebarBlockerNames.value,
}));
const appTaskCreation = useAppTaskCreation({
  store,
  toast,
  t,
  sidebarRepos,
  remoteSnapshot,
  mainPanelIsCloudTask,
  selectedCloudRepoId,
  selectedCloudItemId,
  showNewTaskModal,
  availableWorkflows,
  defaultWorkflowName,
  availableBaseBranches,
  defaultBaseBranchName,
  repoDefaultBranchName,
  showAddRepoModal,
  isCloudOnlyRepoId,
  cloudRepoRemoteUrl,
  onAgentChoiceUsed: trackAgentChoiceUsage,
});
const {
  currentBlockers,
  currentTaskIsBlocked,
  openNewTaskModal,
} = appTaskCreation;
const mainPanelBlockers = computed(() =>
  mainPanelIsCloudTask.value ? selectedRemoteBlockers.value : currentBlockers.value,
);
const mainPanelTaskIsBlocked = computed(() =>
  mainPanelIsCloudTask.value
    ? selectedRemoteTaskIsBlocked.value
    : currentTaskIsBlocked.value,
);

const mainTabViews: MainTabViewsController = {
  tabs: mainTabs,
  modals: appModals,
  preferences: appPreferences,
  store,
};

let keyboardActions = {} as KeyboardActions;
const {
  fatalInitializationError,
  focusAgentTerminal,
  requestCloseCurrentWindow,
} = useAppLifecycle({
  appUpdate,
  commandUsageCounts,
  db,
  dbName,
  disposeDesktopCloudWorkspace,
  getKeyboardActions: () => keyboardActions,
  homePath,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  openFilePreview,
  openImageUrlPreview,
  openTaskFileView,
  preferences,
  remoteTaskDiagnostics,
  restoreSidebarWidth,
  restoreTransferredModal,
  shortcutsStartFull,
  showShortcutsModal,
  startSystemThemeListener,
  stopSidebarResize,
  stopSystemThemeListener,
  store,
  toast,
  warmTransferSidecar: warmCloudTransferSidecar,
  windowWorkspace,
});
const appKeyboardActions = useAppKeyboardActions({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRepos,
  selectedWorkspaceTask,
  selectedWorkspaceTaskBlocked: selectedRemoteTaskIsBlocked,
  currentShortcutContext,
  mainTabs,
  mainPanelRef,
  showNewTaskModal,
  showAddRepoModal,
  addRepoInitialTab,
  showShortcutsModal,
  shortcutsStartFull,
  shortcutsContext,
  showFilePickerModal,
  showCommandPalette,
  showPeerPicker,
  maximizedModal,
  sidebarHidden,
  sidebarRef,
  openNewTaskModal,
  requestCloseCurrentWindow,
  showFilePickerOnTop,
  getCurrentPreviewRecall,
  openFilePreview,
  advanceSelectedRemoteWorkspaceTask,
  closeSelectedWorkspaceTask,
  navigateItems,
  navigateBack,
  navigateForward,
  selectUnreadTaskWithReadFallback,
  selectReadTask,
  navigateRepos,
  closePeerPicker,
  closeFilePicker,
  scanRepoCommands,
  handleBlockTask,
  handleEditBlockedTask,
});
keyboardActions = appKeyboardActions.keyboardActions;
const modalLayerController = {
  isMobile,
  db,
  store,
  appUpdate,
  appKeyboardActions,
  appModals,
  appPreferences,
  appTaskCreation,
  appTaskNavigation,
  appTaskTransfer,
  getKeyboardActions: () => keyboardActions,
} satisfies AppModalLayerController;
</script>

<template>
  <main
    v-if="fatalInitializationError"
    class="fatal-initialization-error"
    data-testid="fatal-initialization-error"
    role="alert"
  >
    <h1>Kanna couldn't start safely</h1>
    <p>{{ fatalInitializationError }}</p>
  </main>
  <div v-else class="app" :class="{ mobile: isMobile }">
    <div
      v-if="!maximized && !sidebarHidden && (!isMobile || !store.selectedItemId)"
      class="sidebar-shell"
      :style="sidebarShellStyle"
      data-testid="sidebar-shell"
    >
      <Sidebar
        ref="sidebarRef"
        :repos="sidebarRepos"
        :task-slots="sidebarItems"
        :selected-repo-id="store.selectedRepoId"
        :selected-slot-id="selectedSidebarSlotId"
        :blocker-names="sidebarBlockerNames"
        :task-blockers="sidebarTaskBlockers"
        :blocker-task-states="sidebarBlockerTaskStates"
        @select-repo="handleSelectRepo"
        @select-item="selectSidebarItemById"
        @new-task="(repoId: string) => openNewTaskModal(repoId).catch((e) => console.error('[App] openNewTaskModal failed:', e))"
        @pin-item="pinSidebarTask"
        @unpin-item="unpinSidebarTask"
        @reorder-pinned="reorderPinnedSidebarTasks"
        @set-parent="store.setTaskParent"
        @rename-item="store.renameItem"
        @rename-done="focusAgentTerminal"
        @hide-repo="store.hideRepo"
        @rename-repo="store.renameRepo"
        @reorder-repos="reorderSidebarRepos"
      />
      <div
        v-if="canResizeSidebar"
        class="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        data-testid="sidebar-resize-handle"
        @pointerdown="startSidebarResize"
      />
    </div>
    <div v-if="!isMobile || store.selectedItemId" class="main-column">
      <MainPanel
        ref="mainPanelRef"
        :ui-slot="mainPanelUiSlot"
        :views="mainTabViews"
        :repo-path="mainPanelRepo?.path"
        :spawn-pty-session="store.spawnPtySession"
        :recover-task-session="store.recoverTaskSession"
        :maximized="maximized"
        :blockers="mainPanelBlockers"
        :blocked="mainPanelTaskIsBlocked"
        :has-repos="sidebarRepos.length > 0"
        :cloud-task="mainPanelIsCloudTask"
        :cloud-terminal-ref="mainPanelCloudTerminalRef"
        :request-revision="store.requestRevision"
        @close-task="closeSelectedWorkspaceTask"
        @back="store.selectedItemId = null"
      />
    </div>

    <AppModalLayer :controller="modalLayerController" />
  </div>
</template>

<style>
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
.fatal-initialization-error {
  display: flex;
  height: 100%;
  width: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px;
  background: var(--kn-bg-app);
  color: var(--kn-text-primary);
  text-align: center;
}
.fatal-initialization-error p {
  max-width: 560px;
  color: var(--kn-text-secondary);
}
.sidebar-shell {
  position: relative;
  flex: 0 0 auto;
  height: 100%;
  min-height: 0;
}
.sidebar-shell :deep(.sidebar) {
  width: 100%;
  min-width: 0;
  max-width: none;
}
.sidebar-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.sidebar-resize-handle::after {
  content: "";
  position: absolute;
  top: 0;
  right: 2px;
  width: 1px;
  height: 100%;
  background: transparent;
}

.sidebar-resize-handle:hover::after,
.sidebar-resize-handle:focus-visible::after {
  background: var(--kn-accent);
}

:global(body.is-resizing-sidebar) {
  cursor: col-resize;
  user-select: none;
}

.main-column {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .app {
    flex-direction: column;
  }
}

.app.mobile {
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

.app.mobile :deep(.sidebar) {
  width: 100%;
  max-width: none;
  height: 100%;
  border-right: none;
}

.app.mobile .sidebar-shell {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100%;
}

.app.mobile .main-panel {
  width: 100%;
  height: 100%;
}

.app.mobile .main-column {
  width: 100%;
  height: 100%;
}
</style>
