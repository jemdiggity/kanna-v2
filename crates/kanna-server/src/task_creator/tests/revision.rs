use super::*;

#[test]
#[ignore = "obsolete close-and-recreate revision task contract"]
fn prepare_revision_task_builds_target_stage_task_from_reviewed_branch() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-stage-revision-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
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
    std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("revision-stage-helper"),
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
        Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
        "copilot",
    )
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Add e2e coverage for task creation.",
    )
    .unwrap();

    assert_eq!(prepared.created_task.repo_id, "repo-1");
    assert_eq!(prepared.created_task.stage, "in progress");
    assert_eq!(prepared.created_task.title, "Mobile shell");
    assert_eq!(prepared.created_task.agent_type, "pty");
    let created_source = db
        .get_pipeline_item(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
    assert_eq!(created_source.agent_type.as_deref(), Some("pty"));
    assert_eq!(
            created_source.prompt.as_deref(),
            Some("Implement revision:\nAdd e2e coverage for task creation.\n\nAdd e2e coverage for task creation.")
        );
    assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
}

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
    let task_id = prepared.created_task.task_id.clone();
    let expected_session_id = prepared.session_id.clone();
    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();

    let created = spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, prepared)
        .await
        .unwrap();
    let command = fake_daemon.await.unwrap();

    assert_eq!(created.task_id, task_id);
    match command {
        kanna_daemon::protocol::Command::SpawnAgent { session_id, params } => {
            assert_eq!(session_id, expected_session_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            assert!(params.cwd.contains(".kanna-worktrees/task-"));
            let system_prompt = params.system_prompt.expect("system prompt should be sent");
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
async fn request_revision_spawns_target_stage_run_in_same_worktree_with_feedback() {
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
    db.insert_stage_run(
        "run-review",
        "review-task",
        "review",
        "running",
        Some("daemon-review"),
        None,
    )
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
    assert_eq!(prepared.feedback.as_deref(), Some("Fix the test gap before PR."));
    assert_eq!(prepared.cwd, worktree.to_string_lossy());

    let fake_daemon = spawn_fake_daemon_session_created_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let response = spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, prepared)
        .await
        .unwrap();
    let command = fake_daemon.await.unwrap();

    assert_eq!(response.task_id, "review-task");
    match command {
        kanna_daemon::protocol::Command::Spawn { args, cwd, .. } => {
            assert_eq!(cwd, worktree.to_string_lossy());
            assert!(args
                .last()
                .expect("shell command")
                .contains("Fix the test gap before PR."));
        }
        kanna_daemon::protocol::Command::SpawnAgent { params, .. } => {
            assert_eq!(params.cwd, worktree.to_string_lossy());
            assert!(params.prompt.contains("Fix the test gap before PR."));
        }
        other => panic!("expected daemon spawn command, got {:?}", other),
    }
    assert_eq!(
        std::fs::read_to_string(&uncommitted_file).unwrap(),
        "local edits survive revision"
    );
    let updated = db.get_task_stage_source("review-task").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("in progress"));
    assert_eq!(updated.branch.as_deref(), Some("task-reviewed"));
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

#[test]
#[ignore = "obsolete prompt-parsing title recovery contract"]
fn prepare_revision_task_recovers_title_from_reviewed_branch_when_review_title_is_missing() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-revision-title-recovery-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
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
    std::fs::write(
            repo_root.join(".kanna/pipelines/qa.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual", "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "auto" },
    { "name": "pr", "transition": "manual" }
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
    assert!(Command::new("git")
        .args(["branch", "task-review-branch"])
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
        db_path: Db::test_db_path("revision-title-recovery"),
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
    db.insert_test_pipeline_item(
        "source-task",
        "repo-1",
        "Original implementation instructions",
        Some("cloud/mobile"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "source-task",
        "task-reviewed-branch",
        "qa",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        "codex",
    )
    .unwrap();
    db.insert_test_pipeline_item(
            "review-task",
            "repo-1",
            "You are a QA review agent.\n\nReview branch task-reviewed-branch for task quality and test coverage against base origin/main. Original task: Original implementation instructions.",
            None,
            "review",
            "2026-04-17 07:01:00",
        )
        .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-review-branch",
        "qa",
        Some("{\"status\":\"failure\",\"summary\":\"missing e2e\"}"),
        "codex",
    )
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Add e2e coverage for task creation.",
    )
    .unwrap();
    let created_source = db
        .get_pipeline_item(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();

    assert_eq!(prepared.created_task.title, "cloud/mobile");
    assert_eq!(created_source.display_name.as_deref(), Some("cloud/mobile"));

    let _ = std::fs::remove_dir_all(&repo_root);
}
