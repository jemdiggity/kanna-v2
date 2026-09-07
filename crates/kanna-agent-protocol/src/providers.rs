use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[cfg(feature = "typescript")]
use ts_rs::TS;

pub const PROVIDER_RESOLUTION_CASES_JSON: &str = include_str!("provider_resolution_cases.json");

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortOverride {
    Flag(&'static str),
    Config(&'static str),
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
        AgentSessionType::Pty
    }

    pub const fn supports_headless(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Opencode)
    }

    /// Stable CLI flag used for an initial model override. The value itself is
    /// intentionally not validated here: provider CLIs own their model
    /// catalogs, so newly released model ids work without a Kanna update.
    pub const fn model_override_flag(self) -> Option<&'static str> {
        match self {
            Self::Claude | Self::Copilot => Some("--model"),
            Self::Codex | Self::Opencode => Some("-m"),
            // No supported `agy` model-selection flag has been established.
            Self::Antigravity => None,
        }
    }

    /// Native CLI control used for an initial reasoning-effort override.
    /// Values are not normalized across providers: Codex reasoning efforts
    /// and OpenCode variants are model-specific, while the other CLIs publish
    /// different fixed vocabularies.
    pub const fn effort_override(self) -> EffortOverride {
        match self {
            Self::Codex => EffortOverride::Config("model_reasoning_effort"),
            Self::Opencode => EffortOverride::Flag("--variant"),
            Self::Claude | Self::Copilot | Self::Antigravity => EffortOverride::Flag("--effort"),
        }
    }

    /// Provider-native effort values when the CLI publishes a fixed set.
    /// `None` means the legal values depend on the selected provider/model
    /// and must be passed through for the CLI to validate.
    pub const fn effort_values(self) -> Option<&'static [&'static str]> {
        match self {
            Self::Codex | Self::Opencode => None,
            Self::Claude => Some(&["low", "medium", "high", "xhigh", "max"]),
            Self::Copilot => Some(&["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
            Self::Antigravity => Some(&["low", "medium", "high"]),
        }
    }

    /// The composer command that ends an interactive session cleanly.
    ///
    /// Transfer finalization types this into the live TUI instead of signalling
    /// the process: the daemon refuses signals for adopted sessions by design
    /// (it holds the master fd but never forked the child, so the pid cannot be
    /// pinned across `kill(2)`), which made every session older than the
    /// running daemon unfinalizable. Injected bytes have no such constraint.
    ///
    /// A clean quit is what makes the shipped conversation complete: Claude
    /// flushes its transcript, and Codex stops appending to the rollout the
    /// transfer is about to stage.
    ///
    /// Verified against the installed CLIs rather than assumed: Codex is pinned
    /// by `tests/cli-contract/tests/live/codex-tui-quit.test.ts`, OpenCode by
    /// `opencode-injected-input.test.ts`, Copilot by `copilot-tui-quit.test.ts`.
    /// Claude and Antigravity are manually verified — see
    /// `docs/2026-08-06-agent-tui-injection-e2e-gap.md`.
    pub const fn quit_command(self) -> &'static str {
        match self {
            // Codex is the odd one out: its composer popup names the command
            // `/quit  exit Codex`, and `/exit` is not offered.
            Self::Codex => "/quit",
            Self::Claude | Self::Copilot | Self::Opencode | Self::Antigravity => "/exit",
        }
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

/// A compact provider selector: `provider[-model[-effort]]`.
///
/// Workflow definitions name provider candidates with an optional model and
/// reasoning effort folded into one token — `claude`, `codex-sol`,
/// `claude-fable-hi`, `codex-astra-lo` — so each candidate in an ordered
/// fallback list carries its own coherent pair instead of the list's leading
/// candidate owning the only model. Anything not specified is left to the
/// provider CLI's own defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSelector {
    pub provider: AgentProvider,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Effort tokens a selector's trailing segment may use, mapped to the
/// canonical spelling the provider CLIs take. Only these tokens read as an
/// effort suffix; any other trailing segment is part of the model string.
const EFFORT_ALIASES: [(&str, &str); 9] = [
    ("lo", "low"),
    ("low", "low"),
    ("med", "medium"),
    ("medium", "medium"),
    ("hi", "high"),
    ("high", "high"),
    ("xhi", "xhigh"),
    ("xhigh", "xhigh"),
    ("max", "max"),
];

fn effort_alias(segment: &str) -> Option<&'static str> {
    EFFORT_ALIASES
        .iter()
        .find(|(alias, _)| *alias == segment)
        .map(|(_, canonical)| *canonical)
}

/// Parse a compact provider selector.
///
/// The first `-`-separated segment must be a provider id. If the last segment
/// is a recognized effort token (`lo`/`low`, `med`/`medium`, `hi`/`high`,
/// `xhi`/`xhigh`, `max` — normalized to the canonical spelling), it is the
/// effort; everything between provider and effort is the model, passed to the
/// CLI verbatim (so multi-segment model ids like `gpt-5-codex` survive — a
/// trailing segment that is not an effort token stays part of the model).
/// A plain provider id parses with no model and no effort.
///
/// The pair is validated against the provider at parse time: a model is
/// rejected for a provider with no model flag, and an effort is checked
/// against the provider's published vocabulary when one exists.
pub fn parse_provider_selector(value: &str) -> Result<ProviderSelector, String> {
    let value = value.trim();
    let syntax_error = |detail: &str| {
        format!(
            "invalid agent provider selector '{value}': {detail} \
             (expected provider[-model[-effort]], e.g. codex, claude-fable, codex-astra-lo)"
        )
    };
    if value.is_empty() {
        return Err(syntax_error("selector is empty"));
    }
    let (head, rest) = match value.split_once('-') {
        None => (value, None),
        Some((head, rest)) => (head, Some(rest)),
    };
    let provider = AgentProvider::from_str(head).map_err(|_| {
        format!(
            "unsupported agent provider '{head}' in selector '{value}' (supported: {})",
            AgentProvider::ALL
                .iter()
                .map(|provider| provider.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    let Some(rest) = rest else {
        return Ok(ProviderSelector {
            provider,
            model: None,
            effort: None,
        });
    };
    let segments = rest.split('-').collect::<Vec<_>>();
    if segments.iter().any(|segment| segment.is_empty()) {
        return Err(syntax_error("empty segment"));
    }
    let (model_segments, effort) = match segments.split_last() {
        Some((last, init)) if effort_alias(last).is_some() => (init, effort_alias(last)),
        _ => (segments.as_slice(), None),
    };
    let model = if model_segments.is_empty() {
        None
    } else {
        Some(model_segments.join("-"))
    };
    if model.is_some() && provider.model_override_flag().is_none() {
        return Err(format!(
            "invalid agent provider selector '{value}': \
             model overrides are not supported for agent provider '{provider}'"
        ));
    }
    if let (Some(effort), Some(values)) = (effort, provider.effort_values()) {
        if !values.contains(&effort) {
            return Err(format!(
                "invalid agent provider selector '{value}': effort '{effort}' is not supported \
                 for agent provider '{provider}' (supported: {})",
                values.join(", ")
            ));
        }
    }
    Ok(ProviderSelector {
        provider,
        model,
        effort: effort.map(str::to_string),
    })
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

#[cfg(test)]
mod selector_tests {
    use super::*;

    fn selector(value: &str) -> ProviderSelector {
        parse_provider_selector(value).unwrap()
    }

    #[test]
    fn plain_provider_ids_parse_with_no_model_or_effort() {
        for provider in AgentProvider::ALL {
            assert_eq!(
                selector(provider.as_str()),
                ProviderSelector {
                    provider,
                    model: None,
                    effort: None,
                }
            );
        }
    }

    #[test]
    fn provider_model_and_effort_split_on_the_trailing_effort_token() {
        assert_eq!(
            selector("claude-fable-hi"),
            ProviderSelector {
                provider: AgentProvider::Claude,
                model: Some("fable".to_string()),
                effort: Some("high".to_string()),
            }
        );
        assert_eq!(
            selector("codex-astra-lo"),
            ProviderSelector {
                provider: AgentProvider::Codex,
                model: Some("astra".to_string()),
                effort: Some("low".to_string()),
            }
        );
    }

    #[test]
    fn a_trailing_segment_that_is_not_an_effort_token_stays_in_the_model() {
        assert_eq!(
            selector("codex-gpt-5-codex"),
            ProviderSelector {
                provider: AgentProvider::Codex,
                model: Some("gpt-5-codex".to_string()),
                effort: None,
            }
        );
    }

    #[test]
    fn an_effort_only_selector_leaves_the_model_to_the_cli() {
        assert_eq!(
            selector("claude-hi"),
            ProviderSelector {
                provider: AgentProvider::Claude,
                model: None,
                effort: Some("high".to_string()),
            }
        );
        assert_eq!(
            selector("codex-med"),
            ProviderSelector {
                provider: AgentProvider::Codex,
                model: None,
                effort: Some("medium".to_string()),
            }
        );
    }

    #[test]
    fn effort_aliases_normalize_to_the_canonical_spelling() {
        assert_eq!(selector("claude-xhi").effort.as_deref(), Some("xhigh"));
        assert_eq!(selector("claude-max").effort.as_deref(), Some("max"));
        assert_eq!(selector("opencode-low").effort.as_deref(), Some("low"));
    }

    #[test]
    fn a_model_is_rejected_for_a_provider_without_a_model_flag() {
        let error = parse_provider_selector("antigravity-gemini").unwrap_err();
        assert!(
            error.contains("model overrides are not supported"),
            "unexpected error: {error}"
        );
        // Effort alone stays valid for the same provider.
        assert_eq!(selector("antigravity-hi").effort.as_deref(), Some("high"));
    }

    #[test]
    fn an_effort_outside_the_provider_vocabulary_is_rejected() {
        // `max` reads as an effort token, and Antigravity's vocabulary
        // excludes it.
        let error = parse_provider_selector("antigravity-max").unwrap_err();
        assert!(
            error.contains("effort 'max' is not supported"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn unknown_providers_and_empty_segments_are_rejected() {
        assert!(parse_provider_selector("clod-fable").is_err());
        assert!(parse_provider_selector("").is_err());
        assert!(parse_provider_selector("claude-").is_err());
        assert!(parse_provider_selector("claude--hi").is_err());
        // A comma-separated list is a list, never one selector.
        assert!(parse_provider_selector("claude,codex").is_err());
    }
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

    /// Transfer finalization types this command into a live TUI and then waits
    /// for the process to exit. A provider whose command is wrong (or missing)
    /// leaves finalization waiting out its whole quit budget before degrading,
    /// so every provider Kanna can spawn has to answer.
    #[test]
    fn every_provider_names_a_quit_command() {
        for provider in AgentProvider::ALL {
            let command = provider.quit_command();
            assert!(
                command.starts_with('/'),
                "{provider} quit command is not a composer command: {command}",
            );
        }
        assert_eq!(AgentProvider::Codex.quit_command(), "/quit");
        assert_eq!(AgentProvider::Claude.quit_command(), "/exit");
    }
}
