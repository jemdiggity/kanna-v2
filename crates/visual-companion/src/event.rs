use crate::discovery::CompanionError;
#[cfg(unix)]
use crate::discovery::{
    create_marker_file, discover_document_revision, is_normal_component, marker_directory_names,
    open_append_regular_file, open_companion_root, open_file_identity, open_optional_directory,
    open_optional_marker_file, open_optional_regular_file, open_or_create_directory,
    open_workspace, remove_marker_file, rename_marker_file,
};
use kanna_agent_protocol::CompanionEvent;
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MAX_COMPANION_EVENT_BYTES: usize = 8 * 1024;
const MAX_CHOICE_BYTES: usize = 256;
const MAX_ELEMENT_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_EVENT_ID_BYTES: usize = 128;
const MAX_EVENT_MARKER_BYTES: usize = MAX_COMPANION_EVENT_BYTES + 32;
#[cfg(unix)]
const EVENT_GENERATION_MARKER_PREFIX: &str = "events-generation-";
// Keep the durable identity journal comfortably inside both companion
// directory-enumeration ceilings (entry count and cumulative basename bytes).
pub(crate) const MAX_EVENT_IDENTITIES_PER_SESSION: usize = 2048;
#[cfg(unix)]
const EVENT_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(250);
#[cfg(unix)]
const EVENT_LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(2);

#[cfg(unix)]
fn lock_events(events: &std::fs::File) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;

    let deadline = std::time::Instant::now() + EVENT_LOCK_WAIT;
    loop {
        if unsafe { libc::flock(events.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock {
            return Err(CompanionError::Internal(
                "failed to lock visual companion events".into(),
            ));
        }
        if std::time::Instant::now() >= deadline {
            return Err(CompanionError::Internal(
                "timed out locking visual companion events".into(),
            ));
        }
        std::thread::sleep(EVENT_LOCK_RETRY);
    }
}

#[cfg(unix)]
fn unlock_events(events: &std::fs::File) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;

    if unsafe { libc::flock(events.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(CompanionError::Internal(
            "failed to unlock visual companion events".into(),
        ))
    }
}

#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum LegacyTailRepair {
    Intact,
    Truncate(u64),
    Oversized,
}

#[cfg(unix)]
fn inspect_legacy_event_log_tail(
    events: &mut (impl std::io::Read + std::io::Seek),
    file_len: u64,
) -> std::io::Result<LegacyTailRepair> {
    use std::io::SeekFrom;

    if file_len == 0 {
        return Ok(LegacyTailRepair::Intact);
    }
    let inspection_bytes = MAX_COMPANION_EVENT_BYTES + 1;
    let inspection_len = usize::try_from(file_len.min(inspection_bytes as u64))
        .expect("bounded event tail inspection length should fit usize");
    let inspection_start = file_len - inspection_len as u64;
    events.seek(SeekFrom::Start(inspection_start))?;
    let mut buffer = vec![0_u8; inspection_len];
    events.read_exact(&mut buffer)?;
    if buffer.last() == Some(&b'\n') {
        return Ok(LegacyTailRepair::Intact);
    }
    if let Some(index) = buffer.iter().rposition(|byte| *byte == b'\n') {
        return Ok(LegacyTailRepair::Truncate(
            inspection_start + index as u64 + 1,
        ));
    }
    if file_len <= MAX_COMPANION_EVENT_BYTES as u64 {
        Ok(LegacyTailRepair::Truncate(0))
    } else {
        Ok(LegacyTailRepair::Oversized)
    }
}

#[cfg(unix)]
fn repair_partial_legacy_event_log_tail(events: &mut std::fs::File) -> Result<(), CompanionError> {
    let file_len = events
        .metadata()
        .map_err(|_| CompanionError::Internal("failed to inspect visual companion events".into()))?
        .len();
    let repair = inspect_legacy_event_log_tail(events, file_len).map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion events".into())
    })?;
    let LegacyTailRepair::Truncate(complete_len) = repair else {
        return match repair {
            LegacyTailRepair::Intact => Ok(()),
            LegacyTailRepair::Oversized => Err(CompanionError::Internal(
                "visual companion events contains an oversized legacy tail".into(),
            )),
            LegacyTailRepair::Truncate(_) => unreachable!(),
        };
    };
    events
        .set_len(complete_len)
        .and_then(|_| events.sync_data())
        .map_err(|_| CompanionError::Internal("failed to repair visual companion events".into()))
}

#[cfg(unix)]
fn event_at_offset(
    events: &mut std::fs::File,
    offset: u64,
    candidate: &CompanionEvent,
) -> Result<bool, CompanionError> {
    use std::io::{Read, Seek, SeekFrom};

    let file_len = events
        .metadata()
        .map_err(|_| CompanionError::Internal("failed to inspect visual companion events".into()))?
        .len();
    if offset >= file_len {
        return Ok(false);
    }
    events
        .seek(SeekFrom::Start(offset))
        .map_err(|_| CompanionError::Internal("failed to recover visual companion event".into()))?;
    let mut byte = [0u8; 1];
    let mut line = Vec::with_capacity(MAX_COMPANION_EVENT_BYTES);
    loop {
        let read = events.read(&mut byte).map_err(|_| {
            CompanionError::Internal("failed to recover visual companion event".into())
        })?;
        if read == 0 {
            if line.is_empty() {
                return Ok(false);
            }
            return Err(CompanionError::Internal(
                "visual companion events contains an incomplete recovery record".into(),
            ));
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= MAX_COMPANION_EVENT_BYTES {
            return Err(CompanionError::Internal(
                "visual companion events contains an oversized recovery record".into(),
            ));
        }
        line.push(byte[0]);
    }
    let existing = serde_json::from_slice::<CompanionEvent>(&line).map_err(|_| {
        CompanionError::Internal(
            "visual companion events contains a corrupt recovery record".into(),
        )
    })?;
    if existing.session_id.is_empty()
        || existing.revision.is_empty()
        || validate_event(&existing).is_err()
    {
        return Err(CompanionError::Internal(
            "visual companion events contains a corrupt recovery record".into(),
        ));
    }
    if existing.event_id == candidate.event_id {
        if existing == *candidate {
            Ok(true)
        } else {
            Err(CompanionError::InvalidEvent)
        }
    } else {
        Ok(false)
    }
}

#[cfg(unix)]
pub(crate) fn marker_names(event_id: &str) -> (String, String) {
    let digest = Sha256::digest(event_id.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (format!("{hex}.pending"), format!("{hex}.committed"))
}

#[cfg(unix)]
fn read_marker(
    marker: &mut std::fs::File,
) -> Result<Option<(u64, CompanionEvent)>, CompanionError> {
    use std::io::{Read, Seek, SeekFrom};

    let length = marker
        .metadata()
        .map_err(|_| CompanionError::Internal("failed to inspect visual companion marker".into()))?
        .len() as usize;
    if length == 0 {
        return Ok(None);
    }
    if length > MAX_EVENT_MARKER_BYTES {
        return Ok(None);
    }
    marker
        .seek(SeekFrom::Start(0))
        .map_err(|_| CompanionError::Internal("failed to read visual companion marker".into()))?;
    let mut bytes = Vec::with_capacity(length);
    marker
        .take((MAX_EVENT_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| CompanionError::Internal("failed to read visual companion marker".into()))?;
    if bytes.len() != length || bytes.last() != Some(&b'\n') {
        return Ok(None);
    }
    bytes.pop();
    let Some(separator) = bytes.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    let Ok(offset_text) = std::str::from_utf8(&bytes[..separator]) else {
        return Ok(None);
    };
    let Ok(offset) = offset_text.parse::<u64>() else {
        return Ok(None);
    };
    let Ok(event) = serde_json::from_slice::<CompanionEvent>(&bytes[separator + 1..]) else {
        return Ok(None);
    };
    if event.session_id.is_empty() || event.revision.is_empty() || validate_event(&event).is_err() {
        return Ok(None);
    }
    Ok(Some((offset, event)))
}

#[cfg(unix)]
fn write_marker(
    marker: &std::fs::File,
    offset: u64,
    serialized: &[u8],
) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let metadata = marker.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion marker".into())
    })?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(CompanionError::Internal(
            "visual companion marker has an unsafe identity".into(),
        ));
    }
    if unsafe { libc::ftruncate(marker.as_raw_fd(), 0) } != 0 {
        return Err(CompanionError::Internal(
            "failed to reset visual companion marker".into(),
        ));
    }
    let offset = offset.to_string();
    let mut line = Vec::with_capacity(offset.len() + serialized.len() + 2);
    line.extend_from_slice(offset.as_bytes());
    line.push(b'\n');
    line.extend_from_slice(serialized);
    line.push(b'\n');
    let written = unsafe {
        libc::write(
            marker.as_raw_fd(),
            line.as_ptr().cast::<libc::c_void>(),
            line.len(),
        )
    };
    if written < 0 || written as usize != line.len() {
        return Err(CompanionError::Internal(
            "failed to write visual companion marker".into(),
        ));
    }
    marker
        .sync_data()
        .map_err(|_| CompanionError::Internal("failed to sync visual companion marker".into()))
}

#[cfg(unix)]
fn complete_pending_event(
    events: &mut std::fs::File,
    offset: u64,
    event: &CompanionEvent,
    serialized: &[u8],
) -> Result<(), CompanionError> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::fd::AsRawFd;

    let mut line = Vec::with_capacity(serialized.len() + 1);
    line.extend_from_slice(serialized);
    line.push(b'\n');
    let file_len = events
        .metadata()
        .map_err(|_| CompanionError::Internal("failed to inspect visual companion events".into()))?
        .len();
    if file_len < offset {
        return Err(CompanionError::Internal(
            "visual companion pending offset is beyond the event log".into(),
        ));
    }
    let available = (file_len - offset).min(line.len() as u64) as usize;
    if available > 0 {
        events.seek(SeekFrom::Start(offset)).map_err(|_| {
            CompanionError::Internal("failed to recover visual companion event".into())
        })?;
        let mut existing = vec![0u8; available];
        events.read_exact(&mut existing).map_err(|_| {
            CompanionError::Internal("failed to recover visual companion event".into())
        })?;
        if existing != line[..available] {
            if event_at_offset(events, offset, event)? {
                return Ok(());
            }
            return Err(CompanionError::Internal(
                "visual companion pending event conflicts with the event log".into(),
            ));
        }
    }
    if available < line.len() {
        // Pending marker recovery runs before every new append while holding
        // the event lock, so a matching prefix can only be this interrupted
        // single-write append. Complete its bounded suffix in place.
        if file_len != offset + available as u64 {
            return Err(CompanionError::Internal(
                "visual companion pending event is not at the log tail".into(),
            ));
        }
        let remaining = &line[available..];
        let written = unsafe {
            libc::write(
                events.as_raw_fd(),
                remaining.as_ptr().cast::<libc::c_void>(),
                remaining.len(),
            )
        };
        if written < 0 || written as usize != remaining.len() {
            return Err(CompanionError::Internal(
                "failed to recover visual companion event".into(),
            ));
        }
    }
    // This is also required when the prior process completed the record write
    // and died before syncing it. Never publish a committed marker until the
    // complete record is durable.
    events.sync_data().map_err(|_| {
        CompanionError::Internal("failed to sync recovered visual companion event".into())
    })?;
    Ok(())
}

#[cfg(unix)]
fn recover_pending_markers(
    events: &mut std::fs::File,
    markers: &std::os::fd::OwnedFd,
) -> Result<Vec<std::ffi::OsString>, CompanionError> {
    use std::os::fd::AsRawFd;

    let mut names = marker_directory_names(markers)?;
    let pending_names = names
        .iter()
        .filter_map(|name| name.to_str())
        .filter(|name| name.ends_with(".pending"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if pending_names.len() > 1 {
        return Err(CompanionError::Internal(
            "visual companion contains multiple pending events".into(),
        ));
    }
    if let Some(pending_name) = pending_names.first() {
        let mut marker =
            open_optional_marker_file(markers.as_raw_fd(), pending_name)?.ok_or_else(|| {
                CompanionError::Internal("visual companion pending marker disappeared".into())
            })?;
        let Some((offset, event)) = read_marker(&mut marker)? else {
            // Append cannot begin until the complete pending marker and its
            // directory entry are synced, so an incomplete marker is safe to
            // discard without touching the event log.
            drop(marker);
            remove_marker_file(markers.as_raw_fd(), pending_name)?;
            names.retain(|name| name.to_str() != Some(pending_name));
            return Ok(names);
        };
        let (expected_pending, committed_name) = marker_names(&event.event_id);
        if pending_name != &expected_pending {
            return Err(CompanionError::Internal(
                "visual companion pending marker hash collision".into(),
            ));
        }
        let serialized = validate_event(&event)?;
        complete_pending_event(events, offset, &event, &serialized)?;
        drop(marker);
        if let Some(mut committed) =
            open_optional_marker_file(markers.as_raw_fd(), &committed_name)?
        {
            let Some((committed_offset, committed_event)) = read_marker(&mut committed)? else {
                return Err(CompanionError::Internal(
                    "visual companion committed marker is corrupt".into(),
                ));
            };
            if committed_offset != offset || committed_event != event {
                return Err(CompanionError::Internal(
                    "visual companion pending marker conflicts with its committed marker".into(),
                ));
            }
            remove_marker_file(markers.as_raw_fd(), pending_name)?;
            names.retain(|name| name.to_str() != Some(pending_name));
            return Ok(names);
        }
        rename_marker_file(markers.as_raw_fd(), pending_name, &committed_name)?;
        names.retain(|name| name.to_str() != Some(pending_name));
        names.push(std::ffi::OsString::from(committed_name));
    }
    Ok(names)
}

#[cfg(unix)]
fn event_generation_marker_name(events: &std::fs::File) -> Result<String, CompanionError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = events.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion events".into())
    })?;
    Ok(format!(
        "{EVENT_GENERATION_MARKER_PREFIX}{:x}-{:x}",
        metadata.dev(),
        metadata.ino()
    ))
}

#[cfg(unix)]
fn is_event_identity_marker(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|name| name.ends_with(".pending") || name.ends_with(".committed"))
}

#[cfg(unix)]
fn clear_event_journal(
    markers: &std::os::fd::OwnedFd,
    names: &[std::ffi::OsString],
) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;

    for name in names {
        let Some(name) = name.to_str() else {
            return Err(CompanionError::Internal(
                "visual companion marker name is not valid UTF-8".into(),
            ));
        };
        let marker = open_optional_marker_file(markers.as_raw_fd(), name)?.ok_or_else(|| {
            CompanionError::Internal("visual companion marker disappeared".into())
        })?;
        drop(marker);
        remove_marker_file(markers.as_raw_fd(), name)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_event_generation_marker(
    markers: &std::os::fd::OwnedFd,
    name: &str,
) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;

    let marker = create_marker_file(markers.as_raw_fd(), name)?.ok_or_else(|| {
        CompanionError::Internal("visual companion event generation changed during creation".into())
    })?;
    marker.sync_data().map_err(|_| {
        CompanionError::Internal("failed to sync visual companion event generation".into())
    })?;
    drop(marker);
    sync_directory(markers.as_raw_fd())
}

#[cfg(unix)]
fn legacy_journal_matches_current_log(
    events: &mut std::fs::File,
    markers: &std::os::fd::OwnedFd,
    names: &[std::ffi::OsString],
    current_event: &CompanionEvent,
) -> Result<bool, CompanionError> {
    use std::os::fd::AsRawFd;

    for name in names.iter().filter(|name| is_event_identity_marker(name)) {
        let Some(name) = name.to_str() else {
            return Ok(false);
        };
        let mut marker =
            open_optional_marker_file(markers.as_raw_fd(), name)?.ok_or_else(|| {
                CompanionError::Internal("visual companion marker disappeared".into())
            })?;
        let Some((offset, marker_event)) = read_marker(&mut marker)? else {
            if name.ends_with(".pending") {
                continue;
            }
            return Err(CompanionError::Internal(
                "visual companion committed marker is corrupt".into(),
            ));
        };
        if marker_event.session_id != current_event.session_id
            || marker_event.revision != current_event.revision
        {
            return Ok(false);
        }
        if name.ends_with(".committed") {
            match event_at_offset(events, offset, &marker_event) {
                Ok(true) => {}
                Ok(false) | Err(CompanionError::InvalidEvent) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn reconcile_event_journal_generation(
    events: &mut std::fs::File,
    events_created: bool,
    markers: &std::os::fd::OwnedFd,
    current_event: &CompanionEvent,
) -> Result<(), CompanionError> {
    let mut names = marker_directory_names(markers)?;
    let expected_generation = event_generation_marker_name(events)?;
    let generations = names
        .iter()
        .filter_map(|name| name.to_str())
        .filter(|name| name.starts_with(EVENT_GENERATION_MARKER_PREFIX))
        .collect::<Vec<_>>();
    let generation_changed = generations.len() > 1
        || generations
            .first()
            .is_some_and(|name| *name != expected_generation);
    let legacy_mismatch = generations.is_empty()
        && !events_created
        && !legacy_journal_matches_current_log(events, markers, &names, current_event)?;
    if (events_created && generations.is_empty()) || generation_changed || legacy_mismatch {
        clear_event_journal(markers, &names)?;
        names.clear();
    }
    if names
        .iter()
        .all(|name| name.to_str() != Some(&expected_generation))
    {
        create_event_generation_marker(markers, &expected_generation)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory_fd: std::os::fd::RawFd) -> Result<(), CompanionError> {
    if unsafe { libc::fsync(directory_fd) } == 0 {
        Ok(())
    } else {
        Err(CompanionError::Internal(
            "failed to sync visual companion marker directory".into(),
        ))
    }
}

#[cfg(unix)]
fn authoritative_workspace_root(
    resolve_workspace: &mut impl FnMut() -> Result<PathBuf, CompanionError>,
) -> Result<std::os::fd::OwnedFd, CompanionError> {
    let workspace = match resolve_workspace() {
        Ok(workspace) => workspace,
        Err(CompanionError::TaskNotFound | CompanionError::WorkspaceUnavailable) => {
            return Err(CompanionError::StaleRevision);
        }
        Err(error) => return Err(error),
    };
    match open_workspace(&workspace) {
        Ok(root) => Ok(root),
        Err(CompanionError::TaskNotFound | CompanionError::WorkspaceUnavailable) => {
            Err(CompanionError::StaleRevision)
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn reopen_current_session_state(
    root: &std::os::fd::OwnedFd,
    session_id: &str,
    revision: &str,
) -> Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd), CompanionError> {
    use std::os::fd::AsRawFd;

    let current = discover_document_revision(root)?.ok_or(CompanionError::StaleRevision)?;
    if current.session_id != session_id || current.revision != revision {
        return Err(CompanionError::StaleRevision);
    }
    let brainstorm = open_companion_root(root)?.ok_or(CompanionError::StaleRevision)?;
    let session = open_optional_directory(brainstorm.as_raw_fd(), session_id)?
        .ok_or(CompanionError::StaleRevision)?;
    let state = open_optional_directory(session.as_raw_fd(), "state")?
        .ok_or(CompanionError::StaleRevision)?;
    let current = discover_document_revision(root)?.ok_or(CompanionError::StaleRevision)?;
    if current.session_id != session_id || current.revision != revision {
        return Err(CompanionError::StaleRevision);
    }
    Ok((session, state))
}

#[cfg(unix)]
fn revalidate_retained_session_state(
    retained_root: &std::os::fd::OwnedFd,
    retained_session: &std::os::fd::OwnedFd,
    retained_state: &std::os::fd::OwnedFd,
    authoritative_root: &std::os::fd::OwnedFd,
    session_id: &str,
    revision: &str,
) -> Result<std::os::fd::OwnedFd, CompanionError> {
    if open_file_identity(retained_root)? != open_file_identity(authoritative_root)? {
        return Err(CompanionError::StaleRevision);
    }
    let (authoritative_session, authoritative_state) =
        reopen_current_session_state(authoritative_root, session_id, revision)?;
    if open_file_identity(retained_session)? != open_file_identity(&authoritative_session)?
        || open_file_identity(retained_state)? != open_file_identity(&authoritative_state)?
    {
        return Err(CompanionError::StaleRevision);
    }
    Ok(authoritative_state)
}

#[cfg(unix)]
fn event_file_identity(events: &std::fs::File) -> Result<(u64, u64), CompanionError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = events.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion events".into())
    })?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn revalidate_retained_events(
    retained_events: &std::fs::File,
    authoritative_state: &std::os::fd::OwnedFd,
) -> Result<(), CompanionError> {
    use std::os::fd::AsRawFd;

    let authoritative_events = open_optional_regular_file(
        authoritative_state.as_raw_fd(),
        std::ffi::OsStr::new("events"),
    )?
    .ok_or(CompanionError::StaleRevision)?;
    if event_file_identity(retained_events)? != event_file_identity(&authoritative_events)? {
        return Err(CompanionError::StaleRevision);
    }
    Ok(())
}

pub fn append_event(
    workspace: &Path,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<(), CompanionError> {
    let workspace = workspace.to_path_buf();
    append_event_with_workspace_resolver(|| Ok(workspace.clone()), session_id, revision, event)
}

pub fn append_event_with_workspace_resolver(
    mut resolve_workspace: impl FnMut() -> Result<PathBuf, CompanionError>,
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
        let workspace = resolve_workspace()?;
        let root = open_workspace(&workspace)?;
        let current = discover_document_revision(&root)?.ok_or(CompanionError::StaleRevision)?;
        if current.session_id != session_id || current.revision != revision {
            return Err(CompanionError::StaleRevision);
        }
        if event.session_id != session_id || event.revision != revision {
            return Err(CompanionError::InvalidEvent);
        }

        let brainstorm = open_companion_root(&root)?.ok_or(CompanionError::StaleRevision)?;
        let session = open_optional_directory(brainstorm.as_raw_fd(), session_id)?
            .ok_or(CompanionError::StaleRevision)?;
        let state = open_optional_directory(session.as_raw_fd(), "state")?
            .ok_or(CompanionError::StaleRevision)?;
        let current = discover_document_revision(&root)?.ok_or(CompanionError::StaleRevision)?;
        if current.session_id != session_id || current.revision != revision {
            return Err(CompanionError::StaleRevision);
        }
        let authoritative_root = authoritative_workspace_root(&mut resolve_workspace)?;
        let authoritative_state = revalidate_retained_session_state(
            &root,
            &session,
            &state,
            &authoritative_root,
            session_id,
            revision,
        )?;
        let (mut events, events_created) = open_append_regular_file(state.as_raw_fd(), "events")?;
        lock_events(&events)?;
        let markers = open_or_create_directory(state.as_raw_fd(), "event-idempotency")?;
        reconcile_event_journal_generation(&mut events, events_created, &markers, event)?;
        let marker_entries = recover_pending_markers(&mut events, &markers)?;
        // Pending markers are authoritative recovery evidence and are repaired
        // above. Markerless logs predate the transaction journal, so preserve
        // their complete records while discarding only a crash-truncated tail.
        repair_partial_legacy_event_log_tail(&mut events)?;
        let (pending_name, committed_name) = marker_names(&event.event_id);
        if let Some(mut committed) =
            open_optional_marker_file(markers.as_raw_fd(), &committed_name)?
        {
            let Some((offset, existing)) = read_marker(&mut committed)? else {
                return Err(CompanionError::Internal(
                    "visual companion committed marker is corrupt".into(),
                ));
            };
            if existing.event_id != event.event_id {
                return Err(CompanionError::Internal(
                    "visual companion marker hash collision".into(),
                ));
            }
            if existing != *event {
                return Err(CompanionError::InvalidEvent);
            }
            if !event_at_offset(&mut events, offset, event)? {
                return Err(CompanionError::Internal(
                    "visual companion committed event is missing from the event log".into(),
                ));
            }
        } else {
            if marker_entries
                .iter()
                .filter(|name| is_event_identity_marker(name))
                .count()
                >= MAX_EVENT_IDENTITIES_PER_SESSION
            {
                return Err(CompanionError::Internal(
                    "visual companion event identity limit reached".into(),
                ));
            }
            let marker =
                create_marker_file(markers.as_raw_fd(), &pending_name)?.ok_or_else(|| {
                    CompanionError::Internal(
                        "visual companion marker changed during creation".into(),
                    )
                })?;
            let offset = events
                .metadata()
                .map_err(|_| {
                    CompanionError::Internal("failed to inspect visual companion events".into())
                })?
                .len();
            // The pending marker and its directory entry are durable before
            // append begins. A replacement process can therefore inspect the
            // exact intended offset without scanning historical events.
            write_marker(&marker, offset, &serialized)?;
            sync_directory(markers.as_raw_fd())?;
            let mut line = serialized.clone();
            line.push(b'\n');
            revalidate_retained_events(&events, &authoritative_state)?;
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
            events.sync_data().map_err(|_| {
                CompanionError::Internal("failed to sync visual companion event".into())
            })?;
            drop(marker);
            rename_marker_file(markers.as_raw_fd(), &pending_name, &committed_name)?;
        }
        unlock_events(&events)?;
        // The document is published independently from the append-only event
        // file. Revalidate after the single write so a revision that wins the
        // race is never acknowledged as accepting the old click. The durable
        // event itself carries the old identity, allowing readers to reject it.
        let authoritative_root = authoritative_workspace_root(&mut resolve_workspace)?;
        let authoritative_state = revalidate_retained_session_state(
            &root,
            &session,
            &state,
            &authoritative_root,
            &event.session_id,
            &event.revision,
        )?;
        revalidate_retained_events(&events, &authoritative_state)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (resolve_workspace, session_id, revision, serialized);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::time::{Duration, Instant};

    struct CountingReader {
        file: std::fs::File,
        bytes_read: usize,
    }

    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.file.read(buffer)?;
            self.bytes_read += read;
            Ok(read)
        }
    }

    impl Seek for CountingReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.file.seek(position)
        }
    }

    #[test]
    fn oversized_sparse_legacy_tail_inspection_has_bounded_reads_and_latency() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.set_len(64 * 1024 * 1024 * 1024).unwrap();
        let mut reader = CountingReader {
            file,
            bytes_read: 0,
        };

        let started = Instant::now();
        let repair = inspect_legacy_event_log_tail(&mut reader, 64 * 1024 * 1024 * 1024).unwrap();

        assert_eq!(repair, LegacyTailRepair::Oversized);
        assert_eq!(reader.bytes_read, MAX_COMPANION_EVENT_BYTES + 1);
        // `reader.bytes_read` above is the real proof that the read is
        // bounded; this only guards against a repair that walks the whole
        // 64 GiB sparse file, which costs minutes. An order-of-magnitude
        // ceiling keeps that signal without racing a loaded box.
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "bounded legacy repair took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn maximum_legal_partial_legacy_tail_keeps_its_preceding_record() {
        let mut bytes = b"complete\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', MAX_COMPANION_EVENT_BYTES));
        let mut reader = std::io::Cursor::new(bytes);
        let file_len = reader.get_ref().len() as u64;

        assert_eq!(
            inspect_legacy_event_log_tail(&mut reader, file_len).unwrap(),
            LegacyTailRepair::Truncate(b"complete\n".len() as u64)
        );
    }
}
