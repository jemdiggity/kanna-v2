use super::NewStageRun;
use super::{
    add_column, database_open_flags, run_migration, Db, NewPipelineItem, NewTaskTransfer,
    NewTaskTransferProvenance, CURRENT_SCHEMA_MIGRATIONS,
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
    assert_eq!(latest_migration, "034_pipeline_item_revision_rounds");

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
    db.insert_test_task_transfer("transfer-1", "incoming", "streaming", Some("{}"))
        .expect("insert transfer");
    drop(db);

    let db = Db::open(&path).expect("reopen test db after restart");
    let streaming = db
        .list_pending_incoming_transfers()
        .expect("list streaming transfer after restart");
    assert_eq!(streaming.len(), 1);
    assert_eq!(streaming[0].status, "streaming");
    assert!(db
        .claim_pending_incoming_transfer("transfer-1")
        .expect("reclaim streaming transfer after restart"));

    assert!(db
        .mark_incoming_transfer_importing("transfer-1", "task-local")
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
        .mark_incoming_transfer_awaiting_acknowledgment("transfer-1", "task-local")
        .expect("mark awaiting"));
    let resumable = db
        .list_pending_incoming_transfers()
        .expect("list resumable transfers");
    assert_eq!(resumable.len(), 1);
    assert_eq!(resumable[0].status, "awaiting_acknowledgment");
    assert_eq!(resumable[0].local_task_id.as_deref(), Some("task-local"));
    assert!(db
        .claim_pending_incoming_transfer("transfer-1")
        .expect("claim resumable awaiting transfer"));

    assert!(db
        .mark_task_transfer_completed("transfer-1", "task-local")
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
        .mark_task_transfer_completed("transfer-1", "task-source")
        .expect("complete transfer"));
    assert!(db
        .mark_task_transfer_completed("transfer-1", "task-source")
        .expect("replay matching completion"));
    assert!(!db
        .mark_task_transfer_completed("transfer-1", "different-source")
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
        .expect("load migrated pipeline item")
        .expect("migrated pipeline item exists");
    assert_eq!(item.activity_revision, 0);
    // Rows written before the revision budget existed start with their full
    // budget rather than an exhausted one.
    assert_eq!(item.revision_rounds, 0);

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
        .expect("reload transitioned pipeline item")
        .expect("transitioned pipeline item exists");
    assert_eq!(item.activity.as_deref(), Some("working"));
    assert_eq!(item.activity_revision, 1);

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
fn provider_session_id_updates_exact_owning_main_run() {
    let path = Db::test_db_path("provider-session-owning-run");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement provider resume",
        Some("Provider resume"),
        "review",
        "2026-07-23 00:00:00",
    )
    .unwrap();
    for (id, stage, kind, status) in [
        ("run-implement", "in progress", "main", "succeeded"),
        ("run-post", "commit", "post", "succeeded"),
        ("run-review", "review", "main", "running"),
    ] {
        db.insert_stage_run(NewStageRun {
            id,
            task_id: "task-1",
            stage,
            kind,
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status,
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: Some("/tmp/task-1"),
            resumed_from_run_id: None,
        })
        .unwrap();
    }

    let update = db
        .update_stage_run_provider_session_id("run-implement", "codex-thread")
        .unwrap();
    assert!(update.changed);

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs[0].provider_session_id.as_deref(), Some("codex-thread"));
    assert_eq!(runs[1].provider_session_id, None);
    assert_eq!(runs[2].provider_session_id, None);
    let task_handle: Option<String> = db
        .conn
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        task_handle, None,
        "a delayed old-run event must not stamp the replacement task handle"
    );
}

#[test]
fn provider_session_id_reports_when_owning_main_run_is_current() {
    let path = Db::test_db_path("provider-session-current-run");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement provider resume",
        Some("Provider resume"),
        "in progress",
        "2026-07-23 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-implement",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: None,
        agent_provider: Some("opencode"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: Some("/tmp/task-1"),
        resumed_from_run_id: None,
    })
    .unwrap();

    let update = db
        .update_stage_run_provider_session_id("run-implement", "opencode-thread")
        .unwrap();

    assert!(update.changed);
    let task_handle: Option<String> = db
        .conn
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_handle.as_deref(), Some("opencode-thread"));
}

#[test]
fn deleting_closed_unstarted_run_restores_previous_main_provider_session() {
    let path = Db::test_db_path("rollback-unstarted-provider-session");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement provider resume",
        Some("Provider resume"),
        "review",
        "2026-07-23 00:00:00",
    )
    .unwrap();
    for (id, stage, status, provider_session_id) in [
        (
            "run-implement",
            "in progress",
            "succeeded",
            Some("provider-implement"),
        ),
        ("run-review", "review", "pending", None),
    ] {
        db.insert_stage_run(NewStageRun {
            id,
            task_id: "task-1",
            stage,
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status,
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id,
            cwd: Some("/tmp/task-1"),
            resumed_from_run_id: None,
        })
        .unwrap();
    }

    db.close_pipeline_item("task-1").unwrap();
    assert!(
        db.update_stage_run_provider_session_id("run-review", "provider-abandoned")
            .unwrap()
            .changed
    );
    db.delete_unstarted_stage_run_and_restore_provider_session_id("run-review")
        .unwrap();

    let task_handle: Option<String> = db
        .conn
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_handle.as_deref(), Some("provider-implement"));
    assert_eq!(
        db.list_stage_runs_for_task("task-1")
            .unwrap()
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        vec!["run-implement"]
    );
}

#[test]
fn landing_stage_run_on_closed_task_does_not_reinsert_worktree_or_mutate_stage() {
    let path = Db::test_db_path("land-stage-run-closed-task");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement provider resume",
        Some("Provider resume"),
        "in progress",
        "2026-07-23 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-review",
        task_id: "task-1",
        stage: "review",
        kind: "main",
        agent: None,
        agent_provider: Some("codex"),
        model: None,
        status: "pending",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: Some("/tmp/task-1-1"),
        resumed_from_run_id: None,
    })
    .unwrap();
    db.upsert_worktree("wt-task-1", "task-1", "/tmp/task-1", "task-1")
        .unwrap();
    db.close_pipeline_item("task-1").unwrap();
    db.delete_worktree_rows_for_task("task-1").unwrap();

    let error = db
        .land_stage_run(
            "task-1",
            "run-review",
            "review",
            Some("task-1-1"),
            Some(("wt-task-1", "/tmp/task-1-1", "task-1-1")),
        )
        .unwrap_err();

    assert!(matches!(error, rusqlite::Error::QueryReturnedNoRows));
    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("in progress"));
    let worktree_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM worktree WHERE pipeline_item_id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(worktree_count, 0);
    assert_eq!(
        db.latest_stage_run("task-1").unwrap().unwrap().status,
        "cancelled"
    );
}

#[test]
fn landing_stage_run_preserves_provider_handle_discovered_after_spawn() {
    let path = Db::test_db_path("land-stage-run-provider-event");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement provider resume",
        Some("Provider resume"),
        "in progress",
        "2026-07-23 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-review",
        task_id: "task-1",
        stage: "review",
        kind: "main",
        agent: None,
        agent_provider: Some("codex"),
        model: None,
        status: "pending",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: Some("/tmp/task-1-1"),
        resumed_from_run_id: None,
    })
    .unwrap();
    assert!(
        db.update_stage_run_provider_session_id("run-review", "provider-review")
            .unwrap()
            .changed
    );

    db.land_stage_run(
        "task-1",
        "run-review",
        "review",
        Some("task-1-1"),
        Some(("wt-task-1", "/tmp/task-1-1", "task-1-1")),
    )
    .unwrap();

    let item = db.get_pipeline_item("task-1").unwrap().unwrap();
    assert_eq!(item.stage.as_deref(), Some("review"));
    let task_handle: Option<String> = db
        .conn
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_handle.as_deref(), Some("provider-review"));
    assert_eq!(
        db.latest_stage_run("task-1").unwrap().unwrap().status,
        "running"
    );
}

#[test]
fn successor_run_reservation_is_single_winner_for_expected_task_state() {
    let path = Db::test_db_path("stage-action-cas");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement CAS",
        Some("CAS"),
        "review",
        "2026-07-25 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-review",
        task_id: "task-1",
        stage: "review",
        kind: "main",
        agent: None,
        agent_provider: Some("codex"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: Some("provider-review"),
        cwd: Some("/tmp/task-1"),
        resumed_from_run_id: None,
    })
    .unwrap();
    let expected = db.task_action_state("task-1").unwrap();

    let reserve = |id: &str| {
        db.replace_current_run_with_pending(
            NewStageRun {
                id,
                task_id: "task-1",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "pending",
                result: None,
                feedback: None,
                session_id: Some("task-1"),
                provider_session_id: None,
                cwd: Some("/tmp/task-1"),
                resumed_from_run_id: None,
            },
            Some("manual"),
            &expected,
            "failed",
            Some(r#"{"status":"failure"}"#),
            Some("review feedback"),
        )
    };

    reserve("run-revision-a").expect("first action reserves");
    assert!(matches!(
        reserve("run-revision-b"),
        Err(rusqlite::Error::QueryReturnedNoRows)
    ));
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(
        runs.iter()
            .filter(|run| run.status == "pending")
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>(),
        vec!["run-revision-a"]
    );
    assert_eq!(
        runs.iter()
            .find(|run| run.id == "run-review")
            .unwrap()
            .status,
        "failed"
    );
}

#[test]
fn delayed_completion_cannot_finish_replacement_run() {
    let path = Db::test_db_path("stage-completion-run-cas");
    let db = Db::open_for_tests(&path).expect("open test db");
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Implement completion CAS",
        None,
        "in progress",
        "2026-07-25 00:00:00",
    )
    .unwrap();
    for id in ["old-run", "replacement-run"] {
        db.insert_stage_run(NewStageRun {
            id,
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: Some("/tmp/task-1"),
            resumed_from_run_id: None,
        })
        .unwrap();
    }

    assert!(matches!(
        db.finish_active_stage_run(
            "task-1",
            Some("old-run"),
            "succeeded",
            Some("{}"),
            Some("late"),
        ),
        Err(rusqlite::Error::QueryReturnedNoRows)
    ));
    assert_eq!(
        db.latest_stage_run("task-1").unwrap().unwrap().status,
        "running"
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
    // A pipeline that opted out of the cap always admits.
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
