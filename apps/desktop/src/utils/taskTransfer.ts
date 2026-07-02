import type { PipelineItem } from "@kanna/db";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";

export type RepoAcquisitionMode = "reuse-local" | "clone-remote" | "bundle-repo";
export type TransferArtifactKind = "session-rollout" | "session-archive";
export type TransferArtifactMaterialization = "copy-file" | "extract-tar-gz";

export interface TransferArtifactPayload {
  artifact_id: string;
  filename: string;
  provider: PipelineItem["agent_provider"];
  kind: TransferArtifactKind;
  home_rel_path: string;
  materialization: TransferArtifactMaterialization;
}

export interface OutgoingTransferPayload {
  target_peer_id: string;
  task: {
    source_peer_id: string;
    source_task_id: string;
    local_task_id?: string;
    resume_session_id?: string | null;
    prompt: string | null;
    stage: string;
    branch: string | null;
    pipeline: string;
    display_name: string | null;
    base_ref: string | null;
    agent_type: string | null;
    agent_provider: PipelineItem["agent_provider"];
  };
  repo: {
    mode: RepoAcquisitionMode;
    remote_url: string | null;
    path: string | null;
    name: string | null;
    default_branch: string | null;
    bundle: {
      artifact_id: string;
      filename: string;
      ref_name: string | null;
    } | null;
  };
  recovery: SessionRecoveryState | null;
  artifacts?: TransferArtifactPayload[];
}

export interface BuildOutgoingTransferPayloadInput {
  sourcePeerId: string;
  sourceTaskId: string;
  targetPeerId: string;
  item: Pick<
    PipelineItem,
    "id" | "prompt" | "stage" | "branch" | "pipeline" | "display_name" | "base_ref" | "agent_type" | "agent_provider" | "agent_session_id"
  >;
  repoPath?: string | null;
  repoName?: string | null;
  repoDefaultBranch?: string | null;
  repoRemoteUrl: string | null;
  recovery: SessionRecoveryState | null;
  artifacts?: TransferArtifactPayload[];
  targetHasRepo: boolean;
  bundle: {
    artifactId: string;
    filename: string;
    refName: string | null;
  } | null;
}

export interface OutgoingTransferPreflightResult {
  transferId: string;
  sourcePeerId: string;
  targetHasRepo: boolean;
}

export interface IncomingTransferRequest {
  transferId: string;
  sourcePeerId: string;
  sourceTaskId: string;
  sourceName: string | null;
  payload: OutgoingTransferPayload;
}

export interface OutgoingTransferCommittedEvent {
  transferId: string;
  sourceTaskId: string;
  destinationLocalTaskId: string;
}

export interface OutgoingTransferFinalizationRequestEvent {
  transferId: string;
}

export interface FinalizedOutgoingTransferResult {
  transferId: string;
  payload: OutgoingTransferPayload;
  finalizedCleanly: boolean;
}

export interface TransferPeerOption {
  id: string;
  name: string;
  subtitle?: string;
  trusted: boolean;
  acceptingTransfers: boolean;
}

export interface PairingResult {
  peer: TransferPeerOption;
  verificationCode: string;
}

export interface PairingCompletedEvent {
  peerId: string;
  displayName: string;
  verificationCode: string;
}

export interface PairingRequestedEvent {
  requestId: string;
  peerId: string;
  displayName: string;
  verificationCode: string;
}

function normalizeRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function parseTransferPeer(value: unknown): TransferPeerOption | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readRequiredString(record, ["peer_id", "peerId"], "transfer peer missing peer_id");
  const name = readRequiredString(
    record,
    ["display_name", "displayName", "name"],
    "transfer peer missing display_name",
  );
  const trusted = readRequiredBoolean(
    record,
    ["trusted"],
    "transfer peer missing trusted flag",
  );
  const acceptingTransfers = readRequiredBoolean(
    record,
    ["accepting_transfers", "acceptingTransfers"],
    "transfer peer missing accepting_transfers flag",
  );

  return {
    id,
    name,
    trusted,
    acceptingTransfers,
    subtitle: trusted ? "paired" : "not paired",
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  throw new Error(label);
}

function readOptionalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function readRequiredBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  throw new Error(label);
}

export function chooseRepoAcquisitionMode(input: {
  remoteUrl: string | null;
  targetHasRepo: boolean;
  bundle: BuildOutgoingTransferPayloadInput["bundle"];
}): RepoAcquisitionMode {
  if (input.targetHasRepo) return "reuse-local";
  if (normalizeRemoteUrl(input.remoteUrl)) return "clone-remote";
  if (input.bundle) return "bundle-repo";
  return "bundle-repo";
}

export function resolveIncomingTransferBaseBranch(
  payload: Pick<OutgoingTransferPayload, "repo" | "task">,
): string | undefined {
  if (payload.repo.mode === "bundle-repo") {
    return payload.task.branch ?? payload.task.base_ref ?? undefined;
  }

  return payload.task.base_ref ?? undefined;
}

export function buildOutgoingTransferPayload(
  input: BuildOutgoingTransferPayloadInput,
): OutgoingTransferPayload {
  const remoteUrl = normalizeRemoteUrl(input.repoRemoteUrl);

  return {
    target_peer_id: input.targetPeerId,
    task: {
      source_peer_id: input.sourcePeerId,
      source_task_id: input.sourceTaskId,
      resume_session_id: input.item.agent_session_id,
      prompt: input.item.prompt,
      stage: input.item.stage,
      branch: input.item.branch,
      pipeline: input.item.pipeline,
      display_name: input.item.display_name,
      base_ref: input.item.base_ref,
      agent_type: input.item.agent_type,
      agent_provider: input.item.agent_provider,
    },
    repo: {
      mode: chooseRepoAcquisitionMode({
        remoteUrl,
        targetHasRepo: input.targetHasRepo,
        bundle: input.bundle,
      }),
      remote_url: remoteUrl,
      path: input.repoPath ?? null,
      name: input.repoName ?? null,
      default_branch: input.repoDefaultBranch ?? null,
      bundle: input.bundle
        ? {
            artifact_id: input.bundle.artifactId,
            filename: input.bundle.filename,
            ref_name: input.bundle.refName,
          }
        : null,
    },
    recovery: input.recovery,
    artifacts: input.artifacts ?? [],
  };
}

export function parseOutgoingTransferPreflightResult(
  value: unknown,
): OutgoingTransferPreflightResult {
  const record = asRecord(value);
  if (!record) {
    throw new Error("prepare_outgoing_transfer preflight returned an invalid payload");
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "prepare_outgoing_transfer preflight response missing transferId",
    ),
    sourcePeerId: readRequiredString(
      record,
      ["sourcePeerId", "source_peer_id"],
      "prepare_outgoing_transfer preflight response missing sourcePeerId",
    ),
    targetHasRepo: readRequiredBoolean(
      record,
      ["targetHasRepo", "target_has_repo"],
      "prepare_outgoing_transfer preflight response missing targetHasRepo",
    ),
  };
}

export function parseTransferPeers(value: unknown): TransferPeerOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseTransferPeer)
    .filter((peer): peer is TransferPeerOption => peer !== null);
}

export function parsePairingResult(value: unknown): PairingResult {
  const record = asRecord(value);
  if (!record) {
    throw new Error("start_peer_pairing returned an invalid payload");
  }

  const peer = parseTransferPeer(record.peer);
  if (!peer) {
    throw new Error("start_peer_pairing response missing peer");
  }

  return {
    peer,
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "start_peer_pairing response missing verification code",
    ),
  };
}

export function parsePairingCompletedEvent(value: unknown): PairingCompletedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("pairing-completed event payload is invalid");
  }

  return {
    peerId: readRequiredString(record, ["peerId", "peer_id"], "pairing-completed event missing peer id"),
    displayName: readRequiredString(
      record,
      ["displayName", "display_name"],
      "pairing-completed event missing display name",
    ),
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "pairing-completed event missing verification code",
    ),
  };
}

export function parsePairingRequestedEvent(value: unknown): PairingRequestedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("pairing-requested event payload is invalid");
  }

  return {
    requestId: readRequiredString(
      record,
      ["requestId", "request_id"],
      "pairing-requested event missing request id",
    ),
    peerId: readRequiredString(record, ["peerId", "peer_id"], "pairing-requested event missing peer id"),
    displayName: readRequiredString(
      record,
      ["displayName", "display_name"],
      "pairing-requested event missing display name",
    ),
    verificationCode: readRequiredString(
      record,
      ["verificationCode", "verification_code"],
      "pairing-requested event missing verification code",
    ),
  };
}

export function parseIncomingTransferRequest(value: unknown): IncomingTransferRequest {
  const record = asRecord(value);
  if (!record) {
    throw new Error("transfer-request event returned an invalid payload");
  }
  const payload = record.payload;
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    throw new Error("transfer-request payload missing payload");
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "transfer-request payload missing transferId",
    ),
    sourcePeerId: readRequiredString(
      record,
      ["sourcePeerId", "source_peer_id"],
      "transfer-request payload missing sourcePeerId",
    ),
    sourceTaskId: readRequiredString(
      record,
      ["sourceTaskId", "source_task_id"],
      "transfer-request payload missing sourceTaskId",
    ),
    sourceName: readOptionalString(record, [
      "sourceName",
      "source_name",
      "sourcePeerName",
      "source_peer_name",
      "peerName",
      "peer_name",
      "displayName",
      "display_name",
    ]),
    payload: payloadRecord as unknown as OutgoingTransferPayload,
  };
}

export function parseOutgoingTransferCommittedEvent(value: unknown): OutgoingTransferCommittedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("outgoing-transfer-committed event returned an invalid payload");
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "outgoing-transfer-committed payload missing transferId",
    ),
    sourceTaskId: readRequiredString(
      record,
      ["sourceTaskId", "source_task_id"],
      "outgoing-transfer-committed payload missing sourceTaskId",
    ),
    destinationLocalTaskId: readRequiredString(
      record,
      ["destinationLocalTaskId", "destination_local_task_id"],
      "outgoing-transfer-committed payload missing destinationLocalTaskId",
    ),
  };
}

export function parseOutgoingTransferFinalizationRequestEvent(
  value: unknown,
): OutgoingTransferFinalizationRequestEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("outgoing-transfer-finalization-requested event returned an invalid payload");
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "outgoing-transfer-finalization-requested payload missing transferId",
    ),
  };
}

export function parseFinalizedOutgoingTransferResult(
  value: unknown,
): FinalizedOutgoingTransferResult {
  const record = asRecord(value);
  if (!record) {
    throw new Error("finalize_outgoing_transfer returned an invalid payload");
  }

  const payloadValue = record.payload;
  const payloadRecord = asRecord(payloadValue);
  if (!payloadRecord) {
    throw new Error("finalize_outgoing_transfer response missing payload");
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "finalize_outgoing_transfer response missing transferId",
    ),
    payload: payloadRecord as unknown as OutgoingTransferPayload,
    finalizedCleanly: readRequiredBoolean(
      record,
      ["finalizedCleanly", "finalized_cleanly"],
      "finalize_outgoing_transfer response missing finalizedCleanly",
    ),
  };
}

export function parsePersistedOutgoingTransferPayload(raw: string | null): OutgoingTransferPayload {
  if (!raw) {
    throw new Error("task transfer payload is missing payload_json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `task transfer payload_json is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error("task transfer payload_json did not decode to an object");
  }

  const task = asRecord(record.task);
  const repo = asRecord(record.repo);
  if (!task || !repo) {
    throw new Error("task transfer payload_json is missing task or repo");
  }

  return record as unknown as OutgoingTransferPayload;
}
