use super::{
    CloudTaskIdentityWrite, Db, NewPipelineItem, OpenAgentTask, PipelineItem, PipelineItemChild,
    ReopenPipelineItemError, TaskEventKind, TaskStageSource,
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;

impl Db {
    pub fn list_task_completion_runs(
        &self,
    ) -> Result<Vec<(String, bool, Option<String>)>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT p.id, p.closed_at IS NULL,
                        (SELECT s.id
                         FROM stage_run s
                         WHERE s.task_id = p.id
                         ORDER BY s.rowid DESC
                         LIMIT 1)
                 FROM pipeline_item p",
        )?;
        let runs = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(runs)
    }

    fn pipeline_item_stage(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT stage FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// Pipeline names most recently chosen by operator-initiated task creates
    /// in a repo, newest first and deduplicated. `initial_pipeline` is
    /// intentionally immutable: changing an existing task's current pipeline
    /// must not rewrite the sticky choice used for the next new task.
    ///
    /// This reads the durable task rows and deliberately does not filter on
    /// `closed_at`. The New Task modal's sticky default has to survive the task
    /// closing — including a close from another window — and the desktop
    /// snapshot (`db::snapshot`) excludes closed tasks, so the snapshot cannot
    /// answer this question. A row exists here exactly when a create succeeded
    /// durably, which is also why a lost create response cannot lose the
    /// choice: the row was already committed.
    ///
    /// Child tasks are excluded. A specialty review that a review stage
    /// dispatched is not a pipeline the operator picked, and letting those rows
    /// win would hijack the default after every dispatched review.
    ///
    /// Ordered by `rowid`, i.e. insertion order. `created_at` is second
    /// resolution text, so tasks created within the same second tie under it.
    pub fn recent_repo_pipelines(
        &self,
        repo_id: &str,
        limit: u32,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT initial_pipeline
             FROM pipeline_item
             WHERE repo_id = ?1
               AND parent_task_id IS NULL
               AND initial_pipeline IS NOT NULL
               AND initial_pipeline <> ''
             GROUP BY initial_pipeline
             ORDER BY MAX(rowid) DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![repo_id, limit], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn list_recent_pipeline_items(&self) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds
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
                parent_task_id: row.get(24)?,
                pipeline_def: row.get(25)?,
                activity_revision: row.get(26)?,
                cloud_task_id: row.get(27)?,
                revision_rounds: row.get(28)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_pipeline_items(&self, query: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let like_query = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds
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
                parent_task_id: row.get(24)?,
                pipeline_def: row.get(25)?,
                activity_revision: row.get(26)?,
                cloud_task_id: row.get(27)?,
                revision_rounds: row.get(28)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds \
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
                parent_task_id: row.get(24)?,
                pipeline_def: row.get(25)?,
                activity_revision: row.get(26)?,
                cloud_task_id: row.get(27)?,
                revision_rounds: row.get(28)?,
            })
        })?;
        rows.collect()
    }

    /// Direct children of `parent_id`, oldest first, with the lifecycle and
    /// pipeline identity a fan-out owner joins its children by. This is the
    /// single child query; [`Db::list_child_task_ids`] is its id projection,
    /// so both surfaces always agree on membership and ordering.
    ///
    /// Deliberately **includes closed children** — see `list_child_task_ids`
    /// for why parentage outlives closure.
    pub fn list_pipeline_item_children(
        &self,
        parent_id: &str,
    ) -> Result<Vec<PipelineItemChild>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, pipeline, created_at, closed_at
             FROM pipeline_item
             WHERE parent_task_id = ?
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([parent_id], |row| {
            Ok(PipelineItemChild {
                id: row.get(0)?,
                pipeline: row.get(1)?,
                created_at: row.get(2)?,
                closed_at: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds \
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
                parent_task_id: row.get(24)?,
                pipeline_def: row.get(25)?,
                activity_revision: row.get(26)?,
                cloud_task_id: row.get(27)?,
                revision_rounds: row.get(28)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn update_pipeline_item_waiting_prompt(
        &self,
        id: &str,
        prompt: &str,
    ) -> Result<bool, rusqlite::Error> {
        let Some(task_id) = self.resolve_pipeline_item_id(id)? else {
            return Ok(false);
        };
        let changed = self.conn.execute(
            "UPDATE pipeline_item
             SET last_output_preview = ?, updated_at = datetime('now')
             WHERE id = ?
               AND closed_at IS NULL
               AND COALESCE(last_output_preview, '') != ?",
            (prompt, &task_id, prompt),
        )?;
        Ok(changed > 0)
    }

    pub fn set_cloud_task_identity(
        &self,
        task_id: &str,
        cloud_task_id: &str,
    ) -> Result<CloudTaskIdentityWrite, rusqlite::Error> {
        let existing = self
            .conn
            .query_row(
                "SELECT cloud_task_id FROM pipeline_item WHERE id = ?",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;

        match existing {
            None => return Ok(CloudTaskIdentityWrite::TaskNotFound),
            Some(Some(existing)) if existing == cloud_task_id => {
                return Ok(CloudTaskIdentityWrite::Unchanged);
            }
            Some(Some(_)) => return Ok(CloudTaskIdentityWrite::Conflict),
            Some(None) => {}
        }

        match self.conn.execute(
            "UPDATE pipeline_item
             SET cloud_task_id = ?, updated_at = datetime('now')
             WHERE id = ? AND cloud_task_id IS NULL",
            (cloud_task_id, task_id),
        ) {
            Ok(1) => Ok(CloudTaskIdentityWrite::Updated),
            Ok(_) => {
                let current = self
                    .conn
                    .query_row(
                        "SELECT cloud_task_id FROM pipeline_item WHERE id = ?",
                        [task_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()?;
                Ok(match current {
                    None => CloudTaskIdentityWrite::TaskNotFound,
                    Some(Some(current)) if current == cloud_task_id => {
                        CloudTaskIdentityWrite::Unchanged
                    }
                    Some(_) => CloudTaskIdentityWrite::Conflict,
                })
            }
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Ok(CloudTaskIdentityWrite::Conflict)
            }
            Err(error) => Err(error),
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
        if terminal_session_id.is_some() {
            return Ok(terminal_session_id);
        }

        let stage_run_session_id = self
            .conn
            .query_row(
                "SELECT session_id
                 FROM stage_run
                 WHERE task_id = ?
                   AND status = 'running'
                   AND session_id IS NOT NULL
                   AND session_id != ''
                 ORDER BY rowid DESC
                 LIMIT 1",
                [&pipeline_item_id],
                |row| row.get(0),
            )
            .optional()?;
        if stage_run_session_id.is_some() {
            return Ok(stage_run_session_id);
        }

        Ok(Some(pipeline_item_id))
    }

    pub fn find_open_agent_task(
        &self,
        repo_id: &str,
        agent: &str,
    ) -> Result<Option<OpenAgentTask>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT p.id, COALESCE(NULLIF(sr.session_id, ''), p.id)
                 FROM pipeline_item p
                 JOIN stage_run sr ON sr.task_id = p.id
                 WHERE p.repo_id = ?
                   AND p.closed_at IS NULL
                   AND sr.agent = ?
                 ORDER BY p.rowid DESC
                 LIMIT 1",
                (repo_id, agent),
                |row| {
                    Ok(OpenAgentTask {
                        task_id: row.get(0)?,
                        session_id: row.get(1)?,
                    })
                },
            )
            .optional()
    }

    pub fn get_task_stage_source(
        &self,
        id: &str,
    ) -> Result<Option<TaskStageSource>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT repo_id, issue_title, prompt, display_name, stage, branch, base_ref, pipeline, pipeline_def, agent_type, agent_provider, closed_at
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(TaskStageSource {
                repo_id: row.get(0)?,
                issue_title: row.get(1)?,
                prompt: row.get(2)?,
                display_name: row.get(3)?,
                stage: row.get(4)?,
                branch: row.get(5)?,
                base_ref: row.get(6)?,
                pipeline: row.get(7)?,
                pipeline_def: row.get(8)?,
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

    pub fn get_pipeline_item_agent_spawn_options(
        &self,
        id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT agent_spawn_options FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    #[allow(dead_code)]
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
             (id, repo_id, prompt, display_name, pipeline, initial_pipeline, stage, branch, agent_type, agent_provider,
              activity, activity_changed_at, port_offset, port_env, agent_spawn_options, base_ref, notify_task_id, parent_task_id, pipeline_def)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)",
            params![
                item.id,
                item.repo_id,
                item.prompt,
                item.display_name,
                item.pipeline,
                item.pipeline,
                item.stage,
                item.branch,
                item.agent_type,
                item.agent_provider,
                item.activity,
                item.port_offset,
                item.port_env_json,
                item.agent_spawn_options_json,
                item.base_ref,
                item.notify_task_id,
                item.parent_task_id,
                item.pipeline_def,
            ],
        )?;
        self.append_task_event(
            item.id,
            TaskEventKind::TaskCreated,
            json!({
                "repoId": item.repo_id,
                "stage": item.stage,
                "displayName": item.display_name,
                "parentTaskId": item.parent_task_id,
            }),
        )?;
        Ok(())
    }

    pub fn pin_pipeline_item_at_top(
        &self,
        repo_id: &str,
        task_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE pipeline_item
             SET pin_order = COALESCE(pin_order, 0) + 1,
                 updated_at = datetime('now')
             WHERE repo_id = ? AND closed_at IS NULL AND pinned = 1",
            [repo_id],
        )?;
        let rows_affected = transaction.execute(
            "UPDATE pipeline_item
             SET pinned = 1, pin_order = 0, updated_at = datetime('now')
             WHERE id = ?",
            [task_id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pin_pipeline_item(&self, task_id: &str, pin_order: i64) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET pinned = 1, pin_order = ?, updated_at = datetime('now') WHERE id = ?",
            (pin_order, task_id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn unpin_pipeline_item(&self, task_id: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET pinned = 0, pin_order = NULL, updated_at = datetime('now') WHERE id = ?",
            [task_id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn reorder_pinned_items(
        &self,
        repo_id: &str,
        ordered_ids: &[String],
    ) -> Result<(), rusqlite::Error> {
        for (index, task_id) in ordered_ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE pipeline_item SET pin_order = ?, updated_at = datetime('now') WHERE id = ? AND repo_id = ?",
                (index as i64, task_id, repo_id),
            )?;
        }
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

    /// Direct children of `parent_id`, oldest first — the downward read of the
    /// parentage `pipeline_item.parent_task_id` records upward.
    ///
    /// Deliberately **includes closed children**. Parentage is durable and a
    /// fan-out orchestrator reconciles finished work: a filter on
    /// `closed_at IS NULL` would hide exactly the children it needs and make an
    /// empty result indistinguishable from "no children were ever created".
    /// Grandchildren are not included; this is the direct-child set, so it
    /// matches the `parent_task_id` scope of the task-event feed exactly.
    pub fn list_child_task_ids(&self, parent_id: &str) -> Result<Vec<String>, rusqlite::Error> {
        Ok(self
            .list_pipeline_item_children(parent_id)?
            .into_iter()
            .map(|child| child.id)
            .collect())
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
        if self.conn.is_autocommit() {
            self.with_immediate_transaction(|db| {
                db.update_pipeline_item_activity_in_transaction(id, activity)
            })
        } else {
            self.update_pipeline_item_activity_in_transaction(id, activity)
        }
    }

    fn update_pipeline_item_activity_in_transaction(
        &self,
        id: &str,
        activity: &str,
    ) -> Result<(), rusqlite::Error> {
        let current = self
            .conn
            .query_row(
                "SELECT activity, last_output_preview
                 FROM pipeline_item
                 WHERE id = ? AND closed_at IS NULL",
                [id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let Some((previous_activity, waiting_prompt_snippet)) = current else {
            return Ok(());
        };
        if previous_activity.as_deref() == Some(activity) {
            return Ok(());
        }

        self.conn.execute(
            "UPDATE pipeline_item
             SET activity = ?, activity_changed_at = datetime('now'),
                 activity_revision = activity_revision + 1,
                 unread_at = CASE WHEN ? = 'unread' THEN datetime('now') ELSE unread_at END,
                 updated_at = datetime('now')
             WHERE id = ?",
            (activity, activity, id),
        )?;

        let waiting_prompt_snippet = waiting_prompt_snippet
            .as_deref()
            .map(str::trim)
            .filter(|snippet| !snippet.is_empty());
        if previous_activity.as_deref() == Some("working")
            && matches!(activity, "idle" | "unread")
            && waiting_prompt_snippet.is_some()
        {
            self.append_task_event(
                id,
                TaskEventKind::ActivityChanged,
                json!({
                    "previousActivity": "working",
                    "activity": activity,
                    "waitingPromptSnippet": waiting_prompt_snippet,
                }),
            )?;
        }
        Ok(())
    }

    /// Agent-requested revision rounds recorded since the last
    /// human-requested revision. The engine caps this to keep a review agent
    /// from driving a task through unbounded revise/review loops.
    pub fn task_revision_rounds(&self, id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT revision_rounds FROM pipeline_item WHERE id = ?",
            [id],
            |row| row.get(0),
        )
    }

    /// Claim one agent-requested revision round if the budget still allows
    /// it, returning the new total — or `None` when the budget is spent.
    ///
    /// The read and the increment share one immediate transaction so that two
    /// concurrent requests cannot both observe the last free slot and both
    /// spend it. `limit` of `0` means the pipeline opted out of the cap.
    pub fn try_claim_agent_revision_round(
        &self,
        id: &str,
        limit: i64,
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let rounds = db.task_revision_rounds(id)?;
            if limit > 0 && rounds >= limit {
                return Ok(None);
            }
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET revision_rounds = revision_rounds + 1, updated_at = datetime('now')
                 WHERE id = ?",
                [id],
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(Some(rounds + 1))
        })
    }

    /// Hand a claimed round back: preparation failed, so no agent ever ran and
    /// the round must not be charged to the task. Floors at zero.
    pub fn release_agent_revision_round(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET revision_rounds = MAX(revision_rounds - 1, 0), updated_at = datetime('now')
             WHERE id = ?",
            [id],
        )?;
        Ok(())
    }

    /// Hand the round budget back: a human asked for this revision, so the
    /// agents get a fresh set of autonomous rounds to satisfy it.
    pub fn reset_task_revision_rounds(&self, id: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET revision_rounds = 0, updated_at = datetime('now')
             WHERE id = ?",
            [id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn mark_pipeline_item_read_if_unchanged(
        &self,
        id: &str,
        expected_activity_revision: Option<i64>,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET activity = 'idle', activity_changed_at = datetime('now'),
                 activity_revision = activity_revision + 1,
                 updated_at = datetime('now')
             WHERE id = ? AND activity = 'unread' AND closed_at IS NULL
               AND (? IS NULL OR activity_revision = ?)",
            (id, expected_activity_revision, expected_activity_revision),
        )?;
        Ok(rows_affected > 0)
    }

    pub fn update_pipeline_item_base_ref_and_activity(
        &self,
        id: &str,
        base_ref: Option<&str>,
        activity: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET base_ref = ?,
                 activity_revision = activity_revision + CASE WHEN activity != ? THEN 1 ELSE 0 END,
                 activity = ?, activity_changed_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ? AND closed_at IS NULL",
            (base_ref, activity, activity, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn close_pipeline_item(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let Some(pipeline_item_id) = db.resolve_pipeline_item_id(id)? else {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            };
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET closed_at = datetime('now'),
                     updated_at = datetime('now')
                 WHERE id = ?",
                [&pipeline_item_id],
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            db.cancel_running_stage_runs(&pipeline_item_id)?;
            db.release_task_ports(&pipeline_item_id)?;
            db.append_task_event(
                &pipeline_item_id,
                TaskEventKind::TaskClosed,
                json!({ "stage": db.pipeline_item_stage(&pipeline_item_id)? }),
            )?;
            Ok(())
        })
    }

    pub fn reopen_pipeline_item(&self, id: &str) -> Result<(), ReopenPipelineItemError> {
        let Some(pipeline_item_id) = self.resolve_pipeline_item_id(id)? else {
            return Err(ReopenPipelineItemError::Database(
                rusqlite::Error::QueryReturnedNoRows,
            ));
        };
        let rows_affected = match self.conn.execute(
            "UPDATE pipeline_item
             SET teardown_started_at = NULL,
                 closed_at = NULL,
                 updated_at = datetime('now')
             WHERE id = ?",
            [&pipeline_item_id],
        ) {
            Ok(rows_affected) => rows_affected,
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                return Err(ReopenPipelineItemError::OwnershipConflict);
            }
            Err(error) => return Err(ReopenPipelineItemError::Database(error)),
        };
        if rows_affected == 0 {
            return Err(ReopenPipelineItemError::Database(
                rusqlite::Error::QueryReturnedNoRows,
            ));
        }
        Ok(())
    }

    pub fn update_pipeline_item_display_name(
        &self,
        id: &str,
        display_name: Option<&str>,
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

    /// Replace the task's current pipeline and pinned definition atomically
    /// with the event that announces the change. The creation-time
    /// `initial_pipeline` is deliberately untouched so re-pipelining does not
    /// alter the repo's sticky new-task default.
    pub fn update_pipeline_item_pipeline(
        &self,
        id: &str,
        expected_stage: &str,
        pipeline: &str,
        pipeline_def: &str,
        revision_rounds: i64,
        revision_limit: i64,
    ) -> Result<bool, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let current = db
                .conn
                .query_row(
                    "SELECT pipeline, pipeline_def, stage
                     FROM pipeline_item
                     WHERE id = ? AND closed_at IS NULL",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            if current.2.as_deref() != Some(expected_stage) {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "task stage changed while setting workflow: expected {expected_stage}, found {}",
                    current.2.as_deref().unwrap_or("<none>")
                )));
            }
            if current.0.as_deref() == Some(pipeline)
                && current.1.as_deref() == Some(pipeline_def)
            {
                return Ok(false);
            }

            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET pipeline = ?, pipeline_def = ?, updated_at = datetime('now')
                 WHERE id = ? AND closed_at IS NULL AND stage = ?",
                (pipeline, pipeline_def, id, expected_stage),
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            db.append_task_event(
                id,
                TaskEventKind::WorkflowChanged,
                json!({
                    "fromWorkflow": current.0.clone(),
                    "toWorkflow": pipeline,
                    "fromPipeline": current.0,
                    "toPipeline": pipeline,
                    "stage": expected_stage,
                    "revisionRounds": revision_rounds,
                    "revisionLimit": revision_limit,
                }),
            )?;
            Ok(true)
        })
    }

    pub fn update_pipeline_item_stage(&self, id: &str, stage: &str) -> Result<(), rusqlite::Error> {
        let from_stage = self.pipeline_item_stage(id)?;
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (stage, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        self.append_stage_changed_event(id, from_stage.as_deref(), stage, None)
    }

    /// One `stage.changed` event per real transition. A rewrite to the stage a
    /// task is already on (a repair path, a replayed request) is not a
    /// transition and must not wake every watcher.
    fn append_stage_changed_event(
        &self,
        id: &str,
        from_stage: Option<&str>,
        to_stage: &str,
        branch: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        if from_stage == Some(to_stage) {
            return Ok(());
        }
        self.append_task_event(
            id,
            TaskEventKind::StageChanged,
            json!({
                "fromStage": from_stage,
                "toStage": to_stage,
                "branch": branch,
            }),
        )
    }

    /// Record the task's pull request once an agent reports it (the pr
    /// stage's verdict carries the URL). Best-effort denormalization: the
    /// authoritative record is the stage run result.
    pub fn update_pipeline_item_pr(
        &self,
        id: &str,
        pr_number: Option<i64>,
        pr_url: &str,
    ) -> Result<(), rusqlite::Error> {
        let previous_pr_url: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT pr_url FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET pr_number = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (pr_number, pr_url, id),
        )?;
        // Re-reporting the same PR URL (a rerun of the pr stage, a replayed
        // verdict) is not a new pull request.
        if rows_affected > 0 && previous_pr_url.flatten().as_deref() != Some(pr_url) {
            self.append_task_event(
                id,
                TaskEventKind::PrCreated,
                json!({ "prNumber": pr_number, "prUrl": pr_url }),
            )?;
        }
        Ok(())
    }

    /// Keep the task's current agent-CLI session id (the desktop's session
    /// recovery resume handle) in step with server-side spawns: set it when a
    /// spawn assigns or resumes a provider session, clear it when the new
    /// session has none — a stale id would resume the wrong conversation.
    /// The provider session a task would resume. `PipelineItem` does not carry
    /// it (only the snapshot projection does), and the transfer engine needs it
    /// to decide what session state a push must ship.
    pub fn task_agent_session_id(
        &self,
        pipeline_item_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT agent_session_id FROM pipeline_item WHERE id = ?",
                [pipeline_item_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    pub fn update_pipeline_item_agent_session_id(
        &self,
        id: &str,
        agent_session_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (agent_session_id, id),
        )?;
        Ok(())
    }

    pub fn update_pipeline_item_agent_binding(
        &self,
        id: &str,
        agent_provider: &str,
        agent_type: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET agent_provider = ?, agent_type = ?, updated_at = datetime('now')
             WHERE id = ? AND closed_at IS NULL",
            (agent_provider, agent_type, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn list_closed_task_identities(
        &self,
    ) -> Result<Vec<super::ClosedTaskIdentity>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id
             FROM pipeline_item
             WHERE closed_at IS NOT NULL
             ORDER BY closed_at DESC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(super::ClosedTaskIdentity {
                id: row.get(0)?,
                repo_id: row.get(1)?,
            })
        })?;
        rows.collect()
    }

    /// Stage transition into a freshly forked workspace: the task's current
    /// branch moves with the stage.
    pub fn update_pipeline_item_stage_and_branch(
        &self,
        id: &str,
        stage: &str,
        branch: &str,
    ) -> Result<(), rusqlite::Error> {
        let from_stage = self.pipeline_item_stage(id)?;
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET stage = ?, branch = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (stage, branch, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        self.append_stage_changed_event(id, from_stage.as_deref(), stage, Some(branch))
    }

    pub fn get_pipeline_item_pr_branch(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT pr_branch FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// Persist the live PR branch without changing the workspace identity.
    pub fn update_pipeline_item_pr_branch(
        &self,
        id: &str,
        branch: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET pr_branch = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (branch, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// When this task's merge request reached the repo's merge agent, or
    /// `None` while it still owes one. Closing a task whose final stage
    /// promised the handoff reads this to tell a delivered handoff from a
    /// skipped one.
    pub fn task_merge_signaled_at(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT merge_signaled_at FROM pipeline_item WHERE id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// Record a delivered merge handoff. The first delivery wins: a task owes
    /// the merge agent one request, so a later duplicate keeps the original
    /// timestamp and logs no second event. Returns whether this call was the
    /// one that recorded it.
    pub fn record_task_merge_signal(
        &self,
        id: &str,
        source: MergeSignalSource,
        branch: &str,
        target: &str,
        pr_url: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET merge_signaled_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ? AND merge_signaled_at IS NULL",
                [id],
            )?;
            if rows_affected == 0 {
                return Ok(false);
            }
            db.append_task_event(
                id,
                TaskEventKind::MergeSignaled,
                json!({
                    "source": source.as_str(),
                    "branch": branch,
                    "target": target,
                    "prUrl": pr_url,
                }),
            )?;
            Ok(true)
        })
    }

    /// Record that a task reached the end of a pipeline whose final stage
    /// declares the merge-signaling `approve` post without any PR to hand
    /// off. The engine refuses to close such a task; this is what a watcher
    /// (and the operator) sees instead of a silent completion.
    pub fn record_task_merge_handoff_missing(
        &self,
        id: &str,
        reason: &str,
    ) -> Result<(), rusqlite::Error> {
        self.append_task_event(
            id,
            TaskEventKind::MergeHandoffMissing,
            json!({ "reason": reason }),
        )
    }
}

/// Who delivered a task's merge request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeSignalSource {
    /// The approve post called `kanna_signal_merge_handoff` itself.
    Agent,
    /// Kanna delivered it while closing the task, because the approve post
    /// finished without one.
    Engine,
}

impl MergeSignalSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Engine => "engine",
        }
    }
}
