use kanna_terminal_recovery::protocol::RecoverySnapshot;
use kanna_terminal_recovery::session_mirror::{scrollback_byte_limit, SessionMirror};
use libghostty_vt::{Terminal, TerminalOptions};

#[test]
fn mirror_serializes_full_scrollback_after_multiple_writes() {
    let mut mirror = SessionMirror::new("session-1", 120, 45).expect("mirror should initialize");
    mirror.write_output(b"line 1\r\n", 1);
    mirror.write_output(b"line 2\r\n", 2);
    mirror.write_output(b"prompt>", 3);

    let snapshot = mirror.snapshot().expect("snapshot should succeed");

    assert!(snapshot.serialized.contains("line 1"));
    assert!(snapshot.serialized.contains("line 2"));
    assert!(snapshot.serialized.contains("prompt>"));
    assert_eq!(snapshot.sequence, 3);
}

#[test]
fn mirror_serializes_ten_thousand_scrollback_lines() {
    let mut mirror = SessionMirror::new("session-10k", 120, 45).expect("mirror should initialize");
    for line in 1..=10_050 {
        mirror.write_output(format!("RSCROLL{line:05}\r\n").as_bytes(), line);
    }
    mirror.write_output(b"RSCROLLEND\r\n", 10_051);

    let snapshot = mirror.snapshot().expect("snapshot should succeed");

    let retained = snapshot.serialized.matches("RSCROLL").count();
    assert!(
        retained >= 10_000,
        "expected at least 10,000 serialized scrollback lines, got {retained}; serialized_len={}",
        snapshot.serialized.len()
    );
    assert!(snapshot.serialized.contains("RSCROLLEND"));
}

#[test]
fn ghostty_terminal_keeps_ten_thousand_scrollback_lines() {
    let mut terminal = Terminal::new(TerminalOptions {
        cols: 120,
        rows: 45,
        max_scrollback: scrollback_byte_limit(120, 45, 10_000),
    })
    .expect("terminal should initialize");

    for line in 1..=10_050 {
        terminal.vt_write(format!("GSCROLL{line:05}\r\n").as_bytes());
    }
    terminal.vt_write(b"GSCROLLEND\r\n");

    let scrollback_rows = terminal
        .scrollback_rows()
        .expect("scrollback rows should be readable");
    let total_rows = terminal
        .total_rows()
        .expect("total rows should be readable");

    assert!(
        scrollback_rows >= 10_000,
        "expected at least 10,000 scrollback rows, got {scrollback_rows}; total_rows={total_rows}"
    );
}

#[test]
fn mirror_restores_cursor_state_from_snapshot() {
    let snapshot = RecoverySnapshot {
        session_id: "session-2".to_string(),
        serialized: "hello".to_string(),
        cols: 80,
        rows: 24,
        cursor_row: 1,
        cursor_col: 2,
        cursor_visible: true,
        saved_at: 1,
        sequence: 7,
    };

    let mut mirror = SessionMirror::new("session-2", 80, 24).expect("mirror should initialize");
    mirror.restore(&snapshot).expect("restore should succeed");

    let restored = mirror.snapshot().expect("snapshot should succeed");
    assert!(restored.serialized.contains("hello"));
    assert_eq!(restored.cursor_row, 1);
    assert_eq!(restored.cursor_col, 2);
    assert_eq!(restored.sequence, 7);
}
