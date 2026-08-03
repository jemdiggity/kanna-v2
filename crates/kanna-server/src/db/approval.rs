use super::Db;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalGateState {
    Eligible,
    Held,
    Overridden,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHold {
    pub run_id: String,
    pub stage: String,
    pub kind: String,
    pub summary: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_record: Option<ApprovalOverrideRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOverrideRecord {
    pub id: String,
    pub actor: String,
    pub channel: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalGate {
    pub state: ApprovalGateState,
    pub holds: Vec<ApprovalHold>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_record: Option<ApprovalOverrideRecord>,
}

pub struct ExplicitStageDisposition<'a> {
    pub task_id: &'a str,
    pub run_id: &'a str,
    pub run_stage: &'a str,
    pub run_kind: &'a str,
    pub run_status: &'a str,
    pub logical_stage: &'a str,
    pub disposition: Option<&'a str>,
    pub summary: &'a str,
}

#[derive(Debug, Clone)]
pub struct ApprovalAuthorization {
    pub run_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub branch: String,
    pub target: String,
    pub pr_url: Option<String>,
    pub approval: ApprovalGate,
    pub delivered_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDeliveryReservation {
    Reserved,
    AlreadyReserved,
    AlreadyDelivered,
}

impl ApprovalGate {
    pub fn permits_approval(&self) -> bool {
        matches!(self.state, ApprovalGateState::Eligible)
            || (matches!(self.state, ApprovalGateState::Overridden)
                && self.override_record.is_some())
    }
}

impl Db {
    pub fn record_approval_authorization(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<(), rusqlite::Error> {
        let task = self
            .get_pipeline_item(task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let repo = self
            .get_repo(&task.repo_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let branch = task.branch.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let target = task
            .base_ref
            .or(repo.default_branch)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let approval = self.task_approval_gate(task_id)?;
        if !approval.permits_approval() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let approval_json = serde_json::to_string(&approval)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        self.conn.execute(
            "INSERT INTO task_approval_authorization
               (run_id, task_id, repo_id, branch, target, pr_url, approval_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO NOTHING",
            (
                run_id,
                task_id,
                task.repo_id,
                branch,
                target,
                task.pr_url,
                approval_json,
            ),
        )?;
        Ok(())
    }

    pub fn approval_authorization(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<Option<ApprovalAuthorization>, rusqlite::Error> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                "SELECT run_id, task_id, repo_id, branch, target, pr_url,
                        approval_json, delivered_at
                 FROM task_approval_authorization
                 WHERE task_id = ? AND run_id = ?",
                (task_id, run_id),
                |row| {
                    let approval_json: String = row.get(6)?;
                    let approval = serde_json::from_str(&approval_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            approval_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                    Ok(ApprovalAuthorization {
                        run_id: row.get(0)?,
                        task_id: row.get(1)?,
                        repo_id: row.get(2)?,
                        branch: row.get(3)?,
                        target: row.get(4)?,
                        pr_url: row.get(5)?,
                        approval,
                        delivered_at: row.get(7)?,
                    })
                },
            )
            .optional()
    }

    pub fn reserve_approval_authorization_delivery(
        &self,
        run_id: &str,
        task_id: &str,
        session_id: &str,
        protocol: i64,
    ) -> Result<ApprovalDeliveryReservation, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let current = transaction.query_row(
            "SELECT delivered_at, delivery_task_id, delivery_session_id, delivery_protocol
             FROM task_approval_authorization WHERE run_id = ?",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )?;
        let result = if current.0.is_some() {
            ApprovalDeliveryReservation::AlreadyDelivered
        } else if current.1.is_some() || current.2.is_some() || current.3.is_some() {
            ApprovalDeliveryReservation::AlreadyReserved
        } else {
            transaction.execute(
                "UPDATE task_approval_authorization
                 SET delivery_task_id = ?, delivery_session_id = ?, delivery_protocol = ?,
                     delivery_reserved_at = datetime('now')
                 WHERE run_id = ? AND delivered_at IS NULL
                   AND delivery_task_id IS NULL AND delivery_session_id IS NULL",
                (task_id, session_id, protocol, run_id),
            )?;
            ApprovalDeliveryReservation::Reserved
        };
        transaction.commit()?;
        Ok(result)
    }

    pub fn release_approval_authorization_delivery(
        &self,
        run_id: &str,
        task_id: &str,
        session_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        Ok(self.conn.execute(
            "UPDATE task_approval_authorization
             SET delivery_task_id = NULL, delivery_session_id = NULL,
                 delivery_protocol = NULL, delivery_reserved_at = NULL
             WHERE run_id = ? AND delivered_at IS NULL
               AND delivery_task_id = ? AND delivery_session_id = ?",
            (run_id, task_id, session_id),
        )? > 0)
    }

    /// Finalize only after the daemon acknowledged the exact recipient. The
    /// singleton identity is rechecked in the same transaction; if it was
    /// replaced after acknowledgement, the reservation remains quarantined
    /// and a retry cannot duplicate a possibly accepted merge action.
    pub fn mark_approval_authorization_delivered(
        &self,
        run_id: &str,
        repo_id: &str,
        task_id: &str,
        session_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let recipient_matches: bool = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM pipeline_item p
               JOIN stage_run sr ON sr.task_id = p.id
               WHERE p.id = ? AND p.repo_id = ? AND p.closed_at IS NULL
                 AND sr.agent = 'merge'
                 AND COALESCE(NULLIF(sr.session_id, ''), p.id) = ?
                 AND COALESCE((
                   SELECT protocol.merge_handoff_version
                   FROM agent_signal_protocol protocol
                   WHERE protocol.task_id = p.id
                     AND protocol.session_id = COALESCE(NULLIF(sr.session_id, ''), p.id)
                 ), 0) = (
                   SELECT authorization.delivery_protocol
                   FROM task_approval_authorization authorization
                   WHERE authorization.run_id = ?
                     AND authorization.delivery_task_id = p.id
                     AND authorization.delivery_session_id = ?
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM stage_run newer
                   WHERE newer.task_id = p.id AND newer.rowid > sr.rowid
                     AND newer.agent = 'merge'
                 )
             )",
            (task_id, repo_id, session_id, run_id, session_id),
            |row| row.get(0),
        )?;
        let changed = if recipient_matches {
            transaction.execute(
                "UPDATE task_approval_authorization
                 SET delivered_at = COALESCE(delivered_at, datetime('now'))
                 WHERE run_id = ? AND delivery_task_id = ? AND delivery_session_id = ?",
                (run_id, task_id, session_id),
            )? > 0
        } else {
            false
        };
        transaction.commit()?;
        Ok(changed)
    }

    pub fn set_merge_handoff_protocol(
        &self,
        task_id: &str,
        session_id: &str,
        version: i64,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO agent_signal_protocol (task_id, session_id, merge_handoff_version)
             VALUES (?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
               session_id = excluded.session_id,
               merge_handoff_version = excluded.merge_handoff_version",
            (task_id, session_id, version),
        )?;
        Ok(())
    }

    pub fn task_approval_gate(&self, task_id: &str) -> Result<ApprovalGate, rusqlite::Error> {
        let unresolved = self.approval_holds(task_id, false)?;
        if !unresolved.is_empty() {
            return Ok(ApprovalGate {
                state: ApprovalGateState::Held,
                holds: unresolved,
                override_record: None,
            });
        }

        let overridden = self.approval_holds(task_id, true)?;
        if overridden.is_empty() {
            return Ok(ApprovalGate {
                state: ApprovalGateState::Eligible,
                holds: Vec::new(),
                override_record: None,
            });
        }
        let override_record = overridden
            .iter()
            .filter_map(|hold| hold.override_record.as_ref())
            .max_by(|left, right| (&left.created_at, &left.id).cmp(&(&right.created_at, &right.id)))
            .cloned();
        let all_overrides_present = overridden.iter().all(|hold| hold.override_record.is_some());
        Ok(match override_record {
            Some(record) if all_overrides_present => ApprovalGate {
                state: ApprovalGateState::Overridden,
                holds: overridden,
                override_record: Some(record),
            },
            Some(_) | None => ApprovalGate {
                state: ApprovalGateState::Held,
                holds: overridden,
                override_record: None,
            },
        })
    }

    fn approval_holds(
        &self,
        task_id: &str,
        overridden: bool,
    ) -> Result<Vec<ApprovalHold>, rusqlite::Error> {
        let override_predicate = if overridden {
            "h.override_id IS NOT NULL"
        } else {
            "h.override_id IS NULL"
        };
        let mut statement = self.conn.prepare(&format!(
            "SELECT h.run_id, h.scope_stage, h.kind, h.summary, h.created_at,
                    o.id, o.actor, o.channel, o.reason, o.created_at
             FROM task_approval_hold h
             LEFT JOIN task_approval_override o ON o.id = h.override_id
             WHERE h.task_id = ?
               AND h.resolved_at IS NULL
               AND {override_predicate}
             ORDER BY h.id ASC"
        ))?;
        let rows = statement.query_map([task_id], |row| {
            Ok(ApprovalHold {
                run_id: row.get(0)?,
                stage: row.get(1)?,
                kind: row.get(2)?,
                summary: row.get(3)?,
                created_at: row.get(4)?,
                override_record: row
                    .get::<_, Option<String>>(5)?
                    .map(|id| -> Result<ApprovalOverrideRecord, rusqlite::Error> {
                        Ok(ApprovalOverrideRecord {
                            id,
                            actor: row.get(6)?,
                            channel: row.get(7)?,
                            reason: row.get(8)?,
                            created_at: row.get(9)?,
                        })
                    })
                    .transpose()?,
            })
        })?;
        rows.collect()
    }

    /// Apply the structured disposition attached to an explicit
    /// `complete-stage` verdict. Failed main runs already acquired their hold
    /// atomically through the stage_run trigger. A successful main verdict is
    /// the only event allowed to resolve prior holds in the same logical
    /// stage; inferred successes and every kind of post are deliberately
    /// excluded.
    pub fn apply_explicit_stage_disposition(
        &self,
        input: ExplicitStageDisposition<'_>,
    ) -> Result<(), rusqlite::Error> {
        let ExplicitStageDisposition {
            task_id,
            run_id,
            run_stage,
            run_kind,
            run_status,
            logical_stage,
            disposition,
            summary,
        } = input;
        if matches!(
            disposition,
            Some("needs_human_input" | "not_merge_candidate")
        ) {
            self.conn.execute(
                "INSERT INTO task_approval_hold
                   (task_id, run_id, scope_stage, kind, summary)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(run_id) DO UPDATE SET
                   scope_stage = excluded.scope_stage,
                   kind = excluded.kind,
                   summary = excluded.summary,
                   created_at = datetime('now'),
                   resolved_by_run_id = NULL,
                   resolved_at = NULL,
                   override_id = NULL",
                (
                    task_id,
                    run_id,
                    if run_kind == "post" {
                        logical_stage
                    } else {
                        run_stage
                    },
                    disposition,
                    summary,
                ),
            )?;
            return Ok(());
        }

        if run_kind == "main" && run_status == "succeeded" {
            self.conn.execute(
                "UPDATE task_approval_hold AS hold
                 SET resolved_by_run_id = ?, resolved_at = datetime('now')
                 WHERE hold.task_id = ?
                   AND hold.scope_stage = ?
                   AND hold.resolved_at IS NULL
                   AND EXISTS (
                     SELECT 1
                     FROM stage_run AS resolver
                     JOIN stage_run AS origin ON origin.id = hold.run_id
                     WHERE resolver.id = ?
                       AND resolver.task_id = hold.task_id
                       AND resolver.rowid > origin.rowid
                   )",
                (run_id, task_id, run_stage, run_id),
            )?;
        }
        Ok(())
    }

    pub fn record_approval_override(
        &self,
        task_id: &str,
        override_id: &str,
        actor: &str,
        channel: &str,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let held: bool = self.conn.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM task_approval_hold
                   WHERE task_id = ? AND resolved_at IS NULL AND override_id IS NULL
                 )",
                [task_id],
                |row| row.get(0),
            )?;
            if !held {
                return Ok(false);
            }
            self.conn.execute(
                "INSERT INTO task_approval_override (id, task_id, actor, channel, reason)
                 VALUES (?, ?, ?, ?, ?)",
                (override_id, task_id, actor, channel, reason),
            )?;
            self.conn.execute(
                "UPDATE task_approval_hold
                 SET override_id = ?
                 WHERE task_id = ? AND resolved_at IS NULL AND override_id IS NULL",
                (override_id, task_id),
            )?;
            Ok(true)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}
