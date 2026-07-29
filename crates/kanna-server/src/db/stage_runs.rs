use super::{Db, NewStageRun, StageRun};
use rusqlite::{params, OptionalExtension};

pub(super) const CURRENT_RUN_OWNERSHIP_VERSION: i64 = 1;

/// Identity of a run closed by `finish_latest_running_stage_run`.
pub struct FinishedStageRun {
    pub kind: String,
    pub completion_transition: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskActionState {
    pub stage: String,
    pub branch: String,
    /// Latest database action row used for compare-and-swap and landing.
    pub active_run_id: Option<String>,
    /// Main run that owns the live daemon process. Injected posts are action
    /// rows, but they cannot replace the process's immutable spawn owner.
    pub process_run_id: Option<String>,
}

/// Result of attaching a provider-native handle to its immutable owning run.
pub struct ProviderSessionUpdate {
    pub changed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplacedStageRunSource {
    pub run_id: String,
    pub status: String,
    pub result: Option<String>,
    pub feedback: Option<String>,
    pub finished_at: Option<String>,
}

pub struct PendingStageActionTarget<'a> {
    pub session_id: &'a str,
    pub stage: &'a str,
    pub branch: Option<&'a str>,
    pub worktree: Option<(&'a str, &'a str, &'a str)>,
    pub remove_worktree_on_rollback: bool,
    pub action_request: Option<PendingTaskActionRequest<'a>>,
}

pub struct PendingTaskActionRequest<'a> {
    pub idempotency_key: &'a str,
    pub success_status: u16,
    pub success_response_body: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingStageAction {
    pub successor_run_id: String,
    pub task_id: String,
    pub session_id: String,
    pub target_stage: String,
    pub target_branch: Option<String>,
    pub target_worktree_id: Option<String>,
    pub target_worktree_path: Option<String>,
    pub target_worktree_branch: Option<String>,
    pub remove_worktree_on_rollback: bool,
    pub source: TaskActionState,
    pub replaced_source: Option<ReplacedStageRunSource>,
}

impl Db {
    pub fn has_durable_running_task_session(&self, task_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM stage_run sr
                JOIN terminal_session ts
                  ON ts.pipeline_item_id = sr.task_id
                 AND ts.daemon_session_id = sr.session_id
                WHERE sr.task_id = ?
                  AND sr.status = 'running'
                  AND sr.session_id IS NOT NULL
                  AND sr.session_id != ''
            )",
            [task_id],
            |row| row.get(0),
        )
    }

    /// Snapshot the ownership tuple every mutating task action must compare
    /// before inserting or landing a replacement run.
    pub fn task_action_state(&self, task_id: &str) -> Result<TaskActionState, rusqlite::Error> {
        self.conn.query_row(
            "SELECT p.stage, p.branch,
                    (
                      SELECT id
                      FROM stage_run
                      WHERE task_id = p.id
                      ORDER BY datetime(started_at) DESC, rowid DESC
                      LIMIT 1
                    ),
                    (
                      SELECT CASE
                               WHEN kind = 'post'
                                 THEN COALESCE(resumed_from_run_id, id)
                               ELSE id
                             END
                      FROM stage_run
                      WHERE task_id = p.id
                      ORDER BY datetime(started_at) DESC, rowid DESC
                      LIMIT 1
                    )
             FROM pipeline_item p
             WHERE p.id = ?1 AND p.closed_at IS NULL",
            [task_id],
            |row| {
                Ok(TaskActionState {
                    stage: row.get(0)?,
                    branch: row.get(1)?,
                    active_run_id: row.get(2)?,
                    process_run_id: row.get(3)?,
                })
            },
        )
    }

    /// Apply a completion verdict only to the latest run, optionally
    /// requiring the immutable run id supplied by the agent process.
    #[cfg(test)]
    pub fn finish_active_stage_run(
        &self,
        task_id: &str,
        expected_run_id: Option<&str>,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<Option<FinishedStageRun>, rusqlite::Error> {
        self.finish_active_stage_run_with_completion_attempt(
            task_id,
            expected_run_id,
            None,
            status,
            result,
            feedback,
        )
    }

    pub fn finish_active_stage_run_with_completion_attempt(
        &self,
        task_id: &str,
        expected_run_id: Option<&str>,
        completion_attempt: Option<&str>,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<Option<FinishedStageRun>, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let run = transaction
            .query_row(
                "SELECT sr.id, sr.kind, sr.completion_transition, sr.status,
                        sr.resumed_from_run_id, sr.run_ownership_version,
                        sr.completion_attempt
                 FROM stage_run sr
                 WHERE sr.task_id = ?1
                 ORDER BY datetime(sr.started_at) DESC, sr.rowid DESC
                 LIMIT 1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            run_id,
            kind,
            completion_transition,
            current_status,
            completion_owner_run_id,
            run_ownership_version,
            required_completion_attempt,
        )) = run
        else {
            return Ok(None);
        };
        let ownership_matches = expected_run_id.is_some_and(|expected| {
            if expected == run_id {
                return true;
            }
            if kind != "post" || completion_owner_run_id.as_deref() != Some(expected) {
                return false;
            }
            let scoped_attempt_matches =
                required_completion_attempt
                    .as_deref()
                    .is_some_and(|required| {
                        completion_attempt.is_some_and(|provided| provided == required)
                    });
            scoped_attempt_matches
        });
        if run_ownership_version >= CURRENT_RUN_OWNERSHIP_VERSION && !ownership_matches {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if run_ownership_version < CURRENT_RUN_OWNERSHIP_VERSION
            && expected_run_id.is_some()
            && !ownership_matches
        {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let completing_delivered_reservation = if current_status == "pending" && kind == "post" {
            transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1
                   FROM task_action_request
                   WHERE successor_run_id = ?1
                     AND state = 'pending'
                     AND phase = 'post_reserved'
                     AND post_delivery_started_at IS NOT NULL
                 )",
                [&run_id],
                |row| row.get::<_, bool>(0),
            )?
        } else {
            false
        };
        if !matches!(current_status.as_str(), "running" | "succeeded" | "failed")
            && !completing_delivered_reservation
        {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let changed = transaction.execute(
            "UPDATE stage_run
             SET status = ?2, result = ?3, feedback = ?4,
                 finished_at = datetime('now')
             WHERE id = ?1 AND task_id = ?5",
            (&run_id, status, result, feedback, task_id),
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if completing_delivered_reservation {
            let action_changed = transaction.execute(
                "UPDATE task_action_request
                 SET state = 'succeeded', updated_at = datetime('now')
                 WHERE successor_run_id = ?1
                   AND state = 'pending'
                   AND phase = 'post_reserved'
                   AND post_delivery_started_at IS NOT NULL",
                [&run_id],
            )?;
            if action_changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.commit()?;
        Ok(Some(FinishedStageRun {
            kind,
            completion_transition,
        }))
    }

    pub fn insert_stage_run(&self, run: NewStageRun<'_>) -> Result<(), rusqlite::Error> {
        self.insert_stage_run_with_completion_transition(run, None)
    }

    pub fn insert_stage_run_with_completion_transition(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.insert_stage_run_with_completion_attempt(run, completion_transition, None)
    }

    pub fn insert_stage_run_with_completion_attempt(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        completion_attempt: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let run_ownership_version =
            if let ("post", Some(owner_run_id)) = (run.kind, run.resumed_from_run_id) {
                self.conn.query_row(
                    "SELECT run_ownership_version FROM stage_run WHERE id = ?1",
                    [owner_run_id],
                    |row| row.get::<_, i64>(0),
                )?
            } else {
                CURRENT_RUN_OWNERSHIP_VERSION
            };
        self.conn.execute(
            "INSERT INTO stage_run
             (id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
              session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition,
              completion_attempt, run_ownership_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                run.id,
                run.task_id,
                run.stage,
                run.kind,
                run.agent,
                run.agent_provider,
                run.model,
                run.status,
                run.result,
                run.feedback,
                run.session_id,
                run.provider_session_id,
                run.cwd,
                run.resumed_from_run_id,
                completion_transition,
                completion_attempt,
                run_ownership_version,
            ],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve_live_post_action(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        completion_attempt: &str,
        expected: &TaskActionState,
        action_request: Option<PendingTaskActionRequest<'_>>,
    ) -> Result<Option<ReplacedStageRunSource>, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let task = transaction.query_row(
            "SELECT stage, branch
             FROM pipeline_item
             WHERE id = ?1 AND closed_at IS NULL",
            [run.task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        if task.0 != expected.stage || task.1 != expected.branch {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let current = transaction
            .query_row(
                "SELECT id, status, result, feedback, finished_at, run_ownership_version
                 FROM stage_run
                 WHERE task_id = ?1
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1",
                [run.task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?;
        if current.as_ref().map(|current| current.0.as_str()) != expected.active_run_id.as_deref() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let source = current.as_ref().map(|current| ReplacedStageRunSource {
            run_id: current.0.clone(),
            status: current.1.clone(),
            result: current.2.clone(),
            feedback: current.3.clone(),
            finished_at: current.4.clone(),
        });
        if current
            .as_ref()
            .is_some_and(|current| current.1 == "running")
        {
            let changed = transaction.execute(
                "UPDATE stage_run
                 SET status = 'succeeded', finished_at = datetime('now')
                 WHERE id = ?1 AND task_id = ?2 AND status = 'running'",
                (
                    current.as_ref().map(|current| current.0.as_str()),
                    run.task_id,
                ),
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.execute(
            "INSERT INTO stage_run
             (id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
              session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition,
              completion_attempt, run_ownership_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16)",
            params![
                run.id,
                run.task_id,
                run.stage,
                run.kind,
                run.agent,
                run.agent_provider,
                run.model,
                run.result,
                run.feedback,
                run.session_id,
                run.provider_session_id,
                run.cwd,
                run.resumed_from_run_id,
                completion_transition,
                completion_attempt,
                current
                    .as_ref()
                    .map(|current| current.5)
                    .unwrap_or(CURRENT_RUN_OWNERSHIP_VERSION),
            ],
        )?;
        if let Some(request) = action_request {
            let linked = transaction.execute(
                "UPDATE task_action_request
                 SET successor_run_id = ?2,
                     phase = 'post_reserved',
                     http_status = ?3,
                     response_body = ?4,
                     post_delivery_started_at = NULL,
                     post_source_run_id = ?6,
                     post_source_status = ?7,
                     post_source_finished_at = ?8,
                     updated_at = datetime('now')
                 WHERE idempotency_key = ?1
                   AND task_id = ?5
                   AND state = 'pending'
                   AND successor_run_id IS NULL
                   AND phase = 'preparing'",
                params![
                    request.idempotency_key,
                    run.id,
                    request.success_status,
                    request.success_response_body,
                    run.task_id,
                    current.as_ref().map(|source| source.0.as_str()),
                    current.as_ref().map(|source| source.1.as_str()),
                    current.as_ref().and_then(|source| source.4.as_deref()),
                ],
            )?;
            if linked != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.commit()?;
        Ok(source)
    }

    /// Record that this reservation's delivery has been *attempted*. Called
    /// before the daemon submission, not after its acknowledgement: once the
    /// submission may have reached the PTY, reconciliation must keep the
    /// reservation (and therefore its delivery identity) instead of retiring
    /// it and minting a new one for a second delivery.
    pub fn mark_reserved_live_post_delivery_started(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE task_action_request
             SET post_delivery_started_at = COALESCE(post_delivery_started_at, datetime('now')),
                 updated_at = datetime('now')
             WHERE task_id = ?1
               AND successor_run_id = ?2
               AND state = 'pending'
               AND phase = 'post_reserved'",
            (task_id, run_id),
        )?;
        if changed != 1 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn land_reserved_live_post(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE stage_run
             SET status = 'running'
             WHERE id = ?1
               AND task_id = ?2
               AND kind = 'post'
               AND status = 'pending'
               AND id = (
                 SELECT id FROM stage_run
                 WHERE task_id = ?2
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1
               )",
            (run_id, task_id),
        )?;
        if changed != 1 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.execute(
            "UPDATE task_action_request
             SET state = 'succeeded', updated_at = datetime('now')
             WHERE successor_run_id = ?1
               AND state = 'pending'
               AND phase = 'post_reserved'",
            [run_id],
        )?;
        transaction.commit()
    }

    pub fn rollback_reserved_live_post(
        &self,
        task_id: &str,
        run_id: &str,
        source: Option<&ReplacedStageRunSource>,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        // Release the reservation before deleting the run it points at.
        // `successor_run_id` is `ON DELETE SET NULL`, so once the row is gone
        // this predicate can never match again and the request would be left
        // stranded in `post_reserved` with a delivery claim it no longer owns.
        transaction.execute(
            "UPDATE task_action_request
             SET successor_run_id = NULL,
                 phase = 'preparing',
                 post_delivery_started_at = NULL,
                 post_source_run_id = NULL,
                 post_source_status = NULL,
                 post_source_finished_at = NULL,
                 updated_at = datetime('now')
             WHERE successor_run_id = ?1
               AND state = 'pending'
               AND phase = 'post_reserved'",
            [run_id],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM stage_run
             WHERE id = ?1
               AND task_id = ?2
               AND kind = 'post'
               AND status = 'pending'
               AND id = (
                 SELECT id FROM stage_run
                 WHERE task_id = ?2
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1
               )",
            (run_id, task_id),
        )?;
        if deleted != 1 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if let Some(source) = source {
            let restored = transaction.execute(
                "UPDATE stage_run
                 SET status = ?2, result = ?3, feedback = ?4, finished_at = ?5
                 WHERE id = ?1 AND task_id = ?6",
                (
                    source.run_id.as_str(),
                    source.status.as_str(),
                    source.result.as_deref(),
                    source.feedback.as_deref(),
                    source.finished_at.as_deref(),
                    task_id,
                ),
            )?;
            if restored != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.commit()
    }

    /// Reserve a successor run only while the task still has the exact
    /// stage, branch, and latest-run ownership observed during preparation.
    /// Finishing the source run and inserting the pending successor share
    /// the same SQLite write transaction, so concurrent/retried actions
    /// cannot both win.
    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    pub fn replace_current_run_with_pending(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        expected: &TaskActionState,
        source_status: &str,
        source_result: Option<&str>,
        source_feedback: Option<&str>,
    ) -> Result<Option<ReplacedStageRunSource>, rusqlite::Error> {
        self.replace_current_run_with_pending_inner(
            run,
            completion_transition,
            expected,
            source_status,
            source_result,
            source_feedback,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn replace_current_run_with_pending_action(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        expected: &TaskActionState,
        source_status: &str,
        source_result: Option<&str>,
        source_feedback: Option<&str>,
        target: PendingStageActionTarget<'_>,
    ) -> Result<Option<ReplacedStageRunSource>, rusqlite::Error> {
        self.replace_current_run_with_pending_inner(
            run,
            completion_transition,
            expected,
            source_status,
            source_result,
            source_feedback,
            Some(target),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn replace_current_run_with_pending_inner(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        expected: &TaskActionState,
        source_status: &str,
        source_result: Option<&str>,
        source_feedback: Option<&str>,
        target: Option<PendingStageActionTarget<'_>>,
    ) -> Result<Option<ReplacedStageRunSource>, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let current = transaction
            .query_row(
                "SELECT p.stage, p.branch,
                        (
                          SELECT id
                          FROM stage_run
                          WHERE task_id = p.id
                          ORDER BY datetime(started_at) DESC, rowid DESC
                          LIMIT 1
                        ),
                        (
                          SELECT CASE
                                   WHEN kind = 'post'
                                     THEN COALESCE(resumed_from_run_id, id)
                                   ELSE id
                                 END
                          FROM stage_run
                          WHERE task_id = p.id
                          ORDER BY datetime(started_at) DESC, rowid DESC
                          LIMIT 1
                        )
                 FROM pipeline_item p
                 WHERE p.id = ?1 AND p.closed_at IS NULL",
                [run.task_id],
                |row| {
                    Ok(TaskActionState {
                        stage: row.get(0)?,
                        branch: row.get(1)?,
                        active_run_id: row.get(2)?,
                        process_run_id: row.get(3)?,
                    })
                },
            )
            .optional()?;
        if current.as_ref() != Some(expected) {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        let replaced_source = if let Some(source_run_id) = expected.active_run_id.as_deref() {
            let source = transaction.query_row(
                "SELECT id, status, result, feedback, finished_at
                 FROM stage_run
                 WHERE id = ?1 AND task_id = ?2",
                (source_run_id, run.task_id),
                |row| {
                    Ok(ReplacedStageRunSource {
                        run_id: row.get(0)?,
                        status: row.get(1)?,
                        result: row.get(2)?,
                        feedback: row.get(3)?,
                        finished_at: row.get(4)?,
                    })
                },
            )?;
            transaction.execute(
                "UPDATE stage_run
                 SET status = ?2,
                     result = COALESCE(?3, result),
                     feedback = COALESCE(?4, feedback),
                     finished_at = COALESCE(finished_at, datetime('now'))
                 WHERE id = ?1 AND task_id = ?5 AND status IN ('pending', 'running')",
                (
                    source_run_id,
                    source_status,
                    source_result,
                    source_feedback,
                    run.task_id,
                ),
            )?;
            Some(source)
        } else {
            None
        };

        let task_changed = transaction.execute(
            "UPDATE pipeline_item
             SET activity = 'working',
                 activity_revision = activity_revision
                   + CASE WHEN activity = 'working' THEN 0 ELSE 1 END,
                 activity_changed_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ?1 AND closed_at IS NULL",
            [run.task_id],
        )?;
        if task_changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        transaction.execute(
            "INSERT INTO stage_run
             (id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
              session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition,
              run_ownership_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run.id,
                run.task_id,
                run.stage,
                run.kind,
                run.agent,
                run.agent_provider,
                run.model,
                run.status,
                run.result,
                run.feedback,
                run.session_id,
                run.provider_session_id,
                run.cwd,
                run.resumed_from_run_id,
                completion_transition,
                CURRENT_RUN_OWNERSHIP_VERSION,
            ),
        )?;
        if let Some(target) = target {
            let (worktree_id, worktree_path, worktree_branch) = target
                .worktree
                .map(|(id, path, branch)| (Some(id), Some(path), Some(branch)))
                .unwrap_or((None, None, None));
            transaction.execute(
                "INSERT INTO pending_stage_action
                 (successor_run_id, task_id, session_id, target_stage, target_branch,
                  target_worktree_id, target_worktree_path, target_worktree_branch,
                  remove_worktree_on_rollback,
                  source_stage, source_branch, source_active_run_id, source_process_run_id,
                  source_run_id, source_status, source_result, source_feedback,
                  source_finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    run.id,
                    run.task_id,
                    target.session_id,
                    target.stage,
                    target.branch,
                    worktree_id,
                    worktree_path,
                    worktree_branch,
                    target.remove_worktree_on_rollback,
                    expected.stage.as_str(),
                    expected.branch.as_str(),
                    expected.active_run_id.as_deref(),
                    expected.process_run_id.as_deref(),
                    replaced_source
                        .as_ref()
                        .map(|source| source.run_id.as_str()),
                    replaced_source
                        .as_ref()
                        .map(|source| source.status.as_str()),
                    replaced_source
                        .as_ref()
                        .and_then(|source| source.result.as_deref()),
                    replaced_source
                        .as_ref()
                        .and_then(|source| source.feedback.as_deref()),
                    replaced_source
                        .as_ref()
                        .and_then(|source| source.finished_at.as_deref()),
                ],
            )?;
            if let Some(request) = target.action_request {
                let linked = transaction.execute(
                    "UPDATE task_action_request
                     SET successor_run_id = ?2,
                         phase = 'successor_reserved',
                         http_status = ?3,
                         response_body = ?4,
                         updated_at = datetime('now')
                     WHERE idempotency_key = ?1
                       AND task_id = ?5
                       AND state = 'pending'
                       AND successor_run_id IS NULL",
                    params![
                        request.idempotency_key,
                        run.id,
                        request.success_status,
                        request.success_response_body,
                        run.task_id,
                    ],
                )?;
                if linked == 0 {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
            }
        }
        transaction.commit()?;
        Ok(replaced_source)
    }

    pub fn pending_stage_actions(&self) -> Result<Vec<PendingStageAction>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT successor_run_id, task_id, session_id, target_stage, target_branch,
                    target_worktree_id, target_worktree_path, target_worktree_branch,
                    remove_worktree_on_rollback,
                    source_stage, source_branch, source_active_run_id, source_process_run_id,
                    source_run_id, source_status, source_result, source_feedback,
                    source_finished_at
             FROM pending_stage_action
             ORDER BY datetime(created_at), rowid",
        )?;
        let rows = stmt.query_map([], |row| {
            let source_run_id = row.get::<_, Option<String>>(13)?;
            let source_status = row.get::<_, Option<String>>(14)?;
            Ok(PendingStageAction {
                successor_run_id: row.get(0)?,
                task_id: row.get(1)?,
                session_id: row.get(2)?,
                target_stage: row.get(3)?,
                target_branch: row.get(4)?,
                target_worktree_id: row.get(5)?,
                target_worktree_path: row.get(6)?,
                target_worktree_branch: row.get(7)?,
                remove_worktree_on_rollback: row.get(8)?,
                source: TaskActionState {
                    stage: row.get(9)?,
                    branch: row.get(10)?,
                    active_run_id: row.get(11)?,
                    process_run_id: row.get(12)?,
                },
                replaced_source: match (source_run_id, source_status) {
                    (Some(run_id), Some(status)) => Some(ReplacedStageRunSource {
                        run_id,
                        status,
                        result: row.get(15)?,
                        feedback: row.get(16)?,
                        finished_at: row.get(17)?,
                    }),
                    _ => None,
                },
            })
        })?;
        rows.collect()
    }

    pub fn pending_stage_action(
        &self,
        successor_run_id: &str,
    ) -> Result<Option<PendingStageAction>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT successor_run_id, task_id, session_id, target_stage, target_branch,
                        target_worktree_id, target_worktree_path, target_worktree_branch,
                        remove_worktree_on_rollback,
                        source_stage, source_branch, source_active_run_id, source_process_run_id,
                        source_run_id, source_status, source_result, source_feedback,
                        source_finished_at
                 FROM pending_stage_action
                 WHERE successor_run_id = ?1",
                [successor_run_id],
                |row| {
                    let source_run_id = row.get::<_, Option<String>>(13)?;
                    let source_status = row.get::<_, Option<String>>(14)?;
                    Ok(PendingStageAction {
                        successor_run_id: row.get(0)?,
                        task_id: row.get(1)?,
                        session_id: row.get(2)?,
                        target_stage: row.get(3)?,
                        target_branch: row.get(4)?,
                        target_worktree_id: row.get(5)?,
                        target_worktree_path: row.get(6)?,
                        target_worktree_branch: row.get(7)?,
                        remove_worktree_on_rollback: row.get(8)?,
                        source: TaskActionState {
                            stage: row.get(9)?,
                            branch: row.get(10)?,
                            active_run_id: row.get(11)?,
                            process_run_id: row.get(12)?,
                        },
                        replaced_source: match (source_run_id, source_status) {
                            (Some(run_id), Some(status)) => Some(ReplacedStageRunSource {
                                run_id,
                                status,
                                result: row.get(15)?,
                                feedback: row.get(16)?,
                                finished_at: row.get(17)?,
                            }),
                            _ => None,
                        },
                    })
                },
            )
            .optional()
    }

    pub fn rollback_pending_stage_action(
        &self,
        action: &PendingStageAction,
    ) -> Result<(), rusqlite::Error> {
        self.rollback_pending_replacement_and_restore_source(
            &action.task_id,
            &action.successor_run_id,
            &action.source,
            action.replaced_source.as_ref(),
        )
    }

    pub fn land_pending_stage_action(
        &self,
        action: &PendingStageAction,
    ) -> Result<(), rusqlite::Error> {
        let worktree = match (
            action.target_worktree_id.as_deref(),
            action.target_worktree_path.as_deref(),
            action.target_worktree_branch.as_deref(),
        ) {
            (Some(id), Some(path), Some(branch)) => Some((id, path, branch)),
            (None, None, None) => None,
            _ => return Err(rusqlite::Error::InvalidQuery),
        };
        self.land_stage_run_if_reserved(
            &action.task_id,
            &action.successor_run_id,
            &action.target_stage,
            action.target_branch.as_deref(),
            worktree,
            Some(&action.source),
        )
    }

    /// Undo a successor reservation only while it is still the task's latest
    /// pending run and the task remains at the source stage/branch. This
    /// restores the source verdict exactly so a live process whose guarded
    /// kill failed remains the action owner for a later retry.
    pub fn rollback_pending_replacement_and_restore_source(
        &self,
        task_id: &str,
        successor_run_id: &str,
        expected: &TaskActionState,
        source: Option<&ReplacedStageRunSource>,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let reservation_is_current = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM pipeline_item task
               JOIN stage_run successor
                 ON successor.id = ?2
                AND successor.task_id = task.id
                AND successor.status = 'pending'
               WHERE task.id = ?1
                 AND task.closed_at IS NULL
                 AND task.stage = ?3
                 AND task.branch = ?4
                 AND (
                   SELECT id
                   FROM stage_run
                   WHERE task_id = task.id
                   ORDER BY datetime(started_at) DESC, rowid DESC
                   LIMIT 1
                 ) = successor.id
             )",
            (
                task_id,
                successor_run_id,
                expected.stage.as_str(),
                expected.branch.as_str(),
            ),
            |row| row.get::<_, bool>(0),
        )?;
        if !reservation_is_current {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        transaction.execute(
            "UPDATE task_action_request
             SET state = 'failed',
                 http_status = 500,
                 response_body = 'task action successor did not become active',
                 updated_at = datetime('now')
             WHERE successor_run_id = ?1 AND state = 'pending'",
            [successor_run_id],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM stage_run
             WHERE id = ?1 AND task_id = ?2 AND status = 'pending'",
            (successor_run_id, task_id),
        )?;
        if deleted == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if let Some(source) = source {
            let restored = transaction.execute(
                "UPDATE stage_run
                 SET status = ?2,
                     result = ?3,
                     feedback = ?4,
                     finished_at = ?5
                 WHERE id = ?1 AND task_id = ?6",
                (
                    source.run_id.as_str(),
                    source.status.as_str(),
                    source.result.as_deref(),
                    source.feedback.as_deref(),
                    source.finished_at.as_deref(),
                    task_id,
                ),
            )?;
            if restored == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.commit()
    }

    #[allow(dead_code)]
    pub fn list_stage_runs_for_task(
        &self,
        task_id: &str,
    ) -> Result<Vec<StageRun>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
                    session_id, provider_session_id, cwd, resumed_from_run_id,
                    completion_transition, run_ownership_version, started_at, finished_at
             FROM stage_run
             WHERE task_id = ?
             ORDER BY datetime(started_at) ASC, rowid ASC",
        )?;
        let rows = stmt.query_map([task_id], stage_run_from_row)?;
        rows.collect()
    }

    /// The most recently started run for a task, regardless of status.
    pub fn latest_stage_run(&self, task_id: &str) -> Result<Option<StageRun>, rusqlite::Error> {
        let run = self
            .conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        completion_transition, run_ownership_version, started_at, finished_at
                 FROM stage_run
                 WHERE task_id = ?
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1",
                [task_id],
                stage_run_from_row,
            )
            .optional();
        match run {
            Ok(run) => Ok(run),
            Err(err) if is_missing_stage_run_table(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// The most recent main run of `stage`, whether or not it is resumable.
    /// The caller must validate this exact run rather than skipping a newer
    /// incomplete run to resume an older provider conversation.
    pub fn latest_main_stage_run(
        &self,
        task_id: &str,
        stage: &str,
    ) -> Result<Option<StageRun>, rusqlite::Error> {
        let run = self
            .conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        completion_transition, run_ownership_version, started_at, finished_at
                 FROM stage_run
                 WHERE task_id = ? AND stage = ? AND kind = 'main'
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1",
                [task_id, stage],
                stage_run_from_row,
            )
            .optional();
        match run {
            Ok(run) => Ok(run),
            Err(err) if is_missing_stage_run_table(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Attach a provider-native resume handle to its immutable owning main
    /// run. The run id is generated before daemon spawn and echoed on daemon
    /// lifecycle events, so a delayed event cannot stamp a replacement run
    /// that reuses the same durable terminal session id.
    pub fn update_stage_run_provider_session_id(
        &self,
        run_id: &str,
        provider_session_id: &str,
    ) -> Result<ProviderSessionUpdate, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE stage_run
             SET provider_session_id = ?2
             WHERE id = ?1 AND kind = 'main' AND provider_session_id IS NULL",
            (run_id, provider_session_id),
        )? > 0;
        if !changed {
            transaction.commit()?;
            return Ok(ProviderSessionUpdate { changed: false });
        }

        transaction.execute(
            "UPDATE pipeline_item
             SET agent_session_id = ?2
             WHERE id = (
               SELECT owner.task_id
               FROM stage_run owner
               WHERE owner.id = ?1 AND owner.kind = 'main'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM stage_run owner
               JOIN stage_run newer
                 ON newer.task_id = owner.task_id
                AND newer.kind = 'main'
                AND (
                  datetime(newer.started_at) > datetime(owner.started_at)
                  OR (
                    datetime(newer.started_at) = datetime(owner.started_at)
                    AND newer.rowid > owner.rowid
                  )
                )
               WHERE owner.id = ?1
             )",
            (run_id, provider_session_id),
        )?;
        transaction.commit()?;
        Ok(ProviderSessionUpdate { changed: true })
    }

    /// Capture the landed main run currently represented by an ownershipless
    /// legacy daemon session. Callers retain this immutable id for later
    /// lifecycle events instead of resolving the reusable session id again.
    pub fn landed_main_run_id_by_session(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT run.id
                 FROM stage_run run
                 JOIN pipeline_item task ON task.id = run.task_id
                 WHERE run.session_id = ?1
                   AND run.kind = 'main'
                   AND run.status != 'pending'
                   AND task.closed_at IS NULL
                 ORDER BY datetime(run.started_at) DESC, run.rowid DESC
                 LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn pending_main_run_id_by_session(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT run.id
                 FROM stage_run run
                 JOIN pipeline_item task ON task.id = run.task_id
                 WHERE run.session_id = ?1
                   AND run.kind = 'main'
                   AND run.status = 'pending'
                   AND task.closed_at IS NULL
                   AND run.id = (
                     SELECT latest.id
                     FROM stage_run latest
                     WHERE latest.task_id = run.task_id
                     ORDER BY datetime(latest.started_at) DESC, latest.rowid DESC
                     LIMIT 1
                   )
                 ORDER BY datetime(run.started_at) DESC, run.rowid DESC
                 LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
    }

    /// True only when `run_id` is the newest main run that owns the reusable
    /// daemon session. Posts may be newer rows while continuing that same
    /// process, but a newer main run permanently supersedes this owner.
    pub fn is_active_main_run_owner(
        &self,
        run_id: &str,
        session_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS (
               SELECT 1
               FROM stage_run owner
               JOIN pipeline_item task ON task.id = owner.task_id
               WHERE owner.id = ?1
                 AND owner.kind = 'main'
                 AND owner.session_id = ?2
                 AND task.closed_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM stage_run newer
                   WHERE newer.task_id = owner.task_id
                     AND newer.kind = 'main'
                     AND (
                       datetime(newer.started_at) > datetime(owner.started_at)
                       OR (
                         datetime(newer.started_at) = datetime(owner.started_at)
                         AND newer.rowid > owner.rowid
                       )
                     )
                 )
             )",
            (run_id, session_id),
            |row| row.get(0),
        )
    }

    pub fn finish_stage_run(
        &self,
        id: &str,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let rows_affected = transaction.execute(
            "UPDATE stage_run
             SET status = ?, result = ?, feedback = ?, finished_at = datetime('now')
             WHERE id = ?",
            (status, result, feedback, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.execute(
            "DELETE FROM pending_stage_action WHERE successor_run_id = ?1",
            [id],
        )?;
        transaction.commit()
    }

    pub fn start_stage_run(&self, id: &str) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE stage_run
             SET status = 'running'
             WHERE id = ?1 AND status = 'pending'",
            [id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.execute(
            "DELETE FROM pending_stage_action WHERE successor_run_id = ?1",
            [id],
        )?;
        transaction.commit()
    }

    /// Land an initial or newly awakened dormant task only while its
    /// reservation is still latest and the task remains open.
    pub fn start_initial_stage_run_if_current(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE stage_run
             SET status = 'running'
             WHERE id = ?1
               AND task_id = ?2
               AND status = 'pending'
               AND EXISTS (
                 SELECT 1
                 FROM pipeline_item task
                 WHERE task.id = ?2
                   AND task.closed_at IS NULL
                   AND (
                     SELECT id
                     FROM stage_run
                     WHERE task_id = task.id
                     ORDER BY datetime(started_at) DESC, rowid DESC
                     LIMIT 1
                   ) = ?1
               )",
            (run_id, task_id),
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.commit()
    }

    /// Land a daemon-created stage session as one atomic ownership change.
    /// Updating the task first acquires SQLite's write lock while proving the
    /// task is still open; close therefore cannot interleave between the
    /// guarded task update, worktree ownership, and starting the exact run.
    #[allow(dead_code)]
    pub fn land_stage_run(
        &self,
        task_id: &str,
        run_id: &str,
        stage: &str,
        branch: Option<&str>,
        worktree: Option<(&str, &str, &str)>,
    ) -> Result<(), rusqlite::Error> {
        self.land_stage_run_if_reserved(task_id, run_id, stage, branch, worktree, None)
    }

    pub fn land_stage_run_if_reserved(
        &self,
        task_id: &str,
        run_id: &str,
        stage: &str,
        branch: Option<&str>,
        worktree: Option<(&str, &str, &str)>,
        expected_source: Option<&TaskActionState>,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        if let Some(expected) = expected_source {
            let reservation_is_current = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1
                   FROM pipeline_item p
                   WHERE p.id = ?1
                     AND p.closed_at IS NULL
                     AND p.stage = ?2
                     AND p.branch = ?3
                     AND (
                       SELECT id
                       FROM stage_run
                       WHERE task_id = p.id
                       ORDER BY datetime(started_at) DESC, rowid DESC
                       LIMIT 1
                     ) = ?4
                 )",
                (
                    task_id,
                    expected.stage.as_str(),
                    expected.branch.as_str(),
                    run_id,
                ),
                |row| row.get::<_, bool>(0),
            )?;
            if !reservation_is_current {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        let task_changed = match branch {
            Some(branch) => transaction.execute(
                "UPDATE pipeline_item
                 SET stage = ?2,
                     branch = ?3,
                     agent_session_id = (
                       SELECT provider_session_id
                       FROM stage_run
                       WHERE id = ?4 AND task_id = ?1
                     ),
                     updated_at = datetime('now')
                 WHERE id = ?1 AND closed_at IS NULL",
                (task_id, stage, branch, run_id),
            )?,
            None => transaction.execute(
                "UPDATE pipeline_item
                     SET stage = ?2,
                     agent_session_id = (
                       SELECT provider_session_id
                       FROM stage_run
                       WHERE id = ?3 AND task_id = ?1
                     ),
                     updated_at = datetime('now')
                 WHERE id = ?1 AND closed_at IS NULL",
                (task_id, stage, run_id),
            )?,
        };
        if task_changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }

        if let Some((worktree_id, worktree_path, worktree_branch)) = worktree {
            transaction.execute(
                "INSERT INTO worktree (id, pipeline_item_id, path, branch)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   pipeline_item_id = excluded.pipeline_item_id,
                   path = excluded.path,
                   branch = excluded.branch",
                (worktree_id, task_id, worktree_path, worktree_branch),
            )?;
        }

        let run_changed = transaction.execute(
            "UPDATE stage_run
             SET status = 'running'
             WHERE id = ?1 AND task_id = ?2 AND status = 'pending'",
            (run_id, task_id),
        )?;
        if run_changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.execute(
            "UPDATE task_action_request
             SET state = 'succeeded', updated_at = datetime('now')
             WHERE successor_run_id = ?1 AND state = 'pending'",
            [run_id],
        )?;
        transaction.execute(
            "DELETE FROM pending_stage_action WHERE successor_run_id = ?1",
            [run_id],
        )?;
        transaction.commit()
    }

    /// Roll back a stage run that was inserted before daemon spawn but never
    /// became the task's active stage. Task close changes pending rows to
    /// cancelled, so both pre-start states are eligible. A provider event can
    /// arrive between close and rollback, so deleting the run and restoring
    /// the newest surviving main run's handle must be one transaction.
    pub fn delete_unstarted_stage_run_and_restore_provider_session_id(
        &self,
        id: &str,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let task_id = transaction.query_row(
            "DELETE FROM stage_run
             WHERE id = ?1 AND status IN ('pending', 'cancelled')
             RETURNING task_id",
            [id],
            |row| row.get::<_, String>(0),
        )?;
        let task_changed = transaction.execute(
            "UPDATE pipeline_item
             SET agent_session_id = (
                   SELECT provider_session_id
                   FROM stage_run
                   WHERE task_id = ?1 AND kind = 'main'
                   ORDER BY datetime(started_at) DESC, rowid DESC
                   LIMIT 1
                 ),
                 updated_at = datetime('now')
             WHERE id = ?1",
            [&task_id],
        )?;
        if task_changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        transaction.commit()
    }

    /// Finish the task's most recent `running` run, returning its kind so
    /// callers can tell whether a main run or a post completed.
    /// Returns `Ok(None)` without writing when no run is running.
    pub fn finish_latest_running_stage_run(
        &self,
        task_id: &str,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<Option<FinishedStageRun>, rusqlite::Error> {
        let run_result = self
            .conn
            .query_row(
                "SELECT id, kind, completion_transition
                 FROM stage_run
                 WHERE task_id = ? AND status = 'running'
                 ORDER BY datetime(started_at) DESC, rowid DESC
                 LIMIT 1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional();
        let run = match run_result {
            Ok(run) => run,
            Err(err) if is_missing_stage_run_table(&err) => return Ok(None),
            Err(err) => return Err(err),
        };
        let Some((run_id, kind, completion_transition)) = run else {
            return Ok(None);
        };
        self.finish_stage_run(&run_id, status, result, feedback)?;
        Ok(Some(FinishedStageRun {
            kind,
            completion_transition,
        }))
    }

    pub fn cancel_running_stage_runs(&self, task_id: &str) -> Result<(), rusqlite::Error> {
        match self.conn.execute(
            "UPDATE stage_run
             SET status = 'cancelled', finished_at = COALESCE(finished_at, datetime('now'))
             WHERE task_id = ? AND status IN ('pending', 'running')",
            [task_id],
        ) {
            Ok(_) => {}
            Err(err) if is_missing_stage_run_table(&err) => return Ok(()),
            Err(err) => return Err(err),
        }
        Ok(())
    }

    /// The task's most recently finished run result, whatever its kind. This
    /// is what `$PREV_RESULT` binds to, so for a stage whose predecessor
    /// declares a post it is the *post's* result (e.g. the commit agent's),
    /// not the stage agent's.
    pub fn latest_finished_stage_run_result(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.latest_finished_stage_run_result_of_kind(task_id, None)
    }

    /// The task's most recently finished **main** run result, skipping posts.
    /// A stage that needs what the previous stage's own agent reported — the
    /// implementer's summary, including work it declined — must use this:
    /// `latest_finished_stage_run_result` would hand it the commit post's
    /// result instead, silently losing that report.
    pub fn latest_finished_main_stage_run_result(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.latest_finished_stage_run_result_of_kind(task_id, Some("main"))
    }

    fn latest_finished_stage_run_result_of_kind(
        &self,
        task_id: &str,
        kind: Option<&str>,
    ) -> Result<Option<String>, rusqlite::Error> {
        let result = self
            .conn
            .query_row(
                "SELECT result
                 FROM stage_run
                 WHERE task_id = ?
                   AND status IN ('succeeded', 'failed')
                   AND result IS NOT NULL
                   AND (?2 IS NULL OR kind = ?2)
                 ORDER BY datetime(finished_at) DESC, datetime(started_at) DESC, rowid DESC
                 LIMIT 1",
                rusqlite::params![task_id, kind],
                |row| row.get(0),
            )
            .optional();
        match result {
            Ok(result) => Ok(result),
            Err(err) if is_missing_stage_run_table(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

fn is_missing_stage_run_table(err: &rusqlite::Error) -> bool {
    matches!(err, rusqlite::Error::SqliteFailure(_, Some(message)) if message.contains("no such table: stage_run"))
}

fn stage_run_from_row(row: &rusqlite::Row<'_>) -> Result<StageRun, rusqlite::Error> {
    Ok(StageRun {
        id: row.get(0)?,
        task_id: row.get(1)?,
        stage: row.get(2)?,
        kind: row.get(3)?,
        agent: row.get(4)?,
        agent_provider: row.get(5)?,
        model: row.get(6)?,
        status: row.get(7)?,
        result: row.get(8)?,
        feedback: row.get(9)?,
        session_id: row.get(10)?,
        provider_session_id: row.get(11)?,
        cwd: row.get(12)?,
        resumed_from_run_id: row.get(13)?,
        completion_transition: row.get(14)?,
        run_ownership_version: row.get(15)?,
        started_at: row.get(16)?,
        finished_at: row.get(17)?,
    })
}
