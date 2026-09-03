import { defineStore } from "pinia";
import { useToast } from "../composables/useToast";
import { createStoreContext, createStoreState, type StoreServices } from "./state";
import { createPortsStore } from "./ports";
import { createQueriesApi } from "./queries";
import { createSelectionApi } from "./selection";
import { recordSelectionIntent as recordStoreSelectionIntent } from "./selectionIntent";
import { createSessionsApi } from "./sessions";
import { createWorkflowApi } from "./workflow";
import { createTasksApi } from "./tasks";
import { createTransferApi } from "./transfer";
import { createInitApi } from "./init";
import type { WindowWorkspaceController } from "../windowWorkspace";
import { fetchDesktopSnapshot } from "../services/desktopServerClient";

export { fetchRepoConfig } from "./state";
export { collectTeardownCommands } from "./tasks";

export const useKannaStore = defineStore("kanna", () => {
  const toast = useToast();
  const state = createStoreState();
  const services: StoreServices = {};
  services.fetchSnapshot = fetchDesktopSnapshot;
  const context = createStoreContext(state, toast, services);

  const ports = createPortsStore(context);
  const queries = createQueriesApi(context);
  const selection = createSelectionApi(context);
  const sessions = createSessionsApi(context);
  const workflow = createWorkflowApi(context);
  const tasks = createTasksApi(context);
  const initApi = createInitApi(context, ports, tasks);

  services.loadInitialData = queries.loadInitialData;
  services.reloadSnapshot = queries.reloadSnapshot;
  services.withOptimisticItemOverlay = queries.withOptimisticItemOverlay;
  services.selectedRepo = selection.selectedRepo;
  services.currentItem = selection.currentItem;
  services.selectedTaskId = selection.selectedTaskId;
  services.currentTaskSlot = selection.currentTaskSlot;
  services.persistSelection = selection.persistSelection;
  services.sortedItemsForCurrentRepo = selection.sortedItemsForCurrentRepo;
  services.sortedItemsAllRepos = selection.sortedItemsAllRepos;
  services.isItemHidden = selection.isItemHidden;
  services.getStageOrder = selection.getStageOrder;
  services.selectRepo = selection.selectRepo;
  services.selectItem = selection.selectItem;
  services.selectReplacementAfterItemRemoval = selection.selectReplacementAfterItemRemoval;
  services.reconcileSelection = selection.reconcileSelection;
  services.restoreSelection = selection.restoreSelection;

  services.applyTaskRuntimeStatus = sessions.applyTaskRuntimeStatus;
  services.getAgentProviderAvailability = sessions.getAgentProviderAvailability;
  services.waitForSessionExit = sessions.waitForSessionExit;
  services.resolveSessionExitWaiters = sessions.resolveSessionExitWaiters;
  services.resolveSessionCreatedWaiters = sessions.resolveSessionCreatedWaiters;
  services.persistExitedSessionResumeId = sessions.persistExitedSessionResumeId;
  services.spawnShellSession = sessions.spawnShellSession;
  services.prewarmWorktreeShellSession = sessions.prewarmWorktreeShellSession;
  services.preparePtySession = sessions.preparePtySession;
  services.spawnPtySession = sessions.spawnPtySession;
  services.recoverTaskSession = sessions.recoverTaskSession;

  services.loadWorkflow = workflow.loadWorkflow;
  services.loadAgent = workflow.loadAgent;
  services.advanceStage = workflow.advanceStage;
  services.requestRevision = workflow.requestRevision;
  services.rerunStage = workflow.rerunStage;

  services.createItem = tasks.createItem;
  services.closeTask = tasks.closeTask;
  services.undoClose = tasks.undoClose;
  services.checkUnblocked = tasks.checkUnblocked;
  services.startBlockedTask = tasks.startBlockedTask;
  services.blockTask = tasks.blockTask;
  services.editBlockedTask = tasks.editBlockedTask;

  const transfer = createTransferApi();

  async function makePR() {
    const item = selection.currentItem.value;
    if (!item) return;
    try {
      await workflow.advanceStage(item.id);
    } catch (error) {
      console.error("[store] stage advance failed:", error);
      toast.error(context.tt("toasts.prAgentFailed"));
    }
  }

  async function mergeQueue() {
    if (!state.selectedRepoId.value) {
      if (state.repos.value.length === 1) {
        state.selectedRepoId.value = state.repos.value[0].id;
      } else {
        toast.warning(context.tt("toasts.selectRepoFirst"));
        return;
      }
    }

    const repo = state.repos.value.find((candidate) => candidate.id === state.selectedRepoId.value);
    if (!repo) return;

    try {
      const agent = await workflow.loadAgent(repo.id, "merge");
      const targetBranch = repo.default_branch || "main";
      const prompt = `${agent.prompt.trim()}

## Runtime Merge Context

Default target branch for this merge run: ${targetBranch}

Use this branch as the default when the user does not specify a target branch. Before merging, verify it against the repository's remote default branch with \`git symbolic-ref --short refs/remotes/origin/HEAD\` or \`git remote show origin\`. If the verified default branch differs from this value, ask the user which branch to use.`;

      await tasks.createItem(repo.id, repo.path, prompt, "pty");
    } catch (error) {
      console.error("[store] merge agent failed to start:", error);
      toast.error(context.tt("toasts.mergeAgentFailed"));
    }
  }

  function attachWindowWorkspace(windowWorkspace: WindowWorkspaceController): void {
    services.windowWorkspace = windowWorkspace;
    state.initialWindowBootstrap.value = windowWorkspace.bootstrap;
  }

  function recordSelectionIntent(): void {
    recordStoreSelectionIntent(state);
  }

  return {
    repos: state.repos,
    items: state.items,
    taskUiSlots: state.taskUiSlots,
    taskBlockers: state.taskBlockers,
    blockerTaskStates: state.blockerTaskStates,
    snapshotSettings: state.snapshotSettings,
    repoSidebarOrder: state.repoSidebarOrder,
    selectedRepoId: state.selectedRepoId,
    selectedItemId: state.selectedItemId,
    lastSelectedItemByRepo: state.lastSelectedItemByRepo,
    canGoBack: selection.canGoBack,
    canGoForward: selection.canGoForward,
    suspendAfterMinutes: state.suspendAfterMinutes,
    killAfterMinutes: state.killAfterMinutes,
    ideCommand: state.ideCommand,
    hideShortcutsOnStartup: state.hideShortcutsOnStartup,
    devLingerTerminals: state.devLingerTerminals,
    appTheme: state.appTheme,
    codeTheme: state.codeTheme,
    agentMessageAppearance: state.agentMessageAppearance,
    markdownPreviewMode: state.markdownPreviewMode,
    lastHiddenRepoId: state.lastHiddenRepoId,
    selectedRepo: selection.selectedRepo,
    currentItem: selection.currentItem,
    selectedTaskId: selection.selectedTaskId,
    currentTaskSlot: selection.currentTaskSlot,
    sortedItemsForCurrentRepo: selection.sortedItemsForCurrentRepo,
    sortedItemsAllRepos: selection.sortedItemsAllRepos,
    getStageOrder: selection.getStageOrder,

    init: initApi.init,
    reloadSnapshot: queries.reloadSnapshot,
    attachWindowWorkspace,
    recordSelectionIntent,
    selectRepo: selection.selectRepo,
    selectItem: selection.selectItem,
    recordNavigation: selection.recordNavigation,
    takeBackTarget: selection.takeBackTarget,
    takeForwardTarget: selection.takeForwardTarget,
    persistSelection: selection.persistSelection,

    importRepo: tasks.importRepo,
    createRepo: tasks.createRepo,
    cloneAndImportRepo: tasks.cloneAndImportRepo,
    hideRepo: tasks.hideRepo,
    renameRepo: tasks.renameRepo,
    reorderRepos: tasks.reorderRepos,

    createItem: tasks.createItem,
    spawnPtySession: sessions.spawnPtySession,
    recoverTaskSession: sessions.recoverTaskSession,
    spawnShellSession: sessions.spawnShellSession,
    closeTask: tasks.closeTask,
    undoClose: tasks.undoClose,

    advanceStage: workflow.advanceStage,
    requestRevision: workflow.requestRevision,
    rerunStage: workflow.rerunStage,
    loadWorkflow: workflow.loadWorkflow,
    loadAgent: workflow.loadAgent,

    makePR,
    mergeQueue,
    pushTaskToPeer: transfer.pushTaskToPeer,
    approveIncomingTransfer: transfer.approveIncomingTransfer,
    rejectIncomingTransfer: transfer.rejectIncomingTransfer,
    blockTask: tasks.blockTask,
    editBlockedTask: tasks.editBlockedTask,
    listBlockersForItem: async (itemId: string) =>
      state.taskBlockers.value
        .filter((blocker) => blocker.blocked_item_id === itemId)
        .map((blocker) => state.items.value.find((item) => item.id === blocker.blocker_item_id))
        .filter((item): item is NonNullable<typeof item> => item != null),
    listBlockedByItem: async (itemId: string) =>
      state.taskBlockers.value
        .filter((blocker) => blocker.blocker_item_id === itemId)
        .map((blocker) => state.items.value.find((item) => item.id === blocker.blocked_item_id))
        .filter((item): item is NonNullable<typeof item> => item != null),
    pinItem: tasks.pinItem,
    unpinItem: tasks.unpinItem,
    reorderPinned: tasks.reorderPinned,
    renameItem: tasks.renameItem,
    setTaskParent: tasks.setTaskParent,
    savePreference: initApi.savePreference,
  };
});
