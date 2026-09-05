use super::Db;

/// A server-owned lifecycle operation which crossed (or is about to cross)
/// the daemon boundary. The payload is deliberately opaque to the storage
/// layer: the lifecycle owner owns its versioned interpretation.
#[derive(Debug, Clone)]
pub struct LifecycleOperationIntent {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub phase: String,
    pub payload_json: String,
}

impl Db {
    pub fn insert_lifecycle_operation_intent(
        &self,
        id: &str,
        task_id: &str,
        kind: &str,
        phase: &str,
        payload_json: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO lifecycle_operation_intent
             (id, task_id, kind, phase, payload_json)
             VALUES (?, ?, ?, ?, ?)",
            (id, task_id, kind, phase, payload_json),
        )?;
        Ok(())
    }

    pub fn update_lifecycle_operation_phase(
        &self,
        id: &str,
        phase: &str,
    ) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute(
            "UPDATE lifecycle_operation_intent SET phase = ? WHERE id = ?",
            (phase, id),
        )?;
        Ok(changed == 1)
    }

    pub fn list_lifecycle_operation_intents(
        &self,
    ) -> Result<Vec<LifecycleOperationIntent>, rusqlite::Error> {
        let mut statement = self.conn.prepare(
            "SELECT id, task_id, kind, phase, payload_json
             FROM lifecycle_operation_intent ORDER BY rowid ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LifecycleOperationIntent {
                id: row.get(0)?,
                task_id: row.get(1)?,
                kind: row.get(2)?,
                phase: row.get(3)?,
                payload_json: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn has_lifecycle_operation(&self, id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifecycle_operation_intent WHERE id = ?)",
            [id],
            |row| row.get(0),
        )
    }

    pub fn has_lifecycle_operation_for_task(&self, task_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM lifecycle_operation_intent WHERE task_id = ?
            )",
            [task_id],
            |row| row.get(0),
        )
    }

    pub fn delete_lifecycle_operation_intent(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM lifecycle_operation_intent WHERE id = ?", [id])?;
        Ok(())
    }
}
