use super::Db;
use rusqlite::OptionalExtension;

impl Db {
    pub fn insert_create_task_intent(
        &self,
        task_id: &str,
        request_json: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO create_task_intent (task_id, request_json)
             VALUES (?1, ?2)",
            (task_id, request_json),
        )?;
        Ok(())
    }

    pub fn get_create_task_intent(&self, task_id: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT request_json FROM create_task_intent WHERE task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn update_create_task_intent(
        &self,
        task_id: &str,
        request_json: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE create_task_intent SET request_json = ?2 WHERE task_id = ?1",
            (task_id, request_json),
        )?;
        Ok(())
    }

    pub fn delete_create_task_intent(&self, task_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM create_task_intent WHERE task_id = ?1",
            [task_id],
        )?;
        Ok(())
    }
}
