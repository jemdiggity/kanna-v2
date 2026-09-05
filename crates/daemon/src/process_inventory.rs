use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind")]
enum InventoryResource {
    #[serde(rename = "process")]
    Process {
        pid: u32,
        label: String,
        identity: String,
    },
    #[serde(rename = "tmux-server")]
    TmuxServer {
        socket: String,
        #[serde(rename = "socketPath", skip_serializing_if = "Option::is_none")]
        socket_path: Option<String>,
    },
}

#[derive(Deserialize, Serialize)]
struct ProcessInventory {
    version: u8,
    resources: Vec<InventoryResource>,
}

#[derive(Clone)]
pub(crate) struct ProcessInventoryRecord {
    path: PathBuf,
    pid: u32,
    label: String,
    identity: String,
}

pub(crate) fn record_process(
    path: &Path,
    pid: u32,
    label: &str,
) -> Result<ProcessInventoryRecord, String> {
    let identity = process_identity(pid)
        .ok_or_else(|| format!("could not establish spawn identity for {label} pid {pid}"))?;
    let record = ProcessInventoryRecord {
        path: path.to_path_buf(),
        pid,
        label: label.to_string(),
        identity,
    };
    mutate_inventory(path, |resources| {
        resources.retain(|resource| {
            !matches!(resource, InventoryResource::Process { pid: existing, .. } if *existing == pid)
        });
        resources.push(InventoryResource::Process {
            pid: record.pid,
            label: record.label.clone(),
            identity: record.identity.clone(),
        });
    })?;
    Ok(record)
}

pub(crate) fn remove_process(record: &ProcessInventoryRecord) {
    if let Err(error) = mutate_inventory(&record.path, |resources| {
        resources.retain(|resource| {
            !matches!(resource, InventoryResource::Process { pid, label, identity }
                if *pid == record.pid && label == &record.label && identity == &record.identity)
        });
    }) {
        log::warn!(
            "failed to remove {} from process inventory: {error}",
            record.label
        );
    }
}

fn mutate_inventory(
    path: &Path,
    mutation: impl FnOnce(&mut Vec<InventoryResource>),
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("inventory path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create process inventory directory: {error}"))?;
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let owner = acquire_lock(&lock)?;

    let result = (|| {
        let mut inventory = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ProcessInventory>(&bytes).ok())
            .filter(|inventory| inventory.version == 1)
            .unwrap_or(ProcessInventory {
                version: 1,
                resources: Vec::new(),
            });
        mutation(&mut inventory.resources);
        if inventory.resources.is_empty() {
            std::fs::remove_file(path)
                .or_else(|error| {
                    (error.kind() == std::io::ErrorKind::NotFound)
                        .then_some(())
                        .ok_or(error)
                })
                .map_err(|error| format!("could not remove empty process inventory: {error}"))?;
            return Ok(());
        }
        let temp = parent.join(format!(
            "process-inventory.json.tmp-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        let bytes = serde_json::to_vec_pretty(&inventory)
            .map_err(|error| format!("could not serialize process inventory: {error}"))?;
        std::fs::write(&temp, bytes)
            .map_err(|error| format!("could not write process inventory: {error}"))?;
        std::fs::rename(&temp, path)
            .map_err(|error| format!("could not publish process inventory: {error}"))
    })();
    remove_inventory_owner(&lock, &owner);
    result
}

fn acquire_lock(lock: &Path) -> Result<PathBuf, String> {
    let owner_name = format!("owner-{}-{}.json", std::process::id(), now_nanos());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let candidate = PathBuf::from(format!(
            "{}.pending-{}-{}",
            lock.display(),
            std::process::id(),
            now_nanos()
        ));
        let acquisition = std::fs::create_dir(&candidate)
            .and_then(|()| {
                let identity = process_identity(std::process::id())
                    .ok_or_else(|| std::io::Error::other("could not establish writer identity"))?;
                let owner = serde_json::json!({ "pid": std::process::id(), "identity": identity })
                    .to_string();
                std::fs::write(candidate.join(&owner_name), &owner)?;
                std::fs::write(candidate.join("owner.json"), owner)
            })
            .and_then(|()| std::fs::rename(&candidate, lock));
        match acquisition {
            Ok(()) => return Ok(lock.join(&owner_name)),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                let _ = std::fs::remove_dir_all(&candidate);
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "timed out acquiring process inventory lock: {error}"
                    ));
                }
                if let Some(owner) = abandoned_inventory_owner(lock) {
                    remove_inventory_owner(lock, &owner);
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(candidate);
                return Err(format!("could not acquire process inventory lock: {error}"));
            }
        }
    }
}

fn abandoned_inventory_owner(lock: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(lock)
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let owner_path = entries
        .iter()
        .find(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("owner-") && name.ends_with(".json")
        })
        .or_else(|| {
            entries
                .iter()
                .find(|entry| entry.file_name() == "owner.json")
        })?
        .path();
    let owner = std::fs::read(&owner_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    if let Some((pid, identity)) = owner.and_then(|value| {
        Some((
            u32::try_from(value.get("pid")?.as_u64()?).ok()?,
            value.get("identity")?.as_str()?.to_string(),
        ))
    }) {
        return (process_identity(pid).as_deref() != Some(identity.as_str())).then_some(owner_path);
    }
    std::fs::metadata(&owner_path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
        .is_ok_and(|age| age >= std::time::Duration::from_secs(1))
        .then_some(owner_path)
}

fn remove_inventory_owner(lock: &std::path::Path, owner: &std::path::Path) {
    // A stale observer can unlink only the generation it inspected. Atomic
    // rmdir refuses a successor's nonempty directory, unlike rename + rm -r.
    let removed = std::fs::remove_file(owner);
    if removed.is_ok() && owner.file_name().is_some_and(|name| name != "owner.json") {
        if let Err(error) = std::fs::remove_file(lock.join("owner.json")) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove legacy inventory metadata: {error}");
            }
        }
    }
    if let Err(error) = removed {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "could not remove inventory owner {}: {error}",
                owner.display()
            );
            return;
        }
    }
    if let Err(error) = std::fs::remove_dir(lock) {
        if !matches!(
            error.kind(),
            std::io::ErrorKind::NotFound
                | std::io::ErrorKind::DirectoryNotEmpty
                | std::io::ErrorKind::AlreadyExists
        ) {
            log::warn!(
                "could not remove inventory lock {}: {error}",
                lock.display()
            );
        }
    }
}

fn process_identity(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    let identity = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!identity.is_empty()).then_some(identity)
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {

    #[test]
    fn stale_inventory_recovery_preserves_a_replacement_writer() {
        for old_name in ["owner-old.json", "owner.json"] {
            let temp = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.tmp")
                .join(format!(
                    "inventory-lock-{}-{}",
                    std::process::id(),
                    super::now_nanos()
                ));
            std::fs::create_dir_all(&temp).unwrap();
            let lock = temp.join("inventory.lock");
            std::fs::create_dir(&lock).unwrap();
            std::fs::write(
                lock.join(old_name),
                r#"{"pid":999999999,"identity":"gone"}"#,
            )
            .unwrap();
            let stale = super::abandoned_inventory_owner(&lock).unwrap();
            // The old writer exits and another publishes before recovery acts.
            std::fs::remove_dir_all(&lock).unwrap();
            std::fs::create_dir(&lock).unwrap();
            let owner = serde_json::json!({
                "pid": std::process::id(),
                "identity": super::process_identity(std::process::id()).unwrap()
            })
            .to_string();
            let current = lock.join("owner-current.json");
            std::fs::write(&current, &owner).unwrap();
            std::fs::write(lock.join("owner.json"), owner).unwrap();
            super::remove_inventory_owner(&lock, &stale);
            assert!(current.exists(), "stale recovery removed a live generation");
            assert!(super::abandoned_inventory_owner(&lock).is_none());
            super::remove_inventory_owner(&lock, &current);
            assert!(!lock.exists());
            std::fs::remove_dir_all(temp).unwrap();
        }
    }
}
