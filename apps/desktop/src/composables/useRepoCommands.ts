import { ref } from "vue";
import {
  fetchDesktopRepoCommands,
  type DesktopRepoCommandCatalog,
} from "../services/desktopServerClient";

export function useRepoCommands() {
  const catalog = ref<DesktopRepoCommandCatalog | null>(null);
  const scanning = ref(false);
  let generation = 0;

  async function scan(repoId: string): Promise<void> {
    const currentGeneration = ++generation;
    scanning.value = true;
    catalog.value = null;
    try {
      const nextCatalog = await fetchDesktopRepoCommands(repoId);
      if (currentGeneration === generation) {
        catalog.value = nextCatalog;
      }
    } catch (error) {
      if (currentGeneration === generation) {
        catalog.value = null;
        console.error("[useRepoCommands] command catalog scan failed:", error);
      }
    } finally {
      if (currentGeneration === generation) {
        scanning.value = false;
      }
    }
  }

  function cancel(): void {
    generation += 1;
    scanning.value = false;
  }

  return { catalog, scanning, scan, cancel };
}
