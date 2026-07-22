import type { AgentProvider } from "@kanna/agent-protocol";

export type { AgentProvider } from "@kanna/agent-protocol";

export interface Repo {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  remote_url: string | null;
  remote_url_hash: string | null;
  hidden: number;       // 0 = visible, 1 = hidden
  sort_order: number;
  created_at: string;
  last_opened_at: string;
}

export interface PipelineItem {
  id: string;
  cloud_task_id?: string | null;
  repo_id: string;
  issue_number: number | null;
  issue_title: string | null;
  prompt: string | null;
  pipeline: string;             // pipeline name (e.g., "default")
  pipeline_def: string | null;  // resolved pipeline JSON snapshot for this task
  stage: string;                // current stage name (e.g., "in progress")
  pr_number: number | null;
  pr_url: string | null;
  pr_branch?: string | null;
  branch: string | null;
  closed_at: string | null;
  agent_type: string | null;
  agent_provider: AgentProvider;
  activity: "working" | "unread" | "idle";
  activity_revision?: number;
  activity_changed_at: string | null;
  unread_at: string | null;
  port_offset: number | null;
  display_name: string | null;
  last_output_preview: string | null;
  port_env: string | null;  // JSON: {"KANNA_DEV_PORT": "1421", ...}
  agent_spawn_options?: string | null; // JSON launch options for missing-session recovery
  pinned: number;          // 0 or 1
  pin_order: number | null;
  base_ref: string | null;
  agent_session_id: string | null;
  teardown_started_at: string | null;
  parent_task_id: string | null; // subtask parent; nests under it in the sidebar
  notify_task_id: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
  /** Transient/derived UI metadata. The legacy column was removed when stage_run
   * became the source of truth; optimistic store overlays may still attach the
   * post action name before the running post stage_run is visible. */
  active_post_action?: string | null;
  /** Derived by listPipelineItems (not a column): 1 while a `kind: "post"`
   * stage run is executing inside the task's live session. */
  has_running_post?: number;
}

export interface TaskBlocker {
  blocked_item_id: string;
  blocker_item_id: string;
}

export interface TaskPort {
  port: number;
  pipeline_item_id: string;
  env_name: string;
  created_at: string;
}

export type StageRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** "main" runs a pipeline stage; "post" runs a stage's tail work (e.g. commit). */
export type StageRunKind = "main" | "post";

export interface StageRun {
  id: string;
  task_id: string;
  stage: string;
  kind: StageRunKind;
  agent: string | null;
  agent_provider: AgentProvider | null;
  model: string | null;
  status: StageRunStatus;
  result: string | null;
  feedback: string | null;
  session_id: string | null;
  /** The agent CLI's own session id, assigned by Kanna or discovered from provider output. */
  provider_session_id: string | null;
  /** Worktree the run executed in; revisions resume the provider session here. */
  cwd: string | null;
  /** Set when this run resumed a previous run's provider session instead of starting fresh. */
  resumed_from_run_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface TrustedPeer {
  id: string;
  peer_id: string;
  display_name: string;
  public_key: string;
  capabilities_json: string;
  paired_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface TaskTransfer {
  id: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "streaming" | "importing" | "awaiting_acknowledgment" | "completed" | "failed" | "rejected";
  source_peer_id: string | null;
  target_peer_id: string | null;
  source_desktop_id: string | null;
  target_desktop_id: string | null;
  source_task_id: string | null;
  local_task_id: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  payload_json: string | null;
}

export interface TaskTransferProvenance {
  pipeline_item_id: string;
  source_peer_id: string;
  source_task_id: string;
  source_machine_task_label: string | null;
  imported_at: string;
}

export interface Worktree {
  id: string;
  pipeline_item_id: string;
  path: string;
  branch: string;
  created_at: string;
}

export interface TerminalSession {
  id: string;
  repo_id: string;
  pipeline_item_id: string | null;
  label: string | null;
  cwd: string | null;
  daemon_session_id: string | null;
  created_at: string;
}

export interface AgentRun {
  id: string;
  repo_id: string;
  agent_type: string;
  issue_number: number | null;
  pr_number: number | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface Setting {
  key: string;
  value: string;
}

export interface ActivityLog {
  pipeline_item_id: string;
  activity: "working" | "unread" | "idle";
  seconds: number;
}

export interface OperatorEvent {
  id: number;
  event_type: "task_selected" | "app_blur" | "app_focus";
  pipeline_item_id: string | null;
  repo_id: string | null;
  created_at: string;
}
