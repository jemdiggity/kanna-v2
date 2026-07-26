use super::super::definitions::{
    AgentDefinition, PipelineDefinition, PipelineStageTransition, RepoDefinitions,
};
use super::super::provider::resolve_agent_provider_with;
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
            pipeline_name: None,
            stage: launch.stage,
            base_ref: None,
            agent: launch.agent,
            agent_provider: launch.agent_provider,
            agent_type: launch.agent_type,
            terminal_cols: None,
            terminal_rows: None,
            model: launch.model,
            permission_mode: launch.permission_mode,
            allowed_tools: launch.allowed_tools,
            disallowed_tools: launch.disallowed_tools,
            max_turns: launch.max_turns,
            max_budget_usd: launch.max_budget_usd,
            setup_cmds: launch.setup_cmds,
            task_template: launch.task_template,
            resume_session_id: None,
            recovery_snapshot: None,
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
fn pipeline_stage_policy_resolves_revision_transition_with_fallback() {
    let explicit: PipelineDefinition = serde_json::from_str(
        r#"{
          "stages": [{
            "name": "in progress",
            "policy": {"transition": "manual", "revision_transition": "auto"}
          }]
        }"#,
    )
    .unwrap();
    let explicit_policy = &explicit.stages[0].policy;
    assert_eq!(explicit_policy.transition, PipelineStageTransition::Manual);
    assert_eq!(
        explicit_policy.revision_transition(),
        PipelineStageTransition::Auto
    );
    assert!(serde_json::to_string(&explicit)
        .unwrap()
        .contains("revision_transition"));

    let inherited: PipelineDefinition = serde_json::from_str(
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
        PipelineStageTransition::Manual
    );

    let invalid = serde_json::from_str::<PipelineDefinition>(
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

fn resolve_test_pipeline_definition(
    repo_root: &std::path::Path,
    pipeline_name: &str,
) -> Result<super::super::definitions::PipelineDefinition, String> {
    RepoDefinitions::resolve(&definition_repo(repo_root, "main"))?.pipeline(pipeline_name)
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
            permission_mode: None,
            allowed_tools: Vec::new(),
        });
        let available = case.available.clone();
        let result = resolve_agent_provider_with(
            joined(&case.explicit).as_deref(),
            (!case.stage.is_empty()).then_some(case.stage.as_slice()),
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
        let pipeline_name = format!("{lower}-pipeline");
        let bin_dir = repo_root.join(format!("{lower}-bin"));
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
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
                "pipeline": pipeline_name,
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
            repo_root.join(format!(".kanna/pipelines/{pipeline_name}.json")),
            serde_json::json!({
                "name": pipeline_name,
                "stages": [{
                    "name": "in progress",
                    "agent": agent_name,
                    "prompt": format!("{prefix}_PIPELINE $TASK_PROMPT"),
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

    std::fs::remove_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
    assert_eq!(stored.pipeline.as_deref(), Some("remote-pipeline"));
    let pipeline_def = stored.pipeline_def.as_deref().unwrap();
    assert!(pipeline_def.contains("REMOTE_PIPELINE"), "{pipeline_def}");
    assert!(!pipeline_def.contains("LOCAL_SENTINEL"), "{pipeline_def}");
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
                prompt.contains("REMOTE_PIPELINE Do remote work"),
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

    std::fs::create_dir_all(publisher.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(publisher.join(".kanna/agents/review")).unwrap();
    std::fs::write(
        publisher.join(".kanna/config.json"),
        serde_json::json!({
            "pipeline": "remote-qa",
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
        publisher.join(".kanna/pipelines/remote-qa.json"),
        serde_json::json!({
            "name": "remote-qa",
            "description": "REMOTE_PIPELINE description",
            "stages": [{
                "name": "remote review",
                "description": "REMOTE_PIPELINE stage description",
                "agent": "review",
                "prompt": "REMOTE_PIPELINE",
                "policy": {"transition": "manual"},
                "post": {
                    "name": "remote post",
                    "description": "REMOTE_PIPELINE post description",
                    "agent": "review",
                    "prompt": "REMOTE_PIPELINE post"
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
        ".kanna/pipelines/remote-qa.json",
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
            "pipeline": "remote-qa-v2",
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
        publisher.join(".kanna/pipelines/remote-qa.json"),
        serde_json::json!({
            "name": "remote-qa-v2",
            "description": "REMOTE_PIPELINE_V2 description",
            "stages": [{
                "name": "remote review v2",
                "description": "REMOTE_PIPELINE_V2 stage description",
                "agent": "review",
                "prompt": "REMOTE_PIPELINE_V2",
                "policy": {"transition": "manual"},
                "post": {
                    "name": "remote post v2",
                    "description": "REMOTE_PIPELINE_V2 post description",
                    "agent": "review",
                    "prompt": "REMOTE_PIPELINE_V2 post"
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
    assert_eq!(config.pipeline.as_deref(), Some("remote-qa"));
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

    let pipeline = definitions.pipeline("remote-qa").unwrap();
    assert_eq!(pipeline.name.as_deref(), Some("remote-qa"));
    assert_eq!(
        pipeline.description.as_deref(),
        Some("REMOTE_PIPELINE description")
    );
    assert_eq!(
        pipeline.stages[0].description.as_deref(),
        Some("REMOTE_PIPELINE stage description")
    );
    assert_eq!(
        pipeline.stages[0].prompt.as_deref(),
        Some("REMOTE_PIPELINE")
    );
    assert_eq!(
        pipeline.stages[0]
            .post
            .as_ref()
            .and_then(|post| post.description.as_deref()),
        Some("REMOTE_PIPELINE post description")
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
        serde_json::to_string(&pipeline).unwrap(),
        serde_json::to_string(&agent).unwrap(),
    );
    assert!(!all_wire_values.contains("LOCAL_SENTINEL"));

    let definitions_v2 = RepoDefinitions::resolve(&repo).expect("resolve updated definitions");
    assert_eq!(definitions_v2.ref_name(), "origin/dev");
    assert_eq!(definitions_v2.revision(), Some(revision_v2.as_str()));
    assert_ne!(definitions_v2.revision(), definitions.revision());
    assert_eq!(
        definitions_v2.config().pipeline.as_deref(),
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

    let pipeline_v2 = definitions_v2.pipeline("remote-qa").unwrap();
    assert_eq!(pipeline_v2.name.as_deref(), Some("remote-qa-v2"));
    assert_eq!(
        pipeline_v2.description.as_deref(),
        Some("REMOTE_PIPELINE_V2 description")
    );
    assert_eq!(
        pipeline_v2.stages[0].prompt.as_deref(),
        Some("REMOTE_PIPELINE_V2")
    );
    assert_eq!(
        pipeline_v2.stages[0]
            .post
            .as_ref()
            .and_then(|post| post.description.as_deref()),
        Some("REMOTE_PIPELINE_V2 post description")
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
        definitions.pipeline("default").unwrap().name.as_deref(),
        Some("default")
    );
    assert_eq!(definitions.agent("review").unwrap().name, "review");

    let pipeline_error = definitions.pipeline("remote-only").unwrap_err();
    assert!(
        pipeline_error.contains("compiled resource not found")
            && pipeline_error.contains(".kanna/pipelines/remote-only.json"),
        "{pipeline_error}"
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

    let dispatch = definitions.pipeline("qa-dispatch").unwrap();
    assert_eq!(dispatch.name.as_deref(), Some("qa-dispatch"));
    let review = dispatch
        .stages
        .iter()
        .find(|stage| stage.name == "review")
        .expect("qa-dispatch review stage");
    assert_eq!(review.agent.as_deref(), Some("qa-dispatcher"));
    assert_eq!(review.policy.transition, PipelineStageTransition::Auto);

    let specialty = definitions.pipeline("specialty-review").unwrap();
    assert_eq!(specialty.stages.len(), 1);
    let stage = &specialty.stages[0];
    assert_eq!(stage.name, "review");
    assert!(
        stage.agent.is_none(),
        "the dispatcher binds the specialty agent at task creation"
    );
    // Manual: both verdicts park the child unread — never auto-close — so
    // the dispatcher uniformly collects the verdict and closes every child.
    assert_eq!(stage.policy.transition, PipelineStageTransition::Manual);

    for agent_name in [
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
fn remote_pipeline_tree_read_error_does_not_fall_back_to_compiled_default() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-pipeline-tree");
    let pipeline_path = repo_root.join(".kanna/pipelines/default.json");
    std::fs::create_dir_all(&pipeline_path).unwrap();
    std::fs::write(pipeline_path.join("child.json"), "{}").unwrap();
    let revision = publish_origin_main(&repo_root, "publish pipeline tree");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let error = definitions.pipeline("default").unwrap_err();

    assert_remote_definition_error(&error, ".kanna/pipelines/default.json", &revision);
    assert!(error.contains("not a blob"), "{error}");
    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn remote_pipeline_manifest_blob_list_error_does_not_return_compiled_names() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-pipeline-list-blob");
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(repo_root.join(".kanna/pipelines"), "not a tree").unwrap();
    let revision = publish_origin_main(&repo_root, "publish pipelines blob");
    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    let error = definitions.pipeline_names().unwrap_err();

    assert_remote_definition_error(&error, ".kanna/pipelines", &revision);
    assert!(error.contains("not a tree"), "{error}");
    let _ = std::fs::remove_dir_all(repo_root);
}

#[test]
fn local_only_committed_definitions_without_remote_tracking_ref_are_ignored() {
    let repo_root = init_git_repo_without_provider_fixtures("definitions-local-only");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/local-agent")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        r#"{"pipeline":"local-pipeline","setup":["LOCAL_SENTINEL"]}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/local-pipeline.json"),
        r#"{"name":"local-pipeline","stages":[{"name":"local","transition":"manual"}]}"#,
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
    assert!(definitions.pipeline("local-pipeline").is_err());
    assert!(definitions.agent("local-agent").is_err());
    assert_eq!(
        definitions.pipeline("default").unwrap().name.as_deref(),
        Some("default")
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
                "pipeline": "qa",
                "setup": ["pnpm install"],
                "test": "must-be-an-array",
                "stage_order": ["review", 42]
            }),
            serde_json::json!({
                "pipeline": "qa",
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

    let pipeline_repo = init_git_repo_without_provider_fixtures("definitions-bad-pipeline");
    std::fs::create_dir_all(pipeline_repo.join(".kanna/pipelines")).unwrap();
    std::fs::write(pipeline_repo.join(".kanna/pipelines/default.json"), "{").unwrap();
    let pipeline_revision = publish_origin_main(&pipeline_repo, "publish malformed pipeline");
    let pipeline_definitions =
        RepoDefinitions::resolve(&definition_repo(&pipeline_repo, "main")).unwrap();
    let pipeline_error = pipeline_definitions.pipeline("default").unwrap_err();
    assert_remote_definition_error(
        &pipeline_error,
        ".kanna/pipelines/default.json",
        &pipeline_revision,
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

    for repo_root in [config_repo, pipeline_repo, agent_repo, extension_repo] {
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
fn pipeline_names_are_sorted_deduped_remote_and_compiled_union() {
    let repo_root = init_git_repo_without_provider_fixtures("definition-pipeline-names");
    let pipeline_dir = repo_root.join(".kanna/pipelines");
    std::fs::create_dir_all(pipeline_dir.join("nested")).unwrap();
    for name in ["zeta.json", "alpha.json", "qa.json", "schema.json"] {
        std::fs::write(pipeline_dir.join(name), "{}").unwrap();
    }
    std::fs::write(pipeline_dir.join("README.md"), "not a pipeline").unwrap();
    std::fs::write(pipeline_dir.join("nested/hidden.json"), "{}").unwrap();
    publish_origin_main(&repo_root, "publish pipeline names");

    let definitions = RepoDefinitions::resolve(&definition_repo(&repo_root, "main")).unwrap();

    assert_eq!(
        definitions.pipeline_names().unwrap(),
        vec![
            "alpha",
            "default",
            "qa",
            "qa-dispatch",
            "specialty-review",
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
fn stored_pipeline_is_parsed_without_snapshot_resolution_and_preserves_descriptions() {
    let stored = serde_json::json!({
        "name": "stored",
        "description": "Stored pipeline",
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

    let pipeline = super::super::definitions::parse_stored_pipeline_definition(&stored).unwrap();

    assert_eq!(pipeline.name.as_deref(), Some("stored"));
    assert_eq!(pipeline.description.as_deref(), Some("Stored pipeline"));
    assert_eq!(
        pipeline.stages[0].description.as_deref(),
        Some("Stored stage")
    );
    assert_eq!(
        pipeline.stages[0]
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
fn read_pipeline_definition_rejects_malformed_provider_selections() {
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
            init_git_repo_without_provider_fixtures(&format!("pipeline-provider-{label}"));
        let pipeline_dir = repo_root.join(".kanna/pipelines");
        std::fs::create_dir_all(&pipeline_dir).unwrap();
        std::fs::write(
            pipeline_dir.join("qa.json"),
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
        publish_origin_main(&repo_root, "publish malformed pipeline provider");

        let error = resolve_test_pipeline_definition(&repo_root, "qa")
            .err()
            .expect("malformed pipeline provider selection should fail");

        assert!(
            error.contains("agent_provider"),
            "{label}: expected provider-specific error, got {error:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn read_pipeline_definition_rejects_legacy_csv_provider_selections() {
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
            init_git_repo_without_provider_fixtures(&format!("pipeline-csv-provider-{location}"));
        let pipeline_dir = repo_root.join(".kanna/pipelines");
        std::fs::create_dir_all(&pipeline_dir).unwrap();
        std::fs::write(
            pipeline_dir.join("qa.json"),
            serde_json::json!({
                "name": "qa",
                "stages": [stage],
            })
            .to_string(),
        )
        .unwrap();
        publish_origin_main(&repo_root, "publish legacy CSV pipeline provider");

        let error = resolve_test_pipeline_definition(&repo_root, "qa")
            .err()
            .expect("live pipeline definitions must reject legacy CSV providers");

        assert!(
            error.contains("agent_provider"),
            "{location}: expected provider-specific error, got {error:?}"
        );
        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn stored_pipeline_definition_accepts_legacy_null_provider_and_omits_it_on_reserialize() {
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

    let pipeline = super::super::definitions::parse_stored_pipeline_definition(&snapshot)
        .expect("legacy durable pipeline snapshots should remain readable");
    let serialized = serde_json::to_value(pipeline).unwrap();

    assert!(serialized["stages"][0].get("agent_provider").is_none());
}

#[test]
fn stored_pipeline_definition_normalizes_legacy_csv_and_preserves_provider_lists() {
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

        let pipeline = super::super::definitions::parse_stored_pipeline_definition(&snapshot)
            .expect("durable pipeline snapshots should remain readable");
        let serialized = serde_json::to_value(pipeline).unwrap();

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
        .contains("Natural-language merge requests"));
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
    assert!(definition.prompt.contains("kanna_complete_stage"));

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
    let stage = super::super::definitions::PipelineStage {
        name: "gate".to_string(),
        description: None,
        agent: None,
        prompt: None,
        agent_provider: None,
        environment: None,
        policy: super::super::definitions::PipelineStagePolicy {
            transition: PipelineStageTransition::Manual,
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
                pipeline_name: None,
                stage: None,
                base_ref: None,
                agent: None,
                agent_provider: Some(provider.to_string()),
                agent_type: Some("agent".to_string()),
                terminal_cols: None,
                terminal_rows: None,
                model: None,
                permission_mode: None,
                allowed_tools: None,
                disallowed_tools: None,
                max_turns: None,
                max_budget_usd: None,
                setup_cmds: None,
                task_template: None,
                resume_session_id: None,
                recovery_snapshot: None,
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
        AgentProvider::Antigravity.executable(),
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
    assert!(command.contains("'opencode' run --interactive"));
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
                pipeline_name: None,
                stage: None,
                base_ref: None,
                agent: None,
                agent_provider: Some(provider.to_string()),
                agent_type: None,
                terminal_cols: None,
                terminal_rows: None,
                model: Some("model-a".to_string()),
                permission_mode: Some("dontAsk".to_string()),
                allowed_tools: Some(vec!["Bash".to_string()]),
                disallowed_tools: None,
                max_turns: None,
                max_budget_usd: None,
                setup_cmds: None,
                task_template: None,
                resume_session_id: None,
                recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: Some(104),
            terminal_rows: Some(72),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: Some(321),
            terminal_rows: Some(256),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: Some("setup".to_string()),
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
fn prepare_task_binds_specialty_agent_on_specialty_review_pipeline() {
    // The QA dispatcher's fan-out path: a child task created on the builtin
    // single-stage `specialty-review` pipeline, with the specialty agent
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
            pipeline_name: Some("specialty-review".to_string()),
            stage: None,
            base_ref: None,
            agent: Some("review-security".to_string()),
            agent_provider: Some("codex".to_string()),
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
        PipelineStageTransition::Manual
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
            terminal_cols: None,
            terminal_rows: None,
            model: Some("opus".to_string()),
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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: Some(resume_session_id.to_string()),
            recovery_snapshot: None,
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
            terminal_cols: Some(104),
            terminal_rows: Some(72),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
    publish_origin_main(&repo_root, "add workspace path");

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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
fn prepare_task_uses_builtin_default_pipeline_when_repo_has_no_local_default_pipeline() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-task-default-pipeline-fallback-{}",
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
    publish_origin_main(&repo_root, "publish default pipeline fallback fixture");

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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            prompt: "Use the configured default provider".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: None,
            agent_type: Some("pty".to_string()),
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
            terminal_cols: None,
            terminal_rows: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
            max_turns: None,
            max_budget_usd: None,
            setup_cmds: None,
            task_template: None,
            resume_session_id: None,
            recovery_snapshot: None,
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
