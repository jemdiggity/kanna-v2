use kanna_daemon::protocol::{Command, Event};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// Bound on one command round-trip. Daemon commands answer in well under a
/// second when healthy; an unbounded await turns a wedged daemon into
/// silently parked work — on 2026-07-24 every stage transition vanished
/// mid-flight awaiting a Kill response that never came, with nothing
/// logged. Generous so that a merely-busy daemon never trips it.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

pub struct DaemonClient {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    daemon_dir: String,
    connected_pid: u32,
    /// Per-round-trip bound; `COMMAND_TIMEOUT` in production, shrinkable in
    /// tests so timeout behavior is verifiable without a 30s stall.
    command_timeout: Duration,
    /// Set after a timeout: the response to the timed-out command may still
    /// arrive and would pair with the wrong request, so the connection is
    /// unusable.
    poisoned: bool,
}

pub struct DaemonClientReader {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
}

pub struct DaemonClientWriter {
    writer: tokio::net::unix::OwnedWriteHalf,
}

#[derive(Debug)]
pub(crate) enum SpawnDeliveryError {
    BeforeSubmission(String),
    AfterSubmission(String),
}

impl std::fmt::Display for SpawnDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforeSubmission(message) | Self::AfterSubmission(message) => {
                formatter.write_str(message)
            }
        }
    }
}

/// Where a `Spawn` request stands relative to the daemon socket.
///
/// A lifecycle operation's `submitted` phase must begin at this boundary and
/// nowhere earlier: everything before the write is a *known* pre-submission
/// failure the next server generation may safely fail, while a crash after it
/// can no longer prove the daemon did not create the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpawnSubmission {
    /// The serialized `Spawn` has been written and flushed to the socket.
    Written,
    /// The daemon answered `RetryOnSuccessor`, which is its proof that the
    /// request had no side effects. The window closes until the replay
    /// against the successor re-opens it.
    WithdrawnBeforeSideEffects,
}

enum ProtectedInputNegotiationError {
    RetryOnSuccessor(String),
    Failed(String),
}

impl DaemonClient {
    pub(crate) fn daemon_dir(&self) -> &str {
        &self.daemon_dir
    }

    pub(crate) fn connected_pid(&self) -> u32 {
        self.connected_pid
    }

    pub async fn connect(daemon_dir: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(daemon_dir));
        let stream = UnixStream::connect(&socket_path).await.map_err(|e| {
            format!(
                "Failed to connect to daemon at {}: {}",
                socket_path.display(),
                e
            )
        })?;
        let connected_pid = peer_pid(&stream)?;
        let (read_half, write_half) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
            daemon_dir: daemon_dir.to_string(),
            connected_pid,
            command_timeout: COMMAND_TIMEOUT,
            poisoned: false,
        })
    }

    /// Shrink the round-trip bound so tests can exercise the timeout path
    /// without waiting out the production duration.
    #[cfg(test)]
    pub(crate) fn set_command_timeout_for_test(&mut self, timeout: Duration) {
        self.command_timeout = timeout;
    }

    #[cfg(test)]
    pub(crate) fn set_connected_pid_for_test(&mut self, pid: u32) {
        self.connected_pid = pid;
    }

    pub async fn send_command(
        &mut self,
        cmd: &Command,
    ) -> Result<Event, Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.send_serialized_command(&json).await
    }

    async fn negotiate_protected_input_once(
        &mut self,
    ) -> Result<(), ProtectedInputNegotiationError> {
        let version = kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION;
        match self
            .send_command(&Command::NegotiateProtectedInput { version })
            .await
            .map_err(|error| {
                ProtectedInputNegotiationError::Failed(format!(
                    "protected-input negotiation failed: {error}"
                ))
            })? {
            Event::ProtectedInputReady {
                version: acknowledged,
            } if acknowledged == version => Ok(()),
            Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
                message,
            } => Err(ProtectedInputNegotiationError::RetryOnSuccessor(message)),
            Event::Error { message, .. } => Err(ProtectedInputNegotiationError::Failed(format!(
                "daemon refused protected-input protocol {version}: {message}"
            ))),
            event => Err(ProtectedInputNegotiationError::Failed(format!(
                "daemon did not acknowledge protected-input protocol {version}: {event:?}"
            ))),
        }
    }

    pub(crate) async fn negotiate_protected_input(&mut self) -> Result<(), String> {
        self.negotiate_protected_input_once()
            .await
            .map_err(|error| match error {
                ProtectedInputNegotiationError::RetryOnSuccessor(message) => {
                    format!("protected-input negotiation requires successor: {message}")
                }
                ProtectedInputNegotiationError::Failed(message) => message,
            })
    }

    pub(crate) async fn send_spawn_command_retrying_successor(
        &mut self,
        cmd: &Command,
    ) -> Result<Event, SpawnDeliveryError> {
        self.send_spawn_command_marking_submission(cmd, &mut |_| {})
            .await
    }

    /// Send a `Spawn` and report the exact socket boundary it crosses.
    ///
    /// `submission` is called with `Written` once the request has been
    /// flushed to the daemon — the first instant at which a lost response
    /// stops proving the session was never created — and with
    /// `WithdrawnBeforeSideEffects` when the daemon answers
    /// `RetryOnSuccessor`, which withdraws that write before the replay.
    pub(crate) async fn send_spawn_command_marking_submission(
        &mut self,
        cmd: &Command,
        submission: &mut (dyn FnMut(SpawnSubmission) + Send),
    ) -> Result<Event, SpawnDeliveryError> {
        debug_assert!(matches!(cmd, Command::Spawn { .. }));
        let previous_pid = self.connected_pid;
        match self.negotiate_protected_input_once().await {
            Ok(()) => {}
            Err(ProtectedInputNegotiationError::RetryOnSuccessor(_)) => {
                let mut successor = wait_for_successor(&self.daemon_dir, previous_pid)
                    .await
                    .map_err(|error| {
                        SpawnDeliveryError::BeforeSubmission(format!(
                            "daemon spawn negotiation could not reach successor: {error}"
                        ))
                    })?;
                successor
                    .negotiate_protected_input_once()
                    .await
                    .map_err(|error| {
                        SpawnDeliveryError::BeforeSubmission(match error {
                            ProtectedInputNegotiationError::RetryOnSuccessor(message) => format!(
                                "successor requested another retry before daemon spawn: {message}"
                            ),
                            ProtectedInputNegotiationError::Failed(message) => message,
                        })
                    })?;
                *self = successor;
            }
            Err(ProtectedInputNegotiationError::Failed(message)) => {
                return Err(SpawnDeliveryError::BeforeSubmission(message));
            }
        }

        let first = self
            .send_command_marking_submission(cmd, submission)
            .await
            .map_err(|error| SpawnDeliveryError::AfterSubmission(error.to_string()))?;
        if !matches!(
            first,
            Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
                ..
            }
        ) {
            return Ok(first);
        }
        submission(SpawnSubmission::WithdrawnBeforeSideEffects);
        let previous_pid = self.connected_pid;
        let mut successor = wait_for_successor(&self.daemon_dir, previous_pid)
            .await
            .map_err(|error| SpawnDeliveryError::BeforeSubmission(error.to_string()))?;
        successor
            .negotiate_protected_input_once()
            .await
            .map_err(|error| {
                SpawnDeliveryError::BeforeSubmission(match error {
                    ProtectedInputNegotiationError::RetryOnSuccessor(message) => {
                        format!("successor requested another retry before daemon spawn: {message}")
                    }
                    ProtectedInputNegotiationError::Failed(message) => message,
                })
            })?;
        *self = successor;
        self.send_command_marking_submission(cmd, submission)
            .await
            .map_err(|error| SpawnDeliveryError::AfterSubmission(error.to_string()))
    }

    async fn send_command_marking_submission(
        &mut self,
        cmd: &Command,
        submission: &mut (dyn FnMut(SpawnSubmission) + Send),
    ) -> Result<Event, Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.send_serialized_command_marking_submission(&json, submission)
            .await
    }

    /// Retry one daemon lifecycle command only when the daemon explicitly
    /// proves it refused before side effects. The command is serialized once,
    /// then replayed byte-for-byte against a different published daemon PID.
    pub async fn send_command_retrying_successor(
        &mut self,
        cmd: &Command,
    ) -> Result<Event, Box<dyn std::error::Error>> {
        if matches!(cmd, Command::Spawn { .. }) {
            return self
                .send_spawn_command_retrying_successor(cmd)
                .await
                .map_err(|error| error.to_string().into());
        }
        let json = serde_json::to_string(cmd)?;
        let first = self.send_serialized_command(&json).await?;
        if !matches!(
            first,
            Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
                ..
            }
        ) {
            return Ok(first);
        }

        let previous_pid = self.connected_pid;
        let successor = wait_for_successor(&self.daemon_dir, previous_pid).await?;
        *self = successor;
        self.send_serialized_command(&json).await
    }

    async fn send_serialized_command(
        &mut self,
        json: &str,
    ) -> Result<Event, Box<dyn std::error::Error>> {
        self.send_serialized_command_marking_submission(json, &mut |_| {})
            .await
    }

    async fn send_serialized_command_marking_submission(
        &mut self,
        json: &str,
        submission: &mut (dyn FnMut(SpawnSubmission) + Send),
    ) -> Result<Event, Box<dyn std::error::Error>> {
        if self.poisoned {
            return Err(
                "daemon connection unusable after an earlier command timeout; reconnect".into(),
            );
        }
        let round_trip = async {
            self.writer.write_all(json.as_bytes()).await?;
            self.writer.write_all(b"\n").await?;
            self.writer.flush().await?;
            submission(SpawnSubmission::Written);
            let mut line = String::new();
            self.reader.read_line(&mut line).await?;
            let event: Event = serde_json::from_str(line.trim())?;
            Ok(event)
        };
        match tokio::time::timeout(self.command_timeout, round_trip).await {
            Ok(result) => result,
            Err(_) => {
                self.poisoned = true;
                Err(format!(
                    "daemon command timed out after {}s (daemon wedged or overloaded)",
                    self.command_timeout.as_secs()
                )
                .into())
            }
        }
    }

    pub async fn read_event(&mut self) -> Result<Event, Box<dyn std::error::Error>> {
        let mut line = String::new();
        self.reader.read_line(&mut line).await?;
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }

    /// Park until the daemon on the other end of this connection stops
    /// serving it, and report why.
    ///
    /// This is how the server learns that a daemon generation ended without
    /// asking anything of the daemon: a connection that never sent
    /// `Subscribe` receives no unsolicited events, so the read completes only
    /// when the daemon closes the socket or exits. Handoff publishes the
    /// successor's pid and binds its socket strictly after the old daemon has
    /// exited, so this fires no later than the successor becomes reachable.
    pub(crate) async fn wait_until_disconnected(&mut self) -> String {
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line).await {
                Ok(0) => return "daemon closed the connection".to_string(),
                Ok(_) => log::debug!(
                    "ignoring unsolicited daemon event on an unsubscribed connection: {}",
                    line.trim()
                ),
                Err(error) => return format!("daemon connection failed: {error}"),
            }
        }
    }

    pub fn into_split(self) -> (DaemonClientReader, DaemonClientWriter) {
        (
            DaemonClientReader {
                reader: self.reader,
            },
            DaemonClientWriter {
                writer: self.writer,
            },
        )
    }
}

pub(crate) async fn wait_for_successor(
    daemon_dir: &str,
    previous_pid: u32,
) -> Result<DaemonClient, Box<dyn std::error::Error>> {
    let pid_path = Path::new(daemon_dir).join("daemon.pid");
    let mut delay = Duration::from_millis(50);
    for _ in 0..20 {
        tokio::time::sleep(delay).await;
        let published_pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<u32>().ok());
        if let Some(published_pid) = published_pid.filter(|pid| *pid != previous_pid) {
            if let Ok(client) = DaemonClient::connect(daemon_dir).await {
                if client.connected_pid == published_pid {
                    return Ok(client);
                }
            }
        }
        delay = std::cmp::min(delay * 2, Duration::from_secs(1));
    }
    Err(
        format!("successor daemon was not published and connectable after pid {previous_pid}")
            .into(),
    )
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> Result<u32, Box<dyn std::error::Error>> {
    use std::os::fd::AsRawFd;

    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            std::ptr::addr_of_mut!(pid).cast(),
            &mut length,
        )
    };
    if result == 0 && pid > 0 {
        Ok(pid as u32)
    } else {
        Err(format!(
            "failed to identify connected daemon pid: {}",
            std::io::Error::last_os_error()
        )
        .into())
    }
}

#[cfg(target_os = "linux")]
fn peer_pid(stream: &UnixStream) -> Result<u32, Box<dyn std::error::Error>> {
    use std::os::fd::AsRawFd;

    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result == 0 && credentials.pid > 0 {
        Ok(credentials.pid as u32)
    } else {
        Err(format!(
            "failed to identify connected daemon pid: {}",
            std::io::Error::last_os_error()
        )
        .into())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_pid(_stream: &UnixStream) -> Result<u32, Box<dyn std::error::Error>> {
    Err("connected daemon pid lookup is unsupported on this platform".into())
}

impl DaemonClientReader {
    pub async fn read_event(&mut self) -> Result<Event, Box<dyn std::error::Error>> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).await?;
        if read == 0 {
            return Err("daemon connection closed".into());
        }
        let event: Event = serde_json::from_str(line.trim())?;
        Ok(event)
    }
}

impl DaemonClientWriter {
    pub async fn send_one_way(&mut self, cmd: &Command) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string(cmd)?;
        self.writer.write_all(json.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    fn temp_daemon_dir(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "kanna-daemon-client-test-{label}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn timed_out_command_fails_promptly_and_poisons_the_connection() {
        let daemon_dir = temp_daemon_dir("timeout-poison");
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(&daemon_dir));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();

        // Fake daemon over the real socket: accepts and reads the command
        // but never replies — the 2026-07-24 wedge shape — then delivers a
        // reply only after the client has already timed out.
        let (release_late_reply_tx, release_late_reply_rx) = tokio::sync::oneshot::channel::<()>();
        let (late_reply_sent_tx, late_reply_sent_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            release_late_reply_rx.await.unwrap();
            let response = serde_json::to_string(&Event::Ok).unwrap();
            write_half.write_all(response.as_bytes()).await.unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            late_reply_sent_tx.send(()).unwrap();
            // Keep the connection open so the client observes a stall or a
            // late reply, never an EOF.
            std::future::pending::<()>().await;
        });

        let mut client = DaemonClient::connect(&daemon_dir).await.unwrap();
        client.set_command_timeout_for_test(Duration::from_millis(200));

        let started = std::time::Instant::now();
        let error = client
            .send_command(&Command::List)
            .await
            .expect_err("a never-answered command must time out");
        assert!(
            error.to_string().contains("timed out"),
            "unexpected error: {error}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout was not prompt: {:?}",
            started.elapsed()
        );

        // Deliver the stalled command's reply late, then issue another
        // command: it must be rejected as poisoned without reading the
        // socket, so the late reply can never be paired with it.
        release_late_reply_tx.send(()).unwrap();
        late_reply_sent_rx.await.unwrap();
        let error = client
            .send_command(&Command::List)
            .await
            .expect_err("a poisoned connection must reject further commands");
        assert!(
            error
                .to_string()
                .contains("unusable after an earlier command timeout"),
            "unexpected error: {error}"
        );

        server.abort();
        let _ = std::fs::remove_file(&socket_path);
    }

    async fn run_successor_retry(label: &str, command: Command, success: Event) -> Event {
        let daemon_dir = temp_daemon_dir(label);
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(&daemon_dir));
        let pid_path = Path::new(&daemon_dir).join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, "41\n").unwrap();
        let old_listener = UnixListener::bind(&socket_path).unwrap();
        let expected_json = serde_json::to_string(&command).unwrap();
        let socket_for_server = socket_path.clone();
        let pid_for_server = pid_path.clone();

        let server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut first = String::new();
            BufReader::new(read_half)
                .read_line(&mut first)
                .await
                .unwrap();
            let refusal = Event::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
                message: "retry".to_string(),
            };
            write_half
                .write_all(serde_json::to_string(&refusal).unwrap().as_bytes())
                .await
                .unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            drop(write_half);
            let _ = std::fs::remove_file(&socket_for_server);

            let successor = UnixListener::bind(&socket_for_server).unwrap();
            std::fs::write(&pid_for_server, format!("{}\n", std::process::id())).unwrap();
            let (stream, _) = successor.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut second = String::new();
            BufReader::new(read_half)
                .read_line(&mut second)
                .await
                .unwrap();
            write_half
                .write_all(serde_json::to_string(&success).unwrap().as_bytes())
                .await
                .unwrap();
            write_half.write_all(b"\n").await.unwrap();
            write_half.flush().await.unwrap();
            (first, second)
        });

        let mut client = DaemonClient::connect(&daemon_dir).await.unwrap();
        client.set_connected_pid_for_test(41);
        let event = client
            .send_command_retrying_successor(&command)
            .await
            .unwrap();

        let (first, second) = server.await.unwrap();
        assert_eq!(first, format!("{expected_json}\n"));
        assert_eq!(second, format!("{expected_json}\n"));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
        event
    }

    #[tokio::test]
    async fn agent_input_refusal_waits_for_new_pid_and_replays_identically_once() {
        let event = run_successor_retry(
            "successor-agent-input",
            Command::AgentInput {
                session_id: "exact-incarnation".to_string(),
                text: "resume exactly once".to_string(),
            },
            Event::Ok,
        )
        .await;

        assert!(matches!(event, Event::Ok));
    }

    #[tokio::test]
    async fn ordinary_pty_spawn_renegotiates_before_successor_replay() {
        let daemon_dir = temp_daemon_dir("successor-ordinary-pty-spawn");
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(&daemon_dir));
        let pid_path = Path::new(&daemon_dir).join("daemon.pid");
        let _ = std::fs::remove_file(&socket_path);
        std::fs::write(&pid_path, "41\n").unwrap();
        let old_listener = UnixListener::bind(&socket_path).unwrap();
        let command = Command::Spawn {
            session_id: "ordinary-pty".to_string(),
            executable: "/bin/cat".to_string(),
            args: Vec::new(),
            cwd: "/tmp".to_string(),
            env: std::collections::HashMap::new(),
            cols: 80,
            rows: 24,
            agent_provider: None,
            terminal_prelude: None,
            operator_input_only: false,
        };
        let expected_spawn = serde_json::to_string(&command).unwrap();
        let socket_for_server = socket_path.clone();
        let pid_for_server = pid_path.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = old_listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut old_commands = Vec::new();
            for response in [
                Event::ProtectedInputReady {
                    version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                },
                Event::Error {
                    code: Some(kanna_daemon::protocol::ErrorCode::RetryOnSuccessor),
                    message: "handoff committed".to_string(),
                },
            ] {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                old_commands.push(line);
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            drop(write_half);
            let _ = std::fs::remove_file(&socket_for_server);

            let successor = UnixListener::bind(&socket_for_server).unwrap();
            std::fs::write(&pid_for_server, format!("{}\n", std::process::id())).unwrap();
            let (stream, _) = successor.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut successor_commands = Vec::new();
            for response in [
                Event::ProtectedInputReady {
                    version: kanna_daemon::protocol::PROTECTED_INPUT_PROTOCOL_VERSION,
                },
                Event::SessionCreated {
                    session_id: "ordinary-pty".to_string(),
                },
            ] {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                successor_commands.push(line);
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            (old_commands, successor_commands)
        });

        let mut client = DaemonClient::connect(&daemon_dir).await.unwrap();
        client.set_connected_pid_for_test(41);
        let event = client
            .send_command_retrying_successor(&command)
            .await
            .unwrap();

        assert!(matches!(
            event,
            Event::SessionCreated { session_id } if session_id == "ordinary-pty"
        ));
        let (old_commands, successor_commands) = server.await.unwrap();
        for commands in [&old_commands, &successor_commands] {
            assert!(matches!(
                serde_json::from_str::<Command>(commands[0].trim()).unwrap(),
                Command::NegotiateProtectedInput { .. }
            ));
            assert_eq!(commands[1], format!("{expected_spawn}\n"));
        }
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }

    #[tokio::test]
    async fn negotiation_disconnect_before_spawn_is_pre_submission() {
        let daemon_dir = temp_daemon_dir("spawn-negotiation-disconnect");
        let socket_path = kanna_runtime_defaults::socket_path(Path::new(&daemon_dir));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, _write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut command = String::new();
            reader.read_line(&mut command).await.unwrap();
            command
        });
        let command = Command::Spawn {
            session_id: "never-submitted".to_string(),
            executable: "/bin/cat".to_string(),
            args: Vec::new(),
            cwd: "/tmp".to_string(),
            env: std::collections::HashMap::new(),
            cols: 80,
            rows: 24,
            agent_provider: None,
            terminal_prelude: None,
            operator_input_only: false,
        };

        let mut client = DaemonClient::connect(&daemon_dir).await.unwrap();
        let error = client
            .send_spawn_command_retrying_successor(&command)
            .await
            .expect_err("a disconnect during negotiation must fail before Spawn submission");

        assert!(matches!(error, SpawnDeliveryError::BeforeSubmission(_)));
        let submitted = server.await.unwrap();
        assert!(matches!(
            serde_json::from_str::<Command>(submitted.trim()).unwrap(),
            Command::NegotiateProtectedInput { .. }
        ));
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_dir_all(daemon_dir);
    }
}
