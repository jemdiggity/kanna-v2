use super::events::RuntimeError;
use super::external_peers::{
    ensure_peer_is_trusted_for_transport, external_key_is_trusted, external_peer, external_peers,
    find_peer, resolve_peer, validate_external_peer, ExternalPeer, PeerRoutes, TransferTransport,
};
use super::state::{TransferArtifactRecord, TransferRuntime};
use super::utils::{
    ensure_peer_is_trusted_for, managed_artifact_dir, managed_artifact_filename,
    parse_peer_response_line, peer_store, prune_transfer_artifacts,
    supports_authenticated_task_requests, write_json_line, ArtifactFraming,
};
use crate::crypto::{
    artifact_stream_context, open_json_bytes, open_json_bytes_bounded, SealedStreamHeader,
    StreamOpener,
};
use crate::peer_store::PeerRecord;
use crate::protocol::DiscoveredPeer;
use crate::protocol::{PeerRegistryEntry, PeerRequest, PeerResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

pub(super) struct ArtifactStreamRequest<'a> {
    pub(super) request_id: &'a str,
    pub(super) transfer_id: &'a str,
    pub(super) artifact_id: &'a str,
    pub(super) framing: ArtifactFraming,
}

/// The wire `filename` is only ever a file name, so `NAME_MAX` is its natural
/// ceiling even though the local name is no longer composed from it.
const MAX_ARTIFACT_FILENAME_BYTES: usize = super::utils::NAME_MAX_BYTES;
const MAX_ARTIFACT_ERROR_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_STREAM_HEADER_FIELD_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BorrowedStreamHeader<'a> {
    version: u32,
    #[serde(borrow)]
    ephemeral_public_key: &'a str,
    #[serde(borrow)]
    nonce_prefix_b64: &'a str,
}

impl BorrowedStreamHeader<'_> {
    fn to_owned_bounded(&self) -> Result<SealedStreamHeader, RuntimeError> {
        if self.ephemeral_public_key.len() > MAX_STREAM_HEADER_FIELD_BYTES
            || self.nonce_prefix_b64.len() > MAX_STREAM_HEADER_FIELD_BYTES
        {
            return Err(RuntimeError::Protocol(
                "artifact stream header field exceeds maximum size".into(),
            ));
        }
        Ok(SealedStreamHeader {
            version: self.version,
            ephemeral_public_key: self.ephemeral_public_key.to_owned(),
            nonce_prefix_b64: self.nonce_prefix_b64.to_owned(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactFetchWireResponse<'a> {
    #[serde(rename = "type", borrow)]
    response_type: Cow<'a, str>,
    #[serde(borrow)]
    request_id: Cow<'a, str>,
    #[serde(default, borrow)]
    transfer_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    sealed_payload: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    stream_header: Option<BorrowedStreamHeader<'a>>,
    #[serde(default, borrow)]
    message: Option<Cow<'a, str>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyArtifactMetadata<'a> {
    #[serde(default, borrow)]
    request_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    transfer_id: Option<Cow<'a, str>>,
    #[serde(borrow)]
    artifact_id: Cow<'a, str>,
    #[serde(default, borrow)]
    artifact_framing: Option<&'a str>,
    #[serde(borrow)]
    filename: Cow<'a, str>,
    #[serde(borrow)]
    payload_b64: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StreamedArtifactMetadata<'a> {
    #[serde(default, borrow)]
    request_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    transfer_id: Option<Cow<'a, str>>,
    #[serde(borrow)]
    artifact_id: Cow<'a, str>,
    #[serde(default, borrow)]
    artifact_framing: Option<&'a str>,
    #[serde(borrow)]
    filename: Cow<'a, str>,
    plaintext_size: u64,
}

#[allow(clippy::ptr_arg)] // Retained capacity is only observable on the `Cow` owner.
fn cow_owned_capacity(value: &Cow<'_, str>) -> usize {
    match value {
        Cow::Borrowed(_) => 0,
        Cow::Owned(value) => value.capacity(),
    }
}

pub(super) async fn read_bounded_artifact_response_line<R>(
    reader: &mut R,
    maximum_bytes: usize,
) -> Result<String, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::with_capacity(maximum_bytes.min(4096));
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(RuntimeError::Protocol(format!(
                "artifact response exceeded the negotiated framing limit of {maximum_bytes} bytes",
            )));
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        let needed = bytes
            .len()
            .checked_add(take)
            .ok_or_else(|| RuntimeError::Protocol("artifact response size overflow".into()))?;
        if needed > maximum_bytes {
            return Err(RuntimeError::Protocol(format!(
                "artifact response exceeded the negotiated framing limit of {maximum_bytes} bytes",
            )));
        }
        if needed > bytes.capacity() {
            let doubled = bytes.capacity().saturating_mul(2).max(4096);
            let target = needed.max(doubled).min(maximum_bytes);
            bytes
                .try_reserve_exact(target.saturating_sub(bytes.len()))
                .map_err(|_| {
                    RuntimeError::Protocol(
                        "could not reserve bounded artifact response buffer".into(),
                    )
                })?;
            super::ensure_legacy_artifact_allocation_capacity(
                &[bytes.capacity()],
                super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
            )?;
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if bytes.ends_with(b"\n") {
            return String::from_utf8(bytes).map_err(|error| {
                RuntimeError::Protocol(format!("artifact response was not valid UTF-8: {error}",))
            });
        }
    }
}

pub(super) struct GuardedArtifactPart {
    path: PathBuf,
    file: Option<tokio::fs::File>,
    committed: bool,
}

impl GuardedArtifactPart {
    pub(super) async fn create(directory: &Path) -> Result<Self, RuntimeError> {
        for _ in 0..16 {
            let mut nonce = [0u8; 16];
            OsRng.fill_bytes(&mut nonce);
            let path = directory.join(format!(".artifact-{}.part", URL_SAFE_NO_PAD.encode(nonce),));
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
            {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        committed: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(RuntimeError::Protocol(
            "could not allocate a unique artifact partial file".into(),
        ))
    }

    #[cfg(test)]
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) async fn write_all(&mut self, payload: &[u8]) -> Result<(), RuntimeError> {
        self.file
            .as_mut()
            .ok_or_else(|| RuntimeError::Protocol("artifact partial file is closed".into()))?
            .write_all(payload)
            .await?;
        Ok(())
    }

    pub(super) async fn commit(mut self, destination: &Path) -> Result<(), RuntimeError> {
        let mut file = self
            .file
            .take()
            .ok_or_else(|| RuntimeError::Protocol("artifact partial file is closed".into()))?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&self.path, destination).await?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for GuardedArtifactPart {
    fn drop(&mut self) {
        if !self.committed {
            drop(self.file.take());
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn ensure_optional_artifact_metadata_match(
    authenticated: Option<&str>,
    expected: &str,
    label: &str,
) -> Result<(), RuntimeError> {
    if authenticated.is_some_and(|value| value != expected) {
        return Err(RuntimeError::Protocol(format!(
            "artifact response authenticated {label} does not match request",
        )));
    }
    Ok(())
}

pub(super) fn artifact_response_line_limit(
    artifact_framing: ArtifactFraming,
    max_peer_response_bytes: usize,
    max_artifact_response_bytes: usize,
) -> usize {
    if artifact_framing.is_streamed() {
        max_peer_response_bytes
    } else {
        max_artifact_response_bytes.min(super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES)
    }
}

pub(super) fn ensure_legacy_artifact_payload_size(
    payload_b64: &str,
    maximum_size: u64,
) -> Result<(), RuntimeError> {
    let encoded_size = u64::try_from(payload_b64.len()).map_err(|_| {
        RuntimeError::Protocol("legacy artifact payload size cannot be represented".into())
    })?;
    ensure_legacy_artifact_payload_length(encoded_size, maximum_size)
}

pub(super) fn ensure_legacy_artifact_payload_length(
    encoded_size: u64,
    maximum_size: u64,
) -> Result<(), RuntimeError> {
    let complete_quads = encoded_size / 4;
    let trailing_bytes = match encoded_size % 4 {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => {
            return Err(RuntimeError::Protocol(
                "invalid artifact payload: invalid unpadded base64 length".into(),
            ));
        }
    };
    let decoded_size = complete_quads
        .checked_mul(3)
        .and_then(|size| size.checked_add(trailing_bytes))
        .ok_or_else(|| RuntimeError::Protocol("legacy artifact payload size overflow".into()))?;
    if decoded_size > maximum_size {
        return Err(RuntimeError::Protocol(format!(
            "transfer artifact exceeds maximum size of {maximum_size} bytes",
        )));
    }
    Ok(())
}

fn decode_legacy_artifact_payload(
    payload_b64: &str,
    maximum_size: u64,
    retained_capacities: &[usize],
) -> Result<Vec<u8>, RuntimeError> {
    ensure_legacy_artifact_payload_size(payload_b64, maximum_size)?;
    if payload_b64.len() > super::MAX_LEGACY_ARTIFACT_PAYLOAD_B64_BYTES {
        return Err(RuntimeError::Protocol(format!(
            "legacy artifact payload encoding exceeds maximum size of {} bytes",
            super::MAX_LEGACY_ARTIFACT_PAYLOAD_B64_BYTES,
        )));
    }
    let complete_quads = payload_b64.len() / 4;
    let trailing_bytes = match payload_b64.len() % 4 {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => unreachable!("payload length was validated before allocation"),
    };
    let decoded_size = complete_quads
        .checked_mul(3)
        .and_then(|size| size.checked_add(trailing_bytes))
        .ok_or_else(|| RuntimeError::Protocol("legacy artifact payload size overflow".into()))?;
    let mut payload = Vec::new();
    payload.try_reserve_exact(decoded_size).map_err(|_| {
        RuntimeError::Protocol("could not reserve bounded legacy artifact payload".into())
    })?;
    let retained = super::legacy_artifact_retained_capacity(retained_capacities)?;
    super::ensure_legacy_artifact_allocation_capacity(
        &[retained, payload.capacity()],
        super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
    )?;
    payload.resize(decoded_size, 0);
    let decoded = URL_SAFE_NO_PAD
        .decode_slice(payload_b64, &mut payload)
        .map_err(|error| RuntimeError::Protocol(format!("invalid artifact payload: {error}")))?;
    if decoded != decoded_size {
        return Err(RuntimeError::Protocol(
            "invalid artifact payload decoded length".into(),
        ));
    }
    Ok(payload)
}

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

    pub(super) async fn send_peer_request_with_line_limit(
        &self,
        peer: &PeerRegistryEntry,
        request: PeerRequest,
        max_line_bytes: Option<usize>,
    ) -> Result<PeerResponse, RuntimeError> {
        let max_response_bytes = max_line_bytes.unwrap_or(self.config.max_peer_response_bytes);
        self.send_peer_request_with_permits(
            peer,
            request,
            self.config.peer_request_timeout,
            &self.peer_request_permits,
            "peer request capacity",
            max_response_bytes,
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
        artifact: ArtifactStreamRequest<'_>,
        source_public_key: &x25519_dalek::PublicKey,
    ) -> Result<PathBuf, RuntimeError> {
        let ArtifactStreamRequest {
            request_id,
            transfer_id,
            artifact_id,
            framing: artifact_framing,
        } = artifact;
        let _permit = Arc::clone(&self.artifact_peer_request_permits)
            .try_acquire_owned()
            .map_err(|_| {
                RuntimeError::Backpressure("artifact peer request capacity is exhausted".into())
            })?;
        let _legacy_memory_permit = if artifact_framing.is_streamed() {
            None
        } else {
            Some(super::try_acquire_legacy_artifact_memory(
                Arc::clone(&self.legacy_artifact_memory_permits),
                "receive",
            )?)
        };
        let permitted_size = if artifact_framing.is_streamed() {
            super::MAX_TRANSFER_ARTIFACT_BYTES
        } else {
            super::MAX_LEGACY_TRANSFER_ARTIFACT_BYTES
        };
        let fetch_result = tokio::time::timeout(self.config.peer_request_timeout, async {
            let mut stream = TcpStream::connect(&peer.endpoint).await?;
            write_json_line(&mut stream, &request).await?;
            let mut reader = BufReader::new(stream);
            let response_line_limit = artifact_response_line_limit(
                artifact_framing,
                self.config.max_peer_response_bytes,
                self.config.max_artifact_response_bytes,
            );
            let response_line =
                read_bounded_artifact_response_line(&mut reader, response_line_limit).await?;
            let response: ArtifactFetchWireResponse<'_> =
                serde_json::from_str(response_line.trim()).map_err(|error| {
                    RuntimeError::Protocol(format!(
                        "peer {} returned an invalid artifact response: {error}",
                        peer.peer_id,
                    ))
                })?;
            let response_owned_capacity = super::legacy_artifact_retained_capacity(&[
                cow_owned_capacity(&response.response_type),
                cow_owned_capacity(&response.request_id),
                response
                    .transfer_id
                    .as_ref()
                    .map_or(0, cow_owned_capacity),
                response
                    .sealed_payload
                    .as_ref()
                    .map_or(0, cow_owned_capacity),
                response.message.as_ref().map_or(0, cow_owned_capacity),
            ])?;
            if !artifact_framing.is_streamed() {
                super::ensure_legacy_artifact_allocation_capacity(
                    &[response_line.capacity(), response_owned_capacity],
                    super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
                )?;
            }
            let (sealed_payload, stream_header) = match response.response_type {
                ref response_type if response_type == "fetch_transfer_artifact" => {
                    if response.message.is_some() {
                        return Err(RuntimeError::Protocol(
                            "artifact fetch response included error-only fields".into(),
                        ));
                    }
                    if response.request_id != request_id {
                        return Err(RuntimeError::Protocol(
                            "mismatched request id in artifact fetch response".into(),
                        ));
                    }
                    let response_transfer_id = response.transfer_id.as_deref().ok_or_else(|| {
                        RuntimeError::Protocol(
                            "artifact fetch response missing transfer_id".into(),
                        )
                    })?;
                    if response_transfer_id != transfer_id {
                        return Err(RuntimeError::Protocol(
                            "mismatched transfer id in artifact fetch response".into(),
                        ));
                    }
                    let sealed_payload = response.sealed_payload.as_deref().ok_or_else(|| {
                        RuntimeError::Protocol(
                            "artifact fetch response missing sealed_payload".into(),
                        )
                    })?;
                    (sealed_payload, response.stream_header.as_ref())
                }
                ref response_type if response_type == "error" => {
                    if response.transfer_id.is_some()
                        || response.sealed_payload.is_some()
                        || response.stream_header.is_some()
                    {
                        return Err(RuntimeError::Protocol(
                            "artifact error response included fetch-only fields".into(),
                        ));
                    }
                    let message = response.message.as_deref().ok_or_else(|| {
                        RuntimeError::Protocol(
                            "artifact error response missing message".into(),
                        )
                    })?;
                    if message.len() > MAX_ARTIFACT_ERROR_MESSAGE_BYTES {
                        return Err(RuntimeError::Protocol(
                            "artifact error response message exceeds maximum size".into(),
                        ));
                    }
                    return Err(RuntimeError::Protocol(message.to_owned()));
                }
                _ => {
                    return Err(RuntimeError::Protocol(
                        "unexpected response while fetching transfer artifact".into(),
                    ));
                }
            };

            let retained_wire_capacity = super::legacy_artifact_retained_capacity(&[
                response_line.capacity(),
                response_owned_capacity,
            ])?;
            let metadata_json = if artifact_framing.is_streamed() {
                open_json_bytes(&self.identity, source_public_key, sealed_payload)?
            } else {
                if sealed_payload.len() > super::MAX_LEGACY_ARTIFACT_SEALED_JSON_BYTES {
                    return Err(RuntimeError::Protocol(format!(
                        "legacy artifact sealed envelope exceeds maximum size of {} bytes",
                        super::MAX_LEGACY_ARTIFACT_SEALED_JSON_BYTES,
                    )));
                }
                open_json_bytes_bounded(
                    &self.identity,
                    source_public_key,
                    sealed_payload,
                    super::MAX_LEGACY_ARTIFACT_CIPHERTEXT_B64_BYTES,
                    super::MAX_LEGACY_ARTIFACT_METADATA_BYTES,
                    retained_wire_capacity,
                    super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
                )?
            };
            let metadata_owned_capacity;
            let (
                metadata_request_id,
                metadata_transfer_id,
                response_artifact_id,
                response_framing,
                filename,
                payload_b64,
                plaintext_size,
            ) = if artifact_framing.is_streamed() {
                let metadata: StreamedArtifactMetadata<'_> =
                    serde_json::from_slice(&metadata_json)?;
                metadata_owned_capacity = super::legacy_artifact_retained_capacity(&[
                    metadata
                        .request_id
                        .as_ref()
                        .map_or(0, cow_owned_capacity),
                    metadata
                        .transfer_id
                        .as_ref()
                        .map_or(0, cow_owned_capacity),
                    cow_owned_capacity(&metadata.artifact_id),
                    cow_owned_capacity(&metadata.filename),
                ])?;
                (
                    metadata.request_id,
                    metadata.transfer_id,
                    metadata.artifact_id,
                    metadata.artifact_framing,
                    metadata.filename,
                    None,
                    Some(metadata.plaintext_size),
                )
            } else {
                let metadata: LegacyArtifactMetadata<'_> =
                    serde_json::from_slice(&metadata_json)?;
                metadata_owned_capacity = super::legacy_artifact_retained_capacity(&[
                    metadata
                        .request_id
                        .as_ref()
                        .map_or(0, cow_owned_capacity),
                    metadata
                        .transfer_id
                        .as_ref()
                        .map_or(0, cow_owned_capacity),
                    cow_owned_capacity(&metadata.artifact_id),
                    cow_owned_capacity(&metadata.filename),
                ])?;
                (
                    metadata.request_id,
                    metadata.transfer_id,
                    metadata.artifact_id,
                    metadata.artifact_framing,
                    metadata.filename,
                    Some(metadata.payload_b64),
                    None,
                )
            };
            if !artifact_framing.is_streamed() {
                super::ensure_legacy_artifact_allocation_capacity(
                    &[
                        retained_wire_capacity,
                        metadata_json.capacity(),
                        metadata_owned_capacity,
                    ],
                    super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
                )?;
            }
            ensure_optional_artifact_metadata_match(
                metadata_request_id.as_deref(),
                request_id,
                "request id",
            )?;
            ensure_optional_artifact_metadata_match(
                metadata_transfer_id.as_deref(),
                transfer_id,
                "transfer id",
            )?;
            if response_artifact_id.as_ref() != artifact_id {
                return Err(RuntimeError::Protocol(
                    "mismatched artifact id in artifact fetch response".into(),
                ));
            }
            if let Some(response_framing) = response_framing {
                if ArtifactFraming::parse(response_framing)? != artifact_framing {
                    return Err(RuntimeError::Protocol(format!(
                        "artifact response authenticated framing does not match requested {}",
                        artifact_framing.name(),
                    )));
                }
            }
            // The authenticated `filename` is the source's own on-disk name. It
            // is advisory — the local name below is derived from the artifact
            // id alone, because composing it from a peer-supplied basename is
            // what used to push the receiver's name past `NAME_MAX` — but it
            // still has to stay a sane size on the wire.
            if filename.len() > MAX_ARTIFACT_FILENAME_BYTES {
                return Err(RuntimeError::Protocol(
                    "artifact filename exceeds maximum size".into(),
                ));
            }
            let artifact_dir = managed_artifact_dir(
                &self.config.registry_dir,
                &self.config.peer_id,
                transfer_id,
            );
            tokio::fs::create_dir_all(&artifact_dir).await?;
            let destination_path = artifact_dir.join(managed_artifact_filename(artifact_id));

            if !artifact_framing.is_streamed() {
                if stream_header.is_some() {
                    return Err(RuntimeError::Protocol(format!(
                        "peer {} selected streamed artifact framing for a legacy request",
                        peer.peer_id,
                    )));
                }
                let payload_b64 = payload_b64.ok_or_else(|| {
                    RuntimeError::Protocol(
                        "legacy artifact fetch response missing payload_b64".into(),
                    )
                })?;
                let payload = decode_legacy_artifact_payload(
                    payload_b64,
                    permitted_size,
                    &[
                        retained_wire_capacity,
                        metadata_json.capacity(),
                        metadata_owned_capacity,
                    ],
                )?;
                let mut partial = GuardedArtifactPart::create(&artifact_dir).await?;
                partial.write_all(&payload).await?;
                partial.commit(&destination_path).await?;
                return Ok::<PathBuf, RuntimeError>(destination_path);
            }

            let stream_header = stream_header.ok_or_else(|| {
                RuntimeError::Protocol(format!(
                    "peer {} omitted negotiated streamed artifact framing",
                    peer.peer_id,
                ))
            })?;
            let stream_header = stream_header.to_owned_bounded()?;
            let plaintext_size = plaintext_size.ok_or_else(|| {
                RuntimeError::Protocol(
                    "artifact fetch response missing plaintext_size".into(),
                )
            })?;
            if plaintext_size > permitted_size {
                return Err(RuntimeError::Protocol(format!(
                    "transfer artifact exceeds maximum size of {permitted_size} bytes",
                )));
            }

            let mut partial = GuardedArtifactPart::create(&artifact_dir).await?;
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
                partial.write_all(&plaintext).await?;
            }
            partial.commit(&destination_path).await?;
            Ok::<PathBuf, RuntimeError>(destination_path)
        })
        .await;
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
