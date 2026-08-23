//! Bounding a terminal snapshot for a remote viewer, and the state that makes
//! the rest of the buffer reachable without re-shipping it.
//!
//! The daemon hands kanna-server one serialized terminal — the visible screen
//! *plus* up to 10,000 rows of scrollback (`crates/daemon/src/session.rs`). On
//! a phone that is the wrong unit of transfer: `7a38cc18`'s frame inventory
//! measured 1.71 MiB base64 for a plain 10,000-row scrollback and 114.8 MiB for
//! a truecolor one, and a flaky link re-ships the whole thing on every
//! reconnect.
//!
//! This module holds the three pure pieces of the fix, so they can be tested
//! without a daemon or a socket:
//!
//! - [`TerminalWindow`] — the bounded snapshot actually sent, plus the older
//!   lines retained to serve later.
//! - [`TerminalHistory`] — those retained lines, served back in bounded chunks.
//! - [`OutputRing`] — live output recorded after a snapshot, so a reconnecting
//!   client can be replayed the bytes it missed instead of the whole terminal.
//!
//! ## What a "line" is here
//!
//! The Ghostty serializer separates rows with `\r\n` and writes *no* separator
//! between a wrapped row and its continuation
//! (`ghostty-xterm-compat-serialize`, `row_end`). Splitting on `\r\n` therefore
//! yields logical lines, which is the right unit for both a scrollback window
//! and a scrollback chunk: rejoining consecutive pieces with `\r\n` reproduces
//! the original byte-for-byte.

use std::collections::VecDeque;
use std::sync::Arc;

/// Rows of scrollback kept above the visible screen in the initial snapshot.
///
/// Sized to render instantly on a poor link rather than to be complete: 400
/// plain lines is tens of KiB, an order of magnitude below the ~225 KB–977 KB
/// full snapshots observed on real sessions
/// (`docs/2026-08-15-long-lived-codex-terminal-fidelity-diagnosis.md`).
/// Everything older is one scroll gesture away.
pub(crate) const TERMINAL_WINDOW_SCROLLBACK_LINES: usize = 400;

/// Hard ceiling on the window, whatever its line count.
///
/// Styled content has no per-line size bound — a truecolor row is ~20x a plain
/// one — so the line budget alone cannot bound the frame. The visible screen is
/// never trimmed below `rows` lines, so a pathological per-cell-truecolor
/// viewport can still exceed this; that floor is the terminal itself, not
/// scrollback, and there is nothing smaller that is still correct.
pub(crate) const TERMINAL_WINDOW_MAX_BYTES: usize = 256 * 1024;

/// Older scrollback retained server-side per snapshot to answer
/// `term_scrollback_request`. Bounds what one attached session costs in memory.
pub(crate) const TERMINAL_HISTORY_RETENTION_BYTES: usize = 1024 * 1024;

/// Per-request scrollback bounds. A client walks its history downward one
/// bounded chunk at a time rather than pulling the retained buffer in one go.
pub(crate) const TERMINAL_SCROLLBACK_CHUNK_MAX_BYTES: usize = 64 * 1024;
pub(crate) const TERMINAL_SCROLLBACK_CHUNK_MAX_LINES: usize = 500;

/// Live output recorded after the current snapshot, so a client that drops its
/// socket can be replayed the gap. Sized for a link outage of a minute or two
/// of ordinary agent output, not for a `cat` of a large file — past this the
/// client gets a bounded fresh snapshot instead.
pub(crate) const TERMINAL_RING_MAX_BYTES: usize = 512 * 1024;

/// Where the serializer switches to the alternate screen. Everything from here
/// on is one indivisible segment: cutting through it would replay alt-screen
/// content onto the primary screen.
const ALT_SCREEN_ENTER: &str = "\x1b[?1049h";

/// Written in front of a window or chunk that starts mid-buffer. The
/// serializer emits SGR *diffs*, so a fragment inherits the style of content it
/// no longer carries; resetting first makes the fragment deterministic instead
/// of dependent on what was dropped.
const FRAGMENT_STYLE_RESET: &str = "\x1b[0m";

/// A bounded snapshot plus what was left out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalWindow {
    /// The VT text to send: the visible screen plus recent scrollback.
    pub(crate) window: String,
    /// Lines older than `window`, oldest first, bounded by
    /// [`TERMINAL_HISTORY_RETENTION_BYTES`].
    pub(crate) history: Vec<String>,
    /// Whether anything at all was dropped from the serialized terminal —
    /// including history evicted past the retention budget, which `history`
    /// alone cannot show.
    pub(crate) truncated: bool,
}

/// Split a serialized terminal into the window to send and the scrollback to
/// retain. `rows` is the terminal's visible height, which is never trimmed.
pub(crate) fn window_snapshot(vt: &str, rows: u16) -> TerminalWindow {
    window_snapshot_with_limits(
        vt,
        rows,
        TERMINAL_WINDOW_SCROLLBACK_LINES,
        TERMINAL_WINDOW_MAX_BYTES,
        TERMINAL_HISTORY_RETENTION_BYTES,
    )
}

pub(crate) fn window_snapshot_with_limits(
    vt: &str,
    rows: u16,
    scrollback_lines: usize,
    max_window_bytes: usize,
    retention_bytes: usize,
) -> TerminalWindow {
    // The alternate-screen segment is kept whole; only the primary-screen
    // prefix in front of it is windowed.
    let boundary = vt.rfind(ALT_SCREEN_ENTER).unwrap_or(vt.len());
    let (prefix, suffix) = vt.split_at(boundary);
    let pieces: Vec<&str> = prefix.split("\r\n").collect();

    let visible = usize::from(rows).max(1);
    let budget = visible.saturating_add(scrollback_lines);
    let mut first_kept = pieces.len().saturating_sub(budget);

    // Byte ceiling, applied after the line budget. Never trims below the
    // visible screen.
    let floor = pieces.len().saturating_sub(visible);
    let mut window_bytes = window_len(&pieces[first_kept..], suffix);
    while window_bytes > max_window_bytes && first_kept < floor {
        window_bytes -= pieces[first_kept].len() + "\r\n".len();
        first_kept += 1;
    }

    let mut history: Vec<String> = pieces[..first_kept]
        .iter()
        .map(|line| (*line).to_string())
        .collect();
    let evicted = retain_history(&mut history, retention_bytes);

    let mut window = String::with_capacity(window_bytes + FRAGMENT_STYLE_RESET.len());
    if first_kept > 0 {
        window.push_str(FRAGMENT_STYLE_RESET);
    }
    window.push_str(&pieces[first_kept..].join("\r\n"));
    window.push_str(suffix);

    TerminalWindow {
        window,
        history,
        truncated: first_kept > 0 || evicted,
    }
}

fn window_len(pieces: &[&str], suffix: &str) -> usize {
    let separators = pieces.len().saturating_sub(1) * "\r\n".len();
    pieces.iter().map(|piece| piece.len()).sum::<usize>() + separators + suffix.len()
}

/// Drop the oldest retained lines until the history fits its budget. Returns
/// whether anything was dropped.
fn retain_history(history: &mut Vec<String>, retention_bytes: usize) -> bool {
    let mut bytes: usize = history.iter().map(|line| line.len() + 2).sum();
    if bytes <= retention_bytes {
        return false;
    }
    let mut dropped = 0usize;
    while bytes > retention_bytes && dropped < history.len() {
        bytes -= history[dropped].len() + 2;
        dropped += 1;
    }
    history.drain(..dropped);
    true
}

/// Appended to carried-over history so it cannot leak terminal state into the
/// session it is seeded under. The serializer emits SGR *diffs* plus a trailing
/// mode suffix (`ghostty-xterm-compat-serialize::serialize_terminal`); this
/// resets every mode that suffix can set, so the replacement agent starts from
/// the same terminal state it would have had without the seed.
const CARRYOVER_MODE_RESET: &str = concat!(
    "\x1b[0m",     // SGR reset — the serializer emits style diffs
    "\x1b[?6l",    // origin mode off
    "\x1b[?1l",    // application cursor keys off
    "\x1b[?7h",    // autowrap on
    "\x1b[?45l",   // reverse-wrap off
    "\x1b[?66l",   // application keypad off
    "\x1b[?69l",   // left/right margins off
    "\x1b[r",      // scrolling region reset
    "\x1b[4l",     // insert mode off
    "\x1b[?2004l", // bracketed paste off
    "\x1b[?1004l", // focus reporting off
    "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l", // mouse reporting off
    "\x1b[?25h",   // cursor visible
);

/// Flatten a serialized terminal into history that can be seeded under a
/// replacement session's terminal, so a stage transition carries the previous
/// session's primary-screen scrollback instead of discarding it.
///
/// The alternate-screen segment is dropped, not flattened: it is the TUI's
/// transient frame, its cursor addressing is only valid on the alt screen, and
/// replaying it would hand the replacement session an active alt screen. What
/// carries over is everything the previous session printed on the primary
/// screen — setup output and any earlier carried-over history included.
/// Dropping the segment also drops the serializer's trailing mode suffix; the
/// no-alt shape keeps it inline, which is why [`CARRYOVER_MODE_RESET`] is
/// appended either way.
///
/// Returns `None` when the primary screen holds nothing worth carrying.
pub(crate) fn carryover_history_vt(vt: &str) -> Option<String> {
    let primary = match vt.rfind(ALT_SCREEN_ENTER) {
        Some(boundary) => &vt[..boundary],
        None => vt,
    };
    if !has_renderable_text(primary) {
        return None;
    }
    Some(format!("{primary}{CARRYOVER_MODE_RESET}"))
}

/// Build the snapshot seeded under a stage transition's replacement session
/// from the outgoing session's snapshot, or `None` when there is nothing worth
/// carrying.
///
/// The cursor is pinned so the replacement's first output lands below the
/// carried history instead of overwriting it:
/// - when an alt-screen segment was dropped, the snapshot's cursor described
///   the alt screen and is meaningless on the primary one — pin to the bottom
///   row, whose worst case is a blank gap, never clobbered history;
/// - otherwise the snapshot's cursor is the real primary-screen cursor, and
///   keeping it continues output exactly where the previous session stopped.
pub(crate) fn carryover_seed_snapshot(
    snapshot: &kanna_daemon::protocol::TerminalSnapshot,
) -> Option<kanna_daemon::protocol::TerminalSnapshot> {
    let vt = carryover_history_vt(&snapshot.vt)?;
    let dropped_alt_segment = snapshot.vt.contains(ALT_SCREEN_ENTER);
    let (cursor_row, cursor_col) = if dropped_alt_segment {
        (snapshot.rows.saturating_sub(1), 0)
    } else {
        (snapshot.cursor_row, snapshot.cursor_col)
    };
    Some(kanna_daemon::protocol::TerminalSnapshot {
        version: 1,
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row,
        cursor_col,
        cursor_visible: true,
        saved_at: snapshot.saved_at,
        sequence: snapshot.sequence,
        vt,
    })
}

/// Whether a VT fragment renders any non-whitespace text — escape sequences
/// alone (styling, cursor movement, modes) are not content.
fn has_renderable_text(vt: &str) -> bool {
    let mut chars = vt.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            if !ch.is_whitespace() && !ch.is_control() {
                return true;
            }
            continue;
        }
        match chars.next() {
            // CSI: parameter/intermediate bytes, then one final byte in @..=~.
            Some('[') => {
                for terminator in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&terminator) {
                        break;
                    }
                }
            }
            // OSC: consume through BEL or ESC \ (ST).
            Some(']') => {
                while let Some(body) = chars.next() {
                    if body == '\x07' {
                        break;
                    }
                    if body == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-byte escapes (ESC 7, ESC =, ESC c, …): already consumed.
            Some(_) | None => {}
        }
    }
    false
}

/// Scrollback older than a sent window, addressed by line index from its oldest
/// retained line.
#[derive(Debug, Default)]
pub(crate) struct TerminalHistory {
    lines: Vec<String>,
}

/// One bounded answer to a scrollback request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistoryChunk {
    pub(crate) start_line: u32,
    pub(crate) end_line: u32,
    /// VT text to prepend above what the client already holds.
    pub(crate) data: String,
    /// Retained lines still older than `start_line`.
    pub(crate) remaining_lines: u32,
}

impl TerminalHistory {
    pub(crate) fn new(lines: Vec<String>) -> Self {
        Self { lines }
    }

    pub(crate) fn len(&self) -> usize {
        self.lines.len()
    }

    /// The newest retained lines below `before_line`, bounded by both
    /// `max_lines` and [`TERMINAL_SCROLLBACK_CHUNK_MAX_BYTES`].
    pub(crate) fn chunk(&self, before_line: usize, max_lines: usize) -> HistoryChunk {
        self.chunk_with_limits(
            before_line,
            max_lines,
            TERMINAL_SCROLLBACK_CHUNK_MAX_BYTES,
            TERMINAL_SCROLLBACK_CHUNK_MAX_LINES,
        )
    }

    pub(crate) fn chunk_with_limits(
        &self,
        before_line: usize,
        max_lines: usize,
        max_bytes: usize,
        max_lines_ceiling: usize,
    ) -> HistoryChunk {
        let end = before_line.min(self.lines.len());
        let requested = max_lines.clamp(1, max_lines_ceiling.max(1));
        let line_floor = end.saturating_sub(requested);

        let mut start = end;
        let mut bytes = 0usize;
        while start > line_floor {
            let candidate = self.lines[start - 1].len() + "\r\n".len();
            if start < end && bytes + candidate > max_bytes {
                break;
            }
            bytes += candidate;
            start -= 1;
        }

        let mut data = String::with_capacity(bytes + FRAGMENT_STYLE_RESET.len());
        if start < end {
            data.push_str(FRAGMENT_STYLE_RESET);
            for line in &self.lines[start..end] {
                data.push_str(line);
                data.push_str("\r\n");
            }
        }

        HistoryChunk {
            start_line: start as u32,
            end_line: end as u32,
            data,
            remaining_lines: start as u32,
        }
    }
}

/// Live output recorded after a snapshot, addressed by a monotonic byte offset.
///
/// The offset is the client's resume position: it never travels on the wire per
/// frame, because a client can add each `term_output` frame's own decoded
/// length to it.
#[derive(Debug)]
pub(crate) struct OutputRing {
    chunks: VecDeque<Arc<[u8]>>,
    bytes: usize,
    capacity: usize,
    start_offset: u64,
    end_offset: u64,
}

impl OutputRing {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            capacity,
            start_offset: 0,
            end_offset: 0,
        }
    }

    /// Discard everything and re-anchor at `offset`. Used when a fresh snapshot
    /// makes every recorded byte redundant.
    pub(crate) fn reset_to(&mut self, offset: u64) {
        self.chunks.clear();
        self.bytes = 0;
        self.start_offset = offset;
        self.end_offset = offset;
    }

    pub(crate) fn push(&mut self, data: Arc<[u8]>) {
        if data.is_empty() {
            return;
        }
        self.end_offset += data.len() as u64;
        self.bytes += data.len();
        self.chunks.push_back(data);
        while self.bytes > self.capacity {
            let Some(evicted) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= evicted.len();
            self.start_offset += evicted.len() as u64;
        }
    }

    #[cfg(test)]
    pub(crate) fn start_offset(&self) -> u64 {
        self.start_offset
    }

    pub(crate) fn end_offset(&self) -> u64 {
        self.end_offset
    }

    /// Bytes from `offset` onward, or `None` when the ring can no longer answer
    /// — the caller must send a bounded fresh snapshot instead.
    pub(crate) fn replay_from(&self, offset: u64) -> Option<Vec<Arc<[u8]>>> {
        if offset > self.end_offset || offset < self.start_offset {
            return None;
        }
        let mut position = self.start_offset;
        let mut replay = Vec::new();
        for chunk in &self.chunks {
            let chunk_end = position + chunk.len() as u64;
            if chunk_end <= offset {
                position = chunk_end;
                continue;
            }
            if position >= offset {
                replay.push(Arc::clone(chunk));
            } else {
                let skip = (offset - position) as usize;
                replay.push(Arc::from(&chunk[skip..]));
            }
            position = chunk_end;
        }
        Some(replay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(count: usize, prefix: &str) -> String {
        (0..count)
            .map(|index| format!("{prefix}{index}"))
            .collect::<Vec<_>>()
            .join("\r\n")
    }

    #[test]
    fn short_snapshot_is_sent_whole() {
        let vt = lines(10, "row-");
        let windowed = window_snapshot(&vt, 24);
        assert_eq!(windowed.window, vt);
        assert!(windowed.history.is_empty());
        assert!(!windowed.truncated);
    }

    #[test]
    fn window_keeps_the_screen_and_recent_scrollback_only() {
        let vt = lines(5_000, "row-");
        let windowed =
            window_snapshot_with_limits(&vt, 24, 400, TERMINAL_WINDOW_MAX_BYTES, 1 << 20);

        assert!(windowed.truncated);
        let kept: Vec<&str> = windowed
            .window
            .trim_start_matches(FRAGMENT_STYLE_RESET)
            .split("\r\n")
            .collect();
        assert_eq!(kept.len(), 424);
        assert_eq!(kept[0], "row-4576");
        assert_eq!(kept[kept.len() - 1], "row-4999");
        assert_eq!(windowed.history.len(), 4_576);
        assert_eq!(windowed.history[0], "row-0");
        assert_eq!(windowed.history[4_575], "row-4575");

        // The window plus its history is the original, byte for byte.
        let mut rebuilt = windowed.history.join("\r\n");
        rebuilt.push_str("\r\n");
        rebuilt.push_str(windowed.window.trim_start_matches(FRAGMENT_STYLE_RESET));
        assert_eq!(rebuilt, vt);
    }

    #[test]
    fn byte_ceiling_trims_further_than_the_line_budget() {
        let wide = "x".repeat(4_000);
        let vt = (0..300)
            .map(|index| format!("{index}{wide}"))
            .collect::<Vec<_>>()
            .join("\r\n");

        let windowed = window_snapshot_with_limits(&vt, 10, 400, 64 * 1024, 1 << 20);
        let kept = windowed
            .window
            .trim_start_matches(FRAGMENT_STYLE_RESET)
            .split("\r\n")
            .count();
        assert!(kept >= 10, "the visible screen is never trimmed away");
        assert!(
            windowed.window.len() <= 64 * 1024 + FRAGMENT_STYLE_RESET.len(),
            "window {} exceeded the byte ceiling",
            windowed.window.len()
        );
        // Retention is its own budget: the history holds what it can of the
        // 300 - kept lines the window left behind.
        assert!(windowed.history.len() <= 300 - kept);
        let retained: usize = windowed.history.iter().map(|line| line.len() + 2).sum();
        assert!(retained <= 1 << 20);
    }

    #[test]
    fn visible_screen_survives_a_byte_ceiling_it_cannot_meet() {
        let wide = "x".repeat(10_000);
        let vt = (0..40)
            .map(|index| format!("{index}{wide}"))
            .collect::<Vec<_>>()
            .join("\r\n");

        let windowed = window_snapshot_with_limits(&vt, 24, 400, 1024, 1 << 20);
        let kept = windowed
            .window
            .trim_start_matches(FRAGMENT_STYLE_RESET)
            .split("\r\n")
            .count();
        assert_eq!(kept, 24);
    }

    #[test]
    fn alternate_screen_segment_is_never_cut_through() {
        let scrollback = lines(2_000, "old-");
        let alt = format!("{ALT_SCREEN_ENTER}\x1b[H{}", lines(30, "alt-"));
        let vt = format!("{scrollback}\r\n{alt}");

        let windowed = window_snapshot_with_limits(&vt, 24, 10, 512, 1 << 20);
        assert!(windowed.truncated);
        assert!(
            windowed.window.contains(ALT_SCREEN_ENTER),
            "the alt-screen switch must survive windowing"
        );
        assert!(windowed.window.ends_with("alt-29"));
        assert!(!windowed.history.iter().any(|line| line.contains("alt-")));
    }

    #[test]
    fn carryover_drops_the_alt_screen_segment_and_its_mode_suffix() {
        let primary = "setup: pnpm install\r\ndone";
        let vt = format!(
            "{primary}\x1b[0m{ALT_SCREEN_ENTER}\x1b[H\x1b[2Jclaude tui frame\x1b[?1002h\x1b[?1006h"
        );

        let carried = carryover_history_vt(&vt).expect("primary content must carry over");
        assert!(carried.starts_with(primary));
        assert!(!carried.contains(ALT_SCREEN_ENTER));
        assert!(!carried.contains("claude tui frame"));
        // The serializer's mouse-mode suffix sat after the alt segment; the
        // carryover must end with the sanitize suffix instead.
        assert!(!carried.contains("\x1b[?1002h"));
        assert!(carried.ends_with(CARRYOVER_MODE_RESET));
    }

    #[test]
    fn carryover_without_an_alt_segment_keeps_the_whole_vt_and_resets_modes() {
        let vt = "codex output\r\nmore output\x1b[?2004h\x1b[?1000h";

        let carried = carryover_history_vt(vt).expect("primary content must carry over");
        assert!(carried.starts_with(vt));
        assert!(carried.ends_with(CARRYOVER_MODE_RESET));
        // The inline suffix survives, but the sanitize suffix after it turns
        // every mode back off.
        let paste_on = carried.find("\x1b[?2004h").unwrap();
        let paste_off = carried.find("\x1b[?2004l").unwrap();
        assert!(paste_off > paste_on);
    }

    #[test]
    fn carryover_of_a_contentless_terminal_is_none() {
        assert_eq!(carryover_history_vt(""), None);
        // Escape sequences, whitespace, and an OSC title are not content.
        assert_eq!(
            carryover_history_vt("\x1b[0m\x1b[2J\x1b[H  \r\n\t\x1b]0;title\x07\x1b[?2004h"),
            None
        );
        // A terminal that only ever drew an alt-screen TUI carries nothing.
        assert_eq!(
            carryover_history_vt(&format!("\x1b[0m{ALT_SCREEN_ENTER}\x1b[Htui")),
            None
        );
    }

    #[test]
    fn carried_history_survives_a_replacement_terminal_round_trip() {
        use kanna_daemon::headless_terminal::HeadlessTerminal;

        // The outgoing session: setup output on the primary screen, then a
        // Claude-shaped TUI takes the alternate screen with mouse reporting on.
        let mut outgoing = HeadlessTerminal::new(80, 24, 1_000).unwrap();
        outgoing.write(b"Running startup script...\r\n$ pnpm install\r\nadded 120 packages\r\n");
        outgoing
            .write(b"\x1b[?2004h\x1b[?1049h\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006hCLAUDE TUI FRAME");
        let snapshot = outgoing.snapshot().unwrap();
        assert!(snapshot.vt.contains("CLAUDE TUI FRAME"));

        // The stage transition seeds the flattened history under the
        // replacement session, whose prelude marker and new output follow.
        let seed = carryover_seed_snapshot(&snapshot).expect("setup output must carry over");
        let mut replacement = HeadlessTerminal::from_snapshot(&seed, 1_000).unwrap();
        replacement.write(
            "\r\n\x1b[2m\u{2501}\u{2501} Stage advanced: in progress \u{2192} review \u{2501}\u{2501}\x1b[0m\r\n"
                .as_bytes(),
        );
        replacement.write(b"review agent starting\r\n");

        let vt = replacement.snapshot().unwrap().vt;
        let setup = vt.find("added 120 packages").expect("setup output kept");
        let marker = vt.find("Stage advanced").expect("stage marker kept");
        let review = vt.find("review agent starting").expect("new output kept");
        assert!(
            setup < marker && marker < review,
            "history stays above the new stage"
        );
        assert!(!vt.contains("CLAUDE TUI FRAME"));
        // The dropped TUI's modes must not leak into the replacement terminal.
        assert!(!vt.contains("\x1b[?1049h"));
        assert!(!vt.contains("\x1b[?1002h"));
        assert!(!vt.contains("\x1b[?2004h"));
    }

    #[test]
    fn renderable_text_scanner_sees_through_escapes_but_not_past_content() {
        assert!(has_renderable_text("\x1b[31mx"));
        assert!(has_renderable_text("plain"));
        assert!(!has_renderable_text("\x1b[31m\x1b[H"));
        assert!(!has_renderable_text("\x1b]0;a window title\x1b\\"));
        assert!(has_renderable_text("\x1b]0;title\x07real output"));
    }

    #[test]
    fn retention_budget_evicts_the_oldest_history() {
        let vt = lines(5_000, "row-");
        let windowed = window_snapshot_with_limits(&vt, 24, 10, TERMINAL_WINDOW_MAX_BYTES, 1_000);
        let retained: usize = windowed.history.iter().map(|line| line.len() + 2).sum();
        assert!(retained <= 1_000);
        assert!(windowed.truncated);
        // Eviction takes the oldest, so the newest retained line still abuts
        // the window.
        assert_eq!(windowed.history.last().unwrap(), "row-4965");
    }

    #[test]
    fn history_chunks_walk_downward_and_run_out() {
        let history = TerminalHistory::new(
            (0..1_000)
                .map(|index| format!("row-{index}"))
                .collect::<Vec<_>>(),
        );

        let first = history.chunk(1_000, 100);
        assert_eq!((first.start_line, first.end_line), (900, 1_000));
        assert_eq!(first.remaining_lines, 900);
        assert!(first.data.starts_with(FRAGMENT_STYLE_RESET));
        assert!(first.data.contains("row-900\r\n"));
        assert!(first.data.ends_with("row-999\r\n"));

        let second = history.chunk(first.start_line as usize, 100);
        assert_eq!((second.start_line, second.end_line), (800, 900));

        let exhausted = history.chunk(0, 100);
        assert_eq!((exhausted.start_line, exhausted.end_line), (0, 0));
        assert_eq!(exhausted.remaining_lines, 0);
        assert!(exhausted.data.is_empty());
    }

    #[test]
    fn history_chunk_is_byte_bounded_and_always_makes_progress() {
        let wide = "y".repeat(5_000);
        let history = TerminalHistory::new((0..100).map(|_| wide.clone()).collect::<Vec<_>>());

        let chunk = history.chunk_with_limits(100, 100, 8_000, 500);
        assert_eq!(chunk.end_line - chunk.start_line, 1);
        assert!(chunk.data.len() < 8_000 + FRAGMENT_STYLE_RESET.len() + 2);

        // A single line larger than the byte budget is still delivered, or the
        // client could never walk past it.
        let huge = TerminalHistory::new(vec!["z".repeat(100_000)]);
        let chunk = huge.chunk_with_limits(1, 10, 1_000, 500);
        assert_eq!((chunk.start_line, chunk.end_line), (0, 1));
        assert!(chunk.data.len() > 100_000);
    }

    #[test]
    fn ring_replays_only_the_delta() {
        let mut ring = OutputRing::new(1_000);
        ring.push(Arc::from(&b"hello "[..]));
        ring.push(Arc::from(&b"world"[..]));
        assert_eq!(ring.end_offset(), 11);

        let replay = ring.replay_from(6).expect("offset inside the ring");
        assert_eq!(replay.len(), 1);
        assert_eq!(&*replay[0], b"world");

        let mid_chunk = ring.replay_from(3).expect("offset inside a chunk");
        assert_eq!(&*mid_chunk[0], b"lo ");
        assert_eq!(&*mid_chunk[1], b"world");

        assert!(ring.replay_from(11).expect("caught up").is_empty());
        assert!(ring.replay_from(12).is_none(), "an impossible offset");
    }

    #[test]
    fn ring_eviction_makes_old_offsets_unreplayable() {
        let mut ring = OutputRing::new(16);
        for index in 0..10u8 {
            ring.push(Arc::from(&[index; 4][..]));
        }
        assert_eq!(ring.end_offset(), 40);
        assert_eq!(ring.start_offset(), 24);
        assert!(ring.replay_from(0).is_none());
        let replay = ring.replay_from(32).expect("recent offset");
        assert_eq!(replay.iter().map(|chunk| chunk.len()).sum::<usize>(), 8);
    }

    #[test]
    fn ring_reset_re_anchors_at_a_fresh_snapshot() {
        let mut ring = OutputRing::new(1_000);
        ring.push(Arc::from(&b"abc"[..]));
        ring.reset_to(ring.end_offset());
        assert_eq!(ring.start_offset(), 3);
        assert!(ring.replay_from(3).expect("at the anchor").is_empty());
        assert!(ring.replay_from(0).is_none());
    }
}
