use git2::Repository;
use serde::Serialize;

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
