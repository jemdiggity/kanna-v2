export type AgentProvider = "claude" | "copilot" | "codex" | "opencode" | "antigravity";

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
  repo_id: string;
  issue_number: number | null;
  issue_title: string | null;
  prompt: string | null;
  pipeline: string;             // pipeline name (e.g., "default")
  pipeline_def: string | null;  // resolved pipeline JSON snapshot for this task
  stage: string;                // current stage name (e.g., "in progress")
  stage_result: string | null;  // JSON from stage-complete signal
  active_post_action: string | null; // stage-local action currently running
  tags: string;                 // JSON array of tag strings, e.g. '["pr"]' or '[]'
  pr_number: number | null;
  pr_url: string | null;
  branch: string | null;
  closed_at: string | null;
  agent_type: string | null;
  agent_provider: AgentProvider;
  activity: "working" | "unread" | "idle";
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
  previous_stage: string | null;
  teardown_started_at: string | null;
  parent_task_id: string | null; // subtask parent; nests under it in the sidebar
  created_at: string;
  updated_at: string;
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

export interface StageRun {
  id: string;
  task_id: string;
  stage: string;
  agent: string | null;
  agent_provider: AgentProvider | null;
  model: string | null;
  status: StageRunStatus;
  result: string | null;
  feedback: string | null;
  session_id: string | null;
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
  status: "pending" | "streaming" | "completed" | "failed" | "rejected";
  source_peer_id: string | null;
  target_peer_id: string | null;
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

export interface StageRun {
  id: string;
  pipeline_item_id: string;
  stage: string;
  status: "running" | "finished" | "failed";
  daemon_session_id: string | null;
  feedback: string | null;
  result_json: string | null;
  started_at: string;
  finished_at: string | null;
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
