use super::{Db, NewRepo, Repo, SnapshotRepo};
use rusqlite::OptionalExtension;

#[derive(Debug)]
pub(crate) struct RepoOrderInput<'a> {
    pub id: &'a str,
    pub remote_url_hash: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ReorderReposResult {
    pub updated_ids: Vec<String>,
    pub not_persisted_ids: Vec<String>,
}

impl Db {
    pub fn list_repo_remote_urls(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, remote_url FROM repo WHERE remote_url IS NOT NULL")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    fn collect_repos(&self, sql: &str) -> Result<Vec<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url_hash: row.get(4)?,
                hidden: row.get(5)?,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                last_opened_at: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_repos(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        self.collect_repos(
            "SELECT id, path, name, default_branch, remote_url_hash, hidden, sort_order, \
                    created_at, last_opened_at \
             FROM repo WHERE hidden = 0 OR hidden IS NULL ORDER BY last_opened_at DESC",
        )
    }

    pub fn list_repos_for_maintenance(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        self.collect_repos(
            "SELECT id, path, name, default_branch, remote_url_hash, hidden, sort_order, \
                    created_at, last_opened_at \
             FROM repo ORDER BY last_opened_at DESC",
        )
    }

    pub fn get_repo(&self, id: &str) -> Result<Option<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, remote_url_hash, hidden, sort_order,
                    created_at, last_opened_at
             FROM repo WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url_hash: row.get(4)?,
                hidden: row.get(5)?,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                last_opened_at: row.get(8)?,
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

    pub fn delete_repo(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute("DELETE FROM repo WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn get_snapshot_repo_by_path(
        &self,
        path: &str,
    ) -> Result<Option<SnapshotRepo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, remote_url, remote_url_hash,
                    hidden, sort_order, created_at, last_opened_at
             FROM repo WHERE path = ?",
        )?;
        let mut rows = stmt.query_map([path], |row| {
            Ok(SnapshotRepo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
                remote_url_hash: row.get(5)?,
                hidden: row.get(6)?,
                sort_order: row.get(7)?,
                created_at: row.get(8)?,
                last_opened_at: row.get(9)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn patch_repo(
        &self,
        id: &str,
        name: Option<&str>,
        remote_url: Option<Option<&str>>,
        remote_url_hash: Option<Option<&str>>,
        hidden: Option<bool>,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE repo
             SET name = COALESCE(?, name),
                 remote_url = CASE WHEN ? THEN ? ELSE remote_url END,
                 remote_url_hash = CASE WHEN ? THEN ? ELSE remote_url_hash END,
                 hidden = COALESCE(?, hidden)
             WHERE id = ?",
            (
                name,
                remote_url.is_some(),
                remote_url.flatten(),
                remote_url_hash.is_some(),
                remote_url_hash.flatten(),
                hidden.map(|value| if value { 1_i64 } else { 0_i64 }),
                id,
            ),
        )?;
        if rows_affected == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    }

    pub(crate) fn reorder_repos(
        &self,
        ordered_repos: &[RepoOrderInput<'_>],
    ) -> Result<ReorderReposResult, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let mut result = ReorderReposResult {
            updated_ids: Vec::new(),
            not_persisted_ids: Vec::new(),
        };

        for (index, repo) in ordered_repos.iter().enumerate() {
            let sort_order = index as i64;
            let local_remote_url_hash = transaction
                .query_row(
                    "SELECT remote_url_hash FROM repo WHERE id = ?1",
                    [repo.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;

            if let Some(local_remote_url_hash) = local_remote_url_hash {
                transaction.execute(
                    "UPDATE repo SET sort_order = ?1 WHERE id = ?2",
                    (sort_order, repo.id),
                )?;
                if let Some(remote_url_hash) = local_remote_url_hash
                    .as_deref()
                    .filter(|hash| !hash.is_empty())
                    .or_else(|| repo.remote_url_hash.filter(|hash| !hash.is_empty()))
                {
                    upsert_repo_sidebar_order(&transaction, remote_url_hash, sort_order)?;
                }
                result.updated_ids.push(repo.id.to_string());
                continue;
            }

            if let Some(remote_url_hash) = repo.remote_url_hash.filter(|hash| !hash.is_empty()) {
                upsert_repo_sidebar_order(&transaction, remote_url_hash, sort_order)?;
                result.updated_ids.push(repo.id.to_string());
            } else {
                result.not_persisted_ids.push(repo.id.to_string());
            }
        }

        transaction.commit()?;
        Ok(result)
    }
}

fn upsert_repo_sidebar_order(
    transaction: &rusqlite::Transaction<'_>,
    remote_url_hash: &str,
    sort_order: i64,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO repo_sidebar_order (remote_url_hash, sort_order)
         VALUES (?1, ?2)
         ON CONFLICT(remote_url_hash) DO UPDATE SET sort_order = excluded.sort_order",
        (remote_url_hash, sort_order),
    )?;
    Ok(())
}
