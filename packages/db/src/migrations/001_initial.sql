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
    pipeline TEXT NOT NULL DEFAULT 'default',
    stage TEXT NOT NULL DEFAULT 'in progress',
    pr_number INTEGER,
    pr_url TEXT,
    branch TEXT,
    agent_type TEXT,
    agent_provider TEXT NOT NULL DEFAULT 'claude',
    activity TEXT NOT NULL DEFAULT 'idle',
    activity_revision INTEGER NOT NULL DEFAULT 0,
    activity_changed_at TEXT,
    unread_at TEXT,
    port_offset INTEGER,
    port_env TEXT,
    agent_spawn_options TEXT,
    teardown_started_at TEXT,
    closed_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    pin_order INTEGER,
    display_name TEXT,
    last_output_preview TEXT,
    base_ref TEXT,
    agent_session_id TEXT,
    notify_task_id TEXT,
    notified_at TEXT,
    parent_task_id TEXT,
    pipeline_def TEXT,
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

CREATE TABLE IF NOT EXISTS stage_run (
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
    completion_transition TEXT CHECK (completion_transition IN ('manual', 'auto')),
    completion_attempt TEXT,
    run_ownership_version INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at);

CREATE TABLE IF NOT EXISTS task_action_request (
    idempotency_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    request_json TEXT NOT NULL,
    successor_run_id TEXT UNIQUE REFERENCES stage_run(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
    http_status INTEGER,
    response_body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_action_request_updated
    ON task_action_request(state, updated_at);
