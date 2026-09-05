import { invoke } from "../invoke";
import { debugLog } from "../utils/debugLog";
import type { DbHandle } from "../types/kanna";

async function e2eSqlRequest<T>(
  sql: string,
  params: unknown[],
  query: boolean,
): Promise<{ rows: T[]; rowsAffected: number }> {
  if (!import.meta.env.DEV || typeof window === "undefined" || !window.__KANNA_E2E__) {
    throw new Error("frontend SQLite access is disabled; use kanna-server APIs");
  }

  const { resolveCurrentKannaServerBaseUrl } = await import("../services/kannaServerBaseUrl");
  const baseUrl = await resolveCurrentKannaServerBaseUrl("running E2E SQL");
  const { localControlAuthHeaders } = await import("../services/localControlCredential");
  const response = await fetch(`${baseUrl}/v1/e2e/sql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await localControlAuthHeaders()) },
    body: JSON.stringify({ sql, params, query }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`E2E SQL failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  return await response.json() as { rows: T[]; rowsAffected: number };
}

const frontendSqlDisabledDb: DbHandle = {
  async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
    const result = await e2eSqlRequest<unknown>(sql, params, false);
    return { rowsAffected: result.rowsAffected };
  },
  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await e2eSqlRequest<T>(sql, params, true);
    return result.rows;
  },
};

export async function resolveDbName(): Promise<string> {
  let dbName = "kanna-v2.db";
  try {
    const envDb = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" });
    if (envDb) dbName = envDb;
  } catch (e) {
    console.debug("[db] KANNA_DB_NAME not set:", e);
  }

  return dbName;
}

export async function loadDatabase(): Promise<{ db: DbHandle; dbName: string }> {
  const dbName = await resolveDbName();
  debugLog("[db] using server-owned database:", dbName);
  return { db: frontendSqlDisabledDb, dbName };
}
