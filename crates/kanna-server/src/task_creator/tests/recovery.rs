use super::*;
use std::os::unix::fs::PermissionsExt;

const RECOVERY_SESSION_ID: &str = "7f7d2f7a-1b2e-4c3d-9a8b-123456789abc";

fn init_recovery_fixture(label: &str) -> (std::path::PathBuf, Config, Db) {
    let repo_root = init_git_repo(label);
    run_git_fixture(&repo_root, &["branch", "task-recovery"]);
    let worktree = repo_root.join(".kanna-worktrees/task-recovery");
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            worktree.to_string_lossy().as_ref(),
            "task-recovery",
        ],
    );
    let config = test_config(label);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "recovery-task",
        "repo-1",
        "Remember the earlier decision and finish the file.",
        Some("Recovery"),
        "in progress",
        "2026-07-30 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "recovery-task",
        "task-recovery",
        "no-review",
        None,
        "claude",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-recovery-task",
        "recovery-task",
        &worktree.to_string_lossy(),
        "task-recovery",
    )
    .unwrap();
    db.upsert_terminal_session(
        "agent-recovery-task",
        "repo-1",
        Some("recovery-task"),
        Some("agent"),
        Some(&worktree.to_string_lossy()),
        Some("recovery-task"),
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-killed-mid-turn",
        task_id: "recovery-task",
        stage: "in progress",
        kind: "main",
        agent: None,
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("recovery-task"),
        provider_session_id: Some(RECOVERY_SESSION_ID),
        cwd: Some(worktree.to_string_lossy().as_ref()),
        resumed_from_run_id: None,
    })
    .unwrap();
    (repo_root, config, db)
}

fn write_recovery_transcript(config_dir: &std::path::Path, worktree: &std::path::Path) {
    let canonical_worktree = std::fs::canonicalize(worktree).unwrap();
    for cwd in [worktree, canonical_worktree.as_path()] {
        let slug: String = cwd
            .to_string_lossy()
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '-'
                }
            })
            .collect();
        let project_dir = config_dir.join("projects").join(slug);
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join(format!("{RECOVERY_SESSION_ID}.jsonl")),
            "{\"remembered\":\"prior-context-retained\"}\n",
        )
        .unwrap();
    }
}

async fn spawn_recovery_fake_daemon(
    daemon_dir: String,
) -> tokio::task::JoinHandle<Vec<kanna_daemon::protocol::Command>> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (presence_stream, _) = listener.accept().await.unwrap();
        let (presence_read, mut presence_write) = presence_stream.into_split();
        let mut presence_reader = BufReader::new(presence_read);
        let mut presence_line = String::new();
        presence_reader.read_line(&mut presence_line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<kanna_daemon::protocol::Command>(presence_line.trim()).unwrap(),
            kanna_daemon::protocol::Command::List
        ));
        presence_write
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&kanna_daemon::protocol::Event::SessionList {
                        sessions: Vec::new(),
                    })
                    .unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        drop(presence_write);

        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command: kanna_daemon::protocol::Command =
                serde_json::from_str(line.trim()).unwrap();
            let response = match &command {
                kanna_daemon::protocol::Command::Kill { .. } => {
                    kanna_daemon::protocol::Event::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    }
                }
                kanna_daemon::protocol::Command::Spawn {
                    session_id,
                    args,
                    cwd,
                    env,
                    ..
                } => {
                    let command_line = args.last().expect("provider command");
                    let status = tokio::process::Command::new("/bin/sh")
                        .args(["-c", command_line])
                        .current_dir(cwd)
                        .envs(env)
                        .status()
                        .await
                        .unwrap();
                    assert!(status.success(), "fake resumed provider failed: {status}");
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            let spawned = matches!(command, kanna_daemon::protocol::Command::Spawn { .. });
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            if spawned {
                return commands;
            }
        }
    })
}

async fn spawn_listing_fake_daemon(
    daemon_dir: String,
) -> tokio::task::JoinHandle<kanna_daemon::protocol::Command> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let command: kanna_daemon::protocol::Command = serde_json::from_str(line.trim()).unwrap();
        assert!(matches!(command, kanna_daemon::protocol::Command::List));
        let event = kanna_daemon::protocol::Event::SessionList {
            sessions: vec![kanna_daemon::protocol::SessionInfo {
                session_id: "recovery-task".to_string(),
                pid: 42,
                cwd: "/tmp".to_string(),
                state: kanna_daemon::protocol::SessionState::Active,
                idle_seconds: 0,
                status: kanna_daemon::protocol::SessionStatus::Busy,
                kind: Default::default(),
            }],
        };
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&event).unwrap()).as_bytes())
            .await
            .unwrap();
        command
    })
}

#[tokio::test]
async fn killed_task_resume_restores_the_provider_transcript_context() {
    let (repo_root, config, db) = init_recovery_fixture("task-recovery-context");
    let worktree = repo_root.join(".kanna-worktrees/task-recovery");
    let config_dir = repo_root.join("claude-config");
    write_recovery_transcript(&config_dir, &worktree);
    crate::http_api::handle_task_terminal_state(
        &crate::http_api::AppState::new(config.clone()),
        "recovery-task",
        137,
    )
    .await
    .unwrap();
    assert_eq!(
        db.latest_stage_run("recovery-task")
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );
    let fake_claude = worktree.join(".kanna/test-provider-bin/claude");
    std::fs::write(
        &fake_claude,
        r#"#!/bin/sh
session_id=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--resume" ]; then
    session_id="$2"
    shift 2
  else
    shift
  fi
done
slug=$(printf '%s' "$PWD" | sed 's/[^[:alnum:]]/-/g')
transcript="$CLAUDE_CONFIG_DIR/projects/$slug/$session_id.jsonl"
grep -q prior-context-retained "$transcript" || exit 42
printf 'retained' > resume-proof.txt
"#,
    )
    .unwrap();
    std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755)).unwrap();

    let fake_daemon = spawn_recovery_fake_daemon(config.daemon_dir.clone()).await;
    let (response, commands) = {
        let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &config_dir);
        let app = crate::http_api::router(std::sync::Arc::new(crate::http_api::AppState::new(
            config.clone(),
        )));
        let response = tower::ServiceExt::oneshot(
            app,
            axum::http::Request::post("/v1/tasks/recovery-task/actions/resume")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        let commands = fake_daemon.await.unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        (response, commands)
    };
    assert_eq!(response.status(), axum::http::StatusCode::OK);

    let command_line = commands
        .iter()
        .find_map(|command| match command {
            kanna_daemon::protocol::Command::Spawn { args, .. } => args.last(),
            _ => None,
        })
        .expect("replacement spawn command");
    assert!(command_line.contains(&format!("--resume '{RECOVERY_SESSION_ID}'")));
    assert_eq!(
        std::fs::read_to_string(worktree.join("resume-proof.txt")).unwrap(),
        "retained"
    );
    let run = loop {
        let run = db.latest_stage_run("recovery-task").unwrap().unwrap();
        if run.id != "run-killed-mid-turn" {
            break run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(
        run.resumed_from_run_id.as_deref(),
        Some("run-killed-mid-turn")
    );
    assert_eq!(run.resume_fallback_reason, None);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn resume_fallback_records_why_the_provider_context_was_not_restored() {
    let (repo_root, config, db) = init_recovery_fixture("task-recovery-fallback");
    crate::http_api::handle_task_terminal_state(
        &crate::http_api::AppState::new(config.clone()),
        "recovery-task",
        137,
    )
    .await
    .unwrap();
    let empty_config_dir = repo_root.join("empty-claude-config");
    std::fs::create_dir_all(empty_config_dir.join("projects")).unwrap();
    let prepared = {
        let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &empty_config_dir);
        let prepared = prepare_resume_task_for_api(&db, &config, "recovery-task");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        prepared.unwrap()
    };
    assert!(prepared.resumed_workspace().is_none());
    assert_eq!(
        prepared.resume_fallback_reason.as_deref(),
        Some("no claude CLI transcript for the previous session")
    );

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap();
    fake_daemon.await.unwrap();

    let run = db.latest_stage_run("recovery-task").unwrap().unwrap();
    assert_eq!(run.resumed_from_run_id, None);
    assert_eq!(
        run.resume_fallback_reason.as_deref(),
        Some("no claude CLI transcript for the previous session")
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn live_daemon_session_restores_a_false_interruption_instead_of_spawning() {
    let (repo_root, config, db) = init_recovery_fixture("task-recovery-live");
    db.cancel_running_stage_runs("recovery-task").unwrap();
    assert_eq!(
        db.latest_stage_run("recovery-task")
            .unwrap()
            .unwrap()
            .status,
        "cancelled"
    );

    let daemon = spawn_listing_fake_daemon(config.daemon_dir.clone()).await;
    assert_eq!(
        super::super::daemon_session_presence(&config.daemon_dir, "recovery-task").await,
        super::super::DaemonSessionPresence::Present
    );
    assert!(
        crate::http_api::restore_task_run_for_live_session(&config.db_path, "recovery-task")
            .unwrap()
    );
    assert_eq!(
        db.latest_stage_run("recovery-task")
            .unwrap()
            .unwrap()
            .status,
        "running"
    );
    assert!(matches!(
        daemon.await.unwrap(),
        kanna_daemon::protocol::Command::List
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
}
