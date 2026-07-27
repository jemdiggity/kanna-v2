use super::Db;
use rusqlite::{params, OptionalExtension};

const COMPLETED_TASK_ACTION_RETENTION_DAYS: i64 = 7;
const MAX_COMPLETED_TASK_ACTION_REQUESTS: i64 = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskActionRequestClaim {
    Claimed,
    Pending {
        phase: String,
        owner_id: Option<String>,
        successor_run_id: Option<String>,
    },
    Completed {
        status: u16,
        body: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskActionExecutionClaim {
    Acquired,
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
            "SELECT task_id, action, request_json, state, phase, owner_id,
                    successor_run_id, http_status, response_body
             FROM task_action_request
             WHERE idempotency_key = ?1",
            [key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<u16>>(7)?,
                    row.get::<_, Option<String>>(8)?,
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
            "pending" => Ok(TaskActionRequestClaim::Pending {
                phase: stored.4,
                owner_id: stored.5,
                successor_run_id: stored.6,
            }),
            "succeeded" | "failed" => match (stored.7, stored.8) {
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

    /// Persist ownership before an HTTP action starts non-cancellable
    /// preparation. One AppState uses one owner id, so same-process retries
    /// remain pending; a restarted server may take over only while no durable
    /// successor has been linked.
    pub fn begin_task_action_request_execution(
        &self,
        key: &str,
        owner_id: &str,
    ) -> Result<TaskActionExecutionClaim, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let request = transaction
            .query_row(
                "SELECT state, phase, owner_id, successor_run_id, http_status, response_body
                 FROM task_action_request
                 WHERE idempotency_key = ?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<u16>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if request.0 != "pending" {
            transaction.commit()?;
            return match (request.4, request.5) {
                (Some(status), Some(body)) => {
                    Ok(TaskActionExecutionClaim::Completed { status, body })
                }
                _ => Err(rusqlite::Error::InvalidQuery),
            };
        }
        if request.3.is_some()
            || matches!(request.1.as_str(), "successor_reserved" | "post_reserved")
            || request.2.as_deref() == Some(owner_id)
        {
            transaction.commit()?;
            return Ok(TaskActionExecutionClaim::Pending);
        }
        let changed = transaction.execute(
            "UPDATE task_action_request
             SET phase = 'preparing',
                 owner_id = ?2,
                 updated_at = datetime('now')
             WHERE idempotency_key = ?1
               AND state = 'pending'
               AND successor_run_id IS NULL
               AND phase IN ('claimed', 'preparing')
               AND (owner_id IS NULL OR owner_id != ?2)",
            (key, owner_id),
        )?;
        transaction.commit()?;
        if changed == 1 {
            Ok(TaskActionExecutionClaim::Acquired)
        } else {
            Ok(TaskActionExecutionClaim::Pending)
        }
    }

    /// Spend one agent revision round and record that exact charge on the
    /// durable request in the same immediate transaction. A restarted owner
    /// reuses the recorded round instead of incrementing the task again.
    pub fn claim_agent_revision_round_for_task_action(
        &self,
        key: &str,
        task_id: &str,
        limit: i64,
    ) -> Result<Option<i64>, rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let (request_task_id, state, recorded_round) = db.conn.query_row(
                "SELECT task_id, state, revision_round
                 FROM task_action_request
                 WHERE idempotency_key = ?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?;
            if request_task_id != task_id || state != "pending" {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            if let Some(round) = recorded_round {
                return Ok(Some(round));
            }
            let rounds = db.task_revision_rounds(task_id)?;
            if limit > 0 && rounds >= limit {
                return Ok(None);
            }
            let next_round = rounds + 1;
            let task_changed = db.conn.execute(
                "UPDATE pipeline_item
                 SET revision_rounds = ?2, updated_at = datetime('now')
                 WHERE id = ?1 AND closed_at IS NULL",
                (task_id, next_round),
            )?;
            let request_changed = db.conn.execute(
                "UPDATE task_action_request
                 SET revision_round = ?2, updated_at = datetime('now')
                 WHERE idempotency_key = ?1
                   AND task_id = ?3
                   AND state = 'pending'
                   AND revision_round IS NULL",
                (key, next_round, task_id),
            )?;
            if task_changed != 1 || request_changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(Some(next_round))
        })
    }

    pub fn release_agent_revision_round_for_task_action(
        &self,
        key: &str,
        task_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.with_immediate_transaction(|db| {
            let recorded_round = db.conn.query_row(
                "SELECT revision_round
                 FROM task_action_request
                 WHERE idempotency_key = ?1 AND task_id = ?2 AND state = 'pending'",
                (key, task_id),
                |row| row.get::<_, Option<i64>>(0),
            )?;
            if recorded_round.is_none() {
                return Ok(());
            }
            db.conn.execute(
                "UPDATE pipeline_item
                 SET revision_rounds = MAX(revision_rounds - 1, 0),
                     updated_at = datetime('now')
                 WHERE id = ?1",
                [task_id],
            )?;
            let changed = db.conn.execute(
                "UPDATE task_action_request
                 SET revision_round = NULL, updated_at = datetime('now')
                 WHERE idempotency_key = ?1 AND task_id = ?2 AND state = 'pending'",
                (key, task_id),
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
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
                "SELECT state, http_status, response_body, successor_run_id, phase, owner_id,
                        post_delivery_started_at, post_source_run_id, post_source_status,
                        post_source_finished_at
                 FROM task_action_request
                 WHERE idempotency_key = ?1",
                [key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<u16>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
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
                if request.4 == "post_reserved" {
                    if request.6.is_none() {
                        let deleted = transaction.execute(
                            "DELETE FROM stage_run
                             WHERE id = ?1
                               AND status = 'pending'
                               AND kind = 'post'
                               AND id = (
                                 SELECT id FROM stage_run
                                 WHERE task_id = (
                                   SELECT task_id FROM task_action_request
                                   WHERE idempotency_key = ?2
                                 )
                                 ORDER BY datetime(started_at) DESC, rowid DESC
                                 LIMIT 1
                               )",
                            (&successor_run_id, key),
                        )?;
                        if deleted != 1 {
                            return Err(rusqlite::Error::QueryReturnedNoRows);
                        }
                        if let (Some(source_run_id), Some(source_status)) =
                            (request.7.as_deref(), request.8.as_deref())
                        {
                            let restored = transaction.execute(
                                "UPDATE stage_run
                                 SET status = ?2, finished_at = ?3
                                 WHERE id = ?1",
                                (source_run_id, source_status, request.9.as_deref()),
                            )?;
                            if restored != 1 {
                                return Err(rusqlite::Error::QueryReturnedNoRows);
                            }
                        }
                        let released = transaction.execute(
                            "UPDATE task_action_request
                             SET successor_run_id = NULL,
                                 phase = 'claimed',
                                 owner_id = NULL,
                                 post_delivery_started_at = NULL,
                                 post_source_run_id = NULL,
                                 post_source_status = NULL,
                                 post_source_finished_at = NULL,
                                 updated_at = datetime('now')
                             WHERE idempotency_key = ?1
                               AND state = 'pending'
                               AND phase = 'post_reserved'
                               AND post_delivery_started_at IS NULL",
                            [key],
                        )?;
                        if released != 1 {
                            return Err(rusqlite::Error::QueryReturnedNoRows);
                        }
                        transaction.commit()?;
                        return Ok(TaskActionRequestClaim::Claimed);
                    }
                    transaction.commit()?;
                    return Ok(TaskActionRequestClaim::Pending {
                        phase: request.4,
                        owner_id: request.5,
                        successor_run_id: Some(successor_run_id),
                    });
                }
                let reservation_exists = transaction.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM pending_stage_action WHERE successor_run_id = ?1
                     )",
                    [&successor_run_id],
                    |row| row.get::<_, bool>(0),
                )?;
                transaction.commit()?;
                if reservation_exists {
                    Ok(TaskActionRequestClaim::Pending {
                        phase: request.4,
                        owner_id: request.5,
                        successor_run_id: Some(successor_run_id),
                    })
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
