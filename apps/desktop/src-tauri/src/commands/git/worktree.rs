use super::{format_git_command_failure, read_process_cwd_for_diagnostics};
use git2::Repository;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn git_worktree_list(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let names = repo.worktrees().map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    // Include the main worktree
    let main_path = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_path.clone());
    result.push(WorktreeInfo {
        name: "(main)".to_string(),
        path: main_path,
    });

    for name_str in names.iter().flatten() {
        if let Ok(wt) = repo.find_worktree(name_str) {
            let path = wt.path().to_string_lossy().to_string();
            result.push(WorktreeInfo {
                name: name_str.to_string(),
                path,
            });
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn git_worktree_add(
    repo_path: String,
    branch: String,
    path: String,
    start_point: Option<String>,
) -> Result<String, String> {
    // Check if the branch already exists — if so, use it directly instead of -b
    let branch_exists = Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{}", branch),
        ])
        .current_dir(&repo_path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let mut args = vec!["worktree".to_string(), "add".to_string()];
    if branch_exists {
        // Branch exists: attach worktree to existing branch
        args.push(path.clone());
        args.push(branch);
    } else {
        // Branch doesn't exist: create it with -b
        args.push("-b".to_string());
        args.push(branch);
        args.push(path.clone());
        if let Some(sp) = start_point {
            args.push(sp);
        }
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        return Err(format_git_command_failure(
            "git worktree add",
            &repo_path,
            &args,
            read_process_cwd_for_diagnostics(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn git_worktree_remove(repo_path: String, path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["worktree", "remove", "--force", &path])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree remove: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
