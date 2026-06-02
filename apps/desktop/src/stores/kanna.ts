import { defineStore } from "pinia";
import {
  getTaskTransfer,
  insertTaskTransfer,
  insertTaskTransferProvenance,
  listBlockedByItem,
  listBlockersForItem,
  markTaskTransferCompleted,
  markTaskTransferRejected,
  type PipelineItem,
  type Repo,
} from "@kanna/db";
import { invoke } from "../invoke";
import { useToast } from "../composables/useToast";
import { loadSessionRecoveryState } from "../composables/sessionRecoveryState";
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
import { createStoreContext, createStoreState, type StoreServices } from "./state";
import { createPortsStore } from "./ports";
import { createQueriesApi } from "./queries";
import { createSelectionApi } from "./selection";
import { createSessionsApi } from "./sessions";
import { createPipelineApi } from "./pipeline";
import { createTasksApi } from "./tasks";
import { createInitApi } from "./init";
import type { WindowWorkspaceController } from "../windowWorkspace";

export { readRepoConfig } from "./state";
export { collectTeardownCommands } from "./tasks";

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

function isDuplicateTaskTransferError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: task_transfer.id");
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

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function joinHomeRelativePath(home: string, relativePath: string): string {
  return `${home.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

async function listDirectoryNames(path: string): Promise<string[]> {
  return invoke<string[]>("list_dir", { path }).catch(() => []);
}

function resolveTransferArtifactMaterialization(
  artifact: Pick<TransferArtifactPayload, "kind" | "materialization">,
): TransferArtifactPayload["materialization"] {
  if (artifact.materialization === "copy-file" || artifact.materialization === "extract-tar-gz") {
    return artifact.materialization;
  }
  return artifact.kind === "session-archive" ? "extract-tar-gz" : "copy-file";
}

interface LocatedTransferArtifact {
  absolutePath: string;
  homeRelPath: string;
  filename: string;
}

async function findCodexRolloutArtifact(sessionId: string): Promise<LocatedTransferArtifact | null> {
  try {
    const home = await invoke<string>("read_env_var", { name: "HOME" });
    const sessionsRoot = `${home}/.codex/sessions`;
    const rootExists = await invoke<boolean>("file_exists", { path: sessionsRoot }).catch(() => false);
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

export const useKannaStore = defineStore("kanna", () => {
  const toast = useToast();
  const state = createStoreState();
  const services: StoreServices = {};
  const context = createStoreContext(state, toast, services);

  const ports = createPortsStore(context);
  const queries = createQueriesApi(context);
  const selection = createSelectionApi(context);
  const sessions = createSessionsApi(context);
  const pipeline = createPipelineApi(context);
  const tasks = createTasksApi(context, ports);
  const initApi = createInitApi(context, ports, tasks);

  services.loadInitialData = queries.loadInitialData;
  services.reloadSnapshot = queries.reloadSnapshot;
  services.withOptimisticItemOverlay = queries.withOptimisticItemOverlay;
  services.selectedRepo = selection.selectedRepo;
  services.currentItem = selection.currentItem;
  services.sortedItemsForCurrentRepo = selection.sortedItemsForCurrentRepo;
  services.sortedItemsAllRepos = selection.sortedItemsAllRepos;
  services.isItemHidden = selection.isItemHidden;
  services.getStageOrder = selection.getStageOrder;
  services.selectRepo = selection.selectRepo;
  services.selectItem = selection.selectItem;
  services.selectReplacementAfterItemRemoval = selection.selectReplacementAfterItemRemoval;
  services.reconcileSelection = selection.reconcileSelection;
  services.restoreSelection = selection.restoreSelection;
  services.goBack = selection.goBack;
  services.goForward = selection.goForward;

  services.applyTaskRuntimeStatus = sessions.applyTaskRuntimeStatus;
  services.syncTaskStatusesFromDaemon = sessions.syncTaskStatusesFromDaemon;
  services.getAgentProviderAvailability = sessions.getAgentProviderAvailability;
  services.waitForSessionExit = sessions.waitForSessionExit;
  services.resolveSessionExitWaiters = sessions.resolveSessionExitWaiters;
  services.persistExitedSessionResumeId = sessions.persistExitedSessionResumeId;
  services.spawnShellSession = sessions.spawnShellSession;
  services.prewarmWorktreeShellSession = sessions.prewarmWorktreeShellSession;
  services.preparePtySession = sessions.preparePtySession;
  services.spawnPtySession = sessions.spawnPtySession;

  services.loadPipeline = pipeline.loadPipeline;
  services.loadAgent = pipeline.loadAgent;
  services.advanceStage = pipeline.advanceStage;
  services.rerunStage = pipeline.rerunStage;

  services.createItem = tasks.createItem;
  services.closeTask = tasks.closeTask;
  services.undoClose = tasks.undoClose;
  services.checkUnblocked = tasks.checkUnblocked;
  services.startBlockedTask = tasks.startBlockedTask;
  services.blockTask = tasks.blockTask;
  services.editBlockedTask = tasks.editBlockedTask;

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

      const home = await invoke<string>("read_env_var", { name: "HOME" });
      if (item.agent_provider === "claude") {
        const sourceDir = `${home}/.claude/tasks/${item.agent_session_id}`;
        const exists = await invoke<boolean>("file_exists", { path: sourceDir }).catch(() => false);
        if (!exists) return [];

        const archivePath = buildTransferArchivePath(transferId, "claude-session");
        await invoke("run_script", {
          script: `tar -C ${shellQuote(`${home}/.claude/tasks`)} -czf ${shellQuote(archivePath)} ${shellQuote(item.agent_session_id)}`,
          cwd: repoPath,
          env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
        });
        const artifactId = buildClaudeSessionArtifactId(transferId);
        await invoke("stage_transfer_artifact", {
          transferId,
          artifactId,
          path: archivePath,
        });
        return [{
          artifact_id: artifactId,
          filename: "claude-session.tar.gz",
          provider: "claude",
          kind: "session-archive",
          materialization: "extract-tar-gz",
          home_rel_path: `.claude/tasks/${item.agent_session_id}`,
        }];
      }

      if (item.agent_provider === "copilot") {
        const sourceDir = `${home}/.copilot/session-state/${item.agent_session_id}`;
        const exists = await invoke<boolean>("file_exists", { path: sourceDir }).catch(() => false);
        if (!exists) return [];

        const archivePath = buildTransferArchivePath(transferId, "copilot-session");
        await invoke("run_script", {
          script: `tar -C ${shellQuote(`${home}/.copilot/session-state`)} -czf ${shellQuote(archivePath)} ${shellQuote(item.agent_session_id)}`,
          cwd: repoPath,
          env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
        });
        const artifactId = buildCopilotSessionArtifactId(transferId);
        await invoke("stage_transfer_artifact", {
          transferId,
          artifactId,
          path: archivePath,
        });
        return [{
          artifact_id: artifactId,
          filename: "copilot-session.tar.gz",
          provider: "copilot",
          kind: "session-archive",
          materialization: "extract-tar-gz",
          home_rel_path: `.copilot/session-state/${item.agent_session_id}`,
        }];
      }
    } catch (error) {
      console.error("[store] failed to stage provider session artifacts:", error);
    }

    return [];
  }

  async function importTransferredResumeState(
    transferId: string,
    payload: OutgoingTransferPayload,
    repoPath: string,
  ): Promise<string | null> {
    const resumeSessionId = payload.task.resume_session_id ?? null;
    const provider = payload.task.agent_provider;
    if (!provider || !resumeSessionId) {
      return resumeSessionId;
    }

    const artifact = payload.artifacts?.find((candidate) => candidate.provider === provider) ?? null;
    if (!artifact) return null;

    try {
      const home = await invoke<string>("read_env_var", { name: "HOME" });
      const destinationPath = joinHomeRelativePath(home, artifact.home_rel_path);
      const destinationParent = parentDirectory(destinationPath);
      const materialization = resolveTransferArtifactMaterialization(artifact);
      const destinationExists = await invoke<boolean>("file_exists", { path: destinationPath }).catch(() => false);
      if (destinationExists) {
        console.warn("[store] skipping transferred session import because destination already exists:", destinationPath);
        return null;
      }

      const fetched = await invoke<{ path: string }>("fetch_transfer_artifact", {
        transferId,
        artifactId: artifact.artifact_id,
      });
      await invoke("ensure_directory", { path: destinationParent });

      if (materialization === "copy-file") {
        await invoke("copy_file", {
          src: fetched.path,
          dst: destinationPath,
        });
        return resumeSessionId;
      }

      if (materialization === "extract-tar-gz") {
        const extractedName = baseName(destinationPath);
        const tempPattern = `${destinationParent}/.kanna-transfer-${transferId}-${extractedName}-XXXXXX`;
        await invoke("run_script", {
          script: [
            `tmp_dir="$(mktemp -d ${shellQuote(tempPattern)})"`,
            'cleanup() { rm -rf "$tmp_dir"; }',
            'trap cleanup EXIT',
            `tar -xzf ${shellQuote(fetched.path)} -C "$tmp_dir"`,
            `test -e "$tmp_dir/${extractedName}"`,
            `mv "$tmp_dir/${extractedName}" ${shellQuote(destinationPath)}`,
          ].join("\n"),
          cwd: repoPath,
          env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
        });
        return resumeSessionId;
      }

      return resumeSessionId;
    } catch (error) {
      console.error("[store] failed to import transferred session artifact:", error);
      return null;
    }
  }

  async function allocateTransferredRepoPath(repoName: string): Promise<string> {
    const home = await invoke<string>("read_env_var", { name: "HOME" });
    const parentDir = defaultReposHome(home);
    await invoke("ensure_directory", { path: parentDir });

    const base = sanitizeTransferRepoName(repoName);
    let candidate = `${parentDir}/${base}`;
    let exists = await invoke<boolean>("file_exists", { path: candidate }).catch(() => false);
    if (!exists) return candidate;

    for (let index = 2; index <= 99; index += 1) {
      candidate = `${parentDir}/${base}-${index}`;
      exists = await invoke<boolean>("file_exists", { path: candidate }).catch(() => false);
      if (!exists) return candidate;
    }

    return `${parentDir}/${base}-${Date.now()}`;
  }

  async function findIncomingTransferRepoMatch(
    payload: OutgoingTransferPayload,
  ): Promise<Repo | null> {
    const repos = state.repos.value;
    const normalizedRemoteUrl = normalizeTransferRepoRemote(payload.repo.remote_url);

    if (normalizedRemoteUrl) {
      for (const repo of repos) {
        const remoteUrl = await invoke<string | null>("git_remote_url", {
          repoPath: repo.path,
        }).catch(() => null);
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

  async function makePR() {
    const item = selection.currentItem.value;
    if (!item) return;
    try {
      await pipeline.advanceStage(item.id);
    } catch (error) {
      console.error("[store] stage advance failed:", error);
      toast.error(context.tt("toasts.prAgentFailed"));
    }
  }

  async function mergeQueue() {
    if (!state.selectedRepoId.value) {
      if (state.repos.value.length === 1) {
        state.selectedRepoId.value = state.repos.value[0].id;
      } else {
        toast.warning(context.tt("toasts.selectRepoFirst"));
        return;
      }
    }

    const repo = state.repos.value.find((candidate) => candidate.id === state.selectedRepoId.value);
    if (!repo) return;

    try {
      const agent = await pipeline.loadAgent(repo.path, "merge");
      const targetBranch = repo.default_branch || "main";
      const prompt = `${agent.prompt.trim()}

## Runtime Merge Context

Default target branch for this merge run: ${targetBranch}

Use this branch as the default when the user does not specify a target branch. Before merging, verify it against the repository's remote default branch with \`git symbolic-ref --short refs/remotes/origin/HEAD\` or \`git remote show origin\`. If the verified default branch differs from this value, ask the user which branch to use.`;

      await tasks.createItem(repo.id, repo.path, prompt, "pty");
    } catch (error) {
      console.error("[store] merge agent failed to start:", error);
      toast.error(context.tt("toasts.mergeAgentFailed"));
    }
  }

  async function pushTaskToPeer(taskId: string, peerId: string): Promise<void> {
    const item = state.items.value.find((candidate) => candidate.id === taskId);
    if (!item) {
      throw new Error(`task not found: ${taskId}`);
    }

    const repo = state.repos.value.find((candidate) => candidate.id === item.repo_id);
    if (!repo) {
      throw new Error(`repo not found for task: ${taskId}`);
    }

    const preflightRaw = await invoke<unknown>("prepare_outgoing_transfer", {
      payload: {
        phase: "preflight",
        sourceTaskId: taskId,
        targetPeerId: peerId,
      },
    });
    const preflight = parseOutgoingTransferPreflightResult(preflightRaw);

    const recovery = await loadSessionRecoveryState(taskId);
    const repoRemoteUrl = preflight.targetHasRepo
      ? null
      : await invoke<string | null>("git_remote_url", {
          repoPath: repo.path,
        }).catch(() => null);
    let bundle: {
      artifactId: string;
      filename: string;
      refName: string | null;
    } | null = null;
    if (!preflight.targetHasRepo && !repoRemoteUrl) {
      const bundlePath = buildTransferBundlePath(preflight.transferId);
      const artifactId = buildTransferBundleArtifactId(preflight.transferId);
      const refName = normalizeTransferRefName(item.branch) ?? normalizeTransferRefName(item.base_ref);
      const refs = buildTransferBundleRefs(item);
      const bundleTargets = refs.length > 0 ? refs.map((ref) => shellQuote(ref)).join(" ") : "--all";

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

    const artifacts = await stageTransferredSessionArtifacts(preflight.transferId, item, repo.path);
    const payload = buildOutgoingTransferPayload({
      sourcePeerId: preflight.sourcePeerId,
      sourceTaskId: taskId,
      targetPeerId: peerId,
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

    await insertTaskTransfer(context.requireDb(), {
      id: preflight.transferId,
      direction: "outgoing",
      status: "pending",
      source_peer_id: preflight.sourcePeerId,
      target_peer_id: peerId,
      source_task_id: taskId,
      local_task_id: taskId,
      error: null,
      payload_json: JSON.stringify(payload),
    });

    await invoke("prepare_outgoing_transfer", {
      payload: {
        phase: "commit",
        transferId: preflight.transferId,
        payload,
      },
    });
    await queries.reloadSnapshot();
  }

  async function recordIncomingTransfer(request: IncomingTransferRequest): Promise<void> {
    try {
      await insertTaskTransfer(context.requireDb(), {
        id: request.transferId,
        direction: "incoming",
        status: "pending",
        source_peer_id: request.sourcePeerId,
        target_peer_id: null,
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
    const transfer = await getTaskTransfer(context.requireDb(), transferId);
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

    const item = state.items.value.find((candidate) => candidate.id === localTaskId);
    if (!item) {
      throw new Error(`source task not found for outgoing transfer: ${transferId}`);
    }

    const repo = state.repos.value.find((candidate) => candidate.id === item.repo_id);
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

    const refreshedItems = await context.requireDb().select<PipelineItem>("SELECT * FROM pipeline_item");
    const refreshedItem = refreshedItems.find((candidate) => candidate.id === item.id) ?? item;
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
      sourceTaskId,
      targetPeerId: transfer.target_peer_id ?? existingPayload.target_peer_id,
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

    await context.requireDb().execute(
      "UPDATE task_transfer SET payload_json = ?, error = NULL WHERE id = ?",
      [JSON.stringify(payload), transferId],
    );
    await queries.reloadSnapshot();

    return {
      transferId,
      payload,
      finalizedCleanly,
    };
  }

  async function approveIncomingTransfer(transferId: string): Promise<string> {
    const transfer = await getTaskTransfer(context.requireDb(), transferId);
    if (!transfer) {
      throw new Error(`incoming transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "incoming") {
      throw new Error(`transfer is not incoming: ${transferId}`);
    }
    if (transfer.status !== "pending" && transfer.status !== "streaming") {
      throw new Error(`incoming transfer is not pending: ${transferId}`);
    }

    const finalized = parseFinalizedOutgoingTransferResult(await invoke("finalize_outgoing_transfer", {
      transferId,
    }));
    const payload = finalized.payload;
    const { repoId, repoPath } = await ensureIncomingTransferRepo(transferId, payload);
    const resumeSessionId = await importTransferredResumeState(transferId, payload, repoPath);
    const localTaskId = await tasks.createItem(
      repoId,
      repoPath,
      payload.task.prompt ?? "",
      payload.task.agent_type === "sdk" ? "sdk" : "pty",
      {
        agentProvider: payload.task.agent_provider,
        baseBranch: resolveIncomingTransferBaseBranch(payload),
        pipelineName: payload.task.pipeline,
        stage: payload.task.stage,
        displayName: payload.task.display_name,
        resumeSessionId,
        recoverySnapshot: payload.recovery,
      },
    );

    await markTaskTransferCompleted(context.requireDb(), transferId, localTaskId);
    await insertTaskTransferProvenance(context.requireDb(), {
      pipeline_item_id: localTaskId,
      source_peer_id: payload.task.source_peer_id,
      source_task_id: payload.task.source_task_id,
      source_machine_task_label: payload.task.branch,
    });

    await invoke("acknowledge_incoming_transfer_commit", {
      transferId,
      sourceTaskId: payload.task.source_task_id,
      destinationLocalTaskId: localTaskId,
    }).catch((error: unknown) => {
      console.error("[store] failed to acknowledge incoming transfer commit:", error);
    });
    await queries.reloadSnapshot();

    return localTaskId;
  }

  async function rejectIncomingTransfer(transferId: string): Promise<void> {
    const transfer = await getTaskTransfer(context.requireDb(), transferId);
    if (!transfer) {
      throw new Error(`incoming transfer not found: ${transferId}`);
    }
    if (transfer.direction !== "incoming") {
      throw new Error(`transfer is not incoming: ${transferId}`);
    }
    if (transfer.status !== "pending") {
      throw new Error(`incoming transfer is not pending: ${transferId}`);
    }

    await markTaskTransferRejected(context.requireDb(), transferId, "Rejected locally");
    await queries.reloadSnapshot();
  }

  async function handleOutgoingTransferCommitted(
    event: OutgoingTransferCommittedEvent,
  ): Promise<void> {
    const transfer = await getTaskTransfer(context.requireDb(), event.transferId);
    if (!transfer || transfer.direction !== "outgoing") {
      return;
    }
    if (transfer.status === "completed") {
      return;
    }
    if (transfer.source_task_id !== event.sourceTaskId) {
      throw new Error(
        `outgoing transfer source task mismatch for ${event.transferId}: expected ${transfer.source_task_id}, got ${event.sourceTaskId}`,
      );
    }

    await markTaskTransferCompleted(
      context.requireDb(),
      event.transferId,
      transfer.local_task_id ?? event.sourceTaskId,
    );
    await tasks.closeTask(event.sourceTaskId);
    await queries.reloadSnapshot();
  }

  function attachWindowWorkspace(windowWorkspace: WindowWorkspaceController): void {
    services.windowWorkspace = windowWorkspace;
    state.initialWindowBootstrap.value = windowWorkspace.bootstrap;
  }

  return {
    repos: state.repos,
    items: state.items,
    selectedRepoId: state.selectedRepoId,
    selectedItemId: state.selectedItemId,
    lastSelectedItemByRepo: state.lastSelectedItemByRepo,
    canGoBack: selection.canGoBack,
    canGoForward: selection.canGoForward,
    suspendAfterMinutes: state.suspendAfterMinutes,
    killAfterMinutes: state.killAfterMinutes,
    ideCommand: state.ideCommand,
    hideShortcutsOnStartup: state.hideShortcutsOnStartup,
    devLingerTerminals: state.devLingerTerminals,
    appTheme: state.appTheme,
    codeTheme: state.codeTheme,
    pendingSetupIds: state.pendingSetupIds,
    lastHiddenRepoId: state.lastHiddenRepoId,
    selectedRepo: selection.selectedRepo,
    currentItem: selection.currentItem,
    sortedItemsForCurrentRepo: selection.sortedItemsForCurrentRepo,
    sortedItemsAllRepos: selection.sortedItemsAllRepos,
    getStageOrder: selection.getStageOrder,

    init: initApi.init,
    attachWindowWorkspace,
    selectRepo: selection.selectRepo,
    selectItem: selection.selectItem,
    goBack: selection.goBack,
    goForward: selection.goForward,

    importRepo: tasks.importRepo,
    createRepo: tasks.createRepo,
    cloneAndImportRepo: tasks.cloneAndImportRepo,
    hideRepo: tasks.hideRepo,
    renameRepo: tasks.renameRepo,
    reorderRepos: tasks.reorderRepos,

    createItem: tasks.createItem,
    spawnPtySession: sessions.spawnPtySession,
    spawnShellSession: sessions.spawnShellSession,
    closeTask: tasks.closeTask,
    undoClose: tasks.undoClose,

    advanceStage: pipeline.advanceStage,
    rerunStage: pipeline.rerunStage,
    loadPipeline: pipeline.loadPipeline,
    loadAgent: pipeline.loadAgent,

    makePR,
    mergeQueue,
    pushTaskToPeer,
    recordIncomingTransfer,
    approveIncomingTransfer,
    rejectIncomingTransfer,
    finalizeOutgoingTransfer,
    handleOutgoingTransferCommitted,
    blockTask: tasks.blockTask,
    editBlockedTask: tasks.editBlockedTask,
    listBlockersForItem: (itemId: string) => listBlockersForItem(context.requireDb(), itemId),
    listBlockedByItem: (itemId: string) => listBlockedByItem(context.requireDb(), itemId),
    pinItem: tasks.pinItem,
    unpinItem: tasks.unpinItem,
    reorderPinned: tasks.reorderPinned,
    renameItem: tasks.renameItem,
    savePreference: initApi.savePreference,
  };
});
