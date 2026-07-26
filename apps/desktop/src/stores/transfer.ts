import type { PipelineItem, Repo } from "../types/kanna";
import {
  completeDesktopTaskTransfer,
  fetchClosedTaskIdentities,
  getDesktopTaskTransfer,
  insertDesktopTaskTransfer,
  insertDesktopTaskTransferProvenance,
  markDesktopTaskTransferAwaitingAcknowledgment,
  markDesktopTaskTransferImporting,
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
  parseFinalizedOutgoingTransferResult,
  parseOutgoingTransferPreflightResult,
  parsePersistedOutgoingTransferPayload,
  resolveIncomingTransferBaseBranch,
  type FinalizedOutgoingTransferResult,
  type IncomingTransferRequest,
  type OutgoingTransferCommittedEvent,
  type OutgoingTransferPayload,
  type TransferArtifactPayload,
} from "../utils/taskTransfer";
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

export interface TransferApi {
  pushTaskToPeer: (
    taskId: string,
    peerId: string,
    options?: PushTaskTransferOptions,
  ) => Promise<void>;
  recordIncomingTransfer: (request: IncomingTransferRequest) => Promise<void>;
  finalizeOutgoingTransfer: (transferId: string) => Promise<FinalizedOutgoingTransferResult>;
  approveIncomingTransfer: (transferId: string) => Promise<string>;
  rejectIncomingTransfer: (transferId: string) => Promise<void>;
  handleOutgoingTransferCommitted: (event: OutgoingTransferCommittedEvent) => Promise<void>;
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

function buildCopilotSessionArtifactId(transferId: string): string {
  return `${transferId}-copilot-session`;
}

async function destinationTaskIdForTransfer(transferId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`kanna-transfer-destination:${transferId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildTransferArchivePath(transferId: string, suffix: string): string {
  return `/tmp/kanna-transfer-${transferId}-${suffix}.tar.gz`;
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
  home: string,
  config: SessionArchiveConfig,
): Promise<TransferArtifactPayload[]> {
  const sourceRoot = `${home}/${config.sourceRootRelativePath}`;
  const sourceDir = `${sourceRoot}/${sessionId}`;
  const exists = await fileExistsSafe(sourceDir);
  if (!exists) return [];

  const archivePath = buildTransferArchivePath(transferId, config.archiveSuffix);
  await invoke("run_script", {
    script: `tar -C ${shellQuote(sourceRoot)} -czf ${shellQuote(archivePath)} ${shellQuote(sessionId)}`,
    cwd: repoPath,
    env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
  });
  const artifactId = config.artifactId(transferId);
  await invoke("stage_transfer_artifact", {
    transferId,
    artifactId,
    path: archivePath,
  });
  return [{
    artifact_id: artifactId,
    filename: config.archiveFilename,
    provider: config.provider,
    kind: "session-archive",
    materialization: "extract-tar-gz",
    home_rel_path: `${config.sourceRootRelativePath}/${sessionId}`,
  }];
}

async function stageTransferredSessionArtifacts(
  transferId: string,
  item: PipelineItem,
  repoPath: string,
): Promise<TransferArtifactPayload[]> {
  if (!item.agent_session_id || !item.agent_provider) {
    return [];
  }

  try {
    if (item.agent_provider === "codex") {
      const rollout = await findCodexRolloutArtifact(item.agent_session_id);
      if (!rollout) return [];

      const artifactId = buildCodexRolloutArtifactId(transferId);
      await invoke("stage_transfer_artifact", {
        transferId,
        artifactId,
        path: rollout.absolutePath,
      });
      return [{
        artifact_id: artifactId,
        filename: rollout.filename,
        provider: "codex",
        kind: "session-rollout",
        materialization: "copy-file",
        home_rel_path: rollout.homeRelPath,
      }];
    }

    const config = SESSION_ARCHIVE_CONFIGS.find((candidate) => candidate.provider === item.agent_provider);
    if (!config) return [];

    const home = await invoke<string>("read_env_var", { name: "HOME" });
    return await stageSessionArchiveArtifact(
      transferId,
      item.agent_session_id,
      repoPath,
      home,
      config,
    );
  } catch (error) {
    console.error("[store] failed to stage provider session artifacts:", error);
  }

  return [];
}

async function importTransferredResumeState(
  transferId: string,
  payload: OutgoingTransferPayload,
): Promise<string | null> {
  const resumeSessionId = payload.task.resume_session_id ?? null;
  const provider = payload.task.agent_provider;
  if (!provider || !resumeSessionId) {
    return resumeSessionId;
  }

  const artifact = payload.artifacts?.find((candidate) => candidate.provider === provider) ?? null;
  if (!artifact) return null;

  try {
    const fetched = await invoke<{ path: string }>("fetch_transfer_artifact", {
      transferId,
      artifactId: artifact.artifact_id,
    });
    const materialized = await invoke<boolean>("materialize_transfer_artifact", {
      sourcePath: fetched.path,
      provider,
      resumeSessionId,
      filename: artifact.filename,
      kind: artifact.kind,
      materialization: artifact.materialization,
    });
    if (!materialized) {
      console.warn(
        "[store] skipping transferred session import because the provider destination already exists",
        { provider, resumeSessionId },
      );
      return null;
    }
    return resumeSessionId;
  } catch (error) {
    console.error("[store] failed to import transferred session artifact:", error);
    return null;
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

  async function pushTaskToPeer(
    taskId: string,
    peerId: string,
    options: PushTaskTransferOptions = {},
  ): Promise<void> {
    const item = context.state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) {
      throw new Error(`task not found: ${taskId}`);
    }
    if (
      item.closed_at != null
      || ["pending", "streaming", "importing", "awaiting_acknowledgment"].includes(
        item.transfer_status ?? "",
      )
      || outgoingPushesInFlight.has(taskId)
      || outgoingPushesDurablyStarted.has(taskId)
    ) {
      throw new Error(`task is already transferring: ${taskId}`);
    }

    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
    if (!repo) {
      throw new Error(`repo not found for task: ${taskId}`);
    }

    outgoingPushesInFlight.add(taskId);
    try {
      const sourceDesktopId = options.targetDesktopId
        ? await invoke<{ desktopId?: string }>("mobile_server_status")
          .then((status) => status.desktopId?.trim() || null)
          .catch(() => null)
        : null;
      if (options.targetDesktopId && !sourceDesktopId) {
        throw new Error("source desktop identity is unavailable for cloud transfer");
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
        });
        bundle = {
          artifactId,
          filename: `${preflight.transferId}.bundle`,
          refName,
        };
      }

      const artifacts = await stageTransferredSessionArtifacts(
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
        repoPath: repo.path,
        repoName: repo.name,
        repoDefaultBranch: repo.default_branch,
        repoRemoteUrl,
        recovery,
        artifacts,
        targetHasRepo: preflight.targetHasRepo,
        bundle,
      });

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

  async function finalizeOutgoingTransfer(
    transferId: string,
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

    let finalizedCleanly = item.agent_type !== "pty";
    if (item.agent_type === "pty") {
      await invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((error: unknown) => {
        console.error("[store] transfer finalization signal failed:", error);
      });
      finalizedCleanly = await waitForSessionExitWithin(
        sessions.waitForSessionExit,
        item.id,
        TRANSFER_SOURCE_FINALIZATION_WAIT_MS,
      );
    }

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
    const artifacts = await stageTransferredSessionArtifacts(transferId, refreshedItem, repo.path);
    const payload = buildOutgoingTransferPayload({
      sourcePeerId,
      sourceDesktopId: transfer.source_desktop_id ?? existingPayload.task.source_desktop_id,
      sourceTaskId,
      targetPeerId: transfer.target_peer_id ?? existingPayload.target_peer_id,
      targetDesktopId: transfer.target_desktop_id ?? existingPayload.target_desktop_id,
      item: refreshedItem,
      repoPath: repo.path,
      repoName: repo.name,
      repoDefaultBranch: repo.default_branch,
      repoRemoteUrl: repoRemoteUrl ?? null,
      recovery: await loadSessionRecoveryState(item.id),
      artifacts,
      targetHasRepo: existingPayload.repo.mode === "reuse-local",
      bundle,
    });

    await updateDesktopTaskTransferPayload(transferId, JSON.stringify(payload));
    await queries.reloadSnapshot();

    return {
      transferId,
      payload,
      finalizedCleanly,
    };
  }

  async function approveIncomingTransfer(transferId: string): Promise<string> {
    const transfer = await getDesktopTaskTransfer(transferId);
    if (!transfer) {
      throw new Error(`incoming transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "incoming") {
      throw new Error(`transfer is not incoming: ${transferId}`);
    }
    if (!["pending", "streaming", "importing", "awaiting_acknowledgment"].includes(transfer.status)) {
      throw new Error(`incoming transfer is not resumable: ${transferId}`);
    }

    let payload: OutgoingTransferPayload;
    let localTaskId = transfer.local_task_id;
    if (localTaskId) {
      payload = parsePersistedOutgoingTransferPayload(transfer.payload_json);
      assertIncomingPayloadMatchesTransfer(transfer, payload);
    } else {
      const finalized = parseFinalizedOutgoingTransferResult(await invoke("finalize_outgoing_transfer", {
        transferId,
      }));
      if (finalized.transferId !== transferId) {
        throw new Error(`finalized incoming transfer id mismatch: ${transferId}`);
      }
      payload = finalized.payload;
      assertIncomingPayloadMatchesTransfer(transfer, payload);
      if (!await updateDesktopTaskTransferPayload(transferId, JSON.stringify(payload))) {
        throw new Error(`failed to persist finalized incoming transfer payload: ${transferId}`);
      }
      const { repoId, repoPath } = await ensureIncomingTransferRepo(transferId, payload);
      const resumeSessionId = await importTransferredResumeState(transferId, payload);
      localTaskId = await tasks.createItem(
        repoId,
        repoPath,
        payload.task.prompt ?? "",
        payload.task.agent_type === "agent" || payload.task.agent_type === "sdk" ? "agent" : "pty",
        {
          requestedTaskId: await destinationTaskIdForTransfer(transferId),
          agentProvider: payload.task.agent_provider,
          baseBranch: resolveIncomingTransferBaseBranch(payload),
          pipelineName: payload.task.pipeline,
          stage: payload.task.stage,
          displayName: payload.task.display_name,
          resumeSessionId,
          recoverySnapshot: payload.recovery,
        },
      );
      if (!await markDesktopTaskTransferImporting(transferId, localTaskId)) {
        throw new Error(`failed to claim imported task for transfer: ${transferId}`);
      }
    }

    await setDesktopTaskCloudIdentity(localTaskId, payload.task.cloud_task_id);
    await insertDesktopTaskTransferProvenance({
      pipeline_item_id: localTaskId,
      source_peer_id: payload.task.source_peer_id,
      source_task_id: payload.task.source_task_id,
      source_machine_task_label: payload.task.branch,
    });
    if (!await markDesktopTaskTransferAwaitingAcknowledgment(transferId, localTaskId)) {
      throw new Error(`failed to mark incoming transfer awaiting acknowledgment: ${transferId}`);
    }
    await queries.reloadSnapshot();

    await invoke("acknowledge_incoming_transfer_commit", {
      transferId,
      sourceTaskId: payload.task.source_task_id,
      destinationLocalTaskId: localTaskId,
    });
    if (!await completeDesktopTaskTransfer(transferId, localTaskId)) {
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
  ): Promise<void> {
    const transfer = await getDesktopTaskTransfer(event.transferId);
    if (!transfer) {
      // The durable transfer row may already have been compacted after a
      // previously successful delivery whose sidecar response was lost.
      // Tombstone the receipt so the explicit apply/nack protocol cannot leave
      // it claimed forever or replay it after the next sidecar restart.
      await invoke("mark_outgoing_transfer_commit_applied", {
        transferId: event.transferId,
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
    if (!await completeDesktopTaskTransfer(
      event.transferId,
      transfer.local_task_id ?? event.sourceTaskId,
    )) {
      throw new Error(`failed to complete outgoing transfer: ${event.transferId}`);
    }
    await invoke("mark_outgoing_transfer_commit_applied", {
      transferId: event.transferId,
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
