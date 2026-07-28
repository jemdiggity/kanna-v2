use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub session_id: String,
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    /// Cursor state, absent in snapshots written by v0.0.30 and earlier.
    ///
    /// `None` means UNKNOWN, not `(0, 0)`. `SessionMirror::restore` replays
    /// `serialized` and then emits an explicit `ESC[row;colH`; before these fields
    /// existed there was no such escape, so the cursor simply stayed where the
    /// replay left it. A plain `#[serde(default)]` to `0` would therefore be a
    /// behaviour change disguised as compatibility — it would yank every upgraded
    /// session's cursor to the top-left. Absence is modelled so `restore` can skip
    /// repositioning.
    ///
    /// `skip_serializing_if` keeps newly written files byte-identical: a live
    /// mirror always knows its own cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_row: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_col: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_visible: Option<bool>,
    pub saved_at: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum RecoveryCommand {
    StartSession {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "resumeFromDisk")]
        #[serde(default)]
        resume_from_disk: bool,
    },
    WriteOutput {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: Vec<u8>,
        sequence: u64,
    },
    ResizeSession {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    EndSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    GetSnapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    FlushAndShutdown,
}

impl RecoveryCommand {
    pub fn expects_response(&self) -> bool {
        matches!(
            self,
            Self::StartSession { .. } | Self::GetSnapshot { .. } | Self::FlushAndShutdown
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum RecoveryResponse {
    Ok,
    Error {
        message: String,
    },
    Snapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
        serialized: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "cursorRow")]
        cursor_row: u16,
        #[serde(rename = "cursorCol")]
        cursor_col: u16,
        #[serde(rename = "cursorVisible")]
        cursor_visible: bool,
        #[serde(rename = "savedAt")]
        saved_at: u64,
        sequence: u64,
    },
    NotFound,
}

impl RecoveryResponse {
    pub fn from_snapshot(snapshot: RecoverySnapshot) -> Self {
        Self::Snapshot {
            session_id: snapshot.session_id,
            serialized: snapshot.serialized,
            cols: snapshot.cols,
            rows: snapshot.rows,
            // A live mirror always knows its cursor (see `SessionMirror::snapshot`),
            // so these are `Some` in practice; the fallbacks only make the
            // conversion total.
            cursor_row: snapshot.cursor_row.unwrap_or(0),
            cursor_col: snapshot.cursor_col.unwrap_or(0),
            cursor_visible: snapshot.cursor_visible.unwrap_or(true),
            saved_at: snapshot.saved_at,
            sequence: snapshot.sequence,
        }
    }
}

pub fn parse_command(line: &str) -> Result<RecoveryCommand, String> {
    serde_json::from_str(line).map_err(|error| format!("Invalid JSON: {}", error))
}

pub fn format_response(response: &RecoveryResponse) -> Result<String, String> {
    let mut json = serde_json::to_string(response)
        .map_err(|error| format!("failed to serialize response: {}", error))?;
    json.push('\n');
    Ok(json)
}
