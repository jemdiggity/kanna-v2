use crate::db::Db;
use ignore::gitignore::GitignoreBuilder;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Seek};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

pub const FILE_RANGE_BYTES: usize = 256 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 100;
pub const MAX_LINE_RANGE: usize = 200;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<BrowseEntry>,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub total_entries: usize,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileRange {
    pub path: String,
    pub start_line: usize,
    pub start_byte: usize,
    pub lines: Vec<String>,
    pub next_line: Option<usize>,
    pub next_byte: Option<usize>,
    pub total_lines: usize,
    pub total_bytes: u64,
    pub binary: bool,
    pub metadata_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowseError {
    InvalidPath,
    RootNotFound,
    TargetNotFound,
    NotFile,
    Internal(String),
}

impl fmt::Display for BrowseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("invalid or disallowed browse path"),
            Self::RootNotFound => f.write_str("browse root is unavailable"),
            Self::TargetNotFound => f.write_str("browse path was not found"),
            Self::NotFile => f.write_str("browse path is not a regular file"),
            Self::Internal(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for BrowseError {}

pub fn task_root(db: &Db, task_id: &str) -> Result<PathBuf, BrowseError> {
    let resolved = db
        .resolve_pipeline_item_id(task_id)
        .map_err(internal_db)?
        .ok_or(BrowseError::RootNotFound)?;
    db.get_task_worktree_path(&resolved)
        .map_err(internal_db)?
        .map(PathBuf::from)
        .ok_or(BrowseError::RootNotFound)
}

pub fn list_directory(
    root: &Path,
    requested_path: &str,
    show_all: bool,
    offset: usize,
    limit: usize,
    filter: Option<&str>,
) -> Result<DirectoryListing, BrowseError> {
    let relative = normalize_requested_path(requested_path)?;
    let root_directory = open_browse_root(root)?;
    let target_directory = open_directory_from_root(&root_directory, &relative)?;
    let matcher = gitignore_matcher(&root_directory, root, &relative)?;
    let normalized_filter = filter.map(str::to_lowercase);
    let mut all = Vec::new();
    for name in directory_names(&target_directory)? {
        let opened = match open_child(&target_directory, &name) {
            Ok(opened) => opened,
            Err(BrowseError::InvalidPath | BrowseError::TargetNotFound) => continue,
            Err(error) => return Err(error),
        };
        let metadata = std::fs::File::from(opened)
            .metadata()
            .map_err(map_target_error)?;
        let is_dir = metadata.is_dir();
        if !is_dir && !metadata.is_file() {
            continue;
        }
        let entry_path = root.join(&relative).join(&name);
        if !show_all && matcher.matched(&entry_path, is_dir).is_ignore() {
            continue;
        }
        let name = name.to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        if normalized_filter
            .as_ref()
            .is_some_and(|query| !name.to_lowercase().contains(query))
        {
            continue;
        }
        all.push(BrowseEntry {
            path: display_path(&relative.join(&name)),
            name,
            is_dir,
            size: (!is_dir).then_some(metadata.len()),
        });
    }
    all.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let total_entries = all.len();
    let limit = limit.clamp(1, MAX_DIRECTORY_ENTRIES);
    let entries = all.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(limit);
    Ok(DirectoryListing {
        path: display_path(&relative),
        entries,
        offset,
        next_offset: (next < total_entries).then_some(next),
        total_entries,
    })
}

pub fn read_file_range(
    root: &Path,
    requested_path: &str,
    start_line: usize,
    start_byte: usize,
    line_count: usize,
    metadata_only: bool,
) -> Result<FileRange, BrowseError> {
    let relative = normalize_requested_path(requested_path)?;
    if relative.as_os_str().is_empty() {
        return Err(BrowseError::NotFile);
    }
    let root_directory = open_browse_root(root)?;
    let mut file = open_file_from_root(&root_directory, &relative)?;
    let metadata = file.metadata().map_err(map_target_error)?;
    if !metadata.is_file() {
        return Err(BrowseError::NotFile);
    }
    let mut sniff = vec![0; BINARY_SNIFF_BYTES.min(metadata.len() as usize)];
    file.read_exact(&mut sniff).map_err(internal_io)?;
    let invalid_utf8 = std::str::from_utf8(&sniff).is_err_and(|error| error.error_len().is_some());
    let binary = sniff.contains(&0) || invalid_utf8;
    if binary {
        return Ok(FileRange {
            path: display_path(&relative),
            start_line,
            start_byte,
            lines: Vec::new(),
            next_line: None,
            next_byte: None,
            total_lines: 0,
            total_bytes: metadata.len(),
            binary: true,
            metadata_only,
        });
    }
    file.rewind().map_err(internal_io)?;
    let limit = line_count.clamp(1, MAX_LINE_RANGE);
    let mut total_lines = 0;
    let mut lines = Vec::new();
    let mut response_bytes: usize = 0;
    let mut continuation = None;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Ok(FileRange {
                    path: display_path(&relative),
                    start_line,
                    start_byte,
                    lines: Vec::new(),
                    next_line: None,
                    next_byte: None,
                    total_lines: 0,
                    total_bytes: metadata.len(),
                    binary: true,
                    metadata_only,
                });
            }
            Err(error) => return Err(internal_io(error)),
        };
        total_lines = index + 1;
        if index < start_line || index >= start_line.saturating_add(limit) {
            continue;
        }
        if continuation.is_some() {
            continue;
        }
        let value = if metadata_only {
            line.len().to_string()
        } else if index == start_line {
            if start_byte > line.len() || !line.is_char_boundary(start_byte) {
                return Err(BrowseError::InvalidPath);
            }
            line[start_byte..].to_string()
        } else {
            line
        };
        if response_bytes.saturating_add(value.len()) > FILE_RANGE_BYTES {
            if !metadata_only && lines.is_empty() {
                let remaining = FILE_RANGE_BYTES.saturating_sub(response_bytes);
                let mut end = remaining.min(value.len());
                while end > 0 && !value.is_char_boundary(end) {
                    end -= 1;
                }
                lines.push(value[..end].to_string());
                continuation = Some((
                    index,
                    if index == start_line {
                        start_byte + end
                    } else {
                        end
                    },
                ));
            } else {
                continuation = Some((index, 0));
            }
            continue;
        }
        response_bytes += value.len();
        lines.push(value);
    }
    let natural_next = start_line.saturating_add(lines.len());
    let (next_line, next_byte) = continuation
        .map(|(line, byte)| (Some(line), Some(byte)))
        .unwrap_or_else(|| ((natural_next < total_lines).then_some(natural_next), None));
    Ok(FileRange {
        path: display_path(&relative),
        start_line,
        start_byte,
        lines,
        next_line,
        next_byte,
        total_lines,
        total_bytes: metadata.len(),
        binary: false,
        metadata_only,
    })
}

fn normalize_requested_path(requested_path: &str) -> Result<PathBuf, BrowseError> {
    if requested_path.contains('\0') {
        return Err(BrowseError::InvalidPath);
    }
    let requested = Path::new(requested_path);
    if requested.is_absolute()
        || requested.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(BrowseError::InvalidPath);
    }
    let mut relative = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::Normal(name) => relative.push(name),
            Component::CurDir => {}
            _ => return Err(BrowseError::InvalidPath),
        }
    }
    Ok(relative)
}
fn gitignore_matcher(
    root_directory: &OwnedFd,
    root_path: &Path,
    relative_target: &Path,
) -> Result<ignore::gitignore::Gitignore, BrowseError> {
    let mut b = GitignoreBuilder::new(root_path);
    let mut current = PathBuf::new();
    add_ignore(&mut b, root_directory, &current)?;
    for component in relative_target.components() {
        current.push(component);
        add_ignore(&mut b, root_directory, &current)?;
    }
    if let Some(global) = ignore::gitignore::gitconfig_excludes_path() {
        if global.is_file() {
            b.add(global);
        }
    }
    b.build()
        .map_err(|e| BrowseError::Internal(format!("gitignore error: {e}")))
}
fn add_ignore(
    builder: &mut GitignoreBuilder,
    root: &OwnedFd,
    directory: &Path,
) -> Result<(), BrowseError> {
    let path = directory.join(".gitignore");
    match open_file_from_root(root, &path) {
        Ok(file) => {
            for line in BufReader::new(file).lines() {
                builder
                    .add_line(Some(path.clone()), &line.map_err(internal_io)?)
                    .map_err(|error| BrowseError::Internal(format!("gitignore error: {error}")))?;
            }
        }
        Err(BrowseError::TargetNotFound | BrowseError::InvalidPath) => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(unix)]
fn open_browse_root(path: &Path) -> Result<OwnedFd, BrowseError> {
    openat_owned(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|_| BrowseError::RootNotFound)
}

#[cfg(unix)]
fn open_directory_from_root(root: &OwnedFd, relative: &Path) -> Result<OwnedFd, BrowseError> {
    traverse_from_root(root, relative, true)
}

#[cfg(unix)]
fn open_file_from_root(root: &OwnedFd, relative: &Path) -> Result<std::fs::File, BrowseError> {
    if relative.as_os_str().is_empty() {
        return Err(BrowseError::NotFile);
    }
    traverse_from_root(root, relative, false).map(std::fs::File::from)
}

#[cfg(unix)]
fn traverse_from_root(
    root: &OwnedFd,
    relative: &Path,
    target_is_directory: bool,
) -> Result<OwnedFd, BrowseError> {
    let mut directory = openat_owned(
        root.as_raw_fd(),
        std::ffi::OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(map_open_error)?;
    let mut components = relative.components().peekable();
    if components.peek().is_none() {
        return if target_is_directory {
            Ok(directory)
        } else {
            Err(BrowseError::NotFile)
        };
    }
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(BrowseError::InvalidPath);
        };
        let last = components.peek().is_none();
        let flags = if last && !target_is_directory {
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
        };
        directory = openat_owned(directory.as_raw_fd(), name, flags).map_err(map_open_error)?;
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_child(directory: &OwnedFd, name: &std::ffi::OsStr) -> Result<OwnedFd, BrowseError> {
    openat_owned(
        directory.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )
    .map_err(map_open_error)
}

#[cfg(unix)]
fn directory_names(directory: &OwnedFd) -> Result<Vec<std::ffi::OsString>, BrowseError> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(internal_io(std::io::Error::last_os_error()));
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe { libc::close(duplicate) };
        return Err(internal_io(std::io::Error::last_os_error()));
    }
    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = DirectoryStream(stream);
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        names.push(std::ffi::OsStr::from_bytes(bytes).to_os_string());
    }
    Ok(names)
}

#[cfg(unix)]
fn openat_owned(
    directory: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
    flags: libc::c_int,
) -> Result<OwnedFd, std::io::Error> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, 0) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn map_open_error(error: std::io::Error) -> BrowseError {
    match error.raw_os_error() {
        Some(code) if code == libc::ENOENT => BrowseError::TargetNotFound,
        Some(
            libc::ELOOP | libc::ENOTDIR | libc::EACCES | libc::EPERM | libc::ENXIO | libc::ENODEV,
        ) => BrowseError::InvalidPath,
        _ => internal_io(error),
    }
}
fn internal_db(error: rusqlite::Error) -> BrowseError {
    BrowseError::Internal(format!("db error: {error}"))
}
fn internal_io(error: std::io::Error) -> BrowseError {
    BrowseError::Internal(format!("failed to read browse path: {error}"))
}
fn map_target_error(error: std::io::Error) -> BrowseError {
    match error.kind() {
        std::io::ErrorKind::NotFound => BrowseError::TargetNotFound,
        std::io::ErrorKind::PermissionDenied => BrowseError::InvalidPath,
        _ => internal_io(error),
    }
}
fn display_path(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_traversal_and_symlink_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let secret = temp.path().join("secret");
        std::fs::write(&secret, "secret").unwrap();
        assert_eq!(
            list_directory(&root, "../", false, 0, 50, None),
            Err(BrowseError::InvalidPath)
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, root.join("escape")).unwrap();
            assert_eq!(
                read_file_range(&root, "escape", 0, 0, 20, false),
                Err(BrowseError::InvalidPath)
            );
            assert_eq!(
                list_directory(&root, "escape", false, 0, 50, None),
                Err(BrowseError::InvalidPath)
            );
        }
    }
    #[test]
    fn pages_directory_and_line_ranges() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(temp.path().join(name), name).unwrap();
        }
        let page = list_directory(temp.path(), "", false, 1, 1, None).unwrap();
        assert_eq!(page.entries[0].name, "b");
        assert_eq!(page.next_offset, Some(2));
        std::fs::write(temp.path().join("lines"), "one\ntwo\nthree\nfour").unwrap();
        let range = read_file_range(temp.path(), "lines", 1, 0, 2, false).unwrap();
        assert_eq!(range.lines, ["two", "three"]);
        assert_eq!(range.next_line, Some(3));
    }
    #[test]
    fn marks_binary_without_bytes() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("bin"), [0, 159]).unwrap();
        let range = read_file_range(temp.path(), "bin", 0, 0, 20, false).unwrap();
        assert!(range.binary);
        assert!(range.lines.is_empty());
    }

    #[test]
    fn caps_response_bytes_and_continues_at_the_next_line() {
        let temp = tempfile::tempdir().unwrap();
        let line = "x".repeat(16 * 1024);
        let contents = std::iter::repeat_n(line, 40).collect::<Vec<_>>().join("\n");
        std::fs::write(temp.path().join("large.txt"), contents).unwrap();

        let first = read_file_range(temp.path(), "large.txt", 0, 0, 40, false).unwrap();
        assert!(first.lines.iter().map(String::len).sum::<usize>() <= FILE_RANGE_BYTES);
        let next_line = first
            .next_line
            .expect("large file should require continuation");
        assert_eq!(next_line, first.lines.len());

        let second = read_file_range(
            temp.path(),
            "large.txt",
            next_line,
            first.next_byte.unwrap_or(0),
            40,
            false,
        )
        .unwrap();
        assert_eq!(second.start_line, next_line);
        assert!(!second.lines.is_empty());
    }

    #[test]
    fn continues_a_single_line_by_byte_without_gaps() {
        let temp = tempfile::tempdir().unwrap();
        let expected = "é".repeat(FILE_RANGE_BYTES);
        std::fs::write(temp.path().join("single.txt"), &expected).unwrap();
        let mut line = 0;
        let mut byte = 0;
        let mut reconstructed = String::new();
        loop {
            let range = read_file_range(temp.path(), "single.txt", line, byte, 1, false).unwrap();
            assert!(range.lines.iter().map(String::len).sum::<usize>() <= FILE_RANGE_BYTES);
            reconstructed.push_str(range.lines.first().map(String::as_str).unwrap_or(""));
            let Some(next_line) = range.next_line else {
                break;
            };
            line = next_line;
            byte = range.next_byte.unwrap_or(0);
        }
        assert_eq!(reconstructed, expected);
    }
}
