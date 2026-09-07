import { setTimeout as sleep } from "node:timers/promises";
import { localProcessFetch, type LocalProcessFetch } from "@kanna/local-process-fetch";

export interface SqlRow {
  [column: string]: unknown;
}

export async function serverSql(
  baseUrl: string,
  sql: string,
  params: unknown[] = [],
  fetchClient: LocalProcessFetch = localProcessFetch,
): Promise<SqlRow[]> {
  const response = await fetchClient(`${baseUrl}/v1/e2e/sql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, params, query: true }),
  });
  if (!response.ok) {
    throw new Error(`e2e sql failed (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as { rows: SqlRow[] }).rows;
}

export async function waitForSql(
  baseUrl: string,
  sql: string,
  params: unknown[],
  accept: (rows: SqlRow[]) => boolean,
  label: string,
  timeoutMs = 120_000,
  fetchClient: LocalProcessFetch = localProcessFetch,
): Promise<SqlRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: SqlRow[] = [];
  while (Date.now() < deadline) {
    last = await serverSql(baseUrl, sql, params, fetchClient);
    if (accept(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
