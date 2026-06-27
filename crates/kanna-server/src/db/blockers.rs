use super::Db;

impl Db {
    pub fn insert_task_blocker(
        &self,
        blocked_item_id: &str,
        blocker_item_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO task_blocker (blocked_item_id, blocker_item_id) VALUES (?, ?)",
            (blocked_item_id, blocker_item_id),
        )?;
        Ok(())
    }

    pub fn remove_all_task_blockers(&self, blocked_item_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM task_blocker WHERE blocked_item_id = ?",
            [blocked_item_id],
        )?;
        Ok(())
    }

    pub fn list_task_blocker_ids(
        &self,
        blocked_item_id: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT blocker_item_id FROM task_blocker WHERE blocked_item_id = ?")?;
        let rows = stmt.query_map([blocked_item_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn task_dependency_has_path_to(
        &self,
        from_blocked_item_id: &str,
        target_item_id: &str,
    ) -> Result<bool, rusqlite::Error> {
        fn dfs(
            db: &Db,
            current_id: &str,
            target_id: &str,
            visited: &mut std::collections::HashSet<String>,
        ) -> Result<bool, rusqlite::Error> {
            if current_id == target_id {
                return Ok(true);
            }
            if !visited.insert(current_id.to_string()) {
                return Ok(false);
            }
            for blocker_id in db.list_task_blocker_ids(current_id)? {
                if dfs(db, &blocker_id, target_id, visited)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }

        dfs(
            self,
            from_blocked_item_id,
            target_item_id,
            &mut std::collections::HashSet::new(),
        )
    }
}
