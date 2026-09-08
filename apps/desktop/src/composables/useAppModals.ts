import { computed, nextTick, onUnmounted, reactive, ref, watch, type ComputedRef } from "vue";

import Sidebar from "../components/Sidebar.vue";
import MainPanel from "../components/MainPanel.vue";
import FilePickerModal from "../components/FilePickerModal.vue";
import { type ShortcutContext } from "./useShortcutContext";
import { useRestoreFocus } from "./useRestoreFocus";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeSidebarWidth,
  type WindowWorkspaceController,
} from "../windowWorkspace";
import type { useKannaStore } from "../stores/kanna";
import {
  MARKDOWN_PREVIEW_MODE_SETTING_KEY,
  type MarkdownPreviewMode,
} from "../stores/markdownPreviewMode";
import type {
  DiffTearOffContext,
  ModalTearOffContext,
  TreeExplorerTearOffContext,
} from "../modalTearOff";
import type { WorkspaceTask } from "../workspace/types";
import type { MainTabsController } from "./useMainTabs";
import { createConfiguredDesktopRemoteTaskViewClient } from "../services/desktopRelayTerminal";
import { createConfiguredDesktopLanTaskViewClient } from "../services/desktopLanTerminal";
import type {
  DesktopRemoteTaskViewClient,
  RemoteTaskDiffRequest,
} from "../services/desktopRemoteTaskClient";

export type DiffScope = "branch" | "working";
export type BranchInclude = "none" | "staged" | "all";

export interface DiffScrollPositions {
  branch?: number;
  working?: number;
}

export interface DiffViewState {
  scope?: DiffScope;
  scrollPositions?: DiffScrollPositions;
  branchInclude?: BranchInclude;
}

interface FilePreviewRecallState {
  filePath: string;
  initialLine?: number;
}

interface UseAppModalsOptions {
  isMobile: boolean;
  store: ReturnType<typeof useKannaStore>;
  windowWorkspace: WindowWorkspaceController;
  selectedWorkspaceTask?: ComputedRef<WorkspaceTask | null>;
  /**
   * The main content area's tabs. A file opened while a task is selected
   * becomes a tab there; the ephemeral preview modal remains for the
   * repo-scoped case, where there is no task tab set to open into.
   */
  mainTabs?: MainTabsController;
}

export function useAppModals({
  isMobile,
  store,
  windowWorkspace,
  selectedWorkspaceTask,
  mainTabs,
}: UseAppModalsOptions) {
  const transferredModalContext = ref<ModalTearOffContext | null>(
    windowWorkspace.bootstrap.tearOffContext ?? null,
  );
  const showNewTaskModal = ref(false);
  const availableWorkflows = ref<string[]>([]);
  const defaultWorkflowName = ref<string | undefined>(undefined);
  const availableBaseBranches = ref<string[]>([]);
  const defaultBaseBranchName = ref<string | undefined>(undefined);
  const repoDefaultBranchName = ref<string | undefined>(undefined);
  const showAddRepoModal = ref(false);
  const addRepoInitialTab = ref<"create" | "import">("create");
  const showShortcutsModal = ref(false);
  const shortcutsStartFull = ref(false);
  const shortcutsContext = ref<ShortcutContext>("main");
  const showFilePickerModal = ref(false);
  const filePickerHidden = ref(false);
  const transferredTreeContext = computed<TreeExplorerTearOffContext | null>(() =>
    transferredModalContext.value?.surface === "tree"
      ? transferredModalContext.value
      : null
  );
  const transferredDiffContext = computed<DiffTearOffContext | null>(() =>
    transferredModalContext.value?.surface === "diff"
      ? transferredModalContext.value
      : null
  );
  const selectedTaskIsRemote = computed(() =>
    selectedWorkspaceTask?.value?.owner.kind === "remote"
  );
  const selectedRemoteTaskRoute = computed(() => {
    const task = selectedWorkspaceTask?.value;
    if (task?.owner.kind !== "remote") return null;
    const selectedRoute = task.terminal.kind === "lan" || task.terminal.kind === "cloud"
      ? { ref: task.terminal.remoteRef, transport: task.terminal.kind }
      : undefined;
    const source = selectedRoute?.ref
      ? undefined
      : task.sources.find((candidate) => candidate.terminalRef);
    const route = selectedRoute?.ref ?? source?.terminalRef;
    return route
      ? {
          desktopId: route.ownerDesktopId,
          taskId: route.ownerLocalTaskId,
          transport: selectedRoute?.transport ?? (source?.kind === "lan" ? "lan" : "cloud"),
        }
      : null;
  });
  const activeRemoteTaskRoute = computed(() => {
    const transferred = transferredTreeContext.value ?? transferredDiffContext.value;
    if (transferred?.remoteDesktopId && transferred.remoteTaskId) {
      return {
        desktopId: transferred.remoteDesktopId,
        taskId: transferred.remoteTaskId,
        transport: transferred.remoteTransport ?? "cloud",
      };
    }
    return selectedRemoteTaskRoute.value;
  });
  const activeTaskViewIsRemote = computed(() => {
    const transferred = transferredTreeContext.value ?? transferredDiffContext.value;
    return Boolean(transferred?.remoteDesktopId && transferred.remoteTaskId)
      || selectedTaskIsRemote.value;
  });
  const activeTask = computed(() =>
    selectedTaskIsRemote.value
      ? selectedWorkspaceTask?.value?.item ?? null
      : store.currentItem
  );
  const currentWorktreePath = computed(() => {
    if (selectedTaskIsRemote.value) return undefined;
    if (!store.selectedRepo?.path || !activeTask.value?.branch) return undefined;
    return `${store.selectedRepo.path}/.kanna-worktrees/${activeTask.value.branch}`;
  });
  const activeRepoPath = computed(() =>
    transferredTreeContext.value?.repoRoot
      ?? transferredDiffContext.value?.repoPath
      ?? (activeTaskViewIsRemote.value ? undefined : store.selectedRepo?.path)
      ?? ""
  );
  const activeWorktreePath = computed(() =>
    transferredTreeContext.value?.worktreePath
      ?? transferredDiffContext.value?.worktreePath
      ?? currentWorktreePath.value
      ?? activeRepoPath.value
  );
  const activeDiffWorktreePath = computed(() =>
    transferredDiffContext.value?.worktreePath
      ?? (activeTaskViewIsRemote.value ? undefined : currentWorktreePath.value)
  );
  const homePath = ref("");
  const treeExplorerRoot = computed(() => {
    if (transferredTreeContext.value) {
      return transferredTreeContext.value.worktreePath;
    }
    if (activeTaskViewIsRemote.value) {
      return activeTask.value?.branch ?? activeRemoteTaskRoute.value?.taskId ?? "Remote task";
    }
    if (currentWorktreePath.value) return currentWorktreePath.value;
    if (store.selectedRepo?.path) return store.selectedRepo.path;
    return homePath.value;
  });
  const showCommandPalette = ref(false);
  const showBlockerSelect = ref(false);
  const blockerSelectMode = ref<"block" | "edit">("block");
  const showPeerPicker = ref(false);
  const sidebarHidden = ref(false);
  const sidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH);
  const maximizedModal = ref<ShortcutContext | null>(null);
  const maximized = computed(() => maximizedModal.value !== null);
  const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);
  const mainPanelRef = ref<InstanceType<typeof MainPanel> | null>(null);
  const filePickerRef = ref<InstanceType<typeof FilePickerModal> | null>(null);
  const sidebarShellStyle = computed(() => ({
    width: `${sidebarWidth.value}px`,
    minWidth: `${sidebarWidth.value}px`,
    maxWidth: `${sidebarWidth.value}px`,
  }));
  const canResizeSidebar = computed(() => !isMobile);
  let sidebarResizeStartX = 0;
  let sidebarResizeStartWidth = DEFAULT_SIDEBAR_WIDTH;
  let sidebarResizeActive = false;

  const diffViewStates = reactive<Record<string, DiffViewState>>({});
  const filePreviewRecallStates = reactive<Record<string, FilePreviewRecallState>>({});
  const currentDiffViewKey = computed(() => {
    if (transferredDiffContext.value?.viewKey) return transferredDiffContext.value.viewKey;
    if (selectedTaskIsRemote.value && selectedWorkspaceTask?.value?.item) {
      return `item:${selectedWorkspaceTask.value.item.id}`;
    }
    if (store.currentItem) return `item:${store.currentItem.id}`;
    if (store.selectedRepo) return `repo:${store.selectedRepo.id}`;
    return undefined;
  });
  const currentDiffViewState = computed(() => {
    const key = currentDiffViewKey.value;
    return key ? diffViewStates[key] : undefined;
  });

  function updateCurrentDiffViewState(partial: DiffViewState) {
    const key = currentDiffViewKey.value;
    if (!key) return;
    const current = diffViewStates[key] ?? {};
    diffViewStates[key] = { ...current, ...partial };
  }

  /**
   * A torn-off window boots with the surface it was dragged out of. That
   * surface is a tab like any other now, so the window opens it in whatever
   * scope it restored and maximizes it, rather than raising a modal over an
   * empty main area.
   */
  function restoreTransferredModal() {
    const context = transferredModalContext.value;
    if (!context) return;
    if (context.surface === "tree") {
      mainTabs?.openTab({ kind: "tree" });
      maximizedModal.value = "tree";
      return;
    }

    const key = context.viewKey ?? currentDiffViewKey.value;
    if (key) {
      diffViewStates[key] = {
        ...(context.initialScope ? { scope: context.initialScope } : {}),
        ...(context.initialScrollPositions
          ? { scrollPositions: context.initialScrollPositions }
          : {}),
        ...(context.initialBranchInclude
          ? { branchInclude: context.initialBranchInclude }
          : {}),
      };
    }
    mainTabs?.openTab({ kind: "diff" });
    maximizedModal.value = "diff";
  }

  /**
   * Clears this window's record of the surface it was torn off with, so the
   * window it came from stops counting it as outstanding. Called when the tab
   * that surface restored into is closed.
   */
  function finishTransferredModal(surface: ModalTearOffContext["surface"]): void {
    if (transferredModalContext.value?.surface !== surface) return;
    transferredModalContext.value = null;
    void windowWorkspace.clearTearOffContext().catch((error: unknown) => {
      console.error("[App] failed to finish transferred modal state:", error);
    });
  }

  function buildCurrentFileFlowKey(): string | undefined {
    if (selectedTaskIsRemote.value && selectedWorkspaceTask?.value?.item) {
      return `item:${selectedWorkspaceTask.value.item.id}`;
    }
    if (store.currentItem) return `item:${store.currentItem.id}`;
    if (store.selectedRepo) return `repo:${store.selectedRepo.id}`;
    return undefined;
  }

  const currentFileFlowKey = computed(() => buildCurrentFileFlowKey());

  let relayTaskViewClientPromise: Promise<DesktopRemoteTaskViewClient | null> | null = null;
  let lanTaskViewClientPromise: Promise<DesktopRemoteTaskViewClient> | null = null;

  async function getRemoteTaskViewClient(
    transport: "lan" | "cloud",
  ): Promise<DesktopRemoteTaskViewClient> {
    if (transport === "lan") {
      lanTaskViewClientPromise ??= createConfiguredDesktopLanTaskViewClient();
      return lanTaskViewClientPromise;
    }
    relayTaskViewClientPromise ??= createConfiguredDesktopRemoteTaskViewClient();
    const client = await relayTaskViewClientPromise;
    if (!client) {
      throw new Error("Remote task files are unavailable because the relay is not configured.");
    }
    return client;
  }

  async function listRemoteTaskDirectory(path: string, showAllFiles: boolean) {
    const route = activeRemoteTaskRoute.value;
    if (!route) throw new Error("Remote task route is unavailable.");
    const client = await getRemoteTaskViewClient(route.transport);
    return client.listTaskDirectory({
      desktopId: route.desktopId,
      taskId: route.taskId,
      path,
      showAllFiles,
    });
  }

  async function readRemoteTaskFile(path: string): Promise<string> {
    const route = activeRemoteTaskRoute.value;
    if (!route) throw new Error("Remote task route is unavailable.");
    const client = await getRemoteTaskViewClient(route.transport);
    return (await client.readTaskFile({
      desktopId: route.desktopId,
      taskId: route.taskId,
      path,
    })).content;
  }

  async function readRemoteTaskDiff(request: RemoteTaskDiffRequest) {
    const route = activeRemoteTaskRoute.value;
    if (!route) throw new Error("Remote task route is unavailable.");
    const client = await getRemoteTaskViewClient(route.transport);
    return client.readTaskDiff({
      desktopId: route.desktopId,
      taskId: route.taskId,
      request,
    });
  }

  onUnmounted(() => {
    void relayTaskViewClientPromise?.then((client) => client?.close());
    void lanTaskViewClientPromise?.then((client) => client.close());
  });

  function rememberCurrentPreview(filePath: string, initialLine: number | undefined) {
    const key = buildCurrentFileFlowKey();
    if (!key) return;
    filePreviewRecallStates[key] = {
      filePath,
      initialLine,
    };
  }

  function getCurrentPreviewRecall(): FilePreviewRecallState | undefined {
    const key = buildCurrentFileFlowKey();
    return key ? filePreviewRecallStates[key] : undefined;
  }

  const currentPreviewMarkdownMode = computed<MarkdownPreviewMode>(
    () => store.markdownPreviewMode,
  );

  let markdownPreviewModeSaveInFlight = false;
  let pendingMarkdownPreviewMode: MarkdownPreviewMode | undefined;

  async function drainMarkdownPreviewModeSaves() {
    if (markdownPreviewModeSaveInFlight) return;
    markdownPreviewModeSaveInFlight = true;

    try {
      while (pendingMarkdownPreviewMode !== undefined) {
        const mode = pendingMarkdownPreviewMode;
        pendingMarkdownPreviewMode = undefined;

        try {
          await store.savePreference(MARKDOWN_PREVIEW_MODE_SETTING_KEY, mode);
        } catch (error: unknown) {
          console.error("[App] failed to persist Markdown preview mode:", error);
        }

        if (pendingMarkdownPreviewMode !== undefined) {
          store.markdownPreviewMode = pendingMarkdownPreviewMode;
        }
      }
    } finally {
      markdownPreviewModeSaveInFlight = false;
    }
  }

  function updateCurrentPreviewMarkdownMode(mode: MarkdownPreviewMode) {
    store.markdownPreviewMode = mode;
    pendingMarkdownPreviewMode = mode;
    void drainMarkdownPreviewModeSaves();
  }

  function clampSidebarWidth(width: number): number {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
  }

  function stopSidebarResize() {
    if (!sidebarResizeActive) return;
    sidebarResizeActive = false;
    document.removeEventListener("pointermove", handleSidebarResizeMove);
    document.removeEventListener("pointerup", handleSidebarResizeEnd);
    document.body.classList.remove("is-resizing-sidebar");
  }

  function handleSidebarResizeMove(event: PointerEvent) {
    if (!sidebarResizeActive) return;
    sidebarWidth.value = clampSidebarWidth(
      sidebarResizeStartWidth + event.clientX - sidebarResizeStartX,
    );
  }

  async function handleSidebarResizeEnd(event: PointerEvent) {
    handleSidebarResizeMove(event);
    stopSidebarResize();
    try {
      await windowWorkspace.persistSidebarWidth(sidebarWidth.value);
    } catch (error: unknown) {
      console.error("[App] failed to persist sidebar width:", error);
    }
  }

  function startSidebarResize(event: PointerEvent) {
    if (!canResizeSidebar.value) return;
    event.preventDefault();
    sidebarResizeActive = true;
    sidebarResizeStartX = event.clientX;
    sidebarResizeStartWidth = sidebarWidth.value;
    document.addEventListener("pointermove", handleSidebarResizeMove);
    document.addEventListener("pointerup", handleSidebarResizeEnd);
    document.body.classList.add("is-resizing-sidebar");
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  async function restoreSidebarWidth() {
    try {
      const snapshot = await windowWorkspace.loadSnapshot();
      const savedWindow = snapshot.windows.find((entry) =>
        entry.windowId === windowWorkspace.bootstrap.windowId
      );
      sidebarWidth.value = normalizeSidebarWidth(savedWindow?.sidebarWidth);
    } catch (error: unknown) {
      console.error("[App] failed to restore sidebar width:", error);
    }
  }

  // Derived from the dialogs that are open, not from the global singleton,
  // which a KeepAlive deactivation can leave stale. The main area's own views
  // are tabs; their shortcut context follows the active tab instead — see
  // `useMainTabs().activeTabContext`.
  const currentShortcutContext = computed<ShortcutContext>(() => {
    // The shortcuts modal is topmost and owns Escape/help toggles even when
    // opened over another dialog.
    if (showShortcutsModal.value) return "main";
    if (showPeerPicker.value) return "transfer";
    if (showNewTaskModal.value) return "newTask";
    if (showFilePickerModal.value) return "file";
    return "main";
  });





  // Tabs are per scope, so a task switch no longer has to tear a view down —
  // but the picker is a dialog over whatever is selected, and one left open
  // onto the previous task's worktree is not a picker for this one.
  watch(currentFileFlowKey, (newKey, oldKey) => {
    if (!oldKey || newKey === oldKey) return;
    closeFilePicker();
  });

  function closeFilePicker() {
    showFilePickerModal.value = false;
    filePickerHidden.value = false;
  }

  function showFilePickerOnTop() {
    showFilePickerModal.value = true;
    filePickerHidden.value = false;
    nextTick(() => filePickerRef.value?.bringToFront?.());
  }

  /**
   * Show a file in the main content area. Every caller — the picker, the tree
   * explorer, a terminal file link, a `kanna_open_file` request — lands here,
   * and every one of them opens a tab in the current scope.
   */
  function openFilePreview(
    filePath: string,
    initialLine?: number,
    remoteContent?: string,
  ) {
    // Remote content is a point-in-time snapshot from another machine; it
    // cannot be re-loaded later, so it is excluded from preview recall.
    if (remoteContent === undefined) rememberCurrentPreview(filePath, initialLine);
    mainTabs?.openTab({
      kind: "file",
      filePath,
      initialLine,
      remoteContent: remoteContent ?? null,
    });
    // The picker is a launcher: once the file has a tab the flow is over, so
    // it is not left mounted waiting to be returned to. The tree explorer is a
    // browser and stays where it is, so several files can be opened in a row.
    closeFilePicker();
  }

  function selectFileFromPicker(filePath: string) {
    openFilePreview(filePath);
  }


  function openImageUrlPreview(imageUrl: string) {
    mainTabs?.openTab({ kind: "image", imageUrl });
  }


  // Only dialogs are left to restore focus after; the main area's views are
  // tabs, and a tab never took focus away from anything to begin with.
  const anyModalOpen = computed(() =>
    showNewTaskModal.value || showAddRepoModal.value || showShortcutsModal.value ||
    showFilePickerModal.value || showBlockerSelect.value || showPeerPicker.value
  );
  useRestoreFocus(anyModalOpen);

  return {
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
    filePickerHidden,
    transferredModalContext,
    transferredTreeContext,
    transferredDiffContext,
    activeTask,
    activeTaskViewIsRemote,
    activeRemoteTaskRoute,
    listRemoteTaskDirectory,
    readRemoteTaskFile,
    readRemoteTaskDiff,
    currentWorktreePath,
    activeRepoPath,
    activeWorktreePath,
    activeDiffWorktreePath,
    homePath,
    treeExplorerRoot,
    showCommandPalette,
    showBlockerSelect,
    blockerSelectMode,
    showPeerPicker,
    sidebarHidden,
    maximizedModal,
    maximized,
    sidebarRef,
    mainPanelRef,
    filePickerRef,
    sidebarShellStyle,
    canResizeSidebar,
    currentDiffViewKey,
    // The per-view diff state record, keyed by `currentDiffViewKey`. Returned
    // so a caller can drop a view's remembered state — the E2E harness resets
    // it to exercise a genuine first open, which is when the diff view probes
    // the worktree for its opening scope instead of reusing the last one.
    diffViewStates,
    currentDiffViewState,
    updateCurrentDiffViewState,
    restoreTransferredModal,
    finishTransferredModal,
    currentPreviewMarkdownMode,
    updateCurrentPreviewMarkdownMode,
    stopSidebarResize,
    startSidebarResize,
    restoreSidebarWidth,
    currentShortcutContext,
    closeFilePicker,
    showFilePickerOnTop,
    openFilePreview,
    selectFileFromPicker,
    openImageUrlPreview,
    getCurrentPreviewRecall,
  };
}
