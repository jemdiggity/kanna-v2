//! The canonical named terminal keys Kanna's agent-facing surfaces accept.
//!
//! Menus and permission prompts inside an agent CLI are driven by discrete
//! keystrokes, not by sentences. `POST /v1/tasks/{id}/input` cannot express one:
//! it carries a logical *message* and the daemon appends its own Enter, so it
//! can answer a question but never move a selection. On 2026-09-05 an imported
//! task sat at Claude's workspace-trust selection and the only way to move it
//! was a hand-written Unix-socket `InputIfSession` carrying `[27,91,66]` and
//! then `[13]`. This table is that capability spelled out once, so the server,
//! the CLI, the MCP catalog and their tests all name the same keys and encode
//! the same bytes.
//!
//! # Terminal-mode limitations
//!
//! These are the sequences an `xterm`-family terminal emits in its **normal**
//! modes, which is what Kanna's PTYs run and what every agent CLI in the
//! provider registry reads. They are not universal:
//!
//! - Cursor keys are encoded as CSI (`ESC [ A`). An application that has
//!   enabled DECCKM (*application cursor keys*) expects SS3 (`ESC O A`)
//!   instead. Most TUI input parsers accept both; some do not.
//!   [`crate::terminal_keys`] deliberately does not guess which mode a live
//!   terminal is in — send the SS3 form as explicit bytes when an application
//!   needs it.
//! - `home` and `end` are the `CSI H` / `CSI F` forms. `linux`- and
//!   `vt220`-style applications may expect `CSI 1~` / `CSI 4~`.
//! - `backspace` is DEL (`0x7f`), which is what macOS terminals send. An
//!   application configured for BS (`0x08`) needs `ctrl-h`.
//! - Function keys are absent on purpose: F1–F4 have both SS3 and CSI
//!   encodings in common use, so no single spelling is unambiguous. Send them
//!   as explicit bytes.
//!
//! Anything not listed here is expressible as explicit bytes, which is the
//! documented escape hatch rather than a reason to grow this table with
//! spellings that are only right some of the time.

/// Version of the server/daemon contract that carries fenced raw terminal
/// input with a producer-declared class.
///
/// A daemon that predates it cannot deserialize the command at all — it drops
/// the connection without answering — so the server negotiates this first.
/// Negotiation touches no PTY, which is what lets a failure be reported as
/// "nothing was written" rather than as an uncertain delivery.
pub const RAW_INPUT_PROTOCOL_VERSION: u32 = 1;

/// What a producer declares one raw terminal write *means* for the composer.
///
/// This mirrors the daemon's own draft/submission/control vocabulary. Only
/// [`TerminalKeyClass::Submission`] ends a composer draft, and only the
/// `enter` key carries it: submission is a declaration, never something
/// inferred from CR bytes in a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalKeyClass {
    /// Bytes that belong to whatever line is being composed. The daemon
    /// decides from their content whether they could actually create a draft.
    Draft,
    /// The producer knows this write submits the current composer.
    Submission,
}

impl TerminalKeyClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Submission => "submission",
        }
    }
}

/// One named key: its wire name, the bytes it writes, and what it declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalKey {
    pub name: &'static str,
    pub bytes: &'static [u8],
    pub class: TerminalKeyClass,
}

/// C0 control characters that already have an unambiguous named key.
///
/// `ctrl-i` is Tab, `ctrl-m` is Enter. Both are accepted under their own names
/// only: `enter` declares a submission boundary and `ctrl-m` would not, so
/// admitting the second spelling would let the same keystroke arrive with the
/// wrong composer meaning depending on which name the caller happened to pick.
pub const CTRL_LETTERS_WITH_NAMED_EQUIVALENTS: [char; 2] = ['i', 'm'];

macro_rules! keys {
    ($($name:literal => $bytes:expr, $class:expr;)*) => {
        &[$(TerminalKey { name: $name, bytes: $bytes, class: $class },)*]
    };
}

use TerminalKeyClass::{Draft, Submission};

/// Named keys that are not a `ctrl-` chord.
const NAMED_KEYS: &[TerminalKey] = keys! {
    "escape"    => b"\x1b",       Draft;
    "enter"     => b"\r",         Submission;
    "tab"       => b"\t",         Draft;
    "backtab"   => b"\x1b[Z",     Draft;
    "backspace" => b"\x7f",       Draft;
    "delete"    => b"\x1b[3~",    Draft;
    "up"        => b"\x1b[A",     Draft;
    "down"      => b"\x1b[B",     Draft;
    "right"     => b"\x1b[C",     Draft;
    "left"      => b"\x1b[D",     Draft;
    "home"      => b"\x1b[H",     Draft;
    "end"       => b"\x1b[F",     Draft;
    "page-up"   => b"\x1b[5~",    Draft;
    "page-down" => b"\x1b[6~",    Draft;
    "space"     => b" ",          Draft;
};

/// `ctrl-` chords whose name is not `ctrl-<letter>`.
const NAMED_CTRL_KEYS: &[TerminalKey] = keys! {
    "ctrl-space"         => b"\x00", Draft;
    "ctrl-backslash"     => b"\x1c", Draft;
    "ctrl-right-bracket" => b"\x1d", Draft;
    "ctrl-caret"         => b"\x1e", Draft;
    "ctrl-underscore"    => b"\x1f", Draft;
};

/// `ctrl-a` … `ctrl-z`, minus the two that duplicate a named key.
///
/// Stored as a static table rather than parsed on demand so that
/// [`terminal_key_names`] can enumerate the complete accepted vocabulary — the
/// MCP schema advertises it, and a contract test holds the two in step.
const CTRL_LETTER_KEYS: &[TerminalKey] = keys! {
    "ctrl-a" => b"\x01", Draft;
    "ctrl-b" => b"\x02", Draft;
    "ctrl-c" => b"\x03", Draft;
    "ctrl-d" => b"\x04", Draft;
    "ctrl-e" => b"\x05", Draft;
    "ctrl-f" => b"\x06", Draft;
    "ctrl-g" => b"\x07", Draft;
    "ctrl-h" => b"\x08", Draft;
    "ctrl-j" => b"\n",   Draft;
    "ctrl-k" => b"\x0b", Draft;
    "ctrl-l" => b"\x0c", Draft;
    "ctrl-n" => b"\x0e", Draft;
    "ctrl-o" => b"\x0f", Draft;
    "ctrl-p" => b"\x10", Draft;
    "ctrl-q" => b"\x11", Draft;
    "ctrl-r" => b"\x12", Draft;
    "ctrl-s" => b"\x13", Draft;
    "ctrl-t" => b"\x14", Draft;
    "ctrl-u" => b"\x15", Draft;
    "ctrl-v" => b"\x16", Draft;
    "ctrl-w" => b"\x17", Draft;
    "ctrl-x" => b"\x18", Draft;
    "ctrl-y" => b"\x19", Draft;
    "ctrl-z" => b"\x1a", Draft;
};

/// Every key this vocabulary accepts, in the order surfaces should list them.
pub fn terminal_keys() -> impl Iterator<Item = &'static TerminalKey> {
    NAMED_KEYS
        .iter()
        .chain(NAMED_CTRL_KEYS)
        .chain(CTRL_LETTER_KEYS)
}

/// Every accepted key name, in listing order.
pub fn terminal_key_names() -> Vec<&'static str> {
    terminal_keys().map(|key| key.name).collect()
}

/// Resolve one key name. Matching is exact: there are no aliases and no case
/// folding, so a name either is the vocabulary's spelling or is rejected with
/// the list of names that are.
pub fn terminal_key(name: &str) -> Option<&'static TerminalKey> {
    terminal_keys().find(|key| key.name == name)
}

/// The rejection message for an unknown key name.
///
/// It names the two redundant spellings explicitly, because `ctrl-m` and
/// `ctrl-i` are the ones a caller is most likely to reach for and the reason
/// they are absent is not guessable from a bare list.
pub fn unknown_terminal_key_message(name: &str) -> String {
    let redundant = match name {
        "ctrl-m" => Some("enter"),
        "ctrl-i" => Some("tab"),
        "ctrl-[" | "ctrl-bracket" | "ctrl-left-bracket" => Some("escape"),
        _ => None,
    };
    match redundant {
        Some(replacement) => format!(
            "unknown key {name:?}: use {replacement:?}, which writes the same byte and declares \
             the correct composer meaning"
        ),
        None => format!(
            "unknown key {name:?}; accepted keys: {}",
            terminal_key_names().join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn key_names_are_unique() {
        let names = terminal_key_names();
        let unique = names.iter().collect::<HashSet<_>>();
        assert_eq!(names.len(), unique.len(), "duplicate key name: {names:?}");
    }

    #[test]
    fn every_key_writes_bytes() {
        for key in terminal_keys() {
            assert!(!key.bytes.is_empty(), "{} writes nothing", key.name);
        }
    }

    #[test]
    fn only_enter_declares_a_submission() {
        let submitting = terminal_keys()
            .filter(|key| key.class == TerminalKeyClass::Submission)
            .map(|key| key.name)
            .collect::<Vec<_>>();
        assert_eq!(submitting, vec!["enter"]);
    }

    #[test]
    fn incident_sequence_encodes_the_bytes_the_manager_sent_by_hand() {
        // The 2026-09-05 workspace-trust selection: Down, then Enter.
        assert_eq!(terminal_key("down").unwrap().bytes, &[27, 91, 66]);
        assert_eq!(terminal_key("enter").unwrap().bytes, &[13]);
        assert_eq!(
            terminal_key("enter").unwrap().class,
            TerminalKeyClass::Submission
        );
        assert_eq!(terminal_key("down").unwrap().class, TerminalKeyClass::Draft);
    }

    #[test]
    fn ctrl_letters_cover_the_alphabet_except_named_duplicates() {
        for letter in 'a'..='z' {
            let name = format!("ctrl-{letter}");
            let key = terminal_key(&name);
            if CTRL_LETTERS_WITH_NAMED_EQUIVALENTS.contains(&letter) {
                assert!(key.is_none(), "{name} should defer to its named key");
                continue;
            }
            let key = key.unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(
                key.bytes,
                &[(letter as u8) & 0x1f],
                "{name} must be the C0 control for {letter}"
            );
        }
    }

    #[test]
    fn redundant_spellings_are_rejected_with_their_replacement() {
        assert!(unknown_terminal_key_message("ctrl-m").contains("\"enter\""));
        assert!(unknown_terminal_key_message("ctrl-i").contains("\"tab\""));
        assert!(unknown_terminal_key_message("ctrl-[").contains("\"escape\""));
        assert!(unknown_terminal_key_message("wiggle").contains("accepted keys"));
    }

    #[test]
    fn no_draft_key_writes_a_carriage_return() {
        for key in terminal_keys().filter(|key| key.class == TerminalKeyClass::Draft) {
            assert!(
                !key.bytes.contains(&b'\r'),
                "{} writes CR without declaring a submission boundary",
                key.name
            );
        }
    }
}
