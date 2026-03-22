import { ref, computed, watch, type Ref } from "vue";
import { hasTag } from "@kanna/core";
import type { DbHandle, PipelineItem, ActivityLog, OperatorEvent } from "@kanna/db";

interface TaskBucket {
  label: string;
  created: number;
  closed: number;
}

interface OperatorMetrics {
  avgResponseTime: number | null;  // seconds
  avgDwellTime: number | null;     // seconds
  switchesPerHour: number | null;
  focusScore: number | null;       // 0.0–1.0
}

type BucketSize = "daily" | "weekly" | "monthly";

export function useAnalytics(db: Ref<DbHandle | null>, repoId: Ref<string | null>) {
  const taskBuckets = ref<TaskBucket[]>([]);
  const bucketSize = ref<BucketSize>("daily");
  const hasData = ref(false);
  const loading = ref(false);
  const operatorMetrics = ref<OperatorMetrics>({ avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null });
  const hasOperatorData = ref(false);

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

  function computeDwells(events: OperatorEvent[]): Map<string, number> {
    const dwells = new Map<string, number>();
    let activeItemId: string | null = null;
    let segmentStart: number | null = null;
    let appVisible = true;

    for (const event of events) {
      const t = new Date(event.created_at + "Z").getTime();

      if (event.event_type === "task_selected") {
        if (activeItemId && segmentStart !== null && appVisible) {
          const dur = Math.max(0, (t - segmentStart) / 1000);
          dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
        }
        activeItemId = event.pipeline_item_id;
        segmentStart = appVisible ? t : null;
      } else if (event.event_type === "app_blur") {
        if (activeItemId && segmentStart !== null) {
          const dur = Math.max(0, (t - segmentStart) / 1000);
          dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
        }
        segmentStart = null;
        appVisible = false;
      } else if (event.event_type === "app_focus") {
        appVisible = true;
        if (activeItemId) segmentStart = t;
      }
    }

    if (activeItemId && segmentStart !== null && appVisible) {
      const dur = Math.max(0, (Date.now() - segmentStart) / 1000);
      dwells.set(activeItemId, (dwells.get(activeItemId) || 0) + dur);
    }

    return dwells;
  }

  function computeActiveHours(events: OperatorEvent[]): number {
    if (events.length === 0) return 0;
    const first = new Date(events[0].created_at + "Z").getTime();
    const now = Date.now();
    let totalBlur = 0;
    let blurStart: number | null = null;

    for (const event of events) {
      const t = new Date(event.created_at + "Z").getTime();
      if (event.event_type === "app_blur") {
        blurStart = t;
      } else if (event.event_type === "app_focus" && blurStart !== null) {
        totalBlur += t - blurStart;
        blurStart = null;
      }
    }
    if (blurStart !== null) totalBlur += now - blurStart;

    return Math.max(0.001, (now - first - totalBlur) / 3600000);
  }

  function computeSwitchCount(events: OperatorEvent[]): number {
    let count = 0;
    let prevItemId: string | null = null;
    for (const event of events) {
      if (event.event_type === "task_selected" && event.pipeline_item_id) {
        if (prevItemId !== null && event.pipeline_item_id !== prevItemId) {
          count++;
        }
        prevItemId = event.pipeline_item_id;
      }
    }
    return count;
  }

  function computeResponseTimes(
    events: OperatorEvent[],
    activityLogs: ActivityLog[]
  ): Map<string, number> {
    const responses = new Map<string, number[]>();

    const selectionTimes = new Map<string, number[]>();
    for (const e of events) {
      if (e.event_type === "task_selected" && e.pipeline_item_id) {
        const arr = selectionTimes.get(e.pipeline_item_id) || [];
        arr.push(new Date(e.created_at + "Z").getTime());
        selectionTimes.set(e.pipeline_item_id, arr);
      }
    }

    for (const log of activityLogs) {
      if (log.activity !== "unread") continue;
      const unreadAt = new Date(log.started_at + "Z").getTime();
      const selections = selectionTimes.get(log.pipeline_item_id) || [];
      const firstAfter = selections.find((t) => t > unreadAt);
      if (firstAfter !== undefined) {
        const dur = (firstAfter - unreadAt) / 1000;
        const arr = responses.get(log.pipeline_item_id) || [];
        arr.push(dur);
        responses.set(log.pipeline_item_id, arr);
      }
    }

    const avgResponses = new Map<string, number>();
    for (const [itemId, times] of responses) {
      avgResponses.set(itemId, times.reduce((a, b) => a + b, 0) / times.length);
    }
    return avgResponses;
  }

  async function refresh() {
    if (!db.value || !repoId.value) {
      hasData.value = false;
      taskBuckets.value = [];
      avgTimeInState.value = { working: 0, idle: 0, unread: 0 };
      operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
      hasOperatorData.value = false;
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
        operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
        hasOperatorData.value = false;
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
        if (hasTag(item, "done")) {
          const key = bucketKey(item.closed_at || item.updated_at, size);
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

      // --- Operator Metrics ---
      const opEvents = await db.value.select<OperatorEvent>(
        `SELECT * FROM operator_event
         WHERE repo_id = ? OR repo_id IS NULL
         ORDER BY created_at ASC`,
        [repoId.value]
      );

      hasOperatorData.value = opEvents.some((e) => e.event_type === "task_selected");

      if (hasOperatorData.value) {
        const dwells = computeDwells(opEvents);
        const dwellValues = [...dwells.values()];
        const avgDwell = dwellValues.length > 0
          ? dwellValues.reduce((a, b) => a + b, 0) / dwellValues.length
          : null;

        const activeHours = computeActiveHours(opEvents);
        const switchCount = computeSwitchCount(opEvents);

        const totalDwell = dwellValues.reduce((a, b) => a + b, 0);
        const focusDwell = dwellValues.filter((d) => d > 30).reduce((a, b) => a + b, 0);
        const focusScore = totalDwell > 0 ? focusDwell / totalDwell : null;

        const responseTimes = computeResponseTimes(opEvents, logs);
        const responseValues = [...responseTimes.values()];
        const avgResponse = responseValues.length > 0
          ? responseValues.reduce((a, b) => a + b, 0) / responseValues.length
          : null;

        operatorMetrics.value = {
          avgResponseTime: avgResponse,
          avgDwellTime: avgDwell,
          switchesPerHour: switchCount / activeHours,
          focusScore,
        };
      } else {
        operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
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
    operatorMetrics,
    hasOperatorData,
  };
}
