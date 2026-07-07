use super::Db;

pub struct NewOperatorEvent<'a> {
    pub event_type: &'a str,
    pub pipeline_item_id: Option<&'a str>,
    pub repo_id: Option<&'a str>,
}

impl Db {
    pub fn insert_operator_events(
        &self,
        events: &[NewOperatorEvent<'_>],
    ) -> Result<usize, rusqlite::Error> {
        let mut inserted = 0;
        for event in events {
            self.conn.execute(
                "INSERT INTO operator_event (event_type, pipeline_item_id, repo_id)
                 VALUES (?, ?, ?)",
                (event.event_type, event.pipeline_item_id, event.repo_id),
            )?;
            inserted += 1;
        }
        Ok(inserted)
    }
}
