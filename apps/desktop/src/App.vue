<script setup lang="ts">
import { computed, inject, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { type AgentProvider, type DbHandle } from "@kanna/db";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import AppModalLayer from "./components/AppModalLayer.vue";
import type { AppModalLayerController } from "./components/AppModalLayer.types";
import { type KeyboardActions } from "./composables/useKeyboardShortcuts";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useAppUpdate } from "./composables/useAppUpdate";
import { useAppCloudWorkspace } from "./composables/useAppCloudWorkspace";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import { useAppModals } from "./composables/useAppModals";
import { useAppPreferences } from "./composables/useAppPreferences";
import { useAppTaskTransfer } from "./composables/useAppTaskTransfer";
import { useAppTaskNavigation } from "./composables/useAppTaskNavigation";
import { useAppTaskCreation } from "./composables/useAppTaskCreation";
import { useAppKeyboardActions } from "./composables/useAppKeyboardActions";
import { useKannaStore } from "./stores/kanna";
import { useThemeRuntime } from "./theme/runtime";
import { type WindowWorkspaceController } from "./windowWorkspace";

const isMobile = __KANNA_MOBILE__;

function firstSupportedAgentProvider(agentProvider: AgentProvider | AgentProvider[] | string | string[] | undefined): AgentProvider | undefined {
  const providers = Array.isArray(agentProvider) ? agentProvider : [agentProvider];
  return providers.find((provider): provider is AgentProvider =>
    provider === "claude"
    || provider === "copilot"
    || provider === "codex"
    || provider === "opencode"
    || provider === "antigravity"
  );
}

const store = useKannaStore();
const toast = useToast();
const { t } = useI18n();
const db = inject<DbHandle>("db")!;
const dbName = inject<string>("dbName")!;
const windowWorkspace = inject<WindowWorkspaceController>("windowWorkspace")!;
const { tasks: customTasks, scan: scanCustomTasks } = useCustomTasks();
const { effectiveAppTheme } = useThemeRuntime();
const appUpdate = useAppUpdate();
useOperatorEvents(computed(() => db) as unknown as Ref<DbHandle | null>);
store.attachWindowWorkspace(windowWorkspace);
const {
  selectedCloudRepoId,
  selectedCloudItemId,
  remoteSnapshot,
  remoteTaskDiagnostics,
  workspaceTasksByItemId,
  sidebarRepos,
  sidebarItems,
  mainPanelRepo,
  mainPanelItem,
  mainPanelIsCloudTask,
  selectedWorkspaceTask,
  mainPanelCloudTerminalRef,
  isCloudOnlyRepoId,
  cloudRepoRemoteUrl,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  closeSelectedWorkspaceTask,
  advanceSelectedRemoteWorkspaceTask,
  disposeDesktopCloudWorkspace,
} = useAppCloudWorkspace({ db, store, toast });

const appModals = useAppModals({ isMobile, store, windowWorkspace });
const {
  showNewTaskModal,
  availablePipelines,
  defaultPipelineName,
  availableBaseBranches,
  defaultBaseBranchName,
  repoDefaultBranchName,
  showAddRepoModal,
  addRepoInitialTab,
  showShortcutsModal,
  shortcutsStartFull,
  shortcutsContext,
  showFilePickerModal,
  filePickerHidden,
  showFilePreviewModal,
  previewHidden,
  previewFromPicker,
  previewFromTree,
  showDiffModal,
  showTreeExplorer,
  homePath,
  showShellModal,
  shellRepoRoot,
  showCommandPalette,
  showAnalyticsModal,
  showBlockerSelect,
  blockerSelectMode,
  showPeerPicker,
  showPreferencesPanel,
  sidebarHidden,
  maximizedModal,
  maximized,
  sidebarRef,
  mainPanelRef,
  shellModalRef,
  diffModalRef,
  showCommitGraphModal,
  commitGraphModalRef,
  treeExplorerRef,
  filePickerRef,
  filePreviewRef,
  preferencesRef,
  sidebarShellStyle,
  canResizeSidebar,
  stopSidebarResize,
  startSidebarResize,
  restoreSidebarWidth,
  currentShortcutContext,
  onShellClose,
  closeTreeExplorer,
  closeFileFlow,
  closeFilePicker,
  showFilePickerOnTop,
  openFilePreview,
  openImageUrlPreview,
  getCurrentPreviewRecall,
} = appModals;
const appTaskTransfer = useAppTaskTransfer({ db, store, toast, showPeerPicker });
const {
  warmTransferSidecar,
  openPeerPicker,
  openPairPeerPicker,
  closePeerPicker,
  importPendingIncomingTransfers,
} = appTaskTransfer;
const appPreferences = useAppPreferences({
  db,
  store,
  effectiveAppTheme,
  firstSupportedAgentProvider,
});
const {
  preferences,
  commandUsageCounts,
  startSystemThemeListener,
  stopSystemThemeListener,
} = appPreferences;
const appTaskNavigation = useAppTaskNavigation({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRef,
  sidebarRepos,
  sidebarItems,
  workspaceTasksByItemId,
  selectedCloudRepoId,
  selectedCloudItemId,
  showBlockerSelect,
  blockerSelectMode,
  customTasks,
  firstSupportedAgentProvider,
  openPeerPicker,
  openPairPeerPicker,
});
const {
  navigateItems,
  navigateRepos,
  selectReadTask,
  selectUnreadTaskWithReadFallback,
  handleBlockTask,
  handleEditBlockedTask,
  sidebarBlockerNames,
  handleSelectRepo,
  handleSelectItem,
} = appTaskNavigation;
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
  availablePipelines,
  defaultPipelineName,
  availableBaseBranches,
  defaultBaseBranchName,
  repoDefaultBranchName,
  showAddRepoModal,
  isCloudOnlyRepoId,
  cloudRepoRemoteUrl,
});
const {
  currentBlockers,
  openNewTaskModal,
} = appTaskCreation;

let keyboardActions = {} as KeyboardActions;
const {
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
  importPendingIncomingTransfers,
  initializeDesktopCloudAuth,
  initializeDesktopLanTaskSync,
  openFilePreview,
  openImageUrlPreview,
  preferences,
  remoteTaskDiagnostics,
  restoreSidebarWidth,
  shortcutsStartFull,
  showShortcutsModal,
  startSystemThemeListener,
  stopSidebarResize,
  stopSystemThemeListener,
  store,
  toast,
  warmTransferSidecar,
  windowWorkspace,
});
const appKeyboardActions = useAppKeyboardActions({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRepos,
  selectedWorkspaceTask,
  currentShortcutContext,
  showNewTaskModal,
  showAddRepoModal,
  addRepoInitialTab,
  showShortcutsModal,
  shortcutsStartFull,
  shortcutsContext,
  showFilePickerModal,
  filePickerHidden,
  showFilePreviewModal,
  previewHidden,
  previewFromPicker,
  previewFromTree,
  showDiffModal,
  showTreeExplorer,
  showShellModal,
  shellRepoRoot,
  showCommandPalette,
  showAnalyticsModal,
  showCommitGraphModal,
  showPeerPicker,
  showPreferencesPanel,
  maximizedModal,
  sidebarHidden,
  sidebarRef,
  shellModalRef,
  diffModalRef,
  commitGraphModalRef,
  treeExplorerRef,
  filePickerRef,
  filePreviewRef,
  preferencesRef,
  openNewTaskModal,
  requestCloseCurrentWindow,
  showFilePickerOnTop,
  getCurrentPreviewRecall,
  openFilePreview,
  closeTreeExplorer,
  advanceSelectedRemoteWorkspaceTask,
  closeSelectedWorkspaceTask,
  navigateItems,
  selectUnreadTaskWithReadFallback,
  selectReadTask,
  navigateRepos,
  closePeerPicker,
  closeFilePicker,
  closeFileFlow,
  onShellClose,
  scanCustomTasks,
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
  <div class="app" :class="{ mobile: isMobile }">
    <div
      v-if="!maximized && !sidebarHidden && (!isMobile || !store.selectedItemId)"
      class="sidebar-shell"
      :style="sidebarShellStyle"
      data-testid="sidebar-shell"
    >
      <Sidebar
        ref="sidebarRef"
        :repos="sidebarRepos"
        :pipeline-items="sidebarItems"
        :selected-repo-id="store.selectedRepoId"
        :selected-item-id="store.selectedItemId"
        :blocker-names="sidebarBlockerNames"
        @select-repo="handleSelectRepo"
        @select-item="handleSelectItem"
        @new-task="(repoId: string) => openNewTaskModal(repoId).catch((e) => console.error('[App] openNewTaskModal failed:', e))"
        @pin-item="store.pinItem"
        @unpin-item="store.unpinItem"
        @reorder-pinned="store.reorderPinned"
        @set-parent="store.setTaskParent"
        @rename-item="store.renameItem"
        @rename-done="focusAgentTerminal"
        @hide-repo="store.hideRepo"
        @rename-repo="store.renameRepo"
        @reorder-repos="store.reorderRepos"
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
        :item="mainPanelItem"
        :repo-path="mainPanelRepo?.path"
        :spawn-pty-session="store.spawnPtySession"
        :recover-task-session="store.recoverTaskSession"
        :maximized="maximized"
        :blockers="currentBlockers"
        :has-repos="sidebarRepos.length > 0"
        :pending-setup="store.currentItem ? (store.pendingSetupIds ?? []).includes(store.currentItem.id) : false"
        :cloud-task="mainPanelIsCloudTask"
        :cloud-terminal-ref="mainPanelCloudTerminalRef"
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
