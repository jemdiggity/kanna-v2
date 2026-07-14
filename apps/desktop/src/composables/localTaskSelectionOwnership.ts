import type { Ref } from "vue";
import type { useKannaStore } from "../stores/kanna";

interface ClaimLocalTaskSelectionOwnershipOptions {
  store: ReturnType<typeof useKannaStore>;
  repoId: string;
  selectedCloudRepoId: Ref<string | null>;
  selectedCloudItemId: Ref<string | null>;
}

export function claimLocalTaskSelectionOwnership({
  store,
  repoId,
  selectedCloudRepoId,
  selectedCloudItemId,
}: ClaimLocalTaskSelectionOwnershipOptions): void {
  const selectedItemId = store.selectedItemId;
  const selectedItemIsLocal = selectedItemId !== null && (
    store.taskUiSlots.some((slot) =>
      slot.slot_id === selectedItemId && slot.draft.repo_id === repoId,
    )
  );
  const hadCloudOwnership = selectedCloudRepoId.value !== null || selectedCloudItemId.value !== null;

  selectedCloudRepoId.value = null;
  selectedCloudItemId.value = null;
  store.selectedRepoId = repoId;

  if (selectedItemId !== null && !selectedItemIsLocal) {
    store.selectedItemId = null;
    if (store.lastSelectedItemByRepo[repoId] === selectedItemId) {
      delete store.lastSelectedItemByRepo[repoId];
    }
  }

  if (!hadCloudOwnership && (selectedItemId === null || selectedItemIsLocal)) return;
  void store.persistSelection().catch((error) => {
    console.error("[App] failed to persist local task selection ownership:", error);
  });
}
