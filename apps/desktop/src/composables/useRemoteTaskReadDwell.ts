import { watchDebounced } from "@vueuse/core";
import { watch, type ComputedRef, type Ref } from "vue";
import type { WorkspaceTask } from "../workspace/types";

interface UseRemoteTaskReadDwellOptions {
  selectedItemId: Ref<string | null>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  markTaskRead: (task: WorkspaceTask, activityCutoff: string) => Promise<void>;
}

export function useRemoteTaskReadDwell({
  selectedItemId,
  workspaceTasksByItemId,
  markTaskRead,
}: UseRemoteTaskReadDwellOptions): void {
  let selectionTime = Date.now();
  watch(
    selectedItemId,
    () => {
      selectionTime = Date.now();
    },
    { flush: "sync" },
  );

  watchDebounced(
    selectedItemId,
    async (itemId) => {
      if (!itemId) return;
      const activityCutoff = new Date(selectionTime).toISOString();
      const task = workspaceTasksByItemId.value.get(itemId);
      if (!task || task.owner.kind === "local" || task.item.activity !== "unread") return;
      if (
        task.item.activity_changed_at
        && new Date(task.item.activity_changed_at).getTime() > selectionTime
      ) {
        return;
      }
      await markTaskRead(task, activityCutoff);
    },
    { debounce: 1000 },
  );
}
