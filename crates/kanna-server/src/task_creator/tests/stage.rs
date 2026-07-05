use super::*;

#[test]
fn builtin_qa_pipeline_ships_approve_as_pr_stage_post() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-builtin-qa-pipeline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();

    let pipeline =
        super::super::definitions::read_pipeline_definition(&repo_root.to_string_lossy(), "qa")
            .unwrap();

    let pr_stage = pipeline
        .stages
        .iter()
        .find(|stage| stage.name == "pr")
        .expect("qa pipeline should have a pr stage");
    let post = pr_stage.post.as_ref().expect("pr stage should have a post");
    assert_eq!(post.name, "approve");
    assert_eq!(post.agent.as_deref(), Some("approve"));
    assert!(post
        .prompt
        .as_deref()
        .unwrap_or_default()
        .contains("$PREV_RESULT"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

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
    assert_eq!(prepared.created_task.title, "Merge Master");

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
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
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
        kind: "main",
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
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
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
async fn prepare_advance_stage_forks_workspace_for_next_run_in_same_task() {
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
        kind: "main",
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
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
        PreparedStageTransition::Close { .. } => {
            panic!("stage advance must spawn a new run in place")
        }
    };

    assert_eq!(run.task_id, "task-1");
    assert_eq!(run.next_stage, "review");
    assert_eq!(run.session_id, "task-1");
    // The transition forks: same task, fresh branch + worktree from the
    // committed tip of task-source.
    let fork_branch = run
        .forked_workspace
        .as_ref()
        .expect("stage transition forks a workspace")
        .branch
        .clone();
    let fork_worktree = run.forked_workspace.as_ref().unwrap().worktree_path.clone();
    // Fork workspaces carry the durable task id plus a workspace counter:
    // the creation workspace is workspace 1, so the first fork is `-2`.
    assert_eq!(fork_branch, "task-task-1-2");
    assert_ne!(fork_branch, "task-source");
    assert_ne!(run.cwd, source_worktree.to_string_lossy());
    assert_eq!(run.cwd, fork_worktree);
    assert!(std::path::Path::new(&fork_worktree).is_dir());

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let advanced = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *run,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(advanced.task_id, "task-1");
    // Kill agent session, kill the stale worktree shell, spawn in the fork.
    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "task-1"
    ));
    assert!(matches!(
        commands.get(1),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "shell-wt-task-1"
    ));
    match commands.get(2) {
        Some(kanna_daemon::protocol::Command::Spawn {
            session_id, cwd, ..
        }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(cwd, &fork_worktree);
        }
        Some(kanna_daemon::protocol::Command::SpawnAgent { session_id, params }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(params.cwd, fork_worktree);
        }
        other => panic!("expected daemon spawn command, got {:?}", other),
    }

    let updated = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("review"));
    assert_eq!(updated.branch.as_deref(), Some(fork_branch.as_str()));
    assert_eq!(updated.closed_at, None);
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);
    assert_eq!(
        db.get_task_worktree_path("task-1").unwrap().as_deref(),
        Some(fork_worktree.as_str())
    );

    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].stage, "in progress");
    assert_eq!(runs[0].status, "succeeded");
    assert!(runs[0].finished_at.is_some());
    assert_eq!(runs[1].stage, "review");
    assert_eq!(runs[1].status, "running");
    assert_eq!(runs[1].session_id.as_deref(), Some("task-1"));

    // The counter skips workspaces that still exist: with `-2` live, the
    // next fork for this task is `-3`.
    assert_eq!(
        super::super::worktree::next_fork_branch(&repo_root.to_string_lossy(), "task-1").unwrap(),
        "task-task-1-3"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn stage_transition_tears_down_departed_stage_environment_before_repo_teardown() {
    let repo_root = init_git_repo("advance-stage-env-teardown");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "teardown": ["echo repo-teardown"]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "setup": ["echo env-setup"],
                    "teardown": ["echo env-teardown"]
                }
            },
            "stages": [
                { "name": "in progress", "transition": "manual", "environment": "dev" },
                { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $TASK_PROMPT" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nagent_provider: claude\n---\nReview agent.",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add teardown config"])
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

    let config = test_config("advance-stage-env-teardown");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Fix teardown",
        Some("Fix teardown"),
        "in progress",
        "2026-07-04 07:00:00",
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

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
        PreparedStageTransition::Close { .. } => panic!("expected stage run"),
    };
    let fork_worktree = run.forked_workspace.as_ref().unwrap().worktree_path.clone();

    let fake_daemon =
        spawn_fake_daemon_fork_transition_with_teardown(config.daemon_dir.clone()).await;
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

    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "task-1"
    ));
    assert!(matches!(
        commands.get(1),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "shell-wt-task-1"
    ));
    assert!(matches!(
        commands.get(2),
        Some(kanna_daemon::protocol::Command::Kill { session_id }) if session_id == "td-task-source"
    ));
    match commands.get(3) {
        Some(kanna_daemon::protocol::Command::Spawn {
            session_id, cwd, ..
        })
        | Some(kanna_daemon::protocol::Command::SpawnAgent {
            session_id,
            params: kanna_daemon::protocol::AgentSpawnParams { cwd, .. },
        }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(cwd, &fork_worktree);
        }
        other => panic!("expected next stage spawn, got {other:?}"),
    }
    match commands.get(4) {
        Some(kanna_daemon::protocol::Command::Spawn {
            session_id,
            cwd,
            args,
            ..
        }) => {
            assert_eq!(session_id, "td-task-source");
            assert_eq!(cwd, &source_worktree.to_string_lossy());
            let command = args.join(" ");
            let env_index = command
                .find("echo env-teardown")
                .expect("environment teardown command should be present");
            let repo_index = command
                .find("echo repo-teardown")
                .expect("repo teardown command should be present");
            assert!(
                env_index < repo_index,
                "environment teardown should run before repo teardown: {command}"
            );
        }
        other => panic!("expected teardown spawn, got {other:?}"),
    }

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
        PreparedStageTransition::Close { task_id, .. } => assert_eq!(task_id, "task-1"),
        PreparedStageTransition::Run(_) | PreparedStageTransition::Post(_) => {
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

    let prepared =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main")).unwrap();
    let run = match prepared {
        Some(PreparedStageTransition::Run(run)) => run,
        Some(PreparedStageTransition::Post(_)) => panic!("expected stage swap, got post dispatch"),
        Some(PreparedStageTransition::Close { .. }) => panic!("expected in-place stage run"),
        None => panic!("expected auto transition"),
    };

    assert_eq!(run.task_id, "task-1");
    assert_eq!(run.next_stage, "pr");
    // The auto transition forks; $BRANCH resolves to the fork (the branch
    // the next agent actually works on) while $SOURCE_WORKTREE still points
    // at the previous stage's worktree.
    let fork = run
        .forked_workspace
        .as_ref()
        .expect("auto transition forks");
    assert_eq!(run.cwd, fork.worktree_path);
    let expected_prompt = format!(
        "PR agent for Fix stage promotion\n\nCreate PR for {} from {} after {{\"status\":\"success\",\"summary\":\"committed\"}}",
        fork.branch,
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

    let prepared =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main")).unwrap();
    assert!(
        prepared.is_none(),
        "manual stages must park instead of auto-advancing"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

fn write_post_pipeline_fixtures(repo_root: &std::path::Path) {
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        serde_json::json!({
            "name": "default",
            "stages": [
                {
                    "name": "in progress",
                    "agent": "implement",
                    "prompt": "$TASK_PROMPT",
                    "policy": { "transition": "manual" },
                    "post": {
                        "name": "commit",
                        "agent": "commit",
                        "prompt": "Commit $TASK_PROMPT"
                    }
                },
                {
                    "name": "pr",
                    "agent": "pr",
                    "prompt": "Create PR for $BRANCH",
                    "policy": { "transition": "manual" }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nagent_provider: claude\n---\nImplement agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nagent_provider: claude\n---\nCommit agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/pr/AGENT.md"),
        "---\nagent_provider: claude\n---\nPR agent.",
    )
    .unwrap();
}

fn seed_post_pipeline_task(config: &Config, db: &Db, repo_root: &std::path::Path) {
    assert!(Command::new("git")
        .args(["branch", "task-source"])
        .current_dir(repo_root)
        .status()
        .unwrap()
        .success());
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
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "claude")
        .unwrap();
    let _ = config;
}

#[test]
fn prepare_advance_stage_dispatches_post_into_running_session() {
    let repo_root = init_git_repo("advance-dispatches-post");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("advance-dispatches-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-main",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        PreparedStageTransition::Run(_) => panic!("expected post dispatch, got stage swap"),
        PreparedStageTransition::Close { .. } => panic!("expected post dispatch, got close"),
    };

    assert_eq!(post.task_id, "task-1");
    assert_eq!(post.session_id, "task-1");
    assert_eq!(post.run_stage, "commit");
    // The injected message composes the post agent's body with the
    // substituted post prompt, plus the completion reminder.
    assert!(
        post.message.contains("Commit agent."),
        "message: {}",
        post.message
    );
    assert!(
        post.message.contains("Commit Fix it"),
        "message: {}",
        post.message
    );
    assert!(
        post.message
            .contains("kanna-cli stage-complete --task-id \"task-1\""),
        "message: {}",
        post.message
    );
    // The fallback spawn keeps the owning stage: a post never moves the
    // task's stage.
    assert_eq!(post.fallback.next_stage, "in progress");
    assert_eq!(post.fallback.run_stage, "commit");
    assert_eq!(post.fallback.run_kind, "post");
    assert_eq!(post.fallback.stage_agent.as_deref(), Some("commit"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_swaps_after_succeeded_post() {
    let repo_root = init_git_repo("advance-after-post-success");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("advance-after-post-success");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();
    db.finish_stage_run("run-post", "succeeded", None, None)
        .unwrap();

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("post already succeeded; expected swap"),
        PreparedStageTransition::Close { .. } => panic!("expected swap, got close"),
    };
    assert_eq!(run.next_stage, "pr");
    assert_eq!(run.run_kind, "main");
    // Stage transitions fork: fresh branch + worktree from the committed tip.
    let fork = run
        .forked_workspace
        .as_ref()
        .expect("swap forks a workspace");
    assert_ne!(fork.branch, "task-source");
    assert!(std::path::Path::new(&fork.worktree_path).is_dir());
    assert_eq!(run.cwd, fork.worktree_path);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_overrides_running_post_with_swap() {
    let repo_root = init_git_repo("advance-overrides-running-post");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("advance-overrides-running-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();

    // A second ⌘S while the post is still running is a human override.
    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("expected human override swap"),
        PreparedStageTransition::Close { .. } => panic!("expected swap, got close"),
    };
    assert_eq!(run.next_stage, "pr");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_redispatches_failed_post() {
    let repo_root = init_git_repo("advance-redispatches-failed-post");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("advance-redispatches-failed-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();
    db.finish_stage_run("run-post", "failed", None, None)
        .unwrap();

    match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => assert_eq!(post.run_stage, "commit"),
        PreparedStageTransition::Run(_) => panic!("failed post must be re-dispatched"),
        PreparedStageTransition::Close { .. } => panic!("expected post dispatch, got close"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn stage_completion_of_post_run_swaps_past_manual_gate() {
    let repo_root = init_git_repo("post-completion-swaps");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("post-completion-swaps");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);

    // A finished post always advances: the manual gate was already passed by
    // the advance that dispatched the post.
    let run = match super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("post"))
        .unwrap()
    {
        Some(PreparedStageTransition::Run(run)) => run,
        other => panic!(
            "expected swap after post completion, got {}",
            match other {
                Some(PreparedStageTransition::Post(_)) => "post dispatch",
                Some(PreparedStageTransition::Close { .. }) => "close",
                None => "park",
                Some(PreparedStageTransition::Run(_)) => unreachable!(),
            }
        ),
    };
    assert_eq!(run.next_stage, "pr");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn stage_completion_of_main_run_on_manual_stage_with_post_parks() {
    let repo_root = init_git_repo("main-completion-parks-with-post");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("main-completion-parks-with-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);

    // The implement agent's own success verdict parks the manual stage; the
    // post is dispatched only when the human (or an auto policy) advances.
    let prepared =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main")).unwrap();
    assert!(prepared.is_none());

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn legacy_task_parked_at_folded_post_stage_advances_past_owner() {
    let repo_root = init_git_repo("legacy-folded-post-advance");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("legacy-folded-post-advance");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    // Pinned snapshot from the first durable implementation: commit is an
    // interleaved continue stage, and the in-flight task is parked AT it.
    let snapshot = serde_json::json!({
        "name": "default",
        "stages": [
            { "name": "in progress", "agent": "implement", "prompt": "$TASK_PROMPT",
              "policy": { "transition": "manual" } },
            { "name": "commit", "agent": "commit", "prompt": "Commit $TASK_PROMPT",
              "policy": { "transition": "auto", "execution": "continue" } },
            { "name": "pr", "agent": "pr", "prompt": "Create PR for $BRANCH",
              "policy": { "transition": "manual" } }
        ]
    })
    .to_string();
    db.update_test_pipeline_item_pipeline_def("task-1", &snapshot)
        .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET stage = 'commit' WHERE id = 'task-1'",
            [],
        )
        .unwrap();

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("folded post position must swap past owner"),
        PreparedStageTransition::Close { .. } => panic!("expected swap, got close"),
    };
    assert_eq!(run.next_stage, "pr");

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn dispatch_post_injects_message_into_live_session_and_records_post_run() {
    let repo_root = init_git_repo("dispatch-post-live-session");
    write_post_pipeline_fixtures(&repo_root);

    let config = test_config("dispatch-post-live-session");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-main",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: Some("sonnet"),
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
    })
    .unwrap();

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        _ => panic!("expected post dispatch"),
    };

    // Message write + discrete Enter: exactly two Input commands.
    let fake_daemon = spawn_fake_daemon_input_ok(config.daemon_dir.clone(), 2).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let response = crate::task_creator::dispatch_prepared_post_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *post,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(response.task_id, "task-1");
    match &commands[0] {
        kanna_daemon::protocol::Command::Input { session_id, data } => {
            assert_eq!(session_id, "task-1");
            let text = String::from_utf8(data.clone()).unwrap();
            assert!(text.contains("Commit agent."), "input: {text}");
            assert!(text.contains("Commit Fix it"), "input: {text}");
        }
        other => panic!("expected Input, got {other:?}"),
    }
    match &commands[1] {
        kanna_daemon::protocol::Command::Input { session_id, data } => {
            assert_eq!(session_id, "task-1");
            assert_eq!(data, &vec![b'\r']);
        }
        other => panic!("expected Enter Input, got {other:?}"),
    }

    // The task never left its stage; the post run is attributed to the
    // session's actual agent (inherited from the running main run).
    let source = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(source.stage.as_deref(), Some("in progress"));
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].kind, "main");
    assert_eq!(runs[0].status, "succeeded");
    assert_eq!(runs[1].kind, "post");
    assert_eq!(runs[1].stage, "commit");
    assert_eq!(runs[1].status, "running");
    assert_eq!(runs[1].agent.as_deref(), Some("implement"));
    assert_eq!(runs[1].model.as_deref(), Some("sonnet"));
    assert_eq!(runs[1].session_id.as_deref(), Some("task-1"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn dispatch_post_falls_back_to_fresh_session_when_session_is_dead() {
    let repo_root = init_git_repo("dispatch-post-dead-session");
    write_post_pipeline_fixtures(&repo_root);

    let mut config = test_config("dispatch-post-dead-session");
    config.kanna_cli_path = Some("/tmp/kanna-cli".to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_pipeline_task(&config, &db, &repo_root);

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        _ => panic!("expected post dispatch"),
    };

    // Input -> session not found; the fallback then kills (also not found)
    // and spawns the post agent as a fresh session.
    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
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
                kanna_daemon::protocol::Command::Input { .. }
                | kanna_daemon::protocol::Command::Kill { .. } => {
                    kanna_daemon::protocol::Event::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    }
                }
                kanna_daemon::protocol::Command::Spawn { session_id, .. } => {
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            let done = matches!(&command, kanna_daemon::protocol::Command::Spawn { .. });
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            if done {
                break;
            }
        }
        commands
    });
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let response = crate::task_creator::dispatch_prepared_post_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *post,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(response.task_id, "task-1");
    let spawn = commands
        .iter()
        .find(|command| matches!(command, kanna_daemon::protocol::Command::Spawn { .. }))
        .expect("fallback spawn");
    match spawn {
        kanna_daemon::protocol::Command::Spawn {
            session_id, args, ..
        } => {
            assert_eq!(session_id, "task-1");
            let command_line = args.join(" ");
            assert!(
                command_line.contains("Commit agent."),
                "spawn: {command_line}"
            );
        }
        _ => unreachable!(),
    }

    let source = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(source.stage.as_deref(), Some("in progress"));
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    let post_run = runs.last().expect("post run recorded");
    assert_eq!(post_run.kind, "post");
    assert_eq!(post_run.stage, "commit");
    assert_eq!(post_run.status, "running");
    assert_eq!(post_run.agent.as_deref(), Some("commit"));

    let _ = std::fs::remove_dir_all(&repo_root);
}
