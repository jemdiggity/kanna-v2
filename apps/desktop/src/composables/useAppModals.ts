import { computed, nextTick, reactive, ref, watch } from "vue";

import Sidebar from "../components/Sidebar.vue";
import MainPanel from "../components/MainPanel.vue";
import FilePickerModal from "../components/FilePickerModal.vue";
import FilePreviewModal from "../components/FilePreviewModal.vue";
import ImageUrlPreviewModal from "../components/ImageUrlPreviewModal.vue";
import TreeExplorerModal from "../components/TreeExplorerModal.vue";
import DiffModal from "../components/DiffModal.vue";
import CommitGraphModal from "../components/CommitGraphModal.vue";
import ShellModal from "../components/ShellModal.vue";
import PreferencesPanel from "../components/PreferencesPanel.vue";
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
  markdownMode?: "raw" | "rendered";
}

interface ModalShortcutContextEntry {
  context: ShortcutContext;
  visible: boolean;
  zIndex: number;
}

interface UseAppModalsOptions {
  isMobile: boolean;
  store: ReturnType<typeof useKannaStore>;
  windowWorkspace: WindowWorkspaceController;
}

export function useAppModals({ isMobile, store, windowWorkspace }: UseAppModalsOptions) {
  const showNewTaskModal = ref(false);
  const availablePipelines = ref<string[]>([]);
  const defaultPipelineName = ref<string | undefined>(undefined);
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
  const showFilePreviewModal = ref(false);
  const previewFilePath = ref("");
  const previewInitialLine = ref<number | undefined>(undefined);
  const previewHidden = ref(false);
  const previewFromPicker = ref(false);
  const previewFromTree = ref(false);
  const showImageUrlPreviewModal = ref(false);
  const previewImageUrl = ref("");
  const showDiffModal = ref(false);
  const showTreeExplorer = ref(false);
  const currentWorktreePath = computed(() => {
    if (!store.selectedRepo?.path || !store.currentItem?.branch) return undefined;
    return `${store.selectedRepo.path}/.kanna-worktrees/${store.currentItem.branch}`;
  });
  const activeWorktreePath = computed(() =>
    currentWorktreePath.value ?? store.selectedRepo?.path ?? ""
  );
  const homePath = ref("");
  const treeExplorerRoot = computed(() => {
    if (currentWorktreePath.value) return currentWorktreePath.value;
    if (store.selectedRepo?.path) return store.selectedRepo.path;
    return homePath.value;
  });
  const showShellModal = ref(false);
  const shellRepoRoot = ref(false);
  const shellModalCwd = computed(() => {
    if (shellRepoRoot.value && !store.selectedRepo) return homePath.value;
    if (shellRepoRoot.value) return store.selectedRepo?.path ?? homePath.value;
    return currentWorktreePath.value ?? store.selectedRepo?.path ?? homePath.value;
  });
  const shellModalFallbackCwd = computed(() =>
    shellRepoRoot.value ? undefined : store.selectedRepo?.path
  );
  const showCommandPalette = ref(false);
  const showAnalyticsModal = ref(false);
  const showBlockerSelect = ref(false);
  const blockerSelectMode = ref<"block" | "edit">("block");
  const showPeerPicker = ref(false);
  const showPreferencesPanel = ref(false);
  const sidebarHidden = ref(false);
  const sidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH);
  const maximizedModal = ref<ShortcutContext | null>(null);
  const maximized = computed(() => maximizedModal.value !== null);
  const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null);
  const mainPanelRef = ref<InstanceType<typeof MainPanel> | null>(null);
  const shellModalRef = ref<InstanceType<typeof ShellModal> | null>(null);
  const diffModalRef = ref<InstanceType<typeof DiffModal> | null>(null);
  const showCommitGraphModal = ref(false);
  const commitGraphModalRef = ref<InstanceType<typeof CommitGraphModal> | null>(null);
  const treeExplorerRef = ref<InstanceType<typeof TreeExplorerModal> | null>(null);
  const filePickerRef = ref<InstanceType<typeof FilePickerModal> | null>(null);
  const filePreviewRef = ref<InstanceType<typeof FilePreviewModal> | null>(null);
  const imageUrlPreviewRef = ref<InstanceType<typeof ImageUrlPreviewModal> | null>(null);
  const preferencesRef = ref<InstanceType<typeof PreferencesPanel> | null>(null);
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

  function buildCurrentFileFlowKey(): string | undefined {
    if (store.currentItem) return `item:${store.currentItem.id}`;
    if (store.selectedRepo) return `repo:${store.selectedRepo.id}`;
    return undefined;
  }

  const currentFileFlowKey = computed(() => buildCurrentFileFlowKey());

  function rememberCurrentPreview(filePath: string, initialLine: number | undefined) {
    const key = buildCurrentFileFlowKey();
    if (!key) return;
    filePreviewRecallStates[key] = {
      filePath,
      initialLine,
      markdownMode: filePreviewRecallStates[key]?.markdownMode ?? "raw",
    };
  }

  function getCurrentPreviewRecall(): FilePreviewRecallState | undefined {
    const key = buildCurrentFileFlowKey();
    return key ? filePreviewRecallStates[key] : undefined;
  }

  const currentPreviewMarkdownMode = computed<"raw" | "rendered">(() => {
    const key = currentFileFlowKey.value;
    return (key ? filePreviewRecallStates[key]?.markdownMode : undefined) ?? "raw";
  });

  function updateCurrentPreviewMarkdownMode(mode: "raw" | "rendered") {
    const key = buildCurrentFileFlowKey();
    if (!key) return;
    const current = filePreviewRecallStates[key];
    if (!current) return;
    filePreviewRecallStates[key] = { ...current, markdownMode: mode };
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

  function topPreviewModalContext(): ShortcutContext | null {
    const modalContexts: ModalShortcutContextEntry[] = [
      { context: "diff", visible: showDiffModal.value, zIndex: diffModalRef.value?.zIndex ?? 0 },
      { context: "graph", visible: showCommitGraphModal.value, zIndex: commitGraphModalRef.value?.zIndex ?? 0 },
      { context: "file", visible: showFilePickerModal.value, zIndex: filePickerRef.value?.zIndex ?? 0 },
      { context: "file", visible: showFilePreviewModal.value, zIndex: filePreviewRef.value?.zIndex ?? 0 },
      { context: "tree", visible: showTreeExplorer.value, zIndex: treeExplorerRef.value?.zIndex ?? 0 },
      { context: "shell", visible: showShellModal.value, zIndex: shellModalRef.value?.zIndex ?? 0 },
    ];
    const entries = modalContexts.filter((entry) => entry.visible);

    entries.sort((a, b) => b.zIndex - a.zIndex);
    return entries[0]?.context ?? null;
  }

  // Derive shortcut context from visible modals (more reliable than the global singleton
  // which can be stale if a KeepAlive deactivation resets it after a modal sets it).
  const currentShortcutContext = computed<ShortcutContext>(() => {
    // The shortcuts modal is topmost and should own Escape/help toggles even when
    // it is opened on top of a context like tree or shell that doesn't expose
    // the generic dismiss shortcut.
    if (showShortcutsModal.value) return "main";
    if (showPeerPicker.value) return "transfer";
    if (showNewTaskModal.value) return "newTask";
    const topPreviewContext = topPreviewModalContext();
    if (topPreviewContext) return topPreviewContext;
    return "main";
  });

  function onShellClose() {
    showShellModal.value = false;
    maximizedModal.value = null;
    if (!store.repos.length) {
      mainPanelRef.value?.recheckClis?.();
    }
  }

  function closeTreeExplorer() {
    showTreeExplorer.value = false;
    maximizedModal.value = maximizedModal.value === "tree" ? null : maximizedModal.value;
  }

  function closeFileFlow() {
    showFilePreviewModal.value = false;
    showFilePickerModal.value = false;
    filePickerHidden.value = false;
    maximizedModal.value = maximizedModal.value === "file" ? null : maximizedModal.value;
    previewHidden.value = false;
    previewFromPicker.value = false;
    previewFromTree.value = false;
  }

  watch(currentFileFlowKey, (newKey, oldKey) => {
    if (!oldKey || newKey === oldKey) return;
    closeFileFlow();
  });

  function closeFilePicker() {
    showFilePickerModal.value = false;
    filePickerHidden.value = false;
  }

  function showFilePickerOnTop() {
    previewHidden.value = false;
    showFilePickerModal.value = true;
    filePickerHidden.value = false;
    nextTick(() => filePickerRef.value?.bringToFront?.());
  }

  function openFilePreview(
    filePath: string,
    initialLine: number | undefined,
    fromPicker: boolean,
    fromTree = false
  ) {
    previewFilePath.value = filePath;
    previewInitialLine.value = initialLine;
    rememberCurrentPreview(filePath, initialLine);
    previewFromPicker.value = fromPicker;
    previewFromTree.value = fromTree;
    previewHidden.value = false;
    showFilePreviewModal.value = true;
    nextTick(() => filePreviewRef.value?.bringToFront?.());
  }

  function selectFileFromPicker(filePath: string) {
    showFilePickerModal.value = false;
    filePickerHidden.value = true;
    openFilePreview(filePath, undefined, true);
  }

  function closeFilePreview(reopenPicker: boolean) {
    showFilePreviewModal.value = false;
    maximizedModal.value = maximizedModal.value === "file" ? null : maximizedModal.value;
    previewHidden.value = false;

    const shouldReopenPicker = reopenPicker && previewFromPicker.value;
    previewFromPicker.value = false;
    previewFromTree.value = false;

    if (shouldReopenPicker) {
      showFilePickerOnTop();
    }
  }

  function openImageUrlPreview(imageUrl: string) {
    previewImageUrl.value = imageUrl;
    showImageUrlPreviewModal.value = true;
    nextTick(() => imageUrlPreviewRef.value?.bringToFront?.());
  }

  function closeImageUrlPreview() {
    showImageUrlPreviewModal.value = false;
    previewImageUrl.value = "";
  }

  const anyModalOpen = computed(() =>
    showNewTaskModal.value || showAddRepoModal.value || showShortcutsModal.value ||
    showFilePickerModal.value || showFilePreviewModal.value || showDiffModal.value ||
    showTreeExplorer.value || showShellModal.value || showAnalyticsModal.value ||
    showBlockerSelect.value || showPreferencesPanel.value || showCommitGraphModal.value ||
    showPeerPicker.value || showImageUrlPreviewModal.value
  );
  useRestoreFocus(anyModalOpen);

  return {
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
    showImageUrlPreviewModal,
    previewImageUrl,
    showDiffModal,
    showTreeExplorer,
    currentWorktreePath,
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
    imageUrlPreviewRef,
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
    openImageUrlPreview,
    closeImageUrlPreview,
    getCurrentPreviewRecall,
  };
}
