import { ref, computed, watch, type Ref } from "vue";
import type { DbHandle } from "../types/kanna";
import { fetchDesktopRepoAnalytics, type DesktopAnalyticsBucketSize } from "../services/desktopServerClient";

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

type BucketSize = DesktopAnalyticsBucketSize;

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
      operatorMetrics.value = { avgResponseTime: null, avgDwellTime: null, switchesPerHour: null, focusScore: null };
      hasOperatorData.value = false;
      return;
    }
    loading.value = true;
    try {
      const analytics = await fetchDesktopRepoAnalytics(repoId.value);
      hasData.value = analytics.hasData;
      bucketSize.value = analytics.bucketSize;
      taskBuckets.value = analytics.taskBuckets.map((bucket) => ({
        label: bucketLabel(bucket.key, analytics.bucketSize),
        created: bucket.created,
        closed: bucket.closed,
      }));
      avgTimeInState.value = analytics.avgTimeInState;
      operatorMetrics.value = analytics.operatorMetrics;
      hasOperatorData.value = analytics.hasOperatorData;

      if (!analytics.hasData) {
        avgTimeInState.value = { working: 0, idle: 0, unread: 0 };
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
