import { ref, computed, watch, type Ref } from "vue";
import type { DbHandle, PipelineItem, ActivityLog } from "@kanna/db";

interface ThroughputBucket {
  label: string;
  created: number;
  completed: number;
}

interface ActivityBreakdown {
  itemId: string;
  label: string;
  working: number;  // seconds
  idle: number;     // seconds
  unread: number;   // seconds
}

type BucketSize = "daily" | "weekly" | "monthly";

export function useAnalytics(db: Ref<DbHandle | null>, repoId: Ref<string | null>) {
  const throughputBuckets = ref<ThroughputBucket[]>([]);
  const activityBreakdowns = ref<ActivityBreakdown[]>([]);
  const bucketSize = ref<BucketSize>("daily");
  const hasData = ref(false);
  const loading = ref(false);

  const headlineStats = computed(() => {
    const totalCreated = throughputBuckets.value.reduce((sum, b) => sum + b.created, 0);
    const totalCompleted = throughputBuckets.value.reduce((sum, b) => sum + b.completed, 0);
    const completionRate = totalCreated > 1 ? Math.round((totalCompleted / totalCreated) * 100) : null;

    const totalWorking = activityBreakdowns.value.reduce((sum, b) => sum + b.working, 0);
    const totalIdle = activityBreakdowns.value.reduce((sum, b) => sum + b.idle, 0);
    const totalUnread = activityBreakdowns.value.reduce((sum, b) => sum + b.unread, 0);
    const count = activityBreakdowns.value.length || 1;

    return {
      tasksCreated: totalCreated,
      tasksCompleted: totalCompleted,
      completionRate,
      avgWorking: totalWorking / count,
      avgIdle: totalIdle / count,
      avgUnread: totalUnread / count,
    };
  });

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
    return d.toISOString().slice(0, 7); // YYYY-MM
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
      throughputBuckets.value = [];
      activityBreakdowns.value = [];
      return;
    }
    loading.value = true;
    try {
      // --- Throughput ---
      const items = await db.value.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE repo_id = ? ORDER BY created_at ASC",
        [repoId.value]
      );
      hasData.value = items.length > 0;
      if (!hasData.value) {
        throughputBuckets.value = [];
        activityBreakdowns.value = [];
        return;
      }

      const size = detectBucketSize(items[0].created_at);
      bucketSize.value = size;

      const bucketMap = new Map<string, { created: number; completed: number }>();
      for (const item of items) {
        const key = bucketKey(item.created_at, size);
        const entry = bucketMap.get(key) || { created: 0, completed: 0 };
        entry.created++;
        bucketMap.set(key, entry);
      }
      for (const item of items) {
        if (item.stage === "done") {
          const key = bucketKey(item.updated_at, size);
          const entry = bucketMap.get(key) || { created: 0, completed: 0 };
          entry.completed++;
          bucketMap.set(key, entry);
        }
      }
      const sortedKeys = [...bucketMap.keys()].sort();
      throughputBuckets.value = sortedKeys.map((key) => ({
        label: bucketLabel(key, size),
        created: bucketMap.get(key)!.created,
        completed: bucketMap.get(key)!.completed,
      }));

      // --- Activity Time ---
      const logs = await db.value.select<ActivityLog>(
        `SELECT al.* FROM activity_log al
         JOIN pipeline_item pi ON al.pipeline_item_id = pi.id
         WHERE pi.repo_id = ?
         ORDER BY al.pipeline_item_id, al.started_at ASC`,
        [repoId.value]
      );

      const itemMap = new Map<string, PipelineItem>();
      for (const item of items) itemMap.set(item.id, item);

      // Group logs by pipeline_item_id
      const grouped = new Map<string, ActivityLog[]>();
      for (const log of logs) {
        const arr = grouped.get(log.pipeline_item_id) || [];
        arr.push(log);
        grouped.set(log.pipeline_item_id, arr);
      }

      const nowIso = new Date().toISOString();
      const breakdowns: ActivityBreakdown[] = [];

      // Most recent 20 items that have logs
      const recentItems = items
        .filter((i) => grouped.has(i.id))
        .slice(-20);

      for (const item of recentItems) {
        const itemLogs = grouped.get(item.id)!;
        const totals = { working: 0, idle: 0, unread: 0 };
        for (let i = 0; i < itemLogs.length; i++) {
          const endTime = i + 1 < itemLogs.length
            ? itemLogs[i + 1].started_at
            : (item.stage === "done" ? item.updated_at : nowIso);
          const start = new Date(itemLogs[i].started_at + "Z").getTime();
          const end = new Date(endTime + "Z").getTime();
          const seconds = Math.max(0, (end - start) / 1000);
          const activity = itemLogs[i].activity as keyof typeof totals;
          if (activity in totals) totals[activity] += seconds;
        }
        breakdowns.push({
          itemId: item.id,
          label: item.display_name || item.issue_title || item.prompt?.slice(0, 30) || item.id.slice(0, 8),
          ...totals,
        });
      }
      activityBreakdowns.value = breakdowns;
    } catch (e) {
      console.error("[analytics] refresh failed:", e);
    } finally {
      loading.value = false;
    }
  }

  // Auto-refresh when repo changes
  watch([db, repoId], refresh, { immediate: true });

  return {
    throughputBuckets,
    activityBreakdowns,
    bucketSize,
    headlineStats,
    hasData,
    loading,
    refresh,
  };
}
