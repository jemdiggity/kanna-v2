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
/// Bound on one `/v1/status` request, so a peer that answers but never closes
/// cannot outlast the readiness deadline that is supposed to contain it.
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

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

    // `server.toml` carries `desktop_secret`, so it is written 0600 like the
    // identity record -- and re-secured on every start, so a file left
    // world-readable by an earlier version does not stay that way.
    let config_path = options.server_config_path();
    config::write_private(
        &config_path,
        config::build_server_config(&options, &identity, cli_bin.as_deref()).as_bytes(),
    )?;

    eprintln!(
        "[worker] data_dir={} daemon={} server={} lan_port={}",
        options.data_dir.display(),
        daemon_bin.display(),
        server_bin.display(),
        options.lan_port()
    );

    // The supervisor records itself so `stop-daemon` can stop supervision
    // before stopping the daemon. Without that ordering, tearing the daemon
    // down races this process's own "the daemon died, replace it" branch and
    // loses. The record is an identity, not a number -- see
    // `SupervisorRecord`.
    let record_path = options.supervisor_record_path();
    SupervisorRecord::of_this_process(&options.data_dir)?.write(&record_path)?;

    let mut daemon = spawn_daemon(&options, &daemon_bin, &server_bin).await?;
    let mut server = start_server(&options, &identity, &server_bin).await?;
    authorize_server(&options, server.pid).await?;

    let result = supervise(
        &options,
        identity,
        daemon_bin,
        server_bin,
        &mut daemon,
        &mut server,
    )
    .await;
    let _ = std::fs::remove_file(&record_path);
    result
}

/// A process this supervisor is responsible for, and the pid it was
/// authorized under.
///
/// `pid` is always the pid doing the work: for a server, the process holding
/// the listening socket. That is the pid handed to the daemon, so it may never
/// be a pid this supervisor merely hopes is the server.
struct Supervised {
    process: SupervisedProcess,
    pid: u32,
}

enum SupervisedProcess {
    /// Spawned by this supervisor, and reaped by it.
    Owned(Child),
    /// Already running when this supervisor started -- because the previous
    /// supervisor was killed and its children were reparented to init. Not
    /// ours to reap, so its exit is observed by asking the kernel whether the
    /// pid is still there.
    Adopted,
}

impl Supervised {
    /// Resolve when this process exits.
    async fn wait(&mut self) -> Result<String, String> {
        let pid = self.pid;
        match &mut self.process {
            SupervisedProcess::Owned(child) => child
                .wait()
                .await
                .map(|status| status.to_string())
                .map_err(|error| format!("failed to reap pid {pid}: {error}")),
            SupervisedProcess::Adopted => {
                // No exit status to reap from a process that is not our child;
                // liveness is all the kernel will tell us about it.
                loop {
                    if !process_is_alive(pid) {
                        return Ok("exited".to_string());
                    }
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
        }
    }

    /// Has it exited already? `None` while it is still running.
    async fn exited(&mut self) -> Result<Option<String>, String> {
        let pid = self.pid;
        match &mut self.process {
            SupervisedProcess::Owned(child) => child
                .try_wait()
                .map(|status| status.map(|status| status.to_string()))
                .map_err(|error| format!("failed to check on pid {pid}: {error}")),
            SupervisedProcess::Adopted => {
                Ok((!process_is_alive(pid)).then(|| "exited".to_string()))
            }
        }
    }

    /// Stop it, and reap it if it is ours.
    async fn stop(&mut self) {
        match &mut self.process {
            SupervisedProcess::Owned(child) => {
                if let Some(pid) = child.id() {
                    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
                }
                let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            SupervisedProcess::Adopted => {
                let pid = self.pid as libc::pid_t;
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        }
    }
}

fn process_is_alive(pid: u32) -> bool {
    pid > 1 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
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
    options: &Options,
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
                match spawn_daemon(options, &daemon_bin, &server_bin).await {
                    Ok(replacement) => {
                        // The old daemon exits once it has handed its sessions
                        // over; reap it so it does not linger as a zombie.
                        let _ = daemon.wait().await;
                        *daemon = replacement;
                        if let Err(error) = authorize_server(options, server.pid).await {
                            eprintln!("[worker] could not authorize the server on the new daemon generation: {error}");
                        }
                    }
                    Err(error) => eprintln!("[worker] replacement daemon failed to start: {error}"),
                }
            }
            _ = terminate.recv() => {
                eprintln!("[worker] stopping the server; the daemon and its sessions stay up");
                server.stop().await;
                return Ok(());
            }
            _ = interrupt.recv() => {
                eprintln!("[worker] stopping the server; the daemon and its sessions stay up");
                server.stop().await;
                return Ok(());
            }
            status = server.wait() => {
                let status = status?;
                let delay = server_backoff.next();
                eprintln!("[worker] kanna-server exited ({status}); restarting in {delay:?}");
                tokio::time::sleep(delay).await;
                // Through `start_server`, not `spawn_server`: the port may
                // still be held, and readiness must belong to whatever ends up
                // actually serving.
                *server = start_server(options, &identity, &server_bin).await?;
                authorize_server(options, server.pid).await?;
                server_backoff.reset();
            }
            status = daemon.wait() => {
                // A daemon that was replaced by a successor exits cleanly and
                // its sessions live on inside the successor, so respawning
                // blindly would start a third generation. Only replace it when
                // nothing is serving the socket.
                let status = status?;
                if let Ok(client) = DaemonClient::connect(&options.daemon_socket_path()).await {
                    eprintln!("[worker] a successor daemon is already serving; adopting it");
                    *daemon = Supervised {
                        pid: client.connected_pid(),
                        process: SupervisedProcess::Adopted,
                    };
                    if let Err(error) = authorize_server(options, server.pid).await {
                        eprintln!("[worker] could not authorize the server on the successor: {error}");
                    }
                    continue;
                }
                eprintln!("[worker] kanna-daemon exited ({status}) with nothing serving; respawning");
                // A respawn that cannot succeed is fatal: looping here would
                // hold the select and make this process deaf to the signal
                // that would otherwise stop it.
                *daemon = spawn_daemon(options, &daemon_bin, &server_bin).await?;
                authorize_server(options, server.pid).await?;
            }
        }
    }
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
    Ok(Supervised {
        process: SupervisedProcess::Owned(child),
        pid,
    })
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

/// What to do about a server that is already answering on this worker's port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExistingServer {
    /// It reports this worker's own desktop identity, so it is this worker's
    /// server, left behind by a supervisor that was killed. Adopt it.
    Adopt,
    /// It belongs to another desktop, or will not say who it is. Stop it
    /// before binding the port: a server this worker cannot identify must
    /// never be authorized on this worker's daemon.
    Replace,
}

fn classify_existing_server(
    status: &serde_json::Value,
    expected_desktop_id: &str,
) -> ExistingServer {
    match status.get("desktopId").and_then(serde_json::Value::as_str) {
        Some(id) if id == expected_desktop_id => ExistingServer::Adopt,
        _ => ExistingServer::Replace,
    }
}

/// Bring this worker's server up, adopting one that is already serving.
///
/// This is not "spawn and wait for `/v1/status`", and the difference is a
/// measured failure rather than caution. A supervisor that is SIGKILLed leaves
/// its daemon and server running, reparented to init; the unit restarts the
/// supervisor two seconds later and it starts against a port that is still
/// bound. Spawning blindly there produces a child that dies on `Address
/// already in use` -- but not before its `human_control::serve()` has unlinked
/// and rebound the human-control socket, cutting the *surviving* server off
/// from `adopt_desktop`. A readiness probe that only asks "does `/v1/status`
/// answer" then reads the orphan's answer and reports the dead child as
/// serving, so the pid this supervisor authorizes on the daemon holds nothing
/// and every task input is refused with "system-input peer is not the pinned
/// kanna-server process". Under `Restart=on-failure` that repeats forever, a
/// daemon generation per round.
///
/// The shape mirrors the desktop's `MobileServerManager::start`, which faces
/// the same question every launch.
async fn start_server(
    options: &Options,
    identity: &Identity,
    server_bin: &Path,
) -> Result<Supervised, String> {
    if let Some(status) = server_status(options).await {
        match classify_existing_server(&status, &identity.desktop_id) {
            ExistingServer::Adopt => {
                // The orphan still owns the human-control socket, so it can
                // still be adopted -- which is exactly why nothing may be
                // spawned before this decision.
                adopt_desktop(options).await?;
                let pid = kanna_server_process::listening_server_pid(options.lan_port()).await?;
                eprintln!(
                    "[worker] adopted the kanna-server already serving on {} (pid {pid})",
                    options.api_base_url()
                );
                return Ok(Supervised {
                    process: SupervisedProcess::Adopted,
                    pid,
                });
            }
            ExistingServer::Replace => {
                eprintln!(
                    "[worker] a kanna-server this worker does not own holds port {}; stopping it",
                    options.lan_port()
                );
                kanna_server_process::stop_server_on_port(options.lan_port()).await?;
            }
        }
    }
    spawn_server(options, identity, server_bin).await
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
    let mut server = Supervised {
        process: SupervisedProcess::Owned(child),
        pid,
    };

    if let Err(error) = finish_server_start(options, &mut server).await {
        // Never leave a spawned child behind on a failed start. It holds the
        // log pipe, and on the failure that matters here it is also part-way
        // through rebinding the human-control socket out from under whoever
        // is actually serving.
        server.stop().await;
        return Err(error);
    }
    eprintln!(
        "[worker] kanna-server {pid} is serving on {}",
        options.api_base_url()
    );
    Ok(server)
}

async fn finish_server_start(options: &Options, server: &mut Supervised) -> Result<(), String> {
    wait_for_server(options, server).await?;
    adopt_desktop(options).await
}

/// Readiness that belongs to the process we spawned, not to whoever answers.
async fn wait_for_server(options: &Options, server: &mut Supervised) -> Result<(), String> {
    let url = format!("{}/v1/status", options.api_base_url());
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = server.exited().await? {
            return Err(format!(
                "kanna-server exited ({status}) before it began serving; see {}",
                options.server_log_path().display()
            ));
        }
        if http_get(&url).await.is_some() {
            // The answer has to come from *our* process. An orphan left by a
            // killed supervisor answers this URL just as readily, and
            // believing it is how a dead pid gets authorized on the daemon.
            let listeners = kanna_server_process::server_pids_on_port(options.lan_port()).await?;
            if listeners.contains(&(server.pid as i32)) {
                return Ok(());
            }
            return Err(format!(
                "{url} is answered by {listeners:?}, not by the kanna-server this worker \
                 spawned ({}); see {}",
                server.pid,
                options.server_log_path().display()
            ));
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

/// `/v1/status` decoded, or `None` when nothing answers.
async fn server_status(options: &Options) -> Option<serde_json::Value> {
    let body = http_get(&format!("{}/v1/status", options.api_base_url())).await?;
    serde_json::from_str(&body).ok()
}

/// A one-request HTTP client, returning the body of a 200.
///
/// Deliberately hand-rolled: the only thing the supervisor asks the server is
/// `/v1/status`, and a TLS-capable HTTP stack is a large dependency (and, on
/// Linux, an OpenSSL one) to carry for a loopback GET.
///
/// The request is a *local process* request -- no `Origin`, no `Sec-Fetch-*`
/// headers -- so `lan_trust` classifies it as such and it needs no credential,
/// which is the same standing the CLI and MCP server have.
async fn http_get(url: &str) -> Option<String> {
    // Bounded as a whole: this reads to EOF, and a peer that answered but did
    // not close would otherwise park the supervisor's readiness loop past the
    // deadline that loop thinks it is enforcing.
    tokio::time::timeout(HTTP_TIMEOUT, http_get_inner(url))
        .await
        .ok()
        .flatten()
}

async fn http_get_inner(url: &str) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (authority, path) = url.strip_prefix("http://").map(|rest| {
        let split = rest.find('/').unwrap_or(rest.len());
        (&rest[..split], &rest[split..])
    })?;
    let mut stream = tokio::net::TcpStream::connect(authority).await.ok()?;
    let request = format!("GET {path} HTTP/1.0\r\nHost: {authority}\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    // HTTP/1.0 with no keep-alive: the server closes when it is done, so the
    // body is everything up to EOF.
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.ok()?;
    if !(response.starts_with(b"HTTP/1.0 200") || response.starts_with(b"HTTP/1.1 200")) {
        return None;
    }
    let body_start = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?
        + 4;
    String::from_utf8(response[body_start..].to_vec()).ok()
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
        .send_command(
            &serde_json::json!({ "type": "AuthorizeServer", "pid": server_pid }).to_string(),
        )
        .await?;
    let response = client.read_event().await?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("failed to decode the daemon's reply: {error}"))?;
    match parsed.get("type").and_then(serde_json::Value::as_str) {
        Some("Ok") => Ok(()),
        _ => Err(format!(
            "daemon refused to authorize the server: {response}"
        )),
    }
}

/// Stop the daemon and every session it owns. This is the explicit teardown;
/// nothing else in the worker does it, because a stopped supervisor is not a
/// reason to kill an operator's agents.
///
/// Supervision is stopped **first**. A running supervisor treats a daemon
/// that exits as one to replace, so stopping the daemon underneath it just
/// produces another one; SIGTERM to the supervisor stops the server and
/// leaves the daemon, which is exactly the state to tear down from.
///
/// The daemon itself has no shutdown *command* -- terminating it is an act on
/// a process, not a request on its protocol -- so its pid comes from whoever
/// is actually serving the socket rather than from a pid file, which a crashed
/// generation can leave behind pointing at a recycled pid.
pub async fn stop_daemon(options: &Options) -> Result<(), String> {
    stop_supervisor(options).await;
    let socket_path = options.daemon_socket_path();
    let client = DaemonClient::connect(&socket_path)
        .await
        .map_err(|error| format!("no daemon is serving {}: {error}", socket_path.display()))?;
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

/// What a running supervisor records about itself, so that a later
/// `stop-daemon` can prove which process to signal.
///
/// A bare pid is not a process. The pid a stale record names may since have
/// been recycled by anything at all -- reproduced with a `/bin/sleep` whose
/// pid was placed in an isolated record, which `stop-daemon` then killed and
/// reported as "no daemon". So the record carries the start-time identity that
/// makes `(pid, start)` unique, the executable that pid must still be running,
/// and the instance it was written for, and every one of them is re-checked
/// against the live process before a signal is sent.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct SupervisorRecord {
    pid: u32,
    /// `(pid, start)` is the identity a recycled pid cannot forge.
    start: kanna_daemon::proc_info::StartTime,
    /// The kernel-derived path of the supervisor's own binary.
    executable: PathBuf,
    /// The instance this supervisor is supervising, so a record copied into
    /// another data directory cannot aim a signal at an unrelated process.
    data_dir: PathBuf,
}

impl SupervisorRecord {
    fn of_this_process(data_dir: &Path) -> Result<Self, String> {
        let pid = std::process::id();
        let start = kanna_daemon::proc_info::process_info(pid as libc::pid_t)
            .ok_or_else(|| "cannot read this supervisor's own process identity".to_string())?
            .start;
        let executable =
            std::env::current_exe().map_err(|error| format!("cannot resolve own path: {error}"))?;
        Ok(Self {
            pid,
            start,
            executable,
            data_dir: data_dir.to_path_buf(),
        })
    }

    fn write(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("failed to encode the supervisor record: {error}"))?;
        std::fs::write(path, bytes)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))
    }

    fn read(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }
}

/// Whether a recorded supervisor may be signaled.
///
/// Split out from the signalling so the decision is testable on its own: it is
/// the part that must never say yes about a process somebody else owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupervisorSignal {
    Signal,
    Refuse,
}

fn classify_supervisor_record(
    record: &SupervisorRecord,
    data_dir: &Path,
    own_pid: u32,
    own_executable: &Path,
    live_start: Option<kanna_daemon::proc_info::StartTime>,
    live_executable: Option<&Path>,
) -> SupervisorSignal {
    // `pid_t` is signed and `kill` reads 0 and negatives as "a process group",
    // so a record naming one of them would broadcast a signal rather than
    // aim it. Anything that does not round-trip through `pid_t` is refused
    // outright rather than truncated into some other process.
    let valid_pid = record.pid > 1 && i32::try_from(record.pid).is_ok();
    let same_instance = record.data_dir == data_dir;
    let not_ourselves = record.pid != own_pid;
    // The recorded binary must be this same `kanna-worker`, and the live
    // process must still be running it. The first refuses a stale record that
    // names some other program; the second refuses a pid that has been
    // recycled into one.
    let recorded_is_this_worker = record.executable == own_executable;
    let still_the_same_binary = live_executable == Some(record.executable.as_path());
    let not_recycled = live_start == Some(record.start);

    if valid_pid
        && same_instance
        && not_ourselves
        && recorded_is_this_worker
        && still_the_same_binary
        && not_recycled
    {
        SupervisorSignal::Signal
    } else {
        SupervisorSignal::Refuse
    }
}

/// Ask a running supervisor for this data directory to stop supervising.
///
/// Best effort: there may not be one, and its SIGTERM path deliberately leaves
/// the daemon running, so this only has to stop the respawns.
async fn stop_supervisor(options: &Options) {
    let path = options.supervisor_record_path();
    let Some(record) = SupervisorRecord::read(&path) else {
        return;
    };
    let Ok(own_executable) = std::env::current_exe() else {
        return;
    };
    let live = kanna_daemon::proc_info::process_info(record.pid as libc::pid_t);
    let live_executable =
        kanna_daemon::proc_info::process_executable_path(record.pid as libc::pid_t);
    if classify_supervisor_record(
        &record,
        &options.data_dir,
        std::process::id(),
        &own_executable,
        live.map(|info| info.start),
        live_executable.as_deref(),
    ) == SupervisorSignal::Refuse
    {
        // Not proof of a running supervisor, so nothing is signaled. A stale
        // record is the normal reason to land here.
        let _ = std::fs::remove_file(&path);
        return;
    }

    let pid = record.pid;
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
        return;
    }
    eprintln!("[worker] asked supervisor {pid} to stop before tearing the daemon down");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while kanna_daemon::proc_info::identity_matches(pid as libc::pid_t, record.start) {
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
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
    async fn http_get_returns_the_body_of_a_200_and_nothing_else() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (reply, expected) in [
            (
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"desktopId\":\"w-1\"}",
                Some("{\"desktopId\":\"w-1\"}".to_string()),
            ),
            ("HTTP/1.1 503 Service Unavailable\r\n\r\n", None),
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
                http_get(&format!("http://127.0.0.1:{port}/v1/status")).await,
                expected
            );
            let _ = serve.await;
        }
    }

    /// `stop-daemon` must not aim a signal at a number. Every one of these is
    /// a way a recorded pid stops being the supervisor that wrote it.
    #[test]
    fn a_supervisor_is_signaled_only_when_the_record_still_describes_it() {
        let data_dir = Path::new("/data/Kanna");
        let exe = PathBuf::from("/opt/kanna/bin/kanna-worker");
        let record = SupervisorRecord {
            pid: 4242,
            start: (99, 0),
            executable: exe.clone(),
            data_dir: data_dir.to_path_buf(),
        };
        let classify = |record: &SupervisorRecord,
                        dir: &Path,
                        own_pid: u32,
                        live_start: Option<(u64, u64)>,
                        live_exe: Option<&Path>| {
            classify_supervisor_record(record, dir, own_pid, &exe, live_start, live_exe)
        };

        assert_eq!(
            classify(&record, data_dir, 1, Some((99, 0)), Some(&exe)),
            SupervisorSignal::Signal
        );

        // A pid recycled into another process: the start time no longer
        // matches, which is the whole reason the record carries one.
        assert_eq!(
            classify(&record, data_dir, 1, Some((100, 0)), Some(&exe)),
            SupervisorSignal::Refuse
        );
        // Dead, so there is nothing to signal.
        assert_eq!(
            classify(&record, data_dir, 1, None, None),
            SupervisorSignal::Refuse
        );
        // That pid is now running something else -- the reproduced case was a
        // reviewer's `/bin/sleep`, which must survive.
        assert_eq!(
            classify(
                &record,
                data_dir,
                1,
                Some((99, 0)),
                Some(Path::new("/bin/sleep"))
            ),
            SupervisorSignal::Refuse
        );
        // A record naming some other program is refused before the live
        // process is even consulted.
        let foreign = SupervisorRecord {
            executable: PathBuf::from("/bin/sleep"),
            ..record.clone()
        };
        assert_eq!(
            classify(
                &foreign,
                data_dir,
                1,
                Some((99, 0)),
                Some(Path::new("/bin/sleep"))
            ),
            SupervisorSignal::Refuse
        );
        // A record copied into another instance's directory.
        assert_eq!(
            classify(
                &record,
                Path::new("/data/Other"),
                1,
                Some((99, 0)),
                Some(&exe)
            ),
            SupervisorSignal::Refuse
        );
        // Ourselves.
        assert_eq!(
            classify(&record, data_dir, 4242, Some((99, 0)), Some(&exe)),
            SupervisorSignal::Refuse
        );
        // Special and out-of-range pids: `kill` reads 0 and negatives as a
        // process *group*, so these would broadcast rather than aim.
        for pid in [0, 1, u32::MAX, i32::MAX as u32 + 1] {
            let odd = SupervisorRecord {
                pid,
                ..record.clone()
            };
            assert_eq!(
                classify(&odd, data_dir, 7, Some((99, 0)), Some(&exe)),
                SupervisorSignal::Refuse,
                "pid {pid} must never be signaled"
            );
        }
    }

    /// The decision the crash-recovery path turns on: a server already on this
    /// worker's port is only adopted when it says it is *this* worker's.
    /// Anything else -- another desktop, or a server that will not identify
    /// itself -- is stopped, because a pid this worker cannot attribute must
    /// never be authorized on its daemon.
    #[test]
    fn an_existing_server_is_adopted_only_when_it_reports_this_worker() {
        let status = |value: serde_json::Value| value;

        assert_eq!(
            classify_existing_server(
                &status(serde_json::json!({ "desktopId": "worker-abc" })),
                "worker-abc"
            ),
            ExistingServer::Adopt
        );
        for foreign in [
            serde_json::json!({ "desktopId": "worker-other" }),
            serde_json::json!({ "desktopId": serde_json::Value::Null }),
            serde_json::json!({ "desktopId": 7 }),
            serde_json::json!({}),
        ] {
            assert_eq!(
                classify_existing_server(&status(foreign.clone()), "worker-abc"),
                ExistingServer::Replace,
                "{foreign} must not be adopted"
            );
        }
    }
}
