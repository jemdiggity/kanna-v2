use super::diff_to_patch;
use git2::Repository;

fn diff_options(context_lines: Option<u32>) -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    if let Some(context_lines) = context_lines {
        opts.context_lines(context_lines);
    }
    opts
}

fn workdir_diff_options(context_lines: Option<u32>) -> git2::DiffOptions {
    let mut opts = diff_options(context_lines);
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    opts
}

#[tauri::command]
pub fn git_diff(
    repo_path: String,
    mode: String,
    context_lines: Option<u32>,
) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    let diff = match mode.as_str() {
        "staged" => {
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let mut opts = diff_options(context_lines);
            repo.diff_tree_to_index(head.as_ref(), None, Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        "all" => {
            let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let mut opts = workdir_diff_options(context_lines);
            repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        _ => {
            let mut opts = workdir_diff_options(context_lines);
            repo.diff_index_to_workdir(None, Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
    };

    diff_to_patch(diff)
}

/// Whether the worktree has anything uncommitted — staged, unstaged, or
/// untracked. The diff view uses it to pick its opening scope: a task whose
/// worktree is clean has nothing to show under "working", and its reviewer
/// wants the branch diff. Untracked files count, because a file the agent
/// just created is exactly the uncommitted work the working scope exists for.
#[tauri::command]
pub fn git_worktree_is_dirty(repo_path: String) -> Result<bool, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    Ok(!statuses.is_empty())
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
    context_lines: Option<u32>,
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
            let mut opts = diff_options(context_lines);
            repo.diff_tree_to_tree(Some(&from_tree), Some(&head_tree), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        "staged" => {
            let index = repo.index().map_err(|e| e.to_string())?;
            let mut opts = diff_options(context_lines);
            repo.diff_tree_to_index(Some(&from_tree), Some(&index), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        "all" => {
            let mut opts = workdir_diff_options(context_lines);
            repo.diff_tree_to_workdir_with_index(Some(&from_tree), Some(&mut opts))
                .map_err(|e| e.to_string())?
        }
        other => return Err(format!("unsupported branch diff mode '{}'", other)),
    };

    diff_to_patch(diff)
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

#[cfg(test)]
mod tests {
    use super::{git_diff_branch_range, git_worktree_is_dirty};
    use crate::commands::git::test_support::{create_commit, TempRepo};
    use git2::{Repository, Signature};
    use std::{fs, path::Path};

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
    fn git_worktree_is_dirty_reports_a_committed_worktree_as_clean() {
        let temp_repo = TempRepo::new("worktree-clean");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        create_commit(&repo, &temp_repo.path);
        // `create_commit` builds its tree without persisting the index, which
        // a real checkout always has. Write it so the fixture matches HEAD;
        // otherwise the seed file reads as staged for deletion.
        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("README.md"))
            .expect("seed file should be indexed");
        index.write().expect("index should be written");

        assert!(
            !git_worktree_is_dirty(temp_repo.path.to_string_lossy().to_string()).unwrap(),
            "a worktree with nothing uncommitted is clean"
        );
    }

    #[test]
    fn git_worktree_is_dirty_counts_staged_unstaged_and_untracked_changes() {
        let (temp_repo, _base) = create_branch_diff_fixture("worktree-dirty");

        assert!(
            git_worktree_is_dirty(temp_repo.path.to_string_lossy().to_string()).unwrap(),
            "staged, unstaged, and untracked changes all make a worktree dirty"
        );
    }

    #[test]
    fn git_worktree_is_dirty_counts_an_untracked_file_on_its_own() {
        let temp_repo = TempRepo::new("worktree-untracked-only");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        create_commit(&repo, &temp_repo.path);
        fs::write(temp_repo.path.join("new-file.txt"), "created by an agent\n")
            .expect("untracked fixture file should be written");

        // A file the agent just created is exactly the uncommitted work the
        // working scope exists to show, so it must not read as clean.
        assert!(
            git_worktree_is_dirty(temp_repo.path.to_string_lossy().to_string()).unwrap(),
            "an untracked file alone makes a worktree dirty"
        );
    }

    #[test]
    fn git_diff_branch_range_none_excludes_index_and_worktree_changes() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-none");

        let patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "none".to_string(),
            None,
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
            None,
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
            None,
        )
        .expect("branch diff should succeed");

        assert!(patch.contains("committed branch mode marker"));
        assert!(patch.contains("staged mode marker"));
        assert!(patch.contains("unstaged mode marker"));
        assert!(patch.contains("untracked mode marker"));
    }

    #[test]
    fn git_diff_branch_range_can_include_all_unchanged_context_lines() {
        let temp_repo = TempRepo::new("branch-diff-full-context");
        let repo = Repository::init(&temp_repo.path).expect("repo should initialize");
        create_commit(&repo, &temp_repo.path);

        fs::write(
            temp_repo.path.join("context.txt"),
            "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\n",
        )
        .expect("context fixture should be written");
        let base_commit = commit_paths(&repo, &["context.txt"], "add context fixture");

        fs::write(
            temp_repo.path.join("context.txt"),
            "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nchanged 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\n",
        )
        .expect("context fixture should be updated");
        commit_paths(&repo, &["context.txt"], "change middle line");

        let compact_patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "none".to_string(),
            None,
        )
        .expect("compact branch diff should succeed");
        let full_patch = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "none".to_string(),
            Some(u32::MAX),
        )
        .expect("full-context branch diff should succeed");

        assert!(!compact_patch.contains(" line 1\n"));
        assert!(!compact_patch.contains(" line 15\n"));
        assert!(full_patch.contains(" line 1\n"));
        assert!(full_patch.contains(" line 15\n"));
    }

    #[test]
    fn git_diff_branch_range_rejects_invalid_mode() {
        let (temp_repo, base_commit) = create_branch_diff_fixture("branch-diff-invalid");

        let error = git_diff_branch_range(
            temp_repo.path.to_string_lossy().into_owned(),
            base_commit.to_string(),
            "workspace".to_string(),
            None,
        )
        .expect_err("invalid branch diff mode should fail");

        assert!(error.contains("unsupported branch diff mode 'workspace'"));
    }
}
