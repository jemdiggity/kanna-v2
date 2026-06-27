use super::events::RuntimeError;
use super::state::{TransferArtifactRecord, TransferRuntime};
use super::utils::{
    ensure_peer_is_trusted_for, parse_peer_response_line, peer_store, prune_transfer_artifacts,
    sanitize_artifact_filename, write_json_line,
};
use crate::peer_store::PeerRecord;
use crate::protocol::DiscoveredPeer;
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;

impl TransferRuntime {
    pub(super) async fn find_peer(
        &self,
        target_peer_id: &str,
    ) -> Result<PeerRegistryEntry, RuntimeError> {
        let peers = self.discovery.list_peers(&self.config.peer_id).await?;
        peers
            .into_iter()
            .find(|peer| peer.peer_id == target_peer_id)
            .ok_or_else(|| RuntimeError::PeerNotFound(target_peer_id.to_owned()))
    }

    pub(super) fn discovered_peer(
        &self,
        peer: PeerRegistryEntry,
    ) -> Result<DiscoveredPeer, RuntimeError> {
        let trusted = self
            .trusted_peer_record(&peer.peer_id)?
            .map(|record| record.public_key == peer.public_key)
            .unwrap_or(false);

        Ok(DiscoveredPeer {
            peer_id: peer.peer_id,
            display_name: peer.display_name,
            endpoint: peer.endpoint,
            pid: peer.pid,
            public_key: peer.public_key,
            protocol_version: peer.protocol_version,
            accepting_transfers: peer.accepting_transfers,
            trusted,
        })
    }

    pub(super) fn trusted_peer_record(
        &self,
        peer_id: &str,
    ) -> Result<Option<PeerRecord>, RuntimeError> {
        Ok(peer_store(&self.config.registry_dir, &self.config.peer_id)?
            .list_active()?
            .into_iter()
            .find(|record| record.peer_id == peer_id))
    }

    pub(super) fn upsert_trusted_peer(&self, record: PeerRecord) -> Result<(), RuntimeError> {
        peer_store(&self.config.registry_dir, &self.config.peer_id)?.upsert(record)?;
        Ok(())
    }

    pub(super) fn ensure_peer_is_trusted(
        &self,
        peer_id: &str,
        observed_public_key: &str,
    ) -> Result<(), RuntimeError> {
        ensure_peer_is_trusted_for(
            &self.config.registry_dir,
            &self.config.peer_id,
            peer_id,
            observed_public_key,
        )
    }

    pub(super) async fn send_peer_request(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
    ) -> Result<PeerResponse, RuntimeError> {
        let request_timeout = self.config.peer_request_timeout;
        let response = tokio::time::timeout(request_timeout, async {
            let mut stream = TcpStream::connect(&peer.endpoint).await?;
            write_json_line(&mut stream, &request).await?;

            let mut response_line = String::new();
            let mut reader = BufReader::new(stream);
            let read = reader.read_line(&mut response_line).await?;
            if read == 0 {
                return Err(RuntimeError::Protocol(format!(
                    "peer {} closed the connection without a response",
                    peer.peer_id
                )));
            }

            parse_peer_response_line(&peer.peer_id, "peer request", &response_line)
        })
        .await
        .map_err(|_| RuntimeError::PeerRequestTimeout {
            peer_id: peer.peer_id.clone(),
            timeout_ms: request_timeout.as_millis(),
        })??;
        Ok(response)
    }

    pub(super) fn next_request_id(&self, prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            self.config.peer_id,
            self.request_counter.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) async fn lookup_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
    ) -> Option<PathBuf> {
        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .get(transfer_id)
            .and_then(|artifacts| artifacts.get(artifact_id))
            .map(|artifact| artifact.path.clone())
    }

    pub(super) async fn materialize_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
        filename: &str,
        payload_b64: &str,
    ) -> Result<PathBuf, RuntimeError> {
        let artifact_dir = self.config.registry_dir.join("artifacts").join(transfer_id);
        std::fs::create_dir_all(&artifact_dir)?;

        let destination_path = artifact_dir.join(format!(
            "{}-{}",
            artifact_id,
            sanitize_artifact_filename(filename)
        ));
        let payload = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|error| {
            RuntimeError::Protocol(format!("invalid artifact payload: {}", error))
        })?;
        std::fs::write(&destination_path, payload)?;

        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(
                artifact_id.to_owned(),
                TransferArtifactRecord {
                    path: destination_path.clone(),
                    created_at: Instant::now(),
                },
            );

        Ok(destination_path)
    }
}
