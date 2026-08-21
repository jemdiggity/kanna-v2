#[cfg(any(test, not(target_os = "macos")))]
use mdns_sd::ServiceInfo;
#[cfg(not(target_os = "macos"))]
use mdns_sd::{DaemonEvent, ServiceDaemon};
#[cfg(any(test, not(target_os = "macos")))]
use std::net::IpAddr;
#[cfg(not(target_os = "macos"))]
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
#[cfg(not(target_os = "macos"))]
use std::thread::JoinHandle;
#[cfg(not(target_os = "macos"))]
use std::time::{Duration, Instant};

pub const MOBILE_BONJOUR_SERVICE_TYPE: &str = "_kanna-mobile._tcp.local.";
// `mdns-sd` has no native interface-notification API. Its platform-neutral
// daemon checks interfaces every five seconds and emits IpAdd/IpDel events;
// the supervisor consumes those events instead of adding another address poll.
// It also exposes no registration-presence query, so a coarse re-registration
// is the only available health check for a silently lost service record.
#[cfg(not(target_os = "macos"))]
const REGISTRATION_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
#[cfg(not(target_os = "macos"))]
const REGISTRATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(not(target_os = "macos"))]
const SUPERVISOR_WAKE_INTERVAL: Duration = Duration::from_secs(1);

#[cfg(target_os = "macos")]
mod macos {
    // Each `mdns_sd::ServiceDaemon` owns raw SO_REUSEPORT UDP/5353 sockets.
    // Several independent Kanna processes therefore compete for multicast
    // packets with one another and with Apple's responder. The DNS-SD API
    // brokers every process through mDNSResponder instead; it is part of
    // libSystem, so signed builds retain no developer-machine dependency.
    use super::MOBILE_BONJOUR_SERVICE_TYPE;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::ptr;
    use std::sync::mpsc::{self, Receiver, SyncSender};
    use std::thread::JoinHandle;
    use std::time::Duration;

    type DnsServiceRef = *mut c_void;
    type DnsServiceFlags = u32;
    type DnsServiceError = i32;
    type DnsServiceRegisterReply = unsafe extern "C" fn(
        DnsServiceRef,
        DnsServiceFlags,
        DnsServiceError,
        *const c_char,
        *const c_char,
        *const c_char,
        *mut c_void,
    );

    const DNS_SERVICE_FLAGS_ADD: DnsServiceFlags = 0x2;
    const DNS_SERVICE_FLAGS_NO_AUTO_RENAME: DnsServiceFlags = 0x8;
    const DNS_SERVICE_ERR_NO_ERROR: DnsServiceError = 0;
    const POLL_INTERVAL_MS: i32 = 250;
    const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(5);
    const RETRY_INTERVAL: Duration = Duration::from_secs(5);

    unsafe extern "C" {
        fn DNSServiceRegister(
            service_ref: *mut DnsServiceRef,
            flags: DnsServiceFlags,
            interface_index: u32,
            name: *const c_char,
            registration_type: *const c_char,
            domain: *const c_char,
            host: *const c_char,
            port: u16,
            txt_len: u16,
            txt_record: *const c_void,
            callback: DnsServiceRegisterReply,
            context: *mut c_void,
        ) -> DnsServiceError;
        fn DNSServiceRefSockFD(service_ref: DnsServiceRef) -> libc::c_int;
        fn DNSServiceProcessResult(service_ref: DnsServiceRef) -> DnsServiceError;
        fn DNSServiceRefDeallocate(service_ref: DnsServiceRef);
    }

    #[derive(Clone)]
    struct Config {
        desktop_name: String,
        desktop_id: String,
        environment: String,
        port: u16,
    }

    enum RegistrationEvent {
        Published { name: String, domain: String },
        Removed,
        Failed(DnsServiceError),
    }

    struct CallbackContext {
        events: mpsc::Sender<RegistrationEvent>,
    }

    unsafe extern "C" fn registration_callback(
        _service_ref: DnsServiceRef,
        flags: DnsServiceFlags,
        error: DnsServiceError,
        name: *const c_char,
        _registration_type: *const c_char,
        domain: *const c_char,
        context: *mut c_void,
    ) {
        if context.is_null() {
            return;
        }
        // SAFETY: `register_once` owns this boxed context until it deallocates
        // the DNSServiceRef, after which no callback can run.
        let callback = unsafe { &*(context.cast::<CallbackContext>()) };
        let event = if error != DNS_SERVICE_ERR_NO_ERROR {
            RegistrationEvent::Failed(error)
        } else if flags & DNS_SERVICE_FLAGS_ADD == 0 {
            RegistrationEvent::Removed
        } else {
            RegistrationEvent::Published {
                // SAFETY: DNSServiceRegister supplies valid callback strings
                // for a successful registration callback.
                name: unsafe { callback_string(name) },
                // SAFETY: Same callback contract as `name` above.
                domain: unsafe { callback_string(domain) },
            }
        };
        let _ = callback.events.send(event);
    }

    unsafe fn callback_string(value: *const c_char) -> String {
        if value.is_null() {
            return String::new();
        }
        // SAFETY: The caller establishes that `value` is a callback-owned,
        // NUL-terminated C string for the duration of this call.
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    }

    enum RunResult {
        Stopped,
        Retry(String),
    }

    pub struct Advertisement {
        stop: SyncSender<()>,
        worker: Option<JoinHandle<()>>,
    }

    impl Advertisement {
        pub fn start(
            desktop_name: &str,
            desktop_id: &str,
            environment: &str,
            port: u16,
        ) -> Result<Self, String> {
            let config = Config {
                desktop_name: desktop_name.to_string(),
                desktop_id: desktop_id.to_string(),
                environment: environment.to_string(),
                port,
            };
            let (stop, stop_receiver) = mpsc::sync_channel(1);
            let (startup, startup_receiver) = mpsc::sync_channel(1);
            let worker = std::thread::Builder::new()
                .name("kanna-mobile-bonjour".to_string())
                .spawn(move || supervise(config, stop_receiver, startup))
                .map_err(|error| format!("failed to start mobile Bonjour supervisor: {error}"))?;

            match startup_receiver.recv_timeout(REGISTRATION_TIMEOUT) {
                Ok(Ok(())) => Ok(Self {
                    stop,
                    worker: Some(worker),
                }),
                Ok(Err(error)) => {
                    let _ = stop.send(());
                    let _ = worker.join();
                    Err(error)
                }
                Err(error) => {
                    let _ = stop.send(());
                    let _ = worker.join();
                    Err(format!(
                        "timed out waiting for observable mobile Bonjour registration: {error}"
                    ))
                }
            }
        }
    }

    impl Drop for Advertisement {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                if worker.join().is_err() {
                    log::warn!("mobile Bonjour supervisor panicked during shutdown");
                }
            }
        }
    }

    fn supervise(config: Config, stop: Receiver<()>, startup: SyncSender<Result<(), String>>) {
        let mut startup = Some(startup);
        loop {
            match register_once(&config, &stop, startup.take()) {
                RunResult::Stopped => return,
                RunResult::Retry(error) => {
                    log::warn!(
                        "mobile Bonjour advertisement failed for {} ({}, {}, port {}): {}; retrying",
                        config.desktop_name,
                        config.desktop_id,
                        config.environment,
                        config.port,
                        error
                    );
                    match stop.recv_timeout(RETRY_INTERVAL) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
            }
        }
    }

    fn register_once(
        config: &Config,
        stop: &Receiver<()>,
        startup: Option<SyncSender<Result<(), String>>>,
    ) -> RunResult {
        let name = match CString::new(config.desktop_id.as_str()) {
            Ok(value) => value,
            Err(error) => return startup_failure(startup, format!("invalid desktop id: {error}")),
        };
        let registration_type =
            match CString::new(MOBILE_BONJOUR_SERVICE_TYPE.trim_end_matches(".local.")) {
                Ok(value) => value,
                Err(error) => {
                    return startup_failure(
                        startup,
                        format!("invalid Bonjour service type: {error}"),
                    );
                }
            };
        let domain = match CString::new("local.") {
            Ok(value) => value,
            Err(error) => {
                return startup_failure(startup, format!("invalid Bonjour domain: {error}"));
            }
        };
        let txt_value = format!("desktopId={}", config.desktop_id);
        if txt_value.len() > u8::MAX as usize {
            return startup_failure(
                startup,
                "desktop id is too long for Bonjour TXT".to_string(),
            );
        }
        let mut txt_record = Vec::with_capacity(txt_value.len() + 1);
        txt_record.push(txt_value.len() as u8);
        txt_record.extend_from_slice(txt_value.as_bytes());
        let (event_sender, event_receiver) = mpsc::channel();
        let context = Box::new(CallbackContext {
            events: event_sender,
        });
        let context_ptr = Box::into_raw(context);
        let mut service_ref: DnsServiceRef = ptr::null_mut();

        // SAFETY: All C strings and TXT bytes remain valid for the duration of
        // the call, which copies them. `context_ptr` remains allocated until
        // after the resulting service reference is deallocated below.
        let error = unsafe {
            DNSServiceRegister(
                &mut service_ref,
                DNS_SERVICE_FLAGS_NO_AUTO_RENAME,
                0,
                name.as_ptr(),
                registration_type.as_ptr(),
                domain.as_ptr(),
                ptr::null(),
                config.port.to_be(),
                txt_record.len() as u16,
                txt_record.as_ptr().cast(),
                registration_callback,
                context_ptr.cast(),
            )
        };
        if error != DNS_SERVICE_ERR_NO_ERROR {
            // SAFETY: DNSServiceRegister failed, so no callback can retain or
            // use the context pointer.
            unsafe { drop(Box::from_raw(context_ptr)) };
            return startup_failure(startup, dns_error("register", error));
        }

        // SAFETY: A successful DNSServiceRegister initialized `service_ref`.
        let socket = unsafe { DNSServiceRefSockFD(service_ref) };
        if socket < 0 {
            // SAFETY: The reference is live and owned by this function.
            unsafe { DNSServiceRefDeallocate(service_ref) };
            // SAFETY: Deallocation prevents future callbacks.
            unsafe { drop(Box::from_raw(context_ptr)) };
            return startup_failure(
                startup,
                "mobile Bonjour registration has no event socket".to_string(),
            );
        }

        let mut startup = startup;
        let result = loop {
            match stop.try_recv() {
                Ok(()) | Err(mpsc::TryRecvError::Disconnected) => {
                    break RunResult::Stopped;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            let mut descriptor = libc::pollfd {
                fd: socket,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: `descriptor` points to one initialized pollfd.
            let poll_result = unsafe { libc::poll(&mut descriptor, 1, POLL_INTERVAL_MS) };
            if poll_result < 0 {
                break RunResult::Retry(std::io::Error::last_os_error().to_string());
            }
            if poll_result > 0 && descriptor.revents & libc::POLLIN != 0 {
                // SAFETY: Only this worker thread processes and deallocates the
                // service reference.
                let process_error = unsafe { DNSServiceProcessResult(service_ref) };
                if process_error != DNS_SERVICE_ERR_NO_ERROR {
                    break RunResult::Retry(dns_error(
                        "process registration result",
                        process_error,
                    ));
                }
            }

            let mut terminal_event = None;
            while let Ok(event) = event_receiver.try_recv() {
                match event {
                    RegistrationEvent::Published { name, domain } => {
                        log::info!(
                            "published mobile Bonjour service {}.{} for {} ({}, {}, port {})",
                            name,
                            domain,
                            config.desktop_name,
                            config.desktop_id,
                            config.environment,
                            config.port
                        );
                        if let Some(sender) = startup.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                    RegistrationEvent::Removed => {
                        terminal_event = Some(RegistrationEvent::Removed);
                        break;
                    }
                    RegistrationEvent::Failed(error) => {
                        terminal_event = Some(RegistrationEvent::Failed(error));
                        break;
                    }
                }
            }
            if let Some(event) = terminal_event {
                break match event {
                    RegistrationEvent::Failed(error) => {
                        RunResult::Retry(dns_error("registration callback", error))
                    }
                    RegistrationEvent::Removed => {
                        RunResult::Retry("registration was removed by mDNSResponder".to_string())
                    }
                    RegistrationEvent::Published { .. } => continue,
                };
            }
        };

        // DNSServiceRefDeallocate closes the mDNSResponder connection, which
        // withdraws the service and its records from all active interfaces.
        // SAFETY: This worker exclusively owns the live reference.
        unsafe { DNSServiceRefDeallocate(service_ref) };
        // SAFETY: Deallocation prevents future callbacks.
        unsafe { drop(Box::from_raw(context_ptr)) };
        result
    }

    fn startup_failure(
        startup: Option<SyncSender<Result<(), String>>>,
        error: String,
    ) -> RunResult {
        if let Some(sender) = startup {
            let _ = sender.send(Err(error.clone()));
        }
        RunResult::Retry(error)
    }

    fn dns_error(action: &str, error: DnsServiceError) -> String {
        format!("failed to {action} through macOS mDNSResponder (DNS-SD error {error})")
    }
}

#[cfg(any(test, not(target_os = "macos")))]
pub fn mobile_service_txt(desktop_id: &str) -> Vec<(&str, &str)> {
    vec![("desktopId", desktop_id)]
}

#[cfg(any(test, not(target_os = "macos")))]
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
#[cfg(any(test, not(target_os = "macos")))]
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

#[cfg(any(test, not(target_os = "macos")))]
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

#[cfg(any(test, not(target_os = "macos")))]
fn is_routable_lan_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
        IpAddr::V6(v6) => {
            !v6.is_loopback() && !v6.is_unspecified() && (v6.segments()[0] & 0xffc0) != 0xfe80
        }
    }
}

#[cfg(any(test, not(target_os = "macos")))]
#[derive(Clone)]
struct AdvertisementConfig {
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    desktop_name: String,
    desktop_id: String,
    port: u16,
}

#[cfg(any(test, not(target_os = "macos")))]
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

#[cfg(any(test, not(target_os = "macos")))]
trait AdvertisementDaemon {
    fn register(&self, service: ServiceInfo) -> Result<(), String>;
    fn shutdown(&self, fullname: &str);
}

#[cfg(not(target_os = "macos"))]
struct MdnsAdvertisementDaemon {
    daemon: ServiceDaemon,
    events: flume::Receiver<DaemonEvent>,
}

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
impl Drop for MdnsAdvertisementDaemon {
    fn drop(&mut self) {
        // `mdns-sd` retains an internal command sender, so dropping the public
        // handle alone does not stop its worker thread.
        let _ = self.daemon.shutdown();
    }
}

#[cfg(any(test, not(target_os = "macos")))]
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

#[cfg(not(target_os = "macos"))]
fn should_stop(stop: &Receiver<()>) -> bool {
    matches!(stop.try_recv(), Ok(()) | Err(TryRecvError::Disconnected))
}

#[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "macos")]
pub use macos::Advertisement as MobileBonjourAdvertisement;

#[cfg(not(target_os = "macos"))]
pub struct MobileBonjourAdvertisement {
    stop: SyncSender<()>,
    supervisor: Option<JoinHandle<()>>,
}

#[cfg(not(target_os = "macos"))]
impl MobileBonjourAdvertisement {
    pub fn start(
        desktop_name: &str,
        desktop_id: &str,
        _environment: &str,
        port: u16,
    ) -> Result<Self, String> {
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

#[cfg(not(target_os = "macos"))]
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
