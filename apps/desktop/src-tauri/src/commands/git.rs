use git2::{Repository, Signature};
use serde::Serialize;
use std::collections::BTreeSet;
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

fn discover_repo(repo_path: &str) -> Result<Repository, String> {
    Repository::discover(repo_path).map_err(|e| e.to_string())
}

fn diff_to_patch(diff: git2::Diff<'_>) -> Result<String, String> {
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

    diff_to_patch(diff)
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
    let repo = discover_repo(&repo_path)?;

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
pub fn git_current_branch(repo_path: String) -> Result<Option<String>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    if !head.is_branch() {
        return Ok(None);
    }
    Ok(head.shorthand().map(|name| name.to_string()))
}

#[tauri::command]
pub fn git_list_base_branches(repo_path: String) -> Result<Vec<String>, String> {
    let repo = discover_repo(&repo_path)?;
    let mut refs = BTreeSet::new();

    for branch_type in [git2::BranchType::Local, git2::BranchType::Remote] {
        let branches = repo
            .branches(Some(branch_type))
            .map_err(|e| e.to_string())?;

        for branch_result in branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            if branch.get().symbolic_target().is_some() {
                continue;
            }
            if let Some(name) = branch.name().map_err(|e| e.to_string())? {
                refs.insert(name.to_string());
            }
        }
    }

    Ok(refs.into_iter().collect())
}

#[tauri::command]
pub fn git_list_remote_base_branches(remote_url: String) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(["ls-remote", "--symref", &remote_url, "HEAD", "refs/heads/*"])
        .output()
        .map_err(|e| format!("Failed to run git ls-remote: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-remote failed: {}", stderr.trim()));
    }

    Ok(parse_remote_base_branches(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_remote_base_branches(output: &str) -> Vec<String> {
    let mut refs = BTreeSet::new();
    for line in output.lines() {
        let Some((_, ref_name)) = line.split_once('\t') else {
            continue;
        };
        let Some(branch) = ref_name.strip_prefix("refs/heads/") else {
            continue;
        };
        if branch.is_empty() {
            continue;
        }
        refs.insert(format!("origin/{}", branch));
    }
    refs.into_iter().collect()
}

#[tauri::command]
pub fn git_branch_upstream(repo_path: String) -> Result<Option<String>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .ok_or_else(|| "HEAD is not on a named branch".to_string())?;
    let branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .map_err(|e| e.to_string())?;
    let upstream = match branch.upstream() {
        Ok(upstream) => upstream,
        Err(_) => return Ok(None),
    };
    let upstream_name = match upstream.name().map_err(|e| e.to_string())? {
        Some(name) => name.to_string(),
        None => return Ok(None),
    };

    // After `git push -u origin <task-branch>`, the upstream is the task branch's
    // remote copy. That is not a useful diff base, so keep the persisted base_ref.
    if upstream_name == branch_name || upstream_name.rsplit('/').next() == Some(branch_name) {
        return Ok(None);
    }

    Ok(Some(upstream_name))
}

#[cfg(test)]
mod tests {
    use super::{
        format_git_command_failure, git_branch_upstream, git_current_branch, git_default_branch,
        git_diff_branch_range, git_list_base_branches, parse_remote_base_branches,
    };
    use git2::{Repository, Signature};
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kanna-git-base-branches-{}-{}-{}",
                prefix,
                std::process::id(),
                unique
            ));
            fs::create_dir_all(&path).expect("temp repo dir should be created");
            Self { path }
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn create_commit(repo: &Repository, repo_path: &Path) -> git2::Oid {
        fs::write(repo_path.join("README.md"), "test\n").expect("seed file should be written");

        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("README.md"))
            .expect("file should be added to index");
        let tree_id = index.write_tree().expect("tree should be written");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature =
            Signature::now("Kanna Tests", "tests@kanna.dev").expect("signature should build");

        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("initial commit should succeed")
    }

    fn commit_paths(repo: &Repository, paths: &[&str], message: &str) -> git2::Oid {
        let mut index = repo.index().expect("index should open");
        for path in paths {
            index
                .add_path(Path::new(path))
                .expect("path should be added to index");
        }
        index.write().expect("index should be written");
        let tree_id = index.write_tree().expect("tree should be written");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature =
            Signature::now("Kanna Tests", "tests@kanna.dev").expect("signature should build");
        let parent = repo
            .head()
            .expect("HEAD should exist")
            .peel_to_commit()
            .expect("HEAD should peel to commit");

        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )
        .expect("commit should succeed")
    }

    fn create_branch_diff_fixture(prefix: &str) -> (TempRepo, git2::Oid) {
        let temp_repo = TempRepo::new(prefix);
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let base_commit = create_commit(&repo, &temp_repo.path);

        fs::write(
            temp_repo.path.join("committed.txt"),
            "committed branch mode marker\n",
        )
        .expect("committed fixture file should be written");
        fs::write(
            temp_repo.path.join("unstaged.txt"),
            "unstaged base marker\n",
        )
        .expect("unstaged base file should be written");
        commit_paths(
            &repo,
            &["committed.txt", "unstaged.txt"],
            "branch fixture commit",
        );

        fs::write(temp_repo.path.join("staged.txt"), "staged mode marker\n")
            .expect("staged fixture file should be written");
        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("staged.txt"))
            .expect("staged file should be added");
        index.write().expect("index should be written");

        fs::write(
            temp_repo.path.join("unstaged.txt"),
            "unstaged base marker\nunstaged mode marker\n",
        )
        .expect("unstaged fixture file should be updated");
        fs::write(
            temp_repo.path.join("untracked.txt"),
            "untracked mode marker\n",
        )
        .expect("untracked fixture file should be written");

        (temp_repo, base_commit)
    }

    #[test]
    fn git_current_branch_returns_checked_out_branch_name() {
        let temp_repo = TempRepo::new("current-branch");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");
        repo.branch("feature/renamed", &commit, false)
            .expect("feature branch should exist");
        repo.set_head("refs/heads/feature/renamed")
            .expect("HEAD should point at feature branch");

        let current = git_current_branch(temp_repo.path.to_string_lossy().into_owned())
            .expect("current branch lookup should succeed");

        assert_eq!(current, Some("feature/renamed".to_string()));
    }

    #[test]
    fn git_list_base_branches_includes_remote_tracking_refs_and_skips_symbolic_head() {
        let temp_repo = TempRepo::new("refs");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");

        repo.branch("main", &commit, true)
            .expect("main branch should exist");
        repo.branch("feature/x", &commit, false)
            .expect("feature branch should exist");
        repo.reference(
            "refs/remotes/origin/main",
            commit_id,
            true,
            "create origin main tracking ref",
        )
        .expect("origin/main should exist");
        repo.reference(
            "refs/remotes/origin/release/x",
            commit_id,
            true,
            "create origin release tracking ref",
        )
        .expect("origin/release/x should exist");
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "create symbolic origin/HEAD",
        )
        .expect("origin/HEAD should exist");

        let refs = git_list_base_branches(temp_repo.path.to_string_lossy().into_owned())
            .expect("branch listing should succeed");

        assert_eq!(
            refs,
            vec![
                "feature/x".to_string(),
                "main".to_string(),
                "master".to_string(),
                "origin/main".to_string(),
                "origin/release/x".to_string(),
            ]
        );
    }

    #[test]
    fn parse_remote_base_branches_returns_origin_refs_and_skips_head() {
        let refs = parse_remote_base_branches(
            "ref: refs/heads/main\tHEAD\n\
             abc123\tHEAD\n\
             abc123\trefs/heads/main\n\
             def456\trefs/heads/release/x\n\
             fedcba\trefs/tags/v1\n",
        );

        assert_eq!(
            refs,
            vec!["origin/main".to_string(), "origin/release/x".to_string()]
        );
    }

    #[test]
    fn git_base_branch_commands_discover_repo_from_subdirectory() {
        let temp_repo = TempRepo::new("subdir-base");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");
        repo.branch("main", &commit, true)
            .expect("main branch should exist");
        repo.set_head("refs/heads/main")
            .expect("HEAD should point at main");
        repo.reference(
            "refs/remotes/origin/main",
            commit_id,
            true,
            "create origin main tracking ref",
        )
        .expect("origin/main should exist");
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "create symbolic origin/HEAD",
        )
        .expect("origin/HEAD should exist");

        let nested_path = temp_repo.path.join("apps").join("desktop");
        fs::create_dir_all(&nested_path).expect("nested path should be created");

        let default_branch = git_default_branch(nested_path.to_string_lossy().into_owned())
            .expect("default branch lookup should discover parent repo");
        let refs = git_list_base_branches(nested_path.to_string_lossy().into_owned())
            .expect("base branch lookup should discover parent repo");

        assert_eq!(default_branch, "main");
        assert!(refs.contains(&"main".to_string()));
        assert!(refs.contains(&"origin/main".to_string()));
    }

    #[test]
    fn git_branch_upstream_returns_non_task_tracking_branch() {
        let temp_repo = TempRepo::new("upstream-base");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");

        repo.branch("task-123", &commit, false)
            .expect("task branch should exist");
        repo.reference(
            "refs/remotes/origin/release",
            commit_id,
            true,
            "create origin release tracking ref",
        )
        .expect("origin/release should exist");
        repo.remote("origin", "https://example.com/repo.git")
            .expect("origin remote should exist");
        repo.find_branch("task-123", git2::BranchType::Local)
            .expect("task branch should be readable")
            .set_upstream(Some("origin/release"))
            .expect("task branch upstream should be set");
        repo.set_head("refs/heads/task-123")
            .expect("HEAD should point at task branch");

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, Some("origin/release".to_string()));
    }

    #[test]
    fn git_branch_upstream_ignores_task_branch_remote_copy() {
        let temp_repo = TempRepo::new("upstream-task-copy");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");

        repo.branch("task-123", &commit, false)
            .expect("task branch should exist");
        repo.reference(
            "refs/remotes/origin/task-123",
            commit_id,
            true,
            "create origin task tracking ref",
        )
        .expect("origin/task-123 should exist");
        repo.remote("origin", "https://example.com/repo.git")
            .expect("origin remote should exist");
        repo.find_branch("task-123", git2::BranchType::Local)
            .expect("task branch should be readable")
            .set_upstream(Some("origin/task-123"))
            .expect("task branch upstream should be set");
        repo.set_head("refs/heads/task-123")
            .expect("HEAD should point at task branch");

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, None);
    }

    #[test]
    fn git_diff_branch_range_none_excludes_index_and_worktree_changes() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-none");

        let patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "none".to_string(),
        )
        .expect("branch diff should succeed");

        assert!(patch.contains("committed branch mode marker"));
        assert!(!patch.contains("staged mode marker"));
        assert!(!patch.contains("unstaged mode marker"));
        assert!(!patch.contains("untracked mode marker"));
    }

    #[test]
    fn git_diff_branch_range_staged_includes_index_changes_only() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-staged");

        let patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "staged".to_string(),
        )
        .expect("branch diff should succeed");

        assert!(patch.contains("committed branch mode marker"));
        assert!(patch.contains("staged mode marker"));
        assert!(!patch.contains("unstaged mode marker"));
        assert!(!patch.contains("untracked mode marker"));
    }

    #[test]
    fn git_diff_branch_range_all_includes_index_and_worktree_changes() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-all");

        let patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "all".to_string(),
        )
        .expect("branch diff should succeed");

        assert!(patch.contains("committed branch mode marker"));
        assert!(patch.contains("staged mode marker"));
        assert!(patch.contains("unstaged mode marker"));
        assert!(patch.contains("untracked mode marker"));
    }

    #[test]
    fn git_diff_branch_range_rejects_invalid_mode() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-invalid");

        let error = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "workspace".to_string(),
        )
        .expect_err("invalid branch diff mode should fail");

        assert!(error.contains("unsupported branch diff mode 'workspace'"));
    }

    #[test]
    fn format_git_command_failure_includes_repo_and_process_context() {
        let args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "/repo/.kanna-worktrees/task-2".to_string(),
        ];

        let message = format_git_command_failure(
            "git worktree add",
            "/repo",
            &args,
            "/app/cwd".to_string(),
            "fatal: Unable to read current working directory: Operation not permitted".to_string(),
        );

        assert!(message.contains("git worktree add failed"));
        assert!(message.contains("repo_path=/repo"));
        assert!(message.contains("process_cwd=/app/cwd"));
        assert!(message.contains("args=worktree add /repo/.kanna-worktrees/task-2"));
        assert!(message.contains(
            "stderr=fatal: Unable to read current working directory: Operation not permitted"
        ));
    }
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

    diff_to_patch(diff)
}

#[tauri::command]
pub fn git_diff_branch_range(
    repo_path: String,
    from: String,
    mode: String,
) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let from_obj = repo
        .revparse_single(&from)
        .map_err(|e| format!("bad ref '{}': {}", from, e))?;
    let from_tree = from_obj
        .peel_to_tree()
        .map_err(|e| format!("can't peel '{}' to tree: {}", from, e))?;

    let diff = match mode.as_str() {
        "none" => {
            let head_obj = repo
                .revparse_single("HEAD")
                .map_err(|e| format!("bad ref 'HEAD': {}", e))?;
            let head_tree = head_obj
                .peel_to_tree()
                .map_err(|e| format!("can't peel 'HEAD' to tree: {}", e))?;
            repo.diff_tree_to_tree(Some(&from_tree), Some(&head_tree), None)
                .map_err(|e| e.to_string())?
        }
        "staged" => {
            let mut index = repo.index().map_err(|e| e.to_string())?;
            repo.diff_tree_to_index(Some(&from_tree), Some(&mut index), None)
                .map_err(|e| e.to_string())?
        }
        "all" => {
            let mut opts = git2::DiffOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            repo.diff_tree_to_workdir_with_index(Some(&from_tree), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        other => return Err(format!("unsupported branch diff mode '{}'", other)),
    };

    diff_to_patch(diff)
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

fn read_process_cwd_for_diagnostics() -> String {
    match std::env::current_dir() {
        Ok(path) => path.display().to_string(),
        Err(error) => format!("<unavailable: {}>", error),
    }
}

fn format_git_command_failure(
    command_label: &str,
    repo_path: &str,
    args: &[String],
    process_cwd: String,
    stderr: String,
) -> String {
    let rendered_args = args.join(" ");
    let stderr = stderr.trim();
    format!(
        "{command_label} failed: repo_path={repo_path}; process_cwd={process_cwd}; args={rendered_args}; stderr={stderr}"
    )
}

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
        return Err(format_git_command_failure(
            "git fetch",
            &repo_path,
            &args,
            read_process_cwd_for_diagnostics(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
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
        return Err(format_git_command_failure(
            "git worktree add",
            &repo_path,
            &args,
            read_process_cwd_for_diagnostics(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    // Create .cargo/config.toml so Cargo builds in the worktree's own target dir.
    let cargo_dir = std::path::Path::new(&path).join(".cargo");
    let _ = std::fs::create_dir_all(&cargo_dir);
    let _ = std::fs::write(
        cargo_dir.join("config.toml"),
        "[build]\ntarget-dir = \".build\"\n",
    );

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
