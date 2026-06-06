use kanna_task_transfer::discovery::{
    encode_txt_record, resolved_service_to_peer_entry, service_info_to_peer_entry, DiscoveryError,
};
use mdns_sd::{ScopedIp, ServiceInfo};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

#[test]
fn resolved_service_maps_txt_metadata_and_prefers_ipv4_endpoints() {
    let txt = encode_txt_record("peer-alpha", "Primary", "pubkey-alpha", 1, true).unwrap();
    let properties = txt.into_iter().collect::<Vec<_>>();
    let info = ServiceInfo::new(
        "_kanna-xfer._tcp.local.",
        "peer-alpha",
        "peer-alpha.local.",
        &[
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 77)),
        ][..],
        4455,
        &properties[..],
    )
    .unwrap();

    let peer = service_info_to_peer_entry(&info).unwrap();
    assert_eq!(peer.peer_id, "peer-alpha");
    assert_eq!(peer.display_name, "Primary");
    assert_eq!(peer.public_key, "pubkey-alpha");
    assert_eq!(peer.protocol_version, 1);
    assert!(peer.accepting_transfers);
    assert_eq!(peer.endpoint, "192.168.1.77:4455");
}

#[test]
fn resolved_service_preserves_scoped_ipv6_endpoint_and_socket_resolution_accepts_it() {
    let txt = encode_txt_record("peer-ipv6", "IPv6 Peer", "pubkey-ipv6", 1, true).unwrap();
    let link_local = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1);
    let scoped_address = scoped_ipv6_address(link_local, 14);
    let properties = txt.into_iter().collect::<Vec<_>>();
    let mut service = ServiceInfo::new(
        "_kanna-xfer._tcp.local.",
        "peer-ipv6",
        "peer-ipv6.local.",
        "127.0.0.1",
        4455,
        &properties[..],
    )
    .unwrap()
    .as_resolved_service();
    service.addresses = HashSet::from([scoped_address]);

    let peer = resolved_service_to_peer_entry(&service).unwrap();

    assert_eq!(peer.endpoint, "[fe80::1%14]:4455");
    let resolved = peer.endpoint.to_socket_addrs().unwrap().collect::<Vec<_>>();
    assert_eq!(
        resolved.as_slice(),
        &[SocketAddr::V6(std::net::SocketAddrV6::new(
            link_local, 4455, 0, 14
        ))]
    );
}

#[test]
fn resolved_service_requires_txt_metadata_and_an_address() {
    let info = ServiceInfo::new(
        "_kanna-xfer._tcp.local.",
        "peer-alpha",
        "peer-alpha.local.",
        "",
        4455,
        &[("peer_id", "peer-alpha")][..],
    )
    .unwrap();

    let error = service_info_to_peer_entry(&info).unwrap_err();
    assert_eq!(error, DiscoveryError::MissingField("display_name"));
}

fn scoped_ipv6_address(ip: Ipv6Addr, scope_id: u32) -> ScopedIp {
    let interface = if_addrs::Interface {
        name: format!("if{scope_id}"),
        addr: if_addrs::IfAddr::V6(if_addrs::Ifv6Addr {
            ip,
            netmask: Ipv6Addr::UNSPECIFIED,
            prefixlen: 64,
            broadcast: None,
        }),
        index: Some(scope_id),
        oper_status: if_addrs::IfOperStatus::Up,
        is_p2p: false,
        #[cfg(windows)]
        adapter_name: format!("adapter-{scope_id}"),
    };

    ScopedIp::from(&interface)
}
