//! Applying a resolved rule set to a session's rendered evidence.
//!
//! The verdicts this produces are unchanged from the ones the daemon has
//! always published: `busy`, `waiting` and `idle`, each a positive match on
//! something the provider drew. What changed is where the patterns come from —
//! a version-resolved rule set instead of constants in the binary — and that a
//! verdict now names the rule that produced it.

use std::sync::Arc;

use crate::protocol::{AgentProvider, SessionStatus};

use super::rules::{
    CompiledPredicate, Matcher, Namespace, ResolvedRules, ResolvedVocabulary, DEFAULT_STATUS_ROWS,
};
use super::schema::{Channel, ProgressState, VocabularySet};
use super::version::CliVersion;

const WAITING_PROMPT_MAX_CHARS: usize = 240;
const WAITING_PROMPT_MAX_LINES: usize = 3;

/// What the rendered terminal proves about a session's composer.
///
/// There is no "a draft is present" answer on purpose. This exists to resolve
/// inherited draft state — whether a session the daemon did not watch being
/// typed into is holding an unsubmitted line — and only the answers that can
/// be *proven* from a frame are spelled out: an empty composer holds nothing,
/// and so does one holding only the provider's own suggestion chrome.
/// Everything else, including a line the daemon cannot explain, is `Unknown`
/// and stays the operator's call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerState {
    /// The provider's own idle composer chrome is on screen with nothing typed
    /// into it. A positive match on rendered chrome, never an inference from a
    /// quiet session.
    Empty,
    /// The composer line holds nothing but the provider's own dim suggestion
    /// chrome — Claude Code's tab-to-accept ghost of the last thing submitted.
    ///
    /// A positive match on two rendered facts at once, never an inference from
    /// text alone: every cell of that line is painted faint (SGR 2), which
    /// Claude never paints a typed draft with, *and* the cursor sits at the
    /// start of the composer rather than after the text, which is where it sits
    /// only when nothing on that line was typed. Both together, because being
    /// wrong here means appending a delivered message to a real unsent line.
    ///
    /// Proof of the same thing [`ComposerState::Empty`] proves — nobody has an
    /// unsent line here — from a frame that is not textually empty. Without it
    /// a session whose ledger was armed once can never recover: the ghost keeps
    /// the composer permanently non-empty, so an empty-text frame never comes.
    ///
    /// The cells this is measured from are read where the grid is rendered,
    /// not here: styling is not something the rule file can describe.
    SuggestionOnly,
    /// Not provably empty: a draft, a suggestion the daemon cannot tell from a
    /// draft, a dialog, a busy frame, a provider whose empty composer has not
    /// been measured, or a screen that has not drawn a composer yet.
    Unknown,
}

impl ComposerState {
    /// Whether this frame proves nobody has an unsent line at the composer.
    pub fn proves_nothing_typed(self) -> bool {
        matches!(self, Self::Empty | Self::SuggestionOnly)
    }
}

/// Everything a rule may read about one settled frame.
pub struct Evidence<'a> {
    /// The classification window, bottom rows of the rendered grid.
    pub lines: &'a [String],
    /// The terminal title the CLI last set with OSC 0/2.
    pub title: &'a str,
    /// The last OSC 9 progress report the CLI emitted.
    pub progress: Option<ProgressState>,
}

/// A classification and the rule that produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub status: SessionStatus,
    pub rule_id: String,
    pub channel: Channel,
}

/// A session's view of the detection rules: its provider, the CLI version it
/// is actually running, and the rule set those two resolve to.
///
/// Held per session and re-resolved when the rule generation moves, so a
/// hot-reloaded pattern fix reaches live sessions without a restart.
#[derive(Debug, Clone)]
pub struct Classifier {
    provider: Option<AgentProvider>,
    version: Option<CliVersion>,
    resolved: Option<Arc<ResolvedRules>>,
    generation: u64,
}

impl Classifier {
    /// A session with no agent provider: a plain shell, which is never
    /// classified.
    pub fn none() -> Self {
        Self {
            provider: None,
            version: None,
            resolved: None,
            generation: 0,
        }
    }

    pub fn new(provider: Option<AgentProvider>) -> Self {
        let mut classifier = Self::none();
        classifier.provider = provider;
        classifier.resolve();
        classifier
    }

    pub fn with_version(provider: Option<AgentProvider>, version: Option<CliVersion>) -> Self {
        let mut classifier = Self::none();
        classifier.provider = provider;
        classifier.version = version;
        classifier.resolve();
        classifier
    }

    pub fn provider(&self) -> Option<AgentProvider> {
        self.provider
    }

    pub fn version(&self) -> Option<&CliVersion> {
        self.version.as_ref()
    }

    /// Record the CLI version a probe answered with. Returns whether it moved,
    /// so the caller can log the transition once rather than on every probe.
    pub fn set_version(&mut self, version: Option<CliVersion>) -> bool {
        if self.version == version {
            return false;
        }
        self.version = version;
        self.resolve();
        true
    }

    fn resolve(&mut self) {
        let Some(provider) = self.provider else {
            self.resolved = None;
            self.generation = super::generation();
            return;
        };
        let (rules, generation) = super::current_rules();
        self.resolved = Some(Arc::new(rules.resolve(provider, self.version.as_ref())));
        self.generation = generation;
    }

    /// Pick up a hot-reloaded rule file. Cheap enough to call per frame: the
    /// common path is one atomic load and an equality test.
    fn refresh(&mut self) {
        if self.provider.is_some() && self.generation != super::generation() {
            self.resolve();
        }
    }

    fn rules(&mut self) -> Option<Arc<ResolvedRules>> {
        self.refresh();
        self.resolved.clone()
    }

    /// How many rendered rows this provider's classification window covers.
    pub fn status_rows(&mut self) -> usize {
        self.rules()
            .map(|rules| rules.status_rows)
            .unwrap_or(DEFAULT_STATUS_ROWS)
    }

    /// How many rows the waiting-prompt reader needs to see a whole dialog.
    pub fn waiting_prompt_rows(&mut self) -> usize {
        self.rules()
            .map(|rules| rules.waiting_prompt_rows)
            .unwrap_or(DEFAULT_STATUS_ROWS)
    }

    /// The arguments that make this provider's CLI print its version.
    pub fn probe_args(&mut self) -> Vec<String> {
        self.rules()
            .map(|rules| rules.probe_args.clone())
            .unwrap_or_default()
    }

    /// Classify one settled frame, naming the rule that decided it.
    ///
    /// Rules are evaluated grid-channel first, then by declared priority, and
    /// the first match wins. `None` leaves the session's current status in
    /// place, which is deliberate: a frame this daemon cannot read is not
    /// evidence that anything changed.
    pub fn classify(&mut self, evidence: &Evidence<'_>) -> Option<Verdict> {
        let rules = self.rules()?;
        for rule in &rules.rules {
            let vocabulary = rules.vocabulary_for(rule.namespace);
            let matched = match (&rule.predicate, rule.channel) {
                (CompiledPredicate::AnyLine(matcher), _) => evidence
                    .lines
                    .iter()
                    .any(|line| matches_line(matcher, line, vocabulary)),
                (CompiledPredicate::AnyLineWrapped(matcher), _) => {
                    evidence
                        .lines
                        .iter()
                        .any(|line| matches_line(matcher, line, vocabulary))
                        || evidence.lines.windows(2).any(|pair| {
                            matches_line(matcher, &format!("{} {}", pair[0], pair[1]), vocabulary)
                        })
                }
                (CompiledPredicate::LastNonEmptyLine(matcher), _) => {
                    matches_line(matcher, last_non_empty_line(evidence.lines), vocabulary)
                }
                // An unset title is the absence of evidence, not evidence of
                // an empty one: a session whose CLI never set a title must not
                // satisfy a `not`-shaped title pattern.
                (CompiledPredicate::Text(matcher), _) => {
                    !evidence.title.is_empty() && matches_line(matcher, evidence.title, vocabulary)
                }
                (CompiledPredicate::ProgressState(states), _) => evidence
                    .progress
                    .is_some_and(|progress| states.contains(&progress)),
                (CompiledPredicate::Structural(name), _) => {
                    structural(name, evidence.lines, &rules)
                }
            };
            if matched {
                return Some(Verdict {
                    status: rule.status,
                    rule_id: rule.id.clone(),
                    channel: rule.channel,
                });
            }
        }
        None
    }

    /// A row shaped like a working footer that matches neither the in-flight
    /// nor the finished form.
    ///
    /// This is the canary. The 2.1.263 defect did not announce itself: the
    /// matcher simply stopped matching, returned nothing for every frame, and
    /// every session silently kept whatever status it last had — a failure no
    /// amount of fixture replay can notice, because fixtures are frozen at the
    /// version that was captured. A row opening with an animation glyph is a
    /// footer by construction, so one that fits neither vocabulary means the
    /// CLI moved and the rule file needs re-measuring.
    pub fn unclassified_footer<'a>(&mut self, lines: &'a [String]) -> Option<&'a str> {
        let rules = self.rules()?;
        let vocabulary = &rules.vocabulary;
        if vocabulary.get(VocabularySet::SpinnerGlyphs).is_empty() {
            return None;
        }
        lines.iter().map(|line| line.trim()).find(|line| {
            starts_with_glyph_word(line, &vocabulary.get(VocabularySet::SpinnerGlyphs).glyphs)
                && !animated_in_flight_footer(line, vocabulary)
                && !contains_any(
                    line,
                    &vocabulary
                        .get(VocabularySet::DoneFooterMarkers)
                        .values_lower,
                )
        })
    }

    /// Read the composer out of a rendered frame: its index in `lines` and the
    /// text rendered after its prompt glyph, or `None` when the frame draws no
    /// readable composer at all.
    ///
    /// Only providers whose empty composer has actually been captured declare
    /// a composer prompt: an unmeasured composer matches nothing rather than
    /// being written from the shape a matcher happened to expect. The composer
    /// is the last prompt line in the window with only chrome below it, and a
    /// busy or waiting frame is refused outright — its empty composer is true
    /// but its screen is mid-repaint, and nothing needs an answer from a
    /// session that is still working.
    ///
    /// "There is no readable composer here" and "the composer reads as holding
    /// something" are different answers, which is why this returns the reading
    /// rather than a verdict: only the second is worth looking at the cells
    /// for, and the cells are read where the grid is rendered.
    pub fn composer_reading(&mut self, lines: &[String]) -> Option<(usize, String)> {
        if self.frame_is_busy_or_waiting(lines) {
            return None;
        }
        let rules = self.rules()?;
        let composer_index = composer_index(lines, &rules)?;
        if composer_box_tail(&lines[composer_index + 1..], &rules)
            .iter()
            .any(|line| !is_chrome(line, &rules))
        {
            return None;
        }
        Some((
            composer_index,
            composer_text(&lines[composer_index], &rules).to_string(),
        ))
    }

    /// The prompt glyphs this session's measured composer is drawn with.
    ///
    /// Empty for a provider whose composer has never been captured, which is
    /// how "unmeasured chrome matches nothing" reaches the cell reads too.
    pub fn composer_prompts(&mut self) -> Vec<char> {
        self.rules().map_or_else(Vec::new, |rules| {
            rules
                .vocabulary
                .get(VocabularySet::ComposerPrompts)
                .glyphs
                .clone()
        })
    }

    /// The text rendered on the composer line, or `None` when this frame draws
    /// no readable composer.
    ///
    /// `Some("")` is the positive proof [`ComposerState::Empty`] is built on;
    /// `Some(text)` is what is *rendered* there and nothing more. This reads
    /// normalised text, and text alone cannot say whether a line was typed or
    /// drawn by the CLI, which is why the session's typed-byte attestation
    /// decides how it is labelled. The *cells* can say more than the text can
    /// — see [`ComposerState::SuggestionOnly`] — but that is corroboration for
    /// the ledger, not a replacement for it.
    pub fn composer_line(
        &mut self,
        frame_lines: &[String],
        status_lines: &[String],
    ) -> Option<String> {
        if self.frame_is_busy_or_waiting(status_lines) {
            return None;
        }
        let rules = self.rules()?;
        let index = composer_index(frame_lines, &rules)?;
        Some(composer_text(&frame_lines[index], &rules).to_string())
    }

    fn frame_is_busy_or_waiting(&mut self, lines: &[String]) -> bool {
        // Composer questions are asked of the rendered grid alone. A title or
        // progress report says what the agent is doing; it says nothing about
        // whether this frame drew a readable composer.
        let evidence = Evidence {
            lines,
            title: "",
            progress: None,
        };
        matches!(
            self.classify(&evidence)
                .filter(|verdict| verdict.channel == Channel::Grid)
                .map(|verdict| verdict.status),
            Some(SessionStatus::Busy) | Some(SessionStatus::Waiting)
        )
    }

    /// The snippet published beside a `waiting` or `idle` status: what the
    /// session is asking, or the last thing it said.
    pub fn waiting_prompt(
        &mut self,
        classification_lines: &[String],
        frame_lines: &[String],
    ) -> Option<String> {
        let rules = self.rules()?;
        waiting_prompt_from_lines(classification_lines, frame_lines, &rules)
    }

    /// Whether a rendered line is provider chrome rather than session content.
    pub fn is_chrome(&mut self, line: &str) -> bool {
        self.rules().is_some_and(|rules| is_chrome(line, &rules))
    }
}

fn structural(name: &str, lines: &[String], rules: &ResolvedRules) -> bool {
    match name {
        "claude-working-footer" => lines
            .iter()
            .any(|line| animated_in_flight_footer(line.trim(), &rules.vocabulary)),
        "claude-active-subagent" => active_subagent(lines, rules),
        "claude-parked-composer" => parked_composer(lines, rules),
        "claude-selected-menu-option" => lines
            .iter()
            .any(|line| line_is_selected_menu_option(line, rules)),
        "opencode-composer-status" => lines
            .iter()
            .any(|line| composer_status_line(line, &rules.vocabulary)),
        "copilot-busy-above-path" => copilot_busy_above_path(lines, rules),
        "copilot-idle-composer-below-path" => copilot_idle_below_path(lines, rules),
        // Unreachable: the loader refuses an unknown name.
        _ => false,
    }
}

/// An in-flight working footer: an animation glyph, the in-flight marker, and
/// none of the finished form.
///
/// The shape is measured, not assumed. Across the captured frames, an
/// in-flight footer always opens with an animation glyph and carries the
/// in-flight marker, while the *same row* is rewritten to
/// "✻ Worked for 6s · done 3:17 PM" the moment the turn ends. Keying on the
/// in-flight marker is what separates live work from the completed footer that
/// persists in the transcript. Requiring the animation glyph is what keeps a
/// transcript line like "⏺ Running 1 shell command…" — a bullet, not an
/// animation frame — out.
fn animated_in_flight_footer(trimmed: &str, vocabulary: &ResolvedVocabulary) -> bool {
    let animated = starts_with_glyph_word(
        trimmed,
        &vocabulary.get(VocabularySet::SpinnerGlyphs).glyphs,
    ) || starts_with_glyph_word(
        trimmed,
        &vocabulary.get(VocabularySet::WorkingFooterGlyphs).glyphs,
    );
    animated
        && contains_any(
            trimmed,
            &vocabulary.get(VocabularySet::InFlightMarkers).values_lower,
        )
        && !contains_any(
            trimmed,
            &vocabulary
                .get(VocabularySet::DoneFooterMarkers)
                .values_lower,
        )
}

fn active_subagent(lines: &[String], rules: &ResolvedRules) -> bool {
    let parents = &rules
        .vocabulary
        .get(VocabularySet::SubagentParentPrefixes)
        .values;
    let tasks = &rules
        .vocabulary
        .get(VocabularySet::SubagentTaskPrefixes)
        .values;
    if parents.is_empty() || tasks.is_empty() {
        return false;
    }
    let Some(parent_index) = lines
        .iter()
        .rposition(|line| starts_with_any(line, parents))
    else {
        return false;
    };
    let after_parent = &lines[parent_index + 1..];
    after_parent.iter().any(|line| starts_with_any(line, tasks))
        && !after_parent.iter().any(|line| {
            starts_with_glyph(
                line,
                &rules.vocabulary.get(VocabularySet::ComposerPrompts).glyphs,
            )
        })
}

/// The composer, drawn above a divider and the provider's mode/status bar, is
/// not generally the last meaningful row even though it is the positive proof
/// a turn has parked. Only accept it when everything below the last composer
/// is measured chrome; busy and waiting rules keep priority over this one.
fn parked_composer(lines: &[String], rules: &ResolvedRules) -> bool {
    let Some(index) = composer_index(lines, rules) else {
        return false;
    };
    // The classified window must reach above the composer box, or this frame
    // cannot answer the question at all.
    //
    // Status classification reads only the bottom rows, and a provider's own
    // chrome can fill nearly all of them: the two box borders and the composer
    // are three, and the status bar beneath them has five measured rows it may
    // draw. Once the box's opening divider is the top of the window — or is
    // not inside it at all — the row that would carry the in-flight footer was
    // never read. An empty slice below then makes the chrome test vacuously
    // true, which is how a running turn gets called idle: not a stale verdict,
    // a confidently wrong one.
    //
    // So require the evidence rather than assume its absence. The region's top
    // is the box's opening border where one is drawn, and the composer row
    // itself where it is not; a window starting there has read none of the
    // transcript above.
    let region_top = lines[..index]
        .iter()
        .rposition(|line| is_divider(line, rules))
        .unwrap_or(index);
    if region_top == 0 {
        return false;
    }

    let below = &lines[index + 1..];
    // The composer box closes with a divider and only the status bar is drawn
    // beneath it, so everything past that border is chrome by construction.
    // Reading it that way is what stops a status-bar row nobody measured from
    // costing a parked frame its idle verdict.
    let above_status_bar = below
        .iter()
        .position(|line| is_divider(line, rules))
        .map_or(below, |border| &below[..border]);
    above_status_bar.iter().all(|line| is_chrome(line, rules))
}

/// A selected option in an interactive menu: the caret is on a numbered choice
/// rather than on an empty input box.
///
/// This is what makes a menu of arbitrary choices visible. Those carry none of
/// the permission-prompt wording, and the caret alone reads as the idle input
/// box — so without this a task parked on a question looked exactly like a
/// task waiting for its next instruction.
///
/// It is a positive match on rendered chrome, never an inference from silence:
/// a session running a long build shows no caret-on-option line and is never
/// reported as waiting. The one benign overlap is a human who typed a line
/// beginning "1." into the input box and did not send it — a task that is, in
/// fact, waiting on its human.
fn line_is_selected_menu_option(line: &str, rules: &ResolvedRules) -> bool {
    let carets = &rules.common.get(VocabularySet::MenuCaretGlyphs).glyphs;
    prompt_remainder(line, carets).is_some_and(starts_numbered_option)
}

/// A composer status line inside a bordered box — mode and model, separated by
/// a measured separator.
///
/// Matching on the separator rather than the mode word is load-bearing: what
/// sits left of it varies with the spawn's flags. This stays a positive match
/// on rendered chrome: a session that has not drawn its composer yet, or that
/// has replaced it with a permission dialog, matches nothing and leaves the
/// previous status in place.
fn composer_status_line(line: &str, vocabulary: &ResolvedVocabulary) -> bool {
    let borders = &vocabulary.get(VocabularySet::BoxBorderGlyphs).glyphs;
    let separators = &vocabulary
        .get(VocabularySet::ComposerStatusSeparators)
        .values;
    if borders.is_empty() || separators.is_empty() {
        return false;
    }
    prompt_remainder(line, borders).is_some_and(|remainder| {
        separators
            .iter()
            .any(|separator| remainder.contains(separator))
    })
}

fn copilot_busy_above_path(lines: &[String], rules: &ResolvedRules) -> bool {
    let Some(path_index) = worktree_path_index(lines, rules) else {
        return false;
    };
    path_index > 0
        && contains_any(
            &lines[path_index - 1],
            &rules
                .vocabulary
                .get(VocabularySet::BusyMarkers)
                .values_lower,
        )
}

fn copilot_idle_below_path(lines: &[String], rules: &ResolvedRules) -> bool {
    let Some(path_index) = worktree_path_index(lines, rules) else {
        return false;
    };
    let prompts = &rules.vocabulary.get(VocabularySet::IdlePromptGlyphs).glyphs;
    lines
        .iter()
        .skip(path_index + 1)
        .find_map(|line| prompt_remainder(line, prompts))
        .is_some_and(str::is_empty)
}

fn worktree_path_index(lines: &[String], rules: &ResolvedRules) -> Option<usize> {
    let markers = &rules.common.get(VocabularySet::WorktreePathMarkers).values;
    if markers.is_empty() {
        return None;
    }
    lines
        .iter()
        .rposition(|line| markers.iter().any(|marker| line.contains(marker)))
}

// ---------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------

pub fn matches_line(matcher: &Matcher, line: &str, vocabulary: &ResolvedVocabulary) -> bool {
    match matcher {
        Matcher::Contains(needle) => contains_ascii_case_insensitive(line, needle),
        Matcher::ContainsAll(needles) => needles
            .iter()
            .all(|needle| contains_ascii_case_insensitive(line, needle)),
        Matcher::Equals(value) => line.trim() == value,
        Matcher::StartsWith(value) => line.trim().starts_with(value.as_str()),
        Matcher::ContainsAny(set) => contains_any(line, &vocabulary.get(*set).values_lower),
        Matcher::ContainsAllOf(set) => {
            let values = &vocabulary.get(*set).values_lower;
            !values.is_empty()
                && values
                    .iter()
                    .all(|value| contains_ascii_case_insensitive(line, value))
        }
        Matcher::StartsWithAny(set) => starts_with_any(line, &vocabulary.get(*set).values),
        Matcher::StartsWithGlyph(set) => starts_with_glyph(line, &vocabulary.get(*set).glyphs),
        Matcher::StartsWithGlyphWord(set) => {
            starts_with_glyph_word(line, &vocabulary.get(*set).glyphs)
        }
        Matcher::AllCharactersIn(set) => all_characters_in(line, &vocabulary.get(*set).glyphs),
        Matcher::AnyOf(matchers) => matchers
            .iter()
            .any(|inner| matches_line(inner, line, vocabulary)),
        Matcher::AllOf(matchers) => matchers
            .iter()
            .all(|inner| matches_line(inner, line, vocabulary)),
        Matcher::Not(inner) => !matches_line(inner, line, vocabulary),
    }
}

/// Whether a rendered line is chrome rather than something the session said.
///
/// An empty row is chrome in code rather than in data: it is the absence of a
/// line, not a pattern anybody could re-measure.
pub fn is_chrome(line: &str, rules: &ResolvedRules) -> bool {
    chrome_matches(line, rules, None)
}

/// Chrome this provider draws, ignoring the shared set.
///
/// Narrower on purpose, and only used where the surrounding structure already
/// says what a row is. Reading a transcript out of a bordered composer box is
/// the case: everything above the box is something the session said, and a
/// shared marker appearing inside it — a worktree path in a "wrote
/// .../file.md" line, say — is content, not frame.
fn is_provider_chrome(line: &str, rules: &ResolvedRules) -> bool {
    chrome_matches(line, rules, Some(Namespace::Provider))
}

fn chrome_matches(line: &str, rules: &ResolvedRules, only: Option<Namespace>) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    rules
        .chrome
        .iter()
        .filter(|(namespace, _)| only.is_none_or(|wanted| *namespace == wanted))
        .any(|(namespace, matcher)| {
            matches_line(matcher, trimmed, rules.vocabulary_for(*namespace))
        })
}

fn is_divider(line: &str, rules: &ResolvedRules) -> bool {
    all_characters_in(line, &rules.common.get(VocabularySet::DividerGlyphs).glyphs)
}

/// The rows below a composer that still have to read as chrome.
///
/// A provider that closes its composer box with a divider draws only its
/// status bar beneath that border, so everything past the border is chrome by
/// construction — the same reading [`parked_composer`] uses, and for the same
/// reason. Claude 2.1.263 puts a `/rc` agent-connection row, an effort badge,
/// an update badge and a login-expiry notice down there; unclassified, any one
/// of them made the composer unreadable, so `composer_state` answered
/// `Unknown` for every live Claude session on this machine and attestation
/// could not fire at all.
///
/// Which providers get this reading is data, not a branch: the truncation runs
/// off the *provider's own* divider glyphs, and only a provider whose box has
/// actually been measured declares any. Everyone else resolves an empty set,
/// matches no border, and is read exactly as before.
fn composer_box_tail<'a>(below: &'a [String], rules: &ResolvedRules) -> &'a [String] {
    let borders = &rules.vocabulary.get(VocabularySet::DividerGlyphs).glyphs;
    if borders.is_empty() {
        return below;
    }
    below
        .iter()
        .position(|line| all_characters_in(line, borders))
        .map_or(below, |border| &below[..border])
}

/// The last composer line in the window.
///
/// A caret sitting on a numbered menu option is not a composer: it is the
/// selection cursor, and reading it as the input line is what made a task
/// parked on a menu look like a task waiting for its next instruction.
fn composer_index(lines: &[String], rules: &ResolvedRules) -> Option<usize> {
    let prompts = &rules.vocabulary.get(VocabularySet::ComposerPrompts).glyphs;
    if prompts.is_empty() {
        return None;
    }
    lines.iter().rposition(|line| {
        starts_with_glyph(line, prompts) && !line_is_selected_menu_option(line, rules)
    })
}

fn composer_text<'a>(line: &'a str, rules: &ResolvedRules) -> &'a str {
    prompt_remainder(
        line,
        &rules.vocabulary.get(VocabularySet::ComposerPrompts).glyphs,
    )
    .unwrap_or("")
}

pub fn contains_ascii_case_insensitive(haystack: &str, needle_lowercase: &str) -> bool {
    if needle_lowercase.is_empty() {
        return true;
    }
    let haystack = haystack.as_bytes();
    let needle = needle_lowercase.as_bytes();
    if needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.to_ascii_lowercase() == *right)
    })
}

fn contains_any(line: &str, needles_lowercase: &[String]) -> bool {
    needles_lowercase
        .iter()
        .any(|needle| contains_ascii_case_insensitive(line, needle))
}

fn starts_with_any(line: &str, prefixes: &[String]) -> bool {
    let trimmed = line.trim_start();
    prefixes
        .iter()
        .any(|prefix| trimmed.starts_with(prefix.as_str()))
}

pub fn starts_with_glyph(line: &str, glyphs: &[char]) -> bool {
    line.trim_start()
        .chars()
        .next()
        .is_some_and(|character| glyphs.contains(&character))
}

fn starts_with_glyph_word(line: &str, glyphs: &[char]) -> bool {
    let mut characters = line.trim_start().chars();
    let Some(first) = characters.next() else {
        return false;
    };
    glyphs.contains(&first) && characters.next().is_some_and(char::is_whitespace)
}

fn all_characters_in(line: &str, glyphs: &[char]) -> bool {
    if glyphs.is_empty() {
        return false;
    }
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|character| character == ' ' || glyphs.contains(&character))
}

pub fn prompt_remainder<'a>(line: &'a str, prompts: &[char]) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let mut characters = trimmed.char_indices();
    let (_, first) = characters.next()?;
    if !prompts.contains(&first) {
        return None;
    }
    let remainder_index = characters.next().map_or(trimmed.len(), |(index, _)| index);
    Some(trimmed[remainder_index..].trim())
}

fn last_non_empty_line(lines: &[String]) -> &str {
    lines
        .iter()
        .rev()
        .find(|line| !line.is_empty())
        .map(String::as_str)
        .unwrap_or("")
}

fn starts_numbered_option(text: &str) -> bool {
    let digit_count = text.chars().take_while(char::is_ascii_digit).count();
    digit_count > 0
        && text[digit_count..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '.' | ')'))
}

/// Bound a prompt snippet to one readable line of context.
pub fn bound_waiting_prompt(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= WAITING_PROMPT_MAX_CHARS {
        return Some(collapsed);
    }
    let mut bounded = collapsed
        .chars()
        .take(WAITING_PROMPT_MAX_CHARS - 1)
        .collect::<String>();
    bounded.push('\u{2026}');
    Some(bounded)
}

// ---------------------------------------------------------------------------
// Waiting-prompt extraction
// ---------------------------------------------------------------------------

fn line_is_permission_option(line: &str, rules: &ResolvedRules) -> bool {
    let prompts = &rules.common.get(VocabularySet::ComposerPrompts).glyphs;
    let trimmed = prompt_remainder(line, prompts).unwrap_or(line).trim_start();
    starts_numbered_option(trimmed)
}

fn waiting_question_from_lines(lines: &[String], rules: &ResolvedRules) -> Option<String> {
    let markers = &rules.common.get(VocabularySet::WaitingMarkers).values_lower;
    if markers.is_empty() {
        return None;
    }
    let start = lines
        .iter()
        .rposition(|line| contains_any(line, markers))
        .or_else(|| {
            lines
                .windows(2)
                .rposition(|pair| contains_any(&format!("{} {}", pair[0], pair[1]), markers))
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
        if !question.is_empty() && line_is_permission_option(trimmed, rules) {
            break;
        }
        question.push(trimmed);
        if trimmed.ends_with('?') || question.len() == WAITING_PROMPT_MAX_LINES {
            break;
        }
    }
    bound_waiting_prompt(&question.join(" "))
}

/// The question a menu is asking, read from the lines above its first option.
/// Scanning from the bottom instead would return the option list, which tells
/// a watcher what the choices are but not what is being decided.
fn waiting_question_above_menu(lines: &[String], rules: &ResolvedRules) -> Option<String> {
    let menu_index = lines
        .iter()
        .position(|line| line_is_selected_menu_option(line, rules))?;

    let mut question = Vec::new();
    for line in lines[..menu_index].iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || is_divider(trimmed, rules) {
            if question.is_empty() {
                continue;
            }
            break;
        }
        if line_is_permission_option(trimmed, rules) {
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

/// What a bordered permission dialog is asking, read from inside the box.
///
/// The generic scans cannot find it — every line carries the box border, so
/// the dialog looks like chrome — and the border is stripped here so the
/// snippet reads as a question rather than as box drawing.
fn boxed_permission_question(lines: &[String], rules: &ResolvedRules) -> Option<String> {
    let borders = &rules.vocabulary.get(VocabularySet::BoxBorderGlyphs).glyphs;
    let actions = &rules
        .vocabulary
        .get(VocabularySet::PermissionActionMarkers)
        .values_lower;
    if borders.is_empty() || actions.is_empty() {
        return None;
    }
    let action_index = lines.iter().rposition(|line| {
        actions
            .iter()
            .all(|action| contains_ascii_case_insensitive(line, action))
    })?;

    // The dialog is the contiguous run of bordered rows ending at the action
    // row. Walking up to its first row matters on a narrow terminal, where the
    // window also reaches the echoed user message — itself drawn in a bordered
    // block, and the wrong answer to "what is being decided".
    let mut start = action_index;
    while start > 0 && starts_with_glyph(&lines[start - 1], borders) {
        start -= 1;
    }

    let mut question = Vec::new();
    for line in &lines[start..action_index] {
        let Some(body) = prompt_remainder(line, borders) else {
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

/// The agent's last words, read from above a bordered composer box.
///
/// A bottom bar that wraps on a narrow terminal cannot be recognised line by
/// line; the composer box is the reliable landmark instead. Everything from
/// its first bordered row down is frame, and everything above it is transcript.
fn boxed_transcript_tail(lines: &[String], rules: &ResolvedRules) -> Option<String> {
    let borders = &rules.vocabulary.get(VocabularySet::BoxBorderGlyphs).glyphs;
    if borders.is_empty() {
        return None;
    }
    let composer_index = lines
        .iter()
        .position(|line| starts_with_glyph(line, borders))?;
    let block_art = &rules.vocabulary.get(VocabularySet::BlockArtGlyphs).glyphs;

    let mut content = Vec::new();
    for line in lines[..composer_index].iter().rev() {
        // A scrollbar painted in the right-hand gutter can leave a transcript
        // row ending in a stray block glyph that is not part of what was said.
        let trimmed = line
            .trim()
            .trim_end_matches(block_art.as_slice())
            .trim_end();
        if trimmed.is_empty() || is_provider_chrome(trimmed, rules) {
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

fn waiting_prompt_from_lines(
    classification_lines: &[String],
    frame_lines: &[String],
    rules: &ResolvedRules,
) -> Option<String> {
    // Nothing at or below the composer is session output. A CLI can paint a
    // command palette below it whose entries look exactly like ordinary
    // transcript, so locate this boundary in the whole visible frame before
    // running *any* content classifier. When the bounded classification window
    // no longer contains that boundary, every one of its rows is below it.
    let (classification_transcript, frame_transcript) = match composer_index(frame_lines, rules) {
        Some(index) => {
            let classification_transcript = composer_index(classification_lines, rules)
                .map_or(&classification_lines[..0], |classification_composer| {
                    &classification_lines[..classification_composer]
                });
            (classification_transcript, &frame_lines[..index])
        }
        None => (classification_lines, frame_lines),
    };

    if let Some(question) = waiting_question_from_lines(classification_transcript, rules) {
        return Some(question);
    }
    if let Some(question) = waiting_question_above_menu(classification_transcript, rules) {
        return Some(question);
    }
    if let Some(question) = boxed_permission_question(classification_transcript, rules) {
        return Some(question);
    }
    if let Some(tail) = boxed_transcript_tail(classification_transcript, rules) {
        return Some(tail);
    }

    let mut content = Vec::new();
    for line in frame_transcript.iter().rev() {
        if is_chrome(line, rules) {
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
