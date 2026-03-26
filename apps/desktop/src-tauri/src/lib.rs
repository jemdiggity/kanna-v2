mod commands;
mod daemon_client;

use commands::agent::AgentState;
use commands::daemon::{AttachedSessions, DaemonState};
use daemon_client::DaemonClient;
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

/// Install a native macOS event monitor that intercepts fn+F (Globe+F) and
/// toggles fullscreen.  The fn/Globe modifier sets NSEventModifierFlagFunction
/// on the NSEvent, which JavaScript cannot detect — so we must handle it here,
/// before the event reaches WKWebView / xterm.js.
#[cfg(target_os = "macos")]
fn setup_fn_f_fullscreen() {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr};
    use std::ptr::{self, NonNull};

    let block = block2::RcBlock::new(|event: NonNull<AnyObject>| -> *mut AnyObject {
        unsafe {
            let flags: usize = msg_send![event.as_ref(), modifierFlags];

            // fn/Globe (bit 23) pressed, without Cmd/Ctrl/Option
            let fn_only = (flags & (1 << 23)) != 0
                && (flags & (1 << 20)) == 0
                && (flags & (1 << 18)) == 0
                && (flags & (1 << 19)) == 0;

            if fn_only {
                let chars: Option<Retained<AnyObject>> = msg_send![event.as_ref(), characters];
                if let Some(chars) = chars {
                    let utf8: *const c_char = msg_send![&*chars, UTF8String];
                    if !utf8.is_null() {
                        if let Ok(s) = CStr::from_ptr(utf8).to_str() {
                            if s.eq_ignore_ascii_case("f") {
                                if let Some(ns_app) = AnyClass::get(c"NSApplication") {
                                    let app: Option<Retained<AnyObject>> =
                                        msg_send![ns_app, sharedApplication];
                                    if let Some(app) = app {
                                        let win: Option<Retained<AnyObject>> =
                                            msg_send![&*app, keyWindow];
                                        if let Some(win) = win {
                                            let _: () = msg_send![
                                                &*win,
                                                toggleFullScreen: ptr::null::<AnyObject>()
                                            ];
                                        }
                                    }
                                }
                                return ptr::null_mut(); // consume the event
                            }
                        }
                    }
                }
            }

            event.as_ptr() // pass through
        }
    });

    unsafe {
        let Some(ns_event) = AnyClass::get(c"NSEvent") else {
            eprintln!("[macos] NSEvent class not found, fn+F shortcut unavailable");
            return;
        };
        let mask: u64 = 1 << 10; // NSEventMaskKeyDown
        let monitor: Option<Retained<AnyObject>> = msg_send![
            ns_event,
            addLocalMonitorForEventsMatchingMask: mask,
            handler: &*block
        ];
        // Keep the monitor alive for the lifetime of the app
        if let Some(m) = monitor {
            std::mem::forget(m);
        }
    }
}

/// Resolve the user's full PATH from their interactive login shell.
/// macOS apps launched from Finder/Spotlight inherit a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include tools like
/// claude, bun, or homebrew binaries. This runs the user's shell once
/// at startup to get the real PATH and sets it on our process so all
/// children (daemon, PTY sessions) inherit it.
#[cfg(target_os = "macos")]
fn fix_path_from_shell() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    match std::process::Command::new(&shell)
        .args(["-ilc", "printf '%s' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout);
            if !path.is_empty() {
                eprintln!(
                    "[path] resolved shell PATH ({} entries)",
                    path.matches(':').count() + 1
                );
                std::env::set_var("PATH", path.as_ref());
            }
        }
        Ok(output) => {
            eprintln!(
                "[path] shell exited with {}, keeping default PATH",
                output.status
            );
        }
        Err(e) => {
            eprintln!("[path] failed to run {}: {}", shell, e);
        }
    }
}

fn worktree_root() -> Option<PathBuf> {
    // Walk up from exe path to find directory containing .kanna-worktrees
    // (that's the main repo root — our worktree is a child of it)
    // OR find a directory whose parent contains .kanna-worktrees (we ARE the worktree)
    std::env::current_exe().ok().and_then(|exe| {
        let mut dir = exe.parent()?;
        loop {
            // Check if this directory's name starts with "task-" and parent is .kanna-worktrees
            if let Some(parent) = dir.parent() {
                if parent.file_name().and_then(|n| n.to_str()) == Some(".kanna-worktrees") {
                    return Some(dir.to_path_buf());
                }
            }
            dir = dir.parent()?;
        }
    })
}

fn short_socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}

/// Directory where daemon stores PID file and logs.
pub fn daemon_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("KANNA_DAEMON_DIR") {
        return PathBuf::from(dir);
    }
    if std::env::var("KANNA_WORKTREE").is_ok() {
        if let Some(root) = worktree_root() {
            return root.join(".kanna-daemon");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna")
}

pub fn daemon_socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("KANNA_DAEMON_DIR") {
        return short_socket_path(&PathBuf::from(dir));
    }
    if std::env::var("KANNA_WORKTREE").is_ok() {
        if let Some(root) = worktree_root() {
            let daemon_dir = root.join(".kanna-daemon");
            return short_socket_path(&daemon_dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Kanna");
    short_socket_path(&dir)
}

/// Try to connect to the daemon. Returns None if not available.
async fn try_connect_daemon() -> Option<DaemonClient> {
    let socket_path = daemon_socket_path();
    DaemonClient::connect(&socket_path).await.ok()
}

/// Always spawn a new daemon. If an old one is running, the new daemon
/// performs a handoff (transfers sessions via SCM_RIGHTS) automatically.
async fn ensure_daemon_running() {
    eprintln!("[daemon] spawning daemon...");

    // Look for the daemon binary in common locations
    let sidecar_name = format!("kanna-daemon-{}", commands::fs::current_target_triple());
    let daemon_candidates = [
        // Tauri externalBin: triple-suffixed, same dir as exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(&sidecar_name))),
        // Dev builds: plain name, same dir as exe
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("kanna-daemon"))),
        // macOS bundle Resources
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("../Resources/kanna-daemon"))),
    ];

    let daemon_bin = daemon_candidates.into_iter().flatten().find(|p| p.exists());

    let Some(daemon_bin) = daemon_bin else {
        eprintln!("[daemon] daemon binary not found — PTY sessions will not work");
        return;
    };

    // Pass KANNA_WORKTREE through so the daemon isolates to {cwd}/.kanna-daemon
    let is_worktree = std::env::var("KANNA_WORKTREE").is_ok();
    eprintln!(
        "[daemon] spawning {:?} (worktree={})",
        daemon_bin, is_worktree
    );
    use std::os::unix::process::CommandExt;
    // setsid() detaches daemon from our process group so Ctrl+C doesn't kill it
    let mut cmd = std::process::Command::new(&daemon_bin);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if is_worktree {
        cmd.env("KANNA_WORKTREE", "1");
        if let Some(root) = worktree_root() {
            let daemon_dir = root.join(".kanna-daemon");
            let daemon_dir_str = daemon_dir.to_str().unwrap_or("/tmp");
            cmd.env("KANNA_DAEMON_DIR", daemon_dir_str);
            // Set on our own process too so daemon_socket_path() and DB naming work
            std::env::set_var("KANNA_DAEMON_DIR", daemon_dir_str);
        }
    }
    match unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        })
        .spawn()
    } {
        Ok(child) => {
            let expected_pid = child.id().to_string();
            let pid_path = daemon_data_dir().join("daemon.pid");

            // Wait for the NEW daemon to be ready:
            // PID file must match our child AND socket must be connectable.
            // This ensures we don't connect to the old daemon during handoff.
            let mut delay = std::time::Duration::from_millis(50);
            for _ in 0..20 {
                tokio::time::sleep(delay).await;
                if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
                    if pid_str.trim() == expected_pid {
                        if try_connect_daemon().await.is_some() {
                            eprintln!("[daemon] spawned and connected (pid={})", expected_pid);
                            return;
                        }
                    }
                }
                delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(1));
            }
            eprintln!("[daemon] spawned but could not connect after retries");
        }
        Err(e) => {
            eprintln!("[daemon] failed to spawn: {}", e);
        }
    }
}

/// Connect to the daemon with exponential backoff. Used by the event bridge
/// to wait for the daemon to become available after a restart.
async fn connect_with_backoff() -> Option<DaemonClient> {
    let socket_path = daemon_socket_path();
    let mut delay = std::time::Duration::from_millis(50);
    for attempt in 1..=30 {
        match DaemonClient::connect(&socket_path).await {
            Ok(client) => {
                eprintln!("[reconnect] connected on attempt {}", attempt);
                return Some(client);
            }
            Err(_) => {
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, std::time::Duration::from_secs(2));
            }
        }
    }
    eprintln!("[reconnect] failed to connect after 30 attempts");
    None
}

/// Spawn the event bridge: a background task that reads events from a dedicated
/// daemon connection and emits them as Tauri events. Automatically reconnects
/// when the daemon restarts.
fn spawn_event_bridge(app: tauri::AppHandle, daemon_state: DaemonState) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Connect (with backoff for reconnection after daemon restart)
            let mut event_client = match connect_with_backoff().await {
                Some(c) => c,
                None => {
                    // Crash recovery: 30 attempts (~30s) of backoff exhausted with no daemon.
                    // The backoff itself prevents thundering herd — if another app instance
                    // spawned a replacement daemon, we'd have connected during backoff.
                    eprintln!("[event-bridge] backoff exhausted, attempting daemon spawn");
                    ensure_daemon_running().await;
                    match connect_with_backoff().await {
                        Some(c) => c,
                        None => {
                            eprintln!("[event-bridge] cannot connect after spawn, giving up");
                            return;
                        }
                    }
                }
            };

            // Subscribe to hook event broadcasts
            let _ = event_client
                .send_command(&serde_json::json!({"type":"Subscribe"}).to_string())
                .await;
            let _ = event_client.read_event().await; // consume Ok

            eprintln!("[event-bridge] connected and subscribed to daemon events");
            let _ = app.emit("daemon_ready", ());

            // Inner read loop
            loop {
                match event_client.read_event().await {
                    Ok(line) => {
                        let event: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        match event.get("type").and_then(|t| t.as_str()) {
                            Some("ShuttingDown") => {
                                eprintln!("[event-bridge] received ShuttingDown, reconnecting...");
                                break;
                            }
                            Some("Output") => {
                                let _ = app.emit("terminal_output", &event);
                            }
                            Some("Exit") => {
                                let _ = app.emit("session_exit", &event);
                            }
                            Some("HookEvent") => {
                                let _ = app.emit("hook_event", &event);
                            }
                            Some("StatusChanged") => {
                                let _ = app.emit("status_changed", &event);
                            }
                            _ => {}
                        }
                    }
                    Err(_) => {
                        eprintln!("[event-bridge] daemon connection lost, reconnecting...");
                        break;
                    }
                }
            }

            // Clear command connection so next use reconnects
            *daemon_state.lock().await = None;
        }
    });
}

/// Listen for `daemon_ready` events and re-attach all tracked sessions.
/// After a daemon restart, sessions survive (child processes are unaware),
/// but the attach streaming connections are lost. This coordinator re-establishes
/// them so terminal output resumes without user intervention.
fn spawn_reattach_coordinator(app: tauri::AppHandle, attached: AttachedSessions) {
    use tauri::Listener;
    let app_listener = app.clone();
    let _ = app_listener.listen("daemon_ready", move |_| {
        let app = app.clone();
        let attached = attached.clone();
        tauri::async_runtime::spawn(async move {
            let session_ids: Vec<String> = attached.lock().await.iter().cloned().collect();
            if session_ids.is_empty() {
                return;
            }
            eprintln!(
                "[reattach] re-attaching {} sessions after daemon restart",
                session_ids.len()
            );
            for sid in session_ids {
                match commands::daemon::attach_session_inner(&app, sid.clone(), &attached).await {
                    Ok(()) => {
                        eprintln!("[reattach] re-attached session {}", sid);
                        // Send Resize to trigger SIGWINCH so Claude TUI redraws
                        let resize_cmd = serde_json::json!({
                            "type": "Resize",
                            "session_id": sid,
                            "cols": 80,
                            "rows": 24,
                        });
                        let socket_path = daemon_socket_path();
                        if let Ok(mut client) = DaemonClient::connect(&socket_path).await {
                            let json = serde_json::to_string(&resize_cmd).unwrap_or_default();
                            let _ = client.send_command(&json).await;
                            let _ = client.read_event().await;
                        }
                    }
                    Err(e) => {
                        // Only remove from tracking if the session definitively doesn't exist.
                        // Transient errors (connection issues, timing) should leave the session
                        // tracked so it can be re-attached on the next daemon_ready.
                        if e.contains("session not found") || e.contains("not found") {
                            eprintln!("[reattach] session {} not found after handoff, removing from tracking", sid);
                            attached.lock().await.remove(&sid);
                        } else {
                            eprintln!("[reattach] failed to re-attach {} (will retry on next daemon_ready): {}", sid, e);
                        }
                    }
                }
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_delta_updater::init());

    #[cfg(debug_assertions)]
    {
        // Skip webdriver in worktree instances — port 4445 conflicts with main app
        if std::env::var("KANNA_WORKTREE").is_err() {
            builder = builder.plugin(tauri_plugin_webdriver::init());
        }
    }

    builder
        .manage(Arc::new(DashMap::new()) as AgentState)
        .manage(Arc::new(Mutex::new(None)) as DaemonState)
        .manage(
            Arc::new(Mutex::new(std::collections::HashSet::<String>::new())) as AttachedSessions,
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                fix_path_from_shell();
                setup_fn_f_fullscreen();
            }

            // Build app menu with full version in About
            let version = env!("KANNA_VERSION");
            let about = AboutMetadataBuilder::new()
                .short_version(Some(version))
                .version(Some(""))
                .build();
            let app_submenu = SubmenuBuilder::new(app, "Kanna")
                .about(Some(about))
                .separator()
                .quit()
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_submenu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window").minimize().build()?;
            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()?;
            app.set_menu(menu)?;

            let handle = app.handle().clone();
            let handle_reattach = handle.clone();
            let daemon_state: DaemonState = app.handle().state::<DaemonState>().inner().clone();
            let daemon_state_bridge = daemon_state.clone();
            let attached: AttachedSessions =
                app.handle().state::<AttachedSessions>().inner().clone();
            spawn_reattach_coordinator(handle_reattach, attached);
            tauri::async_runtime::spawn(async move {
                ensure_daemon_running().await;
                // Clear stale connection so commands reconnect to the new daemon
                *daemon_state.lock().await = None;
                spawn_event_bridge(handle, daemon_state_bridge);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Agent commands
            commands::agent::create_agent_session,
            commands::agent::agent_next_message,
            commands::agent::agent_send_message,
            commands::agent::agent_interrupt,
            commands::agent::agent_close_session,
            commands::agent::get_claude_usage,
            // Daemon commands
            commands::daemon::spawn_session,
            commands::daemon::send_input,
            commands::daemon::resize_session,
            commands::daemon::signal_session,
            commands::daemon::kill_session,
            commands::daemon::list_sessions,
            commands::daemon::attach_session,
            commands::daemon::detach_session,
            // Git commands
            commands::git::git_diff,
            commands::git::git_diff_range,
            commands::git::git_merge_base,
            commands::git::git_worktree_list,
            commands::git::git_log,
            commands::git::git_default_branch,
            commands::git::git_remote_url,
            commands::git::git_push,
            commands::git::git_fetch,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_app_info,
            commands::git::git_clone,
            commands::git::git_init,
            // FS commands
            commands::fs::file_exists,
            commands::fs::list_files,
            commands::fs::read_text_file,
            commands::fs::write_text_file,
            commands::fs::which_binary,
            commands::fs::read_env_var,
            commands::fs::append_log,
            commands::fs::get_app_data_dir,
            commands::fs::copy_file,
            commands::fs::remove_file,
            commands::fs::list_dir,
            commands::fs::ensure_directory,
            commands::fs::read_dir_entries,
            // Shell commands
            commands::shell::run_script,
            commands::shell::ensure_term_init,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
