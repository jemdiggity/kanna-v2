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
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    mcp: BTreeMap<String, OpencodeMcpServer>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    agent: BTreeMap<String, OpencodeAgentConfig>,
}

#[derive(Debug, Serialize)]
struct OpencodeMcpServer {
    command: Vec<String>,
    enabled: bool,
    env: BTreeMap<String, String>,
    #[serde(rename = "type")]
    server_type: &'static str,
}

#[derive(Debug, Serialize)]
struct OpencodeAgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    variant: String,
}

/// The agent OpenCode's TUI starts in, and therefore the one whose model and
/// variant a reasoning-effort override has to reach.
const OPENCODE_DEFAULT_AGENT: &str = "build";

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
    opencode_config_content(Some(server), None, None)
}

/// Build the `OPENCODE_CONFIG_CONTENT` payload for an OpenCode spawn.
///
/// Both of the things Kanna has to configure travel in this one env var, so
/// they are composed together rather than by two writers racing for the
/// variable: MCP registration (every spawn) and the reasoning-effort variant.
///
/// Effort is here rather than on the argv because OpenCode's **TUI entrypoint
/// rejects `--variant`** — the CLI's default command takes one `[project]`
/// positional and no variant flag, so `opencode --variant high` prints usage
/// and exits before a TUI is ever drawn. `opencode run` does accept the flag,
/// which is why the headless adapter still passes it there. `AgentConfig.variant`
/// applies "only when using the agent's configured model", so the model is
/// written alongside the variant whenever one is known.
///
/// Returns `None` when there is nothing to configure, so callers can skip the
/// env var entirely rather than exporting an empty config.
pub fn opencode_config_content(
    server: Option<&KannaMcpServer>,
    model: Option<&str>,
    variant: Option<&str>,
) -> Option<String> {
    let mut mcp = BTreeMap::new();
    if let Some(server) = server {
        let mut command = Vec::with_capacity(1 + server.args.len());
        command.push(server.command.clone());
        command.extend(server.args.clone());

        mcp.insert(
            "kanna-mcp".to_string(),
            OpencodeMcpServer {
                command,
                enabled: true,
                env: server.env.clone(),
                server_type: "local",
            },
        );
    }

    let mut agent = BTreeMap::new();
    if let Some(variant) = variant.filter(|variant| !variant.is_empty()) {
        agent.insert(
            OPENCODE_DEFAULT_AGENT.to_string(),
            OpencodeAgentConfig {
                model: model.map(str::to_string),
                variant: variant.to_string(),
            },
        );
    }

    if mcp.is_empty() && agent.is_empty() {
        return None;
    }

    serde_json::to_string(&OpencodeConfig {
        schema: "https://opencode.ai/config.json",
        mcp,
        agent,
    })
    .ok()
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn toml_string_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}
