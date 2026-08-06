use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceInfo};
use std::net::IpAddr;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const MOBILE_BONJOUR_SERVICE_TYPE: &str = "_kanna-mobile._tcp.local.";
// `mdns-sd` has no native interface-notification API. Its platform-neutral
// daemon checks interfaces every five seconds and emits IpAdd/IpDel events;
// the supervisor consumes those events instead of adding another address poll.
// It also exposes no registration-presence query, so a coarse re-registration
// is the only available health check for a silently lost service record.
const REGISTRATION_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const REGISTRATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const SUPERVISOR_WAKE_INTERVAL: Duration = Duration::from_secs(1);

pub fn mobile_service_txt(desktop_id: &str) -> Vec<(&str, &str)> {
    vec![("desktopId", desktop_id)]
}

pub fn build_mobile_service_info(
    desktop_name: &str,
    desktop_id: &str,
    port: u16,
) -> Result<ServiceInfo, String> {
    let addresses = routable_lan_addresses();
    build_mobile_service_info_with_addresses(desktop_id, port, &addresses).inspect(|_| {
        log::info!(
            "configured mobile Bonjour service for {} ({}) on {:?}",
            desktop_name,
            desktop_id,
            addresses
        );
    })
}

/// Advertises only routable LAN addresses. `enable_addr_auto` would publish
/// every interface address — loopback and link-local included — and a phone
/// resolving the service hostname then connects to 127.0.0.1 or an
/// unreachable fe80 address and times out. (The iOS Simulator masked this:
/// there, loopback really is the desktop.)
fn build_mobile_service_info_with_addresses(
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

#[derive(Clone)]
struct AdvertisementConfig {
    desktop_name: String,
    desktop_id: String,
    port: u16,
}

impl AdvertisementConfig {
    fn new(desktop_name: &str, desktop_id: &str, port: u16) -> Self {
        Self {
            desktop_name: desktop_name.to_string(),
            desktop_id: desktop_id.to_string(),
            port,
        }
    }

    fn service_info(&self, addresses: &[IpAddr]) -> Result<ServiceInfo, String> {
        build_mobile_service_info_with_addresses(&self.desktop_id, self.port, addresses)
    }
}

trait AdvertisementDaemon {
    fn register(&self, service: ServiceInfo) -> Result<(), String>;
    fn shutdown(&self, fullname: &str);
}

struct MdnsAdvertisementDaemon {
    daemon: ServiceDaemon,
    events: flume::Receiver<DaemonEvent>,
}

impl MdnsAdvertisementDaemon {
    fn new() -> Result<Self, String> {
        let daemon = ServiceDaemon::new()
            .map_err(|error| format!("failed to start mDNS daemon: {error}"))?;
        let events = daemon
            .monitor()
            .map_err(|error| format!("failed to monitor mDNS daemon: {error}"))?;
        Ok(Self { daemon, events })
    }
}

impl AdvertisementDaemon for MdnsAdvertisementDaemon {
    fn register(&self, service: ServiceInfo) -> Result<(), String> {
        self.daemon
            .register(service)
            .map_err(|error| format!("failed to register mobile Bonjour service: {error}"))
    }

    fn shutdown(&self, fullname: &str) {
        let _ = self.daemon.unregister(fullname);
        let _ = self.daemon.shutdown();
    }
}

impl Drop for MdnsAdvertisementDaemon {
    fn drop(&mut self) {
        // `mdns-sd` retains an internal command sender, so dropping the public
        // handle alone does not stop its worker thread.
        let _ = self.daemon.shutdown();
    }
}

fn refresh_registration_with_recovery<D, F>(
    daemon: &mut D,
    mut create_daemon: F,
    config: &AdvertisementConfig,
    addresses: &[IpAddr],
) -> Result<(), String>
where
    D: AdvertisementDaemon,
    F: FnMut() -> Result<D, String>,
{
    let service = config.service_info(addresses)?;
    let fullname = service.get_fullname().to_string();
    match daemon.register(service) {
        Ok(()) => Ok(()),
        Err(registration_error) => {
            log::warn!(
                "mobile Bonjour re-registration failed; recreating mDNS daemon: {}",
                registration_error
            );
            let replacement = create_daemon()?;
            replacement.register(config.service_info(addresses)?)?;
            daemon.shutdown(&fullname);
            *daemon = replacement;
            Ok(())
        }
    }
}

fn should_stop(stop: &Receiver<()>) -> bool {
    matches!(stop.try_recv(), Ok(()) | Err(TryRecvError::Disconnected))
}

fn supervise_advertisement(
    mut daemon: MdnsAdvertisementDaemon,
    config: AdvertisementConfig,
    fullname: String,
    stop: Receiver<()>,
) {
    let mut next_refresh = Instant::now() + REGISTRATION_REFRESH_INTERVAL;

    loop {
        if should_stop(&stop) {
            break;
        }

        let wait = next_refresh
            .saturating_duration_since(Instant::now())
            .min(SUPERVISOR_WAKE_INTERVAL);
        let refresh_reason = match daemon.events.recv_timeout(wait) {
            Ok(DaemonEvent::IpAdd(address)) => Some((format!("address added: {address}"), false)),
            Ok(DaemonEvent::IpDel(address)) => Some((format!("address removed: {address}"), false)),
            Ok(DaemonEvent::Error(error)) => {
                log::warn!("mDNS daemon reported an error: {error}");
                None
            }
            Ok(_) => None,
            Err(flume::RecvTimeoutError::Timeout) if Instant::now() >= next_refresh => {
                Some(("periodic health refresh".to_string(), true))
            }
            Err(flume::RecvTimeoutError::Timeout) => None,
            Err(flume::RecvTimeoutError::Disconnected) => {
                Some(("mDNS daemon event channel disconnected".to_string(), false))
            }
        };

        let Some((reason, periodic)) = refresh_reason else {
            continue;
        };
        let addresses = routable_lan_addresses();
        match refresh_registration_with_recovery(
            &mut daemon,
            MdnsAdvertisementDaemon::new,
            &config,
            &addresses,
        ) {
            Ok(()) => {
                if periodic {
                    log::debug!(
                        "refreshed mobile Bonjour service for {} ({}) on {:?}: {}",
                        config.desktop_name,
                        config.desktop_id,
                        addresses,
                        reason
                    );
                } else {
                    log::info!(
                        "refreshed mobile Bonjour service for {} ({}) on {:?}: {}",
                        config.desktop_name,
                        config.desktop_id,
                        addresses,
                        reason
                    );
                }
                next_refresh = Instant::now() + REGISTRATION_REFRESH_INTERVAL;
            }
            Err(error) => {
                log::warn!(
                    "mobile Bonjour advertisement refresh failed ({}): {}",
                    reason,
                    error
                );
                next_refresh = Instant::now() + REGISTRATION_RETRY_INTERVAL;
            }
        }
    }

    daemon.shutdown(&fullname);
}

pub struct MobileBonjourAdvertisement {
    stop: SyncSender<()>,
    supervisor: Option<JoinHandle<()>>,
}

impl MobileBonjourAdvertisement {
    pub fn start(desktop_name: &str, desktop_id: &str, port: u16) -> Result<Self, String> {
        let config = AdvertisementConfig::new(desktop_name, desktop_id, port);
        let daemon = MdnsAdvertisementDaemon::new()?;
        let service = build_mobile_service_info(desktop_name, desktop_id, port)?;
        let fullname = service.get_fullname().to_string();
        daemon.register(service)?;
        let (stop, stop_receiver) = mpsc::sync_channel(1);
        let supervisor = std::thread::Builder::new()
            .name("kanna-mobile-bonjour".to_string())
            .spawn(move || supervise_advertisement(daemon, config, fullname, stop_receiver))
            .map_err(|error| format!("failed to start mobile Bonjour supervisor: {error}"))?;
        Ok(Self {
            stop,
            supervisor: Some(supervisor),
        })
    }
}

impl Drop for MobileBonjourAdvertisement {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(supervisor) = self.supervisor.take() {
            if supervisor.join().is_err() {
                log::warn!("mobile Bonjour supervisor panicked during shutdown");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeDaemonState {
        created: usize,
        registrations: Vec<Vec<IpAddr>>,
        published: Option<Vec<IpAddr>>,
        shutdowns: usize,
    }

    struct FakeAdvertisementDaemon {
        fail_registration: bool,
        state: Arc<Mutex<FakeDaemonState>>,
    }

    impl AdvertisementDaemon for FakeAdvertisementDaemon {
        fn register(&self, service: ServiceInfo) -> Result<(), String> {
            if self.fail_registration {
                return Err("registration disappeared".to_string());
            }
            let addresses: Vec<IpAddr> = service.get_addresses().iter().copied().collect();
            let mut state = self.state.lock().unwrap();
            state.published = Some(addresses.clone());
            state.registrations.push(addresses);
            Ok(())
        }

        fn shutdown(&self, _fullname: &str) {
            self.state.lock().unwrap().shutdowns += 1;
        }
    }

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
        let info = build_mobile_service_info_with_addresses("desktop-1", 48_120, &[lan]).unwrap();

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

    #[test]
    fn refresh_registration_replaces_stale_advertised_addresses() {
        let state = Arc::new(Mutex::new(FakeDaemonState::default()));
        let mut daemon = FakeAdvertisementDaemon {
            fail_registration: false,
            state: Arc::clone(&state),
        };
        let config = AdvertisementConfig::new("Studio Mac", "desktop-1", 48_120);
        let old_address: IpAddr = "172.16.0.240".parse().unwrap();
        let new_address: IpAddr = "192.168.1.20".parse().unwrap();

        refresh_registration_with_recovery(
            &mut daemon,
            || unreachable!("healthy daemon must not be replaced"),
            &config,
            &[old_address],
        )
        .unwrap();
        refresh_registration_with_recovery(
            &mut daemon,
            || unreachable!("healthy daemon must not be replaced"),
            &config,
            &[new_address],
        )
        .unwrap();

        assert_eq!(
            state.lock().unwrap().registrations,
            vec![vec![old_address], vec![new_address]]
        );
    }

    #[test]
    fn refresh_registration_recreates_a_daemon_that_lost_registration() {
        let state = Arc::new(Mutex::new(FakeDaemonState::default()));
        let mut daemon = FakeAdvertisementDaemon {
            fail_registration: true,
            state: Arc::clone(&state),
        };
        let config = AdvertisementConfig::new("Studio Mac", "desktop-1", 48_120);
        let address: IpAddr = "172.16.0.240".parse().unwrap();
        let factory_state = Arc::clone(&state);

        refresh_registration_with_recovery(
            &mut daemon,
            || {
                factory_state.lock().unwrap().created += 1;
                Ok(FakeAdvertisementDaemon {
                    fail_registration: false,
                    state: Arc::clone(&factory_state),
                })
            },
            &config,
            &[address],
        )
        .unwrap();

        let state = state.lock().unwrap();
        assert_eq!(state.created, 1);
        assert_eq!(state.shutdowns, 1);
        assert_eq!(state.registrations, vec![vec![address]]);
        assert!(!daemon.fail_registration);
    }

    #[test]
    fn refresh_registration_republishes_after_silent_record_loss() {
        let state = Arc::new(Mutex::new(FakeDaemonState::default()));
        let mut daemon = FakeAdvertisementDaemon {
            fail_registration: false,
            state: Arc::clone(&state),
        };
        let config = AdvertisementConfig::new("Studio Mac", "desktop-1", 48_120);
        let address: IpAddr = "172.16.0.240".parse().unwrap();

        refresh_registration_with_recovery(
            &mut daemon,
            || unreachable!("healthy daemon must not be replaced"),
            &config,
            &[address],
        )
        .unwrap();
        state.lock().unwrap().published = None;

        refresh_registration_with_recovery(
            &mut daemon,
            || unreachable!("healthy daemon must not be replaced"),
            &config,
            &[address],
        )
        .unwrap();

        assert_eq!(state.lock().unwrap().published, Some(vec![address]));
    }
}
