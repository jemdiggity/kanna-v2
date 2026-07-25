import { shallowRef, watch, type ComputedRef, type Ref } from "vue";
import type { WorkspaceTask } from "../workspace/types";

interface UseRemoteTaskReadDwellOptions {
  selectedItemId: Ref<string | null>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  markTaskRead: (task: WorkspaceTask, expectedActivityRevision: number) => Promise<void>;
}

interface RemoteSelectionObservation {
  itemId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
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
      const remoteRef = task.terminal.remoteRef;
      observedSelection.value = (
        task.owner.kind !== "local"
        && remoteRef
        && task.item.activity === "unread"
        && typeof activityRevision === "number"
        && Number.isSafeInteger(activityRevision)
        && activityRevision >= 0
      )
        ? {
            itemId,
            ownerDesktopId: remoteRef.ownerDesktopId,
            ownerLocalTaskId: remoteRef.ownerLocalTaskId,
            activityRevision,
          }
        : null;
    },
    { flush: "sync", immediate: true },
  );

  watch(
    observedSelection,
    (observation, _previousObservation, onCleanup) => {
      if (!observation) return;

      let cancelled = false;
      const timer = setTimeout(async () => {
        if (cancelled || selectedItemId.value !== observation.itemId) return;
        const task = workspaceTasksByItemId.value.get(observation.itemId);
        if (!task || task.owner.kind === "local" || task.item.activity !== "unread") return;
        const remoteRef = task.terminal.remoteRef;
        if (
          !remoteRef
          || remoteRef.ownerDesktopId !== observation.ownerDesktopId
          || remoteRef.ownerLocalTaskId !== observation.ownerLocalTaskId
        ) return;
        if (task.item.activity_revision !== observation.activityRevision) return;
        await markTaskRead(task, observation.activityRevision);
      }, 1000);

      onCleanup(() => {
        cancelled = true;
        clearTimeout(timer);
      });
    },
    { immediate: true },
  );
}
