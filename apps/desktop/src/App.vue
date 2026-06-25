<script setup lang="ts">
import { ref, computed, inject, onMounted, onBeforeUnmount, onUnmounted, nextTick, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauri } from "./tauri-mock";
import { invoke } from "./invoke";
import { listen, listenCurrentWebviewWindow } from "./listen";
import { getSetting, type AgentProvider, type DbHandle } from "@kanna/db";
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
import PeerPickerModal from "./components/PeerPickerModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import AppUpdatePrompt from "./components/AppUpdatePrompt.vue";
import ToastContainer from "./components/ToastContainer.vue";
import { type ActionName } from "./composables/useKeyboardShortcuts";
import { scheduleStartupBackup, startPeriodicBackup } from "./composables/useBackup";
import { useOperatorEvents } from "./composables/useOperatorEvents";
import { useCustomTasks } from "./composables/useCustomTasks";
import { useToast } from "./composables/useToast";
import { useAppUpdate } from "./composables/useAppUpdate";
import { useAppCloudWorkspace } from "./composables/useAppCloudWorkspace";
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
import {
  parseIncomingTransferRequest,
  parsePairingCompletedEvent,
  parsePairingRequestedEvent,
  parseOutgoingTransferCommittedEvent,
  parseOutgoingTransferFinalizationRequestEvent,
} from "./utils/taskTransfer";
import { useKannaStore } from "./stores/kanna";
import { useThemeRuntime } from "./theme/runtime";
import {
  normalizeAppThemePreference,
  normalizeCodeThemePreference,
} from "./theme/theme";
import {
  WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
  WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
  WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
  type WindowWorkspaceController,
} from "./windowWorkspace";

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
const appUnlisteners: Array<() => void> = [];
let closingCurrentWindow = false;
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

async function requestCloseCurrentWindow() {
  if (closingCurrentWindow) return;
  closingCurrentWindow = true;
  try {
    await windowWorkspace.closeWindow();
  } catch (error: unknown) {
    closingCurrentWindow = false;
    throw error;
  }
}

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
const { keyboardActions } = useAppKeyboardActions({
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

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

function listenNativeMenuAction(
  eventName: string,
  action: () => void | Promise<void>,
  label: string,
) {
  void (async () => {
    try {
      const unlisten = await listenCurrentWebviewWindow(eventName, async () => {
        await action();
      });
      appUnlisteners.push(unlisten);
    } catch (e: unknown) {
      console.error(`[App] native ${label} listener registration failed:`, e);
    }
  })();
}

function isFileTransfer(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  if (transfer.files.length > 0) return true;
  return Array.from(transfer.types).includes("Files");
}

function suppressFileDropNavigation(event: DragEvent) {
  if (!isFileTransfer(event)) return;
  event.preventDefault();
}

function handleFileLinkActivate(event: Event) {
  const detail = (event as CustomEvent).detail as { path: string; line?: number };
  openFilePreview(detail.path, detail.line, false);
}

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

// Init
onMounted(async () => {
  appUpdate.start();
  window.addEventListener("dragenter", suppressFileDropNavigation);
  window.addEventListener("dragover", suppressFileDropNavigation);
  window.addEventListener("drop", suppressFileDropNavigation);
  document.addEventListener("file-link-activate", handleFileLinkActivate);

  await restoreSidebarWidth();
  await store.init(db);
  preferences.appTheme = normalizeAppThemePreference(store.appTheme);
  preferences.codeTheme = normalizeCodeThemePreference(store.codeTheme);
  startSystemThemeListener();
  await nextTick();
  if (windowWorkspace && windowWorkspace.bootstrap.windowId === "main") {
    scheduleStartupBackup(dbName);
  }
  void initializeDesktopCloudAuth().catch((error) =>
    console.warn("[cloud] failed to initialize desktop auth:", error),
  );
  initializeDesktopLanTaskSync();
  await importPendingIncomingTransfers();
  if (import.meta.env.DEV && window.__KANNA_E2E__) {
    void remoteTaskDiagnostics.value;
    window.__KANNA_E2E__.ready = true;
  }

  try {
    const unlistenNativeNewWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT, async () => {
      await keyboardActions.newWindow();
    });
    appUnlisteners.push(unlistenNativeNewWindow);
  } catch (e: unknown) {
    console.error("[App] native new-window listener registration failed:", e);
  }

  try {
    const unlistenNativeCloseWindow = await listenCurrentWebviewWindow(WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT, async () => {
      await keyboardActions.closeWindow();
    });
    appUnlisteners.push(unlistenNativeCloseWindow);
  } catch (e: unknown) {
    console.error("[App] native close-window listener registration failed:", e);
  }

  if (isTauri) {
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const unlistenNativeWindowCloseRequest = await getCurrentWindow().onCloseRequested(async (event) => {
          if (closingCurrentWindow) return;
          closingCurrentWindow = true;
          try {
            await windowWorkspace.forgetCurrentWindow();
          } catch (error: unknown) {
            closingCurrentWindow = false;
            event.preventDefault();
            console.error("[App] native window close request failed:", error);
          }
        });
        appUnlisteners.push(unlistenNativeWindowCloseRequest);
      } catch (e: unknown) {
        console.error("[App] native window close-request listener registration failed:", e);
      }
    })();
  }

  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
    keyboardActions.navigateUp,
    "navigate-task-up",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
    keyboardActions.navigateDown,
    "navigate-task-down",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
    keyboardActions.navigateRepoUp,
    "navigate-repo-up",
  );
  listenNativeMenuAction(
    WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
    keyboardActions.navigateRepoDown,
    "navigate-repo-down",
  );

  try {
    const unlistenTransferRequest = await listen("transfer-request", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const request = parseIncomingTransferRequest(payload);
        await store.recordIncomingTransfer(request);
        await store.approveIncomingTransfer(request.transferId);
      } catch (e: unknown) {
        console.error("[App] failed to import incoming transfer request:", e);
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
    appUnlisteners.push(unlistenTransferRequest);
  } catch (e: unknown) {
    console.error("[App] transfer-request listener registration failed:", e);
  }

  try {
    const unlistenPairingStarted = await listen("pairing-started", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingCompletedEvent(payload);
        toast.info(`Enter code ${pairing.verificationCode} on ${pairing.displayName}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing started event:", e);
      }
    });
    appUnlisteners.push(unlistenPairingStarted);
  } catch (e: unknown) {
    console.error("[App] pairing-started listener registration failed:", e);
  }

  try {
    const unlistenPairingRequested = await listen("pairing-requested", async (event: unknown) => {
      let pairingRequestId: string | null = null;
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingRequestedEvent(payload);
        pairingRequestId = pairing.requestId;
        const enteredCode = window
          .prompt(`Enter pairing code for ${pairing.displayName}`)
          ?.trim() ?? null;
        if (enteredCode !== pairing.verificationCode) {
          await invoke("reject_peer_pairing", { pairingRequestId: pairing.requestId });
          toast.error("Pairing code did not match.");
          return;
        }

        await invoke("accept_peer_pairing", {
          pairingRequestId: pairing.requestId,
          verificationCode: enteredCode,
        });
        toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing request event:", e);
        if (pairingRequestId) {
          try {
            await invoke("reject_peer_pairing", { pairingRequestId });
          } catch (rejectError: unknown) {
            console.error("[App] failed to reject pairing request:", rejectError);
          }
        }
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });
    appUnlisteners.push(unlistenPairingRequested);
  } catch (e: unknown) {
    console.error("[App] pairing-requested listener registration failed:", e);
  }

  try {
    const unlistenPairingCompleted = await listen("pairing-completed", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const pairing = parsePairingCompletedEvent(payload);
        console.debug("[transfer] pairing-completed event received", {
          peerId: pairing.peerId,
          displayName: pairing.displayName,
        });
        toast.info(`Paired with ${pairing.displayName}. Verify code ${pairing.verificationCode}.`);
      } catch (e: unknown) {
        console.error("[App] failed to handle pairing completion event:", e);
      }
    });
    appUnlisteners.push(unlistenPairingCompleted);
  } catch (e: unknown) {
    console.error("[App] pairing-completed listener registration failed:", e);
  }

  try {
    const unlistenOutgoingTransferCommitted = await listen("outgoing-transfer-committed", async (event: unknown) => {
      try {
        const payload = (event as { payload?: unknown })?.payload ?? event;
        const committed = parseOutgoingTransferCommittedEvent(payload);
        await store.handleOutgoingTransferCommitted(committed);
      } catch (e: unknown) {
        console.error("[App] failed to handle outgoing transfer commit acknowledgment:", e);
      }
    });
    appUnlisteners.push(unlistenOutgoingTransferCommitted);
  } catch (e: unknown) {
    console.error("[App] outgoing-transfer-committed listener registration failed:", e);
  }

  try {
    const unlistenOutgoingTransferFinalizationRequested = await listen("outgoing-transfer-finalization-requested", async (event: unknown) => {
      const payload = (event as { payload?: unknown })?.payload ?? event;
      const request = parseOutgoingTransferFinalizationRequestEvent(payload);
      try {
        const finalized = await store.finalizeOutgoingTransfer(request.transferId);
        await invoke("complete_outgoing_transfer_finalization", {
          transferId: request.transferId,
          payload: finalized.payload,
          finalizedCleanly: finalized.finalizedCleanly,
          error: null,
        });
      } catch (error: unknown) {
        console.error("[App] failed to finalize outgoing transfer:", error);
        await invoke("complete_outgoing_transfer_finalization", {
          transferId: request.transferId,
          payload: null,
          finalizedCleanly: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch((invokeError: unknown) => {
          console.error("[App] failed to report outgoing transfer finalization error:", invokeError);
        });
      }
    });
    appUnlisteners.push(unlistenOutgoingTransferFinalizationRequested);
  } catch (e: unknown) {
    console.error("[App] outgoing-transfer-finalization-requested listener registration failed:", e);
  }

  await warmTransferSidecar();

  // Cache $HOME for shell-at-home (no repo selected)
  invoke("read_env_var", { name: "HOME" }).then((val) => {
    homePath.value = val as string;
  }).catch(() => {
    homePath.value = "/Users";
  });

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
  preferences.agentMessageAppearance = store.agentMessageAppearance;

  const savedAgentProvider = await getSetting(db, "defaultAgentProvider");
  if (savedAgentProvider === "copilot") preferences.defaultAgentProvider = "copilot";
  else if (savedAgentProvider === "codex") preferences.defaultAgentProvider = "codex";
  else if (savedAgentProvider === "opencode") preferences.defaultAgentProvider = "opencode";

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

});

onUnmounted(() => {
  while (appUnlisteners.length > 0) {
    const unlisten = appUnlisteners.pop();
    try {
      unlisten?.();
    } catch (e: unknown) {
      console.error("[App] failed to unlisten app event:", e);
    }
  }
});

onBeforeUnmount(() => {
  disposeDesktopCloudWorkspace();
  stopSidebarResize();
  window.removeEventListener("dragenter", suppressFileDropNavigation);
  window.removeEventListener("dragover", suppressFileDropNavigation);
  window.removeEventListener("drop", suppressFileDropNavigation);
  document.removeEventListener("file-link-activate", handleFileLinkActivate);
  stopSystemThemeListener();
  appUpdate.dispose();
});
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
