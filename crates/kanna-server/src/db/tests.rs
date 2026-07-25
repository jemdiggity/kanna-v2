use super::NewStageRun;
use super::{database_open_flags, Db, NewPipelineItem};
use rusqlite::Connection;
use rusqlite::OpenFlags;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db_path() -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_nanos();
    let counter = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("kanna-server-db-{suffix}-{counter}.sqlite"))
}

#[test]
fn database_open_flags_use_sqlite_mutexes_for_shared_desktop_db() {
    let flags = database_open_flags();

    assert!(flags.contains(OpenFlags::SQLITE_OPEN_FULL_MUTEX));
    assert!(!flags.contains(OpenFlags::SQLITE_OPEN_NO_MUTEX));
}

#[test]
fn setting_mutations_are_serialized_across_connections() {
    let path = temp_db_path();
    let path_string = path.to_string_lossy().to_string();
    let seed = Db::open_for_tests(&path_string).expect("seed db");
    seed.set_setting("window_workspace_v1", r#"{"windows":[]}"#)
        .expect("seed setting");
    drop(seed);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for window_id in ["main", "window-2"] {
        let barrier = barrier.clone();
        let path = path_string.clone();
        handles.push(std::thread::spawn(move || {
            let db = Db::open(&path).expect("open shared db");
            barrier.wait();
            db.mutate_setting("window_workspace_v1", |current| {
                let mut value: serde_json::Value =
                    serde_json::from_str(current.as_deref().unwrap_or(r#"{"windows":[]}"#))
                        .expect("parse setting");
                value["windows"]
                    .as_array_mut()
                    .expect("windows array")
                    .push(serde_json::json!({ "windowId": window_id }));
                std::thread::sleep(std::time::Duration::from_millis(25));
                Ok(value.to_string())
            })
            .expect("mutate setting");
        }));
    }
    for handle in handles {
        handle.join().expect("mutation thread");
    }

    let db = Db::open(&path_string).expect("reopen db");
    let value: serde_json::Value = serde_json::from_str(
        &db.get_setting("window_workspace_v1")
            .expect("read setting")
            .expect("setting exists"),
    )
    .expect("parse final setting");
    let mut ids = value["windows"]
        .as_array()
        .expect("windows array")
        .iter()
        .filter_map(|window| window["windowId"].as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    assert_eq!(ids, vec!["main", "window-2"]);

    let _ = std::fs::remove_file(path);
}

#[test]
fn open_applies_desktop_compatible_pragmas() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open temp db");
    conn.execute_batch("CREATE TABLE probe (id INTEGER PRIMARY KEY);")
        .expect("seed db");
    drop(conn);

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");

    let journal_mode: String = db
        .conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal mode");
    let foreign_keys: i64 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("foreign keys");
    let busy_timeout: i64 = db
        .conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .expect("busy timeout");
    let wal_autocheckpoint: i64 = db
        .conn
        .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
        .expect("wal autocheckpoint");

    assert_eq!(journal_mode, "wal");
    assert_eq!(foreign_keys, 1);
    assert!(busy_timeout >= 10_000);
    assert_eq!(wal_autocheckpoint, 100);

    let _ = std::fs::remove_file(path);
}

#[test]
fn open_does_not_create_or_migrate_schema() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open temp db");
    conn.execute_batch("CREATE TABLE probe (id INTEGER PRIMARY KEY);")
        .expect("seed db");
    drop(conn);

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");

    let schema_migrations_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |row| row.get(0),
        )
        .expect("schema migration table probe");
    assert_eq!(schema_migrations_count, 0);

    let _ = std::fs::remove_file(path);
}

#[test]
fn open_creates_and_migrates_fresh_profile_database() {
    let path = temp_db_path();
    let _ = std::fs::remove_file(&path);

    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open fresh db");

    let setting_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key IN ('suspendAfterMinutes', 'killAfterMinutes', 'ideCommand', 'locale')",
            [],
            |row| row.get(0),
        )
        .expect("default settings");
    assert_eq!(setting_count, 4);

    let latest_migration: String = db
        .conn
        .query_row(
            "SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("latest migration");
    assert_eq!(latest_migration, "029_pipeline_item_activity_revision");

    let stage_run_sql: String = db
        .conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stage_run'",
            [],
            |row| row.get(0),
        )
        .expect("stage_run schema");
    assert!(stage_run_sql.contains("provider_session_id"));
    assert!(stage_run_sql.contains("resumed_from_run_id"));
    assert!(stage_run_sql.contains("completion_transition"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn open_migrates_legacy_frontend_schema_with_backfills() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open legacy db");
    conn.execute_batch(
        r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE repo (
              id TEXT PRIMARY KEY,
              path TEXT NOT NULL,
              name TEXT NOT NULL,
              default_branch TEXT NOT NULL DEFAULT 'main',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
              issue_number INTEGER,
              issue_title TEXT,
              prompt TEXT,
              stage TEXT NOT NULL DEFAULT 'in_progress',
              pr_number INTEGER,
              pr_url TEXT,
              branch TEXT,
              agent_type TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO repo (id, path, name, created_at) VALUES ('repo-1', '/tmp/repo-1', 'Repo One', '2026-01-01 00:00:00');
            INSERT INTO pipeline_item (id, repo_id, prompt, stage, branch, agent_type, created_at, updated_at)
            VALUES
              ('task-merge', 'repo-1', 'merge prompt', 'merge', 'task-merge', 'pty', '2026-01-02 00:00:00', '2026-01-02 00:00:00'),
              ('task-port', 'repo-1', 'port prompt', 'in_progress', 'task-port', 'pty', '2026-01-03 00:00:00', '2026-01-03 00:00:00');
        "#,
    )
    .expect("seed legacy db");
    drop(conn);

    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("migrate legacy db");

    let (stage, pipeline, provider): (String, String, String) = db
        .conn
        .query_row(
            "SELECT stage, pipeline, agent_provider FROM pipeline_item WHERE id = 'task-merge'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("migrated pipeline item");
    assert_eq!(stage, "in progress");
    assert_eq!(pipeline, "default");
    assert_eq!(provider, "claude");

    let stage_run_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM stage_run WHERE task_id IN ('task-merge', 'task-port')",
            [],
            |row| row.get(0),
        )
        .expect("stage run backfill");
    assert_eq!(stage_run_count, 2);

    let _ = std::fs::remove_file(path);
}

#[test]
fn server_connection_opens_with_desktop_like_wal_client_active() {
    let path = temp_db_path();
    let desktop_conn = Connection::open(&path).expect("open desktop-like db");
    desktop_conn
        .busy_timeout(std::time::Duration::from_millis(10_000))
        .expect("set busy timeout");
    desktop_conn
        .execute_batch(
            r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA wal_autocheckpoint = 100;
                CREATE TABLE pipeline_item (
                  id TEXT PRIMARY KEY,
                  stage TEXT NOT NULL,
                  closed_at TEXT,
                  updated_at TEXT
                );
                CREATE TABLE task_port (
                  port INTEGER PRIMARY KEY,
                  pipeline_item_id TEXT NOT NULL,
                  env_name TEXT NOT NULL
                );
                INSERT INTO pipeline_item (id, stage) VALUES ('task-1', 'in progress');
                "#,
        )
        .expect("seed desktop-like db");

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open server db");
    db.close_pipeline_item("task-1").expect("server write");

    let stage: String = desktop_conn
        .query_row(
            "SELECT stage FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .expect("desktop-like read");
    assert_eq!(stage, "in progress");

    drop(db);
    drop(desktop_conn);
    let _ = std::fs::remove_file(path);
}

#[test]
fn open_fails_with_clear_error_when_quick_check_cannot_read_database() {
    let path = temp_db_path();
    std::fs::write(&path, b"this is not a sqlite database").expect("write corrupt db");

    let err =
        Db::open_migrated(path.to_str().expect("utf8 path")).expect_err("corrupt db should fail");
    let message = err.to_string();

    assert!(
        message.contains("database disk image is malformed")
            || message.contains("file is not a database")
            || message.contains("quick_check"),
        "unexpected error: {message}"
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn close_pipeline_item_sets_closed_at_without_changing_stage() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open temp db");
    conn.execute_batch(
        r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              stage TEXT NOT NULL,
              closed_at TEXT,
              updated_at TEXT
            );
            CREATE TABLE task_port (
              port INTEGER PRIMARY KEY,
              pipeline_item_id TEXT NOT NULL,
              env_name TEXT NOT NULL
            );
            INSERT INTO pipeline_item (id, stage) VALUES ('task-1', 'in progress');
            "#,
    )
    .expect("seed db");
    drop(conn);

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
    db.close_pipeline_item("task-1").expect("close task");

    let conn = Connection::open(&path).expect("re-open db");
    let (stage, closed_at): (String, Option<String>) = conn
        .query_row(
            "SELECT stage, closed_at FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query row");

    assert_eq!(stage, "in progress");
    assert!(closed_at.is_some());

    let _ = std::fs::remove_file(path);
}

#[test]
fn stage_run_lifecycle_inserts_lists_and_finishes_runs() {
    let path = Db::test_db_path("stage-run-lifecycle");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement feature",
        Some("Implement feature"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();

    db.insert_stage_run_with_completion_transition(
        NewStageRun {
            id: "run-1",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("codex"),
            model: Some("gpt-5"),
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("session-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        },
        Some("auto"),
    )
    .unwrap();

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, "run-1");
    assert_eq!(runs[0].task_id, "task-1");
    assert_eq!(runs[0].stage, "in progress");
    assert_eq!(runs[0].agent.as_deref(), Some("implement"));
    assert_eq!(runs[0].agent_provider.as_deref(), Some("codex"));
    assert_eq!(runs[0].model.as_deref(), Some("gpt-5"));
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].session_id.as_deref(), Some("session-1"));
    assert_eq!(runs[0].completion_transition.as_deref(), Some("auto"));
    assert!(!runs[0].started_at.is_empty());

    let result = r#"{"status":"success","summary":"implemented"}"#;
    db.finish_stage_run("run-1", "succeeded", Some(result), Some("implemented"))
        .unwrap();

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs[0].status, "succeeded");
    assert_eq!(runs[0].result.as_deref(), Some(result));
    assert_eq!(runs[0].feedback.as_deref(), Some("implemented"));
    assert!(runs[0].finished_at.is_some());
}

#[test]
fn close_pipeline_item_cancels_running_stage_runs() {
    let path = Db::test_db_path("stage-run-close-cancel");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement feature",
        Some("Implement feature"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-1",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();

    db.close_pipeline_item("task-1").unwrap();

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs[0].status, "cancelled");
    assert!(runs[0].finished_at.is_some());
}

#[test]
fn close_pipeline_item_accepts_task_branch_name() {
    let path = Db::test_db_path("close-task-branch-name");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "",
        None,
        "in progress",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();

    db.close_pipeline_item("task-710917fb")
        .expect("close task by branch name");

    let item = db.get_pipeline_item("710917fb").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("in progress"));
    assert!(item.closed_at.is_some());
}

#[test]
fn update_pipeline_item_stage_does_not_mutate_closed_rows() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open temp db");
    conn.execute_batch(
        r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              stage TEXT NOT NULL,
              closed_at TEXT,
              updated_at TEXT
            );
            INSERT INTO pipeline_item (id, stage, closed_at)
            VALUES ('task-1', 'review', '2026-06-03 00:02:25');
            "#,
    )
    .expect("seed db");
    drop(conn);

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
    let err = db
        .update_pipeline_item_stage("task-1", "pr")
        .expect_err("closed task should not be stage-mutated");

    assert!(matches!(err, rusqlite::Error::QueryReturnedNoRows));
    let conn = Connection::open(&path).expect("re-open db");
    let (stage, closed_at): (String, Option<String>) = conn
        .query_row(
            "SELECT stage, closed_at FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("query row");
    assert_eq!(stage, "review");
    assert_eq!(closed_at.as_deref(), Some("2026-06-03 00:02:25"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn resolves_pipeline_item_id_from_task_branch_name() {
    let path = Db::test_db_path("resolve-task-branch-name");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "Review branch",
        Some("Review branch"),
        "review",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();

    assert_eq!(
        db.resolve_pipeline_item_id("task-710917fb")
            .unwrap()
            .as_deref(),
        Some("710917fb")
    );
}

#[test]
fn waiting_prompt_update_is_change_aware() {
    let path = temp_db_path();
    let db = Db::open_for_tests(path.to_str().unwrap()).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Original prompt",
        Some("Current title"),
        "in progress",
        "2026-07-11 00:00:00",
    )
    .unwrap();

    assert!(db
        .update_pipeline_item_waiting_prompt("task-1", "Ready for review")
        .unwrap());
    assert!(!db
        .update_pipeline_item_waiting_prompt("task-1", "Ready for review")
        .unwrap());
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .last_output_preview
            .as_deref(),
        Some("Ready for review")
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn resolves_task_terminal_session_id_from_task_or_branch_name() {
    let path = Db::test_db_path("resolve-task-terminal-session");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "Review branch",
        Some("Review branch"),
        "review",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();
    db.conn
            .execute(
                "INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
                 VALUES ('shell-session', 'repo-1', '710917fb', 'shell', '/tmp/repo', 'daemon-shell'),
                        ('agent-session', 'repo-1', '710917fb', 'agent', '/tmp/repo', 'daemon-agent')",
                [],
            )
            .unwrap();

    assert_eq!(
        db.resolve_task_terminal_session_id("710917fb")
            .unwrap()
            .as_deref(),
        Some("daemon-agent")
    );
    assert_eq!(
        db.resolve_task_terminal_session_id("task-710917fb")
            .unwrap()
            .as_deref(),
        Some("daemon-agent")
    );
    assert_eq!(
        db.resolve_task_terminal_session_id("missing").unwrap(),
        None
    );
}

#[test]
fn resolves_task_terminal_session_id_to_pipeline_item_when_no_session_row_exists() {
    let path = Db::test_db_path("resolve-task-terminal-fallback");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "Review branch",
        Some("Review branch"),
        "review",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();

    assert_eq!(
        db.resolve_task_terminal_session_id("task-710917fb")
            .unwrap()
            .as_deref(),
        Some("710917fb")
    );
}

#[test]
fn resolves_task_terminal_session_id_from_latest_running_stage_run() {
    let path = Db::test_db_path("resolve-task-terminal-latest-stage-run");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "710917fb",
        "repo-1",
        "Review branch",
        Some("Review branch"),
        "review",
        "2026-05-11 10:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "710917fb",
        "task-710917fb",
        "default",
        None,
        "claude",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-old",
        task_id: "710917fb",
        stage: "in progress",
        kind: "main",
        agent: None,
        agent_provider: None,
        model: None,
        status: "succeeded",
        result: None,
        feedback: None,
        session_id: Some("daemon-old"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-current",
        task_id: "710917fb",
        stage: "review",
        kind: "main",
        agent: None,
        agent_provider: None,
        model: None,
        status: "running",
        result: None,
        feedback: Some("address review feedback"),
        session_id: Some("daemon-current"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();

    assert_eq!(
        db.resolve_task_terminal_session_id("task-710917fb")
            .unwrap()
            .as_deref(),
        Some("daemon-current")
    );
}

#[test]
fn resolves_task_terminal_session_id_prefers_daemon_mapping_over_provider_uuid_run_id() {
    let path = Db::test_db_path("resolve-task-terminal-provider-uuid");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "b5181132",
        "repo-1",
        "Reconnect historical task",
        Some("Reconnect historical task"),
        "in progress",
        "2026-07-06 12:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("b5181132", "task-b5181132", "qa", None, "claude")
        .unwrap();
    db.insert_test_terminal_session("agent-b5181132", "repo-1", "b5181132", "agent", "b5181132")
        .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-historical-provider-id",
        task_id: "b5181132",
        stage: "in progress",
        kind: "main",
        agent: None,
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("173d6399-8d10-4933-8481-9ba5e551c149"),
        provider_session_id: Some("173d6399-8d10-4933-8481-9ba5e551c149"),
        cwd: Some("/tmp/repo/.kanna-worktrees/task-b5181132"),
        resumed_from_run_id: None,
    })
    .unwrap();

    assert_eq!(
        db.resolve_task_terminal_session_id("task-b5181132")
            .unwrap()
            .as_deref(),
        Some("b5181132")
    );
}

#[test]
fn insert_pipeline_item_stores_stage_metadata() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open temp db");
    conn.execute_batch(
        r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              repo_id TEXT NOT NULL,
              prompt TEXT,
              pipeline TEXT NOT NULL,
              pipeline_def TEXT,
              stage TEXT NOT NULL,
              branch TEXT,
              agent_type TEXT,
              agent_provider TEXT NOT NULL,
              activity TEXT NOT NULL,
              activity_changed_at TEXT,
              port_offset INTEGER,
              port_env TEXT,
              agent_spawn_options TEXT,
              base_ref TEXT,
              notify_task_id TEXT,
              notified_at TEXT,
              parent_task_id TEXT,
              display_name TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
    )
    .expect("seed db");
    drop(conn);

    let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
    db.insert_pipeline_item(NewPipelineItem {
        id: "task-2",
        repo_id: "repo-1",
        prompt: "Merge queued pull requests",
        pipeline: "default",
        pipeline_def: Some("{\"stages\":[]}"),
        stage: "in progress",
        branch: "task-task-2",
        agent_type: "pty",
        agent_provider: "claude",
        activity: "working",
        port_offset: Some(1422),
        port_env_json: Some("{\"KANNA_DEV_PORT\":\"1422\"}"),
        agent_spawn_options_json: None,
        base_ref: None,
        display_name: Some("Merge queue"),
        notify_task_id: None,
        parent_task_id: None,
    })
    .expect("insert pipeline item");

    struct InsertedPipelineItem {
        repo_id: String,
        prompt: String,
        pipeline: String,
        pipeline_def: Option<String>,
        stage: String,
        activity: String,
        port_offset: Option<i64>,
        display_name: Option<String>,
    }

    let conn = Connection::open(&path).expect("re-open db");
    let row = conn
        .query_row(
            "SELECT repo_id, prompt, pipeline, pipeline_def, stage, activity, port_offset, display_name FROM pipeline_item WHERE id = 'task-2'",
            [],
            |row| {
                Ok(InsertedPipelineItem {
                    repo_id: row.get(0)?,
                    prompt: row.get(1)?,
                    pipeline: row.get(2)?,
                    pipeline_def: row.get(3)?,
                    stage: row.get(4)?,
                    activity: row.get(5)?,
                    port_offset: row.get(6)?,
                    display_name: row.get(7)?,
                })
            },
        )
        .expect("query row");

    assert_eq!(row.repo_id, "repo-1");
    assert_eq!(row.prompt, "Merge queued pull requests");
    assert_eq!(row.pipeline, "default");
    assert_eq!(row.pipeline_def.as_deref(), Some("{\"stages\":[]}"));
    assert_eq!(row.stage, "in progress");
    assert_eq!(row.activity, "working");
    assert_eq!(row.port_offset, Some(1422));
    assert_eq!(row.display_name.as_deref(), Some("Merge queue"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn every_server_activity_write_advances_the_activity_revision() {
    let path = Db::test_db_path("activity-revision-writes");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "task prompt",
        Some("Task"),
        "in progress",
        "2026-07-25 01:00:00",
    )
    .unwrap();

    db.update_pipeline_item_activity("task-1", "working")
        .unwrap();
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .activity_revision,
        1
    );

    db.update_pipeline_item_base_ref_and_activity("task-1", Some("origin/main"), "unread")
        .unwrap();
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .activity_revision,
        2
    );

    db.delete_dormant_task_start_artifacts("task-1", Some("origin/main"))
        .unwrap();
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.activity.as_deref(), Some("idle"));
    assert_eq!(item.activity_revision, 3);
}

#[test]
fn task_listing_queries_exclude_closed_items_even_when_stage_is_not_done() {
    let path = Db::test_db_path("closed-item-filtering");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One")
        .expect("insert repo");
    db.insert_test_pipeline_item(
        "task-open",
        "repo-1",
        "visible task",
        Some("Visible Task"),
        "in progress",
        "2026-04-18 10:00:00",
    )
    .expect("insert open task");
    db.insert_test_pipeline_item(
        "task-closed",
        "repo-1",
        "stale task",
        Some("Stale Task"),
        "in progress",
        "2026-04-18 11:00:00",
    )
    .expect("insert stale task");
    db.conn
        .execute(
            "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
            ["task-closed"],
        )
        .expect("mark stale task closed");

    let recent_ids = db
        .list_recent_pipeline_items()
        .expect("list recent tasks")
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>();
    let repo_ids = db
        .list_pipeline_items("repo-1")
        .expect("list repo tasks")
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>();
    let search_ids = db
        .search_pipeline_items("task")
        .expect("search tasks")
        .into_iter()
        .map(|item| item.id)
        .collect::<Vec<_>>();

    assert_eq!(recent_ids, vec!["task-open"]);
    assert_eq!(repo_ids, vec!["task-open"]);
    assert_eq!(search_ids, vec!["task-open"]);

    let _ = std::fs::remove_file(path);
}

#[test]
fn count_open_task_blockers_treats_pr_stage_with_pr_url_as_resolved() {
    let path = Db::test_db_path("open-blockers-pr-resolved");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "prerequisite",
        Some("Prerequisite"),
        "pr",
        "2026-07-01T00:00:00Z",
    )
    .expect("blocker");
    db.insert_test_pipeline_item(
        "dependent-1",
        "repo-1",
        "build on it",
        Some("Dependent"),
        "in progress",
        "2026-07-01T00:01:00Z",
    )
    .expect("dependent");
    db.insert_test_task_blocker("dependent-1", "blocker-1")
        .expect("blocker row");

    // Parked at pr without a PR: still blocking.
    assert_eq!(
        db.count_open_task_blockers("dependent-1").expect("count"),
        1
    );

    // PR created: optimistically resolved even though the task stays open.
    db.update_pipeline_item_pr("blocker-1", Some(7), "https://github.com/acme/repo/pull/7")
        .expect("set pr");
    assert_eq!(
        db.count_open_task_blockers("dependent-1").expect("count"),
        0
    );

    // Closing keeps it resolved.
    db.close_pipeline_item("blocker-1").expect("close");
    assert_eq!(
        db.count_open_task_blockers("dependent-1").expect("count"),
        0
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn ui_snapshot_treats_null_pinned_as_unpinned() {
    let path = Db::test_db_path("snapshot-null-pinned");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "publish this task",
        Some("Publish Task"),
        "in progress",
        "2026-07-14T00:00:00Z",
    )
    .expect("task");
    db.conn
        .execute(
            "UPDATE pipeline_item SET pinned = NULL WHERE id = ?",
            ["task-1"],
        )
        .expect("clear pinned");

    let snapshot = db.ui_snapshot().expect("snapshot with nullable pinned");
    assert_eq!(snapshot.entries[0].items[0].pinned, 0);

    let _ = std::fs::remove_file(path);
}

#[test]
fn find_open_agent_task_ignores_closed_singleton() {
    let path = Db::test_db_path("closed-singleton-agent");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-merge",
        "repo-1",
        "Merge master",
        Some("Merge Master"),
        "in progress",
        "2026-07-01T00:00:00Z",
    )
    .expect("task");
    db.insert_stage_run(NewStageRun {
        id: "run-merge",
        task_id: "task-merge",
        stage: "in progress",
        kind: "main",
        agent: Some("merge"),
        agent_provider: Some("claude"),
        model: None,
        status: "succeeded",
        result: None,
        feedback: None,
        session_id: Some("merge-session"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("run");
    db.set_test_pipeline_item_closed_at("task-merge", "2026-07-01T01:00:00Z")
        .expect("close task");

    assert!(db
        .find_open_agent_task("repo-1", "merge")
        .expect("lookup")
        .is_none());

    let _ = std::fs::remove_file(path);
}
