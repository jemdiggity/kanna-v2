use crate::config::Config;
use crate::db::{Db, NewRepo, NewStageRun};
use kanna_agent_protocol::AgentProvider;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDescriptor {
    pub id: String,
    pub name: String,
    pub connection_mode: String,
    /// Agent provider CLIs installed on this machine, in registry order.
    ///
    /// Advisory, and absent on builds older than this field — a client that
    /// sees no inventory must fall back to offering everything Kanna supports
    /// rather than refusing to create tasks. An empty list is a *reported*
    /// empty machine, which is not the same as an unknown one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_providers: Option<Vec<AgentProvider>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
    /// Cross-machine repo identity: hash of the git remote URL. Lets mobile
    /// clients recognize the same repository registered on several desktops.
    pub remote_url_hash: Option<String>,
    /// Credential-free clone source retained by the authenticated mobile client
    /// so it can ask a different paired desktop to check out the same logical
    /// repository. Credential-bearing HTTP(S) origins are never serialized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetail {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileServerStatus {
    pub state: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub version: String,
    pub environment: String,
    /// Deprecated compatibility alias for `version`.
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ksp_stream_version: Option<u8>,
    /// Version of the task-input image-attachment contract this build serves,
    /// or absent on a build that predates it.
    ///
    /// A phone and the desktop it talks to are separate binaries on separate
    /// release cadences, and on the day attachments ship the normal state is a
    /// new phone paired with a desktop that has not been updated yet. That
    /// desktop deserializes the input body, ignores the unknown `attachment`
    /// field, delivers the text alone, and answers 204 — so without this marker
    /// the phone would clear its composer and the agent would answer about a
    /// picture it never received. Absence is the signal; the client hides the
    /// attach control rather than sending into that silence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_input_attachment_version: Option<u8>,
    /// Agent-facing tool names this build serves, read from the bundled
    /// `kanna-tool-catalog` it was compiled against.
    ///
    /// A client's catalog and the server it talks to are separate binaries with
    /// separate lifecycles — a released app can be hundreds of commits behind a
    /// client built from the working tree — so a client cannot assume a tool it
    /// advertises is actually routable. Diffing this list against its own
    /// catalog turns that skew into something an agent can read up front
    /// instead of discovering through a 404, which is indistinguishable from an
    /// ordinary "not found". Absent on builds older than this field, which is
    /// itself the signal that the server predates capability advertisement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_api_tools: Option<Vec<String>>,
    /// Agent provider CLIs installed on this machine, in registry order.
    /// Carried here as well as on [`DesktopDescriptor`] because a paired LAN
    /// client learns a desktop through its `/v1/status` discovery probe and
    /// never reads `/v1/desktops`. Absent on older builds; see
    /// [`DesktopDescriptor::agent_providers`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_providers: Option<Vec<AgentProvider>>,
    pub write_path_health: crate::workspace_commands::WritePathHealth,
}

pub struct MobileApi {
    config: Config,
    _db: Db,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub repo_id: String,
    pub repo_name: Option<String>,
    pub title: String,
    /// Bounded creation prompt for list presentation. Fetch task detail for
    /// the complete prompt.
    pub prompt: Option<String>,
    pub stage: Option<String>,
    pub closed_at: Option<String>,
    #[serde(default)]
    pub machine_id: Option<String>,
    pub created_at: Option<String>,
    /// Derived display value blending both dimensions below: `working` |
    /// `idle` | `unread`. Kept for every existing consumer; read
    /// `runtimeState`/`readState` when you need one dimension on its own.
    pub activity: Option<String>,
    /// Runtime dimension — the daemon's verdict on the agent session:
    /// `busy` | `waiting` | `idle` | `exited`, or absent when no session has
    /// reported one yet.
    pub runtime_state: Option<String>,
    /// Read dimension — `read` | `unread`. Optional only so a payload from a
    /// peer that predates the split still deserializes; this server always
    /// reports it.
    pub read_state: Option<String>,
    pub activity_revision: i64,
    /// Deprecated input-only alias retained so mixed-version machine
    /// aggregation can deserialize peers that still send `snippet`.
    #[serde(default, skip_serializing)]
    pub snippet: Option<String>,
    pub waiting_prompt_snippet: Option<String>,
    /// Name of the agent definition used by the latest durable stage run.
    #[serde(default)]
    pub agent: Option<String>,
    /// Session transport (`pty` or `agent`), not the agent definition name.
    pub agent_type: Option<String>,
    pub parent_task_id: Option<String>,
    pub pinned: bool,
    pub pin_order: Option<i64>,
    #[serde(default)]
    pub blocked_by_task_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub repo_id: String,
    pub title: String,
    pub prompt: Option<String>,
    pub stage: Option<String>,
    pub workflow_name: Option<String>,
    #[serde(rename = "pipelineName")]
    pub legacy_pipeline_name: Option<String>,
    pub stage_transition: Option<String>,
    /// Derived display value blending both dimensions below: `working` |
    /// `idle` | `unread`. Kept for every existing consumer; read
    /// `runtimeState`/`readState` when you need one dimension on its own.
    pub activity: Option<String>,
    /// Runtime dimension — the daemon's verdict on the agent session:
    /// `busy` | `waiting` | `idle` | `exited`, or absent when no session has
    /// reported one yet. This is the field that answers "is the agent
    /// working?"; `activity` cannot, because a busy agent whose last output
    /// nobody read and a finished one look alike through it.
    pub runtime_state: Option<String>,
    /// Read dimension — `read` | `unread`. Whether a human has seen the
    /// latest output; says nothing about whether the agent is running.
    /// Optional only so a payload from a peer that predates the split still
    /// deserializes; this server always reports it.
    pub read_state: Option<String>,
    /// Why messages delivered into this task's agent session are being
    /// refused, or absent when they are not. `inherited-draft-unknown` means
    /// the daemon adopted the session across a restart or handoff and its
    /// composer holds text nobody here saw typed, so submitting would append
    /// to an unsent line; the session is otherwise healthy and idle, which is
    /// why neither `activity` nor `runtimeState` shows anything wrong. A
    /// sender that sees this should stop retrying and say so: an empty
    /// composer clears itself, and anything else needs a human at that
    /// terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_blocked: Option<String>,
    /// Deprecated input-only alias retained for mixed-version clients.
    #[serde(default, skip_serializing)]
    pub snippet: Option<String>,
    pub waiting_prompt_snippet: Option<String>,
    /// The task's agent-session composer, as its own labelled field.
    ///
    /// `waitingPromptSnippet` and `snippet` are what the session *said*; this
    /// is what somebody is about to say into it — or, on a Claude session,
    /// what the CLI is *suggesting* they say. The two were the same field
    /// once, and the suggestion "run it on my phone so i can see it" was read
    /// as an owner directive and stalled a task for a day. Read `attestation`
    /// before treating `text` as anything: only `typed` is a human draft.
    /// Absent when no session has reported a composer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer: Option<TaskComposer>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    /// Resolved model for the latest stage run. Before the first run starts,
    /// this falls back to the resolved initial spawn option.
    pub model: Option<String>,
    /// Resolved provider-native effort for the latest stage run. Before the
    /// first run starts, this falls back to the resolved initial spawn option.
    pub effort: Option<String>,
    pub branch: Option<String>,
    pub pr_url: Option<String>,
    pub closed_at: Option<String>,
    pub worktree_path: Option<String>,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    pub dirty: bool,
    /// The task's most recent stage run, when one exists. Fan-out
    /// orchestrators (e.g. the QA dispatcher) read a finished child's
    /// verdict from here after `kanna_wait_task` resolves.
    pub latest_run: Option<TaskLatestRun>,
    /// Agent-requested revision rounds already spent on this task (reset by a
    /// human-requested revision). A review agent reads this with
    /// `revision_limit` to know how much rope the loop has left.
    pub revision_rounds: i64,
    /// Rounds the task's workflow allows before the engine parks the task for
    /// its human instead of revising again; `0` means unlimited.
    pub revision_limit: i64,
    /// How many messages have been delivered into this task's agent session
    /// from outside it — operator/manager `POST /v1/tasks/{id}/input` calls.
    /// Historical counts may include retired completion notifications. The
    /// count is here so that a consumer reading only task detail cannot
    /// conclude nothing was ever sent: a non-zero value means there is an
    /// instruction history, and
    /// `GET /v1/tasks/{id}/inputs` has its text. Optional only so a payload
    /// from a peer that predates the record still deserializes.
    #[serde(default)]
    pub delivered_input_count: i64,
    pub parent_task_id: Option<String>,
    /// Direct children of this task, oldest first — the downward view of
    /// `parent_task_id`. **Closed children are included**: parentage is
    /// durable, and a fan-out orchestrator that lost its id list (compaction,
    /// session resume) reconciles finished children from here, so omitting
    /// them would make an empty list mean two different things.
    #[serde(default)]
    pub child_task_ids: Vec<String>,
    #[serde(default)]
    pub blocked_by_task_ids: Vec<String>,
}

/// What a task's agent session has at its prompt, and what the daemon can
/// prove about it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskComposer {
    /// The text rendered on the composer line, or absent when the session
    /// draws no readable composer. Never session output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `typed` — keystrokes reached this composer since its last submission
    /// boundary, so `text` may be a human's unsent line. `not-typed` — an
    /// attested session with none, so `text` is provably the CLI's own
    /// chrome or suggestion and nobody wrote it. `unknown` — the session was
    /// inherited from before attestation and nothing can be proven.
    pub attestation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskLatestRun {
    pub id: String,
    pub stage: String,
    pub kind: String,
    #[serde(default)]
    pub agent: Option<String>,
    pub status: String,
    pub summary: Option<String>,
    pub resumed_from_run_id: Option<String>,
    pub resume_fallback_reason: Option<String>,
    pub finished_at: Option<String>,
}

/// A task's durable instruction history: every message delivered into its
/// agent session from outside that session.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskInputs {
    pub task_id: String,
    /// Every input the task has ever received, not just the returned window.
    pub total: i64,
    /// The most recent `tail` records, oldest first.
    pub inputs: Vec<crate::db::TaskInputRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskChild {
    pub id: String,
    pub agent: Option<String>,
    pub workflow_name: Option<String>,
    #[serde(rename = "pipelineName")]
    pub legacy_pipeline_name: Option<String>,
    pub created_at: Option<String>,
    pub closed_at: Option<String>,
    pub latest_run: Option<TaskLatestRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddRepoRequest {
    pub path: String,
    pub name: Option<String>,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTemplateLaunch {
    pub id: String,
    pub teardown: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRecoverySnapshot {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub saved_at: u64,
    pub sequence: u64,
}

impl CreateTaskRecoverySnapshot {
    pub fn validate(&self) -> Result<(), String> {
        const MAX_COLS: u16 = 320;
        const MAX_ROWS: u16 = 256;
        const MAX_SERIALIZED_BYTES: usize = 64 * 1024 * 1024;

        if self.serialized.len() > MAX_SERIALIZED_BYTES {
            return Err(format!(
                "recoverySnapshot.serialized exceeds {MAX_SERIALIZED_BYTES} bytes"
            ));
        }
        if self.cols == 0 || self.cols > MAX_COLS || self.rows == 0 || self.rows > MAX_ROWS {
            return Err(format!(
                "recoverySnapshot dimensions must be within 1..={MAX_COLS} columns and 1..={MAX_ROWS} rows"
            ));
        }
        if self.cursor_row >= self.rows || self.cursor_col >= self.cols {
            return Err(
                "recoverySnapshot cursor must be inside its terminal dimensions".to_string(),
            );
        }
        Ok(())
    }
}

/// Display-only provenance for a task imported by a cross-machine transfer.
/// The destination terminal prints it once, before the agent starts, so the
/// import is visible instead of a task that simply appeared.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferImportSummary {
    #[serde(default)]
    pub source_machine: Option<String>,
    /// Raw acquisition mode from the transfer payload: `reuse-local`,
    /// `clone-remote`, or `bundle-repo`. Unknown values are printed verbatim
    /// rather than dropped, so a newer sender still shows something true.
    #[serde(default)]
    pub repo_mode: Option<String>,
    #[serde(default)]
    pub session_restored: bool,
}

impl TransferImportSummary {
    const MAX_FIELD_CHARS: usize = 200;

    pub fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("sourceMachine", self.source_machine.as_deref()),
            ("repoMode", self.repo_mode.as_deref()),
        ] {
            if value.is_some_and(|value| value.chars().count() > Self::MAX_FIELD_CHARS) {
                return Err(format!(
                    "transferImport.{label} exceeds {} characters",
                    Self::MAX_FIELD_CHARS
                ));
            }
            if value.is_some_and(|value| value.chars().any(char::is_control)) {
                return Err(format!(
                    "transferImport.{label} must not contain control characters"
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub repo_id: String,
    pub prompt: String,
    #[serde(alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(alias = "pipelineName")]
    pub workflow_name: Option<String>,
    pub stage: Option<String>,
    pub base_ref: Option<String>,
    pub agent: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_type: Option<String>,
    pub terminal_cols: Option<u16>,
    pub terminal_rows: Option<u16>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub disallowed_tools: Option<Vec<String>>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub setup_cmds: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_template: Option<TaskTemplateLaunch>,
    pub resume_session_id: Option<String>,
    pub recovery_snapshot: Option<CreateTaskRecoverySnapshot>,
    /// Absent for every locally created task; set only by the receiver side of
    /// a cross-machine transfer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_import: Option<TransferImportSummary>,
    pub blocker_task_ids: Option<Vec<String>>,
    /// Retired compatibility input. The HTTP boundary rejects a non-null
    /// value and task creation never persists it.
    pub notify_task_id: Option<String>,
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskResponse {
    pub task_id: String,
    pub repo_id: String,
    pub title: String,
    pub prompt: String,
    pub stage: String,
    pub agent_type: String,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteStageRequest {
    /// Exact run whose verdict is being recorded. Completion is never applied
    /// to whichever run happens to be latest after a rerun/revision race.
    #[serde(default)]
    pub run_id: Option<String>,
    /// Adapter-generated stable key for an exact verdict retry. It is not a
    /// catalog argument; old clients omit it and old servers ignore it.
    #[serde(default)]
    pub completion_attempt_key: Option<String>,
    pub status: String,
    pub summary: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeHandoffRequest {
    pub branch: String,
    pub target: String,
    pub pr_url: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestRevisionRequest {
    pub target_stage: String,
    pub summary: String,
    pub prompt: String,
    pub metadata: Option<serde_json::Value>,
    /// Who asked for this revision. Agent-requested revisions spend the
    /// task's revision-round budget and are refused once it is gone; a
    /// human-requested revision is never refused and hands the budget back.
    /// Deliberately absent from the agent tool catalog: an agent must not be
    /// able to claim human origin.
    #[serde(default)]
    pub origin: Option<RevisionOrigin>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionOrigin {
    #[default]
    Agent,
    Human,
}

impl RevisionOrigin {
    pub fn is_agent(self) -> bool {
        matches!(self, Self::Agent)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockTaskRequest {
    pub blocker_task_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskParentRequest {
    #[serde(default)]
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskWorkflowRequest {
    #[serde(alias = "pipelineName")]
    pub workflow_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskWorkflowResponse {
    pub task_id: String,
    pub workflow_name: String,
    #[serde(rename = "pipelineName")]
    pub legacy_pipeline_name: String,
    pub stage: String,
    pub revision_rounds: i64,
    pub revision_limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskActionResponse {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_task: Option<bool>,
    /// Set by `request-revision`: where the task stands against its
    /// revision-round budget, and whether a revision was actually started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_budget: Option<RevisionBudgetStatus>,
}

/// The revision-round budget as it stands after a revision request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionBudgetStatus {
    /// Agent-requested rounds spent, including the one just started.
    pub rounds: i64,
    /// Rounds the task's workflow allows; `0` means unlimited.
    pub limit: i64,
    /// True when the budget is spent and no revision was started: the task is
    /// parked at its current stage for its human.
    pub exhausted: bool,
    pub message: String,
}

impl MobileApi {
    pub fn new(config: Config, db: Db) -> Self {
        Self { config, _db: db }
    }

    pub fn list_desktops(&self) -> Result<Vec<DesktopDescriptor>, String> {
        Ok(vec![DesktopDescriptor {
            id: self.config.desktop_id.clone(),
            name: self.config.desktop_name.clone(),
            connection_mode: "both".to_string(),
            agent_providers: Some(crate::agent_inventory::installed_agent_providers()),
        }])
    }

    pub fn list_repos(&self) -> Result<Vec<RepoSummary>, String> {
        let remote_urls = self
            ._db
            .list_repo_remote_urls()
            .map_err(|e| format!("db error: {e}"))?;
        self._db
            .list_repos()
            .map(|repos| {
                repos
                    .into_iter()
                    .map(|repo| {
                        let remote_url = remote_urls
                            .get(&repo.id)
                            .filter(|url| {
                                crate::transfer_engine::git::is_credential_free_clone_source(url)
                            })
                            .cloned();
                        map_repo_summary(repo, remote_url)
                    })
                    .collect()
            })
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn add_repo(&self, request: AddRepoRequest) -> Result<RepoDetail, AddRepoError> {
        let canonical_path = validate_git_repo_path(&request.path)?;
        let path_string = canonical_path.to_string_lossy().to_string();
        if self
            ._db
            .repo_path_exists(&path_string)
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?
        {
            return Err(AddRepoError::DuplicatePath);
        }
        let name = request
            .name
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                canonical_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
            })
            .ok_or_else(|| {
                AddRepoError::InvalidPath("repo name could not be derived".to_string())
            })?;
        let default_branch = request
            .default_branch
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                git_default_branch(&canonical_path)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| "main".to_string());
        let id = generate_repo_id()?;
        self._db
            .insert_repo(NewRepo {
                id: &id,
                path: &path_string,
                name: &name,
                default_branch: Some(&default_branch),
            })
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?;
        let repo = self
            ._db
            .get_repo(&id)
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?
            .ok_or_else(|| AddRepoError::Internal("created repo was not found".to_string()))?;
        Ok(map_repo_detail(repo))
    }

    pub fn list_repo_tasks(&self, repo_id: &str) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        let repo_names = self.repo_names_by_id()?;
        let items = self
            ._db
            .list_pipeline_items(repo_id)
            .map_err(|e| format!("db error: {}", e))?;
        self.map_task_summaries(items, &repo_names)
    }

    pub fn list_recent_tasks(&self) -> Result<Vec<TaskSummary>, String> {
        self.list_recent_tasks_including_closed(false, None, 50)
    }

    pub fn list_recent_tasks_including_closed(
        &self,
        include_closed: bool,
        repo_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        let repo_names = self.repo_names_by_id()?;
        let items = self
            ._db
            .list_recent_pipeline_items_including_closed(include_closed, repo_id, limit)
            .map_err(|e| format!("db error: {}", e))?;
        self.map_task_summaries(items, &repo_names)
    }

    pub fn search_tasks(&self, query: &str) -> Result<Vec<TaskSummary>, String> {
        self.search_tasks_including_closed(query, false, None)
    }

    pub fn search_tasks_including_closed(
        &self,
        query: &str,
        include_closed: bool,
        repo_id: Option<&str>,
    ) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        let repo_names = self.repo_names_by_id()?;
        let items = self
            ._db
            .search_pipeline_items_including_closed(query, include_closed, repo_id)
            .map_err(|e| format!("db error: {}", e))?;
        self.map_task_summaries(items, &repo_names)
    }

    fn map_task_summaries(
        &self,
        items: Vec<crate::db::PipelineItem>,
        repo_names: &HashMap<String, String>,
    ) -> Result<Vec<TaskSummary>, String> {
        items
            .into_iter()
            .map(|item| {
                let blocked_by_task_ids = self
                    ._db
                    .list_open_task_blocker_ids(&item.id)
                    .map_err(|e| format!("db error: {}", e))?;
                let repo_name = repo_names.get(&item.repo_id).cloned();
                let agent = self
                    ._db
                    .latest_stage_run(&item.id)
                    .map_err(|e| format!("db error: {}", e))?
                    .and_then(|run| run.agent);
                Ok(map_task_summary(
                    item,
                    repo_name,
                    blocked_by_task_ids,
                    &self.config.desktop_id,
                    agent,
                ))
            })
            .collect()
    }

    fn repo_names_by_id(&self) -> Result<HashMap<String, String>, String> {
        self._db
            .list_repos_for_maintenance()
            .map(|repos| repos.into_iter().map(|repo| (repo.id, repo.name)).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn get_task(&self, task_or_branch_id: &str) -> Result<Option<TaskDetail>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        let task_id = self
            ._db
            .resolve_pipeline_item_id(task_or_branch_id)
            .map_err(|e| format!("db error: {}", e))?;
        let Some(task_id) = task_id else {
            return Ok(None);
        };
        let Some(item) = self
            ._db
            .get_pipeline_item(&task_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(None);
        };
        let repo = self
            ._db
            .get_repo(&item.repo_id)
            .map_err(|e| format!("db error: {}", e))?;
        let worktree_path = self
            ._db
            .get_task_worktree_path(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        let latest_run = self
            ._db
            .latest_stage_run(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        let initial_spawn_options = self
            ._db
            .get_pipeline_item_agent_spawn_options(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        let resolved_model = match latest_run.as_ref() {
            Some(run) => run.model.clone(),
            None => model_from_spawn_options(initial_spawn_options.as_deref()),
        };
        let resolved_effort = match latest_run.as_ref() {
            Some(run) => run.effort.clone(),
            None => spawn_option_from_json(initial_spawn_options.as_deref(), "effort"),
        };
        let blocked_by_task_ids = self
            ._db
            .list_open_task_blocker_ids(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        let child_task_ids = self
            ._db
            .list_child_task_ids(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        let delivered_input_count = self
            ._db
            .count_task_inputs(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        Ok(Some(map_task_detail(
            item,
            repo.as_ref(),
            TaskDetailRelations {
                worktree_path,
                latest_run,
                resolved_model,
                resolved_effort,
                child_task_ids,
                blocked_by_task_ids,
                delivered_input_count,
            },
        )))
    }

    /// The task's delivered-input history, oldest first, with `total` naming
    /// the full count so a tailed list never reads as the whole record.
    ///
    /// `Ok(None)` means the task does not exist; an existing task that has
    /// received nothing is an empty list.
    pub fn list_task_inputs(
        &self,
        task_or_branch_id: &str,
        tail: i64,
    ) -> Result<Option<TaskInputs>, String> {
        let Some(task_id) = self
            ._db
            .resolve_pipeline_item_id(task_or_branch_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(None);
        };
        let total = self
            ._db
            .count_task_inputs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        let inputs = self
            ._db
            .list_task_inputs(&task_id, tail)
            .map_err(|e| format!("db error: {}", e))?;
        Ok(Some(TaskInputs {
            task_id,
            total,
            inputs,
        }))
    }

    /// The parent's direct children, oldest first, with each child's latest
    /// recorded stage run. `Ok(None)` means the parent itself does not exist;
    /// an existing parent with no children is an empty list, which is what
    /// lets a fan-out owner tell "nothing was dispatched" from "wrong id".
    pub fn list_task_children(
        &self,
        task_or_branch_id: &str,
    ) -> Result<Option<Vec<TaskChild>>, String> {
        let Some(task_id) = self
            ._db
            .resolve_pipeline_item_id(task_or_branch_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(None);
        };
        let children = self
            ._db
            .list_pipeline_item_children(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        children
            .into_iter()
            .map(|child| {
                let latest_run = self
                    ._db
                    .latest_stage_run(&child.id)
                    .map_err(|e| format!("db error: {}", e))?;
                let agent = latest_run.as_ref().and_then(|run| run.agent.clone());
                Ok(TaskChild {
                    id: child.id,
                    agent,
                    workflow_name: child.pipeline.clone(),
                    legacy_pipeline_name: child.pipeline,
                    created_at: child.created_at,
                    closed_at: child.closed_at,
                    latest_run: latest_run.map(map_task_latest_run),
                })
            })
            .collect::<Result<Vec<_>, String>>()
            .map(Some)
    }
}

pub fn record_orphaned_initialized_tasks(db: &Db) -> Result<bool, String> {
    let worktree_paths = db
        .list_open_task_worktree_paths()
        .map_err(|e| format!("db error: {}", e))?;
    let mut recorded_any = false;
    for (task_id, worktree_path) in worktree_paths {
        if Path::new(&worktree_path).exists() {
            continue;
        }
        let result = format!(
            "task workspace missing: {worktree_path}. Use rerun-stage to recreate the workspace and restart the current stage."
        );
        let already_recorded = db
            .latest_stage_run(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        if already_recorded
            .as_ref()
            .and_then(|run| run.result.as_deref())
            .is_some_and(|existing| existing == result)
        {
            continue;
        }
        log::warn!("recording orphaned task {task_id}: worktree missing at {worktree_path}");
        db.cancel_running_stage_runs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        db.update_pipeline_item_activity(&task_id, "unread")
            .map_err(|e| format!("db error: {}", e))?;
        let run_id = durable_failure_run_id(&task_id);
        db.insert_stage_run(NewStageRun {
            id: &run_id,
            task_id: &task_id,
            stage: already_recorded
                .as_ref()
                .map(|run| run.stage.as_str())
                .unwrap_or("in progress"),
            kind: "main",
            agent: already_recorded
                .as_ref()
                .and_then(|run| run.agent.as_deref()),
            agent_provider: already_recorded
                .as_ref()
                .and_then(|run| run.agent_provider.as_deref()),
            model: already_recorded
                .as_ref()
                .and_then(|run| run.model.as_deref()),
            effort: already_recorded
                .as_ref()
                .and_then(|run| run.effort.as_deref()),
            status: "failed",
            result: Some(&result),
            feedback: Some("worktree missing"),
            session_id: Some(&task_id),
            provider_session_id: None,
            cwd: Some(&worktree_path),
            resumed_from_run_id: None,
        })
        .map_err(|e| format!("db error: {}", e))?;
        recorded_any = true;
    }
    Ok(recorded_any)
}

fn durable_failure_run_id(task_id: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddRepoError {
    InvalidPath(String),
    DuplicatePath,
    Internal(String),
}

impl AddRepoError {
    pub fn message(&self) -> String {
        match self {
            AddRepoError::InvalidPath(message) => message.clone(),
            AddRepoError::DuplicatePath => "repo path is already registered".to_string(),
            AddRepoError::Internal(message) => message.clone(),
        }
    }
}

/// The read dimension of a task, derived from the `activity` display value:
/// `unread` while the latest output is unread, `read` otherwise.
///
/// It is a projection rather than its own column because that is exactly what
/// the operator dimension has always been — `activity == "unread"`. Naming it
/// separately is what lets a consumer say which dimension it is reading.
fn read_state_for_activity(activity: Option<&str>) -> &'static str {
    match activity {
        Some("unread") => "unread",
        _ => "read",
    }
}

fn map_task_summary(
    item: crate::db::PipelineItem,
    repo_name: Option<String>,
    blocked_by_task_ids: Vec<String>,
    machine_id: &str,
    agent: Option<String>,
) -> TaskSummary {
    let full_prompt = item.prompt.clone();
    let prompt = full_prompt.as_deref().map(bound_task_listing_prompt);
    let title = item
        .display_name
        .clone()
        .or(prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    let waiting_prompt_snippet = item.last_output_preview.clone();
    TaskSummary {
        id: item.id,
        repo_id: item.repo_id,
        repo_name,
        title,
        prompt,
        stage: item.stage,
        closed_at: item.closed_at,
        machine_id: Some(machine_id.to_string()),
        created_at: item.created_at,
        runtime_state: item.runtime_status,
        read_state: Some(read_state_for_activity(item.activity.as_deref()).to_string()),
        activity: item.activity,
        activity_revision: item.activity_revision,
        snippet: None,
        waiting_prompt_snippet,
        agent,
        agent_type: item.agent_type,
        parent_task_id: item.parent_task_id,
        pinned: item.pinned.unwrap_or(0) != 0,
        pin_order: item.pin_order,
        blocked_by_task_ids,
    }
}

/// The rows a task detail needs that the `pipeline_item` row cannot supply on
/// its own — each one a separate query the caller has already run.
struct TaskDetailRelations {
    worktree_path: Option<String>,
    latest_run: Option<crate::db::StageRun>,
    resolved_model: Option<String>,
    resolved_effort: Option<String>,
    child_task_ids: Vec<String>,
    blocked_by_task_ids: Vec<String>,
    delivered_input_count: i64,
}

fn map_task_detail(
    item: crate::db::PipelineItem,
    repo: Option<&crate::db::Repo>,
    relations: TaskDetailRelations,
) -> TaskDetail {
    let TaskDetailRelations {
        worktree_path,
        latest_run,
        resolved_model,
        resolved_effort,
        child_task_ids,
        blocked_by_task_ids,
        delivered_input_count,
    } = relations;
    let prompt = item.prompt.clone();
    let title = item
        .display_name
        .clone()
        .or(prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    let git_state = worktree_path
        .as_deref()
        .and_then(|path| {
            Path::new(path)
                .exists()
                .then(|| task_git_state(path, task_base_ref(&item, repo).as_deref()))
        })
        .and_then(Result::ok)
        .unwrap_or_default();
    let existing_worktree_path = worktree_path.filter(|path| Path::new(path).exists());
    let workflow_name = item.pipeline.clone();
    let stage_transition = latest_run
        .as_ref()
        .and_then(|run| run.completion_transition.clone())
        .or_else(|| {
            repo.zip(workflow_name.as_deref())
                .zip(item.stage.as_deref())
                .and_then(|((repo, workflow_name), stage_name)| {
                    crate::task_creator::resolve_stage_transition(
                        repo,
                        workflow_name,
                        item.pipeline_def.as_deref(),
                        stage_name,
                    )
                    .ok()
                    .flatten()
                })
        });
    let revision_limit = repo
        .zip(workflow_name.as_deref())
        .and_then(|(repo, workflow_name)| {
            crate::task_creator::resolve_revision_limit(
                repo,
                workflow_name,
                item.pipeline_def.as_deref(),
            )
            .ok()
        })
        .unwrap_or(crate::task_creator::DEFAULT_REVISION_LIMIT);
    let waiting_prompt_snippet = item.last_output_preview.clone();
    // Reported only once a session has said something about its composer. An
    // absent field means "nothing has reported one", which is a different
    // answer from `unknown` — that one means a session reported it and could
    // prove nothing.
    let composer = item
        .composer_attestation
        .clone()
        .map(|attestation| TaskComposer {
            text: item.composer_text.clone(),
            attestation,
        });
    // `pipeline_item.agent_provider` retains the task-level provider fallback
    // used when resolving later stages. A stage-level agent can run under a
    // different provider, so terminal consumers must follow the provider the
    // latest durable run actually spawned.
    let active_agent_provider = latest_run
        .as_ref()
        .and_then(|run| run.agent_provider.clone())
        .or(item.agent_provider);
    TaskDetail {
        id: item.id,
        repo_id: item.repo_id,
        title,
        prompt,
        stage: item.stage,
        workflow_name: workflow_name.clone(),
        legacy_pipeline_name: workflow_name,
        stage_transition,
        runtime_state: item.runtime_status,
        read_state: Some(read_state_for_activity(item.activity.as_deref()).to_string()),
        input_blocked: item.input_blocked,
        activity: item.activity,
        snippet: None,
        waiting_prompt_snippet,
        composer,
        agent_type: item.agent_type,
        agent_provider: active_agent_provider,
        model: resolved_model,
        effort: resolved_effort,
        branch: item.branch,
        pr_url: item.pr_url,
        closed_at: item.closed_at,
        worktree_path: existing_worktree_path,
        commits_ahead: git_state.commits_ahead,
        commits_behind: git_state.commits_behind,
        dirty: git_state.dirty,
        latest_run: latest_run.map(map_task_latest_run),
        revision_rounds: item.revision_rounds,
        revision_limit,
        delivered_input_count,
        parent_task_id: item.parent_task_id,
        child_task_ids,
        blocked_by_task_ids,
    }
}

fn model_from_spawn_options(raw: Option<&str>) -> Option<String> {
    spawn_option_from_json(raw, "model")
}

fn spawn_option_from_json(raw: Option<&str>, key: &str) -> Option<String> {
    raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|options| options.get(key)?.as_str().map(str::to_string))
}

fn map_task_latest_run(run: crate::db::StageRun) -> TaskLatestRun {
    let summary = run
        .result
        .as_deref()
        .and_then(|result| serde_json::from_str::<serde_json::Value>(result).ok())
        .and_then(|result| {
            result
                .get("summary")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        // Orphaned-workspace runs store a plain-text result instead of the
        // `{status, summary, metadata}` verdict JSON; pass it through as-is.
        .or_else(|| run.result.clone());
    TaskLatestRun {
        id: run.id,
        stage: run.stage,
        kind: run.kind,
        agent: run.agent,
        status: run.status,
        summary,
        resumed_from_run_id: run.resumed_from_run_id,
        resume_fallback_reason: run.resume_fallback_reason,
        finished_at: run.finished_at,
    }
}

const TASK_LISTING_PROMPT_LIMIT: usize = 500;

fn bound_task_listing_prompt(prompt: &str) -> String {
    let mut characters = prompt.chars();
    let bounded = characters
        .by_ref()
        .take(TASK_LISTING_PROMPT_LIMIT)
        .collect::<String>();
    if characters.next().is_some() {
        let mut truncated = bounded
            .chars()
            .take(TASK_LISTING_PROMPT_LIMIT - 1)
            .collect::<String>();
        truncated.push('…');
        truncated
    } else {
        bounded
    }
}

fn map_repo_summary(repo: crate::db::Repo, remote_url: Option<String>) -> RepoSummary {
    RepoSummary {
        id: repo.id,
        name: repo.name,
        remote_url_hash: repo.remote_url_hash,
        remote_url,
    }
}

fn map_repo_detail(repo: crate::db::Repo) -> RepoDetail {
    RepoDetail {
        id: repo.id,
        path: repo.path,
        name: repo.name,
        default_branch: repo.default_branch,
        hidden: repo.hidden,
        sort_order: repo.sort_order,
        created_at: repo.created_at,
        last_opened_at: repo.last_opened_at,
    }
}

#[derive(Default)]
struct TaskGitState {
    commits_ahead: i64,
    commits_behind: i64,
    dirty: bool,
}

fn validate_git_repo_path(path: &str) -> Result<PathBuf, AddRepoError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| AddRepoError::InvalidPath(format!("path does not exist: {}", e)))?;
    if !canonical.is_dir() {
        return Err(AddRepoError::InvalidPath(
            "path must be a directory".to_string(),
        ));
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&canonical)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map_err(|e| AddRepoError::Internal(format!("failed to run git: {}", e)))?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "true" {
        return Err(AddRepoError::InvalidPath(
            "path is not a git repository".to_string(),
        ));
    }
    Ok(canonical)
}

fn git_default_branch(repo_path: &Path) -> Result<String, String> {
    let remote_head = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .map_err(|e| format!("failed to run git symbolic-ref: {}", e))?;
    if remote_head.status.success() {
        let branch = String::from_utf8_lossy(&remote_head.stdout)
            .trim()
            .strip_prefix("origin/")
            .map(str::to_string)
            .or_else(|| {
                let trimmed = String::from_utf8_lossy(&remote_head.stdout)
                    .trim()
                    .to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        if let Some(branch) = branch {
            return Ok(branch);
        }
    }

    let head = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["branch", "--show-current"])
        .output()
        .map_err(|e| format!("failed to run git branch: {}", e))?;
    if head.status.success() {
        let branch = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if !branch.is_empty() {
            return Ok(branch);
        }
    }
    Err("could not determine default branch".to_string())
}

fn task_base_ref(item: &crate::db::PipelineItem, repo: Option<&crate::db::Repo>) -> Option<String> {
    item.base_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| repo.and_then(|repo| repo.default_branch.clone()))
}

fn task_git_state(worktree_path: &str, base_ref: Option<&str>) -> Result<TaskGitState, String> {
    let dirty = git_status_dirty(worktree_path)?;
    let (commits_ahead, commits_behind) = match base_ref {
        Some(base_ref) => git_ahead_behind(worktree_path, base_ref).unwrap_or((0, 0)),
        None => (0, 0),
    };
    Ok(TaskGitState {
        commits_ahead,
        commits_behind,
        dirty,
    })
}

fn git_status_dirty(worktree_path: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("failed to run git status: {}", e))?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(!output.stdout.is_empty())
}

fn git_ahead_behind(worktree_path: &str, base_ref: &str) -> Result<(i64, i64), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(["rev-list", "--left-right", "--count"])
        .arg(format!("{base_ref}...HEAD"))
        .output()
        .map_err(|e| format!("failed to run git rev-list: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.split_whitespace();
    let behind = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let ahead = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

fn generate_repo_id() -> Result<String, AddRepoError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AddRepoError::Internal(format!("system clock error: {}", e)))?
        .as_nanos();
    Ok(format!("repo-{nanos:x}"))
}

/// The task-input attachment contract this build serves: one optional image,
/// base64 in the input body, delivered as a file path in the injected message.
/// Bump it only if that shape changes in a way a client must branch on.
pub const TASK_INPUT_ATTACHMENT_VERSION: u8 = 1;

pub fn build_mobile_server_status(
    config: &Config,
    pairing_code: Option<String>,
) -> MobileServerStatus {
    MobileServerStatus {
        state: "running".to_string(),
        desktop_id: config.desktop_id.clone(),
        desktop_name: config.desktop_name.clone(),
        version: config.version.clone(),
        environment: config.environment.clone(),
        server_version: Some(config.version.clone()),
        lan_host: config.lan_host.clone(),
        lan_port: config.lan_port,
        pairing_code,
        ksp_stream_version: Some(2),
        task_input_attachment_version: Some(TASK_INPUT_ATTACHMENT_VERSION),
        agent_providers: Some(crate::agent_inventory::installed_agent_providers()),
        agent_api_tools: Some(
            kanna_tool_catalog::bundled_catalog()
                .tools
                .into_iter()
                .map(|tool| tool.name)
                .collect(),
        ),
        write_path_health: crate::workspace_commands::write_path_health(),
    }
}

#[cfg(test)]
mod tests {
    use super::{CreateTaskRequest, TransferImportSummary};
    use crate::config::Config;
    use crate::db::Db;
    use serde_json::json;

    #[test]
    fn create_task_request_uses_agent_type_camel_case() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "repoId": "repo-1",
            "prompt": "Build the view",
            "displayName": "Short task title",
            "agentProvider": "claude",
            "agentType": "agent",
            "terminalCols": 104,
            "terminalRows": 72
        }))
        .unwrap();

        assert_eq!(request.display_name.as_deref(), Some("Short task title"));
        assert_eq!(request.agent_type.as_deref(), Some("agent"));
        assert_eq!(request.terminal_cols, Some(104));
        assert_eq!(request.terminal_rows, Some(72));
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Build the view",
                "displayName": "Short task title",
                "workflowName": null,
                "stage": null,
                "baseRef": null,
                "agent": null,
                "agentProvider": "claude",
                "agentType": "agent",
                "terminalCols": 104,
                "terminalRows": 72,
                "model": null,
                "effort": null,
                "permissionMode": null,
                "allowedTools": null,
                "disallowedTools": null,
                "maxTurns": null,
                "maxBudgetUsd": null,
                "setupCmds": null,
                "resumeSessionId": null,
                "blockerTaskIds": null,
                "notifyTaskId": null,
                "parentTaskId": null,
                "recoverySnapshot": null
            })
        );
    }

    #[test]
    fn create_task_request_does_not_retain_body_task_id() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "taskId": "0123456789abcdef",
            "repoId": "repo-1",
            "prompt": "Build the view"
        }))
        .unwrap();

        let serialized = serde_json::to_value(request).unwrap();
        assert!(serialized.get("taskId").is_none());
    }

    #[test]
    fn create_task_request_accepts_display_name_snake_case_alias() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "repoId": "repo-1",
            "prompt": "Build the view",
            "display_name": "Short task title"
        }))
        .unwrap();

        assert_eq!(request.display_name.as_deref(), Some("Short task title"));
    }

    #[test]
    fn transfer_import_summary_rejects_terminal_control_characters() {
        let valid = TransferImportSummary {
            source_machine: Some("Primary Mac".to_string()),
            repo_mode: Some("bundle-repo".to_string()),
            session_restored: true,
        };
        assert_eq!(valid.validate(), Ok(()));

        for unsafe_value in ["Primary\nMac", "Primary\u{1b}]2;spoof\u{7}"] {
            let summary = TransferImportSummary {
                source_machine: Some(unsafe_value.to_string()),
                ..valid.clone()
            };
            assert!(summary
                .validate()
                .is_err_and(|error| error.contains("control characters")));
        }
    }

    #[test]
    fn list_desktops_returns_configured_descriptor() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("desktop-list"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        let api = super::MobileApi::new(config, db);
        let desktops = api.list_desktops().unwrap();

        assert_eq!(desktops.len(), 1);
        assert_eq!(desktops[0].id, "desktop-1");
        assert_eq!(desktops[0].name, "Studio Mac");
        assert_eq!(desktops[0].connection_mode, "both");
    }

    #[test]
    fn list_repos_returns_repo_summaries() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-summaries"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.patch_repo("repo-1", None, None, Some(Some("hash-repo-one")), None)
            .unwrap();

        let api = super::MobileApi::new(config, db);
        let repos = api.list_repos().unwrap();

        assert_eq!(
            repos,
            vec![
                super::RepoSummary {
                    id: "repo-1".to_string(),
                    name: "Repo One".to_string(),
                    remote_url_hash: Some("hash-repo-one".to_string()),
                    remote_url: None,
                },
                super::RepoSummary {
                    id: "repo-2".to_string(),
                    name: "Repo Two".to_string(),
                    remote_url_hash: None,
                    remote_url: None,
                },
            ]
        );
    }

    #[test]
    fn list_recent_tasks_returns_open_tasks_in_updated_order() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-tasks"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-older",
            "repo-1",
            "older prompt",
            Some("Older Task"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        let long_prompt = format!("{}PROMPT_END_SENTINEL", "界".repeat(500));
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            &long_prompt,
            Some("Newer Task"),
            "pr",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.update_pipeline_item_activity("task-newer", "unread")
            .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-newer",
            task_id: "task-newer",
            stage: "pr",
            kind: "main",
            agent: Some("review"),
            agent_provider: Some("codex"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-newer"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "done prompt",
            Some("Done Task"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_recent_tasks().unwrap();

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "task-newer");
        assert_eq!(tasks[0].repo_name.as_deref(), Some("Repo One"));
        assert_eq!(tasks[0].activity.as_deref(), Some("unread"));
        assert_eq!(tasks[0].activity_revision, 1);
        assert_eq!(tasks[0].agent.as_deref(), Some("review"));
        let prompt = tasks[0].prompt.as_deref().expect("bounded prompt");
        assert_eq!(prompt.chars().count(), super::TASK_LISTING_PROMPT_LIMIT);
        assert!(prompt.ends_with('…'));
        assert!(!prompt.contains("PROMPT_END_SENTINEL"));
        assert_eq!(tasks[1].id, "task-older");
        assert_eq!(tasks[1].repo_name.as_deref(), Some("Repo One"));
    }

    #[test]
    fn list_repo_tasks_returns_only_requested_repo_tasks() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-tasks"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-repo-1",
            "repo-1",
            "repo one prompt",
            Some("Repo One Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-repo-2",
            "repo-2",
            "repo two prompt",
            Some("Repo Two Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_repo_tasks("repo-1").unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-repo-1");
        assert_eq!(tasks[0].repo_id, "repo-1");
        assert_eq!(tasks[0].repo_name.as_deref(), Some("Repo One"));
    }

    #[test]
    fn list_recent_tasks_includes_waiting_prompt_snippet() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-task-snippet"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-preview",
            "repo-1",
            "review mobile shell",
            Some("Review Shell"),
            "pr",
            "2026-04-17 09:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_preview("task-preview", Some("Latest agent output preview"))
            .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_recent_tasks().unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].snippet, None);
        assert_eq!(
            tasks[0].waiting_prompt_snippet.as_deref(),
            Some("Latest agent output preview")
        );
        let serialized = serde_json::to_value(&tasks[0]).unwrap();
        assert!(serialized.get("snippet").is_none());
        assert_eq!(
            serialized["waitingPromptSnippet"],
            "Latest agent output preview"
        );

        let legacy: super::TaskSummary = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "repoId": "repo-1",
            "repoName": null,
            "title": "Legacy task",
            "prompt": null,
            "stage": "review",
            "closedAt": null,
            "machineId": "desktop-old",
            "createdAt": null,
            "activity": "idle",
            "runtimeState": "idle",
            "readState": "read",
            "activityRevision": 0,
            "snippet": "Legacy output preview",
            "waitingPromptSnippet": null,
            "agentType": "pty",
            "parentTaskId": null,
            "pinned": false,
            "pinOrder": null,
            "blockedByTaskIds": []
        }))
        .unwrap();
        assert_eq!(legacy.snippet.as_deref(), Some("Legacy output preview"));
    }

    #[test]
    fn task_summaries_expose_unresolved_blocker_ids() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("task-summary-blockers"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        for (id, stage) in [
            ("task-blocked", "in progress"),
            ("task-open-blocker", "in progress"),
            ("task-resolved-blocker", "pr"),
        ] {
            db.insert_test_pipeline_item(id, "repo-1", "work", None, stage, "2026-04-17 09:00:00")
                .unwrap();
        }
        db.update_test_pipeline_item_pr_url(
            "task-resolved-blocker",
            "https://github.com/kanna/kanna/pull/9",
        )
        .unwrap();
        db.insert_task_blocker("task-blocked", "task-open-blocker")
            .unwrap();
        db.insert_task_blocker("task-blocked", "task-resolved-blocker")
            .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_repo_tasks("repo-1").unwrap();
        let blocked = tasks.iter().find(|task| task.id == "task-blocked").unwrap();

        assert_eq!(blocked.blocked_by_task_ids, vec!["task-open-blocker"]);

        let detail = api.get_task("task-blocked").unwrap().unwrap();
        assert_eq!(detail.blocked_by_task_ids, vec!["task-open-blocker"]);
        let serialized = serde_json::to_value(&detail).unwrap();
        assert_eq!(
            serialized["blockedByTaskIds"],
            serde_json::json!(["task-open-blocker"])
        );
    }

    #[test]
    fn task_summaries_expose_the_parent_task_id() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("task-summary-parent"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-parent",
            "repo-1",
            "parent work",
            Some("Parent"),
            "in progress",
            "2026-04-17 09:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-child",
            "repo-1",
            "child work",
            Some("Child"),
            "in progress",
            "2026-04-17 10:00:00",
        )
        .unwrap();
        db.update_pipeline_item_parent("task-child", Some("task-parent"))
            .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_repo_tasks("repo-1").unwrap();
        let parent_by_id: std::collections::HashMap<_, _> = tasks
            .iter()
            .map(|task| (task.id.as_str(), task.parent_task_id.clone()))
            .collect();

        assert_eq!(
            parent_by_id.get("task-child"),
            Some(&Some("task-parent".to_string()))
        );
        assert_eq!(parent_by_id.get("task-parent"), Some(&None));

        let serialized =
            serde_json::to_value(tasks.iter().find(|task| task.id == "task-child").unwrap())
                .unwrap();
        assert_eq!(serialized["parentTaskId"], "task-parent");
    }

    #[test]
    fn task_detail_uses_stored_workflow_transition_when_origin_definition_is_unavailable() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("task-detail-stored-transition"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        // This path intentionally has no Git repository or origin definition.
        // A durable task snapshot must be sufficient for task-detail metadata.
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-stored",
            "repo-1",
            "frozen task",
            Some("Frozen Task"),
            "frozen",
            "2026-04-17 09:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_pipeline_def(
            "task-stored",
            &json!({
                "name": "default",
                "stages": [{
                    "name": "frozen",
                    "transition": "manual"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let api = super::MobileApi::new(config, db);
        let detail = api.get_task("task-stored").unwrap().unwrap();

        assert_eq!(detail.stage_transition.as_deref(), Some("manual"));
    }

    #[test]
    fn get_task_surfaces_latest_stage_run_verdict() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("task-detail-latest-run"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-no-runs",
            "repo-1",
            "no runs yet",
            None,
            "in progress",
            "2026-07-22 09:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-reviewed",
            "repo-1",
            "specialty review child",
            Some("Security Review"),
            "review",
            "2026-07-22 09:05:00",
        )
        .unwrap();
        db.insert_stage_run(crate::db::NewStageRun {
            id: "run-1",
            task_id: "task-reviewed",
            stage: "review",
            kind: "main",
            agent: Some("review-security"),
            agent_provider: Some("claude"),
            model: None,
            effort: None,
            status: "running",
            result: None,
            feedback: None,
            session_id: Some("task-reviewed"),
            provider_session_id: None,
            cwd: None,
            resumed_from_run_id: None,
        })
        .unwrap();
        db.finish_latest_running_stage_run(
            "task-reviewed",
            "failed",
            Some(
                &serde_json::json!({
                    "status": "failure",
                    "summary": "FAIL: token echoed to the daemon log",
                    "metadata": null,
                })
                .to_string(),
            ),
            Some("FAIL: token echoed to the daemon log"),
        )
        .unwrap();

        let api = super::MobileApi::new(config, db);

        let detail = api.get_task("task-no-runs").unwrap().unwrap();
        assert_eq!(detail.latest_run, None);

        let detail = api.get_task("task-reviewed").unwrap().unwrap();
        let latest_run = detail.latest_run.expect("latest run");
        assert_eq!(latest_run.stage, "review");
        assert_eq!(latest_run.kind, "main");
        assert_eq!(latest_run.agent.as_deref(), Some("review-security"));
        assert_eq!(latest_run.status, "failed");
        assert_eq!(
            latest_run.summary.as_deref(),
            Some("FAIL: token echoed to the daemon log")
        );
        assert!(latest_run.finished_at.is_some());
    }

    #[test]
    fn search_tasks_matches_display_name_or_prompt_and_excludes_closed_tasks() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("search-tasks"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "test-version".to_string(),
            environment: "development".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-merge",
            "repo-1",
            "follow up on merge conflicts",
            Some("Merge Cleanup"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-other",
            "repo-1",
            "write release notes",
            Some("Docs"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "merge old branch",
            Some("Done Merge"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.search_tasks("merge").unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-merge");
        assert_eq!(tasks[0].title, "Merge Cleanup");
    }

    #[test]
    fn status_reflects_production_build_metadata() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("status"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "0.0.69".to_string(),
            environment: "production".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let _db = Db::open_for_tests(&config.db_path).unwrap();
        let status = super::build_mobile_server_status(&config, Some("ABC123".to_string()));
        let status_json = serde_json::to_value(&status).unwrap();

        assert_eq!(status.state, "running");
        assert_eq!(status.desktop_id, "desktop-1");
        assert_eq!(status.desktop_name, "Studio Mac");
        assert_eq!(status_json["version"], "0.0.69");
        assert_eq!(status_json["environment"], "production");
        assert_eq!(status_json["serverVersion"], "0.0.69");
        assert_eq!(status_json["kspStreamVersion"], 2);
        // The marker a phone reads before it offers the attach control. A
        // desktop that omits it is one that would swallow the photo.
        assert_eq!(
            status_json["taskInputAttachmentVersion"],
            super::TASK_INPUT_ATTACHMENT_VERSION
        );
        assert_eq!(status_json["writePathHealth"]["status"], "healthy");
        assert_eq!(status_json["writePathHealth"]["maxWorkspaceCommands"], 4);
        assert_eq!(status.pairing_code.as_deref(), Some("ABC123"));
    }

    #[test]
    fn status_reflects_full_staging_prerelease_metadata() {
        let config = Config {
            relay_url: "wss://relay-staging.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-staging".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-staging-daemon".to_string(),
            db_path: Db::test_db_path("status-staging"),
            kanna_cli_path: None,
            desktop_id: "desktop-staging".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            version: "0.0.69-staging.1".to_string(),
            environment: "staging".to_string(),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48121,
            transfer_port: 4455,
            activity_event_debounce_seconds: 300,
            pairing_store_path: "/tmp/kanna-staging-pairings.json".to_string(),
        };

        let _db = Db::open_for_tests(&config.db_path).unwrap();
        let status = super::build_mobile_server_status(&config, None);
        let status_json = serde_json::to_value(&status).unwrap();

        assert_eq!(status_json["version"], "0.0.69-staging.1");
        assert_eq!(status_json["environment"], "staging");
        assert_eq!(status_json["serverVersion"], "0.0.69-staging.1");
    }
}
