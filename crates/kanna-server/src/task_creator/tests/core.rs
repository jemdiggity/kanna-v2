use super::super::definitions::{
    AgentDefinition, DefinitionVisibility, RepoDefinitions, WorkflowDefinition,
    WorkflowStageTransition,
};
use super::super::provider::{
    resolve_agent_provider_with, validate_effort_shape, validate_model_shape,
    validate_provider_effort, validate_provider_model,
};
use super::*;

#[test]
fn repo_command_template_identity_persists_the_selected_teardown_for_close() {
    let repo_root = init_git_repo("repo-command-template-teardown");
    for (slug, teardown) in [
        ("same-label-first", "printf WRONG_TEMPLATE_TEARDOWN"),
        ("same-label-selected", "printf SELECTED_TEMPLATE_TEARDOWN"),
    ] {
        let task_dir = repo_root.join(format!(".kanna/tasks/{slug}"));
        std::fs::create_dir_all(&task_dir).unwrap();
        std::fs::write(
            task_dir.join("agent.md"),
            format!("---\nname: Shared label\nteardown: [{teardown}]\n---\nRun {slug}.\n"),
        )
        .unwrap();
    }
    publish_origin_main(&repo_root, "publish same-label task templates");

    let config = test_config("repo-command-template-teardown");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let repo = db.get_repo("repo-1").unwrap().unwrap();
    let launch =
        crate::repo_commands::resolve_repo_command_launch(&repo, "custom:same-label-selected")
            .unwrap()
            .1
            .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: launch.prompt,
            display_name: Some(launch.display_name),
            workflow_name: None,
            stage: launch.stage,
            base_ref: None,
            agent: launch.agent,
            agent_provider: launch.agent_provider,
            agent_type: launch.agent_type,
            terminal_cols: None,
            terminal_rows: None,
            model: launch.model,
            effort: launch.effort,
            permission_mode: launch.permission_mode,
            allowed_tools: launch.allowed_tools,
            disallowed_tools: launch.disallowed_tools,
            max_turns: launch.max_turns,
            max_budget_usd: launch.max_budget_usd,
            setup_cmds: launch.setup_cmds,
            task_template: launch.task_template,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
        },
    )
    .unwrap();
    let task_id = prepared.task_id().to_string();
    let stored_options = db
        .get_test_pipeline_item_spawn_options(&task_id)
        .unwrap()
        .unwrap();
    assert!(
        stored_options.contains("custom:same-label-selected"),
        "selected template identity must be durable: {stored_options}"
    );

    let teardown = super::super::prepare_workspace_teardown_for_close(&db, &config, &task_id)
        .expect("selected template teardown");
    let command = match teardown.session {
        PreparedSessionSpawn::Pty { args, .. } => args.join(" "),
        PreparedSessionSpawn::Agent { .. } => panic!("teardown must use a PTY"),
    };
    assert!(command.contains("SELECTED_TEMPLATE_TEARDOWN"), "{command}");
    assert!(!command.contains("WRONG_TEMPLATE_TEARDOWN"), "{command}");

    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

fn seed_closed_reopen_task(label: &str) -> (std::path::PathBuf, Config) {
    let repo_root = init_git_repo(label);
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"ports":{"KANNA_DEV_PORT":1420}}"#,
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish reopen port config");

    let config = test_config(label);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-closed",
        "repo-1",
        "task prompt",
        Some("Task"),
        "in progress",
        "2026-07-25 06:00:00",
    )
    .unwrap();
    db.set_test_pipeline_item_closed_at("task-closed", "2026-07-25 07:00:00")
        .unwrap();
    (repo_root, config)
}

#[test]
fn reopen_failure_rolls_back_lifecycle_port_metadata_and_claims_exactly() {
    let (repo_root, config) = seed_closed_reopen_task("reopen-atomic-rollback");
    let db = Db::open(&config.db_path).unwrap();
    db.update_pipeline_item_ports(
        "task-closed",
        Some(4101),
        Some(r#"{"ORIGINAL_PORT":"4101"}"#),
    )
    .unwrap();
    assert!(db
        .claim_task_port("task-closed", "ORIGINAL_PORT", 4101)
        .unwrap());
    drop(db);

    let raw = Connection::open(&config.db_path).unwrap();
    raw.execute_batch(
        r#"
        CREATE TRIGGER inject_reopen_port_persistence_failure
        BEFORE UPDATE OF port_env ON pipeline_item
        WHEN NEW.id = 'task-closed' AND NEW.closed_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'injected reopen persistence failure');
        END;
        "#,
    )
    .unwrap();
    let original: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = raw
        .query_row(
            "SELECT closed_at, teardown_started_at, updated_at, port_offset, port_env
             FROM pipeline_item WHERE id = 'task-closed'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    drop(raw);

    let db = Db::open(&config.db_path).unwrap();
    let error = reopen_task_for_api(&db, "task-closed").unwrap_err();
    assert!(
        matches!(error, ReopenTaskError::Internal(ref message) if message.contains("injected reopen persistence failure")),
        "unexpected reopen error: {error:?}"
    );
    let current: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = Connection::open(&config.db_path)
        .unwrap()
        .query_row(
            "SELECT closed_at, teardown_started_at, updated_at, port_offset, port_env
             FROM pipeline_item WHERE id = 'task-closed'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        current, original,
        "failed reopen must restore exact row state"
    );
    assert_eq!(
        db.list_task_ports_for_item("task-closed").unwrap(),
        HashMap::from([("ORIGINAL_PORT".to_string(), 4101)]),
        "failed reopen must restore the exact prior claims"
    );

    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn reopen_retry_of_open_task_is_a_guarded_noop() {
    let (repo_root, config) = seed_closed_reopen_task("reopen-atomic-retry");
    let db = Db::open(&config.db_path).unwrap();
    assert_eq!(
        reopen_task_for_api(&db, "task-closed").unwrap(),
        "task-closed"
    );
    let original_item = db.get_pipeline_item("task-closed").unwrap().unwrap();
    let original_metadata = db.get_test_pipeline_item_ports("task-closed").unwrap();
    let original_claims = db.list_task_ports_for_item("task-closed").unwrap();
    let hook_called = std::sync::atomic::AtomicBool::new(false);

    let retried = reopen_task_for_api_with_test_hook(&db, "task-closed", || {
        hook_called.store(true, std::sync::atomic::Ordering::SeqCst);
        Err("already-open retry reached the reopen mutation".to_string())
    });

    assert_eq!(retried.unwrap(), "task-closed");
    assert!(!hook_called.load(std::sync::atomic::Ordering::SeqCst));
    let current_item = db.get_pipeline_item("task-closed").unwrap().unwrap();
    assert_eq!(current_item.closed_at, original_item.closed_at);
    assert_eq!(current_item.updated_at, original_item.updated_at);
    assert_eq!(
        db.get_test_pipeline_item_ports("task-closed").unwrap(),
        original_metadata
    );
    assert_eq!(
        db.list_task_ports_for_item("task-closed").unwrap(),
        original_claims
    );

    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn concurrent_close_cannot_observe_or_interleave_with_partial_reopen() {
    let (repo_root, config) = seed_closed_reopen_task("reopen-atomic-concurrent-close");
    let reopen_db = Db::open(&config.db_path).unwrap();
    let observer_db = Db::open(&config.db_path).unwrap();
    let close_db = Db::open(&config.db_path).unwrap();
    let (start_close_tx, start_close_rx) = std::sync::mpsc::channel();
    let (close_attempted_tx, close_attempted_rx) = std::sync::mpsc::channel();
    let (close_done_tx, close_done_rx) = std::sync::mpsc::channel();
    let close_thread = std::thread::spawn(move || {
        start_close_rx.recv().unwrap();
        close_attempted_tx.send(()).unwrap();
        let result = close_db.close_pipeline_item("task-closed");
        close_done_tx.send(()).unwrap();
        result
    });
    let partial_reopen_was_visible = std::sync::atomic::AtomicBool::new(false);
    let close_interleaved = std::sync::atomic::AtomicBool::new(false);

    let reopened = reopen_task_for_api_with_test_hook(&reopen_db, "task-closed", || {
        let visible_item = observer_db
            .get_pipeline_item("task-closed")
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "task disappeared during reopen".to_string())?;
        partial_reopen_was_visible.store(
            visible_item.closed_at.is_none(),
            std::sync::atomic::Ordering::SeqCst,
        );
        start_close_tx.send(()).map_err(|error| error.to_string())?;
        close_attempted_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .map_err(|error| error.to_string())?;
        close_interleaved.store(
            close_done_rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_ok(),
            std::sync::atomic::Ordering::SeqCst,
        );
        Ok(())
    });

    assert_eq!(reopened.unwrap(), "task-closed");
    close_thread.join().unwrap().unwrap();
    assert!(
        !partial_reopen_was_visible.load(std::sync::atomic::Ordering::SeqCst),
        "other connections must keep seeing the task as closed until reopen commits"
    );
    assert!(
        !close_interleaved.load(std::sync::atomic::Ordering::SeqCst),
        "a concurrent close must block behind the complete reopen transaction"
    );
    let db = Db::open(&config.db_path).unwrap();
    assert!(
        db.get_pipeline_item("task-closed")
            .unwrap()
            .unwrap()
            .closed_at
            .is_some(),
        "the serialized close should win after reopen commits"
    );
    assert!(
        db.list_task_ports_for_item("task-closed")
            .unwrap()
            .is_empty(),
        "the serialized close must release every port claimed by reopen"
    );

    let _ = std::fs::remove_dir_all(repo_root);
    let _ = std::fs::remove_file(config.db_path);
}
use crate::db::{NewRepo, Repo};

#[test]
fn workflow_stage_policy_resolves_revision_transition_with_fallback() {
    let explicit: WorkflowDefinition = serde_json::from_str(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual", "revision_transition": "auto"}
          }]
        }"#,
    )
    .unwrap();
    let explicit_policy = &explicit.stages[0].policy;
    assert_eq!(explicit_policy.transition, WorkflowStageTransition::Manual);
    assert_eq!(
        explicit_policy.revision_transition(),
        WorkflowStageTransition::Auto
    );
    assert!(serde_json::to_string(&explicit)
        .unwrap()
        .contains("revision_transition"));

    let inherited: WorkflowDefinition = serde_json::from_str(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual"}
          }]
        }"#,
    )
    .unwrap();
    assert_eq!(
        inherited.stages[0].policy.revision_transition(),
        WorkflowStageTransition::Manual
    );

    let invalid = serde_json::from_str::<WorkflowDefinition>(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual", "revision_transition": "sometimes"}
          }]
        }"#,
    );
    assert!(invalid.is_err());
}

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

fn string_values(values: Option<&[String]>) -> Option<Vec<&str>> {
    values.map(|values| values.iter().map(String::as_str).collect())
}

fn definition_repo(repo_root: &std::path::Path, default_branch: &str) -> Repo {
    Repo {
        id: format!("repo-{}", repo_root.display()),
        path: repo_root.to_string_lossy().into_owned(),
        name: "Definition fixture".to_string(),
        default_branch: Some(default_branch.to_string()),
        remote_url_hash: None,
        hidden: None,
        sort_order: None,
        created_at: None,
        last_opened_at: None,
    }
}

fn resolve_test_agent_definition(
    repo_root: &std::path::Path,
    agent_name: &str,
) -> Result<AgentDefinition, String> {
    RepoDefinitions::resolve(&definition_repo(repo_root, "main"))?.agent(agent_name)
}

fn resolve_test_workflow_definition(
    repo_root: &std::path::Path,
    workflow_name: &str,
) -> Result<super::super::definitions::WorkflowDefinition, String> {
    RepoDefinitions::resolve(&definition_repo(repo_root, "main"))?.workflow(workflow_name)
}

fn assert_remote_definition_error(error: &str, path: &str, revision: &str) {
    assert!(error.contains(path), "missing path {path:?} in {error:?}");
    assert!(
        error.contains("origin/main"),
        "missing attempted ref in {error:?}"
    );
    assert!(
        error.contains(revision),
        "missing pinned revision {revision:?} in {error:?}"
    );
}

#[test]
fn provider_resolution_cases_match_shared_contract() {
    let cases: Vec<ProviderResolutionCase> =
        serde_json::from_str(kanna_agent_protocol::PROVIDER_RESOLUTION_CASES_JSON).unwrap();

    for case in cases {
        let agent = (!case.agent.is_empty()).then(|| AgentDefinition {
            name: "test-agent".to_string(),
            description: "Test agent".to_string(),
            prompt: String::new(),
            agent_providers: case.agent.clone(),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            visibility: DefinitionVisibility::Public,
        });
        let available = case.available.clone();
        let result = resolve_agent_provider_with(
            joined(&case.explicit).as_deref(),
            (!case.stage.is_empty()).then_some(case.stage.as_slice()),
            None,
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
        resolve_agent_provider_with(Some("future-agent"), None, None, None, None, |_| true)
            .unwrap_err(),
        "unsupported agent provider 'future-agent' (supported: claude, copilot, codex, opencode, antigravity)",
    );
}

#[test]
fn model_validation_checks_shape_without_allowlisting_ids() {
    assert!(validate_model_shape(Some("future-provider/model-2027.preview")).is_ok());
    assert_eq!(
        validate_model_shape(Some("")).unwrap_err(),
        "model override must not be empty"
    );
    assert_eq!(
        validate_model_shape(Some(" gpt-5.6")).unwrap_err(),
        "model override must not have leading or trailing whitespace"
    );
    assert_eq!(
        validate_provider_model(AgentProvider::Antigravity, Some("some-model")).unwrap_err(),
        "model overrides are not supported for agent provider 'antigravity'"
    );
}

#[test]
fn effort_validation_uses_provider_native_vocabularies() {
    assert!(validate_effort_shape(Some("future-model-variant")).is_ok());
    assert_eq!(
        validate_effort_shape(Some("")).unwrap_err(),
        "effort override must not be empty"
    );
    assert_eq!(
        validate_effort_shape(Some(" high")).unwrap_err(),
        "effort override must not have leading or trailing whitespace"
    );
    assert!(validate_provider_effort(AgentProvider::Opencode, Some("provider-native")).is_ok());
    assert!(validate_provider_effort(AgentProvider::Codex, Some("max")).is_ok());
    assert!(validate_provider_effort(AgentProvider::Claude, Some("xhigh")).is_ok());
    assert_eq!(
        validate_provider_effort(AgentProvider::Antigravity, Some("xhigh")).unwrap_err(),
        "effort 'xhigh' is not supported for agent provider 'antigravity' (supported: low, medium, high)"
    );
}

#[test]
fn create_task_rejects_model_for_provider_without_a_verified_flag() {
    let repo_root = init_git_repo("reject-antigravity-model");
    let config = test_config("reject-antigravity-model");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let error = match prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use an unsupported model override".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("antigravity".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: Some("some-model".to_string()),
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
        },
    ) {
        Ok(_) => panic!("antigravity model override should be rejected"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        "model overrides are not supported for agent provider 'antigravity'"
    );
    assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_task_rejects_unsupported_effort_before_persisting_state() {
    let repo_root = init_git_repo("reject-antigravity-effort");
    let config = test_config("reject-antigravity-effort");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let error = match prepare_task_for_api_with_error(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use an unsupported effort override".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("antigravity".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: Some("xhigh".to_string()),
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
        },
        None,
    ) {
        Ok(_) => panic!("antigravity xhigh effort should be rejected"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        PrepareTaskError::InvalidRequest(
            "effort 'xhigh' is not supported for agent provider 'antigravity' (supported: low, medium, high)"
                .to_string()
        )
    );
    assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_task_rejects_unsupported_provider_before_persisting_state() {
    let repo_root = init_git_repo("reject-unsupported-provider");
    let config = test_config("reject-unsupported-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let error = match prepare_task_for_api_with_error(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use an unsupported provider".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("future-agent".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            blocker_task_ids: None,
            notify_task_id: None,
            parent_task_id: None,
        },
        None,
    ) {
        Ok(_) => panic!("unsupported provider should be rejected"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        PrepareTaskError::InvalidRequest(
            "unsupported agent provider 'future-agent' (supported: claude, copilot, codex, opencode, antigravity)"
                .to_string()
        )
    );
    assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn provider_resolution_prefers_explicit_then_stage_then_repo_then_agent_then_fallback() {
    let agent = AgentDefinition {
        name: "review".to_string(),
        description: "Review".to_string(),
        prompt: String::new(),
        agent_providers: vec!["opencode".to_string()],
        model: Some("agent-model".to_string()),
        effort: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        visibility: DefinitionVisibility::Public,
    };
    let stage = vec!["copilot".to_string()];
    let repo = vec!["codex".to_string()];
    let available = |_| true;

    assert_eq!(
        resolve_agent_provider_with(
            Some("claude"),
            Some(&stage),
            Some(&repo),
            Some(&agent),
            Some("antigravity"),
            available,
        )
        .unwrap(),
        AgentProvider::Claude,
    );
    assert_eq!(
        resolve_agent_provider_with(
            None,
            Some(&stage),
            Some(&repo),
            Some(&agent),
            Some("antigravity"),
            available,
        )
        .unwrap(),
        AgentProvider::Copilot,
    );
    assert_eq!(
        resolve_agent_provider_with(
            None,
            None,
            Some(&repo),
            Some(&agent),
            Some("antigravity"),
            available,
        )
        .unwrap(),
        AgentProvider::Codex,
    );
    assert_eq!(
        resolve_agent_provider_with(
            None,
            None,
            None,
            Some(&agent),
            Some("antigravity"),
            available,
        )
        .unwrap(),
        AgentProvider::Opencode,
    );
    assert_eq!(
        resolve_agent_provider_with(None, None, None, None, Some("antigravity"), available,)
            .unwrap(),
        AgentProvider::Antigravity,
    );
}

#[test]
fn repo_agent_provider_preferences_resolve_exact_then_most_specific_glob_then_wildcard() {
    let config: super::super::definitions::RepoConfig = serde_json::from_value(serde_json::json!({
        "agentProviders": {
            "*": "antigravity",
            "review-*": "codex",
            "review-s*": {"provider": "opencode", "model": "glob-model", "effort": "high"},
            "review-security": "copilot",
            "qa-dispatcher": "claude"
        }
    }))
    .unwrap();

    let exact = config
        .agent_provider_preference(Some("review-security"))
        .unwrap();
    assert_eq!(exact.providers, vec!["copilot"]);
    let glob = config
        .agent_provider_preference(Some("review-storage"))
        .unwrap();
    assert_eq!(glob.providers, vec!["opencode"]);
    assert_eq!(glob.model.as_deref(), Some("glob-model"));
    assert_eq!(glob.effort.as_deref(), Some("high"));
    assert_eq!(
        config
            .agent_provider_preference(Some("review-ui"))
            .unwrap()
            .providers,
        vec!["codex"],
    );
    assert_eq!(
        config
            .agent_provider_preference(Some("implement"))
            .unwrap()
            .providers,
        vec!["antigravity"],
    );
}

#[test]
fn model_resolution_prefers_explicit_then_repo_then_layered_agent_definition() {
    let agent = AgentDefinition {
        name: "review".to_string(),
        description: "Review".to_string(),
        prompt: String::new(),
        agent_providers: vec!["claude".to_string()],
        model: Some("agent-model".to_string()),
        effort: Some("agent-effort".to_string()),
        permission_mode: None,
        allowed_tools: Vec::new(),
        visibility: DefinitionVisibility::Public,
    };
    let preference = super::super::definitions::AgentProviderPreference {
        providers: vec!["codex".to_string()],
        model: Some("repo-model".to_string()),
        effort: Some("repo-effort".to_string()),
    };

    assert_eq!(
        super::super::resolve_agent_model(
            Some("explicit-model".to_string()),
            Some(&preference),
            Some(&agent),
        )
        .as_deref(),
        Some("explicit-model"),
    );
    assert_eq!(
        super::super::resolve_agent_model(None, Some(&preference), Some(&agent)).as_deref(),
        Some("repo-model"),
    );
    assert_eq!(
        super::super::resolve_agent_model(None, None, Some(&agent)).as_deref(),
        Some("agent-model"),
    );
    assert_eq!(super::super::resolve_agent_model(None, None, None), None);
    assert_eq!(
        super::super::resolve_agent_effort(
            Some("explicit-effort".to_string()),
            Some(&preference),
            Some(&agent),
        )
        .as_deref(),
        Some("explicit-effort"),
    );
    assert_eq!(
        super::super::resolve_agent_effort(None, Some(&preference), Some(&agent)).as_deref(),
        Some("repo-effort"),
    );
    assert_eq!(
        super::super::resolve_agent_effort(None, None, Some(&agent)).as_deref(),
        Some("agent-effort"),
    );
    assert_eq!(super::super::resolve_agent_effort(None, None, None), None);
}

#[test]
fn workspace_config_env_merges_values_and_resolves_path_entries_against_worktree() {
    let worktree = std::path::Path::new("/tmp/kanna-worktrees/task-remote");
    let config: super::super::definitions::RepoConfig = serde_json::from_value(serde_json::json!({
        "workspace": {
            "env": {
                "REMOTE_ENV": "yes",
                "OVERRIDE_ME": "remote",
                "PATH": "remote-existing"
            },
            "path": {
                "prepend": ["remote-bin", "/absolute/prepend"],
                "append": ["remote-tail", "/absolute/append"]
            }
        }
    }))
    .unwrap();
    let mut env = HashMap::from([
        ("KEEP_ME".to_string(), "runtime".to_string()),
        ("OVERRIDE_ME".to_string(), "local".to_string()),
        ("PATH".to_string(), "runtime-existing".to_string()),
    ]);

    super::super::environment::apply_workspace_config_env(
        &mut env,
        &worktree.to_string_lossy(),
        &config,
    );

    assert_eq!(env.get("KEEP_ME").map(String::as_str), Some("runtime"));
    assert_eq!(env.get("REMOTE_ENV").map(String::as_str), Some("yes"));
    assert_eq!(env.get("OVERRIDE_ME").map(String::as_str), Some("remote"));
    assert_eq!(
        env.get("PATH").map(String::as_str),
        Some(
            "/tmp/kanna-worktrees/task-remote/remote-bin:/absolute/prepend:remote-existing:/tmp/kanna-worktrees/task-remote/remote-tail:/absolute/append"
        )
    );
}

#[test]
fn task_creation_uses_one_remote_default_branch_definition_context() {
    use std::os::unix::fs::PermissionsExt;

    let _sidecar_guard = crate::test_sidecar_guard();
    let repo_root = init_git_repo_without_provider_fixtures("remote-task-creation-context");
    let mut config = test_config("remote-task-creation-context");
    let kanna_cli_sidecar = ensure_test_sidecar("kanna-cli");
    let kanna_mcp_sidecar = ensure_test_sidecar("kanna-mcp");
    config.kanna_cli_path = Some(kanna_cli_sidecar.path().to_string_lossy().into_owned());
    let db = Db::open_for_tests(&config.db_path).unwrap();

    let write_definitions = |prefix: &str, provider: &str| {
        let lower = prefix.to_ascii_lowercase();
        let agent_name = format!("{lower}-agent");
        let workflow_name = format!("{lower}-workflow");
        let bin_dir = repo_root.join(format!("{lower}-bin"));
        std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
        std::fs::create_dir_all(repo_root.join(format!(".kanna/agents/{agent_name}"))).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(repo_root.join(format!("{lower}-tail"))).unwrap();
        std::fs::write(repo_root.join(format!("{lower}-tail/.keep")), "").unwrap();
        let provider_binary = bin_dir.join(provider);
        std::fs::write(&provider_binary, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&provider_binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::json!({
                "workflow": workflow_name,
                "setup": [format!("printf {prefix}_SETUP > {lower}-setup.marker")],
                "ports": {format!("{prefix}_PORT"): 49100},
                "reserved_port_offsets": [1],
                "vars": {format!("{prefix}_VAR"): format!("{prefix}_VALUE")},
                "workspace": {
                    "env": {
                        format!("{prefix}_ENV"): "yes",
                        format!("{prefix}_PORT"): "workspace-port-override",
                        "KANNA_TASK_ID": "workspace-task-override",
                        "KANNA_SOCKET_PATH": "/tmp/workspace-socket-override",
                        "KANNA_SERVER_BASE_URL": "http://workspace.invalid",
                        "KANNA_CLI_PATH": "/tmp/workspace-cli-override",
                        "KANNA_MCP_PATH": "/tmp/workspace-mcp-override",
                        "PATH": format!("{prefix}_WORKSPACE_PATH")
                    },
                    "path": {
                        "prepend": [format!("{lower}-bin")],
                        "append": [format!("{lower}-tail")]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            repo_root.join(format!(".kanna/workflows/{workflow_name}.json")),
            serde_json::json!({
                "name": workflow_name,
                "stages": [{
                    "name": "in progress",
                    "agent": agent_name,
                    "prompt": format!("{prefix}_WORKFLOW $TASK_PROMPT"),
                    "transition": "manual"
                }]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            repo_root.join(format!(".kanna/agents/{agent_name}/AGENT.md")),
            format!(
                "---\nname: {agent_name}\ndescription: {prefix} agent\nagent_provider: {provider}\nmodel: {lower}-model\npermission_mode: dontAsk\nallowed_tools:\n  - Read\n  - Bash\n---\n{prefix}_AGENT ${prefix}_VAR\n"
            ),
        )
        .unwrap();
    };

    write_definitions("LOCAL_SENTINEL", "claude");
    publish_origin_main(&repo_root, "publish local sentinel definitions");

    std::fs::remove_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::remove_dir_all(repo_root.join(".kanna/agents")).unwrap();
    write_definitions("REMOTE", "codex");
    publish_origin_branch(&repo_root, "dev", "publish remote dev definitions");

    // The live checkout disagrees with both tracked refs. Orchestration must
    // ignore it and use the exact origin/dev snapshot selected by the DB Repo.
    write_definitions("LOCAL_SENTINEL", "claude");

    db.insert_repo(NewRepo {
        id: "repo-1",
        path: &repo_root.to_string_lossy(),
        name: "Repo One",
        default_branch: Some("dev"),
    })
    .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Do remote work".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
    )
    .unwrap();

    let stored = db
        .get_pipeline_item(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.pipeline.as_deref(), Some("remote-workflow"));
    let workflow_def = stored.pipeline_def.as_deref().unwrap();
    assert!(workflow_def.contains("REMOTE_WORKFLOW"), "{workflow_def}");
    assert!(!workflow_def.contains("LOCAL_SENTINEL"), "{workflow_def}");
    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model.as_deref(), Some("remote-model"));
    assert_eq!(
        prepared.env.get("REMOTE_ENV").map(String::as_str),
        Some("yes")
    );
    assert!(!prepared.env.contains_key("LOCAL_SENTINEL_ENV"));
    assert_eq!(
        prepared.env.get("REMOTE_PORT").map(String::as_str),
        Some("49102")
    );
    assert_eq!(
        prepared.env.get("KANNA_TASK_ID").map(String::as_str),
        Some(prepared.created_task.task_id.as_str())
    );
    let expected_socket_path = kanna_runtime_defaults::socket_path(
        &std::path::Path::new(&config.daemon_dir).join("pipeline"),
    );
    assert_eq!(
        prepared.env.get("KANNA_SOCKET_PATH").map(String::as_str),
        Some(expected_socket_path.to_string_lossy().as_ref())
    );
    assert_eq!(
        prepared
            .env
            .get("KANNA_SERVER_BASE_URL")
            .map(String::as_str),
        Some("http://127.0.0.1:48120")
    );
    assert_eq!(
        prepared.env.get("KANNA_CLI_PATH").map(String::as_str),
        Some(kanna_cli_sidecar.path().to_string_lossy().as_ref())
    );
    assert_eq!(
        prepared.env.get("KANNA_MCP_PATH").map(String::as_str),
        Some(kanna_mcp_sidecar.path().to_string_lossy().as_ref())
    );
    let path = prepared.env.get("PATH").unwrap();
    let expected_prepend = format!("{}/remote-bin", prepared.cwd);
    let expected_append = format!("{}/remote-tail", prepared.cwd);
    let path_entries = path.split(':').collect::<Vec<_>>();
    let runtime_bin = kanna_cli_sidecar.path().parent().unwrap().to_string_lossy();
    let runtime_bin_position = path_entries
        .iter()
        .position(|entry| *entry == runtime_bin)
        .expect("PATH should retain the authoritative runtime binary directory");
    let workspace_env_position = path_entries
        .iter()
        .position(|entry| *entry == "REMOTE_WORKSPACE_PATH")
        .expect("PATH should retain the workspace.env value");
    assert_eq!(
        path_entries.first().copied(),
        Some(expected_prepend.as_str())
    );
    assert!(
        runtime_bin_position < workspace_env_position,
        "runtime binaries must remain inside the workspace PATH layers: {path}"
    );
    assert_eq!(path_entries.last().copied(), Some(expected_append.as_str()));
    let mcp_config_path = prepared
        .env
        .get("KANNA_MCP_CONFIG")
        .expect("task env should include an MCP config");
    let mcp_config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(mcp_config_path).unwrap()).unwrap();
    assert_eq!(
        mcp_config["mcpServers"]["kanna-mcp"]["command"],
        kanna_mcp_sidecar.path().to_string_lossy().as_ref()
    );
    assert_eq!(
        mcp_config["mcpServers"]["kanna-mcp"]["env"]["KANNA_SERVER_BASE_URL"],
        "http://127.0.0.1:48120"
    );
    assert!(std::path::Path::new(&prepared.cwd)
        .join("remote-setup.marker")
        .is_file());
    assert!(!std::path::Path::new(&prepared.cwd)
        .join("local_sentinel-setup.marker")
        .exists());

    match &prepared.session {
        PreparedSessionSpawn::Agent {
            prompt,
            model,
            permission_mode,
            allowed_tools,
            executable,
            ..
        } => {
            assert!(prompt.contains("REMOTE_AGENT REMOTE_VALUE"), "{prompt}");
            assert!(
                prompt.contains("REMOTE_WORKFLOW Do remote work"),
                "{prompt}"
            );
            assert!(!prompt.contains("LOCAL_SENTINEL"), "{prompt}");
            assert_eq!(model.as_deref(), Some("remote-model"));
            assert_eq!(permission_mode.as_deref(), Some("dontAsk"));
            assert_eq!(allowed_tools, &["Read".to_string(), "Bash".to_string()]);
            assert_eq!(
                executable.as_deref(),
                Some(format!("{}/remote-bin/codex", prepared.cwd).as_str())
            );
        }
        _ => panic!("expected remote headless agent spawn"),
    }

    let spawn_options: serde_json::Value = serde_json::from_str(
        db.get_test_pipeline_item_spawn_options(&prepared.created_task.task_id)
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(spawn_options["model"], "remote-model");
    assert_eq!(spawn_options["permissionMode"], "dontAsk");
    assert_eq!(
        spawn_options["allowedTools"],
        serde_json::json!(["Read", "Bash"])
    );

    let _ = std::fs::remove_dir_all(&repo_root);
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

#[test]
fn claim_task_ports_never_hands_out_a_port_kanna_binds_for_itself() {
    let config = test_config("internal-port-claim");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Sit next to Kanna's own ports",
        Some("Internal ports"),
        "in progress",
        "2026-08-05 10:00:00",
    )
    .unwrap();
    // Each base sits directly below one of Kanna's listeners, so the upward
    // search walks into it on the very first candidate.
    let repo_config = super::super::definitions::RepoConfig {
        ports: Some(HashMap::from([
            (
                "TRANSFER_ADJACENT".to_string(),
                kanna_runtime_defaults::DEFAULT_TRANSFER_PORT - 1,
            ),
            (
                "MOBILE_ADJACENT".to_string(),
                kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT - 1,
            ),
        ])),
        ..Default::default()
    };

    let port_env =
        super::super::environment::claim_task_ports(&db, "task-1", &repo_config).unwrap();

    // 4455 and 4456 are ours, so the first free port above 4454 is 4457;
    // 48120 and 48121 are ours, so the first above 48119 is 48122.
    assert_eq!(
        port_env,
        HashMap::from([
            ("TRANSFER_ADJACENT".to_string(), "4457".to_string()),
            ("MOBILE_ADJACENT".to_string(), "48122".to_string()),
        ])
    );
    for port in kanna_runtime_defaults::RESERVED_INTERNAL_PORTS {
        assert!(
            !port_env
                .values()
                .any(|claimed| claimed == &port.to_string()),
            "allocator handed out Kanna's own port {port}",
        );
    }
}

#[test]
fn repo_definitions_pin_all_repo_owned_resources_to_remote_default_branch() {
    let temp = tempfile::tempdir().expect("create repo definitions fixture");
    let origin = temp.path().join("origin.git");
    let publisher = temp.path().join("publisher");
    let consumer = temp.path().join("consumer");

    run_git_fixture(
        temp.path(),
        &[
            "init",
            "--bare",
            "--initial-branch=dev",
            origin.to_str().unwrap(),
        ],
    );
    run_git_fixture(
        temp.path(),
        &[
            "clone",
            origin.to_str().unwrap(),
            publisher.to_str().unwrap(),
        ],
    );
    run_git_fixture(&publisher, &["config", "user.email", "test@example.com"]);
    run_git_fixture(&publisher, &["config", "user.name", "Kanna Test"]);

    std::fs::create_dir_all(publisher.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(publisher.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        publisher.join(".kanna/config.json"),
        serde_json::json!({
            "workflow": "remote-qa",
            "setup": ["REMOTE_SETUP"],
            "teardown": ["REMOTE_TEARDOWN"],
            "test": ["REMOTE_TEST"],
            "ports": {"REMOTE_PORT": 45123},
            "flavors": {"review": "REMOTE_FLAVOR"},
            "vars": {"REMOTE_VAR": "REMOTE_VARS"},
            "reserved_ports": [45124],
            "reserved_port_offsets": [17],
            "stage_order": ["remote review", "remote post"],
            "workspace": {
                "env": {"REMOTE_ENV": "REMOTE_WORKSPACE_ENV"},
                "path": {
                    "prepend": ["REMOTE_PREPEND"],
                    "append": ["REMOTE_APPEND"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/workflows/remote-qa.json"),
        serde_json::json!({
            "name": "remote-qa",
            "description": "REMOTE_WORKFLOW description",
            "stages": [{
                "name": "remote review",
                "description": "REMOTE_WORKFLOW stage description",
                "agent": "review",
                "prompt": "REMOTE_WORKFLOW",
                "policy": {"transition": "manual"},
                "post": {
                    "name": "remote post",
                    "description": "REMOTE_WORKFLOW post description",
                    "agent": "review",
                    "prompt": "REMOTE_WORKFLOW post"
                }
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/agents/review/AGENT.md"),
        "---\nname: remote-review\ndescription: REMOTE_AGENT base description\nagent_provider:\n  - codex\n  - claude\nmodel: remote-model\npermission_mode: dontAsk\nallowed_tools:\n  - Read\n---\nREMOTE_AGENT base body\n",
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/agents/review/EXTEND.md"),
        "---\nname: forbidden-extension-rename\ndescription: REMOTE_EXTENSION description\nagent_provider: copilot\nmodel: extension-model\npermission_mode: acceptEdits\nallowed_tools:\n  - Bash\n---\nREMOTE_EXTENSION body\n",
    )
    .unwrap();

    run_git_fixture(&publisher, &["add", ".kanna"]);
    run_git_fixture(&publisher, &["commit", "-m", "publish remote definitions"]);
    let revision = run_git_fixture(&publisher, &["rev-parse", "HEAD"]);
    run_git_fixture(&publisher, &["push", "-u", "origin", "dev"]);
    run_git_fixture(
        temp.path(),
        &[
            "clone",
            origin.to_str().unwrap(),
            consumer.to_str().unwrap(),
        ],
    );

    for relative_path in [
        ".kanna/config.json",
        ".kanna/workflows/remote-qa.json",
        ".kanna/agents/review/AGENT.md",
        ".kanna/agents/review/EXTEND.md",
    ] {
        std::fs::write(consumer.join(relative_path), "LOCAL_SENTINEL").unwrap();
    }

    let repo = Repo {
        id: "repo-remote-definitions".to_string(),
        path: consumer.to_string_lossy().into_owned(),
        name: "Remote definitions".to_string(),
        default_branch: Some("dev".to_string()),
        remote_url_hash: None,
        hidden: None,
        sort_order: None,
        created_at: None,
        last_opened_at: None,
    };
    let definitions = RepoDefinitions::resolve(&repo).expect("resolve remote definitions");

    assert_eq!(definitions.ref_name(), "origin/dev");
    assert_eq!(definitions.revision(), Some(revision.as_str()));

    std::fs::write(
        publisher.join(".kanna/config.json"),
        serde_json::json!({
            "workflow": "remote-qa-v2",
            "setup": ["REMOTE_SETUP_V2"],
            "test": ["REMOTE_TEST_V2"],
            "flavors": {"review": "REMOTE_FLAVOR_V2"},
            "workspace": {
                "env": {"REMOTE_ENV": "REMOTE_WORKSPACE_ENV_V2"}
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/workflows/remote-qa.json"),
        serde_json::json!({
            "name": "remote-qa-v2",
            "description": "REMOTE_WORKFLOW_V2 description",
            "stages": [{
                "name": "remote review v2",
                "description": "REMOTE_WORKFLOW_V2 stage description",
                "agent": "review",
                "prompt": "REMOTE_WORKFLOW_V2",
                "policy": {"transition": "manual"},
                "post": {
                    "name": "remote post v2",
                    "description": "REMOTE_WORKFLOW_V2 post description",
                    "agent": "review",
                    "prompt": "REMOTE_WORKFLOW_V2 post"
                }
            }]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/agents/review/AGENT.md"),
        "---\nname: remote-review-v2\ndescription: REMOTE_AGENT_V2 base description\nagent_provider: claude\nmodel: remote-model-v2\npermission_mode: default\nallowed_tools:\n  - Read\n---\nREMOTE_AGENT_V2 base body\n",
    )
    .unwrap();
    std::fs::write(
        publisher.join(".kanna/agents/review/EXTEND.md"),
        "---\ndescription: REMOTE_EXTENSION_V2 description\nagent_provider: codex\nmodel: extension-model-v2\npermission_mode: dontAsk\nallowed_tools:\n  - Bash\n  - Read\n---\nREMOTE_EXTENSION_V2 body\n",
    )
    .unwrap();
    run_git_fixture(&publisher, &["add", ".kanna"]);
    run_git_fixture(
        &publisher,
        &["commit", "-m", "publish remote definitions v2"],
    );
    let revision_v2 = run_git_fixture(&publisher, &["rev-parse", "HEAD"]);
    run_git_fixture(&publisher, &["push", "origin", "dev"]);

    assert_ne!(revision_v2, revision);
    assert_eq!(definitions.revision(), Some(revision.as_str()));

    let config = definitions.config();
    assert_eq!(config.workflow.as_deref(), Some("remote-qa"));
    assert_eq!(
        string_values(config.setup.as_deref()),
        Some(vec!["REMOTE_SETUP"])
    );
    assert_eq!(
        string_values(config.teardown.as_deref()),
        Some(vec!["REMOTE_TEARDOWN"])
    );
    assert_eq!(
        string_values(config.test.as_deref()),
        Some(vec!["REMOTE_TEST"])
    );
    assert_eq!(
        config
            .ports
            .as_ref()
            .and_then(|ports| ports.get("REMOTE_PORT")),
        Some(&45123)
    );
    assert_eq!(
        config
            .flavors
            .as_ref()
            .and_then(|flavors| flavors.get("review"))
            .map(String::as_str),
        Some("REMOTE_FLAVOR")
    );
    assert_eq!(
        config
            .vars
            .as_ref()
            .and_then(|vars| vars.get("REMOTE_VAR"))
            .map(String::as_str),
        Some("REMOTE_VARS")
    );
    assert_eq!(config.reserved_ports, vec![45124]);
    assert_eq!(config.reserved_port_offsets, vec![17]);
    assert_eq!(
        string_values(config.stage_order.as_deref()),
        Some(vec!["remote review", "remote post"])
    );
    let workspace = config.workspace.as_ref().expect("workspace config");
    assert_eq!(
        workspace
            .env
            .as_ref()
            .and_then(|env| env.get("REMOTE_ENV"))
            .map(String::as_str),
        Some("REMOTE_WORKSPACE_ENV")
    );
    assert_eq!(
        string_values(workspace.path.as_ref().unwrap().prepend.as_deref()),
        Some(vec!["REMOTE_PREPEND"])
    );
    assert_eq!(
        string_values(workspace.path.as_ref().unwrap().append.as_deref()),
        Some(vec!["REMOTE_APPEND"])
    );

    let workflow = definitions.workflow("remote-qa").unwrap();
    assert_eq!(workflow.name.as_deref(), Some("remote-qa"));
    assert_eq!(
        workflow.description.as_deref(),
        Some("REMOTE_WORKFLOW description")
    );
    assert_eq!(
        workflow.stages[0].description.as_deref(),
        Some("REMOTE_WORKFLOW stage description")
    );
    assert_eq!(
        workflow.stages[0].prompt.as_deref(),
        Some("REMOTE_WORKFLOW")
    );
    assert_eq!(
        workflow.stages[0]
            .post
            .as_ref()
            .and_then(|post| post.description.as_deref()),
        Some("REMOTE_WORKFLOW post description")
    );

    let agent = definitions.agent("review").unwrap();
    assert_eq!(agent.name, "remote-review");
    assert_eq!(agent.description, "REMOTE_EXTENSION description");
    assert_eq!(agent.agent_providers, vec!["copilot"]);
    assert_eq!(agent.model.as_deref(), Some("extension-model"));
    assert_eq!(agent.permission_mode.as_deref(), Some("acceptEdits"));
    assert_eq!(agent.allowed_tools, vec!["Bash"]);
    assert_eq!(
        agent.prompt,
        "REMOTE_AGENT base body\n\nREMOTE_EXTENSION body"
    );

    let all_wire_values = format!(
        "{}\n{}\n{}",
        serde_json::to_string(config).unwrap(),
        serde_json::to_string(&workflow).unwrap(),
        serde_json::to_string(&agent).unwrap(),
    );
    assert!(!all_wire_values.contains("LOCAL_SENTINEL"));

    let definitions_v2 = RepoDefinitions::resolve(&repo).expect("resolve updated definitions");
    assert_eq!(definitions_v2.ref_name(), "origin/dev");
    assert_eq!(definitions_v2.revision(), Some(revision_v2.as_str()));
    assert_ne!(definitions_v2.revision(), definitions.revision());
    assert_eq!(
        definitions_v2.config().workflow.as_deref(),
        Some("remote-qa-v2")
    );
    assert_eq!(
        string_values(definitions_v2.config().setup.as_deref()),
        Some(vec!["REMOTE_SETUP_V2"])
    );
    assert_eq!(
        definitions_v2
            .config()
            .workspace
            .as_ref()
            .and_then(|workspace| workspace.env.as_ref())
            .and_then(|env| env.get("REMOTE_ENV"))
            .map(String::as_str),
        Some("REMOTE_WORKSPACE_ENV_V2")
    );

    let workflow_v2 = definitions_v2.workflow("remote-qa").unwrap();
    assert_eq!(workflow_v2.name.as_deref(), Some("remote-qa-v2"));
    assert_eq!(
        workflow_v2.description.as_deref(),
        Some("REMOTE_WORKFLOW_V2 description")
    );
    assert_eq!(
        workflow_v2.stages[0].prompt.as_deref(),
        Some("REMOTE_WORKFLOW_V2")
    );
    assert_eq!(
        workflow_v2.stages[0]
            .post
            .as_ref()
            .and_then(|post| post.description.as_deref()),
        Some("REMOTE_WORKFLOW_V2 post description")
    );

    let agent_v2 = definitions_v2.agent("review").unwrap();
    assert_eq!(agent_v2.name, "remote-review-v2");
    assert_eq!(agent_v2.description, "REMOTE_EXTENSION_V2 description");
    assert_eq!(agent_v2.agent_providers, vec!["codex"]);
    assert_eq!(agent_v2.model.as_deref(), Some("extension-model-v2"));
    assert_eq!(agent_v2.permission_mode.as_deref(), Some("dontAsk"));
    assert_eq!(agent_v2.allowed_tools, vec!["Bash", "Read"]);
    assert_eq!(
        agent_v2.prompt,
        "REMOTE_AGENT_V2 base body\n\nREMOTE_EXTENSION_V2 body"
    );
}

#[test]
fn missing_remote_custom_definitions_fall_back_only_to_compiled_builtins() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-compiled-only");
    publish_origin_main(&repo_root, "publish empty definition source");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    assert_eq!(
        definitions.workflow("no-review").unwrap().name.as_deref(),
        Some("no-review")
    );
    assert_eq!(definitions.agent("review").unwrap().name, "review");

    let workflow_error = definitions.workflow("remote-only").unwrap_err();
    assert!(
        workflow_error.contains("compiled resource not found")
            && workflow_error.contains(".kanna/workflows/remote-only.json"),
        "{workflow_error}"
    );
    let agent_error = definitions.agent("remote-only").unwrap_err();
    assert!(
        agent_error.contains("compiled resource not found")
            && agent_error.contains(".kanna/agents/remote-only/AGENT.md"),
        "{agent_error}"
    );

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn builtin_dispatch_definitions_resolve_from_compiled_resources() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-dispatch-builtins");
    publish_origin_main(&repo_root, "publish empty dispatch definition source");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let dispatch = definitions.workflow("specialized-reviewers").unwrap();
    assert_eq!(dispatch.name.as_deref(), Some("specialized-reviewers"));
    let review = dispatch
        .stages
        .iter()
        .find(|stage| stage.name == "review")
        .expect("specialized-reviewers review stage");
    assert_eq!(review.agent.as_deref(), Some("qa-dispatcher"));
    assert_eq!(review.policy.transition, WorkflowStageTransition::Auto);

    let specialty = definitions.workflow("specialty-review").unwrap();
    assert_eq!(specialty.stages.len(), 1);
    let stage = &specialty.stages[0];
    assert_eq!(stage.name, "review");
    assert!(
        stage.agent.is_none(),
        "the dispatcher binds the specialty agent at task creation"
    );
    // Manual: both verdicts park the child unread — never auto-close — so
    // the dispatcher uniformly collects the verdict and closes every child.
    assert_eq!(stage.policy.transition, WorkflowStageTransition::Manual);

    let consultation = definitions.workflow("architect-consultation").unwrap();
    assert_eq!(consultation.stages.len(), 1);
    let consultation_stage = &consultation.stages[0];
    assert_eq!(consultation_stage.name, "consultation");
    assert_eq!(consultation_stage.agent.as_deref(), Some("architect"));
    assert_eq!(
        consultation_stage.policy.transition,
        WorkflowStageTransition::Manual
    );

    for agent_name in [
        "architect",
        "qa-dispatcher",
        "review-ui",
        "review-security",
        "review-perf",
        "review-concurrency",
        "review-migration",
        "review-compat",
    ] {
        assert_eq!(definitions.agent(agent_name).unwrap().name, agent_name);
    }

    // review-release is a Kanna repo-local specialty, not a compiled
    // builtin: without a repo file it must not resolve.
    let release_error = definitions.agent("review-release").unwrap_err();
    assert!(
        release_error.contains("compiled resource not found"),
        "{release_error}"
    );

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn legacy_builtin_workflow_names_still_resolve_for_committed_repo_config() {
    // `default`, `qa`, and `qa-dispatch` shipped as built-ins before the
    // lineup was renamed by review depth. A repo that committed a config
    // selecting one of them must keep resolving after upgrading, without the
    // retired name reappearing as a choice.
    for (legacy, current, review_agent) in [
        ("default", "no-review", None),
        ("qa", "single-reviewer", Some("review")),
        (
            "qa-dispatch",
            "specialized-reviewers",
            Some("qa-dispatcher"),
        ),
    ] {
        let repo_root =
            init_git_repo_without_provider_fixtures(&format!("definitions-legacy-{legacy}"));
        std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::json!({ "workflow": legacy }).to_string(),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish legacy workflow selection");

        let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

        // The repo's committed selection still resolves...
        assert_eq!(definitions.config().workflow.as_deref(), Some(legacy));
        let resolved = definitions
            .workflow(legacy)
            .unwrap_or_else(|error| panic!("legacy `{legacy}` must resolve: {error}"));

        // ...to the current definition, which reports its own current name so
        // the task records which workflow it actually got.
        assert_eq!(resolved.name.as_deref(), Some(current));
        let review = resolved.stages.iter().find(|stage| stage.name == "review");
        match review_agent {
            Some(review_agent) => assert_eq!(
                review
                    .unwrap_or_else(|| panic!("`{current}` must have a review stage"))
                    .agent
                    .as_deref(),
                Some(review_agent)
            ),
            None => assert!(review.is_none(), "`{current}` must not have a review stage"),
        }

        // The retired name stays out of the user-facing manifest.
        let names = definitions.workflow_names().unwrap();
        assert!(
            !names.contains(&legacy.to_string()),
            "`{legacy}` must not be offered as a choice; got {names:?}"
        );
        assert_eq!(
            names,
            vec!["no-review", "single-reviewer", "specialized-reviewers"]
        );

        let _ = std::fs::remove_dir_all(repo_root);
    }
}

#[test]
fn internal_builtin_workflows_resolve_without_being_offered_as_a_choice() {
    // `specialty-review` is the single-stage workflow `qa-dispatcher` binds for
    // every child task it fans out. It is one character away from the
    // `specialized-reviewers` workflow an operator picks, so offering both in
    // the picker is an invitation to pick the wrong one — but the name must
    // still resolve, or dispatch breaks.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-internal-workflow");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    publish_origin_main(&repo_root, "publish repo without workflows");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let names = definitions.workflow_names().unwrap();
    for internal in ["architect-consultation", "specialty-review"] {
        assert!(
            !names.contains(&internal.to_string()),
            "internal built-in `{internal}` must not be offered as a choice; got {names:?}"
        );
        let resolved = definitions
            .workflow(internal)
            .unwrap_or_else(|error| panic!("internal built-in `{internal}` must resolve: {error}"));
        assert_eq!(resolved.name.as_deref(), Some(internal));
        assert_eq!(resolved.visibility, DefinitionVisibility::Internal);
    }

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn a_repo_file_shadowing_an_internal_builtin_workflow_declares_its_own_visibility() {
    // Visibility comes from the effective definition, and a repo file wins
    // over the bundled one — visibility included. A repo that re-declares
    // `"visibility": "internal"` customizes what the dispatcher's children run
    // without promoting the name; a repo that omits the field has deliberately
    // made the name a public choice.
    for (label, visibility, expect_listed) in [
        ("re-declared internal", Some("internal"), false),
        ("omitted (deliberate promotion)", None, true),
    ] {
        let repo_root = init_git_repo_without_provider_fixtures(&format!(
            "definitions-internal-shadow-{}",
            if expect_listed { "public" } else { "internal" }
        ));
        std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
        let mut definition = serde_json::json!({
            "name": "specialty-review",
            "stages": [{
                "name": "review",
                "prompt": "REPO_SPECIALTY_REVIEW",
                "policy": {"transition": "manual"}
            }]
        });
        if let Some(visibility) = visibility {
            definition["visibility"] = serde_json::json!(visibility);
        }
        std::fs::write(
            repo_root.join(".kanna/workflows/specialty-review.json"),
            definition.to_string(),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish repo-authored specialty review");

        let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

        let names = definitions.workflow_names().unwrap();
        assert_eq!(
            names.contains(&"specialty-review".to_string()),
            expect_listed,
            "{label}: got {names:?}"
        );
        let resolved = definitions.workflow("specialty-review").unwrap();
        assert_eq!(
            resolved.stages[0].prompt.as_deref(),
            Some("REPO_SPECIALTY_REVIEW"),
            "{label}: the repo's own definition must still win over the bundled one"
        );

        let _ = std::fs::remove_dir_all(repo_root);
    }
}

#[test]
fn a_repo_authored_workflow_declaring_internal_visibility_is_unlisted_but_resolvable() {
    // The mechanism is not reserved for built-ins: a repo workflow bound by
    // the repo's own orchestration can keep itself out of the picker.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-repo-internal-workflow");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/orchestrated-child.json"),
        serde_json::json!({
            "name": "orchestrated-child",
            "visibility": "internal",
            "stages": [{
                "name": "review",
                "prompt": "REPO_CHILD_REVIEW",
                "policy": {"transition": "manual"}
            }]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo-internal workflow");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let names = definitions.workflow_names().unwrap();
    assert!(
        !names.contains(&"orchestrated-child".to_string()),
        "internal repo workflow must not be offered; got {names:?}"
    );
    let resolved = definitions.workflow("orchestrated-child").unwrap();
    assert_eq!(
        resolved.stages[0].prompt.as_deref(),
        Some("REPO_CHILD_REVIEW")
    );
    assert_eq!(resolved.visibility, DefinitionVisibility::Internal);

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn internal_builtin_agents_are_unlisted_but_resolve_by_name() {
    // Kanna binds `commit` and `approve` as stage posts and `architect` from
    // the purpose-built consultation workflow. Their AGENT.md frontmatter
    // declares `visibility: internal`, so `agents()` omits them while their
    // owning workflow bindings keep resolving them by name.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-internal-agents");
    publish_origin_main(&repo_root, "publish repo without agents");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let listed = definitions.agents().unwrap();
    let listed_names = listed
        .iter()
        .map(|agent| agent.name.as_str())
        .collect::<Vec<_>>();
    for internal in ["architect", "commit", "approve"] {
        assert!(
            !listed_names.contains(&internal),
            "`{internal}` must not be offered as a choice; got {listed_names:?}"
        );
        let resolved = definitions
            .agent(internal)
            .unwrap_or_else(|error| panic!("`{internal}` must still resolve by name: {error}"));
        assert_eq!(resolved.name, internal);
        assert_eq!(resolved.visibility, DefinitionVisibility::Internal);
    }
    // The specialty reviewers are genuinely dual-use and stay public.
    for public in ["implement", "review", "review-security"] {
        assert!(
            listed_names.contains(&public),
            "`{public}` must stay listed; got {listed_names:?}"
        );
    }

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn extension_layering_keeps_or_overrides_the_base_agent_visibility() {
    // EXTEND.md follows the same replace-when-present rule as every other
    // frontmatter field: an extension that says nothing about visibility
    // customizes the internal built-in without promoting it, and one that
    // declares `visibility: public` deliberately puts the name on offer.
    for (label, frontmatter, expect_listed) in [
        ("silent extension keeps internal", "", false),
        (
            "extension promotes to public",
            "---\nvisibility: public\n---\n",
            true,
        ),
    ] {
        let repo_root = init_git_repo_without_provider_fixtures(&format!(
            "definitions-extend-visibility-{expect_listed}"
        ));
        let agent_dir = repo_root.join(".kanna/agents/commit");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("EXTEND.md"),
            format!("{frontmatter}Repo commit extension body."),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish commit extension");

        let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

        let listed = definitions
            .agents()
            .unwrap()
            .iter()
            .any(|agent| agent.name == "commit");
        assert_eq!(listed, expect_listed, "{label}");
        let resolved = definitions.agent("commit").unwrap();
        assert!(
            resolved.prompt.ends_with("Repo commit extension body."),
            "{label}: the extension body must still layer on"
        );

        let _ = std::fs::remove_dir_all(repo_root);
    }
}

#[test]
fn a_repo_agent_declaring_internal_visibility_is_unlisted_but_resolvable() {
    // A repo override replaces the built-in wholesale, visibility included —
    // so a repo commit override that omits the field is a public choice, and
    // a repo-authored agent can keep itself out of the listing entirely.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-repo-internal-agent");
    for (name, visibility) in [("commit", None), ("repo-orchestrator", Some("internal"))] {
        let agent_dir = repo_root.join(format!(".kanna/agents/{name}"));
        std::fs::create_dir_all(&agent_dir).unwrap();
        let visibility_line = visibility
            .map(|visibility| format!("visibility: {visibility}\n"))
            .unwrap_or_default();
        std::fs::write(
            agent_dir.join("AGENT.md"),
            format!("---\nname: {name}\ndescription: Repo {name}\n{visibility_line}---\nBody."),
        )
        .unwrap();
    }
    publish_origin_main(&repo_root, "publish repo agents");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let listed_names = definitions
        .agents()
        .unwrap()
        .into_iter()
        .map(|agent| agent.name)
        .collect::<Vec<_>>();
    assert!(
        listed_names.contains(&"commit".to_string()),
        "a repo override omitting visibility is a deliberate public choice; got {listed_names:?}"
    );
    assert!(
        !listed_names.contains(&"repo-orchestrator".to_string()),
        "a repo-authored internal agent must stay unlisted; got {listed_names:?}"
    );
    let resolved = definitions.agent("repo-orchestrator").unwrap();
    assert_eq!(resolved.visibility, DefinitionVisibility::Internal);

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn agent_frontmatter_rejects_an_unknown_visibility_value() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-bad-visibility");
    let agent_dir = repo_root.join(".kanna/agents/oddball");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: oddball\ndescription: Bad visibility\nvisibility: hidden\n---\nBody.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish agent with bad visibility");

    let error = resolve_test_agent_definition(&repo_root, "oddball").unwrap_err();
    assert!(
        error.contains("visibility must be one of: public, internal"),
        "{error}"
    );

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn a_malformed_repo_workflow_file_stays_listed_instead_of_erroring_the_listing() {
    // Reading visibility means parsing every file, but the listing must not
    // fail — or silently drop a name — because one repo workflow is broken.
    // The name stays listed with the public default, and the parse error
    // surfaces on that workflow's own resolution.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-malformed-workflow");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/broken.json"),
        "{ this is not json",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish malformed workflow");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let names = definitions.workflow_names().unwrap();
    assert!(
        names.contains(&"broken".to_string()),
        "malformed workflow must stay listed; got {names:?}"
    );
    let error = definitions.workflow("broken").unwrap_err();
    assert!(
        error.contains("invalid workflow definition"),
        "the parse error belongs to the workflow's own resolution: {error}"
    );

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn legacy_builtin_workflow_alias_yields_to_a_repo_authored_workflow_of_the_same_name() {
    // The alias is a compiled fallback, not an override: a repo that ships its
    // own `qa.json` must keep getting its own definition.
    let repo_root = init_git_repo_without_provider_fixtures("definitions-legacy-repo-authored");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/qa.json"),
        serde_json::json!({
            "name": "qa",
            "stages": [
                { "name": "in progress", "agent": "implement", "policy": { "transition": "manual" } }
            ]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo-authored qa workflow");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();
    let resolved = definitions.workflow("qa").unwrap();

    assert_eq!(resolved.name.as_deref(), Some("qa"));
    assert_eq!(
        resolved.stages.len(),
        1,
        "repo definition wins over the alias"
    );

    // A repo-authored workflow IS a user-facing choice, unlike the alias.
    assert!(definitions
        .workflow_names()
        .unwrap()
        .contains(&"qa".to_string()));

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn remote_workflow_tree_read_error_does_not_fall_back_to_compiled_default() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-workflow-tree");
    let workflow_path = repo_root.join(".kanna/workflows/default.json");
    std::fs::create_dir_all(&workflow_path).unwrap();
    std::fs::write(workflow_path.join("child.json"), "{}").unwrap();
    let revision = publish_origin_main(&repo_root, "publish workflow tree");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let error = definitions.workflow("default").unwrap_err();

    assert_remote_definition_error(&error, ".kanna/workflows/default.json", &revision);
    assert!(error.contains("not a blob"), "{error}");
    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn remote_workflow_manifest_blob_list_error_does_not_return_compiled_names() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-workflow-list-blob");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(repo_root.join(".kanna/workflows"), "not a tree").unwrap();
    let revision = publish_origin_main(&repo_root, "publish workflows blob");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let error = definitions.workflow_names().unwrap_err();

    assert_remote_definition_error(&error, ".kanna/workflows", &revision);
    assert!(error.contains("not a tree"), "{error}");
    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn local_only_committed_definitions_without_remote_tracking_ref_are_ignored() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-local-only");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/local-agent")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"workflow":"local-workflow","setup":["LOCAL_SENTINEL"]}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/local-workflow.json"),
        r#"{"name":"local-workflow","stages":[{"name":"local","transition":"manual"}]}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/local-agent/AGENT.md"),
        "---\nname: local-agent\ndescription: Local only\nagent_provider: claude\n---\nLOCAL_SENTINEL\n",
    )
    .unwrap();
    run_git_fixture(&repo_root, &["add", ".kanna"]);
    run_git_fixture(
        &repo_root,
        &["commit", "-m", "commit local-only definitions"],
    );

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    assert_eq!(definitions.ref_name(), "origin/main");
    assert_eq!(definitions.revision(), None);
    assert_eq!(
        serde_json::to_value(definitions.config()).unwrap(),
        serde_json::json!({})
    );
    assert!(definitions.workflow("local-workflow").is_err());
    assert!(definitions.agent("local-agent").is_err());
    assert_eq!(
        definitions.workflow("no-review").unwrap().name.as_deref(),
        Some("no-review")
    );
    assert_eq!(definitions.agent("review").unwrap().name, "review");

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn repo_config_normalization_matches_shared_parser_behavior() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-config-normalization");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    let cases = [
        (
            "invalid string arrays preserve valid siblings",
            serde_json::json!({
                "workflow": "qa",
                "setup": ["pnpm install"],
                "test": "must-be-an-array",
                "stage_order": ["review", 42]
            }),
            serde_json::json!({
                "workflow": "qa",
                "setup": ["pnpm install"]
            }),
        ),
        (
            "mixed maps and reserved ports retain valid entries",
            serde_json::json!({
                "ports": {"DEV_PORT": 1420, "BAD_PORT": "nope"},
                "flavors": {"pr": "draft", "merge": 42},
                "vars": {"TEAM": "platform", "COUNT": 3},
                "reserved_port_offsets": [0, "bad", -1, 1.5, 2],
                "reserved_ports": [5432, "bad", 0, 65536, 6379]
            }),
            serde_json::json!({
                "ports": {"DEV_PORT": 1420},
                "flavors": {"pr": "draft"},
                "vars": {"TEAM": "platform"},
                "reserved_port_offsets": [0, 2],
                "reserved_ports": [5432, 6379]
            }),
        ),
        (
            "workspace maps and path arrays filter entries independently",
            serde_json::json!({
                "workspace": {
                    "env": {"GOOD": "yes", "BAD": 42},
                    "path": {
                        "prepend": ["./bin", 1],
                        "append": "not-an-array"
                    }
                }
            }),
            serde_json::json!({
                "workspace": {
                    "env": {"GOOD": "yes"},
                    "path": {"prepend": ["./bin"]}
                }
            }),
        ),
        (
            "agent provider preferences normalize shorthand and filter malformed entries",
            serde_json::json!({
                "agentProviders": {
                    "review": "codex",
                    "review-*": {
                        "provider": ["codex", "claude"],
                        "model": "gpt-5"
                    },
                    "bad-type": 42,
                    "bad-provider-list": {"provider": ["codex", 42]}
                }
            }),
            serde_json::json!({
                "agentProviders": {
                    "review": {"provider": ["codex"]},
                    "review-*": {
                        "provider": ["codex", "claude"],
                        "model": "gpt-5"
                    }
                }
            }),
        ),
        (
            "valid optional arrays remain intact",
            serde_json::json!({
                "test": ["pnpm test", "cargo test"],
                "stage_order": ["review", "in progress"]
            }),
            serde_json::json!({
                "test": ["pnpm test", "cargo test"],
                "stage_order": ["review", "in progress"]
            }),
        ),
        (
            "non-object roots normalize to empty config",
            serde_json::json!(["not", "an", "object"]),
            serde_json::json!({}),
        ),
    ];

    for (name, input, expected) in cases {
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::to_string(&input).unwrap(),
        )
        .unwrap();
        publish_origin_main(&repo_root, name);

        let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main"))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            serde_json::to_value(definitions.config()).unwrap(),
            expected,
            "{name}"
        );
    }

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn malformed_remote_definitions_report_path_ref_and_revision_without_fallback() {
    let config_repo = init_git_repo_without_provider_fixtures("definitions-bad-config");
    std::fs::create_dir_all(config_repo.join(".kanna")).unwrap();
    std::fs::write(config_repo.join(".kanna/config.json"), "{").unwrap();
    let config_revision = publish_origin_main(&config_repo, "publish invalid config JSON");
    let config_error = RepoDefinitions::resolve(&definition_repo(&config_repo, "main"))
        .err()
        .expect("malformed remote config should fail");
    assert_remote_definition_error(&config_error, ".kanna/config.json", &config_revision);
    assert!(
        config_error.contains("invalid repo config"),
        "{config_error}"
    );
    assert!(config_error.contains("EOF"), "{config_error}");

    let workflow_repo = init_git_repo_without_provider_fixtures("definitions-bad-workflow");
    std::fs::create_dir_all(workflow_repo.join(".kanna/workflows")).unwrap();
    std::fs::write(workflow_repo.join(".kanna/workflows/default.json"), "{").unwrap();
    let workflow_revision = publish_origin_main(&workflow_repo, "publish malformed workflow");
    let workflow_definitions =
        RepoDefinitions::resolve(&definition_repo(&workflow_repo, "main")).unwrap();
    let workflow_error = workflow_definitions.workflow("default").unwrap_err();
    assert_remote_definition_error(
        &workflow_error,
        ".kanna/workflows/default.json",
        &workflow_revision,
    );

    let agent_repo = init_git_repo_without_provider_fixtures("definitions-bad-agent");
    std::fs::create_dir_all(agent_repo.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        agent_repo.join(".kanna/agents/review/AGENT.md"),
        "---\nname: review\ndescription: Broken remote review\npermission_mode: neverAsk\n---\nREMOTE_AGENT\n",
    )
    .unwrap();
    let agent_revision = publish_origin_main(&agent_repo, "publish malformed agent");
    let agent_definitions =
        RepoDefinitions::resolve(&definition_repo(&agent_repo, "main")).unwrap();
    let agent_error = agent_definitions.agent("review").unwrap_err();
    assert_remote_definition_error(
        &agent_error,
        ".kanna/agents/review/AGENT.md",
        &agent_revision,
    );

    let extension_repo = init_git_repo_without_provider_fixtures("definitions-bad-extension");
    std::fs::create_dir_all(extension_repo.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        extension_repo.join(".kanna/agents/review/EXTEND.md"),
        "---\npermission_mode: neverAsk\n---\nREMOTE_EXTENSION\n",
    )
    .unwrap();
    let extension_revision = publish_origin_main(&extension_repo, "publish malformed extension");
    let extension_definitions =
        RepoDefinitions::resolve(&definition_repo(&extension_repo, "main")).unwrap();
    let extension_error = extension_definitions.agent("review").unwrap_err();
    assert_remote_definition_error(
        &extension_error,
        ".kanna/agents/review/EXTEND.md",
        &extension_revision,
    );

    for repo_root in [config_repo, workflow_repo, agent_repo, extension_repo] {
        let _ = std::fs::remove_dir_all(repo_root);
    }
}

#[test]
fn remote_agent_requires_name_description_and_supported_permission_mode() {
    let cases = [
        (
            "missing-name",
            "---\ndescription: Has description\n---\nAgent body.\n",
            "name is required",
        ),
        (
            "missing-description",
            "---\nname: review\n---\nAgent body.\n",
            "description is required",
        ),
        (
            "invalid-permission",
            "---\nname: review\ndescription: Reviews code\npermission_mode: neverAsk\n---\nAgent body.\n",
            "permission_mode must be one of",
        ),
    ];

    for (label, content, expected) in cases {
        let repo_root = init_git_repo_without_provider_fixtures(&format!("agent-{label}"));
        std::fs::create_dir_all(repo_root.join(".kanna/agents/review")).unwrap();
        std::fs::write(repo_root.join(".kanna/agents/review/AGENT.md"), content).unwrap();
        let revision = publish_origin_main(&repo_root, "publish invalid agent");
        let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

        let error = definitions.agent("review").unwrap_err();
        assert!(error.contains(expected), "{label}: {error}");
        assert_remote_definition_error(&error, ".kanna/agents/review/AGENT.md", &revision);
        let _ = std::fs::remove_dir_all(repo_root);
    }
}

#[test]
fn workflow_names_are_sorted_deduped_remote_and_compiled_union() {
    let repo_root = init_git_repo_without_provider_fixtures("definition-workflow-names");
    let workflow_dir = repo_root.join(".kanna/workflows");
    std::fs::create_dir_all(workflow_dir.join("nested")).unwrap();
    for name in ["zeta.json", "alpha.json", "qa.json", "schema.json"] {
        std::fs::write(workflow_dir.join(name), "{}").unwrap();
    }
    std::fs::write(workflow_dir.join("README.md"), "not a workflow").unwrap();
    std::fs::write(workflow_dir.join("nested/hidden.json"), "{}").unwrap();
    publish_origin_main(&repo_root, "publish workflow names");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    assert_eq!(
        definitions.workflow_names().unwrap(),
        vec![
            "alpha",
            "no-review",
            "qa",
            "single-reviewer",
            "specialized-reviewers",
            "zeta"
        ]
    );
    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn extension_overrides_description_but_cannot_rename_base_agent() {
    let repo_root = init_git_repo_without_provider_fixtures("definition-extension-identity");
    let agent_dir = repo_root.join(".kanna/agents/review");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: base-review\ndescription: Base description\nagent_provider: claude\n---\nBase body.\n",
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "---\nname: attempted-rename\ndescription: Extension description\n---\nExtension body.\n",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish extended agent");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();
    let agent = definitions.agent("review").unwrap();

    assert_eq!(agent.name, "base-review");
    assert_eq!(agent.description, "Extension description");
    assert_eq!(agent.prompt, "Base body.\n\nExtension body.");
    let wire = serde_json::to_value(&agent).unwrap();
    assert_eq!(wire["agent_provider"], serde_json::json!(["claude"]));
    assert!(wire.get("agent_providers").is_none());
    assert!(wire.get("model").is_none());
    assert!(wire.get("permission_mode").is_none());
    assert!(wire.get("allowed_tools").is_none());

    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn stored_workflow_is_parsed_without_snapshot_resolution_and_preserves_descriptions() {
    let stored = serde_json::json!({
        "name": "stored",
        "description": "Stored workflow",
        "stages": [
            {
                "name": "work",
                "description": "Stored stage",
                "transition": "manual"
            },
            {
                "name": "commit",
                "description": "Stored folded post",
                "transition": "auto",
                "mode": "continue"
            }
        ]
    })
    .to_string();

    let workflow = super::super::definitions::parse_stored_workflow_definition(&stored).unwrap();

    assert_eq!(workflow.name.as_deref(), Some("stored"));
    assert_eq!(workflow.description.as_deref(), Some("Stored workflow"));
    assert_eq!(
        workflow.stages[0].description.as_deref(),
        Some("Stored stage")
    );
    assert_eq!(
        workflow.stages[0]
            .post
            .as_ref()
            .and_then(|post| post.description.as_deref()),
        Some("Stored folded post")
    );
}

fn write_agent_repo(label: &str, agent_md: &str, extend_md: Option<&str>) -> std::path::PathBuf {
    let repo_root = init_git_repo_without_provider_fixtures(&format!("agent-def-{label}"));
    let agent_dir = repo_root.join(".kanna/agents/reviewer");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(agent_dir.join("AGENT.md"), agent_md).unwrap();
    if let Some(extend_md) = extend_md {
        std::fs::write(agent_dir.join("EXTEND.md"), extend_md).unwrap();
    }
    publish_origin_main(&repo_root, "publish agent definition fixture");
    repo_root
}

const MALFORMED_AGENT_PROVIDER_CASES: &[(&str, &str, &str)] = &[
    (
        "mixed-array",
        "agent_provider:\n  - claude\n  - 7",
        "agent_provider must be a string or an array of strings",
    ),
    (
        "non-string-scalar",
        "agent_provider: 42",
        "agent_provider must be a string or an array of strings",
    ),
    (
        "null",
        "agent_provider: null",
        "agent_provider must be a string or an array of strings",
    ),
    (
        "empty-array",
        "agent_provider: []",
        "agent_provider must include at least one non-empty provider",
    ),
    (
        "blank-string",
        "agent_provider: \"   \"",
        "agent_provider must include at least one non-empty provider",
    ),
    (
        "unknown-provider",
        "agent_provider: future-agent",
        "unsupported agent provider: future-agent",
    ),
];

#[test]
fn read_agent_definition_rejects_malformed_provider_frontmatter() {
    for (label, yaml, expected) in MALFORMED_AGENT_PROVIDER_CASES {
        let agent_md = format!(
            "---\nname: reviewer\ndescription: Reviews changes\n{yaml}\n---\nAgent prompt."
        );
        let repo_root = write_agent_repo(label, &agent_md, None);

        let error = resolve_test_agent_definition(&repo_root, "reviewer")
            .err()
            .expect("malformed provider frontmatter should fail");

        assert!(
            error.contains(expected),
            "{label}: expected {error:?} to contain {expected:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn read_agent_extension_rejects_malformed_provider_frontmatter() {
    for (label, yaml, expected) in MALFORMED_AGENT_PROVIDER_CASES {
        let extension = format!("---\n{yaml}\n---\nExtended prompt.");
        let repo_root = write_agent_repo(
            &format!("extension-{label}"),
            "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\n---\nAgent prompt.",
            Some(&extension),
        );

        let error = resolve_test_agent_definition(&repo_root, "reviewer")
            .err()
            .expect("malformed provider extension should fail");

        assert!(
            error.contains(expected),
            "{label}: expected {error:?} to contain {expected:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn read_workflow_definition_rejects_malformed_provider_selections() {
    let cases = [
        ("empty-array", serde_json::json!([])),
        ("mixed-array", serde_json::json!(["claude", 7])),
        ("non-string-scalar", serde_json::json!(42)),
        ("null", serde_json::Value::Null),
        ("blank-string", serde_json::json!("")),
        ("unknown-provider", serde_json::json!("future-agent")),
    ];

    for (label, provider) in cases {
        let repo_root =
            init_git_repo_without_provider_fixtures(&format!("workflow-provider-{label}"));
        let workflow_dir = repo_root.join(".kanna/workflows");
        std::fs::create_dir_all(&workflow_dir).unwrap();
        std::fs::write(
            workflow_dir.join("qa.json"),
            serde_json::json!({
                "name": "qa",
                "stages": [{
                    "name": "in progress",
                    "transition": "manual",
                    "agent_provider": provider,
                }],
            })
            .to_string(),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish malformed workflow provider");

        let error = resolve_test_workflow_definition(&repo_root, "qa")
            .err()
            .expect("malformed workflow provider selection should fail");

        assert!(
            error.contains("agent_provider"),
            "{label}: expected provider-specific error, got {error:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn read_workflow_definition_rejects_legacy_csv_provider_selections() {
    for location in ["stage", "post", "post_action"] {
        let mut stage = serde_json::json!({
            "name": "in progress",
            "transition": "manual",
        });
        if location == "stage" {
            stage["agent_provider"] = serde_json::json!("codex,claude");
        } else {
            stage[location] = serde_json::json!({
                "name": "commit",
                "agent_provider": "codex,claude",
            });
        }

        let repo_root =
            init_git_repo_without_provider_fixtures(&format!("workflow-csv-provider-{location}"));
        let workflow_dir = repo_root.join(".kanna/workflows");
        std::fs::create_dir_all(&workflow_dir).unwrap();
        std::fs::write(
            workflow_dir.join("qa.json"),
            serde_json::json!({
                "name": "qa",
                "stages": [stage],
            })
            .to_string(),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish legacy CSV workflow provider");

        let error = resolve_test_workflow_definition(&repo_root, "qa")
            .err()
            .expect("live workflow definitions must reject legacy CSV providers");

        assert!(
            error.contains("agent_provider"),
            "{location}: expected provider-specific error, got {error:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn stored_workflow_definition_accepts_legacy_null_provider_and_omits_it_on_reserialize() {
    let snapshot = serde_json::json!({
        "name": "qa",
        "stages": [{
            "name": "in progress",
            "agent": null,
            "prompt": "$TASK_PROMPT",
            "agent_provider": null,
            "environment": null,
            "policy": { "transition": "manual" },
            "post": null,
        }],
        "environments": null,
    })
    .to_string();

    let workflow = super::super::definitions::parse_stored_workflow_definition(&snapshot)
        .expect("legacy durable workflow snapshots should remain readable");
    let serialized = serde_json::to_value(workflow).unwrap();

    assert!(serialized["stages"][0].get("agent_provider").is_none());
}

#[test]
fn stored_workflow_definition_normalizes_legacy_csv_and_preserves_provider_lists() {
    for post_key in ["post", "post_action"] {
        let mut stage = serde_json::json!({
            "name": "review",
            "agent": "review",
            "prompt": "$TASK_PROMPT",
            "agent_provider": "codex,claude",
            "environment": null,
            "policy": { "transition": "manual" },
        });
        stage[post_key] = serde_json::json!({
            "name": "commit",
            "agent": "commit",
            "prompt": null,
            "agent_provider": "codex,claude",
        });
        let snapshot = serde_json::json!({
            "name": "qa",
            "stages": [stage],
            "environments": null,
        })
        .to_string();

        let workflow = super::super::definitions::parse_stored_workflow_definition(&snapshot)
            .expect("durable workflow snapshots should remain readable");
        let serialized = serde_json::to_value(workflow).unwrap();

        assert_eq!(
            serialized["stages"][0]["agent_provider"],
            serde_json::json!(["codex", "claude"]),
            "{post_key} stage providers"
        );
        assert_eq!(
            serialized["stages"][0]["post"]["agent_provider"],
            serde_json::json!(["codex", "claude"]),
            "{post_key} providers"
        );
    }
}

#[test]
fn read_agent_definition_without_extension_keeps_base() {
    let repo_root = write_agent_repo(
        "no-extend",
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\nmodel: sonnet\n---\nBase prompt.",
        None,
    );

    let definition = resolve_test_agent_definition(&repo_root, "reviewer").unwrap();
    assert_eq!(definition.prompt, "Base prompt.");
    assert_eq!(definition.model.as_deref(), Some("sonnet"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_appends_extension_body_and_overrides_frontmatter() {
    let repo_root = write_agent_repo(
        "extend-override",
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\nmodel: sonnet\npermission_mode: default\n---\nBase prompt.",
        Some("---\nmodel: opus\npermission_mode: acceptEdits\nagent_provider: codex\n---\nRun the full suite."),
    );

    let definition = resolve_test_agent_definition(&repo_root, "reviewer").unwrap();
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
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\nallowed_tools:\n  - Bash\n  - Read\n---\nBase prompt.",
        Some("---\nallowed_tools: []\n---\nRun without tool restrictions."),
    );

    let definition = resolve_test_agent_definition(&repo_root, "reviewer").unwrap();
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
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\nmodel: sonnet\n---\nBase prompt.",
        Some("Repo-specific extra instructions."),
    );

    let definition = resolve_test_agent_definition(&repo_root, "reviewer").unwrap();
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
    let repo_root = init_git_repo_without_provider_fixtures("agent-builtin-extend");
    let agent_dir = repo_root.join(".kanna/agents/review");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "Repo rule: run the full unit and integration suites.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish builtin agent extension");

    let definition = resolve_test_agent_definition(&repo_root, "review").unwrap();
    assert!(definition.prompt.contains("QA review agent"));
    assert!(definition
        .prompt
        .ends_with("Repo rule: run the full unit and integration suites."));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn builtin_merge_agent_accepts_natural_language_open_pr_requests() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-builtin-merge-natural-language");

    let definition = resolve_test_agent_definition(&repo_root, "merge").unwrap();

    assert!(definition
        .prompt
        .contains("Natural-language messages delivered"));
    assert!(definition.prompt.contains("merge all open"));
    assert!(definition.prompt.contains("gh pr list"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_loads_builtin_setup_agent() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-builtin-setup");

    let definition = resolve_test_agent_definition(&repo_root, "setup").unwrap();

    assert!(definition.prompt.contains("GitHub flow"));
    assert!(definition
        .prompt
        .contains("Do not author new agents from scratch"));
    assert!(definition.prompt.contains("Machine-Local Config Bootstrap"));
    assert!(definition.prompt.contains(".kanna/config.local.json"));
    assert!(definition.prompt.contains(".kanna/sync-local-config.sh"));
    assert!(definition.prompt.contains("primary checkout → worktree"));
    assert!(definition.prompt.contains("kanna_complete_stage"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_loads_builtin_ship_agent_with_codex_first() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-builtin-ship");

    let definition = resolve_test_agent_definition(&repo_root, "ship").unwrap();

    assert_eq!(definition.name, "ship");
    assert_eq!(
        definition.agent_providers.first().map(String::as_str),
        Some("codex")
    );
    assert!(definition
        .prompt
        .contains("./kd release ship --staging --dry-run"));
    assert!(definition.prompt.contains("do not ask questions"));
    assert!(definition
        .prompt
        .contains("Production is never your decision"));
    assert!(definition.prompt.contains("Refuse `--production`"));
    assert!(definition
        .prompt
        .contains("explicitly identifies a named human"));
    assert!(definition.prompt.contains("git cherry-pick -x"));
    assert!(definition
        .prompt
        .contains("./kd release promote X.Y.Z-staging.N"));
    assert!(definition.prompt.contains("runtimeVersion"));
    assert!(definition.prompt.contains("Call `kanna_info`"));
    assert!(definition
        .prompt
        .contains("authoritative server environment/version"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_loads_builtin_task_manager_agent_with_codex_first() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-builtin-task-manager");

    let definition = resolve_test_agent_definition(&repo_root, "task-manager").unwrap();

    assert_eq!(definition.name, "task-manager");
    assert_eq!(
        definition.agent_providers.first().map(String::as_str),
        Some("codex")
    );
    assert!(definition.prompt.contains("kanna_wait_events"));
    assert!(definition
        .prompt
        .contains("If this task-manager instance is not running on the Claude provider"));
    assert!(definition
        .prompt
        .contains("never continuously re-arm an idle `kanna_wait_events` MCP call"));
    assert!(definition.prompt.contains("connection.effectiveBaseUrl"));
    assert!(definition.prompt.contains("serverStatus.desktop.id"));
    assert!(definition
        .prompt
        .contains("taskIds cursor is a multi-machine aggregate"));
    assert!(definition
        .prompt
        .contains("[\"repoId\", \"taskIds\", \"parentTaskId\"]"));
    assert!(definition
        .prompt
        .contains("url.searchParams.set(\"timeoutSecs\", String(timeoutSecs))"));
    assert!(definition.prompt.contains("Math.min(60, remainingSecs)"));
    assert!(definition
        .prompt
        .contains("new URL(`/v1/repos/${encodeURIComponent(repoId)}/tasks`, baseUrl)"));
    assert!(definition
        .prompt
        .contains("const requiredNonWorkingSamples = 3"));
    assert!(definition
        .prompt
        .contains("verify with kanna_get_task and the log tail"));
    assert!(definition
        .prompt
        .contains("untracked tasks are covered only by events and the heartbeat"));
    assert!(definition.prompt.contains("25 * 60 * 1000"));
    assert!(definition.prompt.contains("run_in_background: true"));
    assert!(definition
        .prompt
        .contains("response body rather than silently restarting"));
    assert!(definition.prompt.contains("task.awaiting_input"));
    assert!(definition.prompt.contains("task.activity_changed"));
    assert!(definition.prompt.contains("waitingPromptSnippet"));
    assert!(definition.prompt.contains("no_live_agent_session"));
    assert!(definition.prompt.contains("delivery_uncertain"));
    assert!(definition.prompt.contains("kanna_resume_task"));
    assert!(definition.prompt.contains(
        "Product work, bug fixes, investigations, releases, and other durable repository tasks"
    ));
    assert!(definition
        .prompt
        .contains("Do not set `parent_task_id` merely because you created"));
    assert!(definition
        .prompt
        .contains("the long-running manager is never a parent/owner bucket"));
    assert!(definition
        .prompt
        .contains("\"parent_task_id\": \"<durable-work-item-id>\""));
    assert!(definition.prompt.contains("purpose-built child workflows"));
    assert!(definition.prompt.contains("latestRun"));
    assert!(definition.prompt.contains("MERGEABLE"));
    assert!(definition.prompt.contains("git rebase --onto"));
    assert!(definition.prompt.contains("Ask it to `HOLD`"));
    assert!(definition.prompt.contains("payload.exhausted"));
    assert!(definition
        .prompt
        .contains("Audit Premise, Scope, And Runaway Work"));
    assert!(definition
        .prompt
        .contains("ask the agent for one concise re-report"));
    assert!(definition
        .prompt
        .contains("independent, bounded, on-demand architect consultation"));
    assert!(definition
        .prompt
        .contains("\"workflow_name\": \"architect-consultation\""));
    assert!(definition
        .prompt
        .contains("\"parent_task_id\": \"<assessed-durable-work-item-id>\""));
    assert!(definition.prompt.contains("Do not add an `agent` override"));
    assert!(definition.prompt.contains(
        "Kanna's current task and log surfaces do not expose a reliable universal token counter"
    ));
    assert!(definition
        .prompt
        .contains("Preserve branches and commits when retiring the old work"));
    assert!(definition
        .prompt
        .contains("Resolve the authoritative remote default-branch tip"));
    assert!(definition
        .prompt
        .contains("A bare local branch name is a possibly stale pointer"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_uses_explicit_builtin_flavor() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-explicit-flavor");

    let definition = resolve_test_agent_definition(&repo_root, "pr@push-only").unwrap();

    assert!(definition
        .prompt
        .contains("push the branch without creating a PR"));
    assert!(!definition.prompt.contains("gh pr create"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_uses_repo_config_flavor_map() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-config-flavor");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"merge":"git"}}"#,
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish configured agent flavor");

    let definition = resolve_test_agent_definition(&repo_root, "merge").unwrap();

    assert!(definition.prompt.contains("Git-only merge master"));
    assert!(!definition.prompt.contains("gh pr merge"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_prefers_repo_override_over_config_flavor() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-repo-over-config-flavor");
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"pr":"push-only"}}"#,
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: repo-pr\ndescription: Repo-owned PR agent\nagent_provider: claude\n---\nRepo-owned PR agent.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo agent over configured flavor");

    let definition = resolve_test_agent_definition(&repo_root, "pr").unwrap();

    assert_eq!(definition.prompt, "Repo-owned PR agent.");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_prefers_repo_override_over_explicit_flavor() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-repo-over-explicit-flavor");
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: repo-pr\ndescription: Repo-owned PR agent\nagent_provider: claude\n---\nRepo-owned PR agent.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo agent over explicit flavor");

    let definition = resolve_test_agent_definition(&repo_root, "pr@push-only").unwrap();

    assert_eq!(definition.prompt, "Repo-owned PR agent.");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_layers_role_extension_on_explicit_builtin_flavor() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-explicit-flavor-role-extend");
    let agent_dir = repo_root.join(".kanna/agents/pr");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "Repo rule: publish only after local CI passes.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish role extension over explicit flavor");

    let definition = resolve_test_agent_definition(&repo_root, "pr@push-only").unwrap();

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
    let repo_root = init_git_repo_without_provider_fixtures("agent-missing-config-flavor");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"flavors":{"pr":"missing-flavor"}}"#,
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish missing configured flavor");

    let definition = resolve_test_agent_definition(&repo_root, "pr").unwrap();

    assert!(definition.prompt.contains("create a GitHub pull request"));
    assert!(definition.prompt.contains("gh pr create"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn read_agent_definition_substitutes_repo_config_vars_in_agent_body() {
    let repo_root = init_git_repo_without_provider_fixtures("agent-config-vars");
    let agent_dir = repo_root.join(".kanna/agents/reviewer");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"vars":{"KANNA_TASK_ID":"config-task","MERGE_STRATEGY":"squash","REVIEW_TEAM":"platform"}}"#,
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: reviewer\ndescription: Reviews with repo variables\nagent_provider: claude\n---\nUse $MERGE_STRATEGY for ${REVIEW_TEAM}. Keep $BASE_REF and $KANNA_TASK_ID runtime-bound.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish agent variables fixture");

    // The agent body is returned raw: config-var substitution happens in the
    // single build_stage_prompt pass, never at definition-read time.
    let definition = resolve_test_agent_definition(&repo_root, "reviewer").unwrap();

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
            prev_main_result: None,
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
        "## Agent Instructions\n\nUse squash for platform. Keep origin/main and $KANNA_TASK_ID runtime-bound."
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
            prev_main_result: None,
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
        "## Agent Instructions\n\nSee $TASK_PROMPT for full context.\n\nTask: actual task prompt"
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
            prev_main_result: None,
            branch: None,
            base_ref: None,
            source_worktree: None,
            vars: None,
        },
    );

    assert_eq!(
        prompt,
        "## Agent Instructions\n\nPing $UNKNOWN_NAME and ${ALSO_UNKNOWN}."
    );
}

#[test]
fn build_stage_prompt_labels_agent_instructions_and_the_actual_task() {
    let prompt = build_stage_prompt(
        "Generic agent guidance.\n\n## Completion\nSummarize the work.",
        Some("$TASK_PROMPT"),
        &PromptContext {
            task_prompt: Some("Fix the buried task."),
            prev_result: None,
            prev_main_result: None,
            branch: None,
            base_ref: None,
            source_worktree: None,
            vars: None,
        },
    );
    assert_eq!(prompt, "## Agent Instructions\n\nGeneric agent guidance.\n\n## Completion\nSummarize the work.\n\n## Your Task\n\nFix the buried task.");
}

#[test]
fn build_stage_prompt_omits_empty_prompt_sections() {
    let context = PromptContext {
        task_prompt: Some("Ship it."),
        prev_result: None,
        prev_main_result: None,
        branch: None,
        base_ref: None,
        source_worktree: None,
        vars: None,
    };
    assert_eq!(
        build_stage_prompt(" \n\t", Some(" \n$TASK_PROMPT\t "), &context),
        "## Your Task\n\nShip it."
    );
    assert_eq!(
        build_stage_prompt(" \nFollow the review policy.\t ", Some("\n \t"), &context,),
        "## Agent Instructions\n\nFollow the review policy."
    );
    assert_eq!(build_stage_prompt("\n \t", Some(" \t\n"), &context), "");

    let empty_task_context = PromptContext {
        task_prompt: Some(""),
        ..context
    };
    assert_eq!(
        build_stage_prompt(
            "Follow the review policy.",
            Some("$TASK_PROMPT"),
            &empty_task_context,
        ),
        "## Agent Instructions\n\nFollow the review policy."
    );
}

#[test]
fn build_stage_prompt_replaces_base_ref() {
    let prompt = build_stage_prompt(
        "Review changes since $BASE_REF.",
        Some("Current branch $BRANCH."),
        &PromptContext {
            task_prompt: None,
            prev_result: None,
            prev_main_result: None,
            branch: Some("task-source"),
            base_ref: Some("origin/main"),
            source_worktree: Some("/tmp/repo/.kanna-worktrees/task-source"),
            vars: None,
        },
    );

    assert_eq!(
        prompt,
        "## Agent Instructions\n\nReview changes since origin/main.\n\n## Your Task\n\nCurrent branch task-source."
    );
}

#[test]
fn build_target_stage_prompt_sections_a_carried_task_without_rescanning_it() {
    let repo_root = init_git_repo_without_provider_fixtures("agentless-stage-prompt");
    publish_origin_main(&repo_root, "publish agentless prompt fixture");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();
    let stage = super::super::definitions::WorkflowStage {
        name: "gate".to_string(),
        description: None,
        agent: None,
        prompt: None,
        agent_provider: None,
        environment: None,
        policy: super::super::definitions::WorkflowStagePolicy {
            transition: WorkflowStageTransition::Manual,
            revision_transition: None,
        },
        post: None,
    };

    let prompt = super::super::prompt::build_target_stage_prompt(
        &definitions,
        &repo_root.to_string_lossy(),
        &stage,
        "Carry $PREV_RESULT literally.",
        Some("do not reveal"),
        None,
        None,
        None,
        None,
    )
    .unwrap();

    assert_eq!(prompt, "## Your Task\n\nCarry $PREV_RESULT literally.");
    let _ = std::fs::remove_dir_all(&repo_root);
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
fn resolve_agent_type_defaults_to_pty_but_allows_explicit_agent() {
    assert!(matches!(
        resolve_agent_type(None, AgentProvider::Opencode),
        Ok(AgentSessionType::Pty)
    ));
    assert!(matches!(
        resolve_agent_type(Some("agent"), AgentProvider::Opencode),
        Ok(AgentSessionType::Agent)
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
fn resolve_agent_type_rejects_headless_sessions_for_pty_only_providers() {
    for provider in [AgentProvider::Copilot, AgentProvider::Antigravity] {
        for agent_type in ["agent", "sdk", "chat"] {
            assert_eq!(
                resolve_agent_type(Some(agent_type), provider).unwrap_err(),
                format!("provider {provider} does not support headless agent sessions")
            );
        }
    }
}

#[test]
fn resolve_headless_agent_executable_defensively_rejects_pty_only_providers() {
    for provider in [AgentProvider::Copilot, AgentProvider::Antigravity] {
        assert_eq!(
            super::super::environment::resolve_headless_agent_executable(provider, None, "/tmp")
                .unwrap_err(),
            format!("provider {provider} does not support headless agent sessions")
        );
    }
}

#[test]
fn prepare_task_rejects_unsupported_headless_provider_before_persisting_state() {
    let repo_root = init_git_repo("unsupported-headless-provider");
    let config = test_config("unsupported-headless-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    for provider in ["copilot", "antigravity"] {
        let result = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: format!("Use {provider} headlessly"),
                display_name: None,
                workflow_name: None,
                stage: None,
                base_ref: None,
                agent: None,
                agent_provider: Some(provider.to_string()),
                agent_type: Some("agent".to_string()),
                terminal_cols: None,
                terminal_rows: None,
                model: None,
                effort: None,
                permission_mode: None,
                allowed_tools: None,
                disallowed_tools: None,
                max_turns: None,
                max_budget_usd: None,
                setup_cmds: None,
                task_template: None,
                resume_session_id: None,
                recovery_snapshot: None,
                transfer_import: None,
                blocker_task_ids: None,
                notify_task_id: None,
                parent_task_id: None,
            },
        );

        assert_eq!(
            result
                .err()
                .expect("PTY-only headless provider should fail"),
            format!("provider {provider} does not support headless agent sessions")
        );
        assert!(db.list_pipeline_items("repo-1").unwrap().is_empty());
        assert_eq!(db.count_test_worktrees_for_repo("repo-1").unwrap(), 0);
    }

    assert!(!repo_root.join(".kanna-worktrees").exists());
    let _ = std::fs::remove_dir_all(&repo_root);
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
        AgentProvider::Claude.executable(),
        "Review the branch.",
        None,
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
        "This session was launched by Kanna as task `task-123`, stage `review` of workflow `qa` (transition: `auto`)."
    ));
    assert!(!command.contains("{{TASK_CONTEXT}}"));
    assert!(!command.contains("{{MCP_STATUS}}"));
    assert!(command.contains("Claude is launched with this config via `--mcp-config`"));
    assert!(command.contains("kanna-cli guide"));
    assert!(!command.contains("kanna_info"));
    assert!(!command.contains("kanna-cli info"));
    assert!(!command.contains("authoritative server environment"));
    assert!(!command.contains("staging/production"));
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
    assert!(command.contains("record completion so Kanna can advance the workflow"));
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
    assert!(auto.contains("record completion so Kanna can advance the workflow"));
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
    assert!(manual.contains("recording a successful result does not advance the workflow"));
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
        AgentProvider::Antigravity.executable(),
        "Ship the task.",
        None,
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
        "mkdir -p '/tmp/kanna-antigravity-workspaces' && rm -f '/tmp/kanna-antigravity-workspaces/task-123' && ln -s '/tmp/repo/.kanna-worktrees/task-123' '/tmp/kanna-antigravity-workspaces/task-123' && 'agy' --dangerously-skip-permissions --add-dir '/tmp/kanna-antigravity-workspaces/task-123' --prompt-interactive '"
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
        AgentProvider::Codex.executable(),
        "Do work.",
        None,
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

    assert!(command.starts_with("'codex' "));
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
        AgentProvider::Copilot.executable(),
        "Do work.",
        None,
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

    assert!(command.starts_with("'copilot' "));
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
        AgentProvider::Opencode.executable(),
        "Do work.",
        None,
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
    assert!(command.contains("'Kanna preamble."));
    assert!(command.contains("Do work."));

    let _ = std::fs::remove_file(mcp_config);
}

/// `opencode run` streams plain text and exits when its first turn ends; only
/// the CLI's default command draws the TUI that `send-input`, stage posts,
/// revision resume and the transfer wrap-up all need a composer from.
#[test]
fn opencode_pty_command_launches_the_interactive_tui_not_a_one_shot_run() {
    let command = super::build_agent_command(
        &AgentProvider::Opencode,
        AgentProvider::Opencode.executable(),
        "Do work.",
        Some("opencode/big-pickle"),
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(
        command,
        "'opencode' --auto -m 'opencode/big-pickle' --prompt 'Do work.'"
    );
    assert!(!command.contains(" run "));
    assert!(!command.contains("--interactive"));
}

/// The TUI entrypoint takes one `[project]` positional and no `--variant`, so a
/// variant on the argv makes the CLI print usage and exit before drawing
/// anything. Effort has to travel in the config env var instead.
#[test]
fn opencode_pty_command_carries_effort_in_the_config_not_on_the_argv() {
    let command = super::build_agent_command(
        &AgentProvider::Opencode,
        AgentProvider::Opencode.executable(),
        "Do work.",
        Some("opencode/big-pickle"),
        Some("high"),
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert!(!command.contains("--variant"));
    assert!(command.contains(
        "\"agent\":{\"build\":{\"model\":\"opencode/big-pickle\",\"variant\":\"high\"}}"
    ));
    assert!(command.ends_with("--prompt 'Do work.'"));
}

/// A resumed OpenCode PTY session still has to come up as a TUI, or the
/// revision round it was reopened for has nothing to type into either — but the
/// TUI discards `--prompt` whenever it is also resuming a session, so the turn
/// is seeded by a headless `run` against the same session id first.
#[test]
fn opencode_pty_resume_seeds_the_turn_then_attaches_the_tui_to_the_same_session() {
    let session = ProviderSessionBinding::Resume("ses_123".to_string());
    let command = super::build_agent_command(
        &AgentProvider::Opencode,
        AgentProvider::Opencode.executable(),
        "Continue.",
        None,
        None,
        Some("dontAsk"),
        &[],
        &[],
        None,
        None,
        None,
        None,
        None,
        Some(&session),
    );

    assert_eq!(
        command,
        "'opencode' run --auto --session 'ses_123' 'Continue.'; \
         'opencode' --auto --session 'ses_123'"
    );
    // The session id is the same on both halves: the seeding turn extends the
    // conversation the TUI then attaches to, rather than forking a new one.
    assert_eq!(command.matches("--session 'ses_123'").count(), 2);
    // `--prompt` never appears on a resume: the TUI would drop it silently.
    assert!(!command.contains("--prompt"));
}

/// `--dangerously-skip-permissions` has dropped out of both `opencode --help`
/// and `opencode run --help` on 1.18.15; `--auto` is what they document. Every
/// permission mode has to produce a command that comes up, so all three are
/// walked rather than just the default.
#[test]
fn opencode_permission_modes_use_the_documented_bypass_spelling() {
    let build = |permission_mode: Option<&str>| {
        super::build_agent_command(
            &AgentProvider::Opencode,
            AgentProvider::Opencode.executable(),
            "Do work.",
            None,
            None,
            permission_mode,
            &[],
            &[],
            None,
            None,
            None,
            None,
            None,
            None,
        )
    };

    for mode in [None, Some("default"), Some("dontAsk")] {
        let command = build(mode);
        assert_eq!(
            command, "'opencode' --auto --prompt 'Do work.'",
            "permission mode {mode:?}"
        );
    }
    assert_eq!(build(Some("acceptEdits")), "'opencode' --prompt 'Do work.'");
    assert!(!build(None).contains("--dangerously-skip-permissions"));
}

#[test]
fn provider_resume_commands_use_each_cli_native_session_flag() {
    let session = ProviderSessionBinding::Resume("session-123".to_string());
    let build = |provider: AgentProvider| {
        super::build_agent_command(
            &provider,
            provider.executable(),
            "Continue.",
            None,
            None,
            Some("dontAsk"),
            &[],
            &[],
            None,
            None,
            Some("Kanna preamble."),
            None,
            None,
            Some(&session),
        )
    };

    assert!(build(AgentProvider::Claude).contains("--resume 'session-123'"));
    assert!(build(AgentProvider::Copilot).contains("--resume='session-123'"));
    assert!(build(AgentProvider::Codex).contains(" resume 'session-123' '"));
    assert!(build(AgentProvider::Opencode).contains("--session 'session-123'"));
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
    let _sidecar_guard = crate::test_sidecar_guard();
    let mut config = test_config("spawn-env-kanna-cli-path");
    let kanna_cli_sidecar = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp_sidecar = ensure_test_sidecar("kanna-mcp");
    config.kanna_cli_path = Some(kanna_cli_sidecar.path().to_string_lossy().to_string());
    let env = build_spawn_env(
        &config,
        "task-1",
        &HashMap::new(),
        "/tmp/worktree",
        &Default::default(),
    )
    .unwrap();
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
}

#[test]
fn prepare_task_defaults_to_pty_session_for_claude_and_codex() {
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
                workflow_name: None,
                stage: None,
                base_ref: None,
                agent: None,
                agent_provider: Some(provider.to_string()),
                agent_type: None,
                terminal_cols: None,
                terminal_rows: None,
                model: Some("model-a".to_string()),
                effort: None,
                permission_mode: Some("dontAsk".to_string()),
                allowed_tools: Some(vec!["Bash".to_string()]),
                disallowed_tools: None,
                max_turns: None,
                max_budget_usd: None,
                setup_cmds: None,
                task_template: None,
                resume_session_id: None,
                recovery_snapshot: None,
                transfer_import: None,
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
        assert!(matches!(
            prepared.session,
            PreparedSessionSpawn::Pty {
                cols: 80,
                rows: 24,
                ..
            }
        ));

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn resolve_requested_initial_terminal_geometry_requires_complete_positive_pair() {
    assert_eq!(
        resolve_initial_terminal_geometry(Some(80), Some(48)),
        Some((80, 48))
    );
    assert_eq!(resolve_initial_terminal_geometry(Some(80), None), None);
    assert_eq!(resolve_initial_terminal_geometry(None, Some(48)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(0), Some(48)), None);
    assert_eq!(resolve_initial_terminal_geometry(Some(80), Some(0)), None);
    assert_eq!(
        resolve_initial_terminal_geometry(Some(320), Some(256)),
        Some((320, 256))
    );
    assert_eq!(
        resolve_initial_terminal_geometry(Some(321), Some(256)),
        None
    );
    assert_eq!(
        resolve_initial_terminal_geometry(Some(320), Some(257)),
        None
    );
}

#[test]
fn prepare_task_uses_requested_initial_terminal_geometry() {
    let repo_root = init_git_repo("requested-initial-terminal-geometry");
    let config = test_config("requested-initial-terminal-geometry");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use requested geometry".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: Some(104),
            terminal_rows: Some(72),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert!(matches!(
        prepared.session,
        PreparedSessionSpawn::Pty {
            cols: 104,
            rows: 72,
            ..
        }
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_uses_default_initial_terminal_geometry_for_oversized_request() {
    let repo_root = init_git_repo("oversized-initial-terminal-geometry");
    let config = test_config("oversized-initial-terminal-geometry");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Reject oversized geometry".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: Some(321),
            terminal_rows: Some(256),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert!(matches!(
        prepared.session,
        PreparedSessionSpawn::Pty {
            cols: 80,
            rows: 24,
            ..
        }
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
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
        "---\nname: setup\ndescription: Sets up the repository\nagent_provider: codex\nmodel: gpt-5\npermission_mode: dontAsk\nallowed_tools:\n  - Bash\n---\nsetup agent prompt",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish create-request agent selector");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Set up Kanna for this repository.".to_string(),
            display_name: Some("Set Up Repository".to_string()),
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: Some("setup".to_string()),
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
fn prepare_task_named_agent_without_provider_uses_configured_default() {
    let repo_root = init_git_repo("create-request-agent-default-provider");
    let config = test_config("create-request-agent-default-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.set_test_setting("defaultAgentProvider", "copilot")
        .unwrap();

    let agent_dir = repo_root.join(".kanna/agents/ship");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: ship\ndescription: Ships the product\n---\nship agent prompt",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish provider-neutral named agent");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Ship this repository.".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: Some("ship".to_string()),
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert_eq!(prepared.stage_agent.as_deref(), Some("ship"));
    assert_eq!(prepared.agent_provider, "copilot");
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            assert!(args.join(" ").contains("ship agent prompt"));
        }
        _ => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_binds_specialty_agent_on_specialty_review_workflow() {
    // The QA dispatcher's fan-out path: a child task created on the builtin
    // single-stage `specialty-review` workflow, with the specialty agent
    // bound through the create request's `agent` override.
    let repo_root = init_git_repo("specialty-review-dispatch");
    let config = test_config("specialty-review-dispatch");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "parent-1",
        "repo-1",
        "parent task under review",
        None,
        "review",
        "2026-07-22 09:00:00",
    )
    .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Specialty review dispatched from task parent-1.".to_string(),
            display_name: Some("Security Review".to_string()),
            workflow_name: Some("specialty-review".to_string()),
            stage: None,
            base_ref: None,
            agent: Some("review-security".to_string()),
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: Some("parent-1".to_string()),
            parent_task_id: Some("parent-1".to_string()),
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert_eq!(prepared.created_task.stage, "review");
    assert_eq!(prepared.stage_agent.as_deref(), Some("review-security"));
    assert_eq!(
        prepared.completion_transition,
        WorkflowStageTransition::Manual
    );
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("specialty security review agent"));
            assert!(command.contains("Specialty review dispatched from task parent-1."));
        }
        _ => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_binds_bounded_architect_consultation_to_assessed_work_item() {
    let repo_root = init_git_repo("architect-consultation");
    let config = test_config("architect-consultation");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "work-item-1",
        "repo-1",
        "durable work item being assessed",
        None,
        "in progress",
        "2026-08-15 09:00:00",
    )
    .unwrap();
    db.insert_test_pipeline_item(
        "manager-1",
        "repo-1",
        "long-running task manager",
        None,
        "in progress",
        "2026-08-15 09:01:00",
    )
    .unwrap();

    let prompt = "Assess durable work item work-item-1.\nOriginal objective: preserve sessions across upgrades.\nDecision needed: choose the lifecycle owner.\nArtifact requested: none (advisory verdict only).";
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: prompt.to_string(),
            display_name: Some("Architect consultation: lifecycle owner".to_string()),
            workflow_name: Some("architect-consultation".to_string()),
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: Some("manager-1".to_string()),
            parent_task_id: Some("work-item-1".to_string()),
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert_eq!(prepared.created_task.stage, "consultation");
    assert_eq!(prepared.stage_agent.as_deref(), Some("architect"));
    assert_eq!(
        prepared.completion_transition,
        WorkflowStageTransition::Manual
    );
    let stored = db
        .get_pipeline_item(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.pipeline.as_deref(), Some("architect-consultation"));
    assert_eq!(stored.parent_task_id.as_deref(), Some("work-item-1"));
    assert_eq!(stored.notify_task_id.as_deref(), Some("manager-1"));
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("Kanna Architect"));
            assert!(command.contains("choose the lifecycle owner"));
            assert!(command.contains("Artifact requested: none"));
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: Some("opus".to_string()),
            effort: None,
            permission_mode: Some("acceptEdits".to_string()),
            allowed_tools: Some(vec!["Bash".to_string()]),
            disallowed_tools: Some(vec!["WebFetch".to_string()]),
            max_turns: Some(7),
            max_budget_usd: Some(1.5),
            setup_cmds: Some(vec![
                "printf 'custom setup' > .kanna/custom-setup-ran".to_string()
            ]),
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
    assert!(
        !std::path::Path::new(&prepared.cwd)
            .join(".kanna/custom-setup-ran")
            .exists(),
        "PTY setup must be deferred until the terminal starts"
    );
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("custom-setup-ran"));
            assert!(command.contains("Running startup..."));
            assert!(command.contains("--model 'opus'"));
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: Some(resume_session_id.to_string()),
            recovery_snapshot: None,
            transfer_import: None,
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
            assert!(!command.contains("kanna_info"));
            assert!(!command.contains("kanna-cli info"));
        }
        _ => panic!("expected pty spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_for_api_prints_transfer_import_summary_before_the_agent() {
    let repo_root = init_git_repo("create-transfer-import");
    let config = test_config("create-transfer-import");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Continue the transferred work".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: Some(crate::mobile_api::TransferImportSummary {
                source_machine: Some("Primary".to_string()),
                repo_mode: Some("bundle-repo".to_string()),
                session_restored: true,
            }),
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.last().expect("PTY command").clone();
            let banner_index = command
                .find("Imported transferred task")
                .expect("import banner");
            assert!(command.contains("source machine: Primary"));
            assert!(command.contains("repository: restored from a transferred git bundle"));
            assert!(command.contains("session history: restored"));
            assert!(!command.contains("kanna_info"));
            assert!(!command.contains("kanna-cli info"));
            let agent_index = command
                .find("--dangerously-skip-permissions")
                .expect("agent command");
            assert!(banner_index < agent_index, "command: {command}");
        }
        _ => panic!("expected pty spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_task_for_api_omits_the_import_banner_for_local_tasks() {
    let repo_root = init_git_repo("create-no-transfer-import");
    let config = test_config("create-no-transfer-import");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Do local work".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(!command.contains("Imported transferred task"), "{command}");
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: Some(104),
            terminal_rows: Some(72),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
    assert!(matches!(
        prepared.session,
        PreparedSessionSpawn::Agent { .. }
    ));
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
fn prepare_task_for_api_uses_requested_task_id() {
    let repo_root = init_git_repo("requested-task-id");
    let config = test_config("requested-task-id");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api_with_error(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Create with a requested id".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("0123456789abcdef".to_string()),
    )
    .unwrap();

    assert_eq!(prepared.task_id(), "0123456789abcdef");
    assert!(prepared.cwd.ends_with("/task-0123456789abcdef"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_dormant_task_for_api_uses_requested_task_id() {
    let repo_root = init_git_repo("dormant-requested-task-id");
    let config = test_config("dormant-requested-task-id");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Create a dormant task with a requested id".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("fedcba9876543210".to_string()),
    )
    .unwrap();

    assert_eq!(created.task_id, "fedcba9876543210");
    assert_eq!(created.worktree_path, None);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn dormant_start_preparation_rechecks_open_blockers() {
    let repo_root = init_git_repo("dormant-start-rechecks-blockers");
    let config = test_config("dormant-start-rechecks-blockers");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "Unresolved blocker",
        Some("Unresolved blocker"),
        "in progress",
        "2026-07-26 00:00:00",
    )
    .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Do not prepare while blocked".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("dependent-blocked".to_string()),
    )
    .unwrap();
    db.insert_task_blocker(&created.task_id, "blocker-1")
        .unwrap();

    let prepared = prepare_start_dormant_task_for_api(
        &db,
        &config,
        &created.task_id,
        vec!["main".to_string()],
    )
    .unwrap();

    assert!(
        prepared.is_none(),
        "a durable unresolved blocker must prevent worktree preparation"
    );
    assert!(db
        .get_task_worktree_path(&created.task_id)
        .unwrap()
        .is_none());

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn dormant_task_preserves_explicit_provider_and_model_until_spawn() {
    let repo_root = init_git_repo("dormant-model-spawn");
    let config = test_config("dormant-model-spawn");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Start with the requested Codex model".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("agent".to_string()),
            model: Some("gpt-5.6-codex".to_string()),
            effort: Some("xhigh".to_string()),
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("d0c0de12".to_string()),
    )
    .unwrap();
    let detail =
        crate::mobile_api::MobileApi::new(config.clone(), Db::open(&config.db_path).unwrap())
            .get_task(&created.task_id)
            .unwrap()
            .unwrap();
    assert_eq!(detail.agent_provider.as_deref(), Some("codex"));
    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-codex"));
    assert_eq!(detail.effort.as_deref(), Some("xhigh"));

    let prepared = prepare_start_dormant_task_for_api(&db, &config, &created.task_id, Vec::new())
        .unwrap()
        .expect("dormant task should become runnable");
    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model.as_deref(), Some("gpt-5.6-codex"));
    assert_eq!(prepared.effort.as_deref(), Some("xhigh"));
    match prepared.session {
        PreparedSessionSpawn::Agent { model, effort, .. } => {
            assert_eq!(model.as_deref(), Some("gpt-5.6-codex"));
            assert_eq!(effort.as_deref(), Some("xhigh"));
        }
        PreparedSessionSpawn::Pty { .. } => panic!("expected headless spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn dormant_task_composes_repo_preference_with_complete_persisted_spawn_options() {
    let repo_root = init_git_repo("dormant-repo-preference-spawn-options");
    let agent_dir = repo_root.join(".kanna/agents/dormant-review");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: dormant-review\ndescription: Reviews dormant tasks\nagent_provider: claude\nmodel: agent-model\n---\nReview the task.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            },
            "agentProviders": {
                "dormant-review": {
                    "provider": "codex",
                    "model": "repo-model"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish dormant spawn-option fixture");

    let config = test_config("dormant-repo-preference-spawn-options");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Start with repo preferences and stored spawn options".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: Some("dormant-review".to_string()),
            agent_provider: None,
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: Some("dontAsk".to_string()),
            allowed_tools: Some(vec!["Read".to_string(), "Bash".to_string()]),
            disallowed_tools: Some(vec!["WebFetch".to_string()]),
            max_turns: Some(9),
            max_budget_usd: Some(2.5),
            setup_cmds: Some(vec![
                "printf 'dormant setup' > .kanna/dormant-setup-ran".to_string()
            ]),
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("dependent-repo-spawn-options".to_string()),
    )
    .unwrap();

    let detail =
        crate::mobile_api::MobileApi::new(config.clone(), Db::open(&config.db_path).unwrap())
            .get_task(&created.task_id)
            .unwrap()
            .unwrap();
    assert_eq!(detail.agent_provider.as_deref(), Some("codex"));
    assert_eq!(detail.model.as_deref(), Some("repo-model"));

    let spawn_options: serde_json::Value = serde_json::from_str(
        db.get_test_pipeline_item_spawn_options(&created.task_id)
            .unwrap()
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(spawn_options["model"], "repo-model");
    assert_eq!(spawn_options["permissionMode"], "dontAsk");
    assert_eq!(
        spawn_options["allowedTools"],
        serde_json::json!(["Read", "Bash"])
    );
    assert_eq!(
        spawn_options["disallowedTools"],
        serde_json::json!(["WebFetch"])
    );
    assert_eq!(spawn_options["maxTurns"], 9);
    assert_eq!(spawn_options["maxBudgetUsd"], 2.5);

    let prepared = prepare_start_dormant_task_for_api(&db, &config, &created.task_id, Vec::new())
        .unwrap()
        .expect("dormant task should become runnable");
    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model.as_deref(), Some("repo-model"));
    assert!(std::path::Path::new(&prepared.cwd)
        .join(".kanna/dormant-setup-ran")
        .is_file());
    match prepared.session {
        PreparedSessionSpawn::Agent {
            agent_provider,
            model,
            permission_mode,
            allowed_tools,
            disallowed_tools,
            max_turns,
            max_budget_usd,
            ..
        } => {
            assert_eq!(agent_provider, DaemonAgentProvider::Codex);
            assert_eq!(model.as_deref(), Some("repo-model"));
            assert_eq!(permission_mode.as_deref(), Some("dontAsk"));
            assert_eq!(allowed_tools, ["Read".to_string(), "Bash".to_string()]);
            assert_eq!(disallowed_tools, ["WebFetch".to_string()]);
            assert_eq!(max_turns, Some(9));
            assert_eq!(max_budget_usd, Some(2.5));
        }
        PreparedSessionSpawn::Pty { .. } => panic!("expected headless spawn"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn dormant_start_uses_stored_explicit_agent_provider_and_model() {
    let repo_root = init_git_repo("dormant-start-stored-explicit-provider");
    let agent_dir = repo_root.join(".kanna/agents/dormant-review");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("AGENT.md"),
        "---\nname: dormant-review\ndescription: Reviews dormant tasks\nagent_provider: claude\nmodel: agent-model\n---\nReview the task.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            },
            "agentProviders": {
                "dormant-review": {
                    "provider": "codex",
                    "model": "repo-model"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish dormant explicit provider fixture");

    let config = test_config("dormant-start-stored-explicit-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-explicit",
        "repo-1",
        "Explicit provider blocker",
        Some("Explicit provider blocker"),
        "in progress",
        "2026-07-30 00:00:00",
    )
    .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Resume with stored explicit preferences".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: Some("dormant-review".to_string()),
            agent_provider: Some("opencode".to_string()),
            agent_type: None,
            model: Some("explicit-model".to_string()),
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: Some(vec!["blocker-explicit".to_string()]),
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("dependent-explicit-provider".to_string()),
    )
    .unwrap();
    db.insert_task_blocker(&created.task_id, "blocker-explicit")
        .unwrap();
    assert_eq!(db.count_open_task_blockers(&created.task_id).unwrap(), 1);
    db.close_pipeline_item("blocker-explicit").unwrap();

    let prepared = prepare_start_dormant_task_for_api(
        &db,
        &config,
        &created.task_id,
        vec!["main".to_string()],
    )
    .unwrap()
    .expect("resolved blocker should prepare the dormant task");

    assert_eq!(prepared.agent_provider, "opencode");
    assert_eq!(prepared.model.as_deref(), Some("explicit-model"));

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn dormant_start_uses_repo_provider_preference_without_stored_explicit_values() {
    let repo_root = init_git_repo("dormant-start-repo-provider");
    let agent_dir = repo_root.join(".kanna/agents/implement");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("EXTEND.md"),
        "---\nagent_provider: opencode\nmodel: agent-model\n---\n",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish dormant agent preference fixture");

    let config = test_config("dormant-start-repo-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "blocker-repo",
        "repo-1",
        "Repo provider blocker",
        Some("Repo provider blocker"),
        "in progress",
        "2026-07-30 00:00:00",
    )
    .unwrap();

    let created = create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Resume with the repo provider preference".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: Some(vec!["blocker-repo".to_string()]),
            terminal_cols: None,
            terminal_rows: None,
        },
        Some("dependent-repo-provider".to_string()),
    )
    .unwrap();
    db.insert_task_blocker(&created.task_id, "blocker-repo")
        .unwrap();
    assert_eq!(db.count_open_task_blockers(&created.task_id).unwrap(), 1);

    let dormant_item = db.get_pipeline_item(&created.task_id).unwrap().unwrap();
    assert_eq!(dormant_item.agent_provider.as_deref(), Some("opencode"));

    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            },
            "agentProviders": {
                "implement": {
                    "provider": "codex",
                    "model": "repo-model"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish dormant repo provider preference");
    db.close_pipeline_item("blocker-repo").unwrap();

    let prepared = prepare_start_dormant_task_for_api(
        &db,
        &config,
        &created.task_id,
        vec!["main".to_string()],
    )
    .unwrap()
    .expect("resolved blocker should prepare the dormant task");

    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model.as_deref(), Some("repo-model"));

    let _ = std::fs::remove_dir_all(&repo_root);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn prepare_task_for_api_classifies_requested_task_id_primary_key_collision() {
    let task_id = "c1d2e3f4a5b60718";
    let repo_root = init_git_repo("requested-task-id-collision");
    let config = test_config("requested-task-id-collision");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        task_id,
        "repo-1",
        "Create once",
        None,
        "in progress",
        "2026-07-15 00:00:00",
    )
    .unwrap();

    let error = match prepare_task_for_api_with_error(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Create once".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some(task_id.to_string()),
    ) {
        Ok(_) => panic!("duplicate requested task id should fail preparation"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        PrepareTaskError::RequestedTaskIdAlreadyExists
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_dormant_task_for_api_classifies_requested_task_id_primary_key_collision() {
    let task_id = "e1f2a3b4c5d60718";
    let repo_root = init_git_repo("dormant-requested-task-id-collision");
    let config = test_config("dormant-requested-task-id-collision");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        task_id,
        "repo-1",
        "Create dormant once",
        None,
        "in progress",
        "2026-07-15 00:00:00",
    )
    .unwrap();

    let error = match create_dormant_task_for_api_with_error(
        &db,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Create dormant once".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
            terminal_cols: None,
            terminal_rows: None,
        },
        Some(task_id.to_string()),
    ) {
        Ok(_) => panic!("duplicate requested dormant task id should fail creation"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        PrepareTaskError::RequestedTaskIdAlreadyExists
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_codex_agent_uses_resolved_executable_for_headless_spawn() {
    let _sidecar_guard = crate::test_sidecar_guard();
    let codex_sidecar = ensure_test_sidecar("codex");
    let repo_root = init_git_repo_without_provider_fixtures("codex-headless-executable");
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    match prepared.session {
        PreparedSessionSpawn::Agent { executable, .. } => {
            let executable = executable.expect("codex executable should be resolved");
            assert_eq!(executable, codex_sidecar.path().to_string_lossy());
        }
        _ => panic!("expected agent session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_headless_agent_uses_worktree_workspace_path_for_executable_resolution() {
    let _sidecar_guard = crate::test_sidecar_guard();
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
    publish_origin_main(&repo_root, "add workspace path");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use codex".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("copilot".to_string()),
            agent_type: None,
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
            notify_task_id: None,
            parent_task_id: None,
            blocker_task_ids: None,
        },
    )
    .unwrap();

    let provider_session_id = prepared
        .provider_session_id
        .as_deref()
        .expect("Copilot PTY spawn should assign a provider session id");
    match &prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => assert!(args
            .last()
            .expect("Copilot PTY command")
            .contains(&format!("--session-id='{provider_session_id}'"))),
        _ => panic!("expected pty session"),
    }
    let created = db
        .list_pipeline_items("repo-1")
        .unwrap()
        .into_iter()
        .find(|item| item.id == prepared.created_task.task_id)
        .unwrap();
    assert_eq!(created.agent_type.as_deref(), Some("pty"));

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
    publish_origin_main(&repo_root, "add workspace path");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use codex".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
    let expected_executable = std::path::Path::new(&expected_dir)
        .join("codex")
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
            let executable_index = command
                .find(&expected_executable)
                .expect("PTY command should launch the resolved workspace executable");
            assert!(path_index < executable_index);
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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

    let env = build_spawn_env(
        &config,
        "task-1",
        &HashMap::new(),
        "/tmp/worktree",
        &Default::default(),
    )
    .unwrap();

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
fn prepare_task_uses_builtin_default_workflow_when_repo_has_no_local_default_workflow() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-task-default-workflow-fallback-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    install_test_provider_binaries(&repo_root);
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
        .args(["add", "."])
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
    publish_origin_main(&repo_root, "publish default workflow fallback fixture");

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("default-workflow-fallback"),
        kanna_cli_path: None,
        desktop_id: "desktop-1".to_string(),
        desktop_secret: Some("desktop-secret".to_string()),
        desktop_name: "Studio Mac".to_string(),
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
        pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
    };
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let original_cwd = std::env::current_dir().unwrap();
    let unrelated_cwd = std::env::temp_dir().join(format!(
        "kanna-task-default-workflow-unrelated-cwd-{}",
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
fn prepare_task_prefers_explicit_then_repo_then_agent_definition_over_default_provider_setting() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-task-default-agent-provider-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    install_test_provider_binaries(&repo_root);
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
        .args(["add", "."])
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
    publish_origin_main(&repo_root, "publish provider precedence fixture");

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
        version: "test-version".to_string(),
        environment: "development".to_string(),
        lan_host: "0.0.0.0".to_string(),
        lan_port: 48120,
        transfer_port: 4455,
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
            prompt: "Use the built-in implement provider".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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

    // With no agentProviders key, the built-in implement definition remains
    // Claude-first and takes precedence over the configured Copilot default.
    assert_eq!(created_source.agent_provider.as_deref(), Some("claude"));
    assert_eq!(prepared.model, None);
    assert_eq!(prepared.effort, None);

    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::write(repo_root.join(".kanna/config.json"), "{}").unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/EXTEND.md"),
        "---\nagent_provider: opencode\nmodel: extension-model\neffort: medium\n---\n",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish layered implement preference");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the layered agent definition".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
    assert_eq!(created_source.agent_provider.as_deref(), Some("opencode"));
    assert_eq!(prepared.model.as_deref(), Some("extension-model"));
    assert_eq!(prepared.effort.as_deref(), Some("medium"));

    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "agentProviders": {
                "implement": {
                    "provider": "codex",
                    "model": "repo-model",
                    "effort": "high"
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo implement preference");

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the repo provider preference".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
    assert_eq!(prepared.model.as_deref(), Some("repo-model"));
    assert_eq!(prepared.effort.as_deref(), Some("high"));

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the explicit provider".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: Some("explicit-model".to_string()),
            effort: Some("low".to_string()),
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
            transfer_import: None,
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
    assert_eq!(prepared.model.as_deref(), Some("explicit-model"));
    assert_eq!(prepared.effort.as_deref(), Some("low"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_task_model_and_provider_precedence_reaches_claude_and_codex_pty_argv() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ModelSpawnContract {
        provider: String,
        model: String,
        pty_flag: String,
    }

    let contracts: Vec<ModelSpawnContract> = serde_json::from_str(include_str!(
        "../../../../../tests/cli-contract/fixtures/task-model-spawn.json"
    ))
    .unwrap();
    let request_defaults = || CreateTaskRequest {
        repo_id: String::new(),
        prompt: String::new(),
        display_name: None,
        workflow_name: None,
        stage: None,
        base_ref: None,
        agent: None,
        agent_provider: None,
        agent_type: None,
        terminal_cols: None,
        terminal_rows: None,
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: None,
        disallowed_tools: None,
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: None,
        task_template: None,
        resume_session_id: None,
        recovery_snapshot: None,
        transfer_import: None,
        blocker_task_ids: None,
        notify_task_id: None,
        parent_task_id: None,
    };
    let repo_root = init_git_repo("create-model-precedence-contract");
    std::fs::create_dir_all(repo_root.join(".kanna/agents/model-agent")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/model-agent/AGENT.md"),
        "---\nname: model-agent\ndescription: Model precedence fixture\nagent_provider: claude\nmodel: definition-model\n---\nRun $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/model-contract.json"),
        serde_json::json!({
            "stages": [{
                "name": "in progress",
                "agent": "model-agent",
                "prompt": "$TASK_PROMPT",
                "policy": { "transition": "manual" }
            }]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish model precedence contract");

    let config = test_config("create-model-precedence-contract");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let from_definition = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use definition model".to_string(),
            workflow_name: Some("model-contract".to_string()),
            agent_type: Some("pty".to_string()),
            ..request_defaults()
        },
    )
    .unwrap();
    assert_eq!(from_definition.agent_provider, "claude");
    assert_eq!(from_definition.model.as_deref(), Some("definition-model"));

    for contract in contracts {
        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: format!("Use explicit {} model", contract.provider),
                workflow_name: Some("model-contract".to_string()),
                agent_provider: Some(contract.provider.clone()),
                agent_type: Some("pty".to_string()),
                model: Some(contract.model.clone()),
                effort: None,
                ..request_defaults()
            },
        )
        .unwrap();

        assert_eq!(prepared.agent_provider, contract.provider);
        assert_eq!(prepared.model.as_deref(), Some(contract.model.as_str()));
        match prepared.session {
            PreparedSessionSpawn::Pty { args, .. } => {
                assert!(
                    args.join(" ").contains(&contract.pty_flag),
                    "created task did not pass model through to PTY argv"
                );
            }
            PreparedSessionSpawn::Agent { .. } => panic!("expected PTY spawn"),
        }

        if contract.provider == "claude" || contract.provider == "codex" {
            let headless = prepare_task_for_api(
                &db,
                &config,
                CreateTaskRequest {
                    repo_id: "repo-1".to_string(),
                    prompt: format!("Use explicit {} model headlessly", contract.provider),
                    workflow_name: Some("model-contract".to_string()),
                    agent_provider: Some(contract.provider.clone()),
                    agent_type: Some("agent".to_string()),
                    model: Some(contract.model.clone()),
                    effort: None,
                    ..request_defaults()
                },
            )
            .unwrap();
            match headless.session {
                PreparedSessionSpawn::Agent {
                    agent_provider,
                    model,
                    ..
                } => {
                    assert_eq!(agent_provider.as_str(), contract.provider);
                    assert_eq!(model.as_deref(), Some(contract.model.as_str()));
                }
                PreparedSessionSpawn::Pty { .. } => panic!("expected headless spawn"),
            }
        }
    }

    let provider_default = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use provider default model".to_string(),
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            ..request_defaults()
        },
    )
    .unwrap();
    assert_eq!(provider_default.agent_provider, "codex");
    assert_eq!(provider_default.model, None);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn create_task_effort_reaches_every_provider_native_pty_control() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EffortSpawnContract {
        provider: String,
        effort: String,
        pty_flag: String,
    }

    let contracts: Vec<EffortSpawnContract> = serde_json::from_str(include_str!(
        "../../../../../tests/cli-contract/fixtures/task-effort-spawn.json"
    ))
    .unwrap();
    let request_defaults = || CreateTaskRequest {
        repo_id: String::new(),
        prompt: String::new(),
        display_name: None,
        workflow_name: None,
        stage: None,
        base_ref: None,
        agent: None,
        agent_provider: None,
        agent_type: None,
        terminal_cols: None,
        terminal_rows: None,
        model: None,
        effort: None,
        permission_mode: None,
        allowed_tools: None,
        disallowed_tools: None,
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: None,
        task_template: None,
        resume_session_id: None,
        recovery_snapshot: None,
        transfer_import: None,
        blocker_task_ids: None,
        notify_task_id: None,
        parent_task_id: None,
    };
    let repo_root = init_git_repo("create-effort-spawn-contract");
    std::fs::create_dir_all(repo_root.join(".kanna/agents/effort-agent")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/effort-agent/AGENT.md"),
        "---\nname: effort-agent\ndescription: Effort spawn fixture\nagent_provider: claude\neffort: medium\n---\nRun $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/effort-contract.json"),
        serde_json::json!({
            "stages": [{
                "name": "in progress",
                "agent": "effort-agent",
                "prompt": "$TASK_PROMPT",
                "policy": { "transition": "manual" }
            }]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish effort spawn contract");

    let config = test_config("create-effort-spawn-contract");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let from_definition = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use definition effort".to_string(),
            workflow_name: Some("effort-contract".to_string()),
            agent_type: Some("pty".to_string()),
            ..request_defaults()
        },
    )
    .unwrap();
    assert_eq!(from_definition.effort.as_deref(), Some("medium"));

    for contract in contracts {
        let prepared = prepare_task_for_api(
            &db,
            &config,
            CreateTaskRequest {
                repo_id: "repo-1".to_string(),
                prompt: format!("Use explicit {} effort", contract.provider),
                workflow_name: Some("effort-contract".to_string()),
                agent_provider: Some(contract.provider.clone()),
                agent_type: Some("pty".to_string()),
                effort: Some(contract.effort.clone()),
                ..request_defaults()
            },
        )
        .unwrap();

        assert_eq!(prepared.agent_provider, contract.provider);
        assert_eq!(prepared.effort.as_deref(), Some(contract.effort.as_str()));
        match prepared.session {
            PreparedSessionSpawn::Pty { args, .. } => assert!(
                args.join(" ").contains(&contract.pty_flag),
                "created task did not pass effort through to {} PTY argv",
                contract.provider
            ),
            PreparedSessionSpawn::Agent { .. } => panic!("expected PTY spawn"),
        }
    }

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
