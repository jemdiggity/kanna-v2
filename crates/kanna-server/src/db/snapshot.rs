use super::{
    Db, SnapshotBlockerTaskState, SnapshotEntry, SnapshotPipelineItem, SnapshotRepo,
    SnapshotTaskBlocker, UiSnapshot,
};
use std::collections::HashMap;

impl Db {
    pub fn ui_snapshot(&self) -> Result<UiSnapshot, rusqlite::Error> {
        let transaction = self.conn.unchecked_transaction()?;
        let repos = self.list_snapshot_repos()?;
        let mut entries = Vec::with_capacity(repos.len());
        for repo in repos {
            let items = self.list_snapshot_pipeline_items(&repo.id)?;
            entries.push(SnapshotEntry { repo, items });
        }

        let snapshot = UiSnapshot {
            entries,
            repo_sidebar_order: self.list_repo_sidebar_order()?,
            task_blockers: self.list_snapshot_task_blockers()?,
            blocker_task_states: self.list_snapshot_blocker_task_states()?,
            worktree_paths: self.list_snapshot_worktree_paths()?,
            settings: self.list_snapshot_settings()?,
        };
        transaction.commit()?;
        Ok(snapshot)
    }

    fn list_snapshot_repos(&self) -> Result<Vec<SnapshotRepo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT repo.id, repo.path, repo.name, repo.default_branch, repo.remote_url,
                    repo.remote_url_hash, repo.hidden,
                    COALESCE(repo_sidebar_order.sort_order, repo.sort_order) AS sidebar_sort_order,
                    repo.created_at, repo.last_opened_at
             FROM repo
             LEFT JOIN repo_sidebar_order
               ON repo_sidebar_order.remote_url_hash = repo.remote_url_hash
             WHERE repo.hidden = 0
             ORDER BY sidebar_sort_order ASC, repo.created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
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
        rows.collect()
    }

    fn list_repo_sidebar_order(&self) -> Result<HashMap<String, i64>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT remote_url_hash, sort_order FROM repo_sidebar_order ORDER BY sort_order ASC",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    fn list_snapshot_pipeline_items(
        &self,
        repo_id: &str,
    ) -> Result<Vec<SnapshotPipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT pipeline_item.id, pipeline_item.repo_id, pipeline_item.issue_number,
                    pipeline_item.issue_title, pipeline_item.prompt, pipeline_item.pipeline,
                    pipeline_item.pipeline_def, pipeline_item.stage, pipeline_item.pr_number,
                    pipeline_item.pr_url, pipeline_item.branch, pipeline_item.closed_at,
                    pipeline_item.agent_type,
                    COALESCE(
                      (
                        SELECT stage_run.agent_provider
                        FROM stage_run
                        WHERE stage_run.task_id = pipeline_item.id
                          AND stage_run.agent_provider IS NOT NULL
                        ORDER BY stage_run.rowid DESC
                        LIMIT 1
                      ),
                      pipeline_item.agent_provider
                    ) AS agent_provider,
                    pipeline_item.activity, pipeline_item.activity_changed_at,
                    pipeline_item.unread_at, pipeline_item.port_offset,
                    pipeline_item.display_name, pipeline_item.last_output_preview,
                    pipeline_item.port_env, pipeline_item.agent_spawn_options,
                    COALESCE(pipeline_item.pinned, 0) AS pinned, pipeline_item.pin_order,
                    pipeline_item.base_ref, pipeline_item.agent_session_id,
                    pipeline_item.teardown_started_at, pipeline_item.parent_task_id,
                    pipeline_item.notify_task_id, pipeline_item.notified_at,
                    pipeline_item.created_at, pipeline_item.updated_at,
                    EXISTS (
                      SELECT 1 FROM stage_run
                      WHERE stage_run.task_id = pipeline_item.id
                        AND stage_run.kind = 'post'
                        AND stage_run.status = 'running'
                    ) AS has_running_post,
                    (
                      SELECT COUNT(*) FROM queued_task_input
                      WHERE queued_task_input.task_id = pipeline_item.id
                    ) AS queued_input_count,
                    (
                      SELECT CASE queued_task_input.state
                        WHEN 'held' THEN 'input_held_by_draft'
                        WHEN 'uncertain' THEN 'delivery_uncertain'
                        ELSE 'sending'
                      END
                      FROM queued_task_input
                      WHERE queued_task_input.task_id = pipeline_item.id
                      ORDER BY queued_task_input.id
                      LIMIT 1
                    ) AS queued_input_reason,
                    pipeline_item.activity_revision,
                    pipeline_item.blocker_revision,
                    (
                      SELECT stage_run.id
                      FROM stage_run
                      WHERE stage_run.task_id = pipeline_item.id
                      ORDER BY stage_run.rowid DESC
                      LIMIT 1
                    ) AS transition_revision,
                    COALESCE(pipeline_item.cloud_task_id, pipeline_item.id) AS cloud_task_id,
                    task_transfer.id,
                    task_transfer.direction,
                    task_transfer.status,
                    task_transfer.source_peer_id,
                    task_transfer.target_peer_id,
                    task_transfer.source_desktop_id,
                    task_transfer.target_desktop_id,
                    task_transfer.error
             FROM pipeline_item
             LEFT JOIN task_transfer ON task_transfer.id = (
               SELECT candidate.id
               FROM task_transfer candidate
               WHERE candidate.local_task_id = pipeline_item.id
                 AND (
                   (
                     candidate.direction = 'outgoing'
                     AND candidate.status IN ('pending', 'streaming', 'failed')
                   )
                   OR (
                     candidate.direction = 'incoming'
                     AND candidate.status IN (
                       'pending',
                       'claimed',
                       'streaming',
                       'importing',
                       'awaiting_acknowledgment',
                       'failed'
                     )
                   )
                 )
               -- A failed transfer is reported so the UI can show that the move
               -- broke, but it never outranks a live one: a retry already in
               -- flight is the current truth about the task. Terminal
               -- 'completed'/'rejected' stay unreported — there is nothing left
               -- to say about them.
               ORDER BY (candidate.status = 'failed') ASC,
                        datetime(COALESCE(candidate.completed_at, candidate.started_at)) DESC,
                        candidate.rowid DESC
               LIMIT 1
             )
             WHERE pipeline_item.repo_id = ? AND pipeline_item.closed_at IS NULL
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(SnapshotPipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                pipeline: row.get(5)?,
                pipeline_def: row.get(6)?,
                stage: row.get(7)?,
                pr_number: row.get(8)?,
                pr_url: row.get(9)?,
                branch: row.get(10)?,
                closed_at: row.get(11)?,
                agent_type: row.get(12)?,
                agent_provider: row.get(13)?,
                activity: row.get(14)?,
                activity_changed_at: row.get(15)?,
                unread_at: row.get(16)?,
                port_offset: row.get(17)?,
                display_name: row.get(18)?,
                last_output_preview: row.get(19)?,
                port_env: row.get(20)?,
                agent_spawn_options: row.get(21)?,
                pinned: row.get(22)?,
                pin_order: row.get(23)?,
                base_ref: row.get(24)?,
                agent_session_id: row.get(25)?,
                teardown_started_at: row.get(26)?,
                parent_task_id: row.get(27)?,
                notify_task_id: row.get(28)?,
                notified_at: row.get(29)?,
                created_at: row.get(30)?,
                updated_at: row.get(31)?,
                has_running_post: row.get(32)?,
                queued_input_count: row.get(33)?,
                queued_input_reason: row.get(34)?,
                activity_revision: row.get(35)?,
                blocker_revision: row.get(36)?,
                transition_revision: row.get(37)?,
                cloud_task_id: row.get(38)?,
                transfer_id: row.get(39)?,
                transfer_direction: row.get(40)?,
                transfer_status: row.get(41)?,
                transfer_source_peer_id: row.get(42)?,
                transfer_target_peer_id: row.get(43)?,
                transfer_source_desktop_id: row.get(44)?,
                transfer_target_desktop_id: row.get(45)?,
                transfer_error: row.get(46)?,
            })
        })?;
        rows.collect()
    }

    fn list_snapshot_task_blockers(&self) -> Result<Vec<SnapshotTaskBlocker>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT blocked_item_id, blocker_item_id
             FROM task_blocker
             ORDER BY blocked_item_id, blocker_item_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SnapshotTaskBlocker {
                blocked_item_id: row.get(0)?,
                blocker_item_id: row.get(1)?,
            })
        })?;
        rows.collect()
    }

    fn list_snapshot_blocker_task_states(
        &self,
    ) -> Result<HashMap<String, SnapshotBlockerTaskState>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT blocker_item.id, blocker_item.closed_at,
                    blocker_item.stage, blocker_item.pr_url
             FROM task_blocker
             JOIN pipeline_item blocker_item ON blocker_item.id = task_blocker.blocker_item_id
             ORDER BY blocker_item.id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SnapshotBlockerTaskState {
                    closed_at: row.get(1)?,
                    stage: row.get(2)?,
                    pr_url: row.get(3)?,
                },
            ))
        })?;
        rows.collect()
    }

    fn list_snapshot_worktree_paths(&self) -> Result<HashMap<String, String>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT worktree.pipeline_item_id, worktree.path
             FROM worktree
             JOIN pipeline_item ON pipeline_item.id = worktree.pipeline_item_id
             WHERE pipeline_item.closed_at IS NULL
             ORDER BY worktree.created_at DESC, worktree.id DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let pipeline_item_id: String = row.get(0)?;
            let path: String = row.get(1)?;
            Ok((pipeline_item_id, path))
        })?;

        let mut paths = HashMap::new();
        for row in rows {
            let (pipeline_item_id, path) = row?;
            if std::path::Path::new(&path).exists() {
                paths.entry(pipeline_item_id).or_insert(path);
            }
        }
        Ok(paths)
    }

    fn list_snapshot_settings(&self) -> Result<HashMap<String, String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
        let rows = stmt.query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })?;

        let mut settings = HashMap::new();
        for row in rows {
            let (key, value) = row?;
            settings.insert(key, value);
        }
        Ok(settings)
    }
}
