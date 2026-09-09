use crate::db::Db;
use std::collections::HashMap;
use std::fmt;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const MAX_TASK_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_TASK_FILE_MENTIONS: usize = 21;
const MAX_TASK_FILE_MENTION_PATH_BYTES: usize = 4 * 1024;
const MAX_TASK_FILE_MENTION_TOTAL_BYTES: usize = 32 * 1024;
const MAX_TASK_FILE_MENTION_MATCHES: usize = 10;
const MAX_TASK_FILE_WALK_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMention {
    pub path: String,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMatch {
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTaskFileMention {
    pub path: String,
    pub line: Option<u32>,
    pub matches: Vec<TaskFileMatch>,
    pub truncated: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileMentionResolution {
    pub mentions: Vec<ResolvedTaskFileMention>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskFileError {
    InvalidPath(String),
    RequestTooLarge,
    TaskNotFound,
    WorkspaceUnavailable,
    FileNotFound,
    TooLarge,
    UnsupportedContent,
    Internal(String),
}

impl fmt::Display for TaskFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(message) | Self::Internal(message) => formatter.write_str(message),
            Self::RequestTooLarge => formatter.write_str("too many task file mentions"),
            Self::TaskNotFound => formatter.write_str("task not found"),
            Self::WorkspaceUnavailable => formatter.write_str("task workspace unavailable"),
            Self::FileNotFound => formatter.write_str("file not found"),
            Self::TooLarge => formatter.write_str("file exceeds the 1 MiB limit"),
            Self::UnsupportedContent => formatter.write_str("file is not valid UTF-8 text"),
        }
    }
}

impl std::error::Error for TaskFileError {}

pub fn read_task_file(
    db: &Db,
    task_or_branch_id: &str,
    requested_path: &str,
) -> Result<TaskFileContent, TaskFileError> {
    let requested = Path::new(requested_path);
    if requested_path.trim().is_empty()
        || requested_path.contains('\0')
        || requested
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(disallowed_path());
    }

    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|error| TaskFileError::Internal(format!("db error: {error}")))?
        .ok_or(TaskFileError::TaskNotFound)?;
    let worktree_path = db
        .get_task_worktree_path(&task_id)
        .map_err(|error| TaskFileError::Internal(format!("db error: {error}")))?
        .ok_or(TaskFileError::WorkspaceUnavailable)?;
    let root = Path::new(&worktree_path);
    if !root.is_absolute() {
        return Err(TaskFileError::WorkspaceUnavailable);
    }
    let relative = normalize_requested_path(root, requested)?;
    let root_directory = open_task_workspace_root(root)?;
    let mut file = open_task_file_from_root(&root_directory, &relative)?;
    let metadata = file.metadata().map_err(|error| {
        TaskFileError::Internal(format!("failed to inspect task file: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(TaskFileError::InvalidPath(
            "file path must identify a regular file".to_string(),
        ));
    }
    if metadata.len() > MAX_TASK_FILE_BYTES {
        return Err(TaskFileError::TooLarge);
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_TASK_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| TaskFileError::Internal(format!("failed to read task file: {error}")))?;
    if bytes.len() as u64 > MAX_TASK_FILE_BYTES {
        return Err(TaskFileError::TooLarge);
    }

    let content = String::from_utf8(bytes).map_err(|_| TaskFileError::UnsupportedContent)?;

    Ok(TaskFileContent {
        path: display_path(&relative),
        content,
    })
}

pub fn resolve_task_file_mentions(
    db: &Db,
    task_or_branch_id: &str,
    mentions: Vec<TaskFileMention>,
) -> Result<TaskFileMentionResolution, TaskFileError> {
    resolve_task_file_mentions_with_limit(
        db,
        task_or_branch_id,
        mentions,
        MAX_TASK_FILE_WALK_ENTRIES,
    )
}

fn resolve_task_file_mentions_with_limit(
    db: &Db,
    task_or_branch_id: &str,
    mentions: Vec<TaskFileMention>,
    walk_entry_limit: usize,
) -> Result<TaskFileMentionResolution, TaskFileError> {
    validate_mention_batch(&mentions)?;

    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|error| TaskFileError::Internal(format!("db error: {error}")))?
        .ok_or(TaskFileError::TaskNotFound)?;
    let worktree_path = db
        .get_task_worktree_path(&task_id)
        .map_err(|error| TaskFileError::Internal(format!("db error: {error}")))?
        .ok_or(TaskFileError::WorkspaceUnavailable)?;
    let root = Path::new(&worktree_path);
    if !root.is_absolute() {
        return Err(TaskFileError::WorkspaceUnavailable);
    }
    let root_directory = open_task_workspace_root(root)?;

    let mut resolution = TaskFileMentionResolution {
        mentions: mentions
            .iter()
            .map(|mention| ResolvedTaskFileMention {
                path: mention.path.clone(),
                line: mention.line,
                matches: Vec::new(),
                truncated: false,
                unavailable_reason: None,
            })
            .collect(),
    };
    let mut basename_mentions: HashMap<String, Vec<usize>> = HashMap::new();

    for (index, mention) in mentions.iter().enumerate() {
        let requested = Path::new(&mention.path);
        let relative = match normalize_requested_path(root, requested) {
            Ok(relative) => relative,
            Err(error @ TaskFileError::InvalidPath(_)) => {
                resolution.mentions[index].unavailable_reason = Some(error.to_string());
                continue;
            }
            Err(error) => return Err(error),
        };
        match open_task_file_from_root(&root_directory, &relative) {
            Ok(file) => {
                let metadata = file.metadata().map_err(|error| {
                    TaskFileError::Internal(format!("failed to inspect task file: {error}"))
                })?;
                if !metadata.is_file() {
                    resolution.mentions[index].unavailable_reason =
                        Some("file path must identify a regular file".to_string());
                    continue;
                }
                resolution.mentions[index].matches.push(TaskFileMatch {
                    path: display_path(&relative),
                });
            }
            Err(TaskFileError::FileNotFound)
                if relative.components().count() == 1
                    && relative
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some() =>
            {
                let basename = relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .expect("checked UTF-8 basename");
                basename_mentions
                    .entry(basename.to_string())
                    .or_default()
                    .push(index);
            }
            Err(TaskFileError::FileNotFound) => {
                resolution.mentions[index].unavailable_reason =
                    Some(TaskFileError::FileNotFound.to_string());
            }
            Err(error @ TaskFileError::InvalidPath(_)) => {
                resolution.mentions[index].unavailable_reason = Some(error.to_string());
            }
            Err(error) => return Err(error),
        }
    }

    if basename_mentions.is_empty() {
        return Ok(resolution);
    }

    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .follow_links(false)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some(".git") | Some(".kanna-worktrees")
            )
        });

    let mut walk_incomplete = false;
    for (visited, entry_result) in builder.build().enumerate() {
        if visited >= walk_entry_limit {
            walk_incomplete = true;
            break;
        }
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => {
                walk_incomplete = true;
                continue;
            }
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let Some(indices) = entry
            .file_name()
            .to_str()
            .and_then(|basename| basename_mentions.get(basename))
        else {
            continue;
        };
        let Ok(relative) = entry.path().strip_prefix(root) else {
            walk_incomplete = true;
            continue;
        };

        let securely_opened = match open_task_file_from_root(&root_directory, relative) {
            Ok(file) => file
                .metadata()
                .map(|metadata| metadata.is_file())
                .unwrap_or(false),
            Err(_) => false,
        };
        if !securely_opened {
            continue;
        }

        let candidate = TaskFileMatch {
            path: display_path(relative),
        };
        for index in indices {
            let mention = &mut resolution.mentions[*index];
            mention.matches.push(candidate.clone());
            if mention.matches.len() > MAX_TASK_FILE_MENTION_MATCHES {
                mention
                    .matches
                    .sort_unstable_by(|left, right| left.path.cmp(&right.path));
                mention.matches.truncate(MAX_TASK_FILE_MENTION_MATCHES);
                mention.truncated = true;
            }
        }
    }

    for indices in basename_mentions.values() {
        for index in indices {
            let mention = &mut resolution.mentions[*index];
            mention
                .matches
                .sort_unstable_by(|left, right| left.path.cmp(&right.path));
            if walk_incomplete {
                mention.truncated = true;
            }
            if mention.matches.is_empty() {
                mention.unavailable_reason = Some(TaskFileError::FileNotFound.to_string());
            }
        }
    }

    Ok(resolution)
}

fn validate_mention_batch(mentions: &[TaskFileMention]) -> Result<(), TaskFileError> {
    if mentions.len() > MAX_TASK_FILE_MENTIONS {
        return Err(TaskFileError::RequestTooLarge);
    }
    let mut total_path_bytes = 0usize;
    for mention in mentions {
        let path_bytes = mention.path.len();
        total_path_bytes = total_path_bytes
            .checked_add(path_bytes)
            .ok_or(TaskFileError::RequestTooLarge)?;
        if path_bytes > MAX_TASK_FILE_MENTION_PATH_BYTES
            || total_path_bytes > MAX_TASK_FILE_MENTION_TOTAL_BYTES
        {
            return Err(TaskFileError::RequestTooLarge);
        }
    }
    Ok(())
}

fn disallowed_path() -> TaskFileError {
    TaskFileError::InvalidPath("file path must stay within the task workspace".to_string())
}

fn normalize_requested_path(root: &Path, requested: &Path) -> Result<PathBuf, TaskFileError> {
    let requested_text = requested.as_os_str().to_string_lossy();
    if requested_text.trim().is_empty() || requested_text.contains('\0') {
        return Err(disallowed_path());
    }
    let relative = if requested.is_absolute() {
        requested
            .strip_prefix(root)
            .map_err(|_| disallowed_path())?
    } else {
        requested
    };
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            _ => return Err(disallowed_path()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(TaskFileError::InvalidPath(
            "file path must identify a regular file".to_string(),
        ));
    }
    Ok(normalized)
}

#[cfg(unix)]
fn open_task_workspace_root(path: &Path) -> Result<std::os::fd::OwnedFd, TaskFileError> {
    openat_owned(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(map_workspace_open_error)
}

#[cfg(not(unix))]
fn open_task_workspace_root(_path: &Path) -> Result<(), TaskFileError> {
    Err(TaskFileError::Internal(
        "secure task file descriptor traversal is unsupported on this platform".to_string(),
    ))
}

#[cfg(unix)]
fn open_task_file_from_root(
    root_directory: &std::os::fd::OwnedFd,
    relative_target: &Path,
) -> Result<std::fs::File, TaskFileError> {
    use std::os::fd::AsRawFd;

    let mut directory = openat_owned(
        root_directory.as_raw_fd(),
        std::ffi::OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(map_workspace_open_error)?;

    let mut components = relative_target.components().peekable();
    if components.peek().is_none() {
        return Err(TaskFileError::InvalidPath(
            "file path must identify a regular file".to_string(),
        ));
    }

    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(disallowed_path());
        };
        let is_file = components.peek().is_none();
        let flags = if is_file {
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
        };
        let opened =
            openat_owned(directory.as_raw_fd(), name, flags).map_err(map_task_file_open_error)?;
        if is_file {
            return Ok(std::fs::File::from(opened));
        }
        directory = opened;
    }

    Err(disallowed_path())
}

#[cfg(not(unix))]
fn open_task_file_from_root(
    _root_directory: &(),
    _relative_target: &Path,
) -> Result<std::fs::File, TaskFileError> {
    Err(TaskFileError::Internal(
        "secure task file descriptor traversal is unsupported on this platform".to_string(),
    ))
}

#[cfg(unix)]
fn openat_owned(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
    flags: libc::c_int,
) -> Result<std::os::fd::OwnedFd, std::io::Error> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: `name` is NUL-terminated and alive for the call. The returned
    // descriptor is checked for failure and immediately owned exactly once.
    let file_descriptor = unsafe { libc::openat(directory_fd, name.as_ptr(), flags, 0) };
    if file_descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful `openat` returns a new descriptor owned by this
    // function, which transfers that sole ownership into `OwnedFd`.
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(file_descriptor) })
}

#[cfg(unix)]
fn map_task_file_open_error(error: std::io::Error) -> TaskFileError {
    match error.raw_os_error() {
        Some(code) if code == libc::ENOENT => TaskFileError::FileNotFound,
        Some(code)
            if code == libc::ELOOP
                || code == libc::EINVAL
                || code == libc::ENOTDIR
                || code == libc::EACCES
                || code == libc::EPERM
                || code == libc::ENXIO
                || code == libc::ENODEV
                || code == libc::EOPNOTSUPP =>
        {
            disallowed_path()
        }
        _ => TaskFileError::Internal(format!("failed to access task file: {error}")),
    }
}

#[cfg(unix)]
fn map_workspace_open_error(error: std::io::Error) -> TaskFileError {
    match error.raw_os_error() {
        Some(code)
            if code == libc::ENOENT
                || code == libc::ELOOP
                || code == libc::EINVAL
                || code == libc::ENOTDIR
                || code == libc::EACCES =>
        {
            TaskFileError::WorkspaceUnavailable
        }
        _ => TaskFileError::Internal(format!("failed to open task workspace: {error}")),
    }
}

fn display_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{open_task_file_from_root, open_task_workspace_root};
    use super::{
        read_task_file, resolve_task_file_mentions, resolve_task_file_mentions_with_limit,
        TaskFileError, TaskFileMatch, TaskFileMention, MAX_TASK_FILE_BYTES, MAX_TASK_FILE_MENTIONS,
        MAX_TASK_FILE_MENTION_MATCHES,
    };
    use crate::db::Db;
    use std::path::{Path, PathBuf};

    struct TaskFileFixture {
        db: Db,
        worktree: PathBuf,
        outside_file: PathBuf,
        _temp_dir: tempfile::TempDir,
    }

    impl TaskFileFixture {
        fn new() -> Self {
            let temp_dir = tempfile::tempdir().expect("create task file fixture");
            let worktree = temp_dir.path().join("worktree");
            std::fs::create_dir_all(&worktree).expect("create fixture worktree");

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
                "Read task files",
                Some("Read task files"),
                "in progress",
                "2026-07-15 10:00:00",
            )
            .expect("insert fixture task");
            db.upsert_worktree(
                "wt-task-1",
                "task-1",
                worktree.to_str().expect("utf-8 worktree path"),
                "branch-task-1",
            )
            .expect("insert fixture worktree");

            let outside_file = temp_dir.path().join("outside-secret.md");
            std::fs::write(&outside_file, "secret").expect("write outside fixture file");

            Self {
                db,
                worktree,
                outside_file,
                _temp_dir: temp_dir,
            }
        }

        fn write(&self, path: &str, content: &[u8]) -> PathBuf {
            let target = self.worktree.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create fixture file parent");
            }
            std::fs::write(&target, content).expect("write fixture file");
            target
        }

        #[cfg(unix)]
        fn symlink_outside(&self, path: &str) {
            let target = self.worktree.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create fixture symlink parent");
            }
            std::os::unix::fs::symlink(&self.outside_file, target)
                .expect("create escaping symlink");
        }
    }

    #[test]
    fn reads_nested_relative_utf8_file_and_normalizes_path() {
        let fixture = TaskFileFixture::new();
        fixture.write("docs/spec.md", b"# Spec\n");

        let result = read_task_file(&fixture.db, "task-1", "docs/spec.md").unwrap();

        assert_eq!(result.path, "docs/spec.md");
        assert_eq!(result.content, "# Spec\n");
    }

    #[test]
    fn resolves_exact_and_unique_bare_mentions_in_request_order() {
        let fixture = TaskFileFixture::new();
        fixture.write("README.md", b"root");
        fixture.write("apps/mobile/src/screens/TaskScreen.tsx", b"screen");

        let result = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![
                TaskFileMention {
                    path: "TaskScreen.tsx".into(),
                    line: Some(42),
                },
                TaskFileMention {
                    path: "README.md".into(),
                    line: None,
                },
            ],
        )
        .unwrap();

        assert_eq!(
            result.mentions[0].matches,
            vec![TaskFileMatch {
                path: "apps/mobile/src/screens/TaskScreen.tsx".into(),
            }]
        );
        assert_eq!(result.mentions[0].line, Some(42));
        assert_eq!(
            result.mentions[1].matches,
            vec![TaskFileMatch {
                path: "README.md".into(),
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn returns_sorted_ambiguous_matches_and_excludes_ignored_and_symlinked_files() {
        let fixture = TaskFileFixture::new();
        fixture.write(".gitignore", b"generated/\n");
        fixture.write("a/shared.ts", b"a");
        fixture.write("b/shared.ts", b"b");
        fixture.write("generated/shared.ts", b"ignored");
        fixture.symlink_outside("linked/shared.ts");

        let result = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "shared.ts".into(),
                line: None,
            }],
        )
        .unwrap();

        assert_eq!(
            result.mentions[0]
                .matches
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a/shared.ts", "b/shared.ts"]
        );
    }

    #[test]
    fn exactly_maximum_bare_filename_matches_are_sorted_and_not_truncated() {
        let fixture = TaskFileFixture::new();
        for index in (0..MAX_TASK_FILE_MENTION_MATCHES).rev() {
            fixture.write(&format!("match-{index:02}/shared.ts"), b"shared");
        }

        let result = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "shared.ts".into(),
                line: None,
            }],
        )
        .unwrap();

        assert_eq!(
            result.mentions[0]
                .matches
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>(),
            (0..MAX_TASK_FILE_MENTION_MATCHES)
                .map(|index| format!("match-{index:02}/shared.ts"))
                .collect::<Vec<_>>()
        );
        assert!(!result.mentions[0].truncated);
    }

    #[test]
    fn more_than_maximum_bare_filename_matches_return_lexicographically_first_paths() {
        let fixture = TaskFileFixture::new();
        fixture.write("a/shared.ts", b"shared");
        for index in (0..=MAX_TASK_FILE_MENTION_MATCHES).rev() {
            fixture.write(&format!("a-{index:02}/shared.ts"), b"shared");
        }

        let result = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "shared.ts".into(),
                line: None,
            }],
        )
        .unwrap();

        assert_eq!(
            result.mentions[0]
                .matches
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>(),
            (0..MAX_TASK_FILE_MENTION_MATCHES)
                .map(|index| format!("a-{index:02}/shared.ts"))
                .collect::<Vec<_>>()
        );
        assert!(result.mentions[0].truncated);
    }

    #[test]
    fn resolves_invalid_mentions_per_row_and_rejects_oversized_requests() {
        let fixture = TaskFileFixture::new();
        fixture.write("src/available.ts", b"available");

        let resolution = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![
                TaskFileMention {
                    path: "src/available.ts".into(),
                    line: Some(4),
                },
                TaskFileMention {
                    path: fixture.outside_file.to_string_lossy().into_owned(),
                    line: None,
                },
                TaskFileMention {
                    path: "../secret.ts".into(),
                    line: None,
                },
            ],
        )
        .unwrap();

        assert_eq!(
            resolution.mentions[0].matches,
            vec![TaskFileMatch {
                path: "src/available.ts".into(),
            }]
        );
        assert_eq!(resolution.mentions[0].unavailable_reason, None);
        for unavailable in &resolution.mentions[1..] {
            assert!(unavailable.matches.is_empty());
            assert_eq!(
                unavailable.unavailable_reason.as_deref(),
                Some("file path must stay within the task workspace")
            );
        }

        assert!(matches!(
            resolve_task_file_mentions(
                &fixture.db,
                "task-1",
                (0..=MAX_TASK_FILE_MENTIONS)
                    .map(|index| TaskFileMention {
                        path: format!("file-{index}.ts"),
                        line: None,
                    })
                    .collect()
            ),
            Err(TaskFileError::RequestTooLarge)
        ));
    }

    #[test]
    fn missing_nested_mentions_do_not_trigger_basename_search() {
        let fixture = TaskFileFixture::new();
        fixture.write("other/missing.ts", b"not the requested path");

        let result = resolve_task_file_mentions(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "expected/missing.ts".into(),
                line: Some(9),
            }],
        )
        .unwrap();

        assert!(result.mentions[0].matches.is_empty());
        assert!(!result.mentions[0].truncated);
        assert_eq!(result.mentions[0].line, Some(9));
    }

    #[test]
    fn marks_unresolved_basename_truncated_when_walk_limit_is_reached() {
        let fixture = TaskFileFixture::new();
        fixture.write("a.ts", b"a");
        fixture.write("nested/b.ts", b"b");

        let result = resolve_task_file_mentions_with_limit(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "missing.ts".into(),
                line: None,
            }],
            1,
        )
        .unwrap();

        assert!(result.mentions[0].matches.is_empty());
        assert!(result.mentions[0].truncated);
    }

    #[test]
    fn bounds_bare_filename_resolution_when_the_match_is_beyond_the_walk_limit() {
        let fixture = TaskFileFixture::new();
        fixture.write("nested/available.ts", b"available");

        let result = resolve_task_file_mentions_with_limit(
            &fixture.db,
            "task-1",
            vec![TaskFileMention {
                path: "available.ts".into(),
                line: None,
            }],
            0,
        )
        .unwrap();

        assert!(result.mentions[0].matches.is_empty());
        assert!(result.mentions[0].truncated);
        assert_eq!(
            result.mentions[0].unavailable_reason.as_deref(),
            Some("file not found")
        );
    }

    #[test]
    fn reads_bare_relative_file() {
        let fixture = TaskFileFixture::new();
        fixture.write("README.md", b"read me");

        let result = read_task_file(&fixture.db, "task-1", "README.md").unwrap();

        assert_eq!(result.path, "README.md");
        assert_eq!(result.content, "read me");
    }

    #[test]
    fn accepts_absolute_path_inside_worktree_and_normalizes_response_path() {
        let fixture = TaskFileFixture::new();
        let target = fixture.write("docs/spec.md", b"# Spec\n");

        let result = read_task_file(
            &fixture.db,
            "task-1",
            target.to_str().expect("utf-8 fixture path"),
        )
        .unwrap();

        assert_eq!(result.path, "docs/spec.md");
    }

    #[test]
    fn resolves_branch_alias_before_reading() {
        let fixture = TaskFileFixture::new();
        fixture.write("README.md", b"read me");

        let result = read_task_file(&fixture.db, "branch-task-1", "README.md").unwrap();

        assert_eq!(result.content, "read me");
    }

    #[cfg(unix)]
    #[test]
    fn anchored_resolver_keeps_the_original_root_when_its_path_is_replaced() {
        let fixture = TaskFileFixture::new();
        fixture.write("README.md", b"original workspace");
        let held_root = open_task_workspace_root(&fixture.worktree).unwrap();

        let replacement = fixture._temp_dir.path().join("replacement-worktree");
        std::fs::create_dir_all(&replacement).unwrap();
        std::fs::write(replacement.join("README.md"), "outside replacement").unwrap();
        std::fs::rename(
            &fixture.worktree,
            fixture._temp_dir.path().join("original-worktree"),
        )
        .unwrap();
        std::fs::rename(&replacement, &fixture.worktree).unwrap();

        let mut file = open_task_file_from_root(&held_root, Path::new("README.md")).unwrap();
        let mut content = String::new();
        std::io::Read::read_to_string(&mut file, &mut content).unwrap();
        assert_eq!(content, "original workspace");
    }

    #[test]
    fn rejects_empty_path() {
        let fixture = TaskFileFixture::new();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "  "),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_parent_directory_component() {
        let fixture = TaskFileFixture::new();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "docs/../outside-secret.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_embedded_nul_as_invalid_path() {
        let fixture = TaskFileFixture::new();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "docs/bad\0name.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_traversal_through_regular_file_as_invalid_path() {
        let fixture = TaskFileFixture::new();
        fixture.write("README.md", b"read me");

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "README.md/child.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_existing_absolute_file_outside_worktree() {
        let fixture = TaskFileFixture::new();

        assert!(matches!(
            read_task_file(
                &fixture.db,
                "task-1",
                fixture
                    .outside_file
                    .to_str()
                    .expect("utf-8 outside fixture path"),
            ),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_missing_absolute_file_outside_worktree_without_an_existence_oracle() {
        let fixture = TaskFileFixture::new();
        let missing = fixture._temp_dir.path().join("missing-outside.md");

        assert!(matches!(
            read_task_file(
                &fixture.db,
                "task-1",
                missing.to_str().expect("utf-8 outside fixture path"),
            ),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let fixture = TaskFileFixture::new();
        fixture.symlink_outside("docs/escape.md");

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "docs/escape.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_even_when_they_resolve_inside_the_workspace() {
        let fixture = TaskFileFixture::new();
        fixture.write("docs/target.md", b"inside");
        std::os::unix::fs::symlink("target.md", fixture.worktree.join("docs/link.md")).unwrap();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "docs/link.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_loop_as_invalid_path() {
        let fixture = TaskFileFixture::new();
        std::os::unix::fs::symlink("loop-b.md", fixture.worktree.join("loop-a.md")).unwrap();
        std::os::unix::fs::symlink("loop-a.md", fixture.worktree.join("loop-b.md")).unwrap();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "loop-a.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unreadable_file_as_invalid_path() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = TaskFileFixture::new();
        let target = fixture.write("private.md", b"private");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o000)).unwrap();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "private.md"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn rejects_directory() {
        let fixture = TaskFileFixture::new();
        std::fs::create_dir_all(fixture.worktree.join("docs")).unwrap();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "docs"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unix_domain_socket_as_a_non_regular_file() {
        let fixture = TaskFileFixture::new();
        let socket_path = fixture.worktree.join("agent.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();

        assert!(matches!(
            read_task_file(&fixture.db, "task-1", "agent.sock"),
            Err(TaskFileError::InvalidPath(_))
        ));
    }

    #[test]
    fn reports_missing_file() {
        let fixture = TaskFileFixture::new();

        assert_eq!(
            read_task_file(&fixture.db, "task-1", "missing.md"),
            Err(TaskFileError::FileNotFound)
        );
    }

    #[test]
    fn rejects_oversized_file() {
        let fixture = TaskFileFixture::new();
        fixture.write("large.md", &vec![b'x'; MAX_TASK_FILE_BYTES as usize + 1]);

        assert_eq!(
            read_task_file(&fixture.db, "task-1", "large.md"),
            Err(TaskFileError::TooLarge)
        );
    }

    #[test]
    fn rejects_invalid_utf8() {
        let fixture = TaskFileFixture::new();
        fixture.write("binary.md", &[0xff, 0xfe]);

        assert_eq!(
            read_task_file(&fixture.db, "task-1", "binary.md"),
            Err(TaskFileError::UnsupportedContent)
        );
    }

    #[test]
    fn distinguishes_unknown_task() {
        let fixture = TaskFileFixture::new();

        assert_eq!(
            read_task_file(&fixture.db, "missing-task", "README.md"),
            Err(TaskFileError::TaskNotFound)
        );
    }

    #[test]
    fn distinguishes_unavailable_workspace() {
        let fixture = TaskFileFixture::new();
        fixture.db.delete_worktree_rows_for_task("task-1").unwrap();

        assert_eq!(
            read_task_file(&fixture.db, "task-1", "README.md"),
            Err(TaskFileError::WorkspaceUnavailable)
        );
    }
}
