use super::{
    CloudTaskIdentityWrite, Db, NewPipelineItem, OpenAgentTask, PipelineItem, PipelineItemChild,
    ReopenPipelineItemError, TaskEventKind, TaskStageSource, TaskStateSummary,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

const MANAGER_ACTIVITY_DEBOUNCE_SECONDS: u64 = 10;

/// Change an open task's activity and arm the settled-transition debounce in
/// the same transaction. `None` means there is no open task; `Some(false)` is
/// an unchanged value or a failed optimistic precondition.
pub(super) fn update_open_pipeline_item_activity(
    conn: &Connection,
    id: &str,
    activity: &str,
    expected_activity: Option<&str>,
    expected_activity_revision: Option<i64>,
) -> Result<Option<bool>, rusqlite::Error> {
    let current = conn
        .query_row(
            "SELECT activity, activity_revision
             FROM pipeline_item
             WHERE id = ? AND closed_at IS NULL",
            [id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((previous_activity, activity_revision)) = current else {
        return Ok(None);
    };
    if expected_activity.is_some_and(|expected| previous_activity.as_deref() != Some(expected))
        || expected_activity_revision.is_some_and(|expected| activity_revision != expected)
        || previous_activity.as_deref() == Some(activity)
    {
        return Ok(Some(false));
    }

    conn.execute(
        "UPDATE pipeline_item
         SET activity_event_baseline = COALESCE(activity_event_baseline, activity),
             activity_event_pending_at = datetime('now'),
             activity = ?, activity_changed_at = datetime('now'),
             activity_revision = activity_revision + 1,
             unread_at = CASE WHEN ? = 'unread' THEN datetime('now') ELSE unread_at END,
             updated_at = datetime('now')
         WHERE id = ? AND closed_at IS NULL",
        (activity, activity, id),
    )?;
    Ok(Some(true))
}

impl Db {
    pub fn get_task_state_summary(
        &self,
        id: &str,
    ) -> Result<Option<TaskStateSummary>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, activity, activity_revision, activity_changed_at,
                        unread_at, runtime_status, last_output_preview
                   FROM pipeline_item
                  WHERE id = ? AND closed_at IS NULL",
                [id],
                |row| {
                    Ok(TaskStateSummary {
                        task_id: row.get(0)?,
                        activity: row.get(1)?,
                        activity_revision: row.get(2)?,
                        activity_changed_at: row.get(3)?,
                        unread_at: row.get(4)?,
                        runtime_state: row.get(5)?,
                        last_output_preview: row.get(6)?,
                    })
                },
            )
            .optional()
    }

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

    /// Workflow names most recently chosen by operator-initiated task creates
    /// in a repo, newest first and deduplicated. The `initial_pipeline` column
    /// (legacy name for the task's creation-time workflow) is intentionally
    /// immutable: changing an existing task's current workflow must not rewrite
    /// the sticky choice used for the next new task.
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
    /// dispatched is not a workflow the operator picked, and letting those rows
    /// win would hijack the default after every dispatched review.
    ///
    /// Ordered by `rowid`, i.e. insertion order. `created_at` is second
    /// resolution text, so tasks created within the same second tie under it.
    pub fn recent_repo_workflows(
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

    #[cfg(test)]
    pub fn list_recent_pipeline_items(&self) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        self.list_recent_pipeline_items_including_closed(false, None, 50)
    }

    pub fn list_recent_pipeline_items_including_closed(
        &self,
        include_closed: bool,
        repo_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds, runtime_status, input_blocked, composer_text, composer_attestation
             FROM pipeline_item
             WHERE (?1 OR closed_at IS NULL)
               AND (?2 IS NULL OR repo_id = ?2)
             ORDER BY updated_at DESC, created_at DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(rusqlite::params![include_closed, repo_id, limit], |row| {
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
                runtime_status: row.get(29)?,
                input_blocked: row.get(30)?,
                composer_text: row.get(31)?,
                composer_attestation: row.get(32)?,
            })
        })?;
        rows.collect()
    }

    #[cfg(test)]
    pub fn search_pipeline_items(&self, query: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        self.search_pipeline_items_including_closed(query, false, None)
    }

    pub fn search_pipeline_items_including_closed(
        &self,
        query: &str,
        include_closed: bool,
        repo_id: Option<&str>,
    ) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let like_query = format!("%{}%", query.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage,
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at,
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds, runtime_status, input_blocked, composer_text, composer_attestation
             FROM pipeline_item
             WHERE (?1 OR closed_at IS NULL)
               AND (?2 IS NULL OR repo_id = ?2)
               AND (
                 lower(id) LIKE ?3
                 OR lower(coalesce(branch, '')) LIKE ?3
                 OR lower(coalesce(display_name, '')) LIKE ?3
                 OR lower(coalesce(prompt, '')) LIKE ?3
               )
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![include_closed, repo_id, like_query],
            |row| {
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
                    runtime_status: row.get(29)?,
                    input_blocked: row.get(30)?,
                    composer_text: row.get(31)?,
                    composer_attestation: row.get(32)?,
                })
            },
        )?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, pipeline, stage, \
             pr_number, pr_url, branch, agent_type, agent_provider, activity, activity_changed_at, \
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds, runtime_status, input_blocked, composer_text, composer_attestation \
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
                runtime_status: row.get(29)?,
                input_blocked: row.get(30)?,
                composer_text: row.get(31)?,
                composer_attestation: row.get(32)?,
            })
        })?;
        rows.collect()
    }

    /// Direct children of `parent_id`, oldest first, with the lifecycle and
    /// workflow identity a fan-out owner joins its children by. This is the
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
             closed_at, pinned, pin_order, display_name, last_output_preview, created_at, updated_at, base_ref, notify_task_id, notified_at, parent_task_id, pipeline_def, activity_revision, cloud_task_id, revision_rounds, runtime_status, input_blocked, composer_text, composer_attestation \
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
                runtime_status: row.get(29)?,
                input_blocked: row.get(30)?,
                composer_text: row.get(31)?,
                composer_attestation: row.get(32)?,
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

    /// Record what the task's agent session renders on its composer line, and
    /// what the daemon can prove about it.
    ///
    /// Deliberately not folded into `update_pipeline_item_waiting_prompt`:
    /// that writes `last_output_preview`, which every consumer reads as
    /// something the session said. The composer is the opposite — it is what
    /// has not been said yet, and on a Claude session it is frequently the
    /// CLI's own suggestion. Keeping the two columns apart is the whole point.
    pub fn update_pipeline_item_composer(
        &self,
        id: &str,
        composer_text: Option<&str>,
        composer_attestation: &str,
    ) -> Result<bool, rusqlite::Error> {
        let Some(task_id) = self.resolve_pipeline_item_id(id)? else {
            return Ok(false);
        };
        let changed = self.conn.execute(
            "UPDATE pipeline_item
             SET composer_text = ?, composer_attestation = ?, updated_at = datetime('now')
             WHERE id = ?
               AND closed_at IS NULL
               AND (COALESCE(composer_text, '') != COALESCE(?, '')
                    OR COALESCE(composer_attestation, '') != ?)",
            (
                composer_text,
                composer_attestation,
                &task_id,
                composer_text,
                composer_attestation,
            ),
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
                "SELECT p.id, COALESCE(NULLIF(sr.session_id, ''), p.id), p.repo_id
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
                        repo_id: row.get(2)?,
                    })
                },
            )
            .optional()
    }

    /// Every open singleton candidate for one machine-independent repository.
    ///
    /// Repository ids are installation-local, so cross-desktop singleton
    /// discovery must enter through the canonical remote URL hash. Returning
    /// all matches is intentional: older builds could create one singleton per
    /// local registration, and resolution must report that corruption instead
    /// of silently selecting the newest row.
    pub fn find_open_agent_tasks_by_remote_url_hash(
        &self,
        remote_url_hash: &str,
        agent: &str,
    ) -> Result<Vec<OpenAgentTask>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT p.id, COALESCE(NULLIF(latest.session_id, ''), p.id), p.repo_id
             FROM pipeline_item p
             JOIN repo r ON r.id = p.repo_id
             JOIN stage_run matching ON matching.task_id = p.id AND matching.agent = ?
             LEFT JOIN stage_run latest ON latest.rowid = (
                 SELECT candidate.rowid
                 FROM stage_run candidate
                 WHERE candidate.task_id = p.id
                   AND candidate.agent = ?
                 ORDER BY candidate.rowid DESC
                 LIMIT 1
             )
             WHERE r.remote_url_hash = ?
               AND p.closed_at IS NULL
             ORDER BY p.rowid DESC",
        )?;
        let tasks = statement
            .query_map((agent, agent, remote_url_hash), |row| {
                Ok(OpenAgentTask {
                    task_id: row.get(0)?,
                    session_id: row.get(1)?,
                    repo_id: row.get(2)?,
                })
            })?
            .collect();
        tasks
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
        self.in_immediate_transaction_if_needed(|db| {
            db.update_pipeline_item_activity_in_transaction(id, activity)
        })
    }

    fn update_pipeline_item_activity_in_transaction(
        &self,
        id: &str,
        activity: &str,
    ) -> Result<(), rusqlite::Error> {
        update_open_pipeline_item_activity(&self.conn, id, activity, None, None)?;
        Ok(())
    }

    /// Publish every activity value that remains stable for the configured
    /// debounce. The baseline is the last value managers were told about, so
    /// a short A→B→A flicker clears itself without producing either edge.
    pub fn flush_debounced_activity_events(
        &self,
        debounce_seconds: u64,
    ) -> Result<usize, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let modifier = format!("-{debounce_seconds} seconds");
            let mut stmt = db.conn.prepare(
                "SELECT pi.id, pi.activity_event_baseline, pi.activity, pi.runtime_status,
                        (SELECT sr.status FROM stage_run sr WHERE sr.task_id = pi.id
                         ORDER BY sr.rowid DESC LIMIT 1)
                 FROM pipeline_item pi
                 WHERE pi.closed_at IS NULL
                   AND pi.activity_event_pending_at IS NOT NULL
                   AND pi.activity_event_pending_at <= datetime('now', ?)",
            )?;
            let rows = stmt
                .query_map([modifier], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut appended = 0;
            for (id, baseline, activity, runtime_state, latest_run_status) in rows {
                db.conn.execute(
                    "UPDATE pipeline_item SET activity_event_pending_at = NULL WHERE id = ?",
                    [&id],
                )?;
                if baseline == activity {
                    continue;
                }
                let latest_run_finished_without_completion = matches!(
                    (activity.as_deref(), runtime_state.as_deref(), latest_run_status.as_deref()),
                    (Some("idle" | "unread"), Some("idle"), Some("running"))
                );
                db.conn.execute(
                    "UPDATE pipeline_item SET activity_event_baseline = ? WHERE id = ?",
                    (&activity, &id),
                )?;
                db.append_task_event(
                    &id,
                    TaskEventKind::ActivityChanged,
                    json!({
                        "previousActivity": baseline,
                        "activity": activity,
                        "runtimeState": runtime_state,
                        "latestRunFinishedWithoutCompletion": latest_run_finished_without_completion,
                    }),
                )?;
                appended += 1;
            }
            // Extend the same authoritative debounce flush with the manager's
            // runtime dimension. This deliberately shares the server loop and
            // transaction with ActivityChanged, while retaining a fixed
            // 10-second window independent of the legacy display-event knob.
            //
            // Only the non-busy side arrives here: entering `busy` is
            // published the moment the daemon says so, by
            // `update_pipeline_item_runtime_status`. A row whose held value
            // equals the published baseline is a flicker that cleared itself
            // and emits nothing.
            let runtime_modifier = format!("-{MANAGER_ACTIVITY_DEBOUNCE_SECONDS} seconds");
            let mut runtime_stmt = db.conn.prepare(
                "SELECT pi.id, pi.runtime_event_baseline, pi.runtime_status,
                        (SELECT sr.status FROM stage_run sr WHERE sr.task_id = pi.id
                         ORDER BY sr.rowid DESC LIMIT 1)
                 FROM pipeline_item pi
                 WHERE pi.closed_at IS NULL
                   AND pi.runtime_status IS NOT NULL
                   AND pi.runtime_event_pending_at IS NOT NULL
                   AND pi.runtime_event_pending_at <= datetime('now', ?)",
            )?;
            let runtime_rows = runtime_stmt
                .query_map([runtime_modifier], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(runtime_stmt);
            for (id, baseline, runtime_state, latest_run_status) in runtime_rows {
                db.conn.execute(
                    "UPDATE pipeline_item
                     SET runtime_event_baseline = ?, runtime_event_pending_at = NULL
                     WHERE id = ?",
                    (&runtime_state, &id),
                )?;
                if baseline == runtime_state {
                    continue;
                }
                // The runtime-dimension reading of the same fact
                // `ActivityChanged` reports: the session stopped or parked
                // while its latest run never recorded a stage verdict, so a
                // manager can advance it without inventing a polling loop.
                let latest_run_finished_without_completion = matches!(
                    (runtime_state.as_deref(), latest_run_status.as_deref()),
                    (Some("idle" | "exited"), Some("running"))
                );
                db.append_task_event(
                    &id,
                    TaskEventKind::RuntimeChanged,
                    json!({
                        "previousRuntimeState": baseline,
                        "runtimeState": runtime_state,
                        "latestRunFinishedWithoutCompletion":
                            latest_run_finished_without_completion,
                    }),
                )?;
                // Deprecated alias for deployed watchers keyed on the
                // busy-to-non-busy subset. Appended in the same transaction as
                // the event that supersedes it, so the two can never disagree.
                if baseline.as_deref() == Some("busy")
                    && matches!(runtime_state.as_deref(), Some("idle" | "waiting" | "exited"))
                {
                    db.append_task_event(
                        &id,
                        TaskEventKind::RuntimeSettled,
                        json!({
                            "previousRuntimeState": baseline,
                            "runtimeState": runtime_state,
                        }),
                    )?;
                }
            }
            // Preserve the established return contract: callers and tests use
            // this count for ActivityChanged rows, not all kinds sharing the
            // flush transaction.
            Ok(appended)
        })
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
    /// spend it. `limit` of `0` means the workflow opted out of the cap.
    #[cfg(test)]
    pub fn try_claim_agent_revision_round(
        &self,
        id: &str,
        limit: i64,
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            db.claim_agent_revision_round_in_transaction(id, limit)
        })
    }

    pub(crate) fn claim_agent_revision_round_in_transaction(
        &self,
        id: &str,
        limit: i64,
    ) -> Result<Option<i64>, rusqlite::Error> {
        let rounds = self.task_revision_rounds(id)?;
        if limit > 0 && rounds >= limit {
            return Ok(None);
        }
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET revision_rounds = revision_rounds + 1, updated_at = datetime('now')
             WHERE id = ?",
            [id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(Some(rounds + 1))
    }

    /// Hand a claimed round back: preparation failed, so no agent ever ran and
    /// the round must not be charged to the task. Floors at zero.
    #[cfg(test)]
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
        self.with_immediate_transaction(|db| {
            Ok(update_open_pipeline_item_activity(
                &db.conn,
                id,
                "idle",
                Some("unread"),
                expected_activity_revision,
            )?
            .unwrap_or(false))
        })
    }

    pub fn update_pipeline_item_base_ref_and_activity(
        &self,
        id: &str,
        base_ref: Option<&str>,
        activity: &str,
    ) -> Result<(), rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET base_ref = ?, updated_at = datetime('now')
                 WHERE id = ? AND closed_at IS NULL",
                (base_ref, id),
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            update_open_pipeline_item_activity(&db.conn, id, activity, None, None)?;
            Ok(())
        })
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
            // Closing resolves this task as a blocker, which is how most
            // dependents become unblocked.
            db.sync_blocked_events_for_dependents(&pipeline_item_id)?;
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
        // Reopening un-resolves this task as a blocker; dependents that were
        // released by the close go back to blocked.
        self.sync_blocked_events_for_dependents(&pipeline_item_id)?;
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

    /// Replace the task's current workflow and pinned definition atomically
    /// with the event that announces the change. The creation-time
    /// `initial_pipeline` column is deliberately untouched so re-pointing a
    /// task at another workflow does not alter the repo's sticky new-task
    /// default. (`pipeline`, `pipeline_def`, and `initial_pipeline` are the
    /// legacy storage column names for the task's workflow.)
    pub fn update_pipeline_item_pipeline(
        &self,
        id: &str,
        expected_stage: &str,
        workflow_name: &str,
        workflow_def: &str,
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
            if current.0.as_deref() == Some(workflow_name)
                && current.1.as_deref() == Some(workflow_def)
            {
                return Ok(false);
            }

            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item
                 SET pipeline = ?, pipeline_def = ?, updated_at = datetime('now')
                 WHERE id = ? AND closed_at IS NULL AND stage = ?",
                (workflow_name, workflow_def, id, expected_stage),
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            db.append_task_event(
                id,
                TaskEventKind::WorkflowChanged,
                json!({
                    "fromWorkflow": current.0.clone(),
                    "toWorkflow": workflow_name,
                    "fromPipeline": current.0,
                    "toPipeline": workflow_name,
                    "stage": expected_stage,
                    "revisionRounds": revision_rounds,
                    "revisionLimit": revision_limit,
                }),
            )?;
            Ok(true)
        })
    }

    #[cfg(test)]
    pub fn update_pipeline_item_stage(&self, id: &str, stage: &str) -> Result<(), rusqlite::Error> {
        self.update_pipeline_item_stage_with_trigger(id, stage, super::StageTrigger::Unspecified)
    }

    pub fn update_pipeline_item_stage_with_trigger(
        &self,
        id: &str,
        stage: &str,
        trigger: super::StageTrigger,
    ) -> Result<(), rusqlite::Error> {
        self.in_immediate_transaction_if_needed(|db| {
            let from_stage = db.pipeline_item_stage(id)?;
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item SET stage = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
                (stage, id),
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            db.append_stage_changed_event(id, from_stage.as_deref(), stage, None, trigger)?;
            // Reaching (or leaving) `pr` with a PR recorded flips whether this
            // task still blocks its dependents.
            db.sync_blocked_events_for_dependents(id)
        })
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
        trigger: super::StageTrigger,
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
                "trigger": trigger.as_str(),
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
        self.in_immediate_transaction_if_needed(|db| {
            let previous_pr_url: Option<Option<String>> = db
                .conn
                .query_row(
                    "SELECT pr_url FROM pipeline_item WHERE id = ?",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item SET pr_number = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
                (pr_number, pr_url, id),
            )?;
            // Re-reporting the same PR URL (a rerun of the pr stage, a replayed
            // verdict) is not a new pull request.
            if rows_affected > 0 && previous_pr_url.flatten().as_deref() != Some(pr_url) {
                db.append_task_event(
                    id,
                    TaskEventKind::PrCreated,
                    json!({ "prNumber": pr_number, "prUrl": pr_url }),
                )?;
            }
            // A task parked at `pr` with a PR recorded counts as resolved, so
            // this write can release its dependents.
            db.sync_blocked_events_for_dependents(id)
        })
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

    /// Record what a task actually bound to once its workspace is prepared and
    /// provider availability has been probed.
    ///
    /// `agent_spawn_options_json` travels in the same statement as the
    /// provider deliberately: the column holds that provider's model and
    /// effort, and the desktop's recover-session action reads the two together
    /// (`apps/desktop/src/stores/sessions.ts`) to rebuild the invocation. The
    /// row is first written with the *leading* candidate's options, so a task
    /// that falls through to a later candidate has to restamp them here or the
    /// stored pair is one a CLI would reject (`codex -m opus`). `None` leaves
    /// the column as it is, for callers that only rebind the provider.
    pub fn update_pipeline_item_agent_binding(
        &self,
        id: &str,
        agent_provider: &str,
        agent_type: &str,
        agent_spawn_options_json: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item
             SET agent_provider = ?, agent_type = ?,
                 agent_spawn_options = COALESCE(?, agent_spawn_options),
                 updated_at = datetime('now')
             WHERE id = ? AND closed_at IS NULL",
            (agent_provider, agent_type, agent_spawn_options_json, id),
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
    pub fn update_pipeline_item_stage_and_branch_with_trigger(
        &self,
        id: &str,
        stage: &str,
        branch: &str,
        trigger: super::StageTrigger,
    ) -> Result<(), rusqlite::Error> {
        self.in_immediate_transaction_if_needed(|db| {
            let from_stage = db.pipeline_item_stage(id)?;
            let rows_affected = db.conn.execute(
                "UPDATE pipeline_item SET stage = ?, branch = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
                (stage, branch, id),
            )?;
            if rows_affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            db.append_stage_changed_event(id, from_stage.as_deref(), stage, Some(branch), trigger)?;
            db.sync_blocked_events_for_dependents(id)
        })
    }

    /// Point the task's workspace identity at the branch that actually holds
    /// its committed work, without moving its stage. Used to reconcile
    /// `pipeline_item.branch` after a round's commit landed on a workspace the
    /// field no longer named — see `task_creator::work_tip`. A closed task is
    /// left alone: reconciliation is preparation for more work, and there is
    /// none.
    pub fn update_pipeline_item_branch(
        &self,
        id: &str,
        branch: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET branch = ?, updated_at = datetime('now') WHERE id = ? AND closed_at IS NULL",
            (branch, id),
        )?;
        Ok(rows_affected > 0)
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

    /// Record that a task reached the end of a workflow whose final stage
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
