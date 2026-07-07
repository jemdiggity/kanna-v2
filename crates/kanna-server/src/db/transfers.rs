use super::Db;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIncomingTransfer {
    pub id: String,
    pub source_peer_id: Option<String>,
    pub source_task_id: Option<String>,
    pub payload_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskTransfer {
    pub id: String,
    pub direction: String,
    pub status: String,
    pub source_peer_id: Option<String>,
    pub target_peer_id: Option<String>,
    pub source_task_id: Option<String>,
    pub local_task_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub payload_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewTaskTransfer {
    pub id: String,
    pub direction: String,
    pub status: String,
    pub source_peer_id: Option<String>,
    pub target_peer_id: Option<String>,
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
             (id, direction, status, source_peer_id, target_peer_id, source_task_id, local_task_id, error, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                &transfer.id,
                &transfer.direction,
                &transfer.status,
                transfer.source_peer_id.as_deref(),
                transfer.target_peer_id.as_deref(),
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
        let mut stmt = self.conn.prepare(
            "SELECT id, direction, status, source_peer_id, target_peer_id, source_task_id,
                    local_task_id, started_at, completed_at, error, payload_json
             FROM task_transfer WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([transfer_id], |row| {
            Ok(TaskTransfer {
                id: row.get(0)?,
                direction: row.get(1)?,
                status: row.get(2)?,
                source_peer_id: row.get(3)?,
                target_peer_id: row.get(4)?,
                source_task_id: row.get(5)?,
                local_task_id: row.get(6)?,
                started_at: row.get(7)?,
                completed_at: row.get(8)?,
                error: row.get(9)?,
                payload_json: row.get(10)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn update_task_transfer_payload(
        &self,
        transfer_id: &str,
        payload_json: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer SET payload_json = ?, error = NULL WHERE id = ?",
            (payload_json, transfer_id),
        )?;
        Ok(rows_affected == 1)
    }

    pub fn mark_task_transfer_completed(
        &self,
        transfer_id: &str,
        local_task_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer SET status = 'completed', local_task_id = ?, completed_at = datetime('now'), error = NULL WHERE id = ?",
            (local_task_id, transfer_id),
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
             VALUES (?, ?, ?, ?)",
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
            "SELECT id, source_peer_id, source_task_id, payload_json
             FROM task_transfer
             WHERE direction = 'incoming' AND status = 'pending'
             ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PendingIncomingTransfer {
                id: row.get(0)?,
                source_peer_id: row.get(1)?,
                source_task_id: row.get(2)?,
                payload_json: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn claim_pending_incoming_transfer(
        &self,
        transfer_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'streaming', error = NULL
             WHERE id = ? AND direction = 'incoming' AND status = 'pending'",
            [transfer_id],
        )?;
        Ok(rows_affected == 1)
    }

    pub fn fail_pending_incoming_transfer(
        &self,
        transfer_id: &str,
        reason: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE task_transfer
             SET status = 'failed', completed_at = datetime('now'), error = ?
             WHERE id = ? AND direction = 'incoming' AND status IN ('pending', 'streaming')",
            (reason, transfer_id),
        )?;
        Ok(rows_affected == 1)
    }
}
