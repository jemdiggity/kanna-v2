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

function normalizePort(port: unknown): string {
  return typeof port === "string" && port.trim().length > 0 ? port.trim() : "48120";
}

function serverBaseUrlFromPort(port: unknown): string {
  const resolvedPort = normalizePort(port);
  return `http://127.0.0.1:${resolvedPort}`;
}

async function desktopServerBaseUrl(): Promise<string> {
  const { readEnvVarOptional } = await import("../utils/invokeHelpers");
  return serverBaseUrlFromPort(await readEnvVarOptional("KANNA_MOBILE_SERVER_PORT"));
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

export interface PatchDesktopRepoInput {
  remoteUrl?: string | null;
  remoteUrlHash?: string | null;
  hidden?: boolean;
}

export async function patchDesktopRepo(repoId: string, input: PatchDesktopRepoInput): Promise<void> {
  await requestJson<{ repoId: string }>(`/v1/repos/${encodeURIComponent(repoId)}`, {
    method: "PATCH",
    body: input,
  });
}

export async function putDesktopTaskAgentSession(
  taskId: string,
  agentSessionId: string | null,
): Promise<void> {
  await requestJson<{ taskId: string; followTask: string | null }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/agent-session`,
    {
      method: "PUT",
      body: { agentSessionId },
    },
  );
}

export interface PendingIncomingTransfer {
  id: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  payload_json: string | null;
}

export async function fetchPendingIncomingTransfers(): Promise<PendingIncomingTransfer[]> {
  const response = await requestJson<{ transfers: PendingIncomingTransfer[] }>("/v1/transfers/incoming/pending");
  return response.transfers;
}

export async function claimPendingIncomingTransfer(transferId: string): Promise<boolean> {
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/claim`,
    { method: "POST" },
  );
  return response.updated;
}

export async function failPendingIncomingTransfer(transferId: string, reason: string): Promise<boolean> {
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/fail`,
    {
      method: "POST",
      body: { reason },
    },
  );
  return response.updated;
}

export interface ClosedTaskIdentity {
  id: string;
  repo_id: string;
}

export async function fetchClosedTaskIdentities(): Promise<ClosedTaskIdentity[]> {
  const response = await requestJson<{ tasks: ClosedTaskIdentity[] }>("/v1/tasks/closed-identities");
  return response.tasks;
}
