use super::*;

#[tokio::test]
async fn merge_pty_spawns_with_ordinary_input_policy() {
    let config = test_config("merge-ordinary-input");
    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut commands = Vec::new();
        for response in [
            kanna_daemon::protocol::Event::ProtectedInputReady {
                version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
            },
            kanna_daemon::protocol::Event::SessionCreated {
                session_id: "merge-task".to_string(),
            },
        ] {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            commands.push(
                serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
            );
            write
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "merge-task".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Merge".to_string(),
            prompt: "Merge approved work".to_string(),
            stage: "in progress".to_string(),
            agent_type: "pty".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "merge-task".to_string(),
        session_id: "merge-task".to_string(),
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        stage_agent: Some("merge".to_string()),
        agent_provider: "codex".to_string(),
        model: None,
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Pty {
            agent_executable: None,
            executable: "/bin/cat".to_string(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            agent_provider: DaemonAgentProvider::Codex,
        },
    };
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_task(&mut client, prepared).await.unwrap();
    let commands = fake_daemon.await.unwrap();
    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::NegotiateProtectedInput {
            version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
        })
    ));
    assert!(matches!(
        commands.get(1),
        Some(kanna_daemon::protocol::Command::Spawn {
            operator_input_only: false,
            ..
        })
    ));
}

#[tokio::test]
async fn protected_pty_negotiation_disconnect_is_recorded_before_acknowledgement() {
    let config = test_config("protected-merge-negotiation-disconnect");
    let _ = std::fs::remove_dir_all(
        std::path::Path::new(&config.daemon_dir).join("runtime/completion"),
    );
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "merge-task",
        "repo-1",
        "Merge task",
        Some("Merge task"),
        "in progress",
        "2026-08-04 00:00:00",
    )
    .unwrap();
    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, _write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap()
    });
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "merge-task".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Merge task".to_string(),
            prompt: "Merge approved work".to_string(),
            stage: "in progress".to_string(),
            agent_type: "pty".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "merge-task".to_string(),
        session_id: "merge-task".to_string(),
        cwd: "/tmp".to_string(),
        env: HashMap::new(),
        stage_agent: Some("merge".to_string()),
        agent_provider: "codex".to_string(),
        model: None,
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Pty {
            agent_executable: None,
            executable: "/bin/cat".to_string(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            agent_provider: DaemonAgentProvider::Codex,
        },
    };
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    let error = spawn_prepared_task_for_api_recording_stage_run_detailed(
        &config.db_path,
        &mut client,
        prepared,
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        PreparedTaskDeliveryError::BeforeAcknowledgement(_)
    ));
    assert!(matches!(
        daemon.await.unwrap(),
        kanna_daemon::protocol::Command::NegotiateProtectedInput { .. }
    ));
    let runs = db.list_stage_runs_for_task("merge-task").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert!(runs[0]
        .result
        .as_deref()
        .is_some_and(|result| result.contains("before submission")));
    let completion_dir = std::path::Path::new(&config.daemon_dir).join("runtime/completion");
    assert!(
        !completion_dir.exists()
            || std::fs::read_dir(completion_dir)
                .unwrap()
                .filter_map(Result::ok)
                .all(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        != Some("json")
                ),
        "pre-submission failure must not preserve an uncertain child completion context"
    );
}

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
            prompt: "Do work".to_string(),
            stage: "in progress".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::from([(
            "KANNA_SOCKET_PATH".to_string(),
            kanna_runtime_defaults::socket_path(std::path::Path::new(&config.daemon_dir))
                .to_string_lossy()
                .to_string(),
        )]),
        stage_agent: Some("implement".to_string()),
        agent_provider: "claude".to_string(),
        model: Some("sonnet".to_string()),
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Do work".to_string(),
            model: Some("sonnet".to_string()),
            effort: None,
            permission_mode: Some("dontAsk".to_string()),
            allowed_tools: vec!["Bash".to_string()],
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
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
            prompt: "Do work".to_string(),
            stage: "review".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::from([(
            "KANNA_SOCKET_PATH".to_string(),
            kanna_runtime_defaults::socket_path(std::path::Path::new(&config.daemon_dir))
                .to_string_lossy()
                .to_string(),
        )]),
        stage_agent: Some("reviewer".to_string()),
        agent_provider: "claude".to_string(),
        model: Some("sonnet".to_string()),
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Do work".to_string(),
            model: Some("sonnet".to_string()),
            effort: None,
            permission_mode: Some("dontAsk".to_string()),
            allowed_tools: vec!["Bash".to_string()],
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
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
async fn lost_spawn_response_is_classified_after_ack_and_never_rolled_back_as_retryable() {
    let config = test_config("spawn-response-loss");
    let _ = std::fs::remove_dir_all(
        std::path::Path::new(&config.daemon_dir).join("runtime/completion"),
    );
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Agent task",
        Some("Agent task"),
        "in progress",
        "2026-08-04 00:00:00",
    )
    .unwrap();
    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let spawn_socket_path = socket_path.clone();
    let daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
            kanna_daemon::protocol::Command::SpawnAgent { .. }
        ));
        // Consume the command, then lose the response exactly as a daemon or
        // transport crash after Spawn took effect would.
    });
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Agent task".to_string(),
            prompt: "Do work".to_string(),
            stage: "in progress".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::from([(
            "KANNA_SOCKET_PATH".to_string(),
            spawn_socket_path.to_string_lossy().to_string(),
        )]),
        stage_agent: Some("merge".to_string()),
        agent_provider: "claude".to_string(),
        model: None,
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Do work".to_string(),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            system_prompt: "Kanna context".to_string(),
            mcp_config_path: None,
            executable: None,
        },
    };
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let error = spawn_prepared_task_for_api_recording_stage_run_detailed(
        &config.db_path,
        &mut client,
        prepared,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        PreparedTaskDeliveryError::AfterAcknowledgement(_)
    ));
    daemon.await.unwrap();
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "running");
    assert!(db.stage_run_completion_bound(&runs[0].id).unwrap());
    let completion_dir = std::path::Path::new(&config.daemon_dir).join("runtime/completion");
    assert_eq!(
        std::fs::read_dir(completion_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(
                |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            )
            .count(),
        1,
        "uncertain delivery keeps the exact context owned by the possibly-live agent"
    );
}

#[tokio::test]
async fn rejected_spawn_rolls_back_run_scoped_completion_artifacts_immediately() {
    let config = test_config("spawn-before-ack-context-rollback");
    let _ = std::fs::remove_dir_all(
        std::path::Path::new(&config.daemon_dir).join("runtime/completion"),
    );
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Merge task",
        Some("Merge task"),
        "in progress",
        "2026-08-04 00:00:00",
    )
    .unwrap();
    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let spawn_socket_path = socket_path.clone();
    let daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
            kanna_daemon::protocol::Command::SpawnAgent { .. }
        ));
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&kanna_daemon::protocol::Event::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::AgentSpawnFailed),
                        message: "rejected before acknowledgement".to_string(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let prepared = PreparedTaskSpawn {
        created_task: CreatedTask {
            task_id: "task-1".to_string(),
            repo_id: "repo-1".to_string(),
            title: "Merge task".to_string(),
            prompt: "Merge work".to_string(),
            stage: "in progress".to_string(),
            agent_type: "agent".to_string(),
            worktree_path: "/tmp/worktree".to_string(),
        },
        branch: "task-1".to_string(),
        session_id: "task-1".to_string(),
        cwd: "/tmp/repo/.kanna-worktrees/task-1".to_string(),
        env: HashMap::from([(
            "KANNA_SOCKET_PATH".to_string(),
            spawn_socket_path.to_string_lossy().to_string(),
        )]),
        stage_agent: Some("merge".to_string()),
        agent_provider: "claude".to_string(),
        model: None,
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        provider_session_id: None,
        recovery_snapshot: None,
        session: PreparedSessionSpawn::Agent {
            agent_provider: DaemonAgentProvider::Claude,
            prompt: "Merge work".to_string(),
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            max_turns: None,
            max_budget_usd: None,
            system_prompt: "Kanna context".to_string(),
            mcp_config_path: None,
            executable: None,
        },
    };
    let mut client = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let error =
        spawn_prepared_task_for_api_recording_stage_run(&config.db_path, &mut client, prepared)
            .await
            .unwrap_err();
    assert!(error.contains("rejected before acknowledgement"));
    daemon.await.unwrap();
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, "failed");
    assert_eq!(runs[0].feedback.as_deref(), Some("task spawn failed"));
    assert!(db.stage_run_completion_bound(&runs[0].id).unwrap());
    let completion_dir = std::path::Path::new(&config.daemon_dir).join("runtime/completion");
    assert!(
        std::fs::read_dir(completion_dir).unwrap().next().is_none(),
        "before-ack rollback must remove both JSON and lock artifacts"
    );
}

#[tokio::test]
async fn prepared_agent_task_spawn_includes_task_specific_kanna_context() {
    let repo_root =
        init_git_repo_with_workflow("agent-kanna-context", "qa", "verify", "auto", "claude");
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
            workflow_name: Some("qa".to_string()),
            stage: None,
            base_ref: None,
            diff_base_ref: None,
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
            assert_eq!(params.prompt, "## Your Task\n\nExercise Kanna context");
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
            assert_eq!(
                mcp_config_json["mcpServers"]["kanna-mcp"]["env"]["KANNA_TASK_EVENTS_TOKEN_PATH"],
                params.env["KANNA_TASK_EVENTS_TOKEN_PATH"]
            );
            let system_prompt = params.system_prompt.expect("system prompt should be sent");
            assert!(system_prompt.contains(&format!("task `{task_id}`")));
            assert!(system_prompt.contains("stage `verify`"));
            assert!(system_prompt.contains("workflow `qa`"));
            assert!(system_prompt.contains("(transition: `auto`)"));
            assert!(system_prompt.contains("## Kanna Task Environment"));
            assert!(system_prompt.contains("Prefer the `kanna_*` MCP tools"));
            assert!(system_prompt
                .contains("If MCP tools are unavailable, fall back to the `kanna-cli` binary"));
            assert!(system_prompt.contains("KANNA_CLI_PATH"));
            assert!(system_prompt.contains("kanna-cli guide"));
            assert!(system_prompt.contains("kanna-cli stage-complete"));
            assert!(!system_prompt.contains("kanna_info"));
            assert!(!system_prompt.contains("kanna-cli info"));
            assert!(!system_prompt.contains("authoritative server environment"));
        }
        other => panic!("expected SpawnAgent, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepared_claude_pty_task_spawn_passes_kanna_context_as_append_system_prompt() {
    let repo_root = init_git_repo_with_workflow(
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
            workflow_name: Some("qa".to_string()),
            stage: None,
            base_ref: None,
            diff_base_ref: None,
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
            blocker_task_ids: None,
            notify_task_id: None,

            parent_task_id: None,
        },
    )
    .unwrap();
    let task_id = prepared.created_task.task_id.clone();
    let expected_executable = std::path::Path::new(&prepared.cwd)
        .join(".kanna/test-provider-bin/claude")
        .to_string_lossy()
        .to_string();
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
            assert!(shell_command.contains(&format!("'{expected_executable}' ")));
            assert!(shell_command.contains("--mcp-config"));
            assert!(shell_command.contains("/runtime/mcp/"));
            assert!(shell_command.contains("--append-system-prompt"));
            assert!(shell_command.contains(&format!("task `{task_id}`")));
            assert!(shell_command.contains("stage `implement`"));
            assert!(shell_command.contains("workflow `qa`"));
            assert!(shell_command.contains("(transition: `manual`)"));
            assert!(shell_command.contains("kanna-cli stage-complete"));
            assert!(!shell_command.contains("kanna_info"));
            assert!(!shell_command.contains("kanna-cli info"));
            // `--mcp-config` is variadic: without a `--` separator the CLI
            // consumes the positional prompt as a second config file and
            // exits ("MCP config file not found: <prompt>").
            assert!(
                shell_command.contains("-- '## Your Task\n\nUse Claude PTY'"),
                "prompt must follow an option terminator: {shell_command}"
            );
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepared_non_claude_pty_task_spawn_prepends_kanna_context_to_prompt() {
    let repo_root = init_git_repo_with_workflow(
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
            workflow_name: Some("qa".to_string()),
            stage: None,
            base_ref: None,
            diff_base_ref: None,
            agent: None,
            agent_provider: Some("copilot".to_string()),
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
    let task_id = prepared.created_task.task_id.clone();
    let expected_executable = std::path::Path::new(&prepared.cwd)
        .join(".kanna/test-provider-bin/copilot")
        .to_string_lossy()
        .to_string();
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
            assert!(shell_command.contains(&format!("'{expected_executable}' ")));
            assert!(!shell_command.contains("--append-system-prompt"));
            let context_index = shell_command
                .find("## Kanna Task Environment")
                .expect("Kanna context should be prompt-prepended");
            let task_heading_index = shell_command
                .find("## Your Task")
                .expect("task heading should delimit the prompt");
            let prompt_index = shell_command
                .find("Use Copilot PTY")
                .expect("original prompt should be retained");
            assert!(context_index < task_heading_index);
            assert!(task_heading_index < prompt_index);
            assert!(shell_command.contains(&format!("task `{task_id}`")));
            assert!(shell_command.contains("stage `implement`"));
            assert!(shell_command.contains("workflow `qa`"));
            assert!(shell_command.contains("(transition: `manual`)"));
            assert!(!shell_command.contains("kanna_info"));
            assert!(!shell_command.contains("kanna-cli info"));
            assert!(shell_command.contains("kanna-cli stage-complete"));
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepared_antigravity_pty_task_spawn_sets_up_worktree_alias() {
    let repo_root = init_git_repo_with_workflow(
        "antigravity-pty-worktree-alias",
        "qa",
        "implement",
        "manual",
        "antigravity",
    );
    let config = test_config("antigravity-pty-worktree-alias");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use Antigravity PTY".to_string(),
            display_name: None,
            workflow_name: Some("qa".to_string()),
            stage: None,
            base_ref: None,
            diff_base_ref: None,
            agent: None,
            agent_provider: Some("antigravity".to_string()),
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
    )
    .unwrap();
    let task_id = prepared.created_task.task_id.clone();
    let worktree_path = prepared.created_task.worktree_path.clone();
    let expected_executable = std::path::Path::new(&worktree_path)
        .join(".kanna/test-provider-bin/agy")
        .to_string_lossy()
        .to_string();
    let alias_name: String = std::path::Path::new(&worktree_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let alias_path = format!("/tmp/kanna-antigravity-workspaces/{alias_name}");
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    spawn_prepared_task(&mut daemon, prepared).await.unwrap();
    let command = fake_daemon.await.unwrap();

    match command {
        kanna_daemon::protocol::Command::Spawn {
            session_id,
            args,
            cwd,
            ..
        } => {
            assert_eq!(session_id, task_id);
            assert_eq!(cwd, worktree_path);
            let shell_command = args.last().expect("shell command argument");
            assert!(shell_command.contains("mkdir -p '/tmp/kanna-antigravity-workspaces'"));
            assert!(shell_command.contains(&format!("rm -f '{alias_path}'")));
            assert!(shell_command.contains(&format!("ln -s '{}' '{alias_path}'", worktree_path)));
            assert!(shell_command.contains(&format!(
                "'{expected_executable}' --dangerously-skip-permissions --add-dir '{alias_path}'"
            )));
            let alias_setup_index = shell_command
                .find(&format!("ln -s '{}' '{alias_path}'", worktree_path))
                .expect("worktree alias setup should be present");
            let launch_index = shell_command
                .find(&format!(
                    "'{expected_executable}' --dangerously-skip-permissions --add-dir '{alias_path}'"
                ))
                .expect("Antigravity launch should use the alias");
            assert!(alias_setup_index < launch_index);
            let context_index = shell_command
                .find("## Kanna Task Environment")
                .expect("Kanna context should be prompt-prepended");
            let task_heading_index = shell_command
                .find("## Your Task")
                .expect("task heading should delimit the prompt");
            let prompt_index = shell_command
                .find("Use Antigravity PTY")
                .expect("original prompt should be retained");
            assert!(context_index < task_heading_index);
            assert!(task_heading_index < prompt_index);
            assert!(shell_command.contains(&format!("task `{task_id}`")));
            assert!(shell_command.contains("stage `implement`"));
            assert!(shell_command.contains("workflow `qa`"));
            assert!(shell_command.contains("(transition: `manual`)"));
        }
        other => panic!("expected Spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

/// `--full-auto` was removed from the interactive codex CLI, which now rejects
/// it as an unexpected argument and exits before the agent starts. The
/// replacement is the CLI's own advice from the `codex exec` deprecation trap.
/// Live-pinned against the installed CLI by
/// `tests/cli-contract/tests/live/codex-flags.test.ts`, and mirrored in
/// `apps/desktop/src/stores/agent-permissions.ts`.
#[test]
fn codex_accept_edits_uses_the_sandbox_flag_not_removed_full_auto() {
    let command = super::super::commands::build_agent_command(
        &AgentProvider::Codex,
        "codex",
        "do the thing",
        None,
        None,
        Some("acceptEdits"),
        &[],
        &[],
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert!(
        command.contains("--sandbox workspace-write"),
        "codex acceptEdits must ask for the workspace-write sandbox: {command}"
    );
    assert!(
        !command.contains("--full-auto"),
        "the interactive codex CLI rejects --full-auto: {command}"
    );
}

#[test]
fn codex_default_modes_keep_the_yolo_flag() {
    for mode in [None, Some("default"), Some("dontAsk")] {
        let command = super::super::commands::build_agent_command(
            &AgentProvider::Codex,
            "codex",
            "do the thing",
            None,
            None,
            mode,
            &[],
            &[],
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(
            command.contains("--yolo"),
            "mode {mode:?} should stay yolo: {command}"
        );
    }
}
