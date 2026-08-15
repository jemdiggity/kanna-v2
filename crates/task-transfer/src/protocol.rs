use kanna_agent_protocol::{CompanionEvent, ServerFrame};
use serde::{Deserialize, Serialize};

pub const CURRENT_PROTOCOL_VERSION: u32 = 4;
pub const COMPANION_PROTOCOL_VERSION: u32 = 2;

/// Maximum peer request line. Large repository/session artifacts are staged
/// out of band; inline requests carry bounded task metadata, prompts, and a
/// serialized terminal recovery snapshot.
pub const MAX_PEER_REQUEST_LINE_BYTES: usize = 8 * 1024 * 1024;
/// Companion control requests contain only sealed proofs and must remain
/// narrow before authentication to bound unauthenticated ingress memory.
pub const MAX_COMPANION_REQUEST_LINE_BYTES: usize = 64 * 1024;
/// Protocol-v1 transfer commits embedded terminal recovery directly in the
/// sealed submit envelope. Keep that legacy wire shape readable while newer
/// request kinds remain on the narrow unauthenticated ingress limit.
pub const MAX_LEGACY_SUBMIT_TRANSFER_LINE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    GetLocalIdentity {
        request_id: String,
    },
    ListPeers {
        request_id: String,
    },
    UpsertExternalPeer {
        request_id: String,
        peer: crate::runtime::ExternalPeer,
    },
    RemoveExternalPeer {
        request_id: String,
        peer_id: String,
    },
    ClearExternalPeers {
        request_id: String,
    },
    SetTaskSnapshot {
        request_id: String,
        snapshot: serde_json::Value,
    },
    ListPeerTaskSnapshots {
        request_id: String,
    },
    ObservePeerSession {
        request_id: String,
        target_peer_id: String,
        session_id: String,
        observer_lease_id: String,
    },
    ObservePeerCompanion {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        generation: String,
    },
    SendPeerCompanionEvent {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        session_id: String,
        revision: String,
        generation: String,
        event: CompanionEvent,
    },
    SendPeerSessionInput {
        request_id: String,
        target_peer_id: String,
        session_id: String,
        data: Vec<u8>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        submission_boundary: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        control_input: bool,
    },
    ResizePeerSession {
        request_id: String,
        target_peer_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
    },
    ClosePeerTask {
        request_id: String,
        target_peer_id: String,
        task_id: String,
    },
    AdvancePeerTaskStage {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_transition_revision: Option<String>,
    },
    ReadPeerTaskFile {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        path: String,
    },
    MarkPeerTaskRead {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        expected_activity_revision: i64,
    },
    UnobservePeerSession {
        request_id: String,
        target_peer_id: String,
        session_id: String,
        observer_lease_id: String,
    },
    UnobservePeerCompanion {
        request_id: String,
        target_peer_id: String,
        task_id: String,
        generation: String,
    },
    StartPairing {
        request_id: String,
        target_peer_id: String,
    },
    AcceptPairing {
        request_id: String,
        pairing_request_id: String,
        verification_code: String,
    },
    RejectPairing {
        request_id: String,
        pairing_request_id: String,
    },
    StageTransferArtifact {
        request_id: String,
        transfer_id: String,
        artifact_id: String,
        path: String,
        #[serde(default)]
        owned: bool,
    },
    FetchTransferArtifact {
        request_id: String,
        transfer_id: String,
        artifact_id: String,
    },
    PrepareTransferPreflight {
        request_id: String,
        source_task_id: String,
        target_peer_id: String,
        #[serde(default)]
        transport: crate::runtime::TransferTransport,
    },
    RequestTaskPull {
        request_id: String,
        target_peer_id: String,
        source_task_id: String,
        #[serde(default)]
        transport: crate::runtime::TransferTransport,
    },
    PrepareTransferCommit {
        request_id: String,
        transfer_id: String,
        payload: serde_json::Value,
    },
    /// Releases a preflight reservation that will never be committed.
    AbandonOutgoingTransfer {
        request_id: String,
        transfer_id: String,
    },
    FinalizeOutgoingTransfer {
        request_id: String,
        transfer_id: String,
    },
    CompleteOutgoingTransferFinalization {
        request_id: String,
        transfer_id: String,
        payload: Option<serde_json::Value>,
        finalized_cleanly: bool,
        error: Option<String>,
    },
    AcknowledgeImportCommitted {
        request_id: String,
        transfer_id: String,
        source_task_id: String,
        destination_local_task_id: String,
    },
    MarkIncomingEventRecorded {
        request_id: String,
        transfer_id: String,
    },
    MarkImportCommitApplied {
        request_id: String,
        transfer_id: String,
    },
    NackImportCommit {
        request_id: String,
        transfer_id: String,
    },
    MarkImportAckCompleted {
        request_id: String,
        transfer_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    GetLocalIdentity {
        request_id: String,
        peer_id: String,
        display_name: String,
        public_key: String,
        protocol_version: u16,
        accepting_transfers: bool,
    },
    ListPeers {
        request_id: String,
        peers: Vec<DiscoveredPeer>,
    },
    UpsertExternalPeer {
        request_id: String,
    },
    RemoveExternalPeer {
        request_id: String,
    },
    ClearExternalPeers {
        request_id: String,
    },
    SetTaskSnapshot {
        request_id: String,
    },
    ListPeerTaskSnapshots {
        request_id: String,
        snapshots: Vec<PeerTaskSnapshot>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        issues: Vec<PeerTaskSnapshotIssue>,
    },
    ObservePeerSession {
        request_id: String,
    },
    ObservePeerCompanion {
        request_id: String,
    },
    SendPeerCompanionEvent {
        request_id: String,
    },
    SendPeerSessionInput {
        request_id: String,
    },
    ResizePeerSession {
        request_id: String,
    },
    ClosePeerTask {
        request_id: String,
    },
    AdvancePeerTaskStage {
        request_id: String,
    },
    ReadPeerTaskFile {
        request_id: String,
        path: String,
        content: String,
    },
    MarkPeerTaskRead {
        request_id: String,
    },
    UnobservePeerSession {
        request_id: String,
    },
    UnobservePeerCompanion {
        request_id: String,
    },
    StartPairing {
        request_id: String,
        peer: DiscoveredPeer,
        verification_code: String,
    },
    AcceptPairing {
        request_id: String,
        pairing_request_id: String,
    },
    RejectPairing {
        request_id: String,
        pairing_request_id: String,
    },
    StageTransferArtifact {
        request_id: String,
        transfer_id: String,
        artifact_id: String,
    },
    FetchTransferArtifact {
        request_id: String,
        transfer_id: String,
        artifact_id: String,
        path: String,
    },
    PrepareTransferPreflight {
        request_id: String,
        transfer_id: String,
        source_peer_id: String,
        target_has_repo: bool,
    },
    RequestTaskPull {
        request_id: String,
        pull_request_id: String,
    },
    PrepareTransferCommit {
        request_id: String,
        transfer_id: String,
    },
    AbandonOutgoingTransfer {
        request_id: String,
        transfer_id: String,
    },
    FinalizeOutgoingTransfer {
        request_id: String,
        transfer_id: String,
        payload: serde_json::Value,
        finalized_cleanly: bool,
    },
    CompleteOutgoingTransferFinalization {
        request_id: String,
        transfer_id: String,
    },
    AcknowledgeImportCommitted {
        request_id: String,
        transfer_id: String,
    },
    MarkIncomingEventRecorded {
        request_id: String,
        transfer_id: String,
    },
    MarkImportCommitApplied {
        request_id: String,
        transfer_id: String,
    },
    NackImportCommit {
        request_id: String,
        transfer_id: String,
    },
    MarkImportAckCompleted {
        request_id: String,
        transfer_id: String,
    },
    Error {
        request_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalTransferIdentity {
    pub peer_id: String,
    pub display_name: String,
    pub public_key: String,
    pub protocol_version: u16,
    pub accepting_transfers: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerRequest {
    GetAuthenticatedRequestEpoch {
        request_id: String,
    },
    StartPairing {
        request_id: String,
        source_peer_id: String,
        source_display_name: String,
        source_public_key: String,
        capabilities_json: String,
    },
    PrepareTransfer {
        request_id: String,
        source_peer_id: String,
        sealed_payload: String,
    },
    RequestTaskPull {
        request_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    SubmitTransferPayload {
        request_id: String,
        transfer_id: String,
        sealed_payload: String,
    },
    /// Releases the destination-side reservation a preflight created for a
    /// transfer that will never be committed — the losing half of a duplicate
    /// push. Without it the source drops its own reservation while
    /// `incoming-reservations/<transfer_id>.json` sits on the destination until
    /// the TTL sweeper notices.
    AbandonTransfer {
        request_id: String,
        transfer_id: String,
        source_peer_id: String,
        sealed_payload: String,
    },
    FinalizeTransfer {
        request_id: String,
        transfer_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    FetchTransferArtifact {
        request_id: String,
        transfer_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    ImportCommitted {
        request_id: String,
        transfer_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    GetTaskSnapshot {
        request_id: String,
        requester_peer_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    ObserveSession {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    ObserveCompanion {
        request_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    SendCompanionEvent {
        request_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
    SendSessionInput {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
        data: Vec<u8>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        submission_boundary: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        control_input: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    ResizeSession {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    CloseTask {
        request_id: String,
        requester_peer_id: String,
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    AdvanceTaskStage {
        request_id: String,
        requester_peer_id: String,
        task_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_transition_revision: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    ReadTaskFile {
        request_id: String,
        requester_peer_id: String,
        task_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sealed_payload: Option<String>,
    },
    MarkTaskRead {
        request_id: String,
        requester_peer_id: String,
        sealed_payload: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerResponse {
    AuthenticatedRequestEpoch {
        request_id: String,
        epoch: String,
    },
    StartPairing {
        request_id: String,
        peer: PairingPeer,
        verification_code: String,
    },
    PrepareTransfer {
        request_id: String,
        transfer_id: String,
        source_peer_id: String,
        target_has_repo: bool,
    },
    RequestTaskPull {
        request_id: String,
    },
    SubmitTransferPayload {
        request_id: String,
        transfer_id: String,
    },
    AbandonTransfer {
        request_id: String,
        transfer_id: String,
    },
    FinalizeTransfer {
        request_id: String,
        transfer_id: String,
        sealed_payload: String,
    },
    FetchTransferArtifact {
        request_id: String,
        transfer_id: String,
        sealed_payload: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_header: Option<crate::crypto::SealedStreamHeader>,
    },
    ImportCommitted {
        request_id: String,
        transfer_id: String,
    },
    TaskSnapshot {
        request_id: String,
        peer_id: String,
        display_name: String,
        snapshot: serde_json::Value,
    },
    ObserveSession {
        request_id: String,
        session_id: String,
    },
    ObserveCompanion {
        request_id: String,
        sealed_payload: String,
    },
    SendCompanionEvent {
        request_id: String,
        sealed_payload: String,
    },
    SendSessionInput {
        request_id: String,
    },
    ResizeSession {
        request_id: String,
    },
    CloseTask {
        request_id: String,
    },
    AdvanceTaskStage {
        request_id: String,
    },
    ReadTaskFile {
        request_id: String,
        path: String,
        content: String,
    },
    MarkTaskRead {
        request_id: String,
    },
    Error {
        request_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerTerminalEvent {
    Snapshot {
        session_id: String,
        snapshot: serde_json::Value,
    },
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
        code: i32,
    },
    Error {
        session_id: String,
        message: String,
    },
}

/// Commands sent back to the owner over an authenticated terminal observation
/// stream. Protocol v4 makes that stream duplex so interactive input does not
/// pay for a new peer connection and authentication exchange per keystroke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerTerminalControl {
    Input {
        session_id: String,
        data: Vec<u8>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        submission_boundary: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        control_input: bool,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerCompanionEvent {
    Sealed { sealed_payload: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerRegistryEntry {
    pub peer_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub pid: u32,
    pub public_key: String,
    pub protocol_version: u32,
    pub accepting_transfers: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    pub peer_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub pid: u32,
    pub public_key: String,
    pub protocol_version: u32,
    pub accepting_transfers: bool,
    pub trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerTaskSnapshot {
    pub peer_id: String,
    pub display_name: String,
    pub snapshot: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerTaskSnapshotIssue {
    pub peer_id: String,
    pub display_name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerTaskSnapshotListing {
    pub snapshots: Vec<PeerTaskSnapshot>,
    pub issues: Vec<PeerTaskSnapshotIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingPeer {
    pub peer_id: String,
    pub display_name: String,
    pub public_key: String,
    pub capabilities_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidecarEvent {
    PairingStarted {
        peer_id: String,
        display_name: String,
        verification_code: String,
    },
    PairingRequested {
        request_id: String,
        peer_id: String,
        display_name: String,
        verification_code: String,
    },
    PairingCompleted {
        peer_id: String,
        display_name: String,
        verification_code: String,
    },
    IncomingTransferRequest {
        transfer_id: String,
        source_peer_id: String,
        source_task_id: String,
        source_name: Option<String>,
        payload: serde_json::Value,
    },
    TaskPullRequested {
        request_id: String,
        requester_peer_id: String,
        source_task_id: String,
    },
    OutgoingTransferCommitted {
        transfer_id: String,
        source_task_id: String,
        destination_local_task_id: String,
    },
    OutgoingTransferFinalizationRequested {
        transfer_id: String,
    },
    TerminalEvent {
        peer_id: String,
        session_id: String,
        observer_lease_id: String,
        event: PeerTerminalEvent,
    },
    CompanionEvent {
        peer_id: String,
        task_id: String,
        generation: String,
        generation_order: u64,
        frame: ServerFrame,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireMessage {
    ListPeers,
    PairingRequest {
        peer_id: String,
        display_name: String,
    },
    PairingAccept {
        peer_id: String,
        code: String,
        public_key: String,
    },
    PrepareTransfer {
        transfer_id: String,
        task_id: String,
        provider: String,
    },
    PrepareTransferOk {
        transfer_id: String,
        ready_token: String,
    },
    TransferChunk {
        transfer_id: String,
        seq: u64,
        payload_b64: String,
    },
    TransferCommit {
        transfer_id: String,
    },
    TransferAck {
        transfer_id: String,
    },
    Error {
        message: String,
    },
}
