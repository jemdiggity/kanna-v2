use super::Db;
use rusqlite::{params, OptionalExtension};

const COMPLETED_TASK_ACTION_RETENTION_DAYS: i64 = 7;
const MAX_COMPLETED_TASK_ACTION_REQUESTS: i64 = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskActionRequestClaim {
    Claimed,
    Pending,
    Completed { status: u16, body: String },
}

#[derive(Debug)]
pub enum TaskActionRequestError {
    Conflict,
    Database(rusqlite::Error),
}

impl std::fmt::Display for TaskActionRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => formatter.write_str("idempotency key was already used"),
            Self::Database(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for TaskActionRequestError {}

impl From<rusqlite::Error> for TaskActionRequestError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl Db {
    pub fn prune_task_action_requests(&self) -> Result<usize, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let aged = transaction.execute(
            "DELETE FROM task_action_request
             WHERE state != 'pending'
               AND datetime(updated_at) < datetime('now', ?1)",
            [format!("-{COMPLETED_TASK_ACTION_RETENTION_DAYS} days")],
        )?;
        let overflow = transaction.execute(
            "DELETE FROM task_action_request
             WHERE state != 'pending'
               AND idempotency_key IN (
                 SELECT idempotency_key
                 FROM task_action_request
                 WHERE state != 'pending'
                 ORDER BY datetime(updated_at) DESC, rowid DESC
                 LIMIT -1 OFFSET ?1
               )",
            [MAX_COMPLETED_TASK_ACTION_REQUESTS],
        )?;
        transaction.commit()?;
        Ok(aged + overflow)
    }

    pub fn claim_task_action_request(
        &self,
        key: &str,
        task_id: &str,
        action: &str,
        request_json: &str,
    ) -> Result<TaskActionRequestClaim, TaskActionRequestError> {
        self.prune_task_action_requests()?;
        let transaction = self.conn.unchecked_transaction()?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO task_action_request
             (idempotency_key, task_id, action, request_json, state)
             VALUES (?1, ?2, ?3, ?4, 'pending')",
            (key, task_id, action, request_json),
        )? > 0;
        let stored = transaction.query_row(
            "SELECT task_id, action, request_json, state, http_status, response_body
             FROM task_action_request
             WHERE idempotency_key = ?1",
            [key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<u16>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )?;
        transaction.commit()?;

        if stored.0 != task_id || stored.1 != action || stored.2 != request_json {
            return Err(TaskActionRequestError::Conflict);
        }
        if inserted {
            return Ok(TaskActionRequestClaim::Claimed);
        }
        match stored.3.as_str() {
            "pending" => Ok(TaskActionRequestClaim::Pending),
            "succeeded" | "failed" => match (stored.4, stored.5) {
                (Some(status), Some(body)) => {
                    Ok(TaskActionRequestClaim::Completed { status, body })
                }
                _ => Err(TaskActionRequestError::Database(
                    rusqlite::Error::InvalidQuery,
                )),
            },
            _ => Err(TaskActionRequestError::Database(
                rusqlite::Error::InvalidQuery,
            )),
        }
    }

    pub fn finish_task_action_request(
        &self,
        key: &str,
        state: &str,
        status: u16,
        response_body: &str,
    ) -> Result<(), rusqlite::Error> {
        if !matches!(state, "succeeded" | "failed") {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let changed = self.conn.execute(
            "UPDATE task_action_request
             SET state = ?2,
                 http_status = ?3,
                 response_body = ?4,
                 updated_at = datetime('now')
             WHERE idempotency_key = ?1
               AND state IN ('pending', ?2)",
            params![key, state, status, response_body],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn park_exhausted_revision(
        &self,
        task_id: &str,
        result: &str,
        feedback: &str,
        action_response: Option<(&str, u16, &str)>,
    ) -> Result<(), rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE stage_run
             SET status = 'failed',
                 result = ?2,
                 feedback = ?3,
                 finished_at = datetime('now')
             WHERE id = (
               SELECT id
               FROM stage_run
               WHERE task_id = ?1 AND status = 'running'
               ORDER BY datetime(started_at) DESC, rowid DESC
               LIMIT 1
             )",
            (task_id, result, feedback),
        )?;
        transaction.execute(
            "UPDATE pipeline_item
             SET activity = 'unread',
                 activity_changed_at = datetime('now'),
                 activity_revision = activity_revision
                   + CASE WHEN activity = 'unread' THEN 0 ELSE 1 END,
                 unread_at = CASE
                   WHEN activity = 'unread' THEN unread_at
                   ELSE datetime('now')
                 END,
                 updated_at = datetime('now')
             WHERE id = ?1 AND closed_at IS NULL",
            [task_id],
        )?;
        if let Some((key, status, response_body)) = action_response {
            let changed = transaction.execute(
                "UPDATE task_action_request
                 SET state = 'succeeded',
                     http_status = ?3,
                     response_body = ?4,
                     updated_at = datetime('now')
                 WHERE idempotency_key = ?1
                   AND task_id = ?2
                   AND state IN ('pending', 'succeeded')",
                params![key, task_id, status, response_body],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        transaction.commit()
    }

    pub fn reconcile_task_action_request(
        &self,
        key: &str,
    ) -> Result<TaskActionRequestClaim, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let request = transaction
            .query_row(
                "SELECT state, http_status, response_body, successor_run_id
                 FROM task_action_request
                 WHERE idempotency_key = ?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<u16>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if request.0 != "pending" {
            transaction.commit()?;
            return match (request.1, request.2) {
                (Some(status), Some(body)) => {
                    Ok(TaskActionRequestClaim::Completed { status, body })
                }
                _ => Err(rusqlite::Error::InvalidQuery),
            };
        }

        let Some(successor_run_id) = request.3 else {
            transaction.commit()?;
            return Ok(TaskActionRequestClaim::Claimed);
        };

        let successor_status = transaction
            .query_row(
                "SELECT status FROM stage_run WHERE id = ?1",
                [&successor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match successor_status.as_deref() {
            Some("running" | "succeeded") => {
                let status = request.1.unwrap_or(200);
                let body = request.2.unwrap_or_else(|| "{}".to_string());
                transaction.execute(
                    "UPDATE task_action_request
                     SET state = 'succeeded', http_status = ?2, response_body = ?3,
                         updated_at = datetime('now')
                     WHERE idempotency_key = ?1 AND state = 'pending'",
                    params![key, status, body],
                )?;
                transaction.commit()?;
                Ok(TaskActionRequestClaim::Completed { status, body })
            }
            Some("pending") => {
                let reservation_exists = transaction.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM pending_stage_action WHERE successor_run_id = ?1
                     )",
                    [&successor_run_id],
                    |row| row.get::<_, bool>(0),
                )?;
                transaction.commit()?;
                if reservation_exists {
                    Ok(TaskActionRequestClaim::Pending)
                } else {
                    Err(rusqlite::Error::InvalidQuery)
                }
            }
            _ => {
                let body = "revision request successor did not become active";
                transaction.execute(
                    "UPDATE task_action_request
                     SET state = 'failed', http_status = 500, response_body = ?2,
                         updated_at = datetime('now')
                     WHERE idempotency_key = ?1 AND state = 'pending'",
                    (key, body),
                )?;
                transaction.commit()?;
                Ok(TaskActionRequestClaim::Completed {
                    status: 500,
                    body: body.to_string(),
                })
            }
        }
    }
}
