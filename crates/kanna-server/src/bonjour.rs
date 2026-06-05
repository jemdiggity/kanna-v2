use mdns_sd::{ServiceDaemon, ServiceInfo};

pub const MOBILE_BONJOUR_SERVICE_TYPE: &str = "_kanna-mobile._tcp.local.";

pub fn mobile_service_txt(desktop_id: &str) -> Vec<(&str, &str)> {
    vec![("desktopId", desktop_id)]
}

pub fn build_mobile_service_info(
    desktop_name: &str,
    desktop_id: &str,
    port: u16,
) -> Result<ServiceInfo, String> {
    ServiceInfo::new(
        MOBILE_BONJOUR_SERVICE_TYPE,
        desktop_id,
        &format!("{desktop_id}.local."),
        "",
        port,
        &mobile_service_txt(desktop_id)[..],
    )
    .map_err(|error| format!("failed to build mobile Bonjour service: {error}"))
    .map(|info| info.enable_addr_auto())
    .inspect(|_| {
        log::info!(
            "configured mobile Bonjour service for {} ({})",
            desktop_name,
            desktop_id
        );
    })
}

pub struct MobileBonjourAdvertisement {
    daemon: ServiceDaemon,
    fullname: String,
}

impl MobileBonjourAdvertisement {
    pub fn start(desktop_name: &str, desktop_id: &str, port: u16) -> Result<Self, String> {
        let daemon =
            ServiceDaemon::new().map_err(|error| format!("failed to start mDNS daemon: {error}"))?;
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
}
