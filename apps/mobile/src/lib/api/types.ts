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
  pipelineName?: string;
  baseRef?: string;
  stage?: string;
  agentProvider?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
}

export interface CreateTaskResponse {
  taskId: string;
  repoId: string;
  title: string;
  stage: string;
}

export interface TaskActionResponse {
  taskId: string;
}

export interface TaskSummary {
  id: string;
  repoId: string;
  title: string;
  stage: string | null;
  snippet?: string | null;
  agentProvider?: string | null;
}
