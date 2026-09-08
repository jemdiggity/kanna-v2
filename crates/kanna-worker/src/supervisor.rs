//! Start the daemon and the server, keep them running, and hold the trust
//! relationship between them.
//!
//! The shape mirrors the desktop app's `daemon_lifecycle` and mobile server
//! manager, because it has to: the daemon's authorization checks are written
//! against a launcher that is the live direct parent of both processes.

use crate::config::{self, Identity, Options};
use kanna_daemon::control_client::DaemonClient;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

/// How long to wait for a spawned process to publish the evidence that it is
/// actually up (the daemon's pid file plus a connectable socket; the server's
/// `/v1/status`). These are eventual events with no product latency contract,
/// so the bound only contains a wedged child.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub async fn run(options: Options) -> Result<(), String> {
    std::fs::create_dir_all(&options.data_dir)
        .map_err(|error| format!("failed to create {}: {error}", options.data_dir.display()))?;
    let identity = Identity::load_or_create(&options.identity_path())?;

    let daemon_bin = sidecar("kanna-daemon")?;
    let server_bin = sidecar("kanna-server")?;
    let cli_bin = sidecar("kanna-cli").ok();

    // The database directory is the launcher's to create -- the desktop gets
    // it for free from Tauri's app-data directory, and the server only opens
    // the file it is given.
    let db_path = options.db_path();
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let config_path = options.server_config_path();
    std::fs::write(
        &config_path,
        config::build_server_config(&options, &identity, cli_bin.as_deref()),
    )
    .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;

    eprintln!(
        "[worker] data_dir={} daemon={} server={} lan_port={}",
        options.data_dir.display(),
        daemon_bin.display(),
        server_bin.display(),
        options.lan_port()
    );

    let mut daemon = spawn_daemon(&options, &daemon_bin, &server_bin).await?;
    let mut server = spawn_server(&options, &identity, &server_bin).await?;
    authorize_server(&options, server.pid).await?;

    supervise(options, identity, daemon_bin, server_bin, &mut daemon, &mut server).await
}

/// A supervised child: the handle plus the pid we authorized it under.
struct Supervised {
    child: Child,
    pid: u32,
}

/// The event loop.
///
/// Signals carry the desktop's semantics, deliberately:
/// * `SIGHUP` (systemd `ExecReload`) spawns a **replacement daemon**. The new
///   one hands off every live session from the old one, exactly as launching a
///   newer app does; the successor's parent is this still-live supervisor at
///   the same executable path, so successor authorization passes.
/// * `SIGTERM` stops the *server* and leaves the daemon and its sessions
///   running. That is what closing the desktop app does, and agent sessions
///   surviving their operator's UI is the daemon's whole reason to exist.
///   `kanna-worker stop-daemon` is the explicit full teardown.
async fn supervise(
    options: Options,
    identity: Identity,
    daemon_bin: PathBuf,
    server_bin: PathBuf,
    daemon: &mut Supervised,
    server: &mut Supervised,
) -> Result<(), String> {
    let mut hangup = signal(tokio::signal::unix::SignalKind::hangup())?;
    let mut terminate = signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut server_backoff = Backoff::new();

    loop {
        tokio::select! {
            _ = hangup.recv() => {
                eprintln!("[worker] reload: spawning a replacement daemon");
                match spawn_daemon(&options, &daemon_bin, &server_bin).await {
                    Ok(replacement) => {
                        // The old daemon exits once it has handed its sessions
                        // over; reap it so it does not linger as a zombie.
                        let _ = daemon.child.wait().await;
                        *daemon = replacement;
                        if let Err(error) = authorize_server(&options, server.pid).await {
                            eprintln!("[worker] could not authorize the server on the new daemon generation: {error}");
                        }
                    }
                    Err(error) => eprintln!("[worker] replacement daemon failed to start: {error}"),
                }
            }
            _ = terminate.recv() => {
                eprintln!("[worker] stopping the server; the daemon and its sessions stay up");
                stop_child(&mut server.child).await;
                return Ok(());
            }
            _ = interrupt.recv() => {
                eprintln!("[worker] stopping the server; the daemon and its sessions stay up");
                stop_child(&mut server.child).await;
                return Ok(());
            }
            status = server.child.wait() => {
                let status = status.map_err(|error| format!("failed to reap kanna-server: {error}"))?;
                let delay = server_backoff.next();
                eprintln!("[worker] kanna-server exited ({status}); restarting in {delay:?}");
                tokio::time::sleep(delay).await;
                *server = spawn_server(&options, &identity, &server_bin).await?;
                authorize_server(&options, server.pid).await?;
                server_backoff.reset();
            }
            status = daemon.child.wait() => {
                // A daemon that was replaced by a successor exits cleanly and
                // its sessions live on inside the successor, so respawning
                // blindly would start a third generation. Only replace it when
                // nothing is serving the socket.
                let status = status.map_err(|error| format!("failed to reap kanna-daemon: {error}"))?;
                if DaemonClient::connect(&options.daemon_socket_path()).await.is_ok() {
                    eprintln!("[worker] a successor daemon is already serving; adopting it");
                    daemon.child = spawn_placeholder().await?;
                    if let Err(error) = authorize_server(&options, server.pid).await {
                        eprintln!("[worker] could not authorize the server on the successor: {error}");
                    }
                    continue;
                }
                eprintln!("[worker] kanna-daemon exited ({status}) with nothing serving; respawning");
                *daemon = spawn_daemon(&options, &daemon_bin, &server_bin).await?;
                authorize_server(&options, server.pid).await?;
            }
        }
    }
}

/// A never-exiting stand-in for a daemon this supervisor no longer parents.
///
/// When a daemon hands off to a successor started elsewhere, this process
/// still needs *something* in the `daemon.child.wait()` arm of the select, and
/// it must never be ready. A child that sleeps forever is honest about the
/// fact that we are no longer that daemon's parent.
async fn spawn_placeholder() -> Result<Child, String> {
    Command::new("/bin/sh")
        .args(["-c", "while :; do sleep 3600; done"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to spawn the daemon placeholder: {error}"))
}

/// Spawn a daemon generation.
///
/// Always spawns, never "checks first": if one is already running the new
/// daemon performs a handoff and the old one exits. That is the daemon's own
/// invariant, and short-circuiting it is how sessions get orphaned.
async fn spawn_daemon(
    options: &Options,
    daemon_bin: &Path,
    server_bin: &Path,
) -> Result<Supervised, String> {
    let previous_pid = read_pid(&options.daemon_pid_path());

    let mut command = Command::new(daemon_bin);
    kanna_daemon::subprocess_env::apply_child_env(
        &mut command,
        [
            (
                "KANNA_DAEMON_DIR".to_string(),
                options.data_dir.to_string_lossy().into_owned(),
            ),
            (
                "KANNA_SERVER_EXECUTABLE".to_string(),
                server_bin.to_string_lossy().into_owned(),
            ),
        ],
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // `setsid` gives the daemon its own session, so a signal aimed at this
    // supervisor's process group never reaches it -- including the Ctrl-C that
    // would otherwise kill every agent session on the machine.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|error| format!("failed to spawn kanna-daemon: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "spawned kanna-daemon has no process id".to_string())?;

    wait_for_daemon(options, pid, previous_pid).await?;
    eprintln!("[worker] daemon generation {pid} is serving");
    Ok(Supervised { child, pid })
}

/// Readiness is the pid file **and** a connectable socket whose peer is that
/// pid: the pid file is written just before the socket is bound, so on its own
/// it is not readiness, and a socket alone could be the previous generation's.
async fn wait_for_daemon(
    options: &Options,
    pid: u32,
    previous_pid: Option<u32>,
) -> Result<(), String> {
    let socket_path = options.daemon_socket_path();
    let pid_path = options.daemon_pid_path();
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(published) = read_pid(&pid_path) {
            if published == pid {
                if let Ok(client) = DaemonClient::connect(&socket_path).await {
                    if client.connected_pid() == pid {
                        return Ok(());
                    }
                }
            } else if Some(published) != previous_pid && previous_pid.is_some() {
                // Another generation won the race. It is still a live daemon,
                // so this is not a failure -- the caller authorizes against
                // whatever is serving.
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "daemon {pid} never published a connectable socket at {}",
                socket_path.display()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn spawn_server(
    options: &Options,
    identity: &Identity,
    server_bin: &Path,
) -> Result<Supervised, String> {
    let own_exe =
        std::env::current_exe().map_err(|error| format!("cannot resolve own path: {error}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(options.server_log_path())
        .map_err(|error| format!("failed to open the server log: {error}"))?;

    let child = Command::new(server_bin)
        .env("KANNA_SERVER_CONFIG", options.server_config_path())
        // The server's operator bootstrap requires the launcher's identity:
        // it is admitted only as a direct child of the daemon's pinned parent,
        // which is this process.
        .env("KANNA_DESKTOP_EXECUTABLE", &own_exe)
        .envs(config::transfer_identity_env(options, identity))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|error| format!("failed to spawn kanna-server: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "spawned kanna-server has no process id".to_string())?;

    wait_for_server(options).await?;
    adopt_desktop(options).await?;
    eprintln!("[worker] kanna-server {pid} is serving on {}", options.api_base_url());
    Ok(Supervised { child, pid })
}

async fn wait_for_server(options: &Options) -> Result<(), String> {
    let url = format!("{}/v1/status", options.api_base_url());
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if http_get_ok(&url).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "kanna-server never answered {url}; see {}",
                options.server_log_path().display()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// A one-request HTTP client.
///
/// Deliberately hand-rolled: the only thing the supervisor asks the server is
/// "are you up", and a TLS-capable HTTP stack is a large dependency (and, on
/// Linux, an OpenSSL one) to carry for a loopback GET.
///
/// The request is a *local process* request -- no `Origin`, no `Sec-Fetch-*`
/// headers -- so `lan_trust` classifies it as such and it needs no credential,
/// which is the same standing the CLI and MCP server have.
async fn http_get_ok(url: &str) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let Some((authority, path)) = url.strip_prefix("http://").and_then(|rest| {
        let split = rest.find('/').unwrap_or(rest.len());
        Some((&rest[..split], &rest[split..]))
    }) else {
        return false;
    };
    let Ok(mut stream) = tokio::net::TcpStream::connect(authority).await else {
        return false;
    };
    let request = format!("GET {path} HTTP/1.0\r\nHost: {authority}\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    // A partial read is enough: only the status line is being inspected, and
    // waiting for EOF would depend on how the peer closes.
    let mut response = vec![0u8; 64];
    let Ok(read) = stream.read(&mut response).await else {
        return false;
    };
    response.truncate(read);
    response.starts_with(b"HTTP/1.0 200") || response.starts_with(b"HTTP/1.1 200")
}

/// Tell the server which process is its desktop.
///
/// The server pins this supervisor as its operator here; without it the LAN
/// API's human-control surface has no desktop to answer for.
async fn adopt_desktop(options: &Options) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let socket_path = options.human_control_socket_path();
    let mut stream = tokio::net::UnixStream::connect(&socket_path)
        .await
        .map_err(|error| {
            format!(
                "failed to reach the human-control socket at {}: {error}",
                socket_path.display()
            )
        })?;
    stream
        .write_all(b"{\"action\":\"adopt_desktop\"}\n")
        .await
        .map_err(|error| format!("failed to send adopt_desktop: {error}"))?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .map_err(|error| format!("failed to read the adopt_desktop response: {error}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("failed to decode the adopt_desktop response: {error}"))?;
    if parsed.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(format!("adopt_desktop was refused: {}", response.trim()))
    }
}

/// Authorize this server generation on the current daemon generation.
///
/// Repeated after every daemon replacement, because authorization is scoped to
/// a generation: a successor daemon has never heard of the running server.
async fn authorize_server(options: &Options, server_pid: u32) -> Result<(), String> {
    let mut client = DaemonClient::connect(&options.daemon_socket_path()).await?;
    client
        .send_command(&serde_json::json!({ "type": "AuthorizeServer", "pid": server_pid }).to_string())
        .await?;
    let response = client.read_event().await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("failed to decode the daemon's reply: {error}"))?;
    match parsed.get("type").and_then(serde_json::Value::as_str) {
        Some("Ok") => Ok(()),
        _ => Err(format!("daemon refused to authorize the server: {response}")),
    }
}

/// Stop the daemon and every session it owns. This is the explicit teardown;
/// nothing else in the worker does it, because a stopped supervisor is not a
/// reason to kill an operator's agents.
///
/// The daemon has no shutdown *command* -- terminating it is an act on a
/// process, not a request on its protocol -- so the pid is taken from whoever
/// is actually serving the socket rather than from the pid file, which a
/// crashed generation can leave behind pointing at a recycled pid.
pub async fn stop_daemon(options: &Options) -> Result<(), String> {
    let socket_path = options.daemon_socket_path();
    let client = DaemonClient::connect(&socket_path).await.map_err(|error| {
        format!(
            "no daemon is serving {}: {error}",
            socket_path.display()
        )
    })?;
    let pid = client.connected_pid();
    drop(client);
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
        return Err(format!(
            "failed to signal daemon {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    eprintln!("[worker] asked daemon {pid} to stop");
    Ok(())
}

async fn stop_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn signal(kind: tokio::signal::unix::SignalKind) -> Result<tokio::signal::unix::Signal, String> {
    tokio::signal::unix::signal(kind)
        .map_err(|error| format!("failed to install a signal handler: {error}"))
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
}

/// Find a sidecar beside this executable, the way the desktop app does.
fn sidecar(name: &str) -> Result<PathBuf, String> {
    kanna_runtime_defaults::resolve_binary_from_candidates(
        name,
        kanna_runtime_defaults::sidecar_candidates(name),
        |_| Err(format!("{name} was not found beside kanna-worker")),
    )
    .map(PathBuf::from)
}

/// Restart backoff for the server: immediate for the first failure, then
/// doubling to a ceiling, so a server that cannot start does not spin.
struct Backoff {
    next: Duration,
}

impl Backoff {
    fn new() -> Self {
        Self {
            next: Duration::from_millis(200),
        }
    }

    fn next(&mut self) -> Duration {
        let delay = self.next;
        self.next = std::cmp::min(self.next * 2, Duration::from_secs(30));
        delay
    }

    fn reset(&mut self) {
        self.next = Duration::from_millis(200);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_a_ceiling_and_resets() {
        let mut backoff = Backoff::new();
        assert_eq!(backoff.next(), Duration::from_millis(200));
        assert_eq!(backoff.next(), Duration::from_millis(400));
        for _ in 0..20 {
            backoff.next();
        }
        assert_eq!(backoff.next(), Duration::from_secs(30));
        backoff.reset();
        assert_eq!(backoff.next(), Duration::from_millis(200));
    }

    #[tokio::test]
    async fn http_get_ok_reads_the_status_line() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (reply, expected) in [
            ("HTTP/1.1 200 OK\r\n\r\n{}", true),
            ("HTTP/1.1 503 Service Unavailable\r\n\r\n", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let serve = tokio::spawn(async move {
                if let Ok((mut stream, _)) = listener.accept().await {
                    // Drain the request before replying. Closing a socket with
                    // unread data queued makes the kernel send RST instead of
                    // FIN, which the client would see as a connection error
                    // rather than as the reply it did receive.
                    let mut request = vec![0u8; 512];
                    let _ = stream.read(&mut request).await;
                    let _ = stream.write_all(reply.as_bytes()).await;
                }
            });
            assert_eq!(
                http_get_ok(&format!("http://127.0.0.1:{port}/v1/status")).await,
                expected
            );
            let _ = serve.await;
        }
    }
}
