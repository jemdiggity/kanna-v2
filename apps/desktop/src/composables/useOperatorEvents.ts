import { type Ref } from "vue";
import type { DbHandle } from "@kanna/db";
import { insertOperatorEvent } from "@kanna/db";

export function useOperatorEvents(db: Ref<DbHandle | null>): () => void {
  function handleVisibilityChange() {
    if (!db.value) return;
    const eventType = document.hidden ? "app_blur" : "app_focus";
    insertOperatorEvent(db.value, eventType, null, null).catch((e) =>
      console.error("[operator-events] failed:", e)
    );
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
