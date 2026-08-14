import { type Ref } from "vue";
import type { DbHandle } from "../types/kanna";
import { postDesktopOperatorEvent } from "../services/desktopServerClient";

export function useOperatorEvents(db: Ref<DbHandle | null>): () => void {
  function handleVisibilityChange() {
    if (!db.value) return;
    const eventType = document.hidden ? "app_blur" : "app_focus";
    postDesktopOperatorEvent({ eventType, workflowItemId: null, repoId: null }).catch((e) =>
      console.error("[operator-events] failed:", e)
    );
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
