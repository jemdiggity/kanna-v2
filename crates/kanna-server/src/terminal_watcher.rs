use crate::{daemon_client, http_api, session_replacements};
use std::sync::Arc;
use tokio::sync::mpsc;

fn persist_provider_session_id(
    state: &http_api::AppState,
    run_id: Option<&str>,
    resume_session_id: Option<&str>,
) -> Result<(), String> {
    let Some(run_id) = run_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let Some(resume_session_id) = resume_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let db = crate::db::Db::open(&state.config().db_path).map_err(|e| format!("db error: {e}"))?;
    let update = db
        .update_stage_run_provider_session_id(run_id, resume_session_id)
        .map_err(|e| format!("db error: {e}"))?;
    if let Some(task_id) = update.current_task_id {
        db.update_pipeline_item_agent_session_id(&task_id, Some(resume_session_id))
            .map_err(|e| format!("db error: {e}"))?;
    }
    if update.changed {
        state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    }
    Ok(())
}

fn persist_waiting_prompt(
    state: &http_api::AppState,
    session_id: &str,
    prompt: &str,
) -> Result<(), String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Ok(());
    }
    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    if db
        .update_pipeline_item_waiting_prompt(session_id, prompt)
        .map_err(|error| format!("db error: {error}"))?
    {
        state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    }
    Ok(())
}

fn apply_watcher_runtime_status(
    state: &http_api::AppState,
    session_id: &str,
    status: kanna_daemon::protocol::SessionStatus,
) -> Result<(), String> {
    // Busy is selection-independent: every live observer agrees it means
    // working, so the watcher remains an authoritative writer even while a
    // terminal client is attached. Idle/waiting still belong to the attached
    // client because only it knows whether the task is selected (idle) or
    // unselected (unread).
    if state.terminal_attachments().is_attached(session_id)
        && !matches!(status, kanna_daemon::protocol::SessionStatus::Busy)
    {
        return Ok(());
    }

    let db = crate::db::Db::open(&state.config().db_path)
        .map_err(|error| format!("db error: {error}"))?;
    let Some(task_id) = db
        .resolve_pipeline_item_id(session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(());
    };
    let Some(item) = db
        .get_pipeline_item(&task_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(());
    };
    if item.closed_at.is_some() {
        return Ok(());
    }

    let status = match status {
        kanna_daemon::protocol::SessionStatus::Busy => "busy",
        kanna_daemon::protocol::SessionStatus::Waiting => "waiting",
        kanna_daemon::protocol::SessionStatus::Idle => "idle",
    };
    let Some(activity) = http_api::task_activity::activity_for_runtime_status(
        item.activity.as_deref(),
        status,
        false,
    ) else {
        return Ok(());
    };

    db.update_pipeline_item_activity(&task_id, activity)
        .map_err(|error| format!("db error: {error}"))?;
    state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
    Ok(())
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
        DaemonEvent::SessionList { sessions, .. } => {
            if let Some(session) = sessions
                .into_iter()
                .find(|session| session.session_id == session_id)
            {
                // The runtime-status helper re-checks the lease after the
                // daemon round-trip, closing a concurrent reattach race for
                // selection-dependent idle/waiting updates.
                apply_watcher_runtime_status(state, session_id, session.status)?;
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
    // Negotiate on an unsubscribed control socket before opening the event
    // stream. An old daemon's List response has no capabilities and therefore
    // selects the legacy stream, which never receives new enum variants.
    let mut control = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon control connection failed: {}", e))?;
    let daemon_list = control
        .list()
        .await
        .map_err(|e| format!("daemon list failed: {}", e))?;
    for session in daemon_list.sessions {
        if let Err(error) = apply_watcher_runtime_status(state, &session.session_id, session.status)
        {
            log::warn!(
                "failed to reconcile terminal status for {}: {}",
                session.session_id,
                error
            );
        }
    }
    let subscribe = if daemon_list.capabilities.provider_session_events
        && daemon_list.capabilities.event_stream_version
            >= kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION
    {
        DaemonCommand::SubscribeEvents {
            version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION,
        }
    } else {
        DaemonCommand::Subscribe
    };

    let mut daemon = daemon_client::DaemonClient::connect(&config.daemon_dir)
        .await
        .map_err(|e| format!("daemon connection failed: {}", e))?;
    match daemon
        .send_command(&subscribe)
        .await
        .map_err(|e| format!("daemon subscribe failed: {}", e))?
    {
        DaemonEvent::Ok => {}
        DaemonEvent::Error { message, .. } => {
            return Err(format!("daemon subscribe error: {}", message));
        }
        other => return Err(format!("unexpected daemon subscribe response: {:?}", other)),
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
                if let Some(prompt) = waiting_prompt_snippet {
                    if let Err(error) = persist_waiting_prompt(state, &session_id, &prompt) {
                        log::warn!(
                            "failed to persist waiting prompt for {}: {}",
                            session_id,
                            error
                        );
                    }
                }
                if let Err(error) = apply_watcher_runtime_status(state, &session_id, status) {
                    log::warn!(
                        "failed to apply terminal status for {}: {}",
                        session_id,
                        error
                    );
                }
            }
            DaemonEvent::ProviderSessionChanged {
                session_id,
                run_id,
                provider_session_id,
            } => {
                if let Err(error) = persist_provider_session_id(
                    state,
                    run_id.as_deref(),
                    Some(&provider_session_id),
                ) {
                    log::warn!(
                        "failed to persist provider session id for {}: {}",
                        session_id,
                        error
                    );
                }
            }
            DaemonEvent::Exit {
                session_id,
                run_id,
                code,
                killed,
                resume_session_id,
            } => {
                // Consume the replacement entry even when the event is
                // self-describing — a leftover entry would swallow a future
                // legitimate Exit for the same session id.
                let replaced = replacements.consume(&session_id);
                if let Err(error) = persist_provider_session_id(
                    state,
                    run_id.as_deref(),
                    resume_session_id.as_deref(),
                ) {
                    log::warn!(
                        "failed to persist terminal resume session id for {}: {}",
                        session_id,
                        error
                    );
                }
                if replaced || killed {
                    // Orchestrated kill (stage swap, rerun, close) — not the
                    // agent finishing.
                    continue;
                }
                let success = code == 0;
                if let Err(error) =
                    http_api::handle_task_terminal_state(state, &session_id, success).await
                {
                    log::warn!(
                        "failed to handle terminal state for {} (success={}): {}",
                        session_id,
                        success,
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
    use crate::db::{Db, NewStageRun};
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
        let (control_stream, _) = listener.accept().await.unwrap();
        let (control_read, mut control_write) = control_stream.into_split();
        let mut control_reader = BufReader::new(control_read);
        let mut line = String::new();
        control_reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
            DaemonCommand::List => {}
            other => panic!("expected List command, got {other:?}"),
        }
        write_event(
            &mut control_write,
            &DaemonEvent::SessionList {
                sessions,
                capabilities: None,
            },
        )
        .await;

        let (stream, _) = listener.accept().await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonCommand>(line.trim()).unwrap() {
            DaemonCommand::Subscribe => {}
            other => panic!("expected Subscribe command, got {other:?}"),
        }
        write_event(&mut write_half, &DaemonEvent::Ok).await;
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
                DaemonCommand::Input { session_id, data } => {
                    assert_eq!(session_id, "task-parent");
                    inputs.push(data);
                }
                other => panic!("expected Input command, got {other:?}"),
            }
            write_event(&mut write_half, &DaemonEvent::Ok).await;
        }
        inputs
    }

    #[tokio::test]
    async fn watcher_negotiates_versioned_subscription_when_daemon_advertises_it() {
        let unique = unique_name("terminal-watcher-versioned-subscription");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            let mut line = String::new();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
            write_event(
                &mut control_write,
                &DaemonEvent::SessionList {
                    sessions: Vec::new(),
                    capabilities: Some(kanna_daemon::protocol::DaemonCapabilities::current()),
                },
            )
            .await;

            let (subscriber_stream, _) = listener.accept().await.unwrap();
            let (subscriber_read, mut subscriber_write) = subscriber_stream.into_split();
            let mut subscriber_reader = BufReader::new(subscriber_read);
            line.clear();
            subscriber_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::SubscribeEvents {
                    version: kanna_daemon::protocol::CURRENT_EVENT_STREAM_VERSION
                }
            ));
            write_event(&mut subscriber_write, &DaemonEvent::Ok).await;
            write_event(&mut subscriber_write, &DaemonEvent::ShuttingDown).await;
        });

        terminal_state_watcher_once(
            &http_api::AppState::new(config),
            &session_replacements::SessionReplacements::default(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
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
                    run_id: None,
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
            .insert_stage_run(NewStageRun {
                id: "run-current",
                task_id: "task-child",
                stage: "in progress",
                kind: "main",
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status: "running",
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id: None,
                cwd: Some("/tmp/task-child"),
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
                    run_id: Some("run-current".to_string()),
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
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_killed_exit_resume_id_on_completed_stage_run() {
        let unique = unique_name("terminal-watcher-killed-resume-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(NewStageRun {
            id: "run-implement",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("codex"),
            model: None,
            status: "succeeded",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: Some("/tmp/task-child"),
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
                    run_id: Some("run-implement".to_string()),
                    code: 137,
                    resume_session_id: Some("codex-thread".to_string()),
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

        let run = Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(run.provider_session_id.as_deref(), Some("codex-thread"));
        assert_task_not_completed(&config);
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn watcher_persists_live_headless_provider_session_id() {
        let unique = unique_name("terminal-watcher-live-provider-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        db.insert_stage_run(NewStageRun {
            id: "run-implement",
            task_id: "task-child",
            stage: "in progress",
            kind: "main",
            agent: None,
            agent_provider: Some("opencode"),
            model: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-child"),
            provider_session_id: None,
            cwd: Some("/tmp/task-child"),
            resumed_from_run_id: None,
        })
        .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-implement".to_string()),
                    provider_session_id: "opencode-session".to_string(),
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

        let run = Db::open(&config.db_path)
            .unwrap()
            .latest_stage_run("task-child")
            .unwrap()
            .unwrap();
        assert_eq!(run.provider_session_id.as_deref(), Some("opencode-session"));
        assert_task_agent_session_id(&config, "opencode-session");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn delayed_old_provider_event_updates_only_its_owning_main_run() {
        let unique = unique_name("terminal-watcher-delayed-provider-session");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let db = Db::open(&config.db_path).unwrap();
        for (id, stage, kind, status, provider_session_id) in [
            ("run-old", "in progress", "main", "succeeded", None),
            ("run-post", "commit", "post", "succeeded", None),
            (
                "run-replacement",
                "review",
                "main",
                "running",
                Some("replacement-thread"),
            ),
        ] {
            db.insert_stage_run(NewStageRun {
                id,
                task_id: "task-child",
                stage,
                kind,
                agent: None,
                agent_provider: Some("codex"),
                model: None,
                status,
                result: None,
                feedback: None,
                session_id: Some("task-child"),
                provider_session_id,
                cwd: Some("/tmp/task-child"),
                resumed_from_run_id: None,
            })
            .unwrap();
        }
        db.update_pipeline_item_agent_session_id("task-child", Some("replacement-thread"))
            .unwrap();
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let mut subscriber = expect_subscribe(&listener).await;
            write_event(
                &mut subscriber,
                &DaemonEvent::ProviderSessionChanged {
                    session_id: "task-child".to_string(),
                    run_id: Some("run-old".to_string()),
                    provider_session_id: "old-thread".to_string(),
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

        let runs = Db::open(&config.db_path)
            .unwrap()
            .list_stage_runs_for_task("task-child")
            .unwrap();
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-old")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("old-thread")
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-post")
                .and_then(|run| run.provider_session_id.as_deref()),
            None
        );
        assert_eq!(
            runs.iter()
                .find(|run| run.id == "run-replacement")
                .and_then(|run| run.provider_session_id.as_deref()),
            Some("replacement-thread")
        );
        assert_task_agent_session_id(&config, "replacement-thread");
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
                    run_id: None,
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
                    run_id: None,
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
    async fn watcher_applies_unattached_idle_from_working_as_unread() {
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
        assert_eq!(item.activity.as_deref(), Some("unread"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
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
                    capabilities: None,
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
    async fn watcher_applies_subscriber_event_after_list_negotiation() {
        let unique = unique_name("terminal-watcher-list-interleaved-status");
        let daemon_dir = std::env::temp_dir().join(format!("{unique}-daemon"));
        let config = test_config(&unique, &daemon_dir);
        seed_plain_task(&config);
        let (listener, socket_path) = bind_daemon_listener(&daemon_dir);

        let server = tokio::spawn(async move {
            let (control_stream, _) = listener.accept().await.unwrap();
            let (control_read, mut control_write) = control_stream.into_split();
            let mut control_reader = BufReader::new(control_read);
            let mut line = String::new();
            control_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::List
            ));
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
                    capabilities: None,
                },
            )
            .await;

            let (subscriber_stream, _) = listener.accept().await.unwrap();
            let (subscriber_read, mut subscriber_write) = subscriber_stream.into_split();
            let mut subscriber_reader = BufReader::new(subscriber_read);
            line.clear();
            subscriber_reader.read_line(&mut line).await.unwrap();
            assert!(matches!(
                serde_json::from_str::<DaemonCommand>(line.trim()).unwrap(),
                DaemonCommand::Subscribe
            ));
            write_event(&mut subscriber_write, &DaemonEvent::Ok).await;
            write_event(
                &mut subscriber_write,
                &DaemonEvent::StatusChanged {
                    session_id: "task-child".to_string(),
                    status: kanna_daemon::protocol::SessionStatus::Idle,
                    waiting_prompt_snippet: Some("Ready after reconciliation".to_string()),
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
