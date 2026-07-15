use crate::db::Db;
use std::fmt;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const MAX_TASK_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskFileError {
    InvalidPath(String),
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

fn disallowed_path() -> TaskFileError {
    TaskFileError::InvalidPath("file path must stay within the task workspace".to_string())
}

fn normalize_requested_path(root: &Path, requested: &Path) -> Result<PathBuf, TaskFileError> {
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
    use super::{read_task_file, TaskFileError, MAX_TASK_FILE_BYTES};
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
