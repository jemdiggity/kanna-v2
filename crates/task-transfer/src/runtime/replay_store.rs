use super::events::RuntimeError;
use super::state::{ImportCommitReceipt, IncomingTransferReservation, OutgoingTransferReservation};
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
    created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredImportCommitReceipt {
    transfer_id: String,
    target_peer_id: String,
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
    committed_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub(super) struct TransferReplayStore {
    root: PathBuf,
    ttl: Duration,
    applied_receipt_ttl: Duration,
    max_unapplied_receipts: usize,
    max_applied_receipts: usize,
    committed_incoming_ttl: Duration,
    max_active_incoming_reservations: usize,
    max_committed_incoming_reservations: usize,
}

impl TransferReplayStore {
    pub(super) fn new(
        registry_root: &Path,
        self_peer_id: &str,
        ttl: Duration,
        applied_receipt_ttl: Duration,
        max_unapplied_receipts: usize,
        max_applied_receipts: usize,
        committed_incoming_ttl: Duration,
        max_active_incoming_reservations: usize,
        max_committed_incoming_reservations: usize,
    ) -> Self {
        Self {
            root: registry_root
                .join("transfer-replay")
                .join(URL_SAFE_NO_PAD.encode(self_peer_id)),
            ttl,
            applied_receipt_ttl,
            max_unapplied_receipts,
            max_applied_receipts,
            committed_incoming_ttl,
            max_active_incoming_reservations,
            max_committed_incoming_reservations,
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
        let mut committed = Vec::new();
        let mut active_count = 0usize;
        for (path, stored) in self.load_records::<StoredIncomingTransferReservation>(
            &self.root.join("incoming-reservations"),
        )? {
            if path != self.incoming_reservation_path(&stored.transfer_id) {
                self.remove_record(&path);
                continue;
            }
            let committed_at = stored
                .committed_at_unix_ms
                .unwrap_or(stored.created_at_unix_ms);
            if (!stored.committed && self.is_expired(stored.created_at_unix_ms, now_ms))
                || (stored.committed
                    && now_ms.saturating_sub(committed_at)
                        >= self.committed_incoming_ttl.as_millis() as u64)
            {
                self.remove_record(&path);
                continue;
            }
            if stored.committed {
                committed.push((path, stored, committed_at));
                continue;
            }
            active_count += 1;
            loaded.insert(
                stored.transfer_id,
                IncomingTransferReservation {
                    source_peer_id: stored.source_peer_id,
                    source_task_id: stored.source_task_id,
                    created_at_unix_ms: stored.created_at_unix_ms,
                    committed: stored.committed,
                    committed_at_unix_ms: stored.committed_at_unix_ms,
                },
            );
        }
        if active_count > self.max_active_incoming_reservations {
            return Err(RuntimeError::InvalidConfig(format!(
                "replay store contains {active_count} active incoming reservations, exceeding configured maximum {}",
                self.max_active_incoming_reservations
            )));
        }
        committed.sort_by_key(|(_, _, committed_at)| std::cmp::Reverse(*committed_at));
        for (index, (path, stored, _)) in committed.into_iter().enumerate() {
            if index >= self.max_committed_incoming_reservations {
                self.remove_record(&path);
                continue;
            }
            loaded.insert(
                stored.transfer_id,
                IncomingTransferReservation {
                    source_peer_id: stored.source_peer_id,
                    source_task_id: stored.source_task_id,
                    created_at_unix_ms: stored.created_at_unix_ms,
                    committed: true,
                    committed_at_unix_ms: stored.committed_at_unix_ms,
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

    pub(super) fn save_reservation(
        &self,
        transfer_id: &str,
        reservation: &OutgoingTransferReservation,
    ) -> Result<(), RuntimeError> {
        let stored = StoredOutgoingTransferReservation {
            transfer_id: transfer_id.to_owned(),
            target_peer_id: reservation.target_peer_id.clone(),
            source_task_id: reservation.source_task_id.clone(),
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
                committed_at_unix_ms: reservation.committed_at_unix_ms,
            },
        )
    }

    pub(super) fn remove_incoming_reservation(&self, transfer_id: &str) {
        self.remove_record(&self.incoming_reservation_path(transfer_id));
    }

    pub(super) fn max_active_incoming_reservations(&self) -> usize {
        self.max_active_incoming_reservations
    }

    pub(super) fn prune_incoming_reservations(
        &self,
        reservations: &mut HashMap<String, IncomingTransferReservation>,
        protected_transfer_id: Option<&str>,
    ) {
        let now_ms = unix_ms();
        let mut remove = reservations
            .iter()
            .filter(|(_, reservation)| {
                if reservation.committed {
                    now_ms.saturating_sub(
                        reservation
                            .committed_at_unix_ms
                            .unwrap_or(reservation.created_at_unix_ms),
                    ) >= self.committed_incoming_ttl.as_millis() as u64
                } else {
                    now_ms.saturating_sub(reservation.created_at_unix_ms)
                        >= self.ttl.as_millis() as u64
                }
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut committed = reservations
            .iter()
            .filter(|(id, reservation)| {
                reservation.committed
                    && protected_transfer_id.is_none_or(|protected| protected != id.as_str())
                    && !remove.contains(id)
            })
            .map(|(id, reservation)| {
                (
                    id.clone(),
                    reservation
                        .committed_at_unix_ms
                        .unwrap_or(reservation.created_at_unix_ms),
                )
            })
            .collect::<Vec<_>>();
        committed.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        let protected_count = usize::from(
            protected_transfer_id
                .and_then(|id| reservations.get(id))
                .is_some_and(|reservation| reservation.committed),
        );
        let allowed = self
            .max_committed_incoming_reservations
            .saturating_sub(protected_count);
        remove.extend(committed.into_iter().skip(allowed).map(|(id, _)| id));
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
            source_task_id: stored.source_task_id,
            destination_local_task_id: stored.destination_local_task_id,
            created_at_unix_ms: stored.created_at_unix_ms,
            applied: stored.applied,
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
