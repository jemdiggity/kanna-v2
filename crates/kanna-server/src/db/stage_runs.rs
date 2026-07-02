use super::{Db, NewStageRun, StageRun};
use rusqlite::OptionalExtension;

impl Db {
    pub fn insert_stage_run(&self, run: NewStageRun<'_>) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO stage_run
             (id, task_id, stage, agent, agent_provider, model, status, result, feedback, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run.id,
                run.task_id,
                run.stage,
                run.agent,
                run.agent_provider,
                run.model,
                run.status,
                run.result,
                run.feedback,
                run.session_id,
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
            "SELECT id, task_id, stage, agent, agent_provider, model, status, result, feedback,
                    session_id, started_at, finished_at
             FROM stage_run
             WHERE task_id = ?
             ORDER BY datetime(started_at) ASC, id ASC",
        )?;
        let rows = stmt.query_map([task_id], stage_run_from_row)?;
        rows.collect()
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

    pub fn finish_latest_running_stage_run(
        &self,
        task_id: &str,
        status: &str,
        result: Option<&str>,
        feedback: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let run_id_result = self
            .conn
            .query_row(
                "SELECT id
                 FROM stage_run
                 WHERE task_id = ? AND status = 'running'
                 ORDER BY datetime(started_at) DESC, id DESC
                 LIMIT 1",
                [task_id],
                |row| row.get::<_, String>(0),
            )
            .optional();
        let run_id = match run_id_result {
            Ok(run_id) => run_id,
            Err(err) if is_missing_stage_run_table(&err) => return Ok(()),
            Err(err) => return Err(err),
        };
        let Some(run_id) = run_id else {
            return Ok(());
        };
        self.finish_stage_run(&run_id, status, result, feedback)
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

    pub fn latest_finished_stage_run_result(
        &self,
        task_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        let result = self
            .conn
            .query_row(
                "SELECT result
                 FROM stage_run
                 WHERE task_id = ?
                   AND status IN ('succeeded', 'failed')
                   AND result IS NOT NULL
                 ORDER BY datetime(finished_at) DESC, datetime(started_at) DESC, id DESC
                 LIMIT 1",
                [task_id],
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

#[allow(dead_code)]
fn stage_run_from_row(row: &rusqlite::Row<'_>) -> Result<StageRun, rusqlite::Error> {
    Ok(StageRun {
        id: row.get(0)?,
        task_id: row.get(1)?,
        stage: row.get(2)?,
        agent: row.get(3)?,
        agent_provider: row.get(4)?,
        model: row.get(5)?,
        status: row.get(6)?,
        result: row.get(7)?,
        feedback: row.get(8)?,
        session_id: row.get(9)?,
        started_at: row.get(10)?,
        finished_at: row.get(11)?,
    })
}
