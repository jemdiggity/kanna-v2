use super::*;

#[tokio::test]
async fn spawn_prepared_task_sends_spawn_agent_for_agent_sessions() {
    let config = test_config("spawn-prepared-agent-command");
    let daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Agent task".to_string(),
            stage: "in progress".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::new(),
        stage_agent: Some("implement".to_string()),
        agent_provider: "claude".to_string(),
        model: Some("sonnet".to_string()),
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Do work".to_string(),
            model: Some("sonnet".to_string()),
            permission_mode: Some("dontAsk".to_string()),
            allowed_tools: vec!["Bash".to_string()],
            system_prompt: "Kanna context".to_string(),
            mcp_config_path: None,
            executable: None,
        },
    };

    let created = spawn_prepared_task(&mut client, prepared).await.unwrap();
    let command = daemon.await.unwrap();

    assert_eq!(created.task_id, "task-1");
    match command {
        kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
            assert_eq!(session_id, "task-1");
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            assert_eq!(params.prompt, "Do work");
            assert_eq!(params.model.as_deref(), Some("sonnet"));
            assert_eq!(params.permission_mode.as_deref(), Some("dontAsk"));
            assert_eq!(params.allowed_tools, vec!["Bash".to_string()]);
            assert_eq!(params.cwd, "/tmp/repo/.kanna-worktrees/task-1");
            assert_eq!(params.system_prompt.as_deref(), Some("Kanna context"));
            assert_eq!(params.executable, None);
        }
        other => panic!("expected SpawnAgent, got {other:?}"),
    }
}

#[tokio::test]
async fn spawn_prepared_task_records_running_stage_run_after_session_created() {
    let config = test_config("spawn-records-stage-run");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Agent task",
        Some("Agent task"),
        "review",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    let daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Agent task".to_string(),
            stage: "review".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::new(),
        stage_agent: Some("reviewer".to_string()),
        agent_provider: "claude".to_string(),
        model: Some("sonnet".to_string()),
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Do work".to_string(),
            model: Some("sonnet".to_string()),
            permission_mode: Some("dontAsk".to_string()),
            allowed_tools: vec!["Bash".to_string()],
            system_prompt: "Kanna context".to_string(),
            mcp_config_path: None,
            executable: None,
        },
    };

    let created =
        spawn_prepared_task_for_api_recording_stage_run(&config.db_path, &mut client, prepared)
            .await
            .unwrap();
    let _ = daemon.await.unwrap();
    let runs = db.list_stage_runs_for_task("task-1").unwrap();

    assert_eq!(created.task_id, "task-1");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].stage, "review");
    assert_eq!(runs[0].agent.as_deref(), Some("reviewer"));
    assert_eq!(runs[0].agent_provider.as_deref(), Some("claude"));
    assert_eq!(runs[0].model.as_deref(), Some("sonnet"));
    assert_eq!(runs[0].status, "running");
    assert_eq!(runs[0].session_id.as_deref(), Some("task-1"));
}

#[tokio::test]
async fn prepared_agent_task_spawn_includes_task_specific_kanna_context() {
    let repo_root =
        init_git_repo_with_pipeline("agent-kanna-context", "qa", "verify", "auto", "claude");
    let config = test_config("agent-kanna-context");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Exercise Kanna context".to_string(),
            display_name: None,
            pipeline_name: Some("qa".to_string()),
            base_ref: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let task_id = prepared.created_task.task_id.clone();
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    let created = spawn_prepared_task(&mut daemon, prepared).await.unwrap();
    let command = fake_daemon.await.unwrap();

    assert_eq!(created.task_id, task_id);
    match command {
        kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
            assert_eq!(session_id, task_id);
            let mcp_config = params
                .env
                .get("KANNA_MCP_CONFIG")
                .expect("spawn env should include instance-local MCP config");
            assert_eq!(params.mcp_config_path.as_deref(), Some(mcp_config.as_str()));
            assert!(
                mcp_config.contains("/runtime/mcp/"),
                "MCP config should be generated in the instance runtime area"
            );
            assert!(
                !mcp_config.contains(".kanna-worktrees/"),
                "MCP config should not be generated inside the repo worktree"
            );
            let mcp_config_json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(mcp_config).unwrap()).unwrap();
            assert_eq!(
                mcp_config_json["mcpServers"]["kanna-mcp"]["command"],
                params.env["KANNA_MCP_PATH"]
            );
            assert_eq!(
                mcp_config_json["mcpServers"]["kanna-mcp"]["args"],
                serde_json::json!(["serve"])
            );
            assert_eq!(
                mcp_config_json["mcpServers"]["kanna-mcp"]["env"]["KANNA_SERVER_BASE_URL"],
                params.env["KANNA_SERVER_BASE_URL"]
            );
            let system_prompt = params.system_prompt.expect("system prompt should be sent");
            assert!(system_prompt.contains(&format!("task `{task_id}`")));
            assert!(system_prompt.contains("stage `verify`"));
            assert!(system_prompt.contains("pipeline `qa`"));
            assert!(system_prompt.contains("transition `auto`"));
            assert!(system_prompt.contains("instance-local `kanna-mcp` config is available"));
            assert!(system_prompt.contains("Claude is launched with this config"));
            assert!(system_prompt.contains("Prefer `kanna-mcp` tools for Kanna task operations"));
            assert!(system_prompt.contains(
                "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`"
            ));
            assert!(system_prompt.contains("KANNA_CLI_PATH"));
            assert!(system_prompt.contains("kanna-cli guide"));
            assert!(system_prompt.contains("kanna-cli stage-complete"));
        }
        other => panic!("expected SpawnAgent, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepared_claude_pty_task_spawn_passes_kanna_context_as_append_system_prompt() {
    let repo_root = init_git_repo_with_pipeline(
        "claude-pty-kanna-context",
        "qa",
        "implement",
        "manual",
        "claude",
    );
    let config = test_config("claude-pty-kanna-context");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use Claude PTY".to_string(),
            display_name: None,
            pipeline_name: Some("qa".to_string()),
            base_ref: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let task_id = prepared.created_task.task_id.clone();
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    spawn_prepared_task(&mut daemon, prepared).await.unwrap();
    let command = fake_daemon.await.unwrap();

    match command {
        kanna_daemon::protocol::Command::Spawn {
            session_id, args, ..
        } => {
            assert_eq!(session_id, task_id);
            let shell_command = args.last().expect("shell command argument");
            assert!(shell_command.contains("claude "));
            assert!(shell_command.contains("--mcp-config"));
            assert!(shell_command.contains("/runtime/mcp/"));
            assert!(shell_command.contains("--append-system-prompt"));
            assert!(shell_command.contains(&format!("task `{task_id}`")));
            assert!(shell_command.contains("stage `implement`"));
            assert!(shell_command.contains("pipeline `qa`"));
            assert!(shell_command.contains("transition `manual`"));
            assert!(shell_command.contains("kanna-cli stage-complete"));
            assert!(shell_command.contains("'Use Claude PTY'"));
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepared_non_claude_pty_task_spawn_prepends_kanna_context_to_prompt() {
    let repo_root = init_git_repo_with_pipeline(
        "copilot-pty-kanna-context",
        "qa",
        "implement",
        "manual",
        "copilot",
    );
    let config = test_config("copilot-pty-kanna-context");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use Copilot PTY".to_string(),
            display_name: None,
            pipeline_name: Some("qa".to_string()),
            base_ref: None,
            agent_provider: Some("copilot".to_string()),
            agent_type: Some("pty".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let task_id = prepared.created_task.task_id.clone();
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    spawn_prepared_task(&mut daemon, prepared).await.unwrap();
    let command = fake_daemon.await.unwrap();

    match command {
        kanna_daemon::protocol::Command::Spawn {
            session_id, args, ..
        } => {
            assert_eq!(session_id, task_id);
            let shell_command = args.last().expect("shell command argument");
            assert!(shell_command.contains("copilot "));
            assert!(!shell_command.contains("--append-system-prompt"));
            let context_index = shell_command
                .find("## Kanna Task Context")
                .expect("Kanna context should be prompt-prepended");
            let prompt_index = shell_command
                .find("Use Copilot PTY")
                .expect("original prompt should be retained");
            assert!(context_index < prompt_index);
            assert!(shell_command.contains(&format!("task `{task_id}`")));
            assert!(shell_command.contains("stage `implement`"));
            assert!(shell_command.contains("pipeline `qa`"));
            assert!(shell_command.contains("transition `manual`"));
            assert!(shell_command.contains("kanna-cli stage-complete"));
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}
