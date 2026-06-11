use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopIdentity {
    pub desktop_id: String,
    pub desktop_secret: String,
}

pub fn identity_path_for_daemon_dir(daemon_dir: &str) -> PathBuf {
    Path::new(daemon_dir).join("desktop-identity.json")
}

pub fn save_identity(path: &Path, identity: &DesktopIdentity) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let body = serde_json::to_string_pretty(identity).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

pub fn load_identity(path: &Path) -> Result<Option<DesktopIdentity>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let body = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read desktop identity {}: {}", path.display(), e))?;
    let identity = serde_json::from_str(&body)
        .map_err(|e| format!("failed to parse desktop identity {}: {}", path.display(), e))?;
    Ok(Some(identity))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_identity_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kanna-desktop-identity-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn save_identity_writes_json_payload() {
        let path = unique_identity_path();
        let identity = super::DesktopIdentity {
            desktop_id: "desktop-1".to_string(),
            desktop_secret: "desktop-secret".to_string(),
        };

        super::save_identity(&path, &identity).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"desktop_id\": \"desktop-1\""));
        assert!(written.contains("\"desktop_secret\": \"desktop-secret\""));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_identity_reads_saved_json_payload() {
        let path = unique_identity_path();
        let identity = super::DesktopIdentity {
            desktop_id: "desktop-1".to_string(),
            desktop_secret: "desktop-secret".to_string(),
        };
        super::save_identity(&path, &identity).unwrap();

        assert_eq!(super::load_identity(&path).unwrap(), Some(identity));

        let _ = std::fs::remove_file(path);
    }
}
