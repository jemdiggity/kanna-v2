import type { PipelineItem, Repo, TaskBlocker } from "@kanna/db";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";

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
let taskCreatorForTests: ((request: CreateDesktopTaskRequest) => Promise<CreateDesktopTaskResponse>) | null = null;
let taskActionForTests: ((action: string, taskId: string, body?: unknown) => Promise<void>) | null = null;

export function setDesktopSnapshotFetcherForTests(fetcher: (() => Promise<DesktopSnapshot>) | null): void {
  snapshotFetcherForTests = fetcher;
}

export function setDesktopTaskCreatorForTests(creator: ((request: CreateDesktopTaskRequest) => Promise<CreateDesktopTaskResponse>) | null): void {
  taskCreatorForTests = creator;
}

export function setDesktopTaskActionForTests(actionHandler: ((action: string, taskId: string, body?: unknown) => Promise<void>) | null): void {
  taskActionForTests = actionHandler;
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

async function requestJson<T>(path: string, options: { retryMs?: number } = {}): Promise<T> {
  const baseUrl = await desktopServerBaseUrl();
  const deadline = Date.now() + (options.retryMs ?? 0);
  let lastError: unknown = null;

  while (true) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { method: "GET" });
      if (response.ok) {
        return await response.json() as T;
      }
      const body = await response.text().catch(() => "");
      lastError = new Error(`GET ${path} failed: ${response.status}${body ? ` ${body}` : ""}`);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
    }
    await sleep(200);
  }
}

async function post(path: string, body?: unknown): Promise<void> {
  const baseUrl = await desktopServerBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, body === undefined
    ? { method: "POST" }
    : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
}

async function patch(path: string, body: unknown): Promise<void> {
  const baseUrl = await desktopServerBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`PATCH ${path} failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = await desktopServerBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  return await response.json() as T;
}

export async function fetchDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (snapshotFetcherForTests) return await snapshotFetcherForTests();
  return await requestJson<DesktopSnapshot>("/v1/snapshot", { retryMs: 15_000 });
}

export async function closeDesktopTask(taskId: string): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("close", taskId);
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/close`);
}

export async function reopenDesktopTask(taskId: string): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("reopen", taskId);
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/reopen`);
}

export async function markDesktopTaskRead(taskId: string): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("mark-read", taskId);
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/mark-read`);
}

export async function blockDesktopTask(taskId: string, blockerTaskIds: string[]): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("block", taskId, { blockerTaskIds });
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/block`, { blockerTaskIds });
}

export async function unblockDesktopTask(taskId: string): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("unblock", taskId);
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/unblock`);
}

export interface CreateDesktopTaskRequest {
  repoId: string;
  prompt: string;
  displayName?: string | null;
  pipelineName?: string;
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

export async function createDesktopTask(request: CreateDesktopTaskRequest): Promise<CreateDesktopTaskResponse> {
  if (taskCreatorForTests) return await taskCreatorForTests(request);
  return await postJson<CreateDesktopTaskResponse>("/v1/tasks", request);
}

export async function renameDesktopTask(taskId: string, displayName: string | null): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("rename", taskId, { displayName });
  await patch(`/v1/tasks/${encodeURIComponent(taskId)}`, { displayName });
}

export async function setDesktopTaskParent(taskId: string, parentTaskId: string | null): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("set-parent", taskId, { parentTaskId });
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/set-parent`, { parentTaskId });
}

export async function pinDesktopTask(taskId: string, position: number): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("pin", taskId, { position });
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/pin`, { position });
}

export async function unpinDesktopTask(taskId: string): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("unpin", taskId);
  await post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/unpin`);
}

export async function reorderDesktopPinnedTasks(orderedIds: string[]): Promise<void> {
  if (taskActionForTests) return await taskActionForTests("reorder-pinned", "", { orderedIds });
  await post("/v1/tasks/actions/reorder-pinned", { orderedIds });
}
