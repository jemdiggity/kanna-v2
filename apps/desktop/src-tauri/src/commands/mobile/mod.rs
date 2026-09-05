use kanna_runtime_defaults::DesktopCloudEnvironment;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::{watch, Mutex};

mod cloud_env;
mod config;
mod process;

use config::{
    server_config_matches_runtime, server_config_path_for_app_data_dir,
    server_lock_path_for_config, try_claim_server_lock, write_server_config,
};
use process::{find_sidecar, server_pids_on_port, stop_server_on_port};

const LOCAL_SERVER_HOST: &str = "127.0.0.1";
const DEFAULT_LOCAL_SERVER_PORT: u16 = kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT;
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
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub environment: String,
    /// Deprecated compatibility alias for `version`.
    #[serde(default)]
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_code: Option<String>,
    /// Absent on legacy servers. Legacy identity-only status is intentionally
    /// not adoptable because it cannot prove the write path is live.
    #[serde(default)]
    pub write_path_health: Option<WritePathHealth>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritePathHealth {
    pub healthy: bool,
    pub status: String,
    pub active_workspace_commands: usize,
    pub max_workspace_commands: usize,
    pub long_running_workspace_commands: usize,
    pub oldest_workspace_command_seconds: Option<u64>,
}

/// Whether the account this desktop is signed into currently has a mobile
/// push device registered, as `kanna-server` learned from the relay's own
/// target resolution (`GET /v1/mobile/notifications/registration`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobilePushRegistrationStatus {
    /// `registered`, `noRegisteredDevices`, or `unavailable`.
    pub status: String,
    #[serde(default)]
    pub registered_device_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_devices_reason: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingSession {
    pub code: String,
    pub pairing_payload: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Clone)]
pub struct MobileServerManager {
    inner: Arc<Mutex<MobileServerState>>,
    /// Serializes `start()`. `started` is published before the sidecar is spawned so
    /// `snapshot()` and `stop()` can see the attempt, which means a caller arriving
    /// mid-startup would otherwise be told "already started" while the server is not yet
    /// listening. The frontend calls `ensure_mobile_server` and then immediately fetches
    /// `/v1/snapshot`, so that early `Ok` failed app initialization outright whenever the
    /// server took longer to come up than the frontend's fetch budget.
    start_gate: Arc<Mutex<()>>,
    server_lock: Arc<Mutex<Option<File>>>,
    server_pid_tx: watch::Sender<Option<u32>>,
    client: reqwest::Client,
}

#[derive(Debug)]
struct MobileServerState {
    status: String,
    desktop_name: String,
    api_base_url: String,
    config_path: PathBuf,
    started: bool,
    cloud_env: Option<DesktopCloudEnvironment>,
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
    #[cfg(test)]
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self::new_with_cloud_env(app_data_dir, None)
    }

    pub fn new_with_bundle_identifier(app_data_dir: PathBuf, bundle_identifier: &str) -> Self {
        Self::new_with_bundle_identifier_for_mode(
            app_data_dir,
            bundle_identifier,
            cfg!(debug_assertions),
        )
    }

    fn new_with_bundle_identifier_for_mode(
        app_data_dir: PathBuf,
        bundle_identifier: &str,
        debug_assertions: bool,
    ) -> Self {
        let cloud_env = kanna_runtime_defaults::desktop_cloud_environment_for_bundle_identifier(
            bundle_identifier,
            debug_assertions,
        );
        Self::new_with_cloud_env(app_data_dir, cloud_env)
    }

    fn new_with_cloud_env(
        app_data_dir: PathBuf,
        cloud_env: Option<DesktopCloudEnvironment>,
    ) -> Self {
        let config_path = server_config_path_for_app_data_dir(&app_data_dir);
        let (server_pid_tx, _) = watch::channel(None);
        Self {
            inner: Arc::new(Mutex::new(MobileServerState {
                status: "stopped".to_string(),
                desktop_name: default_desktop_name(),
                api_base_url: server_base_url(local_server_port_for_cloud_env(cloud_env)),
                config_path,
                started: false,
                cloud_env,
            })),
            start_gate: Arc::new(Mutex::new(())),
            server_lock: Arc::new(Mutex::new(None)),
            server_pid_tx,
            client: reqwest::Client::new(),
        }
    }

    pub(crate) fn server_pid_receiver(&self) -> watch::Receiver<Option<u32>> {
        self.server_pid_tx.subscribe()
    }

    /// Base URL of this instance's `kanna-server`, starting it if it is not
    /// already running. Unlike `start`, a live server short-circuits without
    /// re-probing status, so a caller on a request path (the transfer control
    /// proxies, the transfer event poller) pays only one HTTP hop.
    pub(crate) async fn ensure_started_base_url(&self) -> Result<String, String> {
        {
            let state = self.inner.lock().await;
            if state.started {
                return Ok(state.api_base_url.clone());
            }
        }
        self.start().await?;
        Ok(self.inner.lock().await.api_base_url.clone())
    }

    pub async fn start(&self) -> Result<(), String> {
        // Held for the whole attempt: callers that arrive while a start is in flight wait
        // for it and observe the finished result, rather than being told the server is
        // ready while it is still binding its port.
        let _start_gate = self.start_gate.lock().await;
        let (config_path, desktop_name, api_base_url, cloud_env) = {
            let state = self.inner.lock().await;
            if state.started {
                return Ok(());
            }
            (
                state.config_path.clone(),
                state.desktop_name.clone(),
                state.api_base_url.clone(),
                state.cloud_env,
            )
        };

        let expected_desktop_id = desktop_id(&config_path)?;
        let existing_status = self.fetch_status(&api_base_url).await.ok();
        if let Some(status) = existing_status {
            ensure_server_belongs_to_desktop(&status, &expected_desktop_id)?;
            if is_current_server_status(
                &status,
                &expected_desktop_id,
                current_server_version(),
                server_environment(cloud_env),
            ) && server_config_matches_runtime(&config_path, &expected_desktop_id, cloud_env)
            {
                adopt_native_desktop(&native_control_daemon_dir()).await?;
                let server_pid = listening_server_pid(cloud_env).await?;
                let mut state = self.inner.lock().await;
                state.started = true;
                state.status = status.state;
                state.desktop_name = status.desktop_name;
                self.server_pid_tx.send_replace(Some(server_pid));
                return Ok(());
            }
            stop_server_on_port(local_server_port_for_cloud_env(cloud_env)).await?;
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

        let desktop_executable = std::env::current_exe()
            .map_err(|error| format!("failed to resolve desktop executable: {error}"))?;
        let transfer_identity_env = match resolve_transfer_identity_env(&config_path) {
            Ok(env) => env,
            Err(error) => {
                let mut state = self.inner.lock().await;
                state.started = false;
                state.status = "error".to_string();
                *self.server_lock.lock().await = None;
                return Err(error);
            }
        };
        let mut child = match Command::new(server_bin)
            .env("KANNA_SERVER_CONFIG", &config_path)
            .env("KANNA_DESKTOP_EXECUTABLE", desktop_executable)
            .envs(transfer_identity_env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(server_stderr_log(&config_path))
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

        let server_pid = child
            .id()
            .ok_or_else(|| "spawned kanna-server has no process id".to_string())?;
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
        if let Err(error) = adopt_native_desktop(&native_control_daemon_dir()).await {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let mut state = self.inner.lock().await;
            state.started = false;
            state.status = "error".to_string();
            *self.server_lock.lock().await = None;
            return Err(error);
        }

        {
            let mut state = self.inner.lock().await;
            state.status = status.state.clone();
            state.desktop_name = status.desktop_name.clone();
        }
        self.server_pid_tx.send_replace(Some(server_pid));

        let state_handle = self.inner.clone();
        let lock_handle = self.server_lock.clone();
        let server_pid_tx = self.server_pid_tx.clone();
        tauri::async_runtime::spawn(async move {
            let exit = child.wait().await;
            server_pid_tx.send_replace(None);
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

    pub async fn create_pairing_session(&self) -> Result<MobilePairingSession, String> {
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
            .json::<MobilePairingSession>()
            .await
            .map_err(|e| format!("failed to parse pairing session response: {}", e))?;

        if pairing.code.is_empty() || pairing.pairing_payload.is_empty() {
            return Err("kanna-server returned an incomplete pairing session".to_string());
        }

        Ok(pairing)
    }

    pub async fn push_registration_status(&self) -> Result<MobilePushRegistrationStatus, String> {
        let api_base_url = {
            let state = self.inner.lock().await;
            if !state.started {
                return Err("kanna-server is not running".to_string());
            }
            state.api_base_url.clone()
        };
        let response = self
            .client
            .get(format!(
                "{}/v1/mobile/notifications/registration",
                api_base_url
            ))
            .send()
            .await
            .map_err(|e| format!("failed to fetch mobile push registration status: {}", e))?;
        let response = response
            .error_for_status()
            .map_err(|e| format!("mobile push registration status request failed: {}", e))?;
        response
            .json::<MobilePushRegistrationStatus>()
            .await
            .map_err(|e| format!("failed to decode mobile push registration status: {}", e))
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

async fn listening_server_pid(cloud_env: Option<DesktopCloudEnvironment>) -> Result<u32, String> {
    let pids = server_pids_on_port(local_server_port_for_cloud_env(cloud_env)).await?;
    let [pid] = pids.as_slice() else {
        return Err(format!(
            "expected exactly one kanna-server listener, found {}",
            pids.len()
        ));
    };
    u32::try_from(*pid).map_err(|_| format!("invalid kanna-server pid: {pid}"))
}

#[tauri::command]
pub async fn ensure_mobile_server(app: tauri::AppHandle) -> Result<(), String> {
    let manager = app.state::<MobileServerManager>();
    manager.start().await
}

pub(crate) async fn ensure_server_base_url(app: &tauri::AppHandle) -> Result<String, String> {
    app.state::<MobileServerManager>()
        .ensure_started_base_url()
        .await
}

/// Block until this instance's `kanna-server` is running. App startup already
/// starts it; a background consumer that starts its own would only contend for
/// the server lock and log a spurious failure on every boot.
pub(crate) async fn wait_for_server_started(app: &tauri::AppHandle) {
    let mut server_pid = app.state::<MobileServerManager>().server_pid_receiver();
    loop {
        // `borrow_and_update`, never `borrow`: plain `borrow` leaves the value
        // marked unseen, so `changed()` returns instantly on every iteration
        // and this becomes a spin that starves the whole Tauri async runtime —
        // the app never finishes starting.
        if server_pid.borrow_and_update().is_some() {
            return;
        }
        if server_pid.changed().await.is_err() {
            return;
        }
    }
}

#[tauri::command]
pub async fn mobile_server_status(app: tauri::AppHandle) -> Result<MobileServerStatus, String> {
    let manager = app.state::<MobileServerManager>();
    manager.snapshot().await
}

#[tauri::command]
pub async fn mobile_push_registration_status(
    app: tauri::AppHandle,
) -> Result<MobilePushRegistrationStatus, String> {
    let manager = app.state::<MobileServerManager>();
    manager.push_registration_status().await
}

#[tauri::command]
pub async fn create_mobile_pairing_session(
    app: tauri::AppHandle,
) -> Result<MobilePairingSession, String> {
    let manager = app.state::<MobileServerManager>();
    manager.create_pairing_session().await
}

/// Expose the desktop's cloud credential to the frontend so a signed-in user
/// can register this desktop in Firestore (`desktopCredentials/{desktopId}`). Only the
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

/// Hand the webview this desktop's local control credential.
///
/// The webview is a browser: it reaches `kanna-server` over the same loopback
/// port any web page can, so `kanna-server` no longer grants authority to a
/// loopback address alone (see `http_api::lan_trust`). This is the credential
/// that distinguishes the app's own window from a page the user happened to
/// open — it is readable only by a process running as the user, which a
/// cross-origin page is not.
///
/// The server writes the file (mode 0600) while it starts, so this waits for
/// the server rather than failing a caller that raced it.
#[tauri::command]
pub async fn local_control_credential(app: tauri::AppHandle) -> Result<String, String> {
    let manager = app.state::<MobileServerManager>();
    manager.start().await?;
    let config_path = {
        let state = manager.inner.lock().await;
        state.config_path.clone()
    };
    let token_path = local_control_credential_path(&config_path)?;
    let mut last_error = String::new();
    for _ in 0..100 {
        match std::fs::read_to_string(&token_path) {
            Ok(token) if !token.trim().is_empty() => return Ok(token.trim().to_string()),
            Ok(_) => last_error = "credential file is empty".to_string(),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(format!(
        "failed to read local control credential {}: {last_error}",
        token_path.display()
    ))
}

/// Mirrors `kanna_server::config::Config::task_events_token_path`: the
/// credential sits beside the pairing store, which sits beside the server
/// config. Keep the two in step.
fn local_control_credential_path(config_path: &Path) -> Result<PathBuf, String> {
    Ok(config_path
        .parent()
        .ok_or_else(|| "server config path missing parent directory".to_string())?
        .join("task-events.token"))
}

fn native_control_daemon_dir() -> PathBuf {
    std::env::var("KANNA_DAEMON_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate::daemon_data_dir())
}

async fn adopt_native_desktop(daemon_dir: &Path) -> Result<(), String> {
    send_native_control_request(
        daemon_dir,
        &serde_json::json!({ "action": "adopt_desktop" }),
    )
    .await
    .map(|_| ())
}

async fn send_native_control_request(
    daemon_dir: &Path,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let socket_path = kanna_runtime_defaults::human_control_socket_path(daemon_dir);
    let mut stream = UnixStream::connect(&socket_path)
        .await
        .map_err(|error| format!("failed to connect to native desktop control: {error}"))?;
    let mut encoded = serde_json::to_vec(request)
        .map_err(|error| format!("failed to encode native desktop request: {error}"))?;
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .await
        .map_err(|error| format!("failed to send native desktop request: {error}"))?;
    let mut response = String::new();
    BufReader::new(stream)
        .read_line(&mut response)
        .await
        .map_err(|error| format!("failed to read native desktop response: {error}"))?;
    let response: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("failed to decode native desktop response: {error}"))?;
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("native desktop request failed")
            .to_string());
    }
    Ok(response)
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

/// Peer identity for the transfer sidecar, resolved once here and handed to
/// `kanna-server` at spawn.
///
/// The desktop keeps this derivation because it owns the two inputs: the Tauri
/// app data directory that holds `transfer/identity.json`, and the machine
/// name. `kanna-server` spawns the sidecar but never re-derives any of it.
/// Explicit environment overrides still win, which is how the E2E harness and
/// `kd` give each parallel instance its own peer id and registry.
fn resolve_transfer_identity_env(config_path: &Path) -> Result<Vec<(String, String)>, String> {
    let app_data_dir = app_data_dir_for_server_config(config_path)?;
    let transfer_root = crate::transfer_identity::resolve_transfer_root(&app_data_dir);
    let resolved = crate::transfer_identity::resolve_transfer_identity_for_root(
        &transfer_root,
        crate::transfer_identity::current_machine_name().as_deref(),
    )?;
    let mut env = vec![
        (
            "KANNA_TRANSFER_ROOT".to_string(),
            transfer_root.to_string_lossy().into_owned(),
        ),
        (
            "KANNA_TRANSFER_REGISTRY_DIR".to_string(),
            env_override("KANNA_TRANSFER_REGISTRY_DIR").unwrap_or_else(|| {
                transfer_root
                    .join("registry")
                    .to_string_lossy()
                    .into_owned()
            }),
        ),
        (
            "KANNA_TRANSFER_PEER_ID".to_string(),
            env_override("KANNA_TRANSFER_PEER_ID").unwrap_or(resolved.peer_id),
        ),
        (
            "KANNA_TRANSFER_DISPLAY_NAME".to_string(),
            env_override("KANNA_TRANSFER_DISPLAY_NAME").unwrap_or(resolved.display_name),
        ),
    ];
    if let Some(discovery) = env_override("KANNA_TRANSFER_DISCOVERY") {
        env.push(("KANNA_TRANSFER_DISCOVERY".to_string(), discovery));
    }
    Ok(env)
}

fn env_override(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

/// kanna-server logs through env_logger to stderr; discarding it leaves API
/// 500s with no server-side record anywhere. Append stderr to a log file next
/// to `server.toml` (the same directory the daemon logs into). Errors-only by
/// default, so the file stays small.
fn server_stderr_log(config_path: &Path) -> std::process::Stdio {
    let Some(dir) = config_path.parent() else {
        eprintln!("[mobile] cannot derive kanna-server log directory; discarding server stderr");
        return std::process::Stdio::null();
    };
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("kanna-server.log"))
    {
        Ok(file) => std::process::Stdio::from(file),
        Err(err) => {
            eprintln!("[mobile] failed to open kanna-server.log: {err}; discarding server stderr");
            std::process::Stdio::null()
        }
    }
}

fn local_server_port_for_cloud_env(cloud_env: Option<DesktopCloudEnvironment>) -> u16 {
    std::env::var("KANNA_MOBILE_SERVER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(|| {
            cloud_env::effective_cloud_env(cloud_env)
                .map(|env| env.mobile_server_port())
                .unwrap_or(DEFAULT_LOCAL_SERVER_PORT)
        })
}

fn local_transfer_port_for_cloud_env(cloud_env: Option<DesktopCloudEnvironment>) -> u16 {
    std::env::var("KANNA_TRANSFER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or_else(|| {
            cloud_env::effective_cloud_env(cloud_env)
                .map(|env| env.transfer_port())
                .unwrap_or(kanna_runtime_defaults::DEFAULT_TRANSFER_PORT)
        })
}

fn server_base_url(port: u16) -> String {
    format!("http://{}:{}", LOCAL_SERVER_HOST, port)
}

fn stopped_snapshot(state: &MobileServerState) -> Result<MobileServerStatus, String> {
    Ok(MobileServerStatus {
        state: state.status.clone(),
        desktop_id: desktop_id(&state.config_path)?,
        desktop_name: state.desktop_name.clone(),
        version: current_server_version().to_string(),
        environment: server_environment(state.cloud_env).to_string(),
        server_version: Some(current_server_version().to_string()),
        lan_host: "0.0.0.0".to_string(),
        lan_port: local_server_port_for_cloud_env(state.cloud_env),
        pairing_code: None,
        write_path_health: Some(WritePathHealth {
            healthy: true,
            status: "healthy".to_string(),
            active_workspace_commands: 0,
            max_workspace_commands: 4,
            long_running_workspace_commands: 0,
            oldest_workspace_command_seconds: None,
        }),
    })
}

fn current_server_version() -> &'static str {
    crate::KANNA_VERSION
}

fn server_environment(cloud_env: Option<DesktopCloudEnvironment>) -> &'static str {
    cloud_env
        .map(DesktopCloudEnvironment::as_str)
        .unwrap_or("development")
}

fn is_current_server_status(
    status: &MobileServerStatus,
    expected_desktop_id: &str,
    expected_version: &str,
    expected_environment: &str,
) -> bool {
    status.desktop_id == expected_desktop_id
        && status.version == expected_version
        && status.environment == expected_environment
        && status
            .write_path_health
            .as_ref()
            .is_some_and(|health| health.healthy)
}

fn ensure_server_belongs_to_desktop(
    status: &MobileServerStatus,
    expected_desktop_id: &str,
) -> Result<(), String> {
    if status.desktop_id == expected_desktop_id {
        return Ok(());
    }
    if is_legacy_short_desktop_identity(&status.desktop_id)
        && is_desktop_uuid_identity(expected_desktop_id)
    {
        return Ok(());
    }
    Err(format!(
        "kanna-server port is already owned by {} ({})",
        status.desktop_name, status.desktop_id
    ))
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
    if is_valid_desktop_identity(&parsed.desktop_id) {
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

fn is_valid_desktop_identity(value: &str) -> bool {
    is_legacy_short_desktop_identity(value) || is_desktop_uuid_identity(value)
}

fn is_legacy_short_desktop_identity(value: &str) -> bool {
    let Some(id) = value.strip_prefix("desktop-") else {
        return false;
    };
    let bytes = id.as_bytes();
    bytes.len() == 8 && bytes.iter().all(|byte| byte.is_ascii_hexdigit())
}

fn is_desktop_uuid_identity(value: &str) -> bool {
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

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file =
        File::open(path).map_err(|e| format!("failed to open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{:02x}", b)).collect())
}

const GENERIC_DESKTOP_NAME: &str = "Kanna Desktop";

fn default_desktop_name() -> String {
    if let Ok(configured_name) = std::env::var("KANNA_TRANSFER_DISPLAY_NAME") {
        let trimmed = configured_name.trim();
        if !trimmed.is_empty() && trimmed != GENERIC_DESKTOP_NAME {
            return trimmed.to_string();
        }
    }
    default_desktop_name_from_sources(
        system_computer_name(),
        std::env::var("COMPUTERNAME")
            .ok()
            .or_else(|| std::env::var("HOSTNAME").ok()),
        system_host_name(),
    )
}

fn default_desktop_name_from_sources(
    computer_name: Option<String>,
    env_host_name: Option<String>,
    system_host_name: Option<String>,
) -> String {
    [computer_name, env_host_name, system_host_name]
        .into_iter()
        .flatten()
        .find_map(|name| {
            let trimmed = name.trim();
            if trimmed.is_empty() || trimmed == GENERIC_DESKTOP_NAME {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .unwrap_or_else(|| GENERIC_DESKTOP_NAME.to_string())
}

#[cfg(target_os = "macos")]
fn system_computer_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn system_computer_name() -> Option<String> {
    None
}

fn system_host_name() -> Option<String> {
    let mut buffer = [0_u8; 256];
    let result =
        unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
    if result != 0 {
        return None;
    }
    let len = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    String::from_utf8(buffer[..len].to_vec())
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::cloud_env::relay_url;
    use super::config::{build_server_config, sidecar_sha256_config_line};
    use super::{
        adopt_native_desktop, app_data_dir_for_server_config, current_server_version,
        default_desktop_name_from_sources, desktop_id, escape_toml_string,
        generate_uuid_v4_from_reader, is_current_server_status, listening_server_pid,
        resolved_db_path, server_base_url, server_stderr_log, stop_server_on_port,
        stopped_snapshot, MobilePairingSession, MobileServerManager, MobileServerState,
        MobileServerStatus, WritePathHealth,
    };
    use crate::daemon_client::DaemonClient;
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::{Command as StdCommand, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::process::{Child, Command};

    const RESTART_ORDINARY_SESSION: &str = "shell-restart-ordinary";
    const RESTART_LEGACY_PROTECTED_SESSION: &str = "shell-restart-legacy-protected";

    pub(super) fn env_lock() -> &'static Mutex<()> {
        crate::test_env_lock()
    }

    pub(super) unsafe fn set_env_var(key: &str, value: &str) {
        let key = CString::new(key).expect("env key should be valid");
        let value = CString::new(value).expect("env value should be valid");
        assert_eq!(libc::setenv(key.as_ptr(), value.as_ptr(), 1), 0);
    }

    pub(super) unsafe fn unset_env_var(key: &str) {
        let key = CString::new(key).expect("env key should be valid");
        assert_eq!(libc::unsetenv(key.as_ptr()), 0);
    }

    /// The desktop is the single owner of transfer identity: it resolves the
    /// peer id from `identity.json`, the display name from the machine name,
    /// and passes both to `kanna-server`, which forwards them to the sidecar
    /// without re-deriving anything.
    #[test]
    fn transfer_identity_env_resolves_peer_identity_for_the_server() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("transfer-identity-env");
        let config_path = root.join("Kanna").join("server.toml");
        unsafe {
            unset_env_var("KANNA_TRANSFER_ROOT");
            unset_env_var("KANNA_TRANSFER_REGISTRY_DIR");
            unset_env_var("KANNA_TRANSFER_PEER_ID");
            unset_env_var("KANNA_TRANSFER_DISPLAY_NAME");
        }

        let env: HashMap<String, String> = super::resolve_transfer_identity_env(&config_path)
            .expect("transfer identity env should resolve")
            .into_iter()
            .collect();
        let transfer_root = root.join("transfer");
        assert_eq!(
            env.get("KANNA_TRANSFER_ROOT").map(String::as_str),
            Some(transfer_root.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get("KANNA_TRANSFER_REGISTRY_DIR").map(String::as_str),
            Some(transfer_root.join("registry").to_string_lossy().as_ref())
        );
        assert!(
            transfer_root.join("identity.json").exists(),
            "resolving must create the identity the sidecar advertises"
        );
        let peer_id = env
            .get("KANNA_TRANSFER_PEER_ID")
            .expect("peer id")
            .to_string();
        assert!(!peer_id.is_empty());
        assert!(env
            .get("KANNA_TRANSFER_DISPLAY_NAME")
            .is_some_and(|name| !name.is_empty()));

        // Resolving twice is stable: the sidecar must not change peer identity
        // across server restarts.
        let again: HashMap<String, String> = super::resolve_transfer_identity_env(&config_path)
            .expect("transfer identity env should resolve")
            .into_iter()
            .collect();
        assert_eq!(again.get("KANNA_TRANSFER_PEER_ID"), Some(&peer_id));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Parallel instances (the E2E two-instance harness, `kd` worktrees) give
    /// each desktop its own peer id and registry through the environment; that
    /// override has to survive the hop through kanna-server.
    #[test]
    fn transfer_identity_env_lets_explicit_overrides_win() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("transfer-identity-override");
        let config_path = root.join("Kanna").join("server.toml");
        let registry = root.join("shared-registry");
        unsafe {
            set_env_var(
                "KANNA_TRANSFER_ROOT",
                root.join("custom").to_string_lossy().as_ref(),
            );
            set_env_var(
                "KANNA_TRANSFER_REGISTRY_DIR",
                registry.to_string_lossy().as_ref(),
            );
            set_env_var("KANNA_TRANSFER_PEER_ID", "peer-secondary");
            set_env_var("KANNA_TRANSFER_DISPLAY_NAME", "Secondary");
        }

        let env: HashMap<String, String> = super::resolve_transfer_identity_env(&config_path)
            .expect("transfer identity env should resolve")
            .into_iter()
            .collect();
        assert_eq!(
            env.get("KANNA_TRANSFER_ROOT").map(String::as_str),
            Some(root.join("custom").to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get("KANNA_TRANSFER_REGISTRY_DIR").map(String::as_str),
            Some(registry.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get("KANNA_TRANSFER_PEER_ID").map(String::as_str),
            Some("peer-secondary")
        );
        assert_eq!(
            env.get("KANNA_TRANSFER_DISPLAY_NAME").map(String::as_str),
            Some("Secondary")
        );

        unsafe {
            unset_env_var("KANNA_TRANSFER_ROOT");
            unset_env_var("KANNA_TRANSFER_REGISTRY_DIR");
            unset_env_var("KANNA_TRANSFER_PEER_ID");
            unset_env_var("KANNA_TRANSFER_DISPLAY_NAME");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn default_desktop_name_prefers_system_computer_name() {
        assert_eq!(
            default_desktop_name_from_sources(
                Some("Gus MacBook Pro".to_string()),
                Some("hostname.local".to_string()),
                Some("kernel-host".to_string()),
            ),
            "Gus MacBook Pro"
        );
    }

    #[test]
    fn mobile_pairing_session_deserializes_privileged_response() {
        let session: MobilePairingSession = serde_json::from_value(serde_json::json!({
            "code": "ABC123",
            "pairingPayload": "KANNA1:DESKTOP-1:ABC123",
            "desktopId": "desktop-1",
            "desktopName": "Studio Mac",
            "lanHost": "192.168.1.10",
            "lanPort": 48120,
            "expiresAtUnixMs": 1_800_000
        }))
        .expect("pairing response should deserialize");

        assert_eq!(session.code, "ABC123");
        assert_eq!(session.desktop_id, "desktop-1");
        assert_eq!(session.pairing_payload, "KANNA1:DESKTOP-1:ABC123");
    }

    #[test]
    fn default_desktop_name_ignores_blank_and_generic_sources() {
        assert_eq!(
            default_desktop_name_from_sources(
                Some("  ".to_string()),
                Some("Kanna Desktop".to_string()),
                Some("Gus-MacBook-Pro.local".to_string()),
            ),
            "Gus-MacBook-Pro.local"
        );
    }

    #[test]
    fn server_stderr_log_appends_to_file_beside_server_config() {
        let root = std::env::temp_dir().join(format!(
            "kanna-server-stderr-log-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create log dir");
        let config_path = root.join("server.toml");
        let log_path = root.join("kanna-server.log");
        std::fs::write(&log_path, "earlier run\n").expect("seed log");

        let stdio = server_stderr_log(&config_path);
        let status = StdCommand::new("/bin/sh")
            .args(["-c", "echo server error >&2"])
            .stderr(stdio)
            .status()
            .expect("run child with captured stderr");
        assert!(status.success());

        let contents = std::fs::read_to_string(&log_path).expect("read log");
        assert!(
            contents.starts_with("earlier run\n"),
            "log must append, not truncate: {contents}"
        );
        assert!(contents.contains("server error"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn current_server_status_requires_matching_build_metadata() {
        let status = MobileServerStatus {
            state: "running".to_string(),
            desktop_id: "desktop-1".to_string(),
            desktop_name: "Studio Mac".to_string(),
            version: current_server_version().to_string(),
            environment: "production".to_string(),
            server_version: Some(current_server_version().to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_code: None,
            write_path_health: Some(WritePathHealth {
                healthy: true,
                status: "healthy".to_string(),
                active_workspace_commands: 0,
                max_workspace_commands: 4,
                long_running_workspace_commands: 0,
                oldest_workspace_command_seconds: None,
            }),
        };

        assert!(is_current_server_status(
            &status,
            "desktop-1",
            current_server_version(),
            "production",
        ));
        assert_eq!(
            status.server_version.as_deref(),
            Some(current_server_version())
        );
        let full_capacity_busy = MobileServerStatus {
            write_path_health: Some(WritePathHealth {
                healthy: true,
                status: "busy".to_string(),
                active_workspace_commands: 4,
                max_workspace_commands: 4,
                long_running_workspace_commands: 0,
                oldest_workspace_command_seconds: Some(30),
            }),
            ..status.clone()
        };
        assert!(is_current_server_status(
            &full_capacity_busy,
            "desktop-1",
            current_server_version(),
            "production",
        ));
        let unhealthy = MobileServerStatus {
            write_path_health: Some(WritePathHealth {
                healthy: false,
                status: "degraded".to_string(),
                active_workspace_commands: 4,
                max_workspace_commands: 4,
                long_running_workspace_commands: 1,
                oldest_workspace_command_seconds: Some(601),
            }),
            ..status.clone()
        };
        assert!(!is_current_server_status(
            &unhealthy,
            "desktop-1",
            current_server_version(),
            "production",
        ));

        let stale_wrong_version = MobileServerStatus {
            version: "__stale__".to_string(),
            ..status.clone()
        };
        assert!(!is_current_server_status(
            &stale_wrong_version,
            "desktop-1",
            current_server_version(),
            "production",
        ));

        let stale_wrong_environment = MobileServerStatus {
            environment: "staging".to_string(),
            ..status
        };
        assert!(!is_current_server_status(
            &stale_wrong_environment,
            "desktop-1",
            current_server_version(),
            "production",
        ));
    }

    #[test]
    fn legacy_status_without_build_metadata_remains_identifiable_as_stale() {
        let status: MobileServerStatus = serde_json::from_value(serde_json::json!({
            "state": "running",
            "desktopId": "desktop-legacy",
            "desktopName": "Legacy Desktop",
            "serverVersion": "0.0.68",
            "lanHost": "0.0.0.0",
            "lanPort": 48120,
            "pairingCode": null
        }))
        .expect("legacy status should remain decodable for safe replacement");

        assert_eq!(status.desktop_id, "desktop-legacy");
        assert!(status.version.is_empty());
        assert!(status.environment.is_empty());
        assert_eq!(
            serde_json::to_value(&status).unwrap()["serverVersion"],
            "0.0.68"
        );
        assert!(!is_current_server_status(
            &status,
            "desktop-legacy",
            current_server_version(),
            "production",
        ));
    }

    /// Installs a `kanna-server` sidecar that stalls before exec'ing the real one, so a
    /// slow startup is reproducible instead of depending on machine load.
    fn install_slow_kanna_server_sidecar(root: &std::path::Path, delay: Duration) -> PathBuf {
        let real = test_kanna_server_binary().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        let dir = root.join("slow-sidecar");
        std::fs::create_dir_all(&dir).expect("slow sidecar dir should be created");
        let script = dir.join("kanna-server");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep {}\nexec {:?} \"$@\"\n",
                delay.as_secs_f32(),
                real
            ),
        )
        .expect("slow sidecar script should be written");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("slow sidecar script should be executable");
        dir
    }

    /// A start that is still in flight must not report success: the frontend calls
    /// `ensure_mobile_server` and then fetches `/v1/snapshot` straight away, so an early
    /// `Ok` failed app initialization with `[init] fatal: TypeError: Load failed`.
    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn start_reports_success_only_once_the_server_answers() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("concurrent-start");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        configure_process_test_env(port, &db_path, &daemon_dir);
        let slow_sidecar_dir = install_slow_kanna_server_sidecar(&root, Duration::from_secs(3));
        unsafe {
            set_env_var(
                "KANNA_TEST_SIDECAR_DIR",
                &slow_sidecar_dir.to_string_lossy(),
            );
        }
        create_test_database(&db_path);
        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;
        let manager = MobileServerManager::new(app_data_dir.clone());

        let first_starter = manager.clone();
        let first_start = tokio::spawn(async move { first_starter.start().await });
        // Long enough for the first attempt to publish `started` and spawn the sidecar,
        // well short of the sidecar becoming reachable.
        tokio::time::sleep(Duration::from_millis(500)).await;

        let concurrent_start = manager.start().await;
        let status_after_start = reqwest::get(format!("{}/v1/status", server_base_url(port)))
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);

        let first_result = first_start.await.expect("first start task should finish");
        let _ = stop_server_on_port(port).await;
        daemon.kill().await.expect("cleanup should stop daemon");
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(&root);

        first_result.expect("first start should succeed");
        concurrent_start.expect("concurrent start should succeed");
        assert!(
            status_after_start,
            "start() returned before kanna-server answered /v1/status"
        );
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
            "__stale__",
            port,
        );
        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;
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
        assert_eq!(status.version, current_server_version());
        assert_eq!(status.environment, "development");
        assert_eq!(
            status.server_version.as_deref(),
            Some(status.version.as_str())
        );

        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        daemon
            .kill()
            .await
            .expect("cleanup should stop test daemon");
        let _ = daemon.wait().await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_replaces_unhealthy_current_server() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("replace-unhealthy-current");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        configure_process_test_env(port, &db_path, &daemon_dir);
        create_test_database(&db_path);
        let manager = MobileServerManager::new(app_data_dir.clone());
        let (expected_desktop_id, current_config_path, current_config) = {
            let state = manager.inner.lock().await;
            let expected_desktop_id =
                desktop_id(&state.config_path).expect("desktop identity should be generated");
            let current_config =
                build_server_config(&state).expect("current server config should build");
            (
                expected_desktop_id,
                state.config_path.clone(),
                current_config,
            )
        };
        std::fs::create_dir_all(current_config_path.parent().unwrap()).unwrap();
        std::fs::write(&current_config_path, current_config)
            .expect("current server config should be written");
        let mut unhealthy_server = start_unhealthy_status_server(port, &expected_desktop_id).await;
        let unhealthy_pid = unhealthy_server
            .id()
            .expect("unhealthy server should have pid");
        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;

        manager
            .start()
            .await
            .expect("manager should replace unhealthy current server");
        tokio::time::timeout(Duration::from_secs(5), unhealthy_server.wait())
            .await
            .expect("unhealthy server should exit promptly")
            .expect("unhealthy server should have been reaped");
        assert!(
            !process_is_running(unhealthy_pid),
            "unhealthy kanna-server process should be stopped"
        );

        let status = manager
            .snapshot()
            .await
            .expect("replacement server should report status");
        assert_eq!(status.desktop_id, expected_desktop_id);
        assert_eq!(status.version, current_server_version());
        assert_eq!(status.environment, "development");
        assert!(
            status
                .write_path_health
                .as_ref()
                .is_some_and(|health| health.healthy),
            "replacement server should report a healthy write path: {status:?}"
        );

        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        daemon
            .kill()
            .await
            .expect("cleanup should stop test daemon");
        let _ = daemon.wait().await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_replaces_stale_legacy_short_id_server_after_identity_was_regenerated() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("replace-stale-legacy-short-id");
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
        let stale_desktop_id = "desktop-ea554bc4";
        assert_ne!(expected_desktop_id, stale_desktop_id);
        write_test_server_config(
            &stale_config_path,
            &db_path,
            &daemon_dir,
            stale_desktop_id,
            "__stale__",
            port,
        );
        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;
        let mut stale_server = start_test_kanna_server(&stale_config_path, port).await;
        let stale_pid = stale_server.id().expect("stale server should have pid");

        manager
            .start()
            .await
            .expect("manager should replace stale legacy short-id server");
        stale_server
            .wait()
            .await
            .expect("stale server should have been reaped");
        assert!(
            !process_is_running(stale_pid),
            "stale legacy kanna-server process should be stopped"
        );

        let status = manager
            .snapshot()
            .await
            .expect("replacement server should report status");
        assert_eq!(status.desktop_id, expected_desktop_id);
        assert_eq!(status.version, current_server_version());
        assert_eq!(status.environment, "development");
        assert_eq!(
            status.server_version.as_deref(),
            Some(status.version.as_str())
        );

        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        daemon
            .kill()
            .await
            .expect("cleanup should stop test daemon");
        let _ = daemon.wait().await;
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
        let current_config = {
            let state = manager.inner.lock().await;
            build_server_config(&state).expect("current server config should build")
        };
        std::fs::create_dir_all(existing_config_path.parent().unwrap()).unwrap();
        std::fs::write(&existing_config_path, current_config)
            .expect("current server config should be written");
        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;
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
        assert_eq!(status.version, current_server_version());
        assert_eq!(status.environment, "development");
        assert_eq!(
            status.server_version.as_deref(),
            Some(status.version.as_str())
        );

        existing_server
            .kill()
            .await
            .expect("cleanup should stop server");
        let _ = existing_server.wait().await;
        daemon
            .kill()
            .await
            .expect("cleanup should stop test daemon");
        let _ = daemon.wait().await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    /// Subprocess fixture for `manager_adopts_server_after_original_desktop_exits`.
    /// It makes the server's pinned parent a short-lived process with the same
    /// executable path as the replacement test process.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn desktop_restart_parent_fixture() {
        let config_path = std::env::var_os("KANNA_RESTART_FIXTURE_CONFIG")
            .map(PathBuf::from)
            .expect("fixture config path");
        let daemon_dir = std::env::var_os("KANNA_DAEMON_DIR")
            .map(PathBuf::from)
            .expect("fixture daemon directory");
        let port = std::env::var("KANNA_RESTART_FIXTURE_PORT")
            .expect("fixture port")
            .parse::<u16>()
            .expect("numeric fixture port");
        let lifecycle_log_fd = std::env::var("KANNA_RESTART_FIXTURE_LOG_FD")
            .expect("fixture lifecycle log fd")
            .parse::<libc::c_int>()
            .expect("numeric fixture lifecycle log fd");
        // Production starts kanna-server and a fresh daemon generation from
        // the same desktop lifetime. Keep both children alive after this
        // short-lived fixture exits so the parent test can exercise restart
        // adoption and the next real daemon handoff.
        let daemon = start_test_kanna_daemon(&daemon_dir).await;
        let lifecycle_log = unsafe { OwnedFd::from_raw_fd(lifecycle_log_fd) };
        let server =
            start_test_kanna_server_with_stderr(&config_path, port, Stdio::from(lifecycle_log))
                .await;
        spawn_restart_terminal(&daemon_dir, RESTART_ORDINARY_SESSION, false).await;
        // Preserve a legacy DB classification so the replacement generation
        // proves it clears the rejected native-terminal-only policy.
        spawn_restart_terminal(&daemon_dir, RESTART_LEGACY_PROTECTED_SESSION, true).await;
        std::mem::forget(server);
        std::mem::forget(daemon);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn manager_adopts_server_after_original_desktop_exits() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("adopt-after-desktop-restart");
        let port = free_loopback_port();
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        configure_process_test_env(port, &db_path, &daemon_dir);
        create_test_database(&db_path);
        let manager = MobileServerManager::new(app_data_dir);
        let config_path = {
            let state = manager.inner.lock().await;
            let config = build_server_config(&state).expect("current server config should build");
            std::fs::create_dir_all(state.config_path.parent().unwrap()).unwrap();
            std::fs::write(&state.config_path, config).unwrap();
            state.config_path.clone()
        };

        let (restart_log_reader, restart_log_writer) =
            std::os::unix::net::UnixStream::pair().expect("restart lifecycle log socket pair");
        let log_fd = restart_log_writer.as_raw_fd();
        let log_fd_flags = unsafe { libc::fcntl(log_fd, libc::F_GETFD) };
        assert_ne!(
            log_fd_flags, -1,
            "restart lifecycle log fd should be readable"
        );
        assert_ne!(
            unsafe { libc::fcntl(log_fd, libc::F_SETFD, log_fd_flags & !libc::FD_CLOEXEC) },
            -1,
            "restart lifecycle log fd should be inherited by the fixture"
        );

        let fixture_status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "commands::mobile::tests::desktop_restart_parent_fixture",
            ])
            .env("KANNA_RESTART_FIXTURE_CONFIG", &config_path)
            .env("KANNA_RESTART_FIXTURE_PORT", port.to_string())
            .env("KANNA_RESTART_FIXTURE_LOG_FD", log_fd.to_string())
            .env("RUST_LOG", "kanna_server::runtime=info")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("restart fixture should launch the surviving server");
        drop(restart_log_writer);
        assert!(fixture_status.success());
        restart_log_reader
            .set_nonblocking(true)
            .expect("restart lifecycle log reader should become nonblocking");
        let mut restart_log = BufReader::new(
            tokio::net::UnixStream::from_std(restart_log_reader)
                .expect("restart lifecycle log should become async"),
        );

        manager
            .start()
            .await
            .expect("replacement desktop should adopt the surviving server");
        let status = manager.snapshot().await.expect("adopted server status");
        assert_eq!(status.version, current_server_version());
        // A second authenticated control request proves the transfer was
        // durable, rather than merely allowing the one adoption request.
        adopt_native_desktop(&daemon_dir)
            .await
            .expect("adopted desktop should retain native authority");

        let server_pid = listening_server_pid(None)
            .await
            .expect("surviving kanna-server should have an exact pid");
        assert_ne!(server_pid, std::process::id());
        let mut replacement_daemon = start_test_kanna_daemon(&daemon_dir).await;
        let replacement_daemon_pid = replacement_daemon
            .id()
            .expect("replacement daemon should have an exact pid");

        let socket_path = daemon_socket_path_for_dir(&daemon_dir);
        let mut authorization = DaemonClient::connect(&socket_path)
            .await
            .expect("replacement daemon should accept native authorization");
        let wrong_process = crate::commands::daemon::authorize_server_process(
            &mut authorization,
            std::process::id(),
        )
        .await
        .expect_err("desktop pid must not authenticate as kanna-server");
        assert_eq!(wrong_process.code.as_deref(), Some("input_unauthorized"));
        crate::commands::daemon::authorize_server_process(&mut authorization, server_pid)
            .await
            .expect("replacement daemon should authorize the exact surviving server");
        await_successor_policy_log(&mut restart_log, replacement_daemon_pid).await;

        assert_daemon_ack(
            &daemon_dir,
            serde_json::json!({
                "type": "Input",
                "session_id": RESTART_ORDINARY_SESSION,
                "data": [111, 114, 100, 105, 110, 97, 114, 121, 10]
            }),
        )
        .await;
        assert_daemon_ack(
            &daemon_dir,
            serde_json::json!({
                "type": "Input",
                "session_id": RESTART_LEGACY_PROTECTED_SESSION,
                "data": [102, 111, 114, 103, 101, 100, 10]
            }),
        )
        .await;
        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        replacement_daemon
            .kill()
            .await
            .expect("cleanup should stop replacement daemon");
        let _ = replacement_daemon.wait().await;
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
            current_server_version(),
            port,
        );
        let mut stale_daemon = start_test_kanna_daemon(&stale_daemon_dir).await;
        let mut stale_server = start_test_kanna_server(&stale_config_path, port).await;
        let stale_pid = stale_server.id().expect("stale server should have pid");
        let mut intended_daemon = start_test_kanna_daemon(&intended_daemon_dir).await;

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
                "prompt": "Create through the replacement server using the intended DB default provider",
                "workflowName": TEST_DEFAULT_PROVIDER_WORKFLOW
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
        stop_server_on_port(port)
            .await
            .expect("cleanup should stop server");
        intended_daemon
            .kill()
            .await
            .expect("cleanup should stop intended daemon");
        let _ = intended_daemon.wait().await;
        stale_daemon
            .kill()
            .await
            .expect("cleanup should stop stale daemon");
        let _ = stale_daemon.wait().await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn staging_release_bundle_start_uses_48121_without_claiming_production_48120() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        let root = unique_test_root("staging-release-bundle-start");
        let app_data_dir = root.join("app-data");
        let db_path = root.join("kanna-test.db");
        let daemon_dir = root.join("daemon");
        let production_port = kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT;
        let staging_port = kanna_runtime_defaults::STAGING_MOBILE_SERVER_PORT;

        let staging_status_before =
            reqwest::get(format!("{}/v1/status", server_base_url(staging_port)))
                .await
                .ok()
                .filter(|response| response.status().is_success());
        if staging_status_before.is_none() {
            let staging_probe = std::net::TcpListener::bind(("127.0.0.1", staging_port))
                .expect("staging test requires 127.0.0.1:48121 to be free or serving /v1/status");
            drop(staging_probe);
        }

        let mut owned_production_server = match try_start_production_status_server(production_port)
            .await
        {
            Ok(child) => Some(child),
            Err(error) => {
                let existing_status =
                    reqwest::get(format!("{}/v1/status", server_base_url(production_port)))
                        .await
                        .ok()
                        .filter(|response| response.status().is_success());
                if existing_status.is_none() {
                    panic!(
                            "production port 48120 is unavailable and did not answer /v1/status: {error}"
                        );
                }
                None
            }
        };

        let sidecar_dir = test_sidecar_dir().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
            unset_env_var("KANNA_E2E_DEVICE_TOKEN");
            set_env_var("KANNA_DB_PATH", &db_path.to_string_lossy());
            set_env_var("KANNA_DAEMON_DIR", &daemon_dir.to_string_lossy());
            set_env_var("KANNA_TEST_SIDECAR_DIR", &sidecar_dir.to_string_lossy());
        }
        create_test_database(&db_path);
        let manager = MobileServerManager::new_with_bundle_identifier_for_mode(
            app_data_dir.clone(),
            kanna_runtime_defaults::STAGING_DESKTOP_BUNDLE_IDENTIFIER,
            false,
        );
        {
            let state = manager.inner.lock().await;
            assert_eq!(state.api_base_url, "http://127.0.0.1:48121");
        }

        if staging_status_before.is_some() {
            let start_error = manager
                .start()
                .await
                .expect_err("staging manager should not claim an existing 48121 owner");
            assert!(start_error.contains("port is already owned"));
            assert_production_status_still_available(production_port, &mut owned_production_server)
                .await;
            cleanup_process_test_env();
            let _ = std::fs::remove_dir_all(root);
            return;
        }

        let mut daemon = start_test_kanna_daemon(&daemon_dir).await;
        let start_result = manager.start().await;
        let status_result = if start_result.is_ok() {
            Some(
                reqwest::get(format!("{}/v1/status", server_base_url(staging_port)))
                    .await
                    .expect("staging kanna-server status should be reachable"),
            )
        } else {
            None
        };

        if start_result.is_ok() {
            stop_server_on_port(staging_port)
                .await
                .expect("cleanup should stop staging server");
        }
        daemon
            .kill()
            .await
            .expect("cleanup should stop staging daemon");
        let _ = daemon.wait().await;
        assert_production_status_still_available(production_port, &mut owned_production_server)
            .await;
        cleanup_process_test_env();
        let _ = std::fs::remove_dir_all(root);

        start_result.expect("staging bundle manager should start kanna-server");
        let status = status_result
            .expect("status should be captured after successful start")
            .json::<MobileServerStatus>()
            .await
            .expect("staging status should deserialize");
        assert_eq!(status.lan_port, staging_port);
        assert_eq!(
            manager
                .snapshot()
                .await
                .expect("staging snapshot should be available")
                .lan_port,
            staging_port
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_status_keeps_polling_past_old_short_timeout_when_child_is_alive() {
        let port = free_loopback_port();
        let manager = MobileServerManager::new(unique_test_root("wait-slow").join("app-data"));
        let server = spawn_delayed_status_responder(port, Duration::from_millis(5_500));
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("alive child should spawn");

        let status = manager
            .wait_for_status(&server_base_url(port), &mut child)
            .await
            .expect("slow but alive server should become ready within the startup budget");

        assert_eq!(status.state, "running");
        assert_eq!(status.desktop_id, "desktop-wait-test");
        child.kill().await.expect("alive child should be killable");
        let _ = child.wait().await;
        server.await.expect("fake status responder should complete");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_for_status_exits_early_when_child_exits_during_startup() {
        let port = free_loopback_port();
        let manager = MobileServerManager::new(unique_test_root("wait-exit").join("app-data"));
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exit 7")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("exiting child should spawn");
        let started_at = tokio::time::Instant::now();

        let error = manager
            .wait_for_status(&server_base_url(port), &mut child)
            .await
            .expect_err("exited child should fail startup immediately");

        assert!(
            started_at.elapsed() < Duration::from_secs(2),
            "startup wait should not consume the full poll budget after child exit"
        );
        assert!(error.contains("kanna-server exited during startup"));
        assert!(error.contains("exit status: 7"));
        let _ = child.wait().await;
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
        assert_ne!(
            first_id.to_ascii_lowercase(),
            second_id.to_ascii_lowercase()
        );
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
    fn desktop_credential_preserves_legacy_short_identity() {
        let root = unique_test_root("desktop-short-credential-migrate");
        let config_path = root.join("main/Kanna/server.toml");
        let identity_path = root.join("main/Kanna/desktop-identity.json");
        std::fs::create_dir_all(identity_path.parent().unwrap()).unwrap();
        let legacy_id = "desktop-ea554bc4";
        std::fs::write(
            &identity_path,
            format!("{{\n  \"desktop_id\": \"{legacy_id}\"\n}}"),
        )
        .unwrap();

        let credential =
            super::desktop_credential(&config_path).expect("legacy short identity should migrate");

        assert_eq!(credential.desktop_id, legacy_id);
        assert_eq!(credential.desktop_secret.len(), 64);
        let rewritten = std::fs::read_to_string(&identity_path).unwrap();
        assert!(rewritten.contains(legacy_id));
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
            cloud_env: None,
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
            cloud_env: None,
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

    #[tokio::test(flavor = "current_thread")]
    #[allow(clippy::await_holding_lock)]
    async fn staging_release_bundle_manager_uses_staging_server_port_without_env() {
        let _guard = env_lock().lock().expect("env lock should not be poisoned");
        unsafe {
            unset_env_var("KANNA_CLOUD_ENV");
            unset_env_var("KANNA_MOBILE_SERVER_PORT");
        }
        let root = unique_test_root("staging-release-bundle-server-port");
        let manager = MobileServerManager::new_with_bundle_identifier_for_mode(
            root.join("app-data"),
            kanna_runtime_defaults::STAGING_DESKTOP_BUNDLE_IDENTIFIER,
            false,
        );

        let state = manager.inner.lock().await;
        assert_eq!(state.api_base_url, "http://127.0.0.1:48121");

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
            cloud_env: None,
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
            set_env_var("KANNA_TRANSFER_PORT", &port.to_string());
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
            unset_env_var("KANNA_TRANSFER_PORT");
            unset_env_var("KANNA_DB_PATH");
            unset_env_var("KANNA_DAEMON_DIR");
            unset_env_var("KANNA_TEST_SIDECAR_DIR");
            unset_env_var("KANNA_DB_NAME");
            unset_env_var("KANNA_RELAY_URL");
            unset_env_var("KANNA_RELAY_PORT");
        }
    }

    pub(super) fn unique_test_root(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kanna-mobile-{prefix}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ))
    }

    pub(super) fn free_loopback_port() -> u16 {
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
                sort_order INTEGER NOT NULL DEFAULT 0,
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
                agent_provider TEXT,
                activity TEXT,
                activity_changed_at TEXT,
                unread_at TEXT,
                port_offset INTEGER,
                port_env TEXT,
                agent_spawn_options TEXT,
                teardown_started_at TEXT,
                closed_at TEXT,
                pinned INTEGER,
                pin_order INTEGER,
                display_name TEXT,
                last_output_preview TEXT,
                pipeline TEXT,
                base_ref TEXT,
                agent_session_id TEXT,
                parent_task_id TEXT,
                notify_task_id TEXT,
                notified_at TEXT,
                pipeline_def TEXT,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE worktree (
                id TEXT PRIMARY KEY,
                pipeline_item_id TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE stage_run (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ('main', 'post')),
                agent TEXT,
                agent_provider TEXT,
                model TEXT,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
                result TEXT,
                feedback TEXT,
                session_id TEXT,
                provider_session_id TEXT,
                cwd TEXT,
                resumed_from_run_id TEXT,
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                finished_at TEXT
            );
            CREATE INDEX idx_stage_run_task_started ON stage_run(task_id, started_at);

            CREATE TABLE task_blocker (
                blocked_item_id TEXT NOT NULL,
                blocker_item_id TEXT NOT NULL,
                PRIMARY KEY (blocked_item_id, blocker_item_id)
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
            "INSERT INTO repo (id, path, name, default_branch, hidden, sort_order, created_at, last_opened_at)
             VALUES ('repo-1', ?, 'Repo One', 'main', 0, 0, datetime('now'), datetime('now'))",
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
        kanna_runtime_defaults::socket_path(daemon_dir)
    }

    const TEST_DEFAULT_PROVIDER_WORKFLOW: &str = "test-default-provider";

    fn init_test_git_repo(repo_root: &std::path::Path) {
        let _ = std::fs::remove_dir_all(repo_root);
        let workflow_dir = repo_root.join(".kanna/workflows");
        let fixture_bin = repo_root.join(".kanna/fixture-bin");
        std::fs::create_dir_all(&workflow_dir).expect("workflow directory should be created");
        std::fs::create_dir_all(&fixture_bin).expect("fixture bin directory should be created");
        std::fs::write(repo_root.join("README.md"), "test repo")
            .expect("repo seed file should be written");
        std::fs::write(
            repo_root.join(".kanna/config.json"),
            serde_json::json!({
                "workspace": {
                    "path": {
                        "prepend": [".kanna/fixture-bin"]
                    }
                }
            })
            .to_string(),
        )
        .expect("repo config should be written");
        std::fs::write(
            workflow_dir.join(format!("{TEST_DEFAULT_PROVIDER_WORKFLOW}.json")),
            serde_json::json!({
                "name": TEST_DEFAULT_PROVIDER_WORKFLOW,
                "stages": [{
                    "name": "in progress",
                    "prompt": "$TASK_PROMPT",
                    "policy": { "transition": "manual" }
                }]
            })
            .to_string(),
        )
        .expect("test workflow should be written");
        let copilot_fixture = fixture_bin.join("copilot");
        std::fs::write(&copilot_fixture, "#!/bin/sh\nexit 0\n")
            .expect("copilot fixture should be written");
        std::fs::set_permissions(&copilot_fixture, std::fs::Permissions::from_mode(0o755))
            .expect("copilot fixture should be executable");
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
            .args(["add", "."])
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
        assert!(StdCommand::new("git")
            .args(["update-ref", "refs/remotes/origin/main", "HEAD"])
            .current_dir(repo_root)
            .status()
            .expect("origin/main fixture ref should be published")
            .success());
    }

    fn write_test_server_config(
        config_path: &std::path::Path,
        db_path: &std::path::Path,
        daemon_dir: &std::path::Path,
        desktop_id: &str,
        version: &str,
        port: u16,
    ) {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).expect("server config directory should be created");
        }
        let build_metadata = format!(
            "version = \"{}\"\nenvironment = \"development\"\n",
            escape_toml_string(version),
        );
        let server_binary_sha256_line = sidecar_sha256_config_line("kanna-server")
            .map(|line| format!("{line}\n"))
            .unwrap_or_default();
        let pairing_store_path = config_path.with_file_name("pairings.json");
        let relay_url = relay_url();
        let config = format!(
            "relay_url = \"{}\"\ndevice_token = \"test-token\"\ndaemon_dir = \"{}\"\ndb_path = \"{}\"\n{}desktop_id = \"{}\"\ndesktop_name = \"Kanna Test\"\n{}lan_host = \"127.0.0.1\"\nlan_port = {}\ntransfer_port = {}\npairing_store_path = \"{}\"\n",
            escape_toml_string(&relay_url),
            escape_toml_string(&daemon_dir.to_string_lossy()),
            escape_toml_string(&db_path.to_string_lossy()),
            server_binary_sha256_line,
            escape_toml_string(desktop_id),
            build_metadata,
            port,
            port,
            escape_toml_string(&pairing_store_path.to_string_lossy()),
        );
        std::fs::write(config_path, config).expect("server config should be written");
    }

    async fn start_test_kanna_daemon(daemon_dir: &std::path::Path) -> Child {
        let daemon = test_kanna_daemon_binary().unwrap_or_else(|| {
            panic!("kanna-daemon sidecar not found; run `./kd build sidecars` before this test")
        });
        let server = test_kanna_server_binary().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        std::fs::create_dir_all(daemon_dir).expect("daemon directory should be created");
        let mut child = Command::new(daemon)
            .env("KANNA_DAEMON_DIR", daemon_dir)
            .env("KANNA_SERVER_EXECUTABLE", server)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("kanna-daemon should spawn");
        let expected_pid = child.id().expect("spawned daemon should have a pid");
        let pid_path = daemon_dir.join("daemon.pid");
        let socket_path = daemon_socket_path_for_dir(daemon_dir);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait().expect("daemon status should be readable") {
                panic!("kanna-daemon exited early with {status}");
            }
            let published_pid = std::fs::read_to_string(&pid_path)
                .ok()
                .and_then(|pid| pid.trim().parse::<u32>().ok());
            if published_pid == Some(expected_pid) {
                if let Ok(client) = DaemonClient::connect(&socket_path).await {
                    if client.connected_pid() == expected_pid {
                        return child;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        panic!("timed out waiting for kanna-daemon pid {expected_pid}");
    }

    async fn await_successor_policy_log(
        lifecycle_log: &mut BufReader<tokio::net::UnixStream>,
        daemon_pid: u32,
    ) {
        let expected =
            format!("protected-input policy established on successor daemon pid {daemon_pid}");
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let mut line = String::new();
                let read = lifecycle_log
                    .read_line(&mut line)
                    .await
                    .expect("surviving server lifecycle log should be readable");
                assert_ne!(read, 0, "surviving server lifecycle log closed early");
                if line.contains(&expected) {
                    return;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for server lifecycle: {expected}"));
    }

    async fn daemon_round_trip(
        daemon_dir: &std::path::Path,
        command: serde_json::Value,
    ) -> serde_json::Value {
        let socket_path = daemon_socket_path_for_dir(daemon_dir);
        let mut client = DaemonClient::connect(&socket_path)
            .await
            .expect("test daemon should accept a command connection");
        client
            .send_command(&command.to_string())
            .await
            .expect("test daemon command should be written");
        loop {
            let event = client
                .read_event()
                .await
                .expect("test daemon should answer the command");
            let event: serde_json::Value =
                serde_json::from_str(&event).expect("test daemon event should be JSON");
            if !matches!(
                event.get("type").and_then(serde_json::Value::as_str),
                Some("Output" | "StatusChanged")
            ) {
                return event;
            }
        }
    }

    async fn assert_daemon_ack(daemon_dir: &std::path::Path, command: serde_json::Value) {
        let event = daemon_round_trip(daemon_dir, command).await;
        assert_eq!(event["type"], "Ok", "daemon rejected command: {event}");
    }

    async fn spawn_restart_terminal(
        daemon_dir: &std::path::Path,
        session_id: &str,
        operator_input_only: bool,
    ) {
        let event = daemon_round_trip(
            daemon_dir,
            serde_json::json!({
                "type": "Spawn",
                "session_id": session_id,
                "executable": "/bin/cat",
                "args": [],
                "cwd": "/tmp",
                "env": {},
                "cols": 80,
                "rows": 24,
                "agent_provider": null,
                "operator_input_only": operator_input_only
            }),
        )
        .await;
        assert_eq!(event["type"], "SessionCreated");
        assert_eq!(event["session_id"], session_id);
    }

    async fn start_test_kanna_server(config_path: &std::path::Path, port: u16) -> Child {
        start_test_kanna_server_with_stderr(config_path, port, Stdio::null()).await
    }

    async fn start_test_kanna_server_with_stderr(
        config_path: &std::path::Path,
        port: u16,
        stderr: Stdio,
    ) -> Child {
        let sidecar = test_kanna_server_binary().unwrap_or_else(|| {
            panic!("kanna-server sidecar not found; run `./kd build sidecars` before this test")
        });
        let mut child = Command::new(sidecar)
            .env("KANNA_SERVER_CONFIG", config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
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

    async fn start_unhealthy_status_server(port: u16, desktop_id: &str) -> Child {
        let status = serde_json::json!({
            "state": "running",
            "desktopId": desktop_id,
            "desktopName": "Unhealthy Kanna Test",
            "version": current_server_version(),
            "environment": "development",
            "serverVersion": current_server_version(),
            "lanHost": "127.0.0.1",
            "lanPort": port,
            "pairingCode": null,
            "writePathHealth": {
                "healthy": false,
                "status": "degraded",
                "activeWorkspaceCommands": 4,
                "maxWorkspaceCommands": 4,
                "longRunningWorkspaceCommands": 4,
                "oldestWorkspaceCommandSeconds": 601
            }
        })
        .to_string();
        let script = r#"
import socket
import sys

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen(8)
body = sys.argv[2].encode("utf-8")
while True:
    conn, _ = sock.accept()
    with conn:
        _ = conn.recv(4096)
        response = (
            b"HTTP/1.1 200 OK\r\n"
            b"content-type: application/json\r\n"
            + f"content-length: {len(body)}\r\n".encode("ascii")
            + b"connection: close\r\n\r\n"
            + body
        )
        conn.sendall(response)
"#;
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(port.to_string())
            .arg(status)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("unhealthy status server should spawn");
        let base_url = server_base_url(port);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child
                .try_wait()
                .expect("unhealthy server status should be readable")
            {
                panic!("unhealthy status server exited early with {status}");
            }
            if reqwest::get(format!("{base_url}/v1/status"))
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return child;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        panic!("timed out waiting for unhealthy status server on {base_url}");
    }

    async fn try_start_production_status_server(port: u16) -> Result<Child, String> {
        let script = r#"
import json
import signal
import socket
import sys

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen(8)
while True:
    conn, _ = sock.accept()
    with conn:
        _ = conn.recv(4096)
        body = json.dumps({
            "state": "running",
            "desktopId": "desktop-production-port-owner",
            "desktopName": "Production Port Owner",
            "version": "test-production",
            "environment": "production",
            "serverVersion": "test-production",
            "lanHost": "127.0.0.1",
            "lanPort": int(sys.argv[1]),
            "pairingCode": None,
        })
        response = (
            "HTTP/1.1 200 OK\r\n"
            "content-type: application/json\r\n"
            f"content-length: {len(body)}\r\n"
            "connection: close\r\n\r\n"
            f"{body}"
        )
        conn.sendall(response.encode("utf-8"))
"#;
        let mut child = Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("failed to start production status server: {error}"))?;
        let base_url = server_base_url(port);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("production status server wait failed: {error}"))?
            {
                return Err(format!(
                    "production status server exited early with {status}"
                ));
            }
            if reqwest::get(format!("{base_url}/v1/status"))
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return Ok(child);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        Err(format!(
            "timed out waiting for production status server on {base_url}"
        ))
    }

    async fn assert_production_status_still_available(
        production_port: u16,
        owned_production_server: &mut Option<Child>,
    ) {
        if let Some(child) = owned_production_server.as_mut() {
            assert!(
                child
                    .try_wait()
                    .expect("production server status should be readable")
                    .is_none(),
                "production 48120 owner should still be running"
            );
            child
                .kill()
                .await
                .expect("cleanup should stop production server");
            let _ = child.wait().await;
        } else {
            let production_response =
                reqwest::get(format!("{}/v1/status", server_base_url(production_port)))
                    .await
                    .expect("existing production server should still answer after staging start");
            assert!(production_response.status().is_success());
        }
    }

    fn spawn_delayed_status_responder(port: u16, delay: Duration) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("fake status responder should bind");
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("fake status responder should accept a request");
            let mut buffer = [0_u8; 1024];
            let _ = stream
                .read(&mut buffer)
                .await
                .expect("fake status responder should read request");
            let body = serde_json::json!({
                "state": "running",
                "desktopId": "desktop-wait-test",
                "desktopName": "Wait Test",
                "version": current_server_version(),
                "environment": "development",
                "serverVersion": current_server_version(),
                "lanHost": "127.0.0.1",
                "lanPort": port,
                "pairingCode": null
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("fake status responder should write response");
        })
    }

    pub(super) fn test_sidecar_dir() -> Option<PathBuf> {
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
                .join(kanna_runtime_defaults::current_target_triple())
                .join("debug"),
            repo_root.join(".build").join("debug"),
        ]
        .into_iter()
        .find(|dir| {
            dir.join(format!(
                "kanna-server-{}",
                kanna_runtime_defaults::current_target_triple()
            ))
            .is_file()
                || dir.join("kanna-server").is_file()
        })
    }

    fn test_kanna_server_binary() -> Option<PathBuf> {
        let dir = test_sidecar_dir()?;
        let suffixed = dir.join(format!(
            "kanna-server-{}",
            kanna_runtime_defaults::current_target_triple()
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

    fn test_kanna_daemon_binary() -> Option<PathBuf> {
        let dir = test_sidecar_dir()?;
        let suffixed = dir.join(format!(
            "kanna-daemon-{}",
            kanna_runtime_defaults::current_target_triple()
        ));
        if suffixed.is_file() {
            return Some(suffixed);
        }
        let unsuffixed = dir.join("kanna-daemon");
        if unsuffixed.is_file() {
            return Some(unsuffixed);
        }
        None
    }

    pub(super) fn process_is_running(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
