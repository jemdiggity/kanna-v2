use super::{Db, NewStageRun, StageRun};
use rusqlite::OptionalExtension;

/// Identity of a run closed by `finish_latest_running_stage_run`.
pub struct FinishedStageRun {
    pub kind: String,
    pub completion_transition: Option<String>,
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
              session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            ),
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn list_stage_runs_for_task(
        &self,
        task_id: &str,
    ) -> Result<Vec<StageRun>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, stage, kind, agent, agent_provider, model, status, result, feedback,
                    session_id, provider_session_id, cwd, resumed_from_run_id,
                    completion_transition, started_at, finished_at
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
                        completion_transition, started_at, finished_at
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
                        completion_transition, started_at, finished_at
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

    /// Roll back a stage run that was inserted before daemon spawn but never
    /// became the task's active stage. Task close changes pending rows to
    /// cancelled, so both pre-start states are eligible.
    pub fn delete_unstarted_stage_run(&self, id: &str) -> Result<(), rusqlite::Error> {
        let changed = self.conn.execute(
            "DELETE FROM stage_run
             WHERE id = ?1 AND status IN ('pending', 'cancelled')",
            [id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
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

    /// Re-finish the task's most recent already-finished run with a late
    /// verdict. A parked task has no running run: an agent that reported
    /// failure, fixed the problem, and reported success would otherwise lose
    /// the verdict (and, for posts, the deferred transition). The latest
    /// verdict wins.
    pub fn refinish_latest_stage_run(
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
                 WHERE task_id = ? AND status IN ('succeeded', 'failed')
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
        started_at: row.get(15)?,
        finished_at: row.get(16)?,
    })
}
