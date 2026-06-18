CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER,
    issue_title TEXT,
    prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'queued',
    active_post_action TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    branch TEXT,
    agent_type TEXT,
    agent_spawn_options TEXT,
    teardown_started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worktree (
    id TEXT PRIMARY KEY,
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terminal_session (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT,
    cwd TEXT,
    daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL,
    issue_number INTEGER,
    pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code');
