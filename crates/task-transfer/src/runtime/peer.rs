use super::events::RuntimeError;
use super::external_peers::{
    ensure_peer_is_trusted_for_transport, external_key_is_trusted, external_peer, external_peers,
    find_peer, resolve_peer, validate_external_peer, ExternalPeer, PeerRoutes, TransferTransport,
};
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
    pub async fn find_peer(&self, target_peer_id: &str) -> Result<PeerRegistryEntry, RuntimeError> {
        self.find_peer_with_transport(target_peer_id, TransferTransport::Auto)
            .await
    }

    pub(super) async fn find_peer_with_transport(
        &self,
        target_peer_id: &str,
        transport: TransferTransport,
    ) -> Result<PeerRegistryEntry, RuntimeError> {
        find_peer(
            &self.discovery,
            &self.external_peers,
            &self.config.peer_id,
            target_peer_id,
            transport,
        )
        .await
    }

    pub(super) async fn resolve_peer_with_transport(
        &self,
        target_peer_id: &str,
        transport: TransferTransport,
    ) -> Result<(PeerRegistryEntry, TransferTransport), RuntimeError> {
        resolve_peer(
            &self.discovery,
            &self.external_peers,
            &self.config.peer_id,
            target_peer_id,
            transport,
        )
        .await
    }

    pub async fn peer_routes(&self, peer_id: &str) -> Result<PeerRoutes, RuntimeError> {
        let lan_endpoint = self
            .discovery
            .list_peers(&self.config.peer_id)
            .await?
            .into_iter()
            .find(|peer| peer.peer_id == peer_id)
            .map(|peer| peer.endpoint);
        let cloud_endpoint = external_peer(&self.external_peers, peer_id).map(|peer| peer.endpoint);
        if lan_endpoint.is_none() && cloud_endpoint.is_none() {
            return Err(RuntimeError::PeerNotFound(peer_id.to_owned()));
        }
        Ok(PeerRoutes {
            lan_endpoint,
            cloud_endpoint,
        })
    }

    pub async fn upsert_external_peer(&self, peer: ExternalPeer) -> Result<(), RuntimeError> {
        validate_external_peer(&peer)?;
        if peer.peer_id == self.config.peer_id {
            return Err(RuntimeError::InvalidConfig(
                "external peer must not identify this runtime".into(),
            ));
        }
        self.external_peers
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(peer.peer_id.clone(), peer);
        Ok(())
    }

    pub async fn list_external_peers(&self) -> Vec<ExternalPeer> {
        external_peers(&self.external_peers)
    }

    pub async fn remove_external_peer(&self, peer_id: &str) -> Result<(), RuntimeError> {
        self.external_peers
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(peer_id);
        Ok(())
    }

    pub async fn clear_external_peers(&self) -> Result<(), RuntimeError> {
        self.external_peers
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        Ok(())
    }

    pub(super) fn discovered_peer(
        &self,
        peer: PeerRegistryEntry,
    ) -> Result<DiscoveredPeer, RuntimeError> {
        let trusted = self
            .trusted_peer_record(&peer.peer_id)?
            .map(|record| record.public_key == peer.public_key)
            .unwrap_or(false)
            || external_key_is_trusted(&self.external_peers, &peer.peer_id, &peer.public_key);

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

    pub fn ensure_peer_is_trusted(
        &self,
        peer_id: &str,
        observed_public_key: &str,
    ) -> Result<(), RuntimeError> {
        if external_key_is_trusted(&self.external_peers, peer_id, observed_public_key) {
            return Ok(());
        }
        ensure_peer_is_trusted_for(
            &self.config.registry_dir,
            &self.config.peer_id,
            peer_id,
            observed_public_key,
        )
    }

    pub(super) fn ensure_peer_is_trusted_for_transport(
        &self,
        peer_id: &str,
        observed_public_key: &str,
        transport: TransferTransport,
    ) -> Result<(), RuntimeError> {
        ensure_peer_is_trusted_for_transport(
            &self.config.registry_dir,
            &self.config.peer_id,
            &self.external_peers,
            peer_id,
            observed_public_key,
            transport,
        )
    }

    pub(super) fn ensure_peer_is_durably_trusted(
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
