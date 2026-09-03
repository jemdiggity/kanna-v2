-- Seed data for Kanna development/testing.
-- Self-contained: creates schema if needed, then populates with realistic data.
--
-- Usage:
--   sqlite3 path/to/kanna.db < seed.sql
--   ./kd dev seed                  # seed the current instance's DB
--   ./kd dev up --seed             # start dev environment + seed

PRAGMA foreign_keys = ON;

-- ── Schema (idempotent) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repo_sidebar_order (
  remote_url_hash TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_item (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  issue_number INTEGER, issue_title TEXT, prompt TEXT,
  stage TEXT NOT NULL DEFAULT 'in_progress',
  pr_number INTEGER, pr_url TEXT, branch TEXT, agent_type TEXT,
  activity TEXT NOT NULL DEFAULT 'idle',
  activity_changed_at TEXT,
  port_offset INTEGER, port_env TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER,
  display_name TEXT, unread_at TEXT, closed_at TEXT,
  base_ref TEXT,
  teardown_started_at TEXT,
  notify_task_id TEXT, notified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_port (
  port INTEGER PRIMARY KEY,
  pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  env_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pipeline_item_id, env_name)
);

CREATE TABLE IF NOT EXISTS worktree (
  id TEXT PRIMARY KEY,
  pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  path TEXT NOT NULL, branch TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terminal_session (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
  label TEXT, cwd TEXT, daemon_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Accumulator schema (matches db.ts migration 004): one row per
-- (pipeline_item_id, activity) holding total seconds spent in that activity.
CREATE TABLE IF NOT EXISTS activity_log (
  pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pipeline_item_id, activity)
);
CREATE INDEX IF NOT EXISTS idx_activity_log_item ON activity_log(pipeline_item_id);

CREATE TABLE IF NOT EXISTS task_blocker (
  blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked_item_id, blocker_item_id)
);

CREATE TABLE IF NOT EXISTS operator_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL, pipeline_item_id TEXT, repo_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_operator_event_repo ON operator_event(repo_id, created_at);

-- ── Clear existing data (FK-safe order) ─────────────────────────────────────

DELETE FROM activity_log;
DELETE FROM task_port;
DELETE FROM task_blocker;
DELETE FROM operator_event;
DELETE FROM terminal_session;
DELETE FROM worktree;
DELETE FROM agent_run;
DELETE FROM pipeline_item;
DELETE FROM repo_sidebar_order;
DELETE FROM repo;
DELETE FROM settings;

-- ── Settings ────────────────────────────────────────────────────────────────

INSERT INTO settings (key, value) VALUES ('suspendAfterMinutes', '5');
INSERT INTO settings (key, value) VALUES ('killAfterMinutes', '30');
INSERT INTO settings (key, value) VALUES ('ideCommand', 'code');

-- ── Repos ───────────────────────────────────────────────────────────────────

INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
VALUES ('repo-seed-app', '/Users/test/example-app', 'example-app', 'main', 0, 0,
        datetime('now', '-30 days'), datetime('now', '-1 hours'));

INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
VALUES ('repo-seed-api', '/Users/test/example-api', 'example-api', 'main', 0, 1,
        datetime('now', '-60 days'), datetime('now', '-3 hours'));

INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
VALUES ('repo-seed-docs', '/Users/test/example-docs', 'example-docs', 'main', 0, 2,
        datetime('now', '-20 days'), datetime('now', '-2 days'));

-- ── Pipeline items ──────────────────────────────────────────────────────────

-- Auth refactor: in progress, working, pinned
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-auth-refactor', 'repo-seed-app', 42, 'Refactor auth middleware',
   'Refactor the auth middleware to use the new token validation library',
   'in progress', 'task-seed-auth-refactor',
  'claude', 'working', datetime('now', '-30 minutes'), 1, 1,
  1, '{"KANNA_DEV_PORT":"1421"}', 'origin/main', datetime('now', '-3 days'), datetime('now', '-30 minutes'));

INSERT INTO task_port (port, pipeline_item_id, env_name)
VALUES (1421, 'task-seed-auth-refactor', 'KANNA_DEV_PORT');

-- Dashboard: in progress, idle, pinned
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-dashboard', 'repo-seed-app', 51, 'Analytics dashboard',
   'Build the operator analytics dashboard with time-series charts',
   'in progress', 'task-seed-dashboard',
  'claude', 'idle', datetime('now', '-6 hours'), 1, 2,
  2, '{"KANNA_DEV_PORT":"1422"}', 'origin/main', datetime('now', '-5 days'), datetime('now', '-6 hours'));

INSERT INTO task_port (port, pipeline_item_id, env_name)
VALUES (1422, 'task-seed-dashboard', 'KANNA_DEV_PORT');

-- Onboarding: in progress, unread
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, unread_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-onboarding', 'repo-seed-app', 55, 'First-run onboarding',
   'Create a first-run onboarding flow that walks users through importing a repo',
   'in progress', 'task-seed-onboarding',
   'claude', 'unread', datetime('now', '-2 hours'), datetime('now', '-2 hours'), 'origin/main',
   datetime('now', '-2 days'), datetime('now', '-2 hours'));

-- Perf audit: has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-perf-audit', 'repo-seed-app', 38, 'Performance audit',
   'Audit frontend rendering performance and fix the top 3 bottlenecks',
   'pr', 'task-seed-perf-audit',
   'claude', 'idle', 67, 'https://github.com/test/example-app/pull/67', 'origin/main',
   datetime('now', '-7 days'), datetime('now', '-1 days'));

-- Search: in progress, working (api repo)
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-search', 'repo-seed-api', 12, 'Full-text search',
   'Implement full-text search across task prompts and issue titles',
   'in progress', 'task-seed-search',
   'claude', 'working', datetime('now', '-1 hours'),
   3, '{"KANNA_DEV_PORT":"1423"}', 'origin/main', datetime('now', '-4 days'), datetime('now', '-1 hours'));

INSERT INTO task_port (port, pipeline_item_id, env_name)
VALUES (1423, 'task-seed-search', 'KANNA_DEV_PORT');

-- Rate limiting: api repo, has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-rate-limit', 'repo-seed-api', 18, 'Rate limiting middleware',
   'Add rate limiting middleware with configurable per-route limits',
   'pr', 'task-seed-rate-limit',
   'claude', 'idle', 23, 'https://github.com/test/example-api/pull/23', 'origin/main',
   datetime('now', '-6 days'), datetime('now', '-2 days'));

-- Webhooks: api repo, in progress
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-webhooks', 'repo-seed-api', 21, 'Webhook delivery system',
   'Build a webhook delivery system with retry logic and event filtering',
   'in progress', 'task-seed-webhooks',
   'claude', 'idle', datetime('now', '-4 hours'), 'origin/main',
   datetime('now', '-3 days'), datetime('now', '-4 hours'));

-- API docs: docs repo, in progress, working
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-api-docs', 'repo-seed-docs', 5, 'API reference docs',
   'Write API reference documentation for all public endpoints',
   'in progress', 'task-seed-api-docs',
   'claude', 'working', datetime('now', '-45 minutes'), 1, 1, 'origin/main',
   datetime('now', '-4 days'), datetime('now', '-45 minutes'));

-- Tutorials: docs repo, in progress
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, activity_changed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-tutorials', 'repo-seed-docs', 8, 'Getting started tutorials',
   'Create getting started tutorials for common workflows',
   'in progress', 'task-seed-tutorials',
   'claude', 'idle', datetime('now', '-1 days'), 'origin/main',
   datetime('now', '-3 days'), datetime('now', '-1 days'));

-- Changelog: docs repo, has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-changelog', 'repo-seed-docs', 3, 'Auto-generated changelog',
   'Set up auto-generated changelog from git history',
   'pr', 'task-seed-changelog',
   'claude', 'idle', 7, 'https://github.com/test/example-docs/pull/7', 'origin/main',
   datetime('now', '-8 days'), datetime('now', '-3 days'));

-- Notifications: merged and closed (closed_at set; stage keeps its last real value)
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, pr_number, pr_url, closed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-notifications', 'repo-seed-app', 30, 'Desktop notifications',
   'Add native desktop notifications when agent runs complete',
   'pr', 'task-seed-notifications',
   'claude', 'idle', 52, 'https://github.com/test/example-app/pull/52', datetime('now', '-2 days'), 'origin/main',
   datetime('now', '-10 days'), datetime('now', '-2 days'));

-- Blocked migration: blocked by auth refactor
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, branch,
   agent_type, activity, display_name,
   created_at, updated_at)
VALUES
  ('task-seed-blocked-migration', 'repo-seed-app', 60, 'DB schema migration v3',
   'Run the v3 schema migration after auth refactor lands',
   'in progress', 'task-seed-blocked-migration',
   'claude', 'idle', 'Schema migration (blocked)',
   datetime('now', '-1 days'), datetime('now', '-1 days'));

-- Done cleanup: closed (closed_at is the sole done indicator)
INSERT INTO pipeline_item
  (id, repo_id, issue_title, prompt, stage,
   agent_type, activity, closed_at,
   created_at, updated_at)
VALUES
  ('task-seed-done-cleanup', 'repo-seed-app', 'Remove deprecated helpers',
   'Clean up unused helper functions from the utils module',
   'in progress',
   'claude', 'idle', datetime('now', '-5 days'),
   datetime('now', '-8 days'), datetime('now', '-5 days'));

-- ── Worktrees ───────────────────────────────────────────────────────────────

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-auth', 'task-seed-auth-refactor',
        '/Users/test/example-app/.kanna-worktrees/task-seed-auth-refactor',
        'task-seed-auth-refactor', datetime('now', '-3 days'));

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-dashboard', 'task-seed-dashboard',
        '/Users/test/example-app/.kanna-worktrees/task-seed-dashboard',
        'task-seed-dashboard', datetime('now', '-5 days'));

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-search', 'task-seed-search',
        '/Users/test/example-api/.kanna-worktrees/task-seed-search',
        'task-seed-search', datetime('now', '-4 days'));

-- ── Terminal sessions ───────────────────────────────────────────────────────

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-auth', 'repo-seed-app', 'task-seed-auth-refactor', 'claude',
        '/Users/test/example-app/.kanna-worktrees/task-seed-auth-refactor',
        'daemon-sess-1', datetime('now', '-3 days'));

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-dashboard', 'repo-seed-app', 'task-seed-dashboard', 'claude',
        '/Users/test/example-app/.kanna-worktrees/task-seed-dashboard',
        'daemon-sess-2', datetime('now', '-5 days'));

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-search', 'repo-seed-api', 'task-seed-search', 'claude',
        '/Users/test/example-api/.kanna-worktrees/task-seed-search',
        'daemon-sess-3', datetime('now', '-4 days'));

-- ── Agent runs ──────────────────────────────────────────────────────────────

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
VALUES ('ar-seed-auth', 'repo-seed-app', 'claude', 42, 'running',
        datetime('now', '-30 minutes'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
VALUES ('ar-seed-dashboard', 'repo-seed-app', 'claude', 51, 'running',
        datetime('now', '-6 hours'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, pr_number, status, started_at, finished_at)
VALUES ('ar-seed-done', 'repo-seed-app', 'claude', 30, 52, 'completed',
        datetime('now', '-10 days'), datetime('now', '-9 days'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at, finished_at, error)
VALUES ('ar-seed-failed', 'repo-seed-app', 'claude', 38, 'failed',
        datetime('now', '-8 days'), datetime('now', '-8 days'),
        'Claude CLI exited with code 1: context window exceeded');

-- ── Task blockers ───────────────────────────────────────────────────────────

INSERT INTO task_blocker (blocked_item_id, blocker_item_id)
VALUES ('task-seed-blocked-migration', 'task-seed-auth-refactor');

-- ── Activity log ────────────────────────────────────────────────────────────

-- Accumulated seconds per (task, activity) — one row per pair (PK).
INSERT INTO activity_log (pipeline_item_id, activity, seconds) VALUES
  ('task-seed-auth-refactor', 'working', 12600),
  ('task-seed-auth-refactor', 'idle', 3600),
  ('task-seed-dashboard', 'working', 18000),
  ('task-seed-dashboard', 'idle', 9000),
  ('task-seed-onboarding', 'working', 7200),
  ('task-seed-onboarding', 'unread', 1800);

-- ── Operator events ─────────────────────────────────────────────────────────

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('task_selected', 'task-seed-auth-refactor', 'repo-seed-app', datetime('now', '-1 hours'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('app_blur', NULL, 'repo-seed-app', datetime('now', '-45 minutes'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('app_focus', NULL, 'repo-seed-app', datetime('now', '-30 minutes'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('task_selected', 'task-seed-dashboard', 'repo-seed-app', datetime('now', '-1 days'));
