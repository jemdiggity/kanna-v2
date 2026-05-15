import { parseAgentMd, type RepoConfig } from "@kanna/core";
import {
  closePipelineItem,
  findRepoByPath,
  getRepo,
  hasCircularDependency,
  hideRepo as hideRepoQuery,
  insertPipelineItem,
  insertRepo,
  insertTaskBlocker,
  listBlockedByItem,
  listBlockersForItem,
  removeAllBlockersForItem,
  removeTaskBlocker,
  reopenPipelineItem,
  reorderPinnedItems,
  unhideRepo as unhideRepoQuery,
  updatePipelineItemActivity,
  updateAgentSessionId,
  updatePipelineItemDisplayName,
  markPipelineItemTearingDown,
  updatePipelineItemTags,
  updateRepoName,
  pinPipelineItem,
  reorderRepos as reorderReposQuery,
  unpinPipelineItem,
  type AgentProvider,
  type PipelineItem,
  type Repo,
} from "@kanna/db";
import { buildStagePrompt } from "../../../../packages/core/src/pipeline/prompt-builder";
import { invoke } from "../invoke";
import { isTauri } from "../tauri-mock";
import { buildTaskShellCommand } from "../composables/terminalSessionRecovery";
import { buildTaskBootstrapCommand } from "../utils/taskBootstrap";
import { renderBestEffortLifecycleCommand } from "../utils/lifecycleCommands";
import {
  getPreferredAgentProviders,
  resolveAgentProvider,
} from "./agent-provider";
import { resolveRealE2eAgentOverride } from "./e2eRealAgentOverride";
import { buildPendingTaskPlaceholder } from "./taskCreationPlaceholder";
import { getTaskCloseBehavior } from "./taskCloseBehavior";
import { shouldSelectNextOnCloseTransition } from "./taskCloseSelection";
import { shouldPrewarmTaskShellOnCreate } from "./taskShellPrewarm";
import { getCreateWorktreeStartPoint, getOriginFetchBranch, resolveInitialBaseRef } from "./taskBaseBranch";
import { buildTaskRuntimeEnv, resolveKannaServerBaseUrl } from "./kannaCliEnv";
import { encodeDaemonInput } from "./daemonInput";
import { buildWorktreeSessionEnv } from "./worktreeEnv";
import { publishDesktopTaskSnapshot } from "../services/desktopCloudPublisher";
import {
  reportCloseSessionError,
  reportPrewarmSessionError,
} from "./kannaCleanup";
import { isTaskTearingDown } from "./taskStages";
import { isTaskSelectedInAnyWindow } from "./windowSelection";
import { resolveDbName } from "./db";
import { readRepoConfig, requireService, type CreateItemOptions, type StoreContext, type WorktreeBootstrapResult } from "./state";

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

const CODEX_SPAWN_SUBMIT_DELAY_MS = 5_000;
const CODEX_SPAWN_COMPOSER_SUBMIT_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyWorktreeProcessIsolation(env: Record<string, string>): Record<string, string> {
  for (const key of INSTANCE_SCOPED_WORKTREE_ENV_KEYS) {
    env[key] = "";
  }
  return env;
}

export interface TasksApi {
  importRepo: (path: string, name: string, defaultBranch: string) => Promise<string>;
  createRepo: (name: string, path: string) => Promise<void>;
  cloneAndImportRepo: (url: string, destination: string) => Promise<void>;
  hideRepo: (repoId: string) => Promise<void>;
  renameRepo: (repoId: string, name: string) => Promise<void>;
  reorderRepos: (orderedIds: string[]) => Promise<void>;
  createItem: (
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType?: "pty" | "sdk",
    opts?: CreateItemOptions,
  ) => Promise<string>;
  closeTask: (targetItemId?: string, opts?: { selectNext?: boolean }) => Promise<void>;
  undoClose: () => Promise<void>;
  blockTask: (blockerIds: string[]) => Promise<void>;
  editBlockedTask: (itemId: string, newBlockerIds: string[]) => Promise<void>;
  checkUnblocked: (blockerItemId: string) => Promise<void>;
  restoreUnblockedTask: (item: PipelineItem) => Promise<void>;
  startBlockedTask: (item: PipelineItem) => Promise<void>;
  pinItem: (itemId: string, position: number) => Promise<void>;
  unpinItem: (itemId: string) => Promise<void>;
  reorderPinned: (repoId: string, orderedIds: string[]) => Promise<void>;
  renameItem: (itemId: string, displayName: string | null) => Promise<void>;
  handleAgentFinished: (sessionId: string) => Promise<void>;
}

export async function collectTeardownCommands(item: PipelineItem, repo: Repo): Promise<string[]> {
  const cmds: string[] = [];
  if (item.display_name) {
    try {
      const tasksDir = `${repo.path}/.kanna/tasks`;
      const entries = await invoke<string[]>("list_dir", { path: tasksDir }).catch(() => [] as string[]);
      for (const entry of entries) {
        const agentMdPath = `${tasksDir}/${entry}/agent.md`;
        let content: string;
        try {
          content = await invoke<string>("read_text_file", { path: agentMdPath });
        } catch {
          continue;
        }
        const config = parseAgentMd(content, entry);
        if (config && config.name === item.display_name && config.teardown?.length) {
          cmds.push(...config.teardown);
          break;
        }
      }
    } catch (error) {
      console.error("[store] custom task teardown lookup failed:", error);
    }
  }

  const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
  const repoConfig = await readRepoConfig(worktreePath);
  if (repoConfig.teardown?.length) {
    cmds.push(...repoConfig.teardown);
  }
  return cmds;
}

export function createTasksApi(
  context: StoreContext,
  ports: import("./ports").PortsStore,
): TasksApi {
  const reloadSnapshot = () => requireService(context.services.reloadSnapshot, "reloadSnapshot")();
  const invalidateWindowWorkspace = async (reason: string): Promise<void> => {
    await context.services.windowWorkspace?.invalidateSharedData(reason);
  };
  const withOptimisticItemOverlay = <T>(input: Parameters<NonNullable<StoreContext["services"]["withOptimisticItemOverlay"]>>[0]) =>
    requireService(context.services.withOptimisticItemOverlay, "withOptimisticItemOverlay")(input) as Promise<T>;

  async function selectReplacementAfterTaskRemoval(item: PipelineItem): Promise<void> {
    if (context.state.selectedItemId.value !== item.id) return;
    await requireService(
      context.services.selectReplacementAfterItemRemoval,
      "selectReplacementAfterItemRemoval",
    )(item);
  }

  function hasLiveTaskResources(item: PipelineItem): boolean {
    return item.branch !== null || item.agent_session_id !== null || item.port_env !== null;
  }

  async function detachSessionsBeforeIntentionalKill(sessionIds: readonly string[]): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    await Promise.all(
      uniqueSessionIds.map((sessionId) =>
        invoke("detach_session", { sessionId }).catch((error: unknown) =>
          reportCloseSessionError(`[store] detach session before kill failed (${sessionId}):`, error),
        ),
      ),
    );
  }

  function buildBlockedResumeMessage(blockers: PipelineItem[]): string {
    const blockerContext = blockers
      .map((blocker) => {
        const name = blocker.display_name || (blocker.prompt ? blocker.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${blocker.branch || "unknown"})`;
      })
      .join("\n");

    return [
      "This task was previously blocked by the following tasks, which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "Please continue this task using that context where relevant.",
    ].join("\n");
  }

  async function importRepo(path: string, name: string, defaultBranch: string): Promise<string> {
    const existing = await findRepoByPath(context.requireDb(), path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(context.requireDb(), existing.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("importRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return existing.id;
    }
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path, name, default_branch: defaultBranch });
    await reloadSnapshot();
    await invalidateWindowWorkspace("importRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, path, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
    return id;
  }

  async function createRepo(name: string, path: string) {
    const existing = await findRepoByPath(context.requireDb(), path);
    if (existing) {
      if (existing.hidden) {
        await unhideRepoQuery(context.requireDb(), existing.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("createRepo");
        context.state.selectedRepoId.value = existing.id;
      }
      return;
    }
    await invoke("ensure_directory", { path });
    await invoke("git_init", { path });
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path }).catch(() => "main");
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path, name, default_branch: defaultBranch });
    await reloadSnapshot();
    await invalidateWindowWorkspace("createRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, path, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
  }

  async function cloneAndImportRepo(url: string, destination: string) {
    await invoke("git_clone", { url, destination });
    const name = destination.split("/").pop() || "repo";
    const defaultBranch = await invoke<string>("git_default_branch", { repoPath: destination }).catch(() => "main");
    const id = crypto.randomUUID().slice(0, 8);
    await insertRepo(context.requireDb(), { id, path: destination, name, default_branch: defaultBranch });
    await reloadSnapshot();
    await invalidateWindowWorkspace("cloneAndImportRepo");
    context.state.selectedRepoId.value = id;
    if (isTauri) {
      requireService(context.services.spawnShellSession, "spawnShellSession")(`shell-repo-${id}`, destination, null, false)
        .catch((error) => reportPrewarmSessionError("[store] repo shell pre-warm failed:", error));
    }
  }

  async function hideRepo(repoId: string) {
    await hideRepoQuery(context.requireDb(), repoId);
    if (context.state.selectedRepoId.value === repoId) context.state.selectedRepoId.value = null;
    context.state.lastHiddenRepoId.value = repoId;
    await reloadSnapshot();
    await invalidateWindowWorkspace("hideRepo");
  }

  async function renameRepo(repoId: string, name: string) {
    await updateRepoName(context.requireDb(), repoId, name);
    await reloadSnapshot();
    await invalidateWindowWorkspace("renameRepo");
  }

  async function reorderRepos(orderedIds: string[]) {
    await reorderReposQuery(context.requireDb(), orderedIds);
    await reloadSnapshot();
    await invalidateWindowWorkspace("reorderRepos");
  }

  async function createWorktree(
    repoPath: string,
    branch: string,
    worktreePath: string,
    baseRef?: string | null,
  ): Promise<WorktreeBootstrapResult> {
    const visibleBootstrapSteps: string[] = [];
    let startPoint = getCreateWorktreeStartPoint(baseRef ?? undefined);
    let renderedStartPoint = startPoint ?? "HEAD";
    const originFetchBranch = getOriginFetchBranch(startPoint);

    if (originFetchBranch) {
      renderedStartPoint = startPoint ?? renderedStartPoint;
      visibleBootstrapSteps.push(`git fetch origin ${originFetchBranch}`);
      try {
        await invoke("git_fetch", { repoPath, branch: originFetchBranch });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[store] fetch origin failed:", message);
        context.toast.warning(context.tt("toasts.fetchFailed"));
      }
    } else if (!startPoint) {
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
        renderedStartPoint = defaultBranch;
        visibleBootstrapSteps.push(`git fetch origin ${defaultBranch}`);
        await invoke("git_fetch", { repoPath, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
        renderedStartPoint = startPoint;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isOffline = /could not resolve host|network is unreachable|connection refused|timed out/i.test(message);
        const noRemote = /does not appear to be a git repository|could not find remote|no remote|remote.*not found/i.test(message);
        if (isOffline || noRemote) {
          console.debug("[store] fetch origin failed (offline or no remote), using local HEAD");
        } else {
          console.warn("[store] fetch origin failed:", message);
          context.toast.warning(context.tt("toasts.fetchFailed"));
        }
      }
    }

    await invoke("git_worktree_add", {
      repoPath,
      branch,
      path: worktreePath,
      startPoint,
    });

    visibleBootstrapSteps.push(
      `git worktree add -b ${branch} '${worktreePath.replace(/'/g, `'\\''`)}' ${renderedStartPoint}`,
    );

    return { visibleBootstrapSteps };
  }

  async function setupWorktreeAndSpawn(
    id: string,
    repoPath: string,
    worktreePath: string,
    branch: string,
    prompt: string,
    agentType: "pty" | "sdk",
    agentProvider: AgentProvider,
    opts?: CreateItemOptions,
  ) {
    const s0 = performance.now();
    const resolvedModel = opts?.customTask?.model ?? opts?.model ?? null;
    const markSetupFailed = async (error: unknown, logPrefix: string, toastMessage: string) => {
      await updatePipelineItemActivity(context.requireDb(), id, "idle");
      await reloadSnapshot();
      console.error(logPrefix, error);
      context.toast.error(toastMessage);
    };
    const finishPendingSetup = () => {
      context.state.pendingSetupIds.value = context.state.pendingSetupIds.value.filter((pendingId) => pendingId !== id);
      context.state.pendingCreateVisibility.delete(id);
    };

    try {
      let s1 = performance.now();
      let worktreeBootstrap: WorktreeBootstrapResult | null = null;
      let repoConfig: RepoConfig = {};
      let portEnv: Record<string, string> = {};
      let ptySetupCmds: string[] = [];
      try {
        worktreeBootstrap = await createWorktree(repoPath, branch, worktreePath, opts?.baseBranch ?? opts?.baseRef ?? null);
        repoConfig = await readRepoConfig(worktreePath);
        ptySetupCmds = repoConfig.setup || [];
      } catch (error) {
        await markSetupFailed(error, "[store] failed to read repo config or create worktree:", context.tt("toasts.worktreeFailed"));
        return;
      }
      console.log(`[perf:setup] readConfig+createWorktree: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      try {
        const allocated = await ports.claimTaskPorts(id, repoConfig);
        portEnv = allocated.portEnv;
        const portOffset = allocated.firstPort;
        await context.requireDb().execute(
          "UPDATE pipeline_item SET port_offset = ?, port_env = ?, updated_at = datetime('now') WHERE id = ?",
          [portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, id],
        );
        await reloadSnapshot();
      } catch (error) {
        await markSetupFailed(error, "[store] task port allocation failed:", `${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
        return;
      }
      console.log(`[perf:setup] portAllocation: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      try {
        if (shouldPrewarmTaskShellOnCreate(agentType)) {
          requireService(context.services.prewarmWorktreeShellSession, "prewarmWorktreeShellSession")(
            `shell-wt-${id}`,
            worktreePath,
            JSON.stringify(portEnv),
            repoPath,
          ).catch((error) => reportPrewarmSessionError("[store] shell pre-warm failed:", error));
        }

        if (agentType !== "pty") {
          const inheritedPath = await invoke<string>("read_env_var", { name: "PATH" }).catch(() => null);
          const sdkBaseEnv = buildWorktreeSessionEnv({
            worktreePath,
            repoConfig,
            portEnv,
            inheritedPath,
          });
          const sdkEnv = {
            ...sdkBaseEnv,
            ...buildTaskRuntimeEnv({
              taskId: id,
              dbName: await resolveDbName(),
              appDataDir: await invoke<string>("get_app_data_dir"),
              socketPath: await invoke<string>("get_pipeline_socket_path"),
              serverBaseUrl: resolveKannaServerBaseUrl(
                await invoke<string>("read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }).catch(() => null),
              ),
              kannaCliPath: await invoke<string>("which_binary", { name: "kanna-cli" }).catch(() => null),
              path: sdkBaseEnv.PATH ?? inheritedPath,
            }),
          };
          await invoke("create_agent_session", {
            sessionId: id,
            cwd: worktreePath,
            prompt,
            env: sdkEnv,
            systemPrompt: null,
            permissionMode: opts?.customTask?.permissionMode ?? null,
            model: resolvedModel,
            allowedTools: opts?.customTask?.allowedTools ?? null,
            disallowedTools: opts?.customTask?.disallowedTools ?? null,
            maxTurns: opts?.customTask?.maxTurns ?? null,
            maxBudgetUsd: opts?.customTask?.maxBudgetUsd ?? null,
          });
        } else {
          const { env, setupCmds, agentCmd, kannaCliPath } = await requireService(context.services.preparePtySession, "preparePtySession")(
            id,
            prompt,
            {
              agentProvider,
              model: resolvedModel ?? undefined,
              permissionMode: opts?.customTask?.permissionMode,
              allowedTools: opts?.customTask?.allowedTools,
              disallowedTools: opts?.customTask?.disallowedTools,
              maxTurns: opts?.customTask?.maxTurns,
              maxBudgetUsd: opts?.customTask?.maxBudgetUsd,
              setupCmdsOverride: opts?.customTask?.setup,
              worktreePath,
              repoConfig,
              portEnv,
              setupCmds: ptySetupCmds,
              resumeSessionId: opts?.resumeSessionId ?? undefined,
            },
          );
          const fullCmd = buildTaskBootstrapCommand({
            worktreePath,
            visibleBootstrapSteps: worktreeBootstrap?.visibleBootstrapSteps ?? [],
            setupCmds,
            agentCmd: buildTaskShellCommand(agentCmd, [], { kannaCliPath }),
          });
          await invoke("spawn_session", {
            sessionId: id,
            cwd: worktreePath,
            executable: "/bin/zsh",
            args: ["--login", "-i", "-c", fullCmd],
            env,
            cols: 80,
            rows: 24,
            agentProvider,
          });
          if (opts?.recoverySnapshot) {
            await invoke("seed_session_recovery_state", {
              sessionId: id,
              serialized: opts.recoverySnapshot.serialized,
              cols: opts.recoverySnapshot.cols,
              rows: opts.recoverySnapshot.rows,
              cursorRow: opts.recoverySnapshot.cursorRow,
              cursorCol: opts.recoverySnapshot.cursorCol,
              cursorVisible: opts.recoverySnapshot.cursorVisible,
            });
          }
          await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
        }
      } catch (error) {
        await markSetupFailed(
          error,
          "[store] agent spawn failed:",
          `${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }
      console.log(`[perf:setup] spawnSession: ${(performance.now() - s1).toFixed(1)}ms`);

      s1 = performance.now();
      finishPendingSetup();
      console.log("[tasks:createItem] setup selection policy", {
        taskId: id,
        stage: opts?.stage,
        selectOnCreate: opts?.selectOnCreate,
        selectedBeforeSetupSelect: context.state.selectedItemId.value,
      });
      if (opts?.selectOnCreate !== false) {
        await requireService(context.services.selectItem, "selectItem")(id);
        console.log(`[perf:setup] selectItem: ${(performance.now() - s1).toFixed(1)}ms`);
      } else {
        console.log("[tasks:createItem] skipped setup auto-select", {
          taskId: id,
          selectedAfterSkip: context.state.selectedItemId.value,
        });
      }
      if (agentType === "pty" && agentProvider === "codex" && prompt.trim().length > 0) {
        await delay(CODEX_SPAWN_SUBMIT_DELAY_MS);
        await invoke("send_input", {
          sessionId: id,
          data: encodeDaemonInput("\r"),
        });
        await delay(CODEX_SPAWN_COMPOSER_SUBMIT_DELAY_MS);
        await invoke("send_input", {
          sessionId: id,
          data: encodeDaemonInput("\x1b[13u"),
        });
      }
      console.log(`[perf:setup] TOTAL (background): ${(performance.now() - s0).toFixed(1)}ms`);
    } finally {
      finishPendingSetup();
      await requireService(context.services.syncTaskStatusesFromDaemon, "syncTaskStatusesFromDaemon")();
    }
  }

  async function createItem(
    repoId: string,
    repoPath: string,
    prompt: string,
    agentType: "pty" | "sdk" = "pty",
    opts?: CreateItemOptions,
  ): Promise<string> {
    const t0 = performance.now();
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `task-${id}`;
    const worktreePath = `${repoPath}/.kanna-worktrees/${branch}`;
    const effectivePrompt = opts?.customTask?.prompt ?? prompt;
    const effectiveAgentType = opts?.customTask?.executionMode ?? agentType;
    const customTaskAgentProvider = opts?.customTask?.agentProvider;
    const customTaskModel = opts?.customTask?.model;
    const requestedAgentProviders = customTaskAgentProvider ?? opts?.agentProvider;
    const requestedModel = customTaskModel ?? opts?.model;
    const displayName = opts?.customTask?.name ?? opts?.displayName ?? null;
    console.log("[tasks:createItem] start", {
      taskId: id,
      repoId,
      agentType: effectiveAgentType,
      requestedStage: opts?.stage,
      requestedPipeline: opts?.pipelineName,
      selectOnCreate: opts?.selectOnCreate,
      selectedAtStart: context.state.selectedItemId.value,
    });
    const realE2eAgentOverride = await resolveRealE2eAgentOverride({
      agentType: effectiveAgentType,
      explicitAgentProvider: requestedAgentProviders,
      explicitModel: requestedModel,
    });
    const providerCandidatesExplicit = customTaskAgentProvider ?? realE2eAgentOverride?.agentProvider ?? requestedAgentProviders;
    const resolvedModel = customTaskModel ?? realE2eAgentOverride?.model ?? requestedModel ?? null;

    const pendingPlaceholder = buildPendingTaskPlaceholder({
      id,
      repoId,
      prompt: effectivePrompt,
      branch,
      agentType: effectiveAgentType,
      requestedAgentProviders,
      pipelineName: opts?.pipelineName,
      stage: opts?.stage,
      displayName,
    });
    context.state.pendingSetupIds.value = [...context.state.pendingSetupIds.value, id];
    context.state.pendingCreateVisibility.set(id, { bumpAt: performance.now() });

    const removePendingPlaceholder = () => {
      context.state.pendingSetupIds.value = context.state.pendingSetupIds.value.filter((pendingId) => pendingId !== id);
      context.state.pendingCreateVisibility.delete(id);
    };

    let pipelineName = opts?.pipelineName;
    let repoConfig: RepoConfig = {};
    let t1 = performance.now();
    if (!pipelineName) {
      try {
        repoConfig = await readRepoConfig(repoPath);
        pipelineName = repoConfig.pipeline ?? "default";
      } catch {
        pipelineName = "default";
      }
    }
    console.log(`[perf:createItem] readRepoConfig: ${(performance.now() - t1).toFixed(1)}ms`);

    let firstStageName = opts?.stage ?? "in progress";
    let pipelinePrompt = effectivePrompt;
    let firstStageProviders: AgentProvider | AgentProvider[] | undefined;
    let firstStageAgentProviders: AgentProvider | AgentProvider[] | undefined;
    t1 = performance.now();
    try {
      const pipeline = await requireService(context.services.loadPipeline, "loadPipeline")(repoPath, pipelineName);
      if (!opts?.stage && pipeline.stages.length > 0) {
        const firstStage = pipeline.stages[0];
        firstStageName = firstStage.name;
        firstStageProviders = firstStage.agent_provider as AgentProvider | AgentProvider[] | undefined;
        if (firstStage.agent && !opts?.stage) {
          try {
            const agent = await requireService(context.services.loadAgent, "loadAgent")(repoPath, firstStage.agent);
            firstStageAgentProviders = agent.agent_provider as AgentProvider | AgentProvider[] | undefined;
            pipelinePrompt = buildStagePrompt(
              agent.prompt,
              firstStage.prompt,
              { taskPrompt: effectivePrompt },
            );
          } catch (error) {
            console.error("[store] failed to load agent for first stage:", error);
          }
        }
      }
    } catch (error) {
      console.error("[store] failed to load pipeline definition:", error);
    }
    console.log(`[perf:createItem] loadPipeline+loadAgent: ${(performance.now() - t1).toFixed(1)}ms`);

    if (Object.keys(repoConfig).length === 0) {
      try {
        repoConfig = await readRepoConfig(repoPath);
      } catch {
        repoConfig = {};
      }
    }

    let effectiveAgentProvider: AgentProvider;
    try {
      const candidates = getPreferredAgentProviders({
        explicit: providerCandidatesExplicit,
        stage: firstStageProviders,
        agent: firstStageAgentProviders,
      });
      const availability = await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")();
      effectiveAgentProvider = resolveAgentProvider(candidates, availability);
    } catch (error) {
      console.error("[store] createItem: failed to resolve agent provider:", error);
      throw error;
    }

    let baseRef: string | null = null;
    let pipelineItemInserted = false;

    try {
      await withOptimisticItemOverlay<void>({
        key: `create:${id}`,
        apply: (snapshot) => ({
          entries: snapshot.entries.map((entry) =>
            entry.repo.id === repoId
              ? {
                  ...entry,
                  items: [pendingPlaceholder, ...entry.items.filter((item) => item.id !== id)],
                }
              : entry,
          ),
        }),
        run: async () => {
          try {
            t1 = performance.now();
            if (opts?.baseRef !== undefined) {
              baseRef = opts.baseRef;
            } else {
              try {
                const defaultBranch = await invoke<string>("git_default_branch", { repoPath });
                const availableBaseBranches = await invoke<string[]>("git_list_base_branches", { repoPath });
                baseRef = resolveInitialBaseRef({
                  selectedBaseBranch: opts?.baseBranch,
                  availableBaseBranches,
                  defaultBranch,
                });
              } catch (error) {
                console.warn("[store] failed to verify base branch:", error);
                baseRef = null;
              }
            }
            if (!baseRef) {
              throw new Error("No valid base branch selected");
            }
            console.log(`[perf:createItem] git base_ref: ${(performance.now() - t1).toFixed(1)}ms`);

            t1 = performance.now();
            await insertPipelineItem(context.requireDb(), {
              id,
              repo_id: repoId,
              issue_number: null,
              issue_title: null,
              prompt: effectivePrompt,
              pipeline: pipelineName,
              stage: firstStageName,
              tags: opts?.tags ?? [firstStageName],
              pr_number: null,
              pr_url: null,
              branch,
              agent_type: effectiveAgentType,
              agent_provider: effectiveAgentProvider,
              port_offset: null,
              port_env: null,
              activity: "working",
              display_name: displayName,
              base_ref: baseRef,
            });

            pipelineItemInserted = true;
            if (opts?.resumeSessionId) {
              await updateAgentSessionId(context.requireDb(), id, opts.resumeSessionId);
            }
          } catch (error) {
            if (pipelineItemInserted) {
              await context.requireDb().execute("DELETE FROM pipeline_item WHERE id = ?", [id]).catch(() => undefined);
            }
            await ports.releaseTaskPorts(id).catch(() => undefined);
            console.error("[store] task creation failed:", error);
            const message = error instanceof Error ? error.message : String(error);
            context.toast.error(message === "No valid base branch selected" ? message : context.tt("toasts.dbInsertFailed"));
            throw error;
          }
          console.log(`[perf:createItem] DB insert: ${(performance.now() - t1).toFixed(1)}ms`);

          await reloadSnapshot();
          const createdItem = context.state.items.value.find((candidate) => candidate.id === id);
          const createdRepo = context.state.repos.value.find((candidate) => candidate.id === repoId) ?? null;
          if (createdItem) {
            const publishPromise = publishDesktopTaskSnapshot(context.requireDb(), createdItem, createdRepo)
              .then(() => {
                if (import.meta.env.DEV && typeof window !== "undefined") {
                  (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
                    status: "ok",
                    taskId: id,
                  };
                }
              })
              .catch((error) => {
                if (import.meta.env.DEV && typeof window !== "undefined") {
                  (window as unknown as { __KANNA_E2E_CLOUD_PUBLISH__?: unknown }).__KANNA_E2E_CLOUD_PUBLISH__ = {
                    status: "error",
                    taskId: id,
                    message: error instanceof Error ? error.message : String(error),
                  };
                }
                console.warn("[cloud] failed to publish task snapshot:", error);
                throw error;
              });
            const awaitCloudPublish = import.meta.env.DEV
              ? await invoke<string>("read_env_var", { name: "KANNA_E2E_AWAIT_CLOUD_PUBLISH" }).catch(() => "")
              : "";
            if (awaitCloudPublish === "1") {
              await publishPromise;
            } else {
              void publishPromise.catch(() => undefined);
            }
          }
          console.log(`[perf:createItem] reload -> waiting for items refresh (id=${id})`);
          console.log(`[perf:createItem] TOTAL (modal → reload): ${(performance.now() - t0).toFixed(1)}ms`);
          console.log("[tasks:createItem] inserted and reloaded", {
            taskId: id,
            stage: firstStageName,
            selectOnCreate: opts?.selectOnCreate,
            selectedAfterReload: context.state.selectedItemId.value,
          });

          void setupWorktreeAndSpawn(
            id,
            repoPath,
            worktreePath,
            branch,
            pipelinePrompt,
            effectiveAgentType,
            effectiveAgentProvider,
            {
              ...opts,
              baseRef,
              model: resolvedModel ?? undefined,
            },
          );
        },
        reconcile: reloadSnapshot,
      });
    } catch (error) {
      removePendingPlaceholder();
      throw error;
    }
    console.log("[tasks:createItem] returning", {
      taskId: id,
      selectOnCreate: opts?.selectOnCreate,
      selectedBeforeReturn: context.state.selectedItemId.value,
    });
    await invalidateWindowWorkspace("createItem");
    return id;
  }

  async function closeTask(targetItemId?: string, opts?: { selectNext?: boolean }) {
    const item = targetItemId
      ? context.state.items.value.find((candidate) => candidate.id === targetItemId)
      : requireService(context.services.currentItem, "currentItem").value;
    const repo = item
      ? context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      : requireService(context.services.selectedRepo, "selectedRepo").value;
    if (!item || !repo) return;

    try {
      await context.requireDb().execute(
        "UPDATE pipeline_item SET previous_stage = stage, updated_at = datetime('now') WHERE id = ? AND previous_stage IS NULL",
        [item.id],
      );

      const wasBlocked = JSON.parse(item.tags).includes("blocked");
      const ownsLiveTaskResources = hasLiveTaskResources(item);
      const existingTeardown = isTaskTearingDown(item);
      const teardownCmds = existingTeardown || !ownsLiveTaskResources
        ? []
        : await collectTeardownCommands(item, repo);
      const closeBehavior = getTaskCloseBehavior({
        wasBlocked,
        hasLiveTaskResources: ownsLiveTaskResources,
        currentStage: item.stage,
        isTearingDown: existingTeardown,
        hasTeardownCommands: teardownCmds.length > 0,
      });

      if (closeBehavior === "finish" && existingTeardown) {
        await detachSessionsBeforeIntentionalKill([item.id, `shell-wt-${item.id}`, `td-${item.id}`]);
        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
          invoke("kill_session", { sessionId: `td-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill teardown session failed:", error)),
        ]);
        if (wasBlocked) {
          await removeAllBlockersForItem(context.requireDb(), item.id);
        }
        await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));

        if (opts?.selectNext !== false) await selectReplacementAfterTaskRemoval(item);
        await checkUnblocked(item.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        return;
      }

      if (closeBehavior === "finish" && wasBlocked && !ownsLiveTaskResources) {
        await removeAllBlockersForItem(context.requireDb(), item.id);
        await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));

        if (opts?.selectNext !== false) await selectReplacementAfterTaskRemoval(item);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        void detachSessionsBeforeIntentionalKill([item.id]).then(() =>
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill_session failed:", error)),
        );
        return;
      }

      if (closeBehavior === "finish") {
        await detachSessionsBeforeIntentionalKill([item.id, `shell-wt-${item.id}`]);
        await Promise.all([
          invoke("kill_session", { sessionId: item.id }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill agent session failed:", error)),
          invoke("kill_session", { sessionId: `shell-wt-${item.id}` }).catch((error: unknown) =>
            reportCloseSessionError("[store] kill shell session failed:", error)),
        ]);
        if (wasBlocked) {
          await removeAllBlockersForItem(context.requireDb(), item.id);
        }
        if (shouldSelectNextOnCloseTransition({
          selectNext: opts?.selectNext !== false,
          wasBlocked,
          previousStage: item.stage,
          nextStage: "done",
        })) {
          await selectReplacementAfterTaskRemoval(item);
        }
        await ports.closeTaskAndReleasePorts(item.id, (id) => closePipelineItem(context.requireDb(), id));
        await checkUnblocked(item.id);
        await reloadSnapshot();
        await invalidateWindowWorkspace("closeTask");
        return;
      }

      await invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((error: unknown) =>
        reportCloseSessionError("[store] signal_session failed:", error));

      let teardownExit: Promise<void> | null = null;
      if (teardownCmds.length > 0) {
        const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
        const scriptParts = teardownCmds.map((command) => renderBestEffortLifecycleCommand(command, "Teardown"));
        const fullCmd = `printf '\\033[33mRunning teardown...\\033[0m\\n' && ${scriptParts.join(" && ")} && printf '\\n'`;
        const tdSessionId = `td-${item.id}`;
        teardownExit = requireService(context.services.waitForSessionExit, "waitForSessionExit")(tdSessionId);
        await invoke("spawn_session", {
          sessionId: tdSessionId,
          cwd: worktreePath,
          executable: "/bin/zsh",
          args: ["--login", "-i", "-c", fullCmd],
          env: applyWorktreeProcessIsolation({ KANNA_WORKTREE: "1" }),
          cols: 120,
          rows: 30,
        });
        await invoke("attach_session_with_snapshot", { sessionId: tdSessionId });
      }

      await markPipelineItemTearingDown(context.requireDb(), item.id);
      if (shouldSelectNextOnCloseTransition({
        selectNext: opts?.selectNext !== false,
        wasBlocked,
        previousStage: item.stage,
        nextStage: "tearing_down",
      })) {
        await selectReplacementAfterTaskRemoval(item);
      }
      await reloadSnapshot();
      await invalidateWindowWorkspace("closeTask");

      void teardownExit;
    } catch (error) {
      console.error("[store] close failed:", error);
      context.toast.error(context.tt("toasts.closeTaskFailed"));
    }
  }

  async function undoClose() {
    if (context.state.lastHiddenRepoId.value) {
      const repoId = context.state.lastHiddenRepoId.value;
      context.state.lastHiddenRepoId.value = null;
      await unhideRepoQuery(context.requireDb(), repoId);
      await reloadSnapshot();
      await invalidateWindowWorkspace("undoClose");
      return;
    }

    try {
      const rows = await context.requireDb().select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1",
      );
      const item = rows[0];
      if (!item) return;
      const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id);
      if (!repo) return;
      const worktreePath = item.branch ? `${repo.path}/.kanna-worktrees/${item.branch}` : repo.path;

      await reopenPipelineItem(context.requireDb(), item.id);
      let portEnv: Record<string, string> = {};
      let portOffset: number | null = null;
      let portAllocationFailed = false;
      try {
        const repoConfig = await readRepoConfig(worktreePath);
        const allocated = await ports.claimTaskPorts(item.id, repoConfig);
        portEnv = allocated.portEnv;
        portOffset = allocated.firstPort;
        await context.requireDb().execute(
          "UPDATE pipeline_item SET port_offset = ?, port_env = ?, updated_at = datetime('now') WHERE id = ?",
          [portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, item.id],
        );
      } catch (error) {
        await ports.releaseTaskPorts(item.id).catch(() => undefined);
        portAllocationFailed = true;
        console.error("[store] undo close port allocation failed:", error);
        context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      }

      await requireService(context.services.selectItem, "selectItem")(item.id);
      await reloadSnapshot();
      await invalidateWindowWorkspace("undoClose");

      if (item.branch && !portAllocationFailed) {
        try {
          const agentProvider = resolveAgentProvider(
            item.agent_provider,
            await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
          );
          await requireService(context.services.spawnPtySession, "spawnPtySession")(item.id, worktreePath, item.prompt || "", 80, 24, {
            agentProvider,
            ...(item.agent_session_id ? { resumeSessionId: item.agent_session_id } : {}),
          });
          await updatePipelineItemActivity(context.requireDb(), item.id, "working");
          await reloadSnapshot();
        } catch (spawnError) {
          await updatePipelineItemActivity(context.requireDb(), item.id, "idle");
          await reloadSnapshot();
          console.error("[store] session re-spawn after undo failed:", spawnError);
          context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${spawnError instanceof Error ? spawnError.message : spawnError}`);
        }
      }

      context.state.selectedItemId.value = item.id;
    } catch (error) {
      console.error("[store] undo close failed:", error);
      context.toast.error(context.tt("toasts.undoCloseFailed"));
    }
  }

  async function handleAgentFinished(sessionId: string) {
    const item = context.state.items.value.find((candidate) => candidate.id === sessionId);
    if (!item) return;
    const activity = await isTaskSelectedInAnyWindow(context, sessionId) ? "idle" : "unread";
    try {
      await updatePipelineItemActivity(context.requireDb(), item.id, activity);
      await reloadSnapshot();
      await invalidateWindowWorkspace("taskActivity");
    } catch (error) {
      console.error("[store] activity update failed:", error);
    }
  }

  async function checkUnblocked(blockerItemId: string) {
    const blockedItems = await listBlockedByItem(context.requireDb(), blockerItemId);
    for (const blocked of blockedItems) {
      if (blocked.closed_at !== null) continue;
      const blockers = await listBlockersForItem(context.requireDb(), blocked.id);
      if (blockers.length === 0) continue;
      const allClear = blockers.every((blocker) => blocker.closed_at !== null);
      if (allClear) {
        await restoreUnblockedTask(blocked, blockers);
      }
    }
  }

  async function restoreUnblockedTask(
    item: PipelineItem,
    blockers?: PipelineItem[],
  ): Promise<void> {
    const resolvedBlockers = blockers ?? await listBlockersForItem(context.requireDb(), item.id);
    if (resolvedBlockers.length === 0) return;

    if (hasLiveTaskResources(item)) {
      await resumeBlockedTaskInPlace(item, resolvedBlockers);
      return;
    }

    await startBlockedTask(item);
  }

  async function resumeBlockedTaskInPlace(
    item: PipelineItem,
    blockers?: PipelineItem[],
  ): Promise<void> {
    if (!JSON.parse(item.tags).includes("blocked")) return;
    const resolvedBlockers = blockers ?? await listBlockersForItem(context.requireDb(), item.id);

    const nextTags = JSON.parse(item.tags).filter((tag: string) => tag !== "blocked");
    await updatePipelineItemTags(context.requireDb(), item.id, nextTags);
    await updatePipelineItemActivity(context.requireDb(), item.id, "working");
    await reloadSnapshot();

    await invoke("send_input", {
      sessionId: item.id,
      data: encodeDaemonInput(`${buildBlockedResumeMessage(resolvedBlockers)}\n`),
    });
  }

  async function startBlockedTask(item: PipelineItem) {
    const repo = context.state.repos.value.find((candidate) => candidate.id === item.repo_id)
      ?? await getRepo(context.requireDb(), item.repo_id);
    if (!repo) {
      console.error("[store] startBlockedTask: repo not found for", item.id);
      return;
    }

    const blockers = await listBlockersForItem(context.requireDb(), item.id);
    const blockerContext = blockers
      .map((blocker) => {
        const name = blocker.display_name || (blocker.prompt ? blocker.prompt.slice(0, 60) : "Untitled");
        return `- ${name} (branch: ${blocker.branch || "unknown"})`;
      })
      .join("\n");

    const augmentedPrompt = [
      "Note: this task was previously blocked by the following tasks which have now completed:",
      blockerContext,
      "Their changes may be on branches that haven't merged to main yet.",
      "",
      "Original task:",
      item.prompt || "",
    ].join("\n");

    const id = item.id;
    const branch = `task-${id}`;
    const worktreePath = `${repo.path}/.kanna-worktrees/${branch}`;

    const worktreeExists = await invoke<boolean>("file_exists", { path: worktreePath });
    let resolvedBaseRef: string | null = null;
    if (!worktreeExists) {
      let startPoint: string | null = null;
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
        await invoke("git_fetch", { repoPath: repo.path, branch: defaultBranch });
        startPoint = `origin/${defaultBranch}`;
        resolvedBaseRef = startPoint;
      } catch (error) {
        console.debug("[store] fetch origin failed (offline?), using local HEAD:", error);
        try {
          const defaultBranch = await invoke<string>("git_default_branch", { repoPath: repo.path });
          resolvedBaseRef = defaultBranch;
        } catch {
          resolvedBaseRef = null;
        }
      }

      try {
        await invoke("git_worktree_add", {
          repoPath: repo.path,
          branch,
          path: worktreePath,
          startPoint,
        });
      } catch (error) {
        console.error("[store] startBlockedTask worktree_add failed:", error);
        context.toast.error(context.tt("toasts.blockedWorktreeFailed"));
        return;
      }
    }

    let repoConfig: RepoConfig = {};
    try {
      repoConfig = await readRepoConfig(worktreePath);
    } catch (error) {
      console.debug("[store] no .kanna/config.json:", error);
    }

    let agentProvider: AgentProvider;
    let portEnv: Record<string, string> = {};
    try {
      agentProvider = resolveAgentProvider(
        item.agent_provider,
        await requireService(context.services.getAgentProviderAvailability, "getAgentProviderAvailability")(),
      );
    } catch (error) {
      console.error("[store] startBlockedTask: agent provider resolution failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
      return;
    }

    try {
      const allocated = await ports.claimTaskPorts(id, repoConfig);
      portEnv = allocated.portEnv;
      const portOffset = allocated.firstPort;

      await context.requireDb().execute(
        `UPDATE pipeline_item
         SET branch = ?, port_offset = ?, port_env = ?, base_ref = ?,
             tags = '[]', activity = 'working',
             activity_changed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
        [branch, portOffset, Object.keys(portEnv).length > 0 ? JSON.stringify(portEnv) : null, resolvedBaseRef, id],
      );
      await reloadSnapshot();

      await requireService(context.services.spawnPtySession, "spawnPtySession")(id, worktreePath, augmentedPrompt, 80, 24, {
        agentProvider,
        portEnv,
        setupCmds: repoConfig.setup || [],
      });
    } catch (error) {
      await updatePipelineItemActivity(context.requireDb(), id, "idle");
      await reloadSnapshot();
      console.error("[store] startBlockedTask PTY spawn failed:", error);
      context.toast.error(`${context.tt("toasts.agentStartFailed")}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function blockTask(blockerIds: string[]) {
    const item = requireService(context.services.currentItem, "currentItem").value;
    const repo = requireService(context.services.selectedRepo, "selectedRepo").value;
    const isItemHidden = requireService(context.services.isItemHidden as ((item: PipelineItem) => boolean) | undefined, "isItemHidden");
    if (!item || !repo || isItemHidden(item) || JSON.parse(item.tags).includes("blocked")) return;

    for (const blockerId of blockerIds) {
      await insertTaskBlocker(context.requireDb(), item.id, blockerId);
    }

    const nextTags = Array.from(new Set([...JSON.parse(item.tags), "blocked"]));
    await updatePipelineItemTags(context.requireDb(), item.id, nextTags);
    await updatePipelineItemActivity(context.requireDb(), item.id, "idle");
    await reloadSnapshot();
    await invalidateWindowWorkspace("blockTask");
    await requireService(context.services.selectItem, "selectItem")(item.id);
  }

  async function editBlockedTask(itemId: string, newBlockerIds: string[]) {
    const item = context.state.items.value.find((candidate) => candidate.id === itemId);
    if (!item || !JSON.parse(item.tags).includes("blocked")) return;

    if (newBlockerIds.length > 0) {
      const hasCycle = await hasCircularDependency(context.requireDb(), itemId, newBlockerIds);
      if (hasCycle) {
        throw new Error("Cannot add blocker — it would create a circular dependency");
      }
    }

    const currentBlockers = await listBlockersForItem(context.requireDb(), itemId);
    const currentIds = new Set(currentBlockers.map((blocker) => blocker.id));
    const newIds = new Set(newBlockerIds);

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        await removeTaskBlocker(context.requireDb(), itemId, id);
      }
    }

    for (const id of newIds) {
      if (!currentIds.has(id)) {
        await insertTaskBlocker(context.requireDb(), itemId, id);
      }
    }

    await reloadSnapshot();
    await invalidateWindowWorkspace("editBlockedTask");

    const updatedBlockers = await listBlockersForItem(context.requireDb(), itemId);
    const allClear = updatedBlockers.length === 0 || updatedBlockers.every(
      (blocker) => blocker.closed_at !== null,
    );
    if (allClear) {
      const resumeBlockers = updatedBlockers.length > 0 ? updatedBlockers : currentBlockers;
      if (hasLiveTaskResources(item)) {
        await resumeBlockedTaskInPlace(item, resumeBlockers);
      } else {
        await startBlockedTask(item);
      }
    }
  }

  async function pinItem(itemId: string, position: number) {
    await pinPipelineItem(context.requireDb(), itemId, position);
    await reloadSnapshot();
    await invalidateWindowWorkspace("pinItem");
  }

  async function unpinItem(itemId: string) {
    await unpinPipelineItem(context.requireDb(), itemId);
    await reloadSnapshot();
    await invalidateWindowWorkspace("unpinItem");
  }

  async function reorderPinned(repoId: string, orderedIds: string[]) {
    await reorderPinnedItems(context.requireDb(), repoId, orderedIds);
    await reloadSnapshot();
    await invalidateWindowWorkspace("reorderPinned");
  }

  async function renameItem(itemId: string, displayName: string | null) {
    await updatePipelineItemDisplayName(context.requireDb(), itemId, displayName);
    await reloadSnapshot();
    await invalidateWindowWorkspace("renameItem");
  }

  return {
    importRepo,
    createRepo,
    cloneAndImportRepo,
    hideRepo,
    renameRepo,
    reorderRepos,
    createItem,
    closeTask,
    undoClose,
    blockTask,
    editBlockedTask,
    checkUnblocked,
    restoreUnblockedTask,
    startBlockedTask,
    pinItem,
    unpinItem,
    reorderPinned,
    renameItem,
    handleAgentFinished,
  };
}
