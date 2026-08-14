use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::Command;

#[derive(Debug)]
pub(super) struct MergeConflict {
    pub(super) branch: String,
    pub(super) message: String,
}

#[derive(Debug)]
pub(super) enum MergeBranchesError {
    Conflict(MergeConflict),
    Other(String),
}

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
pub(crate) fn resolve_current_source_worktree_branch(
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

/// Whether `branch` exists as a local ref in `repo_path`.
///
/// A task's `pipeline_item.branch` is written at creation, but the branch
/// itself only comes into being when the task's first workspace is forked —
/// so a task that never started names a branch that git has never heard of.
/// Anything that hands such a name to git (a worktree start point, a merge)
/// has to check first.
pub(crate) fn local_branch_exists(repo_path: &str, branch: &str) -> bool {
    Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ])
        .current_dir(repo_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Branch/worktree name for a stage fork: the task's durable id plus a
/// workspace counter (`task-<id>-2`, `task-<id>-3`, ...). The creation
/// workspace `task-<id>` is workspace 1, so forks count from 2. Each
/// workspace is an ephemeral manifestation of the task; the visible id ties
/// it back to the durable row. Suffixes whose branch or worktree directory
/// still exists are skipped (revisions can revisit a stage).
pub(super) fn next_fork_branch(repo_path: &str, task_id: &str) -> Result<String, String> {
    for n in 2u32..10_000 {
        let candidate = format!("task-{}-{}", task_id, n);
        let branch_exists = local_branch_exists(repo_path, &candidate);
        let worktree_exists = Path::new(repo_path)
            .join(".kanna-worktrees")
            .join(&candidate)
            .exists();
        if !branch_exists && !worktree_exists {
            return Ok(candidate);
        }
    }
    Err(format!(
        "no free fork workspace suffix for task {}",
        task_id
    ))
}

pub(super) fn generate_task_id() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect())
}

/// Random UUIDv4 for a fresh agent-CLI session (`claude --session-id`
/// requires a valid UUID).
pub(super) fn generate_agent_session_uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].join(""),
        hex[4..6].join(""),
        hex[6..8].join(""),
        hex[8..10].join(""),
        hex[10..16].join(""),
    ))
}

pub(super) fn fetch_start_point(repo_path: &str, default_branch: Option<&str>) -> Option<String> {
    let branch = default_branch.unwrap_or("main");
    let fetch_success = Command::new("git")
        .args(["fetch", "--", "origin", branch])
        .current_dir(repo_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if fetch_success {
        Some(format!("origin/{}", branch))
    } else if Command::new("git")
        .args(["rev-parse", "--verify", "--end-of-options", branch])
        .current_dir(repo_path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        Some(branch.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::fetch_start_point;
    use std::path::Path;
    use std::process::Command;

    fn run_git(repo_path: Option<&Path>, args: &[&str]) {
        let mut command = Command::new("git");
        if let Some(repo_path) = repo_path {
            command.arg("-C").arg(repo_path);
        }
        let output = command.args(args).output().expect("git should launch");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn fetch_start_point_treats_option_shaped_branches_as_revisions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let remote = temp.path().join("remote.git");
        let seed = temp.path().join("seed");
        let local = temp.path().join("local");
        let remote_path = remote.to_string_lossy();

        run_git(None, &["init", "--bare", &remote_path]);
        run_git(None, &["init", seed.to_string_lossy().as_ref()]);
        run_git(
            Some(&seed),
            &[
                "-c",
                "user.name=Kanna Test",
                "-c",
                "user.email=kanna-test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "seed",
            ],
        );

        let remote_branch = "--upload-pack=kanna-missing-upload-pack";
        let remote_refspec = format!("HEAD:refs/heads/{remote_branch}");
        run_git(Some(&seed), &["push", "--", &remote_path, &remote_refspec]);

        run_git(None, &["init", local.to_string_lossy().as_ref()]);
        run_git(Some(&local), &["remote", "add", "origin", &remote_path]);
        assert_eq!(
            fetch_start_point(local.to_string_lossy().as_ref(), Some(remote_branch)),
            Some(format!("origin/{remote_branch}"))
        );

        let local_branch = "--local-option-shaped-branch";
        let local_ref = format!("refs/heads/{local_branch}");
        run_git(Some(&local), &["update-ref", &local_ref, "FETCH_HEAD"]);
        assert_eq!(
            fetch_start_point(local.to_string_lossy().as_ref(), Some(local_branch)),
            Some(local_branch.to_string())
        );
    }
}

pub(super) fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &str,
    start_point: Option<&str>,
) -> Result<(), String> {
    let branch_exists = local_branch_exists(repo_path, branch);

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

    // The main checkout is a shared resource: the desktop frontend polls git
    // status/diff against it constantly, and agents push from sibling
    // worktrees. `git worktree add` can transiently lose a race for the
    // repo's lock files, so retry briefly before giving up — a one-shot
    // failure here used to leave unblocked dependent tasks permanently
    // dormant.
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(300));
            log::warn!(
                "retrying git worktree add for {branch} after lock contention: {last_error}"
            );
        }
        let output = Command::new("git")
            .args(&args)
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("failed to run git worktree add: {}", e))?;
        if output.status.success() {
            last_error.clear();
            break;
        }
        last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !last_error.contains(".lock") {
            return Err(last_error);
        }
    }
    if !last_error.is_empty() {
        return Err(last_error);
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
) -> Result<(), MergeBranchesError> {
    for branch in branches {
        let output = Command::new("git")
            .args(["merge", "--no-edit", branch])
            .current_dir(worktree_path)
            .output()
            .map_err(|e| {
                MergeBranchesError::Other(format!("failed to run git merge {branch}: {e}"))
            })?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let details = format!("{}{}", stdout, stderr).trim().to_string();
            let message = format!("failed to merge blocker branch {branch}: {}", details);
            if details.contains("CONFLICT")
                || details.contains("Automatic merge failed")
                || details.contains("fix conflicts")
            {
                let abort_output = Command::new("git")
                    .args(["merge", "--abort"])
                    .current_dir(worktree_path)
                    .output();
                if let Ok(abort_output) = abort_output {
                    if !abort_output.status.success() {
                        log::warn!(
                            "failed to abort conflicted blocker merge for {branch}: {}",
                            String::from_utf8_lossy(&abort_output.stderr).trim()
                        );
                    }
                }
                return Err(MergeBranchesError::Conflict(MergeConflict {
                    branch: branch.clone(),
                    message,
                }));
            }
            return Err(MergeBranchesError::Other(message));
        }
    }
    Ok(())
}
