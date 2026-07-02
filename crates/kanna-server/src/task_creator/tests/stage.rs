use super::*;

#[test]
fn prepare_merge_agent_creates_in_progress_task() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-merge-agent-task-{}", std::process::id()));
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

    let config = test_config("prepare-merge-agent-in-progress");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Create a PR",
        Some("Create a PR"),
        "pr",
        "2026-06-07 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-task-1", "default", None, "claude")
        .unwrap();

    let prepared = prepare_merge_agent_for_api(&db, &config, "task-1").unwrap();

    assert_eq!(prepared.created_task.repo_id, "repo-1");
    assert_eq!(prepared.created_task.stage, "in progress");
    assert!(prepared.created_task.title.contains("merge agent"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn rerun_stage_uses_compiled_post_action_stage_prompt_and_stage_setup() {
    let repo_root = init_git_repo("rerun-post-action");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        serde_json::json!({
            "name": "default",
            "environments": {
                "dev": { "setup": ["echo setup-rerun"] }
            },
            "stages": [
                {
                    "name": "in progress",
                    "transition": "manual",
                    "agent": "implement",
                    "prompt": "Implement $TASK_PROMPT",
                    "environment": "dev",
                    "post_action": {
                        "name": "commit",
                        "transition": "auto",
                        "agent": "commit",
                        "prompt": "Commit $TASK_PROMPT after $PREV_RESULT"
                    }
                },
                { "name": "pr", "transition": "manual" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nname: implement\nagent_provider: claude\n---\nImplement agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nname: commit\nagent_provider: claude\n---\nCommit agent.",
    )
    .unwrap();
    let worktree = repo_root.join(".kanna-worktrees/task-source");
    std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    assert!(Command::new("git")
        .args(["branch", "task-source", "main"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let mut config = test_config("rerun-post-action");
    config.kanna_cli_path = Some("/tmp/kanna-cli".to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix rerun",
        Some("Fix rerun"),
        "commit",
        "2026-07-01 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    insert_finished_stage_run(
        &db,
        "task-1",
        "commit",
        "{\"status\":\"success\",\"summary\":\"implemented\"}",
    );

    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();
    assert_eq!(prepared.task_id, "task-1");
    assert_eq!(prepared.cwd, worktree.to_string_lossy());
    match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("echo setup-rerun"));
            assert!(command.contains("Commit agent."));
            assert!(command.contains(
                "Commit Fix rerun after {\"status\":\"success\",\"summary\":\"implemented\"}"
            ));
            assert!(!command.contains("Implement agent."));
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected pty rerun"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_uses_stored_pipeline_snapshot_for_existing_task() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-stage-snapshot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/qa")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Snapshot prompt $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nagent_provider: claude\n---\nSnapshot agent: $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/qa/AGENT.md"),
        "---\nagent_provider: claude\n---\nLive agent: $TASK_PROMPT",
    )
    .unwrap();
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
        .args(["add", "README.md", ".kanna"])
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
    assert!(Command::new("git")
        .args(["branch", "task-old-branch"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let snapshot =
        std::fs::read_to_string(repo_root.join(".kanna/pipelines/default.json")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "qa", "transition": "manual", "agent": "qa", "prompt": "Live prompt $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();

    let config = test_config("stage-snapshot-resolution");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix the shell",
        Some("Shell fix"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-old-branch",
        "default",
        None,
        "claude",
    )
    .unwrap();
    insert_finished_stage_run(
        &db,
        "task-1",
        "in progress",
        "{\"status\":\"success\",\"summary\":\"done\"}",
    );
    db.update_test_pipeline_item_pipeline_def("task-1", &snapshot)
        .unwrap();

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Close { .. } => panic!("expected in-place stage run"),
    };

    assert_eq!(run.task_id, "task-1");
    assert_eq!(run.next_stage, "review");
    match run.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(
                command.contains(
                    "Snapshot agent: Fix the shell\n\nSnapshot prompt {\"status\":\"success\",\"summary\":\"done\"}"
                ),
                "unexpected command: {command}"
            );
            assert!(!command.contains("Live agent:"));
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_substitutes_previous_stage_run_result_before_legacy_stage_result() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-run-prev-result-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Use result $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nagent_provider: claude\n---\nReview $TASK_PROMPT",
    )
    .unwrap();
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
        .args(["add", "README.md", ".kanna"])
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
    assert!(Command::new("git")
        .args(["branch", "task-old-branch"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("stage-run-prev-result");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix it",
        Some("Fix it"),
        "in progress",
        "2026-07-02 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-old-branch",
        "default",
        Some("{\"source\":\"legacy\"}"),
        "claude",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-1",
        task_id: "task-1",
        stage: "in progress",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "succeeded",
        result: Some("{\"source\":\"stage_run\"}"),
        feedback: Some("done"),
        session_id: Some("task-1"),
    })
    .unwrap();
    db.finish_stage_run(
        "run-1",
        "succeeded",
        Some("{\"source\":\"stage_run\"}"),
        Some("done"),
    )
    .unwrap();

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Close { .. } => panic!("expected in-place stage run"),
    };

    match run.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(
                command.contains("Review Fix it\n\nUse result {\"source\":\"stage_run\"}"),
                "unexpected command: {command}"
            );
            assert!(!command.contains("{\"source\":\"legacy\"}"));
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_rejects_closed_source_task_even_when_stage_is_active() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-advance-closed-source-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual", "mode": "continue" }
  ]
}"#,
    )
    .unwrap();

    let config = test_config("advance-stage-closed-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix stage promotion",
        Some("Fix stage promotion"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"reviewed\"}"),
        "claude",
    )
    .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
            ["task-1"],
        )
        .unwrap();

    let err = match prepare_advance_stage_for_api(&db, &config, "task-1") {
        Ok(_) => panic!("closed task should not prepare a stage transition"),
        Err(err) => err,
    };

    assert!(
        err.contains("task is closed: task-1"),
        "unexpected error: {err}"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_rejects_blocked_source_task() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-advance-blocked-source-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);

    let config = test_config("advance-stage-blocked-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Blocked prompt",
        Some("Blocked task"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.insert_test_pipeline_item(
        "blocker-1",
        "repo-1",
        "Blocker prompt",
        Some("Blocker"),
        "in progress",
        "2026-04-17 08:00:00",
    )
    .unwrap();
    db.insert_test_task_blocker("task-1", "blocker-1").unwrap();

    let err = match prepare_advance_stage_for_api(&db, &config, "task-1") {
        Ok(_) => panic!("blocked task should not prepare a stage transition"),
        Err(err) => err,
    };

    assert!(
        err.contains("task is blocked: task-1"),
        "unexpected error: {err}"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepare_advance_stage_spawns_next_run_in_same_task_and_worktree() {
    let repo_root = init_git_repo("advance-stage-same-task-run");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $BRANCH in $SOURCE_WORKTREE after $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nagent_provider: claude\n---\nReview task: $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let source_worktree = repo_root.join(".kanna-worktrees/task-source");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("advance-stage-same-task-run");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix stage promotion",
        Some("Fix stage promotion"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        "claude",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-task-1",
        "task-1",
        &source_worktree.to_string_lossy(),
        "task-source",
    )
    .unwrap();
    db.insert_stage_run(crate::db::NewStageRun {
        id: "run-in-progress",
        task_id: "task-1",
        stage: "in progress",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Close { .. } => {
            panic!("stage advance must spawn a new run in place")
        }
    };

    assert_eq!(run.task_id, "task-1");
    assert_eq!(run.next_stage, "review");
    assert_eq!(run.cwd, source_worktree.to_string_lossy());
    assert_eq!(run.session_id, "task-1");

    let fake_daemon = spawn_fake_daemon_kill_then_session_created(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let advanced = spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, *run)
        .await
        .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(advanced.task_id, "task-1");
    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "task-1"
    ));
    match commands.get(1) {
        Some(kanna_daemon::protocol::Command::Spawn {
            session_id, cwd, ..
        }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(cwd, &source_worktree.to_string_lossy());
        }
        Some(kanna_daemon::protocol::Command::SpawnAgent { session_id, params }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(params.cwd, source_worktree.to_string_lossy());
        }
        other => panic!("expected daemon spawn command, got {:?}", other),
    }

    let updated = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("review"));
    assert_eq!(updated.branch.as_deref(), Some("task-source"));
    assert_eq!(updated.closed_at, None);
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].stage, "in progress");
    assert_eq!(runs[0].status, "succeeded");
    assert!(runs[0].finished_at.is_some());
    assert_eq!(runs[1].stage, "review");
    assert_eq!(runs[1].status, "running");
    assert_eq!(runs[1].session_id.as_deref(), Some("task-1"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_at_final_stage_prepares_close() {
    let repo_root = init_git_repo_with_pipeline(
        "advance-final-stage-close",
        "default",
        "in progress",
        "manual",
        "claude",
    );

    let config = test_config("advance-final-stage-close");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Ship it",
        Some("Ship it"),
        "pr",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();

    match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Close { task_id } => assert_eq!(task_id, "task-1"),
        PreparedStageTransition::Run(_) => {
            panic!("advancing past the final stage must close the task")
        }
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_auto_stage_completion_spawns_next_run_in_same_task() {
    let repo_root = init_git_repo("auto-completion-same-task");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "commit", "transition": "auto" },
    { "name": "pr", "transition": "manual", "agent": "pr", "prompt": "Create PR for $BRANCH from $SOURCE_WORKTREE after $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/pr/AGENT.md"),
        "---\nagent_provider: claude\n---\nPR agent for $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let source_worktree = repo_root.join(".kanna-worktrees/task-source");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-source",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("auto-completion-same-task");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix stage promotion",
        Some("Fix stage promotion"),
        "commit",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    insert_finished_stage_run(
        &db,
        "task-1",
        "commit",
        "{\"status\":\"success\",\"summary\":\"committed\"}",
    );

    let prepared = super::prepare_auto_stage_completion_for_api(&db, &config, "task-1").unwrap();
    let run = match prepared {
        Some(PreparedStageTransition::Run(run)) => run,
        Some(PreparedStageTransition::Close { .. }) => panic!("expected in-place stage run"),
        None => panic!("expected auto transition"),
    };

    assert_eq!(run.task_id, "task-1");
    assert_eq!(run.next_stage, "pr");
    assert_eq!(run.cwd, source_worktree.to_string_lossy());
    let expected_prompt = format!(
        "PR agent for Fix stage promotion\n\nCreate PR for task-source from {} after {{\"status\":\"success\",\"summary\":\"committed\"}}",
        source_worktree.to_string_lossy()
    );
    match run.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(
                command.contains(expected_prompt.as_str()),
                "unexpected command: {command}"
            );
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected pty session"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_auto_stage_completion_parks_manual_stage() {
    let repo_root = init_git_repo_with_pipeline(
        "auto-completion-manual-park",
        "default",
        "in progress",
        "manual",
        "claude",
    );

    let config = test_config("auto-completion-manual-park");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix stage promotion",
        Some("Fix stage promotion"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"done\"}"),
        "claude",
    )
    .unwrap();

    let prepared = super::prepare_auto_stage_completion_for_api(&db, &config, "task-1").unwrap();
    assert!(
        prepared.is_none(),
        "manual stages must park instead of auto-advancing"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}
