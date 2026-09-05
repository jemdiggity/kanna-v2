use super::{
    configure_shared_database_connection, create_blocker_revision_triggers, database_create_flags,
    Db,
};
use crate::db::CURRENT_SCHEMA_MIGRATIONS;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

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

    pub fn count_test_sqlite_progress(&self, every_ops: i32, counter: Arc<AtomicUsize>) {
        self.conn.progress_handler(
            every_ops,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        );
    }

    pub fn clear_test_sqlite_progress_handler(&self) {
        self.conn.progress_handler(0, None::<fn() -> bool>);
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
                default_branch_source TEXT,
                remote_url TEXT,
                remote_url_hash TEXT,
                hidden INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                last_opened_at TEXT
            );

            CREATE TABLE repo_sidebar_order (
                remote_url_hash TEXT PRIMARY KEY,
                sort_order INTEGER NOT NULL
            );

            CREATE TABLE pipeline_item (
                id TEXT PRIMARY KEY,
                cloud_task_id TEXT,
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
                activity_revision INTEGER NOT NULL DEFAULT 0,
                blocker_revision INTEGER NOT NULL DEFAULT 0,
                activity_changed_at TEXT,
                activity_event_baseline TEXT,
                activity_event_pending_at TEXT,
                unread_at TEXT,
                pinned INTEGER,
                pin_order INTEGER,
                display_name TEXT,
                last_output_preview TEXT,
                created_at TEXT,
                updated_at TEXT,
                closed_at TEXT,
                pipeline TEXT,
                initial_pipeline TEXT,
                agent_provider TEXT,
                port_offset INTEGER,
                port_env TEXT,
                base_ref TEXT,
                notify_task_id TEXT,
                notified_at TEXT,
                parent_task_id TEXT,
                agent_session_id TEXT,
                agent_spawn_options TEXT,
                teardown_started_at TEXT,
                revision_rounds INTEGER NOT NULL DEFAULT 0,
                merge_signaled_at TEXT,
                runtime_status TEXT,
                runtime_event_baseline TEXT,
                runtime_event_pending_at TEXT,
                input_blocked TEXT,
                composer_text TEXT,
                composer_attestation TEXT
            );
            CREATE UNIQUE INDEX idx_pipeline_item_open_cloud_task_id
            ON pipeline_item(cloud_task_id)
            WHERE closed_at IS NULL;
            CREATE INDEX idx_pipeline_item_parent_created_id
            ON pipeline_item(parent_task_id, created_at, id);
            CREATE INDEX idx_pipeline_item_repo_id_id
            ON pipeline_item(repo_id, id);
            CREATE INDEX idx_repo_remote_url_hash_id
            ON repo(remote_url_hash, id);

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

            CREATE TABLE create_task_intent (
                task_id TEXT PRIMARY KEY,
                request_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (task_id) REFERENCES pipeline_item(id) ON DELETE CASCADE
            );

            CREATE TABLE lifecycle_operation_intent (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('post', 'stage_spawn')),
                phase TEXT NOT NULL CHECK (phase IN ('prepared', 'spawn_ready', 'submitted', 'committed')),
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX idx_lifecycle_operation_intent_task
                ON lifecycle_operation_intent(task_id);

            CREATE TABLE stage_run (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
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
                trigger TEXT CHECK (trigger IN ('auto', 'operator', 'manager', 'unspecified')),
                completion_bound INTEGER NOT NULL DEFAULT 0,
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

            CREATE TABLE task_event (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                type TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX idx_task_event_task_seq ON task_event(task_id, seq);

            CREATE TABLE task_input (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                run_id TEXT,
                stage TEXT,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX idx_task_input_task_id ON task_input(task_id, id);

            CREATE TABLE queued_task_input (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('preparing', 'held', 'uncertain')),
                reason TEXT,
                session_pid INTEGER,
                queued_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX idx_queued_task_input_task_id
                ON queued_task_input(task_id, id);

            CREATE TABLE task_transfer (
                id TEXT PRIMARY KEY,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                source_peer_id TEXT,
                target_peer_id TEXT,
                source_desktop_id TEXT,
                target_desktop_id TEXT,
                source_task_id TEXT,
                local_task_id TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                completed_at TEXT,
                error TEXT,
                payload_json TEXT,
                sidecar_cleanup_completed_at TEXT,
                claim_owner_token TEXT,
                claim_expires_at TEXT
            );
            CREATE UNIQUE INDEX idx_task_transfer_active_outgoing_source
            ON task_transfer(source_task_id)
            WHERE direction = 'outgoing'
              AND source_task_id IS NOT NULL
              AND status IN ('pending', 'streaming');

            CREATE TABLE transfer_work (
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
            CREATE INDEX idx_transfer_work_runnable
                ON transfer_work(status, run_after, created_at);

            CREATE TABLE transfer_work_phase (
                work_id TEXT NOT NULL REFERENCES transfer_work(id) ON DELETE CASCADE,
                phase TEXT NOT NULL,
                claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
                value TEXT,
                PRIMARY KEY (work_id, phase)
            );
            "#,
        )?;
        create_blocker_revision_triggers(&self.conn)?;
        let mut stmt = self
            .conn
            .prepare("INSERT INTO schema_migrations (id) VALUES (?1)")?;
        super::create_contextless_completion_attempt_schema(&self.conn)?;
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
                pinned, pin_order, display_name, created_at, updated_at, pipeline,
                initial_pipeline, agent_provider
             ) VALUES (?, ?, ?, ?, ?, 'pty', 'idle', 0, NULL, ?, ?, ?, 'default', 'default', 'claude')",
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
    pub fn insert_test_task_transfer_with_desktops(
        &self,
        id: &str,
        direction: &str,
        status: &str,
        local_task_id: Option<&str>,
        source_desktop_id: Option<&str>,
        target_desktop_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO task_transfer (
                id, direction, status, source_peer_id, target_peer_id,
                source_desktop_id, target_desktop_id, source_task_id, local_task_id
             ) VALUES (?, ?, ?, 'peer-1', 'peer-2', ?, ?, 'source-task-1', ?)",
            (
                id,
                direction,
                status,
                source_desktop_id,
                target_desktop_id,
                local_task_id,
            ),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn update_test_pipeline_item_stage_context(
        &self,
        id: &str,
        branch: &str,
        workflow_name: &str,
        _stage_result: Option<&str>,
        agent_provider: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET branch = ?, pipeline = ?, agent_provider = ?
             WHERE id = ?",
            (branch, workflow_name, agent_provider, id),
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
