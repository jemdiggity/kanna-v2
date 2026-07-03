use super::definitions::AgentDefinition;
use kanna_daemon::protocol::AgentProvider as DaemonAgentProvider;

#[derive(Clone, Copy)]
pub(super) enum AgentProvider {
    Claude,
    Copilot,
    Codex,
    Opencode,
    Antigravity,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AgentSessionType {
    Pty,
    Agent,
}

impl AgentSessionType {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Pty => "pty",
            Self::Agent => "agent",
        }
    }
}

impl AgentProvider {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Copilot => "copilot",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Antigravity => "antigravity",
        }
    }

    pub(super) fn to_daemon_provider(self) -> DaemonAgentProvider {
        match self {
            Self::Claude => DaemonAgentProvider::Claude,
            Self::Copilot => DaemonAgentProvider::Copilot,
            Self::Codex => DaemonAgentProvider::Codex,
            Self::Opencode => DaemonAgentProvider::Opencode,
            Self::Antigravity => DaemonAgentProvider::Antigravity,
        }
    }
}

pub(super) fn resolve_agent_type(
    explicit_agent_type: Option<&str>,
    provider: AgentProvider,
) -> Result<AgentSessionType, String> {
    match normalize_agent_type(explicit_agent_type) {
        Some("pty") => Ok(AgentSessionType::Pty),
        Some("agent") => Ok(AgentSessionType::Agent),
        Some(other) => Err(format!("unsupported agent_type: {}", other)),
        None => Ok(match provider {
            AgentProvider::Claude | AgentProvider::Codex | AgentProvider::Opencode => {
                AgentSessionType::Agent
            }
            AgentProvider::Copilot | AgentProvider::Antigravity => AgentSessionType::Pty,
        }),
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
    default_provider: Option<&str>,
    stage_provider: Option<&str>,
    agent: Option<&AgentDefinition>,
) -> Result<AgentProvider, String> {
    let mut candidates = Vec::new();
    if let Some(provider) = explicit_provider.or(default_provider).or(stage_provider) {
        candidates.extend(
            provider
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        );
    }
    if candidates.is_empty() {
        candidates.extend(
            agent
                .map(|agent| agent.agent_providers.clone())
                .unwrap_or_default(),
        );
    }

    let parsed = candidates
        .iter()
        .filter_map(|candidate| match candidate.as_str() {
            "claude" => Some(AgentProvider::Claude),
            "copilot" => Some(AgentProvider::Copilot),
            "codex" => Some(AgentProvider::Codex),
            "opencode" => Some(AgentProvider::Opencode),
            "antigravity" => Some(AgentProvider::Antigravity),
            _ => None,
        })
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        return Err("no agent provider configured for task creation".to_string());
    }

    for provider in &parsed {
        if binary_available(provider_binary_name(*provider)) {
            return Ok(*provider);
        }
    }

    Ok(parsed[0])
}

pub(super) fn provider_binary_name(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Antigravity => "agy",
        _ => provider.as_str(),
    }
}

fn binary_available(name: &str) -> bool {
    super::environment::binary_on_path(name)
}
