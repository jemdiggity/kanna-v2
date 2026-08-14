use crate::{daemon_client, http_api, session_replacements};
use std::sync::Arc;
use tokio::sync::mpsc;

fn persist_exit_resume_session_id(
    state: &http_api::AppState,
    session_id: &str,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let Some(resume_session_id) = resume_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let db = crate::db::Db::open(&state.config().db_path).map_err(|e| format!("db error: {e}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(session_id)
        .map_err(|e| format!("db error: {e}"))?
    else {
        return Ok(());
    };
    db.update_latest_stage_run_provider_session_id(&task_id, resume_session_id)
        .map_err(|e| format!("db error: {e}"))?;
    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    Ok(())
}

/// Returns whether anything changed. Publishing is the caller's job: one
/// daemon event can move the prompt, the runtime status, and the activity, and
/// the desktop only needs to be told once.
fn persist_waiting_prompt(
    state: &http_api::AppState,
    session_id: &str,
    prompt: &str,
) -> Result<bool, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Ok(false);
    }
    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    db.update_pipeline_item_waiting_prompt(session_id, prompt)
        .map_err(|error| format!("db error: {error}"))
}

fn apply_watcher_runtime_status(
    state: &http_api::AppState,
    session_id: &str,
    status: kanna_daemon::protocol::SessionStatus,
    waiting_prompt: Option<&str>,
) -> Result<bool, String> {
    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(false);
    };
    let Some(item) = db
        .get_pipeline_item(&task_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(false);
    };
    if item.closed_at.is_some() {
        return Ok(false);
    }

    let status = match status {
        kanna_daemon::protocol::SessionStatus::Busy => "busy",
        kanna_daemon::protocol::SessionStatus::Waiting => "waiting",
        kanna_daemon::protocol::SessionStatus::Idle => "idle",
    };

    // Runtime status is recorded whatever the desktop is doing: it is the
    // daemon's own verdict, it does not depend on which task is selected, and
    // it is the only place `waiting` survives — `activity` folds waiting into
    // idle, which is why a task parked on a prompt used to be invisible to
    // anything but a human reading the terminal.
    let changed = db
        .update_pipeline_item_runtime_status(
            &task_id,
            status,
            waiting_prompt.or(item.last_output_preview.as_deref()),
        )
        .map_err(|error| format!("db error: {error}"))?;

    // Busy is selection-independent: every live observer agrees it means
    // working, so the watcher remains an authoritative writer even while a
    // terminal client is attached. Idle/waiting still belong to the attached
    // client because only it knows whether the task is selected (idle) or
    // unselected (unread).
    if state.terminal_attachments().is_attached(session_id) && status != "busy" {
        return Ok(changed);
    }

    let Some(activity) = http_api::task_activity::activity_for_runtime_status(
        item.activity.as_deref(),
        status,
        false,
    ) else {
        return Ok(changed);
    };

    db.update_pipeline_item_activity(&task_id, activity)
        .map_err(|error| format!("db error: {error}"))?;
    Ok(true)
}

async fn reconcile_detached_terminal_status(
    state: &http_api::AppState,
    session_id: &str,
) -> Result<(), String> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

    // A new attachment may have acquired a lease after the final-drop
    // notification was queued. In that case its snapshot owns reconciliation.
    if state.terminal_attachments().is_attached(session_id) {
        return Ok(());
    }

    let config = state.config();
    let mut daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|error| format!("daemon detach reconciliation connection failed: {error}"))?;
    match daemon
        .send_command(&DaemonCommand::List)
        .await
        .map_err(|error| format!("daemon detach reconciliation list failed: {error}"))?
    {
        DaemonEvent::SessionList { sessions } => {
            if let Some(session) = sessions
                .into_iter()
                .find(|session| session.session_id == session_id)
            {
                // The runtime-status helper re-checks the lease after the
                // daemon round-trip, closing a concurrent reattach race for
                // selection-dependent idle/waiting updates.
                if apply_watcher_runtime_status(state, session_id, session.status, None)? {
                    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
                }
            }
            Ok(())
        }
        DaemonEvent::Error { message, .. } => Err(format!(
            "daemon detach reconciliation list error: {message}"
        )),
        other => Err(format!(
            "unexpected daemon detach reconciliation list response: {other:?}"
        )),
    }
}

pub(crate) async fn terminal_detach_reconciliation_loop(
    state: Arc<http_api::AppState>,
    mut detached: mpsc::UnboundedReceiver<String>,
) {
    while let Some(session_id) = detached.recv().await {
        if let Err(error) = reconcile_detached_terminal_status(&state, &session_id).await {
            log::warn!(
                "failed to reconcile detached terminal status for {}: {}",
                session_id,
                error
            );
        }
    }
}

pub(crate) async fn terminal_state_watcher_loop(
    state: Arc<http_api::AppState>,
    replacements: session_replacements::SessionReplacements,
) {
    loop {
        if let Err(error) = terminal_state_watcher_once(&state, &replacements).await {
            log::warn!("terminal state watcher reconnecting after error: {}", error);
        }
        // Exits broadcast while disconnected are lost along with their
        // replacement entries; stale entries must not swallow future Exits.
        replacements.clear();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn terminal_state_watcher_once(
    state: &http_api::AppState,
    replacements: &session_replacements::SessionReplacements,
) -> Result<(), String> {
    use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

    let config = state.config();
    let mut daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon connection failed: {}", e))?;
    match daemon
        .send_command(&DaemonCommand::Subscribe)
        .await
        .map_err(|e| format!("daemon subscribe failed: {}", e))?
    {
        DaemonEvent::Ok => {}
        DaemonEvent::Error { message, .. } => {
            return Err(format!("daemon subscribe error: {}", message));
        }
        other => return Err(format!("unexpected daemon subscribe response: {:?}", other)),
    }

    // Once subscribed, this connection can receive unsolicited events at any
    // time. Keep request/response commands on an unsubscribed control socket
    // so an event can never be consumed as the List reply.
    let mut control = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon control connection failed: {}", e))?;
    match control
        .send_command(&DaemonCommand::List)
        .await
        .map_err(|e| format!("daemon list failed: {}", e))?
    {
        DaemonEvent::SessionList { sessions } => {
            for session in sessions {
                let mut changed = match http_api::restore_task_run_for_live_session(
                    &config.db_path,
                    &session.session_id,
                ) {
                    Ok(restored) => restored,
                    Err(error) => {
                        log::warn!(
                            "failed to restore live task run for {}: {}",
                            session.session_id,
                            error
                        );
                        false
                    }
                };
                match apply_watcher_runtime_status(state, &session.session_id, session.status, None)
                {
                    Ok(status_changed) => changed |= status_changed,
                    Err(error) => log::warn!(
                        "failed to reconcile terminal status for {}: {}",
                        session.session_id,
                        error
                    ),
                }
                if changed {
                    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
                }
            }
        }
        DaemonEvent::Error { message, .. } => {
            return Err(format!("daemon list error: {}", message));
        }
        other => return Err(format!("unexpected daemon list response: {:?}", other)),
    }

    loop {
        match daemon
            .read_event()
            .await
            .map_err(|e| format!("daemon read failed: {}", e))?
        {
            DaemonEvent::StatusChanged {
                session_id,
                status,
                waiting_prompt_snippet,
            } => {
                // One daemon event, at most one state-changed publish: the
                // prompt, the runtime status, and the activity all move
                // together and the desktop refetches the same snapshot for
                // each.
                let mut changed = false;
                if let Some(prompt) = &waiting_prompt_snippet {
                    match persist_waiting_prompt(state, &session_id, prompt) {
                        Ok(prompt_changed) => changed |= prompt_changed,
                        Err(error) => log::warn!(
                            "failed to persist waiting prompt for {}: {}",
                            session_id,
                            error
                        ),
                    }
                }
                match apply_watcher_runtime_status(
                    state,
                    &session_id,
                    status,
                    waiting_prompt_snippet.as_deref(),
                ) {
                    Ok(status_changed) => changed |= status_changed,
                    Err(error) => log::warn!(
                        "failed to apply terminal status for {}: {}",
                        session_id,
                        error
                    ),
                }
                if changed {
                    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
                }
            }
            DaemonEvent::Exit {
                session_id,
                code,
                killed,
                resume_session_id,
            } => {
                // Consume the replacement entry even when the event is
                // self-describing — a leftover entry would swallow a future
                // legitimate Exit for the same session id.
                let replaced = replacements.consume(&session_id);
                if replaced || killed {
                    // Orchestrated kill (stage swap, rerun, close) — not the
                    // agent finishing.
                    continue;
                }
                if let Err(error) =
                    persist_exit_resume_session_id(state, &session_id, resume_session_id.as_deref())
                {
                    log::warn!(
                        "failed to persist terminal resume session id for {}: {}",
                        session_id,
                        error
                    );
                }
                // The exit code alone does not decide the reported outcome —
                // an agent that exits 0 after reporting failure still failed.
                // handle_task_terminal_state derives that from the task's
                // terminating run; this only says how the session ended.
                if let Err(error) =
                    http_api::handle_task_terminal_state(state, &session_id, code).await
                {
                    log::warn!(
                        "failed to handle terminal state for {} (exit code {}): {}",
                        session_id,
                        code,
                        error
                    );
                }
            }
            DaemonEvent::ShuttingDown => return Ok(()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Db;
    use kanna_daemon::protocol::{
        Command as DaemonCommand, Event as DaemonEvent, SessionInfo, SessionState,
    };
    use std::path::{Path, PathBuf};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::time::{timeout, Duration};

    fn unique_name(prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn daemon_socket_path_for_dir(daemon_dir: &Path) -> PathBuf {
        kanna_runtime_defaults::socket_path(daemon_dir)
    }

    fn test_config(unique: &str, daemon_dir: &Path) -> Config {
        Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: daemon_dir.to_string_lossy().to_string(),
            db_path: Db::test_db_path(unique),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "127.0.0.1".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            pairing_store_path: format!("/tmp/kanna-pairings-{unique}.json"),
        }
    }

    fn seed_notifying_task(config: &Config) {
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child prompt",
            Some("Child Display"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_notify_task("task-child", "task-parent")
            .unwrap();
    }

    fn seed_plain_task(config: &Config) {
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "Child prompt",
            Some("Child Display"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .unwrap();
    }

    fn bind_daemon_listener(daemon_dir: &Path) -> (UnixListener, PathBuf) {
        std::fs::create_dir_all(daemon_dir).unwrap();
        let socket_path = daemon_socket_path_for_dir(daemon_dir);
        let _ = std::fs::remove_file(&socket_path);
        (UnixListener::bind(&socket_path).unwrap(), socket_path)
    }

    async fn expect_subscribe(listener: &UnixListener) -> tokio::net::unix::OwnedWriteHalf {
        expect_subscribe_with_sessions(listener, Vec::new()).await
    }

    async fn expect_subscribe_with_sessions(
        listener: &UnixListener,
        sessions: Vec<SessionInfo>,
    ) -> tokio::net::unix::OwnedWriteHalf {
        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
            DaemonCommand::Subscribe => {}
            other => panic!("expected Subscribe command, got {other:?}"),
        }
        write_event(&mut write_half, &DaemonEvent::Ok).await;

        let (control_stream, _) = listener.accept().await.unwrap();
        let (control_read, mut control_write) = control_stream.into_split();
        let mut control_reader = BufReader::new(control_read);
        line.clear();
        control_reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
            DaemonCommand::List => {}
            other => panic!("expected List command, got {other:?}"),
        }
        write_event(&mut control_write, &DaemonEvent::SessionList { sessions }).await;
        write_half
    }

    async fn write_event(writer: &mut tokio::net::unix::OwnedWriteHalf, event: &DaemonEvent) {
        writer
            .write_all(format!("{}\n", serde_json::to_string(event).unwrap()).as_bytes())
            .await
            .unwrap();
    }

    async fn write_raw_event(writer: &mut tokio::net::unix::OwnedWriteHalf, event: &str) {
        writer.write_all(event.as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
    }

    async fn expect_no_notification_connection(listener: &UnixListener) {
        match timeout(Duration::from_millis(150), listener.accept()).await {
            Err(_) => {}
            Ok(Ok(_)) => panic!("killed exit unexpectedly opened a notification connection"),
            Ok(Err(error)) => panic!("failed while checking for notification connection: {error}"),
        }
    }

    async fn expect_completion_notification(listener: &UnixListener) -> Vec<Vec<u8>> {
        let (list_stream, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("notification session-list connection was not opened")
            .unwrap();
        let (list_read, mut list_write) = list_stream.into_split();
        let mut list_reader = BufReader::new(list_read);
        let mut line = String::new();
        list_reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
            DaemonCommand::List
        ));
        write_event(
            &mut list_write,
            &DaemonEvent::SessionList {
                sessions: vec![SessionInfo {
                    session_id: "task-parent".to_string(),
                    pid: 4242,
                    cwd: "/tmp".to_string(),
                    state: kanna_daemon::protocol::SessionState::Active,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    kind: kanna_daemon::protocol::SessionKind::Pty,
                }],
            },
        )
        .await;

        let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("notification connection was not opened")
            .unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut inputs = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
                DaemonCommand::InputIfSession {
                    session_id,
                    expected_pid,
                    data,
                } => {
                    assert_eq!(session_id, "task-parent");
                    assert_eq!(expected_pid, 4242);
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_event(&mut write_half, &DaemonEvent::Ok).await;
        }
        inputs
    }

    fn assert_task_not_completed(config: &Config) {
        let db = Db::open(&config.db_path).unwrap();
        let task = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(task.activity.as_deref(), Some("idle"));
        assert!(task.notified_at.is_none());
    }

    fn assert_task_completed(config: &Config) {
        let db = Db::open(&config.db_path).unwrap();
        let task = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(task.activity.as_deref(), Some("unread"));
        assert!(task.notified_at.is_some());
    }

    fn assert_task_agent_session_id(config: &Config, expected: &str) {
        let conn = rusqlite::Connection::open(&config.db_path).unwrap();
        let actual: Option<String> = conn
            .query_row(
                "SELECT agent_session_id FROM pipeline_item WHERE id = ?",
                ["task-child"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(actual.as_deref(), Some(expected));
    }

    #[tokio::test]
    async fn watcher_ignores_killed_exit_without_completion_side_effects() {
        let unique = unique_name("terminal-watcher-killed");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: true,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_not_completed(&config);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_exit_resume_session_id() {
        let unique = unique_name("terminal-watcher-resume-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .insert_stage_run(crate::db::NewStageRun {
                id: "run-codex-exit",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                effort: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/codex-task"),
                resumed_from_run_id: None,
            })
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    code: 0,
                    resume_session_id: Some("019d99a5-aa94-7c73-b786-644cc095c037".to_string()),
                    killed: false,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_agent_session_id(&config, "019d99a5-aa94-7c73-b786-644cc095c037");
        let run = Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(
            run.provider_session_id.as_deref(),
            Some("019d99a5-aa94-7c73-b786-644cc095c037")
        );
        assert_eq!(run.status, "cancelled");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_only_changed_waiting_prompts() {
        let unique = unique_name("terminal-watcher-waiting-prompt");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            for _ in 0..2 {
                write_event(
                    &mut subscriber,
                    &DaemonEvent::StatusChanged {
                        session_id: "task-child".to_string(),
                        status: kanna_daemon::protocol::SessionStatus::Idle,
                        waiting_prompt_snippet: Some("Ready for review".to_string()),
                    },
                )
                .await;
            }
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &state,
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        assert_eq!(
            db.get_pipeline_item("task-child")
                .unwrap()
                .unwrap()
                .last_output_preview
                .as_deref(),
            Some("Ready for review")
        );
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        assert!(matches!(
            state_changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_consumes_replacement_entry_even_for_killed_exit() {
        let unique = unique_name("terminal-watcher-killed-consumes-replacement");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let replacements = session_replacements::SessionReplacements::default();
        replacements.begin("task-child");
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    code: -1,
                    resume_session_id: None,
                    killed: true,
                },
            )
            .await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            let inputs = expect_completion_notification(&listener).await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            inputs
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(&http_api::AppState::new(config.clone()), &replacements),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        let inputs = server.await.unwrap();

        assert_eq!(
            inputs,
            vec![
                b"TASK task-child DONE [success]: Child Display".to_vec(),
                vec![b'\r']
            ]
        );
        assert_task_completed(&config);
        assert!(
            !replacements.consume("task-child"),
            "replacement entry should have been consumed by the killed exit"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_replacement_fallback_ignores_exit_without_killed_field() {
        let unique = unique_name("terminal-watcher-legacy-replacement");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_notifying_task(&config);
        let replacements = session_replacements::SessionReplacements::default();
        replacements.begin("task-child");
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_raw_event(
                &mut subscriber,
                r#"{"type":"Exit","session_id":"task-child","code":0}"#,
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            expect_no_notification_connection(&listener).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(&http_api::AppState::new(config.clone()), &replacements),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        assert_task_not_completed(&config);
        assert!(
            !replacements.consume("task-child"),
            "legacy replacement entry should have been consumed"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    /// The daemon is the only component that can tell a parked agent from a
    /// quiet one, and `activity` throws that distinction away. This is the
    /// hand-off that makes `task.awaiting_input` real rather than a guess.
    #[tokio::test]
    async fn watcher_records_waiting_status_and_emits_awaiting_input() {
        let unique = unique_name("terminal-watcher-awaiting-input");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Waiting,
                    waiting_prompt_snippet: Some("How should I publish the fix?".to_string()),
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        assert_eq!(
            db.get_pipeline_item_runtime_status("task-child")
                .unwrap()
                .as_deref(),
            Some("waiting")
        );
        let events = db
            .list_task_events(
                &crate::db::TaskEventScope::Tasks(vec!["task-child".to_string()]),
                0,
                i64::MAX,
                10,
            )
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "task.awaiting_input");
        assert_eq!(
            events[0].payload["prompt"],
            serde_json::json!("How should I publish the fix?")
        );

        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    /// Adopting a running task: the notification target is attached after the
    /// task started, and the same server-side completion path must honour it.
    #[tokio::test]
    async fn watcher_notifies_a_target_attached_after_task_creation() {
        let unique = unique_name("terminal-watcher-retrofit-notify");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_notify_task("task-child", Some("task-parent"))
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::Exit {
                    session_id: "task-child".to_string(),
                    code: 0,
                    resume_session_id: None,
                    killed: false,
                },
            )
            .await;
            let inputs = expect_completion_notification(&listener).await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            inputs
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        let inputs = server.await.unwrap();

        assert_eq!(
            inputs,
            vec![
                b"TASK task-child DONE [success]: Child Display".to_vec(),
                vec![b'\r']
            ]
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_applies_unattached_busy_as_working() {
        let unique = unique_name("terminal-watcher-unattached-busy");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        let item = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_applies_unattached_idle_from_working_and_emits_activity_event() {
        let unique = unique_name("terminal-watcher-unattached-idle");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: Some(
                        "Does this design have your approval?".to_string(),
                    ),
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        assert_eq!(
            item.last_output_preview.as_deref(),
            Some("Does this design have your approval?")
        );
        let events = Db::open(&config.db_path)
            .unwrap()
            .list_task_events(
                &crate::db::TaskEventScope::Tasks(vec!["task-child".to_string()]),
                0,
                i64::MAX,
                10,
            )
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "task.activity_changed");
        assert_eq!(
            events[0].payload,
            serde_json::json!({
                "previousActivity": "working",
                "activity": "unread",
                "waitingPromptSnippet": "Does this design have your approval?",
            })
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    /// The premise the MCP-layer activity debounce is built on. The daemon
    /// classifies each frame on its own, so one mid-redraw frame that loses the
    /// busy marker arrives here as a lone `Idle` between two `Busy` events —
    /// and this layer, correctly, stores it: `activity` is a record of the
    /// latest verdict, not a judgement about whether that verdict is plausible.
    /// A task read taken inside that window sees `unread` for an agent that
    /// never stopped, which is exactly what `kanna-mcp` confirms before
    /// reporting (see `crates/kanna-mcp/tests/activity_debounce.rs`).
    #[tokio::test]
    async fn watcher_parks_activity_at_unread_for_a_single_spurious_idle_frame() {
        let unique = unique_name("terminal-watcher-spurious-idle");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let db_path = config.db_path.clone();

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            for status in [
                kanna_daemon::protocol::SessionStatus::Busy,
                kanna_daemon::protocol::SessionStatus::Idle,
            ] {
                write_event(
                    &mut subscriber,
                    &DaemonEvent::StatusChanged {
                        session_id: "task-child".to_string(),
                        status,
                        waiting_prompt_snippet: None,
                    },
                )
                .await;
            }
            let spurious_stop = await_activity(&db_path, "unread").await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
            spurious_stop
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        let spurious_stop = server.await.unwrap();

        assert!(
            spurious_stop,
            "a single idle frame should reach a task read as a stopped-looking activity"
        );
        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(
            item.activity.as_deref(),
            Some("working"),
            "the next frame carrying the busy marker should undo the misread"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    /// Waits for the watcher to persist `activity`, which it does from its own
    /// task, and reports whether it got there before the wait ran out.
    async fn await_activity(db_path: &str, expected: &str) -> bool {
        for _ in 0..400 {
            let activity = Db::open(db_path)
                .unwrap()
                .get_pipeline_item("task-child")
                .unwrap()
                .and_then(|item| item.activity);
            if activity.as_deref() == Some(expected) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    #[tokio::test]
    async fn watcher_applies_attached_busy_as_working() {
        let unique = unique_name("terminal-watcher-attached-busy");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "unread")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let mut state_changes = state.subscribe_state_changes();
        let _attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert!(matches!(
            state_changes.try_recv(),
            Ok(kanna_agent_protocol::ServerFrame::StateChanged {
                scope: kanna_agent_protocol::StateChangeScope::Tasks
            })
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_skips_attached_idle_status() {
        let unique = unique_name("terminal-watcher-attached-idle");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let _attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: None,
                },
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &state,
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn final_detach_reconciliation_lists_once_and_applies_session_status() {
        let unique = unique_name("terminal-detach-reconcile");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        Db::open(&config.db_path)
            .unwrap()
            .update_pipeline_item_activity("task-child", "working")
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = Arc::new(http_api::AppState::new(config.clone()));
        let detached = state
            .terminal_attachments()
            .take_detach_receiver()
            .expect("detach receiver should be available");
        let worker = tokio::spawn(terminal_detach_reconciliation_loop(
            Arc::clone(&state),
            detached,
        ));
        let attachment = state.terminal_attachments().attach("task-child");

        let server = tokio::spawn(async move {
            let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("detach reconciliation did not connect")
                .unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut write_half,
                &DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-child".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: kanna_daemon::protocol::SessionStatus::Idle,
                        kind: Default::default(),
                    }],
                },
            )
            .await;

            assert!(timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err());
        });

        drop(attachment);
        server.await.unwrap();
        worker.abort();
        let _ = worker.await;

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn detach_reconciliation_is_skipped_while_refcount_is_positive() {
        let unique = unique_name("terminal-detach-still-attached");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);
        let state = http_api::AppState::new(config.clone());
        let _attachment = state.terminal_attachments().attach("task-child");

        reconcile_detached_terminal_status(&state, "task-child")
            .await
            .unwrap();
        assert!(timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err());

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("idle"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_reconciles_unattached_status_from_subscribe_time_list() {
        let unique = unique_name("terminal-watcher-list-reconcile");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-falsely-cancelled",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "cancelled",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: Some("provider-session"),
            cwd: Some("/tmp"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe_with_sessions(
                &listener,
                vec![SessionInfo {
                    session_id: "task-child".to_string(),
                    pid: 42,
                    cwd: "/tmp".to_string(),
                    state: SessionState::Active,
                    idle_seconds: 0,
                    status: kanna_daemon::protocol::SessionStatus::Busy,
                    kind: Default::default(),
                }],
            )
            .await;
            write_event(&mut subscriber, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config.clone()),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();

        let db = Db::open(&config.db_path).unwrap();
        let item = db.get_pipeline_item("task-child").unwrap().unwrap();
        assert_eq!(item.activity.as_deref(), Some("working"));
        assert_eq!(
            db.latest_stage_run("task-child").unwrap().unwrap().status,
            "running"
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_preserves_subscriber_event_interleaved_before_list_reply() {
        let unique = unique_name("terminal-watcher-list-interleaved-status");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (subscriber_stream, _) = listener.accept().await.unwrap();
            let (subscriber_read, mut subscriber_write) = subscriber_stream.into_split();
            let mut subscriber_reader = BufReader::new(subscriber_read);
            let mut line = String::new();
            subscriber_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));
            write_event(&mut subscriber_write, &DaemonEvent::Ok).await;

            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            line.clear();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));

            // This unsolicited subscriber event arrives after Subscribe is
            // acknowledged but before the independent List response.
            write_event(
                &mut subscriber_write,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: Some("Ready after reconciliation".to_string()),
                },
            )
            .await;
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: vec![SessionInfo {
                        session_id: "task-child".to_string(),
                        pid: 42,
                        cwd: "/tmp".to_string(),
                        state: SessionState::Active,
                        idle_seconds: 0,
                        status: kanna_daemon::protocol::SessionStatus::Busy,
                        kind: Default::default(),
                    }],
                },
            )
            .await;
            write_event(&mut subscriber_write, &DaemonEvent::ShuttingDown).await;
        });

        timeout(
            Duration::from_secs(2),
            terminal_state_watcher_once(
                &http_api::AppState::new(config.clone()),
                &session_replacements::SessionReplacements::default(),
            ),
        )
        .await
        .expect("watcher did not finish")
        .unwrap();
        server.await.unwrap();

        let item = Db::open(&config.db_path)
            .unwrap()
            .get_pipeline_item("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(item.activity.as_deref(), Some("unread"));
        assert_eq!(
            item.last_output_preview.as_deref(),
            Some("Ready after reconciliation")
        );
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
