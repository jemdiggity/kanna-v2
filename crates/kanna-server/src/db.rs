use base64::Engine;
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

const SQLITE_BUSY_TIMEOUT_MS: u64 = 10_000;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES: i64 = 100;

#[derive(Debug, Serialize)]
pub struct PipelineItem {
    pub id: String,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
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
}

#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
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

    #[cfg(test)]
    pub fn test_db_path(suffix: &str) -> String {
        std::env::temp_dir()
            .join(format!("kanna-server-db-{suffix}.sqlite"))
            .to_string_lossy()
            .to_string()
    }

    #[cfg(test)]
    pub fn open_for_tests(path: &str) -> Result<Self, rusqlite::Error> {
        let path_buf = PathBuf::from(path);
        let _ = std::fs::remove_file(&path_buf);
        let conn = Connection::open_with_flags(&path_buf, database_create_flags())?;
        configure_shared_database_connection(&conn)?;
        let db = Self { conn };
        db.init_test_schema()?;
        Ok(db)
    }

    #[cfg(test)]
    fn init_test_schema(&self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE repo (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                default_branch TEXT,
                hidden INTEGER,
                created_at TEXT,
                last_opened_at TEXT
            );

            CREATE TABLE pipeline_item (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                issue_number INTEGER,
                issue_title TEXT,
                prompt TEXT,
                stage TEXT,
                pr_number INTEGER,
                pr_url TEXT,
                branch TEXT,
                agent_type TEXT,
                activity TEXT,
                activity_changed_at TEXT,
                pinned INTEGER,
                pin_order INTEGER,
                display_name TEXT,
                last_output_preview TEXT,
                created_at TEXT,
                updated_at TEXT,
                previous_stage TEXT,
                closed_at TEXT,
                pipeline TEXT,
                stage_result TEXT,
                active_post_action TEXT,
                tags TEXT,
                agent_provider TEXT,
                port_offset INTEGER,
                port_env TEXT,
                base_ref TEXT
            );

            CREATE TABLE worktree (
                id TEXT PRIMARY KEY,
                pipeline_item_id TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE task_port (
                port INTEGER PRIMARY KEY,
                pipeline_item_id TEXT NOT NULL,
                env_name TEXT NOT NULL
            );

            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE terminal_session (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                pipeline_item_id TEXT,
                label TEXT,
                cwd TEXT,
                daemon_session_id TEXT
            );

            CREATE TABLE task_blocker (
                blocked_item_id TEXT NOT NULL,
                blocker_item_id TEXT NOT NULL,
                PRIMARY KEY (blocked_item_id, blocker_item_id)
            );
            "#,
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_repo(&self, id: &str, name: &str) -> Result<(), rusqlite::Error> {
        self.insert_test_repo_with_path(id, &format!("/tmp/{id}"), name)
    }

    #[cfg(test)]
    pub fn insert_test_repo_with_path(
        &self,
        id: &str,
        path: &str,
        name: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
             VALUES (?, ?, ?, 'main', 0, datetime('now'), datetime('now'))",
            (id, path, name),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_pipeline_item(
        &self,
        id: &str,
        repo_id: &str,
        prompt: &str,
        display_name: Option<&str>,
        stage: &str,
        updated_at: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO pipeline_item (
                id, repo_id, prompt, stage, branch, agent_type, activity,
                pinned, pin_order, display_name, created_at, updated_at, pipeline, tags, agent_provider
             ) VALUES (?, ?, ?, ?, ?, 'pty', 'idle', 0, NULL, ?, ?, ?, 'default', '[]', 'claude')",
            (
                id,
                repo_id,
                prompt,
                stage,
                format!("branch-{id}"),
                display_name,
                updated_at,
                updated_at,
            ),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_terminal_session(
        &self,
        id: &str,
        repo_id: &str,
        pipeline_item_id: &str,
        label: &str,
        daemon_session_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
             VALUES (?, ?, ?, ?, '/tmp/repo', ?)",
            (id, repo_id, pipeline_item_id, label, daemon_session_id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn count_test_worktrees_for_task(
        &self,
        pipeline_item_id: &str,
        path: &str,
        branch: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM worktree WHERE pipeline_item_id = ? AND path = ? AND branch = ?",
            (pipeline_item_id, path, branch),
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn count_test_pipeline_items_for_repo(
        &self,
        repo_id: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM pipeline_item WHERE repo_id = ?",
            [repo_id],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn count_test_worktrees_for_repo(&self, repo_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*)
             FROM worktree
             JOIN pipeline_item ON pipeline_item.id = worktree.pipeline_item_id
             WHERE pipeline_item.repo_id = ?",
            [repo_id],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn count_test_terminal_sessions_for_repo(
        &self,
        repo_id: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM terminal_session WHERE repo_id = ?",
            [repo_id],
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_preview(
        &self,
        id: &str,
        preview: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET last_output_preview = ? WHERE id = ?",
            (preview, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_stage_context(
        &self,
        id: &str,
        branch: &str,
        pipeline: &str,
        stage_result: Option<&str>,
        agent_provider: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET branch = ?, pipeline = ?, stage_result = ?, agent_provider = ?
             WHERE id = ?",
            (branch, pipeline, stage_result, agent_provider, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_base_ref(
        &self,
        id: &str,
        base_ref: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET base_ref = ? WHERE id = ?",
            (base_ref, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn set_test_setting(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_task_blocker(
        &self,
        blocked_item_id: &str,
        blocker_item_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.insert_task_blocker(blocked_item_id, blocker_item_id)
    }

    #[cfg(test)]
    pub fn count_test_task_blockers(
        &self,
        blocked_item_id: &str,
        blocker_item_id: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM task_blocker WHERE blocked_item_id = ? AND blocker_item_id = ?",
            (blocked_item_id, blocker_item_id),
            |row| row.get(0),
        )
    }

    #[cfg(test)]
    pub fn get_test_pipeline_item_tags(&self, id: &str) -> Result<String, rusqlite::Error> {
        self.pipeline_item_tags(id)
    }

    #[cfg(test)]
    pub fn set_test_pipeline_item_tags(
        &self,
        id: &str,
        tags_json: &str,
    ) -> Result<(), rusqlite::Error> {
        self.update_pipeline_item_tags(id, tags_json)
    }

    pub fn list_recent_pipeline_items(&self) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at
             FROM pipeline_item
             WHERE closed_at IS NULL
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                agent_provider: row.get(10)?,
                activity: row.get(11)?,
                activity_changed_at: row.get(12)?,
                closed_at: row.get(13)?,
                pinned: row.get(14)?,
                pin_order: row.get(15)?,
                display_name: row.get(16)?,
                last_output_preview: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_pipeline_items(&self, query: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let like_query = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at
             FROM pipeline_item
             WHERE closed_at IS NULL
               AND (
                 lower(coalesce(display_name, '')) LIKE ?
                 OR lower(coalesce(prompt, '')) LIKE ?
               )
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([&like_query, &like_query], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                agent_provider: row.get(10)?,
                activity: row.get(11)?,
                activity_changed_at: row.get(12)?,
                closed_at: row.get(13)?,
                pinned: row.get(14)?,
                pin_order: row.get(15)?,
                display_name: row.get(16)?,
                last_output_preview: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_repos(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, created_at, last_opened_at \
             FROM repo WHERE hidden = 0 OR hidden IS NULL ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                created_at: row.get(5)?,
                last_opened_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at \
             FROM pipeline_item WHERE repo_id = ? AND closed_at IS NULL \
             ORDER BY pin_order ASC, created_at DESC",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                agent_provider: row.get(10)?,
                activity: row.get(11)?,
                activity_changed_at: row.get(12)?,
                closed_at: row.get(13)?,
                pinned: row.get(14)?,
                pin_order: row.get(15)?,
                display_name: row.get(16)?,
                last_output_preview: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at \
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                agent_provider: row.get(10)?,
                activity: row.get(11)?,
                activity_changed_at: row.get(12)?,
                closed_at: row.get(13)?,
                pinned: row.get(14)?,
                pin_order: row.get(15)?,
                display_name: row.get(16)?,
                last_output_preview: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn resolve_pipeline_item_id(
        &self,
        task_or_branch_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        let exact = self
            .conn
            .query_row(
                "SELECT id FROM pipeline_item WHERE id = ?",
                [task_or_branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if exact.is_some() {
            return Ok(exact);
        }

        self.conn
            .query_row(
                "SELECT id FROM pipeline_item WHERE branch = ?",
                [task_or_branch_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn resolve_task_terminal_session_id(
        &self,
        task_or_branch_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        let Some(pipeline_item_id) = self.resolve_pipeline_item_id(task_or_branch_id)? else {
            return Ok(None);
        };

        let terminal_session_id = self
            .conn
            .query_row(
                "SELECT daemon_session_id
                 FROM terminal_session
                 WHERE pipeline_item_id = ?
                   AND daemon_session_id IS NOT NULL
                   AND daemon_session_id != ''
                 ORDER BY CASE WHEN label = 'agent' THEN 0 ELSE 1 END, id
                 LIMIT 1",
                [&pipeline_item_id],
                |row| row.get(0),
            )
            .optional()?;

        Ok(terminal_session_id.or(Some(pipeline_item_id)))
    }

    pub fn get_repo(&self, id: &str) -> Result<Option<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, created_at, last_opened_at
             FROM repo WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                created_at: row.get(5)?,
                last_opened_at: row.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn get_task_stage_source(
        &self,
        id: &str,
    ) -> Result<Option<TaskStageSource>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT repo_id, issue_title, prompt, display_name, stage, stage_result, active_post_action, branch, base_ref, pipeline, agent_provider, closed_at
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(TaskStageSource {
                repo_id: row.get(0)?,
                issue_title: row.get(1)?,
                prompt: row.get(2)?,
                display_name: row.get(3)?,
                stage: row.get(4)?,
                stage_result: row.get(5)?,
                active_post_action: row.get(6)?,
                branch: row.get(7)?,
                base_ref: row.get(8)?,
                pipeline: row.get(9)?,
                agent_provider: row.get(10)?,
                closed_at: row.get(11)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn get_pipeline_item_title_by_repo_branch(
        &self,
        repo_id: &str,
        branch: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT display_name, issue_title, prompt
                 FROM pipeline_item
                 WHERE repo_id = ? AND branch = ?
                 ORDER BY datetime(created_at) DESC
                 LIMIT 1",
                (repo_id, branch),
                |row| {
                    let display_name: Option<String> = row.get(0)?;
                    let issue_title: Option<String> = row.get(1)?;
                    let prompt: Option<String> = row.get(2)?;
                    Ok(display_name
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| issue_title.filter(|value| !value.trim().is_empty()))
                        .or_else(|| prompt.filter(|value| !value.trim().is_empty())))
                },
            )
            .optional()
            .map(|title| title.flatten())
    }

    pub fn insert_pipeline_item(&self, item: NewPipelineItem<'_>) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO pipeline_item
             (id, repo_id, prompt, display_name, pipeline, stage, tags, branch, agent_type, agent_provider,
              activity, activity_changed_at, port_offset, port_env, base_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)",
            (
                item.id,
                item.repo_id,
                item.prompt,
                item.display_name,
                item.pipeline,
                item.stage,
                item.tags_json,
                item.branch,
                item.agent_type,
                item.agent_provider,
                item.activity,
                item.port_offset,
                item.port_env_json,
                item.base_ref,
            ),
        )?;
        Ok(())
    }

    pub fn upsert_worktree(
        &self,
        id: &str,
        pipeline_item_id: &str,
        path: &str,
        branch: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO worktree (id, pipeline_item_id, path, branch)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               pipeline_item_id = excluded.pipeline_item_id,
               path = excluded.path,
               branch = excluded.branch",
            (id, pipeline_item_id, path, branch),
        )?;
        Ok(())
    }

    pub fn upsert_terminal_session(
        &self,
        id: &str,
        repo_id: &str,
        pipeline_item_id: Option<&str>,
        label: Option<&str>,
        cwd: Option<&str>,
        daemon_session_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               repo_id = excluded.repo_id,
               pipeline_item_id = excluded.pipeline_item_id,
               label = excluded.label,
               cwd = excluded.cwd,
               daemon_session_id = excluded.daemon_session_id",
            (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id),
        )?;
        Ok(())
    }

    pub fn delete_task_creation_artifacts(&self, item_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM terminal_session WHERE pipeline_item_id = ?",
            [item_id],
        )?;
        self.conn
            .execute("DELETE FROM worktree WHERE pipeline_item_id = ?", [item_id])?;
        self.conn.execute(
            "DELETE FROM task_blocker WHERE blocked_item_id = ? OR blocker_item_id = ?",
            (item_id, item_id),
        )?;
        self.conn.execute(
            "DELETE FROM task_port WHERE pipeline_item_id = ?",
            [item_id],
        )?;
        self.conn
            .execute("DELETE FROM pipeline_item WHERE id = ?", [item_id])?;
        Ok(())
    }

    pub fn close_pipeline_item(&self, id: &str) -> Result<(), rusqlite::Error> {
        let Some(pipeline_item_id) = self.resolve_pipeline_item_id(id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET previous_stage = COALESCE(previous_stage, stage),
                 stage = 'done',
                 closed_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ?",
            [&pipeline_item_id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_stage_result(
        &self,
        id: &str,
        stage_result: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage_result = ?, updated_at = datetime('now') WHERE id = ?",
            (stage_result, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn clear_pipeline_item_stage_result(&self, id: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage_result = NULL, updated_at = datetime('now') WHERE id = ?",
            [id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_stage(&self, id: &str, stage: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (stage, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_stage_state(
        &self,
        id: &str,
        stage: &str,
        stage_result: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage = ?, stage_result = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (stage, stage_result, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn pipeline_item_tags(&self, id: &str) -> Result<String, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COALESCE(tags, '[]') FROM pipeline_item WHERE id = ?",
            [id],
            |row| row.get(0),
        )
    }

    pub fn update_pipeline_item_tags(
        &self,
        id: &str,
        tags_json: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET tags = ?, updated_at = datetime('now') WHERE id = ?",
            (tags_json, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_activity(
        &self,
        id: &str,
        activity: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET activity = ?, activity_changed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?",
            (activity, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn insert_task_blocker(
        &self,
        blocked_item_id: &str,
        blocker_item_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
            (blocked_item_id, blocker_item_id),
        )?;
        Ok(())
    }

    pub fn remove_all_task_blockers(&self, blocked_item_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM task_blocker WHERE blocked_item_id = ?",
            [blocked_item_id],
        )?;
        Ok(())
    }

    pub fn list_task_blocker_ids(
        &self,
        blocked_item_id: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT blocker_item_id FROM task_blocker WHERE blocked_item_id = ?")?;
        let rows = stmt.query_map([blocked_item_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn task_dependency_has_path_to(
        &self,
        from_blocked_item_id: &str,
        target_item_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        fn dfs(
            db: &Db,
            current_id: &str,
            target_id: &str,
            visited: &mut std::collections::HashSet<String>,
        ) -> Result<bool, rusqlite::Error> {
            if current_id == target_id {
                return Ok(true);
            }
            if !visited.insert(current_id.to_string()) {
                return Ok(false);
            }
            for blocker_id in db.list_task_blocker_ids(current_id)? {
                if dfs(db, &blocker_id, target_id, visited)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }

        dfs(
            self,
            from_blocked_item_id,
            target_item_id,
            &mut std::collections::HashSet::new(),
        )
    }

    pub fn update_pipeline_item_active_post_action(
        &self,
        id: &str,
        active_post_action: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = ?, updated_at = datetime('now') WHERE id = ?",
            (active_post_action, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn clear_pipeline_item_active_post_action(&self, id: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = NULL, updated_at = datetime('now') WHERE id = ?",
            [id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_post_action_state(
        &self,
        id: &str,
        active_post_action: Option<&str>,
        stage_result: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = ?, stage_result = ?, updated_at = datetime('now') WHERE id = ?",
            (active_post_action, stage_result, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn list_task_ports(&self) -> Result<Vec<i64>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT port FROM task_port ORDER BY port ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    pub fn list_task_ports_for_item(
        &self,
        item_id: &str,
    ) -> Result<HashMap<String, i64>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT env_name, port FROM task_port WHERE pipeline_item_id = ? ORDER BY port ASC",
        )?;
        let rows = stmt.query_map([item_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut ports = HashMap::new();
        for row in rows {
            let (env_name, port) = row?;
            ports.insert(env_name, port);
        }
        Ok(ports)
    }

    pub fn claim_task_port(
        &self,
        item_id: &str,
        env_name: &str,
        port: i64,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)",
            (port, item_id, env_name),
        )?;
        let owner: Option<String> = self
            .conn
            .query_row(
                "SELECT pipeline_item_id FROM task_port WHERE port = ?",
                [port],
                |row| row.get(0),
            )
            .optional()?;
        Ok(owner.as_deref() == Some(item_id))
    }

    pub fn update_pipeline_item_ports(
        &self,
        item_id: &str,
        port_offset: Option<i64>,
        port_env_json: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET port_offset = ?, port_env = ?, updated_at = datetime('now')
             WHERE id = ?",
            (port_offset, port_env_json, item_id),
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
                row.get(0)
            })
            .optional()
    }

    pub fn select_raw(&self, query: &str, bind_values: &[Value]) -> Result<Value, rusqlite::Error> {
        // SECURITY: reject non-SELECT queries
        let trimmed = query.trim_start().to_uppercase();
        if !trimmed.starts_with("SELECT") {
            return Err(rusqlite::Error::InvalidParameterName(
                "Only SELECT queries are allowed".to_string(),
            ));
        }

        let params: Vec<rusqlite::types::Value> =
            bind_values.iter().map(json_to_sqlite_value).collect();

        let mut stmt = self.conn.prepare(query)?;
        let column_count = stmt.column_count();
        let column_names: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).unwrap_or("").to_string())
            .collect();

        let rows = stmt.query_map(params_from_iter(params.iter()), |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value = row.get_ref(i)?;
                let json_val = sqlite_value_to_json(value);
                obj.insert(name.clone(), json_val);
            }
            Ok(Value::Object(obj))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(Value::Array(result))
    }
}

fn json_to_sqlite_value(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                rusqlite::types::Value::Text(n.to_string())
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => {
            rusqlite::types::Value::Text(serde_json::to_string(v).unwrap_or_default())
        }
    }
}

fn sqlite_value_to_json(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => Value::Number(i.into()),
        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rusqlite::types::ValueRef::Text(t) => {
            Value::String(String::from_utf8_lossy(t).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{database_open_flags, Db, NewPipelineItem};
    use rusqlite::Connection;
    use rusqlite::OpenFlags;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        let counter = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("kanna-server-db-{suffix}-{counter}.sqlite"))
    }

    #[test]
    fn database_open_flags_use_sqlite_mutexes_for_shared_desktop_db() {
        let flags = database_open_flags();

        assert!(flags.contains(OpenFlags::SQLITE_OPEN_FULL_MUTEX));
        assert!(!flags.contains(OpenFlags::SQLITE_OPEN_NO_MUTEX));
    }

    #[test]
    fn open_applies_desktop_compatible_pragmas() {
        let path = temp_db_path();
        let conn = Connection::open(&path).expect("open temp db");
        conn.execute_batch("CREATE TABLE probe (id INTEGER PRIMARY KEY);")
            .expect("seed db");
        drop(conn);

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");

        let journal_mode: String = db
            .conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode");
        let foreign_keys: i64 = db
            .conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign keys");
        let busy_timeout: i64 = db
            .conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy timeout");
        let wal_autocheckpoint: i64 = db
            .conn
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .expect("wal autocheckpoint");

        assert_eq!(journal_mode, "wal");
        assert_eq!(foreign_keys, 1);
        assert!(busy_timeout >= 10_000);
        assert_eq!(wal_autocheckpoint, 100);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn server_connection_opens_with_desktop_like_wal_client_active() {
        let path = temp_db_path();
        let desktop_conn = Connection::open(&path).expect("open desktop-like db");
        desktop_conn
            .busy_timeout(std::time::Duration::from_millis(10_000))
            .expect("set busy timeout");
        desktop_conn
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                PRAGMA wal_autocheckpoint = 100;
                CREATE TABLE pipeline_item (
                  id TEXT PRIMARY KEY,
                  stage TEXT NOT NULL,
                  previous_stage TEXT,
                  closed_at TEXT,
                  updated_at TEXT
                );
                INSERT INTO pipeline_item (id, stage) VALUES ('task-1', 'in progress');
                "#,
            )
            .expect("seed desktop-like db");

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open server db");
        db.close_pipeline_item("task-1").expect("server write");

        let stage: String = desktop_conn
            .query_row(
                "SELECT stage FROM pipeline_item WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .expect("desktop-like read");
        assert_eq!(stage, "done");

        drop(db);
        drop(desktop_conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn open_fails_with_clear_error_when_quick_check_cannot_read_database() {
        let path = temp_db_path();
        std::fs::write(&path, b"this is not a sqlite database").expect("write corrupt db");

        let err = Db::open(path.to_str().expect("utf8 path")).expect_err("corrupt db should fail");
        let message = err.to_string();

        assert!(
            message.contains("database disk image is malformed")
                || message.contains("file is not a database")
                || message.contains("quick_check"),
            "unexpected error: {message}"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn close_pipeline_item_marks_task_done() {
        let path = temp_db_path();
        let conn = Connection::open(&path).expect("open temp db");
        conn.execute_batch(
            r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              stage TEXT NOT NULL,
              previous_stage TEXT,
              closed_at TEXT,
              updated_at TEXT
            );
            INSERT INTO pipeline_item (id, stage) VALUES ('task-1', 'in progress');
            "#,
        )
        .expect("seed db");
        drop(conn);

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
        db.close_pipeline_item("task-1").expect("close task");

        let conn = Connection::open(&path).expect("re-open db");
        let (stage, previous_stage, closed_at): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT stage, previous_stage, closed_at FROM pipeline_item WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query row");

        assert_eq!(stage, "done");
        assert_eq!(previous_stage.as_deref(), Some("in progress"));
        assert!(closed_at.is_some());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn close_pipeline_item_accepts_task_branch_name() {
        let path = Db::test_db_path("close-task-branch-name");
        let db = Db::open_for_tests(&path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "",
            None,
            "in progress",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();

        db.close_pipeline_item("task-710917fb")
            .expect("close task by branch name");

        let item = db.get_pipeline_item("710917fb").unwrap().unwrap();
        assert_eq!(item.stage.as_deref(), Some("done"));
    }

    #[test]
    fn update_pipeline_item_stage_does_not_mutate_closed_rows() {
        let path = temp_db_path();
        let conn = Connection::open(&path).expect("open temp db");
        conn.execute_batch(
            r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              stage TEXT NOT NULL,
              stage_result TEXT,
              closed_at TEXT,
              updated_at TEXT
            );
            INSERT INTO pipeline_item (id, stage, closed_at)
            VALUES ('task-1', 'review', '2026-06-03 00:02:25');
            "#,
        )
        .expect("seed db");
        drop(conn);

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
        let err = db
            .update_pipeline_item_stage("task-1", "pr")
            .expect_err("closed task should not be stage-mutated");

        assert!(matches!(err, rusqlite::Error::QueryReturnedNoRows));
        let conn = Connection::open(&path).expect("re-open db");
        let (stage, closed_at): (String, Option<String>) = conn
            .query_row(
                "SELECT stage, closed_at FROM pipeline_item WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query row");
        assert_eq!(stage, "review");
        assert_eq!(closed_at.as_deref(), Some("2026-06-03 00:02:25"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn update_pipeline_item_stage_state_does_not_mutate_closed_rows() {
        let path = temp_db_path();
        let conn = Connection::open(&path).expect("open temp db");
        conn.execute_batch(
            r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              stage TEXT NOT NULL,
              stage_result TEXT,
              closed_at TEXT,
              updated_at TEXT
            );
            INSERT INTO pipeline_item (id, stage, stage_result, closed_at)
            VALUES ('task-1', 'pr', '{"status":"success"}', '2026-06-03 00:02:25');
            "#,
        )
        .expect("seed db");
        drop(conn);

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
        let err = db
            .update_pipeline_item_stage_state("task-1", "review", None)
            .expect_err("closed task should not be stage-state-mutated");

        assert!(matches!(err, rusqlite::Error::QueryReturnedNoRows));
        let conn = Connection::open(&path).expect("re-open db");
        let (stage, stage_result, closed_at): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT stage, stage_result, closed_at FROM pipeline_item WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query row");
        assert_eq!(stage, "pr");
        assert_eq!(stage_result.as_deref(), Some("{\"status\":\"success\"}"));
        assert_eq!(closed_at.as_deref(), Some("2026-06-03 00:02:25"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn resolves_pipeline_item_id_from_task_branch_name() {
        let path = Db::test_db_path("resolve-task-branch-name");
        let db = Db::open_for_tests(&path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "Review branch",
            Some("Review branch"),
            "review",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();

        assert_eq!(
            db.resolve_pipeline_item_id("task-710917fb")
                .unwrap()
                .as_deref(),
            Some("710917fb")
        );
    }

    #[test]
    fn resolves_task_terminal_session_id_from_task_or_branch_name() {
        let path = Db::test_db_path("resolve-task-terminal-session");
        let db = Db::open_for_tests(&path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "Review branch",
            Some("Review branch"),
            "review",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();
        db.conn
            .execute(
                "INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
                 VALUES ('shell-session', 'repo-1', '710917fb', 'shell', '/tmp/repo', 'daemon-shell'),
                        ('agent-session', 'repo-1', '710917fb', 'agent', '/tmp/repo', 'daemon-agent')",
                [],
            )
            .unwrap();

        assert_eq!(
            db.resolve_task_terminal_session_id("710917fb")
                .unwrap()
                .as_deref(),
            Some("daemon-agent")
        );
        assert_eq!(
            db.resolve_task_terminal_session_id("task-710917fb")
                .unwrap()
                .as_deref(),
            Some("daemon-agent")
        );
        assert_eq!(
            db.resolve_task_terminal_session_id("missing").unwrap(),
            None
        );
    }

    #[test]
    fn resolves_task_terminal_session_id_to_pipeline_item_when_no_session_row_exists() {
        let path = Db::test_db_path("resolve-task-terminal-fallback");
        let db = Db::open_for_tests(&path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "710917fb",
            "repo-1",
            "Review branch",
            Some("Review branch"),
            "review",
            "2026-05-11 10:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_stage_context(
            "710917fb",
            "task-710917fb",
            "default",
            None,
            "claude",
        )
        .unwrap();

        assert_eq!(
            db.resolve_task_terminal_session_id("task-710917fb")
                .unwrap()
                .as_deref(),
            Some("710917fb")
        );
    }

    #[test]
    fn insert_pipeline_item_stores_stage_metadata() {
        let path = temp_db_path();
        let conn = Connection::open(&path).expect("open temp db");
        conn.execute_batch(
            r#"
            CREATE TABLE pipeline_item (
              id TEXT PRIMARY KEY,
              repo_id TEXT NOT NULL,
              prompt TEXT,
              pipeline TEXT NOT NULL,
              stage TEXT NOT NULL,
              tags TEXT NOT NULL,
              branch TEXT,
              agent_type TEXT,
              agent_provider TEXT NOT NULL,
              activity TEXT NOT NULL,
              activity_changed_at TEXT,
              port_offset INTEGER,
              port_env TEXT,
              base_ref TEXT,
              display_name TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .expect("seed db");
        drop(conn);

        let db = Db::open(path.to_str().expect("utf8 path")).expect("open db");
        db.insert_pipeline_item(NewPipelineItem {
            id: "task-2",
            repo_id: "repo-1",
            prompt: "Merge queued pull requests",
            pipeline: "default",
            stage: "in progress",
            tags_json: "[\"in progress\"]",
            branch: "task-task-2",
            agent_type: "pty",
            agent_provider: "claude",
            activity: "working",
            port_offset: Some(1422),
            port_env_json: Some("{\"KANNA_DEV_PORT\":\"1422\"}"),
            base_ref: None,
            display_name: Some("Merge queue"),
        })
        .expect("insert pipeline item");

        let conn = Connection::open(&path).expect("re-open db");
        let row: (String, String, String, String, String, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT repo_id, prompt, pipeline, stage, activity, port_offset, display_name FROM pipeline_item WHERE id = 'task-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .expect("query row");

        assert_eq!(row.0, "repo-1");
        assert_eq!(row.1, "Merge queued pull requests");
        assert_eq!(row.2, "default");
        assert_eq!(row.3, "in progress");
        assert_eq!(row.4, "working");
        assert_eq!(row.5, Some(1422));
        assert_eq!(row.6.as_deref(), Some("Merge queue"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn task_listing_queries_exclude_closed_items_even_when_stage_is_not_done() {
        let path = Db::test_db_path("closed-item-filtering");
        let db = Db::open_for_tests(&path).expect("open test db");
        db.insert_test_repo("repo-1", "Repo One")
            .expect("insert repo");
        db.insert_test_pipeline_item(
            "task-open",
            "repo-1",
            "visible task",
            Some("Visible Task"),
            "in progress",
            "2026-04-18 10:00:00",
        )
        .expect("insert open task");
        db.insert_test_pipeline_item(
            "task-closed",
            "repo-1",
            "stale task",
            Some("Stale Task"),
            "in progress",
            "2026-04-18 11:00:00",
        )
        .expect("insert stale task");
        db.conn
            .execute(
                "UPDATE pipeline_item SET closed_at = datetime('now') WHERE id = ?",
                ["task-closed"],
            )
            .expect("mark stale task closed");

        let recent_ids = db
            .list_recent_pipeline_items()
            .expect("list recent tasks")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        let repo_ids = db
            .list_pipeline_items("repo-1")
            .expect("list repo tasks")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        let search_ids = db
            .search_pipeline_items("task")
            .expect("search tasks")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();

        assert_eq!(recent_ids, vec!["task-open"]);
        assert_eq!(repo_ids, vec!["task-open"]);
        assert_eq!(search_ids, vec!["task-open"]);

        let _ = std::fs::remove_file(path);
    }
}
