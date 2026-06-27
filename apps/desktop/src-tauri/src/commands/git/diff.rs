use super::diff_to_patch;
use git2::Repository;

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
            let index = repo.index().map_err(|e| e.to_string())?;
            repo.diff_tree_to_index(Some(&from_tree), Some(&index), None)
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
    use super::git_diff_branch_range;
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
}
