use super::Db;

impl Db {
    pub fn update_pipeline_item_active_post_action(
        &self,
        id: &str,
        active_post_action: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = ?, updated_at = datetime('now') WHERE id = ?",
            (active_post_action, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn clear_pipeline_item_active_post_action(&self, id: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = NULL, updated_at = datetime('now') WHERE id = ?",
            [id],
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub fn update_pipeline_item_post_action_state(
        &self,
        id: &str,
        active_post_action: Option<&str>,
        stage_result: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE pipeline_item SET active_post_action = ?, stage_result = ?, updated_at = datetime('now') WHERE id = ?",
            (active_post_action, stage_result, id),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }
}
