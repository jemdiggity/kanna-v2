use super::Db;
use rusqlite::OptionalExtension;

impl Db {
    pub fn get_task_worktree_path(
        &self,
        pipeline_item_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT path FROM worktree WHERE pipeline_item_id = ? ORDER BY created_at DESC LIMIT 1",
                [pipeline_item_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn upsert_worktree(
        &self,
        id: &str,
        pipeline_item_id: &str,
        path: &str,
        branch: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO worktree (id, pipeline_item_id, path, branch)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               pipeline_item_id = excluded.pipeline_item_id,
               path = excluded.path,
               branch = excluded.branch",
            (id, pipeline_item_id, path, branch),
        )?;
        Ok(())
    }

    pub fn upsert_terminal_session(
        &self,
        id: &str,
        repo_id: &str,
        pipeline_item_id: Option<&str>,
        label: Option<&str>,
        cwd: Option<&str>,
        daemon_session_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO terminal_session (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               repo_id = excluded.repo_id,
               pipeline_item_id = excluded.pipeline_item_id,
               label = excluded.label,
               cwd = excluded.cwd,
               daemon_session_id = excluded.daemon_session_id",
            (id, repo_id, pipeline_item_id, label, cwd, daemon_session_id),
        )?;
        Ok(())
    }

    pub fn delete_task_creation_artifacts(&self, item_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM terminal_session WHERE pipeline_item_id = ?",
            [item_id],
        )?;
        self.conn
            .execute("DELETE FROM worktree WHERE pipeline_item_id = ?", [item_id])?;
        self.conn.execute(
            "DELETE FROM task_blocker WHERE blocked_item_id = ? OR blocker_item_id = ?",
            (item_id, item_id),
        )?;
        self.conn.execute(
            "DELETE FROM task_port WHERE pipeline_item_id = ?",
            [item_id],
        )?;
        self.conn
            .execute("DELETE FROM pipeline_item WHERE id = ?", [item_id])?;
        Ok(())
    }
}
