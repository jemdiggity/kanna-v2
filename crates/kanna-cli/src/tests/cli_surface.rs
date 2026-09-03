use super::*;

#[test]
fn parses_task_children_command() {
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "children",
        "--task-id",
        "task-1",
        "--server-url",
        "http://127.0.0.1:48120",
    ])
    .unwrap();

    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::Children {
                    task_id,
                    server_url,
                },
        } => {
            assert_eq!(task_id, "task-1");
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected task children command"),
    }
}

#[test]
fn task_children_requires_task_id() {
    let error = match crate::Cli::try_parse_from(["kanna-cli", "task", "children"]) {
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
fn advance_stage_accepts_only_declared_operator_or_manager_sources() {
    let manager = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "advance-stage",
        "--task-id",
        "task-1",
        "--source",
        "manager",
    ]);
    assert!(manager.is_ok());

    let invalid = match crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "advance-stage",
        "--task-id",
        "task-1",
        "--source",
        "auto",
    ]) {
        Ok(_) => panic!("auto is server-owned"),
        Err(error) => error,
    };
    assert_eq!(invalid.kind(), clap::error::ErrorKind::InvalidValue);
}

#[test]
fn parses_new_repo_and_task_subcommands() {
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "info",
        "--server-url",
        "http://127.0.0.1:48121",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Info { server_url } => {
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48121"));
        }
        _ => panic!("expected info command"),
    }

    let cli = crate::Cli::try_parse_from(["kanna-cli", "guide", "--json"]).unwrap();
    match cli.command {
        crate::Commands::Guide { topic, json, .. } => {
            assert_eq!(topic, None);
            assert!(json);
        }
        _ => panic!("expected guide command"),
    }

    let cli = crate::Cli::try_parse_from(["kanna-cli", "guide", "workflows"]).unwrap();
    match cli.command {
        crate::Commands::Guide { topic, json, .. } => {
            assert_eq!(topic.as_deref(), Some("workflows"));
            assert!(!json);
        }
        _ => panic!("expected topic guide command"),
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
        "repo",
        "reconcile-metadata",
        "--repo-id",
        "repo-1",
        "--server-url",
        "http://127.0.0.1:48120",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Repo {
            command:
                crate::RepoCommands::ReconcileMetadata {
                    repo_id,
                    apply,
                    server_url,
                },
        } => {
            assert_eq!(repo_id, "repo-1");
            assert!(apply, "reconciliation applies by default");
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected repo reconcile-metadata command"),
    }

    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "repo",
        "reconcile-metadata",
        "--repo-id",
        "repo-1",
        "--apply",
        "false",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Repo {
            command: crate::RepoCommands::ReconcileMetadata { apply, .. },
        } => assert!(!apply),
        _ => panic!("expected repo reconcile-metadata command"),
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
        "Investigate flaky release",
        "--display-name",
        "Release investigation",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::Create {
                    repo_id,
                    prompt,
                    display_name,
                    parent_task,
                    ..
                },
        } => {
            assert_eq!(repo_id, "repo-1");
            assert_eq!(prompt, "Investigate flaky release");
            assert_eq!(display_name.as_deref(), Some("Release investigation"));
            assert_eq!(parent_task, None);
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
        "--machine-id",
        "desktop-studio",
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
                    machine_id,
                    server_url,
                },
        } => {
            assert_eq!(name, "kanna_create_task");
            assert_eq!(
                json.as_deref(),
                Some(r#"{"repo_id":"repo-1","prompt":"Ship"}"#)
            );
            assert_eq!(arg, vec!["stage=pr".to_string()]);
            assert_eq!(machine_id.as_deref(), Some("desktop-studio"));
            assert_eq!(server_url.as_deref(), Some("http://127.0.0.1:48120"));
        }
        _ => panic!("expected tool call command"),
    }

    let cli = crate::Cli::try_parse_from(["kanna-cli", "machine", "list"]).unwrap();
    assert!(matches!(
        cli.command,
        crate::Commands::Machine {
            command: crate::MachineCommands::List { .. }
        }
    ));
}

#[test]
fn tool_call_args_merge_json_and_repeated_args() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let args = build_tool_call_args(
        &catalog,
        "kanna_create_task",
        &Some(r#"{"repo_id":"repo-1","prompt":"Ship","allowed_tools":["Read"]}"#.to_string()),
        &["stage=pr".to_string()],
    )
    .unwrap();

    assert_eq!(
        args,
        json!({
            "repo_id": "repo-1",
            "prompt": "Ship",
            "allowed_tools": ["Read"],
            "stage": "pr"
        })
    );
}

/// Task ids are hex, so roughly one in 16^8 is all digits. Guessing the type
/// from the text turned those into numbers and the catalog rejected them with
/// `task_id must be a string`, which reads like a bad id rather than a CLI bug.
#[test]
fn tool_call_args_keep_all_digit_ids_as_strings() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let args = build_tool_call_args(
        &catalog,
        "kanna_get_task",
        &None,
        &["task_id=57808275".to_string()],
    )
    .unwrap();

    assert_eq!(args, json!({ "task_id": "57808275" }));
    assert!(kanna_tool_catalog::resolve_request(&catalog, "kanna_get_task", &args).is_ok());
}

/// The inverse of the same bug: a declared integer must not arrive as a string
/// just because `--arg` hands every value over as text.
#[test]
fn tool_call_args_type_declared_integers_from_text() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let args = build_tool_call_args(
        &catalog,
        "kanna_wait_task",
        &None,
        &[
            "task_id=57808275".to_string(),
            "timeout_secs=30".to_string(),
            "poll_secs=3".to_string(),
        ],
    )
    .unwrap();

    assert_eq!(
        args,
        json!({ "task_id": "57808275", "timeout_secs": 30, "poll_secs": 3 })
    );
    let request = kanna_tool_catalog::resolve_request(&catalog, "kanna_wait_task", &args).unwrap();
    let wait = request.wait.expect("wait spec");
    assert_eq!(wait.task_id, "57808275");
    assert_eq!(wait.timeout_secs, 30);
    assert_eq!(wait.poll_secs, 3);
}

#[test]
fn tool_call_args_reject_non_numeric_text_for_declared_integers() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let error = build_tool_call_args(
        &catalog,
        "kanna_wait_task",
        &None,
        &["timeout_secs=soon".to_string()],
    )
    .unwrap_err();

    assert_eq!(error, "timeout_secs must be an unsigned integer, got soon");
}

#[test]
fn tool_call_args_accept_json_and_comma_lists_for_declared_string_arrays() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let comma = build_tool_call_args(
        &catalog,
        "kanna_block_task",
        &None,
        &[
            "task_id=57808275".to_string(),
            "blocker_task_ids=1234,ab12cd".to_string(),
        ],
    )
    .unwrap();
    assert_eq!(
        comma,
        json!({ "task_id": "57808275", "blocker_task_ids": ["1234", "ab12cd"] })
    );

    let json_spelled = build_tool_call_args(
        &catalog,
        "kanna_block_task",
        &None,
        &[
            "task_id=57808275".to_string(),
            r#"blocker_task_ids=["1234","ab12cd"]"#.to_string(),
        ],
    )
    .unwrap();
    assert_eq!(json_spelled, comma);
}

#[test]
fn tool_call_args_parse_declared_objects_as_json() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let args = build_tool_call_args(
        &catalog,
        "kanna_complete_stage",
        &None,
        &[
            "task_id=57808275".to_string(),
            "status=success".to_string(),
            "summary=Shipped".to_string(),
            r#"metadata={"pr_url":"https://example.invalid/pull/1"}"#.to_string(),
        ],
    )
    .unwrap();

    assert_eq!(
        args["metadata"],
        json!({ "pr_url": "https://example.invalid/pull/1" })
    );
    assert_eq!(args["task_id"], json!("57808275"));
}

/// An argument the tool does not declare stays text so the resolver reports the
/// unknown argument — the real problem — instead of a parse failure.
#[test]
fn tool_call_args_leave_undeclared_arguments_as_strings() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let args = build_tool_call_args(
        &catalog,
        "kanna_get_task",
        &None,
        &["task_id=57808275".to_string(), "depth=2".to_string()],
    )
    .unwrap();

    assert_eq!(args["depth"], json!("2"));
    let error = kanna_tool_catalog::resolve_request(&catalog, "kanna_get_task", &args).unwrap_err();
    assert!(error.contains("unknown argument: depth"), "{error}");
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
            .filter(|param| param.location != ParamLoc::Routing)
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
        workflow_name: Some("default".to_string()),
        base_ref: Some("origin/main".to_string()),
        agent: Some("review-security".to_string()),
        agent_provider: Some("claude".to_string()),
        agent_type: Some("agent".to_string()),
        model: Some("sonnet".to_string()),
        effort: Some("high".to_string()),
        permission_mode: Some("acceptEdits".to_string()),
        allowed_tool: vec!["Read".to_string(), "Write".to_string()],
        blocker_task_id: vec!["blocker-1".to_string()],
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
            "workflow_name": "default",
            "base_ref": "origin/main",
            "agent": "review-security",
            "agent_provider": "claude",
            "agent_type": "agent",
            "model": "sonnet",
            "effort": "high",
            "permission_mode": "acceptEdits",
            "allowed_tools": ["Read", "Write"],
            "blocker_task_ids": ["blocker-1"],
            "parent_task_id": "root-1"
        }),
    )
    .unwrap();

    assert_eq!(typed_body, resolved.body);
}

#[test]
fn typed_signal_agent_body_matches_catalog_signal_agent_body() {
    let request = build_signal_agent_request("Please review task task-1".to_string(), None, None);
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

#[test]
fn typed_signal_agent_overrides_match_catalog_signal_agent_body() {
    let request = build_signal_agent_request(
        "Please merge task task-1".to_string(),
        Some("claude".to_string()),
        Some("high".to_string()),
    );
    let typed_body = serde_json::to_value(request).unwrap();
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_signal_agent",
        &json!({
            "repo_id": "repo-1",
            "agent": "merge",
            "message": "Please merge task task-1",
            "agent_provider": "claude",
            "effort": "high",
        }),
    )
    .unwrap();

    assert_eq!(typed_body, resolved.body);
}

#[test]
fn parses_repo_agent_signal_provider_and_effort_overrides() {
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
        "merge all open",
        "--agent-provider",
        "claude",
        "--effort",
        "high",
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
                            agent_provider,
                            effort,
                            ..
                        },
                },
        } => {
            assert_eq!(repo_id, "repo-1");
            assert_eq!(agent, "merge");
            assert_eq!(message, "merge all open");
            assert_eq!(agent_provider.as_deref(), Some("claude"));
            assert_eq!(effort.as_deref(), Some("high"));
        }
        _ => panic!("expected repo agent signal command"),
    }
}

#[test]
fn parses_wait_events_and_rejects_removed_set_notify_command() {
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "wait-events",
        "--task-id",
        "child-a,child-b",
        "--task-id",
        "child-c",
        "--cursor",
        "42",
        "--short-cursor",
        "false",
        "--timeout-secs",
        "30",
        "--limit",
        "10",
        "--exclude-task-id",
        "noisy-a,noisy-b",
        "--include-self",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::WaitEvents {
                    task_id,
                    parent_task_id,
                    repo_id,
                    repo_remote_url_hash,
                    exclude_task_id,
                    include_self,
                    local_only,
                    short_cursor,
                    cursor,
                    timeout_secs,
                    limit,
                    ..
                },
        } => {
            assert_eq!(exclude_task_id, vec!["noisy-a", "noisy-b"]);
            assert!(include_self);
            assert_eq!(task_id, vec!["child-a", "child-b", "child-c"]);
            assert_eq!(parent_task_id, None);
            assert_eq!(repo_id, None);
            assert_eq!(repo_remote_url_hash, None);
            assert!(!local_only);
            assert!(!short_cursor);
            assert_eq!(cursor.as_deref(), Some("42"));
            assert_eq!(timeout_secs, 30);
            assert_eq!(limit, Some(10));
        }
        _ => panic!("expected task wait-events command"),
    }

    assert!(crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "set-notify",
        "--task-id",
        "child-a",
        "--notify-task",
        "parent-1",
    ])
    .is_err());
}

#[test]
fn parses_long_lived_task_watch_contract() {
    let cli = crate::Cli::try_parse_from([
        "kanna-cli",
        "task",
        "watch",
        "--task-id",
        "child-a,child-b",
        "--task-id",
        "child-c",
        "--repo-id",
        "repo-1",
        "--cursor",
        "cursor-7",
        "--all",
        "--budget-secs",
        "900",
        "--follow",
        "--exclude-task-id",
        "noisy-a,noisy-b",
        "--exclude-task-id",
        "noisy-c",
        "--include-self",
    ])
    .unwrap();
    match cli.command {
        crate::Commands::Task {
            command:
                crate::TaskCommands::Watch {
                    task_id,
                    repo_id,
                    exclude_task_id,
                    include_self,
                    cursor,
                    all_events,
                    budget_secs,
                    follow,
                    ..
                },
        } => {
            assert_eq!(task_id, vec!["child-a", "child-b", "child-c"]);
            assert_eq!(repo_id.as_deref(), Some("repo-1"));
            assert_eq!(exclude_task_id, vec!["noisy-a", "noisy-b", "noisy-c"]);
            assert!(include_self);
            assert_eq!(cursor.as_deref(), Some("cursor-7"));
            assert!(all_events);
            assert_eq!(budget_secs, Some(900));
            assert!(follow);
        }
        _ => panic!("expected task watch command"),
    }

    let error = match crate::Cli::try_parse_from(["kanna-cli", "task", "watch"]) {
        Ok(_) => panic!("watch needs an explicit task or repository scope"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("--task-id"));

    let mut command = crate::Cli::command();
    let watch = command
        .find_subcommand_mut("task")
        .and_then(|task| task.find_subcommand_mut("watch"))
        .expect("task watch help");
    let mut help = Vec::new();
    watch.write_long_help(&mut help).unwrap();
    let help = String::from_utf8(help).unwrap();
    assert!(help.contains("push-equivalent"));
    assert!(help.contains("240-second per-call clamp"));
    assert!(help.contains("abort calls around 300 seconds"));
    assert!(help.contains("--include-self"));
    assert!(help.contains("--exclude-task-id"));
}

/// The typed CLI and the catalog tool must hit the same endpoint with the same
/// arguments, or an agent without MCP support silently watches something else.
#[test]
fn typed_wait_events_path_matches_the_catalog_tool_path() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "task_ids": ["child-a", "child-b"], "cursor": "42", "timeout_secs": 30, "limit": 10 }),
    )
    .unwrap();

    // The typed CLI orders its query differently; compare the parsed pairs.
    let task_ids = ["child-a".to_string(), "child-b".to_string()];
    let typed = crate::api::task_events_path(&crate::api::TaskEventsParams {
        task_ids: &task_ids,
        parent_task_id: None,
        repo_id: None,
        repo_remote_url_hash: None,
        exclude_task_ids: &[],
        local_only: false,
        include_current_activity: false,
        short_cursor: true,
        from: None,
        cursor: Some("42"),
        timeout_secs: 30,
        limit: Some(10),
    });
    let query_pairs = |path: &str| {
        let mut pairs = path
            .split_once('?')
            .expect("query")
            .1
            .split('&')
            .map(str::to_string)
            .collect::<Vec<_>>();
        pairs.sort();
        pairs
    };
    assert_eq!(
        resolved.path.split_once('?').unwrap().0,
        typed.split_once('?').unwrap().0
    );
    assert_eq!(query_pairs(&resolved.path), query_pairs(&typed));

    // Exclusions ride the same query key on both surfaces, so a manager on
    // the CLI fallback is silenced by exactly the tasks the MCP tool drops.
    let resolved_excluded = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "repo_id": "repo-1", "exclude_task_ids": ["manager-1", "noisy"], "include_self": false, "timeout_secs": 30 }),
    )
    .unwrap();
    let exclusions = ["manager-1".to_string(), "noisy".to_string()];
    let typed_excluded = crate::api::task_events_path(&crate::api::TaskEventsParams {
        task_ids: &[],
        parent_task_id: None,
        repo_id: Some("repo-1"),
        repo_remote_url_hash: None,
        exclude_task_ids: &exclusions,
        local_only: false,
        include_current_activity: false,
        short_cursor: true,
        from: None,
        cursor: None,
        timeout_secs: 30,
        limit: None,
    });
    assert_eq!(
        query_pairs(&resolved_excluded.path),
        query_pairs(&typed_excluded)
    );
    assert!(typed_excluded.contains("excludeTaskIds=manager-1%2Cnoisy"));
    assert!(!typed_excluded.contains("includeSelf"));

    // Same for the parent scope: an agent on the CLI fallback must land on the
    // same children the MCP tool would watch, not on a repo-wide feed.
    let resolved_parent = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_wait_events",
        &json!({ "parent_task_id": "parent-1", "timeout_secs": 30 }),
    )
    .unwrap();
    let typed_parent = crate::api::task_events_path(&crate::api::TaskEventsParams {
        task_ids: &[],
        parent_task_id: Some("parent-1"),
        repo_id: None,
        repo_remote_url_hash: None,
        exclude_task_ids: &[],
        local_only: false,
        include_current_activity: false,
        short_cursor: true,
        from: None,
        cursor: None,
        timeout_secs: 30,
        limit: None,
    });
    assert_eq!(
        query_pairs(&resolved_parent.path),
        query_pairs(&typed_parent)
    );
}

#[test]
fn removed_set_notify_tool_is_not_in_the_catalog() {
    let catalog = kanna_tool_catalog::bundled_catalog();
    assert!(kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_set_task_notify",
        &json!({ "task_id": "child-a", "notify_task_id": "parent-1" }),
    )
    .is_err());
}

#[test]
fn typed_notify_mobile_body_matches_catalog_notify_mobile_body() {
    let typed_body = serde_json::to_value(crate::models::MobileNotificationRequest {
        title: "Staging shipped".to_string(),
        body: "The staging build is ready.".to_string(),
        task_id: Some("task-1".to_string()),
    })
    .unwrap();
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_notify_mobile",
        &json!({
            "title": "Staging shipped",
            "body": "The staging build is ready.",
            "task_id": "task-1"
        }),
    )
    .unwrap();

    assert_eq!(resolved.path, "/v1/mobile/notifications");
    assert_eq!(typed_body, resolved.body);
}

#[test]
fn typed_set_workflow_body_matches_catalog_set_workflow_body() {
    let typed_body = serde_json::to_value(crate::models::SetTaskWorkflowRequest {
        workflow_name: "single-reviewer".to_string(),
    })
    .unwrap();
    let catalog = kanna_tool_catalog::bundled_catalog();
    let resolved = kanna_tool_catalog::resolve_request(
        &catalog,
        "kanna_set_task_workflow",
        &json!({ "task_id": "child-a", "workflow_name": "single-reviewer" }),
    )
    .unwrap();

    assert_eq!(typed_body, resolved.body);
}
