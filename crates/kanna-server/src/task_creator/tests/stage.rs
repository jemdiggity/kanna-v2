use super::*;

#[test]
fn builtin_single_reviewer_workflow_ships_approve_as_pr_stage_post() {
    let repo_root = init_git_repo_without_provider_fixtures("builtin-qa-workflow");
    let repo = crate::db::Repo {
        id: "repo-builtin-qa".to_string(),
        path: repo_root.to_string_lossy().into_owned(),
        name: "Builtin QA".to_string(),
        default_branch: Some("main".to_string()),
        remote_url_hash: None,
        hidden: None,
        sort_order: None,
        created_at: None,
        last_opened_at: None,
    };
    let workflow = super::super::definitions::RepoDefinitions::resolve(&repo)
        .unwrap()
        .workflow("single-reviewer")
        .unwrap();

    let pr_stage = workflow
        .stages
        .iter()
        .find(|stage| stage.name == "pr")
        .expect("single-reviewer workflow should have a pr stage");
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
fn one_stage_operation_keeps_prompt_spawn_and_teardown_on_pinned_revision() {
    let repo_root = init_git_repo("stage-operation-pinned-revision");
    let config = test_config("stage-operation-pinned-revision");
    let db = Db::open_for_tests(&config.db_path).unwrap();

    let write_version = |version: &str| {
        let lower = version.to_ascii_lowercase();
        std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
        std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::json!({
                "teardown": [format!("printf {version}_REPO_TEARDOWN")],
                "vars": {"PIN_VAR": format!("{version}_VAR")},
                "agentProviders": {
                    "reviewer": {
                        "provider": "opencode",
                        "model": format!("{lower}-repo-model")
                    }
                },
                "workspace": {
                    "env": {format!("{version}_ENV"): "yes"},
                    "path": {"prepend": [".kanna/test-provider-bin"]}
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/workflows/pinned.json"),
            serde_json::json!({
                "name": "pinned",
                "stages": [{
                    "name": "review",
                    "agent": "reviewer",
                    "prompt": format!("{version}_STAGE $TASK_PROMPT $PIN_VAR"),
                    "environment": "dev",
                    "transition": "manual"
                }],
                "environments": {
                    "dev": {
                        "setup": [format!("printf {version}_STAGE_SETUP > {lower}-stage.marker")],
                        "teardown": [format!("printf {version}_STAGE_TEARDOWN")]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            repo_root.join(".kanna/agents/reviewer/AGENT.md"),
            format!(
                "---\nname: reviewer\ndescription: {version} reviewer\nagent_provider: codex\nmodel: {lower}-model\npermission_mode: dontAsk\nallowed_tools:\n  - Read\n---\n{version}_AGENT\n"
            ),
        )
        .unwrap();
    };

    write_version("V1");
    let v1_revision = publish_origin_main(&repo_root, "publish v1 stage definitions");
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    let repo = db.get_repo("repo-1").unwrap().unwrap();
    let definitions = super::super::definitions::RepoDefinitions::resolve(&repo).unwrap();
    let workflow = definitions.workflow("pinned").unwrap();
    assert_eq!(definitions.revision(), Some(v1_revision.as_str()));

    write_version("V2");
    let v2_revision = publish_origin_main(&repo_root, "publish v2 stage definitions");
    assert_ne!(v1_revision, v2_revision);

    let branch = "branch-task-pin";
    let worktree = repo_root.join(".kanna-worktrees").join(branch);
    std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            worktree.to_string_lossy().as_ref(),
            "HEAD",
        ],
    );
    db.insert_test_pipeline_item(
        "task-pin",
        "repo-1",
        "Pinned task",
        Some("Pinned task"),
        "review",
        "2026-07-15 00:00:00",
    )
    .unwrap();
    db.upsert_worktree(
        "wt-task-pin",
        "task-pin",
        worktree.to_string_lossy().as_ref(),
        branch,
    )
    .unwrap();

    let stage = &workflow.stages[0];
    let prompt = super::super::prompt::build_target_stage_prompt(
        &definitions,
        &repo.path,
        stage,
        "Pinned task",
        None,
        None,
        Some(branch),
        Some("origin/main"),
        Some(branch),
    )
    .unwrap();
    assert!(prompt.contains("V1_AGENT"), "{prompt}");
    assert!(prompt.contains("V1_STAGE Pinned task V1_VAR"), "{prompt}");
    assert!(!prompt.contains("V2"), "{prompt}");

    let mut run = super::super::prepare_stage_run_spawn(
        &db,
        &config,
        &repo,
        &definitions,
        "task-pin",
        "pinned",
        &workflow,
        stage,
        "review",
        "main",
        stage.policy.transition,
        super::super::types::RunWorkspaceSpec::Current,
        prompt,
        branch,
        None,
        Some("agent"),
        super::super::SpawnAgentOverrides::default(),
        Some("claude"),
    )
    .unwrap();
    assert_eq!(run.env.get("V1_ENV").map(String::as_str), Some("yes"));
    assert!(!run.env.contains_key("V2_ENV"));
    assert_eq!(run.agent_provider, "opencode");
    assert_eq!(run.model.as_deref(), Some("v1-repo-model"));
    assert!(!worktree.join("v1-stage.marker").exists());
    super::super::finish_deferred_stage_setup(&mut run).unwrap();
    assert!(worktree.join("v1-stage.marker").is_file());
    assert!(!worktree.join("v2-stage.marker").exists());

    let teardown = super::super::prepare_workspace_teardown(
        &db,
        &config,
        &repo,
        &definitions,
        "task-pin",
        &workflow,
        "review",
        branch,
    )
    .unwrap();
    let teardown_command = match teardown.session {
        PreparedSessionSpawn::Pty { args, .. } => args.join(" "),
        PreparedSessionSpawn::Agent { .. } => panic!("teardown should use a PTY"),
    };
    assert!(teardown_command.contains("V1_STAGE_TEARDOWN"));
    assert!(teardown_command.contains("V1_REPO_TEARDOWN"));
    assert!(!teardown_command.contains("V2"), "{teardown_command}");
    assert_eq!(teardown.env.get("V1_ENV").map(String::as_str), Some("yes"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_merge_agent_creates_in_progress_task() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-merge-agent-task-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
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
    assert!(Command::new("git")
        .args(["add", "."])
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
    publish_origin_main(&repo_root, "publish merge agent fixture");

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
    assert_eq!(prepared.created_task.agent_type, "pty");
    assert_eq!(prepared.stage_agent.as_deref(), Some("merge"));
    let runtime_prompt = match prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => args.join(" "),
        PreparedSessionSpawn::Agent { .. } => panic!("merge master should use a PTY session"),
    };
    assert!(runtime_prompt.contains("You are the merge master."));
    assert!(!runtime_prompt.contains("Implement the requested task in this worktree."));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn rerun_stage_uses_compiled_post_action_stage_prompt_and_stage_setup() {
    let repo_root = init_git_repo("rerun-post-action");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "name": "default",
            "environments": {
                "dev": { "setup": ["printf 'setup rerun' > setup-rerun.marker"] }
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
        "---\nname: implement\ndescription: Implements changes\nagent_provider: claude\n---\nImplement agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nname: commit\ndescription: Commits changes\nagent_provider: claude\n---\nCommit agent.",
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish rerun post definitions");
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
    match &prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(command.contains("setup-rerun.marker"));
            assert!(command.contains("Commit agent."));
            assert!(command.contains(
                "Commit Fix rerun after {\"status\":\"success\",\"summary\":\"implemented\"}"
            ));
            assert!(!command.contains("Implement agent."));
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected pty rerun"),
    }
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    rerun_prepared_stage_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
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
        Some(kanna_daemon::protocol::Command::Spawn { session_id, .. }) if session_id == "task-1"
    ));
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .activity
            .as_deref(),
        Some("working")
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn acknowledged_stage_survives_db_failure_restart_and_can_complete() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tower::ServiceExt;

    let config = test_config("stage-after-ack-reconcile");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Transition",
        Some("Transition"),
        "in progress",
        "2026-08-04 00:00:00",
    )
    .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-original",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: Some("/tmp"),
        resumed_from_run_id: None,
    })
    .unwrap();
    drop(db);

    let prepared = super::super::types::PreparedStageRunSpawn {
        task_id: "task-1".to_string(),
        session_id: "task-1".to_string(),
        next_stage: "review".to_string(),
        run_stage: "review".to_string(),
        run_kind: "main",
        workspace: super::super::types::PreparedRunWorkspace::Current,
        workspace_teardown: None,
        stage_agent: Some("implement".to_string()),
        agent_provider: "codex".to_string(),
        model: None,
        effort: None,
        completion_transition: WorkflowStageTransition::Manual,
        feedback: None,
        provider_session_id: None,
        resumed_from_run_id: None,
        resume_fallback_reason: None,
        cwd: "/tmp".to_string(),
        env: std::collections::HashMap::new(),
        terminal_prelude: None,
        session: PreparedSessionSpawn::Pty {
            executable: "/bin/cat".to_string(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            agent_provider: kanna_daemon::protocol::AgentProvider::Codex,
        },
        deferred_setup: None,
        setup_hard_timeout: None,
    };

    let raw = Connection::open(&config.db_path).unwrap();
    raw.execute_batch(
        r#"
        CREATE TRIGGER fail_stage_landing_after_spawn
        BEFORE UPDATE OF stage ON pipeline_item
        WHEN NEW.id = 'task-1' AND NEW.stage = 'review'
        BEGIN
          SELECT RAISE(ABORT, 'injected surviving stage landing failure');
        END;
        "#,
    )
    .unwrap();
    drop(raw);

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        for expected in ["Kill", "Spawn"] {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            let response = match command {
                kanna_daemon::protocol::Command::Kill { .. } if expected == "Kill" => {
                    kanna_daemon::protocol::Event::Ok
                }
                kanna_daemon::protocol::Command::Spawn { session_id, .. }
                    if expected == "Spawn" =>
                {
                    kanna_daemon::protocol::Event::SessionCreated { session_id }
                }
                other => panic!("expected {expected}, got {other:?}"),
            };
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
    .expect_err("post-ack stage landing failure must be surfaced");
    assert!(error.contains("injected surviving stage landing failure"));
    fake_daemon.await.unwrap();

    // Reopen as startup would, then prune. The pre-spawn bound row is the
    // latest durable identity, so the acknowledged child's artifact remains.
    let db = Db::open(&config.db_path).unwrap();
    let live_run = db.latest_stage_run("task-1").unwrap().unwrap();
    assert_eq!(live_run.stage, "review");
    assert_eq!(live_run.status, "running");
    assert!(db.stage_run_completion_bound(&live_run.id).unwrap());
    crate::task_creator::prune_completion_contexts_on_startup(&config.daemon_dir, &db);
    let completion_dir = std::path::Path::new(&config.daemon_dir).join("runtime/completion");
    let context_path = completion_dir.join(format!("{}.json", live_run.id));
    assert!(context_path.exists());
    drop(db);

    let response = crate::http_api::router(std::sync::Arc::new(crate::http_api::AppState::new(
        config.clone(),
    )))
    .oneshot(
        Request::post("/v1/tasks/task-1/actions/complete-stage")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "runId": live_run.id,
                    "status": "failure",
                    "summary": "surviving child reported after restart"
                })
                .to_string(),
            ))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-1")
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );

    let _ = std::fs::remove_file(socket_path);
    let _ = std::fs::remove_dir_all(config.daemon_dir);
    let _ = std::fs::remove_file(config.db_path);
}

#[test]
fn prepare_rerun_stage_recreates_missing_initial_worktree() {
    let repo_root = init_git_repo("rerun-missing-worktree");
    let config = test_config("rerun-missing-worktree");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Recover missing workspace",
        Some("Recover missing workspace"),
        "in progress",
        "2026-07-01 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-task-1", "default", None, "claude")
        .unwrap();

    let worktree = repo_root.join(".kanna-worktrees/task-task-1");
    assert!(!worktree.exists());

    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();

    assert_eq!(prepared.cwd, worktree.to_string_lossy());
    assert!(worktree.is_dir());
    assert_eq!(
        db.get_task_worktree_path("task-1").unwrap().as_deref(),
        Some(worktree.to_string_lossy().as_ref())
    );

    let _ = super::super::worktree::remove_prepared_worktree(
        worktree.to_string_lossy().as_ref(),
        "task-task-1",
    );
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Seed a repo whose `agentProviders` default is `codex` plus a task whose
/// creation request pinned `claude` and a model, and return the rerun the
/// engine prepares for it.
fn rerun_of_task_pinned_to_claude(
    label: &str,
    seed_stage_run: bool,
) -> (std::path::PathBuf, Config, super::super::PreparedStageRerun) {
    let repo_root = init_git_repo(label);
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "workspace": { "path": { "prepend": [".kanna/test-provider-bin"] } },
            "agentProviders": { "*": { "provider": ["codex", "claude"] } }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish repo provider default");

    let config = test_config(label);
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Pinned provider work",
        Some("Pinned provider work"),
        "in progress",
        "2026-08-07 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-task-1", "default", None, "claude")
        .unwrap();
    db.insert_create_task_intent(
        "task-1",
        &serde_json::json!({
            "repoId": "repo-1",
            "prompt": "Pinned provider work",
            "agentProvider": "claude",
            "model": "claude-opus-5"
        })
        .to_string(),
    )
    .unwrap();
    if seed_stage_run {
        db.insert_stage_run(NewStageRun {
            id: "run-existing",
            task_id: "task-1",
            stage: "in progress",
            kind: "main",
            agent: Some("implement"),
            agent_provider: Some("opencode"),
            model: Some("recorded-model"),
            effort: None,
            status: "cancelled",
            result: None,
            feedback: None,
            session_id: Some("task-1"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
    }

    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();
    (repo_root, config, prepared)
}

/// A rerun of a stage that never produced a run reproduces the creation
/// request. Re-deriving from the stage definition walked the precedence chain
/// again and handed a task pinned to `claude` to the repo's default provider.
#[test]
fn rerun_of_a_never_started_stage_keeps_the_tasks_pinned_provider_and_model() {
    let (repo_root, _config, prepared) =
        rerun_of_task_pinned_to_claude("rerun-pinned-provider", false);

    assert_eq!(prepared.agent_provider, "claude");
    assert_eq!(prepared.model.as_deref(), Some("claude-opus-5"));

    let _ = super::super::worktree::remove_prepared_worktree(
        repo_root
            .join(".kanna-worktrees/task-task-1")
            .to_string_lossy()
            .as_ref(),
        "task-task-1",
    );
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Once the stage has a run, that run is what a rerun reproduces — it is the
/// thing being re-run, and it already resolved every override.
#[test]
fn rerun_reproduces_the_recorded_run_of_the_stage() {
    let (repo_root, _config, prepared) = rerun_of_task_pinned_to_claude("rerun-recorded-run", true);

    assert_eq!(prepared.agent_provider, "opencode");
    assert_eq!(prepared.model.as_deref(), Some("recorded-model"));

    let _ = super::super::worktree::remove_prepared_worktree(
        repo_root
            .join(".kanna-worktrees/task-task-1")
            .to_string_lossy()
            .as_ref(),
        "task-task-1",
    );
    let _ = std::fs::remove_dir_all(&repo_root);
}

/// A task's provider stamp is immutable and a machine-local `agentProviders`
/// entry deliberately does not rebind it. The stamp must not, however, be
/// handed the *model* that entry wrote for its own provider: that is how
/// codex-stamped tasks started respawning as `codex -m opus`, which the Codex
/// CLI rejects outright (2026-08-17). The stamped provider survives with a
/// valid invocation instead.
#[test]
fn rerun_of_a_stamped_provider_drops_a_model_written_for_another_provider() {
    let repo_root = init_git_repo("rerun-foreign-local-model");
    let config = test_config("rerun-foreign-local-model");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Stamped provider work",
        Some("Stamped provider work"),
        "in progress",
        "2026-08-17 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-task-1", "default", None, "codex")
        .unwrap();
    db.insert_stage_run(NewStageRun {
        id: "run-existing",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("codex"),
        model: None,
        effort: None,
        status: "cancelled",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    // The incident's machine-local layer: this machine's claude, named with a
    // claude-only model and effort. It is read from the working tree, so no
    // commit is involved.
    std::fs::write(
        repo_root.join(".kanna/config.local.json"),
        serde_json::json!({
            "agentProviders": {
                "*": {"provider": "claude", "model": "opus", "effort": "xhigh"}
            }
        })
        .to_string(),
    )
    .unwrap();

    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();

    assert_eq!(prepared.agent_provider, "codex");
    assert_eq!(prepared.model, None);
    assert_eq!(prepared.effort, None);
    match &prepared.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let shell_command = args.last().expect("PTY spawn should carry a shell command");
            assert!(
                !shell_command.contains("-m "),
                "rerun passed a foreign model to the stamped provider: {shell_command}"
            );
            assert!(
                !shell_command.contains("opus"),
                "rerun leaked the claude-targeted model: {shell_command}"
            );
        }
        PreparedSessionSpawn::Agent { .. } => panic!("expected a PTY rerun"),
    }

    let _ = super::super::worktree::remove_prepared_worktree(
        repo_root
            .join(".kanna-worktrees/task-task-1")
            .to_string_lossy()
            .as_ref(),
        "task-task-1",
    );
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_uses_stored_workflow_snapshot_for_existing_task() {
    let repo_root =
        std::env::temp_dir().join(format!("kanna-stage-snapshot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/qa")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: reviewer\ndescription: Reviews snapshot changes\nagent_provider: claude\n---\nSnapshot agent: $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/qa/AGENT.md"),
        "---\nname: qa\ndescription: Reviews live changes\nagent_provider: claude\n---\nLive agent: $TASK_PROMPT",
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
    publish_origin_main(&repo_root, "publish stored workflow source definitions");
    assert!(Command::new("git")
        .args(["branch", "task-old-branch"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let snapshot =
        std::fs::read_to_string(repo_root.join(".kanna/workflows/default.json")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "qa", "transition": "manual", "agent": "qa", "prompt": "Live prompt $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    publish_origin_main(
        &repo_root,
        "publish replacement workflow after task snapshot",
    );

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
                    "## Agent Instructions\n\nSnapshot agent: Fix the shell\n\n## Your Task\n\nSnapshot prompt {\"status\":\"success\",\"summary\":\"done\"}"
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
fn prepare_advance_stage_applies_repo_agent_extension() {
    let repo_root = std::env::temp_dir().join(format!("kanna-stage-extend-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo_root);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review prompt $PREV_RESULT" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\n---\nBase reviewer: $TASK_PROMPT",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/EXTEND.md"),
        "Repo extension: run the full unit and integration suites.",
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
    publish_origin_main(&repo_root, "publish agent extension fixture");
    assert!(Command::new("git")
        .args(["branch", "task-ext-branch"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());

    let config = test_config("stage-agent-extension");
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
        "task-ext-branch",
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

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
        PreparedStageTransition::Close { .. } => panic!("expected in-place stage run"),
    };

    assert_eq!(run.next_stage, "review");
    match run.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command = args.join(" ");
            assert!(
                command.contains(
                    "## Agent Instructions\n\nBase reviewer: Fix the shell\n\nRepo extension: run the full unit and integration suites.\n\n## Your Task\n\nReview prompt {\"status\":\"success\",\"summary\":\"done\"}"
                ),
                "unexpected command: {command}"
            );
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
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(repo_root.join("README.md"), "test repo").unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: reviewer\ndescription: Reviews changes\nagent_provider: claude\n---\nReview $TASK_PROMPT",
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
    publish_origin_main(&repo_root, "publish previous-result fixture");
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
        effort: None,
        status: "succeeded",
        result: Some("{\"source\":\"stage_run\"}"),
        feedback: Some("done"),
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
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
                command.contains(
                    "## Agent Instructions\n\nReview Fix it\n\n## Your Task\n\nUse result {\"source\":\"stage_run\"}"
                ),
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
    let config = test_config("advance-stage-closed-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
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
}

#[test]
fn prepare_advance_stage_rejects_blocked_source_task() {
    let config = test_config("advance-stage-blocked-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
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
}

#[test]
fn prepare_stage_completion_for_closed_task_is_idempotent_without_definitions() {
    let config = test_config("complete-stage-closed-source");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo("repo-1", "Repo One").unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Closed prompt",
        Some("Closed task"),
        "in progress",
        "2026-04-17 07:00:00",
    )
    .unwrap();
    db.close_pipeline_item("task-1").unwrap();

    let prepared =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main"), None)
            .unwrap();

    assert!(prepared.is_none());
}

#[tokio::test]
async fn prepare_advance_stage_forks_workspace_for_next_run_in_same_task() {
    let repo_root = init_git_repo("advance-stage-same-task-run");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: reviewer\ndescription: Reviews task changes\nagent_provider: claude\n---\nReview task: $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_origin_main(&repo_root, "publish stage fork definitions");
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
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
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
    assert_eq!(
        run.terminal_prelude,
        Some(
            super::super::terminal_marker::format_stage_transition_marker("in progress", "review",)
        )
    );
    // The transition forks: same task, fresh branch + worktree from the
    // committed tip of task-source.
    let fork_branch = run
        .forked_workspace()
        .expect("stage transition forks a workspace")
        .branch
        .clone();
    let fork_worktree = run.forked_workspace().unwrap().worktree_path.clone();
    // Fork workspaces carry the durable task id plus a workspace counter:
    // the creation workspace is workspace 1, so the first fork is `-2`.
    assert_eq!(fork_branch, "task-task-1-2");
    assert_ne!(fork_branch, "task-source");
    assert_ne!(run.cwd, source_worktree.to_string_lossy());
    assert_eq!(run.cwd, fork_worktree);
    assert!(std::path::Path::new(&fork_worktree).is_dir());

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
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
            session_id,
            cwd,
            terminal_prelude,
            args,
            ..
        }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(cwd, &fork_worktree);
            assert_eq!(
                terminal_prelude.as_deref(),
                Some(
                    super::super::terminal_marker::format_stage_transition_marker(
                        "in progress",
                        "review",
                    )
                    .as_slice()
                )
            );
            let command = args.join(" ");
            assert!(!command.contains("kanna_info"));
            assert!(!command.contains("kanna-cli info"));
        }
        Some(kanna_daemon::protocol::Command::SpawnAgent { session_id, params }) => {
            assert_eq!(session_id, "task-1");
            assert_eq!(params.cwd, fork_worktree);
            let system_prompt = params.system_prompt.as_deref().unwrap_or("");
            assert!(!system_prompt.contains("kanna_info"));
            assert!(!system_prompt.contains("kanna-cli info"));
        }
        other => panic!("expected daemon spawn command, got {:?}", other),
    }

    let updated = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(updated.stage.as_deref(), Some("review"));
    assert_eq!(updated.branch.as_deref(), Some(fork_branch.as_str()));
    assert_eq!(updated.closed_at, None);
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .activity
            .as_deref(),
        Some("working")
    );
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

/// A wedged daemon must not silently strand a stage transition: when the
/// kill round-trip times out, the transition fails with the timeout error,
/// the forked workspace is rolled back, and the task's stage/branch stay
/// untouched (2026-07-24 outage regression).
#[tokio::test]
async fn stage_transition_rolls_back_fork_when_daemon_command_times_out() {
    let repo_root = init_git_repo("advance-stage-daemon-timeout");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        r#"{
  "stages": [
    { "name": "in progress", "transition": "manual" },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $BRANCH" }
  ]
}"#,
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/reviewer/AGENT.md"),
        "---\nname: reviewer\ndescription: Reviews task changes\nagent_provider: claude\n---\nReview task: $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_origin_main(&repo_root, "publish stage timeout definitions");
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

    let config = test_config("advance-stage-daemon-timeout");
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

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        other => panic!(
            "expected stage swap, got {:?}",
            std::mem::discriminant(&other)
        ),
    };
    let fork_branch = run
        .forked_workspace()
        .expect("stage transition forks a workspace")
        .branch
        .clone();
    let fork_worktree = run.forked_workspace().unwrap().worktree_path.clone();
    assert!(std::path::Path::new(&fork_worktree).is_dir());

    // Fake daemon reads the first Kill and never replies; the client's
    // shrunken timeout stands in for the production 30s bound.
    let fake_daemon = spawn_fake_daemon_read_then_stall(config.daemon_dir.clone()).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    daemon.set_command_timeout_for_test(std::time::Duration::from_millis(200));

    let error = spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *run,
    )
    .await
    .expect_err("transition against a wedged daemon must fail, not park");
    assert!(error.contains("timed out"), "unexpected error: {error}");

    // The fork is rolled back and the task did not move.
    assert!(
        !std::path::Path::new(&fork_worktree).is_dir(),
        "forked worktree must be removed on rollback"
    );
    assert_eq!(
        run_git_fixture(&repo_root, &["branch", "--list", &fork_branch]),
        "",
        "forked branch must be deleted on rollback"
    );
    let task = db.get_task_stage_source("task-1").unwrap().unwrap();
    assert_eq!(task.stage.as_deref(), Some("in progress"));
    assert_eq!(task.branch.as_deref(), Some("task-source"));
    assert_eq!(
        db.get_task_worktree_path("task-1").unwrap().as_deref(),
        Some(source_worktree.to_string_lossy().as_ref())
    );
    // No review run was left behind.
    let runs = db.list_stage_runs_for_task("task-1").unwrap();
    assert!(
        runs.iter().all(|run| run.stage != "review"),
        "no review run may exist after a failed transition: {runs:?}"
    );

    fake_daemon.abort();
    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn prompt_only_stage_provider_overrides_source_task_provider_in_daemon_spawn() {
    let repo_root = init_git_repo("prompt-only-stage-provider");
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
    publish_origin_main(&repo_root, "publish prompt-only stage definitions");

    let config = test_config("prompt-only-stage-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);

    let run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("expected stage swap, got post dispatch"),
        PreparedStageTransition::Close { .. } => panic!("expected stage swap, got close"),
    };
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

    let spawn = commands
        .iter()
        .find(|command| {
            matches!(
                command,
                kanna_daemon::protocol::Command::Spawn { .. }
                    | kanna_daemon::protocol::Command::SpawnAgent { .. }
            )
        })
        .expect("stage transition daemon spawn");
    match spawn {
        kanna_daemon::protocol::Command::Spawn { agent_provider, .. } => {
            assert_eq!(*agent_provider, Some(DaemonAgentProvider::Codex));
        }
        kanna_daemon::protocol::Command::SpawnAgent { params, .. } => {
            assert_eq!(params.agent_provider, DaemonAgentProvider::Codex);
        }
        _ => unreachable!(),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn stage_transition_tears_down_departed_stage_environment_before_repo_teardown() {
    let repo_root = init_git_repo("advance-stage-env-teardown");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/config.json"),
        serde_json::json!({
            "teardown": ["echo repo-teardown"],
            "workspace": {
                "path": {
                    "prepend": [".kanna/test-provider-bin"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: reviewer\ndescription: Review changes\nagent_provider: claude\n---\nReview agent.",
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
    publish_origin_main(&repo_root, "publish teardown definitions");
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
    let fork_worktree = run.forked_workspace().unwrap().worktree_path.clone();

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

#[tokio::test]
async fn headless_rerun_runs_environment_setup_after_killing_previous_session() {
    let repo_root = init_git_repo("headless-rerun-setup-order");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "setup": [
                        "test -f kill-observed && printf setup > headless-rerun-setup.marker"
                    ]
                }
            },
            "stages": [{
                "name": "in progress",
                "prompt": "$TASK_PROMPT",
                "agent_provider": "codex",
                "environment": "dev",
                "transition": "manual"
            }]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish headless rerun setup definitions");
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

    let config = test_config("headless-rerun-setup-order");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Rerun after setup",
        Some("Rerun after setup"),
        "in progress",
        "2026-07-11 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "codex")
        .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET agent_type = 'agent' WHERE id = 'task-1'",
            [],
        )
        .unwrap();

    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();
    assert!(
        !worktree.join("headless-rerun-setup.marker").exists(),
        "headless setup must stay deferred while the previous session is live"
    );

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let daemon_worktree = worktree.clone();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        for _ in 0..2 {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                kanna_daemon::protocol::Command::Kill { .. } => {
                    assert!(!daemon_worktree.join("headless-rerun-setup.marker").exists());
                    std::fs::write(daemon_worktree.join("kill-observed"), "killed").unwrap();
                    kanna_daemon::protocol::Event::Ok
                }
                kanna_daemon::protocol::Command::SpawnAgent { params, session_id } => {
                    assert!(daemon_worktree
                        .join("headless-rerun-setup.marker")
                        .is_file());
                    assert!(params.executable.is_some());
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            commands.push(command);
            write_half
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
        }
        commands
    });
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    rerun_prepared_stage_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();
    assert!(matches!(
        commands.as_slice(),
        [
            kanna_daemon::protocol::Command::Kill { .. },
            kanna_daemon::protocol::Command::SpawnAgent { .. }
        ]
    ));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn headless_rerun_setup_failure_records_durable_diagnostics_after_kill() {
    let repo_root = init_git_repo("headless-rerun-setup-failure");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "environments": {
                "dev": {
                    "setup": ["printf setup-failed && exit 37"]
                }
            },
            "stages": [{
                "name": "in progress",
                "prompt": "$TASK_PROMPT",
                "agent_provider": "codex",
                "environment": "dev",
                "transition": "manual"
            }]
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(
        &repo_root,
        "publish failing headless rerun setup definitions",
    );
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

    let config = test_config("headless-rerun-setup-failure");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        "task-1",
        "repo-1",
        "Rerun with failing setup",
        Some("Rerun with failing setup"),
        "in progress",
        "2026-07-11 00:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context("task-1", "task-source", "default", None, "codex")
        .unwrap();
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET agent_type = 'agent' WHERE id = 'task-1'",
            [],
        )
        .unwrap();
    let prepared = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
        assert!(matches!(
            command,
            kanna_daemon::protocol::Command::Kill { .. }
        ));
        write_half
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&kanna_daemon::protocol::Event::Ok).unwrap()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        command
    });

    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    let error = rerun_prepared_stage_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        prepared,
    )
    .await
    .expect_err("failing deferred setup must reject the rerun");
    fake_daemon.await.unwrap();

    assert!(error.contains("exit status: 37"), "error: {error}");
    assert!(error.contains("setup-failed"), "error: {error}");
    let failed_run = db
        .latest_stage_run("task-1")
        .unwrap()
        .expect("rerun setup failure should be durable");
    assert_eq!(failed_run.status, "failed");
    assert_eq!(failed_run.kind, "main");
    let result = failed_run.result.unwrap();
    assert!(result.contains("exit status: 37"), "result: {result}");
    assert!(result.contains("setup-failed"), "result: {result}");
    assert_eq!(failed_run.feedback.as_deref(), Some("stage rerun failed"));
    assert_eq!(
        db.get_pipeline_item("task-1")
            .unwrap()
            .unwrap()
            .activity
            .as_deref(),
        Some("unread")
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_at_final_stage_prepares_close() {
    let repo_root = init_git_repo_with_workflow(
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
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: pr\ndescription: Create the pull request\nagent_provider: claude\n---\nPR agent for $TASK_PROMPT",
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", ".kanna"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-m", "add kanna workflow"])
        .current_dir(&repo_root)
        .status()
        .unwrap()
        .success());
    publish_origin_main(&repo_root, "publish auto completion definitions");
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
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main"), None)
            .unwrap();
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
    let fork = run.forked_workspace().expect("auto transition forks");
    assert_eq!(run.cwd, fork.worktree_path);
    let expected_prompt = format!(
        "## Agent Instructions\n\nPR agent for Fix stage promotion\n\n## Your Task\n\nCreate PR for {} from {} after {{\"status\":\"success\",\"summary\":\"committed\"}}",
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
    let repo_root = init_git_repo_with_workflow(
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
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main"), None)
            .unwrap();
    assert!(
        prepared.is_none(),
        "manual stages must park instead of auto-advancing"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

fn write_post_workflow_fixtures(repo_root: &std::path::Path) {
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/commit")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/pr")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
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
        "---\nname: implement\ndescription: Implement the task\nagent_provider: claude\n---\nImplement agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/commit/AGENT.md"),
        "---\nname: commit\ndescription: Commit the implementation\nagent_provider: claude\n---\nCommit agent.",
    )
    .unwrap();
    std::fs::write(
        repo_root.join(".kanna/agents/pr/AGENT.md"),
        "---\nname: pr\ndescription: Create the pull request\nagent_provider: claude\n---\nPR agent.",
    )
    .unwrap();
    publish_origin_main(repo_root, "publish post workflow definitions");
}

fn seed_post_workflow_task(config: &Config, db: &Db, repo_root: &std::path::Path) {
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
fn workflow_null_task_uses_no_review_across_lifecycle_paths_when_repo_defines_default() {
    let repo_root = init_git_repo("workflow-null-fallback");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "name": "default",
            "revision_limit": 17,
            "stages": [{
                "name": "in progress",
                "agent": "review",
                "prompt": "Repo-authored default $TASK_PROMPT",
                "environment": "repo-default",
                "policy": { "transition": "manual" }
            }],
            "environments": {
                "repo-default": {
                    "teardown": ["printf REPO_DEFAULT_TEARDOWN"]
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    publish_origin_main(&repo_root, "publish shadowing default workflow");

    let config = test_config("workflow-null-fallback");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    Connection::open(&config.db_path)
        .unwrap()
        .execute(
            "UPDATE pipeline_item SET pipeline = NULL WHERE id = ?",
            ["task-1"],
        )
        .unwrap();

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        PreparedStageTransition::Run(_) => panic!("no-review advance should dispatch its post"),
        PreparedStageTransition::Close { .. } => {
            panic!("repo-authored default must not close a workflow-null task")
        }
    };
    assert_eq!(post.run_stage, "commit");

    let revision_budget = super::super::resolve_revision_budget(&db, "task-1").unwrap();
    assert_eq!(revision_budget.limit, super::super::DEFAULT_REVISION_LIMIT);

    let rerun = prepare_rerun_stage_for_api(&db, &config, "task-1").unwrap();
    assert_eq!(rerun.stage_agent.as_deref(), Some("implement"));

    assert!(
        super::super::prepare_workspace_teardown_for_close(&db, &config, "task-1").is_none(),
        "repo-authored default teardown must not apply to a workflow-null task"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_dispatches_post_into_running_session() {
    let repo_root = init_git_repo("advance-dispatches-post");
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("advance-dispatches-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-main",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
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
    let completion_index = post
        .message
        .find("When this work is complete")
        .expect("completion instruction");
    let task_heading_index = post.message.find("## Your Task").expect("task heading");
    assert!(
        completion_index < task_heading_index,
        "completion instructions must precede the task section: {}",
        post.message
    );
    assert!(
        post.message.ends_with("## Your Task\n\nCommit Fix it"),
        "post assignment must remain the final section: {}",
        post.message
    );
    // The fallback spawn keeps the owning stage: a post never moves the
    // task's stage.
    assert_eq!(post.fallback.next_stage, "in progress");
    assert_eq!(post.fallback.run_stage, "commit");
    assert_eq!(post.fallback.run_kind, "post");
    assert_eq!(post.fallback.stage_agent.as_deref(), Some("commit"));
    let fallback_prompt = match &post.fallback.session {
        PreparedSessionSpawn::Pty { args, .. } => args.join(" "),
        PreparedSessionSpawn::Agent {
            prompt,
            system_prompt,
            ..
        } => format!("{system_prompt}\n{prompt}"),
    };
    assert!(
        !fallback_prompt.contains("When this work is complete"),
        "fresh post fallback should rely on its auto-stage runtime guidance: {fallback_prompt}"
    );
    assert!(!fallback_prompt.contains("kanna_info"));
    assert!(!fallback_prompt.contains("kanna-cli info"));

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_swaps_after_succeeded_post() {
    let repo_root = init_git_repo("advance-after-post-success");
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("advance-after-post-success");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
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
    let fork = run.forked_workspace().expect("swap forks a workspace");
    assert_ne!(fork.branch, "task-source");
    assert!(std::path::Path::new(&fork.worktree_path).is_dir());
    assert_eq!(run.cwd, fork.worktree_path);

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_advance_stage_redispatches_failed_post() {
    let repo_root = init_git_repo("advance-redispatches-failed-post");
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("advance-redispatches-failed-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-post",
        task_id: "task-1",
        stage: "commit",
        kind: "post",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: None,
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
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
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("post-completion-swaps");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);

    // A finished post always advances: the manual gate was already passed by
    // the advance that dispatched the post.
    let run =
        match super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("post"), None)
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
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("main-completion-parks-with-post");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);

    // The implement agent's own success verdict parks the manual stage; the
    // post is dispatched only when the human (or an auto policy) advances.
    let prepared =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main"), None)
            .unwrap();
    assert!(prepared.is_none());

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn prepare_revision_completion_uses_run_transition() {
    let repo_root = init_git_repo("revision-completion-run-transition");
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("revision-completion-run-transition");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);

    let automatic =
        super::prepare_stage_completion_for_api(&db, &config, "task-1", Some("main"), Some("auto"))
            .unwrap();
    assert!(matches!(automatic, Some(PreparedStageTransition::Post(_))));

    let manual = super::prepare_stage_completion_for_api(
        &db,
        &config,
        "task-1",
        Some("main"),
        Some("manual"),
    )
    .unwrap();
    assert!(manual.is_none());

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[test]
fn legacy_task_parked_at_folded_post_stage_advances_past_owner() {
    let repo_root = init_git_repo("legacy-folded-post-advance");
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("legacy-folded-post-advance");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
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
    write_post_workflow_fixtures(&repo_root);

    let config = test_config("dispatch-post-live-session");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    db.insert_stage_run(NewStageRun {
        id: "run-main",
        task_id: "task-1",
        stage: "in progress",
        kind: "main",
        agent: Some("implement"),
        agent_provider: Some("claude"),
        model: Some("sonnet"),
        effort: None,
        status: "running",
        result: None,
        feedback: None,
        session_id: Some("task-1"),
        provider_session_id: None,
        cwd: None,
        resumed_from_run_id: None,
    })
    .unwrap();
    let completion_path =
        std::path::Path::new(&config.daemon_dir).join("runtime/completion/run-main.json");
    kanna_tool_catalog::write_completion_context(
        &completion_path,
        &kanna_tool_catalog::CompletionContext::new("run-main"),
    )
    .unwrap();

    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        _ => panic!("expected post dispatch"),
    };

    // The daemon owns the draft-safe submission boundary, so the post is one
    // semantic command rather than two raw terminal writes.
    let fake_daemon = spawn_fake_daemon_input_ok(config.daemon_dir.clone(), 1).await;
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
        kanna_daemon::protocol::Command::SubmitInput { session_id, data } => {
            assert_eq!(session_id, "task-1");
            let text = String::from_utf8(data.clone()).unwrap();
            assert!(text.contains("Commit agent."), "input: {text}");
            assert!(text.contains("Commit Fix it"), "input: {text}");
        }
        other => panic!("expected SubmitInput, got {other:?}"),
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
    assert_eq!(
        kanna_tool_catalog::read_completion_context(&completion_path)
            .unwrap()
            .run_id,
        runs[1].id,
        "live post dispatch must rebind through the inherited process context, not the fallback env"
    );

    let _ = std::fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn dispatch_post_falls_back_to_fresh_session_when_session_is_dead() {
    let repo_root = init_git_repo("dispatch-post-dead-session");
    write_post_workflow_fixtures(&repo_root);

    let mut config = test_config("dispatch-post-dead-session");
    config.kanna_cli_path = Some("/tmp/kanna-cli".to_string());
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);

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
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                kanna_daemon::protocol::Command::SubmitInput { .. }
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

#[tokio::test]
async fn prompt_only_post_provider_overrides_source_task_provider_in_fallback_daemon_spawn() {
    let repo_root = init_git_repo("prompt-only-post-provider");
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/default.json"),
        serde_json::json!({
            "stages": [
                {
                    "name": "in progress",
                    "prompt": "$TASK_PROMPT",
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
    publish_origin_main(&repo_root, "publish prompt-only post definitions");

    let config = test_config("prompt-only-post-provider");
    let db = Db::open_for_tests(&config.db_path).unwrap();
    seed_post_workflow_task(&config, &db, &repo_root);
    let post = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
        PreparedStageTransition::Post(post) => post,
        _ => panic!("expected post dispatch"),
    };

    let socket_path = test_daemon_socket_path(&config.daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let fake_daemon = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut commands = Vec::new();
        loop {
            let command = read_fake_daemon_command(&mut reader, &mut write_half).await;
            let response = match &command {
                kanna_daemon::protocol::Command::SubmitInput { .. }
                | kanna_daemon::protocol::Command::Kill { .. } => {
                    kanna_daemon::protocol::Event::Error {
                        code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                        message: "session not found".to_string(),
                    }
                }
                kanna_daemon::protocol::Command::Spawn { session_id, .. }
                | kanna_daemon::protocol::Command::SpawnAgent { session_id, .. } => {
                    kanna_daemon::protocol::Event::SessionCreated {
                        session_id: session_id.clone(),
                    }
                }
                other => panic!("unexpected daemon command: {other:?}"),
            };
            let done = matches!(
                &command,
                kanna_daemon::protocol::Command::Spawn { .. }
                    | kanna_daemon::protocol::Command::SpawnAgent { .. }
            );
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
    crate::task_creator::dispatch_prepared_post_for_api(
        &config.db_path,
        &mut daemon,
        &crate::session_replacements::SessionReplacements::default(),
        *post,
    )
    .await
    .unwrap();
    let commands = fake_daemon.await.unwrap();

    let spawn = commands
        .iter()
        .find(|command| {
            matches!(
                command,
                kanna_daemon::protocol::Command::Spawn { .. }
                    | kanna_daemon::protocol::Command::SpawnAgent { .. }
            )
        })
        .expect("post fallback daemon spawn");
    match spawn {
        kanna_daemon::protocol::Command::Spawn { agent_provider, .. } => {
            assert_eq!(*agent_provider, Some(DaemonAgentProvider::Codex));
        }
        kanna_daemon::protocol::Command::SpawnAgent { params, .. } => {
            assert_eq!(params.agent_provider, DaemonAgentProvider::Codex);
        }
        _ => unreachable!(),
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}
