use super::lan_trust::{DesktopLocalAccess, PrivilegedTaskAccess};
use super::state::AppState;
use crate::db::Db;
use crate::transfer_targets::{
    plan_route, resolve_transfer_target, transfer_targets, TransferTarget,
};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Discriminator clients match on to tell "this push is already in flight" from
/// any other write failure. Kept stable: `stores/transfer.ts` keys its
/// idempotent push path off this exact string.
pub(super) const ACTIVE_OUTGOING_TRANSFER_CONFLICT: &str = "active_outgoing_transfer_exists";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetCloudTaskIdentityRequest {
    cloud_task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingIncomingTransfersResponse {
    transfers: Vec<crate::db::PendingIncomingTransfer>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IncomingTransferCleanupCandidatesResponse {
    transfer_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferUpdateResponse {
    updated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FailTransferRequest {
    reason: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpsertTransferRequest {
    transfer: crate::db::NewTaskTransfer,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateTransferPayloadRequest {
    payload_json: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompleteTransferRequest {
    local_task_id: String,
    claim_owner_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaimIncomingTransferRequest {
    owner_token: String,
    #[serde(default)]
    recovery: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RejectTransferRequest {
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertTransferProvenanceRequest {
    provenance: crate::db::NewTaskTransferProvenance,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferResponse {
    transfer: Option<crate::db::TaskTransfer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PushTaskRequest {
    /// The destination, named the way an agent can actually name one: a
    /// canonical machine (desktop) id or a transfer peer id, resolved here
    /// through `transfer_targets` rather than by the caller.
    #[serde(default, alias = "machine")]
    target_machine: Option<String>,
    /// The desktop's own spelling, kept because the renderer already holds a
    /// resolved peer id and its three routing options. A request that carries
    /// only this still resolves centrally when it can, and falls back to the
    /// caller's values when the peer registry cannot be read.
    #[serde(default)]
    peer_id: Option<String>,
    /// Opt-in idempotency key, for a client that retries this request and does
    /// not want the retry to become a second push.
    ///
    /// Absent — which is every production caller — each request is its own
    /// intent. It has to be: `transfer_work.id` is a permanent primary key and
    /// no row is ever pruned, so keying on anything that repeats (the peer id,
    /// say) would make every push of a task to that peer after the first return
    /// `scheduled: false` and enqueue nothing, forever. Pushing the same task to
    /// the same machine again — after a failure the operator fixed, or simply
    /// later — is ordinary, and the engine's own eligibility read is what stops
    /// two live intents racing into one transfer.
    #[serde(default)]
    intent_key: Option<String>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    cloud_fallback: bool,
    #[serde(default)]
    target_desktop_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferIntentResponse {
    /// `false` when the same intent was already queued — a retried request,
    /// not a second transfer.
    scheduled: bool,
}

/// Where a transfer this call scheduled is going, as this machine resolved it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTransferPeer {
    peer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<String>,
    cloud_fallback: bool,
}

/// The one transfer a source task is allowed to have in flight, as reported to
/// a caller who just asked for another one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferSummary {
    id: String,
    direction: String,
    /// The raw `task_transfer.status`.
    status: String,
    /// The coarse verdict every agent surface reads: `pending`, `completed`,
    /// `failed`, or `rejected`.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_peer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A transfer's status vocabulary is the engine's; this is the four-way answer
/// every agent surface reports so a scheduled move is never read as a finished
/// one.
fn transfer_state(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "rejected" => "rejected",
        _ => "pending",
    }
}

impl From<crate::db::TaskTransfer> for TransferSummary {
    fn from(transfer: crate::db::TaskTransfer) -> Self {
        Self {
            state: transfer_state(&transfer.status),
            id: transfer.id,
            direction: transfer.direction,
            status: transfer.status,
            source_task_id: transfer.source_task_id,
            local_task_id: transfer.local_task_id,
            source_peer_id: transfer.source_peer_id,
            target_peer_id: transfer.target_peer_id,
            source_machine_id: transfer.source_desktop_id,
            target_machine_id: transfer.target_desktop_id,
            started_at: transfer.started_at,
            completed_at: transfer.completed_at,
            error: transfer.error,
        }
    }
}

/// The answer to "push this task", which is never "the task moved".
///
/// A push is an intent the engine executes over minutes: it bundles a
/// repository, ships a conversation, waits for the source agent to wrap up, and
/// only then closes the source task. Reporting the enqueue as the move is how a
/// scheduled transfer that later died on a relay socket got recorded as a
/// completed one, so `moved` is stated outright and `nextStep` names the
/// surface that answers the real question.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PushTaskResponse {
    /// `false` when this exact intent was already queued, or when the task
    /// already has a transfer in flight.
    scheduled: bool,
    /// `scheduled`, `already_queued`, or `already_in_flight`.
    state: &'static str,
    /// Always false: nothing has moved when this call returns.
    moved: bool,
    source_task_id: String,
    /// Work-queue id of the intent, stable across a retry that reuses
    /// `intentKey`. Absent when nothing was queued.
    #[serde(skip_serializing_if = "Option::is_none")]
    work_id: Option<String>,
    target: ResolvedTransferPeer,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_transfer: Option<TransferSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    next_step: &'static str,
}

/// The answer to "pull this task here".
///
/// A pull is one step further from done than a push: it asks the *other*
/// machine to schedule a push back, so this response records that the request
/// was accepted, never that anything crossed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PullTaskResponse {
    accepted: bool,
    /// `requested`, or `already_requested` when the source recognised this as a
    /// repeat of a request it is still holding.
    state: &'static str,
    moved: bool,
    /// The source machine's id for this request. It is stable for repeats of
    /// the same pull within `requestTtlSeconds`, so an unchanged id is how a
    /// caller tells a duplicate from a second move.
    request_id: String,
    request_ttl_seconds: u64,
    source_task_id: String,
    source: ResolvedTransferPeer,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    next_step: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferPeersResponse {
    current_machine_id: String,
    peers: Vec<TransferTarget>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskTransfersResponse {
    task_id: String,
    transfers: Vec<TransferSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PullTaskRequest {
    /// The task id as the *source* machine knows it.
    source_task_id: String,
    #[serde(default, alias = "machine", alias = "sourceMachineId")]
    source_machine: Option<String>,
    #[serde(default)]
    peer_id: Option<String>,
    #[serde(default)]
    transport: Option<String>,
}

/// The sidecar holds a pending pull request for five minutes and answers a
/// repeat of it with the same id (`task-transfer`'s `TASK_PULL_REQUEST_TTL`).
const TASK_PULL_REQUEST_TTL_SECONDS: u64 = 5 * 60;

const PUSH_NEXT_STEP: &str =
    "Nothing has moved yet. Read kanna_task_transfers for this task until its outgoing transfer \
     reports state completed or failed; the source task closes only when the move finishes.";

const PULL_NEXT_STEP: &str =
    "Nothing has moved yet. The source machine schedules the push; read kanna_task_transfers on \
     this machine for the incoming transfer, or kanna_get_task on the source task to see it close.";

/// Pull request ids this process has already handed out, keyed by the peer and
/// source task they were minted for.
///
/// Advisory only, and deliberately so: it exists to turn the sidecar's
/// "same id means same request" contract into a straight answer for the caller.
/// A server restart forgets it, in which case a genuine repeat is reported as
/// `requested` — the id itself, which the response always carries, remains the
/// authoritative comparison.
fn pull_request_memo() -> &'static Mutex<HashMap<(String, String), String>> {
    static MEMO: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Push a task to a paired machine.
///
/// The push itself is server work: the caller states the intent and the engine
/// performs the preflight, the git bundling, the artifact staging and the
/// commit. It cannot be undone by the window closing halfway through.
///
/// Two things happen before the intent is queued, and both exist because a
/// queued intent is invisible until it fails. The destination is resolved
/// centrally, so a caller names a machine rather than scraping a peer id; and
/// the route it resolves to is checked, so a transfer over a cloud credential
/// the renderer last refreshed an hour ago is refused here instead of dying
/// later on a relay socket.
pub(super) async fn push_task_to_peer(
    State(state): State<Arc<AppState>>,
    Path(source_task_id): Path<String>,
    Json(payload): Json<PushTaskRequest>,
) -> Result<Json<PushTaskResponse>, (axum::http::StatusCode, String)> {
    let selector = payload
        .target_machine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            payload
                .peer_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                "name a destination with targetMachine (a machine id or transfer peer id)"
                    .to_string(),
            )
        })?
        .to_string();

    let resolution = resolve_push_target(&state, &selector, &payload).await?;

    let db = open_db(&state)?;
    if let Some(active) = db
        .active_outgoing_transfer_for_source(&source_task_id)
        .map_err(db_error)?
    {
        // The engine's own eligibility read would skip this push anyway. Saying
        // so here, with the transfer that owns the task, is what stops a caller
        // reading a fresh `scheduled: true` as a second move.
        return Ok(Json(PushTaskResponse {
            scheduled: false,
            state: "already_in_flight",
            moved: false,
            source_task_id,
            work_id: None,
            target: resolution.peer,
            active_transfer: Some(active.into()),
            note: Some(
                "this task already has an outgoing transfer in flight; no second push was queued"
                    .to_string(),
            ),
            next_step: PUSH_NEXT_STEP,
        }));
    }
    drop(db);

    let intent_key = payload
        .intent_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .unwrap_or_else(crate::transfer_engine::queue::unique_work_nonce);
    let work_id = format!("push:{source_task_id}:{intent_key}");
    let scheduled = state
        .transfer_work()
        .enqueue(
            &work_id,
            crate::transfer_engine::queue::KIND_PUSH,
            None,
            &serde_json::json!({
                "sourceTaskId": source_task_id,
                "peerId": resolution.peer.peer_id,
                "transport": resolution.peer.transport,
                "cloudFallback": resolution.peer.cloud_fallback,
                "targetDesktopId": resolution.peer.machine_id,
            }),
        )
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(PushTaskResponse {
        scheduled,
        state: if scheduled {
            "scheduled"
        } else {
            "already_queued"
        },
        moved: false,
        source_task_id,
        work_id: Some(work_id),
        target: resolution.peer,
        active_transfer: None,
        note: resolution.note,
        next_step: PUSH_NEXT_STEP,
    }))
}

struct ResolvedPush {
    peer: ResolvedTransferPeer,
    note: Option<String>,
}

/// Resolve the destination and its route, preferring this server's own peer
/// registry and falling back to whatever the caller supplied.
///
/// The fallback exists for the desktop, which resolved a peer in the renderer
/// and passes it with the routing it chose; an unreadable peer registry here
/// must not refuse a push the renderer already knows is valid. It is
/// deliberately narrow: it covers only *not being able to resolve* the
/// destination. A destination this machine did resolve and found unusable —
/// the stale cloud credential — is refused, whichever spelling named it, because
/// falling back there would reinstate the exact silent failure this check
/// exists to end.
async fn resolve_push_target(
    state: &Arc<AppState>,
    selector: &str,
    payload: &PushTaskRequest,
) -> Result<ResolvedPush, (axum::http::StatusCode, String)> {
    let explicit_peer = payload
        .peer_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let targets = match list_targets(state).await {
        Ok(targets) => targets,
        Err(error) => return caller_supplied_push(selector, payload, explicit_peer, error),
    };
    let target = match resolve_transfer_target(&targets, selector) {
        Ok(target) => target.clone(),
        Err(reason) => {
            return caller_supplied_push(
                selector,
                payload,
                explicit_peer,
                (axum::http::StatusCode::NOT_FOUND, reason),
            )
        }
    };
    // Past this point the destination is this machine's own answer, so its
    // verdict on the route stands for every caller.
    let plan = plan_route(&target, payload.transport.as_deref())
        .map_err(|error| (axum::http::StatusCode::CONFLICT, error))?;
    Ok(ResolvedPush {
        peer: ResolvedTransferPeer {
            peer_id: target.peer_id,
            machine_id: payload.target_desktop_id.clone().or(plan.target_machine_id),
            name: Some(target.name),
            transport: Some(plan.transport),
            cloud_fallback: payload.cloud_fallback || plan.cloud_fallback,
        },
        note: plan.note,
    })
}

/// Fall back to the peer and routing the caller resolved for itself, or report
/// why this machine could not resolve one.
fn caller_supplied_push(
    selector: &str,
    payload: &PushTaskRequest,
    explicit_peer: Option<&str>,
    error: (axum::http::StatusCode, String),
) -> Result<ResolvedPush, (axum::http::StatusCode, String)> {
    // A caller that named only a machine has nothing else to push at.
    if explicit_peer.is_none() {
        return Err(error);
    }
    let (_, reason) = error;
    log::warn!("pushing to caller-supplied peer {selector}: {reason}");
    Ok(ResolvedPush {
        peer: ResolvedTransferPeer {
            peer_id: selector.to_string(),
            machine_id: payload.target_desktop_id.clone(),
            name: None,
            transport: payload.transport.clone(),
            cloud_fallback: payload.cloud_fallback,
        },
        note: Some(format!(
            "this machine could not resolve the destination itself ({reason}); the caller's own \
             peer id and routing were used"
        )),
    })
}

async fn list_targets(
    state: &Arc<AppState>,
) -> Result<Vec<TransferTarget>, (axum::http::StatusCode, String)> {
    let peers = state
        .transfer_sidecar()
        .control("list-peers", serde_json::Value::Null)
        .await
        .map_err(|error| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!("failed to read the transfer peer registry: {error}"),
            )
        })?;
    let peers = peers.as_array().cloned().ok_or_else(|| {
        (
            axum::http::StatusCode::BAD_GATEWAY,
            "the transfer peer registry returned an unexpected payload".to_string(),
        )
    })?;
    let cloud_routes =
        crate::cloud_transfer_proxy::cloud_transfer_routes(state.cloud_transfer_proxies()).await;
    Ok(transfer_targets(&peers, &cloud_routes))
}

/// List every machine this one can move a task to or from.
///
/// Read-only and privileged rather than desktop-local, so an agent can ask a
/// sibling machine what *it* can reach before pushing a task from there. It
/// deliberately reports no public keys and no endpoints: a destination is
/// named by machine id or peer id, and the credentials behind either stay in
/// the server.
pub(super) async fn list_transfer_peers(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
) -> Result<Json<TransferPeersResponse>, (axum::http::StatusCode, String)> {
    let peers = list_targets(&state).await?;
    Ok(Json(TransferPeersResponse {
        current_machine_id: state.config().desktop_id.clone(),
        peers,
    }))
}

/// Ask another machine to send one of its tasks here.
///
/// Desktop-local, like the rest of the sidecar control plane: a pull moves a
/// task onto *this* machine, so it is only ever expressed by a process running
/// on it. Pushing from a sibling is the routable direction.
pub(super) async fn pull_task_from_peer(
    _access: DesktopLocalAccess,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PullTaskRequest>,
) -> Result<Json<PullTaskResponse>, (axum::http::StatusCode, String)> {
    let source_task_id = payload.source_task_id.trim().to_string();
    if source_task_id.is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "sourceTaskId must not be empty".to_string(),
        ));
    }
    let selector = payload
        .source_machine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            payload
                .peer_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                "name the source with sourceMachine (a machine id or transfer peer id)".to_string(),
            )
        })?
        .to_string();

    let targets = list_targets(&state).await?;
    let target = resolve_transfer_target(&targets, &selector)
        .map_err(|error| (axum::http::StatusCode::NOT_FOUND, error))?
        .clone();
    let plan = plan_route(&target, payload.transport.as_deref())
        .map_err(|error| (axum::http::StatusCode::CONFLICT, error))?;
    let response = state
        .transfer_sidecar()
        .control(
            "request-task-pull",
            serde_json::json!({
                "targetPeerId": target.peer_id,
                "sourceTaskId": source_task_id,
                "transport": plan.transport,
            }),
        )
        .await
        .map_err(|error| (axum::http::StatusCode::BAD_GATEWAY, error))?;
    let request_id = response
        .get("requestId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                "the transfer sidecar accepted the pull without a request id".to_string(),
            )
        })?
        .to_string();
    let repeated = remember_pull_request(&target.peer_id, &source_task_id, &request_id);

    Ok(Json(PullTaskResponse {
        accepted: true,
        state: if repeated {
            "already_requested"
        } else {
            "requested"
        },
        moved: false,
        request_id,
        request_ttl_seconds: TASK_PULL_REQUEST_TTL_SECONDS,
        source_task_id,
        source: ResolvedTransferPeer {
            peer_id: target.peer_id,
            machine_id: plan.target_machine_id,
            name: Some(target.name),
            transport: Some(plan.transport),
            cloud_fallback: plan.cloud_fallback,
        },
        note: plan.note,
        next_step: PULL_NEXT_STEP,
    }))
}

/// True when this process handed out the same request id for this pull before.
fn remember_pull_request(peer_id: &str, source_task_id: &str, request_id: &str) -> bool {
    let key = (peer_id.to_string(), source_task_id.to_string());
    let mut memo = pull_request_memo()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    memo.insert(key, request_id.to_string())
        .is_some_and(|previous| previous == request_id)
}

/// Every transfer a task has taken part in, on this machine.
///
/// This is the surface that answers whether a scheduled move actually
/// happened, so it reports the engine's own status alongside the coarse
/// `pending` / `completed` / `failed` / `rejected` verdict.
pub(super) async fn list_task_transfers(
    _access: PrivilegedTaskAccess,
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskTransfersResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfers = db
        .list_task_transfers(&task_id)
        .map_err(db_error)?
        .into_iter()
        .map(TransferSummary::from)
        .collect();
    Ok(Json(TaskTransfersResponse { task_id, transfers }))
}

/// Approve or reject an incoming transfer.
///
/// Both are intents rather than work the caller performs, so the desktop and
/// (in principle) mobile express them the same way and the engine executes.
/// Progress reaches the UI through the snapshot's `transfer_status`.
pub(super) async fn approve_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    schedule_incoming_intent(
        &state,
        &transfer_id,
        "import",
        crate::transfer_engine::queue::KIND_IMPORT,
    )
}

pub(super) async fn reject_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    schedule_incoming_intent(
        &state,
        &transfer_id,
        "reject",
        crate::transfer_engine::queue::KIND_REJECT,
    )
}

fn schedule_incoming_intent(
    state: &Arc<AppState>,
    transfer_id: &str,
    prefix: &str,
    kind: &str,
) -> Result<Json<TransferIntentResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(state)?;
    let transfer = db
        .get_task_transfer(transfer_id)
        .map_err(db_error)?
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                format!("incoming transfer not found: {transfer_id}"),
            )
        })?;
    if transfer.direction != "incoming" {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("transfer is not incoming: {transfer_id}"),
        ));
    }
    let scheduled = state
        .transfer_work()
        .enqueue(
            &format!("{prefix}:{transfer_id}"),
            kind,
            Some(transfer_id),
            &serde_json::json!({ "transferId": transfer_id }),
        )
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(TransferIntentResponse { scheduled }))
}

pub(super) async fn list_pending_incoming_transfers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PendingIncomingTransfersResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfers = db.list_pending_incoming_transfers().map_err(db_error)?;
    Ok(Json(PendingIncomingTransfersResponse { transfers }))
}

pub(super) async fn list_incoming_transfer_cleanup_candidates(
    State(state): State<Arc<AppState>>,
) -> Result<Json<IncomingTransferCleanupCandidatesResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer_ids = db.list_terminal_incoming_transfer_ids().map_err(db_error)?;
    Ok(Json(IncomingTransferCleanupCandidatesResponse {
        transfer_ids,
    }))
}

pub(super) async fn mark_incoming_transfer_sidecar_cleanup_completed(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_sidecar_cleanup_completed(&transfer_id)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

/// A duplicate outgoing push is a race, not a server fault.
///
/// Two `task-pull-requested` deliveries for the same source task both passed a
/// stale renderer-snapshot eligibility check on 2026-08-06; the loser's insert
/// tripped `idx_task_transfer_active_outgoing_source` and surfaced as a raw
/// 500, leaving the caller no way to tell "already in flight" from "the write
/// broke". 409 with this body is that distinction, and it is what lets the
/// caller release the sidecar reservation its preflight had already made.
pub(super) async fn insert_task_transfer(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertTransferRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    let db = open_db(&state).map_err(json_error)?;
    match db.insert_task_transfer(&payload.transfer) {
        Ok(()) => Ok(Json(serde_json::json!({ "id": payload.transfer.id }))),
        Err(error) if crate::db::is_active_outgoing_transfer_conflict(&error) => {
            let source_task_id = payload.transfer.source_task_id.clone();
            let existing = source_task_id
                .as_deref()
                .and_then(|task_id| db.active_outgoing_transfer_for_source(task_id).ok())
                .flatten();
            Err((
                axum::http::StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": ACTIVE_OUTGOING_TRANSFER_CONFLICT,
                    "sourceTaskId": source_task_id,
                    "transferId": existing.map(|transfer| transfer.id),
                })),
            ))
        }
        Err(error) => Err(json_error(db_error(error))),
    }
}

pub(super) async fn get_active_outgoing_transfer(
    State(state): State<Arc<AppState>>,
    Path(source_task_id): Path<String>,
) -> Result<Json<TransferResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer = db
        .active_outgoing_transfer_for_source(&source_task_id)
        .map_err(db_error)?;
    Ok(Json(TransferResponse { transfer }))
}

pub(super) async fn get_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
) -> Result<Json<TransferResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let transfer = db.get_task_transfer(&transfer_id).map_err(db_error)?;
    Ok(Json(TransferResponse { transfer }))
}

pub(super) async fn update_task_transfer_payload(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<UpdateTransferPayloadRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .update_task_transfer_payload(
            &transfer_id,
            &payload.payload_json,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn complete_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_task_transfer_completed(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn mark_incoming_transfer_importing(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_importing(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref().unwrap_or_default(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn mark_incoming_transfer_awaiting_acknowledgment(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<CompleteTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_incoming_transfer_awaiting_acknowledgment(
            &transfer_id,
            &payload.local_task_id,
            payload.claim_owner_token.as_deref().unwrap_or_default(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn reject_task_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<RejectTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .mark_task_transfer_rejected(&transfer_id, &payload.reason)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn insert_task_transfer_provenance(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InsertTransferProvenanceRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    db.insert_task_transfer_provenance(&payload.provenance)
        .map_err(db_error)?;
    Ok(Json(serde_json::json!({
        "workflowItemId": payload.provenance.pipeline_item_id,
        "pipelineItemId": payload.provenance.pipeline_item_id,
    })))
}

pub(super) async fn claim_pending_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<ClaimIncomingTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    if payload.owner_token.trim().is_empty() {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "ownerToken must not be empty".to_string(),
        ));
    }
    let db = open_db(&state)?;
    let updated = db
        .claim_pending_incoming_transfer(&transfer_id, &payload.owner_token, payload.recovery)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn renew_incoming_transfer_claim(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<ClaimIncomingTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .renew_incoming_transfer_claim(&transfer_id, &payload.owner_token)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn fail_pending_incoming_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<FailTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .fail_pending_incoming_transfer(
            &transfer_id,
            &payload.reason,
            payload.claim_owner_token.as_deref(),
        )
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn fail_outgoing_transfer(
    State(state): State<Arc<AppState>>,
    Path(transfer_id): Path<String>,
    Json(payload): Json<FailTransferRequest>,
) -> Result<Json<TransferUpdateResponse>, (axum::http::StatusCode, String)> {
    let db = open_db(&state)?;
    let updated = db
        .fail_outgoing_task_transfer(&transfer_id, &payload.reason)
        .map_err(db_error)?;
    Ok(Json(TransferUpdateResponse { updated }))
}

pub(super) async fn set_task_cloud_identity(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
    Json(payload): Json<SetCloudTaskIdentityRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    if payload.cloud_task_id.trim().is_empty()
        || payload.cloud_task_id.chars().any(char::is_control)
    {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            "cloudTaskId must be non-blank and contain no control characters".to_string(),
        ));
    }

    let cloud_task_id = payload.cloud_task_id;
    let db_path = state.config.db_path.clone();
    let task_id_for_write = task_id.clone();
    let write = super::blocking::run_handler_blocking("cloud task identity write", move || {
        let db = Db::open(&db_path).map_err(db_error)?;
        db.set_cloud_task_identity(&task_id_for_write, &cloud_task_id)
            .map_err(db_error)
            .map(|write| (write, cloud_task_id))
    })
    .await?;
    match write {
        (crate::db::CloudTaskIdentityWrite::Updated, cloud_task_id)
        | (crate::db::CloudTaskIdentityWrite::Unchanged, cloud_task_id) => {
            Ok(Json(serde_json::json!({ "cloudTaskId": cloud_task_id })))
        }
        (crate::db::CloudTaskIdentityWrite::Conflict, _) => Err((
            axum::http::StatusCode::CONFLICT,
            "cloud task identity conflicts with existing ownership".to_string(),
        )),
        (crate::db::CloudTaskIdentityWrite::TaskNotFound, _) => Err((
            axum::http::StatusCode::NOT_FOUND,
            format!("task not found: {task_id}"),
        )),
    }
}

fn open_db(state: &AppState) -> Result<Db, (axum::http::StatusCode, String)> {
    Db::open(&state.config.db_path).map_err(|e| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("db error: {}", e),
        )
    })
}

fn db_error(error: rusqlite::Error) -> (axum::http::StatusCode, String) {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        format!("db error: {error}"),
    )
}

fn json_error(
    (status, message): (axum::http::StatusCode, String),
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": message })))
}
