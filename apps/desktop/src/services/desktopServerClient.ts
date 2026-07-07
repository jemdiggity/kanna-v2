import type { PipelineItem, Repo, TaskBlocker } from "../types/kanna";
import type { TaskTransfer } from "../types/kanna";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";
import { invoke } from "../invoke";

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
  ensureMobileServer?: () => MaybePromise<void>;
  getSetting?: (key: string) => MaybePromise<string | null>;
  putSetting?: (key: string, value: string) => MaybePromise<DesktopSettingResponse | void>;
  deleteSetting?: (key: string) => MaybePromise<void>;
  postOperatorEvents?: (events: DesktopOperatorEventInput[]) => MaybePromise<void>;
  createBackup?: () => MaybePromise<DesktopBackupResponse>;
  fetchRepoAnalytics?: (repoId: string) => MaybePromise<DesktopRepoAnalytics>;
  patchRepo?: (repoId: string, input: PatchDesktopRepoInput) => MaybePromise<void>;
  applyTaskRuntimeStatus?: (taskId: string, input: DesktopTaskRuntimeStatusInput) => MaybePromise<DesktopTaskActivityResponse>;
  markTaskRead?: (taskId: string) => MaybePromise<DesktopTaskActivityResponse>;
  putTaskAgentSession?: (taskId: string, agentSessionId: string | null) => MaybePromise<void>;
  claimTaskPorts?: (taskId: string, input: ClaimDesktopTaskPortsInput) => MaybePromise<ClaimDesktopTaskPortsResponse>;
  releaseTaskPorts?: (taskId: string) => MaybePromise<void>;
  createTask?: (request: CreateDesktopTaskRequest) => MaybePromise<CreateDesktopTaskResponse>;
  closeTask?: (taskId: string) => MaybePromise<void>;
  reopenTask?: (taskId: string) => MaybePromise<void>;
  blockTask?: (taskId: string, blockerTaskIds: string[]) => MaybePromise<void>;
  unblockTask?: (taskId: string) => MaybePromise<void>;
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

async function ensureDesktopServerRunning(): Promise<void> {
  if (clientHandlersForTests?.ensureMobileServer) {
    await clientHandlersForTests.ensureMobileServer();
    return;
  }
  await invoke("ensure_mobile_server");
}

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown; retryMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.retryMs ?? 0);
  let lastError: unknown = null;
  const method = options.method ?? "GET";
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);

  while (true) {
    try {
      await ensureDesktopServerRunning();
      const baseUrl = await desktopServerBaseUrl();
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
        body: requestBody,
      });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return await response.json() as T;
      }
      const responseBody = await response.text().catch(() => "");
      lastError = new Error(`${method} ${path} failed: ${response.status}${responseBody ? ` ${responseBody}` : ""}`);
      if (response.status === 404) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("failed: 404")) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
    }
    await sleep(200);
  }
}

async function requestOptionalJson<T>(
  path: string,
  options: { retryMs?: number } = {},
): Promise<T | null> {
  try {
    return await requestJson<T>(path, options);
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

export interface CreateDesktopTaskRequest {
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
  stage?: string;
  baseRef?: string | null;
  agentProvider?: string;
  agentType?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setupCmds?: string[];
  resumeSessionId?: string | null;
  recoverySnapshot?: SessionRecoveryState | null;
  blockerTaskIds?: string[];
  notifyTaskId?: string;
  parentTaskId?: string;
}

export interface CreateDesktopTaskResponse {
  taskId: string;
  repoId: string;
  title: string;
  stage: string;
  agentType: string;
  worktreePath?: string | null;
}

export async function createDesktopTask(
  request: CreateDesktopTaskRequest,
): Promise<CreateDesktopTaskResponse> {
  if (clientHandlersForTests?.createTask) return await clientHandlersForTests.createTask(request);
  return await requestJson<CreateDesktopTaskResponse>("/v1/tasks", {
    method: "POST",
    body: request,
  });
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
  const response = await requestOptionalJson<DesktopSettingResponse>(
    `/v1/settings/${encodeURIComponent(key)}`,
    { retryMs: 15_000 },
  );
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

export interface DesktopBackupResponse {
  backupPath: string;
}

export async function createDesktopBackup(): Promise<DesktopBackupResponse> {
  if (clientHandlersForTests?.createBackup) return await clientHandlersForTests.createBackup();
  return await requestJson<DesktopBackupResponse>("/v1/backup", {
    method: "POST",
  });
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

export type DesktopRuntimeStatus = "busy" | "idle" | "waiting" | string;

export interface DesktopTaskRuntimeStatusInput {
  status: DesktopRuntimeStatus;
  selected: boolean;
}

export interface DesktopTaskActivityResponse {
  taskId?: string;
  task_id?: string;
  activity?: "idle" | "working" | "unread" | null;
}

export async function applyDesktopTaskRuntimeStatus(
  taskId: string,
  input: DesktopTaskRuntimeStatusInput,
): Promise<DesktopTaskActivityResponse> {
  if (clientHandlersForTests?.applyTaskRuntimeStatus) {
    return await clientHandlersForTests.applyTaskRuntimeStatus(taskId, input);
  }
  return await requestJson<DesktopTaskActivityResponse>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/runtime-status`,
    {
      method: "POST",
      body: input,
    },
  );
}

export async function markDesktopTaskRead(taskId: string): Promise<DesktopTaskActivityResponse> {
  if (clientHandlersForTests?.markTaskRead) {
    return await clientHandlersForTests.markTaskRead(taskId);
  }
  return await requestJson<DesktopTaskActivityResponse>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/mark-read`,
    { method: "POST" },
  );
}

export async function putDesktopTaskAgentSession(
  taskId: string,
  agentSessionId: string | null,
): Promise<void> {
  if (clientHandlersForTests?.putTaskAgentSession) {
    await clientHandlersForTests.putTaskAgentSession(taskId, agentSessionId);
    return;
  }
  await requestJson<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/agent-session`,
    {
      method: "POST",
      body: { agentSessionId },
    },
  );
}

export interface ClaimDesktopTaskPortsInput {
  ports?: Record<string, number>;
  reservedPorts?: number[];
  reservedPortOffsets?: number[];
}

export interface ClaimDesktopTaskPortsResponse {
  taskId?: string;
  task_id?: string;
  portEnv?: Record<string, string>;
  port_env?: Record<string, string>;
  firstPort?: number | null;
  first_port?: number | null;
}

export async function claimDesktopTaskPorts(
  taskId: string,
  input: ClaimDesktopTaskPortsInput,
): Promise<ClaimDesktopTaskPortsResponse> {
  if (clientHandlersForTests?.claimTaskPorts) {
    return await clientHandlersForTests.claimTaskPorts(taskId, input);
  }
  return await requestJson<ClaimDesktopTaskPortsResponse>(
    `/v1/tasks/${encodeURIComponent(taskId)}/ports`,
    {
      method: "POST",
      body: input,
    },
  );
}

export async function releaseDesktopTaskPorts(taskId: string): Promise<void> {
  if (clientHandlersForTests?.releaseTaskPorts) {
    await clientHandlersForTests.releaseTaskPorts(taskId);
    return;
  }
  await requestJson<{ taskId: string }>(`/v1/tasks/${encodeURIComponent(taskId)}/ports`, {
    method: "DELETE",
  });
}

export async function closeDesktopTask(taskId: string): Promise<void> {
  if (clientHandlersForTests?.closeTask) {
    await clientHandlersForTests.closeTask(taskId);
    return;
  }
  await requestJson<{ taskId?: string }>(`/v1/tasks/${encodeURIComponent(taskId)}/actions/close`, {
    method: "POST",
  });
}

export async function reopenDesktopTask(taskId: string): Promise<void> {
  if (clientHandlersForTests?.reopenTask) {
    await clientHandlersForTests.reopenTask(taskId);
    return;
  }
  await requestJson<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/reopen`,
    { method: "POST" },
  );
}

export async function blockDesktopTask(taskId: string, blockerTaskIds: string[]): Promise<void> {
  if (clientHandlersForTests?.blockTask) {
    await clientHandlersForTests.blockTask(taskId, blockerTaskIds);
    return;
  }
  await requestJson<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/block`,
    {
      method: "POST",
      body: { blockerTaskIds },
    },
  );
}

export async function unblockDesktopTask(taskId: string): Promise<void> {
  if (clientHandlersForTests?.unblockTask) {
    await clientHandlersForTests.unblockTask(taskId);
    return;
  }
  await requestJson<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/unblock`,
    { method: "POST" },
  );
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

interface PendingIncomingTransferResponse {
  id: string;
  sourcePeerId?: string | null;
  sourceTaskId?: string | null;
  payloadJson?: string | null;
  source_peer_id?: string | null;
  source_task_id?: string | null;
  payload_json?: string | null;
}

function normalizePendingIncomingTransfer(row: PendingIncomingTransferResponse): PendingIncomingTransfer {
  return {
    id: row.id,
    source_peer_id: row.source_peer_id ?? row.sourcePeerId ?? null,
    source_task_id: row.source_task_id ?? row.sourceTaskId ?? null,
    payload_json: row.payload_json ?? row.payloadJson ?? null,
  };
}

export async function fetchPendingIncomingTransfers(): Promise<PendingIncomingTransfer[]> {
  if (clientHandlersForTests?.fetchPendingIncomingTransfers) {
    return await clientHandlersForTests.fetchPendingIncomingTransfers();
  }
  const response = await requestJson<{ transfers: PendingIncomingTransferResponse[] }>("/v1/transfers/incoming/pending");
  return response.transfers.map(normalizePendingIncomingTransfer);
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
