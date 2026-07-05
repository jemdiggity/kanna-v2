use super::Db;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIncomingTransfer {
    pub id: String,
    pub source_peer_id: Option<String>,
    pub source_task_id: Option<String>,
    pub payload_json: Option<String>,
}

impl Db {
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
