use super::local_config::LocalConfigOverride;
use super::provider::AgentProvider;
use crate::mobile_api::TransferImportSummary;
use kanna_agent_protocol::mcp::{
    codex_mcp_config_overrides, opencode_config_content, read_kanna_mcp_server,
};
use kanna_agent_protocol::{prompt_with_system_prompt, EffortOverride};
use std::path::Path;

/// How a PTY spawn binds to the provider CLI's durable conversation store.
pub(super) enum ProviderSessionBinding {
    Assign(String),
    Resume(String),
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_agent_command(
    provider: &AgentProvider,
    executable: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    permission_mode: Option<&str>,
    allowed_tools: &[String],
    disallowed_tools: &[String],
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    kanna_preamble: Option<&str>,
    mcp_config_path: Option<&str>,
    worktree_path: Option<&str>,
    provider_session: Option<&ProviderSessionBinding>,
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
    let executable = format!("'{}'", shell_single_quote(executable));
    match provider {
        AgentProvider::Claude => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("--model '{}'", shell_single_quote(model)));
            }
            extend_effort_flags(*provider, &mut flags, effort);
            if !allowed_tools.is_empty() {
                flags.push(format!("--allowedTools {}", allowed_tools.join(",")));
            }
            if !disallowed_tools.is_empty() {
                flags.push(format!("--disallowedTools {}", disallowed_tools.join(",")));
            }
            if let Some(max_turns) = max_turns {
                flags.push(format!("--max-turns {}", max_turns));
            }
            if let Some(max_budget_usd) = max_budget_usd {
                flags.push(format!("--max-budget-usd {}", max_budget_usd));
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
            match provider_session {
                Some(ProviderSessionBinding::Assign(session_id)) => {
                    flags.push(format!("--session-id '{}'", shell_single_quote(session_id)));
                }
                Some(ProviderSessionBinding::Resume(session_id)) => {
                    flags.push(format!("--resume '{}'", shell_single_quote(session_id)));
                }
                None => {}
            }
            // `--` terminates option parsing. Without it, variadic flags eat
            // the positional prompt: `--mcp-config <path> '<prompt>'` makes
            // the CLI treat the prompt as a second MCP config file and exit
            // with "MCP config file not found: <prompt>".
            format!("{executable} {} -- '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Copilot => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            match provider_session {
                Some(ProviderSessionBinding::Assign(session_id)) => {
                    flags.push(format!("--session-id='{}'", shell_single_quote(session_id)));
                }
                Some(ProviderSessionBinding::Resume(session_id)) => {
                    flags.push(format!("--resume='{}'", shell_single_quote(session_id)));
                }
                None => {}
            }
            if let Some(mcp_config_path) = mcp_config_path {
                flags.push(format!(
                    "--additional-mcp-config @'{}'",
                    shell_single_quote(mcp_config_path)
                ));
            }
            if let Some(model) = model {
                flags.push(format!("--model='{}'", shell_single_quote(model)));
            }
            extend_effort_flags(*provider, &mut flags, effort);
            if !allowed_tools.is_empty() {
                for tool in allowed_tools {
                    flags.push(format!("--allow-tool={}", tool));
                }
            }
            if !disallowed_tools.is_empty() {
                for tool in disallowed_tools {
                    flags.push(format!("--deny-tool={}", tool));
                }
            }
            format!("{executable} {} -i '{}'", flags.join(" "), escaped_prompt)
        }
        AgentProvider::Codex => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            extend_codex_mcp_flags(&mut flags, mcp_config_path);
            if let Some(model) = model {
                flags.push(format!("-m '{}'", shell_single_quote(model)));
            }
            extend_effort_flags(*provider, &mut flags, effort);
            match provider_session {
                Some(ProviderSessionBinding::Resume(session_id)) => format!(
                    "{executable} {} resume '{}' '{}'",
                    flags.join(" "),
                    shell_single_quote(session_id),
                    escaped_prompt
                ),
                _ => format!("{executable} {} '{}'", flags.join(" "), escaped_prompt),
            }
        }
        AgentProvider::Opencode => {
            // `opencode run` is a one-shot: it streams plain text, draws no TUI,
            // and the process exits at the end of its first turn. A PTY task
            // spawned that way has no composer, so `send-input`, stage posts,
            // revision resume and the transfer wrap-up have nothing to type
            // into — injected bytes are echoed by the tty and never become a
            // turn. The CLI's *default* command is what opens the interactive
            // TUI, and `--prompt` delivers the opening prompt as a real turn on
            // it. No `[project]` positional is passed: the bootstrap shell
            // already runs in the worktree, and a stray positional is how an
            // unrecognised flag's value silently becomes the project path.
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            if let Some(model) = model {
                flags.push(format!("-m '{}'", shell_single_quote(model)));
            }
            let session_flag = match provider_session {
                Some(ProviderSessionBinding::Resume(session_id)) => {
                    Some(format!("--session '{}'", shell_single_quote(session_id)))
                }
                _ => None,
            };
            // Effort rides in the config rather than on the argv: the TUI
            // entrypoint rejects `--variant` and exits before drawing anything.
            let env_prefix = opencode_config_env_prefix(mcp_config_path, model, effort);
            let command = |argv: Vec<String>| match &env_prefix {
                Some(prefix) => format!("{prefix} {}", argv.join(" ")),
                None => argv.join(" "),
            };

            let mut tui = vec![executable.clone()];
            tui.extend(flags.iter().cloned());
            tui.extend(session_flag.iter().cloned());

            match (&session_flag, prompt.is_empty()) {
                // A fresh conversation: the TUI's own `--prompt` opens it as a
                // real turn, in one process.
                (None, false) => {
                    tui.push(format!("--prompt '{}'", escaped_prompt));
                    command(tui)
                }
                // A resumed conversation: the TUI accepts `--prompt` and then
                // silently discards it whenever it is also resuming a session
                // (measured on 1.18.15, both flag orders, and with `--continue`
                // and `--fork` in place of `--session`). So the turn is
                // delivered first by a headless `run` against that same session
                // id, and the TUI then attaches to the conversation it just
                // extended. `;` rather than `&&`: if the seeding turn fails, the
                // operator should still get a live composer to recover in.
                (Some(session), false) => {
                    let mut seed = vec![executable.clone(), "run".to_string()];
                    seed.extend(flags);
                    seed.push(session.clone());
                    seed.push(format!("'{}'", escaped_prompt));
                    format!("{}; {}", command(seed), command(tui))
                }
                (_, true) => command(tui),
            }
        }
        AgentProvider::Antigravity => {
            let mut flags = get_agent_permission_flags(*provider, permission_mode);
            debug_assert!(
                model.is_none(),
                "antigravity model override was not rejected"
            );
            extend_effort_flags(*provider, &mut flags, effort);
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
            let mut parts = vec![executable.clone()];
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

fn extend_effort_flags(provider: AgentProvider, flags: &mut Vec<String>, effort: Option<&str>) {
    let Some(effort) = effort else {
        return;
    };
    match provider.effort_override() {
        EffortOverride::Flag(flag) => {
            flags.push(format!("{flag} '{}'", shell_single_quote(effort)));
        }
        EffortOverride::Config(key) => {
            flags.push(format!(
                "-c '{}=\"{}\"'",
                shell_single_quote(key),
                shell_single_quote(effort)
            ));
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

/// Everything Kanna configures on an OpenCode spawn — MCP registration and the
/// reasoning-effort variant — travels in this one env var, so it is composed
/// once here rather than by two writers overwriting each other.
fn opencode_config_env_prefix(
    mcp_config_path: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Option<String> {
    let server = mcp_config_path.and_then(read_kanna_mcp_server);
    let content = opencode_config_content(server.as_ref(), model, effort)?;
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
            // `--full-auto` was REMOVED from the interactive `codex` CLI: the
            // TUI rejects it outright ("unexpected argument '--full-auto'"),
            // so an `acceptEdits` codex task used to die on its usage error
            // before the agent ever started. `codex exec` keeps a deprecation
            // trap for it whose own advice is the replacement below. Pinned by
            // `tests/cli-contract/tests/live/codex-flags.test.ts`.
            Some(_) => vec!["--sandbox workspace-write".to_string()],
        },
        // `--auto` is what `opencode --help` and `opencode run --help` document
        // on 1.18.15. `--dangerously-skip-permissions` still works — it is
        // tolerated rather than removed — but it is undocumented on both
        // entrypoints, and an undocumented flag is the one that disappears
        // without notice. Verified equivalent on a live TUI: with either flag
        // the permission dialog is suppressed and the tool call runs; with
        // neither, the dialog blocks.
        AgentProvider::Opencode => match normalized {
            None | Some("dontAsk") => vec!["--auto".to_string()],
            Some(_) => Vec::new(),
        },
        AgentProvider::Antigravity => match normalized {
            None | Some("dontAsk") => vec!["--dangerously-skip-permissions".to_string()],
            Some(_) => Vec::new(),
        },
    }
}

/// Human-readable rendering of a transfer payload's repo acquisition mode.
/// Unknown modes are echoed verbatim: a wrong-but-honest label beats silence.
fn transfer_repo_mode_label(mode: &str) -> String {
    match mode {
        "reuse-local" => "reused this machine's existing clone".to_string(),
        "clone-remote" => "cloned from its remote".to_string(),
        "bundle-repo" => "restored from a transferred git bundle".to_string(),
        other => other.to_string(),
    }
}

/// One-time import notice for a task that arrived by cross-machine transfer.
/// It is printed before the agent command in the destination PTY, using the
/// same pre-agent `printf` pattern as the setup banner, because nothing else
/// tells the operator that this workspace came from another machine.
fn build_transfer_import_banner(summary: &TransferImportSummary) -> String {
    let mut lines = vec!["printf '\\033[33mImported transferred task\\033[0m\\n'".to_string()];
    let mut detail = |text: String| {
        lines.push(format!(
            "printf '\\033[2m  %s\\033[0m\\n' '{}'",
            shell_single_quote(&text)
        ));
    };
    if let Some(source_machine) = summary
        .source_machine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        detail(format!("source machine: {source_machine}"));
    }
    if let Some(repo_mode) = summary
        .repo_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        detail(format!(
            "repository: {}",
            transfer_repo_mode_label(repo_mode)
        ));
    }
    detail(format!(
        "session history: {}",
        if summary.session_restored {
            "restored"
        } else {
            "not restored"
        }
    ));
    lines.push("printf '\\n'".to_string());
    lines.join(" && ")
}

/// Notice that this machine's `.kanna/config.local.json` changed the config the
/// spawn ran with. Printed for every spawn the local layer touched, not only
/// the first: "works on my machine" drift is only diagnosable if the terminal
/// the operator is looking at says which file is in force.
fn build_local_config_override_banner(local_config_override: &LocalConfigOverride) -> String {
    let mut lines =
        vec!["printf '\\033[33mMachine-local repo config in effect\\033[0m\\n'".to_string()];
    let mut detail = |text: String| {
        lines.push(format!(
            "printf '\\033[2m  %s\\033[0m\\n' '{}'",
            shell_single_quote(&text)
        ));
    };
    detail(local_config_override.path().to_string());
    detail(format!(
        "overrides: {}",
        local_config_override.keys().join(", ")
    ));
    lines.push("printf '\\n'".to_string());
    lines.join(" && ")
}

pub(super) fn build_task_shell_command(
    agent_cmd: &str,
    setup_cmds: &[String],
    transfer_import: Option<&TransferImportSummary>,
    local_config_override: Option<&LocalConfigOverride>,
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

    // The import notice comes before setup: it explains where the workspace
    // the setup commands are about to run in came from.
    if let Some(transfer_import) = transfer_import {
        command_parts.push(build_transfer_import_banner(transfer_import));
    }

    // Likewise before setup: the setup commands themselves are one of the
    // things the local layer can have replaced.
    if let Some(local_config_override) = local_config_override {
        command_parts.push(build_local_config_override_banner(local_config_override));
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
            // zsh may cache a provider found later on PATH before setup
            // installs a workspace-local executable. Refresh its command
            // table so the just-provisioned binary wins.
            "printf '\\033[33mRunning startup...\\033[0m\\n' && {} && rehash && printf '\\n'",
            setup_parts
        ));
    }

    command_parts.push(agent_cmd.to_string());
    command_parts.join(" && ")
}

pub(super) fn build_teardown_shell_command(teardown_cmds: &[String]) -> String {
    if teardown_cmds.is_empty() {
        return "true".to_string();
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
        "printf '\\033[33mRunning teardown...\\033[0m\\n' ; {} ; printf '\\n'",
        teardown_parts
    )
}

/// Canonical Kanna runtime guidance shared with the desktop frontend.
/// `packages/core/src/workflow/prompt-builder.ts` mirrors this file as a TS
/// constant; a sync test there keeps both sides byte-identical.
const KANNA_TASK_ENVIRONMENT_TEMPLATE: &str =
    include_str!("../../../../packages/core/src/workflow/kanna-task-environment.md");

// Completion guidance depends on the stage's transition policy: only `auto`
// stages advance when the agent records a successful result; `manual` stages
// wait for the user to review and advance. Mirrors COMPLETION_GUIDANCE in
// prompt-builder.ts — keep the texts in sync.
const COMPLETION_AUTO: &str = "This stage's transition is `auto`: when this stage's goal is achieved, record completion so Kanna can advance the workflow: call MCP `kanna_complete_stage {\"task_id\": \"$KANNA_TASK_ID\", \"status\": \"success\", \"summary\": \"...\"}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently.";
const COMPLETION_MANUAL: &str = "This stage's transition is `manual`: recording a successful result does not advance the workflow — the user reviews your work and advances the stage themselves. When this stage's goal is achieved, finish with a clear summary of what you did; record completion only if this stage's prompt asks for it. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently: call MCP `kanna_complete_stage {\"task_id\": \"$KANNA_TASK_ID\", \"status\": \"failure\", \"summary\": \"...\"}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status failure --summary \"...\"`.";

pub(super) fn build_kanna_preamble(
    provider: &AgentProvider,
    task_id: &str,
    stage_name: &str,
    workflow_name: &str,
    transition: Option<&str>,
    stage_trigger: &str,
    mcp_config_path: Option<&str>,
) -> String {
    let transition = transition.unwrap_or("manual");
    // Mirrors buildKannaTaskContextLine in prompt-builder.ts — keep in sync.
    let task_context = format!(
        "This session was launched by Kanna as task `{task_id}`, stage `{stage_name}` of workflow `{workflow_name}` (transition: `{transition}`)."
    );
    let completion = if transition == "auto" {
        COMPLETION_AUTO
    } else {
        COMPLETION_MANUAL
    };
    let rendered = KANNA_TASK_ENVIRONMENT_TEMPLATE
        .trim_end()
        .replace("{{TASK_CONTEXT}}", &task_context)
        .replace("{{STAGE_TRIGGER}}", stage_trigger)
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
