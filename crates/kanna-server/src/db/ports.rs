use super::Db;
use rusqlite::OptionalExtension;
use std::collections::HashMap;

impl Db {
    pub fn list_task_ports(&self) -> Result<Vec<i64>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT port FROM task_port ORDER BY port ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    pub fn list_task_ports_for_item(
        &self,
        item_id: &str,
    ) -> Result<HashMap<String, i64>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT env_name, port FROM task_port WHERE pipeline_item_id = ? ORDER BY port ASC",
        )?;
        let rows = stmt.query_map([item_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut ports = HashMap::new();
        for row in rows {
            let (env_name, port) = row?;
            ports.insert(env_name, port);
        }
        Ok(ports)
    }

    pub fn claim_task_port(
        &self,
        item_id: &str,
        env_name: &str,
        port: i64,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO task_port (port, pipeline_item_id, env_name) VALUES (?, ?, ?)",
            (port, item_id, env_name),
        )?;
        let owner: Option<String> = self
            .conn
            .query_row(
                "SELECT pipeline_item_id FROM task_port WHERE port = ?",
                [port],
                |row| row.get(0),
            )
            .optional()?;
        Ok(owner.as_deref() == Some(item_id))
    }

    pub fn update_pipeline_item_ports(
        &self,
        item_id: &str,
        port_offset: Option<i64>,
        port_env_json: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE pipeline_item
             SET port_offset = ?, port_env = ?, updated_at = datetime('now')
             WHERE id = ?",
            (port_offset, port_env_json, item_id),
        )?;
        Ok(())
    }

    pub fn delete_task_ports_for_item(&self, item_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM task_port WHERE pipeline_item_id = ?",
            [item_id],
        )?;
        self.update_pipeline_item_ports(item_id, None, None)?;
        Ok(())
    }
}
