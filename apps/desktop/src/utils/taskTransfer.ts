import { isAgentProvider } from "@kanna/agent-protocol";
import type { PipelineItem } from "../types/kanna";
import type { SessionRecoveryState } from "../composables/sessionRecoveryState";

export type RepoAcquisitionMode = "reuse-local" | "clone-remote" | "bundle-repo";
export type TransferArtifactKind =
  | "session-rollout"
  | "session-archive"
  | "session-transcript"
  | "session-export";
/**
 * How the receiver turns a fetched artifact into resumable session state.
 *
 * `copy-file` and `extract-tar-gz` place bytes under `$HOME` through the Rust
 * fence in `transfer_artifact.rs`. `opencode-import` does not place anything:
 * OpenCode keeps every conversation in one shared SQLite store, so the only
 * supported way in is its own `opencode import`, run in the destination
 * worktree. That artifact must therefore never reach the filesystem fence.
 */
export type TransferArtifactMaterialization = "copy-file" | "extract-tar-gz" | "opencode-import";

/** The one filename an OpenCode session export may travel under. */
export const OPENCODE_SESSION_EXPORT_FILENAME = "opencode-session.json";

/**
 * The CLI-owned data directory `opencode import` writes into, recorded so the
 * payload still describes where session state lands. It is a description, not
 * an instruction: no code derives a destination from it, and `XDG_DATA_HOME`
 * can move the real directory elsewhere.
 */
export const OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH = ".local/share/opencode";

/**
 * OpenCode session ids are `ses_` followed by base62 — not a uuid, unlike every
 * other provider Kanna resumes.
 */
const OPENCODE_SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{1,64}$/;

export function isOpencodeSessionId(value: string): boolean {
  return OPENCODE_SESSION_ID_PATTERN.test(value);
}

export interface TransferArtifactPayload {
  artifact_id: string;
  filename: string;
  provider: PipelineItem["agent_provider"];
  kind: TransferArtifactKind;
  home_rel_path: string;
  materialization: TransferArtifactMaterialization;
}

/**
 * How the source session ended before its state was staged.
 *
 * The SIGINT that finalizes a PTY source is refused outright for *adopted*
 * sessions — every session older than the running daemon, i.e. every task that
 * predates an app upgrade (`crates/daemon/src/pty.rs`, fails closed by design).
 * That is common enough that a hard failure would block all post-upgrade
 * transfers, so a refused signal or a session that never exits is recorded as a
 * degradation and carried to the receiver instead of being swallowed.
 */
export interface TransferFinalizationState {
  cleanly_finalized: boolean;
  degraded_reason: string | null;
}

/** Bounds what a peer can push into our persisted payload and toasts. */
const TRANSFER_DEGRADED_REASON_MAX_LENGTH = 512;

export function cleanTransferFinalizationState(): TransferFinalizationState {
  return { cleanly_finalized: true, degraded_reason: null };
}

export interface OutgoingTransferPayload {
  target_peer_id: string;
  target_desktop_id: string | null;
  task: {
    cloud_task_id: string;
    source_peer_id: string;
    source_desktop_id: string | null;
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
  finalization: TransferFinalizationState;
}

export interface BuildOutgoingTransferPayloadInput {
  sourcePeerId: string;
  sourceDesktopId?: string | null;
  sourceTaskId: string;
  targetPeerId: string;
  targetDesktopId?: string | null;
  item: Pick<
    PipelineItem,
    "id" | "cloud_task_id" | "prompt" | "stage" | "branch" | "pipeline" | "display_name" | "base_ref" | "agent_type" | "agent_provider" | "agent_session_id"
  >;
  /**
   * The session the payload promises, when the task row does not carry it.
   * OpenCode ids are discovered at transfer time rather than assigned at spawn
   * (see `planOpencodeSessionExport`), so `agent_session_id` is null for a task
   * that has a perfectly good conversation to ship.
   */
  resumeSessionId?: string | null;
  repoPath?: string | null;
  repoName?: string | null;
  repoDefaultBranch?: string | null;
  repoRemoteUrl: string | null;
  recovery: SessionRecoveryState | null;
  artifacts?: TransferArtifactPayload[];
  finalization?: TransferFinalizationState;
  targetHasRepo: boolean;
  bundle: {
    artifactId: string;
    filename: string;
    refName: string | null;
  } | null;
}

/**
 * The artifact each provider must ship for a resume to mean anything.
 *
 * Claude's conversation is the cwd-keyed transcript, not the
 * `~/.claude/tasks/<id>` lock directory, so the transcript is the load-bearing
 * one. OpenCode keeps no per-session file at all — its conversations live in a
 * shared SQLite store — so its conversation ships as an `opencode export`.
 * Providers absent from this table keep no transferable session state, so for
 * them an empty artifact list is not a defect.
 */
const REQUIRED_SESSION_ARTIFACT_KINDS: Partial<
  Record<NonNullable<PipelineItem["agent_provider"]>, TransferArtifactKind>
> = {
  claude: "session-transcript",
  codex: "session-rollout",
  copilot: "session-archive",
  opencode: "session-export",
};

export interface SessionArtifactRequirementInput {
  agentType: string | null;
  agentProvider: PipelineItem["agent_provider"] | null;
  resumeSessionId: string | null;
}

/**
 * Which artifact kind a transfer of this task must carry, or `null` when a
 * missing artifact is a legitimate absence: the agent never ran (no session
 * id), the task is not a PTY session, or the provider keeps nothing to ship.
 */
export function requiredSessionArtifactKind(
  input: SessionArtifactRequirementInput,
): TransferArtifactKind | null {
  if (!input.resumeSessionId || !input.agentProvider) return null;
  if (input.agentType !== "pty") return null;
  return REQUIRED_SESSION_ARTIFACT_KINDS[input.agentProvider] ?? null;
}

/**
 * A transfer promised a resumable session and could not back it. Typed rather
 * than string-matched because both sides act on it: the source fails the
 * transfer instead of shipping an artifact-less payload, and the receiver
 * refuses the import instead of minting a fresh session.
 */
export class MissingTransferSessionArtifactError extends Error {
  readonly missingTransferSessionArtifact = true;

  constructor(message: string) {
    super(message);
    this.name = "MissingTransferSessionArtifactError";
  }
}

export function isMissingTransferSessionArtifactError(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { missingTransferSessionArtifact?: unknown })
      .missingTransferSessionArtifact === true;
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

export interface TaskPullRequestedEvent {
  requestId: string;
  requesterPeerId: string;
  sourceTaskId: string;
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

function readNullableString(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string | null {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.length > 0 ? value : null;
    throw new Error(label);
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

function readRequiredEnum<T extends string>(
  record: Record<string, unknown>,
  keys: readonly string[],
  values: readonly T[],
  label: string,
): T {
  const value = readRequiredString(record, keys, label);
  if (!values.includes(value as T)) {
    throw new Error(`${label}: unsupported value ${value}`);
  }
  return value as T;
}

function parseRecoveryState(value: unknown, invalidMessage: string): SessionRecoveryState | null {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (!record) throw new Error(`${invalidMessage}: recovery must be an object or null`);
  const number = (key: keyof SessionRecoveryState): number => {
    const candidate = record[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new Error(`${invalidMessage}: recovery.${key} must be a finite number`);
    }
    return candidate;
  };
  if (typeof record.serialized !== "string" || typeof record.cursorVisible !== "boolean") {
    throw new Error(`${invalidMessage}: recovery payload is invalid`);
  }
  return {
    serialized: record.serialized,
    cols: number("cols"),
    rows: number("rows"),
    cursorRow: number("cursorRow"),
    cursorCol: number("cursorCol"),
    cursorVisible: record.cursorVisible,
    savedAt: number("savedAt"),
    sequence: number("sequence"),
  };
}

function parseFinalizationState(
  value: unknown,
  invalidMessage: string,
): TransferFinalizationState {
  // Senders predating this field report nothing; read that as clean rather
  // than inventing a degradation for every older peer.
  if (value === undefined || value === null) return cleanTransferFinalizationState();
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${invalidMessage}: finalization must be an object or null`);
  }
  const cleanlyFinalized = record.cleanly_finalized ?? record.cleanlyFinalized;
  if (typeof cleanlyFinalized !== "boolean") {
    throw new Error(`${invalidMessage}: finalization.cleanly_finalized must be a boolean`);
  }
  const degradedReason = readNullableString(
    record,
    ["degraded_reason", "degradedReason"],
    `${invalidMessage}: finalization.degraded_reason must be a string or null`,
  );
  return {
    cleanly_finalized: cleanlyFinalized,
    degraded_reason: degradedReason === null
      ? null
      : degradedReason.slice(0, TRANSFER_DEGRADED_REASON_MAX_LENGTH),
  };
}

function validateSimpleComponent(value: string, label: string): string {
  if (
    value.length > 1024
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
  ) {
    throw new Error(`${label} must be one safe path component`);
  }
  return value;
}

const SESSION_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CLAUDE_PROJECT_SLUG_PATTERN = /^[A-Za-z0-9-]{1,1024}$/;

interface ArtifactContract {
  kind: TransferArtifactKind;
  materialization: TransferArtifactMaterialization;
  /**
   * Returns the accepted `home_rel_path`, or throws. Most contracts pin one
   * exact path; the Claude transcript cannot, because its path is keyed by the
   * *source* session's cwd. The receiver derives its own destination, so that
   * field is only checked for shape here and never used to place a file.
   */
  assertHomeRelPath: (value: string) => string;
}

function exactHomeRelPath(homeRelPath: string): (value: string) => string {
  return (value: string) => {
    if (value !== homeRelPath) {
      throw new Error("transfer artifact path does not match the provider session contract");
    }
    return homeRelPath;
  };
}

function canonicalArtifactContract(
  provider: TransferArtifactPayload["provider"],
  resumeSessionId: string,
  filename: string,
): ArtifactContract {
  const sessionId = validateSimpleComponent(resumeSessionId, "transfer resume session id");
  if (provider === "claude" && filename === `${sessionId}.jsonl`) {
    if (!SESSION_UUID_PATTERN.test(sessionId)) {
      throw new Error("transfer resume session id is not a Claude session uuid");
    }
    return {
      kind: "session-transcript",
      materialization: "copy-file",
      assertHomeRelPath: (value: string) => {
        const slug = value.startsWith(".claude/projects/") && value.endsWith(`/${filename}`)
          ? value.slice(".claude/projects/".length, value.length - filename.length - 1)
          : null;
        if (!slug || !CLAUDE_PROJECT_SLUG_PATTERN.test(slug)) {
          throw new Error(
            "transfer artifact path does not match the Claude transcript contract",
          );
        }
        return value;
      },
    };
  }
  if (provider === "claude") {
    if (filename !== "claude-session.tar.gz") {
      throw new Error("transfer artifact filename does not match the Claude session contract");
    }
    return {
      kind: "session-archive",
      materialization: "extract-tar-gz",
      assertHomeRelPath: exactHomeRelPath(`.claude/tasks/${sessionId}`),
    };
  }
  if (provider === "copilot") {
    if (filename !== "copilot-session.tar.gz") {
      throw new Error("transfer artifact filename does not match the Copilot session contract");
    }
    return {
      kind: "session-archive",
      materialization: "extract-tar-gz",
      assertHomeRelPath: exactHomeRelPath(`.copilot/session-state/${sessionId}`),
    };
  }
  if (provider === "opencode") {
    if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("transfer resume session id is not an OpenCode session id");
    }
    if (filename !== OPENCODE_SESSION_EXPORT_FILENAME) {
      throw new Error("transfer artifact filename does not match the OpenCode session contract");
    }
    return {
      kind: "session-export",
      materialization: "opencode-import",
      // Nothing is written to this path: `opencode import` owns its store and
      // the receiver never derives a destination from the payload. The value is
      // pinned anyway so a peer cannot smuggle a path through the field.
      assertHomeRelPath: exactHomeRelPath(OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH),
    };
  }
  if (provider === "codex") {
    validateSimpleComponent(filename, "Codex rollout filename");
    const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T.+\.jsonl$/.exec(filename);
    if (
      !match
      || !filename.endsWith(`-${sessionId}.jsonl`)
      || Number(match[2]) < 1
      || Number(match[2]) > 12
      || Number(match[3]) < 1
      || Number(match[3]) > 31
    ) {
      throw new Error("transfer artifact filename does not match the Codex rollout contract");
    }
    return {
      kind: "session-rollout",
      materialization: "copy-file",
      assertHomeRelPath: exactHomeRelPath(
        `.codex/sessions/${match[1]}/${match[2]}/${match[3]}/${filename}`,
      ),
    };
  }
  throw new Error(`transfer artifacts are unsupported for provider ${provider}`);
}

function parseTransferArtifacts(
  value: unknown,
  taskProvider: PipelineItem["agent_provider"],
  resumeSessionId: string | null,
  invalidMessage: string,
): TransferArtifactPayload[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${invalidMessage}: artifacts must be an array`);
  }
  // A Claude PTY task ships two: the `~/.claude/tasks/<id>` session archive and
  // the conversation transcript. One artifact per kind, so neither can be
  // duplicated into a second destination.
  if (value.length > 2) {
    throw new Error(`${invalidMessage}: at most two resume artifacts are supported`);
  }
  if (value.length === 0) return [];
  if (!resumeSessionId) {
    throw new Error(`${invalidMessage}: artifact requires a resume session id`);
  }

  const seenKinds = new Set<TransferArtifactKind>();
  const seenArtifactIds = new Set<string>();
  return value.map((candidate, index) => {
    const artifact = asRecord(candidate);
    if (!artifact) throw new Error(`${invalidMessage}: artifact ${index} must be an object`);
    const provider = readRequiredString(
      artifact,
      ["provider"],
      `${invalidMessage}: artifact ${index} missing provider`,
    );
    if (!isAgentProvider(provider) || provider !== taskProvider) {
      throw new Error(`${invalidMessage}: artifact provider does not match the task provider`);
    }
    const artifactId = validateSimpleComponent(
      readRequiredString(
        artifact,
        ["artifact_id", "artifactId"],
        `${invalidMessage}: artifact ${index} missing artifact id`,
      ),
      "transfer artifact id",
    );
    const filename = validateSimpleComponent(
      readRequiredString(
        artifact,
        ["filename"],
        `${invalidMessage}: artifact ${index} missing filename`,
      ),
      "transfer artifact filename",
    );
    if (seenArtifactIds.has(artifactId)) {
      throw new Error(`${invalidMessage}: duplicate artifact id ${artifactId}`);
    }
    seenArtifactIds.add(artifactId);
    const contract = canonicalArtifactContract(provider, resumeSessionId, filename);
    const kind = readRequiredEnum(
      artifact,
      ["kind"],
      ["session-rollout", "session-archive", "session-transcript", "session-export"] as const,
      `${invalidMessage}: artifact ${index} missing kind`,
    );
    const materialization = artifact.materialization === undefined
      ? contract.materialization
      : readRequiredEnum(
          artifact,
          ["materialization"],
          ["copy-file", "extract-tar-gz", "opencode-import"] as const,
          `${invalidMessage}: artifact ${index} missing materialization`,
        );
    const homeRelPath = readRequiredString(
      artifact,
      ["home_rel_path", "homeRelPath"],
      `${invalidMessage}: artifact ${index} missing home_rel_path`,
    );
    if (kind !== contract.kind || materialization !== contract.materialization) {
      throw new Error(
        `${invalidMessage}: artifact kind, materialization, or path does not match the provider session contract`,
      );
    }
    if (seenKinds.has(kind)) {
      throw new Error(`${invalidMessage}: duplicate artifact kind ${kind}`);
    }
    seenKinds.add(kind);
    return {
      artifact_id: artifactId,
      filename,
      provider,
      kind,
      home_rel_path: contract.assertHomeRelPath(homeRelPath),
      materialization,
    };
  });
}

function normalizeOutgoingTransferPayload(
  payloadRecord: Record<string, unknown>,
  invalidMessage: string,
): OutgoingTransferPayload {
  const taskRecord = asRecord(payloadRecord.task);
  const repoRecord = asRecord(payloadRecord.repo);
  if (!taskRecord || !repoRecord) {
    throw new Error(invalidMessage);
  }
  const sourceTaskId = readRequiredString(
    taskRecord,
    ["source_task_id", "sourceTaskId"],
    `${invalidMessage}: task missing source_task_id`,
  );
  const sourcePeerId = readRequiredString(
    taskRecord,
    ["source_peer_id", "sourcePeerId"],
    `${invalidMessage}: task missing source_peer_id`,
  );
  const taskProviderValue = readRequiredString(
    taskRecord,
    ["agent_provider", "agentProvider"],
    `${invalidMessage}: task missing agent_provider`,
  );
  if (!isAgentProvider(taskProviderValue)) {
    throw new Error(`${invalidMessage}: task has unsupported agent_provider`);
  }
  const resumeSessionId = readNullableString(
    taskRecord,
    ["resume_session_id", "resumeSessionId"],
    `${invalidMessage}: task resume_session_id must be a string or null`,
  );
  const repoMode = readRequiredEnum(
    repoRecord,
    ["mode"],
    ["reuse-local", "clone-remote", "bundle-repo"] as const,
    `${invalidMessage}: repo missing mode`,
  );
  const bundleRecord = repoRecord.bundle === null || repoRecord.bundle === undefined
    ? null
    : asRecord(repoRecord.bundle);
  if (repoRecord.bundle !== null && repoRecord.bundle !== undefined && !bundleRecord) {
    throw new Error(`${invalidMessage}: repo bundle must be an object or null`);
  }
  const bundle = bundleRecord
    ? {
        artifact_id: validateSimpleComponent(
          readRequiredString(
            bundleRecord,
            ["artifact_id", "artifactId"],
            `${invalidMessage}: repo bundle missing artifact id`,
          ),
          "transfer bundle artifact id",
        ),
        filename: validateSimpleComponent(
          readRequiredString(
            bundleRecord,
            ["filename"],
            `${invalidMessage}: repo bundle missing filename`,
          ),
          "transfer bundle filename",
        ),
        ref_name: readNullableString(
          bundleRecord,
          ["ref_name", "refName"],
          `${invalidMessage}: repo bundle ref_name must be a string or null`,
        ),
      }
    : null;
  if (repoMode === "bundle-repo" && !bundle) {
    throw new Error(`${invalidMessage}: bundle-repo payload is missing bundle metadata`);
  }
  const artifacts = parseTransferArtifacts(
    payloadRecord.artifacts,
    taskProviderValue,
    resumeSessionId,
    invalidMessage,
  );

  return {
    target_peer_id: readRequiredString(
      payloadRecord,
      ["target_peer_id", "targetPeerId"],
      `${invalidMessage}: missing target_peer_id`,
    ),
    target_desktop_id: readOptionalString(payloadRecord, [
      "target_desktop_id",
      "targetDesktopId",
    ]),
    task: {
      cloud_task_id: readOptionalString(taskRecord, ["cloud_task_id", "cloudTaskId"])
        ?? sourceTaskId,
      source_peer_id: sourcePeerId,
      source_desktop_id: readOptionalString(taskRecord, [
        "source_desktop_id",
        "sourceDesktopId",
      ]),
      source_task_id: sourceTaskId,
      local_task_id: readNullableString(
        taskRecord,
        ["local_task_id", "localTaskId"],
        `${invalidMessage}: task local_task_id must be a string or null`,
      ) ?? undefined,
      resume_session_id: resumeSessionId,
      prompt: readNullableString(
        taskRecord,
        ["prompt"],
        `${invalidMessage}: task prompt must be a string or null`,
      ),
      stage: readRequiredString(taskRecord, ["stage"], `${invalidMessage}: task missing stage`),
      branch: readNullableString(
        taskRecord,
        ["branch"],
        `${invalidMessage}: task branch must be a string or null`,
      ),
      pipeline: readRequiredString(
        taskRecord,
        ["pipeline"],
        `${invalidMessage}: task missing pipeline`,
      ),
      display_name: readNullableString(
        taskRecord,
        ["display_name", "displayName"],
        `${invalidMessage}: task display_name must be a string or null`,
      ),
      base_ref: readNullableString(
        taskRecord,
        ["base_ref", "baseRef"],
        `${invalidMessage}: task base_ref must be a string or null`,
      ),
      agent_type: readNullableString(
        taskRecord,
        ["agent_type", "agentType"],
        `${invalidMessage}: task agent_type must be a string or null`,
      ),
      agent_provider: taskProviderValue,
    },
    repo: {
      mode: repoMode,
      remote_url: readNullableString(
        repoRecord,
        ["remote_url", "remoteUrl"],
        `${invalidMessage}: repo remote_url must be a string or null`,
      ),
      path: readNullableString(
        repoRecord,
        ["path"],
        `${invalidMessage}: repo path must be a string or null`,
      ),
      name: readNullableString(
        repoRecord,
        ["name"],
        `${invalidMessage}: repo name must be a string or null`,
      ),
      default_branch: readNullableString(
        repoRecord,
        ["default_branch", "defaultBranch"],
        `${invalidMessage}: repo default_branch must be a string or null`,
      ),
      bundle,
    },
    recovery: parseRecoveryState(payloadRecord.recovery, invalidMessage),
    artifacts,
    finalization: parseFinalizationState(payloadRecord.finalization, invalidMessage),
  };
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
    target_desktop_id: input.targetDesktopId ?? null,
    task: {
      cloud_task_id: input.item.cloud_task_id ?? input.item.id,
      source_peer_id: input.sourcePeerId,
      source_desktop_id: input.sourceDesktopId ?? null,
      source_task_id: input.sourceTaskId,
      resume_session_id: input.resumeSessionId ?? input.item.agent_session_id,
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
    finalization: input.finalization ?? cleanTransferFinalizationState(),
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

export function parseTaskPullRequestedEvent(value: unknown): TaskPullRequestedEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("task-pull-requested event payload is invalid");
  }

  return {
    requestId: readRequiredString(
      record,
      ["requestId", "request_id"],
      "task-pull-requested event missing request id",
    ),
    requesterPeerId: readRequiredString(
      record,
      ["requesterPeerId", "requester_peer_id"],
      "task-pull-requested event missing requester peer id",
    ),
    sourceTaskId: readRequiredString(
      record,
      ["sourceTaskId", "source_task_id"],
      "task-pull-requested event missing source task id",
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

  const sourcePeerId = readRequiredString(
    record,
    ["sourcePeerId", "source_peer_id"],
    "transfer-request payload missing sourcePeerId",
  );
  const sourceTaskId = readRequiredString(
    record,
    ["sourceTaskId", "source_task_id"],
    "transfer-request payload missing sourceTaskId",
  );
  const normalizedPayload = normalizeOutgoingTransferPayload(
    payloadRecord,
    "transfer-request payload is missing task or repo",
  );
  if (
    normalizedPayload.task.source_peer_id !== sourcePeerId
    || normalizedPayload.task.source_task_id !== sourceTaskId
  ) {
    throw new Error(
      "transfer-request payload source identity does not match the authenticated transfer envelope",
    );
  }

  return {
    transferId: readRequiredString(
      record,
      ["transferId", "transfer_id"],
      "transfer-request payload missing transferId",
    ),
    sourcePeerId,
    sourceTaskId,
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
    payload: normalizedPayload,
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
    payload: normalizeOutgoingTransferPayload(
      payloadRecord,
      "finalize_outgoing_transfer response payload is missing task or repo",
    ),
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

  return normalizeOutgoingTransferPayload(
    record,
    "task transfer payload_json is missing task or repo",
  );
}
