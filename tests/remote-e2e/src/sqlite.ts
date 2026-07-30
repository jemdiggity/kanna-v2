import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "./processes";

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repo (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  hidden INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_item (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_number INTEGER,
  issue_title TEXT,
  prompt TEXT,
  stage TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  branch TEXT,
  agent_type TEXT,
  activity TEXT,
  activity_changed_at TEXT,
  unread_at TEXT,
  pinned INTEGER,
  pin_order INTEGER,
  display_name TEXT,
  last_output_preview TEXT,
  closed_at TEXT,
  pipeline TEXT,
  agent_provider TEXT,
  port_offset INTEGER,
  port_env TEXT,
  base_ref TEXT,
  notify_task_id TEXT,
  notified_at TEXT,
  agent_session_id TEXT,
  agent_spawn_options TEXT,
  teardown_started_at TEXT,
  parent_task_id TEXT,
  pipeline_def TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS worktree (
  id TEXT PRIMARY KEY,
  pipeline_item_id TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_port (
  port INTEGER PRIMARY KEY,
  pipeline_item_id TEXT NOT NULL,
  env_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_session (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pipeline_item_id TEXT,
  label TEXT,
  cwd TEXT,
  daemon_session_id TEXT
);

CREATE TABLE IF NOT EXISTS stage_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
  agent TEXT,
  agent_provider TEXT,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  result TEXT,
  feedback TEXT,
  session_id TEXT,
  provider_session_id TEXT,
  cwd TEXT,
  resumed_from_run_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at);

CREATE TABLE IF NOT EXISTS task_blocker (
  blocked_item_id TEXT NOT NULL,
  blocker_item_id TEXT NOT NULL,
  PRIMARY KEY (blocked_item_id, blocker_item_id)
);
`;

export async function createHarnessDatabase(repoRoot: string, dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  await runCommand("sqlite3", [dbPath, schema], { cwd: repoRoot, env: process.env });
}
