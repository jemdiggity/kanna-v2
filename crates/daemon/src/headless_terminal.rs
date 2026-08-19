use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use ghostty_xterm_compat_serialize::serialize_terminal;
use libghostty_vt::{
    render::{CellIterator, RenderState, RowIterator},
    screen::CellWide,
    terminal::Mode,
    Terminal, TerminalOptions,
};

use crate::protocol::{AgentProvider, SessionStatus, TerminalSnapshot};

type HeadlessTerminalResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

// Ghostty's C API names this "max_scrollback", but it is a byte budget, not a
// row count. Budget against the full grid so 10K logical rows survive snapshot.
const GHOSTTY_SCROLLBACK_BYTES_PER_CELL: usize = 20;
const STATUS_ROWS: usize = 8;
const WAITING_PROMPT_MAX_CHARS: usize = 240;
const WAITING_PROMPT_MAX_LINES: usize = 3;
const WAITING_MARKER: &str = "do you want to allow";
const INTERRUPT_MARKER: &str = "esc to interrupt";
const COPILOT_BUSY_MARKER: &str = "esc to cancel";
const ANTIGRAVITY_BUSY_MARKER: &str = "esc to cancel";
const CLAUDE_IDLE_PROMPT: char = '\u{276F}';
const CODEX_IDLE_PROMPT: char = '\u{203A}';

// OpenCode's TUI, pinned against CLI 1.18.15. Every constant below was read off
// real captured frames — `crates/daemon/tests/fixtures/opencode/*.ansi`, which
// the tests at the bottom of this file replay — rather than written from the
// shape the matcher happened to expect. OpenCode draws none of the markers the
// other providers use: before this was measured, `opencode_status_from_lines`
// matched nothing at all and every live session sat at its initial `Busy`
// forever (docs/2026-08-08-opencode-live-idle-detection-e2e-gap.md).

/// The left border OpenCode draws down its composer box, and down every dialog
/// it renders inside that box.
const OPENCODE_BOX_BORDER: char = '\u{2503}';
/// The working footer, drawn only while a turn is in flight.
///
/// Three spellings, because OpenCode used two of them inside a single day:
/// 1.16.2 rendered "escape interrupt" and 1.18.15 renders "esc interrupt".
/// Pinning every spelling seen — including the one the other providers use — is
/// what keeps a CLI upgrade from silently costing `Busy` detection.
const OPENCODE_INTERRUPT_MARKERS: &[&str] =
    &["escape interrupt", "esc interrupt", INTERRUPT_MARKER];
/// The permission dialog's action row, which is what makes the dialog
/// *detectable*: its "△ Permission required" header sits several rows above the
/// bottom — outside the status window on a tall terminal — while this row is
/// always the second-to-last line on screen.
const OPENCODE_PERMISSION_ACTIONS: &[&str] = &["allow once", "allow always"];
/// The turn-summary glyph that replaces the working footer once a turn ends
/// ("▣ Build · Big Pickle · 3.0s").
const OPENCODE_TURN_SUMMARY_GLYPH: char = '\u{25A3}';
/// The progress cells the working footer is drawn from ("⬝⬝⬝⬝⬝⬝⬝⬝", "⬝⬝⬝⬝⬝⬝■■").
const OPENCODE_PROGRESS_GLYPHS: &[char] = &['\u{2B1D}', '\u{25A0}'];
/// The half-block glyphs OpenCode's splash banner, composer rule and scrollbar
/// gutter are drawn from. Text-free, so none of it belongs in a snippet.
const OPENCODE_BLOCK_GLYPHS: &[char] = &[
    '\u{2579}', '\u{2580}', '\u{2584}', '\u{2588}', '\u{258C}', '\u{2590}',
];
/// The bottom hint bar. Dropped on a narrow terminal and wrapped on a narrower
/// one still, so it is usable as chrome to skip but useless as a state marker.
const OPENCODE_HINT_BAR_MARKER: &str = "ctrl+p commands";
/// OpenCode's permission dialog is taller than the status window: reading *what*
/// it is asking needs the rows above the action row, while deciding *that* it is
/// asking does not.
const OPENCODE_WAITING_PROMPT_ROWS: usize = 24;

/// What the rendered terminal proves about a session's composer.
///
/// There is no "a draft is present" answer on purpose. This exists to resolve
/// inherited draft state — whether a session the daemon did not watch being
/// typed into is holding an unsubmitted line — and only one of the two answers
/// can be proven from a frame: an empty composer holds nothing. Everything
/// else, including a line the daemon cannot explain, is `Unknown` and stays
/// the operator's call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerState {
    /// The provider's own idle composer chrome is on screen with nothing typed
    /// into it. A positive match on rendered chrome, never an inference from a
    /// quiet session.
    Empty,
    /// Not provably empty: a draft, a suggestion the daemon cannot tell from a
    /// draft, a dialog, a busy frame, a provider whose empty composer has not
    /// been measured, or a screen that has not drawn a composer yet.
    Unknown,
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
    rows: u16,
    cols: u16,
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
            rows,
            cols,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.terminal.vt_write(bytes);
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

    pub fn visible_status(
        &mut self,
        provider: Option<AgentProvider>,
    ) -> HeadlessTerminalResult<Option<SessionStatus>> {
        let Some(provider) = provider else {
            return Ok(None);
        };

        let footer_lines = self.visible_footer_lines(STATUS_ROWS)?;
        let status = match provider {
            AgentProvider::Claude => claude_status_from_lines(&footer_lines),
            AgentProvider::Codex => codex_status_from_lines(&footer_lines),
            AgentProvider::Opencode => opencode_status_from_lines(&footer_lines),
            AgentProvider::Antigravity => antigravity_status_from_lines(&footer_lines),
            AgentProvider::Copilot => copilot_status_from_lines(&footer_lines),
        };

        Ok(status)
    }

    pub fn composer_state(
        &mut self,
        provider: Option<AgentProvider>,
    ) -> HeadlessTerminalResult<ComposerState> {
        let Some(provider) = provider else {
            return Ok(ComposerState::Unknown);
        };
        let footer_lines = self.visible_footer_lines(STATUS_ROWS)?;
        Ok(composer_state_from_lines(&footer_lines, provider))
    }

    pub fn waiting_prompt_snippet(
        &mut self,
        provider: Option<AgentProvider>,
    ) -> HeadlessTerminalResult<Option<String>> {
        let Some(provider) = provider else {
            return Ok(None);
        };
        let rows = match provider {
            AgentProvider::Opencode => OPENCODE_WAITING_PROMPT_ROWS,
            _ => STATUS_ROWS,
        };
        let footer_lines = self.visible_footer_lines_with_blank_boundaries(rows)?;
        Ok(waiting_prompt_from_lines(&footer_lines, provider))
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

pub fn bound_waiting_prompt(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }

    let chars = normalized.chars().collect::<Vec<_>>();
    if chars.len() <= WAITING_PROMPT_MAX_CHARS {
        return Some(normalized);
    }

    let mut bounded = chars[..WAITING_PROMPT_MAX_CHARS - 1]
        .iter()
        .collect::<String>();
    bounded.push('…');
    Some(bounded)
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

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    let needle_bytes = needle.as_bytes();
    if needle_bytes.is_empty() {
        return true;
    }

    haystack
        .as_bytes()
        .windows(needle_bytes.len())
        .any(|window| window.eq_ignore_ascii_case(needle_bytes))
}

fn any_line_contains_ascii_case_insensitive(lines: &[String], needle: &str) -> bool {
    lines
        .iter()
        .any(|line| contains_ascii_case_insensitive(line, needle))
        || lines.windows(2).any(|pair| {
            let mut combined = String::with_capacity(pair[0].len() + pair[1].len() + 1);
            combined.push_str(&pair[0]);
            combined.push(' ');
            combined.push_str(&pair[1]);
            contains_ascii_case_insensitive(&combined, needle)
        })
}

fn last_non_empty_line(lines: &[String]) -> &str {
    lines
        .iter()
        .rev()
        .find(|line| !line.is_empty())
        .map(String::as_str)
        .unwrap_or("")
}

fn line_starts_with_prompt(line: &str, prompts: &[char]) -> bool {
    line.trim_start()
        .chars()
        .next()
        .is_some_and(|ch| prompts.contains(&ch))
}

fn prompt_remainder<'a>(line: &'a str, prompts: &[char]) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let mut chars = trimmed.char_indices();
    let (_, first) = chars.next()?;
    if !prompts.contains(&first) {
        return None;
    }

    let remainder_index = chars.next().map_or(trimmed.len(), |(index, _)| index);
    Some(trimmed[remainder_index..].trim())
}

fn line_contains_worktree_path(line: &str) -> bool {
    line.contains(".kanna-worktrees/") || line.contains("[⎇ ")
}

/// OpenCode's block art: the rule under the composer ("╹▀▀▀▀…") and the splash
/// banner. Text-free, so nothing in it belongs in a prompt snippet.
fn opencode_line_is_block_art(trimmed: &str) -> bool {
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|character| character == ' ' || OPENCODE_BLOCK_GLYPHS.contains(&character))
}

/// Everything OpenCode paints that is frame rather than content: the composer
/// box and its dialogs, the rule under it, and the bottom bar in each of its
/// three forms (bare hint bar, working footer, turn summary).
fn opencode_line_is_chrome(trimmed: &str) -> bool {
    line_starts_with_prompt(trimmed, &[OPENCODE_BOX_BORDER])
        || opencode_line_is_block_art(trimmed)
        || contains_ascii_case_insensitive(trimmed, OPENCODE_HINT_BAR_MARKER)
        || opencode_line_has_interrupt_marker(trimmed)
        || line_starts_with_prompt(trimmed, &[OPENCODE_TURN_SUMMARY_GLYPH])
        || line_starts_with_prompt(trimmed, OPENCODE_PROGRESS_GLYPHS)
}

fn line_is_visual_divider(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|character| matches!(character, '─' | '━' | '—' | '-' | ' '))
}

fn line_is_claude_spinner(line: &str) -> bool {
    const SPINNER_GLYPHS: &[char] = &['✻', '✽', '✶', '✳', '✢', '✣', '✤', '✥'];
    let mut characters = line.trim_start().chars();
    let Some(first) = characters.next() else {
        return false;
    };
    SPINNER_GLYPHS.contains(&first) && characters.next().is_some_and(char::is_whitespace)
}

fn line_is_provider_chrome(line: &str, provider: AgentProvider) -> bool {
    let trimmed = line.trim();
    let common_chrome = trimmed.is_empty()
        || line_is_visual_divider(trimmed)
        || line_starts_with_prompt(trimmed, &[CLAUDE_IDLE_PROMPT, CODEX_IDLE_PROMPT])
        || line_contains_worktree_path(trimmed)
        || contains_ascii_case_insensitive(trimmed, INTERRUPT_MARKER)
        || contains_ascii_case_insensitive(trimmed, COPILOT_BUSY_MARKER)
        || contains_ascii_case_insensitive(trimmed, ANTIGRAVITY_BUSY_MARKER)
        || contains_ascii_case_insensitive(trimmed, "bypass permissions")
        || contains_ascii_case_insensitive(trimmed, "/ commands");
    if common_chrome {
        return true;
    }

    match provider {
        AgentProvider::Claude => {
            trimmed == "Claude Code"
                || line_is_claude_spinner(trimmed)
                || (["Sonnet", "Opus", "Haiku"]
                    .iter()
                    .any(|model| trimmed.starts_with(model))
                    && contains_ascii_case_insensitive(trimmed, " with "))
        }
        AgentProvider::Codex => {
            trimmed == "OpenAI Codex"
                || trimmed.starts_with("◦ Working")
                || (trimmed.contains(" · ")
                    && (trimmed.starts_with("gpt-")
                        || trimmed.starts_with("o1")
                        || trimmed.starts_with("o3")
                        || trimmed.starts_with("o4")))
        }
        AgentProvider::Opencode => trimmed == "OpenCode" || opencode_line_is_chrome(trimmed),
        AgentProvider::Antigravity => trimmed == "Antigravity",
        AgentProvider::Copilot => trimmed == "GitHub Copilot",
    }
}

fn waiting_question_from_lines(lines: &[String]) -> Option<String> {
    let start = lines
        .iter()
        .rposition(|line| contains_ascii_case_insensitive(line, WAITING_MARKER))
        .or_else(|| {
            lines.windows(2).rposition(|pair| {
                contains_ascii_case_insensitive(&format!("{} {}", pair[0], pair[1]), WAITING_MARKER)
            })
        })?;

    let mut question = Vec::new();
    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if question.is_empty() {
                continue;
            }
            break;
        }
        if !question.is_empty() && line_is_permission_option(trimmed) {
            break;
        }
        question.push(trimmed);
        if trimmed.ends_with('?') || question.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    bound_waiting_prompt(&question.join(" "))
}

fn line_is_permission_option(line: &str) -> bool {
    let trimmed = prompt_remainder(line, &[CLAUDE_IDLE_PROMPT, CODEX_IDLE_PROMPT])
        .unwrap_or(line)
        .trim_start();
    starts_numbered_option(trimmed)
}

fn starts_numbered_option(text: &str) -> bool {
    let digit_count = text.chars().take_while(char::is_ascii_digit).count();
    digit_count > 0
        && text[digit_count..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '.' | ')'))
}

/// A selected option in an interactive menu: the caret is on a numbered choice
/// rather than on an empty input box.
///
/// This is what makes an AskUserQuestion menu ("rebase and force-push / …")
/// visible. Those carry none of the permission-prompt wording, and the caret
/// alone reads as the idle input box — so without this a task parked on a
/// question looked exactly like a task waiting for its next instruction.
///
/// It is a positive match on rendered chrome, never an inference from silence:
/// a session running a long build shows no caret-on-option line and is never
/// reported as waiting. The one benign overlap is a human who typed a line
/// beginning "1." into the input box and did not send it — a task that is, in
/// fact, waiting on its human.
fn line_is_selected_menu_option(line: &str) -> bool {
    prompt_remainder(line, &[CLAUDE_IDLE_PROMPT]).is_some_and(starts_numbered_option)
}

/// The question a menu is asking, read from the lines above its first option.
/// Scanning from the bottom instead would return the option list, which tells a
/// watcher what the choices are but not what is being decided.
fn waiting_question_above_menu(lines: &[String]) -> Option<String> {
    let menu_index = lines
        .iter()
        .position(|line| line_is_selected_menu_option(line))?;

    let mut question = Vec::new();
    for line in lines[..menu_index].iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || line_is_visual_divider(trimmed) {
            if question.is_empty() {
                continue;
            }
            break;
        }
        if line_is_permission_option(trimmed) {
            break;
        }
        question.push(trimmed);
        if question.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    question.reverse();
    bound_waiting_prompt(&question.join(" "))
}

/// What OpenCode's permission dialog is asking, read from inside the composer
/// box: the "△ Permission required" header and the command underneath it. The
/// generic scans cannot find it — every line carries the box border, so the
/// dialog looks like chrome — and the border is stripped here so the snippet
/// reads as a question rather than as box drawing.
fn opencode_permission_question(lines: &[String]) -> Option<String> {
    let action_index = lines
        .iter()
        .rposition(|line| opencode_line_is_permission_action(line))?;

    // The dialog is the contiguous run of bordered rows ending at the action
    // row. Walking up to its first row matters on a narrow terminal, where the
    // window also reaches the echoed user message — itself drawn in a bordered
    // block, and the wrong answer to "what is being decided".
    let mut start = action_index;
    while start > 0 && line_starts_with_prompt(&lines[start - 1], &[OPENCODE_BOX_BORDER]) {
        start -= 1;
    }

    let mut question = Vec::new();
    for line in &lines[start..action_index] {
        let Some(body) = prompt_remainder(line, &[OPENCODE_BOX_BORDER]) else {
            continue;
        };
        if body.is_empty() {
            continue;
        }
        question.push(body);
        if question.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    bound_waiting_prompt(&question.join(" "))
}

/// The agent's last words, read from above the composer box.
///
/// This is the snippet that ships with every `StatusChanged(Idle)`. OpenCode's
/// bottom bar is the project path plus token counters and it *wraps* on a
/// narrow terminal, so recognising it line by line is a losing game; the
/// composer box is the reliable landmark instead. Everything from its first
/// bordered row down is frame, and everything above it is transcript.
fn opencode_transcript_tail(lines: &[String]) -> Option<String> {
    let composer_index = lines
        .iter()
        .position(|line| line_starts_with_prompt(line, &[OPENCODE_BOX_BORDER]))?;

    let mut content = Vec::new();
    for line in lines[..composer_index].iter().rev() {
        // OpenCode paints a scrollbar in the right-hand gutter, so a transcript
        // row can end in a stray block glyph that is not part of what was said.
        let trimmed = line
            .trim()
            .trim_end_matches(OPENCODE_BLOCK_GLYPHS)
            .trim_end();
        if trimmed.is_empty() || opencode_line_is_chrome(trimmed) {
            if content.is_empty() {
                continue;
            }
            break;
        }
        content.push(trimmed);
        if content.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    content.reverse();
    bound_waiting_prompt(&content.join(" "))
}

fn waiting_prompt_from_lines(lines: &[String], provider: AgentProvider) -> Option<String> {
    if let Some(question) = waiting_question_from_lines(lines) {
        return Some(question);
    }
    if let Some(question) = waiting_question_above_menu(lines) {
        return Some(question);
    }
    if provider == AgentProvider::Opencode {
        if let Some(question) = opencode_permission_question(lines) {
            return Some(question);
        }
        if let Some(tail) = opencode_transcript_tail(lines) {
            return Some(tail);
        }
    }

    let mut content = Vec::new();
    for line in lines.iter().rev() {
        if line_is_provider_chrome(line, provider) {
            if content.is_empty() {
                continue;
            }
            break;
        }
        content.push(line.trim());
        if content.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    content.reverse();
    bound_waiting_prompt(&content.join(" "))
}

fn claude_line_starts_subagent_parent(line: &str) -> bool {
    line.trim_start().starts_with("⏺ ")
}

fn claude_line_starts_subagent_task(line: &str) -> bool {
    line.trim_start().starts_with("◯ ")
}

fn claude_lines_have_active_subagent_footer(lines: &[String]) -> bool {
    let Some(parent_index) = lines
        .iter()
        .rposition(|line| claude_line_starts_subagent_parent(line))
    else {
        return false;
    };

    let lines_after_parent = &lines[parent_index + 1..];
    lines_after_parent
        .iter()
        .any(|line| claude_line_starts_subagent_task(line))
        && !lines_after_parent
            .iter()
            .any(|line| line_starts_with_prompt(line, &[CLAUDE_IDLE_PROMPT]))
}

fn claude_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
    if any_line_contains_ascii_case_insensitive(lines, WAITING_MARKER) {
        return Some(SessionStatus::Waiting);
    }
    if any_line_contains_ascii_case_insensitive(lines, INTERRUPT_MARKER) {
        return Some(SessionStatus::Busy);
    }
    if claude_lines_have_active_subagent_footer(lines) {
        return Some(SessionStatus::Busy);
    }
    if lines.iter().any(|line| line_is_selected_menu_option(line)) {
        return Some(SessionStatus::Waiting);
    }
    if line_starts_with_prompt(last_non_empty_line(lines), &[CLAUDE_IDLE_PROMPT]) {
        return Some(SessionStatus::Idle);
    }

    None
}

fn codex_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
    if any_line_contains_ascii_case_insensitive(lines, WAITING_MARKER) {
        return Some(SessionStatus::Waiting);
    }
    if any_line_contains_ascii_case_insensitive(lines, INTERRUPT_MARKER) {
        return Some(SessionStatus::Busy);
    }
    if line_starts_with_prompt(last_non_empty_line(lines), &[CODEX_IDLE_PROMPT]) {
        return Some(SessionStatus::Idle);
    }

    None
}

/// Read the composer out of a rendered frame.
///
/// Claude and Codex only: both draw a single-glyph prompt with the draft
/// immediately after it, so an empty remainder on that line *is* the proof
/// that nothing is typed. OpenCode, Antigravity and Copilot draw composers
/// whose empty state has never been captured here, and this file's rule is
/// that unmeasured chrome matches nothing rather than being written from the
/// shape a matcher happened to expect.
///
/// The composer is the last prompt line in the window, with only provider
/// chrome below it — Claude draws its permission-mode hint under the composer,
/// so the composer is frequently not the last line on screen. A busy or
/// waiting frame is refused outright: its empty composer is true but its
/// screen is mid-repaint, and nothing needs an answer from a session that is
/// still working.
fn composer_state_from_lines(lines: &[String], provider: AgentProvider) -> ComposerState {
    let prompt = match provider {
        AgentProvider::Claude => CLAUDE_IDLE_PROMPT,
        AgentProvider::Codex => CODEX_IDLE_PROMPT,
        AgentProvider::Opencode | AgentProvider::Antigravity | AgentProvider::Copilot => {
            return ComposerState::Unknown
        }
    };
    let status = match provider {
        AgentProvider::Claude => claude_status_from_lines(lines),
        AgentProvider::Codex => codex_status_from_lines(lines),
        _ => None,
    };
    if matches!(
        status,
        Some(SessionStatus::Busy) | Some(SessionStatus::Waiting)
    ) {
        return ComposerState::Unknown;
    }
    let Some(composer_index) = lines
        .iter()
        .rposition(|line| line_starts_with_prompt(line, &[prompt]))
    else {
        return ComposerState::Unknown;
    };
    if lines[composer_index + 1..]
        .iter()
        .any(|line| !line_is_provider_chrome(line, provider))
    {
        return ComposerState::Unknown;
    }
    match prompt_remainder(&lines[composer_index], &[prompt]) {
        Some("") => ComposerState::Empty,
        _ => ComposerState::Unknown,
    }
}

fn opencode_line_has_interrupt_marker(line: &str) -> bool {
    OPENCODE_INTERRUPT_MARKERS
        .iter()
        .any(|marker| contains_ascii_case_insensitive(line, marker))
}

/// OpenCode's permission dialog, matched on its action row:
/// "Allow once  Allow always  Reject   ⇆ select  enter confirm  esc reject".
fn opencode_line_is_permission_action(line: &str) -> bool {
    OPENCODE_PERMISSION_ACTIONS
        .iter()
        .all(|action| contains_ascii_case_insensitive(line, action))
}

/// The composer's status line — "┃ Build · Big Pickle OpenCode Zen": mode and
/// model, inside the input box. 1.16.2 appended the variant as a third field;
/// one separator is all this needs.
///
/// Matching on the separator rather than the mode word is load-bearing: what
/// sits left of the dot varies with the spawn's flags. Kanna's own PTY spawn
/// passes a permission-bypass flag, which badges the mode — it draws
/// "┃ Build auto · Big Pickle OpenCode Zen".
///
/// This is the idle marker because it is the only composer chrome that survived
/// every width measured (80, 100, 120 and 160 columns) *and* both CLI versions
/// seen: the hint bar below it is not drawn on a narrow terminal, and the
/// working footer's wording changed under us mid-investigation. It stays a
/// positive match on rendered chrome, never an inference from silence: a
/// session that has not drawn its composer yet, or that has replaced it with
/// the permission dialog, matches nothing and leaves the previous status in
/// place.
fn opencode_line_is_composer_status(line: &str) -> bool {
    prompt_remainder(line, &[OPENCODE_BOX_BORDER])
        .is_some_and(|remainder| remainder.contains(" \u{B7} "))
}

fn opencode_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
    if any_line_contains_ascii_case_insensitive(lines, WAITING_MARKER)
        || lines
            .iter()
            .any(|line| opencode_line_is_permission_action(line))
    {
        return Some(SessionStatus::Waiting);
    }
    if lines
        .iter()
        .any(|line| opencode_line_has_interrupt_marker(line))
    {
        return Some(SessionStatus::Busy);
    }
    if lines
        .iter()
        .any(|line| opencode_line_is_composer_status(line))
    {
        return Some(SessionStatus::Idle);
    }

    None
}

fn antigravity_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
    if any_line_contains_ascii_case_insensitive(lines, WAITING_MARKER) {
        return Some(SessionStatus::Waiting);
    }
    if any_line_contains_ascii_case_insensitive(lines, ANTIGRAVITY_BUSY_MARKER) {
        return Some(SessionStatus::Busy);
    }
    if line_starts_with_prompt(last_non_empty_line(lines), &[CODEX_IDLE_PROMPT]) {
        return Some(SessionStatus::Idle);
    }

    None
}

fn copilot_line_has_busy_marker(line: &str) -> bool {
    contains_ascii_case_insensitive(line, COPILOT_BUSY_MARKER)
        || contains_ascii_case_insensitive(line, "thinking ")
}

fn copilot_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
    if any_line_contains_ascii_case_insensitive(lines, WAITING_MARKER) {
        return Some(SessionStatus::Waiting);
    }

    if let Some(path_index) = lines
        .iter()
        .rposition(|line| line_contains_worktree_path(line))
    {
        if path_index > 0 && copilot_line_has_busy_marker(&lines[path_index - 1]) {
            return Some(SessionStatus::Busy);
        }

        let path_relative_status = lines
            .iter()
            .skip(path_index + 1)
            .find_map(|line| prompt_remainder(line, &[CLAUDE_IDLE_PROMPT]))
            .filter(|remainder| remainder.is_empty())
            .map(|_| SessionStatus::Idle);
        if path_relative_status.is_some() {
            return path_relative_status;
        }
    }

    if any_line_contains_ascii_case_insensitive(lines, COPILOT_BUSY_MARKER) {
        return Some(SessionStatus::Busy);
    }
    if line_starts_with_prompt(last_non_empty_line(lines), &[CLAUDE_IDLE_PROMPT]) {
        return Some(SessionStatus::Idle);
    }

    None
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::protocol::{AgentProvider, SessionStatus};

    use super::{
        bound_waiting_prompt, initial_session_status, ComposerState, HeadlessTerminal,
        TerminalSnapshot,
    };

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
        assert!(super::contains_ascii_case_insensitive(
            "• Working (0s • Esc To Interrupt)",
            super::INTERRUPT_MARKER
        ));
        assert!(!super::contains_ascii_case_insensitive(
            "Thinking hard",
            super::INTERRUPT_MARKER
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

        let snapshot = headless_terminal.snapshot().unwrap();

        assert!(!snapshot.cursor_visible);
        assert!(!snapshot.vt.contains("\x1b[?2026h"));
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
                .waiting_prompt_snippet(Some(AgentProvider::Codex))
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
                .waiting_prompt_snippet(Some(AgentProvider::Codex))
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
                .waiting_prompt_snippet(Some(AgentProvider::Codex))
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
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
            terminal.visible_status(Some(AgentProvider::Codex)).unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(Some(AgentProvider::Codex))
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Waiting)
        );
        assert_eq!(
            terminal
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
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
                .composer_state(Some(AgentProvider::Claude))
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
                .composer_state(Some(AgentProvider::Claude))
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
                .composer_state(Some(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
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
            busy.composer_state(Some(AgentProvider::Claude)).unwrap(),
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
            waiting.composer_state(Some(AgentProvider::Claude)).unwrap(),
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
                .composer_state(Some(AgentProvider::Claude))
                .unwrap(),
            ComposerState::Unknown
        );
    }

    #[test]
    fn codex_empty_composer_is_provably_empty() {
        let mut terminal = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        terminal.write(concat!("OpenAI Codex\r\n", "Done.\r\n", "› \r\n").as_bytes());

        assert_eq!(
            terminal.composer_state(Some(AgentProvider::Codex)).unwrap(),
            ComposerState::Empty
        );

        let mut drafted = HeadlessTerminal::new(120, 10, 10_000).unwrap();
        drafted.write(concat!("OpenAI Codex\r\n", "Done.\r\n", "› why did\r\n").as_bytes());
        assert_eq!(
            drafted.composer_state(Some(AgentProvider::Codex)).unwrap(),
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
            terminal.composer_state(None).unwrap(),
            ComposerState::Unknown
        );
        for provider in [
            AgentProvider::Opencode,
            AgentProvider::Antigravity,
            AgentProvider::Copilot,
        ] {
            assert_eq!(
                terminal.composer_state(Some(provider)).unwrap(),
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
                    .composer_state(Some(AgentProvider::Opencode))
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
                .visible_status(Some(AgentProvider::Claude))
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
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
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
                .visible_status(Some(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n›".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Codex))
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
                .visible_status(Some(AgentProvider::Codex))
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
                .visible_status(Some(AgentProvider::Codex))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            headless_terminal
                .waiting_prompt_snippet(Some(AgentProvider::Codex))
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
                .visible_status(Some(AgentProvider::Codex))
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
                    .visible_status(Some(AgentProvider::Opencode))
                    .unwrap(),
                Some(fixture.status),
                "{} reported the wrong status. Rendered footer:\n{}",
                fixture.name,
                headless_terminal
                    .visible_footer_text(super::STATUS_ROWS)
                    .unwrap(),
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
                    .visible_status(Some(AgentProvider::Opencode))
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
                .visible_status(Some(AgentProvider::Opencode))
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
                    .visible_status(Some(AgentProvider::Opencode))
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
                    .visible_status(Some(AgentProvider::Opencode))
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
                .waiting_prompt_snippet(Some(AgentProvider::Opencode))
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
                !snippet.contains(super::OPENCODE_BOX_BORDER),
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
                .waiting_prompt_snippet(Some(AgentProvider::Opencode))
                .unwrap()
                .unwrap_or_else(|| panic!("{} produced no idle prompt", fixture.name));

            assert!(
                !snippet.contains(super::OPENCODE_BOX_BORDER)
                    && !snippet.contains('\u{2580}')
                    && !snippet.contains(super::OPENCODE_HINT_BAR_MARKER),
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

    #[test]
    fn antigravity_status_comes_from_visible_cancel_marker() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to cancel)\r\n› Review the implementation"
                .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Antigravity))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n›".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Antigravity))
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n❯".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Claude))
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
                .visible_status(Some(AgentProvider::Claude))
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
                .visible_status(Some(AgentProvider::Claude))
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
    fn claude_permission_footer_without_interrupt_marker_does_not_map_to_waiting() {
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            None
        );
    }

    #[test]
    fn claude_permission_footer_without_interrupt_marker_does_not_map_to_waiting_even_with_blank_rows_below(
    ) {
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
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            None
        );
    }

    #[test]
    fn claude_spinner_without_interrupt_marker_does_not_mark_busy() {
        let mut headless_terminal = HeadlessTerminal::new(120, 8, 10_000).unwrap();
        headless_terminal.write(
            concat!(
                "Claude Code\r\n",
                "✻ Thinking…\r\n",
                "All done\r\n",
                "❯ \r\n"
            )
            .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Claude))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
        assert_eq!(
            headless_terminal
                .waiting_prompt_snippet(Some(AgentProvider::Claude))
                .unwrap()
                .as_deref(),
            Some("All done")
        );
    }

    #[test]
    fn copilot_busy_detects_wrapped_footer_marker() {
        let mut headless_terminal = HeadlessTerminal::new(8, 4, 10_000).unwrap();
        headless_terminal.write("Header\r\n(Esc to cancel)".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Copilot))
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
                .visible_status(Some(AgentProvider::Copilot))
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
                .visible_status(Some(AgentProvider::Copilot))
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
                .visible_status(Some(AgentProvider::Copilot))
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
