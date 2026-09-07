//! The declarative shape of `rules.json`.
//!
//! Every literal the classifier matches lives here as data. The types are
//! deliberately named rather than free-form maps: a misspelled vocabulary key
//! in an override file must fail loudly at load, not silently match nothing —
//! which is precisely the failure mode this architecture exists to end.

use serde::Deserialize;

use crate::protocol::{AgentProvider, SessionStatus};

/// The one schema version this daemon understands. A file declaring a newer
/// one is refused rather than half-read: an override a daemon only partially
/// understands is worse than the bundled rules it would replace.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleFile {
    pub schema_version: u32,
    #[serde(default)]
    pub common: CommonRules,
    #[serde(default)]
    pub providers: Vec<ProviderRuleSet>,
}

/// Patterns that are not one provider's property: the permission wording every
/// CLI here spells the same way, and the chrome that is chrome wherever it is
/// drawn. Its vocabulary is a separate namespace from a provider's — merging
/// them would let Codex's composer glyph satisfy Claude's composer test.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommonRules {
    #[serde(default)]
    pub vocabulary: Vocabulary,
    #[serde(default)]
    pub chrome: Vec<ChromeEntry>,
    /// Rules merged into every provider's list before priority ordering.
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuleSet {
    pub provider: AgentProvider,
    #[serde(default)]
    pub version_probe: Option<VersionProbe>,
    #[serde(default)]
    pub vocabulary: Vocabulary,
    #[serde(default)]
    pub chrome: Vec<ChromeEntry>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// How many rendered rows status classification reads from the bottom of
    /// the screen.
    #[serde(default)]
    pub status_rows: Option<usize>,
    /// How many rows the waiting-prompt reader needs to see a whole dialog.
    /// OpenCode's permission dialog is taller than the status window.
    #[serde(default)]
    pub waiting_prompt_rows: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionProbe {
    /// Arguments that make the CLI print its version. `--version` for every
    /// CLI measured so far; in data because the next one may disagree.
    pub args: Vec<String>,
}

/// Named literal sets the matchers and structural predicates walk.
///
/// Every field is optional and defaults to empty: a provider declares only the
/// vocabulary its own chrome uses, and an empty set matches nothing rather
/// than matching everything.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Vocabulary {
    /// The glyph a *measured* composer line opens with. Declared only where
    /// the provider's empty composer has actually been captured, because
    /// composer attestation is built on that proof.
    #[serde(default)]
    pub composer_prompts: Vec<VersionedGlyphs>,
    /// The glyph the last-line idle rule looks for. Often the same character
    /// as the composer prompt, and deliberately a different set: recognising a
    /// parked prompt is not the same claim as having measured a composer.
    #[serde(default)]
    pub idle_prompt_glyphs: Vec<VersionedGlyphs>,
    /// The animation frames a working footer opens with.
    #[serde(default)]
    pub spinner_glyphs: Vec<VersionedGlyphs>,
    /// Extra glyphs a working footer may open with that are not animation
    /// frames — Claude paints a turn's first frame with a dim middle dot.
    #[serde(default)]
    pub working_footer_glyphs: Vec<VersionedGlyphs>,
    /// The marker that proves a turn is still in flight: Claude's ellipsis,
    /// OpenCode's interrupt hint.
    #[serde(default)]
    pub in_flight_markers: Vec<VersionedStrings>,
    /// What a *finished* turn's footer carries instead.
    #[serde(default)]
    pub done_footer_markers: Vec<VersionedStrings>,
    /// Markers that prove a turn is running wherever they appear.
    #[serde(default)]
    pub busy_markers: Vec<VersionedStrings>,
    /// Markers that prove the CLI is asking the operator something.
    #[serde(default)]
    pub waiting_markers: Vec<VersionedStrings>,
    /// Every action word a permission dialog's action row carries. Matched as
    /// a conjunction: the row is the dialog's only reliably visible part on a
    /// tall terminal, and one word alone appears in ordinary transcript.
    #[serde(default)]
    pub permission_action_markers: Vec<VersionedStrings>,
    /// The caret an interactive menu draws on the selected option. Declared in
    /// the common vocabulary because the menu scan runs for every provider.
    #[serde(default)]
    pub menu_caret_glyphs: Vec<VersionedGlyphs>,
    /// Characters a horizontal rule is drawn from.
    #[serde(default)]
    pub divider_glyphs: Vec<VersionedGlyphs>,
    /// The left border of a composer box and of the dialogs inside it.
    #[serde(default)]
    pub box_border_glyphs: Vec<VersionedGlyphs>,
    /// The separator that identifies a composer status line inside that box.
    #[serde(default)]
    pub composer_status_separators: Vec<VersionedStrings>,
    /// The row that opens a subagent fan-out, and the child rows under it.
    #[serde(default)]
    pub subagent_parent_prefixes: Vec<VersionedStrings>,
    #[serde(default)]
    pub subagent_task_prefixes: Vec<VersionedStrings>,
    /// Text-free block art: banners, rules, scrollbar gutters.
    #[serde(default)]
    pub block_art_glyphs: Vec<VersionedGlyphs>,
    /// The glyphs a footer progress bar is drawn from.
    #[serde(default)]
    pub footer_progress_glyphs: Vec<VersionedGlyphs>,
    /// The glyph that replaces the working footer with a turn summary.
    #[serde(default)]
    pub turn_summary_glyphs: Vec<VersionedGlyphs>,
    /// Substrings identifying the row a CLI prints its workspace path on.
    #[serde(default)]
    pub worktree_path_markers: Vec<VersionedStrings>,
    /// Terminal-title glyphs that prove a turn is in flight.
    #[serde(default)]
    pub title_busy_glyphs: Vec<VersionedGlyphs>,
    /// Terminal-title glyphs that prove a turn has parked.
    #[serde(default)]
    pub title_idle_glyphs: Vec<VersionedGlyphs>,
}

/// Every set a matcher may name. An enum, not a string key: a typo in an
/// override file is then a load error rather than a rule that quietly stops
/// matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VocabularySet {
    ComposerPrompts,
    IdlePromptGlyphs,
    SpinnerGlyphs,
    WorkingFooterGlyphs,
    InFlightMarkers,
    DoneFooterMarkers,
    BusyMarkers,
    WaitingMarkers,
    PermissionActionMarkers,
    MenuCaretGlyphs,
    DividerGlyphs,
    BoxBorderGlyphs,
    ComposerStatusSeparators,
    SubagentParentPrefixes,
    SubagentTaskPrefixes,
    BlockArtGlyphs,
    FooterProgressGlyphs,
    TurnSummaryGlyphs,
    WorktreePathMarkers,
    TitleBusyGlyphs,
    TitleIdleGlyphs,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionedStrings {
    pub id: String,
    #[serde(default)]
    pub versions: Option<String>,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionedGlyphs {
    pub id: String,
    #[serde(default)]
    pub versions: Option<String>,
    /// Single characters. A multi-character entry is refused at load: glyph
    /// sets are compared character by character, so a two-character "glyph"
    /// would silently never match.
    pub glyphs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeEntry {
    pub id: String,
    #[serde(default)]
    pub versions: Option<String>,
    #[serde(rename = "match")]
    pub line_match: LineMatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub status: SessionStatus,
    #[serde(default)]
    pub channel: Channel,
    #[serde(default)]
    pub versions: Option<String>,
    pub priority: i32,
    pub when: Predicate,
}

/// Which provider-emitted evidence a rule reads.
///
/// The grid is authoritative. Title and progress rules are consulted only when
/// no grid rule matched, which is the case that latches a stale status — never
/// to overrule a frame that already proved something.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Channel {
    #[default]
    Grid,
    Title,
    Progress,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Predicate {
    /// Any line in the classification window matches.
    AnyLine(LineMatch),
    /// Any line matches, or any two adjacent lines do once joined by a space.
    ///
    /// The wrapped form is what makes a marker survive a narrow terminal: a
    /// footer hint the CLI drew on one row is rendered across two, and a
    /// scan that only looked at single rows would silently lose the verdict
    /// exactly where the window is smallest.
    AnyLineWrapped(LineMatch),
    /// The last non-empty line in the window matches.
    LastNonEmptyLine(LineMatch),
    /// The channel's own text — a terminal title — matches.
    Text(LineMatch),
    /// The last progress report is in one of these states.
    ProgressState(Vec<ProgressState>),
    /// A named predicate implemented in `classify.rs`.
    Structural(String),
}

/// The states an OSC 9;4 progress report can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressState {
    /// `0` — the report clears any progress.
    Removed,
    /// `1` — a determinate percentage.
    Normal,
    /// `2` — an error state.
    Error,
    /// `3` — indeterminate; work is happening with no known extent.
    Indeterminate,
    /// `4` — paused or waiting.
    Paused,
}

impl ProgressState {
    pub fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            0 => Self::Removed,
            1 => Self::Normal,
            2 => Self::Error,
            3 => Self::Indeterminate,
            4 => Self::Paused,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineMatch {
    /// ASCII case-insensitive substring.
    Contains(String),
    /// Every substring is present, in any order.
    ContainsAll(Vec<String>),
    /// Whitespace-trimmed equality, case-sensitive.
    Equals(String),
    /// Whitespace-trimmed prefix, case-sensitive.
    StartsWith(String),
    /// Any value in the named set is a substring.
    ContainsAny(VocabularySet),
    /// Every value in the named set is a substring, in any order.
    ContainsAllOf(VocabularySet),
    /// Any value in the named set is a whitespace-trimmed prefix.
    StartsWithAny(VocabularySet),
    /// The first non-space character is in the named set.
    StartsWithGlyph(VocabularySet),
    /// ...and the character after it is whitespace, so the glyph is a word of
    /// its own rather than the first letter of one.
    StartsWithGlyphWord(VocabularySet),
    /// Non-empty, and every character is in the named set or a space.
    AllCharactersIn(VocabularySet),
    AnyOf(Vec<LineMatch>),
    AllOf(Vec<LineMatch>),
    Not(Box<LineMatch>),
}
