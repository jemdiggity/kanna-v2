use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TransferIdentityRecord {
    pub peer_id: String,
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedTransferIdentity {
    pub peer_id: String,
    pub display_name: String,
}

pub(crate) fn resolve_transfer_root_with_override(
    app_data_dir: &Path,
    override_root: Option<&Path>,
) -> PathBuf {
    override_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_data_dir.join("transfer"))
}

pub(crate) fn resolve_transfer_identity_for_root(
    transfer_root: &Path,
    machine_name: Option<&str>,
) -> Result<ResolvedTransferIdentity, String> {
    let identity = load_or_create_transfer_identity_for_root(transfer_root)?;
    Ok(ResolvedTransferIdentity {
        peer_id: identity.peer_id.clone(),
        display_name: resolve_transfer_display_name(&identity, machine_name),
    })
}

pub(crate) fn load_or_create_transfer_identity_for_root(
    transfer_root: &Path,
) -> Result<TransferIdentityRecord, String> {
    let path = transfer_identity_path_for_root(transfer_root);
    load_or_create_transfer_identity_at_path(&path)
}

fn load_or_create_transfer_identity_at_path(path: &Path) -> Result<TransferIdentityRecord, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            serde_json::from_str::<TransferIdentityRecord>(&contents).map_err(|error| {
                format!(
                    "failed to parse transfer identity '{}': {}",
                    path.display(),
                    error
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let identity = TransferIdentityRecord {
                peer_id: generate_peer_id(),
                nickname: None,
            };
            write_transfer_identity(path, &identity)?;
            Ok(identity)
        }
        Err(error) => Err(format!(
            "failed to read transfer identity '{}': {}",
            path.display(),
            error
        )),
    }
}

pub(crate) fn resolve_transfer_root(app_data_dir: &Path) -> PathBuf {
    let override_root = std::env::var("KANNA_TRANSFER_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    resolve_transfer_root_with_override(app_data_dir, override_root.as_deref())
}

pub(crate) fn transfer_identity_path_for_root(transfer_root: &Path) -> PathBuf {
    transfer_root.join("identity.json")
}

pub(crate) fn resolve_transfer_display_name(
    identity: &TransferIdentityRecord,
    machine_name: Option<&str>,
) -> String {
    identity
        .nickname
        .as_deref()
        .and_then(trimmed_nonempty)
        .or_else(|| machine_name.and_then(trimmed_nonempty))
        .unwrap_or("Kanna")
        .to_string()
}

pub(crate) fn current_machine_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_output("scutil", &["--get", "ComputerName"]) {
        return Some(name);
    }

    command_output("hostname", &[])
        .or_else(|| {
            std::env::var("HOSTNAME")
                .ok()
                .and_then(|value| trimmed_nonempty(&value).map(str::to_string))
        })
        .or_else(|| {
            std::env::var("COMPUTERNAME")
                .ok()
                .and_then(|value| trimmed_nonempty(&value).map(str::to_string))
        })
}

fn write_transfer_identity(path: &Path, identity: &TransferIdentityRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create transfer identity directory '{}': {}",
                parent.display(),
                error
            )
        })?;
    }
    let payload = serde_json::to_vec_pretty(identity)
        .map_err(|error| format!("failed to serialize transfer identity: {}", error))?;
    std::fs::write(path, payload).map_err(|error| {
        format!(
            "failed to write transfer identity '{}': {}",
            path.display(),
            error
        )
    })
}

fn generate_peer_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("peer-{}-{:x}", std::process::id(), nanos)
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    trimmed_nonempty(&stdout).map(str::to_string)
}

fn trimmed_nonempty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "kanna-transfer-identity-test-{}-{}",
                std::process::id(),
                nanos
            ));
            std::fs::create_dir_all(&path).expect("temp dir should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn loads_existing_transfer_identity_from_app_data() {
        let temp = TestTempDir::new();
        let transfer_root = resolve_transfer_root_with_override(temp.path(), None);
        let path = transfer_identity_path_for_root(&transfer_root);
        std::fs::create_dir_all(path.parent().expect("identity path should have parent"))
            .expect("identity directory should be created");
        std::fs::write(
            &path,
            r#"{
  "peer_id": "peer-stable",
  "nickname": "Desk"
}"#,
        )
        .expect("identity record should be written");

        let identity = load_or_create_transfer_identity_for_root(&transfer_root)
            .expect("existing transfer identity should load");

        assert_eq!(identity.peer_id, "peer-stable");
        assert_eq!(identity.nickname.as_deref(), Some("Desk"));
    }

    #[test]
    fn loads_existing_transfer_identity_from_explicit_root() {
        let temp = TestTempDir::new();
        let transfer_root = temp.path().join("explicit-transfer-root");
        let path = transfer_identity_path_for_root(&transfer_root);
        std::fs::create_dir_all(path.parent().expect("identity path should have parent"))
            .expect("identity directory should be created");
        std::fs::write(
            &path,
            r#"{
  "peer_id": "peer-stable",
  "nickname": "Desk"
}"#,
        )
        .expect("identity record should be written");

        let identity = load_or_create_transfer_identity_for_root(&transfer_root)
            .expect("existing transfer identity should load");

        assert_eq!(identity.peer_id, "peer-stable");
        assert_eq!(identity.nickname.as_deref(), Some("Desk"));
    }

    #[test]
    fn creates_and_persists_transfer_identity_when_missing() {
        let temp = TestTempDir::new();
        let transfer_root = resolve_transfer_root(temp.path());

        let identity = load_or_create_transfer_identity_for_root(&transfer_root)
            .expect("missing transfer identity should be created");

        assert!(!identity.peer_id.is_empty());
        assert!(transfer_identity_path_for_root(&transfer_root).exists());
    }

    #[test]
    fn creates_and_persists_transfer_identity_under_explicit_root() {
        let temp = TestTempDir::new();
        let transfer_root = temp.path().join("explicit-transfer-root");

        let identity = load_or_create_transfer_identity_for_root(&transfer_root)
            .expect("missing transfer identity should be created");

        assert!(!identity.peer_id.is_empty());
        assert!(transfer_identity_path_for_root(&transfer_root).exists());
        assert!(!temp.path().join("transfer").join("identity.json").exists());
    }

    #[test]
    fn resolves_display_name_from_nickname_before_machine_name() {
        let identity = TransferIdentityRecord {
            peer_id: "peer-stable".into(),
            nickname: Some("Desk".into()),
        };

        let display_name = resolve_transfer_display_name(&identity, Some("Jeremy's MacBook Pro"));

        assert_eq!(display_name, "Desk");
    }

    #[test]
    fn resolves_display_name_from_machine_name_when_nickname_missing() {
        let identity = TransferIdentityRecord {
            peer_id: "peer-stable".into(),
            nickname: None,
        };

        let display_name = resolve_transfer_display_name(&identity, Some("Jeremy's MacBook Pro"));

        assert_eq!(display_name, "Jeremy's MacBook Pro");
    }

    #[test]
    fn falls_back_to_kanna_when_no_machine_name_is_available() {
        let identity = TransferIdentityRecord {
            peer_id: "peer-stable".into(),
            nickname: None,
        };

        let display_name = resolve_transfer_display_name(&identity, None);

        assert_eq!(display_name, "Kanna");
    }
}
