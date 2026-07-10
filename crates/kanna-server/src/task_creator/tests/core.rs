use super::super::definitions::AgentDefinition;
use super::super::provider::resolve_agent_provider_with;
use super::*;

#[derive(serde::Deserialize)]
struct ProviderResolutionCase {
    name: String,
    #[serde(default)]
    explicit: Vec<String>,
    #[serde(default)]
    stage: Vec<String>,
    #[serde(default)]
    agent: Vec<String>,
    #[serde(default)]
    fallback: Vec<String>,
    #[serde(default)]
    available: Vec<String>,
    expected: Option<String>,
    error: Option<String>,
}

fn joined(values: &[String]) -> Option<String> {
    (!values.is_empty()).then(|| values.join(","))
}

#[test]
fn provider_resolution_cases_match_shared_contract() {
    let cases: Vec<ProviderResolutionCase> =
        serde_json::from_str(kanna_agent_protocol::PROVIDER_RESOLUTION_CASES_JSON).unwrap();

    for case in cases {
        let agent = (!case.agent.is_empty()).then(|| AgentDefinition {
            prompt: String::new(),
            agent_providers: case.agent.clone(),
            model: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
        });
        let available = case.available.clone();
        let result = resolve_agent_provider_with(
            joined(&case.explicit).as_deref(),
            joined(&case.stage).as_deref(),
            agent.as_ref(),
            joined(&case.fallback).as_deref(),
            |provider| available.iter().any(|value| value == provider.as_str()),
        );

        match (case.expected, case.error) {
            (Some(expected), None) => {
                assert_eq!(result.unwrap().as_str(), expected, "{}", case.name)
            }
            (None, Some(error)) => assert_eq!(result.unwrap_err(), error, "{}", case.name),
            _ => panic!("invalid provider fixture: {}", case.name),
        }
    }
}

#[test]
fn provider_resolution_rejects_unknown_values() {
    assert_eq!(
        resolve_agent_provider_with(Some("future-agent"), None, None, None, |_| true).unwrap_err(),
        "unsupported agent provider: future-agent",
    );
}

#[test]
fn claim_task_ports_skips_reserved_ports_and_offsets() {
    let config = test_config("reserved-port-claim");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Use reserved ports",
        Some("Reserved ports"),
        "in progress",
        "2026-04-18 10:00:00",
    )
    .unwrap();
    let repo_config = super::super::definitions::RepoConfig {
        ports: Some(HashMap::from([
            ("KANNA_DEV_PORT".to_string(), 1420),
            ("API_PORT".to_string(), 3000),
        ])),
        reserved_ports: vec![1421],
        reserved_port_offsets: vec![1],
        ..Default::default()
    };

    let port_env =
        super::super::environment::claim_task_ports(&db, "task-1", &repo_config).unwrap();

    assert_eq!(
        port_env,
        HashMap::from([
            ("KANNA_DEV_PORT".to_string(), "1422".to_string()),
            ("API_PORT".to_string(), "3002".to_string()),
        ])
    );
}

fn write_agent_repo(label: &str, agent_md: &str, extend_md: Option<&str>) -> std::path::PathBuf {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-agent-def-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/reviewer");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(agent_dir.join("AGENT.md"), agent_md).unwrap();
    if let Some(extend_md) = extend_md {
        std::fs::write(agent_dir.join("EXTEND.md"), extend_md).unwrap();
    }
    repo_root
}

#[test]
fn read_agent_definition_without_extension_keeps_base() {
    let repo_root = write_agent_repo(
        "no-extend",
        "---\nagent_provider: claude\nmodel: sonnet\n---\nBase prompt.",
        None,
    );

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "reviewer")
            .unwrap();
    assert_eq!(definition.prompt, "Base prompt.");
    assert_eq!(definition.model.as_deref(), Some("sonnet"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_appends_extension_body_and_overrides_frontmatter() {
    let repo_root = write_agent_repo(
        "extend-override",
        "---\nagent_provider: claude\nmodel: sonnet\npermission_mode: default\n---\nBase prompt.",
        Some("---\nmodel: opus\npermission_mode: acceptEdits\nagent_provider: codex\n---\nRun the full suite."),
    );

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "reviewer")
            .unwrap();
    assert_eq!(definition.prompt, "Base prompt.\n\nRun the full suite.");
    assert_eq!(definition.model.as_deref(), Some("opus"));
    assert_eq!(definition.permission_mode.as_deref(), Some("acceptEdits"));
    assert_eq!(definition.agent_providers, vec!["codex".to_string()]);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_extension_empty_allowed_tools_clears_base_allowed_tools() {
    let repo_root = write_agent_repo(
        "extend-clear-allowed-tools",
        "---\nagent_provider: claude\nallowed_tools:\n  - Bash\n  - Read\n---\nBase prompt.",
        Some("---\nallowed_tools: []\n---\nRun without tool restrictions."),
    );

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "reviewer")
            .unwrap();
    assert_eq!(
        definition.prompt,
        "Base prompt.\n\nRun without tool restrictions."
    );
    assert!(definition.allowed_tools.is_empty());

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_extension_without_frontmatter_extends_prompt_only() {
    let repo_root = write_agent_repo(
        "extend-plain",
        "---\nagent_provider: claude\nmodel: sonnet\n---\nBase prompt.",
        Some("Repo-specific extra instructions."),
    );

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "reviewer")
            .unwrap();
    assert_eq!(
        definition.prompt,
        "Base prompt.\n\nRepo-specific extra instructions."
    );
    assert_eq!(definition.model.as_deref(), Some("sonnet"));
    assert_eq!(definition.agent_providers, vec!["claude".to_string()]);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_extension_applies_to_builtin_fallback() {
    // No repo AGENT.md: the base resolves to the compiled builtin and the
    // repo's EXTEND.md still layers on top of it.
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-builtin-extend-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/review");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "Repo rule: run the full unit and integration suites.",
    )
    .unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "review")
            .unwrap();
    assert!(definition.prompt.contains("QA review agent"));
    assert!(definition
        .prompt
        .ends_with("Repo rule: run the full unit and integration suites."));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn builtin_merge_agent_accepts_natural_language_open_pr_requests() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-builtin-merge-natural-language-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "merge")
            .unwrap();

    assert!(definition
        .prompt
        .contains("Natural-language merge requests"));
    assert!(definition.prompt.contains("merge all open"));
    assert!(definition.prompt.contains("gh pr list"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_loads_builtin_setup_agent() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-builtin-setup-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "setup")
            .unwrap();

    assert!(definition.prompt.contains("GitHub flow"));
    assert!(definition
        .prompt
        .contains("Do not author new agents from scratch"));
    assert!(definition.prompt.contains("kanna_complete_stage"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_uses_explicit_builtin_flavor() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-explicit-flavor-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();

    let definition = super::super::definitions::read_agent_definition(
        &repo_root.to_string_lossy(),
        "pr@push-only",
    )
    .unwrap();

    assert!(definition
        .prompt
        .contains("push the branch without creating a PR"));
    assert!(!definition.prompt.contains("gh pr create"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_uses_repo_config_flavor_map() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-config-flavor-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"merge":"git"}}"#,
    )
    .unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "merge")
            .unwrap();

    assert!(definition.prompt.contains("Git-only merge master"));
    assert!(!definition.prompt.contains("gh pr merge"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_prefers_repo_override_over_config_flavor() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-repo-over-config-flavor-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"pr":"push-only"}}"#,
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nagent_provider: claude\n---\nRepo-owned PR agent.",
    )
    .unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "pr")
            .unwrap();

    assert_eq!(definition.prompt, "Repo-owned PR agent.");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_prefers_repo_override_over_explicit_flavor() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-repo-over-explicit-flavor-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nagent_provider: claude\n---\nRepo-owned PR agent.",
    )
    .unwrap();

    let definition = super::super::definitions::read_agent_definition(
        &repo_root.to_string_lossy(),
        "pr@push-only",
    )
    .unwrap();

    assert_eq!(definition.prompt, "Repo-owned PR agent.");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_layers_role_extension_on_explicit_builtin_flavor() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-explicit-flavor-role-extend-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "Repo rule: publish only after local CI passes.",
    )
    .unwrap();

    let definition = super::super::definitions::read_agent_definition(
        &repo_root.to_string_lossy(),
        "pr@push-only",
    )
    .unwrap();

    assert!(definition
        .prompt
        .contains("push the branch without creating a PR"));
    assert!(definition
        .prompt
        .ends_with("Repo rule: publish only after local CI passes."));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_falls_back_to_builtin_default_for_missing_flavor() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-missing-config-flavor-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"pr":"missing-flavor"}}"#,
    )
    .unwrap();

    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "pr")
            .unwrap();

    assert!(definition.prompt.contains("create a GitHub pull request"));
    assert!(definition.prompt.contains("gh pr create"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_substitutes_repo_config_vars_in_agent_body() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-agent-def-config-vars-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    let agent_dir = repo_root.join(".kanna/agents/reviewer");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"vars":{"KANNA_TASK_ID":"config-task","MERGE_STRATEGY":"squash","REVIEW_TEAM":"platform"}}"#,
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nagent_provider: claude\n---\nUse $MERGE_STRATEGY for ${REVIEW_TEAM}. Keep $BASE_REF and $KANNA_TASK_ID runtime-bound.",
    )
    .unwrap();

    // The agent body is returned raw: config-var substitution happens in the
    // single build_stage_prompt pass, never at definition-read time.
    let definition =
        super::super::definitions::read_agent_definition(&repo_root.to_string_lossy(), "reviewer")
            .unwrap();

    assert_eq!(
        definition.prompt,
        "Use $MERGE_STRATEGY for ${REVIEW_TEAM}. Keep $BASE_REF and $KANNA_TASK_ID runtime-bound."
    );

    let vars: std::collections::HashMap<String, String> = [
        ("KANNA_TASK_ID", "config-task"),
        ("MERGE_STRATEGY", "squash"),
        ("REVIEW_TEAM", "platform"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let prompt = build_stage_prompt(
        &definition.prompt,
        None,
        &PromptContext {
            task_prompt: None,
            prev_result: None,
            branch: None,
            base_ref: Some("origin/main"),
            source_worktree: None,
            vars: Some(&vars),
        },
    );

    // Config vars substitute ($NAME and ${NAME} forms); reserved names bind
    // to runtime context ($BASE_REF) or stay literal for the session
    // environment ($KANNA_TASK_ID) — a config var can never shadow them.
    assert_eq!(
        prompt,
        "Use squash for platform. Keep origin/main and $KANNA_TASK_ID runtime-bound."
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn build_stage_prompt_does_not_reexpand_reserved_tokens_in_var_values() {
    let vars: std::collections::HashMap<String, String> = [(
        "NOTE".to_string(),
        "See $TASK_PROMPT for full context.".to_string(),
    )]
    .into_iter()
    .collect();
    let prompt = build_stage_prompt(
        "$NOTE\n\nTask: $TASK_PROMPT",
        None,
        &PromptContext {
            task_prompt: Some("actual task prompt"),
            prev_result: None,
            branch: None,
            base_ref: None,
            source_worktree: None,
            vars: Some(&vars),
        },
    );

    // The spliced var value is never rescanned: its $TASK_PROMPT stays
    // literal while the template's own $TASK_PROMPT binds normally.
    assert_eq!(
        prompt,
        "See $TASK_PROMPT for full context.\n\nTask: actual task prompt"
    );
}

#[test]
fn build_stage_prompt_leaves_unknown_vars_literal() {
    let prompt = build_stage_prompt(
        "Ping $UNKNOWN_NAME and ${ALSO_UNKNOWN}.",
        None,
        &PromptContext {
            task_prompt: None,
            prev_result: None,
            branch: None,
            base_ref: None,
            source_worktree: None,
            vars: None,
        },
    );

    assert_eq!(prompt, "Ping $UNKNOWN_NAME and ${ALSO_UNKNOWN}.");
}

#[test]
fn build_stage_prompt_replaces_base_ref() {
    let prompt = build_stage_prompt(
        "Review changes since $BASE_REF.",
        Some("Current branch $BRANCH."),
        &PromptContext {
            task_prompt: None,
            prev_result: None,
            branch: Some("task-source"),
            base_ref: Some("origin/main"),
            source_worktree: Some("/tmp/repo/.kanna-worktrees/task-source"),
            vars: None,
        },
    );

    assert_eq!(
        prompt,
        "Review changes since origin/main.\n\nCurrent branch task-source."
    );
}

#[test]
fn resolve_agent_type_normalizes_legacy_sdk_to_agent() {
    assert!(matches!(
        resolve_agent_type(Some("sdk"), AgentProvider::Claude),
        Ok(AgentSessionType::Agent)
    ));
}

#[test]
fn resolve_agent_type_normalizes_chat_to_agent() {
    assert!(matches!(
        resolve_agent_type(Some("chat"), AgentProvider::Claude),
        Ok(AgentSessionType::Agent)
    ));
}

#[test]
fn resolve_agent_type_defaults_opencode_to_agent_but_allows_explicit_pty() {
    assert!(matches!(
        resolve_agent_type(None, AgentProvider::Opencode),
        Ok(AgentSessionType::Agent)
    ));
    assert!(matches!(
        resolve_agent_type(Some("pty"), AgentProvider::Opencode),
        Ok(AgentSessionType::Pty)
    ));
}

#[test]
fn resolve_agent_type_defaults_antigravity_to_pty() {
    assert!(matches!(
        resolve_agent_type(None, AgentProvider::Antigravity),
        Ok(AgentSessionType::Pty)
    ));
}

#[test]
fn build_agent_command_adds_claude_kanna_preamble_as_system_prompt() {
    let preamble = super::build_kanna_preamble(
        &AgentProvider::Claude,
        "task-123",
        "review",
        "qa",
        Some("auto"),
        Some("/tmp/kanna-mcp.json"),
    );

    let command = super::build_agent_command(
        &AgentProvider::Claude,
        "Review the branch.",
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        Some(&preamble),
        None,
        None,
        None,
    );

    assert!(command.contains("--append-system-prompt '"));
    assert!(command.contains("## Kanna Task Environment"));
    assert!(command.contains(
        "This session was launched by Kanna as task `task-123`, stage `review` of pipeline `qa` (transition: `auto`)."
    ));
    assert!(!command.contains("{{TASK_CONTEXT}}"));
    assert!(!command.contains("{{MCP_STATUS}}"));
    assert!(command.contains("Claude is launched with this config via `--mcp-config`"));
    assert!(command.contains("kanna-cli guide"));
    assert!(command.contains("You are not running inside a Kanna sandbox"));
    let mcp_index = command
        .find("Prefer the `kanna_*` MCP tools")
        .expect("preamble should prefer MCP tools");
    let cli_index = command
        .find("If MCP tools are unavailable, fall back to the `kanna-cli` binary")
        .expect("preamble should describe CLI fallback");
    assert!(mcp_index < cli_index);
    assert!(cli_index < command.find("kanna-cli guide").unwrap());
    assert!(command.contains("KANNA_CLI_PATH"));
    assert!(command.contains("Do not push a branch or create a pull request"));
    assert!(command.contains("kanna_complete_stage"));
    assert!(command.contains("kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\""));
    assert!(command.contains("record completion so Kanna can advance the pipeline"));
}

#[test]
fn build_kanna_preamble_renders_transition_specific_completion_guidance() {
    let auto = super::build_kanna_preamble(
        &AgentProvider::Claude,
        "task-123",
        "review",
        "qa",
        Some("auto"),
        None,
    );
    assert!(auto.contains("This stage's transition is `auto`"));
    assert!(auto.contains("record completion so Kanna can advance the pipeline"));
    assert!(auto.contains("--status success --summary \"...\""));
    assert!(!auto.contains("{{COMPLETION}}"));

    let manual = super::build_kanna_preamble(
        &AgentProvider::Claude,
        "task-123",
        "in progress",
        "default",
        Some("manual"),
        None,
    );
    assert!(manual.contains("This stage's transition is `manual`"));
    assert!(manual.contains("recording a successful result does not advance the pipeline"));
    assert!(manual.contains("record completion only if this stage's prompt asks for it"));
    assert!(manual.contains("record status `failure` with the reason"));
    assert!(!manual.contains("--status success"));
    assert!(!manual.contains("{{COMPLETION}}"));

    // Unknown transition falls back to manual, the safe non-advancing default.
    let default = super::build_kanna_preamble(
        &AgentProvider::Claude,
        "task-123",
        "in progress",
        "default",
        None,
        None,
    );
    assert!(default.contains("This stage's transition is `manual`"));
}

#[test]
fn build_agent_command_launches_antigravity_with_prepended_kanna_context() {
    let preamble = super::build_kanna_preamble(
        &AgentProvider::Antigravity,
        "task-123",
        "implement",
        "default",
        Some("manual"),
        None,
    );

    let command = super::build_agent_command(
        &AgentProvider::Antigravity,
        "Ship the task.",
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        Some(&preamble),
        None,
        Some("/tmp/repo/.kanna-worktrees/task-123"),
        None,
    );

    assert!(command.starts_with(
        "mkdir -p '/tmp/kanna-antigravity-workspaces' && rm -f '/tmp/kanna-antigravity-workspaces/task-123' && ln -s '/tmp/repo/.kanna-worktrees/task-123' '/tmp/kanna-antigravity-workspaces/task-123' && agy --dangerously-skip-permissions --add-dir '/tmp/kanna-antigravity-workspaces/task-123' --prompt-interactive '"
    ));
    assert!(command.contains("## Kanna Task Environment"));
    assert!(command.contains("task `task-123`"));
    assert!(!command.contains("{{MCP_STATUS}}"));
    assert!(command.contains("## Your Task\n\nShip the task."));
}

fn write_test_mcp_config(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kanna-server-{label}-mcp-{}.json",
        std::process::id()
    ));
    std::fs::write(
        &path,
        serde_json::json!({
            "mcpServers": {
                "kanna-mcp": {
                    "command": "/tmp/kanna mcp/kanna-mcp",
                    "args": ["serve"],
                    "env": {
                        "KANNA_SERVER_BASE_URL": "http://127.0.0.1:48120"
                    }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    path
}

#[test]
fn build_agent_command_registers_codex_kanna_mcp_with_config_overrides() {
    let mcp_config = write_test_mcp_config("codex-command");
    let command = super::build_agent_command(
        &AgentProvider::Codex,
        "Do work.",
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        Some("Kanna preamble."),
        Some(mcp_config.to_string_lossy().as_ref()),
        None,
        None,
    );

    assert!(command.starts_with("codex "));
    assert!(command.contains("-c 'mcp_servers.kanna-mcp.command=\"/tmp/kanna mcp/kanna-mcp\"'"));
    assert!(command.contains("-c 'mcp_servers.kanna-mcp.args=[\"serve\"]'"));
    assert!(command.contains(
        "-c 'mcp_servers.kanna-mcp.env.KANNA_SERVER_BASE_URL=\"http://127.0.0.1:48120\"'"
    ));
    assert!(command.contains("'Kanna preamble."));
    assert!(command.contains("Do work."));

    let _ = std::fs::remove_file(mcp_config);
}

#[test]
fn build_agent_command_registers_copilot_kanna_mcp_with_additional_config() {
    let mcp_config = write_test_mcp_config("copilot-command");
    let command = super::build_agent_command(
        &AgentProvider::Copilot,
        "Do work.",
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        Some("Kanna preamble."),
        Some(mcp_config.to_string_lossy().as_ref()),
        None,
        None,
    );

    assert!(command.starts_with("copilot "));
    assert!(command.contains("--additional-mcp-config @'"));
    assert!(command.contains(mcp_config.to_string_lossy().as_ref()));
    assert!(command.contains("-i 'Kanna preamble."));
    assert!(command.contains("Do work."));

    let _ = std::fs::remove_file(mcp_config);
}

#[test]
fn build_agent_command_registers_opencode_kanna_mcp_with_inline_config() {
    let mcp_config = write_test_mcp_config("opencode-command");
    let command = super::build_agent_command(
        &AgentProvider::Opencode,
        "Do work.",
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        Some("Kanna preamble."),
        Some(mcp_config.to_string_lossy().as_ref()),
        None,
        None,
    );

    assert!(command.contains("OPENCODE_CONFIG_CONTENT='"));
    assert!(command.contains("\"$schema\":\"https://opencode.ai/config.json\""));
    assert!(command
        .contains("\"mcp\":{\"kanna-mcp\":{\"command\":[\"/tmp/kanna mcp/kanna-mcp\",\"serve\"]"));
    assert!(command.contains("\"type\":\"local\""));
    assert!(command.contains("\"enabled\":true"));
    assert!(command.contains("\"KANNA_SERVER_BASE_URL\":\"http://127.0.0.1:48120\""));
    assert!(command.contains("run --interactive"));
    assert!(command.contains("'Kanna preamble."));
    assert!(command.contains("Do work."));

    let _ = std::fs::remove_file(mcp_config);
}

#[test]
fn build_kanna_preamble_names_automatic_and_fallback_mcp_providers() {
    let codex = super::build_kanna_preamble(
        &AgentProvider::Codex,
        "task-123",
        "implement",
        "default",
        None,
        Some("/tmp/kanna-mcp.json"),
    );
    assert!(codex.contains("Codex is launched with Kanna MCP registration"));
    assert!(codex.contains("Kanna MCP tools should be available automatically"));

    let antigravity = super::build_kanna_preamble(
        &AgentProvider::Antigravity,
        "task-123",
        "implement",
        "default",
        None,
        Some("/tmp/kanna-mcp.json"),
    );
    assert!(antigravity.contains("Antigravity CLI MCP registration is not wired"));
    assert!(antigravity.contains("use the `kanna-cli` fallback for Kanna task operations"));
}

#[test]
fn resolve_binary_prefers_sidecar_candidate_before_path_lookup() {
    let temp_root = std::env::temp_dir().join(format!(
        "kanna-server-sidecar-resolver-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&temp_root);
    std::fs::create_dir_all(&temp_root).unwrap();
    let sidecar = temp_root.join("kanna-cli");
    std::fs::write(&sidecar, "#!/bin/sh\n").unwrap();

    let resolved =
        resolve_binary_from_candidates_with_path_lookup("kanna-cli", vec![sidecar.clone()], |_| {
            Ok("/usr/local/bin/kanna-cli".to_string())
        })
        .expect("sidecar candidate should resolve");

    assert_eq!(resolved, sidecar.to_string_lossy());
}

#[test]
fn build_spawn_env_prepends_kanna_cli_directory_to_path() {
    let _sidecar_guard = super::TEST_SIDECAR_LOCK.lock().unwrap();
    let mut config = test_config("spawn-env-kanna-cli-path");
    let (kanna_cli_path, created_test_sidecar) = ensure_test_sidecar("kanna-cli");
    let (kanna_mcp_path, created_test_mcp_sidecar) = ensure_test_sidecar("kanna-mcp");
    config.kanna_cli_path = Some(kanna_cli_path.to_string_lossy().to_string());
    let env = build_spawn_env(&config, "task-1", &HashMap::new()).unwrap();
    let cli_path = env
        .get("KANNA_CLI_PATH")
        .expect("test host should resolve kanna-cli");
    let cli_dir = std::path::Path::new(cli_path)
        .parent()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let path = env.get("PATH").expect("PATH should be provided");

    assert_eq!(path.split(':').next(), Some(cli_dir.as_str()));
    if created_test_sidecar {
        let _ = std::fs::remove_file(kanna_cli_path);
    }
    if created_test_mcp_sidecar {
        let _ = std::fs::remove_file(kanna_mcp_path);
    }
}

#[test]
fn prepare_task_defaults_to_agent_session_for_claude_and_codex() {
    for provider in ["claude", "codex"] {
        let label = format!("agent-default-{provider}");
        let repo_root = init_git_repo(&label);
        let config = test_config(&label);
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
            .unwrap();

        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: format!("Use {provider}"),
                display_name: None,
                pipeline_name: None,
                stage: None,
                base_ref: None,
                agent: None,
                agent_provider: Some(provider.to_string()),
                agent_type: None,
                model: Some("model-a".to_string()),
                permission_mode: Some("dontAsk".to_string()),
                allowed_tools: Some(vec!["Bash".to_string()]),
                disallowed_tools: None,
                max_turns: None,
                max_budget_usd: None,
                setup_cmds: None,
                resume_session_id: None,
                notify_task_id: None,
                parent_task_id: None,
                blocker_task_ids: None,
            },
        )
        .unwrap();

        let created = db
            .list_pipeline_items("repo-1")
            .unwrap()
            .into_iter()
            .find(|item| item.id == prepared.created_task.task_id)
            .unwrap();
        assert_eq!(created.agent_type.as_deref(), Some("agent"));
        assert!(matches!(
            prepared.session,
            PreparedSessionSpawn::Agent { .. }
        ));

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn prepare_task_uses_create_request_agent_selector() {
    let repo_root = init_git_repo("create-request-agent-selector");
    let config = test_config("create-request-agent-selector");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let agent_dir = repo_root.join(".kanna/agents/setup");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nagent_provider: codex\nmodel: gpt-5\npermission_mode: dontAsk\nallowed_tools:\n  - Bash\n---\nsetup agent prompt",
    )
    .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Set up Kanna for this repository.".to_string(),
            display_name: Some("Set Up Repository".to_string()),
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: Some("setup".to_string()),
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert_eq!(prepared.stage_agent.as_deref(), Some("setup"));
    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model.as_deref(), Some("gpt-5"));
    match prepared.session {
        PreparedSessionSpawn::Pty {
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(agent_provider, DaemonAgentProvider::Codex);
            let command = args.join(" ");
            assert!(command.contains("setup agent prompt"));
            assert!(!command.contains("implement agent prompt"));
        }
        _ => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_persists_create_spawn_options_and_custom_setup() {
    let repo_root = init_git_repo("create-spawn-options");
    let config = test_config("create-spawn-options");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Run with custom options".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            model: Some("opus".to_string()),
            permission_mode: Some("acceptEdits".to_string()),
            allowed_tools: Some(vec!["Bash".to_string()]),
            disallowed_tools: Some(vec!["WebFetch".to_string()]),
            max_turns: Some(7),
            max_budget_usd: Some(1.5),
            setup_cmds: Some(vec!["echo custom setup".to_string()]),
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    let spawn_options: serde_json::Value = serde_json::from_str(
        &db.get_test_pipeline_item_spawn_options(&prepared.created_task.task_id)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(spawn_options["model"], "opus");
    assert_eq!(spawn_options["permissionMode"], "acceptEdits");
    assert_eq!(spawn_options["allowedTools"], serde_json::json!(["Bash"]));
    assert_eq!(
        spawn_options["disallowedTools"],
        serde_json::json!(["WebFetch"])
    );
    assert_eq!(spawn_options["maxTurns"], 7);
    assert_eq!(spawn_options["maxBudgetUsd"], 1.5);

    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("echo custom setup"));
            assert!(command.contains("--model opus"));
            assert!(command.contains("--permission-mode acceptEdits"));
            assert!(command.contains("--allowedTools Bash"));
            assert!(command.contains("--disallowedTools WebFetch"));
            assert!(command.contains("--max-turns 7"));
            assert!(command.contains("--max-budget-usd 1.5"));
        }
        _ => panic!("expected pty spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_for_api_resumes_requested_claude_session() {
    let repo_root = init_git_repo("create-resume-claude");
    let config = test_config("create-resume-claude");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let resume_session_id = "364643cc-5e6d-48fc-86ca-ca7764380900";
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Resume imported work".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: Some(resume_session_id.to_string()),
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert_eq!(
        prepared.provider_session_id.as_deref(),
        Some(resume_session_id)
    );
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains(&format!("--resume '{resume_session_id}'")));
            assert!(!command.contains("--session-id"));
        }
        _ => panic!("expected pty spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_for_api_creates_worktree_without_cargo_config() {
    let repo_root = init_git_repo("no-cargo-config");
    let config = test_config("no-cargo-config");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Create a task worktree".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
    // This boundary test exercises the real server-side task worktree creation
    // without booting the full desktop app, which is too heavyweight for this
    // filesystem side-effect regression.
    assert!(
        !std::path::Path::new(&prepared.cwd)
            .join(".cargo/config.toml")
            .exists(),
        "fresh Kanna-created task worktrees must not receive .cargo/config.toml"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_codex_agent_uses_resolved_executable_for_headless_spawn() {
    let _sidecar_guard = super::TEST_SIDECAR_LOCK.lock().unwrap();
    let (codex_sidecar, created_sidecar) = ensure_test_sidecar("codex");
    let repo_root = init_git_repo("codex-headless-executable");
    let config = test_config("codex-headless-executable");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use codex".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    match prepared.session {
        PreparedSessionSpawn::Agent { executable, .. } => {
            let executable = executable.expect("codex executable should be resolved");
            assert_eq!(executable, codex_sidecar.to_string_lossy());
        }
        _ => panic!("expected agent session"),
    }

    if created_sidecar {
        let _ = std::fs::remove_file(&codex_sidecar);
    }
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_headless_agent_uses_worktree_workspace_path_for_executable_resolution() {
    let _sidecar_guard = super::TEST_SIDECAR_LOCK.lock().unwrap();
    use std::os::unix::fs::PermissionsExt;

    let repo_root = init_git_repo("headless-workspace-path");
    let config = test_config("headless-workspace-path");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let fake_bin = repo_root.join(".kanna/fake-bin");
    std::fs::create_dir_all(&fake_bin).unwrap();
    let fake_codex = fake_bin.join("codex");
    std::fs::write(&fake_codex, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/fake-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add workspace path"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use codex".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    let expected = std::path::Path::new(&prepared.cwd).join(".kanna/fake-bin/codex");
    match prepared.session {
        PreparedSessionSpawn::Agent { executable, .. } => {
            assert_eq!(
                executable.as_deref(),
                Some(expected.to_string_lossy().as_ref())
            );
        }
        _ => panic!("expected agent session"),
    }

    let path = prepared
        .env
        .get("PATH")
        .expect("spawn env should include PATH");
    let expected_dir = expected.parent().unwrap().to_string_lossy().to_string();
    assert_eq!(path.split(':').next(), Some(expected_dir.as_str()));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_defaults_to_pty_session_for_copilot() {
    let repo_root = init_git_repo("copilot-pty-default");
    let config = test_config("copilot-pty-default");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use copilot".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("copilot".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    let created = db
        .list_pipeline_items("repo-1")
        .unwrap()
        .into_iter()
        .find(|item| item.id == prepared.created_task.task_id)
        .unwrap();
    assert_eq!(created.agent_type.as_deref(), Some("pty"));
    assert!(matches!(prepared.session, PreparedSessionSpawn::Pty { .. }));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_pty_task_restores_workspace_path_inside_login_shell_command() {
    use std::os::unix::fs::PermissionsExt;

    let repo_root = init_git_repo("pty-workspace-path");
    let config = test_config("pty-workspace-path");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let fake_bin = repo_root.join(".kanna/fake-bin");
    std::fs::create_dir_all(&fake_bin).unwrap();
    let fake_codex = fake_bin.join("codex");
    std::fs::write(&fake_codex, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/fake-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add workspace path"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use codex".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    let expected_dir = std::path::Path::new(&prepared.cwd)
        .join(".kanna/fake-bin")
        .to_string_lossy()
        .to_string();
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.last().expect("pty shell should include command");
            let restore_path = format!("export PATH='{expected_dir}:");
            assert!(
                command.contains(&restore_path),
                "command should restore spawn PATH before running agent: {command}"
            );
            let path_index = command.find("export PATH=").unwrap();
            let codex_index = command.find("codex ").unwrap();
            assert!(path_index < codex_index);
        }
        _ => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_stores_parent_task_id_for_subtasks() {
    let repo_root = init_git_repo("subtask-parent");
    let config = test_config("subtask-parent");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "parent-1",
        "repo-1",
        "parent prompt",
        Some("Parent"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Child prompt".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: Some("parent-1".to_string()),
        },
    )
    .unwrap();

    assert_eq!(
        db.get_test_pipeline_item_parent(&prepared.created_task.task_id)
            .unwrap()
            .as_deref(),
        Some("parent-1")
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_rejects_missing_parent_task() {
    let repo_root = init_git_repo("subtask-missing-parent");
    let config = test_config("subtask-missing-parent");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let err = match prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Child prompt".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: Some("missing-parent".to_string()),
        },
    ) {
        Ok(_) => panic!("expected missing parent to be rejected"),
        Err(err) => err,
    };

    assert!(err.contains("parent task not found"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn build_spawn_env_prefers_configured_kanna_cli_path() {
    let mut config = test_config("spawn-env-configured-kanna-cli-path");
    config.kanna_cli_path = Some("/Applications/Kanna.app/Contents/MacOS/kanna-cli".to_string());

    let env = build_spawn_env(&config, "task-1", &HashMap::new()).unwrap();

    assert_eq!(
        env.get("KANNA_CLI_PATH").map(String::as_str),
        Some("/Applications/Kanna.app/Contents/MacOS/kanna-cli")
    );
    assert!(env
        .get("PATH")
        .expect("PATH should be set for sidecars")
        .split(':')
        .any(|entry| entry == "/Applications/Kanna.app/Contents/MacOS"));
}

#[test]
fn prepare_task_uses_builtin_default_pipeline_when_repo_has_no_local_default_pipeline() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-task-default-pipeline-fallback-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "README.md"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("default-pipeline-fallback"),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let original_cwd = std::env::current_dir().unwrap();
    let unrelated_cwd = std::env::temp_dir().join(format!(
        "kanna-task-default-pipeline-unrelated-cwd-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&unrelated_cwd);
    std::fs::create_dir_all(&unrelated_cwd).unwrap();
    std::env::set_current_dir(&unrelated_cwd).unwrap();

    let prepared_result = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Implement the fallback".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    );
    std::env::set_current_dir(original_cwd).unwrap();
    let prepared = prepared_result.unwrap();

    assert_eq!(prepared.created_task.stage, "in progress");
    assert_eq!(prepared.created_task.title, "Implement the fallback");
    let branch = format!("task-{}", prepared.session_id);
    let worktree_count = db
        .count_test_worktrees_for_task(&prepared.created_task.task_id, &prepared.cwd, &branch)
        .unwrap();
    assert_eq!(worktree_count, 1);
    let terminal_session_id = db
        .resolve_task_terminal_session_id(&prepared.created_task.task_id)
        .unwrap();
    assert_eq!(
        terminal_session_id.as_deref(),
        Some(prepared.session_id.as_str())
    );
}

#[test]
fn prepare_task_prefers_explicit_then_agent_definition_over_default_provider_setting() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-task-default-agent-provider-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["add", "README.md"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("default-agent-provider"),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        server_version: Some("test-version".to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.set_test_setting("defaultAgentProvider", "copilot")
        .unwrap();

    // Executable discovery has dedicated coverage; keep this integration test
    // focused on provider-source precedence by preparing PTY sessions.
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the configured default provider".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let created_source = db
        .get_task_stage_source(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();

    assert_eq!(created_source.agent_provider.as_deref(), Some("codex"));

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the explicit provider".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            resume_session_id: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let created_source = db
        .get_task_stage_source(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();

    assert_eq!(created_source.agent_provider.as_deref(), Some("claude"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn default_agent_provider_setting_falls_back_to_claude_when_unset() {
    let db_path = Db::test_db_path("default-agent-provider-unset");
    let db = Db::open_for_tests(&db_path).unwrap();

    let provider = read_default_agent_provider_setting(&db).unwrap();

    assert_eq!(provider.as_deref(), Some("claude"));
}

#[test]
fn default_agent_provider_setting_falls_back_to_claude_when_invalid() {
    let db_path = Db::test_db_path("default-agent-provider-invalid");
    let db = Db::open_for_tests(&db_path).unwrap();
    db.set_test_setting("defaultAgentProvider", "future-agent")
        .unwrap();

    let provider = read_default_agent_provider_setting(&db).unwrap();

    assert_eq!(provider.as_deref(), Some("claude"));
}
