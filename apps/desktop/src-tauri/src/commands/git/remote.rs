use super::{discover_repo, format_git_command_failure, read_process_cwd_for_diagnostics};
use git2::Repository;
use serde::Serialize;
use std::collections::BTreeSet;
use std::process::Command;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    default_branch: String,
    has_commits: bool,
}

#[tauri::command]
pub fn git_default_branch(repo_path: String) -> Result<String, String> {
    Ok(git_repository_state(repo_path)?.default_branch)
}

#[tauri::command]
pub fn git_repository_state(repo_path: String) -> Result<GitRepositoryState, String> {
    let repo = discover_repo(&repo_path)?;
    let has_commits = repository_has_commits(&repo)?;

    Ok(GitRepositoryState {
        default_branch: resolve_default_branch(&repo, !has_commits),
        has_commits,
    })
}

fn repository_has_commits(repo: &Repository) -> Result<bool, String> {
    if repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .is_some()
    {
        return Ok(true);
    }

    let references = repo.references().map_err(|error| error.to_string())?;
    for reference in references {
        let reference = reference.map_err(|error| error.to_string())?;
        if reference.peel_to_commit().is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn resolve_default_branch(repo: &Repository, is_empty: bool) -> String {
    // Try to detect from remote HEAD reference
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(branch) = target.strip_prefix("refs/remotes/origin/") {
                return branch.to_string();
            }
        }
    }

    // Fall back: check if "main" or "master" exist locally
    for name in &["main", "master"] {
        let refname = format!("refs/heads/{}", name);
        if repo.find_reference(&refname).is_ok() {
            return name.to_string();
        }
    }

    // An unborn HEAD has no local branch reference yet. Preserve its configured
    // initial branch name so importing `git init --initial-branch=trunk` does
    // not silently rewrite the repository metadata to `main`.
    if is_empty {
        if let Ok(head) = repo.find_reference("HEAD") {
            if let Some(branch) = head
                .symbolic_target()
                .and_then(|target| target.strip_prefix("refs/heads/"))
            {
                return branch.to_string();
            }
        }
    }

    "main".to_string()
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

    // After `git push -u <remote> <branch>`, the upstream is this branch's own
    // remote copy. It carries the same commits, so a diff against it is empty —
    // keep the persisted base_ref instead.
    if upstream_is_own_remote_copy(&repo, head.name(), branch_name, &upstream_name) {
        return Ok(None);
    }

    Ok(Some(upstream_name))
}

/// Whether `upstream_name` is only `branch_name` published on a remote. The
/// comparison strips the remote name rather than the last path segment: the PR
/// stage renames task branches to names like `fix/diff-base`, whose remote copy
/// `origin/fix/diff-base` shares no single-segment suffix with the branch.
fn upstream_is_own_remote_copy(
    repo: &Repository,
    branch_ref: Option<&str>,
    branch_name: &str,
    upstream_name: &str,
) -> bool {
    if upstream_name == branch_name {
        return true;
    }
    upstream_remote_names(repo, branch_ref)
        .iter()
        .any(|remote| upstream_name == format!("{}/{}", remote, branch_name))
}

/// The branch's configured upstream remote, falling back to every configured
/// remote when the branch has no readable `branch.<name>.remote` entry.
fn upstream_remote_names(repo: &Repository, branch_ref: Option<&str>) -> Vec<String> {
    if let Some(remote) = branch_ref
        .and_then(|refname| repo.branch_upstream_remote(refname).ok())
        .and_then(|buf| buf.as_str().map(str::to_string))
    {
        return vec![remote];
    }
    repo.remotes()
        .map(|remotes| remotes.iter().flatten().map(str::to_string).collect())
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::{
        git_branch_upstream, git_current_branch, git_default_branch, git_list_base_branches,
        git_repository_state, parse_remote_base_branches, GitRepositoryState,
    };
    use crate::commands::git::test_support::{create_commit, TempRepo};
    use git2::Repository;
    use std::fs;

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
    fn git_repository_state_classifies_an_unborn_explicit_initial_branch() {
        let temp_repo = TempRepo::new("empty-trunk");
        let repo = Repository::init_opts(
            &temp_repo.path,
            git2::RepositoryInitOptions::new().initial_head("trunk"),
        )
        .expect("repo should initialize");
        drop(repo);

        let state = git_repository_state(temp_repo.path.to_string_lossy().into_owned())
            .expect("repository state should resolve");

        assert_eq!(
            state,
            GitRepositoryState {
                default_branch: "trunk".to_string(),
                has_commits: false,
            }
        );
    }

    #[test]
    fn git_repository_state_keeps_detached_head_and_remote_only_repositories_non_empty() {
        let detached_repo = TempRepo::new("detached");
        let repo = Repository::init(&detached_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &detached_repo.path);
        repo.set_head_detached(commit_id)
            .expect("HEAD should detach at the commit");

        let detached_state =
            git_repository_state(detached_repo.path.to_string_lossy().into_owned())
                .expect("detached repository state should resolve");
        assert_eq!(
            detached_state,
            GitRepositoryState {
                default_branch: "master".to_string(),
                has_commits: true,
            }
        );

        let remote_repo = TempRepo::new("remote-only");
        let repo = Repository::init(&remote_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &remote_repo.path);
        repo.reference(
            "refs/remotes/origin/release/next",
            commit_id,
            true,
            "create remote-only commit ref",
        )
        .expect("remote ref should exist");
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/release/next",
            true,
            "create symbolic remote HEAD",
        )
        .expect("remote HEAD should exist");
        repo.find_reference("refs/heads/master")
            .expect("initial local branch should exist")
            .delete()
            .expect("local branch should be removed");

        let remote_state = git_repository_state(remote_repo.path.to_string_lossy().into_owned())
            .expect("remote-only repository state should resolve");
        assert_eq!(
            remote_state,
            GitRepositoryState {
                default_branch: "release/next".to_string(),
                has_commits: true,
            }
        );
    }

    #[test]
    fn git_repository_state_rejects_non_repositories_and_missing_paths() {
        let temp_dir = TempRepo::new("not-a-repo");
        let non_repo_error = git_repository_state(temp_dir.path.to_string_lossy().into_owned())
            .expect_err("a plain directory should be rejected");
        assert!(!non_repo_error.is_empty());

        let missing = temp_dir.path.join("missing");
        let missing_error = git_repository_state(missing.to_string_lossy().into_owned())
            .expect_err("a missing path should be rejected");
        assert!(!missing_error.is_empty());
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

    /// Checks out `branch` tracking `<remote>/<remote_branch>`, so each
    /// upstream case differs only in those names.
    fn upstream_fixture(prefix: &str, branch: &str, remote: &str, remote_branch: &str) -> TempRepo {
        let temp_repo = TempRepo::new(prefix);
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        let commit_id = create_commit(&repo, &temp_repo.path);
        let commit = repo
            .find_commit(commit_id)
            .expect("commit should be readable");

        repo.branch(branch, &commit, false)
            .expect("task branch should exist");
        repo.remote(remote, "https://example.com/repo.git")
            .expect("remote should exist");
        repo.reference(
            &format!("refs/remotes/{}/{}", remote, remote_branch),
            commit_id,
            true,
            "create remote tracking ref",
        )
        .expect("remote tracking ref should exist");
        repo.find_branch(branch, git2::BranchType::Local)
            .expect("task branch should be readable")
            .set_upstream(Some(&format!("{}/{}", remote, remote_branch)))
            .expect("task branch upstream should be set");
        repo.set_head(&format!("refs/heads/{}", branch))
            .expect("HEAD should point at task branch");

        temp_repo
    }

    #[test]
    fn git_branch_upstream_returns_non_task_tracking_branch() {
        let temp_repo = upstream_fixture("upstream-base", "task-123", "origin", "release");

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, Some("origin/release".to_string()));
    }

    #[test]
    fn git_branch_upstream_ignores_task_branch_remote_copy() {
        let temp_repo = upstream_fixture("upstream-task-copy", "task-123", "origin", "task-123");

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, None);
    }

    #[test]
    fn git_branch_upstream_ignores_renamed_branch_remote_copy() {
        // The PR stage renames the task branch before pushing it, so the
        // remote copy is `origin/fix/diff-base`, not `origin/task-123`.
        let temp_repo = upstream_fixture(
            "upstream-renamed-copy",
            "fix/diff-base",
            "origin",
            "fix/diff-base",
        );

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, None);
    }

    #[test]
    fn git_branch_upstream_ignores_remote_copy_on_a_non_origin_remote() {
        let temp_repo = upstream_fixture(
            "upstream-fork-copy",
            "fix/diff-base",
            "fork",
            "fix/diff-base",
        );

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, None);
    }

    #[test]
    fn git_branch_upstream_keeps_base_branch_sharing_the_branch_name_suffix() {
        let temp_repo = upstream_fixture(
            "upstream-suffix-base",
            "task-123",
            "origin",
            "release/task-123",
        );

        let upstream = git_branch_upstream(temp_repo.path.to_string_lossy().into_owned())
            .expect("upstream lookup should succeed");

        assert_eq!(upstream, Some("origin/release/task-123".to_string()));
    }
}
