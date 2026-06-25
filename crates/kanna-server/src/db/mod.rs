use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::time::Duration;

mod blockers;
mod notifications;
mod pipeline_items;
mod ports;
mod post_actions;
mod repos;
mod settings;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod worktrees;

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

pub struct NewRepo<'a> {
    pub id: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub default_branch: Option<&'a str>,
}

pub struct TaskStageSource {
    pub repo_id: String,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    pub display_name: Option<String>,
    pub stage: Option<String>,
    pub stage_result: Option<String>,
    pub active_post_action: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub pipeline: Option<String>,
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
    pub tags_json: &'a str,
    pub branch: &'a str,
    pub agent_type: &'a str,
    pub agent_provider: &'a str,
    pub activity: &'a str,
    pub port_offset: Option<i64>,
    pub port_env_json: Option<&'a str>,
    pub base_ref: Option<&'a str>,
    pub notify_task_id: Option<&'a str>,
}

pub struct ClaimedTaskNotification {
    pub child_id: String,
    pub notify_task_id: String,
    pub title: String,
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
