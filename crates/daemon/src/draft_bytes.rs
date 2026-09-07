//! Which producer-declared draft bytes can actually put text at a composer.
//!
//! The typed-byte ledger in [`crate::session`] answers one question: *could an
//! unsent line exist at this composer right now?* A message delivered from a
//! phone or a manager is withheld only when the answer may be yes, because
//! writing it would concatenate a sentence nobody wrote onto a human's
//! half-typed line.
//!
//! Counting every declared byte answered a different, wider question — *did a
//! producer touch this terminal?* — and the two are not the same. The desktop
//! declares every non-Enter keydown a draft, so opening a task's terminal and
//! pressing an arrow, Escape or PageUp armed the ledger, and every later
//! delivery was answered `logical_input_held_by_draft` with "a human has an
//! unsent line at that terminal" when nobody had typed anything. That is the
//! owner report of 2026-09-05: a queued-input banner on the phone with a
//! visibly empty composer on the desktop.
//!
//! So the ledger counts the bytes that can **create** composer content. Bytes
//! that only move, scroll, delete or abandon create none, and something that
//! creates nothing cannot create a draft.
//!
//! This is deliberately not the inference this crate refuses to make about
//! *submission*. Submission is a producer's declaration precisely because a
//! `\r` inside a paste is indistinguishable from a pressed Enter. Insertion is
//! not like that: a terminal line editor discards an escape sequence it does
//! not recognise, and the ones it does recognise here are measured below.
//! Everything unrecognised counts as content, so the unknown case holds.

/// Cursor-up and cursor-down are the exception that makes this safe.
///
/// They look like navigation and are not: in Claude Code and in every readline
/// shell they recall a previous line *into* the composer, which is exactly the
/// unsent line a delivered message must never be appended to. Attestation then
/// resolves the harmless case on its own — a recall with nothing to recall
/// leaves the composer rendering empty, and the hold clears on the next frame.
const CONTENT_CAPABLE_SEQUENCE_FINALS: [u8; 2] = [b'A', b'B'];

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const DEL: u8 = 0x7f;
const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
/// `ESC [ M` plus three raw coordinate bytes.
const X10_MOUSE_REPORT_LEN: usize = 6;

/// The escapes that carry a *string* payload: DCS, OSC, SOS, PM and APC.
///
/// No key produces one. They are how a terminal emulator answers the
/// application's own questions — XTVERSION, XTGETTCAP
/// and DECRQSS replies, and the OSC 10/11/4 colour reports Claude Code asks for
/// at startup and after every resize — and they travel back up the same PTY
/// input path a human's keystrokes use. The bytes between the introducer and
/// the terminator are payload, not characters typed at a composer, and counting
/// them armed the ledger with a draft nobody had written. That is the second
/// half of the 2026-09-05 report: a queued-input banner with no unsent line
/// under it, this time on a terminal nobody had even touched.
///
/// A producer that forwards its emulator's replies as declared draft bytes —
/// which the plain `Input` command and the KSP `TermInput` frame both do
/// unless the client marks them control — therefore declares nothing here.
const STRING_ESCAPE_INTRODUCERS: [u8; 5] = [b'P', b']', b'X', b'^', b'_'];

/// C0 controls that cannot put a character at the composer.
///
/// Every one of these either moves the cursor, deletes, redraws, or abandons
/// the line. Anything not listed — `TAB` (completion and Claude's
/// accept-suggestion both insert), `LF`/`CR` (a multiline composer's own
/// newline), `Ctrl-N`/`Ctrl-P` (history), `Ctrl-R` (reverse search),
/// `Ctrl-V`/`Ctrl-Q` (literal next), `Ctrl-Y` (yank) and every unassigned
/// control — counts as content, because the safe direction is to hold.
fn is_inert_control(byte: u8) -> bool {
    matches!(
        byte,
        0x00..=0x08 | 0x0b | 0x0c | 0x15 | 0x17 | 0x1a | 0x1c..=0x1f | DEL
    )
}

/// How far a terminated string escape starting at `data[0]` extends, or `None`
/// when this write contains no terminator for it.
///
/// The terminator is what makes the classification safe. `ESC ]` is also
/// Alt-`]`, and the desktop coalesces consecutive draft keydowns into one
/// write, so an Alt chord followed by typing would otherwise have its typed
/// characters swallowed as reply payload. A well-formed reply carries its own
/// `ST` (`ESC \`) or, for OSC, `BEL`; an Alt chord never does, and falls
/// through to the two-byte chord rule below.
fn string_escape_len(data: &[u8]) -> Option<usize> {
    let mut index = 2;
    while index < data.len() {
        if data[index] == BEL {
            return Some(index + 1);
        }
        if data[index] == ESC {
            return match data.get(index + 1) {
                Some(b'\\') => Some(index + 2),
                // A nested introducer cannot terminate the string; anything
                // else after `ESC` is not `ST` either, so keep scanning from
                // the byte after it rather than stopping on a false match.
                _ => None,
            };
        }
        index += 1;
    }
    None
}

/// How many bytes the escape sequence starting at `data[0]` occupies, and
/// whether it can create composer content.
///
/// A sequence truncated by the end of the write is consumed whole and counts
/// as inert: producers send one key per write, so a split sequence is not a
/// case that occurs, and consuming it stops a stray final byte from being read
/// as a printable character.
fn escape_sequence(data: &[u8]) -> (usize, bool) {
    debug_assert_eq!(data.first(), Some(&ESC));
    match data.get(1) {
        // CSI: parameter and intermediate bytes, then a final byte.
        Some(b'[') => {
            let final_index = data[2..]
                .iter()
                .position(|byte| (0x40..=0x7e).contains(byte))
                .map(|offset| offset + 2);
            match final_index {
                // X10 mouse encoding: `ESC [ M` is followed by three raw
                // coordinate bytes that are not characters. Consuming them
                // here keeps a click from reading as three typed ones.
                Some(2) if data[2] == b'M' => (X10_MOUSE_REPORT_LEN.min(data.len()), false),
                Some(index) => (
                    index + 1,
                    CONTENT_CAPABLE_SEQUENCE_FINALS.contains(&data[index]),
                ),
                None => (data.len(), false),
            }
        }
        // SS3: exactly one byte follows.
        Some(b'O') => match data.get(2) {
            Some(final_byte) => (3, CONTENT_CAPABLE_SEQUENCE_FINALS.contains(final_byte)),
            None => (data.len(), false),
        },
        // A terminal reply carrying a string payload — see
        // [`STRING_ESCAPE_INTRODUCERS`]. Consumed whole, payload included,
        // because none of it was typed.
        Some(introducer) if STRING_ESCAPE_INTRODUCERS.contains(introducer) => {
            match string_escape_len(data) {
                Some(len) => (len, false),
                None => (2, false),
            }
        }
        // An Alt chord. Meta-prefixed keys are command bindings, never
        // self-inserting; macOS Option keys that do compose a character arrive
        // as that character rather than as an escape prefix.
        Some(_) => (2, false),
        // A bare Escape. It abandons, so it creates nothing.
        None => (1, false),
    }
}

/// How many of these producer-declared draft bytes could put content at the
/// composer.
///
/// Zero is the whole point: a write that counts zero declares nothing, arms
/// nothing, and leaves a delivered message free to go out immediately.
pub fn draft_content_byte_count(data: &[u8]) -> u64 {
    let mut index = 0;
    let mut content: u64 = 0;
    while index < data.len() {
        let rest = &data[index..];
        // A bracketed paste is content by construction: the terminal hands
        // everything between the markers to the application as literal text.
        if rest.starts_with(PASTE_START) {
            index += PASTE_START.len();
            let payload = &data[index..];
            let end = payload
                .windows(PASTE_END.len())
                .position(|window| window == PASTE_END)
                .unwrap_or(payload.len());
            content += end as u64;
            index += end;
            index = (index + PASTE_END.len()).min(data.len());
            continue;
        }
        if rest[0] == ESC {
            let (consumed, content_capable) = escape_sequence(rest);
            if content_capable {
                content += consumed as u64;
            }
            index += consumed;
            continue;
        }
        if !is_inert_control(rest[0]) {
            content += 1;
        }
        index += 1;
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printable_text_is_content() {
        assert_eq!(draft_content_byte_count(b"hello"), 5);
        assert_eq!(draft_content_byte_count("héllo".as_bytes()), 6);
    }

    /// The owner's terminal: keys that leave nothing at the prompt.
    #[test]
    fn navigation_and_editing_keys_create_nothing() {
        for (name, bytes) in [
            ("cursor right", b"\x1b[C".as_slice()),
            ("cursor left", b"\x1b[D"),
            ("home", b"\x1b[H"),
            ("end", b"\x1b[F"),
            ("home (vt)", b"\x1b[1~"),
            ("end (vt)", b"\x1b[4~"),
            ("page up", b"\x1b[5~"),
            ("page down", b"\x1b[6~"),
            ("delete", b"\x1b[3~"),
            ("shift-tab", b"\x1b[Z"),
            ("f1", b"\x1bOP"),
            ("f5", b"\x1b[15~"),
            ("modified cursor right", b"\x1b[1;5C"),
            ("x10 mouse press", b"\x1b[M \x30\x30"),
            ("sgr mouse press", b"\x1b[<0;24;5M"),
            ("sgr mouse release", b"\x1b[<0;24;5m"),
            ("wheel up", b"\x1b[<64;24;5M"),
            ("focus in", b"\x1b[I"),
            ("focus out", b"\x1b[O"),
            ("bare escape", b"\x1b"),
            ("alt chord", b"\x1bb"),
            ("backspace", b"\x7f"),
            ("ctrl-h", b"\x08"),
            ("ctrl-a", b"\x01"),
            ("ctrl-e", b"\x05"),
            ("ctrl-c", b"\x03"),
            ("ctrl-u", b"\x15"),
            ("ctrl-w", b"\x17"),
            ("ctrl-k", b"\x0b"),
            ("ctrl-l", b"\x0c"),
        ] {
            assert_eq!(
                draft_content_byte_count(bytes),
                0,
                "{name} cannot put text at a composer"
            );
        }
    }

    /// History recall is not navigation. Up and down pull a previous line into
    /// the composer, so they must arm the ledger like typing does.
    #[test]
    fn history_recall_keys_are_content() {
        for bytes in [
            b"\x1b[A".as_slice(),
            b"\x1b[B",
            b"\x1bOA",
            b"\x1bOB",
            b"\x1b[1;5A",
            b"\x10",
            b"\x0e",
        ] {
            assert!(
                draft_content_byte_count(bytes) > 0,
                "{bytes:?} can recall a line into the composer"
            );
        }
    }

    /// A multiline composer's own newline, and the keys that insert.
    #[test]
    fn insertion_controls_are_content() {
        for bytes in [b"\r".as_slice(), b"\n", b"\t", b"\x16", b"\x19", b"\x12"] {
            assert!(draft_content_byte_count(bytes) > 0, "{bytes:?} inserts");
        }
    }

    /// The reply bytes an emulator writes back up the PTY input path when the
    /// application asks it something. Nobody typed any of them, and a producer
    /// that forwards them as declared draft bytes must declare nothing.
    #[test]
    fn terminal_replies_are_never_composer_content() {
        for (name, bytes) in [
            (
                "osc 11 background colour report",
                b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\".as_slice(),
            ),
            (
                "osc 10 foreground colour report",
                b"\x1b]10;rgb:c5c5/c8c8/c6c6\x07",
            ),
            ("osc 4 palette report", b"\x1b]4;1;rgb:cccc/6666/6666\x1b\\"),
            ("xtversion reply", b"\x1bP>|Ghostty 1.2.0\x1b\\"),
            ("xtgettcap reply", b"\x1bP1+r62656c=5C61\x1b\\"),
            ("decrqss reply", b"\x1bP1$r0m\x1b\\"),
            ("apc reply", b"\x1b_Gi=31;OK\x1b\\"),
            ("privacy message", b"\x1b^status\x1b\\"),
            ("start of string", b"\x1bXpayload\x1b\\"),
            ("primary device attributes", b"\x1b[?62;1;2;6;9;15;22c"),
            ("secondary device attributes", b"\x1b[>1;10;0c"),
            ("cursor position report", b"\x1b[41;3R"),
            ("device status report", b"\x1b[0n"),
            ("kitty keyboard flags report", b"\x1b[?1u"),
            ("text area size report", b"\x1b[8;81;260t"),
            ("colour scheme report", b"\x1b[?997;1n"),
            ("focus in", b"\x1b[I"),
            ("focus out", b"\x1b[O"),
        ] {
            assert_eq!(
                draft_content_byte_count(bytes),
                0,
                "{name} is a terminal reply, not a keystroke"
            );
        }
    }

    /// The whole poisoning burst as one write, the way a producer that batches
    /// its emulator's output would send it.
    #[test]
    fn a_burst_of_terminal_replies_declares_no_draft() {
        let burst = b"\x1b[?62;1;2;6;9;15;22c\x1b[>1;10;0c\x1bP>|Ghostty 1.2.0\x1b\\\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\\x1b]10;rgb:c5c5/c8c8/c6c6\x07\x1b[41;3R\x1b[I";
        assert_eq!(draft_content_byte_count(burst), 0);
    }

    /// `ESC ]` is also Alt-`]`, and the desktop coalesces consecutive draft
    /// keydowns into one write. An unterminated introducer is that chord, so
    /// the characters after it are still someone typing.
    #[test]
    fn an_unterminated_string_introducer_stays_an_alt_chord() {
        assert_eq!(draft_content_byte_count(b"\x1b]hello"), 5);
        assert_eq!(draft_content_byte_count(b"\x1bPtyped"), 5);
    }

    /// A reply followed by real typing in one write keeps the typing.
    #[test]
    fn typing_after_a_reply_in_the_same_write_still_counts() {
        assert_eq!(
            draft_content_byte_count(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\hi"),
            2
        );
    }

    #[test]
    fn a_bracketed_paste_payload_is_content() {
        assert_eq!(
            draft_content_byte_count(b"\x1b[200~pasted line\x1b[201~"),
            "pasted line".len() as u64
        );
    }

    /// An escape sequence inside a paste is literal text, not a key.
    #[test]
    fn escape_bytes_inside_a_paste_stay_content() {
        let pasted = b"\x1b[200~a\x1b[Cb\x1b[201~";
        assert_eq!(draft_content_byte_count(pasted), "a\x1b[Cb".len() as u64);
    }

    #[test]
    fn an_unterminated_paste_counts_its_remainder() {
        assert_eq!(draft_content_byte_count(b"\x1b[200~half"), 4);
    }

    /// Nothing here may read a final byte as a printable character.
    #[test]
    fn a_truncated_escape_sequence_is_consumed_whole() {
        assert_eq!(draft_content_byte_count(b"\x1b[1;5"), 0);
        assert_eq!(draft_content_byte_count(b"\x1bO"), 0);
    }

    #[test]
    fn a_mixed_write_counts_only_its_content() {
        assert_eq!(draft_content_byte_count(b"\x1b[Chi\x7f\x1b[D"), 2);
    }

    #[test]
    fn nothing_is_nothing() {
        assert_eq!(draft_content_byte_count(b""), 0);
    }
}
