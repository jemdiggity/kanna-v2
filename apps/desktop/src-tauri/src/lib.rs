mod commands;
mod daemon_client;

use commands::agent::AgentState;
use commands::daemon::DaemonState;
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
    let daemon_candidates = [
        // Same directory as the app binary (covers .build/debug/ from cargo config)
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

/// Spawn the event bridge: a background task that reads events from a dedicated
/// daemon connection and emits them as Tauri events.
fn spawn_event_bridge(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Dedicated event connection — separate from the command connection
        let mut event_client = match try_connect_daemon().await {
            Some(c) => c,
            None => {
                eprintln!("[event-bridge] daemon not available, skipping event bridge");
                return;
            }
        };

        // Subscribe to hook event broadcasts
        let _ = event_client
            .send_command(&serde_json::json!({"type":"Subscribe"}).to_string())
            .await;
        let _ = event_client.read_event().await; // consume Ok response

        eprintln!("[event-bridge] connected and subscribed to daemon events");

        loop {
            match event_client.read_event().await {
                Ok(line) => {
                    let event: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    match event.get("type").and_then(|t| t.as_str()) {
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
                    eprintln!("[event-bridge] daemon connection lost");
                    break;
                }
            }
        }
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
        .setup(|app| {
            #[cfg(target_os = "macos")]
            setup_fn_f_fullscreen();

            // Build app menu with full version in About
            let version = env!("KANNA_VERSION");
            let about = AboutMetadataBuilder::new().version(Some(version)).build();
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
            let daemon_state: DaemonState = app.handle().state::<DaemonState>().inner().clone();
            tauri::async_runtime::spawn(async move {
                ensure_daemon_running().await;
                // Clear stale connection so commands reconnect to the new daemon
                *daemon_state.lock().await = None;
                spawn_event_bridge(handle);
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
            commands::git::git_worktree_list,
            commands::git::git_log,
            commands::git::git_default_branch,
            commands::git::git_remote_url,
            commands::git::git_push,
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
            // Shell commands
            commands::shell::run_script,
            commands::shell::ensure_term_init,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
