use super::definitions::RepoConfig;
use super::provider::AgentProvider;
use crate::config::Config;
use crate::db::Db;
use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) fn claim_task_ports(
    db: &Db,
    item_id: &str,
    ports: Option<&HashMap<String, u16>>,
) -> Result<HashMap<String, String>, String> {
    let Some(ports) = ports else {
        return Ok(HashMap::new());
    };

    let mut claimed = db
        .list_task_ports()
        .map_err(|e| format!("db error: {}", e))?
        .into_iter()
        .collect::<HashSet<_>>();
    let existing = db
        .list_task_ports_for_item(item_id)
        .map_err(|e| format!("db error: {}", e))?;
    let mut port_env = HashMap::new();

    for (env_name, preferred) in ports {
        if let Some(existing_port) = existing.get(env_name) {
            claimed.insert(*existing_port);
            port_env.insert(env_name.clone(), existing_port.to_string());
            continue;
        }

        let mut candidate = i64::from(*preferred) + 1;
        loop {
            if !claimed.contains(&candidate)
                && db
                    .claim_task_port(item_id, env_name, candidate)
                    .map_err(|e| format!("db error: {}", e))?
            {
                claimed.insert(candidate);
                port_env.insert(env_name.clone(), candidate.to_string());
                break;
            }
            candidate += 1;
            if candidate > 65535 {
                return Err(format!("no free port available near {}", preferred));
            }
        }
    }

    Ok(port_env)
}

pub(super) fn build_spawn_env(
    config: &Config,
    task_id: &str,
    port_env: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::from([
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "kanna".to_string()),
        ("KANNA_WORKTREE".to_string(), "1".to_string()),
        ("KANNA_TASK_ID".to_string(), task_id.to_string()),
        (
            "KANNA_SOCKET_PATH".to_string(),
            pipeline_socket_path(&config.daemon_dir),
        ),
        (
            "KANNA_SERVER_BASE_URL".to_string(),
            format!("http://127.0.0.1:{}", config.lan_port),
        ),
    ]);
    env.extend(port_env.clone());
    let kanna_cli_path = if let Some(path) = config
        .kanna_cli_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string)
    {
        Some(path)
    } else {
        which_binary("kanna-cli")?
    };
    if let Some(path) = kanna_cli_path {
        if let Some(parent) = Path::new(&path).parent() {
            let runtime_path = prepend_path_entry(
                std::env::var("PATH").ok().as_deref(),
                parent.to_string_lossy().as_ref(),
            );
            env.insert("PATH".to_string(), runtime_path);
        }
        env.insert("KANNA_CLI_PATH".to_string(), path);
    }

    if let Ok(Some(path)) = which_binary("kanna-mcp") {
        if let Some(parent) = Path::new(&path).parent() {
            let existing_path = env
                .get("PATH")
                .cloned()
                .or_else(|| std::env::var("PATH").ok());
            let runtime_path =
                prepend_path_entry(existing_path.as_deref(), parent.to_string_lossy().as_ref());
            env.insert("PATH".to_string(), runtime_path);
        }
        env.insert("KANNA_MCP_PATH".to_string(), path);
    }
    Ok(env)
}

pub(super) fn write_kanna_mcp_config(
    daemon_dir: &str,
    task_id: &str,
    env: &mut HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(mcp_path) = env.get("KANNA_MCP_PATH").cloned() else {
        return Ok(None);
    };
    let server_base_url = env
        .get("KANNA_SERVER_BASE_URL")
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:48120".to_string());
    let config_path = Path::new(daemon_dir)
        .join("runtime")
        .join("mcp")
        .join(format!("{task_id}.json"));
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create Kanna MCP config directory: {e}"))?;
    }
    let config = serde_json::json!({
        "mcpServers": {
            "kanna-mcp": {
                "command": mcp_path,
                "args": ["serve"],
                "env": {
                    "KANNA_SERVER_BASE_URL": server_base_url
                }
            }
        }
    });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("failed to render Kanna MCP config: {e}"))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("failed to write Kanna MCP config: {e}"))?;
    let path = config_path.to_string_lossy().to_string();
    env.insert("KANNA_MCP_CONFIG".to_string(), path.clone());
    Ok(Some(path))
}

pub(super) fn apply_workspace_path_env(
    env: &mut HashMap<String, String>,
    worktree_path: &str,
    repo_config: &RepoConfig,
) {
    let Some(path_config) = repo_config
        .workspace
        .as_ref()
        .and_then(|workspace| workspace.path.as_ref())
    else {
        return;
    };

    let prepend_entries = path_config
        .prepend
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let append_entries = path_config
        .append
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|entry| resolve_workspace_path(worktree_path, entry));
    let existing_path = env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();

    let path_parts = prepend_entries
        .chain(std::iter::once(existing_path).filter(|entry| !entry.is_empty()))
        .chain(append_entries)
        .collect::<Vec<_>>();
    if !path_parts.is_empty() {
        env.insert("PATH".to_string(), path_parts.join(":"));
    }
}

pub(super) fn which_binary(name: &str) -> Result<Option<String>, String> {
    resolve_binary_from_candidates(name, sidecar_candidates(name), None).map(Some)
}

pub(super) fn resolve_headless_agent_executable(
    provider: AgentProvider,
    path: Option<&str>,
    worktree_path: &str,
) -> Result<Option<String>, String> {
    match provider {
        AgentProvider::Claude | AgentProvider::Codex | AgentProvider::Opencode => {
            which_binary_with_path(provider.as_str(), path, worktree_path)
        }
        AgentProvider::Copilot | AgentProvider::Antigravity => Ok(None),
    }
}

fn which_binary_with_path(
    name: &str,
    path: Option<&str>,
    worktree_path: &str,
) -> Result<Option<String>, String> {
    if let Some(path) = path {
        if let Some(binary) = resolve_workspace_binary_from_path(name, path, worktree_path) {
            return Ok(Some(binary));
        }
    }

    resolve_binary_from_candidates(name, sidecar_candidates(name), path).map(Some)
}

fn resolve_binary_from_candidates(
    name: &str,
    candidates: Vec<PathBuf>,
    path: Option<&str>,
) -> Result<String, String> {
    resolve_binary_from_candidates_with_path_lookup(name, candidates, |name| {
        if let Some(path) = path {
            return resolve_binary_from_path(name, path)
                .ok_or_else(|| format!("binary '{}' not found in PATH", name));
        }

        let output = Command::new("/bin/zsh")
            .args(["--login", "-i", "-c", &format!("command -v {}", name)])
            .output()
            .map_err(|e| format!("failed to locate {}: {}", name, e))?;

        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }

        Err(format!("binary '{}' not found in PATH", name))
    })
}

fn resolve_workspace_path(worktree_path: &str, entry: &str) -> String {
    let entry_path = Path::new(entry);
    if entry_path.is_absolute() {
        entry_path.to_string_lossy().to_string()
    } else {
        Path::new(worktree_path)
            .join(entry_path)
            .to_string_lossy()
            .to_string()
    }
}

fn resolve_binary_from_path(name: &str, path: &str) -> Option<String> {
    path.split(':')
        .filter(|entry| !entry.is_empty())
        .map(|entry| Path::new(entry).join(name))
        .find(|candidate| is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

fn resolve_workspace_binary_from_path(
    name: &str,
    path: &str,
    worktree_path: &str,
) -> Option<String> {
    let worktree_path = Path::new(worktree_path);
    path.split(':')
        .filter(|entry| !entry.is_empty())
        .map(Path::new)
        .filter(|entry| entry.starts_with(worktree_path))
        .map(|entry| entry.join(name))
        .find(|candidate| is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub(super) fn resolve_binary_from_candidates_with_path_lookup<F>(
    name: &str,
    candidates: Vec<PathBuf>,
    path_lookup: F,
) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    path_lookup(name)
}

fn current_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    {
        "x86_64-apple-darwin"
    }
}

fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    std::env::current_exe()
        .ok()
        .map(|exe| sidecar_candidates_for_exe(&exe, name))
        .unwrap_or_default()
}

fn sidecar_candidates_for_exe(current_exe: &Path, name: &str) -> Vec<PathBuf> {
    let Some(exe_dir) = current_exe.parent() else {
        return Vec::new();
    };

    let sidecar_name = format!("{}-{}", name, current_target_triple());
    let mut candidates = vec![exe_dir.join(&sidecar_name), exe_dir.join(name)];

    if let (Some(build_root), Some(profile_dir)) = (exe_dir.parent(), exe_dir.file_name()) {
        if build_root.file_name().is_some_and(|dir| dir == ".build")
            && matches!(profile_dir.to_str(), Some("debug" | "release"))
        {
            let triple_dir = build_root.join(current_target_triple()).join(profile_dir);
            candidates.push(triple_dir.join(name));
            candidates.push(triple_dir.join(&sidecar_name));
        }
    }

    candidates.push(exe_dir.join("../Resources").join(&sidecar_name));
    candidates.push(exe_dir.join("../Resources").join(name));
    candidates
}

fn prepend_path_entry(path: Option<&str>, entry: &str) -> String {
    let existing_entries = path
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty() && *part != entry);
    std::iter::once(entry)
        .chain(existing_entries)
        .collect::<Vec<_>>()
        .join(":")
}

fn pipeline_socket_path(daemon_dir: &str) -> String {
    let dir = PathBuf::from(daemon_dir).join("pipeline");
    short_socket_path(&dir).to_string_lossy().to_string()
}

fn short_socket_path(dir: &PathBuf) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    dir.hash(&mut hasher);
    let hash = hasher.finish() as u32;
    PathBuf::from(format!("/tmp/kanna-{:08x}.sock", hash))
}
