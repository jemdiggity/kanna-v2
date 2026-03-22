import { watch, type Ref } from "vue";
import { useDebounceFn } from "@vueuse/core";
import type { DbHandle, PipelineItem } from "@kanna/db";
import * as dbModule from "@kanna/db";

export function useMarkAsRead(
  db: Ref<DbHandle | null>,
  selectedItemId: Ref<string | null>,
  allItems: Ref<PipelineItem[]>
): void {
  const markAsRead = useDebounceFn(
    (itemId: string, selectionTime: number) => {
      if (!db.value) return;
      const item = allItems.value.find((i) => i.id === itemId);
      if (!item || item.activity !== "unread") return;

      // Guard: skip if a hook updated activity after we selected the item.
      // activity_changed_at can be ISO 8601 or SQLite datetime('now') format —
      // Date.parse handles both correctly.
      if (item.activity_changed_at !== null) {
        const changedAt = new Date(item.activity_changed_at).getTime();
        if (changedAt > selectionTime) return;
      }

      dbModule.updatePipelineItemActivity(db.value, itemId, "idle").catch((e) => {
        console.error("[useMarkAsRead] failed to update activity:", e);
      });
      item.activity = "idle";
    },
    1000
  );

  watch(selectedItemId, (itemId) => {
    if (itemId) {
      markAsRead(itemId, Date.now());
    }
  });
}
