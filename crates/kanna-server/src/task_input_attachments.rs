//! Image attachments delivered alongside `POST /v1/tasks/{task_id}/input`.
//!
//! The agent CLIs are terminal programs. There is no PTY-level image channel
//! and inventing one would mean a daemon protocol change for a feature that
//! does not need it: every supported agent reads an image *file* when the
//! message names its path. So an attachment is stored as a file on the
//! desktop that owns the task, and the injected input is the caller's text
//! plus a reference to that path. Nothing about the daemon contract changes —
//! the message is one ordinary logical submission.
//!
//! **Where the file lives.** Beside the database, not in the task's worktree.
//! A worktree is a git checkout whose dirty state is snapshotted into a WIP
//! commit at close, so a photo dropped there would end up committed on the
//! task's branch and visible in every diff view. The database's directory is
//! already the per-instance data root (a worktree dev instance has its own
//! `kanna-wt-*.db` there), so deriving the attachment root from `db_path`
//! keeps parallel instances from sharing a directory without adding a config
//! field nobody would remember to set.
//!
//! **Lifecycle.** The task owns its attachments: they are removed when the
//! task closes, next to the other per-task on-disk artifacts
//! (`remove_completion_contexts`). Nothing else is retained — an attachment
//! that outlived its task would be a file no consumer can name.

use base64::Engine;
use std::path::{Path, PathBuf};

/// Largest decoded attachment the server stores.
///
/// Chosen against what the clients actually send, not against what a phone
/// camera produces: mobile downscales to a 1568px longest edge and re-encodes
/// as JPEG before upload, which lands well under 1 MiB for ordinary photos.
/// The headroom above that absorbs a detailed screenshot; anything larger is a
/// client that skipped its budget, and is refused rather than pushed through a
/// relay connection that also carries the task's terminal stream.
pub(crate) const MAX_TASK_INPUT_ATTACHMENT_BYTES: usize = 3 * 1024 * 1024;

/// Body limit for the task-input route.
///
/// Base64 costs a third on top of the decoded cap, and the JSON envelope
/// carries the caller's message text as well. Sized so a legitimate
/// at-the-cap attachment is never rejected by the transport before the
/// attachment-specific error can explain itself.
pub(crate) const MAX_TASK_INPUT_BODY_BYTES: usize = 8 * 1024 * 1024;

/// One image the caller attached to a task input.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskInputAttachment {
    /// The caller's name for the file. Advisory: it is reduced to a safe stem
    /// and used as a *prefix* on a generated name, never as the name itself.
    /// A caller-supplied name is a path-traversal vector, and two phones would
    /// happily send the same `IMG_0001.jpg` — but a path that still reads
    /// `IMG_0001-…jpg` is far easier for an operator to recognise later.
    #[serde(default)]
    pub file_name: Option<String>,
    pub media_type: String,
    pub data_base64: String,
}

/// Why an attachment was refused. Each maps to a distinct HTTP status, so a
/// client can tell "shrink it" from "send a different format".
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskInputAttachmentError {
    UnsupportedMediaType(String),
    Malformed(String),
    TooLarge { bytes: usize, limit: usize },
    Io(String),
}

impl TaskInputAttachmentError {
    pub(crate) fn status(&self) -> axum::http::StatusCode {
        match self {
            Self::UnsupportedMediaType(_) => axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Malformed(_) => axum::http::StatusCode::BAD_REQUEST,
            Self::TooLarge { .. } => axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            Self::Io(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::UnsupportedMediaType(_) => "unsupported_attachment_media_type",
            Self::Malformed(_) => "invalid_attachment",
            Self::TooLarge { .. } => "attachment_too_large",
            Self::Io(_) => "attachment_write_failed",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Self::UnsupportedMediaType(media_type) => format!(
                "unsupported attachment media type {media_type}; attach one of {}",
                supported_media_types().join(", ")
            ),
            Self::Malformed(detail) => format!("attachment is not usable: {detail}"),
            Self::TooLarge { bytes, limit } => format!(
                "attachment is {bytes} bytes, over the {limit}-byte limit; downscale it before sending"
            ),
            Self::Io(detail) => format!("could not store the attachment: {detail}"),
        }
    }
}

fn supported_media_types() -> Vec<&'static str> {
    MEDIA_TYPE_EXTENSIONS
        .iter()
        .map(|(media_type, _)| *media_type)
        .collect()
}

/// Photos only, and only formats an agent CLI can read back from disk.
const MEDIA_TYPE_EXTENSIONS: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/heic", "heic"),
];

fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    let normalized = media_type.trim().to_ascii_lowercase();
    MEDIA_TYPE_EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == normalized)
        .map(|(_, extension)| *extension)
}

/// The root every task's attachment directory hangs off, derived from the
/// database this server instance owns. Named after the database file so a
/// worktree instance sharing the Application Support directory with the main
/// instance still gets its own tree.
pub(crate) fn attachments_root(db_path: &str) -> PathBuf {
    let db_path = Path::new(db_path);
    let directory = db_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = db_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("kanna");
    directory.join(format!("{stem}-task-attachments"))
}

pub(crate) fn task_attachments_dir(db_path: &str, task_id: &str) -> PathBuf {
    attachments_root(db_path).join(sanitize_path_segment(task_id))
}

/// Task ids are generated, but this path is built from a value that arrives
/// over the network, so it is reduced to characters that cannot escape the
/// directory rather than trusted.
fn sanitize_path_segment(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "unnamed".to_string()
    } else {
        sanitized
    }
}

/// Decode and validate an attachment without touching the filesystem.
///
/// Split from the write so the budget rules are testable on their own and so
/// a refusal never leaves a partial file behind.
pub(crate) fn decode_task_input_attachment(
    attachment: &TaskInputAttachment,
) -> Result<(Vec<u8>, &'static str), TaskInputAttachmentError> {
    let extension = extension_for_media_type(&attachment.media_type).ok_or_else(|| {
        TaskInputAttachmentError::UnsupportedMediaType(attachment.media_type.clone())
    })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(attachment.data_base64.trim())
        .map_err(|error| {
            TaskInputAttachmentError::Malformed(format!("base64 payload is invalid: {error}"))
        })?;
    if bytes.is_empty() {
        return Err(TaskInputAttachmentError::Malformed(
            "base64 payload decoded to zero bytes".to_string(),
        ));
    }
    if bytes.len() > MAX_TASK_INPUT_ATTACHMENT_BYTES {
        return Err(TaskInputAttachmentError::TooLarge {
            bytes: bytes.len(),
            limit: MAX_TASK_INPUT_ATTACHMENT_BYTES,
        });
    }
    Ok((bytes, extension))
}

/// Write one attachment into the task's directory and return its absolute
/// path — the exact string the injected message will name.
pub(crate) fn store_task_input_attachment(
    db_path: &str,
    task_id: &str,
    attachment: &TaskInputAttachment,
) -> Result<PathBuf, TaskInputAttachmentError> {
    let (bytes, extension) = decode_task_input_attachment(attachment)?;
    let directory = task_attachments_dir(db_path, task_id);
    std::fs::create_dir_all(&directory).map_err(|error| {
        TaskInputAttachmentError::Io(format!("{}: {error}", directory.display()))
    })?;
    let path = directory.join(stored_file_name(
        attachment.file_name.as_deref(),
        extension,
        &crate::transfer_engine::queue::unique_work_nonce(),
    ));
    std::fs::write(&path, &bytes)
        .map_err(|error| TaskInputAttachmentError::Io(format!("{}: {error}", path.display())))?;
    Ok(path)
}

/// Longest prefix taken from a caller-supplied file name. Long enough to
/// recognise a photo by, short enough that the composed message stays legible.
const STORED_FILE_NAME_PREFIX_CHARS: usize = 40;

/// The name an attachment is stored under: the caller's own name reduced to a
/// safe stem, then a nonce that makes it unique, then the extension the
/// validated media type chose. The nonce is not optional — it is the only part
/// that keeps two photos with the same name from overwriting each other.
fn stored_file_name(file_name: Option<&str>, extension: &str, nonce: &str) -> String {
    let stem = file_name
        .map(|name| {
            Path::new(name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
        })
        .map(sanitize_path_segment)
        .map(|stem| {
            stem.trim_matches('-')
                .chars()
                .take(STORED_FILE_NAME_PREFIX_CHARS)
                .collect::<String>()
        })
        .unwrap_or_default();
    if stem.is_empty() {
        format!("{nonce}.{extension}")
    } else {
        format!("{stem}-{nonce}.{extension}")
    }
}

/// Drop a file whose input never reached the agent. A stored attachment only
/// earns its place on disk once a message naming it has been delivered.
pub(crate) fn discard_stored_attachment(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "failed to discard the attachment of an undelivered input at {}: {error}",
                path.display()
            );
        }
    }
}

/// Remove everything a closed task attached. Best-effort: the close has
/// already committed by the time this runs, and a leftover directory is worth
/// a log line, never a failed close.
pub(crate) fn remove_task_attachments(db_path: &str, task_id: &str) {
    let directory = task_attachments_dir(db_path, task_id);
    match std::fs::remove_dir_all(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!(
            "failed to remove task attachments at {}: {error}",
            directory.display()
        ),
    }
}

/// Compose the text that actually enters the agent session.
///
/// Deliberately one line's worth of joining: the daemon delivers a logical
/// message as the message bytes followed by a carriage return, so a newline
/// *we* insert would land as an extra Enter and split the submission — the
/// text would reach the agent on its own and the image reference would arrive
/// as a second, orphaned message. A caller whose own text already contains
/// newlines keeps whatever behavior it always had; this function adds none.
pub(crate) fn compose_input_with_attachment(input: &str, attachment_path: &str) -> String {
    let text = input.trim_end();
    let reference = format!("[Attached image: {attachment_path}]");
    if text.is_empty() {
        reference
    } else {
        format!("{text} {reference}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(media_type: &str, bytes: &[u8]) -> TaskInputAttachment {
        TaskInputAttachment {
            file_name: Some("photo.jpg".to_string()),
            media_type: media_type.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[test]
    fn attachment_root_is_named_after_the_database_so_instances_do_not_share_one() {
        let main = attachments_root("/data/build.kanna/kanna-v2.db");
        let worktree = attachments_root("/data/build.kanna/kanna-wt-task-7.db");

        assert_eq!(
            main,
            PathBuf::from("/data/build.kanna/kanna-v2-task-attachments")
        );
        assert_eq!(
            worktree,
            PathBuf::from("/data/build.kanna/kanna-wt-task-7-task-attachments")
        );
        assert_ne!(main, worktree);
    }

    #[test]
    fn task_directory_cannot_escape_the_attachment_root() {
        let directory = task_attachments_dir("/data/build.kanna/kanna-v2.db", "../../etc");

        assert_eq!(
            directory,
            PathBuf::from("/data/build.kanna/kanna-v2-task-attachments/------etc")
        );
        assert!(directory.starts_with(attachments_root("/data/build.kanna/kanna-v2.db")));
    }

    #[test]
    fn decode_accepts_the_photo_formats_an_agent_can_read() {
        for (media_type, expected_extension) in [
            ("image/jpeg", "jpg"),
            ("IMAGE/PNG", "png"),
            ("image/webp", "webp"),
        ] {
            let (bytes, extension) =
                decode_task_input_attachment(&attachment(media_type, b"not-really-an-image"))
                    .expect("decode");

            assert_eq!(bytes, b"not-really-an-image");
            assert_eq!(extension, expected_extension);
        }
    }

    #[test]
    fn decode_refuses_anything_that_is_not_a_photo() {
        let error = decode_task_input_attachment(&attachment("application/pdf", b"%PDF"))
            .expect_err("pdf must be refused");

        assert_eq!(
            error,
            TaskInputAttachmentError::UnsupportedMediaType("application/pdf".to_string())
        );
        assert_eq!(
            error.status(),
            axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[test]
    fn decode_refuses_a_payload_over_the_documented_budget() {
        let oversized = vec![0_u8; MAX_TASK_INPUT_ATTACHMENT_BYTES + 1];

        let error = decode_task_input_attachment(&attachment("image/jpeg", &oversized))
            .expect_err("oversized attachment must be refused");

        assert_eq!(
            error,
            TaskInputAttachmentError::TooLarge {
                bytes: MAX_TASK_INPUT_ATTACHMENT_BYTES + 1,
                limit: MAX_TASK_INPUT_ATTACHMENT_BYTES,
            }
        );
        assert_eq!(error.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn decode_refuses_an_empty_or_undecodable_payload() {
        assert!(matches!(
            decode_task_input_attachment(&attachment("image/jpeg", b"")),
            Err(TaskInputAttachmentError::Malformed(_))
        ));
        assert!(matches!(
            decode_task_input_attachment(&TaskInputAttachment {
                file_name: None,
                media_type: "image/jpeg".to_string(),
                data_base64: "not base64 !!".to_string(),
            }),
            Err(TaskInputAttachmentError::Malformed(_))
        ));
    }

    #[test]
    fn stored_name_keeps_a_recognisable_prefix_without_trusting_it() {
        assert_eq!(
            stored_file_name(Some("IMG_4821.HEIC"), "jpg", "7-1-1"),
            "IMG_4821-7-1-1.jpg"
        );
        assert_eq!(
            stored_file_name(Some("../../etc/passwd"), "png", "7-1-1"),
            "passwd-7-1-1.png"
        );
        assert_eq!(stored_file_name(Some("   "), "jpg", "7-1-1"), "7-1-1.jpg");
        assert_eq!(stored_file_name(None, "jpg", "7-1-1"), "7-1-1.jpg");
        assert_eq!(
            stored_file_name(Some(&"n".repeat(120)), "jpg", "7-1-1"),
            format!("{}-7-1-1.jpg", "n".repeat(STORED_FILE_NAME_PREFIX_CHARS))
        );
    }

    #[test]
    fn storing_writes_the_bytes_and_removing_the_task_takes_them_away() {
        let root = tempfile::tempdir().expect("temp dir");
        let db_path = root.path().join("kanna-v2.db");
        let db_path = db_path.to_string_lossy().to_string();

        let path = store_task_input_attachment(
            &db_path,
            "task-1",
            &attachment("image/png", b"\x89PNG pretend"),
        )
        .expect("store");

        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            b"\x89PNG pretend".to_vec()
        );
        assert!(path.starts_with(task_attachments_dir(&db_path, "task-1")));

        remove_task_attachments(&db_path, "task-1");
        assert!(!path.exists());
        assert!(!task_attachments_dir(&db_path, "task-1").exists());
    }

    #[test]
    fn removing_attachments_for_a_task_that_attached_nothing_is_silent() {
        let root = tempfile::tempdir().expect("temp dir");
        let db_path = root
            .path()
            .join("kanna-v2.db")
            .to_string_lossy()
            .to_string();

        remove_task_attachments(&db_path, "task-never-attached");
    }

    #[test]
    fn discarding_removes_the_file_of_an_undelivered_input() {
        let root = tempfile::tempdir().expect("temp dir");
        let db_path = root
            .path()
            .join("kanna-v2.db")
            .to_string_lossy()
            .to_string();
        let path =
            store_task_input_attachment(&db_path, "task-2", &attachment("image/jpeg", b"jpeg"))
                .expect("store");

        discard_stored_attachment(&path);

        assert!(!path.exists());
    }

    #[test]
    fn composed_message_names_the_path_on_the_submission_the_text_is_on() {
        let composed = compose_input_with_attachment("look at this\n", "/data/a/b.jpg");

        assert_eq!(composed, "look at this [Attached image: /data/a/b.jpg]");
        assert!(!composed.contains('\n'));
    }

    #[test]
    fn composed_message_stands_alone_when_the_caller_sent_no_text() {
        assert_eq!(
            compose_input_with_attachment("   ", "/data/a/b.jpg"),
            "[Attached image: /data/a/b.jpg]"
        );
    }

    #[test]
    fn composed_message_leaves_a_callers_own_newlines_alone() {
        let composed = compose_input_with_attachment("first\nsecond", "/data/a/b.jpg");

        assert_eq!(composed, "first\nsecond [Attached image: /data/a/b.jpg]");
    }
}
