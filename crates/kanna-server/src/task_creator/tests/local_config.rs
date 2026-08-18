//! Resolution of the machine-local `.kanna/config.local.json` layer: it must
//! reach a spawn from the working tree, beat the committed config, lose to an
//! explicit task override, and fail loudly rather than quietly when malformed.

use super::super::definitions::{AgentDefinition, DefinitionVisibility, RepoDefinitions};
use super::super::provider::resolve_agent_provider_with;
use super::*;
use crate::db::Repo;

/// A repo whose `origin/main` carries `committed_config` and whose working
/// tree carries nothing else. Nothing is ever committed after this point, so a
/// test that changes behavior afterwards proves it did so without a commit.
fn init_repo_with_committed_config(label: &str, committed_config: serde_json::Value) -> Repo {
    let repo_root = init_git_repo_without_provider_fixtures(label);
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        committed_config.to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish committed repo config");
    Repo {
        id: format!("repo-{label}"),
        path: repo_root.to_string_lossy().into_owned(),
        name: label.to_string(),
        default_branch: Some("main".to_string()),
        remote_url_hash: None,
        hidden: None,
        sort_order: None,
        created_at: None,
        last_opened_at: None,
    }
}

fn write_local_config(repo: &Repo, local_config: &str) {
    std::fs::write(
        std::path::Path::new(&repo.path).join(".kanna/config.local.json"),
        local_config,
    )
    .unwrap();
}

fn untracked_paths(repo: &Repo) -> String {
    run_git_fixture(
        std::path::Path::new(&repo.path),
        &["status", "--porcelain", "--untracked-files=all"],
    )
}

fn committed_provider_fixture() -> serde_json::Value {
    serde_json::json!({
        "workflow": "single-reviewer",
        "setup": ["COMMITTED_SETUP"],
        "ports": {"COMMITTED_PORT": 4100, "SHARED_PORT": 4200},
        "agentProviders": {
            "*": {"provider": ["codex", "claude"]},
            "review": {"provider": "codex", "model": "committed-model"}
        },
        "vars": {"OWNER": "committed"}
    })
}

fn review_agent() -> AgentDefinition {
    AgentDefinition {
        name: "review".to_string(),
        description: "Review".to_string(),
        prompt: String::new(),
        agent_providers: vec!["antigravity".to_string()],
        model: Some("agent-model".to_string()),
        effort: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        visibility: DefinitionVisibility::Public,
    }
}

#[test]
fn a_local_config_layers_over_the_committed_one_without_any_commit() {
    let repo = init_repo_with_committed_config("local-config-layers", committed_provider_fixture());
    let committed = RepoDefinitions::resolve(&repo).expect("resolve committed definitions");
    assert!(committed.config().local_override.is_none());

    write_local_config(
        &repo,
        &serde_json::json!({
            "$schema": "https://schemas.kanna.build/config.schema.json",
            "workflow": "no-review",
            "setup": ["LOCAL_SETUP"],
            "ports": {"SHARED_PORT": 4300},
            "agentProviders": {"*": {"provider": ["claude", "codex"]}}
        })
        .to_string(),
    );
    let local = RepoDefinitions::resolve(&repo).expect("resolve layered definitions");

    // Same origin snapshot, different effective config.
    assert_eq!(local.revision(), committed.revision());
    assert!(
        untracked_paths(&repo).contains(".kanna/config.local.json"),
        "the local layer must work while the file is still uncommitted",
    );

    let config = local.config();
    assert_eq!(config.workflow.as_deref(), Some("no-review"));
    // Arrays replace; they never concatenate.
    assert_eq!(
        config.setup.as_deref(),
        Some(["LOCAL_SETUP".to_string()].as_slice())
    );
    // Map entries merge by name: the named port moves, the unnamed one stays.
    let ports = config.ports.as_ref().expect("ports survive the merge");
    assert_eq!(ports.get("SHARED_PORT"), Some(&4300));
    assert_eq!(ports.get("COMMITTED_PORT"), Some(&4100));
    assert_eq!(
        config
            .agent_provider_preference(Some("implement"))
            .map(|preference| preference.providers.clone()),
        Some(vec!["claude".to_string(), "codex".to_string()]),
    );
    // An `agentProviders` entry the local file never names keeps its
    // committed value, wildcard reordering notwithstanding.
    let review = config
        .agent_provider_preference(Some("review"))
        .expect("committed review preference survives");
    assert_eq!(review.providers, vec!["codex".to_string()]);
    assert_eq!(review.model.as_deref(), Some("committed-model"));
    // Keys outside the local layer are untouched.
    assert_eq!(
        config.vars.as_ref().and_then(|vars| vars.get("OWNER")),
        Some(&"committed".to_string()),
    );

    let provenance = config
        .local_override
        .as_ref()
        .expect("a layered config reports its provenance");
    assert!(
        provenance.path().ends_with("/.kanna/config.local.json"),
        "{}",
        provenance.path()
    );
    assert_eq!(
        provenance.keys(),
        ["agentProviders", "ports", "setup", "workflow"]
    );

    let _ = std::fs::remove_dir_all(&repo.path);
}

#[test]
fn local_provider_preference_beats_the_repo_and_agent_but_loses_to_a_task_override() {
    let repo =
        init_repo_with_committed_config("local-config-precedence", committed_provider_fixture());
    write_local_config(
        &repo,
        &serde_json::json!({
            "agentProviders": {
                "review": {"provider": "opencode", "model": "local-model"}
            }
        })
        .to_string(),
    );
    let definitions = RepoDefinitions::resolve(&repo).expect("resolve layered definitions");
    let preference = definitions
        .config()
        .agent_provider_preference(Some("review"))
        .expect("local preference resolves for the review agent")
        .clone();
    let agent = review_agent();
    let stage_provider = ["copilot".to_string()];
    let available = |_| true;

    // Local config beats the committed config (codex) and the agent's own
    // frontmatter (antigravity) …
    assert_eq!(
        resolve_agent_provider_with(
            None,
            None,
            Some(&preference.providers),
            Some(&agent),
            Some("claude"),
            available,
        )
        .unwrap(),
        AgentProvider::Opencode,
    );
    assert_eq!(
        super::super::agent_tuning_plan(None, None, None, Some(&preference), Some(&agent))
            .model_for(AgentProvider::Opencode)
            .as_deref(),
        Some("local-model"),
    );

    // … and loses to an explicit task override and to a workflow stage's
    // pinned provider, which the local layer deliberately does not displace.
    assert_eq!(
        resolve_agent_provider_with(
            Some("claude"),
            None,
            Some(&preference.providers),
            Some(&agent),
            None,
            available,
        )
        .unwrap(),
        AgentProvider::Claude,
    );
    assert_eq!(
        resolve_agent_provider_with(
            None,
            Some(&stage_provider),
            Some(&preference.providers),
            Some(&agent),
            None,
            available,
        )
        .unwrap(),
        AgentProvider::Copilot,
    );
    assert_eq!(
        super::super::agent_tuning_plan(
            Some("claude"),
            Some("explicit-model".to_string()),
            None,
            Some(&preference),
            Some(&agent),
        )
        .model_for(AgentProvider::Claude)
        .as_deref(),
        Some("explicit-model"),
    );
    // The local entry's model belongs to the provider it names, so a task
    // override onto another provider takes that provider's own default
    // rather than the local layer's claude/opencode model.
    assert_eq!(
        super::super::agent_tuning_plan(
            Some("claude"),
            None,
            None,
            Some(&preference),
            Some(&agent),
        )
        .model_for(AgentProvider::Claude),
        None,
    );

    let _ = std::fs::remove_dir_all(&repo.path);
}

#[test]
fn a_working_tree_config_json_stays_ignored_while_config_local_json_applies() {
    let repo =
        init_repo_with_committed_config("local-config-working-tree", committed_provider_fixture());
    // The committed config's own working-tree copy is still not a source of
    // definitions — only the file that exists to be local is.
    std::fs::write(
        std::path::Path::new(&repo.path).join(".kanna/config.json"),
        serde_json::json!({"workflow": "WORKING_TREE_WORKFLOW"}).to_string(),
    )
    .unwrap();
    write_local_config(
        &repo,
        &serde_json::json!({"workflow": "no-review"}).to_string(),
    );

    let definitions = RepoDefinitions::resolve(&repo).expect("resolve layered definitions");

    assert_eq!(definitions.config().workflow.as_deref(), Some("no-review"));
    // The working tree's committed-config edits neither win nor leak.
    assert_eq!(
        definitions.config().ports.as_ref().map(|ports| ports.len()),
        Some(2)
    );

    let _ = std::fs::remove_dir_all(&repo.path);
}

#[test]
fn a_malformed_local_config_fails_resolution_by_name_instead_of_falling_back() {
    let repo =
        init_repo_with_committed_config("local-config-malformed", committed_provider_fixture());

    for (local_config, expected) in [
        ("{\"workflow\":", "is not valid JSON"),
        (
            "{\"vars\": {\"OWNER\": \"local\"}}",
            "cannot override `vars` per machine",
        ),
        (
            "{\"agentProviders\": {\"review\": {\"model\": \"no-provider\"}}}",
            "entry `review` must be a provider name",
        ),
    ] {
        write_local_config(&repo, local_config);

        let error = RepoDefinitions::resolve(&repo)
            .err()
            .unwrap_or_else(|| panic!("{local_config} should fail resolution"));

        assert!(error.contains(".kanna/config.local.json"), "{error}");
        assert!(error.contains(expected), "{error}");
    }

    let _ = std::fs::remove_dir_all(&repo.path);
}

#[test]
fn a_layered_spawn_announces_the_local_file_before_running_setup() {
    let repo = init_repo_with_committed_config("local-config-banner", committed_provider_fixture());
    write_local_config(
        &repo,
        &serde_json::json!({"setup": ["printf LOCAL_SETUP_RAN"]}).to_string(),
    );
    let definitions = RepoDefinitions::resolve(&repo).expect("resolve layered definitions");
    let config = definitions.config();
    let local_override = config
        .local_override
        .as_ref()
        .expect("a layered config reports its provenance");

    let command = super::super::build_task_shell_command(
        "run-agent",
        config.setup.as_deref().unwrap_or_default(),
        None,
        Some(local_override),
        None,
        None,
    );

    assert!(
        command.contains("Machine-local repo config in effect"),
        "{command}"
    );
    assert!(command.contains(local_override.path()), "{command}");
    assert!(command.contains("overrides: setup"), "{command}");
    let banner_index = command
        .find("Machine-local repo config in effect")
        .expect("banner is present");
    let setup_index = command.find("Running startup...").expect("setup runs");
    assert!(banner_index < setup_index, "{command}");

    let _ = std::fs::remove_dir_all(&repo.path);
}
