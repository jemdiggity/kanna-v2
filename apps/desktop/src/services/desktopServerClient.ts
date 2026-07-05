import type { PipelineItem, Repo, TaskBlocker } from "@kanna/db";

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

export async function fetchDesktopSnapshot(): Promise<DesktopSnapshot> {
  if (snapshotFetcherForTests) return await snapshotFetcherForTests();
  return await requestJson<DesktopSnapshot>("/v1/snapshot", { retryMs: 15_000 });
}
