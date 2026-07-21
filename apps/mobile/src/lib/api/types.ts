export type DesktopMode = "lan" | "remote";

export interface MobileServerStatus {
  state: string;
  desktopId: string;
  desktopName: string;
  version: string;
  environment: string;
  serverVersion: string | null;
  lanHost: string;
  lanPort: number;
  pairingCode: string | null;
}

export interface DesktopDescriptor {
  id: string;
  name: string;
  connectionMode: string;
}

export interface DesktopSummary {
  id: string;
  name: string;
  online: boolean;
  mode: DesktopMode;
  reachableViaRelay?: boolean;
  connectionMode?: "lan" | "internet" | "both";
  lastSeenAt?: string | null;
}

export interface RepoSummary {
  id: string;
  name: string;
}

export type RepoCommandGroup = "automation" | "configure";

export interface RepoCommand {
  id: string;
  label: string;
  description: string;
  group: RepoCommandGroup;
}

export interface RepoCommandCatalog {
  repoId: string;
  revision: string;
  commands: RepoCommand[];
}

export interface RunRepoCommandResponse {
  taskId: string;
  reused: boolean;
  ownerDesktopId?: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId?: string;
}

export interface PairingClaimRequest {
  code: string;
  deviceId: string;
  deviceName: string;
}

export interface PairingClaimResponse {
  desktopId: string;
  desktopName: string;
  /** Per-device LAN credential issued at claim time; absent from desktops
   * that predate device secrets. */
  deviceSecret?: string;
}

export interface CreateTaskRequest {
  taskId?: string;
  repoId: string;
  prompt: string;
  desktopId?: string;
  pipelineName?: string;
  baseRef?: string;
  stage?: string;
  agentProvider?: string;
  agentType?: "pty" | "agent";
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  terminalCols?: number;
  terminalRows?: number;
}

export interface CreateTaskResponse {
  taskId: string;
  repoId: string;
  title: string;
  prompt?: string;
  stage: string;
  agentType?: "pty" | "agent" | null;
  /** Client-resolved owner route when taskId is mobile-canonical. */
  ownerDesktopId?: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId?: string;
}

export interface TaskActionResponse {
  taskId: string;
  followTask?: boolean;
  /** Client-resolved owner route when taskId is mobile-canonical. */
  ownerDesktopId?: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId?: string;
  /** Exact client-resolved metadata for a newly created action task. */
  task?: TaskSummary;
}

export type TaskActivity = "idle" | "working" | "unread";

export interface TaskActivityResponse {
  taskId: string;
  activity: TaskActivity | null;
}

export interface TaskFileContent {
  path: string;
  content: string;
}

export type TaskDiffBranchMode = "none" | "staged" | "all";
export type TaskDiffWorkingMode = "all" | "unstaged" | "staged";

export type TaskDiffRequest =
  | { scope: "branch"; mode: TaskDiffBranchMode }
  | { scope: "working"; mode: TaskDiffWorkingMode };

export const DEFAULT_TASK_DIFF_REQUEST: TaskDiffRequest = {
  scope: "branch",
  mode: "all"
};

export interface TaskDiffContent {
  taskId: string;
  baseRef: string | null;
  mergeBase: string | null;
  patch: string;
  truncated: boolean;
}

export interface TaskSummary {
  id: string;
  repoId: string;
  repoName?: string | null;
  title: string;
  prompt?: string | null;
  stage: string | null;
  createdAt?: string | null;
  waitingPromptSnippet?: string | null;
  agentProvider?: string | null;
  agentType?: "pty" | "agent" | null;
  ownerDesktopId?: string;
  ownerLocalRepoId?: string;
  ownerLocalTaskId?: string;
  ownerOnline?: boolean;
  activity?: TaskActivity | null;
}

export interface TaskDetail extends TaskSummary {
  pipelineName?: string | null;
  stageTransition?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  closedAt?: string | null;
  worktreePath?: string | null;
  commitsAhead?: number;
  commitsBehind?: number;
  dirty?: boolean;
}
