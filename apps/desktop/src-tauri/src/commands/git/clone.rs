use git2::{Repository, Signature};
use std::process::Command;

#[tauri::command]
pub async fn git_clone(url: String, destination: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["clone", &url, &destination])
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone failed: {}", stderr.trim()));
    }

    Ok(())
}

#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    let repo = Repository::init(&path).map_err(|e| format!("git init failed: {}", e))?;

    // Create an empty initial commit so the default branch actually exists.
    // Without this, HEAD points to refs/heads/main but the ref doesn't resolve,
    // which breaks worktree creation, merge-base, and diff operations.
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Kanna", "noreply@kanna.build"))
        .map_err(|e| format!("failed to create signature: {}", e))?;
    let tree_id = repo
        .index()
        .and_then(|mut idx| idx.write_tree())
        .map_err(|e| format!("failed to write empty tree: {}", e))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("failed to find tree: {}", e))?;
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
        .map_err(|e| format!("failed to create initial commit: {}", e))?;

    Ok(())
}
