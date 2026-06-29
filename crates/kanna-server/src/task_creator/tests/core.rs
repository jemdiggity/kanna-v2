use super::*;

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
fn build_agent_command_adds_claude_kanna_preamble_as_system_prompt() {
    let preamble = super::build_kanna_preamble(
        &AgentProvider::Claude,
        "task-123",
        "review",
        "qa",
        Some("auto"),
        None,
    );

    let command = super::build_agent_command(
        &AgentProvider::Claude,
        "Review the branch.",
        None,
        Some("dontAsk"),
        &[],
        Some(&preamble),
        None,
    );

    assert!(command.contains("--append-system-prompt '"));
    assert!(command.contains("task-123"));
    assert!(command.contains("stage `review`"));
    assert!(command.contains("pipeline `qa`"));
    assert!(command.contains("transition `auto`"));
    assert!(command.contains("kanna-cli guide"));
    assert!(command.contains("You are not running inside a Kanna sandbox"));
    let mcp_index = command
        .find("Prefer `kanna-mcp` tools for Kanna task operations")
        .expect("preamble should prefer MCP tools");
    let cli_index = command
        .find("If MCP tools are unavailable, fall back to the instance-local `kanna-cli`")
        .expect("preamble should describe CLI fallback");
    assert!(mcp_index < cli_index);
    assert!(cli_index < command.find("kanna-cli guide").unwrap());
    assert!(command.contains("KANNA_CLI_PATH"));
    assert!(command.contains("Do not push a branch or create a pull request"));
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
                base_ref: None,
                agent_provider: Some(provider.to_string()),
                agent_type: None,
                model: Some("model-a".to_string()),
                permission_mode: Some("dontAsk".to_string()),
                allowed_tools: Some(vec!["Bash".to_string()]),
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
            base_ref: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
            base_ref: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
            base_ref: None,
            agent_provider: Some("copilot".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
            base_ref: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
            base_ref: None,
            agent_provider: Some("claude".to_string()),
            agent_type: Some("agent".to_string()),
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
            base_ref: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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
fn prepare_task_uses_default_agent_provider_setting_when_request_omits_provider() {
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

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the configured default provider".to_string(),
            display_name: None,
            pipeline_name: None,
            base_ref: None,
            agent_provider: None,
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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

    assert_eq!(created_source.agent_provider.as_deref(), Some("copilot"));

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the explicit provider".to_string(),
            display_name: None,
            pipeline_name: None,
            base_ref: None,
            agent_provider: Some("codex".to_string()),
            agent_type: None,
            model: None,
            permission_mode: None,
            allowed_tools: None,
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

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn default_agent_provider_setting_falls_back_to_claude_when_unset() {
    let db_path = Db::test_db_path("default-agent-provider-unset");
    let db = Db::open_for_tests(&db_path).unwrap();

    let provider = read_default_agent_provider_setting(&db).unwrap();

    assert_eq!(provider.as_deref(), Some("claude"));
}
