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
pub(super) const TRANSFER_ARTIFACT_CHUNK_BYTES: usize = 64 * 1024;
