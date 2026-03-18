use git2::Repository;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
}

#[tauri::command]
pub fn git_diff(repo_path: String, staged: bool) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let diff = if staged {
        // Staged diff: HEAD tree vs index
        let head = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), None, None)
            .map_err(|e| e.to_string())?
    } else {
        // Unstaged diff: index vs working directory, including untracked files
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.to_string())?
    };

    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // Include all line types for proper unified diff format:
        // 'F' = file header, 'H' = hunk header, '+'/'-'/' ' = content
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => output.push(origin as u8),
            _ => {} // File/hunk headers don't need origin prefix
        }
        output.extend_from_slice(line.content());
        true
    })
    .map_err(|e| e.to_string())?;

    String::from_utf8(output).map_err(|e| e.to_string())
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

    for name_opt in names.iter() {
        if let Some(name_str) = name_opt {
            if let Ok(wt) = repo.find_worktree(name_str) {
                let path = wt.path().to_string_lossy().to_string();
                result.push(WorktreeInfo {
                    name: name_str.to_string(),
                    path,
                });
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn git_log(
    repo_path: String,
    base: String,
    head: String,
) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let head_obj = repo
        .revparse_single(&head)
        .map_err(|e| format!("failed to resolve head ref '{}': {}", head, e))?;
    let base_obj = repo
        .revparse_single(&base)
        .map_err(|e| format!("failed to resolve base ref '{}': {}", base, e))?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk
        .push(head_obj.id())
        .map_err(|e| e.to_string())?;
    revwalk
        .hide(base_obj.id())
        .map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut commits = Vec::new();
    for oid in revwalk {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let message = commit.message().unwrap_or("").trim().to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        commits.push(CommitInfo {
            hash: format!("{}", oid),
            message,
            author,
        });
    }

    Ok(commits)
}

#[tauri::command]
pub fn git_default_branch(repo_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    // Try to detect from remote HEAD reference
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            // e.g. "refs/remotes/origin/main" -> "main"
            let branch = target.rsplit('/').next().unwrap_or("main").to_string();
            return Ok(branch);
        }
    }

    // Fall back: check if "main" or "master" exist locally
    for name in &["main", "master"] {
        let refname = format!("refs/heads/{}", name);
        if repo.find_reference(&refname).is_ok() {
            return Ok(name.to_string());
        }
    }

    Ok("main".to_string())
}

#[tauri::command]
pub fn git_remote_url(repo_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| format!("no remote 'origin': {}", e))?;
    let url = remote
        .url()
        .ok_or_else(|| "remote URL is not valid UTF-8".to_string())?
        .to_string();
    Ok(url)
}

#[tauri::command]
pub fn git_diff_range(repo_path: String, from: String, to: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let from_obj = repo.revparse_single(&from).map_err(|e| format!("bad ref '{}': {}", from, e))?;
    let to_obj = repo.revparse_single(&to).map_err(|e| format!("bad ref '{}': {}", to, e))?;

    let from_tree = from_obj.peel_to_tree().map_err(|e| format!("can't peel '{}' to tree: {}", from, e))?;
    let to_tree = to_obj.peel_to_tree().map_err(|e| format!("can't peel '{}' to tree: {}", to, e))?;

    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
        .map_err(|e| e.to_string())?;

    let mut output = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        match origin {
            '+' | '-' | ' ' => output.push(origin as u8),
            _ => {}
        }
        output.extend_from_slice(line.content());
        true
    })
    .map_err(|e| e.to_string())?;

    String::from_utf8(output).map_err(|e| e.to_string())
}

// --- CLI-based commands (use system git for auth) ---

#[tauri::command]
pub fn git_push(repo_path: String, branch: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("failed to run git push: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_worktree_add(
    repo_path: String,
    branch: String,
    path: String,
) -> Result<String, String> {
    let output = Command::new("git")
        .args(["worktree", "add", "-b", &branch, &path])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("failed to run git worktree add: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
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
