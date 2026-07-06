import type { PipelineItem } from "@kanna/db";
import { blockDesktopTask, unblockDesktopTask } from "../services/desktopServerClient";
import { requireService, type StoreContext } from "./state";
import type { TasksApi } from "./tasks";

export function createTaskBlockedActions(
  context: StoreContext,
): Pick<TasksApi, "blockTask" | "editBlockedTask" | "checkUnblocked" | "restoreUnblockedTask" | "startBlockedTask"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function blockTask(blockerIds: string[]) {
    const item = requireService(context.services.currentItem, "currentItem").value;
    const repo = requireService(context.services.selectedRepo, "selectedRepo").value;
    const isItemHidden = requireService(context.services.isItemHidden as ((item: PipelineItem) => boolean) | undefined, "isItemHidden");
    if (!item || !repo || isItemHidden(item)) return;

    await blockDesktopTask(item.id, blockerIds);
    await reloadSnapshot();
    await invalidateWindowWorkspace("blockTask");
    await requireService(context.services.selectItem, "selectItem")(item.id);
  }

  async function editBlockedTask(itemId: string, newBlockerIds: string[]) {
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    if (!item) return;

    if (newBlockerIds.length > 0) {
      await blockDesktopTask(itemId, newBlockerIds);
    } else {
      await unblockDesktopTask(itemId);
    }

    await reloadSnapshot();
    await invalidateWindowWorkspace("editBlockedTask");
  }

  async function checkUnblocked(_blockerItemId: string): Promise<void> {
    // Server-owned close/unblock actions start newly unblocked dependents.
  }

  async function restoreUnblockedTask(_item: PipelineItem): Promise<void> {
    // Server-owned close/unblock actions start newly unblocked dependents.
  }

  async function startBlockedTask(_item: PipelineItem): Promise<void> {
    // Server-owned close/unblock actions start dormant blocked tasks.
  }

  return {
    blockTask,
    editBlockedTask,
    checkUnblocked,
    restoreUnblockedTask,
    startBlockedTask,
  };
}
