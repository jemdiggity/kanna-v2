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
const LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
const LEGACY_ARTIFACT_FIXED_MEMORY_ALLOWANCE_BYTES: u64 = 16 * 1024 * 1024;
const LEGACY_ARTIFACT_MEMORY_BYTES_PER_PLAINTEXT_BYTE: u64 = 10;
// A legacy response simultaneously materializes nested base64, JSON, encrypted,
// response-line, and decoded buffers. Reserve fixed framing/allocation headroom,
// then conservatively budget ten resident bytes per plaintext byte.
pub const MAX_LEGACY_TRANSFER_ARTIFACT_BYTES: u64 = (LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES
    - LEGACY_ARTIFACT_FIXED_MEMORY_ALLOWANCE_BYTES)
    / LEGACY_ARTIFACT_MEMORY_BYTES_PER_PLAINTEXT_BYTE;
const LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES: u64 = 1024 * 1024;
const LEGACY_ARTIFACT_RESPONSE_BYTES_PER_PLAINTEXT_BYTE: u64 = 2;
pub(super) const MAX_LEGACY_ARTIFACT_RESPONSE_BYTES: usize =
    (MAX_LEGACY_TRANSFER_ARTIFACT_BYTES * LEGACY_ARTIFACT_RESPONSE_BYTES_PER_PLAINTEXT_BYTE
        + LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES) as usize;
pub(super) const TRANSFER_ARTIFACT_CHUNK_BYTES: usize = 64 * 1024;
