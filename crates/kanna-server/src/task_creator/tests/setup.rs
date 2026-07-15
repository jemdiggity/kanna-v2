use super::*;
use std::io::Read;

const INSTALL_CODEX: &str = "mkdir -p .kanna/setup-bin && printf '#!/bin/sh\\ntouch .kanna/setup-bin/codex-ran\\nexit 0\\n' > .kanna/setup-bin/codex && chmod +x .kanna/setup-bin/codex";

struct ProviderLookupPathGuard;

impl ProviderLookupPathGuard {
    fn without_host_providers() -> Self {
        // The executable resolver intentionally falls back to the user's login
        // shell in production. Setup-only tests must prove the workspace setup
        // itself supplies the provider rather than accidentally using Codex
        // installed on the test host.
        unsafe {
            std::env::set_var("KANNA_TEST_PROVIDER_LOOKUP_PATH", "/usr/bin:/bin");
        }
        Self
    }
}

impl Drop for ProviderLookupPathGuard {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("KANNA_TEST_PROVIDER_LOOKUP_PATH");
        }
    }
}

fn write_setup_repo(
    label: &str,
    setup_command: &str,
    with_stage_pipeline: bool,
) -> std::path::PathBuf {
    let repo_root = init_git_repo_without_provider_fixtures(label);
    std::fs::create_dir_all(repo_root.join(".kanna")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "setup": [setup_command],
            "workspace": {
                "path": {
                    "prepend": [".kanna/setup-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    if with_stage_pipeline {
        std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            serde_json::json!({
                "stages": [
                    {
                        "name": "in progress",
                        "prompt": "$TASK_PROMPT",
                        "transition": "manual"
                    },
                    {
                        "name": "review",
                        "prompt": "Review $TASK_PROMPT",
                        "agent_provider": "codex",
                        "transition": "manual"
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
    }
    publish_origin_main(&repo_root, "publish setup-provisioned provider");
    repo_root
}

#[test]
fn pty_setup_keeps_sidecar_provider_directory_as_path_fallback() {
    let _sidecar_guard = crate::test_sidecar_guard();
    let codex = ensure_test_sidecar("codex");
    let workspace = std::env::temp_dir().join(format!(
        "kanna-pty-sidecar-setup-path-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&workspace);
    std::fs::create_dir_all(&workspace).unwrap();
    let spawn_env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);

    let (session, _) = build_prepared_session(
        AgentProvider::Codex,
        AgentSessionType::Pty,
        "task-1",
        "in progress",
        "default",
        Some("manual"),
        "Run Codex".to_string(),
        None,
        None,
        Vec::new(),
        Vec::new(),
        None,
        None,
        None,
        &spawn_env,
        workspace.to_string_lossy().as_ref(),
        &["true".to_string()],
        false,
        None,
    )
    .unwrap();

    let command = match session {
        PreparedSessionSpawn::Pty { args, .. } => args.last().unwrap().clone(),
        _ => panic!("expected PTY session"),
    };
    let provider_dir = codex.path().parent().unwrap().to_string_lossy();
    assert!(
        command.contains(&format!("/usr/bin:/bin:{provider_dir}")),
        "setup must retain the resolved sidecar directory as a PATH fallback: {command}"
    );

    let _ = std::fs::remove_dir_all(&workspace);
}

fn seed_source_task(
    config: &Config,
    db: &Db,
    repo_root: &std::path::Path,
    agent_type: &str,
) -> std::path::PathBuf {
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    let source_worktree = repo_root.join(".kanna-worktrees/task-source");
    std::fs::create_dir_all(source_worktree.parent().unwrap()).unwrap();
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Use the setup-provisioned Codex",
        Some("Use the setup-provisioned Codex"),
        "in progress",
        "2026-07-11 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET agent_type = ? WHERE id = 'task-1'",
            [agent_type],
        )
        .unwrap();
    db.upsert_worktree(
        "wt-task-1",
        "task-1",
        &source_worktree.to_string_lossy(),
        "task-source",
    )
    .unwrap();
    source_worktree
}

#[tokio::test]
async fn initial_headless_task_runs_setup_before_resolving_workspace_provider() {
    let _sidecar_guard = crate::test_sidecar_guard();
    let _provider_path_guard = ProviderLookupPathGuard::without_host_providers();
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo("setup-provider-initial", INSTALL_CODEX, false);
    let mut config = test_config("setup-provider-initial");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the setup-provisioned Codex".to_string(),
            display_name: None,
            pipeline_name: None,
            stage: None,
            base_ref: None,
            agent: None,
            agent_provider: Some("codex".to_string()),
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

    let expected = std::path::Path::new(&prepared.cwd).join(".kanna/setup-bin/codex");
    assert!(expected.is_file(), "setup should create {expected:?}");
    match &prepared.session {
        PreparedSessionSpawn::Agent {
            executable,
            agent_provider,
            ..
        } => {
            assert_eq!(*agent_provider, DaemonAgentProvider::Codex);
            assert_eq!(
                executable.as_deref(),
                Some(expected.to_string_lossy().as_ref())
            );
        }
        _ => panic!("expected headless agent session"),
    }
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_task(&mut daemon, prepared).await.unwrap();
    match fake_daemon.await.unwrap() {
        kanna_daemon::protocol::Command::SpawnAgent { params, .. } => {
            assert_eq!(params.agent_provider, DaemonAgentProvider::Codex);
            assert_eq!(
                params.executable.as_deref(),
                Some(expected.to_string_lossy().as_ref())
            );
        }
        other => panic!("expected headless daemon spawn, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn stage_fork_runs_repo_setup_before_resolving_pty_provider() {
    let _sidecar_guard = crate::test_sidecar_guard();
    let _provider_path_guard = ProviderLookupPathGuard::without_host_providers();
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo("setup-provider-stage-fork", INSTALL_CODEX, true);
    let mut config = test_config("setup-provider-stage-fork");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_source_task(&config, &db, &repo_root, "pty");

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("expected stage fork, got post dispatch"),
        PreparedStageTransition::Close { .. } => panic!("expected stage fork, got close"),
    };
    let expected = std::path::Path::new(&run.cwd).join(".kanna/setup-bin/codex");
    assert_eq!(
        run.env.get("PATH").and_then(|path| path.split(':').next()),
        expected
            .parent()
            .map(|path| path.to_string_lossy())
            .as_deref(),
        "workspace-local provider directory must lead PATH"
    );
    assert!(
        expected.exists(),
        "provider setup must complete in the fork before provider selection"
    );
    let (pty_executable, pty_args) = match &run.session {
        PreparedSessionSpawn::Pty {
            executable,
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(*agent_provider, DaemonAgentProvider::Codex);
            let command = args.last().expect("PTY command");
            assert!(
                command.contains(expected.to_string_lossy().as_ref()),
                "expected resolved setup-created Codex command: {command}"
            );
            assert!(
                !command.contains("chmod +x .kanna/setup-bin/codex"),
                "setup must not run twice in the agent PTY command: {command}"
            );
            (executable.clone(), args.clone())
        }
        _ => panic!("expected PTY session"),
    };
    let zdotdir = std::path::Path::new(&run.cwd).join(".kanna/test-zdotdir");
    std::fs::create_dir_all(&zdotdir).unwrap();
    let mut pty_env = run.env.clone();
    pty_env.insert("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string());
    let mut process = kanna_daemon::pty::PtySession::spawn(
        &pty_executable,
        &pty_args,
        &run.cwd,
        &pty_env,
        80,
        24,
    )
    .unwrap();
    let mut output_reader = std::fs::File::from(process.try_clone_io_fd().unwrap());
    let mut output = Vec::new();
    let provider_ran = expected.parent().unwrap().join("codex-ran");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let mut buffer = [0_u8; 4096];
        loop {
            match output_reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => output.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("failed to read PTY output: {error}"),
            }
        }
        if provider_ran.is_file() {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = process.kill();
            panic!(
                "PTY bootstrap did not launch the setup-created provider: {}",
                String::from_utf8_lossy(&output)
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let _ = process.kill();
    let _ = process.try_wait();
    assert!(expected.is_file(), "setup should create {expected:?}");
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *run,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();
    match commands
        .iter()
        .find(|command| matches!(command, kanna_daemon::protocol::Command::Spawn { .. }))
        .expect("PTY daemon spawn")
    {
        kanna_daemon::protocol::Command::Spawn {
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(*agent_provider, Some(DaemonAgentProvider::Codex));
            let command = args.last().expect("PTY command");
            assert!(
                command.contains(expected.to_string_lossy().as_ref()),
                "expected resolved setup-created Codex command: {command}"
            );
            assert!(
                !command.contains("chmod +x .kanna/setup-bin/codex"),
                "setup must not run twice in the daemon PTY command: {command}"
            );
        }
        _ => unreachable!(),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn headless_post_preparation_does_not_run_fallback_environment_setup() {
    let repo_root = init_git_repo("headless-post-fallback-setup");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "setup": ["touch post-fallback-setup-ran"]
                }
            },
            "stages": [
                {
                    "name": "in progress",
                    "prompt": "$TASK_PROMPT",
                    "environment": "dev",
                    "transition": "manual",
                    "post": {
                        "name": "commit",
                        "prompt": "Commit $TASK_PROMPT",
                        "agent_provider": "codex"
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish post fallback setup pipeline");
    let config = test_config("headless-post-fallback-setup");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    let source_worktree = seed_source_task(&config, &db, &repo_root, "agent");

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        _ => panic!("expected post dispatch"),
    };

    assert!(matches!(
        post.fallback.session,
        PreparedSessionSpawn::Agent { .. }
    ));
    assert!(
        !source_worktree.join("post-fallback-setup-ran").exists(),
        "preparing a live-session post must not run fallback-only setup"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn failed_stage_fork_setup_removes_new_worktree_and_branch() {
    let _sidecar_guard = crate::test_sidecar_guard();
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo(
        "setup-provider-stage-failure",
        "mkdir -p setup-started && exit 23",
        true,
    );
    let mut config = test_config("setup-provider-stage-failure");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_source_task(&config, &db, &repo_root, "agent");
    let fork_branch =
        super::super::worktree::next_fork_branch(&repo_root.to_string_lossy(), "task-1").unwrap();
    let fork_path = repo_root.join(".kanna-worktrees").join(&fork_branch);

    let error = match prepare_advance_stage_for_api(&db, &config, "task-1") {
        Ok(_) => panic!("failing setup should reject stage preparation"),
        Err(error) => error,
    };

    assert!(error.contains("workspace setup failed"), "error: {error}");
    assert!(
        error.contains("23"),
        "error should include exit status: {error}"
    );
    assert!(
        error.contains("mkdir -p setup-started && exit 23"),
        "error should identify the failing setup command: {error}"
    );
    assert!(
        !fork_path.exists(),
        "failed fork should remove {fork_path:?}"
    );
    assert!(!Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{fork_branch}"),
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let worktrees = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_root)
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&worktrees.stdout).contains(&fork_branch));

    let _ = std::fs::remove_dir_all(&repo_root);
}
