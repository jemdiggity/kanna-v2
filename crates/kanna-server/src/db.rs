use base64::Engine;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct PipelineItem {
    pub id: String,
    pub repo_id: String,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub prompt: Option<String>,
    pub stage: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub agent_type: Option<String>,
    pub activity: Option<String>,
    pub activity_changed_at: Option<String>,
    pub pinned: Option<i64>,
    pub pin_order: Option<i64>,
    pub display_name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Repo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self { conn })
    }

    pub fn list_repos(&self) -> Result<Vec<Repo>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, default_branch, hidden, created_at, last_opened_at \
             FROM repo WHERE hidden = 0 OR hidden IS NULL ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                hidden: row.get(4)?,
                created_at: row.get(5)?,
                last_opened_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn list_pipeline_items(&self, repo_id: &str) -> Result<Vec<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, \
             pr_number, pr_url, branch, agent_type, activity, activity_changed_at, \
             pinned, pin_order, display_name, created_at, updated_at \
             FROM pipeline_item WHERE repo_id = ? \
             ORDER BY pin_order ASC, created_at DESC",
        )?;
        let rows = stmt.query_map([repo_id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                activity: row.get(10)?,
                activity_changed_at: row.get(11)?,
                pinned: row.get(12)?,
                pin_order: row.get(13)?,
                display_name: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_pipeline_item(&self, id: &str) -> Result<Option<PipelineItem>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repo_id, issue_number, issue_title, prompt, stage, \
             pr_number, pr_url, branch, agent_type, activity, activity_changed_at, \
             pinned, pin_order, display_name, created_at, updated_at \
             FROM pipeline_item WHERE id = ?",
        )?;
        let mut rows = stmt.query_map([id], |row| {
            Ok(PipelineItem {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                issue_number: row.get(2)?,
                issue_title: row.get(3)?,
                prompt: row.get(4)?,
                stage: row.get(5)?,
                pr_number: row.get(6)?,
                pr_url: row.get(7)?,
                branch: row.get(8)?,
                agent_type: row.get(9)?,
                activity: row.get(10)?,
                activity_changed_at: row.get(11)?,
                pinned: row.get(12)?,
                pin_order: row.get(13)?,
                display_name: row.get(14)?,
                created_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub fn select_raw(
        &self,
        query: &str,
        bind_values: &[Value],
    ) -> Result<Value, rusqlite::Error> {
        // SECURITY: reject non-SELECT queries
        let trimmed = query.trim_start().to_uppercase();
        if !trimmed.starts_with("SELECT") {
            return Err(rusqlite::Error::InvalidParameterName(
                "Only SELECT queries are allowed".to_string(),
            ));
        }

        let params: Vec<rusqlite::types::Value> = bind_values
            .iter()
            .map(json_to_sqlite_value)
            .collect();

        let mut stmt = self.conn.prepare(query)?;
        let column_count = stmt.column_count();
        let column_names: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).unwrap_or("").to_string())
            .collect();

        let rows = stmt.query_map(params_from_iter(params.iter()), |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let value = row.get_ref(i)?;
                let json_val = sqlite_value_to_json(value);
                obj.insert(name.clone(), json_val);
            }
            Ok(Value::Object(obj))
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(Value::Array(result))
    }
}

fn json_to_sqlite_value(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                rusqlite::types::Value::Text(n.to_string())
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => {
            rusqlite::types::Value::Text(serde_json::to_string(v).unwrap_or_default())
        }
    }
}

fn sqlite_value_to_json(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => Value::Number(i.into()),
        rusqlite::types::ValueRef::Real(f) => {
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        rusqlite::types::ValueRef::Text(t) => {
            Value::String(String::from_utf8_lossy(t).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}
