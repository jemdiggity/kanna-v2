use super::{discover_repo, format_git_command_failure, read_process_cwd_for_diagnostics};
use git2::Repository;
use std::collections::BTreeSet;
use std::process::Command;

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
        parse_remote_base_branches,
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
}
