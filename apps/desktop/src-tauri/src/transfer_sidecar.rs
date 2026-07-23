use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct TransferSidecarClient {
    _child: Child,
    stdin: ChildStdin,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
    request_counter: AtomicU64,
}

impl TransferSidecarClient {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let sidecar_path = resolve_sidecar_binary()?;
        let app_data_dir = app.path().app_data_dir().map_err(|error| {
            format!(
                "failed to resolve app data dir for transfer sidecar: {}",
                error
            )
        })?;
        let sidecar_env = build_transfer_sidecar_env_for_bundle_identifier(
            &app_data_dir,
            crate::transfer_identity::current_machine_name().as_deref(),
            app.config().identifier.as_str(),
            cfg!(debug_assertions),
        )?;
        let mut child = Command::new(&sidecar_path)
            .envs(sidecar_env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to spawn transfer sidecar: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "transfer sidecar stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "transfer sidecar stdout unavailable".to_string())?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));
        spawn_reader(app, stdout, Arc::clone(&pending), Arc::clone(&dead));

        Ok(Self {
            _child: child,
            stdin,
            pending,
            dead,
            request_counter: AtomicU64::new(1),
        })
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    pub async fn list_transfer_peers(&mut self) -> Result<Vec<Value>, String> {
        let request_id = self.next_request_id("list");
        let response = self
            .send_request(
                json!({
                    "type": "list_peers",
                    "request_id": request_id,
                }),
                &request_id,
            )
            .await?;
        let peers = response
            .get("peers")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "transfer sidecar list_peers response missing peers".to_string())?;
        Ok(peers)
    }

    pub async fn set_task_snapshot(&mut self, snapshot: Value) -> Result<Value, String> {
        let request_id = self.next_request_id("set-task-snapshot");
        self.send_request(
            json!({
                "type": "set_task_snapshot",
                "request_id": request_id,
                "snapshot": snapshot,
            }),
            &request_id,
        )
        .await
    }

    pub async fn list_peer_task_snapshots(&mut self) -> Result<Vec<Value>, String> {
        let request_id = self.next_request_id("list-task-snapshots");
        let response = self
            .send_request(
                json!({
                    "type": "list_peer_task_snapshots",
                    "request_id": request_id,
                }),
                &request_id,
            )
            .await?;
        let snapshots = response
            .get("snapshots")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                "transfer sidecar list_peer_task_snapshots response missing snapshots".to_string()
            })?;
        Ok(snapshots)
    }

    pub async fn observe_peer_session(
        &mut self,
        peer_id: String,
        session_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("observe-session");
        self.send_request(
            json!({
                "type": "observe_peer_session",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn unobserve_peer_session(
        &mut self,
        peer_id: String,
        session_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("unobserve-session");
        self.send_request(
            json!({
                "type": "unobserve_peer_session",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn send_peer_session_input(
        &mut self,
        peer_id: String,
        session_id: String,
        data: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("send-input");
        self.send_request(
            json!({
                "type": "send_peer_session_input",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
                "data": data.as_bytes().to_vec(),
            }),
            &request_id,
        )
        .await
    }

    pub async fn resize_peer_session(
        &mut self,
        peer_id: String,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("resize-session");
        self.send_request(
            json!({
                "type": "resize_peer_session",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
                "cols": cols,
                "rows": rows,
            }),
            &request_id,
        )
        .await
    }

    pub async fn close_peer_task(
        &mut self,
        peer_id: String,
        task_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("close-task");
        self.send_request(
            json!({
                "type": "close_peer_task",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "task_id": task_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn advance_peer_task_stage(
        &mut self,
        peer_id: String,
        task_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("advance-stage");
        self.send_request(
            json!({
                "type": "advance_peer_task_stage",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "task_id": task_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn start_peer_pairing(&mut self, peer_id: String) -> Result<Value, String> {
        let request_id = self.next_request_id("pair");
        eprintln!(
            "[transfer-sidecar] sending start_pairing request_id={} peer_id={}",
            request_id, peer_id
        );
        let response = self
            .send_request(
                json!({
                    "type": "start_pairing",
                    "request_id": request_id,
                    "target_peer_id": peer_id,
                }),
                &request_id,
            )
            .await?;
        eprintln!(
            "[transfer-sidecar] received start_pairing response request_id={} peer_id={} response={}",
            request_id, peer_id, response
        );

        Ok(json!({
            "peer": response
                .get("peer")
                .cloned()
                .ok_or_else(|| "transfer sidecar start_pairing response missing peer".to_string())?,
            "verificationCode": required_string(
                &response,
                &["verification_code", "verificationCode"],
            )?,
        }))
    }

    pub async fn accept_peer_pairing(
        &mut self,
        pairing_request_id: String,
        verification_code: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("accept-pair");
        let response = self
            .send_request(
                json!({
                    "type": "accept_pairing",
                    "request_id": request_id,
                    "pairing_request_id": pairing_request_id,
                    "verification_code": verification_code,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "pairingRequestId": required_string(&response, &["pairing_request_id", "pairingRequestId"])?,
        }))
    }

    pub async fn reject_peer_pairing(
        &mut self,
        pairing_request_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("reject-pair");
        let response = self
            .send_request(
                json!({
                    "type": "reject_pairing",
                    "request_id": request_id,
                    "pairing_request_id": pairing_request_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "pairingRequestId": required_string(&response, &["pairing_request_id", "pairingRequestId"])?,
        }))
    }

    pub async fn prepare_outgoing_transfer(&mut self, payload: Value) -> Result<Value, String> {
        let phase = payload
            .get("phase")
            .and_then(Value::as_str)
            .ok_or_else(|| "prepare_outgoing_transfer payload missing phase".to_string())?;

        match phase {
            "preflight" => self.prepare_transfer_preflight(payload).await,
            "commit" => self.prepare_transfer_commit(payload).await,
            other => Err(format!(
                "prepare_outgoing_transfer payload has unsupported phase {}",
                other
            )),
        }
    }

    pub async fn stage_transfer_artifact(
        &mut self,
        transfer_id: String,
        artifact_id: String,
        path: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("stage-artifact");
        let response = self
            .send_request(
                json!({
                    "type": "stage_transfer_artifact",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                    "artifact_id": artifact_id,
                    "path": path,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
            "artifactId": required_string(&response, &["artifact_id", "artifactId"])?,
        }))
    }

    pub async fn fetch_transfer_artifact(
        &mut self,
        transfer_id: String,
        artifact_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("fetch-artifact");
        let response = self
            .send_request(
                json!({
                    "type": "fetch_transfer_artifact",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                    "artifact_id": artifact_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
            "artifactId": required_string(&response, &["artifact_id", "artifactId"])?,
            "path": required_string(&response, &["path"])?,
        }))
    }

    pub async fn acknowledge_incoming_transfer_commit(
        &mut self,
        transfer_id: String,
        source_task_id: String,
        destination_local_task_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("commit-ack");
        let response = self
            .send_request(
                json!({
                    "type": "acknowledge_import_committed",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                    "source_task_id": source_task_id,
                    "destination_local_task_id": destination_local_task_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    pub async fn finalize_outgoing_transfer(
        &mut self,
        transfer_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("finalize");
        let response = self
            .send_request(
                json!({
                    "type": "finalize_outgoing_transfer",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                }),
                &request_id,
            )
            .await?;

        parse_finalize_outgoing_transfer_response(&response)
    }

    pub async fn complete_outgoing_transfer_finalization(
        &mut self,
        transfer_id: String,
        payload: Option<Value>,
        finalized_cleanly: bool,
        error: Option<String>,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("complete-finalize");
        let response = self
            .send_request(
                json!({
                    "type": "complete_outgoing_transfer_finalization",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                    "payload": payload,
                    "finalized_cleanly": finalized_cleanly,
                    "error": error,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    async fn prepare_transfer_preflight(&mut self, payload: Value) -> Result<Value, String> {
        let source_task_id = required_string(&payload, &["sourceTaskId", "source_task_id"])?;
        let target_peer_id = required_string(&payload, &["targetPeerId", "target_peer_id"])?;
        let request_id = self.next_request_id("preflight");
        let response = self
            .send_request(
                json!({
                    "type": "prepare_transfer_preflight",
                    "request_id": request_id,
                    "source_task_id": source_task_id,
                    "target_peer_id": target_peer_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
            "sourcePeerId": required_string(&response, &["source_peer_id", "sourcePeerId"])?,
            "targetHasRepo": required_bool(&response, &["target_has_repo", "targetHasRepo"])?,
        }))
    }

    async fn prepare_transfer_commit(&mut self, payload: Value) -> Result<Value, String> {
        let transfer_id = required_string(&payload, &["transferId", "transfer_id"])?;
        let transfer_payload = payload.get("payload").cloned().ok_or_else(|| {
            "prepare_outgoing_transfer commit payload missing payload".to_string()
        })?;
        let request_id = self.next_request_id("commit");
        let response = self
            .send_request(
                json!({
                    "type": "prepare_transfer_commit",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                    "payload": transfer_payload,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    async fn send_request(&mut self, request: Value, request_id: &str) -> Result<Value, String> {
        if self.is_dead() {
            return Err("transfer sidecar client is not running".to_string());
        }

        let encoded = serde_json::to_vec(&request)
            .map_err(|e| format!("failed to encode transfer sidecar request: {}", e))?;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.to_string(), tx);

        if let Err(error) = self.stdin.write_all(&encoded).await {
            self.dead.store(true, Ordering::Relaxed);
            self.pending.lock().await.remove(request_id);
            return Err(format!(
                "failed to write transfer sidecar request {}: {}",
                request_id, error
            ));
        }
        if let Err(error) = self.stdin.write_all(b"\n").await {
            self.dead.store(true, Ordering::Relaxed);
            self.pending.lock().await.remove(request_id);
            return Err(format!(
                "failed to terminate transfer sidecar request {}: {}",
                request_id, error
            ));
        }
        if let Err(error) = self.stdin.flush().await {
            self.dead.store(true, Ordering::Relaxed);
            self.pending.lock().await.remove(request_id);
            return Err(format!(
                "failed to flush transfer sidecar request {}: {}",
                request_id, error
            ));
        }

        let response = rx.await.map_err(|_| {
            self.dead.store(true, Ordering::Relaxed);
            format!(
                "transfer sidecar response channel closed for {}",
                request_id
            )
        })?;
        if request_id.starts_with("list-") {
            eprintln!(
                "[transfer-debug] sidecar response {}: {}",
                request_id, response
            );
        }
        if response.get("type").and_then(Value::as_str) == Some("error") {
            return Err(response
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "transfer sidecar returned an unknown error".to_string()));
        }
        Ok(response)
    }

    fn next_request_id(&self, prefix: &str) -> String {
        format!(
            "{}-{}",
            prefix,
            self.request_counter.fetch_add(1, Ordering::Relaxed)
        )
    }
}

fn spawn_reader(
    app: AppHandle,
    stdout: ChildStdout,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    dead.store(true, Ordering::Relaxed);
                    eprintln!("[transfer-sidecar] failed reading stdout: {}", error);
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            let value = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("[transfer-sidecar] invalid JSON from sidecar: {}", error);
                    continue;
                }
            };

            if let Some(event_name) = forwarded_event_name(&value) {
                let _ = app.emit(event_name, &value);
                continue;
            }

            if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                if let Some(sender) = pending.lock().await.remove(request_id) {
                    let _ = sender.send(value);
                } else {
                    eprintln!(
                        "[transfer-sidecar] dropped response for unknown request {}",
                        request_id
                    );
                }
                continue;
            }

            eprintln!("[transfer-sidecar] unhandled sidecar message: {}", value);
        }

        dead.store(true, Ordering::Relaxed);
        pending.lock().await.clear();
    });
}

fn required_string(value: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(result) = value.get(key).and_then(Value::as_str) {
            if !result.is_empty() {
                return Ok(result.to_string());
            }
        }
    }
    Err(format!(
        "missing required string field {}",
        keys.join(" or ")
    ))
}

fn parse_finalize_outgoing_transfer_response(response: &Value) -> Result<Value, String> {
    Ok(json!({
        "transferId": required_string(response, &["transfer_id", "transferId"])?,
        "payload": response
            .get("payload")
            .cloned()
            .ok_or_else(|| "finalize_outgoing_transfer response missing payload".to_string())?,
        "finalizedCleanly": required_bool(response, &["finalized_cleanly", "finalizedCleanly"])?,
    }))
}

fn forwarded_event_name(value: &Value) -> Option<&'static str> {
    match value.get("type").and_then(Value::as_str) {
        Some("pairing_started") => Some("pairing-started"),
        Some("pairing_requested") => Some("pairing-requested"),
        Some("incoming_transfer_request") => Some("transfer-request"),
        Some("pairing_completed") => Some("pairing-completed"),
        Some("outgoing_transfer_committed") => Some("outgoing-transfer-committed"),
        Some("outgoing_transfer_finalization_requested") => {
            Some("outgoing-transfer-finalization-requested")
        }
        Some("terminal_event") => Some("transfer-terminal-event"),
        _ => None,
    }
}

#[cfg(test)]
fn build_transfer_sidecar_env(
    app_data_dir: &std::path::Path,
    machine_name: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    build_transfer_sidecar_env_for_bundle_identifier(
        app_data_dir,
        machine_name,
        kanna_runtime_defaults::DESKTOP_BUNDLE_IDENTIFIER,
        cfg!(debug_assertions),
    )
}

fn build_transfer_sidecar_env_for_bundle_identifier(
    app_data_dir: &std::path::Path,
    machine_name: Option<&str>,
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Result<HashMap<String, String>, String> {
    let transfer_root = crate::transfer_identity::resolve_transfer_root(app_data_dir);
    build_transfer_sidecar_env_for_root_with_bundle_identifier(
        app_data_dir,
        &transfer_root,
        machine_name,
        bundle_identifier,
        debug_assertions,
    )
}

#[cfg(test)]
fn build_transfer_sidecar_env_for_root(
    app_data_dir: &std::path::Path,
    transfer_root: &std::path::Path,
    machine_name: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    build_transfer_sidecar_env_for_root_with_bundle_identifier(
        app_data_dir,
        transfer_root,
        machine_name,
        kanna_runtime_defaults::DESKTOP_BUNDLE_IDENTIFIER,
        cfg!(debug_assertions),
    )
}

fn build_transfer_sidecar_env_for_root_with_bundle_identifier(
    app_data_dir: &std::path::Path,
    transfer_root: &std::path::Path,
    machine_name: Option<&str>,
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Result<HashMap<String, String>, String> {
    let resolved =
        crate::transfer_identity::resolve_transfer_identity_for_root(transfer_root, machine_name)?;
    build_transfer_sidecar_env_from_resolved(
        app_data_dir,
        transfer_root,
        resolved,
        bundle_identifier,
        debug_assertions,
    )
}

fn build_transfer_sidecar_env_from_resolved(
    app_data_dir: &std::path::Path,
    transfer_root: &std::path::Path,
    resolved: crate::transfer_identity::ResolvedTransferIdentity,
    bundle_identifier: &str,
    debug_assertions: bool,
) -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    env.insert(
        "KANNA_TRANSFER_PORT".to_string(),
        std::env::var("KANNA_TRANSFER_PORT").unwrap_or_else(|_| "4455".to_string()),
    );
    env.insert(
        "KANNA_TRANSFER_ROOT".to_string(),
        transfer_root.to_string_lossy().into_owned(),
    );
    env.insert(
        "KANNA_TRANSFER_REGISTRY_DIR".to_string(),
        std::env::var("KANNA_TRANSFER_REGISTRY_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                transfer_root
                    .join("registry")
                    .to_string_lossy()
                    .into_owned()
            }),
    );
    env.insert(
        "KANNA_TRANSFER_PEER_ID".to_string(),
        std::env::var("KANNA_TRANSFER_PEER_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(resolved.peer_id),
    );
    env.insert(
        "KANNA_TRANSFER_DISPLAY_NAME".to_string(),
        std::env::var("KANNA_TRANSFER_DISPLAY_NAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(resolved.display_name),
    );
    let daemon_dir = std::env::var("KANNA_DAEMON_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| crate::daemon_data_dir().to_string_lossy().into_owned());
    env.insert("KANNA_DAEMON_DIR".to_string(), daemon_dir);
    let db_path = std::env::var("KANNA_DB_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let db_name = std::env::var("KANNA_DB_NAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "kanna-v2.db".to_string());
            app_data_dir.join(db_name).to_string_lossy().into_owned()
        });
    env.insert("KANNA_DB_PATH".to_string(), db_path.clone());
    env.insert("KANNA_CLI_DB_PATH".to_string(), db_path);
    env.insert(
        "KANNA_MOBILE_SERVER_PORT".to_string(),
        transfer_mobile_server_port(bundle_identifier, debug_assertions),
    );
    Ok(env)
}

fn transfer_mobile_server_port(bundle_identifier: &str, debug_assertions: bool) -> String {
    std::env::var("KANNA_MOBILE_SERVER_PORT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            kanna_runtime_defaults::mobile_server_port_for_bundle_identifier(
                bundle_identifier,
                debug_assertions,
            )
            .unwrap_or(kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT)
            .to_string()
        })
}

fn required_bool(value: &Value, keys: &[&str]) -> Result<bool, String> {
    for key in keys {
        if let Some(result) = value.get(key).and_then(Value::as_bool) {
            return Ok(result);
        }
    }
    Err(format!(
        "missing required boolean field {}",
        keys.join(" or ")
    ))
}

fn resolve_sidecar_binary() -> Result<PathBuf, String> {
    kanna_runtime_defaults::resolve_binary_from_candidates(
        "kanna-task-transfer",
        crate::commands::fs::sidecar_candidates("kanna-task-transfer"),
        |_| Err("kanna-task-transfer sidecar binary not found".to_string()),
    )
    .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    use std::time::{SystemTime, UNIX_EPOCH};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock()
            .lock()
            .expect("env lock should not be poisoned")
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }

        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

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
                "kanna-transfer-sidecar-test-{}-{}",
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
    fn transfer_sidecar_env_includes_stable_peer_id_and_display_name() {
        let _lock = env_lock();
        let _transfer_root = EnvVarGuard::unset("KANNA_TRANSFER_ROOT");
        let _display_name = EnvVarGuard::unset("KANNA_TRANSFER_DISPLAY_NAME");
        let _peer_id = EnvVarGuard::unset("KANNA_TRANSFER_PEER_ID");
        let temp = TestTempDir::new();

        let env = build_transfer_sidecar_env(temp.path(), Some("Jeremy's MacBook Pro"))
            .expect("sidecar env should be built");

        assert!(env.contains_key("KANNA_TRANSFER_PEER_ID"));
        assert_eq!(
            env.get("KANNA_TRANSFER_DISPLAY_NAME").map(String::as_str),
            Some("Jeremy's MacBook Pro")
        );
    }

    #[test]
    fn transfer_sidecar_env_uses_explicit_transfer_root() {
        let temp = TestTempDir::new();
        let transfer_root = temp.path().join("worktree-transfer-root");

        let env = build_transfer_sidecar_env_for_root(
            temp.path(),
            &transfer_root,
            Some("Jeremy's MacBook Pro"),
        )
        .expect("sidecar env should be built");

        assert_eq!(
            env.get("KANNA_TRANSFER_ROOT").map(String::as_str),
            Some(
                transfer_root
                    .to_str()
                    .expect("transfer root should be utf-8"),
            )
        );
        assert_eq!(
            env.get("KANNA_TRANSFER_REGISTRY_DIR").map(String::as_str),
            Some(
                transfer_root
                    .join("registry")
                    .to_str()
                    .expect("registry path should be utf-8"),
            )
        );
        assert!(transfer_root.join("identity.json").exists());
        assert!(!temp.path().join("transfer").join("identity.json").exists());
    }

    #[test]
    fn transfer_sidecar_env_defaults_daemon_dir_when_env_is_missing() {
        let _lock = env_lock();
        let _guard = EnvVarGuard::unset("KANNA_DAEMON_DIR");
        let _transfer_root = EnvVarGuard::unset("KANNA_TRANSFER_ROOT");
        let temp = TestTempDir::new();

        let env = build_transfer_sidecar_env(temp.path(), Some("Jeremy's MacBook Pro"))
            .expect("sidecar env should be built");

        assert_eq!(
            env.get("KANNA_DAEMON_DIR").map(String::as_str),
            Some(
                crate::daemon_data_dir()
                    .to_str()
                    .expect("daemon dir should be utf-8")
            )
        );
    }

    #[test]
    fn transfer_sidecar_env_forwards_mobile_server_port_for_peer_actions() {
        let _lock = env_lock();
        let _guard = EnvVarGuard::set("KANNA_MOBILE_SERVER_PORT", "48129");
        let _transfer_root = EnvVarGuard::unset("KANNA_TRANSFER_ROOT");
        let temp = TestTempDir::new();

        let env = build_transfer_sidecar_env(temp.path(), Some("Jeremy's MacBook Pro"))
            .expect("sidecar env should be built");

        assert_eq!(
            env.get("KANNA_MOBILE_SERVER_PORT").map(String::as_str),
            Some("48129")
        );
    }

    #[test]
    fn transfer_sidecar_env_uses_staging_bundle_mobile_server_port_without_env() {
        let _lock = env_lock();
        let _guard = EnvVarGuard::unset("KANNA_MOBILE_SERVER_PORT");
        let _transfer_root = EnvVarGuard::unset("KANNA_TRANSFER_ROOT");
        let temp = TestTempDir::new();

        let env = build_transfer_sidecar_env_for_bundle_identifier(
            temp.path(),
            Some("Jeremy's MacBook Pro"),
            kanna_runtime_defaults::STAGING_DESKTOP_BUNDLE_IDENTIFIER,
            false,
        )
        .expect("sidecar env should be built");

        assert_eq!(
            env.get("KANNA_MOBILE_SERVER_PORT").map(String::as_str),
            Some("48121")
        );
    }

    #[test]
    fn finalize_outgoing_transfer_response_requires_payload() {
        let response = json!({
            "transferId": "transfer-1",
            "finalizedCleanly": true,
        });

        let error =
            parse_finalize_outgoing_transfer_response(&response).expect_err("payload is required");
        assert!(error.contains("payload"));
    }

    #[test]
    fn finalization_request_events_emit_expected_tauri_topic() {
        let value = json!({
            "type": "outgoing_transfer_finalization_requested",
            "transfer_id": "transfer-1",
        });

        assert_eq!(
            forwarded_event_name(&value),
            Some("outgoing-transfer-finalization-requested")
        );
    }
}
