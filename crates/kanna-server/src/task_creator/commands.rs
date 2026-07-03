use super::environment::which_binary;
use super::provider::{provider_binary_name, AgentProvider};
use kanna_agent_protocol::mcp::{
    codex_mcp_config_overrides, opencode_mcp_config_content, read_kanna_mcp_server,
};
use std::path::Path;

pub(super) fn build_agent_command(
    provider: &AgentProvider,
    prompt: &str,
    model: Option<&str>,
    permission_mode: Option<&str>,
    allowed_tools: &[String],
    kanna_preamble: Option<&str>,
    mcp_config_path: Option<&str>,
) -> String {
    let prompt_with_fallback = match provider {
        AgentProvider::Claude => prompt.to_string(),
        AgentProvider::Copilot
        | AgentProvider::Codex
        | AgentProvider::Opencode
        | AgentProvider::Antigravity => {
            // TODO: Use native system-prompt flags for these providers once Kanna
            // has verified stable CLI support for them. Until then, prepend the
            // short preamble to the prompt body so the task remains Kanna-aware.
            match kanna_preamble {
                Some(preamble) if !preamble.is_empty() => format!("{preamble}\n\n{prompt}"),
                _ => prompt.to_string(),
            }
        }
    };
    let escaped_prompt = shell_single_quote(&prompt_with_fallback);
    match provider {
        AgentProvider::Claude => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("--model {}", model));
            }
            if !allowed_tools.is_empty() {
                flags.push(format!("--allowedTools {}", allowed_tools.join(",")));
            }
            if let Some(preamble) = kanna_preamble {
                flags.push(format!(
                    "--append-system-prompt '{}'",
                    shell_single_quote(preamble)
                ));
            }
            if let Some(mcp_config_path) = mcp_config_path {
                flags.push(format!(
                    "--mcp-config '{}'",
                    shell_single_quote(mcp_config_path)
                ));
            }
            format!("claude {} '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Copilot => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(mcp_config_path) = mcp_config_path {
                flags.push(format!(
                    "--additional-mcp-config @'{}'",
                    shell_single_quote(mcp_config_path)
                ));
            }
            if let Some(model) = model {
                flags.push(format!("--model={}", model));
            }
            if !allowed_tools.is_empty() {
                for tool in allowed_tools {
                    flags.push(format!("--allow-tool={}", tool));
                }
            }
            format!("copilot {} -i '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Codex => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            extend_codex_mcp_flags(&mut flags, mcp_config_path);
            if let Some(model) = model {
                flags.push(format!("-m {}", model));
            }
            format!("codex {} '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Opencode => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("-m {}", model));
            }
            let executable = which_binary("opencode")
                .ok()
                .flatten()
                .unwrap_or_else(|| "opencode".to_string());
            let mut parts = vec![
                format!("'{}'", shell_single_quote(&executable)),
                "run".to_string(),
                "--interactive".to_string(),
            ];
            if let Some(env_prefix) = opencode_mcp_env_prefix(mcp_config_path) {
                parts.insert(0, env_prefix);
            }
            parts.extend(flags);
            if !prompt.is_empty() {
                parts.push(format!("'{}'", escaped_prompt));
            }
            parts.join(" ")
        }
        AgentProvider::Antigravity => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("--model {}", model));
            }
            let mut parts = vec![provider_binary_name(*provider).to_string()];
            parts.extend(flags);
            if !prompt.is_empty() {
                parts.push("--prompt-interactive".to_string());
                parts.push(format!("'{}'", escaped_prompt));
            }
            parts.join(" ")
        }
    }
}

fn extend_codex_mcp_flags(flags: &mut Vec<String>, mcp_config_path: Option<&str>) {
    let Some(server) = mcp_config_path.and_then(read_kanna_mcp_server) else {
        return;
    };

    for value in codex_mcp_config_overrides(&server) {
        flags.push(format!("-c '{}'", shell_single_quote(&value)));
    }
}

fn opencode_mcp_env_prefix(mcp_config_path: Option<&str>) -> Option<String> {
    let server = mcp_config_path.and_then(read_kanna_mcp_server)?;
    let content = opencode_mcp_config_content(&server)?;
    Some(format!(
        "OPENCODE_CONFIG_CONTENT='{}'",
        shell_single_quote(&content)
    ))
}

fn get_agent_permission_flags(
    provider: AgentProvider,
    permission_mode: Option<&str>,
) -> Vec<String> {
    let normalized = match permission_mode {
        Some("default") | None => None,
        other => other,
    };

    match provider {
        AgentProvider::Claude => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(mode) => vec![format!("--permission-mode {}", mode)],
        },
        AgentProvider::Copilot => vec!["--yolo".to_string()],
        AgentProvider::Codex => match normalized {
            None | Some("dontAsk") => vec!["--yolo".to_string()],
            Some(_) => vec!["--full-auto".to_string()],
        },
        AgentProvider::Opencode => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(_) => Vec::new(),
        },
        AgentProvider::Antigravity => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(_) => Vec::new(),
        },
    }
}

pub(super) fn build_task_shell_command(
    agent_cmd: &str,
    setup_cmds: &[String],
    kanna_cli_path: Option<&str>,
) -> String {
    let mut command_parts = Vec::new();
    if let Some(kanna_cli_path) = kanna_cli_path {
        let quoted = shell_single_quote(kanna_cli_path);
        command_parts.push(format!("export KANNA_CLI_PATH='{}'", quoted));
        if let Some(parent) = Path::new(kanna_cli_path).parent() {
            let parent = shell_single_quote(parent.to_string_lossy().as_ref());
            command_parts.push(format!("export PATH='{}':\"$PATH\"", parent));
        }
    }

    if !setup_cmds.is_empty() {
        let setup_parts = setup_cmds
            .iter()
            .map(|cmd| {
                format!(
                    "printf '\\033[2m$ %s\\033[0m\\n' '{}' && {}",
                    shell_single_quote(cmd),
                    cmd
                )
            })
            .collect::<Vec<_>>()
            .join(" && ");
        command_parts.push(format!(
            "printf '\\033[33mRunning startup...\\033[0m\\n' && {} && printf '\\n'",
            setup_parts
        ));
    }

    command_parts.push(agent_cmd.to_string());
    command_parts.join(" && ")
}

pub(super) fn build_kanna_preamble(
    provider: &AgentProvider,
    task_id: &str,
    stage_name: &str,
    pipeline_name: &str,
    transition: Option<&str>,
    mcp_config_path: Option<&str>,
) -> String {
    let provider_name = provider.as_str();
    let transition = transition.unwrap_or("manual");
    let mut lines = vec![
        "## Kanna Task Context".to_string(),
        format!(
            "You are `{provider_name}` running inside Kanna task `{task_id}`, stage `{stage_name}` of pipeline `{pipeline_name}` with transition `{transition}`."
        ),
        "You are not running inside a Kanna sandbox; use the normal shell tools available in this worktree.".to_string(),
    ];
    if mcp_config_path.is_some() {
        lines.push(
            "An instance-local `kanna-mcp` config is available at `KANNA_MCP_CONFIG`.".to_string(),
        );
        lines.push(kanna_mcp_launch_line(*provider));
    }
    lines.extend([
        "Prefer `kanna-mcp` tools for Kanna task operations when your agent client exposes them.".to_string(),
        "If MCP tools are unavailable, fall back to the instance-local `kanna-cli`; it is exported as `KANNA_CLI_PATH` and its directory is prepended to `PATH`.".to_string(),
        "Use `kanna-cli guide` for the generated fallback CLI manual and current workflow semantics.".to_string(),
        "Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so. Most stages should finish by recording stage completion so Kanna can advance the configured pipeline.".to_string(),
        "When this stage is complete, prefer MCP `kanna_complete_stage`; fallback: `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`.".to_string(),
    ]);
    lines.join("\n")
}

fn kanna_mcp_launch_line(provider: AgentProvider) -> String {
    match provider {
        AgentProvider::Claude => {
            "Claude is launched with this config via `--mcp-config`, so Kanna MCP tools should be available automatically.".to_string()
        }
        AgentProvider::Codex => {
            "Codex is launched with Kanna MCP registration via `-c mcp_servers.kanna-mcp.*` overrides, so Kanna MCP tools should be available automatically.".to_string()
        }
        AgentProvider::Copilot => {
            "Copilot is launched with this config via `--additional-mcp-config`, so Kanna MCP tools should be available automatically.".to_string()
        }
        AgentProvider::Opencode => {
            "OpenCode is launched with Kanna MCP registration via `OPENCODE_CONFIG_CONTENT`, so Kanna MCP tools should be available automatically.".to_string()
        }
        AgentProvider::Antigravity => {
            "Antigravity CLI MCP registration is not wired because `agy 1.0.14` exposes no stable MCP flag or config surface; use the `kanna-cli` fallback for Kanna task operations.".to_string()
        }
    }
}

fn shell_single_quote(value: &str) -> String {
    value.replace('\'', "'\\''")
}
