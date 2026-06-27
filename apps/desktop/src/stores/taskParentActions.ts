import { updatePipelineItemParent } from "@kanna/db";
import { validateParentAssignment } from "../utils/taskParenting";
import { requireService, type StoreContext } from "./state";
import type { TasksApi } from "./tasks";

export function createTaskParentActions(
  context: StoreContext,
): Pick<TasksApi, "setTaskParent"> {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };

  async function setTaskParent(itemId: string, parentId: string | null) {
    const items = context.state.items.value;
    const child = items.find((item) => item.id === itemId);
    if (!child) return;

    if (parentId) {
      if (!items.some((item) => item.id === parentId)) return;
      const error = validateParentAssignment(items, itemId, parentId);
      if (error === "same-task" || error === "cycle") {
        context.toast.warning(context.tt("toasts.setParentCycle"));
        return;
      }
      if (error === "different-repo") {
        context.toast.warning(context.tt("toasts.setParentDifferentRepo"));
        return;
      }
    }

    if ((child.parent_task_id ?? null) === parentId) return;

    await updatePipelineItemParent(context.requireDb(), itemId, parentId);
    await reloadSnapshot();
    await invalidateWindowWorkspace("setTaskParent");
  }

  return {
    setTaskParent,
  };
}
