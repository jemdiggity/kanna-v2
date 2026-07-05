//! Preconditions for resuming a previous stage run's agent-CLI session.
//!
//! Claude CLI transcripts are keyed by working directory
//! (`<config-dir>/projects/<cwd-slug>/<session-id>.jsonl`), so a revision can
//! only resume a session inside the worktree the run originally executed in,
//! and only while that worktree still holds exactly the task's committed tip.
//! Every check here fails toward `false`/`None`: a failed precondition means
//! the revision falls back to today's fresh-fork behavior, never an error.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Root of the Claude CLI's per-project session store. Honors
/// `CLAUDE_CONFIG_DIR` the same way the CLI does, defaulting to `~/.claude`.
fn claude_projects_dir() -> Option<PathBuf> {
    if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !config_dir.trim().is_empty() {
            return Some(PathBuf::from(config_dir).join("projects"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    if home.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// The CLI's project-directory slug: every non-alphanumeric character of the
/// absolute working directory becomes `-`.
fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Whether the Claude CLI has a resumable transcript for `session_id`
/// recorded under `cwd`. This mirrors the CLI's storage layout; if that
/// layout ever changes the check fails closed and revisions simply stop
/// resuming (fresh-fork fallback) rather than spawning a `--resume` that
/// errors at startup.
pub(super) fn claude_transcript_exists(cwd: &str, session_id: &str) -> bool {
    let Some(projects_dir) = claude_projects_dir() else {
        return false;
    };
    projects_dir
        .join(claude_project_slug(cwd))
        .join(format!("{session_id}.jsonl"))
        .is_file()
}

/// Commit hash checked out in a worktree, or `None` when the path is not a
/// usable git worktree.
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
    if head.is_empty() {
        None
    } else {
        Some(head)
    }
}

/// Branch checked out in a worktree, or `None` when detached or not a git
/// worktree.
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
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
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
