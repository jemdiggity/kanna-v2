// Placeholder — full delta update flow (Ed25519 + bspatch) will be implemented here.
// Registered in the Tauri builder so the plugin slot is reserved.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("delta-updater").build()
}
