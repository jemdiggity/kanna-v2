import {
  pinPipelineItem,
  reorderPinnedItems,
  unpinPipelineItem,
  updatePipelineItemDisplayName,
} from "@kanna/db";
import { requireService, type StoreContext } from "./state";
import type { TasksApi } from "./tasks";

export function createTaskMetadataActions(
  context: StoreContext,
): Pick<TasksApi, "pinItem" | "unpinItem" | "reorderPinned" | "renameItem"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function pinItem(itemId: string, position: number) {
    await pinPipelineItem(context.requireDb(), itemId, position);
    await reloadSnapshot();
    await invalidateWindowWorkspace("pinItem");
  }

  async function unpinItem(itemId: string) {
    await unpinPipelineItem(context.requireDb(), itemId);
    await reloadSnapshot();
    await invalidateWindowWorkspace("unpinItem");
  }

  async function reorderPinned(repoId: string, orderedIds: string[]) {
    await reorderPinnedItems(context.requireDb(), repoId, orderedIds);
    await reloadSnapshot();
    await invalidateWindowWorkspace("reorderPinned");
  }

  async function renameItem(itemId: string, displayName: string | null) {
    await updatePipelineItemDisplayName(context.requireDb(), itemId, displayName);
    await reloadSnapshot();
    await invalidateWindowWorkspace("renameItem");
  }


  return {
    pinItem,
    unpinItem,
    reorderPinned,
    renameItem,
  };
}
