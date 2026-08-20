use super::Db;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashSet;
use std::fmt;

#[derive(Debug)]
pub enum ReplaceTaskBlockersError {
    Database(rusqlite::Error),
    TaskNotFound(String),
    BlockerNotFound(String),
    SelfDependency,
    CircularDependency,
}

impl fmt::Display for ReplaceTaskBlockersError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "{error}"),
            Self::TaskNotFound(task_id) => write!(formatter, "task not found: {task_id}"),
            Self::BlockerNotFound(task_id) => write!(formatter, "task not found: {task_id}"),
            Self::SelfDependency => write!(formatter, "task cannot block itself"),
            Self::CircularDependency => {
                write!(
                    formatter,
                    "cannot add blocker because it would create a circular dependency"
                )
            }
        }
    }
}

impl std::error::Error for ReplaceTaskBlockersError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for ReplaceTaskBlockersError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

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

    /// Resolve, validate, and replace an existing task's full blocker set in
    /// one serialized transaction. `BEGIN IMMEDIATE` makes cycle checks
    /// authoritative against every blocker writer that committed first.
    pub fn replace_task_blockers_atomically(
        &self,
        task_or_branch_id: &str,
        blocker_task_ids: &[String],
    ) -> Result<String, ReplaceTaskBlockersError> {
        self.replace_task_blockers_atomically_impl(task_or_branch_id, blocker_task_ids, || {})
    }

    #[cfg(test)]
    pub(crate) fn replace_task_blockers_atomically_with_hook(
        &self,
        task_or_branch_id: &str,
        blocker_task_ids: &[String],
        after_delete: impl FnOnce(),
    ) -> Result<String, ReplaceTaskBlockersError> {
        self.replace_task_blockers_atomically_impl(
            task_or_branch_id,
            blocker_task_ids,
            after_delete,
        )
    }

    fn replace_task_blockers_atomically_impl(
        &self,
        task_or_branch_id: &str,
        blocker_task_ids: &[String],
        after_delete: impl FnOnce(),
    ) -> Result<String, ReplaceTaskBlockersError> {
        let transaction = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let task_id = resolve_pipeline_item_id(&transaction, task_or_branch_id)?
            .ok_or_else(|| ReplaceTaskBlockersError::TaskNotFound(task_or_branch_id.to_string()))?;

        let mut resolved_blocker_ids = Vec::new();
        for blocker_task_id in blocker_task_ids {
            let blocker_id =
                resolve_pipeline_item_id(&transaction, blocker_task_id)?.ok_or_else(|| {
                    ReplaceTaskBlockersError::BlockerNotFound(blocker_task_id.to_string())
                })?;
            if blocker_id == task_id {
                return Err(ReplaceTaskBlockersError::SelfDependency);
            }
            if !resolved_blocker_ids.contains(&blocker_id) {
                resolved_blocker_ids.push(blocker_id);
            }
        }
        for blocker_id in &resolved_blocker_ids {
            if dependency_has_path_to(&transaction, blocker_id, &task_id)? {
                return Err(ReplaceTaskBlockersError::CircularDependency);
            }
        }

        transaction.execute(
            "DELETE FROM task_blocker WHERE blocked_item_id = ?",
            [&task_id],
        )?;
        after_delete();
        for blocker_id in &resolved_blocker_ids {
            transaction.execute(
                "INSERT OR IGNORE INTO task_blocker (blocked_item_id, blocker_item_id)
                 VALUES (?, ?)",
                (&task_id, blocker_id),
            )?;
        }
        transaction.execute(
            "UPDATE pipeline_item
             SET activity = 'idle', activity_changed_at = datetime('now'),
                 activity_revision = activity_revision + 1,
                 activity_event_baseline = COALESCE(activity_event_baseline, activity),
                 activity_event_pending_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE id = ? AND activity != 'idle' AND closed_at IS NULL",
            [&task_id],
        )?;
        transaction.commit()?;
        Ok(task_id)
    }

    pub fn list_task_blocker_ids(
        &self,
        blocked_item_id: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT blocker_item_id FROM task_blocker WHERE blocked_item_id = ? ORDER BY blocker_item_id",
            )?;
        let rows = stmt.query_map([blocked_item_id], |row| row.get(0))?;
        rows.collect()
    }

    /// Count blockers that are still unresolved. A blocker resolves
    /// optimistically: either it closed, or it is parked at the `pr` stage
    /// with a PR created (work committed, reviewed, rebased, renamed, and
    /// pushed — stable enough for dependents to stack on without waiting
    /// for the human review/merge loop). Dependents started at that point
    /// inherit same-repo blocker branches before falling back to their
    /// normal base. Keep this predicate in sync with `isBlockerResolved`
    /// in packages/db/src/queries.ts.
    pub fn count_open_task_blockers(&self, blocked_item_id: &str) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*)
             FROM task_blocker blocker
             JOIN pipeline_item blocker_item ON blocker_item.id = blocker.blocker_item_id
             WHERE blocker.blocked_item_id = ?
               AND blocker_item.closed_at IS NULL
               AND NOT (blocker_item.stage = 'pr' AND blocker_item.pr_url IS NOT NULL)",
            [blocked_item_id],
            |row| row.get(0),
        )
    }

    /// Ids of blockers that are still unresolved, for surfacing why a task
    /// is blocked. Keep the resolution predicate in sync with
    /// `count_open_task_blockers` above.
    pub fn list_open_task_blocker_ids(
        &self,
        blocked_item_id: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT blocker.blocker_item_id
             FROM task_blocker blocker
             JOIN pipeline_item blocker_item ON blocker_item.id = blocker.blocker_item_id
             WHERE blocker.blocked_item_id = ?
               AND blocker_item.closed_at IS NULL
               AND NOT (blocker_item.stage = 'pr' AND blocker_item.pr_url IS NOT NULL)
             ORDER BY blocker.blocker_item_id",
        )?;
        let rows = stmt.query_map([blocked_item_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn list_tasks_blocked_by(
        &self,
        blocker_item_id: &str,
    ) -> Result<Vec<String>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT blocked_item_id FROM task_blocker WHERE blocker_item_id = ? ORDER BY blocked_item_id",
        )?;
        let rows = stmt.query_map([blocker_item_id], |row| row.get(0))?;
        rows.collect()
    }
}

fn resolve_pipeline_item_id(
    connection: &Connection,
    task_or_branch_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let exact = connection
        .query_row(
            "SELECT id FROM pipeline_item WHERE id = ?",
            [task_or_branch_id],
            |row| row.get(0),
        )
        .optional()?;
    if exact.is_some() {
        return Ok(exact);
    }
    connection
        .query_row(
            "SELECT id FROM pipeline_item WHERE branch = ?",
            [task_or_branch_id],
            |row| row.get(0),
        )
        .optional()
}

fn dependency_has_path_to(
    connection: &Connection,
    from_blocked_item_id: &str,
    target_item_id: &str,
) -> Result<bool, rusqlite::Error> {
    fn visit(
        connection: &Connection,
        current_id: &str,
        target_id: &str,
        visited: &mut HashSet<String>,
    ) -> Result<bool, rusqlite::Error> {
        if current_id == target_id {
            return Ok(true);
        }
        if !visited.insert(current_id.to_string()) {
            return Ok(false);
        }
        let mut statement = connection.prepare(
            "SELECT blocker_item_id
             FROM task_blocker
             WHERE blocked_item_id = ?
             ORDER BY blocker_item_id",
        )?;
        let blockers = statement
            .query_map([current_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for blocker_id in blockers {
            if visit(connection, &blocker_id, target_id, visited)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    visit(
        connection,
        from_blocked_item_id,
        target_item_id,
        &mut HashSet::new(),
    )
}
