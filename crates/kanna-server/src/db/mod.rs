use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

mod analytics;
mod blockers;
mod notifications;
mod operator_events;
mod pipeline_items;
mod ports;
mod repos;
mod settings;
mod snapshot;
mod stage_runs;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod transfers;
mod worktrees;

#[allow(unused_imports)]
pub use analytics::RepoAnalytics;
#[allow(unused_imports)]
pub use operator_events::NewOperatorEvent;
#[allow(unused_imports)]
pub use stage_runs::FinishedStageRun;
#[allow(unused_imports)]
pub use transfers::{
    NewTaskTransfer, NewTaskTransferProvenance, PendingIncomingTransfer, TaskTransfer,
};

const SQLITE_BUSY_TIMEOUT_MS: u64 = 10_000;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES: i64 = 100;

#[derive(Debug, Serialize)]
pub struct PipelineItem {
    pub id: String,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    pub pipeline: Option<String>,
    pub stage: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    pub activity: Option<String>,
    pub activity_changed_at: Option<String>,
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
    pub pipeline_def: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
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
}

#[derive(Debug, Serialize)]
pub struct SnapshotTaskBlocker {
    pub blocked_item_id: String,
    pub blocker_item_id: String,
}

#[derive(Debug, Serialize)]
pub struct ClosedTaskIdentity {
    pub id: String,
    pub repo_id: String,
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
    pub worktree_paths: HashMap<String, String>,
    pub settings: HashMap<String, String>,
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
    pub status: &'a str,
    pub result: Option<&'a str>,
    pub feedback: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub provider_session_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub resumed_from_run_id: Option<&'a str>,
}

pub struct ClaimedTaskNotification {
    pub child_id: String,
    pub notify_task_id: String,
    pub title: String,
}

pub struct RunningAgentTask {
    pub task_id: String,
    pub session_id: String,
}

#[derive(Debug)]
pub struct Db {
    conn: Connection,
}

fn database_open_flags() -> OpenFlags {
    OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX
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
    run_quick_check(conn)?;
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

impl Db {
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_with_flags(path, database_open_flags())?;
        configure_shared_database_connection(&conn)?;
        Ok(Self { conn })
    }
}
