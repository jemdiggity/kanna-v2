use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::Command;

pub(super) fn remove_prepared_worktree(worktree_path: &str, branch: &str) -> Result<(), String> {
    let worktree = Path::new(worktree_path);
    let repo_path = worktree
        .parent()
        .and_then(|parent| {
            if parent.file_name().and_then(|name| name.to_str()) == Some(".kanna-worktrees") {
                parent.parent()
            } else {
                None
            }
        })
        .ok_or_else(|| format!("cannot derive repo path from worktree path: {worktree_path}"))?;

    let remove_output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree remove: {}", e))?;
    if !remove_output.status.success() {
        let fallback_result = std::fs::remove_dir_all(worktree_path);
        if let Err(err) = fallback_result {
            return Err(format!(
                "failed to remove worktree: {}; fallback remove_dir_all failed: {}",
                String::from_utf8_lossy(&remove_output.stderr).trim(),
                err
            ));
        }
    }

    let delete_output = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git branch delete: {}", e))?;
    if !delete_output.status.success() {
        let message = String::from_utf8_lossy(&delete_output.stderr);
        if !message.contains("not found") && !message.contains("not a branch") {
            return Err(format!("failed to delete task branch: {}", message.trim()));
        }
    }

    Ok(())
}
pub(super) fn resolve_current_source_worktree_branch(
    repo_path: &str,
    stored_branch: Option<&str>,
) -> Option<String> {
    let stored_branch = stored_branch?;
    let worktree_path = Path::new(repo_path)
        .join(".kanna-worktrees")
        .join(stored_branch);
    let output = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(&worktree_path)
        .output();

    let Ok(output) = output else {
        return Some(stored_branch.to_string());
    };
    if !output.status.success() {
        return Some(stored_branch.to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        Some(stored_branch.to_string())
    } else {
        Some(branch)
    }
}

pub(super) fn generate_task_id() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect())
}

pub(super) fn fetch_start_point(repo_path: &str, default_branch: Option<&str>) -> Option<String> {
    let branch = default_branch.unwrap_or("main");
    let status = Command::new("git")
        .args(["fetch", "origin", branch])
        .current_dir(repo_path)
        .status()
        .ok()?;
    if status.success() {
        Some(format!("origin/{}", branch))
    } else {
        None
    }
}

pub(super) fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &str,
    start_point: Option<&str>,
) -> Result<(), String> {
    let branch_exists = Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ])
        .current_dir(repo_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    let mut args = vec!["worktree", "add"];
    if branch_exists {
        args.push(worktree_path);
        args.push(branch);
    } else {
        args.push("-b");
        args.push(branch);
        args.push(worktree_path);
        if let Some(start_point) = start_point {
            args.push(start_point);
        }
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree add: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    // Worktrees contain exactly what the branch checkout contains. Repo-
    // specific scaffolding (like a Rust `.cargo/config.toml`) must come from
    // the repo itself — committed, or created by `.kanna/config.json` setup
    // commands. Kanna used to inject a `.cargo/config.toml` here for its own
    // build layout; the stray untracked file made every commit post in other
    // repos report a dirty worktree.
    Ok(())
}

pub(super) fn merge_branches_into_worktree(
    worktree_path: &str,
    branches: &[String],
) -> Result<(), String> {
    for branch in branches {
        let output = Command::new("git")
            .args(["merge", "--no-edit", branch])
            .current_dir(worktree_path)
            .output()
            .map_err(|e| format!("failed to run git merge {branch}: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "failed to merge blocker branch {branch}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}
