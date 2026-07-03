use super::cloud_env::{
    effective_cloud_env, firebase_auth_emulator_url, firebase_firestore_emulator_host,
    firebase_project_id, relay_url_for_bundled_cloud_env,
};
use super::process::find_sidecar;
use super::{
    current_server_version, default_desktop_name, desktop_credential, escape_toml_string,
    file_sha256_hex, generate_device_token, local_server_port, resolved_db_path, server_base_url,
    MobileServerState,
};
use kanna_runtime_defaults::DesktopCloudEnvironment;
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

pub(super) fn write_server_config(state: &MobileServerState) -> Result<(), String> {
    let config = build_server_config(state)?;
    if let Some(parent) = state.config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create mobile config dir: {}", e))?;
    }
    std::fs::write(&state.config_path, config)
        .map_err(|e| format!("failed to write mobile server config: {}", e))
}

pub(super) fn server_config_path_for_app_data_dir(app_data_dir: &Path) -> PathBuf {
    match server_config_scope() {
        Some(scope) => app_data_dir
            .join("Kanna")
            .join("servers")
            .join(scope)
            .join("server.toml"),
        None => app_data_dir.join("Kanna").join("server.toml"),
    }
}

fn server_config_scope() -> Option<String> {
    if let Ok(db_name) = std::env::var("KANNA_DB_NAME") {
        return Some(sanitize_server_scope(
            Path::new(&db_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(&db_name),
        ));
    }

    if let Ok(db_path) = std::env::var("KANNA_DB_PATH") {
        let path = Path::new(&db_path);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("custom-db");
        return Some(format!(
            "{}-{:08x}",
            sanitize_server_scope(stem),
            path_hash(path)
        ));
    }

    None
}

fn sanitize_server_scope(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "database".to_string()
    } else {
        sanitized
    }
}

fn path_hash(path: &Path) -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish() as u32
}

pub(super) fn server_lock_path_for_config(config_path: &Path) -> Result<PathBuf, String> {
    let dir = config_path
        .parent()
        .ok_or_else(|| "mobile config path missing parent directory".to_string())?;
    Ok(dir.join("server.lock"))
}

pub(super) fn try_claim_server_lock(lock_path: &Path) -> Result<File, String> {
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create mobile server lock dir: {}", e))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("failed to open mobile server lock: {}", e))?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(file)
    } else {
        Err(format!(
            "another kanna-server is already starting for {}",
            lock_path.display()
        ))
    }
}

pub(super) fn build_server_config(state: &MobileServerState) -> Result<String, String> {
    let daemon_dir = std::env::var("KANNA_DAEMON_DIR")
        .unwrap_or_else(|_| crate::daemon_data_dir().to_string_lossy().to_string());
    let db_path = resolved_db_path(state)?;
    let pairing_store_path = state
        .config_path
        .parent()
        .ok_or_else(|| "mobile config path missing parent directory".to_string())?
        .join("mobile-pairings.json");
    let device_token = generate_device_token()?;
    let relay_url = relay_url_for_bundled_cloud_env(state.cloud_env);
    let credential = desktop_credential(&state.config_path)?;
    let use_firebase_emulators = effective_cloud_env(state.cloud_env).is_none();
    let firebase_auth_emulator_url = use_firebase_emulators
        .then(firebase_auth_emulator_url)
        .flatten();
    let firebase_firestore_emulator_host = use_firebase_emulators
        .then(firebase_firestore_emulator_host)
        .flatten();
    let firebase_project_id = firebase_project_id(state.cloud_env);
    let firebase_config = format!(
        "firebase_project_id = \"{}\"\n{}{}",
        escape_toml_string(&firebase_project_id),
        firebase_auth_emulator_url
            .as_ref()
            .map(|url| format!(
                "firebase_auth_emulator_url = \"{}\"\n",
                escape_toml_string(url)
            ))
            .unwrap_or_default(),
        firebase_firestore_emulator_host
            .as_ref()
            .map(|host| format!(
                "firebase_firestore_emulator_host = \"{}\"\n",
                escape_toml_string(host)
            ))
            .unwrap_or_default(),
    );
    let kanna_cli_path = find_sidecar("kanna-cli").ok();
    let kanna_cli_path_line = kanna_cli_path
        .as_ref()
        .map(|path| {
            format!(
                "kanna_cli_path = \"{}\"\n",
                escape_toml_string(&path.to_string_lossy())
            )
        })
        .unwrap_or_default();
    let server_binary_sha256_line = sidecar_sha256_config_line("kanna-server")
        .map(|line| format!("{line}\n"))
        .unwrap_or_default();

    Ok(format!(
        "relay_url = \"{}\"\ndevice_token = \"{}\"\ndaemon_dir = \"{}\"\ndb_path = \"{}\"\n{}{}desktop_id = \"{}\"\ndesktop_secret = \"{}\"\ndesktop_name = \"{}\"\nserver_version = \"{}\"\n{}lan_host = \"0.0.0.0\"\nlan_port = {}\npairing_store_path = \"{}\"\n",
        escape_toml_string(&relay_url),
        escape_toml_string(&device_token),
        escape_toml_string(&daemon_dir),
        escape_toml_string(&db_path.to_string_lossy()),
        kanna_cli_path_line,
        server_binary_sha256_line,
        escape_toml_string(&credential.desktop_id),
        escape_toml_string(&credential.desktop_secret),
        escape_toml_string(&state.desktop_name),
        escape_toml_string(current_server_version()),
        firebase_config,
        local_server_port(),
        escape_toml_string(&pairing_store_path.to_string_lossy()),
    ))
}

pub(super) fn server_config_matches_runtime(
    config_path: &Path,
    desktop_id: &str,
    cloud_env: Option<DesktopCloudEnvironment>,
) -> bool {
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let state = MobileServerState {
        status: "stopped".to_string(),
        desktop_name: default_desktop_name(),
        api_base_url: server_base_url(local_server_port()),
        config_path: config_path.to_path_buf(),
        started: false,
        cloud_env,
    };
    let Ok(db_path) = resolved_db_path(&state) else {
        return false;
    };
    let daemon_dir = std::env::var("KANNA_DAEMON_DIR")
        .unwrap_or_else(|_| crate::daemon_data_dir().to_string_lossy().to_string());
    let Ok(credential) = desktop_credential(config_path) else {
        return false;
    };
    let expected_device_token = std::env::var("KANNA_E2E_DEVICE_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let expected_firebase_project_id = firebase_project_id(cloud_env);
    let kanna_cli_path_line = find_sidecar("kanna-cli").ok().map(|path| {
        format!(
            "kanna_cli_path = \"{}\"",
            escape_toml_string(&path.to_string_lossy())
        )
    });

    let mut required_lines = vec![
        format!(
            "relay_url = \"{}\"",
            escape_toml_string(&relay_url_for_bundled_cloud_env(cloud_env))
        ),
        format!("daemon_dir = \"{}\"", escape_toml_string(&daemon_dir)),
        format!(
            "db_path = \"{}\"",
            escape_toml_string(&db_path.to_string_lossy())
        ),
        format!("desktop_id = \"{}\"", escape_toml_string(desktop_id)),
        format!(
            "desktop_secret = \"{}\"",
            escape_toml_string(&credential.desktop_secret)
        ),
        format!(
            "server_version = \"{}\"",
            escape_toml_string(current_server_version())
        ),
        format!(
            "firebase_project_id = \"{}\"",
            escape_toml_string(&expected_firebase_project_id)
        ),
        format!("lan_port = {}", local_server_port()),
    ];
    if let Some(device_token) = expected_device_token {
        required_lines.push(format!(
            "device_token = \"{}\"",
            escape_toml_string(&device_token)
        ));
    }
    if effective_cloud_env(cloud_env).is_none() {
        if let Some(url) = firebase_auth_emulator_url() {
            required_lines.push(format!(
                "firebase_auth_emulator_url = \"{}\"",
                escape_toml_string(&url)
            ));
        }
        if let Some(host) = firebase_firestore_emulator_host() {
            required_lines.push(format!(
                "firebase_firestore_emulator_host = \"{}\"",
                escape_toml_string(&host)
            ));
        }
    }
    if let Some(line) = kanna_cli_path_line {
        required_lines.push(line);
    }
    if let Some(line) = sidecar_sha256_config_line("kanna-server") {
        required_lines.push(line);
    }
    required_lines.iter().all(|line| content.contains(line))
}

pub(super) fn sidecar_sha256_config_line(name: &str) -> Option<String> {
    let path = find_sidecar(name).ok()?;
    let digest = file_sha256_hex(&path).ok()?;
    Some(format!("{name}_sha256 = \"{digest}\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mobile::tests::{env_lock, set_env_var, unique_test_root, unset_env_var};
    use crate::commands::mobile::{
        desktop_credential, desktop_id, server_base_url, MobileServerManager, MobileServerState,
    };
    use kanna_runtime_defaults::DesktopCloudEnvironment;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn manager_uses_database_scoped_config_path_to_avoid_worktree_clobbering() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_DB_NAME", "kanna-wt-task-1234.db");
        }

        let manager = MobileServerManager::new(PathBuf::from("/tmp/build.kanna"));
        let state = manager.inner.blocking_lock();
        let config_path = state.config_path.clone();

        unsafe {
            unset_env_var("KANNA_DB_NAME");
        }

        assert_eq!(
            config_path,
            PathBuf::from("/tmp/build.kanna/Kanna/servers/kanna-wt-task-1234/server.toml")
        );
    }

    #[test]
    fn default_config_path_preserves_legacy_production_location() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
        }

        assert_eq!(
            server_config_path_for_app_data_dir(&PathBuf::from("/tmp/build.kanna")),
            PathBuf::from("/tmp/build.kanna/Kanna/server.toml")
        );
    }

    #[test]
    fn server_lock_prevents_duplicate_owner_for_same_database_config() {
        let root = std::env::temp_dir().join(format!(
            "kanna-mobile-lock-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config_path = root.join("Kanna/servers/kanna-v2/server.toml");
        let lock_path = server_lock_path_for_config(&config_path).unwrap();

        let first = try_claim_server_lock(&lock_path).expect("first lock should succeed");
        let second = try_claim_server_lock(&lock_path);

        assert!(second.is_err(), "second owner unexpectedly claimed lock");

        drop(first);
        let mut third = None;
        for _ in 0..10 {
            match try_claim_server_lock(&lock_path) {
                Ok(lock) => {
                    third = Some(lock);
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
            }
        }
        let third = third.expect("lock should release on drop");
        drop(third);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_server_config_includes_desktop_identity_and_db_path() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
            unset_env_var("KANNA_E2E_DEVICE_TOKEN");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
            unset_env_var("FIREBASE_AUTH_EMULATOR_HOST");
            unset_env_var("FIRESTORE_EMULATOR_HOST");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"\""));
        assert!(config.contains("desktop_name = \"Studio Mac\""));
        let credential = desktop_credential(&state.config_path).unwrap();
        assert!(config.contains(&format!(
            "desktop_secret = \"{}\"",
            credential.desktop_secret
        )));
        assert!(config.contains(&format!(
            "server_version = \"{}\"",
            current_server_version()
        )));
        assert!(config.contains("db_path = \"/tmp/build.kanna/kanna-v2.db\""));
        assert!(config.contains("lan_port = 48120"));
    }

    #[test]
    fn build_server_config_includes_firebase_emulator_settings_when_provided() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_FIREBASE_PROJECT_ID", "kanna-local");
            set_env_var("KANNA_FIREBASE_AUTH_PORT", "19099");
            set_env_var("KANNA_FIREBASE_FIRESTORE_PORT", "18080");
            unset_env_var("FIREBASE_AUTH_EMULATOR_HOST");
            unset_env_var("FIRESTORE_EMULATOR_HOST");
            unset_env_var("KANNA_E2E_DEVICE_TOKEN");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("firebase_project_id = \"kanna-local\""));
        assert!(config.contains("firebase_auth_emulator_url = \"http://127.0.0.1:19099\""));
        assert!(config.contains("firebase_firestore_emulator_host = \"127.0.0.1:18080\""));

        unsafe {
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
        }
    }

    #[test]
    fn build_server_config_uses_seeded_e2e_device_token_when_provided() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_E2E_DEVICE_TOKEN", "e2e-token");
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
            unset_env_var("FIREBASE_AUTH_EMULATOR_HOST");
            unset_env_var("FIRESTORE_EMULATOR_HOST");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("device_token = \"e2e-token\""));

        unsafe {
            unset_env_var("KANNA_E2E_DEVICE_TOKEN");
        }
    }

    #[test]
    fn build_server_config_includes_desktop_resolved_kanna_cli_path() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("server-config-kanna-cli");
        let sidecar_dir = root.join("sidecars");
        std::fs::create_dir_all(&sidecar_dir).unwrap();
        let cli_path = sidecar_dir.join("kanna-cli");
        std::fs::write(&cli_path, "#!/bin/sh\n").unwrap();
        unsafe {
            set_env_var("KANNA_TEST_SIDECAR_DIR", &sidecar_dir.to_string_lossy());
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: root.join("Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();

        unsafe {
            unset_env_var("KANNA_TEST_SIDECAR_DIR");
        }
        assert!(config.contains(&format!(
            "kanna_cli_path = \"{}\"",
            cli_path.to_string_lossy()
        )));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_server_config_uses_overridden_mobile_server_port() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_MOBILE_SERVER_PORT", "48129");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();

        unsafe {
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
        }

        assert!(config.contains("lan_port = 48129"));
    }

    #[test]
    fn build_server_config_uses_local_relay_port_when_provided() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_RELAY_PORT", "19083");
            unset_env_var("KANNA_RELAY_URL");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: None,
        };

        let config = build_server_config(&state).unwrap();

        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
        }

        assert!(config.contains("relay_url = \"ws://127.0.0.1:19083\""));
    }

    #[test]
    fn build_server_config_uses_staging_bundle_cloud_defaults_without_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
            set_env_var("KANNA_FIREBASE_AUTH_PORT", "19099");
            set_env_var("KANNA_FIREBASE_FIRESTORE_PORT", "18080");
            set_env_var("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:19199");
            set_env_var("FIRESTORE_EMULATOR_HOST", "127.0.0.1:18180");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna.staging/Kanna/server.toml"),
            started: false,
            cloud_env: Some(DesktopCloudEnvironment::Staging),
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"wss://relay-staging.kanna.build\""));
        assert!(config.contains("firebase_project_id = \"kanna-staging\""));
        assert!(!config.contains("firebase_auth_emulator_url"));
        assert!(!config.contains("firebase_firestore_emulator_host"));

        unsafe {
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
            unset_env_var("FIREBASE_AUTH_EMULATOR_HOST");
            unset_env_var("FIRESTORE_EMULATOR_HOST");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn build_server_config_uses_staging_release_bundle_identifier_defaults_without_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
            set_env_var("KANNA_FIREBASE_AUTH_PORT", "19099");
            set_env_var("KANNA_FIREBASE_FIRESTORE_PORT", "18080");
        }
        let root = unique_test_root("staging-release-bundle-server-config");
        let manager = MobileServerManager::new_with_bundle_identifier_for_mode(
            root.join("app-data"),
            kanna_runtime_defaults::STAGING_DESKTOP_BUNDLE_IDENTIFIER,
            false,
        );

        let config = {
            let state = manager.inner.lock().await;
            build_server_config(&state).unwrap()
        };

        assert!(config.contains("relay_url = \"wss://relay-staging.kanna.build\""));
        assert!(config.contains("firebase_project_id = \"kanna-staging\""));
        assert!(!config.contains("firebase_auth_emulator_url"));
        assert!(!config.contains("firebase_firestore_emulator_host"));

        unsafe {
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_server_config_uses_production_bundle_cloud_defaults_without_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
            unset_env_var("KANNA_FIREBASE_AUTH_PORT");
            unset_env_var("KANNA_FIREBASE_FIRESTORE_PORT");
            unset_env_var("FIREBASE_AUTH_EMULATOR_HOST");
            unset_env_var("FIRESTORE_EMULATOR_HOST");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
            cloud_env: Some(DesktopCloudEnvironment::Production),
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"wss://relay.kanna.build\""));
        assert!(config.contains("firebase_project_id = \"kanna-build\""));
        assert!(!config.contains("firebase_auth_emulator_url"));
        assert!(!config.contains("firebase_firestore_emulator_host"));
    }

    #[test]
    fn build_server_config_preserves_explicit_relay_overrides_with_cloud_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            set_env_var("KANNA_RELAY_URL", "wss://relay.override.example");
            set_env_var("KANNA_RELAY_PORT", "19083");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna.staging/Kanna/server.toml"),
            started: false,
            cloud_env: Some(DesktopCloudEnvironment::Staging),
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"wss://relay.override.example\""));
        assert!(config.contains("firebase_project_id = \"kanna-staging\""));

        unsafe {
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    #[test]
    fn build_server_config_preserves_explicit_relay_port_with_cloud_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_RELAY_URL");
            set_env_var("KANNA_RELAY_PORT", "19083");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna.staging/Kanna/server.toml"),
            started: false,
            cloud_env: Some(DesktopCloudEnvironment::Staging),
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"ws://127.0.0.1:19083\""));
        assert!(config.contains("firebase_project_id = \"kanna-staging\""));

        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    #[test]
    fn server_config_matches_runtime_requires_current_relay_url() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_RELAY_PORT", "19083");
            unset_env_var("KANNA_RELAY_URL");
        }
        let path = std::env::temp_dir().join(format!(
            "kanna-server-config-runtime-{}.toml",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos()
        ));
        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: path.clone(),
            started: false,
            cloud_env: None,
        };
        let correct_config = build_server_config(&state).unwrap();
        let stale_config = correct_config.replace(
            "relay_url = \"ws://127.0.0.1:19083\"",
            "relay_url = \"wss://old-relay.example\"",
        );
        std::fs::write(&path, stale_config).unwrap();

        let desktop_id =
            desktop_id(&state.config_path).expect("desktop identity should be generated");

        assert!(!server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        let _ = std::fs::remove_file(path);
        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    #[test]
    fn server_config_matches_runtime_requires_cloud_default_firebase_project() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_FIREBASE_PROJECT_ID");
        }
        let root = unique_test_root("config-cloud-runtime");
        let path = root.join("Kanna/server.toml");
        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: path.clone(),
            started: false,
            cloud_env: Some(DesktopCloudEnvironment::Staging),
        };
        let correct_config = build_server_config(&state).unwrap();
        let stale_config = correct_config.replace(
            "firebase_project_id = \"kanna-staging\"",
            "firebase_project_id = \"kanna-local\"",
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, stale_config).unwrap();
        let desktop_id =
            desktop_id(&state.config_path).expect("desktop identity should be generated");

        assert!(!server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn server_config_matches_runtime_rejects_wrong_db_path() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            set_env_var("KANNA_DB_NAME", "kanna-wt-task-1234.db");
        }
        let root = std::env::temp_dir().join(format!(
            "kanna-server-config-db-runtime-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should be monotonic")
                .as_nanos()
        ));
        let path = root.join("Kanna/servers/kanna-wt-task-1234/server.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: path.clone(),
            started: false,
            cloud_env: None,
        };
        let correct_config = build_server_config(&state).unwrap();
        let correct_db_path = root.join("kanna-wt-task-1234.db");
        let stale_config = correct_config.replace(
            &format!("db_path = \"{}\"", correct_db_path.to_string_lossy()),
            "db_path = \"/tmp/build.kanna/kanna-v2.db\"",
        );
        std::fs::write(&path, stale_config).unwrap();

        let desktop_id =
            desktop_id(&state.config_path).expect("desktop identity should be generated");

        assert!(!server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        let _ = std::fs::remove_dir_all(root);
        unsafe {
            unset_env_var("KANNA_DB_NAME");
        }
    }

    #[test]
    fn server_config_matches_runtime_requires_desktop_secret() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
        }
        let root = unique_test_root("config-secret-runtime");
        let path = root.join("Kanna/server.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: path.clone(),
            started: false,
            cloud_env: None,
        };
        let correct_config = build_server_config(&state).unwrap();
        let credential = desktop_credential(&path).unwrap();
        let desktop_id = credential.desktop_id.clone();
        let stale_config = correct_config.replace(
            &format!("desktop_secret = \"{}\"\n", credential.desktop_secret),
            "",
        );
        assert_ne!(stale_config, correct_config);
        std::fs::write(&path, stale_config).unwrap();

        assert!(!server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn server_config_matches_runtime_rejects_replaced_same_version_server_binary() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("config-server-binary-runtime");
        let sidecar_dir = root.join("sidecars");
        let server_bin = sidecar_dir.join("kanna-server");
        std::fs::create_dir_all(&sidecar_dir).unwrap();
        std::fs::write(&server_bin, b"old-server-binary").unwrap();
        unsafe {
            set_env_var("KANNA_TEST_SIDECAR_DIR", &sidecar_dir.to_string_lossy());
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
        }

        let path = root.join("Kanna/server.toml");
        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: path.clone(),
            started: false,
            cloud_env: None,
        };
        let correct_config = build_server_config(&state).unwrap();
        let desktop_id =
            desktop_id(&state.config_path).expect("desktop identity should be generated");
        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        std::fs::write(&server_bin, b"new-server-binary").unwrap();

        assert!(!server_config_matches_runtime(
            &path,
            &desktop_id,
            state.cloud_env
        ));

        unsafe {
            unset_env_var("KANNA_TEST_SIDECAR_DIR");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
