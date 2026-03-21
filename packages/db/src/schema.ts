export interface Repo {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  hidden: number;       // 0 = visible, 1 = hidden
  created_at: string;
  last_opened_at: string;
}

export interface PipelineItem {
  id: string;
  repo_id: string;
  issue_number: number | null;
  issue_title: string | null;
  prompt: string | null;
  stage: string;
  pr_number: number | null;
  pr_url: string | null;
  branch: string | null;
  agent_type: string | null;
  activity: "working" | "unread" | "idle";
  activity_changed_at: string | null;
  port_offset: number | null;
  display_name: string | null;
  port_env: string | null;  // JSON: {"KANNA_DEV_PORT": "1421", ...}
  pinned: number;          // 0 or 1
  pin_order: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskBlocker {
  blocked_item_id: string;
  blocker_item_id: string;
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
  id: number;
  pipeline_item_id: string;
  activity: "working" | "unread" | "idle";
  started_at: string;
}
