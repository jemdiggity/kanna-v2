export const emulatorPorts = {
  auth: 9099,
  firestore: 8080,
  functions: 5001,
} as const;

export interface CreatePairingCodeRequest {
  desktopDisplayName: string;
}

export interface CreatePairingCodeResponse {
  pairingCode: string;
  pairingCodeId: string;
  desktopId: string;
  desktopSecret: string;
  desktopClaimToken: string;
  expiresAt: string;
}

export interface PairingCodeRecord {
  desktopId: string;
  desktopDisplayName: string;
  desktopClaimTokenHash: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "claimed" | "expired" | "cancelled";
  claimedByUid: string | null;
  claimedAt: string | null;
}

export interface DesktopRecord {
  desktopId: string;
  displayName: string;
  desktopSecret: string;
  lastSeenAt: string | null;
  pairingCodeId: string;
  revokedAt: string | null;
}

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
  cloudTaskId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  title: string;
  promptSnippet: string | null;
  displayName: string | null;
  stage: string;
  activity: CloudTaskActivity;
  status: CloudTaskStatus;
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
    provider: "claude" | "copilot" | "codex";
    type: string;
  };
  transfer: {
    state: CloudTaskTransferState;
    transferId: string | null;
    sourceDesktopId: string | null;
    destinationDesktopId: string | null;
  };
  blockedByTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
