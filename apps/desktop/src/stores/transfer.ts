import type { PipelineItem, Repo } from "../types/kanna";
import {
  completeDesktopTaskTransfer,
  fetchActiveOutgoingTaskTransfer,
  fetchClosedTaskIdentities,
  getDesktopTaskTransfer,
  insertDesktopTaskTransfer,
  isActiveOutgoingTransferConflict,
  insertDesktopTaskTransferProvenance,
  markDesktopTaskTransferAwaitingAcknowledgment,
  markDesktopTaskTransferImporting,
  failOutgoingTaskTransfer,
  markIncomingTransferSidecarCleanupCompleted,
  rejectDesktopTaskTransfer,
  setDesktopTaskCloudIdentity,
  updateDesktopTaskTransferPayload,
} from "../services/desktopServerClient";
import { loadSessionRecoveryState } from "../composables/sessionRecoveryState";
import { invoke } from "../invoke";
import { fileExistsSafe } from "../utils/invokeHelpers";
import { defaultReposHome } from "../utils/reposHome";
import {
  buildOutgoingTransferPayload,
  isOpencodeSessionId,
  MissingTransferSessionArtifactError,
  OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH,
  OPENCODE_SESSION_EXPORT_FILENAME,
  parseFinalizedOutgoingTransferResult,
  parseOutgoingTransferPreflightResult,
  parsePersistedOutgoingTransferPayload,
  requiredSessionArtifactKind,
  resolveIncomingTransferBaseBranch,
  type FinalizedOutgoingTransferResult,
  type IncomingTransferRequest,
  type OutgoingTransferCommittedEvent,
  type OutgoingTransferPayload,
  type TransferArtifactKind,
  type TransferArtifactPayload,
  type TransferFinalizationState,
} from "../utils/taskTransfer";
import { buildTransferImportSummary } from "./transferImportSummary";
import type { QueriesApi } from "./queries";
import type { SessionsApi } from "./sessions";
import type { StoreContext } from "./state";
import type { TasksApi } from "./tasks";

const TRANSFER_SOURCE_FINALIZATION_WAIT_MS = 1500;
const INSTANCE_SCOPED_WORKTREE_ENV_KEYS = [
  "KANNA_TMUX_SESSION",
  "KANNA_DB_NAME",
  "KANNA_DB_PATH",
  "KANNA_DAEMON_DIR",
  "KANNA_TRANSFER_ROOT",
  "KANNA_WEBDRIVER_PORT",
  "KANNA_E2E_TARGET_WEBDRIVER_PORT",
  "KANNA_TRANSFER_PORT",
  "KANNA_TRANSFER_DISPLAY_NAME",
  "KANNA_TRANSFER_PEER_ID",
  "KANNA_TRANSFER_REGISTRY_DIR",
] as const;

interface TransferDependencies {
  tasks: Pick<TasksApi, "createItem" | "closeTask" | "importRepo">;
  queries: Pick<QueriesApi, "reloadSnapshot">;
  sessions: Pick<SessionsApi, "waitForSessionExit">;
}

export interface PushTaskTransferOptions {
  transport?: "lan" | "cloud";
  cloudFallback?: boolean;
  targetDesktopId?: string | null;
}

export class RetryableTaskPushError extends Error {
  readonly retryableTaskPush = true;
}

export function isRetryableTaskPushError(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { retryableTaskPush?: unknown }).retryableTaskPush === true;
}

export interface IncomingTransferOwnership {
  signal?: AbortSignal;
  assertOwnership?: (phase: string) => Promise<boolean>;
}

export interface TransferLifecycleOwnership {
  deliveryId?: string;
  consumerIncarnation?: string;
  assertOwnership?: (phase: string) => Promise<void>;
  claimPhase?: (phase: string) => Promise<boolean>;
}

export interface TransferApi {
  pushTaskToPeer: (
    taskId: string,
    peerId: string,
    options?: PushTaskTransferOptions,
  ) => Promise<void>;
  recordIncomingTransfer: (request: IncomingTransferRequest) => Promise<void>;
  finalizeOutgoingTransfer: (
    transferId: string,
    ownership?: TransferLifecycleOwnership,
  ) => Promise<FinalizedOutgoingTransferResult>;
  approveIncomingTransfer: (
    transferId: string,
    ownerToken?: string,
    ownership?: IncomingTransferOwnership,
  ) => Promise<string>;
  rejectIncomingTransfer: (transferId: string) => Promise<void>;
  handleOutgoingTransferCommitted: (
    event: OutgoingTransferCommittedEvent,
    ownership?: TransferLifecycleOwnership,
  ) => Promise<void>;
}

/**
 * Ownership loss means another renderer may still be driving this delivery, so
 * it is never grounds for declaring the transfer failed.
 */
function isLifecycleOwnershipLossError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("lifecycle delivery ownership was lost");
}

function isDuplicateTaskTransferError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: task_transfer.id");
}

function isPreflightConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "i/o error:",
    "peer not found:",
    "timed out after",
    "connection refused",
    "connection reset",
    "connection closed",
    "no route to host",
    "network is unreachable",
    "broken pipe",
  ].some((fragment) => message.toLowerCase().includes(fragment));
}

function applyWorktreeProcessIsolation(env: Record<string, string>): Record<string, string> {
  for (const key of INSTANCE_SCOPED_WORKTREE_ENV_KEYS) {
    env[key] = "";
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizeTransferRepoName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "repo";
  const sanitized = trimmed.replace(/[\\/]/g, "-");
  return sanitized.length > 0 ? sanitized : "repo";
}

function normalizeTransferRepoRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildTransferBundlePath(transferId: string): string {
  return `/tmp/kanna-transfer-${transferId}.bundle`;
}

function buildTransferBundleArtifactId(transferId: string): string {
  return `${transferId}-repo-bundle`;
}

function buildCodexRolloutArtifactId(transferId: string): string {
  return `${transferId}-codex-rollout`;
}

function buildClaudeSessionArtifactId(transferId: string): string {
  return `${transferId}-claude-session`;
}

function buildClaudeTranscriptArtifactId(transferId: string): string {
  return `${transferId}-claude-transcript`;
}

function buildCopilotSessionArtifactId(transferId: string): string {
  return `${transferId}-copilot-session`;
}

function buildOpencodeSessionArtifactId(transferId: string): string {
  return `${transferId}-opencode-session`;
}

/**
 * Where an OpenCode export is written before it is staged.
 *
 * Deliberately short, and unique by randomness rather than by naming the
 * transfer: a staged `owned` artifact is stored under
 * `<artifact-id>-<basename>` on the source and then fetched into
 * `<artifact-id>-<that name>` on the receiver, so the artifact id is spent
 * twice and a descriptive basename pushes the receiver's filename past the
 * 255-byte limit — which surfaces only as `File name too long` mid-transfer.
 */
function buildOpencodeExportPath(): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return `/tmp/kanna-oc-session-${nonce}.json`;
}

async function destinationTaskIdForTransfer(transferId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`kanna-transfer-destination:${transferId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildTransferArchivePath(
  transferId: string,
  suffix: string,
  deliveryId?: string,
): string {
  const deliverySuffix = deliveryId
    ? `-${deliveryId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    : "";
  return `/tmp/kanna-transfer-${transferId}-${suffix}${deliverySuffix}.tar.gz`;
}

function normalizeTransferRefName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("refs/")) return ref;
  return `refs/heads/${ref}`;
}

function buildTransferBundleRefs(item: PipelineItem): string[] {
  const taskRef = normalizeTransferRefName(item.branch);
  if (taskRef) return [taskRef];

  const baseRef = normalizeTransferRefName(item.base_ref);
  return baseRef ? [baseRef] : [];
}

async function listDirectoryNames(path: string): Promise<string[]> {
  return invoke<string[]>("list_dir", { path }).catch((error) => {
    console.debug("[store] failed to list directory names:", { path, error });
    return [];
  });
}

interface LocatedTransferArtifact {
  absolutePath: string;
  homeRelPath: string;
  filename: string;
}

interface SessionArchiveConfig {
  provider: "claude" | "copilot";
  sourceRootRelativePath: string;
  archiveSuffix: string;
  label: string;
  archiveFilename: string;
  artifactId: (transferId: string) => string;
}

const SESSION_ARCHIVE_CONFIGS: readonly SessionArchiveConfig[] = [
  {
    provider: "claude",
    sourceRootRelativePath: ".claude/tasks",
    archiveSuffix: "claude-session",
    label: "Claude",
    archiveFilename: "claude-session.tar.gz",
    artifactId: buildClaudeSessionArtifactId,
  },
  {
    provider: "copilot",
    sourceRootRelativePath: ".copilot/session-state",
    archiveSuffix: "copilot-session",
    label: "Copilot",
    archiveFilename: "copilot-session.tar.gz",
    artifactId: buildCopilotSessionArtifactId,
  },
];

function taskWorktreePath(repoPath: string, branch: string | null): string | null {
  return branch ? `${repoPath}/.kanna-worktrees/${branch}` : null;
}

/**
 * Claude transcripts are keyed by the session's working directory — the task's
 * worktree — not by the session id alone, so the lookup runs in Rust where the
 * slug derivation and path canonicalization are shared with the receiver.
 */
async function findClaudeTranscriptArtifact(
  worktreePath: string,
  sessionId: string,
): Promise<LocatedTransferArtifact | null> {
  const located = await invoke<{
    absolutePath: string;
    homeRelPath: string;
    filename: string;
  } | null>("locate_claude_transcript", { worktreePath, sessionId })
    .catch((error: unknown) => {
      // A lookup that *failed* is not a transcript that is absent, so it must
      // not be flattened into `null` — the planner would then report a missing
      // conversation for what is really a broken lookup.
      console.error("[store] failed to locate the claude session transcript:", error);
      throw error;
    });
  if (!located) return null;
  return {
    absolutePath: located.absolutePath,
    homeRelPath: located.homeRelPath,
    filename: located.filename,
  };
}

/**
 * Marks where the session listing starts in the locator script's output. A
 * login shell may print its own banner before the script runs, so the resolved
 * worktree path is read as the last line *before* this marker rather than as
 * the first line of the output.
 */
const OPENCODE_SESSION_LIST_MARKER = "__kanna_opencode_session_list__";

interface OpencodeSessionListing {
  id: string;
  directory: string;
  updated: number;
}

function parseOpencodeSessionListings(value: unknown): OpencodeSessionListing[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const id = record.id;
    const directory = record.directory;
    if (typeof id !== "string" || typeof directory !== "string") return [];
    const updated = typeof record.updated === "number" ? record.updated : 0;
    return [{ id, directory, updated }];
  });
}

/**
 * The OpenCode session this task's agent has been talking to, or `null` when it
 * has none yet.
 *
 * Unlike every other provider Kanna resumes, OpenCode's id cannot be known
 * before the agent runs: `opencode run` has no flag that *assigns* a session id
 * (`--session` with an unknown id is "Session not found"), and the id never
 * appears in the terminal, so nothing upstream of here has it to persist. What
 * OpenCode does record is the session's working directory, and a task's
 * worktree is unique to that task — so the session is looked up by worktree at
 * transfer time, when it is guaranteed to exist.
 *
 * Scoped deliberately to the transfer path: making Kanna track OpenCode session
 * ids for every task (resume-after-restart, revisions) is a larger change than
 * shipping the conversation, and this lookup does not stand in its way.
 */
async function findOpencodeSessionId(worktreePath: string): Promise<string | null> {
  let output: string;
  try {
    output = await invoke<string>("run_script", {
      // `pwd -P`, not the worktree path as written: OpenCode records the
      // kernel-resolved cwd, and a worktree can sit under a symlinked root.
      script: `pwd -P && printf '%s\\n' ${shellQuote(OPENCODE_SESSION_LIST_MARKER)} `
        + "&& opencode session list --format json",
      cwd: worktreePath,
      env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
    });
  } catch (error) {
    // A failed lookup is not an absent session, so it must not be flattened
    // into `null` — the planner would then report "no conversation" for what is
    // really a broken CLI.
    console.error("[store] failed to list opencode sessions:", error);
    throw error;
  }

  const markerIndex = output.indexOf(`${OPENCODE_SESSION_LIST_MARKER}\n`);
  if (markerIndex < 0) {
    throw new Error("opencode session listing did not produce the expected marker");
  }
  const resolvedWorktree = output
    .slice(0, markerIndex)
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1);
  if (!resolvedWorktree) {
    throw new Error(`failed to resolve the worktree path for ${worktreePath}`);
  }
  const listingJson = output.slice(markerIndex + OPENCODE_SESSION_LIST_MARKER.length + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(listingJson);
  } catch (error) {
    throw new Error(
      `opencode session listing is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const matches = parseOpencodeSessionListings(parsed)
    .filter((session) => session.directory === resolvedWorktree)
    .sort((left, right) => right.updated - left.updated);
  const sessionId = matches[0]?.id ?? null;
  if (sessionId !== null && !isOpencodeSessionId(sessionId)) {
    throw new Error(`opencode reported an unrecognized session id: ${sessionId}`);
  }
  return sessionId;
}

async function findCodexRolloutArtifact(sessionId: string): Promise<LocatedTransferArtifact | null> {
  try {
    const home = await invoke<string>("read_env_var", { name: "HOME" });
    const sessionsRoot = `${home}/.codex/sessions`;
    const rootExists = await fileExistsSafe(sessionsRoot);
    if (!rootExists) return null;

    const years = await listDirectoryNames(sessionsRoot);
    for (const year of years) {
      const yearPath = `${sessionsRoot}/${year}`;
      const months = await listDirectoryNames(yearPath);
      for (const month of months) {
        const monthPath = `${yearPath}/${month}`;
        const days = await listDirectoryNames(monthPath);
        for (const day of days) {
          const dayPath = `${monthPath}/${day}`;
          const entries = await listDirectoryNames(dayPath);
          const fileName = entries.find((entry) => entry.endsWith(`${sessionId}.jsonl`));
          if (!fileName) continue;

          const homeRelPath = `.codex/sessions/${year}/${month}/${day}/${fileName}`;
          return {
            absolutePath: `${dayPath}/${fileName}`,
            homeRelPath,
            filename: fileName,
          };
        }
      }
    }
  } catch (error) {
    console.error("[store] failed to locate codex rollout artifact:", error);
    throw error;
  }

  return null;
}

async function waitForSessionExitWithin(
  waitForSessionExit: (sessionId: string) => Promise<void>,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    waitForSessionExit(sessionId).then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

async function stageSessionArchiveArtifact(
  transferId: string,
  sessionId: string,
  repoPath: string,
  sourceRoot: string,
  config: SessionArchiveConfig,
  ownership?: TransferLifecycleOwnership,
): Promise<TransferArtifactPayload[]> {
  const archivePath = buildTransferArchivePath(
    transferId,
    config.archiveSuffix,
    ownership?.deliveryId,
  );
  const artifactId = config.artifactId(transferId);
  let staged = false;
  try {
    await ownership?.assertOwnership?.(`${config.label} archive creation`);
    await invoke("run_script", {
      script: `tar -C ${shellQuote(sourceRoot)} -czf ${shellQuote(archivePath)} ${shellQuote(sessionId)}`,
      cwd: repoPath,
      env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
    });
    await ownership?.assertOwnership?.(`${config.label} archive staging`);
    await invoke("stage_transfer_artifact", {
      transferId,
      artifactId,
      path: archivePath,
      owned: true,
      ...(ownership?.deliveryId
        ? {
            deliveryId: ownership.deliveryId,
            consumerIncarnation: ownership.consumerIncarnation,
          }
        : {}),
    });
    staged = true;
  } finally {
    if (!staged) {
      await invoke("remove_file", { path: archivePath }).catch(() => {});
    }
  }
  return [{
    artifact_id: artifactId,
    filename: config.archiveFilename,
    provider: config.provider,
    kind: "session-archive",
    materialization: "extract-tar-gz",
    home_rel_path: `${config.sourceRootRelativePath}/${sessionId}`,
  }];
}

/**
 * Asks OpenCode for a self-contained JSON copy of one conversation and stages
 * it. `opencode export` writes the session to stdout (its progress line goes to
 * stderr), and the receiver feeds the file straight back to `opencode import`.
 */
async function stageOpencodeSessionExport(
  transferId: string,
  sessionId: string,
  worktreePath: string,
  ownership?: TransferLifecycleOwnership,
): Promise<TransferArtifactPayload[]> {
  const exportPath = buildOpencodeExportPath();
  const artifactId = buildOpencodeSessionArtifactId(transferId);
  let staged = false;
  try {
    await ownership?.assertOwnership?.("OpenCode session export");
    await invoke("run_script", {
      script: `opencode export ${shellQuote(sessionId)} > ${shellQuote(exportPath)}`,
      cwd: worktreePath,
      env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
    });
    await ownership?.assertOwnership?.("OpenCode session export staging");
    await invoke("stage_transfer_artifact", {
      transferId,
      artifactId,
      path: exportPath,
      owned: true,
      ...(ownership?.deliveryId
        ? {
            deliveryId: ownership.deliveryId,
            consumerIncarnation: ownership.consumerIncarnation,
          }
        : {}),
    });
    staged = true;
  } finally {
    if (!staged) {
      await invoke("remove_file", { path: exportPath }).catch(() => {});
    }
  }
  return [{
    artifact_id: artifactId,
    filename: OPENCODE_SESSION_EXPORT_FILENAME,
    provider: "opencode",
    kind: "session-export",
    materialization: "opencode-import",
    home_rel_path: OPENCODE_SESSION_DATA_DIR_HOME_REL_PATH,
  }];
}

interface PlannedSessionFileArtifact {
  located: LocatedTransferArtifact;
  kind: Extract<TransferArtifactKind, "session-transcript" | "session-rollout">;
  provider: NonNullable<PipelineItem["agent_provider"]>;
  label: string;
  artifactId: (transferId: string) => string;
}

/**
 * Everything a transfer of this task will ship, located but not yet staged.
 *
 * Locating is separated from staging so the source can prove it *can* ship the
 * conversation before it does anything destructive to the live session. A
 * transfer that cannot must fail with the source task still running.
 */
interface PlannedSessionArtifacts {
  sessionId: string;
  archive: { config: SessionArchiveConfig; sourceRoot: string } | null;
  files: PlannedSessionFileArtifact[];
  /**
   * OpenCode's conversation is not a file on disk — it lives in a shared SQLite
   * store — so it is staged by asking the CLI to export it rather than by
   * locating a path. Carries the worktree the export runs in.
   */
  opencodeExport: { worktreePath: string } | null;
}

/**
 * The task identity a plan was located against; a change invalidates it.
 *
 * JSON-encoded rather than joined on a separator: the value is only ever
 * compared, never parsed, and encoding is the one form no component's own
 * content can forge a match through - `agent_type` carries a repo-supplied
 * agent name, so no single character is provably absent from it. The string is
 * in-memory only: it is compared within one finalization and never persisted
 * or sent.
 */
function sessionPlanIdentity(item: PipelineItem): string {
  return JSON.stringify([
    item.agent_session_id,
    item.agent_provider,
    item.agent_type,
    item.branch,
  ]);
}

async function planTransferredSessionArtifacts(
  item: PipelineItem,
  repoPath: string,
): Promise<PlannedSessionArtifacts | null> {
  const provider = item.agent_provider;
  if (!provider) return null;
  if (provider === "opencode") {
    return await planOpencodeSessionExport(item, repoPath);
  }
  const sessionId = item.agent_session_id;
  if (!sessionId) return null;
  const requiredKind = requiredSessionArtifactKind({
    agentType: item.agent_type,
    agentProvider: provider,
    resumeSessionId: sessionId,
  });

  const missing = (detail: string): MissingTransferSessionArtifactError =>
    new MissingTransferSessionArtifactError(
      `task ${item.id} resumes ${provider} session ${sessionId} but ${detail}`,
    );

  if (provider === "codex") {
    const rollout = await findCodexRolloutArtifact(sessionId);
    if (!rollout) {
      if (requiredKind) throw missing("its rollout could not be found under ~/.codex/sessions");
      return null;
    }
    return {
      sessionId,
      archive: null,
      files: [{
        located: rollout,
        kind: "session-rollout",
        provider: "codex",
        label: "Codex rollout",
        artifactId: buildCodexRolloutArtifactId,
      }],
      opencodeExport: null,
    };
  }

  const config = SESSION_ARCHIVE_CONFIGS.find((candidate) => candidate.provider === provider);
  if (!config) {
    // No transferable session state exists for this provider at all, so an
    // empty artifact list is the truth rather than a silent drop.
    return null;
  }

  const home = await invoke<string>("read_env_var", { name: "HOME" });
  const sourceRoot = `${home}/${config.sourceRootRelativePath}`;
  const archiveExists = await fileExistsSafe(`${sourceRoot}/${sessionId}`);
  const files: PlannedSessionFileArtifact[] = [];

  if (provider === "claude") {
    // The `~/.claude/tasks/<id>` archive holds only lock and highwatermark
    // state. The conversation itself lives in the cwd-keyed transcript, so
    // ship it alongside — neither one is sufficient on its own.
    const worktreePath = taskWorktreePath(repoPath, item.branch);
    const transcript = worktreePath
      ? await findClaudeTranscriptArtifact(worktreePath, sessionId)
      : null;
    if (transcript) {
      files.push({
        located: transcript,
        kind: "session-transcript",
        provider: "claude",
        label: "Claude transcript",
        artifactId: buildClaudeTranscriptArtifactId,
      });
    } else if (requiredKind === "session-transcript") {
      throw missing(
        worktreePath
          ? `no transcript exists for its worktree ${worktreePath}`
          : "it has no worktree to derive a transcript path from",
      );
    }
  }

  if (!archiveExists) {
    if (requiredKind === "session-archive") {
      throw missing(`its session state is missing from ${sourceRoot}`);
    }
    return files.length > 0 ? { sessionId, archive: null, files, opencodeExport: null } : null;
  }

  return { sessionId, archive: { config, sourceRoot }, files, opencodeExport: null };
}

/**
 * OpenCode's half of the plan: find the session this worktree has been talking
 * to, and promise to export it.
 *
 * The absence of a session is a legitimate absence — the agent never got a turn
 * in — and is reported as "nothing to ship". Once a session *does* exist, the
 * export is required: shipping a resume id with no conversation behind it is
 * the exact shape that lost 2.1 MB of Claude transcript.
 */
async function planOpencodeSessionExport(
  item: PipelineItem,
  repoPath: string,
): Promise<PlannedSessionArtifacts | null> {
  if (item.agent_type !== "pty") return null;
  const worktreePath = taskWorktreePath(repoPath, item.branch);
  if (!worktreePath) return null;
  const worktreeExists = await fileExistsSafe(worktreePath);
  if (!worktreeExists) return null;

  const sessionId = await findOpencodeSessionId(worktreePath);
  if (!sessionId) return null;
  return { sessionId, archive: null, files: [], opencodeExport: { worktreePath } };
}

async function stagePlannedSessionArtifacts(
  transferId: string,
  plan: PlannedSessionArtifacts,
  repoPath: string,
  ownership?: TransferLifecycleOwnership,
): Promise<TransferArtifactPayload[]> {
  if (plan.opencodeExport) {
    return await stageOpencodeSessionExport(
      transferId,
      plan.sessionId,
      plan.opencodeExport.worktreePath,
      ownership,
    );
  }

  const artifacts: TransferArtifactPayload[] = plan.archive
    ? await stageSessionArchiveArtifact(
        transferId,
        plan.sessionId,
        repoPath,
        plan.archive.sourceRoot,
        plan.archive.config,
        ownership,
      )
    : [];

  for (const file of plan.files) {
    const artifactId = file.artifactId(transferId);
    await ownership?.assertOwnership?.(`${file.label} staging`);
    await invoke("stage_transfer_artifact", {
      transferId,
      artifactId,
      path: file.located.absolutePath,
      owned: false,
      ...(ownership?.deliveryId
        ? {
            deliveryId: ownership.deliveryId,
            consumerIncarnation: ownership.consumerIncarnation,
          }
        : {}),
    });
    artifacts.push({
      artifact_id: artifactId,
      filename: file.located.filename,
      provider: file.provider,
      kind: file.kind,
      materialization: "copy-file",
      home_rel_path: file.located.homeRelPath,
    });
  }

  return artifacts;
}

async function stageTransferredSessionArtifacts(
  transferId: string,
  item: PipelineItem,
  repoPath: string,
  ownership?: TransferLifecycleOwnership,
): Promise<{ artifacts: TransferArtifactPayload[]; sessionId: string | null }> {
  const plan = await planTransferredSessionArtifacts(item, repoPath);
  if (!plan) return { artifacts: [], sessionId: null };
  return {
    artifacts: await stagePlannedSessionArtifacts(transferId, plan, repoPath, ownership),
    sessionId: plan.sessionId,
  };
}

/**
 * Replays a shipped OpenCode conversation into this machine's session store.
 *
 * `opencode import` keeps the session's id and re-keys it to the directory the
 * import runs in, which is why it must run in the destination worktree: OpenCode
 * resumes by matching the session's recorded directory against the current
 * working directory, and `opencode run --session <id>` from anywhere else is a
 * *silent* no-op — the same failure shape as the transcript loss this whole
 * artifact contract exists to stop.
 *
 * The worktree is created here rather than waited for: the destination task —
 * and therefore its worktree path — is deterministic before creation, but the
 * checkout only happens once the task is created, which is after the agent
 * would need the session. `git worktree add` accepts an existing empty
 * directory, so claiming the path early costs nothing and a failed import
 * leaves only an empty directory behind.
 */
async function importOpencodeSessionExport(
  exportPath: string,
  resumeSessionId: string,
  destinationWorktreePath: string,
): Promise<void> {
  if (!isOpencodeSessionId(resumeSessionId)) {
    throw new Error(`incoming transfer resume id is not an OpenCode session id: ${resumeSessionId}`);
  }
  await invoke("ensure_directory", { path: destinationWorktreePath });
  await invoke("run_script", {
    script: `opencode import ${shellQuote(exportPath)}`,
    cwd: destinationWorktreePath,
    env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
  });
}

async function importTransferredResumeState(
  transferId: string,
  payload: OutgoingTransferPayload,
  destinationWorktreePath: string,
): Promise<string | null> {
  const resumeSessionId = payload.task.resume_session_id ?? null;
  const provider = payload.task.agent_provider;
  if (!provider || !resumeSessionId) {
    return resumeSessionId;
  }

  const requiredKind = requiredSessionArtifactKind({
    agentType: payload.task.agent_type,
    agentProvider: provider,
    resumeSessionId,
  });
  const artifacts = payload.artifacts?.filter((candidate) => candidate.provider === provider) ?? [];
  // A payload that promises a resumable session and ships no way to resume it
  // must not be imported: minting a fresh session here is what silently left
  // the conversation behind on the source machine.
  if (requiredKind && !artifacts.some((candidate) => candidate.kind === requiredKind)) {
    throw new MissingTransferSessionArtifactError(
      `incoming transfer ${transferId} resumes ${provider} session ${resumeSessionId} `
      + `but carries no ${requiredKind} artifact`,
    );
  }
  if (artifacts.length === 0) return null;

  try {
    const materialized = new Map<string, boolean>();
    for (const artifact of artifacts) {
      const fetched = await invoke<{ path: string }>("fetch_transfer_artifact", {
        transferId,
        artifactId: artifact.artifact_id,
      });
      if (artifact.materialization === "opencode-import") {
        await importOpencodeSessionExport(
          fetched.path,
          resumeSessionId,
          destinationWorktreePath,
        );
        materialized.set(artifact.artifact_id, true);
        continue;
      }
      materialized.set(
        artifact.artifact_id,
        await invoke<boolean>("materialize_transfer_artifact", {
          sourcePath: fetched.path,
          provider,
          resumeSessionId,
          filename: artifact.filename,
          kind: artifact.kind,
          materialization: artifact.materialization,
          // A Claude transcript is cwd-keyed, so only the receiver can name
          // where it lands. The sender never supplies a destination path.
          ...(artifact.kind === "session-transcript" ? { destinationWorktreePath } : {}),
        }),
      );
    }

    // An already-present destination only means "abandon the resume" when it
    // means the conversation state could not be established at all. The
    // transcript is the conversation, so it decides when one shipped; a
    // pre-existing `~/.claude/tasks/<id>` lock directory must not veto it.
    const decisive = artifacts.find((candidate) => candidate.kind === "session-transcript")
      ?? artifacts.find((candidate) => candidate.kind === "session-export")
      ?? artifacts.find((candidate) => candidate.kind === "session-archive")
      ?? artifacts[0]!;
    if (decisive.kind === "session-archive" && !materialized.get(decisive.artifact_id)) {
      console.warn(
        "[store] skipping transferred session import because the provider destination already exists",
        { provider, resumeSessionId },
      );
      return null;
    }
    return resumeSessionId;
  } catch (error) {
    console.error("[store] failed to import transferred session artifact:", error);
    throw error;
  }
}

function assertIncomingPayloadMatchesTransfer(
  transfer: {
    id: string;
    source_peer_id: string | null;
    source_task_id: string | null;
  },
  payload: OutgoingTransferPayload,
): void {
  if (
    !transfer.source_peer_id
    || !transfer.source_task_id
    || payload.task.source_peer_id !== transfer.source_peer_id
    || payload.task.source_task_id !== transfer.source_task_id
  ) {
    throw new Error(
      `incoming transfer payload source identity does not match reservation: ${transfer.id}`,
    );
  }
}

export function createTransferApi(
  context: StoreContext,
  { tasks, queries, sessions }: TransferDependencies,
): TransferApi {
  const outgoingPushesInFlight = new Set<string>();
  const outgoingPushesDurablyStarted = new Set<string>();
  async function allocateTransferredRepoPath(repoName: string): Promise<string> {
    const home = await invoke<string>("read_env_var", { name: "HOME" });
    const parentDir = defaultReposHome(home);
    await invoke("ensure_directory", { path: parentDir });

    const base = sanitizeTransferRepoName(repoName);
    let candidate = `${parentDir}/${base}`;
    let exists = await fileExistsSafe(candidate);
    if (!exists) return candidate;

    for (let index = 2; index <= 99; index += 1) {
      candidate = `${parentDir}/${base}-${index}`;
      exists = await fileExistsSafe(candidate);
      if (!exists) return candidate;
    }

    return `${parentDir}/${base}-${Date.now()}`;
  }

  async function findIncomingTransferRepoMatch(
    payload: OutgoingTransferPayload,
  ): Promise<Repo | null> {
    const repos = context.state.repos.value;
    const normalizedRemoteUrl = normalizeTransferRepoRemote(payload.repo.remote_url);

    if (normalizedRemoteUrl) {
      for (const repo of repos) {
        const remoteUrl = await invoke<string | null>("git_remote_url", {
          repoPath: repo.path,
        }).catch((error) => {
          console.debug("[store] failed to read repo remote URL while matching incoming transfer:", error);
          return null;
        });
        if (normalizeTransferRepoRemote(remoteUrl) === normalizedRemoteUrl) {
          return repo;
        }
      }
    }

    const repoPath = payload.repo.path;
    if (repoPath) {
      return repos.find((repo) => repo.path === repoPath) ?? null;
    }

    return null;
  }

  async function ensureIncomingTransferRepo(
    transferId: string,
    payload: OutgoingTransferPayload,
  ): Promise<{ repoId: string; repoPath: string }> {
    const repoName = payload.repo.name ?? "repo";
    const defaultBranch = payload.repo.default_branch ?? "main";
    const existingRepo = await findIncomingTransferRepoMatch(payload);

    if (existingRepo) {
      const repoId = await tasks.importRepo(
        existingRepo.path,
        existingRepo.name,
        existingRepo.default_branch,
      );
      return { repoId, repoPath: existingRepo.path };
    }

    if (payload.repo.mode === "reuse-local") {
      const repoPath = payload.repo.path;
      if (!repoPath) {
        throw new Error("incoming transfer payload is missing a local repo path");
      }

      const repoExists = await invoke<boolean>("file_exists", { path: repoPath });
      if (!repoExists) {
        throw new Error(`incoming transfer repo path does not exist: ${repoPath}`);
      }

      const repoId = await tasks.importRepo(repoPath, repoName, defaultBranch);
      return { repoId, repoPath };
    }

    if (payload.repo.mode === "clone-remote") {
      if (!payload.repo.remote_url) {
        throw new Error("incoming transfer payload is missing a remote URL");
      }

      const repoPath = await allocateTransferredRepoPath(repoName);
      await invoke("git_clone", {
        url: payload.repo.remote_url,
        destination: repoPath,
      });
      const repoId = await tasks.importRepo(repoPath, repoName, defaultBranch);
      return { repoId, repoPath };
    }

    if (payload.repo.mode === "bundle-repo") {
      const artifactId = payload.repo.bundle?.artifact_id;
      if (!artifactId) {
        throw new Error("incoming transfer payload is missing bundle metadata");
      }

      const fetched = await invoke<{ path: string }>("fetch_transfer_artifact", {
        transferId,
        artifactId,
      });
      const repoPath = await allocateTransferredRepoPath(repoName);
      await invoke("git_init", { path: repoPath });
      const checkoutRef =
        payload.repo.bundle?.ref_name
        ?? normalizeTransferRefName(payload.task.branch)
        ?? normalizeTransferRefName(payload.task.base_ref)
        ?? "HEAD";
      await invoke("run_script", {
        script: `git fetch ${shellQuote(fetched.path)} '+refs/*:refs/*' && git checkout ${shellQuote(checkoutRef)}`,
        cwd: repoPath,
        env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
      });
      const repoId = await tasks.importRepo(repoPath, repoName, defaultBranch);
      return { repoId, repoPath };
    }

    throw new Error(`unsupported repo acquisition mode: ${payload.repo.mode satisfies never}`);
  }

  /**
   * Hands a never-to-be-committed preflight reservation back to the sidecar.
   *
   * The reservation is durable (registry dir) and may already own staged
   * artifacts, so failing to release it leaks disk state. A release that itself
   * fails is reported rather than swallowed: the reservation is then genuinely
   * orphaned, and the operator is the only one who can tell.
   */
  async function releaseOutgoingTransferReservation(transferId: string): Promise<void> {
    try {
      await invoke("abandon_outgoing_transfer", { transferId });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[store] failed to release abandoned transfer reservation ${transferId}:`,
        error,
      );
      context.toast.warning(
        `${context.tt("toasts.transferReservationOrphaned")}: ${transferId} (${reason})`,
      );
    }
  }

  /**
   * A push for a task that already has a transfer in flight is a duplicate
   * delivery, not an error: the earlier push owns the transfer and this one has
   * nothing left to do. Resolving (rather than throwing) is what keeps the pull
   * requester's retry loop from treating the race as a dropped delivery.
   */
  async function pushTaskToPeer(
    taskId: string,
    peerId: string,
    options: PushTaskTransferOptions = {},
  ): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) {
      throw new Error(`task not found: ${taskId}`);
    }
    if (item.closed_at != null) {
      throw new Error(`task is closed: ${taskId}`);
    }
    if (
      ["pending", "claimed", "streaming", "importing", "awaiting_acknowledgment"].includes(
        item.transfer_status ?? "",
      )
      || outgoingPushesInFlight.has(taskId)
      || outgoingPushesDurablyStarted.has(taskId)
    ) {
      console.debug(`[store] task already transferring, skipping duplicate push: ${taskId}`);
      return;
    }

    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
    if (!repo) {
      throw new Error(`repo not found for task: ${taskId}`);
    }

    // The snapshot guards above only see this renderer's last reload; the DB is
    // the one place that knows about a push another delivery — or another run
    // of this app — already started.
    const activeTransfer = await fetchActiveOutgoingTaskTransfer(taskId);
    if (activeTransfer) {
      console.debug(
        `[store] task already has an active outgoing transfer ${activeTransfer.id}, skipping duplicate push: ${taskId}`,
      );
      return;
    }

    outgoingPushesInFlight.add(taskId);
    try {
      const sourceDesktopId = options.targetDesktopId
        ? await invoke<{ desktopId?: string }>("mobile_server_status")
          .then((status) => status.desktopId?.trim() || null)
          .catch(() => null)
        : null;
      if (options.targetDesktopId && !sourceDesktopId) {
        throw new RetryableTaskPushError(
          "source desktop identity is unavailable for cloud transfer",
        );
      }
      const preflightPayload = (transport?: "lan" | "cloud") => ({
        phase: "preflight",
        sourceTaskId: taskId,
        targetPeerId: peerId,
        ...(transport ? { transport } : {}),
      });
      let preflightRaw: unknown;
      try {
        preflightRaw = await invoke<unknown>("prepare_outgoing_transfer", {
          payload: preflightPayload(options.transport),
        });
      } catch (error: unknown) {
        if (
          options.transport !== "lan"
          || !options.cloudFallback
          || !isPreflightConnectionFailure(error)
        ) {
          throw error;
        }
        preflightRaw = await invoke<unknown>("prepare_outgoing_transfer", {
          payload: preflightPayload("cloud"),
        });
      }
      const preflight = parseOutgoingTransferPreflightResult(preflightRaw);

      const recovery = await loadSessionRecoveryState(taskId);
      const repoRemoteUrl = preflight.targetHasRepo
        ? null
        : await invoke<string | null>("git_remote_url", {
            repoPath: repo.path,
          }).catch((error) => {
            console.debug("[store] failed to read repo remote URL while preparing transfer:", error);
            return null;
          });
      let bundle: {
        artifactId: string;
        filename: string;
        refName: string | null;
      } | null = null;
      if (!preflight.targetHasRepo && !repoRemoteUrl) {
        const bundlePath = buildTransferBundlePath(preflight.transferId);
        const artifactId = buildTransferBundleArtifactId(preflight.transferId);
        const refName =
          normalizeTransferRefName(item.branch) ?? normalizeTransferRefName(item.base_ref);
        const refs = buildTransferBundleRefs(item);
        const bundleTargets =
          refs.length > 0 ? refs.map((ref) => shellQuote(ref)).join(" ") : "--all";

        await invoke("run_script", {
          script: `git bundle create ${shellQuote(bundlePath)} ${bundleTargets}`,
          cwd: repo.path,
          env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
        });
        await invoke("stage_transfer_artifact", {
          transferId: preflight.transferId,
          artifactId,
          path: bundlePath,
          owned: true,
        });
        bundle = {
          artifactId,
          filename: `${preflight.transferId}.bundle`,
          refName,
        };
      }

      const { artifacts, sessionId } = await stageTransferredSessionArtifacts(
        preflight.transferId,
        item,
        repo.path,
      );
      const payload = buildOutgoingTransferPayload({
        sourcePeerId: preflight.sourcePeerId,
        sourceDesktopId,
        sourceTaskId: taskId,
        targetPeerId: peerId,
        targetDesktopId: options.targetDesktopId,
        item,
        resumeSessionId: sessionId,
        repoPath: repo.path,
        repoName: repo.name,
        repoDefaultBranch: repo.default_branch,
        repoRemoteUrl,
        recovery,
        artifacts,
        targetHasRepo: preflight.targetHasRepo,
        bundle,
      });

      try {
        await insertDesktopTaskTransfer({
          id: preflight.transferId,
          direction: "outgoing",
          status: "pending",
          source_peer_id: preflight.sourcePeerId,
          target_peer_id: peerId,
          source_desktop_id: payload.task.source_desktop_id,
          target_desktop_id: payload.target_desktop_id,
          source_task_id: taskId,
          local_task_id: taskId,
          error: null,
          payload_json: JSON.stringify(payload),
        });
      } catch (error: unknown) {
        if (!isActiveOutgoingTransferConflict(error)) throw error;
        // Another push won the race between the DB read above and this insert.
        // This one's preflight already reserved sidecar state and staged
        // artifacts, so release them here — an abandoned reservation otherwise
        // sits in the registry dir until the TTL sweeper notices.
        console.warn(
          `[store] outgoing transfer already in flight for ${taskId}; releasing duplicate reservation ${preflight.transferId}`,
        );
        await releaseOutgoingTransferReservation(preflight.transferId);
        await queries.reloadSnapshot();
        return;
      }
      outgoingPushesDurablyStarted.add(taskId);

      await invoke("prepare_outgoing_transfer", {
        payload: {
          phase: "commit",
          transferId: preflight.transferId,
          payload,
        },
      });
      await queries.reloadSnapshot();
    } finally {
      outgoingPushesInFlight.delete(taskId);
    }
  }

  async function recordIncomingTransfer(request: IncomingTransferRequest): Promise<void> {
    try {
      await insertDesktopTaskTransfer({
        id: request.transferId,
        direction: "incoming",
        status: "pending",
        source_peer_id: request.sourcePeerId,
        target_peer_id: null,
        source_desktop_id: request.payload.task.source_desktop_id,
        target_desktop_id: request.payload.target_desktop_id,
        source_task_id: request.sourceTaskId,
        local_task_id: null,
        error: null,
        payload_json: JSON.stringify(request.payload),
      });
    } catch (error) {
      if (!isDuplicateTaskTransferError(error)) {
        throw error;
      }
    }
    await queries.reloadSnapshot();
  }

  /**
   * A finalization that cannot honour the payload it is about to write fails
   * the transfer instead of shipping whatever happened to be on disk. The
   * source task is deliberately left alone: losing the transfer is recoverable,
   * losing the conversation is not.
   */
  async function finalizeOutgoingTransfer(
    transferId: string,
    ownership: TransferLifecycleOwnership = {},
  ): Promise<FinalizedOutgoingTransferResult> {
    try {
      return await runOutgoingTransferFinalization(transferId, ownership);
    } catch (error: unknown) {
      console.error("[store] outgoing transfer finalization failed:", error);
      if (isLifecycleOwnershipLossError(error)) {
        // Another consumer may still own and complete this delivery, so its
        // transfer is not ours to declare dead.
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await failOutgoingTaskTransfer(transferId, reason).catch((failError: unknown) => {
        console.error("[store] failed to mark the outgoing transfer failed:", failError);
      });
      context.toast.error(`${context.tt("toasts.transferFinalizationFailed")}: ${reason}`);
      await queries.reloadSnapshot().catch((reloadError: unknown) => {
        console.error("[store] failed to refresh after an outgoing transfer failure:", reloadError);
      });
      throw error;
    }
  }

  async function runOutgoingTransferFinalization(
    transferId: string,
    ownership: TransferLifecycleOwnership,
  ): Promise<FinalizedOutgoingTransferResult> {
    const transfer = await getDesktopTaskTransfer(transferId);
    if (!transfer) {
      throw new Error(`outgoing transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "outgoing") {
      throw new Error(`transfer is not outgoing: ${transferId}`);
    }

    const existingPayload = parsePersistedOutgoingTransferPayload(transfer.payload_json);
    const localTaskId = transfer.local_task_id;
    if (!localTaskId) {
      throw new Error(`outgoing transfer has no local task: ${transferId}`);
    }

    const item = context.state.items.value.find((candidate) => candidate.id === localTaskId);
    if (!item) {
      throw new Error(`source task not found for outgoing transfer: ${transferId}`);
    }

    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
    if (!repo) {
      throw new Error(`repo not found for outgoing transfer: ${transferId}`);
    }

    // Locate the session state this payload will promise *before* signalling
    // the agent: a transfer that cannot ship the conversation must fail with
    // the source task still alive and running, not after it has been shut down.
    const plannedIdentity = sessionPlanIdentity(item);
    const plan = await planTransferredSessionArtifacts(item, repo.path);

    let finalizedCleanly = item.agent_type !== "pty";
    let degradedReason: string | null = null;
    if (item.agent_type === "pty") {
      await ownership.assertOwnership?.("PTY finalization signal");
      const shouldSignal = ownership.claimPhase
        ? await ownership.claimPhase("pty-finalization-signal")
        : true;
      let signalFailure: string | null = null;
      if (shouldSignal) {
        await invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((error: unknown) => {
          // The daemon refuses signals for adopted sessions by design — every
          // session older than the running daemon, so every task predating an
          // app upgrade. Too common to fail the transfer over, too important
          // to swallow: it degrades the transfer instead.
          console.error("[store] transfer finalization signal failed:", error);
          signalFailure = error instanceof Error ? error.message : String(error);
        });
      }
      const exited = await waitForSessionExitWithin(
        sessions.waitForSessionExit,
        item.id,
        TRANSFER_SOURCE_FINALIZATION_WAIT_MS,
      );
      finalizedCleanly = exited && signalFailure === null;
      if (signalFailure !== null) {
        degradedReason =
          `the source agent session could not be signalled to finish: ${String(signalFailure)}`;
      } else if (!exited) {
        degradedReason =
          `the source agent session did not exit within ${TRANSFER_SOURCE_FINALIZATION_WAIT_MS}ms`;
      }
    }

    await ownership.assertOwnership?.("finalization snapshot refresh");
    await queries.reloadSnapshot();
    const refreshedItem = context.state.items.value.find((candidate) => candidate.id === item.id) ?? item;
    const repoRemoteUrl = existingPayload.repo.mode === "reuse-local"
      ? null
      : await invoke<string | null>("git_remote_url", {
          repoPath: repo.path,
        }).catch(() => existingPayload.repo.remote_url);
    const bundle = existingPayload.repo.bundle
      ? {
          artifactId: existingPayload.repo.bundle.artifact_id,
          filename: existingPayload.repo.bundle.filename,
          refName: existingPayload.repo.bundle.ref_name,
        }
      : null;
    const sourcePeerId = transfer.source_peer_id ?? existingPayload.task.source_peer_id;
    const sourceTaskId = transfer.source_task_id ?? existingPayload.task.source_task_id;
    const finalization: TransferFinalizationState = {
      cleanly_finalized: finalizedCleanly,
      degraded_reason: degradedReason,
    };
    // The plan was located against the pre-signal task; re-plan only if the
    // session identity moved under us while the agent was shutting down.
    const finalPlan = sessionPlanIdentity(refreshedItem) === plannedIdentity
      ? plan
      : await planTransferredSessionArtifacts(refreshedItem, repo.path);
    const artifacts = finalPlan
      ? await stagePlannedSessionArtifacts(transferId, finalPlan, repo.path, ownership)
      : [];
    const payload = buildOutgoingTransferPayload({
      sourcePeerId,
      sourceDesktopId: transfer.source_desktop_id ?? existingPayload.task.source_desktop_id,
      sourceTaskId,
      targetPeerId: transfer.target_peer_id ?? existingPayload.target_peer_id,
      targetDesktopId: transfer.target_desktop_id ?? existingPayload.target_desktop_id,
      item: refreshedItem,
      resumeSessionId: finalPlan?.sessionId ?? null,
      repoPath: repo.path,
      repoName: repo.name,
      repoDefaultBranch: repo.default_branch,
      repoRemoteUrl: repoRemoteUrl ?? null,
      recovery: await loadSessionRecoveryState(item.id),
      artifacts,
      finalization,
      targetHasRepo: existingPayload.repo.mode === "reuse-local",
      bundle,
    });

    await ownership.assertOwnership?.("finalized payload persistence");
    await updateDesktopTaskTransferPayload(transferId, JSON.stringify(payload));
    await queries.reloadSnapshot();

    if (degradedReason) {
      // Persisted on the payload above and surfaced here — a degraded handoff
      // that only reached console.error is how the last one went unnoticed.
      context.toast.warning(
        `${context.tt("toasts.transferFinalizationDegraded")}: ${degradedReason}`,
      );
    }

    return {
      transferId,
      payload,
      finalizedCleanly,
    };
  }

  async function approveIncomingTransfer(
    transferId: string,
    ownerToken = "",
    ownership: IncomingTransferOwnership = {},
  ): Promise<string> {
    const assertOwnership = async (phase: string): Promise<void> => {
      if (ownership.signal?.aborted) {
        throw new Error(`incoming transfer ownership was lost before ${phase}: ${transferId}`);
      }
      if (ownership.assertOwnership && !await ownership.assertOwnership(phase)) {
        throw new Error(`incoming transfer ownership was lost before ${phase}: ${transferId}`);
      }
      if (ownership.signal?.aborted) {
        throw new Error(`incoming transfer ownership was lost before ${phase}: ${transferId}`);
      }
    };
    const ownershipLost = (phase: string): Error =>
      new Error(`incoming transfer ownership was lost before ${phase}: ${transferId}`);
    const runOwnedPhase = async <T>(
      phase: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      await assertOwnership(phase);
      const result = await operation();
      await assertOwnership(`${phase} completion`);
      return result;
    };

    const transfer = await getDesktopTaskTransfer(transferId);
    if (!transfer) {
      throw new Error(`incoming transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "incoming") {
      throw new Error(`transfer is not incoming: ${transferId}`);
    }
    if (!["pending", "claimed", "streaming", "importing", "awaiting_acknowledgment"].includes(transfer.status)) {
      throw new Error(`incoming transfer is not resumable: ${transferId}`);
    }

    let payload: OutgoingTransferPayload;
    let localTaskId = transfer.local_task_id;
    if (localTaskId) {
      payload = parsePersistedOutgoingTransferPayload(transfer.payload_json);
      assertIncomingPayloadMatchesTransfer(transfer, payload);
    } else {
      const finalized = parseFinalizedOutgoingTransferResult(await runOwnedPhase(
        "source finalization",
        async () => await invoke("finalize_outgoing_transfer", { transferId }),
      ));
      if (finalized.transferId !== transferId) {
        throw new Error(`finalized incoming transfer id mismatch: ${transferId}`);
      }
      payload = finalized.payload;
      assertIncomingPayloadMatchesTransfer(transfer, payload);
      if (!payload.finalization.cleanly_finalized) {
        // The source could not shut its agent down cleanly. The conversation
        // still crosses, but the operator on *this* machine has to know the
        // handoff was degraded — it is their task now.
        context.toast.warning(
          `${context.tt("toasts.transferFinalizationDegraded")}: `
          + `${payload.finalization.degraded_reason ?? context.tt("toasts.transferFinalizationUnclean")}`,
        );
      }
      if (!await updateDesktopTaskTransferPayload(
        transferId,
        JSON.stringify(payload),
        ownerToken,
      )) {
        if (ownerToken) throw ownershipLost("payload persistence");
        throw new Error(`failed to persist finalized incoming transfer payload: ${transferId}`);
      }
      const { repoId, repoPath } = await runOwnedPhase(
        "repository acquisition",
        async () => await ensureIncomingTransferRepo(transferId, payload),
      );
      // The destination task id — and therefore its worktree — is deterministic
      // before creation, which is what lets the transcript be re-keyed to the
      // destination slug before the agent spawns with `--resume`.
      const destinationTaskId = await destinationTaskIdForTransfer(transferId);
      const resumeSessionId = await runOwnedPhase(
        "artifact materialization",
        async () => await importTransferredResumeState(
          transferId,
          payload,
          `${repoPath}/.kanna-worktrees/task-${destinationTaskId}`,
        ),
      );
      localTaskId = await runOwnedPhase(
        "task creation",
        async () => await tasks.createItem(
          repoId,
          repoPath,
          payload.task.prompt ?? "",
          payload.task.agent_type === "agent" || payload.task.agent_type === "sdk" ? "agent" : "pty",
          {
            requestedTaskId: destinationTaskId,
            agentProvider: payload.task.agent_provider,
            baseBranch: resolveIncomingTransferBaseBranch(payload),
            pipelineName: payload.task.pipeline,
            stage: payload.task.stage,
            displayName: payload.task.display_name,
            resumeSessionId,
            recoverySnapshot: payload.recovery,
            transferImport: await buildTransferImportSummary(payload, resumeSessionId),
          },
        ),
      );
      if (!await markDesktopTaskTransferImporting(transferId, localTaskId, ownerToken)) {
        if (ownerToken) throw ownershipLost("import registration");
        throw new Error(`failed to claim imported task for transfer: ${transferId}`);
      }
    }

    await assertOwnership("task identity finalization");
    await setDesktopTaskCloudIdentity(localTaskId, payload.task.cloud_task_id);
    await insertDesktopTaskTransferProvenance({
      pipeline_item_id: localTaskId,
      source_peer_id: payload.task.source_peer_id,
      source_task_id: payload.task.source_task_id,
      source_machine_task_label: payload.task.branch,
    });
    if (!await markDesktopTaskTransferAwaitingAcknowledgment(transferId, localTaskId, ownerToken)) {
      if (ownerToken) throw ownershipLost("acknowledgment registration");
      throw new Error(`failed to mark incoming transfer awaiting acknowledgment: ${transferId}`);
    }
    await queries.reloadSnapshot();

    await invoke("acknowledge_incoming_transfer_commit", {
      transferId,
      sourceTaskId: payload.task.source_task_id,
      destinationLocalTaskId: localTaskId,
    });
    if (!await completeDesktopTaskTransfer(transferId, localTaskId, ownerToken)) {
      if (ownerToken) throw ownershipLost("transfer completion");
      throw new Error(`failed to complete acknowledged incoming transfer: ${transferId}`);
    }
    await invoke("mark_incoming_transfer_ack_completed", { transferId });
    if (!await markIncomingTransferSidecarCleanupCompleted(transferId)) {
      throw new Error(`failed to mark sidecar cleanup completed: ${transferId}`);
    }
    await queries.reloadSnapshot();

    return localTaskId;
  }

  async function rejectIncomingTransfer(transferId: string): Promise<void> {
    const transfer = await getDesktopTaskTransfer(transferId);
    if (!transfer) {
      throw new Error(`incoming transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "incoming") {
      throw new Error(`transfer is not incoming: ${transferId}`);
    }
    if (transfer.status !== "pending") {
      throw new Error(`incoming transfer is not pending: ${transferId}`);
    }

    if (!await rejectDesktopTaskTransfer(transferId, "Rejected locally")) {
      throw new Error(`failed to reject incoming transfer: ${transferId}`);
    }
    await invoke("mark_incoming_transfer_ack_completed", { transferId });
    if (!await markIncomingTransferSidecarCleanupCompleted(transferId)) {
      throw new Error(`failed to mark sidecar cleanup completed: ${transferId}`);
    }
    await queries.reloadSnapshot();
  }

  async function handleOutgoingTransferCommitted(
    event: OutgoingTransferCommittedEvent,
    ownership: TransferLifecycleOwnership = {},
  ): Promise<void> {
    const transfer = await getDesktopTaskTransfer(event.transferId);
    if (!transfer) {
      // The durable transfer row may already have been compacted after a
      // previously successful delivery whose sidecar response was lost.
      // Tombstone the receipt so the explicit apply/nack protocol cannot leave
      // it claimed forever or replay it after the next sidecar restart.
      await ownership.assertOwnership?.("missing-row commit tombstone");
      await invoke("mark_outgoing_transfer_commit_applied", {
        transferId: event.transferId,
        deliveryId: ownership.deliveryId,
        consumerIncarnation: ownership.consumerIncarnation,
      });
      return;
    }
    if (transfer.direction !== "outgoing") {
      throw new Error(`transfer is not outgoing: ${event.transferId}`);
    }
    if (transfer.source_task_id !== event.sourceTaskId) {
      throw new Error(
        `outgoing transfer source task mismatch for ${event.transferId}: expected ${transfer.source_task_id}, got ${event.sourceTaskId}`,
      );
    }

    await ownership.assertOwnership?.("source task closure");
    const closedNow = await tasks.closeTask(event.sourceTaskId);
    if (!closedNow) {
      const sourceIsDurablyClosed = (await fetchClosedTaskIdentities())
        .some((identity) => identity.id === event.sourceTaskId);
      if (!sourceIsDurablyClosed) {
        throw new Error(
          `failed to confirm source task closure for outgoing transfer: ${event.transferId}`,
        );
      }
    }
    await ownership.assertOwnership?.("outgoing transfer completion");
    if (!await completeDesktopTaskTransfer(
      event.transferId,
      transfer.local_task_id ?? event.sourceTaskId,
    )) {
      throw new Error(`failed to complete outgoing transfer: ${event.transferId}`);
    }
    await ownership.assertOwnership?.("outgoing commit tombstone");
    await invoke("mark_outgoing_transfer_commit_applied", {
      transferId: event.transferId,
      deliveryId: ownership.deliveryId,
      consumerIncarnation: ownership.consumerIncarnation,
    });
    await queries.reloadSnapshot();
  }

  return {
    pushTaskToPeer,
    recordIncomingTransfer,
    finalizeOutgoingTransfer,
    approveIncomingTransfer,
    rejectIncomingTransfer,
    handleOutgoingTransferCommitted,
  };
}
