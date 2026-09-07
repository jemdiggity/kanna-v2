//! Discrete terminal keys and explicit bytes, written into a task's live PTY.
//!
//! `POST /v1/tasks/{task_id}/input` carries a logical *message*: the daemon
//! keeps the text and its synthesized Enter atomic, may frame it as a bracketed
//! paste, and holds it behind a human's unsent draft. That is exactly right for
//! a sentence and useless for a menu. An agent CLI parked on a selection list
//! needs Down and then Enter as two discrete keystrokes, with no appended
//! newline, no paste framing, and no queueing — and on 2026-09-05 an imported
//! task sat at Claude's workspace-trust selection with no supported way to send
//! them. The manager read the daemon's session snapshot by hand, opened the
//! daemon's Unix socket directly, and sent `InputIfSession` carrying
//! `[27, 91, 66]` and then `[13]`. This route is that capability, made
//! supported and fenced the same way every other delivery is.
//!
//! What it deliberately is not:
//!
//! - **Not a logical message.** No Enter is appended, nothing is queued behind
//!   a draft, and nothing is framed as a paste. The bytes named are the bytes
//!   written.
//! - **Not owner speech.** No `task_input` row is written. That table is what a
//!   later stage reads as the instruction history, and terminal control bytes
//!   are not an instruction. The action is announced on the event feed as
//!   `task.raw_input_delivered` instead.
//! - **Not an unfenced write.** Discovery and delivery both hold the task's
//!   lifecycle lease, and every write is fenced to the PTY process ID observed
//!   during discovery, so a stage transition or rerun between the two is
//!   refused rather than typed into a replacement.
//! - **Not a permission bypass.** It moves menus. Nothing here decides whether
//!   a selection *should* be made, and an agent using it to accept a permission
//!   prompt it does not understand is making that mistake on its own authority.

use super::lan_trust::PrivilegedTaskAccess;
use super::state::AppState;
use crate::db::{Db, RawInputWriteRecord, TaskInputSource};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use kanna_daemon::protocol::{
    Command as DaemonCommand, Event as DaemonEvent, RawInputClass, SessionKind, SessionState,
};
use kanna_runtime_defaults::terminal_keys::{
    terminal_key, unknown_terminal_key_message, TerminalKeyClass,
};
use std::sync::Arc;

/// Most keys one call may carry.
///
/// A sequence is an ordered burst into somebody's live terminal, not a script:
/// each write waits for the daemon to acknowledge that every byte reached the
/// PTY before the next is sent, so a long list is a long time holding the
/// task's lifecycle lease. Sixteen covers every menu interaction the incident
/// and its neighbours need, and a caller with more to send makes another call —
/// which stays ordered, because this one has finished writing before it answers.
const MAX_KEYS_PER_CALL: usize = 16;

/// Most bytes one explicit-byte payload may carry.
///
/// A PTY master takes about a kilobyte per write, so anything larger stops
/// being one terminal event and becomes a stream — which is what the logical
/// message route is for.
const MAX_RAW_BYTES: usize = 1024;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawInputRequest {
    /// Named keys, written in order. Mutually exclusive with `bytes`.
    #[serde(default)]
    keys: Option<Vec<String>>,
    /// Explicit bytes, in `encoding`. Mutually exclusive with `keys`.
    #[serde(default)]
    bytes: Option<String>,
    /// How `bytes` is spelled: `hex` (default) or `base64`.
    #[serde(default)]
    encoding: Option<String>,
    /// Who is acting, declared by the caller: `operator` or `manager`.
    /// Recorded unverified beside the write the server can verify it made.
    #[serde(default)]
    source: Option<String>,
}

/// One write's outcome, reported per item so a partial burst says exactly
/// where it stopped.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RawInputWrite {
    index: usize,
    /// The named key, or null for explicit bytes.
    key: Option<String>,
    /// Lowercase hex of exactly the bytes this write carries.
    bytes: String,
    /// The producer-declared composer meaning: `draft` or `submission`.
    class: &'static str,
    /// `written`, `uncertain`, or `not_written`.
    status: &'static str,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RawInputResponse {
    /// `written` — every byte reached the PTY, in order.
    status: &'static str,
    task_id: String,
    /// The PTY process ID every write was fenced to.
    session_pid: u32,
    writes: Vec<RawInputWrite>,
}

/// A raw-input failure that also reports how far the burst got.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawInputFailure {
    ok: bool,
    reason: &'static str,
    message: String,
    /// Whether re-sending this identical call is a sensible next step, stated
    /// rather than implied: a `503` normally reads as "try again", but
    /// `delivery_uncertain` may already have put these keys in somebody's
    /// terminal, and a naive retry types them twice. Only `daemon_handing_off`
    /// is true — nothing was written and a successor daemon is coming. A
    /// rejected request, an absent session, or a daemon too old for the
    /// contract does not fix itself between two attempts either.
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_pid: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    writes: Vec<RawInputWrite>,
}

type RawInputHttpError = (axum::http::StatusCode, Json<RawInputFailure>);

fn raw_input_error(
    status: axum::http::StatusCode,
    reason: &'static str,
    message: String,
) -> RawInputHttpError {
    (
        status,
        Json(RawInputFailure {
            ok: false,
            reason,
            message,
            retryable: false,
            session_pid: None,
            writes: Vec::new(),
        }),
    )
}

fn raw_input_error_with_writes(
    status: axum::http::StatusCode,
    reason: &'static str,
    message: String,
    retryable: bool,
    session_pid: u32,
    writes: Vec<RawInputWrite>,
) -> RawInputHttpError {
    (
        status,
        Json(RawInputFailure {
            ok: false,
            reason,
            message,
            retryable,
            session_pid: Some(session_pid),
            writes,
        }),
    )
}

/// One planned write: what to send, what it declares, and how to name it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedWrite {
    key: Option<String>,
    data: Vec<u8>,
    class: RawInputClass,
}

fn hex_of(data: &[u8]) -> String {
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(raw: &str) -> Result<Vec<u8>, String> {
    if !raw.len().is_multiple_of(2) {
        return Err(format!(
            "bytes must be an even number of hex digits, got {} (example: \"1b5b42\" for Down)",
            raw.len()
        ));
    }
    (0..raw.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16).map_err(|_| {
                format!(
                    "bytes must be hex digits only; {:?} is not (example: \"1b5b42\" for Down)",
                    &raw[index..index + 2]
                )
            })
        })
        .collect()
}

fn decode_base64(raw: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|error| format!("bytes must be valid base64: {error}"))
}

/// Turn a validated request into the ordered writes it means.
///
/// Split out from the handler because this is the whole argument/encoding
/// contract, and the contract is worth testing without a daemon.
fn plan_writes(
    keys: Option<&[String]>,
    bytes: Option<&str>,
    encoding: Option<&str>,
) -> Result<Vec<PlannedWrite>, String> {
    match (keys, bytes) {
        (Some(_), Some(_)) => Err(
            "keys and bytes are mutually exclusive: pass named keys, or explicit bytes, not both"
                .to_string(),
        ),
        (None, None) => Err(
            "pass keys (for example [\"down\", \"enter\"]) or bytes (for example \"1b5b42\")"
                .to_string(),
        ),
        (Some(keys), None) => {
            if encoding.is_some() {
                return Err("encoding applies to bytes, not to keys".to_string());
            }
            if keys.is_empty() {
                return Err("keys must name at least one key".to_string());
            }
            if keys.len() > MAX_KEYS_PER_CALL {
                return Err(format!(
                    "keys carries {} entries; at most {MAX_KEYS_PER_CALL} may be sent in one \
                     call, and consecutive calls stay in order because each one answers only \
                     after its bytes reached the PTY",
                    keys.len()
                ));
            }
            keys.iter()
                .map(|name| {
                    let key =
                        terminal_key(name).ok_or_else(|| unknown_terminal_key_message(name))?;
                    Ok(PlannedWrite {
                        key: Some(key.name.to_string()),
                        data: key.bytes.to_vec(),
                        class: match key.class {
                            TerminalKeyClass::Draft => RawInputClass::Draft,
                            TerminalKeyClass::Submission => RawInputClass::Submission,
                        },
                    })
                })
                .collect()
        }
        (None, Some(bytes)) => {
            let encoding = encoding.unwrap_or("hex");
            let data = match encoding {
                "hex" => decode_hex(bytes)?,
                "base64" => decode_base64(bytes)?,
                other => {
                    return Err(format!(
                        "unknown encoding {other:?}; use \"hex\" (default) or \"base64\""
                    ))
                }
            };
            if data.is_empty() {
                return Err("bytes must carry at least one byte".to_string());
            }
            if data.len() > MAX_RAW_BYTES {
                return Err(format!(
                    "bytes decodes to {} bytes; at most {MAX_RAW_BYTES} may be sent in one call",
                    data.len()
                ));
            }
            // Submission is a producer's declaration, never something read out
            // of a byte stream — that is the rule the daemon's draft ledger is
            // built on. Explicit bytes declare nothing, so a CR here would be
            // written as draft content: the CLI would submit the composer while
            // the ledger recorded a line still being typed, and every later
            // delivered message would be held behind a draft that no longer
            // exists. The `enter` key carries the declaration; this does not.
            if data.contains(&b'\r') {
                return Err(
                    "bytes must not contain a carriage return (0x0d): explicit bytes declare no \
                     submission boundary, so a CR here would leave the daemon's draft \
                     bookkeeping describing a composer that was already submitted. Send Enter as \
                     keys: [\"enter\"], which declares it."
                        .to_string(),
                );
            }
            Ok(vec![PlannedWrite {
                key: None,
                data,
                class: RawInputClass::Draft,
            }])
        }
    }
}

fn pending_writes(planned: &[PlannedWrite]) -> Vec<RawInputWrite> {
    planned
        .iter()
        .enumerate()
        .map(|(index, write)| RawInputWrite {
            index,
            key: write.key.clone(),
            bytes: hex_of(&write.data),
            class: class_name(write.class),
            status: "not_written",
        })
        .collect()
}

fn class_name(class: RawInputClass) -> &'static str {
    match class {
        RawInputClass::Draft => "draft",
        RawInputClass::Submission => "submission",
        RawInputClass::Control => "control",
    }
}

/// Why one fenced raw write did not complete.
enum RawWriteError {
    /// The session named is gone or is a different incarnation. Nothing was
    /// written by *this* write.
    SessionChanged(String),
    /// This daemon has committed a handoff and no longer owns the session.
    /// Nothing was written, and unlike every other failure here the same call
    /// is worth making again once the successor is serving.
    HandingOff(String),
    /// The session only accepts kernel-authenticated operator input.
    OperatorInputOnly(String),
    /// The write may or may not have reached the PTY.
    Uncertain(String),
    Other(String),
}

async fn send_fenced_raw_write(
    daemon: &mut crate::daemon_client::DaemonClient,
    session_id: &str,
    expected_pid: u32,
    write: &PlannedWrite,
) -> Result<(), RawWriteError> {
    let command = DaemonCommand::RawInputIfSession {
        session_id: session_id.to_string(),
        expected_pid,
        data: write.data.clone(),
        class: write.class,
    };
    // The daemon answers a fenced raw write only once every byte has reached
    // the PTY, so this await is the ordering barrier: the next write is not
    // even serialized until this one is on the wire to the terminal.
    match daemon.send_command(&command).await {
        Ok(DaemonEvent::Ok) => Ok(()),
        Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
            message,
        })
        | Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::SessionIncarnationMismatch),
            message,
        }) => Err(RawWriteError::SessionChanged(message)),
        Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::InputUnauthorized),
            message,
        }) => Err(RawWriteError::OperatorInputOnly(message)),
        Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
            message,
        }) => Err(RawWriteError::HandingOff(message)),
        Ok(DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            message,
        }) => Err(RawWriteError::Uncertain(message)),
        Ok(DaemonEvent::Error { message, .. }) => Err(RawWriteError::Other(message)),
        Ok(other) => Err(RawWriteError::Other(format!(
            "unexpected daemon response: {other:?}"
        ))),
        // The request crossed the socket; the answer did not come back. The
        // bytes may already be at the terminal, so this is never retryable.
        Err(error) => Err(RawWriteError::Uncertain(format!(
            "daemon response lost: {error}"
        ))),
    }
}

pub(super) async fn send_task_raw_input(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(payload): Json<RawInputRequest>,
) -> Result<Response, RawInputHttpError> {
    let source = match payload.source.as_deref() {
        Some(declared) => TaskInputSource::from_caller_declared(declared).map_err(|message| {
            raw_input_error(
                axum::http::StatusCode::BAD_REQUEST,
                "invalid_input_source",
                message,
            )
        })?,
        None => TaskInputSource::Unspecified,
    };
    let planned = plan_writes(
        payload.keys.as_deref(),
        payload.bytes.as_deref(),
        payload.encoding.as_deref(),
    )
    .map_err(|message| {
        raw_input_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_raw_input",
            message,
        )
    })?;

    let task_id = super::task_actions::resolve_task_id_for_mutation(&state, &task_id)
        .await
        .map_err(|(status, message)| {
            let reason = if status == axum::http::StatusCode::NOT_FOUND {
                "task_not_found"
            } else {
                "task_input_unavailable"
            };
            raw_input_error(status, reason, message)
        })?;
    let Some(_task_mutation) = state.try_begin_requested_task_mutation(&task_id) else {
        return Err(raw_input_error(
            axum::http::StatusCode::CONFLICT,
            "no_live_agent_session",
            format!(
                "task {task_id} is changing stage or agent session; no key was written; inspect \
                 the current run before retrying"
            ),
        ));
    };

    let mut daemon = crate::daemon_client::DaemonClient::connect(&state.config.daemon_dir)
        .await
        .map_err(|error| {
            raw_input_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_unavailable",
                format!("could not reach the daemon for task {task_id}: {error}"),
            )
        })?;

    // Asked before anything is written, and answered by a command with no
    // session and no side effect, so a refusal here proves the terminal is
    // untouched. A daemon predating the contract cannot decode the command and
    // closes the connection instead of answering; both arrive as the same
    // honest "nothing was written".
    daemon.negotiate_raw_input().await.map_err(|error| {
        raw_input_error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "raw_input_unsupported",
            format!(
                "the running daemon does not support fenced raw terminal input, so no key was \
                 written for task {task_id}: {error}. Restart the Kanna desktop app to hand off \
                 to a current daemon."
            ),
        )
    })?;

    let sessions = match daemon.send_command(&DaemonCommand::List).await {
        Ok(DaemonEvent::SessionList { sessions }) => sessions,
        Ok(other) => {
            return Err(raw_input_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_state_unknown",
                format!(
                    "could not verify a live agent session for task {task_id}: unexpected daemon \
                     response: {other:?}"
                ),
            ));
        }
        Err(error) => {
            return Err(raw_input_error(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "daemon_state_unknown",
                format!("could not verify a live agent session for task {task_id}: {error}"),
            ));
        }
    };
    let Some(session_pid) = sessions
        .iter()
        .find(|session| {
            session.session_id == task_id
                && session.kind == SessionKind::Pty
                && matches!(&session.state, SessionState::Active)
        })
        .map(|session| session.pid)
    else {
        return Err(raw_input_error(
            axum::http::StatusCode::CONFLICT,
            "no_live_agent_session",
            format!(
                "no live agent session for task {task_id}; no key was written. Raw keys drive a \
                 terminal that exists — use kanna_resume_task or kanna_rerun_stage to start one."
            ),
        ));
    };

    let mut writes = pending_writes(&planned);
    let mut failure: Option<RawInputHttpError> = None;
    let mut retryable = false;
    for (index, write) in planned.iter().enumerate() {
        match send_fenced_raw_write(&mut daemon, &task_id, session_pid, write).await {
            Ok(()) => writes[index].status = "written",
            Err(error) => {
                let wrote_earlier = index > 0;
                let (status, reason, message) = match error {
                    // A first write refused for a changed incarnation is
                    // certain: nothing reached any terminal. A later one is
                    // not — earlier keys are already in the PTY of a session
                    // that has since been replaced, and no retry can undo them.
                    RawWriteError::SessionChanged(message) if !wrote_earlier => (
                        axum::http::StatusCode::CONFLICT,
                        "no_live_agent_session",
                        format!(
                            "the live agent session for task {task_id} changed before any key \
                             was written: {message}"
                        ),
                    ),
                    RawWriteError::SessionChanged(message) => (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "delivery_uncertain",
                        format!(
                            "the live agent session for task {task_id} changed part-way through \
                             the sequence: {message}. The keys already marked written reached the \
                             previous session; do not resend this call."
                        ),
                    ),
                    // The one failure here worth repeating verbatim, so it is
                    // the one place `retryable` is true. Nothing was written,
                    // and the next call re-negotiates and re-observes the pid
                    // against the successor rather than replaying a write into
                    // a daemon that no longer owns the terminal.
                    RawWriteError::HandingOff(message) if !wrote_earlier => {
                        retryable = true;
                        (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            "daemon_handing_off",
                            format!(
                                "the daemon is handing this session to a successor, so no key was \
                                 written for task {task_id}: {message}. Make the same call again."
                            ),
                        )
                    }
                    RawWriteError::HandingOff(message) => (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "delivery_uncertain",
                        format!(
                            "the daemon began handing off part-way through the sequence for task \
                             {task_id}: {message}. The keys already marked written reached the \
                             old daemon's PTY; do not resend this call."
                        ),
                    ),
                    RawWriteError::OperatorInputOnly(message) if !wrote_earlier => (
                        axum::http::StatusCode::FORBIDDEN,
                        "session_operator_input_only",
                        format!(
                            "task {task_id} runs a protected session that accepts only \
                             kernel-authenticated operator input: {message}"
                        ),
                    ),
                    RawWriteError::OperatorInputOnly(message) => (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "delivery_uncertain",
                        format!(
                            "task {task_id} began refusing input part-way through the sequence: \
                             {message}. Do not resend this call."
                        ),
                    ),
                    RawWriteError::Uncertain(message) => {
                        writes[index].status = "uncertain";
                        (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            "delivery_uncertain",
                            format!(
                                "raw terminal input for task {task_id} is uncertain: {message}. \
                                 Read the task's terminal before acting; resending would type \
                                 the keys twice."
                            ),
                        )
                    }
                    RawWriteError::Other(message) if !wrote_earlier => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "raw_input_failed",
                        message,
                    ),
                    RawWriteError::Other(message) => (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "delivery_uncertain",
                        format!(
                            "the sequence stopped part-way through for task {task_id}: {message}. \
                             Do not resend this call."
                        ),
                    ),
                };
                failure = Some(raw_input_error_with_writes(
                    status,
                    reason,
                    message,
                    retryable,
                    session_pid,
                    writes.clone(),
                ));
                break;
            }
        }
    }

    let status = match failure.as_ref() {
        None => "written",
        Some((_, Json(body))) => body.reason,
    };
    record_raw_input(&state, &task_id, source, session_pid, status, &writes).await;

    match failure {
        Some(error) => Err(error),
        None => Ok((
            axum::http::StatusCode::OK,
            Json(RawInputResponse {
                status: "written",
                task_id,
                session_pid,
                writes,
            }),
        )
            .into_response()),
    }
}

/// Announce what was written on the event feed.
///
/// Recorded for every outcome that touched the daemon, including the uncertain
/// ones: an audit trail that only holds the clean cases is exactly wrong about
/// the case somebody will later need to reconstruct.
async fn record_raw_input(
    state: &AppState,
    task_id: &str,
    source: TaskInputSource,
    session_pid: u32,
    status: &str,
    writes: &[RawInputWrite],
) {
    let db_path = state.config.db_path.clone();
    let logged_id = task_id.to_string();
    let task_id = task_id.to_string();
    let status = status.to_string();
    let records = writes
        .iter()
        .map(|write| RawInputWriteRecord {
            key: write.key.clone(),
            bytes_hex: write.bytes.clone(),
            class: write.class,
            status: write.status,
        })
        .collect::<Vec<_>>();
    let recorded = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let db = Db::open(&db_path).map_err(|error| format!("db error: {error}"))?;
        db.append_raw_input_event(&task_id, source.as_str(), session_pid, &status, &records)
            .map_err(|error| format!("db error: {error}"))
    })
    .await;
    match recorded {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            log::error!("raw terminal input for {logged_id} was not announced: {error}")
        }
        Err(error) => {
            log::error!("raw-input record worker failed for {logged_id}: {error}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn named_keys_plan_the_bytes_the_manager_sent_by_hand() {
        let planned = plan_writes(Some(&names(&["down", "enter"])), None, None).unwrap();
        assert_eq!(
            planned,
            vec![
                PlannedWrite {
                    key: Some("down".to_string()),
                    data: vec![27, 91, 66],
                    class: RawInputClass::Draft,
                },
                PlannedWrite {
                    key: Some("enter".to_string()),
                    data: vec![13],
                    class: RawInputClass::Submission,
                },
            ]
        );
    }

    #[test]
    fn escape_is_one_draft_write_with_no_newline() {
        let planned = plan_writes(Some(&names(&["escape"])), None, None).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].data, vec![0x1b]);
        assert_eq!(planned[0].class, RawInputClass::Draft);
    }

    #[test]
    fn explicit_hex_bytes_are_written_verbatim() {
        let planned = plan_writes(None, Some("1b5b42"), None).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].key, None);
        assert_eq!(planned[0].data, vec![0x1b, 0x5b, 0x42]);
        assert_eq!(planned[0].class, RawInputClass::Draft);
    }

    #[test]
    fn base64_bytes_decode() {
        let planned = plan_writes(None, Some("G1tC"), Some("base64")).unwrap();
        assert_eq!(planned[0].data, vec![0x1b, 0x5b, 0x42]);
    }

    #[test]
    fn explicit_bytes_may_not_carry_a_carriage_return() {
        let error = plan_writes(None, Some("0d"), None).unwrap_err();
        assert!(error.contains("keys: [\"enter\"]"), "{error}");
    }

    #[test]
    fn keys_and_bytes_are_mutually_exclusive() {
        let error = plan_writes(Some(&names(&["down"])), Some("1b"), None).unwrap_err();
        assert!(error.contains("mutually exclusive"), "{error}");
        let error = plan_writes(None, None, None).unwrap_err();
        assert!(error.contains("keys"), "{error}");
    }

    #[test]
    fn unknown_keys_name_the_accepted_vocabulary() {
        let error = plan_writes(Some(&names(&["arrow-down"])), None, None).unwrap_err();
        assert!(error.contains("accepted keys"), "{error}");
        let error = plan_writes(Some(&names(&["ctrl-m"])), None, None).unwrap_err();
        assert!(error.contains("\"enter\""), "{error}");
    }

    #[test]
    fn limits_are_enforced() {
        let many = names(&["down"; 17]);
        let error = plan_writes(Some(&many), None, None).unwrap_err();
        assert!(error.contains("at most 16"), "{error}");

        let long = "41".repeat(MAX_RAW_BYTES + 1);
        let error = plan_writes(None, Some(&long), None).unwrap_err();
        assert!(error.contains("at most 1024"), "{error}");

        let error = plan_writes(None, Some(""), None).unwrap_err();
        assert!(error.contains("at least one byte"), "{error}");

        let error = plan_writes(Some(&[]), None, None).unwrap_err();
        assert!(error.contains("at least one key"), "{error}");
    }

    #[test]
    fn malformed_encodings_are_rejected_before_any_write() {
        assert!(plan_writes(None, Some("1b5"), None)
            .unwrap_err()
            .contains("even number"));
        assert!(plan_writes(None, Some("zz"), None)
            .unwrap_err()
            .contains("hex digits"));
        assert!(plan_writes(None, Some("1b"), Some("rot13"))
            .unwrap_err()
            .contains("unknown encoding"));
        assert!(plan_writes(Some(&names(&["down"])), None, Some("hex"))
            .unwrap_err()
            .contains("encoding applies to bytes"));
    }

    #[test]
    fn pending_writes_start_unwritten_and_carry_exact_hex() {
        let planned = plan_writes(Some(&names(&["down", "enter"])), None, None).unwrap();
        let pending = pending_writes(&planned);
        assert_eq!(pending[0].bytes, "1b5b42");
        assert_eq!(pending[0].class, "draft");
        assert_eq!(pending[0].status, "not_written");
        assert_eq!(pending[1].bytes, "0d");
        assert_eq!(pending[1].class, "submission");
        assert_eq!(pending[1].index, 1);
    }
}
