import type { AgentProvider } from "./generated/AgentProvider";

export const emulatorPorts = {
  auth: 9099,
  firestore: 8080,
  functions: 5001,
} as const;

export type CloudTaskActivity = "idle" | "working" | "unread";
export type CloudTaskStatus =
  | "active"
  | "blocked"
  | "pr"
  | "merge"
  | "done"
  | "transferring";
export type CloudTaskTransferState =
  | "none"
  | "outgoing"
  | "incoming"
  | "finalization_pending";

export interface CloudTaskSnapshot {
  cloudTaskId?: string;
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  waitingPromptSnippet: string | null;
  displayName: string | null;
  stage: string;
  activity: CloudTaskActivity;
  activityRevision?: number;
  blockerRevision?: number;
  transitionRevision?: string | null;
  status: CloudTaskStatus;
  // Missing on documents written by older desktop publishers.
  hasRunningPost?: boolean;
  repo: {
    cloudRepoId: string;
    name: string;
    remoteUrl: string | null;
    remoteUrlHash: string | null;
    defaultBranch: string | null;
  };
  branch: string | null;
  baseRef: string | null;
  prNumber: number | null;
  prUrl: string | null;
  agent: {
    provider: AgentProvider;
    type: string;
  };
  transfer: {
    state: CloudTaskTransferState;
    transferId: string | null;
    sourceDesktopId: string | null;
    destinationDesktopId: string | null;
  };
  blockedByTaskIds: string[];
  parentTaskId: string | null;
  pinned?: boolean;
  pinOrder?: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
