import { invoke } from "../invoke";
import { migrateLegacyDatabaseIfNeeded } from "../composables/useBackup";
import { debugLog } from "../utils/debugLog";
import type { DbHandle } from "../types/kanna";

interface AppliedMigrationRow {
  id: string;
}

const SERVER_SCHEMA_MARKER = "026_stage_run_resume";

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
  const response = await fetch(`${baseUrl}/v1/e2e/sql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  await migrateLegacyDatabaseIfNeeded(dbName);
  return { db: frontendSqlDisabledDb, dbName };
}

export async function checkDatabaseHealth(_db: DbHandle, _context: string): Promise<void> {
  // kanna-server now owns SQLite health checks during boot. This temporary
  // frontend shim remains for one release so older bootstrap call sites can
  // exist while the frontend has no SQLite connection.
}

export async function runMigrations(db: DbHandle): Promise<void> {
  // Temporary compatibility fallback: when an older frontend path hands us a
  // SQL handle, treat the server's final migration marker as proof that the
  // schema is already owned and migrated by kanna-server. The desired end
  // state is deleting this function after the compatibility window.
  try {
    const rows = await db.select<AppliedMigrationRow>(
      "SELECT id FROM schema_migrations WHERE id = ?",
      [SERVER_SCHEMA_MARKER],
    );
    if (rows.length > 0) return;
  } catch {
    return;
  }
}
