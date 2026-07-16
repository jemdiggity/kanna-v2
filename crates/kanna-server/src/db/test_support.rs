use super::{configure_shared_database_connection, database_create_flags, Db};
use crate::db::CURRENT_SCHEMA_MIGRATIONS;
use rusqlite::Connection;
use std::path::PathBuf;

impl Db {
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
    pub fn get_test_pipeline_item_ports(
        &self,
        id: &str,
    ) -> Result<(Option<i64>, Option<String>), rusqlite::Error> {
        self.conn.query_row(
            "SELECT port_offset, port_env FROM pipeline_item WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }

    #[cfg(test)]
    pub fn get_test_pipeline_item_spawn_options(
        &self,
        id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn.query_row(
            "SELECT agent_spawn_options FROM pipeline_item WHERE id = ?",
            [id],
            |row| row.get(0),
        )
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
                remote_url TEXT,
                remote_url_hash TEXT,
                hidden INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                last_opened_at TEXT
            );

            CREATE TABLE pipeline_item (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                issue_number INTEGER,
                issue_title TEXT,
                prompt TEXT,
                pipeline_def TEXT,
                stage TEXT,
                pr_number INTEGER,
                pr_url TEXT,
                pr_branch TEXT,
                branch TEXT,
                agent_type TEXT,
                activity TEXT,
                activity_changed_at TEXT,
                unread_at TEXT,
                pinned INTEGER,
                pin_order INTEGER,
                display_name TEXT,
                last_output_preview TEXT,
                created_at TEXT,
                updated_at TEXT,
                closed_at TEXT,
                pipeline TEXT,
                agent_provider TEXT,
                port_offset INTEGER,
                port_env TEXT,
                base_ref TEXT,
                notify_task_id TEXT,
                notified_at TEXT,
                parent_task_id TEXT,
                agent_session_id TEXT,
                agent_spawn_options TEXT,
                teardown_started_at TEXT
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

            CREATE TABLE stage_run (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
                agent TEXT,
                agent_provider TEXT,
                model TEXT,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
                result TEXT,
                feedback TEXT,
                session_id TEXT,
                provider_session_id TEXT,
                cwd TEXT,
                resumed_from_run_id TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                finished_at TEXT
            );
            CREATE INDEX idx_stage_run_task_started ON stage_run(task_id, started_at);

            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE schema_migrations (
                id TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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

            CREATE TABLE operator_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                pipeline_item_id TEXT,
                repo_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE activity_log (
                pipeline_item_id TEXT NOT NULL,
                activity TEXT NOT NULL,
                seconds INTEGER NOT NULL,
                PRIMARY KEY (pipeline_item_id, activity)
            );

            CREATE TABLE task_transfer (
                id TEXT PRIMARY KEY,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                source_peer_id TEXT,
                target_peer_id TEXT,
                source_task_id TEXT,
                local_task_id TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at TEXT,
                error TEXT,
                payload_json TEXT
            );
            "#,
        )?;
        let mut stmt = self
            .conn
            .prepare("INSERT INTO schema_migrations (id) VALUES (?1)")?;
        for id in CURRENT_SCHEMA_MIGRATIONS {
            stmt.execute([id])?;
        }
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
            "INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
             VALUES (?, ?, ?, 'main', 0, 0, datetime('now'), datetime('now'))",
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
                pinned, pin_order, display_name, created_at, updated_at, pipeline, agent_provider
             ) VALUES (?, ?, ?, ?, ?, 'pty', 'idle', 0, NULL, ?, ?, ?, 'default', 'claude')",
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
    pub fn set_test_pipeline_item_closed_at(
        &self,
        id: &str,
        closed_at: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET closed_at = ?, updated_at = ? WHERE id = ?",
            (closed_at, closed_at, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_activity_log(
        &self,
        pipeline_item_id: &str,
        activity: &str,
        seconds: i64,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO activity_log (pipeline_item_id, activity, seconds)
             VALUES (?, ?, ?)",
            (pipeline_item_id, activity, seconds),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_operator_event(
        &self,
        event_type: &str,
        pipeline_item_id: Option<&str>,
        repo_id: Option<&str>,
        created_at: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO operator_event (event_type, pipeline_item_id, repo_id, created_at)
             VALUES (?, ?, ?, ?)",
            (event_type, pipeline_item_id, repo_id, created_at),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn insert_test_task_transfer(
        &self,
        id: &str,
        direction: &str,
        status: &str,
        payload_json: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO task_transfer (
                id, direction, status, source_peer_id, source_task_id, payload_json
             ) VALUES (?, ?, ?, 'peer-1', 'source-task-1', ?)",
            (id, direction, status, payload_json),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_stage_context(
        &self,
        id: &str,
        branch: &str,
        pipeline: &str,
        _stage_result: Option<&str>,
        agent_provider: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET branch = ?, pipeline = ?, agent_provider = ?
             WHERE id = ?",
            (branch, pipeline, agent_provider, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_agent_type(
        &self,
        id: &str,
        agent_type: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET agent_type = ? WHERE id = ?",
            (agent_type, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_notify_task(
        &self,
        id: &str,
        notify_task_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET notify_task_id = ? WHERE id = ?",
            (notify_task_id, id),
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
    pub fn update_test_pipeline_item_branch(
        &self,
        id: &str,
        branch: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET branch = ? WHERE id = ?",
            (branch, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_pr_url(
        &self,
        id: &str,
        pr_url: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET pr_url = ? WHERE id = ?",
            (pr_url, id),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_pipeline_def(
        &self,
        id: &str,
        pipeline_def: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET pipeline_def = ? WHERE id = ?",
            (pipeline_def, id),
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
}
