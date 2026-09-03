import { type ComputedRef, type Ref } from "vue";

import Sidebar from "../components/Sidebar.vue";
import FilePickerModal from "../components/FilePickerModal.vue";
import FilePreviewModal from "../components/FilePreviewModal.vue";
import TreeExplorerModal from "../components/TreeExplorerModal.vue";
import DiffModal from "../components/DiffModal.vue";
import CommitGraphModal from "../components/CommitGraphModal.vue";
import ShellModal from "../components/ShellModal.vue";
import PreferencesPanel from "../components/PreferencesPanel.vue";
import { invoke } from "../invoke";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { isTopModal } from "./useModalZIndex";
import type { ShortcutContext } from "./useShortcutContext";
import type { WorkspaceTask } from "../workspace/types";
import type { useKannaStore } from "../stores/kanna";
import type { useToast } from "./useToast";
import { openLatestTerminalFileLink } from "./terminalFileLinkRegistry";
import type { WindowWorkspaceController } from "../windowWorkspace";

interface SidebarRepoProjection {
  id: string;
}

interface UseAppKeyboardActionsOptions {
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  t: (key: string) => string;
  windowWorkspace: WindowWorkspaceController;
  sidebarRepos: ComputedRef<SidebarRepoProjection[]>;
  selectedWorkspaceTask: ComputedRef<WorkspaceTask | null>;
  selectedWorkspaceTaskBlocked: ComputedRef<boolean>;
  currentShortcutContext: ComputedRef<ShortcutContext>;
  showNewTaskModal: Ref<boolean>;
  showAddRepoModal: Ref<boolean>;
  addRepoInitialTab: Ref<"create" | "import">;
  showShortcutsModal: Ref<boolean>;
  shortcutsStartFull: Ref<boolean>;
  shortcutsContext: Ref<ShortcutContext>;
  showFilePickerModal: Ref<boolean>;
  filePickerHidden: Ref<boolean>;
  showFilePreviewModal: Ref<boolean>;
  previewHidden: Ref<boolean>;
  previewFromPicker: Ref<boolean>;
  previewFromTree: Ref<boolean>;
  showDiffModal: Ref<boolean>;
  showTreeExplorer: Ref<boolean>;
  showShellModal: Ref<boolean>;
  shellRepoRoot: Ref<boolean>;
  showCommandPalette: Ref<boolean>;
  showAnalyticsModal: Ref<boolean>;
  showCommitGraphModal: Ref<boolean>;
  showPeerPicker: Ref<boolean>;
  showPreferencesPanel: Ref<boolean>;
  maximizedModal: Ref<ShortcutContext | null>;
  sidebarHidden: Ref<boolean>;
  sidebarRef: Ref<InstanceType<typeof Sidebar> | null>;
  shellModalRef: Ref<InstanceType<typeof ShellModal> | null>;
  diffModalRef: Ref<InstanceType<typeof DiffModal> | null>;
  commitGraphModalRef: Ref<InstanceType<typeof CommitGraphModal> | null>;
  treeExplorerRef: Ref<InstanceType<typeof TreeExplorerModal> | null>;
  filePickerRef: Ref<InstanceType<typeof FilePickerModal> | null>;
  filePreviewRef: Ref<InstanceType<typeof FilePreviewModal> | null>;
  preferencesRef: Ref<InstanceType<typeof PreferencesPanel> | null>;
  openNewTaskModal: () => Promise<void>;
  requestCloseCurrentWindow: () => Promise<void>;
  showFilePickerOnTop: () => void;
  getCurrentPreviewRecall: () => { filePath: string; initialLine?: number } | undefined;
  openFilePreview: (
    filePath: string,
    initialLine: number | undefined,
    fromPicker: boolean,
    fromTree?: boolean,
  ) => void;
  closeTreeExplorer: () => void;
  closeDiffModal: () => void;
  advanceSelectedRemoteWorkspaceTask: (workspaceTask: WorkspaceTask) => Promise<void>;
  closeSelectedWorkspaceTask: () => Promise<boolean>;
  navigateItems: (direction: -1 | 1) => Promise<void>;
  navigateBack: () => Promise<void>;
  navigateForward: () => Promise<void>;
  selectUnreadTaskWithReadFallback: (scope: "currentRepo" | "allRepos") => Promise<void>;
  selectReadTask: (scope: "currentRepo" | "allRepos") => Promise<void>;
  navigateRepos: (direction: -1 | 1) => Promise<void>;
  closePeerPicker: () => void;
  closeFilePicker: () => void;
  closeFileFlow: () => void;
  onShellClose: () => void;
  scanRepoCommands: (repoId: string) => void;
  handleBlockTask: () => void;
  handleEditBlockedTask: () => void;
}

export function useAppKeyboardActions(options: UseAppKeyboardActionsOptions) {
  const {
    store,
    toast,
    t,
    windowWorkspace,
    sidebarRepos,
    selectedWorkspaceTask,
    selectedWorkspaceTaskBlocked,
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
    closeDiffModal,
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
    closeFileFlow,
    onShellClose,
    scanRepoCommands,
    handleBlockTask,
    handleEditBlockedTask,
  } = options;

  // Keyboard shortcuts
  const keyboardActions = {
    newTask: () => {
      if (sidebarRepos.value.length === 0) {
        toast.warning(t("toasts.noReposLoaded"));
        return;
      }
      openNewTaskModal().catch((e) => console.error("[App] openNewTaskModal failed:", e));
    },
    newWindow: async () => {
      const workspaceTask = selectedWorkspaceTask.value;
      const selectedTaskId = workspaceTask && workspaceTask.localTaskId === null
        ? workspaceTask.item.id
        : store.selectedTaskId;
      await windowWorkspace.openWindow({
        selectedRepoId: store.selectedRepoId,
        selectedItemId: selectedTaskId,
      });
    },
    closeWindow: async () => {
      await requestCloseCurrentWindow();
    },
    openFile: () => {
      if (showFilePickerModal.value) {
        const z = filePickerRef.value?.zIndex ?? 0;
        if (isTopModal(z)) {
          showFilePickerModal.value = false;
          filePickerHidden.value = true;
        } else {
          filePickerRef.value?.bringToFront();
        }
      } else {
        showFilePickerOnTop();
      }
    },
    openLatestFileLink: async () => {
      const sessionId = store.currentItem?.id;
      const opened = sessionId
        ? await openLatestTerminalFileLink(sessionId)
        : false;
      if (!opened) toast.info(t("toasts.noTerminalFileLink"));
    },
    toggleFilePreview: () => {
      if (showFilePreviewModal.value) {
        showFilePreviewModal.value = false;
        previewHidden.value = true;
        previewFromPicker.value = false;
        previewFromTree.value = false;
      } else {
        const recalledPreview = getCurrentPreviewRecall();
        if (recalledPreview) {
          openFilePreview(recalledPreview.filePath, recalledPreview.initialLine, false);
          return;
        }
        previewHidden.value = false;
        previewFromPicker.value = false;
        previewFromTree.value = false;
        showFilePickerOnTop();
      }
    },
    toggleTreeExplorer: () => {
      if (showTreeExplorer.value) {
        const z = treeExplorerRef.value?.zIndex ?? 0;
        if (isTopModal(z)) {
          closeTreeExplorer();
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
    advanceStage: () => {
      if (showDiffModal.value) {
        void diffModalRef.value?.approveReview();
        return;
      }
      const workspaceTask = selectedWorkspaceTask.value;
      if (workspaceTask) {
        if (selectedWorkspaceTaskBlocked.value) {
          toast.warning(t("mainPanel.taskBlocked"));
          return;
        }
        if (workspaceTask.item.has_running_post) return;
        if (!workspaceTask.capabilities.canAdvanceStage) return;
        if (!workspaceTask.localTaskId) {
          void advanceSelectedRemoteWorkspaceTask(workspaceTask);
          return;
        }
        void store.advanceStage(workspaceTask.localTaskId);
        return;
      }

      const item = store.currentItem;
      if (!item) return;
      if (store.selectedTaskId && item.id !== store.selectedTaskId) return;
      void store.advanceStage(item.id);
    },
    requestChanges: () => {
      diffModalRef.value?.requestChanges();
    },
    closeTask: async () => {
      await closeSelectedWorkspaceTask();
    },
    undoClose: () => store.undoClose(),
    navigateUp: () => navigateItems(-1),
    navigateDown: () => navigateItems(1),
    goToOldestUnread: () => selectUnreadTaskWithReadFallback("currentRepo"),
    goToOldestUnreadAllRepos: () => selectUnreadTaskWithReadFallback("allRepos"),
    goToOldestRead: () => selectReadTask("currentRepo"),
    goToOldestReadAllRepos: () => selectReadTask("allRepos"),
    navigateRepoUp: () => navigateRepos(-1),
    navigateRepoDown: () => navigateRepos(1),
    toggleSidebar: () => { sidebarHidden.value = !sidebarHidden.value; },
    toggleMaximize: () => {
      const ctx = currentShortcutContext.value;
      maximizedModal.value = maximizedModal.value === ctx ? null : ctx;
    },
    dismiss: () => {
      if (showCommandPalette.value) { showCommandPalette.value = false; return true; }
      if (showShortcutsModal.value) { showShortcutsModal.value = false; return true; }
      if (showPeerPicker.value) { closePeerPicker(); return true; }
      if (showFilePickerModal.value) { closeFilePicker(); return true; }
      if (showFilePreviewModal.value) {
        const shouldCloseFileFlow = filePreviewRef.value?.dismiss() ?? true;
        if (shouldCloseFileFlow) closeFileFlow();
        return true;
      }
      // Shell before diff: let Escape reach the shell terminal (vim, etc.)
      if (showShellModal.value) { return; }
      if (showDiffModal.value) {
        const shouldCloseDiff = diffModalRef.value?.dismiss() ?? true;
        if (shouldCloseDiff) {
          closeDiffModal();
        }
        return true;
      }
      if (showAnalyticsModal.value) { showAnalyticsModal.value = false; return true; }
      if (showCommitGraphModal.value) {
        const shouldCloseCommitGraph = commitGraphModalRef.value?.dismiss() ?? true;
        if (shouldCloseCommitGraph) {
          showCommitGraphModal.value = false;
        }
        return true;
      }
      if (showTreeExplorer.value) {
        const shouldCloseTreeExplorer = treeExplorerRef.value?.dismiss() ?? true;
        if (shouldCloseTreeExplorer) {
          closeTreeExplorer();
        }
        return true;
      }
      if (showNewTaskModal.value) { showNewTaskModal.value = false; return true; }
      if (showAddRepoModal.value) { showAddRepoModal.value = false; return true; }
    },
    openShell: () => {
      const workspaceTask = selectedWorkspaceTask.value;
      if (workspaceTask && !workspaceTask.capabilities.canOpenShell) {
        toast.warning(t("toasts.remoteShellUnavailable"));
        return;
      }
      if (!store.selectedRepo || !store.currentItem) return;
      if (showShellModal.value && !shellRepoRoot.value) {
        const z = shellModalRef.value?.zIndex ?? 0;
        if (isTopModal(z)) {
          onShellClose();
        } else {
          shellModalRef.value?.bringToFront();
        }
      } else {
        shellRepoRoot.value = false;
        showShellModal.value = true;
      }
    },
    openShellRepoRoot: () => {
      if (showShellModal.value && shellRepoRoot.value) {
        const z = shellModalRef.value?.zIndex ?? 0;
        if (isTopModal(z)) {
          onShellClose();
        } else {
          shellModalRef.value?.bringToFront();
        }
      } else {
        shellRepoRoot.value = true;
        showShellModal.value = true;
      }
    },
    showDiff: () => {
      if (!store.selectedRepo && !selectedWorkspaceTask.value) return;
      if (showDiffModal.value) {
        const z = diffModalRef.value?.zIndex ?? 0;
        if (isTopModal(z)) {
          closeDiffModal();
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
        if (repo) scanRepoCommands(repo.id);
      }
    },
    showAnalytics: () => { showAnalyticsModal.value = !showAnalyticsModal.value; },
    goBack: () => navigateBack(),
    goForward: () => navigateForward(),
    createRepo: () => { addRepoInitialTab.value = "create"; showAddRepoModal.value = true; },
    importRepo: () => { addRepoInitialTab.value = "import"; showAddRepoModal.value = true; },
    blockTask: () => { handleBlockTask(); },
    editBlockedTask: () => { handleEditBlockedTask(); },
    openPreferences: () => { showPreferencesPanel.value = !showPreferencesPanel.value; },
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

  return {
    keyboardActions,
  };
}
