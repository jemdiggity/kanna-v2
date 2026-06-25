use super::{Db, NewRepo, Repo};

impl Db {
    pub fn list_repos(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at \
             FROM repo WHERE hidden = 0 OR hidden IS NULL ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                last_opened_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_repo(&self, id: &str) -> Result<Option<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at
             FROM repo WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                last_opened_at: row.get(7)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn insert_repo(&self, repo: NewRepo<'_>) -> Result<(), rusqlite::Error> {
        let sort_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM repo",
            [],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
             VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))",
            (
                repo.id,
                repo.path,
                repo.name,
                repo.default_branch,
                sort_order,
            ),
        )?;
        Ok(())
    }

    pub fn repo_path_exists(&self, path: &str) -> Result<bool, rusqlite::Error> {
        let count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM repo WHERE path = ?", [path], |row| {
                    row.get(0)
                })?;
        Ok(count > 0)
    }
}
