use super::{Db, NewPipelineItem, PipelineItem, TaskStageSource};
use rusqlite::OptionalExtension;

impl Db {
    pub fn list_recent_pipeline_items(&self) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, stage_result,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id
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
                pipeline: row.get(5)?,
                stage: row.get(6)?,
                stage_result: row.get(7)?,
                pr_number: row.get(8)?,
                pr_url: row.get(9)?,
                branch: row.get(10)?,
                agent_type: row.get(11)?,
                agent_provider: row.get(12)?,
                activity: row.get(13)?,
                activity_changed_at: row.get(14)?,
                closed_at: row.get(15)?,
                pinned: row.get(16)?,
                pin_order: row.get(17)?,
                display_name: row.get(18)?,
                last_output_preview: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                base_ref: row.get(22)?,
                notify_task_id: row.get(23)?,
                notified_at: row.get(24)?,
                parent_task_id: row.get(25)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_pipeline_items(&self, query: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let like_query = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, stage_result,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id
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
                pipeline: row.get(5)?,
                stage: row.get(6)?,
                stage_result: row.get(7)?,
                pr_number: row.get(8)?,
                pr_url: row.get(9)?,
                branch: row.get(10)?,
                agent_type: row.get(11)?,
                agent_provider: row.get(12)?,
                activity: row.get(13)?,
                activity_changed_at: row.get(14)?,
                closed_at: row.get(15)?,
                pinned: row.get(16)?,
                pin_order: row.get(17)?,
                display_name: row.get(18)?,
                last_output_preview: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                base_ref: row.get(22)?,
                notify_task_id: row.get(23)?,
                notified_at: row.get(24)?,
                parent_task_id: row.get(25)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, stage_result, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id \
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
                pipeline: row.get(5)?,
                stage: row.get(6)?,
                stage_result: row.get(7)?,
                pr_number: row.get(8)?,
                pr_url: row.get(9)?,
                branch: row.get(10)?,
                agent_type: row.get(11)?,
                agent_provider: row.get(12)?,
                activity: row.get(13)?,
                activity_changed_at: row.get(14)?,
                closed_at: row.get(15)?,
                pinned: row.get(16)?,
                pin_order: row.get(17)?,
                display_name: row.get(18)?,
                last_output_preview: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                base_ref: row.get(22)?,
                notify_task_id: row.get(23)?,
                notified_at: row.get(24)?,
                parent_task_id: row.get(25)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, stage_result, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id \
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                pipeline: row.get(5)?,
                stage: row.get(6)?,
                stage_result: row.get(7)?,
                pr_number: row.get(8)?,
                pr_url: row.get(9)?,
                branch: row.get(10)?,
                agent_type: row.get(11)?,
                agent_provider: row.get(12)?,
                activity: row.get(13)?,
                activity_changed_at: row.get(14)?,
                closed_at: row.get(15)?,
                pinned: row.get(16)?,
                pin_order: row.get(17)?,
                display_name: row.get(18)?,
                last_output_preview: row.get(19)?,
                created_at: row.get(20)?,
                updated_at: row.get(21)?,
                base_ref: row.get(22)?,
                notify_task_id: row.get(23)?,
                notified_at: row.get(24)?,
                parent_task_id: row.get(25)?,
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

        let stage_run_session_id = self
            .conn
            .query_row(
                "SELECT daemon_session_id
                 FROM stage_run
                 WHERE pipeline_item_id = ?
                   AND status = 'running'
                   AND daemon_session_id IS NOT NULL
                   AND daemon_session_id != ''
                 ORDER BY rowid DESC
                 LIMIT 1",
                [&pipeline_item_id],
                |row| row.get(0),
            )
            .optional()?;
        if stage_run_session_id.is_some() {
            return Ok(stage_run_session_id);
        }

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

    pub fn insert_stage_run(
        &self,
        id: &str,
        pipeline_item_id: &str,
        stage: &str,
        status: &str,
        daemon_session_id: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO stage_run (id, pipeline_item_id, stage, status, daemon_session_id, feedback)
             VALUES (?, ?, ?, ?, ?, ?)",
            (id, pipeline_item_id, stage, status, daemon_session_id, feedback),
        )?;
        Ok(())
    }

    pub fn finish_running_stage_runs(
        &self,
        pipeline_item_id: &str,
        result_json: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE stage_run
             SET status = 'finished',
                 result_json = COALESCE(?, result_json),
                 finished_at = datetime('now')
             WHERE pipeline_item_id = ? AND status = 'running'",
            (result_json, pipeline_item_id),
        )?;
        Ok(())
    }

    pub fn count_stage_runs_for_task(&self, pipeline_item_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM stage_run WHERE pipeline_item_id = ?",
            [pipeline_item_id],
            |row| row.get(0),
        )
    }

    pub fn get_task_stage_source(
        &self,
        id: &str,
    ) -> Result<Option<TaskStageSource>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT repo_id, prompt, display_name, stage, stage_result, active_post_action, branch, base_ref, pipeline, agent_type, agent_provider, closed_at
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(TaskStageSource {
                repo_id: row.get(0)?,
                prompt: row.get(1)?,
                display_name: row.get(2)?,
                stage: row.get(3)?,
                stage_result: row.get(4)?,
                active_post_action: row.get(5)?,
                branch: row.get(6)?,
                base_ref: row.get(7)?,
                pipeline: row.get(8)?,
                agent_type: row.get(9)?,
                agent_provider: row.get(10)?,
                closed_at: row.get(11)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn insert_pipeline_item(&self, item: NewPipelineItem<'_>) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO pipeline_item
             (id, repo_id, prompt, display_name, pipeline, stage, tags, branch, agent_type, agent_provider,
              activity, activity_changed_at, port_offset, port_env, base_ref, notify_task_id, parent_task_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)",
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
                item.notify_task_id,
                item.parent_task_id,
            ),
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn get_test_pipeline_item_parent(
        &self,
        id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn.query_row(
            "SELECT parent_task_id FROM pipeline_item WHERE id = ?",
            [id],
            |row| row.get(0),
        )
    }

    pub fn count_open_children(&self, parent_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM pipeline_item WHERE parent_task_id = ? AND closed_at IS NULL",
            [parent_id],
            |row| row.get(0),
        )
    }

    pub fn pipeline_item_parent(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT parent_task_id FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    pub fn update_pipeline_item_parent(
        &self,
        id: &str,
        parent_task_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET parent_task_id = ?, updated_at = datetime('now') WHERE id = ?",
            (parent_task_id, id),
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
        self.conn.execute(
            "UPDATE pipeline_item
             SET activity = ?, activity_changed_at = datetime('now'),
                 unread_at = CASE WHEN ? = 'unread' THEN datetime('now') ELSE unread_at END,
                 updated_at = datetime('now')
             WHERE id = ? AND activity != ? AND closed_at IS NULL",
            (activity, activity, id, activity),
        )?;
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

    pub fn update_pipeline_item_display_name(
        &self,
        id: &str,
        display_name: &str,
    ) -> Result<(), rusqlite::Error> {
        let Some(pipeline_item_id) = self.resolve_pipeline_item_id(id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET display_name = ?, updated_at = datetime('now')
             WHERE id = ?",
            (display_name, pipeline_item_id),
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
}
