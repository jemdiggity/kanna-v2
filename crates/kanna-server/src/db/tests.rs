use super::NewStageRun;
use super::{
    add_column, database_open_flags, run_migration, Db, NewPipelineItem, NewRepo, NewTaskTransfer,
    NewTaskTransferProvenance, ReplaceTaskBlockersError, CURRENT_SCHEMA_MIGRATIONS,
};
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

fn index_columns(conn: &Connection, index_name: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_info('{index_name}')"))
        .expect("prepare index metadata query");
    stmt.query_map([], |row| row.get(2))
        .expect("read index metadata")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect index columns")
}

#[test]
fn database_open_flags_use_sqlite_mutexes_for_shared_desktop_db() {
    let flags = database_open_flags();

    assert!(flags.contains(OpenFlags::SQLITE_OPEN_FULL_MUTEX));
    assert!(!flags.contains(OpenFlags::SQLITE_OPEN_NO_MUTEX));
}

#[test]
fn pin_at_top_rolls_back_existing_pin_order_when_target_update_fails() {
    let path = temp_db_path();
    let path_string = path.to_string_lossy().to_string();
    let db = Db::open_for_tests(&path_string).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One")
        .expect("insert repo");
    db.insert_test_pipeline_item(
        "task-anchor",
        "repo-1",
        "anchor prompt",
        Some("Anchor"),
        "in progress",
        "2026-08-15 10:00:00",
    )
    .expect("insert anchor");
    db.insert_test_pipeline_item(
        "task-target",
        "repo-1",
        "target prompt",
        Some("Target"),
        "in progress",
        "2026-08-15 11:00:00",
    )
    .expect("insert target");
    db.pin_pipeline_item("task-anchor", 0).expect("pin anchor");
    db.conn
        .execute_batch(
            "CREATE TRIGGER fail_target_pin
             BEFORE UPDATE OF pinned ON pipeline_item
             WHEN NEW.id = 'task-target' AND NEW.pinned = 1
             BEGIN
               SELECT RAISE(ABORT, 'forced target pin failure');
             END;",
        )
        .expect("install failure trigger");

    db.pin_pipeline_item_at_top("repo-1", "task-target")
        .expect_err("target pin should fail");

    let anchor: (i64, Option<i64>) = db
        .conn
        .query_row(
            "SELECT pinned, pin_order FROM pipeline_item WHERE id = 'task-anchor'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read anchor");
    let target: (i64, Option<i64>) = db
        .conn
        .query_row(
            "SELECT pinned, pin_order FROM pipeline_item WHERE id = 'task-target'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read target");
    assert_eq!(anchor, (1, Some(0)));
    assert_eq!(target, (0, None));

    drop(db);
    let _ = std::fs::remove_file(path);
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
    assert_eq!(latest_migration, "053_pipeline_item_input_blocked");
    assert_eq!(
        index_columns(&db.conn, "idx_pipeline_item_parent_created_id"),
        vec!["parent_task_id", "created_at", "id"],
        "the migrated schema must cover direct-child filtering and ordering"
    );
    assert_eq!(
        index_columns(&db.conn, "idx_repo_remote_url_hash_id"),
        vec!["remote_url_hash", "id"],
        "the migrated schema must index repository identity lookup"
    );
    assert_eq!(
        index_columns(&db.conn, "idx_pipeline_item_repo_id_id"),
        vec!["repo_id", "id"],
        "the migrated schema must index repository task membership"
    );

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
    assert!(stage_run_sql.contains("completion_bound"));
    let mut transfer_columns_stmt = db
        .conn
        .prepare("PRAGMA table_info(task_transfer)")
        .expect("prepare transfer columns");
    let transfer_columns = transfer_columns_stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("read transfer columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect transfer columns");
    assert!(transfer_columns.contains(&"source_desktop_id".to_string()));
    assert!(transfer_columns.contains(&"target_desktop_id".to_string()));
    assert!(transfer_columns.contains(&"sidecar_cleanup_completed_at".to_string()));

    let _ = std::fs::remove_file(path);
}

#[test]
fn migration_047_removes_merge_gate_tables() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("create fixture");
    db.conn
        .execute_batch(
            "CREATE TABLE task_approval_authorization (run_id TEXT PRIMARY KEY);
             CREATE TABLE task_approval_hold (id TEXT PRIMARY KEY);
             CREATE TABLE task_approval_override (id TEXT PRIMARY KEY);
             CREATE TABLE agent_signal_protocol (task_id TEXT PRIMARY KEY);
             CREATE TABLE merge_handoff_delivery (run_id TEXT PRIMARY KEY);
             DELETE FROM schema_migrations WHERE id = '047_remove_approval_gate';",
        )
        .expect("construct schema-046 fixture");
    drop(db);

    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("run migration 047");
    for removed in [
        "task_approval_authorization",
        "task_approval_hold",
        "task_approval_override",
        "agent_signal_protocol",
        "merge_handoff_delivery",
    ] {
        let exists: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                [removed],
                |row| row.get(0),
            )
            .expect("table lookup");
        assert_eq!(exists, 0, "{removed} must be removed");
    }
    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn test_schema_keeps_parentage_index_in_parity_with_migrations() {
    let path = Db::test_db_path("parentage-index-parity");
    let db = Db::open_for_tests(&path).expect("open test db");

    assert_eq!(
        index_columns(&db.conn, "idx_pipeline_item_parent_created_id"),
        vec!["parent_task_id", "created_at", "id"],
        "router and DB tests must exercise the indexed production query shape"
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn parentage_index_migrates_existing_rows_and_reopens_idempotently() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("create fixture db");
    db.insert_test_repo("repo-parent-migration", "Parent Migration")
        .expect("insert repo");
    for (id, created_at) in [
        ("parent-existing", "2026-08-01 00:00:00"),
        ("child-existing-open", "2026-08-01 00:01:00"),
        ("child-existing-closed", "2026-08-01 00:02:00"),
    ] {
        db.insert_test_pipeline_item(
            id,
            "repo-parent-migration",
            id,
            Some(id),
            "in progress",
            created_at,
        )
        .expect("insert task");
    }
    db.update_pipeline_item_parent("child-existing-open", Some("parent-existing"))
        .expect("parent open child");
    db.update_pipeline_item_parent("child-existing-closed", Some("parent-existing"))
        .expect("parent closed child");
    db.close_pipeline_item("child-existing-closed")
        .expect("close child before migration");

    // Reconstruct the exact pre-041 state: 041 only adds this index, so the
    // production schema and existing parented rows otherwise remain unchanged.
    db.conn
        .execute_batch(
            "DROP INDEX idx_pipeline_item_parent_created_id;
             DELETE FROM schema_migrations
             WHERE id = '041_pipeline_item_parentage_index';",
        )
        .expect("prepare pre-041 fixture");
    drop(db);

    let db = Db::open_migrated(path.to_str().expect("utf8 path"))
        .expect("migrate existing parented rows through production path");
    assert_eq!(
        db.list_child_task_ids("parent-existing")
            .expect("list migrated children"),
        vec![
            "child-existing-open".to_string(),
            "child-existing-closed".to_string()
        ],
        "index migration must preserve ordering and closed children"
    );
    assert_eq!(
        index_columns(&db.conn, "idx_pipeline_item_parent_created_id"),
        vec!["parent_task_id", "created_at", "id"]
    );
    let obsolete_parent_cursor_objects: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE name = 'task_parent_revision'
                OR name LIKE 'trg_pipeline_item_parent_revision_%'",
            [],
            |row| row.get(0),
        )
        .expect("check obsolete cursor schema");
    assert_eq!(obsolete_parent_cursor_objects, 0);
    drop(db);

    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("reopen migrated fixture");
    let migration_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations
             WHERE id = '041_pipeline_item_parentage_index'",
            [],
            |row| row.get(0),
        )
        .expect("count migration records");
    assert_eq!(migration_count, 1, "reopen must not repeat migration 041");

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn task_transfer_round_trip_preserves_nullable_authenticated_desktop_ids() {
    let path = Db::test_db_path("task-transfer-cloud-desktop-ids");
    let db = Db::open_for_tests(&path).expect("open test db");

    db.insert_task_transfer(&NewTaskTransfer {
        id: "transfer-cloud".into(),
        direction: "outgoing".into(),
        status: "pending".into(),
        source_peer_id: Some("peer-a".into()),
        target_peer_id: Some("peer-b".into()),
        source_desktop_id: Some("desktop-a".into()),
        target_desktop_id: Some("desktop-b".into()),
        source_task_id: Some("task-a".into()),
        local_task_id: None,
        error: None,
        payload_json: None,
    })
    .expect("insert cloud transfer");
    db.insert_task_transfer(&NewTaskTransfer {
        id: "transfer-lan".into(),
        direction: "incoming".into(),
        status: "pending".into(),
        source_peer_id: Some("peer-a".into()),
        target_peer_id: Some("peer-b".into()),
        source_desktop_id: None,
        target_desktop_id: None,
        source_task_id: Some("task-a".into()),
        local_task_id: None,
        error: None,
        payload_json: None,
    })
    .expect("insert LAN transfer");

    let cloud = db
        .get_task_transfer("transfer-cloud")
        .expect("load cloud transfer")
        .expect("cloud transfer exists");
    assert_eq!(cloud.source_desktop_id.as_deref(), Some("desktop-a"));
    assert_eq!(cloud.target_desktop_id.as_deref(), Some("desktop-b"));

    let lan = db
        .get_task_transfer("transfer-lan")
        .expect("load LAN transfer")
        .expect("LAN transfer exists");
    assert_eq!(lan.source_desktop_id, None);
    assert_eq!(lan.target_desktop_id, None);

    let _ = std::fs::remove_file(path);
}

#[test]
fn incoming_transfer_insert_is_idempotent_for_event_replay() {
    let path = Db::test_db_path("incoming-transfer-insert-idempotent");
    let db = Db::open_for_tests(&path).expect("open test db");
    let transfer = NewTaskTransfer {
        id: "transfer-replayed".into(),
        direction: "incoming".into(),
        status: "pending".into(),
        source_peer_id: Some("peer-a".into()),
        target_peer_id: None,
        source_desktop_id: Some("desktop-a".into()),
        target_desktop_id: None,
        source_task_id: Some("task-a".into()),
        local_task_id: None,
        error: None,
        payload_json: Some(r#"{"task":{"source_task_id":"task-a"}}"#.into()),
    };

    db.insert_task_transfer(&transfer)
        .expect("insert incoming transfer");
    db.insert_task_transfer(&transfer)
        .expect("replay incoming transfer insert");
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM task_transfer WHERE id = ?",
            ["transfer-replayed"],
            |row| row.get(0),
        )
        .expect("count replayed transfer rows");
    assert_eq!(count, 1);

    let _ = std::fs::remove_file(path);
}

#[test]
fn snapshot_selects_latest_relevant_transfer_for_open_task() {
    let path = Db::test_db_path("snapshot-latest-task-transfer");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Kanna").expect("insert repo");
    db.insert_test_pipeline_item(
        "task-destination",
        "repo-1",
        "Transferred task",
        None,
        "in progress",
        "2026-07-26 00:00:00",
    )
    .expect("insert task");
    db.insert_test_task_transfer_with_desktops(
        "transfer-older-outgoing",
        "outgoing",
        "pending",
        Some("task-destination"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert older relevant outgoing transfer");
    db.insert_test_task_transfer_with_desktops(
        "transfer-awaiting-incoming",
        "incoming",
        "awaiting_acknowledgment",
        Some("task-destination"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert awaiting incoming transfer");
    db.insert_test_task_transfer_with_desktops(
        "transfer-newer-completed-incoming",
        "incoming",
        "completed",
        Some("task-destination"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert newer terminal incoming transfer");
    db.insert_test_task_transfer_with_desktops(
        "transfer-newest-invalid-importing-outgoing",
        "outgoing",
        "importing",
        Some("task-destination"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert newest invalid importing outgoing transfer");
    for (id, started_at, completed_at) in [
        ("transfer-older-outgoing", "2026-07-26 00:01:00", None),
        (
            "transfer-awaiting-incoming",
            "2026-07-26 00:02:00",
            Some("2026-07-26 00:03:00"),
        ),
        (
            "transfer-newer-completed-incoming",
            "2026-07-26 00:04:00",
            Some("2026-07-26 00:05:00"),
        ),
        (
            "transfer-newest-invalid-importing-outgoing",
            "2026-07-26 00:06:00",
            Some("2026-07-26 00:07:00"),
        ),
    ] {
        db.conn
            .execute(
                "UPDATE task_transfer
                 SET started_at = ?, completed_at = ?
                 WHERE id = ?",
                (started_at, completed_at, id),
            )
            .expect("set deterministic transfer timestamps");
    }

    let snapshot = db.ui_snapshot().expect("load snapshot");
    let item = &snapshot.entries[0].items[0];
    assert_eq!(item.cloud_task_id, "task-destination");
    assert_eq!(
        item.transfer_id.as_deref(),
        Some("transfer-awaiting-incoming")
    );
    assert_eq!(item.transfer_direction.as_deref(), Some("incoming"));
    assert_eq!(
        item.transfer_status.as_deref(),
        Some("awaiting_acknowledgment")
    );
    assert_eq!(item.transfer_source_peer_id.as_deref(), Some("peer-1"));
    assert_eq!(item.transfer_target_peer_id.as_deref(), Some("peer-2"));
    assert_eq!(
        item.transfer_source_desktop_id.as_deref(),
        Some("desktop-a")
    );
    assert_eq!(
        item.transfer_target_desktop_id.as_deref(),
        Some("desktop-b")
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn snapshot_reports_the_latest_stage_run_provider_for_terminal_rendering() {
    let path = Db::test_db_path("snapshot-active-stage-provider");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Kanna").expect("insert repo");
    db.insert_test_pipeline_item(
        "task-provider",
        "repo-1",
        "Provider changes by stage",
        None,
        "pr",
        "2026-08-12 00:00:00",
    )
    .expect("insert task");
    db.update_pipeline_item_agent_binding("task-provider", "codex", "pty", None)
        .expect("retain task provider fallback");
    db.insert_stage_run(NewStageRun {
        id: "run-pr",
        task_id: "task-provider",
        stage: "pr",
        kind: "main",
        agent: Some("pr"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-provider"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("insert active stage run");

    let snapshot = db.ui_snapshot().expect("load snapshot");
    let item = &snapshot.entries[0].items[0];
    assert_eq!(item.agent_provider, "claude");
    assert_eq!(
        db.get_pipeline_item("task-provider")
            .expect("load task")
            .expect("task exists")
            .agent_provider
            .as_deref(),
        Some("codex"),
        "the task-level provider fallback remains unchanged",
    );

    let _ = std::fs::remove_file(path);
}

// A transfer that broke used to vanish from the snapshot along with the ones
// that succeeded, so the sidebar could not tell an operator their task never
// made it. A failure is reported until something newer is in flight.
#[test]
fn snapshot_reports_a_failed_transfer_but_prefers_one_still_in_flight() {
    let path = Db::test_db_path("snapshot-failed-task-transfer");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Kanna").expect("insert repo");
    db.insert_test_pipeline_item(
        "task-stranded",
        "repo-1",
        "Transfer that broke",
        None,
        "in progress",
        "2026-08-06 00:00:00",
    )
    .expect("insert task");
    db.insert_test_task_transfer_with_desktops(
        "transfer-failed-outgoing",
        "outgoing",
        "failed",
        Some("task-stranded"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert failed outgoing transfer");
    db.insert_test_task_transfer_with_desktops(
        "transfer-completed-outgoing",
        "outgoing",
        "completed",
        Some("task-stranded"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert completed outgoing transfer");
    for (id, started_at, completed_at) in [
        (
            "transfer-failed-outgoing",
            "2026-08-06 00:01:00",
            Some("2026-08-06 00:02:00"),
        ),
        (
            "transfer-completed-outgoing",
            "2026-08-06 00:03:00",
            Some("2026-08-06 00:04:00"),
        ),
    ] {
        db.conn
            .execute(
                "UPDATE task_transfer
                 SET started_at = ?, completed_at = ?
                 WHERE id = ?",
                (started_at, completed_at, id),
            )
            .expect("set deterministic transfer timestamps");
    }

    let snapshot = db.ui_snapshot().expect("load snapshot");
    let item = &snapshot.entries[0].items[0];
    assert_eq!(
        item.transfer_id.as_deref(),
        Some("transfer-failed-outgoing")
    );
    assert_eq!(item.transfer_status.as_deref(), Some("failed"));

    // A retry started after the failure is the current truth about the task.
    db.insert_test_task_transfer_with_desktops(
        "transfer-retry-outgoing",
        "outgoing",
        "streaming",
        Some("task-stranded"),
        Some("desktop-a"),
        Some("desktop-b"),
    )
    .expect("insert retried outgoing transfer");
    db.conn
        .execute(
            "UPDATE task_transfer SET started_at = ?, completed_at = NULL WHERE id = ?",
            ("2026-08-05 00:00:00", "transfer-retry-outgoing"),
        )
        .expect("start the retry before the failure to prove ordering");

    let snapshot = db.ui_snapshot().expect("reload snapshot");
    let item = &snapshot.entries[0].items[0];
    assert_eq!(item.transfer_id.as_deref(), Some("transfer-retry-outgoing"));
    assert_eq!(item.transfer_status.as_deref(), Some("streaming"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn an_incoming_transfer_can_be_failed_from_every_stage_an_import_dies_at() {
    let path = Db::test_db_path("incoming-transfer-terminalize");
    let db = Db::open_for_tests(&path).expect("open test db");

    // The ownership-fenced route only reaches `pending`/`claimed`, which is
    // right for one renderer among several. The engine is the only importer in
    // its process, and an import that dies at `importing` — after the repo is
    // acquired, before the acknowledgment — still has to end visibly, or the
    // row stays non-terminal forever and holds its sidecar reservation with it.
    for stage in ["pending", "claimed", "importing", "awaiting_acknowledgment"] {
        let transfer_id = format!("transfer-{stage}");
        db.insert_test_task_transfer(&transfer_id, "incoming", stage, Some("{}"))
            .expect("insert transfer");
        assert!(
            db.fail_incoming_task_transfer(&transfer_id, "the import gave up")
                .expect("fail incoming"),
            "an import that died at {stage} could not be terminalized",
        );
        let failed = db
            .get_task_transfer(&transfer_id)
            .expect("read transfer")
            .expect("transfer exists");
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error.as_deref(), Some("the import gave up"));
        assert!(failed.completed_at.is_some());
    }

    // A transfer that already reached a terminal state keeps the one it has: a
    // completed import must not be rewritten as failed by a late retry.
    for terminal in ["completed", "rejected", "failed"] {
        let transfer_id = format!("transfer-settled-{terminal}");
        db.insert_test_task_transfer(&transfer_id, "incoming", terminal, Some("{}"))
            .expect("insert transfer");
        assert!(!db
            .fail_incoming_task_transfer(&transfer_id, "too late")
            .expect("fail incoming"));
        assert_eq!(
            db.get_task_transfer(&transfer_id)
                .expect("read transfer")
                .expect("transfer exists")
                .status,
            terminal,
        );
    }

    // Direction is part of the fence: an outgoing row has its own terminalizer.
    db.insert_test_task_transfer("transfer-outgoing", "outgoing", "pending", Some("{}"))
        .expect("insert transfer");
    assert!(!db
        .fail_incoming_task_transfer("transfer-outgoing", "wrong direction")
        .expect("fail incoming"));
}

#[test]
fn incoming_transfer_state_machine_is_durable_and_provenance_is_idempotent() {
    let path = Db::test_db_path("incoming-transfer-state-machine");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.conn
        .execute_batch(
            "CREATE TABLE task_transfer_provenance (
               pipeline_item_id TEXT PRIMARY KEY,
               source_peer_id TEXT NOT NULL,
               source_task_id TEXT NOT NULL,
               source_machine_task_label TEXT,
               imported_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .expect("create provenance table");
    db.insert_test_task_transfer("transfer-1", "incoming", "pending", Some("{}"))
        .expect("insert transfer");
    drop(db);

    let db = Db::open(&path).expect("reopen test db after restart");
    let streaming = db
        .list_pending_incoming_transfers()
        .expect("list streaming transfer after restart");
    assert_eq!(streaming.len(), 1);
    assert_eq!(streaming[0].status, "pending");
    assert!(db
        .claim_pending_incoming_transfer("transfer-1", "owner-a", false)
        .expect("claim pending transfer after restart"));
    assert!(!db
        .update_task_transfer_payload("transfer-1", "{\"stale\":true}", None)
        .expect("unowned payload update is fenced"));
    assert!(!db
        .update_task_transfer_payload("transfer-1", "{\"stale\":true}", Some("owner-stale"))
        .expect("stale owner payload update is fenced"));
    assert!(db
        .update_task_transfer_payload("transfer-1", "{}", Some("owner-a"))
        .expect("active owner updates payload"));

    assert!(db
        .mark_incoming_transfer_importing("transfer-1", "task-local", "owner-a")
        .expect("mark importing"));
    let importing = db
        .get_task_transfer("transfer-1")
        .expect("read importing")
        .expect("transfer exists");
    assert_eq!(importing.status, "importing");
    assert_eq!(importing.local_task_id.as_deref(), Some("task-local"));

    let provenance = NewTaskTransferProvenance {
        pipeline_item_id: "task-local".into(),
        source_peer_id: "peer-source".into(),
        source_task_id: "task-source".into(),
        source_machine_task_label: Some("source-branch".into()),
    };
    db.insert_task_transfer_provenance(&provenance)
        .expect("insert provenance");
    db.insert_task_transfer_provenance(&provenance)
        .expect("repeat provenance");
    let provenance_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM task_transfer_provenance WHERE pipeline_item_id = ?",
            ["task-local"],
            |row| row.get(0),
        )
        .expect("count provenance");
    assert_eq!(provenance_count, 1);

    assert!(db
        .mark_incoming_transfer_awaiting_acknowledgment("transfer-1", "task-local", "owner-a",)
        .expect("mark awaiting"));
    let resumable = db
        .list_pending_incoming_transfers()
        .expect("list resumable transfers");
    assert_eq!(resumable.len(), 1);
    assert_eq!(resumable[0].status, "awaiting_acknowledgment");
    assert_eq!(resumable[0].local_task_id.as_deref(), Some("task-local"));
    assert!(db
        .claim_pending_incoming_transfer("transfer-1", "owner-b", true)
        .expect("authoritative recovery takes over the active lease"));
    assert!(!db
        .renew_incoming_transfer_claim("transfer-1", "owner-a")
        .expect("superseded owner cannot renew resumable transfer"));
    assert!(db
        .renew_incoming_transfer_claim("transfer-1", "owner-b")
        .expect("replacement owner renews resumable transfer"));

    assert!(db
        .mark_task_transfer_completed("transfer-1", "task-local", Some("owner-b"))
        .expect("mark complete"));
    assert!(db
        .list_pending_incoming_transfers()
        .expect("list after complete")
        .is_empty());
    db.insert_test_task_transfer("transfer-rejected", "incoming", "rejected", Some("{}"))
        .expect("insert rejected incoming transfer");
    db.insert_test_task_transfer("transfer-failed", "incoming", "failed", Some("{}"))
        .expect("insert failed incoming transfer");
    db.insert_test_task_transfer("transfer-outgoing", "outgoing", "completed", Some("{}"))
        .expect("insert completed outgoing transfer");
    let mut cleanup_candidates = db
        .list_terminal_incoming_transfer_ids()
        .expect("list terminal incoming cleanup candidates");
    cleanup_candidates.sort();
    assert_eq!(
        cleanup_candidates,
        vec!["transfer-1", "transfer-failed", "transfer-rejected"]
    );
    assert!(db
        .mark_incoming_transfer_sidecar_cleanup_completed("transfer-1")
        .expect("mark incoming sidecar cleanup completed"));
    assert!(db
        .mark_incoming_transfer_sidecar_cleanup_completed("transfer-1")
        .expect("repeat incoming sidecar cleanup completion"));
    let mut remaining_cleanup_candidates = db
        .list_terminal_incoming_transfer_ids()
        .expect("list remaining cleanup candidates");
    remaining_cleanup_candidates.sort();
    assert_eq!(
        remaining_cleanup_candidates,
        vec!["transfer-failed", "transfer-rejected"]
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn outgoing_transfer_completion_replays_only_for_the_same_source_task() {
    let path = Db::test_db_path("outgoing-transfer-completion-replay");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_task_transfer("transfer-1", "outgoing", "streaming", Some("{}"))
        .expect("insert transfer");

    assert!(db
        .mark_task_transfer_completed("transfer-1", "task-source", None)
        .expect("complete transfer"));
    assert!(db
        .mark_task_transfer_completed("transfer-1", "task-source", None)
        .expect("replay matching completion"));
    assert!(!db
        .mark_task_transfer_completed("transfer-1", "different-source", None)
        .expect("reject mismatched completion"));

    let transfer = db
        .get_task_transfer("transfer-1")
        .expect("read transfer")
        .expect("transfer exists");
    assert_eq!(transfer.status, "completed");
    assert_eq!(transfer.local_task_id.as_deref(), Some("task-source"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn incoming_transfer_claim_is_single_owner_and_expired_recovery_can_take_over() {
    let path = Db::test_db_path("incoming-transfer-owner-lease");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_task_transfer("transfer-lease", "incoming", "pending", Some("{}"))
        .expect("insert pending transfer");
    drop(db);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = ["window-a", "window-b"].map(|owner| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let db = Db::open(&path).expect("open shared db");
            barrier.wait();
            (
                owner,
                db.claim_pending_incoming_transfer("transfer-lease", owner, false)
                    .expect("attempt claim"),
            )
        })
    });
    let results = handles.map(|handle| handle.join().expect("claim thread"));
    assert_eq!(results.iter().filter(|(_, claimed)| *claimed).count(), 1);
    let winner = results
        .iter()
        .find_map(|(owner, claimed)| claimed.then_some(*owner))
        .expect("one winner");
    let loser = if winner == "window-a" {
        "window-b"
    } else {
        "window-a"
    };

    let db = Db::open(&path).expect("reopen lease db");
    assert!(!db
        .mark_incoming_transfer_importing("transfer-lease", "task-local", loser)
        .expect("loser cannot materialize"));
    assert!(db
        .mark_incoming_transfer_importing("transfer-lease", "task-local", winner)
        .expect("winner can materialize"));
    db.conn
        .execute(
            "UPDATE task_transfer SET claim_expires_at = datetime('now', '-1 second')
             WHERE id = 'transfer-lease'",
            [],
        )
        .expect("expire lease");
    assert!(db
        .claim_pending_incoming_transfer("transfer-lease", loser, true)
        .expect("recovery takes over expired lease"));
    assert!(!db
        .renew_incoming_transfer_claim("transfer-lease", winner)
        .expect("former owner cannot renew"));
    assert!(db
        .renew_incoming_transfer_claim("transfer-lease", loser)
        .expect("recovery owner renews"));

    let _ = std::fs::remove_file(path);
}

#[test]
fn active_outgoing_transfer_lease_is_unique_across_connections() {
    let path = Db::test_db_path("active-outgoing-transfer-lease");
    let db = Db::open_for_tests(&path).expect("open test db");
    drop(db);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = ["transfer-window-a", "transfer-window-b"].map(|id| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let db = Db::open(&path).expect("open shared db");
            let transfer = NewTaskTransfer {
                id: id.to_string(),
                direction: "outgoing".into(),
                status: "pending".into(),
                source_peer_id: Some("peer-source".into()),
                target_peer_id: Some("peer-target".into()),
                source_desktop_id: None,
                target_desktop_id: None,
                source_task_id: Some("same-source-task".into()),
                local_task_id: Some("same-source-task".into()),
                error: None,
                payload_json: Some("{}".into()),
            };
            barrier.wait();
            db.insert_task_transfer(&transfer)
        })
    });
    let results = handles.map(|handle| handle.join().expect("insert thread"));
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

    let db = Db::open(&path).expect("reopen transfer db");
    let active: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM task_transfer
             WHERE source_task_id = 'same-source-task'
               AND direction = 'outgoing'
               AND status IN ('pending', 'streaming')",
            [],
            |row| row.get(0),
        )
        .expect("count active transfers");
    assert_eq!(active, 1);

    let _ = std::fs::remove_file(path);
}

#[test]
fn add_column_failure_rolls_back_migration_for_retry() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch(
        r#"
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE retry_probe (id INTEGER PRIMARY KEY);
        INSERT INTO retry_probe (id) VALUES (1);
        "#,
    )
    .expect("seed migration probe");

    let migration_id = "test_add_column_retry";
    let first_result = run_migration(&conn, migration_id, |conn| {
        add_column(conn, "retry_probe", "nullable_value", "TEXT")?;
        add_column(conn, "retry_probe", "required_value", "TEXT NOT NULL")
    });
    assert!(
        first_result.is_err(),
        "invalid ALTER TABLE must fail the migration"
    );

    let rolled_back_column_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM pragma_table_xinfo('retry_probe')
             WHERE name = 'nullable_value'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back columns");
    assert_eq!(rolled_back_column_count, 0);

    let failed_record_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE id = ?1",
            [migration_id],
            |row| row.get(0),
        )
        .expect("count failed migration records");
    assert_eq!(failed_record_count, 0);

    run_migration(&conn, migration_id, |conn| {
        add_column(conn, "retry_probe", "nullable_value", "TEXT")?;
        add_column(
            conn,
            "retry_probe",
            "required_value",
            "TEXT NOT NULL DEFAULT ''",
        )
    })
    .expect("retry migration");

    let successful_column_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM pragma_table_xinfo('retry_probe')
             WHERE name IN ('nullable_value', 'required_value')",
            [],
            |row| row.get(0),
        )
        .expect("count successful columns");
    assert_eq!(successful_column_count, 2);

    let successful_record_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE id = ?1",
            [migration_id],
            |row| row.get(0),
        )
        .expect("count successful migration records");
    assert_eq!(successful_record_count, 1);
}

#[test]
fn open_migrates_origin_main_028_activity_revision() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open origin/main fixture db");
    conn.execute_batch(include_str!("fixtures/origin_main_028.sql"))
        .expect("load origin/main schema fixture");
    let migration_029_index = CURRENT_SCHEMA_MIGRATIONS
        .iter()
        .position(|id| *id == "029_pipeline_item_activity_revision")
        .expect("029 activity revision migration exists");
    for migration_id in &CURRENT_SCHEMA_MIGRATIONS[..migration_029_index] {
        conn.execute(
            "INSERT INTO schema_migrations (id) VALUES (?1)",
            [migration_id],
        )
        .expect("record migration through 028");
    }
    drop(conn);

    let db =
        Db::open_migrated(path.to_str().expect("utf8 path")).expect("migrate origin/main fixture");

    let activity_revision_metadata: (String, i64, Option<String>) = db
        .conn
        .query_row(
            "SELECT type, \"notnull\", dflt_value
             FROM pragma_table_info('pipeline_item')
             WHERE name = 'activity_revision'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("activity revision metadata");
    assert_eq!(
        activity_revision_metadata,
        ("INTEGER".to_string(), 1, Some("0".to_string()))
    );
    let blocker_revision_metadata: (String, i64, Option<String>) = db
        .conn
        .query_row(
            "SELECT type, \"notnull\", dflt_value
             FROM pragma_table_info('pipeline_item')
             WHERE name = 'blocker_revision'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("blocker revision metadata");
    assert_eq!(
        blocker_revision_metadata,
        ("INTEGER".to_string(), 1, Some("0".to_string()))
    );

    let stored_revision: i64 = db
        .conn
        .query_row(
            "SELECT activity_revision FROM pipeline_item WHERE id = 'origin-main-task'",
            [],
            |row| row.get(0),
        )
        .expect("backfilled activity revision");
    assert_eq!(stored_revision, 0);

    let item = db
        .get_pipeline_item("origin-main-task")
        .expect("load migrated task row")
        .expect("migrated task row exists");
    assert_eq!(item.activity_revision, 0);
    // Rows written before the revision budget existed start with their full
    // budget rather than an exhausted one.
    assert_eq!(item.revision_rounds, 0);
    let initial_and_current_workflow: (String, String) = db
        .conn
        .query_row(
            "SELECT initial_pipeline, pipeline
             FROM pipeline_item
             WHERE id = 'origin-main-task'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("backfilled creation-time workflow");
    assert_eq!(
        initial_and_current_workflow,
        ("default".to_string(), "default".to_string())
    );

    let snapshot = db.ui_snapshot().expect("load migrated ui snapshot");
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].items.len(), 1);
    assert_eq!(snapshot.entries[0].items[0].id, "origin-main-task");
    assert_eq!(snapshot.entries[0].items[0].activity_revision, 0);
    drop(db);

    let db = Db::open_migrated(path.to_str().expect("utf8 path"))
        .expect("reopen migrated origin/main fixture");
    let migration_029_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations
             WHERE id = '029_pipeline_item_activity_revision'",
            [],
            |row| row.get(0),
        )
        .expect("count activity revision migrations");
    assert_eq!(migration_029_count, 1);

    db.update_pipeline_item_activity("origin-main-task", "working")
        .expect("transition migrated activity");
    let item = db
        .get_pipeline_item("origin-main-task")
        .expect("reload transitioned task row")
        .expect("transitioned task row exists");
    assert_eq!(item.activity.as_deref(), Some("working"));
    assert_eq!(item.activity_revision, 1);

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn pre_036_streaming_incoming_transfers_recover_without_duplicate_tasks() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open pre-036 fixture db");
    conn.execute_batch(include_str!("fixtures/origin_main_028.sql"))
        .expect("load origin/main base fixture");
    conn.execute_batch(include_str!("fixtures/pre_036_task_transfer.sql"))
        .expect("load exact pre-036 transfer fixture");
    let migration_036_index = CURRENT_SCHEMA_MIGRATIONS
        .iter()
        .position(|id| *id == "036_task_transfer_ownership_leases")
        .expect("036 ownership migration exists");
    for migration_id in &CURRENT_SCHEMA_MIGRATIONS[..migration_036_index] {
        conn.execute(
            "INSERT INTO schema_migrations (id) VALUES (?1)",
            [migration_id],
        )
        .expect("record migration through 035");
    }
    drop(conn);

    let db = Db::open_migrated(path.to_str().expect("utf8 path"))
        .expect("migrate exact pre-036 transfer fixture");
    let before_task = db
        .get_task_transfer("legacy-stream-before-task")
        .expect("read transfer without task")
        .expect("transfer without task exists");
    assert_eq!(before_task.status, "pending");
    assert!(before_task.local_task_id.is_none());
    assert!(before_task.claim_owner_token.is_none());
    assert!(db
        .claim_pending_incoming_transfer("legacy-stream-before-task", "owner-before", false)
        .expect("freshly pending transfer is claimable"));

    let after_task = db
        .get_task_transfer("legacy-stream-after-task")
        .expect("read transfer with task")
        .expect("transfer with task exists");
    assert_eq!(after_task.status, "importing");
    assert_eq!(
        after_task.local_task_id.as_deref(),
        Some("origin-main-task")
    );
    assert!(after_task.claim_owner_token.is_none());
    assert!(db
        .claim_pending_incoming_transfer("legacy-stream-after-task", "owner-after", true)
        .expect("partially imported transfer is recoverable"));
    assert!(db
        .mark_incoming_transfer_awaiting_acknowledgment(
            "legacy-stream-after-task",
            "origin-main-task",
            "owner-after",
        )
        .expect("recovered transfer reaches acknowledgment"));
    assert!(db
        .mark_task_transfer_completed(
            "legacy-stream-after-task",
            "origin-main-task",
            Some("owner-after"),
        )
        .expect("recovered transfer completes"));

    let task_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM pipeline_item WHERE id = 'origin-main-task'",
            [],
            |row| row.get(0),
        )
        .expect("count imported task");
    assert_eq!(task_count, 1);

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn migration_backfills_cloud_task_identity_from_local_task_id() {
    let path = temp_db_path();
    let conn = Connection::open(&path).expect("open pre-cloud-identity fixture db");
    conn.execute_batch(include_str!("fixtures/origin_main_028.sql"))
        .expect("load pre-cloud-identity schema fixture");
    conn.execute(
        "INSERT INTO pipeline_item (
             id, repo_id, prompt, pipeline, stage, branch, agent_type, agent_provider,
             activity, pinned, display_name, created_at, updated_at
         ) VALUES (
             'task-local-uuid', 'origin-main-repo', 'Transferred task', 'default',
             'in progress', 'task-local-uuid', 'claude', 'claude', 'idle', 0,
             'Transferred Task', '2026-07-25 10:00:00', '2026-07-25 10:00:00'
         )",
        [],
    )
    .expect("insert task before cloud identity migration");
    for migration_id in CURRENT_SCHEMA_MIGRATIONS
        .iter()
        .take_while(|id| **id != "029_pipeline_item_activity_revision")
    {
        conn.execute(
            "INSERT INTO schema_migrations (id) VALUES (?1)",
            [migration_id],
        )
        .expect("record migration before cloud identity");
    }
    drop(conn);

    let db = Db::open_migrated(path.to_str().expect("utf8 path"))
        .expect("apply cloud identity migration");

    let stored_identity: String = db
        .conn
        .query_row(
            "SELECT cloud_task_id FROM pipeline_item WHERE id = 'task-local-uuid'",
            [],
            |row| row.get(0),
        )
        .expect("read backfilled cloud identity");
    assert_eq!(stored_identity, "task-local-uuid");

    let item = db
        .get_pipeline_item("task-local-uuid")
        .expect("load migrated task")
        .expect("migrated task exists");
    assert_eq!(item.cloud_task_id.as_deref(), Some("task-local-uuid"));

    let snapshot = db.ui_snapshot().expect("load migrated snapshot");
    assert_eq!(
        snapshot.entries[0].items[0].cloud_task_id,
        "task-local-uuid"
    );

    db.conn
        .execute(
            "UPDATE pipeline_item
             SET closed_at = datetime('now')
             WHERE id = 'task-local-uuid'",
            [],
        )
        .expect("close historical task");
    db.conn
        .execute(
            "INSERT INTO pipeline_item (
                 id, cloud_task_id, repo_id, prompt, pipeline, stage, branch,
                 agent_type, agent_provider, activity, pinned, created_at, updated_at
             ) VALUES (
                 'task-imported-copy', 'task-local-uuid', 'origin-main-repo',
                 'Imported copy', 'default', 'in progress', 'task-imported-copy',
                 'claude', 'claude', 'idle', 0,
                 '2026-07-26 10:00:00', '2026-07-26 10:00:00'
             )",
            [],
        )
        .expect("reuse identity retained by a closed historical row");
    let duplicate_open_identity = db.conn.execute(
        "INSERT INTO pipeline_item (
             id, cloud_task_id, repo_id, prompt, pipeline, stage, branch,
             agent_type, agent_provider, activity, pinned, created_at, updated_at
         ) VALUES (
             'task-open-collision', 'task-local-uuid', 'origin-main-repo',
             'Conflicting copy', 'default', 'in progress', 'task-open-collision',
             'claude', 'claude', 'idle', 0,
             '2026-07-26 11:00:00', '2026-07-26 11:00:00'
         )",
        [],
    );
    assert!(
        duplicate_open_identity.is_err(),
        "two open tasks must not share one cloud identity"
    );

    drop(db);
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
        .expect("migrated task row");
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
                CREATE TABLE task_event (
                  seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  task_id TEXT NOT NULL,
                  type TEXT NOT NULL,
                  payload TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            CREATE TABLE task_event (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              type TEXT NOT NULL,
              payload TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            effort: Some("high"),
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
    assert_eq!(runs[0].effort.as_deref(), Some("high"));
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
        effort: None,
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
        effort: None,
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
        effort: None,
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
        effort: None,
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
              initial_pipeline TEXT,
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
            CREATE TABLE task_event (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              type TEXT NOT NULL,
              payload TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    .expect("insert task row");

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
fn activity_changed_events_cover_working_to_stopped_edges_only() {
    let path = temp_db_path();
    let db = Db::open_for_tests(path.to_str().expect("utf8 path")).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One")
        .expect("insert repo");
    for task_id in ["empty", "prompted", "closed"] {
        db.insert_test_pipeline_item(
            task_id,
            "repo-1",
            "task prompt",
            Some(task_id),
            "in progress",
            "2026-08-16 01:00:00",
        )
        .expect("insert task");
        db.update_pipeline_item_activity(task_id, "working")
            .expect("start working");
    }

    db.update_pipeline_item_activity("empty", "unread")
        .expect("stop without prompt");
    db.update_pipeline_item_waiting_prompt("prompted", "  Ready for review.  ")
        .expect("persist prompt");
    db.update_pipeline_item_activity("prompted", "idle")
        .expect("stop with prompt");

    // Read-state changes after the task stops are not new supervision signals.
    assert!(db
        .mark_pipeline_item_read_if_unchanged("empty", None)
        .expect("mark read"));
    db.update_pipeline_item_activity("empty", "unread")
        .expect("mark unread again");
    db.update_pipeline_item_activity("prompted", "unread")
        .expect("mark prompted task unread");
    db.update_pipeline_item_activity("prompted", "idle")
        .expect("mark prompted task read");

    db.close_pipeline_item("closed").expect("close task");
    let cursor_after_close = db.latest_task_event_seq().expect("event cursor");
    db.update_pipeline_item_activity("closed", "idle")
        .expect("ignore closed task activity");
    assert!(db
        .list_task_events(
            &super::TaskEventScope::Tasks(vec!["closed".to_string()]),
            cursor_after_close,
            i64::MAX,
            10,
        )
        .expect("list closed task events")
        .is_empty());

    let events = db
        .list_task_events(
            &super::TaskEventScope::Tasks(vec!["empty".to_string(), "prompted".to_string()]),
            0,
            i64::MAX,
            10,
        )
        .expect("list activity events");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_type, "task.activity_changed");
    assert_eq!(
        events[0].payload,
        serde_json::json!({
            "previousActivity": "working",
            "activity": "unread",
        })
    );
    assert_eq!(events[1].event_type, "task.activity_changed");
    assert_eq!(
        events[1].payload,
        serde_json::json!({
            "previousActivity": "working",
            "activity": "idle",
            "waitingPromptSnippet": "Ready for review.",
        })
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn the_runtime_dimension_survives_read_state_and_is_reset_by_a_new_run() {
    let path = Db::test_db_path("runtime-dimension-independence");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One")
        .expect("insert repo");
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "task prompt",
        Some("Task One"),
        "in progress",
        "2026-08-18 01:00:00",
    )
    .expect("insert task");

    // The reported defect: an agent busy inside a long tool or MCP call whose
    // latest output nobody has read. The display value collapses to `unread`
    // and the runtime dimension must not follow it.
    db.update_pipeline_item_runtime_status("task-1", "busy", None)
        .expect("record busy");
    db.update_pipeline_item_activity("task-1", "unread")
        .expect("mark unread");
    let item = db.get_pipeline_item("task-1").expect("read task").unwrap();
    assert_eq!(item.activity.as_deref(), Some("unread"));
    assert_eq!(item.runtime_status.as_deref(), Some("busy"));

    assert!(db
        .mark_pipeline_item_read_if_unchanged("task-1", None)
        .expect("mark read"));
    assert_eq!(
        db.get_pipeline_item("task-1")
            .expect("read task")
            .unwrap()
            .runtime_status
            .as_deref(),
        Some("busy"),
        "reading a task changes nothing about whether its agent is running"
    );

    // A session that ends without a replacement is the runtime dimension's
    // terminal value, and the one thing a wait for `finished` may resolve on
    // when no verdict was recorded.
    db.update_pipeline_item_runtime_status("task-1", "exited", None)
        .expect("record exit");
    assert_eq!(
        db.get_pipeline_item("task-1")
            .expect("read task")
            .unwrap()
            .runtime_status
            .as_deref(),
        Some("exited")
    );

    // A fresh running run means that verdict describes a session that no
    // longer exists; leaving it would resolve a wait on the new run's agent.
    db.insert_stage_run(NewStageRun {
        id: "run-2",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("insert replacement run");
    assert_eq!(
        db.get_pipeline_item("task-1")
            .expect("read task")
            .unwrap()
            .runtime_status,
        None,
        "a new session has not been classified yet, and is not an exited one"
    );

    drop(db);
    let _ = std::fs::remove_file(path);
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
fn blocker_revision_advances_without_touching_dependent_updated_at() {
    let path = Db::test_db_path("blocker-revision");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "prerequisite",
        Some("Prerequisite"),
        "in progress",
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

    let dependent_freshness = || {
        db.conn
            .query_row(
                "SELECT blocker_revision, updated_at
                 FROM pipeline_item
                 WHERE id = 'dependent-1'",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("dependent freshness")
    };
    let original_updated_at = dependent_freshness().1;

    db.insert_task_blocker("dependent-1", "blocker-1")
        .expect("insert blocker edge");
    assert_eq!(dependent_freshness(), (1, original_updated_at.clone()));

    db.remove_all_task_blockers("dependent-1")
        .expect("remove blocker edge");
    assert_eq!(dependent_freshness(), (2, original_updated_at.clone()));

    db.insert_task_blocker("dependent-1", "blocker-1")
        .expect("restore blocker edge");
    db.close_pipeline_item("blocker-1")
        .expect("resolve blocker by closing");
    assert_eq!(dependent_freshness(), (4, original_updated_at.clone()));

    db.reopen_pipeline_item("blocker-1")
        .expect("make blocker unresolved again");
    db.update_pipeline_item_stage("blocker-1", "pr")
        .expect("advance blocker to pr");
    db.update_pipeline_item_pr("blocker-1", Some(7), "https://github.com/acme/repo/pull/7")
        .expect("resolve blocker by publishing pr");
    assert_eq!(dependent_freshness(), (6, original_updated_at));

    let snapshot = db.ui_snapshot().expect("snapshot");
    let dependent = snapshot.entries[0]
        .items
        .iter()
        .find(|item| item.id == "dependent-1")
        .expect("dependent snapshot item");
    assert_eq!(dependent.blocker_revision, 6);

    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_blocker_replacements_cannot_both_create_inverse_edges() {
    let path = Db::test_db_path("concurrent-blocker-cycle");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    for id in ["task-a", "task-b"] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            id,
            Some(id),
            "in progress",
            "2026-07-26T00:00:00Z",
        )
        .expect("task");
    }
    drop(db);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let spawn_replace = |task_id: &'static str, blocker_id: &'static str| {
        let path = path.clone();
        let barrier = std::sync::Arc::clone(&barrier);
        std::thread::spawn(move || {
            let db = Db::open(&path).expect("open concurrent db");
            barrier.wait();
            db.replace_task_blockers_atomically(task_id, &[blocker_id.to_string()])
        })
    };
    let first = spawn_replace("task-a", "task-b");
    let second = spawn_replace("task-b", "task-a");
    barrier.wait();
    let results = [first.join().unwrap(), second.join().unwrap()];

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(ReplaceTaskBlockersError::CircularDependency)))
            .count(),
        1
    );

    let db = Db::open(&path).expect("reopen db");
    let a_blockers = db.list_task_blocker_ids("task-a").unwrap();
    let b_blockers = db.list_task_blocker_ids("task-b").unwrap();
    assert!(
        (a_blockers == ["task-b"] && b_blockers.is_empty())
            || (b_blockers == ["task-a"] && a_blockers.is_empty())
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_blocker_replacements_publish_one_complete_set() {
    let path = Db::test_db_path("concurrent-blocker-set");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    for id in ["task", "blocker-a", "blocker-b", "blocker-c", "blocker-d"] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            id,
            Some(id),
            "in progress",
            "2026-07-26T00:00:00Z",
        )
        .expect("task");
    }
    drop(db);

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let spawn_replace = |blockers: Vec<String>| {
        let path = path.clone();
        let barrier = std::sync::Arc::clone(&barrier);
        std::thread::spawn(move || {
            let db = Db::open(&path).expect("open concurrent db");
            barrier.wait();
            db.replace_task_blockers_atomically("task", &blockers)
        })
    };
    let first = spawn_replace(vec!["blocker-a".into(), "blocker-b".into()]);
    let second = spawn_replace(vec!["blocker-c".into(), "blocker-d".into()]);
    barrier.wait();
    first.join().unwrap().expect("first replacement");
    second.join().unwrap().expect("second replacement");

    let blockers = Db::open(&path)
        .unwrap()
        .list_task_blocker_ids("task")
        .unwrap();
    assert!(
        blockers == ["blocker-a", "blocker-b"] || blockers == ["blocker-c", "blocker-d"],
        "concurrent replacements interleaved into {blockers:?}"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn snapshot_never_observes_partial_blocker_replacement() {
    let path = Db::test_db_path("snapshot-atomic-blockers");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    for id in ["task", "blocker-old", "blocker-new-a", "blocker-new-b"] {
        db.insert_test_pipeline_item(
            id,
            "repo-1",
            id,
            Some(id),
            "in progress",
            "2026-07-26T00:00:00Z",
        )
        .expect("task");
    }
    db.insert_task_blocker("task", "blocker-old")
        .expect("old blocker");
    let old_snapshot = db.ui_snapshot().unwrap();
    let old_revision = old_snapshot.entries[0]
        .items
        .iter()
        .find(|item| item.id == "task")
        .unwrap()
        .blocker_revision;
    drop(db);

    let (deleted_tx, deleted_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        Db::open(&writer_path)
            .unwrap()
            .replace_task_blockers_atomically_with_hook(
                "task",
                &["blocker-new-a".into(), "blocker-new-b".into()],
                || {
                    deleted_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                },
            )
    });
    deleted_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("replacement never reached fault boundary");

    let during = Db::open(&path).unwrap().ui_snapshot().unwrap();
    let during_blockers: Vec<_> = during
        .task_blockers
        .iter()
        .filter(|edge| edge.blocked_item_id == "task")
        .map(|edge| edge.blocker_item_id.as_str())
        .collect();
    let during_revision = during.entries[0]
        .items
        .iter()
        .find(|item| item.id == "task")
        .unwrap()
        .blocker_revision;
    assert_eq!(during_blockers, ["blocker-old"]);
    assert_eq!(during_revision, old_revision);

    resume_tx.send(()).unwrap();
    writer.join().unwrap().expect("replacement commit");
    let after = Db::open(&path).unwrap().ui_snapshot().unwrap();
    let after_blockers: Vec<_> = after
        .task_blockers
        .iter()
        .filter(|edge| edge.blocked_item_id == "task")
        .map(|edge| edge.blocker_item_id.as_str())
        .collect();
    let after_revision = after.entries[0]
        .items
        .iter()
        .find(|item| item.id == "task")
        .unwrap()
        .blocker_revision;
    assert_eq!(after_blockers, ["blocker-new-a", "blocker-new-b"]);
    assert!(after_revision > old_revision);
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
        effort: None,
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

#[test]
fn revision_rounds_count_agent_rounds_until_reset() {
    let path = Db::test_db_path("revision-rounds");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix one thing",
        Some("Fix one thing"),
        "in progress",
        "2026-07-26 00:00:00",
    )
    .unwrap();

    // A task starts with its whole budget: existing rows (and rows written by
    // older versions, via the column default) count as zero rounds spent.
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 0);
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .revision_rounds,
        0
    );

    // Claiming reads and increments in one transaction, so the returned count
    // is the round the caller owns.
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 3).unwrap(),
        Some(1)
    );
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 3).unwrap(),
        Some(2)
    );
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 2);

    // At the limit the claim is refused rather than clamped, and refusing
    // must not spend anything.
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 2).unwrap(),
        None
    );
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 2);
    // A workflow that opted out of the cap always admits.
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 0).unwrap(),
        Some(3)
    );
    // Releasing hands a claimed round back, and floors at zero rather than
    // going negative.
    db.release_agent_revision_round("task-1").unwrap();
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 2);
    for _ in 0..5 {
        db.release_agent_revision_round("task-1").unwrap();
    }
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 0);
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 3).unwrap(),
        Some(1)
    );
    assert_eq!(
        db.try_claim_agent_revision_round("task-1", 3).unwrap(),
        Some(2)
    );
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .revision_rounds,
        2
    );

    // A human-requested revision hands the budget back.
    db.reset_task_revision_rounds("task-1").unwrap();
    assert_eq!(db.task_revision_rounds("task-1").unwrap(), 0);

    // An unknown task is an error, never a silent zero that would hand out an
    // unbounded budget.
    assert!(db
        .try_claim_agent_revision_round("missing-task", 3)
        .is_err());
    assert!(db.reset_task_revision_rounds("missing-task").is_err());
}

/// Event type names are a published contract: an orchestrator matches on these
/// strings, and `kanna_wait_events`'s description enumerates them. Renaming one
/// silently breaks every watcher written against it.
#[test]
fn task_event_type_names_are_stable() {
    let names = super::TaskEventKind::ALL
        .iter()
        .map(|kind| kind.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            "task.created",
            "run.started",
            "run.finished",
            "stage.changed",
            "task.workflow_changed",
            "task.closed",
            "task.pr_created",
            "task.revision_requested",
            "task.awaiting_input",
            "task.activity_changed",
            "task.merge_signaled",
            "task.merge_handoff_missing",
            "task.input_delivered",
            "task.input_blocked",
            "task.teardown_failed",
            "task.transfer_finalizing",
        ]
    );
}

/// A migrated database must accept the log the event feed reads, including its
/// autoincrementing cursor — the column the whole no-missed-events guarantee
/// rests on.
#[test]
fn task_event_log_cursor_increases_and_survives_deletes() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open migrated db");
    db.conn
        .execute_batch(
            "INSERT INTO repo (id, path, name) VALUES ('repo-1', '/tmp/repo-1', 'Repo');
             INSERT INTO pipeline_item (id, repo_id, stage) VALUES ('task-1', 'repo-1', 'in progress');",
        )
        .expect("seed task");

    db.append_task_event(
        "task-1",
        super::TaskEventKind::RunStarted,
        serde_json::json!({}),
    )
    .expect("append");
    db.append_task_event(
        "task-1",
        super::TaskEventKind::RunFinished,
        serde_json::json!({}),
    )
    .expect("append");
    let head = db.latest_task_event_seq().expect("head");
    assert_eq!(head, 2);

    // Retention pruning must not let a later event reuse a delivered cursor.
    db.conn
        .execute("DELETE FROM task_event", [])
        .expect("prune");
    assert_eq!(
        db.latest_task_event_seq().expect("head after prune"),
        head,
        "retention must not rewind the allocated cursor before another append"
    );
    db.append_task_event(
        "task-1",
        super::TaskEventKind::TaskClosed,
        serde_json::json!({}),
    )
    .expect("append after prune");
    let events = db
        .list_task_events(
            &super::TaskEventScope::Tasks(vec!["task-1".to_string()]),
            head,
            i64::MAX,
            10,
        )
        .expect("list");
    assert_eq!(events.len(), 1);
    assert!(
        events[0].seq > head,
        "AUTOINCREMENT must not reuse a cursor"
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn parent_event_query_plan_starts_from_the_global_sequence_range() {
    let path = Db::test_db_path("parent-event-query-plan");
    let db = Db::open_for_tests(&path).expect("open db");
    let sql = "EXPLAIN QUERY PLAN
         SELECT seq, task_id, type, payload, created_at
         FROM task_event NOT INDEXED
         WHERE seq > ? AND seq <= ?
           AND task_id IN (
               SELECT id FROM pipeline_item WHERE parent_task_id = ?
           )
         ORDER BY seq ASC
         LIMIT ?";
    let mut stmt = db.conn.prepare(sql).expect("prepare query plan");
    let details = stmt
        .query_map(
            rusqlite::params![10_i64, 20_i64, "parent-plan", 100_i64],
            |row| row.get::<_, String>(3),
        )
        .expect("read query plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect query plan");
    let plan = details.join("\n");
    assert!(
        plan.contains("SEARCH task_event USING INTEGER PRIMARY KEY")
            && plan.contains("rowid>?")
            && plan.contains("rowid<?"),
        "parent feed must seek from the cursor instead of rescanning retained history:\n{plan}"
    );
    assert!(
        plan.contains("idx_pipeline_item_parent_created_id"),
        "parent membership must use the covering relationship index:\n{plan}"
    );

    drop(stmt);
    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn repo_remote_hash_event_query_uses_relationship_indexes() {
    let path = Db::test_db_path("repo-remote-hash-event-query-plan");
    let db = Db::open_for_tests(&path).expect("open db");
    let sql = "EXPLAIN QUERY PLAN
         SELECT seq, task_id, type, payload, created_at
         FROM task_event
         WHERE seq > ? AND seq <= ?
           AND task_id IN (
               SELECT pipeline_item.id
               FROM pipeline_item
               JOIN repo ON repo.id = pipeline_item.repo_id
               WHERE repo.remote_url_hash = ?
           )
         ORDER BY seq ASC
         LIMIT ?";
    let mut stmt = db.conn.prepare(sql).expect("prepare query plan");
    let details = stmt
        .query_map(
            rusqlite::params![10_i64, 20_i64, "remote-hash-plan", 100_i64],
            |row| row.get::<_, String>(3),
        )
        .expect("read query plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect query plan");
    let plan = details.join("\n");
    assert!(
        plan.contains("idx_repo_remote_url_hash_id"),
        "repository hash lookup must use its covering index:\n{plan}"
    );
    assert!(
        plan.contains("idx_pipeline_item_repo_id_id") && !plan.contains("SCAN pipeline_item"),
        "repository task membership must use its covering index instead of scanning every task:\n{plan}"
    );

    drop(stmt);
    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn legacy_parent_candidate_probe_is_indexed_and_never_sorts_history() {
    let path = Db::test_db_path("legacy-parent-candidate-query-plan");
    let db = Db::open_for_tests(&path).expect("open db");
    let sql = "EXPLAIN QUERY PLAN
         SELECT seq, task_id, type, payload, created_at
         FROM task_event INDEXED BY idx_task_event_task_seq
         WHERE task_id = ?1 AND seq > ?2 AND seq <= ?3
         ORDER BY seq ASC
         LIMIT 1";
    let mut stmt = db.conn.prepare(sql).expect("prepare query plan");
    let details = stmt
        .query_map(rusqlite::params!["child-plan", 0_i64, 20_000_i64], |row| {
            row.get::<_, String>(3)
        })
        .expect("read query plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect query plan");
    let plan = details.join("\n");
    assert!(
        plan.contains("idx_task_event_task_seq") && plan.contains("task_id=? AND seq>? AND seq<?"),
        "legacy candidates must use a bounded per-child sequence probe:\n{plan}"
    );
    assert!(
        !plan.contains("SCAN task_event") && !plan.contains("USE TEMP B-TREE"),
        "a candidate probe must neither scan nor sort retained history:\n{plan}"
    );

    drop(stmt);
    drop(db);
    let _ = std::fs::remove_file(path);
}

fn seed_sticky_workflow_db(path: &std::path::Path) -> Db {
    let db = Db::open_for_tests(path.to_str().expect("utf8 path")).expect("open db");
    for (id, name) in [("repo-1", "first"), ("repo-2", "second")] {
        db.insert_repo(NewRepo {
            id,
            path: &format!("/tmp/{id}"),
            name,
            default_branch: Some("main"),
        })
        .expect("insert repo");
    }
    db
}

fn insert_sticky_workflow_task(db: &Db, id: &str, repo_id: &str, workflow_name: &str) {
    insert_sticky_workflow_child_task(db, id, repo_id, workflow_name, None);
}

fn insert_sticky_workflow_child_task(
    db: &Db,
    id: &str,
    repo_id: &str,
    workflow_name: &str,
    parent_task_id: Option<&str>,
) {
    db.insert_pipeline_item(NewPipelineItem {
        id,
        repo_id,
        prompt: "sticky workflow task",
        display_name: None,
        pipeline: workflow_name,
        pipeline_def: None,
        stage: "in progress",
        branch: &format!("task-{id}"),
        agent_type: "pty",
        agent_provider: "claude",
        activity: "idle",
        port_offset: None,
        port_env_json: None,
        agent_spawn_options_json: None,
        base_ref: None,
        notify_task_id: None,
        parent_task_id,
    })
    .expect("insert task row");
}

#[test]
fn recent_repo_workflows_reports_newest_first_per_repo() {
    let path = temp_db_path();
    let db = seed_sticky_workflow_db(&path);

    insert_sticky_workflow_task(&db, "task-1", "repo-1", "default");
    insert_sticky_workflow_task(&db, "task-2", "repo-1", "single-reviewer");
    // Another repo's history must never leak into this one's default.
    insert_sticky_workflow_task(&db, "task-3", "repo-2", "specialized-reviewers");

    assert_eq!(
        db.recent_repo_workflows("repo-1", 10).expect("repo-1"),
        vec!["single-reviewer".to_string(), "default".to_string()],
    );
    assert_eq!(
        db.recent_repo_workflows("repo-2", 10).expect("repo-2"),
        vec!["specialized-reviewers".to_string()],
    );
    assert!(db
        .recent_repo_workflows("repo-unknown", 10)
        .expect("unknown repo")
        .is_empty());

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn recent_repo_workflows_survives_a_closed_task() {
    let path = temp_db_path();
    let db = seed_sticky_workflow_db(&path);

    insert_sticky_workflow_task(&db, "task-1", "repo-1", "single-reviewer");
    db.close_pipeline_item("task-1").expect("close task");

    // The desktop snapshot drops closed tasks; the sticky default must not,
    // or a create whose response was lost and whose task then closed would
    // lose the operator's choice.
    assert_eq!(
        db.recent_repo_workflows("repo-1", 10).expect("repo-1"),
        vec!["single-reviewer".to_string()],
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn recent_repo_workflows_dedupes_and_ignores_dispatched_child_tasks() {
    let path = temp_db_path();
    let db = seed_sticky_workflow_db(&path);

    insert_sticky_workflow_task(&db, "task-1", "repo-1", "default");
    insert_sticky_workflow_task(&db, "task-2", "repo-1", "specialized-reviewers");
    insert_sticky_workflow_task(&db, "task-3", "repo-1", "default");
    // A review stage dispatching specialty reviews is not an operator choice.
    insert_sticky_workflow_child_task(&db, "task-4", "repo-1", "specialty-review", Some("task-2"));

    assert_eq!(
        db.recent_repo_workflows("repo-1", 10).expect("repo-1"),
        vec!["default".to_string(), "specialized-reviewers".to_string()],
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn recent_repo_workflows_honours_the_requested_limit() {
    let path = temp_db_path();
    let db = seed_sticky_workflow_db(&path);

    insert_sticky_workflow_task(&db, "task-1", "repo-1", "default");
    insert_sticky_workflow_task(&db, "task-2", "repo-1", "single-reviewer");
    insert_sticky_workflow_task(&db, "task-3", "repo-1", "specialized-reviewers");

    assert_eq!(
        db.recent_repo_workflows("repo-1", 2).expect("repo-1"),
        vec![
            "specialized-reviewers".to_string(),
            "single-reviewer".to_string()
        ],
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

#[test]
fn recent_repo_workflows_reads_durable_rows_after_reopening_the_database() {
    let path = temp_db_path();
    let path_string = path.to_string_lossy().to_string();
    let db = seed_sticky_workflow_db(&path);
    insert_sticky_workflow_task(&db, "task-1", "repo-1", "single-reviewer");
    db.close_pipeline_item("task-1").expect("close task");
    drop(db);

    // Restart: a fresh connection to the same file, as a relaunched app or a
    // second window would open.
    let reopened = Db::open(&path_string).expect("reopen db");
    assert_eq!(
        reopened
            .recent_repo_workflows("repo-1", 10)
            .expect("repo-1"),
        vec!["single-reviewer".to_string()],
    );

    drop(reopened);
    let _ = std::fs::remove_file(path);
}

/// The record that makes the incident impossible to repeat: an owner directive
/// relayed into a live PTY leaves a row a later stage can read, with the text,
/// the time, the stage and run it landed on, and who claimed to be speaking.
#[test]
fn recorded_task_inputs_carry_their_text_source_and_live_run() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open migrated db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix mobile pinning",
        Some("Fix mobile pinning"),
        "in progress",
        "2026-08-19 04:00:00",
    )
    .expect("task");
    db.insert_stage_run(super::NewStageRun {
        id: "run-implement",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .expect("run");

    let recorded = db
        .record_task_input(
            "task-1",
            super::TaskInputSource::Operator,
            "there shouldn't be a pin/unpin button, just swiping",
        )
        .expect("record")
        .expect("task exists");

    assert_eq!(recorded.task_id, "task-1");
    assert_eq!(recorded.run_id.as_deref(), Some("run-implement"));
    assert_eq!(recorded.stage.as_deref(), Some("in progress"));
    assert_eq!(recorded.source, "operator");
    assert_eq!(
        recorded.message,
        "there shouldn't be a pin/unpin button, just swiping"
    );
    assert!(!recorded.delivered_at.is_empty());

    assert_eq!(db.count_task_inputs("task-1").expect("count"), 1);
    assert_eq!(
        db.list_task_inputs("task-1", 50).expect("list"),
        vec![recorded]
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

/// Deliveries read back oldest first, so the list reads as the instruction
/// history it is, and every source label round-trips — including `notify`,
/// which the server assigns to its own completion notifications.
#[test]
fn task_inputs_read_back_in_delivery_order_with_every_source() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open migrated db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Parent task",
        Some("Parent task"),
        "in progress",
        "2026-08-19 04:00:00",
    )
    .expect("task");

    for (source, message) in [
        (super::TaskInputSource::Operator, "first"),
        (super::TaskInputSource::Manager, "second"),
        (super::TaskInputSource::Unspecified, "third"),
        (
            super::TaskInputSource::Notify,
            "TASK child-1 DONE [success]: Child",
        ),
    ] {
        db.record_task_input("task-1", source, message)
            .expect("record")
            .expect("task exists");
    }

    let inputs = db.list_task_inputs("task-1", 50).expect("list");
    assert_eq!(
        inputs
            .iter()
            .map(|input| (input.source.as_str(), input.message.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("operator", "first"),
            ("manager", "second"),
            ("unspecified", "third"),
            ("notify", "TASK child-1 DONE [success]: Child"),
        ]
    );
    // No running run: the input is still recorded, attributed to the stage
    // rather than invented onto a run that was not executing.
    assert!(inputs.iter().all(|input| input.run_id.is_none()));
    assert_eq!(db.count_task_inputs("task-1").expect("count"), 4);

    // A tail is a window on the end of the history, not a reordering of it,
    // and `total` is what tells a reader the window was one.
    let tailed = db.list_task_inputs("task-1", 2).expect("tail");
    assert_eq!(
        tailed
            .iter()
            .map(|input| input.message.as_str())
            .collect::<Vec<_>>(),
        vec!["third", "TASK child-1 DONE [success]: Child"]
    );

    drop(db);
    let _ = std::fs::remove_file(path);
}

/// The row is the record; the event only announces it. A watcher gets the
/// source and a bounded preview, and is told when the preview was cut so it
/// never mistakes a prefix for the whole directive.
#[test]
fn recording_a_task_input_appends_a_previewed_event() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open migrated db");
    db.insert_test_repo("repo-1", "Repo One").expect("repo");
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Long directive task",
        Some("Long directive task"),
        "review",
        "2026-08-19 04:00:00",
    )
    .expect("task");

    let long_message = "x".repeat(500);
    db.record_task_input("task-1", super::TaskInputSource::Manager, &long_message)
        .expect("record")
        .expect("task exists");
    db.record_task_input("task-1", super::TaskInputSource::Operator, "short")
        .expect("record")
        .expect("task exists");

    let head = db.latest_task_event_seq().expect("head");
    let events = db
        .list_task_events(
            &super::TaskEventScope::Tasks(vec!["task-1".to_string()]),
            0,
            head,
            10,
        )
        .expect("events");
    let delivered = events
        .iter()
        .filter(|event| event.event_type == "task.input_delivered")
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 2);
    assert_eq!(delivered[0].payload["source"], "manager");
    assert_eq!(delivered[0].payload["stage"], "review");
    assert_eq!(delivered[0].payload["truncated"], true);
    assert_eq!(
        delivered[0].payload["preview"].as_str().expect("preview"),
        "x".repeat(200)
    );
    assert_eq!(delivered[1].payload["source"], "operator");
    assert_eq!(delivered[1].payload["truncated"], false);
    assert_eq!(delivered[1].payload["preview"], "short");

    drop(db);
    let _ = std::fs::remove_file(path);
}

/// A notification aimed at a task that no longer exists is a log line, not an
/// error: nothing to record, and nothing broken by there being nothing.
#[test]
fn recording_an_input_for_an_unknown_task_reports_no_record() {
    let path = temp_db_path();
    let db = Db::open_migrated(path.to_str().expect("utf8 path")).expect("open migrated db");

    assert_eq!(
        db.record_task_input("missing-task", super::TaskInputSource::Notify, "hello")
            .expect("record"),
        None
    );
    assert_eq!(db.count_task_inputs("missing-task").expect("count"), 0);

    drop(db);
    let _ = std::fs::remove_file(path);
}

/// `notify` names a message the server generated itself, so a caller cannot
/// claim it; `unspecified` is already what saying nothing means.
#[test]
fn caller_declared_input_sources_are_a_closed_set() {
    assert_eq!(
        super::TaskInputSource::from_caller_declared("operator"),
        Ok(super::TaskInputSource::Operator)
    );
    assert_eq!(
        super::TaskInputSource::from_caller_declared("manager"),
        Ok(super::TaskInputSource::Manager)
    );
    assert!(super::TaskInputSource::from_caller_declared("notify").is_err());
    assert!(super::TaskInputSource::from_caller_declared("unspecified").is_err());
    assert!(super::TaskInputSource::from_caller_declared("owner").is_err());
}
