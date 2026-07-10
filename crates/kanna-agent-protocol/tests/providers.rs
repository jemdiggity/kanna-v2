use kanna_agent_protocol::{agent_provider_specs, AgentProvider, AgentSessionType};
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
    assert_eq!(
        AgentProvider::Copilot.default_session_type(),
        AgentSessionType::Pty
    );
    assert_eq!(
        AgentProvider::Opencode.default_session_type(),
        AgentSessionType::Agent
    );
    assert!(AgentProvider::Claude.supports_headless());
    assert!(AgentProvider::Codex.supports_headless());
    assert!(AgentProvider::Opencode.supports_headless());
    assert!(!AgentProvider::Copilot.supports_headless());
    assert!(!AgentProvider::Antigravity.supports_headless());
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
