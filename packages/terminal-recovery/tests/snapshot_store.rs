use kanna_terminal_recovery::protocol::RecoverySnapshot;
use kanna_terminal_recovery::snapshot_store::SnapshotStore;

#[test]
fn snapshot_store_roundtrips_snapshot_files() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let snapshot = RecoverySnapshot {
        session_id: "session-1".to_string(),
        serialized: "prompt>".to_string(),
        cols: 100,
        rows: 30,
        cursor_row: Some(4),
        cursor_col: Some(5),
        cursor_visible: Some(true),
        saved_at: 10,
        sequence: 11,
    };

    store.write(&snapshot).expect("write should succeed");

    let restored = store
        .require("session-1")
        .expect("stored snapshot should roundtrip");
    assert_eq!(restored, snapshot);
}

#[test]
fn snapshot_store_rejects_invalid_payloads() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    let path = tempdir.path().join("session-bad.json");
    std::fs::write(&path, b"{\"sessionId\":\"session-bad\",\"serialized\":1}")
        .expect("should seed invalid json payload");

    let error = store
        .require("session-bad")
        .expect_err("invalid snapshots should fail");

    assert!(error.to_lowercase().contains("persisted snapshot"));
}

#[test]
fn snapshot_store_remove_is_idempotent() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());

    store
        .remove("missing")
        .expect("remove should ignore missing files");
}

#[test]
fn snapshot_store_removes_stale_temp_files_during_cleanup() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let stale_temp = tempdir.path().join("session-1.json.tmp-123-1");
    let durable_snapshot = tempdir.path().join("session-1.json");
    let fresh_temp = tempdir
        .path()
        .join(format!("session-2.json.tmp-123-{}", current_time_millis()));
    let unrelated_file = tempdir.path().join("notes.tmp-123-456");
    std::fs::write(&stale_temp, b"stale").expect("should seed stale temp file");
    std::fs::write(&durable_snapshot, b"{}").expect("should seed durable file");
    std::fs::write(&fresh_temp, b"fresh").expect("should seed fresh temp file");
    std::fs::write(&unrelated_file, b"keep").expect("should seed unrelated file");

    let store = SnapshotStore::new(tempdir.path());
    store
        .cleanup_stale_temp_files()
        .expect("cleanup should remove stale temp files");

    assert!(
        !stale_temp.exists(),
        "stale recovery temp files should be removed"
    );
    assert!(
        durable_snapshot.exists(),
        "durable snapshots must not be removed"
    );
    assert!(
        fresh_temp.exists(),
        "fresh temp files may belong to a writer"
    );
    assert!(unrelated_file.exists(), "unrelated temp-looking files stay");
}

#[test]
fn snapshot_store_removes_temp_file_when_publish_fails() {
    let tempdir = tempfile::tempdir().expect("tempdir should exist");
    let store = SnapshotStore::new(tempdir.path());
    std::fs::create_dir(tempdir.path().join("session-1.json"))
        .expect("directory should block snapshot publish");

    let snapshot = RecoverySnapshot {
        session_id: "session-1".to_string(),
        serialized: "prompt>".to_string(),
        cols: 100,
        rows: 30,
        cursor_row: Some(4),
        cursor_col: Some(5),
        cursor_visible: Some(true),
        saved_at: 10,
        sequence: 11,
    };

    let error = store
        .write(&snapshot)
        .expect_err("publish should fail when destination is a directory");

    assert!(error.contains("failed to publish snapshot"));
    let leaked_temps = std::fs::read_dir(tempdir.path())
        .expect("snapshot dir should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("session-1.json.tmp-"))
        .collect::<Vec<_>>();
    assert_eq!(
        leaked_temps,
        Vec::<String>::new(),
        "failed publishes should not leave retry temp files"
    );
}

fn current_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
