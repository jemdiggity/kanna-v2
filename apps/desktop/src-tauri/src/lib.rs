mod commands;
mod daemon_client;
mod subprocess_env;
mod transfer_identity;
mod transfer_sidecar;

use commands::agent::AgentState;
use commands::daemon::{
    ActiveAttachedStream, ActiveAttachedStreams, AttachedSessions, DaemonState, WindowSessionSizes,
};
use daemon_client::DaemonClient;
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager};
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex;

/// Managed state holding the pipeline socket path so the frontend can read it.
pub type PipelineSocketState = Arc<Mutex<Option<String>>>;
pub(crate) const KANNA_VERSION: &str = env!("KANNA_VERSION");
pub(crate) const KANNA_BUILD_BRANCH: &str = env!("KANNA_BUILD_BRANCH");
pub(crate) const KANNA_BUILD_COMMIT: &str = env!("KANNA_BUILD_COMMIT");
pub(crate) const KANNA_BUILD_WORKTREE: &str = env!("KANNA_BUILD_WORKTREE");
pub(crate) const KANNA_BUILD_INFO: &str = env!("KANNA_BUILD_INFO");
pub type TransferServiceState = Arc<Mutex<Option<transfer_sidecar::TransferSidecarClient>>>;
const MENU_ID_NEW_WINDOW: &str = "workspace-new-window";
const MENU_ID_CLOSE_WINDOW: &str = "workspace-close-window";
const MENU_ID_NAVIGATE_TASK_UP: &str = "navigate-task-up";
const MENU_ID_NAVIGATE_TASK_DOWN: &str = "navigate-task-down";
const MENU_ID_NAVIGATE_REPO_UP: &str = "navigate-repo-up";
const MENU_ID_NAVIGATE_REPO_DOWN: &str = "navigate-repo-down";
const WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT: &str = "kanna://native-new-window";
const WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT: &str = "kanna://native-close-window";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT: &str = "kanna://native-navigate-task-up";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT: &str = "kanna://native-navigate-task-down";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT: &str = "kanna://native-navigate-repo-up";
const WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT: &str = "kanna://native-navigate-repo-down";

#[derive(Debug, PartialEq, Eq)]
enum NativeWorkspaceMenuAction {
    DispatchToFocused { label: String, event: &'static str },
    CreateRootWindow,
    None,
}

fn resolve_native_workspace_menu_action(
    menu_id: &str,
    focused_label: Option<&str>,
) -> NativeWorkspaceMenuAction {
    match (menu_id, focused_label) {
        (MENU_ID_NEW_WINDOW, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
        },
        (MENU_ID_NEW_WINDOW, None) => NativeWorkspaceMenuAction::CreateRootWindow,
        (MENU_ID_CLOSE_WINDOW, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
        },
        (MENU_ID_NAVIGATE_TASK_UP, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
        },
        (MENU_ID_NAVIGATE_TASK_DOWN, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
        },
        (MENU_ID_NAVIGATE_REPO_UP, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
        },
        (MENU_ID_NAVIGATE_REPO_DOWN, Some(label)) => NativeWorkspaceMenuAction::DispatchToFocused {
            label: label.to_string(),
            event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
        },
        _ => NativeWorkspaceMenuAction::None,
    }
}

fn create_root_kanna_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
        .title("")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()?;
    Ok(())
}

fn handle_native_workspace_menu_event(app: &tauri::AppHandle, menu_id: &str) {
    let focused_label = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label);

    match resolve_native_workspace_menu_action(menu_id, focused_label.as_deref()) {
        NativeWorkspaceMenuAction::DispatchToFocused { label, event } => {
            if app.get_webview_window(&label).is_some() {
                if let Err(error) = app.emit_to(EventTarget::webview_window(&label), event, ()) {
                    eprintln!("[menu] failed to emit {} to {}: {}", event, label, error);
                }
            }
        }
        NativeWorkspaceMenuAction::CreateRootWindow => {
            if let Err(error) = create_root_kanna_window(app) {
                eprintln!("[menu] failed to create root window: {}", error);
            }
        }
        NativeWorkspaceMenuAction::None => {}
    }
}

/// Install a native macOS event monitor that intercepts fn+F (Globe+F) and
/// toggles fullscreen.  The fn/Globe modifier sets NSEventModifierFlagFunction
/// on the NSEvent, which JavaScript cannot detect — so we must handle it here,
/// before the event reaches WKWebView / xterm.js.
///
/// After toggling fullscreen we schedule a focus-restore: WKWebView loses
/// first-responder status during the exit animation, and calling
/// `element.focus()` via `evaluateJavaScript:` triggers `becomeFirstResponder`
/// on modern WebKit (Bug 143482 fix, 2015).
#[cfg(target_os = "macos")]
fn setup_fn_f_fullscreen(app: tauri::AppHandle) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr};
    use std::ptr::{self, NonNull};

    let block = block2::RcBlock::new(move |event: NonNull<AnyObject>| -> *mut AnyObject {
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
                                if let Some(ns_app_cls) = AnyClass::get(c"NSApplication") {
                                    let ns_app: Option<Retained<AnyObject>> =
                                        msg_send![ns_app_cls, sharedApplication];
                                    if let Some(ns_app) = ns_app {
                                        let win: Option<Retained<AnyObject>> =
                                            msg_send![&*ns_app, keyWindow];
                                        if let Some(win) = win {
                                            let _: () = msg_send![
                                                &*win,
                                                toggleFullScreen: ptr::null::<AnyObject>()
                                            ];
                                        }
                                    }
                                }
                                // Schedule focus restoration after the ~700ms animation.
                                // Webview::set_focus() calls wry's focus() which does
                                // [window makeFirstResponder:webview] — restoring
                                // keyboard event delivery to the WKWebView.
                                // NOTE: WebviewWindow::set_focus() only focuses the
                                // NSWindow; we need AsRef<Webview>::set_focus() to
                                // reach the WKWebView's makeFirstResponder.
                                let app_clone = app.clone();
                                std::thread::spawn(move || {
                                    std::thread::sleep(std::time::Duration::from_secs(1));
                                    if let Some(w) = app_clone.get_webview_window("main") {
                                        let wv: &tauri::Webview<_> = w.as_ref();
                                        let _ = wv.set_focus();
                                        let _ = wv.eval("window.__kannaRestoreFocus?.()");
                                    }
                                });
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
    kanna_runtime_defaults::daemon_dir_for_current_runtime()
}

pub fn daemon_socket_path() -> PathBuf {
    short_socket_path(&daemon_data_dir())
}

#[cfg(debug_assertions)]
fn resolve_webdriver_port() -> Option<u16> {
    if let Ok(explicit) = std::env::var("KANNA_WEBDRIVER_PORT") {
        match explicit.parse::<u16>() {
            Ok(port) => return Some(port),
            Err(error) => {
                eprintln!(
                    "[webdriver] invalid KANNA_WEBDRIVER_PORT {:?}: {}",
                    explicit, error
                );
            }
        }
    }

    if std::env::var("KANNA_WORKTREE").is_ok() {
        None
    } else {
        Some(4445)
    }
}

/// Compute the kanna.sock path for the pipeline listener.
/// Uses short_socket_path to stay under macOS SUN_LEN (104 bytes).
fn pipeline_socket_path() -> PathBuf {
    let dir = daemon_data_dir().join("pipeline");
    short_socket_path(&dir)
}

/// Spawn a Unix socket listener at kanna.sock that accepts stage-complete
/// notifications from kanna-cli. Each connection sends a single JSON line;
/// we parse it and emit a Tauri event so the frontend can react.
fn spawn_pipeline_listener(app: &tauri::AppHandle) {
    let socket_path = pipeline_socket_path();

    // Store the path in managed state so the frontend can retrieve it
    let state: tauri::State<'_, PipelineSocketState> = app.state();
    {
        let path_str = socket_path.to_string_lossy().to_string();
        let state_inner = state.inner().clone();
        tauri::async_runtime::block_on(async {
            *state_inner.lock().await = Some(path_str);
        });
    }

    // Remove stale socket file if it exists
    if socket_path.exists() {
        if let Err(e) = std::fs::remove_file(&socket_path) {
            eprintln!(
                "[pipeline-listener] failed to remove stale socket {:?}: {}",
                socket_path, e
            );
        }
    }

    // Ensure the parent directory exists
    if let Some(parent) = socket_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[pipeline-listener] failed to create directory {:?}: {}",
                parent, e
            );
            return;
        }
    }

    let app_handle = app.clone();
    let path = socket_path.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[pipeline-listener] failed to bind {:?}: {}", path, e);
                return;
            }
        };

        eprintln!("[pipeline-listener] listening on {:?}", path);

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    eprintln!("[pipeline-listener] accept error: {}", e);
                    continue;
                }
            };

            let reader = tokio::io::BufReader::new(stream);
            let mut lines = reader.lines();

            match lines.next_line().await {
                Ok(Some(line)) => {
                    let parsed: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("[pipeline-listener] invalid JSON: {} — {:?}", e, line);
                            continue;
                        }
                    };

                    let msg_type = parsed.get("type").and_then(|t| t.as_str());
                    let task_id = parsed.get("task_id").and_then(|t| t.as_str());

                    if msg_type == Some("stage_complete") {
                        if let Some(tid) = task_id {
                            eprintln!("[pipeline-listener] stage_complete for task {}", tid);
                            let _ = app_handle.emit(
                                "pipeline_stage_complete",
                                serde_json::json!({ "task_id": tid }),
                            );
                        } else {
                            eprintln!("[pipeline-listener] stage_complete missing task_id");
                        }
                    }
                }
                Ok(None) => {
                    // Connection closed without sending data
                }
                Err(e) => {
                    eprintln!("[pipeline-listener] read error: {}", e);
                }
            }
            // Connection is dropped/closed here automatically
        }
    });
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

    let daemon_bin = commands::fs::sidecar_candidates("kanna-daemon")
        .into_iter()
        .find(|path| path.exists());

    let Some(daemon_bin) = daemon_bin else {
        eprintln!("[daemon] daemon binary not found — PTY sessions will not work");
        return;
    };

    let daemon_dir = daemon_data_dir();
    let inferred_worktree = kanna_runtime_defaults::worktree_root_for_path(&daemon_bin)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| kanna_runtime_defaults::worktree_root_for_path(&path))
        })
        .is_some();
    let is_worktree = std::env::var("KANNA_WORKTREE").is_ok() || inferred_worktree;
    eprintln!(
        "[daemon] spawning {:?} (worktree={}, daemon_dir={:?})",
        daemon_bin, is_worktree, daemon_dir
    );
    use std::os::unix::process::CommandExt;
    // setsid() detaches daemon from our process group so Ctrl+C doesn't kill it
    let mut cmd = std::process::Command::new(&daemon_bin);
    let mut explicit_env = Vec::new();
    if is_worktree {
        explicit_env.push(("KANNA_WORKTREE".to_string(), "1".to_string()));
    }
    explicit_env.push((
        "KANNA_DAEMON_DIR".to_string(),
        daemon_dir.to_string_lossy().to_string(),
    ));
    subprocess_env::apply_child_env(&mut cmd, explicit_env);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        })
        .spawn()
    } {
        Ok(child) => {
            let expected_pid = child.id().to_string();
            let pid_path = daemon_dir.join("daemon.pid");

            // Wait for the NEW daemon to be ready:
            // PID file must match our child AND socket must be connectable.
            // This ensures we don't connect to the old daemon during handoff.
            let mut delay = std::time::Duration::from_millis(50);
            for _ in 0..20 {
                tokio::time::sleep(delay).await;
                if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
                    if pid_str.trim() == expected_pid && try_connect_daemon().await.is_some() {
                        eprintln!("[daemon] spawned and connected (pid={})", expected_pid);
                        return;
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
                            Some("SessionCreated") => {
                                let _ = app.emit("session_created", &event);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    {
        if let Some(webdriver_port) = resolve_webdriver_port() {
            builder = builder.plugin(tauri_plugin_webdriver::init_with_port(webdriver_port));
        }
    }

    builder
        .manage(Arc::new(DashMap::new()) as AgentState)
        .manage(Arc::new(Mutex::new(None)) as DaemonState)
        .manage(Arc::new(Mutex::new(std::collections::HashMap::<
            String,
            std::collections::HashSet<String>,
        >::new())) as AttachedSessions)
        .manage(Arc::new(Mutex::new(std::collections::HashMap::<
            String,
            ActiveAttachedStream,
        >::new())) as ActiveAttachedStreams)
        .manage(Arc::new(Mutex::new(std::collections::HashMap::<
            String,
            std::collections::HashMap<String, (u16, u16)>,
        >::new())) as WindowSessionSizes)
        .manage(Arc::new(Mutex::new(None)) as PipelineSocketState)
        .manage(Arc::new(Mutex::new(None)) as TransferServiceState)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                fix_path_from_shell();
                setup_fn_f_fullscreen(app.handle().clone());
            }

            // Build app menu with full version in About
            let about = AboutMetadataBuilder::new()
                .short_version(Some(KANNA_VERSION))
                .version(Some(KANNA_BUILD_INFO))
                .build();
            let app_submenu = SubmenuBuilder::new(app, "Kanna")
                .about(Some(about))
                .separator()
                .quit()
                .build()?;
            let new_window_item = MenuItemBuilder::with_id(MENU_ID_NEW_WINDOW, "New Window")
                .accelerator("CmdOrControl+N")
                .build(app)?;
            let close_window_item = MenuItemBuilder::with_id(MENU_ID_CLOSE_WINDOW, "Close Window")
                .accelerator("CmdOrControl+W")
                .build(app)?;
            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(&new_window_item)
                .separator()
                .item(&close_window_item)
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
            let previous_task_item =
                MenuItemBuilder::with_id(MENU_ID_NAVIGATE_TASK_UP, "Previous Task")
                    .accelerator("CmdOrControl+Alt+ArrowUp")
                    .build(app)?;
            let next_task_item = MenuItemBuilder::with_id(MENU_ID_NAVIGATE_TASK_DOWN, "Next Task")
                .accelerator("CmdOrControl+Alt+ArrowDown")
                .build(app)?;
            let previous_repo_item =
                MenuItemBuilder::with_id(MENU_ID_NAVIGATE_REPO_UP, "Previous Repo")
                    .accelerator("CmdOrControl+Shift+ArrowUp")
                    .build(app)?;
            let next_repo_item = MenuItemBuilder::with_id(MENU_ID_NAVIGATE_REPO_DOWN, "Next Repo")
                .accelerator("CmdOrControl+Shift+ArrowDown")
                .build(app)?;
            let navigate_submenu = SubmenuBuilder::new(app, "Navigate")
                .item(&previous_task_item)
                .item(&next_task_item)
                .separator()
                .item(&previous_repo_item)
                .item(&next_repo_item)
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window").minimize().build()?;
            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&file_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&navigate_submenu)
                .item(&window_submenu)
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app_handle, event| {
                handle_native_workspace_menu_event(app_handle, event.id().as_ref());
            });

            let mobile_app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let mobile_manager = commands::mobile::MobileServerManager::new(mobile_app_data_dir);
            app.manage(mobile_manager.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(err) = mobile_manager.start().await {
                    eprintln!("[mobile] failed to start kanna-server: {}", err);
                }
            });

            // Restore webview focus when the window gains focus.
            // This catches fullscreen exit (green button, View menu) and app
            // switching — the WKWebView may not be first responder after these
            // transitions.  Webview::set_focus() calls wry's makeFirstResponder.
            if let Some(main_win) = app.get_webview_window("main") {
                let mw = main_win.clone();
                main_win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        let w = mw.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            let wv: &tauri::Webview<_> = w.as_ref();
                            let _ = wv.set_focus();
                            let _ = wv.eval("window.__kannaRestoreFocus?.()");
                        });
                    }
                });
            }

            // Start pipeline socket listener (kanna.sock) — must run before
            // agents are spawned so KANNA_SOCKET_PATH is available.
            spawn_pipeline_listener(app.handle());

            let handle = app.handle().clone();
            let daemon_state: DaemonState = app.handle().state::<DaemonState>().inner().clone();
            let daemon_state_bridge = daemon_state.clone();
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
            commands::daemon::get_session_recovery_state,
            commands::daemon::seed_session_recovery_state,
            commands::daemon::attach_session_with_snapshot,
            commands::daemon::detach_session,
            // Git commands
            commands::git::git_diff,
            commands::git::git_diff_range,
            commands::git::git_merge_base,
            commands::git::git_worktree_list,
            commands::git::git_log,
            commands::git::git_graph,
            commands::git::git_default_branch,
            commands::git::git_current_branch,
            commands::git::git_list_base_branches,
            commands::git::git_list_remote_base_branches,
            commands::git::git_branch_upstream,
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
            commands::fs::get_app_build_info,
            commands::fs::get_pipeline_socket_path,
            commands::fs::copy_file,
            commands::fs::remove_file,
            commands::fs::list_dir,
            commands::fs::ensure_directory,
            commands::fs::read_dir_entries,
            commands::fs::read_builtin_resource,
            commands::fs::list_builtin_resources,
            commands::fs::read_clipboard_image_png,
            commands::sqlite::backup_sqlite_database,
            commands::cloud::post_cloud_task_snapshot,
            // Mobile commands
            commands::mobile::mobile_server_status,
            commands::mobile::create_mobile_pairing_session,
            // Shell commands
            commands::shell::run_script,
            commands::shell::ensure_term_init,
            // Transfer commands
            commands::transfer::list_transfer_peers,
            commands::transfer::set_transfer_task_snapshot,
            commands::transfer::list_transfer_task_snapshots,
            commands::transfer::observe_transfer_peer_session,
            commands::transfer::unobserve_transfer_peer_session,
            commands::transfer::send_transfer_peer_session_input,
            commands::transfer::resize_transfer_peer_session,
            commands::transfer::close_transfer_peer_task,
            commands::transfer::start_peer_pairing,
            commands::transfer::accept_peer_pairing,
            commands::transfer::reject_peer_pairing,
            commands::transfer::prepare_outgoing_transfer,
            commands::transfer::stage_transfer_artifact,
            commands::transfer::fetch_transfer_artifact,
            commands::transfer::finalize_outgoing_transfer,
            commands::transfer::complete_outgoing_transfer_finalization,
            commands::transfer::acknowledge_incoming_transfer_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::{
        resolve_native_workspace_menu_action, resolve_webdriver_port, NativeWorkspaceMenuAction,
        MENU_ID_CLOSE_WINDOW, MENU_ID_NAVIGATE_REPO_DOWN, MENU_ID_NAVIGATE_REPO_UP,
        MENU_ID_NAVIGATE_TASK_DOWN, MENU_ID_NAVIGATE_TASK_UP, MENU_ID_NEW_WINDOW,
        WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
        WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT, WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
    };

    #[test]
    fn webdriver_disabled_for_worktrees_without_explicit_port() {
        unsafe {
            std::env::set_var("KANNA_WORKTREE", "1");
            std::env::remove_var("KANNA_WEBDRIVER_PORT");
        }
        assert_eq!(resolve_webdriver_port(), None);
        unsafe {
            std::env::remove_var("KANNA_WORKTREE");
        }
    }

    #[test]
    fn webdriver_uses_explicit_port_even_in_worktrees() {
        unsafe {
            std::env::set_var("KANNA_WORKTREE", "1");
            std::env::set_var("KANNA_WEBDRIVER_PORT", "4555");
        }
        assert_eq!(resolve_webdriver_port(), Some(4555));
        unsafe {
            std::env::remove_var("KANNA_WORKTREE");
            std::env::remove_var("KANNA_WEBDRIVER_PORT");
        }
    }

    #[test]
    fn native_new_window_dispatches_to_the_focused_window_when_one_exists() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NEW_WINDOW, Some("window-2")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "window-2".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NEW_WINDOW_EVENT,
            }
        );
    }

    #[test]
    fn native_new_window_creates_a_fresh_window_when_none_are_open() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NEW_WINDOW, None),
            NativeWorkspaceMenuAction::CreateRootWindow
        );
    }

    #[test]
    fn native_close_window_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_CLOSE_WINDOW, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_CLOSE_WINDOW_EVENT,
            }
        );
    }

    #[test]
    fn native_task_navigation_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_UP, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_UP_EVENT,
            }
        );
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_DOWN, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_TASK_DOWN_EVENT,
            }
        );
    }

    #[test]
    fn native_task_navigation_is_ignored_without_a_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_TASK_DOWN, None),
            NativeWorkspaceMenuAction::None
        );
    }

    #[test]
    fn native_repo_navigation_dispatches_to_the_focused_window() {
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_REPO_UP, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_UP_EVENT,
            }
        );
        assert_eq!(
            resolve_native_workspace_menu_action(MENU_ID_NAVIGATE_REPO_DOWN, Some("main")),
            NativeWorkspaceMenuAction::DispatchToFocused {
                label: "main".to_string(),
                event: WINDOW_WORKSPACE_NATIVE_NAVIGATE_REPO_DOWN_EVENT,
            }
        );
    }
}
