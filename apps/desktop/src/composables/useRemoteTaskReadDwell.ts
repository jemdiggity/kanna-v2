import { watchDebounced } from "@vueuse/core";
import { shallowRef, watch, type ComputedRef, type Ref } from "vue";
import type { WorkspaceTask } from "../workspace/types";

interface UseRemoteTaskReadDwellOptions {
  selectedItemId: Ref<string | null>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  markTaskRead: (task: WorkspaceTask, expectedActivityRevision: number) => Promise<void>;
}

interface RemoteSelectionObservation {
  itemId: string;
  activityRevision: number;
}

export function useRemoteTaskReadDwell({
  selectedItemId,
  workspaceTasksByItemId,
  markTaskRead,
}: UseRemoteTaskReadDwellOptions): void {
  const observedSelection = shallowRef<RemoteSelectionObservation | null>(null);
  let pendingItemId: string | null = null;

  watch(
    [selectedItemId, workspaceTasksByItemId],
    ([itemId, taskMap], previous) => {
      const previousItemId = previous?.[0] ?? null;
      if (!itemId) {
        pendingItemId = null;
        observedSelection.value = null;
        return;
      }

      const selectionChanged = itemId !== previousItemId;
      if (!selectionChanged && pendingItemId !== itemId) return;

      const task = taskMap.get(itemId);
      if (!task) {
        pendingItemId = itemId;
        observedSelection.value = null;
        return;
      }

      pendingItemId = null;
      const activityRevision = task.item.activity_revision;
      observedSelection.value = (
        task.owner.kind !== "local"
        && task.item.activity === "unread"
        && typeof activityRevision === "number"
        && Number.isSafeInteger(activityRevision)
        && activityRevision >= 0
      )
        ? { itemId, activityRevision }
        : null;
    },
    { flush: "sync", immediate: true },
  );

  watchDebounced(
    observedSelection,
    async (observation) => {
      if (!observation || selectedItemId.value !== observation.itemId) return;
      const task = workspaceTasksByItemId.value.get(observation.itemId);
      if (!task || task.owner.kind === "local" || task.item.activity !== "unread") return;
      if (task.item.activity_revision !== observation.activityRevision) return;
      await markTaskRead(task, observation.activityRevision);
    },
    { debounce: 1000, immediate: true },
  );
}
