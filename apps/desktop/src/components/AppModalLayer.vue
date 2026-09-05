<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";

import NewTaskModal from "./NewTaskModal.vue";
import AddRepoModal from "./AddRepoModal.vue";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal.vue";
import FilePickerModal from "./FilePickerModal.vue";
import FilePreviewModal from "./FilePreviewModal.vue";
import ImageUrlPreviewModal from "./ImageUrlPreviewModal.vue";
import TreeExplorerModal from "./TreeExplorerModal.vue";
import DiffModal from "./DiffModal.vue";
import CommitGraphModal from "./CommitGraphModal.vue";
import ShellModal from "./ShellModal.vue";
import CommandPaletteModal from "./CommandPaletteModal.vue";
import AnalyticsModal from "./AnalyticsModal.vue";
import BlockerSelectModal from "./BlockerSelectModal.vue";
import PeerPickerModal from "./PeerPickerModal.vue";
import PreferencesPanel from "./PreferencesPanel.vue";
import AppUpdatePrompt from "./AppUpdatePrompt.vue";
import ToastContainer from "./ToastContainer.vue";
import type { ActionName } from "../composables/useKeyboardShortcuts";
import type {
  BranchInclude,
  DiffScope,
  DiffScrollPositions,
} from "../composables/useAppModals";
import type { AppModalLayerController } from "./AppModalLayer.types";

const props = defineProps<{
  controller: AppModalLayerController;
}>();

const c = props.controller;
const m = c.appModals;
const preferences = c.appPreferences.preferences;

function setShellModalRef(component: Element | ComponentPublicInstance | null) {
  m.shellModalRef.value = component as InstanceType<typeof ShellModal> | null;
}

function setDiffModalRef(component: Element | ComponentPublicInstance | null) {
  m.diffModalRef.value = component as InstanceType<typeof DiffModal> | null;
}

function setCommitGraphModalRef(component: Element | ComponentPublicInstance | null) {
  m.commitGraphModalRef.value = component as InstanceType<typeof CommitGraphModal> | null;
}

function setTreeExplorerRef(component: Element | ComponentPublicInstance | null) {
  m.treeExplorerRef.value = component as InstanceType<typeof TreeExplorerModal> | null;
}

function setFilePickerRef(component: Element | ComponentPublicInstance | null) {
  m.filePickerRef.value = component as InstanceType<typeof FilePickerModal> | null;
}

function setFilePreviewRef(component: Element | ComponentPublicInstance | null) {
  m.filePreviewRef.value = component as InstanceType<typeof FilePreviewModal> | null;
}

function setImageUrlPreviewRef(component: Element | ComponentPublicInstance | null) {
  m.imageUrlPreviewRef.value = component as InstanceType<typeof ImageUrlPreviewModal> | null;
}

function setPreferencesRef(component: Element | ComponentPublicInstance | null) {
  m.preferencesRef.value = component as InstanceType<typeof PreferencesPanel> | null;
}
</script>

<template>
  <NewTaskModal
    v-if="m.showNewTaskModal.value"
    :default-agent-provider="preferences.defaultAgentProvider"
    :default-agent-type="preferences.defaultAgentType"
    :recent-agent-choices="preferences.recentAgentChoices"
    :available-agent-providers="c.appTaskCreation.availableAgentProviders.value"
    :workflows="m.availableWorkflows.value"
    :default-workflow="m.defaultWorkflowName.value"
    :base-branches="m.availableBaseBranches.value"
    :default-base-branch="m.defaultBaseBranchName.value"
    :default-branch-name="m.repoDefaultBranchName.value"
    :options-loading="c.appTaskCreation.newTaskOptionsLoading.value"
    :submission-pending="c.appTaskCreation.newTaskSubmissionPending.value"
    :blocker-candidates="c.appTaskCreation.newTaskBlockerCandidates.value"
    @submit="(prompt, agentProvider, workflowName, baseBranch, agentType, blockerTaskIds) => c.appTaskCreation.handleNewTaskSubmit(prompt, agentProvider, workflowName, baseBranch, agentType, blockerTaskIds)"
    @cancel="m.showNewTaskModal.value = false"
  />
  <AddRepoModal
    v-if="m.showAddRepoModal.value"
    :initial-tab="m.addRepoInitialTab.value"
    :cloning="c.appTaskCreation.cloningRepo.value"
    @create="c.appTaskCreation.handleCreateRepo"
    @import="c.appTaskCreation.handleImportRepo"
    @clone="c.appTaskCreation.handleCloneRepo"
    @cancel="m.showAddRepoModal.value = false"
  />
  <CommandPaletteModal
    v-if="m.showCommandPalette.value"
    :extra-commands="c.appTaskNavigation.paletteExtraCommands.value"
    :dynamic-commands="c.appTaskNavigation.paletteDynamicCommands.value"
    :usage-counts="c.appPreferences.commandUsageCounts.value"
    @close="m.showCommandPalette.value = false"
    @execute="(action: ActionName) => c.getKeyboardActions()[action]()"
    @use="c.appPreferences.trackCommandUsage"
  />
  <KeyboardShortcutsModal
    v-if="m.showShortcutsModal.value"
    :context="m.shortcutsContext.value"
    :start-in-full-mode="m.shortcutsStartFull.value"
    :hide-on-startup="c.store.hideShortcutsOnStartup"
    @close="m.showShortcutsModal.value = false"
    @update:hide-on-startup="(val: boolean) => c.store.savePreference('hideShortcutsOnStartup', String(val))"
    @update:full-mode="m.shortcutsStartFull.value = $event"
  />
  <KeepAlive :max="10">
    <ShellModal
      :ref="setShellModalRef"
      v-if="m.showShellModal.value && !c.isMobile && (c.store.selectedRepo ? (m.shellRepoRoot.value || c.store.currentItem) : m.shellRepoRoot.value)"
      :key="`shell-${m.shellRepoRoot.value && !c.store.selectedRepo ? 'home' : m.shellRepoRoot.value ? `repo-${c.store.selectedRepo!.id}` : `wt-${c.store.currentItem?.id}`}`"
      :session-id="`shell-${m.shellRepoRoot.value && !c.store.selectedRepo ? 'home' : m.shellRepoRoot.value ? `repo-${c.store.selectedRepo!.id}` : `wt-${c.store.currentItem?.id}`}`"
      :cwd="m.shellModalCwd.value"
      :fallback-cwd="m.shellModalFallbackCwd.value"
      :port-env="m.shellRepoRoot.value ? undefined : c.store.currentItem?.port_env"
      :maximized="m.maximizedModal.value === 'shell'"
      @close="m.onShellClose"
    />
  </KeepAlive>
  <DiffModal
    :ref="setDiffModalRef"
    v-if="m.showDiffModal.value && !c.isMobile && (m.activeRepoPath.value || m.activeTaskViewIsRemote.value)"
    :repo-path="m.activeRepoPath.value || ''"
    :worktree-path="m.activeDiffWorktreePath.value"
    :initial-scope="m.currentDiffViewState.value?.scope"
    :initial-scroll-positions="m.currentDiffViewState.value?.scrollPositions"
    :initial-branch-include="m.currentDiffViewState.value?.branchInclude"
    :base-ref="m.transferredDiffContext.value?.baseRef ?? m.activeTask.value?.base_ref ?? undefined"
    :view-key="m.currentDiffViewKey.value"
    :maximized="m.maximizedModal.value === 'diff'"
    :remote-diff-loader="m.activeTaskViewIsRemote.value ? m.readRemoteTaskDiff : undefined"
    :remote-desktop-id="m.activeRemoteTaskRoute.value?.desktopId"
    :remote-task-id="m.activeRemoteTaskRoute.value?.taskId"
    :remote-transport="m.activeRemoteTaskRoute.value?.transport"
    @scope-change="(scope: DiffScope) => m.updateCurrentDiffViewState({ scope })"
    @scroll-state-change="(scrollPositions: DiffScrollPositions) => m.updateCurrentDiffViewState({ scrollPositions })"
    @branch-include-change="(branchInclude: BranchInclude) => m.updateCurrentDiffViewState({ branchInclude })"
    @close="m.closeDiffModal"
  />
  <CommitGraphModal
    :ref="setCommitGraphModalRef"
    v-if="m.showCommitGraphModal.value && c.store.selectedRepo?.path"
    :repo-path="c.store.selectedRepo.path"
    :worktree-path="c.store.currentItem?.branch ? m.activeWorktreePath.value : undefined"
    @close="m.showCommitGraphModal.value = false"
  />
  <div
    v-if="(m.showFilePickerModal.value || m.filePickerHidden.value) && !c.isMobile && c.store.selectedRepo?.path"
    v-show="m.showFilePickerModal.value"
  >
    <FilePickerModal
      :ref="setFilePickerRef"
      :key="m.activeWorktreePath.value"
      :worktree-path="m.activeWorktreePath.value"
      :repo-root="c.store.selectedRepo?.path ?? ''"
      @close="m.closeFilePicker"
      @select="m.selectFileFromPicker"
    />
  </div>
  <TreeExplorerModal
    :ref="setTreeExplorerRef"
    v-if="m.showTreeExplorer.value && m.treeExplorerRoot.value"
    :worktree-path="m.treeExplorerRoot.value"
    :repo-root="m.activeRepoPath.value || m.treeExplorerRoot.value"
    :home-path="m.homePath.value"
    :maximized="m.maximizedModal.value === 'tree'"
    :suspended="m.showFilePreviewModal.value && m.previewFromTree.value"
    :remote-directory-loader="m.activeTaskViewIsRemote.value ? m.listRemoteTaskDirectory : undefined"
    :remote-desktop-id="m.activeRemoteTaskRoute.value?.desktopId"
    :remote-task-id="m.activeRemoteTaskRoute.value?.taskId"
    :remote-transport="m.activeRemoteTaskRoute.value?.transport"
    @close="m.closeTreeExplorer"
    @open-file="(f: string) => m.openFilePreview(f, undefined, false, true)"
  />
  <FilePreviewModal
    :ref="setFilePreviewRef"
    v-if="(m.showFilePreviewModal.value || m.previewHidden.value) && !c.isMobile && (m.activeRepoPath.value || m.activeTaskViewIsRemote.value || m.previewRemoteContent.value !== null)"
    v-show="m.showFilePreviewModal.value"
    :key="`${m.activeWorktreePath.value}:${m.previewFilePath.value}`"
    :file-path="m.previewFilePath.value"
    :worktree-path="m.activeWorktreePath.value"
    :remote-content="m.previewRemoteContent.value"
    :remote-content-loader="m.activeTaskViewIsRemote.value ? m.readRemoteTaskFile : undefined"
    :ide-command="c.store.ideCommand"
    :initial-line="m.previewInitialLine.value"
    :initial-markdown-mode="m.currentPreviewMarkdownMode.value"
    :maximized="m.maximizedModal.value === 'file'"
    @close="m.closeFilePreview(true)"
    @update-markdown-mode="m.updateCurrentPreviewMarkdownMode"
  />
  <ImageUrlPreviewModal
    :ref="setImageUrlPreviewRef"
    v-if="m.showImageUrlPreviewModal.value && !c.isMobile"
    :image-url="m.previewImageUrl.value"
    @close="m.closeImageUrlPreview"
  />
  <AnalyticsModal
    v-if="m.showAnalyticsModal.value"
    :repo-id="c.store.selectedRepoId"
    @close="m.showAnalyticsModal.value = false"
  />
  <BlockerSelectModal
    v-if="m.showBlockerSelect.value"
    :candidates="c.appTaskNavigation.blockerCandidates.value"
    :disabled-ids="c.appTaskNavigation.disabledBlockerIds.value"
    :preselected="m.blockerSelectMode.value === 'edit' ? c.appTaskNavigation.preselectedBlockerIds.value : undefined"
    :title="m.blockerSelectMode.value === 'block' ? $t('app.selectBlockingTasks') : $t('app.editBlockingTasks')"
    @confirm="c.appTaskNavigation.onBlockerConfirm"
    @cancel="m.showBlockerSelect.value = false"
  />
  <PeerPickerModal
    v-if="m.showPeerPicker.value"
    :peers="c.appTaskTransfer.peerPickerMode.value === 'pair'
      ? c.appTaskTransfer.transferPeers.value.filter((peer) => !peer.trusted)
      : c.appTaskTransfer.transferPeers.value.filter((peer) => peer.trusted)"
    :loading="c.appTaskTransfer.transferPeersLoading.value"
    :title="c.appTaskTransfer.peerPickerMode.value === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
    :action-label="c.appTaskTransfer.peerPickerMode.value === 'pair' ? $t('taskTransfer.pairPeer') : $t('taskTransfer.pushToMachine')"
    :action-pending="c.appTaskTransfer.transferPeerActionPending.value"
    :require-trusted="c.appTaskTransfer.peerPickerMode.value !== 'pair'"
    @cancel="c.appTaskTransfer.closePeerPicker"
    @select="(peerId) => c.appTaskTransfer.peerPickerMode.value === 'pair' ? c.appTaskTransfer.handlePairPeer(peerId) : c.appTaskTransfer.handlePeerSelected(peerId)"
  />
  <PreferencesPanel
    v-if="m.showPreferencesPanel.value"
    :ref="setPreferencesRef"
    :preferences="preferences"
    @update="c.appPreferences.handlePreferenceUpdate"
    @close="m.showPreferencesPanel.value = false"
  />
  <AppUpdatePrompt :controller="c.appUpdate" />
  <ToastContainer />
</template>
