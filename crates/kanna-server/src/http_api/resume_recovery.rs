//! Runtime recovery for a Claude resume the provider itself rejects.
//!
//! Kanna checks before a resume that the provider transcript is on disk
//! (`task_creator::resume`), and falls back to a fresh conversation when it is
//! not. That preflight cannot cover the second failure mode: the CLI starts,
//! reads its own store, decides the session is unusable, prints its
//! missing-session error and exits. Nothing ran, but to the daemon it looks
//! exactly like an agent that died — the run is recorded failed and the task is
//! parked with a dead session and a transcript that will never come back.
//!
//! This module classifies that one narrow case and relaunches the same stage,
//! in the same worktree, once, without `--resume`. Everything else is left to
//! the caller's normal terminal-state handling: an agent that genuinely failed
//! must still be reported as failed.

use super::state::AppState;
use crate::db::Db;
use kanna_daemon::protocol::{Command as DaemonCommand, Event as DaemonEvent};

/// What inspecting an exited session found.
pub(super) enum RejectedResumeRecovery {
    /// Not a rejected Claude resume. The caller owns the exit as usual.
    NotApplicable,
    /// A fresh replacement session is running for the same task, stage and
    /// worktree. The exit must not finalize the task or notify anyone.
    Relaunched,
    /// The exit *was* a rejected resume, but the fresh relaunch did not land.
    /// The caller finalizes with the original failure; this string only
    /// explains why the recovery did not save it.
    RelaunchFailed(String),
}

/// Claude CLI wordings that mean "the conversation you asked me to resume is
/// not there". This list is the whole classifier: no other agent failure may
/// be retried with a fresh context, because a fresh context silently discards
/// whatever the agent had already worked out.
const CLAUDE_RESUME_REJECTION_MARKERS: &[&str] = &[
    "no conversation found with session id",
    "no conversation found",
    "no conversations found",
    "no conversation to resume",
    "could not resume session",
    "session not found",
    "no such session",
];

/// The offending line from the session's terminal output, when it carries one
/// of the markers above. Matching per line keeps the recorded reason precise
/// and keeps a marker that only appears as part of a longer transcript dump
/// from swallowing the whole screen.
fn claude_resume_rejection(terminal_text: &str) -> Option<String> {
    terminal_text.lines().find_map(|line| {
        let lowered = line.to_lowercase();
        CLAUDE_RESUME_REJECTION_MARKERS
            .iter()
            .any(|marker| lowered.contains(marker))
            .then(|| truncate_for_reason(line.trim()))
    })
}

fn truncate_for_reason(line: &str) -> String {
    const MAX: usize = 200;
    if line.chars().count() <= MAX {
        return line.to_string();
    }
    let truncated: String = line.chars().take(MAX).collect();
    format!("{truncated}…")
}

async fn session_terminal_text(daemon_dir: &str, session_id: &str) -> Result<String, String> {
    let mut daemon = crate::daemon_client::DaemonClient::connect(daemon_dir)
        .await
        .map_err(|error| format!("daemon error: {error}"))?;
    match daemon
        .send_command(&DaemonCommand::Snapshot {
            session_id: session_id.to_string(),
        })
        .await
        .map_err(|error| format!("daemon error: {error}"))?
    {
        DaemonEvent::Snapshot { snapshot, .. } => {
            Ok(kanna_runtime_defaults::strip_ansi_for_display(&snapshot.vt))
        }
        DaemonEvent::Error { message, .. } => Err(format!("daemon snapshot error: {message}")),
        other => Err(format!("unexpected daemon snapshot response: {other:?}")),
    }
}

/// Inspect an exited session and, when it is a Claude resume the CLI refused,
/// relaunch the stage with a fresh conversation exactly once.
pub(super) async fn recover_rejected_claude_resume(
    state: &AppState,
    session_id: &str,
    exit_code: i32,
) -> RejectedResumeRecovery {
    // A clean exit is an agent ending its own session, whatever it printed
    // along the way. Only a failed process can be a launch that never started.
    if exit_code == 0 {
        return RejectedResumeRecovery::NotApplicable;
    }
    let config = state.config();
    let db = match Db::open(&config.db_path) {
        Ok(db) => db,
        Err(error) => {
            log::warn!("resume recovery could not open the database: {error}");
            return RejectedResumeRecovery::NotApplicable;
        }
    };
    let candidate = match rejected_resume_candidate(&db, session_id) {
        Ok(Some(candidate)) => candidate,
        Ok(None) => return RejectedResumeRecovery::NotApplicable,
        Err(error) => {
            log::warn!("resume recovery could not read task state for {session_id}: {error}");
            return RejectedResumeRecovery::NotApplicable;
        }
    };
    let terminal_text = match session_terminal_text(&config.daemon_dir, session_id).await {
        Ok(text) => text,
        Err(error) => {
            // Without the session's output there is no evidence of a rejected
            // resume, so the exit stays a plain failure.
            log::warn!("resume recovery could not read the terminal for {session_id}: {error}");
            return RejectedResumeRecovery::NotApplicable;
        }
    };
    let Some(rejection) = claude_resume_rejection(&terminal_text) else {
        return RejectedResumeRecovery::NotApplicable;
    };

    // The operator (or another server path) may already be replacing this
    // task's session. Whoever holds the mutation owns the next spawn.
    let Some(_mutation) = state.try_begin_requested_task_mutation(&candidate.task_id) else {
        return RejectedResumeRecovery::RelaunchFailed(format!(
            "task {} is already being mutated; left the rejected resume as a failure",
            candidate.task_id
        ));
    };

    let reason = format!(
        "claude could not resume provider session {}: {rejection}",
        candidate
            .provider_session_id
            .as_deref()
            .unwrap_or("recorded on the previous run")
    );
    log::warn!(
        "claude rejected the resumed session for task {} (exit code {exit_code}): {rejection}; \
         relaunching the stage with a fresh conversation",
        candidate.task_id
    );

    // Prepare before writing anything: a preparation failure must leave the
    // exit exactly as the caller found it, so the original failure is what
    // gets reported.
    let prepared = match crate::task_creator::prepare_fresh_restart_after_rejected_resume(
        &db,
        config,
        &candidate.task_id,
        &candidate.run_id,
        &reason,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            return RejectedResumeRecovery::RelaunchFailed(format!(
                "could not prepare a fresh relaunch: {error}"
            ))
        }
    };

    // Close the rejected attempt as what it was — a launch that never ran —
    // before the replacement is recorded. It must not stay `running` (the
    // spawn would then mark it succeeded on its way past) and it must not go
    // through the interrupted-session path, which would offer the operator the
    // same impossible resume again.
    let rejected_result = format!(
        "claude rejected the recorded provider session at launch (exit code {exit_code}): \
         {rejection}; relaunched this stage with a fresh conversation"
    );
    if let Err(error) = db.finish_stage_run(
        &candidate.run_id,
        "failed",
        Some(&rejected_result),
        // Keep whatever the attempt was carrying — a resumed revision's
        // requested changes are part of its record.
        candidate.feedback.as_deref(),
    ) {
        return RejectedResumeRecovery::RelaunchFailed(format!(
            "could not close the rejected resume run: db error: {error}"
        ));
    }

    let mut daemon = match crate::daemon_client::DaemonClient::connect(&config.daemon_dir).await {
        Ok(daemon) => daemon,
        Err(error) => {
            return RejectedResumeRecovery::RelaunchFailed(format!("daemon error: {error}"))
        }
    };
    match crate::task_creator::spawn_prepared_stage_run_for_api(
        &config.db_path,
        &mut daemon,
        &state.session_replacements,
        prepared,
    )
    .await
    {
        Ok(_) => {
            state.publish_state_changed(kanna_agent_protocol::StateChangeScope::Tasks);
            RejectedResumeRecovery::Relaunched
        }
        Err(error) => RejectedResumeRecovery::RelaunchFailed(format!(
            "fresh relaunch failed to spawn: {error}"
        )),
    }
}

/// The run an exit could be a rejected resume of.
struct RejectedResumeCandidate {
    task_id: String,
    run_id: String,
    provider_session_id: Option<String>,
    feedback: Option<String>,
}

/// Every structural precondition, before the terminal is read: an open task
/// whose latest run is the still-running Claude session that this exit belongs
/// to, and which was launched as a resume.
fn rejected_resume_candidate(
    db: &Db,
    session_id: &str,
) -> Result<Option<RejectedResumeCandidate>, String> {
    let Some(task_id) = db
        .resolve_pipeline_item_id(session_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    let closed = db
        .get_pipeline_item(&task_id)
        .map_err(|error| format!("db error: {error}"))?
        .map(|item| item.closed_at.is_some())
        .unwrap_or(true);
    if closed {
        return Ok(None);
    }
    let Some(run) = db
        .latest_stage_run(&task_id)
        .map_err(|error| format!("db error: {error}"))?
    else {
        return Ok(None);
    };
    // `resumed_from_run_id` is what makes this retryable, and it is also what
    // makes the retry one-shot: the replacement is a fresh run, so a second
    // rejection has nothing to classify.
    if run.status != "running"
        || run.resumed_from_run_id.is_none()
        || run.agent_provider.as_deref() != Some("claude")
        || run.session_id.as_deref() != Some(session_id)
    {
        return Ok(None);
    }
    Ok(Some(RejectedResumeCandidate {
        task_id,
        run_id: run.id,
        provider_session_id: run.provider_session_id,
        feedback: run.feedback,
    }))
}

#[cfg(test)]
mod tests {
    use super::claude_resume_rejection;

    #[test]
    fn classifies_the_claude_missing_session_error() {
        assert_eq!(
            claude_resume_rejection(
                "Running startup...\n\
                 No conversation found with session ID: 7f7d2f7a-1b2e-4c3d-9a8b-123456789abc\n"
            )
            .as_deref(),
            Some("No conversation found with session ID: 7f7d2f7a-1b2e-4c3d-9a8b-123456789abc")
        );
    }

    #[test]
    fn ignores_an_ordinary_agent_failure() {
        assert_eq!(
            claude_resume_rejection(
                "error: the build failed\n\
                 thread 'main' panicked at src/main.rs:1:1\n"
            ),
            None
        );
    }

    /// The recovery discards whatever the agent had in flight, so a failure
    /// that merely mentions sessions must never reach it.
    #[test]
    fn ignores_unrelated_session_wording() {
        assert_eq!(
            claude_resume_rejection("warning: tmux session already exists; attaching instead\n"),
            None
        );
    }

    #[test]
    fn truncates_a_pathological_line() {
        let line = format!("No conversation found with session ID: {}", "x".repeat(500));
        let reason = claude_resume_rejection(&line).expect("classified");
        assert_eq!(reason.chars().count(), 201);
        assert!(reason.ends_with('…'));
    }
}
