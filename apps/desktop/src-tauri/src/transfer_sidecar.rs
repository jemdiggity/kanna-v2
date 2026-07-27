use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

type PendingRequests = Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<Value>>>>;
pub type TransferEventConsumerState = Arc<std::sync::Mutex<TransferEventConsumer>>;

pub struct TransferEventConsumer {
    ready_labels: VecDeque<String>,
    pending: VecDeque<PendingLifecycleEvent>,
    pending_bytes: usize,
    next_delivery_id: u64,
}

#[derive(Clone)]
struct PendingLifecycleEvent {
    delivery_id: String,
    name: String,
    payload: Value,
    bytes: usize,
    leased_to: Option<String>,
    lease_expires_at: Option<Instant>,
    recovery_required: bool,
    claimed_phases: HashSet<String>,
}

const MAX_PENDING_LIFECYCLE_EVENTS: usize = 256;
const MAX_PENDING_LIFECYCLE_BYTES: usize = 8 * 1024 * 1024;
const LIFECYCLE_EVENT_LEASE: Duration = Duration::from_secs(30);
const MAX_SIDECAR_STDOUT_FRAME_BYTES: usize = 8 * 1024 * 1024;

impl Default for TransferEventConsumer {
    fn default() -> Self {
        Self {
            ready_labels: VecDeque::new(),
            pending: VecDeque::new(),
            pending_bytes: 0,
            next_delivery_id: 1,
        }
    }
}

impl TransferEventConsumer {
    fn claim(&mut self, candidate: &str) -> bool {
        if !self.ready_labels.iter().any(|label| label == candidate) {
            self.ready_labels.push_back(candidate.to_string());
        }
        self.ready_labels
            .front()
            .is_some_and(|label| label == candidate)
    }

    fn release(&mut self, candidate: &str) {
        self.ready_labels.retain(|label| label != candidate);
        for event in &mut self.pending {
            if event.leased_to.as_deref() == Some(candidate) {
                event.recovery_required = true;
                event.leased_to = None;
                event.lease_expires_at = None;
            }
        }
    }

    fn dispatch_with(
        &mut self,
        event_name: &str,
        payload: Value,
        mut emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(&payload)
            .map_err(|error| format!("failed to size lifecycle event: {error}"))?
            .len();
        if bytes > MAX_PENDING_LIFECYCLE_BYTES
            || self.pending.len() >= MAX_PENDING_LIFECYCLE_EVENTS
            || self.pending_bytes.saturating_add(bytes) > MAX_PENDING_LIFECYCLE_BYTES
        {
            return Err("transfer lifecycle queue capacity is exhausted".into());
        }
        let delivery_id = format!("lifecycle-{}", self.next_delivery_id);
        self.next_delivery_id = self.next_delivery_id.wrapping_add(1).max(1);
        self.pending.push_back(PendingLifecycleEvent {
            delivery_id,
            name: event_name.to_string(),
            payload,
            bytes,
            leased_to: None,
            lease_expires_at: None,
            recovery_required: false,
            claimed_phases: HashSet::new(),
        });
        self.pending_bytes += bytes;
        while let Some(label) = self.ready_labels.front().cloned() {
            if self
                .flush_pending_to(&label, |target, name, value| emit(target, name, value))
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("no ready transfer event consumer".into())
    }

    fn flush_pending_to(
        &mut self,
        label: &str,
        mut emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let now = Instant::now();
        let mut failed_emit = None;
        for event in &mut self.pending {
            if event
                .lease_expires_at
                .is_some_and(|lease_expires_at| lease_expires_at <= now)
            {
                event.leased_to = None;
                event.lease_expires_at = None;
            }
            if event.leased_to.is_some() {
                return Ok(());
            }
            let mut delivered_payload = event.payload.clone();
            if let Some(object) = delivered_payload.as_object_mut() {
                object.insert(
                    "__kannaLifecycleDeliveryId".into(),
                    Value::String(event.delivery_id.clone()),
                );
                if event.recovery_required {
                    object.insert("__kannaLifecycleRecovery".into(), Value::Bool(true));
                }
            }
            if let Err(error) = emit(label, &event.name, &delivered_payload) {
                failed_emit = Some(error);
                break;
            }
            event.leased_to = Some(label.to_string());
            event.lease_expires_at = Some(now + LIFECYCLE_EVENT_LEASE);
            // Preserve lifecycle order and keep renderer work bounded: the
            // next event is offered only after this delivery is acknowledged.
            break;
        }
        if let Some(error) = failed_emit {
            self.release(label);
            return Err(error);
        }
        Ok(())
    }

    fn acknowledge(&mut self, label: &str, delivery_id: &str) -> bool {
        let Some(index) = self.pending.iter().position(|event| {
            event.delivery_id == delivery_id && event.leased_to.as_deref() == Some(label)
        }) else {
            return false;
        };
        if let Some(event) = self.pending.remove(index) {
            self.pending_bytes = self.pending_bytes.saturating_sub(event.bytes);
        }
        true
    }

    fn nack(&mut self, label: &str, delivery_id: &str) -> bool {
        let Some(event) = self.pending.iter_mut().find(|event| {
            event.delivery_id == delivery_id && event.leased_to.as_deref() == Some(label)
        }) else {
            return false;
        };
        event.leased_to = None;
        event.lease_expires_at = None;
        true
    }

    fn renew(&mut self, label: &str, delivery_id: &str) -> bool {
        let Some(event) = self.pending.iter_mut().find(|event| {
            event.delivery_id == delivery_id && event.leased_to.as_deref() == Some(label)
        }) else {
            return false;
        };
        event.lease_expires_at = Some(Instant::now() + LIFECYCLE_EVENT_LEASE);
        true
    }

    fn claim_phase(&mut self, label: &str, delivery_id: &str, phase: &str) -> Result<bool, String> {
        let event = self
            .pending
            .iter_mut()
            .find(|event| event.delivery_id == delivery_id)
            .ok_or_else(|| format!("unknown transfer lifecycle delivery {delivery_id}"))?;
        if event.leased_to.as_deref() != Some(label) {
            return Err(format!(
                "transfer lifecycle delivery {delivery_id} is no longer owned by {label}",
            ));
        }
        event.lease_expires_at = Some(Instant::now() + LIFECYCLE_EVENT_LEASE);
        Ok(event.claimed_phases.insert(phase.to_string()))
    }
}

pub struct TransferSidecarClient {
    _child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
    request_counter: AtomicU64,
    redelivery_task: tauri::async_runtime::JoinHandle<()>,
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
        let pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let event_consumer = app
            .state::<crate::TransferEventConsumerState>()
            .inner()
            .clone();
        let redelivery_task = spawn_lifecycle_redelivery(app.clone(), Arc::clone(&event_consumer));
        spawn_reader(
            app,
            stdout,
            Arc::clone(&pending),
            Arc::clone(&dead),
            event_consumer,
        );

        Ok(Self {
            _child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            dead,
            request_counter: AtomicU64::new(1),
            redelivery_task,
        })
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    pub async fn get_local_identity(&self) -> Result<Value, String> {
        let request_id = self.next_request_id("identity");
        let response = self
            .send_request(
                json!({
                    "type": "get_local_identity",
                    "request_id": request_id,
                }),
                &request_id,
            )
            .await?;
        Ok(json!({
            "peerId": required_string(&response, &["peer_id", "peerId"])?,
            "displayName": required_string(&response, &["display_name", "displayName"])?,
            "publicKey": required_string(&response, &["public_key", "publicKey"])?,
            "protocolVersion": response
                .get("protocol_version")
                .or_else(|| response.get("protocolVersion"))
                .and_then(Value::as_u64)
                .ok_or_else(|| "transfer sidecar identity response missing protocol version".to_string())?,
            "acceptingTransfers": response
                .get("accepting_transfers")
                .or_else(|| response.get("acceptingTransfers"))
                .and_then(Value::as_bool)
                .ok_or_else(|| "transfer sidecar identity response missing accepting state".to_string())?,
        }))
    }

    pub async fn list_transfer_peers(&self) -> Result<Vec<Value>, String> {
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

    pub async fn upsert_external_peer(&self, peer: Value) -> Result<Value, String> {
        let request_id = self.next_request_id("external-upsert");
        let request = build_upsert_external_peer_request(&request_id, &peer)?;
        self.send_request(request, &request_id).await
    }

    pub async fn remove_external_peer(&self, peer_id: String) -> Result<Value, String> {
        if peer_id.trim().is_empty() {
            return Err("external peer id must not be blank".into());
        }
        let request_id = self.next_request_id("external-remove");
        self.send_request(
            json!({
                "type": "remove_external_peer",
                "request_id": request_id,
                "peer_id": peer_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn clear_external_peers(&self) -> Result<Value, String> {
        let request_id = self.next_request_id("external-clear");
        self.send_request(
            json!({
                "type": "clear_external_peers",
                "request_id": request_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn set_task_snapshot(&self, snapshot: Value) -> Result<Value, String> {
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

    pub async fn list_peer_task_snapshots(&self) -> Result<Vec<Value>, String> {
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
        let mut snapshots = response
            .get("snapshots")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                "transfer sidecar list_peer_task_snapshots response missing snapshots".to_string()
            })?;
        if let Some(issues) = response.get("issues").and_then(Value::as_array) {
            snapshots.extend(issues.iter().cloned().map(|mut issue| {
                if let Some(object) = issue.as_object_mut() {
                    if let Some(message) = object.remove("message") {
                        object.insert("error".to_string(), message);
                    }
                }
                issue
            }));
        }
        Ok(snapshots)
    }

    pub async fn observe_peer_session(
        &self,
        peer_id: String,
        session_id: String,
        observer_lease_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("observe-session");
        self.send_request(
            json!({
                "type": "observe_peer_session",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
                "observer_lease_id": observer_lease_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn unobserve_peer_session(
        &self,
        peer_id: String,
        session_id: String,
        observer_lease_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("unobserve-session");
        self.send_request(
            json!({
                "type": "unobserve_peer_session",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "session_id": session_id,
                "observer_lease_id": observer_lease_id,
            }),
            &request_id,
        )
        .await
    }

    pub async fn send_peer_session_input(
        &self,
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
        &self,
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

    pub async fn close_peer_task(&self, peer_id: String, task_id: String) -> Result<Value, String> {
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
        &self,
        peer_id: String,
        task_id: String,
        expected_transition_revision: Option<String>,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("advance-stage");
        let mut request = json!({
            "type": "advance_peer_task_stage",
            "request_id": request_id,
            "target_peer_id": peer_id,
            "task_id": task_id,
        });
        if let Some(expected_transition_revision) = expected_transition_revision {
            request["expected_transition_revision"] = Value::String(expected_transition_revision);
        }
        self.send_request(request, &request_id).await
    }

    pub async fn read_peer_task_file(
        &self,
        peer_id: String,
        task_id: String,
        path: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("read-task-file");
        self.send_request(
            json!({
                "type": "read_peer_task_file",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "task_id": task_id,
                "path": path,
            }),
            &request_id,
        )
        .await
    }

    pub async fn mark_peer_task_read(
        &self,
        peer_id: String,
        task_id: String,
        expected_activity_revision: i64,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("mark-read");
        self.send_request(
            json!({
                "type": "mark_peer_task_read",
                "request_id": request_id,
                "target_peer_id": peer_id,
                "task_id": task_id,
                "expected_activity_revision": expected_activity_revision,
            }),
            &request_id,
        )
        .await
    }

    pub async fn start_peer_pairing(&self, peer_id: String) -> Result<Value, String> {
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
        &self,
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

    pub async fn reject_peer_pairing(&self, pairing_request_id: String) -> Result<Value, String> {
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

    pub async fn prepare_outgoing_transfer(&self, payload: Value) -> Result<Value, String> {
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

    pub async fn request_task_pull(
        &self,
        peer_id: String,
        source_task_id: String,
        transport: String,
    ) -> Result<Value, String> {
        if !matches!(transport.as_str(), "auto" | "lan" | "cloud") {
            return Err(format!("unsupported transfer transport {transport}"));
        }
        let request_id = self.next_request_id("task-pull");
        let response = self
            .send_request(
                json!({
                    "type": "request_task_pull",
                    "request_id": request_id,
                    "target_peer_id": peer_id,
                    "source_task_id": source_task_id,
                    "transport": transport,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "requestId": required_string(
                &response,
                &["pull_request_id", "pullRequestId"],
            )?,
        }))
    }

    pub async fn stage_transfer_artifact(
        &self,
        transfer_id: String,
        artifact_id: String,
        path: String,
        owned: bool,
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
                    "owned": owned,
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
        &self,
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
        &self,
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

    pub async fn mark_outgoing_transfer_commit_applied(
        &self,
        transfer_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("commit-applied");
        let response = self
            .send_request(
                json!({
                    "type": "mark_import_commit_applied",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    pub async fn nack_outgoing_transfer_commit(
        &self,
        transfer_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("commit-nack");
        let response = self
            .send_request(
                json!({
                    "type": "nack_import_commit",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    pub async fn mark_incoming_transfer_event_recorded(
        &self,
        transfer_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("event-recorded");
        let response = self
            .send_request(
                json!({
                    "type": "mark_incoming_event_recorded",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    pub async fn mark_incoming_transfer_ack_completed(
        &self,
        transfer_id: String,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id("ack-completed");
        let response = self
            .send_request(
                json!({
                    "type": "mark_import_ack_completed",
                    "request_id": request_id,
                    "transfer_id": transfer_id,
                }),
                &request_id,
            )
            .await?;

        Ok(json!({
            "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        }))
    }

    pub async fn finalize_outgoing_transfer(&self, transfer_id: String) -> Result<Value, String> {
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
        &self,
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

    async fn prepare_transfer_preflight(&self, payload: Value) -> Result<Value, String> {
        let source_task_id = required_string(&payload, &["sourceTaskId", "source_task_id"])?;
        let target_peer_id = required_string(&payload, &["targetPeerId", "target_peer_id"])?;
        let transport = transfer_transport(&payload)?;
        let request_id = self.next_request_id("preflight");
        let response = self
            .send_request(
                json!({
                    "type": "prepare_transfer_preflight",
                    "request_id": request_id,
                    "source_task_id": source_task_id,
                    "target_peer_id": target_peer_id,
                    "transport": transport,
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

    async fn prepare_transfer_commit(&self, payload: Value) -> Result<Value, String> {
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

    async fn send_request(&self, request: Value, request_id: &str) -> Result<Value, String> {
        if self.is_dead() {
            return Err("transfer sidecar client is not running".to_string());
        }

        let encoded = serde_json::to_vec(&request)
            .map_err(|e| format!("failed to encode transfer sidecar request: {}", e))?;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id.to_string(), tx);
        let _registration = PendingRequestRegistration::new(request_id, Arc::clone(&self.pending));

        let mut stdin = self.stdin.lock().await;
        if let Err(error) = stdin.write_all(&encoded).await {
            self.dead.store(true, Ordering::Relaxed);
            return Err(format!(
                "failed to write transfer sidecar request {}: {}",
                request_id, error
            ));
        }
        if let Err(error) = stdin.write_all(b"\n").await {
            self.dead.store(true, Ordering::Relaxed);
            return Err(format!(
                "failed to terminate transfer sidecar request {}: {}",
                request_id, error
            ));
        }
        if let Err(error) = stdin.flush().await {
            self.dead.store(true, Ordering::Relaxed);
            return Err(format!(
                "failed to flush transfer sidecar request {}: {}",
                request_id, error
            ));
        }
        drop(stdin);

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

impl Drop for TransferSidecarClient {
    fn drop(&mut self) {
        self.redelivery_task.abort();
    }
}

fn spawn_lifecycle_redelivery(
    app: AppHandle,
    state: TransferEventConsumerState,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let mut consumer = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            consumer
                .ready_labels
                .retain(|label| app.get_webview_window(label).is_some());
            let Some(label) = consumer.ready_labels.front().cloned() else {
                continue;
            };
            if let Err(error) = consumer.flush_pending_to(&label, |target, event_name, payload| {
                app.emit_to(EventTarget::webview_window(target), event_name, payload)
                    .map_err(|error| error.to_string())
            }) {
                eprintln!(
                    "[transfer-sidecar] failed redelivering lifecycle event to {label}: {error}"
                );
            }
        }
    })
}

fn build_upsert_external_peer_request(request_id: &str, peer: &Value) -> Result<Value, String> {
    let protocol_version = peer
        .get("protocolVersion")
        .or_else(|| peer.get("protocol_version"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "external peer missing protocol version".to_string())?;
    let accepting_transfers = peer
        .get("acceptingTransfers")
        .or_else(|| peer.get("accepting_transfers"))
        .and_then(Value::as_bool)
        .ok_or_else(|| "external peer missing accepting transfers state".to_string())?;
    Ok(json!({
        "type": "upsert_external_peer",
        "request_id": request_id,
        "peer": {
            "peer_id": required_string(peer, &["peerId", "peer_id"])?,
            "display_name": required_string(peer, &["displayName", "display_name"])?,
            "endpoint": required_string(peer, &["endpoint"])?,
            "public_key": required_string(peer, &["publicKey", "public_key"])?,
            "protocol_version": protocol_version,
            "accepting_transfers": accepting_transfers,
        },
    }))
}

fn transfer_transport(payload: &Value) -> Result<&str, String> {
    let transport = payload
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    match transport {
        "auto" | "lan" | "cloud" => Ok(transport),
        other => Err(format!("unsupported transfer transport {other}")),
    }
}

struct PendingRequestRegistration {
    request_id: String,
    pending: PendingRequests,
}

impl PendingRequestRegistration {
    fn new(request_id: &str, pending: PendingRequests) -> Self {
        Self {
            request_id: request_id.to_string(),
            pending,
        }
    }
}

impl Drop for PendingRequestRegistration {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.request_id);
    }
}

fn spawn_reader(
    app: AppHandle,
    stdout: ChildStdout,
    pending: PendingRequests,
    dead: Arc<AtomicBool>,
    event_consumer: TransferEventConsumerState,
) {
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::with_capacity(64 * 1024);
            let mut bounded = reader.take(MAX_SIDECAR_STDOUT_FRAME_BYTES.saturating_add(1) as u64);
            let read = bounded.read_line(&mut line).await;
            reader = bounded.into_inner();
            let line = match read {
                Ok(0) => break,
                Ok(read) if read > MAX_SIDECAR_STDOUT_FRAME_BYTES || !line.ends_with('\n') => {
                    dead.store(true, Ordering::Relaxed);
                    eprintln!(
                        "[transfer-sidecar] stdout frame exceeded {} bytes or was unterminated",
                        MAX_SIDECAR_STDOUT_FRAME_BYTES
                    );
                    break;
                }
                Ok(_) => {
                    line.pop();
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    line
                }
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
                if is_state_mutating_lifecycle_event(event_name) {
                    loop {
                        match dispatch_lifecycle_event(
                            &app,
                            &event_consumer,
                            event_name,
                            value.clone(),
                        ) {
                            Ok(()) => break,
                            Err(error) if error.contains("queue capacity") => {
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                            Err(error) => {
                                eprintln!(
                                    "[transfer-sidecar] queued undelivered {} event: {}",
                                    event_name, error
                                );
                                break;
                            }
                        }
                    }
                } else {
                    let _ = app.emit(event_name, &value);
                }
                continue;
            }

            if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                if let Some(sender) = pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(request_id)
                {
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
        pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
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
        Some("task_pull_requested") => Some("task-pull-requested"),
        Some("pairing_completed") => Some("pairing-completed"),
        Some("outgoing_transfer_committed") => Some("outgoing-transfer-committed"),
        Some("outgoing_transfer_finalization_requested") => {
            Some("outgoing-transfer-finalization-requested")
        }
        Some("terminal_event") => Some("transfer-terminal-event"),
        _ => None,
    }
}

fn is_state_mutating_lifecycle_event(event_name: &str) -> bool {
    matches!(
        event_name,
        "transfer-request"
            | "task-pull-requested"
            | "outgoing-transfer-committed"
            | "outgoing-transfer-finalization-requested"
    )
}

fn dispatch_lifecycle_event(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    event_name: &str,
    payload: Value,
) -> Result<(), String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer.dispatch_with(event_name, payload, |label, name, value| {
        if app.get_webview_window(label).is_none() {
            return Err(format!("transfer event consumer {label} is unavailable"));
        }
        app.emit_to(EventTarget::webview_window(label), name, value)
            .map_err(|error| {
                eprintln!(
                    "[transfer-sidecar] transfer event consumer {label} rejected {name}: {error}"
                );
                error.to_string()
            })
    })
}

pub fn claim_transfer_event_consumer_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer
        .ready_labels
        .retain(|candidate| app.get_webview_window(candidate).is_some());
    if !consumer.claim(label) {
        return Ok(false);
    }

    consumer.flush_pending_to(label, |target, event_name, payload| {
        if app.get_webview_window(target).is_none() {
            return Err(format!(
                "transfer event consumer {target} is no longer available"
            ));
        }
        app.emit_to(EventTarget::webview_window(target), event_name, payload)
            .map_err(|error| {
                format!("failed delivering queued transfer lifecycle event to {target}: {error}")
            })
    })?;
    Ok(true)
}

pub fn release_transfer_event_consumer_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
) -> Result<(), String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer.release(label);
    let Some(next_label) = consumer.ready_labels.front().cloned() else {
        return Ok(());
    };
    consumer.flush_pending_to(&next_label, |target, event_name, payload| {
        if app.get_webview_window(target).is_none() {
            return Err(format!(
                "standby transfer event consumer {target} is no longer available"
            ));
        }
        app.emit_to(EventTarget::webview_window(target), event_name, payload)
            .map_err(|error| {
                format!("failed delivering queued transfer lifecycle event to {target}: {error}")
            })
    })
}

pub fn acknowledge_transfer_lifecycle_event_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
    delivery_id: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !consumer.acknowledge(label, delivery_id) {
        return Ok(false);
    }
    consumer.flush_pending_to(label, |target, event_name, payload| {
        if app.get_webview_window(target).is_none() {
            return Err(format!(
                "transfer event consumer {target} is no longer available"
            ));
        }
        app.emit_to(EventTarget::webview_window(target), event_name, payload)
            .map_err(|error| error.to_string())
    })?;
    Ok(true)
}

pub fn nack_transfer_lifecycle_event_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
    delivery_id: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !consumer.nack(label, delivery_id) {
        return Ok(false);
    }
    consumer.flush_pending_to(label, |target, event_name, payload| {
        if app.get_webview_window(target).is_none() {
            return Err(format!(
                "transfer event consumer {target} is no longer available"
            ));
        }
        app.emit_to(EventTarget::webview_window(target), event_name, payload)
            .map_err(|error| error.to_string())
    })?;
    Ok(true)
}

pub fn renew_transfer_lifecycle_event_in_state(
    state: &TransferEventConsumerState,
    label: &str,
    delivery_id: &str,
) -> bool {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer.renew(label, delivery_id)
}

pub fn require_transfer_lifecycle_event_owner_in_state(
    state: &TransferEventConsumerState,
    label: &str,
    delivery_id: &str,
) -> Result<(), String> {
    if renew_transfer_lifecycle_event_in_state(state, label, delivery_id) {
        Ok(())
    } else {
        Err(format!(
            "transfer lifecycle delivery {delivery_id} is no longer owned by {label}",
        ))
    }
}

pub fn claim_transfer_lifecycle_phase_in_state(
    state: &TransferEventConsumerState,
    label: &str,
    delivery_id: &str,
    phase: &str,
) -> Result<bool, String> {
    if phase.trim().is_empty() {
        return Err("transfer lifecycle phase must not be empty".into());
    }
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim_phase(label, delivery_id, phase)
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
        std::env::var("KANNA_TRANSFER_PORT")
            .unwrap_or_else(|_| kanna_runtime_defaults::DEFAULT_TRANSFER_PORT.to_string()),
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
    fn external_peer_control_requests_normalize_frontend_fields() {
        let request = build_upsert_external_peer_request(
            "external-1",
            &json!({
                "peerId": "peer-cloud",
                "displayName": "Cloud Mac",
                "endpoint": "127.0.0.1:4456",
                "publicKey": "public-key",
                "protocolVersion": 1,
                "acceptingTransfers": true,
            }),
        )
        .unwrap();
        assert_eq!(
            request,
            json!({
                "type": "upsert_external_peer",
                "request_id": "external-1",
                "peer": {
                    "peer_id": "peer-cloud",
                    "display_name": "Cloud Mac",
                    "endpoint": "127.0.0.1:4456",
                    "public_key": "public-key",
                    "protocol_version": 1,
                    "accepting_transfers": true,
                },
            })
        );
        assert!(
            build_upsert_external_peer_request("external-2", &json!({"peerId": "peer-cloud"}))
                .is_err()
        );
    }

    #[test]
    fn transfer_preflight_transport_defaults_and_rejects_unknown_values() {
        assert_eq!(
            transfer_transport(&json!({"phase": "preflight"})).unwrap(),
            "auto"
        );
        assert_eq!(
            transfer_transport(&json!({"transport": "cloud"})).unwrap(),
            "cloud"
        );
        assert!(transfer_transport(&json!({"transport": "bluetooth"})).is_err());
    }

    #[test]
    fn dropped_sidecar_request_removes_its_pending_response_registration() {
        let pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (sender, _receiver) = oneshot::channel();
        pending
            .lock()
            .unwrap()
            .insert("mark-read-1".to_string(), sender);

        {
            let _registration =
                PendingRequestRegistration::new("mark-read-1", Arc::clone(&pending));
        }

        assert!(pending.lock().unwrap().is_empty());
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

    #[test]
    fn lifecycle_events_select_exactly_one_authoritative_window() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("window-z"));
        assert!(!consumer.claim("main"));
        assert!(!consumer.claim("window-a"));
        consumer.release("window-z");
        assert!(consumer.claim("main"));
        assert!(!consumer.claim("window-a"));
        assert!(is_state_mutating_lifecycle_event("transfer-request"));
        assert!(is_state_mutating_lifecycle_event("task-pull-requested"));
        assert!(is_state_mutating_lifecycle_event(
            "outgoing-transfer-committed"
        ));
        assert!(is_state_mutating_lifecycle_event(
            "outgoing-transfer-finalization-requested"
        ));
        assert!(!is_state_mutating_lifecycle_event("pairing-completed"));
    }

    #[test]
    fn lifecycle_events_queue_without_a_ready_window_and_preserve_order_after_failed_flush() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer
            .dispatch_with("transfer-request", json!({"sequence": 1}), |_, _, _| {
                unreachable!("no ready consumer should avoid emit")
            })
            .is_err());
        assert!(consumer
            .dispatch_with("task-pull-requested", json!({"sequence": 2}), |_, _, _| {
                unreachable!("no ready consumer should avoid emit")
            })
            .is_err());
        assert!(consumer.claim("main"));

        let error = consumer
            .flush_pending_to("main", |_, _, _| Err("listener unavailable".into()))
            .expect_err("failed emit should retain queued work");

        assert_eq!(error, "listener unavailable");
        assert!(consumer.ready_labels.is_empty());
        assert_eq!(consumer.pending.len(), 2);
        assert_eq!(consumer.pending[0].name, "transfer-request");
        assert_eq!(consumer.pending[1].name, "task-pull-requested");
    }

    #[test]
    fn lifecycle_dispatch_replaces_a_stale_owner_with_a_ready_standby() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer
            .dispatch_with("transfer-request", json!({"sequence": 1}), |_, _, _| {
                unreachable!("no ready consumer should avoid emit")
            })
            .is_err());
        assert!(consumer.claim("window-stale"));
        assert!(!consumer.claim("window-ready"));
        let mut attempts = Vec::new();

        consumer
            .dispatch_with(
                "task-pull-requested",
                json!({"sequence": 2}),
                |label, name, payload| {
                    attempts.push((
                        label.to_string(),
                        name.to_string(),
                        payload["sequence"].clone(),
                    ));
                    if label == "window-ready" {
                        Ok(())
                    } else {
                        Err("window unavailable".into())
                    }
                },
            )
            .expect("standby should receive the event");

        assert_eq!(
            attempts,
            [
                (
                    "window-stale".to_string(),
                    "transfer-request".to_string(),
                    json!(1),
                ),
                (
                    "window-ready".to_string(),
                    "transfer-request".to_string(),
                    json!(1),
                ),
            ],
        );
        assert_eq!(
            consumer.ready_labels.front().map(String::as_str),
            Some("window-ready"),
        );
        assert_eq!(consumer.pending.len(), 2);
        let first_delivery = consumer.pending[0].delivery_id.clone();
        assert!(consumer.acknowledge("window-ready", &first_delivery));
        consumer
            .flush_pending_to("window-ready", |label, name, payload| {
                attempts.push((
                    label.to_string(),
                    name.to_string(),
                    payload["sequence"].clone(),
                ));
                Ok(())
            })
            .expect("ack should release the next event");
        assert_eq!(
            attempts.last().map(|attempt| attempt.1.as_str()),
            Some("task-pull-requested")
        );
    }

    #[test]
    fn owner_release_flushes_queued_work_to_the_next_ready_window() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer
            .dispatch_with("transfer-request", json!({"sequence": 1}), |_, _, _| {
                unreachable!("no ready consumer should avoid emit")
            })
            .is_err());
        assert!(consumer.claim("window-owner"));
        assert!(!consumer.claim("window-standby"));
        consumer.release("window-owner");
        let mut delivered = Vec::new();

        consumer
            .flush_pending_to("window-standby", |label, name, payload| {
                delivered.push((label.to_string(), name.to_string(), payload.clone()));
                Ok(())
            })
            .expect("standby should accept queued event");

        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, "window-standby");
        assert_eq!(delivered[0].1, "transfer-request");
        assert_eq!(delivered[0].2["sequence"], json!(1));
        assert_eq!(consumer.pending.len(), 1);
        assert_eq!(
            consumer.pending[0].leased_to.as_deref(),
            Some("window-standby")
        );
    }

    #[test]
    fn lifecycle_delivery_survives_owner_close_before_ack() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("window-owner"));
        let mut delivered_ids = Vec::new();
        let mut recovery_flags = Vec::new();
        consumer
            .dispatch_with(
                "transfer-request",
                json!({"sequence": 1}),
                |_, _, payload| {
                    delivered_ids.push(
                        payload["__kannaLifecycleDeliveryId"]
                            .as_str()
                            .expect("delivery id")
                            .to_string(),
                    );
                    recovery_flags.push(payload["__kannaLifecycleRecovery"].as_bool());
                    Ok(())
                },
            )
            .expect("deliver to owner");
        assert!(!consumer.claim("window-standby"));

        consumer.release("window-owner");
        consumer
            .flush_pending_to("window-standby", |_, _, payload| {
                delivered_ids.push(
                    payload["__kannaLifecycleDeliveryId"]
                        .as_str()
                        .expect("redelivery id")
                        .to_string(),
                );
                recovery_flags.push(payload["__kannaLifecycleRecovery"].as_bool());
                Ok(())
            })
            .expect("redeliver to standby");

        assert_eq!(delivered_ids.len(), 2);
        assert_eq!(delivered_ids[0], delivered_ids[1]);
        assert_eq!(recovery_flags, vec![None, Some(true)]);
        assert!(consumer.acknowledge("window-standby", &delivered_ids[1]));
        assert!(consumer.pending.is_empty());
    }

    #[test]
    fn expired_lifecycle_delivery_lease_is_redelivered_with_the_same_id() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("main"));
        let mut delivery_ids = Vec::new();
        consumer
            .dispatch_with(
                "transfer-request",
                json!({"sequence": 1}),
                |_, _, payload| {
                    delivery_ids.push(
                        payload["__kannaLifecycleDeliveryId"]
                            .as_str()
                            .unwrap()
                            .to_string(),
                    );
                    Ok(())
                },
            )
            .unwrap();
        consumer.pending[0].lease_expires_at = Some(Instant::now() - Duration::from_secs(1));
        consumer
            .flush_pending_to("main", |_, _, payload| {
                delivery_ids.push(
                    payload["__kannaLifecycleDeliveryId"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                );
                Ok(())
            })
            .unwrap();

        assert_eq!(delivery_ids.len(), 2);
        assert_eq!(delivery_ids[0], delivery_ids[1]);
    }

    #[test]
    fn active_lifecycle_consumer_can_renew_its_delivery_lease() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("main"));
        consumer
            .dispatch_with("transfer-request", json!({"sequence": 1}), |_, _, _| Ok(()))
            .unwrap();
        let delivery_id = consumer.pending[0].delivery_id.clone();
        consumer.pending[0].lease_expires_at = Some(Instant::now() + Duration::from_millis(1));

        assert!(consumer.renew("main", &delivery_id));
        assert!(
            consumer.pending[0].lease_expires_at.unwrap()
                > Instant::now() + Duration::from_secs(20)
        );
        assert!(!consumer.renew("standby", &delivery_id));
    }

    #[test]
    fn mutating_lifecycle_work_rejects_a_released_delivery_owner() {
        let state = TransferEventConsumerState::default();
        let delivery_id = {
            let mut consumer = state.lock().unwrap();
            assert!(consumer.claim("owner"));
            consumer
                .dispatch_with("outgoing-transfer-committed", json!({}), |_, _, _| Ok(()))
                .unwrap();
            consumer.pending[0].delivery_id.clone()
        };

        assert!(
            require_transfer_lifecycle_event_owner_in_state(&state, "owner", &delivery_id,).is_ok()
        );
        assert!(claim_transfer_lifecycle_phase_in_state(
            &state,
            "owner",
            &delivery_id,
            "pty-finalization-signal",
        )
        .unwrap());
        {
            let mut consumer = state.lock().unwrap();
            consumer.release("owner");
            assert!(consumer.claim("replacement"));
            consumer
                .flush_pending_to("replacement", |_, _, _| Ok(()))
                .unwrap();
        }
        let error = require_transfer_lifecycle_event_owner_in_state(&state, "owner", &delivery_id)
            .unwrap_err();
        assert!(error.contains("no longer owned"));
        assert!(
            !claim_transfer_lifecycle_phase_in_state(
                &state,
                "replacement",
                &delivery_id,
                "pty-finalization-signal",
            )
            .unwrap(),
            "redelivery repeated a single-flight finalization phase",
        );
    }

    #[test]
    fn lifecycle_queue_applies_explicit_count_and_byte_backpressure() {
        let mut consumer = TransferEventConsumer::default();
        for sequence in 0..MAX_PENDING_LIFECYCLE_EVENTS {
            let error = consumer
                .dispatch_with(
                    "task-pull-requested",
                    json!({"sequence": sequence}),
                    |_, _, _| unreachable!("no renderer is registered"),
                )
                .expect_err("queued without a renderer");
            assert_eq!(error, "no ready transfer event consumer");
        }
        let error = consumer
            .dispatch_with(
                "task-pull-requested",
                json!({"overflow": true}),
                |_, _, _| unreachable!("capacity check precedes emit"),
            )
            .expect_err("queue must reject overload");
        assert!(error.contains("capacity"));
        assert_eq!(consumer.pending.len(), MAX_PENDING_LIFECYCLE_EVENTS);
        assert!(consumer.pending_bytes <= MAX_PENDING_LIFECYCLE_BYTES);
    }

    #[test]
    fn task_pull_request_events_emit_expected_tauri_topic() {
        let value = json!({
            "type": "task_pull_requested",
            "request_id": "pull-1",
            "requester_peer_id": "peer-destination",
            "source_task_id": "task-source",
        });

        assert_eq!(forwarded_event_name(&value), Some("task-pull-requested"));
    }
}
