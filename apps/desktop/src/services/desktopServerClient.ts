import type { PipelineItem, Repo, TaskBlocker } from "../types/kanna";
import type { TaskTransfer } from "../types/kanna";

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

type MaybePromise<T> = T | Promise<T>;

export interface DesktopServerClientHandlersForTests {
  getSetting?: (key: string) => MaybePromise<string | null>;
  putSetting?: (key: string, value: string) => MaybePromise<DesktopSettingResponse | void>;
  deleteSetting?: (key: string) => MaybePromise<void>;
  postOperatorEvents?: (events: DesktopOperatorEventInput[]) => MaybePromise<void>;
  fetchRepoAnalytics?: (repoId: string) => MaybePromise<DesktopRepoAnalytics>;
  patchRepo?: (repoId: string, input: PatchDesktopRepoInput) => MaybePromise<void>;
  addRepo?: (input: AddDesktopRepoInput) => MaybePromise<DesktopRepoResponse>;
  findRepoByPath?: (path: string) => MaybePromise<DesktopRepoResponse | null>;
  reorderRepos?: (orderedIds: string[]) => MaybePromise<void>;
  fetchPendingIncomingTransfers?: () => MaybePromise<PendingIncomingTransfer[]>;
  claimPendingIncomingTransfer?: (transferId: string) => MaybePromise<boolean>;
  failPendingIncomingTransfer?: (transferId: string, reason: string) => MaybePromise<boolean>;
  fetchClosedTaskIdentities?: () => MaybePromise<ClosedTaskIdentity[]>;
  patchTask?: (taskId: string, input: PatchDesktopTaskInput) => MaybePromise<void>;
  setTaskParent?: (taskId: string, parentTaskId: string | null) => MaybePromise<void>;
  pinTask?: (taskId: string, position: number) => MaybePromise<void>;
  unpinTask?: (taskId: string) => MaybePromise<void>;
  reorderPinnedTasks?: (repoId: string, orderedIds: string[]) => MaybePromise<void>;
  insertTaskTransfer?: (transfer: NewTaskTransferInput) => MaybePromise<void>;
  getTaskTransfer?: (transferId: string) => MaybePromise<TaskTransfer | null>;
  updateTaskTransferPayload?: (transferId: string, payloadJson: string) => MaybePromise<boolean>;
  completeTaskTransfer?: (transferId: string, localTaskId: string) => MaybePromise<boolean>;
  rejectTaskTransfer?: (transferId: string, reason: string) => MaybePromise<boolean>;
  insertTaskTransferProvenance?: (provenance: NewTaskTransferProvenanceInput) => MaybePromise<void>;
}

let clientHandlersForTests: DesktopServerClientHandlersForTests | null = null;

export function setDesktopServerClientHandlersForTests(
  handlers: DesktopServerClientHandlersForTests | null,
): void {
  clientHandlersForTests = handlers;
}

export function updateDesktopServerClientHandlersForTests(
  handlers: DesktopServerClientHandlersForTests,
): void {
  clientHandlersForTests = { ...(clientHandlersForTests ?? {}), ...handlers };
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
  const response = await clientHandlersForTests?.putSetting?.(key, value);
  if (response !== undefined) return response;
  if (clientHandlersForTests?.putSetting) return { key, value };
  return await requestJson<DesktopSettingResponse>(`/v1/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: { value },
  });
}

export async function getDesktopSetting(key: string): Promise<string | null> {
  if (clientHandlersForTests?.getSetting) return await clientHandlersForTests.getSetting(key);
  const response = await requestOptionalJson<DesktopSettingResponse>(`/v1/settings/${encodeURIComponent(key)}`);
  return response?.value ?? null;
}

export async function deleteDesktopSetting(key: string): Promise<void> {
  if (clientHandlersForTests?.deleteSetting) {
    await clientHandlersForTests.deleteSetting(key);
    return;
  }
  await requestJson<{ key: string }>(`/v1/settings/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export type DesktopOperatorEventType = "task_selected" | "app_blur" | "app_focus";

export interface DesktopOperatorEventInput {
  eventType: DesktopOperatorEventType;
  pipelineItemId?: string | null;
  repoId?: string | null;
}

export async function postDesktopOperatorEvents(events: DesktopOperatorEventInput[]): Promise<void> {
  if (clientHandlersForTests?.postOperatorEvents) {
    await clientHandlersForTests.postOperatorEvents(events);
    return;
  }
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
  if (clientHandlersForTests?.fetchRepoAnalytics) return await clientHandlersForTests.fetchRepoAnalytics(repoId);
  return await requestJson<DesktopRepoAnalytics>(`/v1/analytics/repos/${encodeURIComponent(repoId)}`);
}

export interface PatchDesktopRepoInput {
  name?: string;
  remoteUrl?: string | null;
  remoteUrlHash?: string | null;
  hidden?: boolean;
}

export async function patchDesktopRepo(repoId: string, input: PatchDesktopRepoInput): Promise<void> {
  if (clientHandlersForTests?.patchRepo) {
    await clientHandlersForTests.patchRepo(repoId, input);
    return;
  }
  await requestJson<{ repoId: string }>(`/v1/repos/${encodeURIComponent(repoId)}`, {
    method: "PATCH",
    body: input,
  });
}

export interface DesktopRepoResponse {
  id: string;
  path: string;
  name: string;
  default_branch?: string | null;
  defaultBranch?: string | null;
  remote_url?: string | null;
  remoteUrl?: string | null;
  remote_url_hash?: string | null;
  remoteUrlHash?: string | null;
  hidden?: number | null;
  sort_order?: number | null;
  sortOrder?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  last_opened_at?: string | null;
  lastOpenedAt?: string | null;
}

export interface AddDesktopRepoInput {
  path: string;
  name?: string | null;
}

export async function findDesktopRepoByPath(path: string): Promise<DesktopRepoResponse | null> {
  if (clientHandlersForTests?.findRepoByPath) return await clientHandlersForTests.findRepoByPath(path);
  return await requestOptionalJson<DesktopRepoResponse>(
    `/v1/repos/by-path?path=${encodeURIComponent(path)}`,
  );
}

export async function addDesktopRepo(input: AddDesktopRepoInput): Promise<DesktopRepoResponse> {
  if (clientHandlersForTests?.addRepo) return await clientHandlersForTests.addRepo(input);
  return await requestJson<DesktopRepoResponse>("/v1/repos", {
    method: "POST",
    body: input,
  });
}

export async function reorderDesktopRepos(orderedIds: string[]): Promise<void> {
  if (clientHandlersForTests?.reorderRepos) {
    await clientHandlersForTests.reorderRepos(orderedIds);
    return;
  }
  await requestJson<{ updated: number }>("/v1/repos/actions/reorder", {
    method: "POST",
    body: { orderedIds },
  });
}

export interface PatchDesktopTaskInput {
  displayName?: string | null;
}

export async function patchDesktopTask(taskId: string, input: PatchDesktopTaskInput): Promise<void> {
  if (clientHandlersForTests?.patchTask) {
    await clientHandlersForTests.patchTask(taskId, input);
    return;
  }
  await requestJson<{ taskId: string }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: input,
  });
}

export async function setDesktopTaskParent(taskId: string, parentTaskId: string | null): Promise<void> {
  if (clientHandlersForTests?.setTaskParent) {
    await clientHandlersForTests.setTaskParent(taskId, parentTaskId);
    return;
  }
  await requestJson<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/set-parent`,
    {
      method: "POST",
      body: { parentTaskId },
    },
  );
}

export async function pinDesktopTask(taskId: string, position: number): Promise<void> {
  if (clientHandlersForTests?.pinTask) {
    await clientHandlersForTests.pinTask(taskId, position);
    return;
  }
  await requestJson<{ taskId: string }>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/pin`, {
    method: "POST",
    body: { position },
  });
}

export async function unpinDesktopTask(taskId: string): Promise<void> {
  if (clientHandlersForTests?.unpinTask) {
    await clientHandlersForTests.unpinTask(taskId);
    return;
  }
  await requestJson<{ taskId: string }>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/unpin`, {
    method: "POST",
  });
}

export async function reorderPinnedDesktopTasks(repoId: string, orderedIds: string[]): Promise<void> {
  if (clientHandlersForTests?.reorderPinnedTasks) {
    await clientHandlersForTests.reorderPinnedTasks(repoId, orderedIds);
    return;
  }
  await requestJson<{ updated: number }>("/v1/tasks/actions/reorder-pinned", {
    method: "POST",
    body: { repoId, orderedIds },
  });
}

export interface PendingIncomingTransfer {
  id: string;
  source_peer_id: string | null;
  source_task_id: string | null;
  payload_json: string | null;
}

export async function fetchPendingIncomingTransfers(): Promise<PendingIncomingTransfer[]> {
  if (clientHandlersForTests?.fetchPendingIncomingTransfers) {
    return await clientHandlersForTests.fetchPendingIncomingTransfers();
  }
  const response = await requestJson<{ transfers: PendingIncomingTransfer[] }>("/v1/transfers/incoming/pending");
  return response.transfers;
}

export async function claimPendingIncomingTransfer(transferId: string): Promise<boolean> {
  if (clientHandlersForTests?.claimPendingIncomingTransfer) {
    return await clientHandlersForTests.claimPendingIncomingTransfer(transferId);
  }
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/claim`,
    { method: "POST" },
  );
  return response.updated;
}

export async function failPendingIncomingTransfer(transferId: string, reason: string): Promise<boolean> {
  if (clientHandlersForTests?.failPendingIncomingTransfer) {
    return await clientHandlersForTests.failPendingIncomingTransfer(transferId, reason);
  }
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
  if (clientHandlersForTests?.fetchClosedTaskIdentities) {
    return await clientHandlersForTests.fetchClosedTaskIdentities();
  }
  const response = await requestJson<{ tasks: ClosedTaskIdentity[] }>("/v1/tasks/closed-identities");
  return response.tasks;
}

export type NewTaskTransferInput = Omit<TaskTransfer, "started_at" | "completed_at">;

export interface NewTaskTransferProvenanceInput {
  pipeline_item_id: string;
  source_peer_id: string;
  source_task_id: string;
  source_machine_task_label: string | null;
}

export async function insertDesktopTaskTransfer(transfer: NewTaskTransferInput): Promise<void> {
  if (clientHandlersForTests?.insertTaskTransfer) {
    await clientHandlersForTests.insertTaskTransfer(transfer);
    return;
  }
  await requestJson<{ id: string }>("/v1/transfers", {
    method: "POST",
    body: { transfer },
  });
}

export async function getDesktopTaskTransfer(transferId: string): Promise<TaskTransfer | null> {
  if (clientHandlersForTests?.getTaskTransfer) return await clientHandlersForTests.getTaskTransfer(transferId);
  const response = await requestJson<{ transfer: TaskTransfer | null }>(
    `/v1/transfers/${encodeURIComponent(transferId)}`,
  );
  return response.transfer;
}

export async function updateDesktopTaskTransferPayload(
  transferId: string,
  payloadJson: string,
): Promise<boolean> {
  if (clientHandlersForTests?.updateTaskTransferPayload) {
    return await clientHandlersForTests.updateTaskTransferPayload(transferId, payloadJson);
  }
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/payload`,
    {
      method: "PUT",
      body: { payloadJson },
    },
  );
  return response.updated;
}

export async function completeDesktopTaskTransfer(
  transferId: string,
  localTaskId: string,
): Promise<boolean> {
  if (clientHandlersForTests?.completeTaskTransfer) {
    return await clientHandlersForTests.completeTaskTransfer(transferId, localTaskId);
  }
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/complete`,
    {
      method: "POST",
      body: { localTaskId },
    },
  );
  return response.updated;
}

export async function rejectDesktopTaskTransfer(
  transferId: string,
  reason: string,
): Promise<boolean> {
  if (clientHandlersForTests?.rejectTaskTransfer) {
    return await clientHandlersForTests.rejectTaskTransfer(transferId, reason);
  }
  const response = await requestJson<{ updated: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/reject`,
    {
      method: "POST",
      body: { reason },
    },
  );
  return response.updated;
}

export async function insertDesktopTaskTransferProvenance(
  provenance: NewTaskTransferProvenanceInput,
): Promise<void> {
  if (clientHandlersForTests?.insertTaskTransferProvenance) {
    await clientHandlersForTests.insertTaskTransferProvenance(provenance);
    return;
  }
  await requestJson<{ pipelineItemId: string }>("/v1/transfers/provenance", {
    method: "POST",
    body: { provenance },
  });
}
