use super::*;

#[test]
fn revision_resume_message_follows_target_stage_transition() {
    let manual = build_revision_resume_message(
        "Original prompt",
        "Add coverage.",
        "task-1",
        PipelineStageTransition::Manual,
        None,
    );
    assert!(manual.contains("do not record stage completion"));
    assert!(
        manual.contains("kanna_complete_stage {\"task_id\": \"task-1\", \"status\": \"failure\"")
    );
    assert!(manual.contains("--status failure"));
    assert!(!manual.contains("--status success"));
    assert!(!manual.contains("Kanna will then advance"));

    let auto = build_revision_resume_message(
        "Original prompt",
        "Add coverage.",
        "task-1",
        PipelineStageTransition::Auto,
        None,
    );
    assert!(auto.contains("record stage completion"));
    assert!(auto.contains("kanna_complete_stage {\"task_id\": \"task-1\", \"status\": \"success\""));
    assert!(auto.contains("--status success"));
    assert!(auto.contains("Kanna will then advance this task's pipeline."));
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
    { "name": "in progress", "policy": { "transition": "manual", "revision_transition": "auto" }, "agent_provider": "claude", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" },
    { "name": "pr", "transition": "manual" }
  ]
}"#,
        )
        .unwrap();
    install_test_provider_binaries(&repo_root);
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
    publish_origin_main(&repo_root, "publish revision spawn definitions");
    assert!(Command::new("git")
        .args(["branch", "task-review-task-2ed-branch"])
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
        "Review branch task-review-task-2ed-branch.",
        Some("Mobile shell"),
        "review",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-review-task-2ed-branch",
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
        None,
    )
    .unwrap();
    assert!(
        prepared.terminal_prelude.is_none(),
        "revision spawns must not be labeled as forward stage advances"
    );
    assert_eq!(
        prepared.completion_transition,
        PipelineStageTransition::Auto
    );
    let task_id = prepared.task_id.clone();
    let expected_session_id = prepared.session_id.clone();
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
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
            assert_eq!(session_id, expected_session_id);
            assert_eq!(params.agent_provider, DaemonAgentProvider::Claude);
            assert!(params.cwd.contains(".kanna-worktrees/task-"));
            let system_prompt = params
                .system_prompt
                .as_ref()
                .expect("system prompt should be sent");
            assert!(system_prompt.contains(&format!("task `{task_id}`")));
            assert!(system_prompt.contains("stage `in progress`"));
            assert!(system_prompt.contains("pipeline `qa`"));
            assert!(system_prompt.contains("(transition: `auto`)"));
            assert!(system_prompt.contains("## Kanna Task Environment"));
            assert!(system_prompt.contains("Prefer the `kanna_*` MCP tools"));
            assert!(system_prompt
                .contains("If MCP tools are unavailable, fall back to the `kanna-cli` binary"));
            assert!(system_prompt.contains("kanna-cli guide"));
            assert!(system_prompt.contains("kanna-cli stage-complete"));
            assert!(system_prompt.contains("KANNA_CLI_PATH"));
        }
        other => panic!("expected SpawnAgent, got {other:?}"),
    }

    let revision_run = db.latest_stage_run(&task_id).unwrap().unwrap();
    assert_eq!(revision_run.completion_transition.as_deref(), Some("auto"));

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
    { "name": "in progress", "policy": { "transition": "manual", "revision_transition": "auto" }, "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        "---\nname: implement\ndescription: Implements requested revisions\nagent_provider: claude\n---\nImplement revision:\n$TASK_PROMPT",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish revision feedback definitions");
    assert!(Command::new("git")
        .args(["branch", "task-review-task-2ed"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    let worktree = repo_root.join(".kanna-worktrees/task-review-task-2ed");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            worktree.to_string_lossy().as_ref(),
            "task-review-task-2ed",
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
        "task-review-task-2ed",
        "qa",
        Some("{\"status\":\"failure\",\"summary\":\"needs fixes\"}"),
        "claude",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-review-task",
        "review-task",
        &worktree.to_string_lossy(),
        "task-review-task-2ed",
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
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Fix the test gap before PR.",
        None,
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
        .forked_workspace()
        .expect("revision forks a workspace");
    let fork_branch = fork.branch.clone();
    let fork_worktree = fork.worktree_path.clone();
    assert_ne!(fork_worktree, worktree.to_string_lossy());
    assert_eq!(prepared.cwd, fork_worktree);

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
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
    let config = test_config("revision-stage-closed-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
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
        "task-review-task-2ed-branch",
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
        None,
    ) {
        Ok(_) => panic!("closed task should not prepare a revision task"),
        Err(err) => err,
    };

    assert!(
        err.contains("task is closed: review-task"),
        "unexpected error: {err}"
    );
}

/// Repo with a claude implement stage, an implement worktree (`task-review-task`)
/// holding a finished stage run, and a review worktree (`task-review-task-2`) at the
/// same committed tip — the state a task is in when the review agent
/// requests a revision.
pub(crate) fn init_resume_revision_fixture(
    label: &str,
    config: &Config,
) -> (std::path::PathBuf, Db) {
    init_resume_revision_fixture_for_provider(label, config, "claude")
}

fn init_resume_revision_fixture_for_provider(
    label: &str,
    config: &Config,
    provider: &str,
) -> (std::path::PathBuf, Db) {
    let repo_root = init_git_repo(label);
    std::fs::create_dir_all(repo_root.join(".kanna/pipelines")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/pipelines/qa.json"),
        r#"{
  "stages": [
    { "name": "in progress", "policy": { "transition": "manual", "revision_transition": "auto" }, "agent": "implement", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/implement/AGENT.md"),
        format!(
            "---\nname: implement\ndescription: Implements resumed revisions\nagent_provider: {provider}\n---\nImplement revision:\n$TASK_PROMPT"
        ),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish resume revision definitions");
    for branch in ["task-review-task", "task-review-task-2"] {
        run_git_fixture(&repo_root, &["branch", branch]);
    }
    for branch in ["task-review-task", "task-review-task-2"] {
        let worktree = repo_root.join(".kanna-worktrees").join(branch);
        assert!(Command::new("git")
            .args([
                "worktree",
                "add",
                worktree.to_string_lossy().as_ref(),
                branch
            ])
            .current_dir(&repo_root)
            .status()
            .unwrap()
            .success());
    }

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Original implementation prompt",
        Some("Original task"),
        "review",
        "2026-07-04 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-review-task-2",
        "qa",
        None,
        provider,
    )
    .unwrap();
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    db.insert_stage_run(NewStageRun {
        id: "run-impl",
        task_id: "review-task",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some(provider),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("review-task"),
        provider_session_id: Some(RESUME_SESSION_UUID),
        cwd: Some(impl_worktree.to_string_lossy().as_ref()),
        resumed_from_run_id: None,
    })
    .unwrap();
    db.finish_stage_run(
        "run-impl",
        "succeeded",
        Some("{\"status\":\"success\"}"),
        None,
    )
    .unwrap();
    (repo_root, db)
}

const RESUME_SESSION_UUID: &str = "6f7d2f7a-1b2e-4c3d-9a8b-123456789abc";

/// Points the Claude session store at a test directory and writes the
/// transcript file the CLI would have for `RESUME_SESSION_UUID` under the
/// implement worktree.
pub(crate) fn write_resume_transcript(config_dir: &std::path::Path, worktree: &std::path::Path) {
    let slug: String = worktree
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let project_dir = config_dir.join("projects").join(slug);
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(
        project_dir.join(format!("{RESUME_SESSION_UUID}.jsonl")),
        "{}\n",
    )
    .unwrap();
}

#[tokio::test]
async fn request_revision_resumes_previous_stage_run_session_in_its_worktree() {
    let config = test_config("revision-resume-happy");
    let (repo_root, db) = init_resume_revision_fixture("revision-resume-happy", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &impl_worktree);

    // The env guard is scoped to the prepare call: CLAUDE_CONFIG_DIR only
    // matters while the transcript precondition runs, and the guard must not
    // be held across the daemon awaits below.
    let prepared = {
        let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Add e2e coverage for the revision loop.",
            None,
        );
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        prepared.unwrap()
    };

    // The revision adopts the implement run's workspace instead of forking.
    let resumed = prepared
        .resumed_workspace()
        .expect("revision resumes the previous workspace");
    assert_eq!(resumed.branch, "task-review-task");
    assert_eq!(resumed.worktree_path, impl_worktree.to_string_lossy());
    assert!(prepared.forked_workspace().is_none());
    assert_eq!(prepared.cwd, impl_worktree.to_string_lossy());
    assert_eq!(prepared.run_kind, "main");
    assert_eq!(prepared.next_stage, "in progress");
    assert_eq!(
        prepared.completion_transition,
        PipelineStageTransition::Auto
    );
    assert_eq!(
        prepared.feedback.as_deref(),
        Some("Add e2e coverage for the revision loop.")
    );

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
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
    match commands.into_iter().last().expect("respawn command") {
        kanna_daemon::protocol::Command::Spawn { args, cwd, .. } => {
            assert_eq!(cwd, impl_worktree.to_string_lossy());
            let command_line = args.last().expect("shell command").clone();
            // The resumed session reopens the recorded conversation and gets
            // the composed revision message as its next user prompt.
            assert!(command_line.contains(&format!("--resume '{RESUME_SESSION_UUID}'")));
            assert!(!command_line.contains("--session-id"));
            assert!(command_line.contains("Original task:\nOriginal implementation prompt"));
            assert!(command_line
                .contains("Reviewer feedback:\nAdd e2e coverage for the revision loop."));
            // The ordinary stage is manual, but reviewer-requested revisions
            // use the explicit automatic revision policy.
            assert!(command_line.contains("record stage completion"));
            assert!(command_line.contains("kanna_complete_stage"));
            assert!(command_line.contains("--status success"));
            assert!(!command_line.contains("do not record stage completion"));
        }
        other => panic!("expected PTY spawn command, got {:?}", other),
    }

    // The task's branch moves back to the adopted workspace, and the run
    // records how it resumed.
    let updated = db.get_task_stage_source("review-task").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("in progress"));
    assert_eq!(updated.branch.as_deref(), Some("task-review-task"));
    let runs = db.list_stage_runs_for_task("review-task").unwrap();
    let revision_run = runs.last().expect("revision run recorded");
    assert_eq!(revision_run.stage, "in progress");
    assert_eq!(revision_run.kind, "main");
    assert_eq!(revision_run.status, "running");
    assert_eq!(revision_run.completion_transition.as_deref(), Some("auto"));
    assert_eq!(
        revision_run.provider_session_id.as_deref(),
        Some(RESUME_SESSION_UUID)
    );
    assert_eq!(
        revision_run.resumed_from_run_id.as_deref(),
        Some("run-impl")
    );
    assert_eq!(
        revision_run.cwd.as_deref(),
        Some(impl_worktree.to_string_lossy().as_ref())
    );
    // The implement worktree survives — nothing forked, nothing rolled back.
    assert!(impl_worktree.is_dir());
    let agent_session_id: Option<String> = Connection::open(&config.db_path)
        .unwrap()
        .query_row(
            "SELECT agent_session_id FROM pipeline_item WHERE id = 'review-task'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_session_id.as_deref(), Some(RESUME_SESSION_UUID));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn failed_owned_kill_restores_source_run_so_revision_can_retry() {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    let config = test_config("revision-owned-kill-retry");
    let (repo_root, db) = init_resume_revision_fixture("revision-owned-kill-retry", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    let review_worktree = repo_root.join(".kanna-worktrees/task-review-task-2");
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &impl_worktree);
    db.insert_stage_run(NewStageRun {
        id: "run-review",
        task_id: "review-task",
        stage: "review",
        kind: "main",
        agent: Some("review"),
        agent_provider: Some("claude"),
        model: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("review-task"),
        provider_session_id: Some("review-provider-session"),
        cwd: Some(review_worktree.to_string_lossy().as_ref()),
        resumed_from_run_id: None,
    })
    .unwrap();

    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Retry after a transient kill failure.",
    )
    .unwrap();
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let failed_kill_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for response in [
            kanna_daemon::protocol::Event::SessionList {
                sessions: Vec::new(),
                capabilities: Some(kanna_daemon::protocol::DaemonCapabilities::current()),
            },
            kanna_daemon::protocol::Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
                message: "transient kill failure".to_string(),
            },
        ] {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
    });
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let error = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap_err();
    failed_kill_daemon.await.unwrap();
    assert!(error.contains("transient kill failure"));

    let runs = db.list_stage_runs_for_task("review-task").unwrap();
    assert_eq!(
        runs.len(),
        2,
        "failed successor reservation must be removed"
    );
    assert_eq!(runs.last().unwrap().id, "run-review");
    assert_eq!(runs.last().unwrap().status, "running");

    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    let retry = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Retry after a transient kill failure.",
    )
    .unwrap();
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let retry_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        retry,
    )
    .await
    .unwrap();
    retry_daemon.await.unwrap();

    let revision_run = db.latest_stage_run("review-task").unwrap().unwrap();
    assert_eq!(revision_run.stage, "in progress");
    assert_eq!(revision_run.status, "running");
    assert_eq!(
        revision_run.resumed_from_run_id.as_deref(),
        Some("run-impl")
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn old_daemon_cannot_record_a_resumed_revision_run() {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    let config = test_config("revision-resume-old-daemon");
    let (repo_root, db) = init_resume_revision_fixture("revision-resume-old-daemon", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &impl_worktree);
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Retry safely against a legacy daemon.",
    )
    .unwrap();
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<kanna_daemon::protocol::Command>(line.trim()).unwrap(),
            kanna_daemon::protocol::Command::List
        ));
        let response = serde_json::to_string(&kanna_daemon::protocol::Event::SessionList {
            sessions: Vec::new(),
            capabilities: None,
        })
        .unwrap();
        write_half.write_all(response.as_bytes()).await.unwrap();
        write_half.write_all(b"\n").await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), listener.accept())
                .await
                .is_err(),
            "resume rejection must not open another daemon connection"
        );
    });

    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let error = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap_err();
    fake_daemon.await.unwrap();

    assert!(error.contains("daemon does not support provider resume"));
    assert_eq!(db.list_stage_runs_for_task("review-task").unwrap().len(), 1);
    assert_eq!(
        db.get_task_stage_source("review-task")
            .unwrap()
            .unwrap()
            .stage
            .as_deref(),
        Some("review")
    );
    assert!(impl_worktree.is_dir());
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn request_revision_resumes_supported_provider_sessions_in_their_worktree() {
    for (provider, command_fragment) in [
        ("codex", "test-provider-bin/codex' resume "),
        ("opencode", "run --interactive --session"),
        ("copilot", "--resume="),
        ("antigravity", "--conversation"),
    ] {
        let label = format!("revision-resume-{provider}");
        let config = test_config(&label);
        let (repo_root, db) = init_resume_revision_fixture_for_provider(&label, &config, provider);
        let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");

        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Address the provider-neutral review feedback.",
        )
        .unwrap();

        assert_eq!(prepared.agent_provider, provider);
        assert!(prepared.forked_workspace().is_none());
        assert_eq!(
            prepared
                .resumed_workspace()
                .expect("supported provider should resume")
                .branch,
            "task-review-task"
        );
        assert_eq!(prepared.cwd, impl_worktree.to_string_lossy());
        assert_eq!(
            prepared.provider_session_id.as_deref(),
            Some(RESUME_SESSION_UUID)
        );
        assert_eq!(prepared.resumed_from_run_id.as_deref(), Some("run-impl"));
        match &prepared.session {
            PreparedSessionSpawn::Pty { args, .. } => {
                let command = args.last().expect("shell command");
                assert!(
                    command.contains(command_fragment),
                    "{provider} command did not contain {command_fragment:?}: {command}"
                );
                assert!(command.contains("Address the provider-neutral review feedback."));
            }
            PreparedSessionSpawn::Agent { .. } => panic!("expected PTY session for {provider}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[test]
fn request_revision_resumes_supported_headless_provider_sessions() {
    for provider in ["codex", "opencode"] {
        let label = format!("revision-resume-headless-{provider}");
        let config = test_config(&label);
        let (repo_root, db) = init_resume_revision_fixture_for_provider(&label, &config, provider);
        db.update_test_pipeline_item_agent_type("review-task", "agent")
            .unwrap();

        let prepared = prepare_revision_task_for_api(
            &db,
            &config,
            "review-task",
            "in progress",
            "Continue the headless provider session.",
        )
        .unwrap();

        assert!(prepared.forked_workspace().is_none());
        assert_eq!(prepared.agent_provider, provider);
        assert_eq!(
            prepared.provider_session_id.as_deref(),
            Some(RESUME_SESSION_UUID)
        );
        match &prepared.session {
            PreparedSessionSpawn::Agent {
                resume_session_id,
                prompt,
                ..
            } => {
                assert_eq!(resume_session_id.as_deref(), Some(RESUME_SESSION_UUID));
                assert!(prompt.contains("Continue the headless provider session."));
            }
            PreparedSessionSpawn::Pty { .. } => panic!("expected headless session for {provider}"),
        }

        let _ = std::fs::remove_dir_all(&repo_root);
    }
}

#[tokio::test]
async fn request_revision_falls_back_to_fork_when_worktree_tip_diverged() {
    let config = test_config("revision-resume-diverged");
    let (repo_root, db) = init_resume_revision_fixture("revision-resume-diverged", &config);
    // The review worktree commits ahead of the implement worktree: the
    // recorded workspace no longer holds the task's committed tip.
    let review_worktree = repo_root.join(".kanna-worktrees/task-review-task-2");
    std::fs::write(review_worktree.join("review-fix.txt"), "fixed in review").unwrap();
    for args in [
        vec!["add", "review-fix.txt"],
        vec!["commit", "-m", "review fix"],
    ] {
        assert!(Command::new("git")
            .args(&args)
            .current_dir(&review_worktree)
            .status()
            .unwrap()
            .success());
    }

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Address the review fixes.",
        None,
    )
    .unwrap();

    assert!(prepared.resumed_workspace().is_none());
    let fork = prepared
        .forked_workspace()
        .expect("diverged tip falls back to a fresh fork");
    assert_ne!(fork.branch, "task-review-task");
    // The fresh agent still sees the original task prompt via the composed
    // revision context.
    match &prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command_line = args.last().expect("shell command");
            assert!(command_line.contains("--session-id"));
            assert!(!command_line.contains("--resume"));
            assert!(command_line.contains("Original task:\nOriginal implementation prompt"));
            assert!(command_line.contains("Reviewer feedback:\nAddress the review fixes."));
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected PTY session, got agent session"),
    }
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn request_revision_falls_back_when_recorded_workspace_is_substituted_at_same_head() {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    let config = test_config("revision-resume-substituted");
    let (repo_root, db) = init_resume_revision_fixture("revision-resume-substituted", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    let original_head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&impl_worktree)
        .output()
        .unwrap();
    assert!(original_head.status.success());
    let original_head = String::from_utf8_lossy(&original_head.stdout)
        .trim()
        .to_string();

    // Replace the recorded path with a different registered worktree at the
    // exact same commit. A HEAD-only check cannot distinguish this foreign
    // workspace from the implementation run's original workspace.
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "remove",
            "--force",
            impl_worktree.to_string_lossy().as_ref(),
        ],
    );
    run_git_fixture(
        &repo_root,
        &["branch", "substituted-workspace", &original_head],
    );
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            impl_worktree.to_string_lossy().as_ref(),
            "substituted-workspace",
        ],
    );

    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &impl_worktree);
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Do not resume in a substituted worktree.",
    );
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let prepared = prepared.unwrap();

    assert!(prepared.resumed_workspace().is_none());
    assert_ne!(
        prepared.provider_session_id.as_deref(),
        Some(RESUME_SESSION_UUID)
    );
    let fork = prepared
        .forked_workspace()
        .expect("substituted worktree must force a fresh fork");
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn request_revision_falls_back_to_fork_without_cli_transcript() {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    let config = test_config("revision-resume-no-transcript");
    let (repo_root, db) = init_resume_revision_fixture("revision-resume-no-transcript", &config);
    // Session store exists but holds no transcript for the recorded session.
    let claude_config_dir = repo_root.join("claude-config");
    std::fs::create_dir_all(claude_config_dir.join("projects")).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Add e2e coverage.",
        None,
    );
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let prepared = prepared.unwrap();

    assert!(prepared.resumed_workspace().is_none());
    let fork = prepared
        .forked_workspace()
        .expect("missing transcript falls back to a fresh fork");
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn revision_does_not_skip_newer_null_handle_main_run() {
    let _env_guard = super::CLAUDE_CONFIG_DIR_LOCK.lock().unwrap();
    let config = test_config("revision-resume-newer-null-handle");
    let (repo_root, db) =
        init_resume_revision_fixture("revision-resume-newer-null-handle", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-review-task");
    let claude_config_dir = repo_root.join("claude-config");
    write_resume_transcript(&claude_config_dir, &impl_worktree);
    std::env::set_var("CLAUDE_CONFIG_DIR", &claude_config_dir);
    db.insert_stage_run(NewStageRun {
        id: "run-newer-codex",
        task_id: "review-task",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        status: "succeeded",
        result: Some("{\"status\":\"success\"}"),
        feedback: None,
        session_id: Some("review-task"),
        provider_session_id: None,
        cwd: Some(impl_worktree.to_string_lossy().as_ref()),
        resumed_from_run_id: None,
    })
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Do not resume stale Claude work.",
    )
    .unwrap();
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    assert!(prepared.resumed_workspace().is_none());
    assert_ne!(
        prepared.provider_session_id.as_deref(),
        Some(RESUME_SESSION_UUID)
    );
    let fork = prepared
        .forked_workspace()
        .expect("newest null-handle run must force a fresh fork");
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn revision_does_not_resume_provider_removed_from_current_stage_definition() {
    let config = test_config("revision-provider-changed");
    let (repo_root, db) =
        init_resume_revision_fixture_for_provider("revision-provider-changed", &config, "claude");
    let codex_pipeline = r#"{
  "stages": [
    { "name": "in progress", "policy": { "transition": "manual", "revision_transition": "auto" }, "agent": "implement", "agent_provider": "codex", "prompt": "$TASK_PROMPT" },
    { "name": "review", "transition": "manual" }
  ]
}"#;
    std::fs::write(repo_root.join(".kanna/pipelines/qa.json"), codex_pipeline).unwrap();
    publish_origin_main(&repo_root, "change revision provider to codex");

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Use the current provider definition.",
    )
    .unwrap();

    assert!(prepared.resumed_workspace().is_none());
    assert_eq!(prepared.agent_provider, "codex");
    let fork = prepared
        .forked_workspace()
        .expect("provider mismatch must force a fresh fork");
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn request_revision_keeps_the_task_provider_over_agent_def_priority() {
    // The built-in implement def lists several providers (codex first); a
    // revision continues work the task already did with its own provider and
    // must not switch. Caught live: an opencode task's revision spawned codex.
    let repo_root = init_git_repo("revision-provider-inherit");
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
        "---\nname: implement\ndescription: Implements provider inheritance revisions\nagent_provider: codex, claude, copilot, opencode, antigravity\n---\nImplement:\n$TASK_PROMPT",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish provider inheritance definitions");
    run_git_fixture(&repo_root, &["branch", "task-review-task-2ed"]);
    let worktree = repo_root.join(".kanna-worktrees/task-review-task-2ed");
    assert!(Command::new("git")
        .args([
            "worktree",
            "add",
            worktree.to_string_lossy().as_ref(),
            "task-review-task-2ed",
        ])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("revision-provider-inherit");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "review-task",
        "repo-1",
        "Create hello.txt",
        Some("Provider inherit"),
        "review",
        "2026-07-05 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        "review-task",
        "task-review-task-2ed",
        "qa",
        None,
        "opencode",
    )
    .unwrap();

    let prepared = prepare_revision_task_for_api(
        &db,
        &config,
        "review-task",
        "in progress",
        "Also create goodbye.txt.",
        None,
    )
    .unwrap();

    assert_eq!(prepared.agent_provider, "opencode");

    if let Some(fork) = prepared.forked_workspace() {
        let _ = crate::task_creator::worktree::remove_prepared_worktree(
            &fork.worktree_path,
            &fork.branch,
        );
    }
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn pipeline_revision_limit_defaults_and_can_be_overridden() {
    let stored_without_limit = serde_json::json!({
        "name": "stored",
        "stages": [{ "name": "in progress", "transition": "manual" }]
    })
    .to_string();
    let pipeline =
        super::super::definitions::parse_stored_pipeline_definition(&stored_without_limit).unwrap();
    // Pinned snapshots written before the field existed inherit the default,
    // so in-flight tasks are bounded too.
    assert_eq!(
        pipeline.revision_limit(),
        super::super::definitions::DEFAULT_REVISION_LIMIT
    );

    let stored_with_limit = serde_json::json!({
        "name": "stored",
        "revision_limit": 1,
        "stages": [{ "name": "in progress", "transition": "manual" }]
    })
    .to_string();
    let pipeline =
        super::super::definitions::parse_stored_pipeline_definition(&stored_with_limit).unwrap();
    assert_eq!(pipeline.revision_limit(), 1);

    let stored_unlimited = serde_json::json!({
        "name": "stored",
        "revision_limit": 0,
        "stages": [{ "name": "in progress", "transition": "manual" }]
    })
    .to_string();
    let pipeline =
        super::super::definitions::parse_stored_pipeline_definition(&stored_unlimited).unwrap();
    assert_eq!(pipeline.revision_limit(), 0);
}

#[test]
fn negative_pipeline_revision_limit_is_a_definition_error() {
    // Both parser entry points (repo pipeline files and pinned pipeline_def
    // snapshots) funnel through normalize_pipeline_definition, so validating
    // there covers both. A negative value must not be read as "unlimited":
    // silently clamping a typo to 0 would disable the very bound the field
    // configures, which is the runaway this cap exists to prevent.
    let stored_negative = serde_json::json!({
        "name": "stored",
        "revision_limit": -1,
        "stages": [{ "name": "in progress", "transition": "manual" }]
    })
    .to_string();

    let error = super::super::definitions::parse_stored_pipeline_definition(&stored_negative)
        .expect_err("a negative revision_limit must be rejected");
    assert!(
        error.contains("revision_limit must be zero or greater"),
        "the error must name the field and the rule: {error}"
    );
    assert!(
        error.contains("-1"),
        "the error must report the offending value: {error}"
    );

    // The neighbouring valid values still parse, so the check rejects only
    // what it should.
    for limit in [0, 1] {
        let stored = serde_json::json!({
            "name": "stored",
            "revision_limit": limit,
            "stages": [{ "name": "in progress", "transition": "manual" }]
        })
        .to_string();
        let pipeline = super::super::definitions::parse_stored_pipeline_definition(&stored)
            .unwrap_or_else(|error| panic!("revision_limit {limit} must parse: {error}"));
        assert_eq!(pipeline.revision_limit(), limit);
    }
}

#[test]
fn revision_budget_is_exhausted_only_at_a_positive_limit() {
    use super::super::RevisionBudget;

    assert!(!RevisionBudget {
        rounds: 2,
        limit: 3
    }
    .exhausted());
    assert!(RevisionBudget {
        rounds: 3,
        limit: 3
    }
    .exhausted());
    assert!(RevisionBudget {
        rounds: 4,
        limit: 3
    }
    .exhausted());
    // `0` opts the pipeline out of the cap entirely.
    assert!(!RevisionBudget {
        rounds: 80,
        limit: 0
    }
    .exhausted());
}

#[test]
fn revision_prompt_announces_the_round_and_holds_scope() {
    use super::super::RevisionRound;

    let unbounded = build_revision_task_prompt("Original prompt", "Add coverage.", None);
    assert!(!unbounded.contains("Revision round"));
    assert!(unbounded.contains("Original task:\nOriginal prompt"));
    assert!(unbounded.contains("Reviewer feedback:\nAdd coverage."));

    let mid = build_revision_task_prompt(
        "Original prompt",
        "Add coverage.",
        Some(RevisionRound {
            number: 2,
            limit: 3,
        }),
    );
    assert!(mid.contains("Revision round 2 of 3"));
    assert!(
        mid.contains("do not rebuild, refactor, or re-architect code the feedback does not name")
    );
    assert!(!mid.contains("final automatic revision round"));

    let last = build_revision_task_prompt(
        "Original prompt",
        "Add coverage.",
        Some(RevisionRound {
            number: 3,
            limit: 3,
        }),
    );
    assert!(last.contains("Revision round 3 of 3"));
    assert!(last.contains("final automatic revision round"));

    // The resume path carries the same round context into the existing
    // session, since a resumed agent never re-reads the composed prompt.
    let resumed = build_revision_resume_message(
        "Original prompt",
        "Add coverage.",
        "task-1",
        PipelineStageTransition::Auto,
        Some(RevisionRound {
            number: 3,
            limit: 3,
        }),
    );
    assert!(resumed.contains("Revision round 3 of 3"));
    assert!(resumed.contains("final automatic revision round"));
}
