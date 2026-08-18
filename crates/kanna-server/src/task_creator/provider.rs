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

pub(super) fn validate_provider_model(
    provider: AgentProvider,
    model: Option<&str>,
) -> Result<(), String> {
    validate_model_shape(model)?;
    if model.is_some() && provider.model_override_flag().is_none() {
        return Err(format!(
            "model overrides are not supported for agent provider '{provider}'"
        ));
    }
    Ok(())
}

pub(super) fn validate_provider_effort(
    provider: AgentProvider,
    effort: Option<&str>,
) -> Result<(), String> {
    validate_effort_shape(effort)?;
    let Some(effort) = effort else {
        return Ok(());
    };
    let Some(values) = provider.effort_values() else {
        return Ok(());
    };
    if values.contains(&effort) {
        Ok(())
    } else {
        Err(format!(
            "effort '{effort}' is not supported for agent provider '{provider}' (supported: {})",
            values.join(", ")
        ))
    }
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
    let raw_candidates =
        if let Some(source) = explicit_provider.filter(|value| !value.trim().is_empty()) {
            source
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        } else if let Some(providers) = stage_provider.filter(|providers| !providers.is_empty()) {
            providers.to_vec()
        } else if let Some(providers) = repo_provider.filter(|providers| !providers.is_empty()) {
            providers.to_vec()
        } else if let Some(agent) = agent.filter(|agent| !agent.agent_providers.is_empty()) {
            agent.agent_providers.clone()
        } else if let Some(source) = fallback_provider.filter(|value| !value.trim().is_empty()) {
            source
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

    if raw_candidates.is_empty() {
        return Err(ResolveProviderCandidatesError::NotConfigured);
    }

    raw_candidates
        .iter()
        .map(|candidate| {
            AgentProvider::from_str(candidate)
                .map_err(|_| ResolveProviderCandidatesError::Unsupported(candidate.clone()))
        })
        .collect::<Result<Vec<_>, _>>()
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

/// Whether a layer's own provider selection would have produced `provider`.
/// Entries are the same shape provider resolution accepts, including the
/// legacy comma-separated form an explicit override may still use.
fn layer_selects_provider(providers: &[String], provider: AgentProvider) -> bool {
    let mut named = providers
        .iter()
        .flat_map(|entry| entry.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .peekable();
    if named.peek().is_none() {
        return true;
    }
    named.any(|entry| entry == provider.as_str())
}
