use std::process;

use serde_json::Value;

use crate::commands::print_json;
use crate::commands::tool::{call_catalog_tool, load_tool_catalog_from_current_dir};
use crate::config::resolve_server_base_url_from_env;

pub(crate) async fn run(server_url: Option<&str>) {
    let catalog = load_tool_catalog_from_current_dir().unwrap_or_else(|error| {
        eprintln!("Error: {error}");
        process::exit(1);
    });
    let base_url = resolve_server_base_url_from_env(server_url);
    let (_, info) = call_catalog_tool(
        &base_url,
        &catalog,
        "kanna_info",
        &Value::Object(Default::default()),
    )
    .await
    .unwrap_or_else(|error| {
        eprintln!("Error: {error}");
        process::exit(1);
    });
    if let Err(error) = print_json(&info) {
        eprintln!("Error: {error}");
        process::exit(1);
    }
}
