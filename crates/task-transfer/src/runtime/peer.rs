use super::events::RuntimeError;
use super::external_peers::{
    ensure_peer_is_trusted_for_transport, external_key_is_trusted, external_peer, external_peers,
    find_peer, resolve_peer, validate_external_peer, ExternalPeer, PeerRoutes, TransferTransport,
};
use super::state::{TransferArtifactRecord, TransferRuntime};
use super::utils::{
    ensure_peer_is_trusted_for, managed_artifact_dir, parse_peer_response_line, peer_store,
    prune_transfer_artifacts, sanitize_artifact_filename, supports_authenticated_task_requests,
    supports_streamed_artifacts, write_json_line,
};
use crate::crypto::{artifact_stream_context, open_json, StreamOpener};
use crate::peer_store::PeerRecord;
use crate::protocol::DiscoveredPeer;
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

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
        let discovery_delay = self
            .config
            .peer_discovery_delays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front();
        if let Some(discovery_delay) = discovery_delay {
            tokio::time::sleep(discovery_delay).await;
        }
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

    pub(super) fn require_authenticated_task_requests(
        &self,
        peer_id: &str,
        public_key: &str,
        protocol_version: u32,
    ) -> Result<(), RuntimeError> {
        if external_key_is_trusted(&self.external_peers, peer_id, public_key) {
            return Ok(());
        }
        let record = self
            .trusted_peer_record(peer_id)?
            .filter(|record| record.public_key == public_key)
            .ok_or_else(|| RuntimeError::Protocol(format!("peer {peer_id} is not trusted")))?;
        if supports_authenticated_task_requests(protocol_version, &record.capabilities_json) {
            return Ok(());
        }
        Err(RuntimeError::Protocol(format!(
            "peer {} uses protocol v{} without authenticated task requests; upgrade and re-pair the peer",
            peer_id, protocol_version
        )))
    }

    pub(super) async fn send_peer_request(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
    ) -> Result<PeerResponse, RuntimeError> {
        self.send_peer_request_with_timeout(peer, request, self.config.peer_request_timeout)
            .await
    }

    pub(super) async fn send_peer_request_with_timeout(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
        request_timeout: std::time::Duration,
    ) -> Result<PeerResponse, RuntimeError> {
        if matches!(&request, PeerRequest::FetchTransferArtifact { .. }) {
            self.send_peer_request_with_permits(
                peer,
                request,
                request_timeout,
                &self.artifact_peer_request_permits,
                "artifact peer request capacity",
                self.config.max_artifact_response_bytes,
            )
            .await
        } else {
            self.send_peer_request_with_permits(
                peer,
                request,
                request_timeout,
                &self.peer_request_permits,
                "peer request capacity",
                self.config.max_peer_response_bytes,
            )
            .await
        }
    }

    pub(super) async fn send_mark_read_peer_request_with_timeout(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
        request_timeout: std::time::Duration,
    ) -> Result<PeerResponse, RuntimeError> {
        self.send_peer_request_with_permits(
            peer,
            request,
            request_timeout,
            &self.mark_read_peer_request_permits,
            "mark-read peer request capacity",
            self.config.max_peer_response_bytes,
        )
        .await
    }

    async fn send_peer_request_with_permits(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
        request_timeout: std::time::Duration,
        permits: &Arc<Semaphore>,
        capacity_name: &str,
        max_response_bytes: usize,
    ) -> Result<PeerResponse, RuntimeError> {
        let _permit = Arc::clone(permits)
            .try_acquire_owned()
            .map_err(|_| RuntimeError::Backpressure(format!("{capacity_name} is exhausted")))?;
        let response = tokio::time::timeout(request_timeout, async {
            let mut stream = TcpStream::connect(&peer.endpoint).await?;
            write_json_line(&mut stream, &request).await?;

            let mut response_line = String::with_capacity(max_response_bytes.min(64 * 1024));
            let mut reader =
                BufReader::new(stream).take(max_response_bytes.saturating_add(1) as u64);
            let read = reader.read_line(&mut response_line).await?;
            if read == 0 {
                return Err(RuntimeError::Protocol(format!(
                    "peer {} closed the connection without a response",
                    peer.peer_id
                )));
            }
            if read > max_response_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "peer {} response exceeds maximum peer response frame size of {} bytes",
                    peer.peer_id, max_response_bytes
                )));
            }
            if !response_line.ends_with('\n') {
                return Err(RuntimeError::Protocol(format!(
                    "peer {} response did not terminate within the peer response frame limit of {} bytes",
                    peer.peer_id, max_response_bytes
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
            "{}-{}-{}-{}",
            prefix,
            self.config.peer_id,
            self.request_namespace,
            self.request_counter.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) async fn lookup_transfer_artifact(
        &self,
        transfer_id: &str,
        artifact_id: &str,
    ) -> Option<PathBuf> {
        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        let expired =
            prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        let path = transfer_artifacts
            .get(transfer_id)
            .and_then(|artifacts| artifacts.get(artifact_id))
            .map(|artifact| artifact.path.clone());
        drop(transfer_artifacts);
        super::utils::remove_owned_artifact_paths(expired).await;
        path
    }

    pub(super) async fn fetch_peer_artifact_stream(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
        request_id: &str,
        transfer_id: &str,
        artifact_id: &str,
        source_public_key: &x25519_dalek::PublicKey,
    ) -> Result<PathBuf, RuntimeError> {
        let _permit = Arc::clone(&self.artifact_peer_request_permits)
            .try_acquire_owned()
            .map_err(|_| {
                RuntimeError::Backpressure("artifact peer request capacity is exhausted".into())
            })?;
        let permitted_size = super::MAX_TRANSFER_ARTIFACT_BYTES;
        let mut partial_path_to_cleanup = None;
        let fetch_result = tokio::time::timeout(self.config.peer_request_timeout, async {
            let mut stream = TcpStream::connect(&peer.endpoint).await?;
            write_json_line(&mut stream, &request).await?;
            let mut reader = BufReader::new(stream);
            let mut response_line = String::with_capacity(4096);
            let read = {
                let mut bounded =
                    (&mut reader).take(self.config.max_peer_response_bytes as u64 + 1);
                bounded.read_line(&mut response_line).await?
            };
            if read == 0
                || read > self.config.max_peer_response_bytes
                || !response_line.ends_with('\n')
            {
                return Err(RuntimeError::Protocol(
                    "artifact response header exceeded the peer response frame limit".into(),
                ));
            }
            let response = parse_peer_response_line(
                &peer.peer_id,
                "artifact fetch",
                &response_line,
            )?;
            let (sealed_payload, stream_header) = match response {
                PeerResponse::FetchTransferArtifact {
                    request_id: response_request_id,
                    transfer_id: response_transfer_id,
                    sealed_payload,
                    stream_header,
                } => {
                    if response_request_id != request_id {
                        return Err(RuntimeError::Protocol(format!(
                            "mismatched request id in artifact fetch response: expected {request_id}, got {response_request_id}",
                        )));
                    }
                    if response_transfer_id != transfer_id {
                        return Err(RuntimeError::Protocol(format!(
                            "mismatched transfer id in artifact fetch response: expected {transfer_id}, got {response_transfer_id}",
                        )));
                    }
                    (sealed_payload, stream_header)
                }
                PeerResponse::Error { message, .. } => {
                    return Err(RuntimeError::Protocol(message));
                }
                other => {
                    return Err(RuntimeError::Protocol(format!(
                        "unexpected response while fetching transfer artifact: {other:?}",
                    )));
                }
            };

            let metadata = open_json(&self.identity, source_public_key, &sealed_payload)?;
            let response_artifact_id = metadata
                .get("artifact_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| RuntimeError::Protocol(
                    "artifact fetch response missing artifact_id".into(),
                ))?;
            if response_artifact_id != artifact_id {
                return Err(RuntimeError::Protocol(format!(
                    "mismatched artifact id in artifact fetch response: expected {artifact_id}, got {response_artifact_id}",
                )));
            }
            let filename = metadata
                .get("filename")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| RuntimeError::Protocol(
                    "artifact fetch response missing filename".into(),
                ))?;
            let artifact_dir = managed_artifact_dir(
                &self.config.registry_dir,
                &self.config.peer_id,
                transfer_id,
            );
            tokio::fs::create_dir_all(&artifact_dir).await?;
            let safe_artifact_id = sanitize_artifact_filename(artifact_id);
            let destination_path = artifact_dir.join(format!(
                "{}-{}",
                safe_artifact_id,
                sanitize_artifact_filename(filename),
            ));

            if !supports_streamed_artifacts(peer.protocol_version) {
                if stream_header.is_some() {
                    return Err(RuntimeError::Protocol(format!(
                        "peer {} selected streamed artifact framing while advertising protocol v{}",
                        peer.peer_id, peer.protocol_version,
                    )));
                }
                let payload_b64 = metadata
                    .get("payload_b64")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Protocol(
                            "legacy artifact fetch response missing payload_b64".into(),
                        )
                    })?;
                let payload = URL_SAFE_NO_PAD.decode(payload_b64).map_err(|error| {
                    RuntimeError::Protocol(format!("invalid artifact payload: {error}"))
                })?;
                if payload.len() as u64 > permitted_size {
                    return Err(RuntimeError::Protocol(format!(
                        "transfer artifact exceeds maximum size of {permitted_size} bytes",
                    )));
                }
                tokio::fs::write(&destination_path, payload).await?;
                return Ok::<PathBuf, RuntimeError>(destination_path);
            }

            let stream_header = stream_header.ok_or_else(|| {
                RuntimeError::Protocol(format!(
                    "peer {} omitted streamed artifact framing for protocol v{}",
                    peer.peer_id, peer.protocol_version,
                ))
            })?;
            let plaintext_size = metadata
                .get("plaintext_size")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RuntimeError::Protocol(
                    "artifact fetch response missing plaintext_size".into(),
                ))?;
            if plaintext_size > permitted_size {
                return Err(RuntimeError::Protocol(format!(
                    "transfer artifact exceeds maximum size of {permitted_size} bytes",
                )));
            }

            let partial_path = artifact_dir.join(format!(
                ".{}-{}.part",
                safe_artifact_id, self.request_namespace,
            ));
            partial_path_to_cleanup = Some(partial_path.clone());
            let mut file = tokio::fs::File::create(&partial_path).await?;
            let response_context =
                artifact_stream_context(request_id, transfer_id, artifact_id, plaintext_size);
            let mut opener = StreamOpener::new(
                &self.identity,
                source_public_key,
                &stream_header,
                &response_context,
            )?;
            let mut sequence = 0u64;
            let mut written = 0u64;
            loop {
                let final_chunk = reader.read_u8().await? != 0;
                let ciphertext_len = reader.read_u32().await? as usize;
                let maximum_ciphertext = super::TRANSFER_ARTIFACT_CHUNK_BYTES + 16;
                if ciphertext_len > maximum_ciphertext {
                    return Err(RuntimeError::Protocol(format!(
                        "artifact chunk exceeds maximum encrypted size of {maximum_ciphertext} bytes",
                    )));
                }
                let mut ciphertext = vec![0u8; ciphertext_len];
                reader.read_exact(&mut ciphertext).await?;
                let plaintext = opener.open_chunk(sequence, &ciphertext, final_chunk)?;
                sequence = sequence.checked_add(1).ok_or_else(|| {
                    RuntimeError::Protocol("artifact chunk sequence exhausted".into())
                })?;
                if final_chunk {
                    if !plaintext.is_empty() || written != plaintext_size {
                        return Err(RuntimeError::Protocol(
                            "artifact stream ended with a size mismatch".into(),
                        ));
                    }
                    break;
                }
                written = written.checked_add(plaintext.len() as u64).ok_or_else(|| {
                    RuntimeError::Protocol("artifact plaintext size overflow".into())
                })?;
                if written > plaintext_size || written > permitted_size {
                    return Err(RuntimeError::Protocol(
                        "artifact stream exceeded its declared size".into(),
                    ));
                }
                file.write_all(&plaintext).await?;
            }
            file.flush().await?;
            tokio::fs::rename(&partial_path, &destination_path).await?;
            partial_path_to_cleanup = None;
            Ok::<PathBuf, RuntimeError>(destination_path)
        })
        .await;
        if !matches!(&fetch_result, Ok(Ok(_))) {
            if let Some(partial_path) = partial_path_to_cleanup.take() {
                let _ = tokio::fs::remove_file(partial_path).await;
            }
        }
        let destination = fetch_result.map_err(|_| RuntimeError::PeerRequestTimeout {
            peer_id: peer.peer_id.clone(),
            timeout_ms: self.config.peer_request_timeout.as_millis(),
        })??;

        let mut transfer_artifacts = self.transfer_artifacts.lock().await;
        let expired =
            prune_transfer_artifacts(&mut transfer_artifacts, self.config.pending_transfer_ttl);
        transfer_artifacts
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(
                artifact_id.to_owned(),
                TransferArtifactRecord {
                    path: destination.clone(),
                    created_at: Instant::now(),
                    owned: true,
                },
            );
        drop(transfer_artifacts);
        super::utils::remove_owned_artifact_paths(expired).await;
        Ok(destination)
    }
}
