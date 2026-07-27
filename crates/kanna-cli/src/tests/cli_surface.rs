use super::*;

#[test]
fn parses_dependent_tasks_exist_command() {
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "dependent-tasks-exist",
        "--task-id",
        "task-1",
        "--server-url",
        "http://127.0.0.1:48120",
    ])
    .unwrap();

    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::DependentTasksExist {
                    task_id,
                    server_url,
                },
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected task dependent-tasks-exist command"),
    }
}

#[test]
fn dependent_tasks_exist_requires_task_id() {
    let error = match crate::Cli::try_parse_from(["kanna-cli", "task", "dependent-tasks-exist"]) {
        Ok(_) => panic!("--task-id should be required"),
        Err(error) => error,
    };

    assert_eq!(
        error.kind(),
        clap::error::ErrorKind::MissingRequiredArgument
    );
    assert!(error.to_string().contains("--task-id"));
}

#[test]
fn parses_new_repo_and_task_subcommands() {
    let cli = crate::Cli::try_parse_from(["kanna-cli", "guide", "--json"]).unwrap();
    match cli.command {
        crate::Commands::Guide { json, .. } => assert!(json),
        _ => panic!("expected guide command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "repo",
        "add",
        "--path",
        "/tmp/project",
        "--name",
        "Project",
        "--server-url",
        "http://127.0.0.1:48120",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Repo {
            command:
                crate::RepoCommands::Add {
                    path,
                    name,
                    server_url,
                },
        } => {
            assert_eq!(path, "/tmp/project");
            assert_eq!(name.as_deref(), Some("Project"));
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected repo add command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "wait",
        "--task-id",
        "task-1",
        "--timeout-secs",
        "5",
        "--poll-secs",
        "1",
        "--until",
        "closed",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::Wait {
                    task_id,
                    timeout_secs,
                    poll_secs,
                    until,
                    ..
                },
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(timeout_secs, 5);
            assert_eq!(poll_secs, 1);
            assert_eq!(until, "closed");
        }
        _ => panic!("expected task wait command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "create",
        "--repo-id",
        "repo-1",
        "--prompt",
        "Child",
        "--display-name",
        "Short child",
        "--notify-task",
        "task-parent",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::Create {
                    repo_id,
                    prompt,
                    display_name,
                    notify_task,
                    ..
                },
        } => {
            assert_eq!(repo_id, "repo-1");
            assert_eq!(prompt, "Child");
            assert_eq!(display_name.as_deref(), Some("Short child"));
            assert_eq!(notify_task.as_deref(), Some("task-parent"));
        }
        _ => panic!("expected task create command"),
    }

    let result = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "create",
        "--repo-id",
        "repo-1",
        "--prompt",
        "Jump to PR",
        "--stage",
        "pr",
    ]);
    let err = match result {
        Ok(_) => panic!("agent-facing task create must not accept stage overrides"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("unexpected argument '--stage'"));

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "logs",
        "--task-id",
        "task-1",
        "--tail",
        "25",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command: crate::TaskCommands::Logs { task_id, tail, .. },
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(tail, Some(25));
        }
        _ => panic!("expected task logs command"),
    }

    let cli =
        crate::Cli::try_parse_from(["kanna-cli", "task", "list", "--repo-id", "repo-1"]).unwrap();
    match cli.command {
        crate::Commands::Task {
            command: crate::TaskCommands::List { repo_id, .. },
        } => {
            assert_eq!(repo_id.as_deref(), Some("repo-1"));
        }
        _ => panic!("expected repo-scoped task list command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "rename",
        "--task-id",
        "task-1",
        "--name",
        "Renamed task",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command: crate::TaskCommands::Rename { task_id, name, .. },
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(name, "Renamed task");
        }
        _ => panic!("expected task rename command"),
    }

    let cli = crate::Cli::try_parse_from(["kanna-cli", "task", "search", "--query", "review me"])
        .unwrap();
    match cli.command {
        crate::Commands::Task {
            command: crate::TaskCommands::Search { query, .. },
        } => {
            assert_eq!(query, "review me");
        }
        _ => panic!("expected task search command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "repo",
        "agent",
        "signal",
        "--repo-id",
        "repo-1",
        "--agent",
        "merge",
        "--message",
        "Please merge this task",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Repo {
            command:
                crate::RepoCommands::Agent {
                    command:
                        crate::RepoAgentCommands::Signal {
                            repo_id,
                            agent,
                            message,
                            ..
                        },
                },
        } => {
            assert_eq!(repo_id, "repo-1");
            assert_eq!(agent, "merge");
            assert_eq!(message, "Please merge this task");
        }
        _ => panic!("expected repo agent signal command"),
    }
}

#[test]
fn parses_generic_tool_subcommands() {
    let cli = crate::Cli::try_parse_from(["kanna-cli", "tool", "list"]).unwrap();
    assert!(matches!(
        cli.command,
        crate::Commands::Tool {
            command: crate::ToolCommands::List
        }
    ));

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "tool",
        "call",
        "kanna_create_task",
        "--json",
        r#"{"repo_id":"repo-1","prompt":"Ship"}"#,
        "--arg",
        "stage=pr",
        "--server-url",
        "http://127.0.0.1:48120",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Tool {
            command:
                crate::ToolCommands::Call {
                    name,
                    json,
                    arg,
                    server_url,
                },
        } => {
            assert_eq!(name, "kanna_create_task");
            assert_eq!(
                json.as_deref(),
                Some(r#"{"repo_id":"repo-1","prompt":"Ship"}"#)
            );
            assert_eq!(arg, vec!["stage=pr".to_string()]);
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected tool call command"),
    }
}

#[test]
fn tool_call_args_merge_json_and_repeated_args() {
    let args = build_tool_call_args(
        &Some(r#"{"repo_id":"repo-1","prompt":"Ship","allowed_tools":["Read"]}"#.to_string()),
        &["stage=pr".to_string(), "timeout_secs=5".to_string()],
    )
    .unwrap();

    assert_eq!(
        args,
        json!({
            "repo_id": "repo-1",
            "prompt": "Ship",
            "allowed_tools": ["Read"],
            "stage": "pr",
            "timeout_secs": 5
        })
    );
}

#[test]
fn generic_complete_stage_tool_call_binds_process_owned_run_id_after_resolution() {
    let request = resolve_tool_request(
        &kanna_tool_catalog::bundled_catalog(),
        "kanna_complete_stage",
        &json!({
            "task_id": "task-current",
            "status": "success",
            "summary": "done",
            "run_id": "run-explicit"
        }),
        Some("run-from-environment"),
    )
    .unwrap();

    assert_eq!(request.body["runId"], json!("run-from-environment"));
}

#[test]
fn generic_complete_stage_tool_call_resolves_old_override_before_binding_run_id() {
    let mut catalog = kanna_tool_catalog::bundled_catalog();
    catalog
        .tools
        .iter_mut()
        .find(|tool| tool.name == "kanna_complete_stage")
        .unwrap()
        .params
        .retain(|param| param.name != "run_id" && param.name != "completion_attempt");

    let request = resolve_tool_request(
        &catalog,
        "kanna_complete_stage",
        &json!({
            "task_id": "task-current",
            "status": "success",
            "summary": "old override",
            "run_id": "caller-supplied-current-run",
            "completion_attempt": "attempt-current"
        }),
        Some("run-from-environment"),
    )
    .unwrap();

    assert_eq!(
        request.body,
        json!({
            "status": "success",
            "summary": "old override",
            "runId": "run-from-environment",
            "completionAttempt": "attempt-current"
        })
    );
}

#[test]
fn typed_cli_surfaces_match_catalog_tools_and_params() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let typed = typed_tool_surfaces();
    let catalog_tool_names = catalog
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<BTreeSet<_>>();
    let typed_tool_names = typed.keys().copied().collect::<BTreeSet<_>>();

    assert_eq!(typed_tool_names, catalog_tool_names);

    let cli = crate::Cli::command();
    for tool in catalog.tools {
        let surface = typed
            .get(tool.name.as_str())
            .expect("catalog tool should have typed CLI surface");
        let command = command_for_path(&cli, surface.command_path)
            .unwrap_or_else(|| panic!("missing typed command for {}", tool.name));
        let cli_arg_ids = command
            .get_arguments()
            .map(|arg| arg.get_id().as_str())
            .collect::<BTreeSet<_>>();
        let catalog_params = tool
            .params
            .iter()
            .map(|param| param.name.as_str())
            .collect::<BTreeSet<_>>();
        let mapped_params = surface
            .param_args
            .iter()
            .map(|(catalog_param, _)| *catalog_param)
            .collect::<BTreeSet<_>>();

        assert_eq!(
            mapped_params, catalog_params,
            "{} typed CLI mapping must cover exactly the catalog params",
            tool.name
        );
        for (catalog_param, cli_arg) in surface.param_args {
            assert!(
                cli_arg_ids.contains(cli_arg),
                "{} maps catalog param {} to missing typed CLI arg {}",
                tool.name,
                catalog_param,
                cli_arg
            );
        }
    }
}

#[test]
fn typed_create_body_matches_catalog_create_task_body() {
    let request = build_create_task_request(TaskCreateOptions {
        repo_id: "repo-1".to_string(),
        prompt: "Ship it".to_string(),
        display_name: Some("Short task title".to_string()),
        pipeline_name: Some("default".to_string()),
        base_ref: Some("origin/main".to_string()),
        agent: Some("review-security".to_string()),
        agent_provider: Some("claude".to_string()),
        agent_type: Some("agent".to_string()),
        model: Some("sonnet".to_string()),
        permission_mode: Some("acceptEdits".to_string()),
        allowed_tool: vec!["Read".to_string(), "Write".to_string()],
        blocker_task_id: vec!["blocker-1".to_string()],
        notify_task: Some("parent-1".to_string()),
        parent_task: Some("root-1".to_string()),
    });
    let typed_body = serde_json::to_value(request).unwrap();
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_create_task",
        &json!({
            "repo_id": "repo-1",
            "prompt": "Ship it",
            "display_name": "Short task title",
            "pipeline_name": "default",
            "base_ref": "origin/main",
            "agent": "review-security",
            "agent_provider": "claude",
            "agent_type": "agent",
            "model": "sonnet",
            "permission_mode": "acceptEdits",
            "allowed_tools": ["Read", "Write"],
            "blocker_task_ids": ["blocker-1"],
            "notify_task_id": "parent-1",
            "parent_task_id": "root-1"
        }),
    )
    .unwrap();

    assert_eq!(typed_body, resolved.body);
}

#[test]
fn typed_signal_agent_body_matches_catalog_signal_agent_body() {
    let request = build_signal_agent_request("Please review task task-1".to_string());
    let typed_body = serde_json::to_value(request).unwrap();
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_signal_agent",
        &json!({
            "repo_id": "repo-1",
            "agent": "review",
            "message": "Please review task task-1",
        }),
    )
    .unwrap();

    assert_eq!(typed_body, resolved.body);
}
