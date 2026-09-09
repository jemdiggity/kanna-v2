use super::*;
use std::io::Read;

// These tests prove that workspace setup itself supplies the provider, so
// their repos are built with `init_git_repo_without_provider_fixtures` and
// carry no `.kanna/test-provider-bin`. Nothing else is needed to keep a Codex
// installed on the developer's machine out of the result: a test build never
// resolves an agent CLI from the host at all (see
// `environment::test_provider_fixture_binary`).

const INSTALL_CODEX: &str = "mkdir -p .kanna/setup-bin && printf '#!/bin/sh\\ntouch .kanna/setup-bin/codex-ran\\nexit 0\\n' > .kanna/setup-bin/codex && chmod +x .kanna/setup-bin/codex";
const INSTALL_STREAMING_CODEX: &str = "printf 'SETUP_OUTPUT_SENTINEL\\n' && mkdir -p .kanna/setup-bin && printf '#!/bin/sh\\nprintf \\\"PROVIDER_OUTPUT_SENTINEL\\\\n\\\"\\ntouch .kanna/setup-bin/codex-ran\\nexit 0\\n' > .kanna/setup-bin/codex && chmod +x .kanna/setup-bin/codex";

/// Reaping a killed process group is an eventual event with no latency
/// contract; this deadline only contains a wedged fixture.
const EVENTUAL_PROGRESS_GUARD: std::time::Duration = std::time::Duration::from_secs(30);

/// The pid a setup fixture recorded, once that process is actually running.
///
/// A partially written file, or a pid whose process has not been created yet,
/// is not readiness — the caller must not arm anything until the grandchild it
/// is about to assert on exists.
fn read_live_pid(path: &std::path::Path) -> Option<i32> {
    let pid: i32 = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
    (unsafe { libc::kill(pid, 0) } == 0).then_some(pid)
}

fn write_setup_repo(
    label: &str,
    setup_command: &str,
    with_stage_workflow: bool,
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
    if with_stage_workflow {
        std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/workflows/default.json"),
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
    let _sidecar_guard = crate::test_sidecar_guard_blocking();
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
        "unspecified",
        "Run Codex".to_string(),
        None,
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
        None,
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
async fn initial_pty_task_streams_setup_before_starting_setup_created_provider() {
    let _sidecar_guard = crate::test_sidecar_guard().await;
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo("setup-provider-initial-pty", INSTALL_STREAMING_CODEX, false);
    let mut config = test_config("setup-provider-initial-pty");
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            diff_base_ref: None,
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

    let expected = std::path::Path::new(&prepared.cwd).join(".kanna/setup-bin/codex");
    assert!(
        !expected.exists(),
        "PTY setup must wait for the daemon terminal bootstrap"
    );
    let (pty_executable, pty_args) = match &prepared.session {
        PreparedSessionSpawn::Pty {
            executable,
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(*agent_provider, DaemonAgentProvider::Codex);
            let command = args.last().expect("PTY command");
            assert!(command.contains("Running startup..."), "command: {command}");
            assert!(
                command.contains(INSTALL_STREAMING_CODEX),
                "setup must run in the PTY command: {command}"
            );
            (executable.clone(), args.clone())
        }
        _ => panic!("expected PTY session"),
    };

    let zdotdir = std::path::Path::new(&prepared.cwd).join(".kanna/test-zdotdir");
    std::fs::create_dir_all(&zdotdir).unwrap();
    let mut pty_env = prepared.env.clone();
    pty_env.insert("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string());
    let mut process = kanna_daemon::pty::PtySession::spawn(
        &pty_executable,
        &pty_args,
        &prepared.cwd,
        &pty_env,
        80,
        24,
    )
    .unwrap();
    let mut output_reader = std::fs::File::from(process.try_clone_io_fd().unwrap());
    let mut output = Vec::new();
    let provider_ran = expected.parent().unwrap().join("codex-ran");
    // The assertions below are about the *order* of the bootstrap's output, and
    // the loop exits on the two events that prove it completed. How long a
    // login shell plus setup plus provider takes is a property of the machine,
    // so this deadline only contains a wedged PTY.
    let deadline = tokio::time::Instant::now() + EVENTUAL_PROGRESS_GUARD;
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
        let text = String::from_utf8_lossy(&output);
        let provider_output_seen = text
            .match_indices("PROVIDER_OUTPUT_SENTINEL")
            .nth(1)
            .is_some();
        if provider_ran.is_file() && provider_output_seen {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = process.kill();
            panic!("PTY bootstrap did not finish: {text}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let _ = process.kill();
    let _ = process.try_wait();

    let output = String::from_utf8_lossy(&output);
    let startup_index = output.find("Running startup...").expect("startup banner");
    let setup_output_index = output
        .match_indices("SETUP_OUTPUT_SENTINEL")
        .nth(1)
        .map(|(index, _)| index)
        .expect("setup output after the echoed setup command");
    let provider_index = output
        .match_indices("PROVIDER_OUTPUT_SENTINEL")
        .nth(1)
        .map(|(index, _)| index)
        .expect("provider output after the echoed setup command");
    assert!(startup_index < setup_output_index, "output: {output}");
    assert!(setup_output_index < provider_index, "output: {output}");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn pty_setup_failure_keeps_output_and_prevents_provider_launch() {
    let workspace = std::env::temp_dir().join(format!(
        "kanna-pty-visible-setup-failure-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&workspace);
    std::fs::create_dir_all(&workspace).unwrap();
    let command = super::super::build_task_shell_command(
        "touch provider-ran",
        &["printf 'SETUP_FAILURE_OUTPUT\\n' && exit 23".to_string()],
        None,
        None,
        None,
        Some("/usr/bin:/bin"),
    );

    let output = Command::new("/bin/zsh")
        .args(["--login", "-c", &command])
        .current_dir(&workspace)
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(23));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Running startup..."), "stdout: {stdout}");
    assert!(stdout.contains("SETUP_FAILURE_OUTPUT"), "stdout: {stdout}");
    assert!(
        !workspace.join("provider-ran").exists(),
        "provider must not launch after setup fails"
    );

    let _ = std::fs::remove_dir_all(&workspace);
}

#[test]
fn initial_pty_task_binds_first_provider_before_setup() {
    let _sidecar_guard = crate::test_sidecar_guard_blocking();
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo("setup-provider-precedence", INSTALL_CODEX, false);
    let mut config = test_config("setup-provider-precedence");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();

    let prepared = prepare_task_for_api(
        &db,
        &config,
        CreateTaskRequest {
            repo_id: "repo-1".to_string(),
            prompt: "Use the first configured provider".to_string(),
            display_name: None,
            workflow_name: None,
            stage: None,
            base_ref: None,
            diff_base_ref: None,
            agent: None,
            agent_provider: Some("claude,codex".to_string()),
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

    assert_eq!(prepared.agent_provider, "claude");
    let installed = std::path::Path::new(&prepared.cwd).join(".kanna/setup-bin/codex");
    assert!(
        !installed.exists(),
        "provider selection must not run setup before the PTY starts"
    );
    match prepared.session {
        PreparedSessionSpawn::Pty {
            args,
            agent_provider,
            ..
        } => {
            assert_eq!(agent_provider, DaemonAgentProvider::Claude);
            let command = args.last().expect("PTY command");
            assert!(command.contains(INSTALL_CODEX), "command: {command}");
        }
        _ => panic!("expected PTY session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn initial_headless_task_runs_setup_before_resolving_workspace_provider() {
    let _sidecar_guard = crate::test_sidecar_guard().await;
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
            workflow_name: None,
            stage: None,
            base_ref: None,
            diff_base_ref: None,
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
    let _sidecar_guard = crate::test_sidecar_guard().await;
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let repo_root = write_setup_repo("setup-provider-stage-fork", INSTALL_CODEX, true);
    let mut config = test_config("setup-provider-stage-fork");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_source_task(&config, &db, &repo_root, "pty");

    let mut run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
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
        !expected.exists(),
        "request-path preparation must not run repository setup"
    );
    assert!(run.has_deferred_setup());
    super::super::finish_deferred_stage_setup(&mut run).unwrap();
    assert!(expected.exists(), "detached finalization must run setup");
    assert!(!run.has_deferred_setup());
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
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
    publish_origin_main(&repo_root, "publish post fallback setup workflow");
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

#[tokio::test]
async fn timed_out_stage_fork_setup_kills_group_records_failure_and_removes_fork() {
    let _sidecar_guard = crate::test_sidecar_guard().await;
    let kanna_cli = ensure_test_sidecar("kanna-cli");
    let _kanna_mcp = ensure_test_sidecar("kanna-mcp");
    let grandchild_pid_file = std::env::temp_dir().join(format!(
        "kanna-stage-setup-grandchild-{}.pid",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&grandchild_pid_file);
    let repo_root = write_setup_repo(
        "setup-provider-stage-failure",
        &format!(
            "printf 'setup-started\\n'; (trap '' HUP TERM; while :; do sleep 1; done) & echo $! > '{}'; wait",
            grandchild_pid_file.display()
        ),
        true,
    );
    let mut config = test_config("setup-provider-stage-failure");
    config.kanna_cli_path = Some(kanna_cli.path().to_string_lossy().to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_source_task(&config, &db, &repo_root, "agent");
    let fork_branch =
        super::super::worktree::next_fork_branch(&repo_root.to_string_lossy(), "task-1").unwrap();
    let fork_path = repo_root.join(".kanna-worktrees").join(&fork_branch);

    let mut run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        _ => panic!("expected stage run"),
    };
    // What this test proves is what the timeout path *does*, not how long the
    // budget is. The assertions below all depend on setup having reached its
    // `printf` and having spawned the signal-proof grandchild first, and a
    // fixed budget cannot express that ordering: the setup shell is
    // `/bin/zsh --login`, so under load the profile it sources can outlast any
    // budget short enough to keep the test quick. The timeout is therefore
    // armed by an observer that has seen the grandchild running.
    let timeout_signal = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    run.set_setup_timeout_signal(std::sync::Arc::clone(&timeout_signal));
    assert!(
        fork_path.exists(),
        "preparation should leave the fork for detached setup"
    );
    let fake_daemon = spawn_fake_daemon_read_then_stall(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    // A plain OS thread, not a task: `finish_deferred_stage_setup` supervises
    // the setup process with blocking calls, so nothing else on this runtime
    // would get to run while it is in flight.
    let armer_pid_file = grandchild_pid_file.clone();
    let armer = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + EVENTUAL_PROGRESS_GUARD;
        loop {
            if let Some(pid) = read_live_pid(&armer_pid_file) {
                timeout_signal.store(true, std::sync::atomic::Ordering::Release);
                return pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "setup never spawned its grandchild"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
    let error = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *run,
    )
    .await
    .unwrap_err();
    fake_daemon.abort();
    let grandchild = armer.join().expect("timeout armer should not panic");

    assert!(
        error.contains("workspace setup timed out"),
        "error: {error}"
    );
    assert!(
        error.contains("setup-started"),
        "error should preserve captured setup output: {error}"
    );
    assert!(
        !fork_path.exists(),
        "failed fork should remove {fork_path:?}"
    );
    let failed = db.latest_stage_run("task-1").unwrap().unwrap();
    assert_eq!(failed.stage, "review");
    assert_eq!(failed.status, "failed");
    assert!(
        failed.result.unwrap().contains("workspace setup timed out"),
        "failed run should preserve setup diagnostics"
    );
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .stage
            .as_deref(),
        Some("in progress")
    );
    let deadline = std::time::Instant::now() + EVENTUAL_PROGRESS_GUARD;
    loop {
        let alive = unsafe { libc::kill(grandchild, 0) == 0 };
        if !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "setup grandchild {grandchild} survived timeout"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
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

    let _ = std::fs::remove_file(grandchild_pid_file);
    let _ = std::fs::remove_dir_all(&repo_root);
}
