use super::discovery::PeerDiscovery;
use super::events::RuntimeError;
use super::utils::ensure_peer_is_trusted_for;
use crate::crypto::parse_public_key;
use crate::protocol::PeerRegistryEntry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalPeer {
    pub peer_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub public_key: String,
    pub protocol_version: u32,
    pub accepting_transfers: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoutes {
    pub lan_endpoint: Option<String>,
    pub cloud_endpoint: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferTransport {
    #[default]
    Auto,
    Lan,
    Cloud,
}

pub(super) type ExternalPeerRegistry = Arc<RwLock<HashMap<String, ExternalPeer>>>;

pub(super) fn registry() -> ExternalPeerRegistry {
    Arc::new(RwLock::new(HashMap::new()))
}

pub(super) fn validate_external_peer(peer: &ExternalPeer) -> Result<(), RuntimeError> {
    if peer.peer_id.trim().is_empty() {
        return Err(RuntimeError::InvalidConfig(
            "external peer id must not be blank".into(),
        ));
    }
    if peer.display_name.trim().is_empty() {
        return Err(RuntimeError::InvalidConfig(
            "external peer display name must not be blank".into(),
        ));
    }
    let endpoint = peer.endpoint.parse::<SocketAddr>().map_err(|error| {
        RuntimeError::InvalidConfig(format!("invalid external peer endpoint: {error}"))
    })?;
    if !endpoint.ip().is_loopback() {
        return Err(RuntimeError::InvalidConfig(
            "external peer endpoint must be loopback".into(),
        ));
    }
    if peer.protocol_version != 1 {
        return Err(RuntimeError::InvalidConfig(format!(
            "unsupported external peer protocol version: {}",
            peer.protocol_version
        )));
    }
    if peer.public_key.trim().is_empty() {
        return Err(RuntimeError::InvalidConfig(
            "external peer public key must not be blank".into(),
        ));
    }
    parse_public_key(&peer.public_key)
        .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
    Ok(())
}

pub(super) fn external_entry(peer: &ExternalPeer) -> PeerRegistryEntry {
    PeerRegistryEntry {
        peer_id: peer.peer_id.clone(),
        display_name: peer.display_name.clone(),
        endpoint: peer.endpoint.clone(),
        pid: 0,
        public_key: peer.public_key.clone(),
        protocol_version: peer.protocol_version,
        accepting_transfers: peer.accepting_transfers,
    }
}

pub(super) fn external_peer(
    registry: &ExternalPeerRegistry,
    peer_id: &str,
) -> Option<ExternalPeer> {
    registry
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(peer_id)
        .cloned()
}

pub(super) fn external_peers(registry: &ExternalPeerRegistry) -> Vec<ExternalPeer> {
    registry
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .cloned()
        .collect()
}

pub(super) fn external_key_is_trusted(
    registry: &ExternalPeerRegistry,
    peer_id: &str,
    observed_public_key: &str,
) -> bool {
    external_peer(registry, peer_id)
        .map(|peer| peer.public_key == observed_public_key)
        .unwrap_or(false)
}

pub(super) async fn find_peer(
    discovery: &PeerDiscovery,
    registry: &ExternalPeerRegistry,
    self_peer_id: &str,
    peer_id: &str,
    transport: TransferTransport,
) -> Result<PeerRegistryEntry, RuntimeError> {
    resolve_peer(discovery, registry, self_peer_id, peer_id, transport)
        .await
        .map(|(peer, _)| peer)
}

pub(super) async fn resolve_peer(
    discovery: &PeerDiscovery,
    registry: &ExternalPeerRegistry,
    self_peer_id: &str,
    peer_id: &str,
    transport: TransferTransport,
) -> Result<(PeerRegistryEntry, TransferTransport), RuntimeError> {
    let lan_peer = discovery
        .list_peers(self_peer_id)
        .await?
        .into_iter()
        .find(|peer| peer.peer_id == peer_id);
    let cloud_peer = external_peer(registry, peer_id).map(|peer| external_entry(&peer));
    match transport {
        TransferTransport::Auto => lan_peer
            .map(|peer| (peer, TransferTransport::Lan))
            .or_else(|| cloud_peer.map(|peer| (peer, TransferTransport::Cloud))),
        TransferTransport::Lan => lan_peer.map(|peer| (peer, TransferTransport::Lan)),
        TransferTransport::Cloud => cloud_peer.map(|peer| (peer, TransferTransport::Cloud)),
    }
    .ok_or_else(|| RuntimeError::PeerNotFound(peer_id.to_owned()))
}

pub(super) fn ensure_peer_is_trusted(
    root: &std::path::Path,
    self_peer_id: &str,
    registry: &ExternalPeerRegistry,
    peer_id: &str,
    observed_public_key: &str,
) -> Result<(), RuntimeError> {
    if external_key_is_trusted(registry, peer_id, observed_public_key) {
        return Ok(());
    }
    ensure_peer_is_trusted_for(root, self_peer_id, peer_id, observed_public_key)
}

pub(super) fn ensure_peer_is_trusted_for_transport(
    root: &std::path::Path,
    self_peer_id: &str,
    registry: &ExternalPeerRegistry,
    peer_id: &str,
    observed_public_key: &str,
    transport: TransferTransport,
) -> Result<(), RuntimeError> {
    if transport == TransferTransport::Cloud {
        if external_key_is_trusted(registry, peer_id, observed_public_key) {
            return Ok(());
        }
        return Err(RuntimeError::Protocol(format!(
            "peer {} is not trusted for cloud transfer",
            peer_id
        )));
    }
    ensure_peer_is_trusted(root, self_peer_id, registry, peer_id, observed_public_key)
}
