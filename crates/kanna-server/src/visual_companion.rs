use crate::db::Db;
use kanna_agent_protocol::{CompanionDocumentKind, CompanionEvent};
use std::fmt;
use std::io::Read;
use std::path::Path;

pub const MAX_COMPANION_HTML_BYTES: u64 = 1024 * 1024;
const MAX_COMPANION_EVENT_BYTES: usize = 8 * 1024;
const MAX_CHOICE_BYTES: usize = 256;
const MAX_ELEMENT_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_EVENT_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionDocument {
    pub session_id: String,
    pub revision: String,
    pub document_kind: CompanionDocumentKind,
    pub html: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionError {
    TaskNotFound,
    WorkspaceUnavailable,
    TooLarge,
    UnsupportedContent,
    StaleRevision,
    InvalidEvent,
    Internal(String),
}

impl fmt::Display for CompanionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TaskNotFound => formatter.write_str("task not found"),
            Self::WorkspaceUnavailable => formatter.write_str("task workspace unavailable"),
            Self::TooLarge => formatter.write_str("visual companion exceeds the 1 MiB limit"),
            Self::UnsupportedContent => {
                formatter.write_str("visual companion is not valid UTF-8 HTML")
            }
            Self::StaleRevision => formatter.write_str("visual companion revision is stale"),
            Self::InvalidEvent => formatter.write_str("visual companion event is invalid"),
            Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CompanionError {}

pub fn current_document(
    db_path: &str,
    task_id: &str,
) -> Result<Option<CompanionDocument>, CompanionError> {
    #[cfg(unix)]
    {
        let root = open_current_workspace(db_path, task_id)?;
        discover_document(&root)
    }
    #[cfg(not(unix))]
    {
        let _ = (db_path, task_id);
        Err(CompanionError::Internal(
            "secure visual companion traversal is unsupported on this platform".into(),
        ))
    }
}

pub fn append_event(
    db_path: &str,
    task_id: &str,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<(), CompanionError> {
    let serialized = validate_event(event)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;

        if !is_normal_component(session_id) {
            return Err(CompanionError::StaleRevision);
        }
        let root = open_current_workspace(db_path, task_id)?;
        let current = discover_document(&root)?.ok_or(CompanionError::StaleRevision)?;
        if current.session_id != session_id || current.revision != revision {
            return Err(CompanionError::StaleRevision);
        }

        let brainstorm = open_companion_root(&root)?.ok_or(CompanionError::StaleRevision)?;
        let session = open_optional_directory(brainstorm.as_raw_fd(), session_id)?
            .ok_or(CompanionError::StaleRevision)?;
        let state = open_optional_directory(session.as_raw_fd(), "state")?
            .ok_or(CompanionError::StaleRevision)?;
        let current = discover_document(&root)?.ok_or(CompanionError::StaleRevision)?;
        if current.session_id != session_id || current.revision != revision {
            return Err(CompanionError::StaleRevision);
        }
        let events = openat_owned(
            state.as_raw_fd(),
            std::ffi::OsStr::new("events"),
            libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map_err(|_| CompanionError::Internal("failed to open visual companion events".into()))?;
        let mut line = serialized;
        line.push(b'\n');
        // A single append-mode write keeps each bounded JSONL event intact
        // relative to other writers of similarly sized companion events.
        let written = unsafe {
            libc::write(
                events.as_raw_fd(),
                line.as_ptr().cast::<libc::c_void>(),
                line.len(),
            )
        };
        if written < 0 || written as usize != line.len() {
            return Err(CompanionError::Internal(
                "failed to append visual companion event".into(),
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (db_path, task_id, session_id, revision, serialized);
        Err(CompanionError::Internal(
            "secure visual companion traversal is unsupported on this platform".into(),
        ))
    }
}

fn validate_event(event: &CompanionEvent) -> Result<Vec<u8>, CompanionError> {
    if event.event_type != "click"
        || event.choice.is_empty()
        || event.choice.len() > MAX_CHOICE_BYTES
        || event
            .element_id
            .as_ref()
            .is_some_and(|element_id| element_id.len() > MAX_ELEMENT_ID_BYTES)
        || event.text.len() > MAX_TEXT_BYTES
        || event.event_id.is_empty()
        || event.event_id.len() > MAX_EVENT_ID_BYTES
    {
        return Err(CompanionError::InvalidEvent);
    }
    let serialized = serde_json::to_vec(event).map_err(|_| CompanionError::InvalidEvent)?;
    if serialized.len() > MAX_COMPANION_EVENT_BYTES {
        return Err(CompanionError::InvalidEvent);
    }
    Ok(serialized)
}

fn is_normal_component(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\0')
        && Path::new(value).components().count() == 1
        && matches!(
            Path::new(value).components().next(),
            Some(std::path::Component::Normal(_))
        )
}

#[cfg(unix)]
fn open_current_workspace(
    db_path: &str,
    task_or_branch_id: &str,
) -> Result<std::os::fd::OwnedFd, CompanionError> {
    let db = Db::open(db_path)
        .map_err(|_| CompanionError::Internal("failed to open Kanna database".into()))?;
    let task_id = db
        .resolve_pipeline_item_id(task_or_branch_id)
        .map_err(|_| CompanionError::Internal("failed to resolve companion task".into()))?
        .ok_or(CompanionError::TaskNotFound)?;
    let worktree = db
        .get_task_worktree_path(&task_id)
        .map_err(|_| CompanionError::Internal("failed to resolve task workspace".into()))?
        .ok_or(CompanionError::WorkspaceUnavailable)?;
    let path = Path::new(&worktree);
    if !path.is_absolute() {
        return Err(CompanionError::WorkspaceUnavailable);
    }
    openat_owned(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
    .map_err(|_| CompanionError::WorkspaceUnavailable)
}

#[cfg(unix)]
fn open_companion_root(
    workspace: &std::os::fd::OwnedFd,
) -> Result<Option<std::os::fd::OwnedFd>, CompanionError> {
    use std::os::fd::AsRawFd;

    let Some(superpowers) = open_optional_directory(workspace.as_raw_fd(), ".superpowers")? else {
        return Ok(None);
    };
    let Some(brainstorm) = open_optional_directory(superpowers.as_raw_fd(), "brainstorm")? else {
        return Ok(None);
    };
    Ok(Some(brainstorm))
}

#[cfg(unix)]
struct DocumentCandidate {
    session_id: String,
    file_name: std::ffi::OsString,
    modified: std::time::SystemTime,
    length: u64,
    file: std::fs::File,
}

#[cfg(unix)]
fn discover_document(
    workspace: &std::os::fd::OwnedFd,
) -> Result<Option<CompanionDocument>, CompanionError> {
    use std::os::fd::AsRawFd;

    let Some(brainstorm) = open_companion_root(workspace)? else {
        return Ok(None);
    };
    let mut selected: Option<DocumentCandidate> = None;
    for session_name in directory_names(&brainstorm)? {
        let Some(session_id) = session_name.to_str() else {
            continue;
        };
        if !is_normal_component(session_id) {
            continue;
        }
        let Some(session) = open_optional_directory(brainstorm.as_raw_fd(), session_id)? else {
            continue;
        };
        let Some(state) = open_optional_directory(session.as_raw_fd(), "state")? else {
            continue;
        };
        if !regular_file_exists(state.as_raw_fd(), "server-info")?
            || entry_exists(state.as_raw_fd(), "server-stopped")?
        {
            continue;
        }
        let Some(content) = open_optional_directory(session.as_raw_fd(), "content")? else {
            continue;
        };
        for file_name in directory_names(&content)? {
            if Path::new(&file_name)
                .extension()
                .and_then(|value| value.to_str())
                != Some("html")
            {
                continue;
            }
            let Some(file) = open_optional_regular_file(content.as_raw_fd(), &file_name)? else {
                continue;
            };
            let metadata = file.metadata().map_err(|_| {
                CompanionError::Internal("failed to inspect visual companion".into())
            })?;
            let candidate = DocumentCandidate {
                session_id: session_id.to_string(),
                file_name,
                modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                length: metadata.len(),
                file,
            };
            let replace = selected.as_ref().is_none_or(|current| {
                (
                    &candidate.modified,
                    &candidate.session_id,
                    &candidate.file_name,
                ) > (&current.modified, &current.session_id, &current.file_name)
            });
            if replace {
                selected = Some(candidate);
            }
        }
    }

    let Some(mut selected) = selected else {
        return Ok(None);
    };
    if selected.length > MAX_COMPANION_HTML_BYTES {
        return Err(CompanionError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(selected.length as usize);
    (&mut selected.file)
        .take(MAX_COMPANION_HTML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CompanionError::Internal("failed to read visual companion".into()))?;
    if bytes.len() as u64 > MAX_COMPANION_HTML_BYTES {
        return Err(CompanionError::TooLarge);
    }
    let html = String::from_utf8(bytes).map_err(|_| CompanionError::UnsupportedContent)?;
    let document_kind = classify_document(&html);
    let revision = document_revision(html.as_bytes());
    Ok(Some(CompanionDocument {
        session_id: selected.session_id,
        revision,
        document_kind,
        html,
    }))
}

fn classify_document(html: &str) -> CompanionDocumentKind {
    let beginning = html
        .trim_start()
        .chars()
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    if beginning.starts_with("<!doctype") || beginning.starts_with("<html") {
        CompanionDocumentKind::FullDocument
    } else {
        CompanionDocumentKind::Fragment
    }
}

fn document_revision(bytes: &[u8]) -> String {
    fn fnv1a(bytes: &[u8], seed: u64) -> u64 {
        bytes.iter().fold(seed, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }
    let first = fnv1a(bytes, 0xcbf2_9ce4_8422_2325);
    let second = fnv1a(bytes, 0x8422_2325_cbf2_9ce4);
    format!("fnv1a64:{:x}:{first:016x}{second:016x}", bytes.len())
}

#[cfg(unix)]
fn directory_names(
    directory: &std::os::fd::OwnedFd,
) -> Result<Vec<std::ffi::OsString>, CompanionError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;

    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(CompanionError::Internal(
            "failed to enumerate visual companions".into(),
        ));
    }
    // fdopendir takes ownership of the duplicated descriptor on success.
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe { libc::close(duplicate) };
        return Err(CompanionError::Internal(
            "failed to enumerate visual companions".into(),
        ));
    }
    let mut names = Vec::new();
    loop {
        // The stream stays valid until closed below; readdir's pointer is
        // consumed before the next call mutates the directory buffer.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes != b"." && bytes != b".." {
            names.push(std::ffi::OsString::from_vec(bytes.to_vec()));
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(names)
}

#[cfg(unix)]
fn open_optional_directory(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<Option<std::os::fd::OwnedFd>, CompanionError> {
    optional_openat(
        directory_fd,
        std::ffi::OsStr::new(name),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
}

#[cfg(unix)]
fn open_optional_regular_file(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
) -> Result<Option<std::fs::File>, CompanionError> {
    let Some(file) = optional_openat(
        directory_fd,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )?
    else {
        return Ok(None);
    };
    let file = std::fs::File::from(file);
    let metadata = file
        .metadata()
        .map_err(|_| CompanionError::Internal("failed to inspect visual companion".into()))?;
    Ok(metadata.is_file().then_some(file))
}

#[cfg(unix)]
fn optional_openat(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
    flags: libc::c_int,
) -> Result<Option<std::os::fd::OwnedFd>, CompanionError> {
    match openat_owned(directory_fd, name, flags, 0) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(code) if code == libc::ENOENT || code == libc::ENOTDIR || code == libc::ELOOP
            ) =>
        {
            Ok(None)
        }
        Err(_) => Err(CompanionError::Internal(
            "failed to access visual companion".into(),
        )),
    }
}

#[cfg(unix)]
fn regular_file_exists(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<bool, CompanionError> {
    Ok(open_optional_regular_file(directory_fd, std::ffi::OsStr::new(name))?.is_some())
}

#[cfg(unix)]
fn entry_exists(directory_fd: std::os::fd::RawFd, name: &str) -> Result<bool, CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(std::ffi::OsStr::new(name).as_bytes())
        .map_err(|_| CompanionError::Internal("invalid visual companion entry".into()))?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            directory_fd,
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(false)
    } else {
        Err(CompanionError::Internal(
            "failed to inspect visual companion state".into(),
        ))
    }
}

#[cfg(unix)]
fn openat_owned(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<std::os::fd::OwnedFd, std::io::Error> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let descriptor =
        unsafe { libc::openat(directory_fd, name.as_ptr(), flags, libc::c_uint::from(mode)) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use kanna_agent_protocol::{CompanionDocumentKind, CompanionEvent};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    struct CompanionFixture {
        db: Db,
        db_path: PathBuf,
        worktree: PathBuf,
        temp_dir: tempfile::TempDir,
    }

    impl CompanionFixture {
        fn new() -> Self {
            let temp_dir = tempfile::tempdir().expect("create companion fixture");
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
                "Show a visual companion",
                Some("Show a visual companion"),
                "in progress",
                "2026-07-17 10:00:00",
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
                db_path,
                worktree,
                temp_dir,
            }
        }

        fn db_path(&self) -> &str {
            self.db_path.to_str().expect("utf-8 database path")
        }

        fn session_path(&self, session_id: &str) -> PathBuf {
            self.worktree
                .join(".superpowers/brainstorm")
                .join(session_id)
        }

        fn write(&self, relative: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> PathBuf {
            let target = self.worktree.join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create fixture parent");
            }
            std::fs::write(&target, bytes).expect("write fixture file");
            target
        }

        fn activate(&self, session_id: &str, file_name: &str, html: &[u8]) -> PathBuf {
            self.write(
                format!(".superpowers/brainstorm/{session_id}/state/server-info"),
                b"{}",
            );
            self.write(
                format!(".superpowers/brainstorm/{session_id}/content/{file_name}"),
                html,
            )
        }

        fn event() -> CompanionEvent {
            CompanionEvent {
                event_id: "event-1".into(),
                event_type: "click".into(),
                choice: "a".into(),
                text: "Option A".into(),
                element_id: None,
                timestamp: 1_784_268_000_000,
            }
        }
    }

    #[test]
    fn returns_none_without_a_brainstorm_directory() {
        let fixture = CompanionFixture::new();
        assert_eq!(current_document(fixture.db_path(), "task-1").unwrap(), None);
    }

    #[test]
    fn reads_an_active_fragment_and_computes_a_stable_revision() {
        let fixture = CompanionFixture::new();
        fixture.activate("123-456", "layout.html", b"<h2>Choose</h2>");

        let first = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let second = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(first.session_id, "123-456");
        assert_eq!(first.html, "<h2>Choose</h2>");
        assert_eq!(first.document_kind, CompanionDocumentKind::Fragment);
        assert_eq!(first.revision, second.revision);
    }

    #[test]
    fn detects_a_complete_html_document() {
        let fixture = CompanionFixture::new();
        fixture.activate(
            "123-456",
            "layout.html",
            b"  <!DOCTYPE html><html><body>Choose</body></html>",
        );
        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(document.document_kind, CompanionDocumentKind::FullDocument);
    }

    #[test]
    fn chooses_the_newest_html_in_the_newest_active_session() {
        let fixture = CompanionFixture::new();
        fixture.activate("older", "first.html", b"older session");
        std::thread::sleep(Duration::from_millis(15));
        fixture.activate("newer", "first.html", b"first screen");
        std::thread::sleep(Duration::from_millis(15));
        fixture.activate("newer", "second.html", b"newest screen");

        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(document.session_id, "newer");
        assert_eq!(document.html, "newest screen");
    }

    #[test]
    fn ignores_stopped_or_incompletely_started_sessions() {
        let fixture = CompanionFixture::new();
        fixture.activate("stopped", "layout.html", b"stopped");
        fixture.write(
            ".superpowers/brainstorm/stopped/state/server-stopped",
            b"{}",
        );
        fixture.write(
            ".superpowers/brainstorm/missing-info/content/layout.html",
            b"not active",
        );
        assert_eq!(current_document(fixture.db_path(), "task-1").unwrap(), None);
    }

    #[test]
    fn rejects_invalid_or_oversized_html() {
        let fixture = CompanionFixture::new();
        fixture.activate("invalid", "layout.html", &[0xff, 0xfe]);
        assert_eq!(
            current_document(fixture.db_path(), "task-1"),
            Err(CompanionError::UnsupportedContent)
        );

        fixture.write(
            ".superpowers/brainstorm/invalid/state/server-stopped",
            b"{}",
        );
        fixture.activate(
            "large",
            "layout.html",
            &vec![b'x'; MAX_COMPANION_HTML_BYTES as usize + 1],
        );
        assert_eq!(
            current_document(fixture.db_path(), "task-1"),
            Err(CompanionError::TooLarge)
        );
    }

    #[test]
    fn reports_tasks_without_a_current_workspace() {
        let fixture = CompanionFixture::new();
        fixture
            .db
            .insert_test_pipeline_item(
                "task-2",
                "repo-1",
                "No workspace",
                None,
                "in progress",
                "2026-07-17 10:00:00",
            )
            .unwrap();
        assert_eq!(
            current_document(fixture.db_path(), "task-2"),
            Err(CompanionError::WorkspaceUnavailable)
        );
        assert_eq!(
            current_document(fixture.db_path(), "missing-task"),
            Err(CompanionError::TaskNotFound)
        );
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_content_or_session_symlinks() {
        let fixture = CompanionFixture::new();
        let outside_session = fixture.temp_dir.path().join("outside-session");
        std::fs::create_dir_all(outside_session.join("content")).unwrap();
        std::fs::create_dir_all(outside_session.join("state")).unwrap();
        std::fs::write(outside_session.join("content/secret.html"), "secret").unwrap();
        std::fs::write(outside_session.join("state/server-info"), "{}").unwrap();
        std::fs::create_dir_all(fixture.worktree.join(".superpowers/brainstorm")).unwrap();
        std::os::unix::fs::symlink(
            &outside_session,
            fixture
                .worktree
                .join(".superpowers/brainstorm/linked-session"),
        )
        .unwrap();

        fixture.write(
            ".superpowers/brainstorm/linked-content/state/server-info",
            b"{}",
        );
        std::fs::create_dir_all(fixture.session_path("linked-content").join("content")).unwrap();
        std::os::unix::fs::symlink(
            outside_session.join("content/secret.html"),
            fixture
                .session_path("linked-content")
                .join("content/layout.html"),
        )
        .unwrap();

        assert_eq!(current_document(fixture.db_path(), "task-1").unwrap(), None);
    }

    #[test]
    fn follows_the_database_workspace_replacement_not_the_old_path() {
        let fixture = CompanionFixture::new();
        fixture.activate("old", "layout.html", b"old companion");
        let replacement = fixture.temp_dir.path().join("replacement");
        std::fs::create_dir_all(&replacement).unwrap();
        fixture
            .db
            .upsert_worktree(
                "wt-task-1",
                "task-1",
                replacement.to_str().unwrap(),
                "replacement-branch",
            )
            .unwrap();
        assert_eq!(current_document(fixture.db_path(), "task-1").unwrap(), None);
    }

    #[test]
    fn appends_one_compatible_jsonl_event_after_authoritative_validation() {
        let fixture = CompanionFixture::new();
        fixture.activate(
            "123-456",
            "layout.html",
            b"<button data-choice='a'>A</button>",
        );
        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let event = CompanionFixture::event();

        append_event(
            fixture.db_path(),
            "task-1",
            &document.session_id,
            &document.revision,
            &event,
        )
        .unwrap();

        let line =
            std::fs::read_to_string(fixture.session_path("123-456").join("state/events")).unwrap();
        let value: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["type"], "click");
        assert_eq!(value["choice"], "a");
        assert_eq!(value["id"], serde_json::Value::Null);
        assert_eq!(value["event_id"], "event-1");
    }

    #[test]
    fn rejects_stale_session_or_revision() {
        let fixture = CompanionFixture::new();
        fixture.activate("123-456", "layout.html", b"screen");
        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let event = CompanionFixture::event();

        assert_eq!(
            append_event(
                fixture.db_path(),
                "task-1",
                "old-session",
                &document.revision,
                &event,
            ),
            Err(CompanionError::StaleRevision)
        );
        assert_eq!(
            append_event(
                fixture.db_path(),
                "task-1",
                &document.session_id,
                "old-revision",
                &event,
            ),
            Err(CompanionError::StaleRevision)
        );
    }

    #[test]
    fn rejects_invalid_or_oversized_events() {
        let fixture = CompanionFixture::new();
        fixture.activate("123-456", "layout.html", b"screen");
        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let mut cases = Vec::new();

        let mut wrong_type = CompanionFixture::event();
        wrong_type.event_type = "submit".into();
        cases.push(wrong_type);
        let mut empty_choice = CompanionFixture::event();
        empty_choice.choice.clear();
        cases.push(empty_choice);
        let mut choice = CompanionFixture::event();
        choice.choice = "x".repeat(257);
        cases.push(choice);
        let mut element_id = CompanionFixture::event();
        element_id.element_id = Some("x".repeat(257));
        cases.push(element_id);
        let mut text = CompanionFixture::event();
        text.text = "x".repeat(4097);
        cases.push(text);
        let mut event_id = CompanionFixture::event();
        event_id.event_id = "x".repeat(129);
        cases.push(event_id);
        let mut serialized = CompanionFixture::event();
        serialized.text = "\\".repeat(4096);
        cases.push(serialized);

        for event in cases {
            assert_eq!(
                append_event(
                    fixture.db_path(),
                    "task-1",
                    &document.session_id,
                    &document.revision,
                    &event,
                ),
                Err(CompanionError::InvalidEvent)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_event_target() {
        let fixture = CompanionFixture::new();
        fixture.activate("123-456", "layout.html", b"screen");
        let document = current_document(fixture.db_path(), "task-1")
            .unwrap()
            .unwrap();
        let outside = fixture.temp_dir.path().join("outside-events");
        std::fs::write(&outside, "untouched\n").unwrap();
        std::os::unix::fs::symlink(
            &outside,
            fixture.session_path("123-456").join("state/events"),
        )
        .unwrap();

        assert!(matches!(
            append_event(
                fixture.db_path(),
                "task-1",
                &document.session_id,
                &document.revision,
                &CompanionFixture::event(),
            ),
            Err(CompanionError::Internal(_))
        ));
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "untouched\n");
    }
}
