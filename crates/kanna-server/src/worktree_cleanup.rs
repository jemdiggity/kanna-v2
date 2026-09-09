use crate::db::Db;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

const ORPHAN_WORKTREE_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const WIP_COMMIT_MESSAGE: &str = "WIP at task close";

#[derive(Debug, Clone)]
struct TaskWorkspace {
    path: PathBuf,
}

pub(crate) fn cleanup_closed_task_worktrees(
    db: &Db,
    repo_path: &Path,
    task_id: &str,
) -> Result<(), String> {
    let Some(item) = db
        .get_pipeline_item(task_id)
        .map_err(|e| format!("db error: {e}"))?
    else {
        return Ok(());
    };
    if item.closed_at.is_none() {
        return Ok(());
    }
    if !repo_path.is_dir() {
        db.delete_worktree_rows_for_task(task_id)
            .map_err(|e| format!("db error: {e}"))?;
        return Ok(());
    }

    let workspaces = collect_task_workspaces(db, repo_path, task_id)?;
    for workspace in &workspaces {
        snapshot_and_remove_workspace(repo_path, workspace)?;
        db.delete_worktree_row_for_path(&workspace.path.to_string_lossy())
            .map_err(|e| format!("db error: {e}"))?;
    }
    db.delete_worktree_rows_for_task(task_id)
        .map_err(|e| format!("db error: {e}"))?;
    prune_repo_worktrees(repo_path)?;
    Ok(())
}

pub(crate) fn cleanup_closed_task_worktrees_by_id(db: &Db, task_id: &str) -> Result<(), String> {
    let Some(item) = db
        .get_pipeline_item(task_id)
        .map_err(|e| format!("db error: {e}"))?
    else {
        return Ok(());
    };
    let Some(repo) = db
        .get_repo(&item.repo_id)
        .map_err(|e| format!("db error: {e}"))?
    else {
        return Ok(());
    };
    cleanup_closed_task_worktrees(db, Path::new(&repo.path), task_id)
}

pub(crate) fn reconcile_leftover_worktrees(db: &Db) -> Result<(), String> {
    let repos = db
        .list_repos_for_maintenance()
        .map_err(|e| format!("db error: {e}"))?;
    for repo in repos {
        if let Err(error) = reconcile_repo_leftover_worktrees(db, &repo.id, Path::new(&repo.path)) {
            log::warn!(
                "worktree cleanup reconciliation failed for repo {}: {}",
                repo.path,
                error
            );
        }
    }
    Ok(())
}

pub(crate) fn cleanup_closed_task_worktrees_shell_command(
    db_path: &str,
    repo_path: &str,
    task_id: &str,
) -> String {
    command::cleanup_shell_command(&current_exe_for_shell(), db_path, repo_path, task_id)
}

mod command;

pub(crate) fn run_cleanup_cli(args: &[String]) -> Result<bool, String> {
    if args.first().map(|arg| arg.as_str()) != Some("worktree-cleanup") {
        return Ok(false);
    }
    let db_path = args
        .get(1)
        .ok_or_else(|| "worktree-cleanup missing db path".to_string())?;
    let task_id = args
        .get(2)
        .ok_or_else(|| "worktree-cleanup missing task id".to_string())?;
    let db = Db::open(db_path).map_err(|e| format!("db error: {e}"))?;
    let item = db
        .get_pipeline_item(task_id)
        .map_err(|e| format!("db error: {e}"))?
        .ok_or_else(|| format!("task not found: {task_id}"))?;
    let repo = db
        .get_repo(&item.repo_id)
        .map_err(|e| format!("db error: {e}"))?
        .ok_or_else(|| format!("repo not found for task: {task_id}"))?;
    cleanup_closed_task_worktrees(&db, Path::new(&repo.path), task_id)?;
    Ok(true)
}

fn reconcile_repo_leftover_worktrees(
    db: &Db,
    repo_id: &str,
    repo_path: &Path,
) -> Result<(), String> {
    let worktrees_dir = repo_path.join(".kanna-worktrees");
    if !worktrees_dir.is_dir() {
        cleanup_missing_closed_worktree_rows(db, repo_id)?;
        prune_repo_worktrees(repo_path)?;
        return Ok(());
    }

    for entry in std::fs::read_dir(&worktrees_dir).map_err(|e| {
        format!(
            "failed to read worktrees dir {}: {e}",
            worktrees_dir.display()
        )
    })? {
        let entry = entry.map_err(|e| format!("failed to read worktree entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(task_id) = resolve_task_id_from_worktree_name(db, name)? else {
            if is_old_orphan(&path)? {
                log::info!("removing old orphan worktree {}", path.display());
                remove_workspace_path(repo_path, &path)?;
            }
            continue;
        };
        let Some(item) = db
            .get_pipeline_item(&task_id)
            .map_err(|e| format!("db error: {e}"))?
        else {
            continue;
        };
        if item.closed_at.is_none() {
            continue;
        }
        if let Err(error) = cleanup_closed_task_worktrees(db, repo_path, &task_id) {
            log::warn!("failed to clean closed task worktrees for {task_id}: {error}");
        }
    }

    cleanup_missing_closed_worktree_rows(db, repo_id)?;
    prune_repo_worktrees(repo_path)?;
    Ok(())
}

fn cleanup_missing_closed_worktree_rows(db: &Db, repo_id: &str) -> Result<(), String> {
    for row in db
        .list_worktrees_for_repo(repo_id)
        .map_err(|e| format!("db error: {e}"))?
    {
        let Some(item) = db
            .get_pipeline_item(&row.pipeline_item_id)
            .map_err(|e| format!("db error: {e}"))?
        else {
            continue;
        };
        if item.closed_at.is_some() && !Path::new(&row.path).exists() {
            db.delete_worktree_row_for_path(&row.path)
                .map_err(|e| format!("db error: {e}"))?;
        }
    }
    Ok(())
}

fn collect_task_workspaces(
    db: &Db,
    repo_path: &Path,
    task_id: &str,
) -> Result<Vec<TaskWorkspace>, String> {
    let mut workspaces = BTreeMap::<PathBuf, String>::new();
    for row in db
        .list_worktrees_for_task(task_id)
        .map_err(|e| format!("db error: {e}"))?
    {
        workspaces.insert(PathBuf::from(row.path), row.branch);
    }

    let worktrees_dir = repo_path.join(".kanna-worktrees");
    if worktrees_dir.is_dir() {
        for entry in std::fs::read_dir(&worktrees_dir).map_err(|e| {
            format!(
                "failed to read worktrees dir {}: {e}",
                worktrees_dir.display()
            )
        })? {
            let entry = entry.map_err(|e| format!("failed to read worktree entry: {e}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
            else {
                continue;
            };
            if resolve_task_id_from_worktree_name(db, &name)?.as_deref() == Some(task_id) {
                workspaces.insert(path, name);
            }
        }
    }

    Ok(workspaces
        .into_keys()
        .map(|path| TaskWorkspace { path })
        .collect())
}

fn snapshot_and_remove_workspace(
    repo_path: &Path,
    workspace: &TaskWorkspace,
) -> Result<(), String> {
    if workspace.path.is_dir() && workspace_is_dirty(&workspace.path)? {
        run_git_checked(&workspace.path, &["add", "-A"])?;
        run_git_checked(&workspace.path, &["commit", "-m", WIP_COMMIT_MESSAGE])?;
        log::info!(
            "created WIP snapshot before removing worktree {}",
            workspace.path.display()
        );
    }
    remove_workspace_path(repo_path, &workspace.path)
}

fn workspace_is_dirty(workspace_path: &Path) -> Result<bool, String> {
    let output = run_git_output(workspace_path, &["status", "--porcelain"])?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn remove_workspace_path(repo_path: &Path, workspace_path: &Path) -> Result<(), String> {
    let path_arg = workspace_path.to_string_lossy().to_string();
    let removed_by_git = run_git_output(
        repo_path,
        &["worktree", "remove", "--force", "--force", &path_arg],
    )
    .map(|output| output.status.success())
    .unwrap_or(false);
    if !removed_by_git && workspace_path.exists() {
        std::fs::remove_dir_all(workspace_path).map_err(|e| {
            format!(
                "failed to remove worktree directory {}: {e}",
                workspace_path.display()
            )
        })?;
    }
    log::info!("removed closed task worktree {}", workspace_path.display());
    Ok(())
}

fn prune_repo_worktrees(repo_path: &Path) -> Result<(), String> {
    run_git_checked(repo_path, &["worktree", "prune"])
}

fn resolve_task_id_from_worktree_name(db: &Db, name: &str) -> Result<Option<String>, String> {
    for candidate in task_id_candidates_from_worktree_name(name) {
        if db
            .get_pipeline_item(&candidate)
            .map_err(|e| format!("db error: {e}"))?
            .is_some()
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn task_id_candidates_from_worktree_name(name: &str) -> Vec<String> {
    let Some(remainder) = name.strip_prefix("task-") else {
        return Vec::new();
    };
    if remainder.is_empty() {
        return Vec::new();
    }
    let mut candidates = vec![remainder.to_string()];
    if let Some((base, suffix)) = remainder.rsplit_once('-') {
        if !base.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()) {
            candidates.push(base.to_string());
        }
    }
    candidates
}

fn is_old_orphan(path: &Path) -> Result<bool, String> {
    let modified = std::fs::metadata(path)
        .map_err(|e| format!("failed to stat orphan worktree {}: {e}", path.display()))?
        .modified()
        .map_err(|e| format!("failed to read orphan mtime {}: {e}", path.display()))?;
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_else(|_| Duration::from_secs(0));
    Ok(age > ORPHAN_WORKTREE_GRACE)
}

fn run_git_checked(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = run_git_output(cwd, args)?;
    if output.status.success() {
        return Ok(());
    }
    Err(format_git_error(args, output))
}

fn run_git_output(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run git {:?} in {}: {e}", args, cwd.display()))
}

fn format_git_error(args: &[&str], output: Output) -> String {
    format!(
        "git {:?} failed with status {}\nstdout:\n{}\nstderr:\n{}",
        args,
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn current_exe_for_shell() -> String {
    std::env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "kanna-server".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn unique_label(label: &str) -> String {
        format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn init_git_repo(label: &str) -> PathBuf {
        let repo_root = std::env::temp_dir().join(format!("kanna-cleanup-{}", unique_label(label)));
        let _ = std::fs::remove_dir_all(&repo_root);
        std::fs::create_dir_all(&repo_root).unwrap();
        std::fs::write(repo_root.join("README.md"), "test repo\n").unwrap();
        run_git(&repo_root, &["init", "-b", "main"]);
        run_git(&repo_root, &["config", "user.email", "test@example.com"]);
        run_git(&repo_root, &["config", "user.name", "Test User"]);
        run_git(&repo_root, &["add", "README.md"]);
        run_git(&repo_root, &["commit", "-m", "init"]);
        repo_root
    }

    fn create_worktree(repo: &Path, branch: &str) -> PathBuf {
        let worktree = repo.join(".kanna-worktrees").join(branch);
        std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        run_git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        );
        worktree
    }

    fn git_worktree_paths(repo: &Path) -> Vec<String> {
        git_stdout(repo, &["worktree", "list", "--porcelain"])
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(|path| path.to_string())
            .collect()
    }

    fn age_path_past_orphan_grace(path: &Path) {
        let status = Command::new("touch")
            .args(["-t", "202001010000"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "touch should age {}", path.display());
    }

    fn insert_task(
        db: &Db,
        repo_id: &str,
        task_id: &str,
        branch: &str,
        worktree: &Path,
        closed: bool,
    ) {
        db.insert_test_pipeline_item(
            task_id,
            repo_id,
            "cleanup task",
            Some("cleanup task"),
            "in progress",
            "2026-07-07 00:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(task_id, branch, "default", None, "claude")
            .unwrap();
        db.upsert_worktree(
            &format!("wt-{branch}"),
            task_id,
            worktree.to_str().unwrap(),
            branch,
        )
        .unwrap();
        if closed {
            db.close_pipeline_item(task_id).unwrap();
        }
    }

    // Packaged-app E2E cannot cover this yet because close+teardown completion
    // is not deterministic under the WebDriver harness. These tests exercise
    // the real git worktree registrations, local commits, DB rows, and startup
    // reconciliation behavior that bound the worktree count.
    #[test]
    fn close_cleanup_removes_closed_task_worktrees_and_spares_open_tasks() {
        let repo = init_git_repo("closed-spares-open");
        let db_path = Db::test_db_path(&unique_label("closed-spares-open"));
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", repo.to_str().unwrap(), "Repo")
            .unwrap();

        let closed_one = create_worktree(&repo, "task-closed");
        let closed_two = create_worktree(&repo, "task-closed-2");
        let open_one = create_worktree(&repo, "task-open");
        insert_task(&db, "repo-1", "closed", "task-closed", &closed_one, true);
        db.upsert_worktree(
            "wt-task-closed-2",
            "closed",
            closed_two.to_str().unwrap(),
            "task-closed-2",
        )
        .unwrap();
        insert_task(&db, "repo-1", "open", "task-open", &open_one, false);

        cleanup_closed_task_worktrees(&db, Path::new(repo.to_str().unwrap()), "closed").unwrap();

        assert!(!closed_one.exists());
        assert!(!closed_two.exists());
        assert!(open_one.exists());
        assert_eq!(db.get_task_worktree_path("closed").unwrap(), None);
        assert!(db.get_task_worktree_path("open").unwrap().is_some());
        let registered = git_worktree_paths(&repo);
        assert!(!registered.iter().any(|path| path.ends_with("/task-closed")));
        assert!(!registered
            .iter()
            .any(|path| path.ends_with("/task-closed-2")));
        assert!(registered.iter().any(|path| path.ends_with("/task-open")));
    }

    #[test]
    fn dirty_workspace_gets_wip_commit_before_removal() {
        let repo = init_git_repo("dirty-wip");
        let db_path = Db::test_db_path(&unique_label("dirty-wip"));
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", repo.to_str().unwrap(), "Repo")
            .unwrap();

        let worktree = create_worktree(&repo, "task-dirty");
        std::fs::write(worktree.join("dirty.txt"), "dirty state\n").unwrap();
        insert_task(&db, "repo-1", "dirty", "task-dirty", &worktree, true);

        cleanup_closed_task_worktrees(&db, &repo, "dirty").unwrap();

        assert!(!worktree.exists());
        assert_eq!(
            git_stdout(&repo, &["log", "-1", "--format=%s", "task-dirty"]),
            "WIP at task close"
        );
        assert_eq!(
            git_stdout(&repo, &["show", "task-dirty:dirty.txt"]),
            "dirty state"
        );
    }

    #[test]
    fn clean_workspace_removed_without_wip_commit() {
        let repo = init_git_repo("clean-no-wip");
        let db_path = Db::test_db_path(&unique_label("clean-no-wip"));
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", repo.to_str().unwrap(), "Repo")
            .unwrap();

        let worktree = create_worktree(&repo, "task-clean");
        let before_head = git_stdout(&repo, &["rev-parse", "task-clean"]);
        insert_task(&db, "repo-1", "clean", "task-clean", &worktree, true);

        cleanup_closed_task_worktrees(&db, &repo, "clean").unwrap();

        assert!(!worktree.exists());
        assert_eq!(git_stdout(&repo, &["rev-parse", "task-clean"]), before_head);
    }

    #[test]
    fn startup_sweep_clears_closed_leftovers_spares_open_and_young_orphans_and_prunes() {
        let repo = init_git_repo("startup-sweep");
        let db_path = Db::test_db_path(&unique_label("startup-sweep"));
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", repo.to_str().unwrap(), "Repo")
            .unwrap();

        let closed = create_worktree(&repo, "task-sweep-closed");
        let open = create_worktree(&repo, "task-sweep-open");
        let young_orphan = create_worktree(&repo, "task-young-orphan");
        let old_orphan = create_worktree(&repo, "task-old-orphan");
        age_path_past_orphan_grace(&old_orphan);
        insert_task(
            &db,
            "repo-1",
            "sweep-closed",
            "task-sweep-closed",
            &closed,
            true,
        );
        insert_task(&db, "repo-1", "sweep-open", "task-sweep-open", &open, false);
        std::fs::remove_dir_all(&closed).unwrap();

        reconcile_leftover_worktrees(&db).unwrap();

        assert!(!closed.exists());
        assert!(open.exists());
        assert!(young_orphan.exists());
        assert!(!old_orphan.exists());
        assert_eq!(db.get_task_worktree_path("sweep-closed").unwrap(), None);
        assert!(db.get_task_worktree_path("sweep-open").unwrap().is_some());
        let registered = git_worktree_paths(&repo);
        assert!(!registered
            .iter()
            .any(|path| path.ends_with("/task-sweep-closed")));
    }

    #[test]
    fn task_id_parsing_prefers_exact_uuid_before_suffix_interpretation() {
        let repo = init_git_repo("legacy-uuid-parsing");
        let db_path = Db::test_db_path(&unique_label("legacy-uuid-parsing"));
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo_with_path("repo-1", repo.to_str().unwrap(), "Repo")
            .unwrap();

        let exact_id = "11111111-2222-3333-4444-555555555555";
        let base_id = "11111111-2222-3333-4444";
        let exact_branch = format!("task-{exact_id}");
        let fork_branch = format!("task-{base_id}-2");
        let exact_worktree = create_worktree(&repo, &exact_branch);
        let fork_worktree = create_worktree(&repo, &fork_branch);
        insert_task(
            &db,
            "repo-1",
            exact_id,
            &exact_branch,
            &exact_worktree,
            false,
        );
        insert_task(&db, "repo-1", base_id, &fork_branch, &fork_worktree, true);

        reconcile_leftover_worktrees(&db).unwrap();

        assert!(exact_worktree.exists());
        assert!(!fork_worktree.exists());
        assert!(db.get_task_worktree_path(exact_id).unwrap().is_some());
        assert_eq!(db.get_task_worktree_path(base_id).unwrap(), None);
    }
}
