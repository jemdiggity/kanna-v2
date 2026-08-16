use super::events::RuntimeError;
use super::state::{OutgoingTransferReservation, StoredIdentity, TransferArtifactRecord};
use crate::crypto::TransferIdentity;
use crate::peer_store::PeerStore;
use crate::protocol::{PeerResponse, PeerTerminalEvent};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub(super) use crate::protocol::CURRENT_PROTOCOL_VERSION;
pub(super) const AUTHENTICATED_TASK_REQUEST_PROTOCOL_VERSION: u32 = 2;
pub(super) const AUTHENTICATED_TASK_REQUEST_VERSION: u32 = 1;
pub(super) const STREAMED_ARTIFACT_PROTOCOL_VERSION: u32 = 3;
pub(super) const DUPLEX_TERMINAL_PROTOCOL_VERSION: u32 = 4;
pub(super) const TERMINAL_INPUT_SEMANTICS_PROTOCOL_VERSION: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ArtifactFraming {
    LegacySealedV1,
    StreamedV3,
}

impl ArtifactFraming {
    pub(super) fn for_protocol(protocol_version: u32) -> Self {
        if supports_streamed_artifacts(protocol_version) {
            Self::StreamedV3
        } else {
            Self::LegacySealedV1
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::LegacySealedV1 => "legacy_sealed_v1",
            Self::StreamedV3 => "streamed_v3",
        }
    }

    pub(super) fn parse(name: &str) -> Result<Self, RuntimeError> {
        match name {
            "legacy_sealed_v1" => Ok(Self::LegacySealedV1),
            "streamed_v3" => Ok(Self::StreamedV3),
            other => Err(RuntimeError::Protocol(format!(
                "unsupported artifact framing {other}",
            ))),
        }
    }

    pub(super) fn is_streamed(self) -> bool {
        matches!(self, Self::StreamedV3)
    }

    pub(super) fn allows_authenticated_request(self, requested: Self) -> bool {
        self == requested || matches!((self, requested), (Self::LegacySealedV1, Self::StreamedV3))
    }
}

pub(super) fn parse_peer_response_line(
    peer_id: &str,
    operation: &str,
    line: &str,
) -> Result<PeerResponse, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty response for {operation}"
        )));
    }

    serde_json::from_str::<PeerResponse>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON response for {operation}: {error}"
        ))
    })
}

pub(super) fn parse_peer_terminal_event_line(
    peer_id: &str,
    session_id: &str,
    line: &str,
) -> Result<PeerTerminalEvent, RuntimeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::Protocol(format!(
            "peer {peer_id} returned an empty terminal event for session {session_id}"
        )));
    }

    serde_json::from_str::<PeerTerminalEvent>(trimmed).map_err(|error| {
        RuntimeError::Protocol(format!(
            "peer {peer_id} returned a non-JSON terminal event for session {session_id}: {error}"
        ))
    })
}

pub(super) fn terminal_observer_key(peer_id: &str, session_id: &str) -> String {
    format!("{peer_id}:{session_id}")
}

pub(super) fn peer_terminal_event_session_id(event: &PeerTerminalEvent) -> &str {
    match event {
        PeerTerminalEvent::Snapshot { session_id, .. }
        | PeerTerminalEvent::Output { session_id, .. }
        | PeerTerminalEvent::Exit { session_id, .. }
        | PeerTerminalEvent::Error { session_id, .. } => session_id,
    }
}

pub(super) fn extract_request_id(line: &str) -> String {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

pub(super) async fn write_json_line<W, T>(stream: &mut W, value: &T) -> Result<(), RuntimeError>
where
    W: tokio::io::AsyncWrite + Unpin,
    T: serde::Serialize,
{
    let encoded = serde_json::to_vec(value)?;
    stream.write_all(&encoded).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

pub(super) async fn write_bounded_legacy_json_line<T>(
    stream: &mut TcpStream,
    value: &T,
    retained_capacity_bytes: usize,
) -> Result<(), RuntimeError>
where
    T: serde::Serialize,
{
    let encoded = serde_json::to_vec(value)?;
    let wire_bytes = encoded
        .len()
        .checked_add(1)
        .ok_or_else(|| RuntimeError::Protocol("legacy artifact response size overflow".into()))?;
    if wire_bytes > super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES {
        return Err(RuntimeError::Protocol(format!(
            "legacy artifact response exceeds maximum size of {} bytes",
            super::MAX_LEGACY_ARTIFACT_RESPONSE_BYTES,
        )));
    }
    super::ensure_legacy_artifact_allocation_capacity(
        &[retained_capacity_bytes, encoded.capacity()],
        super::LEGACY_ARTIFACT_ALLOCATION_BUDGET_BYTES,
    )?;
    stream.write_all(&encoded).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

pub(super) async fn read_bounded_line<R>(
    reader: &mut R,
    max_bytes: usize,
    description: &str,
) -> Result<Option<String>, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    read_bounded_line_with_prefix_extension(reader, max_bytes, None, description).await
}

pub(super) async fn read_bounded_line_with_prefix_extension<R>(
    reader: &mut R,
    max_bytes: usize,
    prefix_extension: Option<(&[u8], usize)>,
    description: &str,
) -> Result<Option<String>, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let prefix_limits = prefix_extension.into_iter().collect::<Vec<_>>();
    read_bounded_line_with_prefix_limits(reader, max_bytes, &prefix_limits, description).await
}

pub(super) async fn read_bounded_line_with_prefix_limits<R>(
    reader: &mut R,
    max_bytes: usize,
    prefix_limits: &[(&[u8], usize)],
    description: &str,
) -> Result<Option<String>, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(max_bytes.min(8 * 1024));
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(RuntimeError::Protocol(format!(
                "{description} is missing newline"
            )));
        }
        let active_max_bytes = prefix_limits
            .iter()
            .find(|(prefix, _)| {
                line.starts_with(prefix) || (line.is_empty() && available.starts_with(prefix))
            })
            .map_or(max_bytes, |(_, limit)| *limit);
        let max_wire_bytes = active_max_bytes.saturating_add(1);
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len().saturating_add(newline) > max_wire_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "{description} exceeds {active_max_bytes} bytes"
                )));
            }
            line.reserve_exact(newline);
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.len() > active_max_bytes {
                return Err(RuntimeError::Protocol(format!(
                    "{description} exceeds {active_max_bytes} bytes"
                )));
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| RuntimeError::Protocol(format!("{description} is not valid UTF-8")));
        }
        if line.len().saturating_add(available.len()) > max_wire_bytes {
            return Err(RuntimeError::Protocol(format!(
                "{description} exceeds {active_max_bytes} bytes"
            )));
        }
        line.reserve_exact(available.len());
        line.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

pub(super) async fn read_bounded_json_line_with_type_limits<R>(
    reader: &mut R,
    unclassified_max_bytes: usize,
    classified_max_bytes: usize,
    type_limits: &[(&str, usize)],
    description: &str,
) -> Result<Option<String>, RuntimeError>
where
    R: AsyncBufRead + Unpin,
{
    let absolute_max_bytes = type_limits
        .iter()
        .map(|(_, limit)| *limit)
        .chain(std::iter::once(classified_max_bytes))
        .max()
        .unwrap_or(classified_max_bytes);
    let mut line = Vec::with_capacity(unclassified_max_bytes.min(8 * 1024));
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err(RuntimeError::Protocol(format!(
                "{description} is missing newline"
            )));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.unwrap_or(available.len());
        if line.len().saturating_add(consumed) > absolute_max_bytes.saturating_add(1) {
            return Err(RuntimeError::Protocol(format!(
                "{description} exceeds {absolute_max_bytes} bytes"
            )));
        }
        line.reserve_exact(consumed);
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed + usize::from(newline.is_some()));
        let active_max_bytes =
            top_level_json_type(&line).map_or(unclassified_max_bytes, |request_type| {
                type_limits
                    .iter()
                    .find(|(name, _)| *name == request_type)
                    .map_or(classified_max_bytes, |(_, limit)| *limit)
            });
        if line.len() > active_max_bytes.saturating_add(1) {
            return Err(RuntimeError::Protocol(format!(
                "{description} exceeds {active_max_bytes} bytes"
            )));
        }
        if newline.is_none() {
            continue;
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > active_max_bytes {
            return Err(RuntimeError::Protocol(format!(
                "{description} exceeds {active_max_bytes} bytes"
            )));
        }
        return String::from_utf8(line)
            .map(Some)
            .map_err(|_| RuntimeError::Protocol(format!("{description} is not valid UTF-8")));
    }
}

fn top_level_json_type(input: &[u8]) -> Option<String> {
    let mut index = input.iter().position(|byte| !byte.is_ascii_whitespace())?;
    if input.get(index) != Some(&b'{') {
        return None;
    }
    index += 1;
    let mut depth = 1_u32;
    let mut expecting_key = true;
    while index < input.len() {
        match input[index] {
            b'"' => {
                let end = json_string_end(input, index)?;
                if depth == 1 && expecting_key {
                    let key = serde_json::from_slice::<String>(&input[index..end]).ok()?;
                    let mut value_index = end;
                    while input
                        .get(value_index)
                        .is_some_and(|byte| byte.is_ascii_whitespace())
                    {
                        value_index += 1;
                    }
                    if input.get(value_index) != Some(&b':') {
                        return None;
                    }
                    value_index += 1;
                    while input
                        .get(value_index)
                        .is_some_and(|byte| byte.is_ascii_whitespace())
                    {
                        value_index += 1;
                    }
                    if key == "type" {
                        if input.get(value_index) != Some(&b'"') {
                            return None;
                        }
                        let value_end = json_string_end(input, value_index)?;
                        return serde_json::from_slice::<String>(&input[value_index..value_end])
                            .ok();
                    }
                    expecting_key = false;
                }
                index = end;
            }
            b'{' | b'[' => {
                depth = depth.saturating_add(1);
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b',' if depth == 1 => {
                expecting_key = true;
                index += 1;
            }
            _ => index += 1,
        }
    }
    None
}

fn json_string_end(input: &[u8], start: usize) -> Option<usize> {
    let mut index = start.checked_add(1)?;
    let mut escaped = false;
    while index < input.len() {
        let byte = input[index];
        index += 1;
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return Some(index);
        }
    }
    None
}

pub(super) fn registry_entry_path(root: &Path, peer_id: &str) -> PathBuf {
    root.join(format!("{}.json", URL_SAFE_NO_PAD.encode(peer_id)))
}

pub(super) fn managed_artifact_dir(
    registry_root: &Path,
    peer_id: &str,
    transfer_id: &str,
) -> PathBuf {
    managed_artifact_root(registry_root, peer_id)
        .join(URL_SAFE_NO_PAD.encode(transfer_id.as_bytes()))
}

pub(super) fn managed_artifact_root(registry_root: &Path, peer_id: &str) -> PathBuf {
    registry_root
        .join("artifacts")
        .join(URL_SAFE_NO_PAD.encode(peer_id.as_bytes()))
}

pub(super) fn remove_managed_artifact_root(
    registry_root: &Path,
    peer_id: &str,
) -> std::io::Result<()> {
    remove_managed_artifact_root_impl(registry_root, &URL_SAFE_NO_PAD.encode(peer_id.as_bytes()))
}

#[cfg(all(test, unix))]
thread_local! {
    static MANAGED_ARTIFACT_CLEANUP_DIRECTORY_OPENS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(all(test, unix))]
pub(super) fn reset_managed_artifact_cleanup_directory_opens() {
    MANAGED_ARTIFACT_CLEANUP_DIRECTORY_OPENS.set(Some(0));
}

#[cfg(all(test, unix))]
pub(super) fn managed_artifact_cleanup_directory_opens() -> usize {
    MANAGED_ARTIFACT_CLEANUP_DIRECTORY_OPENS.get().unwrap_or(0)
}

#[cfg(unix)]
fn remove_managed_artifact_root_impl(
    registry_root: &Path,
    encoded_peer_id: &str,
) -> std::io::Result<()> {
    use std::ffi::{CStr, CString, OsStr};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    struct DirectoryStream(*mut libc::DIR);

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }

    fn open_path_directory(path: &Path) -> std::io::Result<OwnedFd> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
    }

    fn open_child_directory(parent: RawFd, name: &OsStr) -> std::io::Result<OwnedFd> {
        #[cfg(test)]
        MANAGED_ARTIFACT_CLEANUP_DIRECTORY_OPENS.set(
            MANAGED_ARTIFACT_CLEANUP_DIRECTORY_OPENS
                .get()
                .map(|count| count + 1),
        );
        let name = CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let descriptor = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
    }

    fn unlink_child(parent: RawFd, name: &OsStr, flags: libc::c_int) -> std::io::Result<()> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        if unsafe { libc::unlinkat(parent, name.as_ptr(), flags) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn duplicate_directory(directory: RawFd) -> std::io::Result<OwnedFd> {
        let duplicate = unsafe { libc::fcntl(directory, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
    }

    fn first_directory_entry(directory: RawFd) -> std::io::Result<Option<std::ffi::OsString>> {
        let duplicate = duplicate_directory(directory)?;
        let duplicate = duplicate.into_raw_fd();
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::close(duplicate);
            }
            return Err(error);
        }
        let stream = DirectoryStream(stream);
        loop {
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                return Ok(Some(std::ffi::OsString::from_vec(name.to_vec())));
            }
        }
        Ok(None)
    }

    fn child_is_directory(parent: RawFd, name: &OsStr) -> std::io::Result<bool> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent,
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let metadata = unsafe { metadata.assume_init() };
        Ok(metadata.st_mode & libc::S_IFMT == libc::S_IFDIR)
    }

    fn rename_child(
        old_parent: RawFd,
        old_name: &OsStr,
        new_parent: RawFd,
        new_name: &OsStr,
    ) -> std::io::Result<()> {
        let old_name = CString::new(old_name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let new_name = CString::new(new_name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        if unsafe { libc::renameat(old_parent, old_name.as_ptr(), new_parent, new_name.as_ptr()) }
            != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn remove_directory_contents(
        managed_root: RawFd,
        directory: RawFd,
        next_lifted_name: &mut u64,
    ) -> std::io::Result<()> {
        const MAX_LIFT_RENAME_ATTEMPTS: usize = 1_024;

        while let Some(child) = first_directory_entry(directory)? {
            match child_is_directory(directory, &child) {
                Ok(true) => {
                    let mut renamed = false;
                    for _ in 0..MAX_LIFT_RENAME_ATTEMPTS {
                        let lifted_name = std::ffi::OsString::from(format!(
                            ".kanna-cleanup-{}-{}",
                            std::process::id(),
                            *next_lifted_name,
                        ));
                        *next_lifted_name = next_lifted_name.wrapping_add(1);
                        match rename_child(directory, &child, managed_root, &lifted_name) {
                            Ok(()) => {
                                renamed = true;
                                break;
                            }
                            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                                renamed = true;
                                break;
                            }
                            Err(error)
                                if error.raw_os_error() == Some(libc::EEXIST)
                                    || error.raw_os_error() == Some(libc::ENOTEMPTY)
                                    || error.raw_os_error() == Some(libc::ENOTDIR) => {}
                            Err(error) => return Err(error),
                        }
                    }
                    if !renamed {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::AlreadyExists,
                            "managed artifact cleanup rename budget exhausted",
                        ));
                    }
                }
                Ok(false) => match unlink_child(directory, &child, 0) {
                    Ok(()) => {}
                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                    Err(error) => return Err(error),
                },
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn remove_child_tree(parent: RawFd, name: &OsStr) -> std::io::Result<()> {
        let mut next_lifted_name = 1_u64;
        loop {
            let managed_root = match open_child_directory(parent, name) {
                Ok(directory) => directory,
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
                Err(error)
                    if error.raw_os_error() == Some(libc::ENOTDIR)
                        || error.raw_os_error() == Some(libc::ELOOP) =>
                {
                    match unlink_child(parent, name, 0) {
                        Ok(()) => return Ok(()),
                        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            };

            while let Some(child) = first_directory_entry(managed_root.as_raw_fd())? {
                match open_child_directory(managed_root.as_raw_fd(), &child) {
                    Ok(directory) => {
                        remove_directory_contents(
                            managed_root.as_raw_fd(),
                            directory.as_raw_fd(),
                            &mut next_lifted_name,
                        )?;
                        drop(directory);
                        match unlink_child(managed_root.as_raw_fd(), &child, libc::AT_REMOVEDIR) {
                            Ok(()) => {}
                            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                            Err(error) if error.raw_os_error() == Some(libc::ENOTEMPTY) => {}
                            Err(error)
                                if error.raw_os_error() == Some(libc::ENOTDIR)
                                    || error.raw_os_error() == Some(libc::ELOOP) =>
                            {
                                match unlink_child(managed_root.as_raw_fd(), &child, 0) {
                                    Ok(()) => {}
                                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                                    Err(error) => return Err(error),
                                }
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                    Err(error)
                        if error.raw_os_error() == Some(libc::ENOTDIR)
                            || error.raw_os_error() == Some(libc::ELOOP) =>
                    {
                        match unlink_child(managed_root.as_raw_fd(), &child, 0) {
                            Ok(()) => {}
                            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                            Err(error) => return Err(error),
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            drop(managed_root);
            match unlink_child(parent, name, libc::AT_REMOVEDIR) {
                Ok(()) => return Ok(()),
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
                Err(error) if error.raw_os_error() == Some(libc::ENOTEMPTY) => continue,
                Err(error)
                    if error.raw_os_error() == Some(libc::ENOTDIR)
                        || error.raw_os_error() == Some(libc::ELOOP) =>
                {
                    match unlink_child(parent, name, 0) {
                        Ok(()) => return Ok(()),
                        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    let registry = match open_path_directory(registry_root) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let artifacts = match open_child_directory(registry.as_raw_fd(), OsStr::new("artifacts")) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    remove_child_tree(artifacts.as_raw_fd(), OsStr::new(encoded_peer_id))
}

#[cfg(not(unix))]
fn remove_managed_artifact_root_impl(
    registry_root: &Path,
    encoded_peer_id: &str,
) -> std::io::Result<()> {
    let artifacts = registry_root.join("artifacts");
    if std::fs::symlink_metadata(&artifacts).is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "managed artifact ancestor is a symlink",
        ));
    }
    match std::fs::remove_dir_all(artifacts.join(encoded_peer_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn peer_store(root: &Path, self_peer_id: &str) -> Result<PeerStore, RuntimeError> {
    Ok(PeerStore::new(root.join("trusted-peers").join(format!(
        "{}.json",
        URL_SAFE_NO_PAD.encode(self_peer_id)
    ))))
}

fn identity_path(root: &Path, self_peer_id: &str) -> PathBuf {
    root.join("transfer-identities")
        .join(format!("{}.json", URL_SAFE_NO_PAD.encode(self_peer_id)))
}

pub(super) fn load_or_create_identity(
    root: &Path,
    self_peer_id: &str,
) -> Result<TransferIdentity, RuntimeError> {
    let path = identity_path(root, self_peer_id);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if !contents.trim().is_empty() {
            let stored: StoredIdentity = serde_json::from_str(&contents)?;
            return TransferIdentity::from_secret_string(&stored.secret_key)
                .map_err(|error| RuntimeError::InvalidConfig(error.to_string()));
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let identity = TransferIdentity::generate();
    let stored = StoredIdentity {
        secret_key: identity.secret_key_string(),
    };
    std::fs::write(path, serde_json::to_vec_pretty(&stored)?)?;
    Ok(identity)
}

pub(super) fn local_capabilities_json() -> String {
    serde_json::json!({
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
        "transferCapabilityVersion": 1,
        "authenticatedTaskRequests": true,
        "authenticatedTaskRequestVersion": AUTHENTICATED_TASK_REQUEST_VERSION,
        "companionCapabilityVersion": 1,
    })
    .to_string()
}

pub(super) fn supports_authenticated_task_requests(
    protocol_version: u32,
    capabilities_json: &str,
) -> bool {
    if protocol_version < AUTHENTICATED_TASK_REQUEST_PROTOCOL_VERSION {
        return false;
    }
    let Ok(capabilities) = serde_json::from_str::<Value>(capabilities_json) else {
        return false;
    };
    capabilities
        .get("authenticatedTaskRequests")
        .and_then(Value::as_bool)
        == Some(true)
        && capabilities
            .get("authenticatedTaskRequestVersion")
            .and_then(Value::as_u64)
            .is_some_and(|version| version >= AUTHENTICATED_TASK_REQUEST_VERSION as u64)
}

pub(super) fn supports_streamed_artifacts(protocol_version: u32) -> bool {
    protocol_version >= STREAMED_ARTIFACT_PROTOCOL_VERSION
}

pub(super) fn supports_duplex_terminal(protocol_version: u32) -> bool {
    protocol_version >= DUPLEX_TERMINAL_PROTOCOL_VERSION
}

pub(super) fn supports_terminal_input_semantics(protocol_version: u32) -> bool {
    protocol_version >= TERMINAL_INPUT_SEMANTICS_PROTOCOL_VERSION
}

pub(super) fn ensure_peer_is_trusted_for(
    root: &Path,
    self_peer_id: &str,
    peer_id: &str,
    observed_public_key: &str,
) -> Result<(), RuntimeError> {
    let trusted = peer_store(root, self_peer_id)?
        .list_active()?
        .into_iter()
        .find(|record| record.peer_id == peer_id)
        .filter(|record| record.public_key == observed_public_key)
        .is_some();

    if trusted {
        Ok(())
    } else {
        Err(RuntimeError::Protocol(format!(
            "peer {} is not trusted",
            peer_id
        )))
    }
}

pub(super) fn pairing_verification_code(
    left_peer_id: &str,
    left_public_key: &str,
    right_peer_id: &str,
    right_public_key: &str,
) -> String {
    let mut participants = [
        format!("{left_peer_id}:{left_public_key}"),
        format!("{right_peer_id}:{right_public_key}"),
    ];
    participants.sort();

    let mut hasher = Sha256::new();
    hasher.update(participants[0].as_bytes());
    hasher.update(b"|");
    hasher.update(participants[1].as_bytes());
    let digest = hasher.finalize();
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

pub(super) fn unexpected_peer_response(operation: &str, response: &PeerResponse) -> RuntimeError {
    RuntimeError::Protocol(format!(
        "unexpected response while handling {}: {:?}",
        operation, response
    ))
}

pub(super) fn prune_outgoing_transfers(
    transfers: &mut HashMap<String, OutgoingTransferReservation>,
    pending_transfer_ttl: Duration,
) -> Vec<String> {
    let now = Instant::now();
    let expired = transfers
        .iter()
        .filter(|(_, reservation)| {
            now.duration_since(reservation.created_at) >= pending_transfer_ttl
        })
        .map(|(transfer_id, _)| transfer_id.clone())
        .collect::<Vec<_>>();
    for transfer_id in &expired {
        transfers.remove(transfer_id);
    }
    expired
}

pub(super) fn prune_transfer_artifacts(
    transfer_artifacts: &mut HashMap<String, HashMap<String, TransferArtifactRecord>>,
    pending_transfer_ttl: Duration,
) -> Vec<std::path::PathBuf> {
    let now = Instant::now();
    let mut owned_paths = Vec::new();
    transfer_artifacts.retain(|_, artifacts| {
        artifacts.retain(|_, artifact| {
            let keep = now.duration_since(artifact.created_at) < pending_transfer_ttl;
            if !keep && artifact.owned {
                owned_paths.push(artifact.path.clone());
            }
            keep
        });
        !artifacts.is_empty()
    });
    owned_paths
}

pub(super) fn take_transfer_artifacts(
    transfer_artifacts: &mut HashMap<String, HashMap<String, TransferArtifactRecord>>,
    transfer_id: &str,
) -> Vec<std::path::PathBuf> {
    transfer_artifacts
        .remove(transfer_id)
        .into_iter()
        .flat_map(|artifacts| artifacts.into_values())
        .filter(|artifact| artifact.owned)
        .map(|artifact| artifact.path)
        .collect()
}

pub(super) async fn remove_owned_artifact_paths(paths: Vec<std::path::PathBuf>) {
    for path in paths {
        let _ = remove_owned_artifact_path(&path).await;
    }
}

/// Deletes one owned artifact and says whether the disk agreed.
///
/// A file that was already gone is success — the contract is that nothing is
/// left, not that something was. Pruning the now-empty parent stays best
/// effort: it legitimately fails while sibling artifacts of the same transfer
/// are still staged, which is not a leak.
pub(super) async fn remove_owned_artifact_path(path: &std::path::Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::remove_dir(parent).await;
    }
    Ok(())
}

pub(super) fn sanitize_artifact_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .map(|character| match character {
            '/' | '\\' => '-',
            _ => character,
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "artifact".to_string()
    } else {
        sanitized
    }
}

/// POSIX `NAME_MAX`: no single path component may exceed 255 bytes on macOS or
/// Linux. Exceeding it fails the open with `ENAMETOOLONG`, which for an
/// artifact means the transfer dies mid-flight with "File name too long".
pub(super) const NAME_MAX_BYTES: usize = 255;

/// Byte budget for a managed artifact's own file name.
///
/// It sits far below [`NAME_MAX_BYTES`] on purpose. Each side names its local
/// copy independently, but a *receiver running an older build* still composes
/// `<artifact-id>-<the name the source sent>`; keeping the name we stage small
/// keeps that older receiver's doubled name inside `NAME_MAX` too — with a
/// 64-byte artifact id it lands near 160 bytes instead of overflowing.
pub(super) const MANAGED_ARTIFACT_FILENAME_BYTES: usize = 96;

/// Digest bytes retained in a managed artifact name. Base64 of 12 bytes is 16
/// characters drawn from the URL-safe alphabet, so the name stays path-safe.
const MANAGED_ARTIFACT_DIGEST_BYTES: usize = 12;

/// The name a managed artifact takes on disk, derived from its artifact id
/// alone.
///
/// That name is a *local storage detail on each side*: the source records the
/// staged path in memory, the receiver hands the fetched path back to its
/// caller, and materialization takes the user-visible file name from the
/// transfer payload (`TransferArtifactPayload.filename`) — never from either
/// on-disk name. The naming scheme itself never crosses the wire, so the two
/// peers need not agree on it and no cross-version compatibility rides on it.
///
/// Deriving from the artifact id, and never from the source basename, is what
/// bounds the name. Basenames are unbounded — a staged Claude session archive
/// is already `kanna-transfer-<transfer-id>-claude-session.tar.gz` — and the
/// previous scheme spent the artifact id twice in the receiver's name
/// (`<artifact-id>-<artifact-id>-<basename>`), overflowing `NAME_MAX` for real
/// Claude and Copilot transfers. The truncated-id prefix keeps the name legible
/// on disk; the digest keeps ids that share a long prefix — every artifact of
/// one transfer starts with the same transfer id — from colliding once the
/// prefix is truncated.
pub(super) fn managed_artifact_filename(artifact_id: &str) -> String {
    let digest = Sha256::digest(artifact_id.as_bytes());
    let suffix = URL_SAFE_NO_PAD.encode(&digest[..MANAGED_ARTIFACT_DIGEST_BYTES]);
    let prefix_budget = MANAGED_ARTIFACT_FILENAME_BYTES
        .saturating_sub(suffix.len())
        .saturating_sub(1);
    let sanitized = sanitize_artifact_filename(artifact_id);
    format!(
        "{}-{}",
        truncate_on_char_boundary(&sanitized, prefix_budget),
        suffix,
    )
}

/// Truncate to at most `budget` bytes without splitting a UTF-8 character.
fn truncate_on_char_boundary(value: &str, budget: usize) -> &str {
    if value.len() <= budget {
        return value;
    }
    let mut end = budget;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader};

    #[test]
    fn duplex_terminal_controls_start_at_protocol_v4() {
        assert!(!supports_duplex_terminal(3));
        assert!(supports_duplex_terminal(4));
    }

    #[test]
    fn explicit_terminal_input_semantics_start_at_protocol_v5() {
        assert!(!supports_terminal_input_semantics(4));
        assert!(supports_terminal_input_semantics(5));
    }

    #[tokio::test]
    async fn bounded_line_accepts_exact_limit_and_rejects_one_byte_over() {
        let (mut writer, reader) = tokio::io::duplex(32);
        writer.write_all(b"1234\n").await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_bounded_line(&mut reader, 4, "test line")
                .await
                .unwrap()
                .as_deref(),
            Some("1234")
        );

        let (mut writer, reader) = tokio::io::duplex(32);
        writer.write_all(b"12345\n").await.unwrap();
        let mut reader = BufReader::new(reader);
        let error = read_bounded_line(&mut reader, 4, "test line")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("exceeds 4 bytes"));
    }

    #[tokio::test]
    async fn bounded_line_rejects_newline_free_input_at_the_limit() {
        let (mut writer, reader) = tokio::io::duplex(32);
        writer.write_all(b"1234").await.unwrap();
        writer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        let error = read_bounded_line(&mut reader, 4, "test line")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("missing newline"));
    }

    #[tokio::test]
    async fn bounded_line_accepts_exact_limit_with_crlf_and_never_echoes_rejected_payload() {
        let (mut writer, reader) = tokio::io::duplex(32);
        writer.write_all(b"1234\r\n").await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_bounded_line(&mut reader, 4, "test line")
                .await
                .unwrap()
                .as_deref(),
            Some("1234")
        );

        let (mut writer, reader) = tokio::io::duplex(64);
        writer
            .write_all(b"secret-attacker-payload\n")
            .await
            .unwrap();
        let mut reader = BufReader::new(reader);
        let error = read_bounded_line(&mut reader, 4, "test line")
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-attacker-payload"));
    }

    #[tokio::test]
    async fn bounded_line_distinguishes_clean_eof_from_partial_line_eof() {
        let (mut writer, reader) = tokio::io::duplex(8);
        writer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_bounded_line(&mut reader, 4, "test line")
                .await
                .unwrap(),
            None
        );

        let (mut writer, reader) = tokio::io::duplex(8);
        writer.write_all(b"12").await.unwrap();
        writer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        assert!(read_bounded_line(&mut reader, 4, "test line")
            .await
            .unwrap_err()
            .to_string()
            .contains("missing newline"));
    }

    #[tokio::test]
    async fn companion_prefix_keeps_oversized_sealed_requests_on_the_narrow_limit() {
        let prefix = br#"{"type":"observe_companion","#;
        let mut request = prefix.to_vec();
        request.extend(std::iter::repeat_n(b'x', 64));
        request.push(b'\n');
        let (mut writer, reader) = tokio::io::duplex(256);
        writer.write_all(&request).await.unwrap();
        let mut reader = BufReader::new(reader);
        let error = read_bounded_line_with_prefix_limits(
            &mut reader,
            128,
            &[(prefix.as_slice(), 32)],
            "peer request",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("exceeds 32 bytes"));
    }

    #[tokio::test]
    async fn companion_type_after_request_id_keeps_the_narrow_limit() {
        let mut request =
            br#"{"request_id":"reordered","type":"observe_companion","sealed_payload":""#.to_vec();
        request.resize(65, b'x');
        request.push(b'\n');
        let (mut writer, reader) = tokio::io::duplex(256);
        writer.write_all(&request).await.unwrap();
        let mut reader = BufReader::new(reader);
        let error = read_bounded_json_line_with_type_limits(
            &mut reader,
            32,
            128,
            &[("observe_companion", 32)],
            "peer request",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("exceeds 32 bytes"));
    }

    #[test]
    fn top_level_type_ignores_nested_and_string_decoys() {
        let request = br#"{
            "request_id":"contains \"type\":\"submit_transfer_payload\"",
            "metadata":{"type":"submit_transfer_payload"},
            "type":"observe_companion"
        }"#;
        assert_eq!(
            top_level_json_type(request).as_deref(),
            Some("observe_companion")
        );
    }
}
