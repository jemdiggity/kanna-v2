use kanna_agent_protocol::{agent_provider_specs, AgentProvider, AgentSessionType, EffortOverride};
use std::str::FromStr;

#[test]
fn registry_covers_every_provider_once() {
    let specs = agent_provider_specs();
    assert_eq!(specs.len(), AgentProvider::ALL.len());
    for provider in AgentProvider::ALL {
        assert_eq!(specs.iter().filter(|spec| spec.id == provider).count(), 1);
    }
}

#[test]
fn provider_metadata_matches_runtime_contracts() {
    assert_eq!(AgentProvider::Antigravity.executable(), "agy");
    for provider in AgentProvider::ALL {
        assert_eq!(provider.default_session_type(), AgentSessionType::Pty);
    }
    assert!(AgentProvider::Claude.supports_headless());
    assert!(AgentProvider::Codex.supports_headless());
    assert!(AgentProvider::Opencode.supports_headless());
    assert!(!AgentProvider::Copilot.supports_headless());
    assert!(!AgentProvider::Antigravity.supports_headless());
}

#[test]
fn provider_model_override_flags_are_explicit() {
    assert_eq!(AgentProvider::Claude.model_override_flag(), Some("--model"));
    assert_eq!(
        AgentProvider::Copilot.model_override_flag(),
        Some("--model")
    );
    assert_eq!(AgentProvider::Codex.model_override_flag(), Some("-m"));
    assert_eq!(AgentProvider::Opencode.model_override_flag(), Some("-m"));
    assert_eq!(AgentProvider::Antigravity.model_override_flag(), None);
}

#[test]
fn provider_effort_controls_and_native_values_are_explicit() {
    assert_eq!(
        AgentProvider::Codex.effort_override(),
        EffortOverride::Config("model_reasoning_effort")
    );
    assert_eq!(
        AgentProvider::Claude.effort_override(),
        EffortOverride::Flag("--effort")
    );
    assert_eq!(
        AgentProvider::Copilot.effort_override(),
        EffortOverride::Flag("--effort")
    );
    assert_eq!(
        AgentProvider::Opencode.effort_override(),
        EffortOverride::Flag("--variant")
    );
    assert_eq!(
        AgentProvider::Antigravity.effort_override(),
        EffortOverride::Flag("--effort")
    );
    assert_eq!(
        AgentProvider::Codex.effort_values(),
        Some(&["minimal", "low", "medium", "high", "xhigh"][..])
    );
    assert_eq!(
        AgentProvider::Claude.effort_values(),
        Some(&["low", "medium", "high", "xhigh", "max"][..])
    );
    assert_eq!(
        AgentProvider::Copilot.effort_values(),
        Some(&["none", "minimal", "low", "medium", "high", "xhigh", "max"][..])
    );
    assert_eq!(AgentProvider::Opencode.effort_values(), None);
    assert_eq!(
        AgentProvider::Antigravity.effort_values(),
        Some(&["low", "medium", "high"][..])
    );
}

#[test]
fn provider_strings_round_trip() {
    for provider in AgentProvider::ALL {
        assert_eq!(
            AgentProvider::from_str(provider.as_str()).unwrap(),
            provider
        );
        assert_eq!(
            serde_json::from_str::<AgentProvider>(&serde_json::to_string(&provider).unwrap())
                .unwrap(),
            provider
        );
    }
    assert!(AgentProvider::from_str("future-agent").is_err());
}
