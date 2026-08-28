//! SQLite schema and accessors.
//!
//! **Naming note.** The product concept is a *workflow*; the storage layer
//! still spells it *pipeline*. The `pipeline_item` table (a task), its
//! `pipeline` / `pipeline_def` / `initial_pipeline` columns, the
//! `pipeline_item_id` foreign keys, the `idx_pipeline_item_*` indices, and the
//! recorded migration ids are all deliberately left under the old name — a
//! table rename buys the least and risks the most, and migration ids are
//! immutable once recorded. Identifiers here that name *the table or its
//! columns* therefore keep saying `pipeline_item` / `pipeline`; identifiers
//! that name *the concept* say workflow. See
//! `docs/2026-08-19-workflow-rename-remaining-debt.md`.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

mod analytics;
mod blockers;
mod create_intents;
mod operator_events;
mod pipeline_items;
mod ports;
mod repos;
mod settings;
mod snapshot;
mod stage_runs;
mod task_events;
mod task_inputs;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod transfer_work;
mod transfers;
mod worktrees;

#[allow(unused_imports)]
pub use analytics::RepoAnalytics;
pub use blockers::ReplaceTaskBlockersError;
#[allow(unused_imports)]
pub use operator_events::NewOperatorEvent;
#[allow(unused_imports)]
pub use pipeline_items::MergeSignalSource;
#[allow(unused_imports)]
pub use stage_runs::FinishedStageRun;
#[allow(unused_imports)]
pub use task_events::{appended as task_event_appended, TaskEvent, TaskEventKind, TaskEventScope};
#[allow(unused_imports)]
pub use task_inputs::{TaskInputRecord, TaskInputSource};
#[allow(unused_imports)]
pub use transfer_work::{TransferWorkItem, MAX_TRANSFER_WORK_ATTEMPTS};
pub use transfers::{
    is_active_outgoing_transfer_conflict, NewTaskTransfer, NewTaskTransferProvenance,
    PendingIncomingTransfer, TaskTransfer,
};

const SQLITE_BUSY_TIMEOUT_MS: u64 = 10_000;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES: i64 = 100;
#[cfg(test)]
pub(crate) const CURRENT_SCHEMA_MIGRATIONS: &[&str] = &[
    "001_default_settings",
    "002_pipeline_item_metadata_columns",
    "003_legacy_stage_to_tags_backfill",
    "004_activity_log_accumulator",
    "005_task_blocker_table",
    "006_operator_event_table",
    "007_pipeline_stage_columns",
    "008_tags_to_stage_backfill",
    "009_task_port_table",
    "010_rename_torndown_stage",
    "011_pipeline_item_last_output_preview",
    "012_pipeline_item_active_post_action",
    "013_task_transfer_tables",
    "014_task_transfer_payload_json",
    "015_agent_session_id_rename",
    "016_repo_sort_order",
    "016_task_teardown_state",
    "017_theme_preferences",
    "018_merge_stage_to_in_progress",
    "019_repo_remote_metadata_columns",
    "020_agent_message_appearance_preference",
    "020_pipeline_item_notify_task",
    "021_pipeline_item_agent_spawn_options",
    "022_pipeline_item_parent_task_id",
    "023_stage_run_pipeline_snapshot",
    "024_pipeline_item_stage_graph_cleanup",
    "025_stage_run_kind",
    "026_stage_run_resume",
    "027_pipeline_item_pr_branch",
    "028_stage_run_completion_transition",
    "029_pipeline_item_activity_revision",
    "030_pipeline_item_cloud_task_id",
    "031_task_transfer_cloud_desktop_ids",
    "032_task_transfer_sidecar_cleanup",
    "033_create_task_intent",
    "034_pipeline_item_revision_rounds",
    "035_pipeline_item_blocker_revision",
    "036_task_transfer_ownership_leases",
    "037_task_event_log",
    "038_pipeline_item_initial_pipeline",
    "039_stage_run_resume_fallback_reason",
    "040_stage_run_effort",
    "041_pipeline_item_parentage_index",
    "042_task_approval_lineage",
    "043_task_approval_atomic_projection",
    "044_task_approval_authorization",
    "045_agent_signal_protocol",
    "046_completion_and_merge_delivery_binding",
    "047_remove_approval_gate",
    "048_pipeline_item_merge_signaled",
    "049_transfer_work_queue",
    "050_transfer_work_phase_value",
    "051_repo_remote_hash_task_event_indexes",
    "052_task_input_log",
    "053_pipeline_item_input_blocked",
    "054_pipeline_item_composer",
    "055_activity_event_debounce",
    "056_runtime_settled_debounce",
    "057_queued_task_input",
    "058_queued_task_input_session_incarnation",
];

#[derive(Debug, Serialize)]
pub struct PipelineItem {
    pub id: String,
    pub cloud_task_id: Option<String>,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    /// The task's workflow name. `pipeline` is the legacy storage column name
    /// (see [`crate::db`] — the table rename is deliberate remaining debt).
    pub pipeline: Option<String>,
    pub stage: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    /// Derived display value blending the runtime and read dimensions:
    /// `working` | `idle` | `unread`. Read `runtime_status` for what the agent
    /// process is doing and `activity == "unread"` for whether a human has
    /// read the latest output; neither is recoverable from this field alone.
    pub activity: Option<String>,
    pub activity_revision: i64,
    pub activity_changed_at: Option<String>,
    /// The runtime dimension: the daemon's selection-independent verdict on
    /// the task's agent session — `busy` | `waiting` | `idle` | `exited`, or
    /// `None` when no session has ever reported one.
    pub runtime_status: Option<String>,
    /// Why the task's agent session refuses messages delivered into it, or
    /// `None` when it accepts them. Today the only value is
    /// `inherited-draft-unknown`: the daemon adopted the session across a
    /// restart or handoff and its composer holds text nobody here saw typed,
    /// so submitting would append to an unsent line.
    pub input_blocked: Option<String>,
    /// The text the task's agent session currently renders on its composer
    /// line, or `None` when it draws no readable composer. Never folded into
    /// `last_output_preview`: this is what somebody is about to say, or what
    /// the CLI is suggesting they say, and a reader that cannot tell it from
    /// transcript acts on a sentence nobody wrote.
    pub composer_text: Option<String>,
    /// What the daemon can prove about that text: `typed` (keystrokes reached
    /// it since the last submission boundary), `not-typed` (an attested
    /// session with none, so the text is provably CLI chrome), or `unknown`
    /// (a session inherited from before attestation). `None` when no session
    /// has reported one yet.
    pub composer_attestation: Option<String>,
    pub closed_at: Option<String>,
    pub pinned: Option<i64>,
    pub pin_order: Option<i64>,
    pub display_name: Option<String>,
    pub last_output_preview: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub base_ref: Option<String>,
    pub notify_task_id: Option<String>,
    pub notified_at: Option<String>,
    pub parent_task_id: Option<String>,
    /// The task's pinned workflow definition JSON. `pipeline_def` is the
    /// legacy storage column name.
    pub pipeline_def: Option<String>,
    /// Agent-requested revision rounds since the last human-requested one.
    /// Bounds autonomous review/revise loops; a human revision resets it.
    pub revision_rounds: i64,
}

/// One direct child of a parent task, as the fan-out history surfaces read it:
/// its identity, the workflow that classifies it, and its lifecycle timestamps.
/// The verdict itself lives on the child's latest `stage_run`.
#[derive(Debug, Serialize)]
pub struct PipelineItemChild {
    pub id: String,
    pub pipeline: Option<String>,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub remote_url_hash: Option<String>,
    pub hidden: Option<i64>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SnapshotRepo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub remote_url: Option<String>,
    pub remote_url_hash: Option<String>,
    pub hidden: i64,
    pub sort_order: i64,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SnapshotPipelineItem {
    pub id: String,
    pub cloud_task_id: String,
    pub transfer_id: Option<String>,
    pub transfer_direction: Option<String>,
    pub transfer_status: Option<String>,
    pub transfer_source_peer_id: Option<String>,
    pub transfer_target_peer_id: Option<String>,
    pub transfer_source_desktop_id: Option<String>,
    pub transfer_target_desktop_id: Option<String>,
    pub transfer_error: Option<String>,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    pub pipeline: String,
    pub pipeline_def: Option<String>,
    pub stage: String,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub closed_at: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: String,
    pub activity: String,
    pub activity_revision: i64,
    pub blocker_revision: i64,
    pub transition_revision: Option<String>,
    pub activity_changed_at: Option<String>,
    pub unread_at: Option<String>,
    pub port_offset: Option<i64>,
    pub display_name: Option<String>,
    pub last_output_preview: Option<String>,
    pub port_env: Option<String>,
    pub agent_spawn_options: Option<String>,
    pub pinned: i64,
    pub pin_order: Option<i64>,
    pub base_ref: Option<String>,
    pub agent_session_id: Option<String>,
    pub teardown_started_at: Option<String>,
    pub parent_task_id: Option<String>,
    pub notify_task_id: Option<String>,
    pub notified_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub has_running_post: i64,
    pub queued_input_count: i64,
    pub queued_input_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SnapshotTaskBlocker {
    pub blocked_item_id: String,
    pub blocker_item_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotBlockerTaskState {
    pub closed_at: Option<String>,
    pub stage: Option<String>,
    pub pr_url: Option<String>,
}

impl SnapshotBlockerTaskState {
    pub fn is_resolved(&self) -> bool {
        self.closed_at.is_some() || (self.stage.as_deref() == Some("pr") && self.pr_url.is_some())
    }
}

#[derive(Debug, Serialize)]
pub struct ClosedTaskIdentity {
    pub id: String,
    pub repo_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudTaskIdentityWrite {
    Updated,
    Unchanged,
    Conflict,
    TaskNotFound,
}

#[derive(Debug)]
pub enum ReopenPipelineItemError {
    OwnershipConflict,
    Database(rusqlite::Error),
}

impl From<rusqlite::Error> for ReopenPipelineItemError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub repo: SnapshotRepo,
    pub items: Vec<SnapshotPipelineItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSnapshot {
    pub entries: Vec<SnapshotEntry>,
    pub task_blockers: Vec<SnapshotTaskBlocker>,
    pub blocker_task_states: HashMap<String, SnapshotBlockerTaskState>,
    pub worktree_paths: HashMap<String, String>,
    pub settings: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct WorktreeRecord {
    pub pipeline_item_id: String,
    pub path: String,
    pub branch: String,
}

pub struct NewRepo<'a> {
    pub id: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub default_branch: Option<&'a str>,
}

pub struct TaskStageSource {
    pub repo_id: String,
    #[allow(dead_code)]
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    #[allow(dead_code)]
    pub display_name: Option<String>,
    pub stage: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub pipeline: Option<String>,
    pub pipeline_def: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    pub closed_at: Option<String>,
}

pub struct NewPipelineItem<'a> {
    pub id: &'a str,
    pub repo_id: &'a str,
    pub prompt: &'a str,
    pub display_name: Option<&'a str>,
    pub pipeline: &'a str,
    pub stage: &'a str,
    pub branch: &'a str,
    pub agent_type: &'a str,
    pub agent_provider: &'a str,
    pub activity: &'a str,
    pub port_offset: Option<i64>,
    pub port_env_json: Option<&'a str>,
    pub agent_spawn_options_json: Option<&'a str>,
    pub base_ref: Option<&'a str>,
    pub notify_task_id: Option<&'a str>,
    pub parent_task_id: Option<&'a str>,
    pub pipeline_def: Option<&'a str>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct StageRun {
    pub id: String,
    pub task_id: String,
    pub stage: String,
    pub kind: String,
    pub agent: Option<String>,
    pub agent_provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub status: String,
    pub result: Option<String>,
    pub feedback: Option<String>,
    pub session_id: Option<String>,
    /// The agent CLI's own session id (e.g. the Claude `--session-id` /
    /// `--resume` UUID), assigned at spawn time. Revisions resume from it.
    pub provider_session_id: Option<String>,
    /// Worktree the run executed in; a resumed revision reopens the provider
    /// session here (CLI transcripts are keyed by working directory).
    pub cwd: Option<String>,
    /// Set when this run resumed a previous run's provider session instead
    /// of starting a fresh agent; records which run's session it continued.
    pub resumed_from_run_id: Option<String>,
    /// Set when a caller requested resume but Kanna had to start a fresh
    /// provider conversation. This is deliberately durable so a fresh spawn
    /// is never presented as a successful resume.
    pub resume_fallback_reason: Option<String>,
    /// Effective completion policy chosen when this run was prepared.
    /// Legacy rows leave this null and fall back to the pinned stage policy.
    pub completion_transition: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

pub struct NewStageRun<'a> {
    pub id: &'a str,
    pub task_id: &'a str,
    pub stage: &'a str,
    pub kind: &'a str,
    pub agent: Option<&'a str>,
    pub agent_provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub status: &'a str,
    pub result: Option<&'a str>,
    pub feedback: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub provider_session_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub resumed_from_run_id: Option<&'a str>,
}

pub struct OpenAgentTask {
    pub task_id: String,
    pub session_id: String,
}

#[derive(Debug)]
pub struct Db {
    conn: Connection,
}

fn database_open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_FULL_MUTEX
}

#[cfg(test)]
fn database_create_flags() -> OpenFlags {
    database_open_flags() | OpenFlags::SQLITE_OPEN_CREATE
}

fn configure_shared_database_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    let journal_mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "expected SQLite journal_mode WAL, got {journal_mode}"
        )));
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "wal_autocheckpoint", SQLITE_WAL_AUTOCHECKPOINT_PAGES)?;
    Ok(())
}

fn run_quick_check(conn: &Connection) -> Result<(), rusqlite::Error> {
    let result: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if result == "ok" {
        return Ok(());
    }

    Err(rusqlite::Error::InvalidParameterName(format!(
        "SQLite quick_check failed: {result}"
    )))
}

fn sqlite_sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

pub(crate) fn relocate_legacy_database_if_needed(
    legacy_path: &Path,
    canonical_path: &Path,
) -> Result<bool, String> {
    if !legacy_path.exists() {
        return Ok(false);
    }

    if canonical_path.exists() {
        archive_legacy_database(legacy_path, canonical_path)?;
        return Ok(false);
    }

    let canonical_parent = canonical_path.parent().ok_or_else(|| {
        format!(
            "canonical database path has no parent: {}",
            canonical_path.display()
        )
    })?;
    std::fs::create_dir_all(canonical_parent).map_err(|error| {
        format!(
            "failed to create canonical database directory {}: {error}",
            canonical_parent.display()
        )
    })?;

    let connection =
        Connection::open_with_flags(legacy_path, database_open_flags()).map_err(|error| {
            format!(
                "failed to open legacy database {}: {error}",
                legacy_path.display()
            )
        })?;
    configure_shared_database_connection(&connection).map_err(|error| {
        format!(
            "failed to configure legacy database {}: {error}",
            legacy_path.display()
        )
    })?;
    let (busy, log_frames, checkpointed_frames): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| {
            format!(
                "failed to checkpoint legacy database {}: {error}",
                legacy_path.display()
            )
        })?;
    if busy != 0 || log_frames != checkpointed_frames {
        return Err(format!(
            "legacy database checkpoint did not complete for {}: busy={busy}, log_frames={log_frames}, checkpointed_frames={checkpointed_frames}",
            legacy_path.display()
        ));
    }
    run_quick_check(&connection).map_err(|error| {
        format!(
            "legacy database health check failed for {}: {error}",
            legacy_path.display()
        )
    })?;
    drop(connection);

    std::fs::rename(legacy_path, canonical_path).map_err(|error| {
        format!(
            "failed to atomically relocate legacy database {} to {}: {error}",
            legacy_path.display(),
            canonical_path.display()
        )
    })?;

    for suffix in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar_path(legacy_path, suffix);
        if let Err(error) = std::fs::remove_file(&sidecar) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "failed to remove checkpointed legacy SQLite sidecar {}: {}",
                    sidecar.display(),
                    error
                );
            }
        }
    }

    Ok(true)
}

fn archive_legacy_database(legacy_path: &Path, canonical_path: &Path) -> Result<(), String> {
    let archive_path = legacy_recovery_archive_path(canonical_path)?;
    let connection =
        Connection::open_with_flags(legacy_path, database_open_flags()).map_err(|error| {
            format!(
                "failed to open legacy database {} for recovery archive: {error}",
                legacy_path.display()
            )
        })?;
    configure_shared_database_connection(&connection).map_err(|error| {
        format!(
            "failed to configure legacy database {} for recovery archive: {error}",
            legacy_path.display()
        )
    })?;
    let (busy, log_frames, checkpointed_frames): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| {
            format!(
                "failed to checkpoint legacy database {} for recovery archive: {error}",
                legacy_path.display()
            )
        })?;
    if busy != 0 || log_frames != checkpointed_frames {
        return Err(format!(
            "legacy database checkpoint did not complete for {} while archiving: busy={busy}, log_frames={log_frames}, checkpointed_frames={checkpointed_frames}",
            legacy_path.display()
        ));
    }
    run_quick_check(&connection).map_err(|error| {
        format!(
            "legacy database health check failed for {} before recovery archive: {error}",
            legacy_path.display()
        )
    })?;
    drop(connection);

    std::fs::copy(legacy_path, &archive_path).map_err(|error| {
        format!(
            "failed to archive legacy database {} to {}: {error}",
            legacy_path.display(),
            archive_path.display()
        )
    })?;
    let archive_connection = Connection::open(&archive_path).map_err(|error| {
        format!(
            "failed to open legacy recovery archive {}: {error}",
            archive_path.display()
        )
    })?;
    run_quick_check(&archive_connection).map_err(|error| {
        format!(
            "legacy recovery archive health check failed for {}: {error}",
            archive_path.display()
        )
    })?;
    drop(archive_connection);

    std::fs::remove_file(legacy_path).map_err(|error| {
        format!(
            "failed to remove archived legacy database {}: {error}",
            legacy_path.display()
        )
    })?;
    remove_sqlite_sidecars(legacy_path);
    log::warn!(
        "Canonical database {} already existed; archived legacy database {} at {}",
        canonical_path.display(),
        legacy_path.display(),
        archive_path.display()
    );
    Ok(())
}

fn legacy_recovery_archive_path(canonical_path: &Path) -> Result<PathBuf, String> {
    let parent = canonical_path.parent().ok_or_else(|| {
        format!(
            "canonical database path has no parent: {}",
            canonical_path.display()
        )
    })?;
    let file_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "canonical database path has no filename: {}",
                canonical_path.display()
            )
        })?;
    let timestamp = backup_timestamp();
    for suffix in 0..1000 {
        let suffix = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let candidate = parent.join(format!("{file_name}.legacy-recovery-{timestamp}{suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "failed to choose a legacy recovery archive path beside {}",
        canonical_path.display()
    ))
}

fn remove_sqlite_sidecars(database_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar_path(database_path, suffix);
        if let Err(error) = std::fs::remove_file(&sidecar) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "failed to remove checkpointed SQLite sidecar {}: {}",
                    sidecar.display(),
                    error
                );
            }
        }
    }
}

fn create_base_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS repo (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          remote_url TEXT,
          remote_url_hash TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pipeline_item (
          id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
          issue_number INTEGER, issue_title TEXT, prompt TEXT,
          pipeline_def TEXT,
          stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
          branch TEXT, agent_type TEXT,
          agent_spawn_options TEXT,
          teardown_started_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS task_port (
          port INTEGER PRIMARY KEY,
          pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          env_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(pipeline_item_id, env_name)
        );
        CREATE TABLE IF NOT EXISTS worktree (
          id TEXT PRIMARY KEY, pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS terminal_session (
          id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
          pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
          label TEXT, cwd TEXT, daemon_session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_run (
          id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
          agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
          status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS stage_run (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          stage TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
          agent TEXT,
          agent_provider TEXT,
          model TEXT,
          effort TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          result TEXT,
          feedback TEXT,
          session_id TEXT,
          provider_session_id TEXT,
          cwd TEXT,
          resumed_from_run_id TEXT,
          resume_fallback_reason TEXT,
          completion_transition TEXT CHECK (completion_transition IN ('manual', 'auto')),
          completion_bound INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        "#,
    )?;
    Ok(())
}

fn has_migration(conn: &Connection, id: &str) -> Result<bool, rusqlite::Error> {
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM schema_migrations WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn record_migration(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("INSERT INTO schema_migrations (id) VALUES (?1)", [id])?;
    Ok(())
}

fn run_migration(
    conn: &Connection,
    id: &str,
    migrate: impl FnOnce(&Connection) -> Result<(), rusqlite::Error>,
) -> Result<(), rusqlite::Error> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        if has_migration(conn, id)? {
            return Ok(());
        }
        migrate(conn)?;
        record_migration(conn, id)
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(error) => {
            if let Err(rollback_error) = conn.execute_batch("ROLLBACK") {
                log::warn!("failed to roll back migration {id} after {error}: {rollback_error}");
            }
            Err(error)
        }
    }
}

fn add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let column_exists: i64 = conn.query_row(
        "SELECT EXISTS(
           SELECT 1
           FROM pragma_table_xinfo(?1)
           WHERE name = ?2
         )",
        params![table, column],
        |row| row.get(0),
    )?;
    if column_exists != 0 {
        return Ok(());
    }

    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute_batch(&sql)
}

fn create_blocker_revision_triggers(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TRIGGER IF NOT EXISTS task_blocker_insert_revision
        AFTER INSERT ON task_blocker
        BEGIN
          UPDATE pipeline_item
          SET blocker_revision = blocker_revision + 1
          WHERE id = NEW.blocked_item_id;
        END;

        CREATE TRIGGER IF NOT EXISTS task_blocker_delete_revision
        AFTER DELETE ON task_blocker
        BEGIN
          UPDATE pipeline_item
          SET blocker_revision = blocker_revision + 1
          WHERE id = OLD.blocked_item_id;
        END;

        CREATE TRIGGER IF NOT EXISTS task_blocker_resolution_revision
        AFTER UPDATE OF stage, pr_url, closed_at ON pipeline_item
        WHEN
          CASE
            WHEN OLD.closed_at IS NOT NULL
              OR (OLD.stage = 'pr' AND OLD.pr_url IS NOT NULL)
            THEN 1 ELSE 0
          END
          <>
          CASE
            WHEN NEW.closed_at IS NOT NULL
              OR (NEW.stage = 'pr' AND NEW.pr_url IS NOT NULL)
            THEN 1 ELSE 0
          END
        BEGIN
          UPDATE pipeline_item
          SET blocker_revision = blocker_revision + 1
          WHERE id IN (
            SELECT blocked_item_id
            FROM task_blocker
            WHERE blocker_item_id = NEW.id
          );
        END;
        "#,
    )
}

fn drop_column(conn: &Connection, table: &str, column: &str) {
    let sql = format!("ALTER TABLE {table} DROP COLUMN {column}");
    if let Err(error) = conn.execute_batch(&sql) {
        log::debug!("column {table}.{column} already absent or cannot be dropped: {error}");
    }
}

fn run_schema_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    create_base_schema(conn)?;

    run_migration(conn, "001_default_settings", |conn| {
        conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('locale', 'en');
            "#,
        )
    })?;

    run_migration(conn, "002_pipeline_item_metadata_columns", |conn| {
        add_column(
            conn,
            "pipeline_item",
            "activity",
            "TEXT NOT NULL DEFAULT 'idle'",
        )?;
        add_column(conn, "pipeline_item", "activity_changed_at", "TEXT")?;
        add_column(conn, "pipeline_item", "port_offset", "INTEGER")?;
        add_column(conn, "pipeline_item", "port_env", "TEXT")?;
        add_column(
            conn,
            "pipeline_item",
            "pinned",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column(conn, "pipeline_item", "pin_order", "INTEGER")?;
        add_column(conn, "pipeline_item", "display_name", "TEXT")?;
        add_column(conn, "pipeline_item", "unread_at", "TEXT")?;
        add_column(conn, "repo", "hidden", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "repo", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "pipeline_item", "closed_at", "TEXT")?;
        add_column(conn, "pipeline_item", "agent_type", "TEXT")?;
        add_column(conn, "pipeline_item", "agent_session_id", "TEXT")?;
        add_column(conn, "pipeline_item", "tags", "TEXT NOT NULL DEFAULT '[]'")?;
        add_column(conn, "pipeline_item", "base_ref", "TEXT")?;
        add_column(
            conn,
            "pipeline_item",
            "agent_provider",
            "TEXT NOT NULL DEFAULT 'claude'",
        )?;
        add_column(conn, "pipeline_item", "agent_spawn_options", "TEXT")?;
        add_column(conn, "pipeline_item", "previous_stage", "TEXT")?;
        add_column(conn, "pipeline_item", "teardown_started_at", "TEXT")?;
        add_column(conn, "pipeline_item", "created_at", "TEXT")?;
        add_column(conn, "pipeline_item", "updated_at", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "003_legacy_stage_to_tags_backfill", |conn| {
        let _ = conn.execute_batch(
            r#"
            UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued';
            UPDATE pipeline_item SET closed_at = COALESCE(closed_at, updated_at, datetime('now')) WHERE stage IN ('needs_review', 'merged', 'closed');
            UPDATE pipeline_item SET closed_at = COALESCE(closed_at, updated_at, datetime('now')) WHERE stage = 'done';
            UPDATE pipeline_item SET tags = '["pr"]' WHERE stage = 'pr' AND tags = '[]';
            UPDATE pipeline_item SET tags = '["merge"]' WHERE stage = 'merge' AND tags = '[]';
            UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'merge' AND closed_at IS NULL;
            UPDATE pipeline_item SET tags = '["blocked"]' WHERE stage = 'blocked' AND tags = '[]';
            "#,
        );
        Ok(())
    })?;

    run_migration(conn, "004_activity_log_accumulator", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS activity_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              activity TEXT NOT NULL,
              started_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_activity_log_item ON activity_log(pipeline_item_id);
            DROP TABLE IF EXISTS activity_log;
            DROP INDEX IF EXISTS idx_activity_log_item;
            CREATE TABLE IF NOT EXISTS activity_log (
              pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              activity TEXT NOT NULL,
              seconds INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (pipeline_item_id, activity)
            );
            "#,
        )
    })?;

    run_migration(conn, "005_task_blocker_table", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_blocker (
              blocked_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              blocker_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              PRIMARY KEY (blocked_item_id, blocker_item_id)
            );
            "#,
        )
    })?;

    run_migration(conn, "006_operator_event_table", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS operator_event (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              event_type TEXT NOT NULL,
              pipeline_item_id TEXT,
              repo_id TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_operator_event_repo ON operator_event(repo_id, created_at);
            "#,
        )
    })?;

    run_migration(conn, "007_pipeline_stage_columns", |conn| {
        add_column(
            conn,
            "pipeline_item",
            "pipeline",
            "TEXT NOT NULL DEFAULT 'default'",
        )?;
        add_column(conn, "pipeline_item", "stage_result", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "008_tags_to_stage_backfill", |conn| {
        conn.execute_batch(
            r#"
            UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"in progress"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy');
            UPDATE pipeline_item SET stage = 'pr' WHERE tags LIKE '%"pr"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy');
            UPDATE pipeline_item SET stage = 'in progress' WHERE tags LIKE '%"merge"%' AND closed_at IS NULL AND stage IN ('in_progress', 'legacy', 'merge');
            UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'in_progress';
            UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'merge' AND closed_at IS NULL;
            UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'legacy';
            "#,
        )
    })?;

    run_migration(conn, "009_task_port_table", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_port (
              port INTEGER PRIMARY KEY,
              pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              env_name TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              UNIQUE(pipeline_item_id, env_name)
            );
            "#,
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, port_env FROM pipeline_item WHERE closed_at IS NULL AND port_env IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (item_id, port_env) = row?;
            let Some(port_env) = port_env else { continue };
            let Ok(env) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&port_env)
            else {
                continue;
            };
            for (env_name, value) in env {
                let port = match value {
                    serde_json::Value::Number(number) => number.as_i64(),
                    serde_json::Value::String(text) => text.parse::<i64>().ok(),
                    _ => None,
                };
                let Some(port) = port else { continue };
                if port <= 0 {
                    continue;
                }
                conn.execute(
                    "INSERT OR IGNORE INTO task_port (port, pipeline_item_id, env_name) VALUES (?1, ?2, ?3)",
                    params![port, item_id, env_name],
                )?;
            }
        }
        Ok(())
    })?;

    run_migration(conn, "010_rename_torndown_stage", |conn| {
        conn.execute_batch("UPDATE pipeline_item SET stage = 'teardown' WHERE stage = 'torndown';")
    })?;

    run_migration(conn, "011_pipeline_item_last_output_preview", |conn| {
        add_column(conn, "pipeline_item", "last_output_preview", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "012_pipeline_item_active_post_action", |conn| {
        add_column(conn, "pipeline_item", "active_post_action", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "013_task_transfer_tables", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS trusted_peer (
              id TEXT PRIMARY KEY,
              peer_id TEXT NOT NULL UNIQUE,
              display_name TEXT NOT NULL,
              public_key TEXT NOT NULL,
              capabilities_json TEXT NOT NULL,
              paired_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_seen_at TEXT,
              revoked_at TEXT
            );
            CREATE TABLE IF NOT EXISTS task_transfer (
              id TEXT PRIMARY KEY,
              direction TEXT NOT NULL,
              status TEXT NOT NULL,
              source_peer_id TEXT,
              target_peer_id TEXT,
              source_task_id TEXT,
              local_task_id TEXT REFERENCES pipeline_item(id) ON DELETE CASCADE,
              started_at TEXT NOT NULL DEFAULT (datetime('now')),
              completed_at TEXT,
              error TEXT,
              payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_task_transfer_local_task ON task_transfer(local_task_id, started_at DESC);
            CREATE TABLE IF NOT EXISTS task_transfer_provenance (
              pipeline_item_id TEXT PRIMARY KEY REFERENCES pipeline_item(id) ON DELETE CASCADE,
              source_peer_id TEXT NOT NULL,
              source_task_id TEXT NOT NULL,
              source_machine_task_label TEXT,
              imported_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
    })?;

    run_migration(conn, "014_task_transfer_payload_json", |conn| {
        add_column(conn, "task_transfer", "payload_json", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "015_agent_session_id_rename", |conn| {
        add_column(conn, "pipeline_item", "agent_session_id", "TEXT")?;
        let _ = conn.execute_batch(
            r#"
            UPDATE pipeline_item
               SET agent_session_id = claude_session_id
             WHERE agent_session_id IS NULL
               AND claude_session_id IS NOT NULL;
            "#,
        );
        Ok(())
    })?;

    run_migration(conn, "016_repo_sort_order", |conn| {
        add_column(conn, "repo", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        let ids = {
            let mut stmt = conn.prepare("SELECT id FROM repo ORDER BY created_at ASC")?;
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for (index, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE repo SET sort_order = ?1 WHERE id = ?2",
                params![index as i64, id],
            )?;
        }
        Ok(())
    })?;

    run_migration(conn, "016_task_teardown_state", |conn| {
        add_column(conn, "pipeline_item", "teardown_started_at", "TEXT")?;
        conn.execute_batch(
            r#"
            UPDATE pipeline_item
            SET
              teardown_started_at = COALESCE(teardown_started_at, updated_at, datetime('now')),
              stage = 'in progress',
              updated_at = datetime('now')
            WHERE stage IN ('teardown', 'torndown')
              AND closed_at IS NULL;
            "#,
        )
    })?;

    run_migration(conn, "017_theme_preferences", |conn| {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            ["appTheme", "dark"],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            ["codeTheme", "match"],
        )?;
        Ok(())
    })?;

    run_migration(conn, "018_merge_stage_to_in_progress", |conn| {
        conn.execute_batch("UPDATE pipeline_item SET stage = 'in progress' WHERE stage = 'merge' AND closed_at IS NULL;")
    })?;

    run_migration(conn, "019_repo_remote_metadata_columns", |conn| {
        add_column(conn, "repo", "remote_url", "TEXT")?;
        add_column(conn, "repo", "remote_url_hash", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "020_agent_message_appearance_preference", |conn| {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            ["agentMessageAppearance", "chat"],
        )?;
        Ok(())
    })?;

    run_migration(conn, "020_pipeline_item_notify_task", |conn| {
        add_column(conn, "pipeline_item", "notify_task_id", "TEXT")?;
        add_column(conn, "pipeline_item", "notified_at", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "021_pipeline_item_agent_spawn_options", |conn| {
        add_column(conn, "pipeline_item", "agent_spawn_options", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "022_pipeline_item_parent_task_id", |conn| {
        add_column(conn, "pipeline_item", "parent_task_id", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "023_stage_run_pipeline_snapshot", |conn| {
        add_column(conn, "pipeline_item", "pipeline_def", "TEXT")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS stage_run (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
              stage TEXT NOT NULL,
              agent TEXT,
              agent_provider TEXT,
              model TEXT,
              status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
              result TEXT,
              feedback TEXT,
              session_id TEXT,
              started_at TEXT NOT NULL DEFAULT (datetime('now')),
              finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_stage_run_task_started ON stage_run(task_id, started_at);
            INSERT OR IGNORE INTO stage_run (
              id, task_id, stage, agent, agent_provider, model, status, result, feedback, session_id, started_at, finished_at
            )
            SELECT
              'migration-current-' || id,
              id,
              stage,
              agent_type,
              agent_provider,
              NULL,
              CASE
                WHEN stage_result IS NOT NULL
                  AND json_valid(stage_result)
                  AND json_extract(stage_result, '$.status') = 'success'
                  THEN 'succeeded'
                WHEN stage_result IS NOT NULL
                  AND json_valid(stage_result)
                  AND json_extract(stage_result, '$.status') = 'failure'
                  THEN 'failed'
                ELSE 'running'
              END,
              stage_result,
              CASE
                WHEN stage_result IS NOT NULL AND json_valid(stage_result)
                  THEN json_extract(stage_result, '$.summary')
                ELSE NULL
              END,
              agent_session_id,
              COALESCE(activity_changed_at, created_at, datetime('now')),
              CASE
                WHEN stage_result IS NOT NULL
                  AND json_valid(stage_result)
                  AND json_extract(stage_result, '$.status') IN ('success', 'failure')
                  THEN COALESCE(updated_at, datetime('now'))
                ELSE NULL
              END
            FROM pipeline_item
            WHERE closed_at IS NULL
              AND stage != 'done'
              AND NOT EXISTS (
                SELECT 1 FROM stage_run WHERE stage_run.task_id = pipeline_item.id
              );
            "#,
        )
    })?;

    run_migration(conn, "024_pipeline_item_stage_graph_cleanup", |conn| {
        if conn
            .execute_batch(
                r#"
                UPDATE pipeline_item
                SET
                  closed_at = COALESCE(closed_at, updated_at, datetime('now')),
                  stage = COALESCE(NULLIF(previous_stage, ''), 'in progress'),
                  updated_at = datetime('now')
                WHERE stage = 'done'
                  AND closed_at IS NULL;
                "#,
            )
            .is_err()
        {
            conn.execute_batch(
                r#"
                UPDATE pipeline_item
                SET
                  closed_at = COALESCE(closed_at, updated_at, datetime('now')),
                  stage = 'in progress',
                  updated_at = datetime('now')
                WHERE stage = 'done'
                  AND closed_at IS NULL;
                "#,
            )?;
        }
        drop_column(conn, "pipeline_item", "tags");
        drop_column(conn, "pipeline_item", "stage_result");
        drop_column(conn, "pipeline_item", "active_post_action");
        drop_column(conn, "pipeline_item", "previous_stage");
        Ok(())
    })?;

    run_migration(conn, "025_stage_run_kind", |conn| {
        add_column(conn, "stage_run", "kind", "TEXT NOT NULL DEFAULT 'main'")?;
        Ok(())
    })?;

    run_migration(conn, "026_stage_run_resume", |conn| {
        add_column(conn, "stage_run", "provider_session_id", "TEXT")?;
        add_column(conn, "stage_run", "cwd", "TEXT")?;
        add_column(conn, "stage_run", "resumed_from_run_id", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "027_pipeline_item_pr_branch", |conn| {
        add_column(conn, "pipeline_item", "pr_branch", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "028_stage_run_completion_transition", |conn| {
        add_column(
            conn,
            "stage_run",
            "completion_transition",
            "TEXT CHECK (completion_transition IN ('manual', 'auto'))",
        )?;
        Ok(())
    })?;

    run_migration(conn, "029_pipeline_item_activity_revision", |conn| {
        add_column(
            conn,
            "pipeline_item",
            "activity_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Ok(())
    })?;

    run_migration(conn, "030_pipeline_item_cloud_task_id", |conn| {
        add_column(conn, "pipeline_item", "cloud_task_id", "TEXT")?;
        conn.execute_batch(
            r#"
            UPDATE pipeline_item
            SET cloud_task_id = id
            WHERE cloud_task_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_item_open_cloud_task_id
            ON pipeline_item(cloud_task_id)
            WHERE closed_at IS NULL;
            "#,
        )
    })?;

    run_migration(conn, "031_task_transfer_cloud_desktop_ids", |conn| {
        add_column(conn, "task_transfer", "source_desktop_id", "TEXT")?;
        add_column(conn, "task_transfer", "target_desktop_id", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "032_task_transfer_sidecar_cleanup", |conn| {
        add_column(
            conn,
            "task_transfer",
            "sidecar_cleanup_completed_at",
            "TEXT",
        )?;
        Ok(())
    })?;

    run_migration(conn, "033_create_task_intent", |conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS create_task_intent (
                task_id TEXT PRIMARY KEY,
                request_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (task_id) REFERENCES pipeline_item(id) ON DELETE CASCADE
            );
            "#,
        )
    })?;

    run_migration(conn, "034_pipeline_item_revision_rounds", |conn| {
        add_column(
            conn,
            "pipeline_item",
            "revision_rounds",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Ok(())
    })?;

    run_migration(conn, "035_pipeline_item_blocker_revision", |conn| {
        add_column(
            conn,
            "pipeline_item",
            "blocker_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        create_blocker_revision_triggers(conn)
    })?;

    run_migration(conn, "036_task_transfer_ownership_leases", |conn| {
        add_column(conn, "task_transfer", "claim_owner_token", "TEXT")?;
        add_column(conn, "task_transfer", "claim_expires_at", "TEXT")?;
        conn.execute_batch(
            r#"
            UPDATE task_transfer
            SET status = CASE
                    WHEN local_task_id IS NULL THEN 'pending'
                    ELSE 'importing'
                END,
                claim_owner_token = NULL,
                claim_expires_at = NULL,
                error = NULL
            WHERE direction = 'incoming'
              AND status = 'streaming';

            UPDATE task_transfer AS loser
            SET status = 'failed',
                completed_at = datetime('now'),
                error = COALESCE(error, 'superseded duplicate active ownership transfer during migration')
            WHERE direction = 'outgoing'
              AND source_task_id IS NOT NULL
              AND status IN ('pending', 'streaming')
              AND EXISTS (
                SELECT 1
                FROM task_transfer AS winner
                WHERE winner.direction = 'outgoing'
                  AND winner.source_task_id = loser.source_task_id
                  AND winner.status IN ('pending', 'streaming')
                  AND (
                    winner.started_at < loser.started_at
                    OR (winner.started_at = loser.started_at AND winner.id < loser.id)
                  )
              );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_transfer_active_outgoing_source
            ON task_transfer(source_task_id)
            WHERE direction = 'outgoing'
              AND source_task_id IS NOT NULL
              AND status IN ('pending', 'streaming');
            "#,
        )
    })?;

    run_migration(conn, "037_task_event_log", |conn| {
        // `seq` is the watchers' cursor: AUTOINCREMENT so a deleted row's id is
        // never reused, and SQLite's single-writer rule means it is allocated
        // and committed under the same write lock (see db/task_events.rs).
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_event (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_event_task_seq ON task_event(task_id, seq);
            "#,
        )?;
        // Runtime status is the daemon's selection-independent view of a task
        // session. `activity` cannot carry it: it collapses waiting into idle,
        // which is exactly why a task parked on a prompt was invisible.
        add_column(conn, "pipeline_item", "runtime_status", "TEXT")
    })?;

    run_migration(conn, "038_pipeline_item_initial_pipeline", |conn| {
        add_column(conn, "pipeline_item", "initial_pipeline", "TEXT")?;
        conn.execute_batch(
            "UPDATE pipeline_item
             SET initial_pipeline = pipeline
             WHERE initial_pipeline IS NULL;",
        )
    })?;

    run_migration(conn, "039_stage_run_resume_fallback_reason", |conn| {
        add_column(conn, "stage_run", "resume_fallback_reason", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "040_stage_run_effort", |conn| {
        add_column(conn, "stage_run", "effort", "TEXT")
    })?;

    run_migration(conn, "041_pipeline_item_parentage_index", |conn| {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_pipeline_item_parent_created_id
             ON pipeline_item(parent_task_id, created_at, id);",
        )
    })?;

    run_migration(conn, "042_task_approval_lineage", |conn| {
        create_task_approval_lineage_schema(conn)?;
        // Existing failed main runs are authoritative even though they predate
        // the projection. Only a later successful main run in the same stage
        // supersedes them; successful commit/approve posts deliberately do not.
        conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO task_approval_hold
              (task_id, run_id, scope_stage, kind, summary, created_at)
            SELECT
              failed.task_id,
              failed.id,
              failed.stage,
              'failed_result',
              COALESCE(NULLIF(failed.feedback, ''), NULLIF(failed.result, ''), 'main stage run failed'),
              COALESCE(failed.finished_at, failed.started_at, datetime('now'))
            FROM stage_run AS failed
            WHERE failed.kind = 'main'
              AND failed.status = 'failed'
              AND NOT EXISTS (
                SELECT 1
                FROM stage_run AS succeeded
                WHERE succeeded.task_id = failed.task_id
                  AND succeeded.kind = 'main'
                  AND succeeded.stage = failed.stage
                  AND succeeded.status = 'succeeded'
                  AND succeeded.rowid > failed.rowid
              );

            -- Historical compatibility for the approval projection introduced
            -- by this migration. Migration 047 removes that projection.
            INSERT OR IGNORE INTO task_approval_hold
              (task_id, run_id, scope_stage, kind, summary, created_at)
            SELECT
              post.task_id,
              post.id,
              COALESCE(
                (
                  SELECT failed.stage
                  FROM stage_run AS failed
                  WHERE failed.task_id = post.task_id
                    AND failed.kind = 'main'
                    AND failed.status = 'failed'
                    AND failed.rowid < post.rowid
                  ORDER BY failed.rowid DESC
                  LIMIT 1
                ),
                owner.stage
              ),
              'not_merge_candidate',
              COALESCE(NULLIF(post.feedback, ''), NULLIF(post.result, ''), 'not a merge candidate'),
              COALESCE(post.finished_at, post.started_at, datetime('now'))
            FROM stage_run AS post
            JOIN pipeline_item AS owner ON owner.id = post.task_id
            WHERE post.kind = 'post'
              AND post.status = 'succeeded'
              AND (
                lower(COALESCE(post.feedback, '')) LIKE '%not a merge candidate%'
                OR lower(COALESCE(post.result, '')) LIKE '%not a merge candidate%'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM stage_run AS succeeded
                WHERE succeeded.task_id = post.task_id
                  AND succeeded.kind = 'main'
                  AND succeeded.status = 'succeeded'
                  AND succeeded.rowid > post.rowid
                  AND succeeded.stage = COALESCE(
                    (
                      SELECT failed.stage
                      FROM stage_run AS failed
                      WHERE failed.task_id = post.task_id
                        AND failed.kind = 'main'
                        AND failed.status = 'failed'
                        AND failed.rowid < post.rowid
                      ORDER BY failed.rowid DESC
                      LIMIT 1
                    ),
                    owner.stage
                  )
              );
            "#,
        )
    })?;

    run_migration(conn, "043_task_approval_atomic_projection", |conn| {
        create_task_approval_lineage_schema(conn)
    })?;

    run_migration(conn, "044_task_approval_authorization", |conn| {
        create_task_approval_authorization_schema(conn)
    })?;

    run_migration(conn, "045_agent_signal_protocol", |conn| {
        create_agent_signal_protocol_schema(conn)
    })?;

    run_migration(conn, "046_completion_and_merge_delivery_binding", |conn| {
        add_column(
            conn,
            "stage_run",
            "completion_bound",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column(
            conn,
            "task_approval_authorization",
            "delivery_task_id",
            "TEXT",
        )?;
        add_column(
            conn,
            "task_approval_authorization",
            "delivery_session_id",
            "TEXT",
        )?;
        add_column(
            conn,
            "task_approval_authorization",
            "delivery_protocol",
            "INTEGER",
        )?;
        add_column(
            conn,
            "task_approval_authorization",
            "delivery_reserved_at",
            "TEXT",
        )?;
        add_column(conn, "agent_signal_protocol", "session_id", "TEXT")
    })?;

    run_migration(conn, "047_remove_approval_gate", |conn| {
        conn.execute_batch(
            r#"
            DROP TRIGGER IF EXISTS stage_run_failed_main_approval_hold_insert;
            DROP TRIGGER IF EXISTS stage_run_failed_main_approval_hold_update;
            DROP TRIGGER IF EXISTS stage_run_structured_approval_hold_insert;
            DROP TRIGGER IF EXISTS stage_run_structured_approval_hold_update;
            DROP TRIGGER IF EXISTS stage_run_success_main_resolve_approval_hold_insert;
            DROP TRIGGER IF EXISTS stage_run_success_main_resolve_approval_hold_update;
            DROP TABLE task_approval_authorization;
            DROP TABLE task_approval_hold;
            DROP TABLE task_approval_override;
            DROP TABLE IF EXISTS agent_signal_protocol;
            DROP TABLE IF EXISTS merge_handoff_delivery;
            "#,
        )
    })?;

    // One timestamp, not a delivery-binding table: the engine records *that*
    // a task's merge request reached the repo's merge agent so closing the
    // task can tell a delivered handoff from a skipped one. It attests
    // nothing about the merge itself — approval eligibility stayed deleted
    // with migration 047.
    run_migration(conn, "048_pipeline_item_merge_signaled", |conn| {
        add_column(conn, "pipeline_item", "merge_signaled_at", "TEXT")?;
        Ok(())
    })?;

    run_migration(conn, "049_transfer_work_queue", |conn| {
        // The four sidecar lifecycle events used to live in an in-memory Tauri
        // queue that died with the app, so only `transfer-request` had any
        // restart recovery at all. They are rows now, appended by the same
        // reader that observes them, and `id` is derived from the event so a
        // redelivered one collapses onto the work already queued.
        //
        // `transfer_work_phase` is the durable form of the in-memory
        // `claimed_phases` set: a step that must happen at most once per work
        // item (signalling the source agent, closing the source task) claims
        // its phase here, so a resumed item cannot repeat it.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS transfer_work (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                transfer_id TEXT,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                run_after TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_transfer_work_runnable
                ON transfer_work(status, run_after, created_at);

            CREATE TABLE IF NOT EXISTS transfer_work_phase (
                work_id TEXT NOT NULL REFERENCES transfer_work(id) ON DELETE CASCADE,
                phase TEXT NOT NULL,
                claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (work_id, phase)
            );
            "#,
        )
    })?;

    run_migration(conn, "050_transfer_work_phase_value", |conn| {
        // A boolean claim answers "has this step run?" but not "what did it
        // decide?", and two steps need the answer to survive a retry rather
        // than be recomputed against a machine the first attempt already
        // changed: the session a source had *before* its agent was signalled,
        // and the session id an import materialized. Recomputing either on
        // attempt 2 reads a world the first attempt already moved.
        add_column(conn, "transfer_work_phase", "value", "TEXT")
    })?;

    run_migration(conn, "051_repo_remote_hash_task_event_indexes", |conn| {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_repo_remote_url_hash_id
             ON repo(remote_url_hash, id);
             CREATE INDEX IF NOT EXISTS idx_pipeline_item_repo_id_id
             ON pipeline_item(repo_id, id);",
        )
    })?;

    run_migration(conn, "052_task_input_log", |conn| {
        // Messages delivered into a task's PTY from outside its session used
        // to exist only as terminal bytes, so a later stage could read the
        // whole durable record and honestly conclude none had ever been sent.
        // `id` is AUTOINCREMENT because `delivered_at` has one-second
        // resolution and two deliveries in the same second must still order.
        // Rows follow the task: they are as short-lived as it is, which is why
        // the full message text is kept rather than truncated.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_input (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
                run_id TEXT REFERENCES stage_run(id) ON DELETE SET NULL,
                stage TEXT,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_input_task_id ON task_input(task_id, id);
            "#,
        )
    })?;

    run_migration(conn, "053_pipeline_item_input_blocked", |conn| {
        // Why a task-level column rather than a live daemon read: a session
        // that refuses input is otherwise indistinguishable from a healthy
        // idle one, so the first sign of one used to be an unrelated agent's
        // delivery failing against it. Recorded here, it is on task detail and
        // in the event feed like every other state a watcher acts on.
        add_column(conn, "pipeline_item", "input_blocked", "TEXT")
    })?;

    run_migration(conn, "054_pipeline_item_composer", |conn| {
        // The composer line, kept apart from everything the session actually
        // said. `last_output_preview` — where the waiting-prompt snippet lives
        // — is read by agents as content, and a CLI that paints a suggestive
        // placeholder at its own prompt turned that into an owner directive
        // twice. Two columns rather than one: the text is useless without the
        // verdict on whether anybody typed it.
        add_column(conn, "pipeline_item", "composer_text", "TEXT")?;
        add_column(conn, "pipeline_item", "composer_attestation", "TEXT")
    })?;

    run_migration(conn, "055_activity_event_debounce", |conn| {
        add_column(conn, "pipeline_item", "activity_event_baseline", "TEXT")?;
        add_column(conn, "pipeline_item", "activity_event_pending_at", "TEXT")?;
        conn.execute(
            "UPDATE pipeline_item SET activity_event_baseline = activity
             WHERE activity_event_baseline IS NULL",
            [],
        )?;
        Ok(())
    })?;

    run_migration(conn, "056_runtime_settled_debounce", |conn| {
        add_column(conn, "pipeline_item", "runtime_event_baseline", "TEXT")?;
        add_column(conn, "pipeline_item", "runtime_event_pending_at", "TEXT")?;
        conn.execute(
            "UPDATE pipeline_item
             SET runtime_event_baseline = runtime_status
             WHERE runtime_event_baseline IS NULL",
            [],
        )?;
        Ok(())
    })?;

    run_migration(conn, "057_queued_task_input", |conn| {
        // The daemon can accept a logical message while a typed terminal
        // draft prevents submission. Keep the server-side attribution until
        // the daemon announces that exact FIFO slot was written; otherwise a
        // restart loses both sender-visible queue state and the later durable
        // delivery record.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS queued_task_input (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('preparing', 'held', 'uncertain')),
                reason TEXT,
                queued_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_queued_task_input_task_id
                ON queued_task_input(task_id, id);
            "#,
        )
    })?;

    run_migration(conn, "058_queued_task_input_session_incarnation", |conn| {
        // A task id survives stage and recovery session replacement. Queue
        // recovery must therefore be fenced by the same child pid that
        // SubmitInputIfSession uses to identify the exact daemon session
        // incarnation. Rows created before that identity existed cannot be
        // reconciled safely.
        add_column(conn, "queued_task_input", "session_pid", "INTEGER")?;
        conn.execute(
            "UPDATE queued_task_input
             SET state = 'uncertain', reason = 'delivery outcome predates session-incarnation tracking'
             WHERE session_pid IS NULL",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_queued_task_input_session
             ON queued_task_input(task_id, session_pid, id)",
            [],
        )?;
        Ok(())
    })?;

    Ok(())
}

fn create_task_approval_authorization_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS task_approval_authorization (
          run_id TEXT PRIMARY KEY REFERENCES stage_run(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
          branch TEXT NOT NULL,
          target TEXT NOT NULL,
          pr_url TEXT,
          approval_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          delivered_at TEXT,
          delivery_task_id TEXT,
          delivery_session_id TEXT,
          delivery_protocol INTEGER,
          delivery_reserved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_approval_authorization_task
          ON task_approval_authorization(task_id, created_at);
        "#,
    )
}

fn create_agent_signal_protocol_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS agent_signal_protocol (
          task_id TEXT PRIMARY KEY REFERENCES pipeline_item(id) ON DELETE CASCADE,
          session_id TEXT,
          merge_handoff_version INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
}

fn create_task_approval_lineage_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS task_approval_override (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          channel TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS task_approval_hold (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL UNIQUE REFERENCES stage_run(id) ON DELETE CASCADE,
          scope_stage TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('failed_result', 'needs_human_input', 'not_merge_candidate')),
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_by_run_id TEXT REFERENCES stage_run(id),
          resolved_at TEXT,
          override_id TEXT REFERENCES task_approval_override(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_approval_hold_task
          ON task_approval_hold(task_id, id);
        CREATE TRIGGER IF NOT EXISTS stage_run_failed_main_approval_hold_insert
        AFTER INSERT ON stage_run
        WHEN NEW.kind = 'main' AND NEW.status = 'failed'
        BEGIN
          INSERT INTO task_approval_hold
            (task_id, run_id, scope_stage, kind, summary)
          VALUES
            (NEW.task_id, NEW.id, NEW.stage, 'failed_result',
             COALESCE(NULLIF(NEW.feedback, ''), NULLIF(NEW.result, ''), 'main stage run failed'))
          ON CONFLICT(run_id) DO UPDATE SET
            scope_stage = excluded.scope_stage,
            kind = 'failed_result',
            summary = excluded.summary,
            created_at = datetime('now'),
            resolved_by_run_id = NULL,
            resolved_at = NULL,
            override_id = NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS stage_run_failed_main_approval_hold_update
        AFTER UPDATE OF status, result, feedback ON stage_run
        WHEN NEW.kind = 'main' AND NEW.status = 'failed'
        BEGIN
          INSERT INTO task_approval_hold
            (task_id, run_id, scope_stage, kind, summary)
          VALUES
            (NEW.task_id, NEW.id, NEW.stage, 'failed_result',
             COALESCE(NULLIF(NEW.feedback, ''), NULLIF(NEW.result, ''), 'main stage run failed'))
          ON CONFLICT(run_id) DO UPDATE SET
            scope_stage = excluded.scope_stage,
            kind = 'failed_result',
            summary = excluded.summary,
            created_at = datetime('now'),
            resolved_by_run_id = NULL,
            resolved_at = NULL,
            override_id = NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS stage_run_structured_approval_hold_insert
        AFTER INSERT ON stage_run
        WHEN CASE
          WHEN json_valid(NEW.result)
          THEN json_extract(NEW.result, '$.disposition')
          ELSE NULL
        END IN ('needs_human_input', 'not_merge_candidate')
        BEGIN
          INSERT INTO task_approval_hold
            (task_id, run_id, scope_stage, kind, summary)
          VALUES
            (NEW.task_id, NEW.id,
             CASE
               WHEN NEW.kind = 'post'
               THEN COALESCE((SELECT stage FROM pipeline_item WHERE id = NEW.task_id), NEW.stage)
               ELSE NEW.stage
             END,
             json_extract(NEW.result, '$.disposition'),
             COALESCE(NULLIF(NEW.feedback, ''), NULLIF(NEW.result, ''), 'explicit approval hold'))
          ON CONFLICT(run_id) DO UPDATE SET
            scope_stage = excluded.scope_stage,
            kind = excluded.kind,
            summary = excluded.summary,
            created_at = datetime('now'),
            resolved_by_run_id = NULL,
            resolved_at = NULL,
            override_id = NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS stage_run_structured_approval_hold_update
        AFTER UPDATE OF status, result, feedback ON stage_run
        WHEN CASE
          WHEN json_valid(NEW.result)
          THEN json_extract(NEW.result, '$.disposition')
          ELSE NULL
        END IN ('needs_human_input', 'not_merge_candidate')
        BEGIN
          INSERT INTO task_approval_hold
            (task_id, run_id, scope_stage, kind, summary)
          VALUES
            (NEW.task_id, NEW.id,
             CASE
               WHEN NEW.kind = 'post'
               THEN COALESCE((SELECT stage FROM pipeline_item WHERE id = NEW.task_id), NEW.stage)
               ELSE NEW.stage
             END,
             json_extract(NEW.result, '$.disposition'),
             COALESCE(NULLIF(NEW.feedback, ''), NULLIF(NEW.result, ''), 'explicit approval hold'))
          ON CONFLICT(run_id) DO UPDATE SET
            scope_stage = excluded.scope_stage,
            kind = excluded.kind,
            summary = excluded.summary,
            created_at = datetime('now'),
            resolved_by_run_id = NULL,
            resolved_at = NULL,
            override_id = NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS stage_run_success_main_resolve_approval_hold_insert
        AFTER INSERT ON stage_run
        WHEN NEW.kind = 'main' AND NEW.status = 'succeeded'
        BEGIN
          UPDATE task_approval_hold
          SET resolved_by_run_id = NEW.id, resolved_at = datetime('now')
          WHERE task_id = NEW.task_id
            AND scope_stage = NEW.stage
            AND resolved_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM stage_run AS origin
              WHERE origin.id = task_approval_hold.run_id
                AND origin.rowid < NEW.rowid
            );
        END;
        CREATE TRIGGER IF NOT EXISTS stage_run_success_main_resolve_approval_hold_update
        AFTER UPDATE OF status, result, feedback ON stage_run
        WHEN NEW.kind = 'main' AND NEW.status = 'succeeded'
        BEGIN
          UPDATE task_approval_hold
          SET resolved_by_run_id = NEW.id, resolved_at = datetime('now')
          WHERE task_id = NEW.task_id
            AND scope_stage = NEW.stage
            AND resolved_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM stage_run AS origin
              WHERE origin.id = task_approval_hold.run_id
                AND origin.rowid < NEW.rowid
            );
        END;
        "#,
    )
}

/// Events exist to be tailed, not archived: a watcher that has been away for
/// two weeks has lost the thread anyway. Pruning at open keeps the log bounded
/// without putting a delete in the append path.
const TASK_EVENT_RETENTION_DAYS: u32 = 14;

fn prune_task_events(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM task_event WHERE created_at < datetime('now', ?1)",
        [format!("-{TASK_EVENT_RETENTION_DAYS} days")],
    )?;
    Ok(())
}

impl Db {
    #[cfg(debug_assertions)]
    pub(crate) fn connection_for_e2e_tests(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn with_immediate_transaction<T, E>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(E::from)?;
        match operation(self) {
            Ok(value) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(E::from(error));
                }
                Ok(value)
            }
            Err(error) => {
                if let Err(rollback_error) = self.conn.execute_batch("ROLLBACK") {
                    log::error!("failed to roll back immediate transaction: {rollback_error}");
                }
                Err(error)
            }
        }
    }

    /// Run related reads against one SQLite snapshot without taking the write
    /// reservation used by mutation transactions. In WAL mode writers may
    /// continue while this snapshot is held, but every read in `operation`
    /// observes the same committed state.
    pub(crate) fn with_read_transaction<T>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, rusqlite::Error>,
    ) -> Result<T, rusqlite::Error> {
        self.conn.execute_batch("BEGIN")?;
        match operation(self) {
            Ok(value) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error);
                }
                Ok(value)
            }
            Err(error) => {
                if let Err(rollback_error) = self.conn.execute_batch("ROLLBACK") {
                    log::error!("failed to roll back read transaction: {rollback_error}");
                }
                Err(error)
            }
        }
    }

    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_with_flags(path, database_open_flags())?;
        configure_shared_database_connection(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_migrated(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_with_flags(path, database_open_flags())?;
        configure_shared_database_connection(&conn)?;
        run_schema_migrations(&conn)?;
        prune_task_events(&conn)?;
        run_quick_check(&conn)?;
        Ok(Self { conn })
    }

    pub fn backup_database(&self, db_path: &str) -> Result<PathBuf, rusqlite::Error> {
        let backup_path = backup_path_for_database(Path::new(db_path))?;
        let backup_path_string = backup_path.to_string_lossy().to_string();
        self.conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        self.conn
            .execute("VACUUM main INTO ?1", [&backup_path_string])?;
        let backup_conn = Connection::open(&backup_path)?;
        run_quick_check(&backup_conn)?;
        Ok(backup_path)
    }
}

fn backup_path_for_database(db_path: &Path) -> Result<PathBuf, rusqlite::Error> {
    let file_name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            rusqlite::Error::InvalidParameterName("database path has no filename".to_string())
        })?;
    let timestamp = backup_timestamp();
    let first = db_path.with_file_name(format!("{file_name}.backup-{timestamp}"));
    if !first.exists() {
        return Ok(first);
    }
    for suffix in 1..1000 {
        let candidate = db_path.with_file_name(format!("{file_name}.backup-{timestamp}-{suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(rusqlite::Error::InvalidParameterName(
        "failed to choose a unique backup path".to_string(),
    ))
}

fn backup_timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}
