import type { DbHandle } from "./queries.js";

export async function runMigrations(database: DbHandle) {
  await database.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS worktree (
    id TEXT PRIMARY KEY, pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS terminal_session (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT, cwd TEXT, daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, error TEXT
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code')`);

  // Column additions (added in feature-parity update)
  const addColumn = async (sql: string) => {
    try { await database.execute(sql); } catch { /* column already exists */ }
  };
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN activity TEXT NOT NULL DEFAULT 'idle'`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN activity_changed_at TEXT`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN port_offset INTEGER`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN port_env TEXT`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN pin_order INTEGER`);
  await addColumn(`ALTER TABLE pipeline_item ADD COLUMN display_name TEXT`);
  await addColumn(`ALTER TABLE repo ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);

  // Pipeline simplification: map old stages to new
  try {
    await database.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
    await database.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
  } catch { /* migration already applied or no rows to update */ }
}
