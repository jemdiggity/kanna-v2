<script setup lang="ts">
import { computed, inject, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { type AgentProvider, type DbHandle } from "@kanna/db";
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
import PeerPickerModal from "./components/PeerPickerModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import AppUpdatePrompt from "./components/AppUpdatePrompt.vue";
import ToastContainer from "./components/ToastContainer.vue";
import { type ActionName, type KeyboardActions } from "./composables/useKeyboardShortcuts";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useAppUpdate } from "./composables/useAppUpdate";
import { useAppCloudWorkspace } from "./composables/useAppCloudWorkspace";
import { useAppLifecycle } from "./composables/useAppLifecycle";
import {
  useAppModals,
  type DiffScope,
  type DiffScrollPositions,
  type BranchInclude,
} from "./composables/useAppModals";
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
    provider === "claude" || provider === "copilot" || provider === "codex" || provider === "opencode"
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
  previewFilePath,
  previewInitialLine,
  previewHidden,
  previewFromPicker,
  previewFromTree,
  showDiffModal,
  showTreeExplorer,
  activeWorktreePath,
  homePath,
  treeExplorerRoot,
  showShellModal,
  shellRepoRoot,
  shellModalCwd,
  shellModalFallbackCwd,
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
  currentDiffViewKey,
  currentDiffViewState,
  updateCurrentDiffViewState,
  currentPreviewMarkdownMode,
  updateCurrentPreviewMarkdownMode,
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
  selectFileFromPicker,
  closeFilePreview,
  getCurrentPreviewRecall,
} = useAppModals({ isMobile, store, windowWorkspace });
const {
  peerPickerMode,
  transferPeers,
  transferPeersLoading,
  transferPeerActionPending,
  warmTransferSidecar,
  openPeerPicker,
  openPairPeerPicker,
  closePeerPicker,
  handlePeerSelected,
  handlePairPeer,
  importPendingIncomingTransfers,
} = useAppTaskTransfer({ db, store, toast, showPeerPicker });
const {
  preferences,
  commandUsageCounts,
  startSystemThemeListener,
  stopSystemThemeListener,
  trackCommandUsage,
  handlePreferenceUpdate,
} = useAppPreferences({
  db,
  store,
  effectiveAppTheme,
  firstSupportedAgentProvider,
});
const {
  navigateItems,
  navigateRepos,
  selectReadTask,
  selectUnreadTaskWithReadFallback,
  handleBlockTask,
  handleEditBlockedTask,
  blockerCandidates,
  disabledBlockerIds,
  preselectedBlockerIds,
  sidebarBlockerNames,
  onBlockerConfirm,
  paletteExtraCommands,
  paletteDynamicCommands,
  handleSelectRepo,
  handleSelectItem,
} = useAppTaskNavigation({
  store,
  toast,
  t,
  windowWorkspace,
  sidebarRef,
  sidebarRepos,
  sidebarItems,
  mainPanelItem,
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
  cloningRepo,
  currentBlockers,
  openNewTaskModal,
  handleNewTaskSubmit,
  handleCreateRepo,
  handleImportRepo,
  handleCloneRepo,
} = useAppTaskCreation({
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

    <NewTaskModal
      v-if="showNewTaskModal"
      :default-agent-provider="preferences.defaultAgentProvider"
      :pipelines="availablePipelines"
      :default-pipeline="defaultPipelineName"
      :base-branches="availableBaseBranches"
      :default-base-branch="defaultBaseBranchName"
      :default-branch-name="repoDefaultBranchName"
      @submit="(prompt, agentProvider, pipelineName, baseBranch, agentType) => handleNewTaskSubmit(prompt, agentProvider, pipelineName, baseBranch, agentType)"
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
        v-if="showShellModal && !isMobile && (store.selectedRepo ? (shellRepoRoot || store.currentItem) : shellRepoRoot)"
        :key="`shell-${shellRepoRoot && !store.selectedRepo ? 'home' : shellRepoRoot ? `repo-${store.selectedRepo!.id}` : `wt-${store.currentItem?.id}`}`"
        :session-id="`shell-${shellRepoRoot && !store.selectedRepo ? 'home' : shellRepoRoot ? `repo-${store.selectedRepo!.id}` : `wt-${store.currentItem?.id}`}`"
        :cwd="shellModalCwd"
        :fallback-cwd="shellModalFallbackCwd"
        :port-env="shellRepoRoot ? undefined : store.currentItem?.port_env"
        :maximized="maximizedModal === 'shell'"
        @close="onShellClose"
      />
    </KeepAlive>
    <DiffModal
      ref="diffModalRef"
      v-if="showDiffModal && !isMobile && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      :initial-scope="currentDiffViewState?.scope"
      :initial-scroll-positions="currentDiffViewState?.scrollPositions"
      :initial-branch-include="currentDiffViewState?.branchInclude"
      :base-ref="store.currentItem?.base_ref ?? undefined"
      :view-key="currentDiffViewKey"
      :maximized="maximizedModal === 'diff'"
      @scope-change="(scope: DiffScope) => updateCurrentDiffViewState({ scope })"
      @scroll-state-change="(scrollPositions: DiffScrollPositions) => updateCurrentDiffViewState({ scrollPositions })"
      @branch-include-change="(branchInclude: BranchInclude) => updateCurrentDiffViewState({ branchInclude })"
      @close="showDiffModal = false; maximizedModal = null"
    />
    <CommitGraphModal
      ref="commitGraphModalRef"
      v-if="showCommitGraphModal && store.selectedRepo?.path"
      :repo-path="store.selectedRepo.path"
      :worktree-path="store.currentItem?.branch ? activeWorktreePath : undefined"
      @close="showCommitGraphModal = false"
    />
    <div
      v-if="(showFilePickerModal || filePickerHidden) && !isMobile && store.selectedRepo?.path"
      v-show="showFilePickerModal"
    >
      <FilePickerModal
        ref="filePickerRef"
        :key="activeWorktreePath"
        :worktree-path="activeWorktreePath"
        :repo-root="store.selectedRepo?.path ?? ''"
        @close="closeFilePicker"
        @select="selectFileFromPicker"
      />
    </div>
    <TreeExplorerModal
      ref="treeExplorerRef"
      v-if="showTreeExplorer && treeExplorerRoot"
      :worktree-path="treeExplorerRoot"
      :repo-root="store.selectedRepo?.path ?? treeExplorerRoot"
      :home-path="homePath"
      :maximized="maximizedModal === 'tree'"
      :suspended="showFilePreviewModal && previewFromTree"
      @close="closeTreeExplorer"
      @open-file="(f: string) => openFilePreview(f, undefined, false, true)"
    />
    <FilePreviewModal
      ref="filePreviewRef"
      v-if="(showFilePreviewModal || previewHidden) && !isMobile && store.selectedRepo?.path"
      v-show="showFilePreviewModal"
      :key="`${activeWorktreePath}:${previewFilePath}`"
      :file-path="previewFilePath"
      :worktree-path="activeWorktreePath"
      :ide-command="store.ideCommand"
      :initial-line="previewInitialLine"
      :initial-markdown-mode="currentPreviewMarkdownMode"
      :maximized="maximizedModal === 'file'"
      @close="closeFilePreview(true)"
      @update-markdown-mode="updateCurrentPreviewMarkdownMode"
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
    <PeerPickerModal
      v-if="showPeerPicker"
      :peers="peerPickerMode === 'pair'
        ? transferPeers.filter((peer) => !peer.trusted)
        : transferPeers.filter((peer) => peer.trusted)"
      :loading="transferPeersLoading"
      :title="peerPickerMode === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
      :action-label="peerPickerMode === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
      :action-pending="transferPeerActionPending"
      :require-trusted="peerPickerMode !== 'pair'"
      @cancel="closePeerPicker"
      @select="(peerId) => peerPickerMode === 'pair' ? handlePairPeer(peerId) : handlePeerSelected(peerId)"
    />
    <PreferencesPanel
      v-if="showPreferencesPanel"
      ref="preferencesRef"
      :preferences="preferences"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
    />
    <AppUpdatePrompt :controller="appUpdate" />
    <ToastContainer />
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
