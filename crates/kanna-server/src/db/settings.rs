use super::Db;
use base64::Engine;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;

impl Db {
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
                row.get(0)
            })
            .optional()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?", [key])?;
        Ok(())
    }

    pub fn select_raw(&self, query: &str, bind_values: &[Value]) -> Result<Value, rusqlite::Error> {
        // SECURITY: reject non-SELECT queries
        let trimmed = query.trim_start().to_uppercase();
        if !trimmed.starts_with("SELECT") {
            return Err(rusqlite::Error::InvalidParameterName(
                "Only SELECT queries are allowed".to_string(),
            ));
        }

        let params: Vec<rusqlite::types::Value> =
            bind_values.iter().map(json_to_sqlite_value).collect();

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
        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rusqlite::types::ValueRef::Text(t) => {
            Value::String(String::from_utf8_lossy(t).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            Value::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}
