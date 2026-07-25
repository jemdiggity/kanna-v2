//! Preconditions for resuming a previous stage run's agent-CLI session.
//!
//! Every provider resumes inside the worktree that owns the recorded run.
//! Claude additionally keys CLI transcripts by working directory
//! (`<config-dir>/projects/<cwd-slug>/<session-id>.jsonl`), so a revision can
//! only resume there when the transcript still exists. Every check here fails
//! toward `false`/`None`: a failed precondition means the revision falls back
//! to the fresh-fork behavior, never an error.

use std::path::{Path, PathBuf};
use std::process::Command;

fn git_path(worktree_path: &Path, args: &[&str]) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        worktree_path.join(path)
    })
}

/// Verify that a recorded run cwd still identifies the same registered
/// worktree in the task's repository. A matching HEAD alone is insufficient:
/// another repository or worktree can be substituted at the recorded path at
/// the same commit. Every failed check returns `None`, which makes revision
/// resume fall back to a fresh fork.
pub(super) fn verified_registered_worktree_branch(
    repo_path: &str,
    task_id: &str,
    recorded_cwd: &str,
) -> Option<String> {
    let repo_path = Path::new(repo_path);
    let recorded_cwd = Path::new(recorded_cwd);
    let recorded_name = recorded_cwd.file_name()?.to_str()?;
    let recorded_parent = recorded_cwd.parent()?;
    if recorded_parent != repo_path.join(".kanna-worktrees") {
        return None;
    }

    let canonical_repo = repo_path.canonicalize().ok()?;
    let canonical_workspace_root = repo_path.join(".kanna-worktrees").canonicalize().ok()?;
    let canonical_cwd = recorded_cwd.canonicalize().ok()?;
    if canonical_cwd.parent()? != canonical_workspace_root
        || canonical_cwd.file_name()?.to_str()? != recorded_name
    {
        return None;
    }

    let repo_common_dir = git_path(&canonical_repo, &["rev-parse", "--git-common-dir"])?
        .canonicalize()
        .ok()?;
    let cwd_common_dir = git_path(&canonical_cwd, &["rev-parse", "--git-common-dir"])?
        .canonicalize()
        .ok()?;
    if cwd_common_dir != repo_common_dir {
        return None;
    }
    let cwd_top_level = git_path(&canonical_cwd, &["rev-parse", "--show-toplevel"])?
        .canonicalize()
        .ok()?;
    if cwd_top_level != canonical_cwd {
        return None;
    }
    let cwd_git_dir = git_path(&canonical_cwd, &["rev-parse", "--git-dir"])?
        .canonicalize()
        .ok()?;
    if cwd_git_dir.parent()? != repo_common_dir.join("worktrees") {
        return None;
    }

    let branch = current_branch(recorded_cwd.to_str()?)?;
    if branch != recorded_name {
        return None;
    }
    let task_branch = format!("task-{task_id}");
    let belongs_to_task = branch == task_branch
        || branch
            .strip_prefix(&format!("{task_branch}-"))
            .is_some_and(|counter| {
                !counter.is_empty()
                    && counter.chars().all(|character| character.is_ascii_digit())
                    && counter.parse::<u64>().is_ok_and(|counter| counter >= 2)
            });
    if !belongs_to_task {
        return None;
    }

    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&canonical_repo)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let expected_ref = format!("refs/heads/{branch}");
    let registered = String::from_utf8_lossy(&output.stdout)
        .split("\n\n")
        .filter(|entry| !entry.trim().is_empty())
        .any(|entry| {
            let mut path_matches = false;
            let mut branch_matches = false;
            for line in entry.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    path_matches = Path::new(path)
                        .canonicalize()
                        .is_ok_and(|path| path == canonical_cwd);
                } else if let Some(reference) = line.strip_prefix("branch ") {
                    branch_matches = reference == expected_ref;
                }
            }
            path_matches && branch_matches
        });
    registered.then_some(branch)
}

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
