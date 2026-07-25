use super::events::RuntimeError;
use super::state::{ImportCommitReceipt, OutgoingTransferReservation};
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

#[derive(Debug, Clone)]
pub(super) struct TransferReplayStore {
    root: PathBuf,
    ttl: Duration,
}

impl TransferReplayStore {
    pub(super) fn new(registry_root: &Path, self_peer_id: &str, ttl: Duration) -> Self {
        Self {
            root: registry_root
                .join("transfer-replay")
                .join(URL_SAFE_NO_PAD.encode(self_peer_id)),
            ttl,
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
                let _ = fs::remove_file(path);
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

    pub(super) fn load_receipts(
        &self,
    ) -> Result<HashMap<String, ImportCommitReceipt>, RuntimeError> {
        let mut loaded = HashMap::new();
        for (path, stored) in
            self.load_records::<StoredImportCommitReceipt>(&self.root.join("receipts"))?
        {
            // Receipts are durable protocol history, not pending reservations:
            // unapplied entries must replay and applied entries remain idempotency tombstones.
            if path != self.receipt_path(&stored.transfer_id) {
                let _ = fs::remove_file(path);
                continue;
            }
            loaded.insert(
                stored.transfer_id,
                ImportCommitReceipt {
                    target_peer_id: stored.target_peer_id,
                    source_task_id: stored.source_task_id,
                    destination_local_task_id: stored.destination_local_task_id,
                    created_at_unix_ms: stored.created_at_unix_ms,
                    applied: stored.applied,
                },
            );
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
        let _ = fs::remove_file(self.reservation_path(transfer_id));
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
                continue;
            }
            match fs::read(&path)
                .ok()
                .and_then(|payload| serde_json::from_slice(&payload).ok())
            {
                Some(record) => records.push((path, record)),
                None => {
                    let _ = fs::remove_file(path);
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

    fn is_expired(&self, created_at_ms: u64, now_ms: u64) -> bool {
        now_ms.saturating_sub(created_at_ms) >= self.ttl.as_millis() as u64
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
