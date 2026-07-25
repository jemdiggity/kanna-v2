PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE repo (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    remote_url TEXT,
    remote_url_hash TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pipeline_item (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER,
    issue_title TEXT,
    prompt TEXT,
    pipeline_def TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress',
    pr_number INTEGER,
    pr_url TEXT,
    branch TEXT,
    agent_type TEXT,
    agent_spawn_options TEXT,
    teardown_started_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    activity TEXT NOT NULL DEFAULT 'idle',
    activity_changed_at TEXT,
    port_offset INTEGER,
    port_env TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    pin_order INTEGER,
    display_name TEXT,
    unread_at TEXT,
    closed_at TEXT,
    agent_session_id TEXT,
    base_ref TEXT,
    agent_provider TEXT NOT NULL DEFAULT 'claude',
    pipeline TEXT NOT NULL DEFAULT 'default',
    last_output_preview TEXT,
    notify_task_id TEXT,
    notified_at TEXT,
    parent_task_id TEXT,
    pr_branch TEXT
);

CREATE TABLE task_port (
    port INTEGER PRIMARY KEY,
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    env_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pipeline_item_id, env_name)
);

CREATE TABLE worktree (
    id TEXT PRIMARY KEY,
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE terminal_session (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT,
    cwd TEXT,
    daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_run (
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

CREATE TABLE activity_log (
    pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    activity TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pipeline_item_id, activity)
);

CREATE TABLE task_blocker (
    blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    PRIMARY KEY (blocked_item_id, blocker_item_id)
);

CREATE TABLE operator_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    pipeline_item_id TEXT,
    repo_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_operator_event_repo ON operator_event(repo_id, created_at);

CREATE TABLE trusted_peer (
    id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    paired_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    revoked_at TEXT
);

CREATE TABLE task_transfer (
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
);
CREATE INDEX idx_task_transfer_local_task
    ON task_transfer(local_task_id, started_at DESC);

CREATE TABLE task_transfer_provenance (
    pipeline_item_id TEXT PRIMARY KEY REFERENCES pipeline_item(id) ON DELETE CASCADE,
    source_peer_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    source_machine_task_label TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE stage_run (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
    agent TEXT,
    agent_provider TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    result TEXT,
    feedback TEXT,
    session_id TEXT,
    provider_session_id TEXT,
    cwd TEXT,
    resumed_from_run_id TEXT,
    completion_transition TEXT CHECK (completion_transition IN ('manual', 'auto')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);
CREATE INDEX idx_stage_run_task_started ON stage_run(task_id, started_at);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
    ('suspendAfterMinutes', '5'),
    ('killAfterMinutes', '30'),
    ('ideCommand', 'code'),
    ('locale', 'en'),
    ('appTheme', 'dark'),
    ('codeTheme', 'match'),
    ('agentMessageAppearance', 'chat');

INSERT INTO repo (
    id,
    path,
    name,
    default_branch,
    hidden,
    sort_order,
    created_at,
    last_opened_at
) VALUES (
    'origin-main-repo',
    '/tmp/origin-main-repo',
    'Origin Main Repo',
    'main',
    0,
    0,
    '2026-07-24 10:00:00',
    '2026-07-24 10:00:00'
);

INSERT INTO pipeline_item (
    id,
    repo_id,
    prompt,
    pipeline,
    stage,
    branch,
    agent_type,
    agent_provider,
    activity,
    activity_changed_at,
    closed_at,
    pinned,
    display_name,
    created_at,
    updated_at
) VALUES (
    'origin-main-task',
    'origin-main-repo',
    'Existing origin/main task',
    'default',
    'in progress',
    'task-origin-main',
    'claude',
    'claude',
    'idle',
    '2026-07-24 10:05:00',
    NULL,
    0,
    'Existing Task',
    '2026-07-24 10:00:00',
    '2026-07-24 10:05:00'
);
