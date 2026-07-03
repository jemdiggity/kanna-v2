use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct KannaMcpServer {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct KannaMcpConfig {
    #[serde(rename = "mcpServers")]
    mcp_servers: BTreeMap<String, KannaMcpServer>,
}

#[derive(Debug, Serialize)]
struct OpencodeConfig {
    #[serde(rename = "$schema")]
    schema: &'static str,
    mcp: BTreeMap<String, OpencodeMcpServer>,
}

#[derive(Debug, Serialize)]
struct OpencodeMcpServer {
    command: Vec<String>,
    enabled: bool,
    env: BTreeMap<String, String>,
    #[serde(rename = "type")]
    server_type: &'static str,
}

pub fn read_kanna_mcp_server(path: &str) -> Option<KannaMcpServer> {
    let content = std::fs::read_to_string(Path::new(path)).ok()?;
    let config: KannaMcpConfig = serde_json::from_str(&content).ok()?;
    config.mcp_servers.get("kanna-mcp").cloned()
}

pub fn codex_mcp_config_overrides(server: &KannaMcpServer) -> Vec<String> {
    let mut overrides = vec![
        format!(
            "mcp_servers.kanna-mcp.command={}",
            toml_string(&server.command)
        ),
        format!(
            "mcp_servers.kanna-mcp.args={}",
            toml_string_array(&server.args)
        ),
    ];

    for (key, value) in &server.env {
        overrides.push(format!(
            "mcp_servers.kanna-mcp.env.{key}={}",
            toml_string(value)
        ));
    }

    overrides
}

pub fn opencode_mcp_config_content(server: &KannaMcpServer) -> Option<String> {
    let mut command = Vec::with_capacity(1 + server.args.len());
    command.push(server.command.clone());
    command.extend(server.args.clone());

    let mut mcp = BTreeMap::new();
    mcp.insert(
        "kanna-mcp".to_string(),
        OpencodeMcpServer {
            command,
            enabled: true,
            env: server.env.clone(),
            server_type: "local",
        },
    );

    serde_json::to_string(&OpencodeConfig {
        schema: "https://opencode.ai/config.json",
        mcp,
    })
    .ok()
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn toml_string_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}
