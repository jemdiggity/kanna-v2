use crate::db::{SnapshotPipelineItem, UiSnapshot};
use crate::http_api::settings::{CloudTransferIdentity, CLOUD_TRANSFER_IDENTITY_SETTING};
use kanna_agent_protocol::AgentProvider;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::time::{Duration, Instant};

const MAX_PUBLISH_ATTEMPTS: u8 = 3;
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
const CLOUD_TASK_SCHEMA_V1: u8 = 1;
const CLOUD_TASK_SCHEMA_V2: u8 = 2;

#[derive(Debug, Clone)]
struct RestingSnippet {
    value: Option<String>,
    activity: String,
    transition_revision: Option<String>,
    closed: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RestingSnippetCache {
    tasks: HashMap<String, RestingSnippet>,
}

impl RestingSnippetCache {
    fn retain_boundary_value(&mut self, item: &SnapshotPipelineItem) -> Option<String> {
        let live = truncate_option(item.last_output_preview.clone(), 240);
        let closed = item.closed_at.is_some();
        let previous = self.tasks.get(&item.id);
        let boundary = previous.is_none_or(|previous| {
            (!previous.closed && closed)
                || (previous.activity == "working"
                    && matches!(item.activity.as_str(), "idle" | "unread"))
                || previous.transition_revision != item.transition_revision
        });
        let value = if boundary {
            live
        } else {
            previous.and_then(|previous| previous.value.clone())
        };
        self.tasks.insert(
            item.id.clone(),
            RestingSnippet {
                value: value.clone(),
                activity: item.activity.clone(),
                transition_revision: item.transition_revision.clone(),
                closed,
            },
        );
        value
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudTaskSnapshotEnvelope {
    schema_version: u8,
    desktop: CloudDesktopSnapshot,
    tasks: Vec<CloudTaskSnapshot>,
}

impl CloudTaskSnapshotEnvelope {
    pub(crate) fn fingerprint(&self) -> String {
        serde_json::to_string(self).expect("cloud task snapshot must serialize")
    }

    fn for_publication_version(mut self, version: u8) -> Self {
        if version == CLOUD_TASK_SCHEMA_V2 {
            self.schema_version = CLOUD_TASK_SCHEMA_V2;
            return self;
        }
        self.schema_version = CLOUD_TASK_SCHEMA_V1;
        for task in &mut self.tasks {
            task.transfer = CloudTransferSnapshot::none();
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudDesktopSnapshot {
    display_name: String,
    /// Agent provider CLIs installed on this desktop, in registry order. The
    /// relay stores it on the desktop document so a phone off the LAN learns
    /// the machine's inventory from the record that already describes the
    /// machine, without a round trip to it. Absent from desktops that predate
    /// the field, which mobile reads as "unknown", not "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_providers: Option<Vec<AgentProvider>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transfer: Option<CloudDesktopTransferSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudDesktopTransferSnapshot {
    peer_id: String,
    public_key: String,
    protocol_version: u16,
    accepting_transfers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudTaskSnapshot {
    cloud_task_id: String,
    local_repo_id: String,
    owner_desktop_id: String,
    owner_local_task_id: String,
    title: String,
    prompt_snippet: Option<String>,
    waiting_prompt_snippet: Option<String>,
    display_name: Option<String>,
    stage: String,
    activity: String,
    activity_revision: i64,
    blocker_revision: i64,
    transition_revision: Option<String>,
    status: String,
    has_running_post: bool,
    queued_input_count: i64,
    queued_input_reason: Option<String>,
    repo: CloudRepoSnapshot,
    branch: Option<String>,
    base_ref: Option<String>,
    pr_number: Option<i64>,
    pr_url: Option<String>,
    agent: CloudAgentSnapshot,
    transfer: CloudTransferSnapshot,
    blocked_by_task_ids: Vec<String>,
    parent_task_id: Option<String>,
    pinned: bool,
    pin_order: Option<i64>,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudRepoSnapshot {
    cloud_repo_id: String,
    name: String,
    remote_url: Option<String>,
    remote_url_hash: Option<String>,
    default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloudAgentSnapshot {
    provider: String,
    #[serde(rename = "type")]
    execution_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudTransferSnapshot {
    state: String,
    transfer_id: Option<String>,
    source_desktop_id: Option<String>,
    destination_desktop_id: Option<String>,
}

impl CloudTransferSnapshot {
    fn none() -> Self {
        Self {
            state: "none".into(),
            transfer_id: None,
            source_desktop_id: None,
            destination_desktop_id: None,
        }
    }
}

#[cfg(test)]
pub(crate) fn map_ui_snapshot(
    desktop_id: &str,
    desktop_name: &str,
    agent_providers: Vec<AgentProvider>,
    snapshot: UiSnapshot,
) -> CloudTaskSnapshotEnvelope {
    map_ui_snapshot_with_snippets(desktop_id, desktop_name, agent_providers, snapshot, None)
}

pub(crate) fn map_ui_snapshot_for_publication(
    desktop_id: &str,
    desktop_name: &str,
    agent_providers: Vec<AgentProvider>,
    snapshot: UiSnapshot,
    resting_snippets: &mut RestingSnippetCache,
) -> CloudTaskSnapshotEnvelope {
    map_ui_snapshot_with_snippets(
        desktop_id,
        desktop_name,
        agent_providers,
        snapshot,
        Some(resting_snippets),
    )
}

fn map_ui_snapshot_with_snippets(
    desktop_id: &str,
    desktop_name: &str,
    agent_providers: Vec<AgentProvider>,
    snapshot: UiSnapshot,
    mut resting_snippets: Option<&mut RestingSnippetCache>,
) -> CloudTaskSnapshotEnvelope {
    let desktop_transfer = snapshot
        .settings
        .get(CLOUD_TRANSFER_IDENTITY_SETTING)
        .and_then(|encoded| serde_json::from_str::<CloudTransferIdentity>(encoded).ok())
        .filter(valid_cloud_transfer_identity)
        .map(|identity| CloudDesktopTransferSnapshot {
            peer_id: identity.peer_id,
            public_key: identity.public_key,
            protocol_version: identity.protocol_version,
            accepting_transfers: identity.accepting_transfers,
        });
    let blockers = snapshot.task_blockers.into_iter().fold(
        HashMap::<String, Vec<String>>::new(),
        |mut by_task, blocker| {
            if snapshot
                .blocker_task_states
                .get(&blocker.blocker_item_id)
                .is_some_and(|state| state.is_resolved())
            {
                return by_task;
            }
            by_task
                .entry(blocker.blocked_item_id)
                .or_default()
                .push(blocker.blocker_item_id);
            by_task
        },
    );
    let mut tasks = Vec::new();

    for entry in snapshot.entries {
        for item in entry.items {
            let blocked_by_task_ids = blockers.get(&item.id).cloned().unwrap_or_default();
            let resting_snippet = resting_snippets
                .as_deref_mut()
                .map(|cache| cache.retain_boundary_value(&item));
            tasks.push(map_task(
                desktop_id,
                &entry.repo,
                item,
                blocked_by_task_ids,
                resting_snippet,
            ));
        }
    }
    tasks.sort_by(|left, right| {
        left.local_repo_id
            .cmp(&right.local_repo_id)
            .then(left.owner_local_task_id.cmp(&right.owner_local_task_id))
    });

    CloudTaskSnapshotEnvelope {
        schema_version: CLOUD_TASK_SCHEMA_V2,
        desktop: CloudDesktopSnapshot {
            display_name: truncate(desktop_name, 256),
            agent_providers: Some(agent_providers),
            transfer: desktop_transfer,
        },
        tasks,
    }
}

fn valid_cloud_transfer_identity(identity: &CloudTransferIdentity) -> bool {
    !identity.peer_id.trim().is_empty()
        && identity.peer_id.chars().count() <= 256
        && !identity.public_key.trim().is_empty()
        && identity.public_key.chars().count() <= 4096
        && identity.protocol_version > 0
}

fn map_task(
    desktop_id: &str,
    repo: &crate::db::SnapshotRepo,
    item: SnapshotPipelineItem,
    blocked_by_task_ids: Vec<String>,
    resting_snippet: Option<Option<String>>,
) -> CloudTaskSnapshot {
    let transfer = map_transfer(&item);
    let prompt = item.prompt.unwrap_or_default();
    let title = item
        .display_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            prompt
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| item.id.clone());
    let status = if item.closed_at.is_some() {
        "done"
    } else if !blocked_by_task_ids.is_empty() {
        "blocked"
    } else if item.stage == "pr" {
        "pr"
    } else {
        "active"
    };

    let updated_at = item
        .updated_at
        .clone()
        .or_else(|| item.created_at.clone())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let created_at = item
        .created_at
        .clone()
        .unwrap_or_else(|| updated_at.clone());

    CloudTaskSnapshot {
        cloud_task_id: item.cloud_task_id,
        local_repo_id: repo.id.clone(),
        owner_desktop_id: desktop_id.to_string(),
        owner_local_task_id: item.id,
        title: truncate(&title, 512),
        prompt_snippet: (!prompt.is_empty()).then(|| prompt.chars().take(500).collect()),
        waiting_prompt_snippet: resting_snippet
            .unwrap_or_else(|| truncate_option(item.last_output_preview, 240)),
        display_name: truncate_option(item.display_name, 512),
        stage: truncate(&item.stage, 64),
        activity: truncate(&item.activity, 32),
        activity_revision: item.activity_revision,
        blocker_revision: item.blocker_revision,
        transition_revision: item.transition_revision,
        status: status.into(),
        has_running_post: item.has_running_post != 0,
        queued_input_count: item.queued_input_count,
        queued_input_reason: item.queued_input_reason,
        repo: CloudRepoSnapshot {
            cloud_repo_id: repo.id.clone(),
            name: truncate(&repo.name, 256),
            remote_url: truncate_option(repo.remote_url.clone(), 2048),
            remote_url_hash: truncate_option(repo.remote_url_hash.clone(), 128),
            default_branch: truncate_option(repo.default_branch.clone(), 512),
        },
        branch: truncate_option(item.branch, 512),
        base_ref: truncate_option(item.base_ref, 512),
        pr_number: item.pr_number,
        pr_url: truncate_option(item.pr_url, 2048),
        agent: CloudAgentSnapshot {
            provider: truncate(&item.agent_provider, 64),
            execution_type: truncate(&item.agent_type.unwrap_or_else(|| "pty".into()), 32),
        },
        transfer,
        blocked_by_task_ids: blocked_by_task_ids.into_iter().take(100).collect(),
        parent_task_id: truncate_option(item.parent_task_id, 128),
        pinned: item.pinned != 0,
        pin_order: item.pin_order,
        created_at,
        updated_at,
        closed_at: item.closed_at,
    }
}

fn map_transfer(item: &SnapshotPipelineItem) -> CloudTransferSnapshot {
    let Some(transfer_id) = nonblank(item.transfer_id.as_deref()) else {
        return CloudTransferSnapshot::none();
    };
    let Some(source_desktop_id) = nonblank(item.transfer_source_desktop_id.as_deref()) else {
        return CloudTransferSnapshot::none();
    };
    let Some(destination_desktop_id) = nonblank(item.transfer_target_desktop_id.as_deref()) else {
        return CloudTransferSnapshot::none();
    };
    let state = match (
        item.transfer_direction.as_deref(),
        item.transfer_status.as_deref(),
    ) {
        (Some("outgoing"), Some("pending" | "streaming")) => "outgoing",
        (Some("incoming"), Some("pending" | "claimed" | "streaming" | "importing")) => "incoming",
        (Some("incoming"), Some("awaiting_acknowledgment")) if item.closed_at.is_none() => {
            "finalization_pending"
        }
        _ => return CloudTransferSnapshot::none(),
    };

    CloudTransferSnapshot {
        state: state.into(),
        transfer_id: Some(transfer_id.into()),
        source_desktop_id: Some(source_desktop_id.into()),
        destination_desktop_id: Some(destination_desktop_id.into()),
    }
}

fn nonblank(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn truncate_option(value: Option<String>, max_chars: usize) -> Option<String> {
    value.map(|value| truncate(&value, max_chars))
}

#[derive(Debug, Clone)]
pub(crate) struct PublishRequest {
    pub(crate) id: String,
    pub(crate) snapshot: CloudTaskSnapshotEnvelope,
}

#[derive(Debug)]
struct InFlight {
    request: PublishRequest,
    attempt: u8,
    sent_at: Instant,
}

#[derive(Debug)]
pub(crate) enum PublisherStep {
    Publish(PublishRequest),
    Reconnect,
    Wait,
}

#[derive(Debug)]
pub(crate) struct PublisherState {
    authenticated: bool,
    publication_version: u8,
    force_reconcile: bool,
    latest: Option<CloudTaskSnapshotEnvelope>,
    last_acked_fingerprint: Option<String>,
    in_flight: Option<InFlight>,
    retry_at: Option<(Instant, u8)>,
    reconnect: bool,
    next_id: u64,
}

impl PublisherState {
    pub(crate) fn new() -> Self {
        Self {
            authenticated: false,
            publication_version: CLOUD_TASK_SCHEMA_V1,
            force_reconcile: false,
            latest: None,
            last_acked_fingerprint: None,
            in_flight: None,
            retry_at: None,
            reconnect: false,
            next_id: 1,
        }
    }

    pub(crate) fn on_authenticated(&mut self, advertised_version: Option<u64>) {
        self.authenticated = true;
        self.publication_version = match advertised_version {
            Some(2) => CLOUD_TASK_SCHEMA_V2,
            _ => CLOUD_TASK_SCHEMA_V1,
        };
        self.force_reconcile = true;
        self.reconnect = false;
    }

    pub(crate) fn on_disconnected(&mut self) {
        self.authenticated = false;
        self.force_reconcile = true;
        self.in_flight = None;
        self.retry_at = None;
        self.reconnect = false;
    }

    pub(crate) fn observe(&mut self, snapshot: CloudTaskSnapshotEnvelope) {
        self.latest = Some(snapshot);
    }

    pub(crate) fn next_step(&mut self, now: Instant) -> PublisherStep {
        if self.reconnect {
            return PublisherStep::Reconnect;
        }
        if !self.authenticated {
            return PublisherStep::Wait;
        }
        if let Some(in_flight) = self.in_flight.take() {
            if now.duration_since(in_flight.sent_at) < ACK_TIMEOUT {
                self.in_flight = Some(in_flight);
                return PublisherStep::Wait;
            }
            self.schedule_failure(in_flight.attempt, now);
        }
        if self.reconnect {
            return PublisherStep::Reconnect;
        }

        let attempt = match self.retry_at {
            Some((ready_at, _)) if now < ready_at => return PublisherStep::Wait,
            Some((_, attempt)) => attempt,
            None => 1,
        };
        let Some(snapshot) = self
            .latest
            .clone()
            .map(|snapshot| snapshot.for_publication_version(self.publication_version))
        else {
            return PublisherStep::Wait;
        };
        let fingerprint = snapshot.fingerprint();
        if self.retry_at.is_none()
            && !self.force_reconcile
            && self.last_acked_fingerprint.as_deref() == Some(&fingerprint)
        {
            return PublisherStep::Wait;
        }

        self.retry_at = None;
        self.force_reconcile = false;
        let request = PublishRequest {
            id: format!("task-snapshot-{}", self.next_id),
            snapshot,
        };
        self.next_id += 1;
        self.in_flight = Some(InFlight {
            request: request.clone(),
            attempt,
            sent_at: now,
        });
        PublisherStep::Publish(request)
    }

    pub(crate) fn on_ack(
        &mut self,
        id: &str,
        ok: bool,
        _error: Option<String>,
        now: Instant,
    ) -> Result<(), String> {
        let Some(in_flight) = self.in_flight.take() else {
            return Err(format!("unexpected task snapshot acknowledgement {id}"));
        };
        if in_flight.request.id != id {
            self.in_flight = Some(in_flight);
            return Err(format!("task snapshot acknowledgement id mismatch: {id}"));
        }
        if ok {
            self.last_acked_fingerprint = Some(in_flight.request.snapshot.fingerprint());
            return Ok(());
        }
        self.schedule_failure(in_flight.attempt, now);
        Ok(())
    }

    fn schedule_failure(&mut self, attempt: u8, now: Instant) {
        if attempt >= MAX_PUBLISH_ATTEMPTS {
            self.reconnect = true;
        } else {
            let delay = Duration::from_secs(1 << (attempt - 1));
            self.retry_at = Some((now + delay, attempt + 1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        map_ui_snapshot, map_ui_snapshot_for_publication, PublisherState, PublisherStep,
        RestingSnippetCache,
    };
    use kanna_agent_protocol::AgentProvider;

    fn test_agent_providers() -> Vec<AgentProvider> {
        vec![AgentProvider::Opencode]
    }
    use crate::db::{
        SnapshotBlockerTaskState, SnapshotEntry, SnapshotPipelineItem, SnapshotRepo,
        SnapshotTaskBlocker, UiSnapshot,
    };
    use std::collections::HashMap;
    use tokio::time::{Duration, Instant};

    fn ui_snapshot(activity: &str) -> UiSnapshot {
        UiSnapshot {
            entries: vec![SnapshotEntry {
                repo: SnapshotRepo {
                    id: "repo-1".into(),
                    path: "/tmp/repo".into(),
                    name: "Kanna".into(),
                    default_branch: Some("main".into()),
                    remote_url: Some("git@github.com:kanna/kanna.git".into()),
                    remote_url_hash: Some("remote-hash".into()),
                    hidden: 0,
                    sort_order: 0,
                    created_at: Some("2026-07-01 00:00:00".into()),
                    last_opened_at: None,
                },
                items: vec![SnapshotPipelineItem {
                    id: "task-1".into(),
                    cloud_task_id: "cloud-stable".into(),
                    transfer_id: None,
                    transfer_direction: None,
                    transfer_status: None,
                    transfer_source_peer_id: None,
                    transfer_target_peer_id: None,
                    transfer_source_desktop_id: None,
                    transfer_target_desktop_id: None,
                    transfer_error: None,
                    repo_id: "repo-1".into(),
                    issue_number: None,
                    issue_title: None,
                    prompt: Some("Implement publication\nwith detail".into()),
                    pipeline: "default".into(),
                    pipeline_def: None,
                    stage: "review".into(),
                    pr_number: Some(42),
                    pr_url: Some("https://github.com/kanna/kanna/pull/42".into()),
                    branch: Some("feat/cloud".into()),
                    closed_at: None,
                    agent_type: Some("pty".into()),
                    agent_provider: "codex".into(),
                    activity: activity.into(),
                    activity_revision: 7,
                    blocker_revision: 11,
                    transition_revision: Some("run-7".into()),
                    activity_changed_at: Some("2026-07-14 01:02:03".into()),
                    unread_at: None,
                    port_offset: None,
                    display_name: Some("Cloud publication".into()),
                    last_output_preview: Some("Ready for review".into()),
                    port_env: None,
                    agent_spawn_options: None,
                    pinned: 0,
                    pin_order: None,
                    base_ref: Some("origin/main".into()),
                    agent_session_id: None,
                    teardown_started_at: None,
                    parent_task_id: None,
                    notify_task_id: None,
                    notified_at: None,
                    created_at: Some("2026-07-14 00:00:00".into()),
                    updated_at: Some("2026-07-14 01:02:03".into()),
                    has_running_post: 0,
                    queued_input_count: 2,
                    queued_input_reason: Some("input_held_by_draft".into()),
                }],
            }],
            task_blockers: vec![SnapshotTaskBlocker {
                blocked_item_id: "task-1".into(),
                blocker_item_id: "task-blocker".into(),
            }],
            blocker_task_states: HashMap::new(),
            worktree_paths: HashMap::new(),
            settings: HashMap::new(),
        }
    }

    #[test]
    fn snapshot_mapping_preserves_mobile_cloud_schema_and_activity() {
        let snapshot = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("working"),
        );
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(json["schemaVersion"], 2);
        assert_eq!(json["desktop"]["displayName"], "Studio Mac");
        assert_eq!(
            json["desktop"]["agentProviders"],
            serde_json::json!(["opencode"])
        );
        assert_eq!(json["tasks"][0]["ownerDesktopId"], "desktop-1");
        assert_eq!(json["tasks"][0]["ownerLocalTaskId"], "task-1");
        assert_eq!(json["tasks"][0]["cloudTaskId"], "cloud-stable");
        assert_eq!(json["tasks"][0]["localRepoId"], "repo-1");
        assert_eq!(json["tasks"][0]["title"], "Cloud publication");
        assert_eq!(
            json["tasks"][0]["promptSnippet"],
            "Implement publication\nwith detail"
        );
        assert_eq!(json["tasks"][0]["activity"], "working");
        assert_eq!(json["tasks"][0]["activityRevision"], 7);
        assert_eq!(json["tasks"][0]["blockerRevision"], 11);
        assert_eq!(json["tasks"][0]["transitionRevision"], "run-7");
        assert_eq!(json["tasks"][0]["hasRunningPost"], false);
        assert_eq!(json["tasks"][0]["queuedInputCount"], 2);
        assert_eq!(json["tasks"][0]["queuedInputReason"], "input_held_by_draft");
        assert_eq!(json["tasks"][0]["waitingPromptSnippet"], "Ready for review");
        assert_eq!(json["tasks"][0]["status"], "blocked");
        assert_eq!(
            json["tasks"][0]["blockedByTaskIds"],
            serde_json::json!(["task-blocker"])
        );
        assert_eq!(
            json["tasks"][0]["repo"]["remoteUrl"],
            "git@github.com:kanna/kanna.git"
        );
        assert_eq!(json["tasks"][0]["repo"]["remoteUrlHash"], "remote-hash");
        assert_eq!(json["tasks"][0]["branch"], "feat/cloud");
        assert_eq!(json["tasks"][0]["baseRef"], "origin/main");
        assert_eq!(json["tasks"][0]["prNumber"], 42);
        assert_eq!(
            json["tasks"][0]["agent"],
            serde_json::json!({"provider":"codex","type":"pty"})
        );
        assert_eq!(json["tasks"][0]["parentTaskId"], serde_json::Value::Null);
        assert_eq!(json["tasks"][0]["pinned"], false);
        assert_eq!(json["tasks"][0]["pinOrder"], serde_json::Value::Null);
    }

    #[test]
    fn publisher_skips_continuous_output_writes_until_resting_boundary() {
        let mut cache = RestingSnippetCache::default();
        let mut publisher = PublisherState::new();
        publisher.on_authenticated(Some(2));
        let now = Instant::now();
        let first = map_ui_snapshot_for_publication(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("working"),
            &mut cache,
        );
        publisher.observe(first);
        let PublisherStep::Publish(first_request) = publisher.next_step(now) else {
            panic!("expected initial publication");
        };
        publisher
            .on_ack(&first_request.id, true, None, now)
            .unwrap();
        for index in 0..10 {
            let mut continuous = ui_snapshot("working");
            continuous.entries[0].items[0].last_output_preview =
                Some(format!("hot output {index}"));
            let continuous = map_ui_snapshot_for_publication(
                "desktop-1",
                "Studio Mac",
                test_agent_providers(),
                continuous,
                &mut cache,
            );
            publisher.observe(continuous);
            assert!(matches!(publisher.next_step(now), PublisherStep::Wait));
        }

        let mut idle = ui_snapshot("idle");
        idle.entries[0].items[0].last_output_preview = Some("finished output".into());
        let idle = map_ui_snapshot_for_publication(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            idle,
            &mut cache,
        );
        publisher.observe(idle.clone());
        assert!(matches!(
            publisher.next_step(now),
            PublisherStep::Publish(_)
        ));
        assert_eq!(
            serde_json::to_value(idle).unwrap()["tasks"][0]["waitingPromptSnippet"],
            "finished output"
        );
    }

    #[test]
    fn snapshot_mapping_publishes_cloud_transfer_identity_setting() {
        let mut source = ui_snapshot("idle");
        source.settings.insert(
            "cloud_transfer_identity_v1".into(),
            serde_json::json!({
                "peerId": "peer-a",
                "displayName": "Studio Mac",
                "publicKey": "base64-key",
                "protocolVersion": 1,
                "acceptingTransfers": true,
            })
            .to_string(),
        );

        let mapped = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(mapped).unwrap();

        assert_eq!(
            json["desktop"]["transfer"],
            serde_json::json!({
                "peerId": "peer-a",
                "publicKey": "base64-key",
                "protocolVersion": 1,
                "acceptingTransfers": true,
            }),
        );
    }

    #[test]
    fn snapshot_mapping_publishes_authenticated_transfer_states() {
        for (direction, status, expected_state) in [
            ("outgoing", "pending", "outgoing"),
            ("outgoing", "streaming", "outgoing"),
            ("incoming", "pending", "incoming"),
            ("incoming", "streaming", "incoming"),
            ("incoming", "importing", "incoming"),
            (
                "incoming",
                "awaiting_acknowledgment",
                "finalization_pending",
            ),
        ] {
            let mut source = ui_snapshot("idle");
            let item = &mut source.entries[0].items[0];
            item.transfer_id = Some("transfer-1".into());
            item.transfer_direction = Some(direction.into());
            item.transfer_status = Some(status.into());
            item.transfer_source_peer_id = Some("peer-a".into());
            item.transfer_target_peer_id = Some("peer-b".into());
            item.transfer_source_desktop_id = Some("desktop-a".into());
            item.transfer_target_desktop_id = Some("desktop-b".into());

            let snapshot =
                map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
            let json = serde_json::to_value(snapshot).unwrap();

            assert_eq!(json["tasks"][0]["transfer"]["state"], expected_state);
            assert_eq!(json["tasks"][0]["transfer"]["transferId"], "transfer-1");
            assert_eq!(json["tasks"][0]["transfer"]["sourceDesktopId"], "desktop-a");
            assert_eq!(
                json["tasks"][0]["transfer"]["destinationDesktopId"],
                "desktop-b"
            );
        }

        let mut completed = ui_snapshot("idle");
        let item = &mut completed.entries[0].items[0];
        item.transfer_id = Some("transfer-1".into());
        item.transfer_direction = Some("incoming".into());
        item.transfer_status = Some("completed".into());
        item.transfer_source_desktop_id = Some("desktop-a".into());
        item.transfer_target_desktop_id = Some("desktop-b".into());
        let snapshot =
            map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), completed);
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["tasks"][0]["transfer"]["state"], "none");
    }

    #[test]
    fn snapshot_mapping_suppresses_lan_only_transfer_state() {
        let mut source = ui_snapshot("idle");
        let item = &mut source.entries[0].items[0];
        item.transfer_id = Some("transfer-lan".into());
        item.transfer_direction = Some("outgoing".into());
        item.transfer_status = Some("pending".into());
        item.transfer_source_peer_id = Some("peer-a".into());
        item.transfer_target_peer_id = Some("peer-b".into());

        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(
            json["tasks"][0]["transfer"],
            serde_json::json!({
                "state": "none",
                "transferId": null,
                "sourceDesktopId": null,
                "destinationDesktopId": null,
            })
        );
    }

    #[test]
    fn snapshot_mapping_publishes_running_post_flag() {
        let mut source = ui_snapshot("working");
        source.entries[0].items[0].has_running_post = 1;

        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(json["tasks"][0]["hasRunningPost"], true);
    }

    #[test]
    fn snapshot_mapping_publishes_parent_task_id() {
        let mut source = ui_snapshot("idle");
        source.entries[0].items[0].parent_task_id = Some("task-parent".into());

        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(json["tasks"][0]["parentTaskId"], "task-parent");
    }

    #[test]
    fn snapshot_mapping_publishes_canonical_pin_state() {
        let mut source = ui_snapshot("idle");
        source.entries[0].items[0].pinned = 1;
        source.entries[0].items[0].pin_order = Some(3);

        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(json["tasks"][0]["pinned"], true);
        assert_eq!(json["tasks"][0]["pinOrder"], 3);
    }

    #[test]
    fn snapshot_mapping_omits_resolved_blockers() {
        let mut source = ui_snapshot("idle");
        source.blocker_task_states.insert(
            "task-blocker".into(),
            SnapshotBlockerTaskState {
                closed_at: Some("2026-07-19 22:49:04".into()),
                stage: Some("pr".into()),
                pr_url: Some("https://github.com/kanna/kanna/pull/41".into()),
            },
        );

        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), source);
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(json["tasks"][0]["status"], "active");
        assert_eq!(json["tasks"][0]["blockedByTaskIds"], serde_json::json!([]));
    }

    #[test]
    fn snapshot_mapping_bounds_prompt_before_a_canonical_end_sentinel() {
        let full_prompt = format!("{}PROMPT_END_SENTINEL", "p".repeat(520));
        let mut snapshot = ui_snapshot("working");
        snapshot.entries[0].items[0].prompt = Some(full_prompt);

        let mapped = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), snapshot);
        let json = serde_json::to_value(mapped).unwrap();
        let prompt_snippet = json["tasks"][0]["promptSnippet"].as_str().unwrap();

        assert_eq!(prompt_snippet.chars().count(), 500);
        assert!(!prompt_snippet.contains("PROMPT_END_SENTINEL"));
    }

    #[test]
    fn activity_only_change_changes_snapshot_fingerprint() {
        let idle = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        );
        let working = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("working"),
        );
        assert_ne!(idle.fingerprint(), working.fingerprint());
    }

    #[test]
    fn waiting_prompt_only_change_changes_snapshot_fingerprint() {
        let mut first = ui_snapshot("idle");
        first.entries[0].items[0].last_output_preview = Some("First answer".into());
        let mut second = ui_snapshot("idle");
        second.entries[0].items[0].last_output_preview = Some("Second answer".into());

        let first = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), first);
        let second = map_ui_snapshot("desktop-1", "Studio Mac", test_agent_providers(), second);

        assert_ne!(first.fingerprint(), second.fingerprint());
    }

    #[test]
    fn snapshot_mapping_bounds_user_controlled_strings_for_the_relay_contract() {
        let mut source = ui_snapshot("working");
        source.entries[0].repo.name = "r".repeat(300);
        source.entries[0].items[0].display_name = Some("t".repeat(600));
        source.entries[0].items[0].stage = "s".repeat(100);
        let snapshot = map_ui_snapshot(
            "desktop-1",
            &"d".repeat(300),
            test_agent_providers(),
            source,
        );
        let json = serde_json::to_value(snapshot).unwrap();

        assert_eq!(
            json["desktop"]["displayName"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            256
        );
        assert_eq!(
            json["tasks"][0]["title"].as_str().unwrap().chars().count(),
            512
        );
        assert_eq!(
            json["tasks"][0]["displayName"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            512
        );
        assert_eq!(
            json["tasks"][0]["stage"].as_str().unwrap().chars().count(),
            64
        );
        assert_eq!(
            json["tasks"][0]["repo"]["name"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            256
        );
    }

    #[test]
    fn publisher_coalesces_to_latest_snapshot_with_one_in_flight() {
        let now = Instant::now();
        let idle = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        );
        let working = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("working"),
        );
        let mut state = PublisherState::new();
        state.on_authenticated(Some(2));
        state.observe(idle);

        let PublisherStep::Publish(first) = state.next_step(now) else {
            panic!("expected publish")
        };
        state.observe(working.clone());
        assert!(matches!(state.next_step(now), PublisherStep::Wait));
        state.on_ack(&first.id, true, None, now).unwrap();
        let PublisherStep::Publish(second) = state.next_step(now) else {
            panic!("expected coalesced publish")
        };
        assert_eq!(second.snapshot.fingerprint(), working.fingerprint());
    }

    #[test]
    fn publisher_downconverts_transfer_state_for_v1_or_unknown_relays() {
        let now = Instant::now();

        for advertised_version in [None, Some(1), Some(99)] {
            let mut source = ui_snapshot("idle");
            let item = &mut source.entries[0].items[0];
            item.transfer_id = Some("transfer-1".into());
            item.transfer_direction = Some("outgoing".into());
            item.transfer_status = Some("streaming".into());
            item.transfer_source_desktop_id = Some("desktop-a".into());
            item.transfer_target_desktop_id = Some("desktop-b".into());
            let mut state = PublisherState::new();
            state.on_authenticated(advertised_version);
            state.observe(map_ui_snapshot(
                "desktop-1",
                "Studio Mac",
                test_agent_providers(),
                source,
            ));
            let PublisherStep::Publish(request) = state.next_step(now) else {
                panic!("expected compatibility publication");
            };
            let json = serde_json::to_value(request.snapshot).unwrap();
            assert_eq!(json["schemaVersion"], 1);
            assert_eq!(json["tasks"][0]["transfer"]["state"], "none");
        }
    }

    #[test]
    fn snapshot_publishes_an_empty_inventory_as_an_empty_list() {
        let snapshot = map_ui_snapshot("desktop-1", "Studio Mac", Vec::new(), ui_snapshot("idle"));
        let json = serde_json::to_value(snapshot).unwrap();

        // A machine with no agent CLI must be distinguishable from a desktop
        // too old to report one: mobile blocks creation on the first and falls
        // back to offering everything on the second.
        assert_eq!(json["desktop"]["agentProviders"], serde_json::json!([]));
    }

    #[test]
    fn publisher_retries_with_backoff_then_requests_reconnect() {
        let now = Instant::now();
        let mut state = PublisherState::new();
        state.on_authenticated(Some(2));
        state.observe(map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        ));

        for attempt in 1..=3 {
            let PublisherStep::Publish(request) =
                state.next_step(now + Duration::from_secs(attempt * 10))
            else {
                panic!("expected publish attempt {attempt}");
            };
            state
                .on_ack(&request.id, false, Some("write failed".into()), now)
                .unwrap();
        }
        assert!(matches!(
            state.next_step(now + Duration::from_secs(60)),
            PublisherStep::Reconnect
        ));
    }

    #[test]
    fn authenticated_reconnect_forces_reconciliation_of_unchanged_snapshot() {
        let now = Instant::now();
        let snapshot = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        );
        let mut state = PublisherState::new();
        state.on_authenticated(Some(2));
        state.observe(snapshot.clone());
        let PublisherStep::Publish(first) = state.next_step(now) else {
            panic!("expected first")
        };
        state.on_ack(&first.id, true, None, now).unwrap();
        assert!(matches!(state.next_step(now), PublisherStep::Wait));

        state.on_disconnected();
        state.on_authenticated(Some(2));
        state.observe(snapshot);
        assert!(matches!(state.next_step(now), PublisherStep::Publish(_)));
    }

    #[test]
    fn publisher_times_out_an_unacknowledged_request_and_retries() {
        let now = Instant::now();
        let mut state = PublisherState::new();
        state.on_authenticated(Some(2));
        state.observe(map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        ));
        assert!(matches!(state.next_step(now), PublisherStep::Publish(_)));
        assert!(matches!(
            state.next_step(now + Duration::from_secs(16)),
            PublisherStep::Wait
        ));
        assert!(matches!(
            state.next_step(now + Duration::from_secs(18)),
            PublisherStep::Publish(_)
        ));
    }

    #[test]
    fn publisher_reconciles_latest_snapshot_after_timeout_and_disconnect() {
        let now = Instant::now();
        let idle = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("idle"),
        );
        let working = map_ui_snapshot(
            "desktop-1",
            "Studio Mac",
            test_agent_providers(),
            ui_snapshot("working"),
        );
        let mut state = PublisherState::new();
        state.on_authenticated(Some(2));
        state.observe(idle);

        let PublisherStep::Publish(abandoned) = state.next_step(now) else {
            panic!("expected abandoned publication")
        };
        state.observe(working.clone());
        assert!(matches!(
            state.next_step(now + Duration::from_secs(16)),
            PublisherStep::Wait
        ));

        state.on_disconnected();
        state.on_authenticated(Some(2));
        let PublisherStep::Publish(reconnected) = state.next_step(now + Duration::from_secs(16))
        else {
            panic!("expected reconnect reconciliation")
        };
        assert_ne!(reconnected.id, abandoned.id);
        assert_eq!(reconnected.snapshot.fingerprint(), working.fingerprint(),);
    }
}
