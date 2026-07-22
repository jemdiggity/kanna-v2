use kanna_daemon::{protocol, recovery::RecoverySnapshot};

pub(crate) fn recovery_snapshot_to_terminal_snapshot(
    snapshot: RecoverySnapshot,
) -> protocol::TerminalSnapshot {
    protocol::TerminalSnapshot {
        version: 1,
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        cursor_visible: snapshot.cursor_visible,
        saved_at: snapshot.saved_at,
        sequence: snapshot.sequence,
        vt: snapshot.serialized,
    }
}

pub(crate) fn error_event(
    code: Option<protocol::ErrorCode>,
    message: impl Into<String>,
) -> protocol::Event {
    protocol::Event::Error {
        code,
        message: message.into(),
    }
}
