use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

pub const MOBILE_BONJOUR_SERVICE_TYPE: &str = "_kanna-mobile._tcp.local.";

pub fn mobile_service_txt(desktop_id: &str) -> Vec<(&str, &str)> {
    vec![("desktopId", desktop_id)]
}

pub fn build_mobile_service_info(
    desktop_name: &str,
    desktop_id: &str,
    port: u16,
) -> Result<ServiceInfo, String> {
    build_mobile_service_info_with_addresses(
        desktop_name,
        desktop_id,
        port,
        &routable_lan_addresses(),
    )
}

/// Advertises only routable LAN addresses. `enable_addr_auto` would publish
/// every interface address — loopback and link-local included — and a phone
/// resolving the service hostname then connects to 127.0.0.1 or an
/// unreachable fe80 address and times out. (The iOS Simulator masked this:
/// there, loopback really is the desktop.)
fn build_mobile_service_info_with_addresses(
    desktop_name: &str,
    desktop_id: &str,
    port: u16,
    addresses: &[IpAddr],
) -> Result<ServiceInfo, String> {
    ServiceInfo::new(
        MOBILE_BONJOUR_SERVICE_TYPE,
        desktop_id,
        &format!("{desktop_id}.local."),
        addresses,
        port,
        &mobile_service_txt(desktop_id)[..],
    )
    .map_err(|error| format!("failed to build mobile Bonjour service: {error}"))
    .map(|info| {
        if addresses.is_empty() {
            info.enable_addr_auto()
        } else {
            info
        }
    })
    .inspect(|_| {
        log::info!(
            "configured mobile Bonjour service for {} ({}) on {:?}",
            desktop_name,
            desktop_id,
            addresses
        );
    })
}

fn routable_lan_addresses() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .map(|interface| interface.addr.ip())
                .filter(is_routable_lan_address)
                .collect()
        })
        .unwrap_or_default()
}

fn is_routable_lan_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
        IpAddr::V6(v6) => {
            !v6.is_loopback() && !v6.is_unspecified() && (v6.segments()[0] & 0xffc0) != 0xfe80
        }
    }
}

pub struct MobileBonjourAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MobileBonjourAdvertisement {
    pub fn start(desktop_name: &str, desktop_id: &str, port: u16) -> Result<Self, String> {
        let daemon = ServiceDaemon::new()
            .map_err(|error| format!("failed to start mDNS daemon: {error}"))?;
        let service = build_mobile_service_info(desktop_name, desktop_id, port)?;
        let fullname = service.get_fullname().to_string();
        daemon
            .register(service)
            .map_err(|error| format!("failed to register mobile Bonjour service: {error}"))?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for MobileBonjourAdvertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_service_txt_contains_only_desktop_identity() {
        let txt = mobile_service_txt("desktop-1");
        assert_eq!(txt, vec![("desktopId", "desktop-1")]);
    }

    #[test]
    fn mobile_service_type_is_stable() {
        assert_eq!(MOBILE_BONJOUR_SERVICE_TYPE, "_kanna-mobile._tcp.local.");
    }

    #[test]
    fn mobile_service_info_uses_desktop_identity_and_port() {
        let info = build_mobile_service_info("Studio Mac", "desktop-1", 48_120).unwrap();
        assert_eq!(info.get_type(), MOBILE_BONJOUR_SERVICE_TYPE);
        assert_eq!(info.get_fullname(), "desktop-1._kanna-mobile._tcp.local.");
        assert_eq!(info.get_port(), 48_120);
    }

    #[test]
    fn mobile_service_info_advertises_only_the_supplied_addresses() {
        let lan: IpAddr = "172.16.0.240".parse().unwrap();
        let info =
            build_mobile_service_info_with_addresses("Studio Mac", "desktop-1", 48_120, &[lan])
                .unwrap();

        let advertised = info.get_addresses();
        assert!(advertised.contains(&lan));
        assert_eq!(advertised.len(), 1);
    }

    #[test]
    fn routable_filter_rejects_loopback_and_link_local_addresses() {
        let rejected = [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.17.186",
            "::1",
            "::",
            "fe80::470:5183:45bd:9f35",
        ];
        for address in rejected {
            let address: IpAddr = address.parse().unwrap();
            assert!(
                !is_routable_lan_address(&address),
                "{address} must not be advertised"
            );
        }

        let accepted = ["172.16.0.240", "192.168.1.20", "10.0.0.5", "2001:db8::1"];
        for address in accepted {
            let address: IpAddr = address.parse().unwrap();
            assert!(
                is_routable_lan_address(&address),
                "{address} should be advertised"
            );
        }
    }
}
