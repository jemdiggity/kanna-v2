use serde::{Deserialize, Serialize};

/// Keep duplex terminal input controls below the receiver's bounded command
/// size. Larger writes (notably xterm paste payloads) are split in FIFO order.
pub const MAX_DUPLEX_TERMINAL_INPUT_BYTES: usize = 4 * 1024;

pub const CURRENT_PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    ListPeers {
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
    },
    SendPeerSessionInput {
        request_id: String,
        target_peer_id: String,
        session_id: String,
        data: Vec<u8>,
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
    },
    UnobservePeerSession {
        request_id: String,
        target_peer_id: String,
        session_id: String,
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
    },
    PrepareTransferCommit {
        request_id: String,
        transfer_id: String,
        payload: serde_json::Value,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    ListPeers {
        request_id: String,
        peers: Vec<DiscoveredPeer>,
    },
    SetTaskSnapshot {
        request_id: String,
    },
    ListPeerTaskSnapshots {
        request_id: String,
        snapshots: Vec<PeerTaskSnapshot>,
    },
    ObservePeerSession {
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
    UnobservePeerSession {
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
    PrepareTransferCommit {
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
    Error {
        request_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerRequest {
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
    SubmitTransferPayload {
        request_id: String,
        transfer_id: String,
        sealed_payload: String,
    },
    FinalizeTransfer {
        request_id: String,
        transfer_id: String,
        requester_peer_id: String,
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
    },
    ObserveSession {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
    },
    SendSessionInput {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
        data: Vec<u8>,
    },
    ResizeSession {
        request_id: String,
        requester_peer_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
    },
    CloseTask {
        request_id: String,
        requester_peer_id: String,
        task_id: String,
    },
    AdvanceTaskStage {
        request_id: String,
        requester_peer_id: String,
        task_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerResponse {
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
    SubmitTransferPayload {
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
/// stream. Release protocol v2 makes that stream duplex so interactive input
/// does not pay for a new peer connection and trust check per keystroke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PeerTerminalControl {
    Input {
        session_id: String,
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
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
pub struct PairingPeer {
    pub peer_id: String,
    pub display_name: String,
    pub public_key: String,
    pub capabilities_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
        event: PeerTerminalEvent,
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
