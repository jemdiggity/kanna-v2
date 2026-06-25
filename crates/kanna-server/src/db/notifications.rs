use super::{ClaimedTaskNotification, Db};
use rusqlite::OptionalExtension;

impl Db {
    pub fn claim_task_notification(
        &self,
        child_id: &str,
    ) -> Result<Option<ClaimedTaskNotification>, rusqlite::Error> {
        let notification = self
            .conn
            .query_row(
                "SELECT id, notify_task_id, display_name, issue_title, prompt
                 FROM pipeline_item
                 WHERE id = ? AND notify_task_id IS NOT NULL AND notify_task_id != '' AND notified_at IS NULL",
                [child_id],
                |row| {
                    let child_id: String = row.get(0)?;
                    let notify_task_id: String = row.get(1)?;
                    let display_name: Option<String> = row.get(2)?;
                    let issue_title: Option<String> = row.get(3)?;
                    let prompt: Option<String> = row.get(4)?;
                    let title = display_name
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| issue_title.filter(|value| !value.trim().is_empty()))
                        .or_else(|| {
                            prompt
                                .and_then(|value| value.lines().next().map(str::to_string))
                                .filter(|value| !value.trim().is_empty())
                        })
                        .unwrap_or_else(|| child_id.clone());
                    Ok(ClaimedTaskNotification {
                        child_id,
                        notify_task_id,
                        title,
                    })
                },
            )
            .optional()?;
        let Some(notification) = notification else {
            return Ok(None);
        };
        let rows = self.conn.execute(
            "UPDATE pipeline_item SET notified_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND notified_at IS NULL",
            [&notification.child_id],
        )?;
        if rows == 0 {
            return Ok(None);
        }
        Ok(Some(notification))
    }
}
