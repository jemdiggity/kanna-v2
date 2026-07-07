import { invoke } from "../invoke";
import { migrateLegacyDatabaseIfNeeded } from "../composables/useBackup";
import { debugLog } from "../utils/debugLog";
import type { DbHandle } from "../types/kanna";

interface AppliedMigrationRow {
  id: string;
}

const SERVER_SCHEMA_MARKER = "026_stage_run_resume";
const FRONTEND_SQL_DISABLED_MESSAGE = "frontend SQLite access is disabled";

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
  // schema is already owned and migrated by kanna-server. If that marker is
  // absent on a real SQL handle, run the legacy frontend sequence for one
  // release only. The desired end state is deleting this function after the
  // compatibility window, not keeping frontend schema ownership.
  try {
    const rows = await db.select<AppliedMigrationRow>(
      "SELECT id FROM schema_migrations WHERE id = ?",
      [SERVER_SCHEMA_MARKER],
    );
    if (rows.length > 0) return;
  } catch (error) {
    if (String(error).includes(FRONTEND_SQL_DISABLED_MESSAGE)) {
      return;
    }
  }

  await runLegacyFrontendMigrations(db);
}

async function runLegacyFrontendMigrations(db: DbHandle): Promise<void> {
  await db.execute("PRAGMA foreign_keys = ON");

  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    remote_url TEXT,
    remote_url_hash TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    pipeline_def TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
    agent_spawn_options TEXT,
    teardown_started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS task_port (
    port INTEGER PRIMARY KEY,
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    env_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pipeline_item_id, env_name)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS worktree (
    id TEXT PRIMARY KEY, pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS terminal_session (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT, cwd TEXT, daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, error TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS stage_run (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
    agent TEXT,
    agent_provider TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    result TEXT,
    feedback TEXT,
    session_id TEXT,
    provider_session_id TEXT,
    cwd TEXT,
    resumed_from_run_id TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const hasMigration = async (id: string): Promise<boolean> => {
    const rows = await db.select<AppliedMigrationRow>(
      "SELECT id FROM schema_migrations WHERE id = ?",
      [id],
    );
    return rows.length > 0;
  };

  const recordMigration = async (id: string): Promise<void> => {
    await db.execute(
      "INSERT INTO schema_migrations (id) VALUES (?)",
      [id],
    );
  };

  const runMigration = async (id: string, migrate: () => Promise<void>): Promise<void> => {
    if (await hasMigration(id)) return;
    await migrate();
    await recordMigration(id);
  };

  const addColumn = async (table: string, col: string, def: string) => {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch (error) {
      console.debug(`[db] column ${table}.${col} already exists:`, error);
    }
  };

  const dropColumn = async (table: string, col: string) => {
    try {
      await db.execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    } catch (error) {
      console.debug(`[db] column ${table}.${col} already absent or cannot be dropped:`, error);
    }
  };

  await runMigration("001_default_settings", async () => {
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5')`);
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30')`);
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code')`);
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('locale', 'en')`);
  });

  await runMigration("002_pipeline_item_metadata_columns", async () => {
    await addColumn("pipeline_item", "activity", "TEXT NOT NULL DEFAULT 'idle'");
    await addColumn("pipeline_item", "activity_changed_at", "TEXT");
    await addColumn("pipeline_item", "port_offset", "INTEGER");
    await addColumn("pipeline_item", "port_env", "TEXT");
    await addColumn("pipeline_item", "pinned", "INTEGER NOT NULL DEFAULT 0");
    await addColumn("pipeline_item", "pin_order", "INTEGER");
    await addColumn("pipeline_item", "display_name", "TEXT");
    await addColumn("pipeline_item", "unread_at", "TEXT");
    await addColumn("repo", "hidden", "INTEGER NOT NULL DEFAULT 0");
    await addColumn("repo", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    await addColumn("pipeline_item", "closed_at", "TEXT");
    await addColumn("pipeline_item", "agent_session_id", "TEXT");
    await addColumn("pipeline_item", "tags", "TEXT NOT NULL DEFAULT '[]'");
    await addColumn("pipeline_item", "base_ref", "TEXT");
    await addColumn("pipeline_item", "agent_provider", "TEXT NOT NULL DEFAULT 'claude'");
    await addColumn("pipeline_item", "agent_spawn_options", "TEXT");
    await addColumn("pipeline_item", "previous_stage", "TEXT");
    await addColumn("pipeline_item", "teardown_started_at", "TEXT");
  });

  await runMigration("003_legacy_stage_to_tags_backfill", async () => {
    try {
      await db.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
      await db.execute(`UPDATE pipeline_item SET closed_at = COALESCE(closed_at, updated_at, datetime('now')) WHERE stage IN ('needs_review', 'merged', 'closed')`);
      await db.execute(`UPDATE pipeline_item SET closed_at = COALESCE(closed_at, updated_at, datetime('now')) WHERE stage = 'done'`);
      await db.execute(`UPDATE pipeline_item SET tags = '["pr"]' WHERE stage = 'pr' AND tags = '[]'`);
      await db.execute(`UPDATE pipeline_item SET tags = '["merge"]' WHERE stage = 'merge' AND tags = '[]'`);
      await db.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'merge' AND closed_at IS NULL`);
      await db.execute(`UPDATE pipeline_item SET tags = '["blocked"]' WHERE stage = 'blocked' AND tags = '[]'`);
    } catch (error) {
      console.debug("[db] stage/tags migration:", error);
    }
  });

  await runMigration("004_activity_log_accumulator", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
      activity TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_activity_log_item ON activity_log(pipeline_item_id)`);
    try {
      await db.execute(`DROP TABLE IF EXISTS activity_log`);
      await db.execute(`DROP INDEX IF EXISTS idx_activity_log_item`);
      await db.execute(`CREATE TABLE IF NOT EXISTS activity_log (
        pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
        activity TEXT NOT NULL,
        seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pipeline_item_id, activity)
      )`);
    } catch (error) {
      console.debug("[db] activity_log accumulator migration:", error);
    }
  });

  await runMigration("005_task_blocker_table", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS task_blocker (
      blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
      blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
      PRIMARY KEY (blocked_item_id, blocker_item_id)
    )`);
  });

  await runMigration("006_operator_event_table", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS operator_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      pipeline_item_id TEXT,
      repo_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_operator_event_repo ON operator_event(repo_id, created_at)`);
  });

  await runMigration("007_pipeline_stage_columns", async () => {
    await addColumn("pipeline_item", "pipeline", "TEXT NOT NULL DEFAULT 'default'");
    await addColumn("pipeline_item", "stage_result", "TEXT");
  });

  await runMigration("008_tags_to_stage_backfill", async () => {
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"in progress"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy')`);
    await db.execute(`UPDATE pipeline_item SET stage = 'pr' WHERE tags LIKE '%"pr"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy')`);
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"merge"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy', 'merge')`);
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'in_progress'`);
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'merge' AND closed_at IS NULL`);
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'legacy'`);
  });

  await runMigration("009_task_port_table", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS task_port (
      port INTEGER PRIMARY KEY,
      pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
      env_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pipeline_item_id, env_name)
    )`);
    const activeItems = await db.select<{ id: string; port_env: string | null }>(
      "SELECT id, port_env FROM pipeline_item WHERE closed_at IS NULL AND port_env IS NOT NULL",
    );
    for (const item of activeItems) {
      try {
        const env = JSON.parse(item.port_env ?? "{}") as Record<string, string | number>;
        for (const [envName, value] of Object.entries(env)) {
          const port = typeof value === "number" ? value : parseInt(value, 10);
          if (!Number.isInteger(port) || port <= 0) continue;
          await db.execute(
            "INSERT OR IGNORE INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)",
            [port, item.id, envName],
          );
        }
      } catch (error) {
        console.debug("[db] task_port backfill failed:", error);
      }
    }
  });

  await runMigration("010_rename_torndown_stage", async () => {
    await db.execute(`UPDATE pipeline_item SET stage = 'teardown' WHERE stage = 'torndown'`);
  });

  await runMigration("011_pipeline_item_last_output_preview", async () => {
    await addColumn("pipeline_item", "last_output_preview", "TEXT");
  });

  await runMigration("012_pipeline_item_active_post_action", async () => {
    await addColumn("pipeline_item", "active_post_action", "TEXT");
  });

  await runMigration("013_task_transfer_tables", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS trusted_peer (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      paired_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      revoked_at TEXT
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS task_transfer (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      source_peer_id TEXT,
      target_peer_id TEXT,
      source_task_id TEXT,
      local_task_id TEXT REFERENCES pipeline_item(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      error TEXT,
      payload_json TEXT
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_task_transfer_local_task ON task_transfer(local_task_id, started_at DESC)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS task_transfer_provenance (
      pipeline_item_id TEXT PRIMARY KEY REFERENCES pipeline_item(id) ON DELETE CASCADE,
      source_peer_id TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      source_machine_task_label TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  await runMigration("014_task_transfer_payload_json", async () => {
    await addColumn("task_transfer", "payload_json", "TEXT");
  });

  await runMigration("015_agent_session_id_rename", async () => {
    await addColumn("pipeline_item", "agent_session_id", "TEXT");
    try {
      await db.execute(
        `UPDATE pipeline_item
            SET agent_session_id = claude_session_id
          WHERE agent_session_id IS NULL
            AND claude_session_id IS NOT NULL`,
      );
    } catch (error) {
      console.debug("[db] agent_session_id backfill:", error);
    }
  });

  await runMigration("016_repo_sort_order", async () => {
    await addColumn("repo", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    const repos = await db.select<{ id: string }>("SELECT id FROM repo ORDER BY created_at ASC");
    for (const [index, repo] of repos.entries()) {
      await db.execute("UPDATE repo SET sort_order = ? WHERE id = ?", [index, repo.id]);
    }
  });

  await runMigration("016_task_teardown_state", async () => {
    await addColumn("pipeline_item", "teardown_started_at", "TEXT");
    await db.execute(`
      UPDATE pipeline_item
      SET
        teardown_started_at = COALESCE(teardown_started_at, updated_at, datetime('now')),
        stage = 'in progress',
        updated_at = datetime('now')
      WHERE stage IN ('teardown', 'torndown')
        AND closed_at IS NULL
    `);
  });

  await runMigration("017_theme_preferences", async () => {
    await db.execute(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      ["appTheme", "dark"],
    );
    await db.execute(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      ["codeTheme", "match"],
    );
  });

  await runMigration("018_merge_stage_to_in_progress", async () => {
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'merge' AND closed_at IS NULL`);
  });

  await runMigration("019_repo_remote_metadata_columns", async () => {
    await addColumn("repo", "remote_url", "TEXT");
    await addColumn("repo", "remote_url_hash", "TEXT");
  });

  await runMigration("020_agent_message_appearance_preference", async () => {
    await db.execute(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      ["agentMessageAppearance", "chat"],
    );
  });

  await runMigration("020_pipeline_item_notify_task", async () => {
    await addColumn("pipeline_item", "notify_task_id", "TEXT");
    await addColumn("pipeline_item", "notified_at", "TEXT");
  });

  await runMigration("021_pipeline_item_agent_spawn_options", async () => {
    await addColumn("pipeline_item", "agent_spawn_options", "TEXT");
  });

  await runMigration("022_pipeline_item_parent_task_id", async () => {
    await addColumn("pipeline_item", "parent_task_id", "TEXT");
  });

  await runMigration("023_stage_run_pipeline_snapshot", async () => {
    await addColumn("pipeline_item", "pipeline_def", "TEXT");
    await db.execute(`CREATE TABLE IF NOT EXISTS stage_run (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      agent TEXT,
      agent_provider TEXT,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
      result TEXT,
      feedback TEXT,
      session_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at)`);
    await db.execute(`
      INSERT OR IGNORE INTO stage_run (
        id, task_id, stage, agent, agent_provider, model, status, result, feedback, session_id, started_at, finished_at
      )
      SELECT
        'migration-current-' || id,
        id,
        stage,
        agent_type,
        agent_provider,
        NULL,
        CASE
          WHEN stage_result IS NOT NULL
            AND json_valid(stage_result)
            AND json_extract(stage_result, '$.status') = 'success'
            THEN 'succeeded'
          WHEN stage_result IS NOT NULL
            AND json_valid(stage_result)
            AND json_extract(stage_result, '$.status') = 'failure'
            THEN 'failed'
          ELSE 'running'
        END,
        stage_result,
        CASE
          WHEN stage_result IS NOT NULL AND json_valid(stage_result)
            THEN json_extract(stage_result, '$.summary')
          ELSE NULL
        END,
        agent_session_id,
        COALESCE(activity_changed_at, created_at, datetime('now')),
        CASE
          WHEN stage_result IS NOT NULL
            AND json_valid(stage_result)
            AND json_extract(stage_result, '$.status') IN ('success', 'failure')
            THEN COALESCE(updated_at, datetime('now'))
          ELSE NULL
        END
      FROM pipeline_item
      WHERE closed_at IS NULL
        AND stage != 'done'
        AND NOT EXISTS (
          SELECT 1 FROM stage_run WHERE stage_run.task_id = pipeline_item.id
        )
    `);
  });

  await runMigration("024_pipeline_item_stage_graph_cleanup", async () => {
    await db.execute(`
      UPDATE pipeline_item
      SET
        closed_at = COALESCE(closed_at, updated_at, datetime('now')),
        stage = COALESCE(NULLIF(previous_stage, ''), 'in progress'),
        updated_at = datetime('now')
      WHERE stage = 'done'
        AND closed_at IS NULL
    `).catch((error) => {
      console.debug("[db] done-stage normalization without previous_stage:", error);
      return db.execute(`
        UPDATE pipeline_item
        SET
          closed_at = COALESCE(closed_at, updated_at, datetime('now')),
          stage = 'in progress',
          updated_at = datetime('now')
        WHERE stage = 'done'
          AND closed_at IS NULL
      `);
    });
    await dropColumn("pipeline_item", "tags");
    await dropColumn("pipeline_item", "stage_result");
    await dropColumn("pipeline_item", "active_post_action");
    await dropColumn("pipeline_item", "previous_stage");
  });

  await runMigration("025_stage_run_kind", async () => {
    await addColumn("stage_run", "kind", "TEXT NOT NULL DEFAULT 'main'");
  });

  await runMigration("026_stage_run_resume", async () => {
    await addColumn("stage_run", "provider_session_id", "TEXT");
    await addColumn("stage_run", "cwd", "TEXT");
    await addColumn("stage_run", "resumed_from_run_id", "TEXT");
  });
}
