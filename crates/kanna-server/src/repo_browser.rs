use crate::db::Db;
use ignore::gitignore::GitignoreBuilder;
use std::fmt;
use std::io::{BufRead, BufReader, Read};
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
    pub lines: Vec<String>,
    pub next_line: Option<usize>,
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
    NotDirectory,
    NotFile,
    Internal(String),
}

impl fmt::Display for BrowseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => f.write_str("invalid or disallowed browse path"),
            Self::RootNotFound => f.write_str("browse root is unavailable"),
            Self::TargetNotFound => f.write_str("browse path was not found"),
            Self::NotDirectory => f.write_str("browse path is not a directory"),
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
    let (canonical_root, target, relative) = resolve_target(root, requested_path)?;
    if !target.is_dir() {
        return Err(BrowseError::NotDirectory);
    }
    let matcher = gitignore_matcher(&canonical_root, &target)?;
    let normalized_filter = filter.map(str::to_lowercase);
    let mut all = Vec::new();
    for entry in std::fs::read_dir(&target).map_err(internal_io)? {
        let entry = entry.map_err(internal_io)?;
        let entry_path = entry.path();
        let canonical = std::fs::canonicalize(&entry_path).map_err(map_target_error)?;
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        let metadata = canonical.metadata().map_err(map_target_error)?;
        let is_dir = metadata.is_dir();
        if !is_dir && !metadata.is_file() {
            continue;
        }
        if !show_all && matcher.matched(&entry_path, is_dir).is_ignore() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
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
    line_count: usize,
    metadata_only: bool,
) -> Result<FileRange, BrowseError> {
    let (_, target, relative) = resolve_target(root, requested_path)?;
    let mut file = std::fs::File::open(&target).map_err(map_target_error)?;
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
            lines: Vec::new(),
            next_line: None,
            total_lines: 0,
            total_bytes: metadata.len(),
            binary: true,
            metadata_only,
        });
    }
    drop(file);
    let limit = line_count.clamp(1, MAX_LINE_RANGE);
    let mut total_lines = 0;
    let mut lines = Vec::new();
    let mut response_bytes: usize = 0;
    let mut collecting = true;
    for (index, line) in BufReader::new(std::fs::File::open(&target).map_err(map_target_error)?)
        .lines()
        .enumerate()
    {
        let line = match line {
            Ok(line) => line,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Ok(FileRange {
                    path: display_path(&relative),
                    start_line,
                    lines: Vec::new(),
                    next_line: None,
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
        if !collecting {
            continue;
        }
        let value = if metadata_only {
            line.len().to_string()
        } else {
            line
        };
        if response_bytes.saturating_add(value.len()) > FILE_RANGE_BYTES {
            if lines.is_empty() && !metadata_only {
                let mut end = FILE_RANGE_BYTES.min(value.len());
                while end > 0 && !value.is_char_boundary(end) {
                    end -= 1;
                }
                lines.push(value[..end].to_string());
            }
            collecting = false;
            continue;
        }
        response_bytes += value.len();
        lines.push(value);
    }
    let next = start_line.saturating_add(lines.len());
    Ok(FileRange {
        path: display_path(&relative),
        start_line,
        lines,
        next_line: (next < total_lines).then_some(next),
        total_lines,
        total_bytes: metadata.len(),
        binary: false,
        metadata_only,
    })
}

fn resolve_target(
    root: &Path,
    requested_path: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), BrowseError> {
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
    let canonical_root = std::fs::canonicalize(root).map_err(|_| BrowseError::RootNotFound)?;
    let target = std::fs::canonicalize(canonical_root.join(requested)).map_err(map_target_error)?;
    if !target.starts_with(&canonical_root) {
        return Err(BrowseError::InvalidPath);
    }
    let relative = target
        .strip_prefix(&canonical_root)
        .map_err(|_| BrowseError::InvalidPath)?
        .to_path_buf();
    Ok((canonical_root, target, relative))
}
fn gitignore_matcher(
    root: &Path,
    target: &Path,
) -> Result<ignore::gitignore::Gitignore, BrowseError> {
    let mut b = GitignoreBuilder::new(root);
    let mut current = root.to_path_buf();
    add_ignore(&mut b, &current);
    if let Ok(relative) = target.strip_prefix(root) {
        for c in relative.components() {
            current.push(c);
            add_ignore(&mut b, &current);
        }
    }
    if let Some(global) = ignore::gitignore::gitconfig_excludes_path() {
        if global.is_file() {
            b.add(global);
        }
    }
    b.build()
        .map_err(|e| BrowseError::Internal(format!("gitignore error: {e}")))
}
fn add_ignore(builder: &mut GitignoreBuilder, directory: &Path) {
    let path = directory.join(".gitignore");
    if path.is_file() {
        builder.add(path);
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
                read_file_range(&root, "escape", 0, 20, false),
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
        let range = read_file_range(temp.path(), "lines", 1, 2, false).unwrap();
        assert_eq!(range.lines, ["two", "three"]);
        assert_eq!(range.next_line, Some(3));
    }
    #[test]
    fn marks_binary_without_bytes() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("bin"), [0, 159]).unwrap();
        let range = read_file_range(temp.path(), "bin", 0, 20, false).unwrap();
        assert!(range.binary);
        assert!(range.lines.is_empty());
    }

    #[test]
    fn caps_response_bytes_and_continues_at_the_next_line() {
        let temp = tempfile::tempdir().unwrap();
        let line = "x".repeat(16 * 1024);
        let contents = std::iter::repeat_n(line, 40).collect::<Vec<_>>().join("\n");
        std::fs::write(temp.path().join("large.txt"), contents).unwrap();

        let first = read_file_range(temp.path(), "large.txt", 0, 40, false).unwrap();
        assert!(first.lines.iter().map(String::len).sum::<usize>() <= FILE_RANGE_BYTES);
        let next_line = first
            .next_line
            .expect("large file should require continuation");
        assert_eq!(next_line, first.lines.len());

        let second = read_file_range(temp.path(), "large.txt", next_line, 40, false).unwrap();
        assert_eq!(second.start_line, next_line);
        assert!(!second.lines.is_empty());
    }
}
