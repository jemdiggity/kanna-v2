use super::definitions::AgentDefinition;
pub(super) use kanna_agent_protocol::{AgentProvider, AgentSessionType};
use std::str::FromStr;

pub(super) fn resolve_agent_type(
    explicit_agent_type: Option<&str>,
    provider: AgentProvider,
) -> Result<AgentSessionType, String> {
    match normalize_agent_type(explicit_agent_type) {
        Some("pty") => Ok(AgentSessionType::Pty),
        Some("agent") => Ok(AgentSessionType::Agent),
        Some(other) => Err(format!("unsupported agent_type: {}", other)),
        None => Ok(provider.default_session_type()),
    }
}

pub(super) fn normalize_agent_type(agent_type: Option<&str>) -> Option<&str> {
    match agent_type {
        Some("sdk" | "chat") => Some("agent"),
        Some(value) => Some(value),
        None => None,
    }
}

pub(super) fn resolve_agent_provider(
    explicit_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
    search_path: Option<&str>,
    workspace_root: &str,
) -> Result<AgentProvider, String> {
    resolve_agent_provider_with(
        explicit_provider,
        stage_provider,
        agent,
        fallback_provider,
        |provider| {
            super::environment::resolve_provider_executable(provider, search_path, workspace_root)
                .is_ok()
        },
    )
}

pub(super) fn resolve_agent_provider_with(
    explicit_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
    fallback_provider: Option<&str>,
    is_available: impl Fn(AgentProvider) -> bool,
) -> Result<AgentProvider, String> {
    let string_source = explicit_provider
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stage_provider.filter(|value| !value.trim().is_empty()));

    let raw_candidates = if let Some(source) = string_source {
        source
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
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
        return Err("No agent provider configured for this request.".to_string());
    }

    let candidates = raw_candidates
        .iter()
        .map(|candidate| AgentProvider::from_str(candidate))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(provider) = candidates
        .iter()
        .copied()
        .find(|provider| is_available(*provider))
    {
        return Ok(provider);
    }

    Err(format!(
        "None of the configured agent providers are available: {}.",
        candidates
            .iter()
            .map(|provider| provider.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}
