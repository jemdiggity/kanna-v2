use super::*;

#[tokio::test]
async fn prepared_revision_agent_task_spawn_sends_task_specific_kanna_context() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-revision-spawn-context-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "auto", "agent_provider": "claude", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
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
        .args(["branch", "task-reviewed-branch"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("revision-agent-spawn-kanna-context");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Review branch task-reviewed-branch.",
        Some("Mobile shell"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-reviewed-branch",
        "qa",
        Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
        "claude",
    )
    .unwrap();
    db.update_test_pipeline_item_agent_type("review-task", "agent")
        .unwrap();
    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Add integration coverage for spawned Kanna context.",
    )
    .unwrap();
    let task_id = prepared.task_id.clone();
    let expected_session_id = prepared.session_id.clone();
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    let created = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(created.task_id, task_id);
    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::Kill { .. })
    ));
    match commands.into_iter().last().expect("respawn command") {
        kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
            assert_eq!(session_id, &expected_session_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            assert!(params.cwd.contains(".kanna-worktrees/task-"));
            let system_prompt = params
                .system_prompt
                .as_ref()
                .expect("system prompt should be sent");
            assert!(system_prompt.contains(&format!("task `{task_id}`")));
            assert!(system_prompt.contains("stage `in progress`"));
            assert!(system_prompt.contains("pipeline `qa`"));
            assert!(system_prompt.contains("transition `auto`"));
            assert!(system_prompt.contains("instance-local `kanna-mcp` config is available"));
            assert!(system_prompt.contains("Claude is launched with this config"));
            assert!(system_prompt.contains("Prefer `kanna-mcp` tools for Kanna task operations"));
            assert!(system_prompt.contains(
                "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`"
            ));
            assert!(system_prompt.contains("kanna-cli guide"));
            assert!(system_prompt.contains("kanna-cli stage-complete"));
            assert!(system_prompt.contains("KANNA_CLI_PATH"));
        }
        other => panic!("expected SpawnAgent, got {other:?}"),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn request_revision_forks_workspace_for_target_stage_run_with_feedback() {
    let repo_root = init_git_repo("revision-same-worktree-feedback");
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/qa.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add qa pipeline"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "task-reviewed"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let worktree = repo_root.join(".kanna-worktrees/task-reviewed");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            worktree.to_string_lossy().as_ref(),
            "task-reviewed",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let uncommitted_file = worktree.join("needs-to-survive.txt");
    std::fs::write(&uncommitted_file, "local edits survive revision").unwrap();

    let config = test_config("revision-same-worktree-feedback");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Original implementation prompt",
        Some("Original task"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-reviewed",
        "qa",
        Some("{\"status\":\"failure\",\"summary\":\"needs fixes\"}"),
        "claude",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-review-task",
        "review-task",
        &worktree.to_string_lossy(),
        "task-reviewed",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-review",
        task_id: "review-task",
        stage: "review",
        kind: "main",
        agent: None,
        agent_provider: None,
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("daemon-review"),
    })
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Fix the test gap before PR.",
    )
    .unwrap();

    assert_eq!(prepared.task_id, "review-task");
    assert_eq!(prepared.next_stage, "in progress");
    assert_eq!(
        prepared.feedback.as_deref(),
        Some("Fix the test gap before PR.")
    );
    // Revisions fork like any other stage transition: fresh branch and
    // worktree from the committed tip. Only committed work crosses the
    // boundary.
    let fork = prepared
        .forked_workspace
        .as_ref()
        .expect("revision forks a workspace");
    let fork_branch = fork.branch.clone();
    let fork_worktree = fork.worktree_path.clone();
    assert_ne!(fork_worktree, worktree.to_string_lossy());
    assert_eq!(prepared.cwd, fork_worktree);

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let response = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    assert_eq!(response.task_id, "review-task");
    assert!(matches!(
        commands.first(),
        Some(kanna_daemon::protocol::Command::Kill { .. })
    ));
    match commands.into_iter().last().expect("respawn command") {
        kanna_daemon::protocol::Command::Spawn { args, cwd, .. } => {
            assert_eq!(cwd, fork_worktree);
            assert!(args
                .last()
                .expect("shell command")
                .contains("Fix the test gap before PR."));
        }
        kanna_daemon::protocol::Command::SpawnAgent { params, .. } => {
            assert_eq!(params.cwd, fork_worktree);
            assert!(params.prompt.contains("Fix the test gap before PR."));
        }
        other => panic!("expected daemon spawn command, got {:?}", other),
    }
    // The previous worktree (and its uncommitted scratch) stays on disk
    // untouched until cleanup; the fork contains committed work only.
    assert_eq!(
        std::fs::read_to_string(&uncommitted_file).unwrap(),
        "local edits survive revision"
    );
    assert!(!std::path::Path::new(&fork_worktree)
        .join("needs-to-survive.txt")
        .exists());
    let updated = db.get_task_stage_source("review-task").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("in progress"));
    assert_eq!(updated.branch.as_deref(), Some(fork_branch.as_str()));
    assert_eq!(updated.closed_at, None);
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_revision_task_rejects_closed_source_task_even_when_stage_is_active() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-revision-closed-source-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/qa.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
    )
    .unwrap();

    let config = test_config("revision-stage-closed-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Fix the mobile shell",
        Some("Mobile shell"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-reviewed-branch",
        "qa",
        Some("{\"status\":\"failure\",\"summary\":\"needs revision\"}"),
        "claude",
    )
    .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
            ["review-task"],
        )
        .unwrap();

    let err = match prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Add more tests",
    ) {
        Ok(_) => panic!("closed task should not prepare a revision task"),
        Err(err) => err,
    };

    assert!(
        err.contains("task is closed: review-task"),
        "unexpected error: {err}"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}
