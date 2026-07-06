use super::environment::which_binary;
use super::provider::{provider_binary_name, AgentProvider};
use kanna_agent_protocol::mcp::{
    codex_mcp_config_overrides, opencode_mcp_config_content, read_kanna_mcp_server,
};
use kanna_agent_protocol::prompt_with_system_prompt;
use std::path::Path;

/// How a Claude PTY spawn binds to the CLI's own session store: `Assign`
/// starts a fresh conversation under a Kanna-chosen UUID (`--session-id`) so
/// a later revision can resume it; `Resume` reopens a previous run's
/// conversation (`--resume`). The desktop TS spawn path
/// (`apps/desktop/src/stores/agentCommand.ts`) follows the same convention.
pub(super) enum ClaudeSessionBinding {
    Assign(String),
    Resume(String),
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_agent_command(
    provider: &AgentProvider,
    prompt: &str,
    model: Option<&str>,
    permission_mode: Option<&str>,
    allowed_tools: &[String],
    kanna_preamble: Option<&str>,
    mcp_config_path: Option<&str>,
    worktree_path: Option<&str>,
    claude_session: Option<&ClaudeSessionBinding>,
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
            prompt_with_system_prompt(kanna_preamble, prompt)
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
            match claude_session {
                Some(ClaudeSessionBinding::Assign(session_id)) => {
                    flags.push(format!("--session-id '{}'", shell_single_quote(session_id)));
                }
                Some(ClaudeSessionBinding::Resume(session_id)) => {
                    flags.push(format!("--resume '{}'", shell_single_quote(session_id)));
                }
                None => {}
            }
            // `--` terminates option parsing. Without it, variadic flags eat
            // the positional prompt: `--mcp-config <path> '<prompt>'` makes
            // the CLI treat the prompt as a second MCP config file and exit
            // with "MCP config file not found: <prompt>".
            format!("claude {} -- '{}'", flags.join(" "), escaped_prompt)
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
            let mut setup = Vec::new();
            if let Some(worktree_path) = worktree_path {
                let alias_base = "/tmp/kanna-antigravity-workspaces";
                let alias_path = format!(
                    "{}/{}",
                    alias_base,
                    safe_antigravity_alias_name(worktree_path)
                );
                setup.push(format!("mkdir -p '{}'", shell_single_quote(alias_base)));
                setup.push(format!("rm -f '{}'", shell_single_quote(&alias_path)));
                setup.push(format!(
                    "ln -s '{}' '{}'",
                    shell_single_quote(worktree_path),
                    shell_single_quote(&alias_path)
                ));
                flags.push(format!("--add-dir '{}'", shell_single_quote(&alias_path)));
            }
            let mut parts = vec![provider_binary_name(*provider).to_string()];
            parts.extend(flags);
            if !prompt.is_empty() {
                parts.push("--prompt-interactive".to_string());
                parts.push(format!("'{}'", escaped_prompt));
            }
            setup.push(parts.join(" "));
            setup.join(" && ")
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
    spawn_path: Option<&str>,
) -> String {
    let mut command_parts = Vec::new();
    if let Some(kanna_cli_path) = kanna_cli_path {
        let quoted = shell_single_quote(kanna_cli_path);
        command_parts.push(format!("export KANNA_CLI_PATH='{}'", quoted));
    }

    if let Some(spawn_path) = spawn_path.filter(|path| !path.is_empty()) {
        command_parts.push(format!("export PATH='{}'", shell_single_quote(spawn_path)));
    } else if let Some(kanna_cli_path) = kanna_cli_path {
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

pub(super) fn build_teardown_shell_command(teardown_cmds: &[String]) -> String {
    if teardown_cmds.is_empty() {
        return "exit 0".to_string();
    }

    let teardown_parts = teardown_cmds
        .iter()
        .map(|cmd| {
            let escaped = shell_single_quote(cmd);
            format!(
                "( {{ printf '\\033[2m$ %s\\033[0m\\n' '{escaped}' && ( {cmd} ); }} || printf '\\033[31mTeardown command failed; continuing: %s\\033[0m\\n' '{escaped}' )"
            )
        })
        .collect::<Vec<_>>()
        .join(" ; ");

    format!(
        "printf '\\033[33mRunning teardown...\\033[0m\\n' ; {} ; printf '\\n' ; exit 0",
        teardown_parts
    )
}

/// Canonical Kanna runtime guidance shared with the desktop frontend.
/// `packages/core/src/pipeline/prompt-builder.ts` mirrors this file as a TS
/// constant; a sync test there keeps both sides byte-identical.
const KANNA_TASK_ENVIRONMENT_TEMPLATE: &str =
    include_str!("../../../../packages/core/src/pipeline/kanna-task-environment.md");

// Completion guidance depends on the stage's transition policy: only `auto`
// stages advance when the agent records a successful result; `manual` stages
// wait for the user to review and advance. Mirrors COMPLETION_GUIDANCE in
// prompt-builder.ts — keep the texts in sync.
const COMPLETION_AUTO: &str = "This stage's transition is `auto`: when this stage's goal is achieved, record completion so Kanna can advance the pipeline: call MCP `kanna_complete_stage {\"task_id\": \"$KANNA_TASK_ID\", \"status\": \"success\", \"summary\": \"...\"}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently.";
const COMPLETION_MANUAL: &str = "This stage's transition is `manual`: recording a successful result does not advance the pipeline — the user reviews your work and advances the stage themselves. When this stage's goal is achieved, finish with a clear summary of what you did; record completion only if this stage's prompt asks for it. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently: call MCP `kanna_complete_stage {\"task_id\": \"$KANNA_TASK_ID\", \"status\": \"failure\", \"summary\": \"...\"}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status failure --summary \"...\"`.";

pub(super) fn build_kanna_preamble(
    provider: &AgentProvider,
    task_id: &str,
    stage_name: &str,
    pipeline_name: &str,
    transition: Option<&str>,
    mcp_config_path: Option<&str>,
) -> String {
    let transition = transition.unwrap_or("manual");
    // Mirrors buildKannaTaskContextLine in prompt-builder.ts — keep in sync.
    let task_context = format!(
        "This session was launched by Kanna as task `{task_id}`, stage `{stage_name}` of pipeline `{pipeline_name}` (transition: `{transition}`)."
    );
    let completion = if transition == "auto" {
        COMPLETION_AUTO
    } else {
        COMPLETION_MANUAL
    };
    let rendered = KANNA_TASK_ENVIRONMENT_TEMPLATE
        .trim_end()
        .replace("{{TASK_CONTEXT}}", &task_context)
        .replace("{{COMPLETION}}", completion);
    match mcp_config_path {
        Some(_) => rendered.replace("{{MCP_STATUS}}", &kanna_mcp_launch_line(*provider)),
        None => rendered.replace("- {{MCP_STATUS}}\n", ""),
    }
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

fn safe_antigravity_alias_name(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value)
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
