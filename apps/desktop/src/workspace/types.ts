import type { RemoteTaskPin } from "../services/remoteTaskPins";
import type { PipelineItem, Repo } from "../types/kanna";
import type {
  DesktopCloudRepo,
  DesktopCloudSnapshot,
  DesktopCloudTerminalRef,
} from "../services/desktopCloudTaskIndex";

export type WorkspaceSourceKind = "local" | "cloud" | "lan";
export type WorkspaceRepoSource = "local-only" | "remote-only" | "mixed";
export type WorkspaceReachability = "local" | "reachable" | "offline" | "unknown" | "stale";
export type WorkspaceTerminalRouteKind = "local" | "cloud" | "lan" | "none";

export interface WorkspaceOwner {
  kind: "local" | "remote";
  id: string;
  label?: string | null;
}

export interface WorkspaceTerminalRoute {
  kind: WorkspaceTerminalRouteKind;
  localSessionId?: string;
  remoteRef?: DesktopCloudTerminalRef;
}

export interface WorkspaceCapabilities {
  canOpenTerminal: boolean;
  canSendInput: boolean;
  canResizeTerminal: boolean;
  canClose: boolean;
  canCreateSiblingTask: boolean;
  canPushToMachine: boolean;
  canPullFromMachine: boolean;
  canOpenDiff: boolean;
  canOpenInIde: boolean;
  canOpenShell: boolean;
  canAdvanceStage: boolean;
  canEditMetadata: boolean;
}

export interface WorkspaceRepo {
  key: string;
  localRepoId: string | null;
  remoteRepoIds: string[];
  name: string;
  path: string | null;
  remoteUrl: string | null;
  remoteUrlHash: string | null;
  defaultBranch: string | null;
  source: WorkspaceRepoSource;
  sortOrder: number;
}

export interface WorkspaceTaskSource {
  kind: WorkspaceSourceKind;
  taskId: string;
  repoId: string;
  updatedAt: string;
  blockerRevision?: number;
  transitionRevision?: string | null;
  terminalRef?: DesktopCloudTerminalRef;
  blockedByTaskIds: string[];
}

export interface WorkspaceTask {
  id: string;
  logicalTaskKey: string;
  localTaskId: string | null;
  remoteTaskIds: string[];
  repoKey: string;
  item: PipelineItem;
  owner: WorkspaceOwner;
  sources: WorkspaceTaskSource[];
  blockedByTaskIds: string[];
  reachability: WorkspaceReachability;
  capabilities: WorkspaceCapabilities;
  terminal: WorkspaceTerminalRoute;
}

export interface RemoteTaskDiagnostics {
  itemId: string;
  prompt: string;
  repoId: string;
  sources: WorkspaceSourceKind[];
  selectedTerminalTransport: WorkspaceTerminalRouteKind;
  ownerDesktopId?: string;
  ownerLocalTaskId?: string;
  cloudUpdatedAt?: string;
  lanUpdatedAt?: string;
}

export interface LocalRepoWithRemote {
  repo: Repo;
  remoteUrlHash: string | null;
  remoteUrl?: string | null;
}

export interface BuildWorkspaceInput {
  localRepos: LocalRepoWithRemote[];
  localItems: PipelineItem[];
  localClosedItems?: Array<Pick<PipelineItem, "id" | "repo_id">>;
  cloudSnapshot: DesktopCloudSnapshot;
  lanSnapshot: DesktopCloudSnapshot;
  /** Viewer-local pin overlay for remote-only tasks, keyed by owner-side task id. */
  remoteTaskPins?: ReadonlyMap<string, RemoteTaskPin>;
  /** Viewer-local sidebar positions for repositories advertised by remote URL hash. */
  repoSidebarOrder?: ReadonlyMap<string, number>;
}

export interface BuildWorkspaceResult {
  repos: WorkspaceRepo[];
  tasks: WorkspaceTask[];
  diagnostics: RemoteTaskDiagnostics[];
}

export type RemoteRepo = DesktopCloudRepo;
