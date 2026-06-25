pub(crate) mod guide;
pub(crate) mod repo;
pub(crate) mod socket;
pub(crate) mod stage_complete;
pub(crate) mod task;
pub(crate) mod tool;

use serde::Serialize;
use serde_json::Value;

pub(crate) fn parse_metadata_json(metadata: &Option<String>) -> Result<Option<Value>, String> {
    match metadata {
        Some(json_str) => serde_json::from_str(json_str)
            .map(Some)
            .map_err(|e| format!("--metadata is not valid JSON: {e}")),
        None => Ok(None),
    }
}

pub(crate) fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let rendered =
        serde_json::to_string_pretty(value).map_err(|e| format!("failed to render json: {e}"))?;
    println!("{rendered}");
    Ok(())
}
