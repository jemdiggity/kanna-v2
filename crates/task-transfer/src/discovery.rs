use crate::protocol::PeerRegistryEntry;
use mdns_sd::{ResolvedService, ScopedIp, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr, SocketAddrV4, SocketAddrV6};
use thiserror::Error;

pub const SERVICE_TYPE: &str = "_kanna-xfer._tcp.local.";

const PEER_ID_KEY: &str = "peer_id";
const DISPLAY_NAME_KEY: &str = "display_name";
const PUBLIC_KEY_KEY: &str = "public_key";
const PROTOCOL_VERSION_KEY: &str = "protocol_version";
const ACCEPTING_TRANSFERS_KEY: &str = "accepting_transfers";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxtPeerRecord {
    pub peer_id: String,
    pub display_name: String,
    pub public_key: String,
    pub protocol_version: u32,
    pub accepting_transfers: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DiscoveryError {
    #[error("missing TXT field: {0}")]
    MissingField(&'static str),
    #[error("invalid peer_id")]
    InvalidPeerId,
    #[error("invalid display_name")]
    InvalidDisplayName,
    #[error("invalid public_key")]
    InvalidPublicKey,
    #[error("invalid protocol_version: {0}")]
    InvalidProtocolVersion(String),
    #[error("invalid accepting_transfers flag: {0}")]
    InvalidAcceptingTransfers(String),
    #[error("resolved service is missing an address")]
    MissingAddress,
    #[error("TXT entry for {field} exceeds 255 bytes: {length}")]
    TxtEntryTooLong { field: String, length: usize },
}

pub fn encode_txt_record(
    peer_id: &str,
    display_name: &str,
    public_key: &str,
    protocol_version: u32,
    accepting_transfers: bool,
) -> Result<BTreeMap<String, String>, DiscoveryError> {
    validate_peer_id(peer_id)?;
    validate_display_name(display_name)?;
    validate_public_key(public_key)?;
    validate_protocol_version(protocol_version)?;

    let txt = BTreeMap::from([
        (PEER_ID_KEY.to_owned(), peer_id.to_owned()),
        (DISPLAY_NAME_KEY.to_owned(), display_name.to_owned()),
        (PUBLIC_KEY_KEY.to_owned(), public_key.to_owned()),
        (
            PROTOCOL_VERSION_KEY.to_owned(),
            protocol_version.to_string(),
        ),
        (
            ACCEPTING_TRANSFERS_KEY.to_owned(),
            if accepting_transfers { "1" } else { "0" }.to_owned(),
        ),
    ]);

    validate_txt_entries(&txt)?;

    Ok(txt)
}

pub fn decode_txt_record(txt: &BTreeMap<String, String>) -> Result<TxtPeerRecord, DiscoveryError> {
    validate_txt_entries(txt)?;

    let peer_id = txt
        .get(PEER_ID_KEY)
        .cloned()
        .ok_or(DiscoveryError::MissingField(PEER_ID_KEY))?;
    validate_peer_id(&peer_id)?;

    let display_name = txt
        .get(DISPLAY_NAME_KEY)
        .cloned()
        .ok_or(DiscoveryError::MissingField(DISPLAY_NAME_KEY))?;
    validate_display_name(&display_name)?;

    let public_key = txt
        .get(PUBLIC_KEY_KEY)
        .cloned()
        .ok_or(DiscoveryError::MissingField(PUBLIC_KEY_KEY))?;
    validate_public_key(&public_key)?;

    let protocol_version = txt
        .get(PROTOCOL_VERSION_KEY)
        .ok_or(DiscoveryError::MissingField(PROTOCOL_VERSION_KEY))?
        .parse::<u32>()
        .map_err(|error| DiscoveryError::InvalidProtocolVersion(error.to_string()))?;
    validate_protocol_version(protocol_version)?;

    let accepting_transfers = match txt
        .get(ACCEPTING_TRANSFERS_KEY)
        .ok_or(DiscoveryError::MissingField(ACCEPTING_TRANSFERS_KEY))?
        .as_str()
    {
        "1" => true,
        "0" => false,
        other => return Err(DiscoveryError::InvalidAcceptingTransfers(other.to_owned())),
    };

    Ok(TxtPeerRecord {
        peer_id,
        display_name,
        public_key,
        protocol_version,
        accepting_transfers,
    })
}

pub fn resolved_service_to_peer_entry(
    service: &ResolvedService,
) -> Result<PeerRegistryEntry, DiscoveryError> {
    let record = decode_txt_record(&txt_record_from_resolved_service(service)?)?;
    let endpoint = select_endpoint_socket_addr(service)?.to_string();

    Ok(PeerRegistryEntry {
        peer_id: record.peer_id,
        display_name: record.display_name,
        endpoint,
        pid: 0,
        public_key: record.public_key,
        protocol_version: record.protocol_version,
        accepting_transfers: record.accepting_transfers,
    })
}

pub fn service_info_to_peer_entry(
    service: &ServiceInfo,
) -> Result<PeerRegistryEntry, DiscoveryError> {
    let record = decode_txt_record(&txt_record_from_service_info(service)?)?;
    let endpoint =
        socket_addr_with_scope(select_service_info_address(service)?, service.get_port(), 0)
            .to_string();

    Ok(PeerRegistryEntry {
        peer_id: record.peer_id,
        display_name: record.display_name,
        endpoint,
        pid: 0,
        public_key: record.public_key,
        protocol_version: record.protocol_version,
        accepting_transfers: record.accepting_transfers,
    })
}

fn txt_record_from_resolved_service(
    service: &ResolvedService,
) -> Result<BTreeMap<String, String>, DiscoveryError> {
    let txt = BTreeMap::from([
        read_txt_property(service, PEER_ID_KEY)?,
        read_txt_property(service, DISPLAY_NAME_KEY)?,
        read_txt_property(service, PUBLIC_KEY_KEY)?,
        read_txt_property(service, PROTOCOL_VERSION_KEY)?,
        read_txt_property(service, ACCEPTING_TRANSFERS_KEY)?,
    ]);
    Ok(txt)
}

pub fn hostname_for_peer(peer_id: &str) -> Result<String, DiscoveryError> {
    validate_peer_id(peer_id)?;

    let mut label = String::with_capacity(peer_id.len().min(57) + 6);
    label.push_str("kanna-");
    for character in peer_id.chars() {
        if label.len() >= 63 {
            break;
        }

        let normalized = match character {
            'a'..='z' | '0'..='9' => character,
            'A'..='Z' => character.to_ascii_lowercase(),
            _ => '-',
        };
        label.push(normalized);
    }

    if label.ends_with('-') {
        label.push('0');
    }

    Ok(format!("{label}.local."))
}

pub(crate) fn validate_peer_id(peer_id: &str) -> Result<(), DiscoveryError> {
    if peer_id.is_empty() {
        return Err(DiscoveryError::InvalidPeerId);
    }

    if !peer_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(DiscoveryError::InvalidPeerId);
    }

    Ok(())
}

fn validate_display_name(display_name: &str) -> Result<(), DiscoveryError> {
    if display_name.trim().is_empty() || display_name.chars().any(char::is_control) {
        return Err(DiscoveryError::InvalidDisplayName);
    }

    Ok(())
}

fn validate_public_key(public_key: &str) -> Result<(), DiscoveryError> {
    if public_key.trim().is_empty() || public_key.chars().any(char::is_control) {
        return Err(DiscoveryError::InvalidPublicKey);
    }

    Ok(())
}

fn validate_protocol_version(protocol_version: u32) -> Result<(), DiscoveryError> {
    if protocol_version == 0 {
        return Err(DiscoveryError::InvalidProtocolVersion(
            protocol_version.to_string(),
        ));
    }

    Ok(())
}

fn read_txt_property(
    service: &ResolvedService,
    key: &'static str,
) -> Result<(String, String), DiscoveryError> {
    let value = service
        .get_property_val_str(key)
        .ok_or(DiscoveryError::MissingField(key))?;
    Ok((key.to_owned(), value.to_owned()))
}

fn txt_record_from_service_info(
    service: &ServiceInfo,
) -> Result<BTreeMap<String, String>, DiscoveryError> {
    Ok(BTreeMap::from([
        read_service_info_property(service, PEER_ID_KEY)?,
        read_service_info_property(service, DISPLAY_NAME_KEY)?,
        read_service_info_property(service, PUBLIC_KEY_KEY)?,
        read_service_info_property(service, PROTOCOL_VERSION_KEY)?,
        read_service_info_property(service, ACCEPTING_TRANSFERS_KEY)?,
    ]))
}

fn read_service_info_property(
    service: &ServiceInfo,
    key: &'static str,
) -> Result<(String, String), DiscoveryError> {
    let value = service
        .get_property_val_str(key)
        .ok_or(DiscoveryError::MissingField(key))?;
    Ok((key.to_owned(), value.to_owned()))
}

fn select_endpoint_socket_addr(service: &ResolvedService) -> Result<SocketAddr, DiscoveryError> {
    let port = service.get_port();
    service
        .get_addresses()
        .iter()
        .find_map(preferred_address)
        .or_else(|| {
            service
                .get_addresses()
                .iter()
                .find_map(non_loopback_address)
        })
        .or_else(|| service.get_addresses().iter().next().map(scoped_ip_addr))
        .ok_or(DiscoveryError::MissingAddress)
        .map(|(ip, scope_id)| socket_addr_with_scope(ip, port, scope_id))
}

fn select_service_info_address(service: &ServiceInfo) -> Result<IpAddr, DiscoveryError> {
    service
        .get_addresses_v4()
        .into_iter()
        .next()
        .copied()
        .map(IpAddr::V4)
        .or_else(|| service.get_addresses().iter().next().copied())
        .ok_or(DiscoveryError::MissingAddress)
}

fn preferred_address(address: &ScopedIp) -> Option<(IpAddr, u32)> {
    match address {
        ScopedIp::V4(v4) if !v4.addr().is_loopback() => Some((IpAddr::V4(*v4.addr()), 0)),
        _ => None,
    }
}

fn non_loopback_address(address: &ScopedIp) -> Option<(IpAddr, u32)> {
    let (ip, scope_id) = scoped_ip_addr(address);
    (!ip.is_loopback()).then_some((ip, scope_id))
}

fn scoped_ip_addr(address: &ScopedIp) -> (IpAddr, u32) {
    match address {
        ScopedIp::V4(v4) => (IpAddr::V4(*v4.addr()), 0),
        ScopedIp::V6(v6) => (IpAddr::V6(*v6.addr()), v6.scope_id().index),
        _ => (address.to_ip_addr(), 0),
    }
}

fn socket_addr_with_scope(ip: IpAddr, port: u16, scope_id: u32) -> SocketAddr {
    match ip {
        IpAddr::V4(addr) => SocketAddr::V4(SocketAddrV4::new(addr, port)),
        IpAddr::V6(addr) => SocketAddr::V6(SocketAddrV6::new(addr, port, 0, scope_id)),
    }
}

fn validate_txt_entries(txt: &BTreeMap<String, String>) -> Result<(), DiscoveryError> {
    for (key, value) in txt {
        let entry_length = key.len() + 1 + value.len();
        if entry_length > 255 {
            return Err(DiscoveryError::TxtEntryTooLong {
                field: key.clone(),
                length: entry_length,
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv6Addr};

    #[test]
    fn socket_addr_preserves_ipv6_scope_id() {
        let link_local = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1);

        assert_eq!(
            socket_addr_with_scope(IpAddr::V6(link_local), 4455, 14).to_string(),
            "[fe80::1%14]:4455"
        );
    }
}
