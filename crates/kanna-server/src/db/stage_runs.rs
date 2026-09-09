use super::{Db, NewStageRun, StageRun, TaskEventKind};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Identity of a run closed by `finish_latest_running_stage_run`.
pub struct FinishedStageRun {
    pub kind: String,
    pub completion_transition: Option<String>,
    pub trigger: String,
}

/// How a stage run was entered. Caller-declared labels are recorded without
/// authentication; only `Auto` is server-owned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageTrigger {
    Auto,
    Operator,
    Manager,
    Unspecified,
}

impl StageTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Operator => "operator",
            Self::Manager => "manager",
            Self::Unspecified => "unspecified",
        }
    }

    pub fn from_caller_declared(value: &str) -> Result<Self, String> {
        match value {
            "operator" => Ok(Self::Operator),
            "manager" => Ok(Self::Manager),
            other => Err(format!(
                "unknown stage advance source: {other}; use \"operator\" or \"manager\", or omit it"
            )),
        }
    }
}

/// Who declared a per-advance provider override. Like [`StageTrigger`], every
/// value here is a caller declaration the server records without
/// authenticating it; unlike a trigger there is no server-owned value, because
/// an override only ever exists because somebody asked for one.
///
/// `Agent` is the value that makes this worth recording separately from the
/// trigger: a plan agent recommends a builder tier and a human accepts it by
/// advancing the stage, so the advance is `operator` while the model was
/// picked by the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderOverrideSource {
    Operator,
    Manager,
    Agent,
    Unspecified,
}

impl ProviderOverrideSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Manager => "manager",
            Self::Agent => "agent",
            Self::Unspecified => "unspecified",
        }
    }

    pub fn from_caller_declared(value: &str) -> Result<Self, String> {
        match value {
            "operator" => Ok(Self::Operator),
            "manager" => Ok(Self::Manager),
            "agent" => Ok(Self::Agent),
            other => Err(format!(
                "unknown provider override source: {other}; use \"operator\", \"manager\" or \"agent\", or omit it"
            )),
        }
    }
}

/// A provider/model/effort override carried by one explicit stage advance and
/// applied to the stage that advance enters.
///
/// This is the durable record of *who chose the successor stage's model*, kept
/// beside the run's own resolved `agent_provider`/`model`/`effort` because
/// those alone cannot say whether a value was asked for or merely resolved: an
/// override that names only a provider still lets that provider's own lower
/// layers supply the model.
///
/// Model and effort belong to the provider named here and travel with it as
/// one layer — the AGENTS.md rule that a pair is never composed across layers
/// is why `model` and `effort` are meaningless without `provider`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageProviderOverride {
    /// `operator` | `manager` | `agent` | `unspecified`.
    pub source: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl StageProviderOverride {
    fn to_column(&self) -> Option<String> {
        match serde_json::to_string(self) {
            Ok(encoded) => Some(encoded),
            Err(error) => {
                // Never fail a spawn over its provenance record; a run with an
                // unreadable override reads as one with none, which is what
                // every pre-upgrade row already does.
                log::warn!("failed to encode a stage provider override: {error}");
                None
            }
        }
    }

    fn from_column(stored: Option<String>) -> Option<Self> {
        let stored = stored?;
        match serde_json::from_str(&stored) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                log::warn!("failed to parse a stored stage provider override: {error}");
                None
            }
        }
    }
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
        self.insert_stage_run_with_completion_binding(run, completion_transition, false)
    }

    /// Insert a run whose agent process was spawned with this exact run id in
    /// its completion context. Legacy/pre-upgrade runs deliberately leave the
    /// bit clear so surviving old clients may omit `runId`; a newly spawned
    /// run never takes that compatibility path.
    pub fn insert_stage_run_with_completion_binding(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        completion_bound: bool,
    ) -> Result<(), rusqlite::Error> {
        self.insert_stage_run_with_completion_binding_and_trigger(
            run,
            completion_transition,
            completion_bound,
            None,
        )
    }

    pub fn insert_stage_run_with_completion_binding_and_trigger(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        completion_bound: bool,
        trigger: Option<StageTrigger>,
    ) -> Result<(), rusqlite::Error> {
        self.insert_stage_run_with_provenance(
            run,
            completion_transition,
            completion_bound,
            trigger,
            None,
        )
    }

    /// Insert a run together with the full provenance of how it was started:
    /// its trigger, and the per-advance provider override that picked its
    /// model, if any.
    pub fn insert_stage_run_with_provenance(
        &self,
        run: NewStageRun<'_>,
        completion_transition: Option<&str>,
        completion_bound: bool,
        trigger: Option<StageTrigger>,
        provider_override: Option<&StageProviderOverride>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO stage_run
             (id, task_id, stage, kind, agent, agent_provider, model, effort, status, result, feedback,
              session_id, provider_session_id, cwd, resumed_from_run_id, completion_transition,
              completion_bound, trigger, provider_override)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                run.id,
                run.task_id,
                run.stage,
                run.kind,
                run.agent,
                run.agent_provider,
                run.model,
                run.effort,
                run.status,
                run.result,
                run.feedback,
                run.session_id,
                run.provider_session_id,
                run.cwd,
                run.resumed_from_run_id,
                completion_transition,
                completion_bound,
                trigger.map(StageTrigger::as_str),
                provider_override.and_then(StageProviderOverride::to_column),
            ],
        )?;
        // A pending run has not started anything yet; the watcher wants the
        // moment an agent is actually working.
        if run.status == "running" {
            // A previous session's `exited` verdict describes a session that
            // no longer exists, and a run that is starting proves this task has
            // one again. A post run is injected into the same live session,
            // whose `busy` verdict is still current, so only the terminal value
            // is cleared. The live-session restore path clears it the same way
            // — see `restore_task_run_for_live_session`.
            self.clear_exited_runtime_status(run.task_id)?;
            self.append_task_event(
                run.task_id,
                TaskEventKind::RunStarted,
                json!({
                    "runId": run.id,
                    "stage": run.stage,
                    "kind": run.kind,
                    "agent": run.agent,
                    "agentProvider": run.agent_provider,
                }),
            )?;
        }
        Ok(())
    }

    /// A stage that never spawned has no run stamp to supersede. An explicit
    /// execution edit also releases its creation request as a spawn template.
    pub fn workflow_stage_execution_edited(
        &self,
        task_id: &str,
        stage: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_event, json_each(task_event.payload, '$.changedExecutionStages') AS stage
             WHERE task_event.task_id = ? AND task_event.type = 'task.workflow_changed' AND stage.value = ?)",
            (task_id, stage), |row| row.get(0))
    }

    /// A workflow replacement explicitly invalidates only the old executions
    /// whose stage binding changed. RunStarted and WorkflowChanged are durable
    /// transactionally ordered events; no wall-clock comparison is involved.
    pub fn stage_run_workflow_superseded(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_event, json_each(task_event.payload, '$.supersededRunIds') AS run
             WHERE task_event.task_id = ? AND task_event.type = 'task.workflow_changed' AND run.value = ?)",
            (task_id, run_id), |row| row.get(0))
    }

    #[allow(dead_code)]
    pub fn list_stage_runs_for_task(
        &self,
        task_id: &str,
    ) -> Result<Vec<StageRun>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result, feedback,
                    session_id, provider_session_id, cwd, resumed_from_run_id,
                    resume_fallback_reason, completion_transition,
                    COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
             FROM stage_run
             WHERE task_id = ?
             ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map([task_id], stage_run_from_row)?;
        rows.collect()
    }

    pub fn running_stage_runs_for_task(
        &self,
        task_id: &str,
    ) -> Result<Vec<StageRun>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result, feedback,
                    session_id, provider_session_id, cwd, resumed_from_run_id,
                    resume_fallback_reason, completion_transition,
                    COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
             FROM stage_run WHERE task_id = ? AND status = 'running' ORDER BY rowid ASC",
        )?;
        let rows = stmt.query_map([task_id], stage_run_from_row)?;
        rows.collect()
    }

    /// Every distinct worktree a task's runs have been recorded in, most
    /// recently used first. A task's work does not stay on one branch —
    /// each stage transition forks a new workspace — so this is how
    /// `task_creator::work_tip` enumerates the branches that might hold the
    /// task's committed tip.
    pub fn task_stage_run_cwds(&self, task_id: &str) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = match self.conn.prepare(
            "SELECT cwd FROM stage_run
             WHERE task_id = ? AND cwd IS NOT NULL
             GROUP BY cwd
             ORDER BY MAX(rowid) DESC",
        ) {
            Ok(stmt) => stmt,
            Err(err) if is_missing_stage_run_table(&err) => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        let rows = stmt.query_map([task_id], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// The most recently started run for a task, regardless of status.
    pub fn latest_stage_run(&self, task_id: &str) -> Result<Option<StageRun>, rusqlite::Error> {
        let run = self
            .conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        resume_fallback_reason, completion_transition,
                        COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
                 FROM stage_run
                 WHERE task_id = ?
                 ORDER BY rowid DESC
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

    /// The most recently started run of one stage and kind. A rerun uses this
    /// to reproduce the run it is replacing (its provider, model, and effort)
    /// instead of re-deriving the stage's defaults.
    pub fn latest_stage_run_for_stage(
        &self,
        task_id: &str,
        stage: &str,
        kind: &str,
    ) -> Result<Option<StageRun>, rusqlite::Error> {
        let run = self
            .conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        resume_fallback_reason, completion_transition,
                        COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
                 FROM stage_run
                 WHERE task_id = ? AND stage = ? AND kind = ?
                 ORDER BY rowid DESC
                 LIMIT 1",
                [task_id, stage, kind],
                stage_run_from_row,
            )
            .optional();
        match run {
            Ok(run) => Ok(run),
            Err(err) if is_missing_stage_run_table(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    pub fn stage_run(&self, run_id: &str) -> Result<Option<StageRun>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        resume_fallback_reason, completion_transition,
                        COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
                 FROM stage_run WHERE id = ?",
                [run_id],
                stage_run_from_row,
            )
            .optional()
    }

    /// The most recent main run of `stage` whose provider session could be
    /// resumed: it recorded both the agent CLI's own session id and the
    /// worktree it ran in. Whether resumption is actually possible (worktree
    /// still on disk, transcript present, tips match) is the caller's check.
    pub fn latest_resumable_stage_run(
        &self,
        task_id: &str,
        stage: &str,
    ) -> Result<Option<StageRun>, rusqlite::Error> {
        let run = self
            .conn
            .query_row(
                "SELECT id, task_id, stage, kind, agent, agent_provider, model, effort, status, result,
                        feedback, session_id, provider_session_id, cwd, resumed_from_run_id,
                        resume_fallback_reason, completion_transition,
                        COALESCE(trigger, 'unspecified'), provider_override, started_at, finished_at
                 FROM stage_run
                 WHERE task_id = ? AND stage = ? AND kind = 'main'
                   AND provider_session_id IS NOT NULL AND cwd IS NOT NULL
                 ORDER BY rowid DESC
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

    /// Context-less keys belong to the task, not whichever run is live on retry.
    pub(crate) fn contextless_completion_attempt(
        &self,
        task_id: &str,
        attempt_key: &str,
    ) -> Result<Option<(String, String)>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT run_id, result FROM contextless_completion_attempt
             WHERE task_id = ? AND attempt_key = ?",
                (task_id, attempt_key),
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
    }

    pub(crate) fn record_contextless_completion_attempt(
        &self,
        attempt_key: &str,
        run_id: &str,
        result: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO contextless_completion_attempt (task_id, attempt_key, run_id, result)
             SELECT task_id, ?, id, ? FROM stage_run WHERE id = ?",
            (attempt_key, result, run_id),
        )?;
        Ok(())
    }

    /// Commit the retry identity and verdict together, including run.finished.
    pub(crate) fn finish_contextless_stage_run(
        &self,
        attempt_key: &str,
        run_id: &str,
        status: &str,
        result: &str,
        summary: &str,
    ) -> Result<(), rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            db.finish_stage_run(run_id, status, Some(result), Some(summary))?;
            db.record_contextless_completion_attempt(attempt_key, run_id, result)
        })
    }

    pub fn finish_stage_run(
        &self,
        id: &str,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let identity = self
            .conn
            .query_row(
                "SELECT task_id, stage, kind FROM stage_run WHERE id = ?",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let rows_affected = self.conn.execute(
            "UPDATE stage_run
             SET status = ?, result = ?, feedback = ?, finished_at = datetime('now')
             WHERE id = ?",
            (status, result, feedback, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if let Some((task_id, stage, kind)) = identity {
            self.append_task_event(
                &task_id,
                TaskEventKind::RunFinished,
                json!({
                    "runId": id,
                    "stage": stage,
                    "kind": kind,
                    "status": status,
                    "result": result,
                }),
            )?;
        }
        Ok(())
    }

    pub fn set_stage_run_resume_fallback_reason(
        &self,
        run_id: &str,
        reason: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE stage_run SET resume_fallback_reason = ? WHERE id = ?",
            (reason, run_id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    /// Persist a provider session id learned after spawn (for example Codex's
    /// terminal footer) on both the task and its latest run. The run record is
    /// the durable resume source; the `pipeline_item` field remains the legacy
    /// current-session mirror.
    pub fn update_latest_stage_run_provider_session_id(
        &self,
        task_id: &str,
        provider_session_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE stage_run
             SET provider_session_id = ?
             WHERE id = (
               SELECT id FROM stage_run
               WHERE task_id = ?
               ORDER BY rowid DESC
               LIMIT 1
             )",
            (provider_session_id, task_id),
        )?;
        self.update_pipeline_item_agent_session_id(task_id, Some(provider_session_id))
    }

    /// The most recent `main` run a daemon session served for a task. A stage
    /// transition respawns the same session id for the next stage, so the run
    /// — not the session — is the identity a provider session belongs to, and
    /// a killer must resolve it before its replacement run is inserted. The
    /// stage's post shares the session id but is never the run a revision
    /// reopens, so it is deliberately skipped.
    pub fn latest_main_stage_run_id_for_session(
        &self,
        task_id: &str,
        session_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        let run_id = self
            .conn
            .query_row(
                "SELECT id FROM stage_run
                 WHERE task_id = ? AND session_id = ? AND kind = 'main'
                 ORDER BY rowid DESC
                 LIMIT 1",
                (task_id, session_id),
                |row| row.get::<_, String>(0),
            )
            .optional();
        match run_id {
            Ok(run_id) => Ok(run_id),
            Err(err) if is_missing_stage_run_table(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Record a provider session id discovered as a session ended, on the exact
    /// run that session was serving. Returns whether it was recorded.
    ///
    /// The write is fenced on the run still naming that session and on having
    /// no provider session of its own: a delayed `Exit` from a replaced
    /// incarnation must never overwrite the id a later session recorded for
    /// the same run. Unlike the natural-exit path this deliberately leaves
    /// `pipeline_item.agent_session_id` alone — an orchestrated kill retires
    /// the outgoing session, and the task's current session is its
    /// replacement, which sets that mirror itself when it spawns.
    pub fn record_stage_run_provider_session_id(
        &self,
        run_id: &str,
        session_id: &str,
        provider_session_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let updated = self.conn.execute(
            "UPDATE stage_run
             SET provider_session_id = ?
             WHERE id = ? AND session_id = ? AND provider_session_id IS NULL",
            (provider_session_id, run_id, session_id),
        )?;
        Ok(updated > 0)
    }

    /// Restore a run that the terminal-loss path marked interrupted when the
    /// daemon proves the original session is still alive. The feedback marker
    /// identifies current no-verdict interruptions; legacy bare cancellations
    /// are also recoverable. A live-but-failed agent verdict is never reopened.
    pub fn restore_latest_interrupted_stage_run(
        &self,
        task_id: &str,
        interruption_feedback: &str,
    ) -> Result<bool, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let run_id = transaction
            .query_row(
                "SELECT sr.id
                 FROM stage_run sr
                 JOIN pipeline_item p ON p.id = sr.task_id
                 WHERE sr.task_id = ?
                   AND p.closed_at IS NULL
                   AND sr.id = (
                     SELECT latest.id
                     FROM stage_run latest
                     WHERE latest.task_id = sr.task_id
                     ORDER BY latest.rowid DESC
                     LIMIT 1
                   )
                   AND sr.status IN ('cancelled', 'failed')
                   AND (
                     sr.feedback = ?
                     OR (sr.status = 'cancelled' AND sr.result IS NULL AND sr.feedback IS NULL)
                   )
                 ORDER BY sr.rowid DESC
                 LIMIT 1",
                (task_id, interruption_feedback),
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(run_id) = run_id else {
            transaction.commit()?;
            return Ok(false);
        };
        let rows_affected = transaction.execute(
            "UPDATE stage_run
             SET status = 'running', result = NULL, feedback = NULL, finished_at = NULL
             WHERE id = ?
               AND status IN ('cancelled', 'failed')
               AND (
                 feedback = ?
                 OR (status = 'cancelled' AND result IS NULL AND feedback IS NULL)
               )",
            (&run_id, interruption_feedback),
        )?;
        transaction.commit()?;
        Ok(rows_affected > 0)
    }

    pub fn stage_run_completion_bound(&self, run_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT completion_bound != 0 FROM stage_run WHERE id = ?",
            [run_id],
            |row| row.get(0),
        )
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
                "SELECT id, kind, completion_transition, COALESCE(trigger, 'unspecified')
                 FROM stage_run
                 WHERE task_id = ? AND status = 'running'
                 ORDER BY rowid DESC
                 LIMIT 1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional();
        let run = match run_result {
            Ok(run) => run,
            Err(err) if is_missing_stage_run_table(&err) => return Ok(None),
            Err(err) => return Err(err),
        };
        let Some((run_id, kind, completion_transition, trigger)) = run else {
            return Ok(None);
        };
        self.finish_stage_run(&run_id, status, result, feedback)?;
        Ok(Some(FinishedStageRun {
            kind,
            completion_transition,
            trigger,
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
                 ORDER BY rowid DESC
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
        effort: row.get(7)?,
        status: row.get(8)?,
        result: row.get(9)?,
        feedback: row.get(10)?,
        session_id: row.get(11)?,
        provider_session_id: row.get(12)?,
        cwd: row.get(13)?,
        resumed_from_run_id: row.get(14)?,
        resume_fallback_reason: row.get(15)?,
        completion_transition: row.get(16)?,
        trigger: row.get(17)?,
        provider_override: StageProviderOverride::from_column(row.get(18)?),
        started_at: row.get(19)?,
        finished_at: row.get(20)?,
    })
}
