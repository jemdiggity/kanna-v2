use super::daemon::requester_peer_public_key;
use super::events::{RuntimeError, RuntimeEvent};
use super::state::{
    ListenerContext, OwnerCompanionObserver, RuntimeEventSender, MAX_COMPANION_OBSERVERS,
};
use super::utils::{parse_peer_response_line, read_bounded_line, write_json_line};
use crate::crypto::{open_typed, seal_typed, TransferIdentity};
use crate::protocol::{PeerCompanionEvent, PeerRegistryEntry, PeerRequest, PeerResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kanna_agent_protocol::{CompanionEvent, ServerFrame};
use kanna_visual_companion::{
    append_event_with_workspace_resolver, CompanionBundle, CompanionError, CompanionScan,
    CompanionScanner, MAX_COMPANION_ASSET_COUNT, MAX_COMPANION_ASSET_TOTAL_BYTES,
    MAX_COMPANION_DIRECTORY_NAME_BYTES, MAX_COMPANION_HTML_BYTES,
};
use rand_core::{OsRng, RngCore};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch, Mutex, OwnedSemaphorePermit, Semaphore};

const COMPANION_POLL_INTERVAL: Duration = Duration::from_millis(500);
const COMPANION_PROOF_TTL: Duration = Duration::from_secs(60);
const MAX_COMPANION_PROOF_NONCES: usize = 4096;
const MAX_COMPANION_PROOF_IDENTIFIER_BYTES: usize = 256;
const COMPANION_EVENT_WINDOW: Duration = Duration::from_secs(10);
const MAX_COMPANION_EVENTS_PER_WINDOW: usize = 30;
const MAX_COMPANION_RATE_LIMIT_SESSIONS: usize = 64;
const MAX_OWNER_COMPANION_RETENTION_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAX_COMPANION_CONTROL_LINE_BYTES: usize = 64 * 1024;
const AEAD_TAG_BYTES: usize = 16;
const MAX_COMPANION_METADATA_JSON_BYTES: usize = MAX_COMPANION_ASSET_COUNT * 4 * 1024 + 1024 * 1024;
const MAX_COMPANION_PLAINTEXT_JSON_BYTES: usize = MAX_COMPANION_HTML_BYTES as usize * 6
    + base64_encoded_len(MAX_COMPANION_ASSET_TOTAL_BYTES as usize)
    + MAX_COMPANION_DIRECTORY_NAME_BYTES * 6
    + MAX_COMPANION_METADATA_JSON_BYTES;
// The frame JSON nests a sealed JSON envelope. This bound covers worst-case
// JSON escaping for the 1 MiB HTML and all asset names, base64 expansion of
// 16 MiB raw assets, metadata for all 32 assets, the AEAD tag, ciphertext
// base64, and 64 KiB for the envelope plus outer protocol wrapper.
pub(super) const MAX_COMPANION_FRAME_LINE_BYTES: usize =
    base64_encoded_len(MAX_COMPANION_PLAINTEXT_JSON_BYTES + AEAD_TAG_BYTES) + 64 * 1024;
pub(super) const MAX_CONCURRENT_COMPANION_INBOUND_DECODES: usize = 2;
pub(super) const MAX_COMPANION_INBOUND_DECODE_BYTES: usize =
    MAX_COMPANION_FRAME_LINE_BYTES * MAX_CONCURRENT_COMPANION_INBOUND_DECODES;

#[derive(Debug)]
pub(super) struct CompanionInboundByteBudget {
    max_bytes: usize,
    retained_bytes: AtomicUsize,
}

impl CompanionInboundByteBudget {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(1),
            retained_bytes: AtomicUsize::new(0),
        }
    }

    fn try_reserve(self: &Arc<Self>, bytes: usize) -> Option<CompanionInboundBytePermit> {
        self.try_add(bytes).then(|| CompanionInboundBytePermit {
            budget: Arc::clone(self),
            bytes,
        })
    }

    fn try_add(&self, bytes: usize) -> bool {
        self.retained_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |retained| {
                retained
                    .checked_add(bytes)
                    .filter(|next| *next <= self.max_bytes)
            })
            .is_ok()
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        self.retained_bytes.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
struct CompanionInboundBytePermit {
    budget: Arc<CompanionInboundByteBudget>,
    bytes: usize,
}

impl CompanionInboundBytePermit {
    fn try_extend(&mut self, bytes: usize) -> bool {
        if !self.budget.try_add(bytes) {
            return false;
        }
        self.bytes += bytes;
        true
    }

    fn release(&mut self, bytes: usize) {
        debug_assert!(bytes <= self.bytes);
        self.bytes -= bytes;
        self.budget
            .retained_bytes
            .fetch_sub(bytes, Ordering::AcqRel);
    }
}

impl Drop for CompanionInboundBytePermit {
    fn drop(&mut self) {
        self.budget
            .retained_bytes
            .fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

const fn base64_encoded_len(bytes: usize) -> usize {
    bytes.saturating_add(2) / 3 * 4
}

#[derive(Default)]
pub(super) struct CompanionEventRateLimiter {
    recent_by_session: HashMap<String, VecDeque<Instant>>,
}

impl CompanionEventRateLimiter {
    fn is_limited_at(&mut self, session_id: &str, now: Instant) -> bool {
        self.prune_at(now);
        self.recent_by_session.get(session_id).map_or(
            self.recent_by_session.len() >= MAX_COMPANION_RATE_LIMIT_SESSIONS,
            |recent| recent.len() >= MAX_COMPANION_EVENTS_PER_WINDOW,
        )
    }

    fn record_accepted_at(&mut self, session_id: &str, now: Instant) {
        self.prune_at(now);
        debug_assert!(
            self.recent_by_session.contains_key(session_id)
                || self.recent_by_session.len() < MAX_COMPANION_RATE_LIMIT_SESSIONS
        );
        self.recent_by_session
            .entry(session_id.to_owned())
            .or_default()
            .push_back(now);
    }

    fn prune_at(&mut self, now: Instant) {
        self.recent_by_session.retain(|_, recent| {
            while recent.front().is_some_and(|timestamp| {
                now.saturating_duration_since(*timestamp) >= COMPANION_EVENT_WINDOW
            }) {
                recent.pop_front();
            }
            !recent.is_empty()
        });
    }
}

struct ActiveOwnerCompanion(Arc<AtomicUsize>);

impl ActiveOwnerCompanion {
    fn new(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self(count)
    }
}

struct OwnerCompanionRetention {
    total: Arc<AtomicUsize>,
    retained: usize,
}

pub(super) struct OwnerCompanionSource {
    sender: watch::Sender<Option<Arc<ServerFrame>>>,
    cancel: watch::Sender<bool>,
}

impl OwnerCompanionRetention {
    fn new(total: Arc<AtomicUsize>) -> Self {
        Self { total, retained: 0 }
    }

    fn replace(&mut self, bytes: usize) -> bool {
        let mut current = self.total.load(Ordering::Acquire);
        loop {
            let next = current.saturating_sub(self.retained).saturating_add(bytes);
            if next > MAX_OWNER_COMPANION_RETENTION_BYTES {
                return false;
            }
            match self.total.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.retained = bytes;
                    return true;
                }
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for OwnerCompanionRetention {
    fn drop(&mut self) {
        self.total.fetch_sub(self.retained, Ordering::AcqRel);
    }
}

impl Drop for ActiveOwnerCompanion {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct OwnerScanState {
    scanner: CompanionScanner,
    workspace: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CompanionProof {
    operation: String,
    request_id: String,
    requester_peer_id: String,
    task_id: String,
    generation: Option<String>,
    session_id: Option<String>,
    revision: Option<String>,
    event: Option<CompanionEvent>,
    stream_nonce: String,
    observation_challenge: Option<String>,
    sequence: u64,
    nonce: String,
    issued_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct CompanionOwnerPayload {
    operation: String,
    request_id: String,
    task_id: String,
    generation: String,
    stream_nonce: String,
    observation_challenge: String,
    sequence: u64,
    frame: Option<ServerFrame>,
}

#[derive(Serialize)]
struct CompanionOwnerFramePayload<'a> {
    operation: &'static str,
    request_id: &'a str,
    task_id: &'a str,
    generation: &'a str,
    stream_nonce: &'a str,
    observation_challenge: &'a str,
    sequence: u64,
    frame: &'a ServerFrame,
}

fn seal_owner_payload(
    identity: &TransferIdentity,
    viewer_public: &x25519_dalek::PublicKey,
    payload: CompanionOwnerPayload,
) -> Result<String, RuntimeError> {
    Ok(seal_typed(identity, viewer_public, &payload)?)
}

// Keep each authenticated frame binding explicit beside its serialized payload field.
#[allow(clippy::too_many_arguments)]
fn seal_owner_frame_payload(
    identity: &TransferIdentity,
    viewer_public: &x25519_dalek::PublicKey,
    request_id: &str,
    task_id: &str,
    generation: &str,
    stream_nonce: &str,
    observation_challenge: &str,
    sequence: u64,
    frame: &ServerFrame,
) -> Result<String, RuntimeError> {
    Ok(seal_typed(
        identity,
        viewer_public,
        &CompanionOwnerFramePayload {
            operation: "companion_frame",
            request_id,
            task_id,
            generation,
            stream_nonce,
            observation_challenge,
            sequence,
            frame,
        },
    )?)
}

fn open_owner_payload(
    identity: &TransferIdentity,
    owner_public: &x25519_dalek::PublicKey,
    sealed: &str,
) -> Result<CompanionOwnerPayload, RuntimeError> {
    open_typed(identity, owner_public, sealed).map_err(|error| {
        RuntimeError::Protocol(format!("invalid owner companion payload: {error}"))
    })
}

// Each expected binding is independent of the untrusted payload being checked.
#[allow(clippy::too_many_arguments)]
fn validate_owner_payload(
    payload: CompanionOwnerPayload,
    operation: &str,
    request_id: &str,
    task_id: &str,
    generation: &str,
    stream_nonce: &str,
    expected_observation_challenge: Option<&str>,
    sequence: u64,
) -> Result<(String, Option<ServerFrame>), RuntimeError> {
    if payload.operation != operation
        || payload.request_id != request_id
        || payload.task_id != task_id
        || payload.generation != generation
        || payload.stream_nonce != stream_nonce
        || expected_observation_challenge
            .is_some_and(|expected| payload.observation_challenge != expected)
        || payload.sequence != sequence
    {
        return Err(RuntimeError::Protocol(
            "companion payload sequence or binding is invalid".into(),
        ));
    }
    validate_observation_challenge(&payload.observation_challenge)?;
    Ok((payload.observation_challenge, payload.frame))
}

// Keep each authenticated control binding explicit beside its serialized payload field.
#[allow(clippy::too_many_arguments)]
pub(super) async fn seal_owner_control_payload(
    context: &ListenerContext,
    requester_peer_id: &str,
    operation: &str,
    request_id: &str,
    task_id: &str,
    generation: &str,
    stream_nonce: &str,
    observation_challenge: &str,
    sequence: u64,
    frame: Option<ServerFrame>,
) -> Result<String, RuntimeError> {
    let viewer_public = requester_peer_public_key(context, requester_peer_id).await?;
    let identity =
        super::utils::load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
    seal_owner_payload(
        &identity,
        &viewer_public,
        CompanionOwnerPayload {
            operation: operation.into(),
            request_id: request_id.into(),
            task_id: task_id.into(),
            generation: generation.into(),
            stream_nonce: stream_nonce.into(),
            observation_challenge: observation_challenge.into(),
            sequence,
            frame,
        },
    )
}

type OwnerControlPayloadFields = (
    String,
    String,
    String,
    String,
    String,
    String,
    u64,
    Option<ServerFrame>,
);

pub(super) fn open_owner_control_payload(
    identity: &TransferIdentity,
    owner_public: &x25519_dalek::PublicKey,
    sealed_payload: &str,
) -> Result<OwnerControlPayloadFields, RuntimeError> {
    let payload = open_owner_payload(identity, owner_public, sealed_payload)?;
    Ok((
        payload.operation,
        payload.request_id,
        payload.task_id,
        payload.generation,
        payload.stream_nonce,
        payload.observation_challenge,
        payload.sequence,
        payload.frame,
    ))
}

pub(super) fn seal_observe_companion_proof(
    identity: &TransferIdentity,
    receiver_public: &x25519_dalek::PublicKey,
    request_id: &str,
    requester_peer_id: &str,
    task_id: &str,
    generation: &str,
) -> Result<(String, String), RuntimeError> {
    let stream_nonce = fresh_nonce();
    let sealed = seal_companion_proof(
        identity,
        receiver_public,
        CompanionProof {
            operation: "observe_companion".into(),
            request_id: request_id.into(),
            requester_peer_id: requester_peer_id.into(),
            task_id: task_id.into(),
            generation: Some(generation.into()),
            session_id: None,
            revision: None,
            event: None,
            stream_nonce: stream_nonce.clone(),
            observation_challenge: None,
            sequence: 0,
            nonce: fresh_nonce(),
            issued_at_ms: now_ms()?,
        },
    )?;
    Ok((sealed, stream_nonce))
}

// Keep event identity and observation bindings explicit beside the proof fields.
#[allow(clippy::too_many_arguments)]
pub(super) fn seal_send_companion_event_proof(
    identity: &TransferIdentity,
    receiver_public: &x25519_dalek::PublicKey,
    request_id: &str,
    requester_peer_id: &str,
    task_id: &str,
    session_id: &str,
    revision: &str,
    generation: &str,
    stream_nonce: &str,
    observation_challenge: &str,
    sequence: u64,
    event: &CompanionEvent,
) -> Result<String, RuntimeError> {
    seal_companion_proof(
        identity,
        receiver_public,
        CompanionProof {
            operation: "send_companion_event".into(),
            request_id: request_id.into(),
            requester_peer_id: requester_peer_id.into(),
            task_id: task_id.into(),
            generation: Some(generation.into()),
            session_id: Some(session_id.into()),
            revision: Some(revision.into()),
            event: Some(event.clone()),
            stream_nonce: stream_nonce.into(),
            observation_challenge: Some(observation_challenge.into()),
            sequence,
            nonce: fresh_nonce(),
            issued_at_ms: now_ms()?,
        },
    )
}

fn seal_companion_proof(
    identity: &TransferIdentity,
    receiver_public: &x25519_dalek::PublicKey,
    proof: CompanionProof,
) -> Result<String, RuntimeError> {
    Ok(seal_typed(identity, receiver_public, &proof)?)
}

pub(super) async fn verify_observe_companion_proof(
    context: &ListenerContext,
    request_id: &str,
    requester_peer_id: &str,
    sealed_proof: &str,
) -> Result<(String, String, String), RuntimeError> {
    validate_proof_identifier(request_id, "request")?;
    validate_proof_identifier(requester_peer_id, "requester peer")?;
    let proof = open_companion_proof(context, requester_peer_id, sealed_proof).await?;
    validate_proof_identifier(&proof.request_id, "request")?;
    validate_proof_identifier(&proof.requester_peer_id, "requester peer")?;
    if proof.operation != "observe_companion"
        || proof.request_id != request_id
        || proof.requester_peer_id != requester_peer_id
        || proof.session_id.is_some()
        || proof.revision.is_some()
        || proof.event.is_some()
        || proof.observation_challenge.is_some()
        || proof.sequence != 0
    {
        return Err(RuntimeError::Protocol(
            "companion observation proof does not match request".into(),
        ));
    }
    validate_proof_identifier(&proof.task_id, "task")?;
    validate_proof_identifier(
        proof
            .generation
            .as_deref()
            .ok_or_else(|| RuntimeError::Protocol("companion generation is missing".into()))?,
        "generation",
    )?;
    validate_cryptographic_nonce(&proof.stream_nonce, "stream nonce")?;
    validate_cryptographic_nonce(&proof.nonce, "proof nonce")?;
    consume_companion_proof_nonce(context, requester_peer_id, &proof).await?;
    let generation = proof.generation.expect("validated companion generation");
    Ok((proof.task_id, generation, proof.stream_nonce))
}

pub(super) async fn verify_send_companion_event_proof(
    context: &ListenerContext,
    request_id: &str,
    requester_peer_id: &str,
    sealed_proof: &str,
) -> Result<
    (
        String,
        String,
        String,
        String,
        String,
        String,
        u64,
        CompanionEvent,
    ),
    RuntimeError,
> {
    validate_proof_identifier(request_id, "request")?;
    validate_proof_identifier(requester_peer_id, "requester peer")?;
    let proof = open_companion_proof(context, requester_peer_id, sealed_proof).await?;
    validate_proof_identifier(&proof.request_id, "request")?;
    validate_proof_identifier(&proof.requester_peer_id, "requester peer")?;
    if proof.operation != "send_companion_event"
        || proof.request_id != request_id
        || proof.requester_peer_id != requester_peer_id
    {
        return Err(RuntimeError::Protocol(
            "companion event proof does not match request".into(),
        ));
    }
    validate_proof_identifier(&proof.task_id, "task")?;
    validate_proof_identifier(
        proof
            .session_id
            .as_deref()
            .ok_or_else(|| RuntimeError::Protocol("companion event session is missing".into()))?,
        "session",
    )?;
    validate_proof_identifier(
        proof
            .revision
            .as_deref()
            .ok_or_else(|| RuntimeError::Protocol("companion event revision is missing".into()))?,
        "revision",
    )?;
    validate_proof_identifier(
        proof.generation.as_deref().ok_or_else(|| {
            RuntimeError::Protocol("companion event generation is missing".into())
        })?,
        "generation",
    )?;
    validate_cryptographic_nonce(&proof.stream_nonce, "stream nonce")?;
    validate_cryptographic_nonce(&proof.nonce, "proof nonce")?;
    validate_observation_challenge(proof.observation_challenge.as_deref().ok_or_else(|| {
        RuntimeError::Protocol("companion observation challenge is missing".into())
    })?)?;
    if proof.event.is_none() {
        return Err(RuntimeError::Protocol("companion event is missing".into()));
    }
    consume_companion_proof_nonce(context, requester_peer_id, &proof).await?;
    Ok((
        proof.task_id,
        proof
            .session_id
            .ok_or_else(|| RuntimeError::Protocol("companion event session is missing".into()))?,
        proof
            .revision
            .ok_or_else(|| RuntimeError::Protocol("companion event revision is missing".into()))?,
        proof.generation.ok_or_else(|| {
            RuntimeError::Protocol("companion event generation is missing".into())
        })?,
        proof.stream_nonce,
        proof.observation_challenge.ok_or_else(|| {
            RuntimeError::Protocol("companion observation challenge is missing".into())
        })?,
        proof.sequence,
        proof
            .event
            .ok_or_else(|| RuntimeError::Protocol("companion event is missing".into()))?,
    ))
}

pub(super) async fn ensure_owner_companion_generation(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
    generation: &str,
    stream_nonce: &str,
    observation_challenge: &str,
    sequence: u64,
) -> Result<Arc<Mutex<CompanionEventRateLimiter>>, RuntimeError> {
    let key = (requester_peer_id.to_owned(), task_id.to_owned());
    let mut observers = context.owner_companion_observers.lock().await;
    if let Some(observer) = observers.get_mut(&key) {
        if observer.generation == generation
            && observer.stream_nonce == stream_nonce
            && observer.observation_challenge == observation_challenge
            && observer.next_event_sequence == sequence
        {
            observer.next_event_sequence += 1;
            return Ok(Arc::clone(&observer.event_rate_limiter));
        }
    }
    Err(RuntimeError::Protocol(
        "companion observation is not active".into(),
    ))
}

async fn open_companion_proof(
    context: &ListenerContext,
    requester_peer_id: &str,
    sealed_proof: &str,
) -> Result<CompanionProof, RuntimeError> {
    let requester_public = requester_peer_public_key(context, requester_peer_id).await?;
    let identity =
        super::utils::load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
    open_typed(&identity, &requester_public, sealed_proof)
        .map_err(|error| RuntimeError::Protocol(format!("invalid companion proof: {error}")))
}

async fn consume_companion_proof_nonce(
    context: &ListenerContext,
    requester_peer_id: &str,
    proof: &CompanionProof,
) -> Result<(), RuntimeError> {
    let now = now_ms()?;
    let mut nonces = context.companion_proof_nonces.lock().await;
    consume_companion_proof_nonce_at(
        &mut nonces,
        requester_peer_id,
        &proof.nonce,
        proof.issued_at_ms,
        now,
        Instant::now(),
    )
}

fn consume_companion_proof_nonce_at(
    nonces: &mut std::collections::HashMap<(String, String), Instant>,
    requester_peer_id: &str,
    nonce: &str,
    issued_at_ms: u64,
    now_ms: u64,
    now: Instant,
) -> Result<(), RuntimeError> {
    validate_proof_identifier(requester_peer_id, "requester peer")?;
    validate_cryptographic_nonce(nonce, "proof nonce")?;
    if now_ms.abs_diff(issued_at_ms) > COMPANION_PROOF_TTL.as_millis() as u64 {
        return Err(RuntimeError::Protocol("companion proof expired".into()));
    }
    let key = (requester_peer_id.to_owned(), nonce.to_owned());
    nonces.retain(|_, seen| now.saturating_duration_since(*seen) <= COMPANION_PROOF_TTL);
    if nonces.contains_key(&key) {
        return Err(RuntimeError::Protocol(
            "companion proof has already been used".into(),
        ));
    }
    if nonces.len() >= MAX_COMPANION_PROOF_NONCES {
        return Err(RuntimeError::Protocol(
            "companion proof replay cache is full".into(),
        ));
    }
    nonces.insert(key, now);
    Ok(())
}

fn fresh_nonce() -> String {
    let mut bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn validate_proof_identifier(value: &str, name: &str) -> Result<(), RuntimeError> {
    if value.is_empty()
        || value.len() > MAX_COMPANION_PROOF_IDENTIFIER_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(RuntimeError::Protocol(format!(
            "companion {name} identifier is invalid"
        )));
    }
    Ok(())
}

fn validate_cryptographic_nonce(value: &str, name: &str) -> Result<(), RuntimeError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| RuntimeError::Protocol(format!("companion {name} is invalid")))?;
    if decoded.len() != 24 || URL_SAFE_NO_PAD.encode(decoded) != value {
        return Err(RuntimeError::Protocol(format!(
            "companion {name} is invalid"
        )));
    }
    Ok(())
}

pub(super) fn fresh_observation_challenge() -> String {
    fresh_nonce()
}

fn validate_observation_challenge(challenge: &str) -> Result<(), RuntimeError> {
    validate_cryptographic_nonce(challenge, "observation challenge")
}

fn now_ms() -> Result<u64, RuntimeError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RuntimeError::Protocol("system clock is before Unix epoch".into()))?
        .as_millis() as u64)
}

pub(super) struct PeerCompanionOpen {
    pub(super) peer: PeerRegistryEntry,
    pub(super) request_id: String,
    pub(super) requester_peer_id: String,
    pub(super) task_id: String,
    pub(super) generation: String,
    pub(super) sealed_proof: String,
    pub(super) stream_nonce: String,
}

pub(super) async fn open_peer_companion_stream(
    opening: PeerCompanionOpen,
    identity: &TransferIdentity,
) -> Result<(BufReader<TcpStream>, String), RuntimeError> {
    let PeerCompanionOpen {
        peer,
        request_id,
        requester_peer_id,
        task_id,
        generation,
        sealed_proof,
        stream_nonce,
    } = opening;
    let mut stream = TcpStream::connect(&peer.endpoint).await?;
    write_json_line(
        &mut stream,
        &PeerRequest::ObserveCompanion {
            request_id: request_id.clone(),
            requester_peer_id,
            sealed_payload: sealed_proof,
        },
    )
    .await?;

    let mut reader = BufReader::new(stream);
    let response_line = read_bounded_line(
        &mut reader,
        MAX_COMPANION_CONTROL_LINE_BYTES,
        "companion ACK",
    )
    .await?
    .ok_or_else(|| {
        RuntimeError::Protocol(format!(
            "peer {} closed observe-companion before response",
            peer.peer_id
        ))
    })?;
    let observation_challenge =
        match parse_peer_response_line(&peer.peer_id, "observe-companion", &response_line)? {
            PeerResponse::ObserveCompanion {
                request_id: response_request_id,
                sealed_payload,
            } if response_request_id == request_id => {
                let owner_public = crate::crypto::parse_public_key(&peer.public_key)?;
                let payload = open_owner_payload(identity, &owner_public, &sealed_payload)?;
                let (challenge, frame) = validate_owner_payload(
                    payload,
                    "observe_companion_ack",
                    &request_id,
                    &task_id,
                    &generation,
                    &stream_nonce,
                    None,
                    0,
                )?;
                if frame.is_some() {
                    return Err(RuntimeError::Protocol(
                        "companion ACK contains a frame".into(),
                    ));
                }
                challenge
            }
            PeerResponse::Error { message, .. } => return Err(RuntimeError::Protocol(message)),
            other => {
                return Err(RuntimeError::Protocol(format!(
                    "unexpected observe-companion response: {other:?}"
                )));
            }
        };

    Ok((reader, observation_challenge))
}

pub(super) struct PeerCompanionStream {
    pub(super) peer: PeerRegistryEntry,
    pub(super) task_id: String,
    pub(super) generation: String,
    pub(super) generation_order: u64,
    pub(super) request_id: String,
    pub(super) stream_nonce: String,
    pub(super) observation_challenge: String,
    pub(super) identity: TransferIdentity,
    pub(super) incoming_sender: RuntimeEventSender,
    pub(super) inbound_decode_slots: Arc<Semaphore>,
    pub(super) inbound_decode_budget: Arc<CompanionInboundByteBudget>,
}

pub(super) async fn stream_peer_companion<R>(
    observation: PeerCompanionStream,
    mut reader: R,
) -> Result<(), RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let PeerCompanionStream {
        peer,
        task_id,
        generation,
        generation_order,
        request_id,
        stream_nonce,
        observation_challenge,
        identity,
        incoming_sender,
        inbound_decode_slots,
        inbound_decode_budget,
    } = observation;
    let mut expected_sequence = 1_u64;
    loop {
        let (event_line, wire_permit) =
            read_bounded_companion_line(&mut reader, &inbound_decode_budget)
                .await?
                .ok_or_else(|| {
                    RuntimeError::Protocol(format!(
                        "peer {} closed the companion stream for task {}",
                        peer.peer_id, task_id
                    ))
                })?;
        let decode_slot = Arc::clone(&inbound_decode_slots)
            .acquire_owned()
            .await
            .map_err(|_| {
                RuntimeError::Protocol("companion decode admission is unavailable".into())
            })?;
        let frame = decode_peer_companion_frame(
            event_line,
            peer.peer_id.clone(),
            peer.public_key.clone(),
            task_id.clone(),
            generation.clone(),
            request_id.clone(),
            stream_nonce.clone(),
            observation_challenge.clone(),
            expected_sequence,
            identity.clone(),
            decode_slot,
            wire_permit,
        )
        .await?;
        expected_sequence += 1;
        incoming_sender
            .send(RuntimeEvent::CompanionEvent {
                peer_id: peer.peer_id.clone(),
                task_id: task_id.clone(),
                generation: generation.clone(),
                generation_order,
                frame,
            })
            .await
            .map_err(|_| RuntimeError::IncomingEventChannelClosed)?;
    }
}

async fn read_bounded_companion_line<R>(
    reader: &mut R,
    inbound_byte_budget: &Arc<CompanionInboundByteBudget>,
) -> Result<Option<(String, CompanionInboundBytePermit)>, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(MAX_COMPANION_FRAME_LINE_BYTES.min(8 * 1024));
    let mut wire_permit = None;
    let max_wire_bytes = MAX_COMPANION_FRAME_LINE_BYTES.saturating_add(1);
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(RuntimeError::Protocol(
                "companion frame is missing newline".into(),
            ));
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len().saturating_add(newline) > max_wire_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "companion frame exceeds {MAX_COMPANION_FRAME_LINE_BYTES} bytes"
                )));
            }
            retain_companion_wire_bytes(&mut wire_permit, inbound_byte_budget, newline)?;
            line.reserve_exact(newline);
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
                wire_permit
                    .as_mut()
                    .expect("copied carriage return must hold byte admission")
                    .release(1);
            }
            if line.len() > MAX_COMPANION_FRAME_LINE_BYTES {
                return Err(RuntimeError::Protocol(format!(
                    "companion frame exceeds {MAX_COMPANION_FRAME_LINE_BYTES} bytes"
                )));
            }
            let line = String::from_utf8(line)
                .map_err(|_| RuntimeError::Protocol("companion frame is not valid UTF-8".into()))?;
            let wire_permit = wire_permit.unwrap_or_else(|| {
                inbound_byte_budget
                    .try_reserve(0)
                    .expect("zero-byte companion admission must succeed")
            });
            return Ok(Some((line, wire_permit)));
        }
        if line.len().saturating_add(available.len()) > max_wire_bytes {
            return Err(RuntimeError::Protocol(format!(
                "companion frame exceeds {MAX_COMPANION_FRAME_LINE_BYTES} bytes"
            )));
        }
        retain_companion_wire_bytes(&mut wire_permit, inbound_byte_budget, available.len())?;
        line.reserve_exact(available.len());
        line.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

fn retain_companion_wire_bytes(
    permit: &mut Option<CompanionInboundBytePermit>,
    budget: &Arc<CompanionInboundByteBudget>,
    bytes: usize,
) -> Result<(), RuntimeError> {
    let admitted = match permit {
        Some(permit) => permit.try_extend(bytes),
        None => match budget.try_reserve(bytes) {
            Some(first) => {
                *permit = Some(first);
                true
            }
            None => false,
        },
    };
    admitted.then_some(()).ok_or_else(|| {
        RuntimeError::Protocol("companion decode byte admission is unavailable".into())
    })
}

#[allow(clippy::too_many_arguments)]
async fn decode_peer_companion_frame(
    event_line: String,
    peer_id: String,
    owner_public_key: String,
    task_id: String,
    generation: String,
    request_id: String,
    stream_nonce: String,
    observation_challenge: String,
    expected_sequence: u64,
    identity: TransferIdentity,
    decode_slot: OwnedSemaphorePermit,
    wire_permit: CompanionInboundBytePermit,
) -> Result<ServerFrame, RuntimeError> {
    tokio::task::spawn_blocking(move || {
        let _decode_slot = decode_slot;
        let _wire_permit = wire_permit;
        let event =
            serde_json::from_str::<PeerCompanionEvent>(event_line.trim()).map_err(|error| {
                RuntimeError::Protocol(format!(
                    "peer {peer_id} returned a non-JSON companion event for task {task_id}: {error}"
                ))
            })?;
        let PeerCompanionEvent::Sealed { sealed_payload } = event;
        let owner_public = crate::crypto::parse_public_key(&owner_public_key)?;
        let payload = open_owner_payload(&identity, &owner_public, &sealed_payload)?;
        let (_, frame) = validate_owner_payload(
            payload,
            "companion_frame",
            &request_id,
            &task_id,
            &generation,
            &stream_nonce,
            Some(&observation_challenge),
            expected_sequence,
        )?;
        frame.ok_or_else(|| RuntimeError::Protocol("companion frame payload is missing".into()))
    })
    .await
    .map_err(|_| RuntimeError::Protocol("companion decode worker failed".into()))?
}

pub(super) struct OwnerCompanionStream {
    pub(super) task_id: String,
    pub(super) request_id: String,
    pub(super) generation: String,
    pub(super) stream_nonce: String,
    pub(super) observation_challenge: String,
}

pub(super) async fn stream_owner_companion(
    context: &ListenerContext,
    mut stream: TcpStream,
    requester_peer_id: &str,
    observation: OwnerCompanionStream,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), RuntimeError> {
    let OwnerCompanionStream {
        task_id,
        request_id,
        generation,
        stream_nonce,
        observation_challenge,
    } = observation;
    let _active = ActiveOwnerCompanion::new(Arc::clone(&context.active_owner_companions));
    let db_path = context
        .db_path
        .clone()
        .ok_or_else(|| RuntimeError::Protocol("database path is not configured".into()))?;
    let viewer_public = requester_peer_public_key(context, requester_peer_id).await?;
    let identity =
        super::utils::load_or_create_identity(&context.registry_root, &context.self_peer_id)?;
    let (source, mut receiver) = owner_companion_source(context, db_path, task_id.clone()).await;
    if receiver.borrow().is_some() {
        receiver.mark_changed();
    }
    let mut sequence = 1_u64;

    let result = loop {
        let changed = tokio::select! {
            changed = receiver.changed() => {
                if changed.is_err() {
                    break Ok(());
                }
                true
            }
            readable = stream.readable() => {
                if let Err(error) = readable {
                    break Err(error.into());
                }
                let mut byte = [0_u8; 1];
                match stream.try_read(&mut byte) {
                    Ok(0) => break Ok(()),
                    Ok(_) => break Err(RuntimeError::Protocol(
                        "unexpected data on companion observation stream".into(),
                    )),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
                    Err(error) => break Err(error.into()),
                }
            }
            cancelled = cancel.changed() => {
                if cancelled.is_err() || *cancel.borrow() {
                    break Ok(());
                }
                false
            }
        };
        if !changed {
            continue;
        }
        let frame = receiver.borrow_and_update().clone();
        let Some(frame) = frame else {
            continue;
        };
        let encode_permit = match Arc::clone(&context.owner_companion_encoding_slots)
            .acquire_owned()
            .await
        {
            Ok(permit) => permit,
            Err(_) => {
                break Err(RuntimeError::Protocol(
                    "companion encoding admission is unavailable".into(),
                ))
            }
        };
        let seal_identity = identity.clone();
        let seal_viewer_public = viewer_public;
        let seal_frame = Arc::clone(&frame);
        let seal_request_id = request_id.clone();
        let seal_task_id = task_id.clone();
        let seal_generation = generation.clone();
        let seal_stream_nonce = stream_nonce.clone();
        let seal_observation_challenge = observation_challenge.clone();
        let sealed_payload = tokio::task::spawn_blocking(move || {
            seal_owner_frame_payload(
                &seal_identity,
                &seal_viewer_public,
                &seal_request_id,
                &seal_task_id,
                &seal_generation,
                &seal_stream_nonce,
                &seal_observation_challenge,
                sequence,
                seal_frame.as_ref(),
            )
        })
        .await
        .map_err(|_| RuntimeError::Protocol("companion encrypt worker failed".into()))
        .and_then(|result| result);
        let sealed_payload = match sealed_payload {
            Ok(payload) => payload,
            Err(error) => break Err(error),
        };
        sequence += 1;
        match write_sealed_companion_payload(
            &mut stream,
            sealed_payload,
            &mut cancel,
            context.peer_request_timeout,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => break Ok(()),
            Err(error) => break Err(error),
        }
        drop(encode_permit);
    };
    drop(receiver);
    release_owner_companion_source(context, &task_id, &source).await;
    result
}

async fn write_sealed_companion_payload(
    stream: &mut TcpStream,
    sealed_payload: String,
    cancel: &mut watch::Receiver<bool>,
    delivery_timeout: Duration,
) -> Result<bool, RuntimeError> {
    let deadline = tokio::time::Instant::now() + delivery_timeout;
    let (chunk_tx, mut chunk_rx) = mpsc::channel::<Vec<u8>>(2);
    let producer = tokio::task::spawn_blocking(move || {
        produce_sealed_companion_chunks(&sealed_payload, &chunk_tx)
    });
    loop {
        let receive = tokio::time::timeout_at(deadline, chunk_rx.recv());
        let chunk = tokio::select! {
            result = receive => {
                result.map_err(|_| RuntimeError::Protocol(
                    "companion observer delivery timed out".into(),
                ))?
            }
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Ok(false);
                }
                continue;
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if !write_companion_delivery_chunk(stream, &chunk, cancel, deadline).await? {
            return Ok(false);
        }
    }
    producer
        .await
        .map_err(|_| RuntimeError::Protocol("companion frame worker failed".into()))?;
    let flush = tokio::time::timeout_at(deadline, stream.flush());
    tokio::select! {
        result = flush => {
            result
                .map_err(|_| RuntimeError::Protocol(
                    "companion observer delivery timed out".into(),
                ))??;
        }
        changed = cancel.changed() => {
            if changed.is_err() || *cancel.borrow() {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn produce_sealed_companion_chunks(sealed_payload: &str, chunk_tx: &mpsc::Sender<Vec<u8>>) {
    const PREFIX: &[u8] = b"{\"sealed\":{\"sealed_payload\":\"";
    const SUFFIX: &[u8] = b"\"}}\n";
    const CHUNK_BYTES: usize = 64 * 1024;
    if chunk_tx.blocking_send(PREFIX.to_vec()).is_err() {
        return;
    }
    let mut escaped = Vec::with_capacity(CHUNK_BYTES + 6);
    for byte in sealed_payload.bytes() {
        match byte {
            b'"' => escaped.extend_from_slice(br#"\""#),
            b'\\' => escaped.extend_from_slice(br#"\\"#),
            b'\n' => escaped.extend_from_slice(br#"\n"#),
            b'\r' => escaped.extend_from_slice(br#"\r"#),
            b'\t' => escaped.extend_from_slice(br#"\t"#),
            0x08 => escaped.extend_from_slice(br#"\b"#),
            0x0c => escaped.extend_from_slice(br#"\f"#),
            0x00..=0x1f => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                escaped.extend_from_slice(b"\\u00");
                escaped.push(HEX[(byte >> 4) as usize]);
                escaped.push(HEX[(byte & 0x0f) as usize]);
            }
            _ => escaped.push(byte),
        }
        if escaped.len() >= CHUNK_BYTES {
            if chunk_tx
                .blocking_send(std::mem::take(&mut escaped))
                .is_err()
            {
                return;
            }
            escaped = Vec::with_capacity(CHUNK_BYTES + 6);
        }
    }
    if !escaped.is_empty() && chunk_tx.blocking_send(escaped).is_err() {
        return;
    }
    let _ = chunk_tx.blocking_send(SUFFIX.to_vec());
}

async fn write_companion_delivery_chunk(
    stream: &mut TcpStream,
    chunk: &[u8],
    cancel: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<bool, RuntimeError> {
    loop {
        let write = tokio::time::timeout_at(deadline, stream.write_all(chunk));
        tokio::select! {
            result = write => {
                result
                    .map_err(|_| RuntimeError::Protocol(
                        "companion observer delivery timed out".into(),
                    ))??;
                return Ok(true);
            }
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    return Ok(false);
                }
            }
        }
    }
}

async fn owner_companion_source(
    context: &ListenerContext,
    db_path: PathBuf,
    task_id: String,
) -> (
    Arc<OwnerCompanionSource>,
    watch::Receiver<Option<Arc<ServerFrame>>>,
) {
    let mut sources = context.owner_companion_sources.lock().await;
    if let Some(source) = sources.get(&task_id) {
        return (Arc::clone(source), source.sender.subscribe());
    }
    let (sender, receiver) = watch::channel(None);
    let (cancel, cancel_receiver) = watch::channel(false);
    let source = Arc::new(OwnerCompanionSource { sender, cancel });
    sources.insert(task_id.clone(), Arc::clone(&source));
    spawn_owner_companion_poller(
        db_path,
        task_id,
        Arc::clone(&source),
        cancel_receiver,
        Arc::clone(&context.owner_companion_retained_bytes),
        Arc::clone(&context.companion_materialization_budget),
    );
    (source, receiver)
}

fn spawn_owner_companion_poller(
    db_path: PathBuf,
    task_id: String,
    source: Arc<OwnerCompanionSource>,
    mut cancel: watch::Receiver<bool>,
    retained_bytes: Arc<AtomicUsize>,
    materialization_budget: Arc<kanna_visual_companion::CompanionMaterializationBudget>,
) {
    tokio::spawn(async move {
        let mut retention = OwnerCompanionRetention::new(retained_bytes);
        let scan_budget = Arc::clone(&materialization_budget);
        let mut state = OwnerScanState {
            scanner: CompanionScanner::with_materialization_budget(materialization_budget),
            workspace: None,
        };
        let mut last_frame: Option<Arc<ServerFrame>> = None;
        loop {
            let scan_db_path = db_path.clone();
            let scan_task_id = task_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                let (state, frame) = scan_owner_companion(state, &scan_db_path, &scan_task_id);
                let bytes = frame.as_ref().map_or(0, companion_frame_retained_bytes);
                (state, frame, bytes)
            })
            .await;
            let (next_state, frame, frame_bytes) = match result {
                Ok(result) => result,
                Err(_) => (
                    OwnerScanState {
                        scanner: CompanionScanner::with_materialization_budget(Arc::clone(
                            &scan_budget,
                        )),
                        workspace: None,
                    },
                    Some(ServerFrame::CompanionError {
                        task_id: task_id.clone(),
                        code: "read_failed".into(),
                        message: "Visual companion scan worker failed.".into(),
                        attachment_epoch: None,
                    }),
                    0,
                ),
            };
            state = next_state;
            if let Some(frame) = frame {
                let frame = if retention.replace(frame_bytes) {
                    Arc::new(frame)
                } else {
                    Arc::new(ServerFrame::CompanionError {
                        task_id: task_id.clone(),
                        code: "retention_budget_exceeded".into(),
                        message: "Visual companion tasks exceed their shared memory budget.".into(),
                        attachment_epoch: None,
                    })
                };
                if last_frame.as_deref() != Some(frame.as_ref()) {
                    last_frame = Some(Arc::clone(&frame));
                    publish_owner_companion_frame(&source, frame);
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(COMPANION_POLL_INTERVAL) => {}
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        return;
                    }
                }
            }
        }
    });
}

fn publish_owner_companion_frame(source: &OwnerCompanionSource, frame: Arc<ServerFrame>) {
    // A reconnect can subscribe to the cached source after the previous
    // receiver has dropped but before release acquires the source-map lock.
    // Store the latest value even with zero receivers; the poller's last-frame
    // suppression means there may never be a second publish for this revision.
    source.sender.send_replace(Some(frame));
}

fn companion_frame_retained_bytes(frame: &ServerFrame) -> usize {
    match frame {
        ServerFrame::CompanionSnapshot {
            task_id,
            session_id,
            revision,
            html,
            source_origin,
            assets,
            ..
        } => {
            task_id.len()
                + session_id.len()
                + revision.len()
                + html.len()
                + source_origin.as_deref().map_or(0, str::len)
                + assets
                    .iter()
                    .map(|asset| {
                        asset.name.len()
                            + asset.content_type.len()
                            + asset.digest.len()
                            + asset.data_b64.len()
                    })
                    .sum::<usize>()
                + 1024
        }
        _ => 1024,
    }
}

async fn release_owner_companion_source(
    context: &ListenerContext,
    task_id: &str,
    source: &Arc<OwnerCompanionSource>,
) {
    let mut sources = context.owner_companion_sources.lock().await;
    if source.sender.receiver_count() == 0
        && sources
            .get(task_id)
            .is_some_and(|current| Arc::ptr_eq(current, source))
    {
        sources.remove(task_id);
        let _ = source.cancel.send(true);
    }
}

pub(super) async fn register_owner_companion_observer(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
    generation: &str,
    stream_nonce: &str,
    observation_challenge: &str,
) -> Result<watch::Receiver<bool>, RuntimeError> {
    let key = (requester_peer_id.to_owned(), task_id.to_owned());
    let mut observers = context.owner_companion_observers.lock().await;
    if !observers.contains_key(&key) && observers.len() >= MAX_COMPANION_OBSERVERS {
        return Err(RuntimeError::Protocol(
            "too many active companion observers".into(),
        ));
    }
    if let Some(previous) = observers.remove(&key) {
        let _ = previous.cancel.send(true);
    }
    let (cancel, receiver) = watch::channel(false);
    observers.insert(
        key,
        OwnerCompanionObserver {
            generation: generation.into(),
            stream_nonce: stream_nonce.into(),
            observation_challenge: observation_challenge.into(),
            next_event_sequence: 1,
            event_rate_limiter: Arc::new(Mutex::new(CompanionEventRateLimiter::default())),
            cancel,
        },
    );
    Ok(receiver)
}

pub(super) async fn remove_owner_companion_observer(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
    generation: &str,
) {
    let key = (requester_peer_id.to_owned(), task_id.to_owned());
    let mut observers = context.owner_companion_observers.lock().await;
    if observers
        .get(&key)
        .is_some_and(|observer| observer.generation == generation)
    {
        observers.remove(&key);
    }
}

fn scan_owner_companion(
    mut state: OwnerScanState,
    db_path: &Path,
    task_id: &str,
) -> (OwnerScanState, Option<ServerFrame>) {
    let workspace = match resolve_workspace(db_path, task_id) {
        Ok(workspace) => workspace,
        Err(error) => {
            state.scanner.invalidate();
            state.workspace = None;
            return (state, Some(frame_for_scan_error(task_id, error)));
        }
    };
    if state.workspace.as_deref() != Some(workspace.as_path()) {
        state.scanner.invalidate();
        state.workspace = Some(workspace.clone());
    }
    let frame = match state.scanner.scan(&workspace) {
        Ok(CompanionScan::Changed(Some(bundle))) => Some(bundle_frame(task_id, bundle)),
        Ok(CompanionScan::Changed(None)) => Some(ServerFrame::CompanionUnavailable {
            task_id: task_id.to_owned(),
            attachment_epoch: None,
        }),
        Ok(CompanionScan::Unchanged) => None,
        Err(error) => Some(frame_for_scan_error(task_id, error)),
    };
    (state, frame)
}

fn bundle_frame(task_id: &str, bundle: CompanionBundle) -> ServerFrame {
    ServerFrame::CompanionSnapshot {
        task_id: task_id.to_owned(),
        session_id: bundle.session_id,
        revision: bundle.revision,
        document_kind: bundle.document_kind,
        html: bundle.html,
        source_origin: bundle.source_origin,
        assets: bundle.assets,
        attachment_epoch: None,
    }
}

fn frame_for_scan_error(task_id: &str, error: CompanionError) -> ServerFrame {
    match error {
        CompanionError::TaskNotFound | CompanionError::WorkspaceUnavailable => {
            ServerFrame::CompanionUnavailable {
                task_id: task_id.to_owned(),
                attachment_epoch: None,
            }
        }
        CompanionError::TooLarge => ServerFrame::CompanionError {
            task_id: task_id.to_owned(),
            code: "too_large".into(),
            message: "Visual companion exceeds its resource limits.".into(),
            attachment_epoch: None,
        },
        CompanionError::UnsupportedContent => ServerFrame::CompanionError {
            task_id: task_id.to_owned(),
            code: "unsupported_content".into(),
            message: "Visual companion is not valid UTF-8 HTML.".into(),
            attachment_epoch: None,
        },
        CompanionError::StaleRevision | CompanionError::InvalidEvent => {
            ServerFrame::CompanionError {
                task_id: task_id.to_owned(),
                code: "read_failed".into(),
                message: "Visual companion could not be read.".into(),
                attachment_epoch: None,
            }
        }
        CompanionError::Internal(_) => ServerFrame::CompanionError {
            task_id: task_id.to_owned(),
            code: "read_failed".into(),
            message: "Visual companion could not be read.".into(),
            attachment_epoch: None,
        },
    }
}

pub(super) async fn append_owner_companion_event(
    context: &ListenerContext,
    task_id: &str,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<ServerFrame, RuntimeError> {
    let db_path = context
        .db_path
        .clone()
        .ok_or_else(|| RuntimeError::Protocol("database path is not configured".into()))?;
    let event_id = event.event_id.clone();
    let task = task_id.to_owned();
    let session = session_id.to_owned();
    let worker_revision = revision.to_owned();
    let mut event = event.clone();
    if event.session_id.is_empty() && event.revision.is_empty() {
        event.session_id = session_id.to_owned();
        event.revision = revision.to_owned();
    }
    let result = tokio::task::spawn_blocking(move || {
        append_event_with_workspace_resolver(
            || resolve_workspace(&db_path, &task),
            &session,
            &worker_revision,
            &event,
        )
    })
    .await
    .map_err(|_| RuntimeError::Protocol("visual companion event worker failed".into()))?;

    let (accepted, code, message) = match result {
        Ok(()) => (true, None, None),
        Err(CompanionError::InvalidEvent) => (
            false,
            Some("invalid_event".into()),
            Some("Visual companion event is invalid.".into()),
        ),
        Err(
            CompanionError::StaleRevision
            | CompanionError::TaskNotFound
            | CompanionError::WorkspaceUnavailable,
        ) => (
            false,
            Some("stale_revision".into()),
            Some("Refresh the visual companion and try again.".into()),
        ),
        Err(_) => (
            false,
            Some("write_failed".into()),
            Some("Could not send the visual companion event.".into()),
        ),
    };
    Ok(ServerFrame::CompanionEventResult {
        task_id: task_id.to_owned(),
        session_id: Some(session_id.to_owned()),
        revision: Some(revision.to_owned()),
        event_id,
        accepted,
        code,
        message,
        attachment_epoch: None,
    })
}

pub(super) async fn append_owner_companion_event_rate_limited(
    context: &ListenerContext,
    limiter: Arc<Mutex<CompanionEventRateLimiter>>,
    task_id: &str,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<ServerFrame, RuntimeError> {
    let mut limiter = limiter.lock().await;
    let now = Instant::now();
    if limiter.is_limited_at(session_id, now) {
        return Ok(ServerFrame::CompanionEventResult {
            task_id: task_id.to_owned(),
            session_id: Some(session_id.to_owned()),
            revision: Some(revision.to_owned()),
            event_id: event.event_id.clone(),
            accepted: false,
            code: Some("companion_rate_limited".into()),
            message: Some("Too many visual companion selections were sent.".into()),
            attachment_epoch: None,
        });
    }
    let frame = append_owner_companion_event(context, task_id, session_id, revision, event).await?;
    if matches!(
        &frame,
        ServerFrame::CompanionEventResult { accepted: true, .. }
    ) {
        limiter.record_accepted_at(session_id, Instant::now());
    }
    Ok(frame)
}

fn resolve_workspace(db_path: &Path, task_or_branch_id: &str) -> Result<PathBuf, CompanionError> {
    let db = rusqlite::Connection::open(db_path)
        .map_err(|_| CompanionError::Internal("failed to open Kanna database".into()))?;
    let exact: Option<String> = db
        .query_row(
            "SELECT id FROM pipeline_item WHERE id = ?",
            [task_or_branch_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| CompanionError::Internal("failed to resolve companion task".into()))?;
    let task_id = match exact {
        Some(id) => id,
        None => db
            .query_row(
                "SELECT id FROM pipeline_item WHERE branch = ?",
                [task_or_branch_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| CompanionError::Internal("failed to resolve companion task".into()))?
            .ok_or(CompanionError::TaskNotFound)?,
    };
    db.query_row(
        "SELECT path FROM worktree
         WHERE pipeline_item_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1",
        [task_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|_| CompanionError::Internal("failed to resolve task workspace".into()))?
    .map(PathBuf::from)
    .ok_or(CompanionError::WorkspaceUnavailable)
}

pub(super) fn frame_task_id(frame: &ServerFrame) -> Option<&str> {
    match frame {
        ServerFrame::CompanionSnapshot { task_id, .. }
        | ServerFrame::CompanionUnavailable { task_id, .. }
        | ServerFrame::CompanionEventResult { task_id, .. }
        | ServerFrame::CompanionError { task_id, .. } => Some(task_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{open_json, seal_json};
    use kanna_agent_protocol::{CompanionAsset, CompanionDocumentKind};
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWriteExt, ReadBuf};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    struct PollTrackingReader<R> {
        inner: R,
        first_poll: Option<oneshot::Sender<()>>,
    }

    impl<R> PollTrackingReader<R> {
        fn new(inner: R, first_poll: oneshot::Sender<()>) -> Self {
            Self {
                inner,
                first_poll: Some(first_poll),
            }
        }
    }

    impl<R> AsyncRead for PollTrackingReader<R>
    where
        R: AsyncBufRead + Unpin,
    {
        fn poll_read(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let this = self.get_mut();
            Pin::new(&mut this.inner).poll_read(context, buffer)
        }
    }

    impl<R> AsyncBufRead for PollTrackingReader<R>
    where
        R: AsyncBufRead + Unpin,
    {
        fn poll_fill_buf(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<std::io::Result<&[u8]>> {
            let this = self.get_mut();
            if let Some(first_poll) = this.first_poll.take() {
                let _ = first_poll.send(());
            }
            Pin::new(&mut this.inner).poll_fill_buf(context)
        }

        fn consume(self: Pin<&mut Self>, amount: usize) {
            let this = self.get_mut();
            Pin::new(&mut this.inner).consume(amount);
        }
    }

    fn maximum_legal_owner_payload() -> CompanionOwnerPayload {
        let asset_data = base64::engine::general_purpose::STANDARD.encode(vec![
            0_u8;
            MAX_COMPANION_ASSET_TOTAL_BYTES
                as usize
                / MAX_COMPANION_ASSET_COUNT
        ]);
        let assets = (0..MAX_COMPANION_ASSET_COUNT)
            .map(|index| CompanionAsset {
                name: format!("{index}.bin"),
                content_type: "application/octet-stream".into(),
                digest: "d".repeat(64),
                data_b64: asset_data.clone(),
            })
            .collect();
        CompanionOwnerPayload {
            operation: "companion_frame".into(),
            request_id: "request-1".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            stream_nonce: fresh_nonce(),
            observation_challenge: fresh_nonce(),
            sequence: 1,
            frame: Some(ServerFrame::CompanionSnapshot {
                task_id: "task-1".into(),
                session_id: "session-1".into(),
                revision: "r".repeat(64),
                document_kind: CompanionDocumentKind::FullDocument,
                html: "x".repeat(MAX_COMPANION_HTML_BYTES as usize),
                source_origin: None,
                assets,
                attachment_epoch: None,
            }),
        }
    }

    #[test]
    fn companion_event_rate_limit_matches_ksp_window_session_and_generation_boundaries() {
        let start = Instant::now();
        let mut limiter = CompanionEventRateLimiter::default();
        for _ in 0..MAX_COMPANION_EVENTS_PER_WINDOW {
            assert!(!limiter.is_limited_at("session-1", start));
            limiter.record_accepted_at("session-1", start);
        }
        assert!(limiter.is_limited_at("session-1", start));
        assert!(limiter.is_limited_at(
            "session-1",
            start + COMPANION_EVENT_WINDOW - Duration::from_nanos(1),
        ));
        assert!(!limiter.is_limited_at("session-2", start));
        assert!(!limiter.is_limited_at("session-1", start + COMPANION_EVENT_WINDOW,));

        let mut new_generation_limiter = CompanionEventRateLimiter::default();
        assert!(!new_generation_limiter.is_limited_at("session-1", start));
    }

    #[test]
    fn cached_poller_stores_a_distinct_revision_without_subscribers() {
        let initial = Arc::new(ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: "revision-1".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "first".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        });
        let replacement = Arc::new(ServerFrame::CompanionSnapshot {
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            revision: "revision-2".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "second".into(),
            source_origin: None,
            assets: Vec::new(),
            attachment_epoch: None,
        });
        let (sender, receiver) = watch::channel(Some(initial));
        let (cancel, _cancel_receiver) = watch::channel(false);
        let source = Arc::new(OwnerCompanionSource { sender, cancel });
        drop(receiver);

        publish_owner_companion_frame(&source, replacement);

        let reconnected = source.sender.subscribe();
        assert!(matches!(
            reconnected.borrow().as_deref(),
            Some(ServerFrame::CompanionSnapshot { revision, html, .. })
                if revision == "revision-2" && html == "second"
        ));
    }

    #[test]
    fn companion_rate_limiter_does_not_allocate_for_unaccepted_sessions_and_is_capped() {
        let now = Instant::now();
        let mut limiter = CompanionEventRateLimiter::default();
        for index in 0..(MAX_COMPANION_RATE_LIMIT_SESSIONS * 2) {
            assert!(!limiter.is_limited_at(&format!("unaccepted-{index}"), now));
        }
        assert!(limiter.recent_by_session.is_empty());

        for index in 0..MAX_COMPANION_RATE_LIMIT_SESSIONS {
            let session = format!("accepted-{index}");
            assert!(!limiter.is_limited_at(&session, now));
            limiter.record_accepted_at(&session, now);
        }
        assert!(limiter.is_limited_at("one-too-many", now));
        assert_eq!(
            limiter.recent_by_session.len(),
            MAX_COMPANION_RATE_LIMIT_SESSIONS
        );
    }

    #[test]
    fn observation_challenge_requires_canonical_cryptographic_nonce() {
        let challenge = fresh_nonce();
        validate_observation_challenge(&challenge).unwrap();
        for invalid in ["", "short", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] {
            assert!(validate_observation_challenge(invalid).is_err());
        }
    }

    #[test]
    fn proof_fields_are_bounded_before_replay_or_observer_state() {
        for name in ["task", "request", "requester peer"] {
            assert!(validate_proof_identifier("task-1", name).is_ok());
        }
        for invalid in ["", "bad\nid"] {
            assert!(validate_proof_identifier(invalid, "task").is_err());
        }
        assert!(validate_proof_identifier(
            &"x".repeat(MAX_COMPANION_PROOF_IDENTIFIER_BYTES + 1),
            "task",
        )
        .is_err());
        let nonce = fresh_nonce();
        assert!(validate_cryptographic_nonce(&nonce, "proof nonce").is_ok());
        for invalid in ["", "short", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] {
            assert!(validate_cryptographic_nonce(invalid, "proof nonce").is_err());
        }
    }

    #[tokio::test]
    async fn companion_ack_proxy_rejects_newline_free_control_at_limit() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let peer = PeerRegistryEntry {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            endpoint,
            pid: std::process::id(),
            public_key: crate::crypto::public_key_to_string(&owner.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = String::new();
            BufReader::new(&mut stream)
                .read_line(&mut request)
                .await
                .unwrap();
            stream
                .write_all(&vec![b'x'; MAX_COMPANION_CONTROL_LINE_BYTES])
                .await
                .unwrap();
        });
        let (sealed, stream_nonce) = seal_observe_companion_proof(
            &viewer,
            &owner.public_key,
            "request-1",
            "peer-viewer",
            "task-1",
            "generation-1",
        )
        .unwrap();
        let error = open_peer_companion_stream(
            crate::runtime::companion::PeerCompanionOpen {
                peer,
                request_id: "request-1".into(),
                requester_peer_id: "peer-viewer".into(),
                task_id: "task-1".into(),
                generation: "generation-1".into(),
                sealed_proof: sealed,
                stream_nonce,
            },
            &viewer,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("missing newline"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn maximum_companion_delivery_times_out_for_non_reading_observer() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let client = TcpStream::connect(endpoint).await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        let (_cancel_tx, mut cancel) = watch::channel(false);
        let sealed_payload = "A".repeat(MAX_COMPANION_FRAME_LINE_BYTES - 64);

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            write_sealed_companion_payload(
                &mut server,
                sealed_payload,
                &mut cancel,
                Duration::from_millis(25),
            ),
        )
        .await
        .expect("non-reading observer delivery ignored its timeout");
        assert!(matches!(
            result,
            Err(RuntimeError::Protocol(message)) if message.contains("timed out")
        ));
        drop(client);
    }

    #[tokio::test]
    async fn companion_frame_proxy_rejects_one_byte_over_derived_limit() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let peer = PeerRegistryEntry {
            peer_id: "peer-owner".into(),
            display_name: "Owner".into(),
            endpoint,
            pid: std::process::id(),
            public_key: crate::crypto::public_key_to_string(&owner.public_key),
            protocol_version: 1,
            accepting_transfers: true,
        };
        let viewer_public = viewer.public_key;
        let owner_for_server = owner.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request_line = String::new();
            BufReader::new(&mut stream)
                .read_line(&mut request_line)
                .await
                .unwrap();
            let PeerRequest::ObserveCompanion {
                request_id,
                sealed_payload,
                ..
            } = serde_json::from_str(request_line.trim()).unwrap()
            else {
                panic!("expected companion observe");
            };
            let proof = open_json(&owner_for_server, &viewer_public, &sealed_payload).unwrap();
            let challenge = fresh_nonce();
            let ack = seal_owner_payload(
                &owner_for_server,
                &viewer_public,
                CompanionOwnerPayload {
                    operation: "observe_companion_ack".into(),
                    request_id: request_id.clone(),
                    task_id: proof["task_id"].as_str().unwrap().into(),
                    generation: proof["generation"].as_str().unwrap().into(),
                    stream_nonce: proof["stream_nonce"].as_str().unwrap().into(),
                    observation_challenge: challenge,
                    sequence: 0,
                    frame: None,
                },
            )
            .unwrap();
            stream
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&PeerResponse::ObserveCompanion {
                            request_id,
                            sealed_payload: ack,
                        })
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let chunk = [b'x'; 8192];
            let mut remaining = MAX_COMPANION_FRAME_LINE_BYTES + 1;
            while remaining > 0 {
                let count = remaining.min(chunk.len());
                if stream.write_all(&chunk[..count]).await.is_err() {
                    return;
                }
                remaining -= count;
            }
            let _ = stream.write_all(b"\n").await;
        });
        let (sealed, stream_nonce) = seal_observe_companion_proof(
            &viewer,
            &owner.public_key,
            "request-1",
            "peer-viewer",
            "task-1",
            "generation-1",
        )
        .unwrap();
        let (stream, challenge) = open_peer_companion_stream(
            crate::runtime::companion::PeerCompanionOpen {
                peer: peer.clone(),
                request_id: "request-1".into(),
                requester_peer_id: "peer-viewer".into(),
                task_id: "task-1".into(),
                generation: "generation-1".into(),
                sealed_proof: sealed,
                stream_nonce: stream_nonce.clone(),
            },
            &viewer,
        )
        .await
        .unwrap();
        let (sender, _) = super::super::state::runtime_event_channel();
        let error = stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer,
                task_id: "task-1".into(),
                generation: "generation-1".into(),
                generation_order: 1,
                request_id: "request-1".into(),
                stream_nonce,
                observation_challenge: challenge,
                identity: viewer,
                incoming_sender: sender,
                inbound_decode_slots: Arc::new(Semaphore::new(
                    MAX_CONCURRENT_COMPANION_INBOUND_DECODES,
                )),
                inbound_decode_budget: Arc::new(CompanionInboundByteBudget::new(
                    MAX_COMPANION_INBOUND_DECODE_BYTES,
                )),
            },
            stream,
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains(&format!("exceeds {} bytes", MAX_COMPANION_FRAME_LINE_BYTES)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn idle_authenticated_streams_do_not_starve_a_ready_companion_frame() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let idle_remote_one = TcpStream::connect(endpoint).await.unwrap();
        let (idle_stream_one, _) = listener.accept().await.unwrap();
        let idle_remote_two = TcpStream::connect(endpoint).await.unwrap();
        let (idle_stream_two, _) = listener.accept().await.unwrap();
        let mut ready_remote = TcpStream::connect(endpoint).await.unwrap();
        let (ready_stream, _) = listener.accept().await.unwrap();

        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let stream_nonce = fresh_nonce();
        let observation_challenge = fresh_nonce();
        let sealed_payload = seal_owner_payload(
            &owner,
            &viewer.public_key,
            CompanionOwnerPayload {
                operation: "companion_frame".into(),
                request_id: "request-ready".into(),
                task_id: "task-ready".into(),
                generation: "generation-ready".into(),
                stream_nonce: stream_nonce.clone(),
                observation_challenge: observation_challenge.clone(),
                sequence: 1,
                frame: Some(ServerFrame::CompanionUnavailable {
                    task_id: "task-ready".into(),
                    attachment_epoch: None,
                }),
            },
        )
        .unwrap();
        let event_line =
            serde_json::to_string(&PeerCompanionEvent::Sealed { sealed_payload }).unwrap();
        assert!(event_line.len() <= MAX_COMPANION_FRAME_LINE_BYTES);
        ready_remote
            .write_all(format!("{event_line}\n").as_bytes())
            .await
            .unwrap();

        let owner_public_key = crate::crypto::public_key_to_string(&owner.public_key);
        let slots = Arc::new(Semaphore::new(2));
        let budget = Arc::new(CompanionInboundByteBudget::new(
            MAX_COMPANION_INBOUND_DECODE_BYTES,
        ));
        let (sender, mut receiver) = super::super::state::runtime_event_channel();
        let idle_peer_one = PeerRegistryEntry {
            peer_id: "peer-idle-one".into(),
            display_name: "Idle One".into(),
            endpoint: endpoint.to_string(),
            pid: std::process::id(),
            public_key: owner_public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        };
        let idle_peer_two = PeerRegistryEntry {
            peer_id: "peer-idle-two".into(),
            display_name: "Idle Two".into(),
            endpoint: endpoint.to_string(),
            pid: std::process::id(),
            public_key: owner_public_key.clone(),
            protocol_version: 1,
            accepting_transfers: true,
        };
        let ready_peer = PeerRegistryEntry {
            peer_id: "peer-ready".into(),
            display_name: "Ready".into(),
            endpoint: endpoint.to_string(),
            pid: std::process::id(),
            public_key: owner_public_key,
            protocol_version: 1,
            accepting_transfers: true,
        };
        let (idle_one_polled, idle_one_poll) = oneshot::channel();
        let (idle_two_polled, idle_two_poll) = oneshot::channel();

        let idle_one = tokio::spawn(stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer: idle_peer_one,
                task_id: "task-idle-one".into(),
                generation: "generation-idle-one".into(),
                generation_order: 1,
                request_id: "request-idle-one".into(),
                stream_nonce: fresh_nonce(),
                observation_challenge: fresh_nonce(),
                identity: viewer.clone(),
                incoming_sender: sender.clone(),
                inbound_decode_slots: Arc::clone(&slots),
                inbound_decode_budget: Arc::clone(&budget),
            },
            PollTrackingReader::new(BufReader::new(idle_stream_one), idle_one_polled),
        ));
        let idle_two = tokio::spawn(stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer: idle_peer_two,
                task_id: "task-idle-two".into(),
                generation: "generation-idle-two".into(),
                generation_order: 1,
                request_id: "request-idle-two".into(),
                stream_nonce: fresh_nonce(),
                observation_challenge: fresh_nonce(),
                identity: viewer.clone(),
                incoming_sender: sender.clone(),
                inbound_decode_slots: Arc::clone(&slots),
                inbound_decode_budget: Arc::clone(&budget),
            },
            PollTrackingReader::new(BufReader::new(idle_stream_two), idle_two_polled),
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            idle_one_poll
                .await
                .expect("first idle companion reader stopped before polling");
            idle_two_poll
                .await
                .expect("second idle companion reader stopped before polling");
        })
        .await
        .expect("idle companion readers were not polled");
        assert_eq!(budget.retained_bytes(), 0);
        assert_eq!(slots.available_permits(), 2);

        let ready = tokio::spawn(stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer: ready_peer,
                task_id: "task-ready".into(),
                generation: "generation-ready".into(),
                generation_order: 1,
                request_id: "request-ready".into(),
                stream_nonce,
                observation_challenge,
                identity: viewer,
                incoming_sender: sender,
                inbound_decode_slots: Arc::clone(&slots),
                inbound_decode_budget: Arc::clone(&budget),
            },
            BufReader::new(ready_stream),
        ));

        let event = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("ready companion frame was starved by idle streams")
            .expect("runtime event channel closed");
        assert!(matches!(
            event,
            RuntimeEvent::CompanionEvent {
                peer_id,
                task_id,
                frame: ServerFrame::CompanionUnavailable { .. },
                ..
            } if peer_id == "peer-ready" && task_id == "task-ready"
        ));

        idle_one.abort();
        idle_two.abort();
        ready.abort();
        drop((idle_remote_one, idle_remote_two, ready_remote));
    }

    #[tokio::test]
    async fn partial_companion_input_is_retained_within_the_shared_byte_bound() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let mut partial_remote = TcpStream::connect(endpoint).await.unwrap();
        let (partial_stream, _) = listener.accept().await.unwrap();
        let mut ready_remote = TcpStream::connect(endpoint).await.unwrap();
        let (ready_stream, _) = listener.accept().await.unwrap();

        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let stream_nonce = fresh_nonce();
        let observation_challenge = fresh_nonce();
        let sealed_payload = seal_owner_payload(
            &owner,
            &viewer.public_key,
            CompanionOwnerPayload {
                operation: "companion_frame".into(),
                request_id: "request-ready".into(),
                task_id: "task-ready".into(),
                generation: "generation-ready".into(),
                stream_nonce: stream_nonce.clone(),
                observation_challenge: observation_challenge.clone(),
                sequence: 1,
                frame: Some(ServerFrame::CompanionUnavailable {
                    task_id: "task-ready".into(),
                    attachment_epoch: None,
                }),
            },
        )
        .unwrap();
        let event_line =
            serde_json::to_string(&PeerCompanionEvent::Sealed { sealed_payload }).unwrap();
        let partial_bytes = vec![b'x'; 8 * 1024];
        let byte_limit = partial_bytes.len() + event_line.len();
        let owner_public_key = crate::crypto::public_key_to_string(&owner.public_key);
        let slots = Arc::new(Semaphore::new(2));
        let budget = Arc::new(CompanionInboundByteBudget::new(byte_limit));
        let (sender, mut receiver) = super::super::state::runtime_event_channel();

        let partial = tokio::spawn(stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer: PeerRegistryEntry {
                    peer_id: "peer-partial".into(),
                    display_name: "Partial".into(),
                    endpoint: endpoint.to_string(),
                    pid: std::process::id(),
                    public_key: owner_public_key.clone(),
                    protocol_version: 1,
                    accepting_transfers: true,
                },
                task_id: "task-partial".into(),
                generation: "generation-partial".into(),
                generation_order: 1,
                request_id: "request-partial".into(),
                stream_nonce: fresh_nonce(),
                observation_challenge: fresh_nonce(),
                identity: viewer.clone(),
                incoming_sender: sender.clone(),
                inbound_decode_slots: Arc::clone(&slots),
                inbound_decode_budget: Arc::clone(&budget),
            },
            BufReader::new(partial_stream),
        ));
        partial_remote.write_all(&partial_bytes).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while budget.retained_bytes() != partial_bytes.len() {
                assert!(budget.retained_bytes() <= byte_limit);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("partial companion input was not admitted incrementally");

        ready_remote
            .write_all(format!("{event_line}\n").as_bytes())
            .await
            .unwrap();
        let ready = tokio::spawn(stream_peer_companion(
            crate::runtime::companion::PeerCompanionStream {
                peer: PeerRegistryEntry {
                    peer_id: "peer-ready".into(),
                    display_name: "Ready".into(),
                    endpoint: endpoint.to_string(),
                    pid: std::process::id(),
                    public_key: owner_public_key,
                    protocol_version: 1,
                    accepting_transfers: true,
                },
                task_id: "task-ready".into(),
                generation: "generation-ready".into(),
                generation_order: 1,
                request_id: "request-ready".into(),
                stream_nonce,
                observation_challenge,
                identity: viewer,
                incoming_sender: sender,
                inbound_decode_slots: Arc::clone(&slots),
                inbound_decode_budget: Arc::clone(&budget),
            },
            BufReader::new(ready_stream),
        ));
        let event = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("ready frame was starved by partial companion input")
            .expect("runtime event channel closed");
        assert!(matches!(
            event,
            RuntimeEvent::CompanionEvent {
                peer_id,
                frame: ServerFrame::CompanionUnavailable { .. },
                ..
            } if peer_id == "peer-ready"
        ));
        assert!(budget.retained_bytes() <= byte_limit);

        partial.abort();
        ready.abort();
        let _ = partial.await;
        let _ = ready.await;
        assert_eq!(budget.retained_bytes(), 0);
    }

    #[tokio::test]
    async fn incremental_companion_line_preserves_utf8_newline_and_crlf_safety() {
        let budget = Arc::new(CompanionInboundByteBudget::new(64));
        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"valid\r\n").await.unwrap();
        let (line, permit) = read_bounded_companion_line(&mut BufReader::new(reader), &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(line, "valid");
        assert_eq!(budget.retained_bytes(), line.len());
        drop(permit);
        assert_eq!(budget.retained_bytes(), 0);

        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(&[0xff, b'\n']).await.unwrap();
        let error = read_bounded_companion_line(&mut BufReader::new(reader), &budget)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("not valid UTF-8"));
        assert!(!error.contains('\u{fffd}'));
        assert_eq!(budget.retained_bytes(), 0);

        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"secret-partial").await.unwrap();
        writer.shutdown().await.unwrap();
        let error = read_bounded_companion_line(&mut BufReader::new(reader), &budget)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("missing newline"));
        assert!(!error.contains("secret-partial"));
        assert_eq!(budget.retained_bytes(), 0);
    }

    #[test]
    fn incremental_companion_byte_budget_rejects_aggregate_overcommit_and_reclaims() {
        let budget = Arc::new(CompanionInboundByteBudget::new(10));
        let mut first = budget.try_reserve(7).expect("first input admitted");
        assert!(budget.try_reserve(4).is_none());
        assert!(!first.try_extend(4));
        assert_eq!(budget.retained_bytes(), 7);

        let second = budget.try_reserve(3).expect("remaining bytes admitted");
        assert_eq!(budget.retained_bytes(), 10);
        assert!(budget.try_reserve(1).is_none());

        drop((first, second));
        assert_eq!(budget.retained_bytes(), 0);
    }

    #[test]
    fn maximum_legal_companion_bundle_serializes_below_derived_frame_limit() {
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let raw_asset_bytes = MAX_COMPANION_ASSET_TOTAL_BYTES as usize / MAX_COMPANION_ASSET_COUNT;
        let asset_data =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; raw_asset_bytes]);
        let assets = (0..MAX_COMPANION_ASSET_COUNT)
            .map(|index| CompanionAsset {
                name: format!("{index:02}-{}", "n".repeat(250)),
                content_type: "application/octet-stream".into(),
                digest: "d".repeat(64),
                data_b64: asset_data.clone(),
            })
            .collect();
        let sealed = seal_owner_payload(
            &owner,
            &viewer.public_key,
            CompanionOwnerPayload {
                operation: "companion_frame".into(),
                request_id: "request-1".into(),
                task_id: "task-1".into(),
                generation: "generation-1".into(),
                stream_nonce: fresh_nonce(),
                observation_challenge: fresh_nonce(),
                sequence: 1,
                frame: Some(ServerFrame::CompanionSnapshot {
                    task_id: "task-1".into(),
                    session_id: "session-1".into(),
                    revision: "r".repeat(64),
                    document_kind: CompanionDocumentKind::FullDocument,
                    html: "\0".repeat(MAX_COMPANION_HTML_BYTES as usize),
                    source_origin: Some("http://127.0.0.1:65535".into()),
                    assets,
                    attachment_epoch: None,
                }),
            },
        )
        .unwrap();
        let wire = serde_json::to_vec(&PeerCompanionEvent::Sealed {
            sealed_payload: sealed,
        })
        .unwrap();
        assert!(
            wire.len() <= MAX_COMPANION_FRAME_LINE_BYTES,
            "legal maximum companion wire frame {} exceeded derived limit {}",
            wire.len(),
            MAX_COMPANION_FRAME_LINE_BYTES,
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn two_concurrent_maximum_inbound_frames_do_not_block_terminal_progress() {
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let payload = maximum_legal_owner_payload();
        let stream_nonce = payload.stream_nonce.clone();
        let observation_challenge = payload.observation_challenge.clone();
        let sealed = seal_owner_payload(&owner, &viewer.public_key, payload).unwrap();
        let event_line = serde_json::to_string(&PeerCompanionEvent::Sealed {
            sealed_payload: sealed,
        })
        .unwrap();
        assert!(event_line.len() <= MAX_COMPANION_FRAME_LINE_BYTES);

        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_COMPANION_INBOUND_DECODES));
        let budget = Arc::new(CompanionInboundByteBudget::new(
            event_line.len() * MAX_CONCURRENT_COMPANION_INBOUND_DECODES,
        ));
        let owner_public_key = crate::crypto::public_key_to_string(&owner.public_key);
        let mut decodes = Vec::new();
        for _ in 0..MAX_CONCURRENT_COMPANION_INBOUND_DECODES {
            let decode_slot = Arc::clone(&slots).acquire_owned().await.unwrap();
            let wire_permit = Arc::clone(&budget)
                .try_reserve(event_line.len())
                .expect("maximum inbound frame should fit the shared budget");
            decodes.push(tokio::spawn(decode_peer_companion_frame(
                event_line.clone(),
                "peer-max-admission".into(),
                owner_public_key.clone(),
                "task-1".into(),
                "generation-1".into(),
                "request-1".into(),
                stream_nonce.clone(),
                observation_challenge.clone(),
                1,
                viewer.clone(),
                decode_slot,
                wire_permit,
            )));
        }
        assert_eq!(slots.available_permits(), 0);
        assert_eq!(
            budget.retained_bytes(),
            event_line.len() * MAX_CONCURRENT_COMPANION_INBOUND_DECODES
        );

        // Let both decode futures enter their blocking workers before proving
        // the multiplexed reliable lane still advances on a single Tokio worker.
        tokio::task::yield_now().await;
        let (sender, mut receiver) = super::super::state::runtime_event_channel();
        sender
            .send(RuntimeEvent::TerminalEvent {
                peer_id: "peer-terminal".into(),
                session_id: "session-terminal".into(),
                observer_lease_id: "lease-test".into(),
                event: crate::protocol::PeerTerminalEvent::Output {
                    session_id: "session-terminal".into(),
                    data: b"responsive".to_vec(),
                },
            })
            .await
            .unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("terminal/control delivery stalled behind companion decoding");
        assert!(matches!(
            terminal,
            Some(RuntimeEvent::TerminalEvent {
                peer_id,
                session_id,
                ..
            }) if peer_id == "peer-terminal" && session_id == "session-terminal"
        ));

        for decode in decodes {
            let frame = tokio::time::timeout(Duration::from_secs(30), decode)
                .await
                .expect("maximum inbound companion decode timed out")
                .unwrap()
                .unwrap();
            assert!(matches!(frame, ServerFrame::CompanionSnapshot { .. }));
        }
        assert_eq!(budget.retained_bytes(), 0);
        assert_eq!(
            slots.available_permits(),
            MAX_CONCURRENT_COMPANION_INBOUND_DECODES
        );
    }

    #[test]
    fn two_maximum_legal_observers_share_the_aggregate_retention_budget() {
        let total = Arc::new(AtomicUsize::new(0));
        let mut first = OwnerCompanionRetention::new(Arc::clone(&total));
        let mut second = OwnerCompanionRetention::new(Arc::clone(&total));
        let mut third = OwnerCompanionRetention::new(Arc::clone(&total));
        let payload = maximum_legal_owner_payload();
        let frame_bytes = serde_json::to_vec(payload.frame.as_ref().unwrap())
            .unwrap()
            .len();

        assert!(first.replace(frame_bytes));
        assert!(second.replace(frame_bytes));
        assert!(!third.replace(frame_bytes));
        assert!(
            total.load(Ordering::Acquire) <= MAX_OWNER_COMPANION_RETENTION_BYTES,
            "multi-observer retention must remain within the aggregate budget"
        );
        drop(first);
        drop(second);
        assert_eq!(total.load(Ordering::Acquire), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn runtime_keeps_scheduling_while_actual_maximum_bundle_is_encrypted() {
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let payload = maximum_legal_owner_payload();
        let ticks = Arc::new(AtomicUsize::new(0));
        let ticking = Arc::clone(&ticks);
        let heartbeat = tokio::spawn(async move {
            loop {
                ticking.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        });

        let encrypted = tokio::task::spawn_blocking(move || {
            seal_owner_payload(&owner, &viewer.public_key, payload)
        })
        .await
        .unwrap()
        .unwrap();

        heartbeat.abort();
        assert!(!encrypted.is_empty());
        assert!(
            ticks.load(Ordering::Relaxed) > 0,
            "terminal/runtime scheduling must continue during maximum-bundle encryption"
        );
    }

    #[test]
    fn attacker_claiming_trusted_peer_cannot_open_companion_proof() {
        let owner = TransferIdentity::generate();
        let trusted = TransferIdentity::generate();
        let attacker = TransferIdentity::generate();
        let sealed = seal_json(
            &attacker,
            &owner.public_key,
            &json!({"operation": "observe_companion"}),
        )
        .unwrap();

        assert!(open_json(&owner, &trusted.public_key, &sealed).is_err());
    }

    #[test]
    fn captured_observe_and_send_proofs_are_each_rejected_on_replay() {
        let now = Instant::now();
        let mut nonces = std::collections::HashMap::new();
        for _ in 0..2 {
            let nonce = fresh_nonce();
            consume_companion_proof_nonce_at(&mut nonces, "peer-viewer", &nonce, 1_000, 1_000, now)
                .unwrap();
            let replay = consume_companion_proof_nonce_at(
                &mut nonces,
                "peer-viewer",
                &nonce,
                1_000,
                1_000,
                now,
            )
            .unwrap_err();
            assert!(replay.to_string().contains("already been used"));
        }
    }

    #[test]
    fn companion_proof_replay_cache_is_cardinality_bounded() {
        let now = Instant::now();
        let mut nonces = std::collections::HashMap::new();
        for _ in 0..MAX_COMPANION_PROOF_NONCES {
            let nonce = fresh_nonce();
            consume_companion_proof_nonce_at(&mut nonces, "peer-viewer", &nonce, 1_000, 1_000, now)
                .unwrap();
        }
        let error = consume_companion_proof_nonce_at(
            &mut nonces,
            "peer-viewer",
            &fresh_nonce(),
            1_000,
            1_000,
            now,
        )
        .unwrap_err();
        assert!(error.to_string().contains("replay cache is full"));
        assert_eq!(nonces.len(), MAX_COMPANION_PROOF_NONCES);
    }

    #[test]
    fn replay_cache_rejects_oversized_peer_ids_before_allocating() {
        let mut nonces = std::collections::HashMap::new();
        let error = consume_companion_proof_nonce_at(
            &mut nonces,
            &"p".repeat(MAX_COMPANION_PROOF_IDENTIFIER_BYTES + 1),
            &fresh_nonce(),
            1_000,
            1_000,
            Instant::now(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("requester peer identifier"));
        assert!(nonces.is_empty());
    }

    #[test]
    fn companion_wire_payloads_are_confidential_and_pinned_to_the_owner_key() {
        let owner = TransferIdentity::generate();
        let viewer = TransferIdentity::generate();
        let wrong_owner = TransferIdentity::generate();
        let forwarding_attacker = TransferIdentity::generate();
        let observation_challenge = fresh_nonce();
        let sealed_ack = seal_owner_payload(
            &owner,
            &viewer.public_key,
            CompanionOwnerPayload {
                operation: "observe_companion_ack".into(),
                request_id: "request-1".into(),
                task_id: "secret-task".into(),
                generation: "generation-1".into(),
                stream_nonce: "stream-1".into(),
                observation_challenge: observation_challenge.clone(),
                sequence: 0,
                frame: None,
            },
        )
        .unwrap();
        assert!(open_owner_payload(&viewer, &wrong_owner.public_key, &sealed_ack).is_err());
        assert!(open_owner_payload(&forwarding_attacker, &owner.public_key, &sealed_ack).is_err());
        assert!(validate_owner_payload(
            open_owner_payload(&viewer, &owner.public_key, &sealed_ack).unwrap(),
            "observe_companion_ack",
            "request-1",
            "secret-task",
            "generation-1",
            "stream-1",
            Some(&observation_challenge),
            0,
        )
        .is_ok());
        let frame = ServerFrame::CompanionSnapshot {
            task_id: "secret-task".into(),
            session_id: "secret-session".into(),
            revision: "secret-revision".into(),
            document_kind: CompanionDocumentKind::Fragment,
            html: "<h1>secret companion html</h1>".into(),
            source_origin: Some("http://localhost:52341".into()),
            assets: vec![],
            attachment_epoch: None,
        };
        let sealed = seal_owner_payload(
            &owner,
            &viewer.public_key,
            CompanionOwnerPayload {
                operation: "companion_frame".into(),
                request_id: "request-1".into(),
                task_id: "secret-task".into(),
                generation: "generation-1".into(),
                stream_nonce: "stream-1".into(),
                observation_challenge: observation_challenge.clone(),
                sequence: 1,
                frame: Some(frame.clone()),
            },
        )
        .unwrap();
        let wire = serde_json::to_string(&PeerCompanionEvent::Sealed {
            sealed_payload: sealed.clone(),
        })
        .unwrap();
        assert!(!wire.contains("secret companion html"));
        assert!(!wire.contains("secret-task"));
        assert!(open_owner_payload(&viewer, &wrong_owner.public_key, &sealed).is_err());
        assert!(open_owner_payload(&forwarding_attacker, &owner.public_key, &sealed).is_err());
        let opened = open_owner_payload(&viewer, &owner.public_key, &sealed).unwrap();
        assert_eq!(opened.frame, Some(frame));

        let mut tampered = sealed.into_bytes();
        let last = tampered.len() - 2;
        tampered[last] ^= 1;
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(open_owner_payload(&viewer, &owner.public_key, &tampered).is_err());
    }

    #[test]
    fn companion_frame_binding_rejects_replay_out_of_order_and_wrong_session() {
        let observation_challenge = fresh_nonce();
        let payload = |sequence, stream_nonce: &str, challenge: &str| CompanionOwnerPayload {
            operation: "companion_frame".into(),
            request_id: "request-1".into(),
            task_id: "task-1".into(),
            generation: "generation-1".into(),
            stream_nonce: stream_nonce.into(),
            observation_challenge: challenge.into(),
            sequence,
            frame: Some(ServerFrame::CompanionUnavailable {
                task_id: "task-1".into(),
                attachment_epoch: None,
            }),
        };
        assert!(validate_owner_payload(
            payload(1, "stream-1", &observation_challenge),
            "companion_frame",
            "request-1",
            "task-1",
            "generation-1",
            "stream-1",
            Some(&observation_challenge),
            1,
        )
        .is_ok());
        assert!(validate_owner_payload(
            payload(1, "stream-1", &observation_challenge),
            "companion_frame",
            "request-1",
            "task-1",
            "generation-1",
            "stream-1",
            Some(&observation_challenge),
            2,
        )
        .is_err());
        assert!(validate_owner_payload(
            payload(2, "forwarded-stream", &observation_challenge),
            "companion_frame",
            "request-1",
            "task-1",
            "generation-1",
            "stream-1",
            Some(&observation_challenge),
            2,
        )
        .is_err());
        assert!(validate_owner_payload(
            payload(2, "stream-1", &fresh_nonce()),
            "companion_frame",
            "request-1",
            "task-1",
            "generation-1",
            "stream-1",
            Some(&observation_challenge),
            2,
        )
        .is_err());
    }

    #[test]
    fn complete_observe_and_event_bodies_are_absent_from_outer_wire_requests() {
        let viewer = TransferIdentity::generate();
        let owner = TransferIdentity::generate();
        let (sealed_observe, _) = seal_observe_companion_proof(
            &viewer,
            &owner.public_key,
            "observe-request",
            "peer-viewer",
            "secret-task",
            "secret-generation",
        )
        .unwrap();
        let observe_wire = serde_json::to_string(&PeerRequest::ObserveCompanion {
            request_id: "observe-request".into(),
            requester_peer_id: "peer-viewer".into(),
            sealed_payload: sealed_observe,
        })
        .unwrap();
        assert!(!observe_wire.contains("secret-task"));
        assert!(!observe_wire.contains("secret-generation"));

        let event = CompanionEvent {
            session_id: "secret-session".into(),
            revision: "secret-revision".into(),
            event_id: "secret-event-id".into(),
            event_type: "click".into(),
            choice: "secret-choice".into(),
            text: "secret-text".into(),
            element_id: Some("secret-element".into()),
            timestamp: 42,
        };
        let sealed_payload = seal_send_companion_event_proof(
            &viewer,
            &owner.public_key,
            "request-1",
            "peer-viewer",
            "secret-task",
            "secret-session",
            "secret-revision",
            "generation-1",
            "stream-1",
            &fresh_nonce(),
            1,
            &event,
        )
        .unwrap();
        let wire = serde_json::to_string(&PeerRequest::SendCompanionEvent {
            request_id: "request-1".into(),
            requester_peer_id: "peer-viewer".into(),
            sealed_payload,
        })
        .unwrap();
        for secret in [
            "secret-event-id",
            "secret-choice",
            "secret-text",
            "secret-task",
            "secret-session",
            "secret-revision",
        ] {
            assert!(!wire.contains(secret));
        }
    }
}
