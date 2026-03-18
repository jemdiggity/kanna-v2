mod protocol;
mod pty;
mod session;
mod socket;

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, Mutex};

use protocol::{Command, Event};
use session::SessionManager;
use socket::{bind_socket, read_command, write_event};

fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna")
}

#[tokio::main]
async fn main() {
    let dir = app_support_dir();
    std::fs::create_dir_all(&dir).expect("Failed to create app support dir");

    // Write PID file
    let pid_path = dir.join("daemon.pid");
    let pid = std::process::id();
    std::fs::write(&pid_path, pid.to_string()).expect("Failed to write PID file");

    let socket_path = dir.join("daemon.sock");
    let listener = bind_socket(&socket_path).expect("Failed to bind Unix socket");

    eprintln!("kanna-daemon starting, pid={}, socket={:?}", pid, socket_path);

    let sessions: Arc<Mutex<SessionManager>> = Arc::new(Mutex::new(SessionManager::new()));

    // Broadcast channel for hook events — any connection can send, all connections receive
    let (hook_tx, _) = broadcast::channel::<String>(256);

    // Graceful shutdown on Ctrl+C
    let pid_path_clone = pid_path.clone();
    let socket_path_clone = socket_path.clone();
    let sessions_shutdown = sessions.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        eprintln!("kanna-daemon shutting down");
        sessions_shutdown.lock().await.kill_all();
        let _ = std::fs::remove_file(&pid_path_clone);
        let _ = std::fs::remove_file(&socket_path_clone);
        std::process::exit(0);
    });

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let sessions_clone = sessions.clone();
                let hook_tx_clone = hook_tx.clone();
                tokio::spawn(async move {
                    handle_connection(stream, sessions_clone, hook_tx_clone).await;
                });
            }
            Err(e) => {
                eprintln!("accept error: {}", e);
            }
        }
    }
}

async fn handle_connection(
    stream: UnixStream,
    sessions: Arc<Mutex<SessionManager>>,
    hook_tx: broadcast::Sender<String>,
) {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));

    // No automatic broadcast subscription — clients must explicitly Subscribe.
    // This prevents hook events from mixing with command responses.
    let subscribed = Arc::new(std::sync::atomic::AtomicBool::new(false));

    loop {
        let cmd = read_command(&mut reader).await;
        match cmd {
            None => break,
            Some(Command::Subscribe) => {
                // Opt in to receiving broadcast hook events on this connection
                if !subscribed.load(std::sync::atomic::Ordering::Relaxed) {
                    subscribed.store(true, std::sync::atomic::Ordering::Relaxed);
                    let mut hook_rx = hook_tx.subscribe();
                    let writer_hook = writer.clone();
                    tokio::spawn(async move {
                        use tokio::io::AsyncWriteExt;
                        while let Ok(msg) = hook_rx.recv().await {
                            let mut w = writer_hook.lock().await;
                            let _ = w.write_all(msg.as_bytes()).await;
                            let _ = w.write_all(b"\n").await;
                            let _ = w.flush().await;
                        }
                    });
                }
                let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
            }
            Some(command) => {
                handle_command(command, sessions.clone(), writer.clone(), &hook_tx).await;
            }
        }
    }
}

async fn handle_command(
    command: Command,
    sessions: Arc<Mutex<SessionManager>>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    hook_tx: &broadcast::Sender<String>,
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
                    mgr.insert(session_id.clone(), pty_session);
                    drop(mgr);

                    // Only send SessionCreated — no auto-streaming.
                    // Client must Attach to start receiving Output events.
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

            // Get reader from existing session
            let reader = match mgr.sessions_reader(&session_id) {
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
            let pid = mgr.sessions.get(&session_id).map(|s| s.pid()).unwrap_or(0);
            drop(mgr);

            {
                let evt = Event::Ok;
                let _ = write_event(&mut *writer.lock().await, &evt).await;
            }

            let sid = session_id.clone();
            let writer_out = writer.clone();
            let sessions_exit = sessions.clone();
            tokio::task::spawn_blocking(move || {
                stream_output(sid, reader, writer_out, sessions_exit, pid);
            });
        }

        Command::Detach { session_id } => {
            // Detach just acknowledges — the output task will stop when reader drops
            let evt = if sessions.lock().await.contains(&session_id) {
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
                        let evt = Event::Ok;
                        drop(mgr);
                        let _ = write_event(&mut *writer.lock().await, &evt).await;
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
            let mgr = sessions.lock().await;
            let result = mgr.resize(&session_id, cols, rows);
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
                "SIGTSTP" => libc::SIGTSTP,
                "SIGCONT" => libc::SIGCONT,
                "SIGTERM" => libc::SIGTERM,
                "SIGKILL" => libc::SIGKILL,
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
            // Remove the session after killing
            if result.is_ok() {
                mgr.remove(&session_id);
            }
            drop(mgr);
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

        Command::Handoff => {
            let evt = Event::HandoffUnsupported;
            let _ = write_event(&mut *writer.lock().await, &evt).await;
        }

        Command::Subscribe => {
            // Handled in handle_connection before dispatch
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }

        Command::HookEvent {
            session_id,
            event,
            data,
        } => {
            // Broadcast the hook event to all connected clients
            let evt = Event::HookEvent {
                session_id,
                event,
                data,
            };
            if let Ok(json) = serde_json::to_string(&evt) {
                let _ = hook_tx.send(json);
            }
            // Acknowledge to the sender
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }
    }
}

/// Runs in a blocking thread: reads PTY output and sends Output events.
/// When the process exits, removes it from the session manager and sends Exit.
fn stream_output(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    sessions: Arc<Mutex<SessionManager>>,
    _pid: u32,
) {
    let rt = tokio::runtime::Handle::current();
    let mut buf = [0u8; 4096];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — process has exited
                break;
            }
            Ok(n) => {
                let data = buf[..n].to_vec();
                let evt = Event::Output {
                    session_id: session_id.clone(),
                    data,
                };
                let writer_clone = writer.clone();
                rt.block_on(async move {
                    let _ = write_event(&mut *writer_clone.lock().await, &evt).await;
                });
            }
            Err(e) => {
                eprintln!("PTY read error for session {}: {}", session_id, e);
                break;
            }
        }
    }

    // Get exit code and clean up
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
    rt.block_on(async move {
        let _ = write_event(&mut *writer.lock().await, &evt).await;
    });
}
