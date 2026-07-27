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
// The deployed protocol-v2 contract is a whole-response 128 MiB artifact.
// Legacy framing nests its unpadded payload encoding inside encrypted JSON,
// padded ciphertext base64, a sealed envelope, and one outer JSON response.
// Derive every hard wire limit from that maximum valid encoding instead of a
// ratio estimate so the receiver can reject oversized fields before decoding.
const LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const LEGACY_ARTIFACT_FIXED_MEMORY_ALLOWANCE_BYTES: u64 = 1024 * 1024;
const LEGACY_ARTIFACT_METADATA_FIXED_ALLOWANCE_BYTES: u64 = 1024 * 1024;
const LEGACY_ARTIFACT_ENVELOPE_FIXED_ALLOWANCE_BYTES: u64 = 1024;
const LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES: u64 = 1024 * 1024;
const LEGACY_ARTIFACT_AEAD_TAG_BYTES: u64 = 16;

const fn unpadded_base64_len(decoded_bytes: u64) -> u64 {
    decoded_bytes / 3 * 4
        + match decoded_bytes % 3 {
            0 => 0,
            1 => 2,
            2 => 3,
            _ => unreachable!(),
        }
}

const fn padded_base64_len(decoded_bytes: u64) -> u64 {
    decoded_bytes.saturating_add(2) / 3 * 4
}

pub(super) const MAX_LEGACY_ARTIFACT_PAYLOAD_B64_BYTES: usize =
    unpadded_base64_len(MAX_LEGACY_TRANSFER_ARTIFACT_BYTES) as usize;
pub(super) const MAX_LEGACY_ARTIFACT_METADATA_BYTES: usize =
    (MAX_LEGACY_ARTIFACT_PAYLOAD_B64_BYTES as u64 + LEGACY_ARTIFACT_METADATA_FIXED_ALLOWANCE_BYTES)
        as usize;
pub(super) const MAX_LEGACY_ARTIFACT_CIPHERTEXT_BYTES: usize =
    MAX_LEGACY_ARTIFACT_METADATA_BYTES + LEGACY_ARTIFACT_AEAD_TAG_BYTES as usize;
pub(super) const MAX_LEGACY_ARTIFACT_CIPHERTEXT_B64_BYTES: usize =
    padded_base64_len(MAX_LEGACY_ARTIFACT_CIPHERTEXT_BYTES as u64) as usize;
pub(super) const MAX_LEGACY_ARTIFACT_SEALED_JSON_BYTES: usize =
    MAX_LEGACY_ARTIFACT_CIPHERTEXT_B64_BYTES
        + LEGACY_ARTIFACT_ENVELOPE_FIXED_ALLOWANCE_BYTES as usize;
pub(super) const MAX_LEGACY_ARTIFACT_RESPONSE_BYTES: usize =
    MAX_LEGACY_ARTIFACT_SEALED_JSON_BYTES + LEGACY_ARTIFACT_RESPONSE_FIXED_ALLOWANCE_BYTES as usize;
pub(super) const LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES: usize =
    (LEGACY_ARTIFACT_TOTAL_MEMORY_BUDGET_BYTES - LEGACY_ARTIFACT_FIXED_MEMORY_ALLOWANCE_BYTES)
        as usize;

const _: () = {
    assert!(MAX_LEGACY_ARTIFACT_RESPONSE_BYTES > MAX_LEGACY_ARTIFACT_CIPHERTEXT_B64_BYTES);
    let receiver_payload_peak = MAX_LEGACY_ARTIFACT_RESPONSE_BYTES
        + MAX_LEGACY_ARTIFACT_SEALED_JSON_BYTES
        + MAX_LEGACY_ARTIFACT_METADATA_BYTES
        + MAX_LEGACY_TRANSFER_ARTIFACT_BYTES as usize;
    assert!(receiver_payload_peak < LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES);
};

pub(super) fn ensure_legacy_artifact_allocation_capacity(
    capacities: &[usize],
    budget: usize,
) -> Result<(), RuntimeError> {
    let retained = legacy_artifact_retained_capacity(capacities)?;
    if retained > budget {
        return Err(RuntimeError::Protocol(format!(
            "legacy artifact retained allocations exceed the {budget}-byte memory budget",
        )));
    }
    Ok(())
}

pub(super) fn legacy_artifact_retained_capacity(
    capacities: &[usize],
) -> Result<usize, RuntimeError> {
    capacities.iter().try_fold(0usize, |total, capacity| {
        total.checked_add(*capacity).ok_or_else(|| {
            RuntimeError::Protocol("legacy artifact retained allocation size overflow".into())
        })
    })
}

pub(super) fn try_acquire_legacy_artifact_memory(
    permits: std::sync::Arc<tokio::sync::Semaphore>,
    operation: &str,
) -> Result<tokio::sync::OwnedSemaphorePermit, RuntimeError> {
    permits.try_acquire_owned().map_err(|_| {
        let message = if operation == "serialization" {
            "legacy artifact response materialization capacity is exhausted".to_owned()
        } else {
            format!("legacy artifact {operation} memory capacity is exhausted")
        };
        RuntimeError::Backpressure(message)
    })
}

pub(super) const TRANSFER_ARTIFACT_CHUNK_BYTES: usize = 64 * 1024;
