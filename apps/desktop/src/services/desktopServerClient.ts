import { isAgentProvider, type AgentProvider } from "@kanna/agent-protocol";
import type { RepoConfig } from "@kanna/core";
import type { AgentDefinition, WorkflowDefinition } from "../../../../packages/core/src/workflow/workflow-types";
import type { BlockerTaskStates, PipelineItem, Repo, TaskBlocker } from "../types/kanna";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";
import type { TransferImportSummary } from "../stores/transferImportSummary";
import { invoke } from "../invoke";

export interface DesktopSnapshotEntry {
  repo: Repo;
  items: PipelineItem[];
}

export interface DesktopSnapshot {
  entries: DesktopSnapshotEntry[];
  taskBlockers: TaskBlocker[];
  blockerTaskStates?: BlockerTaskStates;
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
  mutateWindowWorkspace?: (
    mutation: DesktopWindowWorkspaceMutation,
  ) => MaybePromise<DesktopWindowWorkspaceSnapshot>;
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
  setTaskCloudIdentity?: (taskId: string, cloudTaskId: string) => MaybePromise<void>;
  reopenTask?: (taskId: string) => MaybePromise<void>;
  blockTask?: (taskId: string, blockerTaskIds: string[]) => MaybePromise<void>;
  unblockTask?: (taskId: string) => MaybePromise<void>;
  addRepo?: (input: AddDesktopRepoInput) => MaybePromise<DesktopRepoResponse>;
  fetchRepoKannaDefinitions?: (repoId: string) => MaybePromise<DesktopRepoKannaDefinitions>;
  refreshRepoOrigin?: (repoId: string) => MaybePromise<DesktopRepoKannaDefinitions>;
  fetchRepoWorkflowDefinition?: (
    repoId: string,
    workflowName: string,
  ) => MaybePromise<DesktopRepoWorkflowDefinition>;
  fetchRepoAgentDefinition?: (
    repoId: string,
    agentSelector: string,
  ) => MaybePromise<DesktopRepoAgentDefinition>;
  fetchRepoAgentProviders?: (repoId: string) => MaybePromise<AgentProvider[]>;
  fetchRepoRecentWorkflows?: (repoId: string) => MaybePromise<string[]>;
  fetchRepoCommands?: (repoId: string) => MaybePromise<DesktopRepoCommandCatalog>;
  runRepoCommand?: (
    repoId: string,
    commandId: string,
    catalogRevision: string,
  ) => MaybePromise<RunDesktopRepoCommandResponse>;
  findRepoByPath?: (path: string) => MaybePromise<DesktopRepoResponse | null>;
  reorderRepos?: (orderedIds: string[]) => MaybePromise<void>;
  fetchClosedTaskIdentities?: () => MaybePromise<ClosedTaskIdentity[]>;
  fetchTaskDetail?: (taskId: string) => MaybePromise<DesktopTaskDetail>;
  patchTask?: (taskId: string, input: PatchDesktopTaskInput) => MaybePromise<void>;
  setTaskParent?: (taskId: string, parentTaskId: string | null) => MaybePromise<void>;
  setTaskWorkflow?: (
    taskId: string,
    workflowName: string,
  ) => MaybePromise<SetDesktopTaskWorkflowResponse>;
  pinTask?: (taskId: string, position: number) => MaybePromise<void>;
  unpinTask?: (taskId: string) => MaybePromise<void>;
  reorderPinnedTasks?: (repoId: string, orderedIds: string[]) => MaybePromise<void>;
  pushTaskToPeer?: (
    sourceTaskId: string,
    peerId: string,
    options: {
      transport?: "lan" | "cloud";
      cloudFallback?: boolean;
      targetDesktopId?: string | null;
      intentKey?: string;
    },
  ) => MaybePromise<boolean>;
  approveIncomingTaskTransfer?: (transferId: string) => MaybePromise<boolean>;
  rejectIncomingTaskTransfer?: (transferId: string) => MaybePromise<boolean>;
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

/**
 * A non-2xx answer from `kanna-server`, carrying the status and body so callers
 * can act on the distinction the server drew instead of pattern-matching prose.
 */
export class DesktopServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "DesktopServerRequestError";
  }

  /** The body parsed as JSON, or null when the server answered with prose. */
  parsedBody(): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(this.body);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

/**
 * Statuses that describe the request rather than a transient server condition,
 * so retrying them only delays the caller's own handling.
 *
 * 404 is the whole set, deliberately. A 409 means different things per route —
 * `PUT /v1/tasks/{id}` returns one for a creation already in flight, which
 * `createDesktopTask` waits out with a 15s `retryMs` — so a caller that wants a
 * conflict answered rather than retried asks for no retry budget instead of
 * making that choice for every other route. `POST /v1/transfers` does exactly
 * that: with no `retryMs` its deadline has already passed, so its duplicate
 * 409 surfaces on the first attempt without this set's help.
 */
const TERMINAL_REQUEST_STATUSES = new Set([404]);

function isTerminalRequestError(error: unknown): boolean {
  return error instanceof DesktopServerRequestError
    && TERMINAL_REQUEST_STATUSES.has(error.status);
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
      lastError = new DesktopServerRequestError(
        `${method} ${path} failed: ${response.status}${responseBody ? ` ${responseBody}` : ""}`,
        response.status,
        responseBody,
      );
      if (isTerminalRequestError(lastError)) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (isTerminalRequestError(error)) {
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

export interface DesktopTaskLatestRun {
  id: string;
  stage: string;
  kind: string;
  agent?: string | null;
  status: string;
  summary: string | null;
  resumedFromRunId: string | null;
  resumeFallbackReason: string | null;
  finishedAt: string | null;
}

export interface DesktopTaskDetail {
  id: string;
  stage: string | null;
  closedAt: string | null;
  latestRun: DesktopTaskLatestRun | null;
  revisionRounds: number;
  revisionLimit: number;
  childTaskIds: string[];
  /**
   * Why messages delivered into this task's agent session are being refused,
   * or absent when they are not. The session is alive and idle while this is
   * set, so nothing else on screen says anything is wrong.
   */
  inputBlocked?: string | null;
}

export async function fetchDesktopTaskDetail(taskId: string): Promise<DesktopTaskDetail> {
  if (clientHandlersForTests?.fetchTaskDetail) {
    return await clientHandlersForTests.fetchTaskDetail(taskId);
  }
  return await requestJson<DesktopTaskDetail>(`/v1/tasks/${encodeURIComponent(taskId)}`);
}

export interface CreateDesktopTaskRequest {
  requestedTaskId?: string;
  repoId: string;
  prompt: string;
  displayName?: string | null;
  workflowName?: string;
  stage?: string;
  baseRef?: string | null;
  agent?: string;
  agentProvider?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setupCmds?: string[];
  resumeSessionId?: string | null;
  recoverySnapshot?: SessionRecoveryState | null;
  transferImport?: TransferImportSummary | null;
  blockerTaskIds?: string[];
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
  const { requestedTaskId, ...body } = request;
  const path = requestedTaskId
    ? `/v1/tasks/${encodeURIComponent(requestedTaskId)}`
    : "/v1/tasks";
  return await requestJson<CreateDesktopTaskResponse>(path, {
    method: requestedTaskId ? "PUT" : "POST",
    body,
    retryMs: requestedTaskId ? 15_000 : undefined,
  });
}

interface DesktopRepoAgentProvidersResponse {
  providers: Array<{ id: string; executable: string }>;
}

export interface DesktopRepoKannaDefinitions {
  revision: string | null;
  refName: string;
  config: RepoConfig;
  defaultWorkflow: string;
  workflows: string[];
}

export interface DesktopRepoWorkflowDefinition {
  revision: string | null;
  definition: WorkflowDefinition;
}

export interface DesktopRepoAgentDefinition {
  revision: string | null;
  definition: AgentDefinition;
}

export interface DesktopRepoCommand {
  id: string;
  label: string;
  description: string;
  group: "automation" | "configure";
}

export interface DesktopRepoCommandCatalog {
  repoId: string;
  revision: string;
  commands: DesktopRepoCommand[];
}

export interface RunDesktopRepoCommandResponse {
  taskId: string;
  reused: boolean;
}

export async function fetchDesktopRepoCommands(
  repoId: string,
): Promise<DesktopRepoCommandCatalog> {
  if (clientHandlersForTests?.fetchRepoCommands) {
    return await clientHandlersForTests.fetchRepoCommands(repoId);
  }
  return await requestJson<DesktopRepoCommandCatalog>(
    `/v1/repos/${encodeURIComponent(repoId)}/commands`,
  );
}

export async function runDesktopRepoCommand(
  repoId: string,
  commandId: string,
  catalogRevision: string,
): Promise<RunDesktopRepoCommandResponse> {
  if (clientHandlersForTests?.runRepoCommand) {
    return await clientHandlersForTests.runRepoCommand(repoId, commandId, catalogRevision);
  }
  return await requestJson<RunDesktopRepoCommandResponse>(
    `/v1/repos/${encodeURIComponent(repoId)}/commands/${encodeURIComponent(commandId)}/run`,
    { method: "POST", body: { catalogRevision } },
  );
}

export async function fetchDesktopRepoKannaDefinitions(
  repoId: string,
): Promise<DesktopRepoKannaDefinitions> {
  if (clientHandlersForTests?.fetchRepoKannaDefinitions) {
    return await clientHandlersForTests.fetchRepoKannaDefinitions(repoId);
  }
  return await requestJson<DesktopRepoKannaDefinitions>(
    `/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions`,
  );
}

/**
 * Fetch the repo's `origin` and read back the definitions it now resolves to.
 * This is the one definitions call that waits on the network, so callers run it
 * beside a rendered UI rather than in front of one.
 */
export async function refreshDesktopRepoOrigin(
  repoId: string,
): Promise<DesktopRepoKannaDefinitions> {
  if (clientHandlersForTests?.refreshRepoOrigin) {
    return await clientHandlersForTests.refreshRepoOrigin(repoId);
  }
  return await requestJson<DesktopRepoKannaDefinitions>(
    `/v1/repos/${encodeURIComponent(repoId)}/fetch-origin`,
    { method: "POST" },
  );
}

export async function fetchDesktopRepoWorkflowDefinition(
  repoId: string,
  workflowName: string,
): Promise<DesktopRepoWorkflowDefinition> {
  if (clientHandlersForTests?.fetchRepoWorkflowDefinition) {
    return await clientHandlersForTests.fetchRepoWorkflowDefinition(repoId, workflowName);
  }
  return await requestJson<DesktopRepoWorkflowDefinition>(
    `/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions/workflows/${encodeURIComponent(workflowName)}`,
  );
}

export async function fetchDesktopRepoAgentDefinition(
  repoId: string,
  agentSelector: string,
): Promise<DesktopRepoAgentDefinition> {
  if (clientHandlersForTests?.fetchRepoAgentDefinition) {
    return await clientHandlersForTests.fetchRepoAgentDefinition(repoId, agentSelector);
  }
  return await requestJson<DesktopRepoAgentDefinition>(
    `/v1/repos/${encodeURIComponent(repoId)}/kanna-definitions/agents/${encodeURIComponent(agentSelector)}`,
  );
}

export async function fetchDesktopRepoAgentProviders(repoId: string): Promise<AgentProvider[]> {
  if (clientHandlersForTests?.fetchRepoAgentProviders) {
    return await clientHandlersForTests.fetchRepoAgentProviders(repoId);
  }
  const response = await requestJson<DesktopRepoAgentProvidersResponse>(
    `/v1/repos/${encodeURIComponent(repoId)}/agent-providers`,
  );
  return response.providers.map(({ id }) => id).filter(isAgentProvider);
}

interface DesktopRepoRecentWorkflowsResponse {
  workflows: string[];
}

/**
 * Workflows this repo's tasks were most recently created with, newest first.
 * Derived from durable task rows, so it survives closed tasks, lost create
 * responses, and restarts, and reads the same in every window.
 */
export async function fetchDesktopRepoRecentWorkflows(repoId: string): Promise<string[]> {
  if (clientHandlersForTests?.fetchRepoRecentWorkflows) {
    return await clientHandlersForTests.fetchRepoRecentWorkflows(repoId);
  }
  const response = await requestJson<DesktopRepoRecentWorkflowsResponse>(
    `/v1/repos/${encodeURIComponent(repoId)}/recent-workflows`,
  );
  return response.workflows;
}

export interface DesktopSettingResponse {
  key: string;
  value: string;
}

export interface DesktopCloudTransferIdentity {
  peerId: string;
  displayName: string;
  publicKey: string;
  protocolVersion: number;
  acceptingTransfers: boolean;
}

export async function putDesktopCloudTransferIdentity(
  identity: DesktopCloudTransferIdentity,
): Promise<void> {
  await requestJson<DesktopSettingResponse>("/v1/settings/cloud-transfer-identity", {
    method: "PUT",
    body: identity,
  });
}

export async function reconnectDesktopCloudRelay(): Promise<void> {
  await requestJson<void>("/v1/cloud/relay/actions/reconnect", {
    method: "POST",
  });
}

export interface DesktopWorkspaceWindowState {
  windowId: string;
  selectedRepoId: string | null;
  selectedItemId: string | null;
  sidebarHidden: boolean;
  sidebarWidth: number;
  order: number;
  geometry?: DesktopWorkspaceWindowGeometry | null;
}

export interface DesktopWorkspaceWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowWorkspaceSnapshot {
  windows: DesktopWorkspaceWindowState[];
}

export type DesktopWindowWorkspaceMutation =
  | { operation: "ensure"; window: DesktopWorkspaceWindowState }
  | { operation: "restore"; window: DesktopWorkspaceWindowState }
  | {
      operation: "updateSelection";
      windowId: string;
      selectedRepoId: string | null;
      selectedItemId: string | null;
    }
  | { operation: "updateSidebarHidden"; windowId: string; sidebarHidden: boolean }
  | { operation: "updateSidebarWidth"; windowId: string; sidebarWidth: number }
  | {
      operation: "updateGeometry";
      windowId: string;
      geometry: DesktopWorkspaceWindowGeometry;
    }
  | {
      operation: "remove";
      windowId: string;
      observedWindowIds?: string[];
      liveWindowIds?: string[];
    };

export async function mutateDesktopWindowWorkspace(
  mutation: DesktopWindowWorkspaceMutation,
): Promise<DesktopWindowWorkspaceSnapshot> {
  if (clientHandlersForTests?.mutateWindowWorkspace) {
    return await clientHandlersForTests.mutateWindowWorkspace(mutation);
  }
  return await requestJson<DesktopWindowWorkspaceSnapshot>("/v1/window-workspace/mutations", {
    method: "POST",
    body: mutation,
  });
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
  workflowItemId?: string | null;
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

export async function setDesktopTaskCloudIdentity(
  taskId: string,
  cloudTaskId: string,
): Promise<void> {
  if (clientHandlersForTests?.setTaskCloudIdentity) {
    await clientHandlersForTests.setTaskCloudIdentity(taskId, cloudTaskId);
    return;
  }
  await requestJson<{ cloudTaskId: string }>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/cloud-task-identity`,
    {
      method: "PUT",
      body: { cloudTaskId },
    },
  );
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
  defaultBranch?: string | null;
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

export interface SetDesktopTaskWorkflowResponse {
  taskId: string;
  workflowName: string;
  stage: string;
  revisionRounds: number;
  revisionLimit: number;
}

export async function setDesktopTaskWorkflow(
  taskId: string,
  workflowName: string,
): Promise<SetDesktopTaskWorkflowResponse> {
  if (clientHandlersForTests?.setTaskWorkflow) {
    return await clientHandlersForTests.setTaskWorkflow(taskId, workflowName);
  }
  return await requestJson<SetDesktopTaskWorkflowResponse>(
    `/v1/tasks/${encodeURIComponent(taskId)}/actions/set-workflow`,
    {
      method: "POST",
      body: { workflowName },
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

/**
 * Push a task to a paired machine.
 *
 * An intent, not the work: the engine performs the preflight, the git bundling,
 * the artifact staging and the commit, so the push survives this window
 * closing. Returns `false` when the same intent was already queued — a retried
 * request rather than a second transfer.
 */
export async function pushTaskToPeer(
  sourceTaskId: string,
  peerId: string,
  options: {
    transport?: "lan" | "cloud";
    cloudFallback?: boolean;
    targetDesktopId?: string | null;
    intentKey?: string;
  } = {},
): Promise<boolean> {
  if (clientHandlersForTests?.pushTaskToPeer) {
    return await clientHandlersForTests.pushTaskToPeer(sourceTaskId, peerId, options);
  }
  const response = await requestJson<{ scheduled: boolean }>(
    `/v1/tasks/${encodeURIComponent(sourceTaskId)}/actions/push-to-peer`,
    {
      method: "POST",
      body: {
        peerId,
        transport: options.transport,
        cloudFallback: options.cloudFallback ?? false,
        targetDesktopId: options.targetDesktopId ?? null,
        intentKey: options.intentKey,
      },
    },
  );
  return response.scheduled;
}

export async function approveIncomingTaskTransfer(transferId: string): Promise<boolean> {
  if (clientHandlersForTests?.approveIncomingTaskTransfer) {
    return await clientHandlersForTests.approveIncomingTaskTransfer(transferId);
  }
  const response = await requestJson<{ scheduled: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/approve`,
    { method: "POST" },
  );
  return response.scheduled;
}

export async function rejectIncomingTaskTransfer(transferId: string): Promise<boolean> {
  if (clientHandlersForTests?.rejectIncomingTaskTransfer) {
    return await clientHandlersForTests.rejectIncomingTaskTransfer(transferId);
  }
  const response = await requestJson<{ scheduled: boolean }>(
    `/v1/transfers/${encodeURIComponent(transferId)}/actions/reject-incoming`,
    { method: "POST" },
  );
  return response.scheduled;
}
