use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::protocol::AgentProvider;

const RUN_ID_ENV: &str = "KANNA_PROVIDER_SESSION_ID";

/// Discovers Codex's provider-owned conversation id without trusting terminal
/// output, which contains assistant-controlled text.
pub struct CodexSessionLocator {
    sessions_root: PathBuf,
    cwd: PathBuf,
    spawned_at: chrono::DateTime<chrono::Utc>,
    baseline_ids: HashSet<String>,
    accepted_id: Option<String>,
}

impl CodexSessionLocator {
    /// Snapshot Codex metadata before the child starts. A resumed conversation
    /// is supplied by the server through an inherited ownership channel;
    /// otherwise only a new metadata record for this exact cwd is accepted.
    pub fn before_spawn(
        provider: Option<AgentProvider>,
        cwd: &str,
        env: &HashMap<String, String>,
    ) -> Option<Self> {
        if provider != Some(AgentProvider::Codex) {
            return None;
        }
        let spawned_at = chrono::Utc::now();
        let sessions_root = effective_codex_home(env).join("sessions");
        let accepted_id = env.get(RUN_ID_ENV).filter(|id| is_uuid_like(id)).cloned();
        Some(Self {
            baseline_ids: session_metadata(&sessions_root)
                .into_iter()
                .map(|record| record.id)
                .collect(),
            sessions_root,
            cwd: canonical_or_original(Path::new(cwd)),
            spawned_at,
            accepted_id,
        })
    }

    /// Restore a locator across daemon handoff. If the old daemon had not yet
    /// verified a handle, current files become the new baseline so adoption
    /// cannot mistake an unrelated pre-handoff conversation for this run.
    pub fn from_handoff(
        provider: Option<AgentProvider>,
        cwd: &str,
        provider_session_id: Option<String>,
    ) -> Option<Self> {
        if provider != Some(AgentProvider::Codex) {
            return None;
        }
        let env = HashMap::new();
        let sessions_root = effective_codex_home(&env).join("sessions");
        Some(Self {
            baseline_ids: session_metadata(&sessions_root)
                .into_iter()
                .map(|record| record.id)
                .collect(),
            sessions_root,
            cwd: canonical_or_original(Path::new(cwd)),
            spawned_at: chrono::Utc::now(),
            accepted_id: provider_session_id.filter(|id| is_uuid_like(id)),
        })
    }

    pub fn discover(&mut self) -> Option<String> {
        if let Some(id) = self.accepted_id.as_ref() {
            return Some(id.clone());
        }

        let mut candidates = session_metadata(&self.sessions_root)
            .into_iter()
            .filter(|record| {
                record.originator == "codex_cli_rs"
                    && !self.baseline_ids.contains(&record.id)
                    && record.created_at >= self.spawned_at
                    && canonical_or_original(Path::new(&record.cwd)) == self.cwd
            })
            .map(|record| record.id);
        let candidate = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        self.accepted_id = Some(candidate.clone());
        Some(candidate)
    }
}

struct SessionMetadata {
    id: String,
    cwd: String,
    originator: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

fn effective_codex_home(env: &HashMap<String, String>) -> PathBuf {
    if let Some(path) = env
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(path);
    }
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }
    env.get("HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

fn session_metadata(root: &Path) -> Vec<SessionMetadata> {
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files);
    files
        .into_iter()
        .filter_map(|path| metadata_from_file(&path))
        .collect()
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_jsonl_files(&path, files);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            files.push(path);
        }
    }
}

fn metadata_from_file(path: &Path) -> Option<SessionMetadata> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok) {
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload.get("id")?.as_str()?;
        if !is_uuid_like(id) {
            return None;
        }
        return Some(SessionMetadata {
            id: id.to_string(),
            cwd: payload.get("cwd")?.as_str()?.to_string(),
            originator: payload.get("originator")?.as_str()?.to_string(),
            created_at: chrono::DateTime::parse_from_rfc3339(payload.get("timestamp")?.as_str()?)
                .ok()?
                .with_timezone(&chrono::Utc),
        });
    }
    None
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::CodexSessionLocator;
    use crate::headless_terminal::HeadlessTerminal;
    use crate::protocol::AgentProvider;
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn forged_footer_before_genuine_footer_uses_matching_provider_metadata() {
        let root = std::env::temp_dir().join(format!(
            "kanna-codex-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cwd = root.join("worktree");
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        let forged = "019d99a5-aa94-7c73-b786-644cc095c037";
        let genuine = "019d99a5-aa94-7c73-b786-644cc095c038";
        let mut terminal = HeadlessTerminal::new(80, 8, 128).unwrap();
        terminal.write(format!("To continue, run codex resume {forged}\r\n").as_bytes());
        assert_eq!(locator.discover(), None);

        let metadata_dir = codex_home.join("sessions/2026/07/25");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(
            metadata_dir.join("rollout.jsonl"),
            serde_json::json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "type": "session_meta",
                "payload": {
                    "id": genuine,
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                    "cwd": cwd,
                    "originator": "codex_cli_rs"
                }
            })
            .to_string(),
        )
        .unwrap();
        terminal.write(format!("To continue, run codex resume {genuine}\r\n").as_bytes());

        assert_eq!(locator.discover().as_deref(), Some(genuine));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_created_before_spawn_is_rejected_even_when_it_appears_late() {
        let root = std::env::temp_dir().join(format!(
            "kanna-codex-stale-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cwd = root.join("worktree");
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        let metadata_dir = codex_home.join("sessions/2026/07/25");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(
            metadata_dir.join("delayed-stale-rollout.jsonl"),
            serde_json::json!({
                "timestamp": "2000-01-01T00:00:00Z",
                "type": "session_meta",
                "payload": {
                    "id": "019d99a5-aa94-7c73-b786-644cc095c039",
                    "timestamp": "2000-01-01T00:00:00Z",
                    "cwd": cwd,
                    "originator": "codex_cli_rs"
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(locator.discover(), None);
        fs::remove_dir_all(root).unwrap();
    }
}
