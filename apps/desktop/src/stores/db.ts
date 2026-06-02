import * as tauriMock from "../tauri-mock";
import { invoke } from "../invoke";
import { migrateLegacyDatabaseIfNeeded } from "../composables/useBackup";
import type { DbHandle } from "@kanna/db";

interface AppliedMigrationRow {
  id: string;
}

interface QuickCheckRow {
  quick_check?: unknown;
}

export async function resolveDbName(): Promise<string> {
  if (!tauriMock.isTauri) return "mock";

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

  if (!tauriMock.isTauri) {
    const db = tauriMock.getMockDatabase() as unknown as DbHandle;
    return { db, dbName };
  }

  console.log("[db] using database:", dbName);
  await migrateLegacyDatabaseIfNeeded(dbName);
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = (await Database.load(`sqlite:${dbName}`)) as unknown as DbHandle;
  await checkDatabaseHealth(db, "startup");
  return { db, dbName };
}

export async function checkDatabaseHealth(db: DbHandle, context: string): Promise<void> {
  let rows: QuickCheckRow[];
  try {
    rows = await db.select<QuickCheckRow>("PRAGMA quick_check");
  } catch (error) {
    throw new Error(databaseHealthErrorMessage(context, String(error)));
  }

  const results = rows.map((row) => String(row.quick_check ?? ""));
  if (results.length > 0 && results.every((result) => result === "ok")) {
    return;
  }

  throw new Error(databaseHealthErrorMessage(context, results.join("; ") || "no quick_check rows"));
}

function databaseHealthErrorMessage(context: string, detail: string): string {
  return [
    `Database health check failed during ${context}.`,
    `SQLite reported: ${detail}.`,
    "Stop all Kanna processes, preserve the current database files, and restore from a recent backup or a vetted .recover output before continuing.",
  ].join(" ");
}

export async function runMigrations(db: DbHandle): Promise<void> {
  // Enable foreign key enforcement so ON DELETE CASCADE works
  await db.execute("PRAGMA foreign_keys = ON");
  // Checkpoint every 100 pages (~400 KB) instead of the default 1000 (~4 MB).
  // tauri-plugin-sql uses a 10-connection pool; idle connections hold open WAL read
  // snapshots that block checkpoints. A large WAL can then be partially truncated
  // mid-read by a checkpoint, causing SQLITE_IOERR_SHORT_READ (522) bursts.
  // Frequent small checkpoints keep the WAL too small for this race to matter.
  await db.execute("PRAGMA wal_autocheckpoint = 100");

  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
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
    try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch { console.debug(`[db] column ${table}.${col} already exists`); }
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
    await addColumn("pipeline_item", "previous_stage", "TEXT");
    await addColumn("pipeline_item", "teardown_started_at", "TEXT");
  });

  await runMigration("003_legacy_stage_to_tags_backfill", async () => {
    try {
      await db.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
      await db.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
      await db.execute(`UPDATE pipeline_item SET tags = '["done"]' WHERE stage = 'done' AND tags = '[]'`);
      await db.execute(`UPDATE pipeline_item SET tags = '["pr"]' WHERE stage = 'pr' AND tags = '[]'`);
      await db.execute(`UPDATE pipeline_item SET tags = '["merge"]' WHERE stage = 'merge' AND tags = '[]'`);
      await db.execute(`UPDATE pipeline_item SET tags = '["blocked"]' WHERE stage = 'blocked' AND tags = '[]'`);
    } catch (e) {
      console.debug("[db] stage/tags migration:", e);
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
    } catch (e) {
      console.debug("[db] activity_log accumulator migration:", e);
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
    await db.execute(`UPDATE pipeline_item SET stage = 'merge' WHERE tags LIKE '%"merge"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy')`);
    await db.execute(`UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'in_progress'`);
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
      "SELECT id, port_env FROM pipeline_item WHERE stage != 'done' AND port_env IS NOT NULL",
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
      } catch (e) {
        console.debug("[db] task_port backfill failed:", e);
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
    } catch (e) {
      console.debug("[db] agent_session_id backfill:", e);
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
        stage = COALESCE(previous_stage, 'in progress'),
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
}
