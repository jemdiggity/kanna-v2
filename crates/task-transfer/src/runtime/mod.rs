mod config;
mod daemon;
mod discovery;
mod events;
mod external_peers;
mod lifecycle;
mod listener;
mod pairing;
mod peer;
mod pull;
mod replay_store;
mod state;
mod transfers;
mod utils;

#[cfg(test)]
mod tests;

pub use config::{DiscoveryMode, RuntimeConfig};
pub use events::{
    FinalizedOutgoingTransfer, IncomingTransferEvent, OutgoingTransferCommittedEvent,
    OutgoingTransferFinalizationRequestedEvent, PairingCompletedEvent, PairingRequestedEvent,
    PairingResult, PairingStartedEvent, PreflightResult, RuntimeError, RuntimeEvent,
    TaskPullRequestedEvent,
};
pub use external_peers::{ExternalPeer, PeerRoutes, TransferTransport};
pub use state::{StagedTransferArtifact, TransferRuntime};

pub const MAX_TRANSFER_ARTIFACT_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_LEGACY_TRANSFER_ARTIFACT_BYTES: u64 = MAX_TRANSFER_ARTIFACT_BYTES;
// The deployed protocol-v2 contract is a whole-response 128 MiB artifact. A
// strict borrowed parser keeps its response line, decoded ciphertext,
// decrypted JSON, and decoded payload below this aggregate receiver budget.
const LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES: u64 = 1024 * 1024;
const LEGACY_ARTIFACT_RESPONSE_BYTES_PER_PLAINTEXT_BYTE: u64 = 2;
pub(super) const MAX_LEGACY_ARTIFACT_RESPONSE_BYTES: usize = {
    let response_bytes = MAX_LEGACY_TRANSFER_ARTIFACT_BYTES
        * LEGACY_ARTIFACT_RESPONSE_BYTES_PER_PLAINTEXT_BYTE
        + LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES;
    // The response line and its JSON-unescaped sealed envelope coexist. While
    // opening the envelope, decoded ciphertext and decrypted metadata coexist
    // too. Once opening returns, ciphertext has been released before the final
    // artifact decode. Both bounded peaks must fit the aggregate budget.
    let encrypted_metadata_bytes = response_bytes.div_ceil(4) * 3;
    let envelope_open_peak = response_bytes * 2 + encrypted_metadata_bytes * 2;
    let payload_decode_peak =
        response_bytes * 2 + encrypted_metadata_bytes + MAX_LEGACY_TRANSFER_ARTIFACT_BYTES;
    assert!(envelope_open_peak < LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES);
    assert!(payload_decode_peak < LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES);
    response_bytes as usize
};
pub(super) const TRANSFER_ARTIFACT_CHUNK_BYTES: usize = 64 * 1024;
