mod commands;
mod companion_bridge;
mod daemon_client;
mod daemon_lifecycle;
#[cfg(debug_assertions)]
mod dev_url;
mod macos;
mod menu;
mod subprocess_env;
mod transfer_identity;
mod transfer_sidecar;
mod workflow_listener;

use commands::daemon::{
    ActiveAttachedStream, ActiveAttachedStreams, AttachedSessions, DaemonState, WindowSessionSizes,
};
use daemon_lifecycle::{ensure_daemon_running, spawn_event_bridge};
use menu::{
    handle_native_workspace_menu_event, MENU_ID_CLOSE_WINDOW, MENU_ID_NAVIGATE_REPO_DOWN,
    MENU_ID_NAVIGATE_REPO_UP, MENU_ID_NAVIGATE_TASK_DOWN, MENU_ID_NAVIGATE_TASK_UP,
    MENU_ID_NEW_WINDOW,
};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use workflow_listener::spawn_workflow_listener;

/// Managed state holding the workflow completion socket path.
pub type WorkflowSocketState = Arc<Mutex<Option<String>>>;
pub(crate) const KANNA_VERSION: &str = env!("KANNA_VERSION");
pub(crate) const KANNA_BUILD_BRANCH: &str = env!("KANNA_BUILD_BRANCH");
pub(crate) const KANNA_BUILD_COMMIT: &str = env!("KANNA_BUILD_COMMIT");
pub(crate) const KANNA_BUILD_TASK_ID: &str = env!("KANNA_BUILD_TASK_ID");
pub(crate) const KANNA_BUILD_WORKTREE: &str = env!("KANNA_BUILD_WORKTREE");
pub(crate) const KANNA_BUILD_INFO: &str = env!("KANNA_BUILD_INFO");
/// Fingerprint of the `TAURI_CONFIG` this binary's context was expanded from — see
/// `build.rs`, which pins it so cargo cannot hand back a crate built for another config.
#[cfg(debug_assertions)]
pub(crate) const TAURI_CONFIG_FINGERPRINT: &str = env!("KANNA_TAURI_CONFIG_FINGERPRINT");
static RUNTIME_BUNDLE_IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Process-wide lock serializing tests that read or mutate process env vars.
/// Per-module locks cannot serialize against each other, so env-dependent
/// tests in different modules raced (e.g. shell.rs flipping KANNA_DB_NAME
/// while mobile.rs asserted on a config derived from it).
#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}
/// Directory where daemon stores PID file and logs.
pub fn daemon_data_dir() -> PathBuf {
    kanna_runtime_defaults::daemon_dir_for_current_runtime_with_bundle_identifier(
        RUNTIME_BUNDLE_IDENTIFIER.get().map(String::as_str),
        cfg!(debug_assertions),
    )
}

pub fn daemon_socket_path() -> PathBuf {
    kanna_runtime_defaults::socket_path(&daemon_data_dir())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
        .manage(Arc::new(Mutex::new(None)) as WorkflowSocketState)
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let Some(manager) = window
                .app_handle()
                .try_state::<Arc<companion_bridge::CompanionBridgeManager>>()
            else {
                return;
            };
            let manager = Arc::clone(manager.inner());
            let window_label = window.label().to_owned();
            tauri::async_runtime::spawn(async move {
                manager.close_owned_by_window(&window_label).await;
            });
        })
        .setup(|app| {
            let (companion_events, mut companion_event_receiver) = tokio::sync::mpsc::channel(64);
            let companion_manager = Arc::new(companion_bridge::CompanionBridgeManager::new(
                companion_events,
            ));
            app.manage(companion_manager);
            let companion_event_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = companion_event_receiver.recv().await {
                    if let Some(window) =
                        companion_event_app.get_webview_window(&event.owner_window_label)
                    {
                        let _ = window.emit("remote-companion-browser-event", event);
                    }
                }
            });

            #[cfg(target_os = "macos")]
            {
                macos::fix_path_from_shell();
                macos::setup_fn_f_fullscreen(app.handle().clone());
            }
            #[cfg(debug_assertions)]
            dev_url::warn_on_stale_dev_url(app.handle());
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
            let bundle_identifier = app.config().identifier.clone();
            let _ = RUNTIME_BUNDLE_IDENTIFIER.set(bundle_identifier.clone());
            let mobile_manager = commands::mobile::MobileServerManager::new_with_bundle_identifier(
                mobile_app_data_dir,
                bundle_identifier.as_str(),
            );
            app.manage(mobile_manager.clone());
            let server_pid_receiver = mobile_manager.server_pid_receiver();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = mobile_manager.start().await {
                    eprintln!("[mobile] failed to start kanna-server: {}", err);
                }
            });
            // The sidecar's events now arrive over the server's event stream
            // rather than a stdout pipe this process owns, so the reader runs
            // for the app's lifetime instead of per sidecar spawn.
            transfer_sidecar::spawn_transfer_event_poller(app.handle().clone());
            transfer_sidecar::spawn_transfer_companion_event_poller(app.handle().clone());

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

            // Start the workflow socket listener (kanna.sock) — must run before
            // agents are spawned so KANNA_SOCKET_PATH is available.
            spawn_workflow_listener(app.handle());

            let handle = app.handle().clone();
            let daemon_state: DaemonState = app.handle().state::<DaemonState>().inner().clone();
            let daemon_state_bridge = daemon_state.clone();
            tauri::async_runtime::spawn(async move {
                ensure_daemon_running().await;
                // Clear stale connection so commands reconnect to the new daemon
                *daemon_state.lock().await = None;
                spawn_event_bridge(handle, daemon_state_bridge, server_pid_receiver);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Agent commands
            commands::agent::get_claude_usage,
            // Daemon commands
            commands::daemon::spawn_session,
            commands::daemon::spawn_agent_session,
            commands::daemon::send_input,
            commands::daemon::send_agent_input,
            commands::daemon::resize_session,
            commands::daemon::signal_session,
            commands::daemon::kill_session,
            commands::daemon::list_sessions,
            commands::daemon::get_session_recovery_state,
            commands::daemon::seed_session_recovery_state,
            commands::daemon::attach_session_with_snapshot,
            commands::daemon::detach_session,
            #[cfg(debug_assertions)]
            daemon_lifecycle::spawn_replacement_daemon_for_e2e,
            // Git commands
            commands::git::diff::git_diff,
            commands::git::diff::git_diff_branch_range,
            commands::git::diff::git_diff_range,
            commands::git::diff::git_merge_base,
            commands::git::worktree::git_worktree_list,
            commands::git::log::git_log,
            commands::git::log::git_graph,
            commands::git::remote::git_default_branch,
            commands::git::remote::git_repository_has_commits,
            commands::git::remote::git_repository_state,
            commands::git::remote::git_current_branch,
            commands::git::remote::git_list_base_branches,
            commands::git::remote::git_list_remote_base_branches,
            commands::git::remote::git_branch_upstream,
            commands::git::remote::git_remote_url,
            commands::git::remote::git_push,
            commands::git::remote::git_fetch,
            commands::git::worktree::git_worktree_add,
            commands::git::worktree::git_worktree_remove,
            commands::git::log::git_app_info,
            commands::git::clone::git_clone,
            commands::git::clone::git_init,
            // FS commands
            commands::fs::file_exists,
            commands::fs::list_files,
            commands::fs::read_text_file,
            commands::fs::read_image_file_data_url,
            commands::fs::write_text_file,
            commands::fs::which_binary,
            commands::fs::read_env_var,
            commands::fs::append_log,
            commands::fs::get_app_data_dir,
            commands::fs::get_app_build_info,
            commands::fs::get_workflow_socket_path,
            commands::fs::get_pipeline_socket_path,
            commands::fs::copy_file,
            commands::fs::remove_file,
            commands::fs::list_dir,
            commands::fs::ensure_directory,
            commands::fs::read_dir_entries,
            commands::fs::read_builtin_resource,
            commands::fs::list_builtin_resources,
            commands::fs::read_clipboard_image_png,
            commands::cloud::post_cloud_task_snapshot,
            // Remote visual companion bridge commands
            commands::companion::upsert_remote_companion_bridge,
            commands::companion::set_remote_companion_bridge_state,
            commands::companion::set_remote_companion_event_result,
            commands::companion::close_remote_companion_bridge,
            commands::companion::close_remote_companion_bridges_for_lease,
            // Mobile commands
            commands::mobile::ensure_mobile_server,
            commands::mobile::mobile_server_status,
            commands::mobile::create_mobile_pairing_session,
            commands::mobile::desktop_cloud_credential,
            // Shell commands
            commands::shell::run_script,
            commands::shell::ensure_term_init,
            // Transfer commands
            commands::transfer::list_transfer_peers,
            commands::transfer::upsert_external_transfer_peer,
            commands::transfer::remove_external_transfer_peer,
            commands::transfer::clear_external_transfer_peers,
            commands::transfer::get_transfer_identity,
            commands::transfer::set_transfer_task_snapshot,
            commands::transfer::list_transfer_task_snapshots,
            commands::transfer::observe_transfer_peer_session,
            commands::transfer::unobserve_transfer_peer_session,
            commands::transfer::observe_transfer_peer_companion,
            commands::transfer::unobserve_transfer_peer_companion,
            commands::transfer::send_transfer_peer_companion_event,
            commands::transfer::send_transfer_peer_session_input,
            commands::transfer::resize_transfer_peer_session,
            commands::transfer::close_transfer_peer_task,
            commands::transfer::advance_transfer_peer_task_stage,
            commands::transfer::read_transfer_peer_task_file,
            commands::transfer::read_transfer_peer_task_directory,
            commands::transfer::read_transfer_peer_task_diff,
            commands::transfer::mark_transfer_peer_task_read,
            commands::transfer::start_peer_pairing,
            commands::transfer::accept_peer_pairing,
            commands::transfer::reject_peer_pairing,
            commands::transfer::request_task_pull,
            commands::transfer::ensure_cloud_transfer_proxy,
            commands::transfer::remove_cloud_transfer_proxy,
            commands::transfer::clear_cloud_transfer_proxies,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::resolve_webdriver_port;
    use std::ffi::OsString;

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            unsafe { std::env::remove_var(key) };
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.previous {
                    Some(value) => std::env::set_var(self.key, value),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    #[test]
    fn webdriver_env_guard_restores_existing_values() {
        let _lock = super::test_env_lock()
            .lock()
            .expect("env lock should not be poisoned");
        let _outer_worktree = EnvVarGuard::set("KANNA_WORKTREE", "outer-worktree");
        let _outer_webdriver = EnvVarGuard::set("KANNA_WEBDRIVER_PORT", "4666");

        {
            let _worktree = EnvVarGuard::set("KANNA_WORKTREE", "1");
            let _webdriver = EnvVarGuard::unset("KANNA_WEBDRIVER_PORT");
            assert_eq!(std::env::var("KANNA_WORKTREE").as_deref(), Ok("1"));
            assert!(std::env::var_os("KANNA_WEBDRIVER_PORT").is_none());
        }

        assert_eq!(
            std::env::var("KANNA_WORKTREE").as_deref(),
            Ok("outer-worktree")
        );
        assert_eq!(std::env::var("KANNA_WEBDRIVER_PORT").as_deref(), Ok("4666"));
    }

    #[test]
    fn webdriver_disabled_for_worktrees_without_explicit_port() {
        let _lock = super::test_env_lock()
            .lock()
            .expect("env lock should not be poisoned");
        let _worktree = EnvVarGuard::set("KANNA_WORKTREE", "1");
        let _webdriver = EnvVarGuard::unset("KANNA_WEBDRIVER_PORT");

        assert_eq!(resolve_webdriver_port(), None);
    }

    #[test]
    fn webdriver_uses_explicit_port_even_in_worktrees() {
        let _lock = super::test_env_lock()
            .lock()
            .expect("env lock should not be poisoned");
        let _worktree = EnvVarGuard::set("KANNA_WORKTREE", "1");
        let _webdriver = EnvVarGuard::set("KANNA_WEBDRIVER_PORT", "4555");

        assert_eq!(resolve_webdriver_port(), Some(4555));
    }
}
