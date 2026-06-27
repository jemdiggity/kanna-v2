use super::{Db, NewPipelineItem, PipelineItem, TaskStageSource};
use rusqlite::OptionalExtension;

impl Db {
    pub fn list_recent_pipeline_items(&self) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at
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
                pr_number: row.get(7)?,
                pr_url: row.get(8)?,
                branch: row.get(9)?,
                agent_type: row.get(10)?,
                agent_provider: row.get(11)?,
                activity: row.get(12)?,
                activity_changed_at: row.get(13)?,
                closed_at: row.get(14)?,
                pinned: row.get(15)?,
                pin_order: row.get(16)?,
                display_name: row.get(17)?,
                last_output_preview: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
                base_ref: row.get(21)?,
                notify_task_id: row.get(22)?,
                notified_at: row.get(23)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_pipeline_items(&self, query: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let like_query = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at
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
                pr_number: row.get(7)?,
                pr_url: row.get(8)?,
                branch: row.get(9)?,
                agent_type: row.get(10)?,
                agent_provider: row.get(11)?,
                activity: row.get(12)?,
                activity_changed_at: row.get(13)?,
                closed_at: row.get(14)?,
                pinned: row.get(15)?,
                pin_order: row.get(16)?,
                display_name: row.get(17)?,
                last_output_preview: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
                base_ref: row.get(21)?,
                notify_task_id: row.get(22)?,
                notified_at: row.get(23)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at \
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
                pr_number: row.get(7)?,
                pr_url: row.get(8)?,
                branch: row.get(9)?,
                agent_type: row.get(10)?,
                agent_provider: row.get(11)?,
                activity: row.get(12)?,
                activity_changed_at: row.get(13)?,
                closed_at: row.get(14)?,
                pinned: row.get(15)?,
                pin_order: row.get(16)?,
                display_name: row.get(17)?,
                last_output_preview: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
                base_ref: row.get(21)?,
                notify_task_id: row.get(22)?,
                notified_at: row.get(23)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at \
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
                pr_number: row.get(7)?,
                pr_url: row.get(8)?,
                branch: row.get(9)?,
                agent_type: row.get(10)?,
                agent_provider: row.get(11)?,
                activity: row.get(12)?,
                activity_changed_at: row.get(13)?,
                closed_at: row.get(14)?,
                pinned: row.get(15)?,
                pin_order: row.get(16)?,
                display_name: row.get(17)?,
                last_output_preview: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
                base_ref: row.get(21)?,
                notify_task_id: row.get(22)?,
                notified_at: row.get(23)?,
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

    pub fn get_task_stage_source(
        &self,
        id: &str,
    ) -> Result<Option<TaskStageSource>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT repo_id, issue_title, prompt, display_name, stage, stage_result, active_post_action, branch, base_ref, pipeline, agent_type, agent_provider, closed_at
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
                agent_type: row.get(10)?,
                agent_provider: row.get(11)?,
                closed_at: row.get(12)?,
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
              activity, activity_changed_at, port_offset, port_env, base_ref, notify_task_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)",
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
            ),
        )?;
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
