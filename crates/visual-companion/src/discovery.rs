use base64::Engine as _;
use kanna_agent_protocol::{CompanionAsset, CompanionDocumentKind};
use sha2::{Digest as _, Sha256};
use std::fmt;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Maximum accepted UTF-8 HTML document size.
pub const MAX_COMPANION_HTML_BYTES: u64 = 1024 * 1024;
/// Maximum number of direct assets included in one companion bundle.
pub const MAX_COMPANION_ASSET_COUNT: usize = 32;
/// Maximum unencoded size of one companion asset.
pub const MAX_COMPANION_ASSET_BYTES: u64 = 4 * 1024 * 1024;
/// Maximum total unencoded size of all assets in one companion bundle.
pub const MAX_COMPANION_ASSET_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum raw bytes in local images inlined into one companion document.
///
/// Base64 expands this to at most 1 MiB. The bound covers the reported
/// approximately 528 KiB screenshot gallery with headroom while keeping the
/// prepared HTML comfortably below the companion transport limits.
pub const MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES: u64 = 768 * 1024;
/// Maximum UTF-8 bytes in a document after local image preparation.
pub const MAX_COMPANION_PREPARED_HTML_BYTES: usize = 1536 * 1024;
/// Maximum cumulative entries enumerated across one companion tree scan.
pub const MAX_COMPANION_DIRECTORY_ENTRIES: usize = 4096;
/// Maximum cumulative basename bytes enumerated across one companion tree scan.
pub const MAX_COMPANION_DIRECTORY_NAME_BYTES: usize = 256 * 1024;
/// Conservative retained bytes for a fully materialized legal bundle,
/// including base64 expansion and metadata.
pub const MAX_COMPANION_MATERIALIZED_BYTES: usize = MAX_COMPANION_HTML_BYTES as usize
    + (MAX_COMPANION_ASSET_TOTAL_BYTES as usize * 4).div_ceil(3)
    + (MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES as usize * 4).div_ceil(3)
    + 1024 * 1024;
/// Conservative retained bytes for a materialized companion without assets.
pub const MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES: usize = MAX_COMPANION_HTML_BYTES as usize
    + (MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES as usize * 4).div_ceil(3)
    + MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES as usize
    + 1024 * 1024;

// server-info contains only small JSON metadata. Bounding it independently
// prevents malformed source metadata from competing with document/asset memory.
const MAX_SERVER_INFO_BYTES: u64 = 16 * 1024;

/// A companion document and its descriptor-relative, point-in-time resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionBundle {
    /// Brainstorm session that owns this bundle.
    pub session_id: String,
    /// Stable document-and-assets revision used for event validation.
    pub revision: String,
    /// Whether `html` is a fragment or a complete HTML document.
    pub document_kind: CompanionDocumentKind,
    /// Validated UTF-8 companion document.
    pub html: String,
    /// Validated HTTP loopback origin advertised by the source, when usable.
    pub source_origin: Option<String>,
    /// Bounded direct regular-file assets, ordered by bytewise basename.
    pub assets: Vec<CompanionAsset>,
}

/// Result of one stateful companion scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionScan {
    /// The authoritative tree changed and produced a new availability value.
    Changed(Option<CompanionBundle>),
    /// The bounded metadata fingerprint is unchanged; no payload was read.
    Unchanged,
}

/// Stateful descriptor-relative scanner that skips unchanged payloads.
#[derive(Debug, Default)]
pub struct CompanionScanner {
    fingerprint: Option<CompanionFingerprint>,
    materialization_budget: Option<Arc<CompanionMaterializationBudget>>,
    #[cfg(test)]
    materialization_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CompanionFingerprint {
    metadata: [u8; 32],
    include_assets: bool,
}

impl CompanionScanner {
    /// Creates an empty scanner whose first successful scan is changed.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_materialization_budget(
        materialization_budget: Arc<CompanionMaterializationBudget>,
    ) -> Self {
        Self {
            materialization_budget: Some(materialization_budget),
            ..Self::default()
        }
    }

    /// Scans an explicit workspace, materializing only when metadata changed.
    pub fn scan(&mut self, workspace: &Path) -> Result<CompanionScan, CompanionError> {
        self.scan_with_assets(workspace, true)
    }

    /// Scans an explicit workspace, optionally materializing companion assets.
    pub fn scan_with_assets(
        &mut self,
        workspace: &Path,
        include_assets: bool,
    ) -> Result<CompanionScan, CompanionError> {
        #[cfg(unix)]
        {
            let result = (|| {
                let root = open_workspace(workspace)?;
                let prepared = prepare_scan(&root)?;
                let fingerprint = CompanionFingerprint {
                    metadata: prepared.fingerprint,
                    include_assets,
                };
                if self.fingerprint == Some(fingerprint) {
                    return Ok(CompanionScan::Unchanged);
                }
                #[cfg(test)]
                {
                    self.materialization_count += 1;
                }
                let _admission = match (&prepared.selected, &self.materialization_budget) {
                    (Some(_), Some(budget)) => Some(
                        budget
                            .try_reserve(if include_assets {
                                MAX_COMPANION_MATERIALIZED_BYTES
                            } else {
                                MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES
                            })
                            .ok_or_else(|| {
                                CompanionError::Internal(
                                    "visual companion materialization budget is busy".into(),
                                )
                            })?,
                    ),
                    _ => None,
                };
                let materialized = materialize_scan(prepared, include_assets)?;
                if materialized.cacheable {
                    self.fingerprint = Some(fingerprint);
                } else {
                    self.invalidate();
                }
                Ok(CompanionScan::Changed(materialized.bundle))
            })();
            if result.is_err() {
                self.invalidate();
            }
            result
        }
        #[cfg(not(unix))]
        {
            let _ = (workspace, include_assets);
            self.invalidate();
            Err(CompanionError::Internal(
                "secure visual companion traversal is unsupported on this platform".into(),
            ))
        }
    }

    /// Forces the next successful scan to materialize its bundle.
    pub fn invalidate(&mut self) {
        self.fingerprint = None;
    }

    #[cfg(test)]
    pub(crate) fn materialization_count(&self) -> usize {
        self.materialization_count
    }
}

#[derive(Debug)]
pub struct CompanionMaterializationBudget {
    limits: CompanionMaterializationLimits,
    state: Mutex<CompanionMaterializationState>,
}

#[derive(Debug, Clone, Copy)]
struct CompanionMaterializationLimits {
    max_concurrent: usize,
    max_bytes: usize,
}

#[derive(Debug, Default)]
struct CompanionMaterializationState {
    concurrent: usize,
    bytes: usize,
}

impl CompanionMaterializationBudget {
    pub fn new(max_concurrent: usize, max_bytes: usize) -> Self {
        Self {
            limits: CompanionMaterializationLimits {
                max_concurrent: max_concurrent.max(1),
                max_bytes: max_bytes.max(1),
            },
            state: Mutex::new(CompanionMaterializationState::default()),
        }
    }

    pub fn try_reserve(self: &Arc<Self>, bytes: usize) -> Option<CompanionMaterializationPermit> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.concurrent >= self.limits.max_concurrent
            || state.bytes.saturating_add(bytes) > self.limits.max_bytes
        {
            return None;
        }
        state.concurrent += 1;
        state.bytes += bytes;
        Some(CompanionMaterializationPermit {
            budget: Arc::clone(self),
            bytes,
        })
    }

    #[doc(hidden)]
    pub fn retained_bytes(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .bytes
    }
}

pub struct CompanionMaterializationPermit {
    budget: Arc<CompanionMaterializationBudget>,
    bytes: usize,
}

impl Drop for CompanionMaterializationPermit {
    fn drop(&mut self) {
        let mut state = self
            .budget
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.concurrent -= 1;
        state.bytes -= self.bytes;
    }
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
            Self::TooLarge => formatter.write_str("visual companion exceeds its resource limits"),
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

/// Discovers the current companion from an explicit absolute workspace.
///
/// After opening the workspace itself, discovery traverses session state,
/// documents, and assets only through descriptor-relative, no-follow opens.
pub fn current_bundle(workspace: &Path) -> Result<Option<CompanionBundle>, CompanionError> {
    #[cfg(unix)]
    {
        let root = open_workspace(workspace)?;
        Ok(materialize_scan(prepare_scan(&root)?, true)?.bundle)
    }
    #[cfg(not(unix))]
    {
        let _ = workspace;
        Err(CompanionError::Internal(
            "secure visual companion traversal is unsupported on this platform".into(),
        ))
    }
}

pub(crate) fn is_normal_component(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\0')
        && Path::new(value).components().count() == 1
        && matches!(
            Path::new(value).components().next(),
            Some(std::path::Component::Normal(_))
        )
}

#[cfg(unix)]
pub(crate) fn open_workspace(workspace: &Path) -> Result<std::os::fd::OwnedFd, CompanionError> {
    if !workspace.is_absolute() {
        return Err(CompanionError::WorkspaceUnavailable);
    }
    openat_owned(
        libc::AT_FDCWD,
        workspace.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
    .map_err(|_| CompanionError::WorkspaceUnavailable)
}

#[cfg(unix)]
pub(crate) fn open_companion_root(
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
    state: std::os::fd::OwnedFd,
    content: std::os::fd::OwnedFd,
    content_names: Vec<std::ffi::OsString>,
}

#[cfg(unix)]
struct PreparedScan {
    fingerprint: [u8; 32],
    selected: Option<DocumentCandidate>,
}

#[cfg(unix)]
struct MaterializedScan {
    bundle: Option<CompanionBundle>,
    cacheable: bool,
}

#[cfg(unix)]
pub(crate) struct CompanionDocumentRevision {
    pub(crate) session_id: String,
    pub(crate) revision: String,
}

#[cfg(unix)]
struct OptionalMaterialization<T> {
    value: Option<T>,
    cacheable: bool,
}

#[cfg(unix)]
impl<T> OptionalMaterialization<T> {
    fn value(value: T) -> Self {
        Self {
            value: Some(value),
            cacheable: true,
        }
    }

    fn omitted() -> Self {
        Self {
            value: None,
            cacheable: true,
        }
    }

    fn degraded() -> Self {
        Self {
            value: None,
            cacheable: false,
        }
    }
}

#[cfg(unix)]
#[derive(Default)]
struct DirectoryBudget {
    entries: usize,
    name_bytes: usize,
}

#[cfg(unix)]
impl DirectoryBudget {
    fn charge(&mut self, name_bytes: usize) -> Result<(), CompanionError> {
        self.entries = self.entries.saturating_add(1);
        self.name_bytes = self.name_bytes.saturating_add(name_bytes);
        if self.entries > MAX_COMPANION_DIRECTORY_ENTRIES
            || self.name_bytes > MAX_COMPANION_DIRECTORY_NAME_BYTES
        {
            return Err(CompanionError::TooLarge);
        }
        Ok(())
    }
}

#[cfg(unix)]
/// Reproduces the selected bundle identity from descriptor metadata only.
///
/// Event validation uses this path so its pre/post race fences never read,
/// hash, or base64-encode document and asset payloads.
pub(crate) fn discover_document_revision(
    workspace: &std::os::fd::OwnedFd,
) -> Result<Option<CompanionDocumentRevision>, CompanionError> {
    let Some(selected) = prepare_scan(workspace)?.selected else {
        return Ok(None);
    };
    let revision = descriptor_revision(&selected)?;
    Ok(Some(CompanionDocumentRevision {
        session_id: selected.session_id,
        revision,
    }))
}

#[cfg(unix)]
fn prepare_scan(workspace: &std::os::fd::OwnedFd) -> Result<PreparedScan, CompanionError> {
    use std::os::fd::AsRawFd;

    let mut fingerprint = Sha256::new();
    fingerprint.update(b"kanna-companion-fingerprint-v1");
    fingerprint_descriptor(&mut fingerprint, workspace)?;
    let mut budget = DirectoryBudget::default();

    let Some(superpowers) = open_optional_directory(workspace.as_raw_fd(), ".superpowers")? else {
        fingerprint.update([0]);
        return Ok(PreparedScan {
            fingerprint: fingerprint.finalize().into(),
            selected: None,
        });
    };
    fingerprint.update([1]);
    fingerprint_descriptor(&mut fingerprint, &superpowers)?;
    let Some(brainstorm) = open_optional_directory(superpowers.as_raw_fd(), "brainstorm")? else {
        fingerprint.update([0]);
        return Ok(PreparedScan {
            fingerprint: fingerprint.finalize().into(),
            selected: None,
        });
    };
    fingerprint.update([1]);
    fingerprint_descriptor(&mut fingerprint, &brainstorm)?;

    let mut selected: Option<DocumentCandidate> = None;
    let session_names = directory_names(&brainstorm, &mut budget)?;
    fingerprint_names(&mut fingerprint, &session_names);
    for session_name in session_names {
        let Some(session_id) = session_name.to_str() else {
            continue;
        };
        if !is_normal_component(session_id) {
            continue;
        }
        let Some(session) = open_optional_directory(brainstorm.as_raw_fd(), session_id)? else {
            fingerprint.update([0]);
            continue;
        };
        fingerprint.update([1]);
        fingerprint_descriptor(&mut fingerprint, &session)?;
        let Some(state) = open_optional_directory(session.as_raw_fd(), "state")? else {
            fingerprint.update([0]);
            continue;
        };
        fingerprint.update([1]);
        fingerprint_descriptor(&mut fingerprint, &state)?;
        let has_server_info = fingerprint_entry(
            &mut fingerprint,
            state.as_raw_fd(),
            std::ffi::OsStr::new("server-info"),
        )?;
        let is_stopped = fingerprint_entry(
            &mut fingerprint,
            state.as_raw_fd(),
            std::ffi::OsStr::new("server-stopped"),
        )?;
        if !has_server_info || is_stopped {
            continue;
        }
        let Some(content) = open_optional_directory(session.as_raw_fd(), "content")? else {
            fingerprint.update([0]);
            continue;
        };
        fingerprint.update([1]);
        fingerprint_descriptor(&mut fingerprint, &content)?;
        let content_names = directory_names(&content, &mut budget)?;
        fingerprint_names(&mut fingerprint, &content_names);
        for file_name in &content_names {
            fingerprint_entry(&mut fingerprint, content.as_raw_fd(), file_name)?;
        }

        let mut session_document = None;
        for file_name in &content_names {
            if Path::new(&file_name)
                .extension()
                .and_then(|value| value.to_str())
                != Some("html")
            {
                continue;
            }
            let Some(file) = open_optional_regular_file(content.as_raw_fd(), file_name)? else {
                continue;
            };
            let metadata = file.metadata().map_err(|_| {
                CompanionError::Internal("failed to inspect visual companion".into())
            })?;
            let candidate = (
                file_name.clone(),
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                metadata.len(),
                file,
            );
            let replace = session_document.as_ref().is_none_or(
                |current: &(
                    std::ffi::OsString,
                    std::time::SystemTime,
                    u64,
                    std::fs::File,
                )| { (&candidate.1, &candidate.0) > (&current.1, &current.0) },
            );
            if replace {
                session_document = Some(candidate);
            }
        }
        let Some((file_name, modified, length, file)) = session_document else {
            continue;
        };
        let candidate = DocumentCandidate {
            session_id: session_id.to_string(),
            file_name,
            modified,
            length,
            file,
            state,
            content,
            content_names,
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

    Ok(PreparedScan {
        fingerprint: fingerprint.finalize().into(),
        selected,
    })
}

#[cfg(unix)]
fn materialize_scan(
    prepared: PreparedScan,
    include_assets: bool,
) -> Result<MaterializedScan, CompanionError> {
    use std::os::fd::AsRawFd;

    let Some(mut selected) = prepared.selected else {
        return Ok(MaterializedScan {
            bundle: None,
            cacheable: true,
        });
    };
    let revision_before = descriptor_revision(&selected)?;
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
    let source_html = String::from_utf8(bytes).map_err(|_| CompanionError::UnsupportedContent)?;
    let document_kind = classify_document(&source_html);
    let prepared_html =
        inline_local_images(&source_html, &selected.content, &selected.content_names);
    let source_origin = discover_source_origin(selected.state.as_raw_fd());
    let assets = if include_assets {
        discover_assets(&selected.content, &selected.content_names)?
    } else {
        OptionalMaterialization::omitted()
    };
    let revision = descriptor_revision(&selected)?;
    if revision != revision_before {
        return Err(CompanionError::Internal(
            "visual companion changed during materialization".into(),
        ));
    }
    Ok(MaterializedScan {
        cacheable: source_origin.cacheable && assets.cacheable && prepared_html.cacheable,
        bundle: Some(CompanionBundle {
            session_id: selected.session_id,
            revision,
            document_kind,
            html: prepared_html.value,
            source_origin: source_origin.value,
            assets: assets.value.unwrap_or_default(),
        }),
    })
}

#[cfg(unix)]
struct PreparedHtml {
    value: String,
    cacheable: bool,
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct ImageSourceAttribute {
    value_start: usize,
    value_end: usize,
}

#[cfg(unix)]
fn inline_local_images(
    html: &str,
    content: &std::os::fd::OwnedFd,
    content_names: &[std::ffi::OsString],
) -> PreparedHtml {
    let mut output = String::with_capacity(html.len());
    let mut copied_until = 0;
    let mut search_from = 0;
    let mut remaining_image_bytes = MAX_COMPANION_INLINE_IMAGE_TOTAL_BYTES;
    let mut cacheable = true;

    while let Some(relative_start) = html[search_from..].find('<') {
        let tag_start = search_from + relative_start;
        if html[tag_start..].starts_with("<!--") {
            search_from = html[tag_start + 4..]
                .find("-->")
                .map_or(html.len(), |end| tag_start + 4 + end + 3);
            continue;
        }
        let Some((name_end, tag_end)) = html_start_tag(html, tag_start) else {
            search_from = tag_start + 1;
            continue;
        };
        let tag_name = &html[tag_start + 1..name_end];
        if tag_name.eq_ignore_ascii_case("script")
            || tag_name.eq_ignore_ascii_case("style")
            || tag_name.eq_ignore_ascii_case("textarea")
            || tag_name.eq_ignore_ascii_case("title")
        {
            let closing = format!("</{tag_name}");
            search_from = find_ascii_case_insensitive(html, tag_end, &closing).unwrap_or(tag_end);
            continue;
        }
        search_from = tag_end;
        if !tag_name.eq_ignore_ascii_case("img") {
            continue;
        }
        let Some(source) = image_source_attribute(html, name_end, tag_end) else {
            continue;
        };
        let raw_source = &html[source.value_start..source.value_end];
        let replacement = match classify_local_image_source(raw_source) {
            LocalImageSource::Passthrough => continue,
            LocalImageSource::OutsideContent => {
                LocalImageReplacement::Rejected("path is outside companion content")
            }
            LocalImageSource::Sibling(file_name) => {
                let resolution =
                    inline_image_data(content, content_names, file_name, remaining_image_bytes);
                cacheable &= resolution.cacheable;
                match resolution.value {
                    Ok((data_uri, raw_bytes)) => LocalImageReplacement::Source {
                        data_uri,
                        raw_bytes,
                    },
                    Err(reason) => LocalImageReplacement::Rejected(reason),
                }
            }
        };

        // Every rewrite is admitted only when the document still fits the cap
        // with the untouched remainder appended, so no path can grow the
        // prepared document past MAX_COMPANION_PREPARED_HTML_BYTES. The source
        // is at most MAX_COMPANION_HTML_BYTES, which is below the cap, so the
        // invariant holds from the first tag onwards. Per-image rewrites keep
        // summary headroom in reserve so the terminal notice below still has
        // room to explain the degradation.
        let pending = output
            .len()
            .saturating_add(tag_start.saturating_sub(copied_until));
        let trailing = html.len().saturating_sub(tag_end);
        let fits = |replacement_len: usize| {
            pending
                .saturating_add(replacement_len)
                .saturating_add(trailing)
                <= MAX_COMPANION_PREPARED_HTML_BYTES
        };
        let fits_reserved = |replacement_len: usize| {
            fits(replacement_len.saturating_add(REMAINING_IMAGES_PLACEHOLDER_RESERVE_BYTES))
        };

        let reason = match replacement {
            LocalImageReplacement::Source {
                data_uri,
                raw_bytes,
            } => {
                let inlined_len = source
                    .value_start
                    .saturating_sub(tag_start)
                    .saturating_add(data_uri.len())
                    .saturating_add(tag_end.saturating_sub(source.value_end));
                if fits_reserved(inlined_len) {
                    output.push_str(&html[copied_until..tag_start]);
                    output.push_str(&html[tag_start..source.value_start]);
                    output.push_str(&data_uri);
                    output.push_str(&html[source.value_end..tag_end]);
                    copied_until = tag_end;
                    remaining_image_bytes = remaining_image_bytes.saturating_sub(raw_bytes);
                    continue;
                }
                // Resolution already paid the file-read and base64-encoding
                // cost. Debit that work even though the data URI cannot be
                // retained so repeated references cannot repeat it beyond the
                // per-document raw-image budget.
                remaining_image_bytes = remaining_image_bytes.saturating_sub(raw_bytes);
                PREPARED_SIZE_EXHAUSTED_REASON
            }
            LocalImageReplacement::Rejected(reason) => reason,
        };

        let placeholder = local_image_placeholder(raw_source, reason);
        if fits_reserved(placeholder.len()) {
            output.push_str(&html[copied_until..tag_start]);
            output.push_str(&placeholder);
            copied_until = tag_end;
            continue;
        }
        // Per-image notices no longer fit. Degrade once, in a bounded form
        // that still names why images are missing, and leave the rest of the
        // source untouched rather than growing past the cap.
        let summary = remaining_images_placeholder(reason);
        if fits(summary.len()) {
            output.push_str(&html[copied_until..tag_start]);
            output.push_str(&summary);
            copied_until = tag_end;
        }
        break;
    }
    output.push_str(&html[copied_until..]);
    PreparedHtml {
        value: output,
        cacheable,
    }
}

#[cfg(unix)]
enum LocalImageReplacement {
    Source { data_uri: String, raw_bytes: u64 },
    Rejected(&'static str),
}

#[cfg(unix)]
const PREPARED_SIZE_EXHAUSTED_REASON: &str = "1.5 MiB prepared document size limit is exhausted";

/// Headroom held back from per-image rewrites so the bounded summary notice
/// still fits once per-image notices do not. Emitting the summary is itself
/// conditional, so an under-estimate can only cost visibility, never the cap.
#[cfg(unix)]
const REMAINING_IMAGES_PLACEHOLDER_RESERVE_BYTES: usize = 512;

#[cfg(unix)]
enum LocalImageSource<'a> {
    Passthrough,
    Sibling(&'a str),
    OutsideContent,
}

#[cfg(unix)]
fn classify_local_image_source(source: &str) -> LocalImageSource<'_> {
    if source.starts_with("data:")
        || source
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return LocalImageSource::Passthrough;
    }
    let candidate = source
        .strip_prefix("/files/")
        .or_else(|| source.strip_prefix("./"))
        .unwrap_or(source);
    if is_normal_component(candidate) && !candidate.contains(['/', '\\']) {
        LocalImageSource::Sibling(candidate)
    } else {
        LocalImageSource::OutsideContent
    }
}

#[cfg(unix)]
struct InlineImageResolution {
    value: Result<(String, u64), &'static str>,
    cacheable: bool,
}

#[cfg(unix)]
fn inline_image_data(
    content: &std::os::fd::OwnedFd,
    content_names: &[std::ffi::OsString],
    file_name: &str,
    remaining_bytes: u64,
) -> InlineImageResolution {
    use std::os::fd::AsRawFd;

    let content_type = companion_asset_content_type(file_name);
    if !matches!(
        content_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    ) {
        return InlineImageResolution {
            value: Err("file type is not a supported passive image"),
            cacheable: true,
        };
    }
    let Some(name) = content_names.iter().find(|name| name == &file_name) else {
        return InlineImageResolution {
            value: Err("file is missing from companion content"),
            cacheable: true,
        };
    };
    let opened = open_optional_materialization_file(content.as_raw_fd(), name);
    let Some(mut file) = opened.value else {
        return InlineImageResolution {
            value: Err("file is unavailable or unsafe"),
            cacheable: opened.cacheable,
        };
    };
    let metadata = match optional_file_metadata(&file, name) {
        Ok(metadata) => metadata,
        Err(error) => {
            let classified = classify_optional_error::<()>(&error);
            return InlineImageResolution {
                value: Err("file is unavailable or unsafe"),
                cacheable: classified.cacheable,
            };
        }
    };
    if metadata.len() > remaining_bytes {
        return InlineImageResolution {
            value: Err("768 KiB document image budget is exhausted"),
            cacheable: true,
        };
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if let Err(error) = optional_read_to_end(
        &mut file,
        name,
        remaining_bytes.saturating_add(1),
        &mut bytes,
    ) {
        let classified = classify_optional_error::<()>(&error);
        return InlineImageResolution {
            value: Err("file could not be read safely"),
            cacheable: classified.cacheable,
        };
    }
    if bytes.len() as u64 > remaining_bytes {
        return InlineImageResolution {
            value: Err("768 KiB document image budget is exhausted"),
            cacheable: true,
        };
    }
    let raw_bytes = bytes.len() as u64;
    InlineImageResolution {
        value: Ok((
            format!(
                "data:{content_type};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            raw_bytes,
        )),
        cacheable: true,
    }
}

#[cfg(unix)]
fn local_image_placeholder(source: &str, reason: &str) -> String {
    image_placeholder(&format!("Image unavailable: {source} ({reason})."))
}

/// A single, source-independent notice standing in for every image left
/// unprepared once per-image notices no longer fit the prepared document.
/// Reasons are a closed set of static strings, so this is bounded regardless
/// of the document it degrades.
#[cfg(unix)]
fn remaining_images_placeholder(reason: &str) -> String {
    let label = if reason == PREPARED_SIZE_EXHAUSTED_REASON {
        format!("Remaining images unavailable: {reason}.")
    } else {
        format!("Remaining images unavailable: {reason}, and {PREPARED_SIZE_EXHAUSTED_REASON}.")
    };
    image_placeholder(&label)
}

#[cfg(unix)]
fn image_placeholder(label: &str) -> String {
    let escaped = escape_html_text(label);
    format!(
        r#"<span class="kanna-companion-image-placeholder" role="img" aria-label="{escaped}">{escaped}</span>"#
    )
}

#[cfg(unix)]
fn escape_html_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(unix)]
fn html_start_tag(html: &str, start: usize) -> Option<(usize, usize)> {
    let bytes = html.as_bytes();
    let mut cursor = start.checked_add(1)?;
    let first = *bytes.get(cursor)?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    while bytes
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':'))
    {
        cursor += 1;
    }
    let name_end = cursor;
    let mut quote = None;
    while let Some(byte) = bytes.get(cursor).copied() {
        match (quote, byte) {
            (Some(expected), current) if current == expected => quote = None,
            (None, b'\'' | b'"') => quote = Some(byte),
            (None, b'>') => return Some((name_end, cursor + 1)),
            _ => {}
        }
        cursor += 1;
    }
    None
}

#[cfg(unix)]
fn image_source_attribute(
    html: &str,
    name_end: usize,
    tag_end: usize,
) -> Option<ImageSourceAttribute> {
    let bytes = html.as_bytes();
    let mut cursor = name_end;
    while cursor + 1 < tag_end {
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if matches!(bytes.get(cursor), Some(b'/') | Some(b'>')) {
            cursor += 1;
            continue;
        }
        let attribute_start = cursor;
        while bytes
            .get(cursor)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'=' | b'/' | b'>'))
        {
            cursor += 1;
        }
        if cursor == attribute_start {
            cursor += 1;
            continue;
        }
        let name = &html[attribute_start..cursor];
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let quote = bytes
            .get(cursor)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'));
        if quote.is_some() {
            cursor += 1;
        }
        let value_start = cursor;
        while let Some(byte) = bytes.get(cursor).copied() {
            if quote.is_some_and(|expected| byte == expected)
                || (quote.is_none() && (byte.is_ascii_whitespace() || byte == b'>'))
            {
                break;
            }
            cursor += 1;
        }
        let value_end = cursor;
        if quote.is_some() && cursor < tag_end {
            cursor += 1;
        }
        if name.eq_ignore_ascii_case("src") {
            return Some(ImageSourceAttribute {
                value_start,
                value_end,
            });
        }
    }
    None
}

#[cfg(unix)]
fn find_ascii_case_insensitive(html: &str, start: usize, needle: &str) -> Option<usize> {
    let needle_len = needle.len();
    html.get(start..)?
        .char_indices()
        .map(|(offset, _)| start + offset)
        .find(|candidate| {
            html.get(*candidate..candidate.saturating_add(needle_len))
                .is_some_and(|value| value.eq_ignore_ascii_case(needle))
        })
}

#[cfg(unix)]
fn discover_source_origin(state_fd: std::os::fd::RawFd) -> OptionalMaterialization<String> {
    let name = std::ffi::OsStr::new("server-info");
    let mut file = match open_optional_materialization_file(state_fd, name) {
        OptionalMaterialization {
            value: Some(file), ..
        } => file,
        OptionalMaterialization {
            value: None,
            cacheable,
        } => {
            return OptionalMaterialization {
                value: None,
                cacheable,
            };
        }
    };
    let length = match optional_file_metadata(&file, name) {
        Ok(metadata) => metadata.len(),
        Err(error) => return classify_optional_error(&error),
    };
    if length > MAX_SERVER_INFO_BYTES {
        return OptionalMaterialization::omitted();
    }
    let mut bytes = Vec::with_capacity(length as usize);
    if let Err(error) = optional_read_to_end(&mut file, name, MAX_SERVER_INFO_BYTES + 1, &mut bytes)
    {
        return classify_optional_error(&error);
    }
    if bytes.len() as u64 > MAX_SERVER_INFO_BYTES {
        return OptionalMaterialization::omitted();
    }
    let Some(origin) = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|metadata| metadata.get("url")?.as_str().map(str::to_string))
        .and_then(|origin| normalize_source_origin(&origin))
    else {
        return OptionalMaterialization::omitted();
    };
    OptionalMaterialization::value(origin)
}

fn normalize_source_origin(raw: &str) -> Option<String> {
    let (host, port) = parse_raw_loopback_origin(raw)?;
    Some(format!("http://{host}:{port}"))
}

fn parse_raw_loopback_origin(raw: &str) -> Option<(&'static str, u16)> {
    let (scheme, remainder) = raw.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let suffix_start = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..suffix_start];
    let suffix = &remainder[suffix_start..];
    if authority.contains('@') {
        return None;
    }
    if !suffix.is_empty()
        && !suffix.strip_prefix('/').is_some_and(|root_suffix| {
            root_suffix.is_empty() || root_suffix.starts_with('?') || root_suffix.starts_with('#')
        })
    {
        return None;
    }

    let (host, port_text) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after_bracket) = bracketed.split_once(']')?;
        if host != "::1" {
            return None;
        }
        ("[::1]", after_bracket.strip_prefix(':')?)
    } else {
        let (host, port) = authority.rsplit_once(':')?;
        if host.contains(':') {
            return None;
        }
        let normalized_host = if host.eq_ignore_ascii_case("localhost") {
            "localhost"
        } else if host == "127.0.0.1" {
            "127.0.0.1"
        } else {
            return None;
        };
        (normalized_host, port)
    };
    if port_text.is_empty() || !port_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = port_text.parse::<u16>().ok()?;
    (port != 0).then_some((host, port))
}

#[cfg(unix)]
fn discover_assets(
    content: &std::os::fd::OwnedFd,
    names: &[std::ffi::OsString],
) -> Result<OptionalMaterialization<Vec<CompanionAsset>>, CompanionError> {
    use std::os::fd::AsRawFd;

    let mut assets = Vec::new();
    let mut total_bytes = 0_u64;
    let mut cacheable = true;
    for file_name in names {
        if assets.len() == MAX_COMPANION_ASSET_COUNT {
            break;
        }
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !is_normal_component(name) || is_html_file(name) {
            continue;
        }
        let opened = open_optional_materialization_file(content.as_raw_fd(), file_name);
        cacheable &= opened.cacheable;
        let Some(mut file) = opened.value else {
            continue;
        };
        let length = match optional_file_metadata(&file, file_name) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                cacheable &= classify_optional_error::<()>(&error).cacheable;
                continue;
            }
        };
        if length > MAX_COMPANION_ASSET_BYTES
            || total_bytes.saturating_add(length) > MAX_COMPANION_ASSET_TOTAL_BYTES
        {
            continue;
        }
        let mut bytes = Vec::with_capacity(length as usize);
        if let Err(error) = optional_read_to_end(
            &mut file,
            file_name,
            MAX_COMPANION_ASSET_BYTES + 1,
            &mut bytes,
        ) {
            cacheable &= classify_optional_error::<()>(&error).cacheable;
            continue;
        }
        if bytes.len() as u64 > MAX_COMPANION_ASSET_BYTES
            || total_bytes.saturating_add(bytes.len() as u64) > MAX_COMPANION_ASSET_TOTAL_BYTES
        {
            continue;
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        assets.push(CompanionAsset {
            name: name.to_string(),
            content_type: companion_asset_content_type(name).to_string(),
            digest,
            data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
        total_bytes += bytes.len() as u64;
    }
    Ok(OptionalMaterialization {
        value: Some(assets),
        cacheable,
    })
}

#[cfg(unix)]
fn open_optional_materialization_file(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
) -> OptionalMaterialization<std::fs::File> {
    if let Some(error) = injected_optional_failure(name, OptionalFailureStage::Open) {
        return classify_optional_error(&error);
    }
    let descriptor = match openat_owned(
        directory_fd,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        0,
    ) {
        Ok(descriptor) => descriptor,
        Err(error) => return classify_optional_error(&error),
    };
    let file = std::fs::File::from(descriptor);
    let metadata = match optional_file_metadata(&file, name) {
        Ok(metadata) => metadata,
        Err(error) => return classify_optional_error(&error),
    };
    if has_safe_regular_file_identity(&metadata) {
        OptionalMaterialization::value(file)
    } else {
        OptionalMaterialization::degraded()
    }
}

#[cfg(unix)]
fn has_safe_regular_file_identity(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    metadata.is_file() && metadata.nlink() == 1 && metadata.uid() == unsafe { libc::geteuid() }
}

#[cfg(unix)]
fn optional_file_metadata(
    file: &std::fs::File,
    name: &std::ffi::OsStr,
) -> Result<std::fs::Metadata, std::io::Error> {
    if let Some(error) = injected_optional_failure(name, OptionalFailureStage::Metadata) {
        return Err(error);
    }
    file.metadata()
}

#[cfg(unix)]
fn optional_read_to_end(
    file: &mut std::fs::File,
    name: &std::ffi::OsStr,
    limit: u64,
    bytes: &mut Vec<u8>,
) -> Result<(), std::io::Error> {
    if let Some(error) = injected_optional_failure(name, OptionalFailureStage::Read) {
        return Err(error);
    }
    file.take(limit).read_to_end(bytes).map(|_| ())
}

#[cfg(unix)]
fn classify_optional_error<T>(error: &std::io::Error) -> OptionalMaterialization<T> {
    if matches!(
        error.raw_os_error(),
        Some(code)
            if code == libc::ENOENT
                || code == libc::ENOTDIR
                || code == libc::ELOOP
                || code == libc::EACCES
                || code == libc::EPERM
                || code == libc::ENXIO
                || code == libc::EISDIR
    ) {
        OptionalMaterialization::omitted()
    } else {
        OptionalMaterialization::degraded()
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OptionalFailureStage {
    Open,
    Metadata,
    Read,
}

#[cfg(all(test, unix))]
#[derive(Clone)]
struct InjectedOptionalFailure {
    name: std::ffi::OsString,
    stage: OptionalFailureStage,
}

#[cfg(all(test, unix))]
std::thread_local! {
    static INJECTED_OPTIONAL_FAILURE: std::cell::RefCell<Option<InjectedOptionalFailure>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(crate) struct OptionalFailureGuard(Option<InjectedOptionalFailure>);

#[cfg(all(test, unix))]
impl Drop for OptionalFailureGuard {
    fn drop(&mut self) {
        let previous = self.0.take();
        INJECTED_OPTIONAL_FAILURE.with(|injected| {
            injected.replace(previous);
        });
    }
}

#[cfg(all(test, unix))]
pub(crate) fn inject_optional_materialization_failure_for_test(
    name: impl Into<std::ffi::OsString>,
    stage: OptionalFailureStage,
) -> OptionalFailureGuard {
    let failure = InjectedOptionalFailure {
        name: name.into(),
        stage,
    };
    let previous = INJECTED_OPTIONAL_FAILURE.with(|injected| injected.replace(Some(failure)));
    OptionalFailureGuard(previous)
}

#[cfg(all(test, unix))]
fn injected_optional_failure(
    name: &std::ffi::OsStr,
    stage: OptionalFailureStage,
) -> Option<std::io::Error> {
    INJECTED_OPTIONAL_FAILURE.with(|injected| {
        injected
            .borrow()
            .as_ref()
            .filter(|failure| failure.name == name && failure.stage == stage)
            .map(|_| std::io::Error::from_raw_os_error(libc::EIO))
    })
}

#[cfg(all(not(test), unix))]
fn injected_optional_failure(
    _name: &std::ffi::OsStr,
    _stage: OptionalFailureStage,
) -> Option<std::io::Error> {
    None
}

fn is_html_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

fn companion_asset_content_type(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("css") {
        "text/css"
    } else if extension.eq_ignore_ascii_case("txt") {
        "text/plain"
    } else if extension.eq_ignore_ascii_case("png") {
        "image/png"
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        "image/jpeg"
    } else if extension.eq_ignore_ascii_case("gif") {
        "image/gif"
    } else if extension.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if extension.eq_ignore_ascii_case("avif") {
        "image/avif"
    } else if extension.eq_ignore_ascii_case("ico") {
        "image/x-icon"
    } else if extension.eq_ignore_ascii_case("woff") {
        "font/woff"
    } else if extension.eq_ignore_ascii_case("woff2") {
        "font/woff2"
    } else if extension.eq_ignore_ascii_case("ttf") {
        "font/ttf"
    } else if extension.eq_ignore_ascii_case("otf") {
        "font/otf"
    } else {
        "application/octet-stream"
    }
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

#[cfg(unix)]
fn descriptor_revision(selected: &DocumentCandidate) -> Result<String, CompanionError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    fn update_component(hasher: &mut Sha256, value: &[u8]) {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value);
    }

    let mut hasher = Sha256::new();
    hasher.update(b"kanna-companion-descriptor-revision-v1");
    update_component(&mut hasher, selected.session_id.as_bytes());
    update_component(&mut hasher, selected.file_name.as_bytes());
    fingerprint_descriptor(&mut hasher, &selected.content)?;
    fingerprint_names(&mut hasher, &selected.content_names);
    for name in &selected.content_names {
        fingerprint_entry(&mut hasher, selected.content.as_raw_fd(), name)?;
    }
    Ok(format!("descriptor-sha256:{:x}", hasher.finalize()))
}

#[cfg(unix)]
fn fingerprint_names(hasher: &mut Sha256, names: &[std::ffi::OsString]) {
    use std::os::unix::ffi::OsStrExt;

    hasher.update((names.len() as u64).to_le_bytes());
    for name in names {
        let bytes = name.as_bytes();
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
}

#[cfg(unix)]
fn fingerprint_descriptor(
    hasher: &mut Sha256,
    descriptor: &std::os::fd::OwnedFd,
) -> Result<(), CompanionError> {
    let file = std::fs::File::from(duplicate_descriptor(descriptor)?);
    let metadata = file.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion metadata".into())
    })?;
    fingerprint_metadata(hasher, &metadata);
    Ok(())
}

#[cfg(unix)]
fn fingerprint_metadata(hasher: &mut Sha256, metadata: &std::fs::Metadata) {
    use std::os::unix::fs::MetadataExt;

    hasher.update(metadata.dev().to_le_bytes());
    hasher.update(metadata.ino().to_le_bytes());
    hasher.update(metadata.mode().to_le_bytes());
    hasher.update(metadata.size().to_le_bytes());
    hasher.update(metadata.mtime().to_le_bytes());
    hasher.update(metadata.mtime_nsec().to_le_bytes());
    hasher.update(metadata.ctime().to_le_bytes());
    hasher.update(metadata.ctime_nsec().to_le_bytes());
}

#[cfg(unix)]
fn fingerprint_entry(
    hasher: &mut Sha256,
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::OsStr,
) -> Result<bool, CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    let name_bytes = name.as_bytes();
    hasher.update((name_bytes.len() as u64).to_le_bytes());
    hasher.update(name_bytes);
    let name = std::ffi::CString::new(name_bytes)
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
        hasher.update([1]);
        fingerprint_stat(hasher, &unsafe { metadata.assume_init() });
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        hasher.update([0]);
        Ok(false)
    } else {
        Err(CompanionError::Internal(
            "failed to inspect visual companion entry".into(),
        ))
    }
}

#[cfg(unix)]
fn fingerprint_stat(hasher: &mut Sha256, metadata: &libc::stat) {
    hasher.update((metadata.st_dev as u64).to_le_bytes());
    hasher.update(metadata.st_ino.to_le_bytes());
    hasher.update((metadata.st_mode as u64).to_le_bytes());
    hasher.update(metadata.st_size.to_le_bytes());
    hasher.update(metadata.st_mtime.to_le_bytes());
    hasher.update(metadata.st_mtime_nsec.to_le_bytes());
    hasher.update(metadata.st_ctime.to_le_bytes());
    hasher.update(metadata.st_ctime_nsec.to_le_bytes());
}

#[cfg(unix)]
struct DirectoryStream(*mut libc::DIR);

#[cfg(unix)]
impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}

#[cfg(unix)]
fn directory_names(
    directory: &std::os::fd::OwnedFd,
    budget: &mut DirectoryBudget,
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
    let stream = DirectoryStream(stream);
    // dup shares the underlying directory offset. Reset the duplicated stream
    // so repeated scans through a retained content descriptor remain complete.
    unsafe { libc::rewinddir(stream.0) };
    collect_directory_names(
        || loop {
            set_errno(0);
            // The stream stays valid until the next call; copy the name now.
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                let error = get_errno();
                return if error == 0 {
                    Ok(None)
                } else {
                    Err(std::io::Error::from_raw_os_error(error))
                };
            }
            let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes != b"." && bytes != b".." {
                return Ok(Some(std::ffi::OsString::from_vec(bytes.to_vec())));
            }
        },
        budget,
    )
}

#[cfg(unix)]
fn collect_directory_names(
    mut next: impl FnMut() -> Result<Option<std::ffi::OsString>, std::io::Error>,
    budget: &mut DirectoryBudget,
) -> Result<Vec<std::ffi::OsString>, CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    let mut names = Vec::new();
    loop {
        match next() {
            Ok(Some(name)) => {
                budget.charge(name.as_bytes().len())?;
                names.push(name);
            }
            Ok(None) => break,
            Err(_) => {
                return Err(CompanionError::Internal(
                    "failed to enumerate visual companions".into(),
                ));
            }
        }
    }
    names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(names)
}

#[cfg(all(test, unix))]
pub(crate) fn collect_directory_names_for_test(
    next: impl FnMut() -> Result<Option<std::ffi::OsString>, std::io::Error>,
) -> Result<Vec<std::ffi::OsString>, CompanionError> {
    collect_directory_names(next, &mut DirectoryBudget::default())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(unix)]
fn set_errno(value: libc::c_int) {
    unsafe { *errno_location() = value };
}

#[cfg(unix)]
fn get_errno() -> libc::c_int {
    unsafe { *errno_location() }
}

#[cfg(unix)]
pub(crate) fn open_optional_directory(
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
pub(crate) fn open_or_create_directory(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<std::os::fd::OwnedFd, CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    if !is_normal_component(name) {
        return Err(CompanionError::Internal(
            "invalid visual companion directory name".into(),
        ));
    }
    let name_c = std::ffi::CString::new(std::ffi::OsStr::new(name).as_bytes())
        .map_err(|_| CompanionError::Internal("invalid visual companion directory name".into()))?;
    let created = unsafe { libc::mkdirat(directory_fd, name_c.as_ptr(), 0o700) } == 0;
    if !created && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(CompanionError::Internal(
            "failed to create visual companion directory".into(),
        ));
    }
    let opened = open_optional_directory(directory_fd, name)?.ok_or_else(|| {
        CompanionError::Internal("visual companion directory is not a directory".into())
    })?;
    if created && unsafe { libc::fsync(directory_fd) } != 0 {
        return Err(CompanionError::Internal(
            "failed to sync visual companion directory".into(),
        ));
    }
    Ok(opened)
}

#[cfg(unix)]
pub(crate) fn open_optional_marker_file(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<Option<std::fs::File>, CompanionError> {
    if !is_normal_component(name) {
        return Err(CompanionError::Internal(
            "invalid visual companion marker name".into(),
        ));
    }
    let flags =
        libc::O_RDWR | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let descriptor = match openat_owned(directory_fd, std::ffi::OsStr::new(name), flags, 0o600) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(CompanionError::Internal(
                "failed to open visual companion marker".into(),
            ))
        }
    };
    let file = std::fs::File::from(descriptor);
    let metadata = file.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion marker".into())
    })?;
    if !has_safe_regular_file_identity(&metadata) {
        return Err(CompanionError::Internal(
            "visual companion marker has an unsafe identity".into(),
        ));
    }
    Ok(Some(file))
}

#[cfg(unix)]
pub(crate) fn create_marker_file(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<Option<std::fs::File>, CompanionError> {
    if !is_normal_component(name) {
        return Err(CompanionError::Internal(
            "invalid visual companion marker name".into(),
        ));
    }
    let flags = libc::O_RDWR
        | libc::O_APPEND
        | libc::O_CREAT
        | libc::O_EXCL
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK;
    match openat_owned(directory_fd, std::ffi::OsStr::new(name), flags, 0o600) {
        Ok(file) => Ok(Some(std::fs::File::from(file))),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(_) => Err(CompanionError::Internal(
            "failed to create visual companion marker".into(),
        )),
    }
}

#[cfg(unix)]
pub(crate) fn rename_marker_file(
    directory_fd: std::os::fd::RawFd,
    from: &str,
    to: &str,
) -> Result<(), CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    if !is_normal_component(from) || !is_normal_component(to) {
        return Err(CompanionError::Internal(
            "invalid visual companion marker name".into(),
        ));
    }
    let from = std::ffi::CString::new(std::ffi::OsStr::new(from).as_bytes())
        .map_err(|_| CompanionError::Internal("invalid visual companion marker name".into()))?;
    let to = std::ffi::CString::new(std::ffi::OsStr::new(to).as_bytes())
        .map_err(|_| CompanionError::Internal("invalid visual companion marker name".into()))?;
    if unsafe { libc::renameat(directory_fd, from.as_ptr(), directory_fd, to.as_ptr()) } != 0 {
        return Err(CompanionError::Internal(
            "failed to commit visual companion marker".into(),
        ));
    }
    if unsafe { libc::fsync(directory_fd) } != 0 {
        return Err(CompanionError::Internal(
            "failed to sync visual companion marker directory".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn remove_marker_file(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<(), CompanionError> {
    use std::os::unix::ffi::OsStrExt;

    if !is_normal_component(name) {
        return Err(CompanionError::Internal(
            "invalid visual companion marker name".into(),
        ));
    }
    let name = std::ffi::CString::new(std::ffi::OsStr::new(name).as_bytes())
        .map_err(|_| CompanionError::Internal("invalid visual companion marker name".into()))?;
    if unsafe { libc::unlinkat(directory_fd, name.as_ptr(), 0) } != 0 {
        return Err(CompanionError::Internal(
            "failed to remove visual companion marker".into(),
        ));
    }
    if unsafe { libc::fsync(directory_fd) } != 0 {
        return Err(CompanionError::Internal(
            "failed to sync visual companion marker directory".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn marker_directory_names(
    directory: &std::os::fd::OwnedFd,
) -> Result<Vec<std::ffi::OsString>, CompanionError> {
    directory_names(directory, &mut DirectoryBudget::default())
}

#[cfg(unix)]
pub(crate) fn open_optional_regular_file(
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
    Ok(has_safe_regular_file_identity(&metadata).then_some(file))
}

#[cfg(unix)]
pub(crate) fn open_append_regular_file(
    directory_fd: std::os::fd::RawFd,
    name: &str,
) -> Result<(std::fs::File, bool), CompanionError> {
    let name = std::ffi::OsStr::new(name);
    let flags =
        libc::O_RDWR | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let mut create_races = 0;
    let (file, created) = loop {
        match openat_owned(directory_fd, name, flags, 0o600) {
            Ok(file) => break (std::fs::File::from(file), false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match openat_owned(
                    directory_fd,
                    name,
                    flags | libc::O_CREAT | libc::O_EXCL,
                    0o600,
                ) {
                    Ok(file) => break (std::fs::File::from(file), true),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        create_races += 1;
                        if create_races < 4 {
                            continue;
                        }
                        return Err(CompanionError::Internal(
                            "visual companion events changed repeatedly during creation".into(),
                        ));
                    }
                    Err(error) => {
                        return Err(CompanionError::Internal(format!(
                            "failed to create visual companion events: {error}"
                        )));
                    }
                }
            }
            Err(error) => {
                return Err(CompanionError::Internal(format!(
                    "failed to open visual companion events: {error}"
                )));
            }
        }
    };
    let metadata = file.metadata().map_err(|_| {
        CompanionError::Internal("failed to inspect visual companion events".into())
    })?;
    if !has_safe_regular_file_identity(&metadata) {
        return Err(CompanionError::Internal(
            "visual companion events has an unsafe identity".into(),
        ));
    }
    Ok((file, created))
}

#[cfg(unix)]
pub(crate) fn open_file_identity(
    descriptor: &std::os::fd::OwnedFd,
) -> Result<(libc::dev_t, libc::ino_t), CompanionError> {
    use std::os::fd::AsRawFd;

    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(CompanionError::Internal(
            "failed to inspect task workspace identity".into(),
        ));
    }
    let metadata = unsafe { metadata.assume_init() };
    Ok((metadata.st_dev, metadata.st_ino))
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
fn duplicate_descriptor(
    descriptor: &std::os::fd::OwnedFd,
) -> Result<std::os::fd::OwnedFd, CompanionError> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let duplicate = unsafe { libc::dup(descriptor.as_raw_fd()) };
    if duplicate < 0 {
        return Err(CompanionError::Internal(
            "failed to retain visual companion content".into(),
        ));
    }
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(duplicate) })
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
