use flate2::read::GzDecoder;
use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_ARCHIVE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Claude keys a conversation transcript by the session's working directory:
/// `~/.claude/projects/<slug(cwd)>/<session-id>.jsonl`. The slug replaces every
/// character outside `[A-Za-z0-9]` with `-`.
///
/// Pinned empirically, not from folklore: across 481 real transcripts under
/// `~/.claude/projects/`, comparing each transcript's recorded `cwd` against the
/// directory it lives in, this rule matched every one — including `/`, `.` and
/// `_`. The slug is computed by Claude in JavaScript, whose `String.replace`
/// walks UTF-16 code units, so an astral character contributes two dashes.
pub fn claude_project_slug(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut slug = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else {
            for _ in 0..character.len_utf16() {
                slug.push('-');
            }
        }
    }
    slug
}

/// A process's working directory is always fully resolved by the kernel, so the
/// path Claude records — and therefore the slug — is the realpath. The
/// destination worktree does not exist yet when a transfer materializes its
/// transcript, so resolve the longest existing ancestor and re-append the rest.
pub fn resolve_session_cwd(path: &Path) -> PathBuf {
    let mut trailing = Vec::new();
    let mut candidate = path;
    loop {
        if let Ok(resolved) = candidate.canonicalize() {
            return trailing
                .iter()
                .rev()
                .fold(resolved, |resolved, component| resolved.join(component));
        }
        let Some(parent) = candidate.parent() else {
            return path.to_path_buf();
        };
        let Some(name) = candidate.file_name() else {
            return path.to_path_buf();
        };
        trailing.push(name.to_os_string());
        candidate = parent;
    }
}

fn is_session_uuid(value: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = value.split('-');
    for length in groups {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != length || !part.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

enum ArtifactDestination {
    File {
        directories: Vec<String>,
        filename: String,
    },
    Archive {
        directories: Vec<String>,
        session_id: String,
    },
}

/// The payload-declared shape of one transfer artifact, plus the one field the
/// payload may never carry: where the file lands. A Claude transcript is
/// cwd-keyed, so its destination is computed here from a receiver-supplied
/// worktree path — the sender never names a destination.
pub struct TransferArtifactContract<'a> {
    pub provider: &'a str,
    pub resume_session_id: &'a str,
    pub filename: &'a str,
    pub kind: &'a str,
    pub materialization: &'a str,
    pub destination_worktree_path: Option<&'a Path>,
}

pub fn materialize_transfer_artifact_at_home(
    home: &Path,
    source_path: &Path,
    contract: TransferArtifactContract<'_>,
) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let destination = validate_artifact_contract(&contract)?;
        let canonical_home = home
            .canonicalize()
            .map_err(|error| format!("failed to resolve transfer artifact home: {error}"))?;
        if !canonical_home.is_absolute() {
            return Err("transfer artifact home must be absolute".into());
        }
        let home_fd = openat_owned(
            libc::AT_FDCWD,
            canonical_home.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
        .map_err(|error| format!("failed to securely open transfer artifact home: {error}"))?;
        let source = open_regular_source(source_path)?;

        match destination {
            ArtifactDestination::File {
                directories,
                filename,
            } => {
                let destination_dir = open_or_create_directories(&home_fd, &directories)?;
                copy_regular_file_exclusive(&source, destination_dir.as_raw_fd(), &filename)
            }
            ArtifactDestination::Archive {
                directories,
                session_id,
            } => {
                let destination_dir = open_or_create_directories(&home_fd, &directories)?;
                if entry_exists(destination_dir.as_raw_fd(), OsStr::new(&session_id))? {
                    return Ok(false);
                }
                extract_archive_exclusive(
                    source,
                    destination_dir.as_raw_fd(),
                    &canonical_home,
                    &directories,
                    &session_id,
                )
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (home, source_path, contract);
        Err("secure transfer artifact materialization is unsupported on this platform".into())
    }
}

/// Where a Claude session's transcript lives for a session that ran in
/// `worktree_path`. Returns `None` when the file is absent so the caller keeps
/// the existing skip-and-continue staging shape.
pub struct LocatedClaudeTranscript {
    pub absolute_path: PathBuf,
    pub home_rel_path: String,
    pub filename: String,
}

pub fn locate_claude_transcript_at_home(
    home: &Path,
    worktree_path: &Path,
    session_id: &str,
) -> Result<Option<LocatedClaudeTranscript>, String> {
    if !is_session_uuid(session_id) {
        // Claude names transcripts by session uuid, so there is nothing to find
        // — not an error, just no transcript for this session.
        return Ok(None);
    }
    let slug = claude_project_slug(&resolve_session_cwd(worktree_path));
    validate_component(&slug, "Claude project slug")?;
    let filename = format!("{session_id}.jsonl");
    let home_rel_path = format!(".claude/projects/{slug}/{filename}");
    let absolute_path = home
        .join(".claude")
        .join("projects")
        .join(&slug)
        .join(&filename);
    match std::fs::symlink_metadata(&absolute_path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(LocatedClaudeTranscript {
            absolute_path,
            home_rel_path,
            filename,
        })),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect Claude transcript: {error}")),
    }
}

fn validate_component(value: &str, label: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || value.len() > 1024
        || value.contains('\0')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!("{label} must be one safe path component"));
    }
    Ok(())
}

fn validate_artifact_contract(
    contract: &TransferArtifactContract<'_>,
) -> Result<ArtifactDestination, String> {
    let TransferArtifactContract {
        provider,
        resume_session_id: session_id,
        filename,
        kind,
        materialization,
        destination_worktree_path,
    } = *contract;
    validate_component(session_id, "transfer resume session id")?;
    validate_component(filename, "transfer artifact filename")?;
    match provider {
        "claude" if kind == "session-transcript" && materialization == "copy-file" => {
            // Transcripts are cwd-keyed, so the sender cannot name where this
            // file must land — the destination worktree exists only here. The
            // slug is computed from a receiver-supplied path and never from
            // anything in the payload.
            if !is_session_uuid(session_id) {
                return Err("transfer resume session id is not a Claude session uuid".to_string());
            }
            if filename != format!("{session_id}.jsonl") {
                return Err(
                    "transfer artifact filename does not match the Claude transcript contract"
                        .to_string(),
                );
            }
            let worktree_path = destination_worktree_path.ok_or_else(|| {
                "Claude transcript materialization requires a destination worktree path".to_string()
            })?;
            if !worktree_path.is_absolute() {
                return Err("transfer destination worktree path must be absolute".into());
            }
            let slug = claude_project_slug(&resolve_session_cwd(worktree_path));
            validate_component(&slug, "transfer destination project slug")?;
            Ok(ArtifactDestination::File {
                directories: vec![".claude".into(), "projects".into(), slug],
                filename: filename.into(),
            })
        }
        "claude"
            if filename == "claude-session.tar.gz"
                && kind == "session-archive"
                && materialization == "extract-tar-gz" =>
        {
            Ok(ArtifactDestination::Archive {
                directories: vec![".claude".into(), "tasks".into()],
                session_id: session_id.into(),
            })
        }
        "copilot"
            if filename == "copilot-session.tar.gz"
                && kind == "session-archive"
                && materialization == "extract-tar-gz" =>
        {
            Ok(ArtifactDestination::Archive {
                directories: vec![".copilot".into(), "session-state".into()],
                session_id: session_id.into(),
            })
        }
        "codex" if kind == "session-rollout" && materialization == "copy-file" => {
            let suffix = format!("-{session_id}.jsonl");
            let date = filename
                .strip_prefix("rollout-")
                .and_then(|remainder| remainder.get(..10))
                .filter(|date| {
                    filename.as_bytes().get("rollout-".len() + 10) == Some(&b'T')
                        && filename.ends_with(&suffix)
                        && date.as_bytes().get(4) == Some(&b'-')
                        && date.as_bytes().get(7) == Some(&b'-')
                })
                .ok_or_else(|| {
                    "transfer artifact filename does not match the Codex rollout contract"
                        .to_string()
                })?;
            let year = &date[0..4];
            let month = &date[5..7];
            let day = &date[8..10];
            let valid_digits = [year, month, day]
                .iter()
                .all(|part| part.bytes().all(|byte| byte.is_ascii_digit()));
            let valid_date = valid_digits
                && month
                    .parse::<u8>()
                    .is_ok_and(|value| (1..=12).contains(&value))
                && day
                    .parse::<u8>()
                    .is_ok_and(|value| (1..=31).contains(&value));
            if !valid_date {
                return Err("transfer artifact filename has an invalid Codex rollout date".into());
            }
            Ok(ArtifactDestination::File {
                directories: vec![
                    ".codex".into(),
                    "sessions".into(),
                    year.into(),
                    month.into(),
                    day.into(),
                ],
                filename: filename.into(),
            })
        }
        "claude" | "copilot" | "codex" => {
            Err("transfer artifact metadata does not match the provider session contract".into())
        }
        _ => Err(format!(
            "transfer artifacts are unsupported for provider {provider}"
        )),
    }
}

#[cfg(unix)]
fn open_regular_source(path: &Path) -> Result<File, String> {
    let descriptor = openat_owned(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        0,
    )
    .map_err(|error| format!("failed to securely open transfer artifact: {error}"))?;
    let file = File::from(descriptor);
    let metadata = file
        .metadata()
        .map_err(|error| format!("failed to inspect transfer artifact: {error}"))?;
    if !metadata.is_file() {
        return Err("transfer artifact source is not a regular file".into());
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "transfer artifact exceeds the {} byte limit",
            MAX_ARCHIVE_BYTES
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_or_create_directories(root: &OwnedFd, components: &[String]) -> Result<OwnedFd, String> {
    let mut current = duplicate_fd(root.as_raw_fd())
        .map_err(|error| format!("failed to duplicate transfer home descriptor: {error}"))?;
    for component in components {
        validate_component(component, "transfer destination component")?;
        current = open_or_create_directory(current.as_raw_fd(), OsStr::new(component))?;
    }
    Ok(current)
}

#[cfg(unix)]
fn open_or_create_directory(parent: RawFd, name: &OsStr) -> Result<OwnedFd, String> {
    match openat_owned(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    ) {
        Ok(directory) => Ok(directory),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            let name = c_string(name)?;
            let created = unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) };
            if created != 0 {
                let create_error = std::io::Error::last_os_error();
                if create_error.raw_os_error() != Some(libc::EEXIST) {
                    return Err(format!(
                        "failed to create transfer destination directory: {create_error}"
                    ));
                }
            }
            openat_owned(
                parent,
                OsStr::from_bytes(name.as_bytes()),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0,
            )
            .map_err(|error| {
                format!("failed to securely open transfer destination directory: {error}")
            })
        }
        Err(error) => Err(format!(
            "transfer destination directory is not a safe directory: {error}"
        )),
    }
}

#[cfg(unix)]
fn entry_exists(parent: RawFd, name: &OsStr) -> Result<bool, String> {
    let name = c_string(name)?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent,
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
        Err(format!("failed to inspect transfer destination: {error}"))
    }
}

#[cfg(unix)]
fn copy_regular_file_exclusive(source: &File, parent: RawFd, name: &str) -> Result<bool, String> {
    cleanup_stale_copy_temps(parent, name)?;
    if entry_exists(parent, OsStr::new(name))? {
        return Ok(false);
    }
    let (temporary_name, mut destination) = create_private_temp_file(parent, name)?;
    let mut source = source
        .try_clone()
        .map_err(|error| format!("failed to clone transfer artifact descriptor: {error}"))?;
    let result = std::io::copy(&mut source, &mut destination)
        .and_then(|_| destination.flush())
        .and_then(|_| destination.sync_all())
        .map_err(|error| format!("failed to copy transfer artifact: {error}"));
    if result.is_err() {
        let _ = unlinkat(parent, OsStr::new(&temporary_name), 0);
        return result.map(|_| false);
    }
    drop(destination);

    match renameat_no_replace(
        parent,
        OsStr::new(&temporary_name),
        parent,
        OsStr::new(name),
    ) {
        Ok(()) => {
            sync_directory(parent)?;
            Ok(true)
        }
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            let _ = unlinkat(parent, OsStr::new(&temporary_name), 0);
            sync_directory(parent)?;
            Ok(false)
        }
        Err(error) => {
            let _ = unlinkat(parent, OsStr::new(&temporary_name), 0);
            Err(format!(
                "failed to publish transferred rollout atomically: {error}"
            ))
        }
    }
}

#[cfg(unix)]
fn create_private_temp_file(parent: RawFd, name: &str) -> Result<(String, File), String> {
    for _ in 0..100 {
        let candidate = format!(
            ".{name}.kanna-transfer-{}-{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        match openat_owned(
            parent,
            OsStr::new(&candidate),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        ) {
            Ok(descriptor) => return Ok((candidate, File::from(descriptor))),
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => {
                return Err(format!(
                    "failed to create private transfer destination file: {error}"
                ));
            }
        }
    }
    Err("failed to allocate a unique transfer destination file".into())
}

#[cfg(unix)]
fn cleanup_stale_copy_temps(parent: RawFd, name: &str) -> Result<(), String> {
    let prefix = format!(".{name}.kanna-transfer-");
    let suffix = ".tmp";
    let duplicate = duplicate_fd(parent)
        .map_err(|error| format!("failed to inspect transfer destination directory: {error}"))?;
    let raw = duplicate.into_raw_fd();
    let directory = unsafe { libc::fdopendir(raw) };
    if directory.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(raw);
        }
        return Err(format!(
            "failed to inspect transfer destination directory: {error}"
        ));
    }

    let mut stale = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(directory) };
        if entry.is_null() {
            break;
        }
        let entry_name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let Ok(entry_name) = entry_name.to_str() else {
            continue;
        };
        let Some(owner) = entry_name
            .strip_prefix(&prefix)
            .and_then(|value| value.strip_suffix(suffix))
            .and_then(|value| value.split_once('-').map(|(pid, _)| pid))
            .and_then(|pid| pid.parse::<libc::pid_t>().ok())
        else {
            continue;
        };
        if !process_is_alive(owner) {
            stale.push(entry_name.to_owned());
        }
    }
    unsafe {
        libc::closedir(directory);
    }
    for entry_name in stale {
        unlinkat(parent, OsStr::new(&entry_name), 0)
            .map_err(|error| format!("failed to clean stale transfer destination file: {error}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn process_is_alive(pid: libc::pid_t) -> bool {
    if pid <= 0 {
        return false;
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn sync_directory(parent: RawFd) -> Result<(), String> {
    File::from(
        duplicate_fd(parent)
            .map_err(|error| format!("failed to duplicate transfer destination: {error}"))?,
    )
    .sync_all()
    .map_err(|error| format!("failed to sync transfer destination directory: {error}"))
}

#[cfg(unix)]
fn extract_archive_exclusive(
    source: File,
    destination_parent: RawFd,
    canonical_home: &Path,
    destination_components: &[String],
    session_id: &str,
) -> Result<bool, String> {
    let (temporary_name, temporary_fd) = create_private_temp_directory(destination_parent)?;
    let temporary_path = destination_components
        .iter()
        .fold(canonical_home.to_path_buf(), |path, component| {
            path.join(component)
        })
        .join(&temporary_name);
    if let Err(error) = extract_validated_archive(source, &temporary_fd, session_id) {
        let _ = std::fs::remove_dir_all(&temporary_path);
        return Err(error);
    }

    match renameat_no_replace(
        temporary_fd.as_raw_fd(),
        OsStr::new(session_id),
        destination_parent,
        OsStr::new(session_id),
    ) {
        Ok(()) => {
            drop(temporary_fd);
            unlinkat(
                destination_parent,
                OsStr::new(&temporary_name),
                libc::AT_REMOVEDIR,
            )
            .map_err(|error| format!("failed to remove transfer extraction directory: {error}"))?;
            Ok(true)
        }
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            drop(temporary_fd);
            let _ = std::fs::remove_dir_all(&temporary_path);
            Ok(false)
        }
        Err(error) => {
            drop(temporary_fd);
            let _ = std::fs::remove_dir_all(&temporary_path);
            Err(format!(
                "failed to publish transferred session atomically: {error}"
            ))
        }
    }
}

#[cfg(unix)]
fn extract_validated_archive(
    source: File,
    temporary_root: &OwnedFd,
    session_id: &str,
) -> Result<(), String> {
    let decoder = GzDecoder::new(source);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("failed to read transfer archive: {error}"))?;
    let mut entry_count = 0usize;
    let mut expanded_bytes = 0u64;
    let mut saw_session_root = false;

    for entry in entries {
        entry_count = entry_count.saturating_add(1);
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "transfer archive exceeds the {} entry limit",
                MAX_ARCHIVE_ENTRIES
            ));
        }
        let mut entry =
            entry.map_err(|error| format!("failed to read transfer archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("transfer archive entry has an invalid path: {error}"))?;
        let components = path
            .components()
            .map(|component| match component {
                Component::Normal(value) => value
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "transfer archive path is not UTF-8".to_string()),
                _ => Err("transfer archive path contains traversal".to_string()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if components.first().map(String::as_str) != Some(session_id) {
            return Err("transfer archive entry is outside the expected session root".into());
        }
        saw_session_root = true;
        let relative = &components[1..];
        let entry_type = entry.header().entry_type();
        let entry_size = entry.size();
        if entry_type.is_dir() {
            if entry_size != 0 {
                return Err("transfer archive directory entry has a non-zero size".into());
            }
            let _ = open_or_create_directories(temporary_root, &components)?;
            continue;
        }
        if !entry_type.is_file() || relative.is_empty() {
            return Err("transfer archive contains a link or unsupported entry type".into());
        }
        expanded_bytes = expanded_bytes
            .checked_add(entry_size)
            .filter(|size| *size <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| {
                format!(
                    "transfer archive exceeds the {} expanded byte limit",
                    MAX_EXPANDED_BYTES
                )
            })?;
        let parent_components = &components[..components.len() - 1];
        let parent = open_or_create_directories(temporary_root, parent_components)?;
        let filename = components.last().expect("non-empty archive path");
        let mut output = openat_owned(
            parent.as_raw_fd(),
            OsStr::new(filename),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map(File::from)
        .map_err(|error| format!("failed to create transfer archive entry: {error}"))?;
        let copied = std::io::copy(&mut entry.by_ref().take(entry_size + 1), &mut output)
            .map_err(|error| format!("failed to extract transfer archive entry: {error}"))?;
        if copied != entry_size {
            return Err("transfer archive entry size changed during extraction".into());
        }
        output
            .flush()
            .map_err(|error| format!("failed to flush transfer archive entry: {error}"))?;
    }
    if !saw_session_root {
        return Err("transfer archive is empty".into());
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_temp_directory(parent: RawFd) -> Result<(String, OwnedFd), String> {
    for _ in 0..100 {
        let candidate = format!(
            ".kanna-transfer-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let name = c_string(OsStr::new(&candidate))?;
        if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } == 0 {
            let descriptor = openat_owned(
                parent,
                OsStr::new(&candidate),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0,
            )
            .map_err(|error| {
                format!("failed to securely open transfer extraction directory: {error}")
            })?;
            return Ok((candidate, descriptor));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(format!(
                "failed to create transfer extraction directory: {error}"
            ));
        }
    }
    Err("failed to allocate a unique transfer extraction directory".into())
}

#[cfg(unix)]
fn duplicate_fd(descriptor: RawFd) -> Result<OwnedFd, std::io::Error> {
    let duplicate = unsafe { libc::dup(descriptor) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

#[cfg(unix)]
fn c_string(name: &OsStr) -> Result<CString, String> {
    CString::new(name.as_bytes())
        .map_err(|_| "transfer destination contains a null byte".to_string())
}

#[cfg(unix)]
fn openat_owned(
    parent: RawFd,
    name: &OsStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<OwnedFd, std::io::Error> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let descriptor =
        unsafe { libc::openat(parent, name.as_ptr(), flags, libc::c_uint::from(mode)) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn unlinkat(parent: RawFd, name: &OsStr, flags: libc::c_int) -> Result<(), std::io::Error> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if unsafe { libc::unlinkat(parent, name.as_ptr(), flags) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn renameat_no_replace(
    source_parent: RawFd,
    source: &OsStr,
    destination_parent: RawFd,
    destination: &OsStr,
) -> Result<(), std::io::Error> {
    let source = CString::new(source.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if unsafe {
        libc::renameatx_np(
            source_parent,
            source.as_ptr(),
            destination_parent,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn renameat_no_replace(
    source_parent: RawFd,
    source: &OsStr,
    destination_parent: RawFd,
    destination: &OsStr,
) -> Result<(), std::io::Error> {
    let source = CString::new(source.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent,
            source.as_ptr(),
            destination_parent,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn renameat_no_replace(
    _source_parent: RawFd,
    _source: &OsStr,
    _destination_parent: RawFd,
    _destination: &OsStr,
) -> Result<(), std::io::Error> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

#[cfg(test)]
mod tests {
    use super::{
        claude_project_slug, locate_claude_transcript_at_home,
        materialize_transfer_artifact_at_home, TransferArtifactContract,
    };
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tar::{Builder, EntryType, Header};

    const CLAUDE_SESSION: &str = "364643cc-5e6d-48fc-86ca-ca7764380900";
    const CODEX_SESSION: &str = "019d9a8c-9f39-7240-818f-88367a7c31df";
    const CODEX_FILENAME: &str =
        "rollout-2026-04-18T06-27-04-019d9a8c-9f39-7240-818f-88367a7c31df.jsonl";
    static TEST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kanna-transfer-artifact-test-{}-{unique}-{}",
                std::process::id(),
                TEST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&path).expect("create temp directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn archive_with_entry(path: &Path, entry_path: &str, entry_type: EntryType, body: &[u8]) {
        let file = std::fs::File::create(path).expect("create archive");
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = Builder::new(encoder);
        let mut header = Header::new_gnu();
        header.set_entry_type(entry_type);
        header.set_mode(0o600);
        header.set_size(body.len() as u64);
        header.set_path(entry_path).expect("set entry path");
        header.set_cksum();
        archive.append(&header, body).expect("append archive entry");
        archive
            .into_inner()
            .expect("finish tar")
            .finish()
            .expect("finish gzip");
    }

    fn claude_archive(path: &Path) {
        archive_with_entry(
            path,
            &format!("{CLAUDE_SESSION}/state.json"),
            EntryType::Regular,
            br#"{"ok":true}"#,
        );
    }

    #[test]
    fn imports_a_valid_provider_archive_under_the_derived_session_path() {
        let fixture = TempDir::new();
        let archive = fixture.path().join("claude.tar.gz");
        claude_archive(&archive);

        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &archive,
                TransferArtifactContract {
                    provider: "claude",
                    resume_session_id: CLAUDE_SESSION,
                    filename: "claude-session.tar.gz",
                    kind: "session-archive",
                    materialization: "extract-tar-gz",
                    destination_worktree_path: None,
                },
            ),
            Ok(true),
        );
        assert_eq!(
            std::fs::read(
                fixture
                    .path()
                    .join(".claude/tasks")
                    .join(CLAUDE_SESSION)
                    .join("state.json")
            )
            .expect("read imported state"),
            br#"{"ok":true}"#,
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_provider_root_without_writing_outside_home() {
        use std::os::unix::fs::symlink;

        let fixture = TempDir::new();
        let outside = TempDir::new();
        std::fs::create_dir(fixture.path().join(".claude")).expect("create provider parent");
        symlink(outside.path(), fixture.path().join(".claude/tasks")).expect("create root symlink");
        let archive = fixture.path().join("claude.tar.gz");
        claude_archive(&archive);

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &archive,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: CLAUDE_SESSION,
                filename: "claude-session.tar.gz",
                kind: "session-archive",
                materialization: "extract-tar-gz",
                destination_worktree_path: None,
            },
        )
        .is_err());
        assert!(!outside.path().join(CLAUDE_SESSION).exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_codex_date_directory() {
        use std::os::unix::fs::symlink;

        let fixture = TempDir::new();
        let outside = TempDir::new();
        let month = fixture.path().join(".codex/sessions/2026/04");
        std::fs::create_dir_all(&month).expect("create codex month");
        symlink(outside.path(), month.join("18")).expect("create date symlink");
        let rollout = fixture.path().join("rollout.jsonl");
        std::fs::write(&rollout, b"rollout").expect("write rollout");

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &rollout,
            TransferArtifactContract {
                provider: "codex",
                resume_session_id: CODEX_SESSION,
                filename: CODEX_FILENAME,
                kind: "session-rollout",
                materialization: "copy-file",
                destination_worktree_path: None,
            },
        )
        .is_err());
        assert!(!outside.path().join(CODEX_FILENAME).exists());
    }

    #[test]
    fn retries_an_interrupted_codex_copy_without_publishing_partial_state() {
        let fixture = TempDir::new();
        let rollout = fixture.path().join("rollout.jsonl");
        let expected = b"{\"type\":\"session_meta\"}\n{\"type\":\"response_item\"}\n";
        std::fs::write(&rollout, expected).expect("write rollout");
        let destination_dir = fixture.path().join(".codex/sessions/2026/04/18");
        std::fs::create_dir_all(&destination_dir).expect("create codex destination");
        let stale_temp =
            destination_dir.join(format!(".{CODEX_FILENAME}.kanna-transfer-2147483647-1.tmp"));
        std::fs::write(&stale_temp, &expected[..8]).expect("write interrupted partial copy");

        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &rollout,
                TransferArtifactContract {
                    provider: "codex",
                    resume_session_id: CODEX_SESSION,
                    filename: CODEX_FILENAME,
                    kind: "session-rollout",
                    materialization: "copy-file",
                    destination_worktree_path: None,
                },
            ),
            Ok(true),
        );
        assert_eq!(
            std::fs::read(destination_dir.join(CODEX_FILENAME)).expect("read published rollout"),
            expected,
        );
        assert!(!stale_temp.exists(), "stale private temp should be cleaned");
        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &rollout,
                TransferArtifactContract {
                    provider: "codex",
                    resume_session_id: CODEX_SESSION,
                    filename: CODEX_FILENAME,
                    kind: "session-rollout",
                    materialization: "copy-file",
                    destination_worktree_path: None,
                },
            ),
            Ok(false),
        );
        assert_eq!(
            std::fs::read(destination_dir.join(CODEX_FILENAME)).expect("read retried rollout"),
            expected,
        );
    }

    #[test]
    fn rejects_an_archive_outside_the_expected_session_root() {
        let fixture = TempDir::new();
        let archive = fixture.path().join("wrong-root.tar.gz");
        archive_with_entry(
            &archive,
            "other-session/state.json",
            EntryType::Regular,
            b"owned",
        );

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &archive,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: CLAUDE_SESSION,
                filename: "claude-session.tar.gz",
                kind: "session-archive",
                materialization: "extract-tar-gz",
                destination_worktree_path: None,
            },
        )
        .is_err());
        assert!(!fixture.path().join(".claude/tasks/other-session").exists());
    }

    #[test]
    fn rejects_archive_symlink_entries() {
        let fixture = TempDir::new();
        let archive = fixture.path().join("link.tar.gz");
        archive_with_entry(
            &archive,
            &format!("{CLAUDE_SESSION}/escape"),
            EntryType::Symlink,
            b"../../outside",
        );

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &archive,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: CLAUDE_SESSION,
                filename: "claude-session.tar.gz",
                kind: "session-archive",
                materialization: "extract-tar-gz",
                destination_worktree_path: None,
            },
        )
        .is_err());
        assert!(!fixture
            .path()
            .join(".claude/tasks")
            .join(CLAUDE_SESSION)
            .exists());
    }

    #[test]
    fn leaves_an_existing_derived_destination_untouched() {
        let fixture = TempDir::new();
        let destination = fixture.path().join(".claude/tasks").join(CLAUDE_SESSION);
        std::fs::create_dir_all(&destination).expect("create existing destination");
        std::fs::write(destination.join("keep"), b"original").expect("write existing state");
        let archive = fixture.path().join("claude.tar.gz");
        claude_archive(&archive);

        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &archive,
                TransferArtifactContract {
                    provider: "claude",
                    resume_session_id: CLAUDE_SESSION,
                    filename: "claude-session.tar.gz",
                    kind: "session-archive",
                    materialization: "extract-tar-gz",
                    destination_worktree_path: None,
                },
            ),
            Ok(false),
        );
        assert_eq!(
            std::fs::read(destination.join("keep")).expect("read existing state"),
            b"original",
        );
    }

    // --- Claude conversation transcripts ------------------------------------
    //
    // Transcripts are cwd-keyed, so the destination directory is computed here
    // from a receiver-supplied worktree path. The sender never names it.

    const TRANSCRIPT: &[u8] = b"{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n";

    fn transcript_filename() -> String {
        format!("{CLAUDE_SESSION}.jsonl")
    }

    fn write_transcript(path: &Path) {
        std::fs::write(path, TRANSCRIPT).expect("write transcript");
    }

    #[test]
    fn derives_the_claude_project_slug_by_replacing_every_non_alphanumeric_character() {
        // Pinned against real `~/.claude/projects/` directories: `/`, `.` and
        // `_` all collapse to `-`, and case is preserved.
        assert_eq!(
            claude_project_slug(Path::new("/Users/x/.kanna/repos/kanna-7")),
            "-Users-x--kanna-repos-kanna-7",
        );
        assert_eq!(
            claude_project_slug(Path::new("/private/tmp/probe/wt/a.b_c")),
            "-private-tmp-probe-wt-a-b-c",
        );
        assert_eq!(
            claude_project_slug(Path::new("/tmp/kanna-test-CSEH7S")),
            "-tmp-kanna-test-CSEH7S",
        );
        assert_eq!(claude_project_slug(Path::new("/a b/c+d")), "-a-b-c-d");
    }

    #[test]
    fn resolves_the_session_cwd_through_symlinked_and_missing_ancestors() {
        let fixture = TempDir::new();
        let repo = fixture.path().join("repo");
        std::fs::create_dir(&repo).expect("create repo");
        let canonical_repo = repo.canonicalize().expect("canonicalize repo");
        // The destination worktree does not exist yet at materialization time.
        let worktree = repo.join(".kanna-worktrees").join("task-abc");

        assert_eq!(
            super::resolve_session_cwd(&worktree),
            canonical_repo.join(".kanna-worktrees").join("task-abc"),
        );
    }

    #[test]
    fn imports_a_claude_transcript_under_the_receiver_derived_slug() {
        let fixture = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-dest");
        std::fs::create_dir_all(&worktree).expect("create destination worktree");
        let slug = claude_project_slug(&worktree.canonicalize().expect("canonicalize worktree"));

        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &source,
                TransferArtifactContract {
                    provider: "claude",
                    resume_session_id: CLAUDE_SESSION,
                    filename: &transcript_filename(),
                    kind: "session-transcript",
                    materialization: "copy-file",
                    destination_worktree_path: Some(&worktree),
                },
            ),
            Ok(true),
        );
        assert_eq!(
            std::fs::read(
                fixture
                    .path()
                    .join(".claude/projects")
                    .join(&slug)
                    .join(transcript_filename())
            )
            .expect("read imported transcript"),
            TRANSCRIPT,
        );
    }

    #[test]
    fn rejects_a_claude_transcript_without_a_receiver_supplied_destination() {
        let fixture = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &source,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: CLAUDE_SESSION,
                filename: &transcript_filename(),
                kind: "session-transcript",
                materialization: "copy-file",
                destination_worktree_path: None,
            },
        )
        .is_err());
        assert!(!fixture.path().join(".claude/projects").exists());
    }

    #[test]
    fn rejects_a_claude_transcript_filename_that_is_not_the_validated_session_id() {
        let fixture = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-dest");
        std::fs::create_dir_all(&worktree).expect("create destination worktree");

        for filename in [
            "019d9a8c-9f39-7240-818f-88367a7c31df.jsonl",
            "364643cc-5e6d-48fc-86ca-ca7764380900.json",
            "transcript.jsonl",
        ] {
            assert!(
                materialize_transfer_artifact_at_home(
                    fixture.path(),
                    &source,
                    TransferArtifactContract {
                        provider: "claude",
                        resume_session_id: CLAUDE_SESSION,
                        filename,
                        kind: "session-transcript",
                        materialization: "copy-file",
                        destination_worktree_path: Some(&worktree),
                    },
                )
                .is_err(),
                "expected {filename} to be rejected",
            );
        }
    }

    #[test]
    fn rejects_a_claude_transcript_whose_session_id_is_not_a_uuid() {
        let fixture = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-dest");
        std::fs::create_dir_all(&worktree).expect("create destination worktree");

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &source,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: "resume-fenced",
                filename: "resume-fenced.jsonl",
                kind: "session-transcript",
                materialization: "copy-file",
                destination_worktree_path: Some(&worktree),
            },
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_claude_projects_slug_directory_without_writing_outside_home() {
        use std::os::unix::fs::symlink;

        let fixture = TempDir::new();
        let outside = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-dest");
        std::fs::create_dir_all(&worktree).expect("create destination worktree");
        let slug = claude_project_slug(&worktree.canonicalize().expect("canonicalize worktree"));
        std::fs::create_dir_all(fixture.path().join(".claude/projects"))
            .expect("create projects root");
        symlink(
            outside.path(),
            fixture.path().join(".claude/projects").join(&slug),
        )
        .expect("create slug symlink");

        assert!(materialize_transfer_artifact_at_home(
            fixture.path(),
            &source,
            TransferArtifactContract {
                provider: "claude",
                resume_session_id: CLAUDE_SESSION,
                filename: &transcript_filename(),
                kind: "session-transcript",
                materialization: "copy-file",
                destination_worktree_path: Some(&worktree),
            },
        )
        .is_err());
        assert!(!outside.path().join(transcript_filename()).exists());
    }

    #[test]
    fn leaves_an_existing_claude_transcript_untouched() {
        let fixture = TempDir::new();
        let source = fixture.path().join("source.jsonl");
        write_transcript(&source);
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-dest");
        std::fs::create_dir_all(&worktree).expect("create destination worktree");
        let slug = claude_project_slug(&worktree.canonicalize().expect("canonicalize worktree"));
        let destination = fixture.path().join(".claude/projects").join(&slug);
        std::fs::create_dir_all(&destination).expect("create existing destination");
        std::fs::write(destination.join(transcript_filename()), b"original")
            .expect("write existing transcript");

        assert_eq!(
            materialize_transfer_artifact_at_home(
                fixture.path(),
                &source,
                TransferArtifactContract {
                    provider: "claude",
                    resume_session_id: CLAUDE_SESSION,
                    filename: &transcript_filename(),
                    kind: "session-transcript",
                    materialization: "copy-file",
                    destination_worktree_path: Some(&worktree),
                },
            ),
            Ok(false),
        );
        assert_eq!(
            std::fs::read(destination.join(transcript_filename())).expect("read existing"),
            b"original",
        );
    }

    #[test]
    fn locates_a_claude_transcript_under_the_source_worktree_slug() {
        let fixture = TempDir::new();
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-source");
        std::fs::create_dir_all(&worktree).expect("create source worktree");
        let slug = claude_project_slug(&worktree.canonicalize().expect("canonicalize worktree"));
        let transcript_dir = fixture.path().join(".claude/projects").join(&slug);
        std::fs::create_dir_all(&transcript_dir).expect("create transcript directory");
        write_transcript(&transcript_dir.join(transcript_filename()));

        let located = locate_claude_transcript_at_home(fixture.path(), &worktree, CLAUDE_SESSION)
            .expect("locate transcript")
            .expect("transcript is present");
        assert_eq!(
            located.absolute_path,
            transcript_dir.join(transcript_filename())
        );
        assert_eq!(
            located.home_rel_path,
            format!(".claude/projects/{slug}/{}", transcript_filename()),
        );
        assert_eq!(located.filename, transcript_filename());
    }

    #[test]
    fn reports_a_missing_claude_transcript_without_failing() {
        let fixture = TempDir::new();
        let worktree = fixture.path().join("repo/.kanna-worktrees/task-source");
        std::fs::create_dir_all(&worktree).expect("create source worktree");

        assert!(
            locate_claude_transcript_at_home(fixture.path(), &worktree, CLAUDE_SESSION)
                .expect("locate transcript")
                .is_none()
        );
        // A legacy non-uuid session id has no transcript to find; it must not
        // fail the lookup and cost the session archive its place in the payload.
        assert!(
            locate_claude_transcript_at_home(fixture.path(), &worktree, "resume-fenced")
                .expect("locate transcript")
                .is_none()
        );
    }
}
