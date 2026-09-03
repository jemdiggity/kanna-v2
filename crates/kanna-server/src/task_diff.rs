use crate::db::Db;
use std::fmt;
use std::path::Path;
use std::process::Command;

pub const MAX_TASK_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub task_id: String,
    pub base_ref: Option<String>,
    pub merge_base: Option<String>,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskDiffError {
    InvalidRequest(String),
    TaskNotFound,
    WorkspaceUnavailable,
    Internal(String),
}

impl fmt::Display for TaskDiffError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) | Self::Internal(message) => formatter.write_str(message),
            Self::TaskNotFound => formatter.write_str("task not found"),
            Self::WorkspaceUnavailable => formatter.write_str("task workspace unavailable"),
        }
    }
}

impl std::error::Error for TaskDiffError {}

/// How far a branch-scope diff reaches past the merge-base, mirroring the
/// desktop diff view: `Committed` stops at HEAD, `Staged` adds the index,
/// `All` adds the working tree and untracked files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchDiffMode {
    Committed,
    Staged,
    All,
}

/// Which uncommitted changes a working-scope diff shows, mirroring the
/// desktop diff view: `All` is worktree+index vs HEAD, `Unstaged` is
/// worktree vs index, `Staged` is index vs HEAD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkingDiffMode {
    All,
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDiffRequest {
    Branch(BranchDiffMode),
    Working(WorkingDiffMode),
}

impl Default for TaskDiffRequest {
    fn default() -> Self {
        Self::Branch(BranchDiffMode::All)
    }
}

impl TaskDiffRequest {
    pub fn parse(scope: Option<&str>, mode: Option<&str>) -> Result<Self, TaskDiffError> {
        let scope = scope.map(str::trim).filter(|value| !value.is_empty());
        let mode = mode.map(str::trim).filter(|value| !value.is_empty());
        match scope.unwrap_or("branch") {
            "branch" => match mode.unwrap_or("all") {
                "none" => Ok(Self::Branch(BranchDiffMode::Committed)),
                "staged" => Ok(Self::Branch(BranchDiffMode::Staged)),
                "all" => Ok(Self::Branch(BranchDiffMode::All)),
                other => Err(TaskDiffError::InvalidRequest(format!(
                    "unsupported branch diff mode '{other}' (expected none, staged, or all)"
                ))),
            },
            "working" => match mode.unwrap_or("all") {
                "all" => Ok(Self::Working(WorkingDiffMode::All)),
                "unstaged" => Ok(Self::Working(WorkingDiffMode::Unstaged)),
                "staged" => Ok(Self::Working(WorkingDiffMode::Staged)),
                other => Err(TaskDiffError::InvalidRequest(format!(
                    "unsupported working diff mode '{other}' (expected all, unstaged, or staged)"
                ))),
            },
            other => Err(TaskDiffError::InvalidRequest(format!(
                "unsupported diff scope '{other}' (expected branch or working)"
            ))),
        }
    }

    fn includes_untracked(&self) -> bool {
        matches!(
            self,
            Self::Branch(BranchDiffMode::All)
                | Self::Working(WorkingDiffMode::All)
                | Self::Working(WorkingDiffMode::Unstaged)
        )
    }
}

/// Computes a task diff scoped like the desktop diff view. Branch scope
/// diffs from the merge-base with the task's base ref; when no merge-base
/// resolves it falls back to the equivalent working diff against HEAD.
pub fn read_task_diff(
    db: &Db,
    task_or_branch_id: &str,
    request: TaskDiffRequest,
) -> Result<TaskDiff, TaskDiffError> {
    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|error| TaskDiffError::Internal(format!("db error: {error}")))?
        .ok_or(TaskDiffError::TaskNotFound)?;
    let worktree_path = db
        .get_task_worktree_path(&task_id)
        .map_err(|error| TaskDiffError::Internal(format!("db error: {error}")))?
        .ok_or(TaskDiffError::WorkspaceUnavailable)?;
    let root = Path::new(&worktree_path);
    if !root.is_absolute() || !root.is_dir() {
        return Err(TaskDiffError::WorkspaceUnavailable);
    }

    let (base_ref, merge_base) = match request {
        TaskDiffRequest::Branch(_) => {
            let item = db
                .get_pipeline_item(&task_id)
                .map_err(|error| TaskDiffError::Internal(format!("db error: {error}")))?
                .ok_or(TaskDiffError::TaskNotFound)?;
            let repo = db
                .get_repo(&item.repo_id)
                .map_err(|error| TaskDiffError::Internal(format!("db error: {error}")))?;
            let base_ref = item
                .base_ref
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| repo.and_then(|repo| repo.default_branch.clone()));
            let merge_base = base_ref
                .as_deref()
                .and_then(|base_ref| crate::git_refs::resolve_base_ref(root, base_ref))
                .and_then(|resolved| resolved.merge_base);
            (base_ref, merge_base)
        }
        TaskDiffRequest::Working(_) => (None, None),
    };

    let mut patch = tracked_patch(root, request, merge_base.as_deref())?;
    let mut truncated = false;
    if request.includes_untracked() {
        for untracked in list_untracked_files(root)? {
            if patch.len() >= MAX_TASK_DIFF_BYTES {
                truncated = true;
                break;
            }
            patch.push_str(&untracked_file_patch(root, &untracked)?);
        }
    }

    if patch.len() > MAX_TASK_DIFF_BYTES {
        truncated = true;
        patch = truncate_at_line_boundary(&patch, MAX_TASK_DIFF_BYTES);
    }

    Ok(TaskDiff {
        task_id,
        base_ref,
        merge_base,
        patch,
        truncated,
    })
}

/// The tracked-file portion of the diff for each scope/mode. Branch modes
/// diff from the merge-base; without one they degrade to the matching
/// working diff so a task without a reachable base still shows its changes.
fn tracked_patch(
    root: &Path,
    request: TaskDiffRequest,
    merge_base: Option<&str>,
) -> Result<String, TaskDiffError> {
    match (request, merge_base) {
        (TaskDiffRequest::Branch(BranchDiffMode::Committed), Some(merge_base)) => {
            git_diff(root, &[merge_base, "HEAD"], false)
        }
        (TaskDiffRequest::Branch(BranchDiffMode::Staged), Some(merge_base)) => {
            git_diff(root, &["--cached", merge_base], false)
        }
        (TaskDiffRequest::Branch(BranchDiffMode::All), Some(merge_base)) => {
            git_diff(root, &[merge_base], false)
        }
        // No merge-base: committed-only has nothing meaningful to show
        // against, so every branch mode degrades to its working equivalent.
        (TaskDiffRequest::Branch(BranchDiffMode::Committed), None) => Ok(String::new()),
        (TaskDiffRequest::Branch(BranchDiffMode::Staged), None)
        | (TaskDiffRequest::Working(WorkingDiffMode::Staged), _) => {
            git_diff(root, &["--cached"], true)
        }
        (TaskDiffRequest::Branch(BranchDiffMode::All), None)
        | (TaskDiffRequest::Working(WorkingDiffMode::All), _) => git_diff(root, &["HEAD"], true),
        (TaskDiffRequest::Working(WorkingDiffMode::Unstaged), _) => git_diff(root, &[], false),
    }
}

fn run_git(root: &Path, args: &[&str]) -> Result<std::process::Output, TaskDiffError> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| TaskDiffError::Internal(format!("failed to run git: {error}")))
}

/// Runs `git diff <selector...> --`. `tolerate_failure` covers selectors
/// that reference HEAD in a repo with an unborn HEAD (fresh repo without
/// commits): there is nothing tracked to diff, so the patch is empty and
/// untracked files still get collected by the caller.
fn git_diff(
    root: &Path,
    selector: &[&str],
    tolerate_failure: bool,
) -> Result<String, TaskDiffError> {
    let mut args = vec!["diff"];
    args.extend_from_slice(selector);
    args.push("--");
    let output = run_git(root, &args)?;
    if !output.status.success() {
        if tolerate_failure {
            return Ok(String::new());
        }
        return Err(TaskDiffError::Internal(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn list_untracked_files(root: &Path) -> Result<Vec<String>, TaskDiffError> {
    let output = run_git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    if !output.status.success() {
        return Err(TaskDiffError::Internal(format!(
            "git ls-files failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect())
}

fn untracked_file_patch(root: &Path, path: &str) -> Result<String, TaskDiffError> {
    // `git diff --no-index` exits 1 when the files differ. Any other failure
    // (for example the file vanished mid-scan) skips the file instead of
    // failing the whole diff.
    let output = run_git(root, &["diff", "--no-index", "--", "/dev/null", path])?;
    match output.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => Ok(String::new()),
    }
}

fn truncate_at_line_boundary(patch: &str, limit: usize) -> String {
    let clipped = &patch.as_bytes()[..limit.min(patch.len())];
    let end = clipped
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    String::from_utf8_lossy(&patch.as_bytes()[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::path::PathBuf;

    struct TaskDiffFixture {
        db: Db,
        worktree: PathBuf,
        _temp_dir: tempfile::TempDir,
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn write_file(dir: &Path, path: &str, content: &str) {
        let full = dir.join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("create fixture file parent");
        }
        std::fs::write(full, content).expect("write fixture file");
    }

    impl TaskDiffFixture {
        fn new() -> Self {
            let temp_dir = tempfile::tempdir().expect("create task diff fixture");
            let worktree = temp_dir.path().join("worktree");
            std::fs::create_dir_all(&worktree).expect("create fixture worktree");
            git(&worktree, &["init", "-b", "main"]);
            git(&worktree, &["config", "user.email", "test@example.com"]);
            git(&worktree, &["config", "user.name", "Test"]);
            write_file(&worktree, "README.md", "hello\n");
            git(&worktree, &["add", "."]);
            git(&worktree, &["commit", "-m", "initial"]);

            let db_path = temp_dir.path().join("kanna.sqlite");
            let db = Db::open_for_tests(db_path.to_str().expect("utf-8 database path"))
                .expect("open fixture database");
            db.insert_test_repo_with_path(
                "repo-1",
                temp_dir.path().to_str().expect("utf-8 repository path"),
                "Repo One",
            )
            .expect("insert fixture repository");
            db.insert_test_pipeline_item(
                "task-1",
                "repo-1",
                "Diff task changes",
                Some("Diff task changes"),
                "in progress",
                "2026-07-21 10:00:00",
            )
            .expect("insert fixture task");
            db.upsert_worktree(
                "wt-task-1",
                "task-1",
                worktree.to_str().expect("utf-8 worktree path"),
                "branch-task-1",
            )
            .expect("insert fixture worktree");

            Self {
                db,
                worktree,
                _temp_dir: temp_dir,
            }
        }
    }

    #[test]
    fn returns_branch_diff_from_merge_base() {
        let fixture = TaskDiffFixture::new();
        git(&fixture.worktree, &["checkout", "-b", "branch-task-1"]);
        write_file(&fixture.worktree, "README.md", "hello\nchanged\n");
        git(&fixture.worktree, &["commit", "-am", "change"]);

        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert_eq!(diff.task_id, "task-1");
        assert_eq!(diff.base_ref.as_deref(), Some("main"));
        assert!(diff.merge_base.is_some());
        assert!(diff.patch.contains("+changed"));
        assert!(!diff.truncated);
    }

    #[test]
    fn includes_uncommitted_and_untracked_changes() {
        let fixture = TaskDiffFixture::new();
        git(&fixture.worktree, &["checkout", "-b", "branch-task-1"]);
        write_file(&fixture.worktree, "README.md", "hello\nuncommitted\n");
        write_file(&fixture.worktree, "new/file.txt", "brand new\n");

        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert!(diff.patch.contains("+uncommitted"));
        assert!(diff.patch.contains("new/file.txt"));
        assert!(diff.patch.contains("+brand new"));
    }

    #[test]
    fn resolves_task_by_branch_name() {
        let fixture = TaskDiffFixture::new();
        git(&fixture.worktree, &["checkout", "-b", "branch-task-1"]);
        write_file(&fixture.worktree, "README.md", "hello\nvia branch\n");

        let diff =
            read_task_diff(&fixture.db, "branch-task-1", TaskDiffRequest::default()).expect("diff");
        assert_eq!(diff.task_id, "task-1");
        assert!(diff.patch.contains("+via branch"));
    }

    #[test]
    fn prefers_task_base_ref_over_repo_default_branch() {
        let fixture = TaskDiffFixture::new();
        git(&fixture.worktree, &["checkout", "-b", "base-branch"]);
        write_file(&fixture.worktree, "base.txt", "base\n");
        git(&fixture.worktree, &["add", "."]);
        git(&fixture.worktree, &["commit", "-m", "base branch commit"]);
        git(&fixture.worktree, &["checkout", "-b", "branch-task-1"]);
        write_file(&fixture.worktree, "task.txt", "task\n");
        git(&fixture.worktree, &["add", "."]);
        git(&fixture.worktree, &["commit", "-m", "task commit"]);
        fixture
            .db
            .update_pipeline_item_base_ref_and_activity("task-1", Some("base-branch"), "idle")
            .expect("set base ref");

        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert_eq!(diff.base_ref.as_deref(), Some("base-branch"));
        assert!(diff.patch.contains("task.txt"));
        assert!(!diff.patch.contains("base.txt"));
    }

    #[test]
    fn falls_back_to_working_diff_when_base_ref_is_unresolvable() {
        let fixture = TaskDiffFixture::new();
        fixture
            .db
            .update_pipeline_item_base_ref_and_activity("task-1", Some("no-such-branch"), "idle")
            .expect("set base ref");
        write_file(&fixture.worktree, "README.md", "hello\nworking\n");

        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert_eq!(diff.base_ref.as_deref(), Some("no-such-branch"));
        assert_eq!(diff.merge_base, None);
        assert!(diff.patch.contains("+working"));
    }

    #[test]
    fn returns_empty_patch_when_workspace_is_clean() {
        let fixture = TaskDiffFixture::new();
        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert_eq!(diff.patch, "");
        assert!(!diff.truncated);
    }

    #[test]
    fn missing_task_is_not_found() {
        let fixture = TaskDiffFixture::new();
        assert_eq!(
            read_task_diff(&fixture.db, "missing", TaskDiffRequest::default()),
            Err(TaskDiffError::TaskNotFound)
        );
    }

    #[test]
    fn missing_worktree_row_is_workspace_unavailable() {
        let fixture = TaskDiffFixture::new();
        fixture
            .db
            .insert_test_pipeline_item(
                "task-2",
                "repo-1",
                "No worktree",
                Some("No worktree"),
                "in progress",
                "2026-07-21 10:00:00",
            )
            .expect("insert fixture task");

        assert_eq!(
            read_task_diff(&fixture.db, "task-2", TaskDiffRequest::default()),
            Err(TaskDiffError::WorkspaceUnavailable)
        );
    }

    #[test]
    fn removed_worktree_directory_is_workspace_unavailable() {
        let fixture = TaskDiffFixture::new();
        let gone = fixture.worktree.parent().expect("parent").join("gone");
        fixture
            .db
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                gone.to_str().expect("utf-8 path"),
                "branch-task-1",
            )
            .expect("repoint fixture worktree");

        assert_eq!(
            read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()),
            Err(TaskDiffError::WorkspaceUnavailable)
        );
    }

    #[test]
    fn truncates_oversized_patches_at_a_line_boundary() {
        let fixture = TaskDiffFixture::new();
        let big_line = "x".repeat(1024);
        let mut content = String::new();
        for _ in 0..1100 {
            content.push_str(&big_line);
            content.push('\n');
        }
        write_file(&fixture.worktree, "big.txt", &content);

        let diff = read_task_diff(&fixture.db, "task-1", TaskDiffRequest::default()).expect("diff");
        assert!(diff.truncated);
        assert!(diff.patch.len() <= MAX_TASK_DIFF_BYTES);
        assert!(diff.patch.ends_with('\n'));
    }

    #[test]
    fn parses_scopes_and_modes_with_defaults() {
        assert_eq!(
            TaskDiffRequest::parse(None, None).unwrap(),
            TaskDiffRequest::Branch(BranchDiffMode::All)
        );
        assert_eq!(
            TaskDiffRequest::parse(Some("branch"), Some("none")).unwrap(),
            TaskDiffRequest::Branch(BranchDiffMode::Committed)
        );
        assert_eq!(
            TaskDiffRequest::parse(Some("branch"), Some("staged")).unwrap(),
            TaskDiffRequest::Branch(BranchDiffMode::Staged)
        );
        assert_eq!(
            TaskDiffRequest::parse(Some("working"), None).unwrap(),
            TaskDiffRequest::Working(WorkingDiffMode::All)
        );
        assert_eq!(
            TaskDiffRequest::parse(Some("working"), Some("unstaged")).unwrap(),
            TaskDiffRequest::Working(WorkingDiffMode::Unstaged)
        );
        assert_eq!(
            TaskDiffRequest::parse(Some("working"), Some("staged")).unwrap(),
            TaskDiffRequest::Working(WorkingDiffMode::Staged)
        );
        assert!(matches!(
            TaskDiffRequest::parse(Some("bogus"), None),
            Err(TaskDiffError::InvalidRequest(_))
        ));
        assert!(matches!(
            TaskDiffRequest::parse(Some("branch"), Some("bogus")),
            Err(TaskDiffError::InvalidRequest(_))
        ));
        assert!(matches!(
            TaskDiffRequest::parse(Some("working"), Some("none")),
            Err(TaskDiffError::InvalidRequest(_))
        ));
    }

    /// One workspace exercising every scope/mode: a committed change, a
    /// staged change, an unstaged change, and an untracked file.
    fn seed_layered_changes(fixture: &TaskDiffFixture) {
        git(&fixture.worktree, &["checkout", "-b", "branch-task-1"]);
        write_file(&fixture.worktree, "committed.txt", "committed\n");
        git(&fixture.worktree, &["add", "."]);
        git(&fixture.worktree, &["commit", "-m", "committed change"]);
        write_file(&fixture.worktree, "staged.txt", "staged\n");
        git(&fixture.worktree, &["add", "staged.txt"]);
        write_file(&fixture.worktree, "README.md", "hello\nunstaged\n");
        write_file(&fixture.worktree, "untracked.txt", "untracked\n");
    }

    #[test]
    fn branch_committed_mode_shows_only_commits_past_the_merge_base() {
        let fixture = TaskDiffFixture::new();
        seed_layered_changes(&fixture);

        let diff = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Branch(BranchDiffMode::Committed),
        )
        .expect("diff");
        assert!(diff.patch.contains("committed.txt"));
        assert!(!diff.patch.contains("staged.txt"));
        assert!(!diff.patch.contains("+unstaged"));
        assert!(!diff.patch.contains("untracked.txt"));
    }

    #[test]
    fn branch_staged_mode_reaches_through_the_index() {
        let fixture = TaskDiffFixture::new();
        seed_layered_changes(&fixture);

        let diff = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Branch(BranchDiffMode::Staged),
        )
        .expect("diff");
        assert!(diff.patch.contains("committed.txt"));
        assert!(diff.patch.contains("staged.txt"));
        assert!(!diff.patch.contains("+unstaged"));
        assert!(!diff.patch.contains("untracked.txt"));
    }

    #[test]
    fn branch_all_mode_includes_working_tree_and_untracked() {
        let fixture = TaskDiffFixture::new();
        seed_layered_changes(&fixture);

        let diff = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Branch(BranchDiffMode::All),
        )
        .expect("diff");
        assert!(diff.patch.contains("committed.txt"));
        assert!(diff.patch.contains("staged.txt"));
        assert!(diff.patch.contains("+unstaged"));
        assert!(diff.patch.contains("untracked.txt"));
    }

    #[test]
    fn working_modes_exclude_committed_changes() {
        let fixture = TaskDiffFixture::new();
        seed_layered_changes(&fixture);

        let all = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Working(WorkingDiffMode::All),
        )
        .expect("diff");
        assert!(!all.patch.contains("committed.txt"));
        assert!(all.patch.contains("staged.txt"));
        assert!(all.patch.contains("+unstaged"));
        assert!(all.patch.contains("untracked.txt"));
        assert_eq!(all.base_ref, None);
        assert_eq!(all.merge_base, None);

        let unstaged = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Working(WorkingDiffMode::Unstaged),
        )
        .expect("diff");
        assert!(!unstaged.patch.contains("committed.txt"));
        assert!(!unstaged.patch.contains("staged.txt"));
        assert!(unstaged.patch.contains("+unstaged"));
        assert!(unstaged.patch.contains("untracked.txt"));

        let staged = read_task_diff(
            &fixture.db,
            "task-1",
            TaskDiffRequest::Working(WorkingDiffMode::Staged),
        )
        .expect("diff");
        assert!(!staged.patch.contains("committed.txt"));
        assert!(staged.patch.contains("staged.txt"));
        assert!(!staged.patch.contains("+unstaged"));
        assert!(!staged.patch.contains("untracked.txt"));
    }

    #[test]
    fn truncate_at_line_boundary_keeps_whole_lines() {
        assert_eq!(truncate_at_line_boundary("ab\ncd\nef", 5), "ab\n");
        assert_eq!(truncate_at_line_boundary("ab\ncd\nef", 6), "ab\ncd\n");
        assert_eq!(truncate_at_line_boundary("abcdef", 3), "");
        assert_eq!(truncate_at_line_boundary("ab\n", 10), "ab\n");
    }
}
