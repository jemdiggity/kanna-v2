-- Seed data for Kanna development/testing.
-- Self-contained: creates schema if needed, then populates with realistic data.
--
-- Usage:
--   sqlite3 path/to/kanna.db < seed.sql
--   ./scripts/dev.sh seed          # seed the current instance's DB
--   ./scripts/dev.sh start --seed  # start dev server + seed

PRAGMA foreign_keys = ON;

-- ── Schema (idempotent) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_item (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  issue_number INTEGER, issue_title TEXT, prompt TEXT,
  stage TEXT NOT NULL DEFAULT 'in_progress',
  tags TEXT NOT NULL DEFAULT '[]',
  pr_number INTEGER, pr_url TEXT, branch TEXT, agent_type TEXT,
  activity TEXT NOT NULL DEFAULT 'idle',
  activity_changed_at TEXT,
  port_offset INTEGER, port_env TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER,
  display_name TEXT, unread_at TEXT, closed_at TEXT,
  base_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
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
DELETE FROM task_blocker;
DELETE FROM operator_event;
DELETE FROM terminal_session;
DELETE FROM worktree;
DELETE FROM agent_run;
DELETE FROM pipeline_item;
DELETE FROM repo;
DELETE FROM settings;

-- ── Settings ────────────────────────────────────────────────────────────────

INSERT INTO settings (key, value) VALUES ('suspendAfterMinutes', '5');
INSERT INTO settings (key, value) VALUES ('killAfterMinutes', '30');
INSERT INTO settings (key, value) VALUES ('ideCommand', 'code');

-- ── Repos ───────────────────────────────────────────────────────────────────

INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
VALUES ('repo-seed-kanna', '/Users/test/kanna-tauri', 'kanna-tauri', 'main', 0,
        datetime('now', '-30 days'), datetime('now', '-1 hours'));

INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
VALUES ('repo-seed-api', '/Users/test/kanna-api', 'kanna-api', 'main', 0,
        datetime('now', '-60 days'), datetime('now', '-3 hours'));

INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
VALUES ('repo-seed-docs', '/Users/test/kanna-docs', 'kanna-docs', 'main', 0,
        datetime('now', '-20 days'), datetime('now', '-2 days'));

-- ── Pipeline items ──────────────────────────────────────────────────────────

-- Auth refactor: in progress, working, pinned
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-auth-refactor', 'repo-seed-kanna', 42, 'Refactor auth middleware',
   'Refactor the auth middleware to use the new token validation library',
   'in_progress', '["in progress"]', 'task-seed-auth-refactor',
   'claude', 'working', datetime('now', '-30 minutes'), 1, 1,
   1, '{"KANNA_DEV_PORT":"1421"}', 'origin/main', datetime('now', '-3 days'), datetime('now', '-30 minutes'));

-- Dashboard: in progress, idle, pinned
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-dashboard', 'repo-seed-kanna', 51, 'Analytics dashboard',
   'Build the operator analytics dashboard with time-series charts',
   'in_progress', '["in progress"]', 'task-seed-dashboard',
   'claude', 'idle', datetime('now', '-6 hours'), 1, 2,
   2, '{"KANNA_DEV_PORT":"1422"}', 'origin/main', datetime('now', '-5 days'), datetime('now', '-6 hours'));

-- Onboarding: in progress, unread
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, unread_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-onboarding', 'repo-seed-kanna', 55, 'First-run onboarding',
   'Create a first-run onboarding flow that walks users through importing a repo',
   'in_progress', '["in progress"]', 'task-seed-onboarding',
   'claude', 'unread', datetime('now', '-2 hours'), datetime('now', '-2 hours'), 'origin/main',
   datetime('now', '-2 days'), datetime('now', '-2 hours'));

-- Perf audit: has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-perf-audit', 'repo-seed-kanna', 38, 'Performance audit',
   'Audit frontend rendering performance and fix the top 3 bottlenecks',
   'pr', '["pr"]', 'task-seed-perf-audit',
   'claude', 'idle', 67, 'https://github.com/test/kanna-tauri/pull/67', 'origin/main',
   datetime('now', '-7 days'), datetime('now', '-1 days'));

-- Search: in progress, working (api repo)
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at,
   port_offset, port_env, base_ref, created_at, updated_at)
VALUES
  ('task-seed-search', 'repo-seed-api', 12, 'Full-text search',
   'Implement full-text search across task prompts and issue titles',
   'in_progress', '["in progress"]', 'task-seed-search',
   'claude', 'working', datetime('now', '-1 hours'),
   1, '{"KANNA_DEV_PORT":"1421"}', 'origin/main', datetime('now', '-4 days'), datetime('now', '-1 hours'));

-- Rate limiting: api repo, has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-rate-limit', 'repo-seed-api', 18, 'Rate limiting middleware',
   'Add rate limiting middleware with configurable per-route limits',
   'pr', '["pr"]', 'task-seed-rate-limit',
   'claude', 'idle', 23, 'https://github.com/test/kanna-api/pull/23', 'origin/main',
   datetime('now', '-6 days'), datetime('now', '-2 days'));

-- Webhooks: api repo, in progress
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-webhooks', 'repo-seed-api', 21, 'Webhook delivery system',
   'Build a webhook delivery system with retry logic and event filtering',
   'in_progress', '["in progress"]', 'task-seed-webhooks',
   'claude', 'idle', datetime('now', '-4 hours'), 'origin/main',
   datetime('now', '-3 days'), datetime('now', '-4 hours'));

-- API docs: docs repo, in progress, working
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, pinned, pin_order, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-api-docs', 'repo-seed-docs', 5, 'API reference docs',
   'Write API reference documentation for all public endpoints',
   'in_progress', '["in progress"]', 'task-seed-api-docs',
   'claude', 'working', datetime('now', '-45 minutes'), 1, 1, 'origin/main',
   datetime('now', '-4 days'), datetime('now', '-45 minutes'));

-- Tutorials: docs repo, in progress
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, activity_changed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-tutorials', 'repo-seed-docs', 8, 'Getting started tutorials',
   'Create getting started tutorials for common workflows',
   'in_progress', '["in progress"]', 'task-seed-tutorials',
   'claude', 'idle', datetime('now', '-1 days'), 'origin/main',
   datetime('now', '-3 days'), datetime('now', '-1 days'));

-- Changelog: docs repo, has PR
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, pr_number, pr_url, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-changelog', 'repo-seed-docs', 3, 'Auto-generated changelog',
   'Set up auto-generated changelog from git history',
   'pr', '["pr"]', 'task-seed-changelog',
   'claude', 'idle', 7, 'https://github.com/test/kanna-docs/pull/7', 'origin/main',
   datetime('now', '-8 days'), datetime('now', '-3 days'));

-- Notifications: done + merged
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, pr_number, pr_url, closed_at, base_ref,
   created_at, updated_at)
VALUES
  ('task-seed-notifications', 'repo-seed-kanna', 30, 'Desktop notifications',
   'Add native desktop notifications when agent runs complete',
   'done', '["done","merge"]', 'task-seed-notifications',
   'claude', 'idle', 52, 'https://github.com/test/kanna-tauri/pull/52', datetime('now', '-2 days'), 'origin/main',
   datetime('now', '-10 days'), datetime('now', '-2 days'));

-- Blocked migration: blocked by auth refactor
INSERT INTO pipeline_item
  (id, repo_id, issue_number, issue_title, prompt, stage, tags, branch,
   agent_type, activity, display_name,
   created_at, updated_at)
VALUES
  ('task-seed-blocked-migration', 'repo-seed-kanna', 60, 'DB schema migration v3',
   'Run the v3 schema migration after auth refactor lands',
   'in_progress', '["in progress","blocked"]', 'task-seed-blocked-migration',
   'claude', 'idle', 'Schema migration (blocked)',
   datetime('now', '-1 days'), datetime('now', '-1 days'));

-- Done cleanup: done, closed
INSERT INTO pipeline_item
  (id, repo_id, issue_title, prompt, stage, tags,
   agent_type, activity, closed_at,
   created_at, updated_at)
VALUES
  ('task-seed-done-cleanup', 'repo-seed-kanna', 'Remove deprecated helpers',
   'Clean up unused helper functions from the utils module',
   'done', '["done"]',
   'claude', 'idle', datetime('now', '-5 days'),
   datetime('now', '-8 days'), datetime('now', '-5 days'));

-- ── Worktrees ───────────────────────────────────────────────────────────────

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-auth', 'task-seed-auth-refactor',
        '/Users/test/kanna-tauri/.kanna-worktrees/task-seed-auth-refactor',
        'task-seed-auth-refactor', datetime('now', '-3 days'));

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-dashboard', 'task-seed-dashboard',
        '/Users/test/kanna-tauri/.kanna-worktrees/task-seed-dashboard',
        'task-seed-dashboard', datetime('now', '-5 days'));

INSERT INTO worktree (id, pipeline_item_id, path, branch, created_at)
VALUES ('wt-seed-search', 'task-seed-search',
        '/Users/test/kanna-api/.kanna-worktrees/task-seed-search',
        'task-seed-search', datetime('now', '-4 days'));

-- ── Terminal sessions ───────────────────────────────────────────────────────

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-auth', 'repo-seed-kanna', 'task-seed-auth-refactor', 'claude',
        '/Users/test/kanna-tauri/.kanna-worktrees/task-seed-auth-refactor',
        'daemon-sess-1', datetime('now', '-3 days'));

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-dashboard', 'repo-seed-kanna', 'task-seed-dashboard', 'claude',
        '/Users/test/kanna-tauri/.kanna-worktrees/task-seed-dashboard',
        'daemon-sess-2', datetime('now', '-5 days'));

INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id, created_at)
VALUES ('ts-seed-search', 'repo-seed-api', 'task-seed-search', 'claude',
        '/Users/test/kanna-api/.kanna-worktrees/task-seed-search',
        'daemon-sess-3', datetime('now', '-4 days'));

-- ── Agent runs ──────────────────────────────────────────────────────────────

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
VALUES ('ar-seed-auth', 'repo-seed-kanna', 'claude', 42, 'running',
        datetime('now', '-30 minutes'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at)
VALUES ('ar-seed-dashboard', 'repo-seed-kanna', 'claude', 51, 'running',
        datetime('now', '-6 hours'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, pr_number, status, started_at, finished_at)
VALUES ('ar-seed-done', 'repo-seed-kanna', 'claude', 30, 52, 'completed',
        datetime('now', '-10 days'), datetime('now', '-9 days'));

INSERT INTO agent_run (id, repo_id, agent_type, issue_number, status, started_at, finished_at, error)
VALUES ('ar-seed-failed', 'repo-seed-kanna', 'claude', 38, 'failed',
        datetime('now', '-8 days'), datetime('now', '-8 days'),
        'Claude CLI exited with code 1: context window exceeded');

-- ── Task blockers ───────────────────────────────────────────────────────────

INSERT INTO task_blocker (blocked_item_id, blocker_item_id)
VALUES ('task-seed-blocked-migration', 'task-seed-auth-refactor');

-- ── Activity log ────────────────────────────────────────────────────────────

INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-auth-refactor', 'working', datetime('now', '-3 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-auth-refactor', 'idle', datetime('now', '-2 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-auth-refactor', 'working', datetime('now', '-30 minutes'));

INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-dashboard', 'working', datetime('now', '-5 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-dashboard', 'idle', datetime('now', '-4 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-dashboard', 'working', datetime('now', '-1 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-dashboard', 'idle', datetime('now', '-6 hours'));

INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-onboarding', 'working', datetime('now', '-2 days'));
INSERT INTO activity_log (pipeline_item_id, activity, started_at)
VALUES ('task-seed-onboarding', 'unread', datetime('now', '-2 hours'));

-- ── Operator events ─────────────────────────────────────────────────────────

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('task_selected', 'task-seed-auth-refactor', 'repo-seed-kanna', datetime('now', '-1 hours'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('app_blur', NULL, 'repo-seed-kanna', datetime('now', '-45 minutes'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('app_focus', NULL, 'repo-seed-kanna', datetime('now', '-30 minutes'));

INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
VALUES ('task_selected', 'task-seed-dashboard', 'repo-seed-kanna', datetime('now', '-1 days'));
