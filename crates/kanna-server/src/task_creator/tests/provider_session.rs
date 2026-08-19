//! The provider session id a PTY agent only reveals as it dies, carried
//! across an ordinary stage transition.
//!
//! Codex never receives its session id from Kanna: the daemon scrapes the
//! rollout uuid off the TUI footer and reports it on the `Exit` it broadcasts.
//! An implementation -> review transition kills that session on purpose, so
//! the `Exit` is a replaced/killed one — the shape the watcher must skip for
//! completion notification and terminal-state finalization, but must not skip
//! for the id itself. Losing it there is invisible until a revision, which
//! then forks a fresh conversation instead of resuming. Observed historically
//! on closed tasks cf1b5371 and 6a6eb58b, each of which burned four distinct
//! rollout uuids across one implementation and three revisions.
//!
//! These tests drive the real transition, the real watcher, and the real
//! revision preparation against one fake daemon, because the loss only exists
//! in the wiring between them.

use super::*;

const CODEX_ROLLOUT_UUID: &str = "019d99a5-aa94-7c73-b786-644cc095c037";
const TASK_ID: &str = "codex-task";

/// Repo with a codex `in progress` stage whose `commit` post has already run,
/// an implement worktree holding the implementation run, and a task parked
/// exactly where an advance moves it into review.
fn init_codex_transition_fixture(label: &str, config: &Config) -> (std::path::PathBuf, Db) {
    let repo_root = init_git_repo(label);
    std::fs::create_dir_all(repo_root.join(".kanna/workflows")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/implement")).unwrap();
    std::fs::create_dir_all(repo_root.join(".kanna/agents/reviewer")).unwrap();
    std::fs::write(
        repo_root.join(".kanna/workflows/codexqa.json"),
        r#"{
  "stages": [
    {
      "name": "in progress",
      "policy": { "transition": "manual", "revision_transition": "auto" },
      "agent": "implement",
      "prompt": "$TASK_PROMPT",
      "post": { "name": "commit", "prompt": "Commit for $TASK_PROMPT" }
    },
    { "name": "review", "transition": "manual", "agent": "reviewer", "prompt": "Review $PREV_MAIN_RESULT" }
  ]
}"#,
    )
    .unwrap();
    for agent in ["implement", "reviewer"] {
        std::fs::write(
            repo_root.join(format!(".kanna/agents/{agent}/AGENT.md")),
            format!(
                "---\nname: {agent}\ndescription: Test {agent} agent\nagent_provider: codex\n---\nRun {agent}."
            ),
        )
        .unwrap();
    }
    publish_origin_main(&repo_root, "publish codex transition definitions");
    run_git_fixture(&repo_root, &["branch", "task-codex-impl"]);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-codex-impl");
    run_git_fixture(
        &repo_root,
        &[
            "worktree",
            "add",
            impl_worktree.to_string_lossy().as_ref(),
            "task-codex-impl",
        ],
    );

    let db = Db::open_for_tests(&config.db_path).unwrap();
    db.insert_test_repo_with_path("repo-1", &repo_root.to_string_lossy(), "Repo One")
        .unwrap();
    db.insert_test_pipeline_item(
        TASK_ID,
        "repo-1",
        "Fix the terminal redraw.",
        Some("Codex transition"),
        "in progress",
        "2026-08-16 07:00:00",
    )
    .unwrap();
    db.update_test_pipeline_item_stage_context(
        TASK_ID,
        "task-codex-impl",
        "codexqa",
        None,
        "codex",
    )
    .unwrap();
    let impl_cwd = impl_worktree.to_string_lossy().to_string();
    let codex_run =
        |id: &'static str, stage: &'static str, kind: &'static str, agent: &'static str| {
            NewStageRun {
                id,
                task_id: TASK_ID,
                stage,
                kind,
                agent: Some(agent),
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some(TASK_ID),
                // Codex is spawned without a session id: it assigns its own,
                // and Kanna only learns it when the session ends.
                provider_session_id: None,
                cwd: Some(impl_cwd.as_str()),
                resumed_from_run_id: None,
            }
        };
    db.insert_stage_run(codex_run("run-impl", "in progress", "main", "implement"))
        .unwrap();
    db.finish_stage_run(
        "run-impl",
        "succeeded",
        Some("{\"status\":\"success\",\"summary\":\"implemented\"}"),
        None,
    )
    .unwrap();
    // The commit post ran in the same session and is the task's latest run —
    // it is not the run a revision reopens.
    db.insert_stage_run(codex_run("run-commit", "commit", "post", "commit"))
        .unwrap();
    db.finish_stage_run(
        "run-commit",
        "succeeded",
        Some("{\"status\":\"success\",\"summary\":\"committed\"}"),
        None,
    )
    .unwrap();
    (repo_root, db)
}

/// Fake daemon for the watcher half: answers `Subscribe` and the watcher's
/// unsubscribed control `List`, then broadcasts one event and shuts down.
async fn spawn_fake_daemon_broadcasting(
    daemon_dir: String,
    event: kanna_daemon::protocol::Event,
) -> tokio::task::JoinHandle<()> {
    let socket_path = test_daemon_socket_path(&daemon_dir);
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        let (subscribe_stream, _) = listener.accept().await.unwrap();
        let (subscribe_read, mut subscribe_write) = subscribe_stream.into_split();
        let mut subscribe_reader = BufReader::new(subscribe_read);
        assert!(matches!(
            read_fake_daemon_command(&mut subscribe_reader, &mut subscribe_write).await,
            kanna_daemon::protocol::Command::Subscribe
        ));
        write_fake_daemon_event(&mut subscribe_write, &kanna_daemon::protocol::Event::Ok).await;

        let (list_stream, _) = listener.accept().await.unwrap();
        let (list_read, mut list_write) = list_stream.into_split();
        let mut list_reader = BufReader::new(list_read);
        assert!(matches!(
            read_fake_daemon_command(&mut list_reader, &mut list_write).await,
            kanna_daemon::protocol::Command::List
        ));
        write_fake_daemon_event(
            &mut list_write,
            &kanna_daemon::protocol::Event::SessionList {
                sessions: Vec::new(),
            },
        )
        .await;

        write_fake_daemon_event(&mut subscribe_write, &event).await;
        write_fake_daemon_event(
            &mut subscribe_write,
            &kanna_daemon::protocol::Event::ShuttingDown,
        )
        .await;
    })
}

async fn write_fake_daemon_event(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    event: &kanna_daemon::protocol::Event,
) {
    writer
        .write_all(format!("{}\n", serde_json::to_string(event).unwrap()).as_bytes())
        .await
        .unwrap();
}

/// Writes the rollout file the Codex CLI would have left for `uuid` in `cwd`,
/// so the resume precondition sees a real transcript.
fn write_codex_rollout(codex_home: &std::path::Path, uuid: &str, cwd: &std::path::Path) {
    let sessions_dir = codex_home.join("sessions/2026/08/16");
    std::fs::create_dir_all(&sessions_dir).unwrap();
    std::fs::write(
        sessions_dir.join(format!("rollout-2026-08-16T07-00-00-{uuid}.jsonl")),
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session_meta",
                "payload": { "id": uuid, "cwd": cwd.to_string_lossy() },
            })
        ),
    )
    .unwrap();
}

/// The whole loss path in one test: the transition kills the codex session,
/// the daemon reports the rollout uuid on the killed `Exit` *after* the review
/// run already exists, and the next revision must reopen that conversation in
/// its own worktree instead of forking a fresh one.
#[tokio::test]
async fn killed_codex_transition_exit_lands_on_the_implementation_run_and_the_revision_resumes_it()
{
    let config = test_config("codex-transition-resume");
    let (repo_root, db) = init_codex_transition_fixture("codex-transition-resume", &config);
    let impl_worktree = repo_root.join(".kanna-worktrees/task-codex-impl");
    let state = crate::http_api::AppState::new(config.clone());
    let replacements = state.session_replacements();

    let prepared = match prepare_advance_stage_for_api(&db, &config, TASK_ID).unwrap() {
        PreparedStageTransition::Run(run) => run,
        PreparedStageTransition::Post(_) => panic!("the commit post already ran for this stage"),
        PreparedStageTransition::Close { .. } => panic!("expected the review stage, not a close"),
    };
    assert_eq!(prepared.next_stage, "review");

    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *prepared)
        .await
        .unwrap();
    let commands = fake_daemon.await.unwrap();
    assert!(
        commands.iter().any(|command| matches!(
            command,
            kanna_daemon::protocol::Command::Kill { session_id } if session_id == TASK_ID
        )),
        "the transition must kill the implementation session: {commands:?}"
    );
    drop(daemon);

    // The review run exists before the killed Exit is processed — the
    // ordering that made "the task's latest run" the wrong target.
    let review_run_id = db
        .latest_stage_run(TASK_ID)
        .unwrap()
        .expect("review run recorded")
        .id;
    assert_ne!(review_run_id, "run-impl");

    let watcher_daemon = spawn_fake_daemon_broadcasting(
        config.daemon_dir.clone(),
        kanna_daemon::protocol::Event::Exit {
            session_id: TASK_ID.to_string(),
            code: 128 + 9,
            resume_session_id: Some(CODEX_ROLLOUT_UUID.to_string()),
            killed: true,
        },
    )
    .await;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        crate::terminal_watcher::terminal_state_watcher_once(&state, &replacements),
    )
    .await
    .expect("watcher did not finish")
    .unwrap();
    watcher_daemon.await.unwrap();

    let runs = db.list_stage_runs_for_task(TASK_ID).unwrap();
    let run = |id: &str| {
        runs.iter()
            .find(|run| run.id == id)
            .unwrap_or_else(|| panic!("run {id} recorded"))
    };
    assert_eq!(
        run("run-impl").provider_session_id.as_deref(),
        Some(CODEX_ROLLOUT_UUID),
        "the killed session's rollout uuid belongs to the run it served"
    );
    assert_eq!(
        run("run-commit").provider_session_id.as_deref(),
        None,
        "the post run is not the conversation a revision reopens"
    );
    assert_eq!(
        run(&review_run_id).provider_session_id.as_deref(),
        None,
        "the review run must never inherit the implementation session"
    );
    // An orchestrated kill is not the agent finishing: the freshly spawned
    // review run stays running rather than being finalized by the Exit.
    assert_eq!(run(&review_run_id).status, "running");

    // The reviewer now requests a revision of the implementation stage.
    let codex_home = repo_root.join("codex-home");
    write_codex_rollout(&codex_home, CODEX_ROLLOUT_UUID, &impl_worktree);
    let revision = {
        let _env_guard = super::CODEX_HOME_LOCK.lock().unwrap();
        std::env::set_var("CODEX_HOME", &codex_home);
        let revision = prepare_revision_task_for_api(
            &db,
            &config,
            TASK_ID,
            "in progress",
            "Cover the redraw regression with a test.",
            None,
        );
        std::env::remove_var("CODEX_HOME");
        revision.unwrap()
    };

    let resumed = revision
        .resumed_workspace()
        .expect("the revision must resume the recorded codex conversation");
    assert_eq!(resumed.branch, "task-codex-impl");
    assert_eq!(resumed.worktree_path, impl_worktree.to_string_lossy());
    assert!(revision.forked_workspace().is_none());
    assert_eq!(revision.agent_provider, "codex");
    assert_eq!(
        revision.provider_session_id.as_deref(),
        Some(CODEX_ROLLOUT_UUID)
    );
    assert_eq!(revision.resumed_from_run_id.as_deref(), Some("run-impl"));
    assert!(revision.resume_fallback_reason.is_none());
    match &revision.session {
        PreparedSessionSpawn::Pty { args, .. } => {
            let command_line = args.last().expect("shell command");
            assert!(
                command_line.contains(&format!("resume '{CODEX_ROLLOUT_UUID}'")),
                "the revision must reopen the recorded conversation: {command_line}"
            );
        }
        PreparedSessionSpawn::Agent { .. } => {
            panic!("expected a PTY session, got an agent session")
        }
    }

    let _ = std::fs::remove_dir_all(&repo_root);
}

/// Without a recorded conversation the revision must still fork rather than
/// claim a resume — the behavior every non-codex provider and every failed
/// extraction keeps, and the baseline the fix must not paper over.
#[tokio::test]
async fn a_transition_that_discovers_no_session_still_forks_the_revision() {
    let config = test_config("codex-transition-no-session");
    let (repo_root, db) = init_codex_transition_fixture("codex-transition-no-session", &config);
    let state = crate::http_api::AppState::new(config.clone());
    let replacements = state.session_replacements();

    let prepared = match prepare_advance_stage_for_api(&db, &config, TASK_ID).unwrap() {
        PreparedStageTransition::Run(run) => run,
        _ => panic!("expected the review stage, not a post or a close"),
    };
    let fake_daemon = spawn_fake_daemon_fork_transition(config.daemon_dir.clone(), 1).await;
    let mut daemon = DaemonClient::connect(&config.daemon_dir).await.unwrap();
    spawn_prepared_stage_run_for_api(&config.db_path, &mut daemon, &replacements, *prepared)
        .await
        .unwrap();
    fake_daemon.await.unwrap();
    drop(daemon);

    // The daemon found no rollout uuid to report (a non-codex agent, or a
    // footer it could not read).
    let watcher_daemon = spawn_fake_daemon_broadcasting(
        config.daemon_dir.clone(),
        kanna_daemon::protocol::Event::Exit {
            session_id: TASK_ID.to_string(),
            code: 128 + 9,
            resume_session_id: None,
            killed: true,
        },
    )
    .await;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        crate::terminal_watcher::terminal_state_watcher_once(&state, &replacements),
    )
    .await
    .expect("watcher did not finish")
    .unwrap();
    watcher_daemon.await.unwrap();

    let runs = db.list_stage_runs_for_task(TASK_ID).unwrap();
    assert!(
        runs.iter().all(|run| run.provider_session_id.is_none()),
        "an Exit with no discovered session must record nothing: {runs:?}"
    );

    let revision = prepare_revision_task_for_api(
        &db,
        &config,
        TASK_ID,
        "in progress",
        "Cover the redraw regression with a test.",
        None,
    )
    .unwrap();
    assert!(revision.resumed_workspace().is_none());
    let fork = revision
        .forked_workspace()
        .expect("no recorded session must still fork a fresh workspace");
    assert_eq!(
        revision.resume_fallback_reason.as_deref(),
        Some("no stage run recorded a provider session")
    );
    let _ =
        crate::task_creator::worktree::remove_prepared_worktree(&fork.worktree_path, &fork.branch);

    let _ = std::fs::remove_dir_all(&repo_root);
}
