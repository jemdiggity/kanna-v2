use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::process::Command;
use tokio::sync::Mutex;

const LOCAL_SERVER_HOST: &str = "127.0.0.1";
const DEFAULT_LOCAL_SERVER_PORT: u16 = 48_120;
// kanna-server can take a while to bind and register when the machine is under
// heavy load (e.g. an in-progress iOS/Rust build during `kd mobile run`). Poll
// generously and only give up early if the process actually exits — a healthy
// server must never be killed for being slow to answer /v1/status.
const STATUS_POLL_ATTEMPTS: usize = 240;
const STATUS_POLL_DELAY_MS: u64 = 250;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileServerStatus {
    pub state: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingSessionPayload {
    code: String,
}

#[derive(Clone)]
pub struct MobileServerManager {
    inner: Arc<Mutex<MobileServerState>>,
    server_lock: Arc<Mutex<Option<File>>>,
    client: reqwest::Client,
}

#[derive(Debug)]
struct MobileServerState {
    status: String,
    desktop_name: String,
    api_base_url: String,
    config_path: PathBuf,
    started: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct DesktopIdentityFile {
    desktop_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    desktop_secret: Option<String>,
}

/// Local desktop relay credential: a stable per-instance id plus the secret
/// that proves it. The plain secret only ever lives in the identity file and
/// the generated `server.toml`; everything cloud-facing sees its SHA-256 hash.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopCredential {
    desktop_id: String,
    desktop_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudCredential {
    pub desktop_id: String,
    pub desktop_secret_hash: String,
}

impl MobileServerManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let config_path = server_config_path_for_app_data_dir(&app_data_dir);
        Self {
            inner: Arc::new(Mutex::new(MobileServerState {
                status: "stopped".to_string(),
                desktop_name: default_desktop_name(),
                api_base_url: server_base_url(local_server_port()),
                config_path,
                started: false,
            })),
            server_lock: Arc::new(Mutex::new(None)),
            client: reqwest::Client::new(),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let (config_path, desktop_name, api_base_url) = {
            let state = self.inner.lock().await;
            if state.started {
                return Ok(());
            }
            (
                state.config_path.clone(),
                state.desktop_name.clone(),
                state.api_base_url.clone(),
            )
        };

        let expected_desktop_id = desktop_id(&config_path)?;
        let existing_status = self.fetch_status(&api_base_url).await.ok();
        if let Some(status) = existing_status {
            ensure_server_belongs_to_desktop(&status, &expected_desktop_id)?;
            if is_current_server_status(&status, &expected_desktop_id, current_server_version())
                && server_config_matches_runtime(&config_path, &expected_desktop_id)
            {
                let mut state = self.inner.lock().await;
                state.started = true;
                state.status = status.state;
                state.desktop_name = status.desktop_name;
                return Ok(());
            }
            stop_server_on_port(local_server_port()).await?;
        }

        let lock_path = server_lock_path_for_config(&config_path)?;
        let claimed_lock = try_claim_server_lock(&lock_path)?;

        {
            let mut state = self.inner.lock().await;
            write_server_config(&state)?;
            state.started = true;
        }
        *self.server_lock.lock().await = Some(claimed_lock);

        let server_bin = match find_sidecar("kanna-server") {
            Ok(path) => path,
            Err(err) => {
                let mut state = self.inner.lock().await;
                state.started = false;
                state.status = "error".to_string();
                *self.server_lock.lock().await = None;
                return Err(err);
            }
        };

        let mut child = match Command::new(server_bin)
            .env("KANNA_SERVER_CONFIG", &config_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let mut state = self.inner.lock().await;
                state.started = false;
                state.status = "error".to_string();
                *self.server_lock.lock().await = None;
                return Err(format!("failed to spawn kanna-server: {}", err));
            }
        };

        let status = match self.wait_for_status(&api_base_url, &mut child).await {
            Ok(status) => status,
            Err(err) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let mut state = self.inner.lock().await;
                state.started = false;
                state.status = "error".to_string();
                *self.server_lock.lock().await = None;
                return Err(err);
            }
        };

        {
            let mut state = self.inner.lock().await;
            state.status = status.state.clone();
            state.desktop_name = status.desktop_name.clone();
        }

        let state_handle = self.inner.clone();
        let lock_handle = self.server_lock.clone();
        tauri::async_runtime::spawn(async move {
            let exit = child.wait().await;
            let mut state = state_handle.lock().await;
            state.started = false;
            state.desktop_name = desktop_name;
            *lock_handle.lock().await = None;
            match exit {
                Ok(status) if status.success() => {
                    state.status = "stopped".to_string();
                }
                Ok(status) => {
                    state.status = "error".to_string();
                    eprintln!("[mobile] kanna-server exited with {}", status);
                }
                Err(err) => {
                    state.status = "error".to_string();
                    eprintln!("[mobile] failed to wait for kanna-server: {}", err);
                }
            }
        });

        Ok(())
    }

    pub async fn snapshot(&self) -> Result<MobileServerStatus, String> {
        let state = self.inner.lock().await;
        if !state.started {
            return stopped_snapshot(&state);
        }
        let api_base_url = state.api_base_url.clone();
        drop(state);

        let status = self.fetch_status(&api_base_url).await?;
        let mut state = self.inner.lock().await;
        state.status = status.state.clone();
        state.desktop_name = status.desktop_name.clone();
        Ok(status)
    }

    pub async fn create_pairing_session(&self) -> Result<MobileServerStatus, String> {
        let api_base_url = {
            let state = self.inner.lock().await;
            if !state.started {
                return Err("kanna-server is not running".to_string());
            }
            state.api_base_url.clone()
        };

        let response = self
            .client
            .post(format!("{}/v1/pairing/sessions", api_base_url))
            .send()
            .await
            .map_err(|e| format!("failed to create pairing session: {}", e))?;
        let response = response
            .error_for_status()
            .map_err(|e| format!("pairing session request failed: {}", e))?;
        let pairing = response
            .json::<PairingSessionPayload>()
            .await
            .map_err(|e| format!("failed to parse pairing session response: {}", e))?;

        if pairing.code.is_empty() {
            return Err("kanna-server returned an empty pairing code".to_string());
        }

        self.snapshot().await
    }

    async fn wait_for_status(
        &self,
        api_base_url: &str,
        child: &mut tokio::process::Child,
    ) -> Result<MobileServerStatus, String> {
        let mut last_error = "kanna-server did not become ready".to_string();
        for _ in 0..STATUS_POLL_ATTEMPTS {
            // If the process already exited it genuinely failed to start; stop
            // polling instead of waiting out the full budget on a dead server.
            if let Ok(Some(exit)) = child.try_wait() {
                return Err(format!("kanna-server exited during startup with {}", exit));
            }
            match self.fetch_status(api_base_url).await {
                Ok(status) => return Ok(status),
                Err(err) => {
                    last_error = err;
                    tokio::time::sleep(std::time::Duration::from_millis(STATUS_POLL_DELAY_MS))
                        .await;
                }
            }
        }

        Err(last_error)
    }

    async fn fetch_status(&self, api_base_url: &str) -> Result<MobileServerStatus, String> {
        let response = self
            .client
            .get(format!("{}/v1/status", api_base_url))
            .send()
            .await
            .map_err(|e| format!("failed to fetch mobile server status: {}", e))?;
        let response = response
            .error_for_status()
            .map_err(|e| format!("mobile server status request failed: {}", e))?;
        response
            .json::<MobileServerStatus>()
            .await
            .map_err(|e| format!("failed to decode mobile server status: {}", e))
    }
}

#[tauri::command]
pub async fn ensure_mobile_server(app: tauri::AppHandle) -> Result<(), String> {
    let manager = app.state::<MobileServerManager>();
    manager.start().await
}

#[tauri::command]
pub async fn mobile_server_status(app: tauri::AppHandle) -> Result<MobileServerStatus, String> {
    let manager = app.state::<MobileServerManager>();
    manager.snapshot().await
}

#[tauri::command]
pub async fn create_mobile_pairing_session(
    app: tauri::AppHandle,
) -> Result<MobileServerStatus, String> {
    let manager = app.state::<MobileServerManager>();
    manager.create_pairing_session().await
}

/// Expose the desktop's cloud credential to the frontend so a signed-in user
/// can register this desktop in Firestore (`users/{uid}/desktops`). Only the
/// SHA-256 hash of the secret crosses into the webview; the relay compares
/// the hash, so the plain secret never leaves the Rust side.
#[tauri::command]
pub async fn desktop_cloud_credential(
    app: tauri::AppHandle,
) -> Result<DesktopCloudCredential, String> {
    let manager = app.state::<MobileServerManager>();
    let config_path = {
        let state = manager.inner.lock().await;
        state.config_path.clone()
    };
    let credential = desktop_credential(&config_path)?;
    Ok(DesktopCloudCredential {
        desktop_id: credential.desktop_id,
        desktop_secret_hash: sha256_hex(&credential.desktop_secret),
    })
}

fn write_server_config(state: &MobileServerState) -> Result<(), String> {
    let config = build_server_config(state)?;
    if let Some(parent) = state.config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create mobile config dir: {}", e))?;
    }
    std::fs::write(&state.config_path, config)
        .map_err(|e| format!("failed to write mobile server config: {}", e))
}

fn server_config_path_for_app_data_dir(app_data_dir: &Path) -> PathBuf {
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

fn server_lock_path_for_config(config_path: &Path) -> Result<PathBuf, String> {
    let dir = config_path
        .parent()
        .ok_or_else(|| "mobile config path missing parent directory".to_string())?;
    Ok(dir.join("server.lock"))
}

fn try_claim_server_lock(lock_path: &Path) -> Result<File, String> {
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

fn build_server_config(state: &MobileServerState) -> Result<String, String> {
    let daemon_dir = std::env::var("KANNA_DAEMON_DIR")
        .unwrap_or_else(|_| crate::daemon_data_dir().to_string_lossy().to_string());
    let db_path = resolved_db_path(state)?;
    let pairing_store_path = state
        .config_path
        .parent()
        .ok_or_else(|| "mobile config path missing parent directory".to_string())?
        .join("mobile-pairings.json");
    let device_token = generate_device_token()?;
    let relay_url = relay_url();
    let credential = desktop_credential(&state.config_path)?;
    let firebase_auth_emulator_url = firebase_auth_emulator_url();
    let firebase_firestore_emulator_host = firebase_firestore_emulator_host();
    let firebase_project_id = std::env::var("KANNA_FIREBASE_PROJECT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "kanna-local".to_string());
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

    Ok(format!(
        "relay_url = \"{}\"\ndevice_token = \"{}\"\ndaemon_dir = \"{}\"\ndb_path = \"{}\"\n{}desktop_id = \"{}\"\ndesktop_secret = \"{}\"\ndesktop_name = \"{}\"\nserver_version = \"{}\"\n{}lan_host = \"0.0.0.0\"\nlan_port = {}\npairing_store_path = \"{}\"\n",
        escape_toml_string(&relay_url),
        escape_toml_string(&device_token),
        escape_toml_string(&daemon_dir),
        escape_toml_string(&db_path.to_string_lossy()),
        kanna_cli_path_line,
        escape_toml_string(&credential.desktop_id),
        escape_toml_string(&credential.desktop_secret),
        escape_toml_string(&state.desktop_name),
        escape_toml_string(current_server_version()),
        firebase_config,
        local_server_port(),
        escape_toml_string(&pairing_store_path.to_string_lossy()),
    ))
}

fn server_config_matches_runtime(config_path: &Path, desktop_id: &str) -> bool {
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let state = MobileServerState {
        status: "stopped".to_string(),
        desktop_name: default_desktop_name(),
        api_base_url: server_base_url(local_server_port()),
        config_path: config_path.to_path_buf(),
        started: false,
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
    let expected_firebase_project_id = std::env::var("KANNA_FIREBASE_PROJECT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "kanna-local".to_string());
    let kanna_cli_path_line = find_sidecar("kanna-cli").ok().map(|path| {
        format!(
            "kanna_cli_path = \"{}\"",
            escape_toml_string(&path.to_string_lossy())
        )
    });

    let mut required_lines = vec![
        format!("relay_url = \"{}\"", escape_toml_string(&relay_url())),
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
    if let Some(line) = kanna_cli_path_line {
        required_lines.push(line);
    }
    required_lines.iter().all(|line| content.contains(line))
}

const PRODUCTION_RELAY_URL: &str = "wss://relay.kanna.build";

fn relay_url() -> String {
    relay_url_for_mode(cfg!(debug_assertions))
}

fn relay_url_for_mode(debug_assertions: bool) -> String {
    if let Ok(url) = std::env::var("KANNA_RELAY_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(port) = std::env::var("KANNA_RELAY_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return format!("ws://127.0.0.1:{}", trimmed);
        }
    }
    if !debug_assertions {
        return PRODUCTION_RELAY_URL.to_string();
    }
    String::new()
}

fn firebase_auth_emulator_url() -> Option<String> {
    if let Ok(host) = std::env::var("FIREBASE_AUTH_EMULATOR_HOST") {
        let trimmed = host.trim();
        if !trimmed.is_empty() {
            return Some(format!(
                "http://{}",
                trimmed
                    .trim_start_matches("http://")
                    .trim_start_matches("https://")
            ));
        }
    }
    if let Ok(port) = std::env::var("KANNA_FIREBASE_AUTH_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return Some(format!("http://127.0.0.1:{trimmed}"));
        }
    }
    None
}

fn firebase_firestore_emulator_host() -> Option<String> {
    if let Ok(host) = std::env::var("FIRESTORE_EMULATOR_HOST") {
        let trimmed = host.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(port) = std::env::var("KANNA_FIREBASE_FIRESTORE_PORT") {
        let trimmed = port.trim();
        if !trimmed.is_empty() {
            return Some(format!("127.0.0.1:{trimmed}"));
        }
    }
    None
}

fn resolved_db_path(state: &MobileServerState) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("KANNA_DB_PATH") {
        return Ok(PathBuf::from(path));
    }

    let app_data_dir = app_data_dir_for_server_config(&state.config_path)?;
    if let Ok(db_name) = std::env::var("KANNA_DB_NAME") {
        return Ok(app_data_dir.join(db_name));
    }

    Ok(app_data_dir.join("kanna-v2.db"))
}

fn app_data_dir_for_server_config(config_path: &Path) -> Result<PathBuf, String> {
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "mobile config path missing parent directory".to_string())?;

    if config_dir.file_name().and_then(|value| value.to_str()) == Some("Kanna") {
        return config_dir
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "mobile config path missing app data directory".to_string());
    }

    if config_dir
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        == Some("servers")
    {
        return config_dir
            .parent()
            .and_then(|servers_dir| servers_dir.parent())
            .and_then(|kanna_dir| kanna_dir.parent())
            .map(Path::to_path_buf)
            .ok_or_else(|| "mobile server config path missing app data directory".to_string());
    }

    config_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "mobile config path missing app data directory".to_string())
}

fn local_server_port() -> u16 {
    std::env::var("KANNA_MOBILE_SERVER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_LOCAL_SERVER_PORT)
}

fn find_sidecar(name: &str) -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Ok(dir) = std::env::var("KANNA_TEST_SIDECAR_DIR") {
        let dir = PathBuf::from(dir);
        let suffixed = dir.join(format!(
            "{}-{}",
            name,
            crate::commands::fs::current_target_triple()
        ));
        if suffixed.exists() {
            return Ok(suffixed);
        }
        let unsuffixed = dir.join(name);
        if unsuffixed.exists() {
            return Ok(unsuffixed);
        }
    }

    for candidate in crate::commands::fs::sidecar_candidates(name) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!("mobile sidecar '{}' not found", name))
}

fn server_base_url(port: u16) -> String {
    format!("http://{}:{}", LOCAL_SERVER_HOST, port)
}

fn stopped_snapshot(state: &MobileServerState) -> Result<MobileServerStatus, String> {
    Ok(MobileServerStatus {
        state: state.status.clone(),
        desktop_id: desktop_id(&state.config_path)?,
        desktop_name: state.desktop_name.clone(),
        server_version: Some(current_server_version().to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: local_server_port(),
        pairing_code: None,
    })
}

fn current_server_version() -> &'static str {
    crate::KANNA_VERSION
}

fn is_current_server_status(
    status: &MobileServerStatus,
    expected_desktop_id: &str,
    expected_server_version: &str,
) -> bool {
    status.desktop_id == expected_desktop_id
        && status.server_version.as_deref() == Some(expected_server_version)
}

fn ensure_server_belongs_to_desktop(
    status: &MobileServerStatus,
    expected_desktop_id: &str,
) -> Result<(), String> {
    if status.desktop_id == expected_desktop_id {
        return Ok(());
    }
    Err(format!(
        "kanna-server port is already owned by {} ({})",
        status.desktop_name, status.desktop_id
    ))
}

async fn stop_server_on_port(port: u16) -> Result<(), String> {
    let pids = server_pids_on_port(port).await?;
    if pids.is_empty() {
        return Ok(());
    }

    for pid in &pids {
        signal_process(*pid, libc::SIGTERM)?;
    }
    let _ = wait_for_server_port_to_close(port, 20).await;

    let remaining_pids = server_pids_on_port(port).await?;
    if remaining_pids.is_empty() {
        return Ok(());
    }

    for pid in remaining_pids {
        signal_process(pid, libc::SIGKILL)?;
    }
    wait_for_server_port_to_close(port, 20).await
}

async fn server_pids_on_port(port: u16) -> Result<Vec<i32>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-ti", &format!("TCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .await
        .map_err(|e| format!("failed to inspect kanna-server port owner: {}", e))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_lsof_pids(&stdout))
}

fn parse_lsof_pids(output: &str) -> Vec<i32> {
    output
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect()
}

fn signal_process(pid: i32, signal: i32) -> Result<(), String> {
    let rc = unsafe { libc::kill(pid, signal) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!(
            "failed to signal stale kanna-server process {}: {}",
            pid,
            std::io::Error::last_os_error()
        ))
    }
}

async fn wait_for_server_port_to_close(port: u16, attempts: usize) -> Result<(), String> {
    for _ in 0..attempts {
        if server_pids_on_port(port).await?.is_empty() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(format!("stale kanna-server did not stop on port {}", port))
}

fn desktop_id(config_path: &Path) -> Result<String, String> {
    Ok(desktop_credential(config_path)?.desktop_id)
}

fn desktop_credential(config_path: &Path) -> Result<DesktopCredential, String> {
    let identity_path = desktop_identity_path(config_path);
    if let Some(identity) = read_desktop_identity(&identity_path) {
        return credential_from_identity(&identity_path, identity);
    }

    let credential = DesktopCredential {
        desktop_id: format!("desktop-{}", generate_uuid_v4()?),
        desktop_secret: generate_desktop_secret()?,
    };
    match write_desktop_identity(&identity_path, &credential) {
        Ok(()) => Ok(credential),
        Err(error) if error.starts_with("desktop identity already exists") => {
            // Lost a creation race to another process in this scope; adopt the
            // winner's identity, attaching a secret if it predates credentials.
            match read_desktop_identity(&identity_path) {
                Some(identity) => credential_from_identity(&identity_path, identity),
                None => Ok(credential),
            }
        }
        Err(error) => {
            eprintln!(
                "[mobile] failed to persist desktop identity at {}: {}",
                identity_path.display(),
                error
            );
            Ok(credential)
        }
    }
}

fn credential_from_identity(
    identity_path: &Path,
    identity: DesktopIdentityFile,
) -> Result<DesktopCredential, String> {
    if let Some(secret) = identity
        .desktop_secret
        .as_deref()
        .filter(|secret| !secret.is_empty())
    {
        return Ok(DesktopCredential {
            desktop_id: identity.desktop_id,
            desktop_secret: secret.to_string(),
        });
    }

    // Identity files written before desktop credentials existed only carry the
    // id. Keep the id stable and attach a freshly generated secret.
    let credential = DesktopCredential {
        desktop_id: identity.desktop_id,
        desktop_secret: generate_desktop_secret()?,
    };
    if let Err(error) = rewrite_desktop_identity(identity_path, &credential) {
        eprintln!(
            "[mobile] failed to persist desktop secret at {}: {}",
            identity_path.display(),
            error
        );
    }
    Ok(credential)
}

fn desktop_identity_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("desktop-identity.json")
}

fn read_desktop_identity(path: &Path) -> Option<DesktopIdentityFile> {
    let body = std::fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<DesktopIdentityFile>(&body).ok()?;
    if is_desktop_uuid(&parsed.desktop_id) {
        Some(parsed)
    } else {
        None
    }
}

fn encode_desktop_identity(credential: &DesktopCredential) -> Result<String, String> {
    serde_json::to_string_pretty(&DesktopIdentityFile {
        desktop_id: credential.desktop_id.clone(),
        desktop_secret: Some(credential.desktop_secret.clone()),
    })
    .map_err(|e| format!("failed to encode desktop identity: {}", e))
}

fn write_desktop_identity(path: &Path, credential: &DesktopCredential) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create desktop identity dir: {}", e))?;
    }
    let body = encode_desktop_identity(credential)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(body.as_bytes())
        })
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                "desktop identity already exists".to_string()
            } else {
                format!("failed to write desktop identity: {}", e)
            }
        })
}

fn rewrite_desktop_identity(path: &Path, credential: &DesktopCredential) -> Result<(), String> {
    let body = encode_desktop_identity(credential)?;
    std::fs::write(path, body).map_err(|e| format!("failed to write desktop identity: {}", e))
}

fn generate_uuid_v4() -> Result<String, String> {
    let file = File::open("/dev/urandom")
        .map_err(|error| format!("failed to generate desktop identity: {}", error))?;
    generate_uuid_v4_from_reader(file)
}

fn generate_uuid_v4_from_reader(mut reader: impl std::io::Read) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| format!("failed to generate desktop identity: {}", error))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    ))
}

fn is_desktop_uuid(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("desktop-") else {
        return false;
    };
    let bytes = uuid.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn generate_device_token() -> Result<String, String> {
    if let Ok(token) = std::env::var("KANNA_E2E_DEVICE_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    generate_random_hex(16)
}

fn generate_desktop_secret() -> Result<String, String> {
    generate_random_hex(32)
}

fn generate_random_hex(byte_count: usize) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    let mut bytes = vec![0u8; byte_count];
    File::open("/dev/urandom")
        .map_err(|e| format!("failed to open /dev/urandom: {}", e))?
        .read_exact(&mut bytes)
        .map_err(|e| format!("failed to read random bytes: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

fn default_desktop_name() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "Kanna Desktop".to_string())
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::{
        app_data_dir_for_server_config, build_server_config, current_server_version, desktop_id,
        escape_toml_string, generate_uuid_v4_from_reader, is_current_server_status,
        parse_lsof_pids, relay_url, resolved_db_path, server_base_url,
        server_config_matches_runtime, server_config_path_for_app_data_dir,
        server_lock_path_for_config, server_pids_on_port, stop_server_on_port, stopped_snapshot,
        try_claim_server_lock, MobileServerManager, MobileServerState, MobileServerStatus,
    };
    use std::ffi::CString;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;
    use std::process::{Command as StdCommand, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;
    use tokio::process::{Child, Command};

    fn env_lock() -> &'static Mutex<()> {
        crate::test_env_lock()
    }

    unsafe fn set_env_var(key: &str, value: &str) {
        let key = CString::new(key).expect("env key should be valid");
        let value = CString::new(value).expect("env value should be valid");
        assert_eq!(libc::setenv(key.as_ptr(), value.as_ptr(), 1), 0);
    }

    unsafe fn unset_env_var(key: &str) {
        let key = CString::new(key).expect("env key should be valid");
        assert_eq!(libc::unsetenv(key.as_ptr()), 0);
    }

    #[test]
    fn current_server_status_requires_matching_version() {
        let status = MobileServerStatus {
            state: "running".to_string(),
            desktop_id: "desktop-1".to_string(),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some(current_server_version().to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_code: None,
        };

        assert!(is_current_server_status(
            &status,
            "desktop-1",
            current_server_version()
        ));

        let stale_missing_version = MobileServerStatus {
            server_version: None,
            ..status.clone()
        };
        assert!(!is_current_server_status(
            &stale_missing_version,
            "desktop-1",
            current_server_version()
        ));

        let stale_wrong_version = MobileServerStatus {
            server_version: Some("__stale__".to_string()),
            ..status
        };
        assert!(!is_current_server_status(
            &stale_wrong_version,
            "desktop-1",
            current_server_version()
        ));
    }

    #[test]
    fn parse_lsof_pids_ignores_non_pid_lines() {
        assert_eq!(parse_lsof_pids("123\nnot-a-pid\n456\n"), vec![123, 456]);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_replaces_stale_server_with_same_desktop_id() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("replace-stale");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        let stale_config_path = root.join("stale-server.toml");
        configure_process_test_env(port, &db_path, &daemon_dir);
        create_test_database(&db_path);
        let manager = MobileServerManager::new(app_data_dir.clone());
        let expected_desktop_id = {
            let state = manager.inner.lock().await;
            desktop_id(&state.config_path).expect("desktop identity should be generated")
        };
        write_test_server_config(
            &stale_config_path,
            &db_path,
            &daemon_dir,
            &expected_desktop_id,
            None,
            None,
            port,
        );
        let mut stale_server = start_test_kanna_server(&stale_config_path, port).await;
        let stale_pid = stale_server.id().expect("stale server should have pid");

        manager
            .start()
            .await
            .expect("manager should replace stale server");
        stale_server
            .wait()
            .await
            .expect("stale server should have been reaped");
        assert!(
            !process_is_running(stale_pid),
            "stale kanna-server process should be stopped"
        );

        let status = manager
            .snapshot()
            .await
            .expect("replacement server should report status");
        assert_eq!(status.desktop_id, expected_desktop_id);
        assert_eq!(
            status.server_version.as_deref(),
            Some(current_server_version())
        );

        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_reuses_current_server_with_same_desktop_id() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("reuse-current");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        configure_process_test_env(port, &db_path, &daemon_dir);
        create_test_database(&db_path);
        let manager = MobileServerManager::new(app_data_dir.clone());
        let (expected_credential, existing_config_path) = {
            let state = manager.inner.lock().await;
            (
                super::desktop_credential(&state.config_path)
                    .expect("desktop credential should be generated"),
                state.config_path.clone(),
            )
        };
        let expected_desktop_id = expected_credential.desktop_id.clone();
        write_test_server_config(
            &existing_config_path,
            &db_path,
            &daemon_dir,
            &expected_desktop_id,
            Some(&expected_credential.desktop_secret),
            Some(current_server_version()),
            port,
        );
        let mut existing_server = start_test_kanna_server(&existing_config_path, port).await;

        manager
            .start()
            .await
            .expect("manager should reuse current server");
        assert!(
            existing_server
                .try_wait()
                .expect("server status should be readable")
                .is_none(),
            "current kanna-server should still be running"
        );

        let status = manager
            .snapshot()
            .await
            .expect("reused server should report status");
        assert_eq!(status.desktop_id, expected_desktop_id);
        assert_eq!(
            status.server_version.as_deref(),
            Some(current_server_version())
        );

        existing_server
            .kill()
            .await
            .expect("cleanup should stop server");
        let _ = existing_server.wait().await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_replaces_current_server_with_stale_runtime_config_before_task_create() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("replace-current-stale-runtime");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let intended_db_path = root.join("intended.db");
        let stale_db_path = root.join("stale.db");
        let intended_daemon_dir = root.join("intended-daemon");
        let stale_daemon_dir = root.join("stale-daemon");
        let repo_root = root.join("repo");
        let stale_config_path = root.join("stale-server.toml");
        init_test_git_repo(&repo_root);
        create_task_server_test_database(&stale_db_path, &repo_root, "claude");
        create_task_server_test_database(&intended_db_path, &repo_root, "copilot");
        let daemon_socket = daemon_socket_path_for_dir(&intended_daemon_dir);
        let daemon_server = spawn_one_task_create_daemon(&daemon_socket, "copilot").await;

        configure_process_test_env(port, &intended_db_path, &intended_daemon_dir);
        let manager = MobileServerManager::new(app_data_dir.clone());
        let expected_desktop_id = {
            let state = manager.inner.lock().await;
            desktop_id(&state.config_path).expect("desktop identity should be generated")
        };
        write_test_server_config(
            &stale_config_path,
            &stale_db_path,
            &stale_daemon_dir,
            &expected_desktop_id,
            None,
            Some(current_server_version()),
            port,
        );
        let mut stale_server = start_test_kanna_server(&stale_config_path, port).await;
        let stale_pid = stale_server.id().expect("stale server should have pid");

        manager
            .start()
            .await
            .expect("manager should replace same-version server with stale runtime config");
        stale_server
            .wait()
            .await
            .expect("stale server should have been reaped");
        assert!(
            !process_is_running(stale_pid),
            "same-version kanna-server with stale runtime config should be stopped"
        );

        let response = reqwest::Client::new()
            .post(format!("{}/v1/tasks", server_base_url(port)))
            .json(&serde_json::json!({
                "repoId": "repo-1",
                "prompt": "Use intended DB default provider"
            }))
            .send()
            .await
            .expect("task create request should reach replacement server");
        assert!(
            response.status().is_success(),
            "task create should succeed through replacement server: {}",
            response.text().await.unwrap_or_default()
        );

        let intended_provider = read_created_task_agent_provider(&intended_db_path);
        let stale_provider = read_created_task_agent_provider(&stale_db_path);
        assert_eq!(intended_provider.as_deref(), Some("copilot"));
        assert!(
            stale_provider.is_none(),
            "stale DB should not receive CLI-created task after manager replacement"
        );
        daemon_server
            .await
            .expect("fake daemon should observe copilot spawn");

        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        cleanup_process_test_env();
        let _ = std::fs::remove_file(daemon_socket);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_server_on_port_escalates_to_sigkill_when_sigterm_is_ignored() {
        let port = free_loopback_port();
        let mut child = start_sigterm_ignoring_listener(port).await;
        let child_pid = child.id().expect("listener should have pid");

        stop_server_on_port(port)
            .await
            .expect("shutdown should escalate and free the port");

        let status = child
            .wait()
            .await
            .expect("listener process should be reaped");
        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "SIGTERM-ignoring listener should be killed with SIGKILL"
        );
        assert!(
            !process_is_running(child_pid),
            "SIGTERM-ignoring listener should no longer be running"
        );
        assert!(
            server_pids_on_port(port).await.unwrap().is_empty(),
            "port should not have remaining listener pids"
        );
        let rebound = std::net::TcpListener::bind(("127.0.0.1", port))
            .expect("port should be reusable after stale listener is killed");
        drop(rebound);
    }

    #[test]
    fn escape_toml_string_escapes_quotes_and_backslashes() {
        assert_eq!(escape_toml_string(r#"foo\bar"baz"#), r#"foo\\bar\"baz"#);
    }

    #[test]
    fn desktop_id_is_persisted_per_app_instance_scope() {
        let root = unique_test_root("desktop-id");
        let first_config = root.join("main/Kanna/server.toml");
        let second_config = root.join("worktree/Kanna/servers/kanna-wt-task/server.toml");

        let first_id = desktop_id(&first_config).expect("first desktop identity should generate");
        let first_again = desktop_id(&first_config).expect("first desktop identity should be read");
        let second_id =
            desktop_id(&second_config).expect("second desktop identity should generate");

        assert_eq!(first_id, first_again);
        assert_ne!(first_id, second_id);
        assert!(first_id.starts_with("desktop-"));
        assert_eq!(first_id.len(), "desktop-".len() + 36);
        assert!(
            std::fs::read_to_string(root.join("main/Kanna/desktop-identity.json"))
                .unwrap()
                .contains(&first_id)
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_credential_persists_secret_and_stays_stable() {
        let root = unique_test_root("desktop-credential");
        let config_path = root.join("main/Kanna/server.toml");

        let first = super::desktop_credential(&config_path).expect("credential should generate");
        let second = super::desktop_credential(&config_path).expect("credential should re-read");

        assert_eq!(first, second);
        assert_eq!(first.desktop_secret.len(), 64);
        let written =
            std::fs::read_to_string(root.join("main/Kanna/desktop-identity.json")).unwrap();
        assert!(written.contains(&first.desktop_id));
        assert!(written.contains(&first.desktop_secret));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_credential_migrates_legacy_identity_preserving_id() {
        let root = unique_test_root("desktop-credential-migrate");
        let config_path = root.join("main/Kanna/server.toml");
        let identity_path = root.join("main/Kanna/desktop-identity.json");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        let legacy_id = "desktop-12345678-1234-4234-8234-123456789abc";
        std::fs::write(
            &identity_path,
            format!("{{\n  \"desktop_id\": \"{legacy_id}\"\n}}"),
        )
        .unwrap();

        let credential =
            super::desktop_credential(&config_path).expect("legacy identity should migrate");

        assert_eq!(credential.desktop_id, legacy_id);
        assert_eq!(credential.desktop_secret.len(), 64);
        let rewritten = std::fs::read_to_string(&identity_path).unwrap();
        assert!(rewritten.contains(&credential.desktop_secret));

        let again = super::desktop_credential(&config_path).unwrap();
        assert_eq!(again, credential);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            super::sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn uuid_generation_propagates_entropy_read_errors() {
        struct FailingReader;

        impl std::io::Read for FailingReader {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("entropy unavailable"))
            }
        }

        let error = generate_uuid_v4_from_reader(FailingReader).unwrap_err();

        assert!(error.contains("failed to generate desktop identity"));
        assert!(error.contains("entropy unavailable"));
    }

    #[test]
    fn server_base_url_uses_loopback() {
        assert_eq!(server_base_url(48120), "http://127.0.0.1:48120");
    }

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
    fn resolved_db_path_defaults_to_app_data_dir() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_DB_PATH");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
        };

        assert_eq!(
            resolved_db_path(&state).unwrap(),
            PathBuf::from("/tmp/build.kanna/kanna-v2.db")
        );
    }

    #[test]
    fn resolved_db_path_uses_kanna_db_name_inside_app_data_dir() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_DB_NAME", "kanna-wt-task-1234.db");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from(
                "/tmp/build.kanna/Kanna/servers/kanna-wt-task-1234/server.toml",
            ),
            started: false,
        };

        let resolved = resolved_db_path(&state).unwrap();

        unsafe {
            unset_env_var("KANNA_DB_NAME");
        }

        assert_eq!(
            resolved,
            PathBuf::from("/tmp/build.kanna/kanna-wt-task-1234.db")
        );
    }

    #[test]
    fn app_data_dir_resolution_supports_legacy_and_scoped_config_paths() {
        assert_eq!(
            app_data_dir_for_server_config(&PathBuf::from("/tmp/build.kanna/Kanna/server.toml"))
                .unwrap(),
            PathBuf::from("/tmp/build.kanna")
        );
        assert_eq!(
            app_data_dir_for_server_config(&PathBuf::from(
                "/tmp/build.kanna/Kanna/servers/kanna-v2/server.toml"
            ))
            .unwrap(),
            PathBuf::from("/tmp/build.kanna")
        );
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
        };

        let config = build_server_config(&state).unwrap();
        assert!(config.contains("relay_url = \"\""));
        assert!(config.contains("desktop_name = \"Studio Mac\""));
        let credential = super::desktop_credential(&state.config_path).unwrap();
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
        };

        let config = build_server_config(&state).unwrap();

        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
        }

        assert!(config.contains("relay_url = \"ws://127.0.0.1:19083\""));
    }

    #[test]
    fn relay_url_prefers_explicit_url() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            set_env_var("KANNA_RELAY_URL", "ws://relay.local:19080");
            set_env_var("KANNA_RELAY_PORT", "19083");
        }

        assert_eq!(relay_url(), "ws://relay.local:19080");

        unsafe {
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    #[test]
    fn relay_url_defaults_to_production_relay_for_release_builds() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }

        assert_eq!(super::relay_url_for_mode(false), "wss://relay.kanna.build");
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
        };
        let correct_config = build_server_config(&state).unwrap();
        let stale_config = correct_config.replace(
            "relay_url = \"ws://127.0.0.1:19083\"",
            "relay_url = \"wss://old-relay.example\"",
        );
        std::fs::write(&path, stale_config).unwrap();

        let desktop_id =
            desktop_id(&state.config_path).expect("desktop identity should be generated");

        assert!(!server_config_matches_runtime(&path, &desktop_id));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(&path, &desktop_id));

        let _ = std::fs::remove_file(path);
        unsafe {
            unset_env_var("KANNA_RELAY_PORT");
        }
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

        assert!(!server_config_matches_runtime(&path, &desktop_id));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(&path, &desktop_id));

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
        };
        let correct_config = build_server_config(&state).unwrap();
        let credential = super::desktop_credential(&path).unwrap();
        let desktop_id = credential.desktop_id.clone();
        let stale_config = correct_config.replace(
            &format!("desktop_secret = \"{}\"\n", credential.desktop_secret),
            "",
        );
        assert_ne!(stale_config, correct_config);
        std::fs::write(&path, stale_config).unwrap();

        assert!(!server_config_matches_runtime(&path, &desktop_id));

        std::fs::write(&path, correct_config).unwrap();
        assert!(server_config_matches_runtime(&path, &desktop_id));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stopped_snapshot_reflects_local_state() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
        }

        let state = MobileServerState {
            status: "stopped".to_string(),
            desktop_name: "Studio Mac".to_string(),
            api_base_url: server_base_url(48120),
            config_path: PathBuf::from("/tmp/build.kanna/Kanna/server.toml"),
            started: false,
        };

        let snapshot = stopped_snapshot(&state).expect("stopped snapshot should build");
        assert_eq!(snapshot.state, "stopped");
        assert_eq!(snapshot.desktop_name, "Studio Mac");
        assert_eq!(snapshot.lan_port, 48120);
        assert!(snapshot.pairing_code.is_none());
    }

    fn configure_process_test_env(
        port: u16,
        db_path: &std::path::Path,
        daemon_dir: &std::path::Path,
    ) {
        let sidecar_dir = test_sidecar_dir().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        unsafe {
            set_env_var("KANNA_MOBILE_SERVER_PORT", &port.to_string());
            set_env_var("KANNA_DB_PATH", &db_path.to_string_lossy());
            set_env_var("KANNA_DAEMON_DIR", &daemon_dir.to_string_lossy());
            set_env_var("KANNA_TEST_SIDECAR_DIR", &sidecar_dir.to_string_lossy());
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    fn cleanup_process_test_env() {
        unsafe {
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
            unset_env_var("KANNA_DB_PATH");
            unset_env_var("KANNA_DAEMON_DIR");
            unset_env_var("KANNA_TEST_SIDECAR_DIR");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    fn unique_test_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kanna-mobile-{prefix}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ))
    }

    fn free_loopback_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("free loopback port should be available");
        listener
            .local_addr()
            .expect("listener should have local addr")
            .port()
    }

    fn create_test_database(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("test db directory should be created");
        }
        let conn = rusqlite::Connection::open(path).expect("test db should be created");
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .expect("test db should enable WAL");
    }

    fn create_task_server_test_database(
        path: &std::path::Path,
        repo_path: &std::path::Path,
        default_provider: &str,
    ) {
        create_test_database(path);
        let conn = rusqlite::Connection::open(path).expect("test db should open");
        conn.execute_batch(
            r#"
            CREATE TABLE repo (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                default_branch TEXT,
                hidden INTEGER,
                created_at TEXT,
                last_opened_at TEXT
            );

            CREATE TABLE pipeline_item (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                issue_number INTEGER,
                issue_title TEXT,
                prompt TEXT,
                stage TEXT,
                pr_number INTEGER,
                pr_url TEXT,
                branch TEXT,
                agent_type TEXT,
                activity TEXT,
                activity_changed_at TEXT,
                pinned INTEGER,
                pin_order INTEGER,
                display_name TEXT,
                last_output_preview TEXT,
                created_at TEXT,
                updated_at TEXT,
                previous_stage TEXT,
                closed_at TEXT,
                pipeline TEXT,
                stage_result TEXT,
                active_post_action TEXT,
                tags TEXT,
                agent_provider TEXT,
                port_offset INTEGER,
                port_env TEXT,
                base_ref TEXT
            );

            CREATE TABLE worktree (
                id TEXT PRIMARY KEY,
                pipeline_item_id TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE terminal_session (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                pipeline_item_id TEXT,
                label TEXT,
                cwd TEXT,
                daemon_session_id TEXT
            );

            CREATE TABLE task_port (
                pipeline_item_id TEXT NOT NULL,
                env_name TEXT NOT NULL,
                port INTEGER NOT NULL,
                PRIMARY KEY (pipeline_item_id, env_name),
                UNIQUE (port)
            );
            "#,
        )
        .expect("test schema should be created");
        conn.execute(
            "INSERT INTO repo (id, path, name, default_branch, hidden, created_at, last_opened_at)
             VALUES ('repo-1', ?, 'Repo One', 'main', 0, datetime('now'), datetime('now'))",
            [repo_path.to_string_lossy().as_ref()],
        )
        .expect("test repo should be inserted");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('defaultAgentProvider', ?)",
            [default_provider],
        )
        .expect("default provider setting should be inserted");
    }

    fn read_created_task_agent_provider(path: &std::path::Path) -> Option<String> {
        let conn = rusqlite::Connection::open(path).expect("test db should open");
        conn.query_row(
            "SELECT agent_provider FROM pipeline_item ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok()
    }

    fn daemon_socket_path_for_dir(daemon_dir: &std::path::Path) -> PathBuf {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        daemon_dir.hash(&mut hasher);
        let hash = hasher.finish() as u32;
        PathBuf::from(format!("/tmp/kanna-{hash:08x}.sock"))
    }

    async fn spawn_one_task_create_daemon(
        socket_path: &std::path::Path,
        expected_agent_provider: &str,
    ) -> tokio::task::JoinHandle<()> {
        if let Some(parent) = socket_path.parent() {
            std::fs::create_dir_all(parent).expect("daemon socket parent should exist");
        }
        let _ = std::fs::remove_file(socket_path);
        let listener = UnixListener::bind(socket_path).expect("fake daemon socket should bind");
        let expected_agent_provider = expected_agent_provider.to_string();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("daemon should accept spawn");
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("daemon command should be readable");
            let command: serde_json::Value =
                serde_json::from_str(line.trim()).expect("daemon command should be JSON");
            assert_eq!(
                command.get("type").and_then(|value| value.as_str()),
                Some("Spawn")
            );
            assert_eq!(
                command
                    .get("agent_provider")
                    .and_then(|value| value.as_str()),
                Some(expected_agent_provider.as_str())
            );
            let session_id = command
                .get("session_id")
                .and_then(|value| value.as_str())
                .expect("spawn should include session id");
            write_half
                .write_all(
                    format!(
                        "{{\"type\":\"SessionCreated\",\"session_id\":{}}}\n",
                        serde_json::to_string(session_id).unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .expect("daemon response should be written");
        })
    }

    fn init_test_git_repo(repo_root: &std::path::Path) {
        let _ = std::fs::remove_dir_all(repo_root);
        std::fs::create_dir_all(repo_root).expect("repo directory should be created");
        std::fs::write(repo_root.join("README.md"), "test repo")
            .expect("repo seed file should be written");
        assert!(StdCommand::new("git")
            .arg("init")
            .arg("-b")
            .arg("main")
            .current_dir(repo_root)
            .status()
            .expect("git init should run")
            .success());
        assert!(StdCommand::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(repo_root)
            .status()
            .expect("git config user.email should run")
            .success());
        assert!(StdCommand::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(repo_root)
            .status()
            .expect("git config user.name should run")
            .success());
        assert!(StdCommand::new("git")
            .args(["add", "README.md"])
            .current_dir(repo_root)
            .status()
            .expect("git add should run")
            .success());
        assert!(StdCommand::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(repo_root)
            .status()
            .expect("git commit should run")
            .success());
    }

    fn write_test_server_config(
        config_path: &std::path::Path,
        db_path: &std::path::Path,
        daemon_dir: &std::path::Path,
        desktop_id: &str,
        desktop_secret: Option<&str>,
        server_version: Option<&str>,
        port: u16,
    ) {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).expect("server config directory should be created");
        }
        let secret_line = desktop_secret
            .map(|secret| format!("desktop_secret = \"{}\"\n", escape_toml_string(secret)))
            .unwrap_or_default();
        let version_line = server_version
            .map(|version| format!("server_version = \"{}\"\n", escape_toml_string(version)))
            .unwrap_or_default();
        let pairing_store_path = config_path.with_file_name("pairings.json");
        let relay_url = relay_url();
        let config = format!(
            "relay_url = \"{}\"\ndevice_token = \"test-token\"\ndaemon_dir = \"{}\"\ndb_path = \"{}\"\ndesktop_id = \"{}\"\n{}desktop_name = \"Kanna Test\"\n{}lan_host = \"127.0.0.1\"\nlan_port = {}\npairing_store_path = \"{}\"\n",
            escape_toml_string(&relay_url),
            escape_toml_string(&daemon_dir.to_string_lossy()),
            escape_toml_string(&db_path.to_string_lossy()),
            escape_toml_string(desktop_id),
            secret_line,
            version_line,
            port,
            escape_toml_string(&pairing_store_path.to_string_lossy()),
        );
        std::fs::write(config_path, config).expect("server config should be written");
    }

    async fn start_test_kanna_server(config_path: &std::path::Path, port: u16) -> Child {
        let sidecar = test_kanna_server_binary().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        let mut child = Command::new(sidecar)
            .env("KANNA_SERVER_CONFIG", config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("kanna-server should spawn");
        let base_url = server_base_url(port);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().expect("server status should be readable") {
                panic!("kanna-server exited early with {status}");
            }
            if reqwest::get(format!("{base_url}/v1/status"))
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return child;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = child.kill().await;
        panic!("timed out waiting for kanna-server on {base_url}");
    }

    async fn start_sigterm_ignoring_listener(port: u16) -> Child {
        let script = r#"
import signal
import socket
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen(1)
while True:
    time.sleep(1)
"#;
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("python3 should start SIGTERM-ignoring listener");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child
                .try_wait()
                .expect("listener status should be readable")
            {
                panic!("SIGTERM-ignoring listener exited early with {status}");
            }
            if !server_pids_on_port(port).await.unwrap().is_empty() {
                return child;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        panic!("timed out waiting for SIGTERM-ignoring listener on port {port}");
    }

    fn test_sidecar_dir() -> Option<PathBuf> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|desktop| desktop.parent())
            .and_then(|apps| apps.parent())
            .expect("manifest should be under apps/desktop/src-tauri");
        [
            manifest_dir.join("binaries"),
            repo_root
                .join(".build")
                .join(crate::commands::fs::current_target_triple())
                .join("debug"),
            repo_root.join(".build").join("debug"),
        ]
        .into_iter()
        .find(|dir| {
            dir.join(format!(
                "kanna-server-{}",
                crate::commands::fs::current_target_triple()
            ))
            .is_file()
                || dir.join("kanna-server").is_file()
        })
    }

    fn test_kanna_server_binary() -> Option<PathBuf> {
        let dir = test_sidecar_dir()?;
        let suffixed = dir.join(format!(
            "kanna-server-{}",
            crate::commands::fs::current_target_triple()
        ));
        if suffixed.is_file() {
            return Some(suffixed);
        }
        let unsuffixed = dir.join("kanna-server");
        if unsuffixed.is_file() {
            return Some(unsuffixed);
        }
        None
    }

    fn process_is_running(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
