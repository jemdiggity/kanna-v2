use super::{Db, NewStageRun, StageRun};
use rusqlite::OptionalExtension;

const CURRENT_RUN_OWNERSHIP_VERSION: i64 = 1;

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
    pub fn finish_active_stage_run(
        &self,
        task_id: &str,
        expected_run_id: Option<&str>,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<Option<FinishedStageRun>, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let run = transaction
            .query_row(
                "SELECT id, kind, completion_transition, status,
                        resumed_from_run_id, run_ownership_version
                 FROM stage_run
                 WHERE task_id = ?1
                 ORDER BY datetime(started_at) DESC, rowid DESC
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
        )) = run
        else {
            return Ok(None);
        };
        let ownership_matches = expected_run_id.is_some_and(|expected| {
            expected == run_id
                || (kind == "post"
                    && completion_owner_run_id
                        .as_deref()
                        .is_some_and(|owner| owner == expected))
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
        if !matches!(
            current_status.as_str(),
            "pending" | "running" | "succeeded" | "failed"
        ) {
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
        self.conn.execute(
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
        Ok(())
    }

    /// Reserve a successor run only while the task still has the exact
    /// stage, branch, and latest-run ownership observed during preparation.
    /// Finishing the source run and inserting the pending successor share
    /// the same SQLite write transaction, so concurrent/retried actions
    /// cannot both win.
    #[allow(clippy::too_many_arguments)]
    pub fn replace_current_run_with_pending(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        expected: &TaskActionState,
        source_status: &str,
        source_result: Option<&str>,
        source_feedback: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
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

        if let Some(source_run_id) = expected.active_run_id.as_deref() {
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
        }

        let task_changed = transaction.execute(
            "UPDATE pipeline_item
             SET activity = 'working',
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

    /// Compatibility path for a daemon session adopted without immutable run
    /// ownership. The watcher calls this only after capability negotiation
    /// identifies the live session as ownershipless.
    pub fn update_active_stage_run_provider_session_id_by_session(
        &self,
        session_id: &str,
        provider_session_id: &str,
    ) -> Result<ProviderSessionUpdate, rusqlite::Error> {
        let Some(task_id) = self.resolve_pipeline_item_id(session_id)? else {
            return Ok(ProviderSessionUpdate { changed: false });
        };
        let transaction = self.conn.unchecked_transaction()?;
        let run_id = transaction
            .query_row(
                "SELECT run.id
                 FROM stage_run run
                 JOIN pipeline_item task ON task.id = run.task_id
                 WHERE run.task_id = ?1
                   AND run.kind = 'main'
                   AND task.closed_at IS NULL
                 ORDER BY datetime(run.started_at) DESC, run.rowid DESC
                 LIMIT 1",
                [&task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(run_id) = run_id else {
            transaction.commit()?;
            return Ok(ProviderSessionUpdate { changed: false });
        };
        let changed = transaction.execute(
            "UPDATE stage_run
             SET provider_session_id = ?2
             WHERE id = ?1 AND provider_session_id IS NULL",
            (&run_id, provider_session_id),
        )? > 0;
        transaction.execute(
            "UPDATE pipeline_item
             SET agent_session_id = (
               SELECT provider_session_id FROM stage_run WHERE id = ?2
             )
             WHERE id = ?1 AND closed_at IS NULL",
            (&task_id, &run_id),
        )?;
        transaction.commit()?;
        Ok(ProviderSessionUpdate { changed })
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
        let rows_affected = self.conn.execute(
            "UPDATE stage_run
             SET status = ?, result = ?, feedback = ?, finished_at = datetime('now')
             WHERE id = ?",
            (status, result, feedback, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn start_stage_run(&self, id: &str) -> Result<(), rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE stage_run
             SET status = 'running'
             WHERE id = ?1 AND status = 'pending'",
            [id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
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
