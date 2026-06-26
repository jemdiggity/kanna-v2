use std::io::{BufRead, BufReader, Read, Write as IoWrite};

use tokio::sync::broadcast;

use kanna_agent_protocol::{AgentEvent, PermissionDecision, SessionEndReason, TurnModel};
use kanna_daemon::agent::{event_status, AgentSessions};
use kanna_daemon::protocol::{Event, SessionStatus};

use super::{broadcast_event, journal_and_fan_out, log_info, set_status};

/// Spawn the stdout + stderr reader threads for a (re)spawned agent child.
pub fn start_agent_readers(
    session_id: String,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
) {
    {
        let session_id = session_id.clone();
        let agents = agents.clone();
        let broadcast_tx = broadcast_tx.clone();
        tokio::task::spawn_blocking(move || {
            run_agent_reader(session_id, Box::new(stdout), false, agents, broadcast_tx);
        });
    }
    tokio::task::spawn_blocking(move || {
        run_agent_reader(session_id, Box::new(stderr), true, agents, broadcast_tx);
    });
}

fn run_agent_reader(
    session_id: String,
    reader: Box<dyn Read + Send>,
    is_stderr: bool,
    agents: AgentSessions,
    broadcast_tx: broadcast::Sender<String>,
) {
    let rt = tokio::runtime::Handle::current();
    log_info(format_args!(
        "[agent] reader start session={} stderr={}",
        session_id, is_stderr
    ));

    for line in BufReader::new(reader).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let events = if is_stderr {
            vec![AgentEvent::Diagnostic { message: line }]
        } else {
            let adapter = rt.block_on(async {
                agents
                    .lock()
                    .await
                    .get(&session_id)
                    .map(|record| record.adapter.clone())
            });
            let Some(adapter) = adapter else {
                // Session removed (killed) — stop reading.
                return;
            };
            let mut guard = match adapter.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.parse_line(&line)
        };

        for event in events {
            rt.block_on(process_event(&session_id, event, &agents, &broadcast_tx));
        }
    }

    log_info(format_args!(
        "[agent] reader eof session={} stderr={}",
        session_id, is_stderr
    ));
    if !is_stderr {
        rt.block_on(handle_child_exit(&session_id, &agents, &broadcast_tx));
    }
}

async fn process_event(
    session_id: &str,
    event: AgentEvent,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    // Registry pass: capture provider session id, permission bookkeeping,
    // status derivation, auto-allow.
    let mut auto_resolve: Option<String> = None;
    let mut provider_session_to_persist: Option<String> = None;
    let shared = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        record.last_activity_at = std::time::Instant::now();

        {
            let provider_session_id = match record.adapter.lock() {
                Ok(adapter) => adapter.provider_session_id(),
                Err(poisoned) => poisoned.into_inner().provider_session_id(),
            };
            if provider_session_id.is_some() {
                record.provider_session_id = provider_session_id.clone();
                provider_session_to_persist = provider_session_id;
            }
        }

        match &event {
            AgentEvent::PermissionRequest {
                request_id,
                tool_name,
                ..
            } => {
                if record.session_allowed_tools.contains(tool_name) {
                    let line = match record.adapter.lock() {
                        Ok(mut adapter) => adapter
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                        Err(poisoned) => poisoned
                            .into_inner()
                            .encode_permission_response(request_id, &PermissionDecision::Allow),
                    };
                    if let (Some(line), Some(stdin)) = (line, record.stdin.as_mut()) {
                        if writeln!(stdin, "{line}")
                            .and_then(|_| stdin.flush())
                            .is_ok()
                        {
                            auto_resolve = Some(request_id.clone());
                        }
                    }
                }
                if auto_resolve.is_none() {
                    record.pending_permissions.insert(request_id.clone());
                }
            }
            AgentEvent::PermissionResolved { request_id, .. } => {
                record.pending_permissions.remove(request_id);
            }
            _ => {}
        }

        if let Some(next) = event_status(&event) {
            // An auto-approved request never surfaces as Waiting.
            let next = if auto_resolve.is_some() {
                SessionStatus::Busy
            } else {
                next
            };
            set_status(record, broadcast_tx, session_id, next);
        }

        record.shared.clone()
    };

    if let Some(provider_session_id) = provider_session_to_persist {
        let mut sh = shared.lock().await;
        sh.journal.set_provider_session_id(&provider_session_id);
    }

    journal_and_fan_out(session_id, &shared, event).await;
    if let Some(request_id) = auto_resolve {
        journal_and_fan_out(
            session_id,
            &shared,
            AgentEvent::PermissionResolved {
                request_id,
                decision: PermissionDecision::AllowSession,
            },
        )
        .await;
    }
}

async fn handle_child_exit(
    session_id: &str,
    agents: &AgentSessions,
    broadcast_tx: &broadcast::Sender<String>,
) {
    let (shared, code, per_turn, interrupted) = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(session_id) else {
            return;
        };
        let code = record
            .child
            .as_mut()
            .and_then(|child| child.wait().ok())
            .and_then(|status| status.code())
            .unwrap_or(-1);
        record.child = None;
        record.stdin = None;
        record.exited = true;
        let interrupted = std::mem::replace(&mut record.interrupt_requested, false);
        if let Some(fds) = record.handoff_fds.take() {
            fds.close();
        }
        set_status(record, broadcast_tx, session_id, SessionStatus::Idle);
        let per_turn = matches!(record.turn_model, TurnModel::PerTurn);
        (record.shared.clone(), code, per_turn, interrupted)
    };

    // A user-initiated stop signals the child to exit; surface it as an
    // interruption (never a crash) and end the turn so the UI stops showing
    // activity. Per-turn sessions stay usable — the next message respawns the
    // provider.
    let reason = if interrupted {
        SessionEndReason::Interrupted
    } else if per_turn && code == 0 {
        // Per-turn providers exit after every turn by design — process churn is
        // an implementation detail, not a session event.
        return;
    } else if code == 0 {
        SessionEndReason::Completed
    } else {
        SessionEndReason::Crashed
    };
    journal_and_fan_out(
        session_id,
        &shared,
        AgentEvent::SessionEnded {
            reason,
            exit_code: Some(code),
            message: None,
        },
    )
    .await;
    broadcast_event(
        broadcast_tx,
        &Event::Exit {
            session_id: session_id.to_string(),
            code,
            resume_session_id: None,
        },
    );
}
