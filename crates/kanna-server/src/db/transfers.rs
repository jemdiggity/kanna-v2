use super::Db;
use serde::{Deserialize, Serialize};

const TASK_TRANSFER_COLUMNS: &str = "SELECT id, direction, status, source_peer_id, target_peer_id,
            source_desktop_id, target_desktop_id, source_task_id,
            local_task_id, started_at, completed_at, error, payload_json,
            claim_owner_token, claim_expires_at
     FROM task_transfer";

/// Mirrors `idx_task_transfer_active_outgoing_source` (migration
/// `036_task_transfer_ownership_leases`) exactly. The index is what rejects a
/// duplicate push, so anything that predicts the rejection has to agree with it
/// literally rather than approximately.
const ACTIVE_OUTGOING_TRANSFER_STATUSES: &str = "('pending', 'streaming')";

/// The rusqlite message SQLite raises when that index rejects an insert.
pub const ACTIVE_OUTGOING_TRANSFER_CONSTRAINT: &str =
    "UNIQUE constraint failed: task_transfer.source_task_id";

fn read_task_transfer(row: &rusqlite::Row<'_>) -> Result<TaskTransfer, rusqlite::Error> {
    Ok(TaskTransfer {
        id: row.get(0)?,
        direction: row.get(1)?,
        status: row.get(2)?,
        source_peer_id: row.get(3)?,
        target_peer_id: row.get(4)?,
        source_desktop_id: row.get(5)?,
        target_desktop_id: row.get(6)?,
        source_task_id: row.get(7)?,
        local_task_id: row.get(8)?,
        started_at: row.get(9)?,
        completed_at: row.get(10)?,
        error: row.get(11)?,
        payload_json: row.get(12)?,
        claim_owner_token: row.get(13)?,
        claim_expires_at: row.get(14)?,
    })
}

/// True when `error` is the active-outgoing index rejecting a duplicate push,
/// rather than any other constraint the insert could trip.
pub fn is_active_outgoing_transfer_conflict(error: &rusqlite::Error) -> bool {
    match error {
        rusqlite::Error::SqliteFailure(failure, message) => {
            failure.code == rusqlite::ErrorCode::ConstraintViolation
                && message
                    .as_deref()
                    .is_some_and(|message| message.contains(ACTIVE_OUTGOING_TRANSFER_CONSTRAINT))
        }
        _ => false,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIncomingTransfer {
    pub id: String,
    pub status: String,
    pub source_peer_id: Option<String>,
    pub source_task_id: Option<String>,
    pub local_task_id: Option<String>,
    pub payload_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskTransfer {
    pub id: String,
    pub direction: String,
    pub status: String,
    pub source_peer_id: Option<String>,
    pub target_peer_id: Option<String>,
    pub source_desktop_id: Option<String>,
    pub target_desktop_id: Option<String>,
    pub source_task_id: Option<String>,
    pub local_task_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub payload_json: Option<String>,
    pub claim_owner_token: Option<String>,
    pub claim_expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewTaskTransfer {
    pub id: String,
    pub direction: String,
    pub status: String,
    pub source_peer_id: Option<String>,
    pub target_peer_id: Option<String>,
    pub source_desktop_id: Option<String>,
    pub target_desktop_id: Option<String>,
    pub source_task_id: Option<String>,
    pub local_task_id: Option<String>,
    pub error: Option<String>,
    pub payload_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewTaskTransferProvenance {
    pub pipeline_item_id: String,
    pub source_peer_id: String,
    pub source_task_id: String,
    pub source_machine_task_label: Option<String>,
}

impl Db {
    pub fn insert_task_transfer(&self, transfer: &NewTaskTransfer) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO task_transfer
             (id, direction, status, source_peer_id, target_peer_id, source_desktop_id, target_desktop_id, source_task_id, local_task_id, error, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING",
            (
                &transfer.id,
                &transfer.direction,
                &transfer.status,
                transfer.source_peer_id.as_deref(),
                transfer.target_peer_id.as_deref(),
                transfer.source_desktop_id.as_deref(),
                transfer.target_desktop_id.as_deref(),
                transfer.source_task_id.as_deref(),
                transfer.local_task_id.as_deref(),
                transfer.error.as_deref(),
                transfer.payload_json.as_deref(),
            ),
        )?;
        Ok(())
    }

    pub fn get_task_transfer(
        &self,
        transfer_id: &str,
    ) -> Result<Option<TaskTransfer>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare(&format!("{TASK_TRANSFER_COLUMNS} WHERE id = ?"))?;
        let mut rows = stmt.query_map([transfer_id], read_task_transfer)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// The one outgoing transfer a source task is allowed to have in flight, as
    /// the DB sees it.
    ///
    /// Renderer snapshots lag the DB, so a second `task-pull-requested` delivery
    /// could pass an eligibility check that only read `store.items` and then
    /// collide with `idx_task_transfer_active_outgoing_source`. This is the
    /// authoritative read that check needs, and it survives an app restart in a
    /// way the renderer's in-memory push guards never could.
    pub fn active_outgoing_transfer_for_source(
        &self,
        source_task_id: &str,
    ) -> Result<Option<TaskTransfer>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "{TASK_TRANSFER_COLUMNS}
             WHERE direction = 'outgoing'
               AND source_task_id = ?
               AND status IN {ACTIVE_OUTGOING_TRANSFER_STATUSES}
             ORDER BY started_at, id
             LIMIT 1"
        ))?;
        let mut rows = stmt.query_map([source_task_id], read_task_transfer)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn update_task_transfer_payload(
        &self,
        transfer_id: &str,
        payload_json: &str,
        claim_owner_token: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET payload_json = ?, error = NULL
             WHERE id = ?
               AND (
                 direction = 'outgoing'
                 OR (
                   direction = 'incoming'
                   AND ? IS NOT NULL
                   AND claim_owner_token = ?
                 )
               )",
            (
                payload_json,
                transfer_id,
                claim_owner_token,
                claim_owner_token,
            ),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn mark_task_transfer_completed(
        &self,
        transfer_id: &str,
        local_task_id: &str,
        claim_owner_token: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'completed', local_task_id = ?, completed_at = datetime('now'), error = NULL
             WHERE id = ?
               AND (
                 (direction = 'outgoing'
                   AND (
                     status IN ('pending', 'streaming')
                     OR (status = 'completed' AND local_task_id = ?)
                   ))
                 OR
                 (direction = 'incoming'
                   AND local_task_id = ?
                   AND claim_owner_token = ?
                   AND status IN ('awaiting_acknowledgment', 'completed'))
               )",
            (
                local_task_id,
                transfer_id,
                local_task_id,
                local_task_id,
                claim_owner_token,
            ),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn mark_incoming_transfer_importing(
        &self,
        transfer_id: &str,
        local_task_id: &str,
        claim_owner_token: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'importing', local_task_id = ?, error = NULL
             WHERE id = ? AND direction = 'incoming' AND claim_owner_token = ?
               AND (
                 status = 'claimed'
                 OR (status = 'importing' AND local_task_id = ?)
               )",
            (local_task_id, transfer_id, claim_owner_token, local_task_id),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn mark_incoming_transfer_awaiting_acknowledgment(
        &self,
        transfer_id: &str,
        local_task_id: &str,
        claim_owner_token: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'awaiting_acknowledgment', error = NULL
             WHERE id = ? AND direction = 'incoming' AND local_task_id = ?
               AND claim_owner_token = ?
               AND status IN ('importing', 'awaiting_acknowledgment')",
            (transfer_id, local_task_id, claim_owner_token),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn mark_task_transfer_rejected(
        &self,
        transfer_id: &str,
        error: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer SET status = 'rejected', completed_at = datetime('now'), error = ? WHERE id = ?",
            (error, transfer_id),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn insert_task_transfer_provenance(
        &self,
        provenance: &NewTaskTransferProvenance,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO task_transfer_provenance
             (pipeline_item_id, source_peer_id, source_task_id, source_machine_task_label)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(pipeline_item_id) DO NOTHING",
            (
                &provenance.pipeline_item_id,
                &provenance.source_peer_id,
                &provenance.source_task_id,
                provenance.source_machine_task_label.as_deref(),
            ),
        )?;
        Ok(())
    }

    pub fn list_pending_incoming_transfers(
        &self,
    ) -> Result<Vec<PendingIncomingTransfer>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, status, source_peer_id, source_task_id, local_task_id, payload_json
             FROM task_transfer
             WHERE direction = 'incoming'
               AND status IN ('pending', 'claimed', 'importing', 'awaiting_acknowledgment')
             ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PendingIncomingTransfer {
                id: row.get(0)?,
                status: row.get(1)?,
                source_peer_id: row.get(2)?,
                source_task_id: row.get(3)?,
                local_task_id: row.get(4)?,
                payload_json: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Every transfer this task took part in, newest first.
    ///
    /// A task is named by `source_task_id` on the machine it left and by
    /// `local_task_id` on the machine it arrived at — and by both on the
    /// source, whose `local_task_id` is its own id. Matching either is what
    /// lets one durable task id answer "where has this been?" from whichever
    /// side is asked, which is the question an agent has after scheduling a
    /// move.
    pub fn list_task_transfers(&self, task_id: &str) -> Result<Vec<TaskTransfer>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(&format!(
            "{TASK_TRANSFER_COLUMNS}
             WHERE source_task_id = ?1 OR local_task_id = ?1
             ORDER BY started_at DESC, id DESC"
        ))?;
        let rows = stmt.query_map([task_id], read_task_transfer)?;
        rows.collect()
    }

    pub fn list_terminal_incoming_transfer_ids(&self) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id
             FROM task_transfer
             WHERE direction = 'incoming'
               AND status IN ('completed', 'rejected', 'failed')
               AND sidecar_cleanup_completed_at IS NULL
             ORDER BY completed_at ASC, started_at ASC",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    pub fn mark_incoming_transfer_sidecar_cleanup_completed(
        &self,
        transfer_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET sidecar_cleanup_completed_at =
                 COALESCE(sidecar_cleanup_completed_at, datetime('now'))
             WHERE id = ? AND direction = 'incoming'
               AND status IN ('completed', 'rejected', 'failed')",
            [transfer_id],
        )?;
        Ok(rows_affected == 1)
    }

    pub fn claim_pending_incoming_transfer(
        &self,
        transfer_id: &str,
        owner_token: &str,
        recovery: bool,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = CASE WHEN status = 'pending' THEN 'claimed' ELSE status END,
                 claim_owner_token = ?,
                 claim_expires_at = datetime('now', '+30 seconds'),
                 error = NULL
             WHERE id = ? AND direction = 'incoming'
               AND (
                 status = 'pending'
                 OR (
                   ? = 1
                   AND status IN ('claimed', 'importing', 'awaiting_acknowledgment')
                 )
               )",
            (owner_token, transfer_id, i64::from(recovery)),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn renew_incoming_transfer_claim(
        &self,
        transfer_id: &str,
        owner_token: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET claim_expires_at = datetime('now', '+30 seconds')
             WHERE id = ? AND direction = 'incoming'
               AND claim_owner_token = ?
               AND status IN ('claimed', 'importing', 'awaiting_acknowledgment')",
            (transfer_id, owner_token),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn fail_pending_incoming_transfer(
        &self,
        transfer_id: &str,
        reason: &str,
        claim_owner_token: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'failed', completed_at = datetime('now'), error = ?
             WHERE id = ? AND direction = 'incoming'
               AND (
                 (
                   ? IS NULL
                   AND status = 'pending'
                   AND claim_owner_token IS NULL
                 )
                 OR (
                   ? IS NOT NULL
                   AND status = 'claimed'
                   AND claim_owner_token = ?
                 )
               )",
            (
                reason,
                transfer_id,
                claim_owner_token,
                claim_owner_token,
                claim_owner_token,
            ),
        )?;
        Ok(rows_affected == 1)
    }

    /// Drives an incoming transfer to its terminal failed state, wherever it
    /// had got to.
    ///
    /// [`Self::fail_pending_incoming_transfer`] is ownership-fenced and only
    /// reaches `pending`/`claimed`, which is right for a caller that holds one
    /// renderer's claim among several. The transfer engine is the only importer
    /// in the process, and an import that dies at `importing` or
    /// `awaiting_acknowledgment` still has to end visibly — otherwise the row
    /// sits non-terminal forever and the sidecar reservation with it.
    pub fn fail_incoming_task_transfer(
        &self,
        transfer_id: &str,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'failed', completed_at = datetime('now'), error = ?
             WHERE id = ? AND direction = 'incoming'
               AND status NOT IN ('completed', 'rejected', 'failed')",
            (reason, transfer_id),
        )?;
        Ok(rows_affected == 1)
    }

    /// Drives an outgoing transfer to its terminal failed state.
    ///
    /// The incoming side has had a fail route since the beginning; the outgoing
    /// side had none, so a source whose finalization could not ship the agent's
    /// session state left its row `pending` forever — invisible to the operator
    /// and blocking any retry of the same task.
    pub fn fail_outgoing_task_transfer(
        &self,
        transfer_id: &str,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'failed', completed_at = datetime('now'), error = ?
             WHERE id = ? AND direction = 'outgoing'
               AND status NOT IN ('completed', 'rejected', 'failed')",
            (reason, transfer_id),
        )?;
        Ok(rows_affected == 1)
    }
}
