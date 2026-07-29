use std::path::{Path, PathBuf};

use crate::protocol::RecoverySnapshot;

#[derive(Clone)]
pub struct SnapshotStore {
    root: PathBuf,
}

impl SnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn cleanup_stale_temp_files(&self) -> Result<(), String> {
        self.remove_stale_temp_files()
    }

    pub fn spawn_stale_temp_cleanup(&self) {
        let store = self.clone();
        std::thread::spawn(move || {
            let _ = store.cleanup_stale_temp_files();
        });
    }

    pub fn write(&self, snapshot: &RecoverySnapshot) -> Result<(), String> {
        let file_path = self.file_path(&snapshot.session_id)?;
        let temp_path =
            file_path.with_extension(format!("json.tmp-{}-{}", std::process::id(), now_millis()));
        std::fs::create_dir_all(file_path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|error| format!("failed to create snapshot dir {:?}: {}", self.root, error))?;
        let payload = serde_json::to_vec(snapshot).map_err(|error| {
            format!(
                "failed to serialize snapshot {}: {}",
                snapshot.session_id, error
            )
        })?;
        if let Err(error) = std::fs::write(&temp_path, payload) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!(
                "failed to write snapshot {:?}: {}",
                temp_path, error
            ));
        }
        if let Err(error) = std::fs::rename(&temp_path, &file_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!(
                "failed to publish snapshot {:?}: {}",
                file_path, error
            ));
        }
        Ok(())
    }

    pub fn read(&self, session_id: &str) -> Result<Option<RecoverySnapshot>, String> {
        let path = self.file_path(session_id)?;
        if !path.exists() {
            return Ok(None);
        }

        self.require(session_id).map(Some)
    }

    pub fn require(&self, session_id: &str) -> Result<RecoverySnapshot, String> {
        let path = self.file_path(session_id)?;
        let contents = std::fs::read_to_string(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "missing persisted snapshot for resumed session: {}",
                    session_id
                )
            } else {
                format!(
                    "invalid persisted snapshot for resumed session: {}",
                    session_id
                )
            }
        })?;
        let snapshot: RecoverySnapshot = serde_json::from_str(&contents).map_err(|_| {
            format!(
                "invalid persisted snapshot for resumed session: {}",
                session_id
            )
        })?;
        if snapshot.session_id != session_id {
            return Err(format!(
                "snapshot file {:?} contained mismatched session id {}",
                path, snapshot.session_id
            ));
        }
        Ok(snapshot)
    }

    pub fn remove(&self, session_id: &str) -> Result<(), String> {
        let path = self.file_path(session_id)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to remove snapshot {:?}: {}", path, error)),
        }
    }

    /// Path of a session's snapshot, refusing an id that would escape `root`.
    ///
    /// The worker is a SEPARATE PROCESS: `session_id` arrives over its NDJSON
    /// protocol, so it is untrusted input here regardless of what the daemon does
    /// with it. `Path::join` REPLACES its base given an absolute-looking id and `..`
    /// walks out, so an unchecked id is an arbitrary-file read on load and an
    /// arbitrary-file write on persist. The check is shared with the daemon via
    /// `kanna_runtime_defaults::session_id` so the two processes cannot disagree
    /// about what "safe" means.
    fn file_path(&self, session_id: &str) -> Result<PathBuf, String> {
        if !kanna_runtime_defaults::session_id::is_safe(session_id) {
            return Err(format!(
                "refusing to derive a snapshot path from unsafe session id {session_id:?}"
            ));
        }
        Ok(self.root.join(format!("{}.json", session_id)))
    }

    fn remove_stale_temp_files(&self) -> Result<(), String> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "failed to scan recovery snapshot dir {:?}: {}",
                    self.root, error
                ));
            }
        };

        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "failed to read recovery snapshot dir {:?}: {}",
                    self.root, error
                )
            })?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_snapshot_temp_file(name) {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "failed to inspect recovery temp file {:?}: {}",
                    entry.path(),
                    error
                )
            })?;
            if !file_type.is_file() {
                continue;
            }
            std::fs::remove_file(entry.path()).map_err(|error| {
                format!(
                    "failed to remove recovery temp file {:?}: {}",
                    entry.path(),
                    error
                )
            })?;
        }

        Ok(())
    }
}

fn is_snapshot_temp_file(name: &str) -> bool {
    let Some((_, timestamp)) = name.rsplit_once(".json.tmp-") else {
        return false;
    };
    timestamp
        .rsplit_once('-')
        .and_then(|(_, millis)| millis.parse::<u64>().ok())
        .is_some_and(|millis| now_millis().saturating_sub(millis) >= stale_temp_file_age_ms())
}

fn stale_temp_file_age_ms() -> u64 {
    10 * 60 * 1_000
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod legacy_compat_tests {
    use super::*;

    /// The exact JSON v0.0.30 wrote: no cursor fields at all.
    const V0_0_30_SNAPSHOT: &str = r#"{"sessionId":"legacy-v0030","serialized":"LEGACY_SCROLLBACK\r\n","cols":80,"rows":24,"savedAt":1700000000000,"sequence":7}"#;

    /// The worker's loader must accept a released v0.0.30 snapshot and report its
    /// cursor as UNKNOWN, not (0, 0): `SessionMirror::restore` emits an explicit
    /// reposition, so defaulting to 0 would yank an upgraded cursor to top-left.
    #[test]
    fn a_v0_0_30_snapshot_loads_with_an_unknown_cursor() {
        let dir = std::env::temp_dir().join(format!(
            "kanna-legacy-snap-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("legacy-v0030.json"), V0_0_30_SNAPSHOT).expect("fixture");

        // Self-validating guard: prove the fixture is one the PRE-FIX shape
        // rejects, or this test could pass for the wrong reason. `Option<T>` is
        // implicitly optional in serde, so deleting the `#[serde(default)]`
        // attributes is a no-op — the mechanism is the TYPE, and a type-level
        // mutation does not compile. This assertion is the mutation check.
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        struct RequiredCursorShape {
            session_id: String,
            serialized: String,
            cols: u16,
            rows: u16,
            cursor_row: u16,
            cursor_col: u16,
            cursor_visible: bool,
            saved_at: u64,
            sequence: u64,
        }
        assert!(
            serde_json::from_str::<RequiredCursorShape>(V0_0_30_SNAPSHOT).is_err(),
            "fixture must be rejected by the old required-cursor shape, else this test \
             proves nothing about v0.0.30 compatibility"
        );

        let store = SnapshotStore::new(dir.clone());
        let snapshot = store
            .require("legacy-v0030")
            .expect("a released v0.0.30 snapshot must still load");
        assert_eq!(snapshot.serialized, "LEGACY_SCROLLBACK\r\n");
        assert!(
            snapshot.cursor_row.is_none()
                && snapshot.cursor_col.is_none()
                && snapshot.cursor_visible.is_none(),
            "absent cursor state must stay unknown, not default to the origin"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod session_id_boundary_tests {
    use super::*;

    /// The WORKER must refuse a traversing session id on its own.
    ///
    /// It is a separate process: ids arrive over its NDJSON protocol, so relying on
    /// the daemon to have validated them would leave this process one bug away from
    /// an arbitrary-file read on load and an arbitrary-file write on persist.
    #[test]
    fn a_traversing_session_id_cannot_escape_the_snapshot_root() {
        let root = std::env::temp_dir().join(format!(
            "kanna-wkr-escape-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&root).expect("root");
        let outside = root.parent().expect("parent").join("kanna-wkr-canary.json");
        std::fs::write(&outside, b"SECRET").expect("plant canary");

        let store = SnapshotStore::new(root.clone());
        for hostile in [
            "../kanna-wkr-canary",
            "/etc/passwd",
            "..",
            "Upper",
            "caf\u{e9}",
        ] {
            let snapshot = RecoverySnapshot {
                session_id: hostile.to_string(),
                serialized: "OVERWRITE".to_string(),
                cols: 80,
                rows: 24,
                cursor_row: Some(0),
                cursor_col: Some(0),
                cursor_visible: Some(true),
                saved_at: 0,
                sequence: 0,
            };
            assert!(
                store.write(&snapshot).is_err(),
                "id {hostile:?} must be refused on write"
            );
            assert!(
                store.read(hostile).is_err(),
                "id {hostile:?} must be refused on read"
            );
            assert!(
                store.require(hostile).is_err(),
                "id {hostile:?} must be refused on require"
            );
            assert!(
                store.remove(hostile).is_err(),
                "id {hostile:?} must be refused on remove"
            );
        }

        assert_eq!(
            std::fs::read(&outside).expect("canary readable"),
            b"SECRET".to_vec(),
            "the file outside the snapshot root was read or modified"
        );

        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }
}
