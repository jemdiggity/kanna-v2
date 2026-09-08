<script setup lang="ts">
import type { ComponentPublicInstance } from "vue";

import NewTaskModal from "./NewTaskModal.vue";
import AddRepoModal from "./AddRepoModal.vue";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal.vue";
import FilePickerModal from "./FilePickerModal.vue";
import CommandPaletteModal from "./CommandPaletteModal.vue";
import BlockerSelectModal from "./BlockerSelectModal.vue";
import PeerPickerModal from "./PeerPickerModal.vue";
import AppUpdatePrompt from "./AppUpdatePrompt.vue";
import ToastContainer from "./ToastContainer.vue";
import type { ActionName } from "../composables/useKeyboardShortcuts";
import type { AppModalLayerController } from "./AppModalLayer.types";

const props = defineProps<{
  controller: AppModalLayerController;
}>();

const c = props.controller;
const m = c.appModals;
const preferences = c.appPreferences.preferences;

function setFilePickerRef(component: Element | ComponentPublicInstance | null) {
  m.filePickerRef.value = component as InstanceType<typeof FilePickerModal> | null;
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
  <AppUpdatePrompt :controller="c.appUpdate" />
  <ToastContainer />
</template>
