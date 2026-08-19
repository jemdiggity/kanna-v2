export type { AgentProvider } from "@kanna/agent-protocol";
import type { AgentProvider } from "@kanna/agent-protocol";

export interface Repo {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  remote_url: string | null;
  remote_url_hash: string | null;
  hidden: number;
  sort_order: number;
  created_at: string;
  last_opened_at: string;
}

export interface PipelineItem {
  id: string;
  cloud_task_id?: string | null;
  transfer_id?: string | null;
  transfer_direction?: "incoming" | "outgoing" | null;
  transfer_status?: TaskTransfer["status"] | null;
  transfer_source_peer_id?: string | null;
  transfer_target_peer_id?: string | null;
  transfer_source_desktop_id?: string | null;
  transfer_target_desktop_id?: string | null;
  /**
   * Why a transfer failed. The push is server work now, so a refusal — a source
   * that cannot ship the conversation, an import that gave up — has no caller
   * left to throw at. This is how it reaches the operator.
   */
  transfer_error?: string | null;
  repo_id: string;
  issue_number: number | null;
  issue_title: string | null;
  prompt: string | null;
  /** Workflow name. `pipeline` is the legacy storage column name. */
  pipeline: string;
  /** Pinned workflow definition JSON; legacy storage column name. */
  pipeline_def: string | null;
  stage: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_branch?: string | null;
  branch: string | null;
  closed_at: string | null;
  agent_type: string | null;
  agent_provider: AgentProvider;
  activity: "working" | "unread" | "idle";
  activity_revision?: number;
  blocker_revision?: number;
  transition_revision?: string | null;
  activity_changed_at: string | null;
  unread_at: string | null;
  port_offset: number | null;
  display_name: string | null;
  last_output_preview: string | null;
  port_env: string | null;
  agent_spawn_options?: string | null;
  pinned: number;
  pin_order: number | null;
  base_ref: string | null;
  agent_session_id: string | null;
  teardown_started_at: string | null;
  parent_task_id: string | null;
  notify_task_id: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
  active_post_action?: string | null;
  has_running_post?: number;
}

export interface TaskBlocker {
  blocked_item_id: string;
  blocker_item_id: string;
}

export type BlockerTaskState = Pick<PipelineItem, "closed_at" | "stage" | "pr_url">;
export type BlockerTaskStates = Record<string, BlockerTaskState>;
export type BlockerDisplayItem = Pick<
  PipelineItem,
  "id" | "display_name" | "issue_title" | "prompt" | "closed_at" | "stage" | "pr_url"
> & {
  fallback_task_id?: string;
};

export interface TaskPort {
  port: number;
  pipeline_item_id: string;
  env_name: string;
}

export interface TaskTransfer {
  id: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "claimed" | "streaming" | "importing" | "awaiting_acknowledgment" | "completed" | "failed" | "rejected";
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
  claim_owner_token?: string | null;
  claim_expires_at?: string | null;
}

export interface DbHandle {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T[]>;
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
