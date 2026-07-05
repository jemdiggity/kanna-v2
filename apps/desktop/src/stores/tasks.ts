import type { PipelineItem } from "@kanna/db";
import type { AgentExecutionType } from "./agentExecutionType";
import type { CreateItemOptions, StoreContext } from "./state";
import type { PortsStore } from "./ports";
import { createTaskBlockedActions } from "./taskBlockedActions";
import { createTaskCloseActions } from "./taskCloseActions";
import { createTaskItemActions } from "./taskItemActions";
import { createTaskMetadataActions } from "./taskMetadataActions";
import { createTaskParentActions } from "./taskParentActions";
import { createTaskRepoActions } from "./taskRepoActions";

export { collectTeardownCommands } from "./taskLifecycleEnv";

export interface TasksApi {
  importRepo: (path: string, name: string, defaultBranch: string) => Promise<string>;
  createRepo: (name: string, path: string) => Promise<void>;
  cloneAndImportRepo: (url: string, destination: string) => Promise<void>;
  hideRepo: (repoId: string) => Promise<void>;
  renameRepo: (repoId: string, name: string) => Promise<void>;
  reorderRepos: (orderedIds: string[]) => Promise<void>;
  createItem: (
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType?: AgentExecutionType,
    opts?: CreateItemOptions,
  ) => Promise<string>;
  closeTask: (targetItemId?: string, opts?: { selectNext?: boolean }) => Promise<void>;
  undoClose: () => Promise<void>;
  blockTask: (blockerIds: string[]) => Promise<void>;
  editBlockedTask: (itemId: string, newBlockerIds: string[]) => Promise<void>;
  checkUnblocked: (blockerItemId: string) => Promise<void>;
  restoreUnblockedTask: (item: PipelineItem) => Promise<void>;
  startBlockedTask: (item: PipelineItem) => Promise<void>;
  pinItem: (itemId: string, position: number) => Promise<void>;
  unpinItem: (itemId: string) => Promise<void>;
  reorderPinned: (repoId: string, orderedIds: string[]) => Promise<void>;
  renameItem: (itemId: string, displayName: string | null) => Promise<void>;
  setTaskParent: (itemId: string, parentId: string | null) => Promise<void>;
  handleAgentFinished: (sessionId: string) => Promise<void>;
}

export function createTasksApi(
  context: StoreContext,
  ports: PortsStore,
): TasksApi {
  const repoActions = createTaskRepoActions(context);
  const itemActions = createTaskItemActions(context, ports);
  const blockedActions = createTaskBlockedActions(context, ports);
  const closeActions = createTaskCloseActions(context, {
    checkUnblocked: blockedActions.checkUnblocked,
  });
  const metadataActions = createTaskMetadataActions(context);
  const parentActions = createTaskParentActions(context);

  return {
    importRepo: repoActions.importRepo,
    createRepo: repoActions.createRepo,
    cloneAndImportRepo: repoActions.cloneAndImportRepo,
    hideRepo: repoActions.hideRepo,
    renameRepo: repoActions.renameRepo,
    reorderRepos: repoActions.reorderRepos,
    createItem: itemActions.createItem,
    closeTask: closeActions.closeTask,
    undoClose: closeActions.undoClose,
    blockTask: blockedActions.blockTask,
    editBlockedTask: blockedActions.editBlockedTask,
    checkUnblocked: blockedActions.checkUnblocked,
    restoreUnblockedTask: blockedActions.restoreUnblockedTask,
    startBlockedTask: blockedActions.startBlockedTask,
    pinItem: metadataActions.pinItem,
    unpinItem: metadataActions.unpinItem,
    reorderPinned: metadataActions.reorderPinned,
    renameItem: metadataActions.renameItem,
    setTaskParent: parentActions.setTaskParent,
    handleAgentFinished: closeActions.handleAgentFinished,
  };
}
