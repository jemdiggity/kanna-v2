use super::definitions::AgentDefinition;
pub(super) use kanna_agent_protocol::{AgentProvider, AgentSessionType};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ResolveProviderCandidatesError {
    NotConfigured,
    Unsupported(String),
}

impl fmt::Display for ResolveProviderCandidatesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => {
                formatter.write_str("No agent provider configured for this request.")
            }
            Self::Unsupported(candidate) => write!(
                formatter,
                "unsupported agent provider '{candidate}' (supported: {})",
                AgentProvider::ALL
                    .iter()
                    .map(|provider| provider.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

pub(super) fn resolve_agent_type(
    explicit_agent_type: Option<&str>,
    provider: AgentProvider,
) -> Result<AgentSessionType, String> {
    let agent_type = match normalize_agent_type(explicit_agent_type) {
        Some("pty") => Ok(AgentSessionType::Pty),
        Some("agent") => Ok(AgentSessionType::Agent),
        Some(other) => Err(format!("unsupported agent_type: {}", other)),
        None => Ok(provider.default_session_type()),
    }?;

    if agent_type == AgentSessionType::Agent && !provider.supports_headless() {
        return Err(format!(
            "provider {provider} does not support headless agent sessions"
        ));
    }
    Ok(agent_type)
}

pub(super) fn normalize_agent_type(agent_type: Option<&str>) -> Option<&str> {
    match agent_type {
        Some("sdk" | "chat") => Some("agent"),
        Some(value) => Some(value),
        None => None,
    }
}

pub(super) fn validate_model_shape(model: Option<&str>) -> Result<(), String> {
    let Some(model) = model else {
        return Ok(());
    };
    if model.is_empty() {
        return Err("model override must not be empty".to_string());
    }
    if model.trim() != model {
        return Err("model override must not have leading or trailing whitespace".to_string());
    }
    if model.chars().any(char::is_control) {
        return Err("model override must not contain control characters".to_string());
    }
    Ok(())
}

pub(super) fn validate_effort_shape(effort: Option<&str>) -> Result<(), String> {
    let Some(effort) = effort else {
        return Ok(());
    };
    if effort.is_empty() {
        return Err("effort override must not be empty".to_string());
    }
    if effort.trim() != effort {
        return Err("effort override must not have leading or trailing whitespace".to_string());
    }
    if effort.chars().any(char::is_control) {
        return Err("effort override must not contain control characters".to_string());
    }
    Ok(())
}

/// Shape checks plus the provider-coherence rule, which
/// `kanna_agent_protocol` owns for every layer that may name a model —
/// compact selectors included — so the rule is stated once.
pub(super) fn validate_provider_model(
    provider: AgentProvider,
    model: Option<&str>,
) -> Result<(), String> {
    validate_model_shape(model)?;
    kanna_agent_protocol::validate_provider_model(provider, model)
}

/// Shape checks plus the provider's published effort vocabulary; see
/// [`validate_provider_model`] for why the rule itself lives in the protocol
/// crate.
pub(super) fn validate_provider_effort(
    provider: AgentProvider,
    effort: Option<&str>,
) -> Result<(), String> {
    validate_effort_shape(effort)?;
    kanna_agent_protocol::validate_provider_effort(provider, effort)
}

/// Validate one advance-carried provider override and turn it into the
/// durable record the spawned stage run keeps.
///
/// The pair is checked here, at request time, rather than at spawn: an
/// incoherent one (`codex -m opus`, an effort outside the provider's
/// vocabulary) is a bad request, and failing it later would leave a task
/// parked behind a stage that never started. The coherence rules themselves
/// come from `kanna_agent_protocol`, the same statement compact provider
/// selectors are parsed against.
///
/// A model or effort without a provider is refused rather than defaulted:
/// model and effort ids are provider-specific, so a value with no provider
/// beside it is exactly the cross-layer composition provider resolution
/// exists to prevent.
pub(crate) fn parse_stage_provider_override(
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    source: Option<&str>,
) -> Result<Option<crate::db::StageProviderOverride>, String> {
    let provider = provider.map(str::trim).filter(|value| !value.is_empty());
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    let effort = effort.map(str::trim).filter(|value| !value.is_empty());
    let source = source.map(str::trim).filter(|value| !value.is_empty());
    let Some(provider_id) = provider else {
        if model.is_some() || effort.is_some() {
            return Err(
                "a next-stage model or effort override needs a provider: model and effort ids are \
                 provider-specific and are never applied to a provider chosen by another layer"
                    .to_string(),
            );
        }
        if source.is_some() {
            return Err(
                "a next-stage provider override source was declared without an override"
                    .to_string(),
            );
        }
        return Ok(None);
    };
    // Deliberately one provider, not an ordered list: a list carries no way to
    // say which candidate a single model was written for, which is the whole
    // reason workflow stages need compact selectors. An override names the
    // provider it means.
    if provider_id.contains(',') {
        return Err(format!(
            "a next-stage provider override names one provider, not a list ('{provider_id}'):              a model and effort belong to a single provider"
        ));
    }
    let parsed = AgentProvider::from_str(provider_id).map_err(|_| {
        format!(
            "unsupported agent provider '{provider_id}' (supported: {})",
            AgentProvider::ALL
                .iter()
                .map(|provider| provider.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    validate_provider_model(parsed, model)?;
    validate_provider_effort(parsed, effort)?;
    let source = match source {
        Some(source) => crate::db::ProviderOverrideSource::from_caller_declared(source)?,
        None => crate::db::ProviderOverrideSource::Unspecified,
    };
    Ok(Some(crate::db::StageProviderOverride {
        source: source.as_str().to_string(),
        provider: parsed.as_str().to_string(),
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }))
}

pub(super) fn resolve_agent_provider(
    explicit_provider: Option<&str>,
    stage_provider: Option<&[String]>,
    repo_provider: Option<&[String]>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
    search_path: Option<&str>,
    workspace_root: &str,
) -> Result<AgentProvider, String> {
    let candidates = resolve_agent_provider_candidates(
        explicit_provider,
        stage_provider,
        repo_provider,
        agent,
        fallback_provider,
    )
    .map_err(|error| error.to_string())?;
    candidates
        .iter()
        .copied()
        .find(|provider| {
            super::environment::resolve_provider_executable(*provider, search_path, workspace_root)
                .is_ok()
        })
        .ok_or_else(|| unavailable_provider_error(&candidates))
}

pub(super) fn resolve_agent_provider_candidates(
    explicit_provider: Option<&str>,
    stage_provider: Option<&[String]>,
    repo_provider: Option<&[String]>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
) -> Result<Vec<AgentProvider>, ResolveProviderCandidatesError> {
    // Workflow stage/post entries are compact provider selectors
    // (`provider[-model[-effort]]`); every other layer names plain provider
    // ids. Both syntaxes resolve to the provider here — a selector's model
    // and effort enter through the tuning plan (`stage_tuning_layers`), not
    // through candidate resolution.
    let (raw_candidates, selector_syntax) =
        if let Some(source) = explicit_provider.filter(|value| !value.trim().is_empty()) {
            (
                source
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
                false,
            )
        } else if let Some(providers) = stage_provider.filter(|providers| !providers.is_empty()) {
            (providers.to_vec(), true)
        } else if let Some(providers) = repo_provider.filter(|providers| !providers.is_empty()) {
            (providers.to_vec(), false)
        } else if let Some(agent) = agent.filter(|agent| !agent.agent_providers.is_empty()) {
            (agent.agent_providers.clone(), false)
        } else if let Some(source) = fallback_provider.filter(|value| !value.trim().is_empty()) {
            (
                source
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
                false,
            )
        } else {
            (Vec::new(), false)
        };

    if raw_candidates.is_empty() {
        return Err(ResolveProviderCandidatesError::NotConfigured);
    }

    raw_candidates
        .iter()
        .map(|candidate| {
            if selector_syntax {
                kanna_agent_protocol::parse_provider_selector(candidate)
                    .map(|selector| selector.provider)
                    .map_err(|_| ResolveProviderCandidatesError::Unsupported(candidate.clone()))
            } else {
                AgentProvider::from_str(candidate)
                    .map_err(|_| ResolveProviderCandidatesError::Unsupported(candidate.clone()))
            }
        })
        .collect::<Result<Vec<_>, _>>()
}

/// The tuning layers a workflow stage's compact provider selectors
/// contribute — one layer per selector that names a model or an effort, each
/// bound to exactly that selector's provider. This is what lets an ordered
/// fallback list like `["claude-fable-hi", "codex-astra-lo"]` give every
/// candidate its own coherent pair: whichever provider availability lands on
/// draws the values written beside it, and a selector with neither model nor
/// effort contributes nothing (the CLI's own defaults apply).
pub(super) fn stage_tuning_layers(stage_provider: Option<&[String]>) -> Vec<AgentTuningLayer> {
    stage_provider
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| kanna_agent_protocol::parse_provider_selector(entry).ok())
        .filter(|selector| selector.model.is_some() || selector.effort.is_some())
        .map(|selector| AgentTuningLayer {
            providers: vec![selector.provider.as_str().to_string()],
            model: selector.model,
            effort: selector.effort,
        })
        .collect()
}

fn unavailable_provider_error(candidates: &[AgentProvider]) -> String {
    format!(
        "None of the configured agent providers are available: {}.",
        candidates
            .iter()
            .map(|provider| provider.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(test)]
pub(super) fn resolve_agent_provider_with(
    explicit_provider: Option<&str>,
    stage_provider: Option<&[String]>,
    repo_provider: Option<&[String]>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
    is_available: impl Fn(AgentProvider) -> bool,
) -> Result<AgentProvider, String> {
    let candidates = resolve_agent_provider_candidates(
        explicit_provider,
        stage_provider,
        repo_provider,
        agent,
        fallback_provider,
    )
    .map_err(|error| error.to_string())?;
    candidates
        .iter()
        .copied()
        .find(|provider| is_available(*provider))
        .ok_or_else(|| unavailable_provider_error(&candidates))
}

/// One layer of the model/effort chain together with the provider selection
/// it was written beside. An empty `providers` list is provider-agnostic —
/// the caller named a value without naming a provider, so it applies to
/// whichever provider resolution lands on.
#[derive(Clone, Debug, Default)]
pub(super) struct AgentTuningLayer {
    pub(super) providers: Vec<String>,
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
}

/// The model and effort a spawn may draw from, left unresolved until the
/// provider is finally chosen.
///
/// Model and effort values belong to the provider they were written for:
/// `codex -m opus` is rejected outright by the Codex CLI, and no two provider
/// CLIs share an effort vocabulary. Resolution therefore must not compose a
/// model from one layer onto a provider chosen by a higher-precedence layer.
/// This walks the same ordered chain as provider resolution and takes the
/// first layer that both names a value *and* would itself have selected the
/// resolved provider; layers written for some other provider are skipped, and
/// the pair falls back to that provider's own stamped or default model.
///
/// The alternative — composing across layers — is what let a machine-local
/// `.kanna/config.local.json` entry pointing an agent at
/// `{"provider": "claude", "model": "opus"}` poison the respawn of a task
/// already stamped `codex` (2026-08-17): the stamp won provider selection,
/// the local entry still supplied the model, and every respawn died on
/// `The 'opus' model is not supported when using Codex with a ChatGPT
/// account.`
///
/// **A layer's model and effort belong to its first-named provider only.** A
/// layer may name an ordered candidate list (`{"provider": ["codex",
/// "claude"], "model": "gpt-5"}` — the shape `config.schema.json` itself
/// gives as an example), and a list carries no way to say which candidate a
/// single model id was written for. The leading entry is the one the author
/// preferred and wrote the model beside; the rest are outage fallbacks, and
/// they run on their own stamped or default model. Applying the value to
/// every candidate reintroduces exactly this bug the moment the leading
/// provider is unavailable — which is the case the escape hatch exists for.
#[derive(Clone, Debug, Default)]
pub(super) struct AgentTuningPlan {
    layers: Vec<AgentTuningLayer>,
}

impl AgentTuningPlan {
    pub(super) fn new(layers: Vec<AgentTuningLayer>) -> Self {
        Self { layers }
    }

    pub(super) fn model_for(&self, provider: AgentProvider) -> Option<String> {
        self.layers_for(provider)
            .find_map(|layer| layer.model.clone())
    }

    pub(super) fn effort_for(&self, provider: AgentProvider) -> Option<String> {
        self.layers_for(provider)
            .find_map(|layer| layer.effort.clone())
    }

    fn layers_for(
        &self,
        provider: AgentProvider,
    ) -> impl Iterator<Item = &AgentTuningLayer> + use<'_> {
        self.layers
            .iter()
            .filter(move |layer| layer_selects_provider(&layer.providers, provider))
    }
}

/// Whether a layer's model/effort was written for `provider`: true when the
/// layer names no provider at all (the caller gave a bare value, so it
/// applies to whatever resolution lands on), and otherwise only for the
/// layer's *first* named provider. Entries are the same shape provider
/// resolution accepts, including the legacy comma-separated form an explicit
/// override may still use.
fn layer_selects_provider(providers: &[String], provider: AgentProvider) -> bool {
    let mut named = providers
        .iter()
        .flat_map(|entry| entry.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty());
    match named.next() {
        None => true,
        Some(preferred) => preferred == provider.as_str(),
    }
}
