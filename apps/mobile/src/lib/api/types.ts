export type DesktopMode = "lan" | "remote";

export interface MobileServerStatus {
  state: string;
  desktopId: string;
  desktopName: string;
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

export interface PairingSession {
  code: string;
  desktopId: string;
  desktopName: string;
  lanHost: string;
  lanPort: number;
  expiresAtUnixMs: number;
}

export interface CreateTaskRequest {
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
}

export interface CreateTaskResponse {
  taskId: string;
  repoId: string;
  title: string;
  stage: string;
  agentType?: "pty" | "agent" | null;
}

export interface TaskActionResponse {
  taskId: string;
  followTask?: boolean;
}

export interface TaskSummary {
  id: string;
  repoId: string;
  repoName?: string | null;
  title: string;
  stage: string | null;
  waitingPromptSnippet?: string | null;
  agentProvider?: string | null;
  agentType?: "pty" | "agent" | null;
}
