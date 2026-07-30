//! Shared provider-session resume preconditions.
//!
//! Revision and death recovery both come through this module. A failed
//! precondition is a reason for a fresh spawn, never permission to claim that
//! a provider transcript was resumed.

use super::provider::{AgentProvider, AgentSessionType};
use super::types::ResumeWorkspaceSpec;
use serde_json::Value;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;

fn home_child(env_override: &str, child: &str) -> Option<PathBuf> {
    if let Ok(config_dir) = std::env::var(env_override) {
        if !config_dir.trim().is_empty() {
            return Some(PathBuf::from(config_dir));
        }
    }
    let home = std::env::var("HOME").ok()?;
    (!home.trim().is_empty()).then(|| PathBuf::from(home).join(child))
}

fn claude_projects_dir() -> Option<PathBuf> {
    home_child("CLAUDE_CONFIG_DIR", ".claude").map(|dir| dir.join("projects"))
}

fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_transcript_exists(cwd: &str, session_id: &str) -> bool {
    let Some(projects_dir) = claude_projects_dir() else {
        return false;
    };
    projects_dir
        .join(claude_project_slug(cwd))
        .join(format!("{session_id}.jsonl"))
        .is_file()
}

fn copilot_transcript_exists(session_id: &str) -> bool {
    let Some(config_dir) = home_child("COPILOT_CONFIG_DIR", ".copilot") else {
        return false;
    };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        config_dir.join("data.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return false;
    };
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)",
        [session_id],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

pub(super) fn same_cwd(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let (Ok(left), Ok(right)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) else {
        return false;
    };
    left == right
}

fn codex_session_metadata(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let first_line = std::io::BufReader::new(file).lines().next()?.ok()?;
    let value: Value = serde_json::from_str(&first_line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    Some((
        payload.get("id")?.as_str()?.to_string(),
        payload.get("cwd")?.as_str()?.to_string(),
    ))
}

fn codex_sessions() -> Vec<(std::time::SystemTime, String, String)> {
    let Some(config_dir) = home_child("CODEX_HOME", ".codex") else {
        return Vec::new();
    };
    let sessions_dir = config_dir.join("sessions");
    let mut pending = vec![sessions_dir];
    let mut sessions = Vec::new();
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                if let Some((id, cwd)) = codex_session_metadata(&path) {
                    sessions.push((modified, id, cwd));
                }
            }
        }
    }
    sessions
}

fn resolve_codex_session_id(cwd: &str, recorded: Option<&str>) -> Option<String> {
    let mut sessions = codex_sessions();
    sessions.sort_by(|left, right| right.0.cmp(&left.0));
    if let Some(recorded) = recorded {
        return sessions
            .iter()
            .any(|(_, id, session_cwd)| id == recorded && same_cwd(session_cwd, cwd))
            .then(|| recorded.to_string());
    }
    sessions
        .into_iter()
        .find(|(_, _, session_cwd)| same_cwd(session_cwd, cwd))
        .map(|(_, id, _)| id)
}

fn opencode_database_path() -> Option<PathBuf> {
    if let Ok(data_home) = std::env::var("OPENCODE_DATA_HOME") {
        if !data_home.trim().is_empty() {
            return Some(PathBuf::from(data_home).join("opencode.db"));
        }
    }
    if let Ok(xdg_data_home) = std::env::var("XDG_DATA_HOME") {
        if !xdg_data_home.trim().is_empty() {
            return Some(
                PathBuf::from(xdg_data_home)
                    .join("opencode")
                    .join("opencode.db"),
            );
        }
    }
    let home = std::env::var("HOME").ok()?;
    (!home.trim().is_empty()).then(|| {
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("opencode")
            .join("opencode.db")
    })
}

#[allow(clippy::let_and_return)]
fn resolve_opencode_session_id(cwd: &str, recorded: Option<&str>) -> Option<String> {
    let path = opencode_database_path()?;
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return None;
    };
    if let Some(recorded) = recorded {
        return conn
            .query_row(
                "SELECT directory FROM session WHERE id = ?",
                [recorded],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .filter(|directory| same_cwd(directory, cwd))
            .map(|_| recorded.to_string());
    }
    let mut statement = conn
        .prepare("SELECT id, directory FROM session ORDER BY time_updated DESC")
        .ok()?;
    let sessions = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    // Keep this binding so rusqlite's borrowed row iterator is dropped before
    // its statement and connection.
    let resolved = sessions
        .filter_map(Result::ok)
        .find(|(_, directory)| same_cwd(directory, cwd))
        .map(|(id, _)| id);
    resolved
}

fn resolve_provider_session_id(
    provider: AgentProvider,
    cwd: &str,
    recorded: Option<&str>,
) -> Result<String, String> {
    match provider {
        AgentProvider::Claude => recorded
            .filter(|id| claude_transcript_exists(cwd, id))
            .map(str::to_string)
            .ok_or_else(|| "no claude CLI transcript for the previous session".to_string()),
        AgentProvider::Copilot => recorded
            .filter(|id| copilot_transcript_exists(id))
            .map(str::to_string)
            .ok_or_else(|| "no Copilot CLI transcript for the recorded session".to_string()),
        AgentProvider::Codex => resolve_codex_session_id(cwd, recorded).ok_or_else(|| {
            "no Codex CLI transcript for the recorded session or previous run cwd".to_string()
        }),
        AgentProvider::Opencode => resolve_opencode_session_id(cwd, recorded).ok_or_else(|| {
            "no OpenCode CLI transcript for the recorded session or previous run cwd".to_string()
        }),
        AgentProvider::Antigravity => Err(
            "antigravity can resume a conversation only when its CLI conversation id is known; \
             Kanna cannot assign or capture that id at PTY spawn"
                .to_string(),
        ),
    }
}

/// Validate and materialize the workspace/provider half of a resume. Callers
/// supply the message and stage policy, but revision and death recovery share
/// every safety check here.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_resume_workspace(
    provider_name: Option<&str>,
    source_agent_type: Option<&str>,
    run_cwd: Option<&str>,
    provider_session_id: Option<&str>,
    resumed_from_run_id: &str,
    current_worktree: &str,
) -> Result<(AgentProvider, ResumeWorkspaceSpec), String> {
    let provider_name =
        provider_name.ok_or_else(|| "previous run recorded no agent provider".to_string())?;
    let provider = AgentProvider::from_str(provider_name)
        .map_err(|_| format!("unsupported provider recorded on previous run: {provider_name}"))?;
    if super::provider::normalize_agent_type(source_agent_type)
        == Some(AgentSessionType::Agent.as_str())
    {
        return Err("headless agent sessions do not yet support recovery respawn".to_string());
    }
    let run_cwd = run_cwd.ok_or_else(|| "previous run recorded no cwd".to_string())?;
    let resume_head =
        rev_parse_head(run_cwd).ok_or_else(|| "previous run's worktree is gone".to_string())?;
    let current_head = rev_parse_head(current_worktree)
        .ok_or_else(|| "task's current worktree is gone".to_string())?;
    if resume_head != current_head {
        return Err("previous run's worktree diverged from the committed tip".to_string());
    }
    let branch = current_branch(run_cwd)
        .ok_or_else(|| "previous run's worktree has no checked-out branch".to_string())?;
    let provider_session_id = resolve_provider_session_id(provider, run_cwd, provider_session_id)?;
    Ok((
        provider,
        ResumeWorkspaceSpec {
            cwd: run_cwd.to_string(),
            branch,
            provider_session_id,
            resumed_from_run_id: resumed_from_run_id.to_string(),
        },
    ))
}

pub(super) fn rev_parse_head(worktree_path: &str) -> Option<String> {
    if !Path::new(worktree_path).is_dir() {
        return None;
    }
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(worktree_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!head.is_empty()).then_some(head)
}

pub(super) fn current_branch(worktree_path: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(worktree_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!branch.is_empty()).then_some(branch)
}

#[cfg(test)]
mod tests {
    use super::claude_project_slug;

    #[test]
    fn slug_replaces_every_non_alphanumeric_character() {
        assert_eq!(
            claude_project_slug("/Users/dev/.kanna/repos/kanna-7/.kanna-worktrees/task-8d177e40"),
            "-Users-dev--kanna-repos-kanna-7--kanna-worktrees-task-8d177e40"
        );
    }
}
