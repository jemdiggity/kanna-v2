use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[cfg(feature = "typescript")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum AgentProvider {
    Claude,
    Copilot,
    Codex,
    Opencode,
    Antigravity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum AgentSessionType {
    Pty,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct AgentProviderSpec {
    pub id: AgentProvider,
    pub executable: String,
    pub default_session_type: AgentSessionType,
    pub supports_headless: bool,
}

impl AgentProvider {
    pub const ALL: [Self; 5] = [
        Self::Claude,
        Self::Copilot,
        Self::Codex,
        Self::Opencode,
        Self::Antigravity,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Copilot => "copilot",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Antigravity => "antigravity",
        }
    }

    pub const fn executable(self) -> &'static str {
        match self {
            Self::Antigravity => "agy",
            _ => self.as_str(),
        }
    }

    pub const fn default_session_type(self) -> AgentSessionType {
        match self {
            Self::Claude | Self::Codex | Self::Opencode => AgentSessionType::Agent,
            Self::Copilot | Self::Antigravity => AgentSessionType::Pty,
        }
    }

    pub const fn supports_headless(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Opencode)
    }
}

impl AgentSessionType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pty => "pty",
            Self::Agent => "agent",
        }
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AgentProvider {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.as_str() == value)
            .ok_or_else(|| format!("unsupported agent provider: {value}"))
    }
}

pub fn agent_provider_specs() -> Vec<AgentProviderSpec> {
    AgentProvider::ALL
        .into_iter()
        .map(|provider| AgentProviderSpec {
            id: provider,
            executable: provider.executable().to_string(),
            default_session_type: provider.default_session_type(),
            supports_headless: provider.supports_headless(),
        })
        .collect()
}

#[cfg(all(test, feature = "typescript"))]
mod tests {
    use super::*;

    #[test]
    fn export_bindings_provider_registry() {
        let output_dir = match std::env::var("TS_RS_EXPORT_DIR") {
            Ok(output_dir) => output_dir,
            Err(std::env::VarError::NotPresent) => return,
            Err(error) => panic!("TS_RS_EXPORT_DIR must be valid Unicode: {error}"),
        };
        let specs_json = serde_json::to_string_pretty(&agent_provider_specs()).unwrap();
        let source = format!(
            r#"// Generated from crates/kanna-agent-protocol. Do not edit manually.
import type {{ AgentProvider }} from "./AgentProvider";
import type {{ AgentProviderSpec }} from "./AgentProviderSpec";

export const AGENT_PROVIDER_SPECS = {specs_json} as const satisfies readonly AgentProviderSpec[];
export const AGENT_PROVIDERS: readonly AgentProvider[] =
  AGENT_PROVIDER_SPECS.map(({{ id }}) => id);

export function isAgentProvider(value: unknown): value is AgentProvider {{
  return typeof value === "string"
    && AGENT_PROVIDERS.includes(value as AgentProvider);
}}

export function getAgentProviderSpec(provider: AgentProvider): Readonly<AgentProviderSpec> {{
  const spec = AGENT_PROVIDER_SPECS.find((candidate) => candidate.id === provider);
  if (!spec) throw new Error(`Unknown agent provider: ${{provider}}`);
  return spec;
}}
"#,
        );
        std::fs::write(
            std::path::Path::new(&output_dir).join("AgentProviderRegistry.ts"),
            source,
        )
        .unwrap();
    }
}
