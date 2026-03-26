mod fd_transfer;
mod protocol;
mod pty;
mod session;
mod socket;

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, Mutex};

/// A single client's writer handle.
type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

/// Map of session_id → all attached writers (broadcast to all on output).
type SessionWriters = Arc<Mutex<HashMap<String, Vec<SessionWriter>>>>;

/// Pre-attach buffer: collects output between Spawn and first Attach.
/// Flushed to the client on Attach, then set to None.
type PreAttachBuffer = Arc<Mutex<Option<Vec<u8>>>>;
type PreAttachBuffers = Arc<Mutex<HashMap<String, PreAttachBuffer>>>;

/// Per-session size registry: maps client pointer → (cols, rows).
/// Used to compute min(cols) x min(rows) across all attached clients.
type SessionSizes = Arc<Mutex<HashMap<String, HashMap<usize, (u16, u16)>>>>;

use protocol::{Command, Event};
use session::SessionManager;
use socket::{bind_socket, read_command, write_event};

fn app_support_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("KANNA_DAEMON_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna")
}

fn socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

#[tokio::main]
async fn main() {
    let dir = app_support_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create app support dir");

    // Log to file + stderr
    let _ = flexi_logger::Logger::try_with_env_or_str("info")
        .unwrap()
        .log_to_file(
            flexi_logger::FileSpec::default()
                .directory(&dir)
                .discriminant(std::process::id().to_string()),
        )
        .duplicate_to_stderr(flexi_logger::Duplicate::Info)
        .start();

    let pid_path = dir.join("daemon.pid");
    let socket_path = socket_path(&dir);

    // Attempt handoff from old daemon (if running)
    let adopted = attempt_handoff(&pid_path, &socket_path).await;

    // Write our PID
    let pid = std::process::id();
    std::fs::write(&pid_path, pid.to_string()).expect("Failed to write PID file");

    let listener = bind_socket(&socket_path).expect("Failed to bind Unix socket");

    log::info!(
        "kanna-daemon v{} ({} @ {}) starting, pid={}, socket={:?}",
        env!("KANNA_VERSION"),
        env!("GIT_BRANCH"),
        env!("GIT_COMMIT"),
        pid,
        socket_path
    );

    let sessions: Arc<Mutex<SessionManager>> = Arc::new(Mutex::new(SessionManager::new()));
    let session_writers: SessionWriters = Arc::new(Mutex::new(HashMap::new()));
    let pre_attach_buffers: PreAttachBuffers = Arc::new(Mutex::new(HashMap::new()));
    let session_sizes: SessionSizes = Arc::new(Mutex::new(HashMap::new()));

    // Adopt handed-off sessions
    if !adopted.is_empty() {
        let mut mgr = sessions.lock().await;
        for (session_id, pty_session) in adopted {
            log::info!(
                "[handoff] adopted session {} (pid={})",
                session_id,
                pty_session.pid()
            );
            mgr.insert(session_id, pty_session);
            // Note: no stream_output started — client must Attach to start streaming
        }
    }

    let (broadcast_tx, _) = broadcast::channel::<String>(256);

    let pid_path_clone = pid_path.clone();
    let socket_path_clone = socket_path.clone();
    let sessions_shutdown = sessions.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        log::info!("kanna-daemon shutting down");
        sessions_shutdown.lock().await.kill_all();
        let _ = std::fs::remove_file(&pid_path_clone);
        let _ = std::fs::remove_file(&socket_path_clone);
        std::process::exit(0);
    });

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let sessions_clone = sessions.clone();
                let broadcast_tx_clone = broadcast_tx.clone();
                let writers_clone = session_writers.clone();
                let buffers_clone = pre_attach_buffers.clone();
                let sizes_clone = session_sizes.clone();
                tokio::spawn(async move {
                    handle_connection(
                        stream,
                        sessions_clone,
                        broadcast_tx_clone,
                        writers_clone,
                        buffers_clone,
                        sizes_clone,
                    )
                    .await;
                });
            }
            Err(e) => {
                log::error!("accept error: {}", e);
            }
        }
    }
}

/// Try to take over sessions from an existing daemon.
/// Returns adopted (session_id, PtySession) pairs.
async fn attempt_handoff(
    pid_path: &PathBuf,
    socket_path: &PathBuf,
) -> Vec<(String, pty::PtySession)> {
    // Check if old daemon is running
    let old_pid = match std::fs::read_to_string(pid_path) {
        Ok(s) => match s.trim().parse::<i32>() {
            Ok(pid) if unsafe { libc::kill(pid, 0) } == 0 => pid,
            _ => return vec![],
        },
        Err(_) => return vec![],
    };

    log::info!(
        "[handoff] old daemon detected (pid={}), requesting handoff",
        old_pid
    );

    // Connect to old daemon
    let stream = match tokio::net::UnixStream::connect(socket_path).await {
        Ok(s) => s,
        Err(e) => {
            log::info!("[handoff] failed to connect to old daemon: {}", e);
            // Old daemon might be stuck — kill it
            unsafe { libc::kill(old_pid, libc::SIGTERM) };
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            return vec![];
        }
    };

    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(read_half);
    let mut writer = write_half;

    // Send Handoff command
    let cmd = serde_json::json!({ "type": "Handoff", "version": HANDOFF_VERSION });
    let mut json = serde_json::to_string(&cmd).unwrap();
    json.push('\n');
    use tokio::io::AsyncWriteExt;
    if let Err(e) = writer.write_all(json.as_bytes()).await {
        log::info!("[handoff] failed to send handoff command: {}", e);
        return vec![];
    }
    let _ = writer.flush().await;

    // Read response
    let mut line = String::new();
    use tokio::io::AsyncBufReadExt;
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        reader.read_line(&mut line),
    )
    .await
    {
        Ok(Ok(_)) => {}
        _ => {
            log::info!("[handoff] timeout or error reading handoff response");
            unsafe { libc::kill(old_pid, libc::SIGTERM) };
            return vec![];
        }
    }

    let event: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => {
            log::info!("[handoff] invalid response: {}", e);
            return vec![];
        }
    };

    match event.get("type").and_then(|t| t.as_str()) {
        Some("HandoffReady") => {}
        Some("Error") => {
            let msg = event
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown");
            log::info!("[handoff] old daemon refused: {}", msg);
            return vec![];
        }
        other => {
            log::info!("[handoff] unexpected response type: {:?}", other);
            return vec![];
        }
    }

    // Parse session metadata
    let session_infos: Vec<protocol::SessionInfo> = match event.get("sessions") {
        Some(s) => serde_json::from_value(s.clone()).unwrap_or_default(),
        None => vec![],
    };

    if session_infos.is_empty() {
        log::info!("[handoff] no sessions to adopt");
        // Wait for old daemon to exit
        wait_for_exit(old_pid).await;
        return vec![];
    }

    log::info!("[handoff] receiving {} session fds", session_infos.len());

    // Receive master fds via SCM_RIGHTS
    let fds = match fd_transfer::recv_fds(raw_fd, session_infos.len()) {
        Ok(fds) => fds,
        Err(e) => {
            log::info!("[handoff] failed to receive fds: {}", e);
            return vec![];
        }
    };

    if fds.len() != session_infos.len() {
        log::info!(
            "[handoff] fd count mismatch: got {}, expected {}",
            fds.len(),
            session_infos.len()
        );
        return vec![];
    }

    // Build adopted sessions
    let mut adopted = Vec::new();
    for (info, fd) in session_infos.into_iter().zip(fds) {
        let owned_fd = unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fd) };
        let session = pty::PtySession::adopt(owned_fd, info.pid as libc::pid_t, info.cwd);
        adopted.push((info.session_id, session));
    }

    // Wait for old daemon to exit cleanly
    wait_for_exit(old_pid).await;

    adopted
}

/// Wait for a process to exit, with a timeout.
async fn wait_for_exit(pid: i32) {
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
    }
    log::info!(
        "[handoff] old daemon (pid={}) didn't exit, sending SIGTERM",
        pid
    );
    unsafe { libc::kill(pid, libc::SIGTERM) };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if unsafe { libc::kill(pid, 0) } == 0 {
        log::info!("[handoff] old daemon still alive, sending SIGKILL");
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

async fn handle_connection(
    stream: UnixStream,
    sessions: Arc<Mutex<SessionManager>>,
    broadcast_tx: broadcast::Sender<String>,
    session_writers: SessionWriters,
    pre_attach_buffers: PreAttachBuffers,
    session_sizes: SessionSizes,
) {
    // Keep the raw fd for SCM_RIGHTS (used by Handoff)
    let raw_fd = stream.as_raw_fd();
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    let subscribed = Arc::new(std::sync::atomic::AtomicBool::new(false));

    loop {
        let cmd = read_command(&mut reader).await;
        match cmd {
            None => break,
            Some(Command::Handoff { version }) => {
                handle_handoff(
                    version,
                    raw_fd,
                    sessions.clone(),
                    session_writers.clone(),
                    session_sizes.clone(),
                    writer.clone(),
                    broadcast_tx.clone(),
                )
                .await;
                break; // Connection ends after handoff
            }
            Some(Command::Subscribe) => {
                if !subscribed.load(std::sync::atomic::Ordering::Relaxed) {
                    subscribed.store(true, std::sync::atomic::Ordering::Relaxed);
                    let mut broadcast_rx = broadcast_tx.subscribe();
                    let writer_broadcast = writer.clone();
                    tokio::spawn(async move {
                        use tokio::io::AsyncWriteExt;
                        while let Ok(msg) = broadcast_rx.recv().await {
                            let mut w = writer_broadcast.lock().await;
                            let _ = w.write_all(msg.as_bytes()).await;
                            let _ = w.write_all(b"\n").await;
                            let _ = w.flush().await;
                        }
                    });
                }
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(command) => {
                handle_command(
                    command,
                    sessions.clone(),
                    writer.clone(),
                    session_writers.clone(),
                    pre_attach_buffers.clone(),
                    session_sizes.clone(),
                )
                .await;
            }
        }
    }
}

async fn handle_command(
    command: Command,
    sessions: Arc<Mutex<SessionManager>>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    session_writers: SessionWriters,
    pre_attach_buffers: PreAttachBuffers,
    session_sizes: SessionSizes,
) {
    match command {
        Command::Spawn {
            session_id,
            executable,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            let mut mgr = sessions.lock().await;
            if mgr.contains(&session_id) {
                let evt = Event::Error {
                    message: format!("session already exists: {}", session_id),
                };
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            match pty::PtySession::spawn(&executable, &args, &cwd, &env, cols, rows) {
                Ok(pty_session) => {
                    let pty_reader = pty_session.try_clone_reader();
                    mgr.insert(session_id.clone(), pty_session);
                    drop(mgr);

                    // Start stream_output immediately so startup output
                    // (including kitty keyboard mode push) is captured.
                    if let Ok(reader) = pty_reader {
                        session_writers
                            .lock()
                            .await
                            .insert(session_id.clone(), Vec::new());

                        let buffer: PreAttachBuffer = Arc::new(Mutex::new(Some(Vec::new())));
                        pre_attach_buffers
                            .lock()
                            .await
                            .insert(session_id.clone(), buffer.clone());

                        let sid = session_id.clone();
                        let sessions_exit = sessions.clone();
                        let writers_for_stream = session_writers.clone();
                        let sizes_for_stream = session_sizes.clone();
                        tokio::task::spawn_blocking(move || {
                            stream_output(
                                sid,
                                reader,
                                writers_for_stream,
                                buffer,
                                sessions_exit,
                                sizes_for_stream,
                            );
                        });
                    }

                    let evt = Event::SessionCreated {
                        session_id: session_id.clone(),
                    };
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                }
                Err(e) => {
                    let evt = Event::Error {
                        message: format!("failed to spawn PTY: {}", e),
                    };
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                }
            }
        }

        Command::Attach { session_id } => {
            let mgr = sessions.lock().await;
            if !mgr.contains(&session_id) {
                let evt = Event::Error {
                    message: format!("session not found: {}", session_id),
                };
                drop(mgr);
                let _ = write_event(&mut *writer.lock().await, &evt).await;
                return;
            }

            let is_streaming = session_writers.lock().await.contains_key(&session_id);
            if is_streaming {
                // stream_output already running (started at Spawn) — push writer to broadcast list
                drop(mgr);
                {
                    let mut writers = session_writers.lock().await;
                    if let Some(vec) = writers.get_mut(&session_id) {
                        vec.push(writer.clone());
                    }
                }

                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;

                // Flush pre-attach buffer (startup output including kitty keyboard push)
                if let Some(buffer) = pre_attach_buffers.lock().await.remove(&session_id) {
                    if let Some(data) = buffer.lock().await.take() {
                        if !data.is_empty() {
                            log::info!(
                                "[attach] flushing {} bytes of pre-attach output for {}",
                                data.len(),
                                session_id
                            );
                            let evt = Event::Output {
                                session_id: session_id.clone(),
                                data,
                            };
                            let _ = write_event(&mut *writer.lock().await, &evt).await;
                        }
                    }
                }
            } else {
                // No stream_output yet (adopted session from handoff) — start it now
                let pty_reader = match mgr.sessions.get(&session_id).unwrap().try_clone_reader() {
                    Ok(r) => r,
                    Err(e) => {
                        let evt = Event::Error {
                            message: format!("failed to clone PTY reader: {}", e),
                        };
                        drop(mgr);
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                        return;
                    }
                };
                drop(mgr);

                session_writers
                    .lock()
                    .await
                    .insert(session_id.clone(), vec![writer.clone()]);

                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;

                let sid = session_id.clone();
                let sessions_exit = sessions.clone();
                let writers_for_stream = session_writers.clone();
                let sizes_for_stream = session_sizes.clone();
                let no_buffer: PreAttachBuffer = Arc::new(Mutex::new(None));
                tokio::task::spawn_blocking(move || {
                    stream_output(
                        sid,
                        pty_reader,
                        writers_for_stream,
                        no_buffer,
                        sessions_exit,
                        sizes_for_stream,
                    );
                });
            }
        }

        Command::Detach { session_id } => {
            let evt = if sessions.lock().await.contains(&session_id) {
                let mut writers = session_writers.lock().await;
                if let Some(vec) = writers.get_mut(&session_id) {
                    let ptr = Arc::as_ptr(&writer) as usize;
                    vec.retain(|w| Arc::as_ptr(w) as usize != ptr);
                }
                drop(writers);

                // Remove this client from the size registry and recompute
                {
                    let mut sizes = session_sizes.lock().await;
                    if let Some(client_sizes) = sizes.get_mut(&session_id) {
                        let writer_id = Arc::as_ptr(&writer) as usize;
                        client_sizes.remove(&writer_id);
                        if !client_sizes.is_empty() {
                            let min_cols =
                                client_sizes.values().map(|(c, _)| *c).min().unwrap_or(80);
                            let min_rows =
                                client_sizes.values().map(|(_, r)| *r).min().unwrap_or(24);
                            drop(sizes);
                            let mgr = sessions.lock().await;
                            let _ = mgr.resize(&session_id, min_cols, min_rows);
                        }
                    }
                }

                Event::Ok
            } else {
                Event::Error {
                    message: format!("session not found: {}", session_id),
                }
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Input { session_id, data } => {
            let mut mgr = sessions.lock().await;
            match mgr.get_mut(&session_id) {
                Some(session) => match session.write_input(&data) {
                    Ok(_) => {
                        drop(mgr);
                        let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
                    }
                    Err(e) => {
                        let evt = Event::Error {
                            message: format!("write error: {}", e),
                        };
                        drop(mgr);
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
                    }
                },
                None => {
                    let evt = Event::Error {
                        message: format!("session not found: {}", session_id),
                    };
                    drop(mgr);
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                }
            }
        }

        Command::Resize {
            session_id,
            cols,
            rows,
        } => {
            // Update this client's size and compute effective min across all attached clients
            let writer_id = Arc::as_ptr(&writer) as usize;
            let (eff_cols, eff_rows) = {
                let mut sizes = session_sizes.lock().await;
                let client_sizes = sizes.entry(session_id.clone()).or_default();
                client_sizes.insert(writer_id, (cols, rows));
                let min_cols = client_sizes.values().map(|(c, _)| *c).min().unwrap_or(cols);
                let min_rows = client_sizes.values().map(|(_, r)| *r).min().unwrap_or(rows);
                (min_cols, min_rows)
            };

            let mgr = sessions.lock().await;
            let result = mgr.resize(&session_id, eff_cols, eff_rows);
            drop(mgr);
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => Event::Error {
                    message: e.to_string(),
                },
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Signal { session_id, signal } => {
            let sig = match signal.as_str() {
                "SIGINT" => libc::SIGINT,
                "SIGTSTP" => libc::SIGTSTP,
                "SIGCONT" => libc::SIGCONT,
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
                "SIGWINCH" => libc::SIGWINCH,
                other => {
                    let evt = Event::Error {
                        message: format!("unknown signal: {}", other),
                    };
                    let _ = write_event(&mut *writer.lock().await, &evt).await;
                    return;
                }
            };
            let mgr = sessions.lock().await;
            let result = mgr.signal(&session_id, sig);
            drop(mgr);
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => Event::Error {
                    message: e.to_string(),
                },
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Kill { session_id } => {
            let mut mgr = sessions.lock().await;
            let result = match mgr.get_mut(&session_id) {
                Some(session) => session.kill(),
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session not found: {}", session_id),
                )),
            };
            if result.is_ok() {
                mgr.remove(&session_id);
            }
            drop(mgr);
            session_writers.lock().await.remove(&session_id);
            session_sizes.lock().await.remove(&session_id);
            let evt = match result {
                Ok(_) => Event::Ok,
                Err(e) => Event::Error {
                    message: e.to_string(),
                },
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::List => {
            let mut mgr = sessions.lock().await;
            let sessions_list = mgr.list();
            drop(mgr);
            let evt = Event::SessionList {
                sessions: sessions_list,
            };
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Handoff { .. } => {
            // Handled in handle_connection before dispatch
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::Subscribe => {
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }
    }
}

/// Current handoff protocol version. Both sides must agree.
const HANDOFF_VERSION: u32 = 1;

/// Handle a handoff request from a new daemon.
/// Collects all live sessions, sends metadata + master fds, then exits.
async fn handle_handoff(
    version: u32,
    socket_fd: std::os::unix::io::RawFd,
    sessions: Arc<Mutex<SessionManager>>,
    session_writers: SessionWriters,
    session_sizes: SessionSizes,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    broadcast_tx: broadcast::Sender<String>,
) {
    if version != HANDOFF_VERSION {
        let evt = Event::Error {
            message: format!(
                "handoff version mismatch: expected {}, got {}",
                HANDOFF_VERSION, version
            ),
        };
        let _ = write_event(&mut *writer.lock().await, &evt).await;
        return;
    }

    // Collect live sessions and detach them
    let mut mgr = sessions.lock().await;
    let session_ids: Vec<String> = mgr.sessions.keys().cloned().collect();

    let mut infos = Vec::new();
    let mut fds = Vec::new();

    for id in &session_ids {
        if let Some(session) = mgr.remove(id) {
            if session.is_alive() {
                let pid = session.pid();
                let cwd = session.cwd.clone();
                let (fd, _, _) = session.detach_for_handoff();
                infos.push(protocol::SessionInfo {
                    session_id: id.clone(),
                    pid,
                    cwd,
                    state: protocol::SessionState::Active,
                    idle_seconds: 0,
                });
                fds.push(fd);
            }
            // Dead sessions are just dropped
        }
    }
    drop(mgr);

    // Clear all writer slots (stream_output tasks will exit on next read failure)
    session_writers.lock().await.clear();
    session_sizes.lock().await.clear();

    log::info!("[handoff] transferring {} sessions", infos.len());

    // Send HandoffReady with session metadata
    let evt = Event::HandoffReady { sessions: infos };
    let _ = write_event(&mut *writer.lock().await, &evt).await;

    // Flush the writer before sending fds
    {
        use tokio::io::AsyncWriteExt;
        let _ = writer.lock().await.flush().await;
    }

    // Send master fds via SCM_RIGHTS
    if !fds.is_empty() {
        if let Err(e) = fd_transfer::send_fds(socket_fd, &fds) {
            log::info!("[handoff] failed to send fds: {}", e);
        }
        // Close our copies — the new daemon owns them now
        for fd in &fds {
            unsafe { libc::close(*fd) };
        }
    }

    // Broadcast ShuttingDown so subscribed clients know not to reconnect to this daemon.
    let shutdown_evt = Event::ShuttingDown;
    if let Ok(json) = serde_json::to_string(&shutdown_evt) {
        let _ = broadcast_tx.send(json);
    }

    log::info!("[handoff] complete, exiting");
    // Use a blocking thread to exit — std::process::exit from an async context
    // can hang if tokio tasks are still running.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::exit(0);
    });
    // Give subscriber tasks time to flush the ShuttingDown event to their sockets.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
}

/// Maximum pre-attach buffer size (64 KB). Output before client attaches is
/// buffered so kitty keyboard mode pushes reach xterm.js on first attach.
const MAX_PRE_ATTACH_BUFFER: usize = 64 * 1024;

/// Runs in a blocking thread for the entire lifetime of a session.
/// ONE reader per session — never duplicated. Output is broadcast to all
/// currently attached clients via the SessionWriters map.
/// Buffers output before first Attach so startup sequences (like kitty
/// keyboard mode push) are replayed to xterm.js on connect.
fn stream_output(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    session_writers: SessionWriters,
    pre_attach_buffer: PreAttachBuffer,
    sessions: Arc<Mutex<SessionManager>>,
    session_sizes: SessionSizes,
) {
    let rt = tokio::runtime::Handle::current();
    let mut buf = [0u8; 4096];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = buf[..n].to_vec();

                // If pre-attach buffer is active (Some), append to it
                let buffered = rt.block_on(async {
                    let mut guard = pre_attach_buffer.lock().await;
                    if let Some(ref mut buffer) = *guard {
                        if buffer.len() + data.len() <= MAX_PRE_ATTACH_BUFFER {
                            buffer.extend_from_slice(&data);
                        }
                        true
                    } else {
                        false
                    }
                });
                // Buffer is active — Attach handler will flush it
                if buffered {
                    continue;
                }

                let evt = Event::Output {
                    session_id: session_id.clone(),
                    data,
                };
                rt.block_on(async {
                    let mut writers = session_writers.lock().await;
                    if let Some(vec) = writers.get_mut(&session_id) {
                        let mut failed = Vec::new();
                        for (i, w) in vec.iter().enumerate() {
                            if write_event(&mut *w.lock().await, &evt).await.is_err() {
                                failed.push(i);
                            }
                        }
                        // Remove broken writers in reverse order to preserve indices
                        for i in failed.into_iter().rev() {
                            vec.remove(i);
                        }
                    }
                });
            }
            Err(e) => {
                log::error!("PTY read error for session {}: {}", session_id, e);
                break;
            }
        }
    }

    let exit_code = {
        let mut mgr = rt.block_on(sessions.lock());
        let code = match mgr.get_mut(&session_id) {
            Some(session) => session.try_wait().unwrap_or(0),
            None => 0,
        };
        mgr.remove(&session_id);
        code
    };

    let evt = Event::Exit {
        session_id: session_id.clone(),
        code: exit_code,
    };
    rt.block_on(async {
        // Broadcast Exit to all attached writers, then remove the session entry.
        // session_writers and writers_cleanup are the same Arc — use a single lock.
        let mut writers = session_writers.lock().await;
        if let Some(vec) = writers.get(&session_id) {
            for w in vec.iter() {
                let _ = write_event(&mut *w.lock().await, &evt).await;
            }
        }
        writers.remove(&session_id);
        drop(writers);
        session_sizes.lock().await.remove(&session_id);
    });
}
