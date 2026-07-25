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

function sameObservation(
  left: RemoteSelectionObservation | null,
  right: RemoteSelectionObservation | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.itemId === right.itemId
    && left.ownerDesktopId === right.ownerDesktopId
    && left.ownerLocalTaskId === right.ownerLocalTaskId
    && left.activityRevision === right.activityRevision
  );
}

export function useRemoteTaskReadDwell({
  selectedItemId,
  workspaceTasksByItemId,
  markTaskRead,
}: UseRemoteTaskReadDwellOptions): void {
  const observedSelection = shallowRef<RemoteSelectionObservation | null>(null);

  watch(
    [selectedItemId, workspaceTasksByItemId],
    ([itemId, taskMap]) => {
      const task = itemId ? taskMap.get(itemId) : null;
      const activityRevision = task?.item.activity_revision;
      const remoteRef = task?.terminal.remoteRef;
      const nextObservation = (
        itemId
        && task
        && task.owner.kind !== "local"
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
      if (!sameObservation(observedSelection.value, nextObservation)) {
        observedSelection.value = nextObservation;
      }
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
