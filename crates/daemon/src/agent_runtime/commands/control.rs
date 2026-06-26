use std::io::Write as IoWrite;

use kanna_agent_protocol::InterruptAction;
use kanna_daemon::agent::{self, AgentClientWriter, AgentSessions};
use kanna_daemon::protocol::{self, Event};

use crate::agent_runtime::common::{agent_error, reply};

pub async fn handle_agent_interrupt(
    session_id: String,
    writer: AgentClientWriter,
    agents: AgentSessions,
) {
    let result = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        let action = match record.adapter.lock() {
            Ok(mut adapter) => adapter.encode_interrupt(),
            Err(poisoned) => poisoned.into_inner().encode_interrupt(),
        };
        match action {
            InterruptAction::StdinLine(line) => match record.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
                None => Err(std::io::Error::other("stdin closed")),
            },
            InterruptAction::Signal => {
                if record.exited {
                    Ok(())
                } else {
                    // The signal makes the child exit; flag it so the exit is
                    // surfaced as an interruption, not a crash.
                    record.interrupt_requested = true;
                    agent::signal_agent_pid(record.pid, libc::SIGINT)
                }
            }
        }
    };

    match result {
        Ok(()) => reply(&writer, &Event::Ok).await,
        Err(error) => {
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::WriteFailed,
                    format!("failed to interrupt agent: {error}"),
                ),
            )
            .await
        }
    }
}

/// Switch the agent's model. The new model is stored on the session so any
/// future spawn uses it (the only mechanism for per-turn providers); for live
/// persistent providers, a `set_model` control line is also written to stdin so
/// the change takes effect immediately.
pub async fn handle_agent_set_model(
    session_id: String,
    model: String,
    writer: AgentClientWriter,
    agents: AgentSessions,
) {
    let result = {
        let mut registry = agents.lock().await;
        let Some(record) = registry.get_mut(&session_id) else {
            drop(registry);
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::SessionNotFound,
                    format!("agent session not found: {session_id}"),
                ),
            )
            .await;
            return;
        };

        record.params.model = Some(model.clone());
        let line = match record.adapter.lock() {
            Ok(mut adapter) => adapter.encode_set_model(&model),
            Err(poisoned) => poisoned.into_inner().encode_set_model(&model),
        };
        match line {
            Some(line) if !record.exited => match record.stdin.as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|_| stdin.flush()),
                // No live stdin to steer; the stored model covers the next spawn.
                None => Ok(()),
            },
            _ => Ok(()),
        }
    };

    match result {
        Ok(()) => reply(&writer, &Event::Ok).await,
        Err(error) => {
            reply(
                &writer,
                &agent_error(
                    protocol::ErrorCode::WriteFailed,
                    format!("failed to set agent model: {error}"),
                ),
            )
            .await
        }
    }
}
