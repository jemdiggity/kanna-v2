import { isTauri, getMockDatabase } from "../tauri-mock";
import { invoke } from "../invoke";
import { backupOnStartup } from "../composables/useBackup";
import type { DbHandle } from "@kanna/db";

export async function resolveDbName(): Promise<string> {
  if (!isTauri) return "mock";

  let dbName = "kanna-v2.db";
  try {
    const envDb = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" });
    if (envDb) dbName = envDb;
  } catch (e) {
    console.debug("[db] KANNA_DB_NAME not set:", e);
  }

  try {
    const wt = await invoke<string>("read_env_var", { name: "KANNA_WORKTREE" });
    if (wt) {
      const daemonDir = await invoke<string>("read_env_var", { name: "KANNA_DAEMON_DIR" }).catch(() => "");
      let suffix = Date.now().toString();
      if (daemonDir) {
        const parts = daemonDir.split("/");
        const idx = parts.indexOf(".kanna-daemon");
        if (idx > 0) suffix = parts[idx - 1];
      }
      dbName = `kanna-wt-${suffix}.db`;
    }
  } catch (e) {
    console.debug("[db] KANNA_WORKTREE not set:", e);
  }

  return dbName;
}

export async function loadDatabase(): Promise<{ db: DbHandle; dbName: string }> {
  const dbName = await resolveDbName();

  if (!isTauri) {
    const db = getMockDatabase() as unknown as DbHandle;
    return { db, dbName };
  }

  console.log("[db] using database:", dbName);
  await backupOnStartup(dbName);
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = (await Database.load(`sqlite:${dbName}`)) as unknown as DbHandle;
  return { db, dbName };
}

export async function runMigrations(db: DbHandle): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code')`);

  const addColumn = async (table: string, col: string, def: string) => {
    try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch { console.debug(`[db] column ${table}.${col} already exists`); }
  };
  await addColumn("pipeline_item", "activity", "TEXT NOT NULL DEFAULT 'idle'");
  await addColumn("pipeline_item", "activity_changed_at", "TEXT");
  await addColumn("pipeline_item", "port_offset", "INTEGER");
  await addColumn("pipeline_item", "port_env", "TEXT");
  await addColumn("pipeline_item", "pinned", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("pipeline_item", "pin_order", "INTEGER");
  await addColumn("pipeline_item", "display_name", "TEXT");
  await addColumn("repo", "hidden", "INTEGER NOT NULL DEFAULT 0");

  try {
    await db.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
    await db.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
  } catch (e) { console.debug("[db] stage migration:", e); }
}
