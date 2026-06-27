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
fn prepare_advance_stage_builds_next_stage_task_from_previous_branch() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-stage-advance-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
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
    std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "pr", "transition": "manual", "agent": "reviewer", "prompt": "Review branch $BRANCH against $BASE_REF with result $PREV_RESULT" }
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
        .args(["commit", "-m", "add kanna config"])
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("advance-stage-helper"),
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
        "task-1",
        "repo-1",
        "Fix the mobile shell",
        Some("Mobile shell"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-old-branch",
        "default",
        Some("{\"status\":\"success\"}"),
        "copilot",
    )
    .unwrap();
    db.update_test_pipeline_item_base_ref("task-1", "origin/main")
        .unwrap();

    let prepared = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Spawn(prepared) => prepared,
        PreparedStageTransition::Continue(_) => panic!("expected new task transition"),
    };
    let created_source = db
        .get_task_stage_source(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();

    assert_eq!(prepared.created_task.repo_id, "repo-1");
    assert_eq!(prepared.created_task.stage, "pr");
    assert_eq!(prepared.created_task.title, "Mobile shell");
    assert_eq!(prepared.created_task.agent_type, "pty");
    assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
    assert_eq!(created_source.agent_type.as_deref(), Some("pty"));
    assert_eq!(
            created_source.prompt.as_deref(),
            Some("Review task: Fix the mobile shell\n\nReview branch task-old-branch against origin/main with result {\"status\":\"success\"}")
        );
    assert_eq!(created_source.base_ref.as_deref(), Some("origin/main"));
    assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
}

#[test]
fn prepare_advance_stage_uses_current_source_worktree_branch_after_rename() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-advance-renamed-source-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "pr", "transition": "manual", "agent": "reviewer", "prompt": "Review branch $BRANCH against $BASE_REF" }
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

    let source_worktree = repo_root.join(".kanna-worktrees/task-old-branch");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            source_worktree.to_string_lossy().as_ref(),
            "task-old-branch",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["branch", "-m", "renamed/source-branch"])
        .current_dir(&source_worktree)
        .status()
        .unwrap()
        .success());
    assert!(!Command::new("git")
        .args(["rev-parse", "--verify", "task-old-branch"])
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
        daemon_dir: std::env::temp_dir()
            .join(format!("kanna-daemon-continue-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
        db_path: Db::test_db_path("advance-stage-renamed-source"),
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
        "task-1",
        "repo-1",
        "Fix the mobile shell",
        Some("Mobile shell"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-old-branch",
        "default",
        Some("{\"status\":\"success\"}"),
        "copilot",
    )
    .unwrap();
    db.update_test_pipeline_item_base_ref("task-1", "origin/dev")
        .unwrap();

    let prepared = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Spawn(prepared) => prepared,
        PreparedStageTransition::Continue(_) => panic!("expected new task transition"),
    };

    assert_eq!(prepared.created_task.repo_id, "repo-1");
    assert_eq!(prepared.created_task.stage, "pr");
    assert_eq!(prepared.created_task.title, "Mobile shell");
    let created_source = db
        .get_task_stage_source(&prepared.created_task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(created_source.display_name.as_deref(), Some("Mobile shell"));
    assert_eq!(
            created_source.prompt.as_deref(),
            Some("Review task: Fix the mobile shell\n\nReview branch renamed/source-branch against origin/dev")
        );
    assert!(prepared.cwd.contains(".kanna-worktrees/task-"));
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prepare_advance_stage_continues_commit_stage_in_same_task_and_worktree() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-advance-continue-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "commit", "transition": "auto", "mode": "continue", "agent": "commit", "prompt": "Commit $TASK_PROMPT from $BRANCH after $PREV_RESULT" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nagent_provider: claude\n---\nCommit agent",
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("advance-stage-continue"),
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
    db.update_test_pipeline_item_agent_type("task-1", "sdk")
        .unwrap();

    let prepared = prepare_advance_stage_for_api(&db, &config, "task-1").unwrap();
    let continuation = match prepared {
        PreparedStageTransition::Continue(continuation) => continuation,
        PreparedStageTransition::Spawn(_) => panic!("expected continue transition"),
    };

    assert_eq!(continuation.task_id, "task-1");
    assert_eq!(continuation.agent_type, "agent");
    assert_eq!(continuation.previous_stage, "in progress");
    assert_eq!(continuation.next_stage, "commit");
    assert_eq!(
            String::from_utf8(continuation.input.clone()).unwrap(),
            "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
        );
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);
    db.insert_test_terminal_session("terminal-1", "repo-1", "task-1", "agent", "daemon-agent-1")
        .unwrap();

    let fake_daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let continued = continue_prepared_stage_for_api(&config.db_path, &mut daemon, *continuation)
        .await
        .unwrap();
    let command = fake_daemon.await.unwrap();
    assert_eq!(continued.task_id, "task-1");
    match command {
        kanna_daemon::protocol::Command::AgentInput { session_id, text } => {
            assert_eq!(session_id, "daemon-agent-1");
            assert_eq!(
                    text,
                    "Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}"
                );
        }
        other => panic!("expected daemon agent input command, got {:?}", other),
    }
    let updated_source = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(updated_source.stage.as_deref(), Some("commit"));
    assert_eq!(updated_source.branch.as_deref(), Some("task-source"));
    assert_eq!(updated_source.stage_result, None);
    assert_eq!(updated_source.closed_at, None);
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

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

#[tokio::test]
async fn prepare_advance_stage_enters_post_action_without_changing_stage() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-advance-post-action-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/default.json"),
        r#"{
  "stages": [
    {
      "name": "in progress",
      "transition": "manual",
      "post_action": {
        "name": "commit",
        "transition": "auto",
        "agent": "commit",
        "prompt": "Commit $TASK_PROMPT from $BRANCH after $PREV_RESULT"
      }
    },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nagent_provider: claude\n---\nCommit agent",
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: std::env::temp_dir()
            .join(format!("kanna-daemon-post-action-{}", std::process::id()))
            .to_string_lossy()
            .to_string(),
        db_path: Db::test_db_path("advance-stage-post-action"),
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

    let prepared = prepare_advance_stage_for_api(&db, &config, "task-1").unwrap();
    let continuation = match prepared {
        PreparedStageTransition::Continue(continuation) => continuation,
        PreparedStageTransition::Spawn(_) => panic!("expected post-action continuation"),
    };

    assert_eq!(continuation.task_id, "task-1");
    assert_eq!(continuation.previous_stage, "in progress");
    assert_eq!(continuation.next_stage, "in progress");
    assert_eq!(continuation.active_post_action.as_deref(), Some("commit"));
    assert_eq!(
            String::from_utf8(continuation.input.clone()).unwrap(),
            "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
        );

    let fake_daemon = spawn_fake_daemon_once(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let continued = continue_prepared_stage_for_api(&config.db_path, &mut daemon, *continuation)
        .await
        .unwrap();
    let command = fake_daemon.await.unwrap();
    assert_eq!(continued.task_id, "task-1");
    match command {
        kanna_daemon::protocol::Command::Input { session_id, data } => {
            assert_eq!(session_id, "task-1");
            assert_eq!(
                    String::from_utf8(data).unwrap(),
                    "\u{1b}[200~Commit agent\n\nCommit Fix stage promotion from task-source after {\"status\":\"success\",\"summary\":\"implemented\"}\u{1b}[201~\r"
                );
        }
        other => panic!("expected daemon input command, got {:?}", other),
    }
    let updated_source = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(updated_source.stage.as_deref(), Some("in progress"));
    assert_eq!(updated_source.active_post_action.as_deref(), Some("commit"));
    assert_eq!(updated_source.stage_result, None);
    assert_eq!(updated_source.closed_at, None);
    assert_eq!(db.list_pipeline_items("repo-1").unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_auto_stage_completion_from_commit_creates_pr_task_from_original_branch() {
    let repo_root = std::env::temp_dir().join(format!(
        "kanna-stage-auto-pr-after-continue-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna-worktrees")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
            repo_root.join(".kanna/pipelines/default.json"),
            r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "commit", "transition": "auto", "mode": "continue" },
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

    let config = Config {
        relay_url: "wss://relay.example".to_string(),
        device_token: "device-token".to_string(),
        firebase_project_id: "kanna-local".to_string(),
        firebase_auth_emulator_url: None,
        firebase_firestore_emulator_host: None,
        daemon_dir: "/tmp/kanna-daemon".to_string(),
        db_path: Db::test_db_path("auto-pr-after-continue"),
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
        "task-1",
        "repo-1",
        "Fix stage promotion",
        Some("Fix stage promotion"),
        "commit",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "task-1",
        "task-source",
        "default",
        Some("{\"status\":\"success\",\"summary\":\"committed\"}"),
        "claude",
    )
    .unwrap();
    db.update_test_pipeline_item_base_ref("task-1", "origin/main")
        .unwrap();

    let prepared = super::prepare_auto_stage_completion_for_api(&db, &config, "task-1").unwrap();
    let spawn = match prepared {
        Some(PreparedStageTransition::Spawn(spawn)) => spawn,
        Some(PreparedStageTransition::Continue(_)) => panic!("expected pr task spawn"),
        None => panic!("expected auto transition"),
    };

    assert_eq!(spawn.created_task.repo_id, "repo-1");
    assert_eq!(spawn.created_task.stage, "pr");
    assert_ne!(spawn.created_task.task_id, "task-1");
    assert_eq!(spawn.created_task.title, "Fix stage promotion");
    let created_source = db
        .get_task_stage_source(&spawn.created_task.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        created_source.display_name.as_deref(),
        Some("Fix stage promotion")
    );
    let expected_prompt = format!(
            "PR agent for Fix stage promotion\n\nCreate PR for task-source from {} after {{\"status\":\"success\",\"summary\":\"committed\"}}",
            source_worktree.to_string_lossy()
        );
    assert_eq!(
        created_source.prompt.as_deref(),
        Some(expected_prompt.as_str())
    );
    assert!(spawn.cwd.contains(".kanna-worktrees/task-"));
    assert!(!spawn.cwd.ends_with("task-source"));
    assert_eq!(created_source.base_ref.as_deref(), Some("origin/main"));

    let _ = std::fs::remove_dir_all(&repo_root);
}
