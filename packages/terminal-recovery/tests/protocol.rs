use kanna_terminal_recovery::protocol::{RecoveryCommand, RecoveryResponse, RecoverySnapshot};

#[test]
fn start_session_command_roundtrips() {
    let json = r#"{"type":"StartSession","sessionId":"sess-1","cols":120,"rows":45,"resumeFromDisk":true}"#;
    let command: RecoveryCommand = serde_json::from_str(json).expect("should parse command");

    assert_eq!(
        command,
        RecoveryCommand::StartSession {
            session_id: "sess-1".to_string(),
            cols: 120,
            rows: 45,
            resume_from_disk: true,
        }
    );
}

#[test]
fn snapshot_response_serializes_cursor_fields() {
    let response = RecoveryResponse::from_snapshot(RecoverySnapshot {
        session_id: "sess-1".to_string(),
        serialized: "prompt>".to_string(),
        cols: 120,
        rows: 45,
        cursor_row: Some(12),
        cursor_col: Some(4),
        cursor_visible: Some(false),
        saved_at: 123,
        sequence: 9,
    });

    let json = serde_json::to_string(&response).expect("should serialize response");

    assert!(json.contains("\"cursorRow\":12"));
    assert!(json.contains("\"cursorCol\":4"));
    assert!(json.contains("\"cursorVisible\":false"));
    assert!(json.contains("\"sessionId\":\"sess-1\""));
}
