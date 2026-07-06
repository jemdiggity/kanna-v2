import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDesktopServerClientHandlersForTests } from "../services/desktopServerClient";
import { useAnalytics } from "./useAnalytics";

async function flushWatchers(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useAnalytics", () => {
  beforeEach(() => {
    setDesktopServerClientHandlersForTests({});
  });

  it("fetches repo analytics from the desktop server without a frontend database handle", async () => {
    const fetchRepoAnalytics = vi.fn(async (repoId: string) => ({
      taskBuckets: [{ key: "2026-07-01", created: 2, closed: 1 }],
      bucketSize: "daily" as const,
      hasData: true,
      avgTimeInState: {
        working: 12,
        idle: 34,
        unread: 5,
      },
      operatorMetrics: {
        avgResponseTime: 7,
        avgDwellTime: 8,
        switchesPerHour: 9,
        focusScore: 0.75,
      },
      hasOperatorData: true,
    }));
    setDesktopServerClientHandlersForTests({ fetchRepoAnalytics });

    const repoId = ref<string | null>("repo-1");
    const analytics = useAnalytics(repoId);

    await flushWatchers();

    expect(fetchRepoAnalytics).toHaveBeenCalledWith("repo-1");
    expect(analytics.hasData.value).toBe(true);
    expect(analytics.headlineStats.value).toEqual({
      totalCreated: 2,
      totalClosed: 1,
      open: 1,
    });
    expect(analytics.avgTimeInState.value).toEqual({
      working: 12,
      idle: 34,
      unread: 5,
    });
    expect(analytics.hasOperatorData.value).toBe(true);
  });
});
