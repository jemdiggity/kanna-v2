import { type ComputedRef, type Ref } from "vue";

import Sidebar from "../components/Sidebar.vue";
import { invoke } from "../invoke";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { ShortcutContext } from "./useShortcutContext";
import type { WorkspaceTask } from "../workspace/types";
import type { MainTabsController } from "./useMainTabs";
import MainPanel from "../components/MainPanel.vue";
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
  /**
   * The main content area's tabs. While a task is selected, the view
   * shortcuts open, focus and close tabs there instead of raising a modal.
   */
  mainTabs: MainTabsController;
  mainPanelRef: Ref<InstanceType<typeof MainPanel> | null>;
  showNewTaskModal: Ref<boolean>;
  showAddRepoModal: Ref<boolean>;
  addRepoInitialTab: Ref<"create" | "import">;
  showShortcutsModal: Ref<boolean>;
  shortcutsStartFull: Ref<boolean>;
  shortcutsContext: Ref<ShortcutContext>;
  showFilePickerModal: Ref<boolean>;
  showCommandPalette: Ref<boolean>;
  showPeerPicker: Ref<boolean>;
  maximizedModal: Ref<ShortcutContext | null>;
  sidebarHidden: Ref<boolean>;
  sidebarRef: Ref<InstanceType<typeof Sidebar> | null>;
  openNewTaskModal: () => Promise<void>;
  requestCloseCurrentWindow: () => Promise<void>;
  showFilePickerOnTop: () => void;
  getCurrentPreviewRecall: () => { filePath: string; initialLine?: number } | undefined;
  openFilePreview: (filePath: string, initialLine?: number) => void;
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
  } = options;

  // The Preferences tab owns section cycling while it is the tab in front;
  // otherwise the keys move between the main content area's tabs.
  function cycleTabs(direction: -1 | 1) {
    if (mainTabs.activeTab.value?.kind === "preferences") {
      mainPanelRef.value?.cyclePreferencesSection?.(direction);
      return;
    }
    mainTabs.cycleTab(direction);
  }

  /**
   * The surface the operator is actually looking at: the dialog on top, else
   * the tab in front. It decides which shortcut list ⌘/ shows and what ⇧⌘⏎
   * maximizes — but deliberately not which shortcuts *fire*, because a tab is
   * a view, not a mode, and the task shortcuts stay live behind it.
   */
  function activeSurfaceContext(): ShortcutContext {
    const modalContext = currentShortcutContext.value;
    if (modalContext !== "main") return modalContext;
    return mainTabs.activeTabContext.value ?? "main";
  }

  /**
   * Contexts whose view binds a key for its own use, per key.
   *
   * A matched global shortcut only calls `preventDefault()`, so the same
   * keydown carries on to the view's own window listener: with a file tab in
   * front, one ⌘O launched the editor twice — once on the worktree, once on
   * the file — and one ⌘F opened the view's find *and* focused the sidebar
   * search behind it. The view that re-binds a key owns it while its tab is in
   * front; every other task shortcut deliberately stays live behind a tab,
   * which is why this is per key rather than a blanket stand-down.
   */
  const SEARCH_BOUND_BY_VIEW: ShortcutContext[] = ["file", "diff", "graph"];
  const IDE_BOUND_BY_VIEW: ShortcutContext[] = ["file"];

  function tabInFrontOwns(contexts: ShortcutContext[]): boolean {
    return contexts.includes(activeSurfaceContext());
  }

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
    closeTabOrWindow: async () => {
      // ⌘W closes the tab in front. The native File menu item routes here too,
      // so the menu and the keyboard agree.
      if (mainTabs.closeActiveTab()) return;
      // Nothing closable is in front — the agent session, which is the task
      // rather than a view of it. Only then does ⌘W mean the window, and only
      // once no view is left open: closing a window out from under the tabs
      // someone still has open is not what the key means anywhere else.
      if (mainTabs.tabs.value.some((tab) => tab.kind !== "agent")) return;
      await requestCloseCurrentWindow();
    },
    closeWindow: async () => {
      await requestCloseCurrentWindow();
    },
    openFile: () => {
      // The picker is the only preview-flow modal left, so it is always the
      // top one when it is open: ⌘P toggles it rather than raising it.
      if (showFilePickerModal.value) {
        closeFilePicker();
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
      const openFileTab = mainTabs.tabs.value.find((tab) => tab.kind === "file");
      if (openFileTab) {
        mainTabs.activateTab(openFileTab.id);
        return;
      }
      const recalled = getCurrentPreviewRecall();
      if (recalled) {
        openFilePreview(recalled.filePath, recalled.initialLine);
        return;
      }
      showFilePickerOnTop();
    },
    toggleTreeExplorer: () => {
      mainTabs.openTab({ kind: "tree" });
    },
    openInIDE: async () => {
      if (tabInFrontOwns(IDE_BOUND_BY_VIEW)) return;
      const item = store.currentItem;
      const repo = store.selectedRepo;
      if (!item?.branch || !repo) return;
      const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
      await invoke("run_script", { script: `${store.ideCommand} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch((e) => console.error("[openInIDE] failed:", e));
    },
    advanceStage: () => {
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
      const ctx = activeSurfaceContext();
      maximizedModal.value = maximizedModal.value === ctx ? null : ctx;
    },
    dismiss: () => {
      // Dialogs first, in stacking order; the main area's tabs are below all
      // of them and get Escape only once none of them wanted it.
      if (showCommandPalette.value) { showCommandPalette.value = false; return true; }
      if (showShortcutsModal.value) { showShortcutsModal.value = false; return true; }
      if (showPeerPicker.value) { closePeerPicker(); return true; }
      if (showFilePickerModal.value) { closeFilePicker(); return true; }
      if (showNewTaskModal.value) { showNewTaskModal.value = false; return true; }
      if (showAddRepoModal.value) { showAddRepoModal.value = false; return true; }
      if (mainPanelRef.value?.dismissActiveTab?.()) return true;
    },
    openShell: () => {
      const workspaceTask = selectedWorkspaceTask.value;
      if (workspaceTask && !workspaceTask.capabilities.canOpenShell) {
        toast.warning(t("toasts.remoteShellUnavailable"));
        return;
      }
      // A repository or app scope has no worktree to run in, so ⌘J opens the
      // shell that scope does have rather than nothing at all.
      mainTabs.openTab({
        kind: "shell",
        shellScope: mainTabs.hasAgentTab.value ? "worktree" : "repo",
      });
    },
    openShellRepoRoot: () => {
      mainTabs.openTab({ kind: "shell", shellScope: "repo" });
    },
    showDiff: () => {
      if (!store.selectedRepo && !selectedWorkspaceTask.value) return;
      mainTabs.openTab({ kind: "diff" });
    },
    showCommitGraph: () => {
      if (!store.selectedRepo) return;
      mainTabs.openTab({ kind: "graph" });
    },
    showShortcuts: () => {
      if (showShortcutsModal.value) {
        if (shortcutsStartFull.value && activeSurfaceContext() !== "main") {
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
    showAnalytics: () => {
      mainTabs.openTab({ kind: "analytics" });
    },
    goBack: () => navigateBack(),
    goForward: () => navigateForward(),
    createRepo: () => { addRepoInitialTab.value = "create"; showAddRepoModal.value = true; },
    importRepo: () => { addRepoInitialTab.value = "import"; showAddRepoModal.value = true; },
    blockTask: () => { handleBlockTask(); },
    editBlockedTask: () => { handleEditBlockedTask(); },
    openPreferences: () => {
      mainTabs.openTab({ kind: "preferences" });
    },
    prevTab: () => { cycleTabs(-1); },
    nextTab: () => { cycleTabs(1); },
    focusSearch: () => {
      if (tabInFrontOwns(SEARCH_BOUND_BY_VIEW)) return;
      sidebarRef.value?.focusSearch();
    },
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
