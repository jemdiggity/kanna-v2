import { ref, computed, watch, type Ref } from "vue";
import type { DbHandle, PipelineItem, ActivityLog } from "@kanna/db";

interface TaskBucket {
  label: string;
  created: number;
  closed: number;
}

type BucketSize = "daily" | "weekly" | "monthly";

export function useAnalytics(db: Ref<DbHandle | null>, repoId: Ref<string | null>) {
  const taskBuckets = ref<TaskBucket[]>([]);
  const bucketSize = ref<BucketSize>("daily");
  const hasData = ref(false);
  const loading = ref(false);

  const headlineStats = computed(() => {
    const totalCreated = taskBuckets.value.reduce((sum, b) => sum + b.created, 0);
    const totalClosed = taskBuckets.value.reduce((sum, b) => sum + b.closed, 0);
    return {
      totalCreated,
      totalClosed,
      open: totalCreated - totalClosed,
    };
  });

  const avgTimeInState = ref({ working: 0, idle: 0, unread: 0 });

  function detectBucketSize(minDate: string): BucketSize {
    const now = Date.now();
    const min = new Date(minDate + "Z").getTime();
    const days = (now - min) / 86400000;
    if (days < 14) return "daily";
    if (days < 90) return "weekly";
    return "monthly";
  }

  function bucketKey(dateStr: string, size: BucketSize): string {
    const d = new Date(dateStr + "Z");
    if (size === "daily") return d.toISOString().slice(0, 10);
    if (size === "weekly") {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      return monday.toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 7);
  }

  function bucketLabel(key: string, size: BucketSize): string {
    if (size === "daily") {
      const d = new Date(key + "T00:00:00Z");
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    if (size === "weekly") {
      const d = new Date(key + "T00:00:00Z");
      return "W/" + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    const d = new Date(key + "-01T00:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }

  async function refresh() {
    if (!db.value || !repoId.value) {
      hasData.value = false;
      taskBuckets.value = [];
      avgTimeInState.value = { working: 0, idle: 0, unread: 0 };
      return;
    }
    loading.value = true;
    try {
      const items = await db.value.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE repo_id = ? ORDER BY created_at ASC",
        [repoId.value]
      );
      hasData.value = items.length > 0;
      if (!hasData.value) {
        taskBuckets.value = [];
        avgTimeInState.value = { working: 0, idle: 0, unread: 0 };
        return;
      }

      // --- Tasks created / closed per day ---
      const size = detectBucketSize(items[0].created_at);
      bucketSize.value = size;

      const bucketMap = new Map<string, { created: number; closed: number }>();
      for (const item of items) {
        const key = bucketKey(item.created_at, size);
        const entry = bucketMap.get(key) || { created: 0, closed: 0 };
        entry.created++;
        bucketMap.set(key, entry);
      }
      for (const item of items) {
        if (item.closed_at) {
          const key = bucketKey(item.closed_at, size);
          const entry = bucketMap.get(key) || { created: 0, closed: 0 };
          entry.closed++;
          bucketMap.set(key, entry);
        }
      }
      const sortedKeys = [...bucketMap.keys()].sort();
      taskBuckets.value = sortedKeys.map((key) => ({
        label: bucketLabel(key, size),
        created: bucketMap.get(key)!.created,
        closed: bucketMap.get(key)!.closed,
      }));

      // --- Avg Time in State ---
      const doneItems = items.filter((i) => i.stage === "done");
      const logs = await db.value.select<ActivityLog>(
        `SELECT al.* FROM activity_log al
         JOIN pipeline_item pi ON al.pipeline_item_id = pi.id
         WHERE pi.repo_id = ? AND pi.stage = 'done'
         ORDER BY al.pipeline_item_id, al.started_at ASC`,
        [repoId.value]
      );

      const grouped = new Map<string, ActivityLog[]>();
      for (const log of logs) {
        const arr = grouped.get(log.pipeline_item_id) || [];
        arr.push(log);
        grouped.set(log.pipeline_item_id, arr);
      }

      const itemMap = new Map<string, PipelineItem>();
      for (const item of doneItems) itemMap.set(item.id, item);

      const totals = { working: 0, idle: 0, unread: 0 };
      let taskCount = 0;

      for (const item of doneItems) {
        const itemLogs = grouped.get(item.id);
        if (!itemLogs || itemLogs.length === 0) continue;
        taskCount++;
        for (let i = 0; i < itemLogs.length; i++) {
          const endTime = i + 1 < itemLogs.length
            ? itemLogs[i + 1].started_at
            : item.updated_at;
          const start = new Date(itemLogs[i].started_at + "Z").getTime();
          const end = new Date(endTime + "Z").getTime();
          const seconds = Math.max(0, (end - start) / 1000);
          const activity = itemLogs[i].activity as keyof typeof totals;
          if (activity in totals) totals[activity] += seconds;
        }
      }

      if (taskCount > 0) {
        avgTimeInState.value = {
          working: totals.working / taskCount,
          idle: totals.idle / taskCount,
          unread: totals.unread / taskCount,
        };
      } else {
        avgTimeInState.value = { working: 0, idle: 0, unread: 0 };
      }
    } catch (e) {
      console.error("[analytics] refresh failed:", e);
    } finally {
      loading.value = false;
    }
  }

  watch([db, repoId], refresh, { immediate: true });

  return {
    taskBuckets,
    bucketSize,
    headlineStats,
    avgTimeInState,
    hasData,
    loading,
    refresh,
  };
}
