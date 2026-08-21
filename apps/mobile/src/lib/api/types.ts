import type { AgentProvider } from "@kanna/agent-protocol";

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
  /** Optional direct-stream epoch. Absence identifies desktops that expose
   * only the legacy `/v1/stream` endpoint. */
  kspStreamVersion?: number;
  /** Absent from desktops that predate write-path health reporting; absence
   * means the health is unknown, not unhealthy. */
  writePathHealth?: WritePathHealth;
  /** Version of the task-input image-attachment contract the desktop serves.
   * Absent means an older desktop that would deserialize an `attachment`
   * field, ignore it, deliver the text alone and still answer 204 — so the
   * composer treats absence as "cannot attach" rather than sending a photo
   * into silence. */
  taskInputAttachmentVersion?: number;
  /** Agent provider CLIs installed on the desktop. See
   * {@link DesktopSummary.agentProviders}. */
  agentProviders?: AgentProvider[];
}

export interface WritePathHealth {
  healthy: boolean;
  status: string;
  activeWorkspaceCommands: number;
  maxWorkspaceCommands: number;
  longRunningWorkspaceCommands: number;
  oldestWorkspaceCommandSeconds: number | null;
}

export interface DesktopDescriptor {
  id: string;
  name: string;
  connectionMode: string;
  agentProviders?: AgentProvider[];
}

export interface DesktopSummary {
  id: string;
  name: string;
  online: boolean;
  mode: DesktopMode;
  reachableViaRelay?: boolean;
  connectionMode?: "lan" | "internet" | "both";
  lastSeenAt?: string | null;
  /** Agent provider CLIs whose executable resolves on that machine, as the
   * machine itself reported them.
   *
   * Advisory: `undefined` means "not reported" — an older desktop, or a record
   * this transport cannot carry it on — and callers must fall back to offering
   * every provider Kanna supports rather than blocking task creation. An empty
   * array is a reported answer: that machine can run nothing. */
  agentProviders?: AgentProvider[];
}

export interface RepoSummary {
  id: string;
  name: string;
  /** Clone source reported by an authenticated desktop that has this repo. */
  remoteUrl?: string | null;
  /** Cross-machine repo identity: hash of the git remote URL. The same
   * repository registered on several desktops shares this hash while each
   * desktop mints its own local id. */
  remoteUrlHash?: string | null;
  /** Desktop ids whose latest repository inventory contains this logical
   * repository. Mobile derives this from per-desktop `/v1/repos` reads; it is
   * not a server-persisted repository identity. */
  registeredDesktopIds?: string[];
}

export interface StartRepoCheckoutRequest {
  desktopId: string;
  name: string;
  remoteUrl: string;
  remoteUrlHash: string;
}

export type RepoCheckoutState = "running" | "done" | "failed";

export interface RepoCheckoutOperation {
  id: string;
  state: RepoCheckoutState;
  repoName: string;
  remoteUrlHash: string;
  repoId?: string;
  error?: string;
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
  workflowName?: string;
  baseRef?: string;
  stage?: string;
  agentProvider?: string;
  agentType?: "pty" | "agent";
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  terminalCols?: number;
  terminalRows?: number;
}

export interface AbortTaskCreationRequest {
  taskId: string;
  desktopId: string;
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

/**
 * The desktop's derived display value, blending the two dimensions below.
 * Mobile deliberately renders this: an operator's view of a task is exactly
 * the blend. Anything deciding whether an agent is *running* must read
 * {@link TaskRuntimeState} instead — a task busy inside a long tool or MCP
 * call whose output nobody has read reports "unread" here, exactly like a
 * finished one.
 */
export type TaskActivity = "idle" | "working" | "unread";

/**
 * The runtime dimension: the daemon's verdict on the task's agent session,
 * independent of selection and of read state. "exited" is written by the
 * server when a session ends without a replacement.
 */
export type TaskRuntimeState = "busy" | "waiting" | "idle" | "exited";

/** The read dimension: whether a human has seen the task's latest output. */
export type TaskReadState = "read" | "unread";

export interface TaskActivityResponse {
  taskId: string;
  activity: TaskActivity | null;
}

export interface TaskFileContent {
  path: string;
  content: string;
}

/**
 * One image sent with a task input.
 *
 * Base64 in the JSON body on purpose, and identically on both transports: the
 * relay carries a desktop invocation as a JSON message and the LAN client
 * posts JSON to the same route, so a single encoding means one server handler,
 * one durable record, and one thing to test. See
 * `lib/attachments/imageAttachmentBudget.ts` for the size budget that keeps
 * the payload small enough for that to be a good trade.
 */
export interface TaskInputAttachment {
  fileName: string;
  mediaType: string;
  dataBase64: string;
}

export interface TaskFileMentionInput {
  path: string;
  line?: number;
}

export interface TaskFileMentionMatch {
  path: string;
}

export interface ResolvedTaskFileMention extends TaskFileMentionInput {
  matches: TaskFileMentionMatch[];
  truncated: boolean;
}

export interface TaskFileMentionResolution {
  mentions: ResolvedTaskFileMention[];
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
  /** What the task's agent session is doing; absent on a server predating the split. */
  runtimeState?: TaskRuntimeState | null;
  /** Whether a human has read the task's latest output. */
  readState?: TaskReadState | null;
  /** Owner-side activity generation used to acknowledge exactly one notification. */
  activityRevision?: number;
  /** Owner-local id of the parent task when this task is a subtask. */
  parentTaskId?: string | null;
  /** Owner-local ids of unresolved blockers; non-empty means blocked. */
  blockedByTaskIds?: string[];
  /** Canonical owner-side task pin state. */
  pinned?: boolean;
  /** Owner-side ordering position among pinned tasks in the same repo. */
  pinOrder?: number | null;
}

export interface TaskLatestRun {
  id: string;
  stage: string;
  kind: string;
  status: string;
  summary?: string | null;
  resumedFromRunId?: string | null;
  resumeFallbackReason?: string | null;
  finishedAt?: string | null;
}

export interface TaskDetail extends TaskSummary {
  workflowName?: string | null;
  stageTransition?: string | null;
  /** Resolved model used by the latest stage run. */
  model?: string | null;
  /** Resolved provider-native reasoning effort used by the latest stage run. */
  effort?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  closedAt?: string | null;
  worktreePath?: string | null;
  commitsAhead?: number;
  commitsBehind?: number;
  dirty?: boolean;
  latestRun?: TaskLatestRun | null;
  /** Agent-requested revision rounds spent since the last human-requested one. */
  revisionRounds?: number;
  /** Rounds the task's workflow allows before it parks for its human; 0 = unlimited. */
  revisionLimit?: number;
  /**
   * Why messages delivered into this task's agent session are being refused,
   * or absent when they are not. `inherited-draft-unknown` means the daemon
   * adopted the session across a restart or handoff and its composer holds
   * text nobody saw typed, so submitting would append to an unsent line.
   */
  inputBlocked?: string | null;
}
