//! Transfer lifecycle-event delivery for the renderer.
//!
//! `kanna-server` owns the `kanna-task-transfer` sidecar and its stdio control
//! plane. What stays here is the half that is genuinely about *windows*: one
//! authoritative renderer is elected to handle the four state-mutating
//! lifecycle events, with leases, ack/nack and redelivery so the work survives
//! that window disappearing.
//!
//! Events reach this queue by long-polling the server's transfer event stream
//! instead of by reading the sidecar's stdout. The queue itself is unchanged
//! and is deleted when orchestration moves server-side.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

pub type TransferEventConsumerState = Arc<std::sync::Mutex<TransferEventConsumer>>;

pub struct TransferEventConsumer {
    ready_labels: VecDeque<String>,
    consumer_incarnations: HashMap<String, String>,
    consumer_registrations: HashMap<String, ConsumerRegistration>,
    pending: VecDeque<PendingLifecycleEvent>,
    pending_bytes: usize,
    next_delivery_id: u64,
}

#[derive(Clone)]
struct ConsumerRegistration {
    label: String,
    release_requested: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEventConsumerClaim {
    pub authoritative: bool,
    pub consumer_incarnation: String,
}

#[derive(Clone)]
struct PendingLifecycleEvent {
    delivery_id: String,
    name: String,
    payload: Value,
    bytes: usize,
    leased_to: Option<String>,
    leased_consumer_incarnation: Option<String>,
    lease_expires_at: Option<Instant>,
    recovery_required: bool,
    claimed_phases: HashSet<String>,
    nacked_by: HashSet<String>,
}

const MAX_PENDING_LIFECYCLE_EVENTS: usize = 256;
const MAX_PENDING_LIFECYCLE_BYTES: usize = 8 * 1024 * 1024;
const LIFECYCLE_EVENT_LEASE: Duration = Duration::from_secs(30);

impl Default for TransferEventConsumer {
    fn default() -> Self {
        Self {
            ready_labels: VecDeque::new(),
            consumer_incarnations: HashMap::new(),
            consumer_registrations: HashMap::new(),
            pending: VecDeque::new(),
            pending_bytes: 0,
            next_delivery_id: 1,
        }
    }
}

impl TransferEventConsumer {
    fn new_consumer_incarnation() -> String {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn claim(&mut self, candidate: &str) -> TransferEventConsumerClaim {
        if let Some(previous_incarnation) = self.consumer_incarnations.get(candidate).cloned() {
            self.release_incarnation(candidate, &previous_incarnation);
        }
        let consumer_incarnation = Self::new_consumer_incarnation();
        self.ready_labels.push_back(candidate.to_string());
        self.consumer_incarnations
            .insert(candidate.to_string(), consumer_incarnation.clone());
        self.consumer_registrations.insert(
            consumer_incarnation.clone(),
            ConsumerRegistration {
                label: candidate.to_string(),
                release_requested: false,
            },
        );
        let authoritative = self
            .ready_labels
            .front()
            .is_some_and(|label| label == candidate);
        TransferEventConsumerClaim {
            authoritative,
            consumer_incarnation,
        }
    }

    fn registration_matches(&self, label: &str, incarnation: &str) -> bool {
        self.consumer_registrations
            .get(incarnation)
            .is_some_and(|registration| registration.label == label)
    }

    fn finish_release_if_idle(&mut self, incarnation: &str) {
        let release_requested = self
            .consumer_registrations
            .get(incarnation)
            .is_some_and(|registration| registration.release_requested);
        let owns_lease = self
            .pending
            .iter()
            .any(|event| event.leased_consumer_incarnation.as_deref() == Some(incarnation));
        if release_requested && !owns_lease {
            self.consumer_registrations.remove(incarnation);
        }
    }

    fn release_incarnation(&mut self, label: &str, incarnation: &str) -> bool {
        if !self.registration_matches(label, incarnation) {
            return false;
        }
        if self
            .consumer_incarnations
            .get(label)
            .is_some_and(|current| current == incarnation)
        {
            self.consumer_incarnations.remove(label);
            self.ready_labels.retain(|candidate| candidate != label);
        }
        if let Some(registration) = self.consumer_registrations.get_mut(incarnation) {
            registration.release_requested = true;
        }
        self.finish_release_if_idle(incarnation);
        true
    }

    #[cfg(test)]
    fn release(&mut self, label: &str) -> bool {
        let Some(incarnation) = self.consumer_incarnations.get(label).cloned() else {
            return false;
        };
        self.release_incarnation(label, &incarnation)
    }

    fn release_unavailable_label(&mut self, label: &str) {
        self.ready_labels.retain(|candidate| candidate != label);
        self.consumer_incarnations.remove(label);
        let incarnations = self
            .consumer_registrations
            .iter()
            .filter(|(_, registration)| registration.label == label)
            .map(|(incarnation, _)| incarnation.clone())
            .collect::<Vec<_>>();
        for incarnation in &incarnations {
            for event in &mut self.pending {
                if event.leased_to.as_deref() == Some(label)
                    && event.leased_consumer_incarnation.as_deref() == Some(incarnation)
                {
                    event.recovery_required = true;
                    event.leased_to = None;
                    event.leased_consumer_incarnation = None;
                    event.lease_expires_at = None;
                }
            }
            self.consumer_registrations.remove(incarnation);
        }
    }

    fn expire_leases(&mut self, now: Instant) {
        let mut expired_incarnations = Vec::new();
        for event in &mut self.pending {
            if event
                .lease_expires_at
                .is_some_and(|lease_expires_at| lease_expires_at <= now)
            {
                if let Some(incarnation) = event.leased_consumer_incarnation.take() {
                    expired_incarnations.push(incarnation);
                }
                event.recovery_required = true;
                event.leased_to = None;
                event.lease_expires_at = None;
            }
        }
        for incarnation in expired_incarnations {
            self.finish_release_if_idle(&incarnation);
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
            leased_consumer_incarnation: None,
            lease_expires_at: None,
            recovery_required: false,
            claimed_phases: HashSet::new(),
            nacked_by: HashSet::new(),
        });
        self.pending_bytes += bytes;
        if self.flush_pending_to_eligible(|target, name, value| emit(target, name, value))? {
            return Ok(());
        }
        Err("no ready transfer event consumer".into())
    }

    #[cfg(test)]
    fn flush_pending_to(
        &mut self,
        label: &str,
        mut emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        let Some(consumer_incarnation) = self.consumer_incarnations.get(label).cloned() else {
            return Ok(false);
        };
        let now = Instant::now();
        self.expire_leases(now);
        let mut failed_emit = None;
        for event in &mut self.pending {
            if event.leased_to.is_some() {
                return Ok(false);
            }
            if event.nacked_by.contains(&consumer_incarnation) {
                continue;
            }
            let mut delivered_payload = event.payload.clone();
            if let Some(object) = delivered_payload.as_object_mut() {
                object.insert(
                    "__kannaLifecycleDeliveryId".into(),
                    Value::String(event.delivery_id.clone()),
                );
                object.insert(
                    "__kannaLifecycleConsumerIncarnation".into(),
                    Value::String(consumer_incarnation.clone()),
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
            event.leased_consumer_incarnation = Some(consumer_incarnation.clone());
            event.lease_expires_at = Some(now + LIFECYCLE_EVENT_LEASE);
            // Preserve lifecycle order and keep renderer work bounded: the
            // next event is offered only after this delivery is acknowledged.
            return Ok(true);
        }
        if let Some(error) = failed_emit {
            self.release_unavailable_label(label);
            return Err(error);
        }
        Ok(false)
    }

    fn flush_pending_to_eligible(
        &mut self,
        mut emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        let mut last_error = None;
        for event_index in 0..self.pending.len() {
            let now = Instant::now();
            self.expire_leases(now);
            if self.pending[event_index].leased_to.is_some() {
                return Ok(false);
            }

            let candidates = self.ready_labels.iter().cloned().collect::<Vec<_>>();
            for label in candidates {
                let Some(consumer_incarnation) = self.consumer_incarnations.get(&label).cloned()
                else {
                    continue;
                };
                if self.pending[event_index]
                    .nacked_by
                    .contains(&consumer_incarnation)
                {
                    continue;
                }
                let event_name = self.pending[event_index].name.clone();
                let mut delivered_payload = self.pending[event_index].payload.clone();
                if let Some(object) = delivered_payload.as_object_mut() {
                    object.insert(
                        "__kannaLifecycleDeliveryId".into(),
                        Value::String(self.pending[event_index].delivery_id.clone()),
                    );
                    object.insert(
                        "__kannaLifecycleConsumerIncarnation".into(),
                        Value::String(consumer_incarnation.clone()),
                    );
                    if self.pending[event_index].recovery_required {
                        object.insert("__kannaLifecycleRecovery".into(), Value::Bool(true));
                    }
                }
                if let Err(error) = emit(&label, &event_name, &delivered_payload) {
                    self.release_unavailable_label(&label);
                    last_error = Some(error);
                    continue;
                }
                let event = &mut self.pending[event_index];
                event.leased_to = Some(label);
                event.leased_consumer_incarnation = Some(consumer_incarnation);
                event.lease_expires_at = Some(now + LIFECYCLE_EVENT_LEASE);
                return Ok(true);
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(false),
        }
    }

    fn acknowledge_incarnation(
        &mut self,
        label: &str,
        consumer_incarnation: &str,
        delivery_id: &str,
    ) -> bool {
        if !self.registration_matches(label, consumer_incarnation) {
            return false;
        }
        let Some(index) = self.pending.iter().position(|event| {
            event.delivery_id == delivery_id
                && event.leased_to.as_deref() == Some(label)
                && event.leased_consumer_incarnation.as_deref() == Some(consumer_incarnation)
        }) else {
            return false;
        };
        if let Some(event) = self.pending.remove(index) {
            self.pending_bytes = self.pending_bytes.saturating_sub(event.bytes);
        }
        self.finish_release_if_idle(consumer_incarnation);
        true
    }

    #[cfg(test)]
    fn acknowledge(&mut self, label: &str, delivery_id: &str) -> bool {
        let Some(consumer_incarnation) = self.consumer_incarnations.get(label).cloned() else {
            return false;
        };
        self.acknowledge_incarnation(label, &consumer_incarnation, delivery_id)
    }

    fn nack_incarnation(
        &mut self,
        label: &str,
        consumer_incarnation: &str,
        delivery_id: &str,
    ) -> bool {
        if !self.registration_matches(label, consumer_incarnation) {
            return false;
        }
        let Some(event) = self.pending.iter_mut().find(|event| {
            event.delivery_id == delivery_id
                && event.leased_to.as_deref() == Some(label)
                && event.leased_consumer_incarnation.as_deref() == Some(consumer_incarnation)
        }) else {
            return false;
        };
        event.recovery_required = true;
        event.leased_to = None;
        event.leased_consumer_incarnation = None;
        event.lease_expires_at = None;
        // A NACK excludes this renderer only from this delivery. It remains a
        // mounted consumer for later queue entries.
        event.nacked_by.insert(consumer_incarnation.to_string());
        self.finish_release_if_idle(consumer_incarnation);
        true
    }

    fn nack_with_incarnation(
        &mut self,
        label: &str,
        consumer_incarnation: &str,
        delivery_id: &str,
        mut emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        if !self.nack_incarnation(label, consumer_incarnation, delivery_id) {
            return Ok(false);
        }
        self.flush_pending_to_eligible(|target, event_name, payload| {
            emit(target, event_name, payload)
        })?;
        Ok(true)
    }

    #[cfg(test)]
    fn nack_with(
        &mut self,
        label: &str,
        delivery_id: &str,
        emit: impl FnMut(&str, &str, &Value) -> Result<(), String>,
    ) -> Result<bool, String> {
        let Some(consumer_incarnation) = self.consumer_incarnations.get(label).cloned() else {
            return Ok(false);
        };
        self.nack_with_incarnation(label, &consumer_incarnation, delivery_id, emit)
    }

    fn renew_incarnation(
        &mut self,
        label: &str,
        consumer_incarnation: &str,
        delivery_id: &str,
    ) -> bool {
        if !self.registration_matches(label, consumer_incarnation) {
            return false;
        }
        let Some(event) = self.pending.iter_mut().find(|event| {
            event.delivery_id == delivery_id
                && event.leased_to.as_deref() == Some(label)
                && event.leased_consumer_incarnation.as_deref() == Some(consumer_incarnation)
        }) else {
            return false;
        };
        event.lease_expires_at = Some(Instant::now() + LIFECYCLE_EVENT_LEASE);
        true
    }

    #[cfg(test)]
    fn renew(&mut self, label: &str, delivery_id: &str) -> bool {
        let Some(consumer_incarnation) = self.consumer_incarnations.get(label).cloned() else {
            return false;
        };
        self.renew_incarnation(label, &consumer_incarnation, delivery_id)
    }

    fn claim_phase_incarnation(
        &mut self,
        label: &str,
        consumer_incarnation: &str,
        delivery_id: &str,
        phase: &str,
    ) -> Result<bool, String> {
        if !self.registration_matches(label, consumer_incarnation) {
            return Err(format!(
                "transfer lifecycle delivery {delivery_id} is no longer owned by {label}",
            ));
        }
        let event = self
            .pending
            .iter_mut()
            .find(|event| event.delivery_id == delivery_id)
            .ok_or_else(|| format!("unknown transfer lifecycle delivery {delivery_id}"))?;
        if event.leased_to.as_deref() != Some(label)
            || event.leased_consumer_incarnation.as_deref() != Some(consumer_incarnation)
        {
            return Err(format!(
                "transfer lifecycle delivery {delivery_id} is no longer owned by {label}",
            ));
        }
        event.lease_expires_at = Some(Instant::now() + LIFECYCLE_EVENT_LEASE);
        Ok(event.claimed_phases.insert(phase.to_string()))
    }
}

/// Reclaim leases from windows that vanished and re-offer their undelivered
/// work to a standby. Independent of the sidecar's lifetime, so it runs for
/// the app's lifetime.
pub fn spawn_lifecycle_redelivery(app: AppHandle) {
    let state = app.state::<TransferEventConsumerState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let mut consumer = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let stale_labels = consumer
                .ready_labels
                .iter()
                .filter(|label| app.get_webview_window(label).is_none())
                .cloned()
                .collect::<Vec<_>>();
            for label in stale_labels {
                consumer.release_unavailable_label(&label);
            }
            if let Err(error) = consumer.flush_pending_to_eligible(|target, event_name, payload| {
                app.emit_to(EventTarget::webview_window(target), event_name, payload)
                    .map_err(|error| error.to_string())
            }) {
                eprintln!("[transfer-sidecar] failed redelivering lifecycle event: {error}");
            }
        }
    });
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
) -> Result<TransferEventConsumerClaim, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stale_labels = consumer
        .ready_labels
        .iter()
        .filter(|candidate| app.get_webview_window(candidate).is_none())
        .cloned()
        .collect::<Vec<_>>();
    for stale_label in stale_labels {
        consumer.release_unavailable_label(&stale_label);
    }
    let claim = consumer.claim(label);

    consumer.flush_pending_to_eligible(|target, event_name, payload| {
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
    Ok(claim)
}

pub fn release_transfer_event_consumer_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
    consumer_incarnation: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !consumer.release_incarnation(label, consumer_incarnation) {
        return Ok(false);
    }
    consumer.flush_pending_to_eligible(|target, event_name, payload| {
        if app.get_webview_window(target).is_none() {
            return Err(format!(
                "standby transfer event consumer {target} is no longer available"
            ));
        }
        app.emit_to(EventTarget::webview_window(target), event_name, payload)
            .map_err(|error| {
                format!("failed delivering queued transfer lifecycle event to {target}: {error}")
            })
    })?;
    Ok(true)
}

pub fn acknowledge_transfer_lifecycle_event_in_state(
    app: &AppHandle,
    state: &TransferEventConsumerState,
    label: &str,
    consumer_incarnation: &str,
    delivery_id: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !consumer.acknowledge_incarnation(label, consumer_incarnation, delivery_id) {
        return Ok(false);
    }
    consumer.flush_pending_to_eligible(|target, event_name, payload| {
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
    consumer_incarnation: &str,
    delivery_id: &str,
) -> Result<bool, String> {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer.nack_with_incarnation(
        label,
        consumer_incarnation,
        delivery_id,
        |target, event_name, payload| {
            if app.get_webview_window(target).is_none() {
                return Err(format!(
                    "transfer event consumer {target} is no longer available"
                ));
            }
            app.emit_to(EventTarget::webview_window(target), event_name, payload)
                .map_err(|error| error.to_string())
        },
    )
}

pub fn renew_transfer_lifecycle_event_in_state(
    state: &TransferEventConsumerState,
    label: &str,
    consumer_incarnation: &str,
    delivery_id: &str,
) -> bool {
    let mut consumer = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    consumer.renew_incarnation(label, consumer_incarnation, delivery_id)
}

pub fn require_transfer_lifecycle_event_owner_in_state(
    state: &TransferEventConsumerState,
    label: &str,
    consumer_incarnation: &str,
    delivery_id: &str,
) -> Result<(), String> {
    if renew_transfer_lifecycle_event_in_state(state, label, consumer_incarnation, delivery_id) {
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
    consumer_incarnation: &str,
    delivery_id: &str,
    phase: &str,
) -> Result<bool, String> {
    if phase.trim().is_empty() {
        return Err("transfer lifecycle phase must not be empty".into());
    }
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim_phase_incarnation(label, consumer_incarnation, delivery_id, phase)
}
/// Long-poll the server's sidecar event stream and feed the lifecycle queue.
///
/// This replaces the stdout reader the desktop used to own. The cursor is held
/// here and only advanced once an event has been queued or emitted, so a
/// failed hand-off is retried rather than skipped. The server prunes through
/// the cursor it is given, which is why exactly one of these runs per app.
pub fn spawn_transfer_event_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // App startup owns starting kanna-server. Polling before it is up
        // would race that start for the server lock and make one of the two
        // fail, so wait for it rather than starting a second one.
        crate::commands::mobile::wait_for_server_started(&app).await;
        let client = reqwest::Client::new();
        let mut cursor: Option<u64> = None;
        loop {
            match poll_transfer_events(&app, &client, cursor).await {
                Ok(batch) => {
                    if batch.missed_events {
                        eprintln!(
                            "[transfer-events] server dropped advisory transfer events before cursor {:?}",
                            cursor
                        );
                    }
                    for entry in batch.events {
                        deliver_transfer_event(&app, &entry).await;
                    }
                    cursor = Some(batch.cursor);
                }
                Err(error) => {
                    // The server restarts independently of this process; a
                    // failed poll is expected during that window.
                    eprintln!("[transfer-events] poll failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

#[derive(Debug)]
struct TransferEventBatch {
    events: Vec<TransferEventEntry>,
    cursor: u64,
    missed_events: bool,
}

#[derive(Debug)]
struct TransferEventEntry {
    durable: bool,
    event: Value,
}

async fn poll_transfer_events(
    app: &AppHandle,
    client: &reqwest::Client,
    cursor: Option<u64>,
) -> Result<TransferEventBatch, String> {
    let base_url = crate::commands::mobile::ensure_server_base_url(app).await?;
    let mut url = format!("{base_url}/v1/transfers/sidecar/events?timeoutSecs=25");
    if let Some(cursor) = cursor {
        url.push_str(&format!("&cursor={cursor}"));
    }
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|error| format!("transfer event request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "transfer event request failed: {}",
            response.status()
        ));
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("invalid transfer event response: {error}"))?;
    parse_transfer_event_batch(&body)
}

/// A malformed batch is an error, never a silently shorter one: dropping an
/// entry here would lose a transfer step with no trace.
fn parse_transfer_event_batch(body: &Value) -> Result<TransferEventBatch, String> {
    let cursor = body
        .get("cursor")
        .and_then(Value::as_u64)
        .ok_or_else(|| "transfer event response missing cursor".to_string())?;
    let events = body
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "transfer event response missing events".to_string())?
        .iter()
        .map(|entry| {
            Ok(TransferEventEntry {
                durable: entry
                    .get("durable")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "transfer event entry missing durable".to_string())?,
                event: entry
                    .get("event")
                    .cloned()
                    .ok_or_else(|| "transfer event entry missing event".to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(TransferEventBatch {
        events,
        cursor,
        missed_events: body
            .get("missedEvents")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

async fn deliver_transfer_event(app: &AppHandle, entry: &TransferEventEntry) {
    let Some(event_name) = forwarded_event_name(&entry.event) else {
        eprintln!("[transfer-events] unhandled sidecar event: {}", entry.event);
        return;
    };
    if !entry.durable {
        let _ = app.emit(event_name, &entry.event);
        return;
    }
    let consumer = app.state::<TransferEventConsumerState>().inner().clone();
    loop {
        match dispatch_lifecycle_event(app, &consumer, event_name, entry.event.clone()) {
            Ok(()) => return,
            Err(error) if error.contains("queue capacity") => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => {
                eprintln!("[transfer-events] queued undelivered {event_name} event: {error}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transfer_event_batches_carry_durability_and_advance_the_cursor() {
        let batch = parse_transfer_event_batch(&json!({
            "cursor": 7,
            "missedEvents": true,
            "events": [
                {
                    "seq": 7,
                    "durable": true,
                    "event": { "type": "task_pull_requested", "transfer_id": "t-1" },
                },
            ],
        }))
        .expect("batch should parse");
        assert_eq!(batch.cursor, 7);
        assert!(batch.missed_events);
        assert_eq!(batch.events.len(), 1);
        assert!(batch.events[0].durable);
        assert_eq!(
            forwarded_event_name(&batch.events[0].event),
            Some("task-pull-requested")
        );
    }

    #[test]
    fn a_batch_entry_without_durability_fails_instead_of_being_skipped() {
        let error = parse_transfer_event_batch(&json!({
            "cursor": 1,
            "events": [{ "seq": 1, "event": { "type": "task_pull_requested" } }],
        }))
        .expect_err("a malformed entry must not be silently dropped");
        assert!(error.contains("durable"), "{error}");
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
        assert!(consumer.claim("window-z").authoritative);
        assert!(!consumer.claim("main").authoritative);
        assert!(!consumer.claim("window-a").authoritative);
        consumer.release("window-z");
        // Authority moves to the next standby in claim order. Re-claiming a label
        // is not a query: it always mints a replacement incarnation and re-queues
        // that label behind the consumers already waiting.
        assert_eq!(
            consumer.ready_labels.front().map(String::as_str),
            Some("main"),
        );
        assert!(!consumer.claim("window-a").authoritative);
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
        assert!(consumer.claim("main").authoritative);

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
        assert!(consumer.claim("window-stale").authoritative);
        assert!(!consumer.claim("window-ready").authoritative);
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
        assert!(consumer.claim("window-owner").authoritative);
        assert!(!consumer.claim("window-standby").authoritative);
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
        assert!(consumer.claim("window-owner").authoritative);
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
        assert!(!consumer.claim("window-standby").authoritative);

        // The owner window is gone, so it can never settle its delivery: the
        // queue reclaims the lease outright instead of waiting for a settlement.
        consumer.release_unavailable_label("window-owner");
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
    fn nacked_lifecycle_delivery_reemits_only_to_standby_consumers_and_stops_when_exhausted() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("window-owner").authoritative);
        assert!(!consumer.claim("window-standby").authoritative);
        let mut delivered_to = Vec::new();
        consumer
            .dispatch_with(
                "task-pull-requested",
                json!({"sequence": 1}),
                |label, _, _| {
                    delivered_to.push(label.to_string());
                    Ok(())
                },
            )
            .expect("owner should receive initial delivery");
        let delivery_id = consumer.pending[0].delivery_id.clone();

        assert!(consumer
            .nack_with("window-owner", &delivery_id, |label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("owner NACK should settle"));
        assert!(consumer
            .nack_with("window-standby", &delivery_id, |_, _, _| {
                unreachable!("no consumer remains for another re-emission")
            })
            .expect("standby NACK should settle"));

        assert_eq!(delivered_to, ["window-owner", "window-standby"]);
        assert_eq!(
            consumer.ready_labels.iter().cloned().collect::<Vec<_>>(),
            ["window-owner", "window-standby"],
        );
        assert!(consumer.pending[0].recovery_required);
        assert_eq!(consumer.pending[0].leased_to, None);
    }

    #[test]
    fn nacked_lifecycle_delivery_reaches_a_standby_claimed_after_the_nack() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("window-owner").authoritative);
        let mut delivered_to = Vec::new();
        consumer
            .dispatch_with("task-pull-requested", json!({}), |label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("owner should receive initial delivery");
        let delivery_id = consumer.pending[0].delivery_id.clone();
        assert!(consumer
            .nack_with("window-owner", &delivery_id, |_, _, _| {
                unreachable!("no standby exists yet")
            })
            .expect("owner NACK should retain the delivery"));

        assert!(!consumer.claim("window-late-standby").authoritative);
        assert!(consumer
            .flush_pending_to_eligible(|label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("late standby selection should succeed"));

        assert_eq!(delivered_to, ["window-owner", "window-late-standby"]);
        assert_eq!(
            consumer.pending[0].leased_to.as_deref(),
            Some("window-late-standby"),
        );
    }

    #[test]
    fn nacked_lifecycle_delivery_reaches_a_new_incarnation_with_the_same_label() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("main").authoritative);
        let mut delivered_to = Vec::new();
        consumer
            .dispatch_with("task-pull-requested", json!({}), |label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("first main incarnation should receive initial delivery");
        let delivery_id = consumer.pending[0].delivery_id.clone();
        assert!(consumer
            .nack_with("main", &delivery_id, |_, _, _| {
                unreachable!("the only consumer NACKed")
            })
            .expect("first main incarnation NACK should retain the delivery"));

        consumer.release("main");
        assert!(consumer.claim("main").authoritative);
        assert!(consumer
            .flush_pending_to_eligible(|label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("replacement main incarnation should be eligible"));

        assert_eq!(delivered_to, ["main", "main"]);
        assert_eq!(consumer.pending[0].leased_to.as_deref(), Some("main"));
    }

    #[test]
    fn release_waits_for_exact_incarnation_settlement_before_redelivery() {
        let mut consumer = TransferEventConsumer::default();
        let owner = consumer.claim("window-owner");
        let standby = consumer.claim("window-standby");
        let mut delivered_to = Vec::new();
        consumer
            .dispatch_with("task-pull-requested", json!({}), |label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("owner should receive the task pull");
        let delivery_id = consumer.pending[0].delivery_id.clone();

        assert!(consumer.release_incarnation("window-owner", &owner.consumer_incarnation,));
        assert!(!consumer
            .flush_pending_to_eligible(|label, _, _| {
                delivered_to.push(label.to_string());
                Ok(())
            })
            .expect("release should defer while settlement is pending"));
        assert_eq!(delivered_to, ["window-owner"]);
        assert_eq!(
            consumer.pending[0].leased_consumer_incarnation.as_deref(),
            Some(owner.consumer_incarnation.as_str()),
        );

        assert!(consumer.acknowledge_incarnation(
            "window-owner",
            &owner.consumer_incarnation,
            &delivery_id,
        ));
        assert!(consumer.pending.is_empty());
        assert!(!consumer.consumer_incarnations.contains_key("window-owner"));
        assert_eq!(
            consumer
                .consumer_incarnations
                .get("window-standby")
                .map(String::as_str),
            Some(standby.consumer_incarnation.as_str()),
        );
        assert_eq!(delivered_to, ["window-owner"]);
    }

    #[test]
    fn delayed_commands_from_an_old_same_label_incarnation_cannot_act_on_replacement() {
        let mut consumer = TransferEventConsumer::default();
        let first = consumer.claim("main");
        consumer
            .dispatch_with("task-pull-requested", json!({}), |_, _, _| Ok(()))
            .expect("first incarnation receives a delivery");
        let first_delivery = consumer.pending[0].delivery_id.clone();
        assert!(consumer.acknowledge_incarnation(
            "main",
            &first.consumer_incarnation,
            &first_delivery,
        ));

        let replacement = consumer.claim("main");
        assert_ne!(first.consumer_incarnation, replacement.consumer_incarnation,);
        consumer
            .dispatch_with("outgoing-transfer-committed", json!({}), |_, _, _| Ok(()))
            .expect("replacement receives a delivery");
        let replacement_delivery = consumer.pending[0].delivery_id.clone();

        assert!(!consumer.release_incarnation("main", &first.consumer_incarnation));
        assert!(!consumer.acknowledge_incarnation(
            "main",
            &first.consumer_incarnation,
            &replacement_delivery,
        ));
        assert!(!consumer.nack_incarnation(
            "main",
            &first.consumer_incarnation,
            &replacement_delivery,
        ));
        assert!(!consumer.renew_incarnation(
            "main",
            &first.consumer_incarnation,
            &replacement_delivery,
        ));
        assert!(consumer
            .claim_phase_incarnation(
                "main",
                &first.consumer_incarnation,
                &replacement_delivery,
                "stale-phase",
            )
            .is_err());
        assert!(consumer.renew_incarnation(
            "main",
            &replacement.consumer_incarnation,
            &replacement_delivery,
        ));
        assert!(consumer
            .claim_phase_incarnation(
                "main",
                &replacement.consumer_incarnation,
                &replacement_delivery,
                "replacement-phase",
            )
            .expect("replacement owns its phase"));
    }

    #[test]
    fn exhausted_nack_candidates_remain_available_for_later_deliveries() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("window-owner").authoritative);
        assert!(!consumer.claim("window-standby").authoritative);
        let mut delivered = Vec::new();
        consumer
            .dispatch_with(
                "task-pull-requested",
                json!({"sequence": 1}),
                |label, _, payload| {
                    delivered.push((label.to_string(), payload["sequence"].clone()));
                    Ok(())
                },
            )
            .expect("owner should receive initial delivery");
        let delivery_id = consumer.pending[0].delivery_id.clone();
        assert!(consumer
            .nack_with("window-owner", &delivery_id, |label, _, payload| {
                delivered.push((label.to_string(), payload["sequence"].clone()));
                Ok(())
            })
            .expect("owner NACK should settle"));
        assert!(consumer
            .nack_with("window-standby", &delivery_id, |_, _, _| {
                unreachable!("the first delivery exhausted its candidates")
            })
            .expect("standby NACK should settle"));

        consumer
            .dispatch_with(
                "outgoing-transfer-committed",
                json!({"sequence": 2}),
                |label, _, payload| {
                    delivered.push((label.to_string(), payload["sequence"].clone()));
                    Ok(())
                },
            )
            .expect("a mounted consumer should receive the later delivery");

        assert_eq!(
            delivered,
            [
                ("window-owner".to_string(), json!(1)),
                ("window-standby".to_string(), json!(1)),
                ("window-owner".to_string(), json!(2)),
            ],
        );
        assert_eq!(
            consumer.ready_labels.iter().cloned().collect::<Vec<_>>(),
            ["window-owner", "window-standby"],
        );
    }

    #[test]
    fn expired_lifecycle_delivery_lease_is_redelivered_with_the_same_id() {
        let mut consumer = TransferEventConsumer::default();
        assert!(consumer.claim("main").authoritative);
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
        assert!(consumer.claim("main").authoritative);
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
        let (owner, delivery_id) = {
            let mut consumer = state.lock().unwrap();
            let owner = consumer.claim("owner");
            assert!(owner.authoritative);
            consumer
                .dispatch_with("outgoing-transfer-committed", json!({}), |_, _, _| Ok(()))
                .unwrap();
            let delivery_id = consumer.pending[0].delivery_id.clone();
            (owner, delivery_id)
        };

        assert!(require_transfer_lifecycle_event_owner_in_state(
            &state,
            "owner",
            &owner.consumer_incarnation,
            &delivery_id,
        )
        .is_ok());
        assert!(claim_transfer_lifecycle_phase_in_state(
            &state,
            "owner",
            &owner.consumer_incarnation,
            &delivery_id,
            "pty-finalization-signal",
        )
        .unwrap());
        let replacement = {
            let mut consumer = state.lock().unwrap();
            assert!(consumer.release_incarnation("owner", &owner.consumer_incarnation));
            let replacement = consumer.claim("replacement");
            // A released owner keeps its in-flight delivery until it settles, so
            // the replacement cannot be handed the same work concurrently.
            assert!(!consumer
                .flush_pending_to("replacement", |_, _, _| Ok(()))
                .unwrap());
            assert!(consumer.nack_incarnation("owner", &owner.consumer_incarnation, &delivery_id,));
            assert!(consumer
                .flush_pending_to("replacement", |_, _, _| Ok(()))
                .unwrap());
            replacement
        };

        let error = require_transfer_lifecycle_event_owner_in_state(
            &state,
            "owner",
            &owner.consumer_incarnation,
            &delivery_id,
        )
        .unwrap_err();
        assert!(error.contains("no longer owned"));
        assert!(
            !claim_transfer_lifecycle_phase_in_state(
                &state,
                "replacement",
                &replacement.consumer_incarnation,
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
