mod commands;
mod relay_client;

use relay_client::{PendingRequests, RelaySink};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize shared state for the relay connection
    let relay_sink: RelaySink = Arc::new(Mutex::new(None));
    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(relay_sink)
        .manage(pending_requests)
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::connect_relay,
            commands::list_pipeline_items,
            commands::get_pipeline_item,
            commands::list_sessions,
            commands::attach_session,
            commands::detach_session,
            commands::send_input,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
