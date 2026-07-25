import { watchDebounced } from "@vueuse/core";
import type { ComputedRef, Ref } from "vue";
import type { WorkspaceTask } from "../workspace/types";

interface UseRemoteTaskReadDwellOptions {
  selectedItemId: Ref<string | null>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  markTaskRead: (task: WorkspaceTask) => Promise<void>;
}

export function useRemoteTaskReadDwell({
  selectedItemId,
  workspaceTasksByItemId,
  markTaskRead,
}: UseRemoteTaskReadDwellOptions): void {
  watchDebounced(
    selectedItemId,
    async (itemId) => {
      if (!itemId) return;
      const selectionTime = Date.now() - 1000;
      const task = workspaceTasksByItemId.value.get(itemId);
      if (!task || task.owner.kind === "local" || task.item.activity !== "unread") return;
      if (
        task.item.activity_changed_at
        && new Date(task.item.activity_changed_at).getTime() > selectionTime
      ) {
        return;
      }
      await markTaskRead(task);
    },
    { debounce: 1000 },
  );
}
