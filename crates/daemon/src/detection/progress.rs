//! OSC 9 progress reports as a classification channel.
//!
//! A CLI that reports progress out of band is telling the terminal what it is
//! doing in a form that survives a full-screen repaint, a synchronized-output
//! bracket, and a window resize — everything that can leave the rendered grid
//! momentarily unreadable. That makes it exactly the right evidence for the
//! failure this architecture exists to fix: a frame the grid rules cannot read
//! leaves the session latched at whatever status it last had.
//!
//! **No agent CLI measured here emits one today.** The scanner exists anyway,
//! because the point of moving patterns into data is that a provider shipping
//! progress reports becomes a rule-file edit rather than a daemon release. The
//! bundled rule file therefore ships no progress rules, and this reports
//! `None` for every session until one does.
//!
//! The sequence is ConEmu's, as implemented by Windows Terminal and now widely
//! emitted by build tools: `ESC ] 9 ; 4 ; <state> ; <progress> BEL`, or the
//! same payload terminated by `ESC \`.

use super::schema::ProgressState;

/// The last progress report a session emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressReport {
    pub state: ProgressState,
    /// The reported percentage, where the state carries one.
    pub percent: Option<u8>,
}

/// Longest payload worth buffering. An OSC 9;4 report is under twenty bytes;
/// anything longer is a different OSC command (a desktop notification, a
/// hyperlink) that this scanner has no interest in and must not accumulate
/// unboundedly.
const MAX_PAYLOAD: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    /// Outside any escape sequence.
    Text,
    /// Saw `ESC`.
    Escape,
    /// Inside `ESC ] ...`, buffering the payload.
    Payload,
    /// Saw `ESC` while buffering: the next byte decides whether it terminated
    /// the sequence (`\`) or started a new one.
    PayloadEscape,
}

/// Incremental scanner over the raw PTY byte stream.
///
/// Incremental because PTY reads split wherever the kernel decides: a report
/// can arrive with its state in one chunk and its percentage in the next, and
/// a scanner that only looked inside single chunks would miss exactly the
/// reports emitted during heavy output.
#[derive(Debug)]
pub struct ProgressScanner {
    state: ScanState,
    payload: String,
    /// True once the payload is known not to be an OSC 9 report, so the rest
    /// of it is skipped instead of buffered.
    ignoring: bool,
    latest: Option<ProgressReport>,
}

impl Default for ProgressScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl ProgressScanner {
    pub fn new() -> Self {
        Self {
            state: ScanState::Text,
            payload: String::new(),
            ignoring: false,
            latest: None,
        }
    }

    pub fn latest(&self) -> Option<ProgressReport> {
        self.latest
    }

    pub fn latest_state(&self) -> Option<ProgressState> {
        self.latest.map(|report| report.state)
    }

    pub fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.push(*byte);
        }
    }

    fn push(&mut self, byte: u8) {
        match self.state {
            ScanState::Text => {
                if byte == 0x1b {
                    self.state = ScanState::Escape;
                }
            }
            ScanState::Escape => {
                self.state = if byte == b']' {
                    self.payload.clear();
                    self.ignoring = false;
                    ScanState::Payload
                } else if byte == 0x1b {
                    ScanState::Escape
                } else {
                    ScanState::Text
                };
            }
            ScanState::Payload => match byte {
                0x07 => self.finish(),
                0x1b => self.state = ScanState::PayloadEscape,
                _ => self.accumulate(byte),
            },
            ScanState::PayloadEscape => {
                if byte == b'\\' {
                    self.finish();
                } else {
                    // Not a string terminator: the payload was interrupted by
                    // a new escape sequence. Drop it rather than splice.
                    self.payload.clear();
                    self.state = if byte == b']' {
                        self.ignoring = false;
                        ScanState::Payload
                    } else {
                        ScanState::Text
                    };
                }
            }
        }
    }

    fn accumulate(&mut self, byte: u8) {
        if self.ignoring {
            return;
        }
        if self.payload.len() >= MAX_PAYLOAD {
            self.ignoring = true;
            self.payload.clear();
            return;
        }
        // Reports are ASCII. A non-ASCII byte means this is a title or a
        // notification, neither of which this scanner reads.
        if byte.is_ascii() {
            self.payload.push(char::from(byte));
        } else {
            self.ignoring = true;
            self.payload.clear();
        }
    }

    fn finish(&mut self) {
        if !self.ignoring {
            if let Some(report) = parse_progress(&self.payload) {
                self.latest = Some(report);
            }
        }
        self.payload.clear();
        self.ignoring = false;
        self.state = ScanState::Text;
    }
}

/// `9;4;<state>[;<percent>]`, with anything else ignored.
fn parse_progress(payload: &str) -> Option<ProgressReport> {
    let mut fields = payload.split(';');
    if fields.next()? != "9" {
        return None;
    }
    if fields.next()? != "4" {
        return None;
    }
    let state = ProgressState::from_code(fields.next()?.trim().parse::<u8>().ok()?)?;
    let percent = fields
        .next()
        .and_then(|value| value.trim().parse::<u8>().ok())
        .filter(|percent| *percent <= 100);
    Some(ProgressReport { state, percent })
}

#[cfg(test)]
mod tests {
    use super::{ProgressScanner, ProgressState};

    fn scan(chunks: &[&[u8]]) -> Option<super::ProgressReport> {
        let mut scanner = ProgressScanner::new();
        for chunk in chunks {
            scanner.write(chunk);
        }
        scanner.latest()
    }

    #[test]
    fn reads_a_bel_terminated_report() {
        let report = scan(&[b"\x1b]9;4;3;0\x07"]).expect("a report must be read");
        assert_eq!(report.state, ProgressState::Indeterminate);
    }

    #[test]
    fn reads_a_string_terminated_report_with_a_percentage() {
        let report = scan(&[b"\x1b]9;4;1;42\x1b\\"]).expect("a report must be read");
        assert_eq!(report.state, ProgressState::Normal);
        assert_eq!(report.percent, Some(42));
    }

    #[test]
    fn a_report_split_across_pty_reads_is_still_read() {
        let report = scan(&[b"\x1b]9;4", b";3", b";0\x07"]).expect("a report must be read");
        assert_eq!(report.state, ProgressState::Indeterminate);
    }

    #[test]
    fn the_latest_report_wins() {
        let report =
            scan(&[b"\x1b]9;4;3;0\x07 working \x1b]9;4;0;0\x07"]).expect("a report must be read");
        assert_eq!(report.state, ProgressState::Removed);
    }

    #[test]
    fn other_osc_commands_are_ignored() {
        assert!(scan(&[b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07"]).is_none());
        assert!(scan(&[b"\x1b]8;;https://example.test\x07"]).is_none());
        assert!(scan(&[b"\x1b]9;a desktop notification\x07"]).is_none());
    }

    #[test]
    fn an_overlong_payload_is_dropped_rather_than_buffered() {
        let mut scanner = ProgressScanner::new();
        scanner.write(b"\x1b]9;4;3;");
        scanner.write(&vec![b'0'; 4096]);
        scanner.write(b"\x07");
        assert!(scanner.latest().is_none());
        assert!(
            scanner.payload.is_empty(),
            "an ignored payload must not be retained"
        );
    }

    #[test]
    fn an_unterminated_payload_does_not_swallow_the_next_report() {
        let report = scan(&[b"\x1b]0;title\x1b[1m", b"\x1b]9;4;2;0\x07"])
            .expect("the second report must be read");
        assert_eq!(report.state, ProgressState::Error);
    }
}
