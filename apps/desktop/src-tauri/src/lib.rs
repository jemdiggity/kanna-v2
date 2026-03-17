mod commands;
mod daemon_client;

use std::sync::Arc;
use tokio::sync::Mutex;

use commands::daemon::DaemonState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let daemon_state: DaemonState = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(daemon_state)
        .invoke_handler(tauri::generate_handler![
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
            commands::git::git_worktree_list,
            commands::git::git_log,
            commands::git::git_default_branch,
            commands::git::git_remote_url,
            commands::git::git_push,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            // FS commands
            commands::fs::file_exists,
            commands::fs::read_text_file,
            commands::fs::which_binary,
            // Shell commands
            commands::shell::run_script,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
