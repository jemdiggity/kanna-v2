//! Validation for session ids arriving over the daemon socket.
//!
//! Session ids are client-supplied and are interpolated into filenames by more
//! than one subsystem — agent journals (`agent-journals/{id}.ndjson`) and
//! recovery snapshots (`{snapshot_dir}/{id}.json`) — so an unchecked id is a
//! write-anywhere primitive. `Path::join` replaces its base when handed an
//! absolute path, and `..` walks out of the directory.
//!
//! This module is the single source of truth for that check. It deliberately
//! lives outside `agent`: PTY spawn and recovery derive paths from session ids
//! too.

use std::path::{Component, Path};

/// True when `session_id` is safe to use as the filename stem for persisted
/// daemon state.
///
/// In addition to requiring exactly one normal path component, this accepts
/// only lowercase ASCII. That makes the mapping from registry id to filename
/// injective on case- and normalization-insensitive filesystems.
pub fn is_safe(session_id: &str) -> bool {
    if session_id.is_empty() || session_id.contains('\0') {
        return false;
    }
    if session_id.contains('/') || session_id.contains('\\') {
        return false;
    }

    // Registry identity is an exact Rust string, but the target macOS
    // filesystem is case- and normalization-insensitive. Rejecting non-ASCII
    // removes normalization aliases, and rejecting uppercase leaves one
    // representative of each ASCII case-equivalence class.
    if !session_id.is_ascii() || session_id.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return false;
    }

    let mut components = Path::new(session_id).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(only)), None) => only == std::ffi::OsStr::new(session_id),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ids_the_daemon_issues() {
        for safe in [
            "agent-1",
            "task-eb76b59d",
            "td-task-eb76b59d-2",
            "session_42",
            "a",
            "..dotfile-ish",
            "trailing..",
        ] {
            assert!(is_safe(safe), "{safe:?} should be accepted");
        }
    }

    #[test]
    fn rejects_ids_that_would_escape_the_directory() {
        for hostile in [
            "",
            ".",
            "..",
            "/",
            "/etc/passwd",
            "../escape",
            "../../etc/passwd",
            "nested/id",
            "back\\slash",
            "has\0nul",
            "trailing/",
        ] {
            assert!(!is_safe(hostile), "{hostile:?} should be rejected");
        }
    }

    /// The policy assertions run everywhere. The probe reports whether this
    /// volume actually aliases case variants, but is informational so the test
    /// remains portable to case-sensitive filesystems.
    #[test]
    fn rejects_ids_that_can_alias_on_case_and_normalization_insensitive_volumes() {
        let probe = std::env::temp_dir().join(format!(
            "kanna-idclass-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&probe).expect("probe dir");
        std::fs::write(probe.join("Agent.ndjson"), b"first").expect("write upper");
        std::fs::write(probe.join("agent.ndjson"), b"second").expect("write lower");
        let collided =
            std::fs::read(probe.join("Agent.ndjson")).expect("read upper") == b"second".to_vec();
        let _ = std::fs::remove_dir_all(&probe);

        if collided {
            eprintln!(
                "note: this volume is case-insensitive; the ids rejected below would alias here"
            );
        } else {
            eprintln!(
                "note: this volume is case-sensitive; the policy still protects shipped apps on \
                 case-insensitive APFS"
            );
        }

        assert!(is_safe("agent-1"));
        for cased in ["Agent-1", "AGENT-1", "aGent-1", "Task-EB76B59D"] {
            assert!(
                !is_safe(cased),
                "{cased:?} collides with its lowercase form and must be rejected"
            );
        }

        let composed = "caf\u{e9}";
        let decomposed = "cafe\u{301}";
        assert_ne!(composed, decomposed, "the two forms differ as Rust strings");
        assert!(
            !is_safe(composed) && !is_safe(decomposed),
            "canonically equivalent ids must both be rejected"
        );
        for non_ascii in ["ünïcode", "日本語", "e\u{301}"] {
            assert!(!is_safe(non_ascii), "{non_ascii:?} must be rejected");
        }
    }
}
