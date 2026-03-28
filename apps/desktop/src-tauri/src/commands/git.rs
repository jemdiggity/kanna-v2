use git2::{Repository, Signature};
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

#[derive(Serialize)]
pub struct GraphCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

#[derive(Serialize)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub head_commit: Option<String>,
}

#[tauri::command]
pub fn git_diff(repo_path: String, mode: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let diff = match mode.as_str() {
        "staged" => {
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            repo.diff_tree_to_index(head.as_ref(), None, None)
                .map_err(|e| e.to_string())?
        }
        "all" => {
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let mut opts = git2::DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        _ => {
            let mut opts = git2::DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
    };

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
pub fn git_log(repo_path: String, base: String, head: String) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let head_obj = repo
        .revparse_single(&head)
        .map_err(|e| format!("failed to resolve head ref '{}': {}", head, e))?;
    let base_obj = repo
        .revparse_single(&base)
        .map_err(|e| format!("failed to resolve base ref '{}': {}", base, e))?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(head_obj.id()).map_err(|e| e.to_string())?;
    revwalk.hide(base_obj.id()).map_err(|e| e.to_string())?;
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
pub fn git_graph(
    repo_path: String,
    max_count: Option<usize>,
    from_ref: Option<String>,
) -> Result<GraphResult, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    // Build ref map: oid -> list of human-readable ref names
    let mut ref_map: std::collections::HashMap<git2::Oid, Vec<String>> =
        std::collections::HashMap::new();
    for reference in repo.references().map_err(|e| e.to_string())? {
        let reference = match reference {
            Ok(r) => r,
            Err(_) => continue,
        };
        let name = match reference.name() {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Resolve to the commit oid (peel through annotated tags)
        let oid = match reference.peel_to_commit() {
            Ok(c) => c.id(),
            Err(_) => continue,
        };
        let display = if let Some(rest) = name.strip_prefix("refs/heads/") {
            rest.to_string()
        } else if let Some(rest) = name.strip_prefix("refs/remotes/") {
            rest.to_string()
        } else if let Some(rest) = name.strip_prefix("refs/tags/") {
            rest.to_string()
        } else {
            continue;
        };
        ref_map.entry(oid).or_default().push(display);
    }

    // Resolve HEAD
    let head_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());

    // Walk commits
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    if let Some(ref from) = from_ref {
        let obj = repo
            .revparse_single(from)
            .map_err(|e| format!("bad ref '{}': {}", from, e))?;
        revwalk.push(obj.id()).map_err(|e| e.to_string())?;
    } else {
        revwalk
            .push_glob("refs/heads/*")
            .map_err(|e| e.to_string())?;
        let _ = revwalk.push_glob("refs/remotes/*");
    }

    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let limit = max_count.unwrap_or(usize::MAX);
    let mut commits = Vec::new();

    for oid in revwalk {
        if commits.len() >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let message = commit
            .message()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let parents = commit.parent_ids().map(|p| p.to_string()).collect();
        let refs = ref_map.remove(&oid).unwrap_or_default();

        commits.push(GraphCommit {
            hash,
            short_hash,
            message,
            author,
            timestamp,
            parents,
            refs,
        });
    }

    Ok(GraphResult {
        commits,
        head_commit,
    })
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

    let from_obj = repo
        .revparse_single(&from)
        .map_err(|e| format!("bad ref '{}': {}", from, e))?;
    let to_obj = repo
        .revparse_single(&to)
        .map_err(|e| format!("bad ref '{}': {}", to, e))?;

    let from_tree = from_obj
        .peel_to_tree()
        .map_err(|e| format!("can't peel '{}' to tree: {}", from, e))?;
    let to_tree = to_obj
        .peel_to_tree()
        .map_err(|e| format!("can't peel '{}' to tree: {}", to, e))?;

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

#[derive(Serialize)]
pub struct AppGitInfo {
    pub branch: String,
    pub commit_hash: String,
    pub version: String,
}

#[tauri::command]
pub fn git_app_info() -> Result<AppGitInfo, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let repo = Repository::discover(&cwd).map_err(|e| e.to_string())?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.shorthand().unwrap_or("unknown").to_string();
    let oid = head.target().ok_or("HEAD has no target".to_string())?;
    let hash = &oid.to_string()[..7];

    // Read version from VERSION file at repo workdir root
    let version = repo
        .workdir()
        .and_then(|d| std::fs::read_to_string(d.join("VERSION")).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    Ok(AppGitInfo {
        branch,
        commit_hash: hash.to_string(),
        version,
    })
}

#[tauri::command]
pub fn git_merge_base(repo_path: String, ref_a: String, ref_b: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let oid_a = repo
        .revparse_single(&ref_a)
        .map_err(|e| format!("bad ref '{}': {}", ref_a, e))?
        .id();
    let oid_b = repo
        .revparse_single(&ref_b)
        .map_err(|e| format!("bad ref '{}': {}", ref_b, e))?
        .id();

    let merge_base = repo
        .merge_base(oid_a, oid_b)
        .map_err(|e| format!("no merge base between '{}' and '{}': {}", ref_a, ref_b, e))?;

    Ok(merge_base.to_string())
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
pub fn git_fetch(repo_path: String, branch: Option<String>) -> Result<(), String> {
    let mut args = vec!["fetch".to_string(), "origin".to_string()];
    if let Some(b) = branch {
        args.push(b);
    }
    let output = Command::new("git")
        .args(&args)
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("failed to run git fetch: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
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
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Create .cargo/config.toml so Cargo builds in the worktree's own target dir.
    let cargo_dir = std::path::Path::new(&path).join(".cargo");
    let _ = std::fs::create_dir_all(&cargo_dir);
    let _ = std::fs::write(
        cargo_dir.join("config.toml"),
        "[build]\ntarget-dir = \".build\"\n",
    );

    // APFS-clone the main repo's Rust build cache into the worktree so the first
    // build is incremental (~seconds) instead of a full recompile (~minutes).
    // `cp -c` uses copy-on-write clonefile(2) — nearly instant and space-efficient.
    let main_build = std::path::Path::new(&repo_path).join(".build");
    if main_build.is_dir() {
        let wt_build = std::path::Path::new(&path).join(".build");
        let _ = Command::new("cp")
            .args(["-c", "-R"])
            .arg(&main_build)
            .arg(&wt_build)
            .output();
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

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
