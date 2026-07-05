import type { PipelineItem, Repo, TaskBlocker } from "../types/kanna";

export interface DesktopSnapshotEntry {
  repo: Repo;
  items: PipelineItem[];
}

export interface DesktopSnapshot {
  entries: DesktopSnapshotEntry[];
  taskBlockers: TaskBlocker[];
  worktreePaths: Record<string, string>;
  settings: Record<string, string>;
}

let snapshotFetcherForTests: (() => Promise<DesktopSnapshot>) | null = null;

export function setDesktopSnapshotFetcherForTests(fetcher: (() => Promise<DesktopSnapshot>) | null): void {
  snapshotFetcherForTests = fetcher;
}

async function desktopServerBaseUrl(): Promise<string> {
  const { resolveCurrentKannaServerBaseUrl } = await import("./kannaServerBaseUrl");
  return await resolveCurrentKannaServerBaseUrl("fetching desktop snapshot");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown; retryMs?: number } = {},
): Promise<T> {
  const baseUrl = await desktopServerBaseUrl();
  const deadline = Date.now() + (options.retryMs ?? 0);
  let lastError: unknown = null;
  const method = options.method ?? "GET";
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);

  while (true) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
        body: requestBody,
      });
      if (response.ok) {
        return await response.json() as T;
      }
      const responseBody = await response.text().catch(() => "");
      lastError = new Error(`${method} ${path} failed: ${response.status}${responseBody ? ` ${responseBody}` : ""}`);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
    }
    await sleep(200);
  }
}

async function requestOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await requestJson<T>(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed: 404")) {
      return null;
    }
    throw error;
  }
}

export async function fetchDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (snapshotFetcherForTests) return await snapshotFetcherForTests();
  return await requestJson<DesktopSnapshot>("/v1/snapshot", { retryMs: 15_000 });
}

export interface DesktopSettingResponse {
  key: string;
  value: string;
}

export async function putDesktopSetting(key: string, value: string): Promise<DesktopSettingResponse> {
  return await requestJson<DesktopSettingResponse>(`/v1/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
}

export async function getDesktopSetting(key: string): Promise<string | null> {
  const response = await requestOptionalJson<DesktopSettingResponse>(`/v1/settings/${encodeURIComponent(key)}`);
  return response?.value ?? null;
}

export type DesktopOperatorEventType = "task_selected" | "app_blur" | "app_focus";

export interface DesktopOperatorEventInput {
  eventType: DesktopOperatorEventType;
  pipelineItemId?: string | null;
  repoId?: string | null;
}

export async function postDesktopOperatorEvents(events: DesktopOperatorEventInput[]): Promise<void> {
  await requestJson<{ inserted: number }>("/v1/operator-events", {
    method: "POST",
    body: { events },
  });
}

export function postDesktopOperatorEvent(event: DesktopOperatorEventInput): Promise<void> {
  return postDesktopOperatorEvents([event]);
}

export type DesktopAnalyticsBucketSize = "daily" | "weekly" | "monthly";

export interface DesktopAnalyticsBucket {
  key: string;
  created: number;
  closed: number;
}

export interface DesktopOperatorMetrics {
  avgResponseTime: number | null;
  avgDwellTime: number | null;
  switchesPerHour: number | null;
  focusScore: number | null;
}

export interface DesktopRepoAnalytics {
  taskBuckets: DesktopAnalyticsBucket[];
  bucketSize: DesktopAnalyticsBucketSize;
  hasData: boolean;
  avgTimeInState: {
    working: number;
    idle: number;
    unread: number;
  };
  operatorMetrics: DesktopOperatorMetrics;
  hasOperatorData: boolean;
}

export async function fetchDesktopRepoAnalytics(repoId: string): Promise<DesktopRepoAnalytics> {
  return await requestJson<DesktopRepoAnalytics>(`/v1/analytics/repos/${encodeURIComponent(repoId)}`);
}
