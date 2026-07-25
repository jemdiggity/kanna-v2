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

    pub fn waiting_prompt_snippet(
        &mut self,
        provider: Option<AgentProvider>,
    ) -> HeadlessTerminalResult<Option<String>> {
        let Some(provider) = provider else {
            return Ok(None);
        };
        let footer_lines = self.visible_footer_lines_with_blank_boundaries(STATUS_ROWS)?;
        Ok(waiting_prompt_from_lines(&footer_lines, provider))
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
        AgentProvider::Opencode => trimmed == "OpenCode",
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
    let digit_count = trimmed.chars().take_while(char::is_ascii_digit).count();
    digit_count > 0
        && trimmed[digit_count..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '.' | ')'))
}

fn waiting_prompt_from_lines(lines: &[String], provider: AgentProvider) -> Option<String> {
    if let Some(question) = waiting_question_from_lines(lines) {
        return Some(question);
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

fn opencode_status_from_lines(lines: &[String]) -> Option<SessionStatus> {
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

    use super::{bound_waiting_prompt, initial_session_status, HeadlessTerminal, TerminalSnapshot};

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
    fn opencode_status_comes_from_visible_footer_content() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n› Review the implementation"
                .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Opencode))
                .unwrap(),
            Some(SessionStatus::Busy)
        );

        headless_terminal.write("\x1b[2J\x1b[HHeader\r\nBody\r\nAll done\r\n›".as_bytes());

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Opencode))
                .unwrap(),
            Some(SessionStatus::Idle)
        );
    }

    #[test]
    fn opencode_prompt_does_not_force_idle_while_interrupt_marker_is_visible() {
        let mut headless_terminal = HeadlessTerminal::new(80, 4, 10_000).unwrap();
        headless_terminal.write(
            "Header\r\nBody\r\n• Working(0s • esc to interrupt)\r\n› The tests are failing"
                .as_bytes(),
        );

        assert_eq!(
            headless_terminal
                .visible_status(Some(AgentProvider::Opencode))
                .unwrap(),
            Some(SessionStatus::Busy)
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
