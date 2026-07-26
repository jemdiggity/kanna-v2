use super::events::{IncomingTransferEvent, RuntimeError};
use super::state::{
    AuthenticatedPeerRequestReplay, ImportCommitReceipt, IncomingTransferReservation,
    OutgoingTransferReservation,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredOutgoingTransferReservation {
    transfer_id: String,
    target_peer_id: String,
    source_task_id: String,
    #[serde(default)]
    target_peer: Option<crate::protocol::PeerRegistryEntry>,
    #[serde(default)]
    transport: Option<super::external_peers::TransferTransport>,
    created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredImportCommitReceipt {
    transfer_id: String,
    target_peer_id: String,
    #[serde(default)]
    target_peer: Option<crate::protocol::PeerRegistryEntry>,
    #[serde(default)]
    transport: Option<super::external_peers::TransferTransport>,
    source_task_id: String,
    destination_local_task_id: String,
    created_at_unix_ms: u64,
    applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredIncomingTransferReservation {
    transfer_id: String,
    source_peer_id: String,
    source_task_id: String,
    created_at_unix_ms: u64,
    committed: bool,
    #[serde(default)]
    event: Option<IncomingTransferEvent>,
    #[serde(default)]
    event_recorded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAuthenticatedPeerRequest {
    replay_key: String,
    expires_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
pub(super) struct TransferReplayStore {
    root: PathBuf,
    ttl: Duration,
    applied_receipt_ttl: Duration,
    max_unapplied_receipts: usize,
    max_applied_receipts: usize,
    max_incoming_reservations: usize,
}

impl TransferReplayStore {
    pub(super) fn new(
        registry_root: &Path,
        self_peer_id: &str,
        ttl: Duration,
        applied_receipt_ttl: Duration,
        max_unapplied_receipts: usize,
        max_applied_receipts: usize,
        max_incoming_reservations: usize,
    ) -> Self {
        Self {
            root: registry_root
                .join("transfer-replay")
                .join(URL_SAFE_NO_PAD.encode(self_peer_id)),
            ttl,
            applied_receipt_ttl,
            max_unapplied_receipts,
            max_applied_receipts,
            max_incoming_reservations,
        }
    }

    pub(super) fn load_outgoing_reservations(
        &self,
    ) -> Result<HashMap<String, OutgoingTransferReservation>, RuntimeError> {
        let now_ms = unix_ms();
        let now = Instant::now();
        let mut loaded = HashMap::new();
        for (path, stored) in
            self.load_records::<StoredOutgoingTransferReservation>(&self.root.join("reservations"))?
        {
            if self.is_expired(stored.created_at_unix_ms, now_ms)
                || path != self.reservation_path(&stored.transfer_id)
            {
                self.remove_record(&path);
                continue;
            }
            let age = Duration::from_millis(now_ms.saturating_sub(stored.created_at_unix_ms));
            loaded.insert(
                stored.transfer_id,
                OutgoingTransferReservation {
                    target_peer_id: stored.target_peer_id,
                    source_task_id: stored.source_task_id,
                    target_peer: stored.target_peer,
                    transport: stored.transport,
                    created_at: now.checked_sub(age).unwrap_or(now),
                },
            );
        }
        Ok(loaded)
    }

    pub(super) fn load_incoming_reservations(
        &self,
    ) -> Result<HashMap<String, IncomingTransferReservation>, RuntimeError> {
        let now_ms = unix_ms();
        let mut loaded = HashMap::new();
        for (path, stored) in self.load_records::<StoredIncomingTransferReservation>(
            &self.root.join("incoming-reservations"),
        )? {
            if path != self.incoming_reservation_path(&stored.transfer_id) {
                self.remove_record(&path);
                continue;
            }
            if !stored.committed && self.is_expired(stored.created_at_unix_ms, now_ms) {
                self.remove_record(&path);
                continue;
            }
            loaded.insert(
                stored.transfer_id,
                IncomingTransferReservation {
                    source_peer_id: stored.source_peer_id,
                    source_task_id: stored.source_task_id,
                    created_at_unix_ms: stored.created_at_unix_ms,
                    committed: stored.committed,
                    event: stored.event,
                    event_recorded: stored.event_recorded,
                },
            );
        }
        Ok(loaded)
    }

    pub(super) fn load_receipts(
        &self,
    ) -> Result<HashMap<String, ImportCommitReceipt>, RuntimeError> {
        let now_ms = unix_ms();
        let mut loaded = HashMap::new();
        let mut applied = Vec::new();
        let mut unapplied_count = 0usize;
        for (path, stored) in
            self.load_records::<StoredImportCommitReceipt>(&self.root.join("receipts"))?
        {
            if path != self.receipt_path(&stored.transfer_id) {
                self.remove_record(&path);
                continue;
            }
            if stored.applied {
                if now_ms.saturating_sub(stored.created_at_unix_ms)
                    >= self.applied_receipt_ttl.as_millis() as u64
                {
                    self.remove_record(&path);
                    continue;
                }
                applied.push((path, stored));
            } else {
                unapplied_count += 1;
                loaded.insert(stored.transfer_id.clone(), stored.into());
            }
        }
        if unapplied_count > self.max_unapplied_receipts {
            return Err(RuntimeError::InvalidConfig(format!(
                "replay store contains {unapplied_count} unapplied receipts, exceeding configured maximum {}",
                self.max_unapplied_receipts
            )));
        }
        applied.sort_by_key(|(_, receipt)| std::cmp::Reverse(receipt.created_at_unix_ms));
        for (index, (path, stored)) in applied.into_iter().enumerate() {
            if index >= self.max_applied_receipts {
                self.remove_record(&path);
            } else {
                loaded.insert(stored.transfer_id.clone(), stored.into());
            }
        }
        Ok(loaded)
    }

    pub(super) fn load_authenticated_peer_requests(
        &self,
    ) -> Result<HashMap<String, AuthenticatedPeerRequestReplay>, RuntimeError> {
        let now_ms = unix_ms();
        let mut loaded = HashMap::new();
        for (path, stored) in self.load_records::<StoredAuthenticatedPeerRequest>(
            &self.root.join("authenticated-peer-requests"),
        )? {
            if path != self.authenticated_peer_request_path(&stored.replay_key)
                || stored.expires_at_unix_ms < now_ms
            {
                self.remove_record(&path);
                continue;
            }
            loaded.insert(
                stored.replay_key,
                AuthenticatedPeerRequestReplay {
                    expires_at_unix_ms: stored.expires_at_unix_ms,
                    durable: true,
                },
            );
        }
        Ok(loaded)
    }

    pub(super) fn save_authenticated_peer_request(
        &self,
        replay_key: &str,
        expires_at_unix_ms: u64,
    ) -> Result<(), RuntimeError> {
        self.write_atomic(
            &self.authenticated_peer_request_path(replay_key),
            &StoredAuthenticatedPeerRequest {
                replay_key: replay_key.to_owned(),
                expires_at_unix_ms,
            },
        )
    }

    pub(super) fn remove_authenticated_peer_request(&self, replay_key: &str) {
        self.remove_record(&self.authenticated_peer_request_path(replay_key));
    }

    pub(super) fn save_reservation(
        &self,
        transfer_id: &str,
        reservation: &OutgoingTransferReservation,
    ) -> Result<(), RuntimeError> {
        let stored = StoredOutgoingTransferReservation {
            transfer_id: transfer_id.to_owned(),
            target_peer_id: reservation.target_peer_id.clone(),
            source_task_id: reservation.source_task_id.clone(),
            target_peer: reservation.target_peer.clone(),
            transport: reservation.transport,
            created_at_unix_ms: unix_ms(),
        };
        self.write_atomic(&self.reservation_path(transfer_id), &stored)
    }

    pub(super) fn remove_reservation(&self, transfer_id: &str) {
        self.remove_record(&self.reservation_path(transfer_id));
    }

    pub(super) fn save_incoming_reservation(
        &self,
        transfer_id: &str,
        reservation: &IncomingTransferReservation,
    ) -> Result<(), RuntimeError> {
        self.write_atomic(
            &self.incoming_reservation_path(transfer_id),
            &StoredIncomingTransferReservation {
                transfer_id: transfer_id.to_owned(),
                source_peer_id: reservation.source_peer_id.clone(),
                source_task_id: reservation.source_task_id.clone(),
                created_at_unix_ms: reservation.created_at_unix_ms,
                committed: reservation.committed,
                event: reservation.event.clone(),
                event_recorded: reservation.event_recorded,
            },
        )
    }

    pub(super) fn remove_incoming_reservation(&self, transfer_id: &str) {
        self.remove_record(&self.incoming_reservation_path(transfer_id));
    }

    pub(super) fn max_incoming_reservations(&self) -> usize {
        self.max_incoming_reservations
    }

    pub(super) fn prune_incoming_reservations(
        &self,
        reservations: &mut HashMap<String, IncomingTransferReservation>,
    ) {
        let now_ms = unix_ms();
        let remove = reservations
            .iter()
            .filter(|(_, reservation)| {
                !reservation.committed
                    && now_ms.saturating_sub(reservation.created_at_unix_ms)
                        >= self.ttl.as_millis() as u64
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for transfer_id in remove {
            reservations.remove(&transfer_id);
            self.remove_incoming_reservation(&transfer_id);
        }
    }

    pub(super) fn save_receipt(
        &self,
        transfer_id: &str,
        receipt: &ImportCommitReceipt,
    ) -> Result<(), RuntimeError> {
        let stored = StoredImportCommitReceipt {
            transfer_id: transfer_id.to_owned(),
            target_peer_id: receipt.target_peer_id.clone(),
            target_peer: receipt.target_peer.clone(),
            transport: receipt.transport,
            source_task_id: receipt.source_task_id.clone(),
            destination_local_task_id: receipt.destination_local_task_id.clone(),
            created_at_unix_ms: receipt.created_at_unix_ms,
            applied: receipt.applied,
        };
        self.write_atomic(&self.receipt_path(transfer_id), &stored)
    }

    pub(super) fn max_unapplied_receipts(&self) -> usize {
        self.max_unapplied_receipts
    }

    pub(super) fn compact_receipts(&self, receipts: &mut HashMap<String, ImportCommitReceipt>) {
        let now_ms = unix_ms();
        let mut applied = receipts
            .iter()
            .filter(|(_, receipt)| receipt.applied)
            .map(|(id, receipt)| (id.clone(), receipt.created_at_unix_ms))
            .collect::<Vec<_>>();
        applied.sort_by_key(|(_, created)| std::cmp::Reverse(*created));
        for (index, (transfer_id, created_at)) in applied.into_iter().enumerate() {
            if index >= self.max_applied_receipts
                || now_ms.saturating_sub(created_at) >= self.applied_receipt_ttl.as_millis() as u64
            {
                receipts.remove(&transfer_id);
                self.remove_record(&self.receipt_path(&transfer_id));
            }
        }
    }

    fn load_records<T: DeserializeOwned>(
        &self,
        directory: &Path,
    ) -> Result<Vec<(PathBuf, T)>, RuntimeError> {
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                if path.extension().and_then(|extension| extension.to_str()) == Some("tmp") {
                    self.remove_record(&path);
                }
                continue;
            }
            match fs::read(&path)
                .ok()
                .and_then(|payload| serde_json::from_slice(&payload).ok())
            {
                Some(record) => records.push((path, record)),
                None => {
                    self.remove_record(&path);
                }
            }
        }
        Ok(records)
    }

    fn write_atomic<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), RuntimeError> {
        let parent = path
            .parent()
            .ok_or_else(|| RuntimeError::InvalidConfig("replay path has no parent".into()))?;
        fs::create_dir_all(parent)?;
        let payload = serde_json::to_vec_pretty(value)?;
        let temp = parent.join(format!(
            ".{}.{}.{}.tmp",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("transfer-replay"),
            process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> Result<(), RuntimeError> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&payload)?;
            file.sync_all()?;
            fs::rename(&temp, path)?;
            fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }

    fn reservation_path(&self, transfer_id: &str) -> PathBuf {
        self.root
            .join("reservations")
            .join(format!("{}.json", transfer_key(transfer_id)))
    }

    fn receipt_path(&self, transfer_id: &str) -> PathBuf {
        self.root
            .join("receipts")
            .join(format!("{}.json", transfer_key(transfer_id)))
    }

    fn incoming_reservation_path(&self, transfer_id: &str) -> PathBuf {
        self.root
            .join("incoming-reservations")
            .join(format!("{}.json", transfer_key(transfer_id)))
    }

    fn authenticated_peer_request_path(&self, replay_key: &str) -> PathBuf {
        self.root
            .join("authenticated-peer-requests")
            .join(format!("{}.json", transfer_key(replay_key)))
    }

    fn remove_record(&self, path: &Path) {
        if fs::remove_file(path).is_ok() {
            if let Some(parent) = path.parent() {
                let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
            }
        }
    }

    fn is_expired(&self, created_at_ms: u64, now_ms: u64) -> bool {
        now_ms.saturating_sub(created_at_ms) >= self.ttl.as_millis() as u64
    }
}

impl From<StoredImportCommitReceipt> for ImportCommitReceipt {
    fn from(stored: StoredImportCommitReceipt) -> Self {
        Self {
            target_peer_id: stored.target_peer_id,
            target_peer: stored.target_peer,
            transport: stored.transport,
            source_task_id: stored.source_task_id,
            destination_local_task_id: stored.destination_local_task_id,
            created_at_unix_ms: stored.created_at_unix_ms,
            applied: stored.applied,
            event_queued: false,
            delivery_in_flight: false,
        }
    }
}

pub(super) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn transfer_key(transfer_id: &str) -> String {
    let digest = Sha256::digest(transfer_id.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod restart_tests {
    use super::{ImportCommitReceipt, StoredImportCommitReceipt};

    #[test]
    fn persisted_unapplied_receipt_requeues_after_runtime_restart() {
        let mut receipt = ImportCommitReceipt::from(StoredImportCommitReceipt {
            transfer_id: "transfer-1".into(),
            target_peer_id: "peer-target".into(),
            target_peer: None,
            transport: None,
            source_task_id: "task-source".into(),
            destination_local_task_id: "task-local".into(),
            created_at_unix_ms: 1,
            applied: false,
        });
        assert!(!receipt.event_queued);
        assert!(!receipt.delivery_in_flight);

        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        receipt
            .try_queue_event("transfer-1", &sender)
            .expect("restarted receipt should be queueable");

        assert!(receipt.event_queued);
        let event = receiver
            .try_recv()
            .expect("restarted receipt should be delivered again");
        assert_eq!(event.transfer_id, "transfer-1");
        assert_eq!(event.source_task_id, "task-source");
        assert_eq!(event.destination_local_task_id, "task-local");
    }
}
