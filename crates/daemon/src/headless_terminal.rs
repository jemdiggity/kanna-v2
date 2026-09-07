//! The daemon's headless terminal: a VT emulator that renders a session's PTY
//! output with no window attached.
//!
//! This file renders. It deliberately does **not** decide what a frame means:
//! the patterns that answer "is this session busy, waiting or parked?" live in
//! [`crate::detection`], as version-resolved data rather than constants in the
//! binary. What is left here is the rendering the classifier reads — the
//! grid, the terminal title, and the progress reports the session emitted —
//! plus the snapshot machinery reconnection and handoff are built on.

use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use ghostty_xterm_compat_serialize::serialize_terminal;
use libghostty_vt::{
    render::{CellIterator, RenderState, RowIterator},
    screen::CellWide,
    terminal::Mode,
    Terminal, TerminalOptions,
};

use crate::detection::progress::ProgressScanner;
use crate::detection::schema::ProgressState;
use crate::detection::{Classifier, Evidence, Verdict};
use crate::protocol::{AgentProvider, SessionStatus, TerminalSnapshot};

#[allow(unused_imports)]
pub use crate::detection::classify::{bound_waiting_prompt, ComposerState};

use crate::detection::classify::starts_with_glyph;

type HeadlessTerminalResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

// Ghostty's C API names this "max_scrollback", but it is a byte budget, not a
// row count. Budget against the full grid so 10K logical rows survive snapshot.
const GHOSTTY_SCROLLBACK_BYTES_PER_CELL: usize = 20;

/// One reading of the composer row's *cells*, with the styling and cursor the
/// provider painted them with.
///
/// The line-text reads elsewhere in this file normalise whitespace and throw
/// styling away, which is right for classifying chrome and wrong for the two
/// questions here: whether the provider painted this line as its own
/// suggestion, and what exactly a human has typed on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerRow {
    /// The rendered text after the prompt glyph and its separator cell, with
    /// the row's trailing blank cells dropped. Interior spacing is untouched.
    pub text: String,
    /// Whether every non-blank cell of `text` is painted faint (SGR 2).
    pub all_faint: bool,
    /// The text between the start of the composer and the cursor, when the
    /// cursor is on this row at or after that start. `None` otherwise.
    pub before_cursor: Option<String>,
    /// Whether the cursor sits where a composer holding no typed text puts it:
    /// at the very start, with the whole line still to its right.
    pub cursor_at_start: bool,
    /// Whether every cell from the cursor to the end of the row is blank —
    /// the cursor is after everything rendered, so `before_cursor` is the
    /// whole line.
    pub cursor_at_end: bool,
}

pub fn initial_session_status(provider: Option<AgentProvider>) -> SessionStatus {
    if provider.is_some() {
        SessionStatus::Busy
    } else {
        SessionStatus::Idle
    }
}

pub struct HeadlessTerminal {
    terminal: Box<Terminal<'static, 'static>>,
    render_state: RenderState<'static>,
    row_iterator: RowIterator<'static>,
    cell_iterator: CellIterator<'static>,
    pty_writes: Rc<RefCell<Vec<Vec<u8>>>>,
    /// Out-of-band progress the session reported with OSC 9. Scanned from the
    /// byte stream rather than read off the grid, because that is the point of
    /// the channel: it survives a repaint that leaves the grid unreadable.
    progress: ProgressScanner,
    rows: u16,
    cols: u16,
    /// Whether this session has already reported a provider footer its rules
    /// cannot classify. The warning is the canary for the next vocabulary
    /// change and is worth exactly one line per session, not one per frame.
    warned_unclassified_footer: bool,
}

unsafe impl Send for HeadlessTerminal {}

#[allow(dead_code)]
pub struct TerminalSnapshotWithMetadata {
    pub snapshot: TerminalSnapshot,
    pub used_visible_text_fallback: bool,
}

impl HeadlessTerminal {
    fn normalize_dimensions(cols: u16, rows: u16) -> (u16, u16) {
        let normalized_cols = if cols == 0 { 80 } else { cols };
        let normalized_rows = if rows == 0 { 24 } else { rows };
        (normalized_cols, normalized_rows)
    }

    fn restore_vt(snapshot: &TerminalSnapshot) -> String {
        format!(
            "{}{}\x1b[{};{}H",
            snapshot.vt,
            if snapshot.cursor_visible {
                "\x1b[?25h"
            } else {
                "\x1b[?25l"
            },
            u32::from(snapshot.cursor_row) + 1,
            u32::from(snapshot.cursor_col) + 1,
        )
    }

    pub fn new(cols: u16, rows: u16, scrollback: usize) -> HeadlessTerminalResult<Self> {
        let pty_writes = Rc::new(RefCell::new(Vec::new()));
        let mut terminal = Box::new(Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: scrollback_byte_limit(cols, rows, scrollback),
        })?);
        let render_state = RenderState::new()?;
        let row_iterator = RowIterator::new()?;
        let cell_iterator = CellIterator::new()?;
        terminal.on_pty_write({
            let pty_writes = Rc::clone(&pty_writes);
            move |_terminal, data| {
                pty_writes.borrow_mut().push(data.to_vec());
            }
        })?;

        Ok(Self {
            terminal,
            render_state,
            row_iterator,
            cell_iterator,
            pty_writes,
            progress: ProgressScanner::new(),
            rows,
            cols,
            warned_unclassified_footer: false,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
        self.progress.write(bytes);
    }

    pub fn bracketed_paste_mode(&self) -> bool {
        self.terminal.mode(Mode::BRACKETED_PASTE).unwrap_or(false)
    }

    pub fn drain_pty_writes(&mut self) -> Vec<Vec<u8>> {
        self.pty_writes.borrow_mut().drain(..).collect()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> HeadlessTerminalResult<()> {
        self.terminal.resize(cols, rows, 1, 1)?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn snapshot(&mut self) -> HeadlessTerminalResult<TerminalSnapshot> {
        Ok(self.snapshot_with_metadata()?.snapshot)
    }

    pub fn snapshot_with_metadata(
        &mut self,
    ) -> HeadlessTerminalResult<TerminalSnapshotWithMetadata> {
        let had_synchronized_output = self.terminal.mode(Mode::SYNC_OUTPUT).unwrap_or(false);
        if had_synchronized_output {
            self.terminal.set_mode(Mode::SYNC_OUTPUT, false)?;
        }
        let mut used_visible_text_fallback = false;
        let vt = match serialize_terminal(&self.terminal, None) {
            Ok(snapshot) => snapshot.serialized_candidate,
            Err(error) => {
                log::warn!(
                    "[headless-terminal] failed to serialize terminal snapshot, falling back to visible text: {}",
                    error
                );
                used_visible_text_fallback = true;
                self.visible_text_vt(usize::from(self.rows))?
            }
        };
        if had_synchronized_output {
            self.terminal.set_mode(Mode::SYNC_OUTPUT, true)?;
        }

        Ok(TerminalSnapshotWithMetadata {
            snapshot: TerminalSnapshot {
                version: 1,
                rows: self.rows,
                cols: self.cols,
                cursor_row: self.terminal.cursor_y().unwrap_or(0),
                cursor_col: self.terminal.cursor_x().unwrap_or(0),
                cursor_visible: self.terminal.is_cursor_visible().unwrap_or(true),
                saved_at: 0,
                sequence: 0,
                vt,
            },
            used_visible_text_fallback,
        })
    }

    fn visible_text_vt(&mut self, rows: usize) -> HeadlessTerminalResult<String> {
        let lines = self.visible_footer_lines(rows)?;
        if lines.is_empty() {
            return Ok(String::new());
        }
        Ok(lines.join("\r\n"))
    }

    fn visible_footer_lines(&mut self, rows: usize) -> HeadlessTerminalResult<Vec<String>> {
        self.visible_footer_lines_with_policy(rows, false)
    }

    fn visible_footer_lines_with_blank_boundaries(
        &mut self,
        rows: usize,
    ) -> HeadlessTerminalResult<Vec<String>> {
        self.visible_footer_lines_with_policy(rows, true)
    }

    fn visible_footer_lines_with_policy(
        &mut self,
        rows: usize,
        preserve_blank_boundaries: bool,
    ) -> HeadlessTerminalResult<Vec<String>> {
        let snapshot = self.render_state.update(&self.terminal)?;
        let cols = usize::from(snapshot.cols()?);
        let mut rendered_rows: VecDeque<String> = VecDeque::with_capacity(rows.saturating_mul(2));
        let mut meaningful_row_count = 0usize;
        let mut pending_blank_boundary = false;

        let mut row_iteration = self.row_iterator.update(&snapshot)?;
        while let Some(row) = row_iteration.next() {
            let mut rendered = String::with_capacity(cols);
            let mut cell_iteration = self.cell_iterator.update(row)?;
            for x in 0..cols {
                cell_iteration.select(x as u16)?;
                let raw_cell = cell_iteration.raw_cell()?;
                match raw_cell.wide()? {
                    CellWide::SpacerTail | CellWide::SpacerHead => {}
                    CellWide::Narrow | CellWide::Wide => {
                        let graphemes = cell_iteration.graphemes()?;
                        if graphemes.is_empty() {
                            rendered.push(' ');
                        } else {
                            rendered.extend(graphemes);
                        }
                    }
                }
            }
            let normalized = normalize_row_text(&rendered);
            if normalized.is_empty() {
                if preserve_blank_boundaries && meaningful_row_count > 0 {
                    pending_blank_boundary = true;
                }
                continue;
            }

            if rows == 0 {
                continue;
            }
            if meaningful_row_count == rows {
                while let Some(expired) = rendered_rows.pop_front() {
                    if !expired.is_empty() {
                        meaningful_row_count -= 1;
                        break;
                    }
                }
                while rendered_rows.front().is_some_and(String::is_empty) {
                    rendered_rows.pop_front();
                }
            }
            if preserve_blank_boundaries && pending_blank_boundary && !rendered_rows.is_empty() {
                rendered_rows.push_back(String::new());
            }
            pending_blank_boundary = false;
            rendered_rows.push_back(normalized);
            meaningful_row_count += 1;
        }

        Ok(rendered_rows.into_iter().collect())
    }

    #[cfg(test)]
    pub fn visible_footer_text(&mut self, rows: usize) -> HeadlessTerminalResult<String> {
        Ok(self.visible_footer_lines(rows)?.join("\n"))
    }

    pub fn debug_lines(&mut self, rows: usize) -> HeadlessTerminalResult<Vec<String>> {
        self.visible_footer_lines(rows)
    }

    /// The terminal title the session last set with OSC 0/2.
    ///
    /// Provider-emitted state that survives a full-screen repaint, which is
    /// what makes it usable evidence for the frames the grid cannot read.
    pub fn title(&self) -> String {
        self.terminal.title().unwrap_or("").to_string()
    }

    /// The last OSC 9 progress report the session emitted, if any.
    pub fn progress_state(&self) -> Option<ProgressState> {
        self.progress.latest_state()
    }

    /// Classify this frame, naming the rule that decided it.
    pub fn visible_verdict(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<Verdict>> {
        if classifier.provider().is_none() {
            return Ok(None);
        }
        let rows = classifier.status_rows();
        let lines = self.visible_footer_lines(rows)?;

        if !self.warned_unclassified_footer {
            if let Some(footer) = classifier.unclassified_footer(&lines) {
                log::warn!(
                    "[status] {:?} drew a footer these rules cannot classify, so its runtime \
                     status may be stale; re-measure the vocabulary in \
                     crates/daemon/src/detection/rules.json against CLI version {}: {footer:?}",
                    classifier.provider(),
                    classifier
                        .version()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| "unknown".to_string()),
                );
                self.warned_unclassified_footer = true;
            }
        }

        let title = self.title();
        let progress = self.progress_state();
        Ok(classifier.classify(&Evidence {
            lines: &lines,
            title: &title,
            progress,
        }))
    }

    pub fn visible_status(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<SessionStatus>> {
        Ok(self
            .visible_verdict(classifier)?
            .map(|verdict| verdict.status))
    }

    /// Whether the provider has finished publishing its current terminal
    /// frame.
    ///
    /// A TUI redraw bracketed with DEC synchronized-output mode is an
    /// intermediate frame while that mode is active: the old composer and a
    /// newly painted working line can coexist even though neither is the frame
    /// the provider will expose when the bracket closes. Status classification
    /// must wait for that boundary instead of turning a paint operation into
    /// agent activity.
    pub fn status_frame_complete(&self) -> bool {
        !self.terminal.mode(Mode::SYNC_OUTPUT).unwrap_or(false)
    }

    pub fn composer_state(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<ComposerState> {
        if classifier.provider().is_none() {
            return Ok(ComposerState::Unknown);
        }
        let rows = classifier.status_rows();
        let lines = self.visible_footer_lines(rows)?;
        // The text-level reading is the classifier's: which row is the
        // composer, and whether the frame draws a readable one at all, are
        // rule questions. An empty composer is already the whole proof.
        let composer_line = match classifier.composer_reading(&lines) {
            None => return Ok(ComposerState::Unknown),
            Some((_, text)) if text.is_empty() => return Ok(ComposerState::Empty),
            Some((index, _)) => lines[index].clone(),
        };
        // The line is not textually empty, so the only remaining question is
        // whether the provider painted it as its own suggestion. Answered from
        // the cells, and only for a provider whose suggestion styling has
        // actually been measured off real frames.
        let Some(provider) = classifier.provider() else {
            return Ok(ComposerState::Unknown);
        };
        if !paints_faint_suggestions(provider) {
            return Ok(ComposerState::Unknown);
        }
        let Some(row) = self.composer_row_for_line(&composer_line, classifier)? else {
            return Ok(ComposerState::Unknown);
        };
        if row.all_faint && row.cursor_at_start && !row.text.is_empty() {
            return Ok(ComposerState::SuggestionOnly);
        }
        Ok(ComposerState::Unknown)
    }

    /// The composer row a human could have a swappable draft on, read from the
    /// cells rather than from normalised text.
    ///
    /// `None` whenever this frame is not a plain, idle, readable composer —
    /// a dialog, a busy repaint, an alternate screen, a provider whose
    /// composer has never been measured, or a line the row scan cannot pin
    /// back to a cell row. Everything a caller needs to decide whether it may
    /// lift text off that line is in the returned row; nothing here decides it.
    pub fn plain_composer_row(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<ComposerRow>> {
        if classifier.composer_prompts().is_empty() {
            return Ok(None);
        }
        // Deliberately no alternate-screen guard. Claude Code draws its whole
        // TUI — composer included — on the alternate screen (`ESC[?1049h` is
        // in every live session's own byte stream), so refusing one would
        // refuse every real composer there is. What actually separates a
        // composer from a full-screen application here is the composer shape
        // itself: a measured prompt glyph with nothing but provider chrome
        // under it, on a frame that is neither busy nor waiting.
        if !self.status_frame_complete() {
            return Ok(None);
        }
        let rows = classifier.status_rows();
        let lines = self.visible_footer_lines(rows)?;
        let Some((index, _)) = classifier.composer_reading(&lines) else {
            return Ok(None);
        };
        let composer_line = lines[index].clone();
        self.composer_row_for_line(&composer_line, classifier)
    }

    /// Find the cell row that rendered `normalized_line` and read its styling.
    ///
    /// The line is located by the same text the classifier reads, so there is
    /// one answer to *which* row is the composer; this only adds what
    /// normalisation threw away. Cell attributes are the one thing the rule
    /// file deliberately does not describe — styling and cursor position are
    /// read off the grid, not matched against measured patterns — so this
    /// stays here, in the file that renders. The last matching row wins,
    /// matching the classifier's own last-prompt-line reading.
    fn composer_row_for_line(
        &mut self,
        normalized_line: &str,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<ComposerRow>> {
        let prompts = classifier.composer_prompts();
        if prompts.is_empty() {
            return Ok(None);
        }
        let cursor_x = self.terminal.cursor_x().unwrap_or(0);
        let cursor_y = self.terminal.cursor_y().unwrap_or(0);
        let snapshot = self.render_state.update(&self.terminal)?;
        let cols = usize::from(snapshot.cols()?);
        let mut matched: Option<(u16, Vec<ComposerCell>)> = None;
        let mut y: u16 = 0;
        let mut row_iteration = self.row_iterator.update(&snapshot)?;
        while let Some(row) = row_iteration.next() {
            let mut cells: Vec<ComposerCell> = Vec::with_capacity(cols);
            let mut cell_iteration = self.cell_iterator.update(row)?;
            for x in 0..cols {
                cell_iteration.select(x as u16)?;
                let raw_cell = cell_iteration.raw_cell()?;
                let text = match raw_cell.wide()? {
                    CellWide::SpacerTail | CellWide::SpacerHead => String::new(),
                    CellWide::Narrow | CellWide::Wide => {
                        cell_iteration.graphemes()?.into_iter().collect()
                    }
                };
                let faint = cell_iteration.style()?.faint;
                cells.push(ComposerCell { text, faint });
            }
            let rendered: String = cells.iter().map(|cell| cell.text.as_str()).collect();
            if normalize_row_text(&rendered) == normalized_line
                && starts_with_glyph(&rendered, &prompts)
            {
                matched = Some((y, cells));
            }
            y = y.saturating_add(1);
        }
        let Some((row_y, cells)) = matched else {
            return Ok(None);
        };
        Ok(Some(composer_row_from_cells(
            &cells,
            &prompts,
            (cursor_y == row_y).then_some(cursor_x),
        )))
    }

    /// The text rendered on this frame's composer line, or `None` when the
    /// frame draws no readable composer. Reported beside the session's typed-
    /// byte attestation so a reader can tell a human's unsent line from the
    /// CLI's own suggestion; the frame alone cannot.
    pub fn composer_line(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<String>> {
        if classifier.provider().is_none() {
            return Ok(None);
        }
        let status_rows = classifier.status_rows();
        let status_lines = self.visible_footer_lines(status_rows)?;
        let frame_lines = self.visible_footer_lines(usize::from(self.rows).max(status_rows))?;
        Ok(classifier.composer_line(&frame_lines, &status_lines))
    }

    pub fn waiting_prompt_snippet(
        &mut self,
        classifier: &mut Classifier,
    ) -> HeadlessTerminalResult<Option<String>> {
        if classifier.provider().is_none() {
            return Ok(None);
        }
        let classification_rows = classifier.waiting_prompt_rows();
        let classification_lines =
            self.visible_footer_lines_with_blank_boundaries(classification_rows)?;
        let frame_lines = self.visible_footer_lines_with_blank_boundaries(
            usize::from(self.rows).max(classification_rows),
        )?;
        Ok(classifier.waiting_prompt(&classification_lines, &frame_lines))
    }

    pub fn codex_resume_session_id(&mut self) -> HeadlessTerminalResult<Option<String>> {
        let footer_lines = self.visible_footer_lines(16)?;
        let joined = footer_lines.join(" ");
        Ok(extract_codex_resume_session_id(&joined))
    }

    pub fn from_snapshot(
        snapshot: &TerminalSnapshot,
        scrollback: usize,
    ) -> HeadlessTerminalResult<Self> {
        let mut headless_terminal = Self::new(snapshot.cols, snapshot.rows, scrollback)?;
        headless_terminal.write(Self::restore_vt(snapshot).as_bytes());
        Ok(headless_terminal)
    }

    pub fn from_handoff(
        snapshot: Option<&TerminalSnapshot>,
        cols: u16,
        rows: u16,
        scrollback: usize,
    ) -> HeadlessTerminalResult<Self> {
        let (cols, rows) = Self::normalize_dimensions(cols, rows);
        match snapshot {
            Some(snapshot) => match Self::from_snapshot(snapshot, scrollback) {
                Ok(headless_terminal) => Ok(headless_terminal),
                Err(error) => {
                    log::warn!(
                        "[handoff] failed to restore headless terminal from snapshot rows={} cols={}: {}",
                        snapshot.rows,
                        snapshot.cols,
                        error
                    );
                    Self::new(cols, rows, scrollback)
                }
            },
            None => Self::new(cols, rows, scrollback),
        }
    }
}

/// Whether a rendered line is a provider composer — the input line, not
/// something the session said.
///
/// Public because the composer has to be recognisable outside the daemon too:
/// the task-logs tail is a rendered frame flattened to text, and an agent
/// reading it cannot be left to guess which line is the prompt. One rule, one
/// place, so the tail and the snippet agree on what the composer is.
///
/// This file is compiled into both the `kanna_daemon` library and the daemon
/// binary, which declare their own module trees over it. The only caller is
/// `kanna-server`'s `http_api::task_logs`, which links the library target, so
/// per-crate dead-code analysis of the binary cannot see it. Same reason as
/// the module-level allow in `detection`.
#[allow(dead_code)]
pub fn line_is_composer(line: &str) -> bool {
    crate::detection::classify::starts_with_glyph(
        line,
        &crate::detection::global_composer_prompts(),
    )
}

/// The text a composer line carries, without its prompt glyph.
///
/// Allowed dead in the binary target for the same reason as
/// [`line_is_composer`]: its only caller is `kanna-server`'s
/// `http_api::task_logs`, which links the library target.
#[allow(dead_code)]
pub fn composer_line_text(line: &str) -> String {
    crate::detection::classify::prompt_remainder(line, &crate::detection::global_composer_prompts())
        .unwrap_or("")
        .to_string()
}

/// Whether this provider's suggestion styling has been measured off real
/// frames.
///
/// Claude Code paints its tab-to-accept ghost with SGR 2 and leaves the cursor
/// at the start of the composer; both were read off a live session's snapshot
/// on 2026-09-07 (`\x1b[0m❯\u{a0}\x1b[2mcommit this`). Nothing else here has
/// been measured, and this file's rule is that unmeasured chrome matches
/// nothing rather than being written from the shape a matcher expects.
///
/// Deliberately not a rule-file entry. `detection/rules.json` describes what
/// provider chrome *reads* as — text, glyphs, vocabulary — and a cell's
/// styling is not text: nothing in the matcher language can express "painted
/// faint", and inventing a styling dialect to hold one measured fact would be
/// a worse architecture than the one the rule file replaced.
fn paints_faint_suggestions(provider: AgentProvider) -> bool {
    matches!(provider, AgentProvider::Claude)
}

/// One rendered cell of the composer row: what it draws and whether it is dim.
struct ComposerCell {
    text: String,
    faint: bool,
}

/// Read a composer row's cells into the facts a caller can act on.
///
/// The draft starts after the prompt glyph and the single separator cell the
/// provider draws next to it — the same two characters the classifier's own
/// prompt-remainder read skips — so what is captured here is what a human
/// would see themselves having typed, and nothing the provider drew.
fn composer_row_from_cells(
    cells: &[ComposerCell],
    prompts: &[char],
    cursor_x: Option<u16>,
) -> ComposerRow {
    let prompt_index = cells
        .iter()
        .position(|cell| {
            cell.text
                .chars()
                .next()
                .is_some_and(|character| prompts.contains(&character))
        })
        .unwrap_or(0);
    let separator = cells.get(prompt_index + 1).is_some_and(cell_is_blank);
    let start = prompt_index + 1 + usize::from(separator);
    let cell_is_content = |cell: &ComposerCell| !cell_is_blank(cell);

    let end = cells
        .iter()
        .rposition(cell_is_content)
        .map_or(start, |index| index + 1)
        .max(start);
    let text: String = cells[start.min(cells.len())..end.min(cells.len())]
        .iter()
        .map(|cell| cell.text.as_str())
        .collect();
    let styled = &cells[start.min(cells.len())..end.min(cells.len())];
    let all_faint = styled.iter().any(&cell_is_content)
        && styled
            .iter()
            .filter(|cell| cell_is_content(cell))
            .all(|cell| cell.faint);

    let cursor = cursor_x.map(usize::from);
    let before_cursor = cursor.filter(|at| *at >= start).map(|at| {
        cells[start.min(cells.len())..at.min(cells.len())]
            .iter()
            .map(|cell| cell.text.as_str())
            .collect::<String>()
    });
    let cursor_at_start = cursor == Some(start);
    let cursor_at_end = cursor
        .is_some_and(|at| at >= start && !cells[at.min(cells.len())..].iter().any(cell_is_content));

    ComposerRow {
        text,
        all_faint,
        before_cursor,
        cursor_at_start,
        cursor_at_end,
    }
}

/// A cell holds nothing a human could have typed: it is empty, or it draws
/// only whitespace. The provider's own separator next to the prompt is a
/// no-break space, which is whitespace like any other here.
fn cell_is_blank(cell: &ComposerCell) -> bool {
    cell.text.is_empty() || cell.text.chars().all(char::is_whitespace)
}

pub fn scrollback_byte_limit(cols: u16, rows: u16, scrollback_rows: usize) -> usize {
    usize::from(cols)
        .saturating_mul(usize::from(rows).saturating_add(scrollback_rows))
        .saturating_mul(GHOSTTY_SCROLLBACK_BYTES_PER_CELL)
}

fn normalize_row_text(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    let mut words = text.split_whitespace();
    if let Some(first_word) = words.next() {
        normalized.push_str(first_word);
        for word in words {
            normalized.push(' ');
            normalized.push_str(word);
        }
    }
    normalized
}

fn extract_codex_resume_session_id(text: &str) -> Option<String> {
    let tokens: Vec<String> = text
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| {
                    matches!(ch, '"' | '\'' | '`' | ',' | '.' | ';' | ':' | '(' | ')')
                })
                .to_string()
        })
        .collect();

    for window in tokens.windows(3) {
        if !window[0].eq_ignore_ascii_case("codex") {
            continue;
        }
        if !window[1].eq_ignore_ascii_case("resume") {
            continue;
        }
        if is_uuid_like(&window[2]) {
            return Some(window[2].clone());
        }
    }

    None
}

fn is_uuid_like(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    for (index, ch) in value.chars().enumerate() {
        let expects_dash = matches!(index, 8 | 13 | 18 | 23);
        if expects_dash {
            if ch != '-' {
                return false;
            }
            continue;
        }

        if !ch.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}
#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::protocol::{AgentProvider, SessionStatus};

    use crate::detection::classify::contains_ascii_case_insensitive;
    use crate::detection::rules::DEFAULT_STATUS_ROWS as STATUS_ROWS;
    use crate::detection::schema::Channel;
    use crate::detection::{Classifier, CliVersion, Evidence, Verdict};

    use super::{
        bound_waiting_prompt, initial_session_status, line_is_composer, ComposerState,
        HeadlessTerminal, TerminalSnapshot,
    };

    /// The marker every Claude release before 2.1.263 drew in its working
    /// footer, kept here because several tests pin its *absence*.
    const INTERRUPT_MARKER: &str = "esc to interrupt";
    /// What a finished turn's footer carries in place of the ellipsis.
    const CLAUDE_DONE_FOOTER_MARKER: &str = "\u{B7} done ";
    /// OpenCode's composer box border, pinned so snippet tests can assert it
    /// never leaks into a published snippet.
    const OPENCODE_BOX_BORDER: char = '\u{2503}';
    const OPENCODE_HINT_BAR_MARKER: &str = "ctrl+p commands";

    /// A session classifier for a provider whose CLI version is unknown —
    /// which selects every rule measured for that provider, exactly as a live
    /// session does before its version probe answers.
    fn rules_for(provider: AgentProvider) -> Classifier {
        Classifier::new(Some(provider))
    }

    /// The same, pinned to a CLI release.
    fn rules_for_version(provider: AgentProvider, version: &str) -> Classifier {
        Classifier::with_version(Some(provider), CliVersion::parse(version))
    }

    /// Classify a hand-written frame, naming the rule that decided it.
    fn verdict_for(provider: AgentProvider, lines: &[&str]) -> Option<Verdict> {
        let lines = lines
            .iter()
            .map(|line| (*line).to_string())
            .collect::<Vec<_>>();
        rules_for(provider).classify(&Evidence {
            lines: &lines,
            title: "",
            progress: None,
        })
    }

    /// A frame of the OpenCode TUI as it was actually drawn.
    ///
    /// `stream` is the raw PTY output of a real `opencode` process from launch
    /// up to the moment it reached `status`, captured by
    /// `crates/daemon/tests/fixtures/opencode/capture-tui-fixtures.py` and
    /// replayed here through the same headless terminal the daemon runs. Nothing
    /// about these frames is transcribed or reconstructed: the previous fixtures
    /// were hand-written from an assumed TUI and pinned a composer glyph the CLI
    /// had stopped drawing, which is how live sessions came to sit at `Busy`
    /// forever (docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md).
    ///
    /// Both geometries are pinned on purpose: OpenCode drops or wraps its
    /// "ctrl+p commands" hint bar on a narrow terminal, so a marker chosen from
    /// a wide terminal alone would have failed silently on a narrow one.
    struct OpencodeFixture {
        name: &'static str,
        cols: u16,
        rows: u16,
        stream: &'static [u8],
        status: SessionStatus,
    }

    impl OpencodeFixture {
        fn replay(&self) -> HeadlessTerminal {
            let mut headless_terminal =
                HeadlessTerminal::new(self.cols, self.rows, 10_000).unwrap();
            headless_terminal.write(self.stream);
            headless_terminal
        }
    }

    /// The CLI release the OpenCode fixtures were captured from. Named here so
    /// the rule-selection assertions run under the rules measured for that
    /// release, and a re-capture moves both together.
    const OPENCODE_FIXTURE_CLI_VERSION: &str = "1.18.15";

    /// Captured from OpenCode CLI **1.18.15** (`opencode/big-pickle`).
    /// Re-capture with the script beside the fixtures when the TUI moves.
    const OPENCODE_FIXTURES: &[OpencodeFixture] = &[
        OpencodeFixture {
            name: "busy 120x40",
            cols: 120,
            rows: 40,
            stream: include_bytes!("../tests/fixtures/opencode/busy-120x40.ansi"),
            status: SessionStatus::Busy,
        },
        OpencodeFixture {
            name: "idle 120x40",
            cols: 120,
            rows: 40,
            stream: include_bytes!("../tests/fixtures/opencode/idle-120x40.ansi"),
            status: SessionStatus::Idle,
        },
        OpencodeFixture {
            name: "permission 120x40",
            cols: 120,
            rows: 40,
            stream: include_bytes!("../tests/fixtures/opencode/permission-120x40.ansi"),
            status: SessionStatus::Waiting,
        },
        OpencodeFixture {
            name: "busy 80x24",
            cols: 80,
            rows: 24,
            stream: include_bytes!("../tests/fixtures/opencode/busy-80x24.ansi"),
            status: SessionStatus::Busy,
        },
        OpencodeFixture {
            name: "idle 80x24",
            cols: 80,
            rows: 24,
            stream: include_bytes!("../tests/fixtures/opencode/idle-80x24.ansi"),
            status: SessionStatus::Idle,
        },
        OpencodeFixture {
            name: "permission 80x24",
            cols: 80,
            rows: 24,
            stream: include_bytes!("../tests/fixtures/opencode/permission-80x24.ansi"),
            status: SessionStatus::Waiting,
        },
    ];

    #[test]
    fn ascii_case_insensitive_contains_matches_status_markers() {
        assert!(contains_ascii_case_insensitive(
            "• Working (0s • Esc To Interrupt)",
            INTERRUPT_MARKER
        ));
        assert!(!contains_ascii_case_insensitive(
            "Thinking hard",
            INTERRUPT_MARKER
        ));
    }

    #[test]
    fn headless_terminal_snapshot_tracks_output_and_resize() {
        let mut headless_terminal = HeadlessTerminal::new(80, 24, 10_000).unwrap();
        headless_terminal.write(b"abc");
        headless_terminal.resize(100, 30).unwrap();
        let snapshot = headless_terminal.snapshot().unwrap();

        assert_eq!(snapshot.rows, 30);
        assert_eq!(snapshot.cols, 100);
        assert!(snapshot.vt.contains("abc"));
    }

    #[test]
    fn snapshot_metadata_reports_no_fallback_for_serializable_screen() {
        let mut headless_terminal = HeadlessTerminal::new(80, 24, 10_000).unwrap();
        headless_terminal.write(b"abc");

        let snapshot = headless_terminal.snapshot_with_metadata().unwrap();

        assert!(!snapshot.used_visible_text_fallback);
        assert!(snapshot.snapshot.vt.contains("abc"));
    }

    #[test]
    fn headless_terminal_snapshot_keeps_ten_thousand_scrollback_lines() {
        let mut headless_terminal = HeadlessTerminal::new(120, 45, 10_000).unwrap();
        for line in 1..=10_050 {
            headless_terminal.write(format!("DSCROLL{line:05}\r\n").as_bytes());
        }
        headless_terminal.write(b"DSCROLLEND\r\n");

        let snapshot = headless_terminal.snapshot().unwrap();
        let retained = snapshot.vt.matches("DSCROLL").count();

        assert!(
            retained >= 10_000,
            "expected at least 10,000 serialized scrollback lines, got {retained}; serialized_len={}",
            snapshot.vt.len()
        );
        assert!(snapshot.vt.contains("DSCROLLEND"));
    }

    #[test]
    fn headless_terminal_survives_move_after_callback_registration() {
        let mut by_id = HashMap::new();
        by_id.insert(
            "session".to_string(),
            HeadlessTerminal::new(80, 24, 10_000).unwrap(),
        );

        let headless_terminal = by_id.get_mut("session").unwrap();
        headless_terminal.write(b"\x1b[>q");

        let replies = headless_terminal.drain_pty_writes();
        assert!(!replies.is_empty());
    }

    #[test]
    fn headless_terminal_restores_from_snapshot() {
        let snapshot = TerminalSnapshot {
            version: 1,
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 2,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "hello".to_string(),
        };

        let mut headless_terminal = HeadlessTerminal::from_snapshot(&snapshot, 10_000).unwrap();
        let restored = headless_terminal.snapshot().unwrap();

        assert_eq!(restored.rows, 24);
        assert_eq!(restored.cols, 80);
        assert!(restored.vt.contains("hello"));
        assert_eq!(restored.cursor_row, 1);
        assert_eq!(restored.cursor_col, 2);
    }

    #[test]
    fn headless_terminal_snapshot_tracks_cursor_visibility_and_strips_sync_output() {
        let mut headless_terminal = HeadlessTerminal::new(80, 24, 10_000).unwrap();
        headless_terminal.write(b"\x1b[?25l\x1b[?2026hhello");

        assert!(!headless_terminal.status_frame_complete());

        let snapshot = headless_terminal.snapshot().unwrap();

        assert!(!snapshot.cursor_visible);
        assert!(!snapshot.vt.contains("\x1b[?2026h"));

        headless_terminal.write(b"\x1b[?2026l");
        assert!(headless_terminal.status_frame_complete());
    }

    #[test]
    fn handoff_snapshot_restore_falls_back_to_blank_headless_terminal() {
        let snapshot = TerminalSnapshot {
            version: 1,
            rows: 0,
            cols: 0,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            saved_at: 0,
            sequence: 0,
            vt: "ignored".to_string(),
        };

        assert!(HeadlessTerminal::from_snapshot(&snapshot, 10_000).is_err());

        let mut headless_terminal =
            HeadlessTerminal::from_handoff(Some(&snapshot), 120, 45, 10_000).unwrap();
        headless_terminal.write(b"hello");
        let restored = headless_terminal.snapshot().unwrap();

        assert_eq!(restored.cols, 120);
        assert_eq!(restored.rows, 45);
        assert!(restored.vt.contains("hello"));
    }

    #[test]
    fn handoff_without_snapshot_falls_back_to_default_dimensions() {
        let mut headless_terminal = HeadlessTerminal::from_handoff(None, 0, 0, 10_000).unwrap();
        headless_terminal.write(b"hello");
        let restored = headless_terminal.snapshot().unwrap();

        assert_eq!(restored.cols, 80);
        assert_eq!(restored.rows, 24);
        assert!(restored.vt.contains("hello"));
    }

    #[test]
    fn visible_footer_text_reads_bottom_rendered_rows() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n› Find and fix a bug".as_bytes(),
        );

        let footer = headless_terminal.visible_footer_text(3).unwrap();

        assert!(footer.contains("Working(0s • esc to interrupt)"));
        assert!(footer.contains("› Find and fix a bug"));
    }

    #[test]
    fn idle_prompt_snippet_keeps_agent_text_and_drops_codex_chrome() {
        let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        terminal.write(
            concat!(
                "OpenAI Codex\r\n",
                "• Updated the mobile task card and all focused tests pass.\r\n",
                "gpt-5.5 high · /tmp/.kanna-worktrees/task-1\r\n",
                "────────────────────────────────\r\n",
                "› \r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Codex))
                .unwrap()
                .as_deref(),
            Some("• Updated the mobile task card and all focused tests pass.")
        );
    }

    #[test]
    fn idle_prompt_snippet_drops_codex_model_footer_without_a_worktree_path() {
        let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        terminal.write(
            concat!(
                "OpenAI Codex\r\n",
                "gpt-5.5 high · /tmp/project\r\n",
                "• The renamed title is synced to mobile.\r\n",
                "────────────────────────────────\r\n",
                "› \r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Codex))
                .unwrap()
                .as_deref(),
            Some("• The renamed title is synced to mobile.")
        );
    }

    #[test]
    fn codex_waiting_prompt_snippet_stops_at_blank_separator_after_tool_output() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "OpenAI Codex\r\n",
                "• Ran cargo test -p kanna-daemon waiting_prompt\r\n",
                "  └ test result: ok. 4 passed; 0 failed\r\n",
                "\r\n",
                "• Ready for review.\r\n",
                "gpt-5.5 high · /tmp/project\r\n",
                "────────────────────────────────\r\n",
                "› \r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Codex))
                .unwrap()
                .as_deref(),
            Some("• Ready for review.")
        );
    }

    #[test]
    fn claude_waiting_prompt_snippet_stops_at_blank_separator_after_tool_output() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "⏺ Bash(cargo test -p kanna-daemon waiting_prompt)\r\n",
                "  ⎿  test result: ok. 4 passed; 0 failed\r\n",
                "\r\n",
                "Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ \r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("Ready for review.")
        );
    }

    #[test]
    fn waiting_prompt_snippet_keeps_full_non_empty_footer_budget_around_blank_boundary() {
        let mut terminal = HeadlessTerminal::new(120, 12, 10_000).unwrap();
        terminal.write(
            concat!(
                "Do you want to allow Bash to run the focused tests?\r\n",
                "\r\n",
                "1. Yes\r\n",
                "2. No\r\n",
                "3. Always allow\r\n",
                "4. Review command\r\n",
                "5. Show details\r\n",
                "6. Cancel\r\n",
                "7. Help\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("Do you want to allow Bash to run the focused tests?")
        );
    }

    #[test]
    fn codex_waiting_prompt_snippet_collapses_a_long_blank_gap_to_one_boundary() {
        let mut terminal = HeadlessTerminal::new(120, 20, 10_000).unwrap();
        terminal.write(
            concat!(
                "• Ready for review.\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "\r\n",
                "gpt-5.5 high · /tmp/project\r\n",
                "────────────────────────────────\r\n",
                "› \r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Codex))
                .unwrap()
                .as_deref(),
            Some("• Ready for review.")
        );
    }

    /// A question menu (Claude's AskUserQuestion) carries none of the
    /// permission-prompt wording, and its caret line reads as the idle input
    /// box — so a task parked on one used to be indistinguishable from a task
    /// that had simply finished talking.
    #[test]
    fn claude_selection_menu_reports_waiting_and_its_question() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ The branch has diverged from main.\r\n",
                "\r\n",
                "How should I publish the fix?\r\n",
                "❯ 1. Rebase and force-push\r\n",
                "  2. Force-push as-is\r\n",
                "  3. Leave local\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("How should I publish the fix?")
        );
    }

    /// The event feed's whole value rests on this: a session running a long
    /// build must never be reported as blocked on input, no matter how quiet it
    /// is or what its output happens to contain.
    #[test]
    fn claude_running_build_output_is_never_waiting() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Bash(cargo build)\r\n",
                "  Compiling kanna-server v0.1.0\r\n",
                "  1. this line merely starts with a number\r\n",
                "\r\n",
                "✻ Building… (312s • esc to interrupt)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    /// The composer is where somebody is about to speak, not where the
    /// session spoke — and the CLI paints its own tab-to-accept suggestion
    /// there. A snippet that carries it hands an agent a sentence nobody said,
    /// which is how "run it on my phone so i can see it" reached a task
    /// manager as an owner directive.
    #[test]
    fn claude_waiting_prompt_snippet_never_carries_the_composer_suggestion() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯\u{a0}check again in a minute\r\n",
                "────────────────────────────────\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("⏺ Ready for review.")
        );
        assert_eq!(
            terminal
                .composer_line(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("check again in a minute"),
            "the text still has to be readable — as its own labelled field"
        );
    }

    /// A composer line long enough to wrap carries no prompt glyph on its
    /// continuation rows, so those rows read as transcript unless the snippet
    /// cuts at the composer's *position*. This is the leak a per-line chrome
    /// rule cannot close.
    #[test]
    fn claude_waiting_prompt_snippet_never_carries_a_wrapped_composer_line() {
        let mut terminal = HeadlessTerminal::new(40, 12, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "⏺ Ready for review.\r\n",
                "────────────────────────\r\n",
                "❯\u{a0}run it on my phone so i can see it right now please\r\n",
                "⏵⏵ bypass permissions on\r\n",
            )
            .as_bytes(),
        );

        let snippet = terminal
            .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
            .unwrap();
        assert_eq!(snippet.as_deref(), Some("⏺ Ready for review."));
        assert!(
            !snippet.unwrap_or_default().contains("phone"),
            "no part of the composer line, wrapped or not, is session output"
        );
    }

    #[test]
    fn claude_waiting_prompt_snippet_never_carries_three_palette_rows() {
        let mut terminal = HeadlessTerminal::new(120, 12, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ /\r\n",
                "/loop Run a prompt or slash command on a recurring interval\r\n",
                "/commit Commit the current changes\r\n",
                "/review Review the current branch\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("⏺ Ready for review.")
        );
    }

    #[test]
    fn claude_waiting_prompt_finds_composer_above_status_window_palette() {
        let mut terminal = HeadlessTerminal::new(120, 14, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ /\r\n",
                "/agents Manage agent configurations\r\n",
                "/clear Clear conversation history\r\n",
                "/commit Commit the current changes\r\n",
                "/compact Compact conversation history\r\n",
                "/config Open configuration\r\n",
                "/doctor Diagnose installation\r\n",
                "/help Show available commands\r\n",
                "/loop Run a recurring prompt\r\n",
                "/review Review the current branch\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("⏺ Ready for review."),
            "the composer boundary must come from the visible frame, not the eight-row status window"
        );
    }

    #[test]
    fn claude_waiting_prompt_ignores_palette_below_interleaved_chrome() {
        let mut terminal = HeadlessTerminal::new(120, 12, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ /\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
                "/loop Run a recurring prompt\r\n",
                "/commit Commit the current changes\r\n",
                "/review Review the current branch\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("⏺ Ready for review.")
        );
    }

    /// Palette entries are composer-owned frame content, but the composer
    /// itself remains useful on its separately labelled surface. Its text is
    /// still not proof of an empty composer, so attestation stays conservative.
    #[test]
    fn claude_palette_keeps_snippet_clean_and_composer_labelled() {
        let mut terminal = HeadlessTerminal::new(120, 14, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ /loop\r\n",
                "/agents Manage agent configurations\r\n",
                "/clear Clear conversation history\r\n",
                "/commit Commit the current changes\r\n",
                "/compact Compact conversation history\r\n",
                "/config Open configuration\r\n",
                "/doctor Diagnose installation\r\n",
                "/help Show available commands\r\n",
                "/loop Run a recurring prompt\r\n",
                "/review Review the current branch\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("⏺ Ready for review.")
        );
        assert_eq!(
            terminal
                .composer_line(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("/loop")
        );
        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// Every frame below is the same shape the status matchers above are
    /// pinned against, read for a different question: is anything typed into
    /// the composer? Only a bare prompt glyph answers yes-it-is-empty.
    #[test]
    fn claude_empty_composer_is_provably_empty() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done — 3 files changed.\r\n",
                "────────────────────────────────\r\n",
                "❯ \r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Empty
        );
    }

    #[test]
    fn claude_composer_holding_text_is_never_provably_empty() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done — 3 files changed.\r\n",
                "────────────────────────────────\r\n",
                "❯ half typed thought\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// A `❯` line carrying the CLI's own tab-to-accept suggestion renders as
    /// text the daemon cannot tell from a typed draft, and it must not be
    /// treated as an empty composer — accepting one would submit a sentence
    /// nobody wrote.
    #[test]
    fn claude_composer_showing_a_suggestion_is_not_provably_empty() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done.\r\n",
                "❯ run the tests again (tab to accept)\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// The 2026-09-07 owner report, replayed from the frame that produced it.
    ///
    /// A live session's snapshot rendered its composer as
    /// `ESC[0m ❯ NBSP ESC[2m commit this` with the cursor parked at column 2 —
    /// SGR 2 is faint, and the owner could see it was grey while typed text is
    /// not. Text alone called that a draft and held every delivery behind it
    /// for the life of the session.
    #[test]
    fn claude_faint_suggestion_with_the_cursor_at_the_start_proves_nothing_typed() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(claude_composer_frame("\x1b[2mcommit this").as_bytes());
        terminal.write(b"\x1b[3;3H");

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::SuggestionOnly
        );
        assert_eq!(
            terminal
                .composer_line(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("commit this"),
            "what is rendered is still reported; only the verdict about it changed"
        );
    }

    /// The line that must never be read as a suggestion: the same words, typed.
    #[test]
    fn claude_typed_text_at_the_composer_is_never_read_as_a_suggestion() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(claude_composer_frame("commit this").as_bytes());
        terminal.write(b"\x1b[3;14H");

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// Faint alone is not enough. A human who dimmed their own terminal, or a
    /// provider that ever paints a draft faint, still has the cursor after
    /// what they typed.
    #[test]
    fn claude_faint_text_with_the_cursor_after_it_stays_unknown() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(claude_composer_frame("\x1b[2mcommit this").as_bytes());
        terminal.write(b"\x1b[3;14H");

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// The cursor at the start is not enough either: a human who pressed
    /// Ctrl-A over their own draft is at column 2 with text that is not faint.
    #[test]
    fn claude_unfaint_text_with_the_cursor_at_the_start_stays_unknown() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(claude_composer_frame("commit this").as_bytes());
        terminal.write(b"\x1b[3;3H");

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// Unmeasured chrome matches nothing. Codex draws a composer this file can
    /// read, but nobody has measured what it paints its own suggestions with.
    #[test]
    fn codex_suggestion_styling_is_unmeasured_and_matches_nothing() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done.\r\n",
                "────────────────────────────────\r\n",
                "\x1b[0m›\u{a0}\x1b[2mcommit this\r\n",
            )
            .as_bytes(),
        );
        terminal.write(b"\x1b[3;3H");

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// What a swap is allowed to lift off the composer, read from the cells:
    /// exactly the bytes left of the cursor, interior spacing and multibyte
    /// intact, and nothing the provider drew.
    #[test]
    fn a_typed_draft_is_captured_byte_exact_from_the_cells() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(claude_composer_frame("héllo  wörld ").as_bytes());
        // 13 rendered cells of draft, so the cursor sits at column 2 + 13.
        terminal.write(b"\x1b[3;16H");

        let row = terminal
            .plain_composer_row(&mut rules_for(AgentProvider::Claude))
            .unwrap()
            .expect("a plain composer row");
        assert_eq!(row.before_cursor.as_deref(), Some("héllo  wörld "));
        assert!(row.cursor_at_end);
        assert!(!row.all_faint);
        assert!(!row.cursor_at_start);
    }

    /// Claude Code draws its composer on the alternate screen, so a composer
    /// row must still be readable there.
    #[test]
    fn a_composer_on_the_alternate_screen_is_still_a_composer() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(b"\x1b[?1049h");
        terminal.write(claude_composer_frame("half typed").as_bytes());
        terminal.write(b"\x1b[3;13H");

        let row = terminal
            .plain_composer_row(&mut rules_for(AgentProvider::Claude))
            .unwrap()
            .expect("a composer row on the alternate screen");
        assert_eq!(row.before_cursor.as_deref(), Some("half typed"));
    }

    /// A permission prompt is not a plain composer, whatever it draws below.
    #[test]
    fn a_waiting_permission_prompt_has_no_plain_composer_row() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "Do you want to allow this command?\r\n",
                "❯ 1. Yes\r\n",
                "  2. No\r\n",
            )
            .as_bytes(),
        );

        assert!(terminal
            .plain_composer_row(&mut rules_for(AgentProvider::Claude))
            .unwrap()
            .is_none());
    }

    /// Everything past the composer box's closing divider is Claude's status
    /// bar, whose rows this file has never enumerated. Unclassified, the `/rc`
    /// row made every live Claude session on this machine fail the composer
    /// read, so attestation could never fire.
    #[test]
    fn rows_below_the_composer_box_divider_are_status_bar_chrome() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done.\r\n",
                "────────────────────────────────\r\n",
                "❯ \r\n",
                "────────────────────────────────\r\n",
                "/rc\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Empty
        );
    }

    /// The box-tail reading is Claude's because Claude's box is what was
    /// measured, and that is a rule-file fact rather than a branch in code.
    ///
    /// Codex declares no divider glyphs of its own, so the same frame shape
    /// keeps the reading it always had: an unmeasured row below the composer
    /// leaves the composer unreadable. A provider does not inherit another
    /// provider's measurements by drawing a similar-looking screen.
    #[test]
    fn an_unmeasured_providers_composer_box_is_not_read_from_a_divider() {
        let frame = concat!(
            "⏺ Done.\r\n",
            "────────────────────────────────\r\n",
            "› \r\n",
            "────────────────────────────────\r\n",
            "some unmeasured status row\r\n",
        );
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(frame.as_bytes());

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            ComposerState::Unknown,
            "Codex declares no box border, so nothing below its composer is \
             read as a status bar"
        );

        // The identical shape, for the provider whose box *was* measured.
        let mut claude = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        claude.write(frame.replace('\u{203A}', "\u{276F}").as_bytes());
        assert_eq!(
            claude
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Empty
        );
    }

    /// A palette below the composer is not below the box: it is drawn inside
    /// it, above the closing divider, so it still has to read as chrome — and
    /// it does not, because the composer above it is holding a `/`.
    #[test]
    fn a_palette_entry_still_leaves_the_composer_unreadable() {
        let mut terminal = HeadlessTerminal::new(120, 14, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Ready for review.\r\n",
                "────────────────────────────────\r\n",
                "❯ /\r\n",
                "/clear Clear conversation history\r\n",
                "/commit Commit the current changes\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// A Claude frame whose composer line carries `composer` verbatim, drawn
    /// the way the CLI draws it: `❯`, a no-break space, then the line.
    fn claude_composer_frame(composer: &str) -> String {
        format!(
            "⏺ Done.\r\n────────────────────────────────\r\n\x1b[0m❯\u{a0}{composer}\r\n\x1b[0m⏵⏵ bypass permissions on (shift+tab to cycle)\r\n"
        )
    }

    #[test]
    fn claude_busy_and_waiting_frames_are_not_attested() {
        let mut busy = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        busy.write(
            concat!(
                "✻ Thinking…\r\n",
                "• Working (12s • esc to interrupt)\r\n",
                "❯ \r\n",
            )
            .as_bytes(),
        );
        assert_eq!(
            busy.composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );

        let mut waiting = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        waiting.write(
            concat!(
                "Do you want to allow this command?\r\n",
                "❯ 1. Yes\r\n",
                "  2. No\r\n",
            )
            .as_bytes(),
        );
        assert_eq!(
            waiting
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// Non-chrome output below the prompt line means the composer is not where
    /// this thinks it is, so the frame proves nothing.
    #[test]
    fn claude_prompt_buried_above_transcript_output_is_not_a_composer() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(concat!("❯ \r\n", "⏺ Reading src/main.rs\r\n").as_bytes());

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    #[test]
    fn codex_empty_composer_is_provably_empty() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(concat!("OpenAI Codex\r\n", "Done.\r\n", "› \r\n").as_bytes());

        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            ComposerState::Empty
        );

        let mut drafted = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        drafted.write(concat!("OpenAI Codex\r\n", "Done.\r\n", "› why did\r\n").as_bytes());
        assert_eq!(
            drafted
                .composer_state(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    /// A session with no provider is a plain shell — Kanna's teardown and
    /// worktree shells among them — and nothing here knows what an empty
    /// composer looks like in one. The same holds for the providers whose
    /// composers have never been captured: unmeasured chrome matches nothing.
    #[test]
    fn unmeasured_providers_and_plain_shells_are_never_attested() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write("❯ \r\n".as_bytes());

        assert_eq!(
            terminal.composer_state(&mut Classifier::none()).unwrap(),
            ComposerState::Unknown
        );
        for provider in [
            AgentProvider::Opencode,
            AgentProvider::Antigravity,
            AgentProvider::Copilot,
        ] {
            assert_eq!(
                terminal.composer_state(&mut rules_for(provider)).unwrap(),
                ComposerState::Unknown,
                "{provider:?} has no captured empty-composer frame to match"
            );
        }
    }

    #[test]
    fn opencode_captured_idle_frame_is_not_attested() {
        for fixture in OPENCODE_FIXTURES {
            let mut headless_terminal = fixture.replay();

            assert_eq!(
                headless_terminal
                    .composer_state(&mut rules_for(AgentProvider::Opencode))
                    .unwrap(),
                ComposerState::Unknown,
                "{} must not be read as a provably empty composer",
                fixture.name
            );
        }
    }

    #[test]
    fn claude_empty_input_box_still_reports_idle() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(
            concat!(
                "⏺ Done — 3 files changed.\r\n",
                "────────────────────────────────\r\n",
                "❯ \r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn waiting_prompt_snippet_uses_visible_permission_question() {
        let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "Do you want to allow Bash to run the focused tests?\r\n",
                "1. Yes\r\n",
                "2. No\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("Do you want to allow Bash to run the focused tests?")
        );
    }

    #[test]
    fn waiting_prompt_snippet_reassembles_a_wrapped_permission_question() {
        let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "Do you want to\r\n",
                "allow Bash to run the focused tests?\r\n",
                "1. Yes\r\n",
                "2. No\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("Do you want to allow Bash to run the focused tests?")
        );
    }

    #[test]
    fn waiting_prompt_snippet_keeps_question_continuation_after_marker_line() {
        let mut terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        terminal.write(
            concat!(
                "Claude Code\r\n",
                "Do you want to allow Bash to run this\r\n",
                "command with elevated permissions?\r\n",
                "1. Yes\r\n",
                "2. No\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("Do you want to allow Bash to run this command with elevated permissions?")
        );
    }

    #[test]
    fn waiting_prompt_snippet_is_bounded_to_240_unicode_scalars() {
        let bounded = bound_waiting_prompt(&"界".repeat(300)).unwrap();

        assert_eq!(bounded.chars().count(), 240);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn codex_status_comes_from_visible_footer_content() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n› Find and fix a bug".as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n›".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn codex_prompt_does_not_force_idle_while_interrupt_marker_is_visible() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n› The application panicked"
                .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn codex_working_status_without_interrupt_marker_does_not_override_prompt() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "OpenAI Codex\r\n",
                "◦ Working\r\n",
                "gpt-5.5 high · /tmp/kanna-codex-fixture-root\r\n",
                "› Improve documentation in @filename\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            headless_terminal
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            None
        );
    }

    #[test]
    fn codex_assistant_text_starting_with_working_does_not_keep_prompt_busy() {
        let mut headless_terminal = HeadlessTerminal::new(80, 5, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "OpenAI Codex\r\n",
                "• Working on the implementation details.\r\n",
                "────────────────────────────────\r\n",
                "› Follow-up prompt\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn opencode_status_is_read_from_real_captured_frames() {
        for fixture in OPENCODE_FIXTURES {
            let mut headless_terminal = fixture.replay();

            assert_eq!(
                headless_terminal
                    .visible_status(&mut rules_for(AgentProvider::Opencode))
                    .unwrap(),
                Some(fixture.status),
                "{} reported the wrong status. Rendered footer:\n{}",
                fixture.name,
                headless_terminal.visible_footer_text(STATUS_ROWS).unwrap(),
            );
        }
    }

    /// The pre-2026-08-08 matcher keyed `Idle` on a `›` composer glyph that
    /// OpenCode does not draw, so a live session sat at its initial `Busy` for
    /// the rest of its life — no idle, no clean transfer finalization, no
    /// sidebar state change. The captured post-turn frame is the pin.
    #[test]
    fn opencode_reports_idle_once_a_real_turn_has_finished() {
        for fixture in OPENCODE_FIXTURES
            .iter()
            .filter(|fixture| fixture.status == SessionStatus::Idle)
        {
            let mut headless_terminal = fixture.replay();

            assert_eq!(
                headless_terminal
                    .visible_status(&mut rules_for(AgentProvider::Opencode))
                    .unwrap(),
                Some(SessionStatus::Idle),
                "{} never left Busy",
                fixture.name
            );
        }
    }

    /// OpenCode prefixes the *user's* own message with `›`, which is why the old
    /// idle glyph was not merely stale but wrong: an echoed instruction is not a
    /// composer, and a session that has drawn nothing else is not idle.
    #[test]
    fn opencode_echoed_user_message_is_not_an_idle_composer() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write("Header\r\nBody\r\n› Review the implementation".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Opencode))
                .unwrap(),
            None
        );
    }

    /// 1.18.15 renders "esc interrupt" and 1.16.2 rendered "escape interrupt".
    /// Every spelling seen is pinned, so a CLI that moves again still reports
    /// Busy rather than silently losing the state.
    #[test]
    fn opencode_accepts_every_pinned_spelling_of_the_working_footer() {
        for footer in ["escape interrupt", "esc interrupt", "esc to interrupt"] {
            let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
            headless_terminal.write(
                format!("Body\r\n┃ Build · Big Pickle OpenCode Zen · default\r\n⬝⬝⬝⬝⬝⬝⬝⬝ {footer}")
                    .as_bytes(),
            );

            assert_eq!(
                headless_terminal
                    .visible_status(&mut rules_for(AgentProvider::Opencode))
                    .unwrap(),
                Some(SessionStatus::Busy),
                "{footer:?} did not read as busy"
            );
        }
    }

    /// The composer's status line names the model, and OpenCode has drawn it
    /// three ways in the versions seen: "Build · Big Pickle OpenCode Zen"
    /// (1.18.15), the same with a trailing "· default" variant (1.16.2), and
    /// "Build · Model default" when no model is configured and the CLI resolves
    /// none. All three were read off a live composer; keying idle on the
    /// richest one alone would have missed the others.
    #[test]
    fn opencode_composer_status_covers_both_model_spellings() {
        for composer in [
            "\u{2503}  Build \u{B7} Big Pickle OpenCode Zen",
            "\u{2503}  Build \u{B7} Big Pickle OpenCode Zen \u{B7} default",
            "\u{2503}  Build \u{B7} Model default",
        ] {
            let mut headless_terminal = HeadlessTerminal::new(120, 4, 10_000).unwrap();
            headless_terminal.write(format!("Body\r\n{composer}\r\nctrl+p commands").as_bytes());

            assert_eq!(
                headless_terminal
                    .visible_status(&mut rules_for(AgentProvider::Opencode))
                    .unwrap(),
                Some(SessionStatus::Idle),
                "{composer:?} did not read as an idle composer"
            );
        }
    }

    /// The permission dialog's header sits far above the status window, so the
    /// snippet has to be read from a taller slice than the status is.
    #[test]
    fn opencode_waiting_prompt_reads_the_permission_dialog() {
        for fixture in OPENCODE_FIXTURES
            .iter()
            .filter(|fixture| fixture.status == SessionStatus::Waiting)
        {
            let snippet = fixture
                .replay()
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Opencode))
                .unwrap()
                .unwrap_or_else(|| panic!("{} produced no waiting prompt", fixture.name));

            assert!(
                snippet.contains("Permission required"),
                "{} snippet lost the question: {snippet:?}",
                fixture.name
            );
            assert!(
                snippet.contains("echo hello > greeting.txt"),
                "{} snippet lost the command being decided: {snippet:?}",
                fixture.name
            );
            assert!(
                !snippet.contains(OPENCODE_BOX_BORDER),
                "{} snippet still carries the composer border: {snippet:?}",
                fixture.name
            );
        }
    }

    /// The idle snippet ships with every `StatusChanged(Idle)`, so OpenCode's
    /// composer, rule and bottom bar have to read as chrome rather than as the
    /// agent's last words.
    #[test]
    fn opencode_idle_prompt_skips_composer_chrome() {
        for fixture in OPENCODE_FIXTURES
            .iter()
            .filter(|fixture| fixture.status == SessionStatus::Idle)
        {
            let snippet = fixture
                .replay()
                .waiting_prompt_snippet(&mut rules_for(AgentProvider::Opencode))
                .unwrap()
                .unwrap_or_else(|| panic!("{} produced no idle prompt", fixture.name));

            assert!(
                !snippet.contains(OPENCODE_BOX_BORDER)
                    && !snippet.contains('\u{2580}')
                    && !snippet.contains(OPENCODE_HINT_BAR_MARKER),
                "{} snippet is chrome, not content: {snippet:?}",
                fixture.name
            );
            // The captured turn's reply ends "…58 / 59 / 60".
            assert!(
                snippet.contains("60"),
                "{} snippet lost the agent's reply: {snippet:?}",
                fixture.name
            );
        }
    }

    /// The transcript above a bordered composer box is what the session said,
    /// and the shared chrome markers do not apply inside it: an agent whose
    /// last line names a file it wrote must keep that line, even though the
    /// path it names is also how a CLI's own footer is recognised.
    #[test]
    fn a_boxed_transcript_tail_keeps_a_reply_that_names_a_worktree_path() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Wrote /repo/.kanna-worktrees/task-9/NOTES.md\r\n",
                "\u{2503} Build \u{B7} Big Pickle OpenCode Zen\r\n",
            )
            .as_bytes(),
        );

        let snippet = headless_terminal
            .waiting_prompt_snippet(&mut rules_for(AgentProvider::Opencode))
            .unwrap()
            .expect("a parked OpenCode frame must publish what it last said");
        assert!(
            snippet.contains("NOTES.md"),
            "the agent's last words were dropped as chrome: {snippet:?}"
        );
    }

    #[test]
    fn antigravity_status_comes_from_visible_cancel_marker() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to cancel)\r\n› Review the implementation"
                .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Antigravity))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n›".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Antigravity))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn claude_status_comes_from_visible_interrupt_marker() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n❯ Find and fix a bug".as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n❯".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn claude_interrupt_marker_takes_priority_over_permission_footer() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "✻ Running tests\r\n",
                "────────────────────────────────────────────────────────────────\r\n",
                "✻ Working (4s • esc to interrupt)\r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn claude_subagent_footer_without_interrupt_marker_marks_busy() {
        let mut headless_terminal = HeadlessTerminal::new(140, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "Reviewing changes\r\n",
                "⏺ main\r\n",
                "  ◯ Explore  Verify firmware issue fixes                                      2m 31s · ↓ 44.2k tokens\r\n",
                "  ◯ Explore  Verify backend issue fixes\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn codex_resume_session_id_comes_from_visible_footer_content() {
        let mut headless_terminal = HeadlessTerminal::new(48, 6, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Header\r\n",
                "Done\r\n",
                "To continue this session, run codex\r\n",
                "resume 019d99a5-aa94-7c73-b786-644cc095c037\r\n",
                "›\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal.codex_resume_session_id().unwrap(),
            Some("019d99a5-aa94-7c73-b786-644cc095c037".to_string())
        );
    }

    #[test]
    fn claude_idle_composer_above_permission_footer_reports_idle() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "❯ foobar\r\n",
                "Please run /login\r\n",
                "────────────────────────────────────────────────────────────────\r\n",
                "❯ \r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn claude_idle_composer_above_permission_footer_reports_idle_with_blank_rows_below() {
        let mut headless_terminal = HeadlessTerminal::new(120, 42, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "Sonnet 4.6 with high effort\r\n",
                "~/.kanna/repos/foobar-11/.kanna-worktrees/task-079a9d8b\r\n",
                "\r\n",
                "❯ foobar\r\n",
                "Please run /login\r\n",
                "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n",
                "❯ \r\n",
                "⏵⏵ bypass permissions on (shift+tab to cycle)\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn captured_incident_claude_composer_reports_idle() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/claude/idle-composer-2.1.259-280x81.json"
        ))
        .unwrap();
        assert_eq!(fixture["inheritedStatus"], "busy");
        let snapshot: TerminalSnapshot =
            serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        let mut terminal = HeadlessTerminal::from_snapshot(&snapshot, 10_000).unwrap();

        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Empty
        );
    }

    fn claude_fixture_terminal(name: &str) -> HeadlessTerminal {
        let raw = std::fs::read_to_string(format!(
            "{}/tests/fixtures/claude/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut terminal = HeadlessTerminal::new(
            fixture["cols"].as_u64().unwrap() as u16,
            fixture["rows"].as_u64().unwrap() as u16,
            10_000,
        )
        .unwrap();
        terminal.write(fixture["serialized"].as_str().unwrap().as_bytes());
        terminal
    }

    /// The CLI release a captured frame came from, read out of the fixture
    /// rather than restated here: a re-capture that bumps the version moves
    /// the rules these assertions run under with it, instead of silently
    /// leaving them pinned to a release nobody runs any more.
    fn claude_fixture_classifier(name: &str) -> Classifier {
        let raw = std::fs::read_to_string(format!(
            "{}/tests/fixtures/claude/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let version = fixture["claudeVersion"]
            .as_str()
            .unwrap_or_else(|| panic!("{name} must record the CLI version it was captured from"));
        rules_for_version(AgentProvider::Claude, version)
    }

    /// Every captured frame, classified under the rules measured for the
    /// release it came from, must be decided by the rule written for it.
    ///
    /// Asserting the status alone is not enough. A frame that still lands on
    /// `busy` through a rule written for a different release is rule selection
    /// drifting — the exact failure version gating exists to prevent — and only
    /// the rule id can see it.
    #[test]
    fn captured_claude_frames_match_the_rule_measured_for_their_version() {
        for (fixture, status, rule) in [
            (
                "working-footer-2.1.263-171x65.json",
                SessionStatus::Busy,
                "claude/busy/working-footer",
            ),
            (
                "working-footer-first-paint-2.1.263-171x65.json",
                SessionStatus::Busy,
                "claude/busy/working-footer",
            ),
            (
                "parked-composer-status-bar-2.1.263-171x65.json",
                SessionStatus::Idle,
                "claude/idle/parked-composer",
            ),
        ] {
            let mut terminal = claude_fixture_terminal(fixture);
            let verdict = terminal
                .visible_verdict(&mut claude_fixture_classifier(fixture))
                .unwrap()
                .unwrap_or_else(|| panic!("{fixture} must classify"));
            assert_eq!(
                (verdict.status, verdict.rule_id.as_str()),
                (status, rule),
                "{fixture}"
            );
        }
    }

    /// The marker every Claude before 2.1.263 drew, and 2.1.263 does not.
    ///
    /// Both spellings of the truth coexist: a session on an older CLI still
    /// classifies from the footer hint, and a session on 2.1.263 does not
    /// match a hint its CLI cannot draw. Before rules carried version ranges
    /// this was one slot, and measuring it against either release broke the
    /// other.
    #[test]
    fn the_retired_interrupt_marker_applies_only_to_the_releases_that_drew_it() {
        let frame = [
            "Header".to_string(),
            "\u{2022} Working (12s \u{2022} esc to interrupt)".to_string(),
        ];
        let evidence = |lines: &[String]| -> Option<Verdict> {
            let lines = lines.to_vec();
            let mut classifier = rules_for_version(AgentProvider::Claude, "2.1.259");
            classifier.classify(&Evidence {
                lines: &lines,
                title: "",
                progress: None,
            })
        };
        let older = evidence(&frame).expect("2.1.259 must still classify its footer hint");
        assert_eq!(older.status, SessionStatus::Busy);
        assert_eq!(older.rule_id, "claude/busy/interrupt-marker");

        let mut newer = rules_for_version(AgentProvider::Claude, "2.1.263");
        assert_eq!(
            newer.classify(&Evidence {
                lines: &frame,
                title: "",
                progress: None,
            }),
            None,
            "2.1.263 draws no interrupt hint, so a rule measured against \
             earlier releases must not decide its frames"
        );

        // And an unprobed session keeps both, which is what it classified from
        // before rule selection existed.
        let unknown = rules_for(AgentProvider::Claude)
            .classify(&Evidence {
                lines: &frame,
                title: "",
                progress: None,
            })
            .expect("an unknown-version session must apply every measured rule");
        assert_eq!(unknown.rule_id, "claude/busy/interrupt-marker");
    }

    /// OpenCode renamed its working footer from "escape interrupt" (1.16.2) to
    /// "esc interrupt" (1.18.15) inside a single day. Both are pinned, each to
    /// the releases that drew it.
    #[test]
    fn opencode_interrupt_spellings_are_selected_by_cli_version() {
        let frame = ["\u{2B1D}\u{2B1D}\u{2B1D} escape interrupt tab agents".to_string()];
        let classify = |version: &str| {
            rules_for_version(AgentProvider::Opencode, version).classify(&Evidence {
                lines: &frame,
                title: "",
                progress: None,
            })
        };

        let older = classify("1.16.2").expect("1.16.2 drew this spelling");
        assert_eq!(older.status, SessionStatus::Busy);
        assert_eq!(older.rule_id, "opencode/busy/interrupt-marker");

        assert_eq!(
            classify("1.18.15"),
            None,
            "1.18.15 renamed the footer, so its rules must not match the old \
             spelling"
        );
    }

    /// The captured 1.18.15 frames, under the rules measured for 1.18.15.
    #[test]
    fn captured_opencode_frames_match_the_rule_measured_for_their_version() {
        for (fixture, rule) in [
            ("busy 120x40", "opencode/busy/interrupt-marker"),
            ("idle 120x40", "opencode/idle/composer-status"),
            ("permission 120x40", "opencode/waiting/permission-action"),
            ("busy 80x24", "opencode/busy/interrupt-marker"),
            ("idle 80x24", "opencode/idle/composer-status"),
            ("permission 80x24", "opencode/waiting/permission-action"),
        ] {
            let fixture = OPENCODE_FIXTURES
                .iter()
                .find(|candidate| candidate.name == fixture)
                .unwrap_or_else(|| panic!("{fixture} must exist"));
            let verdict = fixture
                .replay()
                .visible_verdict(&mut rules_for_version(
                    AgentProvider::Opencode,
                    OPENCODE_FIXTURE_CLI_VERSION,
                ))
                .unwrap()
                .unwrap_or_else(|| panic!("{} must classify", fixture.name));
            assert_eq!(
                (verdict.status, verdict.rule_id.as_str()),
                (fixture.status, rule),
                "{}",
                fixture.name
            );
        }
    }

    /// Claude sets its terminal title on every animation frame, and the title
    /// survives a repaint that leaves the grid unreadable. Read off the
    /// captured frames rather than assumed.
    #[test]
    fn captured_claude_frames_set_an_animated_terminal_title() {
        for (fixture, busy) in [
            ("working-footer-2.1.263-171x65.json", true),
            ("working-footer-first-paint-2.1.263-171x65.json", true),
            ("parked-composer-status-bar-2.1.263-171x65.json", false),
        ] {
            let title = claude_fixture_terminal(fixture).title();
            assert!(
                !title.is_empty(),
                "{fixture} should carry an OSC 0 title: {title:?}"
            );
            let animating = title.starts_with('\u{25D0}') || title.starts_with('\u{25D1}');
            assert_eq!(animating, busy, "{fixture} title was {title:?}");
        }
    }

    /// The title is additive, not authoritative: it decides only the frames the
    /// grid cannot read, which is the case that latches a stale status.
    #[test]
    fn a_busy_title_decides_only_a_frame_the_grid_cannot_read() {
        let unreadable = ["Building the workspace".to_string()];
        let mut classifier = rules_for_version(AgentProvider::Claude, "2.1.263");
        let verdict = classifier
            .classify(&Evidence {
                lines: &unreadable,
                title: "\u{25D0} Sleep command test",
                progress: None,
            })
            .expect("a busy title must answer a frame no grid rule matched");
        assert_eq!(verdict.status, SessionStatus::Busy);
        assert_eq!(verdict.rule_id, "claude/busy/title-spinner");
        assert_eq!(verdict.channel, Channel::Title);
    }

    /// And a grid verdict is never overruled by one.
    #[test]
    fn a_grid_verdict_outranks_a_busy_title() {
        let mut terminal =
            claude_fixture_terminal("parked-composer-status-bar-2.1.263-171x65.json");
        let lines = terminal.visible_footer_lines(STATUS_ROWS).unwrap();
        let mut classifier = rules_for_version(AgentProvider::Claude, "2.1.263");
        let verdict = classifier
            .classify(&Evidence {
                lines: &lines,
                title: "\u{25D0} Sleep command test",
                progress: None,
            })
            .expect("a parked frame must classify");
        assert_eq!(verdict.status, SessionStatus::Idle);
        assert_eq!(verdict.rule_id, "claude/idle/parked-composer");
    }

    /// A release before the title was measured gets no title rule at all.
    #[test]
    fn the_title_channel_is_version_gated_like_every_other_pattern() {
        let unreadable = ["Building the workspace".to_string()];
        assert_eq!(
            rules_for_version(AgentProvider::Claude, "2.1.259").classify(&Evidence {
                lines: &unreadable,
                title: "\u{25D0} Sleep command test",
                progress: None,
            }),
            None
        );
    }

    /// 2.1.263 draws no `esc to interrupt`, so the marker every earlier CLI
    /// carried cannot be what proves a Claude turn is in flight. Asserted on the
    /// captured frame rather than on the matcher, because the whole defect was a
    /// matcher that still believed the marker was there.
    #[test]
    fn captured_claude_working_frame_draws_no_interrupt_marker() {
        for fixture in [
            "working-footer-2.1.263-171x65.json",
            "working-footer-first-paint-2.1.263-171x65.json",
        ] {
            let mut terminal = claude_fixture_terminal(fixture);
            let footer = terminal.visible_footer_text(STATUS_ROWS).unwrap();
            assert!(
                !contains_ascii_case_insensitive(&footer, INTERRUPT_MARKER),
                "{fixture} unexpectedly carries the legacy busy marker: {footer}"
            );
        }
    }

    /// The first reported incident: a session that reported `idle` while it was
    /// visibly working. The frame carries a live footer *and* a drawn composer,
    /// so the composer must not win.
    #[test]
    fn captured_claude_working_footer_reports_busy() {
        for fixture in [
            "working-footer-2.1.263-171x65.json",
            "working-footer-first-paint-2.1.263-171x65.json",
        ] {
            let mut terminal = claude_fixture_terminal(fixture);
            assert_eq!(
                terminal
                    .visible_status(&mut rules_for(AgentProvider::Claude))
                    .unwrap(),
                Some(SessionStatus::Busy),
                "{fixture}"
            );
        }
    }

    /// A working frame still draws its composer, so the busy verdict above is
    /// not an artefact of the composer being absent.
    #[test]
    fn captured_claude_working_frame_still_draws_its_composer() {
        let mut terminal = claude_fixture_terminal("working-footer-2.1.263-171x65.json");
        let lines = terminal.visible_footer_lines(STATUS_ROWS).unwrap();
        assert!(
            lines.iter().any(|line| line_is_composer(line)),
            "expected a composer row in {lines:?}"
        );
    }

    /// The second reported incident, in the opposite direction: the same session
    /// once it has parked. Its status bar carries `/rc`, which used to leave the
    /// frame unclassifiable and the session latched at `busy`.
    #[test]
    fn captured_claude_parked_composer_below_status_bar_reports_idle() {
        let mut terminal =
            claude_fixture_terminal("parked-composer-status-bar-2.1.263-171x65.json");
        let lines = terminal.visible_footer_lines(STATUS_ROWS).unwrap();
        assert!(
            lines.iter().any(|line| line.trim() == "/rc"),
            "fixture should still carry the unmeasured status row: {lines:?}"
        );
        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    /// The captured parked frame carries `/rc` under its composer, and until
    /// that row was classified the composer read as unreadable — so every live
    /// Claude session on this machine answered `Unknown` and composer
    /// attestation could never fire on any of them.
    #[test]
    fn captured_claude_parked_composer_is_provably_empty() {
        let mut terminal =
            claude_fixture_terminal("parked-composer-status-bar-2.1.263-171x65.json");
        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Empty
        );
    }

    /// The 2026-09-07 owner report, on the real frame that produced it.
    ///
    /// Task `5d2f1c5c`'s live composer, captured unaltered from the daemon
    /// handoff log: `❯`, a no-break space, then `commit this` painted with
    /// SGR 2, with the CLI's own cursor left at the start of the line. The
    /// session's ledger said `typed`; the frame says the CLI drew it.
    #[test]
    fn captured_claude_faint_suggestion_proves_nothing_typed() {
        let mut terminal = HeadlessTerminal::new(260, 10, 10_000).unwrap();
        terminal.write(
            &std::fs::read(format!(
                "{}/tests/fixtures/claude/faint-suggestion-composer.ansi",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        );

        assert_eq!(
            terminal
                .composer_line(&mut rules_for(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("commit this")
        );
        assert_eq!(
            terminal
                .composer_state(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            ComposerState::SuggestionOnly
        );
    }

    /// What the retired `claude_spinner_without_interrupt_marker_does_not_mark_busy`
    /// was really guarding: a spinner-glyph row that is *not* live work must not
    /// read as busy. Claude rewrites its footer to the `done` form the instant a
    /// turn ends, and that is the form which persists in the transcript, so the
    /// ellipsis is what separates the two. Taken from the captured parked frame,
    /// which carries exactly that row.
    #[test]
    fn claude_done_footer_above_parked_composer_is_idle() {
        let mut terminal =
            claude_fixture_terminal("parked-composer-status-bar-2.1.263-171x65.json");
        let lines = terminal.visible_footer_lines(STATUS_ROWS).unwrap();
        let done_footer = lines
            .iter()
            .find(|line| line.contains(CLAUDE_DONE_FOOTER_MARKER))
            .expect("captured parked frame should carry a done footer");
        assert_eq!(
            verdict_for(AgentProvider::Claude, &[done_footer.as_str()])
                .map(|verdict| (verdict.status, verdict.rule_id)),
            Some((SessionStatus::Idle, "claude/idle/done-footer".to_string())),
            "a finished footer is not live work: {done_footer:?}"
        );
        assert_eq!(
            terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    /// The done footer is a second, independent route to Idle: this frame has
    /// no composer at all, so the structural rule cannot fire and only the
    /// footer proves the turn ended.
    #[test]
    fn claude_done_footer_reports_idle_without_a_composer() {
        let mut headless_terminal = HeadlessTerminal::new(120, 4, 10_000).unwrap();
        headless_terminal
            .write("All finished\r\n\u{273B} Cooked for 12s \u{B7} done 2:57 PM\r\n".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    /// A finished footer left on screen above a turn that has already started
    /// must not read as settled.
    #[test]
    fn claude_done_footer_does_not_outrank_a_live_turn() {
        let mut headless_terminal = HeadlessTerminal::new(120, 6, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "\u{273B} Cooked for 12s \u{B7} done 2:57 PM\r\n",
                "\u{23FA} Running 1 shell command\u{2026}\r\n",
                "\u{273B} Tomfoolering\u{2026} (2s \u{B7} \u{2193} 50 tokens)\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    /// A tall status bar can push the in-flight footer out of the classified
    /// window entirely. The composer box plus five status-bar rows already
    /// fills all eight, so the only rows left to read are Claude's own input
    /// chrome — and "everything below the composer is chrome" is then vacuously
    /// true. Reporting `Idle` off that window turns a running turn into a
    /// confidently wrong verdict, which is incident 1's exact symptom; the
    /// frame proves nothing, so the classifier must say nothing.
    #[test]
    fn claude_live_turn_behind_a_tall_status_bar_is_not_idle() {
        let mut headless_terminal = HeadlessTerminal::new(171, 30, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "\u{23FA} Running 1 shell command\u{2026}\r\n",
                "\u{273B} Tomfoolering\u{2026} (2s \u{B7} \u{2193} 50 tokens)\r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "\u{276F} \r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "  \u{23F5}\u{23F5} bypass permissions on (shift+tab to cycle) \u{B7} \u{2190} for agents\r\n",
                "  /rc\r\n",
                "  \u{25CF} high \u{B7} /effort\r\n",
                "  new task? /clear to save 390.7k tokens\r\n",
                "  \u{2714} Update installed \u{B7} Restart to update\r\n",
                "  \u{26A0} Your login will expire soon \u{B7} /login\r\n"
            )
            .as_bytes(),
        );

        // Pinned so the test keeps testing what it claims: the working footer
        // really is outside the rows the classifier reads.
        let classified = headless_terminal.visible_footer_lines(STATUS_ROWS).unwrap();
        assert!(
            classified
                .iter()
                .all(|line| verdict_for(AgentProvider::Claude, &[line.as_str()])
                    .is_none_or(|verdict| verdict.rule_id != "claude/busy/working-footer")),
            "fixture should push the footer out of the window: {classified:?}"
        );

        assert_ne!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle),
            "a frame that cannot see above the composer box must not claim Idle"
        );
    }

    /// The same guard must not cost a parked session its verdict when the
    /// window does reach above the box — which is every captured frame.
    #[test]
    fn claude_parked_composer_still_idle_when_the_window_reaches_above_the_box() {
        let mut headless_terminal = HeadlessTerminal::new(171, 30, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "\u{23FA} All finished\r\n",
                "\u{273B} Cooked for 12s \u{B7} done 2:57 PM\r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "\u{276F} \r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "  /rc\r\n",
                "  \u{23F5}\u{23F5} bypass permissions on (shift+tab to cycle)\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    /// Nor above a question the session is parked on.
    #[test]
    fn claude_done_footer_does_not_outrank_a_permission_prompt() {
        let mut headless_terminal = HeadlessTerminal::new(120, 6, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "\u{273B} Cooked for 12s \u{B7} done 2:57 PM\r\n",
                "Do you want to allow this command?\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Waiting)
        );
    }

    /// The canary is silent on every frame this repo has actually measured. If
    /// this starts failing, a fixture carries a footer form the constants no
    /// longer describe.
    #[test]
    fn captured_claude_frames_carry_no_unclassified_footer() {
        for fixture in [
            "working-footer-2.1.263-171x65.json",
            "working-footer-first-paint-2.1.263-171x65.json",
            "parked-composer-status-bar-2.1.263-171x65.json",
        ] {
            let mut terminal = claude_fixture_terminal(fixture);
            let lines = terminal.visible_footer_lines(STATUS_ROWS).unwrap();
            assert_eq!(
                rules_for(AgentProvider::Claude).unclassified_footer(&lines),
                None,
                "{fixture}"
            );
        }
    }

    /// And it fires on a footer shape the constants do not describe — the shape
    /// a future CLI change would arrive as.
    #[test]
    fn claude_unclassified_footer_flags_an_unmeasured_form() {
        let lines = vec![
            "Some transcript output".to_string(),
            "\u{273B} Cogitating for 3s".to_string(),
        ];
        assert_eq!(
            rules_for(AgentProvider::Claude).unclassified_footer(&lines),
            Some("\u{273B} Cogitating for 3s")
        );
    }

    /// One line per session, not one per rendered frame.
    #[test]
    fn claude_unclassified_footer_warns_once_per_session() {
        let mut headless_terminal = HeadlessTerminal::new(120, 4, 10_000).unwrap();
        headless_terminal.write("\u{273B} Cogitating for 3s\r\n".as_bytes());
        assert!(!headless_terminal.warned_unclassified_footer);

        headless_terminal
            .visible_status(&mut rules_for(AgentProvider::Claude))
            .unwrap();
        assert!(
            headless_terminal.warned_unclassified_footer,
            "an unmeasured footer should report itself once"
        );

        headless_terminal
            .visible_status(&mut rules_for(AgentProvider::Claude))
            .unwrap();
        assert!(headless_terminal.warned_unclassified_footer);
    }

    /// A transcript bullet is not an animation frame, even carrying the same
    /// ellipsis the live footer is keyed on.
    #[test]
    fn claude_transcript_bullet_with_an_ellipsis_is_not_a_working_footer() {
        for line in [
            "\u{23FA} Running 1 shell command\u{2026}",
            "Running 1 shell command\u{2026}",
        ] {
            assert!(
                verdict_for(AgentProvider::Claude, &[line])
                    .is_none_or(|verdict| verdict.rule_id != "claude/busy/working-footer"),
                "{line:?} is a transcript bullet, not an animation frame"
            );
        }
    }

    /// A live footer above a drawn composer still reports busy: the captured
    /// working frames prove Claude draws both at once, so the composer cannot
    /// veto the footer.
    #[test]
    fn claude_working_footer_outranks_a_drawn_composer() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "\u{273B} Thinking\u{2026} (12s \u{B7} \u{2193} 50 tokens)\r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "\u{276F} \r\n",
                "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n",
                "/rc\r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn copilot_busy_detects_wrapped_footer_marker() {
        let mut headless_terminal = HeadlessTerminal::new(8, 4, 10_000).unwrap();
        headless_terminal.write("Header\r\n(Esc to cancel)".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Copilot))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn copilot_idle_detects_prompt_footer() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write("Header\r\nDone\r\n❯".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Copilot))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn copilot_busy_detects_thinking_line_above_worktree_path() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "● You mentioned \"pizza\" again.\r\n",
                "◎ Thinking (Esc to cancel · 230 B)\r\n",
                "~/.kanna/repos/foobar-11/.kanna-worktrees/task-5b6a4e5e [⎇ task-5b6a4e5e%] GPT-4.1\r\n",
                "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n",
                "❯ \r\n",
                "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n",
                "v1.0.28 available · run /update · / commands · ? help\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Copilot))
                .unwrap(),
            Some(SessionStatus::Busy)
        );
    }

    #[test]
    fn copilot_idle_detects_empty_prompt_below_worktree_path_with_help_footer() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "● You mentioned \"pizza\" again.\r\n",
                "~/.kanna/repos/foobar-11/.kanna-worktrees/task-5b6a4e5e [⎇ task-5b6a4e5e%] GPT-4.1\r\n",
                "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n",
                "❯ \r\n",
                "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n",
                "v1.0.28 available · run /update · / commands · ? help\r\n",
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(&mut rules_for(AgentProvider::Copilot))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn debug_lines_returns_last_non_empty_rendered_rows() {
        let mut headless_terminal = HeadlessTerminal::new(20, 6, 10_000).unwrap();
        headless_terminal.write("Header\r\n\r\nThinking hard\r\n(Esc to cancel)\r\n".as_bytes());

        assert_eq!(
            headless_terminal.debug_lines(3).unwrap(),
            vec![
                "Header".to_string(),
                "Thinking hard".to_string(),
                "(Esc to cancel)".to_string(),
            ]
        );
    }

    #[test]
    fn initial_agent_sessions_start_busy() {
        assert_eq!(
            initial_session_status(Some(AgentProvider::Claude)),
            SessionStatus::Busy
        );
        assert_eq!(
            initial_session_status(Some(AgentProvider::Copilot)),
            SessionStatus::Busy
        );
        assert_eq!(
            initial_session_status(Some(AgentProvider::Codex)),
            SessionStatus::Busy
        );
        assert_eq!(
            initial_session_status(Some(AgentProvider::Opencode)),
            SessionStatus::Busy
        );
        assert_eq!(initial_session_status(None), SessionStatus::Idle);
    }
}
