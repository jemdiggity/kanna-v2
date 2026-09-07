//! Loading, validating and version-resolving the detection rule file.
//!
//! Parsing happens once per file load; version resolution happens once per
//! (provider, CLI version, rule generation) and is cached on the session's
//! classifier. Nothing here runs per frame.

use std::collections::{HashMap, HashSet};

use crate::protocol::{AgentProvider, SessionStatus};

use super::schema::{
    Channel, ChromeEntry, LineMatch, Predicate, ProgressState, Rule, RuleFile, Vocabulary,
    VocabularySet, SCHEMA_VERSION,
};
use super::version::{CliVersion, VersionRange};

/// The structural predicates `classify.rs` implements. A rule naming anything
/// else fails validation: an unknown name that quietly matched nothing would
/// reintroduce exactly the silent-degradation failure this file exists to end.
pub const STRUCTURAL_PREDICATES: &[&str] = &[
    "claude-working-footer",
    "claude-active-subagent",
    "claude-parked-composer",
    "claude-selected-menu-option",
    "opencode-composer-status",
    "copilot-busy-above-path",
    "copilot-idle-composer-below-path",
];

/// Which vocabulary a matcher's set references. Common and provider
/// vocabularies are separate namespaces on purpose: merging them would let
/// Codex's composer glyph satisfy Claude's composer test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Namespace {
    Common,
    Provider,
}

#[derive(Debug, Clone)]
pub enum Matcher {
    /// Needle already lowercased.
    Contains(String),
    ContainsAll(Vec<String>),
    Equals(String),
    StartsWith(String),
    ContainsAny(VocabularySet),
    ContainsAllOf(VocabularySet),
    StartsWithAny(VocabularySet),
    StartsWithGlyph(VocabularySet),
    StartsWithGlyphWord(VocabularySet),
    AllCharactersIn(VocabularySet),
    AnyOf(Vec<Matcher>),
    AllOf(Vec<Matcher>),
    Not(Box<Matcher>),
}

#[derive(Debug, Clone)]
pub enum CompiledPredicate {
    AnyLine(Matcher),
    AnyLineWrapped(Matcher),
    LastNonEmptyLine(Matcher),
    Text(Matcher),
    ProgressState(Vec<ProgressState>),
    Structural(&'static str),
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub id: String,
    pub status: SessionStatus,
    pub channel: Channel,
    pub namespace: Namespace,
    pub versions: VersionRange,
    pub priority: i32,
    pub order: usize,
    pub predicate: CompiledPredicate,
}

#[derive(Debug, Clone)]
pub struct CompiledChrome {
    pub id: String,
    pub namespace: Namespace,
    pub versions: VersionRange,
    pub matcher: Matcher,
}

/// One vocabulary set, resolved for a specific CLI version.
#[derive(Debug, Clone, Default)]
pub struct ResolvedSet {
    pub values: Vec<String>,
    pub values_lower: Vec<String>,
    pub glyphs: Vec<char>,
}

impl ResolvedSet {
    pub fn is_empty(&self) -> bool {
        self.values.is_empty() && self.glyphs.is_empty()
    }
}

const SET_COUNT: usize = 21;

fn set_index(set: VocabularySet) -> usize {
    match set {
        VocabularySet::ComposerPrompts => 0,
        VocabularySet::IdlePromptGlyphs => 1,
        VocabularySet::SpinnerGlyphs => 2,
        VocabularySet::WorkingFooterGlyphs => 3,
        VocabularySet::InFlightMarkers => 4,
        VocabularySet::DoneFooterMarkers => 5,
        VocabularySet::BusyMarkers => 6,
        VocabularySet::WaitingMarkers => 7,
        VocabularySet::PermissionActionMarkers => 19,
        VocabularySet::MenuCaretGlyphs => 20,
        VocabularySet::DividerGlyphs => 8,
        VocabularySet::BoxBorderGlyphs => 9,
        VocabularySet::ComposerStatusSeparators => 10,
        VocabularySet::SubagentParentPrefixes => 11,
        VocabularySet::SubagentTaskPrefixes => 12,
        VocabularySet::BlockArtGlyphs => 13,
        VocabularySet::FooterProgressGlyphs => 14,
        VocabularySet::TurnSummaryGlyphs => 15,
        VocabularySet::WorktreePathMarkers => 16,
        VocabularySet::TitleBusyGlyphs => 17,
        VocabularySet::TitleIdleGlyphs => 18,
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedVocabulary {
    sets: [ResolvedSet; SET_COUNT],
}

impl Default for ResolvedVocabulary {
    fn default() -> Self {
        Self {
            sets: std::array::from_fn(|_| ResolvedSet::default()),
        }
    }
}

impl ResolvedVocabulary {
    pub fn get(&self, set: VocabularySet) -> &ResolvedSet {
        &self.sets[set_index(set)]
    }

    fn push_strings(&mut self, set: VocabularySet, values: &[String]) {
        let resolved = &mut self.sets[set_index(set)];
        for value in values {
            resolved.values.push(value.clone());
            resolved.values_lower.push(value.to_ascii_lowercase());
        }
    }

    fn push_glyphs(&mut self, set: VocabularySet, glyphs: &[char]) {
        let resolved = &mut self.sets[set_index(set)];
        for glyph in glyphs {
            resolved.glyphs.push(*glyph);
            resolved.values.push(glyph.to_string());
            resolved.values_lower.push(glyph.to_lowercase().to_string());
        }
    }
}

/// A version-gated vocabulary entry, with its range and payload parsed once.
#[derive(Debug, Clone)]
struct VocabularyEntry {
    id: String,
    set: VocabularySet,
    versions: VersionRange,
    values: Vec<String>,
    glyphs: Vec<char>,
}

#[derive(Debug, Clone, Default)]
struct CompiledVocabulary {
    entries: Vec<VocabularyEntry>,
}

impl CompiledVocabulary {
    fn resolve(&self, version: Option<&CliVersion>) -> ResolvedVocabulary {
        let mut resolved = ResolvedVocabulary::default();
        for entry in &self.entries {
            if !entry.versions.admits(version) {
                continue;
            }
            if !entry.values.is_empty() {
                resolved.push_strings(entry.set, &entry.values);
            }
            if !entry.glyphs.is_empty() {
                resolved.push_glyphs(entry.set, &entry.glyphs);
            }
        }
        resolved
    }
}

#[derive(Debug, Clone)]
struct CompiledProvider {
    probe_args: Vec<String>,
    vocabulary: CompiledVocabulary,
    chrome: Vec<CompiledChrome>,
    rules: Vec<CompiledRule>,
    status_rows: Option<usize>,
    waiting_prompt_rows: Option<usize>,
}

/// How many rendered rows status classification reads when a provider does not
/// declare its own. Eight is what every provider was measured with.
pub const DEFAULT_STATUS_ROWS: usize = 8;

#[derive(Debug, Clone)]
pub struct CompiledRules {
    common_vocabulary: CompiledVocabulary,
    common_chrome: Vec<CompiledChrome>,
    common_rules: Vec<CompiledRule>,
    providers: HashMap<AgentProvider, CompiledProvider>,
}

/// A rule set narrowed to one provider and one CLI version.
#[derive(Debug, Clone)]
pub struct ResolvedRules {
    pub provider: AgentProvider,
    pub version: Option<CliVersion>,
    pub common: ResolvedVocabulary,
    pub vocabulary: ResolvedVocabulary,
    pub chrome: Vec<(Namespace, Matcher)>,
    pub rules: Vec<ResolvedRule>,
    pub status_rows: usize,
    pub waiting_prompt_rows: usize,
    pub probe_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRule {
    pub id: String,
    pub status: SessionStatus,
    pub channel: Channel,
    pub namespace: Namespace,
    pub predicate: CompiledPredicate,
}

impl ResolvedRules {
    pub fn vocabulary_for(&self, namespace: Namespace) -> &ResolvedVocabulary {
        match namespace {
            Namespace::Common => &self.common,
            Namespace::Provider => &self.vocabulary,
        }
    }
}

impl CompiledRules {
    pub fn parse(contents: &str, origin: &str) -> Result<Self, String> {
        let file: RuleFile = serde_json::from_str(contents)
            .map_err(|error| format!("{origin} is not a valid detection rule file: {error}"))?;
        Self::compile(file, origin)
    }

    fn compile(file: RuleFile, origin: &str) -> Result<Self, String> {
        if file.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "{origin} declares schemaVersion {} but this daemon understands {SCHEMA_VERSION}",
                file.schema_version
            ));
        }

        // Ids are the merge key an override file replaces by, so they must be
        // unique across the whole file — vocabulary, chrome and rules alike.
        let mut seen_ids = HashSet::new();
        let common_vocabulary =
            compile_vocabulary(&file.common.vocabulary, origin, "common", &mut seen_ids)?;
        let common_chrome = compile_chrome(
            &file.common.chrome,
            Namespace::Common,
            origin,
            "common",
            &mut seen_ids,
        )?;
        let common_rules = compile_rules(
            &file.common.rules,
            Namespace::Common,
            origin,
            "common",
            &mut seen_ids,
            0,
        )?;

        let mut providers = HashMap::new();
        for (index, provider_set) in file.providers.iter().enumerate() {
            let label = format!("provider {:?}", provider_set.provider);
            if providers.contains_key(&provider_set.provider) {
                return Err(format!("{origin}: {label} is declared twice"));
            }
            let vocabulary =
                compile_vocabulary(&provider_set.vocabulary, origin, &label, &mut seen_ids)?;
            let chrome = compile_chrome(
                &provider_set.chrome,
                Namespace::Provider,
                origin,
                &label,
                &mut seen_ids,
            )?;
            let rules = compile_rules(
                &provider_set.rules,
                Namespace::Provider,
                origin,
                &label,
                &mut seen_ids,
                (index + 1) * 10_000,
            )?;
            providers.insert(
                provider_set.provider,
                CompiledProvider {
                    probe_args: provider_set
                        .version_probe
                        .as_ref()
                        .map(|probe| probe.args.clone())
                        .unwrap_or_default(),
                    vocabulary,
                    chrome,
                    rules,
                    status_rows: provider_set.status_rows,
                    waiting_prompt_rows: provider_set.waiting_prompt_rows,
                },
            );
        }

        Ok(Self {
            common_vocabulary,
            common_chrome,
            common_rules,
            providers,
        })
    }

    /// Merge an override file over this one, by id.
    ///
    /// An override entry with the same `id` as a bundled entry replaces it in
    /// place; anything else is appended. That is what lets a single-rule fix
    /// ship as a five-line file instead of a restatement of everything the
    /// daemon already knows.
    pub fn merge_over(&self, overlay: &CompiledRules) -> CompiledRules {
        let mut merged = self.clone();
        merge_vocabulary(&mut merged.common_vocabulary, &overlay.common_vocabulary);
        merge_chrome(&mut merged.common_chrome, &overlay.common_chrome);
        merge_rules(&mut merged.common_rules, &overlay.common_rules);

        for (provider, overlay_provider) in &overlay.providers {
            match merged.providers.get_mut(provider) {
                Some(base) => {
                    if !overlay_provider.probe_args.is_empty() {
                        base.probe_args = overlay_provider.probe_args.clone();
                    }
                    merge_vocabulary(&mut base.vocabulary, &overlay_provider.vocabulary);
                    merge_chrome(&mut base.chrome, &overlay_provider.chrome);
                    merge_rules(&mut base.rules, &overlay_provider.rules);
                    if overlay_provider.status_rows.is_some() {
                        base.status_rows = overlay_provider.status_rows;
                    }
                    if overlay_provider.waiting_prompt_rows.is_some() {
                        base.waiting_prompt_rows = overlay_provider.waiting_prompt_rows;
                    }
                }
                None => {
                    merged.providers.insert(*provider, overlay_provider.clone());
                }
            }
        }
        merged
    }

    /// Every composer prompt glyph any provider draws, for the provider-neutral
    /// composer test the task-logs tail shares with the daemon.
    pub fn global_composer_prompts(&self) -> Vec<char> {
        self.common_vocabulary
            .resolve(None)
            .get(VocabularySet::ComposerPrompts)
            .glyphs
            .clone()
    }

    pub fn probe_args(&self, provider: AgentProvider) -> Vec<String> {
        self.providers
            .get(&provider)
            .map(|compiled| compiled.probe_args.clone())
            .unwrap_or_default()
    }

    pub fn resolve(&self, provider: AgentProvider, version: Option<&CliVersion>) -> ResolvedRules {
        let compiled = self.providers.get(&provider);
        let common = self.common_vocabulary.resolve(version);
        let vocabulary = compiled
            .map(|compiled| compiled.vocabulary.resolve(version))
            .unwrap_or_default();

        let mut chrome = Vec::new();
        for entry in self
            .common_chrome
            .iter()
            .chain(compiled.iter().flat_map(|compiled| compiled.chrome.iter()))
        {
            if entry.versions.admits(version) {
                chrome.push((entry.namespace, entry.matcher.clone()));
            }
        }

        let status_rows = compiled
            .and_then(|compiled| compiled.status_rows)
            .unwrap_or(DEFAULT_STATUS_ROWS);
        let mut selected = self
            .common_rules
            .iter()
            .chain(compiled.iter().flat_map(|compiled| compiled.rules.iter()))
            .filter(|rule| rule.versions.admits(version))
            .collect::<Vec<_>>();
        // Grid before every other channel, then declared priority, then file
        // order. The channel key is not a tie-break: a title rule must never
        // pre-empt a frame that already proved something.
        selected.sort_by_key(|rule| (rule.channel, rule.priority, rule.order));

        ResolvedRules {
            provider,
            version: version.cloned(),
            common,
            vocabulary,
            chrome,
            rules: selected
                .into_iter()
                .map(|rule| ResolvedRule {
                    id: rule.id.clone(),
                    status: rule.status,
                    channel: rule.channel,
                    namespace: rule.namespace,
                    predicate: rule.predicate.clone(),
                })
                .collect(),
            status_rows,
            waiting_prompt_rows: compiled
                .and_then(|compiled| compiled.waiting_prompt_rows)
                .unwrap_or(status_rows),
            probe_args: compiled
                .map(|compiled| compiled.probe_args.clone())
                .unwrap_or_default(),
        }
    }

    /// Every rule id this file declares, for tests and diagnostics.
    pub fn rule_ids(&self) -> Vec<String> {
        self.common_rules
            .iter()
            .map(|rule| rule.id.clone())
            .chain(
                self.providers
                    .values()
                    .flat_map(|provider| provider.rules.iter().map(|rule| rule.id.clone())),
            )
            .collect()
    }
}

fn merge_vocabulary(base: &mut CompiledVocabulary, overlay: &CompiledVocabulary) {
    for entry in &overlay.entries {
        match base
            .entries
            .iter_mut()
            .find(|existing| existing.id == entry.id)
        {
            Some(existing) => *existing = entry.clone(),
            None => base.entries.push(entry.clone()),
        }
    }
}

fn merge_chrome(base: &mut Vec<CompiledChrome>, overlay: &[CompiledChrome]) {
    for entry in overlay {
        match base.iter_mut().find(|existing| existing.id == entry.id) {
            Some(existing) => *existing = entry.clone(),
            None => base.push(entry.clone()),
        }
    }
}

fn merge_rules(base: &mut Vec<CompiledRule>, overlay: &[CompiledRule]) {
    for rule in overlay {
        match base.iter_mut().find(|existing| existing.id == rule.id) {
            Some(existing) => {
                let order = existing.order;
                *existing = rule.clone();
                existing.order = order;
            }
            None => base.push(rule.clone()),
        }
    }
}

fn compile_vocabulary(
    vocabulary: &Vocabulary,
    origin: &str,
    label: &str,
    seen_ids: &mut HashSet<String>,
) -> Result<CompiledVocabulary, String> {
    let mut entries = Vec::new();
    let string_sets: &[(VocabularySet, &Vec<super::schema::VersionedStrings>)] = &[
        (
            VocabularySet::InFlightMarkers,
            &vocabulary.in_flight_markers,
        ),
        (
            VocabularySet::DoneFooterMarkers,
            &vocabulary.done_footer_markers,
        ),
        (VocabularySet::BusyMarkers, &vocabulary.busy_markers),
        (VocabularySet::WaitingMarkers, &vocabulary.waiting_markers),
        (
            VocabularySet::PermissionActionMarkers,
            &vocabulary.permission_action_markers,
        ),
        (
            VocabularySet::ComposerStatusSeparators,
            &vocabulary.composer_status_separators,
        ),
        (
            VocabularySet::SubagentParentPrefixes,
            &vocabulary.subagent_parent_prefixes,
        ),
        (
            VocabularySet::SubagentTaskPrefixes,
            &vocabulary.subagent_task_prefixes,
        ),
        (
            VocabularySet::WorktreePathMarkers,
            &vocabulary.worktree_path_markers,
        ),
    ];
    for (set, declared) in string_sets {
        for entry in *declared {
            if !seen_ids.insert(entry.id.clone()) {
                return Err(format!(
                    "{origin}: {label} declares the id {} more than once",
                    entry.id
                ));
            }
            if entry.values.is_empty() {
                return Err(format!(
                    "{origin}: {label} vocabulary entry {} declares no values",
                    entry.id
                ));
            }
            entries.push(VocabularyEntry {
                id: entry.id.clone(),
                set: *set,
                versions: parse_range(entry.versions.as_deref(), origin, &entry.id)?,
                values: entry.values.clone(),
                glyphs: Vec::new(),
            });
        }
    }

    let glyph_sets: &[(VocabularySet, &Vec<super::schema::VersionedGlyphs>)] = &[
        (VocabularySet::ComposerPrompts, &vocabulary.composer_prompts),
        (
            VocabularySet::IdlePromptGlyphs,
            &vocabulary.idle_prompt_glyphs,
        ),
        (VocabularySet::SpinnerGlyphs, &vocabulary.spinner_glyphs),
        (
            VocabularySet::WorkingFooterGlyphs,
            &vocabulary.working_footer_glyphs,
        ),
        (VocabularySet::DividerGlyphs, &vocabulary.divider_glyphs),
        (
            VocabularySet::BoxBorderGlyphs,
            &vocabulary.box_border_glyphs,
        ),
        (VocabularySet::BlockArtGlyphs, &vocabulary.block_art_glyphs),
        (
            VocabularySet::FooterProgressGlyphs,
            &vocabulary.footer_progress_glyphs,
        ),
        (
            VocabularySet::TurnSummaryGlyphs,
            &vocabulary.turn_summary_glyphs,
        ),
        (
            VocabularySet::TitleBusyGlyphs,
            &vocabulary.title_busy_glyphs,
        ),
        (
            VocabularySet::TitleIdleGlyphs,
            &vocabulary.title_idle_glyphs,
        ),
        (
            VocabularySet::MenuCaretGlyphs,
            &vocabulary.menu_caret_glyphs,
        ),
    ];
    for (set, declared) in glyph_sets {
        for entry in *declared {
            if !seen_ids.insert(entry.id.clone()) {
                return Err(format!(
                    "{origin}: {label} declares the id {} more than once",
                    entry.id
                ));
            }
            if entry.glyphs.is_empty() {
                return Err(format!(
                    "{origin}: {label} vocabulary entry {} declares no glyphs",
                    entry.id
                ));
            }
            let mut glyphs = Vec::with_capacity(entry.glyphs.len());
            for glyph in &entry.glyphs {
                let mut characters = glyph.chars();
                match (characters.next(), characters.next()) {
                    (Some(character), None) => glyphs.push(character),
                    _ => {
                        return Err(format!(
                            "{origin}: {label} vocabulary entry {} declares {glyph:?}, which is \
                             not a single character; glyph sets are compared character by \
                             character and a longer value could never match",
                            entry.id
                        ))
                    }
                }
            }
            entries.push(VocabularyEntry {
                id: entry.id.clone(),
                set: *set,
                versions: parse_range(entry.versions.as_deref(), origin, &entry.id)?,
                values: Vec::new(),
                glyphs,
            });
        }
    }

    Ok(CompiledVocabulary { entries })
}

fn compile_chrome(
    declared: &[ChromeEntry],
    namespace: Namespace,
    origin: &str,
    label: &str,
    seen_ids: &mut HashSet<String>,
) -> Result<Vec<CompiledChrome>, String> {
    declared
        .iter()
        .map(|entry| {
            if !seen_ids.insert(entry.id.clone()) {
                return Err(format!(
                    "{origin}: {label} declares the id {} more than once",
                    entry.id
                ));
            }
            Ok(CompiledChrome {
                id: entry.id.clone(),
                namespace,
                versions: parse_range(entry.versions.as_deref(), origin, &entry.id)?,
                matcher: compile_match(&entry.line_match),
            })
        })
        .collect()
}

fn compile_rules(
    declared: &[Rule],
    namespace: Namespace,
    origin: &str,
    label: &str,
    seen_ids: &mut HashSet<String>,
    order_base: usize,
) -> Result<Vec<CompiledRule>, String> {
    declared
        .iter()
        .enumerate()
        .map(|(index, rule)| {
            if !seen_ids.insert(rule.id.clone()) {
                return Err(format!(
                    "{origin}: {label} declares the id {} more than once",
                    rule.id
                ));
            }
            let predicate = compile_predicate(&rule.when, origin, &rule.id)?;
            check_channel(&predicate, rule.channel, origin, &rule.id)?;
            Ok(CompiledRule {
                id: rule.id.clone(),
                status: rule.status,
                channel: rule.channel,
                namespace,
                versions: parse_range(rule.versions.as_deref(), origin, &rule.id)?,
                priority: rule.priority,
                order: order_base + index,
                predicate,
            })
        })
        .collect()
}

/// A predicate reads one kind of evidence, so a rule that names a channel its
/// predicate cannot read is a mistake, not a configuration. Refusing it at load
/// is what stops a title pattern from being written against the grid and then
/// quietly never matching.
fn check_channel(
    predicate: &CompiledPredicate,
    channel: Channel,
    origin: &str,
    rule_id: &str,
) -> Result<(), String> {
    let required = match predicate {
        CompiledPredicate::Text(_) => Channel::Title,
        CompiledPredicate::ProgressState(_) => Channel::Progress,
        CompiledPredicate::AnyLine(_)
        | CompiledPredicate::AnyLineWrapped(_)
        | CompiledPredicate::LastNonEmptyLine(_)
        | CompiledPredicate::Structural(_) => Channel::Grid,
    };
    if channel == required {
        return Ok(());
    }
    Err(format!(
        "{origin}: rule {rule_id} declares channel {channel:?} but its predicate reads \
         {required:?}"
    ))
}

fn compile_predicate(
    predicate: &Predicate,
    origin: &str,
    rule_id: &str,
) -> Result<CompiledPredicate, String> {
    Ok(match predicate {
        Predicate::AnyLine(line_match) => CompiledPredicate::AnyLine(compile_match(line_match)),
        Predicate::AnyLineWrapped(line_match) => {
            CompiledPredicate::AnyLineWrapped(compile_match(line_match))
        }
        Predicate::LastNonEmptyLine(line_match) => {
            CompiledPredicate::LastNonEmptyLine(compile_match(line_match))
        }
        Predicate::Text(line_match) => CompiledPredicate::Text(compile_match(line_match)),
        Predicate::ProgressState(states) => {
            if states.is_empty() {
                return Err(format!("{origin}: rule {rule_id} lists no progress states"));
            }
            CompiledPredicate::ProgressState(states.clone())
        }
        Predicate::Structural(name) => {
            let known = STRUCTURAL_PREDICATES
                .iter()
                .find(|candidate| *candidate == name)
                .ok_or_else(|| {
                    format!(
                        "{origin}: rule {rule_id} names the structural predicate {name:?}, which \
                         this daemon does not implement; known predicates are {}",
                        STRUCTURAL_PREDICATES.join(", ")
                    )
                })?;
            CompiledPredicate::Structural(known)
        }
    })
}

fn compile_match(line_match: &LineMatch) -> Matcher {
    match line_match {
        LineMatch::Contains(value) => Matcher::Contains(value.to_ascii_lowercase()),
        LineMatch::ContainsAll(values) => {
            Matcher::ContainsAll(values.iter().map(|v| v.to_ascii_lowercase()).collect())
        }
        LineMatch::Equals(value) => Matcher::Equals(value.clone()),
        LineMatch::StartsWith(value) => Matcher::StartsWith(value.clone()),
        LineMatch::ContainsAny(set) => Matcher::ContainsAny(*set),
        LineMatch::ContainsAllOf(set) => Matcher::ContainsAllOf(*set),
        LineMatch::StartsWithAny(set) => Matcher::StartsWithAny(*set),
        LineMatch::StartsWithGlyph(set) => Matcher::StartsWithGlyph(*set),
        LineMatch::StartsWithGlyphWord(set) => Matcher::StartsWithGlyphWord(*set),
        LineMatch::AllCharactersIn(set) => Matcher::AllCharactersIn(*set),
        LineMatch::AnyOf(matches) => Matcher::AnyOf(matches.iter().map(compile_match).collect()),
        LineMatch::AllOf(matches) => Matcher::AllOf(matches.iter().map(compile_match).collect()),
        LineMatch::Not(inner) => Matcher::Not(Box::new(compile_match(inner))),
    }
}

fn parse_range(raw: Option<&str>, origin: &str, id: &str) -> Result<VersionRange, String> {
    VersionRange::parse(raw.unwrap_or("*"))
        .map_err(|error| format!("{origin}: {id} has an invalid version range: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{CompiledRules, Namespace, STRUCTURAL_PREDICATES};
    use crate::detection::schema::VocabularySet;
    use crate::detection::version::CliVersion;
    use crate::protocol::{AgentProvider, SessionStatus};

    const PROVIDERS: &[AgentProvider] = &[
        AgentProvider::Claude,
        AgentProvider::Codex,
        AgentProvider::Opencode,
        AgentProvider::Antigravity,
        AgentProvider::Copilot,
    ];

    #[test]
    fn the_bundled_rules_parse_and_cover_every_provider() {
        let rules = crate::detection::bundled();
        for provider in PROVIDERS {
            let resolved = rules.resolve(*provider, None);
            assert!(
                !resolved.rules.is_empty(),
                "{provider:?} must declare detection rules"
            );
            assert!(
                !resolved.probe_args.is_empty(),
                "{provider:?} must declare how to read its CLI version"
            );
        }
    }

    /// Every structural predicate the daemon implements is used by the bundled
    /// file, and every one the file names is implemented. The second half is
    /// enforced at load; this is the first half, which stops a predicate from
    /// quietly outliving the rule that needed it.
    #[test]
    fn every_implemented_structural_predicate_is_used() {
        let rules = crate::detection::bundled();
        let used = PROVIDERS
            .iter()
            .flat_map(|provider| rules.resolve(*provider, None).rules)
            .filter_map(|rule| match rule.predicate {
                super::CompiledPredicate::Structural(name) => Some(name),
                _ => None,
            })
            .collect::<Vec<_>>();
        for predicate in STRUCTURAL_PREDICATES {
            assert!(
                used.contains(predicate),
                "{predicate} is implemented but no bundled rule uses it"
            );
        }
    }

    /// A rule's id is its provenance in logs, tests and regression fixtures.
    /// Two rules answering to one id would make that provenance a lie.
    #[test]
    fn bundled_rule_ids_are_unique() {
        let mut ids = crate::detection::bundled().rule_ids();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count);
    }

    fn parse(json: &str) -> Result<CompiledRules, String> {
        CompiledRules::parse(json, "the test rule file")
    }

    #[test]
    fn a_newer_schema_version_is_refused_rather_than_half_read() {
        let error = parse(r#"{"schemaVersion": 99, "providers": []}"#).unwrap_err();
        assert!(error.contains("schemaVersion 99"), "{error}");
    }

    #[test]
    fn an_unknown_structural_predicate_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [{
                  "id": "claude/busy/invented",
                  "status": "busy",
                  "priority": 10,
                  "when": { "structural": "claude-reads-minds" }
                }]
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("claude-reads-minds"), "{error}");
    }

    /// A glyph set is compared character by character, so a longer value could
    /// never match. Refusing it at load is the difference between a typo that
    /// is reported and one that silently costs a verdict.
    #[test]
    fn a_multi_character_glyph_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "vocabulary": {
                  "composerPrompts": [{ "id": "x", "glyphs": ["->"] }]
                }
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("not a single character"), "{error}");
    }

    #[test]
    fn an_unknown_vocabulary_key_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "vocabulary": { "composerGlyphs": [] }
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("composerGlyphs"), "{error}");
    }

    #[test]
    fn a_duplicate_id_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [
                  {
                    "id": "claude/busy/x",
                    "status": "busy",
                    "priority": 10,
                    "when": { "anyLine": { "contains": "a" } }
                  },
                  {
                    "id": "claude/busy/x",
                    "status": "busy",
                    "priority": 20,
                    "when": { "anyLine": { "contains": "b" } }
                  }
                ]
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("more than once"), "{error}");
    }

    #[test]
    fn an_invalid_version_range_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [{
                  "id": "claude/busy/x",
                  "status": "busy",
                  "priority": 10,
                  "versions": "2.1.263",
                  "when": { "anyLine": { "contains": "a" } }
                }]
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("invalid version range"), "{error}");
    }

    /// A rule that names a channel its predicate cannot read is a mistake, not
    /// a configuration: written that way, a title pattern would be matched
    /// against the grid and quietly never fire.
    #[test]
    fn a_rule_whose_channel_and_predicate_disagree_is_refused() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [{
                  "id": "claude/busy/title-on-the-grid",
                  "status": "busy",
                  "channel": "grid",
                  "priority": 10,
                  "when": { "text": { "contains": "working" } }
                }]
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("channel Grid"), "{error}");
    }

    /// An override replaces the bundled entry that shares its id and appends
    /// anything else, so a one-rule fix is a five-line file rather than a
    /// restatement of everything the daemon already knows.
    #[test]
    fn an_override_replaces_by_id_and_appends_the_rest() {
        let overlay = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [
                  {
                    "id": "claude/busy/interrupt-marker",
                    "status": "busy",
                    "priority": 20,
                    "when": { "anyLine": { "contains": "press esc to stop" } }
                  },
                  {
                    "id": "claude/waiting/new-dialog-shape",
                    "status": "waiting",
                    "priority": 12,
                    "when": { "anyLine": { "contains": "approve this edit?" } }
                  }
                ]
              }]
            }"#,
        )
        .unwrap();
        let merged = crate::detection::bundled().merge_over(&overlay);
        let resolved = merged.resolve(AgentProvider::Claude, None);

        let replaced = resolved
            .rules
            .iter()
            .filter(|rule| rule.id == "claude/busy/interrupt-marker")
            .count();
        assert_eq!(replaced, 1, "the override must replace, not duplicate");

        assert!(
            resolved
                .rules
                .iter()
                .any(|rule| rule.id == "claude/waiting/new-dialog-shape"),
            "a rule the bundled file has never seen must be added"
        );
        assert!(
            resolved
                .rules
                .iter()
                .any(|rule| rule.id == "claude/idle/parked-composer"),
            "an override must not drop the rules it does not mention"
        );
    }

    /// Vocabulary merges by id too, so a marker whose wording moved is fixed
    /// by restating one entry rather than the provider's whole vocabulary.
    #[test]
    fn an_override_replaces_a_vocabulary_entry_by_id() {
        let overlay = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "opencode",
                "vocabulary": {
                  "inFlightMarkers": [{
                    "id": "opencode/vocab/interrupt-1.18",
                    "versions": ">=1.17",
                    "values": ["press esc to interrupt"]
                  }]
                }
              }]
            }"#,
        )
        .unwrap();
        let merged = crate::detection::bundled().merge_over(&overlay);
        let resolved = merged.resolve(
            AgentProvider::Opencode,
            CliVersion::parse("1.18.15").as_ref(),
        );
        let markers = &resolved
            .vocabulary
            .get(VocabularySet::InFlightMarkers)
            .values;
        assert!(markers
            .iter()
            .any(|value| value == "press esc to interrupt"));
        assert!(
            !markers.iter().any(|value| value == "esc interrupt"),
            "the replaced entry must not survive beside its replacement: {markers:?}"
        );
        assert!(
            markers.iter().any(|value| value == "esc to interrupt"),
            "an entry the override did not mention must survive: {markers:?}"
        );
    }

    /// Ids are the merge key, so they cannot repeat anywhere in the file.
    #[test]
    fn a_vocabulary_id_may_not_repeat() {
        let error = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "vocabulary": {
                  "spinnerGlyphs": [{ "id": "dup", "glyphs": ["a"] }],
                  "composerPrompts": [{ "id": "dup", "glyphs": ["b"] }]
                }
              }]
            }"#,
        )
        .unwrap_err();
        assert!(error.contains("more than once"), "{error}");
    }

    /// An override may teach the daemon about a CLI release this build
    /// predates, without a daemon release.
    #[test]
    fn an_override_can_add_a_rule_for_an_unreleased_cli_version() {
        let overlay = parse(
            r#"{
              "schemaVersion": 1,
              "providers": [{
                "provider": "claude",
                "rules": [{
                  "id": "claude/busy/future-footer",
                  "status": "busy",
                  "priority": 25,
                  "versions": ">=3.0.0",
                  "when": { "anyLine": { "contains": "still cooking" } }
                }]
              }]
            }"#,
        )
        .unwrap();
        let merged = crate::detection::bundled().merge_over(&overlay);

        let future = CliVersion::parse("3.1.0");
        assert!(merged
            .resolve(AgentProvider::Claude, future.as_ref())
            .rules
            .iter()
            .any(|rule| rule.id == "claude/busy/future-footer"));
        assert!(
            !merged
                .resolve(AgentProvider::Claude, CliVersion::parse("2.1.263").as_ref())
                .rules
                .iter()
                .any(|rule| rule.id == "claude/busy/future-footer"),
            "a rule measured against a later release must not reach an earlier one"
        );
    }

    /// The grid is authoritative. Ordering guarantees it, so pin the ordering.
    #[test]
    fn grid_rules_are_ordered_ahead_of_every_other_channel() {
        let resolved = crate::detection::bundled()
            .resolve(AgentProvider::Claude, CliVersion::parse("2.1.263").as_ref());
        let first_non_grid = resolved
            .rules
            .iter()
            .position(|rule| rule.channel != crate::detection::schema::Channel::Grid)
            .expect("Claude declares a title rule");
        assert!(
            resolved.rules[..first_non_grid]
                .iter()
                .all(|rule| rule.channel == crate::detection::schema::Channel::Grid),
            "no non-grid rule may be evaluated before a grid rule"
        );
    }

    /// Common and provider vocabularies stay separate namespaces. Merging them
    /// would let one provider's composer glyph satisfy another's composer test.
    #[test]
    fn the_common_composer_set_does_not_leak_into_a_provider_vocabulary() {
        let rules = crate::detection::bundled();
        let claude = rules.resolve(AgentProvider::Claude, None);
        assert_eq!(
            claude.vocabulary.get(VocabularySet::ComposerPrompts).glyphs,
            vec!['\u{276F}']
        );
        assert!(claude
            .common
            .get(VocabularySet::ComposerPrompts)
            .glyphs
            .contains(&'\u{203A}'));
        assert!(claude
            .chrome
            .iter()
            .any(|(namespace, _)| *namespace == Namespace::Common));
    }

    /// A provider the file says nothing about classifies nothing, rather than
    /// falling back to another provider's chrome.
    #[test]
    fn an_undeclared_provider_resolves_to_the_common_rules_only() {
        let rules = parse(r#"{"schemaVersion": 1, "providers": []}"#).unwrap();
        let resolved = rules.resolve(AgentProvider::Claude, None);
        assert!(resolved.rules.is_empty());
        assert_eq!(resolved.status_rows, super::DEFAULT_STATUS_ROWS);
    }

    /// Waiting stays a positive match on provider-drawn chrome. Nothing in the
    /// bundled file may reach that verdict from a channel other than the grid.
    #[test]
    fn no_bundled_rule_reaches_waiting_from_outside_the_grid() {
        let rules = crate::detection::bundled();
        for provider in PROVIDERS {
            for rule in rules.resolve(*provider, None).rules {
                if rule.status == SessionStatus::Waiting {
                    assert_eq!(
                        rule.channel,
                        crate::detection::schema::Channel::Grid,
                        "{} must decide waiting from the rendered grid",
                        rule.id
                    );
                }
            }
        }
    }
}
