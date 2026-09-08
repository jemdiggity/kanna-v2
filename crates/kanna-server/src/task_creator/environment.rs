use super::commands::build_task_shell_command;
use super::definitions::RepoConfig;
use super::provider::AgentProvider;
use crate::config::Config;
use crate::db::Db;
use crate::internal_ports::reserve_internal_ports;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) fn claim_task_ports(
    db: &Db,
    item_id: &str,
    repo_config: &RepoConfig,
) -> Result<HashMap<String, String>, String> {
    let ports = repo_config.ports.as_ref();
    let Some(ports) = ports else {
        return Ok(HashMap::new());
    };

    let mut claimed = db
        .list_task_ports()
        .map_err(|e| format!("db error: {}", e))?
        .into_iter()
        .collect::<HashSet<_>>();
    add_reserved_ports(&mut claimed, repo_config);
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

fn add_reserved_ports(occupied: &mut HashSet<i64>, repo_config: &RepoConfig) {
    reserve_internal_ports(occupied);
    for port in &repo_config.reserved_ports {
        if (1..=65535).contains(port) {
            occupied.insert(*port);
        }
    }

    let Some(ports) = repo_config.ports.as_ref() else {
        return;
    };
    for preferred in ports.values() {
        for offset in &repo_config.reserved_port_offsets {
            if *offset < 0 {
                continue;
            }
            let Some(reserved) = i64::from(*preferred).checked_add(*offset) else {
                continue;
            };
            if (1..=65535).contains(&reserved) {
                occupied.insert(reserved);
            }
        }
    }
}

pub(super) fn build_spawn_env(
    config: &Config,
    task_id: &str,
    port_env: &HashMap<String, String>,
    worktree_path: &str,
    repo_config: &RepoConfig,
) -> Result<HashMap<String, String>, String> {
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
    let kanna_mcp_path = which_binary("kanna-mcp").ok().flatten();
    let mut env = HashMap::from([
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "kanna".to_string()),
    ]);

    apply_workspace_env(&mut env, repo_config);
    for executable in [&kanna_cli_path, &kanna_mcp_path].into_iter().flatten() {
        if let Some(parent) = Path::new(executable).parent() {
            let existing_path = env
                .get("PATH")
                .cloned()
                .or_else(|| std::env::var("PATH").ok());
            let runtime_path =
                prepend_path_entry(existing_path.as_deref(), parent.to_string_lossy().as_ref());
            env.insert("PATH".to_string(), runtime_path);
        }
    }
    apply_workspace_path_env(&mut env, worktree_path, repo_config);
    env.extend(port_env.clone());

    // Repo configuration is intentionally layered before this metadata. A
    // checkout may customize its workspace, but it cannot redirect Kanna's
    // task identity or control-plane binaries and endpoints.
    for key in [
        "KANNA_WORKTREE",
        "KANNA_TASK_ID",
        "KANNA_SOCKET_PATH",
        "KANNA_SERVER_BASE_URL",
        "KANNA_TASK_EVENTS_TOKEN_PATH",
        "KANNA_CLI_PATH",
        "KANNA_MCP_PATH",
        "KANNA_MCP_CONFIG",
        kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV,
        kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV,
    ] {
        env.remove(key);
    }
    env.insert("KANNA_WORKTREE".to_string(), "1".to_string());
    env.insert("KANNA_TASK_ID".to_string(), task_id.to_string());
    env.insert(
        "KANNA_SOCKET_PATH".to_string(),
        workflow_socket_path(&config.daemon_dir),
    );
    env.insert(
        "KANNA_SERVER_BASE_URL".to_string(),
        kanna_server_base_url(config),
    );
    if let Some(path) = config.task_events_token_path() {
        env.insert(
            "KANNA_TASK_EVENTS_TOKEN_PATH".to_string(),
            path.to_string_lossy().to_string(),
        );
    }

    if let Some(path) = kanna_cli_path {
        env.insert("KANNA_CLI_PATH".to_string(), path);
    }

    if let Some(path) = kanna_mcp_path {
        env.insert("KANNA_MCP_PATH".to_string(), path);
    }
    Ok(env)
}

pub(super) fn write_kanna_mcp_config(
    daemon_dir: &str,
    task_id: &str,
    server_base_url: &str,
    env: &mut HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(mcp_path) = env.get("KANNA_MCP_PATH").cloned() else {
        return Ok(None);
    };
    let config_path = Path::new(daemon_dir)
        .join("runtime")
        .join("mcp")
        .join(format!("{task_id}.json"));
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create Kanna MCP config directory: {e}"))?;
    }
    let mut mcp_env = serde_json::Map::from_iter([(
        "KANNA_SERVER_BASE_URL".to_string(),
        serde_json::Value::String(server_base_url.to_string()),
    )]);
    if let Some(token_path) = env.get("KANNA_TASK_EVENTS_TOKEN_PATH") {
        mcp_env.insert(
            "KANNA_TASK_EVENTS_TOKEN_PATH".to_string(),
            serde_json::Value::String(token_path.clone()),
        );
    }
    let config = serde_json::json!({
        "mcpServers": {
            "kanna-mcp": {
                "command": mcp_path,
                "args": ["serve"],
                "env": mcp_env
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

pub(super) fn kanna_server_base_url(config: &Config) -> String {
    format!("http://127.0.0.1:{}", config.lan_port)
}

pub(super) fn apply_workspace_config_env(
    env: &mut HashMap<String, String>,
    worktree_path: &str,
    repo_config: &RepoConfig,
) {
    apply_workspace_env(env, repo_config);
    apply_workspace_path_env(env, worktree_path, repo_config);
}

fn apply_workspace_env(env: &mut HashMap<String, String>, repo_config: &RepoConfig) {
    let Some(workspace_config) = repo_config.workspace.as_ref() else {
        return;
    };

    if let Some(config_env) = workspace_config.env.as_ref() {
        env.extend(config_env.clone());
    }
}

fn apply_workspace_path_env(
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

pub(super) fn run_workspace_setup_commands(
    setup_cmds: &[String],
    worktree_path: &str,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    if setup_cmds.is_empty() {
        return Ok(());
    }

    let command = build_task_shell_command(
        "true",
        setup_cmds,
        None,
        None,
        env.get("KANNA_CLI_PATH").map(String::as_str),
        env.get("PATH").map(String::as_str),
    );
    crate::workspace_commands::run_workspace_command(
        "workspace setup",
        &command,
        Path::new(worktree_path),
        env,
    )
}

#[cfg(test)]
pub(super) fn run_workspace_setup_commands_with_armed_timeout(
    setup_cmds: &[String],
    worktree_path: &str,
    env: &HashMap<String, String>,
    armed_timeout: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let command = build_task_shell_command(
        "true",
        setup_cmds,
        None,
        None,
        env.get("KANNA_CLI_PATH").map(String::as_str),
        env.get("PATH").map(String::as_str),
    );
    crate::workspace_commands::run_workspace_command_with_armed_timeout_for_test(
        "workspace setup",
        &command,
        Path::new(worktree_path),
        env,
        armed_timeout,
    )
}

pub(super) fn append_executable_parent_to_path(
    path: Option<&str>,
    executable: &str,
) -> Option<String> {
    let parent = Path::new(executable).parent()?.to_string_lossy();
    if parent.is_empty() {
        return path.map(str::to_string);
    }
    if path
        .unwrap_or_default()
        .split(':')
        .any(|entry| entry == parent)
    {
        return path.map(str::to_string);
    }

    match path.filter(|path| !path.is_empty()) {
        Some(path) => Some(format!("{path}:{parent}")),
        None => Some(parent.into_owned()),
    }
}

pub(super) fn build_workspace_search_path(
    workspace_root: &str,
    repo_config: &RepoConfig,
) -> Option<String> {
    let mut env = HashMap::new();
    apply_workspace_config_env(&mut env, workspace_root, repo_config);
    env.remove("PATH")
}

pub(super) fn which_binary(name: &str) -> Result<Option<String>, String> {
    resolve_binary_from_candidates(name, sidecar_candidates(name), None).map(Some)
}

pub(super) fn resolve_headless_agent_executable(
    provider: AgentProvider,
    path: Option<&str>,
    worktree_path: &str,
) -> Result<Option<String>, String> {
    if !provider.supports_headless() {
        return Err(format!(
            "provider {provider} does not support headless agent sessions"
        ));
    }
    resolve_provider_executable(provider, path, worktree_path).map(Some)
}

pub(super) fn resolve_provider_executable(
    provider: AgentProvider,
    path: Option<&str>,
    workspace_root: &str,
) -> Result<String, String> {
    which_binary_with_path(provider.executable(), path, workspace_root)
}

fn which_binary_with_path(
    name: &str,
    path: Option<&str>,
    worktree_path: &str,
) -> Result<String, String> {
    if let Some(path) = path {
        if let Some(binary) = resolve_workspace_binary_from_path(name, path, worktree_path) {
            return Ok(binary);
        }
    }

    if let Some(binary) = test_provider_fixture_binary(name, worktree_path) {
        return Ok(binary);
    }

    resolve_binary_from_candidates(name, sidecar_candidates(name), path)
}

/// The scripted agent CLIs a test repository carries in
/// `.kanna/test-provider-bin`.
///
/// A test build must never resolve an agent CLI that merely happens to be
/// installed on the machine running it, or the suite passes on a laptop with
/// `claude` installed and fails on a build host without one. The fixture used
/// to reach this resolver only as a `workspace.path.prepend` in the test
/// repo's `.kanna/config.json` — which every test that writes a config of its
/// own silently dropped, and which a stage prepared before its worktree exists
/// never had at all. Reading the directory out of the workspace itself is what
/// makes the one fixture apply to every code path that probes with a workspace
/// root, whatever that repo's config happens to say.
#[cfg(test)]
fn test_provider_fixture_binary(name: &str, workspace_root: &str) -> Option<String> {
    let workspace_root = Path::new(workspace_root);
    if !workspace_root.is_absolute() {
        return None;
    }
    let candidate = workspace_root.join(".kanna/test-provider-bin").join(name);
    kanna_runtime_defaults::is_executable_file(&candidate)
        .then(|| candidate.to_string_lossy().to_string())
}

#[cfg(not(test))]
fn test_provider_fixture_binary(_name: &str, _workspace_root: &str) -> Option<String> {
    None
}

/// The user's real PATH as an interactive login shell resolves it, captured
/// ONCE per process. Loading the shell's startup files costs seconds; it used to run per binary
/// lookup on the stage-advance request path, which is where the multi-second
/// ⌘S-to-prompt lag came from. `warm_login_shell_path` pays the one-time cost
/// at server startup, off the request path. Binary resolution also checks live
/// user install locations so an agent installed later does not require a server
/// restart merely because the cached PATH predates it.
fn login_shell_path() -> Option<&'static str> {
    static LOGIN_SHELL_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    LOGIN_SHELL_PATH
        .get_or_init(|| {
            let shell = crate::login_shell::login_shell();
            let output = Command::new(shell.path())
                .args(shell.login_interactive_args("printf %s \"$PATH\""))
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .as_deref()
}

pub(crate) fn warm_login_shell_path() {
    let _ = login_shell_path();
}

/// Absolute path to an agent CLI, resolved the way a spawned task resolves it.
///
/// `kanna-server` is started with `subprocess_env::apply_child_env`, which
/// injects no PATH, so a Finder- or Spotlight-launched Kanna gives it the
/// launchd default — which contains none of the places these CLIs actually live
/// (`~/.opencode/bin`, `~/.bun/bin`, Homebrew). Anything that execs an agent
/// binary by bare name works from a terminal and fails in a packaged app, so it
/// goes through the same process-PATH-then-cached-login-shell-PATH lookup every
/// task spawn already uses.
pub(crate) fn resolve_agent_executable(provider: AgentProvider) -> Result<String, String> {
    resolve_provider_executable(provider, None, "")
}

/// Cheap binary availability check against the process PATH, the cached
/// login-shell PATH, and live user install locations — never a per-call login
/// shell.
fn resolve_binary_from_candidates(
    name: &str,
    candidates: Vec<PathBuf>,
    path: Option<&str>,
) -> Result<String, String> {
    resolve_binary_from_candidates_with_path_lookup(name, candidates, |name| {
        // An agent CLI never resolves from the host in a test build. The
        // production chain below deliberately reaches past the caller's PATH
        // into the login shell and the user's install directories, so leaving
        // it in place makes every provider-availability assertion a statement
        // about which CLIs the developer happens to have installed. Providers
        // come from the workspace fixture resolved above, or from a lookup
        // path a test names explicitly. Sidecars are Kanna's own binaries and
        // keep the real chain.
        #[cfg(test)]
        if !matches!(name, "kanna-cli" | "kanna-mcp") {
            return match std::env::var("KANNA_TEST_PROVIDER_LOOKUP_PATH") {
                Ok(test_path) => resolve_binary_from_path(name, &test_path)
                    .ok_or_else(|| format!("binary '{name}' not found in test provider PATH")),
                Err(_) => Err(format!(
                    "binary '{name}' is not supplied by any test provider fixture"
                )),
            };
        }

        if let Some(path) = path {
            if let Some(binary) = resolve_binary_from_path(name, path) {
                return Ok(binary);
            }
        }

        // The process PATH first (cheap, and correct when launched from a
        // terminal), then the captured login-shell PATH (Spotlight-launched
        // apps inherit a minimal PATH).
        if let Ok(process_path) = std::env::var("PATH") {
            if let Some(binary) = resolve_binary_from_path(name, &process_path) {
                return Ok(binary);
            }
        }
        if let Some(login_path) = login_shell_path() {
            if let Some(binary) = resolve_binary_from_path(name, login_path) {
                return Ok(binary);
            }
        }
        if let Some(binary) = kanna_runtime_defaults::find_user_binary(name) {
            return Ok(binary.to_string_lossy().to_string());
        }

        Err(format!(
            "binary '{}' not found in PATH or user install locations",
            name
        ))
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
    kanna_runtime_defaults::which_binary_in_path(name, path)
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
        .find(|candidate| kanna_runtime_defaults::is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

pub(super) fn resolve_binary_from_candidates_with_path_lookup<F>(
    name: &str,
    candidates: Vec<PathBuf>,
    path_lookup: F,
) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    kanna_runtime_defaults::resolve_binary_from_candidates(name, candidates, path_lookup)
}

fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    kanna_runtime_defaults::sidecar_candidates(name)
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

/// The `pipeline` directory name is the legacy on-disk spelling and stays part
/// of the cross-version socket contract; only the symbols say workflow.
fn workflow_socket_path(daemon_dir: &str) -> String {
    let dir = PathBuf::from(daemon_dir).join("pipeline");
    kanna_runtime_defaults::socket_path(&dir)
        .to_string_lossy()
        .to_string()
}
