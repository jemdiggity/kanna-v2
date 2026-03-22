mod commands;
mod relay_client;

use relay_client::{PendingRequests, RelaySink};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RelaySink::default())
        .manage(PendingRequests::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_pipeline_items,
            commands::get_pipeline_item,
            commands::list_sessions,
            commands::attach_session,
            commands::detach_session,
            commands::send_input,
            commands::connect_relay,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
